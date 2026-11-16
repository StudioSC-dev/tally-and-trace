"""A cross-currency transfer's destination-side face currency (STU-303, AC5).

A transfer is recorded in its source account's currency (``currency``). Its
``projected_currency`` and ``original_currency``, when the request leaves them
out, each default on their own to the destination account's currency; values
the request sends are validated and kept as before. Same-currency transfers
are unchanged.
"""
import pytest

from app.tests.conftest import API, sw_db_reachable, sw_post

pytestmark = pytest.mark.skipif(not sw_db_reachable(), reason="no database available")


def _account(client, who, name, currency, balance=0):
    return sw_post(client, who, "/accounts/", {
        "name": name, "account_type": "checking", "currency": currency,
        "balance": balance})["id"]


def _transfer(client, who, src, dst, amount, *, expect=(200, 201), **extra):
    body = {"account_id": src, "transfer_from_account_id": src, "transfer_to_account_id": dst,
            "transaction_type": "transfer", "amount": amount,
            "transaction_date": "2026-11-09T00:00:00", "is_posted": False, **extra}
    r = client.post(f"{API}/transactions/", json=body, headers=who["headers"])
    assert r.status_code in expect, r.text
    return r.json()


@pytest.fixture
def fc(sw_client, sw_people):
    a = sw_people("Faye", "Face")
    return {"a": a,
            "php": _account(sw_client, a, "PHP Checking", "PHP", 50_000),
            "php_sav": _account(sw_client, a, "PHP Savings", "PHP", 0),
            "usd": _account(sw_client, a, "USD Savings", "USD", 1_000)}


def _faces(txn):
    return (txn["currency"], txn["projected_currency"], txn["original_currency"])


def test_transfer_face_currency_defaults_to_destination(sw_client, fc):
    client, a = sw_client, fc["a"]
    both = _transfer(client, a, fc["php"], fc["usd"], 5_800, projected_amount=5_800,
                     original_amount=5_800)
    assert _faces(both) == ("PHP", "USD", "USD")
    # Each defaults on its own: one sent, the other left out.
    projected_only = _transfer(client, a, fc["php"], fc["usd"], 5_800, projected_amount=5_800,
                               original_amount=5_800, original_currency="PHP")
    assert _faces(projected_only) == ("PHP", "USD", "PHP")
    original_only = _transfer(client, a, fc["php"], fc["usd"], 5_800, projected_amount=5_800,
                              projected_currency="PHP", original_amount=5_800)
    assert _faces(original_only) == ("PHP", "PHP", "USD")
    # The other way round, the destination is PHP.
    back = _transfer(client, a, fc["usd"], fc["php"], 100, projected_amount=100,
                     original_amount=100)
    assert _faces(back) == ("USD", "PHP", "PHP")
    # An edit that adds a figure with no currency defaults it to the destination too.
    bare = _transfer(client, a, fc["php"], fc["usd"], 5_800)
    assert (bare["projected_currency"], bare["original_currency"]) == (None, None)
    r = client.put(f"{API}/transactions/{bare['id']}", headers=a["headers"],
                   json={"projected_amount": 5_800, "original_amount": 5_800})
    assert r.status_code == 200, r.text
    assert _faces(r.json()) == ("PHP", "USD", "USD")


def test_transfer_face_currency_preserves_explicit_values(sw_client, fc):
    client, a = sw_client, fc["a"]
    sent = _transfer(client, a, fc["php"], fc["usd"], 5_800, projected_amount=5_800,
                     projected_currency="PHP", original_amount=40, original_currency="EUR")
    assert _faces(sent) == ("PHP", "PHP", "EUR")
    assert (sent["projected_amount"], sent["original_amount"]) == (5_800, 40)
    # An explicit value is still validated as before.
    for field in ("projected_currency", "original_currency"):
        r = client.post(f"{API}/transactions/", headers=a["headers"], json={
            "account_id": fc["php"], "transfer_from_account_id": fc["php"],
            "transfer_to_account_id": fc["usd"], "transaction_type": "transfer",
            "amount": 5_800, "projected_amount": 5_800, "original_amount": 5_800,
            "transaction_date": "2026-11-09T00:00:00", "is_posted": False, field: "XYZ"})
        assert r.status_code == 422, r.text
    # An edit sending one keeps it.
    r = client.put(f"{API}/transactions/{sent['id']}", headers=a["headers"],
                   json={"projected_currency": "USD"})
    assert r.status_code == 200, r.text
    assert _faces(r.json()) == ("PHP", "USD", "EUR")


def test_transfer_source_currency_unchanged(sw_client, fc):
    client, a = sw_client, fc["a"]
    # ``currency`` is the source account's, whatever the request names.
    for named in ("USD", "EUR", "PHP"):
        txn = _transfer(client, a, fc["php"], fc["usd"], 5_800, currency=named,
                        projected_amount=5_800)
        assert (txn["currency"], txn["amount"], txn["received_amount"]) == ("PHP", 5_800, None)
    posted = _transfer(client, a, fc["usd"], fc["php"], 100, is_posted=True,
                       received_amount=5_800, currency="PHP")
    assert (posted["currency"], posted["amount"], posted["received_amount"]) == (
        "USD", 100, 5_800)


def test_same_currency_transfer_unchanged(sw_client, fc):
    client, a = sw_client, fc["a"]
    plain = _transfer(client, a, fc["php"], fc["php_sav"], 1_000)
    assert _faces(plain) == ("PHP", None, None)
    assert plain["received_amount"] is None
    faced = _transfer(client, a, fc["php"], fc["php_sav"], 1_000, projected_amount=1_000,
                      original_amount=1_000)
    assert _faces(faced) == ("PHP", "PHP", "PHP")
    explicit = _transfer(client, a, fc["php"], fc["php_sav"], 1_000, projected_amount=20,
                         projected_currency="USD")
    assert _faces(explicit) == ("PHP", "USD", None)
