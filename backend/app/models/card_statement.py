"""Stored closed card statements (STU-601, PERF-6). See docs/statements-store.md.

``card_statements`` holds one row per closed cycle of a credit card, from the
cycle holding its first posted line item through ``materialized_through``,
empty cycles included: the cycle's line-item balance (posted charges and cash
advances less refunds, in the card's currency) and how many line items it holds.
Only figures that depend on neither the reader, the day of the read nor an
exchange rate are stored; everything else (due, payments, owed, status) is
computed on read from these balances (``app/services/statements_store.py``).

``card_statement_state`` says how far a card's rows are complete
(``materialized_through``, the last close stored) and under which close day.

Neither table is written by an API route directly: the write-through hook and
the read-path catch-up in ``statements_store`` own them.
"""
from sqlalchemy import Column, Date, DateTime, ForeignKey, Integer, Numeric, SmallInteger
from sqlalchemy.sql import func

from app.core.database import Base


class CardStatement(Base):
    __tablename__ = "card_statements"

    card_id = Column(
        Integer,
        ForeignKey("accounts.id", ondelete="CASCADE", name="fk_card_statements_card_id_accounts"),
        primary_key=True,
    )
    close = Column(Date, primary_key=True)
    window_start = Column(Date, nullable=False)
    line_balance = Column(Numeric(15, 2), nullable=False)
    line_count = Column(Integer, nullable=False)
    close_day = Column(SmallInteger, nullable=False)
    computed_at = Column(DateTime(timezone=True), server_default=func.now(), nullable=False)


class CardStatementState(Base):
    __tablename__ = "card_statement_state"

    card_id = Column(
        Integer,
        ForeignKey("accounts.id", ondelete="CASCADE",
                   name="fk_card_statement_state_card_id_accounts"),
        primary_key=True,
    )
    materialized_through = Column(Date, nullable=True)
    close_day = Column(SmallInteger, nullable=True)
