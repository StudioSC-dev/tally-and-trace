"""Reconcile a card statement with the bank's (STU-749).

For now: the statement header writes the printed-due and minimum-due PUT handlers
(``routers/cards.py``) make.
"""
from __future__ import annotations

from datetime import date
from decimal import Decimal

from fastapi import HTTPException
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.orm import Session
from sqlalchemy.sql import func

from app.models.account import Account
from app.models.card_statement_due_override import CardStatementDueOverride
from app.models.card_statement_minimum import CardStatementMinimum
from app.services.statements import due_in_order, load_due_overrides


def store_minimum(db: Session, card: Account, close: date, amount: Decimal,
                  actor_id: int) -> None:
    """Upsert the statement's printed minimum amount due. Uncommitted."""
    statement = pg_insert(CardStatementMinimum).values(
        account_id=card.id, statement_close=close, amount=amount, created_by_actor=actor_id)
    db.execute(statement.on_conflict_do_update(
        constraint="uq_card_statement_minimums_account_close",
        set_={"amount": statement.excluded.amount,
              "created_by_actor": statement.excluded.created_by_actor,
              "updated_at": func.now()}))


def store_due_override(db: Session, card: Account, close: date, due: date,
                       actor_id: int) -> None:
    """Upsert the statement's printed due, 422 unless it is after the close and
    strictly between the dues of the statements either side. The caller holds the
    card's lock. Uncommitted."""
    overrides = load_due_overrides(db, [card.id])[card.id]
    if due <= close:
        raise HTTPException(status_code=422, detail="The due date must be after the close")
    if not due_in_order(card, close, {**overrides, close: due}):
        raise HTTPException(
            status_code=422,
            detail="The due date must fall between the previous and the next statement's "
                   "due dates")
    statement = pg_insert(CardStatementDueOverride).values(
        account_id=card.id, statement_close=close, due_date=due, created_by_actor=actor_id)
    db.execute(statement.on_conflict_do_update(
        constraint="uq_card_statement_due_overrides_account_close",
        set_={"due_date": statement.excluded.due_date,
              "created_by_actor": statement.excluded.created_by_actor,
              "updated_at": func.now()}))
