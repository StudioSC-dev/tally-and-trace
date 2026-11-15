"""STU-244: a stored receipt file goes when nothing names it any more.

Deleting a transaction or uploading a new receipt over an old one removes the
old file, but only after the commit, so a rolled-back request keeps both the
file and the row's reference. Only a file ``stored_receipt_path`` accepts (in
``UPLOAD_DIR/receipts``, named for this transaction) is ever removed.
"""
import os

import pytest
from sqlalchemy.orm import Session

from app.tests.conftest import API, sw_db_reachable, sw_post

pytestmark = pytest.mark.skipif(not sw_db_reachable(), reason="DATABASE_URL not reachable")

DAY = "2026-10-01T00:00:00"
PNG = b"\x89PNG\r\n\x1a\n" + b"receipt-bytes-" * 20
NEW_PNG = b"\x89PNG\r\n\x1a\n" + b"new-receipt-" * 20


@pytest.fixture
def uploads(tmp_path, monkeypatch):
    """A throwaway upload directory, removed with ``tmp_path``."""
    from app.core.config import settings

    root = tmp_path / "uploads"
    root.mkdir()
    monkeypatch.setattr(settings, "UPLOAD_DIR", str(root))
    return root


def _call(client, who, method, path, **kwargs):
    return client.request(method, f"{API}{path}", headers=who["headers"], **kwargs)


def _debit(client, who, account, **extra):
    return sw_post(client, who, "/transactions/", {
        "account_id": account, "amount": 25, "transaction_type": "debit",
        "description": "Lunch", "transaction_date": DAY, "is_posted": True, **extra})["id"]


def _upload(client, who, txn, content=PNG):
    r = _call(client, who, "POST", f"/transactions/{txn}/upload-receipt",
              files={"file": ("r.png", content, "image/png")})
    assert r.status_code == 200, r.text


def _stored(db, txn):
    from app.models.transaction import Transaction

    db.expire_all()
    row = db.get(Transaction, txn)
    return row.receipt_url if row else None


def _file(uploads, stored):
    assert stored and stored.startswith("/uploads/receipts/"), stored
    return uploads / stored[len("/uploads/"):]


def _set_receipt(client, who, txn, value):
    r = _call(client, who, "PUT", f"/transactions/{txn}", json={"receipt_url": value})
    assert r.status_code == 200, r.text


def _receipt_bytes(client, who, txn):
    r = _call(client, who, "GET", f"/transactions/{txn}/receipt")
    assert r.status_code == 200, r.text
    return r.content


def _failing_commit(monkeypatch):
    """Every ``Session.commit`` raises, as a database refusing the commit would."""
    def fail(self):
        raise RuntimeError("simulated commit failure")
    monkeypatch.setattr(Session, "commit", fail)


def _receipt_files(uploads):
    folder = uploads / "receipts"
    return sorted(p.name for p in folder.iterdir()) if folder.exists() else []


def test_delete_transaction_removes_file(sw, sw_client, sw_db, uploads):
    """AC3."""
    a = sw["a"]
    txn = _debit(sw_client, a, sw["joint"])
    _upload(sw_client, a, txn)
    path = _file(uploads, _stored(sw_db, txn))
    assert path.is_file()
    r = _call(sw_client, a, "DELETE", f"/transactions/{txn}")
    assert r.status_code == 200, r.text
    assert _stored(sw_db, txn) is None
    assert not path.exists()
    assert _receipt_files(uploads) == []


def test_replace_receipt_removes_old_file(sw, sw_client, sw_db, uploads):
    """AC4."""
    a = sw["a"]
    txn = _debit(sw_client, a, sw["joint"])
    _upload(sw_client, a, txn)
    old = _file(uploads, _stored(sw_db, txn))
    _upload(sw_client, a, txn, NEW_PNG)
    new = _file(uploads, _stored(sw_db, txn))
    assert new != old
    assert not old.exists()
    assert new.read_bytes() == NEW_PNG
    assert _receipt_bytes(sw_client, a, txn) == NEW_PNG
    assert _receipt_files(uploads) == [new.name]


def test_receipt_kept_if_delete_rolls_back(sw, sw_client, sw_db, uploads, monkeypatch):
    """AC5: the delete's commit fails, so the row, its reference and its file stay."""
    from app.models.account import Account

    a = sw["a"]
    txn = _debit(sw_client, a, sw["joint"])
    _upload(sw_client, a, txn)
    stored = _stored(sw_db, txn)
    path = _file(uploads, stored)
    sw_db.expire_all()
    balance = sw_db.get(Account, sw["joint"]).balance
    with monkeypatch.context() as m:
        _failing_commit(m)
        with pytest.raises(RuntimeError, match="simulated commit failure"):
            _call(sw_client, a, "DELETE", f"/transactions/{txn}")
    assert _stored(sw_db, txn) == stored
    assert path.read_bytes() == PNG
    assert sw_db.get(Account, sw["joint"]).balance == balance
    assert _receipt_bytes(sw_client, a, txn) == PNG


def test_old_receipt_kept_if_replacement_rolls_back(sw, sw_client, sw_db, uploads,
                                                    monkeypatch):
    """AC5: the new upload's commit fails, so the old reference and file stay,
    and the file that was never committed is not left behind."""
    a = sw["a"]
    txn = _debit(sw_client, a, sw["joint"])
    _upload(sw_client, a, txn)
    stored = _stored(sw_db, txn)
    path = _file(uploads, stored)
    with monkeypatch.context() as m:
        _failing_commit(m)
        with pytest.raises(RuntimeError, match="simulated commit failure"):
            _call(sw_client, a, "POST", f"/transactions/{txn}/upload-receipt",
                  files={"file": ("r.png", NEW_PNG, "image/png")})
    assert _stored(sw_db, txn) == stored
    assert path.read_bytes() == PNG
    assert _receipt_files(uploads) == [path.name]
    assert _receipt_bytes(sw_client, a, txn) == PNG


def test_cleanup_ignores_foreign_paths(sw, sw_client, sw_db, uploads):
    """AC6: a stored value naming anything but this transaction's own file in
    ``UPLOAD_DIR/receipts`` is never deleted, on replace or on delete."""
    a = sw["a"]
    other = _debit(sw_client, sw["b"], sw["b_private"])
    _upload(sw_client, sw["b"], other)
    other_file = _file(uploads, _stored(sw_db, other))

    outside = uploads.parent / "outside"
    outside.mkdir()
    receipts = uploads / "receipts"

    def plant(txn):
        name = f"receipt_{txn}_x.png"
        (outside / name).write_bytes(PNG)
        (uploads / name).write_bytes(PNG)  # in the upload root, not in receipts/
        link = receipts / f"receipt_{txn}_link.png"
        os.symlink(outside / name, link)
        values = (f"/uploads/../outside/{name}",
                  f"/uploads/receipts/../../outside/{name}",
                  f"/uploads/{name}",
                  f"/uploads/receipts/{link.name}",
                  _stored(sw_db, other))  # another transaction's file
        kept = (outside / name, uploads / name, link, other_file)
        return values, kept

    for action in ("replace", "delete"):
        for index in range(5):
            txn = _debit(sw_client, a, sw["joint"])
            values, kept = plant(txn)
            _set_receipt(sw_client, a, txn, values[index])
            if action == "replace":
                _upload(sw_client, a, txn, NEW_PNG)
                assert _receipt_bytes(sw_client, a, txn) == NEW_PNG
            else:
                r = _call(sw_client, a, "DELETE", f"/transactions/{txn}")
                assert r.status_code == 200, r.text
            for path in kept:
                assert os.path.lexists(path), (action, values[index], path)
                assert path.read_bytes() == PNG
    assert _receipt_bytes(sw_client, sw["b"], other) == PNG


def test_receipt_operations_preserve_unrelated_data_and_files(sw, sw_client, sw_db,
                                                             uploads):
    """AC10: replacing and deleting touch only the one row's receipt file."""
    a = sw["a"]
    keep = _debit(sw_client, a, sw["joint"], description="Groceries",
                  invoice_url="https://example.com/invoice-keep.pdf")
    txn = _debit(sw_client, a, sw["joint"], description="Hardware",
                 invoice_url="https://example.com/invoice.pdf")
    _upload(sw_client, a, keep)
    keep_file = _file(uploads, _stored(sw_db, keep))
    _upload(sw_client, a, txn)

    def snapshot(t):
        body = _call(sw_client, a, "GET", f"/transactions/{t}").json()
        body.pop("receipt_url")
        body.pop("updated_at", None)
        return body

    before_txn, before_keep = snapshot(txn), snapshot(keep)
    _upload(sw_client, a, txn, NEW_PNG)
    assert snapshot(txn) == before_txn
    assert snapshot(keep) == before_keep
    assert keep_file.read_bytes() == PNG
    assert _receipt_bytes(sw_client, a, keep) == PNG

    r = _call(sw_client, a, "DELETE", f"/transactions/{txn}")
    assert r.status_code == 200, r.text
    assert snapshot(keep) == before_keep
    assert keep_file.read_bytes() == PNG
    assert _receipt_bytes(sw_client, a, keep) == PNG
    assert _receipt_files(uploads) == [keep_file.name]
