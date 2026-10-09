"""
Data portability endpoints for Tally & Trace.

``GET /data/export.json`` and ``GET /data/export.csv`` export the caller's own
data: their records in full, plus every other record they can read through the
Limited models (records by others on accounts they own or that are shared with
them, and their own records on an account they can no longer view). The schema
is explicit (``app/services/export.py``).
"""

import csv
import io
import json
import zipfile
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import Response
from sqlalchemy.orm import Session

from app.core.auth import get_current_active_user
from app.core.database import get_db
from app.core.time import utc_now
from app.models.user import User
from app.services.export import TABLE_FIELDS, build_export

router = APIRouter()


def _to_csv_bytes(fields: tuple, rows: list) -> bytes:
    """One CSV with a header row, even when there are no rows."""
    output = io.StringIO()
    writer = csv.DictWriter(output, fieldnames=list(fields))
    writer.writeheader()
    for row in rows:
        writer.writerow({k: json.dumps(v) if isinstance(v, (dict, list)) else v
                         for k, v in row.items()})
    return output.getvalue().encode("utf-8")


@router.get("/export.json")
def export_json(
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_active_user),
):
    """Export the caller's data as a single JSON file."""
    payload = build_export(db, current_user)
    filename = f"tally_trace_export_{utc_now().strftime('%Y%m%d')}.json"
    return Response(
        content=json.dumps(payload, indent=2).encode("utf-8"),
        media_type="application/json",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@router.get("/export.csv")
def export_csv(
    table: Optional[str] = Query(
        None,
        description="One table: " + ", ".join(TABLE_FIELDS) + ". Omit for a ZIP of all of them.",
    ),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_active_user),
):
    """
    Export the caller's data as CSV.

    - With ``table``, returns that one CSV file.
    - Otherwise returns a ZIP archive with one CSV per table.
    """
    if table is not None and table not in TABLE_FIELDS:
        raise HTTPException(
            status_code=400,
            detail=f"Unknown table '{table}'. Choose from: {', '.join(TABLE_FIELDS)}",
        )
    payload = build_export(db, current_user)
    date_str = utc_now().strftime("%Y%m%d")

    if table:
        filename = f"tally_trace_{table}_{date_str}.csv"
        return Response(
            content=_to_csv_bytes(TABLE_FIELDS[table], payload[table]),
            media_type="text/csv",
            headers={"Content-Disposition": f'attachment; filename="{filename}"'},
        )

    zip_buffer = io.BytesIO()
    with zipfile.ZipFile(zip_buffer, "w", zipfile.ZIP_DEFLATED) as zf:
        for name, fields in TABLE_FIELDS.items():
            zf.writestr(f"{name}.csv", _to_csv_bytes(fields, payload[name]))
    filename = f"tally_trace_export_{date_str}.zip"
    return Response(
        content=zip_buffer.getvalue(),
        media_type="application/zip",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )
