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


# (caller, endpoint) -> ceilings. Set at the measured values at the commit above, then
# lowered by STU-597 (access as data) to its measured result plus 10% (the owner's
# snapshot to the epic's 350 target); a figure already within 10% stays. The household
# snapshot's instances rose by one there: accounts load when a response names them,
# not when roles are checked, so one account is loaded again after it was released.
BUDGETS: Dict[Tuple[str, str], Budget] = {
    ("owner", "snapshot"): Budget(350, 111_157, 8_985, 4, 9_280),
    ("owner", "installment-plans"): Budget(69, 1_963, 0, 0, 26),
    ("owner", "budget-entries"): Budget(19, 14_408, 0, 0, 29),
    ("owner", "accounts"): Budget(11, 9_876, 0, 0, 16),
    ("owner", "transactions"): Budget(16, 20_829, 0, 0, 38),
    ("owner", "statements"): Budget(13, 47_893, 431, 0, 435),
    ("owner", "card-credit"): Budget(54, 9_374, 431, 0, 491),
    ("editor", "snapshot"): Budget(291, 36_062, 3_463, 4, 3_540),
    ("editor", "installment-plans"): Budget(40, 713, 0, 0, 8),
    ("editor", "budget-entries"): Budget(17, 4_187, 0, 0, 10),
    ("editor", "accounts"): Budget(9, 1_665, 0, 0, 5),
    ("editor", "transactions"): Budget(15, 8_878, 0, 0, 27),
    ("editor", "statements"): Budget(17, 47_875, 431, 0, 436),
    ("viewer", "snapshot"): Budget(250, 31_604, 3_463, 4, 3_527),
    ("viewer", "installment-plans"): Budget(9, 61, 0, 0, 5),
    ("viewer", "budget-entries"): Budget(11, 39, 0, 0, 1),
    ("viewer", "accounts"): Budget(9, 1_667, 0, 0, 5),
    ("viewer", "transactions"): Budget(15, 3_824, 0, 0, 21),
    ("viewer", "statements"): Budget(17, 36_670, 427, 0, 434),
    ("household", "snapshot"): Budget(232, 10_590, 1_370, 3, 1_339),
    ("household", "installment-plans"): Budget(13, 61, 0, 0, 5),
    ("household", "budget-entries"): Budget(17, 39, 0, 0, 1),
    ("household", "accounts"): Budget(13, 358, 0, 0, 5),
    ("household", "transactions"): Budget(24, 4_601, 0, 0, 21),
    ("household", "household-upcoming"): Budget(71, 7_353, 455, 1, 446),
    ("household", "household-monthly"): Budget(100, 138, 455, 1, 455),
    ("household", "household-dashboard"): Budget(173, 7_740, 909, 2, 897),
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


# --- the awkward cases and the access relationships the budgets depend on --------------------
# The ceilings are upper bounds, so a fixture that quietly lost one of these would still
# pass them. These fail instead.

API = "/api/v1"


def _statements(client, world, caller, card):
    r = client.get(f"{API}/accounts/{card}/statements", headers=world.callers[caller].headers)
    assert r.status_code == 200, (caller, r.status_code, r.text[:200])
    return r.json()


def _items(body):
    return body if isinstance(body, list) else body.get("items", body.get("statements", []))


@needs_db
def test_fixture_contains_the_awkward_statement_cases(realistic, sw_db, sw_client):
    from app.models.account import Account
    from app.models.budget_entry import BudgetEntry
    from app.models.card_statement_due_override import CardStatementDueOverride
    from app.models.transaction import Transaction, TransactionType
    from app.services.statements import statement_close

    w, acc, today = realistic, realistic.accounts, realistic.today
    owner = w.callers["owner"].id

    # Posted late: the bank posted the charge after the statement its own day belongs to closed.
    late = 0
    for t in sw_db.query(Transaction).filter(Transaction.user_id == owner,
                                              Transaction.posting_date.isnot(None)):
        card = sw_db.get(Account, t.account_id)
        if t.posting_date.date() > statement_close(card, t.transaction_date.date()):
            late += 1
    assert late >= 15

    # Refunds exceeding charges: the engine itself reports credit (negative) statements on the
    # card the refunds were put on, one closed and one still open.
    credits = [s for s in _items(_statements(sw_client, w, "owner", acc["card_c"]))
               if s["statement_balance"] < 0]
    assert len(credits) >= 2

    # A cash advance (a transfer out of a card, with a fee), settled and planned.
    advances = sw_db.query(Transaction).filter(
        Transaction.transfer_from_account_id == acc["card_b"],
        Transaction.transaction_type == TransactionType.TRANSFER, Transaction.transfer_fee > 0)
    assert {a.is_posted for a in advances} == {True, False}

    # A payment into a card, in the cycle that is still open on today.
    card_d = sw_db.get(Account, acc["card_d"])
    payments = sw_db.query(Transaction).filter(Transaction.transfer_to_account_id == card_d.id,
                                               Transaction.is_posted.is_(True)).all()
    assert any(statement_close(card_d, p.transaction_date.date()) == statement_close(card_d, today)
               for p in payments)

    # An unposted foreign-currency charge on a card.
    foreign = sw_db.query(Transaction).filter(
        Transaction.user_id == owner, Transaction.is_posted.is_(False),
        Transaction.projected_currency.isnot(None),
        Transaction.account_id.in_([acc[k] for k in ("card_a", "card_b", "card_c", "card_d")]))
    assert foreign.count() >= 1

    # Due-date overrides on two cards.
    overridden = {o.account_id for o in sw_db.query(CardStatementDueOverride).filter(
        CardStatementDueOverride.account_id.in_(
            [acc[k] for k in ("card_a", "card_b", "card_c", "card_d")]))}
    assert overridden == {acc["card_a"], acc["card_c"]}

    # The legacy (due_date only) and close-day-31 cards.
    legacy = sw_db.get(Account, acc["card_c"])
    assert legacy.due_date and not legacy.billing_cycle_start
    assert sw_db.get(Account, acc["card_d"]).billing_cycle_start == 31

    # Installments on cards.
    cards = [acc[k] for k in ("card_a", "card_b", "card_c", "card_d")]
    assert sw_db.query(BudgetEntry).filter(
        BudgetEntry.user_id == owner, BudgetEntry.end_mode == "after_occurrences",
        BudgetEntry.account_id.in_(cards)).count() >= 6


@needs_db
def test_fixture_access_relationships(realistic, sw_client, sw_people):
    w, acc = realistic, realistic.accounts
    mine = set(acc.values())

    def visible(who_headers):
        r = sw_client.get(f"{API}/accounts/?limit=100", headers=who_headers)
        assert r.status_code == 200, r.text
        return {a["id"] for a in _items(r.json())}

    # The editor sees the shared card and reads its statements in full.
    assert acc["card_a"] in visible(w.callers["editor"].headers)
    full = _items(_statements(sw_client, w, "editor", acc["card_a"]))
    assert full and all("statement_balance" in s for s in full)

    # The viewer sees the card shared to it, as the limited view: no balance, no row ids.
    assert acc["card_d"] in visible(w.callers["viewer"].headers)
    limited = _items(_statements(sw_client, w, "viewer", acc["card_d"]))
    assert limited and not any("statement_balance" in s for s in limited)
    assert not any("transaction_id" in line for s in limited for line in s["lines"])

    # The household member sees the household-tagged card, and not the untagged ones.
    seen = visible(w.callers["household"].headers)
    assert acc["card_b"] in seen
    assert acc["card_a"] not in seen and acc["card_c"] not in seen

    # A stranger sees none of it.
    stranger = sw_people("Sam", "Stranger")
    assert not (visible(stranger["headers"]) & mine)
    r = sw_client.get(f"{API}/accounts/{acc['card_a']}/statements", headers=stranger["headers"])
    assert r.status_code == 404


# --- stored statements: the snapshot does not grow with history (STU-601, PERF-6, AC7) -------

HISTORY_SLACK = 5


def _snapshot_with_history(client, db, today, years: int) -> perf.Sample:
    from app.tests.fixtures import realistic as fixture

    patch = pytest.MonkeyPatch()
    patch.setattr(fixture, "HISTORY_DAYS", 365 * years)
    patch.setattr(fixture, "BASE_ROWS", 1400 * years)
    world = None
    try:
        world = fixture.build_realistic(client, db, today, tag=f"h{years}y")
        return perf.measure(client, world.callers["owner"].headers, "/dashboard/snapshot",
                            runs=1)
    finally:
        patch.undo()
        if world is not None:
            world.remove(db)


@needs_db
def test_the_snapshot_does_not_grow_with_history(realistic, sw_client):
    """With closed statements stored, the snapshot runs the same number of SQL
    statements over four years of history as over one (within ``HISTORY_SLACK``), and
    its ``statement_day`` calls stay bounded by the rows not yet in a stored statement
    (open cycles and unposted rows): at most 2,000. The clock is pinned by
    ``realistic``. Replaying every row (``STATEMENTS_STORE=off``) makes 16,158 calls."""
    from app.core.database import SessionLocal

    db = SessionLocal()
    try:
        one = _snapshot_with_history(sw_client, db, realistic.today, 1)
        four = _snapshot_with_history(sw_client, db, realistic.today, 4)
    finally:
        db.close()
    assert abs(four.statements - one.statements) <= HISTORY_SLACK, (one.statements,
                                                                    four.statements)
    assert four.statement_day <= 2_000, four.statement_day
