"""Performance budgets on the realistic dataset (STU-596).

Hard gates, exact and repeatable (the dataset and the clock are fixed, ids are
normalised out of the byte counts): per hot endpoint and caller, the SQL statements
executed, the response bytes, and the work counters ``statement_day`` calls,
``collect_events`` calls and ORM instances loaded. A ceiling is an upper bound.

CPU time is reported, not gated tightly: the median ``time.process_time`` of 5 runs
goes to the report (``PERF_BUDGETS_REPORT``: CI copies it to the job summary and
uploads it as ``perf-budgets.md``), and the owner's endpoints fail only above
``CPU_FACTOR`` times the committed baseline, to catch a catastrophe without flaking
on a shared runner.

Lowering a ceiling: a change that makes an endpoint cheaper lowers its numbers here,
to the measured result plus 10%, in the same pull request. Raising one needs a
reason in the pull request body.

Measured on the dataset of ``app/tests/fixtures/realistic.py`` (2,938 transactions,
four cards, four callers) at origin/main 1b2d92c, the day the budgets landed.
"""
import os
from typing import Dict, NamedTuple, Tuple

import pytest

from app.tests.conftest import sw_db_reachable
from app.tests.fixtures import perf
from app.tests.fixtures.realistic import CALLERS

needs_db = pytest.mark.skipif(not sw_db_reachable(), reason="DATABASE_URL not reachable")

BUILD_SECONDS_LIMIT = 30
CPU_FACTOR = 3
# Below this a 3x gate would be noise: GC, a cold cache or a busy neighbour.
CPU_FLOOR_MS = 100


class Budget(NamedTuple):
    statements: int
    bytes: int
    statement_day: int
    collect_events: int
    instances: int


# (caller, endpoint) -> ceilings. Equal to the measured values at the commit above.
BUDGETS: Dict[Tuple[str, str], Budget] = {
    ("owner", "snapshot"): Budget(609, 112_157, 496_424, 4, 9_280),
    ("owner", "installment-plans"): Budget(79, 1_963, 0, 0, 33),
    ("owner", "budget-entries"): Budget(20, 14_408, 0, 0, 31),
    ("owner", "accounts"): Budget(12, 9_876, 0, 0, 19),
    ("owner", "transactions"): Budget(17, 20_829, 0, 0, 50),
    ("owner", "statements"): Budget(17, 47_893, 29_716, 0, 435),
    ("owner", "card-credit"): Budget(63, 9_374, 29_716, 0, 491),
    ("editor", "snapshot"): Budget(347, 36_062, 188_635, 4, 3_540),
    ("editor", "installment-plans"): Budget(40, 713, 0, 0, 11),
    ("editor", "budget-entries"): Budget(17, 4_187, 0, 0, 12),
    ("editor", "accounts"): Budget(9, 1_665, 0, 0, 7),
    ("editor", "transactions"): Budget(15, 8_878, 0, 0, 28),
    ("editor", "statements"): Budget(17, 47_875, 29_716, 0, 436),
    ("viewer", "snapshot"): Budget(304, 31_604, 188_635, 4, 3_527),
    ("viewer", "installment-plans"): Budget(11, 61, 0, 0, 9),
    ("viewer", "budget-entries"): Budget(11, 39, 0, 0, 1),
    ("viewer", "accounts"): Budget(9, 1_667, 0, 0, 7),
    ("viewer", "transactions"): Budget(15, 3_824, 0, 0, 22),
    ("viewer", "statements"): Budget(17, 36_670, 29_488, 0, 434),
    ("household", "snapshot"): Budget(293, 10_590, 66_503, 3, 1_338),
    ("household", "installment-plans"): Budget(16, 61, 0, 0, 9),
    ("household", "budget-entries"): Budget(17, 39, 0, 0, 1),
    ("household", "accounts"): Budget(14, 358, 0, 0, 5),
    ("household", "transactions"): Budget(24, 4_601, 0, 0, 21),
    ("household", "household-upcoming"): Budget(84, 7_353, 21_837, 1, 446),
    ("household", "household-monthly"): Budget(112, 138, 21_837, 1, 455),
    ("household", "household-dashboard"): Budget(201, 7_740, 43_674, 2, 897),
}

# The owner's median CPU (ms) on the machine that wrote the budgets, one run at full
# CPU, nothing else running. The gate is CPU_FACTOR times this.
CPU_BASELINE_MS = {
    "snapshot": 1100, "installment-plans": 60,
    "budget-entries": 25, "accounts": 15,
    "transactions": 22, "statements": 65,
    "card-credit": 85,
}


@pytest.fixture(scope="module")
def measured(realistic, sw_client):
    """Every (caller, endpoint) of ``BUDGETS`` measured once; the report written."""
    samples: Dict[Tuple[str, str], perf.Sample] = {}
    for caller in CALLERS:
        for name, path in perf.hot_paths(realistic, caller).items():
            samples[(caller, name)] = perf.measure(
                sw_client, realistic.callers[caller].headers, path, runs=5)
    _write_report(realistic, samples)
    return samples


def _report(world, samples) -> str:
    lines = [
        "## Performance budgets", "",
        f"Realistic dataset: {world.transaction_count:,} transactions, 4 cards, built in "
        f"{world.build_seconds:.1f} s (limit {BUILD_SECONDS_LIMIT} s). Counts are exact and "
        "gated; CPU is the median of 5 runs, reported, and gated only above "
        f"{CPU_FACTOR}x the committed baseline for the owner.", "",
        "| caller | endpoint | SQL | bytes | statement_day | collect_events | instances "
        "| CPU ms | CPU baseline ms |",
        "|---|---|---|---|---|---|---|---|---|",
    ]
    for (caller, name), s in samples.items():
        base = CPU_BASELINE_MS.get(name) if caller == "owner" else None
        b = BUDGETS.get((caller, name))
        lines.append(
            f"| {caller} | {name} | {s.statements} / {b.statements if b else '-'} "
            f"| {s.bytes:,} / {f'{b.bytes:,}' if b else '-'} "
            f"| {s.statement_day:,} / {f'{b.statement_day:,}' if b else '-'} "
            f"| {s.collect_events} / {b.collect_events if b else '-'} "
            f"| {s.instances:,} / {f'{b.instances:,}' if b else '-'} "
            f"| {s.cpu_ms:.0f} | {base if base is not None else '-'} |")
    lines += ["", "Cells are measured / ceiling."]
    return "\n".join(lines) + "\n"


def _write_report(world, samples) -> None:
    path = os.environ.get("PERF_BUDGETS_REPORT")
    if path:
        with open(path, "w") as f:
            f.write(_report(world, samples))


# --- the dataset ----------------------------------------------------------------------------

@needs_db
def test_fixture_builds_within_the_time_limit(realistic):
    assert realistic.build_seconds < BUILD_SECONDS_LIMIT, (
        f"the realistic fixture took {realistic.build_seconds:.1f} s")


@needs_db
def test_fixture_has_the_agreed_shape(realistic, sw_db):
    from app.models.account import Account, AccountType
    from app.models.budget_entry import BudgetEntry
    from app.models.transaction import Transaction

    owner = realistic.callers["owner"].id
    assert 2_500 <= sw_db.query(Transaction).filter(Transaction.user_id == owner).count()
    cards = sw_db.query(Account).filter(Account.user_id == owner,
                                        Account.account_type == AccountType.CREDIT).all()
    assert len(cards) == 4
    assert sorted(c.billing_cycle_start or 0 for c in cards) == [0, 12, 20, 31]
    assert any(c.due_date and not c.billing_cycle_start for c in cards)  # the legacy card
    assert sw_db.query(BudgetEntry).filter(BudgetEntry.user_id == owner).count() >= 16
    assert set(realistic.callers) == set(CALLERS)


# --- hard gates -----------------------------------------------------------------------------

@needs_db
@pytest.mark.parametrize("caller,endpoint", sorted(BUDGETS))
def test_work_within_the_ceilings(measured, caller, endpoint):
    got, ceiling = measured[(caller, endpoint)], BUDGETS[(caller, endpoint)]
    over = {f: (getattr(got, f), getattr(ceiling, f)) for f in Budget._fields
            if getattr(got, f) > getattr(ceiling, f)}
    assert not over, f"{caller} {endpoint} over its ceiling (measured, ceiling): {over}"


@needs_db
def test_every_budgeted_request_was_measured(measured):
    assert set(measured) == set(BUDGETS)


@needs_db
@pytest.mark.parametrize("endpoint", sorted(CPU_BASELINE_MS))
def test_owner_cpu_is_not_a_catastrophe(measured, endpoint):
    cpu = measured[("owner", endpoint)].cpu_ms
    limit = max(CPU_FACTOR * CPU_BASELINE_MS[endpoint], CPU_FLOOR_MS)
    assert cpu <= limit, (f"owner {endpoint}: {cpu:.0f} ms CPU against a baseline of "
                          f"{CPU_BASELINE_MS[endpoint]} ms (limit {limit:.0f} ms)")
