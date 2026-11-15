"""The upcoming and payables lists for a test, as the routes build them (STU-306).

The single-currency upcoming and payables helpers the projection tests once called
are gone (STU-306); these read the same lists from the per-currency functions the
routes use (``upcoming_by_currency``, ``currency_upcoming_items``,
``payables_by_currency``), with the arguments those helpers took. Every item also
carries its ``currency``, its labels and its due fields, which a test reads or
leaves alone.
"""
from datetime import datetime
from typing import List, Optional

from app.core.context import RequestContext


def upcoming_rows(db, user_id: int, days: int = 30, reference: Optional[datetime] = None,
                  tag_id: Optional[int] = None) -> List[dict]:
    """``/forecast/upcoming``'s items for ``user_id`` over ``days`` from ``reference``."""
    from app.services.forecast import upcoming_by_currency

    return upcoming_by_currency(RequestContext(db, user_id), days=days, reference=reference,
                                tag_id=tag_id)["items"]


def event_rows(events: List[dict]) -> List[dict]:
    """``collect_events(detail=True)`` events (a Household view's, say) as upcoming items."""
    from app.services.forecast import currency_upcoming_items

    return currency_upcoming_items(events)


def payable_rows(db, user_id: int, days: int = 30, reference: Optional[datetime] = None,
                 tag_id: Optional[int] = None) -> List[dict]:
    """The payables (the dashboard snapshot's) for ``user_id`` over ``days`` from ``reference``."""
    from app.services.forecast import payables_by_currency

    return payables_by_currency(RequestContext(db, user_id), days=days, reference=reference,
                                tag_id=tag_id)
