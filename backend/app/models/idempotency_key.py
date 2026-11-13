from sqlalchemy import Column, DateTime, ForeignKey, Integer, String
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.sql import func
from app.core.database import Base


class IdempotencyKey(Base):
    """A create that was already answered for a client's ``Idempotency-Key`` (STU-604).

    Written in the same transaction as the create it guards (core/idempotency.py),
    so a stored key always has its record and a record made under a key always has
    its key. ``status_code`` and ``response_json`` stay null only inside that
    transaction, where the row holds the key while the handler runs.
    """
    __tablename__ = "idempotency_keys"

    user_id = Column(Integer, ForeignKey("users.id", ondelete="CASCADE"), primary_key=True)
    key = Column(UUID(as_uuid=True), primary_key=True)
    route = Column(String, nullable=False)           # "POST /api/v1/transactions/5/repeat"
    request_hash = Column(String(64), nullable=False)
    status_code = Column(Integer, nullable=True)
    response_json = Column(JSONB, nullable=True)
    response_headers = Column(JSONB, nullable=True)  # the X-Occurrence* headers of a Mark paid
    created_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now(),
                        index=True)
