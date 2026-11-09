"""Quick balances on the dashboard (STU-578).

The section above the Cash-Flow Timeline: up to ``MAX_TILES`` account tiles,
each with its figures in the account's own currency. With no pins the tiles
are the default slots, in this order:

- ``debit``: the caller's busiest ``checking`` or ``savings`` account;
- ``credit``: the busiest ``credit`` card;
- ``e_wallet``: the busiest ``e_wallet``.

Cash and loan accounts are never defaults. A slot with no candidate is left
out (no placeholder).

**Candidates** are the active accounts the caller owns or administers
(``MANAGE_ROLES``), in any currency: the credit gate's scope, so a default
card always has its figures. A share as editor or viewer and a Household
``tag_viewer`` account are never defaults.

**Movement** is the number of posted transaction legs on the account dated in
the last ``MOVEMENT_DAYS`` Manila days (today and the 89 before it), by the
date part of ``transaction_date``. A debit or credit is one leg on its
account; a transfer is a leg on its source (``transfer_from_account_id``,
else ``account_id``) and a leg on its destination. Every posted row counts,
whoever recorded it; the response names the winner, never the count. A count,
not an amount: one large transfer never outweighs daily use, and currencies
need no conversion.

**Tie-breaks**, in order: the caller's main account
(``forecast.main_account_or_none``), the latest leg's ``transaction_date`` in
the window, then the lowest account id. An account with no legs can still win
as the only candidate.

**Figures** (``tiles``): every tile carries ``balance`` (``Account.balance``,
posted only). A credit card the caller manages (``can_see_credit``) carries
``card`` (``card_credit.amount_due``). A card whose group is served credit
(``card_credit.credit_for_cards``: a limit, and the caller manages every card
in the group) carries ``credit``, a subset of ``CardCredit``. No one else gets
either key.
"""
from __future__ import annotations

from datetime import datetime, time, timedelta
from typing import Dict, List, Optional, Sequence, Tuple

from sqlalchemy import case, func, select, union_all
from sqlalchemy.orm import Session

from app.core.access import MANAGE_ROLES, viewable_accounts
from app.core.redaction import Redactor
from app.core.time import manila_today
from app.models.account import Account, AccountType
from app.models.transaction import Transaction, TransactionType
from app.services import card_credit
from app.services import forecast as fc
from app.services.fx import FxRates

MAX_TILES = 6
MOVEMENT_DAYS = 90

# The default slots, in display order, and the account types each takes
# (``ACCOUNT_TYPE_GROUP`` in packages/shared: debit is checking and savings).
SLOTS: Tuple[Tuple[str, Tuple[AccountType, ...]], ...] = (
    ("debit", (AccountType.CHECKING, AccountType.SAVINGS)),
    ("credit", (AccountType.CREDIT,)),
    ("e_wallet", (AccountType.E_WALLET,)),
)

CREDIT_KEYS = ("limit", "available_now", "complete", "shared_with")


def movement(db: Session, account_ids: Sequence[int]
             ) -> Dict[int, Tuple[int, Optional[datetime]]]:
    """``{account id: (legs, latest leg's transaction_date)}`` over the window,
    in one query; an account with no leg is missing."""
    if not account_ids:
        return {}
    today = manila_today()
    start = datetime.combine(today - timedelta(days=MOVEMENT_DAYS - 1), time())
    end = datetime.combine(today + timedelta(days=1), time())
    t = Transaction
    window = (t.is_posted.is_(True), t.transaction_date >= start, t.transaction_date < end)
    source = case(
        (t.transaction_type == TransactionType.TRANSFER,
         func.coalesce(t.transfer_from_account_id, t.account_id)),
        else_=t.account_id,
    )
    legs = union_all(
        select(source.label("account_id"), t.transaction_date.label("day")).where(*window),
        select(t.transfer_to_account_id.label("account_id"), t.transaction_date.label("day"))
        .where(*window, t.transaction_type == TransactionType.TRANSFER,
               t.transfer_to_account_id.isnot(None)),
    ).subquery()
    rows = (db.query(legs.c.account_id, func.count(), func.max(legs.c.day))
            .filter(legs.c.account_id.in_(list(account_ids)))
            .group_by(legs.c.account_id)
            .all())
    return {account_id: (count, fc._naive(latest)) for account_id, count, latest in rows}


def default_slots(db: Session, user) -> List[Tuple[str, Account]]:
    """``[(slot, account)]``: each default slot's winner, in slot order."""
    types = [account_type for _, slot_types in SLOTS for account_type in slot_types]
    candidates = viewable_accounts(db, user, active_only=True, roles=MANAGE_ROLES).filter(
        Account.account_type.in_(types)).all()
    if not candidates:
        return []
    moved = movement(db, [a.id for a in candidates])
    main_id = fc.main_account_or_none(db, user)

    def rank(account: Account):
        legs, latest = moved.get(account.id, (0, None))
        newest = -(latest - datetime.min) if latest is not None else timedelta(0)
        return (-legs, account.id != main_id, newest, account.id)

    out = []
    for slot, slot_types in SLOTS:
        fits = [a for a in candidates if a.account_type in slot_types]
        if fits:
            out.append((slot, min(fits, key=rank)))
    return out


def _amount(value) -> float:
    return round(float(value or 0), 2)


def tiles(db: Session, user, placed: List[Tuple[Optional[str], Account]],
          fx: Optional[FxRates]) -> List[dict]:
    """The tiles of ``placed`` (``[(slot or None, account)]``, in order), with
    each one's figures (the module docstring). Card figures are read once for
    every card."""
    cards = [a for _, a in placed if a.account_type == AccountType.CREDIT]
    managed = [a for a in cards if card_credit.can_see_credit(user, a)]
    due = card_credit.amount_due(db, user, managed, fx)
    credit = (card_credit.credit_for_cards(db, user, [a.id for a in managed], fx=fx,
                                           redactor=Redactor(db, user))
              if managed else {})
    out = []
    for slot, account in placed:
        tile = {
            "account_id": account.id,
            "name": account.name,
            "account_type": account.account_type.value,
            "currency": fc._code(account.currency),
            "balance": _amount(account.balance),
            "slot": slot,
        }
        if account.id in due:
            tile["card"] = due[account.id]
        if account.id in credit:
            tile["credit"] = {key: credit[account.id][key] for key in CREDIT_KEYS}
        out.append(tile)
    return out


def quick_balances(db: Session, user, fx: Optional[FxRates]) -> dict:
    """``QuickBalances``: the default tiles (pins are not stored yet)."""
    placed: List[Tuple[Optional[str], Account]] = list(default_slots(db, user))
    return {"pinned": False, "max_tiles": MAX_TILES, "tiles": tiles(db, user, placed, fx)}
