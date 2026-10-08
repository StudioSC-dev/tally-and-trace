"""add loan accounts and loan payment kind

Adds the ``loan`` account type and the loan's terms on ``accounts``, all
nullable so existing rows are unaffected:

- ``loan_kind``: personal / auto / home;
- ``loan_annual_rate``: nominal annual rate in percent (e.g. 6.5 for 6.5%);
- ``loan_term_months``, ``loan_payment_amount``, ``loan_first_payment_date``;
- ``loan_amortization``: ``fixed`` (the bank's schedule; payments left are
  counted) or ``reduce_term`` (a prepayment shortens the term);
- ``loan_payments_made_offset``: scheduled payments made before the loan was
  tracked here, so a loan loaded mid-term counts them without importing history.

A loan's balance is negative while money is owed. A payment is a transfer into
the loan (principal as the amount, interest as the transfer fee);
``transactions.loan_payment_kind`` (scheduled / prepayment) tells the two apart.

Revision ID: c4e8a2f6b1d3
Revises: b9e3f1a7c5d2
Create Date: 2026-10-08

"""
from alembic import op
import sqlalchemy as sa

revision = "c4e8a2f6b1d3"
down_revision = "b9e3f1a7c5d2"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # ADD VALUE IF NOT EXISTS is safe inside a transaction on PostgreSQL 12+ as
    # long as the new value isn't used in the same transaction (it isn't here).
    op.execute("ALTER TYPE accounttype ADD VALUE IF NOT EXISTS 'loan'")

    op.add_column("accounts", sa.Column("loan_kind", sa.String(16), nullable=True))
    op.add_column("accounts", sa.Column("loan_annual_rate", sa.Numeric(7, 4), nullable=True))
    op.add_column("accounts", sa.Column("loan_term_months", sa.Integer(), nullable=True))
    op.add_column("accounts", sa.Column("loan_payment_amount", sa.Numeric(15, 2), nullable=True))
    op.add_column("accounts", sa.Column("loan_first_payment_date", sa.Date(), nullable=True))
    op.add_column("accounts", sa.Column("loan_amortization", sa.String(16), nullable=True))
    op.add_column("accounts", sa.Column("loan_payments_made_offset", sa.Integer(), nullable=True))
    op.create_check_constraint(
        "ck_accounts_loan_kind", "accounts",
        "loan_kind IS NULL OR loan_kind IN ('personal', 'auto', 'home')",
    )
    op.create_check_constraint(
        "ck_accounts_loan_amortization", "accounts",
        "loan_amortization IS NULL OR loan_amortization IN ('fixed', 'reduce_term')",
    )

    op.add_column("transactions", sa.Column("loan_payment_kind", sa.String(16), nullable=True))
    op.create_check_constraint(
        "ck_transactions_loan_payment_kind", "transactions",
        "loan_payment_kind IS NULL OR loan_payment_kind IN ('scheduled', 'prepayment')",
    )


def downgrade() -> None:
    op.drop_constraint("ck_transactions_loan_payment_kind", "transactions", type_="check")
    op.drop_column("transactions", "loan_payment_kind")
    op.drop_constraint("ck_accounts_loan_amortization", "accounts", type_="check")
    op.drop_constraint("ck_accounts_loan_kind", "accounts", type_="check")
    for column in (
        "loan_payments_made_offset", "loan_amortization", "loan_first_payment_date",
        "loan_payment_amount", "loan_term_months", "loan_annual_rate", "loan_kind",
    ):
        op.drop_column("accounts", column)
    # NOTE: PostgreSQL cannot DROP individual enum values, so 'loan' is left in
    # accounttype on downgrade (as in b7c1e2f3a4d5). Removing it would require
    # recreating the type.
