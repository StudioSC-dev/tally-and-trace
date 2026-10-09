"""The demo seed: two demo users with generic data, replaced by shape version.

On startup ``seed_database`` compares the one-row ``demo_state`` table with
``DEMO_SHAPE_VERSION``. When the row is missing, holds another version, or a
demo user is missing, both demo users' data is replaced with the current shape
(the user rows, and so their ids, are kept); otherwise nothing changes, so
every id stays the same. Only the two demo users, matched by their fixed
emails, are ever touched. The whole run is one transaction under a Postgres
advisory lock, so concurrent workers seed once, and a failure rolls back and
logs at error level.

Shape 3 (STU-232): the demo owner's Joint Account, tagged Household, is shared
with the Demo Partner as editor. Household bills are paid from the joint
account and from the owner's private card, and the partner has an account of
their own and a deposit from it into the joint account (``partner`` and
``shares`` in ``constants/seed_data.json``). Demo users can't change shares
(``app/routers/shares.py``), so the share comes only from this seed.

Bump ``DEMO_SHAPE_VERSION`` whenever the demo data's shape changes.
"""

import copy
import json
import logging
import os
from datetime import datetime

from sqlalchemy import func, or_, select, text
from sqlalchemy.orm import Session

from app.core.auth import get_password_hash
from app.core.database import SessionLocal
from app.core.tags import LINKS, ensure_household_tag
from app.models import Account, Allocation, BudgetEntry, Category, Tag, Transaction, User
from app.models.account_share import AccountShare
from app.models.account import AccountType
from app.models.allocation import AllocationType, BudgetPeriodFrequency
from app.models.budget_entry import BudgetEntryType
from app.models.demo_state import DemoState
from app.models.transaction import RecurrenceFrequency, TransactionType
from app.models.user import CurrencyType
from app.models.wishlist_item import WishlistItem

logger = logging.getLogger(__name__)

DEMO_EMAIL = "demo@example.com"
DEMO_PARTNER_EMAIL = "demo.partner@example.com"
# Demo users can neither share nor be shared with (app/routers/shares.py).
DEMO_EMAILS = frozenset({DEMO_EMAIL, DEMO_PARTNER_EMAIL})
DEMO_PASSWORD = "password123"
DEMO_SHAPE_VERSION = 3  # 2: tags (STU-231); 3: the Demo Partner and joint share (STU-232)
# One seeder at a time across workers (pg_advisory_xact_lock key).
_LOCK_KEY = 229_0001
_SEED_FILE = os.path.join(os.path.dirname(os.path.dirname(__file__)), "constants", "seed_data.json")


def seed_database() -> None:
    """Make sure the demo user exists with the current demo shape (see the module docstring)."""
    db = SessionLocal()
    try:
        _seed(db)
    except Exception:
        db.rollback()
        logger.exception("Demo seed failed; the demo user's data is unchanged")
    finally:
        db.close()


def _seed(db: Session) -> None:
    if db.get_bind().dialect.name == "postgresql":
        db.execute(text("SELECT pg_advisory_xact_lock(:key)"), {"key": _LOCK_KEY})
    state = db.get(DemoState, 1)
    user = db.query(User).filter(User.email == DEMO_EMAIL).first()
    partner = db.query(User).filter(User.email == DEMO_PARTNER_EMAIL).first()
    if (state is not None and state.shape_version == DEMO_SHAPE_VERSION
            and user is not None and partner is not None):
        db.rollback()  # releases the lock; nothing changed
        logger.info("Demo seed is current (shape %s); nothing to do", DEMO_SHAPE_VERSION)
        return

    if user is None:
        user = User(email=DEMO_EMAIL)
        db.add(user)
    if partner is None:
        partner = User(email=DEMO_PARTNER_EMAIL)
        db.add(partner)
    _reset_demo_user(user, "User", onboarded=False)
    _reset_demo_user(partner, "Partner", onboarded=True)
    db.flush()
    _delete_demo_data(db, [user, partner])
    household = ensure_household_tag(db, user)  # kept across reseeds, like the user row
    ensure_household_tag(db, partner)
    _load_seed_data(db, user, household, partner)

    if state is None:
        db.add(DemoState(id=1, shape_version=DEMO_SHAPE_VERSION))
    else:
        state.shape_version = DEMO_SHAPE_VERSION
        state.seeded_at = func.now()
    db.commit()
    logger.info("Demo seed replaced the demo user's data (shape %s)", DEMO_SHAPE_VERSION)


def _reset_demo_user(user: User, last_name: str, *, onboarded: bool) -> None:
    user.password_hash = get_password_hash(DEMO_PASSWORD)
    user.first_name = "Demo"
    user.last_name = last_name
    user.is_active = True
    user.is_verified = True
    # The demo owner starts pre-onboarding; the partner goes straight in.
    user.onboarding_completed = onboarded
    user.default_currency = CurrencyType.PHP


def _delete_demo_data(db: Session, users) -> None:
    """Everything the demo users own, children first; the user rows stay.

    So does each Household system tag, as every user keeps theirs; its links go
    with the records they tag. Every user's transactions go before any account,
    since the partner's deposit lands on the owner's joint account.
    """
    ids = [u.id for u in users]
    for model in (Transaction, BudgetEntry, WishlistItem, Allocation, Category):
        db.query(model).filter(model.user_id.in_(ids)).delete(synchronize_session=False)
    db.query(Tag).filter(Tag.user_id.in_(ids), Tag.is_system.is_(False)).delete(
        synchronize_session=False)
    owned = select(Account.id).where(Account.user_id.in_(ids))
    db.query(AccountShare).filter(or_(
        AccountShare.account_id.in_(owned), AccountShare.user_id.in_(ids),
    )).delete(synchronize_session=False)
    db.query(Account).filter(Account.user_id.in_(ids)).update(
        {"payment_account_id": None, "payment_overflow_account_id": None},
        synchronize_session=False)
    db.query(Account).filter(Account.user_id.in_(ids)).delete(synchronize_session=False)
    db.flush()


def _load_partner_data(db: Session, owner: User, partner: User, seed_data: dict,
                       owner_accounts: dict) -> None:
    """The Demo Partner's accounts and transactions, and the owner's shares to them.

    Partner transactions name the partner's accounts by 1-based index
    (``account_id``) and an owner account by ``transfer_to_owner_account_id``.
    """
    data = seed_data.get("partner", {})
    accounts = {}
    for i, account_data in enumerate(data.get("accounts", []), start=1):
        row = dict(account_data)
        row["account_type"] = AccountType(row["account_type"].lower())
        row["user_id"] = partner.id
        row.setdefault("currency", partner.default_currency)
        account = Account(**row)
        db.add(account)
        db.flush()
        accounts[i] = account
    for txn_data in data.get("transactions", []):
        row = dict(txn_data)
        source = accounts[row.pop("account_id")]
        target = row.pop("transfer_to_owner_account_id", None)
        kind = TransactionType(row.pop("transaction_type").lower())
        db.add(Transaction(
            user_id=partner.id, created_by_actor=partner.id, account_id=source.id,
            transaction_type=kind, currency=source.currency, transfer_fee=0.0,
            transaction_date=datetime.fromisoformat(row.pop("transaction_date")),
            transfer_from_account_id=source.id if kind == TransactionType.TRANSFER else None,
            transfer_to_account_id=owner_accounts[target] if target else None,
            is_recurring=False, **row))
    for share in seed_data.get("shares", []):
        db.add(AccountShare(account_id=owner_accounts[share["account_id"]], user_id=partner.id,
                            role=share["role"], created_by=owner.id))
    db.flush()


def _load_seed_data(db: Session, default_user: User, household: Tag, partner: User) -> None:
    """The generic demo data in ``constants/seed_data.json``: the demo owner's,
    then the Demo Partner's (``_load_partner_data``).

    Records name their tags in a ``tags`` list: Household is the user's system
    tag, and every other name is one of the top-level ``tags``.
    """
    with open(_SEED_FILE, "r") as f:
        seed_data = json.load(f)

    tag_ids = {household.name: household.id}
    for tag_data in seed_data.get("tags", []):
        tag = Tag(user_id=default_user.id, name=tag_data["name"], color=tag_data.get("color"))
        db.add(tag)
        db.flush()
        tag_ids[tag.name] = tag.id
    tagged = []  # (record, tag names), linked once every record has its id

    # Create accounts associated with the default user
    accounts = []
    account_id_mapping = {}  # Map original index to actual ID
    account_obj_mapping = {}
    for i, account_data in enumerate(seed_data["accounts"]):
        # Convert account_type string to enum (convert uppercase to lowercase)
        account_type_str = account_data["account_type"].lower()
        account_data["account_type"] = AccountType(account_type_str)
        # Add user_id to account data
        account_data["user_id"] = default_user.id
        account_data.setdefault("currency", default_user.default_currency)
        if account_data.get("days_until_due_date") is None:
            account_data["days_until_due_date"] = 21
        names = account_data.pop("tags", [])
        account = Account(**account_data)
        db.add(account)
        accounts.append(account)
        tagged.append((account, names))
    db.flush()

    # Refresh to get IDs and create mapping
    for i, account in enumerate(accounts):
        db.refresh(account)
        account_id_mapping[i + 1] = account.id  # Original seed data uses 1-based indexing
        account_obj_mapping[i + 1] = account

    # Create categories associated with the default user
    categories = []
    category_id_mapping = {}  # Map original index to actual ID
    for i, category_data in enumerate(seed_data["categories"]):
        # Add user_id to category data
        category_data["user_id"] = default_user.id
        category = Category(**category_data)
        db.add(category)
        categories.append(category)
    db.flush()

    # Refresh to get IDs and create mapping
    for i, category in enumerate(categories):
        db.refresh(category)
        category_id_mapping[i + 1] = category.id  # Original seed data uses 1-based indexing

    # Create allocations associated with the default user
    allocations = []
    allocation_id_mapping = {}  # Map original index to actual ID
    for i, allocation_data in enumerate(seed_data["allocations"]):
        # Convert allocation_type string to enum (convert uppercase to lowercase)
        allocation_type_str = allocation_data["allocation_type"].lower()
        allocation_data["allocation_type"] = AllocationType(allocation_type_str)
        if allocation_data.get("target_date"):
            allocation_data["target_date"] = datetime.fromisoformat(allocation_data["target_date"])
        if allocation_data.get("period_frequency"):
            allocation_data["period_frequency"] = BudgetPeriodFrequency(allocation_data["period_frequency"].lower())
        if allocation_data.get("period_start"):
            allocation_data["period_start"] = datetime.fromisoformat(allocation_data["period_start"])
        if allocation_data.get("period_end"):
            allocation_data["period_end"] = datetime.fromisoformat(allocation_data["period_end"])
        # Add user_id to allocation data
        allocation_data["user_id"] = default_user.id
        # Map account_id to actual account ID
        original_account_id = allocation_data["account_id"]
        allocation_data["account_id"] = account_id_mapping[original_account_id]
        config = allocation_data.get("configuration")
        if config:
            config_copy = copy.deepcopy(config)
            if isinstance(config_copy.get("category_ids"), list):
                config_copy["category_ids"] = [
                    category_id_mapping[cat_id]
                    for cat_id in config_copy["category_ids"]
                    if cat_id in category_id_mapping
                ]
            if isinstance(config_copy.get("account_ids"), list):
                config_copy["account_ids"] = [
                    account_id_mapping[acct_id]
                    for acct_id in config_copy["account_ids"]
                    if acct_id in account_id_mapping
                ]
            if config_copy.get("savings_category_id"):
                category_ref = config_copy["savings_category_id"]
                if category_ref in category_id_mapping:
                    config_copy["savings_category_id"] = category_id_mapping[category_ref]
            if config_copy.get("start_date"):
                config_copy["start_date"] = datetime.fromisoformat(config_copy["start_date"])
            if config_copy.get("end_date"):
                config_copy["end_date"] = datetime.fromisoformat(config_copy["end_date"])
            allocation_data["configuration"] = config_copy
        allocation = Allocation(**allocation_data)
        db.add(allocation)
        allocations.append(allocation)
    db.flush()

    # Refresh to get IDs and create mapping
    for i, allocation in enumerate(allocations):
        db.refresh(allocation)
        allocation_id_mapping[i + 1] = allocation.id  # Original seed data uses 1-based indexing

    # Create budget entries (recurring income/expenses)
    budget_entries = []
    budget_entry_id_mapping = {}
    for i, entry_data in enumerate(seed_data.get("budget_entries", [])):
        entry_copy = entry_data.copy()
        entry_copy["user_id"] = default_user.id
        entry_copy["entry_type"] = BudgetEntryType(entry_copy["entry_type"].lower())
        entry_copy["currency"] = CurrencyType(entry_copy.get("currency", default_user.default_currency.name))
        entry_copy["cadence"] = RecurrenceFrequency(entry_copy.get("cadence", "monthly").lower())
        entry_copy["next_occurrence"] = datetime.fromisoformat(entry_copy["next_occurrence"])
        entry_copy["end_mode"] = entry_copy.get("end_mode", "indefinite").lower()
        if entry_copy.get("end_date"):
            entry_copy["end_date"] = datetime.fromisoformat(entry_copy["end_date"])
        if entry_copy.get("max_occurrences") is not None:
            entry_copy["max_occurrences"] = int(entry_copy["max_occurrences"])
        if entry_copy.get("account_id"):
            entry_copy["account_id"] = account_id_mapping[entry_copy["account_id"]]
        if entry_copy.get("category_id"):
            entry_copy["category_id"] = category_id_mapping[entry_copy["category_id"]]
        if entry_copy.get("allocation_id"):
            entry_copy["allocation_id"] = allocation_id_mapping[entry_copy["allocation_id"]]
        names = entry_copy.pop("tags", [])
        budget_entry = BudgetEntry(**entry_copy)
        db.add(budget_entry)
        budget_entries.append(budget_entry)
        tagged.append((budget_entry, names))
    if budget_entries:
        db.flush()
        for i, entry in enumerate(budget_entries):
            db.refresh(entry)
            budget_entry_id_mapping[i + 1] = entry.id

    # Create transactions associated with the default user
    for transaction_data in seed_data["transactions"]:
        original_account_id = transaction_data["account_id"]
        # Convert transaction_type string to enum (convert uppercase to lowercase)
        transaction_type_str = transaction_data["transaction_type"].lower()
        transaction_data["transaction_type"] = TransactionType(transaction_type_str)
        # Convert date strings to datetime
        transaction_data["transaction_date"] = datetime.fromisoformat(transaction_data["transaction_date"])
        if transaction_data.get("posting_date"):
            transaction_data["posting_date"] = datetime.fromisoformat(transaction_data["posting_date"])
        # Add user_id to transaction data
        transaction_data["user_id"] = default_user.id
        transaction_data["created_by_actor"] = default_user.id
        # Map foreign key IDs to actual IDs
        transaction_data["account_id"] = account_id_mapping[original_account_id]
        original_category_id = transaction_data.get("category_id")
        if original_category_id is not None:
            transaction_data["category_id"] = category_id_mapping[original_category_id]
        if transaction_data.get("allocation_id"):
            transaction_data["allocation_id"] = allocation_id_mapping[transaction_data["allocation_id"]]
        budget_entry_ref = None
        if transaction_data.get("budget_entry_id"):
            mapped_id = budget_entry_id_mapping[transaction_data["budget_entry_id"]]
            transaction_data["budget_entry_id"] = mapped_id
            budget_entry_ref = next((entry for entry in budget_entries if entry.id == mapped_id), None)
        else:
            transaction_data["budget_entry_id"] = None
        if transaction_data.get("transfer_from_account_id"):
            transaction_data["transfer_from_account_id"] = account_id_mapping[
                transaction_data["transfer_from_account_id"]
            ]
        elif transaction_data["transaction_type"] == TransactionType.TRANSFER:
            transaction_data["transfer_from_account_id"] = account_id_mapping[original_account_id]
        if transaction_data.get("transfer_to_account_id"):
            transaction_data["transfer_to_account_id"] = account_id_mapping[
                transaction_data["transfer_to_account_id"]
            ]
        account_ref = account_obj_mapping.get(original_account_id)
        if transaction_data.get("currency") is None and account_ref:
            transaction_data["currency"] = account_ref.currency
        if transaction_data.get("projected_amount") is not None and transaction_data.get("projected_currency") is None and account_ref:
            transaction_data["projected_currency"] = account_ref.currency
        if transaction_data.get("transfer_fee") is None:
            transaction_data["transfer_fee"] = 0.0
        transaction_data.pop("is_recurring", None)
        if budget_entry_ref:
            transaction_data["is_recurring"] = True
            transaction_data["recurrence_frequency"] = budget_entry_ref.cadence
        else:
            transaction_data["is_recurring"] = False
            transaction_data["recurrence_frequency"] = None
        names = transaction_data.pop("tags", [])
        transaction = Transaction(**transaction_data)
        db.add(transaction)
        tagged.append((transaction, names))
    db.flush()

    for record, names in tagged:
        table, column = LINKS[type(record)]
        for name in names:
            db.execute(table.insert().values({"tag_id": tag_ids[name], column: record.id}))
    db.flush()

    _load_partner_data(db, default_user, partner, seed_data, account_id_mapping)
