"""Cached daily exchange rates (STU-236, plan B).

Rates are stored as units per US dollar, one row per currency, in
``fx_rates``. The rate from A to B is ``per_usd[B] / per_usd[A]``, rounded to
6 places; converted amounts are rounded to 2 places, half up (``convert``).

Reading a rate never touches the network. ``FxRates.rate(a, b)``:

- both rows at most 24 hours old: the stored rate, ``stale`` false;
- either row older: the stored rate whatever its age, ``stale`` true, and
  ``on_stale`` is called;
- either row missing: None (the caller marks the item unconverted), and
  ``on_stale`` is called.

A request with nothing to convert never asks for a rate, so it never
schedules a fetch. In a request, ``get_fx`` wires ``on_stale`` to
``Refresher.schedule``, which adds at most one background task per process at
a time (a 60 s lease) and none for 15 minutes after a failed or partial
fetch. The task runs after the response: it first closes the request's
session (``Refresher.schedule``), then works on its own, so no request
session or transaction is held across the network call. The fetch itself has
one overall deadline, body included (``CurrencyApiProvider``).

Services called without a request use ``FxRates.offline(db)``: stored rates
only, nothing scheduled. It is built by the module hook ``_offline_factory``
so the test suite can replace it.
"""
from __future__ import annotations

import json
import logging
import threading
import time
from contextlib import contextmanager
from dataclasses import dataclass
from datetime import date, datetime, timedelta, timezone
from decimal import ROUND_HALF_UP, Decimal
from typing import Callable, ContextManager, Iterable, Iterator, Optional, Protocol

import httpx
from fastapi import BackgroundTasks, Depends
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.orm import Session

from app.core.database import get_db
from app.models.fx_rate import FxRate
from app.models.user import CurrencyType

logger = logging.getLogger(__name__)

STALE_AFTER = timedelta(hours=24)
LEASE = timedelta(seconds=60)
BACKOFF = timedelta(minutes=15)
FETCH_BUDGET_SECONDS = 5.0
SOURCE = "currency-api"
PRIMARY_URL = ("https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest"
               "/v1/currencies/usd.min.json")
MIRROR_URL = "https://latest.currency-api.pages.dev/v1/currencies/usd.min.json"

RATE_PLACES = Decimal("0.000001")
CENTS = Decimal("0.01")
CURRENCIES = frozenset(c.value for c in CurrencyType)

Clock = Callable[[], datetime]


def utcnow() -> datetime:
    """The wall clock, as naive UTC. Only module defaults read it."""
    return datetime.now(timezone.utc).replace(tzinfo=None)


def _naive_utc(value: datetime) -> datetime:
    if value.tzinfo is None:
        return value
    return value.astimezone(timezone.utc).replace(tzinfo=None)


def convert(amount, rate: Decimal) -> Decimal:
    """``amount × rate``, rounded to 2 places, half up."""
    return (Decimal(str(amount)) * rate).quantize(CENTS, rounding=ROUND_HALF_UP)


# --- values -------------------------------------------------------------------------------

@dataclass(frozen=True)
class StoredRate:
    """One ``fx_rates`` row. ``fetched_at`` is naive UTC."""
    currency: str
    per_usd: Decimal
    as_of: date
    fetched_at: datetime
    source: str


@dataclass(frozen=True)
class Rate:
    """The rate used to convert ``base`` into ``quote``."""
    base: str
    quote: str
    rate: Decimal
    as_of: date
    source: str
    stale: bool

    def as_dict(self) -> dict:
        return {"base": self.base, "quote": self.quote, "rate": self.rate,
                "as_of": self.as_of, "source": self.source, "stale": self.stale}


class FxFetchError(Exception):
    """The provider could not return rates."""


# --- providers ----------------------------------------------------------------------------

class RateProvider(Protocol):
    def fetch(self) -> dict[str, tuple[Decimal, date]]:
        """``{CUR: (per_usd, as_of)}`` for the currencies it has."""
        ...


class CurrencyApiProvider:
    """fawazahmed0 currency-api (CC0, no key): jsDelivr first, then the same
    provider's pages.dev mirror, within one overall time budget."""

    def __init__(self, *, transport: Optional[httpx.BaseTransport] = None,
                 budget: float = FETCH_BUDGET_SECONDS,
                 monotonic: Callable[[], float] = time.monotonic,
                 urls: tuple[str, ...] = (PRIMARY_URL, MIRROR_URL)):
        self.transport = transport
        self.budget = budget
        self.monotonic = monotonic
        self.urls = urls

    def fetch(self) -> dict[str, tuple[Decimal, date]]:
        deadline = self.monotonic() + self.budget
        errors = []
        for url in self.urls:
            remaining = deadline - self.monotonic()
            if remaining <= 0:
                errors.append(f"{url}: no time left")
                break
            try:
                return self.parse(json.loads(self._get(url, remaining)))
            except (httpx.HTTPError, ValueError, KeyError, TypeError, TimeoutError) as exc:
                errors.append(f"{url}: {exc!r}")
        raise FxFetchError("; ".join(errors))

    def _get(self, url: str, remaining: float) -> bytes:
        """``url``'s body, within ``remaining`` seconds overall.

        HTTPX timeouts bound each connect, read or write, not the whole
        response, so a body that trickles in would outlast them. The attempt
        (request and body) runs on a worker thread instead, and is abandoned
        once ``remaining`` has passed: its client is closed, and the worker
        stops at the next chunk.
        """
        result: dict = {}
        cancelled = threading.Event()
        client = httpx.Client(transport=self.transport)

        def attempt() -> None:
            try:
                with client.stream("GET", url, timeout=httpx.Timeout(remaining)) as response:
                    response.raise_for_status()
                    chunks = []
                    for chunk in response.iter_bytes():
                        if cancelled.is_set():
                            return
                        chunks.append(chunk)
                    result["body"] = b"".join(chunks)
            except Exception as exc:  # re-raised on the caller's thread
                result["error"] = exc

        worker = threading.Thread(target=attempt, name="fx-fetch", daemon=True)
        worker.start()
        worker.join(remaining)
        if worker.is_alive():
            cancelled.set()
            client.close()
            raise TimeoutError(f"no complete response within {remaining:.1f} s")
        client.close()
        if "error" in result:
            raise result["error"]
        return result["body"]

    @staticmethod
    def parse(payload: dict) -> dict[str, tuple[Decimal, date]]:
        as_of = date.fromisoformat(payload["date"])
        rates = {}
        for key, value in payload["usd"].items():
            currency = str(key).upper()
            if currency not in CURRENCIES:
                continue
            per_usd = Decimal(str(value))
            if per_usd > 0:
                rates[currency] = (per_usd, as_of)
        return rates


class _NoFetch:
    """The provider of offline rates: they never fetch."""

    def fetch(self) -> dict[str, tuple[Decimal, date]]:
        raise FxFetchError("offline rates never fetch")


# --- stores -------------------------------------------------------------------------------

class RateStore(Protocol):
    def all(self) -> dict[str, StoredRate]: ...

    def get(self, currency: str) -> Optional[StoredRate]: ...

    def upsert(self, rows: Iterable[StoredRate]) -> None:
        """Write ``rows``, each only over an older ``fetched_at``."""
        ...


class MemoryRateStore:
    def __init__(self, rows: Iterable[StoredRate] = ()):
        self._rows = {r.currency: r for r in rows}
        self._lock = threading.Lock()

    def all(self) -> dict[str, StoredRate]:
        with self._lock:
            return dict(self._rows)

    def get(self, currency: str) -> Optional[StoredRate]:
        with self._lock:
            return self._rows.get(currency)

    def upsert(self, rows: Iterable[StoredRate]) -> None:
        with self._lock:
            for row in rows:
                current = self._rows.get(row.currency)
                if current is None or current.fetched_at < row.fetched_at:
                    self._rows[row.currency] = row


class DbRateStore:
    """``fx_rates`` through ``db``. Reads once per store; ``upsert`` does not commit."""

    def __init__(self, db: Session):
        self.db = db
        self._rows: Optional[dict[str, StoredRate]] = None

    def all(self) -> dict[str, StoredRate]:
        if self._rows is None:
            self._rows = {
                r.currency: StoredRate(r.currency, Decimal(r.per_usd), r.as_of,
                                       _naive_utc(r.fetched_at), r.source)
                for r in self.db.query(FxRate).all()
            }
        return dict(self._rows)

    def get(self, currency: str) -> Optional[StoredRate]:
        return self.all().get(currency)

    def upsert(self, rows: Iterable[StoredRate]) -> None:
        values = [{"currency": r.currency, "per_usd": r.per_usd, "as_of": r.as_of,
                   "fetched_at": r.fetched_at.replace(tzinfo=timezone.utc)
                   if r.fetched_at.tzinfo is None else r.fetched_at,
                   "source": r.source} for r in rows]
        if not values:
            return
        stmt = insert(FxRate.__table__).values(values)
        stmt = stmt.on_conflict_do_update(
            index_elements=[FxRate.__table__.c.currency],
            set_={c: stmt.excluded[c] for c in ("per_usd", "as_of", "fetched_at", "source")},
            where=FxRate.__table__.c.fetched_at < stmt.excluded.fetched_at,
        )
        self.db.execute(stmt)
        self._rows = None


# --- rates --------------------------------------------------------------------------------

def _is_stale(row: StoredRate, now: datetime) -> bool:
    return now - row.fetched_at > STALE_AFTER


def needs_fetch(rows: dict[str, StoredRate], now: datetime) -> bool:
    """True when any currency has no row, or any row is stale."""
    return any(c not in rows or _is_stale(rows[c], now) for c in CURRENCIES)


class FxRates:
    """Rates for one request (or one offline service call).

    ``used`` records every pair returned, and ``missing`` every pair with no
    row, so callers can decide which pairs to disclose (``FxMeta``).
    """

    def __init__(self, store: RateStore, provider: Optional[RateProvider], clock: Clock,
                 on_stale: Callable[[], object]):
        self.store = store
        self.provider = provider
        self.clock = clock
        self.on_stale = on_stale
        self.used: dict[tuple[str, str], Rate] = {}
        self.missing: set[tuple[str, str]] = set()
        self._signalled = False

    @staticmethod
    def offline(db: Session) -> "FxRates":
        """Stored rates for a service called without a request; never fetches."""
        return _offline_factory(db)

    def _stale(self) -> None:
        if not self._signalled:
            self._signalled = True
            self.on_stale()

    def rate(self, base, quote) -> Optional[Rate]:
        base, quote = _code(base), _code(quote)
        if base == quote:
            return Rate(base, quote, Decimal("1"), self.clock().date(), "identity", False)
        a, b = self.store.get(base), self.store.get(quote)
        if a is None or b is None:
            self.missing.add((base, quote))
            self._stale()
            return None
        now = self.clock()
        stale = _is_stale(a, now) or _is_stale(b, now)
        rate = Rate(base, quote, (b.per_usd / a.per_usd).quantize(RATE_PLACES, ROUND_HALF_UP),
                    min(a.as_of, b.as_of),
                    a.source if a.source == b.source else f"{a.source} / {b.source}",
                    stale)
        self.used[(base, quote)] = rate
        if stale:
            self._stale()
        return rate


def _code(currency) -> str:
    return currency.value if isinstance(currency, CurrencyType) else str(currency)


class FxMeta:
    """Accumulates a response's ``fx: {rates, unconverted_count}``.

    Callers add only what they may disclose: the rates used by full rows and
    the full rows left unconverted.
    """

    def __init__(self):
        self._rates: dict[tuple[str, str], Rate] = {}
        self.unconverted_count = 0

    def add(self, rate: Optional[Rate]) -> None:
        if rate is not None and rate.base != rate.quote:
            self._rates[(rate.base, rate.quote)] = rate

    def add_unconverted(self, count: int = 1) -> None:
        self.unconverted_count += count

    def as_dict(self) -> dict:
        return {"rates": [self._rates[k].as_dict() for k in sorted(self._rates)],
                "unconverted_count": self.unconverted_count}


# --- refresh ------------------------------------------------------------------------------

def _session_factory() -> Session:
    from app.core.database import SessionLocal

    return SessionLocal()


@contextmanager
def db_store_session() -> Iterator[RateStore]:
    """A ``DbRateStore`` on its own session, committed on success."""
    db = _session_factory()
    try:
        yield DbRateStore(db)
        db.commit()
    except Exception:
        db.rollback()
        raise
    finally:
        db.close()


class Refresher:
    """Schedules and runs background fetches for one process.

    ``in_flight`` is a lease timestamp, not a flag: when an endpoint raises
    after ``on_stale``, FastAPI never runs the task, and the lease simply
    expires after ``LEASE``. ``failed_at`` starts a ``BACKOFF`` after a failed
    or partial fetch.
    """

    def __init__(self, provider: RateProvider, clock: Clock,
                 store_factory: Callable[[], ContextManager[RateStore]]):
        self.provider = provider
        self.clock = clock
        self.store_factory = store_factory
        self.in_flight: Optional[datetime] = None
        self.failed_at: Optional[datetime] = None
        self._lock = threading.Lock()
        self._fetch_lock = threading.Lock()

    def _backing_off(self, now: datetime) -> bool:
        return self.failed_at is not None and now - self.failed_at < BACKOFF

    def schedule(self, background_tasks: BackgroundTasks,
                 release: Optional[Session] = None) -> bool:
        """Add one refresh task, unless one is leased or a failure is backing off.

        ``release`` is the request's session: the task closes it before it
        does anything else, so no request session or transaction is open
        across the network call, whichever order the installed FastAPI runs
        background tasks and dependency exits in (the request is answered by
        then; closing a closed session again is harmless).
        """
        with self._lock:
            now = self.clock()
            if self.in_flight is not None and now - self.in_flight < LEASE:
                return False
            if self._backing_off(now):
                return False
            self.in_flight = now
        if release is None:
            background_tasks.add_task(self.run)
        else:
            background_tasks.add_task(self.run_after_release, release)
        return True

    def run_after_release(self, session: Session) -> None:
        try:
            session.close()
        finally:
            self.run()

    def run(self) -> None:
        try:
            with self._fetch_lock:
                self._refresh()
        except Exception:
            logger.exception("Exchange-rate refresh failed")
            with self._lock:
                self.failed_at = self.clock()
        finally:
            with self._lock:
                self.in_flight = None

    def _refresh(self) -> None:
        now = self.clock()
        with self._lock:
            if self._backing_off(now):
                return
        with self.store_factory() as store:
            rows = store.all()
        if not needs_fetch(rows, now):
            return
        try:
            fetched = self.provider.fetch()
        except Exception:
            logger.exception("Exchange-rate fetch failed; keeping the stored rates")
            with self._lock:
                self.failed_at = self.clock()
            return
        fetched_at = self.clock()
        as_of = max((d for _, d in fetched.values()), default=fetched_at.date())
        batch = {c: StoredRate(c, per_usd, d, fetched_at, SOURCE)
                 for c, (per_usd, d) in fetched.items() if c in CURRENCIES and c != "USD"}
        batch["USD"] = StoredRate("USD", Decimal("1"), as_of, fetched_at, SOURCE)
        with self.store_factory() as store:
            store.upsert(batch.values())
        gap = sorted(CURRENCIES - set(batch))
        if gap:
            logger.warning("Exchange-rate fetch returned no rate for %s", ", ".join(gap))
            with self._lock:
                self.failed_at = fetched_at
        else:
            logger.info("Exchange rates fetched from %s (as of %s)", SOURCE, as_of)


_refresher = Refresher(provider=CurrencyApiProvider(), clock=utcnow,
                       store_factory=db_store_session)


def get_fx(background_tasks: BackgroundTasks, db: Session = Depends(get_db)) -> FxRates:
    """The request's rates; a stale or missing rate schedules a refresh."""
    refresher = _refresher
    return FxRates(DbRateStore(db), refresher.provider, refresher.clock,
                   on_stale=lambda: refresher.schedule(background_tasks, release=db))


def _default_offline_factory(db: Session) -> FxRates:
    return FxRates(DbRateStore(db), _NoFetch(), _refresher.clock, on_stale=lambda: None)


_offline_factory: Callable[[Session], FxRates] = _default_offline_factory
