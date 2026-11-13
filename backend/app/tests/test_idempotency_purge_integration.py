"""The daily job deletes idempotency keys older than seven days (STU-604, PERF-9).
Skips without a database."""
import os
import uuid

import pytest
from sqlalchemy import create_engine, text

from app.tests.conftest import API, sw_db_reachable

pytestmark = pytest.mark.skipif(not sw_db_reachable(), reason="DATABASE_URL not reachable")


@pytest.fixture
def engine():
    e = create_engine(os.environ["DATABASE_URL"])
    yield e
    e.dispose()


@pytest.fixture
def world(sw_client, sw_db, sw_people):
    return {"client": sw_client, "db": sw_db, "me": sw_people("Ida", "Idem")}


def _count(w, model, **filters) -> int:
    w["db"].expire_all()
    return w["db"].query(model).filter_by(**filters).count()


def test_the_daily_job_deletes_keys_older_than_seven_days(world, engine, monkeypatch):
    from app.core.config import settings
    from app.models.idempotency_key import IdempotencyKey

    monkeypatch.setattr(settings, "JOB_TOKEN", "test-job-token")
    uid = world["me"]["id"]
    old, fresh = uuid.uuid4(), uuid.uuid4()
    with engine.begin() as c:
        c.execute(text(
            "INSERT INTO idempotency_keys (user_id, key, route, request_hash, status_code, "
            "response_json, created_at) VALUES "
            "(:u, :old, 'POST /x', 'h', 200, '{}', now() - interval '7 days 1 hour'), "
            "(:u, :fresh, 'POST /x', 'h', 200, '{}', now() - interval '6 days 23 hours')"),
            {"u": uid, "old": str(old), "fresh": str(fresh)})
    dry = world["client"].post(f"{API}/jobs/post-due-installments?dry_run=true",
                               headers={"X-Job-Token": "test-job-token"})
    assert dry.status_code == 200
    assert _count(world, IdempotencyKey, user_id=uid) == 2  # a dry run deletes nothing
    r = world["client"].post(f"{API}/jobs/post-due-installments",
                             headers={"X-Job-Token": "test-job-token"})
    assert r.status_code == 200 and set(r.json()) == {"dry_run", "posted", "skipped"}
    world["db"].expire_all()
    left = {row.key for row in world["db"].query(IdempotencyKey).filter_by(user_id=uid)}
    assert left == {fresh}
