"""Tag CRUD: the caller's own tags only (see ``app/core/tags.py``).

Another user's tag id gets the same 404 as an unknown id. The Household system
tag can be recoloured but not renamed or deleted (400). A name the caller
already uses, ignoring case, is refused with 400, as categories are.
"""

from typing import List

from fastapi import APIRouter, Depends, HTTPException, Response
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.core.auth import get_current_active_user
from app.core.database import get_db
from app.core.tags import DUPLICATE_TAG, SYSTEM_TAG_LOCKED, get_own_tag_or_404, name_taken
from app.models.tag import Tag
from app.models.user import User
from app.schemas.tag import TagCreate, TagResponse, TagUpdate

router = APIRouter()


def _commit_or_duplicate(db: Session) -> None:
    """Commit; a concurrent insert of the same name is the same 400 as a checked one."""
    try:
        db.commit()
    except IntegrityError as exc:
        db.rollback()
        raise HTTPException(status_code=400, detail=DUPLICATE_TAG) from exc


@router.get("/", response_model=List[TagResponse])
def list_tags(
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_active_user),
):
    """The caller's tags: the Household system tag first, then by name."""
    return (
        db.query(Tag)
        .filter(Tag.user_id == current_user.id)
        .order_by(Tag.is_system.desc(), Tag.name, Tag.id)
        .all()
    )


@router.post("/", response_model=TagResponse, status_code=201)
def create_tag(
    tag_in: TagCreate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_active_user),
):
    if name_taken(db, current_user, tag_in.name):
        raise HTTPException(status_code=400, detail=DUPLICATE_TAG)
    tag = Tag(user_id=current_user.id, name=tag_in.name, color=tag_in.color, is_system=False)
    db.add(tag)
    _commit_or_duplicate(db)
    db.refresh(tag)
    return tag


@router.get("/{tag_id}", response_model=TagResponse)
def get_tag(
    tag_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_active_user),
):
    return get_own_tag_or_404(db, current_user, tag_id)


@router.put("/{tag_id}", response_model=TagResponse)
def update_tag(
    tag_id: int,
    tag_update: TagUpdate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_active_user),
):
    """Rename or recolour a tag. The system tag keeps its name."""
    tag = get_own_tag_or_404(db, current_user, tag_id)
    data = tag_update.model_dump(exclude_unset=True)
    if "name" in data and data["name"] != tag.name:
        if tag.is_system:
            raise HTTPException(status_code=400, detail=SYSTEM_TAG_LOCKED)
        if name_taken(db, current_user, data["name"], exclude_id=tag.id):
            raise HTTPException(status_code=400, detail=DUPLICATE_TAG)
    for field, value in data.items():
        setattr(tag, field, value)
    _commit_or_duplicate(db)
    db.refresh(tag)
    return tag


@router.delete("/{tag_id}", status_code=204)
def delete_tag(
    tag_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_active_user),
):
    """Delete a tag; its links to records go with it. The system tag stays."""
    tag = get_own_tag_or_404(db, current_user, tag_id)
    if tag.is_system:
        raise HTTPException(status_code=400, detail=SYSTEM_TAG_LOCKED)
    db.delete(tag)
    db.commit()
    return Response(status_code=204)
