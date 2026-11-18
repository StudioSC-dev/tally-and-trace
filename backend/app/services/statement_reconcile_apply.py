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
  to a recurring entry is also unlinked from it, as ``unpost_plan`` decides
  (STU-761): the latest recorded payment of a capped installment is given back
  (``_give_back``: one more payment left, ``next_occurrence`` back on its
  occurrence, a completed installment active again, auto-post off); a row of any
  other recurring entry but a transfer is unlinked with its schedule untouched;
  any other installment row, and a recurring transfer's, is refused. The entries
  those rows are linked to are locked after the budget locks and before the rows
  (``core/locking.py``), and the fingerprint covers what each such unpost does.

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

A savings, checking or e-wallet statement (STU-753)
---------------------------------------------------
``POST /accounts/{account_id}/statements/reconcile`` (``routers/accounts.py``) runs
the same apply (``_apply`` with ``ACCOUNT``) over the account's rows; what differs:

- Which statement: the period the header gives, ``period_start`` through
  ``period_end``; it must have ended (before Manila's today). Only a savings,
  checking, e-wallet or cash account (400 otherwise; a card's names the card route).
- Rows (``load_account``): every row touching the account, whoever entered them
  (as ``GET /accounts/{id}/balance`` reads them), each by its effect on this
  account (``account_side``): a debit or credit on it by its amount; a transfer out
  of it a ``debit`` of ``amount + transfer_fee`` and a transfer into it a
  ``credit`` of ``received_amount`` (else ``amount``), as ``transfer_sides``
  gives them. A pending debit or credit with a foreign face is put in the
  account's currency as a card's is (``statements.normalise_lines``). A posted row
  is placed by its own ``transaction_date``: cycle rows are the posted rows in the
  period; candidates the posted rows in the period of the same length either side
  and the unposted rows dated on or before the end of the one after.
- A transfer is one row on both accounts' statements. It is matched like any row
  and keeps its dates (``RowRecord.keeps_dates``); any write to it (its amount,
  posting or unposting it) is refused (``TRANSFER_CHANGE``), since it would change
  the other account too, and so is a ``create`` whose possible duplicate is a
  transfer (``TRANSFER_DUPLICATE``): the line is most likely that transfer, dated
  off the period. A transfer out of the account carries its fee (``RowRecord.fee``),
  so a posted one may be matched to an amount line and a fee line (the fee pairing,
  ``statement_reconcile``), which writes nothing. A row linked to a recurring entry is
  refused unposting (``LINKED_UNPOST``): the un-record a card's unpost does is not done
  here.
- No header writes.
- Verify (``verify_account``): after the writes, the posted rows in the period
  must add up to the statement's change (``opening_balance`` plus them is the
  ``closing_balance``), and the account's balance at the end of ``period_end``
  (``balance_at``: its stored balance less every posted row dated after) must
  equal the ``closing_balance``. Otherwise the apply is rolled back and the gap
  returned (409).
- On success the period's posted rows are marked ``is_reconciled`` (an unposted
  row is cleared) and ``account_statement_reconciliations`` gets one row per
  account and ``period_end``.
"""
from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass, field, replace
from datetime import date, datetime, time, timedelta
from decimal import Decimal
from typing import Dict, List, Optional, Sequence, Tuple

from fastapi import HTTPException
from pydantic import ValidationError
from sqlalchemy import or_
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.orm import Session
from sqlalchemy.sql import func

from app.core import locking
from app.core.access import (
    MANAGE_ROLES, NONE, get_account_or_404, role_map, viewable_account_ids,
)
from app.core.time import manila_day, manila_midnight, manila_today, utc_now
from app.models.account import Account, AccountType
from app.models.budget_entry import BudgetEntry
from app.models.card_statement_due_override import CardStatementDueOverride
from app.models.card_statement_minimum import CardStatementMinimum
from app.models.statement_reconciliation import (
    AccountStatementReconciliation, StatementReconciliation,
)
from app.models.transaction import Transaction, TransactionType, transfer_sides
from app.models.user import CurrencyType, User
from app.schemas.statement_reconcile import AccountStatement, BankStatement, StatementLine
from app.services import statement_reconcile as sr
from app.services.recurring_kinds import is_capped
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
ACCOUNT_TYPES = (AccountType.SAVINGS, AccountType.CHECKING, AccountType.E_WALLET,
                 AccountType.CASH)
CARD_ROUTE = ("This is a credit card: reconcile its statement with "
              "POST /cards/{account}/statements/reconcile")
NOT_A_BANK_ACCOUNT = ("Only a savings, checking, e-wallet or cash account's statement is "
                      "reconciled here")
TRANSFER_CHANGE = ("Row {row} is a transfer between accounts {source} and {destination}: "
                   "changing it here would change both; edit the transfer and run the dry "
                   "run again")
TRANSFER_DUPLICATE = ("Line {line} may be transfer row {row}, whose date keeps it off this "
                      "period; change the transfer's date and run the dry run again")
LINKED_UNPOST = ("Row {row} is linked to a recurring entry: unposting it here would leave "
                 "the entry's paid count and schedule as they are")
NOT_LATEST = ("Row {row} is a payment of installment {entry} but not its latest one: only "
              "the latest payment can be given back here; handle this row by hand and run "
              "the dry run again")
LINKED_BY_HAND = ("Row {row} was linked to installment {entry} by hand, not recorded as one "
                  "of its payments: handle this row by hand and run the dry run again")
# What unposting a row linked to a recurring entry does on a card (STU-761).
UNRECORD, UNLINK, REFUSE = "unrecord", "unlink", "refuse"


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
    # The recurring entries those rows are linked to, by id (a card's only).
    entries: Dict[int, "LinkedEntry"] = field(default_factory=dict)


@dataclass
class LinkedEntry:
    """A recurring entry linked to a row read, and the ids of its linked rows on its
    latest linked day (``coalesce(occurrence_date, transaction_date)``, the day
    ``forecast.linked_transactions`` gives a row; the entry owner's rows)."""
    entry: BudgetEntry
    latest: Tuple[int, ...]


def linked_entries(db: Session, rows: Dict[int, Transaction]) -> Dict[int, LinkedEntry]:
    """``LinkedEntry`` for every entry a row in ``rows`` is linked to."""
    ids = sorted({t.budget_entry_id for t in rows.values() if t.budget_entry_id is not None})
    out: Dict[int, LinkedEntry] = {}
    if not ids:
        return out
    for entry in db.query(BudgetEntry).filter(BudgetEntry.id.in_(ids)).order_by(BudgetEntry.id):
        days = [(txn_id, day.date()) for txn_id, day in db.query(
            Transaction.id, func.coalesce(Transaction.occurrence_date, Transaction.transaction_date))
            .filter(Transaction.budget_entry_id == entry.id,
                    Transaction.user_id == entry.user_id)]
        last = max((day for _, day in days), default=None)
        out[entry.id] = LinkedEntry(entry, tuple(sorted(i for i, day in days if day == last)))
    return out


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
    out.entries = linked_entries(db, out.rows)
    return out


def diff(loaded: Loaded, statement: BankStatement) -> sr.StatementDiff:
    """``diff_statement`` over ``loaded`` (read through the module, so one patch reaches
    every caller). When an ``unpost`` names a row linked to a recurring entry, the
    fingerprint also covers what that unpost does (``unpost_plan``) and the entry's
    figures it changes, so an apply refuses when either changed since the dry run."""
    result = sr.diff_statement(statement, loaded.view, loaded.cycle, loaded.candidates,
                               loaded.payments)
    covered = []
    for txn in _linked_unposts(loaded, result):
        linked = loaded.entries.get(txn.budget_entry_id)
        covered.append([txn.id, txn.budget_entry_id, unpost_plan(loaded, txn)[0]] + (
            [] if linked is None else [
                linked.entry.max_occurrences, bool(linked.entry.is_active),
                bool(linked.entry.auto_post_enabled),
                sr._canon(linked.entry.next_occurrence), sr._canon(linked.entry.updated_at)]))
    if not covered:
        return result
    body = json.dumps({"diff": result.fingerprint, "linked_unposts": covered},
                      sort_keys=True, separators=(",", ":"))
    return replace(result, fingerprint=hashlib.sha256(body.encode("utf-8")).hexdigest())


def _linked_unposts(loaded: Loaded, result: sr.StatementDiff) -> List[Transaction]:
    """The rows ``result`` unposts that are linked to a recurring entry, by id."""
    return [loaded.rows[a.row_id] for a in sorted(
        (a for a in result.actions if a.kind == "unpost"), key=lambda a: a.row_id)
        if loaded.rows[a.row_id].budget_entry_id is not None]


def unpost_plan(loaded: Loaded, txn: Transaction) -> Tuple[str, Optional[str]]:
    """What unposting ``txn``, a row linked to a recurring entry, does on a card
    (STU-761): ``(UNRECORD | UNLINK | REFUSE, the refusal's reason or None)``.

    - A capped installment (``recurring_kinds.is_capped``), when ``txn`` was recorded
      as one of its payments (``occurrence_date`` set) and is the only linked row on
      its latest linked day: ``UNRECORD``, the payment is given back (``_give_back``).
    - Any other row of a capped installment: refused (``LINKED_BY_HAND``,
      ``NOT_LATEST``).
    - A recurring transfer, capped or not: refused (``LINKED_UNPOST``).
    - Any other recurring entry: ``UNLINK``, its schedule untouched.
    """
    linked = loaded.entries.get(txn.budget_entry_id)
    if linked is None or linked.entry.transfer_to_account_id is not None:
        return REFUSE, LINKED_UNPOST.format(row=txn.id)
    entry = linked.entry
    if not is_capped(entry):
        return UNLINK, None
    if txn.occurrence_date is None:
        return REFUSE, LINKED_BY_HAND.format(row=txn.id, entry=entry.id)
    if linked.latest != (txn.id,):
        return REFUSE, NOT_LATEST.format(row=txn.id, entry=entry.id)
    return UNRECORD, None


def unpost_note(loaded: Loaded, txn: Transaction) -> str:
    """What unposting ``txn`` (linked to a recurring entry) does, read before it is
    done: a note in the dry run's and the apply's answer. No amount."""
    outcome, reason = unpost_plan(loaded, txn)
    if outcome == REFUSE:
        return f"row {txn.id}: unposting it is refused: {reason}"
    entry = loaded.entries[txn.budget_entry_id].entry
    if outcome == UNLINK:
        return (f"row {txn.id}: unposted and unlinked from recurring entry {entry.id}; "
                "its schedule is unchanged")
    day = txn.occurrence_date.date().isoformat()
    text = (f"row {txn.id}: unposted and unlinked from installment {entry.id}; its payment "
            f"due {day} is given back ({entry.max_occurrences + 1} left, the next due {day})")
    if not entry.is_active and entry.max_occurrences == 0:
        text += "; the completed installment is active again"
    if entry.auto_post_enabled:
        text += "; auto-post is turned off"
    return text


def unpost_notes(loaded: Loaded, result: sr.StatementDiff) -> List[str]:
    """A dry run's notes: what each unpost of a row linked to a recurring entry does
    (``unpost_note``). Writes nothing."""
    return [unpost_note(loaded, txn) for txn in _linked_unposts(loaded, result)]


# --- apply --------------------------------------------------------------------------------

def _refused(message: str, *, status: int = 409, **extra) -> HTTPException:
    return HTTPException(status_code=status, detail={"message": message, **extra})


def _midnight(day: Optional[date]) -> Optional[datetime]:
    return datetime.combine(day, time()) if day is not None else None


def _lock(db: Session, user: User, account: Account, loaded: Loaded, kind: "_Kind") -> Account:
    """Take the apply's locks in ``core/locking.py`` order; the account, refreshed."""
    ids = sorted(loaded.rows)
    owners = {user.id} | {owner for (owner,) in db.query(Transaction.user_id)
                          .filter(Transaction.id.in_(ids))} if ids else {user.id}
    owners |= {linked.entry.user_id for linked in loaded.entries.values()}
    for owner in sorted(owners):
        locking.lock_owner_budgets(db, owner)
    for entry_id in sorted(loaded.entries):
        locking.lock_entry(db, entry_id)
    accounts = {account.id}
    for txn_id in ids:
        txn = locking.lock_transaction(db, txn_id)
        if txn is not None:
            accounts |= {txn.account_id, txn.transfer_from_account_id, txn.transfer_to_account_id}
    locked = locking.lock_accounts(db, accounts)
    account = locked.get(account.id)
    # The caller's grants read afresh: they may have changed while this waited.
    if account is None or role_map(db, user).get(account.id, NONE) not in MANAGE_ROLES:
        raise HTTPException(status_code=404, detail="Account not found")
    kind.check_account(account)
    return account


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
    reconciliation: object


class _Kind:
    """What reconciling one kind of account needs; the apply itself (``_apply``) is
    shared. ``_Card`` is a credit card's statement."""
    noun = "account"

    def load(self, db: Session, user: User, account: Account, statement, fx) -> Loaded:
        raise NotImplementedError

    def diff(self, loaded: Loaded, statement) -> sr.StatementDiff:
        raise NotImplementedError

    def check_account(self, account: Account) -> None:
        """Refuse an account of the wrong type (after the locks)."""

    def check_view(self, loaded: Loaded, statement) -> None:
        """Refuse a statement the app places elsewhere (before the fingerprint)."""

    def write_header(self, db: Session, user: User, account: Account, loaded: Loaded,
                     result: sr.StatementDiff) -> None:
        """Store the header values the statement differs on."""

    def check_row(self, txn: Transaction, action: sr.Action) -> None:
        """Refuse an ``update``, ``move`` or ``unpost`` of ``txn`` beyond ``_row_update``'s."""

    def check_create(self, action: sr.Action, loaded: Loaded) -> None:
        """Refuse a ``create``."""

    def unpost_linked(self, db: Session, loaded: Loaded, txn: Transaction) -> dict:
        """The ``TransactionUpdate`` fields that unpost ``txn``, a row linked to a
        recurring entry, after any write to the entry; refused by default."""
        raise _refused(LINKED_UNPOST.format(row=txn.id), row_id=txn.id)

    def verify(self, db: Session, user: User, account: Account, loaded: Loaded, statement,
               fx) -> List[Transaction]:
        raise NotImplementedError

    def record(self, db: Session, user: User, account: Account, loaded: Loaded, statement):
        raise NotImplementedError


class _Card(_Kind):
    noun = "card"

    def load(self, db, user, account, statement, fx):
        return load(db, user, account, statement, fx)

    def diff(self, loaded, statement):
        return diff(loaded, statement)

    def check_account(self, account):
        if account.account_type != AccountType.CREDIT:
            raise HTTPException(status_code=400, detail="Only a credit card has available credit")

    def check_view(self, loaded, statement):
        if statement.header.close_date != loaded.view.close:
            raise _refused(CLOSING_DAY.format(statement=statement.header.close_date.isoformat(),
                                              app=loaded.view.close.isoformat()), status=422)

    def write_header(self, db, user, account, loaded, result):
        close = loaded.view.close
        for header in result.header:
            try:
                if header.field == "due":
                    store_due_override(db, account, close, header.statement, user.id)
                elif header.field == "minimum_due":
                    store_minimum(db, account, close, header.statement, user.id)
            except HTTPException as exc:
                raise _refused(f"The statement's {header.field} was refused: {exc.detail}",
                               field=header.field)

    def unpost_linked(self, db, loaded, txn):
        outcome, reason = unpost_plan(loaded, txn)
        if outcome == REFUSE:
            raise _refused(reason, row_id=txn.id)
        if outcome == UNRECORD:
            _give_back(loaded.entries[txn.budget_entry_id].entry, txn)
        return {"is_posted": False, "budget_entry_id": None}

    def verify(self, db, user, account, loaded, statement, fx):
        return verify(db, user, account, loaded.view.close, statement.line_balance, fx)

    def record(self, db, user, account, loaded, statement):
        return _record(db, user, account, loaded.view.close, statement)


CARD = _Card()


def _give_back(entry: BudgetEntry, txn: Transaction) -> None:
    """Un-record the installment payment ``txn`` stands for (STU-761), the one path
    that moves a schedule back past a recorded payment: ``max_occurrences`` (the
    payments left) gains the one ``posting._advance`` used up, ``next_occurrence``
    returns to that occurrence, a completed installment is active again, and
    auto-post is turned off as a schedule edit moving the next date earlier turns
    it off (``routers/budget_entries.py``), so the next run does not post the
    occurrence again. The caller holds the entry's lock; ``txn`` is then unlinked."""
    if not entry.is_active and entry.max_occurrences == 0:
        entry.is_active = True
    entry.max_occurrences += 1
    entry.next_occurrence = txn.occurrence_date
    entry.installment_reviewed_at = None
    entry.auto_post_enabled = False
    entry.updated_at = utc_now()


def apply(db: Session, user: User, card: Account, statement: BankStatement,
          fingerprint: str, fx) -> Applied:
    """Apply ``statement`` to ``card`` (see the module docstring). Uncommitted: the
    caller commits. Every refusal rolls the session back before it is raised."""
    return _apply(CARD, db, user, card, statement, fingerprint, fx)


def _apply(kind: _Kind, db: Session, user: User, account: Account, statement,
           fingerprint: str, fx) -> Applied:
    from app.routers.transactions import add_transaction, apply_transaction_update
    from app.schemas.transaction import TransactionCreate, TransactionUpdate

    try:
        first = kind.load(db, user, account, statement, fx)
        account = _lock(db, user, account, first, kind)
        db.expire_all()  # every row read again, as the locks leave it
        loaded = kind.load(db, user, account, statement, fx)
        result = kind.diff(loaded, statement)
        if set(loaded.rows) - set(first.rows) or set(loaded.entries) - set(first.entries):
            raise _refused(f"The {kind.noun}'s rows changed while this ran; "
                           "run the dry run again")
        kind.check_view(loaded, statement)
        if result.fingerprint != fingerprint:
            raise _refused(f"The statement or the {kind.noun}'s rows changed since the dry run; "
                           "run the dry run again")
        if not result.balanced:
            raise _refused("The actions would not make this statement equal the bank's; "
                           "nothing was applied")

        kind.write_header(db, user, account, loaded, result)

        lines = {line.line_no: line for line in statement.lines}
        unposted: List[int] = []
        notes: List[str] = []
        for action in sorted((a for a in result.actions
                              if a.kind in ("update", "move", "unpost")),
                             key=lambda a: a.row_id):
            txn = loaded.rows[action.row_id]
            line = lines.get(action.line_no)
            try:
                kind.check_row(txn, action)
                if action.kind == "unpost" and txn.budget_entry_id is not None:
                    note = unpost_note(loaded, txn)
                    fields = kind.unpost_linked(db, loaded, txn)
                    notes.append(note)
                else:
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
        for action in sorted((a for a in result.actions if a.kind == "create"),
                             key=lambda a: a.line_no):
            new, line = action.new_row, lines[action.line_no]
            kind.check_create(action, loaded)
            if action.possible_duplicate_of is not None:
                notes.append(f"line {action.line_no}: may duplicate recurring row "
                             f"{action.possible_duplicate_of}, whose date keeps it off this "
                             "statement")
            try:
                txn = add_transaction(db, user, TransactionCreate(
                    account_id=account.id,
                    transaction_type=(TransactionType.CREDIT if new.kind == "credit"
                                      else TransactionType.DEBIT),
                    amount=float(new.amount),
                    currency=account.currency,
                    transaction_date=_midnight(new.transaction_date),
                    posting_date=_midnight(new.posting_date),
                    is_posted=True,
                    description=new.description,
                    **_original(line, account, notes),
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
        on_statement = kind.verify(db, user, account, loaded, statement, fx)
        for txn in on_statement:
            txn.is_reconciled = True
        for txn_id in unposted:
            db.get(Transaction, txn_id).is_reconciled = False
        reconciliation = kind.record(db, user, account, loaded, statement)
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


# --- a savings, checking or e-wallet statement (STU-753) ---------------------------------

def check_bank_account(account: Account) -> None:
    """400 unless ``account`` is a savings, checking, e-wallet or cash account; a
    card's refusal names the card route."""
    if account.account_type == AccountType.CREDIT:
        raise HTTPException(status_code=400, detail=CARD_ROUTE.format(account=account.id))
    if account.account_type not in ACCOUNT_TYPES:
        raise HTTPException(status_code=400, detail=NOT_A_BANK_ACCOUNT)


def account_view(statement: AccountStatement) -> sr.AppStatementView:
    """The statement's period as the diff reads it; 422 unless it has ended."""
    header = statement.header
    if header.period_end >= manila_today():
        raise HTTPException(status_code=422, detail="This statement's period has not ended")
    return sr.AppStatementView(close=header.period_end,
                               window_start=header.period_start - timedelta(days=1),
                               placement="transaction_date")


def _touching(account_id: int):
    """Every row that can move the account, as ``GET /accounts/{id}/balance`` reads them."""
    return or_(Transaction.account_id == account_id,
               Transaction.transfer_from_account_id == account_id,
               Transaction.transfer_to_account_id == account_id)


def account_side(txn: Transaction, account_id: int) -> Optional[Tuple[str, Decimal]]:
    """``(kind, amount)``: the row's effect on the account, a ``debit`` (money out) or
    a ``credit`` (money in) by its stored figure; None when it does not move it. The
    rule of ``GET /accounts/{id}/balance``: a transfer by its own side
    (``transfer_sides``), any other row by its ``account_id``."""
    if txn.transaction_type == TransactionType.TRANSFER:
        out, received = transfer_sides(txn)
        if txn.transfer_from_account_id == account_id:
            return "debit", out
        if txn.transfer_to_account_id == account_id:
            return "credit", received
        return None
    if txn.account_id != account_id:
        return None
    amount = Decimal(str(txn.amount))
    return ("credit", amount) if txn.transaction_type == TransactionType.CREDIT else ("debit", amount)


def _effect(txn: Transaction, account_id: int) -> Decimal:
    side = account_side(txn, account_id)
    if side is None:
        return Decimal("0")
    return side[1] if side[0] == "credit" else -side[1]


def load_account(db: Session, user: User, account: Account, statement: AccountStatement,
                 fx) -> Loaded:
    """The account's rows for ``statement`` (see the module docstring)."""
    view = account_view(statement)
    span = view.close - view.window_start
    after, through = view.window_start - span, view.close + span
    txns = db.query(Transaction).filter(_touching(account.id)).all()
    plain = [t for t in txns if t.transaction_type != TransactionType.TRANSFER
             and t.account_id == account.id]
    kept, amount_of, _, _ = normalise_lines(db, account, plain, fx)
    kept_ids = {t.id for t in kept}
    out = Loaded(view, [], [], [])
    for txn in txns:
        transfer = txn.transaction_type == TransactionType.TRANSFER
        side = account_side(txn, account.id)
        if side is None or (not transfer and txn.id not in kept_ids):
            continue
        kind, amount = side if transfer else (side[0], amount_of(txn))
        own = txn.transaction_date.date()
        posted = bool(txn.is_posted)
        source = transfer and txn.transfer_from_account_id == account.id
        record = sr.RowRecord(
            id=txn.id, kind=kind, amount=amount, transaction_date=own,
            posting_date=manila_day(txn.posting_date) if txn.posting_date else None,
            is_posted=posted, updated_at=txn.updated_at, budget_entry_id=txn.budget_entry_id,
            keeps_dates=transfer,
            fee=Decimal(str(txn.transfer_fee or 0)) if source else None)
        if posted:
            if view.window_start < own <= view.close:
                out.cycle.append(record)
            elif after < own <= through:
                out.candidates.append(record)
            else:
                continue
        elif own <= through:
            out.candidates.append(record)
        else:
            continue
        out.rows[txn.id] = txn
    return out


def diff_account(loaded: Loaded, statement: AccountStatement) -> sr.StatementDiff:
    """``diff_account_statement`` over ``loaded`` (read through the module)."""
    return sr.diff_account_statement(statement, loaded.view, loaded.cycle, loaded.candidates)


def balance_at(db: Session, account: Account, day: date) -> Decimal:
    """The account's balance at the end of ``day``: its stored balance (what the app
    shows as its balance, kept by every write path) less the effect of every posted
    row dated after ``day``, whoever entered it."""
    later = db.query(Transaction).filter(
        _touching(account.id), Transaction.is_posted.is_(True),
        Transaction.transaction_date >= _midnight(day + timedelta(days=1))).all()
    stored = Decimal(str(account.balance or 0)).quantize(Decimal("0.01"))
    return stored - sum((_effect(t, account.id) for t in later), Decimal("0"))


def verify_account(db: Session, account: Account, statement: AccountStatement
                   ) -> List[Transaction]:
    """The posted rows in the statement's period, after checking they add up to its
    change and that the account's balance at ``period_end`` is its closing balance;
    a 409 with the gap otherwise. Reads the flushed, uncommitted rows."""
    header = statement.header
    rows = db.query(Transaction).filter(
        _touching(account.id), Transaction.is_posted.is_(True),
        Transaction.transaction_date >= _midnight(header.period_start),
        Transaction.transaction_date < _midnight(header.period_end + timedelta(days=1)),
    ).order_by(Transaction.id).all()
    change = sum((_effect(t, account.id) for t in rows), Decimal("0"))
    opening = (header.opening_balance if header.opening_balance is not None
               else header.closing_balance - statement.change)
    if opening + change != header.closing_balance:
        raise _refused("After the actions the app's rows in the period do not equal the "
                       "bank's; nothing was applied", app_change=str(change),
                       statement_change=str(header.closing_balance - opening),
                       gap=str(opening + change - header.closing_balance))
    closing = balance_at(db, account, header.period_end)
    if closing != header.closing_balance:
        raise _refused(f"After the actions the app's balance at the end of "
                       f"{header.period_end.isoformat()} does not equal the statement's "
                       "closing balance; nothing was applied",
                       app_closing_balance=str(closing),
                       statement_closing_balance=str(header.closing_balance),
                       gap=str(closing - header.closing_balance))
    return rows


def _record_account(db: Session, user: User, account: Account,
                    statement: AccountStatement) -> AccountStatementReconciliation:
    header = statement.header
    values = {"account_id": account.id, "period_start": header.period_start,
              "period_end": header.period_end, "opening_balance": header.opening_balance,
              "closing_balance": header.closing_balance, "change": statement.change,
              "line_count": len(statement.lines), "reconciled_by_actor": user.id}
    upsert = pg_insert(AccountStatementReconciliation).values(**values)
    db.execute(upsert.on_conflict_do_update(
        constraint="uq_account_statement_reconciliations_account_end",
        set_={**{key: upsert.excluded[key] for key in values
                 if key not in ("account_id", "period_end")},
              "reconciled_at": func.now()}))
    db.flush()
    return (db.query(AccountStatementReconciliation)
            .filter(AccountStatementReconciliation.account_id == account.id,
                    AccountStatementReconciliation.period_end == header.period_end)
            .populate_existing().one())


class _BankAccount(_Kind):
    noun = "account"

    def load(self, db, user, account, statement, fx):
        return load_account(db, user, account, statement, fx)

    def diff(self, loaded, statement):
        return diff_account(loaded, statement)

    def check_account(self, account):
        check_bank_account(account)

    def check_row(self, txn, action):
        if txn.transaction_type == TransactionType.TRANSFER:
            raise _refused(TRANSFER_CHANGE.format(
                row=txn.id, source=txn.transfer_from_account_id,
                destination=txn.transfer_to_account_id), row_id=txn.id, line_no=action.line_no)

    def check_create(self, action, loaded):
        duplicate = loaded.rows.get(action.possible_duplicate_of)
        if duplicate is not None and duplicate.transaction_type == TransactionType.TRANSFER:
            raise _refused(TRANSFER_DUPLICATE.format(line=action.line_no, row=duplicate.id),
                           line_no=action.line_no, row_id=duplicate.id)

    def verify(self, db, user, account, loaded, statement, fx):
        return verify_account(db, account, statement)

    def record(self, db, user, account, loaded, statement):
        return _record_account(db, user, account, statement)


ACCOUNT = _BankAccount()


def apply_account(db: Session, user: User, account: Account, statement: AccountStatement,
                  fingerprint: str, fx) -> Applied:
    """Apply ``statement`` to a savings, checking or e-wallet ``account`` (see the
    module docstring). Uncommitted: the caller commits. Every refusal rolls the
    session back before it is raised."""
    return _apply(ACCOUNT, db, user, account, statement, fingerprint, fx)


def account_as_out(result: sr.StatementDiff, *, dry_run: bool,
                   created: Optional[Dict[int, int]] = None, notes: Sequence[str] = (),
                   reconciliation: Optional[AccountStatementReconciliation] = None) -> dict:
    """The ``AccountReconcileOut`` body."""
    body = as_out(result, dry_run=dry_run, created=created, notes=notes)
    if reconciliation is not None:
        body["reconciliation"] = {
            "period_start": reconciliation.period_start,
            "period_end": reconciliation.period_end,
            "opening_balance": reconciliation.opening_balance,
            "closing_balance": reconciliation.closing_balance,
            "change": reconciliation.change,
            "line_count": reconciliation.line_count,
            "reconciled_at": reconciliation.reconciled_at,
            "reconciled_by_actor": reconciliation.reconciled_by_actor,
        }
    return body


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
