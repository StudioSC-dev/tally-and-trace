"""Disposable income leaves out recurring entries past their end date (STU-305).

An entry with ``end_mode`` "on_date" and an ``end_date`` before today has ended:
neither ``get_disposable_income`` (the scalar, as the wishlist reads it) nor
``disposable_by_currency`` (``/forecast/disposable``, the dashboard) counts it,
even while it is still active. One ending today, one ending later and one with
no end date still count; an inactive one stays left out. Written through the ORM
on a throwaway user with one PHP account, today being ``TODAY``.
"""
from datetime import date, datetime
from decimal import Decimal

import pytest

from app.core.context import RequestContext
from app.tests.conftest import sw_db_reachable

pytestmark = pytest.mark.skipif(not sw_db_reachable(), reason="no database available")

TODAY = date(2026, 11, 2)
AMOUNT = {"income": 300.0, "expense": 200.0}
FIGURE = {"income": "monthly_income", "expense": "monthly_expenses"}


@pytest.fixture
def me(sw_people, sw_db):
    """A PHP user with a PHP checking account: ``(user id, account id)``."""
    from app.models.account import Account, AccountType
    from app.models.user import CurrencyType, User

    who = sw_people("End", "Date")
    sw_db.get(User, who["id"]).default_currency = CurrencyType.PHP
    account = Account(user_id=who["id"], name="Checking", account_type=AccountType.CHECKING,
                      currency=CurrencyType.PHP, balance=Decimal("1000.00"))
    sw_db.add(account)
    sw_db.commit()
    return who["id"], account.id


def _entry(db, me, kind, **kw):
    from app.models.budget_entry import BudgetEntry, BudgetEntryType
    from app.models.transaction import RecurrenceFrequency
    from app.models.user import CurrencyType

    uid, account = me
    db.add(BudgetEntry(user_id=uid, name=f"Monthly {kind}", entry_type=BudgetEntryType(kind),
                       amount=Decimal(str(AMOUNT[kind])), currency=CurrencyType.PHP,
                       cadence=RecurrenceFrequency.MONTHLY,
                       next_occurrence=datetime(2026, 11, 20, 8), account_id=account, **kw))
    db.commit()


def _scalar(db, uid):
    from app.services.forecast import get_disposable_income

    return get_disposable_income(db, uid, today=TODAY)


def _by_currency(db, uid):
    from app.services.forecast import disposable_by_currency

    body = disposable_by_currency(RequestContext(db, uid, today=TODAY))
    (php,) = [r for r in body["by_currency"] if r["currency"] == "PHP"] or [None]
    # The scalars are the default currency's row (PHP).
    assert php is None or {k: body[k] for k in ("monthly_income", "monthly_expenses",
                                                "monthly_disposable")} == {
        k: php[k] for k in ("monthly_income", "monthly_expenses", "monthly_disposable")}
    return body


FUNCTIONS = {"scalar": _scalar, "by_currency": _by_currency}


def _counted(body, kind) -> float:
    """The entry's own figure; the other one stays 0 (only one entry exists)."""
    other = FIGURE["expense" if kind == "income" else "income"]
    assert body[other] == 0.0
    sign = 1 if kind == "income" else -1
    assert body["monthly_disposable"] == sign * body[FIGURE[kind]]
    return body[FIGURE[kind]]


KINDS = pytest.mark.parametrize("kind", ["income", "expense"])
BOTH = pytest.mark.parametrize("fn", ["scalar", "by_currency"])


@KINDS
def test_ended_entry_excluded_scalar(sw_db, me, kind):
    """AC1: ended the minute before today began, still active: not counted."""
    _entry(sw_db, me, kind, end_mode="on_date", end_date=datetime(2026, 11, 1, 23, 59))
    assert _counted(_scalar(sw_db, me[0]), kind) == 0.0


@KINDS
def test_ended_entry_excluded_by_currency(sw_db, me, kind):
    """AC2: the same entry is in no ``by_currency`` row and no scalar."""
    _entry(sw_db, me, kind, end_mode="on_date", end_date=datetime(2026, 11, 1, 23, 59))
    body = _by_currency(sw_db, me[0])
    assert _counted(body, kind) == 0.0
    assert all(r[FIGURE[kind]] == 0.0 for r in body["by_currency"])


@BOTH
@KINDS
@pytest.mark.parametrize("ends", [datetime(2026, 11, 2, 0, 0), datetime(2026, 11, 2, 8, 0)],
                         ids=["midnight", "morning"])
def test_entry_ending_today_counted(sw_db, me, kind, fn, ends):
    """AC3: an end date on today itself, at any time of day, still counts."""
    _entry(sw_db, me, kind, end_mode="on_date", end_date=ends)
    assert _counted(FUNCTIONS[fn](sw_db, me[0]), kind) == AMOUNT[kind]


@BOTH
@KINDS
def test_entry_ending_later_counted(sw_db, me, kind, fn):
    """AC3: an end date after today counts."""
    _entry(sw_db, me, kind, end_mode="on_date", end_date=datetime(2027, 3, 20, 8))
    assert _counted(FUNCTIONS[fn](sw_db, me[0]), kind) == AMOUNT[kind]


@BOTH
@KINDS
@pytest.mark.parametrize("end", [
    {"end_mode": "indefinite"},
    {"end_mode": "on_date", "end_date": None},
    {"end_mode": "after_occurrences", "max_occurrences": 3},
], ids=["indefinite", "on_date_without_date", "after_occurrences"])
def test_entry_without_end_date_unchanged(sw_db, me, kind, fn, end):
    """AC3: no end date (or another end mode) counts as before."""
    _entry(sw_db, me, kind, **end)
    assert _counted(FUNCTIONS[fn](sw_db, me[0]), kind) == AMOUNT[kind]


@BOTH
@KINDS
@pytest.mark.parametrize("end", [
    {"end_mode": "indefinite"},
    {"end_mode": "on_date", "end_date": datetime(2027, 3, 20, 8)},
    {"end_mode": "on_date", "end_date": datetime(2026, 3, 5, 8)},
], ids=["indefinite", "ending_later", "ended"])
def test_inactive_entry_remains_excluded(sw_db, me, kind, fn, end):
    """AC3: an inactive entry is left out whatever its end date."""
    _entry(sw_db, me, kind, is_active=False, **end)
    assert _counted(FUNCTIONS[fn](sw_db, me[0]), kind) == 0.0
