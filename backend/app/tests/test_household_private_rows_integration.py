"""Household-tagged rows on a member's private accounts in the period summary (STU-336).

Owner rule (2026-10-17): anything tagged Household stops being private to the
household, even in a private account; the rest of that account stays private.
C reads such a row through rule (c). ``summary/period`` lists those posted debits
on their own line, ``household_private``, in each record's currency (as the
Limited row shows it), by category, and never adds them into ``summary``,
``category_breakdown`` or ``by_currency``. Nothing about the hidden account is
read or shown.

Uses the ``hh`` world (``conftest.py``): A owner, B editor on A's joint account
(tagged with A's Household tag), C holding A's and B's Household tag shares.
"""
import pytest

from app.tests.conftest import API, PRIVATE, sw_db_reachable, sw_leaks, sw_post, sw_share

pytestmark = pytest.mark.skipif(not sw_db_reachable(), reason="DATABASE_URL not reachable")

DAY = "2026-10-01T00:00:00"
RANGE = {"start_date": "2026-09-01T00:00:00", "end_date": "2026-10-31T23:59:59"}
LINE_KEYS = {"currency", "total_expenses", "transaction_count", "category_breakdown"}

# Sentinels: never anywhere in C's summary.
UNTAGGED_DEBIT, UNTAGGED_CREDIT, HH_CREDIT = 77.71, 313.31, 444.41
LOAN_FEE, LOAN_PRINCIPAL, FX_SENT, FX_RECEIVED = 12.34, 501.23, 33.17, 1_861.17
SENTINELS = (UNTAGGED_DEBIT, UNTAGGED_CREDIT, HH_CREDIT, LOAN_FEE, LOAN_PRINCIPAL, FX_SENT,
             FX_RECEIVED)


def _get(client, who, path, **params):
    r = client.get(f"{API}{path}", headers=who["headers"], params=params)
    assert r.status_code == 200, (path, r.status_code, r.text)
    return r.json()


def _summary(client, who, **params):
    return _get(client, who, "/transactions/summary/period", **{**RANGE, **params})


def _list(client, who, **params):
    return _get(client, who, "/transactions/", limit=500, **{**RANGE, **params})["items"]


def _category(client, who, name):
    return sw_post(client, who, "/categories/", {"name": name})["id"]


def _txn(client, who, account, amount, kind="debit", tags=(), category=None, posted=True,
         **extra):
    body = {"account_id": account, "amount": amount, "transaction_type": kind,
            "description": "Spend", "transaction_date": DAY, "is_posted": posted,
            "tag_ids": list(tags), **extra}
    if category is not None:
        body["category_id"] = category
    return sw_post(client, who, "/transactions/", body)["id"]


def _transfer(client, who, frm, to, amount, tags=(), **extra):
    return _txn(client, who, frm, amount, kind="transfer", tags=tags,
                transfer_from_account_id=frm, transfer_to_account_id=to, **extra)


def _usd_account(client, who):
    return sw_post(client, who, "/accounts/", {
        "name": f"{PRIVATE} dollars", "account_type": "checking", "balance": 2_000,
        "currency": "USD"})["id"]


def _without_line(body):
    return {k: v for k, v in body.items() if k != "household_private"}


def _line(body, currency="PHP"):
    rows = [r for r in body["household_private"] if r["currency"] == currency]
    assert len(rows) <= 1
    return rows[0] if rows else None


def _php(body):
    return next(r for r in body["by_currency"] if r["currency"] == "PHP")


@pytest.fixture
def utilities(hh, sw_client):
    return _category(sw_client, hh["a"], "Utilities")


@pytest.fixture
def private_world(hh, sw_client, utilities):
    """A's rule-(c) rows of every kind (I1, I4-I6) and the sentinels, none of them
    in C's scope; in-scope rows on the joint and C's own account for the totals."""
    client, a = sw_client, hh["a"]
    usd = _usd_account(client, a)
    hh_a = [hh["hh_a"]]
    hidden = _category(client, a, f"{PRIVATE} pharmacy")
    return {
        "usd": usd,
        "hh": _txn(client, a, hh["a_private"], 55.55, tags=hh_a, category=utilities),
        "hh_usd": _txn(client, a, usd, 20, tags=hh_a, currency="USD"),
        "pending": _txn(client, a, hh["a_private"], 9.99, tags=hh_a, posted=False),
        "fx": _transfer(client, a, usd, hh["a_private"], FX_SENT, tags=hh_a,
                        received_amount=FX_RECEIVED),
        "loan": _transfer(client, a, hh["a_private"], hh["a_loan"], LOAN_PRINCIPAL, tags=hh_a,
                          transfer_fee=LOAN_FEE),
        "hh_credit": _txn(client, a, hh["a_private"], HH_CREDIT, kind="credit", tags=hh_a,
                          category=utilities),
        "untagged": _txn(client, a, hh["a_private"], UNTAGGED_DEBIT, category=utilities),
        "untagged_credit": _txn(client, a, hh["a_private"], UNTAGGED_CREDIT, kind="credit"),
        "hidden_category": _txn(client, a, hh["a_private"], 3.21, category=hidden),
    }


def _in_scope_rows(hh, client, utilities):
    """Rows C counts in its totals: A on the joint account, C's own spending."""
    _txn(client, hh["a"], hh["joint"], 120, category=utilities)
    _txn(client, hh["c"], hh["c_private"], 15)
    _txn(client, hh["c"], hh["c_private"], 40, kind="credit")


# --- Commit 1: the summary line ------------------------------------------------------------

def test_i1_a_household_debit_on_a_private_account_is_its_own_line(hh, sw_client, utilities):
    _txn(sw_client, hh["a"], hh["a_private"], 55.55, tags=[hh["hh_a"]], category=utilities)
    body = _summary(sw_client, hh["c"])
    assert body["household_private"] == [{"currency": "PHP", "total_expenses": 55.55,
                                          "transaction_count": 1,
                                          "category_breakdown": {"Utilities": 55.55}}]


def test_i2_totals_are_unchanged_by_rule_c_rows(hh, sw_client, utilities):
    _in_scope_rows(hh, sw_client, utilities)
    before = _summary(sw_client, hh["c"])
    assert before["household_private"] == []
    client, a = sw_client, hh["a"]
    usd, hh_a = _usd_account(client, a), [hh["hh_a"]]
    _txn(client, a, hh["a_private"], 55.55, tags=hh_a, category=utilities)
    _txn(client, a, usd, 20, tags=hh_a, currency="USD")
    _txn(client, a, hh["a_private"], 9.99, tags=hh_a, posted=False)
    _transfer(client, a, usd, hh["a_private"], FX_SENT, tags=hh_a, received_amount=FX_RECEIVED)
    _transfer(client, a, hh["a_private"], hh["a_loan"], LOAN_PRINCIPAL, tags=hh_a,
              transfer_fee=LOAN_FEE)
    _txn(client, a, hh["a_private"], HH_CREDIT, kind="credit", tags=hh_a)
    after = _summary(sw_client, hh["c"])
    assert _without_line(after) == _without_line(before)
    assert [r["currency"] for r in after["household_private"]] == ["PHP", "USD"]
    for who in (hh["a"], hh["b"]):
        assert _summary(sw_client, who)["household_private"] == []


def test_i3_the_line_leaks_nothing_about_the_hidden_accounts(hh, sw_client, private_world):
    body = _summary(sw_client, hh["c"])
    private_ids = [hh["a_private"], hh["a_card"], hh["a_loan"], hh["a_wallet"],
                   private_world["usd"]]
    assert sw_leaks(body, private_ids=private_ids, numbers=SENTINELS) == []
    assert PRIVATE not in str(body)
    assert body["household_private"]
    for row in body["household_private"]:
        assert set(row) == LINE_KEYS


def test_i4_each_row_counts_in_its_record_currency(hh, sw_client, utilities):
    client, a, c = sw_client, hh["a"], hh["c"]
    _in_scope_rows(hh, client, utilities)
    before = _summary(client, c)
    usd = _usd_account(client, a)
    row = _txn(client, a, usd, 20, tags=[hh["hh_a"]], currency="USD")
    body = _summary(client, c)
    assert _line(body, "USD") == {"currency": "USD", "total_expenses": 20.0,
                                  "transaction_count": 1,
                                  "category_breakdown": {"Uncategorized": 20.0}}
    assert "USD" not in [r["currency"] for r in body["by_currency"]]
    assert _php(body) == _php(before)
    listed = _get(client, c, f"/transactions/{row}")
    assert listed["currency"] == "USD" and listed["account"]["id"] is None


def test_i4_a_deleted_category_is_uncategorized_as_on_the_limited_row(hh, sw_client):
    client, a, c = sw_client, hh["a"], hh["c"]
    gone = _category(client, a, "Old bills")
    row = _txn(client, a, hh["a_private"], 6.5, tags=[hh["hh_a"]], category=gone)
    assert _line(_summary(client, c))["category_breakdown"] == {"Old bills": 6.5}
    r = client.delete(f"{API}/categories/{gone}", headers=a["headers"])
    assert r.status_code == 200, r.text
    assert _line(_summary(client, c))["category_breakdown"] == {"Uncategorized": 6.5}
    assert _get(client, c, f"/transactions/{row}")["category_name"] is None


def test_i5_transfers_between_private_accounts_are_absent(hh, sw_client, utilities):
    client, a, c = sw_client, hh["a"], hh["c"]
    _in_scope_rows(hh, client, utilities)
    before = _summary(client, c)
    usd, hh_a = _usd_account(client, a), [hh["hh_a"]]
    fx = _transfer(client, a, usd, hh["a_private"], FX_SENT, tags=hh_a,
                   received_amount=FX_RECEIVED)
    loan = _transfer(client, a, hh["a_private"], hh["a_loan"], LOAN_PRINCIPAL, tags=hh_a,
                     transfer_fee=LOAN_FEE)
    readable = {t["id"] for t in _list(client, c)}
    assert {fx, loan} <= readable  # rule (c) reads them; the line still skips them
    after = _summary(client, c)
    assert after == before
    assert sw_leaks(after, numbers=SENTINELS) == []


def test_i6_a_pending_debit_counts_once_posted(hh, sw_client):
    client, a, c = sw_client, hh["a"], hh["c"]
    row = _txn(client, a, hh["a_private"], 9.99, tags=[hh["hh_a"]], posted=False)
    assert _summary(client, c)["household_private"] == []
    r = client.put(f"{API}/transactions/{row}", json={"is_posted": True}, headers=a["headers"])
    assert r.status_code == 200, r.text
    assert _line(_summary(client, c))["total_expenses"] == 9.99


def test_i7_revoking_a_share_drops_only_that_sharers_rows(hh, sw_client, sw_db):
    from app.models.tag_share import TagShare

    client, c = sw_client, hh["c"]
    _txn(client, hh["a"], hh["a_private"], 55.55, tags=[hh["hh_a"]])
    _txn(client, hh["b"], hh["b_private"], 8.25, tags=[hh["hh_b"]])
    assert _line(_summary(client, c))["total_expenses"] == 63.8
    sw_db.query(TagShare).filter(TagShare.id == hh["a_to_c"]).delete()
    sw_db.commit()
    assert _line(_summary(client, c)) == {"currency": "PHP", "total_expenses": 8.25,
                                         "transaction_count": 1,
                                         "category_breakdown": {"Uncategorized": 8.25}}


def test_i8_an_account_id_never_reaches_the_line(hh, sw_client, utilities):
    client, c = sw_client, hh["c"]
    _txn(client, hh["a"], hh["a_private"], 55.55, tags=[hh["hh_a"]], category=utilities)
    _txn(client, hh["a"], hh["joint"], 120, category=utilities)
    hidden = _summary(client, c, account_id=hh["a_private"])
    assert hidden == _summary(client, c, account_id=2_000_000_000)
    assert hidden["household_private"] == []
    assert _summary(client, c, account_id=hh["joint"])["household_private"] == []


def test_i9_a_row_counts_in_exactly_one_place(hh, sw_client, sw_db, utilities):
    client, c = sw_client, hh["c"]
    _txn(client, hh["a"], hh["a_private"], 55.55, tags=[hh["hh_a"]], category=utilities)
    before = _summary(client, c)
    assert "Utilities" not in _php(before)["category_breakdown"]
    assert _line(before)["category_breakdown"] == {"Utilities": 55.55}
    sw_share(sw_db, hh["a_private"], c["id"], "viewer", hh["a"]["id"])
    after = _summary(client, c)
    assert after["household_private"] == []
    assert _php(after)["category_breakdown"]["Utilities"] == {"income": 0.0, "expenses": 55.55}


def test_i10_the_line_matches_the_listed_rows(hh, sw_client, private_world):
    client, c = sw_client, hh["c"]
    _txn(client, hh["b"], hh["b_private"], 8.25, tags=[hh["hh_b"]])
    _txn(client, c, hh["c_private"], 15)
    rows = _list(client, c)
    def neutral(t):
        return t["view"] == "limited" and (t["account"] is None or t["account"]["id"] is None)

    # C has no rule-(a) neutral rows: its own rows are on its own accounts.
    assert not any(neutral(t) for t in rows if t["created_by"] == "Cal T.")
    sharers = {"Alice O.", "Bea P."}
    listed: dict = {}
    for t in rows:
        if (t["transaction_type"] == "debit" and t["is_posted"] and neutral(t)
                and t["created_by"] in sharers):
            listed[t["currency"]] = listed.get(t["currency"], 0) + t["amount"]
    line = {r["currency"]: r["total_expenses"] for r in _summary(client, c)["household_private"]}
    assert set(line) == set(listed) == {"PHP", "USD"}
    for currency, total in line.items():
        assert round(listed[currency], 2) == pytest.approx(total)


def test_i11_the_tag_filter_applies_to_the_line(hh, sw_client, utilities):
    client, c = sw_client, hh["c"]
    _txn(client, hh["a"], hh["a_private"], 55.55, tags=[hh["hh_a"]], category=utilities)
    assert _line(_summary(client, c, tag=hh["hh_a"]))["total_expenses"] == 55.55
    assert _summary(client, c, tag=hh["hh_c"])["household_private"] == []


def test_i12_wallet_logic_is_untouched_and_the_line_is_not_additive(hh, sw_client):
    """A tops up a Household wallet C views and pays the private card from it; the
    card's Household debit is on the line, the top-up stays wallet spend."""
    client, a, c = sw_client, hh["a"], hh["c"]
    gcash = sw_post(client, a, "/accounts/", {
        "name": "Household GCash", "account_type": "checking", "balance": 0,
        "is_spending_wallet": True, "tag_ids": [hh["hh_a"]]})["id"]
    _transfer(client, a, hh["joint"], gcash, 1_000)
    _transfer(client, a, gcash, hh["a_card"], 1_000)
    before = _summary(client, c)
    assert _php(before)["total_expenses"] == 1_000.0
    assert before["household_private"] == []
    _txn(client, a, hh["a_card"], 1_000, tags=[hh["hh_a"]])
    after = _summary(client, c)
    assert _without_line(after) == _without_line(before)
    assert _line(after) == {"currency": "PHP", "total_expenses": 1_000.0,
                            "transaction_count": 1,
                            "category_breakdown": {"Uncategorized": 1_000.0}}
