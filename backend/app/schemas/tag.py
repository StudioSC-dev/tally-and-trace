from datetime import datetime
from typing import List, Optional

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


# Tag fields shared by the records that carry tags (accounts, transactions and
# recurring entries). On create, ``tag_ids`` are the caller's own tags to put
# on the record. On update, an omitted ``tag_ids`` leaves the caller's tags as
# they are and a list replaces them (``[]`` removes them); null is refused.
MAX_TAGS = 50


def tag_ids_create_field():
    return Field(default_factory=list, max_length=MAX_TAGS,
                 description="The caller's own tag ids to put on the record")


def tag_ids_update_field():
    return Field(None, max_length=MAX_TAGS,
                 description="Replaces the caller's tags on the record; omit to keep them")


def tag_ids_not_null(value):
    if value is None:
        raise ValueError("tag_ids cannot be null; omit it to leave the tags unchanged")
    return value


def tags_response_field():
    """The record's explicit tags the caller may see (their own), as ``tags``."""
    return Field(default_factory=list, validation_alias="visible_tags")


TagIds = List[int]
TagSummaries = List[TagSummary]
