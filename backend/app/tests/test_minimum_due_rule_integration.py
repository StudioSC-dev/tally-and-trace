"""A card's minimum due rule through the API (STU-343 Plan C, 2.4).

The rule is stored on ``accounts.minimum_due_rule`` as JSON with string Decimals,
accepted on create and PUT for credit cards only, null for editors and viewers,
absent for tag viewers, listed in the export, and the presets endpoint serves the
five bank rules. The migration sits on the single Alembic head and its downgrade
drops the column. Skips without a database.
"""
import os
import subprocess
import sys
from pathlib import Path

import pytest
from sqlalchemy import create_engine, inspect, text
from sqlalchemy.engine import make_url

from app.tests.conftest import API, hh_household, hh_tag_share, sw_db_reachable, sw_post, sw_share

pytestmark = pytest.mark.skipif(not sw_db_reachable(), reason="DATABASE_URL not reachable")

BACKEND_DIR = Path(__file__).resolve().parents[2]
PREVIOUS = "1b678ac2c4f3"
RULE_REVISION = "644091f19b93"

BDO = {"version": 1, "preset": "bdo", "base_percent": "3",
       "base_excludes": ["installments", "overlimit"], "installment_percent": "3",
       "floor": {"PHP": "850", "USD": "17"}, "floored_terms": [],
       "added_terms": ["installments", "overdue", "overlimit"], "annual_fee": None,
       "rounding": "down"}


# --- migration -------------------------------------------------------------------------------

def test_rule_migration_is_the_single_head_after_gifts_given_category():
    from alembic.config import Config
    from alembic.script import ScriptDirectory

    script = ScriptDirectory.from_config(Config(str(BACKEND_DIR / "alembic.ini")))
    (head,) = script.get_heads()
    assert RULE_REVISION in {rev.revision for rev in script.walk_revisions("base", head)}
    assert script.get_revision(RULE_REVISION).down_revision == PREVIOUS


@pytest.fixture
def scratch_url():
    base = make_url(os.environ["DATABASE_URL"])
    name = f"{base.database}_mdrule_{os.urandom(3).hex()}"
    admin = create_engine(base, isolation_level="AUTOCOMMIT")
    with admin.connect() as c:
        c.execute(text(f'CREATE DATABASE "{name}"'))
    url = base.set(database=name)
    try:
        yield url
    finally:
        with admin.connect() as c:
            c.execute(text(f'DROP DATABASE IF EXISTS "{name}" WITH (FORCE)'))
        admin.dispose()


def _alembic(url, *args):
    env = {**os.environ, "DATABASE_URL": url.render_as_string(hide_password=False)}
    result = subprocess.run([sys.executable, "-m", "alembic", *args], cwd=BACKEND_DIR, env=env,
                            capture_output=True, text=True)
    assert result.returncode == 0, result.stderr


def test_upgrade_adds_the_column_and_downgrade_drops_it(scratch_url):
    def columns():
        engine = create_engine(scratch_url)
        try:
            with engine.connect() as c:
                return {col["name"] for col in inspect(c).get_columns("accounts")}
        finally:
            engine.dispose()

    _alembic(scratch_url, "upgrade", RULE_REVISION)
    assert "minimum_due_rule" in columns()
    _alembic(scratch_url, "downgrade", PREVIOUS)
    assert "minimum_due_rule" not in columns()


# --- API -------------------------------------------------------------------------------------

@pytest.fixture
def world(sw_client, sw_db, sw_people):
    """Owner A's joint card (Household-tagged) shared with B (editor), V (viewer) and
    D (admin); C holds A's Household tag share. A also has a checking account."""
    client, db = sw_client, sw_db
    a, b, v, d, c = (sw_people(n, "Probe") for n in ("Alice", "Bea", "Vic", "Dee", "Cal"))
    hh_a = hh_household(db, a)
    checking = sw_post(client, a, "/accounts/", {
        "name": "Checking", "account_type": "checking", "balance": 50_000})["id"]
    card = sw_post(client, a, "/accounts/", {
        "name": "Card C", "account_type": "credit", "balance": 0, "credit_limit": 128_000,
        "billing_cycle_start": 24, "days_until_due_date": 21,
        "payment_account_id": checking, "tag_ids": [hh_a]})["id"]
    sw_share(db, card, b["id"], "editor", a["id"])
    sw_share(db, card, v["id"], "viewer", a["id"])
    sw_share(db, card, d["id"], "admin", a["id"])
    hh_tag_share(db, a, c)
    return {"a": a, "b": b, "v": v, "d": d, "c": c, "card": card, "checking": checking}


def _put(client, who, account, body, expect=200):
    r = client.put(f"{API}/accounts/{account}", json=body, headers=who["headers"])
    assert r.status_code == expect, r.text
    return r.json()


def _get(client, who, account):
    r = client.get(f"{API}/accounts/{account}", headers=who["headers"])
    assert r.status_code == 200, r.text
    return r.json()


def _stored(db, account):
    return db.execute(text("SELECT minimum_due_rule FROM accounts WHERE id = :i"),
                      {"i": account}).scalar_one()


def test_a_rule_put_on_a_card_is_stored_with_string_decimals(sw_client, sw_db, world):
    body = _put(sw_client, world["a"], world["card"], {"minimum_due_rule": BDO})
    assert body["minimum_due_rule"] == BDO
    assert _stored(sw_db, world["card"]) == BDO
    assert _get(sw_client, world["a"], world["card"])["minimum_due_rule"] == BDO
    # The admin manages the card too.
    hsbc = {**BDO, "preset": "custom", "base_percent": "1.25", "annual_fee": "2400.50"}
    assert _put(sw_client, world["d"], world["card"],
                {"minimum_due_rule": hsbc})["minimum_due_rule"] == hsbc
    # Other edits leave it alone; an explicit null clears it.
    _put(sw_client, world["a"], world["card"], {"name": "Card C renamed"})
    assert _stored(sw_db, world["card"]) == hsbc
    assert _put(sw_client, world["a"], world["card"],
                {"minimum_due_rule": None})["minimum_due_rule"] is None
    sw_db.expire_all()
    assert _stored(sw_db, world["card"]) is None


def test_a_rule_on_create(sw_client, sw_db, world):
    card = sw_post(sw_client, world["a"], "/accounts/", {
        "name": "Card N", "account_type": "credit", "minimum_due_rule": BDO})
    assert card["minimum_due_rule"] == BDO
    assert _stored(sw_db, card["id"]) == BDO
    r = sw_client.post(f"{API}/accounts/", headers=world["a"]["headers"], json={
        "name": "Bank N", "account_type": "savings", "minimum_due_rule": BDO})
    assert r.status_code == 400
    assert r.json()["detail"] == "Only a credit card has a minimum due rule"


def test_a_rule_on_checking_is_refused(sw_client, sw_db, world):
    r = _put(sw_client, world["a"], world["checking"], {"minimum_due_rule": BDO}, expect=400)
    assert r["detail"] == "Only a credit card has a minimum due rule"
    assert _stored(sw_db, world["checking"]) is None
    # A card keeping its rule cannot become another type.
    _put(sw_client, world["a"], world["card"], {"minimum_due_rule": BDO})
    r = _put(sw_client, world["a"], world["card"],
             {"account_type": "checking", "payment_account_id": None}, expect=400)
    assert r["detail"] == "Only a credit card has a minimum due rule"


def test_an_editor_cannot_set_a_rule(sw_client, sw_db, world):
    _put(sw_client, world["b"], world["card"], {"minimum_due_rule": BDO}, expect=404)
    assert _stored(sw_db, world["card"]) is None


@pytest.mark.parametrize("change", [
    {"floored_terms": ["overdue"], "added_terms": ["overdue"]},
    {"installment_percent": None},
    {"added_terms": ["overdue", "overdue"]},
    {"installment_percent": "-3"},
    {"installment_percent": "101"},
    {"annual_fee": "-1"},
    {"floor": {"PHP": "-1"}},
    {"base_percent": "NaN"},
    {"base_percent": "Infinity"},
])
def test_invalid_rules_are_422(sw_client, sw_db, world, change):
    _put(sw_client, world["a"], world["card"], {"minimum_due_rule": {**BDO, **change}},
         expect=422)
    assert _stored(sw_db, world["card"]) is None


def test_the_rule_is_manager_only(sw_client, world):
    _put(sw_client, world["a"], world["card"], {"minimum_due_rule": BDO})
    for who in ("a", "d"):
        assert _get(sw_client, world[who], world["card"])["minimum_due_rule"] == BDO
    for who in ("b", "v"):
        body = _get(sw_client, world[who], world["card"])
        assert body["my_role"] in ("editor", "viewer")
        assert body["minimum_due_rule"] is None
    tag_view = _get(sw_client, world["c"], world["card"])
    assert tag_view["my_role"] == "tag_viewer"
    assert "minimum_due_rule" not in tag_view
    r = sw_client.get(f"{API}/accounts/", params={"limit": 100}, headers=world["v"]["headers"])
    (listed,) = [a for a in r.json()["items"] if a["id"] == world["card"]]
    assert listed["minimum_due_rule"] is None


def test_the_presets_endpoint(sw_client, world):
    from app.schemas.minimum_due import MinimumDueRule

    r = sw_client.get(f"{API}/accounts/minimum-due-presets", headers=world["b"]["headers"])
    assert r.status_code == 200, r.text
    body = r.json()
    assert [p["key"] for p in body] == ["bdo", "bdo_installment", "metrobank",
                                        "security_bank", "hsbc"]
    for preset in body:
        assert set(preset) == {"key", "label", "effective_from", "rule"}
        assert MinimumDueRule.model_validate(preset["rule"]).preset == preset["key"]
    assert body[0]["rule"] == BDO
    hsbc = body[4]
    assert (hsbc["label"], hsbc["effective_from"]) == ("HSBC (from 2025-05-01)", "2025-05-01")
    assert hsbc["rule"]["floor"] == {"PHP": "1500"}
    assert sw_client.get(f"{API}/accounts/minimum-due-presets").status_code == 401


def test_the_export_carries_the_rule(sw_client, world):
    _put(sw_client, world["a"], world["card"], {"minimum_due_rule": BDO})
    r = sw_client.get(f"{API}/data/export.json", headers=world["a"]["headers"])
    assert r.status_code == 200, r.text
    rows = {a["id"]: a for a in r.json()["accounts"]}
    assert rows[world["card"]]["minimum_due_rule"] == BDO
    assert rows[world["checking"]]["minimum_due_rule"] is None
