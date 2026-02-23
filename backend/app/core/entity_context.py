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
