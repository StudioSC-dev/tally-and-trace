"""Load a validated cutover input into the owner's account (plan v3, section 2.2).

One outer ``conn.begin()`` holds the whole run, and the Session joins it with
``join_transaction_mode="create_savepoint"``: every ``commit()`` inside a
router releases a savepoint, and the outer transaction decides the outcome.
The order is the plan's:

1. verify the target (``current_database()``, ``inet_server_addr()``);
2. ``pg_try_advisory_xact_lock``: a second run is refused, never queued;
3. the alembic head, the owner (found by email, never created), the
   Household tag (looked up, never ensured), the pre-load guard and full
   validation;
4. write through the app's own write paths, called in-process with the
   owner: categories, custom tags, cash accounts at their computed openings,
   cards (opening 0) and loans (opening ``balance_at_cutover``) with routing
   set by ``update_account`` once the targets exist, recurring entries, then
   transactions in (date, key) order through ``add_transaction``;
5. assert inside the transaction: each account's ledger balance at the
   cutover equals ``balance_at_cutover``, and each card's compared set
   equals ``statements_at_cutover``;
6. a dry run writes the review report and rolls back; a real run writes the
   run record as ``prepared``, commits, reads ``finished_at`` from the
   database clock and marks the record ``complete``.

Any refusal or write error aborts the whole run; the terminal shows only the
check name and the input key, and the details go to the report file.
"""

import hashlib
import os
import subprocess
from datetime import datetime, timezone
from decimal import Decimal
from typing import Callable, Dict, List, Optional

from fastapi import HTTPException
from pydantic import ValidationError
from sqlalchemy import create_engine, func, select, text
from sqlalchemy.orm import Session
from sqlalchemy.pool import NullPool

from app.core.access import touches_accounts, viewable_account_ids
from app.core.seed import DEMO_EMAILS
from app.cutover_load.bootstrap import CUTOVER_LOCK_KEY, Refused, check_target, observe_target
from app.cutover_load.outputs import create_private, replace_private, repo_root, to_json
from app.cutover_load.schema import parse_input
from app.cutover_load.validate import (
    InputInvalid, LoadPlan, Problem, card_cycles, day_start, is_card, is_loan, validate_input,
)
from app.models.account import Account, AccountType
from app.models.account_share import AccountShare
from app.models.allocation import Allocation
from app.models.budget_entry import BudgetEntry
from app.models.category import Category, CategoryKind
from app.models.tag import HOUSEHOLD_TAG_NAME, Tag, account_tags, budget_entry_tags, \
    transaction_tags
from app.models.tag_share import TagShare
from app.models.transaction import Transaction, TransactionType, transfer_sides
from app.models.user import User
from app.models.wishlist_item import WishlistItem
from app.routers.accounts import create_account, update_account
from app.routers.budget_entries import _attach_occurrence_counts, create_budget_entry
from app.routers.categories import create_category
from app.routers.tags import create_tag
from app.routers.transactions import add_transaction
from app.schemas.account import AccountCreate, AccountUpdate
from app.schemas.budget_entry import BudgetEntryCreate
from app.schemas.category import CategoryCreate
from app.schemas.tag import TagCreate
from app.schemas.transaction import TransactionCreate
from app.services.loans import build_schedule

BACKEND = os.path.dirname(os.path.dirname(os.path.dirname(os.path.realpath(__file__))))
OWNED_TABLES = (Account, Transaction, BudgetEntry, Category, Allocation, WishlistItem)
LINKS = ((account_tags, "account_id", Account), (transaction_tags, "transaction_id", Transaction),
         (budget_entry_tags, "budget_entry_id", BudgetEntry))


class CutoverError(Exception):
    """A refusal or failure: ``check`` and ``key`` reach the terminal, ``detail`` the report."""

    def __init__(self, check: str, key: str, detail: str):
        super().__init__(f"{check} [{key}]: {detail}")
        self.check, self.key, self.detail = check, key, detail


# --- Owner, Household tag, alembic head, guard --------------------------------------------

def find_owner(db: Session, email: str) -> User:
    """The owner by email, refused when missing, ambiguous by case, inactive,
    unverified or a demo user (as ``routers/shares._match`` matches)."""
    wanted = email.strip().lower()
    users = db.query(User).filter(func.lower(User.email) == wanted).limit(2).all()
    if not users:
        raise CutoverError("owner", "owner_email", "no user has this email")
    if len(users) > 1:
        raise CutoverError("owner", "owner_email",
                           "two users differ from this email only by case")
    user = users[0]
    if wanted in DEMO_EMAILS:
        raise CutoverError("owner", "owner_email", "the owner is a demo user")
    if not user.is_active:
        raise CutoverError("owner", "owner_email", "the owner is inactive")
    if not user.is_verified:
        raise CutoverError("owner", "owner_email", "the owner has not verified their email")
    return user


def household_tag(db: Session, owner: User) -> int:
    """The owner's Household tag id, queried and never created (plan section 1.1)."""
    row = db.execute(text("SELECT id FROM tags WHERE user_id = :owner AND is_system"),
                     {"owner": owner.id}).first()
    if row is None:
        raise CutoverError("household_tag", "owner_email", "the owner has no Household tag")
    return row[0]


def code_head() -> str:
    from alembic.config import Config
    from alembic.script import ScriptDirectory

    config = Config(os.path.join(BACKEND, "alembic.ini"))
    config.set_main_option("script_location", os.path.join(BACKEND, "migrations"))
    heads = ScriptDirectory.from_config(config).get_heads()
    if len(heads) != 1:
        raise CutoverError("alembic", "-", f"the code has {len(heads)} heads")
    return heads[0]


def check_alembic(db: Session) -> str:
    head = code_head()
    versions = [row[0] for row in db.execute(text("SELECT version_num FROM alembic_version"))]
    if versions != [head]:
        raise CutoverError("alembic", "-", "the database is not at the code's single head")
    return head


def check_guard(db: Session, owner: User, household_id: int) -> None:
    """The pre-load guard (plan section 1.3): the owner owns and has received nothing."""
    found = []
    for model in OWNED_TABLES:
        if db.query(model.id).filter(model.user_id == owner.id).first():
            found.append(model.__tablename__)
    if db.query(Tag.id).filter(Tag.user_id == owner.id, Tag.is_system.is_(False)).first():
        found.append("tags")
    for link, _, _ in LINKS:
        if db.execute(select(link.c.tag_id).where(link.c.tag_id == household_id)).first():
            found.append(f"{link.name} (Household tag)")
    if db.query(TagShare.id).filter(TagShare.tag_id == household_id).first():
        found.append("tag_shares (Household tag)")
    if db.query(AccountShare.id).filter(AccountShare.user_id == owner.id).first():
        found.append("account_shares (received)")
    if db.query(TagShare.id).filter(TagShare.user_id == owner.id).first():
        found.append("tag_shares (received)")
    if found:
        raise CutoverError("guard", "owner_email",
                           f"the owner already has rows in: {', '.join(found)}")


def take_lock(conn) -> None:
    got = conn.execute(text("SELECT pg_try_advisory_xact_lock(:key)"),
                       {"key": CUTOVER_LOCK_KEY}).scalar()
    if not got:
        raise Refused("lock", "another cutover run is active")


# --- Counts --------------------------------------------------------------------------------

def owner_counts(db: Session, owner_id: int) -> Dict[str, int]:
    """The owner's row counts per table: the guard's tables, the three link tables
    (links on the owner's records or with the owner's tags) and the shares touching
    the owner (on the owner's objects, or received)."""
    counts = {model.__tablename__: db.query(model).filter(model.user_id == owner_id).count()
              for model in OWNED_TABLES}
    counts["tags"] = db.query(Tag).filter(Tag.user_id == owner_id).count()
    own_tags = select(Tag.id).where(Tag.user_id == owner_id)
    for link, column, model in LINKS:
        owned = select(model.id).where(model.user_id == owner_id)
        counts[link.name] = db.execute(select(func.count()).select_from(link).where(
            (link.c[column].in_(owned)) | (link.c.tag_id.in_(own_tags)))).scalar()
    own_accounts = select(Account.id).where(Account.user_id == owner_id)
    counts["account_shares"] = db.query(AccountShare).filter(
        AccountShare.account_id.in_(own_accounts) | (AccountShare.user_id == owner_id)).count()
    counts["tag_shares"] = db.query(TagShare).filter(
        TagShare.tag_id.in_(own_tags) | (TagShare.user_id == owner_id)).count()
    return counts


# --- Ledger --------------------------------------------------------------------------------

def ledger_balance(db: Session, account: Account, boundary: datetime) -> Decimal:
    """B(account, boundary): the stored balance less every posted row dated on or
    after ``boundary`` touching it, whoever entered it (plan section 1.6)."""
    balance = Decimal(str(account.balance))
    rows = db.query(Transaction).filter(
        touches_accounts(Transaction, [account.id]),
        Transaction.is_posted.is_(True),
        Transaction.transaction_date >= boundary,
    ).all()
    for row in rows:
        amount = Decimal(str(row.amount))
        if row.transaction_type == TransactionType.TRANSFER:
            out, received = transfer_sides(row)
            if row.transfer_from_account_id == account.id:
                balance += out
            if row.transfer_to_account_id == account.id:
                balance -= received
        elif row.account_id == account.id:
            balance += -amount if row.transaction_type == TransactionType.CREDIT else amount
    return balance


def stored_card_cycles(db: Session, owner: User, card: Account, boundary: datetime) -> List[dict]:
    """The card's compared set at ``boundary`` from the stored rows (as the check reads it)."""
    from app.services.statements import _card_rows

    by_card, unbilled = _card_rows(db, [card.id], viewable_account_ids(db, owner))
    return card_cycles(card, card.id, by_card.get(card.id, []), unbilled, boundary)


# --- Writing -------------------------------------------------------------------------------

def _money(value: Optional[Decimal]) -> Optional[float]:
    return float(value) if value is not None else None


class Writer:
    """Writes a ``LoadPlan`` through the app's write paths, as the owner."""

    def __init__(self, db: Session, owner: User, plan: LoadPlan, household_id: int):
        self.db, self.owner, self.plan = db, owner, plan
        self.tags: Dict[str, int] = {HOUSEHOLD_TAG_NAME: household_id}
        self.categories: Dict[str, int] = {}
        self.accounts: Dict[str, int] = {}
        self.entries: Dict[str, int] = {}
        self.transactions: Dict[str, int] = {}

    def call(self, key: str, fn: Callable, *args, **kwargs):
        try:
            return fn(*args, **kwargs)
        except HTTPException as exc:
            raise CutoverError("write", key, str(exc.detail)) from None
        except ValidationError as exc:
            raise CutoverError("write", key, f"rejected by the app's schema: {exc}") from None

    def tag_ids(self, names: List[str]) -> List[int]:
        return [self.tags[name] for name in names]

    def account_id(self, key: Optional[str]) -> Optional[int]:
        return self.accounts[key] if key is not None else None

    def write(self) -> None:
        db, owner, plan = self.db, self.owner, self.plan
        for c in plan.data.categories:
            created = self.call(c.key, lambda c=c: create_category(
                CategoryCreate(name=c.name, kind=c.kind, is_expense=c.kind == CategoryKind.EXPENSE),
                db=db, current_user=owner))
            self.categories[c.key] = created.id
        for t in plan.data.tags:
            created = self.call(t.name, lambda t=t: create_tag(
                TagCreate(name=t.name, color=t.color), db=db, current_user=owner))
            self.tags[t.name] = created.id
        accounts = plan.data.accounts
        for a in [a for a in accounts if not is_card(a) and not is_loan(a)]:
            self._account(a, {})
        for a in [a for a in accounts if is_card(a) or is_loan(a)]:
            self._account(a, self._terms(a))
        for a in accounts:
            routing = self._routing(a)
            if routing:
                self.call(a.key, lambda a=a, routing=routing: update_account(
                    self.accounts[a.key], AccountUpdate(**routing), db=db, current_user=owner))
        for p in plan.entries:
            self._entry(p)
        for t in plan.transactions:
            created = self.call(t.key, lambda t=t: add_transaction(db, owner, self._row(t)))
            self.transactions[t.key] = created.id
        db.commit()

    def _account(self, a, terms: dict) -> None:
        payload = dict(name=a.name, account_type=a.account_type, currency=a.currency,
                       balance=float(self.plan.openings[a.key]),
                       is_spending_wallet=a.is_spending_wallet,
                       tag_ids=self.tag_ids(a.tags), **terms)
        created = self.call(a.key, lambda: create_account(
            AccountCreate(**payload), db=self.db, current_user=self.owner))
        self.accounts[a.key] = created["id"]

    @staticmethod
    def _terms(a) -> dict:
        if a.card is not None:
            terms = {"billing_cycle_start": a.card.billing_cycle_start,
                     "credit_limit": _money(a.card.credit_limit)}
            if a.card.days_until_due_date is not None:
                terms["days_until_due_date"] = a.card.days_until_due_date
            return terms
        loan = a.loan
        return {"loan_kind": loan.loan_kind, "loan_annual_rate": float(loan.annual_rate),
                "loan_term_months": loan.term_months,
                "loan_payment_amount": float(loan.payment_amount),
                "loan_first_payment_date": loan.first_payment_date,
                "loan_amortization": loan.amortization,
                "loan_payments_made_offset": loan.payments_made_offset}

    def _routing(self, a) -> dict:
        if a.card is not None:
            routing = {"payment_account_id": self.account_id(a.card.payment_account_key),
                       "payment_overflow_account_id":
                           self.account_id(a.card.payment_overflow_account_key)}
        elif a.loan is not None:
            routing = {"payment_account_id": self.account_id(a.loan.payment_account_key)}
        else:
            return {}
        return {k: v for k, v in routing.items() if v is not None}

    def _entry(self, p) -> None:
        e = p.entry
        payload = dict(
            name=e.name, entry_type=e.entry_type, amount=float(e.amount), currency=e.currency,
            cadence=e.cadence, next_occurrence=day_start(e.next_occurrence),
            end_mode=p.end_mode, account_id=self.account_id(e.account_key),
            overflow_account_id=self.account_id(e.overflow_account_key),
            transfer_to_account_id=self.account_id(e.transfer_to_account_key),
            category_id=self.categories.get(e.category_key) if e.category_key else None,
            is_autopay=e.is_autopay, is_active=p.is_active,
            max_occurrences=p.max_occurrences,
            occurrences_paid_offset=p.occurrences_paid_offset,
            tag_ids=self.tag_ids(e.tags))
        if e.end_date is not None:
            payload["end_date"] = day_start(e.end_date)
        for name in ("semi_monthly_day_1", "semi_monthly_day_2"):
            if getattr(e, name) is not None:
                payload[name] = getattr(e, name)
        created = self.call(e.key, lambda: create_budget_entry(
            BudgetEntryCreate(**payload), db=self.db, current_user=self.owner))
        self.entries[e.key] = created.id

    def _row(self, t) -> TransactionCreate:
        """The create payload; ``currency`` is always the account's (plan section 2.1)."""
        source = self.plan.accounts[t.account_key]
        payload = dict(
            account_id=self.accounts[t.account_key], transaction_type=t.type,
            transaction_date=day_start(t.date), is_posted=t.is_posted,
            description=t.description, currency=source.currency,
            category_id=self.categories.get(t.category_key) if t.category_key else None,
            tag_ids=self.tag_ids(t.tags))
        if t.type == TransactionType.TRANSFER:
            payload.update(amount=float(t.amount),
                           transfer_from_account_id=self.accounts[t.account_key],
                           transfer_to_account_id=self.accounts[t.to_account_key])
            if t.transfer_fee is not None:
                payload["transfer_fee"] = float(t.transfer_fee)
            if t.received_amount is not None:
                payload["received_amount"] = float(t.received_amount)
        elif t.face_currency is None:
            payload["amount"] = float(t.amount)
        elif t.is_posted:
            payload.update(amount=float(t.amount), projected_amount=float(t.face_amount),
                           projected_currency=t.face_currency)
        else:
            payload.update(amount=float(t.face_amount), projected_amount=float(t.face_amount),
                           projected_currency=t.face_currency)
        return self.call(t.key, lambda: TransactionCreate(**payload))


# --- After the writes ----------------------------------------------------------------------

def assert_loaded(db: Session, owner: User, plan: LoadPlan, writer: Writer) -> None:
    """Section 2.2 step 7: balances at the cutover and card compared sets."""
    boundary = plan.boundary
    problems = []
    for a in plan.data.accounts:
        account = db.get(Account, writer.accounts[a.key])
        at_cutover = ledger_balance(db, account, boundary)
        if at_cutover != a.balance_at_cutover:
            problems.append(Problem("assert_balance", a.key,
                                    f"B(cutover) is {at_cutover}, expected {a.balance_at_cutover}"))
        if a.card is not None:
            found = [(c["close"], c["owed"]) for c in stored_card_cycles(db, owner, account,
                                                                          boundary)]
            listed = [(s.close, s.owed) for s in sorted(a.card.statements_at_cutover,
                                                        key=lambda s: s.close)]
            if found != listed:
                problems.append(Problem("assert_statements", a.key,
                                        f"stored compared set {found}, listed {listed}"))
    if problems:
        raise InputInvalid(problems)


def review(db: Session, owner: User, plan: LoadPlan, writer: Writer, database: str,
           address: str, session_timezone: str) -> dict:
    """The dry-run review report (section 2.2 step 8)."""
    boundary = plan.boundary
    accounts, cards, loans = [], [], []
    for a in plan.data.accounts:
        account = db.get(Account, writer.accounts[a.key])
        accounts.append({"key": a.key, "name": a.name, "account_type": a.account_type.value,
                         "currency": a.currency.value, "opening": plan.openings[a.key],
                         "at_cutover": ledger_balance(db, account, boundary),
                         "final": Decimal(str(account.balance))})
        if a.account_type == AccountType.CREDIT:
            cards.append({"key": a.key,
                          "statements": stored_card_cycles(db, owner, account, boundary)})
        if a.account_type == AccountType.LOAN:
            loans.append({"key": a.key, "schedule": build_schedule(db, account)})
    entries = [db.get(BudgetEntry, writer.entries[p.entry.key]) for p in plan.entries
               if p.end_mode == "after_occurrences"]
    installments = [{"key": next(k for k, v in writer.entries.items() if v == e.id),
                     "name": e.name, "n": e.occurrences_paid,
                     "m": e.occurrences_paid + (e.max_occurrences or 0),
                     "is_active": e.is_active}
                    for e in _attach_occurrence_counts(db, entries)]
    return {"kind": "cutover-load-review", "database": database, "server_addr": address,
            "session_timezone": session_timezone, "owner_id": owner.id, "cutover_date": plan.data.cutover_date,
            "load_date": plan.data.load_date, "accounts": accounts, "cards": cards,
            "loans": loans, "installments": installments,
            "row_counts": owner_counts(db, owner.id)}


def git_sha() -> str:
    try:
        out = subprocess.run(["git", "-C", repo_root(), "rev-parse", "HEAD"],
                             capture_output=True, text=True, timeout=10, check=True)
        return out.stdout.strip()
    except Exception:
        return "unknown"


def finished_clock(conn, owner_id: int):
    """The database clock now, never earlier than the owner's newest row timestamp.

    ``update_account`` stamps ``updated_at`` from the loader's own clock
    (``utc_now``), not the database's, so a loader clock ahead of the
    database's would otherwise leave a loaded row "after" ``finished_at``.
    """
    parts = ["SELECT clock_timestamp() AS t"]
    for table in ("accounts", "transactions", "budget_entries", "categories", "allocations",
                  "wishlist_items"):
        parts.append(f"SELECT max(greatest(created_at, updated_at)) FROM {table} "
                     "WHERE user_id = :owner")
    parts.append("SELECT max(created_at) FROM tags WHERE user_id = :owner")
    sql = f"SELECT max(t) FROM ({' UNION ALL '.join(parts)}) AS stamps"
    return conn.execute(text(sql), {"owner": owner_id}).scalar()


# --- The run -------------------------------------------------------------------------------

def run_load(*, url, input_path: str, report_path: str, run_record_path: Optional[str],
             dry_run: bool, expect_db: str, expect_server_addr: Optional[str],
             out: Callable[[str], None] = print) -> int:
    """Load (or dry-run) the input; 0 on success. Raises ``Refused``, ``InputInvalid``
    or ``CutoverError`` on any refusal, with nothing written."""
    with open(input_path, "rb") as fh:
        raw = fh.read()
    input_sha = hashlib.sha256(raw).hexdigest()
    engine = create_engine(url, poolclass=NullPool)
    try:
        with engine.connect() as conn:
            trans = conn.begin()
            try:
                observed = observe_target(conn)
                out(f"observed: db={observed[0]} server_addr={observed[1]}")
                database, address = check_target(observed, expect_db=expect_db,
                                                 expect_server_addr=expect_server_addr)
                take_lock(conn)
                # The transaction's start: the database's now(), which stamps every
                # created_at this run writes, so no loaded row is before started_at.
                started_at = conn.execute(text("SELECT now()")).scalar()
                # The date columns are timestamptz: a naive date is written and read
                # in this zone, so the cutover check must run under the same one.
                session_timezone = conn.execute(text("SHOW TimeZone")).scalar()
                db = Session(bind=conn, join_transaction_mode="create_savepoint",
                             autoflush=False)
                revision = check_alembic(db)
                try:
                    data = parse_input(raw)
                except ValidationError as exc:
                    raise InputInvalid([Problem("schema", "-", str(exc))]) from None
                owner = find_owner(db, data.owner_email)
                household_id = household_tag(db, owner)
                check_guard(db, owner, household_id)
                plan = validate_input(data)
                out(f"validation: pass ({len(plan.transactions)} transactions, "
                    f"{len(plan.accounts)} accounts, {len(plan.entries)} recurring entries)")
                writer = Writer(db, owner, plan, household_id)
                writer.write()
                assert_loaded(db, owner, plan, writer)
                out("assert: balances at the cutover and card statements pass")
                report = review(db, owner, plan, writer, database, address, session_timezone)
                counts = report["row_counts"]
                if dry_run:
                    create_private(report_path, to_json({**report, "dry_run": True}))
                    db.close()
                    trans.rollback()
                    out("dry run: rolled back; review report written")
                    for table, count in sorted(counts.items()):
                        out(f"  {table}: {count}")
                    return 0
                record = {
                    "kind": "cutover-load-run", "status": "prepared",
                    "owner_id": owner.id, "owner_email": owner.email,
                    "database": database, "server_addr": address,
                    "session_timezone": session_timezone,
                    "alembic_revision": revision, "git_sha": git_sha(),
                    "input_sha256": input_sha, "started_at": started_at.isoformat(),
                    "row_counts": counts, "finished_at": None, "signed_off_at": None,
                }
                create_private(run_record_path, to_json(record))
                create_private(report_path, to_json({**report, "dry_run": False}))
                db.close()
                trans.commit()
            except BaseException:
                if trans.is_active:
                    trans.rollback()
                raise
            finished_at = finished_clock(conn, record["owner_id"])
            conn.rollback()
        replace_private(run_record_path, to_json(
            {**record, "status": "complete", "finished_at": finished_at.isoformat()}))
        out("load: committed; run record complete")
        for table, count in sorted(counts.items()):
            out(f"  {table}: {count}")
        return 0
    finally:
        engine.dispose()


def failure_report(exc: BaseException) -> dict:
    """The details of a refusal, for the report file (never the terminal)."""
    if isinstance(exc, InputInvalid):
        problems = [{"check": p.check, "key": p.key, "detail": p.detail} for p in exc.problems]
    elif isinstance(exc, CutoverError):
        problems = [{"check": exc.check, "key": exc.key, "detail": exc.detail}]
    elif isinstance(exc, Refused):
        problems = [{"check": exc.check, "key": "-", "detail": exc.message}]
    else:
        problems = [{"check": "error", "key": "-", "detail": type(exc).__name__}]
    return {"kind": "cutover-load-failure", "problems": problems,
            "at": datetime.now(timezone.utc).isoformat()}
