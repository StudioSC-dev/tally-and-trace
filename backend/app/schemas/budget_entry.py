from datetime import date, datetime
from typing import Annotated, Optional, List, Literal, Union
from pydantic import BaseModel, Field, field_validator, model_validator
from app.core.record_dates import check_record_date
from app.schemas.access import AccountRef, RecordPermissions
from app.schemas.transaction import TransactionOut
from app.models.budget_entry import BudgetEntryType
from app.models.transaction import RecurrenceFrequency
from app.models.user import CurrencyType
from app.schemas.tag import (
    TagIds, TagSummaries, tag_ids_create_field, tag_ids_not_null, tag_ids_update_field,
    tags_response_field,
)


DayRule = Literal["last_weekday"]
BillingKind = Literal["subscription", "bill"]
EntryKind = Literal["subscription", "installment", "bill", "cash"]


class BudgetEntryBase(BaseModel):
    name: str = Field(..., min_length=1, max_length=150)
    entry_type: BudgetEntryType
    amount: float = Field(..., gt=0)
    currency: CurrencyType = CurrencyType.PHP
    cadence: RecurrenceFrequency = RecurrenceFrequency.MONTHLY
    next_occurrence: datetime
    lead_time_days: int = Field(0, ge=0, le=365)
    # Only meaningful when cadence == SEMI_MONTHLY. Days clamp to month length at projection time.
    semi_monthly_day_1: int = Field(1, ge=1, le=31)
    semi_monthly_day_2: int = Field(15, ge=1, le=31)
    # Month-family cadences only (services/recurrence.py): the intended day of the
    # month, or the rule "last_weekday", never both. Omitted on create, the anchor
    # is next_occurrence's day; next_occurrence must be on the day either names.
    anchor_day: Optional[int] = Field(None, ge=1, le=31)
    day_rule: Optional[DayRule] = None
    end_mode: Literal["indefinite", "on_date", "after_occurrences"] = "indefinite"
    account_id: Optional[int] = Field(None, gt=0)
    overflow_account_id: Optional[int] = Field(None, gt=0)
    # Recurring transfer: occurrences move money from account_id to this account.
    transfer_to_account_id: Optional[int] = Field(None, gt=0)
    category_id: Optional[int] = Field(None, gt=0)
    allocation_id: Optional[int] = Field(None, gt=0)
    is_autopay: bool = False
    is_active: bool = True
    description: Optional[str] = Field(None, max_length=500)
    end_date: Optional[datetime] = None
    max_occurrences: Optional[int] = Field(None, ge=0, le=360)
    # Installments paid before import with no linked transaction; counts toward "n of m".
    occurrences_paid_offset: int = Field(0, ge=0, le=360)
    # Card expenses: how an open-ended entry is billed. Unset on create, an open-ended
    # card expense gets a server default; an explicit null is stored as sent.
    billing_kind: Optional[BillingKind] = None


ZERO_REMAINING_MESSAGE = (
    "max_occurrences of 0 is only allowed for inactive 'after_occurrences' entries"
)


def zero_remaining_allowed(end_mode: str, max_occurrences: Optional[int], is_active: Optional[bool]) -> bool:
    """0 remaining means a completed installment: only valid when inactive."""
    if max_occurrences != 0:
        return True
    return end_mode == "after_occurrences" and is_active is False


class BudgetEntryCreate(BudgetEntryBase):
    tag_ids: TagIds = tag_ids_create_field()

    @model_validator(mode="after")
    def _zero_remaining_only_when_completed(self):
        if not zero_remaining_allowed(self.end_mode, self.max_occurrences, self.is_active):
            raise ValueError(ZERO_REMAINING_MESSAGE)
        return self


class BudgetEntryUpdate(BaseModel):
    name: Optional[str] = Field(None, min_length=1, max_length=150)
    entry_type: Optional[BudgetEntryType] = None
    amount: Optional[float] = Field(None, gt=0)
    currency: Optional[CurrencyType] = None
    cadence: Optional[RecurrenceFrequency] = None
    next_occurrence: Optional[datetime] = None
    lead_time_days: Optional[int] = Field(None, ge=0, le=365)
    semi_monthly_day_1: Optional[int] = Field(None, ge=1, le=31)
    semi_monthly_day_2: Optional[int] = Field(None, ge=1, le=31)
    # Null clears (see services/recurrence.py ``resolve_day_fields``).
    anchor_day: Optional[int] = Field(None, ge=1, le=31)
    day_rule: Optional[DayRule] = None
    account_id: Optional[int] = Field(None, gt=0)
    overflow_account_id: Optional[int] = Field(None, gt=0)
    transfer_to_account_id: Optional[int] = Field(None, gt=0)
    category_id: Optional[int] = Field(None, gt=0)
    allocation_id: Optional[int] = Field(None, gt=0)
    is_autopay: Optional[bool] = None
    is_active: Optional[bool] = None
    description: Optional[str] = Field(None, max_length=500)
    end_mode: Optional[Literal["indefinite", "on_date", "after_occurrences"]] = None
    end_date: Optional[datetime] = None
    max_occurrences: Optional[int] = Field(None, ge=0, le=360)
    occurrences_paid_offset: Optional[int] = Field(None, ge=0, le=360)
    billing_kind: Optional[BillingKind] = None
    tag_ids: Optional[TagIds] = tag_ids_update_field()
    # The ``updated_at`` of the copy the edit was made from, sent back unchanged.
    # When sent (null included) it must equal the stored value exactly, or the
    # edit is refused with 409. Omitted, the edit is not checked. Never stored.
    expected_updated_at: Optional[datetime] = None

    @field_validator("tag_ids")
    @classmethod
    def _tag_ids_not_null(cls, v):
        return tag_ids_not_null(v)

    @field_validator("occurrences_paid_offset")
    @classmethod
    def _offset_not_null(cls, v):
        # Omit the field to leave it unchanged; an explicit null would violate NOT NULL.
        if v is None:
            raise ValueError("occurrences_paid_offset cannot be null")
        return v


class BudgetEntryFields(BudgetEntryBase):
    """A recurring entry's stored fields as its creator sees them (no access fields)."""
    id: int
    created_at: datetime
    updated_at: Optional[datetime] = None
    # Installments only ("n of m"): occurrences materialised so far, counted from the
    # linked transactions. None for open-ended entries, where the notion doesn't apply.
    occurrences_paid: Optional[int] = None
    # Read-only, derived (services/recurring_kinds.py); null for income and transfers.
    kind: Optional[EntryKind] = None
    # Read-only (STU-343 Plan B): set by create and the review, never by an edit.
    installment_reviewed: bool = False
    auto_post_enabled: bool = False
    tags: TagSummaries = tags_response_field()

    class Config:
        from_attributes = True


class BudgetEntryResponse(BudgetEntryFields):
    """``view`` "full": the creator's view of their own entry."""
    view: Literal["full"] = "full"
    permissions: RecordPermissions
    created_by: Optional[str] = None


class SharedFullRecurringEntry(BaseModel):
    """``view`` "shared_full": an editor's or admin's view of someone else's entry.

    The owner schema without the creator's category and allocation, plus
    ``category_name``.
    """
    view: Literal["shared_full"]
    id: int
    permissions: RecordPermissions
    created_by: Optional[str] = None
    name: str
    entry_type: BudgetEntryType
    amount: float
    currency: CurrencyType
    cadence: RecurrenceFrequency
    next_occurrence: datetime
    lead_time_days: int = 0
    semi_monthly_day_1: int = 1
    semi_monthly_day_2: int = 15
    anchor_day: Optional[int] = None
    day_rule: Optional[DayRule] = None
    end_mode: Literal["indefinite", "on_date", "after_occurrences"] = "indefinite"
    account_id: Optional[int] = None
    overflow_account_id: Optional[int] = None
    transfer_to_account_id: Optional[int] = None
    is_autopay: bool = False
    is_active: bool = True
    description: Optional[str] = None
    end_date: Optional[datetime] = None
    max_occurrences: Optional[int] = None
    occurrences_paid_offset: int = 0
    occurrences_paid: Optional[int] = None
    billing_kind: Optional[BillingKind] = None
    kind: Optional[EntryKind] = None
    installment_reviewed: bool = False
    auto_post_enabled: bool = False
    category_name: Optional[str] = None
    tags: TagSummaries = tags_response_field()
    created_at: datetime
    updated_at: Optional[datetime] = None


class LimitedRecurringEntry(BaseModel):
    """``view`` "limited": the allowlist for everyone else (see app/core/redaction.py)."""
    view: Literal["limited"]
    id: int
    permissions: RecordPermissions
    created_by: Optional[str] = None
    display_name: Optional[str] = None
    amount: float
    currency: CurrencyType
    entry_type: BudgetEntryType
    cadence: RecurrenceFrequency
    next_occurrence: datetime
    end_date: Optional[datetime] = None
    category_name: Optional[str] = None
    account: Optional[AccountRef] = None
    counterpart: Optional[AccountRef] = None
    tags: TagSummaries = tags_response_field()


BudgetEntryOut = Annotated[
    Union[BudgetEntryResponse, SharedFullRecurringEntry, LimitedRecurringEntry],
    Field(discriminator="view"),
]


class BudgetEntryListResponse(BaseModel):
    items: List[BudgetEntryOut]
    total: int
    has_more: bool


class BudgetEntryMaterialize(BaseModel):
    """Post a due recurring entry as an actual transaction."""
    # The occurrence being recorded, matched by calendar day against the schedule
    # (services/posting.py ``resolve_occurrence``); defaults to next_occurrence.
    occurrence_date: Optional[datetime] = None
    transaction_date: Optional[datetime] = None  # defaults to the occurrence
    amount: Optional[float] = Field(None, gt=0)   # defaults to the entry's amount
    advance: bool = True                          # advance next_occurrence to the following one
    # False records a card expense's occurrence as Charged: one pending debit
    # linked to it (the card balance does not move until it is posted).
    is_posted: bool = True
    transfer_fee: float = Field(0, ge=0)          # transfer entries only: fee charged on the source
    # Transfer entries only: what the destination received, in its own currency.
    # Required when the destination's currency differs from the source's.
    received_amount: Optional[float] = Field(None, ge=0)

    @field_validator("transaction_date")
    @classmethod
    def _transaction_date_in_range(cls, v):
        return check_record_date(v)


class EntryOccurrence(BaseModel):
    """One occurrence offered by Mark paid."""
    occurrence_date: date
    due: bool  # on or before today on the Manila calendar
    # The row(s) already standing for it: one pending (posted by Mark paid), one
    # posted (Mark paid only moves the schedule on), or several (refused).
    linked: Optional[Literal["pending", "posted", "ambiguous"]] = None
    skipped_before: int  # unrecorded occurrences before it, from next_occurrence
    # Walked occurrences left out of the listing immediately before this one
    # (0 when it follows the previous listed one, or is the walk's first).
    omitted_before: int


class EntryOccurrences(BaseModel):
    """GET /budget-entries/{id}/occurrences."""
    entry_id: int
    today: date
    capped: bool
    kind: Optional[EntryKind] = None
    due_unposted: int
    # The first and last of those, listed or not; None when due_unposted is 0.
    oldest_due: Optional[date] = None
    latest_due: Optional[date] = None
    # The first walked occurrence, due or not, listed or not, that no posted row
    # stands for; None when every walked occurrence is recorded.
    oldest_unrecorded: Optional[date] = None
    omitted: int  # walked occurrences left out of ``occurrences``
    occurrences: List[EntryOccurrence]


class MaterializeDueItem(BaseModel):
    occurrence_date: date
    outcome: Literal["created", "posted_pending", "already_posted"]
    transaction: TransactionOut


class MaterializeDueResult(BaseModel):
    """POST /budget-entries/{id}/materialize-due: every due occurrence, in order."""
    entry_id: int
    results: List[MaterializeDueItem]
    next_occurrence: datetime
    is_active: bool


class PostDueInstallmentsRequest(BaseModel):
    """POST /budget-entries/post-due-installments: who asked. ``page_open`` is
    the Transactions page's automatic run, throttled per user; ``button`` is
    Post now, never throttled."""
    trigger: Literal["button", "page_open"] = "button"


class PostDueEntry(BaseModel):
    """One entry of a backstop run: months posted, and why it stopped (null when it did not)."""
    entry_id: int
    posted: int
    skipped_reason: Optional[str] = None


class PostDueInstallmentsResult(BaseModel):
    """POST /budget-entries/post-due-installments (STU-343 Plan B).

    ``posted`` counts months that moved money (new rows and posted pending
    rows); ``skipped`` counts entries by reason. Every listed entry is one the
    caller can edit. ``throttled`` is a page-open run refused because the
    caller's last one was under 15 minutes ago; it posts nothing.
    """
    trigger: Literal["button", "page_open"]
    throttled: bool
    posted: int
    skipped: dict[str, int]
    entries: List[PostDueEntry]


AutoPostBlock = Literal["foreign_currency", "no_statement_cycle", "inactive", "not_installment"]


class ReviewMissedMonth(BaseModel):
    """A due month no posted row stands for; ``pending`` when a pending row is
    linked to it (the review posts that row, keeping its date)."""
    occurrence_date: date
    linked: Optional[Literal["pending"]] = None


class ReviewCandidateRow(BaseModel):
    """A possible duplicate: the creator's own unlinked charge on the card."""
    id: int
    date: date
    amount: float
    is_posted: bool
    description: Optional[str] = None


class ReviewCandidates(BaseModel):
    occurrence_date: date
    transactions: List[ReviewCandidateRow]


class ReviewEnvelope(BaseModel):
    allocation_name: str


class AutoPostReview(BaseModel):
    """GET /budget-entries/{id}/auto-post-review (STU-343 Plan B).

    ``envelope`` is the entry's allocation, for its creator only.
    ``entry_version`` (the stored ``updated_at``) and ``review_token`` are sent
    back unchanged with the POST. ``remaining_after`` is null for an
    open-ended entry.
    """
    entry_id: int
    name: str
    account_name: Optional[str] = None
    currency: CurrencyType
    amount: float
    reviewed: bool
    auto_post_enabled: bool
    block: Optional[AutoPostBlock] = None
    missed: List[ReviewMissedMonth]
    candidates: List[ReviewCandidates]
    remaining_after: Optional[int] = None
    envelope: Optional[ReviewEnvelope] = None
    past_cycles: bool
    entry_version: Optional[datetime] = None
    review_token: str


class ReviewLink(BaseModel):
    """Link one candidate to the missed month it stands for."""
    transaction_id: int
    occurrence_date: date


class AutoPostReviewRequest(BaseModel):
    """POST /budget-entries/{id}/auto-post-review. ``entry_version`` (null for
    an entry never updated) and ``review_token`` are the GET's, unchanged;
    both are required."""
    entry_version: Optional[datetime]
    review_token: str
    links: List[ReviewLink] = Field(default_factory=list)


class ReviewOutcome(BaseModel):
    occurrence_date: date
    outcome: Literal["created", "posted_pending", "already_posted"]


class AutoPostReviewResult(BaseModel):
    """The review's result; ``replayed`` when the same review had already been
    applied (nothing written, ``outcomes`` empty)."""
    replayed: bool
    reviewed: bool
    auto_post_enabled: bool
    next_occurrence: datetime
    max_occurrences: Optional[int] = None
    outcomes: List[ReviewOutcome]


class AutoPostToggle(BaseModel):
    """POST /budget-entries/{id}/auto-post: only ``false`` (turn off) is
    accepted; turning on is the review's."""
    enabled: bool
