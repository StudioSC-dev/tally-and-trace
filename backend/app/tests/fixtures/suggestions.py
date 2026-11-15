"""The description-suggestions latency fixture (STU-626, AC6).

``build_suggestions`` seeds one caller who sees 10,000 transactions in full (their
own, on their own two accounts, some tagged and categorised) and 10,000 more limited
(an owner's rows on a bank shared to the caller as a viewer), drawn from a seeded
generator over a fixed pool of descriptions, so two builds produce the same rows.
``measure_latency`` times ``GET /transactions/description-suggestions`` for that
caller over a fixed list of prefixes: 10 warm-up requests, then ``REQUESTS`` timed
ones, reported as the median and p95 wall time and the SQL statements per request.

Shared by ``test_transaction_description_autofill.py`` and
``backend/scripts/perf_bench.py --scenario suggestions``. Nothing here may import
``app.tests.conftest`` (see ``realistic.py``).
"""
from __future__ import annotations

import random
import secrets
import statistics
import time
from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Dict, List

API = "/api/v1"
PASSWORD = "Password123!"
SEED = 626
VISIBLE_ROWS = 10_000
LIMITED_ROWS = 10_000
WARMUP = 10
REQUESTS = 100
P95_LIMIT_MS = 250
START = datetime(2024, 11, 1, 9, 0)

MERCHANTS = ("Shopwise", "SM Supermarket", "Starbucks", "Shell", "Meralco", "Maynilad",
             "Mercury Drug", "Jollibee", "Grab", "Globe", "Netflix", "National Book Store",
             "Puregold", "Petron", "PLDT", "Rustan's", "Robinsons", "Watsons", "7-Eleven",
             "Angkas")
# The prefixes the requests cycle through: one and two letters (many matches), whole
# words and a miss.
PREFIXES = ("s", "sh", "m", "me", "Starbucks", "g", "p", "pe", "r", "w", "n", "7", "a",
            "Shopwise 1", "zzz")


@dataclass
class SuggestionsWorld:
    caller_id: int
    caller_email: str
    owner_id: int
    accounts: Dict[str, int]
    build_seconds: float

    def headers(self, client) -> Dict[str, str]:
        r = client.post(f"{API}/auth/login",
                        json={"email": self.caller_email, "password": PASSWORD})
        assert r.status_code == 200, r.text
        return {"Authorization": f"Bearer {r.json()['access_token']}"}

    def to_state(self) -> dict:
        return {"caller_id": self.caller_id, "caller_email": self.caller_email,
                "owner_id": self.owner_id, "accounts": self.accounts,
                "build_seconds": self.build_seconds}

    @classmethod
    def from_state(cls, state: dict) -> "SuggestionsWorld":
        return cls(**state)

    def remove(self, db) -> None:
        from app.models.account import Account
        from app.models.account_share import AccountShare
        from app.models.category import Category
        from app.models.tag import Tag
        from app.models.transaction import Transaction
        from app.models.user import User

        users = [self.caller_id, self.owner_id]
        db.rollback()
        db.query(Transaction).filter(Transaction.user_id.in_(users)).delete(
            synchronize_session=False)
        db.query(AccountShare).filter(AccountShare.user_id.in_(users)).delete(
            synchronize_session=False)
        db.query(Category).filter(Category.user_id.in_(users)).delete(synchronize_session=False)
        db.query(Account).filter(Account.user_id.in_(users)).delete(synchronize_session=False)
        db.query(Tag).filter(Tag.user_id.in_(users)).delete(synchronize_session=False)
        db.query(User).filter(User.id.in_(users)).delete(synchronize_session=False)
        db.commit()


def build_suggestions(db, tag: str = "sugg") -> SuggestionsWorld:
    """Seed the fixture (module docstring) straight through the database."""
    from sqlalchemy import insert

    from app.core.auth import get_password_hash
    from app.models.account import Account, AccountType
    from app.models.account_share import AccountShare
    from app.models.category import Category, CategoryKind
    from app.models.tag import Tag, transaction_tags
    from app.models.transaction import Transaction, TransactionType
    from app.models.user import User

    t0 = time.perf_counter()
    rng = random.Random(SEED)
    run = secrets.token_hex(4)
    pw_hash = get_password_hash(PASSWORD)
    people = {}
    for key in ("caller", "owner"):
        user = User(email=f"{tag}-{key}-{run}@example.com", password_hash=pw_hash,
                    first_name=key.capitalize(), last_name="Sugg", is_verified=True)
        db.add(user)
        db.flush()
        people[key] = user
    caller, owner = people["caller"], people["owner"]

    def account(user, name, kind=AccountType.CHECKING):
        a = Account(user_id=user.id, name=name, account_type=kind, balance=0, currency="PHP")
        db.add(a)
        db.flush()
        return a.id

    acc = {"own_bank": account(caller, "Own bank"), "own_cash": account(caller, "Own cash",
                                                                         AccountType.CASH),
           "shared_bank": account(owner, "Owner bank")}
    db.add(AccountShare(account_id=acc["shared_bank"], user_id=caller.id, role="viewer",
                        created_by=owner.id))
    categories = []
    for name in ("Groceries", "Dining", "Utilities", "Transport", "Shopping"):
        c = Category(user_id=caller.id, name=name, kind=CategoryKind.EXPENSE, is_expense=True)
        db.add(c)
        db.flush()
        categories.append(c.id)
    tags = []
    for name in ("Work", "Family", "Trip"):
        t = Tag(user_id=caller.id, name=name)
        db.add(t)
        db.flush()
        tags.append(t.id)

    def rows(user_id, accounts, count, with_refs):
        out = []
        for k in range(count):
            merchant = rng.choice(MERCHANTS)
            out.append({
                "user_id": user_id, "created_by_actor": user_id,
                "account_id": rng.choice(accounts), "amount": rng.randrange(50, 5_000),
                "currency": "PHP", "transaction_type": TransactionType.DEBIT,
                "description": f"{merchant} {rng.randrange(40)}" if k % 3 else merchant,
                "is_posted": True, "transfer_fee": 0,
                "transaction_date": START + timedelta(minutes=k * 53 + rng.randrange(50)),
                "category_id": rng.choice(categories) if with_refs else None,
            })
        return out

    visible = rows(caller.id, [acc["own_bank"], acc["own_cash"]], VISIBLE_ROWS, True)
    limited = rows(owner.id, [acc["shared_bank"]], LIMITED_ROWS, False)
    ids = db.execute(insert(Transaction).returning(Transaction.id), visible).scalars().all()
    db.execute(insert(Transaction), limited)
    links = [{"tag_id": tags[i % len(tags)], "transaction_id": tid}
             for i, tid in enumerate(ids) if i % 4 == 0]
    db.execute(transaction_tags.insert(), links)
    db.commit()
    return SuggestionsWorld(caller.id, caller.email, owner.id, acc,
                            time.perf_counter() - t0)


def _percentile(values: List[float], pct: float) -> float:
    ordered = sorted(values)
    rank = max(0, min(len(ordered) - 1, int(round(pct / 100 * len(ordered) + 0.5)) - 1))
    return ordered[rank]


def measure_latency(client, headers, requests: int = REQUESTS, warmup: int = WARMUP) -> dict:
    """Wall time of ``requests`` suggestion requests after ``warmup`` ones (module
    docstring): ``{"requests", "median_ms", "p95_ms", "max_ms", "statements"}``, the last
    being the most SQL statements any timed request ran."""
    from sqlalchemy import event

    from app.core.database import engine

    url = f"{API}/transactions/description-suggestions"
    for i in range(warmup):
        r = client.get(url, params={"q": PREFIXES[i % len(PREFIXES)]}, headers=headers)
        assert r.status_code == 200, r.text
    walls: List[float] = []
    most = 0
    for i in range(requests):
        count = [0]

        def tick(*_):
            count[0] += 1

        event.listen(engine, "before_cursor_execute", tick)
        try:
            w0 = time.perf_counter()
            r = client.get(url, params={"q": PREFIXES[i % len(PREFIXES)]}, headers=headers)
            walls.append((time.perf_counter() - w0) * 1000)
        finally:
            event.remove(engine, "before_cursor_execute", tick)
        assert r.status_code == 200, r.text
        most = max(most, count[0])
    return {"requests": requests, "median_ms": statistics.median(walls),
            "p95_ms": _percentile(walls, 95), "max_ms": max(walls), "statements": most}


# What every request runs before its own work: the UTC pin of the session's transaction
# (``database.pin_utc``) and the caller's row (auth); plus the request context's one
# ``AccessMap`` read (PERF-3: the access rules every context read shares).
FIXED_SQL = ("SET LOCAL TIME ZONE", "SELECT users.")
ACCESS_MAP_TABLE = "account_shares"


def suggestion_reads(client, who, q):
    """``(reads, seen)``: the SQL statements a suggestions request ran beyond its fixed
    cost (the pin, auth and at most one ``AccessMap`` read), and all of them."""
    from sqlalchemy import event

    from app.core.database import engine

    seen: List[str] = []

    def record(conn, cursor, statement, *_):
        seen.append(statement)

    event.listen(engine, "before_cursor_execute", record)
    try:
        r = client.get(f"{API}/transactions/description-suggestions", params={"q": q},
                       headers=who["headers"])
    finally:
        event.remove(engine, "before_cursor_execute", record)
    assert r.status_code == 200, r.text
    own = [s for s in seen if not s.lstrip().startswith(FIXED_SQL)]
    maps = [s for s in own if ACCESS_MAP_TABLE in s and "FROM transactions" not in s]
    assert len(maps) <= 1, maps
    return [s for s in own if s not in maps], seen
