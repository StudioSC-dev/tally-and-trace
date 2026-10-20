"""Recording a card occurrence as Charged (STU-384, Ruling 3, backend ``is_posted``).

``POST /budget-entries/{id}/materialize`` with ``is_posted`` False records a card
expense's occurrence as one pending debit linked to it and advances the
schedule; the card balance moves only when that row is posted on the
Transactions page (``PUT /transactions/{id}``). Any other entry is a 400, and an
occurrence already linked is a 409. Skips without a database.
"""
import os
import sys
from datetime import datetime
from decimal import Decimal

import pytest
from sqlalchemy import create_engine, text

from app.tests.conftest import API, sw_db_reachable, sw_post, sw_share

pytestmark = pytest.mark.skipif(not sw_db_reachable(), reason="DATABASE_URL not reachable")

# Sunday 2026-10-18, 02:00 UTC: 10:00 in Manila.
REF = datetime(2026, 10, 18, 2, 0)
CHARGED = {"is_posted": False}


def pin_clock(monkeypatch, when: datetime) -> None:
    """Freeze ``naive_utc_now`` in every loaded app module (Manila's today included)."""
    for name, module in list(sys.modules.items()):
        if name.startswith("app.") and hasattr(module, "naive_utc_now"):
            monkeypatch.setattr(module, "naive_utc_now", lambda: when)


@pytest.fixture
def engine():
    e = create_engine(os.environ["DATABASE_URL"])
    yield e
    e.dispose()


def _account(client, who, name="Checking", account_type="checking", balance=50_000, **extra):
    return sw_post(client, who, "/accounts/", {
        "name": name, "account_type": account_type, "balance": balance, **extra})["id"]


def _card(client, who, checking, name="Card C"):
    return _account(client, who, name, "credit", 0, billing_cycle_start=24,
                    days_until_due_date=21, payment_account_id=checking)


def _entry(client, who, account_id, next_day, amount, name, **extra):
    return sw_post(client, who, "/budget-entries/", {
        "name": name, "entry_type": "expense", "amount": amount, "cadence": "monthly",
        "next_occurrence": f"{next_day}T00:00:00", "account_id": account_id, **extra})["id"]


def _row(client, who, account_id, entry_id, day, amount, posted=False):
    return sw_post(client, who, "/transactions/", {
        "account_id": account_id, "transaction_type": "debit", "amount": amount,
        "description": "Linked", "transaction_date": f"{day}T00:00:00",
        "is_posted": posted, "budget_entry_id": entry_id})["id"]


def _materialize(client, who, entry_id, body=None):
    return client.post(f"{API}/budget-entries/{entry_id}/materialize", json=body or {},
                       headers=who["headers"])


def _balance(client, who, account_id) -> Decimal:
    r = client.get(f"{API}/accounts/{account_id}", headers=who["headers"])
    assert r.status_code == 200, r.text
    return Decimal(str(r.json()["balance"]))


def _state(client, who, entry_id) -> dict:
    r = client.get(f"{API}/budget-entries/{entry_id}", headers=who["headers"])
    assert r.status_code == 200, r.text
    return r.json()


def _linked(engine, entry_id) -> list:
    """``(id, is_posted, occurrence day)`` of every row linked to the entry."""
    with engine.connect() as c:
        return [(r[0], r[1], r[2].date().isoformat() if r[2] else None) for r in c.execute(text(
            "SELECT id, is_posted, occurrence_date FROM transactions "
            "WHERE budget_entry_id = :e ORDER BY id"), {"e": entry_id})]


def _snapshot_card(client, who, card):
    r = client.get(f"{API}/dashboard/snapshot", headers=who["headers"])
    assert r.status_code == 200, r.text
    return next(c for c in r.json()["card_charges"] if c["account_id"] == card)


def _charge_for(section, txn_id):
    return next(c for c in section["charges"]
                if c.get("source") == "transaction" and c.get("source_id") == txn_id)


def _post(client, who, txn_id):
    r = client.put(f"{API}/transactions/{txn_id}", json={"is_posted": True},
                   headers=who["headers"])
    assert r.status_code == 200, r.text
    return r.json()


@pytest.fixture
def world(sw_client, sw_people):
    client, me = sw_client, sw_people()
    checking = _account(client, me)
    card = _card(client, me, checking)
    return {"client": client, "me": me, "checking": checking, "card": card}


def test_charged_creates_one_pending_linked_row_and_advances(world, engine, monkeypatch):
    client, me, card = world["client"], world["me"], world["card"]
    netflix = _entry(client, me, card, "2026-10-20", 549, "Netflix")
    pin_clock(monkeypatch, REF)
    before = _balance(client, me, card)

    r = _materialize(client, me, netflix, CHARGED)

    assert r.status_code == 201, r.text
    assert r.headers["X-Occurrence-Outcome"] == "created"
    assert r.headers["X-Occurrence-Recorded"] == "2026-10-20"
    txn = r.json()
    assert txn["is_posted"] is False
    assert _linked(engine, netflix) == [(txn["id"], False, "2026-10-20")]
    assert _balance(client, me, card) == before
    assert _state(client, me, netflix)["next_occurrence"][:10] == "2026-11-20"

    r = client.get(f"{API}/budget-entries/{netflix}/occurrences", headers=me["headers"])
    assert r.status_code == 200, r.text
    assert "2026-10-20" not in {o["occurrence_date"] for o in r.json()["occurrences"]}

    section = _snapshot_card(client, me, card)
    charge = _charge_for(section, txn["id"])
    assert (charge["kind"], charge["recurring"], charge["date"]) == (
        "pending", True, "2026-10-20")
    assert section["missed"] == []

    # Posting it on the Transactions page: still one row, now posted, balance moved.
    assert _post(client, me, txn["id"])["is_posted"] is True
    assert _linked(engine, netflix) == [(txn["id"], True, "2026-10-20")]
    assert abs(_balance(client, me, card) - before) == Decimal("549.00")

    # The day is off the schedule now: a later Mark paid for it is refused.
    r = _materialize(client, me, netflix, {"occurrence_date": "2026-10-20T00:00:00"})
    assert r.status_code == 422, r.text
    assert len(_linked(engine, netflix)) == 1


def test_charged_on_a_missed_month_lowers_the_missed_count(world, engine, monkeypatch):
    client, me, card = world["client"], world["me"], world["card"]
    spotify = _entry(client, me, card, "2026-09-10", 279, "Spotify")
    pin_clock(monkeypatch, REF)
    assert [(m["entry_id"], m["count"]) for m in _snapshot_card(client, me, card)["missed"]] == [
        (spotify, 2)]

    r = _materialize(client, me, spotify, CHARGED)

    assert r.status_code == 201, r.text
    section = _snapshot_card(client, me, card)
    assert [(m["entry_id"], m["count"], m["oldest"]) for m in section["missed"]] == [
        (spotify, 1, "2026-10-10")]
    charge = _charge_for(section, r.json()["id"])
    assert (charge["kind"], charge["recurring"], charge["overdue"]) == ("pending", True, True)


def test_a_shared_editor_charges_and_posts_the_owners_card_entry(sw_client, sw_db, sw_people,
                                                                 engine, monkeypatch):
    client = sw_client
    a, b = sw_people("Alice", "Owner"), sw_people("Bea", "Partner")
    card = _card(client, a, _account(client, a))
    sw_share(sw_db, card, b["id"], "editor", a["id"])
    netflix = _entry(client, a, card, "2026-10-20", 549, "Netflix")
    pin_clock(monkeypatch, REF)

    r = _materialize(client, b, netflix, CHARGED)
    assert r.status_code == 201, r.text
    txn_id = r.json()["id"]

    assert _charge_for(_snapshot_card(client, b, card), txn_id)["recurring"] is True
    r = client.get(f"{API}/transactions/", params={"is_posted": "false", "limit": 100},
                   headers=b["headers"])
    assert r.status_code == 200, r.text
    [row] = [t for t in r.json()["items"] if t["id"] == txn_id]
    assert row["view"] == "shared_full"
    assert "budget_entry_id" not in row

    _post(client, b, txn_id)
    assert _linked(engine, netflix) == [(txn_id, True, "2026-10-20")]


def test_the_card_owner_posts_a_charge_they_cannot_edit(sw_client, sw_db, sw_people, engine,
                                                        monkeypatch):
    """The account owner exemption: B's charged row on A's card, B since demoted."""
    from app.models.account_share import AccountShare

    client, db = sw_client, sw_db
    a, b = sw_people("Alice", "Owner"), sw_people("Bea", "Partner")
    card = _card(client, a, _account(client, a))
    share = sw_share(db, card, b["id"], "editor", a["id"])
    gym = _entry(client, b, card, "2026-10-20", 1_500, "Gym")
    pin_clock(monkeypatch, REF)
    r = _materialize(client, b, gym, CHARGED)
    assert r.status_code == 201, r.text
    txn_id = r.json()["id"]
    db.query(AccountShare).filter(AccountShare.id == share).update({"role": "viewer"})
    db.commit()

    r = client.get(f"{API}/transactions/", params={"is_posted": "false", "limit": 100},
                   headers=a["headers"])
    assert r.status_code == 200, r.text
    [row] = [t for t in r.json()["items"] if t["id"] == txn_id]
    assert row["view"] == "shared_full"
    assert (row["permissions"]["can_post"], row["permissions"]["can_edit"]) == (True, False)
    assert _charge_for(_snapshot_card(client, a, card), txn_id)["recurring"] is True

    _post(client, a, txn_id)
    assert _linked(engine, gym) == [(txn_id, True, "2026-10-20")]


def test_charged_refusals(world, engine, monkeypatch):
    client, me, checking, card = (world["client"], world["me"], world["checking"],
                                  world["card"])
    savings = _account(client, me, "Savings", balance=0)
    pending_linked = _entry(client, me, card, "2026-10-20", 549, "Netflix")
    _row(client, me, card, pending_linked, "2026-10-20", 549)
    posted_linked = _entry(client, me, card, "2026-10-20", 279, "Spotify")
    _row(client, me, card, posted_linked, "2026-10-20", 279, posted=True)
    rent = _entry(client, me, checking, "2026-10-20", 20_000, "Rent")
    salary = sw_post(client, me, "/budget-entries/", {
        "name": "Salary", "entry_type": "income", "amount": 50_000, "cadence": "monthly",
        "next_occurrence": "2026-10-20T00:00:00", "account_id": checking})["id"]
    save = sw_post(client, me, "/budget-entries/", {
        "name": "Save", "entry_type": "expense", "amount": 5_000, "cadence": "monthly",
        "next_occurrence": "2026-10-20T00:00:00", "account_id": checking,
        "transfer_to_account_id": savings})["id"]
    paused = _entry(client, me, card, "2026-10-20", 999, "Paused", is_active=False)
    pin_clock(monkeypatch, REF)
    counts = {e: len(_linked(engine, e)) for e in (pending_linked, posted_linked, rent,
                                                   salary, save, paused)}

    r = _materialize(client, me, pending_linked, CHARGED)
    assert r.status_code == 409, r.text
    assert r.json()["detail"] == ("This occurrence is already charged; "
                                  "post it on the Transactions page")
    r = _materialize(client, me, posted_linked, CHARGED)
    assert r.status_code == 409, r.text
    assert r.json()["detail"] == "This occurrence is already recorded"
    for entry in (rent, salary, save):
        r = _materialize(client, me, entry, CHARGED)
        assert r.status_code == 400, r.text
        assert r.json()["detail"] == "Only a card expense can be recorded as charged"
    r = _materialize(client, me, paused, CHARGED)
    assert r.status_code == 409, r.text
    assert r.json()["detail"] == "This entry is paused"

    assert {e: len(_linked(engine, e)) for e in counts} == counts
    for entry in (pending_linked, posted_linked, rent, salary, save):
        assert _state(client, me, entry)["next_occurrence"][:10] == "2026-10-20"


def test_charged_uses_up_one_installment_month(world, engine, monkeypatch):
    client, me, card = world["client"], world["me"], world["card"]
    iphone = _entry(client, me, card, "2026-10-20", 5_000, "iPhone",
                    end_mode="after_occurrences", max_occurrences=12)
    pin_clock(monkeypatch, REF)

    r = _materialize(client, me, iphone, {"is_posted": False, "advance": False})
    assert r.status_code == 400, r.text
    assert _linked(engine, iphone) == []

    r = _materialize(client, me, iphone, CHARGED)
    assert r.status_code == 201, r.text
    state = _state(client, me, iphone)
    assert (state["max_occurrences"], state["next_occurrence"][:10]) == (11, "2026-11-20")
    assert _linked(engine, iphone) == [(r.json()["id"], False, "2026-10-20")]


def test_omitting_is_posted_posts_as_before(world, engine, monkeypatch):
    client, me, card = world["client"], world["me"], world["card"]
    netflix = _entry(client, me, card, "2026-10-20", 549, "Netflix")
    pin_clock(monkeypatch, REF)
    before = _balance(client, me, card)

    r = _materialize(client, me, netflix)

    assert r.status_code == 201, r.text
    assert r.json()["is_posted"] is True
    assert _linked(engine, netflix) == [(r.json()["id"], True, "2026-10-20")]
    assert abs(_balance(client, me, card) - before) == Decimal("549.00")
