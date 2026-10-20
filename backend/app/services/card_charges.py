"""Upcoming charges by card for ``/dashboard/snapshot`` (STU-343, basic view).

Every active credit card the caller holds a direct role on lists the charges
due on it over the next 30 days (from midnight on the Manila calendar), chosen
by where each charge comes from:

1. occurrences of the card's recurring expenses (``is_kind_eligible``), on a
   card with or without a statement cycle, unconverted ones included;
2. its unposted debits;
3. its unposted transfers out (cash advances), at the amount plus fee the
   card is billed;
4. its overdue unposted debits, which the projection skips (they reach cash
   through their statements), queried here directly.

Recurring card payments are not charges and recurring transfers out of a card
stay refused, so neither is listed. A card is listed only when it has a charge
or a missed item. The ``?tag=`` filter is ignored, and no total or
credit-derived figure is returned.

A charge the caller sees Limited keeps only ``LimitedCharge``'s keys, with the
response's shared public id (``PublicIds``), so one occurrence has one id across
the snapshot's lists. Only a recurring entry's charge offers Mark paid
(``can_mark_paid``, the entry's ``can_post``); a pending card transaction is
posted on the Transactions page, never here. ``recurring`` marks a pending debit
linked to a recurring entry (one recorded as Charged, or linked by hand); it
names no entry, so a shared editor sees it too.

Each ``missed`` item also says which of its missed occurrences a pending
linked row already stands for (``unlinked_count``, ``oldest_unlinked``) and
lists those rows, the ones it may read and does not see Limited
(``pending_transaction_ids``).
"""
from __future__ import annotations

from datetime import date, datetime
from typing import Dict, List, Optional

from sqlalchemy.orm import Session

from app.core.access import DIRECT_ROLES, account_role
from app.core.redaction import LIMITED, Redactor
from app.core.time import manila_midnight, manila_today
from app.models.account import Account, AccountType
from app.models.budget_entry import BudgetEntry
from app.models.transaction import Transaction, TransactionType, pending_face
from app.services import forecast as fc
from app.services.fx import FxRates
from app.services.missed import split_pending_links
from app.services.recurring_kinds import entry_kind, is_capped, is_kind_eligible
from app.services.statements import resolve_cycle_fields

WINDOW_DAYS = 30
LIMITED_KEYS = ("view", "public_id", "date", "original_date", "overdue", "display_name")


def _day(value) -> Optional[str]:
    if value is None:
        return None
    return (fc._naive(value).date() if isinstance(value, datetime) else value).isoformat()


def _amount(value) -> Optional[float]:
    return round(float(value), 2) if value is not None else None


class _Charge:
    """One selected charge before serialisation: its listing day, sort key and
    either a full payload or the event that becomes a ``LimitedCharge``."""

    def __init__(self, card_id: int, when: datetime, original: Optional[datetime],
                 order: int, *, full: Optional[dict] = None,
                 limited: Optional[dict] = None):
        self.card_id = card_id
        self.when = when
        self.original = original
        self.order = order
        self.full = full
        self.limited = limited

    def sort_key(self):
        return (self.when.date(), (self.original or self.when).date(), self.order)


def card_charges_by_card(db: Session, user, *, fx: Optional[FxRates],
                         collector: fc.FxCollector, ids: fc.PublicIds,
                         redactor: Redactor) -> List[dict]:
    """``card_charges`` of the snapshot (see the module docstring).

    ``collector`` and ``ids`` are the snapshot's own, so the response's ``fx``
    covers these rows and a Limited occurrence keeps its id in every list.
    """
    user_id = user.id
    accounts = fc.get_account_balances(db, user_id)
    cards = {a.id: a for a in accounts
             if a.account_type == AccountType.CREDIT and account_role(user_id, a) in DIRECT_ROLES}
    if not cards:
        return []
    start, end = fc._upcoming_window(WINDOW_DAYS, manila_midnight())
    today = manila_today()
    events = fc.collect_events(db, start, end, user_id=user_id, accounts=accounts,
                               keep_origin=True, fx=fx, detail=True)

    entry_ids = {e["origin"][1] for e in events if e["origin"][0] is BudgetEntry}
    txn_ids = {e["origin"][1] for e in events if e["origin"][0] is Transaction}
    entries = {e.id: e for e in db.query(BudgetEntry).filter(
        BudgetEntry.id.in_(entry_ids)).all()} if entry_ids else {}
    txns = {t.id: t for t in db.query(Transaction).filter(
        Transaction.id.in_(txn_ids)).all()} if txn_ids else {}
    access = redactor.access

    charges: List[_Charge] = []

    def add_event(card_id: int, e: dict, payload) -> None:
        when = fc._naive(e["date"])
        original = fc._naive(e["original_date"]) if e.get("original_date") else None
        if e.get("view") == LIMITED:
            charges.append(_Charge(card_id, when, original, len(charges), limited=e))
        else:
            charges.append(_Charge(card_id, when, original, len(charges), full=payload()))

    for e in events:
        model, record_id = e["origin"]
        if model is BudgetEntry:
            entry = entries.get(record_id)
            if entry is None or entry.account_id not in cards or not is_kind_eligible(entry):
                continue
            card = cards[entry.account_id]
            add_event(card.id, e, lambda e=e, entry=entry, card=card: _entry_charge(
                e, entry, card, collector, redactor))
        elif model is Transaction:
            txn = txns.get(record_id)
            if txn is None:
                continue
            if txn.transaction_type == TransactionType.DEBIT and txn.account_id in cards:
                card = cards[txn.account_id]
                add_event(card.id, e, lambda e=e, txn=txn, card=card: _debit_charge(
                    e, txn, card, collector, redactor))
            elif txn.transaction_type == TransactionType.TRANSFER:
                source = txn.transfer_from_account_id or txn.account_id
                if source in cards:
                    card = cards[source]
                    add_event(card.id, e, lambda e=e, txn=txn, card=card: _advance_charge(
                        e, txn, card, collector, redactor))

    # Overdue unposted debits on the cards: the projection skips them, so they
    # are read here and listed on the window start, like any overdue row.
    money = fc.Money(db, fx)
    money.seed(accounts)
    overdue = [t for t in db.query(Transaction).filter(
        Transaction.account_id.in_(list(cards)),
        Transaction.transaction_type == TransactionType.DEBIT,
        Transaction.is_posted.is_(False),
        Transaction.transaction_date < start,
    ).order_by(Transaction.transaction_date, Transaction.id).all() if access.readable(t)]
    for txn in overdue:
        card = cards[txn.account_id]
        original = fc._naive(txn.transaction_date)
        if redactor.view(txn) == LIMITED:
            charges.append(_Charge(card.id, start, original, len(charges), limited={
                "origin": (Transaction, txn.id),
                "date": start,
                "original_date": original,
                "overdue": True,
                "name": redactor.display_description(txn),
            }))
        else:
            charges.append(_Charge(card.id, start, original, len(charges), full=_overdue_charge(
                txn, card, start, original, money, collector, redactor)))

    charges.sort(key=_Charge.sort_key)
    limited = [c for c in charges if c.limited is not None]
    # One key per charge: a limited event split by cash currency elsewhere is
    # keyed by its first row, as the other lists key it.
    keyed = [fc._limited_rows(c.limited)[0] if "rows" in c.limited else c.limited
             for c in limited]
    for charge, public_id in zip(limited, ids.assign(keyed)):
        e = charge.limited
        charge.full = {
            "view": LIMITED,
            "public_id": public_id,
            "date": _day(e["date"]),
            "original_date": _day(e.get("original_date")),
            "overdue": bool(e.get("overdue")),
            "display_name": e["name"],
        }

    missed = _missed(db, cards, today, redactor)
    out = []
    for card in sorted(cards.values(), key=lambda a: (a.name, a.id)):
        rows = [c.full for c in charges if c.card_id == card.id]
        card_missed = missed.get(card.id, [])
        if not rows and not card_missed:
            continue
        out.append({
            "account_id": card.id,
            "account_name": card.name,
            "currency": fc._code(card.currency),
            "statement_cycle": resolve_cycle_fields(card) is not None,
            "missed": card_missed,
            "charges": rows,
        })
    return out


def _full(e_view: str, *, when: datetime, original: Optional[datetime],
          occurrence: Optional[date], name: str, kind: str, source: str, source_id: int,
          row: dict, key: tuple, collector: fc.FxCollector, can_mark_paid: bool,
          recurring: bool) -> dict:
    return {
        "view": e_view,
        "date": _day(when),
        "original_date": _day(original),
        "overdue": original is not None,
        "occurrence_date": occurrence.isoformat() if occurrence is not None else None,
        "name": name,
        "kind": kind,
        "source": source,
        "source_id": source_id,
        "recurring": recurring,
        "amount": _amount(row["amount"]),
        "currency": row["currency"],
        **collector.row(key, row),
        "can_mark_paid": can_mark_paid,
    }


def _card_row(e: dict, card: Account) -> dict:
    currency = fc._code(card.currency)
    return next((r for r in e.get("rows") or () if r["currency"] == currency),
                fc._row(currency, None))


def _event_times(e: dict) -> tuple:
    when = fc._naive(e["date"])
    original = fc._naive(e["original_date"]) if e.get("original_date") else None
    return when, original


def _entry_charge(e: dict, entry: BudgetEntry, card: Account, collector: fc.FxCollector,
                  redactor: Redactor) -> dict:
    when, original = _event_times(e)
    row = _card_row(e, card)
    return _full(redactor.view(entry), when=when, original=original,
                 occurrence=(original or when).date(), name=e["name"],
                 kind=entry_kind(entry, card), source="budget_entry", source_id=entry.id,
                 row=row, key=fc._row_key(e, row["currency"]), collector=collector,
                 can_mark_paid=bool(redactor.access.permissions(entry)["can_post"]),
                 recurring=False)


def _debit_charge(e: dict, txn: Transaction, card: Account, collector: fc.FxCollector,
                  redactor: Redactor) -> dict:
    when, original = _event_times(e)
    row = _card_row(e, card)
    return _full(redactor.view(txn), when=when, original=original, occurrence=None,
                 name=e["name"], kind="pending", source="transaction", source_id=txn.id,
                 row=row, key=fc._row_key(e, row["currency"]), collector=collector,
                 can_mark_paid=False, recurring=txn.budget_entry_id is not None)


def _advance_charge(e: dict, txn: Transaction, card: Account, collector: fc.FxCollector,
                    redactor: Redactor) -> dict:
    """A cash advance: what the card is billed, its leg's amount plus fee."""
    when, original = _event_times(e)
    currency = fc._code(card.currency)
    leg = next((leg for leg in e["legs"] if leg["account_id"] == card.id), None)
    source_row = next((r for r in e.get("rows") or () if r["currency"] == currency), None)
    estimate = source_row["estimate"] if source_row is not None else None
    if estimate is not None:
        estimate = {**estimate, "original_amount": fc._money(e["face_amount"])
                    + fc._money(e.get("transfer_fee") or 0)}
    row = fc._row(currency, -leg["amount"] if leg is not None else None, estimate)
    return _full(redactor.view(txn), when=when, original=original, occurrence=None,
                 name=e["name"], kind="advance", source="transaction", source_id=txn.id,
                 row=row, key=fc._row_key(e, currency), collector=collector,
                 can_mark_paid=False, recurring=False)


def _overdue_charge(txn: Transaction, card: Account, start: datetime, original: datetime,
                    money: fc.Money, collector: fc.FxCollector, redactor: Redactor) -> dict:
    """An overdue unposted debit, as ``collect_events`` would list it."""
    currency = fc._code(card.currency)
    face, face_currency = pending_face(txn)
    if fc._code(face_currency) != currency and face is not None:
        figure, estimate = money.to(face, face_currency, currency)
    else:
        figure, estimate = fc._money(txn.amount), None
    row = fc._row(currency, figure, estimate)
    name = redactor.display_description(txn) or "Unposted transaction"
    key = ("transaction", txn.id, start.date(), name, currency)
    return _full(redactor.view(txn), when=start, original=original, occurrence=None,
                 name=name, kind="pending", source="transaction", source_id=txn.id,
                 row=row, key=key, collector=collector, can_mark_paid=False,
                 recurring=txn.budget_entry_id is not None)


def _missed(db: Session, cards: Dict[int, Account], today: date,
            redactor: Redactor) -> Dict[int, List[dict]]:
    """``{card id: [missed item]}``: each open-ended subscription or bill on a
    card, seen in full or shared_full, with occurrences before today that no
    posted row records (``count``), also counting today's (``due_count``).
    ``unlinked_count``, ``oldest_unlinked`` and ``pending_transaction_ids``
    split ``count`` by pending linked rows (``missed.split_pending_links``)."""
    entries = [e for e in db.query(BudgetEntry).filter(
        BudgetEntry.account_id.in_(list(cards)),
        BudgetEntry.is_active.is_(True),
    ).order_by(BudgetEntry.next_occurrence, BudgetEntry.id).all()
        if is_kind_eligible(e) and not is_capped(e)
        and entry_kind(e, cards[e.account_id]) in ("subscription", "bill")
        and redactor.access.readable(e) and redactor.view(e) != LIMITED]
    unrecorded = fc.unrecorded_occurrences(db, entries, through=today)
    missed = {entry_id: [occ for occ in due if occ.date() < today]
              for entry_id, due in unrecorded.items()}
    links = split_pending_links(db, entries, missed, redactor)
    out: Dict[int, List[dict]] = {}
    for entry in entries:
        due = unrecorded.get(entry.id, [])
        count = len(missed.get(entry.id, []))
        if count == 0:
            continue
        out.setdefault(entry.account_id, []).append({
            "entry_id": entry.id,
            "name": entry.name,
            "kind": entry_kind(entry, cards[entry.account_id]),
            "count": count,
            "due_count": len(due),
            "oldest": due[0].date().isoformat(),
            **links[entry.id],
            "can_mark_paid": bool(redactor.access.permissions(entry)["can_post"]),
        })
    return out
