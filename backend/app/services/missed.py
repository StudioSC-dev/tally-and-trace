"""Missed recurring occurrences and row permissions for ``/dashboard/snapshot`` (STU-384).

- ``recurring_missed``: the snapshot's ``missed`` key. Every active recurring
  entry the caller sees in full or shared_full with occurrences before today
  (Manila) that no posted row records: cash expenses, income, transfers and
  capped entries (a billed card's installment included, whose lapsed months no
  other list shows). Open-ended card subscriptions and bills are left to
  ``card_charges``' ``missed`` (``card_charges._missed``), and wallet-funded
  spending is not counted, as the projection skips it.
- ``split_pending_links``: of each entry's missed occurrences, the ones a
  pending linked row already stands for, so a list can show each such
  occurrence once, as its pending row. Used by both missed lists.
- ``entry_row_fields``: ``kind`` and ``can_mark_paid`` on the snapshot's full
  budget-entry rows (``payables`` and ``upcoming_this_month``), so a list can
  offer an entry's actions without loading the entries itself.
"""
from __future__ import annotations

from collections import defaultdict
from datetime import datetime, timedelta
from typing import Dict, Iterable, List, Optional

from sqlalchemy import or_
from sqlalchemy.orm import Session

from app.core.access import (
    VIEW_ROLES, readable_criterion, touches_accounts, viewable_account_ids,
)
from app.core.redaction import FULL, LIMITED, Redactor
from app.core.tags import effective_tag_criterion
from app.core.time import manila_today
from app.models.account import AccountType
from app.models.budget_entry import BudgetEntry
from app.models.transaction import Transaction
from app.services import forecast as fc
from app.services.recurring_kinds import BILLING_KINDS, entry_kind, is_capped, is_kind_eligible


def split_pending_links(db: Session, entries, unrecorded: Dict[int, List[datetime]],
                        redactor: Redactor) -> Dict[int, dict]:
    """``{entry id: {"unlinked_count", "oldest_unlinked", "pending_transaction_ids"}}``.

    ``unrecorded`` is each entry's missed occurrences (``unrecorded_occurrences``,
    cut to the days a list counts). Each pending row linked to an entry
    (``_linked_rows`` with ``occurrence_match``, the projection's rule) stands
    for one occurrence on its day, so each missed occurrence takes at most one
    pending row on that day. ``unlinked_count`` and ``oldest_unlinked`` are the
    occurrences left without one; ``pending_transaction_ids`` are the rows
    taken. Only a row the caller may read and sees in full (its creator) is
    taken: shared_full and Limited views drop a row's ``budget_entry_id``, and
    naming the row beside its entry would rebuild that link, so for anyone else
    its occurrence stays unlinked.
    """
    entries = list(entries)
    linked = [(entry_id, when, txn_id) for entry_id, when, txn_id, is_posted in fc._linked_rows(
        db, [e.id for e in entries], occurrence_match=True) if not is_posted]
    txns = {t.id: t for t in db.query(Transaction).filter(
        Transaction.id.in_([txn_id for _, _, txn_id in linked]))} if linked else {}
    pending: Dict[tuple, List[int]] = defaultdict(list)
    for entry_id, when, txn_id in linked:
        txn = txns.get(txn_id)
        if txn is not None and redactor.access.readable(txn) and redactor.view(txn) == FULL:
            pending[(entry_id, fc._naive(when).date())].append(txn_id)

    taken: Dict[int, List[int]] = {}
    out: Dict[int, dict] = {}
    for entry in entries:
        unlinked: List[datetime] = []
        taken[entry.id] = []
        for occ in unrecorded.get(entry.id, []):
            rows = pending.get((entry.id, occ.date()))
            if rows:
                taken[entry.id].append(rows.pop(0))
            else:
                unlinked.append(occ)
        out[entry.id] = {
            "unlinked_count": len(unlinked),
            "oldest_unlinked": unlinked[0].date().isoformat() if unlinked else None,
            "pending_transaction_ids": sorted(taken[entry.id]),
        }
    return out


def _card_missed_covers(entry: BudgetEntry, account) -> bool:
    """What ``card_charges._missed`` lists: an open-ended subscription or bill on a card."""
    return (account is not None and account.account_type == AccountType.CREDIT
            and is_kind_eligible(entry) and not is_capped(entry)
            and entry_kind(entry, account) in BILLING_KINDS)


def recurring_missed(db: Session, user, *, redactor: Redactor,
                     tag_id: Optional[int]) -> List[dict]:
    """The snapshot's ``missed`` key (see the module docstring), sorted by
    ``oldest``, then name.

    ``count`` is the occurrences before today that no posted row records, from
    the entry's ``next_occurrence`` (``unrecorded_occurrences``, each calendar
    day once, capped entries at their cap), with ``oldest`` the first. A pending
    linked row records nothing yet; ``split_pending_links`` adds the occurrences
    without one. With ``tag_id`` only entries carrying it effectively are kept,
    as the payables are.
    """
    user_id = user.id
    access = redactor.access
    accounts = fc.get_account_balances(db, user_id)
    scope_account_ids = {a.id for a in accounts}
    direct_ids = viewable_account_ids(db, user_id)
    grants = list(access.grants.values())

    # The payables' disclosure: ``collect_events``' ``disclosed()`` (services/
    # forecast.py), without a household view. Keep the two in step.
    query = db.query(BudgetEntry).filter(
        readable_criterion(BudgetEntry, user_id, direct_ids, grants),
        or_(BudgetEntry.user_id == user_id, touches_accounts(BudgetEntry, scope_account_ids)),
        BudgetEntry.is_active.is_(True),
        BudgetEntry.account_id.isnot(None),
    )
    if tag_id is not None:
        query = query.filter(effective_tag_criterion(BudgetEntry, tag_id))
    entries = [e for e in query.order_by(BudgetEntry.id).all()
               if access.readable(e) and redactor.view(e) != LIMITED]
    if not entries:
        return []

    # Wallets as the projection judges them (``collect_events``): the scoped
    # ones plus any viewable account an entry is funded from.
    viewable_ids = viewable_account_ids(db, user_id, roles=VIEW_ROLES)
    wallet_ids = {a.id for a in accounts if fc.is_spending_wallet(a)} | fc.wallet_ids_of(
        db, (e.account_id for e in entries if e.account_id in viewable_ids))
    access.load(e.account_id for e in entries)
    entries = [e for e in entries
               if not _card_missed_covers(e, access.account(e.account_id))
               and not (e.transfer_to_account_id is None and e.account_id in wallet_ids)]

    today = manila_today()
    unrecorded = fc.unrecorded_occurrences(db, entries, through=today - timedelta(days=1))
    links = split_pending_links(db, entries, unrecorded, redactor)
    out = []
    for entry in entries:
        missed = unrecorded.get(entry.id, [])
        if not missed:
            continue
        account = access.account(entry.account_id)
        out.append({
            "view": redactor.view(entry),
            "entry_id": entry.id,
            "name": entry.name,
            "entry_type": entry.entry_type.value,
            "kind": entry_kind(entry, account),
            "is_transfer": entry.transfer_to_account_id is not None,
            "capped": is_capped(entry),
            "account_name": account.name if account is not None
            and redactor.can_view(account.id) else None,
            "count": len(missed),
            "oldest": missed[0].date().isoformat(),
            **links[entry.id],
            "can_mark_paid": bool(access.permissions(entry)["can_post"]),
        })
    out.sort(key=lambda row: (row["oldest"], row["name"]))
    return out


def entry_row_fields(db: Session, rows: Iterable[dict], redactor: Redactor) -> None:
    """Add ``kind`` (``entry_kind``) and ``can_mark_paid`` (the entry's
    ``can_post``, with an account to post to) to each full budget-entry row,
    in place. Limited rows and other sources are left as they are. One query
    for the entries, one for their accounts."""
    rows = [r for r in rows
            if r.get("view") != LIMITED and r.get("source") == "budget_entry"
            and r.get("source_id") is not None]
    if not rows:
        return
    ids = {r["source_id"] for r in rows}
    entries = {e.id: e for e in db.query(BudgetEntry).filter(BudgetEntry.id.in_(ids)).all()}
    access = redactor.access
    access.load(acc for e in entries.values()
                for acc in (e.account_id, e.transfer_to_account_id, e.overflow_account_id))
    for row in rows:
        entry = entries.get(row["source_id"])
        if entry is None:
            row["kind"], row["can_mark_paid"] = None, False
            continue
        row["kind"] = entry_kind(entry, access.account(entry.account_id))
        row["can_mark_paid"] = bool(access.permissions(entry)["can_post"]
                                    and entry.account_id is not None)
