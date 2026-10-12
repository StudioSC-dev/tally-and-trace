"""Household views and monthly totals (STU-233, plan §3).

Each view is one sharer's Household: the sharer's active Household-tagged
accounts the caller sees, the records on them the caller may read, and the
sharer's Household occurrences outside them. Monthly totals are per currency:
recorded months from posted transactions, the current month from today and
later months from the projection. Every money case runs on posted data (a
recorded month) and on projected data.
"""
from datetime import datetime

import pytest

from app.tests.conftest import API, PRIVATE, hh_tag_share, sw_db_reachable, sw_leaks, sw_post

pytestmark = pytest.mark.skipif(not sw_db_reachable(), reason="DATABASE_URL not reachable")

PROJECTED = datetime(2026, 10, 10)   # October current, November projected
RECORDED = datetime(2026, 12, 10)    # October and November recorded
OCT, NOV = datetime(2026, 10, 1), datetime(2026, 11, 1)
FIELDS = ("income", "expense", "fees", "moved_in", "moved_out", "paid_from_other_accounts")


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


def _get(client, who, path, expect=200):
    r = client.get(f"{API}{path}", headers=who["headers"])
    assert r.status_code == expect, (path, r.status_code, r.text)
    return r.json()


def _monthly(db, who, sharer, reference, first=OCT, last=NOV):
    from app.services.household import household_monthly, household_view

    db.expire_all()
    grant = household_view(db, who["id"], sharer["id"])
    return household_monthly(db, who["id"], grant, first, last, reference=reference)


def _sum(months, currency="PHP"):
    """Each field summed over the months, for one currency."""
    out = dict.fromkeys(FIELDS, 0.0)
    for month in months:
        for line in month["currencies"]:
            if line["currency"] == currency:
                for k in FIELDS:
                    out[k] = round(out[k] + line[k], 2)
    return out


MODES = {"recorded": (True, RECORDED), "projected": (False, PROJECTED)}


def _charge(client, hh, mode, amount=100, tags=None, when="2026-10-12T00:00:00", **extra):
    posted, _ = MODES[mode]
    return _txn(client, hh["a"], hh["a_card"], amount, when, posted=posted,
                tags=[hh["hh_a"]] if tags is None else tags,
                description=extra.pop("description", "Household internet"), **extra)


def _pay(client, hh, amount, mode, when="2026-11-01T00:00:00"):
    posted, _ = MODES[mode]
    _transfer(client, hh["a"], hh["joint"], hh["a_card"], amount, when, posted=posted)


# --- Views ------------------------------------------------------------------------------------

def test_views_list_self_and_each_sharer_and_404_for_anyone_else(hh, sw_client, sw_db):
    a, b, c = hh["a"], hh["b"], hh["c"]
    views = _get(sw_client, c, "/household/")
    assert [(v["sharer_id"], v["is_self"]) for v in views] == [
        (c["id"], True), *sorted([(a["id"], False), (b["id"], False)])]
    assert [(v["sharer_id"], v["is_self"]) for v in _get(sw_client, a, "/household/")] == [
        (a["id"], True)]
    for path in ("transactions", "upcoming", "dashboard", "monthly?from=2026-10&to=2026-11"):
        _get(sw_client, a, f"/household/{c['id']}/{path}", expect=404)  # no share from C
        _get(sw_client, c, f"/household/999999999/{path}", expect=404)
        _get(sw_client, c, f"/household/{a['id']}/{path}")
        _get(sw_client, a, f"/household/{a['id']}/{path}")  # the sharer's own view


def test_monthly_rejects_a_bad_range(hh, sw_client):
    c, a = hh["c"], hh["a"]
    _get(sw_client, c, f"/household/{a['id']}/monthly?from=2026-11&to=2026-10", expect=422)
    _get(sw_client, c, f"/household/{a['id']}/monthly?from=2026-13&to=2026-14", expect=422)
    _get(sw_client, c, f"/household/{a['id']}/monthly?from=2020-01&to=2026-10", expect=422)


def test_revoking_or_leaving_closes_the_view(hh, sw_client, sw_db):
    a, b, c = hh["a"], hh["b"], hh["c"]
    r = sw_client.delete(f"{API}/tags/household/shares/{hh['a_to_c']}", headers=a["headers"])
    assert r.status_code == 204
    _get(sw_client, c, f"/household/{a['id']}/transactions", expect=404)
    r = sw_client.delete(f"{API}/shares/received/household/{hh['b_to_c']}",
                         headers=c["headers"])
    assert r.status_code == 204
    _get(sw_client, c, f"/household/{b['id']}/monthly?from=2026-10&to=2026-10", expect=404)
    assert [v["is_self"] for v in _get(sw_client, c, "/household/")] == [True]


def test_transactions_view_never_leaks_partner_or_private_records(hh, sw_client, sw_db):
    a, b, c = hh["a"], hh["b"], hh["c"]
    rent = _txn(sw_client, a, hh["joint"], 120, "2026-10-05T00:00:00", posted=True,
                description="Household rent")
    internet = _txn(sw_client, a, hh["a_card"], 100, "2026-10-12T00:00:00", posted=True,
                    tags=[hh["hh_a"]], description="Household internet")
    _txn(sw_client, a, hh["a_private"], 66.61, "2026-10-06T00:00:00", posted=True,
         description=f"{PRIVATE} gift")
    _txn(sw_client, b, hh["joint"], 77.17, "2026-10-07T00:00:00", posted=True,
         tags=[hh["hh_b"]], description=f"{PRIVATE} Bea lunch")
    body = _get(sw_client, c, f"/household/{a['id']}/transactions")
    assert sorted(t["id"] for t in body["items"]) == sorted([rent, internet])
    assert body["total"] == 2
    [shown] = [t for t in body["items"] if t["id"] == internet]
    assert shown["display_description"] == "Household internet" and shown["view"] == "limited"
    assert sw_leaks(body, private_ids=[hh["a_private"], hh["a_card"], hh["b_private"]],
                    numbers=(66.61, 77.17)) == []
    # B, a direct editor holding no share from A, has no view of A; A's own view
    # holds every record on the joint account and A's occurrence, not A's privates.
    _get(sw_client, b, f"/household/{a['id']}/transactions", expect=404)
    own = _get(sw_client, a, f"/household/{a['id']}/transactions")
    assert {t.get("description") or t.get("display_description") for t in own["items"]} == {
        "Household rent", "Household internet", f"{PRIVATE} Bea lunch"}


def test_multiple_sharers_each_view_scoped_to_one_sharer(hh, sw_client, sw_db):
    a, b, c = hh["a"], hh["b"], hh["c"]
    _put(sw_client, b, f"/accounts/{hh['b_private']}", {"tag_ids": [hh["hh_b"]]})
    bea = _txn(sw_client, b, hh["b_private"], 40, "2026-10-08T00:00:00", posted=True,
               description="Bea groceries")
    rent = _txn(sw_client, a, hh["joint"], 120, "2026-10-05T00:00:00", posted=True,
                description="Household rent")
    a_view = _get(sw_client, c, f"/household/{a['id']}/transactions")["items"]
    b_view = _get(sw_client, c, f"/household/{b['id']}/transactions")["items"]
    assert [t["id"] for t in a_view] == [rent]
    assert [t["id"] for t in b_view] == [bea]
    a_dash = _get(sw_client, c, f"/household/{a['id']}/dashboard")
    b_dash = _get(sw_client, c, f"/household/{b['id']}/dashboard")
    assert [x["id"] for x in a_dash["accounts"]] == [hh["joint"]]
    assert [x["id"] for x in b_dash["accounts"]] == [hh["b_private"]]
    assert a_dash["accounts"][0]["my_role"] == "tag_viewer"
    assert set(a_dash) == {"sharer", "accounts", "month", "upcoming"}
    assert a_dash["sharer"] == {"id": a["id"], "name": "Alice O."}


def test_upcoming_view_lists_the_occurrence_once_and_no_private_spending(hh, sw_client, sw_db):
    from app.services.forecast import upcoming_items
    from app.services.household import household_events, household_view

    a, c = hh["a"], hh["c"]
    _txn(sw_client, a, hh["a_card"], 100, "2026-10-12T00:00:00", tags=[hh["hh_a"]],
         description="Household internet")
    _txn(sw_client, a, hh["a_private"], 66.61, "2026-10-13T00:00:00",
         description=f"{PRIVATE} gift")
    _txn(sw_client, a, hh["joint"], 120, "2026-10-15T00:00:00", description="Household rent")
    sw_db.expire_all()
    grant = household_view(sw_db, c["id"], a["id"])
    items = upcoming_items(household_events(sw_db, c["id"], grant, PROJECTED,
                                            datetime(2026, 12, 9)))
    assert [(i["date"], i["display_name"], i["face_amount"], i["cash_delta"]) for i in items] == [
        ("2026-10-12", "Household internet", 100.0, 0.0),
        ("2026-10-15", "Household rent", 120.0, -120.0),
    ]
    assert sw_leaks(items, private_ids=[hh["a_private"], hh["a_card"]], numbers=(66.61,)) == []


# --- Monthly totals: the money cases, posted and projected -------------------------------------

@pytest.mark.parametrize("mode", list(MODES))
@pytest.mark.parametrize("paid,remainder", [(0, 100.0), (40, 60.0), (100, 0.0)])
def test_privately_routed_card_less_the_joint_payment(hh, sw_client, sw_db, mode, paid,
                                                      remainder):
    _charge(sw_client, hh, mode)
    if paid:
        _pay(sw_client, hh, paid, mode)
    totals = _sum(_monthly(sw_db, hh["c"], hh["a"], MODES[mode][1]))
    assert totals["paid_from_other_accounts"] == remainder
    assert totals["expense"] == paid
    assert totals["expense"] + totals["paid_from_other_accounts"] == 100


@pytest.mark.parametrize("mode", list(MODES))
def test_mixed_statement_fully_paid_from_joint_leaves_no_remainder(hh, sw_client, sw_db, mode):
    _charge(sw_client, hh, mode, 50)
    _charge(sw_client, hh, mode, 50, tags=[], when="2026-10-13T00:00:00",
            description=f"{PRIVATE} gift")
    _pay(sw_client, hh, 100, mode)
    totals = _sum(_monthly(sw_db, hh["c"], hh["a"], MODES[mode][1]))
    assert (totals["expense"], totals["paid_from_other_accounts"]) == (100.0, 0.0)


@pytest.mark.parametrize("viewer", ["c", "a"])
@pytest.mark.parametrize("mode", list(MODES))
def test_household_bill_routed_to_joint_counts_once(hh, sw_client, sw_db, mode, viewer):
    _put(sw_client, hh["a"], f"/accounts/{hh['a_card']}", {"payment_account_id": hh["joint"]})
    _charge(sw_client, hh, mode)
    if mode == "recorded":
        _pay(sw_client, hh, 100, mode, when="2026-11-05T00:00:00")  # the routed payment
    months = _monthly(sw_db, hh[viewer], hh["a"], MODES[mode][1])
    assert _sum(months) == {**dict.fromkeys(FIELDS, 0.0), "expense": 100.0}
    [nov] = [m for m in months if m["month"] == "2026-11"]
    assert nov["currencies"][0]["expense"] == 100.0


@pytest.mark.parametrize("mode", list(MODES))
def test_hidden_primary_with_joint_overflow_counts_at_face(hh, sw_client, sw_db, mode):
    _put(sw_client, hh["a"], f"/accounts/{hh['a_card']}",
         {"payment_overflow_account_id": hh["joint"]})
    _charge(sw_client, hh, mode)
    totals = _sum(_monthly(sw_db, hh["c"], hh["a"], MODES[mode][1]))
    assert totals == {**dict.fromkeys(FIELDS, 0.0), "paid_from_other_accounts": 100.0}


@pytest.mark.parametrize("mode", list(MODES))
def test_wallet_occurrence_is_paid_from_other_accounts(hh, sw_client, sw_db, mode):
    posted, ref = MODES[mode]
    _txn(sw_client, hh["a"], hh["a_wallet"], 30, "2026-10-14T00:00:00", posted=posted,
         tags=[hh["hh_a"]], description="Household snacks")
    totals = _sum(_monthly(sw_db, hh["c"], hh["a"], ref))
    assert totals == {**dict.fromkeys(FIELDS, 0.0), "paid_from_other_accounts": 30.0}


# --- Monthly totals: exact lines -----------------------------------------------------------------

def test_exact_lines_with_moved_in_private_spending_excluded_and_two_currencies(
        hh, sw_client, sw_db):
    a, b, c = hh["a"], hh["b"], hh["c"]
    hh_tag_share(sw_db, a, b)  # B, the joint account's editor, also holds A's share
    usd = sw_post(sw_client, a, "/accounts/", {
        "name": "Household dollars", "account_type": "savings", "balance": 0,
        "currency": "USD", "tag_ids": [hh["hh_a"]]})["id"]
    _txn(sw_client, a, hh["joint"], 1000, "2026-10-02T00:00:00", kind="credit", posted=True,
         description="Salary")
    _transfer(sw_client, b, hh["b_private"], hh["joint"], 500, "2026-10-03T00:00:00",
              posted=True, description="Bea share")
    _txn(sw_client, b, hh["b_private"], 70.07, "2026-10-04T00:00:00", posted=True,
         description="Bea private lunch")
    _txn(sw_client, a, hh["joint"], 120, "2026-10-05T00:00:00", posted=True,
         description="Household rent")
    _transfer(sw_client, a, hh["joint"], hh["a_private"], 200, "2026-10-06T00:00:00",
              posted=True, transfer_fee=5, description="To savings")
    _txn(sw_client, a, usd, 40, "2026-10-07T00:00:00", kind="credit", posted=True,
         currency="USD", description="Dollar refund")
    _txn(sw_client, a, hh["joint"], 30, "2026-10-25T00:00:00", description="Household gas")
    reference = datetime(2026, 10, 20)

    [b_month] = _monthly(sw_db, b, a, reference, OCT, OCT)
    assert b_month == {"month": "2026-10", "kind": "current", "currencies": [
        {"currency": "PHP", "income": 1000.0, "expense": 150.0, "fees": 5.0,
         "moved_in": 500.0, "moved_out": 200.0, "paid_from_other_accounts": 0.0},
        {"currency": "USD", "income": 40.0, "expense": 0.0, "fees": 0.0,
         "moved_in": 0.0, "moved_out": 0.0, "paid_from_other_accounts": 0.0},
    ]}
    # C (tag viewer) never counts B's records: no "Moved in" from B's deposit.
    [c_month] = _monthly(sw_db, c, a, reference, OCT, OCT)
    assert c_month["currencies"][0] == {
        "currency": "PHP", "income": 1000.0, "expense": 150.0, "fees": 5.0,
        "moved_in": 0.0, "moved_out": 200.0, "paid_from_other_accounts": 0.0}
    assert sw_leaks(c_month, numbers=(500, 70.07)) == []


def test_monthly_endpoint_shape(hh, sw_client, sw_db):
    a, c = hh["a"], hh["c"]
    body = _get(sw_client, c, f"/household/{a['id']}/monthly?from=2026-09&to=2026-12")
    assert set(body) == {"sharer", "from", "to", "months"}
    assert (body["from"], body["to"]) == ("2026-09", "2026-12")
    assert [m["month"] for m in body["months"]] == ["2026-09", "2026-10", "2026-11", "2026-12"]
    assert all(m["kind"] in ("recorded", "current", "projected") for m in body["months"])


# --- Hidden loans and cards: no interest in the totals (plan §2) --------------------------------

def _loan_payment(client, hh, mode, when="2026-10-20T00:00:00"):
    posted, _ = MODES[mode]
    _transfer(client, hh["a"], hh["joint"], hh["a_loan"], 400, when, posted=posted,
              transfer_fee=50, description="Loan payment")


@pytest.mark.parametrize("mode", list(MODES))
def test_payment_into_a_hidden_loan_is_one_whole_expense(hh, sw_client, sw_db, mode):
    _loan_payment(sw_client, hh, mode)
    months = _monthly(sw_db, hh["c"], hh["a"], MODES[mode][1])
    lines = [(m["month"], line) for m in months for line in m["currencies"]]
    assert lines == [("2026-10", {"currency": "PHP", **dict.fromkeys(FIELDS, 0.0),
                                  "expense": 450.0})]


@pytest.mark.parametrize("mode", list(MODES))
def test_payment_into_a_visible_loan_keeps_its_fee(hh, sw_client, sw_db, mode):
    # A sees their own loan: the payment's principal and interest stay apart.
    _loan_payment(sw_client, hh, mode)
    months = _monthly(sw_db, hh["a"], hh["a"], MODES[mode][1])
    lines = [(m["month"], line) for m in months for line in m["currencies"]]
    assert lines == [("2026-10", {"currency": "PHP", **dict.fromkeys(FIELDS, 0.0),
                                  "expense": 400.0, "fees": 50.0})]


@pytest.mark.parametrize("viewer,expected", [
    ("c", {"expense": 450.0}), ("a", {"expense": 400.0, "fees": 50.0})])
def test_dashboard_month_hides_a_hidden_loans_interest(hh, sw_client, sw_db, viewer, expected):
    from app.core.time import naive_utc_now

    today = naive_utc_now().replace(hour=0, minute=0, second=0, microsecond=0)
    _transfer(sw_client, hh["a"], hh["joint"], hh["a_loan"], 400, today.isoformat(),
              posted=True, transfer_fee=50, description="Loan payment")
    body = _get(sw_client, hh[viewer], f"/household/{hh['a']['id']}/dashboard")
    assert body["month"]["currencies"] == [
        {"currency": "PHP", **dict.fromkeys(FIELDS, 0.0), **expected}]
    if viewer == "c":
        assert sw_leaks(body, numbers=(50,)) == []


# --- A posted charge on an open statement is left to the projection (owner ruling) ----------------

MIXED = datetime(2026, 10, 20)   # the charge is posted (October), its statement due November 5


def test_posted_bill_routed_to_joint_is_counted_once(hh, sw_client, sw_db):
    _put(sw_client, hh["a"], f"/accounts/{hh['a_card']}", {"payment_account_id": hh["joint"]})
    _charge(sw_client, hh, "recorded")
    months = _monthly(sw_db, hh["c"], hh["a"], MIXED)
    lines = [(m["month"], m["kind"], line) for m in months for line in m["currencies"]]
    assert lines == [("2026-11", "projected", {"currency": "PHP", **dict.fromkeys(FIELDS, 0.0),
                                               "expense": 100.0})]


@pytest.mark.parametrize("paid", [0, 40, 100])
def test_posted_charge_with_a_planned_joint_payment_is_counted_once(hh, sw_client, sw_db, paid):
    _charge(sw_client, hh, "recorded")
    if paid:
        _pay(sw_client, hh, paid, "projected")
    totals = _sum(_monthly(sw_db, hh["c"], hh["a"], MIXED))
    assert (totals["expense"], totals["paid_from_other_accounts"]) == (paid, 100.0 - paid)


def test_posted_charge_on_a_settled_statement_keeps_the_posted_rule(hh, sw_client, sw_db):
    # Settled by A's posted private payment: a later planned joint payment
    # pays the next statement, not this charge.
    _charge(sw_client, hh, "recorded")
    _transfer(sw_client, hh["a"], hh["a_private"], hh["a_card"], 100, "2026-10-16T00:00:00",
              posted=True)
    _pay(sw_client, hh, 100, "projected")
    totals = _sum(_monthly(sw_db, hh["c"], hh["a"], MIXED))
    assert (totals["expense"], totals["paid_from_other_accounts"]) == (100.0, 100.0)


# --- Upcoming items carry their own currency ----------------------------------------------------

def test_household_upcoming_items_carry_their_currency(hh, sw_client, sw_db):
    from datetime import timedelta

    from app.core.time import naive_utc_now
    from app.models.user import CurrencyType, User

    a, b = hh["a"], hh["b"]
    sw_db.get(User, a["id"]).default_currency = CurrencyType.EUR  # neither item's currency
    sw_db.commit()
    usd = sw_post(sw_client, a, "/accounts/", {
        "name": "Household dollars", "account_type": "savings", "balance": 500,
        "currency": "USD", "tag_ids": [hh["hh_a"]]})["id"]
    soon = (naive_utc_now() + timedelta(days=3)).replace(hour=0, minute=0, second=0,
                                                        microsecond=0)
    _txn(sw_client, a, usd, 25, soon.isoformat(), currency="USD", description="Dollar bill")
    _txn(sw_client, a, hh["joint"], 120, soon.isoformat(), description="Household rent")
    _txn(sw_client, b, hh["joint"], 30, soon.isoformat(), description="Bea gas")
    expected = {("Dollar bill", 25.0, "USD"), ("Household rent", 120.0, "PHP"),
                ("Bea gas", 30.0, "PHP")}
    for body in (_get(sw_client, a, f"/household/{a['id']}/upcoming")["items"],
                 _get(sw_client, a, f"/household/{a['id']}/dashboard")["upcoming"]):
        assert {(i["name"], i["amount"], i["currency"]) for i in body} == expected
    # A limited item keeps its own currency too (C sees A's records Limited).
    items = _get(sw_client, hh["c"], f"/household/{a['id']}/upcoming")["items"]
    assert {(i["display_name"], i["currency"]) for i in items} == {
        ("Dollar bill", "USD"), ("Household rent", "PHP")}
    # The ordinary upcoming list is unchanged: no currency on a full item.
    plain = _get(sw_client, a, "/forecast/upcoming")["items"]
    assert {i["name"] for i in plain} >= {"Dollar bill", "Household rent"}
    assert all("currency" not in i for i in plain if i.get("view") != "limited")
