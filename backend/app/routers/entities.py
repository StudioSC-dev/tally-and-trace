from typing import List, Optional
from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy.orm import Session

from app.core.auth import get_current_active_user
from app.core.database import get_db
from app.core.entity_context import require_entity_owner
from app.models.entity import Entity, EntityMembership, MemberRole
from app.models.user import User
from app.schemas.entity import (
    EntityCreate,
    EntityMembershipResponse,
    EntityResponse,
    EntityUpdate,
    EntityWithMembershipsResponse,
    MembershipCreate,
)

router = APIRouter()


# ---------------------------------------------------------------------------
# Entity CRUD
# ---------------------------------------------------------------------------

@router.get("/", response_model=List[EntityResponse])
def list_entities(
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_active_user),
    is_active: Optional[bool] = Query(None),
):
    """List all entities the current user belongs to."""
    query = (
        db.query(Entity)
        .join(EntityMembership, EntityMembership.entity_id == Entity.id)
        .filter(EntityMembership.user_id == current_user.id)
    )
    if is_active is not None:
        query = query.filter(Entity.is_active == is_active)
    return query.order_by(Entity.created_at).all()


@router.post("/", response_model=EntityWithMembershipsResponse, status_code=status.HTTP_201_CREATED)
def create_entity(
    payload: EntityCreate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_active_user),
):
    """Create a new entity.  The creator automatically becomes its owner."""
    entity = Entity(**payload.dict())
    db.add(entity)
    db.flush()  # get id before commit

    membership = EntityMembership(
        user_id=current_user.id,
        entity_id=entity.id,
        role=MemberRole.OWNER,
    )
    db.add(membership)
    db.commit()
    db.refresh(entity)
    return entity


@router.get("/{entity_id}", response_model=EntityWithMembershipsResponse)
def get_entity(
    entity_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_active_user),
):
    """Get entity details.  User must be a member."""
    entity = db.query(Entity).filter(Entity.id == entity_id).first()
    if not entity:
        raise HTTPException(status_code=404, detail="Entity not found")

    membership = (
        db.query(EntityMembership)
        .filter(
            EntityMembership.entity_id == entity_id,
            EntityMembership.user_id == current_user.id,
        )
        .first()
    )
    if not membership:
        raise HTTPException(status_code=403, detail="Access denied")

    return entity


@router.put("/{entity_id}", response_model=EntityResponse)
def update_entity(
    entity_id: int,
    payload: EntityUpdate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_active_user),
):
    """Update an entity.  Only owners may do this."""
    entity = db.query(Entity).filter(Entity.id == entity_id).first()
    if not entity:
        raise HTTPException(status_code=404, detail="Entity not found")

    membership = (
        db.query(EntityMembership)
        .filter(
            EntityMembership.entity_id == entity_id,
            EntityMembership.user_id == current_user.id,
            EntityMembership.role == MemberRole.OWNER,
        )
        .first()
    )
    if not membership:
        raise HTTPException(status_code=403, detail="Only owners can update an entity")

    for field, value in payload.dict(exclude_unset=True).items():
        setattr(entity, field, value)
    entity.updated_at = datetime.utcnow()
    db.commit()
    db.refresh(entity)
    return entity


@router.delete("/{entity_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_entity(
    entity_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_active_user),
):
    """Soft-delete an entity (mark inactive).  Owner only."""
    entity = db.query(Entity).filter(Entity.id == entity_id).first()
    if not entity:
        raise HTTPException(status_code=404, detail="Entity not found")

    membership = (
        db.query(EntityMembership)
        .filter(
            EntityMembership.entity_id == entity_id,
            EntityMembership.user_id == current_user.id,
            EntityMembership.role == MemberRole.OWNER,
        )
        .first()
    )
    if not membership:
        raise HTTPException(status_code=403, detail="Only owners can delete an entity")

    entity.is_active = False
    entity.updated_at = datetime.utcnow()
    db.commit()


# ---------------------------------------------------------------------------
# Membership management
# ---------------------------------------------------------------------------

@router.get("/{entity_id}/members", response_model=List[EntityMembershipResponse])
def list_members(
    entity_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_active_user),
):
    """List all members of an entity."""
    # verify caller is a member
    membership = (
        db.query(EntityMembership)
        .filter(
            EntityMembership.entity_id == entity_id,
            EntityMembership.user_id == current_user.id,
        )
        .first()
    )
    if not membership:
        raise HTTPException(status_code=403, detail="Access denied")

    return (
        db.query(EntityMembership)
        .filter(EntityMembership.entity_id == entity_id)
        .all()
    )


@router.post("/{entity_id}/members", response_model=EntityMembershipResponse, status_code=201)
def add_member(
    entity_id: int,
    payload: MembershipCreate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_active_user),
):
    """Add a user to an entity.  Owner only."""
    entity = db.query(Entity).filter(Entity.id == entity_id).first()
    if not entity:
        raise HTTPException(status_code=404, detail="Entity not found")

    owner_membership = (
        db.query(EntityMembership)
        .filter(
            EntityMembership.entity_id == entity_id,
            EntityMembership.user_id == current_user.id,
            EntityMembership.role == MemberRole.OWNER,
        )
        .first()
    )
    if not owner_membership:
        raise HTTPException(status_code=403, detail="Only owners can add members")

    existing = (
        db.query(EntityMembership)
        .filter(
            EntityMembership.entity_id == entity_id,
            EntityMembership.user_id == payload.user_id,
        )
        .first()
    )
    if existing:
        raise HTTPException(status_code=400, detail="User is already a member of this entity")

    new_membership = EntityMembership(
        user_id=payload.user_id,
        entity_id=entity_id,
        role=payload.role,
    )
    db.add(new_membership)
    db.commit()
    db.refresh(new_membership)
    return new_membership


@router.delete("/{entity_id}/members/{target_user_id}", status_code=status.HTTP_204_NO_CONTENT)
def remove_member(
    entity_id: int,
    target_user_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_active_user),
):
    """Remove a member from an entity.  Owner only (cannot remove yourself if sole owner)."""
    owner_membership = (
        db.query(EntityMembership)
        .filter(
            EntityMembership.entity_id == entity_id,
            EntityMembership.user_id == current_user.id,
            EntityMembership.role == MemberRole.OWNER,
        )
        .first()
    )
    if not owner_membership:
        raise HTTPException(status_code=403, detail="Only owners can remove members")

    target = (
        db.query(EntityMembership)
        .filter(
            EntityMembership.entity_id == entity_id,
            EntityMembership.user_id == target_user_id,
        )
        .first()
    )
    if not target:
        raise HTTPException(status_code=404, detail="Member not found")

    db.delete(target)
    db.commit()
