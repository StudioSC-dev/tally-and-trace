"""A savings, checking or e-wallet statement and its diff against the account's rows
(STU-753; pure).

No database: rows are ``RowRecord`` values. Every figure is made up. The statement's
period is 2026-07-01 .. 2026-07-31 (``window_start`` is the day before, 2026-06-30).
"""
import random
from datetime import date, datetime, timedelta, timezone
from decimal import Decimal

import pytest
from pydantic import ValidationError

from app.schemas.statement_reconcile import AccountStatement, BankStatement
from app.services.statement_reconcile import (
    Action, AppStatementView, FieldChange, NewRow, RowRecord, diff_account_statement, fingerprint,
    line_balance, simulate,
)

START = date(2026, 7, 1)
END = date(2026, 7, 31)
VIEW = AppStatementView(close=END, window_start=START - timedelta(days=1),
                        placement="transaction_date")
STAMP = datetime(2026, 8, 1, 1, 0, tzinfo=timezone.utc)
OPENING = Decimal("10000.00")


def D(value) -> Decimal:
    return Decimal(str(value))


def day(month, d) -> date:
    return date(2026, month, d)


def line(no, when, amount, kind="debit", posting=None, desc=None) -> dict:
    out = {"line_no": no, "transaction_date": when.isoformat(), "description": desc or f"Line {no}",
           "amount": str(amount), "kind": kind}
    if posting is not None:
        out["posting_date"] = posting.isoformat()
    return out


def statement(lines, opening=OPENING, **header) -> AccountStatement:
    debits = sum((D(x["amount"]) for x in lines if x["kind"] == "debit"), D(0))
    credits = sum((D(x["amount"]) for x in lines if x["kind"] == "credit"), D(0))
    fields = {"period_start": START.isoformat(), "period_end": END.isoformat(),
              "opening_balance": None if opening is None else str(opening),
              "closing_balance": str(OPENING + credits - debits)}
    fields.update(header)
    return AccountStatement.model_validate({"header": fields, "lines": lines})


def row(rid, when, amount, kind="debit", posting=None, posted=True, entry=None,
        transfer=False, updated=STAMP) -> RowRecord:
    return RowRecord(id=rid, kind=kind, amount=D(amount), transaction_date=when,
                     posting_date=posting, is_posted=posted, updated_at=updated,
                     budget_entry_id=entry, keeps_dates=transfer)


def run(st, cycle=(), candidates=(), view=VIEW):
    return diff_account_statement(st, view, list(cycle), list(candidates))


def simulated_balance(diff, cycle=(), candidates=()):
    return line_balance(simulate([*cycle, *candidates], diff.actions,
                                 window_start=VIEW.window_start, close=END,
                                 placement="transaction_date"))


# --- the contract -------------------------------------------------------------------------


def test_header_that_does_not_add_up_states_the_gap():
    lines = [line(1, day(7, 1), "400.00"), line(2, day(7, 4), "35.00", "credit")]
    ok = statement(lines)
    assert ok.header.closing_balance == D("9635.00") and ok.change == D("-365.00")
    assert ok.line_balance == D("365.00")
    with pytest.raises(ValidationError) as caught:
        statement(lines, closing_balance="9700.00")
    assert ("opening_balance + credits - debits = 9635.00, closing_balance = 9700.00,"
            " gap 65.00") in str(caught.value)


def test_header_without_an_opening_balance_is_not_checked():
    st = statement([line(1, day(7, 1), "400.00")], opening=None, closing_balance="1.00")
    assert st.header.opening_balance is None


@pytest.mark.parametrize("bad, message", [
    ({"period_end": "2026-06-30"}, "period_end is before period_start"),
    ({"closing_balance": "1.001"}, "no more than 2 decimal places"),
    ({"close_date": "2026-07-31"}, "Extra inputs are not permitted"),
])
def test_bad_headers_are_rejected(bad, message):
    with pytest.raises(ValidationError) as caught:
        statement([], opening=None, **bad)
    assert message in str(caught.value)


@pytest.mark.parametrize("kind", ["charge", "payment"])
def test_a_card_kind_is_not_a_bank_line(kind):
    with pytest.raises(ValidationError):
        statement([line(1, day(7, 1), "10.00", kind)], opening=None, closing_balance="0.00")


def test_a_bank_kind_is_not_a_card_line():
    with pytest.raises(ValidationError):
        BankStatement.model_validate({
            "header": {"close_date": "2026-07-24", "total_due": "10.00"},
            "lines": [line(1, day(7, 1), "10.00", "debit")]})


# --- one test per action kind ---------------------------------------------------------------


def test_statement_equal_to_the_period_is_all_matched():
    st = statement([line(1, day(7, 1), "1200.00"), line(2, day(7, 3), "80.50", "credit"),
                    line(3, day(7, 31), "45.00", posting=day(8, 2))])
    cycle = [row(11, day(7, 1), "1200.00"), row(12, day(7, 3), "80.50", "credit"),
             row(13, day(7, 31), "45.00", posting=day(8, 2))]
    diff = run(st, cycle)
    assert diff.header == () and diff.balanced and diff.warnings == ()
    assert diff.actions == (Action("matched", 1, 11), Action("matched", 2, 12),
                            Action("matched", 3, 13))


def test_update_amount_and_dates():
    st = statement([line(1, day(7, 10), "1200.00"), line(2, day(7, 13), "500.00", "credit")])
    diff = run(st, [row(1, day(7, 10), "1000.00"), row(2, day(7, 12), "500.00", "credit")])
    assert diff.balanced
    assert diff.actions == (
        Action("update", 1, 1, (FieldChange("amount", D("1000.00"), D("1200.00")),)),
        Action("update", 2, 2, (FieldChange("transaction_date", day(7, 12), day(7, 13)),)),
    )


def test_move_from_unposted_and_from_the_previous_period():
    st = statement([line(1, day(7, 15), "300.00"), line(2, day(7, 1), "400.00", "credit")])
    candidates = [row(3, day(7, 15), "300.00", posted=False),
                  row(4, day(6, 29), "400.00", "credit")]
    diff = run(st, (), candidates)
    assert diff.balanced
    assert diff.actions == (
        Action("move", 1, 3, (FieldChange("is_posted", False, True),)),
        Action("move", 2, 4, (FieldChange("transaction_date", day(6, 29), day(7, 1)),)),
    )


def test_create_and_unpost():
    st = statement([line(1, day(7, 5), "250.00", "credit", desc="Interest")])
    diff = run(st, [row(9, day(7, 8), "700.00")])
    assert diff.balanced
    assert diff.actions == (
        Action("create", 1, None, (), NewRow("credit", D("250.00"), day(7, 5), None,
                                             "Interest")),
        Action("unpost", None, 9, (FieldChange("is_posted", True, False),)),
    )


# --- placement, recurring rows and transfers ------------------------------------------------


def test_a_posting_date_after_the_period_does_not_move_a_row_off_it():
    st = statement([line(1, day(7, 31), "45.00", posting=day(8, 3))])
    diff = run(st, [row(1, day(7, 31), "45.00")])
    assert diff.balanced and diff.warnings == ()
    assert diff.actions == (
        Action("update", 1, 1, (FieldChange("posting_date", None, day(8, 3)),)),)


def test_a_line_dated_outside_the_period_is_a_warning_and_unbalanced():
    st = statement([line(1, day(8, 1), "45.00")])
    diff = run(st)
    assert not diff.balanced
    assert [w.line_no for w in diff.warnings] == [1]


def test_recurring_row_keeps_its_transaction_date():
    st = statement([line(1, day(7, 16), "30000.00", "credit", desc="Salary")])
    diff = run(st, [row(5, day(7, 15), "30000.00", "credit", entry=3)])
    assert diff.actions == (Action("matched", 1, 5),)
    # Planned in the next period, it is never pulled onto this one: a create names it.
    diff = run(st, (), [row(6, day(8, 1), "30000.00", "credit", posted=False, entry=3)])
    assert diff.actions == (Action("create", 1, None, (), NewRow(
        "credit", D("30000.00"), day(7, 16), None, "Salary"), 6),)


def test_a_transfer_keeps_its_dates_and_is_matched():
    st = statement([line(1, day(7, 11), "5000.00", posting=day(7, 12))])
    diff = run(st, [row(7, day(7, 10), "5000.00", transfer=True)])
    assert diff.balanced and diff.actions == (Action("matched", 1, 7),)


def test_a_transfer_off_the_period_is_not_pulled_onto_it():
    st = statement([line(1, day(7, 31), "5000.00")])
    transfer = row(7, day(8, 1), "5000.00", "debit", transfer=True)
    diff = run(st, (), [transfer])
    assert diff.balanced
    assert diff.actions == (Action("create", 1, None, (), NewRow(
        "debit", D("5000.00"), day(7, 31), None, "Line 1"), 7),)


def test_a_transfer_differing_in_amount_is_an_update_of_the_amount_only():
    st = statement([line(1, day(7, 11), "5015.00")])
    diff = run(st, [row(7, day(7, 10), "5000.00", transfer=True)])
    assert diff.actions == (
        Action("update", 1, 7, (FieldChange("amount", D("5000.00"), D("5015.00")),)),)


def test_the_view_must_be_the_statements_period():
    st = statement([])
    for view in (AppStatementView(close=END, window_start=START, placement="transaction_date"),
                 AppStatementView(close=END, window_start=VIEW.window_start)):
        with pytest.raises(ValueError, match="period"):
            run(st, view=view)
    with pytest.raises(ValueError, match="debits or credits"):
        run(st, [row(1, day(7, 1), "1.00", "charge")])


def test_fingerprint_reads_the_period():
    st = statement([line(1, day(7, 1), "10.00")])
    rows = [row(1, day(7, 1), "10.00")]
    other = statement([line(1, day(7, 1), "10.00")], period_start="2026-07-02")
    assert fingerprint(st, VIEW, rows) != fingerprint(other, VIEW, rows)
    assert run(st, rows).fingerprint == fingerprint(st, VIEW, rows)


# --- property --------------------------------------------------------------------------------

AMOUNTS = [D("100.00"), D("100.00"), D("250.50"), D("99.99"), D("1000.00"), D("12.34")]


def _random_case(rng: random.Random):
    period = [START + timedelta(days=k) for k in range(31)]
    few_days = rng.sample(period, 4)  # same-day rows and lines are common
    lines = []
    for no in range(1, rng.randint(0, 9) + 1):
        kind = rng.choices(["debit", "credit"], [3, 2])[0]
        when = rng.choice(few_days)
        posting = rng.choice([None, None, when + timedelta(days=rng.randint(0, 3))])
        lines.append(line(no, when, rng.choice(AMOUNTS), kind, posting))
    st = statement(lines)
    ids = iter(rng.sample(range(1, 10_000), 60))
    cycle, candidates = [], []

    def near(x):
        return x + timedelta(days=rng.choice([-1, 0, 0, 1, 2]))

    def amount_like(x):
        return rng.choice([x, x, x + D("0.50"), rng.choice(AMOUNTS)])

    def linked():
        return rng.choice([{}, {}, {}, {"entry": 5}, {"transfer": True}])

    for x in st.lines:
        source = rng.random()
        if source < 0.45:  # on the period, maybe off by an amount or a day
            when = min(max(near(x.transaction_date), START), END)
            cycle.append(row(next(ids), when, amount_like(x.amount), x.kind, **linked()))
        elif source < 0.65:  # unposted
            candidates.append(row(next(ids), near(x.transaction_date), amount_like(x.amount),
                                  x.kind, posted=False, **linked()))
        elif source < 0.8:  # on a neighbouring period
            when = (START - timedelta(days=rng.randint(1, 3)) if rng.random() < 0.5
                    else END + timedelta(days=rng.randint(1, 3)))
            candidates.append(row(next(ids), when, x.amount, x.kind, **linked()))
    for _ in range(rng.randint(0, 4)):  # rows the statement does not list
        kind = rng.choice(["debit", "debit", "credit"])
        where = rng.random()
        if where < 0.5:
            cycle.append(row(next(ids), rng.choice(few_days), rng.choice(AMOUNTS), kind,
                             **linked()))
        elif where < 0.8:
            candidates.append(row(next(ids), rng.choice(few_days + [END + timedelta(days=5)]),
                                  rng.choice(AMOUNTS), kind, posted=False, **linked()))
        else:
            candidates.append(row(next(ids), START - timedelta(days=3), rng.choice(AMOUNTS),
                                  kind, **linked()))
    return st, cycle, candidates


def test_property_simulated_period_equals_statement():
    rng = random.Random(753)
    kinds_seen = set()
    for case in range(600):
        st, cycle, candidates = _random_case(rng)
        diff = run(st, cycle, candidates)
        kinds_seen.update(a.kind for a in diff.actions)
        assert simulated_balance(diff, cycle, candidates) == st.line_balance, case
        assert diff.balanced and diff.warnings == (), case
        row_ids = [a.row_id for a in diff.actions if a.row_id is not None]
        assert len(row_ids) == len(set(row_ids)), case
        assert sorted(a.line_no for a in diff.actions if a.line_no is not None) == \
            [x.line_no for x in st.lines], case
        acted = {a.row_id for a in diff.actions}
        assert all(r.id in acted for r in cycle), case
        # A transfer is never given a date.
        transfers = {r.id for r in (*cycle, *candidates) if r.keeps_dates}
        assert not any(c.field in ("transaction_date", "posting_date")
                       for a in diff.actions if a.row_id in transfers for c in a.changes), case
    assert kinds_seen == {"matched", "update", "move", "create", "unpost"}
