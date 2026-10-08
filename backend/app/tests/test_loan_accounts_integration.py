"""Loan accounts (personal, auto, home): payments, prepayments and the schedule.

A loan's balance is negative while money is owed (owed = -balance). A payment is
one TRANSFER from a funding account to the loan: ``amount`` is principal and
``transfer_fee`` is interest, so the existing transfer arithmetic moves both
balances. ``loan_payment_kind`` tells scheduled payments from prepayments.

Everything goes through the HTTP layer, on throwaway users. Skips without a
database.
"""
import os
import secrets
from decimal import Decimal

import pytest
from sqlalchemy import create_engine, text


def _db_reachable() -> bool:
    url = os.getenv("DATABASE_URL", "")
    if not url:
        return False
    try:
        with create_engine(url).connect() as c:
            c.execute(text("SELECT 1"))
        return True
    except Exception:
        return False


pytestmark = pytest.mark.skipif(not _db_reachable(), reason="no database available")

API = "/api/v1"
PASSWORD = "Password123!"


@pytest.fixture(scope="module")
def client():
    from fastapi.testclient import TestClient
    from app.main import app

    with TestClient(app) as c:
        yield c


@pytest.fixture
def db(client):
    from app.core.database import SessionLocal

    session = SessionLocal()
    try:
        yield session
    finally:
        session.close()


@pytest.fixture
def people(client, db):
    """Factory for throwaway users (with auth headers); everything they made is removed."""
    from app.core.auth import get_password_hash
    from app.models.account import Account
    from app.models.budget_entry import BudgetEntry
    from app.models.entity import Entity, EntityMembership
    from app.models.transaction import Transaction
    from app.models.user import User

    users, entities = [], []

    def make():
        email = f"loan-{secrets.token_hex(6)}@example.com"
        u = User(email=email, password_hash=get_password_hash(PASSWORD),
                 first_name="Loan", last_name="Probe", is_verified=True)
        db.add(u)
        db.commit()
        db.refresh(u)
        users.append(u.id)
        r = client.post(f"{API}/auth/login", json={"email": email, "password": PASSWORD})
        assert r.status_code == 200, r.text
        return {"id": u.id, "headers": {"Authorization": f"Bearer {r.json()['access_token']}"}}

    def entity(*members):
        from app.models.entity import EntityType, MemberRole

        e = Entity(name=f"Loan Biz {secrets.token_hex(3)}", entity_type=EntityType.BUSINESS)
        db.add(e)
        db.commit()
        db.refresh(e)
        entities.append(e.id)
        for i, m in enumerate(members):
            db.add(EntityMembership(entity_id=e.id, user_id=m["id"],
                                    role=MemberRole.OWNER if i == 0 else MemberRole.MEMBER))
        db.commit()
        return e.id

    make.entity = entity
    yield make

    db.rollback()
    db.query(Transaction).filter(Transaction.user_id.in_(users)).delete(synchronize_session=False)
    db.query(BudgetEntry).filter(BudgetEntry.user_id.in_(users)).delete(synchronize_session=False)
    db.query(Account).filter(Account.user_id.in_(users)).update(
        {"payment_account_id": None, "payment_overflow_account_id": None},
        synchronize_session=False)
    db.commit()
    db.query(Account).filter(Account.user_id.in_(users)).delete(synchronize_session=False)
    db.query(EntityMembership).filter(EntityMembership.entity_id.in_(entities)).delete(
        synchronize_session=False)
    db.query(Entity).filter(Entity.id.in_(entities)).delete(synchronize_session=False)
    db.query(User).filter(User.id.in_(users)).delete(synchronize_session=False)
    db.commit()


def _account(client, who, **payload):
    body = {"name": "Probe Bank", "account_type": "savings", "balance": 0}
    body.update(payload)
    return client.post(f"{API}/accounts/", json=body, headers=who["headers"])


def _bank(client, who, balance=500_000, **kw):
    r = _account(client, who, balance=balance, **kw)
    assert r.status_code == 200, r.text
    return r.json()


def _loan(client, who, **payload):
    body = {"name": "Probe Car Loan", "account_type": "loan", "loan_kind": "auto",
            "balance": -1_000_000, "loan_annual_rate": 10, "loan_term_months": 60,
            "loan_payment_amount": 28_239, "loan_first_payment_date": "2026-03-04"}
    body.update(payload)
    r = _account(client, who, **body)
    assert r.status_code == 200, r.text
    return r.json()


def _balance(client, who, account_id):
    r = client.get(f"{API}/accounts/{account_id}", headers=who["headers"])
    assert r.status_code == 200, r.text
    return Decimal(str(r.json()["balance"]))


def _pay(client, who, loan_id, **payload):
    return client.post(f"{API}/accounts/{loan_id}/loan-payment", json=payload,
                       headers=who["headers"])


def _prepay(client, who, loan_id, **payload):
    return client.post(f"{API}/accounts/{loan_id}/loan-prepayment", json=payload,
                       headers=who["headers"])


def _schedule(client, who, loan_id):
    return client.get(f"{API}/accounts/{loan_id}/loan-schedule", headers=who["headers"])


def _summary(client, who, start="2026-10-01T00:00:00", end="2026-10-31T23:59:59"):
    r = client.get(f"{API}/transactions/summary/period",
                   params={"start_date": start, "end_date": end}, headers=who["headers"])
    assert r.status_code == 200, r.text
    return r.json()


def _assert_rows_sum(summary):
    rows = summary["category_breakdown"]
    total = sum((Decimal(str(r["expenses"])) for r in rows.values()), Decimal("0"))
    assert total == Decimal(str(summary["summary"]["total_expenses"]))


# --- account shape -----------------------------------------------------------

def test_loan_accounts_default_amortization_by_kind(client, people):
    me = people()
    assert _loan(client, me, loan_kind="home")["loan_amortization"] == "reduce_term"
    assert _loan(client, me, loan_kind="auto")["loan_amortization"] == "fixed"
    assert _loan(client, me, loan_kind="personal")["loan_amortization"] == "fixed"
    assert _loan(client, me, loan_kind="home",
                 loan_amortization="fixed")["loan_amortization"] == "fixed"

    r = _account(client, me, name="No kind", account_type="loan", balance=-1)
    assert r.status_code == 400 and "loan_kind" in r.text
    r = _account(client, me, name="Bank", loan_kind="auto")
    assert r.status_code == 400
    r = _account(client, me, name="Loan wallet", account_type="loan", loan_kind="auto",
                 is_spending_wallet=True)
    assert r.status_code == 400
    r = _account(client, me, account_type="loan", loan_kind="boat")
    assert r.status_code == 422


# --- schedule ----------------------------------------------------------------

def test_fixed_loan_counts_payments_left_from_the_term(client, people):
    """Cutover: payment #8 of 60 recorded, 7 earlier ones carried as an offset."""
    me = people()
    bank = _bank(client, me)
    loan = _loan(client, me, balance=-1_018_809.05, loan_payments_made_offset=7,
                 payment_account_id=bank["id"])

    before = _schedule(client, me, loan["id"]).json()
    assert before["payments_made"] == 7
    assert before["payments_left"] == 53
    assert before["next_due_date"] == "2026-10-04"

    r = _pay(client, me, loan["id"], principal=28_239 - 8_000, interest=8_000,
             transaction_date="2026-10-04T00:00:00")
    assert r.status_code == 200, r.text

    s = _schedule(client, me, loan["id"])
    assert s.status_code == 200, s.text
    s = s.json()
    assert s["payments_made"] == 8
    assert s["payments_left"] == 52
    assert s["next_due_date"] == "2026-11-04"
    assert len(s["upcoming"]) == 52
    assert s["upcoming"][0]["due_date"] == "2026-11-04"
    assert s["upcoming"][-1]["due_date"] == "2031-02-04"
    # Fixed loans take each split from the bank, so upcoming rows carry none.
    assert s["upcoming"][0]["payment"] == 28_239
    assert s["upcoming"][0]["principal"] is None and s["upcoming"][0]["interest"] is None


def test_schedule_is_built_from_the_banks_balance_and_split(client, people):
    me = people()
    bank = _bank(client, me)
    loan = _loan(client, me, loan_kind="home", balance=-1_000_000, loan_annual_rate=6,
                 loan_payment_amount=28_239, payment_account_id=bank["id"])

    r = _pay(client, me, loan["id"], principal=20_000, interest=8_239,
             transaction_date="2026-10-04T00:00:00")
    assert r.status_code == 200, r.text

    s = _schedule(client, me, loan["id"]).json()
    assert Decimal(str(s["owed"])) == Decimal("980000.00")
    paid = s["payments"][-1]
    assert (paid["principal"], paid["interest"], paid["kind"]) == (20_000, 8_239, "scheduled")
    # reduce_term preview: amortised from the bank's stated balance at the loan rate.
    first = s["upcoming"][0]
    assert first["interest"] == 4_900.0  # 980,000 * 6% / 12
    assert first["principal"] == 28_239 - 4_900
    assert s["proposed_split"] == {"principal": 23_339.0, "interest": 4_900.0}
    assert sum(Decimal(str(row["principal"])) for row in s["upcoming"]) == Decimal("980000.00")
    assert s["payments_left"] == len(s["upcoming"])


def test_payment_proposes_a_split_the_banks_figures_override(client, people):
    me = people()
    bank = _bank(client, me)
    loan = _loan(client, me, balance=-100_000, loan_annual_rate=12, loan_payment_amount=5_000,
                 payment_account_id=bank["id"])

    # No figures: interest = owed * 12% / 12 = 1,000; principal = 5,000 - 1,000.
    proposed = _pay(client, me, loan["id"], transaction_date="2026-10-04T00:00:00").json()
    assert (proposed["amount"], proposed["transfer_fee"]) == (4_000, 1_000)

    # The bank's figures win.
    bank_split = _pay(client, me, loan["id"], principal=4_100, interest=900,
                      transaction_date="2026-11-04T00:00:00").json()
    assert (bank_split["amount"], bank_split["transfer_fee"]) == (4_100, 900)

    # One figure plus the total: the other is the difference.
    partial = _pay(client, me, loan["id"], amount=5_000, interest=850,
                   transaction_date="2026-12-04T00:00:00").json()
    assert (partial["amount"], partial["transfer_fee"]) == (4_150, 850)

    assert _balance(client, me, loan["id"]) == Decimal("-87750.00")
    assert _balance(client, me, bank["id"]) == Decimal("485000.00")

    r = _pay(client, me, loan["id"], principal=200_000, interest=0)
    assert r.status_code == 400  # more principal than is owed


def test_reduce_term_prepayment_shortens_the_term(client, people):
    me = people()
    bank = _bank(client, me)
    loan = _loan(client, me, loan_kind="home", balance=-100_000, loan_annual_rate=6,
                 loan_payment_amount=2_000, loan_first_payment_date="2026-11-04",
                 payment_account_id=bank["id"])

    before = _schedule(client, me, loan["id"]).json()
    r = _prepay(client, me, loan["id"], amount=20_000, transaction_date="2026-10-20T00:00:00")
    assert r.status_code == 200, r.text
    assert r.json()["loan_payment_kind"] == "prepayment"
    assert r.json()["transfer_fee"] == 0
    after = _schedule(client, me, loan["id"]).json()

    assert Decimal(str(after["owed"])) == Decimal("80000.00")
    assert after["payments_left"] < before["payments_left"]
    assert after["upcoming"][-1]["due_date"] < before["upcoming"][-1]["due_date"]
    # A prepayment is not a scheduled payment: the next due date does not move.
    assert after["payments_made"] == before["payments_made"] == 0
    assert after["next_due_date"] == before["next_due_date"] == "2026-11-04"


def test_prepayment_on_a_fixed_loan_is_rejected(client, people):
    me = people()
    bank = _bank(client, me)
    loan = _loan(client, me, payment_account_id=bank["id"])

    r = _prepay(client, me, loan["id"], amount=10_000)
    assert r.status_code == 400 and "fixed" in r.text
    assert _balance(client, me, loan["id"]) == Decimal("-1000000.00")
    assert _balance(client, me, bank["id"]) == Decimal("500000.00")


def test_payment_kind_is_set_by_each_endpoint_and_persisted(client, people, db):
    from app.models.transaction import Transaction

    me = people()
    bank = _bank(client, me)
    loan = _loan(client, me, loan_kind="home", payment_account_id=bank["id"])

    paid = _pay(client, me, loan["id"], principal=20_000, interest=8_000).json()
    extra = _prepay(client, me, loan["id"], amount=5_000).json()
    assert paid["loan_payment_kind"] == "scheduled"
    assert extra["loan_payment_kind"] == "prepayment"

    for txn, kind in ((paid, "scheduled"), (extra, "prepayment")):
        got = client.get(f"{API}/transactions/{txn['id']}", headers=me["headers"]).json()
        assert got["loan_payment_kind"] == kind
        assert got["transaction_type"] == "transfer"
        assert (got["transfer_from_account_id"], got["transfer_to_account_id"]) == (
            bank["id"], loan["id"])
        row = db.query(Transaction).filter(Transaction.id == txn["id"]).one()
        assert row.loan_payment_kind == kind

    # The generic transactions API cannot set it.
    r = client.post(f"{API}/transactions/", headers=me["headers"], json={
        "account_id": bank["id"], "transaction_type": "transfer", "amount": 10,
        "transfer_from_account_id": bank["id"], "transfer_to_account_id": loan["id"],
        "transaction_date": "2026-10-05T00:00:00", "loan_payment_kind": "scheduled",
    })
    assert r.status_code == 200 and r.json()["loan_payment_kind"] is None


# --- invariants: balances and the period summary ------------------------------

def test_interest_is_reported_per_loan_and_the_invariant_holds_after_edit_and_delete(
        client, people):
    me = people()
    bank = _bank(client, me, balance=100_000)
    loan = _loan(client, me, name="BDO Auto", balance=-500_000,
                 payment_account_id=bank["id"])

    paid = _pay(client, me, loan["id"], principal=20_000, interest=8_239,
                transaction_date="2026-10-04T00:00:00").json()
    assert _balance(client, me, bank["id"]) == Decimal("71761.00")
    assert _balance(client, me, loan["id"]) == Decimal("-480000.00")

    s = _summary(client, me)
    rows = s["category_breakdown"]
    assert Decimal(str(rows["Interest: BDO Auto"]["expenses"])) == Decimal("8239")
    assert "Transfer fees" not in rows
    assert Decimal(str(s["summary"]["total_expenses"])) == Decimal("8239")
    _assert_rows_sum(s)

    r = client.put(f"{API}/transactions/{paid['id']}", headers=me["headers"],
                   json={"amount": 21_000, "transfer_fee": 7_239})
    assert r.status_code == 200, r.text
    assert r.json()["loan_payment_kind"] == "scheduled"
    assert _balance(client, me, bank["id"]) == Decimal("71761.00")
    assert _balance(client, me, loan["id"]) == Decimal("-479000.00")
    s = _summary(client, me)
    assert Decimal(str(s["category_breakdown"]["Interest: BDO Auto"]["expenses"])) == Decimal(
        "7239")
    _assert_rows_sum(s)

    r = client.delete(f"{API}/transactions/{paid['id']}", headers=me["headers"])
    assert r.status_code == 200, r.text
    assert _balance(client, me, bank["id"]) == Decimal("100000.00")
    assert _balance(client, me, loan["id"]) == Decimal("-500000.00")
    s = _summary(client, me)
    assert "Interest: BDO Auto" not in s["category_breakdown"]
    assert Decimal(str(s["summary"]["total_expenses"])) == 0
    _assert_rows_sum(s)


# --- routing -----------------------------------------------------------------

@pytest.mark.parametrize("field", ["payment_account_id", "payment_overflow_account_id"])
def test_card_routing_rejects_a_loan(client, people, field):
    me = people()
    loan = _loan(client, me)
    bank = _bank(client, me)
    card = {"name": "Probe CC", "account_type": "credit", "billing_cycle_start": 24,
            "days_until_due_date": 21}

    r = _account(client, me, **card, **{field: loan["id"]})
    assert r.status_code == 400 and "loan" in r.text

    ok = _account(client, me, **card, **{field: bank["id"]})
    assert ok.status_code == 200, ok.text
    r = client.put(f"{API}/accounts/{ok.json()['id']}", json={field: loan["id"]},
                   headers=me["headers"])
    assert r.status_code == 400 and "loan" in r.text


def test_a_loan_cannot_be_paid_from_another_loan_a_card_or_a_wallet(client, people):
    me = people()
    other = _loan(client, me, name="Other loan")
    card = _account(client, me, name="CC", account_type="credit").json()
    wallet = _account(client, me, name="GCash", account_type="e_wallet",
                      is_spending_wallet=True).json()

    for funding in (other, card, wallet):
        r = _account(client, me, name="L", account_type="loan", loan_kind="auto", balance=-1,
                     payment_account_id=funding["id"])
        assert r.status_code == 400, (funding["name"], r.text)

    loan = _loan(client, me)
    for funding in (other, card, wallet):
        r = _pay(client, me, loan["id"], from_account_id=funding["id"],
                 principal=100, interest=0)
        assert r.status_code == 400, (funding["name"], r.text)
    r = _pay(client, me, loan["id"], principal=100, interest=0)
    assert r.status_code == 400 and "funding account" in r.text  # none routed or given


def test_budget_entries_cannot_draw_on_a_loan(client, people):
    me = people()
    loan = _loan(client, me)
    bank = _bank(client, me)
    entry = {"name": "Probe bill", "entry_type": "expense", "amount": 100,
             "next_occurrence": "2026-11-04T00:00:00"}

    for payload in ({"account_id": bank["id"], "overflow_account_id": loan["id"]},
                    {"account_id": loan["id"]}):
        r = client.post(f"{API}/budget-entries/", json={**entry, **payload},
                        headers=me["headers"])
        assert r.status_code == 400 and "loan" in r.text, r.text

    ok = client.post(f"{API}/budget-entries/", json={**entry, "account_id": bank["id"]},
                     headers=me["headers"])
    assert ok.status_code == 201, ok.text
    for payload in ({"overflow_account_id": loan["id"]}, {"account_id": loan["id"]}):
        r = client.put(f"{API}/budget-entries/{ok.json()['id']}", json=payload,
                       headers=me["headers"])
        assert r.status_code == 400 and "loan" in r.text, r.text

    # A recurring transfer INTO a loan is fine (it pays the loan).
    r = client.post(f"{API}/budget-entries/", headers=me["headers"], json={
        **entry, "account_id": bank["id"], "transfer_to_account_id": loan["id"]})
    assert r.status_code == 201, r.text


def test_a_funding_account_cannot_become_a_loan(client, people):
    me = people()
    bank = _bank(client, me)
    card = _account(client, me, name="CC", account_type="credit",
                    payment_account_id=bank["id"])
    assert card.status_code == 200, card.text
    r = client.put(f"{API}/accounts/{bank['id']}", headers=me["headers"],
                   json={"account_type": "loan", "loan_kind": "auto"})
    assert r.status_code == 400


# --- access ------------------------------------------------------------------

def test_another_users_loan_cannot_be_paid_or_read(client, people):
    owner, stranger = people(), people()
    bank = _bank(client, owner)
    loan = _loan(client, owner, loan_kind="home", payment_account_id=bank["id"])
    stranger_bank = _bank(client, stranger)

    assert _schedule(client, stranger, loan["id"]).status_code == 404
    assert _pay(client, stranger, loan["id"], from_account_id=stranger_bank["id"],
                principal=100, interest=0).status_code == 404
    assert _prepay(client, stranger, loan["id"], from_account_id=stranger_bank["id"],
                   amount=100).status_code == 404
    assert _balance(client, owner, loan["id"]) == Decimal("-1000000.00")


def test_an_inaccessible_funding_account_is_rejected(client, people):
    owner, stranger = people(), people()
    stranger_bank = _bank(client, stranger)
    loan = _loan(client, owner, loan_kind="home")

    r = _pay(client, owner, loan["id"], from_account_id=stranger_bank["id"],
             principal=100, interest=0)
    assert r.status_code == 404
    r = _prepay(client, owner, loan["id"], from_account_id=stranger_bank["id"], amount=100)
    assert r.status_code == 404
    assert _balance(client, stranger, stranger_bank["id"]) == Decimal("500000.00")

    r = _account(client, owner, name="L", account_type="loan", loan_kind="auto", balance=-1,
                 payment_account_id=stranger_bank["id"])
    assert r.status_code == 404
    r = client.put(f"{API}/accounts/{loan['id']}", headers=owner["headers"],
                   json={"payment_account_id": stranger_bank["id"]})
    assert r.status_code == 404


def test_entity_membership_governs_loan_access(client, people):
    owner, member, outsider = people(), people(), people()
    entity_id = people.entity(owner, member)
    in_entity = {"X-Entity-Id": str(entity_id)}

    bank = _bank(client, owner, entity_id=entity_id)
    loan = _loan(client, owner, entity_id=entity_id, loan_kind="home",
                 payment_account_id=bank["id"])
    member_h = {**member, "headers": {**member["headers"], **in_entity}}

    # A co-member may read the schedule and pay from the entity's bank.
    assert _schedule(client, member_h, loan["id"]).status_code == 200
    r = _pay(client, member_h, loan["id"], principal=100, interest=10)
    assert r.status_code == 200, r.text
    r = _prepay(client, member_h, loan["id"], amount=50)
    assert r.status_code == 200, r.text

    # A non-member may not, with or without the entity header.
    for headers in (outsider["headers"], {**outsider["headers"], **in_entity}):
        who = {**outsider, "headers": headers}
        assert _schedule(client, who, loan["id"]).status_code in (403, 404)
        assert _pay(client, who, loan["id"], principal=100, interest=0).status_code in (403, 404)
        assert _prepay(client, who, loan["id"], amount=50).status_code in (403, 404)
    assert _balance(client, owner, loan["id"]) == Decimal("-999850.00")
