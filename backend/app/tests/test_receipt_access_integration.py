"""Shared accounts (STU-232): receipt files are served only behind the record rules.

A receipt is the creator's (like ``receipt_url``, which only the ``full`` view
carries), so ``GET /transactions/{id}/receipt`` returns the file to a caller who
sees the transaction in full and the record routes' uniform 404 to everyone
else. Uploads are never served as static files.
"""
import os
import re
import subprocess
import sys
import textwrap
from pathlib import Path

import pytest

from app.tests.conftest import API, sw_db_reachable, sw_post

pytestmark = pytest.mark.skipif(not sw_db_reachable(), reason="DATABASE_URL not reachable")

DAY = "2026-10-01T00:00:00"
NOT_FOUND = {"detail": "Transaction not found"}
PNG = b"\x89PNG\r\n\x1a\n" + b"receipt-bytes-" * 20


@pytest.fixture
def uploads(tmp_path, monkeypatch):
    """A throwaway upload directory, removed with ``tmp_path``."""
    from app.core.config import settings

    root = tmp_path / "uploads"
    root.mkdir()
    monkeypatch.setattr(settings, "UPLOAD_DIR", str(root))
    return root


def _call(client, who, method, path, **kwargs):
    headers = who["headers"] if who else {}
    return client.request(method, f"{API}{path}", headers=headers, **kwargs)


def _debit(client, who, account):
    return sw_post(client, who, "/transactions/", {
        "account_id": account, "amount": 25, "transaction_type": "debit",
        "description": "Lunch", "transaction_date": DAY, "is_posted": True})["id"]


def _upload(client, who, txn, content=PNG, name="r.png"):
    r = _call(client, who, "POST", f"/transactions/{txn}/upload-receipt",
              files={"file": (name, content, "image/png")})
    assert r.status_code == 200, r.text
    return r.json()


def _stored(db, txn):
    from app.models.transaction import Transaction

    db.expire_all()
    return db.get(Transaction, txn).receipt_url


def _set_receipt(client, who, txn, value):
    r = _call(client, who, "PUT", f"/transactions/{txn}", json={"receipt_url": value})
    assert r.status_code == 200, r.text


def _refused(client, who, txn):
    r = _call(client, who, "GET", f"/transactions/{txn}/receipt")
    assert (r.status_code, r.json()) == (404, NOT_FOUND), (who and who["id"], r.text)


def test_the_creator_in_full_view_gets_the_exact_file(sw, sw_client, sw_db, uploads):
    a = sw["a"]
    txn = _debit(sw_client, a, sw["joint"])
    out = _upload(sw_client, a, txn)
    route = f"{API}/transactions/{txn}/receipt"
    assert out["file_url"] == route
    r = _call(sw_client, a, "GET", f"/transactions/{txn}/receipt")
    assert r.status_code == 200 and r.content == PNG
    assert r.headers["content-type"] == "image/png"
    assert r.headers["cache-control"] == "private, no-store"
    assert _call(sw_client, a, "GET", f"/transactions/{txn}").json()["receipt_url"] == route


def test_new_uploads_get_random_names(sw, sw_client, sw_db, uploads):
    a = sw["a"]
    txn = _debit(sw_client, a, sw["joint"])
    _upload(sw_client, a, txn)
    first = _stored(sw_db, txn)
    _upload(sw_client, a, txn)
    second = _stored(sw_db, txn)
    pattern = rf"^/uploads/receipts/receipt_{txn}_[A-Za-z0-9_-]{{32}}\.png$"
    assert re.match(pattern, first) and re.match(pattern, second) and first != second
    assert not re.search(r"\d{8}_\d{6}", second)  # no timestamp to guess from


@pytest.mark.parametrize("who", ["b", "v", "d", "s"])
def test_everyone_else_gets_the_same_404(sw, sw_client, sw_db, uploads, who):
    """The SharedFull editor and admin, the Limited viewer and a stranger."""
    txn = _debit(sw_client, sw["a"], sw["joint"])
    _upload(sw_client, sw["a"], txn)
    _refused(sw_client, sw[who], txn)
    record = _call(sw_client, sw[who], "GET", f"/transactions/{txn}")
    if record.status_code == 200:
        assert "receipt_url" not in record.json()
    missing = _call(sw_client, sw[who], "GET", "/transactions/2147483000")
    assert (missing.status_code, missing.json()) == (404, NOT_FOUND)


def test_anonymous_callers_get_what_other_routes_give(sw, sw_client, sw_db, uploads):
    txn = _debit(sw_client, sw["a"], sw["joint"])
    _upload(sw_client, sw["a"], txn)
    file = _call(sw_client, None, "GET", f"/transactions/{txn}/receipt")
    record = _call(sw_client, None, "GET", f"/transactions/{txn}")
    assert file.status_code == record.status_code == 401
    assert file.json() == record.json()


def test_a_creator_who_loses_the_full_view_loses_the_file(sw, sw_client, sw_db, uploads):
    """Bea (editor) adds a receipt to her own record on the joint account. As a
    viewer she still sees it in full, so she keeps the file; once revoked she
    gets the 404. The account owner never sees her receipt (SharedFull)."""
    from app.models.account_share import AccountShare

    b = sw["b"]
    txn = _debit(sw_client, b, sw["joint"])
    _upload(sw_client, b, txn)
    assert _call(sw_client, b, "GET", f"/transactions/{txn}/receipt").content == PNG
    _refused(sw_client, sw["a"], txn)

    share = sw_db.get(AccountShare, sw["shares"]["b"])
    share.role = "viewer"
    sw_db.commit()
    record = _call(sw_client, b, "GET", f"/transactions/{txn}").json()
    assert record["view"] == "full" and record["receipt_url"]
    assert _call(sw_client, b, "GET", f"/transactions/{txn}/receipt").content == PNG

    sw_db.delete(sw_db.get(AccountShare, sw["shares"]["b"]))
    sw_db.commit()
    _refused(sw_client, b, txn)


def test_a_creator_without_the_full_view_of_a_transfer_is_refused(sw, sw_client, sw_db,
                                                                   uploads):
    """Bea's transfer from her bank into the joint account: revoking her share
    leaves her able to read it (her own account) but not in full."""
    b = sw["b"]
    txn = sw_post(sw_client, b, "/transactions/", {
        "account_id": sw["b_private"], "transfer_from_account_id": sw["b_private"],
        "transfer_to_account_id": sw["joint"], "amount": 30, "transaction_type": "transfer",
        "description": "Top up", "transaction_date": DAY, "is_posted": True})["id"]
    _upload(sw_client, b, txn)
    assert _call(sw_client, b, "GET", f"/transactions/{txn}/receipt").status_code == 200
    from app.models.account_share import AccountShare

    sw_db.delete(sw_db.get(AccountShare, sw["shares"]["b"]))
    sw_db.commit()
    record = _call(sw_client, b, "GET", f"/transactions/{txn}")
    assert record.status_code == 200 and record.json()["view"] == "limited"
    _refused(sw_client, b, txn)


def test_guessed_missing_and_foreign_files_are_refused(sw, sw_client, sw_db, uploads):
    a = sw["a"]
    txn = _debit(sw_client, a, sw["joint"])
    _refused(sw_client, a, txn)  # no receipt at all
    _refused(sw_client, a, 2147483000)  # no such transaction
    _set_receipt(sw_client, a, txn, f"/uploads/receipts/receipt_{txn}_guess.png")
    _refused(sw_client, a, txn)  # no such file
    _set_receipt(sw_client, a, txn, "https://example.com/receipt.png")
    assert _call(sw_client, a, "GET", f"/transactions/{txn}").json()["receipt_url"] == \
        "https://example.com/receipt.png"  # an external link is returned as entered
    _refused(sw_client, a, txn)

    # Another user's file, named in the creator's own row, is not served: a
    # file belongs to the transaction its name carries.
    other = _debit(sw_client, sw["b"], sw["b_private"])
    _upload(sw_client, sw["b"], other)
    _set_receipt(sw_client, a, txn, _stored(sw_db, other))
    _refused(sw_client, a, txn)


def test_a_stored_path_outside_the_upload_directory_is_refused(sw, sw_client, sw_db,
                                                                uploads):
    a = sw["a"]
    txn = _debit(sw_client, a, sw["joint"])
    outside = uploads.parent / "outside"
    outside.mkdir()
    name = f"receipt_{txn}_x.png"
    (outside / name).write_bytes(PNG)
    (uploads / name).write_bytes(PNG)  # in the upload root, not in receipts/
    (uploads / "receipts").mkdir()
    os.symlink(outside / name, uploads / "receipts" / f"receipt_{txn}_link.png")
    for value in (f"/uploads/../outside/{name}",
                  f"/uploads/receipts/../../outside/{name}",
                  f"/uploads/receipts/..%2F..%2Foutside/{name}",
                  f"/uploads/{name}",
                  f"/uploads/receipts/receipt_{txn}_link.png"):
        _set_receipt(sw_client, a, txn, value)
        _refused(sw_client, a, txn)


def test_sending_the_shown_url_back_keeps_the_receipt(sw, sw_client, sw_db, uploads):
    a = sw["a"]
    txn = _debit(sw_client, a, sw["joint"])
    _upload(sw_client, a, txn)
    stored = _stored(sw_db, txn)
    shown = _call(sw_client, a, "GET", f"/transactions/{txn}").json()["receipt_url"]
    _set_receipt(sw_client, a, txn, shown)
    assert _stored(sw_db, txn) == stored
    assert _call(sw_client, a, "GET", f"/transactions/{txn}/receipt").content == PNG


def test_rows_from_before_keep_working_through_the_route(sw, sw_client, sw_db, uploads):
    """A row stored with the old timestamped name is served by the route too."""
    from app.models.transaction import Transaction

    a = sw["a"]
    txn = _debit(sw_client, a, sw["joint"])
    (uploads / "receipts").mkdir()
    name = f"receipt_{txn}_20260101_120000.png"
    (uploads / "receipts" / name).write_bytes(PNG)
    row = sw_db.get(Transaction, txn)
    row.receipt_url = f"/uploads/receipts/{name}"
    sw_db.commit()
    assert _call(sw_client, a, "GET", f"/transactions/{txn}").json()["receipt_url"] == \
        f"{API}/transactions/{txn}/receipt"
    assert _call(sw_client, a, "GET", f"/transactions/{txn}/receipt").content == PNG
    _refused(sw_client, sw["b"], txn)


def test_the_old_static_url_serves_nothing(tmp_path):
    """Even with the upload directory present when the app is built."""
    root = tmp_path / "uploads"
    (root / "receipts").mkdir(parents=True)
    (root / "receipts" / "receipt_1_20260101_120000.png").write_bytes(PNG)
    backend = Path(__file__).resolve().parents[2]
    script = textwrap.dedent("""
        from fastapi.testclient import TestClient
        from app.main import app
        r = TestClient(app).get("/uploads/receipts/receipt_1_20260101_120000.png")
        mounted = any(getattr(rt, "path", "").startswith("/uploads") for rt in app.routes)
        print("RESULT", r.status_code, mounted)
    """)
    env = {**os.environ, "UPLOAD_DIR": str(root), "PYTHONPATH": str(backend)}
    # Run outside backend/ so its .env is not read.
    out = subprocess.run([sys.executable, "-c", script], cwd=tmp_path, env=env,
                         capture_output=True, text=True, timeout=120)
    assert out.returncode == 0, out.stderr
    assert "RESULT 404 False" in out.stdout.splitlines(), out.stdout
