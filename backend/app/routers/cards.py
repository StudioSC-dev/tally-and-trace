"""Credit-card endpoints (STU-343 Plan C): available credit, statement minimums,
statements' printed due dates, Pay.

Owner and admin only (``card_credit.can_see_credit``); anyone else gets a 404,
so no credit-derived figure reaches an editor, viewer or tag viewer. The one
exception is the statements read API (``GET /{account_id}/statements`` and
``GET /{account_id}/statements/{close_date}``, STU-601): any direct role on the
card (not a tag viewer), as ``GET /accounts/{account_id}/statements``, with a
viewer's limited view.
"""
from datetime import date, datetime, time, timedelta
from decimal import Decimal
from typing import Dict, List, Optional

from fastapi import APIRouter, Depends, HTTPException, Query, Response
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.orm import Session
from sqlalchemy.sql import func

from app.core import locking
from app.core.access import (
    EDIT_ROLES, MANAGE_ROLES, NONE, account_role, get_account_or_404, role_map,
    viewable_account_ids,
)
from app.core.auth import get_current_active_user
from app.core.idempotency import Idempotency, finish, idempotency
from app.core.database import get_db
from app.core.redaction import Redactor, serialize_transaction
from app.core.time import manila_day, manila_midnight, manila_today
from app.models.account import Account, AccountType
from app.models.card_statement_due_override import CardStatementDueOverride
from app.models.card_statement_minimum import CardStatementMinimum
from app.models.transaction import TransactionType
from app.models.user import User
from app.schemas.card import (
    CardPaymentCreate, CardStatementDetailOut, CardStatementListOut, StatementDueSet,
    StatementMinimumSet,
)
from app.schemas.minimum_due import MinimumDueRule
from app.schemas.transaction import TransactionCreate, TransactionOut
from app.services import card_credit
from app.services import forecast as fc
from app.services.fx import FxRates, get_fx
from app.services.minimum_due import statement_minimums
from app.services.statements import (
    computed_due, due_in_order, load_due_overrides, resolve_cycle_fields, statement_close,
    open_cycle_summary, statement_lines, statement_summaries,
)

router = APIRouter()

# StatementDue: the most recent closed statements listed, plus any older one still owed.
RECENT_STATEMENTS = 6
# A printed due may be entered on a closed statement or on one of this many
# statements not yet closed (the open cycle and the one after it).
DUE_FUTURE_CYCLES = 2


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


def _minimum_limit(db: Session, user: User, card: Account) -> Optional[Decimal]:
    """The limit behind the card's overlimit term: its own, or for a card
    sharing another card's limit, that card's (``T`` of this card's statement
    less the shared limit; going over only in combination is not counted).
    None, so no overlimit, when there is none or the caller does not manage
    the card holding it."""
    if card.credit_limit is not None:
        return fc._money(card.credit_limit)
    if card.shares_limit_with_account_id is None:
        return None
    primary = db.get(Account, card.shares_limit_with_account_id)
    if primary is None or primary.credit_limit is None or not card_credit.can_see_credit(
            user, primary):
        return None
    return fc._money(primary.credit_limit)


def card_statements(db: Session, user: User, card: Account, fx: Optional[FxRates],
                    redactor: Redactor,
                    unposted: List[card_credit.UnpostedMonth]) -> List[dict]:
    """``StatementDue[]``: the card's closed statements
    (``card_credit.closed_statements``: closed before Manila's today), the six
    most recent plus any older one still owed, oldest first, each with its
    minimum amount due (``statement_minimums``). ``unposted_installments``
    and ``unposted_postable`` count the ``unposted`` months
    (``card_credit.unposted_months``) whose cycle closes on or before that
    statement's close, cumulatively like ``clear_through``: what Full leaves
    out, and how many of those the caller's Post now would record."""
    history = card_credit.closed_statements(db, user, card, fx, with_lines=True)
    if not history:
        return []
    overrides = {row.statement_close: row.amount for row in db.query(CardStatementMinimum)
                 .filter(CardStatementMinimum.account_id == card.id)}
    limit = _minimum_limit(db, user, card)
    # Each minimum reads only the statements before it, so the closed ones
    # alone give the same figures.
    minimums = statement_minimums(db, card, history, _rule(card), overrides, limit, redactor)
    closed = range(len(history))
    recent = set(closed[-RECENT_STATEMENTS:])
    listed = [i for i in closed if i in recent or history[i]["owed"] > 0]
    out = []
    for i in listed:
        statement = history[i]
        close = statement["close"].date()
        left_out = [m for m in unposted if m.close <= close]
        out.append({
            "close_date": statement["close"].date().isoformat(),
            "due_date": statement["due"].date().isoformat(),
            "due_overridden": statement["due_overridden"],
            "computed_due_date": statement["computed_due"].date().isoformat(),
            "status": statement["status"],
            "owed": _amount(statement["owed"]),
            "clear_through": _amount(statement["clear_through"]),
            "outstanding": _amount(statement["outstanding"]),
            "incomplete": statement["incomplete"],
            "minimum_due": _minimum_out(minimums[i]),
            "unposted_installments": len(left_out),
            "unposted_postable": sum(1 for m in left_out if m.postable),
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
    cycle open on Manila's today, null without cycle settings. ``unposted``
    is ``{count, postable, oldest_close, oldest_due}`` over the card's
    unposted installment months on closed cycles
    (``card_credit.unposted_months``), null when there are none; it exists
    with no recorded statement at all.
    """
    card = _managed_card(db, current_user, account_id)
    redactor = Redactor(db, current_user)
    unposted = card_credit.unposted_months(db, card, current_user)
    credit = card_credit.credit_for_cards(db, current_user, [card.id], fx=fx,
                                          redactor=redactor)
    rule = _rule(card)
    return {
        "account_id": card.id,
        "name": card.name,
        "currency": fc._code(card.currency),
        "credit": credit.get(card.id),
        "rule": rule.model_dump(mode="json") if rule is not None else None,
        "statements": card_statements(db, current_user, card, fx, redactor, unposted),
        "open_cycle": card_credit.open_cycle(
            card, manila_today(), due_overrides=load_due_overrides(db, [card.id])[card.id]),
        "unposted": card_credit.unposted_summary(unposted),
    }


# --- Statements read API (STU-601, PERF-6; docs/statements-store.md) ------------------

def _readable_card(db: Session, user: User, account_id: int) -> tuple:
    """``(card, limited)``: a direct role on the card (404 otherwise, a tag viewer
    included), 400 when it is not a credit card; ``limited`` for a viewer, as
    ``GET /accounts/{account_id}/statements``."""
    card = get_account_or_404(db, user, account_id)
    if card.account_type != AccountType.CREDIT:
        raise HTTPException(status_code=400, detail="Account is not a credit card")
    return card, account_role(user, card) not in EDIT_ROLES


def _statement_rows(db: Session, user: User, card: Account, fx: Optional[FxRates]
                    ) -> List[dict]:
    """The card's closed statements and the cycle open on Manila's today, oldest
    first, read from the stored statements (``statement_summaries``)."""
    today = manila_today()
    viewable = viewable_account_ids(db, user)
    summaries = statement_summaries(db, card, manila_midnight(), viewable, fx=fx,
                                    with_counts=True)
    if not summaries:  # no line item yet: the open cycle, at zero
        open_cycle = open_cycle_summary(db, card, manila_midnight(), viewable)
        summaries = [open_cycle] if open_cycle is not None else []
    return [s for s in summaries if s["window_start"].date() < today]


def _summary_out(statement: dict, limited: bool) -> dict:
    close = statement["close"].date()
    out = {
        "close_date": close,
        "window_start": statement["window_start"].date(),
        "due_date": statement["due"].date(),
        "computed_due_date": statement["computed_due"].date(),
        "due_overridden": statement["due_overridden"],
        "is_closed": close < manila_today(),
        "status": statement["status"],
        "owed": _amount(statement["owed"]),
        "line_count": statement["line_count"],
        "incomplete": statement["incomplete"],
    }
    if not limited:
        out.update({key: _amount(statement[key]) for key in (
            "balance", "clear_through", "outstanding", "paid_since_close")})
    return out


def _card_head(card: Account, limited: bool) -> dict:
    head = {"view": "limited" if limited else "full", "name": card.name,
            "currency": fc._code(card.currency)}
    if not limited:
        head["card_id"] = card.id
    return head


@router.get("/{account_id}/statements", response_model=CardStatementListOut,
            response_model_exclude_none=True)
def list_card_statements(
    account_id: int,
    from_: Optional[date] = Query(None, alias="from"),
    to: Optional[date] = Query(None),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_active_user),
    fx: FxRates = Depends(get_fx),
):
    """A card's statements: every closed one (close before Manila's today) and
    the cycle open today, oldest first, optionally those closing in
    ``[from, to]``. Closed ones are read from the stored statements.

    Any direct role on the card; 404 otherwise (a tag viewer too). An owner, admin or editor gets every
    figure; a viewer the limited view (no ``balance``, ``clear_through``,
    ``outstanding``, ``paid_since_close`` or ``card_id``). A statement's key is
    its ``close_date``.
    """
    card, limited = _readable_card(db, current_user, account_id)
    rows = [s for s in _statement_rows(db, current_user, card, fx)
            if (from_ is None or s["close"].date() >= from_)
            and (to is None or s["close"].date() <= to)]
    return {**_card_head(card, limited),
            "statements": [_summary_out(s, limited) for s in rows]}


@router.get("/{account_id}/statements/{close_date}", response_model=CardStatementDetailOut,
            response_model_exclude_none=True)
def get_card_statement(
    account_id: int,
    close_date: str,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_active_user),
    fx: FxRates = Depends(get_fx),
):
    """One statement of the list above, with its lines (by date). 404 when
    ``close_date`` is not one of them (read as text after the access check, so
    a caller without a role gets the same 404 whatever they send).

    Line descriptions follow the description rule (app/core/redaction.py). A
    full line carries ``transaction_id`` and, when its row is posted on a
    day other than its own, ``posted_date``; the full view also lists the
    lines left out for want of a rate under ``unconverted_lines``.
    """
    card, limited = _readable_card(db, current_user, account_id)
    try:
        close = date.fromisoformat(close_date)
    except ValueError:
        close = None
    statement = next((s for s in _statement_rows(db, current_user, card, fx)
                      if s["close"].date() == close), None)
    if statement is None:
        raise HTTPException(status_code=404, detail="Statement not found")
    found = statement_lines(db, card, close, manila_midnight(),
                            viewable_account_ids(db, current_user), fx=fx)
    redactor = Redactor(db, current_user)
    redactor.prepare([line["transaction"] for line in [*found["lines"], *found["unconverted"]]])
    lines = []
    for line in found["lines"]:
        txn = line["transaction"]
        item = {"date": line["date"], "amount": float(line["amount"]),
                "display_description": redactor.display_description(txn)}
        if not limited:
            item["transaction_id"] = txn.id
            posted = manila_day(txn.posting_date) if txn.is_posted and txn.posting_date else None
            if posted is not None and posted != txn.transaction_date.date():
                item["posted_date"] = posted
        lines.append(item)
    body = {**_card_head(card, limited), "statement": _summary_out(statement, limited),
            "lines": lines}
    if not limited:
        body["unconverted_lines"] = [{
            "date": line["date"],
            "original_amount": float(line["original_amount"]),
            "original_currency": fc._code(line["original_currency"]),
            "display_description": redactor.display_description(line["transaction"]),
            "transaction_id": line["transaction"].id,
        } for line in found["unconverted"]]
    return body


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
    if day is None or statement_close(card, day) != day or day >= manila_today():
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


def _due_statement(card: Account, close_date: str) -> date:
    """``close_date`` as a date, when it is the close of one of the card's
    statements that is closed (before Manila's today) or one of the next
    ``DUE_FUTURE_CYCLES`` not yet closed; else 422. 400 for a card without
    cycle settings."""
    if resolve_cycle_fields(card) is None:
        raise HTTPException(status_code=400,
                            detail="This card has no statement cycle (set its closing day)")
    try:
        day = date.fromisoformat(close_date)
    except ValueError:
        day = None
    today = manila_today()
    if day is not None and statement_close(card, day) == day:
        if day < today:
            return day
        upcoming = statement_close(card, today)
        for _ in range(DUE_FUTURE_CYCLES):
            if day == upcoming:
                return day
            upcoming = statement_close(card, upcoming + timedelta(days=1))
    raise HTTPException(status_code=422,
                        detail="Not a closed or upcoming statement of this card")


def _locked_due_statement(db: Session, user: User, account_id: int,
                          close_date: str) -> tuple:
    """The card (404 / 400 as ``_managed_card``), locked, and the statement's
    close (``_due_statement``, checked on the locked row). The card lock
    serialises every printed-due edit on the card, so two edits to
    neighbouring statements cannot both pass the order check."""
    card = _managed_card(db, user, account_id)
    card = locking.lock_accounts(db, [card.id])[card.id]
    if card.account_type != AccountType.CREDIT:  # converted while this waited for the lock
        raise HTTPException(status_code=400, detail="Only a credit card has available credit")
    return card, _due_statement(card, close_date)


@router.put("/{account_id}/statements/{close_date}/due-date")
def set_statement_due(
    account_id: int,
    close_date: str,
    body: StatementDueSet,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_active_user),
):
    """Enter the due date printed on a statement.

    It replaces the statement's rolled due (``close + days``, moved to the
    next banking day) everywhere: payables, status, the overdue carry, the
    forecast and Household. The close and the minimum are unchanged. Owner or
    admin only (404 otherwise); 400 for a non-card or a card without cycle
    settings; 422 unless ``close_date`` is the close of a closed statement or
    of one of the next two, and unless the due is after the close and
    strictly between the dues of the statements before and after it.
    Returns ``{close_date, due_date, computed_due}``.
    """
    card, day = _locked_due_statement(db, current_user, account_id, close_date)
    overrides = load_due_overrides(db, [card.id])[card.id]
    if body.due_date <= day:
        raise HTTPException(status_code=422, detail="The due date must be after the close")
    if not due_in_order(card, day, {**overrides, day: body.due_date}):
        raise HTTPException(
            status_code=422,
            detail="The due date must fall between the previous and the next statement's "
                   "due dates")
    statement = pg_insert(CardStatementDueOverride).values(
        account_id=card.id, statement_close=day, due_date=body.due_date,
        created_by_actor=current_user.id)
    db.execute(statement.on_conflict_do_update(
        constraint="uq_card_statement_due_overrides_account_close",
        set_={"due_date": statement.excluded.due_date,
              "created_by_actor": statement.excluded.created_by_actor,
              "updated_at": func.now()}))
    db.commit()
    days_until_due = resolve_cycle_fields(card)[1]
    return {"close_date": day.isoformat(), "due_date": body.due_date.isoformat(),
            "computed_due": computed_due(day, days_until_due).isoformat()}


@router.delete("/{account_id}/statements/{close_date}/due-date", status_code=204)
def clear_statement_due(
    account_id: int,
    close_date: str,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_active_user),
):
    """Clear a statement's printed due, so its rolled due applies again.

    The same access, statement and lock as the PUT; 204 whether or not one was
    entered. 409 when the rolled due would not fall strictly between the dues
    of the neighbouring statements (one of them printed).
    """
    card, day = _locked_due_statement(db, current_user, account_id, close_date)
    overrides = load_due_overrides(db, [card.id])[card.id]
    if day in overrides:
        rest = {close: due for close, due in overrides.items() if close != day}
        if not due_in_order(card, day, rest):
            raise HTTPException(
                status_code=409,
                detail="Clearing it would put this statement's due on or past a neighbouring "
                       "statement's printed due; change that one first")
        db.query(CardStatementDueOverride).filter(
            CardStatementDueOverride.account_id == card.id,
            CardStatementDueOverride.statement_close == day,
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
    idem: Idempotency = Depends(idempotency),
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
    db.flush()
    db.refresh(txn)
    return finish(idem, db, serialize_transaction(db, current_user, txn),
                  model=TransactionOut, status_code=201)
