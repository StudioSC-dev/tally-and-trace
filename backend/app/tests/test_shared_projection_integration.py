"""Shared accounts (STU-232): the projection over a shared scope.

Each case of the ticket's matrix, with exact amounts and dates, through
``collect_events`` and the views built on it, at a fixed reference date.
"""
from datetime import datetime, timedelta
from decimal import Decimal

import pytest

from app.tests.conftest import API, PRIVATE, sw_db_reachable, sw_leaks, sw_post, sw_share

pytestmark = pytest.mark.skipif(not sw_db_reachable(), reason="DATABASE_URL not reachable")

REF = datetime(2026, 10, 10)
END = REF + timedelta(days=60)
LIMITED_EVENT_KEYS = {"view", "public_id", "date", "original_date", "overdue", "display_name",
                      "face_amount", "cash_delta", "currency", "account", "kind"}


def _events(db, who):
    from app.services.forecast import collect_events

    db.expire_all()
    return collect_events(db, REF, END, user_id=who["id"])


def _legs(e):
    return [(leg["account_id"], leg["amount"], leg["cash"]) for leg in e["legs"]]


def _txn(client, who, account, amount, when, kind="debit", posted=False, **extra):
    body = {"account_id": account, "amount": amount, "transaction_type": kind,
            "transaction_date": when, "is_posted": posted, "description": "Plain", **extra}
    return sw_post(client, who, "/transactions/", body)["id"]


def _transfer(client, who, frm, to, amount, when, posted=False, **extra):
    return _txn(client, who, frm, amount, when, kind="transfer", posted=posted,
                transfer_from_account_id=frm, transfer_to_account_id=to, **extra)


def _card(client, sw, db, *, payment, overflow=None, share=("b",), name="Shared card"):
    body = {"name": name, "account_type": "credit", "balance": 0,
            "billing_cycle_start": 10, "days_until_due_date": 20, "payment_account_id": payment}
    if overflow:
        body["payment_overflow_account_id"] = overflow
    card = sw_post(client, sw["a"], "/accounts/", body)["id"]
    for who in share:
        sw_share(db, card, sw[who]["id"], "editor", sw["a"]["id"])
    return card


def _put(client, who, path, body):
    r = client.put(f"{API}{path}", json=body, headers=who["headers"])
    assert r.status_code == 200, r.text


def test_partners_deposit_is_counted_once(sw, sw_client, sw_db):
    _transfer(sw_client, sw["b"], sw["b_private"], sw["joint"], 250, "2026-10-15T00:00:00")
    owner = [e for e in _events(sw_db, sw["a"]) if e["date"] == datetime(2026, 10, 15)]
    assert len(owner) == 1
    assert _legs(owner[0]) == [(sw["joint"], Decimal("250.00"), True)]
    assert owner[0]["amount"] == Decimal("250.00")
    assert owner[0]["view"] == "limited" and owner[0]["name"] == "Transfer"
    partner = [e for e in _events(sw_db, sw["b"]) if e["date"] == datetime(2026, 10, 15)]
    assert len(partner) == 1
    assert _legs(partner[0]) == [(sw["b_private"], Decimal("-250.00"), True),
                                 (sw["joint"], Decimal("250.00"), True)]
    assert partner[0]["amount"] == 0


def test_owners_private_loan_paid_from_joint_is_a_neutral_loan_payment(sw, sw_client, sw_db):
    _transfer(sw_client, sw["a"], sw["joint"], sw["a_loan"], 4000, "2026-10-18T00:00:00",
              transfer_fee=500)
    [e] = [e for e in _events(sw_db, sw["b"]) if e["date"] == datetime(2026, 10, 18)]
    assert e["name"] == "Loan payment" and e["source_id"] is None
    assert "transfer_fee" not in e
    assert _legs(e) == [(sw["joint"], Decimal("-4500.00"), True)]
    assert e["amount"] == Decimal("-4500.00") and e["face_amount"] == Decimal("4500.00")
    assert e["kind"] == "loan_payment" and e["loan_payment"] is True
    assert sw_leaks(e, {sw["a_loan"], sw["a_private"]}) == []


def test_discovered_loan_routed_to_joint_is_a_neutral_payable(sw, sw_client, sw_db):
    _put(sw_client, sw["a"], f"/accounts/{sw['a_loan']}", {"payment_account_id": sw["joint"]})
    owner = [e for e in _events(sw_db, sw["a"]) if e["source"] == "loan"]
    partner = [e for e in _events(sw_db, sw["b"]) if e["source"] == "loan"]
    assert [(e["date"], e["amount"]) for e in partner] == \
        [(e["date"], e["amount"]) for e in owner]
    first = partner[0]
    assert first["date"] == datetime(2026, 10, 20) and first["amount"] == Decimal("-5000.00")
    assert first["name"] == "Loan payment" and first["source_id"] is None
    assert "loan_due_date" not in first and first["view"] == "limited"
    assert owner[0]["name"].startswith(PRIVATE) and owner[0]["source_id"] == sw["a_loan"]


def test_card_payment_to_a_visible_card_moves_cash(sw, sw_client, sw_db):
    card = _card(sw_client, sw, sw_db, payment=sw["joint"])
    _transfer(sw_client, sw["a"], sw["joint"], card, 100, "2026-10-16T00:00:00")
    [e] = [e for e in _events(sw_db, sw["b"]) if e["date"] == datetime(2026, 10, 16)]
    assert e["amount"] == Decimal("-100.00") and e["card_payment"] is True
    assert _legs(e) == [(sw["joint"], Decimal("-100.00"), True),
                        (card, Decimal("100.00"), False)]


def test_wallet_top_up_and_return_move_cash_legs_only(sw, sw_client, sw_db):
    wallet = sw_post(sw_client, sw["a"], "/accounts/", {
        "name": "Cash wallet", "account_type": "cash", "balance": 0,
        "is_spending_wallet": True})["id"]
    sw_share(sw_db, wallet, sw["b"]["id"], "editor", sw["a"]["id"])
    _transfer(sw_client, sw["a"], sw["joint"], wallet, 50, "2026-10-17T00:00:00")
    _transfer(sw_client, sw["a"], wallet, sw["joint"], 20, "2026-10-19T00:00:00")
    events = {e["date"]: e for e in _events(sw_db, sw["b"])}
    top_up, back = events[datetime(2026, 10, 17)], events[datetime(2026, 10, 19)]
    assert top_up["amount"] == Decimal("-50.00") and top_up["top_up"] is True
    assert _legs(top_up) == [(sw["joint"], Decimal("-50.00"), True),
                             (wallet, Decimal("50.00"), False)]
    assert back["amount"] == Decimal("20.00")
    assert _legs(back) == [(wallet, Decimal("-20.00"), False),
                           (sw["joint"], Decimal("20.00"), True)]


def test_loan_payment_moves_principal_plus_interest(sw, sw_client, sw_db):
    loan = sw_post(sw_client, sw["a"], "/accounts/", {
        "name": "Shared loan", "account_type": "loan", "loan_kind": "personal",
        "balance": -10_000, "loan_annual_rate": 12, "loan_term_months": 12,
        "loan_payment_amount": 1_000, "loan_first_payment_date": "2026-11-15",
        "payment_account_id": sw["joint"]})["id"]
    sw_share(sw_db, loan, sw["b"]["id"], "editor", sw["a"]["id"])
    _transfer(sw_client, sw["a"], sw["joint"], loan, 1000, "2026-10-21T00:00:00",
              transfer_fee=50)
    [e] = [e for e in _events(sw_db, sw["b"]) if e["date"] == datetime(2026, 10, 21)]
    assert e["amount"] == Decimal("-1050.00") and e["transfer_fee"] == Decimal("50.00")


def test_overdue_statements_and_dues_are_distinct_events(sw, sw_client, sw_db):
    card = _card(sw_client, sw, sw_db, payment=sw["joint"])
    _txn(sw_client, sw["a"], card, 70, "2026-08-05T00:00:00", posted=True)
    _txn(sw_client, sw["b"], card, 90, "2026-09-05T00:00:00", posted=True)
    loan = sw_post(sw_client, sw["a"], "/accounts/", {
        "name": "Old loan", "account_type": "loan", "loan_kind": "personal",
        "balance": -6_000, "loan_annual_rate": 0, "loan_term_months": 12,
        "loan_payment_amount": 500, "loan_first_payment_date": "2026-08-15",
        "payment_account_id": sw["joint"]})["id"]
    sw_share(sw_db, loan, sw["b"]["id"], "editor", sw["a"]["id"])
    for who in ("a", "b"):
        events = _events(sw_db, sw[who])
        statements = sorted((e["original_date"], e["amount"]) for e in events
                            if e["source"] == "statement" and e.get("overdue"))
        assert statements == [(datetime(2026, 8, 30), Decimal("-70.00")),
                              (datetime(2026, 9, 30), Decimal("-90.00"))]
        dues = sorted((e["original_date"], e["amount"]) for e in events
                      if e["source"] == "loan" and e.get("overdue"))
        assert dues == [(datetime(2026, 8, 15), Decimal("-500.00")),
                        (datetime(2026, 9, 15), Decimal("-500.00"))]


def test_recurring_entries_by_each_user_appear_for_both(sw, sw_client, sw_db):
    for who, name in (("a", "Alice rent"), ("b", "Bea internet")):
        sw_post(sw_client, sw[who], "/budget-entries/", {
            "name": name, "entry_type": "expense", "amount": 300,
            "next_occurrence": "2026-10-25T00:00:00", "account_id": sw["joint"]})
    for who in ("a", "b", "d"):
        names = {e["name"] for e in _events(sw_db, sw[who])
                 if e["date"] == datetime(2026, 10, 25)}
        assert names == {"Alice rent", "Bea internet"}
    # A viewer sees both as limited events, with their names (every account viewable).
    viewer = [e for e in _events(sw_db, sw["v"]) if e["date"] == datetime(2026, 10, 25)]
    assert sorted(e["name"] for e in viewer) == ["Alice rent", "Bea internet"]
    assert {e["view"] for e in viewer} == {"limited"}
    assert {e["source_id"] for e in viewer} == {None}


def test_another_users_debit_on_joint_is_in_the_owners_projection(sw, sw_client, sw_db):
    _txn(sw_client, sw["b"], sw["joint"], 80, "2026-10-22T00:00:00")
    [e] = [e for e in _events(sw_db, sw["a"]) if e["date"] == datetime(2026, 10, 22)]
    assert _legs(e) == [(sw["joint"], Decimal("-80.00"), True)]
    assert e["amount"] == Decimal("-80.00")


def test_owners_private_card_routed_to_joint_is_a_neutral_card_payment(sw, sw_client, sw_db):
    _put(sw_client, sw["a"], f"/accounts/{sw['a_card']}", {"payment_account_id": sw["joint"]})
    _txn(sw_client, sw["a"], sw["a_card"], 300, "2026-10-01T00:00:00", posted=True,
         description=f"{PRIVATE} purchase")
    [owner] = [e for e in _events(sw_db, sw["a"]) if e["source"] == "statement"]
    assert owner["date"] == datetime(2026, 11, 5) and owner["source_id"] == sw["a_card"]
    [e] = [e for e in _events(sw_db, sw["b"]) if e["source"] == "statement"]
    assert e["name"] == "Card payment" and e["source_id"] is None
    assert e["date"] == datetime(2026, 11, 5)
    assert e["amount"] == Decimal("-300.00") and e["face_amount"] == Decimal("300.00")
    assert _legs(e) == [(sw["joint"], Decimal("-300.00"), True)]
    for key in ("statement_close", "statement_balance"):
        assert key not in e
    assert sw_leaks(e, {sw["a_card"], sw["a_private"]}) == []


def test_hidden_primary_with_joint_overflow_gets_no_leg(sw, sw_client, sw_db):
    from app.services.forecast import project_running_balance

    _put(sw_client, sw["a"], f"/accounts/{sw['a_card']}",
         {"payment_overflow_account_id": sw["joint"]})
    _txn(sw_client, sw["a"], sw["a_card"], 6_000, "2026-10-01T00:00:00", posted=True)
    [e] = [e for e in _events(sw_db, sw["b"]) if e["source"] == "statement"]
    assert e["name"] == "Card payment" and e["legs"] == [] and e["amount"] == 0
    assert e["counts_as_cash"] is False
    sw_db.expire_all()
    owner = project_running_balance(sw_db, sw["a"]["id"], days=60, reference=REF)
    partner = project_running_balance(sw_db, sw["b"]["id"], days=60, reference=REF)
    assert owner["overflow_moves"]  # the owner's 5,000 private balance falls 1,000 short
    assert partner["overflow_moves"] == []

    def joint(result):
        return [a["closing_balance"] for a in result["by_account"]
                if a["account_id"] == sw["joint"]]
    assert joint(owner) == joint(partner) == [Decimal("10000.00")]


def test_visible_card_with_a_hidden_payment_account_has_no_leg(sw, sw_client, sw_db):
    card = _card(sw_client, sw, sw_db, payment=sw["a_private"])
    _txn(sw_client, sw["a"], card, 120, "2026-10-02T00:00:00", posted=True)
    [e] = [e for e in _events(sw_db, sw["b"]) if e["source"] == "statement"]
    assert e["source_id"] == card and e["legs"] == []
    assert e["funding_account_id"] is None and e["overflow_account_id"] is None
    assert e["amount"] == 0 and e["face_amount"] == Decimal("120.00")
    assert sw_leaks(e, {sw["a_private"]}) == []
    [owner] = [e for e in _events(sw_db, sw["a"]) if e["source"] == "statement"]
    assert _legs(owner) == [(sw["a_private"], Decimal("-120.00"), True)]


def test_another_users_debit_on_a_shared_card_is_billed(sw, sw_client, sw_db):
    card = _card(sw_client, sw, sw_db, payment=sw["joint"])
    _txn(sw_client, sw["a"], card, 60, "2026-10-02T00:00:00", posted=True)
    _txn(sw_client, sw["b"], card, 40, "2026-10-03T00:00:00", posted=True)
    [e] = [e for e in _events(sw_db, sw["a"]) if e["source"] == "statement"]
    assert e["date"] == datetime(2026, 10, 30) and e["amount"] == Decimal("-100.00")


def test_transfer_into_the_partners_loan_is_neutral_for_the_owner(sw, sw_client, sw_db):
    b_loan = sw_post(sw_client, sw["b"], "/accounts/", {
        "name": "Bea student loan", "account_type": "loan", "loan_kind": "personal",
        "balance": -8_000, "loan_annual_rate": 6, "loan_term_months": 24,
        "loan_payment_amount": 400, "loan_first_payment_date": "2026-12-20",
        "payment_account_id": sw["b_private"]})["id"]
    _transfer(sw_client, sw["b"], sw["joint"], b_loan, 700, "2026-10-23T00:00:00",
              transfer_fee=30)
    [e] = [e for e in _events(sw_db, sw["a"]) if e["date"] == datetime(2026, 10, 23)]
    assert e["name"] == "Loan payment" and e["source_id"] is None
    assert "transfer_fee" not in e
    assert e["amount"] == Decimal("-730.00")
    assert _legs(e) == [(sw["joint"], Decimal("-730.00"), True)]
    assert "Bea student loan" not in str(e)
    assert sw_leaks(e, {b_loan}) == []


def test_accountless_entries_never_reach_a_sharees_cash(sw, sw_client, sw_db):
    from app.services.forecast import project_running_balance

    sw_post(sw_client, sw["a"], "/budget-entries/", {
        "name": "Pocket money", "entry_type": "expense", "amount": 90,
        "next_occurrence": "2026-10-26T00:00:00"})
    assert "Pocket money" in {e["name"] for e in _events(sw_db, sw["a"])}
    for who in ("b", "v", "d"):
        assert "Pocket money" not in {e["name"] for e in _events(sw_db, sw[who])}
        result = project_running_balance(sw_db, sw[who]["id"], days=60, reference=REF)
        assert result["unassigned_closing"] == 0


@pytest.mark.skip(reason="T5: needs tag shares (the Household tag share is STU-233)")
def test_t5_partner_records_on_joint_seen_through_owners_tag_share():
    """Partner B's records on A's joint account, seen by C through A's tag share."""


# --- Public shapes -----------------------------------------------------------------------

def test_limited_events_have_the_allowlist_shape(sw, sw_client, sw_db):
    from app.services.forecast import get_payables, get_upcoming_items, project_running_balance
    from app.services.forecast import serialize_timeline

    _put(sw_client, sw["a"], f"/accounts/{sw['a_card']}", {"payment_account_id": sw["joint"]})
    _txn(sw_client, sw["a"], sw["a_card"], 300, "2026-10-01T00:00:00", posted=True,
         description=f"{PRIVATE} purchase")
    _transfer(sw_client, sw["a"], sw["joint"], sw["a_loan"], 4000, "2026-10-18T00:00:00",
              transfer_fee=500)
    b = sw["b"]["id"]
    sw_db.expire_all()
    upcoming = [i for i in get_upcoming_items(sw_db, b, days=60, reference=REF)
                if i.get("view") == "limited"]
    payables = [p for p in get_payables(sw_db, b, days=60, reference=REF)
                if p.get("view") == "limited"]
    timeline = serialize_timeline(project_running_balance(sw_db, b, days=60, reference=REF))
    limited_timeline = [e for e in timeline["events"] if e.get("view") == "limited"]
    assert upcoming and payables and limited_timeline
    for item in upcoming + payables:
        assert set(item) == LIMITED_EVENT_KEYS
    for item in limited_timeline:
        assert set(item) == LIMITED_EVENT_KEYS | {"running_balance"}
    card = next(i for i in payables if i["kind"] == "card_payment")
    assert card == {**card, "display_name": "Card payment", "cash_delta": -300.0,
                    "face_amount": 300.0, "date": "2026-11-05",
                    "account": {"id": sw["joint"], "name": "Joint account"}}
    secret = {sw["a_card"], sw["a_loan"], sw["a_private"]}
    for body in (upcoming, payables, timeline):
        assert sw_leaks(body, secret, numbers=[500]) == []


@pytest.mark.parametrize("who", ["b", "v", "d"])
def test_projection_endpoints_carry_no_sentinel(sw, sw_client, sw_db, who):
    soon = (datetime.utcnow() + timedelta(days=5)).replace(microsecond=0).isoformat()
    _put(sw_client, sw["a"], f"/accounts/{sw['a_card']}",
         {"payment_account_id": sw["joint"], "payment_overflow_account_id": sw["a_private"]})
    _txn(sw_client, sw["a"], sw["a_card"], 300, soon, posted=True,
         description=f"{PRIVATE} purchase")
    _transfer(sw_client, sw["a"], sw["joint"], sw["a_loan"], 4000, soon, transfer_fee=500,
              description=f"{PRIVATE} loan payment")
    _transfer(sw_client, sw["a"], sw["a_private"], sw["joint"], 600, soon,
              description=f"{PRIVATE} top-up")
    sw_post(sw_client, sw["a"], "/budget-entries/", {
        "name": f"{PRIVATE} insurance", "entry_type": "expense", "amount": 60,
        "next_occurrence": soon, "account_id": sw["joint"],
        "overflow_account_id": sw["a_private"]})
    secret = {sw["a_card"], sw["a_loan"], sw["a_private"]}
    for path in ("/forecast/upcoming?days=60", "/forecast/timeline?days=60",
                 "/forecast/cashflow?months=3", "/forecast/disposable",
                 "/dashboard/snapshot"):
        r = sw_client.get(f"{API}{path}", headers=sw[who]["headers"])
        assert r.status_code == 200, r.text
        assert sw_leaks(r.json(), secret, numbers=[500]) == [], path
