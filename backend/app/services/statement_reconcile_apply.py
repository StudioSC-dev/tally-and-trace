"""Reconcile a card statement: load, diff, apply, verify (STU-749).

``POST /cards/{account_id}/statements/reconcile`` (``routers/cards.py``) drives it.
The diff itself is pure (``services/statement_reconcile.py``, STU-746); this module
reads the card's rows into ``RowRecord`` values, applies the diff's actions through
the existing write paths, and proves the result with the app's own statement
computation.

Which statement
---------------
The statement's ``close_date`` must be before Manila's today. When it is a close of
the card, that statement (closed) is the one compared. Otherwise it is compared with
the card's nearest close either side, at most ``NEAR_CLOSE_DAYS`` away (``app_close``;
farther, 422): the diff has no row actions and an apply is refused, since the card's
closing day must be changed first.

Rows (``load``)
---------------
The card's rows are read as every statement read reads them: by card id alone,
whoever entered them (``statements._card_rows``), after the caller's access to
the card was checked, split into line items and payments
(``statements._split_card_rows``; a cash advance is a charge of its amount plus
fee) and put in the card's currency (``statements.normalise_lines``; a pending
row with no stored rate is left out). Each line item is placed by
``statements.statement_day`` read on Manila's today:

- cycle rows: posted line items placed in ``(window_start, close]``;
- candidates: posted line items placed on the statement before or after it,
  and unposted line items dated on or before the next statement's close (a row
  planned later than that is not claimed);
- payments: payments into the card dated from the previous statement's window
  through the next statement's close.

Apply (``apply``)
-----------------
One database transaction, locks in ``core/locking.py`` order: the budget lock of
every owner of a row read (and the caller's), ascending; then every line-item row
read, ascending id; then the card and every other account those rows touch,
ascending. The rows are then read again and the diff recomputed under the locks:
a row that appeared since (not locked), a fingerprint that differs from the dry
run's, or an unbalanced diff refuses the apply (409) before anything is written.

- header: the printed due (``store_due_override``, the printed-due PUT's rules)
  and the minimum due (``store_minimum``) when the statement gives them and they
  differ;
- ``update`` / ``move``: ``routers.transactions.apply_transaction_update`` (the
  body of ``PUT /transactions/{id}``) with the statement's amount, dates and
  ``is_posted``; a cash advance's amount is the line less its fee;
- ``create``: ``routers.transactions.add_transaction``, a posted, uncategorised
  row in the card's currency, ``created_by_actor`` the caller, keeping the line's
  ``original_amount``/``original_currency`` (and the ``exchange_rate`` between
  them) as a posted foreign create stores them;
- ``unpost``: ``apply_transaction_update`` with ``is_posted`` False. A row linked
  to a recurring entry is refused (see ``LINKED_UNPOST``).

Any refusal from a write path refuses the whole apply with its reason (409) and
writes nothing.

Verify (``verify``)
-------------------
After the writes are flushed, inside the transaction: the statement's line balance
by ``statements.statement_summaries`` (the stored statements, as every read gets
them) and by ``statements.statement_lines`` (a replay of the window's rows) must
both equal the statement's charges less credits. Otherwise the transaction is
rolled back and the gap returned (409).

On success every line item on the statement is marked ``is_reconciled`` (an
unposted row is cleared), and ``statement_reconciliations`` gets one row per card
and close.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date, datetime, time, timedelta
from decimal import Decimal
from typing import Dict, List, Optional, Sequence, Tuple

from fastapi import HTTPException
from pydantic import ValidationError
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.orm import Session
from sqlalchemy.sql import func

from app.core import locking
from app.core.access import (
    MANAGE_ROLES, NONE, get_account_or_404, role_map, viewable_account_ids,
)
from app.core.time import manila_day, manila_midnight, manila_today
from app.models.account import Account, AccountType
from app.models.card_statement_due_override import CardStatementDueOverride
from app.models.card_statement_minimum import CardStatementMinimum
from app.models.statement_reconciliation import StatementReconciliation
from app.models.transaction import Transaction, TransactionType
from app.models.user import CurrencyType, User
from app.schemas.statement_reconcile import BankStatement, StatementLine
from app.services import statement_reconcile as sr
from app.services.statements import (
    _card_rows, _split_card_rows, due_in_order, iter_cycles_from, load_due_overrides,
    normalise_lines, resolve_cycle_fields, statement_close, statement_day, statement_lines,
    statement_summaries,
)

CLOSING_DAY = ("This statement closes on {statement}, but this card's cycle closes on {app}: "
               "change the card's closing day first")
# A statement closing at most this many days from one of the card's closes is that
# statement with the closing day moved (refused as such); farther, it is not the card's.
NEAR_CLOSE_DAYS = 7
LINKED_UNPOST = ("Row {row} is linked to a recurring entry: unposting it here would leave "
                 "the entry's paid count and schedule as they are")


def managed_card(db: Session, user: User, account_id: int) -> Account:
    """The card, 404 unless ``user`` is an owner or admin of it, 400 when it is not a
    credit card. The reconcile route's access check, shared with its owner-run script."""
    card = get_account_or_404(db, user, account_id, roles=MANAGE_ROLES)
    if card.account_type != AccountType.CREDIT:
        raise HTTPException(status_code=400, detail="Only a credit card has available credit")
    return card


# --- header writes (shared with the printed-due and minimum-due PUT handlers) -------------

def store_minimum(db: Session, card: Account, close: date, amount: Decimal,
                  actor_id: int) -> None:
    """Upsert the statement's printed minimum amount due. Uncommitted."""
    statement = pg_insert(CardStatementMinimum).values(
        account_id=card.id, statement_close=close, amount=amount, created_by_actor=actor_id)
    db.execute(statement.on_conflict_do_update(
        constraint="uq_card_statement_minimums_account_close",
        set_={"amount": statement.excluded.amount,
              "created_by_actor": statement.excluded.created_by_actor,
              "updated_at": func.now()}))


def store_due_override(db: Session, card: Account, close: date, due: date,
                       actor_id: int) -> None:
    """Upsert the statement's printed due, 422 unless it is after the close and
    strictly between the dues of the statements either side. The caller holds the
    card's lock. Uncommitted."""
    overrides = load_due_overrides(db, [card.id])[card.id]
    if due <= close:
        raise HTTPException(status_code=422, detail="The due date must be after the close")
    if not due_in_order(card, close, {**overrides, close: due}):
        raise HTTPException(
            status_code=422,
            detail="The due date must fall between the previous and the next statement's "
                   "due dates")
    statement = pg_insert(CardStatementDueOverride).values(
        account_id=card.id, statement_close=close, due_date=due, created_by_actor=actor_id)
    db.execute(statement.on_conflict_do_update(
        constraint="uq_card_statement_due_overrides_account_close",
        set_={"due_date": statement.excluded.due_date,
              "created_by_actor": statement.excluded.created_by_actor,
              "updated_at": func.now()}))


# --- loading ------------------------------------------------------------------------------

@dataclass
class Loaded:
    """The card's rows read for one statement."""
    view: sr.AppStatementView
    cycle: List[sr.RowRecord]
    candidates: List[sr.RowRecord]
    payments: List[sr.RowRecord]
    # Every line-item row read (cycle and candidates), by id.
    rows: Dict[int, Transaction] = field(default_factory=dict)


def statement_view(db: Session, card: Account, statement: BankStatement) -> sr.AppStatementView:
    """The app's statement for the bank statement's cycle. 400 for a card without
    cycle settings; 422 unless that statement has closed (see ``app_close``)."""
    if resolve_cycle_fields(card) is None:
        raise HTTPException(status_code=400,
                            detail="This card has no statement cycle (set its closing day)")
    close = app_close(card, statement.header.close_date, manila_today())
    overrides = load_due_overrides(db, [card.id])[card.id]
    cycle = next(iter_cycles_from(card, close, datetime.min, through=close,
                                  due_overrides=overrides))
    minimum = (db.query(CardStatementMinimum.amount)
               .filter(CardStatementMinimum.account_id == card.id,
                       CardStatementMinimum.statement_close == close).scalar())
    return sr.AppStatementView(
        close=close, window_start=cycle["window_start"].date(), due=cycle["due"].date(),
        minimum_due=Decimal(minimum) if minimum is not None else None)


def app_close(card: Account, stated: date, today: date) -> date:
    """The card's close that a statement closing on ``stated`` is compared with.

    - ``stated`` on or after ``today``: 422, the statement has not closed.
    - ``stated`` a close of the card: that close, 422 unless it is before ``today``.
    - Otherwise the card's nearest close either side (the earlier on a tie), when it
      is at most ``NEAR_CLOSE_DAYS`` away: the diff then reports the close mismatch
      and an apply is refused until the card's closing day changes. Farther: 422.
    """
    not_closed = HTTPException(status_code=422, detail="Not a closed statement of this card")
    if stated >= today:
        raise not_closed
    following = statement_close(card, stated)
    if following == stated:
        return stated
    # One close a month: the one before ``following`` is in the month before it.
    previous = statement_close(
        card, (following.replace(day=1) - timedelta(days=1)).replace(day=1))
    nearest = min((previous, following), key=lambda close: (abs((close - stated).days), close))
    if abs((nearest - stated).days) > NEAR_CLOSE_DAYS:
        raise not_closed
    return nearest


def _bounds(card: Account, view: sr.AppStatementView) -> Tuple[date, date]:
    """``(after, through)``: the window of the statements either side of ``view``'s."""
    before = next(iter_cycles_from(card, view.window_start, datetime.min,
                                   through=view.window_start, due_overrides={}))
    following = statement_close(card, view.close + timedelta(days=1))
    return before["window_start"].date(), following


def _kind(line) -> str:
    return "credit" if line.transaction_type == TransactionType.CREDIT else "charge"


def load(db: Session, user: User, card: Account, statement: BankStatement, fx) -> Loaded:
    """The card's rows for ``statement`` (see the module docstring)."""
    view = statement_view(db, card, statement)
    after, through = _bounds(card, view)
    viewable = viewable_account_ids(db, user)
    by_card, unbilled = _card_rows(db, [card.id], viewable)
    lines, payments = _split_card_rows(card.id, by_card.get(card.id, []), unbilled,
                                       keep_source=True, payment_sources=True,
                                       currency=card.currency, fx=fx)
    kept, amount_of, _, _ = normalise_lines(db, card, lines, fx)
    today = manila_today()
    out = Loaded(view, [], [], [])
    for line in kept:
        txn = getattr(line, "source", line)
        posted = bool(getattr(line, "is_posted", True))
        own = line.transaction_date.date()
        record = sr.RowRecord(
            id=txn.id, kind=_kind(line), amount=amount_of(line), transaction_date=own,
            posting_date=manila_day(txn.posting_date) if txn.posting_date else None,
            is_posted=posted, updated_at=txn.updated_at, budget_entry_id=txn.budget_entry_id)
        if posted:
            placed = statement_day(line, today)
            if view.window_start < placed <= view.close:
                out.cycle.append(record)
            elif after < placed <= through:
                out.candidates.append(record)
            else:
                continue
        elif own <= through:
            out.candidates.append(record)
        else:
            continue
        out.rows[txn.id] = txn
    for when, received, _, row in payments:
        day = when.date()
        if after < day <= through:
            out.payments.append(sr.RowRecord(
                id=row.id, kind="payment", amount=received, transaction_date=day,
                posting_date=None, is_posted=bool(row.is_posted), updated_at=row.updated_at))
    return out


def diff(loaded: Loaded, statement: BankStatement) -> sr.StatementDiff:
    """``diff_statement`` over ``loaded`` (read through the module, so one patch reaches
    every caller)."""
    return sr.diff_statement(statement, loaded.view, loaded.cycle, loaded.candidates,
                             loaded.payments)


# --- apply --------------------------------------------------------------------------------

def _refused(message: str, *, status: int = 409, **extra) -> HTTPException:
    return HTTPException(status_code=status, detail={"message": message, **extra})


def _midnight(day: Optional[date]) -> Optional[datetime]:
    return datetime.combine(day, time()) if day is not None else None


def _lock(db: Session, user: User, card: Account, loaded: Loaded) -> Account:
    """Take the apply's locks in ``core/locking.py`` order; the card, refreshed."""
    ids = sorted(loaded.rows)
    owners = {user.id} | {owner for (owner,) in db.query(Transaction.user_id)
                          .filter(Transaction.id.in_(ids))} if ids else {user.id}
    for owner in sorted(owners):
        locking.lock_owner_budgets(db, owner)
    accounts = {card.id}
    for txn_id in ids:
        txn = locking.lock_transaction(db, txn_id)
        if txn is not None:
            accounts |= {txn.account_id, txn.transfer_from_account_id, txn.transfer_to_account_id}
    locked = locking.lock_accounts(db, accounts)
    card = locked.get(card.id)
    # The caller's grants read afresh: they may have changed while this waited.
    if card is None or role_map(db, user).get(card.id, NONE) not in MANAGE_ROLES:
        raise HTTPException(status_code=404, detail="Account not found")
    if card.account_type != AccountType.CREDIT:
        raise HTTPException(status_code=400, detail="Only a credit card has available credit")
    return card


def _row_update(txn: Transaction, action: sr.Action, line: StatementLine) -> dict:
    """The ``TransactionUpdate`` fields of an ``update``, ``move`` or ``unpost``."""
    if action.kind == "unpost":
        if txn.budget_entry_id is not None:
            raise _refused(LINKED_UNPOST.format(row=txn.id), row_id=txn.id)
        return {"is_posted": False}
    fields: dict = {}
    transfer = txn.transaction_type == TransactionType.TRANSFER
    fee = Decimal(str(txn.transfer_fee or 0)) if transfer else Decimal("0")
    for change in action.changes:
        if change.field == "amount":
            amount = change.after - fee
            if amount < 0:
                raise _refused(f"Row {txn.id}: the statement's amount is less than its fee",
                               row_id=txn.id, line_no=action.line_no)
            fields["amount"] = float(amount)
        elif change.field == "transaction_date":
            if txn.budget_entry_id is not None:  # the diff never does this; kept as a guard
                raise _refused(f"Row {txn.id} is linked to a recurring entry: its date is kept",
                               row_id=txn.id)
            fields["transaction_date"] = _midnight(change.after)
        elif change.field == "posting_date":
            fields["posting_date"] = _midnight(change.after)
        elif change.field == "is_posted":
            fields["is_posted"] = change.after
    if fields.get("is_posted") and not transfer and "amount" not in fields:
        # Posting a pending row whose face is foreign needs the actual figure: the line's.
        fields["amount"] = float(line.amount)
    return fields


def _original(line: StatementLine, card: Account, notes: List[str]) -> dict:
    """The FX metadata a create keeps from the line, as a posted foreign create stores
    it: the face in ``original_*`` and the rate between them."""
    from app.routers.transactions import exchange_rate

    if line.original_currency is None:
        return {}
    known = {c.value for c in CurrencyType}
    if line.original_currency not in known:
        notes.append(f"line {line.line_no}: original currency {line.original_currency} is "
                     "not one the app records, so only the card amount was kept")
        return {}
    if line.original_currency == getattr(card.currency, "value", card.currency):
        return {}
    return {"original_amount": float(line.original_amount),
            "original_currency": line.original_currency,
            "exchange_rate": float(exchange_rate(line.amount, line.original_amount))}


@dataclass
class Applied:
    diff: sr.StatementDiff
    created: Dict[int, int]  # line_no -> new row id
    notes: List[str]
    reconciliation: StatementReconciliation


def apply(db: Session, user: User, card: Account, statement: BankStatement,
          fingerprint: str, fx) -> Applied:
    """Apply ``statement`` to ``card`` (see the module docstring). Uncommitted: the
    caller commits. Every refusal rolls the session back before it is raised."""
    from app.routers.transactions import add_transaction, apply_transaction_update
    from app.schemas.transaction import TransactionCreate, TransactionUpdate

    try:
        first = load(db, user, card, statement, fx)
        card = _lock(db, user, card, first)
        db.expire_all()  # every row read again, as the locks leave it
        loaded = load(db, user, card, statement, fx)
        result = diff(loaded, statement)
        if set(loaded.rows) - set(first.rows):
            raise _refused("The card's rows changed while this ran; run the dry run again")
        if statement.header.close_date != loaded.view.close:
            raise _refused(CLOSING_DAY.format(statement=statement.header.close_date.isoformat(),
                                              app=loaded.view.close.isoformat()), status=422)
        if result.fingerprint != fingerprint:
            raise _refused("The statement or the card's rows changed since the dry run; "
                           "run the dry run again")
        if not result.balanced:
            raise _refused("The actions would not make this statement equal the bank's; "
                           "nothing was applied")

        close = loaded.view.close
        for header in result.header:
            try:
                if header.field == "due":
                    store_due_override(db, card, close, header.statement, user.id)
                elif header.field == "minimum_due":
                    store_minimum(db, card, close, header.statement, user.id)
            except HTTPException as exc:
                raise _refused(f"The statement's {header.field} was refused: {exc.detail}",
                               field=header.field)

        lines = {line.line_no: line for line in statement.lines}
        unposted: List[int] = []
        for action in sorted((a for a in result.actions
                              if a.kind in ("update", "move", "unpost")),
                             key=lambda a: a.row_id):
            txn = loaded.rows[action.row_id]
            line = lines.get(action.line_no)
            try:
                fields = _row_update(txn, action, line)
                apply_transaction_update(db, user, txn, TransactionUpdate(**fields))
            except HTTPException as exc:
                if isinstance(exc.detail, dict):
                    raise
                raise _refused(f"Row {txn.id} ({action.kind}) was refused: {exc.detail}",
                               row_id=txn.id, line_no=action.line_no, reason=exc.detail)
            except ValidationError as exc:
                raise _refused(f"Row {txn.id} ({action.kind}) was refused: {exc.errors()}",
                               row_id=txn.id, line_no=action.line_no)
            if action.kind == "unpost":
                unposted.append(txn.id)

        created: Dict[int, int] = {}
        notes: List[str] = []
        for action in sorted((a for a in result.actions if a.kind == "create"),
                             key=lambda a: a.line_no):
            new, line = action.new_row, lines[action.line_no]
            if action.possible_duplicate_of is not None:
                notes.append(f"line {action.line_no}: may duplicate recurring row "
                             f"{action.possible_duplicate_of}, whose date keeps it off this "
                             "statement")
            try:
                txn = add_transaction(db, user, TransactionCreate(
                    account_id=card.id,
                    transaction_type=(TransactionType.CREDIT if new.kind == "credit"
                                      else TransactionType.DEBIT),
                    amount=float(new.amount),
                    currency=card.currency,
                    transaction_date=_midnight(new.transaction_date),
                    posting_date=_midnight(new.posting_date),
                    is_posted=True,
                    description=new.description,
                    **_original(line, card, notes),
                ))
                db.flush()
            except HTTPException as exc:
                raise _refused(f"Line {action.line_no} (create) was refused: {exc.detail}",
                               line_no=action.line_no, reason=exc.detail)
            except ValidationError as exc:
                raise _refused(f"Line {action.line_no} (create) was refused: {exc.errors()}",
                               line_no=action.line_no)
            created[action.line_no] = txn.id

        db.flush()
        db.expire_all()  # verify reads the rows as stored, not as the writes left them
        on_statement = verify(db, user, card, close, statement.line_balance, fx)
        for txn in on_statement:
            txn.is_reconciled = True
        for txn_id in unposted:
            db.get(Transaction, txn_id).is_reconciled = False
        reconciliation = _record(db, user, card, close, statement)
        return Applied(result, created, notes, reconciliation)
    except BaseException:
        db.rollback()
        raise


def verify(db: Session, user: User, card: Account, close: date, expected: Decimal,
           fx) -> List[Transaction]:
    """The rows on the statement closing on ``close``, after checking its line balance
    equals ``expected`` by the stored statements and by a replay of its window; a 409
    with the gap otherwise. Reads the flushed, uncommitted rows."""
    viewable = viewable_account_ids(db, user)
    midnight = manila_midnight()
    summaries = statement_summaries(db, card, midnight, viewable, fx=fx)
    stored = next((s["balance"] for s in summaries if s["close"].date() == close),
                  Decimal("0"))
    found = statement_lines(db, card, close, midnight, viewable, fx=fx)
    replay = sum((Decimal(str(line["amount"])) for line in found["lines"]), Decimal("0"))
    for figure in (stored, replay):
        if figure != expected:
            raise _refused("After the actions the app's statement does not equal the bank's; "
                           "nothing was applied", app_line_balance=str(figure),
                           statement_line_balance=str(expected), gap=str(figure - expected))
    return [line["transaction"] for line in found["lines"]]


def _record(db: Session, user: User, card: Account, close: date,
            statement: BankStatement) -> StatementReconciliation:
    values = {"card_id": card.id, "statement_close": close,
              "total_due": statement.header.total_due,
              "line_balance": statement.line_balance,
              "line_count": sum(1 for line in statement.lines if line.kind != "payment"),
              "reconciled_by_actor": user.id}
    upsert = pg_insert(StatementReconciliation).values(**values)
    db.execute(upsert.on_conflict_do_update(
        constraint="uq_statement_reconciliations_card_close",
        set_={**{key: upsert.excluded[key] for key in values
                 if key not in ("card_id", "statement_close")},
              "reconciled_at": func.now()}))
    db.flush()
    return (db.query(StatementReconciliation)
            .filter(StatementReconciliation.card_id == card.id,
                    StatementReconciliation.statement_close == close)
            .populate_existing().one())


def reconciled_closes(db: Session, card_id: int) -> Dict[date, datetime]:
    """``{statement close: reconciled_at}`` for the card's reconciled statements."""
    return {close: at for close, at in db.query(
        StatementReconciliation.statement_close, StatementReconciliation.reconciled_at)
        .filter(StatementReconciliation.card_id == card_id)}


def as_out(result: sr.StatementDiff, *, dry_run: bool, created: Optional[Dict[int, int]] = None,
           notes: Sequence[str] = (), reconciliation: Optional[StatementReconciliation] = None
           ) -> dict:
    """The ``ReconcileOut`` body."""
    created = created or {}
    body = {
        "dry_run": dry_run,
        "fingerprint": result.fingerprint,
        "balanced": result.balanced,
        "header": [{"field": h.field, "statement": h.statement, "app": h.app}
                   for h in result.header],
        "actions": [{
            "kind": a.kind, "line_no": a.line_no, "row_id": a.row_id,
            "changes": [{"field": c.field, "before": c.before, "after": c.after}
                        for c in a.changes],
            "new_row": None if a.new_row is None else {
                "kind": a.new_row.kind, "amount": a.new_row.amount,
                "transaction_date": a.new_row.transaction_date,
                "posting_date": a.new_row.posting_date,
                "description": a.new_row.description},
            "possible_duplicate_of": a.possible_duplicate_of,
            "created_row_id": created.get(a.line_no) if a.kind == "create" else None,
        } for a in result.actions],
        "warnings": [{"line_no": w.line_no, "reason": w.reason} for w in result.warnings],
        "notes": list(notes),
        "reconciliation": None,
    }
    if reconciliation is not None:
        body["reconciliation"] = {
            "close_date": reconciliation.statement_close,
            "total_due": reconciliation.total_due,
            "line_balance": reconciliation.line_balance,
            "line_count": reconciliation.line_count,
            "reconciled_at": reconciliation.reconciled_at,
            "reconciled_by_actor": reconciliation.reconciled_by_actor,
        }
    return body
