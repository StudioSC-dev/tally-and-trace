"""The read-only cutover check (STU-204, plan v3 §2.5).

One REPEATABLE READ, READ ONLY transaction, on a connection whose sessions default
to read-only, holding the shared cutover advisory lock. The ORM Session joins it
with ``create_savepoint``, so an internal ``commit()`` can neither end the snapshot
nor write. Rates are offline only.

Every block lists its missing, extra or differing rows; nothing is absorbed. Any
failure fails the run. ``T`` is ``as_of`` at 00:00. The date columns are
``timestamptz``: they are read in the session time zone (recorded in the report)
and compared without their zone.
"""

from __future__ import annotations

import hashlib
import json
from contextlib import contextmanager
from datetime import date, datetime, timedelta
from decimal import Decimal
from itertools import islice
from typing import Dict, Iterator, List, Optional

from sqlalchemy import and_, create_engine, func, or_, text
from sqlalchemy.orm import Session
from sqlalchemy.pool import NullPool

from app.core.database import UTC_SESSION_OPTIONS
from app.cutover_check.bootstrap import CUTOVER_LOCK_KEY, verify_target
from app.cutover_check.schema import (
    Frozen, Recurring, Selector, add_months, month_of, month_start,
)
from app.cutover_check.sheet import check_sheet
from app.cutover_check.statements import compared_set, computed_cycles, naive
from app.models.account import Account, AccountType
from app.models.budget_entry import BudgetEntry, BudgetEntryType
from app.models.transaction import Transaction, TransactionType, transfer_sides
from app.models.user import User
from app.services.fx import FxRates

# Read-only by default, and on UTC like every engine (STU-315): the dates are
# timestamptz, read back in the session's zone.
READ_ONLY_OPTIONS = f"-c default_transaction_read_only=on {UTC_SESSION_OPTIONS}"


class CheckRefused(Exception):
    """The check cannot run at all (owner, lock); no block is evaluated."""


def _code(value):
    return getattr(value, "value", value)


def _money(value) -> Decimal:
    return Decimal(str(value if value is not None else 0)).quantize(Decimal("0.01"))


def _day(value) -> datetime:
    return datetime(value.year, value.month, value.day)


def _fmt(value):
    if isinstance(value, Decimal):
        return f"{value:.2f}"
    if isinstance(value, (date, datetime)):
        return value.isoformat()
    return value


def row_ref(row: Transaction) -> dict:
    """A transaction as the report names it."""
    return {"transaction_id": row.id, "date": row.transaction_date.date().isoformat(),
            "type": _code(row.transaction_type), "amount": _fmt(_money(row.amount)),
            "account_id": row.account_id, "posted": bool(row.is_posted),
            "description": row.description}


# --- Ledger balance (plan §1.6) -------------------------------------------------------------

def effect_on(row: Transaction, account_id: int) -> Decimal:
    """A posted row's effect on one account's stored balance."""
    if row.transaction_type == TransactionType.TRANSFER:
        out, received = transfer_sides(row)
        total = Decimal("0")
        if (row.transfer_from_account_id or row.account_id) == account_id:
            total -= out
        if row.transfer_to_account_id == account_id:
            total += received
        return total
    if row.account_id != account_id:
        return Decimal("0")
    amount = _money(row.amount)
    return amount if row.transaction_type == TransactionType.CREDIT else -amount


def touching(account_ids):
    """Criterion: a row touches one of the accounts (a transfer by its transfer sides)."""
    ids = list(account_ids)
    return or_(
        and_(Transaction.transaction_type != TransactionType.TRANSFER,
             Transaction.account_id.in_(ids)),
        and_(Transaction.transaction_type == TransactionType.TRANSFER,
             or_(Transaction.account_id.in_(ids),
                 Transaction.transfer_from_account_id.in_(ids),
                 Transaction.transfer_to_account_id.in_(ids))),
    )


def ledger_balance(db: Session, account: Account, boundary: datetime) -> Decimal:
    """B(account, C): the stored balance less every posted row dated at or after C,
    whoever created it (the raw ledger, never an access-scoped view)."""
    rows = db.query(Transaction).filter(
        touching([account.id]), Transaction.is_posted.is_(True),
        Transaction.transaction_date >= boundary).all()
    return _money(account.balance) - sum((effect_on(r, account.id) for r in rows), Decimal("0"))


# --- Context ----------------------------------------------------------------------------------

class Block:
    def __init__(self, name: str):
        self.name = name
        self.checked = 0
        self.failures: List[dict] = []
        self.refused: Optional[str] = None

    def fail(self, message: str, **detail) -> None:
        self.failures.append({"message": message,
                              **{k: _fmt(v) for k, v in detail.items()}})

    @property
    def status(self) -> str:
        if self.refused is not None:
            return "refused"
        return "fail" if self.failures else "pass"

    def as_dict(self) -> dict:
        out = {"name": self.name, "status": self.status, "checked": self.checked,
               "failures": self.failures}
        if self.refused is not None:
            out["refused"] = self.refused
        return out


class Context:
    def __init__(self, db: Session, frozen: Frozen, owner: User):
        self.db = db
        self.frozen = frozen
        self.owner = owner
        self.T = _day(frozen.as_of)
        self.fx = FxRates.offline(db)
        self.accounts = db.query(Account).filter(Account.user_id == owner.id).all()
        self._by_key: Dict[tuple, List[Account]] = {}
        for a in self.accounts:
            key = (a.name, _code(a.account_type), _code(a.currency))
            self._by_key.setdefault(key, []).append(a)
        self.account_ids = [a.id for a in self.accounts]
        self.posted_after = self._posted_after()
        self._entries: Optional[tuple] = None

    def _posted_after(self) -> List[Transaction]:
        if not self.account_ids:
            return []
        return db_rows(self.db.query(Transaction).filter(
            touching(self.account_ids), Transaction.is_posted.is_(True),
            Transaction.transaction_date >= self.T))

    def resolve(self, selector: Optional[Selector], block: Block, role: str):
        """The owner's one account matching ``selector`` (None stays None);
        zero or several matches is a failure in ``block`` and returns False."""
        if selector is None:
            return None
        found = self._by_key.get(selector.key(), [])
        if len(found) != 1:
            block.fail(f"{role}: selector matches {len(found)} owner accounts",
                       selector=selector.label())
            return False
        return found[0]

    def label(self, account_id: Optional[int]) -> Optional[str]:
        """An account as the report names it (any owner's, by id)."""
        if account_id is None:
            return None
        a = self.db.get(Account, account_id)
        if a is None:
            return f"account {account_id}"
        return f"{a.name} ({_code(a.account_type)}, {_code(a.currency)})"

    def owner_accounts(self, account_type: AccountType) -> List[Account]:
        return [a for a in self.accounts if a.account_type == account_type]

    def guard_refusal(self, block: Block) -> bool:
        """The posted-after guard: refuse ``block`` while posted rows exist at or after T."""
        if not self.posted_after:
            return False
        block.refused = "posted rows dated on or after as_of"
        for row in self.posted_after:
            block.fail("posted row dated on or after as_of", **row_ref(row))
        return True


def db_rows(query) -> List[Transaction]:
    return query.order_by(Transaction.transaction_date, Transaction.id).all()


# --- Blocks -----------------------------------------------------------------------------------

def check_checkpoints(ctx: Context, block: Block) -> None:
    """Check 1: B(account, C) for every listed account, exact to the centavo.
    C is ``date`` 00:00 at the start of the day, the next day's 00:00 at its end."""
    for cp in ctx.frozen.checkpoints:
        boundary = _day(cp.date) + (timedelta(days=1) if cp.point == "end_of_day"
                                    else timedelta(0))
        for bal in cp.balances:
            account = ctx.resolve(bal.account, block, f"checkpoint {cp.date} {cp.point}")
            if not account:
                continue
            block.checked += 1
            actual = ledger_balance(ctx.db, account, boundary)
            if actual != bal.amount:
                block.fail("balance differs", account=bal.account.label(), date=cp.date,
                           point=cp.point, expected=bal.amount, actual=actual,
                           difference=actual - bal.amount)


def check_card_statements(ctx: Context, block: Block) -> None:
    """Check 2: each card's compared set as of T equals the frozen statements,
    by close date, then close, due, balance and owed."""
    frozen_by_card: Dict[int, list] = {}
    for s in ctx.frozen.card_statements:
        card = ctx.resolve(s.card, block, "card statement")
        if card is False:
            continue
        if card.account_type != AccountType.CREDIT:
            block.fail("not a credit card", card=s.card.label())
            continue
        frozen_by_card.setdefault(card.id, []).append(s)
    for card in ctx.owner_accounts(AccountType.CREDIT):
        computed = {c["close"]: c for c in compared_set(
            computed_cycles(ctx.db, card, ctx.owner.id, ctx.T))}
        expected = {s.close: s for s in frozen_by_card.get(card.id, [])}
        label = f"{card.name} (credit, {_code(card.currency)})"
        for close in sorted(set(expected) - set(computed)):
            block.fail("frozen statement missing from the app", card=label, close=close)
        for close in sorted(set(computed) - set(expected)):
            c = computed[close]
            block.fail("app statement not in the frozen file", card=label, close=close,
                       due=c["due"], balance=c["balance"], owed=c["owed"])
        for close in sorted(set(computed) & set(expected)):
            block.checked += 1
            c, s = computed[close], expected[close]
            for field, want, got in (("due", s.due, c["due"]), ("balance", s.balance, c["balance"]),
                                     ("owed", s.owed, c["owed"])):
                if want != got:
                    block.fail(f"statement {field} differs", card=label, close=close,
                               expected=want, actual=got)


def check_foreign(ctx: Context, block: Block) -> None:
    """Check 7: every posted debit or credit is in its account's currency, and every
    posted cross-currency transfer has ``received_amount``."""
    if not ctx.account_ids:
        return
    currency = {a.id: _code(a.currency) for a in ctx.db.query(Account).all()}
    rows = db_rows(ctx.db.query(Transaction).filter(
        touching(ctx.account_ids), Transaction.is_posted.is_(True)))
    for row in rows:
        block.checked += 1
        if row.transaction_type == TransactionType.TRANSFER:
            src = currency.get(row.transfer_from_account_id or row.account_id)
            dst = currency.get(row.transfer_to_account_id)
            if src != dst and row.received_amount is None:
                block.fail("cross-currency transfer without received_amount", **row_ref(row))
        elif _code(row.currency) != currency.get(row.account_id):
            block.fail("posted row not in its account's currency",
                       row_currency=_code(row.currency),
                       account_currency=currency.get(row.account_id), **row_ref(row))


def _id(account) -> Optional[int]:
    return account.id if account else None


def check_card_routing(ctx: Context, block: Block) -> None:
    """Check 3: each card's payment and overflow accounts equal the frozen selectors.
    Every owner card must be listed."""
    listed = set()
    for r in ctx.frozen.card_routing:
        card = ctx.resolve(r.card, block, "card routing")
        pay = ctx.resolve(r.payment_account, block, "card routing payment account")
        overflow = ctx.resolve(r.overflow_account, block, "card routing overflow account")
        if card is False or pay is False or overflow is False:
            continue
        if card.account_type != AccountType.CREDIT:
            block.fail("not a credit card", card=r.card.label())
            continue
        listed.add(card.id)
        block.checked += 1
        for field, want, got in (("payment_account", _id(pay), card.payment_account_id),
                                 ("overflow_account", _id(overflow),
                                  card.payment_overflow_account_id)):
            if want != got:
                block.fail(f"card {field} differs", card=r.card.label(),
                           expected=ctx.label(want), actual=ctx.label(got))
    for card in ctx.owner_accounts(AccountType.CREDIT):
        if card.id not in listed:
            block.fail("owner card not in the frozen card_routing", card=ctx.label(card.id))


def _cents(value) -> Optional[Decimal]:
    return None if value is None else _money(value)


def check_loans(ctx: Context, block: Block) -> None:
    """Check 4: each loan's payer, then ``build_schedule``: owed, payments made and
    left, next due date and the first 3 upcoming rows (the split when frozen).
    Every owner loan must be listed. Refused by the posted-after guard."""
    from app.services.loans import build_schedule

    if ctx.guard_refusal(block):
        return
    listed = set()
    for x in ctx.frozen.loans:
        loan = ctx.resolve(x.loan, block, "loan")
        payer = ctx.resolve(x.payment_account, block, "loan payment account")
        if loan is False or payer is False:
            continue
        if loan.account_type != AccountType.LOAN:
            block.fail("not a loan", loan=x.loan.label())
            continue
        listed.add(loan.id)
        block.checked += 1
        name = x.loan.label()
        if _id(payer) != loan.payment_account_id:
            block.fail("loan payment_account differs", loan=name,
                       expected=ctx.label(_id(payer)), actual=ctx.label(loan.payment_account_id))
        sched = build_schedule(ctx.db, loan)
        for field, want, got in (
            ("owed", x.owed, _cents(sched["owed"])),
            ("payments_made", x.payments_made, sched["payments_made"]),
            ("payments_left", x.payments_left, sched["payments_left"]),
            ("next_due", x.next_due, sched["next_due_date"]),
        ):
            if want != got:
                block.fail(f"loan {field} differs", loan=name, expected=want, actual=got)
        upcoming = sched["upcoming"][:3]
        if len(upcoming) != len(x.next_rows):
            block.fail("loan next_rows count differs", loan=name, expected=len(x.next_rows),
                       actual=len(upcoming))
        for i, (want, got) in enumerate(zip(x.next_rows, upcoming), start=1):
            pairs = [("due_date", want.due_date, got["due_date"]),
                     ("payment", want.payment, _cents(got["payment"]))]
            for split in ("principal", "interest"):
                if getattr(want, split) is not None:
                    pairs.append((split, getattr(want, split), _cents(got[split])))
            for field, w, g in pairs:
                if w != g:
                    block.fail(f"loan next row {i} {field} differs", loan=name, expected=w,
                               actual=g)
    for loan in ctx.owner_accounts(AccountType.LOAN):
        if loan.id not in listed:
            block.fail("owner loan not in the frozen loans", loan=ctx.label(loan.id))


def match_entries(ctx: Context) -> tuple:
    """``(pairs, problems)``: each frozen entry with the one owner entry it names by
    (name, account, destination), and every resolution problem as a failure dict.
    Every owner entry must be named by exactly one frozen entry."""
    if ctx._entries is not None:
        return ctx._entries
    scratch = Block("recurring")
    owner_entries = ctx.db.query(BudgetEntry).filter(
        BudgetEntry.user_id == ctx.owner.id).order_by(BudgetEntry.id).all()
    pairs, named = [], set()
    for f in ctx.frozen.recurring:
        account = ctx.resolve(f.account, scratch, f"recurring {f.name} account")
        dest = ctx.resolve(f.destination, scratch, f"recurring {f.name} destination")
        if account is False or dest is False:
            continue
        found = [e for e in owner_entries if e.name == f.name and e.account_id == account.id
                 and e.transfer_to_account_id == _id(dest)]
        if len(found) != 1:
            scratch.fail(f"frozen entry matches {len(found)} owner entries", entry=f.label(),
                         entry_ids=[e.id for e in found])
            named.update(e.id for e in found)
            continue
        named.add(found[0].id)
        pairs.append((f, found[0]))
    for e in owner_entries:
        if e.id not in named:
            scratch.fail("owner entry not in the frozen recurring", entry_id=e.id, name=e.name,
                         account=ctx.label(e.account_id))
    ctx._entries = (pairs, scratch.failures)
    return ctx._entries


def installment_n(db: Session, entry: BudgetEntry) -> int:
    """n of an installment: linked transactions plus the offset, as
    ``_attach_occurrence_counts`` counts them (``linked_transactions``)."""
    from app.services.forecast import linked_transactions

    linked = sum(1 for entry_id, _ in linked_transactions(db, [entry.id]) if entry_id == entry.id)
    return linked + (entry.occurrences_paid_offset or 0)


def next_dates(entry: BudgetEntry, count: int) -> List[str]:
    """The entry's first ``count`` occurrence dates from ``next_occurrence`` on, walked
    by ``iter_occurrences`` (so a cap and ``end_date`` apply as in the projection)."""
    from app.services.forecast import iter_occurrences

    walk = iter_occurrences(entry, naive(entry.next_occurrence), datetime.max)
    return [d.date().isoformat() for d in islice(walk, count)]


def check_recurring(ctx: Context, block: Block) -> None:
    """Check 5: each frozen entry resolves to exactly one owner entry and every frozen
    field matches it, overflow account and autopay included; n of m for installments.
    ``day_rule`` is always compared; ``anchor_day`` and ``next_dates`` when frozen."""
    pairs, problems = match_entries(ctx)
    block.failures.extend(problems)
    for f, e in pairs:
        overflow = ctx.resolve(f.overflow_account, block, f"recurring {f.name} overflow")
        if overflow is False:
            continue
        block.checked += 1
        fields = [
            ("entry_type", f.entry_type, _code(e.entry_type)),
            ("amount", f.amount, _money(e.amount)),
            ("currency", f.currency, _code(e.currency)),
            ("cadence", f.cadence, _code(e.cadence)),
            ("next_occurrence", f.next_occurrence, naive(e.next_occurrence).date()),
            ("end_mode", f.end_mode, e.end_mode),
            ("end_date", f.end_date, naive(e.end_date).date() if e.end_date else None),
            ("max_occurrences", f.max_occurrences, e.max_occurrences),
            ("is_autopay", f.is_autopay, bool(e.is_autopay)),
            ("is_active", f.is_active, bool(e.is_active)),
        ]
        if f.semi_monthly_days is not None:
            fields.append(("semi_monthly_days", list(f.semi_monthly_days),
                           [e.semi_monthly_day_1, e.semi_monthly_day_2]))
        fields.append(("day_rule", f.day_rule, e.day_rule))
        if f.anchor_day is not None:
            fields.append(("anchor_day", f.anchor_day, e.anchor_day))
        if f.next_dates is not None:
            fields.append(("next_dates", [d.isoformat() for d in f.next_dates],
                           next_dates(e, len(f.next_dates))))
        if f.installment is not None:
            n = installment_n(ctx.db, e)
            m = n + (e.max_occurrences or 0)
            fields.append(("installment", f"{f.installment.n} of {f.installment.m}",
                           f"{n} of {m}"))
        for field, want, got in fields:
            if want != got:
                block.fail(f"recurring {field} differs", entry=f.label(), expected=want,
                           actual=got)
        if _id(overflow) != e.overflow_account_id:  # by id; labels only name it
            block.fail("recurring overflow_account differs", entry=f.label(),
                       expected=ctx.label(_id(overflow)), actual=ctx.label(e.overflow_account_id))


def row_matches(ctx: Context, row: Transaction, f: Recurring, entry: BudgetEntry) -> bool:
    """An unlinked row matches an entry: same account and type (a transfer: same
    source and destination), the same money by meaning, and the description when
    ``description_contains`` is frozen."""
    if entry.transfer_to_account_id is not None:
        if (row.transaction_type != TransactionType.TRANSFER
                or (row.transfer_from_account_id or row.account_id) != entry.account_id
                or row.transfer_to_account_id != entry.transfer_to_account_id):
            return False
    else:
        kind = (TransactionType.CREDIT if entry.entry_type == BudgetEntryType.INCOME
                else TransactionType.DEBIT)
        if row.transaction_type != kind or row.account_id != entry.account_id:
            return False
    account = ctx.db.get(Account, entry.account_id)
    dest = ctx.db.get(Account, entry.transfer_to_account_id) if entry.transfer_to_account_id \
        else None
    amount = _money(entry.amount)
    if dest is not None and dest.account_type == AccountType.LOAN:
        same = _money(row.amount) + _money(row.transfer_fee) == amount
    elif account is not None and _code(entry.currency) != _code(account.currency):
        face = ((row.projected_amount, row.projected_currency)
                if row.projected_amount is not None
                and row.projected_currency is not None
                else (row.original_amount, row.original_currency))
        same = face[0] is not None and (_money(face[0]), _code(face[1])) == (
            amount, _code(entry.currency))
    else:
        same = _money(row.amount) == amount and _code(row.currency) == _code(entry.currency)
    if not same:
        return False
    if f.description_contains:
        return f.description_contains.lower() in (row.description or "").lower()
    return True


def check_occurrences(ctx: Context, block: Block) -> None:
    """Check 6: per entry and month, linked transactions + unlinked matching
    transactions + projected occurrences = the frozen count. Projected occurrences
    are ``collect_events``' budget-entry events from T on, so months before T count
    transactions only. Every active entry must have ``next_occurrence`` on or after T."""
    from app.services.forecast import collect_events, is_spending_wallet

    pairs, _ = match_entries(ctx)
    for e in ctx.db.query(BudgetEntry).filter(BudgetEntry.user_id == ctx.owner.id,
                                              BudgetEntry.is_active.is_(True)):
        if naive(e.next_occurrence) < ctx.T:
            block.fail("active entry with next_occurrence before as_of", entry_id=e.id,
                       name=e.name, next_occurrence=naive(e.next_occurrence).date())

    unlinked = db_rows(ctx.db.query(Transaction).filter(
        Transaction.user_id == ctx.owner.id, Transaction.budget_entry_id.is_(None)))
    matched: Dict[int, List[int]] = {}
    for row in unlinked:
        hits = [e.id for f, e in pairs if row_matches(ctx, row, f, e)]
        if len(hits) > 1:
            block.fail("unlinked row matches several entries", entries=[
                f.label() for f, e in pairs if e.id in hits], **row_ref(row))
        matched[row.id] = hits

    T_month = month_of(ctx.frozen.as_of)
    last = max((m for f, _ in pairs if f.expected for m in f.expected), default=None)
    projected: Dict[tuple, int] = {}
    if last is not None and last >= T_month:
        end = _day(month_start(add_months(last, 1)))
        for ev in collect_events(ctx.db, ctx.T, end, user_id=ctx.owner.id, keep_origin=True,
                                 fx=ctx.fx):
            origin = ev.get("origin")
            if ev["source"] != "budget_entry" or not origin or origin[0] is not BudgetEntry:
                continue
            key = (origin[1], month_of(naive(ev["date"]).date()))
            projected[key] = projected.get(key, 0) + 1

    for f, e in pairs:
        account = ctx.db.get(Account, e.account_id) if e.account_id else None
        wallet = (e.transfer_to_account_id is None and account is not None
                  and is_spending_wallet(account))
        if wallet:
            if f.expected is not None:
                block.fail("refused: a wallet-funded entry is not projected; "
                           "freeze no expected for it", entry=f.label())
            continue
        if f.expected is None:
            block.fail("frozen entry has no expected counts", entry=f.label())
            continue
        linked_rows = db_rows(ctx.db.query(Transaction).filter(
            Transaction.user_id == ctx.owner.id, Transaction.budget_entry_id == e.id))
        for month, want in sorted(f.expected.items()):
            linked = [r.id for r in linked_rows
                      if month_of(naive(r.transaction_date).date()) == month]
            loose = [r.id for r in unlinked if e.id in matched.get(r.id, [])
                     and month_of(naive(r.transaction_date).date()) == month]
            proj = projected.get((e.id, month), 0)
            block.checked += 1
            if len(linked) + len(loose) + proj != want:
                block.fail("occurrence count differs", entry=f.label(), month=month,
                           expected=want, actual=len(linked) + len(loose) + proj,
                           linked_ids=linked, unlinked_ids=loose, projected=proj)


BLOCKS: List[tuple] = [
    ("checkpoints", check_checkpoints),
    ("card_statements", check_card_statements),
    ("card_routing", check_card_routing),
    ("loans", check_loans),
    ("recurring", check_recurring),
    ("occurrences", check_occurrences),
    ("foreign_invariants", check_foreign),
    ("sheet", check_sheet),
]


# --- Running ----------------------------------------------------------------------------------

def find_owner(db: Session, email: str) -> User:
    found = db.query(User).filter(func.lower(User.email) == email.strip().lower()).all()
    if len(found) != 1:
        raise CheckRefused(f"owner email matches {len(found)} users")
    return found[0]


def check_session(db: Session, frozen: Frozen,
                  blocks: Optional[List[tuple]] = None) -> dict:
    """Run every block in ``db`` (already read-only) and return the report body."""
    owner = find_owner(db, frozen.owner_email)
    ctx = Context(db, frozen, owner)
    results = []
    for name, fn in (blocks or BLOCKS):
        block = Block(name)
        fn(ctx, block)
        results.append(block)
    passed = all(b.status == "pass" for b in results)
    return {
        "overall": "pass" if passed else "fail",
        "owner_id": owner.id,
        "as_of": frozen.as_of.isoformat(),
        "posted_after": [row_ref(r) for r in ctx.posted_after],
        "blocks": [b.as_dict() for b in results],
    }


def make_engine(url):
    """An engine whose sessions default to read-only and run on UTC (code-supplied,
    not a URL key)."""
    return create_engine(url, poolclass=NullPool,
                         connect_args={"options": READ_ONLY_OPTIONS})


@contextmanager
def readonly_session(url, expect_db: str, expect_server_addr: str) -> Iterator[tuple]:
    """``(session, database, server address)`` inside the read-only snapshot.

    The target is verified and a session-level shared lock taken before the
    snapshot transaction begins, so the snapshot cannot predate the lock (it
    conflicts with a load's or reset's exclusive transaction lock on the same key).
    The snapshot must run on the backend that took the lock. Everything is rolled
    back on exit, then the lock is released; an unlock that reports false is
    refused, and an unlock failure never hides an error from inside the session.
    """
    engine = make_engine(url)
    try:
        with engine.connect() as conn:
            conn.execution_options(isolation_level="REPEATABLE READ")
            database, addr = verify_target(conn, expect_db, expect_server_addr)
            locked, pid = conn.execute(
                text("SELECT pg_try_advisory_lock_shared(:key), pg_backend_pid()"),
                {"key": CUTOVER_LOCK_KEY}).one()
            conn.commit()  # ends the probe transaction; the session-level lock stays
            if not locked:
                raise CheckRefused("a cutover load or reset holds the lock")
            try:
                trans = conn.begin()
                try:
                    if conn.execute(text("SELECT pg_backend_pid()")).scalar() != pid:
                        raise CheckRefused("the database backend changed after the lock "
                                           "was taken; connect directly, not via a pooler")
                    conn.exec_driver_sql("SET TRANSACTION READ ONLY")
                    session = Session(bind=conn, join_transaction_mode="create_savepoint",
                                      autoflush=False)
                    try:
                        yield session, database, addr
                    finally:
                        session.close()
                finally:
                    trans.rollback()
            except BaseException as exc:
                if not _release(conn):
                    note = getattr(exc, "add_note", None)  # Python 3.11+
                    if callable(note):
                        note("the shared cutover lock was not released")
                raise
            if not _release(conn):
                raise CheckRefused("the shared cutover lock was not released; no later "
                                   "load or reset can run until this backend ends")
    finally:
        engine.dispose()


def _release(conn) -> bool:
    """Release the shared lock; False when the server says it was not held or the
    unlock itself failed (the caller decides whether that is an error)."""
    try:
        released = conn.execute(text("SELECT pg_advisory_unlock_shared(:key)"),
                                {"key": CUTOVER_LOCK_KEY}).scalar()
        conn.commit()
    except Exception:
        return False
    return bool(released)


def frozen_sha256(path: str) -> str:
    with open(path, "rb") as handle:
        return hashlib.sha256(handle.read()).hexdigest()


def run(url, frozen: Frozen, *, expect_db: str, expect_server_addr: str,
        frozen_digest: Optional[str] = None,
        blocks: Optional[List[tuple]] = None) -> dict:
    """The full report: target, owner, every block, overall pass or fail."""
    with readonly_session(url, expect_db, expect_server_addr) as (db, database, addr):
        body = check_session(db, frozen, blocks)
        checked_at = db.execute(text("SELECT clock_timestamp()")).scalar()
        session_tz = db.execute(text("SHOW TimeZone")).scalar()
    return {
        "report": "cutover-check",
        "version": 1,
        "overall": body.pop("overall"),
        "owner_id": body.pop("owner_id"),
        "database": database,
        "server_addr": addr,
        "host": url.host,
        "frozen_sha256": frozen_digest,
        # Dates are read in this zone (the columns are timestamptz): the load and
        # the check must run with the same one.
        "session_timezone": session_tz,
        "checked_at": checked_at.isoformat(),
        **body,
    }


def summary_lines(report: dict) -> List[str]:
    """Stdout: check names, counts and pass or fail only."""
    lines = []
    for b in report["blocks"]:
        lines.append(f"{b['name']}: {b['status'].upper()} "
                     f"(checked {b['checked']}, failures {len(b['failures'])})")
    lines.append(f"overall: {report['overall'].upper()}")
    return lines


def dump(report: dict) -> str:
    return json.dumps(report, indent=2, sort_keys=False)
