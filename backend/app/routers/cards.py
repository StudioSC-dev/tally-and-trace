"""Credit-card endpoints (STU-343 Plan C): available credit.

Owner and admin only (``card_credit.can_see_credit``); anyone else gets a 404,
so no credit-derived figure reaches an editor, viewer or tag viewer.
"""
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from app.core.access import MANAGE_ROLES, get_account_or_404
from app.core.auth import get_current_active_user
from app.core.database import get_db
from app.core.redaction import Redactor
from app.core.time import manila_today
from app.models.account import AccountType
from app.models.user import User
from app.services import card_credit
from app.services import forecast as fc
from app.services.fx import FxRates, get_fx

router = APIRouter()


@router.get("/credit")
def list_card_credit(
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_active_user),
    fx: FxRates = Depends(get_fx),
):
    """``{items: CardCredit[]}``: every active credit card the caller manages
    (owner or admin) that has a limit, by name."""
    ids = card_credit.managed_card_ids(db, current_user)
    credit = card_credit.credit_for_cards(db, current_user, ids, fx=fx,
                                          redactor=Redactor(db, current_user))
    return {"items": [credit[i] for i in ids if i in credit]}


@router.get("/{account_id}/credit")
def get_card_credit(
    account_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_active_user),
    fx: FxRates = Depends(get_fx),
):
    """One card's credit detail (``CardCreditDetail``).

    404 unless the caller is an owner or admin of the account; 400 when it is
    not a credit card. ``credit`` is null when no limit is set. ``open_cycle``
    is the cycle open on Manila's today, null without cycle settings.
    """
    card = get_account_or_404(db, current_user, account_id, roles=MANAGE_ROLES)
    if card.account_type != AccountType.CREDIT:
        raise HTTPException(status_code=400, detail="Only a credit card has available credit")
    credit = card_credit.credit_for_cards(db, current_user, [card.id], fx=fx,
                                          redactor=Redactor(db, current_user))
    return {
        "account_id": card.id,
        "name": card.name,
        "currency": fc._code(card.currency),
        "credit": credit.get(card.id),
        "rule": None,
        "statements": [],
        "open_cycle": card_credit.open_cycle(card, manila_today()),
    }
