from datetime import datetime, timedelta

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import text
from sqlalchemy.orm import Session
from typing import Iterable, List, Optional
from app.core import locking
from app.core.database import get_db
from app.core.auth import get_current_active_user
from app.core.access import (
    OWNER_ROLES, get_account_or_404, get_owned_or_404, owned_criterion, require_owned_ref,
)
from app.models.category import Category
from app.models.allocation import Allocation, AllocationType, BudgetPeriodFrequency
from app.schemas.allocation import (
    MULTI_ACCOUNT, TRANSACTION_TOTAL, AllocationCreate, AllocationResponse, AllocationUpdate, AllocationListResponse,
    AllocationRankedResponse, AllocationRankOrder, BudgetPeriodResponse, account_rule_error, goal_mode,
)
from app.schemas.transaction import BudgetTransactionPage
from app.core.redaction import FULL, serialize_transactions
from app.models.user import CurrencyType, User
from app.core.time import utc_now
from app.routers.transactions import (
    _compute_period_end, _lock_allocations, _recompute_budget_total, _start_of_period,
)
from app.services import allocation_rank
from app.services import budget_periods
from app.services.fx import FxRates, get_fx
from app.services.savings_progress import progress_for

router = APIRouter()

CARRY_NEEDS_A_LIMIT = "carry_over needs a target_amount or a monthly_target"


def _ids(value, detail: str) -> list:
    """Configuration ids as ints; anything else is a 400."""
    try:
        return [int(v) for v in value]
    except (TypeError, ValueError):
        raise HTTPException(status_code=400, detail=detail)


def _validate_configuration(db: Session, user: User, configuration) -> None:
    """Same-owner rule for the ids in an allocation's configuration.

    ``category_ids``, ``account_ids`` and ``savings_category_id`` must all be
    the caller's own (allocations are never shared, so the caller is the owner).
    """
    if not configuration:
        return
    for category_id in _ids(configuration.get("category_ids") or [],
                            "configuration.category_ids must be a list of ids"):
        require_owned_ref(db, Category, category_id, "Category not found", user)
    for account_id in _ids(configuration.get("account_ids") or [],
                           "configuration.account_ids must be a list of ids"):
        get_account_or_404(db, user, account_id, roles=OWNER_ROLES)
    savings = configuration.get("savings_category_id")
    if savings is not None:
        (savings_id,) = _ids([savings], "configuration.savings_category_id must be an id")
        require_owned_ref(db, Category, savings_id, "Category not found", user)

def _with_listed_categories(configuration):
    """The configuration with ``category_ids`` as a list of ids: a string or an object
    the validator accepts (``"7"`` names category 7, as the matcher has always read
    it) is stored as the ids it names (STU-795). Validate first."""
    if isinstance(configuration, dict) and isinstance(configuration.get("category_ids"),
                                                      (str, dict)):
        return {**configuration, "category_ids": _ids(
            configuration["category_ids"], "configuration.category_ids must be a list of ids")}
    return configuration


def _effective_window(start, end, frequency):
    """A budget's current window ``(start, end)``, naive UTC, as a roll will read it
    (``_ensure_budget_period``): no start is the period containing now, with its end
    derived; no end is derived from the start."""
    frequency = frequency or BudgetPeriodFrequency.MONTHLY
    start = budget_periods.naive_utc(start)
    if start is None:
        start = _start_of_period(budget_periods.now(), frequency)
        return start, _compute_period_end(start, frequency)
    return start, budget_periods.naive_utc(end) or _compute_period_end(start, frequency)


WINDOW_FIELDS = ("period_start", "period_end", "period_frequency")
INVERTED_WINDOW = "period_end must be after period_start"


def _first_aggregated_account(allocation_type, configuration) -> Optional[int]:
    """A ``multi_account`` savings allocation's stored account: its first aggregated one."""
    if allocation_type != AllocationType.SAVINGS or goal_mode(configuration) != MULTI_ACCOUNT:
        return None
    (first,) = _ids(configuration["account_ids"][:1],
                    "configuration.account_ids must be a list of ids")
    return first

def _money(value):
    return None if value is None else float(value)


def _responses(db: Session, allocations: Iterable[Allocation], fx: FxRates,
               history: bool = True) -> List[AllocationResponse]:
    """The allocations as responses: savings ones with their calculated progress,
    budgets with their current window (``services.budget_periods``), any elapsed
    budget rolled first in a short transaction of its own (STU-795). A write's
    response passes ``history=False``: the current window's figures without the carry
    chain's replay (its carry figures null while carry is on)."""
    allocations = list(allocations)
    budget_periods.roll_for_read(db, allocations)
    progress = progress_for(db, allocations, fx)
    budgets = budget_periods.snapshots(db, allocations, fx, history=history)
    bodies = []
    for allocation in allocations:
        body = AllocationResponse.model_validate(allocation)
        if allocation.id in progress:
            body = body.model_copy(update=progress[allocation.id].as_fields())
        if allocation.id in budgets:
            fields = budgets[allocation.id].current.current_fields()
            body = body.model_copy(update={
                **fields, **{k: _money(fields[k]) for k in ("current_amount", "carry_in",
                                                            "available")}})
        else:
            body = body.model_copy(update={"carry_over_from": None})
        bodies.append(body)
    return bodies

@router.get("/", response_model=AllocationListResponse)
def get_allocations(
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_active_user),
    account_id: Optional[int] = Query(None, description="Filter by account ID"),
    allocation_type: Optional[str] = Query(None, description="Filter by allocation type"),
    is_active: Optional[bool] = Query(None, description="Filter by active status"),
    ranked: Optional[bool] = Query(None, description="Only ranked goals (true) or only the others (false)"),
    limit: int = Query(10, ge=1, le=1000),
    offset: int = Query(0, ge=0),
    fx: FxRates = Depends(get_fx),
):
    """Get all allocations with optional filtering"""
    # Allocations are never shared: the caller's own only.
    query = db.query(Allocation).filter(owned_criterion(Allocation, current_user))

    if account_id:
        query = query.filter(Allocation.account_id == account_id)
    if allocation_type:
        # Convert string to enum
        try:
            allocation_type_enum = AllocationType(allocation_type.lower())
            query = query.filter(Allocation.allocation_type == allocation_type_enum)
        except ValueError:
            raise HTTPException(status_code=400, detail=f"Invalid allocation type: {allocation_type}")
    if is_active is not None:
        query = query.filter(Allocation.is_active == is_active)
    if ranked is not None:
        # Ranked rows are the ones holding a rank (STU-786); totals and pages follow.
        query = query.filter(Allocation.rank.is_not(None) if ranked else Allocation.rank.is_(None))

    total = query.count()
    allocations = (
        query.order_by(Allocation.created_at.desc(), Allocation.id.desc())
        .offset(offset)
        .limit(limit)
        .all()
    )
    has_more = offset + len(allocations) < total
    return {"items": _responses(db, allocations, fx), "total": total, "has_more": has_more}

@router.get("/ranked", response_model=AllocationRankedResponse)
def get_ranked_allocations(
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_active_user),
    fx: FxRates = Depends(get_fx),
):
    """All of the caller's ranked goals, top first. Never paged (STU-786)."""
    allocations = allocation_rank.ranked_for(db, current_user.id)
    return {"items": _responses(db, allocations, fx)}

@router.put("/ranked", response_model=AllocationRankedResponse)
def reorder_ranked_allocations(
    order: AllocationRankOrder,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_active_user),
    fx: FxRates = Depends(get_fx),
):
    """Set the caller's ranked goals to the given complete order (STU-786)."""
    allocations = allocation_rank.reorder(db, current_user.id, order.ids)
    # Built while the owner lock is held; the commit releases it.
    items = _responses(db, allocations, fx)
    db.commit()
    return {"items": items}

@router.post("/", response_model=AllocationResponse)
def create_allocation(
    allocation: AllocationCreate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_active_user),
    fx: FxRates = Depends(get_fx),
):
    """Create a new allocation"""
    # Allocations are never shared: the caller is the owner (STU-222).
    locking.lock_owner_budgets(db, current_user.id)
    _validate_configuration(db, current_user, allocation.configuration)
    allocation_data = allocation.dict()
    allocation_data["configuration"] = _with_listed_categories(allocation_data["configuration"])
    is_budget = allocation.allocation_type == AllocationType.BUDGET
    if is_budget:
        start, end = _effective_window(allocation.period_start, allocation.period_end,
                                       allocation.period_frequency)
        if end <= start:
            raise HTTPException(status_code=422, detail=INVERTED_WINDOW)
    carry_over = bool(allocation_data.pop("carry_over", None)) and is_budget
    if carry_over and allocation.target_amount is None and allocation.monthly_target is None:
        raise HTTPException(status_code=422, detail=CARRY_NEEDS_A_LIMIT)
    first = _first_aggregated_account(allocation.allocation_type, allocation.configuration)
    if first is not None:
        allocation_data["account_id"] = first
    if allocation.allocation_type == AllocationType.SAVINGS:
        # A savings figure is calculated on read (STU-777): a sent one is ignored.
        allocation_data["current_amount"] = 0
    # An allocation is the owner's: its account must be the caller's own.
    account = None
    if allocation_data["account_id"] is not None:
        account = get_account_or_404(db, current_user, allocation_data["account_id"],
                                     roles=OWNER_ROLES)
    if allocation_data["currency"] is None:
        # Unsent: a savings allocation tracking its account(s) takes the (first)
        # account's currency, anything else the owner's default currency, or PHP
        # without one (STU-777). The caller is always the owner.
        tracks_account = (allocation.allocation_type == AllocationType.SAVINGS
                          and goal_mode(allocation.configuration) != TRANSACTION_TOTAL)
        allocation_data["currency"] = (account.currency if tracks_account and account
                                       else current_user.default_currency or CurrencyType.PHP)

    db_allocation = Allocation(**allocation_data, user_id=current_user.id)
    db.add(db_allocation)
    db.flush()
    allocation_rank.sync_membership(db, db_allocation, was_ranked=False)
    if db_allocation.allocation_type == AllocationType.BUDGET:
        # A budget's total is derived from its rows (STU-222): a sent one is ignored.
        _recompute_budget_total(db, db_allocation, [None])
        if carry_over:
            # Carry starts at the current window (STU-795).
            db_allocation.carry_over_from = budget_periods.naive_utc(db_allocation.period_start)
    db.commit()
    db.refresh(db_allocation)
    return _responses(db, [db_allocation], fx, history=False)[0]

@router.get("/{allocation_id}", response_model=AllocationResponse)
def get_allocation(
    allocation_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_active_user),
    fx: FxRates = Depends(get_fx),
):
    """Get a specific allocation by ID"""
    allocation = get_owned_or_404(db, Allocation, allocation_id, current_user, "Allocation not found")
    return _responses(db, [allocation], fx)[0]

@router.put("/{allocation_id}", response_model=AllocationResponse)
def update_allocation(
    allocation_id: int,
    allocation_update: AllocationUpdate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_active_user),
    fx: FxRates = Depends(get_fx),
):
    """Update an existing allocation"""
    # The owner's lock first, then the read (STU-786).
    locking.lock_owner_budgets(db, current_user.id)
    db_allocation = get_owned_or_404(db, Allocation, allocation_id, current_user, "Allocation not found")
    db_allocation = apply_allocation_update(
        db, current_user, db_allocation, allocation_update.dict(exclude_unset=True))
    db.commit()
    db.refresh(db_allocation)
    return _responses(db, [db_allocation], fx, history=False)[0]

def _budget_configuration(stored, sent):
    """A budget's configuration as edited: the stored ``account_ids`` list (an empty
    one included) is kept when the edit sends no configuration (null) or one without
    the key (STU-795), so an older form never widens an envelope to every account;
    also when the edit makes the allocation a budget (a ``multi_account`` savings
    allocation's accounts). A sent list replaces it, and is validated."""
    kept = stored.get("account_ids") if isinstance(stored, dict) else None
    if not isinstance(kept, list):
        return sent
    if sent is None:
        return {"account_ids": kept}
    if isinstance(sent, dict) and "account_ids" not in sent:
        return {**sent, "account_ids": kept}
    return sent


def _code(currency) -> str:
    return getattr(currency, "value", currency) or CurrencyType.PHP.value


def apply_allocation_update(db: Session, user: User, allocation: Allocation,
                            update_data: dict) -> Allocation:
    """Apply an allocation edit, uncommitted, and return the allocation.

    The owner's budget lock is taken first (allocations are never shared, so the
    caller is the owner), then the allocation row, refreshed, so a membership
    change never races a transaction write discovering that owner's budgets
    (STU-222). A budget's total is derived from its rows: a sent one is ignored
    and the total is recomputed.

    A budget first closes its elapsed windows under the settings they ran with
    (STU-795), then the edit is checked and applied: a currency change once a
    window is stored, ``carry_over`` true with no limit left, and a date edit (or a
    change back to budget) whose window, as a roll will read it (a null start is the
    period containing now), ends at or before its start, starts before the newest
    stored window's end, or starts before the window carry-over began in while
    carry stays on, are refused (422) with nothing changed. ``carry_over`` true
    starts carry at the current window (kept when already on), false or no limit
    left clears it, and leaving budget clears it. A date or cadence change clears
    ``period_anchor_day``, so the next roll reads the new window's.
    """
    locking.lock_owner_budgets(db, user.id)
    locked = _lock_allocations(db, [allocation])
    if not locked:
        # Deleted between the caller's ownership check and the lock.
        raise HTTPException(status_code=404, detail="Allocation not found")
    (allocation,) = locked
    was_ranked = allocation_rank.is_ranked(allocation.allocation_type, allocation.is_active)
    was_budget = allocation.allocation_type == AllocationType.BUDGET
    if was_budget:
        budget_periods.roll(db, allocation)
    update_data = dict(update_data)
    carry_over = update_data.pop("carry_over", None)
    if "currency" in update_data and update_data["currency"] is None:
        update_data.pop("currency")  # a null currency is no change, never a null column
    if "is_active" in update_data and update_data["is_active"] is None:
        update_data.pop("is_active")  # a null is_active is no change, never a null column
    is_budget = update_data.get("allocation_type", allocation.allocation_type) == AllocationType.BUDGET
    if is_budget and "configuration" in update_data:
        update_data["configuration"] = _budget_configuration(
            allocation.configuration, update_data["configuration"])
    if {"allocation_type", "configuration", "account_id"} & update_data.keys():
        # The account each mode needs (STU-777), judged on the allocation as edited.
        allocation_type = update_data.get("allocation_type", allocation.allocation_type)
        configuration = update_data.get("configuration", allocation.configuration)
        problem = account_rule_error(allocation_type, configuration,
                                     update_data.get("account_id", allocation.account_id))
        if problem:
            raise HTTPException(status_code=422, detail=problem)
        if "configuration" in update_data:
            _validate_configuration(db, user, configuration)
            configuration = update_data["configuration"] = _with_listed_categories(configuration)
        first = _first_aggregated_account(allocation_type, configuration)
        if first is not None:
            update_data["account_id"] = first
    if "account_id" in update_data and update_data["account_id"] is not None:
        get_account_or_404(db, user, update_data["account_id"], roles=OWNER_ROLES)
    if ("currency" in update_data
            and _code(update_data["currency"]) != _code(allocation.currency)
            and budget_periods.has_stored(db, allocation.id)):
        raise HTTPException(status_code=422, detail=(
            "This budget has closed periods in its currency; start a new envelope to "
            "use another currency"))
    limits = [update_data.get(f, getattr(allocation, f)) for f in ("target_amount", "monthly_target")]
    has_limit = any(v is not None for v in limits)
    if is_budget and carry_over is True and not has_limit:
        raise HTTPException(status_code=422, detail=CARRY_NEEDS_A_LIMIT)
    window_edited = any(
        f in update_data and budget_periods.naive_utc(update_data[f]) != budget_periods.naive_utc(
            getattr(allocation, f)) for f in ("period_start", "period_end")) or (
        "period_frequency" in update_data
        and update_data["period_frequency"] != allocation.period_frequency)
    if is_budget and (not was_budget or set(WINDOW_FIELDS) & update_data.keys()):
        start, end = _effective_window(
            *(update_data[f] if f in update_data else getattr(allocation, f)
              for f in WINDOW_FIELDS))
        if end <= start:
            raise HTTPException(status_code=422, detail=INVERTED_WINDOW)
        newest = budget_periods.newest_stored_end(db, allocation.id)
        if newest is not None and start < newest:
            raise HTTPException(status_code=422, detail=(
                "period_start can't be before the end of the budget's newest closed period "
                f"({newest.isoformat()})"))
        carry_from = budget_periods.naive_utc(allocation.carry_over_from)
        carry_stays = was_budget and carry_over is not False and has_limit
        if carry_stays and carry_from is not None and start < carry_from:
            raise HTTPException(status_code=422, detail=(
                "period_start can't be before the period carry-over started in "
                f"({carry_from.isoformat()}); turn carry_over off first"))
    if update_data.get("allocation_type", allocation.allocation_type) in (
            AllocationType.BUDGET, AllocationType.SAVINGS):
        # Budgets' and savings' figures are derived (STU-222, STU-777): a sent one is ignored.
        update_data.pop("current_amount", None)
    for field, value in update_data.items():
        setattr(allocation, field, value)
    if (not is_budget or carry_over is False or not has_limit
            or (not was_budget and carry_over is not True)):
        allocation.carry_over_from = None
    if window_edited:
        allocation.period_anchor_day = None

    allocation.updated_at = utc_now()
    db.flush()
    allocation_rank.sync_membership(db, allocation, was_ranked)
    if is_budget:
        if not was_budget:
            # Back to budget: its window moves to now, storing none of the windows it
            # spent as another type.
            budget_periods.roll(db, allocation, keep=False)
        _recompute_budget_total(db, allocation, [None])
        if carry_over is True and allocation.carry_over_from is None:
            allocation.carry_over_from = budget_periods.naive_utc(allocation.period_start)
            db.flush()
    return allocation

@router.delete("/{allocation_id}")
def delete_allocation(
    allocation_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_active_user),
):
    """Soft delete an allocation (mark as inactive)"""
    # The owner's lock first, then the read, so the rank gap closes on current ranks (STU-786).
    locking.lock_owner_budgets(db, current_user.id)
    db_allocation = get_owned_or_404(db, Allocation, allocation_id, current_user, "Allocation not found")
    db_allocation.is_active = False
    db_allocation.updated_at = utc_now()
    allocation_rank.clear_and_close_gap(db, db_allocation)
    db.commit()
    return {"message": "Allocation deleted successfully"}

@router.get("/{allocation_id}/progress")
def get_allocation_progress(
    allocation_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_active_user),
    fx: FxRates = Depends(get_fx),
):
    """Get progress details for an allocation"""
    allocation = get_owned_or_404(db, Allocation, allocation_id, current_user, "Allocation not found")
    # A savings allocation's figure is calculated from its mode (STU-777).
    budget_periods.roll_for_read(db, [allocation])
    savings = progress_for(db, [allocation], fx).get(allocation.id)
    budget = budget_periods.snapshots(db, [allocation], fx).get(allocation.id)
    current_amount = (savings.current_amount if savings
                      else budget.current.spent if budget else allocation.current_amount)
    if budget:
        # A budget's figures are its current window's (STU-795): what it has spent, and
        # what remains of its limit and any carry.
        current = budget.current
        remaining = current.remaining if current.remaining is not None else 0
        return {
            "allocation_id": allocation_id,
            "current_amount": current_amount,
            "target_amount": allocation.target_amount,
            "progress_percentage": round(
                (current_amount / allocation.target_amount) * 100, 2)
            if allocation.target_amount and allocation.target_amount > 0 else 0,
            "monthly_target": allocation.monthly_target,
            "monthly_progress": current.spent,
            "remaining_amount": remaining,
            "target_date": allocation.target_date,
            "days_remaining": (allocation.target_date - datetime.now()).days
            if allocation.target_date else None,
        }
    # Calculate progress percentage
    progress_percentage = 0
    if allocation.target_amount and allocation.target_amount > 0:
        progress_percentage = (current_amount / allocation.target_amount) * 100
    
    # Calculate monthly progress
    monthly_progress = 0
    if allocation.monthly_target:
        from app.models.transaction import Transaction, TransactionType
        # The allocation owner's transactions for it in the current month. Another
        # user's row naming it is a stale reference and never counts.
        start_of_month = datetime.now().replace(day=1, hour=0, minute=0, second=0, microsecond=0)
        end_of_month = (start_of_month + timedelta(days=32)).replace(day=1) - timedelta(seconds=1)
        
        transactions = db.query(Transaction).filter(
            Transaction.allocation_id == allocation_id,
            Transaction.user_id == allocation.user_id,
            Transaction.transaction_date >= start_of_month,
            Transaction.transaction_date <= end_of_month,
            Transaction.transaction_type == TransactionType.CREDIT
        ).all()
        
        monthly_progress = sum(t.amount for t in transactions)
    
    body = {
        "allocation_id": allocation_id,
        "current_amount": current_amount,
        "target_amount": allocation.target_amount,
        "progress_percentage": round(progress_percentage, 2),
        "monthly_target": allocation.monthly_target,
        "monthly_progress": monthly_progress,
        "remaining_amount": allocation.target_amount - current_amount if allocation.target_amount else 0,
        "target_date": allocation.target_date,
        "days_remaining": (allocation.target_date - datetime.now()).days if allocation.target_date else None
    }
    if savings:
        body.update(savings.as_fields())
    return body

def _budget_or_404(db: Session, user: User, allocation_id: int) -> Allocation:
    """The caller's own budget; a missing, foreign or non-budget allocation is a 404."""
    allocation = get_owned_or_404(db, Allocation, allocation_id, user, "Allocation not found")
    if allocation.allocation_type != AllocationType.BUDGET:
        raise HTTPException(status_code=404, detail="Allocation not found")
    return allocation


def _budget_snapshot(db: Session, user: User, allocation_id: int, fx: FxRates):
    """The caller's own budget, rolled, and its snapshot (STU-795).

    The roll commits; then one REPEATABLE READ transaction re-reads the budget (an
    edit the roll waited for, a type change included, is seen: no longer a budget
    is a 404) and everything after it, so the figures, the count and the page a
    caller reads all come from one database snapshot.
    """
    budget_periods.roll_for_read(db, [_budget_or_404(db, user, allocation_id)])
    db.commit()  # ends the transaction the lookup ran in
    db.execute(text("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ"))
    allocation = _budget_or_404(db, user, allocation_id)
    return allocation, budget_periods.snapshots(db, [allocation], fx)[allocation.id]


@router.get("/{allocation_id}/periods", response_model=List[BudgetPeriodResponse])
def get_budget_periods(
    allocation_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_active_user),
    fx: FxRates = Depends(get_fx),
):
    """A budget's last 12 windows, newest (the current one) first (STU-795)."""
    _, snapshot = _budget_snapshot(db, current_user, allocation_id, fx)
    return [window.as_dict() for window in snapshot.windows]


@router.get("/{allocation_id}/transactions", response_model=BudgetTransactionPage)
def get_budget_transactions(
    allocation_id: int,
    period_start: Optional[datetime] = Query(
        None, description="The start of one of the windows /periods returns; the current "
                          "window when omitted"),
    limit: int = Query(10, ge=1, le=1000),
    offset: int = Query(0, ge=0),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_active_user),
    fx: FxRates = Depends(get_fx),
):
    """The rows a budget window counts, newest first, as ``GET /transactions`` shows
    them, with the window's per-currency subtotals and converted total (STU-795), all
    read in one snapshot (``_budget_snapshot``)."""
    allocation, snapshot = _budget_snapshot(db, current_user, allocation_id, fx)
    if period_start is None:
        window = snapshot.current
    else:
        window = snapshot.window_at(budget_periods.naive_utc(period_start))
        if window is None:
            raise HTTPException(status_code=422, detail=(
                "period_start must be the start of one of the budget's last 12 periods"))
    query = budget_periods.counted_rows(db, allocation, window)
    total = query.count()
    rows = query.offset(offset).limit(limit).all()
    items = serialize_transactions(db, current_user, rows)
    quote = allocation.currency or CurrencyType.PHP
    for item, row in zip(items, rows):
        if item["view"] == FULL:
            item["missing_rate"] = fx.rate(budget_periods.row_currency(db, row), quote) is None
    return {
        "items": items, "total": total, "has_more": offset + len(rows) < total,
        "currency_subtotals": {code: float(amount)
                               for code, amount in sorted(window.subtotals.items())},
        "converted_total": float(window.spent),
    }


@router.get("/summary/goals")
def get_goals_summary(
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_active_user),
):
    """Get summary of all active goals"""
    goals = (
        db.query(Allocation)
        .filter(
            owned_criterion(Allocation, current_user),
            Allocation.allocation_type == AllocationType.GOAL,
            Allocation.is_active.is_(True),
        )
        .all()
    )
    
    total_target = sum(goal.target_amount or 0 for goal in goals)
    total_current = sum(goal.current_amount for goal in goals)
    total_progress = (total_current / total_target * 100) if total_target > 0 else 0
    
    return {
        "total_goals": len(goals),
        "total_target_amount": total_target,
        "total_current_amount": total_current,
        "total_progress_percentage": round(total_progress, 2),
        "goals": [
            {
                "id": goal.id,
                "name": goal.name,
                "target_amount": goal.target_amount,
                "current_amount": goal.current_amount,
                "progress_percentage": round((goal.current_amount / goal.target_amount * 100) if goal.target_amount else 0, 2),
                "target_date": goal.target_date
            }
            for goal in goals
        ]
    }
