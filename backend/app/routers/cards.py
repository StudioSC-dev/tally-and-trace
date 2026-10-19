"""Credit-card endpoints (STU-343 Plan C): available credit, statement minimums, Pay.

Owner and admin only (``card_credit.can_see_credit``); anyone else gets a 404,
so no credit-derived figure reaches an editor, viewer or tag viewer.
"""
from datetime import date, datetime, time
from decimal import Decimal
from typing import Dict, List, Optional

from fastapi import APIRouter, Depends, HTTPException, Response
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.orm import Session
from sqlalchemy.sql import func

from app.core import locking
from app.core.access import (
    EDIT_ROLES, MANAGE_ROLES, NONE, account_role, get_account_or_404, role_map,
    viewable_account_ids,
)
from app.core.auth import get_current_active_user
from app.core.database import get_db
from app.core.redaction import Redactor, serialize_transaction
from app.core.time import manila_midnight, manila_today
from app.models.account import Account, AccountType
from app.models.card_statement_minimum import CardStatementMinimum
from app.models.transaction import TransactionType
from app.models.user import User
from app.schemas.card import CardPaymentCreate, StatementMinimumSet
from app.schemas.minimum_due import MinimumDueRule
from app.schemas.transaction import TransactionCreate, TransactionOut
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


def _check_payment(user: User, card: Optional[Account], payer: Optional[Account],
                   roles: Optional[Dict[int, str]] = None) -> None:
    """Pay's rules, in order (section 2.6). Run before the locks and again on
    the locked, refreshed rows, so a concurrent change cannot slip through.
    ``roles`` (``role_map``, read after the locks) replaces ``account_role``,
    whose loaded share grants could predate a revocation.

    The card: an owner or admin (404), a credit card (400), active (400). The
    paying account: an edit role (404), not the card, active, not a credit or
    loan account (spending wallets may pay), in the card's currency (400).
    """
    def role(account: Account) -> str:
        return roles.get(account.id, NONE) if roles is not None else account_role(user, account)

    if card is None or role(card) not in MANAGE_ROLES:
        raise HTTPException(status_code=404, detail="Account not found")
    if card.account_type != AccountType.CREDIT:
        raise HTTPException(status_code=400, detail="Only a credit card takes a card payment")
    if not card.is_active:
        raise HTTPException(status_code=400, detail="This card is inactive")
    if payer is None or role(payer) not in EDIT_ROLES:
        raise HTTPException(status_code=404, detail="from_account_id account not found")
    if payer.id == card.id:
        raise HTTPException(status_code=400, detail="A card cannot pay itself")
    if not payer.is_active:
        raise HTTPException(status_code=400, detail="This account is inactive")
    if payer.account_type in (AccountType.CREDIT, AccountType.LOAN):
        raise HTTPException(status_code=400,
                            detail="Pay a card from a bank, cash or e-wallet account")
    currency = fc._code(card.currency)
    if fc._code(payer.currency) != currency:
        raise HTTPException(
            status_code=400,
            detail=f"Pay this card from a {currency} account. Card payments are in the "
                   f"card's currency; move the money into a {currency} account first.")


@router.post("/{account_id}/payments", response_model=TransactionOut, status_code=201)
def record_card_payment(
    account_id: int,
    payment: CardPaymentCreate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_active_user),
):
    """Pay a card: one transfer from a same-currency account into the card (201).

    Any amount; the server targets no statement, since payments settle the
    oldest statement first. Owner or admin of the card only (404 otherwise);
    the rules are ``_check_payment``'s. ``payment_date`` is the transaction's
    day (midnight); a day after Manila's today is a planned payment, recorded
    pending. The global lock order is taken here (the owner's budget lock,
    then both accounts in ascending id) and the rules re-run on the refreshed
    rows, with the caller's roles re-read, before ``add_transaction`` records
    the transfer.
    """
    from app.routers.transactions import add_transaction

    card = db.query(Account).filter(Account.id == account_id).first()
    payer = db.query(Account).filter(Account.id == payment.from_account_id).first()
    _check_payment(current_user, card, payer)

    locking.lock_owner_budgets(db, current_user.id)
    locked = locking.lock_accounts(db, [card.id, payer.id])
    try:
        # The caller's grants read afresh: the loaded ones may predate a
        # revocation or downgrade made while Pay waited on its locks.
        _check_payment(current_user, locked.get(card.id), locked.get(payer.id),
                       role_map(db, current_user))
    except HTTPException:
        db.rollback()
        raise

    txn = add_transaction(db, current_user, TransactionCreate(
        account_id=payer.id,
        transaction_type=TransactionType.TRANSFER,
        transfer_from_account_id=payer.id,
        transfer_to_account_id=card.id,
        amount=float(payment.amount),
        description=payment.description or "Card payment",
        transaction_date=datetime.combine(payment.payment_date, time()),
        is_posted=payment.payment_date <= manila_today(),
    ))
    db.commit()
    db.refresh(txn)
    return serialize_transaction(db, current_user, txn)
