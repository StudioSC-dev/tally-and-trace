"""Default categories: the set every new account starts with.

The definitions live in ``constants/default_categories.json`` (name,
description, colour, kind). ``is_expense`` is not stored there; it is derived
from the kind, as the categories router does.
"""

import json
from pathlib import Path
from typing import List

from sqlalchemy.orm import Session

from app.models.category import Category, CategoryKind

_DEFAULTS_PATH = Path(__file__).resolve().parent.parent / "constants" / "default_categories.json"

with _DEFAULTS_PATH.open(encoding="utf-8") as _f:
    DEFAULT_CATEGORIES: List[dict] = json.load(_f)


def ensure_default_categories(db: Session, user) -> int:
    """Give the user each default category they don't already own; returns how many were made.

    A default is matched on its exact name and kind; an inactive (soft-deleted)
    category with the same name and kind counts as existing, so it is not
    recreated.
    Flushed, never committed: called in the same transaction that creates the
    user, so a user never exists without them.
    """
    uid = getattr(user, "id", user)
    owned = {
        (name, kind)
        for name, kind in db.query(Category.name, Category.kind).filter(Category.user_id == uid)
    }
    created = 0
    for entry in DEFAULT_CATEGORIES:
        kind = CategoryKind(entry["kind"])
        if (entry["name"], kind) in owned:
            continue
        db.add(Category(
            user_id=uid, name=entry["name"], description=entry["description"],
            color=entry["color"], kind=kind,
            is_expense=kind == CategoryKind.EXPENSE, is_active=True))
        created += 1
    if created:
        db.flush()
    return created
