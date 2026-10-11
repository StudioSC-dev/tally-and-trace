"""Household tag shares: the export (STU-233, plan §1 and §2).

A tag viewer's export lists the sharer's Household-tagged accounts as shared
accounts (``my_role`` "tag_viewer") and the sharer's records readable under
rules (b2) and (c) through the Limited models. Another user's records on the
sharer's account, and the sharer's non-Household records, never appear: not in
the JSON, the one-table CSVs or the ZIP, including after revocation.
"""
import io
import re
import zipfile

import pytest

from app.tests.conftest import API, PRIVATE, sw_db_reachable, sw_leaks, sw_post

pytestmark = pytest.mark.skipif(not sw_db_reachable(), reason="DATABASE_URL not reachable")

SENTINELS = (66.61, 77.17)


def _get(client, who, path, **params):
    r = client.get(f"{API}{path}", headers=who["headers"], params=params)
    assert r.status_code == 200, (path, r.status_code, r.text)
    return r


def _all_exports(client, who):
    """(the JSON body, every CSV and ZIP member as text)."""
    from app.services.export import TABLE_FIELDS

    body = _get(client, who, "/data/export.json").json()
    texts = [_get(client, who, "/data/export.csv", table=t).text for t in TABLE_FIELDS]
    archive = zipfile.ZipFile(io.BytesIO(_get(client, who, "/data/export.csv").content))
    texts += [archive.read(name).decode() for name in archive.namelist()]
    return body, texts


def _clean(body, texts, private_ids):
    assert sw_leaks(body, private_ids, numbers=SENTINELS) == []
    for text in texts:
        assert PRIVATE not in text
        for n in SENTINELS:
            assert not re.search(rf"(?<![\d.]){re.escape(str(n))}(?!\d)", text)


def _txn(client, who, account, amount, description, tags=()):
    return sw_post(client, who, "/transactions/", {
        "account_id": account, "amount": amount, "transaction_type": "debit",
        "transaction_date": "2026-10-05T00:00:00", "is_posted": True,
        "description": description, "tag_ids": list(tags)})["id"]


@pytest.fixture
def records(hh, sw_client):
    a, b = hh["a"], hh["b"]
    return {
        "rent": _txn(sw_client, a, hh["joint"], 120, "Household rent"),
        "internet": _txn(sw_client, a, hh["a_card"], 100, "Household internet",
                         tags=[hh["hh_a"]]),
        "private": _txn(sw_client, a, hh["a_private"], 66.61, f"{PRIVATE} gift"),
        "partner": _txn(sw_client, b, hh["joint"], 77.17, f"{PRIVATE} Bea lunch",
                        tags=[hh["hh_b"]]),
        "private_ids": [hh["a_private"], hh["a_card"], hh["a_loan"], hh["a_wallet"],
                        hh["b_private"]],
    }


def test_tag_viewer_export_holds_the_sharers_household_only(hh, sw_client, records):
    body, texts = _all_exports(sw_client, hh["c"])
    _clean(body, texts, records["private_ids"])
    assert body["export_version"] == 2
    assert [(a["id"], a["my_role"]) for a in body["shared_accounts"]] == [
        (hh["joint"], "tag_viewer")]
    others = {t["id"]: t for t in body["others_transactions"]}
    assert set(others) == {records["rent"], records["internet"]}
    assert others[records["internet"]]["display_description"] == "Household internet"
    assert others[records["internet"]]["account"] == {"id": None, "name": "Card payment"}
    assert body["transactions"] == [] and body["account_tags"] == []


def test_export_stays_clean_after_revocation(hh, sw_client, records):
    a, c = hh["a"], hh["c"]
    r = sw_client.delete(f"{API}/tags/household/shares/{hh['a_to_c']}", headers=a["headers"])
    assert r.status_code == 204
    r = sw_client.delete(f"{API}/shares/received/household/{hh['b_to_c']}", headers=c["headers"])
    assert r.status_code == 204
    body, texts = _all_exports(sw_client, c)
    _clean(body, texts, records["private_ids"] + [hh["joint"]])
    assert body["shared_accounts"] == [] and body["others_transactions"] == []
    for text in texts:
        assert "Household rent" not in text and "Household internet" not in text


def test_the_partner_and_owner_exports_are_unchanged_by_the_tag_share(hh, sw_client, records):
    # B (direct editor on joint) exports A's joint records Limited and none of A's privates.
    body = _get(sw_client, hh["b"], "/data/export.json").json()
    assert [(a["id"], a["my_role"]) for a in body["shared_accounts"]] == [
        (hh["joint"], "editor")]
    assert {t["id"] for t in body["others_transactions"]} == {records["rent"]}
    own = _get(sw_client, hh["a"], "/data/export.json").json()
    assert {records["rent"], records["internet"], records["private"]} <= {
        t["id"] for t in own["transactions"]}
