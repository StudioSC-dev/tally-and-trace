"""The day a month-family recurring entry falls on (STU-315).

Month-family cadences (monthly, quarterly, semi-annual, annual) step by whole
months. An entry with ``day_rule`` "last_weekday" lands on the month's last
Monday-Friday; one with an ``anchor_day`` lands on that day, clamped to the
month's length. Both step from the current (year, month), never from the
current day, so a clamped 28 February goes back to the 31st in March. An entry
with neither keeps the legacy step (``forecast._next_occurrence``), which
clamps from the current day and so sticks on a clamped one.

``canon`` is the date every rule is computed on: an aware value's UTC
components, a naive value as it is (naive means UTC components, which is how
it is stored and read back on the UTC session). ``resolve_day_fields`` decides
the two fields an API write persists; it raises ``DayRuleError`` for a request
it refuses.
"""

from calendar import monthrange
from datetime import MAXYEAR, date, datetime, timedelta, timezone
from typing import Mapping, Optional, Tuple

from app.models.transaction import RecurrenceFrequency

LAST_WEEKDAY = "last_weekday"
DAY_FIELDS = ("anchor_day", "day_rule")

MONTH_STEP = {
    RecurrenceFrequency.MONTHLY: 1,
    RecurrenceFrequency.QUARTERLY: 3,
    RecurrenceFrequency.SEMI_ANNUAL: 6,
    RecurrenceFrequency.ANNUAL: 12,
}
MONTH_FAMILY = frozenset(MONTH_STEP)


class DayRuleError(ValueError):
    """A write whose day fields are refused; the message is the API's detail."""


def canon(value: datetime) -> datetime:
    """The naive UTC components every day rule is computed on."""
    if value.tzinfo is not None:
        return value.astimezone(timezone.utc).replace(tzinfo=None)
    return value


def shift_month(year: int, month: int, months: int) -> Tuple[int, int]:
    """(year, month) ``months`` later; ``ValueError`` past the last year a date holds."""
    index = month - 1 + months
    year, month = year + index // 12, index % 12 + 1
    if year > MAXYEAR:
        raise ValueError("past the last year a date can hold")
    return year, month


def last_weekday(year: int, month: int) -> date:
    """The month's last Monday-Friday (a Saturday or Sunday month end moves to Friday)."""
    d = date(year, month, monthrange(year, month)[1])
    while d.weekday() >= 5:
        d -= timedelta(days=1)
    return d


def rule_date(entry, year: int, month: int) -> Optional[date]:
    """The entry's day in that month, or None for the legacy schedule."""
    if getattr(entry, "day_rule", None) == LAST_WEEKDAY:
        return last_weekday(year, month)
    anchor = getattr(entry, "anchor_day", None)
    if anchor:
        return date(year, month, min(anchor, monthrange(year, month)[1]))
    return None


def step_occurrence(entry, current: datetime) -> datetime:
    """The occurrence after ``current`` for a fixed-step cadence.

    Keeps ``current``'s time of day and tzinfo: materialize passes the aware
    value read from the ``timestamptz`` column and compares the result with
    ``end_date``. Semi-monthly entries are walked by their callers.
    """
    from app.services.forecast import _next_occurrence

    months = MONTH_STEP.get(entry.cadence)
    if months:
        year, month = shift_month(current.year, current.month, months)
        day = rule_date(entry, year, month)
        if day is not None:
            return current.replace(year=day.year, month=day.month, day=day.day)
    return _next_occurrence(current, entry.cadence)


def _expected_day(anchor: int, on: date) -> int:
    return min(anchor, monthrange(on.year, on.month)[1])


def resolve_day_fields(*, cadence, next_occurrence: datetime, sent: Mapping,
                       stored=None) -> dict:
    """``{"anchor_day", "day_rule"}`` for a create (``stored`` None) or an update.

    ``cadence`` and ``next_occurrence`` are the row as it will be (the request
    merged over ``stored``); ``sent`` holds the day fields the request named,
    null included. Rules, in order (plan section 2.4):

    0. The request decides between the two fields: both non-null is refused; a
       rule sent without an anchor clears the stored anchor, and an anchor sent
       without a rule clears the stored rule.
    1. Outside the month family both are cleared; naming either non-null is refused.
    3. A rule: no anchor, and ``next_occurrence`` must be its month's last weekday.
    4. An anchor sent non-null wins, and ``next_occurrence`` must be on it (clamped).
    5. An anchor sent as null (no rule): the legacy schedule.
    6. Neither: a create, an update entering the month family, or one clearing
       a stored rule takes the date's day. A legacy row (both stored null)
       stays legacy. An anchored row keeps its anchor while the date is on it
       (clamped) and is re-anchored to the date's day when it moves off it.
    """
    sent_anchor, anchor = "anchor_day" in sent, sent.get("anchor_day")
    sent_rule, rule = "day_rule" in sent, sent.get("day_rule")
    if anchor is not None and rule is not None:
        raise DayRuleError("Set anchor_day or day_rule, not both")
    stored_anchor = getattr(stored, "anchor_day", None)
    stored_rule = getattr(stored, "day_rule", None)
    merged_rule = rule if sent_rule else stored_rule
    if anchor is not None and not sent_rule:
        merged_rule = None

    if cadence not in MONTH_FAMILY:
        if anchor is not None or rule is not None:
            raise DayRuleError("anchor_day and day_rule apply only to monthly, quarterly, "
                               "semi-annual and annual entries")
        return {"anchor_day": None, "day_rule": None}

    on = canon(next_occurrence).date()
    if merged_rule == LAST_WEEKDAY:
        expected = last_weekday(on.year, on.month)
        if on != expected:
            raise DayRuleError("next_occurrence must be the last weekday of its month "
                               f"({expected.isoformat()})")
        return {"anchor_day": None, "day_rule": LAST_WEEKDAY}
    if anchor is not None:
        expected_day = _expected_day(anchor, on)
        if on.day != expected_day:
            expected = on.replace(day=expected_day)
            raise DayRuleError(f"next_occurrence must fall on day {anchor} of its month "
                               f"({expected.isoformat()})")
        return {"anchor_day": anchor, "day_rule": None}
    if sent_anchor:
        return {"anchor_day": None, "day_rule": None}

    derived = {"anchor_day": on.day, "day_rule": None}
    if stored is None or stored_rule is not None or stored.cadence not in MONTH_FAMILY:
        return derived
    if stored_anchor is None:
        return {"anchor_day": None, "day_rule": None}
    if canon(stored.next_occurrence) == canon(next_occurrence):
        return {"anchor_day": stored_anchor, "day_rule": None}
    if on.day == _expected_day(stored_anchor, on):
        return {"anchor_day": stored_anchor, "day_rule": None}
    return derived
