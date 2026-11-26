"""Posted rows for the wishlist's free-flow tests (STU-789), on the real clock.

Free flow (``services/free_flow.py``) averages the full Manila months from the
month after the caller's earliest row up to last month. ``anchor`` writes a zero
row two months back, so with every other row written last month (``post`` and
``transfer``) the window is last month alone (``sample_months`` 1) and each
figure is last month's total. Rows go straight to the database, as the free-flow
tests write them; the users' cleanup (``sw_people``) removes them.

Nothing here may import ``app.tests.conftest``.
"""
from datetime import date, datetime
from decimal import Decimal
from typing import Optional

from app.core.time import manila_today


def month_day(back: int, day: int = 10) -> datetime:
    """Noon Manila (04:00 UTC, naive) on ``day`` of the month ``back`` months ago."""
    today = manila_today()
    index = today.year * 12 + today.month - 1 - back
    return datetime.combine(date(index // 12, index % 12 + 1, day), datetime.min.time()).replace(
        hour=4)


def account(db, owner_id: int, kind: str = "checking", currency: str = "PHP",
            balance=0, **extra) -> int:
    from app.models.account import Account, AccountType
    from app.models.user import CurrencyType

    a = Account(user_id=owner_id, name=f"{kind} {currency}", account_type=AccountType(kind),
                balance=Decimal(str(balance)), currency=CurrencyType(currency), **extra)
    db.add(a)
    db.commit()
    return a.id


def post(db, user_id: int, account_id: int, kind: str, amount, *, to: Optional[int] = None,
         back: int = 1, currency: Optional[str] = None) -> int:
    """A posted row last month (``back`` months ago), in its account's currency."""
    from app.models.account import Account
    from app.models.transaction import Transaction, TransactionType
    from app.models.user import CurrencyType

    code = (CurrencyType(currency) if currency is not None
            else db.get(Account, account_id).currency)
    t = Transaction(user_id=user_id, account_id=account_id,
                    transaction_type=TransactionType(kind), amount=Decimal(str(amount)),
                    currency=code, transfer_fee=Decimal("0"),
                    transaction_date=month_day(back), is_posted=True, description="row")
    if kind == "transfer":
        t.transfer_from_account_id, t.transfer_to_account_id = account_id, to
    db.add(t)
    db.commit()
    return t.id


def transfer(db, user_id: int, source: int, destination: int, amount, back: int = 1) -> int:
    return post(db, user_id, source, "transfer", amount, to=destination, back=back)


def anchor(db, user_id: int, account_id: int) -> int:
    """A zero row two months back: the window is last month alone."""
    return post(db, user_id, account_id, "debit", 0, back=2)


def flow(db, user_id: int, account_id: int, *, income=0, spending=0, saved=0,
         savings_id: Optional[int] = None) -> None:
    """Last month on one Pool account: ``income`` in, ``spending`` out, and
    ``saved`` moved to ``savings_id``. With no goals, ``net_flow`` is
    ``income - spending`` and ``free_flow`` is ``net_flow - saved``."""
    anchor(db, user_id, account_id)
    if income:
        post(db, user_id, account_id, "credit", income)
    if spending:
        post(db, user_id, account_id, "debit", spending)
    if saved:
        transfer(db, user_id, account_id, savings_id, saved)
