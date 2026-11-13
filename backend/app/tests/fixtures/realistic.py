"""The realistic dataset every performance budget and golden file runs on (STU-596).

``build_realistic`` seeds one owner with two years of history (~3,000 transactions),
10+ accounts including four credit cards, sixteen recurring entries and the awkward
rows the statement engine has to place correctly, then three more callers who see
part of it. Everything is relative to ``today`` and drawn from a seeded generator,
so two builds on the same day produce the same shape.

The four callers (``Realistic.callers``):

``owner``      everything
``editor``     SharedFull: an editor on Card A and on the joint bank
``viewer``     a viewer on the joint bank and on Card D (limited views)
``household``  holds a share of the owner's Household tag, which marks Card B and
               a few records (the read-only household views)

The cards:

``card_a``  closes on the 12th; shared to the editor
``card_b``  closes on the 20th; carries the Household tag
``card_c``  legacy: only ``due_date`` set, no ``billing_cycle_start``
``card_d``  closes on the 31st (clamped in short months); shared to the viewer

Awkward rows: charges posted after the statement closed (``posting_date`` past the
close), a cycle whose refunds exceed its charges, a cash advance with a fee, a
payment into a card in its open cycle, an unposted foreign-currency charge, loan
payments, and due-date overrides on two cards.

Rows are written straight through the ORM (an HTTP call per row would take minutes);
accounts, entries and shares go through the API or the same models the tests use.
Use as the ``realistic`` fixture (module scope), or call ``build_realistic`` and
``Realistic.remove`` from a script (``backend/scripts/perf_bench.py``).

Nothing here may import ``app.tests.conftest``: it vets DATABASE_URL on import, and
the script that reuses this module does that itself.
"""
from __future__ import annotations

import random
import secrets
import sys
import time
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta
from typing import Dict, List, Optional

import pytest

API = "/api/v1"
PASSWORD = "Password123!"
# Fixed so a builder run and the budget tests agree. Matches no real clock; the
# tests pin the app's clock to it, the benchmark builds on the real day instead.
REF = datetime(2026, 11, 13, 2, 0)  # naive UTC; Manila's 10:00 on Friday 13 Nov
SEED = 7
CALLERS = ("owner", "editor", "viewer", "household")
HISTORY_DAYS = 730
BASE_ROWS = 2800  # random rows; the payments, loan rows and special rows come on top


@dataclass
class Caller:
    key: str
    id: int
    email: str
    _client: object = field(repr=False, default=None)
    _token: Optional[str] = field(repr=False, default=None)
    _minted: float = field(repr=False, default=0.0)

    @property
    def headers(self) -> Dict[str, str]:
        """A bearer header; a fresh login once the token is ten minutes old (they last 15)."""
        if self._token is None or time.monotonic() - self._minted > 600:
            r = self._client.post(f"{API}/auth/login",
                                  json={"email": self.email, "password": PASSWORD})
            assert r.status_code == 200, r.text
            self._token, self._minted = r.json()["access_token"], time.monotonic()
        return {"Authorization": f"Bearer {self._token}"}


@dataclass
class Realistic:
    today: date
    callers: Dict[str, Caller]
    accounts: Dict[str, int]
    # The card each caller reads the statements/credit endpoints of.
    statement_card: Dict[str, int]
    entries: List[int]
    transaction_count: int
    build_seconds: float

    def to_state(self) -> dict:
        return {"today": self.today.isoformat(), "accounts": self.accounts,
                "statement_card": self.statement_card, "entries": self.entries,
                "transaction_count": self.transaction_count,
                "build_seconds": self.build_seconds,
                "callers": {k: {"id": c.id, "email": c.email} for k, c in self.callers.items()}}

    @classmethod
    def from_state(cls, state: dict, client) -> "Realistic":
        return cls(
            today=date.fromisoformat(state["today"]), accounts=state["accounts"],
            statement_card=state["statement_card"], entries=state["entries"],
            transaction_count=state["transaction_count"],
            build_seconds=state["build_seconds"],
            callers={k: Caller(k, v["id"], v["email"], client)
                     for k, v in state["callers"].items()})

    def remove(self, db) -> None:
        """Delete everything the build made (the users last)."""
        from app.models.account import Account
        from app.models.allocation import Allocation
        from app.models.budget_entry import BudgetEntry
        from app.models.category import Category
        from app.models.tag import Tag
        from app.models.transaction import Transaction
        from app.models.user import User
        from app.models.wishlist_item import WishlistItem

        users = [c.id for c in self.callers.values()]
        db.rollback()
        owned = [a for (a,) in db.query(Account.id).filter(Account.user_id.in_(users))]
        db.query(Transaction).filter(Transaction.user_id.in_(users)).delete(
            synchronize_session=False)
        if owned:
            from app.core.access import touches_accounts
            db.query(Transaction).filter(touches_accounts(Transaction, owned)).delete(
                synchronize_session=False)
        for model in (BudgetEntry, WishlistItem, Allocation, Category):
            db.query(model).filter(model.user_id.in_(users)).delete(synchronize_session=False)
        db.query(Account).filter(Account.user_id.in_(users)).update(
            {"payment_account_id": None, "payment_overflow_account_id": None,
             "shares_limit_with_account_id": None}, synchronize_session=False)
        db.commit()
        db.query(Account).filter(Account.user_id.in_(users)).delete(synchronize_session=False)
        db.query(Tag).filter(Tag.user_id.in_(users)).delete(synchronize_session=False)
        db.query(User).filter(User.id.in_(users)).delete(synchronize_session=False)
        db.commit()


def _post(client, headers, path, body):
    r = client.post(f"{API}{path}", json=body, headers=headers)
    assert r.status_code in (200, 201), (path, r.status_code, r.text[:400])
    return r.json()


def _at(day: date, hour: int = 0, minute: int = 0) -> datetime:
    return datetime(day.year, day.month, day.day, hour, minute)


def build_realistic(client, db, today: date, tag: str = "perf") -> Realistic:
    """Seed the dataset into the application's database and return its handles.

    ``client`` is a TestClient (or httpx client) on the app, ``db`` a session on the
    same database. ``tag`` goes into the users' emails.
    """
    from app.core.auth import get_password_hash
    from app.core.tags import ensure_household_tag
    from app.models.account import Account
    from app.models.account_share import AccountShare
    from app.models.card_statement_due_override import CardStatementDueOverride
    from app.models.category import Category, CategoryKind
    from app.models.tag import transaction_tags
    from app.models.tag_share import TagShare
    from app.models.transaction import Transaction, TransactionType
    from app.models.user import CurrencyType, User
    from app.services.statements import statement_close

    t0 = time.perf_counter()
    rng = random.Random(SEED)
    run = secrets.token_hex(4)
    pw_hash = get_password_hash(PASSWORD)

    # --- users -------------------------------------------------------------------------
    callers: Dict[str, Caller] = {}
    for key in CALLERS:
        user = User(email=f"{tag}-{key}-{run}@example.com", password_hash=pw_hash,
                    first_name=key.capitalize(), last_name="Perf", is_verified=True)
        db.add(user)
        db.commit()
        db.refresh(user)
        callers[key] = Caller(key, user.id, user.email, client)
    owner = callers["owner"]
    h = owner.headers
    household_tag = ensure_household_tag(db, owner.id).id
    db.commit()

    # --- accounts (through the API: the real validation and defaults) -------------------
    def acct(name, kind, balance=0, **extra):
        return _post(client, h, "/accounts/", {
            "name": name, "account_type": kind, "balance": balance, **extra})["id"]

    acc: Dict[str, int] = {}
    acc["bank0"] = acct("Joint bank", "checking", 150_000)
    acc["bank1"] = acct("Salary bank", "checking", 90_000)
    acc["bank2"] = acct("Bills bank", "checking", 40_000)
    acc["savings0"] = acct("Emergency fund", "savings", 300_000)
    acc["savings1"] = acct("Travel fund", "savings", 80_000)
    acc["cash"] = acct("Cash", "cash", 5_000)
    acc["wallet"] = acct("E-wallet", "checking", 2_500, is_spending_wallet=True)
    acc["card_a"] = acct("Card A", "credit", 0, billing_cycle_start=12, days_until_due_date=21,
                         credit_limit=150_000, payment_account_id=acc["bank0"])
    acc["card_b"] = acct("Card B", "credit", 0, billing_cycle_start=20, days_until_due_date=25,
                         credit_limit=100_000, payment_account_id=acc["bank1"],
                         tag_ids=[household_tag])
    acc["card_c"] = acct("Card C", "credit", 0, due_date=5, days_until_due_date=21,
                         credit_limit=60_000, payment_account_id=acc["bank1"])
    acc["card_d"] = acct("Card D", "credit", 0, billing_cycle_start=31, days_until_due_date=21,
                         credit_limit=80_000, payment_account_id=acc["bank0"])
    first_loan_payment = today.replace(day=20) - timedelta(days=30 * 23)
    acc["loan"] = acct("Car loan", "loan", -420_000, loan_kind="auto", loan_amortization="fixed",
                       loan_annual_rate=9, loan_term_months=60, loan_payment_amount=12_000,
                       loan_first_payment_date=first_loan_payment.isoformat(),
                       payment_account_id=acc["bank0"])

    for account, user, role in (
        ("card_a", "editor", "editor"), ("bank0", "editor", "editor"),
        ("bank0", "viewer", "viewer"), ("card_d", "viewer", "viewer"),
    ):
        db.add(AccountShare(account_id=acc[account], user_id=callers[user].id, role=role,
                            created_by=owner.id))
    db.add(TagShare(tag_id=household_tag, user_id=callers["household"].id))
    db.commit()

    cards = [acc[k] for k in ("card_a", "card_b", "card_c", "card_d")]
    banks = [acc[k] for k in ("bank0", "bank1", "bank2")]

    # --- categories ---------------------------------------------------------------------
    cat_ids: List[int] = []
    for name in ("Groceries", "Dining", "Transport", "Utilities", "Shopping", "Health",
                 "Travel", "Subscriptions"):
        c = Category(user_id=owner.id, name=name, kind=CategoryKind.EXPENSE, is_expense=True)
        db.add(c)
        db.flush()
        cat_ids.append(c.id)
    income_cat = Category(user_id=owner.id, name="Salary", kind=CategoryKind.INCOME,
                          is_expense=False)
    db.add(income_cat)
    db.commit()

    # --- recurring entries: bills, installments, a salary --------------------------------
    entries: List[int] = []
    for i in range(10):
        entries.append(_post(client, h, "/budget-entries/", {
            "name": f"Bill {i}", "entry_type": "expense", "amount": 1_000 + i * 150,
            "cadence": "monthly",
            "next_occurrence": f"{(today + timedelta(days=i * 3 - 8)).isoformat()}T00:00:00",
            "account_id": (banks + cards)[i % 7],
            **({"tag_ids": [household_tag]} if i == 2 else {})})["id"])
    entries.append(_post(client, h, "/budget-entries/", {
        "name": "Salary", "entry_type": "income", "amount": 65_000, "cadence": "semi_monthly",
        "next_occurrence": f"{(today + timedelta(days=2)).isoformat()}T00:00:00",
        "account_id": acc["bank1"]})["id"])
    for i in range(6):
        entries.append(_post(client, h, "/budget-entries/", {
            "name": f"Installment {i}", "entry_type": "expense", "amount": 2_500 + i * 400,
            "cadence": "monthly",
            "next_occurrence": f"{(today + timedelta(days=i * 4 - 6)).isoformat()}T00:00:00",
            "account_id": cards[i % 4], "end_mode": "after_occurrences",
            "max_occurrences": 12})["id"])

    # --- transactions (direct rows) -------------------------------------------------------
    uid = owner.id
    rows: List[Transaction] = []

    def row(account, kind, amount, when, desc, posted=True, **kw):
        t = Transaction(user_id=uid, created_by_actor=uid, account_id=account, amount=amount,
                        transaction_type=kind, description=desc, is_posted=posted,
                        transaction_date=when, transfer_fee=kw.pop("fee", 0), **kw)
        rows.append(t)
        return t

    def transfer(src, dst, amount, when, desc, posted=True, **kw):
        return row(src, TransactionType.TRANSFER, amount, when, desc, posted,
                   transfer_from_account_id=src, transfer_to_account_id=dst, **kw)

    start = today - timedelta(days=HISTORY_DAYS)
    spend_accounts = cards * 3 + banks * 2 + [acc["savings0"], acc["cash"], acc["wallet"]]
    for k in range(BASE_ROWS):
        day = start + timedelta(days=rng.randrange(HISTORY_DAYS))
        when = _at(day, rng.randrange(24), rng.randrange(60))
        posted = rng.random() > 0.05
        if not posted and rng.random() < 0.5:
            when = _at(today + timedelta(days=rng.randrange(1, 31)), 9)
        kind = rng.choices([TransactionType.DEBIT, TransactionType.CREDIT,
                            TransactionType.TRANSFER], [80, 12, 8])[0]
        a = rng.choice(spend_accounts)
        if kind == TransactionType.TRANSFER:
            b = rng.choice([x for x in banks + [acc["savings0"], acc["savings1"]] if x != a])
            transfer(a, b, rng.randrange(500, 8_000), when, f"Move {k}", posted)
        else:
            row(a, kind, rng.randrange(50, 5_000), when, f"Txn {k}", posted,
                category_id=rng.choice(cat_ids),
                budget_entry_id=rng.choice(entries) if rng.random() < 0.1 else None)

    # A card payment from a bank each month, two years back (nothing outstanding to pay
    # twice: each is consumed by the oldest open statement).
    for m in range(1, 24):
        pay_day = today - timedelta(days=30 * m - 3)
        for card, bank in zip(cards, (banks[0], banks[1], banks[1], banks[0])):
            transfer(bank, card, rng.randrange(6_000, 14_000), _at(pay_day, 11),
                     "Card payment")
    # Loan payments: principal as the amount, interest as the fee.
    for m in range(23):
        transfer(acc["bank0"], acc["loan"], 9_800, _at(first_loan_payment + timedelta(days=30 * m), 8),
                 "Loan payment", fee=2_200, loan_payment_kind="scheduled")

    # Posted late: the charge's own day is in a statement, the bank posted it after the close.
    for card_key in ("card_a", "card_b", "card_d"):
        card = db.get(Account, acc[card_key])
        for back in (1, 2, 3, 5, 8):
            close = statement_close(card, today - timedelta(days=30 * back))
            row(card.id, TransactionType.DEBIT, rng.randrange(800, 4_000),
                _at(close - timedelta(days=1), 16), f"Posted late {card_key} {back}",
                posting_date=_at(close + timedelta(days=2), 9),
                category_id=rng.choice(cat_ids))

    # Refunds that exceed the charges: a credit cycle on card C, past and open.
    card_c = db.get(Account, acc["card_c"])
    for back in (1, 0):
        close = statement_close(card_c, today - timedelta(days=30 * back + 2))
        row(card_c.id, TransactionType.DEBIT, 1_500, _at(close - timedelta(days=6), 12),
            "Small purchase")
        # More than every debit on the card in the 32 days to the close (a cycle is shorter),
        # so the statement is a credit whatever else was drawn (30,000 covers the projected
        # entries the engine adds to the open cycle).
        charges = sum(t.amount for t in rows if t.account_id == card_c.id
                      and t.transaction_type == TransactionType.DEBIT
                      and _at(close - timedelta(days=32)) <= t.transaction_date <= _at(close, 23))
        row(card_c.id, TransactionType.CREDIT, charges + 30_000, _at(close - timedelta(days=4), 12),
            "Refund above the charges", category_id=rng.choice(cat_ids))

    # A cash advance with a fee (settled and planned), a payment into a card in its
    # open cycle (nothing billed yet), and an unposted foreign-currency charge.
    transfer(acc["card_b"], acc["bank1"], 10_000, _at(today - timedelta(days=40), 10),
             "Cash advance", fee=300)
    transfer(acc["card_b"], acc["bank1"], 5_000, _at(today + timedelta(days=6), 10),
             "Cash advance planned", posted=False, fee=150)
    transfer(acc["bank0"], acc["card_d"], 4_000, _at(today - timedelta(days=2), 10),
             "Payment in the open cycle")
    row(acc["card_a"], TransactionType.DEBIT, 1_160, _at(today + timedelta(days=3), 9),
        "Foreign charge", False, currency=CurrencyType.PHP, projected_amount=20,
        projected_currency=CurrencyType.USD, category_id=cat_ids[6])

    db.add_all(rows)
    db.flush()
    # A few household-tagged rows, so the household member sees records as well as accounts.
    tagged = [t.id for t in rows if t.account_id == acc["card_b"]
              and t.transaction_type == TransactionType.DEBIT][:25]
    if tagged:
        db.execute(transaction_tags.insert(),
                   [{"tag_id": household_tag, "transaction_id": i} for i in tagged])

    # Due-date overrides: the dates the bank printed, on two cards.
    for card_key, back in (("card_a", 1), ("card_a", 2), ("card_c", 1)):
        card = db.get(Account, acc[card_key])
        close = statement_close(card, today - timedelta(days=30 * back))
        db.add(CardStatementDueOverride(account_id=card.id, statement_close=close,
                                        due_date=close + timedelta(days=24),
                                        created_by_actor=owner.id))
    db.commit()

    return Realistic(
        today=today, callers=callers, accounts=acc,
        statement_card={"owner": acc["card_a"], "editor": acc["card_a"],
                        "viewer": acc["card_d"], "household": acc["card_b"]},
        entries=entries, transaction_count=len(rows), build_seconds=time.perf_counter() - t0)


# --- the pytest fixture ---------------------------------------------------------------------

def pin_clock(monkeypatch, when: datetime) -> None:
    """Freeze ``naive_utc_now`` in every loaded app module (Manila's today included).

    Token expiry reads ``utc_now`` and is not touched, so logins stay valid.
    """
    for name, module in list(sys.modules.items()):
        if name.startswith("app.") and hasattr(module, "naive_utc_now"):
            monkeypatch.setattr(module, "naive_utc_now", lambda: when)


@pytest.fixture(scope="module")
def realistic(sw_client):
    """The realistic dataset, built once per module with the clock pinned to ``REF``.

    The clock stays pinned for the module, so a budget or golden-file test sees the
    same ``today`` as the build. Removed afterwards.
    """
    from app.core.database import SessionLocal

    patch = pytest.MonkeyPatch()
    pin_clock(patch, REF)
    db = SessionLocal()
    world = None
    try:
        world = build_realistic(sw_client, db, REF.date(), tag="fx")
        yield world
    finally:
        patch.undo()
        if world is not None:
            world.remove(db)
        else:
            db.rollback()
        db.close()
