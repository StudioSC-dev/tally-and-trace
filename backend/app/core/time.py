"""UTC time helpers.

``datetime.utcnow()`` is deprecated from Python 3.12 and was always a footgun: it
returns a *naive* datetime that happens to hold UTC. That silently compares wrong
against local-naive datetimes and raises ``TypeError`` against aware ones.

Replacing it is not a blanket find-and-replace, because this schema has two
datetime families and they need different answers:

``utc_now()`` -> **aware**. For ``TIMESTAMP WITH TIME ZONE`` columns:
    every ``created_at`` / ``updated_at``, ``email_tokens.expires_at``,
    ``users.last_login``, ``wishlist_items.target_date`` / ``purchased_at``,
    ``entity_memberships.joined_at``. Also correct for JWT ``exp`` claims.

``naive_utc_now()`` -> **naive UTC**. For ``TIMESTAMP WITHOUT TIME ZONE`` columns
    and anything compared against them:
    ``transactions.transaction_date`` / ``posting_date``,
    ``budget_entries.next_occurrence`` / ``end_date``,
    ``allocations.period_start`` / ``period_end`` / ``target_date``,
    ``refresh_tokens.expires_at`` / ``revoked_at``.

Pick by the column you are touching. Feeding an aware value into a naive column
(or comparing across the two in Python) is the exact failure this module exists
to prevent -- see the forecast engine's ``_naive()`` normaliser, which exists for
the same reason.

Unifying the schema onto ``timestamptz`` would remove the split, but that is a
data migration with its own semantics to reason about and is deliberately NOT
bundled with this sweep.
"""

from datetime import datetime, timezone


def utc_now() -> datetime:
    """Current UTC time, timezone-aware. Use with ``TIMESTAMP WITH TIME ZONE``."""
    return datetime.now(timezone.utc)


def naive_utc_now() -> datetime:
    """Current UTC time as a naive datetime.

    Behaviourally identical to the deprecated ``datetime.utcnow()``, minus the
    deprecation. Use with ``TIMESTAMP WITHOUT TIME ZONE`` columns.
    """
    return datetime.now(timezone.utc).replace(tzinfo=None)
