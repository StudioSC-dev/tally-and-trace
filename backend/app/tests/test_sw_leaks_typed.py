"""The typed leak check (STU-659): ``sw_leaks`` flags a private id only where its kind
can appear, so ids from different tables that happen to be equal are not leaks.

Scenario names are the test names. ``i13_forced_collision`` lives with i13, in
``test_household_private_rows_integration.py``.
"""
import ast
import json
import os
import subprocess
import sys
import xml.etree.ElementTree as ET
from pathlib import Path

import pytest

from app.tests.conftest import PRIVATE, SW_REFS, sw_leaks

TESTS = Path(__file__).parent
BACKEND = TESTS.parents[1]
ID = 4242  # one number, in every table's sequence


def test_account_id_equal_to_row_id_not_flagged():
    accounts = {"account": [ID]}
    # A transaction row's own id, in a bare list and in an items envelope.
    assert sw_leaks([{"id": ID, "account": {"id": 1}}], accounts, rows="transaction") == []
    assert sw_leaks({"items": [{"id": ID}], "total": 1}, accounts, rows="transaction") == []
    # With no row-kind context the id is unclassified, so ignored.
    assert sw_leaks([{"id": ID}], accounts) == []
    # Another table's reference, a user and a plain number are not an account either.
    assert sw_leaks({"transaction_id": ID, "category_id": ID, "owner_id": ID,
                     "user_id": ID, "tag_ids": [ID], "id": ID}, accounts) == []


def test_account_id_flagged_where_accounts_appear():
    accounts = {"account": [ID]}
    for body, where in (
        ({"account_id": ID}, "$.account_id"),
        ({"transfer_to_account_id": ID}, "$.transfer_to_account_id"),
        ({"payment_account_id": ID}, "$.payment_account_id"),
        ({"account_ids": [ID]}, "$.account_ids[0]"),
        ({"hidden_account_ids": [ID]}, "$.hidden_account_ids[0]"),
        ({"account": {"id": ID}}, "$.account.id"),
        ({"payment_account": {"id": ID, "name": "x"}}, "$.payment_account.id"),
        ([{"id": 1, "account": {"id": ID}}], "$[0].account.id"),
    ):
        assert sw_leaks(body, accounts) == [(where, ID)], body
    # A list of rows named an account's, through ``refs``.
    assert sw_leaks({"accounts": [{"id": ID}]}, accounts, refs=SW_REFS) == [
        ("$.accounts[0].id", ID)]
    assert sw_leaks({"counterpart": {"id": ID}}, accounts, refs=SW_REFS) == [
        ("$.counterpart.id", ID)]
    # An id that is not the private one is no leak.
    assert sw_leaks({"account_id": ID + 1, "account": {"id": ID + 1}}, accounts) == []


def test_transaction_id_flagged_where_transactions_appear():
    txns = {"transaction": [ID]}
    assert sw_leaks([{"id": ID}], txns, rows="transaction") == [("$[0].id", ID)]
    assert sw_leaks({"items": [{"id": ID}]}, txns, rows="transaction") == [
        ("$.items[0].id", ID)]
    for body, where in (
        ({"transaction_id": ID}, "$.transaction_id"),
        ({"linked_transaction_id": ID}, "$.linked_transaction_id"),
        ({"transaction_ids": [ID]}, "$.transaction_ids[0]"),
        ({"transaction": {"id": ID}}, "$.transaction.id"),
    ):
        assert sw_leaks(body, txns) == [(where, ID)], body
    assert sw_leaks({"account_id": ID, "transfer_to_account_id": ID, "account_ids": [ID],
                     "account": {"id": ID}}, txns) == []


def test_untyped_unchanged():
    body = {"id": ID, "x_id": ID, "y_ids": [ID], "account": {"id": ID}, "amount": ID,
            "other": ID + 1, "items": [{"id": ID}]}
    expected = [("$.id", ID), ("$.x_id", ID), ("$.y_ids[0]", ID), ("$.account.id", ID),
                ("$.items[0].id", ID)]
    for private in ([ID], {ID}, (ID,), frozenset({ID})):
        assert sw_leaks(body, private) == expected
        assert sw_leaks(body, private_ids=private) == expected
    assert sw_leaks(body) == []
    # A dict keyed by id (int keys) is walked, typed or not.
    keyed = {7: {"account": {"id": ID}, "total": 1}}
    assert sw_leaks(keyed, [ID]) == [("$.7.account.id", ID)]
    assert sw_leaks(keyed, {"account": [ID]}) == [("$.7.account.id", ID)]
    # Typed context arguments need typed ids.
    with pytest.raises(ValueError):
        sw_leaks(body, [ID], rows="transaction")
    with pytest.raises(ValueError):
        sw_leaks(body, [ID], refs=SW_REFS)


KINDS = ("account", "transaction", "entry", "category", "allocation", "tag")


@pytest.mark.parametrize("kind", KINDS)
def test_other_caller_kinds_match_only_their_kind(kind):
    private = {k: [ID] if k == kind else [] for k in KINDS}
    # Positive: under the kind's own keys, as an object's id and as a row's own id.
    for body, where in (
        ({f"{kind}_id": ID}, f"$.{kind}_id"),
        ({f"parent_{kind}_id": ID}, f"$.parent_{kind}_id"),
        ({f"{kind}_ids": [ID]}, f"$.{kind}_ids[0]"),
        ({kind: {"id": ID}}, f"$.{kind}.id"),
    ):
        assert sw_leaks(body, private) == [(where, ID)], (kind, body)
    assert sw_leaks([{"id": ID}], private, rows=kind) == [("$[0].id", ID)]
    # Collision: the same number as another kind's id, or unclassified, is no leak.
    for other in KINDS:
        if other == kind:
            continue
        assert sw_leaks({f"{other}_id": ID, f"{other}_ids": [ID], other: {"id": ID}},
                        private) == [], (kind, other)
        assert sw_leaks([{"id": ID}], private, rows=other) == [], (kind, other)
    assert sw_leaks({"id": ID, "source_id": ID, "owner_id": ID, "user_id": ID}, private) == []


def test_private_strings_and_numbers_unchanged():
    body = {"name": f"{PRIVATE} gym", f"{PRIVATE}_key": 1, "nested": [{"note": f"a {PRIVATE}"}],
            "amount": 77.77, "fee": 12.3456, "ok": "fine"}
    sentinels = (77.77, 12.35)
    expected = sw_leaks(body, numbers=sentinels)
    assert [w for w, _ in expected] == ["$.name", "$", "$.nested[0].note", "$.amount", "$.fee"]
    assert sw_leaks(body, {"account": [1], "transaction": []}, numbers=sentinels) == expected
    assert sw_leaks(body, {"account": [ID]}, numbers=sentinels, rows="account") == expected
    assert sw_leaks(body, [ID], numbers=sentinels) == expected


def test_row_kind_context_boundaries():
    txns = {"transaction": [ID], "entry": [ID + 1]}
    row = {"id": ID, "detail": {"id": ID}, "lines": [{"id": ID}], "account": {"id": ID}}
    bare = sw_leaks([row], txns, rows="transaction")
    assert bare == [("$[0].id", ID)]
    envelope = sw_leaks({"items": [row], "total": 1, "id": ID}, txns, rows="transaction")
    assert envelope == [("$.items[0].id", ID)]
    # Only a root list or a root ``items``: not one nested in an object.
    assert sw_leaks({"data": {"items": [{"id": ID}]}}, txns, rows="transaction") == []
    assert sw_leaks({"data": [{"id": ID}]}, txns, rows="transaction") == []
    # No row-kind context: an unclassified id is ignored.
    assert sw_leaks([row], txns) == []
    assert sw_leaks({"items": [row]}, txns) == []
    # Context of another kind does not flag this kind's rows; its own kind does.
    assert sw_leaks([{"id": ID}], txns, rows="entry") == []
    assert sw_leaks([{"id": ID + 1}], txns, rows="entry") == [("$[0].id", ID + 1)]
    # The context covers the rows' own id and nothing nested, even under a kind key.
    nested = [{"id": 1, "transaction": {"id": ID}, "detail": {"id": ID}}]
    assert sw_leaks(nested, txns, rows="transaction") == [("$[0].transaction.id", ID)]


# --- Migration inventory ----------------------------------------------------------------

MOVED = {
    "test_card_credit_integration.py", "test_household_access_integration.py",
    "test_household_export_integration.py", "test_household_private_rows_integration.py",
    "test_household_projection_integration.py", "test_household_redaction_integration.py",
    "test_household_views_integration.py", "test_installment_review_integration.py",
    "test_recurring_missed_integration.py", "test_scheduled_list_integration.py",
    "test_shared_export_integration.py", "test_shared_projection_integration.py",
    "test_shared_redaction_integration.py", "test_upcoming_occurrences_integration.py",
}


def _private_arg(call):
    if len(call.args) > 1:
        return call.args[1]
    return next((k.value for k in call.keywords if k.arg == "private_ids"), None)


def _sw_leaks_calls():
    for path in sorted(TESTS.glob("*.py")):
        if path.name in ("conftest.py", Path(__file__).name):
            continue
        tree = ast.parse(path.read_text())
        for call in ast.walk(tree):
            if (isinstance(call, ast.Call) and isinstance(call.func, ast.Name)
                    and call.func.id == "sw_leaks" and _private_arg(call) is not None):
                yield path.name, tree, call


def _assigned(tree, name):
    return [n.value for n in ast.walk(tree) if isinstance(n, ast.Assign)
            and any(isinstance(t, ast.Name) and t.id == name for t in n.targets)]


def _params(tree):
    return {a.arg for f in ast.walk(tree) if isinstance(f, ast.FunctionDef)
            for a in f.args.args}


def _typed(tree, node):
    """Whether a private-ids argument is typed: a dict, a name assigned only dicts, a
    helper's parameter (its callers are checked as calls too) or a fixture's
    ``private_ids`` entry (a dict, checked where the fixture builds it)."""
    if isinstance(node, ast.Dict):
        return True
    if isinstance(node, ast.Name):
        values = _assigned(tree, node.id)
        return all(isinstance(v, ast.Dict) for v in values) if values else node.id in _params(tree)
    if isinstance(node, ast.Subscript):
        return isinstance(node.slice, ast.Constant) and node.slice.value == "private_ids"
    return False


def test_quality_gates():
    """Every caller of ``sw_leaks`` that passes private ids passes them typed, and the
    callers are the ones the migration moved."""
    seen, untyped = set(), []
    for name, tree, call in _sw_leaks_calls():
        seen.add(name)
        if not _typed(tree, _private_arg(call)):
            untyped.append((name, call.lineno))
    assert untyped == []
    assert seen == MOVED
    # The fixture that builds the shared ``private_ids`` holds a dict of kinds.
    redaction = ast.parse((TESTS / "test_shared_redaction_integration.py").read_text())
    built = [v for d in ast.walk(redaction) if isinstance(d, ast.Dict)
             for k, v in zip(d.keys, d.values)
             if isinstance(k, ast.Constant) and k.value == "private_ids"]
    assert built and all(isinstance(v, ast.Dict) for v in built)
    # No caller passes a literal list, set or tuple of ids.
    assert not [n for n, _, c in _sw_leaks_calls()
                if isinstance(_private_arg(c), (ast.List, ast.Set, ast.Tuple, ast.ListComp,
                                                ast.SetComp))]


# --- The regressions fail without the typed matcher -------------------------------------

REGRESSIONS = (
    "app/tests/test_sw_leaks_typed.py::test_account_id_equal_to_row_id_not_flagged",
    "app/tests/test_household_private_rows_integration.py::test_i13_forced_collision",
)


def _run(tmp_path, tag, *, reverted):
    junit, log = tmp_path / f"{tag}.xml", tmp_path / f"{tag}.jsonl"
    env = {**os.environ, "SW_REVERT_LOG": str(log)}
    command = [sys.executable, "-m", "pytest", "-q", "-p", "no:cacheprovider",
               f"--junitxml={junit}", *REGRESSIONS]
    if reverted:
        command[4:4] = ["-p", "app.tests._revert_untyped_plugin"]
    subprocess.run(command, cwd=BACKEND, env=env, capture_output=True, text=True, timeout=300)
    cases = {c.get("name"): c for c in ET.parse(junit).getroot().iter("testcase")}
    hits = [json.loads(line) for line in log.read_text().splitlines()] if log.exists() else []
    return cases, hits


def test_reverted_untyped_match_fails_regressions(tmp_path):
    from app.tests.conftest import sw_db_reachable

    if not sw_db_reachable():
        pytest.skip("DATABASE_URL not reachable")
    names = [r.split("::")[1] for r in REGRESSIONS]
    cases, hits = _run(tmp_path, "reverted", reverted=True)
    for name in names:
        assert name in cases, name
        case = cases[name]
        # A failed assertion on the leak list: not an error, a skip or a pass.
        assert case.find("failure") is not None, name
        assert case.find("error") is None and case.find("skipped") is None, name
        assert "AssertionError" in case.find("failure").get("message", "") + (
            case.find("failure").text or ""), name
        # The colliding account id was matched across kinds: the typed matcher refused it.
        assert [h for h in hits if h["test"] == name and h["kind"] == "account"], name
    cases, hits = _run(tmp_path, "typed", reverted=False)
    assert hits == []
    for name in names:
        case = cases[name]
        assert not list(case), (name, [c.tag for c in case])
