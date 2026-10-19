"""The four recurring-entry kinds (STU-343): subscription, installment, bill, cash.

One shared predicate, used by the redactor, the create/PUT default and the later
posting plans. A kind exists only for a plain expense (not income, not a transfer).
"""
from typing import Optional

from sqlalchemy import func
from sqlalchemy.orm import Session

from app.models.account import Account, AccountType
from app.models.budget_entry import BudgetEntryType
from app.models.category import Category

BILLING_KINDS = ("subscription", "bill")


def is_kind_eligible(e) -> bool:
    return e.entry_type == BudgetEntryType.EXPENSE and e.transfer_to_account_id is None


def is_capped(e) -> bool:
    return e.end_mode == "after_occurrences" and e.max_occurrences is not None


def _is_card(account: Optional[Account]) -> bool:
    return account is not None and account.account_type == AccountType.CREDIT


def is_card_installment(e, account: Optional[Account]) -> bool:
    return (is_kind_eligible(e) and is_capped(e) and _is_card(account)
            and e.billing_kind != "bill")


def entry_kind(e, account: Optional[Account]) -> Optional[str]:
    if not is_kind_eligible(e):
        return None
    if not _is_card(account):
        return "cash"
    if is_card_installment(e, account):
        return "installment"
    return e.billing_kind or "subscription"


def default_billing_kind(db: Session, e, account: Optional[Account]) -> Optional[str]:
    """The server default for an open-ended card expense, else None.

    "bill" when the creator's own active category is named Utilities (any case),
    "subscription" otherwise.
    """
    if not is_kind_eligible(e) or is_capped(e) or not _is_card(account):
        return None
    if e.category_id is not None:
        utilities = db.query(Category.id).filter(
            Category.id == e.category_id,
            Category.user_id == e.user_id,
            Category.is_active.is_(True),
            func.lower(Category.name) == "utilities",
        ).first()
        if utilities is not None:
            return "bill"
    return "subscription"
