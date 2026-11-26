"""The one owner of ``allocations.rank`` (STU-786).

Ranked rows are a user's active allocations of type ``savings`` or ``goal``; rank 1
is the top. Every other row has a null rank. Every rank change goes through this
module, and every caller holds the owner's budget lock (``locking.lock_owner_budgets``,
re-entrant) before it reads: each function takes it again first, so a path that
forgot cannot skip it.
"""
from typing import Iterable, List

from fastapi import HTTPException
from sqlalchemy import func
from sqlalchemy.orm import Session

from app.core import locking
from app.models.allocation import Allocation, AllocationType

RANKED_TYPES = (AllocationType.SAVINGS, AllocationType.GOAL)


def is_ranked(allocation_type, is_active) -> bool:
    """Whether an allocation of this type and active flag is in the ranked set."""
    return allocation_type in RANKED_TYPES and is_active is True


def _ranked_query(db: Session, owner_id: int):
    return db.query(Allocation).filter(
        Allocation.user_id == owner_id,
        Allocation.allocation_type.in_(RANKED_TYPES),
        Allocation.is_active.is_(True),
    )


def ranked_for(db: Session, owner_id: int) -> List[Allocation]:
    """All of the owner's ranked allocations, top first. Never paged."""
    locking.lock_owner_budgets(db, owner_id)
    return _ranked_query(db, owner_id).order_by(Allocation.rank, Allocation.id).all()


def _next_rank(db: Session, owner_id: int) -> int:
    top = db.query(func.max(Allocation.rank)).filter(Allocation.user_id == owner_id).scalar()
    return (top or 0) + 1


def place_at_bottom(db: Session, allocation: Allocation) -> None:
    """Put a ranked-set allocation last. It must not hold a rank already."""
    locking.lock_owner_budgets(db, allocation.user_id)
    allocation.rank = _next_rank(db, allocation.user_id)
    db.flush()


def clear_and_close_gap(db: Session, allocation: Allocation) -> None:
    """Take an allocation out of the ranking and move every lower one up a place."""
    locking.lock_owner_budgets(db, allocation.user_id)
    old = allocation.rank
    if old is None:
        return
    allocation.rank = None
    db.flush()
    db.query(Allocation).filter(
        Allocation.user_id == allocation.user_id, Allocation.rank > old,
    ).update({Allocation.rank: Allocation.rank - 1}, synchronize_session="fetch")


def sync_membership(db: Session, allocation: Allocation, was_ranked: bool) -> None:
    """After a create or edit: bring the rank in line with the allocation's new state.

    Entering the ranked set (a create, a reactivation, a type change in) goes to the
    bottom; leaving it clears the rank and closes the gap; staying keeps its place.
    """
    now_ranked = is_ranked(allocation.allocation_type, allocation.is_active)
    if now_ranked and not was_ranked:
        place_at_bottom(db, allocation)
    elif was_ranked and not now_ranked:
        clear_and_close_gap(db, allocation)


def reorder(db: Session, owner_id: int, ids: Iterable[int]) -> List[Allocation]:
    """Rewrite the owner's ranks 1..N to the given complete order, in one transaction.

    An id that is not the owner's (another user's, or none) is a 404. A duplicate,
    an id the owner has but that is not ranked, or a ranked id left out is a 422.
    The caller commits.
    """
    locking.lock_owner_budgets(db, owner_id)
    ids = list(ids)
    found = {a.id: a for a in db.query(Allocation).filter(Allocation.id.in_(set(ids))).all()}
    if any(i not in found or found[i].user_id != owner_id for i in ids):
        raise HTTPException(status_code=404, detail="Allocation not found")
    if len(set(ids)) != len(ids):
        raise HTTPException(status_code=422, detail="Each allocation may be listed only once")
    ranked = {a.id: a for a in _ranked_query(db, owner_id).all()}
    if any(i not in ranked for i in ids):
        raise HTTPException(status_code=422, detail="Only ranked allocations can be ordered")
    if len(ids) != len(ranked):
        raise HTTPException(status_code=422, detail="The list must include every ranked allocation")
    # Two passes, so no moment holds a rank twice: a unique index added later must
    # not break this.
    for allocation in ranked.values():
        allocation.rank = None
    db.flush()
    for place, allocation_id in enumerate(ids, start=1):
        ranked[allocation_id].rank = place
    db.flush()
    return [ranked[i] for i in ids]
