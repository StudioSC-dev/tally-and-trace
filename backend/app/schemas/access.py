"""Fields every shared-record response carries (see app/core/redaction.py)."""
from typing import Optional

from pydantic import BaseModel


class RecordPermissions(BaseModel):
    """What the caller may do to a record, computed by the server.

    Clients show controls from these flags only, never from the record's ``view``.
    """
    can_edit: bool
    can_delete: bool
    can_post: bool
    can_revert: bool
    can_tag: bool


class AccountRef(BaseModel):
    """An account a record touches: ``{id, name}`` when the caller can view it,
    otherwise ``{id: null, name}`` with a neutral name ("Other account",
    "Loan payment" or "Card payment")."""
    id: Optional[int] = None
    name: str


class AccountPermissions(BaseModel):
    can_edit_settings: bool
    can_manage_shares: bool
    can_add_transactions: bool
    # Deleting or deactivating the account (``is_active``): its owner only.
    can_delete: bool
