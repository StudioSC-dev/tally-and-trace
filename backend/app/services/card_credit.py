"""Available credit per card (STU-343 Plan C, section 2.2).

Owner and admin only (``can_see_credit``), on a credit card with a limit; the
figure is in the card's own currency K.

**Shared limit.** A card linked to another card's limit
(``shares_limit_with_account_id``, the secondary) has no limit of its own; the
card it points at (the primary) holds it. A primary and every card pointing at
it form a group, and every figure below covers the group: ``limit`` is the
primary's, each opening component is summed over the group's active members
(each worked out exactly as for one card), and one walk runs over every
member's items, so both cards show the same headline. Each card's ``checks``
hold only its own charges, each checked in that merged walk, and
``shared_with`` names the other members (``[]`` on an unlinked card). A caller
sees a group's credit only when ``can_see_credit`` holds on every member;
otherwise no member gets one, as for a card with no limit.

**Opening** (everything already committed)::

    available_now = limit - (balance_owed + pending_total + installment_hold + missed_total)

1. ``balance_owed`` is ``-balance``: posted rows only.
2. ``pending_total``: the unposted charges placed ``now`` (below), debits at
   their face (a foreign face at the buffered live rate) and transfers out of
   the card at amount plus fee. A row linked to a recurring entry is counted
   at most once: here, or as a ``planned`` charge in the walk.
3. ``installment_hold``: each active card installment's remaining occurrences
   from ``next_occurrence`` (the cap applied after clamped days merge), less
   those a linked row stands for and a reviewed installment's held months
   (``installment_duplicates.held_occurrences``, through Manila's today), at
   the entry amount. A held month's possible duplicate is an unlinked charge
   already on the card, counted where it stands (the balance, or
   ``pending_total`` / ``planned_charges_total`` while pending), so the month
   is counted once, as that charge.
4. ``missed_total``: each active subscription or bill's occurrences before
   today with no linked row, posted or pending, at the entry amount.

**Placement** of each unposted charge (``_placement``), by its own day (the
date part of ``transaction_date``) against Manila's today ``S``:

- ``now``: dated today or earlier; or (the replacement exception) a linked
  row whose occurrence the stream consumed for a held installment month or a
  missed month (``replacing_ids``), whatever its date, since that month has
  left the hold or the missed list. Counted in ``pending_total``.
- ``planned``: otherwise, dated inside the window. Not in the opening; it
  subtracts on its own day in the walk, and its figure is summed in
  ``planned_charges_total`` (known rates only).
- ``beyond``: otherwise (dated on or after ``E``). Ignored.

**Walk** over ``[S, E)`` (Manila midnight, 30 days with the last included), in
date order, a day's payments after its charges: subscription and bill
occurrences with no linked row and ``planned`` rows subtract; ``now`` rows
dated in the window and installment occurrences subtract 0 (the opening holds
them); unposted transfers into the card (planned payments) dated in the window
add. Each charge gets a check with ``available_after`` (counted planned
payments included) and ``available_after_without_planned``. A subtracting
check is never short-circuited as an installment: a ``planned`` row linked to
an installment carries its own kind (``pending`` or ``advance``).

Every recurring occurrence comes from one stream, ``capped_distinct_days``
(each calendar day once, a cap applied after merging), and each linked row
(``_linked_rows`` with ``occurrence_match``) hides exactly one occurrence on
its day, as ``unrecorded_occurrences`` consumes them; on a day with several
linked rows, posted rows are taken first, then by ascending id.

A forced date (``services/payment_dates.py``) places an occurrence: before
today, inside the window and each check's ``date`` read the effective date,
while links, held months and each check's ``occurrence_date`` stay nominal. An
installment's hold counts occurrences, so a forced date cannot change it.

A foreign figure is ``convert(face, rate x (1 + CARD_FX_BUFFER))`` at the
request's live stored rate, never a row's own ``exchange_rate``; with no rate
it is unknown (``unknown_count`` in the opening for a ``now`` row, ``unchecked``
in the walk). A row or entry the caller sees Limited is left out and counted in
``uncounted_shared`` (a ``planned`` Limited row marks checks from its day, a
``beyond`` one is ignored); a Limited planned payment is neither counted nor
listed.
Anything uncounted at or before a check turns its ``ok`` or
``ok_with_planned`` into ``incomplete``.

This module runs its own queries and ``Redactor.view``; it does not reuse the
card charges' selection.
"""
from __future__ import annotations

from collections import Counter
from dataclasses import dataclass
from datetime import date, datetime, timedelta
from decimal import Decimal
from typing import Dict, Iterable, List, Optional, Set

from sqlalchemy import and_, or_
from sqlalchemy.orm import Session

from app.core.access import MANAGE_ROLES, account_role, viewable_account_ids, viewable_accounts
from app.core.redaction import FULL, LIMITED, Redactor
from app.core.time import manila_midnight, manila_today
from app.models.account import Account, AccountType
from app.models.budget_entry import BudgetEntry
from app.models.transaction import Transaction, TransactionType, pending_face, transfer_sides
from app.services import forecast as fc
from app.services import statements_store
from app.services.fx import FxRates, convert
from app.services.installment_duplicates import held_occurrences
from app.services.payment_dates import Moved, effective, extend, load_entry_overrides
from app.services.recurring_kinds import entry_kind, is_card_installment, is_kind_eligible
from app.services.statements import (
    _split_card_rows, iter_cycles_from, load_due_overrides, resolve_cycle_fields,
    statement_day, statement_history, statement_summaries,
)

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
    """Every active credit card with a limit, or linked to another card's
    limit, that the caller manages, by name. ``credit_for_cards`` applies the
    group gate."""
    cards = viewable_accounts(db, user, active_only=True, roles=MANAGE_ROLES).filter(
        Account.account_type == AccountType.CREDIT,
        or_(Account.credit_limit.isnot(None),
            Account.shares_limit_with_account_id.isnot(None)),
    ).all()
    return [c.id for c in sorted(cards, key=lambda a: (a.name, a.id))]


def _amount(value: Optional[Decimal]) -> Optional[float]:
    return round(float(value), 2) if value is not None else None


def _day(value) -> date:
    return fc._naive(value).date() if isinstance(value, datetime) else value


def _placement(txn: Transaction, s_day: date, e_day: date, replacing_ids: Set[int]) -> str:
    """``now``, ``planned`` or ``beyond`` for an unposted charge on the card
    (see the module docstring), by its own day."""
    day = _day(txn.transaction_date)
    if day <= s_day or txn.id in replacing_ids:
        return "now"
    return "planned" if day < e_day else "beyond"


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


def _stream(entry, end: datetime, *, whole: bool, moved: Optional[Moved] = None
            ) -> List[datetime]:
    """The entry's occurrences from ``next_occurrence`` (``capped_distinct_days``).

    ``whole`` (a capped installment) walks every remaining occurrence, however
    far: one step per day to ``end`` as ``unrecorded_occurrences`` bounds it,
    and never fewer steps than the cap plus two, so a long plan is never cut
    short at the window's end. Otherwise the walk stops at ``end``, or the reach
    past it for an entry with forced dates (``moved``).
    """
    if moved and not whole:
        end = extend(end)
    start = fc._naive(entry.next_occurrence)
    bound = max((end - start).days, 0) + 2
    if whole:
        bound = max(bound, max(entry.max_occurrences or 0, 0) + 2)
        return fc.capped_distinct_days(entry, start, datetime.max, max_steps=bound)
    return fc.capped_distinct_days(entry, start, end, max_steps=bound)


def credit_for_cards(db: Session, user, card_ids: Iterable[int], *,
                     fx: Optional[FxRates], redactor: Optional[Redactor] = None
                     ) -> Dict[int, dict]:
    """``{card id: CardCredit}`` for each of ``card_ids`` whose group (the card,
    or its primary and every card pointing at it; the module docstring) has a
    limit and passes ``can_see_credit`` on every member; the others are left
    out. An unlinked card is a group of one.

    Rows and entries are read once for every member of every group served.
    Beside ``linked`` it builds ``held``: the held months of the cards'
    reviewed card installments through Manila's today
    (``installment_duplicates.held_occurrences``, one call; the canonical
    assignment per creator and card, whatever the caller sees), which
    ``_card_parts`` leaves out of the hold."""
    card_ids = list(dict.fromkeys(card_ids))
    if not card_ids:
        return {}
    groups = _credit_groups(db, user, card_ids)
    if not groups:
        return {}
    cards = {m.id: m for _, members in groups for m in members}
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
    # {(entry id, day): [transaction id]}: posted rows first, then by id.
    linked: Dict[tuple, List[int]] = {}
    for entry_id, when, txn_id, _ in sorted(
            fc._linked_rows(db, [e.id for e in entries], occurrence_match=True),
            key=lambda row: (not row[3], row[2])):
        linked.setdefault((entry_id, fc._naive(when).date()), []).append(txn_id)
    reviewed = [e for e in entries if fc.reviewed_card_installment(e, cards[e.account_id])]
    held = held_occurrences(db, reviewed, start.date()) if reviewed else Counter()
    forced = load_entry_overrides(db, [e.id for e in entries])
    entry_by_id = {e.id: e for e in entries}

    def view(record) -> str:
        return redactor.view(record) if redactor.access.readable(record) else LIMITED

    requested = set(card_ids)
    out = {}
    for primary, members in groups:
        money = _Converter(fx, fc._code(primary.currency))
        parts = [_card_parts(
            card, start, end, money,
            rows=[r for r in rows if _touches(r, card.id)],
            entries=[e for e in entries if e.account_id == card.id],
            linked=linked, held=held, forced=forced, entry_by_id=entry_by_id, view=view)
            for card in members]
        credit = _group_credit(primary, members, parts, start, money)
        out.update({card_id: c for card_id, c in credit.items() if card_id in requested})
    return out


def _credit_groups(db: Session, user, card_ids: List[int]) -> List[tuple]:
    """``[(primary, members)]``: the group of each of ``card_ids`` that is
    served credit, each group once. ``members`` (by id) are the primary and
    every card pointing at it, active or requested, and the group is served
    only when the primary has a limit and the caller passes
    ``can_see_credit`` on every member. One query when the cards' groups are
    all among ``card_ids`` (the managed list), two otherwise."""
    accounts = {a.id: a for a in db.query(Account).filter(or_(
        Account.id.in_(card_ids), Account.shares_limit_with_account_id.in_(card_ids))).all()}
    missing = {a.shares_limit_with_account_id for a in accounts.values()
               if a.shares_limit_with_account_id is not None
               and a.shares_limit_with_account_id not in accounts}
    if missing:
        accounts.update({a.id: a for a in db.query(Account).filter(or_(
            Account.id.in_(missing), Account.shares_limit_with_account_id.in_(missing))).all()})
    requested = set(card_ids)
    by_primary: Dict[int, List[Account]] = {}
    for a in accounts.values():
        if a.is_active or a.id in requested:
            by_primary.setdefault(a.shares_limit_with_account_id or a.id, []).append(a)
    out = []
    for primary_id in dict.fromkeys(
            accounts[i].shares_limit_with_account_id or i for i in card_ids if i in accounts):
        primary = accounts.get(primary_id)
        members = sorted(by_primary.get(primary_id, []), key=lambda a: a.id)
        if (primary is None or primary.credit_limit is None or not members
                or not all(can_see_credit(user, m) for m in members)):
            continue
        out.append((primary, members))
    return out


def _touches(txn: Transaction, card_id: int) -> bool:
    if txn.transaction_type == TransactionType.DEBIT:
        return txn.account_id == card_id
    return (txn.transfer_from_account_id or txn.account_id) == card_id \
        or txn.transfer_to_account_id == card_id


def _card_parts(card: Account, start: datetime, end: datetime, money: _Converter, *,
                rows: List[Transaction], entries: List[BudgetEntry],
                linked: Dict[tuple, List[int]], held: Counter,
                forced: Dict[int, Moved], entry_by_id: Dict[int, BudgetEntry],
                view) -> dict:
    """One card's share of its group's ``CardCredit`` (the module docstring):
    its opening components, counts, missed list, planned payments and walk
    items, which ``_group_credit`` sums and walks with the other members'.

    ``linked`` is ``{(entry id, day): [transaction id]}`` (posted rows first),
    consumed here; ``held`` is ``Counter[(entry id, day)]`` of the held months
    (``credit_for_cards``), read only; ``forced`` is each entry's forced dates.
    The streams pre-pass keeps ``(effective, nominal)`` pairs and drops each
    occurrence a linked row takes, and each held installment month: its
    possible duplicate is not added to ``replacing_ids`` and keeps its own
    placement, so the month is counted once, as that charge.
    """
    s_day, e_day = start.date(), end.date()

    balance_owed = -fc._money(card.balance or 0)
    pending_total = _ZERO
    planned_charges = _ZERO
    hold = _ZERO
    missed_total = _ZERO
    unknown = 0
    uncounted_shared = 0
    opening_uncounted = False
    # (day, phase, order, payload)
    walk: List[tuple] = []
    planned: List[dict] = []

    # --- streams: each entry's occurrences, less those a linked row takes -----
    # A taken row replaces a held installment month or a missed month (before
    # today) only there; it then counts now whatever its own date. A held
    # month (a possible duplicate stands for it) is dropped too, but its
    # charge is unlinked and keeps its own placement.
    replacing_ids: Set[int] = set()
    streams = []
    for entry in entries:
        installment = is_card_installment(entry, card)
        moved = forced.get(entry.id)
        occurrences = []
        for occ in _stream(entry, end, whole=installment, moved=moved):
            nominal = occ.date()
            day = effective(moved, nominal)
            key = (entry.id, nominal)
            taken = linked.get(key)
            if taken:
                txn_id = taken.pop(0)
                if installment or day < s_day:
                    replacing_ids.add(txn_id)
                continue
            if installment and held[key]:
                continue
            occurrences.append((day, nominal))
        streams.append((entry, installment, occurrences))

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
        placement = _placement(txn, s_day, e_day, replacing_ids)
        if placement == "beyond":
            continue
        if record_view == LIMITED:
            uncounted_shared += 1
            if placement == "now":
                opening_uncounted = True
            else:
                walk.append((day, _MARK, (0, txn.id), None))
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
            linked_kind = entry_kind(entry, card)
            if not (placement == "planned" and linked_kind == "installment"):
                kind = linked_kind or kind
        if placement == "planned":
            if figure is not None:
                planned_charges += figure
            walk.append((day, _CHARGE, (0, txn.id), {
                "source": "transaction", "source_id": txn.id, "date": day,
                "occurrence_date": None, "kind": kind, "amount": figure,
                "subtract": True}))
            continue
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
    for entry, installment, occurrences in streams:
        kind = entry_kind(entry, card)
        if view(entry) == LIMITED:
            # Left out: the opening when it holds or missed anything, else
            # every check from its first occurrence in the window.
            before = [d for d, _ in occurrences if d < s_day]
            inside = [d for d, _ in occurrences if s_day <= d < e_day]
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
            for d, nominal in occurrences:
                if s_day <= d < e_day:
                    walk.append((d, _CHARGE, (1, entry.id), {
                        "source": "budget_entry", "source_id": entry.id, "date": d,
                        "occurrence_date": nominal, "kind": "installment", "amount": each,
                        "subtract": False}))
            continue
        before = [d for d, _ in occurrences if d < s_day]
        if before:
            total = each * len(before) if each is not None else None
            if total is None:
                unknown += 1
                opening_uncounted = True
            else:
                missed_total += total
            missed.append({"entry_id": entry.id, "name": entry.name, "kind": kind,
                           "count": len(before), "total": _amount(total)})
        for d, nominal in occurrences:
            if s_day <= d < e_day:
                walk.append((d, _CHARGE, (1, entry.id), {
                    "source": "budget_entry", "source_id": entry.id, "date": d,
                    "occurrence_date": nominal, "kind": kind, "amount": each,
                    "subtract": True}))

    for _, phase, _, item in walk:
        if phase == _CHARGE:
            item["card_id"] = card.id
    return {"balance_owed": balance_owed, "pending_total": pending_total,
            "planned_charges": planned_charges, "hold": hold, "missed_total": missed_total,
            "unknown": unknown, "uncounted_shared": uncounted_shared,
            "opening_uncounted": opening_uncounted, "walk": walk, "planned": planned,
            "missed": missed}


def _group_credit(primary: Account, members: List[Account], parts: List[dict],
                  start: datetime, money: _Converter) -> Dict[int, dict]:
    """``{card id: CardCredit}`` for each member of a group (one card when it
    is unlinked): the primary's limit less every member's opening, then one
    walk over every member's items in ``(day, phase, order)`` order, so a
    charge on one card is checked after the other card's earlier charges and
    payments. Every figure is the group's; each card keeps only the checks for
    its own charges, and ``shared_with`` names the other members by name."""
    limit = fc._money(primary.credit_limit)
    s_day = start.date()

    def total(key):
        return sum((part[key] for part in parts), _ZERO)

    balance_owed, pending_total = total("balance_owed"), total("pending_total")
    hold, missed_total = total("hold"), total("missed_total")
    planned_charges = total("planned_charges")
    unknown = sum(part["unknown"] for part in parts)
    uncounted_shared = sum(part["uncounted_shared"] for part in parts)
    walk = [item for part in parts for item in part["walk"]]
    planned = [p for part in parts for p in part["planned"]]
    missed = [m for part in parts for m in part["missed"]]

    available_now = limit - (balance_owed + pending_total + hold + missed_total)

    # --- the walk ---------------------------------------------------------------
    walk.sort(key=lambda item: (item[0], item[1], item[2]))
    after = without = available_now
    uncounted = any(part["opening_uncounted"] for part in parts)
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
        if item["kind"] == "installment" and not item["subtract"]:
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
        checks.append((item["card_id"], {
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
        }))
        if figure is None and item["kind"] != "installment":
            uncounted = True

    counted = [p for p in planned if p["counted"]]
    planned.sort(key=lambda p: p["_order"])
    for p in planned:
        p.pop("_order")
    with_planned = available_now + sum((amount for _, amount in payments), _ZERO)
    by_name = sorted(members, key=lambda a: (a.name, a.id))
    return {card.id: {
        "account_id": card.id,
        "currency": money.currency,
        "limit": _amount(limit),
        "as_of": s_day.isoformat(),
        "available_now": _amount(available_now),
        "available_with_planned": _amount(with_planned),
        "planned_charges_total": _amount(planned_charges),
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
        # Each card gets its own copies of the group's lists.
        "missed": [dict(m) for m in missed],
        "planned_payments": [dict(p) for p in planned],
        "checks": [check for owner, check in checks if owner == card.id],
        "fx": money.rates(),
        "fx_buffer_pct": int(CARD_FX_BUFFER * 100),
        "shared_with": [{"account_id": m.id, "name": m.name}
                        for m in by_name if m.id != card.id],
    } for card in members}


def open_cycle(card: Account, today: date, *, due_overrides) -> Optional[dict]:
    """``{close_date, due_date, due_overridden, computed_due_date}`` of the
    cycle open on ``today`` (its close is today or later), or None for a card
    without cycle settings. ``due_overrides`` is the card's
    ``statements.load_due_overrides`` entry: ``due_date`` is the printed due
    when one was entered, ``computed_due_date`` the rolled one."""
    cycle = next(iter_cycles_from(card, today, datetime.min, through=today,
                                  due_overrides=due_overrides), None)
    if cycle is None:
        return None
    return {"close_date": cycle["close"].date().isoformat(),
            "due_date": cycle["due"].date().isoformat(),
            "due_overridden": cycle["due_overridden"],
            "computed_due_date": cycle["computed_due"].date().isoformat()}


def closed_statements(db: Session, user, card: Account, fx: Optional[FxRates],
                      viewable_ids: Optional[Iterable[int]] = None,
                      card_rows=None, due_overrides=None, *,
                      with_lines: bool = False, stored=None) -> List[dict]:
    """The card's closed statements, oldest first: ``statement_summaries`` on
    Manila's midnight over the caller's viewable accounts, kept while the close
    is before Manila's today (a statement closing today can still take
    charges). Recorded rows only, in the card's currency. The one selection
    behind the Pay dialog (``routers/cards.py: card_statements``) and the owed
    statements in the snapshot (``statements_due``).

    ``viewable_ids`` and ``card_rows`` (a ``statements._card_rows`` result
    covering the card) and ``due_overrides`` (the card's
    ``statements.load_due_overrides`` entry) let a caller walking many cards
    look them up once; by default each is read for this card.

    Figures only by default; ``with_lines`` reads ``statement_history``
    instead, so each statement also carries its ``lines`` and ``unconverted``
    (the minimum amount due needs them).

    Figures come from the stored closed statements (STU-601): ``stored`` is
    the card's ``statements_store.read_card_rows`` entry matching
    ``card_rows`` (None with every row, or when ``card_rows`` is None and the
    store is read here)."""
    today = manila_today()
    if viewable_ids is None:
        viewable_ids = viewable_account_ids(db, user)
    if with_lines:
        history = statement_history(db, card, manila_midnight(), viewable_ids, fx=fx,
                                    card_rows=card_rows, due_overrides=due_overrides)
    else:
        history = statement_summaries(db, card, manila_midnight(), viewable_ids, fx=fx,
                                      card_rows=card_rows, due_overrides=due_overrides,
                                      stored=stored)
    return [s for s in history if s["close"].date() < today]


@dataclass(frozen=True)
class UnpostedMonth:
    """One unposted installment month on a closed cycle (``unposted_months``)."""
    entry_id: int
    day: date
    close: date
    due: date
    postable: bool


def unposted_months(db: Session, card: Account, caller,
                    due_overrides=None) -> List[UnpostedMonth]:
    """The months the card's statements leave out because no recorder has run.

    Over the card's active, reviewed card installments (any creator, as
    ``statement_history`` takes every row on the card): each month of
    ``post_plan``'s ``due`` through Manila's today (no posted row stands for
    it) that has no pending linked row (that row is already on the card) and
    is not held (its possible duplicate is), on a cycle that closed before
    Manila's today (a month in the open cycle is on no closed statement), the
    cycle read on the effective date: a month forced into the open cycle is not
    on a closed one.
    One ``held_occurrences`` call (the canonical assignment). ``postable`` is
    whether the month is in ``post_plan(..., caller)``'s ``postable``: what
    the caller's Post now would record. Computed over cycles, not recorded
    statements, so it is defined on a card with no recorded statement.
    Ordered by close, day, then entry id. Counts only, never amounts; the
    callers are the managers' surfaces (``statements_due``, the credit detail).
    ``due`` is the cycle's printed due when one was entered; ``due_overrides``
    is the card's ``statements.load_due_overrides`` entry, read when None.
    """
    from app.core.access import RecordAccess
    from app.services.posting import post_plan

    today = manila_today()
    entries = [e for e in db.query(BudgetEntry).filter(
        BudgetEntry.account_id == card.id,
        BudgetEntry.is_active.is_(True),
        BudgetEntry.installment_reviewed_at.isnot(None),
    ).order_by(BudgetEntry.id).all() if is_card_installment(e, card)]
    if not entries:
        return []
    if due_overrides is None:
        due_overrides = load_due_overrides(db, [card.id])[card.id]
    held = held_occurrences(db, entries, today)
    forced = load_entry_overrides(db, [e.id for e in entries])
    pending = {(entry_id, fc._naive(when).date())
               for entry_id, when, _, is_posted in fc._linked_rows(
                   db, [e.id for e in entries], occurrence_match=True)
               if not is_posted}
    access = RecordAccess(db, caller)
    out: List[UnpostedMonth] = []
    for entry in entries:
        plan = post_plan(db, entry, caller, today, held, access)
        postable = {occ.date() for occ in plan.postable}
        for occ in plan.due:
            day = occ.date()
            if (entry.id, day) in pending or held[(entry.id, day)]:
                continue
            billed_on = effective(forced.get(entry.id), day)
            cycle = next(iter_cycles_from(card, billed_on, datetime.min, through=billed_on,
                                          due_overrides=due_overrides), None)
            if cycle is None or cycle["close"].date() >= today:
                continue
            out.append(UnpostedMonth(entry_id=entry.id, day=day, close=cycle["close"].date(),
                                     due=cycle["due"].date(), postable=day in postable))
    out.sort(key=lambda m: (m.close, m.day, m.entry_id))
    return out


def unposted_summary(months: List[UnpostedMonth]) -> Optional[dict]:
    """The credit detail's ``unposted``: ``{count, postable, oldest_close,
    oldest_due}`` over ``months``, or None when there are none."""
    if not months:
        return None
    oldest = min(months, key=lambda m: (m.close, m.due))
    return {"count": len(months), "postable": sum(1 for m in months if m.postable),
            "oldest_close": oldest.close.isoformat(), "oldest_due": oldest.due.isoformat()}


def statements_due(db: Session, user, fx: Optional[FxRates]) -> List[dict]:
    """``CardStatementDue[]``: each managed credit card (owner or admin, active,
    with or without a limit: a superset of the credit pass) with something to
    clear on its closed statements, by name.

    The owed statements are the closed statements (``closed_statements``,
    recorded rows only) that still owe, counted only while the latest one's
    ``clear_through`` is above 0. The unposted months are ``unposted_months``
    for the caller. A card is listed when either is non-empty and the oldest
    due date among them is before E (the 30-day window from Manila's
    midnight, its last day included), which an overdue one always is.

    ``clear_through`` is exactly what the Pay dialog suggests as Full, in the
    card's currency, from recorded rows only (0 with no owed statement).
    ``close_date`` and ``due_date`` are the latest closed statement's, or the
    latest unposted month's cycle when nothing is recorded.
    ``statement_count`` is the number of distinct closes among the owed
    statements and the unposted months; ``overdue`` whether an owed statement
    has the ``overdue`` status or an unposted month's due date is before
    Manila's today; ``incomplete`` whether a foreign line with no rate may
    have left ``clear_through`` low. ``unposted_installments`` and
    ``unposted_postable`` count the unposted months and those the caller's
    Post now would record. With no unposted month the row is exactly the
    recorded one.
    """
    today = manila_today()
    end = today + timedelta(days=WINDOW_DAYS + 1)
    cards = viewable_accounts(db, user, active_only=True, roles=MANAGE_ROLES).filter(
        Account.account_type == AccountType.CREDIT).all()
    # The viewable accounts and every card's rows are read once, not per card.
    viewable_ids = viewable_account_ids(db, user)
    card_rows, stored = (statements_store.read_card_rows(db, cards, viewable_ids, today)
                         if cards else (None, {}))
    overrides = load_due_overrides(db, [c.id for c in cards])
    items = []
    for card in sorted(cards, key=lambda a: (a.name, a.id)):
        closed = closed_statements(db, user, card, fx, viewable_ids=viewable_ids,
                                   card_rows=card_rows, due_overrides=overrides[card.id],
                                   stored=stored.get(card.id))
        months = unposted_months(db, card, user, due_overrides=overrides[card.id])
        latest_clear = closed[-1]["clear_through"] if closed else _ZERO
        owed = [s for s in closed if s["owed"] > 0] if latest_clear > 0 else []
        if not owed and not months:
            continue
        oldest_due = min([s["due"].date() for s in owed] + [m.due for m in months])
        if oldest_due >= end:
            continue
        if closed:
            close, due = closed[-1]["close"].date(), closed[-1]["due"].date()
        else:
            last = max(months, key=lambda m: (m.close, m.due))
            close, due = last.close, last.due
        items.append({
            "account_id": card.id,
            "name": card.name,
            "currency": fc._code(card.currency),
            "close_date": close.isoformat(),
            "due_date": due.isoformat(),
            "clear_through": _amount(max(latest_clear, _ZERO)),
            "statement_count": len({s["close"].date() for s in owed} | {m.close for m in months}),
            "oldest_due": oldest_due.isoformat(),
            "overdue": (any(s["status"] == "overdue" for s in owed)
                        or any(m.due < today for m in months)),
            "incomplete": closed[-1]["incomplete"] if closed else False,
            "unposted_installments": len(months),
            "unposted_postable": sum(1 for m in months if m.postable),
        })
    return items


def amount_due(db: Session, user, cards: List[Account], fx: Optional[FxRates]
               ) -> Dict[int, dict]:
    """``{card id: {amount_due, due_date, overdue, incomplete, unbilled}}`` for
    each of ``cards`` (credit cards the caller manages; the caller checks),
    unwindowed: the quick balances' card figures (STU-578).

    ``amount_due``, ``due_date``, ``overdue`` and ``incomplete`` are
    ``statements_due``'s recorded figures over the same selection
    (``closed_statements``): the latest closed statement's ``clear_through``
    (0 with nothing owed or no closed statement) and its due date (null with
    no closed statement), whether an owed statement is overdue, and whether a
    foreign line with no rate may have left the figure low. Unposted
    installment months are not counted. Where ``statements_due`` lists the
    card, ``amount_due`` is its ``clear_through``.

    ``unbilled`` is the charges not yet on a statement: posted line items
    (charges and cash advances less refunds, in the card's currency) whose
    ``statement_day`` is after the latest closed statement's close, or every
    posted line item with no closed statement. Payments are not netted. It is
    null on a card without cycle settings, which no statement ever bills.

    The viewable accounts and every card's rows are read once, not per card.
    """
    if not cards:
        return {}
    today = manila_today()
    ids = [c.id for c in cards]
    viewable_ids = viewable_account_ids(db, user)
    # With stored statements the rows are those placed after the stored ones:
    # every row ``unbilled`` sums is among them (it is after the latest close).
    card_rows, stored = statements_store.read_card_rows(db, cards, viewable_ids, today)
    overrides = load_due_overrides(db, ids)
    by_card, unbilled_sources = card_rows
    out = {}
    for card in cards:
        closed = closed_statements(db, user, card, fx, viewable_ids=viewable_ids,
                                   card_rows=card_rows, due_overrides=overrides[card.id],
                                   stored=stored.get(card.id))
        latest_clear = closed[-1]["clear_through"] if closed else _ZERO
        owed = [s for s in closed if s["owed"] > 0] if latest_clear > 0 else []
        unbilled = None
        if resolve_cycle_fields(card) is not None:
            last_close = closed[-1]["close"].date() if closed else None
            lines, _ = _split_card_rows(card.id, by_card.get(card.id, []), unbilled_sources)
            unbilled = sum(((-Decimal(str(line.amount))
                             if line.transaction_type == TransactionType.CREDIT
                             else Decimal(str(line.amount)))
                            for line in lines
                            if getattr(line, "is_posted", True)
                            and (last_close is None or statement_day(line, today) > last_close)),
                           _ZERO)
        out[card.id] = {
            "amount_due": _amount(max(latest_clear, _ZERO)),
            "due_date": closed[-1]["due"].date().isoformat() if closed else None,
            "overdue": any(s["status"] == "overdue" for s in owed),
            "incomplete": closed[-1]["incomplete"] if closed else False,
            "unbilled": _amount(unbilled),
        }
    return out
