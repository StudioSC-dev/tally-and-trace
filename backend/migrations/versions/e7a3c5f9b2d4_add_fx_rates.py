"""add fx rates

Cached daily exchange rates (STU-236).

- ``fx_rates``: one row per currency, ``per_usd`` units per US dollar, the
  provider's ``as_of`` date, when the row was ``fetched_at`` and its
  ``source``.
- Seeded with literal values from the provider's file dated 2026-10-12
  (``@fawazahmed0/currency-api@2026-10-12``). Every seed row has the epoch
  ``fetched_at``, so it is stale from the start: the first conversion
  schedules a refresh, and any real fetch wins the upsert.

Downgrade drops the table.

Revision ID: e7a3c5f9b2d4
Revises: d4b8e2f6a1c3
Create Date: 2026-10-13

"""
from datetime import date, datetime, timezone
from decimal import Decimal

from alembic import op
import sqlalchemy as sa

revision = "e7a3c5f9b2d4"
down_revision = "d4b8e2f6a1c3"
branch_labels = None
depends_on = None

SEED_SOURCE = "seed currency-api 2026-10-12"
SEED_AS_OF = date(2026, 10, 12)
SEED_FETCHED_AT = datetime(1970, 1, 1, tzinfo=timezone.utc)
SEED_PER_USD = {
    "USD": "1",
    "PHP": "62.77060786",
    "EUR": "0.89282214",
    "GBP": "0.75552913",
    "JPY": "158.3874829",
    "AUD": "1.43389336",
    "CAD": "1.42612637",
    "CHF": "0.83093222",
    "CNY": "6.69308518",
    "SGD": "1.28023669",
}


def upgrade() -> None:
    table = op.create_table(
        "fx_rates",
        sa.Column("currency", sa.CHAR(3), primary_key=True),
        sa.Column("per_usd", sa.Numeric(20, 10), nullable=False),
        sa.Column("as_of", sa.Date(), nullable=False),
        sa.Column("fetched_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("source", sa.String(32), nullable=False),
    )
    op.bulk_insert(table, [
        {"currency": currency, "per_usd": Decimal(per_usd), "as_of": SEED_AS_OF,
         "fetched_at": SEED_FETCHED_AT, "source": SEED_SOURCE}
        for currency, per_usd in SEED_PER_USD.items()
    ])


def downgrade() -> None:
    op.drop_table("fx_rates")
