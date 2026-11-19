"""Reconcile a card statement from a JSON file, for the owner-run script (STU-752).

``scripts/reconcile_statement.py`` drives it. It calls the same service as
``POST /cards/{account_id}/statements/reconcile`` (``statement_reconcile_apply``),
acting as the user it is given: the card's owner/admin check and ``created_by_actor``
are that user's. Nothing here decides what changes; the diff and the apply are the
service's.

Output never carries an amount: ids, line numbers, dates, action kinds, field names,
warnings and refusal reasons. A field whose value is an amount is named, not shown.
See docs/statement-reconcile.md.
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field
from datetime import date
from typing import Dict, List

from fastapi import HTTPException
from sqlalchemy.orm import Session

from app.models.user import User
from app.schemas.statement_reconcile import BankStatement
from app.services import statement_reconcile as sr
from app.services import statement_reconcile_apply as reconcile
from app.services.fx import FxRates

DONE, REFUSED = 0, 3

# A decimal figure (1234.50) or a thousands-separated one (1,234): free text from the
# diff and from the write paths may carry one, and none is ever printed.
_AMOUNT = re.compile(r"-?\d{1,3}(?:,\d{3})+(?:\.\d+)?|-?\d+\.\d+")
_AMOUNT_FIELDS = ("amount", "minimum_due")


def scrub(text: object) -> str:
    """``text`` with every figure that looks like an amount replaced."""
    return _AMOUNT.sub("<amount>", str(text))


@dataclass
class Outcome:
    code: int
    lines: List[str] = field(default_factory=list)


def _show(value: object) -> str:
    if value is None:
        return "none"
    return value.isoformat() if isinstance(value, date) else str(value)


def _change(change: sr.FieldChange) -> str:
    if change.field in _AMOUNT_FIELDS:
        return "amount changes"
    return f"{change.field} {_show(change.before)} -> {_show(change.after)}"


def describe(result: sr.StatementDiff) -> List[str]:
    """The diff as output lines: no amount in any of them."""
    out: List[str] = []
    for header in result.header:
        if header.field == "minimum_due":
            out.append("header: minimum_due differs (amount changes)")
        else:
            out.append(f"header: {header.field} differs (statement {_show(header.statement)},"
                       f" app {_show(header.app)})")
    counts: Dict[str, int] = {}
    for action in result.actions:
        counts[action.kind] = counts.get(action.kind, 0) + 1
        parts = [action.kind]
        if action.line_no is not None:
            parts.append(f"line {action.line_no}")
        if action.row_id is not None:
            parts.append(f"row {action.row_id}")
        text = " ".join(parts)
        if action.changes:
            text += ": " + "; ".join(_change(c) for c in action.changes)
        if action.new_row is not None:
            new = action.new_row
            text += (f": {new.kind}, transaction_date {_show(new.transaction_date)},"
                     f" posting_date {_show(new.posting_date)}")
        if action.possible_duplicate_of is not None:
            text += f" (may duplicate recurring row {action.possible_duplicate_of})"
        out.append(f"action: {text}")
    out.append("actions: " + (", ".join(f"{kind} {n}" for kind, n in sorted(counts.items()))
                              or "none"))
    for warning in result.warnings:
        out.append(f"warning: line {warning.line_no}: {scrub(warning.reason)}")
    out.append(f"balanced: {'yes' if result.balanced else 'no'}")
    out.append(f"fingerprint: {result.fingerprint}")
    return out


def refusal(exc: HTTPException) -> List[str]:
    """A refusal as output lines: its reason and the ids it names, never a figure."""
    detail = exc.detail
    if not isinstance(detail, dict):
        return [f"refused: {scrub(detail)} (HTTP {exc.status_code})"]
    out = [f"refused: {scrub(detail.get('message', ''))} (HTTP {exc.status_code})"]
    for key in ("row_id", "line_no", "field"):
        if key in detail:
            out.append(f"  {key}: {scrub(detail[key])}")
    if "gap" in detail:
        out.append("  the app's statement and the bank's differ by an amount (not shown)")
    return out


def run(db: Session, *, actor_user_id: int, card_id: int, statement: BankStatement,
        apply: bool, fx: FxRates) -> Outcome:
    """A dry run, or a dry run then an apply with its fingerprint. Commits only an
    apply that succeeded; a refusal writes nothing."""
    user = db.get(User, actor_user_id)
    if user is None or not user.is_active:
        return Outcome(REFUSED, [f"refused: user {actor_user_id} is not an active user"])
    try:
        card = reconcile.managed_card(db, user, card_id)
        loaded = reconcile.load(db, user, card, statement, fx)
        result = reconcile.diff(loaded, statement)
    except HTTPException as exc:
        db.rollback()
        return Outcome(REFUSED, refusal(exc))
    lines = [f"card: {card.id}", f"statement: closes {statement.header.close_date.isoformat()}"
             f" (app: {loaded.view.close.isoformat()})", *describe(result),
             *(f"note: {scrub(note)}" for note in reconcile.unpost_notes(loaded, result))]
    if any(h.field == "close" for h in result.header):
        db.rollback()
        lines.append("refused: the statement's close is not the card's: change the card's "
                     "closing day first (see docs/statement-reconcile.md)")
        return Outcome(REFUSED, lines)
    if not result.balanced:
        db.rollback()
        lines.append("refused: the actions would not make the statement equal the bank's")
        return Outcome(REFUSED, lines)
    if not apply:
        db.rollback()  # the dry run reads only; drop anything the reads opened
        lines.append("dry run: nothing was written (--apply writes)")
        return Outcome(DONE, lines)
    try:
        applied = reconcile.apply(db, user, card, statement, result.fingerprint, fx)
        db.commit()
    except HTTPException as exc:  # apply has rolled back
        return Outcome(REFUSED, [*lines, *refusal(exc), "nothing was written"])
    for number, row_id in sorted(applied.created.items()):
        lines.append(f"created: line {number} as row {row_id}")
    lines.extend(f"note: {scrub(note)}" for note in applied.notes)
    lines.append(f"applied: statement closing {applied.reconciliation.statement_close.isoformat()}"
                 f" is recorded as reconciled ({applied.reconciliation.line_count} line items)")
    return Outcome(DONE, lines)
