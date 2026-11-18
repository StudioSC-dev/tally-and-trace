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
set) keeps its ``transaction_date``; its ``posting_date`` follows the line, since a
posted row is placed on the later of its own day and its posting day:

- a candidate row (a ``move``) takes the line's posting date, else the line's
  transaction date when that is after the row's own day, else keeps its own posting
  date when that still places it on this statement, else none;
- a cycle row takes the line's posting date when the line gives one; otherwise its
  posting date changes only when needed to keep it on this statement (to the line's
  transaction date when that is after the row's own day, else none).

A recurring candidate row is paired with a line only when, so dated, it lands on this
statement (a row whose own day is after the close never does). When a line becomes a
``create`` and a recurring candidate of the same kind and amount was left out only for
that reason, the ``create`` names it in ``possible_duplicate_of`` (lowest id).

Warnings. A line whose resulting row would not land on this statement (its dates fall
outside ``(window_start, close]``) still gets its action, and ``warnings`` names it.
``balanced`` is True only when ``simulate`` on the actions gives the statement's line
balance; an apply must be refused when it is False.

Payments. A ``payment`` line is paired with a payment row by rule 1 only (exact amount,
nearest date, lowest id) and reported ``matched`` or ``missing``; payments never
change the line balance and produce no writes.

Close. When the statement's close differs from the app's, the header diff says so and
there are no row actions: the rows are placed on another cycle than the statement's.

A savings, checking or e-wallet statement (``diff_account_statement``, STU-753)
--------------------------------------------------------------------------------
The same matching rules and action kinds over the account's rows, with three
differences:

- The window is the statement's period: ``window_start`` is the day before
  ``period_start`` and ``close`` is ``period_end``. A posted row is placed by its own
  ``transaction_date`` (``placement="transaction_date"``), as the account's balance
  reads it; its ``posting_date`` never moves it.
- Rows and lines are ``debit`` (money out) or ``credit`` (money in); a debit counts
  like a charge in ``line_balance``, so the statement's line balance is debits less
  credits. There are no payments and no header diff.
- A transfer between two accounts is one row carrying both sides, each placed by the
  same date; its ``RowRecord`` has ``keeps_dates``. It keeps both its dates whatever
  the line says (the other account's statement may print another day), so, like a
  recurring candidate, it is paired only where its own date lands, and a ``create``
  that it was left out for names it in ``possible_duplicate_of``.
- The fee pairing, before rule 1 (STU-774): the source side of a transfer with a fee
  (its ``RowRecord.fee``, set only on a bank account's statement) is one row whose
  amount is the transfer's amount plus its fee, while a bank may print the fee as a
  line of its own. A posted cycle row with a ``fee`` above 0 is ``matched`` to two
  lines, one action each: the one debit line equal to its amount less the fee and the
  one debit line equal to the fee, both within one day of it, when there is exactly
  one of each, they are distinct lines, and neither could be either line of another
  such row. Otherwise the row falls to rules 1 to 3 unchanged.
"""
from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass
from datetime import date, datetime, timedelta
from decimal import Decimal
from typing import Dict, Iterable, List, Literal, Optional, Sequence, Tuple

from app.schemas.statement_reconcile import AccountStatement, BankStatement, StatementLine

RowKind = Literal["charge", "credit", "payment", "debit"]
ActionKind = Literal["matched", "update", "move", "create", "unpost", "missing"]
Placement = Literal["statement_day", "transaction_date"]

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
    # One side of a transfer on a bank account's statement: its dates are kept.
    keeps_dates: bool = False
    # The source side of a transfer on a bank account's statement: the fee inside
    # ``amount`` (``amount`` is the transfer's amount plus it), for the fee pairing.
    fee: Optional[Decimal] = None


@dataclass(frozen=True)
class AppStatementView:
    """The app's own view of the statement: its computed close, due and minimum due,
    and the start of its window (the previous close; the window is
    ``(window_start, close]``)."""
    close: date
    window_start: date
    due: Optional[date] = None
    minimum_due: Optional[Decimal] = None
    # What places a posted row: a card's ``statement_day`` (the later of its own day
    # and its posting day) or, on a bank account, its own ``transaction_date``.
    placement: Placement = "statement_day"


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
    possible_duplicate_of: Optional[int] = None


@dataclass(frozen=True)
class DiffWarning:
    line_no: int
    reason: str


@dataclass(frozen=True)
class StatementDiff:
    fingerprint: str
    header: Tuple[HeaderDiff, ...]
    actions: Tuple[Action, ...] = ()
    warnings: Tuple[DiffWarning, ...] = ()
    balanced: bool = False


# --- Fingerprint ------------------------------------------------------------------------


def _canon(value):
    if isinstance(value, Decimal):
        return f"{value:.2f}"
    if isinstance(value, (date, datetime)):
        return value.isoformat()
    return value


def fingerprint(statement: BankStatement, view: AppStatementView,
                rows: Iterable[RowRecord]) -> str:
    """SHA-256 over the canonical statement JSON (keys sorted, lines by ``line_no``),
    the app's view (close, window start, due, minimum due) and, for every row read,
    its id, amount, dates, posted flag and ``updated_at`` (rows by id). Input order
    does not change it; a change to the card's cycle settings or overrides does."""
    header = {k: _canon(v) for k, v in statement.header.model_dump().items()}
    lines = [{k: _canon(v) for k, v in line.model_dump().items()}
             for line in sorted(statement.lines, key=lambda line: line.line_no)]
    read = [[r.id, _canon(r.amount), _canon(r.transaction_date), _canon(r.posting_date),
             r.is_posted, _canon(r.updated_at)] + ([_canon(r.fee)] if r.fee is not None else [])
            for r in sorted(rows, key=lambda r: r.id)]
    app = {"close": _canon(view.close), "window_start": _canon(view.window_start),
           "due": _canon(view.due), "minimum_due": _canon(view.minimum_due)}
    body = json.dumps({"statement": {"header": header, "lines": lines}, "view": app,
                       "rows": read},
                      sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(body.encode("utf-8")).hexdigest()


# --- Diff -------------------------------------------------------------------------------


def _posted_day(transaction_date: date, posting_date: Optional[date],
                placement: Placement = "statement_day") -> date:
    """The day that places a posted row with these dates: ``statements.statement_day``,
    or its own day under ``placement="transaction_date"``."""
    if placement == "transaction_date" or posting_date is None:
        return transaction_date
    return max(transaction_date, posting_date)


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


def _exact_pairs(lines: Sequence[StatementLine], pool: Sequence[Tuple[int, RowRecord]],
                 eligible=lambda line, rank, row: True
                 ) -> List[Tuple[StatementLine, int, RowRecord]]:
    """Rule 1: pairs of equal amount and kind, best ranked first, each side used once."""
    by_key: Dict[Tuple[str, Decimal], List[Tuple[int, RowRecord]]] = {}
    for rank, row in pool:
        by_key.setdefault((row.kind, row.amount), []).append((rank, row))
    ranked = []
    for line in lines:
        for rank, row in by_key.get((line.kind, line.amount), ()):
            if not eligible(line, rank, row):
                continue
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


def _fee_pairs(lines: Sequence[StatementLine], pool: Sequence[Tuple[int, RowRecord]]
               ) -> List[Tuple[StatementLine, StatementLine, RowRecord]]:
    """The fee pairing: ``(amount line, fee line, row)`` for a posted cycle row with a
    ``fee`` above 0 and exactly one line of each, distinct, both debits within one day
    of it: one equal to its amount less the fee, one equal to the fee. A line that
    could be either line of another such row is never paired."""
    near: Dict[int, Tuple[List[StatementLine], List[StatementLine]]] = {}
    for rank, row in pool:
        if rank != CYCLE or not row.is_posted or row.kind != "debit" or not row.fee:
            continue
        close = [line for line in lines
                 if line.kind == "debit" and _distance(line, row) <= 1]
        near[row.id] = ([line for line in close if line.amount == row.amount - row.fee],
                        [line for line in close if line.amount == row.fee])
    claims: Dict[int, int] = {}
    for amounts, fees in near.values():
        for line_no in {line.line_no for line in (*amounts, *fees)}:
            claims[line_no] = claims.get(line_no, 0) + 1
    rows = {row.id: row for _, row in pool}
    pairs = []
    for row_id, (amounts, fees) in near.items():
        if len(amounts) == 1 and len(fees) == 1 and amounts[0].line_no != fees[0].line_no \
                and claims[amounts[0].line_no] == claims[fees[0].line_no] == 1:
            pairs.append((amounts[0], fees[0], rows[row_id]))
    return pairs


def _unambiguous_pairs(lines: Sequence[StatementLine], pool: Sequence[Tuple[int, RowRecord]],
                       eligible) -> List[Tuple[StatementLine, int, RowRecord]]:
    """Rule 2: a line and a row of the same kind within one day of each other, when
    each is the other's only remaining counterpart within a day."""
    near_rows: Dict[int, List[Tuple[int, RowRecord]]] = {}
    near_lines: Dict[int, List[StatementLine]] = {}
    for line in lines:
        for rank, row in pool:
            if row.kind == line.kind and _distance(line, row) <= 1 and eligible(line, rank, row):
                near_rows.setdefault(line.line_no, []).append((rank, row))
                near_lines.setdefault(row.id, []).append(line)
    pairs = []
    for line in lines:
        found = near_rows.get(line.line_no, [])
        if len(found) == 1 and len(near_lines[found[0][1].id]) == 1:
            rank, row = found[0]
            pairs.append((line, rank, row))
    return pairs


def _lands(view: AppStatementView, transaction_date: date, posting_date: Optional[date]) -> bool:
    return view.window_start < _posted_day(transaction_date, posting_date,
                                           view.placement) <= view.close


def _target_dates(view: AppStatementView, line: StatementLine, rank: int, row: RowRecord
                  ) -> Tuple[date, Optional[date]]:
    """The dates ``row`` takes when paired with ``line`` (see the module docstring)."""
    if row.keeps_dates:
        return row.transaction_date, row.posting_date
    if row.budget_entry_id is None:
        return line.transaction_date, line.posting_date
    own = row.transaction_date
    if line.posting_date is not None:
        return own, line.posting_date
    later = line.transaction_date if line.transaction_date > own else None
    if rank == CANDIDATE and later is not None:
        return own, later
    if _lands(view, own, row.posting_date):
        return own, row.posting_date
    return own, later


def _row_changes(view: AppStatementView, line: StatementLine, rank: int, row: RowRecord
                 ) -> Tuple[FieldChange, ...]:
    changes: List[FieldChange] = []
    if row.amount != line.amount:
        changes.append(FieldChange("amount", row.amount, line.amount))
    transaction_date, posting_date = _target_dates(view, line, rank, row)
    if row.transaction_date != transaction_date:
        changes.append(FieldChange("transaction_date", row.transaction_date, transaction_date))
    if row.posting_date != posting_date:
        changes.append(FieldChange("posting_date", row.posting_date, posting_date))
    if not row.is_posted:
        changes.append(FieldChange("is_posted", False, True))
    return tuple(changes)


def _pair_action(view: AppStatementView, line: StatementLine, rank: int, row: RowRecord
                 ) -> Action:
    changes = _row_changes(view, line, rank, row)
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


def _keeps_day(row: RowRecord) -> bool:
    """A row that keeps its own transaction date: linked to a recurring entry, or a
    transfer side that keeps both dates."""
    return row.budget_entry_id is not None or row.keeps_dates


def _sort_key(action: Action):
    return (action.line_no is None, action.line_no or 0, action.row_id or 0)


def diff_statement(statement: BankStatement, view: AppStatementView,
                   cycle_rows: Sequence[RowRecord], candidate_rows: Sequence[RowRecord],
                   payment_rows: Sequence[RowRecord] = ()) -> StatementDiff:
    """The header diff and one action per line or row; see the module docstring."""
    _check_rows(cycle_rows, candidate_rows, payment_rows)
    digest = fingerprint(statement, view, (*cycle_rows, *candidate_rows, *payment_rows))
    header = tuple(_header_diff(statement, view))
    if statement.header.close_date != view.close:
        return StatementDiff(digest, header)
    return _row_diff(statement, view, cycle_rows, candidate_rows, payment_rows, digest, header)


def _row_diff(statement, view: AppStatementView, cycle_rows: Sequence[RowRecord],
              candidate_rows: Sequence[RowRecord], payment_rows: Sequence[RowRecord],
              digest: str, header: Tuple[HeaderDiff, ...]) -> StatementDiff:
    """The row actions, warnings and ``balanced`` of a statement whose window is
    ``view``'s (matching rules 1 to 3, see the module docstring)."""
    def eligible(line: StatementLine, rank: int, row: RowRecord) -> bool:
        # A recurring candidate keeps its own day: it can only be posted where that,
        # with the statement's posting date, puts it.
        return (rank == CYCLE or not _keeps_day(row)
                or _lands(view, *_target_dates(view, line, rank, row)))

    pool = [(CYCLE, r) for r in cycle_rows] + [(CANDIDATE, r) for r in candidate_rows]
    items = [line for line in statement.lines if line.kind != "payment"]
    actions: List[Action] = []

    for amount_line, fee_line, row in _fee_pairs(items, pool):
        actions += [Action("matched", amount_line.line_no, row.id),
                    Action("matched", fee_line.line_no, row.id)]
    fee_lines = {a.line_no for a in actions}
    fee_rows = {a.row_id for a in actions}
    paired = _exact_pairs([line for line in items if line.line_no not in fee_lines],
                          [(rank, row) for rank, row in pool if row.id not in fee_rows],
                          eligible)
    taken_lines = fee_lines | {line.line_no for line, _, _ in paired}
    taken_rows = fee_rows | {row.id for _, _, row in paired}
    rest_lines = [line for line in items if line.line_no not in taken_lines]
    rest_pool = [(rank, row) for rank, row in pool if row.id not in taken_rows]
    for line, rank, row in paired + _unambiguous_pairs(rest_lines, rest_pool, eligible):
        taken_lines.add(line.line_no)
        taken_rows.add(row.id)
        actions.append(_pair_action(view, line, rank, row))

    for line in items:
        if line.line_no not in taken_lines:
            left_out = [r.id for r in candidate_rows
                        if r.id not in taken_rows and _keeps_day(r)
                        and r.kind == line.kind and r.amount == line.amount
                        and not eligible(line, CANDIDATE, r)]
            actions.append(Action("create", line.line_no, None, (), NewRow(
                line.kind, line.amount, line.transaction_date, line.posting_date,
                line.description), min(left_out) if left_out else None))
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

    actions.sort(key=_sort_key)
    rows = [*cycle_rows, *candidate_rows]
    after = _apply(rows, actions)
    by_row = {r.row_id: r for r in after if r.row_id is not None}
    by_line = {r.line_no: r for r in after if r.line_no is not None}
    item_nos = {line.line_no for line in items}
    warnings = []
    for action in actions:
        if action.line_no not in item_nos:
            continue
        result = by_row[action.row_id] if action.row_id is not None else by_line[action.line_no]
        if not _lands(view, result.transaction_date, result.posting_date):
            day = _posted_day(result.transaction_date, result.posting_date, view.placement)
            warnings.append(DiffWarning(action.line_no, (
                f"its dates place it on {day.isoformat()}, outside this statement"
                f" ({view.window_start.isoformat()}, {view.close.isoformat()}]")))
    balanced = line_balance(simulate(rows, actions, window_start=view.window_start,
                                     close=view.close, placement=view.placement)
                            ) == statement.line_balance
    return StatementDiff(digest, header, tuple(actions), tuple(warnings), balanced)


def diff_account_statement(statement: AccountStatement, view: AppStatementView,
                           cycle_rows: Sequence[RowRecord],
                           candidate_rows: Sequence[RowRecord]) -> StatementDiff:
    """One action per line or row of a savings, checking or e-wallet statement (see
    "A savings, checking or e-wallet statement" in the module docstring). ``view`` is
    the period: ``window_start`` the day before ``period_start``, ``close`` the
    ``period_end``, ``placement`` ``"transaction_date"``; rows are ``debit`` or
    ``credit``."""
    header = statement.header
    if (view.close != header.period_end
            or view.window_start != header.period_start - ONE_DAY
            or view.placement != "transaction_date"):
        raise ValueError("the view is not the statement's period")
    if any(r.kind not in ("debit", "credit") for r in (*cycle_rows, *candidate_rows)):
        raise ValueError("an account's rows are debits or credits")
    _check_rows(cycle_rows, candidate_rows, ())
    digest = fingerprint(statement, view, (*cycle_rows, *candidate_rows))
    return _row_diff(statement, view, cycle_rows, candidate_rows, (), digest, ())


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
             window_start: date, close: date,
             placement: Placement = "statement_day") -> List[SimulatedRow]:
    """The statement's rows after ``actions``: every row of ``rows`` with its changes
    applied, plus the created rows, kept when it is a posted line item whose
    ``statement_day`` (or own day, under ``placement="transaction_date"``) falls in
    ``(window_start, close]`` (a closed statement holds posted rows only). Sorted by
    row id, then created rows by ``line_no``."""
    kept = [r for r in _apply(rows, actions) if r.kind != "payment" and r.is_posted
            and window_start < _posted_day(r.transaction_date, r.posting_date,
                                           placement) <= close]
    return sorted(kept, key=lambda r: (r.row_id is None, r.row_id or 0, r.line_no or 0))


def _apply(rows: Sequence[RowRecord], actions: Sequence[Action]) -> List[SimulatedRow]:
    """Every row of ``rows`` with its changes applied, then the created rows."""
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
    return out


def line_balance(rows: Iterable[SimulatedRow]) -> Decimal:
    """Charges (and a bank account's debits) less credits."""
    total = Decimal("0")
    for row in rows:
        if row.kind in ("charge", "debit"):
            total += row.amount
        elif row.kind == "credit":
            total -= row.amount
    return total
