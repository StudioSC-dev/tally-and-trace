"""
Utility for resolving and validating the active entity from request context.

Clients send either:
  - Query parameter  ?entity_id=<int>
  - Header           X-Entity-Id: <int>

The helper verifies the requesting user has membership in the entity and
returns the Entity ORM object.  If the caller provides no entity_id the
function returns None (caller may fall back to user-scoped queries).
"""

from typing import Optional
from fastapi import Header, HTTPException, Query, status, Depends
from sqlalchemy.orm import Session

from app.core.database import get_db
from app.core.auth import get_current_active_user
from app.models.entity import Entity, EntityMembership, MemberRole
from app.models.user import User


def get_active_entity(
    entity_id: Optional[int] = Query(None, description="Entity context ID"),
    x_entity_id: Optional[str] = Header(None, alias="X-Entity-Id"),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_active_user),
) -> Optional[Entity]:
    """
    Resolve entity from query param or header.  Validates the user has
    membership.  Returns None if no entity_id is supplied.
    """
    resolved_id: Optional[int] = entity_id

    # Header takes priority over query param if both are present
    if x_entity_id is not None:
        try:
            resolved_id = int(x_entity_id)
        except ValueError:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="X-Entity-Id header must be an integer",
            )

    if resolved_id is None:
        return None

    entity = db.query(Entity).filter(Entity.id == resolved_id, Entity.is_active.is_(True)).first()
    if not entity:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Entity not found")

    membership = (
        db.query(EntityMembership)
        .filter(
            EntityMembership.entity_id == resolved_id,
            EntityMembership.user_id == current_user.id,
        )
        .first()
    )
    if not membership:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="You are not a member of this entity",
        )

    return entity


def validate_entity_ownership(db: Session, user: User, entity_id: Optional[int]) -> None:
    """
    Raise if ``entity_id`` is supplied but the user isn't a member of that entity.

    Used by create/update endpoints that accept a client-supplied ``entity_id`` in
    the request body (independent of the ``get_active_entity`` header/query path),
    so a caller can't tag a record onto an entity they don't belong to.
    """
    if entity_id is None:
        return

    membership = (
        db.query(EntityMembership)
        .filter(
            EntityMembership.entity_id == entity_id,
            EntityMembership.user_id == user.id,
        )
        .first()
    )
    if not membership:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="You are not a member of this entity",
        )


def user_entity_ids(db: Session, user: User) -> set:
    """Every entity id the user is a member of."""
    rows = (
        db.query(EntityMembership.entity_id)
        .filter(EntityMembership.user_id == user.id)
        .all()
    )
    return {row[0] for row in rows}


def scope_criterion(model, user_id: int, entity_id: Optional[int]):
    """SQLAlchemy criterion for the rows a caller may list.

    **This is the entity-sharing rule, and it is deliberately narrow.**

    - With an active entity: scope to that entity ALONE and drop the ``user_id``
      predicate. That is the whole point of sharing -- a second member of a
      business entity sees records a co-owner created. Callers must have resolved
      the entity through ``get_active_entity`` / ``validate_entity_ownership``
      first, which is what proves membership; this function assumes that check
      already happened and does not repeat it.
    - Without an active entity: fall back to ``user_id``, unchanged. Records with
      a null ``entity_id`` (pre-entity data) are only ever visible to their owner,
      and an unscoped call must not fan out across every entity the user belongs
      to -- that would silently widen every API/MCP caller that omits the header.
    """
    if entity_id is not None:
        return model.entity_id == entity_id
    return model.user_id == user_id


def can_access_record(db: Session, user: User, record) -> bool:
    """Whether ``user`` may read/write a single record.

    Accessible when the user owns it, or when it belongs to an entity the user is
    a member of. Membership grants full access rather than read-only: an entity's
    ledger is collaborative, and a half-shared state (see a transaction but fail to
    correct it) is worse than either extreme. Owner-only operations are a separate
    concern already served by ``require_entity_owner``.
    """
    if getattr(record, "user_id", None) == user.id:
        return True

    entity_id = getattr(record, "entity_id", None)
    if entity_id is None:
        return False

    membership = (
        db.query(EntityMembership)
        .filter(
            EntityMembership.entity_id == entity_id,
            EntityMembership.user_id == user.id,
        )
        .first()
    )
    return membership is not None


def get_accessible_or_404(db: Session, model, record_id: int, user: User, detail: str = "Not found"):
    """Fetch a record by id, 404ing unless the caller owns it or shares its entity.

    404 rather than 403 on purpose: a 403 would confirm the id exists to someone
    with no right to know that.
    """
    record = db.query(model).filter(model.id == record_id).first()
    if not record or not can_access_record(db, user, record):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=detail)
    return record


def require_entity_owner(
    entity: Optional[Entity] = Depends(get_active_entity),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_active_user),
) -> Entity:
    """Like get_active_entity but additionally requires the user to be an owner."""
    if entity is None:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="entity_id is required for this operation",
        )

    membership = (
        db.query(EntityMembership)
        .filter(
            EntityMembership.entity_id == entity.id,
            EntityMembership.user_id == current_user.id,
            EntityMembership.role == MemberRole.OWNER,
        )
        .first()
    )
    if not membership:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Only entity owners can perform this action",
        )

    return entity
