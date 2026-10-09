"""Tags: who may use which tag, and the Household system tag.

A tag belongs to one user and is private to them. Every user has exactly one
system tag, "Household" (``is_system``), created with the user and never
renamed or deleted.

``usable_tag_ids`` is the one place that decides which tags a caller may use
to filter and see. Today that is their own tags; tag shares add the sharer's
Household tag there later, and nothing else needs to change for it.

A miss on another user's tag is the same 404 as an unknown id, so a tag id
never confirms that it exists.
"""

from typing import Optional, Set

from fastapi import HTTPException, status
from sqlalchemy import func
from sqlalchemy.orm import Session

from app.models.tag import HOUSEHOLD_TAG_NAME, Tag

TAG_NOT_FOUND = "Tag not found"
SYSTEM_TAG_LOCKED = "The Household tag is a system tag: it can't be renamed or deleted"
DUPLICATE_TAG = "Tag with this name already exists"


def _uid(user) -> Optional[int]:
    """A user's id, from a ``User`` or a bare id."""
    return getattr(user, "id", user)


def ensure_household_tag(db: Session, user) -> Tag:
    """The user's Household system tag, created (and flushed) when missing.

    Called in the same transaction that creates the user, so a user never
    exists without it.
    """
    uid = _uid(user)
    tag = db.query(Tag).filter(Tag.user_id == uid, Tag.is_system.is_(True)).first()
    if tag is None:
        tag = Tag(user_id=uid, name=HOUSEHOLD_TAG_NAME, is_system=True)
        db.add(tag)
        db.flush()
    return tag


def usable_tag_ids(db: Session, user) -> Set[int]:
    """The tags the caller may filter by and see on records: their own.

    The seam for tag shares: a shared Household tag is added here.
    """
    return {row[0] for row in db.query(Tag.id).filter(Tag.user_id == _uid(user))}


def get_own_tag_or_404(db: Session, user, tag_id: int) -> Tag:
    """The caller's own tag, 404ing for an unknown id or anyone else's."""
    tag = db.query(Tag).filter(Tag.id == tag_id).first()
    if tag is None or tag.user_id != _uid(user):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=TAG_NOT_FOUND)
    return tag


def name_taken(db: Session, user, name: str, *, exclude_id: Optional[int] = None) -> bool:
    """Whether the caller already has a tag with ``name``, ignoring case."""
    query = db.query(Tag.id).filter(
        Tag.user_id == _uid(user), func.lower(Tag.name) == name.lower())
    if exclude_id is not None:
        query = query.filter(Tag.id != exclude_id)
    return query.first() is not None
