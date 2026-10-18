"""Projections split by currency disclose nothing new (STU-236, plan G, criterion 9).

The Limited shapes are the epic's (``LimitedStatement`` may add ``incomplete``),
no Limited object carries an estimate field (G2), Limited values are today's
(the record's ``amount`` and ``currency``), and ``fx``, ``currencies`` and
``by_currency`` come only from viewable accounts and full rows. Each world is
walked over every G4 endpoint the caller can reach, clock frozen at
``FX_REF`` (2026-11-02), rate 58.00 PHP per USD.

``summary/period``'s ``household_private`` (STU-336) lists Household rule-(c)
debits in their record currency, as their Limited rows show it; it is not a
``by_currency``. No world here puts a row on it: the tag-share rows are pending
(one is on ``a_private``, out of scope, but pending).
"""
from datetime import datetime

import pytest

from app.tests.conftest import (
    API, hh_household, hh_tag_share, sw_db_reachable, sw_post, sw_share,
)
from app.tests.test_currency_projection_integration import _acct, _transfer, _txn
from app.tests.test_currency_projection_integration import frozen  # noqa: F401  (fixture)
from app.tests.test_shared_projection_integration import LIMITED_EVENT_KEYS
from app.tests.test_shared_redaction_integration import (
    LIMITED_BALANCE_KEYS, LIMITED_ENTRY_KEYS, LIMITED_SCHEDULE_KEYS, LIMITED_STATEMENT_KEYS,
    LIMITED_TRANSACTION_KEYS,
)

pytestmark = pytest.mark.skipif(not sw_db_reachable(), reason="no database available")

G2_FIELDS = {"original_amount", "original_currency", "rate", "rate_as_of", "rate_stale",
             "estimated", "unconverted", "received_amount", "unconverted_lines"}
LIMITED_SHAPES = [
    LIMITED_EVENT_KEYS, LIMITED_EVENT_KEYS | {"running_balance"}, LIMITED_TRANSACTION_KEYS,
    LIMITED_ENTRY_KEYS, LIMITED_BALANCE_KEYS, LIMITED_SCHEDULE_KEYS,
    {"view", "name", "currency", "statements"},  # the limited statements envelope
]


def _d(day, month=11):
    return datetime(2026, month, day)


# --- the walk -------------------------------------------------------------------------------

def _get(client, who, path, **params):
    r = client.get(f"{API}{path}", headers=who["headers"], params=params)
    assert r.status_code == 200, (path, r.status_code, r.text)
    return r.json()


def reach(client, who) -> dict:
    """Every G4 endpoint ``who`` can reach, by path."""
    bodies = {}

    def get(path, **params):
        bodies[path] = _get(client, who, path, **params)
        return bodies[path]

    get("/dashboard/snapshot")
    get("/forecast/timeline", days=60)
    get("/forecast/cashflow", months=3)
    get("/forecast/upcoming", days=60)
    get("/forecast/disposable")
    get("/transactions/summary/period", start_date="2026-10-01T00:00:00",
        end_date="2026-12-31T23:59:59")
    get("/transactions/", limit=500)
    for entry in get("/budget-entries/", limit=200)["items"]:
        get(f"/budget-entries/{entry['id']}")
    accounts = _get(client, who, "/accounts/", limit=1000)["items"]
    for account in accounts:
        get(f"/accounts/{account['id']}/balance")
        if account["account_type"] == "credit":
            get(f"/accounts/{account['id']}/statements")
    for view in get("/household/"):
        sharer = view["sharer_id"]
        get(f"/household/{sharer}/transactions")
        get(f"/household/{sharer}/upcoming", days=60)
        get(f"/household/{sharer}/monthly", **{"from": "2026-10", "to": "2026-12"})
        get(f"/household/{sharer}/dashboard")
    get("/data/export.json")
    return bodies


def limited_objects(node, path="$"):
    """Every Limited object in a JSON tree, with its path (statements by their envelope)."""
    if isinstance(node, dict):
        if node.get("view") == "limited":
            yield path, node
            if "statements" in node:
                for i, s in enumerate(node["statements"]):
                    yield f"{path}.statements[{i}]", s
        for k, v in node.items():
            yield from limited_objects(v, f"{path}.{k}")
    elif isinstance(node, list):
        for i, v in enumerate(node):
            yield from limited_objects(v, f"{path}[{i}]")


def keys_within(node):
    if isinstance(node, dict):
        for k, v in node.items():
            yield k
            yield from keys_within(v)
    elif isinstance(node, list):
        for v in node:
            yield from keys_within(v)


def check_shapes(bodies):
    """(a) every Limited object's key set is its epic shape; (b) none carries a G2 field."""
    seen = 0
    for path, body in bodies.items():
        for where, obj in limited_objects(body, path):
            seen += 1
            if ".statements[" in where:
                assert set(obj) in (LIMITED_STATEMENT_KEYS, LIMITED_STATEMENT_KEYS | {"incomplete"}), where
            else:
                assert set(obj) in LIMITED_SHAPES, (where, sorted(obj))
            assert not G2_FIELDS & set(keys_within(obj)), (where, obj)
    return seen


def limited_events(bodies, path):
    return [obj for _, obj in limited_objects(bodies[path]) if "public_id" in obj]


def no_usd_metadata(bodies):
    """(d) no USD pair in ``fx``, no USD in ``currencies`` or any ``by_currency``."""
    for path, body in bodies.items():
        if not isinstance(body, dict):
            continue
        for rate in (body.get("fx") or {}).get("rates", []):
            assert "USD" not in (rate["base"], rate["quote"]), path
        assert "USD" not in (body.get("currencies") or []), path
        stack = [body]
        while stack:
            node = stack.pop()
            if isinstance(node, dict):
                for row in node.get("by_currency") or []:
                    if isinstance(row, dict):
                        assert row.get("currency") != "USD", path
                stack.extend(node.values())
            elif isinstance(node, list):
                stack.extend(node)


# --- worlds ---------------------------------------------------------------------------------

@pytest.fixture
def world(sw_client, sw_db, sw_people, frozen):  # noqa: F811
    """X (the caller, PHP default) and Y (another user), with:

    - Y's PHP Joint, X an editor on it, and Y's hidden USD card paid from it (a
      posted USD 50 charge, statement due Nov 30);
    - Y's hidden USD account sending USD 100 into X's PHP bank, received
      PHP 5,800: one posted in October, one pending on Nov 9 (Y made both);
    - X's own pending PHP 5,800 to Y's hidden USD account, received USD 100.
    """
    db = sw_db
    x = sw_people("Xena", "Caller")
    y = sw_people("Yuri", "Hidden")
    hh_household(db, x)
    x_bank = _acct(db, x["id"], "X bank", "checking", "PHP", 20_000)
    joint = _acct(db, y["id"], "Y joint", "checking", "PHP", 30_000)
    y_usd = _acct(db, y["id"], "Y dollars", "savings", "USD", 2_000)
    y_card = _acct(db, y["id"], "Y dollar card", "credit", "USD", -50, billing_cycle_start=20,
                   days_until_due_date=10, payment_account_id=joint)
    sw_share(db, joint, x["id"], "editor", y["id"])
    _txn(db, y["id"], y_card, "debit", 50, _d(25, 10), "USD", posted=True,
         description="Y dollar charge")
    posted_in = _transfer(db, y["id"], y_usd, x_bank, 100, _d(20, 10), "USD", posted=True,
                          received_amount=5_800, description="Y dollars in")
    pending_in = _transfer(db, y["id"], y_usd, x_bank, 100, _d(9), "USD",
                           received_amount=5_800, description="Y dollars pending")
    pending_out = _transfer(db, x["id"], x_bank, y_usd, 5_800, _d(10), "PHP",
                            received_amount=100, description="X pesos out")
    return {"x": x, "y": y, "x_bank": x_bank, "joint": joint, "y_usd": y_usd,
            "y_card": y_card, "posted_in": posted_in, "pending_in": pending_in,
            "pending_out": pending_out}


def test_hidden_card_hidden_source_and_hidden_destination(sw_client, world):
    bodies = reach(sw_client, world["x"])
    assert check_shapes(bodies) > 0
    no_usd_metadata(bodies)
    assert bodies["/forecast/timeline"]["currencies"] == ["PHP"]

    # The hidden card's payment from the Joint: as today, its face is what the
    # visible leg moves (no statement total), in that leg's currency, so the
    # hidden card's own currency is never shown.
    for path in ("/forecast/upcoming", "/dashboard/snapshot", "/forecast/timeline"):
        cards = [e for e in limited_events(bodies, path) if e["kind"] == "card_payment"]
        assert cards and {(c["face_amount"], c["currency"], c["cash_delta"]) for c in cards} == {
            (2_900.0, "PHP", -2_900.0)}, path

    # The hidden source into X's bank: the record's USD 100, cash in PHP 5,800.
    (inbound,) = [e for e in limited_events(bodies, "/forecast/upcoming")
                  if e["date"] == "2026-11-09"]
    assert (inbound["face_amount"], inbound["currency"], inbound["cash_delta"]) == (
        100.0, "USD", 5_800.0)
    rows = {t["id"]: t for t in bodies["/transactions/"]["items"]}
    limited_in = rows[world["posted_in"]]
    assert limited_in["view"] == "limited"
    assert (limited_in["amount"], limited_in["currency"], limited_in["transfer_fee"]) == (
        100.0, "USD", 0.0)
    # X's own balance history moves by PHP 5,800 for the inbound transfer.
    history = bodies[f"/accounts/{world['x_bank']}/balance"]["balance_history"]
    (entry,) = [h for h in history if h["date"].startswith("2026-10-20")]
    assert (entry["view"], entry["amount"]) == ("limited", 5_800.0)

    # X's own transfer to the hidden USD account (Limited, as today: it touches an
    # account X can't view): the record's PHP 5,800, no USD anywhere.
    (out,) = [e for e in limited_events(bodies, "/forecast/upcoming")
              if e["date"] == "2026-11-10"]
    assert (out["face_amount"], out["currency"], out["cash_delta"]) == (5_800.0, "PHP", -5_800.0)
    # The PHP row of the timeline holds every one of them.
    php = bodies["/forecast/timeline"]["by_currency"]
    assert [r["currency"] for r in php] == ["PHP"]


@pytest.fixture
def tagged(sw_client, sw_db, sw_people, frozen):  # noqa: F811
    """T holds A's Household tag share. A's tagged PHP joint and USD account carry a
    pending cross-currency transfer (PHP 5,800, no received amount) and a pending
    JPY debit with no stored rate, both tagged Household."""
    db, client = sw_db, sw_client
    a = sw_people("Ana", "Sharer")
    t = sw_people("Tom", "Tagviewer")
    hh_household(db, t)
    hh_a = hh_household(db, a)
    hh_tag_share(db, a, t)
    joint = sw_post(client, a, "/accounts/", {
        "name": "A joint", "account_type": "checking", "currency": "PHP", "balance": 10_000,
        "tag_ids": [hh_a]})["id"]
    usd = sw_post(client, a, "/accounts/", {
        "name": "A dollars", "account_type": "savings", "currency": "USD", "balance": 500,
        "tag_ids": [hh_a]})["id"]
    move = sw_post(client, a, "/transactions/", {
        "account_id": joint, "transfer_from_account_id": joint, "transfer_to_account_id": usd,
        "transaction_type": "transfer", "amount": 5_800, "currency": "PHP",
        "transaction_date": "2026-11-09T00:00:00", "is_posted": False,
        "description": "Tagged move", "tag_ids": [hh_a]})["id"]
    yen = sw_post(client, a, "/transactions/", {
        "account_id": joint, "transaction_type": "debit", "amount": 1_000, "currency": "PHP",
        "projected_amount": 1_000, "projected_currency": "JPY",
        "transaction_date": "2026-11-12T00:00:00", "is_posted": False,
        "description": "Tagged yen", "tag_ids": [hh_a]})["id"]
    return {"a": a, "t": t, "joint": joint, "usd": usd, "move": move, "yen": yen}


def test_a_tag_viewer_on_a_cross_currency_transfer(sw_client, tagged):
    bodies = reach(sw_client, tagged["t"])
    assert check_shapes(bodies) > 0
    # Limited rows never add a pair or count as unconverted.
    for path in ("/forecast/timeline", "/forecast/upcoming", "/forecast/cashflow",
                 "/dashboard/snapshot"):
        assert bodies[path]["fx"] == {"rates": [], "unconverted_count": 0}, path

    # One limited row per currency, each at today's face (the record's PHP 5,800).
    moves = [e for e in limited_events(bodies, "/forecast/upcoming")
             if e["date"] == "2026-11-09"]
    assert sorted((e["face_amount"], e["currency"], e["cash_delta"]) for e in moves) == [
        (5_800.0, "PHP", -5_800.0), (5_800.0, "PHP", 100.0)]
    # (f) The unconverted limited item: no new keys, no cash.
    (yen,) = [e for e in limited_events(bodies, "/forecast/upcoming")
              if e["date"] == "2026-11-12"]
    assert set(yen) == LIMITED_EVENT_KEYS
    assert (yen["cash_delta"], yen["face_amount"], yen["currency"]) == (0.0, 1_000.0, "PHP")


def test_household_occurrences_without_a_leg(hh, sw_client, frozen):  # noqa: F811
    """A's Household occurrences outside C's view scope: a pending debit on A's
    private bank and an accountless USD entry. (e) Each is a limited item with
    no cash, in its record's currency at today's figure (nothing covers them)."""
    client = sw_client
    sw_post(client, hh["a"], "/transactions/", {
        "account_id": hh["a_private"], "transaction_type": "debit", "amount": 20,
        "currency": "PHP", "projected_amount": 20, "projected_currency": "USD",
        "transaction_date": "2026-11-06T00:00:00", "is_posted": False,
        "description": "Private bill", "tag_ids": [hh["hh_a"]]})
    sw_post(client, hh["a"], "/budget-entries/", {
        "name": "Accountless bill", "entry_type": "expense", "amount": 30, "currency": "USD",
        "next_occurrence": "2026-11-07T00:00:00", "end_mode": "after_occurrences",
        "max_occurrences": 1, "tag_ids": [hh["hh_a"]]})

    bodies = reach(sw_client, hh["c"])
    assert check_shapes(bodies) > 0
    path = f"/household/{hh['a']['id']}/upcoming"
    items = {i["display_name"]: i for i in bodies[path]["items"] if i.get("view") == "limited"}
    assert (items["Private bill"]["cash_delta"], items["Private bill"]["face_amount"],
            items["Private bill"]["currency"]) == (0.0, 20.0, "PHP")
    assert (items["Accountless bill"]["cash_delta"], items["Accountless bill"]["face_amount"],
            items["Accountless bill"]["currency"]) == (0.0, 30.0, "USD")
    months = bodies[f"/household/{hh['a']['id']}/monthly"]["months"]
    (nov,) = [m for m in months if m["month"] == "2026-11"]
    paid = {line["currency"]: line["paid_from_other_accounts"] for line in nov["currencies"]}
    assert paid == {"PHP": 20.0, "USD": 30.0}
