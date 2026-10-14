from sqlalchemy import CHAR, Column, Date, DateTime, Numeric, String

from app.core.database import Base


class FxRate(Base):
    """A cached daily exchange rate: units of ``currency`` per US dollar (STU-236).

    One row per currency. ``fetched_at`` is when the row was fetched (the seed
    uses the epoch, so it is stale from the start); ``as_of`` is the provider's
    date for the figure. See ``app/services/fx.py``.
    """
    __tablename__ = "fx_rates"

    currency = Column(CHAR(3), primary_key=True)
    per_usd = Column(Numeric(20, 10), nullable=False)
    as_of = Column(Date, nullable=False)
    fetched_at = Column(DateTime(timezone=True), nullable=False)
    source = Column(String(32), nullable=False)
