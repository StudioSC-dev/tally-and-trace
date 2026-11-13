"""Idempotent creates (STU-604): ``Idempotency-Key`` on every create the save outbox sends.

A client that does not know whether a create arrived (a timeout, a dropped
connection, a reload) repeats it with the same ``Idempotency-Key`` (a UUID). The
repeat must not make a second record, and must get the answer the first one got.

How it works (one dependency, ``idempotency``, and one call, ``finish``):

- No header: nothing here runs; the route behaves as it always did.
- The dependency takes the key by inserting its row (``INSERT .. ON CONFLICT DO
  NOTHING`` on the ``(user_id, key)`` primary key) in the request's own
  transaction, before the handler does anything. Two requests with the same key
  at once: the second waits on that row until the first commits or rolls back,
  then either replays the first's stored answer or, if the first failed, takes the
  key itself. So exactly one of them creates.
- ``finish`` stores the success response on that row and commits, so the key row
  and the create are one transaction: a crash leaves both or neither.
- A request that fails (any non-2xx, or a crash) rolls back, row included, so the
  same key can be retried.
- A key already answered replays the stored status, body and headers byte for byte
  (``IdempotentReplay``, answered by the handler ``install`` registers) without
  running the handler. The same key on another route, or with another body, is a
  422. Keys are per user.
- The daily job deletes rows older than ``RETENTION`` (``purge_expired``).

``OUTBOX_ENDPOINTS`` lists every route the frontend's save outbox (PERF-10) sends
with a key; a test fails when one of them lacks the ``idempotency`` dependency.
"""
import hashlib
import json
import uuid
from datetime import timedelta
from typing import Any, Mapping, Optional

from fastapi import Depends, FastAPI, Header, HTTPException, Request, Response
from pydantic import TypeAdapter
from sqlalchemy import delete, func, select, update
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.orm import Session

from app.core.auth import get_current_active_user
from app.core.database import get_db
from app.models.idempotency_key import IdempotencyKey
from app.models.user import User

RETENTION = timedelta(days=7)

# (method, route path under /api/v1, as declared). The outbox's create paths and the Due card's
# record action; PUT updates are idempotent by body and DELETE by outcome, so they are not here.
OUTBOX_ENDPOINTS: tuple[tuple[str, str], ...] = (
    ("POST", "/transactions/"),
    ("POST", "/transactions/repeating"),
    ("POST", "/transactions/{transaction_id}/repeat"),
    ("POST", "/cards/{account_id}/payments"),
    ("POST", "/budget-entries/"),
    ("POST", "/budget-entries/{entry_id}/materialize"),
    ("POST", "/budget-entries/{entry_id}/materialize-due"),
)


class IdempotentReplay(Exception):
    """Raised by the dependency to answer with a stored response, handler unrun."""

    def __init__(self, response: Response):
        self.response = response


class Idempotency:
    """What the dependency hands a handler: the key it holds, or none."""

    def __init__(self, user_id: Optional[int] = None, key: Optional[uuid.UUID] = None):
        self.user_id = user_id
        self.key = key

    @property
    def active(self) -> bool:
        return self.key is not None


def _canonical(body: bytes) -> str:
    """The body as canonical JSON (parsed, keys sorted, no whitespace); the raw text when it
    is not JSON (the route will refuse it)."""
    if not body:
        return ""
    try:
        return json.dumps(json.loads(body), sort_keys=True, separators=(",", ":"))
    except ValueError:
        return body.decode("utf-8", "replace")


def request_hash(body: bytes) -> str:
    return hashlib.sha256(_canonical(body).encode()).hexdigest()


def _encode(payload: Any) -> bytes:
    """The one serialisation of a stored response, first answer and replay alike."""
    return json.dumps(payload, sort_keys=True, separators=(",", ":"),
                      ensure_ascii=False).encode()


def _response(status_code: int, payload: Any, headers: Optional[Mapping[str, str]]) -> Response:
    return Response(content=_encode(payload), status_code=status_code,
                    headers=dict(headers or {}), media_type="application/json")


async def _raw_body(request: Request) -> bytes:
    return await request.body()


def idempotency(
    request: Request,
    body: bytes = Depends(_raw_body),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_active_user),
    idempotency_key: Optional[str] = Header(
        None, alias="Idempotency-Key",
        description="A UUID the client makes once per save and repeats on every retry."),
) -> Idempotency:
    """Take the request's idempotency key, or replay the answer it already has."""
    if idempotency_key is None:
        return Idempotency()
    try:
        key = uuid.UUID(idempotency_key)
    except ValueError:
        raise HTTPException(status_code=422, detail="Idempotency-Key must be a UUID")
    route = f"{request.method} {request.url.path}"
    digest = request_hash(body)
    taken = db.execute(
        pg_insert(IdempotencyKey)
        .values(user_id=current_user.id, key=key, route=route, request_hash=digest)
        .on_conflict_do_nothing(index_elements=["user_id", "key"])
        .returning(IdempotencyKey.key)
    ).first()
    if taken is not None:
        return Idempotency(current_user.id, key)
    # Someone has it, and has committed by now (the insert waited): read it afresh.
    row = db.execute(
        select(IdempotencyKey.route, IdempotencyKey.request_hash, IdempotencyKey.status_code,
               IdempotencyKey.response_json, IdempotencyKey.response_headers)
        .where(IdempotencyKey.user_id == current_user.id, IdempotencyKey.key == key)
    ).first()
    if row is None:  # purged between the two statements: take it as new
        return idempotency(request, body, db, current_user, idempotency_key)
    if row.route != route or row.request_hash != digest:
        raise HTTPException(
            status_code=422,
            detail="This Idempotency-Key was already used for a different request")
    if row.status_code is None:  # never stored by a finished create: not a replayable answer
        raise HTTPException(status_code=409, detail="This request is still being processed")
    raise IdempotentReplay(_response(row.status_code, row.response_json, row.response_headers))


def finish(
    idem: Any,
    db: Session,
    payload: Any,
    *,
    model: Any,
    status_code: int = 200,
    headers: Optional[Mapping[str, str]] = None,
    response: Optional[Response] = None,
) -> Any:
    """Commit the create, storing its answer when the request holds a key.

    Call it where the handler used to ``db.commit()``, with the response built from the
    flushed (uncommitted) rows: the stored answer is committed with them. ``model`` is the
    route's response model. Without a key (or called directly, ``idem`` not a held key) it
    only commits and returns ``payload`` for FastAPI to serialise, setting ``status_code``
    and ``headers`` on ``response`` when one is given; with one it returns the response itself.
    """
    if not isinstance(idem, Idempotency) or not idem.active:
        db.commit()
        if response is not None:
            response.status_code = status_code
            response.headers.update(headers or {})
        return payload
    adapter = TypeAdapter(model)
    stored = adapter.dump_python(adapter.validate_python(payload), mode="json", by_alias=True)
    stored = json.loads(_encode(stored))  # what the column will hold, so both answers match
    result = db.execute(
        update(IdempotencyKey)
        .where(IdempotencyKey.user_id == idem.user_id, IdempotencyKey.key == idem.key,
               IdempotencyKey.status_code.is_(None))
        .values(status_code=status_code, response_json=stored,
                response_headers=dict(headers) if headers else None)
    )
    if result.rowcount != 1:
        # The handler rolled the key's row away: committing would leave an unguarded create.
        db.rollback()
        raise HTTPException(status_code=500, detail="Could not store the idempotency key")
    db.commit()
    return _response(status_code, stored, headers)


def purge_expired(db: Session, now_cutoff=None) -> int:
    """Delete rows older than ``RETENTION``; the count. Commits."""
    cutoff = now_cutoff or (func.now() - RETENTION)
    count = db.execute(delete(IdempotencyKey).where(IdempotencyKey.created_at < cutoff)).rowcount
    db.commit()
    return count


def install(app: FastAPI) -> None:
    """Register the replay answer on the app."""
    @app.exception_handler(IdempotentReplay)
    async def _replay(_request: Request, exc: IdempotentReplay) -> Response:
        return exc.response
