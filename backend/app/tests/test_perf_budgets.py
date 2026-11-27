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


# The Add form's Description suggestions (STU-626): budgeted for every caller but kept
# out of ``perf.hot_paths`` (and so out of the golden files). "T" starts most rows.
SUGGESTIONS = "description-suggestions"
SUGGESTIONS_PATH = "/transactions/description-suggestions?q=T"


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
# The conditional GETs (STU-602, core/conditional.py) then add one statement, the data
# version read, to snapshot, installment-plans, budget-entries, accounts and transactions.
# STU-601 (PERF-6, stored closed statements) lowered statement_day and instances the same
# way; its SQL counts rose by up to 10 (each statement read loads the cards' stored state
# and rows) and stayed within these ceilings.
# STU-598 (PERF-3, one request context per read) lowered them again to its measured
# result plus 10% (``collect_events`` to its exact count: one run per read at most).
# The owner's card-credit instances rose from 491 to 493 (ceiling 543): the per-entry
# reads now load every reviewed installment and held-month pair the caller may walk
# in one query each, a few more rows than the one card needs, for 26 statements
# instead of 49. Refitted after STU-623 (shared card holds released after each read),
# which took one or two statements off the shared-caller snapshots and household reads.
# STU-599 (PERF-4) read the Household tag links of a tag holder's projection in one query
# per kind of record instead of one per row: the household reads' SQL ceilings are
# lowered to the measured result plus 10%.
# ``/dashboard/due`` (STU-599, PERF-4) is budgeted at its measured result plus 10%, its
# SQL capped at the plan's hard gate (``DUE_SQL_GATE``). The plan's 60 KB gate holds for
# the editor, viewer and household member but not the owner: the owner's response is
# 158,026 bytes, of which the snapshot's own lists (payables, upcoming, card charges) are
# 97 KB and the 64 unposted rows through today 53 KB, so it is budgeted as measured.
# STU-253 raised byte ceilings to the measured result: every account carries
# ``permissions.can_view_details`` (accounts lists, the Household dashboard), and a
# tag-viewer card's statement event shows its figure instead of 0 (household reads).
# The description suggestions (STU-626) are budgeted at their measured result plus 10%:
# four statements, of which one is their own (``SUGGESTIONS_SQL_GATE``); the viewer and
# household member see no row in full that starts with "T", so they get an empty list.
# STU-244 added ``owner_id`` to every direct-role account: the accounts lists' byte
# ceilings rose by exactly its bytes (18 per account); the household list is unchanged.
# The accounts lists carry both ``owner_id`` and ``can_view_details``: their ceilings are
# the measured result with both fields (STU-244's rise plus STU-253's).
# STU-658 added ``final_amount`` to every full entry (20 bytes each as null) and
# ``remaining_total`` to every installment plan (26 bytes at these figures): the
# budget-entries and installment-plans byte ceilings rose by exactly those bytes.
# STU-660 added ``next_occurrence_amount`` to every full entry (a figure or null, computed from
# the entry already loaded: no statement, no instance): the budget-entries byte ceilings rose
# to the measured result (owner 14,748 to 15,293, editor 4,287 to 4,447).
BUDGETS: Dict[Tuple[str, str], Budget] = {
    ("owner", "snapshot"): Budget(66, 111_157, 328, 1, 929),
    ("owner", "due"): Budget(60, 173_828, 308, 1, 992),
    ("owner", "installment-plans"): Budget(15, 2_119, 0, 0, 21),
    ("owner", "budget-entries"): Budget(16, 15_293, 0, 0, 29),
    ("owner", "accounts"): Budget(12, 10_380, 0, 0, 16),
    ("owner", "transactions"): Budget(13, 20_829, 0, 0, 38),
    ("owner", SUGGESTIONS): Budget(4, 1_506, 0, 0, 1),
    ("owner", "statements"): Budget(11, 47_893, 431, 0, 435),
    ("owner", "card-credit"): Budget(29, 9_374, 431, 0, 543),
    ("editor", "snapshot"): Budget(64, 36_062, 54, 1, 197),
    ("editor", "due"): Budget(60, 50_386, 45, 1, 223),
    ("editor", "installment-plans"): Budget(17, 765, 0, 0, 7),
    ("editor", "budget-entries"): Budget(16, 4_447, 0, 0, 10),
    ("editor", "accounts"): Budget(10, 1_749, 0, 0, 5),
    ("editor", "transactions"): Budget(14, 8_878, 0, 0, 27),
    ("editor", SUGGESTIONS): Budget(4, 1_492, 0, 0, 1),
    ("editor", "statements"): Budget(14, 47_875, 431, 0, 436),
    ("viewer", "snapshot"): Budget(60, 31_604, 54, 1, 183),
    ("viewer", "due"): Budget(56, 30_039, 45, 1, 182),
    ("viewer", "installment-plans"): Budget(9, 61, 0, 0, 5),
    ("viewer", "budget-entries"): Budget(9, 39, 0, 0, 1),
    ("viewer", "accounts"): Budget(10, 1_751, 0, 0, 5),
    ("viewer", "transactions"): Budget(14, 3_824, 0, 0, 21),
    ("viewer", SUGGESTIONS): Budget(4, 13, 0, 0, 1),
    ("viewer", "statements"): Budget(14, 36_670, 427, 0, 434),
    ("household", "snapshot"): Budget(51, 10_653, 44, 1, 84),
    ("household", "due"): Budget(47, 8_525, 37, 1, 82),
    ("household", "installment-plans"): Budget(13, 61, 0, 0, 5),
    ("household", "budget-entries"): Budget(11, 39, 0, 0, 1),
    ("household", "accounts"): Budget(14, 383, 0, 0, 5),
    ("household", "transactions"): Budget(18, 4_601, 0, 0, 21),
    ("household", SUGGESTIONS): Budget(4, 13, 0, 0, 1),
    ("household", "household-upcoming"): Budget(39, 7_416, 38, 1, 73),
    ("household", "household-monthly"): Budget(63, 138, 38, 1, 82),
    ("household", "household-dashboard"): Budget(69, 7_828, 38, 1, 85),
}

# The owner's median CPU (ms) on the machine that wrote the budgets, one run at full
# CPU, nothing else running. The gate is CPU_FACTOR times this.
CPU_BASELINE_MS = {
    "snapshot": 1100, "due": 80, "installment-plans": 60,
    "budget-entries": 25, "accounts": 15,
    "transactions": 22, "statements": 65,
    "card-credit": 85,
}


@pytest.fixture(scope="module")
def measured(realistic, sw_client):
    """Every (caller, endpoint) of ``BUDGETS`` measured once; the report written."""
    samples: Dict[Tuple[str, str], perf.Sample] = {}
    for caller in CALLERS:
        paths = dict(perf.hot_paths(realistic, caller))
        paths[SUGGESTIONS] = SUGGESTIONS_PATH
        for name, path in paths.items():
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


# STU-598 (PERF-3): what each read builds, exactly. Every endpoint is named in one
# of the sets below, so a new one has to be placed before its budget can pass.
# The reads that run the projection (``collect_events``), once:
PROJECTING = {"snapshot", "due", "household-upcoming", "household-monthly",
              "household-dashboard"}
# The reads that legitimately do not run it:
NOT_PROJECTING = {"installment-plans", "budget-entries", "accounts", "transactions",
                  "statements", "card-credit", SUGGESTIONS}
# The reads with no ``RequestContext``: the accounts list reads the caller's access map
# once and builds no ``RecordAccess`` or ``Redactor``.
NO_CONTEXT = {"accounts"}
# The reads whose context reads the caller's access map and builds no ``RecordAccess``
# or ``Redactor``: the description suggestions (STU-626) serialize no record.
ACCESS_MAP_ONLY = {SUGGESTIONS}


def _expected_once(endpoint: str) -> Dict[str, int]:
    if endpoint in NO_CONTEXT:
        built = {"contexts": 0, "access_maps": 1, "record_access": 0, "redactors": 0}
    elif endpoint in ACCESS_MAP_ONLY:
        built = {"contexts": 1, "access_maps": 1, "record_access": 0, "redactors": 0}
    else:
        built = {"contexts": 1, "access_maps": 1, "record_access": 1, "redactors": 1}
    return {**built, "collect_events": 1 if endpoint in PROJECTING else 0}


def test_every_budgeted_endpoint_is_placed_once():
    endpoints = {endpoint for _, endpoint in BUDGETS}
    assert PROJECTING.isdisjoint(NOT_PROJECTING)
    assert PROJECTING | NOT_PROJECTING == endpoints
    assert NO_CONTEXT <= endpoints and ACCESS_MAP_ONLY <= endpoints
    assert NO_CONTEXT.isdisjoint(ACCESS_MAP_ONLY)


@needs_db
@pytest.mark.parametrize("caller,endpoint", sorted(BUDGETS))
def test_one_request_context_per_request(measured, caller, endpoint):
    """STU-598 (PERF-3): a context-backed read builds exactly one ``RequestContext``,
    reads each user's ``AccessMap`` (the viewable accounts and roles) once and builds
    their ``RecordAccess`` and ``Redactor`` once, and runs the projection's
    ``collect_events`` exactly once when it projects (never when it does not). Exact,
    so a read that stopped building the context (all zeros) fails as well."""
    got = measured[(caller, endpoint)]
    expected = _expected_once(endpoint)
    once = {f: getattr(got, f) for f in expected}
    assert once == expected, f"{caller} {endpoint}: measured {once}, expected {expected}"


# STU-599 (PERF-4, AC3): ``/dashboard/due`` runs at most this many SQL statements, for
# every caller, whatever its budget says.
DUE_SQL_GATE = 60


@needs_db
@pytest.mark.parametrize("caller", CALLERS)
def test_due_within_the_sql_gate(measured, caller):
    got = measured[(caller, "due")].statements
    assert got <= DUE_SQL_GATE, f"{caller} /dashboard/due ran {got} SQL statements"


# STU-626 (AC6): the description suggestions run at most this many SQL statements of
# their own, for every caller, whatever their budget says: what a request runs beyond
# its fixed cost, which is the UTC pin of its transaction (``database.pin_utc``), the
# caller's row (auth) and the request context's one ``AccessMap`` read (PERF-3).
SUGGESTIONS_SQL_GATE = 1
SUGGESTIONS_FIXED_SQL = 3


@needs_db
@pytest.mark.parametrize("caller", CALLERS)
def test_suggestions_query_budget(measured, realistic, sw_client, caller):
    from app.tests.fixtures.suggestions import suggestion_reads

    got = measured[(caller, SUGGESTIONS)].statements
    assert got - SUGGESTIONS_FIXED_SQL <= SUGGESTIONS_SQL_GATE, (
        f"{caller} {SUGGESTIONS} ran {got} SQL statements")
    who = {"headers": realistic.callers[caller].headers}
    for q in ("T", "Txn 1", "Card payment", "no such description"):
        reads, seen = suggestion_reads(sw_client, who, q)
        assert len(reads) <= SUGGESTIONS_SQL_GATE, (caller, q, reads)
        assert len(seen) - len(reads) <= SUGGESTIONS_FIXED_SQL, (caller, q, seen)


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


# --- STU-789 (AC15): the snapshot with a populated wishlist and goals -------------------------

# The measured figures for the populated fixture, set by owner ruling on 2026-11-26.
WISHLIST_SNAPSHOT_BUDGET = BUDGETS[("owner", "snapshot")]._replace(statements=67, bytes=111_935)


@needs_db
def test_snapshot_with_a_wishlist_and_goals_within_its_ceilings(
        measured, realistic, sw_client, sw_db):
    """The owner's snapshot with eight wishlist items and four ranked goals on top of the
    realistic rows (two years, so free flow reads a full 12 months) stays within its own
    ceilings (``WISHLIST_SNAPSHOT_BUDGET``: the owner's snapshot ceilings, with statements
    and bytes at this fixture's measured figures), and still builds one context and runs
    the projection once. The owner's snapshot ceilings themselves are unchanged.
    ``measured`` runs first, so the plain budgets are measured without the wishlist."""
    from app.tests.fixtures.realistic import add_wishlist_and_goals, remove_wishlist_and_goals

    headers = realistic.callers["owner"].headers
    add_wishlist_and_goals(sw_db, realistic)
    try:
        got = perf.measure(sw_client, headers, "/dashboard/snapshot", runs=5)
        next_up = sw_client.get(f"{API}/dashboard/snapshot", headers=headers).json()[
            "wishlist_next_up"]
        flow = sw_client.get(f"{API}/wishlist/free-flow", headers=headers).json()
    finally:
        remove_wishlist_and_goals(sw_db, realistic)
    # The fixture really ran free flow: a full year, the goals, and a status per item.
    (php,) = [r for r in flow["rows"] if r["currency"] == "PHP"]
    assert php["sample_months"] == 12
    assert len(flow["goals"]) == 4
    assert len(next_up) == 3 and all(i["projection_status"] for i in next_up)
    print(f"\nSTU-789 owner snapshot with wishlist and goals: {got}; PHP row {php['status']}; "
          f"next-up {[i['projection_status'] for i in next_up]}")

    once = {f: getattr(got, f) for f in ("contexts", "access_maps", "collect_events")}
    assert once == {"contexts": 1, "access_maps": 1, "collect_events": 1}, once
    limit = max(CPU_FACTOR * CPU_BASELINE_MS["snapshot"], CPU_FLOOR_MS)
    assert got.cpu_ms <= limit, (got.cpu_ms, limit)
    ceiling = WISHLIST_SNAPSHOT_BUDGET
    over = {f: (getattr(got, f), getattr(ceiling, f)) for f in Budget._fields
            if getattr(got, f) > getattr(ceiling, f)}
    assert not over, f"owner snapshot with a wishlist over its ceiling (measured, ceiling): {over}"


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


# --- STU-795: budget envelopes' spent statement and window rolls ------------------------------

def _plan_nodes(node):
    yield node
    for child in node.get("Plans", []):
        yield from _plan_nodes(child)


def _capture(engine):
    """``(statement, parameters)`` of every statement run while installed."""
    from sqlalchemy import event

    seen = []

    def on_execute(conn, cursor, statement, parameters, context, executemany):
        seen.append((statement, parameters))

    event.listen(engine, "before_cursor_execute", on_execute)
    return seen, lambda: event.remove(engine, "before_cursor_execute", on_execute)


@needs_db
def test_budget_list_scans_transactions_once(realistic, sw_client, sw_db):
    """AC28: the budget list reads every envelope's spent figures, across all their
    windows, in one statement that scans ``transactions`` once. Ten envelopes on the
    realistic owner (2,938 rows): five started two years ago (one of them daily, so 730
    stored windows), the others weekly, quarterly, in USD, with no limit and a custom
    window; some limited to accounts."""
    import json
    import re

    from sqlalchemy import text

    from app.core.database import engine
    from app.models.category import Category

    owner = realistic.callers["owner"]
    headers, acc = owner.headers, realistic.accounts
    cats = [c for (c,) in sw_db.query(Category.id).filter(Category.user_id == owner.id)
            .order_by(Category.id)]
    sw_db.rollback()
    two_years = "2024-11-01T00:00:00"
    envelopes = [
        {"period_frequency": "monthly", "period_start": two_years, "target_amount": 20_000},
        {"period_frequency": "monthly", "period_start": two_years, "target_amount": 8_000,
         "account_ids": [acc["bank0"], acc["card_a"]]},
        {"period_frequency": "monthly", "period_start": two_years, "monthly_target": 5_000},
        {"period_frequency": "weekly", "period_start": "2024-11-04T00:00:00",
         "target_amount": 2_000},
        {"period_frequency": "daily", "period_start": "2024-11-13T00:00:00",
         "target_amount": 500, "account_ids": [acc["cash"], acc["wallet"]]},
        {"period_frequency": "weekly", "target_amount": 3_000, "carry_over": True},
        {"period_frequency": "quarterly", "period_start": "2025-01-01T00:00:00",
         "target_amount": 60_000, "carry_over": True},
        {"period_frequency": "monthly", "target_amount": 300, "currency": "USD"},
        {"period_frequency": "monthly"},
        {"period_frequency": "monthly", "period_start": "2026-09-01T00:00:00",
         "period_end": "2026-12-01T00:00:00", "target_amount": 30_000},
    ]
    ids = []
    try:
        for n, fields in enumerate(envelopes):
            accounts = fields.pop("account_ids", None)
            configuration = {"category_ids": cats[n % len(cats):][:3] or cats[:3]}
            if accounts:
                configuration["account_ids"] = accounts
            r = sw_client.post(f"{API}/allocations/", headers=headers, json={
                "name": f"Envelope {n}", "allocation_type": "budget",
                "configuration": configuration, **fields})
            assert r.status_code == 200, r.text
            ids.append(r.json()["id"])
        stored = sw_db.execute(text(
            "SELECT count(*) FROM budget_periods WHERE allocation_id = ANY(:ids)"),
            {"ids": ids}).scalar_one()
        sw_db.rollback()
        assert stored >= 730 + 4 * 24

        path = f"{API}/allocations/?allocation_type=budget&limit=100"
        assert sw_client.get(path, headers=headers).status_code == 200  # warm; nothing rolls
        seen, stop = _capture(engine)
        try:
            r = sw_client.get(path, headers=headers)
        finally:
            stop()
        assert r.status_code == 200 and r.json()["total"] == len(ids)
        reading = [(s, p) for s, p in seen if re.search(r"\btransactions\b", s)]
        assert len(reading) == 1, [s[:120] for s, _ in reading]  # one spent statement
        (statement, parameters), = reading
        assert "budget_periods" not in statement

        raw = engine.raw_connection()
        try:
            cursor = raw.cursor()
            cursor.execute("EXPLAIN (ANALYZE, FORMAT JSON) " + statement, parameters)
            (plan,) = cursor.fetchone()[0]
            raw.rollback()
        finally:
            raw.close()
        plan = plan if isinstance(plan, dict) else json.loads(plan)
        scans = [n for n in _plan_nodes(plan["Plan"]) if n.get("Relation Name") == "transactions"]
        assert len(scans) == 1, [n["Node Type"] for n in scans]
        assert scans[0]["Actual Loops"] == 1, scans[0]
        print(f"\nSTU-795 budget list: {len(seen)} statements, one transactions scan "
              f"({scans[0]['Node Type']}, {scans[0]['Actual Rows']} rows) over "
              f"{stored} stored windows")
    finally:
        sw_db.rollback()
        if ids:
            sw_db.execute(text("DELETE FROM allocations WHERE id = ANY(:ids)"), {"ids": ids})
            sw_db.commit()


def _budget_world(client, people, name):
    from app.tests.conftest import sw_post

    who = people()
    bank = sw_post(client, who, "/accounts/", {"name": f"{name} bank",
                                              "account_type": "checking", "balance": 10_000})["id"]
    food = sw_post(client, who, "/categories/", {"name": "Food", "kind": "expense"})["id"]
    return who, bank, food


def _spend(client, who, bank, food, day):
    r = client.post(f"{API}/transactions/", headers=who["headers"], json={
        "account_id": bank, "transaction_type": "debit", "amount": 25, "description": "Lunch",
        "transaction_date": day, "is_posted": True, "category_id": food})
    assert r.status_code == 200, r.text


def _budget(client, who, food, frequency, start):
    r = client.post(f"{API}/allocations/", headers=who["headers"], json={
        "name": "Food", "allocation_type": "budget", "period_frequency": frequency,
        "period_start": start, "target_amount": 1_000,
        "configuration": {"category_ids": [food]}})
    assert r.status_code == 200, r.text
    return r.json()["id"]


@needs_db
def test_budget_roll_adds_only_one_insert_to_transaction_write(
        realistic, sw_client, sw_people, monkeypatch):
    """AC29: the same transaction write, once on a budget that is current and once on
    one whose window has elapsed, differs by exactly one SQL statement: the insert of
    the closed window."""
    from datetime import timedelta

    from app.core.database import engine
    from app.tests.fixtures.realistic import REF, pin_clock

    current = _budget_world(sw_client, sw_people, "Current")
    rolling = _budget_world(sw_client, sw_people, "Rolling")
    earlier = REF - timedelta(days=24)  # Oct 20
    pin_clock(monkeypatch, earlier)
    _budget(sw_client, rolling[0], rolling[2], "monthly", "2026-10-01T00:00:00")
    _spend(sw_client, *rolling, "2026-10-15T00:00:00")  # warm, in October: no roll
    pin_clock(monkeypatch, REF)
    _budget(sw_client, current[0], current[2], "monthly", "2026-11-01T00:00:00")
    _spend(sw_client, *current, "2026-11-02T00:00:00")  # warm

    counted = {}
    for key, world in (("current", current), ("rolling", rolling)):
        seen, stop = _capture(engine)
        try:
            _spend(sw_client, *world, "2026-11-10T00:00:00")
        finally:
            stop()
        counted[key] = [s for s, _ in seen]
    extra = len(counted["rolling"]) - len(counted["current"])
    periods = {k: [s for s in v if "budget_periods" in s] for k, v in counted.items()}
    print(f"\nSTU-795 transaction write: {len(counted['current'])} statements, "
          f"{len(counted['rolling'])} when it rolls")
    assert extra == 1, (len(counted["current"]), len(counted["rolling"]))
    assert periods["current"] == []
    assert len(periods["rolling"]) == 1
    assert periods["rolling"][0].lstrip().startswith("INSERT INTO budget_periods")


# AC30: the median wall time (ms) of the first write after 400 daily windows elapsed,
# measured on the local Postgres 15 test container on 2026-11-27 (the scenario's own
# fixture; not yet measured on CI). The gate is the greater of 100 ms and 3x this.
ROLL_400_BASELINE_MS = 33
ROLL_400_FLOOR_MS = 100


@needs_db
def test_first_write_rolls_400_daily_windows_within_ceiling(
        realistic, sw_client, sw_people, sw_db, monkeypatch):
    """AC30: a daily budget left 400 days: the first write stores all 400 windows in one
    statement. Five independently reset fixtures (a fresh user and budget each, set up
    outside the timer); the median request time stays under the ceiling."""
    import statistics
    import time as clock
    from datetime import timedelta

    from sqlalchemy import text

    from app.core.database import engine
    from app.tests.fixtures.realistic import REF, pin_clock

    timings = []
    for run in range(5):
        pin_clock(monkeypatch, REF - timedelta(days=400))
        world = _budget_world(sw_client, sw_people, f"Daily {run}")
        start = (REF - timedelta(days=400)).replace(hour=0).isoformat()
        budget = _budget(sw_client, world[0], world[2], "daily", start)
        pin_clock(monkeypatch, REF)
        seen, stop = _capture(engine)
        try:
            began = clock.perf_counter()
            _spend(sw_client, *world, REF.replace(hour=0).isoformat())
            timings.append((clock.perf_counter() - began) * 1000)
        finally:
            stop()
        inserts = [s for s, _ in seen if s.lstrip().startswith("INSERT INTO budget_periods")]
        assert len(inserts) == 1
        stored = sw_db.execute(text(
            "SELECT count(*) FROM budget_periods WHERE allocation_id = :a"),
            {"a": budget}).scalar_one()
        sw_db.rollback()
        assert stored == 400
    median = statistics.median(timings)
    limit = max(ROLL_400_FLOOR_MS, 3 * ROLL_400_BASELINE_MS)
    print(f"\nSTU-795 first write rolling 400 daily windows: median {median:.1f} ms "
          f"(runs {[round(t, 1) for t in timings]}, limit {limit} ms)")
    assert median < limit, (median, limit)
