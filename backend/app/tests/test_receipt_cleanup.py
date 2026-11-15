"""STU-642: a PUT that replaces a stored receipt reference removes the old file.

A transaction edit has no Undo (the web app marks only creates undoable, and the
API keeps no undo record for a PUT), so the superseded file goes right after the
commit, through the same ``remove_stored_receipt`` guard STU-244 uses. A failed
commit keeps it, and anything ``stored_receipt_path`` refuses is never touched.
"""
import os

import pytest

from app.tests import test_receipt_cleanup_integration as stu244
from app.tests.conftest import sw_db_reachable
from app.tests.test_receipt_cleanup_integration import (  # noqa: F401  (fixtures + helpers)
    NEW_PNG, PNG, _call, _debit, _failing_commit, _file, _receipt_bytes, _receipt_files,
    _set_receipt, _stored, _upload, uploads,
)

pytestmark = pytest.mark.skipif(not sw_db_reachable(), reason="DATABASE_URL not reachable")

STU244_TESTS = (
    stu244.test_delete_transaction_removes_file,
    stu244.test_replace_receipt_removes_old_file,
    stu244.test_receipt_kept_if_delete_rolls_back,
    stu244.test_old_receipt_kept_if_replacement_rolls_back,
    stu244.test_cleanup_ignores_foreign_paths,
    stu244.test_receipt_operations_preserve_unrelated_data_and_files,
)


def _second_stored(uploads, txn):
    """A second stored receipt file for ``txn``, as an upload would have left it."""
    name = f"receipt_{txn}_second.png"
    (uploads / "receipts" / name).write_bytes(NEW_PNG)
    return f"/uploads/receipts/{name}", uploads / "receipts" / name


def test_put_replaced_receipt_removed(sw, sw_client, sw_db, uploads):
    """AC1."""
    a = sw["a"]
    txn = _debit(sw_client, a, sw["joint"])
    _upload(sw_client, a, txn)
    old = _file(uploads, _stored(sw_db, txn))
    new_ref, new = _second_stored(uploads, txn)
    _set_receipt(sw_client, a, txn, new_ref)
    assert _stored(sw_db, txn) == new_ref
    assert not old.exists()
    assert new.read_bytes() == NEW_PNG
    assert _receipt_files(uploads) == [new.name]
    assert _receipt_bytes(sw_client, a, txn) == NEW_PNG


def test_put_rollback_keeps_old_receipt(sw, sw_client, sw_db, uploads, monkeypatch):
    """AC2."""
    a = sw["a"]
    txn = _debit(sw_client, a, sw["joint"])
    _upload(sw_client, a, txn)
    stored = _stored(sw_db, txn)
    old = _file(uploads, stored)
    new_ref, new = _second_stored(uploads, txn)
    with monkeypatch.context() as m:
        _failing_commit(m)
        with pytest.raises(RuntimeError, match="simulated commit failure"):
            _call(sw_client, a, "PUT", f"/transactions/{txn}", json={"receipt_url": new_ref})
    assert _stored(sw_db, txn) == stored
    assert old.read_bytes() == PNG
    assert new.exists()
    assert _receipt_bytes(sw_client, a, txn) == PNG


def test_put_replaced_external_receipt_not_deleted(sw, sw_client, sw_db, uploads):
    """AC3: replacing an external link, or a path outside the store, deletes nothing."""
    a = sw["a"]
    other = _debit(sw_client, sw["b"], sw["b_private"])
    _upload(sw_client, sw["b"], other)
    other_file = _file(uploads, _stored(sw_db, other))
    outside = uploads.parent / "outside"
    outside.mkdir()

    txn = _debit(sw_client, a, sw["joint"])
    name = f"receipt_{txn}_x.png"
    (outside / name).write_bytes(PNG)
    (uploads / name).write_bytes(PNG)  # in the upload root, not in receipts/
    link = uploads / "receipts" / f"receipt_{txn}_link.png"
    os.symlink(outside / name, link)
    olds = ("https://example.com/receipt.png",
            f"/uploads/../outside/{name}",
            f"/uploads/{name}",
            f"/uploads/receipts/{link.name}",
            _stored(sw_db, other))  # another transaction's file
    for old in olds:
        _set_receipt(sw_client, a, txn, old)
        _set_receipt(sw_client, a, txn, "https://example.com/other.png")
        assert _stored(sw_db, txn) == "https://example.com/other.png"
        for path in (outside / name, uploads / name, other_file):
            assert path.read_bytes() == PNG, old
        assert os.path.lexists(link), old
    assert _receipt_bytes(sw_client, sw["b"], other) == PNG


def test_put_without_receipt_change_keeps_file(sw, sw_client, sw_db, uploads):
    """AC4: no receipt in the body, the same value, or the route form sent back."""
    a = sw["a"]
    txn = _debit(sw_client, a, sw["joint"])
    _upload(sw_client, a, txn)
    stored = _stored(sw_db, txn)
    path = _file(uploads, stored)
    route = f"/api/v1/transactions/{txn}/receipt"
    bodies = ({"description": "Renamed"}, {"receipt_url": stored}, {"receipt_url": route})
    for body in bodies:
        r = _call(sw_client, a, "PUT", f"/transactions/{txn}", json=body)
        assert r.status_code == 200, r.text
        assert _stored(sw_db, txn) == stored, body
        assert path.read_bytes() == PNG, body
    assert _receipt_bytes(sw_client, a, txn) == PNG


def test_stu244_cleanup_regressions(sw, sw_client, sw_db, uploads, tmp_path_factory,
                                    monkeypatch):
    """AC5: STU-244's own tests, called unchanged against fresh upload directories."""
    from app.core.config import settings

    for index, test in enumerate(STU244_TESTS):
        root = tmp_path_factory.mktemp(f"stu244_{index}") / "uploads"
        root.mkdir()
        monkeypatch.setattr(settings, "UPLOAD_DIR", str(root))
        params = test.__code__.co_varnames[:test.__code__.co_argcount]
        values = {"sw": sw, "sw_client": sw_client, "sw_db": sw_db, "uploads": root,
                  "monkeypatch": monkeypatch}
        test(**{name: values[name] for name in params})


def test_put_receipt_cleanup_preserves_unrelated_data_and_files(sw, sw_client, sw_db,
                                                               uploads):
    """AC7."""
    from app.models.account import Account

    a = sw["a"]
    keep = _debit(sw_client, a, sw["joint"], description="Groceries",
                  invoice_url="https://example.com/invoice-keep.pdf")
    txn = _debit(sw_client, a, sw["joint"], description="Hardware",
                 invoice_url="https://example.com/invoice.pdf")
    _upload(sw_client, a, keep)
    keep_file = _file(uploads, _stored(sw_db, keep))
    _upload(sw_client, a, txn)
    old = _file(uploads, _stored(sw_db, txn))
    new_ref, new = _second_stored(uploads, txn)

    def snapshot(t):
        body = _call(sw_client, a, "GET", f"/transactions/{t}").json()
        body.pop("receipt_url")
        body.pop("updated_at", None)
        return body

    def balance():
        sw_db.expire_all()
        return sw_db.get(Account, sw["joint"]).balance

    before_txn, before_keep, before_balance = snapshot(txn), snapshot(keep), balance()
    _set_receipt(sw_client, a, txn, new_ref)
    assert not old.exists()
    assert snapshot(txn) == before_txn
    assert snapshot(keep) == before_keep
    assert balance() == before_balance
    assert keep_file.read_bytes() == PNG
    assert new.read_bytes() == NEW_PNG
    assert _receipt_bytes(sw_client, a, keep) == PNG
    assert _receipt_files(uploads) == sorted([keep_file.name, new.name])
