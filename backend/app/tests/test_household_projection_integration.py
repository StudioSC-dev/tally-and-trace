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

from app.tests.conftest import API, PRIVATE, hh_household, sw_db_reachable, sw_leaks, sw_post

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


# --- Household coverage follows the statement engine's settlement order ---------------------------

def _card_entry(client, hh, amount, when, name="Household cable"):
    """A one-off Household charge scheduled on A's private card (a recurring entry)."""
    sw_post(client, hh["a"], "/budget-entries/", {
        "name": name, "entry_type": "expense", "amount": amount, "account_id": hh["a_card"],
        "next_occurrence": when, "end_date": "2026-10-31T00:00:00", "tag_ids": [hh["hh_a"]]})


def _monthly_totals(db, who, sharer):
    from app.services.household import household_monthly, household_view

    db.expire_all()
    grant = household_view(db, who["id"], sharer["id"])
    months = household_monthly(db, who["id"], grant, datetime(2026, 10, 1),
                               datetime(2026, 11, 1), reference=REF)
    out: dict = {}
    for month in months:
        for line in month["currencies"]:
            for k, v in line.items():
                if k != "currency":
                    out[k] = round(out.get(k, 0.0) + v, 2)
    return out


def test_a_recurring_household_charge_is_settled_after_the_transaction_rows(hh, sw_client,
                                                                           sw_db):
    # The engine settles the rows first: the joint payment pays the private
    # November charge, so the October Household charge stays payable on
    # November 5 from A's private bank, and is paid from other accounts.
    a, c = hh["a"], hh["c"]
    _txn(sw_client, a, hh["a_card"], 100, "2026-11-01T00:00:00", description=f"{PRIVATE} gift")
    _transfer(sw_client, a, hh["joint"], hh["a_card"], 100, "2026-10-20T00:00:00")
    _card_entry(sw_client, hh, 100, "2026-10-12T00:00:00")
    items = _household(_upcoming(sw_db, c))
    assert [(i["date"], i["face_amount"]) for i in items] == [("2026-10-12", 100.0)]
    totals = _monthly_totals(sw_db, c, a)
    assert (totals["expense"], totals["paid_from_other_accounts"]) == (100.0, 100.0)


def test_transaction_and_recurring_household_charges_in_the_engines_order(hh, sw_client, sw_db):
    # Rows: October 50 (Household), November 100 (private); the joint 120 pays
    # 50 of October and 70 of November. The October Household entry of 100 is
    # added after, so it is left whole.
    a, c = hh["a"], hh["c"]
    _txn(sw_client, a, hh["a_card"], 50, "2026-10-12T00:00:00", tags=[hh["hh_a"]],
         description="Household internet")
    _txn(sw_client, a, hh["a_card"], 100, "2026-11-01T00:00:00", description=f"{PRIVATE} gift")
    _transfer(sw_client, a, hh["joint"], hh["a_card"], 120, "2026-10-20T00:00:00")
    _card_entry(sw_client, hh, 100, "2026-10-13T00:00:00")
    items = _household(_upcoming(sw_db, c))
    assert [(i["date"], i["display_name"], i["face_amount"]) for i in items] == [
        ("2026-10-13", "Household cable", 100.0)]
    totals = _monthly_totals(sw_db, c, a)
    assert (totals["expense"], totals["paid_from_other_accounts"]) == (120.0, 100.0)


# --- A direct share and a tag share together: each occurrence once ------------------------------

def test_a_record_seen_directly_and_through_the_tag_share_appears_once(hh, sw_client, sw_db):
    from app.services.forecast import collect_events, project_running_balance
    from app.services.household import household_events, household_view
    from app.tests.conftest import sw_share

    a, c = hh["a"], hh["c"]
    sw_share(sw_db, hh["a_private"], c["id"], "viewer", a["id"])  # plus A's Household tag share
    _txn(sw_client, a, hh["a_private"], 25, "2026-10-12T00:00:00", tags=[hh["hh_a"]],
         description="Household groceries")
    sw_db.expire_all()

    def named(rows, key):
        return [r for r in rows if r.get(key) == "Household groceries"]

    # The normal views: an ordinary expense on an account C sees, once.
    [item] = named(_upcoming(sw_db, c), "display_name")
    assert (item["cash_delta"], item["kind"]) == (-25.0, "expense")
    [event] = named(collect_events(sw_db, REF, datetime(2026, 12, 9), user_id=c["id"]), "name")
    assert event["amount"] == Decimal("-25.00") and not event.get("household_occurrence")
    timeline = project_running_balance(sw_db, c["id"], days=60, reference=REF)
    assert len(named(timeline["events"], "name")) == 1
    # The Household view (the joint account only): a Household occurrence, once.
    grant = household_view(sw_db, c["id"], a["id"])
    [occ] = named(household_events(sw_db, c["id"], grant, REF, datetime(2026, 12, 9)), "name")
    assert occ["amount"] == 0 and occ["household_occurrence"] and occ["face_amount"] == 25


# --- A recorded occurrence on an account shared only through the tag share (STU-266) -----------

def _tag_shared_bill(client, hh):
    """A's checking account carrying A's Household tag (shared with C through the
    tag share, with no ``AccountShare``) and a monthly 500 bill on it, due 15 Oct
    and 15 Nov."""
    a = hh["a"]
    account = sw_post(client, a, "/accounts/", {
        "name": "Household checking", "account_type": "checking", "balance": 4_000,
        "tag_ids": [hh["hh_a"]]})["id"]
    entry = sw_post(client, a, "/budget-entries/", {
        "name": "Household water", "entry_type": "expense", "amount": 500,
        "account_id": account, "next_occurrence": "2026-10-15T00:00:00",
        "cadence": "monthly"})["id"]
    return account, entry


def _bill_days(db, who, end=datetime(2026, 11, 9)):
    from app.services.forecast import collect_events

    db.expire_all()
    return [(e["date"], e["amount"]) for e in collect_events(db, REF, end, user_id=who["id"])
            if e["source"] == "budget_entry" and e["name"] == "Household water"]


def _closing(db, who):
    from app.services.forecast import project_running_balance

    db.expire_all()
    return project_running_balance(db, who["id"], days=30, reference=REF)["closing_balance"]


def test_a_private_row_linked_to_a_tag_shared_entry_never_suppresses_the_viewers_occurrence(
        hh, sw_client, sw_db):
    # The 15 Oct row is on A's private, untagged bank, which C cannot read: C's
    # projection is unchanged by it, and the occurrence is still listed.
    a, c = hh["a"], hh["c"]
    _, entry = _tag_shared_bill(sw_client, hh)
    before = _closing(sw_db, c)
    assert _bill_days(sw_db, c) == [(datetime(2026, 10, 15), Decimal("-500.00"))]
    _txn(sw_client, a, hh["a_private"], 500, "2026-10-15T00:00:00",
         description=f"{PRIVATE} water", budget_entry_id=entry)
    assert _bill_days(sw_db, c) == [(datetime(2026, 10, 15), Decimal("-500.00"))]
    assert _closing(sw_db, c) == before
    # A's own view follows the same rule as for an AccountShare: the entry's
    # account is shared, so only a row on that account stands for an occurrence,
    # and A sees the occurrence next to the private row.
    assert _bill_days(sw_db, a) == [(datetime(2026, 10, 15), Decimal("-500.00"))]


def test_a_row_on_the_tag_shared_entrys_own_account_suppresses_for_viewer_and_owner(
        hh, sw_client, sw_db):
    a, c = hh["a"], hh["c"]
    account, entry = _tag_shared_bill(sw_client, hh)
    before = _closing(sw_db, c)
    _txn(sw_client, a, account, 500, "2026-10-15T00:00:00", description="Household water",
         budget_entry_id=entry)
    assert _bill_days(sw_db, c) == []
    assert _bill_days(sw_db, a) == []
    assert _closing(sw_db, c) == before  # the unposted row is the one movement


def test_a_linked_transfer_to_another_users_account_never_suppresses_the_viewers_occurrence(
        hh, sw_client, sw_db):
    # B gives A editor on B's bank; A records the 15 Oct bill as an unposted
    # transfer from the tag-shared account into it. The transfer touches B's
    # account, so C cannot read it (rule (b2) needs every touched account to be
    # A's): C's occurrence and closing balance stay as they were.
    from app.tests.conftest import sw_share

    a, c = hh["a"], hh["c"]
    account, entry = _tag_shared_bill(sw_client, hh)
    sw_share(sw_db, hh["b_private"], a["id"], "editor", hh["b"]["id"])
    before = _closing(sw_db, c)
    _transfer(sw_client, a, account, hh["b_private"], 500, "2026-10-15T00:00:00",
              description="Household water", budget_entry_id=entry)
    assert _bill_days(sw_db, c) == [(datetime(2026, 10, 15), Decimal("-500.00"))]
    assert _closing(sw_db, c) == before


def test_a_linked_transfer_on_an_unshared_entry_still_suppresses_the_occurrence(
        sw_client, sw_db, sw_people):
    # With no share at all the creator's row counts whatever its type or account.
    d = sw_people("Dan", "Solo")
    checking = sw_post(sw_client, d, "/accounts/", {
        "name": "Solo checking", "account_type": "checking", "balance": 4_000})["id"]
    savings = sw_post(sw_client, d, "/accounts/", {
        "name": "Solo savings", "account_type": "checking", "balance": 1_000})["id"]
    entry = sw_post(sw_client, d, "/budget-entries/", {
        "name": "Household water", "entry_type": "expense", "amount": 500,
        "account_id": checking, "next_occurrence": "2026-10-15T00:00:00",
        "cadence": "monthly"})["id"]
    assert _bill_days(sw_db, d) == [(datetime(2026, 10, 15), Decimal("-500.00"))]
    _transfer(sw_client, d, checking, savings, 500, "2026-10-15T00:00:00",
              description="Household water", budget_entry_id=entry)
    assert _bill_days(sw_db, d) == []


def test_the_household_view_keeps_a_tag_shared_occurrence_recorded_on_a_private_account(
        hh, sw_client, sw_db):
    from app.services.household import household_events, household_view

    a, c = hh["a"], hh["c"]
    _, entry = _tag_shared_bill(sw_client, hh)
    _txn(sw_client, a, hh["a_private"], 500, "2026-10-15T00:00:00",
         description=f"{PRIVATE} water", budget_entry_id=entry)
    sw_db.expire_all()
    grant = household_view(sw_db, c["id"], a["id"])
    events = household_events(sw_db, c["id"], grant, REF, datetime(2026, 11, 9))
    assert [(e["date"], e["amount"]) for e in events
            if e["source"] == "budget_entry" and e["name"] == "Household water"] == [
        (datetime(2026, 10, 15), Decimal("-500.00"))]


def test_a_tag_share_with_its_own_owner_does_not_count_as_sharing(sw_client, sw_db, sw_people):
    # The API refuses a self-share, the table does not. Nobody gains access from
    # it, so the owner's row on another account still stands for the occurrence,
    # exactly as with no share at all.
    from app.models.tag_share import TagShare

    d = sw_people("Dan", "Solo")
    tag = hh_household(sw_db, d)
    sw_db.add(TagShare(tag_id=tag, user_id=d["id"]))
    sw_db.commit()
    tagged = sw_post(sw_client, d, "/accounts/", {
        "name": "Solo checking", "account_type": "checking", "balance": 4_000,
        "tag_ids": [tag]})["id"]
    other = sw_post(sw_client, d, "/accounts/", {
        "name": "Solo savings", "account_type": "checking", "balance": 1_000})["id"]
    entry = sw_post(sw_client, d, "/budget-entries/", {
        "name": "Household water", "entry_type": "expense", "amount": 500,
        "account_id": tagged, "next_occurrence": "2026-10-15T00:00:00",
        "cadence": "monthly"})["id"]
    assert _bill_days(sw_db, d) == [(datetime(2026, 10, 15), Decimal("-500.00"))]
    _txn(sw_client, d, other, 500, "2026-10-15T00:00:00", description="Household water",
         budget_entry_id=entry)
    assert _bill_days(sw_db, d) == []
