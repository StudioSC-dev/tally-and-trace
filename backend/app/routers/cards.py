"""Credit-card endpoints (STU-343 Plan C): available credit, statement minimums.

Owner and admin only (``card_credit.can_see_credit``); anyone else gets a 404,
so no credit-derived figure reaches an editor, viewer or tag viewer.
"""
from datetime import date, datetime
from decimal import Decimal
from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException, Response
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.orm import Session
from sqlalchemy.sql import func

from app.core.access import MANAGE_ROLES, get_account_or_404, viewable_account_ids
from app.core.auth import get_current_active_user
from app.core.database import get_db
from app.core.redaction import Redactor
from app.core.time import manila_midnight, manila_today
from app.models.account import Account, AccountType
from app.models.card_statement_minimum import CardStatementMinimum
from app.models.user import User
from app.schemas.card import StatementMinimumSet
from app.schemas.minimum_due import MinimumDueRule
from app.services import card_credit
from app.services import forecast as fc
from app.services.fx import FxRates, get_fx
from app.services.minimum_due import statement_minimums
from app.services.statements import iter_cycles_from, resolve_cycle_fields, statement_history

router = APIRouter()

# StatementDue: the most recent closed statements listed, plus any older one still owed.
RECENT_STATEMENTS = 6


def _amount(value: Optional[Decimal]) -> Optional[float]:
    return round(float(value), 2) if value is not None else None


def _managed_card(db: Session, user: User, account_id: int) -> Account:
    """The card, 404 unless the caller is an owner or admin of it, 400 when it
    is not a credit card."""
    card = get_account_or_404(db, user, account_id, roles=MANAGE_ROLES)
    if card.account_type != AccountType.CREDIT:
        raise HTTPException(status_code=400, detail="Only a credit card has available credit")
    return card


def _rule(card: Account) -> Optional[MinimumDueRule]:
    stored = card.minimum_due_rule
    return MinimumDueRule.model_validate(stored) if stored is not None else None


def _minimum_out(result: dict) -> dict:
    inputs = result["inputs"]
    return {
        "amount": _amount(result["amount"]),
        "remaining": _amount(result["remaining"]),
        "source": result["source"],
        "reason": result["reason"],
        "complete": result["complete"],
        "assumptions": list(result["assumptions"]),
        "inputs": None if inputs is None else {
            "outstanding": _amount(inputs.outstanding),
            "installments": _amount(inputs.installments),
            "new_transactions": _amount(inputs.new_transactions),
            "overdue": _amount(inputs.overdue),
            "overlimit": _amount(inputs.overlimit),
        },
    }


def card_statements(db: Session, user: User, card: Account, fx: Optional[FxRates],
                    redactor: Redactor) -> List[dict]:
    """``StatementDue[]``: the card's closed statements (closed before Manila's
    today), the six most recent plus any older one still owed, oldest first,
    each with its minimum amount due (``statement_minimums``)."""
    history = statement_history(db, card, manila_midnight(), viewable_account_ids(db, user),
                                fx=fx)
    if not history:
        return []
    overrides = {row.statement_close: row.amount for row in db.query(CardStatementMinimum)
                 .filter(CardStatementMinimum.account_id == card.id)}
    limit = fc._money(card.credit_limit) if card.credit_limit is not None else None
    minimums = statement_minimums(db, card, history, _rule(card), overrides, limit, redactor)
    today = manila_today()
    closed = [i for i, s in enumerate(history) if s["close"].date() < today]
    recent = set(closed[-RECENT_STATEMENTS:])
    listed = [i for i in closed if i in recent or history[i]["owed"] > 0]
    out = []
    for i in listed:
        statement = history[i]
        out.append({
            "close_date": statement["close"].date().isoformat(),
            "due_date": statement["due"].date().isoformat(),
            "status": statement["status"],
            "owed": _amount(statement["owed"]),
            "clear_through": _amount(statement["clear_through"]),
            "outstanding": _amount(statement["outstanding"]),
            "incomplete": statement["incomplete"],
            "minimum_due": _minimum_out(minimums[i]),
        })
    return out


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
    not a credit card. ``credit`` is null when no limit is set. ``rule`` is the
    card's minimum due rule. ``statements`` are its closed statements with
    their minimum amount due (``card_statements``). ``open_cycle`` is the
    cycle open on Manila's today, null without cycle settings.
    """
    card = _managed_card(db, current_user, account_id)
    redactor = Redactor(db, current_user)
    credit = card_credit.credit_for_cards(db, current_user, [card.id], fx=fx,
                                          redactor=redactor)
    rule = _rule(card)
    return {
        "account_id": card.id,
        "name": card.name,
        "currency": fc._code(card.currency),
        "credit": credit.get(card.id),
        "rule": rule.model_dump(mode="json") if rule is not None else None,
        "statements": card_statements(db, current_user, card, fx, redactor),
        "open_cycle": card_credit.open_cycle(card, manila_today()),
    }


def _closed_statement(card: Account, close_date: str) -> date:
    """``close_date`` as a date, when it is the close of one of the card's
    statements and before Manila's today (a closed statement); else 422.
    400 for a card without cycle settings."""
    if resolve_cycle_fields(card) is None:
        raise HTTPException(status_code=400,
                            detail="This card has no statement cycle (set its closing day)")
    try:
        day = date.fromisoformat(close_date)
    except ValueError:
        day = None
    cycle = None
    if day is not None:
        cycle = next(iter_cycles_from(card, day, datetime.min, through=day), None)
    if cycle is None or cycle["close"].date() != day or day >= manila_today():
        raise HTTPException(status_code=422, detail="Not a closed statement of this card")
    return day


# ``close_date`` is read as text and parsed after the access check, so a caller
# who may not manage the card gets the same 404 whatever they send.
@router.put("/{account_id}/statements/{close_date}/minimum-due")
def set_statement_minimum(
    account_id: int,
    close_date: str,
    body: StatementMinimumSet,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_active_user),
):
    """Enter a closed statement's minimum amount due from the bank's statement.

    It replaces that statement's estimate and feeds the next statements'
    overdue carry. Owner or admin only (404 otherwise); 400 for a non-card or
    a card without cycle settings; 422 unless ``close_date`` is the close of a
    statement closed before Manila's today. Returns ``{close_date, amount}``.
    """
    card = _managed_card(db, current_user, account_id)
    day = _closed_statement(card, close_date)
    statement = pg_insert(CardStatementMinimum).values(
        account_id=card.id, statement_close=day, amount=body.amount,
        created_by_actor=current_user.id)
    db.execute(statement.on_conflict_do_update(
        constraint="uq_card_statement_minimums_account_close",
        set_={"amount": statement.excluded.amount,
              "created_by_actor": statement.excluded.created_by_actor,
              "updated_at": func.now()}))
    db.commit()
    return {"close_date": day.isoformat(), "amount": _amount(body.amount)}


@router.delete("/{account_id}/statements/{close_date}/minimum-due", status_code=204)
def clear_statement_minimum(
    account_id: int,
    close_date: str,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_active_user),
):
    """Clear a closed statement's entered minimum, so its estimate shows again.

    The same access and statement checks as the PUT; 204 whether or not one
    was entered.
    """
    card = _managed_card(db, current_user, account_id)
    day = _closed_statement(card, close_date)
    db.query(CardStatementMinimum).filter(
        CardStatementMinimum.account_id == card.id,
        CardStatementMinimum.statement_close == day,
    ).delete(synchronize_session=False)
    db.commit()
    return Response(status_code=204)
