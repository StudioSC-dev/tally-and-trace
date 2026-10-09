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

from typing import Dict, Iterable, List, Optional, Set

from fastapi import HTTPException, status
from sqlalchemy import delete, func, insert, literal, select
from sqlalchemy.orm import Session

from app.models.account import Account
from app.models.budget_entry import BudgetEntry
from app.models.tag import (
    HOUSEHOLD_TAG_NAME, Tag, account_tags, budget_entry_tags, transaction_tags,
)
from app.models.transaction import Transaction

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


# --- Tags on records ------------------------------------------------------------
#
# A user tags a record only with their own tags, and only when they may edit
# it (the record's own write rule, checked by its router). Each record shows
# only the caller's usable tags, so another user's private tag never appears.

LINKS = {
    Account: (account_tags, "account_id"),
    Transaction: (transaction_tags, "transaction_id"),
    BudgetEntry: (budget_entry_tags, "budget_entry_id"),
}


def own_tag_ids(db: Session, user, tag_ids: Iterable[int]) -> List[int]:
    """``tag_ids`` without duplicates, 404ing unless every one is the caller's own.

    Tagging uses the caller's own tags only (a shared tag never grants writes).
    An unknown id and another user's id get the same 404.
    """
    ids = list(dict.fromkeys(tag_ids))
    if not ids:
        return []
    found = {row[0] for row in db.query(Tag.id).filter(Tag.id.in_(ids), Tag.user_id == _uid(user))}
    if found != set(ids):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=TAG_NOT_FOUND)
    return ids


def replace_own_tags(db: Session, model, record_id: int, user, tag_ids: List[int]) -> None:
    """Make the caller's own tags on the record exactly ``tag_ids`` (already checked).

    Tags anyone else put on the record stay. Nothing is committed.
    """
    link, column = LINKS[model]
    own = select(Tag.id).where(Tag.user_id == _uid(user)).scalar_subquery()
    db.execute(delete(link).where(link.c[column] == record_id, link.c.tag_id.in_(own)))
    if tag_ids:
        db.execute(insert(link), [{"tag_id": t, column: record_id} for t in tag_ids])


def copy_explicit_tags(db: Session, entry_id: int, transaction_id: int) -> None:
    """Put a recurring entry's explicit tags on the transaction materialised from it.

    Explicit tags only, never the ones it gets from its accounts, and a copy:
    later changes to the entry's tags leave the transaction as it is. Nothing
    is committed.
    """
    db.execute(insert(transaction_tags).from_select(
        ["tag_id", "transaction_id"],
        select(budget_entry_tags.c.tag_id, literal(transaction_id)).where(
            budget_entry_tags.c.budget_entry_id == entry_id),
    ))


def attach_visible_tags(db: Session, user, records):
    """Set ``visible_tags`` on each record: its explicit tags the caller may see.

    Responses read it as ``tags``. Accepts one record or a list; returns it.
    """
    items = records if isinstance(records, list) else [records]
    by_model: Dict[type, list] = {}
    for record in items:
        record.visible_tags = []
        by_model.setdefault(type(record), []).append(record)
    usable = usable_tag_ids(db, user)
    if not usable:
        return records
    for model, group in by_model.items():
        link, column = LINKS[model]
        rows = db.query(link.c[column], Tag).join(Tag, Tag.id == link.c.tag_id).filter(
            link.c[column].in_([r.id for r in group]), Tag.id.in_(list(usable)),
        ).order_by(Tag.is_system.desc(), Tag.name, Tag.id).all()
        tags_by_record: Dict[int, list] = {}
        for record_id, tag in rows:
            tags_by_record.setdefault(record_id, []).append(tag)
        for record in group:
            record.visible_tags = tags_by_record.get(record.id, [])
    return records
