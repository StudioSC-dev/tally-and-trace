"""Check 8: the Sheet account's month ends against the app, per currency.

For the named account A in currency c, with approved differences a(m) and
D(M) = the sum of a(m) for m <= M, and L the month of ``as_of``:

- a month ending on or before T closes at B(A, first of the next month);
- month L closes at the projection's period 0 closing for A (period 0 runs from T,
  opening at the stored balance, which the posted-after guard makes B(A, T));
- a later month M closes at period (M - L);
- the opening is B(A, first of ``first_month``) from the ledger; a ``first_month``
  starting after T refuses the block (there is no ledger opening to read).

Closings are read from the ``by_currency`` row whose ``currency`` is c, then its
``by_account`` entry for A; the partition's ``net`` is never used. With
``overflow_policy`` included, the cumulative overflow moves into A less those out
of it are added to the projected closings.
"""

from __future__ import annotations

from datetime import timedelta
from decimal import Decimal
from typing import Dict, List, Optional

from app.cutover_check.schema import add_months, month_of, month_start, months_between


def _cents(value) -> Decimal:
    return Decimal(str(value)).quantize(Decimal("0.01"))


def check_sheet(ctx, block) -> None:
    from app.cutover_check.check import _day, effect_on, ledger_balance, row_ref, touching
    from app.cutover_check.statements import naive
    from app.models.transaction import Transaction
    from app.services.forecast import cashflow_by_currency, is_projection_cash

    s = ctx.frozen.sheet
    if ctx.guard_refusal(block):
        return
    account = ctx.resolve(s.account, block, "sheet account")
    if not account:
        return
    if not is_projection_cash(account):
        block.refused = "the sheet account is not projection cash"
        block.fail("refused: the sheet account must be projection cash, "
                   "not a card, a loan or a spending wallet", account=s.account.label())
        return

    T, L = ctx.T, month_of(ctx.frozen.as_of)
    first = _day(month_start(s.first_month))
    if first > T:
        block.refused = "first_month starts after as_of"
        block.fail("refused: first_month starts after as_of", first_month=s.first_month)
        return
    last = s.months[-1]
    horizon = months_between(L, last) + 1 if last >= L else 0
    periods: List[dict] = []
    if horizon > 0:
        periods = cashflow_by_currency(ctx.db, ctx.owner.id, months=horizon, reference=T,
                                       fx=ctx.fx)["periods"]

    overflow: List[Decimal] = []
    running = Decimal("0")
    for period in periods:
        row = _currency_row(period, s.currency)
        for move in (row or {}).get("overflow_moves", []):
            if move["to_account_id"] == account.id:
                running += _cents(move["amount"])
            if move["from_account_id"] == account.id:
                running -= _cents(move["amount"])
        overflow.append(running)

    def app_close(month: str) -> Optional[Decimal]:
        following = _day(month_start(add_months(month, 1)))
        if following <= T:
            return ledger_balance(ctx.db, account, following)
        k = months_between(L, month)
        row = _currency_row(periods[k], s.currency)
        entry = next((a for a in (row or {}).get("by_account", [])
                      if a["account_id"] == account.id), None)
        if entry is None:
            block.fail("sheet account missing from the projection", month=month,
                       currency=s.currency, account=s.account.label())
            return None
        value = _cents(entry["closing_balance"])
        if s.overflow_policy == "included":
            value += overflow[k]
        return value

    approved: Dict[str, Decimal] = {}
    for diff in s.approved_differences:
        approved[diff.month] = approved.get(diff.month, Decimal("0")) + diff.amount

    app_open = ledger_balance(ctx.db, account, first)
    block.checked += 1
    if app_open - s.opening_offset != s.sheet_opening:
        block.fail("sheet opening differs", month=add_months(s.first_month, -1),
                   expected=s.sheet_opening, actual=app_open - s.opening_offset,
                   difference=app_open - s.opening_offset - s.sheet_opening)

    cumulative = Decimal("0")
    app_prev, sheet_prev = app_open, s.sheet_opening
    for month in s.months:
        close = app_close(month)
        if close is None:
            return
        a = approved.get(month, Decimal("0"))
        cumulative += a
        sheet_close = s.month_end[month]
        block.checked += 1
        got = close - s.opening_offset - cumulative
        if got != sheet_close:
            block.fail("sheet closing differs", month=month, expected=sheet_close, actual=got,
                       difference=got - sheet_close)
        app_net, sheet_net = close - app_prev - a, sheet_close - sheet_prev
        if app_net != sheet_net:
            block.fail("sheet net differs", month=month, expected=sheet_net, actual=app_net,
                       difference=app_net - sheet_net)
        app_prev, sheet_prev = close, sheet_close

    for item in s.dated_items:
        block.checked += 1
        start = _day(item.date)
        # Candidates: the owner's posted rows on A (a transfer by either side).
        rows = ctx.db.query(Transaction).filter(
            Transaction.user_id == ctx.owner.id, touching([account.id]),
            Transaction.is_posted.is_(True), Transaction.transaction_date >= start,
            Transaction.transaction_date < start + timedelta(days=1)).order_by(
            Transaction.transaction_date, Transaction.id).all()
        found = [r for r in rows
                 if naive(r.transaction_date).date() == item.date
                 and effect_on(r, account.id) == item.amount
                 and item.description_contains.lower() in (r.description or "").lower()]
        if not found:
            near = [row_ref(r) for r in rows if naive(r.transaction_date).date() == item.date
                    and effect_on(r, account.id) != 0]
            block.fail("dated item not found as a posted row on the sheet account",
                       date=item.date, amount=item.amount,
                       description_contains=item.description_contains, same_day_rows=near)


def _currency_row(period: dict, currency: str) -> Optional[dict]:
    return next((r for r in period["by_currency"] if r["currency"] == currency), None)
