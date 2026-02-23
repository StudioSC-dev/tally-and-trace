import enum
from sqlalchemy import Column, Integer, String, Boolean, DateTime, ForeignKey, Text, Enum
from sqlalchemy.sql import func
from sqlalchemy.orm import relationship
from app.core.database import Base


class EntityType(str, enum.Enum):
    PERSONAL = "personal"
    BUSINESS = "business"


class MemberRole(str, enum.Enum):
    OWNER = "owner"
    MEMBER = "member"


def _enum_values(enum_cls):
    return [member.value for member in enum_cls]


class Entity(Base):
    __tablename__ = "entities"

    id = Column(Integer, primary_key=True, index=True)
    name = Column(String(150), nullable=False, index=True)
    entity_type = Column(
        Enum(EntityType, values_callable=_enum_values, name="entitytype"),
        nullable=False,
        default=EntityType.PERSONAL,
    )
    description = Column(Text, nullable=True)
    default_currency = Column(String(10), nullable=True, default="PHP")
    is_active = Column(Boolean, default=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    updated_at = Column(DateTime(timezone=True), onupdate=func.now())

    # Relationships
    memberships = relationship(
        "EntityMembership",
        back_populates="entity",
        cascade="all, delete-orphan",
    )


class EntityMembership(Base):
    __tablename__ = "entity_memberships"

    id = Column(Integer, primary_key=True, index=True)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=False)
    entity_id = Column(Integer, ForeignKey("entities.id"), nullable=False)
    role = Column(
        Enum(MemberRole, values_callable=_enum_values, name="memberrole"),
        nullable=False,
        default=MemberRole.MEMBER,
    )
    joined_at = Column(DateTime(timezone=True), server_default=func.now())

    # Relationships
    user = relationship("User", back_populates="entity_memberships")
    entity = relationship("Entity", back_populates="memberships")
