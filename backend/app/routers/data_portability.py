"""
Data portability endpoints for Tally & Trace.
Supports CSV and JSON export of all financial data scoped to an entity.
"""

import csv
import io
import json
from datetime import datetime
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import Response, StreamingResponse
from sqlalchemy.orm import Session

from app.core.auth import get_current_active_user
from app.core.database import get_db
from app.models.account import Account
from app.models.allocation import Allocation
from app.models.budget_entry import BudgetEntry
from app.models.category import Category
from app.models.entity import Entity, EntityMembership
from app.models.transaction import Transaction
from app.models.user import User
from app.models.wishlist_item import WishlistItem

router = APIRouter()


def _check_entity_access(db: Session, entity_id: int, user_id: int) -> Entity:
    entity = db.query(Entity).filter(Entity.id == entity_id, Entity.is_active == True).first()
    if not entity:
        raise HTTPException(status_code=404, detail="Entity not found")
    membership = (
        db.query(EntityMembership)
        .filter(
            EntityMembership.entity_id == entity_id,
            EntityMembership.user_id == user_id,
        )
        .first()
    )
    if not membership:
        raise HTTPException(status_code=403, detail="You do not have access to this entity")
    return entity


def _serialize(obj):
    """JSON-safe serializer for ORM objects."""
    if isinstance(obj, datetime):
        return obj.isoformat()
    if hasattr(obj, "value"):
        return obj.value
    return str(obj)


def _orm_to_dict(instance) -> dict:
    """Convert a SQLAlchemy ORM instance to a plain dict (columns only)."""
    result = {}
    for col in instance.__table__.columns:
        value = getattr(instance, col.name)
        if isinstance(value, datetime):
            value = value.isoformat()
        elif hasattr(value, "value"):
            value = value.value
        result[col.name] = value
    return result


# ---------------------------------------------------------------------------
# JSON export
# ---------------------------------------------------------------------------

@router.get("/entities/{entity_id}/export.json")
def export_json(
    entity_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_active_user),
):
    """Export all financial data for an entity as a single JSON file."""
    entity = _check_entity_access(db, entity_id, current_user.id)

    accounts = db.query(Account).filter(Account.entity_id == entity_id).all()
    transactions = db.query(Transaction).filter(Transaction.entity_id == entity_id).all()
    categories = db.query(Category).filter(Category.entity_id == entity_id).all()
    allocations = db.query(Allocation).filter(Allocation.entity_id == entity_id).all()
    budget_entries = db.query(BudgetEntry).filter(BudgetEntry.entity_id == entity_id).all()
    wishlist_items = db.query(WishlistItem).filter(WishlistItem.entity_id == entity_id).all()

    payload = {
        "entity": _orm_to_dict(entity),
        "exported_at": datetime.utcnow().isoformat(),
        "accounts": [_orm_to_dict(r) for r in accounts],
        "transactions": [_orm_to_dict(r) for r in transactions],
        "categories": [_orm_to_dict(r) for r in categories],
        "allocations": [_orm_to_dict(r) for r in allocations],
        "budget_entries": [_orm_to_dict(r) for r in budget_entries],
        "wishlist_items": [_orm_to_dict(r) for r in wishlist_items],
    }

    json_bytes = json.dumps(payload, default=str, indent=2).encode("utf-8")
    filename = f"tally_trace_entity_{entity_id}_{datetime.utcnow().strftime('%Y%m%d')}.json"

    return Response(
        content=json_bytes,
        media_type="application/json",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


# ---------------------------------------------------------------------------
# CSV export (zip of individual CSVs per table)
# ---------------------------------------------------------------------------

def _to_csv_bytes(rows: list[dict]) -> bytes:
    if not rows:
        return b""
    output = io.StringIO()
    writer = csv.DictWriter(output, fieldnames=list(rows[0].keys()))
    writer.writeheader()
    writer.writerows(rows)
    return output.getvalue().encode("utf-8")


@router.get("/entities/{entity_id}/export.csv")
def export_csv(
    entity_id: int,
    table: Optional[str] = Query(
        None,
        description="Specific table to export: accounts, transactions, categories, allocations, budget_entries, wishlist_items. Omit to get a zip of all.",
    ),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_active_user),
):
    """
    Export financial data for an entity as CSV.

    - If `table` is specified, returns a single CSV file.
    - Otherwise returns a ZIP archive containing one CSV per table.
    """
    _check_entity_access(db, entity_id, current_user.id)

    table_map = {
        "accounts": lambda: db.query(Account).filter(Account.entity_id == entity_id).all(),
        "transactions": lambda: db.query(Transaction).filter(Transaction.entity_id == entity_id).all(),
        "categories": lambda: db.query(Category).filter(Category.entity_id == entity_id).all(),
        "allocations": lambda: db.query(Allocation).filter(Allocation.entity_id == entity_id).all(),
        "budget_entries": lambda: db.query(BudgetEntry).filter(BudgetEntry.entity_id == entity_id).all(),
        "wishlist_items": lambda: db.query(WishlistItem).filter(WishlistItem.entity_id == entity_id).all(),
    }

    date_str = datetime.utcnow().strftime("%Y%m%d")

    if table:
        if table not in table_map:
            raise HTTPException(status_code=400, detail=f"Unknown table '{table}'. Choose from: {', '.join(table_map)}")
        rows = [_orm_to_dict(r) for r in table_map[table]()]
        csv_bytes = _to_csv_bytes(rows)
        filename = f"tally_trace_entity_{entity_id}_{table}_{date_str}.csv"
        return Response(
            content=csv_bytes,
            media_type="text/csv",
            headers={"Content-Disposition": f'attachment; filename="{filename}"'},
        )

    # Return ZIP of all tables
    import zipfile

    zip_buffer = io.BytesIO()
    with zipfile.ZipFile(zip_buffer, "w", zipfile.ZIP_DEFLATED) as zf:
        for tname, query_fn in table_map.items():
            rows = [_orm_to_dict(r) for r in query_fn()]
            csv_bytes = _to_csv_bytes(rows)
            zf.writestr(f"{tname}.csv", csv_bytes)

    zip_buffer.seek(0)
    filename = f"tally_trace_entity_{entity_id}_{date_str}.zip"
    return Response(
        content=zip_buffer.getvalue(),
        media_type="application/zip",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )
