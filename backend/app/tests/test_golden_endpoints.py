"""Every hot endpoint answers exactly as it did before the access refactor (STU-597).

The golden files (``app/tests/data/golden/realistic/``) were captured at origin/main
e28b69c, the parent of the access-map change, on the realistic dataset with the
clock pinned to ``realistic.REF``. Each request of ``golden.golden_paths`` is made as
the owner, the SharedFull editor, the viewer, the household member and a stranger,
and its canonical text (``golden.canonical``) must equal the file byte for byte: a
difference in what any caller may see, or in any figure, fails here.

``GOLDEN_UPDATE=1`` rewrites the files instead (only on purpose, at a reference commit).
"""
import difflib
import os

import pytest

from app.tests.conftest import sw_db_reachable
from app.tests.fixtures import golden

needs_db = pytest.mark.skipif(not sw_db_reachable(), reason="DATABASE_URL not reachable")
UPDATE = os.environ.get("GOLDEN_UPDATE") == "1"


@pytest.fixture(scope="module")
def captured(realistic, sw_client):
    """Every golden response, ``{(caller, endpoint): text}``, made once."""
    from app.core.database import SessionLocal

    db = SessionLocal()
    stranger = golden.make_stranger(sw_client, db)
    try:
        callers = dict(realistic.callers, stranger=stranger)
        out = {}
        for key in golden.GOLDEN_CALLERS:
            for name, text in golden.capture(sw_client, realistic, callers[key], key).items():
                out[(key, name)] = text
        if UPDATE:
            golden.GOLDEN_DIR.mkdir(parents=True, exist_ok=True)
            for old in golden.GOLDEN_DIR.glob("*.json"):
                old.unlink()
            for (key, name), text in out.items():
                golden.golden_file(key, name).write_text(text, encoding="utf-8")
        return out
    finally:
        golden.remove_stranger(db, stranger)
        db.close()


def _expected():
    return sorted(p.stem.split("--", 1) for p in golden.GOLDEN_DIR.glob("*.json"))


@needs_db
def test_every_golden_request_has_a_file(captured):
    assert sorted(list(k) for k in captured) == _expected()


@needs_db
@pytest.mark.parametrize("caller,endpoint", _expected())
def test_response_matches_the_golden_file(captured, caller, endpoint):
    want = golden.golden_file(caller, endpoint).read_text(encoding="utf-8")
    got = captured[(caller, endpoint)]
    if got != want:
        diff = "".join(list(difflib.unified_diff(
            want.splitlines(True), got.splitlines(True), "golden", "now", n=4))[:80])
        pytest.fail(f"{caller} {endpoint}: the response differs from its golden file\n{diff}")


@needs_db
def test_the_stranger_sees_nothing(captured):
    import json

    for (caller, name), text in captured.items():
        if caller != "stranger":
            continue
        got = json.loads(text)
        if name in ("statements", "card-credit", "household-upcoming"):
            assert got["status"] == 404, (name, got["status"])
        else:
            assert got["status"] == 200, (name, got["status"])
