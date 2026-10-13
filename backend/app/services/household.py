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
account of the view scope (posted, planned or recurring) that the caller can
read, so that it is among the cash the caller's Household totals count (a
payment they can't read still settles the statement, but never covers a
Household line for them), settled once in the card's currency (STU-236, plan
D4: a line in another currency is estimated at the stored rate, a pending
one from its ``pending_face``) with every other payment and credit in the
statement engine's order (``_settle_with_sources``, mirroring
``statements.build_statement_payables``): the transaction rows are balanced
and paid oldest statement first, and only then are the projected entry
charges added and paid from what is left, so a payment the rows already used
never covers a charge projected later. Recurring transfers into the card,
which the engine does not net, are applied last. A virtual overflow move is
not cash and never counts. When the card's primary payment account is in the
view scope, its routed statement payment pays whatever the statement still
owes, in the card's currency, so that counts as covered too (in the
projection). The in-scope part allocated to a statement covers its Household
lines first, in date order, capped at their total; each line's remainder is
``max(0, line - its covered part)`` and only a remainder above 0 is
returned, as the occurrence's ``face_amount``. Any other occurrence (a
wallet, a bank, a card without cycle settings, a refund, a transfer, or an
accountless entry) is returned at its face amount, in the record's currency.

**Which currency a covered line is counted in.** When the caller can view
the card or reads the record in full, the card's currency, at the card
figure's remainder. Otherwise (a Limited record) the record's currency, as
its Limited value shows it, at ``face x remainder / card figure``: the face
when nothing is covered and today's figure for a same-currency line, so no
rate or converted figure is disclosed.

``recorded`` picks the data: posted charges against posted payments (a
recorded month), or every row plus projected entry charges against posted,
planned and recurring payments plus the routed payment (the projection).

**The projection's horizon is the statement's, never the request's.** A
line's projected cover counts the recurring payments and projected entry
charges from the projection's first day (today) through the due date of the
statement holding the line (plus one day), whatever range, window or
dashboard asks for it, so a month's figure, the dashboard and Upcoming
agree. A payment counted there is the joint outflow of its own month when
that month is in range, and otherwise still covers.

**A posted charge on an open statement is left to the projection.** In a
recorded month, a posted Household charge whose statement the posted
payments have not settled is covered as the projection covers it: by the
posted, planned and recurring in-scope cash payments and the routed payment,
over the projection's horizon (above), from today (``projection_start``).
Those planned payments are counted as joint outflow by the projection, so
the charge is counted once: the joint outflow plus its remainder is the
charge, across the recorded and projected months together. A statement the
posted payments settled keeps the posted-only rule, and so does one past due
with no further planned payment (the projection then adds nothing in scope;
a routed overdue statement is still projected, from the joint account, and
so still covers).
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timedelta
from decimal import Decimal
from typing import Dict, Iterable, List, Optional, Tuple

from sqlalchemy.orm import Session

from app.core.access import (
    VIEW_ROLES, HouseholdGrant, account_role, household_explicit_criterion, touches_none,
)
from app.models.account import Account, AccountType
from app.models.budget_entry import BudgetEntry, BudgetEntryType
from app.models.transaction import Transaction, TransactionType, pending_face
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
    currency: Optional[str] = None  # the remainder's (module docstring); the record's by default
    # FX state, for a full row only (plan B5, G): ``estimate`` is
    # ``{original_amount, original_currency, rate}`` when the remainder is in
    # the card's currency estimated from a foreign face; ``unconverted`` when
    # that face has no stored rate (the remainder then stays the face).
    estimate: Optional[dict] = None
    unconverted: bool = False

    def __post_init__(self):
        if self.currency is None:
            self.currency = _currency(self.record.currency)


def _money(value) -> Decimal:
    return Decimal(str(value or 0)).quantize(Decimal("0.01"))


def _naive(dt: datetime) -> datetime:
    return dt.replace(tzinfo=None) if dt.tzinfo else dt


def household_occurrences(db: Session, grant: HouseholdGrant, scope: Iterable[Account],
                          start: datetime, end: datetime, *, recorded: bool,
                          viewable_ids: Iterable[int], access,
                          projection_start: Optional[datetime] = None, fx=None
                          ) -> List[Occurrence]:
    """The Household occurrences of ``grant``'s sharer in ``[start, end)`` (module docstring).

    ``scope`` is the Household view scope (``household_accounts``). Projected
    (``recorded`` False): unposted transactions dated before ``end`` (one
    dated before ``start`` is listed at ``start``, overdue) and active
    recurring entries' occurrences in the window. Recorded: posted
    transactions dated in the window. ``viewable_ids`` are the caller's
    viewable accounts (``statements._card_rows``); ``access`` is the caller's
    ``RecordAccess``: only a payment it reads covers a line.
    ``projection_start`` (recorded only) is the day the projection starts
    (today): a posted charge on a statement the posted payments have not
    settled is covered as the projection covers it, from then through that
    statement's due date (module docstring); without it, posted payments
    only. A projected line's cover runs from ``start`` through its
    statement's due date, whatever ``end`` is. ``fx`` holds the request's
    stored rates (offline ones when None).
    """
    from app.core.redaction import LIMITED, Redactor
    from app.services.forecast import (
        Money, _billed_card_occurrences, _linked_occurrence_days, iter_occurrences,
    )

    start, end = _naive(start), _naive(end)
    money = Money(db, fx)
    viewable_ids = set(viewable_ids)
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
    redactor = Redactor(db, access.uid, access)
    estimates: Dict[int, dict] = {}  # id(occurrence) -> its card line's estimate

    def in_card_currency(occ: Occurrence, card: Account) -> bool:
        """The caller views the card or reads the record in full (module docstring)."""
        return card.id in viewable_ids or redactor.view(occ.record) != LIMITED

    def card_fx(occ: Occurrence, card: Account, face, face_currency) -> bool:
        """A card line's FX state; False when its face has no stored rate.

        Such a line is on no statement. Read in the card's currency it is
        listed unconverted (no figure, in no total); otherwise (Limited) it
        keeps its face in the record's currency, as every Limited occurrence
        does. An estimate is kept for the cover loop below, which shows it
        only once the occurrence is in the card's currency.
        """
        figure, estimate = money.to(face, face_currency, card.currency)
        if figure is None:
            if in_card_currency(occ, card):
                occ.currency, occ.unconverted, occ.estimate = (
                    _currency(card.currency), True, estimate)
            return False
        if estimate is not None:
            estimates[id(occ)] = estimate
        return True

    for txn in txns:
        when = _naive(txn.transaction_date)
        extra = {}
        if not recorded and when < start:
            when, extra = start, {"overdue": True, "original_date": when}
        occ = Occurrence(when, txn, _money(txn.amount), _money(txn.amount), extra)
        out.append(occ)
        if txn.transaction_type == TransactionType.DEBIT and txn.account_id in billed:
            face, face_currency = (pending_face(txn) if not txn.is_posted
                                   else (txn.amount, billed[txn.account_id].currency))
            if card_fx(occ, billed[txn.account_id], face, face_currency):
                card_lines.setdefault(txn.account_id, []).append((occ, ("t", txn.id)))

    linked = _linked_occurrence_days(db, [e.id for e in entries])
    for entry in entries:
        if entry.account_id in billed and entry.transfer_to_account_id is None:
            card = billed[entry.account_id]
            for _, when in _billed_card_occurrences(db, [entry], billed, start, end):
                if when < start:
                    continue  # billed on its statement, but not listed: before the window
                occ = Occurrence(when, entry, _money(entry.amount), _money(entry.amount))
                out.append(occ)
                if (card_fx(occ, card, entry.amount, entry.currency)
                        and entry.entry_type == BudgetEntryType.EXPENSE):
                    card_lines.setdefault(entry.account_id, []).append(
                        (occ, ("e", entry.id, when)))
            continue
        for when in iter_occurrences(entry, start, end):
            key = (entry.id, when.date())
            if linked[key]:
                linked[key] -= 1
                continue
            out.append(Occurrence(when, entry, _money(entry.amount), _money(entry.amount)))

    for card_id, lines in card_lines.items():
        card = billed[card_id]
        covered = _card_household_cover(db, card, cash_ids, start, end,
                                        recorded=recorded, viewable_ids=viewable_ids,
                                        readable=access.readable, money=money)
        # Projected cover, per statement: from the projection's first day through
        # that statement's due date, whatever the requested range (module
        # docstring). In a recorded month only for a statement still open.
        begin = start if not recorded else (
            _naive(projection_start) if projection_start is not None else None)
        by_due: Dict[datetime, dict] = {}
        if begin is not None:
            for _, key in lines:
                if key not in covered or (recorded and not covered[key][1]):
                    continue
                due = covered[key][2]
                if due not in by_due:
                    horizon = max(begin, _naive(due) + timedelta(days=1))
                    by_due[due] = _card_household_cover(
                        db, card, cash_ids, begin, horizon, recorded=False,
                        viewable_ids=viewable_ids, readable=access.readable, money=money)
        for occ, key in lines:
            if key not in covered:
                continue  # no statement holds it: its face, in the record's currency
            remainder, _, due, figure = covered[key]
            if key in by_due.get(due, {}):
                remainder, _, _, figure = by_due[due][key]
            if in_card_currency(occ, card):
                occ.currency, occ.remainder = _currency(card.currency), remainder
                occ.estimate = estimates.get(id(occ))
            elif figure:
                occ.remainder = _money(occ.face * remainder / figure)
    return [o for o in out if o.remainder > 0]


def _card_household_cover(db: Session, card: Account, cash_ids: set, start: datetime,
                          end: datetime, *, recorded: bool, viewable_ids: Iterable[int],
                          readable, money=None
                          ) -> Dict[tuple, Tuple[Decimal, bool, datetime, Decimal]]:
    """``{line key: (remainder, open, due, figure)}`` for every Household line
    on ``card`` (module docstring), in the card's currency: ``figure`` is the
    line in the card's currency and ``remainder`` what in-scope payments leave
    of it; ``open`` is True when the line's statement still owes something
    after the payments counted, and ``due`` is that statement's due date.

    Line keys are ``("t", transaction id)`` and ``("e", entry id, occurrence)``;
    a line whose key is missing has no statement (remainder = face). The card's
    rows are read and split as the statement engine reads them (``_card_rows``,
    ``_split_card_rows``, with ``viewable_ids`` the caller's viewable accounts)
    and settled in its order (``_settle_with_sources``). A payment is in scope
    when it comes from a cash account of ``cash_ids`` and ``readable`` (the
    caller's read rule) accepts its record. Everything is settled once, in
    the card's currency (plan D4): a pending line's figure is its
    ``pending_face`` estimated at the stored rate (``statements.normalise_lines``;
    one with no stored rate is left out), a projected entry charge is the
    entry's amount estimated likewise, and a recurring transfer into the card
    its amount estimated into the card's currency. ``money`` holds the stored
    rates (``forecast.Money``).
    """
    from app.services.forecast import (
        Money, _card_entry_charges, _linked_occurrence_days, iter_occurrences,
    )
    from app.services.statements import _card_rows, _split_card_rows, normalise_lines

    by_card, unbilled = _card_rows(db, [card.id], viewable_ids)
    rows = by_card.get(card.id, [])
    if recorded:
        rows = [r for r in rows if r.is_posted]
    lines, payments = _split_card_rows(card.id, rows, unbilled, payment_sources=True)
    money = money or Money(db)
    card_currency = _currency(card.currency)
    lines, amount_of, _, _ = normalise_lines(db, card, lines, money.fx)
    household_txns = _household_ids(db, Transaction, [r.id for r in rows], card.user_id)
    keys: Dict[int, tuple] = {}  # id(line) -> line key
    for line in lines:
        if (isinstance(line, Transaction) and line.transaction_type == TransactionType.DEBIT
                and line.id in household_txns):
            keys[id(line)] = ("t", line.id)

    projected: list = []
    recurring: List[Tuple[datetime, Decimal, bool]] = []
    if not recorded:
        entries = db.query(BudgetEntry).filter(
            BudgetEntry.account_id == card.id, BudgetEntry.is_active.is_(True),
            BudgetEntry.transfer_to_account_id.is_(None)).all()
        household_entries = _household_ids(db, BudgetEntry, [e.id for e in entries],
                                           card.user_id)
        for entry in entries:
            for line in _card_entry_charges(db, [entry], {card.id: card}, start, end,
                                            None, money=money).get(card.id, []):
                projected.append(line)
                if (entry.id in household_entries
                        and entry.entry_type != BudgetEntryType.INCOME):
                    keys[id(line)] = ("e", entry.id, line.transaction_date)
        # Recurring transfers into the card: payments on their occurrences.
        transfers = db.query(BudgetEntry).filter(
            BudgetEntry.transfer_to_account_id == card.id,
            BudgetEntry.is_active.is_(True)).all()
        linked = _linked_occurrence_days(db, [e.id for e in transfers])
        for entry in transfers:
            for when in iter_occurrences(entry, start, end):
                key = (entry.id, when.date())
                if linked[key]:
                    linked[key] -= 1
                    continue
                amount, _ = money.to(entry.amount, entry.currency, card_currency)
                if amount is not None:
                    recurring.append((when, amount,
                                      entry.account_id in cash_ids and readable(entry)))

    if not keys:
        return {}
    days = [line.transaction_date.date() for line in [*lines, *projected]]
    cycles = list(iter_cycles_from(card, min(days), datetime.min, through=max(days)))
    paying = [(when, amount, src in cash_ids and readable(row))
              for when, amount, src, row in payments]
    owed, in_scope = _settle_with_sources(cycles, lines, paying, projected, recurring,
                                          amount_of=amount_of)
    # Projected only: in a recorded month only posted payments cover anything.
    routed = not recorded and card.payment_account_id in cash_ids

    out: Dict[tuple, Tuple[Decimal, bool, datetime, Decimal]] = {}
    for idx, c in enumerate(cycles):
        cover = in_scope[idx] + (owed[idx] if routed else ZERO)
        lo, hi = c["window_start"].date(), c["close"].date()
        household = sorted(((line.transaction_date, _money(amount_of(line)), keys[id(line)])
                            for line in [*lines, *projected]
                            if id(line) in keys and lo < line.transaction_date.date() <= hi),
                           key=lambda line: (line[0].date(), str(line[2])))
        for _, amt, key in household:
            part = min(cover, amt)
            cover -= part
            out[key] = (amt - part, owed[idx] > 0, c["due"], amt)
    return out


def _currency(value) -> str:
    return getattr(value, "value", value)


def _settle_with_sources(cycles: List[dict], lines: list,
                         payments: List[Tuple[datetime, Decimal, bool]], projected: list,
                         recurring: List[Tuple[datetime, Decimal, bool]] = (),
                         amount_of=None) -> Tuple[List[Decimal], List[Decimal]]:
    """``(owed, in_scope)`` per cycle: the statement engine's settlement, by payment source.

    The same sequence as ``statements.build_statement_payables``: the
    transaction rows (``lines``) are balanced per cycle and every payment into
    the card and every net credit is allocated oldest statement first
    (``allocate_payments``); the projected entry charges are then added and
    what the pool left unspent pays outstanding cycles oldest first, and each
    projected credit pays from the first statement due on or after its date
    (``settle_projected``). ``owed`` is what each cycle still owes, exactly
    as the engine computes it. ``in_scope`` is the part of each cycle paid by
    a payment flagged True (an in-scope cash payment); credits are never in
    scope. Recurring transfers into the card, which the engine does not net,
    are applied last, in date order, oldest statement first. ``amount_of``
    reads a line's figure in the card's currency (``normalise_lines``).
    """
    from app.services.statements import _row_amount, statement_balance

    amount_of = amount_of or _row_amount
    balances = [statement_balance(lines, c["window_start"], c["close"], amount_of)
                for c in cycles]
    owed = [max(b, ZERO) for b in balances]
    in_scope = [ZERO] * len(cycles)

    def spend(amount: Decimal, flag: bool, i: int) -> Tuple[Decimal, int]:
        while amount > 0 and i < len(owed):
            paid = min(amount, owed[i])
            owed[i] -= paid
            amount -= paid
            if flag:
                in_scope[i] += paid
            if owed[i] == 0:
                i += 1
        return amount, i

    # allocate_payments: payments in date order, then the net credits.
    pool = [(amount, flag) for _, amount, flag in sorted(payments, key=lambda p: p[0].date())]
    pool += [(-b, False) for b in balances if b < 0]
    unspent: List[Tuple[Decimal, bool]] = []
    i = 0
    for amount, flag in pool:
        left, i = spend(amount, flag, i)
        if left > 0:
            unspent.append((left, flag))

    # settle_projected: projected charges, then the unspent pool, then projected credits.
    credits = []
    for row in projected:
        day = row.transaction_date.date()
        if row.transaction_type == TransactionType.CREDIT:
            credits.append((day, Decimal(str(row.amount))))
        elif row.transaction_type == TransactionType.DEBIT:
            for idx, c in enumerate(cycles):
                if c["window_start"].date() < day <= c["close"].date():
                    owed[idx] += Decimal(str(row.amount))
                    break
    for amount, flag in unspent:
        _spend_from(owed, in_scope, amount, flag, 0)
    for day, amount in sorted(credits, key=lambda c: c[0]):
        first = next((idx for idx, c in enumerate(cycles) if c["due"].date() >= day),
                     len(cycles))
        _spend_from(owed, in_scope, amount, False, first)
    for _, amount, flag in sorted(recurring, key=lambda p: p[0]):
        _spend_from(owed, in_scope, amount, flag, 0)
    return owed, in_scope


def _spend_from(owed: List[Decimal], in_scope: List[Decimal], amount: Decimal, flag: bool,
               i: int) -> None:
    """``settle_projected``'s ``spend``: pay outstanding cycles from ``i`` on, in order."""
    while amount > 0 and i < len(owed):
        paid = min(amount, owed[i])
        owed[i] -= paid
        amount -= paid
        if flag:
            in_scope[i] += paid
        i += 1


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


# ---------------------------------------------------------------------------
# Household views (``routers/household.py``): one sharer at a time.
# ---------------------------------------------------------------------------

def household_view(db: Session, user, sharer_id: int) -> Optional[HouseholdGrant]:
    """The grant behind the caller's Household view of ``sharer_id``, or None.

    ``sharer_id`` is the caller themselves for their own Household view (their
    own Household-tagged accounts), otherwise a sharer whose Household tag
    share they hold. Anyone else: None (the routes answer 404).
    """
    from app.core.access import household_grants, own_household_grant

    uid = _uid(user)
    if sharer_id == uid:
        return own_household_grant(db, uid)
    return next((g for g in household_grants(db, uid) if g.sharer_id == sharer_id), None)


def household_events(db: Session, user, grant: HouseholdGrant, start: datetime, end: datetime,
                     *, keep_origin: bool = False, fx=None) -> List[dict]:
    """``collect_events`` in Household mode: the Household view of ``grant``'s
    sharer, with the per-currency detail (``collect_events(detail=True)``)."""
    from app.services.forecast import collect_events

    return collect_events(db, start, end, user_id=_uid(user),
                          accounts=household_accounts(db, user, grant), household=grant,
                          keep_origin=keep_origin, fx=fx, detail=True)


def household_upcoming(db: Session, user, grant: HouseholdGrant, start: datetime,
                       end: datetime, fx=None) -> List[dict]:
    """The Household view's upcoming items (``forecast.currency_upcoming_items``).

    Each full item carries its ``currency`` (its listing row's: the cash
    leg's, or the in-scope account's) and, when estimated, the B5 labels, as
    in ``/forecast/upcoming``; a limited one keeps its own ``currency``.
    """
    from app.services.forecast import currency_upcoming_items

    return currency_upcoming_items(household_events(db, user, grant, start, end, fx=fx))


def household_transactions_criterion(db: Session, user, grant: HouseholdGrant,
                                     scope_ids: Iterable[int]):
    """Criterion: the transactions in the Household view: readable by the
    caller (§1) and touching a scope account, or the sharer's Household
    occurrences (rule (c) records outside the scope). Never the caller's own
    private records."""
    from sqlalchemy import and_, or_

    from app.core.access import (
        household_grants, readable_criterion, touches_accounts, viewable_account_ids,
    )

    uid = _uid(user)
    readable = readable_criterion(Transaction, uid, viewable_account_ids(db, uid),
                                  household_grants(db, uid))
    return and_(readable, or_(touches_accounts(Transaction, list(scope_ids)),
                              household_explicit_criterion(Transaction, grant)))


MONTH_FIELDS = ("income", "expense", "fees", "moved_in", "moved_out", "paid_from_other_accounts")
LIABILITIES = (AccountType.CREDIT, AccountType.LOAN)


def _month_key(when) -> str:
    return f"{when.year:04d}-{when.month:02d}"


def _next_month(day: datetime) -> datetime:
    return day.replace(year=day.year + day.month // 12, month=day.month % 12 + 1, day=1)


def household_monthly(db: Session, user, grant: HouseholdGrant, first: datetime, last: datetime,
                      reference: Optional[datetime] = None, fx=None) -> List[dict]:
    """Monthly totals of ``grant``'s Household view, per currency, never added
    across currencies.

    ``first`` and ``last`` are month starts (inclusive). Recorded months (and
    the current month up to today) come from posted transactions; the current
    month from today and later months from the projection (``household_events``).

    Per month and currency (STU-236, plan D4): each leg's account currency,
    an inbound cross-currency transfer at its ``in`` figure (the stored
    ``received_amount``, or a projected one's estimate); a projected event's
    cash per currency; an occurrence's currency (module docstring). ``fx``
    holds the request's stored rates (offline ones when None):

    - ``income`` / ``expense``: credits and debits on scope cash accounts,
      projected statement and loan payables from them, transfers between a
      scope cash account and a liability (a card or loan, in scope or not) or
      a scope non-cash account (a spending wallet);
    - ``fees``: transfer fees paid from a scope cash account, except on a
      payment into a loan or card the caller can't view: that payment is one
      whole ``expense`` (principal and interest), as its Limited transaction
      shows it, so no interest is revealed;
    - ``moved_in`` / ``moved_out``: transfers between a scope cash account and
      a non-liability account outside the scope (the viewer's own deposit from
      their private account is "Moved in");
    - ``paid_from_other_accounts``: the remainders of the sharer's Household
      expense occurrences outside the scope (see the module docstring). A
      posted charge on a statement not yet settled is left to the projection:
      it is covered by the planned and routed in-scope payments the
      projection counts as expense, so it is counted once.

    Transfers between two scope cash accounts in one currency count only
    their fee; across currencies they also count the money moved
    (``moved_out`` and ``moved_in``, each in its own currency). A card
    charge in scope counts when the card is paid, not when it is made.
    """
    from app.core.access import household_grants, readable_criterion, touches_accounts
    from app.core.access import viewable_account_ids
    from app.core.redaction import Redactor
    from app.core.time import naive_utc_now
    from app.services.forecast import is_projection_cash

    uid = _uid(user)
    now = reference or naive_utc_now()
    today = now.replace(hour=0, minute=0, second=0, microsecond=0)
    current = today.replace(day=1)
    end = _next_month(last)

    scope = household_accounts(db, user, grant)
    scope_ids = {a.id for a in scope}
    cash_ids = {a.id for a in scope if is_projection_cash(a)}
    totals: Dict[Tuple[str, str], Dict[str, Decimal]] = {}

    def add(when, currency, field_name: str, amount) -> None:
        amount = _money(amount)
        if not amount:
            return
        key = (_month_key(when), getattr(currency, "value", currency))
        row = totals.setdefault(key, dict.fromkeys(MONTH_FIELDS, ZERO))
        row[field_name] += amount

    types: Dict[int, AccountType] = {}

    def liability(account_id) -> bool:
        if account_id is None:
            return False
        if account_id not in types:
            account = db.get(Account, account_id)
            types[account_id] = account.account_type if account else None
        return types[account_id] in LIABILITIES

    redactor = Redactor(db, uid)

    def currency_of(account_id, fallback):
        account = db.get(Account, account_id) if account_id is not None else None
        return account.currency if account is not None else fallback

    def transfer(when, currency, src, dst, amount, fee, received) -> None:
        """One transfer's legs, each in its scope account's currency.

        ``amount`` and ``fee`` are the source leg's figures in the source's
        currency, ``received`` the inbound leg's in the destination's (a
        cross-currency transfer's ``in``). A figure of None is a leg with no
        stored rate (unconverted): it is left out.

        Between two scope cash accounts in one currency only the fee counts;
        in different currencies the money moved counts too, ``moved_out`` of
        what was sent in the source's currency and ``moved_in`` of what
        arrived in the destination's (plan C3, D4).
        """
        src_in, dst_in = src in cash_ids, dst in cash_ids
        if src_in:
            currency = currency_of(src, currency)
        if src_in and not dst_in and liability(dst) and not redactor.can_view(dst):
            # Into a loan or card the caller can't view: one whole expense, as
            # its Limited transaction shows it (no fee, so no interest shown).
            if amount is not None:
                add(when, currency, "expense", _money(amount) + _money(fee))
            return
        if src_in and amount is not None:
            add(when, currency, "fees", fee)
        if src_in and dst_in:
            destination = currency_of(dst, currency)
            if _currency(destination) != _currency(currency):
                if amount is not None:
                    add(when, currency, "moved_out", amount)
                if received is not None:
                    add(when, destination, "moved_in", received)
        elif src_in:
            spent = dst in scope_ids or liability(dst)
            if amount is not None:
                add(when, currency, "expense" if spent else "moved_out", amount)
        elif dst_in:
            earned = src in scope_ids or liability(src)
            if received is not None:
                add(when, currency_of(dst, currency), "income" if earned else "moved_in",
                    received)

    access = redactor.access
    # Recorded: posted transactions in the months up to and including the current one.
    recorded_end = min(end, _next_month(current))
    if first < recorded_end and scope_ids:
        posted = db.query(Transaction).filter(
            readable_criterion(Transaction, uid, viewable_account_ids(db, uid),
                               household_grants(db, uid)),
            touches_accounts(Transaction, list(scope_ids)),
            Transaction.is_posted.is_(True),
            Transaction.transaction_date >= first,
            Transaction.transaction_date < recorded_end,
        ).all()
        for t in posted:
            if not access.readable(t):
                continue
            when = _naive(t.transaction_date)
            if t.transaction_type == TransactionType.TRANSFER:
                # Posted: the stored figures (``transfer_sides``: null received is ``amount``).
                transfer(when, t.currency, t.transfer_from_account_id or t.account_id,
                         t.transfer_to_account_id, t.amount, t.transfer_fee,
                         t.received_amount if t.received_amount is not None else t.amount)
            elif t.account_id in cash_ids:
                add(when, currency_of(t.account_id, t.currency),
                    "income" if t.transaction_type == TransactionType.CREDIT else "expense",
                    t.amount)
    if first < recorded_end:
        for occ in household_occurrences(db, grant, scope, first, recorded_end, recorded=True,
                                         viewable_ids=viewable_account_ids(
                                             db, uid, roles=VIEW_ROLES),
                                         access=access, projection_start=today, fx=fx):
            if occ.record.transaction_type == TransactionType.DEBIT and not occ.unconverted:
                add(occ.date, occ.currency, "paid_from_other_accounts", occ.remainder)

    # Projected: from today to the end of the last month.
    if end > today:
        for e in household_events(db, user, grant, today, end, keep_origin=True, fx=fx):
            when = _naive(e["date"])
            if when < first:
                continue
            model, record_id = e["origin"]
            source = db.get(model, record_id)
            if e.get("household_occurrence"):
                # An unconverted occurrence (no figure in its row) is in no total.
                if (e["type"] in (TransactionType.DEBIT.value, BudgetEntryType.EXPENSE.value)
                        and e["rows"][0]["amount"] is not None):
                    add(when, e["rows"][0]["currency"], "paid_from_other_accounts",
                        e["face_amount"])
                continue
            if not e["counts_as_cash"]:
                continue
            if e["type"] == TransactionType.TRANSFER.value and model is not Account:
                if model is Transaction:
                    src, dst = (source.transfer_from_account_id or source.account_id,
                                source.transfer_to_account_id)
                else:
                    src, dst = source.account_id, source.transfer_to_account_id
                # Each leg's own figure, in its account's currency (plan B7): the
                # source leg is ``-(amount + fee)`` (estimated into the source's
                # currency for a legacy face), its first listing row the amount
                # sent; the inbound leg is the stored ``received_amount`` or the
                # estimate. A leg missing for want of a rate is left out.
                out = next((-leg["amount"] for leg in e["legs"] if leg["account_id"] == src),
                           None)
                sent = e["rows"][0]["amount"] if out is not None else None
                received = next((leg["amount"] for leg in e["legs"]
                                 if leg["account_id"] == dst), None)
                transfer(when, source.currency, src, dst, sent,
                         out - sent if sent is not None else None, received)
                continue
            for currency, amount in e["cash_by_currency"].items():
                add(when, currency, "income" if amount > 0 else "expense", abs(amount))

    months = []
    day = first
    while day < end:
        key = _month_key(day)
        kind = "recorded" if day < current else "current" if day == current else "projected"
        currencies = [
            {"currency": currency, **{k: float(v) for k, v in row.items()}}
            for (month, currency), row in sorted(totals.items()) if month == key
        ]
        months.append({"month": key, "kind": kind, "currencies": currencies})
        day = _next_month(day)
    return months
