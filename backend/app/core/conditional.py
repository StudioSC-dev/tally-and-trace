"""Conditional GETs (STU-602, PERF-7): ``ETag`` and ``304 Not Modified`` keyed on the
database's data version (core/data_version.py).

A route opts in with one line in its decorator::

    @router.get("/snapshot", dependencies=[Depends(conditional_get)])

The dependency runs after auth and before the handler's own work. It reads the data
version first, before any data read, and computes

    ETag = W/"hash(version, user id, Manila day, UTC day, method, path,
                   query sorted by name, RENDER_GIT_COMMIT, job flag)"

When ``If-None-Match`` names that tag, it answers ``304`` (``NotModified``) and the
handler never runs. Otherwise the handler runs and its 200 carries ``ETag``,
``Cache-Control: private, no-cache`` and ``Vary: Authorization``; an error raised by
the handler carries none of them.

Why the version is read first: a write committed between that read and the
handler's reads leaves new data under the old version's tag, and the next request,
seeing the new version, gets a 200. Read the other way round, old data could carry
the new version's tag and be revalidated with a 304 indefinitely.

What else the key holds, and why. An opted-in endpoint's answer may depend only on
the data, the caller, the request and the things below; one that depends on time
finer than these is not opted in.

- The Manila day: every due, missed and window decision turns at Manila midnight.
- The UTC day: ``/dashboard/snapshot``'s wishlist ``affordable_by`` and an identity
  rate's ``as_of`` read the UTC date, which turns at 08:00 Manila.
- ``RENDER_GIT_COMMIT``: a deploy may change any answer's shape.
- Whether ``JOB_TOKEN`` is set: ``auto_post_scheduled`` (snapshot, upcoming
  occurrences) reads it, and a Render env change restarts with the same commit.
- An exchange rate older than 24 hours turns ``stale`` with no write, and its
  refresh is scheduled by the handler, so while any stored rate is stale no 304 is
  given (``FxRates.has_stale_row``). The refresh writes ``fx_rates``, which bumps.

Opted in (each checked for wall-clock reads finer than a day; none found beyond the
above): ``/dashboard/snapshot``, ``/budget-entries/installment-plans``,
``/budget-entries/upcoming-occurrences``, ``/transactions/``, ``/accounts/``,
``/categories/``, ``/budget-entries/``. ``/dashboard/due`` (PERF-4) and
``/cards/{id}/statements`` (PERF-6) opt in with the same one line when they land.

The browser's HTTP cache sends ``If-None-Match`` by itself (fetch's default cache
mode), so the web client needs no code for 304s.
"""
import hashlib
import os
from typing import Dict
from urllib.parse import urlencode

from fastapi import Depends, FastAPI, Request, Response
from sqlalchemy.orm import Session

from app.core import data_version
from app.core import time as clock
from app.core.auth import get_current_active_user
from app.core.config import settings
from app.core.database import get_db
from app.models.user import User
from app.services.fx import FxRates, get_fx

CACHE_CONTROL = "private, no-cache"
VARY = "Authorization"


class NotModified(Exception):
    """Answered as a bodiless 304 with ``headers`` (registered by ``install``)."""

    def __init__(self, headers: Dict[str, str]):
        self.headers = headers


def canonical_query(request: Request) -> str:
    """The query string with its parameters sorted by name. A repeated name keeps its
    values' order, which an endpoint may honour (``ids=2&ids=1``)."""
    items = sorted(request.query_params.multi_items(), key=lambda kv: kv[0])
    return urlencode(items)


def etag_for(version: int, user_id: int, request: Request) -> str:
    now = clock.naive_utc_now()
    manila_day = (now + clock.MANILA_OFFSET).date()
    parts = (
        str(version), str(user_id), manila_day.isoformat(), now.date().isoformat(),
        request.method, request.url.path, canonical_query(request),
        os.environ.get("RENDER_GIT_COMMIT", ""), str(settings.JOB_TOKEN is not None),
    )
    digest = hashlib.sha256("\x1f".join(parts).encode()).hexdigest()[:32]
    return f'W/"{digest}"'


def _opaque(tag: str) -> str:
    tag = tag.strip()
    return tag[2:] if tag.startswith("W/") else tag


def matches(if_none_match: str, etag: str) -> bool:
    """Weak comparison against an ``If-None-Match`` list (a proxy may weaken a tag).
    ``*`` is not honoured: a 200 is never wrong."""
    if not if_none_match:
        return False
    want = _opaque(etag)
    return any(_opaque(t) == want for t in if_none_match.split(","))


def conditional_get(
    request: Request,
    response: Response,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_active_user),
    fx: FxRates = Depends(get_fx),
) -> None:
    version = data_version.current_version(db)  # first: before any data read
    if version is None:
        return
    etag = etag_for(version, current_user.id, request)
    headers = {"ETag": etag, "Cache-Control": CACHE_CONTROL, "Vary": VARY}
    if matches(request.headers.get("if-none-match", ""), etag) and not fx.has_stale_row():
        raise NotModified(headers)
    # Kept by FastAPI on the handler's own 200 only; an error response drops them.
    response.headers.update(headers)


def install(app: FastAPI) -> None:
    """Register the 304 answer on the app."""
    @app.exception_handler(NotModified)
    async def _not_modified(_request: Request, exc: NotModified) -> Response:
        return Response(status_code=304, headers=exc.headers)
