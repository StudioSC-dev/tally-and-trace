from pydantic import BaseModel, Field
from typing import Optional, List
from datetime import datetime
from app.models.entity import EntityType, MemberRole


class EntityCreate(BaseModel):
    name: str = Field(..., min_length=1, max_length=150)
    entity_type: EntityType = EntityType.PERSONAL
    description: Optional[str] = None
    default_currency: Optional[str] = "PHP"


class EntityUpdate(BaseModel):
    name: Optional[str] = Field(None, min_length=1, max_length=150)
    entity_type: Optional[EntityType] = None
    description: Optional[str] = None
    default_currency: Optional[str] = None
    is_active: Optional[bool] = None


class EntityResponse(BaseModel):
    id: int
    name: str
    entity_type: EntityType
    description: Optional[str] = None
    default_currency: Optional[str] = None
    is_active: bool
    created_at: datetime
    updated_at: Optional[datetime] = None

    class Config:
        from_attributes = True


class MembershipCreate(BaseModel):
    user_id: int = Field(..., gt=0)
    role: MemberRole = MemberRole.MEMBER


class EntityMembershipResponse(BaseModel):
    id: int
    user_id: int
    entity_id: int
    role: MemberRole
    joined_at: datetime

    class Config:
        from_attributes = True


class EntityWithMembershipsResponse(EntityResponse):
    memberships: List[EntityMembershipResponse] = []
