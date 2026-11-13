from fastapi import APIRouter, Depends, HTTPException, Query, Response
from sqlalchemy.orm import Session
from sqlalchemy import or_
from typing import List, Optional
from app.core import locking
from app.core.database import get_db
from app.core.auth import get_current_active_user
from app.core.access import (
    DIRECT_ROLES,
    EDIT_ROLES,
    MANAGE_ROLES,
    OWNER,
    OWNER_ROLES,
    TAG_VIEWER,
    VIEW_ROLES,
    account_role,
    can_edit_account,
    can_view_account,
    get_account_or_404,
    viewable_account_ids,
    viewable_accounts,
)
from app.core.redaction import serialize_account, serialize_accounts
from app.core.tags import (
    TAG_FILTER_HELP, effective_tag_criterion, filter_tag_id, own_tag_ids,
    replace_own_tags,
)
from app.models.account import Account, AccountType
from app.models.transaction import Transaction, TransactionType
from app.models.user import User
from app.schemas.account import AccountCreate, AccountResponse, AccountUpdate, AccountListResponse
from app.schemas.budget_entry import AutoPostPreview, AutoPostToggle, ForcedDateSet
from app.schemas.loan import LoanPaymentCreate, LoanPrepaymentCreate
from app.schemas.minimum_due import MinimumDuePresetOut, MinimumDueRule
from app.schemas.transaction import TransactionOut
from app.services import loans as loan_svc
from app.services import payment_dates, posting
from app.services.minimum_due import PRESETS as MINIMUM_DUE_PRESETS
from app.services.fx import FxRates, get_fx
from app.services.statements import (
    due_override_conflicts, load_due_overrides, resolve_cycle_fields,
)
from app.core.time import manila_day, manila_midnight, naive_utc_now, utc_now
from datetime import date, datetime, timedelta, timezone
from decimal import Decimal
from types import SimpleNamespace

router = APIRouter()


def _funding_account(
    db: Session, current_user: User, target_id: int, field: str, account_id: Optional[int] = None,
    owner=None,
) -> Account:
    """The account ``field`` names, if the caller may use it to fund a payment.

    Access is checked first (404), so the type rules never describe an account
    the caller cannot see: the caller needs an edit role on it, and with
    ``owner`` (an account's routing) it must be owned by that same user, since
    routing never points across owners. A funding account holds projection
    cash: not the paying account itself, a credit card (owed, not held), a
    spending wallet (already spent at top-up) or a loan (owed, not held).
    """
    if account_id is not None and target_id == account_id:
        raise HTTPException(status_code=400, detail=f"{field} cannot be the account itself")

    target = db.query(Account).filter(Account.id == target_id).first()
    if (not target or not can_edit_account(current_user, target)
            or (owner is not None and account_role(owner, target) != OWNER)):
        raise HTTPException(status_code=404, detail=f"{field} account not found")
    if target.account_type == AccountType.CREDIT:
        raise HTTPException(
            status_code=400,
            detail=f"{field} must be a funding account, not a credit card",
        )
    if target.account_type == AccountType.LOAN:
        raise HTTPException(
            status_code=400,
            detail=f"{field} must be a funding account, not a loan",
        )
    if target.is_spending_wallet:
        raise HTTPException(
            status_code=400,
            detail=f"{field} must be a funding account, not a spending wallet",
        )
    return target


def _validate_payment_routing(db: Session, current_user: User, data: dict,
                              account: Optional[Account] = None, owner=None) -> None:
    """Reject payment routing that points at accounts the caller can't use.

    Covers a card's statement payment / overflow account and a loan's payment
    account. A routing target must be owned by the account's owner (``owner``,
    default the caller), so a route never crosses owners. Without this, a caller
    could route a payment at an arbitrary account id and read that account's
    name back out of the timeline's ``account_shortfalls``. Also rejects
    self-routing, which would make an account fund its own payment, and (except
    for a loan, whose payer ``_validate_loan`` checks) a target in another
    currency than the account's.

    On an update (``account``) only a target that changes is checked: an admin's
    form resending a stored route they may not use (the owner's private payer)
    still saves, and learns nothing it was not already shown.
    """
    account_id = account.id if account is not None else None
    account_type = data.get("account_type", account.account_type if account else None)
    currency = data.get("currency", account.currency if account else None)
    for field in ("payment_account_id", "payment_overflow_account_id"):
        target_id = data.get(field)
        if target_id is None:
            continue
        if account is not None and target_id == getattr(account, field):
            continue
        target = _funding_account(db, current_user, target_id, field, account_id,
                                  owner=owner if owner is not None else current_user)
        # A loan's payer has its own currency rule (_validate_loan).
        if account_type != AccountType.LOAN and target.currency != currency:
            raise HTTPException(status_code=400, detail=ROUTING_CURRENCY_DETAIL)


# Payment and overflow routing never crosses currencies (a card is paid, and a
# shortfall covered, in the paying account's own currency). Names no account:
# the other side may be one the caller cannot access.
ROUTING_CURRENCY_DETAIL = (
    "Payment and overflow routing must stay within one currency: "
    "this would pair accounts in different currencies")


def _validate_currency_routing(db: Session, data: dict, account: Account) -> None:
    """Refuse a currency change that would pair this account across currencies.

    The pairings are a card's (or other non-loan account's) payment and
    overflow accounts, and a recurring entry's account and overflow account,
    whichever side this account is on (a loan's payer is ``_validate_loan`` and
    ``_validate_loan_payer``). Only a change of currency is checked; the
    routing fields themselves are checked when they change
    (``_validate_payment_routing``, and the entry routes).
    """
    from app.models.budget_entry import BudgetEntry

    currency = data.get("currency")
    if currency is None or currency == account.currency:
        return

    def differs(account_id) -> bool:
        other = db.get(Account, account_id) if account_id else None
        return other is not None and other.currency != currency

    if data.get("account_type", account.account_type) != AccountType.LOAN and any(
            differs(data.get(field, getattr(account, field)))
            for field in ("payment_account_id", "payment_overflow_account_id")):
        raise HTTPException(status_code=400, detail=ROUTING_CURRENCY_DETAIL)
    routed = db.query(Account).filter(
        Account.account_type != AccountType.LOAN,
        or_(Account.payment_account_id == account.id,
            Account.payment_overflow_account_id == account.id),
    ).all()
    if any(other.currency != currency for other in routed):
        raise HTTPException(status_code=400, detail=ROUTING_CURRENCY_DETAIL)
    entries = db.query(BudgetEntry).filter(
        BudgetEntry.overflow_account_id.isnot(None),
        or_(BudgetEntry.account_id == account.id,
            BudgetEntry.overflow_account_id == account.id),
    ).all()
    for entry in entries:
        other = (entry.overflow_account_id if entry.account_id == account.id
                 else entry.account_id)
        if other == account.id:
            continue
        if differs(other) or (other is None and entry.currency != currency):
            raise HTTPException(status_code=400, detail=ROUTING_CURRENCY_DETAIL)


SHARED_LIMIT_TARGET_DETAIL = "shares_limit_with_account_id account not found"
SHARED_LIMIT_UNLINK_DETAIL = "Unlink the shared credit limit first"


def _validate_shared_limit(db: Session, current_user: User, data: dict,
                           account: Optional[Account] = None, owner=None) -> None:
    """Check a card's link to another card's credit limit, and edits that would break one.

    A linked card (the secondary) points at the card holding the limit (the
    primary) and keeps no limit of its own; the primary points at nothing, so
    there are no chains or cycles. Every rule is judged on the resulting
    fields. On an update a link is checked only when it changes, as
    ``_validate_payment_routing`` does.

    Linking (to a target, from the account or the new card):

    - the target must be a card the caller manages and the account's owner
      (``owner``, default the caller) owns, or 404 without describing it;
    - not the card itself, both cards credit cards, both active, one currency,
      and the target holds a limit of its own (400);
    - the target is not linked itself, and no card is linked to this one (409);
    - the request carries no limit of its own (400); the stored one is cleared.

    While a card is linked, a limit of its own is refused (400). While a card
    is a primary, clearing its limit is refused (409). On either side, a change
    of currency or away from a credit card is refused (409), and so is
    deactivating it (409): unlink first, and the usual deactivation guards then
    apply. Unlinking (null) is any manager's of the linked card, and may set a
    limit in the same request.

    The caller locks every card the write touches first: the account and the
    target on an update, the target on a create, the account on a delete.
    """
    owner = owner if owner is not None else current_user

    def resolved(field, default=None):
        if field in data:
            return data[field]
        return getattr(account, field) if account is not None else default

    account_type = resolved("account_type")
    is_active = resolved("is_active", True)
    pointer = resolved("shares_limit_with_account_id")
    link_changes = "shares_limit_with_account_id" in data and (
        account is None or data["shares_limit_with_account_id"]
        != account.shares_limit_with_account_id)
    deactivating = data.get("is_active") is False and (account is None or account.is_active)
    currency_changes = (account is not None and "currency" in data
                        and data["currency"] != account.currency)
    leaves_credit = ("account_type" in data and account_type != AccountType.CREDIT)

    if link_changes and pointer is not None:
        if account is not None and pointer == account.id:
            raise HTTPException(status_code=400,
                                detail="A card cannot share its own credit limit")
        target = db.get(Account, pointer)
        if (target is None or account_role(current_user, target) not in MANAGE_ROLES
                or target.user_id != owner.id):
            raise HTTPException(status_code=404, detail=SHARED_LIMIT_TARGET_DETAIL)
        if account_type != AccountType.CREDIT or target.account_type != AccountType.CREDIT:
            raise HTTPException(status_code=400,
                                detail="Only a credit card can share another credit card's limit")
        if not target.is_active or not is_active:
            raise HTTPException(status_code=400,
                                detail="Both cards must be active to share a credit limit")
        if target.currency != resolved("currency"):
            raise HTTPException(status_code=400,
                                detail="Cards sharing a credit limit must be in one currency")
        if target.shares_limit_with_account_id is not None:
            raise HTTPException(
                status_code=409,
                detail="That card shares another card's limit; link to the card that holds it")
        if account is not None and db.query(Account.id).filter(
                Account.shares_limit_with_account_id == account.id).first():
            raise HTTPException(
                status_code=409,
                detail="Other cards share this card's limit, so it cannot share another's")
        if target.credit_limit is None:
            raise HTTPException(status_code=400,
                                detail="That card has no credit limit to share")
        if data.get("credit_limit") is not None:
            raise HTTPException(
                status_code=400,
                detail="A card that shares another card's limit has no limit of its own")
        data["credit_limit"] = None
        return

    if pointer is not None:
        # A linked card, its link unchanged.
        if data.get("credit_limit") is not None:
            primary = db.get(Account, pointer)
            if primary is not None and can_view_account(current_user, primary):
                detail = (f"This card shares its limit with {primary.name}; "
                          "change the limit there")
            else:
                detail = "This card shares another card's limit; change the limit there"
            raise HTTPException(status_code=400, detail=detail)
        if currency_changes or leaves_credit:
            raise HTTPException(
                status_code=409,
                detail="This card shares a credit limit; unlink it before changing its "
                       "currency or type")
        if deactivating:
            raise HTTPException(status_code=409, detail=SHARED_LIMIT_UNLINK_DETAIL)

    if account is None or not db.query(Account.id).filter(
            Account.shares_limit_with_account_id == account.id).first():
        return
    # A primary: other cards share its limit.
    if "credit_limit" in data and data["credit_limit"] is None:
        raise HTTPException(
            status_code=409,
            detail="Other cards share this card's limit; unlink them before removing it")
    if currency_changes or leaves_credit:
        raise HTTPException(
            status_code=409,
            detail="Other cards share this card's limit; unlink them before changing its "
                   "currency or type")
    if deactivating:
        raise HTTPException(status_code=409, detail=SHARED_LIMIT_UNLINK_DETAIL)


def _validate_spending_wallet(db: Session, data: dict, account: Optional[Account] = None) -> None:
    """Reject a spending-wallet flag that would leave a wallet funding something.

    A wallet is not projection cash, so it cannot be a credit card (whose balance is
    owed, not held), nor a funding account other routing draws on: a card's
    statement payment or overflow account, or a budget entry's overflow account.
    """
    from app.models.budget_entry import BudgetEntry

    is_wallet = data.get("is_spending_wallet", account.is_spending_wallet if account else False)
    if not is_wallet:
        return
    account_type = data.get("account_type", account.account_type if account else None)
    if account_type == AccountType.CREDIT:
        raise HTTPException(status_code=400, detail="A credit card cannot be a spending wallet")
    if account_type == AccountType.LOAN:
        raise HTTPException(status_code=400, detail="A loan cannot be a spending wallet")
    if account is None or account.is_spending_wallet:
        return
    routed = db.query(Account.id).filter(
        or_(Account.payment_account_id == account.id,
            Account.payment_overflow_account_id == account.id),
    ).first()
    overflow = db.query(BudgetEntry.id).filter(BudgetEntry.overflow_account_id == account.id).first()
    if routed or overflow:
        raise HTTPException(
            status_code=400,
            detail="This account funds a card payment or overflow routing; "
                   "remove that routing before marking it a spending wallet",
        )


def _validate_card_loan_payments(db: Session, current_user: User, data: dict,
                                 account: Account) -> None:
    """Keep a card that funds a pending payment into a loan billable.

    A transfer into a loan from a credit card is cash only through the card's
    statements, so a card without billing cycle settings may not fund one
    (``_loan_payment_source`` in routers/transactions.py). An update that would
    leave a card with no resolvable cycle (``resolve_cycle_fields``) while an
    unposted transfer into a loan is funded from it is refused: that payment
    would otherwise vanish from projected outflows. When the caller cannot
    access one of those loans, the message does not mention the loan.
    """
    if not any(f in data for f in ("account_type", "billing_cycle_start", "due_date")):
        return
    if data.get("account_type", account.account_type) != AccountType.CREDIT:
        return
    resolved = SimpleNamespace(**{
        f: data.get(f, getattr(account, f))
        for f in ("billing_cycle_start", "due_date", "days_until_due_date")})
    if resolve_cycle_fields(resolved) is not None:
        return
    loans = db.query(Account).join(
        Transaction, Transaction.transfer_to_account_id == Account.id,
    ).filter(
        Account.account_type == AccountType.LOAN,
        Transaction.transaction_type == TransactionType.TRANSFER,
        Transaction.transfer_from_account_id == account.id,
        Transaction.is_posted.is_(False),
    ).all()
    if not loans:
        return
    if any(not can_view_account(current_user, loan) for loan in loans):
        detail = ("This card funds a pending payment that needs its billing cycle settings; "
                  "keep a statement close or due day until that payment is posted or removed")
    else:
        detail = ("This card funds a pending loan payment, which needs its billing cycle "
                  "settings; keep a statement close or due day until that payment is posted "
                  "or removed")
    raise HTTPException(status_code=400, detail=detail)


CYCLE_FIELDS = ("billing_cycle_start", "due_date", "days_until_due_date")


def _has_open_installments(db: Session, account: Account) -> bool:
    """Whether any card installment on ``account`` still has payments left
    (``max_occurrences > 0``), active or paused, whoever created it."""
    from app.models.budget_entry import BudgetEntry
    from app.services.recurring_kinds import is_card_installment

    entries = db.query(BudgetEntry).filter(
        BudgetEntry.account_id == account.id, BudgetEntry.max_occurrences > 0).all()
    return any(is_card_installment(e, account) for e in entries)


def _refuse_cycle_identity_change(db: Session, data: dict, account: Account) -> None:
    """Keep a card's statement-keyed records attached to their statements.

    A printed due (``card_statement_due_overrides``) is keyed by its
    statement's close and was checked against the dues of the statements
    either side of it; a card installment is charged on the statement close
    (``recurring_kinds.is_normalised_installment``). With the fields merged as
    ``_validate_card_loan_payments`` merges them, an update is refused (409):

    - while the card has a card installment with payments left
      (``max_occurrences > 0``, active or paused, any creator's), when the
      resolved close day changes or the card stops having a cycle: an
      installment on the old close would stop being on a close, and a paused
      one would resume on the old day. A card gaining its first cycle is not
      a change (no installment can be on a close yet); a completed
      installment does not block;
    - while the card has a printed due, when the resolved close day changes,
      or the card stops having a cycle (no close or due day, or no longer a
      credit card): the overrides would no longer name a statement. A
      ``days_until_due_date`` change on a legacy card (only ``due_date`` set)
      moves its close, so it counts here;
    - while the card has a printed due, when a ``days_until_due_date`` change
      leaves one out of order against the recomputed dues of its neighbours
      (``statements.due_override_conflicts``).

    The card is locked by ``update_account`` before this runs, and a create
    of a card installment locks it too, so the two take turns.
    """
    if not any(f in data for f in ("account_type", *CYCLE_FIELDS)):
        return
    merged = SimpleNamespace(**{f: data.get(f, getattr(account, f)) for f in CYCLE_FIELDS})
    before = resolve_cycle_fields(account)
    after = (resolve_cycle_fields(merged)
             if data.get("account_type", account.account_type) == AccountType.CREDIT else None)
    close_moved = after is None or before is None or after[0] != before[0]
    if before is not None and close_moved and _has_open_installments(db, account):
        raise HTTPException(
            status_code=409,
            detail="This card has installments charged on its statement close with payments "
                   "left; its closing day can't change until they are paid off")
    overrides = load_due_overrides(db, [account.id])[account.id]
    if not overrides:
        return
    if close_moved:
        raise HTTPException(
            status_code=409,
            detail="This card has statement due dates entered from its statements; clear them "
                   "before changing its closing day")
    if due_override_conflicts(merged, overrides):
        raise HTTPException(
            status_code=409,
            detail="With these days until due, a statement due date entered from a statement "
                   "would fall on or past a neighbouring statement's due date; change or clear "
                   "it first")


def _validate_loan_payer(db: Session, current_user: User, data: dict, account: Account) -> None:
    """Keep an account that pays an active loan eligible to pay it.

    A loan's ``payment_account_id`` is checked when it is routed: a funding
    account (``_funding_account``: not a credit card, a loan or a spending
    wallet) in the loan's currency. An update to that account must not break
    either rule afterwards, nor deactivate it (``is_active`` False, as the
    soft delete does), or the loan would be projected from an account that can
    no longer pay it; the loan has to be re-routed first. When the caller
    cannot access one of those loans, the message does not mention the loan.
    """
    loans = db.query(Account).filter(
        Account.account_type == AccountType.LOAN,
        Account.is_active.is_(True),
        Account.payment_account_id == account.id,
    ).all()
    if not loans:
        return
    account_type = data.get("account_type", account.account_type)
    wallet = data.get("is_spending_wallet", account.is_spending_wallet)
    ineligible = (("account_type" in data or "is_spending_wallet" in data)
                  and (account_type in (AccountType.CREDIT, AccountType.LOAN) or wallet))
    currency_mismatch = ("currency" in data
                         and any(loan.currency != data["currency"] for loan in loans))
    deactivated = data.get("is_active") is False and account.is_active
    if not (ineligible or currency_mismatch or deactivated):
        return
    if any(not can_view_account(current_user, loan) for loan in loans):
        raise HTTPException(
            status_code=400,
            detail="This account is the payment account of an account you cannot access, "
                   "so it must stay an active funding account in the same currency; "
                   "that account's payment account has to change first",
        )
    if deactivated:
        raise HTTPException(
            status_code=400,
            detail="This account pays a loan; re-route the loan's payment account "
                   "before deactivating it",
        )
    if ineligible:
        raise HTTPException(
            status_code=400,
            detail="This account pays a loan, which needs a funding account (not a credit "
                   "card, loan or spending wallet); re-route the loan's payment account first",
        )
    if currency_mismatch:
        raise HTTPException(
            status_code=400,
            detail="This account pays a loan in another currency; "
                   "re-route the loan's payment account first",
        )


# Refusals for deactivating an account that still carries an obligation. Only the
# owner may deactivate (OWNER_ROLES, checked first), and none of these names a
# record, an account or an amount: a pending payment may have been entered by
# a sharee, or go to an account the owner cannot see.
CARD_PENDING_PAYMENT_DETAIL = (
    "This card funds a pending payment; post or remove that payment "
    "before deactivating the card")
CARD_RECURRING_ENTRY_DETAIL = (
    "This card has an active recurring entry; end it or move it to another account "
    "before deactivating the card")
CARD_OPEN_STATEMENT_DETAIL = (
    "This card has an unpaid statement balance; pay it in full "
    "before deactivating the card")
LOAN_PENDING_PAYMENT_DETAIL = (
    "This loan has a pending or recurring payment; post or remove the pending payment "
    "and end the recurring one before deactivating the loan")


def _start_of_today() -> datetime:
    """The projection's window start (``_upcoming_window``): Manila today at midnight."""
    return manila_midnight()


def _validate_deactivation(db: Session, current_user: User, data: dict,
                           account: Account) -> None:
    """Refuse deactivating a card or loan that still has an obligation on it.

    Applies when ``is_active`` goes from True to False (an update or the soft
    delete); the caller is already known to be the owner. Judged by the
    account's stored type, which is what the obligations were recorded against.

    - A card funding a pending payment into a loan: an unposted transfer from
      the card into a loan, whoever entered it and whatever the loan's state
      (``_validate_card_loan_payments`` reads the same rows). Recurring entries
      are not checked: a recurring transfer cannot be funded from a card
      (``_validate_transfer_destination`` in routers/budget_entries.py).
    - A card with an active recurring entry: an active budget entry scheduled
      on the card (not a recurring transfer), an expense or an income (a credit
      or cashback), that the projection still bills, as the projection itself
      computes it (``card_entries_still_bill`` in services/forecast.py, from the
      start of today and with no window end). On a card with cycle settings
      that is ``_card_entry_charges``: an occurrence before today still billed
      on a statement not yet due (an entry that ended recently still owes it),
      or any occurrence from today on, either way unless a linked transaction
      stands for it (a materialised occurrence is a recorded row, judged by the
      statement check below). A reviewed card installment's unrecorded months
      are billed even when their statement is already due (STU-343 Plan B), so
      a card cannot be closed while such a month is still owed. On a card
      without cycle settings, where the projection lists each occurrence as an
      event on the card, it is any occurrence from today on that no linked
      transaction stands for. Once the card is inactive their legs drop, so
      either is refused.
    - A card with an open statement: any statement in ``statement_summaries``
      that still owes something after payments ("open" or "overdue"). That
      includes the cycle open today and later ones, posted and unposted
      recorded charges alike; recurring occurrences not yet recorded are not
      in it, hence the check above. Payments are netted as ``allocate_payments``
      nets them, planned ones included, so an unposted transfer into the card
      that covers what is owed counts as paying it. A card without cycle
      settings has no statements, so nothing here refuses it. A statement
      with a line in a currency that has no stored rate (``unconverted``)
      is refused too: its balance is not known (STU-236, plan D5).
    - A loan with a pending payment: an unposted transfer into it (a planned
      payment or prepayment), or an active recurring entry paying into it that
      still has an occurrence from today on that no linked transaction stands
      for (``has_unsuppressed_occurrence``, the loan-cover walk in
      ``collect_events``, which starts at today: an installment's unrecorded
      overdue occurrence counts as due today, while an open-ended entry's
      missed occurrences, a schedule that has ended, or a last occurrence
      recorded without advancing it, project nothing); both are projected
      against its due dates
      (services/loans.py).
    """
    from app.models.budget_entry import BudgetEntry
    from app.services.forecast import card_entries_still_bill, has_unsuppressed_occurrence
    from app.services.statements import statement_summaries

    if not (data.get("is_active") is False and account.is_active):
        return
    if account.account_type == AccountType.CREDIT:
        pending = db.query(Transaction.id).join(
            Account, Account.id == Transaction.transfer_to_account_id,
        ).filter(
            Account.account_type == AccountType.LOAN,
            Transaction.transaction_type == TransactionType.TRANSFER,
            Transaction.transfer_from_account_id == account.id,
            Transaction.is_posted.is_(False),
        ).first()
        if pending:
            raise HTTPException(status_code=400, detail=CARD_PENDING_PAYMENT_DETAIL)
        entries = db.query(BudgetEntry).filter(
            BudgetEntry.account_id == account.id,
            BudgetEntry.transfer_to_account_id.is_(None),
            BudgetEntry.is_active.is_(True),
        ).all()
        if card_entries_still_bill(db, account, entries, _start_of_today()):
            raise HTTPException(status_code=400, detail=CARD_RECURRING_ENTRY_DETAIL)
        # ``incomplete`` is True from the first statement with an unconverted
        # line onward, so any() over it is "some statement left a line out".
        history = statement_summaries(db, account, manila_midnight(),
                                      viewable_account_ids(db, current_user))
        if any(statement["owed"] > 0 or statement["incomplete"] for statement in history):
            raise HTTPException(status_code=400, detail=CARD_OPEN_STATEMENT_DETAIL)
    elif account.account_type == AccountType.LOAN:
        pending = db.query(Transaction.id).filter(
            Transaction.transaction_type == TransactionType.TRANSFER,
            Transaction.transfer_to_account_id == account.id,
            Transaction.is_posted.is_(False),
        ).first()
        recurring = has_unsuppressed_occurrence(db, db.query(BudgetEntry).filter(
            BudgetEntry.transfer_to_account_id == account.id,
            BudgetEntry.is_active.is_(True),
        ).all(), _start_of_today())
        if pending or recurring:
            raise HTTPException(status_code=400, detail=LOAN_PENDING_PAYMENT_DETAIL)


LOAN_FIELDS = (
    "loan_kind", "loan_annual_rate", "loan_term_months", "loan_payment_amount",
    "loan_first_payment_date", "loan_amortization", "loan_payments_made_offset",
)


def _validate_loan(db: Session, data: dict, account: Optional[Account] = None) -> None:
    """Check loan terms against the account's resulting type; default the amortisation.

    A loan needs a ``loan_kind``; its amortisation defaults by kind (home loans
    shorten the term on prepayment, others follow the bank's fixed schedule).
    Loan terms are rejected on any other account type. An account that routing
    draws on (a card's statement payment or overflow, a loan's payment account,
    a budget entry's account or overflow) cannot become a loan: a loan holds no
    cash to fund them. A loan's paying account must be in the loan's currency,
    as every payment from it is (``loan_svc.check_currency``).
    """
    from app.models.budget_entry import BudgetEntry

    def resolved(field):
        if field in data:
            return data[field]
        return getattr(account, field) if account is not None else None

    account_type = resolved("account_type")
    if account_type != AccountType.LOAN:
        if any(resolved(field) is not None for field in LOAN_FIELDS):
            raise HTTPException(status_code=400, detail="Loan terms apply only to loan accounts")
        return

    kind = resolved("loan_kind")
    if kind is None:
        raise HTTPException(
            status_code=400,
            detail="A loan account needs a loan_kind (personal, auto or home)",
        )
    if resolved("loan_amortization") is None:
        data["loan_amortization"] = loan_svc.default_amortization(kind)
    payment_account_id = resolved("payment_account_id")
    if payment_account_id is not None:
        payer = db.query(Account).filter(Account.id == payment_account_id).first()
        if payer is not None and payer.currency != resolved("currency"):
            raise HTTPException(
                status_code=400,
                detail="A loan's payment account must be in the loan's currency",
            )

    if account is None or account.account_type == AccountType.LOAN:
        return
    routed = db.query(Account.id).filter(
        or_(Account.payment_account_id == account.id,
            Account.payment_overflow_account_id == account.id),
    ).first()
    entry = db.query(BudgetEntry.id).filter(
        or_(BudgetEntry.account_id == account.id,
            BudgetEntry.overflow_account_id == account.id),
    ).first()
    if routed or entry:
        raise HTTPException(
            status_code=400,
            detail="This account funds a payment, budget entry or overflow routing; "
                   "remove that routing before making it a loan",
        )


def _validate_minimum_due_rule(data: dict, rule: Optional[MinimumDueRule],
                               account: Optional[Account] = None) -> None:
    """Store a validated rule as JSON; only a credit card may hold one.

    ``rule`` is the request's parsed ``MinimumDueRule`` (``data`` holds its plain
    dump). It is stored as ``rule.model_dump(mode="json")``, so its Decimals are
    strings. A rule on an account whose resulting type is not a credit card is
    refused, including a stored rule left on a card being changed to another type.
    """
    if "minimum_due_rule" in data:
        data["minimum_due_rule"] = rule.model_dump(mode="json") if rule is not None else None
        stored = data["minimum_due_rule"]
    else:
        stored = account.minimum_due_rule if account is not None else None
    account_type = data.get("account_type", account.account_type if account else None)
    if stored is not None and account_type != AccountType.CREDIT:
        raise HTTPException(status_code=400, detail="Only a credit card has a minimum due rule")


@router.get("/", response_model=AccountListResponse)
def get_accounts(
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_active_user),
    account_type: Optional[str] = Query(None, description="Filter by account type"),
    is_active: Optional[bool] = Query(None, description="Filter by active status"),
    tag: Optional[int] = Query(None, description=TAG_FILTER_HELP),
    limit: int = Query(10, ge=1, le=1000),
    offset: int = Query(0, ge=0),
):
    """Get all accounts with optional filtering.

    Includes the accounts reached through a Household tag share (``my_role``
    "tag_viewer", the minimal shape), active ones only.
    """
    direct = viewable_accounts(db, current_user).with_entities(Account.id)
    query = viewable_accounts(db, current_user, roles=VIEW_ROLES).filter(
        or_(Account.id.in_(direct), Account.is_active.is_(True)))

    if account_type:
        # Convert string to enum
        try:
            account_type_enum = AccountType(account_type.lower())
            query = query.filter(Account.account_type == account_type_enum)
        except ValueError:
            raise HTTPException(status_code=400, detail=f"Invalid account type: {account_type}")
    
    if is_active is not None:
        query = query.filter(Account.is_active == is_active)
    tag_id = filter_tag_id(db, current_user, tag)
    if tag_id is not None:
        query = query.filter(effective_tag_criterion(Account, tag_id))

    total = query.count()
    accounts = (
        query.order_by(Account.created_at.desc(), Account.id.desc())
        .offset(offset)
        .limit(limit)
        .all()
    )
    has_more = offset + len(accounts) < total
    return {"items": serialize_accounts(db, current_user, accounts), "total": total,
            "has_more": has_more}

@router.get("/minimum-due-presets", response_model=List[MinimumDuePresetOut])
def get_minimum_due_presets(current_user: User = Depends(get_current_active_user)):
    """The bank presets for a card's minimum due rule (``app/services/minimum_due.py``).

    Each is ``{key, label, effective_from, rule}``; the rule's Decimals are strings.
    ``effective_from`` is empty when the bank's wording names no date.
    """
    return [preset.served() for preset in MINIMUM_DUE_PRESETS.values()]


@router.post("/", response_model=AccountResponse)
def create_account(
    account: AccountCreate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_active_user),
):
    """Create a new account"""
    account_data = account.dict()
    # The caller's own tags only (404 otherwise); linked once the account exists.
    tag_ids = own_tag_ids(db, current_user, account_data.pop("tag_ids", None) or [])

    # The target is locked first, so a link to it and its own edits take turns.
    locking.lock_accounts(db, [account_data.get("shares_limit_with_account_id")])

    _validate_payment_routing(db, current_user, account_data)
    _validate_shared_limit(db, current_user, account_data)
    _validate_spending_wallet(db, account_data)
    _validate_loan(db, account_data)
    _validate_minimum_due_rule(account_data, account.minimum_due_rule)

    db_account = Account(**account_data, user_id=current_user.id)
    db.add(db_account)
    db.flush()
    if tag_ids:
        replace_own_tags(db, Account, db_account.id, current_user, tag_ids)
    db.commit()
    db.refresh(db_account)
    return serialize_account(db, current_user, db_account)

@router.get("/{account_id}", response_model=AccountResponse)
def get_account(account_id: int, db: Session = Depends(get_db), current_user: User = Depends(get_current_active_user)):
    """Get a specific account by ID (any role, ``tag_viewer`` included)."""
    return serialize_account(db, current_user, get_account_or_404(
        db, current_user, account_id, roles=VIEW_ROLES))

@router.put("/{account_id}", response_model=AccountResponse)
def update_account(account_id: int, account_update: AccountUpdate, db: Session = Depends(get_db), current_user: User = Depends(get_current_active_user)):
    """Update an existing account (settings and routing: owner or admin; deactivating: owner)"""
    db_account = get_account_or_404(db, current_user, account_id, roles=MANAGE_ROLES)
    update_data = account_update.dict(exclude_unset=True)
    # Locked before any validation, field write or tag-link write, whatever the edit
    # (STU-226): a tags-only edit that deleted its link rows first and wanted the
    # account only at commit would deadlock with a balance edit holding it. A
    # shared-limit link locks its target in the same call (ascending id), so two
    # links that would make a chain or a cycle take turns.
    db_account = locking.lock_accounts(
        db, [db_account.id, update_data.get("shares_limit_with_account_id")])[db_account.id]

    # Tags: the caller's own only, on an account whose settings they may change.
    tag_ids = update_data.pop("tag_ids", None)
    if tag_ids is not None:
        tag_ids = own_tag_ids(db, current_user, tag_ids)
    # Deactivating (or reactivating) is the owner's alone; an admin's form that
    # resends the stored value unchanged still saves.
    if ("is_active" in update_data and update_data["is_active"] != db_account.is_active
            and account_role(current_user, db_account) not in OWNER_ROLES):
        raise HTTPException(status_code=404, detail="Account not found")
    _validate_payment_routing(db, current_user, update_data, account=db_account,
                              owner=db_account.user)
    _validate_shared_limit(db, current_user, update_data, account=db_account,
                           owner=db_account.user)
    _validate_currency_routing(db, update_data, db_account)
    _validate_loan_payer(db, current_user, update_data, db_account)
    _validate_deactivation(db, current_user, update_data, db_account)
    _validate_card_loan_payments(db, current_user, update_data, db_account)
    _refuse_cycle_identity_change(db, update_data, db_account)
    _validate_spending_wallet(db, update_data, db_account)
    _validate_loan(db, update_data, db_account)
    _validate_minimum_due_rule(update_data, account_update.minimum_due_rule, db_account)
    stored_first = db_account.loan_first_payment_date
    stored_terms = loan_svc.due_terms(db_account)
    for field, value in update_data.items():
        setattr(db_account, field, value)
    # Every due date moves, so no forced date still stands for one.
    if db_account.loan_first_payment_date != stored_first:
        payment_dates.clear_all(db, loan_account_id=db_account.id)
    # Past due dates post only with a confirmed count: turning it back on asks.
    if db_account.auto_post_enabled and loan_svc.opens_due_dates(
            stored_terms, loan_svc.due_terms(db_account)):
        db_account.auto_post_enabled = False

    db_account.updated_at = utc_now()
    if tag_ids is not None:
        replace_own_tags(db, Account, db_account.id, current_user, tag_ids)
    db.commit()
    db.refresh(db_account)
    return serialize_account(db, current_user, db_account)

@router.delete("/{account_id}")
def delete_account(account_id: int, db: Session = Depends(get_db), current_user: User = Depends(get_current_active_user)):
    """Soft delete an account (mark as inactive). Owner only."""
    db_account = get_account_or_404(db, current_user, account_id, roles=OWNER_ROLES)
    # Locked before any check, as an update is: a shared-limit link to or from
    # this card locks it too, so the two take turns.
    db_account = locking.lock_accounts(db, [db_account.id])[db_account.id]
    _validate_shared_limit(db, current_user, {"is_active": False}, db_account,
                           owner=db_account.user)
    _validate_loan_payer(db, current_user, {"is_active": False}, db_account)
    _validate_deactivation(db, current_user, {"is_active": False}, db_account)

    db_account.is_active = False
    db_account.updated_at = utc_now()
    db.commit()
    return {"message": "Account deleted successfully"}

@router.get("/{account_id}/balance")
def get_account_balance(account_id: int, db: Session = Depends(get_db), current_user: User = Depends(get_current_active_user)):
    """Current balance and balance history for an account.

    Each history entry carries ``view``. One for a row the caller sees in full
    (``full`` or ``shared_full``, see app/core/redaction.py) is ``{date, amount,
    balance_after, balance, transaction_id, display_description}``; any other
    is the limited allowlist ``{date, amount, balance_after,
    display_description}``. ``amount`` is the row's signed effect on this
    account: a transfer's source moves by ``amount + transfer_fee``, its
    destination by ``received_amount`` (or ``amount`` when that is null).

    A ``tag_viewer`` (Household tag share) gets the history of the rows it may
    read only, the sharer's own (the tag-share invariant): ``balance_after``
    and ``calculated_balance`` then run over those rows alone.
    """
    from app.core.redaction import FULL, SHARED_FULL, Redactor
    from app.models.transaction import Transaction, TransactionType, transfer_sides

    account = get_account_or_404(db, current_user, account_id, roles=VIEW_ROLES)
    transactions = db.query(Transaction).filter(
        or_(
            Transaction.account_id == account_id,
            Transaction.transfer_from_account_id == account_id,
            Transaction.transfer_to_account_id == account_id
        )
    ).order_by(Transaction.transaction_date, Transaction.id).all()
    redactor = Redactor(db, current_user)
    redactor.prepare(transactions)
    if account_role(current_user, account) == TAG_VIEWER:
        transactions = [t for t in transactions if redactor.access.readable(t)]

    balance_history = []
    running_balance = 0.0
    for transaction in transactions:
        if not transaction.is_posted:
            continue

        if transaction.transaction_type == TransactionType.CREDIT and transaction.account_id == account_id:
            effect = float(transaction.amount)
        elif transaction.transaction_type == TransactionType.DEBIT and transaction.account_id == account_id:
            effect = -float(transaction.amount)
        elif transaction.transaction_type == TransactionType.TRANSFER:
            # Each side by its own figure (a cross-currency transfer's differ).
            out, received = transfer_sides(transaction)
            if transaction.transfer_from_account_id == account_id:
                effect = -float(out)
            elif transaction.transfer_to_account_id == account_id:
                effect = float(received)
            else:
                continue
        else:
            continue
        running_balance += effect

        facts = redactor.access.facts(transaction)
        view = redactor.view(transaction, facts)
        entry = {
            "view": view,
            "date": transaction.transaction_date,
            "amount": effect,
            "balance_after": running_balance,
            "display_description": redactor.display_description(transaction, facts),
        }
        if view in (FULL, SHARED_FULL):
            entry.update({"balance": running_balance, "transaction_id": transaction.id})
        else:
            entry["view"] = "limited"
        balance_history.append(entry)

    return {
        "account_id": account_id,
        "current_balance": account.balance,
        "calculated_balance": running_balance,
        "balance_history": balance_history
    }


@router.get("/{account_id}/statements")
def get_card_statements(
    account_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_active_user),
    fx: FxRates = Depends(get_fx),
):
    """A credit card's statements, oldest first, through the one closing next.

    Any role on the card. An owner, admin or editor gets each statement's
    ``statement_balance`` and its lines with ``transaction_id``; a viewer gets
    the limited statement: ``{close_date, due_date, amount_due, currency,
    status, lines: [{date, display_description, amount}]}``. Line descriptions
    follow the description rule (app/core/redaction.py). ``status`` is "paid",
    "open" or "overdue". A full line carries ``posted_date`` (a Manila day) when
    its row is posted on a day other than its own; the limited line never does.

    Lines are in the card's currency (STU-236, plan D5). In the full view a
    line estimated from a foreign figure carries the estimate labels when the
    caller reads its row in full, and a line with no stored rate is left out
    of the totals and listed under ``unconverted_lines`` with its original
    figure. In the limited view such a line is omitted. Either view's
    statement carries ``incomplete: true`` when a line was left out for want
    of a rate (the key is absent otherwise).
    """
    from app.core.redaction import FULL, SHARED_FULL, Redactor
    from app.services.forecast import _row, row_labels
    from app.services.statements import statement_history

    card = get_account_or_404(db, current_user, account_id)
    if card.account_type != AccountType.CREDIT:
        raise HTTPException(status_code=400, detail="Account is not a credit card")
    role = account_role(current_user, card)
    limited = role not in EDIT_ROLES
    history = statement_history(db, card, manila_midnight(),
                                viewable_account_ids(db, current_user), fx=fx)
    redactor = Redactor(db, current_user)
    redactor.prepare([line["transaction"] for s in history
                      for line in [*s["lines"], *s["unconverted"]]])
    card_currency = card.currency.value
    statements = []
    for statement in history:
        lines = []
        for line in statement["lines"]:
            txn = line["transaction"]
            item = {"date": line["date"], "amount": float(line["amount"]),
                    "display_description": redactor.display_description(txn)}
            if not limited:
                item["transaction_id"] = txn.id
                posted = manila_day(txn.posting_date) if txn.is_posted and txn.posting_date else None
                if posted is not None and posted != txn.transaction_date.date():
                    item["posted_date"] = posted
                if "estimate" in line and redactor.view(txn) in (FULL, SHARED_FULL):
                    item.update(row_labels(_row(card_currency, abs(line["amount"]),
                                                line["estimate"])))
            lines.append(item)
        row = {
            "close_date": statement["close"],
            "due_date": statement["due"],
            "amount_due": float(statement["owed"]),
            "currency": card.currency,
            "status": statement["status"],
            "lines": lines,
        }
        if statement["unconverted"]:
            # Present only when a line was left out, so a statement with every
            # line converted keeps the epic's shape.
            row["incomplete"] = True
        if not limited:
            row["statement_balance"] = float(statement["balance"])
            row["unconverted_lines"] = [{
                "date": line["date"],
                "amount": None,
                "unconverted": True,
                "original_amount": float(line["original_amount"]),
                "original_currency": line["original_currency"],
                "display_description": redactor.display_description(line["transaction"]),
                "transaction_id": line["transaction"].id,
            } for line in statement["unconverted"]]
        statements.append(row)
    body = {"view": "limited" if limited else "full", "name": card.name,
            "currency": card.currency, "statements": statements}
    if not limited:
        body["account_id"] = card.id
    return body


# --- Loans -------------------------------------------------------------------

def _loan_or_404(db: Session, current_user: User, account_id: int, *, edit: bool = False,
                 manage: bool = False) -> Account:
    """The loan, 404ing unless the caller holds a role on it (an edit role with
    ``edit``, an owner's or admin's with ``manage``)."""
    roles = MANAGE_ROLES if manage else EDIT_ROLES if edit else DIRECT_ROLES
    account = get_account_or_404(db, current_user, account_id, roles=roles)
    if account.account_type != AccountType.LOAN:
        raise HTTPException(status_code=400, detail="Account is not a loan")
    return account


def _loan_funding(db: Session, current_user: User, loan: Account,
                  from_account_id: Optional[int]) -> Account:
    """The account paying the loan: the request's, else the loan's payment account."""
    target_id = from_account_id or loan.payment_account_id
    if target_id is None:
        raise HTTPException(
            status_code=400,
            detail="No funding account: pass from_account_id or set the loan's payment_account_id",
        )
    return _funding_account(db, current_user, target_id, "from_account_id", loan.id)


def _lock(db: Session, *accounts: Account) -> None:
    """``SELECT ... FOR NO KEY UPDATE`` each account, in ascending id order, refreshing it.

    Owed amounts, splits and balances are then computed from rows no concurrent
    payment can change until this one commits. A fixed lock order keeps two
    payments over the same pair of accounts from deadlocking. The mode and order
    are every ledger write's (``app.core.locking.lock_accounts``), so re-locking
    an account a transaction write already holds changes nothing.
    """
    locking.lock_accounts(db, [a.id for a in accounts])


def _when(value: Optional[datetime]) -> datetime:
    """Naive UTC, as transaction_date is stored."""
    if value is None:
        return naive_utc_now()
    return value.astimezone(timezone.utc).replace(tzinfo=None) if value.tzinfo else value


def _cents(value: Optional[Decimal]) -> Optional[Decimal]:
    """The normalised money value (whole cents) used for every check and write."""
    try:
        return loan_svc.cents(value)
    except loan_svc.LoanError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


def _record(db: Session, current_user: User, loan: Account, funding: Account,
            principal: Decimal, interest: Decimal, kind: str, body) -> Transaction:
    try:
        txn = loan_svc.record_payment(
            db, user_id=current_user.id, loan=loan, funding=funding,
            principal=principal, interest=interest, kind=kind,
            when=_when(body.transaction_date), is_posted=body.is_posted,
            description=body.description,
        )
    except loan_svc.LoanError as exc:
        db.rollback()
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    db.commit()
    db.refresh(txn)
    from app.core.redaction import serialize_transaction
    return serialize_transaction(db, current_user, txn)


@router.post("/{account_id}/loan-payment", response_model=TransactionOut)
def record_loan_payment(
    account_id: int,
    payment: LoanPaymentCreate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_active_user),
):
    """Record a scheduled payment: one transfer, principal as amount, interest as fee.

    The bank's figures (principal / interest) override the proposed split.
    """
    loan = _loan_or_404(db, current_user, account_id, edit=True)
    funding = _loan_funding(db, current_user, loan, payment.from_account_id)
    _lock(db, loan, funding)
    total, principal, interest = (
        _cents(payment.amount), _cents(payment.principal), _cents(payment.interest))
    if None not in (total, principal, interest) and principal + interest != total:
        raise HTTPException(status_code=400, detail="principal + interest must equal amount")
    try:
        principal, interest = loan_svc.propose_split(
            loan, total=total, principal=principal, interest=interest)
    except loan_svc.LoanError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return _record(db, current_user, loan, funding, principal, interest, loan_svc.SCHEDULED, payment)


@router.post("/{account_id}/loan-prepayment", response_model=TransactionOut)
def record_loan_prepayment(
    account_id: int,
    prepayment: LoanPrepaymentCreate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_active_user),
):
    """Record extra principal (no interest). Refused on a ``fixed`` loan.

    The funding account is checked first, so a caller who may not use it gets
    the same 404 whatever the loan's amortisation (which the loan's terms hide
    from an editor).
    """
    loan = _loan_or_404(db, current_user, account_id, edit=True)
    funding = _loan_funding(db, current_user, loan, prepayment.from_account_id)
    if loan_svc.amortization_of(loan) == loan_svc.FIXED:
        raise HTTPException(
            status_code=400,
            detail="Prepayment is not available on a fixed loan (its schedule is the bank's)",
        )
    _lock(db, loan, funding)
    if loan_svc.amortization_of(loan) == loan_svc.FIXED:  # re-read under the lock
        db.rollback()
        raise HTTPException(
            status_code=400,
            detail="Prepayment is not available on a fixed loan (its schedule is the bank's)",
        )
    return _record(db, current_user, loan, funding, _cents(prepayment.amount), Decimal("0"),
                   loan_svc.PREPAYMENT, prepayment)


def _locked_loan(db: Session, current_user: User, account_id: int) -> Account:
    """The loan, locked in the ledger's order and checked for an edit role.

    The owner's budget lock, then the loan, so a forced date and a payment of
    the loan queue on the same rows. The access check runs again on what the
    locks read: a demotion committed while the caller waited is seen.
    """
    loan = _loan_or_404(db, current_user, account_id, edit=True)
    locking.lock_owner_budgets(db, loan.user_id)
    db.expire_all()
    locking.lock_accounts(db, [account_id])
    return _loan_or_404(db, current_user, account_id, edit=True)


def _due_neighbours(db: Session, loan: Account, step: int) -> tuple:
    """The effective dates of the due dates either side of ``step``. Read from
    the schedule rather than the open list: a due date before it may reopen if a
    payment is deleted, and one after it may appear if the term grows."""
    moved = payment_dates.load_loan_overrides(db, [loan.id]).get(loan.id)
    first = loan.loan_first_payment_date
    previous = (payment_dates.effective(moved, loan_svc.due_date(first, step - 1))
                if step > 0 else None)
    return previous, payment_dates.effective(moved, loan_svc.due_date(first, step + 1))


@router.put("/{account_id}/loan-due-dates/{day}/date")
def set_loan_due_date(
    account_id: int,
    day: date,
    body: ForcedDateSet,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_active_user),
):
    """Force a loan's scheduled due date ``day`` onto another date.

    The due date keeps ``day`` as its identity, for settling and covers; the
    forced date decides when it is due, shown and overdue. The scheduled date
    itself clears it. An edit role on the loan (404 otherwise).

    409 when ``settle_posted`` has allocated money to the due date: its payment
    is the record, and its date the transaction's. 422 unless ``day`` is an open
    due date, and on a date more than 31 days from ``day``, not strictly between
    the dates of the due dates either side, or outside the record dates.
    Returns ``{occurrence_date, effective_date}``.
    """
    loan = _locked_loan(db, current_user, account_id)
    step = loan_svc.due_step(loan, day)
    state = loan_svc.settle_posted(loan, loan_svc._payments_into(db, loan))
    if step is not None and loan_svc.money_allocated(loan, state, step):
        raise HTTPException(
            status_code=409,
            detail="Money is already allocated to this due date; change the payment's date")
    midnight = datetime(day.year, day.month, day.day)
    if day not in {due for _, due, _ in loan_svc.due_dates(db, loan, midnight + timedelta(days=1))}:
        raise HTTPException(status_code=422, detail="Not an open due date of this loan")
    previous, following = _due_neighbours(db, loan, step)
    forced = body.effective_date
    if forced == day:
        _clear_due_date(db, loan, step, day)
    else:
        payment_dates.refuse_forced_date(day, forced, previous, following)
        payment_dates.set_override(db, current_user.id, day, forced, loan_account_id=loan.id)
    db.commit()
    return {"occurrence_date": day, "effective_date": forced}


def _clear_due_date(db: Session, loan: Account, step: Optional[int], day: date) -> None:
    """Clear the forced date on ``day`` if there is one, a 409 when the neighbours
    were forced so that ``day`` would no longer fall between them."""
    moved = payment_dates.load_loan_overrides(db, [loan.id]).get(loan.id, {})
    if step is not None and day in moved:
        previous, following = _due_neighbours(db, loan, step)
        if not payment_dates.in_order(previous, day, following):
            raise HTTPException(status_code=409, detail=payment_dates.CLEAR_OUT_OF_ORDER)
    payment_dates.clear_override(db, day, loan_account_id=loan.id)


@router.delete("/{account_id}/loan-due-dates/{day}/date", status_code=204)
def clear_loan_due_date(
    account_id: int,
    day: date,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_active_user),
):
    """Put a loan's due date back on its scheduled date.

    The same access and locks as the PUT; 204 whether or not one was set. 409
    when a neighbour is forced so that the scheduled date would no longer fall
    between them.
    """
    loan = _locked_loan(db, current_user, account_id)
    _clear_due_date(db, loan, loan_svc.due_step(loan, day), day)
    db.commit()
    return Response(status_code=204)


LOAN_BLOCK_MESSAGES = {
    "inactive": "This loan is closed",
    "no_funding_account": "Set a payment account on this loan to settle it by autopay",
    "no_access": "You can't pay this loan from its payment account",
    "no_schedule": "Set this loan's first payment date and payment amount to settle it by autopay",
    "no_rate": "Set this loan's interest rate to settle it by autopay",
    "foreign_currency": "This loan's payment account is in another currency, "
                        "so it can't settle by autopay",
    "recurring_entry": "A recurring transfer already pays this loan; end it first, "
                       "or autopay would pay it twice",
}


@router.get("/{account_id}/auto-post-preview", response_model=AutoPostPreview)
def get_loan_auto_post_preview(
    account_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_active_user),
):
    """What turning autopay on would do: its ``block``, or the ``due_count`` to
    confirm and the ``oldest`` due date (``posting.loan_autopay_preview``). The
    flag is an owner's or admin's; anyone else gets 404."""
    loan = _loan_or_404(db, current_user, account_id, manage=True)
    return posting.loan_autopay_preview(db, loan, current_user)


@router.post("/{account_id}/auto-post", response_model=AccountResponse)
def set_loan_auto_post(
    account_id: int,
    payload: AutoPostToggle,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_active_user),
):
    """Turn a loan's autopay on or off. Off never posts or changes history.

    On: a ``posting.loan_block`` is a 400 with its reason, ``expected_due`` must
    match the due count (``GET .../auto-post-preview``), else a 409, and the same
    commit then sets the flag and posts each due date on its own day, as the job
    would (``posting.turn_on_loan_autopay``); a funds or planned-payment stop
    leaves the flag on and the rest flagged. An owner or admin, under the owner
    and account locks; anyone else gets 404. The role is checked again on what the
    locks read.
    """
    loan = _loan_or_404(db, current_user, account_id, manage=True)
    if posting.lock_loan(db, account_id, loan.user_id) is None:
        raise HTTPException(status_code=409, detail=posting.LOAN_CHANGED)
    loan = _loan_or_404(db, current_user, account_id, manage=True)
    if payload.enabled:
        block = posting.loan_block(db, loan, current_user)
        if block is not None:
            raise HTTPException(status_code=400, detail=LOAN_BLOCK_MESSAGES[block])
        posting.turn_on_loan_autopay(db, loan, current_user, payload.expected_due)
    else:
        loan.auto_post_enabled = False
        loan.updated_at = utc_now()
    db.commit()
    db.refresh(loan)
    return serialize_account(db, current_user, loan)


# Schedule fields built from the loan's terms, and its settlement flag: shown to
# its owner and admins only.
LOAN_TERM_SCHEDULE_FIELDS = ("annual_rate", "payment_amount", "term_months",
                             "first_payment_date", "amortization", "proposed_split",
                             "settlement")


@router.get("/{account_id}/loan-schedule")
def get_loan_schedule(
    account_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_active_user),
):
    """The loan's owed amount, payments made / left, next due date and upcoming rows.

    An owner, admin or editor gets the full schedule (``view`` "full"). Loan
    terms are an owner's or admin's (plan §2), so for an editor they are null:
    ``annual_rate``, ``payment_amount``, ``term_months``, ``first_payment_date``,
    ``amortization``, ``proposed_split``, ``settlement``, and each upcoming row's
    ``principal``, ``interest`` and ``balance_after`` (derived from the rate).
    The editor keeps the payment rows (with ``transaction_id``) and each
    upcoming due date and amount. A viewer gets the limited schedule: ``{name, currency, owed, next_due_date,
    payments_left, rows: [{due_date, amount, status}]}`` with ``status`` "paid"
    (a posted payment, dated when it was made, principal and interest together)
    or "open" (an upcoming due date). No rate, term, amortisation, first payment
    date, balance after, principal and interest split, or row ids.
    """
    loan = _loan_or_404(db, current_user, account_id)
    schedule = loan_svc.build_schedule(db, loan)
    role = account_role(current_user, loan)
    if role in MANAGE_ROLES:
        return {"view": "full", **schedule}
    if role in EDIT_ROLES:
        terms = dict.fromkeys(LOAN_TERM_SCHEDULE_FIELDS)
        upcoming = [{**row, "principal": None, "interest": None, "balance_after": None}
                    for row in schedule["upcoming"]]
        return {"view": "full", **schedule, **terms, "upcoming": upcoming}
    rows = [{"due_date": p["date"], "amount": round(p["principal"] + p["interest"], 2),
             "status": "paid"} for p in schedule["payments"]]
    rows += [{"due_date": r["effective_date"], "amount": r["payment"], "status": "open"}
             for r in schedule["upcoming"]]
    return {
        "view": "limited",
        "name": loan.name,
        "currency": loan.currency,
        "owed": schedule["owed"],
        "next_due_date": schedule["next_due_effective_date"],
        "payments_left": schedule["payments_left"],
        "rows": rows,
    }
