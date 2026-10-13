"""The daily exchange-rate cache (STU-236, plan B; acceptance criterion 10).

Unit tests: fake providers that count their calls, memory stores and a frozen,
hand-advanced clock. Nothing here touches the network, the wall clock or the
database. The request path is driven through ``get_fx`` on a throwaway FastAPI
app (never the real one), so FastAPI's own background-task rules apply: a task
runs only when the endpoint returns, and never when it raises.
"""
import json
import threading
from contextlib import contextmanager
from datetime import date, datetime, timedelta
from decimal import Decimal

import httpx
import pytest
from fastapi import BackgroundTasks, Depends, FastAPI, HTTPException
from fastapi.testclient import TestClient

from app.models.user import CurrencyType
from app.services import fx
from app.services.fx import (
    BACKOFF,
    LEASE,
    CurrencyApiProvider,
    FxMeta,
    FxRates,
    MemoryRateStore,
    Refresher,
    StoredRate,
    convert,
    get_fx,
    needs_fetch,
)

T0 = datetime(2026, 11, 2, 0, 0)  # naive UTC
ALL = [c.value for c in CurrencyType]
PER_USD = {"USD": Decimal("1"), "PHP": Decimal("58"), "EUR": Decimal("0.9"),
           "GBP": Decimal("0.75"), "JPY": Decimal("150"), "AUD": Decimal("1.4"),
           "CAD": Decimal("1.4"), "CHF": Decimal("0.8"), "CNY": Decimal("6.7"),
           "SGD": Decimal("1.3")}


# --- fakes --------------------------------------------------------------------------------

class Clock:
    def __init__(self, now=T0):
        self.now = now

    def __call__(self):
        return self.now

    def advance(self, **kw):
        self.now += timedelta(**kw)


class CountingProvider:
    """Returns ``rates`` (all ten by default) or raises ``error``; counts calls."""

    def __init__(self, rates=None, error=None):
        self.rates = dict(PER_USD) if rates is None else rates
        self.error = error
        self.calls = 0
        self._lock = threading.Lock()

    def fetch(self):
        with self._lock:
            self.calls += 1
        if self.error:
            raise self.error
        return {cur: (value, date(2026, 11, 1)) for cur, value in self.rates.items()}


class FailingStore(MemoryRateStore):
    def upsert(self, rows):
        raise RuntimeError("disk full")


def _row(cur, fetched_at, per_usd=None):
    return StoredRate(cur, PER_USD[cur] if per_usd is None else Decimal(per_usd),
                      date(2026, 10, 31), fetched_at, "currency-api")


def _store(fetched_at, currencies=ALL):
    return MemoryRateStore(_row(c, fetched_at) for c in currencies)


def _factory(store):
    @contextmanager
    def open_store():
        yield store
    return open_store


def _refresher(store, provider, clock):
    return Refresher(provider=provider, clock=clock, store_factory=_factory(store))


def _rates(store, refresher, tasks):
    return FxRates(store, refresher.provider, refresher.clock,
                   on_stale=lambda: refresher.schedule(tasks))


def _run(tasks: BackgroundTasks):
    for task in tasks.tasks:
        task.func(*task.args, **task.kwargs)
    tasks.tasks.clear()


def _stale_request(store, refresher):
    """One request that converts PHP to USD against ``store``; runs its task."""
    tasks = BackgroundTasks()
    rate = _rates(store, refresher, tasks).rate("PHP", "USD")
    _run(tasks)
    return rate


# --- rate semantics -----------------------------------------------------------------------

def test_fresh_rate_is_used_and_nothing_is_fetched():
    clock, provider = Clock(), CountingProvider()
    store = _store(T0 - timedelta(hours=24))  # exactly 24 hours old is still fresh
    rate = _stale_request(store, _refresher(store, provider, clock))
    assert rate.rate == Decimal("0.017241") and rate.stale is False
    assert provider.calls == 0


def test_stale_rate_is_used_and_one_background_fetch_runs():
    clock, provider = Clock(), CountingProvider(rates={**PER_USD, "PHP": Decimal("60")})
    store = _store(T0 - timedelta(hours=24, seconds=1))
    refresher = _refresher(store, provider, clock)
    tasks = BackgroundTasks()
    rate = _rates(store, refresher, tasks).rate("USD", "PHP")
    assert (rate.rate, rate.stale) == (Decimal("58.000000"), True)  # the stored rate, at once
    assert provider.calls == 0 and len(tasks.tasks) == 1  # fetched after the response only
    _run(tasks)
    assert provider.calls == 1
    assert store.get("PHP").per_usd == Decimal("60")


def test_stale_rows_with_nothing_to_convert_fetch_nothing():
    clock, provider = Clock(), CountingProvider()
    store = _store(datetime(1970, 1, 1))
    refresher = _refresher(store, provider, clock)
    tasks = BackgroundTasks()
    _rates(store, refresher, tasks)  # a request that never asks for a rate
    _run(tasks)
    assert provider.calls == 0 and refresher.in_flight is None


def test_ten_concurrent_stale_requests_fetch_once():
    clock, provider = Clock(), CountingProvider()
    store = _store(datetime(1970, 1, 1))
    refresher = _refresher(store, provider, clock)
    barrier = threading.Barrier(10)
    queues = [BackgroundTasks() for _ in range(10)]
    stale = []

    def request(tasks):
        barrier.wait()
        stale.append(_rates(store, refresher, tasks).rate("PHP", "USD").stale)

    threads = [threading.Thread(target=request, args=(q,)) for q in queues]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert stale == [True] * 10
    assert sum(len(q.tasks) for q in queues) == 1
    for q in queues:
        _run(q)
    assert provider.calls == 1


def test_concurrent_tasks_fetch_once_under_the_fetch_lock():
    clock, provider = Clock(), CountingProvider()
    store = _store(datetime(1970, 1, 1))
    refresher = _refresher(store, provider, clock)
    threads = [threading.Thread(target=refresher.run) for _ in range(5)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert provider.calls == 1  # the later runs find every row fresh


def test_failed_fetch_keeps_the_stale_rate_and_backs_off_for_15_minutes():
    clock, provider = Clock(), CountingProvider(error=fx.FxFetchError("down"))
    store = _store(datetime(1970, 1, 1))
    refresher = _refresher(store, provider, clock)
    rate = _stale_request(store, refresher)
    assert provider.calls == 1
    assert (rate.rate, rate.stale) == (Decimal("0.017241"), True)
    assert refresher.in_flight is None and refresher.failed_at == T0

    clock.advance(minutes=14, seconds=59)
    rate = _stale_request(store, refresher)
    assert rate.stale is True and provider.calls == 1  # no retry inside the backoff
    clock.advance(seconds=1)
    _stale_request(store, refresher)
    assert provider.calls == 2


def test_missing_row_is_none_and_schedules_a_refresh():
    clock, provider = Clock(), CountingProvider()
    store = _store(T0, [c for c in ALL if c != "JPY"])
    refresher = _refresher(store, provider, clock)
    tasks = BackgroundTasks()
    fxr = _rates(store, refresher, tasks)
    assert fxr.rate("JPY", "PHP") is None
    assert fxr.missing == {("JPY", "PHP")} and fxr.used == {}
    assert len(tasks.tasks) == 1
    _run(tasks)
    assert provider.calls == 1 and store.get("JPY").per_usd == Decimal("150")


def test_a_missing_currency_is_fetched_even_when_every_stored_row_is_fresh():
    clock, provider = Clock(), CountingProvider()
    store = _store(T0, [c for c in ALL if c != "PHP"])
    assert needs_fetch(store.all(), T0) is True
    refresher = _refresher(store, provider, clock)
    tasks = BackgroundTasks()
    assert _rates(store, refresher, tasks).rate("USD", "PHP") is None
    _run(tasks)
    assert provider.calls == 1
    assert store.get("PHP").per_usd == Decimal("58")


def test_partial_batch_keeps_what_arrived_and_backs_off():
    clock = Clock()
    provider = CountingProvider(rates={c: v for c, v in PER_USD.items() if c != "JPY"})
    store = _store(datetime(1970, 1, 1), [c for c in ALL if c != "JPY"])
    refresher = _refresher(store, provider, clock)
    tasks = BackgroundTasks()
    assert _rates(store, refresher, tasks).rate("JPY", "PHP") is None
    _run(tasks)
    assert provider.calls == 1
    assert store.get("JPY") is None
    assert store.get("PHP").fetched_at == T0  # the rows that arrived are kept
    assert refresher.failed_at == T0 and refresher.in_flight is None

    clock.advance(minutes=14)
    tasks = BackgroundTasks()
    assert _rates(store, refresher, tasks).rate("JPY", "PHP") is None
    _run(tasks)
    assert provider.calls == 1  # backoff: nothing within 15 minutes
    clock.advance(minutes=1)
    tasks = BackgroundTasks()
    _rates(store, refresher, tasks).rate("JPY", "PHP")
    _run(tasks)
    assert provider.calls == 2


def test_one_success_leaves_every_row_fresh_usd_included():
    clock, provider = Clock(), CountingProvider(rates={c: v for c, v in PER_USD.items()
                                                      if c != "USD"})
    store = _store(datetime(1970, 1, 1))
    refresher = _refresher(store, provider, clock)
    _stale_request(store, refresher)
    assert provider.calls == 1
    rows = store.all()
    assert set(rows) == set(ALL)
    assert all(r.fetched_at == T0 for r in rows.values())
    assert rows["USD"].per_usd == Decimal("1")
    assert needs_fetch(rows, T0) is False

    clock.advance(hours=1)
    rate = _stale_request(store, refresher)
    assert rate.stale is False and provider.calls == 1


def test_an_older_fetch_never_overwrites_a_newer_row():
    store = MemoryRateStore([_row("PHP", T0, "60")])
    store.upsert([_row("PHP", T0 - timedelta(hours=1), "55")])
    assert store.get("PHP").per_usd == Decimal("60")
    store.upsert([_row("PHP", T0 + timedelta(hours=1), "61")])
    assert store.get("PHP").per_usd == Decimal("61")


def test_persistence_failure_clears_the_lease():
    clock, provider = Clock(), CountingProvider()
    store = FailingStore(_row(c, datetime(1970, 1, 1)) for c in ALL)
    refresher = _refresher(store, provider, clock)
    tasks = BackgroundTasks()
    _rates(store, refresher, tasks).rate("PHP", "USD")
    assert refresher.in_flight == T0
    _run(tasks)  # logged, not raised
    assert provider.calls == 1
    assert refresher.in_flight is None and refresher.failed_at == T0


# --- the request dependency and the lease -------------------------------------------------

@pytest.fixture
def mini(monkeypatch):
    """A throwaway app whose endpoints take ``get_fx``, over a memory store."""
    clock = Clock()
    provider = CountingProvider()
    store = _store(datetime(1970, 1, 1))
    refresher = _refresher(store, provider, clock)
    monkeypatch.setattr(fx, "_refresher", refresher)
    monkeypatch.setattr(fx, "DbRateStore", lambda db: store)

    app = FastAPI()
    app.dependency_overrides[fx.get_db] = lambda: None

    @app.get("/convert")
    def convert_one(f: FxRates = Depends(get_fx)):
        rate = f.rate("PHP", "USD")
        return {"stale": rate.stale}

    @app.get("/nothing")
    def nothing(f: FxRates = Depends(get_fx)):
        return {}

    @app.get("/boom")
    def boom(f: FxRates = Depends(get_fx)):
        f.rate("PHP", "USD")  # on_stale fires and schedules ...
        raise HTTPException(500, "after on_stale")  # ... but the task never runs

    with TestClient(app) as client:
        yield {"client": client, "clock": clock, "provider": provider, "store": store,
               "refresher": refresher}


def test_get_fx_request_with_nothing_to_convert_fetches_nothing(mini):
    assert mini["client"].get("/nothing").status_code == 200
    assert mini["provider"].calls == 0 and mini["refresher"].in_flight is None


def test_get_fx_stale_request_refreshes_after_the_response(mini):
    r = mini["client"].get("/convert")
    assert r.json() == {"stale": True}
    assert mini["provider"].calls == 1
    assert mini["client"].get("/convert").json() == {"stale": False}
    assert mini["provider"].calls == 1


def test_lease_expires_when_the_endpoint_raises_after_on_stale(mini):
    client, clock, provider = mini["client"], mini["clock"], mini["provider"]
    assert client.get("/boom").status_code == 500
    assert provider.calls == 0 and mini["refresher"].in_flight == T0  # the task never ran

    clock.advance(seconds=59)
    assert client.get("/convert").json() == {"stale": True}
    assert provider.calls == 0  # the lease still holds: nothing scheduled

    clock.advance(seconds=1)
    assert LEASE == timedelta(seconds=60)
    assert client.get("/convert").json() == {"stale": True}
    assert provider.calls == 1  # exactly one schedule once the lease expires
    assert mini["refresher"].in_flight is None


def test_backoff_is_fifteen_minutes():
    assert BACKOFF == timedelta(minutes=15)


# --- offline rates and metadata -----------------------------------------------------------

def test_offline_rates_use_the_module_hook_and_never_schedule(monkeypatch):
    store = _store(datetime(1970, 1, 1))
    seen = []
    monkeypatch.setattr(fx, "_offline_factory", lambda db: (seen.append(db), FxRates(
        store, CountingProvider(error=AssertionError("no fetch")), Clock(), lambda: None))[1])
    rates = FxRates.offline("db-session")
    assert seen == ["db-session"]
    assert rates.rate("USD", "PHP").stale is True


def test_default_offline_rates_schedule_nothing(monkeypatch):
    store = _store(datetime(1970, 1, 1))
    monkeypatch.setattr(fx, "DbRateStore", lambda db: store)
    monkeypatch.setattr(fx, "_offline_factory", fx._default_offline_factory)
    monkeypatch.setattr(fx, "_refresher", _refresher(
        store, CountingProvider(error=AssertionError("no fetch")), Clock()))
    rates = FxRates.offline(None)
    assert rates.rate("USD", "PHP").rate == Decimal("58.000000")
    assert fx._refresher.in_flight is None


def test_fx_meta_lists_only_the_pairs_it_is_given():
    store = _store(T0)
    rates = FxRates(store, CountingProvider(), Clock(), lambda: None)
    usd_php = rates.rate("USD", "PHP")
    rates.rate("PHP", "EUR")  # used, but not disclosed by this caller
    assert set(rates.used) == {("USD", "PHP"), ("PHP", "EUR")}
    meta = FxMeta()
    meta.add(usd_php)
    meta.add(usd_php)
    meta.add_unconverted()
    assert meta.as_dict() == {
        "rates": [{"base": "USD", "quote": "PHP", "rate": Decimal("58.000000"),
                   "as_of": date(2026, 10, 31), "source": "currency-api", "stale": False}],
        "unconverted_count": 1,
    }


def test_identity_pair_needs_no_row():
    rates = FxRates(MemoryRateStore(), CountingProvider(), Clock(), lambda: None)
    assert rates.rate("PHP", "PHP").rate == Decimal("1")
    assert rates.used == {} and rates.missing == set()


# --- rounding -----------------------------------------------------------------------------

def test_rounding_rules():
    store = MemoryRateStore([_row("USD", T0), _row("PHP", T0, "58.00")])
    rates = FxRates(store, CountingProvider(), Clock(), lambda: None)
    usd_php, php_usd = rates.rate("USD", "PHP"), rates.rate("PHP", "USD")
    assert str(usd_php.rate) == "58.000000"
    assert str(php_usd.rate) == "0.017241"
    assert convert(Decimal("5800"), php_usd.rate) == Decimal("100.00")  # 99.9978
    assert convert(Decimal("80"), usd_php.rate) == Decimal("4640.00")
    assert convert(Decimal("0.125"), Decimal("1")) == Decimal("0.13")  # half up
    assert convert(Decimal("10"), Decimal("0.0000005")) == Decimal("0.00")


# --- the provider -------------------------------------------------------------------------

def _payload(date_str="2026-11-01", **rates):
    return json.dumps({"date": date_str, "usd": rates}).encode()


def test_provider_parses_lowercase_keys_and_keeps_only_known_currencies():
    seen = []

    def handler(request):
        seen.append(str(request.url))
        return httpx.Response(200, content=_payload(php=62.77060786, usd=1, jpy=158.3874829,
                                                    btc=0.00001, xau=0.0004))

    rates = CurrencyApiProvider(transport=httpx.MockTransport(handler)).fetch()
    assert rates == {"PHP": (Decimal("62.77060786"), date(2026, 11, 1)),
                     "USD": (Decimal("1"), date(2026, 11, 1)),
                     "JPY": (Decimal("158.3874829"), date(2026, 11, 1))}
    assert seen == [fx.PRIMARY_URL]
    assert fx.PRIMARY_URL.startswith("https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@")


def test_provider_falls_back_to_the_mirror():
    seen = []

    def handler(request):
        seen.append(str(request.url))
        if request.url.host == "cdn.jsdelivr.net":
            return httpx.Response(503)
        return httpx.Response(200, content=_payload(php=60))

    rates = CurrencyApiProvider(transport=httpx.MockTransport(handler)).fetch()
    assert rates == {"PHP": (Decimal("60"), date(2026, 11, 1))}
    assert seen == [fx.PRIMARY_URL, fx.MIRROR_URL]
    assert fx.MIRROR_URL.endswith(".currency-api.pages.dev/v1/currencies/usd.min.json")


def test_provider_raises_when_both_sources_fail():
    def handler(request):
        raise httpx.ConnectError("unreachable", request=request)

    with pytest.raises(fx.FxFetchError):
        CurrencyApiProvider(transport=httpx.MockTransport(handler)).fetch()


def test_provider_shares_one_overall_budget():
    timeouts = []
    ticks = iter([0.0, 0.0, 3.5, 3.5, 6.0])

    def handler(request):
        timeouts.append(request.extensions["timeout"]["read"])
        raise httpx.ReadTimeout("slow", request=request)

    provider = CurrencyApiProvider(transport=httpx.MockTransport(handler),
                                   monotonic=lambda: next(ticks))
    with pytest.raises(fx.FxFetchError):
        provider.fetch()
    assert timeouts == [5.0, 1.5]  # the mirror gets only what the first try left


# --- the clock ----------------------------------------------------------------------------

def test_fx_reads_time_only_through_its_clock(monkeypatch):
    """With the module's wall clock poisoned, every path that takes an injected
    clock still works: rates, staleness, scheduling, the refresh task, and the
    test suite's own override (B8)."""
    def poisoned():
        raise AssertionError("wall clock read")

    monkeypatch.setattr(fx, "utcnow", poisoned)
    clock, provider = Clock(), CountingProvider()
    store = _store(datetime(1970, 1, 1))
    _stale_request(store, _refresher(store, provider, clock))
    assert provider.calls == 1

    from app.main import app
    from app.tests.conftest import FX_REF

    override = app.dependency_overrides[get_fx]()
    assert override.clock() == FX_REF
    assert fx._refresher.clock() == FX_REF
    assert override.rate("USD", "PHP").stale is False
    assert FxRates.offline(None).rate("PHP", "USD").rate == Decimal("0.017241")
