"""One request's context: who is asking, and what the request has already read (STU-598).

A read builds a ``RequestContext`` once (the ``request_context`` dependency) and
hands it to the services it calls in place of ``(db, user)``. The context holds
what every one of them would otherwise derive again on its own:

- the caller (``user``, ``uid``), the request's rates (``fx``) and its Manila day
  (``today``), stamped once;
- the ``AccessMap`` of the caller (and of any record creator a rule asks about),
  one ``RecordAccess`` and one ``Redactor`` per user, and the caller's Household
  grants (``access``, ``record_access``, ``redactor``, ``grants``), so roles,
  accounts and creators load once per request;
- the projection scope (``accounts``) and the caller's default currency;
- the projection's events (``forecast.shared_events``): ``collect_events`` runs
  once, over the widest window the request asks for (``widen_events``), and each
  list keeps the events of its own window;
- bulk reads by record id (``by_id``): a recurring entry's linked rows and forced
  dates, a card's printed dues, loaded for every record the request may touch in
  one query instead of one query per entry or card.

**Bound to the session.** ``bind`` puts the context on the request's session
(``context_of``) for the length of the request, so the helpers shared with write
paths (``access_map``, ``_linked_rows``, ``load_entry_overrides``, ...) answer
from it inside a read and read the database as before anywhere else (a write
route, a script, a test's own session). Everything held is dropped when the
session flushes, commits or rolls back, so a write made in the same session is
never answered from before it. A context that is not bound (built by hand, as
the tests do) still shares its own members between the services it is passed to.
"""
from __future__ import annotations

from datetime import date, datetime
from typing import Any, Callable, Dict, Hashable, Iterable, List, Optional

from fastapi import Depends
from sqlalchemy import event
from sqlalchemy.orm import Session

from app.core.auth import get_current_active_user
from app.core.database import get_db
from app.core.time import manila_today
from app.services.fx import FxRates, get_fx

CONTEXT_KEY = "request_context"
_DROP_ON = ("after_flush", "after_commit", "after_rollback")


def context_of(db) -> Optional["RequestContext"]:
    """The context bound to ``db`` (``RequestContext.bind``), or None."""
    info = getattr(db, "info", None)
    return info.get(CONTEXT_KEY) if info is not None else None


class RequestContext:
    """What one request knows about its caller and has read (module docstring)."""

    def __init__(self, db: Session, user, *, fx=None, today: Optional[date] = None):
        self.db = db
        self.user = user
        self.uid: Optional[int] = getattr(user, "id", user)
        self.fx = fx
        self.today: date = today if today is not None else manila_today()
        # The furthest end any list of this request reads events to (``widen_events``).
        self.event_horizon: Optional[datetime] = None
        self._memo: Dict[Hashable, Any] = {}
        self._rows: Dict[str, Dict[Hashable, Any]] = {}

    # --- binding ---------------------------------------------------------------------------

    def bind(self) -> "RequestContext":
        """Put the context on its session (``context_of``) until ``unbind``."""
        self.db.info[CONTEXT_KEY] = self
        for name in _DROP_ON:
            event.listen(self.db, name, self._drop)
        return self

    def unbind(self) -> None:
        if self.db.info.get(CONTEXT_KEY) is self:
            del self.db.info[CONTEXT_KEY]
        for name in _DROP_ON:
            if event.contains(self.db, name, self._drop):
                event.remove(self.db, name, self._drop)
        self._drop()

    def _drop(self, *_args) -> None:
        """Forget everything read: the session wrote, or ended its transaction."""
        self._memo.clear()
        self._rows.clear()

    # --- memos -----------------------------------------------------------------------------

    def memo(self, key: Hashable, compute: Callable[[], Any]) -> Any:
        """``compute()`` once per request for ``key`` (dropped on a write)."""
        if key not in self._memo:
            self._memo[key] = compute()
        return self._memo[key]

    def by_id(self, kind: str, ids: Iterable, load: Callable[[List], Dict[Any, Any]], *,
              universe: Optional[Callable[[], Iterable]] = None) -> Dict[Any, Any]:
        """``{id: value}`` for ``ids``, each read once per request.

        ``load(ids)`` reads the values of the ids given, one per id it finds (an
        id it leaves out reads as None). On the first miss of ``kind`` the ids of
        ``universe()`` are read along, so a request walking its records one at a
        time reads them all in one query.
        """
        held = self._rows.setdefault(kind, {})
        wanted = [i for i in dict.fromkeys(ids) if i is not None]
        missing = [i for i in wanted if i not in held]
        if missing:
            if universe is not None and (kind, "universe") not in self._memo:
                self._memo[(kind, "universe")] = True
                seen = set(missing)
                missing += [i for i in dict.fromkeys(universe())
                            if i is not None and i not in held and i not in seen]
            found = load(missing)
            for i in missing:
                held[i] = found.get(i)
        return {i: held[i] for i in wanted}

    # --- the caller ------------------------------------------------------------------------

    def access_map(self, uid: Optional[int] = None):
        """``uid``'s ``AccessMap`` (default the caller): one query per user."""
        from app.core.access import _build_access_map

        uid = self.uid if uid is None else uid
        return self.memo(("access_map", uid), lambda: _build_access_map(self.db, uid, None))

    @property
    def access(self):
        return self.access_map()

    def record_access_of(self, uid: Optional[int] = None):
        """``uid``'s ``RecordAccess`` (default the caller), one per user."""
        from app.core.access import RecordAccess

        uid = self.uid if uid is None else uid
        return self.memo(("record_access", uid), lambda: RecordAccess(self.db, uid))

    @property
    def record_access(self):
        return self.record_access_of()

    def redactor_of(self, user=None):
        """``user``'s ``Redactor`` (default the caller) over its ``RecordAccess``."""
        from app.core.redaction import Redactor

        user = self.user if user is None else user
        uid = getattr(user, "id", user)
        return self.memo(("redactor", uid),
                         lambda: Redactor(self.db, user, self.record_access_of(uid)))

    @property
    def redactor(self):
        return self.redactor_of()

    @property
    def grants(self):
        """The caller's Household grants, by sharer (``RecordAccess.grants``)."""
        return self.record_access.grants

    def viewable_ids(self, *, roles=None, active_only: bool = False) -> set:
        """``viewable_account_ids`` from the request's ``AccessMap``."""
        from app.core.access import DIRECT_ROLES

        return self.access.ids(DIRECT_ROLES if roles is None else roles,
                               active_only=active_only)

    @property
    def accounts(self) -> list:
        """The projection scope (``forecast.get_account_balances``), in id order."""
        from app.services.forecast import _scope_accounts

        return list(self.memo(("accounts", self.uid),
                              lambda: _scope_accounts(self.db, self.uid)))

    @property
    def default_currency(self) -> str:
        from app.services.forecast import default_currency

        return self.memo("default_currency", lambda: default_currency(self.db, self.uid))

    def entry_ids(self) -> List[int]:
        """Every active recurring entry the request may walk: the caller's own and
        every one touching an account they hold any role on (one query, shared with
        ``entry_pairs``). The bulk reads of entries (``by_id``) read these with their
        first miss."""
        return [i for i, _, _ in self._entries()]

    def entry_pairs(self) -> List[tuple]:
        """The (creator, account) pairs of ``entry_ids``' entries that have an account:
        the held-month assignment reads these with its first miss
        (``installment_duplicates.held_assignment``)."""
        return sorted({(u, a) for _, u, a in self._entries() if a is not None})

    def _entries(self) -> List[tuple]:
        def load() -> List[tuple]:
            from sqlalchemy import or_

            from app.core.access import touches_accounts
            from app.models.budget_entry import BudgetEntry

            held = list(self.access.roles)
            criterion = BudgetEntry.user_id == self.uid
            if held:
                criterion = or_(criterion, touches_accounts(BudgetEntry, held))
            return [tuple(row) for row in self.db.query(
                BudgetEntry.id, BudgetEntry.user_id, BudgetEntry.account_id).filter(
                BudgetEntry.is_active.is_(True), criterion).order_by(BudgetEntry.id)]

        return self.memo("entries", load)

    def events_run(self, key: Hashable, end: datetime,
                   collect: Callable[[datetime], List[dict]]) -> List[dict]:
        """The events of the request's one run for ``key`` (a start, a view), read
        to at least ``end``: ``collect(horizon)`` runs once, to the furthest of
        ``end`` and ``event_horizon`` (``widen_events``), and again only for a
        later ``end``. The list is shared: callers copy what they change."""
        run = self._memo.get(("events", key))
        if run is None or run[0] < end:
            horizon = end if self.event_horizon is None else max(end, self.event_horizon)
            run = (horizon, collect(horizon))
            self._memo[("events", key)] = run
        return run[1]

    def widen_events(self, end: datetime) -> None:
        """Note that a list of this request reads events up to ``end``, so the one
        ``collect_events`` run covers it (``forecast.shared_events``)."""
        if self.event_horizon is None or end > self.event_horizon:
            self.event_horizon = end


def request_context(db: Session = Depends(get_db), user=Depends(get_current_active_user),
                    fx: FxRates = Depends(get_fx)):
    """FastAPI dependency: the request's context, bound to its session for the
    length of the request (FastAPI builds it once per request)."""
    ctx = RequestContext(db, user, fx=fx).bind()
    try:
        yield ctx
    finally:
        ctx.unbind()
