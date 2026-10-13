"""Posting a foreign figure needs the actual figure (STU-236, plan F1-F3).

A pending foreign purchase is stored the way the web form writes it: ``amount``
= ``projected_amount`` = the foreign figure, ``projected_currency`` = the foreign
currency and ``currency`` = the account's. Its face currency is
``projected_currency`` (else ``currency``) and its face figure ``projected_amount``
(else ``amount``). When such a row is posted, or a recurring entry in another
currency is materialised, the caller must send the figure the account actually
moved by, in the account's currency; the face figure stays in ``projected_*``
and the server fills ``original_*`` and ``exchange_rate``. Reverting leaves the
posted ``amount`` alone. The account owner exemption may carry that one figure
and nothing else.
"""
from decimal import Decimal

import pytest

from app.tests.conftest import API, sw_db_reachable, sw_post, sw_share

pytestmark = pytest.mark.skipif(not sw_db_reachable(), reason="no database available")

DAY = "2026-11-08T00:00:00"
FOREIGN_POST = "Enter the amount in PHP to post this foreign purchase"


# --- helpers ------------------------------------------------------------------------------

def _balance(db, account_id) -> Decimal:
    from app.models.account import Account

    db.expire_all()
    return Decimal(str(db.get(Account, account_id).balance))


def _row(db, txn_id):
    from app.models.transaction import Transaction

    db.expire_all()
    return db.get(Transaction, txn_id)


def _account(client, who, name, currency, balance=0, **extra):
    return sw_post(client, who, "/accounts/", {
        "name": name, "account_type": "checking", "currency": currency,
        "balance": balance, **extra})["id"]


def _put(client, who, txn_id, body):
    return client.put(f"{API}/transactions/{txn_id}", json=body, headers=who["headers"])


def _pending_foreign(client, who, account, amount=80, currency="USD"):
    """The form's pending foreign purchase: amount = projected = the foreign figure."""
    return sw_post(client, who, "/transactions/", {
        "account_id": account, "transaction_type": "debit", "amount": amount,
        "currency": "PHP", "projected_amount": amount, "projected_currency": currency,
        "description": "Foreign purchase", "transaction_date": DAY, "is_posted": False})["id"]


def _pending_local(client, who, account, amount=500):
    return sw_post(client, who, "/transactions/", {
        "account_id": account, "transaction_type": "debit", "amount": amount,
        "description": "Local purchase", "transaction_date": DAY, "is_posted": False})["id"]


def _pending_transfer(client, who, src, dst, amount, **extra):
    return sw_post(client, who, "/transactions/", {
        "account_id": src, "transfer_from_account_id": src, "transfer_to_account_id": dst,
        "transaction_type": "transfer", "amount": amount, "transaction_date": DAY,
        "is_posted": False, **extra})["id"]


def _entry(client, who, account, amount, currency, **extra):
    return sw_post(client, who, "/budget-entries/", {
        "name": "Recurring", "entry_type": "expense", "amount": amount, "currency": currency,
        "next_occurrence": "2026-11-12T00:00:00", "account_id": account, **extra})


def _forecast_row(client, who, txn_id):
    """The pending row's upcoming item (a year ahead), as ``who`` sees it."""
    r = client.get(f"{API}/forecast/upcoming", params={"days": 365}, headers=who["headers"])
    assert r.status_code == 200, r.text
    (item,) = [i for i in r.json()["items"]
               if i.get("source") == "transaction" and i.get("source_id") == txn_id]
    return item


def _assert_reestimated(client, who, txn_id):
    """After a revert the forecast re-estimates from the face (USD 80 at 58.00), never
    from the retained amount (4,700 read as USD would be 272,600)."""
    item = _forecast_row(client, who, txn_id)
    assert (item["amount"], item["currency"], item["estimated"], item["original_amount"],
            item["original_currency"], item["rate"]) == (4_640.0, "PHP", True, 80.0, "USD", 58.0)


def _materialize(client, who, entry_id, body):
    return client.post(f"{API}/budget-entries/{entry_id}/materialize", json=body,
                       headers=who["headers"])


@pytest.fixture
def fp(sw_client, sw_db, sw_people):
    """Owner A: PHP Checking 50,000, PHP Savings 10,000, USD Savings 1,000.

    B is an editor and V a viewer on PHP Checking and USD Savings; C is an editor
    on all three, and is the creator whose access the matrix tests take away.
    """
    client, db = sw_client, sw_db
    a = sw_people("Ana", "Owner")
    b = sw_people("Ben", "Editor")
    v = sw_people("Val", "Viewer")
    c = sw_people("Cy", "Creator")
    php = _account(client, a, "PHP Checking", "PHP", 50_000)
    php_sav = _account(client, a, "PHP Savings", "PHP", 10_000)
    usd = _account(client, a, "USD Savings", "USD", 1_000)
    shares = {}
    for account in (php, usd):
        sw_share(db, account, b["id"], "editor", a["id"])
        sw_share(db, account, v["id"], "viewer", a["id"])
    for account in (php, php_sav, usd):
        shares[account] = sw_share(db, account, c["id"], "editor", a["id"])
    return {"a": a, "b": b, "v": v, "c": c, "php": php, "php_sav": php_sav, "usd": usd,
            "c_shares": shares}


def _revoke_c(db, fp):
    """C loses access to every account of A's."""
    from app.models.account_share import AccountShare

    for share_id in fp["c_shares"].values():
        db.delete(db.get(AccountShare, share_id))
    db.commit()


# --- F1: materialise -----------------------------------------------------------------------

def test_materialising_a_foreign_entry_needs_the_amount_charged(sw_client, sw_db, fp):
    client, db, a = sw_client, sw_db, fp["a"]
    entry = _entry(client, a, fp["php"], 20, "USD")

    r = _materialize(client, a, entry["id"], {})
    assert r.status_code == 400, r.text
    assert r.json()["detail"] == "Enter the amount charged in PHP"
    assert _balance(db, fp["php"]) == Decimal("50000.00")
    r = client.get(f"{API}/budget-entries/{entry['id']}", headers=a["headers"])
    assert r.json()["next_occurrence"] == entry["next_occurrence"]

    r = _materialize(client, a, entry["id"], {"amount": 1_180})
    assert r.status_code == 201, r.text
    body = r.json()
    assert (body["amount"], body["currency"]) == (1_180, "PHP")
    assert (body["projected_amount"], body["projected_currency"]) == (20, "USD")
    assert (body["original_amount"], body["original_currency"]) == (20, "USD")
    assert _row(db, body["id"]).exchange_rate == Decimal("59.000000")
    assert _balance(db, fp["php"]) == Decimal("48820.00")


def test_a_transfer_entry_follows_the_rule_on_its_source_side(sw_client, sw_db, fp):
    client, db, a = sw_client, sw_db, fp["a"]
    entry = _entry(client, a, fp["php"], 100, "USD", transfer_to_account_id=fp["php_sav"])

    r = _materialize(client, a, entry["id"], {})
    assert r.status_code == 400, r.text
    assert r.json()["detail"] == "Enter the amount charged in PHP"

    r = _materialize(client, a, entry["id"], {"amount": 5_850})
    assert r.status_code == 201, r.text
    body = r.json()
    assert (body["amount"], body["currency"], body["received_amount"]) == (5_850, "PHP", None)
    assert (body["original_amount"], body["original_currency"]) == (100, "USD")
    assert _row(db, body["id"]).exchange_rate == Decimal("58.500000")
    assert _balance(db, fp["php"]) == Decimal("44150.00")
    assert _balance(db, fp["php_sav"]) == Decimal("15850.00")


def test_a_cross_currency_transfer_entry_needs_the_amount_received(sw_client, sw_db, fp):
    client, db, a = sw_client, sw_db, fp["a"]
    entry = _entry(client, a, fp["usd"], 500, "USD", transfer_to_account_id=fp["php"])
    r = _materialize(client, a, entry["id"], {})
    assert r.status_code == 400, r.text
    assert r.json()["detail"] == "Enter the amount received"
    assert _balance(db, fp["usd"]) == Decimal("1000.00")


def test_a_same_currency_transfer_entry_is_unchanged(sw_client, sw_db, fp):
    client, db, a = sw_client, sw_db, fp["a"]
    entry = _entry(client, a, fp["php"], 5_000, "PHP", transfer_to_account_id=fp["php_sav"])
    r = _materialize(client, a, entry["id"], {})
    assert r.status_code == 201, r.text
    body = r.json()
    assert (body["amount"], body["currency"], body["received_amount"]) == (5_000, "PHP", None)
    assert body["projected_amount"] is None and body["original_amount"] is None
    assert body["exchange_rate"] is None
    assert _balance(db, fp["php"]) == Decimal("45000.00")
    assert _balance(db, fp["php_sav"]) == Decimal("15000.00")


def test_a_same_currency_entry_posts_its_own_amount(sw_client, sw_db, fp):
    client, db, a = sw_client, sw_db, fp["a"]
    entry = _entry(client, a, fp["php"], 25_000, "PHP")
    r = _materialize(client, a, entry["id"], {})
    assert r.status_code == 201, r.text
    body = r.json()
    assert (body["amount"], body["currency"], body["exchange_rate"]) == (25_000, "PHP", None)
    assert _balance(db, fp["php"]) == Decimal("25000.00")


# --- F2: provenance through post, revert and repost ----------------------------------------

@pytest.mark.parametrize("actor", ["owner", "editor"])
def test_post_revert_repost_keeps_the_face_figure(sw_client, sw_db, fp, actor):
    """The Nov 8 debit (projected USD 80) on PHP Checking."""
    client, db = sw_client, sw_db
    who = fp["a"] if actor == "owner" else fp["b"]
    txn = _pending_foreign(client, fp["a"], fp["php"])

    r = _put(client, who, txn, {"is_posted": True, "amount": 4_700})
    assert r.status_code == 200, r.text
    assert _balance(db, fp["php"]) == Decimal("45300.00")
    row = _row(db, txn)
    assert (row.amount, row.currency.value) == (Decimal("4700.00"), "PHP")
    assert (row.original_amount, row.original_currency.value) == (Decimal("80.00"), "USD")
    assert (row.projected_amount, row.projected_currency.value) == (Decimal("80.00"), "USD")
    assert row.exchange_rate == Decimal("58.750000")

    # Status-only revert: the balance is restored, the posted amount is kept.
    r = _put(client, who, txn, {"is_posted": False})
    assert r.status_code == 200, r.text
    assert _balance(db, fp["php"]) == Decimal("50000.00")
    row = _row(db, txn)
    assert row.is_posted is False
    assert row.amount == Decimal("4700.00")
    assert row.projected_amount == Decimal("80.00")
    _assert_reestimated(client, who, txn)

    # Repost with another actual figure: the face figure still drives the rate.
    r = _put(client, who, txn, {"is_posted": True, "amount": 4_650})
    assert r.status_code == 200, r.text
    assert _balance(db, fp["php"]) == Decimal("45350.00")
    row = _row(db, txn)
    assert row.amount == Decimal("4650.00")
    assert (row.original_amount, row.original_currency.value) == (Decimal("80.00"), "USD")
    assert row.exchange_rate == Decimal("58.125000")


def test_a_currency_only_foreign_face_survives_a_modal_post(sw_client, sw_db, fp):
    """A pending USD 80 with no ``projected_*`` on PHP Checking, posted as the
    web modal posts it (``currency`` normalised to the account's): the stored
    face is kept in ``projected_*``, so after a revert the forecast still
    re-estimates USD 80 (PHP 4,640), never reads the retained 4,700 as PHP."""
    client, db, a = sw_client, sw_db, fp["a"]
    txn = sw_post(client, a, "/transactions/", {
        "account_id": fp["php"], "transaction_type": "debit", "amount": 80,
        "currency": "USD", "description": "Foreign purchase", "transaction_date": DAY,
        "is_posted": False})["id"]
    assert _row(db, txn).projected_amount is None

    r = _put(client, a, txn, {"is_posted": True, "amount": 4_700, "currency": "PHP"})
    assert r.status_code == 200, r.text
    assert _balance(db, fp["php"]) == Decimal("45300.00")
    row = _row(db, txn)
    assert (row.amount, row.currency.value) == (Decimal("4700.00"), "PHP")
    assert (row.projected_amount, row.projected_currency.value) == (Decimal("80.00"), "USD")
    assert (row.original_amount, row.original_currency.value) == (Decimal("80.00"), "USD")
    assert row.exchange_rate == Decimal("58.750000")

    r = _put(client, a, txn, {"is_posted": False})
    assert r.status_code == 200, r.text
    assert _balance(db, fp["php"]) == Decimal("50000.00")
    _assert_reestimated(client, a, txn)


def test_a_client_rate_and_original_are_kept(sw_client, sw_db, fp):
    client, db, a = sw_client, sw_db, fp["a"]
    txn = _pending_foreign(client, a, fp["php"])
    r = _put(client, a, txn, {"is_posted": True, "amount": 4_700, "exchange_rate": 58.7})
    assert r.status_code == 200, r.text
    row = _row(db, txn)
    assert row.exchange_rate == Decimal("58.700000")
    assert row.original_amount == Decimal("80.00")


def test_a_posted_create_with_the_actual_figure_fills_the_provenance(sw_client, sw_db, fp):
    client, db, a = sw_client, sw_db, fp["a"]
    body = sw_post(client, a, "/transactions/", {
        "account_id": fp["php"], "transaction_type": "debit", "amount": 4_700,
        "currency": "PHP", "projected_amount": 80, "projected_currency": "USD",
        "transaction_date": DAY, "is_posted": True})
    assert (body["original_amount"], body["original_currency"]) == (80, "USD")
    assert _row(db, body["id"]).exchange_rate == Decimal("58.750000")
    assert _balance(db, fp["php"]) == Decimal("45300.00")


@pytest.mark.parametrize("actor", ["owner", "editor"])
def test_reverting_a_posted_create_with_only_a_foreign_currency_keeps_the_amount(
        sw_client, sw_db, fp, actor):
    """Created posted with ``currency`` USD and no ``projected_amount``: the
    actual PHP 4,700 is all there is. Reverting records the account's currency
    as the face currency, so the forecast reads the retained 4,700 as PHP and
    never converts it again (4,700 read as USD would be 272,600)."""
    client, db = sw_client, sw_db
    who = fp["a"] if actor == "owner" else fp["b"]
    txn = sw_post(client, fp["a"], "/transactions/", {
        "account_id": fp["php"], "transaction_type": "debit", "amount": 4_700,
        "currency": "USD", "description": "Foreign purchase", "transaction_date": DAY,
        "is_posted": True})["id"]
    assert _balance(db, fp["php"]) == Decimal("45300.00")

    r = _put(client, who, txn, {"is_posted": False})
    assert r.status_code == 200, r.text
    assert _balance(db, fp["php"]) == Decimal("50000.00")
    row = _row(db, txn)
    assert (row.amount, row.projected_amount, row.projected_currency.value) == (
        Decimal("4700.00"), None, "PHP")
    item = _forecast_row(client, who, txn)
    assert (item["amount"], item["currency"]) == (4_700.0, "PHP")
    assert not set(item) & {"estimated", "original_amount", "rate", "unconverted"}


# --- F2: refusals --------------------------------------------------------------------------

def test_posting_a_foreign_pending_debit_status_only_is_refused(sw_client, sw_db, fp):
    client, db, a = sw_client, sw_db, fp["a"]
    txn = _pending_foreign(client, a, fp["php"])
    r = _put(client, a, txn, {"is_posted": True})
    assert r.status_code == 400, r.text
    assert r.json()["detail"] == FOREIGN_POST
    assert _balance(db, fp["php"]) == Decimal("50000.00")
    assert _row(db, txn).is_posted is False


def test_a_foreign_credit_is_refused_the_same_way(sw_client, sw_db, fp):
    client, db, a = sw_client, sw_db, fp["a"]
    txn = sw_post(client, a, "/transactions/", {
        "account_id": fp["php"], "transaction_type": "credit", "amount": 55,
        "currency": "PHP", "projected_amount": 55, "projected_currency": "USD",
        "transaction_date": DAY, "is_posted": False})["id"]
    r = _put(client, a, txn, {"is_posted": True})
    assert r.status_code == 400 and r.json()["detail"] == FOREIGN_POST, r.text
    r = _put(client, a, txn, {"is_posted": True, "amount": 0})
    assert r.status_code == 400 and r.json()["detail"] == FOREIGN_POST, r.text
    r = _put(client, a, txn, {"is_posted": True, "amount": 3_190})
    assert r.status_code == 200, r.text
    assert _balance(db, fp["php"]) == Decimal("53190.00")


@pytest.mark.parametrize("face", [{"currency": "USD"}, {"projected_currency": "USD"}],
                         ids=["currency", "projected_currency"])
def test_creating_a_posted_foreign_debit_without_the_actual_figure_is_refused(
        sw_client, sw_db, fp, face):
    client, db, a = sw_client, sw_db, fp["a"]
    # On create, ``amount`` is the actual figure: 0 is none.
    r = client.post(f"{API}/transactions/", headers=a["headers"], json={
        "account_id": fp["php"], "transaction_type": "debit", "amount": 0,
        "projected_amount": 80, "transaction_date": DAY, "is_posted": True, **face})
    assert r.status_code == 400, r.text
    assert r.json()["detail"] == FOREIGN_POST
    assert _balance(db, fp["php"]) == Decimal("50000.00")


def test_posting_a_cross_currency_transfer_needs_the_amount_received(sw_client, sw_db, fp):
    client, db, a = sw_client, sw_db, fp["a"]
    txn = _pending_transfer(client, a, fp["php"], fp["usd"], 5_800)
    r = _put(client, a, txn, {"is_posted": True})
    assert r.status_code == 400, r.text
    assert r.json()["detail"] == "Enter the amount received"
    assert _balance(db, fp["php"]) == Decimal("50000.00")
    assert _balance(db, fp["usd"]) == Decimal("1000.00")

    r = _put(client, a, txn, {"is_posted": True, "received_amount": 100})
    assert r.status_code == 200, r.text
    assert _balance(db, fp["php"]) == Decimal("44200.00")
    assert _balance(db, fp["usd"]) == Decimal("1100.00")


def test_a_stored_amount_received_lets_a_transfer_post_status_only(sw_client, sw_db, fp):
    client, db, a = sw_client, sw_db, fp["a"]
    txn = _pending_transfer(client, a, fp["php"], fp["usd"], 5_800, received_amount=100)
    r = _put(client, a, txn, {"is_posted": True})
    assert r.status_code == 200, r.text
    assert _balance(db, fp["usd"]) == Decimal("1100.00")


# --- F3: the owner exemption ----------------------------------------------------------------

@pytest.fixture
def stranded(sw_client, sw_db, fp):
    """Rows C made on A's accounts, then C's access is revoked (the exemption applies)."""
    client, c = sw_client, fp["c"]
    rows = {
        "foreign": _pending_foreign(client, c, fp["php"]),
        "local": _pending_local(client, c, fp["php"]),
        "transfer": _pending_transfer(client, c, fp["php"], fp["usd"], 5_800),
        "local_transfer": _pending_transfer(client, c, fp["php"], fp["php_sav"], 2_000),
    }
    # A posted foreign row, to revert.
    posted = _pending_foreign(client, c, fp["php"], amount=50)
    r = _put(client, c, posted, {"is_posted": True, "amount": 2_900})
    assert r.status_code == 200, r.text
    rows["posted"] = posted
    _revoke_c(sw_db, fp)
    return rows


def test_owner_exemption_posts_a_foreign_debit_with_its_amount(sw_client, sw_db, fp, stranded):
    client, db, a = sw_client, sw_db, fp["a"]
    txn = stranded["foreign"]
    r = _put(client, a, txn, {"is_posted": True})
    assert r.status_code == 400 and r.json()["detail"] == FOREIGN_POST, r.text
    r = _put(client, a, txn, {"is_posted": True, "amount": 4_700})
    assert r.status_code == 200, r.text
    row = _row(db, txn)
    assert row.is_posted is True and row.amount == Decimal("4700.00")
    assert row.original_amount == Decimal("80.00")
    assert row.exchange_rate == Decimal("58.750000")
    # 50,000 - 2,900 (C's posted row) - 4,700.
    assert _balance(db, fp["php"]) == Decimal("42400.00")

    # Owner status-only revert: restored, the posted amount kept.
    r = _put(client, a, txn, {"is_posted": False})
    assert r.status_code == 200, r.text
    assert _balance(db, fp["php"]) == Decimal("47100.00")
    row = _row(db, txn)
    assert (row.amount, row.projected_amount) == (Decimal("4700.00"), Decimal("80.00"))
    _assert_reestimated(client, a, txn)
    r = _put(client, a, txn, {"is_posted": True, "amount": 4_650})
    assert r.status_code == 200, r.text
    assert _balance(db, fp["php"]) == Decimal("42450.00")


def test_owner_exemption_posts_a_cross_currency_transfer_with_its_amount_received(
        sw_client, sw_db, fp, stranded):
    client, db, a = sw_client, sw_db, fp["a"]
    txn = stranded["transfer"]
    r = _put(client, a, txn, {"is_posted": True})
    assert r.status_code == 400 and r.json()["detail"] == "Enter the amount received", r.text
    r = _put(client, a, txn, {"is_posted": True, "received_amount": 100})
    assert r.status_code == 200, r.text
    assert _balance(db, fp["php"]) == Decimal("41300.00")  # 50,000 - 2,900 - 5,800
    assert _balance(db, fp["usd"]) == Decimal("1100.00")


@pytest.mark.parametrize("row,body", [
    ("foreign", {"is_posted": True, "amount": 4_700, "description": "x"}),
    ("foreign", {"is_posted": True, "amount": 4_700, "received_amount": 100}),
    ("foreign", {"is_posted": True, "amount": 4_700, "exchange_rate": 58.75}),
    ("foreign", {"is_posted": True, "received_amount": 100}),
    ("foreign", {"is_posted": True, "projected_amount": 81}),
    ("transfer", {"is_posted": True, "amount": 5_000}),
    ("transfer", {"is_posted": True, "received_amount": 100, "transfer_fee": 5}),
    ("local", {"is_posted": True, "amount": 400}),
    ("local", {"is_posted": True, "received_amount": 400}),
    ("local_transfer", {"is_posted": True, "received_amount": 2_000}),
    ("local_transfer", {"is_posted": True, "amount": 2_000}),
    ("posted", {"is_posted": True, "amount": 3_000}),
    ("posted", {"is_posted": False, "amount": 3_000}),
    ("posted", {"is_posted": False, "description": "x"}),
])
def test_owner_exemption_refuses_anything_else(sw_client, sw_db, fp, stranded, row, body):
    client, db = sw_client, sw_db
    before = (_balance(db, fp["php"]), _balance(db, fp["usd"]))
    r = _put(client, fp["a"], stranded[row], body)
    assert r.status_code == 404, r.text
    assert (_balance(db, fp["php"]), _balance(db, fp["usd"])) == before


def test_owner_exemption_reverts_status_only_and_keeps_the_amount(sw_client, sw_db, fp, stranded):
    client, db, a = sw_client, sw_db, fp["a"]
    r = _put(client, a, stranded["posted"], {"is_posted": False})
    assert r.status_code == 200, r.text
    assert _balance(db, fp["php"]) == Decimal("50000.00")
    row = _row(db, stranded["posted"])
    assert (row.amount, row.projected_amount) == (Decimal("2900.00"), Decimal("50.00"))


def test_the_creator_who_lost_access_and_a_viewer_get_404(sw_client, sw_db, fp, stranded):
    client = sw_client
    for who in (fp["c"], fp["v"]):
        assert _put(client, who, stranded["foreign"],
                    {"is_posted": True, "amount": 4_700}).status_code == 404
        assert _put(client, who, stranded["transfer"],
                    {"is_posted": True, "received_amount": 100}).status_code == 404
        assert _put(client, who, stranded["posted"], {"is_posted": False}).status_code == 404


def test_viewer_gets_404_on_a_row_with_a_live_creator(sw_client, fp):
    txn = _pending_foreign(sw_client, fp["a"], fp["php"])
    assert _put(sw_client, fp["v"], txn, {"is_posted": True, "amount": 4_700}).status_code == 404
    assert _put(sw_client, fp["v"], txn, {"is_posted": True}).status_code == 404


def test_editor_takes_the_normal_path(sw_client, sw_db, fp):
    client, db, b = sw_client, sw_db, fp["b"]
    txn = _pending_foreign(client, fp["a"], fp["php"])
    r = _put(client, b, txn, {"is_posted": True})
    assert r.status_code == 400 and r.json()["detail"] == FOREIGN_POST, r.text
    r = _put(client, b, txn, {"is_posted": True, "amount": 4_700, "description": "Paid"})
    assert r.status_code == 200, r.text
    assert _balance(db, fp["php"]) == Decimal("45300.00")
    assert _row(db, txn).description == "Paid"


# --- unchanged -----------------------------------------------------------------------------

@pytest.mark.parametrize("actor", ["owner", "editor"])
def test_same_currency_posting_status_only_is_unchanged(sw_client, sw_db, fp, actor):
    client, db = sw_client, sw_db
    who = fp["a"] if actor == "owner" else fp["b"]
    txn = _pending_local(client, fp["a"], fp["php"])
    r = _put(client, who, txn, {"is_posted": True})
    assert r.status_code == 200, r.text
    assert _balance(db, fp["php"]) == Decimal("49500.00")
    row = _row(db, txn)
    assert row.exchange_rate is None and row.original_amount is None
    r = _put(client, who, txn, {"is_posted": False})
    assert r.status_code == 200, r.text
    assert _balance(db, fp["php"]) == Decimal("50000.00")


def test_owner_exemption_posts_same_currency_rows_status_only(sw_client, sw_db, fp, stranded):
    client, db, a = sw_client, sw_db, fp["a"]
    assert _put(client, a, stranded["local"], {"is_posted": True}).status_code == 200
    assert _put(client, a, stranded["local_transfer"], {"is_posted": True}).status_code == 200
    # 50,000 - 2,900 (C's posted row) - 500 - 2,000.
    assert _balance(db, fp["php"]) == Decimal("44600.00")
    assert _balance(db, fp["php_sav"]) == Decimal("12000.00")


def test_same_currency_transfer_posting_is_unchanged(sw_client, sw_db, fp):
    client, db, a = sw_client, sw_db, fp["a"]
    txn = _pending_transfer(client, a, fp["php"], fp["php_sav"], 2_000, transfer_fee=10)
    r = _put(client, a, txn, {"is_posted": True})
    assert r.status_code == 200, r.text
    assert r.json()["received_amount"] is None
    assert _balance(db, fp["php"]) == Decimal("47990.00")
    assert _balance(db, fp["php_sav"]) == Decimal("12000.00")


def test_a_pending_loan_payment_posts_as_before(sw_client, sw_db, fp):
    client, db, a = sw_client, sw_db, fp["a"]
    loan = sw_post(client, a, "/accounts/", {
        "name": "Car loan", "account_type": "loan", "loan_kind": "auto", "currency": "PHP",
        "balance": -100_000, "loan_annual_rate": 12, "loan_term_months": 24,
        "loan_payment_amount": 5_000, "loan_first_payment_date": "2026-10-20",
        "payment_account_id": fp["php"]})["id"]
    txn = _pending_transfer(client, a, fp["php"], loan, 5_000)
    r = _put(client, a, txn, {"is_posted": True})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["received_amount"] is None and body["exchange_rate"] is None
    principal = Decimal(str(body["amount"]))
    fee = Decimal(str(body["transfer_fee"]))
    assert principal + fee == Decimal("5000")
    assert _balance(db, fp["php"]) == Decimal("45000.00")
    assert _balance(db, loan) == Decimal("-100000.00") + principal
