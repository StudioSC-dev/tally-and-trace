"""Account shares and the user picker (STU-232); see ``app/routers/shares.py``."""

from datetime import datetime
from typing import List, Literal, Optional

from pydantic import BaseModel, ConfigDict

ShareRole = Literal["viewer", "editor", "admin"]


class UserMatch(BaseModel):
    """The picker's only answer: an exact email match, never the email itself."""

    id: int
    display_name: str


class ShareCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    user_id: int
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
