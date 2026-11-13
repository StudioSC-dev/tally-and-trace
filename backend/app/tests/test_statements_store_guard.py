"""Every bulk write to transactions or accounts is reviewed (STU-601, PERF-6, AC4).

Stored card statements are kept current by an ORM session hook
(``app/services/statements_store.py``), which a write bypassing the ORM never
reaches: ``query(...).update/delete``, Core ``insert/update/delete`` on the tables,
and raw SQL. This test scans ``app/`` (tests excluded) and ``scripts/`` for those
and fails on any site not in ``ALLOWED``, so a new one is reviewed: it either
calls ``statements_store.reset_cards`` in the same function, or is listed with
the reason it cannot change a stored statement.

A ``query(model)`` whose model is a variable is flagged too: it may be either table.
"""
import ast
import re
from pathlib import Path
from typing import List, Tuple

BACKEND = Path(__file__).resolve().parents[2]
ROOTS = (BACKEND / "app", BACKEND / "scripts")
SKIP = (BACKEND / "app" / "tests",)
LEDGER = {"Transaction", "Account"}
RAW_SQL = re.compile(
    r"\b(DELETE\s+FROM|UPDATE|INSERT\s+INTO|TRUNCATE(\s+TABLE)?)\s+\"?(transactions|accounts)\b",
    re.IGNORECASE)

# (path from backend/, enclosing function, kind) -> why it is safe.
# "reset" means the function calls statements_store.reset_cards (checked below).
ALLOWED = {
    ("app/core/seed.py", "_delete_demo_data", "query(model).delete"): "reset",
    ("app/core/seed.py", "_delete_demo_data", "query(Account).update"): "reset",
    ("app/core/seed.py", "_delete_demo_data", "query(Account).delete"): "reset",
    ("app/cutover_load/reset.py", "delete_owner_rows", "raw SQL"): "reset",
}


def _qualname(stack: List[str]) -> str:
    return ".".join(stack) or "<module>"


def _query_model(node: ast.AST):
    """The first argument of the ``query(...)`` call a method chain starts from."""
    while isinstance(node, (ast.Call, ast.Attribute)):
        if isinstance(node, ast.Call):
            func = node.func
            if isinstance(func, ast.Attribute) and func.attr == "query" and node.args:
                return node.args[0]
            node = func
        else:
            node = node.value
    return None


def _model_name(arg) -> str:
    if isinstance(arg, ast.Name):
        return arg.id
    if isinstance(arg, ast.Attribute) and arg.attr == "__table__" and isinstance(arg.value,
                                                                                 ast.Name):
        return arg.value.id
    return ast.unparse(arg)


def _risky(name: str) -> bool:
    """Transaction or Account, or anything that is not plainly another model class."""
    return name in LEDGER or not re.fullmatch(r"[A-Z][A-Za-z0-9]*", name)


class _Finder(ast.NodeVisitor):
    def __init__(self):
        self.stack: List[str] = []
        self.found: List[Tuple[str, str, int]] = []
        # Per scope: a variable holding a query chain -> its model argument.
        self.queries: List[dict] = [{}]

    def _scope(self, node):
        self.stack.append(node.name)
        self.queries.append({})
        self.generic_visit(node)
        self.queries.pop()
        self.stack.pop()

    def visit_Assign(self, node: ast.Assign):
        arg = _query_model(node.value)
        if arg is not None:
            for target in node.targets:
                if isinstance(target, ast.Name):
                    self.queries[-1][target.id] = arg
        self.generic_visit(node)

    visit_FunctionDef = visit_AsyncFunctionDef = visit_ClassDef = _scope

    def visit_Call(self, node: ast.Call):
        func = node.func
        where = _qualname(self.stack)
        if isinstance(func, ast.Attribute) and func.attr in ("update", "delete"):
            arg = _query_model(func.value)
            if arg is None and isinstance(func.value, ast.Name):
                arg = self.queries[-1].get(func.value.id)
            if arg is not None and _risky(_model_name(arg)):
                self.found.append((where, f"query({_model_name(arg)}).{func.attr}", node.lineno))
        if isinstance(func, ast.Name) and func.id in ("insert", "update", "delete") and node.args:
            name = _model_name(node.args[0])
            if name in LEDGER:
                self.found.append((where, f"{func.id}({name})", node.lineno))
        self.generic_visit(node)

    def visit_Constant(self, node: ast.Constant):
        if isinstance(node.value, str) and RAW_SQL.search(node.value):
            self.found.append((_qualname(self.stack), "raw SQL", node.lineno))


def _scan() -> dict:
    """``{(path, function, kind): [line, ...]}`` over every scanned file."""
    out: dict = {}
    for root in ROOTS:
        for path in sorted(root.rglob("*.py")):
            if any(path.is_relative_to(skip) for skip in SKIP):
                continue
            finder = _Finder()
            finder.visit(ast.parse(path.read_text(), filename=str(path)))
            rel = path.relative_to(BACKEND).as_posix()
            for where, kind, line in finder.found:
                out.setdefault((rel, where, kind), []).append(line)
    return out


def _function_source(rel: str, name: str) -> str:
    tree = ast.parse((BACKEND / rel).read_text())
    for node in ast.walk(tree):
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and node.name == name:
            return ast.unparse(node)
    raise AssertionError(f"{rel}: no function {name}")


def test_every_bulk_ledger_write_is_reviewed():
    found = _scan()
    unreviewed = {key: lines for key, lines in found.items() if key not in ALLOWED}
    assert not unreviewed, (
        "bulk writes to transactions/accounts the statement hook cannot see; call "
        "statements_store.reset_cards in that function and add it to ALLOWED: "
        + "; ".join(f"{p}:{lines} {f} {k}" for (p, f, k), lines in unreviewed.items()))


def test_the_allowlist_has_no_stale_entries():
    found = _scan()
    assert not [key for key in ALLOWED if key not in found]


def test_every_reset_entry_calls_reset_cards():
    for (rel, function, _), why in ALLOWED.items():
        if why == "reset":
            assert "statements_store.reset_cards(" in _function_source(rel, function.split(".")[-1]), \
                f"{rel} {function} is allowed as 'reset' but does not call reset_cards"


def test_the_scanner_flags_a_new_raw_delete():
    """The scan itself: a raw ``DELETE FROM transactions`` in a function is found."""
    finder = _Finder()
    finder.visit(ast.parse('def purge(db):\n    db.execute(text("DELETE FROM transactions"))\n'
                           'def bulk(db):\n    db.query(Transaction).filter().delete()\n'
                           'def core(db):\n    db.execute(update(Account).values(x=1))\n'
                           'def held(db):\n    q = db.query(Transaction).filter()\n'
                           '    q.update({"amount": 1})\n'))
    assert [(w, k) for w, k, _ in finder.found] == [
        ("purge", "raw SQL"), ("bulk", "query(Transaction).delete"), ("core", "update(Account)"),
        ("held", "query(Transaction).update")]
