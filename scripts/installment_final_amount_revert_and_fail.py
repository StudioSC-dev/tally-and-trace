#!/usr/bin/env python3
"""STU-658 AC7: installment_final_amount_revert_and_fail.

Shows the final-amount tests guard the change: with it reverted they fail, and
restored they pass. Everything runs in a temporary git worktree of HEAD (never
the caller's tree), which is removed at the end.

1. ``forecast.occurrence_amount`` made to return ``amount``: the AC3 forecast
   and statement cases of ``test_occurrence_amount_reader`` (forecast,
   projection, statement_engine, stored_statements, offsets 0 and 2) must each
   FAIL on an assertion.
2. The shared split reverted to STU-631's rule (round down, the remainder on
   the first payment): the ``installment_split`` unit test ``last_lower`` must
   FAIL on an assertion.
3. Both restored: the same tests must all PASS.

Only a test that ran and failed on an assertion counts as a failure; an error
(a fixture or import error), a skip (for example an unreachable database) or a
missing test fails the check. Exits 0 when every step holds, 1 when one does
not, 2 for setup errors.

Needs ``DATABASE_URL`` pointing at a local throwaway Postgres. Before anything
else runs, the URL and the environment are vetted by the test suite's own guard
(``backend/app/tests/_db_guard.py``: a local host, a ``tt_test_*`` or
``tally_trace_test`` database, no libpq routing variable); anything else exits 2
with no database command run. Migrations are then run to head on it. Also needs
the backend's Python
(run this script with it), and pnpm with the workspace's packages in its store.

Usage, from the repo root:
  DATABASE_URL=postgresql://... SECRET_KEY=... python scripts/installment_final_amount_revert_and_fail.py
"""
import importlib.util
import json
import os
import subprocess
import sys
import tempfile
import xml.etree.ElementTree as ET
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
READER_TEST = "app/tests/test_installment_final_amount_integration.py"
READER_CASES = [f"{READER_TEST}::test_occurrence_amount_reader[{case}-offset{offset}]"
                for case in ("forecast", "projection", "statement_engine", "stored_statements")
                for offset in (0, 2)]
SPLIT_TEST_FILE = "src/utils/installmentSplit.test.ts"
SPLIT_TEST_NAME = "last_lower"

HELPER_FILE = "backend/app/services/forecast.py"
HELPER_FROM = "    if final_day is False:\n        final_day = final_occurrence_day(entry)\n"
HELPER_TO = "    return entry.amount  # AC7 revert\n" + HELPER_FROM

SPLIT_FILE = "packages/shared/src/utils/installmentSplit.ts"
SPLIT_FROM = """  // Half-up on exact integers: the remainder is at least half of `months`.
  const monthly = 2 * (totalCentavos - floor * months) >= months ? floor + 1 : floor
  const last = totalCentavos - monthly * (months - 1)
  if (monthly <= 0 || last <= 0) return null
  const payments = [...Array.from({ length: months - 1 }, () => monthly), last]
"""
SPLIT_TO = """  // AC7 revert: STU-631's rule, rounded down with the remainder on the first payment.
  const monthly = floor
  const last = floor
  if (monthly <= 0) return null
  const payments = [totalCentavos - floor * (months - 1), ...Array.from({ length: months - 1 }, () => floor)]
"""


class SetupError(Exception):
    pass


def db_guard():
    """The test suite's throwaway-database guard (stdlib-only, so loading it touches no database)."""
    spec = importlib.util.spec_from_file_location(
        "_db_guard", ROOT / "backend" / "app" / "tests" / "_db_guard.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def run(cmd, cwd, env=None, check=True):
    done = subprocess.run(cmd, cwd=cwd, env=env, capture_output=True, text=True)
    if check and done.returncode != 0:
        raise SetupError(f"{' '.join(cmd)} exited {done.returncode}:\n{done.stdout[-2000:]}{done.stderr[-2000:]}")
    return done


def patch(tree: Path, rel: str, old: str, new: str) -> None:
    path = tree / rel
    text = path.read_text(encoding="utf-8")
    if text.count(old) != 1:
        raise SetupError(f"the code to revert is not in {rel} exactly once")
    path.write_text(text.replace(old, new), encoding="utf-8")


def restore(tree: Path, rel: str) -> None:
    run(["git", "checkout", "--", rel], cwd=tree)


def backend_env() -> dict:
    env = {k: v for k, v in os.environ.items() if k not in ("PGHOST", "PGPORT", "PGDATABASE")}
    env.setdefault("SECRET_KEY", "local-revert-and-fail-only")
    env.setdefault("ENVIRONMENT", "development")
    return env


def reader_outcomes(tree: Path, scratch: Path, label: str) -> dict:
    """``{test id: passed|failed|error|skipped}`` for READER_CASES, from pytest's junit file."""
    report = scratch / f"{label}.xml"
    run([sys.executable, "-m", "pytest", "-p", "no:cacheprovider", "-q", "-W", "ignore",
         "-p", "no:logging", f"--junitxml={report}", *READER_CASES],
        cwd=tree / "backend", env=backend_env(), check=False)
    if not report.exists():
        raise SetupError(f"pytest wrote no report for {label}")
    out = {}
    for case in ET.parse(report).getroot().iter("testcase"):
        name = f"{READER_TEST}::{case.get('name')}"
        kinds = {child.tag for child in case}
        failure = case.find("failure")
        if "error" in kinds:
            out[name] = "error"
        elif "skipped" in kinds:
            out[name] = "skipped"
        elif failure is not None:
            # An assertion, not a crash inside the test body.
            text = (failure.get("message") or "") + (failure.text or "")
            out[name] = "failed" if "AssertionError" in text or "assert " in text else "error"
        else:
            out[name] = "passed"
    return out


def split_outcome(tree: Path, scratch: Path, label: str) -> str:
    """``last_lower``'s outcome from vitest's JSON report: passed, failed, error or missing."""
    report = scratch / f"{label}.json"
    env = {**os.environ, "TZ": "Asia/Manila"}
    run(["pnpm", "exec", "vitest", "run", SPLIT_TEST_FILE, "-t", SPLIT_TEST_NAME,
         "--reporter=json", f"--outputFile={report}"],
        cwd=tree / "packages/shared", env=env, check=False)
    if not report.exists():
        raise SetupError(f"vitest wrote no report for {label}")
    body = json.loads(report.read_text(encoding="utf-8"))
    found = [t for f in body.get("testResults", []) for t in f.get("assertionResults", [])
             if SPLIT_TEST_NAME in t.get("title", "")]
    if len(found) != 1:
        return "missing"
    test = found[0]
    if test.get("status") == "passed":
        return "passed"
    if test.get("status") == "failed":
        messages = " ".join(test.get("failureMessages") or [])
        return "failed" if "AssertionError" in messages or "expected" in messages else "error"
    return test.get("status") or "missing"


def main() -> int:
    # The conftest's rule, on the URL and the environment every database command runs with.
    guard = db_guard()
    refusal = (guard.check_test_database_url(os.environ.get("DATABASE_URL", ""))
               or guard.check_environment(backend_env()))
    if refusal:
        print(f"refusing to run: {refusal} (a local throwaway database is required)", file=sys.stderr)
        return 2
    own_status = run(["git", "status", "--porcelain"], cwd=ROOT).stdout
    head = run(["git", "rev-parse", "--short", "HEAD"], cwd=ROOT).stdout.strip()
    scratch = Path(tempfile.mkdtemp(prefix="final-amount-r-a-f-"))
    tree = scratch / "tree"
    results = []

    def record(step, ok, detail):
        results.append((step, ok, detail))
        print(f"  [{'PASS' if ok else 'FAIL'}] {step}: {detail}")

    try:
        run(["git", "worktree", "add", "--detach", str(tree), "HEAD"], cwd=ROOT)
        run(["pnpm", "install", "--frozen-lockfile", "--offline", "--filter", "./packages/shared"], cwd=tree)
        run([sys.executable, "-m", "alembic", "upgrade", "head"], cwd=tree / "backend", env=backend_env())
        print(f"installment_final_amount_revert_and_fail at {head} (temporary worktree {tree})")

        print("\n1. occurrence_amount returns amount")
        patch(tree, HELPER_FILE, HELPER_FROM, HELPER_TO)
        got = reader_outcomes(tree, scratch, "reader-reverted")
        missing = [c for c in READER_CASES if c not in got]
        not_failed = {c.split("::")[1]: s for c, s in got.items() if s != "failed"}
        record("reader cases fail with the helper reverted",
               not missing and not not_failed and len(got) == len(READER_CASES),
               f"{sum(s == 'failed' for s in got.values())}/{len(READER_CASES)} failed on an assertion"
               + (f"; not failed: {not_failed}" if not_failed else "")
               + (f"; missing: {missing}" if missing else ""))
        restore(tree, HELPER_FILE)

        print("\n2. the shared split rounds down with the remainder on the first payment")
        patch(tree, SPLIT_FILE, SPLIT_FROM, SPLIT_TO)
        outcome = split_outcome(tree, scratch, "split-reverted")
        record("last_lower fails with the split reverted", outcome == "failed", f"last_lower {outcome}")
        restore(tree, SPLIT_FILE)

        print("\n3. both restored")
        got = reader_outcomes(tree, scratch, "reader-restored")
        not_passed = {c.split("::")[1]: s for c, s in got.items() if s != "passed"}
        record("reader cases pass restored", len(got) == len(READER_CASES) and not not_passed,
               f"{sum(s == 'passed' for s in got.values())}/{len(READER_CASES)} passed"
               + (f"; not passed: {not_passed}" if not_passed else ""))
        outcome = split_outcome(tree, scratch, "split-restored")
        record("last_lower passes restored", outcome == "passed", f"last_lower {outcome}")
        clean = run(["git", "status", "--porcelain"], cwd=tree).stdout == ""
        record("temporary worktree restored", clean, "no changes left" if clean else "changes left")
    except SetupError as error:
        print(f"setup error: {error}", file=sys.stderr)
        return 2
    finally:
        run(["git", "worktree", "remove", "--force", str(tree)], cwd=ROOT, check=False)
        run(["rm", "-rf", str(scratch)], cwd=ROOT, check=False)

    untouched = run(["git", "status", "--porcelain"], cwd=ROOT).stdout == own_status
    record("caller's tree untouched", untouched, "unchanged" if untouched else "CHANGED")
    ok = all(passed for _, passed, _ in results)
    print(f"\ninstallment_final_amount_revert_and_fail: {'PASS' if ok else 'FAIL'} "
          f"({sum(p for _, p, _ in results)}/{len(results)} checks)")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
