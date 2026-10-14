"""The read-only cutover check (STU-204, plan v3 §2.5).

One REPEATABLE READ, READ ONLY transaction, on a connection whose sessions default
to read-only, holding the shared cutover advisory lock. The ORM Session joins it
with ``create_savepoint``, so an internal ``commit()`` can neither end the snapshot
nor write. Rates are offline only.

Every block lists its missing, extra or differing rows; nothing is absorbed. Any
failure fails the run. ``T`` is ``as_of`` at 00:00 (naive, as the columns are).
"""

from __future__ import annotations

import hashlib
import json
from contextlib import contextmanager
from datetime import date, datetime, timedelta
from decimal import Decimal
from typing import Dict, Iterator, List, Optional

from sqlalchemy import and_, create_engine, func, or_, text
from sqlalchemy.orm import Session
from sqlalchemy.pool import NullPool

from app.cutover_check.bootstrap import CUTOVER_LOCK_KEY, verify_target
from app.cutover_check.schema import Frozen, Selector
from app.cutover_check.statements import compared_set, computed_cycles
from app.models.account import Account, AccountType
from app.models.transaction import Transaction, TransactionType, transfer_sides
from app.models.user import User
from app.services.fx import FxRates

READ_ONLY_OPTIONS = "-c default_transaction_read_only=on"


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


BLOCKS: List[tuple] = [
    ("checkpoints", check_checkpoints),
    ("card_statements", check_card_statements),
    ("foreign_invariants", check_foreign),
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
    """An engine whose sessions default to read-only (code-supplied, not a URL key)."""
    return create_engine(url, poolclass=NullPool,
                         connect_args={"options": READ_ONLY_OPTIONS})


@contextmanager
def readonly_session(url, expect_db: str, expect_server_addr: str) -> Iterator[tuple]:
    """``(session, database, server address)`` inside the read-only snapshot.

    The target is verified and the shared lock taken before the Session exists;
    everything is rolled back on exit.
    """
    engine = make_engine(url)
    try:
        with engine.connect() as conn:
            conn.execution_options(isolation_level="REPEATABLE READ")
            trans = conn.begin()
            try:
                conn.exec_driver_sql("SET TRANSACTION READ ONLY")
                database, addr = verify_target(conn, expect_db, expect_server_addr)
                locked = conn.execute(text("SELECT pg_try_advisory_xact_lock_shared(:key)"),
                                      {"key": CUTOVER_LOCK_KEY}).scalar()
                if not locked:
                    raise CheckRefused("a cutover load or reset holds the lock")
                session = Session(bind=conn, join_transaction_mode="create_savepoint",
                                  autoflush=False)
                try:
                    yield session, database, addr
                finally:
                    session.close()
            finally:
                trans.rollback()
    finally:
        engine.dispose()


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
