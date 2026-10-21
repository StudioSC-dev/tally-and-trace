"""Available credit per card (STU-343 Plan C, section 2.2).

Owner and admin only (``can_see_credit``), on a credit card with a limit; the
figure is in the card's own currency K.

**Opening** (everything already committed)::

    available_now = limit - (balance_owed + pending_total + installment_hold + missed_total)

1. ``balance_owed`` is ``-balance``: posted rows only.
2. ``pending_total`` is every unposted row on the card, whatever its date:
   debits at their face (a foreign face at the buffered live rate) and
   transfers out of the card at amount plus fee. A row linked to a recurring
   entry is counted here once and nowhere else.
3. ``installment_hold``: each active card installment's remaining occurrences
   from ``next_occurrence`` (the cap applied after clamped days merge), less
   those a linked row stands for, at the entry amount.
4. ``missed_total``: each active subscription or bill's occurrences before
   today with no linked row, posted or pending, at the entry amount.

**Walk** over ``[S, E)`` (Manila midnight, 30 days with the last included), in
date order, a day's payments after its charges: subscription and bill
occurrences with no linked row subtract; pending rows dated in the window and
installment occurrences subtract 0 (the opening holds them); unposted
transfers into the card (planned payments) dated in the window add. Each
charge gets a check with ``available_after`` (counted planned payments
included) and ``available_after_without_planned``.

Every recurring occurrence comes from one stream, ``capped_distinct_days``
(each calendar day once, a cap applied after merging), and each linked row
(``_linked_rows`` with ``occurrence_match``) hides exactly one occurrence on
its day, as ``unrecorded_occurrences`` consumes them.

A foreign figure is ``convert(face, rate x (1 + CARD_FX_BUFFER))`` at the
request's live stored rate, never a row's own ``exchange_rate``; with no rate
it is unknown (``unknown_count`` in the opening, ``unchecked`` in the walk).
A row or entry the caller sees Limited is left out and counted in
``uncounted_shared``; a Limited planned payment is neither counted nor listed.
Anything uncounted at or before a check turns its ``ok`` or
``ok_with_planned`` into ``incomplete``.

This module runs its own queries and ``Redactor.view``; it does not reuse the
card charges' selection.
"""
from __future__ import annotations

from collections import Counter
from datetime import date, datetime, timedelta
from decimal import Decimal
from typing import Dict, Iterable, List, Optional

from sqlalchemy import and_, or_
from sqlalchemy.orm import Session

from app.core.access import MANAGE_ROLES, account_role, viewable_account_ids, viewable_accounts
from app.core.redaction import FULL, LIMITED, Redactor
from app.core.time import manila_midnight, manila_today
from app.models.account import Account, AccountType
from app.models.budget_entry import BudgetEntry
from app.models.transaction import Transaction, TransactionType, pending_face, transfer_sides
from app.services import forecast as fc
from app.services.fx import FxRates, convert
from app.services.recurring_kinds import entry_kind, is_card_installment, is_kind_eligible
from app.services.statements import iter_cycles_from, statement_history

CARD_FX_BUFFER = Decimal("0.03")
WINDOW_DAYS = 30
_ZERO = Decimal("0")
_RATE_PLACES = Decimal("0.000001")

# Walk phases on one day: a Limited entry's marker first (it makes that day's
# checks incomplete), then charges, then planned payments.
_MARK, _CHARGE, _PAYMENT = 0, 1, 2


def can_see_credit(user, card: Optional[Account]) -> bool:
    """The credit gate: an owner or admin of a credit card."""
    return (card is not None and card.account_type == AccountType.CREDIT
            and account_role(user, card) in MANAGE_ROLES)


def managed_card_ids(db: Session, user) -> List[int]:
    """Every active credit card with a limit the caller manages, by name."""
    cards = viewable_accounts(db, user, active_only=True, roles=MANAGE_ROLES).filter(
        Account.account_type == AccountType.CREDIT,
        Account.credit_limit.isnot(None),
    ).all()
    return [c.id for c in sorted(cards, key=lambda a: (a.name, a.id))]


def _amount(value: Optional[Decimal]) -> Optional[float]:
    return round(float(value), 2) if value is not None else None


def _day(value) -> date:
    return fc._naive(value).date() if isinstance(value, datetime) else value


class _Converter:
    """Figures in the card's currency at the buffered live rate."""

    def __init__(self, fx: FxRates, currency: str):
        self.fx = fx
        self.currency = currency
        self.used: Dict[tuple, object] = {}

    def to_card(self, amount, currency) -> Optional[Decimal]:
        currency = fc._code(currency) or self.currency
        if currency == self.currency:
            return fc._money(amount)
        rate = self.fx.rate(currency, self.currency)
        if rate is None:
            return None
        self.used[(rate.base, rate.quote)] = rate
        return convert(fc._money(amount), rate.rate * (1 + CARD_FX_BUFFER))

    def rates(self) -> List[dict]:
        return [{
            "base": r.base,
            "quote": r.quote,
            "rate": float(r.rate),
            "buffered_rate": float((r.rate * (1 + CARD_FX_BUFFER)).quantize(_RATE_PLACES)),
            "as_of": r.as_of.isoformat(),
            "stale": bool(r.stale),
        } for _, r in sorted(self.used.items())]


def _stream(entry, end: datetime, *, whole: bool) -> List[datetime]:
    """The entry's occurrences from ``next_occurrence`` (``capped_distinct_days``).

    ``whole`` (a capped installment) walks every remaining occurrence, however
    far: one step per day to ``end`` as ``unrecorded_occurrences`` bounds it,
    and never fewer steps than the cap plus two, so a long plan is never cut
    short at the window's end. Otherwise the walk stops at ``end``.
    """
    start = fc._naive(entry.next_occurrence)
    bound = max((end - start).days, 0) + 2
    if whole:
        bound = max(bound, max(entry.max_occurrences or 0, 0) + 2)
        return fc.capped_distinct_days(entry, start, datetime.max, max_steps=bound)
    return fc.capped_distinct_days(entry, start, end, max_steps=bound)


def credit_for_cards(db: Session, user, card_ids: Iterable[int], *,
                     fx: Optional[FxRates], redactor: Optional[Redactor] = None
                     ) -> Dict[int, dict]:
    """``{card id: CardCredit}`` for each of ``card_ids`` that passes
    ``can_see_credit`` and has a limit; the others are left out."""
    card_ids = list(dict.fromkeys(card_ids))
    if not card_ids:
        return {}
    cards = {c.id: c for c in db.query(Account).filter(Account.id.in_(card_ids)).all()
             if can_see_credit(user, c) and c.credit_limit is not None}
    if not cards:
        return {}
    fx = fx if fx is not None else FxRates.offline(db)
    redactor = redactor or Redactor(db, user)
    start, end = fc._upcoming_window(WINDOW_DAYS, manila_midnight())

    ids = list(cards)
    rows = db.query(Transaction).filter(
        Transaction.is_posted.is_(False),
        or_(
            and_(Transaction.transaction_type == TransactionType.DEBIT,
                 Transaction.account_id.in_(ids)),
            and_(Transaction.transaction_type == TransactionType.TRANSFER,
                 or_(Transaction.transfer_from_account_id.in_(ids),
                     and_(Transaction.transfer_from_account_id.is_(None),
                          Transaction.account_id.in_(ids)),
                     Transaction.transfer_to_account_id.in_(ids))),
        ),
    ).order_by(Transaction.transaction_date, Transaction.id).all()
    entries = [e for e in db.query(BudgetEntry).filter(
        BudgetEntry.account_id.in_(ids),
        BudgetEntry.is_active.is_(True),
    ).order_by(BudgetEntry.next_occurrence, BudgetEntry.id).all()
        if is_kind_eligible(e)
        and entry_kind(e, cards[e.account_id]) in ("installment", "subscription", "bill")]
    redactor.prepare(list(rows) + entries)
    linked = Counter((entry_id, fc._naive(when).date())
                     for entry_id, when, _, _ in fc._linked_rows(
                         db, [e.id for e in entries], occurrence_match=True))
    entry_by_id = {e.id: e for e in entries}

    def view(record) -> str:
        return redactor.view(record) if redactor.access.readable(record) else LIMITED

    out = {}
    for card in cards.values():
        out[card.id] = _card_credit(
            card, start, end, fx,
            rows=[r for r in rows if _touches(r, card.id)],
            entries=[e for e in entries if e.account_id == card.id],
            linked=linked, entry_by_id=entry_by_id, view=view)
    return out


def _touches(txn: Transaction, card_id: int) -> bool:
    if txn.transaction_type == TransactionType.DEBIT:
        return txn.account_id == card_id
    return (txn.transfer_from_account_id or txn.account_id) == card_id \
        or txn.transfer_to_account_id == card_id


def _card_credit(card: Account, start: datetime, end: datetime, fx: FxRates, *,
                 rows: List[Transaction], entries: List[BudgetEntry], linked: Counter,
                 entry_by_id: Dict[int, BudgetEntry], view) -> dict:
    currency = fc._code(card.currency)
    money = _Converter(fx, currency)
    limit = fc._money(card.credit_limit)
    s_day, e_day = start.date(), end.date()

    balance_owed = -fc._money(card.balance or 0)
    pending_total = _ZERO
    hold = _ZERO
    missed_total = _ZERO
    unknown = 0
    uncounted_shared = 0
    opening_uncounted = False
    # (day, phase, order, payload)
    walk: List[tuple] = []
    planned: List[dict] = []

    # --- transactions ---------------------------------------------------------
    for txn in rows:
        day = _day(txn.transaction_date)
        source = txn.transfer_from_account_id or txn.account_id
        is_payment = (txn.transaction_type == TransactionType.TRANSFER
                      and txn.transfer_to_account_id == card.id and source != card.id)
        record_view = view(txn)
        if is_payment:
            if record_view == LIMITED:
                continue  # leaving it out only understates credit
            amount = fc._money(transfer_sides(txn)[1])
            reason = ("before_today" if day < s_day
                      else "after_window" if day >= e_day else None)
            planned.append({"date": day.isoformat(), "amount": _amount(amount),
                            "counted": reason is None, "reason": reason,
                            "_order": (day, txn.id)})
            if reason is None:
                walk.append((day, _PAYMENT, (0, txn.id), {"amount": amount}))
            continue
        if record_view == LIMITED:
            uncounted_shared += 1
            opening_uncounted = True
            continue
        if txn.transaction_type == TransactionType.DEBIT:
            face, face_currency = pending_face(txn)
            figure = money.to_card(face, face_currency) if face is not None else None
            kind = "pending"
        else:
            figure = fc._money(transfer_sides(txn)[0])
            kind = "advance"
        entry = entry_by_id.get(txn.budget_entry_id) if txn.budget_entry_id else None
        if record_view == FULL and entry is not None and entry.account_id == card.id:
            # The caller made the row, so its link is theirs to see.
            kind = entry_kind(entry, card) or kind
        if figure is None:
            unknown += 1
            opening_uncounted = True
        else:
            pending_total += figure
        if s_day <= day < e_day:
            walk.append((day, _CHARGE, (0, txn.id), {
                "source": "transaction", "source_id": txn.id, "date": day,
                "occurrence_date": None, "kind": kind, "amount": figure,
                "subtract": False}))

    # --- recurring entries ----------------------------------------------------
    missed: List[dict] = []
    for entry in entries:
        kind = entry_kind(entry, card)
        installment = is_card_installment(entry, card)
        occurrences = []
        for occ in _stream(entry, end, whole=installment):
            key = (entry.id, occ.date())
            if linked[key]:
                linked[key] -= 1
                continue
            occurrences.append(occ.date())
        if view(entry) == LIMITED:
            # Left out: the opening when it holds or missed anything, else
            # every check from its first occurrence in the window.
            before = [d for d in occurrences if d < s_day]
            inside = [d for d in occurrences if s_day <= d < e_day]
            if (installment and occurrences) or before:
                uncounted_shared += 1
                opening_uncounted = True
            elif inside:
                uncounted_shared += 1
                walk.append((inside[0], _MARK, (1, entry.id), None))
            continue
        each = money.to_card(entry.amount, entry.currency)
        if installment:
            if occurrences:
                if each is None:
                    unknown += 1
                    opening_uncounted = True
                else:
                    hold += each * len(occurrences)
            for d in occurrences:
                if s_day <= d < e_day:
                    walk.append((d, _CHARGE, (1, entry.id), {
                        "source": "budget_entry", "source_id": entry.id, "date": d,
                        "occurrence_date": d, "kind": "installment", "amount": each,
                        "subtract": False}))
            continue
        before = [d for d in occurrences if d < s_day]
        if before:
            total = each * len(before) if each is not None else None
            if total is None:
                unknown += 1
                opening_uncounted = True
            else:
                missed_total += total
            missed.append({"entry_id": entry.id, "name": entry.name, "kind": kind,
                           "count": len(before), "total": _amount(total)})
        for d in occurrences:
            if s_day <= d < e_day:
                walk.append((d, _CHARGE, (1, entry.id), {
                    "source": "budget_entry", "source_id": entry.id, "date": d,
                    "occurrence_date": d, "kind": kind, "amount": each,
                    "subtract": True}))

    available_now = limit - (balance_owed + pending_total + hold + missed_total)

    # --- the walk ---------------------------------------------------------------
    walk.sort(key=lambda item: (item[0], item[1], item[2]))
    after = without = available_now
    uncounted = opening_uncounted
    payments: List[tuple] = []  # (day, amount), counted, in walk order
    checks: List[dict] = []
    for day, phase, _, item in walk:
        if phase == _MARK:
            uncounted = True
            continue
        if phase == _PAYMENT:
            after += item["amount"]
            payments.append((day, item["amount"]))
            continue
        figure = item["amount"]
        relies = None
        if item["kind"] == "installment":
            status = "installment"
            values = (after, without)
        elif figure is None:
            status = "unchecked"
            values = (None, None)
        else:
            if item["subtract"]:
                after -= figure
                without -= figure
            values = (after, without)
            if after < 0:
                status = "at_risk"
            elif without < 0:
                status = "ok_with_planned"
                running = without
                for paid_on, paid in payments:
                    running += paid
                    if running >= 0:
                        relies = paid_on.isoformat()
                        break
            else:
                status = "ok"
            if uncounted and status in ("ok", "ok_with_planned"):
                status, relies = "incomplete", None
        checks.append({
            "source": item["source"],
            "source_id": item["source_id"],
            "date": item["date"].isoformat(),
            "occurrence_date": (item["occurrence_date"].isoformat()
                                if item["occurrence_date"] is not None else None),
            "kind": item["kind"],
            "amount": _amount(figure),
            "available_after": _amount(values[0]),
            "available_after_without_planned": _amount(values[1]),
            "status": status,
            "relies_on_planned": relies,
        })
        if figure is None and item["kind"] != "installment":
            uncounted = True

    counted = [p for p in planned if p["counted"]]
    planned.sort(key=lambda p: p["_order"])
    for p in planned:
        p.pop("_order")
    with_planned = available_now + sum((amount for _, amount in payments), _ZERO)
    return {
        "account_id": card.id,
        "currency": currency,
        "limit": _amount(limit),
        "as_of": s_day.isoformat(),
        "available_now": _amount(available_now),
        "available_with_planned": _amount(with_planned),
        "planned_by": max(p["date"] for p in counted) if counted else None,
        "complete": unknown == 0 and uncounted_shared == 0,
        "uncounted_shared": uncounted_shared,
        "unknown_count": unknown,
        "opening": {
            "balance_owed": _amount(balance_owed),
            "pending_total": _amount(pending_total),
            "installment_hold": _amount(hold),
            "missed_total": _amount(missed_total),
        },
        "missed": missed,
        "planned_payments": planned,
        "checks": checks,
        "fx": money.rates(),
        "fx_buffer_pct": int(CARD_FX_BUFFER * 100),
    }


def open_cycle(card: Account, today: date) -> Optional[dict]:
    """``{close_date, due_date}`` of the cycle open on ``today`` (its close is
    today or later), or None for a card without cycle settings."""
    cycle = next(iter_cycles_from(card, today, datetime.min, through=today), None)
    if cycle is None:
        return None
    return {"close_date": cycle["close"].date().isoformat(),
            "due_date": cycle["due"].date().isoformat()}


def closed_statements(db: Session, user, card: Account, fx: Optional[FxRates]) -> List[dict]:
    """The card's closed statements, oldest first: ``statement_history`` on
    Manila's midnight over the caller's viewable accounts, kept while the close
    is before Manila's today (a statement closing today can still take
    charges). Recorded rows only, in the card's currency. The one selection
    behind the Pay dialog (``routers/cards.py: card_statements``) and the owed
    statements in the snapshot (``statements_due``)."""
    today = manila_today()
    history = statement_history(db, card, manila_midnight(), viewable_account_ids(db, user),
                                fx=fx)
    return [s for s in history if s["close"].date() < today]


def statements_due(db: Session, user, fx: Optional[FxRates]) -> List[dict]:
    """``CardStatementDue[]``: each managed credit card (owner or admin, active,
    with or without a limit: a superset of the credit pass) whose latest closed
    statement L still has something to clear, by name.

    A card is listed when L's ``clear_through`` is above 0 and its oldest owed
    closed statement is due before E (the 30-day window from Manila's
    midnight, its last day included) or is overdue. ``clear_through`` is
    exactly what the Pay dialog suggests as Full, in the card's currency, from
    recorded rows only (``closed_statements``). ``statement_count`` is the
    number of closed statements still owed; ``overdue`` whether any of them
    is due before Manila's today; ``incomplete`` whether a foreign line with
    no rate may have left ``clear_through`` low.
    """
    end = manila_today() + timedelta(days=WINDOW_DAYS + 1)
    cards = viewable_accounts(db, user, active_only=True, roles=MANAGE_ROLES).filter(
        Account.account_type == AccountType.CREDIT).all()
    items = []
    for card in sorted(cards, key=lambda a: (a.name, a.id)):
        closed = closed_statements(db, user, card, fx)
        if not closed or closed[-1]["clear_through"] <= 0:
            continue
        latest = closed[-1]
        owed = [s for s in closed if s["owed"] > 0]
        oldest_due = owed[0]["due"].date()
        if oldest_due >= end:
            continue
        items.append({
            "account_id": card.id,
            "name": card.name,
            "currency": fc._code(card.currency),
            "close_date": latest["close"].date().isoformat(),
            "due_date": latest["due"].date().isoformat(),
            "clear_through": _amount(latest["clear_through"]),
            "statement_count": len(owed),
            "oldest_due": oldest_due.isoformat(),
            "overdue": any(s["status"] == "overdue" for s in owed),
            "incomplete": latest["incomplete"],
        })
    return items
