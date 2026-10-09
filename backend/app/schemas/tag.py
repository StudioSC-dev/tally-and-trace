from datetime import datetime
from typing import Optional

from pydantic import BaseModel, Field, field_validator

HEX_COLOR = r"^#[0-9A-Fa-f]{6}$"


def _clean_name(value: Optional[str]) -> Optional[str]:
    if value is None:
        return None
    value = value.strip()
    if not value:
        raise ValueError("name cannot be blank")
    return value


class TagCreate(BaseModel):
    name: str = Field(..., min_length=1, max_length=50)
    color: Optional[str] = Field(None, pattern=HEX_COLOR)

    @field_validator("name")
    @classmethod
    def _name_not_blank(cls, v):
        return _clean_name(v)


class TagUpdate(BaseModel):
    """Rename or recolour a tag. Omit a field to leave it unchanged."""
    name: Optional[str] = Field(None, min_length=1, max_length=50)
    color: Optional[str] = Field(None, pattern=HEX_COLOR)

    @field_validator("name")
    @classmethod
    def _name_not_null(cls, v):
        if v is None:
            raise ValueError("name cannot be null")
        return _clean_name(v)


class TagSummary(BaseModel):
    """A tag as it appears on a record: only the caller's own tags are listed."""
    id: int
    name: str
    color: Optional[str] = None
    is_system: bool

    class Config:
        from_attributes = True


class TagResponse(TagSummary):
    created_at: datetime
