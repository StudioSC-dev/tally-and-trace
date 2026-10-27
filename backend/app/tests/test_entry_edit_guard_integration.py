"""PUT /budget-entries/{id}: the stale-copy guard (STU-343 Plan B, B1).

An edit may carry ``expected_updated_at``, the ``updated_at`` of the copy it
was made from. When sent (null included) it must equal the stored value
exactly, microseconds included, or the edit is refused with 409 and nothing
is written. Every successful edit moves ``updated_at``, a tag-only edit
included. A caller who cannot edit the entry gets 404 before the check.
Skips without a database.
"""
import os
import sys
from datetime import datetime, timezone

import pytest
from sqlalchemy import create_engine, text

from app.tests.conftest import API, sw_db_reachable, sw_post, sw_share

pytestmark = pytest.mark.skipif(not sw_db_reachable(), reason="DATABASE_URL not reachable")

# Sunday 2026-10-18, 02:00 UTC: 10:00 in Manila.
REF = datetime(2026, 10, 18, 2, 0)
STALE = "This entry changed since you opened it; reopen it to edit"


def pin_clock(monkeypatch, when: datetime) -> None:
    """Freeze ``naive_utc_now`` in every loaded app module (Manila's today included)."""
    for name, module in list(sys.modules.items()):
        if name.startswith("app.") and hasattr(module, "naive_utc_now"):
            monkeypatch.setattr(module, "naive_utc_now", lambda: when)


@pytest.fixture
def engine():
    e = create_engine(os.environ["DATABASE_URL"])
    yield e
    e.dispose()


def _account(client, who, name="Checking", account_type="checking", balance=50_000, **extra):
    return sw_post(client, who, "/accounts/", {
        "name": name, "account_type": account_type, "balance": balance, **extra})["id"]


def _card(client, who, checking):
    return _account(client, who, "Card C", "credit", 0, billing_cycle_start=24,
                    days_until_due_date=21, payment_account_id=checking)


def _tablet(client, who, card):
    """Tablet: PHP 5,000 on the 5th, capped, 24 remaining, next 2026-07-05."""
    return sw_post(client, who, "/budget-entries/", {
        "name": "Tablet", "entry_type": "expense", "amount": 5_000, "cadence": "monthly",
        "next_occurrence": "2026-07-05T00:00:00", "account_id": card,
        "end_mode": "after_occurrences", "max_occurrences": 24})["id"]


def _get(client, who, entry_id) -> dict:
    r = client.get(f"{API}/budget-entries/{entry_id}", headers=who["headers"])
    assert r.status_code == 200, r.text
    return r.json()


def _put(client, who, entry_id, body):
    return client.put(f"{API}/budget-entries/{entry_id}", json=body, headers=who["headers"])


def _mark_paid(client, who, entry_id, day):
    r = client.post(f"{API}/budget-entries/{entry_id}/materialize",
                    json={"occurrence_date": f"{day}T00:00:00"}, headers=who["headers"])
    assert r.status_code == 201, r.text


@pytest.fixture
def world(sw_client, sw_people, monkeypatch):
    client = sw_client
    owner = sw_people("Olive", "Owner")
    checking = _account(client, owner)
    card = _card(client, owner, checking)
    tablet = _tablet(client, owner, card)
    pin_clock(monkeypatch, REF)
    return {"client": client, "o": owner, "card": card, "tablet": tablet,
            "people": sw_people}


def test_stale_edit_is_refused(world):
    client, o, tablet = world["client"], world["o"], world["tablet"]
    loaded = _get(client, o, tablet)
    _mark_paid(client, o, tablet, "2026-07-05")
    before = _get(client, o, tablet)
    assert before["updated_at"] != loaded["updated_at"]

    r = _put(client, o, tablet, {"name": "Tablet Pro",
                                 "expected_updated_at": loaded["updated_at"]})

    assert r.status_code == 409, r.text
    assert r.json()["detail"] == STALE
    after = _get(client, o, tablet)
    assert after["name"] == "Tablet"
    assert after["next_occurrence"] == before["next_occurrence"]
    assert after["max_occurrences"] == before["max_occurrences"] == 23
    assert after["updated_at"] == before["updated_at"]


def test_current_version_is_accepted(world, engine):
    client, o, tablet = world["client"], world["o"], world["tablet"]
    _mark_paid(client, o, tablet, "2026-07-05")
    current = _get(client, o, tablet)

    r = _put(client, o, tablet, {"name": "Tablet Pro",
                                 "expected_updated_at": current["updated_at"]})

    assert r.status_code == 200, r.text
    body = r.json()
    assert "expected_updated_at" not in body
    assert body["name"] == "Tablet Pro"
    assert body["updated_at"] != current["updated_at"]
    unchanged = {k: v for k, v in body.items() if k not in ("name", "updated_at")}
    assert unchanged == {k: v for k, v in current.items() if k not in ("name", "updated_at")}
    with engine.connect() as c:
        assert c.execute(text(
            "SELECT count(*) FROM information_schema.columns "
            "WHERE table_name = 'budget_entries' AND column_name = 'expected_updated_at'"
        )).scalar() == 0


def test_edit_without_a_version_is_unchecked(world):
    client, o, tablet = world["client"], world["o"], world["tablet"]
    _mark_paid(client, o, tablet, "2026-07-05")

    r = _put(client, o, tablet, {"name": "Tablet Pro"})

    assert r.status_code == 200, r.text
    assert r.json()["name"] == "Tablet Pro"


def test_a_millisecond_rounded_version_is_stale(world, engine):
    client, o, tablet = world["client"], world["o"], world["tablet"]
    stored = datetime(2026, 10, 18, 2, 0, 0, 123456, tzinfo=timezone.utc)
    with engine.begin() as c:
        c.execute(text("UPDATE budget_entries SET updated_at = :u WHERE id = :e"),
                  {"u": stored, "e": tablet})
    exact = _get(client, o, tablet)["updated_at"]
    assert datetime.fromisoformat(exact.replace("Z", "+00:00")) == stored
    rounded = stored.replace(microsecond=123000).isoformat()

    r = _put(client, o, tablet, {"name": "Tablet Pro", "expected_updated_at": rounded})
    assert r.status_code == 409, r.text
    assert _get(client, o, tablet)["name"] == "Tablet"

    r = _put(client, o, tablet, {"name": "Tablet Pro", "expected_updated_at": exact})
    assert r.status_code == 200, r.text
    assert r.json()["name"] == "Tablet Pro"


def test_never_updated_entry_matches_null(world):
    client, o, tablet = world["client"], world["o"], world["tablet"]
    assert _get(client, o, tablet)["updated_at"] is None

    r = _put(client, o, tablet, {"name": "Tablet Pro", "expected_updated_at": None})

    assert r.status_code == 200, r.text
    assert r.json()["name"] == "Tablet Pro"
    assert r.json()["updated_at"] is not None


def test_tag_only_edit_advances_the_version(world):
    client, o, tablet = world["client"], world["o"], world["tablet"]
    tag = sw_post(client, o, "/tags/", {"name": "Gadgets"})["id"]
    _mark_paid(client, o, tablet, "2026-07-05")
    old = _get(client, o, tablet)["updated_at"]

    r = _put(client, o, tablet, {"tag_ids": [tag], "expected_updated_at": old})
    assert r.status_code == 200, r.text
    assert r.json()["updated_at"] != old

    r = _put(client, o, tablet, {"name": "Tablet Pro", "expected_updated_at": old})
    assert r.status_code == 409, r.text
    assert r.json()["detail"] == STALE


def test_a_non_editor_gets_404_before_the_version_check(world, sw_db):
    client, o, card, tablet = world["client"], world["o"], world["card"], world["tablet"]
    viewer = world["people"]("Vic", "Viewer")
    sw_share(sw_db, card, viewer["id"], "viewer", o["id"])
    loaded = _get(client, o, tablet)
    _mark_paid(client, o, tablet, "2026-07-05")

    r = _put(client, viewer, tablet, {"name": "Tablet Pro",
                                      "expected_updated_at": loaded["updated_at"]})

    assert r.status_code == 404, r.text
    assert _get(client, o, tablet)["name"] == "Tablet"
