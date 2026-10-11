"""Account shares and the user picker (STU-232, plan §4).

- ``GET/POST /accounts/{id}/shares`` and ``PATCH/DELETE
  /accounts/{id}/shares/{share_id}``: the account's owner or an admin. Anyone
  else with a role on the account gets 403; anyone without one, 404.
- ``GET /shares/received`` and ``DELETE /shares/received/{id}``: the shares the
  caller holds, and leaving one.
- ``GET /users/lookup?email=``: ``{id, display_name}`` on an exact,
  case-insensitive match. Every other case (no such user, the caller, an
  inactive or demo user) is the same 404 "No matching user". Rate-limited per
  caller (429).
- A share is created by ``{email, role}``, resolved by that same lookup and
  counted against the same per-caller limit, never by a raw user id: a user
  is reachable only by someone who knows their exact email.

Rules: the owner is never a share row and can't be removed. Only the owner
grants admin, and an admin can't change or remove another admin's share.
Removing a share, leaving one, or demoting it to viewer deactivates the
sharee's recurring entries that touch the account, so they leave the
projection; their transactions stay (stranded records, ``app/core/access.py``).
Demo users get 403 on every route here and can't be share targets.
"""

import time
from collections import defaultdict, deque
from typing import Deque, Dict, List, Optional

from fastapi import APIRouter, Depends, HTTPException, Query, Response, status
from sqlalchemy import func, or_
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.core.access import (
    ADMIN, EDIT_ROLES, MANAGE_ROLES, OWNER, TOUCHED_COLUMNS, VIEWER, account_role,
    get_account_or_404,
)
from app.core.auth import get_current_active_user
from app.core.database import get_db
from app.core.redaction import display_name
from app.core.seed import DEMO_EMAILS
from app.models.account import Account
from app.models.account_share import AccountShare
from app.models.budget_entry import BudgetEntry
from app.models.user import User
from app.schemas.share import (
    AccountOwner, AccountSharesResponse, ReceivedShare, ShareCreate, ShareResponse,
    ShareUpdate, UserMatch,
)

account_router = APIRouter()
received_router = APIRouter()
users_router = APIRouter()

NO_MATCH = "No matching user"
SHARE_NOT_FOUND = "Share not found"
DEMO_FORBIDDEN = "Demo accounts can't share or be shared with"
MANAGE_FORBIDDEN = "Only the account's owner or an admin can manage its shares"
ADMIN_GRANT_FORBIDDEN = "Only the account's owner can grant admin"
ADMIN_TOUCH_FORBIDDEN = "An admin can't change or remove another admin"
ALREADY_SHARED = "This user already has access to the account"
OWNER_TARGET = "The owner already has full access"

# The picker's per-caller rate limit: LOOKUP_LIMIT calls in LOOKUP_WINDOW seconds.
LOOKUP_LIMIT = 10
LOOKUP_WINDOW = 60.0
_lookups: Dict[int, Deque[float]] = defaultdict(deque)


def _is_demo(user: User) -> bool:
    return (user.email or "").lower() in DEMO_EMAILS


def no_demo(current_user: User = Depends(get_current_active_user)) -> User:
    """The caller, unless a demo user (403)."""
    if _is_demo(current_user):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail=DEMO_FORBIDDEN)
    return current_user


def _managed_account(db: Session, user: User, account_id: int) -> Account:
    """The account if the caller may manage its shares: 404 without a role, 403 below admin."""
    account = get_account_or_404(db, user, account_id)
    if account_role(user, account) not in MANAGE_ROLES:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail=MANAGE_FORBIDDEN)
    return account


def _share_or_404(db: Session, account: Account, share_id: int) -> AccountShare:
    share = (db.query(AccountShare)
             .filter(AccountShare.id == share_id, AccountShare.account_id == account.id)
             .first())
    if share is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=SHARE_NOT_FOUND)
    return share


def _guard_admin_rules(user: User, account: Account, share: AccountShare, new_role=None):
    """Only the owner grants admin; an admin can't touch another admin's share."""
    is_owner = account_role(user, account) == OWNER
    if new_role == ADMIN and not is_owner:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail=ADMIN_GRANT_FORBIDDEN)
    if share.role == ADMIN and not is_owner and share.user_id != user.id:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail=ADMIN_TOUCH_FORBIDDEN)


def deactivate_entries(db: Session, user_id: int, account_id: int) -> int:
    """Deactivate ``user_id``'s recurring entries touching ``account_id`` (not committed)."""
    touches = or_(*(getattr(BudgetEntry, c) == account_id for c in TOUCHED_COLUMNS[BudgetEntry]))
    return (db.query(BudgetEntry)
            .filter(BudgetEntry.user_id == user_id, BudgetEntry.is_active.is_(True), touches)
            .update({BudgetEntry.is_active: False}, synchronize_session=False))


def _share_out(share: AccountShare) -> dict:
    return {"id": share.id, "account_id": share.account_id, "user_id": share.user_id,
            "display_name": display_name(share.user), "role": share.role,
            "created_at": share.created_at}


# --- /accounts/{account_id}/shares ---------------------------------------------------------

@account_router.get("/{account_id}/shares", response_model=AccountSharesResponse)
def list_account_shares(account_id: int, db: Session = Depends(get_db),
                        current_user: User = Depends(no_demo)):
    account = _managed_account(db, current_user, account_id)
    shares = (db.query(AccountShare).filter(AccountShare.account_id == account.id)
              .order_by(AccountShare.created_at, AccountShare.id).all())
    return {"account_id": account.id,
            "owner": AccountOwner(user_id=account.user_id, display_name=display_name(account.user)),
            "shares": [_share_out(s) for s in shares]}


@account_router.post("/{account_id}/shares", response_model=ShareResponse,
                     status_code=status.HTTP_201_CREATED)
def create_account_share(account_id: int, body: ShareCreate, db: Session = Depends(get_db),
                         current_user: User = Depends(no_demo)):
    # Every request counts against the picker's limit, whatever it then answers.
    _check_rate(current_user)
    account = _managed_account(db, current_user, account_id)
    if body.role == ADMIN and account_role(current_user, account) != OWNER:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail=ADMIN_GRANT_FORBIDDEN)
    target = _match(db, body.email)
    if target is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=NO_MATCH)
    if target.id == account.user_id:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=OWNER_TARGET)
    share = AccountShare(account_id=account.id, user_id=target.id, role=body.role,
                         created_by=current_user.id)
    db.add(share)
    try:
        db.commit()
    except IntegrityError as exc:
        db.rollback()
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=ALREADY_SHARED) from exc
    db.refresh(share)
    return _share_out(share)


@account_router.patch("/{account_id}/shares/{share_id}", response_model=ShareResponse)
def update_account_share(account_id: int, share_id: int, body: ShareUpdate,
                         db: Session = Depends(get_db), current_user: User = Depends(no_demo)):
    account = _managed_account(db, current_user, account_id)
    share = _share_or_404(db, account, share_id)
    _guard_admin_rules(current_user, account, share, body.role)
    demoted = share.role in EDIT_ROLES and body.role == VIEWER
    share.role = body.role
    if demoted:
        deactivate_entries(db, share.user_id, account.id)
    db.commit()
    db.refresh(share)
    return _share_out(share)


@account_router.delete("/{account_id}/shares/{share_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_account_share(account_id: int, share_id: int, db: Session = Depends(get_db),
                         current_user: User = Depends(no_demo)):
    account = _managed_account(db, current_user, account_id)
    share = _share_or_404(db, account, share_id)
    _guard_admin_rules(current_user, account, share)
    deactivate_entries(db, share.user_id, account.id)
    db.delete(share)
    db.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)


# --- /shares/received ----------------------------------------------------------------------

@received_router.get("/received", response_model=List[ReceivedShare])
def list_received_shares(db: Session = Depends(get_db), current_user: User = Depends(no_demo)):
    shares = (db.query(AccountShare).filter(AccountShare.user_id == current_user.id)
              .order_by(AccountShare.created_at, AccountShare.id).all())
    return [{"id": s.id, "account_id": s.account_id, "account_name": s.account.name,
             "owner_name": display_name(s.account.user), "role": s.role,
             "created_at": s.created_at} for s in shares]


@received_router.delete("/received/{share_id}", status_code=status.HTTP_204_NO_CONTENT)
def leave_share(share_id: int, db: Session = Depends(get_db),
                current_user: User = Depends(no_demo)):
    share = (db.query(AccountShare)
             .filter(AccountShare.id == share_id, AccountShare.user_id == current_user.id)
             .first())
    if share is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=SHARE_NOT_FOUND)
    deactivate_entries(db, current_user.id, share.account_id)
    db.delete(share)
    db.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)


# --- /users/lookup -------------------------------------------------------------------------

def _rate_limited(user_id: int) -> bool:
    now = time.monotonic()
    hits = _lookups[user_id]
    while hits and now - hits[0] >= LOOKUP_WINDOW:
        hits.popleft()
    if len(hits) >= LOOKUP_LIMIT:
        return True
    hits.append(now)
    return False


def _check_rate(user: User) -> None:
    """429 once the caller has used up the picker's limit (lookups and share creation)."""
    if _rate_limited(user.id):
        raise HTTPException(status_code=status.HTTP_429_TOO_MANY_REQUESTS,
                            detail="Too many lookups; try again in a minute")


def _match(db: Session, email: str) -> Optional[User]:
    """The active, non-demo user with exactly this email (case-insensitive), else None.

    ``users.email`` is unique only as stored, so two accounts can differ by case
    alone (registered before registration compared case-insensitively). Such
    an email names no one: None, never whichever row comes first.
    """
    wanted = email.strip().lower()
    users = db.query(User).filter(func.lower(User.email) == wanted).limit(2).all()
    if len(users) != 1:
        return None
    user = users[0]
    if not user.is_active or _is_demo(user):
        return None
    return user


@users_router.get("/lookup", response_model=UserMatch)
def lookup_user(email: str = Query(..., min_length=1, max_length=255),
                db: Session = Depends(get_db), current_user: User = Depends(no_demo)):
    _check_rate(current_user)
    user = _match(db, email)
    if user is None or user.id == current_user.id:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=NO_MATCH)
    return {"id": user.id, "display_name": display_name(user) or ""}
