"""A savings allocation's ``current_amount`` is calculated from its mode (STU-777).

``target_balance`` reads the linked account's balance, ``multi_account`` the
sum of the chosen accounts' balances, and ``transaction_total`` the owner's
posted Savings-category rows dated from the allocation's creation day
(transfers and debits add, credits subtract, never below 0). Each figure is
converted to the allocation's currency; one with no rate is left out and named
in ``current_amount_missing``. The list, one allocation, its progress and the
data export all carry the calculated figure; a sent one is ignored. Budgets and
goals are unchanged. One user never reads another's balances or rows, and the
list does not query per allocation.

Rates: the test store has PHP and USD (58.00 PHP per USD) and no EUR.
Skips without a database.
"""
import csv
import io
from datetime import datetime, timezone

import pytest
from sqlalchemy import event

from app.tests.conftest import API, sw_db_reachable, sw_post

pytestmark = pytest.mark.skipif(not sw_db_reachable(), reason="DATABASE_URL not reachable")

# 20:00 UTC on Jun 9 is 04:00 on Jun 10 in Manila: the allocation's creation day is Jun 10.
CREATED = datetime(2026, 6, 9, 20, 0, tzinfo=timezone.utc)


def _account(client, who, name, balance, currency="PHP", account_type="savings"):
    return sw_post(client, who, "/accounts/", {
        "name": name, "account_type": account_type, "balance": balance,
        "currency": currency})["id"]


def _category(client, who, name="Savings", kind="transfer"):
    return sw_post(client, who, "/categories/", {"name": name, "kind": kind})["id"]


def _row(client, who, account, kind, day, amount, category, posted=True, to=None):
    body = {"account_id": account, "transaction_type": kind, "amount": amount,
            "description": f"{kind} {amount}", "transaction_date": f"{day}T00:00:00",
            "is_posted": posted, "category_id": category}
    if kind == "transfer":
        body.update(transfer_from_account_id=account, transfer_to_account_id=to)
    return sw_post(client, who, "/transactions/", body)["id"]


def _allocation(client, who, configuration, account=None, kind="savings", **extra):
    body = {"name": "Fund", "allocation_type": kind, "target_amount": 50_000,
            "configuration": configuration, **extra}
    if account is not None:
        body["account_id"] = account
    return sw_post(client, who, "/allocations/", body)


def _get(client, who, path, expect=200, **params):
    r = client.get(f"{API}{path}", headers=who["headers"], params=params)
    assert r.status_code == expect, r.text
    return r.json()


def _created_at(db, allocation_id, when=CREATED):
    from app.models.allocation import Allocation

    db.query(Allocation).filter(Allocation.id == allocation_id).update(
        {"created_at": when}, synchronize_session=False)
    db.commit()


def _fields(body):
    return (body["current_amount"], body["current_amount_complete"],
            body["current_amount_missing"], body["current_amount_source"])


@pytest.fixture
def world(sw_client, sw_db, sw_people):
    client = sw_client
    me = sw_people()
    accounts = {
        "bpi": _account(client, me, "BPI Joint Savings", 10_000),
        "usd": _account(client, me, "Dollar Savings", 100, "USD"),
        "eur": _account(client, me, "Euro Savings", 50, "EUR"),
        "checking": _account(client, me, "Checking", 50_000, account_type="checking"),
    }
    return {"client": client, "db": sw_db, "me": me, "people": sw_people,
            "savings": _category(client, me), "other": _category(client, me, "Food", "expense"),
            **accounts}


# --- the three modes ------------------------------------------------------------------------

def test_target_balance_is_the_linked_accounts_balance_converted(world):
    client, me = world["client"], world["me"]
    php = _allocation(client, me, {"goal_mode": "target_balance"}, world["bpi"])
    assert _fields(php) == (10_000.0, True, [], "Balance of BPI Joint Savings")
    usd = _allocation(client, me, {"goal_mode": "target_balance"}, world["usd"], currency="PHP")
    assert _fields(usd) == (5_800.0, True, [], "Balance of Dollar Savings")


@pytest.mark.parametrize("configuration", [None, {}, {"goal_mode": None}])
def test_a_missing_goal_mode_is_target_balance(world, configuration):
    client, me = world["client"], world["me"]
    body = _allocation(client, me, configuration, world["bpi"])
    assert _fields(body) == (10_000.0, True, [], "Balance of BPI Joint Savings")


def test_multi_account_sums_the_chosen_balances_and_names_missing_rates(world):
    client, me = world["client"], world["me"]
    body = _allocation(client, me, {"goal_mode": "multi_account",
                                    "account_ids": [world["bpi"], world["usd"]]})
    assert _fields(body) == (15_800.0, True, [], "2 accounts combined")
    body = _allocation(client, me, {"goal_mode": "multi_account",
                                    "account_ids": [world["bpi"], world["usd"], world["eur"]]})
    # The euro balance has no rate: it is left out and named.
    assert _fields(body) == (15_800.0, False, ["EUR"], "3 accounts combined")


def test_transaction_total_counts_posted_savings_rows_since_creation(world):
    client, me, db = world["client"], world["me"], world["db"]
    savings, other = world["savings"], world["other"]
    body = _allocation(client, me, {"goal_mode": "transaction_total",
                                    "savings_category_id": savings})
    _created_at(db, body["id"])
    checking, bpi = world["checking"], world["bpi"]
    _row(client, me, checking, "transfer", "2026-06-10", 1_000, savings, to=bpi)  # + on the day
    _row(client, me, checking, "debit", "2026-06-12", 500, savings)               # +
    _row(client, me, checking, "credit", "2026-06-15", 300, savings)              # -
    _row(client, me, world["usd"], "debit", "2026-06-11", 10, savings)            # + 580 PHP
    _row(client, me, checking, "transfer", "2026-06-09", 2_000, savings, to=bpi)  # before creation
    _row(client, me, checking, "debit", "2026-06-11", 700, savings, posted=False)  # not posted
    _row(client, me, checking, "debit", "2026-06-11", 400, other)                 # not Savings

    got = _get(client, me, f"/allocations/{body['id']}")
    assert _fields(got) == (1_780.0, True, [], "Savings transactions since 2026-06-10")

    _row(client, me, world["eur"], "debit", "2026-06-11", 5, savings)  # no EUR rate
    got = _get(client, me, f"/allocations/{body['id']}")
    assert _fields(got) == (1_780.0, False, ["EUR"], "Savings transactions since 2026-06-10")


def test_transaction_total_never_goes_below_zero(world):
    client, me, db = world["client"], world["me"], world["db"]
    body = _allocation(client, me, {"goal_mode": "transaction_total",
                                    "savings_category_id": world["savings"]})
    _created_at(db, body["id"])
    _row(client, me, world["checking"], "credit", "2026-06-11", 900, world["savings"])
    assert _get(client, me, f"/allocations/{body['id']}")["current_amount"] == 0.0


# --- every reader, and a sent figure ignored -------------------------------------------------

def test_every_reader_returns_the_calculated_figure(world):
    client, me = world["client"], world["me"]
    body = _allocation(client, me, {"goal_mode": "target_balance"}, world["bpi"],
                       current_amount=123)
    aid = body["id"]
    assert body["current_amount"] == 10_000.0

    (listed,) = _get(client, me, "/allocations/")["items"]
    assert _fields(listed) == (10_000.0, True, [], "Balance of BPI Joint Savings")
    assert _fields(_get(client, me, f"/allocations/{aid}")) == _fields(listed)

    progress = _get(client, me, f"/allocations/{aid}/progress")
    assert float(progress["current_amount"]) == 10_000.0
    assert float(progress["remaining_amount"]) == 40_000.0
    assert progress["progress_percentage"] == 20.0
    assert progress["current_amount_source"] == "Balance of BPI Joint Savings"
    assert progress["current_amount_complete"] is True

    (exported,) = _get(client, me, "/data/export.json")["allocations"]
    assert exported["current_amount"] == "10000.00"
    r = client.get(f"{API}/data/export.csv", params={"table": "allocations"},
                   headers=me["headers"])
    (row,) = csv.DictReader(io.StringIO(r.text))
    assert row["current_amount"] == "10000.00"

    # A sent figure is ignored on update too, and the stored column stays 0.
    r = client.put(f"{API}/allocations/{aid}", json={"current_amount": 999},
                   headers=me["headers"])
    assert r.status_code == 200 and r.json()["current_amount"] == 10_000.0
    from app.models.allocation import Allocation
    world["db"].expire_all()
    assert world["db"].get(Allocation, aid).current_amount == 0


def test_budgets_and_goals_are_unchanged(world):
    client, me = world["client"], world["me"]
    goal = _allocation(client, me, {"goal_mode": "target_balance"}, world["bpi"], kind="goal",
                       current_amount=1_234)
    assert _fields(goal) == (1_234.0, True, [], None)
    assert _get(client, me, f"/allocations/{goal['id']}")["current_amount"] == 1_234.0
    progress = _get(client, me, f"/allocations/{goal['id']}/progress")
    assert float(progress["current_amount"]) == 1_234.0
    assert "current_amount_source" not in progress
    summary = _get(client, me, "/allocations/summary/goals")
    assert summary["total_current_amount"] == 1_234.0

    budget = _allocation(client, me, {"category_ids": [world["other"]]}, world["checking"],
                         kind="budget", current_amount=999, period_frequency="monthly",
                         period_start="2026-06-01T00:00:00")
    assert _fields(budget) == (0.0, True, [], None)


# --- isolation --------------------------------------------------------------------------------

def test_another_users_balances_and_rows_are_never_read(world):
    """A configuration naming another user's account or category (written around the
    API) contributes nothing, and another user's rows in my category never count."""
    from app.models.allocation import Allocation
    from app.models.transaction import Transaction, TransactionType

    client, me, db = world["client"], world["me"], world["db"]
    them = world["people"]("Other", "User")
    theirs = _account(client, them, "Their Vault", 77_777)
    their_savings = _category(client, them)
    _row(client, them, theirs, "debit", "2026-06-11", 4_000, their_savings)
    # Their row naming my Savings category, written directly.
    db.add(Transaction(user_id=them["id"], account_id=theirs, category_id=world["savings"],
                       amount=6_000, transaction_type=TransactionType.DEBIT, is_posted=True,
                       transaction_date=datetime(2026, 6, 11)))
    db.commit()

    single = _allocation(client, me, {"goal_mode": "target_balance"}, world["bpi"])
    multi = _allocation(client, me, {"goal_mode": "multi_account",
                                     "account_ids": [world["bpi"]]})
    total = _allocation(client, me, {"goal_mode": "transaction_total",
                                     "savings_category_id": world["savings"]})
    stolen = _allocation(client, me, {"goal_mode": "transaction_total",
                                      "savings_category_id": world["savings"]})
    db.query(Allocation).filter(Allocation.id == single["id"]).update(
        {"account_id": theirs}, synchronize_session=False)
    db.query(Allocation).filter(Allocation.id == multi["id"]).update(
        {"configuration": {"goal_mode": "multi_account", "account_ids": [theirs, world["bpi"]]}},
        synchronize_session=False)
    db.query(Allocation).filter(Allocation.id == stolen["id"]).update(
        {"configuration": {"goal_mode": "transaction_total",
                           "savings_category_id": their_savings}},
        synchronize_session=False)
    db.commit()
    _created_at(db, total["id"])
    _created_at(db, stolen["id"])

    by_id = {a["id"]: a for a in _get(client, me, "/allocations/", limit=100)["items"]}
    assert _fields(by_id[single["id"]]) == (0.0, True, [], "No linked account")
    assert _fields(by_id[multi["id"]]) == (10_000.0, True, [], "1 account combined")
    assert by_id[total["id"]]["current_amount"] == 0.0
    assert by_id[stolen["id"]]["current_amount"] == 0.0
    for aid in (single["id"], multi["id"], total["id"], stolen["id"]):
        assert "Their Vault" not in str(_get(client, me, f"/allocations/{aid}/progress"))
        _get(client, them, f"/allocations/{aid}", expect=404)
        _get(client, them, f"/allocations/{aid}/progress", expect=404)
    assert _get(client, them, "/allocations/")["items"] == []
    exported = {a["id"]: a for a in _get(client, me, "/data/export.json")["allocations"]}
    assert exported[single["id"]]["current_amount"] == "0"
    assert exported[stolen["id"]]["current_amount"] == "0"


# --- query count ------------------------------------------------------------------------------

def _statements(client, who, path, **params):
    seen = []

    def record(conn, cursor, statement, parameters, context, executemany):
        seen.append(statement)

    from app.core.database import engine

    event.listen(engine, "before_cursor_execute", record)
    try:
        r = client.get(f"{API}{path}", headers=who["headers"], params=params)
    finally:
        event.remove(engine, "before_cursor_execute", record)
    assert r.status_code == 200, r.text
    return r.json(), len(seen)


def _one_of_each(client, who, w):
    _allocation(client, who, {"goal_mode": "target_balance"}, w["bpi"])
    _allocation(client, who, {"goal_mode": "multi_account", "account_ids": [w["bpi"], w["usd"]]})
    _allocation(client, who, {"goal_mode": "transaction_total",
                              "savings_category_id": w["savings"]})


def test_the_list_does_not_query_per_allocation(world):
    client, me = world["client"], world["me"]
    _row(client, me, world["checking"], "debit", "2026-06-11", 100, world["savings"])
    _one_of_each(client, me, world)
    body, few = _statements(client, me, "/allocations/", limit=100)
    assert len(body["items"]) == 3
    for _ in range(3):
        _one_of_each(client, me, world)
    body, many = _statements(client, me, "/allocations/", limit=100)
    assert len(body["items"]) == 12
    assert many == few


# --- currency ---------------------------------------------------------------------------------

def test_an_explicit_currency_is_respected(world):
    client, me = world["client"], world["me"]
    body = _allocation(client, me, {"goal_mode": "target_balance"}, world["bpi"], currency="USD")
    # 10,000 PHP at 1/58 (0.017241).
    assert body["currency"] == "USD"
    assert _fields(body) == (172.41, True, [], "Balance of BPI Joint Savings")
    goal = _allocation(client, me, None, world["bpi"], kind="goal", currency="EUR")
    assert goal["currency"] == "EUR"


def test_the_default_currency_is_the_tracked_accounts(world):
    client, me = world["client"], world["me"]
    # A USD goal on a USD account: the raw balance, no conversion, nothing missing.
    usd = _allocation(client, me, {"goal_mode": "target_balance"}, world["usd"])
    assert usd["currency"] == "USD"
    assert _fields(usd) == (100.0, True, [], "Balance of Dollar Savings")
    # multi_account: the first aggregated account's currency.
    multi = _allocation(client, me, {"goal_mode": "multi_account",
                                     "account_ids": [world["usd"], world["bpi"]]})
    assert multi["currency"] == "USD"
    assert _fields(multi) == (272.41, True, [], "2 accounts combined")
    multi = _allocation(client, me, {"goal_mode": "multi_account",
                                     "account_ids": [world["bpi"], world["usd"]]})
    assert multi["currency"] == "PHP"


def test_the_default_currency_is_php_otherwise(world):
    client, me = world["client"], world["me"]
    total = _allocation(client, me, {"goal_mode": "transaction_total",
                                     "savings_category_id": world["savings"]})
    assert total["currency"] == "PHP"
    # An account sent with transaction_total is not tracked, so it sets no currency.
    total = _allocation(client, me, {"goal_mode": "transaction_total",
                                     "savings_category_id": world["savings"]}, world["usd"])
    assert total["currency"] == "PHP"
    goal = _allocation(client, me, None, world["usd"], kind="goal")
    assert goal["currency"] == "PHP"
    (exported,) = [a for a in _get(client, me, "/data/export.json")["allocations"]
                   if a["id"] == goal["id"]]
    assert exported["currency"] == "PHP"


def test_an_update_changes_the_currency_and_the_figure_follows(world):
    client, me = world["client"], world["me"]
    body = _allocation(client, me, {"goal_mode": "target_balance"}, world["usd"])
    aid = body["id"]
    r = client.put(f"{API}/allocations/{aid}", json={"currency": "PHP"}, headers=me["headers"])
    assert r.status_code == 200, r.text
    assert (r.json()["currency"], r.json()["current_amount"]) == ("PHP", 5_800.0)
    assert _get(client, me, f"/allocations/{aid}")["current_amount"] == 5_800.0
    assert float(_get(client, me, f"/allocations/{aid}/progress")["current_amount"]) == 5_800.0
    (exported,) = [a for a in _get(client, me, "/data/export.json")["allocations"]
                   if a["id"] == aid]
    assert (exported["currency"], exported["current_amount"]) == ("PHP", "5800.00")
    # A null currency changes nothing.
    r = client.put(f"{API}/allocations/{aid}", json={"currency": None}, headers=me["headers"])
    assert r.status_code == 200 and r.json()["currency"] == "PHP"


def test_a_budgets_total_ignores_its_currency(world):
    client, me = world["client"], world["me"]
    budget = {"category_ids": [world["other"]]}
    period = {"period_frequency": "monthly", "period_start": "2026-11-01T00:00:00"}
    php = _allocation(client, me, budget, world["checking"], kind="budget", **period)
    usd = _allocation(client, me, budget, world["checking"], kind="budget", currency="USD",
                      **period)
    assert (php["currency"], usd["currency"]) == ("PHP", "USD")
    _row(client, me, world["checking"], "debit", "2026-11-05", 500, world["other"])
    got = {a["id"]: a for a in _get(client, me, "/allocations/", limit=100)["items"]}
    assert _fields(got[php["id"]]) == (500.0, True, [], None)
    assert _fields(got[usd["id"]]) == (500.0, True, [], None)
