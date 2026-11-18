"""The bank statement contract and its diff against a card's rows (STU-746; pure).

No database: rows are ``RowRecord`` values. Every figure is made up. The statement
closes on 2026-07-24; its window is 2026-06-25 .. 2026-07-24 (``window_start`` is the
previous close, 2026-06-24).
"""
import random
from dataclasses import replace
from datetime import date, datetime, timedelta, timezone
from decimal import Decimal

import pytest

from app.schemas.statement_reconcile import BankStatement
from app.services.statement_reconcile import (
    Action, AppStatementView, FieldChange, HeaderDiff, NewRow, RowRecord, diff_statement,
    fingerprint, line_balance, simulate,
)

CLOSE = date(2026, 7, 24)
WINDOW_START = date(2026, 6, 24)
DUE = date(2026, 8, 14)
VIEW = AppStatementView(close=CLOSE, window_start=WINDOW_START, due=DUE,
                        minimum_due=Decimal("500.00"))
STAMP = datetime(2026, 7, 25, 1, 0, tzinfo=timezone.utc)


def D(value) -> Decimal:
    return Decimal(str(value))


def day(month, d) -> date:
    return date(2026, month, d)


def line(no, when, amount, kind="charge", posting=None, desc=None) -> dict:
    out = {"line_no": no, "transaction_date": when.isoformat(), "description": desc or f"Line {no}",
           "amount": str(amount), "kind": kind}
    if posting is not None:
        out["posting_date"] = posting.isoformat()
    return out


def statement(lines, **header) -> BankStatement:
    charges = sum((D(x["amount"]) for x in lines if x["kind"] == "charge"), D(0))
    credits = sum((D(x["amount"]) for x in lines if x["kind"] == "credit"), D(0))
    fields = {"close_date": CLOSE.isoformat(), "total_due": str(charges - credits),
              "due_date": DUE.isoformat(), "minimum_due": "500.00"}
    fields.update(header)
    return BankStatement.model_validate({"header": fields, "lines": lines})


def row(rid, when, amount, kind="charge", posting=None, posted=True, entry=None,
        updated=STAMP) -> RowRecord:
    return RowRecord(id=rid, kind=kind, amount=D(amount), transaction_date=when,
                     posting_date=posting, is_posted=posted, updated_at=updated,
                     budget_entry_id=entry)


def run(st, cycle=(), candidates=(), payments=(), view=VIEW):
    return diff_statement(st, view, list(cycle), list(candidates), list(payments))


def simulated_balance(st, diff, cycle=(), candidates=(), payments=()):
    rows = [*cycle, *candidates, *payments]
    return line_balance(simulate(rows, diff.actions, window_start=WINDOW_START, close=CLOSE))


# --- AC1 --------------------------------------------------------------------------------


def test_statement_equal_to_cycle_is_all_matched():
    st = statement([line(1, day(7, 1), "1200.00"), line(2, day(7, 3), "80.50", "credit"),
                    line(3, day(7, 20), "45.00", posting=day(7, 21))])
    cycle = [row(11, day(7, 1), "1200.00"), row(12, day(7, 3), "80.50", "credit"),
             row(13, day(7, 20), "45.00", posting=day(7, 21))]
    diff = run(st, cycle)
    assert diff.header == ()
    assert diff.actions == (Action("matched", 1, 11), Action("matched", 2, 12),
                            Action("matched", 3, 13))


# --- AC2 --------------------------------------------------------------------------------


def test_update_amount():
    st = statement([line(1, day(7, 1), "1000.00")])
    diff = run(st, [row(10, day(7, 1), "950.00")])
    assert diff.actions == (
        Action("update", 1, 10, (FieldChange("amount", D("950.00"), D("1000.00")),)),)


def test_update_dates():
    st = statement([line(1, day(7, 2), "500.00", posting=day(7, 3))])
    diff = run(st, [row(10, day(7, 1), "500.00")])
    assert diff.actions == (Action("update", 1, 10, (
        FieldChange("transaction_date", day(7, 1), day(7, 2)),
        FieldChange("posting_date", None, day(7, 3)),
    )),)


def test_move_from_unposted():
    st = statement([line(1, day(7, 5), "300.00")])
    unposted = row(20, day(7, 5), "300.00", posted=False)
    diff = run(st, [], [unposted])
    assert diff.actions == (
        Action("move", 1, 20, (FieldChange("is_posted", False, True),)),)
    assert simulated_balance(st, diff, [], [unposted]) == D("300.00")


def test_move_from_next_statement():
    # The app placed it on the next statement by its posting date; the bank posted it here.
    st = statement([line(1, day(7, 24), "640.00", posting=day(7, 24))])
    neighbour = row(30, day(7, 24), "640.00", posting=day(7, 26))
    diff = run(st, [], [neighbour])
    assert diff.actions == (
        Action("move", 1, 30, (FieldChange("posting_date", day(7, 26), day(7, 24)),)),)
    assert simulated_balance(st, diff, [], [neighbour]) == D("640.00")


def test_move_from_previous_statement():
    st = statement([line(1, day(6, 25), "75.25")])
    neighbour = row(31, day(6, 24), "75.25")
    diff = run(st, [], [neighbour])
    assert diff.actions == (
        Action("move", 1, 31, (FieldChange("transaction_date", day(6, 24), day(6, 25)),)),)


def test_create():
    st = statement([line(1, day(7, 9), "999.99", desc="Hardware store")])
    diff = run(st)
    assert diff.actions == (Action("create", 1, None, (), NewRow(
        "charge", D("999.99"), day(7, 9), None, "Hardware store")),)
    assert simulated_balance(st, diff) == D("999.99")


def test_unpost():
    st = statement([line(1, day(7, 1), "100.00")])
    cycle = [row(10, day(7, 1), "100.00"), row(11, day(7, 15), "250.00")]
    diff = run(st, cycle)
    assert diff.actions == (Action("matched", 1, 10),
                            Action("unpost", None, 11, (FieldChange("is_posted", True, False),)))
    assert simulated_balance(st, diff, cycle) == D("100.00")


# --- AC3 --------------------------------------------------------------------------------


def test_recurring_row_keeps_its_dates():
    # An installment row is dated on the close by design; the bank prints another date.
    st = statement([line(1, day(7, 20), "1500.00", posting=day(7, 21))])
    diff = run(st, [row(40, CLOSE, "1500.00", entry=7)])
    assert diff.actions == (Action("matched", 1, 40),)


def test_recurring_row_amount_difference_is_an_update_of_the_amount_only():
    st = statement([line(1, day(7, 23), "1250.00", posting=day(7, 23))])
    diff = run(st, [row(40, CLOSE, "1200.00", entry=7)])
    assert diff.actions == (
        Action("update", 1, 40, (FieldChange("amount", D("1200.00"), D("1250.00")),)),)


def test_recurring_candidate_is_moved_only_where_its_own_dates_place_it():
    st = statement([line(1, day(7, 24), "800.00"), line(2, day(7, 24), "60.00")])
    on_this = row(41, CLOSE, "800.00", posted=False, entry=7)          # posts onto this one
    on_next = row(42, day(8, 24), "60.00", posted=False, entry=8)      # its dates are next month's
    diff = run(st, [], [on_this, on_next])
    assert diff.actions == (
        Action("move", 1, 41, (FieldChange("is_posted", False, True),)),
        Action("create", 2, None, (), NewRow("charge", D("60.00"), day(7, 24), None, "Line 2")),
    )


# --- AC4 --------------------------------------------------------------------------------

AMOUNTS = [D("100.00"), D("100.00"), D("250.50"), D("99.99"), D("1000.00"), D("12.34")]


def _random_case(rng: random.Random):
    window_days = [WINDOW_START + timedelta(days=k) for k in range(1, 31)]
    few_days = rng.sample(window_days, 4)  # same-day rows and lines are common
    lines = []
    for no in range(1, rng.randint(0, 9) + 1):
        kind = rng.choices(["charge", "credit", "payment"], [6, 2, 1])[0]
        when = rng.choice(few_days)
        posting = rng.choice([None, None, min(when + timedelta(days=rng.randint(0, 3)), CLOSE)])
        lines.append(line(no, when, rng.choice(AMOUNTS), kind, posting))
    st = statement(lines)
    ids = iter(rng.sample(range(1, 10_000), 60))
    cycle, candidates, payments = [], [], []

    def near(x):
        return x + timedelta(days=rng.choice([-1, 0, 0, 1, 2]))

    def amount_like(x):
        return rng.choice([x, x, x + D("0.50"), rng.choice(AMOUNTS)])

    for x in st.lines:
        source = rng.random()
        if x.kind == "payment":
            if source < 0.6:
                payments.append(row(next(ids), near(x.transaction_date), amount_like(x.amount),
                                    "payment"))
            continue
        entry = rng.choice([None, None, None, 5])
        if source < 0.45:  # on the cycle, maybe off by an amount or a day
            when = min(max(near(x.transaction_date), WINDOW_START + timedelta(days=1)), CLOSE)
            cycle.append(row(next(ids), when, amount_like(x.amount), x.kind, entry=entry))
        elif source < 0.65:  # unposted
            candidates.append(row(next(ids), near(x.transaction_date), amount_like(x.amount),
                                  x.kind, posted=False, entry=entry))
        elif source < 0.8:  # on a neighbouring statement
            if rng.random() < 0.5:
                candidates.append(row(next(ids), WINDOW_START - timedelta(days=rng.randint(0, 2)),
                                      x.amount, x.kind, entry=entry))
            else:
                candidates.append(row(next(ids), CLOSE, x.amount, x.kind,
                                      posting=CLOSE + timedelta(days=rng.randint(1, 3)),
                                      entry=entry))
    for _ in range(rng.randint(0, 4)):  # rows the statement does not list
        kind = rng.choice(["charge", "charge", "credit"])
        entry = rng.choice([None, 6])
        where = rng.random()
        if where < 0.5:
            cycle.append(row(next(ids), rng.choice(few_days), rng.choice(AMOUNTS), kind,
                             entry=entry))
        elif where < 0.8:
            candidates.append(row(next(ids), rng.choice(few_days + [CLOSE + timedelta(days=5)]),
                                  rng.choice(AMOUNTS), kind, posted=False, entry=entry))
        else:
            candidates.append(row(next(ids), WINDOW_START - timedelta(days=3),
                                  rng.choice(AMOUNTS), kind, entry=entry))
    for _ in range(rng.randint(0, 2)):
        payments.append(row(next(ids), rng.choice(few_days), rng.choice(AMOUNTS), "payment"))
    return st, cycle, candidates, payments


def test_property_simulated_cycle_equals_statement():
    rng = random.Random(746)
    kinds_seen = set()
    for case in range(600):
        st, cycle, candidates, payments = _random_case(rng)
        diff = run(st, cycle, candidates, payments)
        kinds_seen.update(a.kind for a in diff.actions)
        assert simulated_balance(st, diff, cycle, candidates, payments) == st.line_balance, case
        row_ids = [a.row_id for a in diff.actions if a.row_id is not None]
        assert len(row_ids) == len(set(row_ids)), case
        assert sorted(a.line_no for a in diff.actions if a.line_no is not None) == \
            [x.line_no for x in st.lines], case
        acted = {a.row_id for a in diff.actions}
        assert all(r.id in acted for r in cycle), case
    assert kinds_seen == {"matched", "update", "move", "create", "unpost", "missing"}


# --- AC5 --------------------------------------------------------------------------------


def _duplicates_case():
    st = statement([line(1, day(7, 10), "100.00"), line(2, day(7, 10), "100.00"),
                    line(3, day(7, 12), "100.00"), line(4, day(7, 15), "55.00"),
                    line(5, day(7, 16), "20.00", "credit"), line(6, day(7, 2), "300.00", "payment")])
    cycle = [row(7, day(7, 10), "100.00"), row(3, day(7, 10), "100.00"),
             row(9, day(7, 15), "54.00")]
    candidates = [row(5, day(7, 10), "100.00", posted=False), row(4, day(7, 11), "100.00",
                  posted=False), row(8, day(7, 16), "20.00", "credit", posted=False)]
    payments = [row(2, day(7, 2), "300.00", "payment"), row(1, day(7, 2), "300.00", "payment")]
    return st, cycle, candidates, payments


def test_same_inputs_in_any_order_give_the_same_diff():
    st, cycle, candidates, payments = _duplicates_case()
    expected = run(st, cycle, candidates, payments)
    rng = random.Random(5)
    for _ in range(50):
        lines = [x.model_dump(mode="json") for x in st.lines]
        rng.shuffle(lines)
        shuffled = BankStatement.model_validate(
            {"header": st.header.model_dump(mode="json"), "lines": lines})
        c, k, p = cycle[:], candidates[:], payments[:]
        for part in (c, k, p):
            rng.shuffle(part)
        got = run(shuffled, c, k, p)
        assert got.actions == expected.actions
        assert got.fingerprint == expected.fingerprint
    # Lowest row id first among equal ranks; cycle rows before the candidates.
    assert expected.actions == (
        Action("matched", 1, 3), Action("matched", 2, 7),
        Action("move", 3, 4, (FieldChange("transaction_date", day(7, 11), day(7, 12)),
                              FieldChange("is_posted", False, True))),
        Action("update", 4, 9, (FieldChange("amount", D("54.00"), D("55.00")),)),
        Action("move", 5, 8, (FieldChange("is_posted", False, True),)),
        Action("matched", 6, 1),
    )


@pytest.mark.parametrize("change", [
    {"amount": D("100.01")},
    {"transaction_date": day(7, 11)},
    {"posting_date": day(7, 11)},
    {"is_posted": False},
    {"updated_at": STAMP + timedelta(seconds=1)},
])
def test_fingerprint_changes_with_a_row(change):
    st, cycle, candidates, payments = _duplicates_case()
    before = fingerprint(st, [*cycle, *candidates, *payments])
    changed = [replace(cycle[0], **change), *cycle[1:]]
    assert run(st, changed, candidates, payments).fingerprint != before
    assert run(st, cycle, candidates, payments).fingerprint == before


# --- AC6 --------------------------------------------------------------------------------


def test_payment_lines_never_change_the_line_balance():
    charges = [line(1, day(7, 1), "400.00"), line(2, day(7, 4), "35.00", "credit")]
    paid = charges + [line(3, day(7, 5), "1000.00", "payment"),
                      line(4, day(7, 20), "250.00", "payment")]
    cycle = [row(10, day(7, 1), "400.00"), row(11, day(7, 4), "35.00", "credit")]
    payments = [row(50, day(7, 6), "1000.00", "payment"), row(51, day(7, 5), "1000.00", "payment")]
    without = run(statement(charges), cycle)
    with_payments = run(statement(paid), cycle, (), payments)
    assert with_payments.actions == without.actions + (Action("matched", 3, 51),
                                                       Action("missing", 4))
    assert (simulated_balance(None, with_payments, cycle, (), payments)
            == simulated_balance(None, without, cycle) == D("365.00"))


# --- AC8 --------------------------------------------------------------------------------


def test_a_different_close_gives_a_header_diff_and_no_row_actions():
    st = statement([line(1, day(7, 1), "100.00"), line(2, day(7, 2), "300.00", "payment")],
                   close_date="2026-07-25")
    diff = run(st, [row(10, day(7, 1), "90.00"), row(11, day(7, 9), "5.00")],
               [row(12, day(7, 2), "1.00", posted=False)], [row(13, day(7, 2), "300.00", "payment")])
    assert diff.header == (HeaderDiff("close", day(7, 25), CLOSE),)
    assert diff.actions == ()


def test_header_diff_reports_due_and_minimum_due():
    st = statement([], due_date="2026-08-15", minimum_due="650.00")
    assert run(st).header == (HeaderDiff("due", day(8, 15), DUE),
                              HeaderDiff("minimum_due", D("650.00"), D("500.00")))


def test_a_row_given_twice_is_refused():
    with pytest.raises(ValueError, match="more than once"):
        run(statement([]), [row(1, day(7, 1), "1.00")], [row(1, day(7, 1), "1.00", posted=False)])
