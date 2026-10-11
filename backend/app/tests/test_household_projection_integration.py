"""Household tag shares: the projection (STU-233, plan §3).

C (holding A's Household tag share) projects A's Household-tagged accounts
with A's records on them, never another user's; A's explicitly
Household-tagged records outside that scope are Household occurrences:
listed, ``cash_delta`` 0, de-duplicated against in-scope card payments.
At a fixed reference date, through the forecast service.
"""
from datetime import datetime
from decimal import Decimal

import pytest

from app.tests.conftest import API, PRIVATE, sw_db_reachable, sw_leaks, sw_post

pytestmark = pytest.mark.skipif(not sw_db_reachable(), reason="DATABASE_URL not reachable")

REF = datetime(2026, 10, 10)
LIMITED_EVENT_KEYS = {"view", "public_id", "date", "original_date", "overdue", "display_name",
                      "face_amount", "cash_delta", "currency", "account", "kind"}


def _txn(client, who, account, amount, when, kind="debit", posted=False, tags=(), **extra):
    body = {"account_id": account, "amount": amount, "transaction_type": kind,
            "transaction_date": when, "is_posted": posted, "description": "Plain",
            "tag_ids": list(tags), **extra}
    return sw_post(client, who, "/transactions/", body)["id"]


def _transfer(client, who, frm, to, amount, when, posted=False, **extra):
    return _txn(client, who, frm, amount, when, kind="transfer", posted=posted,
                transfer_from_account_id=frm, transfer_to_account_id=to, **extra)


def _put(client, who, path, body):
    r = client.put(f"{API}{path}", json=body, headers=who["headers"])
    assert r.status_code == 200, r.text


def _upcoming(db, who, days=60):
    from app.services.forecast import get_upcoming_items

    db.expire_all()
    return get_upcoming_items(db, who["id"], days=days, reference=REF)


def _household(items):
    return [i for i in items if i.get("kind") == "household"]


def test_household_occurrences_on_a_private_card_wallet_and_accountless_entry(hh, sw_client,
                                                                              sw_db):
    from app.services.forecast import get_payables, project_running_balance

    a, c = hh["a"], hh["c"]
    _txn(sw_client, a, hh["a_card"], 100, "2026-10-12T00:00:00", tags=[hh["hh_a"]],
         description="Household internet")
    _txn(sw_client, a, hh["a_wallet"], 30, "2026-10-14T00:00:00", tags=[hh["hh_a"]],
         description="Household snacks")
    sw_post(sw_client, a, "/budget-entries/", {
        "name": "Household water", "entry_type": "expense", "amount": 45,
        "next_occurrence": "2026-10-20T00:00:00", "tag_ids": [hh["hh_a"]]})
    _txn(sw_client, a, hh["a_card"], 77, "2026-10-13T00:00:00", description=f"{PRIVATE} gift")
    before = project_running_balance(sw_db, c["id"], days=60, reference=REF)

    items = _household(_upcoming(sw_db, c))
    assert [(i["date"], i["display_name"], i["face_amount"], i["cash_delta"], i["account"])
            for i in items] == [
        ("2026-10-12", "Household internet", 100.0, 0.0, {"id": None, "name": "Card payment"}),
        ("2026-10-14", "Household snacks", 30.0, 0.0, {"id": None, "name": "Other account"}),
        ("2026-10-20", "Household water", 45.0, 0.0, None),
        ("2026-11-20", "Household water", 45.0, 0.0, None),  # monthly
    ]
    assert all(set(i) == LIMITED_EVENT_KEYS for i in items)
    assert sw_leaks(_upcoming(sw_db, c), private_ids=[hh["a_card"], hh["a_wallet"]]) == []
    # Never cash: no payable, no unassigned cash, the same closings.
    assert not [p for p in get_payables(sw_db, c["id"], days=60, reference=REF)
                if p.get("kind") == "household"]
    after = project_running_balance(sw_db, c["id"], days=60, reference=REF)
    assert after["unassigned_closing"] == 0
    assert after["closing_balance"] == before["closing_balance"]
    # A user holding no share sees none of it.
    assert _household(_upcoming(sw_db, hh["b"])) == []


@pytest.mark.parametrize("paid,remainder", [(0, 100.0), (40, 60.0), (100, None)])
def test_a_household_charge_on_a_privately_routed_card_less_the_joint_payment(
        hh, sw_client, sw_db, paid, remainder):
    a, c = hh["a"], hh["c"]
    _txn(sw_client, a, hh["a_card"], 100, "2026-10-12T00:00:00", tags=[hh["hh_a"]],
         description="Household internet")
    if paid:
        _transfer(sw_client, a, hh["joint"], hh["a_card"], paid, "2026-11-01T00:00:00")
    items = _household(_upcoming(sw_db, c))
    assert [i["face_amount"] for i in items] == ([] if remainder is None else [remainder])
    # The joint outflow plus the remainder is always the charge.
    joint_out = sum(-i["cash_delta"] for i in _upcoming(sw_db, c)
                    if i.get("kind") == "card_payment")
    assert joint_out + (remainder or 0) == 100


@pytest.mark.parametrize("paid", [50, 100])
def test_a_mixed_statement_paid_from_joint_covers_the_household_line_first(hh, sw_client,
                                                                           sw_db, paid):
    a, c = hh["a"], hh["c"]
    _txn(sw_client, a, hh["a_card"], 50, "2026-10-12T00:00:00", tags=[hh["hh_a"]],
         description="Household internet")
    _txn(sw_client, a, hh["a_card"], 50, "2026-10-13T00:00:00", description=f"{PRIVATE} gift")
    _transfer(sw_client, a, hh["joint"], hh["a_card"], paid, "2026-11-01T00:00:00")
    assert _household(_upcoming(sw_db, c)) == []


def test_a_household_bill_on_a_card_routed_to_joint_counts_once(hh, sw_client, sw_db):
    a, c = hh["a"], hh["c"]
    _put(sw_client, a, f"/accounts/{hh['a_card']}", {"payment_account_id": hh["joint"]})
    _txn(sw_client, a, hh["a_card"], 100, "2026-10-12T00:00:00", tags=[hh["hh_a"]],
         description="Household internet")
    items = _upcoming(sw_db, c)
    assert _household(items) == []
    [payment] = [i for i in items if i.get("kind") == "card_payment"]
    assert (payment["date"], payment["cash_delta"], payment["account"]) == (
        "2026-11-05", -100.0, {"id": hh["joint"], "name": "Joint account"})


def test_a_hidden_primary_with_joint_overflow_leaves_the_bill_at_face(hh, sw_client, sw_db):
    a, c = hh["a"], hh["c"]
    _put(sw_client, a, f"/accounts/{hh['a_card']}",
         {"payment_overflow_account_id": hh["joint"]})
    _txn(sw_client, a, hh["a_card"], 100, "2026-10-12T00:00:00", tags=[hh["hh_a"]],
         description="Household internet")
    items = _upcoming(sw_db, c)
    assert [i["face_amount"] for i in _household(items)] == [100.0]
    # The neutral card payment moves no cash for C: no leg, no overflow move.
    [payment] = [i for i in items if i.get("kind") == "card_payment"]
    assert payment["cash_delta"] == 0.0 and payment["account"] is None


def test_partner_records_on_joint_never_reach_the_tag_viewers_projection(hh, sw_client,
                                                                          sw_db):
    from app.services.forecast import collect_events, project_running_balance

    a, b, c = hh["a"], hh["b"], hh["c"]
    _txn(sw_client, a, hh["joint"], 120, "2026-10-15T00:00:00", description="Household rent")
    _txn(sw_client, b, hh["joint"], 66.61, "2026-10-16T00:00:00", tags=[hh["hh_b"]],
         description=f"{PRIVATE} Bea lunch")
    sw_post(sw_client, b, "/budget-entries/", {
        "name": f"{PRIVATE} Bea bill", "entry_type": "expense", "amount": 311.37,
        "next_occurrence": "2026-10-21T00:00:00", "account_id": hh["joint"],
        "tag_ids": [hh["hh_b"]]})
    sw_db.expire_all()
    events = collect_events(sw_db, REF, datetime(2026, 12, 9), user_id=c["id"])
    assert [(e["date"], e["name"], e["amount"]) for e in events] == [
        (datetime(2026, 10, 15), "Household rent", Decimal("-120.00"))]
    assert events[0]["view"] == "limited" and events[0]["kind"] == "expense"
    timeline = project_running_balance(sw_db, c["id"], days=60, reference=REF)
    assert sw_leaks(_upcoming(sw_db, c), numbers=(66.61, 311.37)) == []
    assert [e["name"] for e in timeline["events"]] == ["Household rent"]
    # B, a direct editor, projects every record on the account.
    names = {e["name"] for e in collect_events(sw_db, REF, datetime(2026, 12, 9),
                                               user_id=b["id"])}
    assert {"Household rent", f"{PRIVATE} Bea lunch", f"{PRIVATE} Bea bill"} <= names


def test_a_household_tagged_card_in_scope_projects_its_statement_without_detail(hh, sw_client,
                                                                               sw_db):
    from app.services.forecast import collect_events

    a, c = hh["a"], hh["c"]
    _put(sw_client, a, f"/accounts/{hh['a_card']}",
         {"tag_ids": [hh["hh_a"]], "payment_account_id": hh["joint"]})
    _txn(sw_client, a, hh["a_card"], 100, "2026-10-12T00:00:00", posted=True,
         description="Household internet")
    sw_db.expire_all()
    [statement] = [e for e in collect_events(sw_db, REF, datetime(2026, 12, 9), user_id=c["id"])
                   if e["source"] == "statement"]
    assert statement["view"] == "limited" and statement["kind"] == "card_payment"
    assert statement["amount"] == Decimal("-100.00") and statement["source_id"] is None
    assert "statement_balance" not in statement and "statement_close" not in statement
    assert _household(_upcoming(sw_db, c)) == []
