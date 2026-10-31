"""Scheduled jobs, called by a token instead of a user (STU-343 Plan B).

``POST /jobs/post-due-installments`` posts every due month of the auto-post-on
card installments (services/posting.py ``post_due_installments``), as each
entry's creator. A GitHub Actions schedule calls it every morning.

The caller sends ``X-Job-Token``, compared in constant time with
``settings.JOB_TOKEN``. With no token configured the endpoint does not exist
(404); a missing or wrong token is a 401. The response carries counts only (no
ids, names or amounts), because the workflow's logs are public.
"""
import hmac
from datetime import date
from typing import Optional

from fastapi import APIRouter, Depends, Header, HTTPException, Query
from sqlalchemy.orm import Session

from app.core.config import settings
from app.core.database import get_db
from app.core.time import manila_today
from app.services import posting

router = APIRouter()


def _require_job_token(token: Optional[str]) -> None:
    expected = settings.JOB_TOKEN
    if expected is None:
        raise HTTPException(status_code=404, detail="Not Found")
    if token is None or not hmac.compare_digest(token.encode(), expected.encode()):
        raise HTTPException(status_code=401, detail="Invalid job token")


@router.post("/post-due-installments")
def post_due_installments_job(
    dry_run: bool = Query(False),
    through: Optional[date] = Query(None),
    x_job_token: Optional[str] = Header(None),
    db: Session = Depends(get_db),
):
    """Post the due card installment months through ``through`` (default and
    latest: Manila's today; a later day is a 422). ``dry_run`` rolls each
    entry back after computing it. Returns ``{dry_run, posted, skipped}``."""
    _require_job_token(x_job_token)
    today = manila_today()
    if through is None:
        through = today
    elif through > today:
        raise HTTPException(status_code=422, detail="through cannot be after today")
    result = posting.post_due_installments(db, through=through, dry_run=dry_run)
    return {"dry_run": dry_run, "posted": result.posted, "skipped": dict(result.skipped)}
