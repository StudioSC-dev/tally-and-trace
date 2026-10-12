"""Account shares, Household tag shares and the user picker (STU-232, STU-233).

See ``app/routers/shares.py``.
"""

from datetime import datetime
from typing import List, Literal, Optional

from pydantic import BaseModel, ConfigDict, Field

ShareRole = Literal["viewer", "editor", "admin"]


class UserMatch(BaseModel):
    """The picker's only answer: an exact email match, never the email itself."""

    id: int
    display_name: str


class ShareCreate(BaseModel):
    """A new share, by the sharee's exact email (resolved like ``/users/lookup``)."""

    model_config = ConfigDict(extra="forbid")

    email: str = Field(..., min_length=1, max_length=255)
    role: ShareRole


class ShareUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    role: ShareRole


class ShareResponse(BaseModel):
    id: int
    account_id: int
    user_id: int
    display_name: Optional[str] = None
    role: ShareRole
    created_at: Optional[datetime] = None


class AccountOwner(BaseModel):
    user_id: int
    display_name: Optional[str] = None
    role: Literal["owner"] = "owner"


class AccountSharesResponse(BaseModel):
    account_id: int
    owner: AccountOwner
    shares: List[ShareResponse]


class ReceivedShare(BaseModel):
    id: int
    account_id: int
    account_name: str
    owner_name: Optional[str] = None
    role: ShareRole
    created_at: Optional[datetime] = None


class TagShareCreate(BaseModel):
    """A new Household tag share, by the sharee's exact email (like ``/users/lookup``)."""

    model_config = ConfigDict(extra="forbid")

    email: str = Field(..., min_length=1, max_length=255)


class TagShareResponse(BaseModel):
    """One holder of the caller's Household tag. The role is always ``tag_viewer``."""

    id: int
    tag_id: int
    user_id: int
    display_name: Optional[str] = None
    created_at: Optional[datetime] = None


class HouseholdSharesResponse(BaseModel):
    tag_id: int
    shares: List[TagShareResponse]


class ReceivedTagShare(BaseModel):
    """A Household tag share the caller holds; ``sharer_id`` keys ``/household/{sharer_id}``."""

    id: int
    tag_id: int
    sharer_id: int
    sharer_name: Optional[str] = None
    created_at: Optional[datetime] = None
