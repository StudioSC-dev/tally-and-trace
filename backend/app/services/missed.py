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
- ``entry_row_fields``: ``kind``, ``plan_kind``, ``settlement`` and ``can_mark_paid`` on the snapshot's full
  budget-entry rows (``payables`` and ``upcoming_this_month``), so a list can
  offer an entry's actions without loading the entries itself.
- ``installment_snapshot``: the snapshot's ``installment_review`` and
  ``installment_auto_post`` keys (STU-343 Plan B), and each card installment's
  ``installment_state``, which ``recurring_missed`` repeats on its rows.
- ``autopay_due``: the snapshot's ``autopay_due`` key, the due autopay cash
  entries, a payment held by its funds or a duplicate among them.
- ``upcoming_occurrences``: ``GET /budget-entries/upcoming-occurrences``
  (STU-465), the occurrences after Manila's today that no row stands for yet,
  posted or pending, from the same entries as ``recurring_missed`` (card
  subscriptions, bills and wallet spending included), for the Transactions
  page's Upcoming list.
- ``installment_plans``: ``GET /budget-entries/installment-plans`` (STU-511),
  one row per active card installment with its next unrecorded charge, for the
  Transactions card's Installments tab.
"""
from __future__ import annotations

from collections import Counter, defaultdict
from dataclasses import dataclass
from datetime import date, datetime, timedelta
from typing import Dict, FrozenSet, Iterable, List, Optional, Sequence

from sqlalchemy import and_, or_
from sqlalchemy.orm import Session

from app.core.config import settings
from app.core.access import (
    VIEW_ROLES, readable_criterion, record_account_ids, touches_accounts, viewable_account_ids,
)
from app.core.redaction import FULL, LIMITED, Redactor
from app.core.tags import effective_tag_criterion
from app.core.time import manila_today
from app.models.account import AccountType
from app.models.budget_entry import BudgetEntry, BudgetEntryType
from app.models.transaction import Transaction, TransactionType
from app.services import forecast as fc
from app.services import posting as posting_svc
from app.services.installment_duplicates import held_occurrences
from app.services.payment_dates import effective, load_entry_overrides
from app.services.posting import OCCURRENCE_HORIZON, PostPlan, first_occurrence, post_plan
from app.services.recurring_kinds import (
    BILLING_KINDS, auto_post_block, auto_posts, entry_kind, is_capped, is_card_installment,
    is_kind_eligible, plan_kind, settlement,
)


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

def installment_state(entry: BudgetEntry, plan: PostPlan) -> str:
    """An auto-posted entry's state from ``post_plan``'s blocker (``blocker_state``)."""
    return blocker_state(plan.blocker)


def blocker_state(blocker: Optional[str]) -> str:
    """A ``post_plan`` blocker as a state: ``unreviewed``, ``off`` (reviewed,
    auto-post off), ``blocked`` (reviewed and on, but ``blocked:<reason>`` or
    ``creator_no_access``), ``held`` (a due month is held by a duplicate or, on a
    cash entry, its funds) or ``on``. ``caller_no_access`` leaves the state ``on``:
    it only empties the caller's ``postable``.
    """
    if blocker == "unreviewed":
        return "unreviewed"
    if blocker == "auto_post_off":
        return "off"
    if blocker in ("held", "insufficient_funds"):
        return "held"
    if blocker is not None and (blocker.startswith("blocked:") or blocker == "creator_no_access"):
        return "blocked"
    return "on"


def _block_reason(plan: PostPlan) -> Optional[str]:
    """Why a ``blocked`` installment cannot auto-post: ``foreign_currency``,
    ``no_statement_cycle``, ``ambiguous`` or ``creator_no_access``."""
    blocker = plan.blocker or ""
    return blocker.split(":", 1)[1] if blocker.startswith("blocked:") else blocker


@dataclass(frozen=True)
class InstallmentInfo:
    """One card installment as the caller sees it (``installment_snapshot``)."""
    entry: BudgetEntry
    plan: PostPlan
    state: str
    block_reason: Optional[str]
    can_edit: bool
    today: date


def installment_infos(db: Session, user, *, redactor: Redactor) -> Dict[int, InstallmentInfo]:
    """``{entry id: InstallmentInfo}`` for every active card installment the
    caller reads in full or shared_full (a Limited view is left out, as
    ``recurring_missed`` leaves it out), planned for the caller through Manila's
    today by ``post_plan``. One ``held_occurrences`` call covers the reviewed
    ones (the canonical assignment), so every caller sees the same held months.
    Not filtered by tag: the backstop posts whatever it can, whatever tag the
    page is showing.
    """
    access = redactor.access
    direct_ids = viewable_account_ids(db, user.id)
    grants = list(access.grants.values())
    candidates = db.query(BudgetEntry).filter(
        readable_criterion(BudgetEntry, user.id, direct_ids, grants),
        BudgetEntry.is_active.is_(True),
        BudgetEntry.account_id.isnot(None),
        BudgetEntry.end_mode == "after_occurrences",
    ).order_by(BudgetEntry.id).all()
    candidates = [e for e in candidates if access.readable(e) and redactor.view(e) != LIMITED]
    if not candidates:
        return {}
    access.load(e.account_id for e in candidates)
    entries = [e for e in candidates if is_card_installment(e, access.account(e.account_id))]
    if not entries:
        return {}
    today = manila_today()
    reviewed = [e for e in entries if e.installment_reviewed_at is not None]
    held = held_occurrences(db, reviewed, today) if reviewed else Counter()
    out: Dict[int, InstallmentInfo] = {}
    for entry in entries:
        plan = post_plan(db, entry, user, today, held, access)
        state = installment_state(entry, plan)
        out[entry.id] = InstallmentInfo(
            entry=entry, plan=plan, state=state,
            block_reason=_block_reason(plan) if state == "blocked" else None,
            can_edit=bool(access.permissions(entry)["can_edit"]), today=today)
    return out


def _clean_review(db: Session, entry: BudgetEntry, user, today: date) -> Optional[dict]:
    """``clean_review`` of an ``installment_review`` row (``installment_snapshot``):
    the review's binding when it has no missed month and no candidate, else None."""
    state = posting_svc.review_state(db, entry, user, today)
    if state.missed or state.candidates:
        return None
    return {"entry_version": posting_svc._iso(entry.updated_at), "review_token": state.token}


def installment_snapshot(db: Session, user, *, redactor: Redactor,
                         infos: Optional[Dict[int, InstallmentInfo]] = None) -> dict:
    """The snapshot's ``installment_review`` and ``installment_auto_post``.

    - ``installment_review``: active card installments the caller can edit that
      are not reviewed and have no ``auto_post_block``, with ``missed_count``
      (the months due through Manila's today) and ``clean_review``. Empty for
      a viewer or a tag viewer, who cannot edit.
    - ``clean_review`` (STU-474): for an entry whose review asks nothing (no
      missed month and so no candidate, by ``posting.review_state``, the
      review's own rule), the binding a batch review sends back:
      ``entry_version`` (``posting._iso`` of the stored ``updated_at``: aware
      UTC with a ``+00:00`` suffix, compared by the server as a datetime, so
      the GET's ``Z`` form is the same version) and the caller-bound
      ``review_token``. Null for any other row. Only callers who can edit
      the entry get a row, the callers the review accepts.
    - ``installment_auto_post``: active reviewed card installments the caller
      reads in full or shared_full with at least one month due, with the
      caller's ``postable_count``, ``due_today_count`` (the due months that
      fall on the Manila today the plan was computed through), the ``state``
      and ``block_reason``;
      ``can_post`` and ``can_review`` are both the caller's ``can_edit``. A
      viewer's or tag viewer's view is Limited, so they get no row.
    """
    if infos is None:
        infos = installment_infos(db, user, redactor=redactor)
    access = redactor.access

    def account_name(entry: BudgetEntry) -> Optional[str]:
        account = access.account(entry.account_id)
        return account.name if account is not None and redactor.can_view(account.id) else None

    review = []
    posting = []
    forced = load_entry_overrides(db, infos)
    for info in infos.values():
        entry, plan = info.entry, info.plan
        if entry.installment_reviewed_at is None:
            if info.can_edit and auto_post_block(entry, access.account(entry.account_id)) is None:
                review.append({"entry_id": entry.id, "name": entry.name,
                               "account_name": account_name(entry),
                               "missed_count": len(plan.due),
                               "clean_review": _clean_review(db, entry, user, info.today)
                               if not plan.due else None})
        elif plan.due:
            posting.append({
                "entry_id": entry.id,
                "name": entry.name,
                "account_name": account_name(entry),
                "due_count": len(plan.due),
                "postable_count": len(plan.postable),
                "due_today_count": sum(
                    1 for occ in plan.due
                    if effective(forced.get(entry.id), occ.date()) == info.today),
                "oldest": plan.due[0].date().isoformat(),
                "state": info.state,
                "block_reason": info.block_reason,
                "can_post": info.can_edit,
                "can_review": info.can_edit,
            })
    review.sort(key=lambda row: (row["name"], row["entry_id"]))
    posting.sort(key=lambda row: (row["oldest"], row["name"], row["entry_id"]))
    return {"installment_review": review, "installment_auto_post": posting}


def _listed_entries(db: Session, user, redactor: Redactor, tag_id: Optional[int],
                    criteria: Sequence = ()) -> List[BudgetEntry]:
    """The recurring entries a list of the caller's may show, in id order: the
    payables' disclosure (``collect_events``' ``disclosed()`` in
    services/forecast.py, without a household view; keep the two in step),
    active, with an account, readable and not Limited. A Limited view hides
    ``is_active``, so listing only active entries would reveal it. With
    ``tag_id`` only entries carrying it effectively are kept, and ``criteria``
    narrow the query further."""
    user_id = user.id
    access = redactor.access
    scope_account_ids = {a.id for a in fc.get_account_balances(db, user_id)}
    direct_ids = viewable_account_ids(db, user_id)
    grants = list(access.grants.values())
    query = db.query(BudgetEntry).filter(
        readable_criterion(BudgetEntry, user_id, direct_ids, grants),
        or_(BudgetEntry.user_id == user_id, touches_accounts(BudgetEntry, scope_account_ids)),
        BudgetEntry.is_active.is_(True),
        BudgetEntry.account_id.isnot(None),
        *criteria,
    )
    if tag_id is not None:
        query = query.filter(effective_tag_criterion(BudgetEntry, tag_id))
    entries = query.order_by(BudgetEntry.id).all()
    # Everything the filter below reads, in bulk rather than per entry: the
    # accounts (with their shares and tags) and, for a Household tag share,
    # which entries carry the sharer's tag explicitly.
    access.load(i for e in entries for i in record_account_ids(e))
    access.load_explicit(entries)
    return [e for e in entries if access.readable(e) and redactor.view(e) != LIMITED]


def autopay_due(db: Session, user, *, redactor: Redactor) -> List[dict]:
    """The snapshot's ``autopay_due`` key: one row per autopay cash entry the
    caller can edit, in a view not Limited, with an occurrence due through
    Manila's today, planned for the caller by ``post_plan``, sorted by ``oldest``
    then name. ``due_count`` and ``postable_count`` are the plan's, ``oldest``
    the first due occurrence's effective date, ``state`` its ``installment_state``
    and ``block_reason`` ``posting.blocker_reason`` (``insufficient_funds``,
    ``possible_duplicate`` and the rest), ``account_name`` the account a notice
    names. A held row stays until it posts. Card installments stay in
    ``installment_auto_post``. Not filtered by tag, as that list is not.
    """
    access = redactor.access
    entries = _listed_entries(db, user, redactor, None,
                              (BudgetEntry.auto_post_enabled.is_(True),))
    access.load(e.account_id for e in entries)
    entries = [e for e in entries
               if not is_card_installment(e, access.account(e.account_id))
               and auto_posts(e, access.account(e.account_id))
               and access.permissions(e)["can_edit"]]
    if not entries:
        return []
    today = manila_today()
    held = held_occurrences(db, entries, today)
    forced = load_entry_overrides(db, [e.id for e in entries])
    out = []
    for entry in entries:
        plan = post_plan(db, entry, user, today, held, access)
        if not plan.due:
            continue
        account = access.account(entry.account_id)
        out.append({
            "source": "budget_entry",
            "source_id": entry.id,
            "name": entry.name,
            "account_name": account.name if redactor.can_view(account.id) else None,
            "due_count": len(plan.due),
            "postable_count": len(plan.postable),
            "oldest": effective(forced.get(entry.id), plan.due[0].date()).isoformat(),
            "state": installment_state(entry, plan),
            "block_reason": posting_svc.blocker_reason(plan.blocker),
        })
    out.sort(key=lambda row: (row["oldest"], row["name"], row["source_id"]))
    return out


def recurring_missed(db: Session, user, *, redactor: Redactor, tag_id: Optional[int],
                     infos: Optional[Dict[int, InstallmentInfo]] = None) -> List[dict]:
    """The snapshot's ``missed`` key (see the module docstring), sorted by
    ``oldest_effective``, then name.

    ``count`` is the occurrences before today that no posted row records, from
    the entry's ``next_occurrence`` (``unrecorded_occurrences``, each calendar
    day once, capped entries at their cap, read on the effective date), with
    ``oldest`` the first: its nominal date, which Mark paid sends back, and
    ``oldest_effective`` the date to show. A pending
    linked row records nothing yet; ``split_pending_links`` adds the occurrences
    without one. With ``tag_id`` only entries carrying it effectively are kept,
    as the payables are. A card installment's row also carries ``auto_post`` (its
    ``installment_state``), ``block_reason`` and ``can_review`` (the caller can
    edit and ``auto_post_block`` is None, the rule that admits an entry to
    ``installment_review``), which no other row has; ``infos`` is ``installment_infos`` when the caller has it.
    """
    user_id = user.id
    access = redactor.access
    entries = _listed_entries(db, user, redactor, tag_id)
    if not entries:
        return []

    # Wallets as the projection judges them (``collect_events``): the scoped
    # ones plus any viewable account an entry is funded from.
    accounts = fc.get_account_balances(db, user_id)
    viewable_ids = viewable_account_ids(db, user_id, roles=VIEW_ROLES)
    wallet_ids = {a.id for a in accounts if fc.is_spending_wallet(a)} | fc.wallet_ids_of(
        db, (e.account_id for e in entries if e.account_id in viewable_ids))
    access.load(e.account_id for e in entries)
    entries = [e for e in entries
               if not _card_missed_covers(e, access.account(e.account_id))
               and not (e.transfer_to_account_id is None and e.account_id in wallet_ids)]

    if infos is None:
        infos = installment_infos(db, user, redactor=redactor)
    today = manila_today()
    unrecorded = fc.unrecorded_occurrences(db, entries, through=today - timedelta(days=1))
    links = split_pending_links(db, entries, unrecorded, redactor)
    forced = load_entry_overrides(db, [e.id for e in entries])
    out = []
    for entry in entries:
        missed = unrecorded.get(entry.id, [])
        if not missed:
            continue
        account = access.account(entry.account_id)
        info = infos.get(entry.id)
        out.append({
            "view": redactor.view(entry),
            "entry_id": entry.id,
            "name": entry.name,
            "entry_type": entry.entry_type.value,
            "kind": entry_kind(entry, account),
            "plan_kind": plan_kind(entry, account),
            "is_transfer": entry.transfer_to_account_id is not None,
            "capped": is_capped(entry),
            "account_name": account.name if account is not None
            and redactor.can_view(account.id) else None,
            "count": len(missed),
            "oldest": missed[0].date().isoformat(),
            "oldest_effective": effective(forced.get(entry.id), missed[0].date()).isoformat(),
            **links[entry.id],
            "can_mark_paid": bool(access.permissions(entry)["can_post"]),
            **({"auto_post": info.state, "block_reason": info.block_reason,
                "can_review": info.can_edit and auto_post_block(entry, account) is None}
               if info is not None else {}),
        })
    out.sort(key=lambda row: (row["oldest_effective"], row["name"]))
    return out


@dataclass(frozen=True)
class UpcomingFilters:
    """The Transactions page's filters, as ``GET /transactions`` names them,
    read for recurring entries (``upcoming_occurrences``). ``account_ids`` are
    already cut to the accounts the caller can view; ``transaction_types`` are
    parsed; ``tag_id`` is ``filter_tag_id``'s."""
    account_ids: Optional[FrozenSet[int]] = None
    transaction_types: Optional[FrozenSet[TransactionType]] = None
    category_names: Optional[FrozenSet[str]] = None
    uncategorized: bool = False
    entered_by_me: bool = False
    search: Optional[str] = None
    tag_id: Optional[int] = None


def _type_criterion(types: FrozenSet[TransactionType]):
    """What each transaction type means for an entry: ``debit`` an expense that
    is not a transfer, ``credit`` income, ``transfer`` a transfer."""
    matches = []
    if TransactionType.DEBIT in types:
        matches.append(and_(BudgetEntry.entry_type == BudgetEntryType.EXPENSE,
                            BudgetEntry.transfer_to_account_id.is_(None)))
    if TransactionType.CREDIT in types:
        matches.append(BudgetEntry.entry_type == BudgetEntryType.INCOME)
    if TransactionType.TRANSFER in types:
        matches.append(BudgetEntry.transfer_to_account_id.isnot(None))
    return or_(*matches)


def upcoming_window(start: Optional[date], end: Optional[date]) -> tuple:
    """``(first day, last day)`` of an upcoming list: from Manila's tomorrow at
    the earliest (today and earlier are Due and overdue's) through Manila's
    today plus ``OCCURRENCE_HORIZON`` at the latest; an open end is that
    horizon. The first day may be after the last: an empty list."""
    today = manila_today()
    first = today + timedelta(days=1)
    last = today + OCCURRENCE_HORIZON
    return (max(start, first) if start is not None else first,
            min(end, last) if end is not None else last)


def upcoming_occurrences(db: Session, user, *, redactor: Redactor, start: Optional[date],
                         end: Optional[date], filters: UpcomingFilters, limit: int,
                         plan: Optional[str] = None) -> dict:
    """``{"items", "total"}``: every occurrence from ``start`` through ``end``
    (inclusive, clamped by ``upcoming_window``) of the entries
    ``_listed_entries`` gives, narrowed by ``filters``, that no linked row
    stands for, posted or pending (``unrecorded_occurrences`` with
    ``pending_records``): such a row is listed itself. Card subscriptions and
    bills and wallet spending are kept, as the Transactions page lists their
    rows. The window, the filter and the sort read ``effective_date``, the
    forced date or the occurrence's own; ``occurrence_date`` stays nominal.
    Sorted by day, name and entry id; ``total`` counts before ``limit``.

    The walk runs from each entry's ``next_occurrence``, not from ``start``: a
    capped entry's cap and the matching of linked rows both count from there,
    so a long-stale entry walks its unrecorded history first (as the missed
    list does on every snapshot).

    ``recordable`` is whether Mark paid can record the occurrence now: the
    caller's ``can_post``, the schedule's first occurrence on a capped entry
    (``posting.resolve_occurrence`` refuses any later month), and not a card
    installment whose auto-post is ``on`` (it records itself on its day). It is
    the only place that gate lives: the page derives its buttons from it.

    ``plan`` (STU-511) keeps only the entries whose ``plan_kind`` matches
    (``subscription``, or ``none`` for null) before the sort and ``limit``, so
    ``items`` and ``total`` are exact for one Transactions card tab; installments
    match neither. None keeps every entry."""
    first, last = upcoming_window(start, end)
    if first > last:
        return {"items": [], "total": 0}
    criteria = []
    if filters.account_ids is not None:
        criteria.append(touches_accounts(BudgetEntry, filters.account_ids))
    if filters.transaction_types:
        criteria.append(_type_criterion(filters.transaction_types))
    if filters.entered_by_me:
        criteria.append(BudgetEntry.user_id == user.id)
    if filters.search:
        criteria.append(BudgetEntry.name.ilike(f"%{filters.search}%"))
    entries = _listed_entries(db, user, redactor, filters.tag_id, criteria)
    if filters.category_names or filters.uncategorized:
        # As the transaction list matches them: the category its creator owns
        # and keeps active (``Redactor.category_name``), ORed with having none
        # on an entry that is not a transfer.
        names = filters.category_names or frozenset()
        entries = [e for e in entries if redactor.category_name(e) in names
                   or (filters.uncategorized and e.transfer_to_account_id is None
                       and redactor.category_name(e) is None)]
    if not entries:
        return {"items": [], "total": 0}

    access = redactor.access
    access.load(acc for e in entries for acc in (e.account_id, e.transfer_to_account_id))
    if plan is not None:
        wanted = None if plan == "none" else plan
        entries = [e for e in entries if plan_kind(e, access.account(e.account_id)) == wanted]
        if not entries:
            return {"items": [], "total": 0}
    # Only card installments have an auto-post state: a list without one (a
    # ``plan`` partition never has one) skips the per-installment plans.
    infos = (installment_infos(db, user, redactor=redactor)
             if any(is_card_installment(e, access.account(e.account_id)) for e in entries)
             else {})
    unrecorded = fc.unrecorded_occurrences(db, entries, through=last, pending_records=True)
    forced = load_entry_overrides(db, [e.id for e in entries])

    def account_name(account_id: Optional[int]) -> Optional[str]:
        account = access.account(account_id) if account_id is not None else None
        return account.name if account is not None and redactor.can_view(account.id) else None

    items = []
    for entry in entries:
        moved = forced.get(entry.id)
        days = [(occ.date(), effective(moved, occ.date()))
                for occ in unrecorded.get(entry.id, [])
                if effective(moved, occ.date()) >= first]
        if not days:
            continue
        account = access.account(entry.account_id)
        info = infos.get(entry.id)
        capped = is_capped(entry)
        can_mark_paid = bool(access.permissions(entry)["can_post"])
        first_day = first_occurrence(entry).date() if capped else None
        auto_post = info.state if info is not None else None
        shared = {
            "view": redactor.view(entry),
            "entry_id": entry.id,
            "name": entry.name,
            "entry_type": entry.entry_type.value,
            "is_transfer": entry.transfer_to_account_id is not None,
            "kind": entry_kind(entry, account),
            "plan_kind": plan_kind(entry, account),
            "amount": float(entry.amount),
            "currency": entry.currency.value,
            "account_name": account_name(entry.account_id),
            "transfer_to_account_name": account_name(entry.transfer_to_account_id),
            "capped": capped,
            "can_mark_paid": can_mark_paid,
            "auto_post": auto_post,
            "block_reason": info.block_reason if info is not None else None,
            "can_review": bool(info is not None and info.can_edit
                               and auto_post_block(entry, account) is None),
        }
        for day, when in days:
            items.append({
                **shared,
                "occurrence_date": day,
                "effective_date": when,
                "recordable": (can_mark_paid and (not capped or day == first_day)
                               and auto_post != "on"),
            })
    items.sort(key=lambda row: (row["effective_date"], row["name"], row["entry_id"]))
    return {"items": items[:limit], "total": len(items)}


def installment_plans(db: Session, user, *, redactor: Redactor) -> dict:
    """``{"items", "auto_post_scheduled", "today"}``: one item per active entry
    ``_listed_entries`` gives whose ``plan_kind`` is ``installment``, with
    ``today`` the Manila day the items were computed for.

    ``next_charge`` is the first occurrence no linked row stands for, posted or
    pending (``unrecorded_occurrences`` with ``pending_records``), over the
    whole remaining schedule (``capped_schedule_end``), so a charge years out is
    still found; null only when every remaining month has a row. ``missed``
    counts those whose effective date is before today. ``payments_left`` is
    ``max_occurrences`` and ``payments_total`` adds the paid count
    (``forecast.occurrences_paid``), as Allocations reads "n of m".
    ``can_mark_paid``, ``auto_post``, ``block_reason`` and ``can_review`` are
    ``upcoming_occurrences``'; ``recordable`` is its gate for ``next_charge``:
    the schedule's first occurrence only, never with auto-post on.

    Sorted with an overdue ``next_charge`` first, then by ``next_charge``,
    ``name`` and ``entry_id``; a null ``next_charge`` goes last."""
    today = manila_today()
    access = redactor.access
    entries = _listed_entries(db, user, redactor, None,
                              (BudgetEntry.end_mode == "after_occurrences",))
    access.load(e.account_id for e in entries)
    entries = [e for e in entries if plan_kind(e, access.account(e.account_id)) == "installment"]
    infos = installment_infos(db, user, redactor=redactor) if entries else {}
    paid = fc.occurrences_paid(db, entries)
    # One pass for every plan's linked rows: each walk is still capped at its
    # own ``max_occurrences`` (``capped_distinct_days``), so walking through the
    # latest schedule end lists the same days as walking through its own.
    unrecorded = fc.unrecorded_occurrences(
        db, entries, through=max(fc.capped_schedule_end(e) for e in entries),
        pending_records=True) if entries else {}
    forced = load_entry_overrides(db, [e.id for e in entries])
    items = []
    for entry in entries:
        account = access.account(entry.account_id)
        info = infos.get(entry.id)
        days = unrecorded.get(entry.id, [])
        next_charge = days[0].date() if days else None
        can_mark_paid = bool(access.permissions(entry)["can_post"])
        auto_post = info.state if info is not None else None
        items.append({
            "view": redactor.view(entry),
            "entry_id": entry.id,
            "name": entry.name,
            "account_name": account.name if account is not None
            and redactor.can_view(account.id) else None,
            "amount": float(entry.amount),
            "currency": entry.currency.value,
            "next_charge": next_charge,
            "missed": sum(1 for occ in days
                          if effective(forced.get(entry.id), occ.date()) < today),
            "payments_left": entry.max_occurrences,
            "payments_total": paid[entry.id] + entry.max_occurrences,
            "can_mark_paid": can_mark_paid,
            "auto_post": auto_post,
            "block_reason": info.block_reason if info is not None else None,
            "can_review": bool(info is not None and info.can_edit
                               and auto_post_block(entry, account) is None),
            "recordable": (can_mark_paid and next_charge is not None
                           and next_charge == first_occurrence(entry).date()
                           and auto_post != "on"),
        })
    items.sort(key=lambda row: (row["next_charge"] is None,
                                not (row["next_charge"] is not None
                                     and row["next_charge"] < today),
                                row["next_charge"] or today, row["name"], row["entry_id"]))
    return {"items": items, "auto_post_scheduled": settings.JOB_TOKEN is not None,
            "today": today}


def entry_row_fields(db: Session, rows: Iterable[dict], redactor: Redactor) -> None:
    """Add ``kind`` (``entry_kind``), ``plan_kind`` (``plan_kind``, the
    Transactions card tab), ``settlement`` (``settlement``) and ``can_mark_paid``
    (the entry's ``can_post``, with an account to post to) to each full budget-entry row,
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
            row["kind"], row["plan_kind"], row["settlement"] = None, None, None
            row["can_mark_paid"] = False
            continue
        account = access.account(entry.account_id)
        row["kind"] = entry_kind(entry, account)
        row["plan_kind"] = plan_kind(entry, account)
        row["settlement"] = settlement(entry, account)
        row["can_mark_paid"] = bool(access.permissions(entry)["can_post"]
                                    and entry.account_id is not None)
