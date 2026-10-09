"""What a caller sees of a record: one serializer rule, explicit models.

Every transaction and recurring entry response goes through ``Redactor``; the
response models (``app/schemas/transaction.py`` and ``budget_entry.py``) are
discriminated on ``view`` and list exactly what each kind may carry.

- ``full``: the caller created the record and can view every account it
  touches. The owner schema.
- ``shared_full``: the caller did not create it, but is an editor or above on
  every account it touches. The owner schema minus the creator's private
  references (``category_id``, ``allocation_id``, ``budget_entry_id``,
  ``receipt_url``, ``invoice_url``), plus a read-only ``category_name``.
- ``limited``: everyone else. An explicit allowlist, with accounts as
  references: a viewable account is ``{id, name}``, any other a neutral
  ``{id: null, name}`` ("Other account", "Loan payment" or "Card payment").

A record that touches no account is ``full`` for its creator and ``limited``
for anyone else.

``display_description`` (and a recurring entry's ``display_name``, and the
category name a limited record shows) is the stored text only when the caller
can view every account the record touches; otherwise a neutral label for its
kind. A payment into a loan or card the caller can't view shows no interest:
``transfer_fee`` is null and ``amount`` is the whole payment.

Tags are only ever the caller's own (``attach_visible_tags``). Every record
carries ``view``, ``permissions`` (``RecordAccess.permissions``) and
``created_by`` (the creator's display name).
"""

from typing import Dict, Iterable, List, Optional

from sqlalchemy.orm import Session

from app.core.access import DIRECT_ROLES, EDIT_ROLES, RecordAccess, record_account_ids
from app.models.account import Account, AccountType
from app.models.budget_entry import BudgetEntry, BudgetEntryType
from app.models.category import Category
from app.models.transaction import Transaction, TransactionType
from app.models.user import User

FULL = "full"
SHARED_FULL = "shared_full"
LIMITED = "limited"

OTHER_ACCOUNT = "Other account"
LOAN_PAYMENT = "Loan payment"
CARD_PAYMENT = "Card payment"

# The creator's own references: never in another user's view of the record.
OWNER_PRIVATE_FIELDS = ("category_id", "allocation_id", "budget_entry_id", "receipt_url",
                        "invoice_url")

TRANSACTION_LABELS = {
    TransactionType.DEBIT: "Expense",
    TransactionType.CREDIT: "Income",
    TransactionType.TRANSFER: "Transfer",
}
ENTRY_LABELS = {
    BudgetEntryType.EXPENSE: "Recurring expense",
    BudgetEntryType.INCOME: "Recurring income",
}


def display_name(user: Optional[User]) -> Optional[str]:
    """A user as others see them: first name and last-name initial ("Bea P.")."""
    if user is None:
        return None
    first = (user.first_name or "").strip()
    last = (user.last_name or "").strip()
    return f"{first} {last[0]}." if last else first or None


def neutral_label(account: Optional[Account]) -> str:
    """The name an account the caller can't view is shown under."""
    if account is not None and account.account_type == AccountType.LOAN:
        return LOAN_PAYMENT
    if account is not None and account.account_type == AccountType.CREDIT:
        return CARD_PAYMENT
    return OTHER_ACCOUNT


class Redactor:
    """Serializes records for one caller, loading what it needs once per batch."""

    def __init__(self, db: Session, user, access: Optional[RecordAccess] = None):
        self.db = db
        self.user = user
        self.access = access or RecordAccess(db, user)
        self._users: Dict[int, Optional[User]] = {}
        self._categories: Dict[int, Optional[Category]] = {}

    # --- loading ---------------------------------------------------------------------

    def prepare(self, records: Iterable) -> None:
        records = list(records)
        ids = set()
        for record in records:
            ids.update(record_account_ids(record))
            for column in ("account_id", "transfer_to_account_id", "transfer_from_account_id",
                           "overflow_account_id"):
                value = getattr(record, column, None)
                if value is not None:
                    ids.add(value)
        self.access.load(ids)
        self._load_users({r.user_id for r in records})
        self._load_categories({r.category_id for r in records if r.category_id})

    def _load_users(self, ids) -> None:
        missing = [i for i in ids if i is not None and i not in self._users]
        if missing:
            for user in self.db.query(User).filter(User.id.in_(missing)).all():
                self._users[user.id] = user
            for i in missing:
                self._users.setdefault(i, None)

    def _load_categories(self, ids) -> None:
        missing = [i for i in ids if i is not None and i not in self._categories]
        if missing:
            for category in self.db.query(Category).filter(Category.id.in_(missing)).all():
                self._categories[category.id] = category
            for i in missing:
                self._categories.setdefault(i, None)

    def created_by(self, record) -> Optional[str]:
        self._load_users([record.user_id])
        return display_name(self._users.get(record.user_id))

    def category_name(self, record) -> Optional[str]:
        """The record's category name, when its creator owns the category."""
        if not record.category_id:
            return None
        self._load_categories([record.category_id])
        category = self._categories.get(record.category_id)
        if category is None or category.user_id != record.user_id:
            return None
        return category.name

    # --- rules -----------------------------------------------------------------------

    def can_view(self, account_id: Optional[int]) -> bool:
        return self.access.role(account_id) in DIRECT_ROLES

    def account_ref(self, account_id: Optional[int]) -> Optional[dict]:
        """``{id, name}`` for a viewable account, a neutral ``{id: null, name}`` otherwise."""
        if account_id is None:
            return None
        account = self.access.account(account_id)
        if account is not None and self.can_view(account_id):
            return {"id": account.id, "name": account.name}
        return {"id": None, "name": neutral_label(account)}

    def view(self, record, facts: Optional[dict] = None) -> str:
        f = facts or self.access.facts(record)
        if not f["view_all"]:
            return LIMITED
        if f["is_creator"]:
            return FULL
        if f["ids"] and all(self.access.role(i) in EDIT_ROLES for i in f["ids"]):
            return SHARED_FULL
        return LIMITED

    def _hidden_liability(self, record) -> Optional[Account]:
        """The loan or card a transfer pays into, when the caller can't view it."""
        if getattr(record, "transaction_type", None) != TransactionType.TRANSFER:
            return None
        target = self.access.account(record.transfer_to_account_id)
        if target is None or self.can_view(target.id):
            return None
        if target.account_type in (AccountType.LOAN, AccountType.CREDIT):
            return target
        return None

    def display_description(self, record, facts: Optional[dict] = None) -> Optional[str]:
        """The stored description when every touched account is viewable, else a label."""
        f = facts or self.access.facts(record)
        if f["view_all"] and record_account_ids(record):
            return record.description if isinstance(record, Transaction) else record.name
        hidden = self._hidden_liability(record) if isinstance(record, Transaction) else None
        if hidden is None and isinstance(record, BudgetEntry) and record.transfer_to_account_id:
            target = self.access.account(record.transfer_to_account_id)
            if target is not None and not self.can_view(target.id) and \
                    target.account_type in (AccountType.LOAN, AccountType.CREDIT):
                hidden = target
        if hidden is not None:
            return neutral_label(hidden)
        if isinstance(record, Transaction):
            return TRANSACTION_LABELS.get(record.transaction_type, "Transaction")
        if record.transfer_to_account_id:
            return "Recurring transfer"
        return ENTRY_LABELS.get(record.entry_type, "Recurring entry")

    # --- serializers -----------------------------------------------------------------

    def _common(self, record, view: str) -> dict:
        return {
            "view": view,
            "permissions": self.access.permissions(record),
            "created_by": self.created_by(record),
            "tags": [{"id": t.id, "name": t.name, "color": t.color, "is_system": t.is_system}
                     for t in (getattr(record, "visible_tags", None) or [])],
        }

    def transaction(self, txn: Transaction) -> dict:
        from app.schemas.transaction import TransactionFields

        facts = self.access.facts(txn)
        view = self.view(txn, facts)
        if view in (FULL, SHARED_FULL):
            data = TransactionFields.model_validate(txn).model_dump()
            data.update(self._common(txn, view))
            if view == SHARED_FULL:
                for field in OWNER_PRIVATE_FIELDS:
                    data.pop(field, None)
                data["category_name"] = self.category_name(txn)
            return data
        return self.limited_transaction(txn, facts)

    def limited_transaction(self, txn: Transaction, facts: Optional[dict] = None) -> dict:
        """The ``LimitedTransaction`` body, whatever the caller's view (exports use it)."""
        facts = facts or self.access.facts(txn)
        shown = facts["view_all"] and bool(facts["ids"])
        hidden = self._hidden_liability(txn)
        amount, fee = txn.amount, txn.transfer_fee
        if hidden is not None:
            # No interest shown: the whole payment, no split.
            amount, fee = (amount or 0) + (fee or 0), None
        transfer = txn.transaction_type == TransactionType.TRANSFER
        return {
            **self._common(txn, LIMITED),
            "id": txn.id,
            "date": txn.transaction_date,
            "display_description": self.display_description(txn, facts),
            "amount": amount,
            "transfer_fee": fee,
            "currency": txn.currency,
            "transaction_type": txn.transaction_type,
            "is_posted": txn.is_posted,
            "category_name": self.category_name(txn) if shown else None,
            "account": self.account_ref(
                txn.transfer_from_account_id if transfer and txn.transfer_from_account_id
                else txn.account_id),
            "counterpart": self.account_ref(txn.transfer_to_account_id) if transfer else None,
        }

    def transactions(self, txns: List[Transaction]) -> List[dict]:
        self.prepare(txns)
        return [self.transaction(t) for t in txns]

    def entry(self, entry: BudgetEntry) -> dict:
        from app.schemas.budget_entry import BudgetEntryFields

        facts = self.access.facts(entry)
        view = self.view(entry, facts)
        if view in (FULL, SHARED_FULL):
            data = BudgetEntryFields.model_validate(entry).model_dump()
            data.update(self._common(entry, view))
            if view == SHARED_FULL:
                for field in OWNER_PRIVATE_FIELDS:
                    data.pop(field, None)
                data["category_name"] = self.category_name(entry)
            return data
        return self.limited_entry(entry, facts)

    def limited_entry(self, entry: BudgetEntry, facts: Optional[dict] = None) -> dict:
        """The ``LimitedRecurringEntry`` body, whatever the caller's view (exports use it)."""
        facts = facts or self.access.facts(entry)
        shown = facts["view_all"] and bool(facts["ids"])
        return {
            **self._common(entry, LIMITED),
            "id": entry.id,
            "display_name": self.display_description(entry, facts),
            "amount": entry.amount,
            "currency": entry.currency,
            "entry_type": entry.entry_type,
            "cadence": entry.cadence,
            "next_occurrence": entry.next_occurrence,
            "end_date": entry.end_date,
            "category_name": self.category_name(entry) if shown else None,
            "account": self.account_ref(entry.account_id),
            "counterpart": self.account_ref(entry.transfer_to_account_id),
        }

    def entries(self, entries: List[BudgetEntry]) -> List[dict]:
        self.prepare(entries)
        return [self.entry(e) for e in entries]


def displayed_description_criterion(viewable_ids: Iterable[int]):
    """Criterion: a transaction whose stored description the caller is shown.

    That is one whose every touched account is viewable (``display_description``).
    Search matches displayed text only, so it is combined with this.
    """
    from sqlalchemy import and_, or_

    ids = list(viewable_ids)
    return and_(
        Transaction.account_id.in_(ids),
        or_(
            Transaction.transaction_type != TransactionType.TRANSFER,
            and_(
                or_(Transaction.transfer_from_account_id.is_(None),
                    Transaction.transfer_from_account_id.in_(ids)),
                or_(Transaction.transfer_to_account_id.is_(None),
                    Transaction.transfer_to_account_id.in_(ids)),
            ),
        ),
    )


def serialize_transactions(db: Session, user, txns: List[Transaction]) -> List[dict]:
    """Transactions as ``user`` may see them, tags included."""
    from app.core.tags import attach_visible_tags

    attach_visible_tags(db, user, txns)
    return Redactor(db, user).transactions(txns)


def serialize_transaction(db: Session, user, txn: Transaction):
    """One transaction as its response model (attribute access for callers)."""
    from pydantic import TypeAdapter

    from app.schemas.transaction import TransactionOut

    return TypeAdapter(TransactionOut).validate_python(serialize_transactions(db, user, [txn])[0])


def serialize_entries(db: Session, user, entries: List[BudgetEntry]) -> List[dict]:
    """Recurring entries as ``user`` may see them, tags included (occurrence
    counts must already be attached)."""
    from app.core.tags import attach_visible_tags

    attach_visible_tags(db, user, entries)
    return Redactor(db, user).entries(entries)


def serialize_entry(db: Session, user, entry: BudgetEntry):
    """One recurring entry as its response model (attribute access for callers)."""
    from pydantic import TypeAdapter

    from app.schemas.budget_entry import BudgetEntryOut

    return TypeAdapter(BudgetEntryOut).validate_python(serialize_entries(db, user, [entry])[0])


# Account fields only an owner or admin is shown: loan terms, limits, the
# description and routing ids. Every role sees the rest (name, type, currency,
# balance, cycle days).
MANAGER_ONLY_ACCOUNT_FIELDS = (
    "description", "credit_limit", "payment_account_id", "payment_overflow_account_id",
    "loan_annual_rate", "loan_term_months", "loan_payment_amount", "loan_first_payment_date",
    "loan_amortization", "loan_payments_made_offset",
)


def serialize_accounts(db: Session, user, accounts: List[Account]) -> List[dict]:
    """Accounts as ``user`` sees them: ``my_role``, ``permissions``, ``owner_name``,
    and the owner-or-admin fields nulled for everyone else."""
    from app.core.access import MANAGE_ROLES, account_role
    from app.core.tags import attach_visible_tags
    from app.schemas.account import AccountFields

    attach_visible_tags(db, user, accounts)
    owners = {u.id: u for u in db.query(User).filter(
        User.id.in_({a.user_id for a in accounts}))} if accounts else {}
    out = []
    for account in accounts:
        role = account_role(user, account)
        data = AccountFields.model_validate(account).model_dump()
        if role not in MANAGE_ROLES:
            for field in MANAGER_ONLY_ACCOUNT_FIELDS:
                data[field] = None
        data.update({
            "my_role": role,
            "permissions": {
                "can_edit_settings": role in MANAGE_ROLES,
                "can_manage_shares": role in MANAGE_ROLES,
                "can_add_transactions": role in EDIT_ROLES,
            },
            "owner_name": display_name(owners.get(account.user_id)),
        })
        out.append(data)
    return out


def serialize_account(db: Session, user, account: Account) -> dict:
    return serialize_accounts(db, user, [account])[0]
