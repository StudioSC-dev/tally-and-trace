"""Household view scope and Household occurrences (STU-233, plan §3).

**Household view scope** for sharer U (``household_accounts``): U's active
accounts carrying U's Household tag that the caller sees, by ``tag_viewer``
or a direct role. For U themselves (their own Household view) it is their
own Household-tagged active accounts.

**Household occurrences** (``household_occurrences``): U's records carrying
U's Household tag explicitly (read rule (c)), on U's accounts only (or none),
that touch no account of the view scope. A Household bill on U's private card
or wallet is one. They are listed, never cash (``cash_delta`` 0), and each
appears once.

An occurrence on a credit card is de-duplicated against the in-scope CASH
payments into that card: every transfer into it from a projection-cash
account of the view scope (posted, planned or recurring), allocated to its
statements oldest first with every other payment and credit, as
``statements.py`` allocates them. A virtual overflow move is not cash and
never counts. When the card's primary payment account is in the view scope,
its routed statement payment pays whatever the statement still owes, so that
counts as covered too. The in-scope part allocated to a statement covers its
Household lines first, in date order, capped at their total; each line's
remainder is ``max(0, line - its covered part)`` and only a remainder above 0
is returned, as the occurrence's ``face_amount``. Any other occurrence
(a wallet, a bank, a card without cycle settings, a refund, a transfer, or an
accountless entry) is returned at its face amount.

``recorded`` picks the data: posted charges against posted payments (a
recorded month), or every row plus projected entry charges against posted,
planned and recurring payments plus the routed payment (the projection).
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime
from decimal import Decimal
from typing import Dict, Iterable, List, Optional, Tuple

from sqlalchemy.orm import Session

from app.core.access import (
    VIEW_ROLES, HouseholdGrant, account_role, household_explicit_criterion, touches_none,
)
from app.models.account import Account, AccountType
from app.models.budget_entry import BudgetEntry, BudgetEntryType
from app.models.transaction import Transaction, TransactionType
from app.services.statements import iter_cycles_from, resolve_cycle_fields

ZERO = Decimal("0")


def _uid(user) -> Optional[int]:
    return getattr(user, "id", user)


def household_accounts(db: Session, user, grant: HouseholdGrant) -> List[Account]:
    """The Household view scope of ``grant``'s sharer, for the caller (see the module docstring)."""
    if not grant.tagged_ids:
        return []
    accounts = db.query(Account).filter(Account.id.in_(list(grant.tagged_ids)),
                                        Account.is_active.is_(True)).all()
    uid = _uid(user)
    return [a for a in accounts if account_role(uid, a) in VIEW_ROLES]


@dataclass
class Occurrence:
    """One Household occurrence: a record (or one occurrence of a recurring entry)."""

    date: datetime
    record: object
    face: Decimal           # the amount as entered
    remainder: Decimal      # what is left after in-scope payments (returned when > 0)
    extra: dict = field(default_factory=dict)  # overdue / original_date


def _money(value) -> Decimal:
    return Decimal(str(value or 0)).quantize(Decimal("0.01"))


def _naive(dt: datetime) -> datetime:
    return dt.replace(tzinfo=None) if dt.tzinfo else dt


def household_occurrences(db: Session, grant: HouseholdGrant, scope: Iterable[Account],
                          start: datetime, end: datetime, *, recorded: bool) -> List[Occurrence]:
    """The Household occurrences of ``grant``'s sharer in ``[start, end)`` (module docstring).

    ``scope`` is the Household view scope (``household_accounts``). Projected
    (``recorded`` False): unposted transactions dated before ``end`` (one
    dated before ``start`` is listed at ``start``, overdue) and active
    recurring entries' occurrences in the window. Recorded: posted
    transactions dated in the window.
    """
    from app.services.forecast import _card_entry_charges, _linked_occurrence_days, iter_occurrences

    start, end = _naive(start), _naive(end)
    scope = list(scope)
    scope_ids = {a.id for a in scope}
    cash_ids = {a.id for a in scope if a.account_type not in (AccountType.CREDIT, AccountType.LOAN)
                and not a.is_spending_wallet}

    txn_query = db.query(Transaction).filter(
        household_explicit_criterion(Transaction, grant), touches_none(Transaction, scope_ids))
    if recorded:
        txn_query = txn_query.filter(Transaction.is_posted.is_(True),
                                     Transaction.transaction_date >= start,
                                     Transaction.transaction_date < end)
    else:
        txn_query = txn_query.filter(Transaction.is_posted.is_(False),
                                     Transaction.transaction_date < end)
    txns = txn_query.order_by(Transaction.transaction_date, Transaction.id).all()
    entries = [] if recorded else db.query(BudgetEntry).filter(
        household_explicit_criterion(BudgetEntry, grant), touches_none(BudgetEntry, scope_ids),
        BudgetEntry.is_active.is_(True),
    ).order_by(BudgetEntry.id).all()

    cards = {a.id: a for a in db.query(Account).filter(
        Account.id.in_({r.account_id for r in [*txns, *entries] if r.account_id}),
        Account.account_type == AccountType.CREDIT,
    ).all()} if (txns or entries) else {}
    billed = {cid: c for cid, c in cards.items() if resolve_cycle_fields(c) is not None}

    out: List[Occurrence] = []
    card_lines: Dict[int, list] = {}  # card id -> [(occurrence, line key)]
    for txn in txns:
        when = _naive(txn.transaction_date)
        extra = {}
        if not recorded and when < start:
            when, extra = start, {"overdue": True, "original_date": when}
        occ = Occurrence(when, txn, _money(txn.amount), _money(txn.amount), extra)
        out.append(occ)
        if txn.transaction_type == TransactionType.DEBIT and txn.account_id in billed:
            card_lines.setdefault(txn.account_id, []).append((occ, ("t", txn.id)))

    linked = _linked_occurrence_days(db, [e.id for e in entries])
    for entry in entries:
        if entry.account_id in billed and entry.transfer_to_account_id is None:
            charges = _card_entry_charges(db, [entry], billed, start, end, None).get(
                entry.account_id, [])
            for line in charges:
                if line.transaction_date < start:
                    continue  # billed on its statement, but not listed: before the window
                occ = Occurrence(line.transaction_date, entry, _money(entry.amount),
                                 _money(entry.amount))
                out.append(occ)
                if entry.entry_type == BudgetEntryType.EXPENSE:
                    card_lines.setdefault(entry.account_id, []).append(
                        (occ, ("e", entry.id, line.transaction_date)))
            continue
        for when in iter_occurrences(entry, start, end):
            key = (entry.id, when.date())
            if linked[key]:
                linked[key] -= 1
                continue
            out.append(Occurrence(when, entry, _money(entry.amount), _money(entry.amount)))

    for card_id, lines in card_lines.items():
        covered = _card_household_cover(db, billed[card_id], cash_ids, start, end,
                                        recorded=recorded)
        for occ, key in lines:
            occ.remainder = covered.get(key, occ.face)
    return [o for o in out if o.remainder > 0]


def _card_household_cover(db: Session, card: Account, cash_ids: set, start: datetime,
                          end: datetime, *, recorded: bool) -> Dict[tuple, Decimal]:
    """``{line key: remainder}`` for every Household line on ``card`` (module docstring).

    Line keys are ``("t", transaction id)`` and ``("e", entry id, occurrence)``;
    a line whose key is missing has no statement (remainder = face).
    """
    from app.services.forecast import _card_entry_charges, _linked_occurrence_days, iter_occurrences

    rows = db.query(Transaction).filter(
        (Transaction.account_id == card.id)
        | ((Transaction.transaction_type == TransactionType.TRANSFER)
           & ((Transaction.transfer_to_account_id == card.id)
              | (Transaction.transfer_from_account_id == card.id)))
    ).all()
    if recorded:
        rows = [r for r in rows if r.is_posted]
    household_txns = _household_ids(db, Transaction, [r.id for r in rows], card.user_id)

    lines: List[Tuple[datetime, Decimal, Optional[tuple]]] = []
    payments: List[Tuple[datetime, Decimal, bool]] = []
    for row in rows:
        when = _naive(row.transaction_date)
        amount = _money(row.amount)
        if row.transaction_type == TransactionType.TRANSFER:
            source = row.transfer_from_account_id or row.account_id
            if row.transfer_to_account_id == card.id:
                payments.append((when, amount, source in cash_ids))
            elif source == card.id:
                lines.append((when, amount + _money(row.transfer_fee), None))
            continue
        if row.transaction_type == TransactionType.DEBIT:
            key = ("t", row.id) if row.id in household_txns else None
            lines.append((when, amount, key))
        elif row.transaction_type == TransactionType.CREDIT:
            lines.append((when, -amount, None))

    if not recorded:
        entries = db.query(BudgetEntry).filter(
            BudgetEntry.account_id == card.id, BudgetEntry.is_active.is_(True),
            BudgetEntry.transfer_to_account_id.is_(None)).all()
        household_entries = _household_ids(db, BudgetEntry, [e.id for e in entries],
                                           card.user_id)
        for entry in entries:
            income = entry.entry_type == BudgetEntryType.INCOME
            for line in _card_entry_charges(db, [entry], {card.id: card}, start, end,
                                            None).get(card.id, []):
                amount = _money(line.amount)
                key = (("e", entry.id, line.transaction_date)
                       if entry.id in household_entries and not income else None)
                lines.append((line.transaction_date, -amount if income else amount, key))
        # Recurring transfers into the card: payments on their occurrences.
        recurring = db.query(BudgetEntry).filter(
            BudgetEntry.transfer_to_account_id == card.id,
            BudgetEntry.is_active.is_(True)).all()
        linked = _linked_occurrence_days(db, [e.id for e in recurring])
        for entry in recurring:
            for when in iter_occurrences(entry, start, end):
                key = (entry.id, when.date())
                if linked[key]:
                    linked[key] -= 1
                    continue
                payments.append((when, _money(entry.amount), entry.account_id in cash_ids))

    if not lines:
        return {}
    days = [when.date() for when, _, _ in lines]
    cycles = list(iter_cycles_from(card, min(days), datetime.min, through=max(days)))
    balances = []
    for c in cycles:
        lo, hi = c["window_start"].date(), c["close"].date()
        balances.append(sum((amt for when, amt, _ in lines if lo < when.date() <= hi), ZERO))

    # Every payment and credit, oldest statement first; track the in-scope part.
    remaining = [max(b, ZERO) for b in balances]
    in_scope = [ZERO] * len(cycles)
    pool = [(amt, flag) for _, amt, flag in sorted(payments, key=lambda p: p[0])]
    pool += [(-b, False) for b in balances if b < 0]
    i = 0
    for amount, flag in pool:
        left = amount
        while left > 0 and i < len(remaining):
            paid = min(left, remaining[i])
            remaining[i] -= paid
            left -= paid
            if flag:
                in_scope[i] += paid
            if remaining[i] == 0:
                i += 1
    routed = card.payment_account_id in cash_ids

    out: Dict[tuple, Decimal] = {}
    for idx, c in enumerate(cycles):
        cover = in_scope[idx] + (remaining[idx] if routed else ZERO)
        lo, hi = c["window_start"].date(), c["close"].date()
        household = sorted(((when, amt, key) for when, amt, key in lines
                            if key is not None and lo < when.date() <= hi),
                           key=lambda line: (line[0], str(line[2])))
        for _, amt, key in household:
            part = min(cover, amt)
            cover -= part
            out[key] = amt - part
    return out


def _household_ids(db: Session, model, ids: List[int], owner_id: int) -> set:
    """The ids among ``ids`` carrying their owner's Household tag explicitly (``owner_id``'s)."""
    from app.core.access import TAG_LINKS
    from app.models.tag import Tag

    if not ids:
        return set()
    link, column = TAG_LINKS[model]
    return {row[0] for row in db.query(link.c[column]).join(Tag, Tag.id == link.c.tag_id).join(
        model, model.id == link.c[column]).filter(
        link.c[column].in_(ids), Tag.is_system.is_(True), Tag.user_id == owner_id,
        model.user_id == owner_id)}
