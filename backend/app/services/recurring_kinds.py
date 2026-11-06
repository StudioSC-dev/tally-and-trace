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
from app.models.transaction import RecurrenceFrequency
from app.services.statements import resolve_cycle_fields

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


def installment_close_day(e, account: Optional[Account]) -> Optional[int]:
    """The close day a card installment is charged on, or None.

    A card installment (``is_card_installment``) on a card with a statement
    cycle is charged monthly on the statement close (the resolved close day,
    ``statements.resolve_cycle_fields``). None for anything else, including a
    card installment on a card without a cycle.
    """
    if not is_card_installment(e, account):
        return None
    fields = resolve_cycle_fields(account)
    return fields[0] if fields is not None else None


def is_normalised_installment(e, account: Optional[Account]) -> bool:
    """Whether ``e`` is a card installment already charged on the statement close:
    monthly, anchored on the card's close day, with no day rule. Its
    ``iter_occurrences`` then yields exactly the statement closes. Any other
    card installment is legacy until the re-date script converts it
    (``services/installment_redate.py``)."""
    close_day = installment_close_day(e, account)
    return (close_day is not None and e.cadence == RecurrenceFrequency.MONTHLY
            and e.anchor_day == close_day and getattr(e, "day_rule", None) is None)


def entry_kind(e, account: Optional[Account]) -> Optional[str]:
    if not is_kind_eligible(e):
        return None
    if not _is_card(account):
        return "cash"
    if is_card_installment(e, account):
        return "installment"
    return e.billing_kind or "subscription"


def plan_kind(e, account: Optional[Account]) -> Optional[str]:
    """Which Transactions card tab lists the entry's occurrences (STU-511):
    ``installment`` (a card installment), ``subscription`` (an open-ended card
    subscription, or an open-ended bank expense the user marked
    ``billing_kind`` subscription), or None (Due and Upcoming)."""
    if is_card_installment(e, account):
        return "installment"
    kind = entry_kind(e, account)
    if e.end_mode == "indefinite" and (
            kind == "subscription"
            or (kind == "cash" and e.billing_kind == "subscription")):  # a bank entry the user marked
        return "subscription"
    return None


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


def auto_post_block(e, account: Optional[Account]) -> Optional[str]:
    """Why a card installment cannot auto-post, or None when it is eligible.

    ``not_installment``, ``foreign_currency`` (the entry is not in the card's
    currency), ``no_statement_cycle`` (the card has no statement cycle:
    ``statements.resolve_cycle_fields`` is None),
    ``inactive`` (paused or completed).
    """
    if not is_card_installment(e, account):
        return "not_installment"
    if e.currency != account.currency:
        return "foreign_currency"
    if resolve_cycle_fields(account) is None:
        return "no_statement_cycle"
    if not e.is_active:
        return "inactive"
    return None


def settlement_block(e, account: Optional[Account]) -> Optional[str]:
    """Why an entry cannot settle by autopay, or None when it can.

    A card installment answers with ``auto_post_block``. Anything else must be a
    cash entry: ``not_cash`` (income, a transfer, a card subscription or bill),
    ``no_account``, ``spending_wallet``, ``inactive`` (paused or completed),
    ``foreign_currency`` (the entry is not in its account's currency, so posting
    would need a typed figure).

    ``auto_post_block`` keeps its card-only answer: ``create_budget_entry`` turns
    an entry on when that function returns None.
    """
    from app.services.forecast import is_spending_wallet

    if is_card_installment(e, account):
        return auto_post_block(e, account)
    if entry_kind(e, account) != "cash":
        return "not_cash"
    if account is None:
        return "no_account"
    if is_spending_wallet(account):
        return "spending_wallet"
    if not e.is_active:
        return "inactive"
    if e.currency != account.currency:
        return "foreign_currency"
    return None


def settlement(e, account: Optional[Account]) -> Optional[str]:
    """The wire value, from ``auto_post_enabled`` alone: ``autopay`` or ``manual``
    on a cash entry or a card installment, None on everything else (a row that
    names no settlement)."""
    if settlement_block(e, account) in ("not_cash", "no_account", "spending_wallet"):
        return None
    return "autopay" if e.auto_post_enabled else "manual"
