"""Response models of the dashboard routes (routers/dashboard.py)."""
from typing import Any, Dict, List

from pydantic import BaseModel

from app.schemas.budget_entry import UpcomingOccurrences
from app.schemas.transaction import TransactionOut

# A row of a list ``/dashboard/due`` shares with ``/dashboard/snapshot``: built by
# the same services, in the same shape, and documented where they are built
# (services/forecast.py, card_charges.py, card_credit.py, missed.py). Passed through
# as the snapshot passes them.
SnapshotRow = Dict[str, Any]


class UnpostedPage(BaseModel):
    """One page of the caller's unposted transactions dated on or before the Manila
    day, as ``GET /transactions`` shows each row, newest first (date, then id).
    Only rows the caller sees ``full`` or ``shared_full``: a limited row has no
    actions on the Due card. ``total`` counts every page; ``page`` is 1-based."""
    items: List[TransactionOut]
    total: int
    page: int
    page_size: int
    has_more: bool


class DashboardDue(BaseModel):
    """``GET /dashboard/due``: what the Transactions page's Due card renders.

    The first nine lists are ``/dashboard/snapshot``'s own, built by the same code
    from the same request context (``routers/dashboard._due_lists``), with
    ``today`` the Manila day they were computed for.

    ``linked_pending``: the unposted rows a missed row links
    (``pending_transaction_ids`` of ``missed`` and of each card's ``missed``), as
    ``GET /transactions?ids=...&is_posted=false`` returns them.

    ``upcoming_occurrences`` and ``subscription_occurrences``: as
    ``GET /budget-entries/upcoming-occurrences`` returns them for the days after
    the Manila day through 30 days ahead, with ``plan=none`` and
    ``plan=subscription``, limit 500.

    ``unposted``: the unposted rows dated on or before the Manila day, 200 a page
    (``?unposted_page=``). Later unposted rows are the upcoming-transactions
    request's.
    """
    today: str
    payables: List[SnapshotRow]
    upcoming_this_month: List[SnapshotRow]
    card_charges: List[SnapshotRow]
    missed: List[SnapshotRow]
    card_statements_due: List[SnapshotRow]
    installment_review: List[SnapshotRow]
    installment_auto_post: List[SnapshotRow]
    autopay_due: List[SnapshotRow]
    auto_post_scheduled: bool
    linked_pending: List[TransactionOut]
    upcoming_occurrences: UpcomingOccurrences
    subscription_occurrences: UpcomingOccurrences
    unposted: UnpostedPage
