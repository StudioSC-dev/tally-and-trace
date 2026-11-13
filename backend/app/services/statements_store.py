"""Stored closed card statements, kept current by write-through (STU-601, PERF-6).

The design and the operating notes are in ``docs/statements-store.md``. In short:

- ``card_statements`` holds, per credit card, one row per **closed** cycle (close
  before the Manila day of the read) from the cycle holding its first posted line
  item through ``card_statement_state.materialized_through``, empty cycles
  included: the cycle's line-item balance and line count. A closed cycle holds
  posted rows only (an unposted row sits on the cycle open on the day it is read,
  ``statements.statement_day``), so those figures depend on no reader, no day and
  no exchange rate. Dues, payments, owed, status and the rest are computed on read.
- Reads (``read_card_rows``) take the stored cycles through a bound and replay
  only the rows placed after it, plus the payments. When the last closed cycle is
  past ``materialized_through`` (time closed a cycle; nothing was written), the
  read first catches up in its own short transaction.
- Writes are write-through: a session hook (``before_flush``/``after_flush``,
  registered on every session in ``app/core/database.py``) sees every new, changed
  or deleted ``Transaction`` and recomputes, inside the same transaction, the
  stored cycles the row was or is placed on. A change to a card's billing
  settings deletes and repopulates that card's rows. Bulk writes that bypass the
  ORM call ``reset_cards`` (a guard test keeps that list complete).
- Every writer and the catch-up serialise per card on
  ``pg_advisory_xact_lock(LOCK_NS, card_id)``, taken in card-id order. A read
  holds the same lock shared (``pg_try_advisory_xact_lock_shared``, to the end of
  its transaction) while it reads the stored rows and then the rows after them,
  so no write commits in between; a card it cannot lock at once is replayed.
- ``STATEMENTS_STORE=off`` makes reads replay every row, as before; the write
  hook always runs, so turning the store back on is safe.
"""
from __future__ import annotations

import os
from datetime import date, datetime, time, timedelta
from decimal import Decimal
from typing import Dict, Iterable, List, Optional, Sequence, Set, Tuple

from sqlalchemy import and_, delete, func, or_, select, text
from sqlalchemy import inspect as sa_inspect
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.engine import Engine
from sqlalchemy.orm import Session

from app.core.time import manila_today
from app.models.account import Account, AccountType
from app.models.card_statement import CardStatement, CardStatementState
from app.models.transaction import Transaction, TransactionType
from app.services.statements import (
    StoredCycles, _card_rows, _split_card_rows, cycle_balances, iter_cycles_from, place_days,
    resolve_cycle_fields, statement_close, statement_day,
)

# Namespace of the per-card advisory key (the owner budget lock is 226, STU-226).
LOCK_NS = 601

_T = Transaction.__table__
_A = Account.__table__
_S = CardStatement.__table__
_ST = CardStatementState.__table__

# The transaction fields that decide where a row is placed and what it adds.
_FIELDS = ("account_id", "transaction_type", "amount", "transaction_date", "is_posted",
           "posting_date", "transfer_from_account_id", "transfer_to_account_id",
           "transfer_fee")
# A change to any of these re-keys or may re-key the card's statements.
_BILLING = ("account_type", "billing_cycle_start", "due_date", "days_until_due_date",
            "currency")
_PENDING = "statements_store.pending"


def enabled() -> bool:
    """Whether reads use the stored statements (``STATEMENTS_STORE``, default on)."""
    return os.environ.get("STATEMENTS_STORE", "on").strip().lower() not in (
        "off", "0", "false", "no")


# --- cycle helpers ---------------------------------------------------------------------------

def _close_day(card) -> Optional[int]:
    fields = resolve_cycle_fields(card)
    return fields[0] if fields is not None else None


def _is_card(card) -> bool:
    return card is not None and card.account_type == AccountType.CREDIT and \
        resolve_cycle_fields(card) is not None


def last_close_before(card, day: date) -> date:
    """The card's last close strictly before ``day``: the start of the window
    holding ``day``."""
    cycle = next(iter_cycles_from(card, day, datetime.min, through=day, due_overrides={}))
    return cycle["window_start"].date()


def _midnight(day: date) -> datetime:
    return datetime.combine(day, time())


def _cards(conn, ids: Iterable[int]) -> Dict[int, object]:
    ids = list(set(ids))
    if not ids:
        return {}
    cols = [_A.c.id, *(_A.c[name] for name in _BILLING)]
    return {row.id: row for row in conn.execute(select(*cols).where(_A.c.id.in_(ids)))}


def _states(conn, ids: Iterable[int]) -> Dict[int, object]:
    ids = list(set(ids))
    if not ids:
        return {}
    return {row.card_id: row for row in conn.execute(select(_ST).where(_ST.c.card_id.in_(ids)))}


def _held(db: Session) -> Set[int]:
    """The cards whose lock ``db``'s current transaction holds shared (``load``);
    a new transaction starts with none (the locks went with the last one)."""
    tx = db.get_transaction()
    entry = db.info.get("statements_store_held")
    if entry is None or entry[0] is not tx:
        entry = (tx, set())
        db.info["statements_store_held"] = entry
    return entry[1]


def _try_lock_shared_all(conn, card_ids: Iterable[int]) -> List[int]:
    """The cards whose lock this transaction now holds shared (a reader's), in one
    statement and without waiting; held to the transaction's end. A card whose
    lock a writer or a catch-up holds is left out."""
    ids = sorted(set(card_ids))
    if not ids:
        return []
    rows = conn.execute(text(
        "SELECT id FROM unnest(CAST(:ids AS integer[])) WITH ORDINALITY AS t(id, n) "
        "WHERE pg_try_advisory_xact_lock_shared(:ns, id) ORDER BY n"),
        {"ns": LOCK_NS, "ids": ids})
    return [row.id for row in rows]


def _lock(conn, card_ids: Iterable[int]) -> None:
    for card_id in sorted(set(card_ids)):
        conn.execute(text("SELECT pg_advisory_xact_lock(:ns, :id)"),
                     {"ns": LOCK_NS, "id": card_id})


def _try_lock_all(conn, card_ids: Iterable[int]) -> List[int]:
    """The cards whose lock this transaction got (in id order, one statement);
    a card whose lock is held elsewhere is left out, without waiting."""
    ids = sorted(set(card_ids))
    if not ids:
        return []
    rows = conn.execute(text(
        "SELECT id FROM unnest(CAST(:ids AS integer[])) WITH ORDINALITY AS t(id, n) "
        "WHERE pg_try_advisory_xact_lock(:ns, id) ORDER BY n"), {"ns": LOCK_NS, "ids": ids})
    return [row.id for row in rows]


# --- materialising ---------------------------------------------------------------------------

def posted_lines(conn, card_id: int, after: Optional[date], through: date
                 ) -> List[Tuple[object, date]]:
    """The card's posted line items placed in ``(after, through]`` (from its first
    with no ``after``), each with its ``statement_day``. Lines exactly as the
    replay splits them (``_split_card_rows``): charges and refunds on the card and
    transfers out of it, whoever entered them; a payment into it is no line."""
    query = select(_T.c.id, *(_T.c[name] for name in _FIELDS)).where(
        or_(_T.c.account_id == card_id,
            and_(_T.c.transaction_type == TransactionType.TRANSFER,
                 _T.c.transfer_from_account_id == card_id)),
        _T.c.is_posted.is_(True),
        _T.c.transaction_date < _midnight(through + timedelta(days=1)),
    )
    if after is not None:
        query = query.where(or_(
            _T.c.transaction_date >= _midnight(after + timedelta(days=1)),
            _T.c.posting_date >= _midnight(after - timedelta(days=1)),
        ))
    lines, _ = _split_card_rows(card_id, conn.execute(query).all())
    out = []
    for line in lines:
        day = statement_day(line, through)  # posted: the day of the read is not used
        if (after is None or day > after) and day <= through:
            out.append((line, day))
    return out


def cycle_rows(card, lines: Sequence[Tuple[object, date]], first: Optional[date],
               through: date) -> List[dict]:
    """``card_statements`` rows for every cycle from the one holding ``first`` (with
    None, the one holding the earliest of ``lines``) through the one closing on
    ``through``, empty ones included, from ``lines`` (``posted_lines``)."""
    starts = [day for _, day in lines] + ([first] if first is not None else [])
    if not starts:
        return []
    cycles = list(iter_cycles_from(card, min(starts), datetime.min, through=through,
                                   due_overrides={}))
    cycles = [c for c in cycles if c["close"].date() <= through]
    placed = place_days([day for _, day in lines], cycles)
    balances = cycle_balances([line for line, _ in lines], placed, len(cycles))
    counts = [0] * len(cycles)
    for i in placed:
        if i is not None:
            counts[i] += 1
    close_day = _close_day(card)
    return [{"card_id": card.id, "close": c["close"].date(),
             "window_start": c["window_start"].date(), "line_balance": balance,
             "line_count": count, "close_day": close_day}
            for c, balance, count in zip(cycles, balances, counts)]


def _upsert(conn, rows: List[dict]) -> None:
    if not rows:
        return
    stmt = pg_insert(_S).values(rows)
    stmt = stmt.on_conflict_do_update(
        index_elements=[_S.c.card_id, _S.c.close],
        set_={"window_start": stmt.excluded.window_start,
              "line_balance": stmt.excluded.line_balance,
              "line_count": stmt.excluded.line_count,
              "close_day": stmt.excluded.close_day,
              "computed_at": func.now()})
    conn.execute(stmt)


def _set_state(conn, card_id: int, through: Optional[date], close_day: Optional[int]) -> None:
    stmt = pg_insert(_ST).values(card_id=card_id, materialized_through=through,
                                 close_day=close_day)
    conn.execute(stmt.on_conflict_do_update(
        index_elements=[_ST.c.card_id],
        set_={"materialized_through": stmt.excluded.materialized_through,
              "close_day": stmt.excluded.close_day}))


def _forget(conn, card_id: int) -> None:
    conn.execute(delete(_S).where(_S.c.card_id == card_id))
    conn.execute(delete(_ST).where(_ST.c.card_id == card_id))


def materialize(conn, card, state, today: date) -> None:
    """Bring the card's stored rows up to its last close before ``today``. The
    caller holds the card's lock and read ``state`` after taking it.

    From ``materialized_through`` on when the state is current; from scratch
    (its old rows deleted) when there is none or it was kept under another close
    day (settings changed by a path the hook did not see)."""
    close_day = _close_day(card)
    target = last_close_before(card, today)
    through = None
    if state is not None and state.close_day == close_day:
        through = state.materialized_through
    else:
        conn.execute(delete(_S).where(_S.c.card_id == card.id))
    if through is not None and through >= target:
        return
    lines = posted_lines(conn, card.id, through, target)
    first = through + timedelta(days=1) if through is not None else None
    _upsert(conn, cycle_rows(card, lines, first, target))
    _set_state(conn, card.id, target, close_day)


def repopulate(conn, card_id: int, card, today: date) -> None:
    """Delete the card's stored statements and recompute every closed cycle under
    its current settings (none when it is no longer a modellable credit card).
    The caller holds the card's lock."""
    _forget(conn, card_id)
    if _is_card(card):
        materialize(conn, card, None, today)


def recompute(conn, card, closes: Set[date]) -> None:
    """Recompute the stored cycles closing on ``closes`` from the rows. The
    caller holds the card's lock."""
    if not closes:
        return
    windows = {close: next(iter_cycles_from(card, close, datetime.min, through=close,
                                            due_overrides={}))["window_start"].date()
               for close in closes}
    low, high = min(windows.values()), max(closes)
    rows = cycle_rows(card, posted_lines(conn, card.id, low, high),
                      low + timedelta(days=1), high)
    _upsert(conn, [row for row in rows if row["close"] in closes])


# --- reads -----------------------------------------------------------------------------------

def catch_up(db: Session, cards: Sequence, today: date) -> None:
    """Materialise the cards' newly closed cycles in a short transaction of its
    own, committed at once. A card whose lock is held (a writer, possibly this
    request's own session, or another catch-up) is skipped: the read then
    replays those cycles from the rows, which is the same answer."""
    bind = db.get_bind()
    if not isinstance(bind, Engine) or bind.dialect.name != "postgresql":
        return
    with Session(bind) as own:
        conn = own.connection()
        locked = _try_lock_all(conn, {c.id for c in cards})
        fresh, states = _cards(conn, locked), _states(conn, locked)
        for card_id in locked:
            card = fresh.get(card_id)
            if _is_card(card):
                materialize(conn, card, states.get(card_id), today)
        own.commit()


def load(db: Session, cards: Sequence, day: date, *, catch_up_first: bool = True
         ) -> Dict[int, StoredCycles]:
    """``{card id: StoredCycles}`` for the read of ``cards`` on ``day``, catching
    up first (unless ``catch_up_first`` is False: then nothing is written). A
    card is left out when it has no usable stored rows (the read then replays
    every row); ``through`` is the earlier of ``materialized_through`` and the
    card's last close before ``day``."""
    cards = [c for c in cards if _is_card(c)]
    if not cards or db is None:
        return {}
    conn = db.connection()
    today = manila_today()
    held = _held(db)

    def usable(card, states) -> bool:
        state = states.get(card.id)
        return (state is not None and state.materialized_through is not None
                and state.close_day == _close_day(card))

    # The stored rows and the rows the read then takes (``_card_rows``) must be one
    # view: a writer committing between the two would leave a cycle it changed
    # stale here, its rows dropped there. A writer holds the card's lock to its
    # commit, so a shared hold (to this transaction's end) keeps one out until the
    # read is done; a card whose lock a writer holds now is replayed instead.
    # Taken without waiting, so a read never joins a lock wait. Once per card per
    # transaction: a card already held is read at once (no catch-up can take it).
    fresh = [c for c in cards if c.id not in held]
    if fresh:
        first = _states(conn, [c.id for c in fresh])
        behind = [c for c in fresh if not usable(c, first)
                  or first[c.id].materialized_through < last_close_before(c, today)]
        if behind and catch_up_first:
            catch_up(db, behind, today)
        held.update(_try_lock_shared_all(conn, [c.id for c in fresh]))
    locked = [c.id for c in cards if c.id in held]
    if not locked:
        return {}
    states = {}
    found: Dict[int, Dict[date, Tuple[Decimal, int]]] = {}
    # The state and its rows read again in one statement, under the lock.
    joined = (select(_ST.c.card_id, _ST.c.materialized_through, _ST.c.close_day, _S.c.close,
                     _S.c.line_balance, _S.c.line_count)
              .select_from(_ST.outerjoin(_S, _S.c.card_id == _ST.c.card_id))
              .where(_ST.c.card_id.in_(locked)))
    for row in conn.execute(joined):
        states[row.card_id] = row
        if row.close is not None:
            found.setdefault(row.card_id, {})[row.close] = (Decimal(row.line_balance),
                                                            row.line_count)
    bounds = {c.id: min(states[c.id].materialized_through, last_close_before(c, day))
              for c in cards if usable(c, states)}
    return {cid: StoredCycles(through=bounds[cid],
                              cycles={close: v for close, v in found.get(cid, {}).items()
                                      if close <= bounds[cid]})
            for cid in bounds}


def read_card_rows(db: Session, cards: Sequence, viewable_ids: Iterable[int], day: date, *,
                   catch_up_first: bool = True):
    """``(card_rows, stored_by_card)`` for reading ``cards`` on ``day``.

    ``card_rows`` is a ``statements._card_rows`` result: with the store on and
    every modellable card stored, only the rows that can be placed after the
    earliest stored bound plus every payment; otherwise every row.
    ``stored_by_card`` is ``load``'s result ({} with the store off). Pass both to
    ``statement_summaries`` / ``build_statement_payables``."""
    viewable_ids = list(viewable_ids)
    stored = load(db, cards, day, catch_up_first=catch_up_first) if enabled() else {}
    modelled = [c for c in cards if _is_card(c)]
    after = None
    if modelled and all(c.id in stored for c in modelled):
        after = min(stored[c.id].through for c in modelled)
    return _card_rows(db, [c.id for c in cards], viewable_ids, lines_after=after), stored


# --- bulk paths ------------------------------------------------------------------------------

def reset_cards(db: Session, card_ids: Iterable[Optional[int]]) -> None:
    """Forget the cards' stored statements (the next read rebuilds them). For a
    write that bypasses the ORM (raw SQL, ``query(...).delete()``): call it in the
    same transaction, before or after that write."""
    ids = sorted({i for i in card_ids if i})
    if not ids or db.get_bind().dialect.name != "postgresql":
        return
    conn = db.connection()
    _lock(conn, ids)
    for card_id in ids:
        _forget(conn, card_id)


def user_card_ids(db: Session, user_ids: Iterable[int]) -> List[int]:
    """The credit cards the users own or their transactions touch: what a bulk
    delete of the users' transactions or accounts can change (``reset_cards``)."""
    ids = list(user_ids)
    if not ids:
        return []
    touched = select(_T.c.account_id).where(_T.c.user_id.in_(ids)).union(
        select(_T.c.transfer_from_account_id).where(_T.c.user_id.in_(ids)))
    return [i for (i,) in db.execute(select(_A.c.id).where(
        _A.c.account_type == AccountType.CREDIT,
        or_(_A.c.user_id.in_(ids), _A.c.id.in_(touched))).order_by(_A.c.id))]


# --- write-through ---------------------------------------------------------------------------

def _identity(obj) -> Optional[int]:
    key = sa_inspect(obj).identity
    return key[0] if key else None


def _txn_states(conn, ids: Iterable[int]) -> Dict[int, tuple]:
    ids = list(set(ids))
    if not ids:
        return {}
    cols = [_T.c[name] for name in _FIELDS]
    return {row.id: row for row in conn.execute(select(_T.c.id, *cols).where(_T.c.id.in_(ids)))}


def _billing(conn, ids: Iterable[int]) -> Dict[int, tuple]:
    return {cid: tuple(getattr(row, name) for name in _BILLING)
            for cid, row in _cards(conn, ids).items()}


def placement(state) -> Optional[Tuple[int, date]]:
    """``(card id, statement_day)`` of a stored transaction state when it is a
    posted line item, else None: exactly where ``_split_card_rows`` puts it (a
    transfer is a line of its source unless it is paid into that same account).
    An unposted row is on no closed cycle, so it is never stored."""
    if state.is_posted is not True:
        return None
    if state.transaction_type == TransactionType.TRANSFER:
        source = state.transfer_from_account_id or state.account_id
        if state.transfer_to_account_id == source:
            return None
        card_id = source
    else:
        card_id = state.account_id
    if card_id is None:
        return None
    return card_id, statement_day(state, date.min)


def _postgres(session: Session) -> bool:
    try:
        return session.get_bind().dialect.name == "postgresql"
    except Exception:
        return False


def before_flush(session: Session, flush_context, instances) -> None:
    txns_old = [i for i in (_identity(o) for o in (*session.dirty, *session.deleted)
                            if isinstance(o, Transaction)) if i is not None]
    txns_new = [o for o in session.new if isinstance(o, Transaction)]
    accounts = [i for i in (_identity(o) for o in session.dirty if isinstance(o, Account))
                if i is not None]
    if not (txns_old or txns_new or accounts) or not _postgres(session):
        return
    # The rows still hold their state before this flush.
    conn = session.connection()
    session.info.setdefault(_PENDING, []).append({
        "old": _txn_states(conn, txns_old),
        "dirty": [i for i in (_identity(o) for o in session.dirty
                              if isinstance(o, Transaction)) if i is not None],
        "new": txns_new,
        "billing": _billing(conn, accounts),
    })


def after_flush(session: Session, flush_context) -> None:
    pending = session.info.pop(_PENDING, None)
    if not pending:
        return
    conn = session.connection()
    touched: Dict[int, Set[date]] = {}
    repop: Set[int] = set()
    for batch in pending:
        # A new row's key is in its dict once inserted (its identity is set later).
        ids = batch["dirty"] + [i for i in (sa_inspect(o).dict.get("id") for o in batch["new"])
                                if i is not None]
        new = _txn_states(conn, ids)
        for txn_id in set(batch["old"]) | set(new):
            before, after = batch["old"].get(txn_id), new.get(txn_id)
            if before is not None and after is not None and tuple(before) == tuple(after):
                continue
            for state in (before, after):
                placed = placement(state) if state is not None else None
                if placed is not None:
                    touched.setdefault(placed[0], set()).add(placed[1])
        now = _billing(conn, batch["billing"])
        repop |= {cid for cid, old in batch["billing"].items()
                  if cid in now and now[cid] != old}
    apply_changes(conn, touched, repop)


def apply_changes(conn, touched: Dict[int, Set[date]], repop: Set[int]) -> None:
    """Under each card's lock, in card-id order: repopulate the cards in
    ``repop`` and recompute, on every other stored card, the stored cycles
    holding the ``touched`` statement days. Every touched credit card is locked,
    stored or not, so a catch-up never commits a cycle computed from rows this
    transaction is changing."""
    cards = _cards(conn, set(touched) | repop)
    ids = sorted(cid for cid, card in cards.items()
                 if card.account_type == AccountType.CREDIT or cid in repop)
    if not ids:
        return
    _lock(conn, ids)
    today = manila_today()
    states = _states(conn, ids)
    for cid in ids:
        card = cards[cid]
        state = states.get(cid)
        if cid in repop:
            if state is not None or _is_card(card):
                repopulate(conn, cid, card, today)
            continue
        if not _is_card(card) or state is None or state.materialized_through is None:
            continue
        if state.close_day != _close_day(card):
            repopulate(conn, cid, card, today)
            continue
        through = state.materialized_through
        recompute(conn, card, {statement_close(card, day) for day in touched.get(cid, ())
                               if day <= through})


# --- verification (the statements_store command, tests) -------------------------------------

def verify_card(db: Session, card, viewable_ids: Iterable[int], today: date, fx=None) -> dict:
    """Whether the card's stored statements match its rows. Reads only.

    ``rows_equal``: every stored row through ``materialized_through`` holds the
    balance and line count the rows give (empty cycles may be missing or zero),
    under the card's current close day, and no row is past it.
    ``summaries_equal``: ``statement_summaries`` on ``today`` from the stored
    rows as they are (no catch-up) equals the replay of every row.
    Counts and booleans only: no amount leaves this function.
    """
    from app.services.statements import statement_summaries

    conn = db.connection()
    state = _states(conn, [card.id]).get(card.id)
    rows = list(conn.execute(select(_S).where(_S.c.card_id == card.id)))
    through = state.materialized_through if state is not None else None
    close_day = _close_day(card)
    rows_equal = True
    if through is not None:
        expected = {r["close"]: (Decimal(r["line_balance"]), r["line_count"])
                    for r in cycle_rows(card, posted_lines(conn, card.id, None, through),
                                        None, through)}
        found = {r.close: (Decimal(r.line_balance), r.line_count) for r in rows}
        rows_equal = (
            state.close_day == close_day
            and all(r.close_day == close_day and r.close <= through for r in rows)
            and all(balance == 0 for balance, count in found.values() if count == 0)
            and {k: v for k, v in found.items() if v[1]}
            == {k: v for k, v in expected.items() if v[1]})
    else:
        rows_equal = not rows
    viewable_ids = list(viewable_ids)
    midnight = datetime.combine(today, time())
    card_rows, stored = read_card_rows(db, [card], viewable_ids, today, catch_up_first=False)
    from_store = statement_summaries(db, card, midnight, viewable_ids, fx=fx,
                                     card_rows=card_rows, stored=stored.get(card.id))
    replay = statement_summaries(db, card, midnight, viewable_ids, fx=fx,
                                 card_rows=_card_rows(db, [card.id], viewable_ids))
    return {
        "card_id": card.id,
        "stored_rows": len(rows),
        "materialized": through is not None,
        "behind": through is None or through < last_close_before(card, today),
        "rows_equal": rows_equal,
        "summaries_equal": repr(from_store) == repr(replay),
    }
