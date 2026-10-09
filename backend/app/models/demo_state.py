from sqlalchemy import CheckConstraint, Column, DateTime, Integer
from sqlalchemy.sql import func

from app.core.database import Base


class DemoState(Base):
    """The demo seed's shape version: one row (``id`` 1), see ``app/core/seed.py``."""
    __tablename__ = "demo_state"
    __table_args__ = (CheckConstraint("id = 1", name="ck_demo_state_single_row"),)

    id = Column(Integer, primary_key=True)
    shape_version = Column(Integer, nullable=False)
    seeded_at = Column(DateTime(timezone=True), server_default=func.now(), nullable=False)
