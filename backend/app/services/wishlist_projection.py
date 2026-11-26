"""A wishlist item's rate and projection status, from free flow (STU-789).

The rules are section 3 of ``.claude/plans/wishlist-net-flow-plan.md``. Every
wishlist surface (``GET /wishlist/plan``, ``/wishlist/{id}/outlook``,
``/wishlist/{id}/readiness`` and ``wishlist_next_up`` in ``/dashboard/snapshot``)
reads an item's rate and status from ``project`` here, so a full-payment item has
the same rate and status on all four.

**Rate by priority**, from the item's currency row of ``free_flow.compute``, and
only when that row is ``ok``: a critical item (an urgent need, before saving) uses
``max(net_flow, 0)``; a want (high, medium, low: after saving) uses ``free_flow``.

**Projection status**, for the item on its own, first match:

``paid_from_savings``  its pay-from account is one of the caller's own Savings
                       accounts (an account the caller does not own is not read)
``not_estimated``      the caller has no full month of history
``incomplete``         the caller is cross-currency
``no_projection``      no row for the currency, or the row is ``no_projection``
``no_room``            the rate is 0
``beyond_horizon``     ``ceil(cost / rate)`` is over 60
``dated``              otherwise

Only a ``dated`` item has a date (``now + months * 30 days``). There is no rate
floor. Nothing about another user's account, goal or item is read.
"""
from dataclasses import dataclass
from datetime import timedelta
from decimal import ROUND_CEILING, Decimal
from typing import Optional, Set

from app.core.access import OWNER_ROLES
from app.core.time import utc_now
from app.models.account import Account, AccountType
from app.models.wishlist_item import WishlistPriority
from app.services import free_flow

ZERO = Decimal("0")
HORIZON_MONTHS = 60

PAID_FROM_SAVINGS = "paid_from_savings"
NOT_ESTIMATED = "not_estimated"
INCOMPLETE = "incomplete"
NO_PROJECTION = "no_projection"
NO_ROOM = "no_room"
BEYOND_HORIZON = "beyond_horizon"
DATED = "dated"

NET_FLOW, FREE_FLOW = "net_flow", "free_flow"

PAID_FROM_SAVINGS_NOTE = "Paid from a savings account, so it is not estimated"
NOT_ESTIMATED_NOTE = "Needs one full month of history"
NO_ROOM_WANT_NOTE = "Nothing is left after your savings goals"
NO_ROOM_CRITICAL_NOTE = "Your net flow does not cover this"
BEYOND_HORIZON_NOTE = "More than 5 years away"


def no_projection_note(currency: str) -> str:
    """What an item in a currency with no projection says (STU-304)."""
    return f"No projected income or expenses in {currency}, so this can't be judged yet."


@dataclass
class Projection:
    """One item on its own. ``rate`` is None when there is none (the row is not
    ``ok``, or the item is paid from savings); ``months`` is ``ceil(cost / rate)``
    when the rate is above 0; ``row`` is the item's currency row when it is ``ok``."""
    status: str
    note: Optional[str]
    basis: str
    rate: Optional[Decimal] = None
    months: Optional[int] = None
    row: Optional[free_flow.FreeFlowRow] = None

    @property
    def dated(self) -> bool:
        return self.status == DATED

    @property
    def date(self) -> Optional[str]:
        """The item's own date, set only when it is ``dated``."""
        return due_date(self.months) if self.dated else None


def _code(value) -> str:
    return getattr(value, "value", value)


def due_date(months: int) -> str:
    """The existing arithmetic: ``now + months * 30 days``."""
    return (utc_now() + timedelta(days=months * 30)).date().isoformat()


def months_for(cost: Decimal, rate: Decimal) -> int:
    """``ceil(cost / rate)`` for a rate above 0."""
    return int((cost / rate).to_integral_value(rounding=ROUND_CEILING))


def is_critical(item) -> bool:
    return _code(item.priority) == WishlistPriority.CRITICAL.value


def basis_of(item) -> str:
    return NET_FLOW if is_critical(item) else FREE_FLOW


def own_savings_ids(ctx) -> Set[int]:
    """The caller's own Savings accounts (``OWNER_ROLES``), read once per request."""
    def load() -> Set[int]:
        own = ctx.viewable_ids(roles=OWNER_ROLES)
        if not own:
            return set()
        return {i for (i,) in ctx.db.query(Account.id).filter(
            Account.id.in_(own), Account.account_type == AccountType.SAVINGS)}
    return ctx.memo(("wishlist_own_savings", ctx.uid), load)


def is_paid_from_savings(ctx, item) -> bool:
    """The item's pay-from account is one of the caller's own Savings accounts. An
    account the caller does not own is only compared by id, never read."""
    if item.account_id is None or item.account_id not in ctx.viewable_ids(roles=OWNER_ROLES):
        return False
    return item.account_id in own_savings_ids(ctx)


def rate_of(item, row: free_flow.FreeFlowRow) -> Decimal:
    """The item's rate from its ``ok`` currency row (rate by priority)."""
    if is_critical(item):
        return max(row.net_flow, ZERO)
    return row.free_flow


def project(ctx, item, cost: Decimal) -> Projection:
    """The item's projection on its own (module docstring). ``cost`` is the
    amount it is dated by: its price as money."""
    basis = basis_of(item)
    if is_paid_from_savings(ctx, item):
        return Projection(PAID_FROM_SAVINGS, PAID_FROM_SAVINGS_NOTE, basis)
    flow = free_flow.compute(ctx)
    if flow.status == free_flow.NOT_ESTIMATED:
        return Projection(NOT_ESTIMATED, NOT_ESTIMATED_NOTE, basis)
    if flow.status == free_flow.INCOMPLETE:
        return Projection(INCOMPLETE, free_flow.INCOMPLETE_NOTE, basis)
    code = _code(item.currency)
    row = flow.row(code)
    if row is None or row.status != free_flow.OK:
        return Projection(NO_PROJECTION, no_projection_note(code), basis)
    rate = rate_of(item, row)
    if rate <= ZERO:
        note = NO_ROOM_CRITICAL_NOTE if is_critical(item) else NO_ROOM_WANT_NOTE
        return Projection(NO_ROOM, note, basis, rate=ZERO, row=row)
    months = months_for(cost, rate)
    if months > HORIZON_MONTHS:
        return Projection(BEYOND_HORIZON, BEYOND_HORIZON_NOTE, basis, rate=rate,
                          months=months, row=row)
    return Projection(DATED, None, basis, rate=rate, months=months, row=row)
