"""What must change for a card's rows to equal a bank statement (STU-746; pure).

The statement always wins: it decides each line item's amount, its dates, that it is
posted and whether a row exists for it. The app keeps a row's description, category
and tags. A row on the statement's cycle that the statement does not list is
unposted, never deleted: an unposted row sits on the cycle open on the day it is read
(``statements.statement_day``), so it leaves this closed statement.

Nothing here reads or writes the database. The caller loads the rows as ``RowRecord``
values, calls ``diff_statement``, applies the actions through the existing write
paths and can check the result with ``simulate``.

Inputs
------
- ``cycle_rows``: the card's line-item rows on the statement (posted, placed by
  ``statement_day`` in ``(window_start, close]``).
- ``candidate_rows``: line-item rows off the cycle that the statement may claim: the
  card's unposted rows and the posted rows on the statements either side.
- ``payment_rows``: the card's payment transfers (transfers into the card).

A ``RowRecord``'s dates are calendar days: ``transaction_date`` is the row's
``transaction_date.date()`` and ``posting_date`` the Manila day of its
``posting_date`` (``app.core.time.manila_day``), as ``statements.statement_day``
reads them. ``amount`` is positive, in the card's currency; ``kind`` gives the sign
(a cash advance is a ``charge`` of its amount plus fee).

Matching (deterministic)
------------------------
1. Exact amount and kind. Every (line, row) pair of equal amount and kind is ranked by
   cycle rows before candidate rows, then the nearest transaction date, then the
   lowest row id, then the lowest ``line_no``; pairs are taken in that order while
   both sides are free.
2. Then a line and a row of the same kind whose amounts differ are paired only when
   unambiguous: within one day of each other, the line has exactly one remaining row
   within a day and that row has exactly one remaining line within a day.
3. Anything else stays unpaired: a line is a ``create``, a cycle row an ``unpost``; an
   unpaired candidate row is left alone.

A pair on the cycle is ``matched`` when nothing differs, else an ``update``; a pair with
a candidate row is a ``move`` (posted, and given the statement's amount and dates).

Dates. A row's target dates are the line's ``transaction_date`` and ``posting_date``
(none when the line gives none). A row linked to a recurring entry (``budget_entry_id``
set) keeps its dates and only its amount is compared; such a candidate row is paired
only when its own dates, once posted, place it on this statement.

Payments. A ``payment`` line is paired with a payment row by rule 1 only (exact amount,
nearest date, lowest id) and reported ``matched`` or ``missing``; payments never
change the line balance and produce no writes.

Close. When the statement's close differs from the app's, the header diff says so and
there are no row actions: the rows are placed on another cycle than the statement's.
"""
from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta
from decimal import Decimal
from typing import Dict, Iterable, List, Literal, Optional, Sequence, Tuple

from app.schemas.statement_reconcile import BankStatement, StatementLine

RowKind = Literal["charge", "credit", "payment"]
ActionKind = Literal["matched", "update", "move", "create", "unpost", "missing"]

CYCLE, CANDIDATE = 0, 1
ONE_DAY = timedelta(days=1)


@dataclass(frozen=True)
class RowRecord:
    """A card row as the diff reads it (not an ORM object)."""
    id: int
    kind: RowKind
    amount: Decimal
    transaction_date: date
    posting_date: Optional[date]
    is_posted: bool
    updated_at: Optional[datetime]
    budget_entry_id: Optional[int] = None


@dataclass(frozen=True)
class AppStatementView:
    """The app's own view of the statement: its computed close, due and minimum due,
    and the start of its window (the previous close; the window is
    ``(window_start, close]``)."""
    close: date
    window_start: date
    due: Optional[date] = None
    minimum_due: Optional[Decimal] = None


@dataclass(frozen=True)
class HeaderDiff:
    field: Literal["close", "due", "minimum_due"]
    statement: object
    app: object


@dataclass(frozen=True)
class FieldChange:
    field: Literal["amount", "transaction_date", "posting_date", "is_posted"]
    before: object
    after: object


@dataclass(frozen=True)
class NewRow:
    """The row a ``create`` adds: posted, uncategorised, from the line."""
    kind: RowKind
    amount: Decimal
    transaction_date: date
    posting_date: Optional[date]
    description: str
    is_posted: bool = True
    category_id: Optional[int] = None


@dataclass(frozen=True)
class Action:
    kind: ActionKind
    line_no: Optional[int] = None
    row_id: Optional[int] = None
    changes: Tuple[FieldChange, ...] = ()
    new_row: Optional[NewRow] = None


@dataclass(frozen=True)
class StatementDiff:
    fingerprint: str
    header: Tuple[HeaderDiff, ...]
    actions: Tuple[Action, ...] = field(default_factory=tuple)


# --- Fingerprint ------------------------------------------------------------------------


def _canon(value):
    if isinstance(value, Decimal):
        return f"{value:.2f}"
    if isinstance(value, (date, datetime)):
        return value.isoformat()
    return value


def fingerprint(statement: BankStatement, rows: Iterable[RowRecord]) -> str:
    """SHA-256 over the canonical statement JSON (keys sorted, lines by ``line_no``)
    and, for every row read, its id, amount, dates, posted flag and ``updated_at``
    (rows by id). Input order does not change it."""
    header = {k: _canon(v) for k, v in statement.header.model_dump().items()}
    lines = [{k: _canon(v) for k, v in line.model_dump().items()}
             for line in sorted(statement.lines, key=lambda line: line.line_no)]
    read = [[r.id, _canon(r.amount), _canon(r.transaction_date), _canon(r.posting_date),
             r.is_posted, _canon(r.updated_at)]
            for r in sorted(rows, key=lambda r: r.id)]
    body = json.dumps({"statement": {"header": header, "lines": lines}, "rows": read},
                      sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(body.encode("utf-8")).hexdigest()


# --- Diff -------------------------------------------------------------------------------


def _posted_day(transaction_date: date, posting_date: Optional[date]) -> date:
    """``statements.statement_day`` of a posted row with these dates."""
    return max(transaction_date, posting_date) if posting_date is not None else transaction_date


def _header_diff(statement: BankStatement, view: AppStatementView) -> List[HeaderDiff]:
    header = statement.header
    out: List[HeaderDiff] = []
    if header.close_date != view.close:
        out.append(HeaderDiff("close", header.close_date, view.close))
    if header.due_date is not None and header.due_date != view.due:
        out.append(HeaderDiff("due", header.due_date, view.due))
    if header.minimum_due is not None and header.minimum_due != view.minimum_due:
        out.append(HeaderDiff("minimum_due", header.minimum_due, view.minimum_due))
    return out


def _distance(line: StatementLine, row: RowRecord) -> int:
    return abs((line.transaction_date - row.transaction_date).days)


def _exact_pairs(lines: Sequence[StatementLine], pool: Sequence[Tuple[int, RowRecord]]
                 ) -> List[Tuple[StatementLine, int, RowRecord]]:
    """Rule 1: pairs of equal amount and kind, best ranked first, each side used once."""
    by_key: Dict[Tuple[str, Decimal], List[Tuple[int, RowRecord]]] = {}
    for rank, row in pool:
        by_key.setdefault((row.kind, row.amount), []).append((rank, row))
    ranked = []
    for line in lines:
        for rank, row in by_key.get((line.kind, line.amount), ()):
            ranked.append(((rank, _distance(line, row), row.id, line.line_no), line, rank, row))
    ranked.sort(key=lambda item: item[0])
    used_lines: set = set()
    used_rows: set = set()
    pairs = []
    for _, line, rank, row in ranked:
        if line.line_no in used_lines or row.id in used_rows:
            continue
        used_lines.add(line.line_no)
        used_rows.add(row.id)
        pairs.append((line, rank, row))
    return pairs


def _unambiguous_pairs(lines: Sequence[StatementLine], pool: Sequence[Tuple[int, RowRecord]]
                       ) -> List[Tuple[StatementLine, int, RowRecord]]:
    """Rule 2: a line and a row of the same kind within one day of each other, when
    each is the other's only remaining counterpart within a day."""
    near_rows: Dict[int, List[Tuple[int, RowRecord]]] = {}
    near_lines: Dict[int, List[StatementLine]] = {}
    for line in lines:
        for rank, row in pool:
            if row.kind == line.kind and _distance(line, row) <= 1:
                near_rows.setdefault(line.line_no, []).append((rank, row))
                near_lines.setdefault(row.id, []).append(line)
    pairs = []
    for line in lines:
        found = near_rows.get(line.line_no, [])
        if len(found) == 1 and len(near_lines[found[0][1].id]) == 1:
            rank, row = found[0]
            pairs.append((line, rank, row))
    return pairs


def _row_changes(line: StatementLine, row: RowRecord) -> Tuple[FieldChange, ...]:
    changes: List[FieldChange] = []
    if row.amount != line.amount:
        changes.append(FieldChange("amount", row.amount, line.amount))
    if row.budget_entry_id is None:
        if row.transaction_date != line.transaction_date:
            changes.append(FieldChange("transaction_date", row.transaction_date,
                                       line.transaction_date))
        if row.posting_date != line.posting_date:
            changes.append(FieldChange("posting_date", row.posting_date, line.posting_date))
    if not row.is_posted:
        changes.append(FieldChange("is_posted", False, True))
    return tuple(changes)


def _pair_action(line: StatementLine, rank: int, row: RowRecord) -> Action:
    changes = _row_changes(line, row)
    if rank == CANDIDATE:
        return Action("move", line.line_no, row.id, changes)
    return Action("update" if changes else "matched", line.line_no, row.id, changes)


def _check_rows(cycle_rows, candidate_rows, payment_rows) -> None:
    ids = [r.id for r in (*cycle_rows, *candidate_rows, *payment_rows)]
    if len(set(ids)) != len(ids):
        raise ValueError("a row id is given more than once")
    if any(r.kind == "payment" for r in (*cycle_rows, *candidate_rows)):
        raise ValueError("a payment row is not a line item")
    if any(r.kind != "payment" for r in payment_rows):
        raise ValueError("payment_rows takes payment rows only")


def _sort_key(action: Action):
    return (action.line_no is None, action.line_no or 0, action.row_id or 0)


def diff_statement(statement: BankStatement, view: AppStatementView,
                   cycle_rows: Sequence[RowRecord], candidate_rows: Sequence[RowRecord],
                   payment_rows: Sequence[RowRecord] = ()) -> StatementDiff:
    """The header diff and one action per line or row; see the module docstring."""
    _check_rows(cycle_rows, candidate_rows, payment_rows)
    digest = fingerprint(statement, (*cycle_rows, *candidate_rows, *payment_rows))
    header = tuple(_header_diff(statement, view))
    if statement.header.close_date != view.close:
        return StatementDiff(digest, header, ())

    def placeable(row: RowRecord) -> bool:
        # A recurring row keeps its dates: it can only be posted where they put it.
        return (row.budget_entry_id is None
                or view.window_start < _posted_day(row.transaction_date, row.posting_date)
                <= view.close)

    pool = ([(CYCLE, r) for r in cycle_rows]
            + [(CANDIDATE, r) for r in candidate_rows if placeable(r)])
    items = [line for line in statement.lines if line.kind != "payment"]
    actions: List[Action] = []

    paired = _exact_pairs(items, pool)
    taken_lines = {line.line_no for line, _, _ in paired}
    taken_rows = {row.id for _, _, row in paired}
    rest_lines = [line for line in items if line.line_no not in taken_lines]
    rest_pool = [(rank, row) for rank, row in pool if row.id not in taken_rows]
    for line, rank, row in paired + _unambiguous_pairs(rest_lines, rest_pool):
        taken_lines.add(line.line_no)
        taken_rows.add(row.id)
        actions.append(_pair_action(line, rank, row))

    for line in items:
        if line.line_no not in taken_lines:
            actions.append(Action("create", line.line_no, None, (), NewRow(
                line.kind, line.amount, line.transaction_date, line.posting_date,
                line.description)))
    for row in cycle_rows:
        if row.id not in taken_rows:
            actions.append(Action("unpost", None, row.id,
                                  (FieldChange("is_posted", row.is_posted, False),)))

    payment_lines = [line for line in statement.lines if line.kind == "payment"]
    payments = _exact_pairs(payment_lines, [(CYCLE, r) for r in payment_rows])
    found = {line.line_no for line, _, _ in payments}
    actions += [Action("matched", line.line_no, row.id) for line, _, row in payments]
    actions += [Action("missing", line.line_no) for line in payment_lines
                if line.line_no not in found]

    return StatementDiff(digest, header, tuple(sorted(actions, key=_sort_key)))


# --- Simulation -------------------------------------------------------------------------


@dataclass(frozen=True)
class SimulatedRow:
    """A line item after the actions: ``row_id`` for an existing row, ``line_no`` for
    one a ``create`` adds."""
    row_id: Optional[int]
    line_no: Optional[int]
    kind: RowKind
    amount: Decimal
    transaction_date: date
    posting_date: Optional[date]
    is_posted: bool


def simulate(rows: Sequence[RowRecord], actions: Sequence[Action], *,
             window_start: date, close: date) -> List[SimulatedRow]:
    """The statement's rows after ``actions``: every row of ``rows`` with its changes
    applied, plus the created rows, kept when it is a posted line item whose
    ``statement_day`` falls in ``(window_start, close]`` (a closed statement holds
    posted rows only). Sorted by row id, then created rows by ``line_no``."""
    changes = {a.row_id: a.changes for a in actions if a.row_id is not None}
    out: List[SimulatedRow] = []
    for row in rows:
        values = {"amount": row.amount, "transaction_date": row.transaction_date,
                  "posting_date": row.posting_date, "is_posted": row.is_posted}
        for change in changes.get(row.id, ()):
            values[change.field] = change.after
        out.append(SimulatedRow(row.id, None, row.kind, **values))
    for action in actions:
        if action.kind == "create" and action.new_row is not None:
            new = action.new_row
            out.append(SimulatedRow(None, action.line_no, new.kind, new.amount,
                                    new.transaction_date, new.posting_date, new.is_posted))
    kept = [r for r in out if r.kind != "payment" and r.is_posted
            and window_start < _posted_day(r.transaction_date, r.posting_date) <= close]
    return sorted(kept, key=lambda r: (r.row_id is None, r.row_id or 0, r.line_no or 0))


def line_balance(rows: Iterable[SimulatedRow]) -> Decimal:
    """Charges less credits."""
    total = Decimal("0")
    for row in rows:
        if row.kind == "charge":
            total += row.amount
        elif row.kind == "credit":
            total -= row.amount
    return total
