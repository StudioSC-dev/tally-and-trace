"""The cutover load against a real database (STU-202; plan v3, sections 2.2 to 2.4, 2.6).

Runs ``app.cutover_load`` in-process (and ``scripts/cutover_load.py`` as a
subprocess for the bootstrap cases) on the synthetic fixtures in
``data/cutover_load/`` (invented round figures). Every input and output file
lives in pytest's temporary directory, outside the repository.

**Skip gate.** These tests write and reset rows, so they run only against a
local database: the effective ``settings.DATABASE_URL`` must equal the exported
``DATABASE_URL``, the URL must pass the cutover's own URL validation with a
host of ``localhost``, ``127.0.0.1`` or ``::1``, and the server must report a
loopback or private address (a database in a local container reports its
container address, never a loopback one).
"""
import copy
import ipaddress
import json
import os
import stat
import subprocess
import sys
from datetime import date, datetime
from decimal import Decimal

import pytest
from sqlalchemy import create_engine, text
from sqlalchemy.engine import make_url

from app.tests.conftest import API, fx_rates, hh_household

HERE = os.path.dirname(__file__)
DATA = os.path.join(HERE, "data", "cutover_load")
BACKEND = os.path.dirname(os.path.dirname(HERE))
SCRIPT = os.path.join(BACKEND, "scripts", "cutover_load.py")
LOCAL_HOSTS = ("localhost", "127.0.0.1", "::1")
D = Decimal


def _gate():
    url = os.getenv("DATABASE_URL", "")
    if not url:
        return False, "DATABASE_URL is not set", None
    from app.core.config import settings

    if settings.DATABASE_URL != url:
        return False, "the effective settings URL is not the exported DATABASE_URL", None
    from app.cutover_load import bootstrap

    try:
        parsed = make_url(url)
        bootstrap.check_pg_environment()
        bootstrap.validate_url(url, expect_host=parsed.host or "", expect_db=parsed.database or "")
    except Exception as exc:
        return False, f"the URL fails the cutover validation ({type(exc).__name__})", None
    if parsed.host not in LOCAL_HOSTS:
        return False, "the database host is not local", None
    try:
        engine = create_engine(url)
        with engine.connect() as conn:
            address = conn.execute(text("SELECT host(inet_server_addr())")).scalar()
        engine.dispose()
    except Exception:
        return False, "the database is not reachable", None
    if address is None:
        return False, "connected over a Unix socket", None
    ip = ipaddress.ip_address(address)
    if not (ip.is_loopback or ip.is_private):
        return False, "the server address is neither loopback nor private", None
    return True, "", {"url": url, "host": parsed.host, "db": parsed.database, "addr": address}


OK, REASON, TARGET = _gate()
pytestmark = pytest.mark.skipif(not OK, reason=REASON)


# --- Helpers -------------------------------------------------------------------------------

def fixture(name="base") -> dict:
    with open(os.path.join(DATA, f"{name}.json"), encoding="utf-8") as fh:
        return json.load(fh)


def by_key(items, key):
    return next(i for i in items if i["key"] == key)


def card_at_cutover(data) -> dict:
    """``data`` without the card's rows after the cutover, so ``statement_history``
    (which reads every recorded row) shows the statements as they stood then."""
    data["transactions"] = [t for t in data["transactions"]
                            if t["account_key"] != "card" or t["date"] < data["cutover_date"]]
    return data


def write_input(tmp_path, data, who, name="input.json") -> str:
    path = tmp_path / name
    path.write_text(json.dumps({**data, "owner_email": who["email"]}))
    return str(path)


def quiet(_line):
    pass


def load(tmp_path, data, who, *, dry_run=False, addr="observed", tag="run"):
    from app.cutover_load.bootstrap import validate_url
    from app.cutover_load.loader import run_load

    url = validate_url(TARGET["url"], expect_host=TARGET["host"], expect_db=TARGET["db"])
    report, record = tmp_path / f"{tag}-report.json", tmp_path / f"{tag}-record.json"
    run_load(url=url, input_path=write_input(tmp_path, data, who, f"{tag}-input.json"),
             report_path=str(report), run_record_path=None if dry_run else str(record),
             dry_run=dry_run, expect_db=TARGET["db"],
             expect_server_addr=TARGET["addr"] if addr == "observed" else addr, out=quiet)
    return report, record


def reset(record, confirm, *, dry_run=False):
    from app.cutover_load.bootstrap import validate_url
    from app.cutover_load.reset import run_reset

    url = validate_url(TARGET["url"], expect_host=TARGET["host"], expect_db=TARGET["db"])
    return run_reset(url=url, run_record_path=str(record), confirm=confirm, dry_run=dry_run,
                     expect_db=TARGET["db"], expect_server_addr=TARGET["addr"], out=quiet)


def counts(db, owner_id):
    from app.cutover_load.loader import owner_counts

    db.rollback()
    return owner_counts(db, owner_id)


def table_counts(db) -> dict:
    db.rollback()
    tables = [r[0] for r in db.execute(text(
        "SELECT tablename FROM pg_tables WHERE schemaname = 'public' "
        "AND tablename <> 'alembic_version'"))]
    return {t: db.execute(text(f'SELECT count(*) FROM "{t}"')).scalar() for t in tables}


def account(db, who, name):
    from app.models.account import Account

    db.rollback()
    return db.query(Account).filter(Account.user_id == who["id"], Account.name == name).one()


def txn(db, who, description):
    from app.models.transaction import Transaction

    db.rollback()
    return db.query(Transaction).filter(Transaction.user_id == who["id"],
                                        Transaction.description == description).one()


def entry(db, who, name):
    from app.models.budget_entry import BudgetEntry

    db.rollback()
    return db.query(BudgetEntry).filter(BudgetEntry.user_id == who["id"],
                                        BudgetEntry.name == name).one()


def wall(value: datetime) -> datetime:
    """A stored date as the app and the cutover check read it: the timestamptz value
    in the session time zone with the zone dropped (``forecast._naive``)."""
    return value.replace(tzinfo=None) if value.tzinfo else value


def mode_of(path) -> int:
    return stat.S_IMODE(os.stat(path).st_mode)


def edit_record(record, **changes):
    data = json.loads(record.read_text())
    data.update(changes)
    os.chmod(record, 0o600)
    record.write_text(json.dumps(data))


@pytest.fixture
def owner(sw_people, sw_db):
    who = sw_people("Owen", "Cutover")
    who["household"] = hh_household(sw_db, who)
    return who


# --- Test 1: happy path --------------------------------------------------------------------

FINAL = {"Main Bank": D("29800.00"), "Joint Bank": D("25000.00"), "Dollar Bank": D("850.00"),
         "Cash Wallet": D("3000.00"), "Main Card": D("-2210.00"), "Spare Card": D("0.00"),
         "Car Loan": D("-293000.00")}


def test_happy_path_balances_counts_and_run_record(tmp_path, owner, sw_db):
    from app.cutover_load.loader import ledger_balance

    data = fixture()
    report, record = load(tmp_path, data, owner)
    boundary = datetime(2026, 3, 1)
    for a in data["accounts"]:
        acct = account(sw_db, owner, a["name"])
        assert D(str(acct.balance)) == FINAL[a["name"]], a["name"]
        assert ledger_balance(sw_db, acct, boundary) == D(a["balance_at_cutover"]), a["name"]
    found = counts(sw_db, owner["id"])
    assert found == {"accounts": 7, "transactions": 13, "budget_entries": 6, "categories": 4,
                     "allocations": 0, "wishlist_items": 0, "tags": 2, "account_tags": 1,
                     "transaction_tags": 3, "budget_entry_tags": 1, "account_shares": 0,
                     "tag_shares": 0}
    rec = json.loads(record.read_text())
    assert rec["status"] == "complete" and rec["signed_off_at"] is None
    assert rec["owner_id"] == owner["id"] and rec["owner_email"] == owner["email"]
    assert (rec["database"], rec["server_addr"]) == (TARGET["db"], TARGET["addr"])
    assert rec["session_timezone"] == sw_db.execute(text("SHOW TimeZone")).scalar()
    assert rec["row_counts"] == found
    assert len(rec["input_sha256"]) == 64 and rec["alembic_revision"]
    started = datetime.fromisoformat(rec["started_at"])
    finished = datetime.fromisoformat(rec["finished_at"])
    sw_db.rollback()
    newest = sw_db.execute(text(
        "SELECT max(greatest(created_at, coalesce(updated_at, created_at))) FROM transactions "
        "WHERE user_id = :o"), {"o": owner["id"]}).scalar()
    assert started <= newest <= finished  # finished_at is read from the database clock
    assert mode_of(record) == 0o600 and mode_of(report) == 0o600
    assert json.loads(report.read_text())["dry_run"] is False


def test_the_prepared_record_is_written_before_the_commit(tmp_path, owner, monkeypatch):
    """The run record is ``prepared`` until the commit, then ``complete``."""
    from app.cutover_load import loader

    seen = []
    real = loader.create_private

    def spy(path, payload):
        real(path, payload)
        if path.endswith("record.json"):
            seen.append(json.loads(payload)["status"])

    monkeypatch.setattr(loader, "create_private", spy)
    _, record = load(tmp_path, fixture(), owner)
    assert seen == ["prepared"]
    assert json.loads(record.read_text())["status"] == "complete"


# --- Tests 2 and 3: the boundary and a partial payment -------------------------------------

def test_a_row_at_midnight_on_the_cutover_moves_the_stored_balance(tmp_path, owner, sw_db):
    from app.cutover_load.loader import ledger_balance

    load(tmp_path, fixture(), owner)
    rent = txn(sw_db, owner, "Rent March")
    assert wall(rent.transaction_date) == datetime(2026, 3, 1, 0, 0)
    bank = account(sw_db, owner, "Main Bank")
    assert ledger_balance(sw_db, bank, datetime(2026, 3, 1)) == D("50000.00")
    assert ledger_balance(sw_db, bank, datetime(2026, 3, 2)) == D("35000.00")


def test_a_card_line_the_day_before_the_cutover_is_in_the_open_cycle(tmp_path, owner, sw_db):
    from app.core.access import viewable_account_ids
    from app.models.user import User
    from app.services.statements import statement_history

    data = card_at_cutover(fixture())
    data["transactions"].append({"key": "c_feb28", "date": "2026-02-28", "type": "debit",
                                 "account_key": "card", "amount": "10.00", "is_posted": True})
    by_key(data["accounts"], "card")["balance_at_cutover"] = "-130.00"
    by_key(data["accounts"], "card")["card"]["statements_at_cutover"][1]["owed"] = "70.00"
    load(tmp_path, data, owner)
    card = account(sw_db, owner, "Main Card")
    user = sw_db.get(User, owner["id"])
    history = statement_history(sw_db, card, datetime(2026, 2, 28),
                                viewable_account_ids(sw_db, user))
    assert [(h["close"].date(), h["owed"]) for h in history] == [
        (date(2026, 2, 15), D("60.00")), (date(2026, 3, 15), D("70.00"))]


def test_a_partial_payment_leaves_sixty_and_sixty(tmp_path, owner, sw_db):
    from app.core.access import viewable_account_ids
    from app.cutover_load.loader import ledger_balance
    from app.models.user import User
    from app.services.statements import statement_history

    report, _ = load(tmp_path, card_at_cutover(fixture()), owner)
    card = account(sw_db, owner, "Main Card")
    user = sw_db.get(User, owner["id"])
    history = statement_history(sw_db, card, datetime(2026, 2, 28),
                                viewable_account_ids(sw_db, user))
    assert [(h["close"].date(), h["balance"], h["owed"]) for h in history] == [
        (date(2026, 2, 15), D("100.00"), D("60.00")), (date(2026, 3, 15), D("60.00"), D("60.00"))]
    bank = by_key(json.loads(report.read_text())["accounts"], "bank")
    assert D(bank["opening"]) == D("50040.00")  # balance_at_cutover + 40
    assert ledger_balance(sw_db, account(sw_db, owner, "Main Bank"),
                          datetime(2026, 3, 1)) == D("50000.00")


def test_an_unused_card_loads_with_no_statements(tmp_path, owner, sw_db):
    from app.core.access import viewable_account_ids
    from app.models.user import User
    from app.services.statements import statement_history

    report, _ = load(tmp_path, fixture(), owner)
    spare = account(sw_db, owner, "Spare Card")
    assert statement_history(sw_db, spare, datetime(2026, 2, 28),
                             viewable_account_ids(sw_db, sw_db.get(User, owner["id"]))) == []
    assert by_key(json.loads(report.read_text())["cards"], "spare")["statements"] == []


# --- Test 5: loans -------------------------------------------------------------------------

def test_a_loan_with_offset_seven_and_payment_eight(tmp_path, owner, sw_db):
    from app.services.loans import build_schedule

    load(tmp_path, fixture(), owner)
    loan = account(sw_db, owner, "Car Loan")
    schedule = build_schedule(sw_db, loan)
    assert schedule["payments_made"] == 8
    assert schedule["next_due_date"] == date(2026, 4, 20)  # due date number 9
    assert D(str(schedule["owed"])) == D("293000.00")  # opening less the principal
    payment = txn(sw_db, owner, "Car loan payment 8")
    assert (payment.loan_payment_kind, D(str(payment.amount)), D(str(payment.transfer_fee))) == (
        "scheduled", D("7000.00"), D("3000.00"))
    assert loan.payment_account_id == account(sw_db, owner, "Main Bank").id


# --- Test 6: recurring ---------------------------------------------------------------------

def test_recurring_entries_load_with_their_installment_counts(tmp_path, owner, sw_db):
    load(tmp_path, fixture(), owner)
    phone = entry(sw_db, owner, "Phone Installment")
    assert (phone.is_active, phone.max_occurrences, phone.occurrences_paid_offset,
            phone.end_mode) == (False, 0, 6, "after_occurrences")
    laptop = entry(sw_db, owner, "Laptop Installment")
    assert (laptop.is_active, laptop.max_occurrences, laptop.occurrences_paid_offset) == (
        True, 8, 4)
    salary = entry(sw_db, owner, "Salary")
    assert (salary.semi_monthly_day_1, salary.semi_monthly_day_2) == (15, 30)
    assert wall(salary.next_occurrence) == datetime(2026, 3, 15)
    loan_entry = entry(sw_db, owner, "Car Loan Payment")
    assert loan_entry.transfer_to_account_id == account(sw_db, owner, "Car Loan").id
    assert loan_entry.is_autopay is True


# --- Test 7: cross currency ----------------------------------------------------------------

def test_cross_currency_rows_store_the_right_figures(tmp_path, owner, sw_db):
    load(tmp_path, fixture(), owner)
    move = txn(sw_db, owner, "Dollars home")
    assert (D(str(move.amount)), D(str(move.received_amount)), move.currency.value) == (
        D("100.00"), D("5800.00"), "USD")
    assert txn(sw_db, owner, "Dollar purchase").currency.value == "USD"
    posted = txn(sw_db, owner, "Streaming March")
    assert (posted.currency.value, D(str(posted.amount))) == ("PHP", D("590.00"))
    assert (D(str(posted.projected_amount)), posted.projected_currency.value) == (
        D("10.00"), "USD")
    assert (D(str(posted.original_amount)), posted.original_currency.value) == (D("10.00"), "USD")
    assert D(str(posted.exchange_rate)) == D("59.000000")
    pending = txn(sw_db, owner, "Pending foreign charge")
    assert (D(str(pending.amount)), D(str(pending.projected_amount))) == (D("20.00"), D("20.00"))
    assert (pending.projected_currency.value, pending.currency.value) == ("USD", "PHP")
    assert pending.original_amount is None and pending.is_posted is False


def test_currency_refusals_happen_before_any_write(tmp_path, owner, sw_db):
    from app.cutover_load.validate import InputInvalid

    data = fixture()
    del by_key(data["transactions"], "usd_move")["received_amount"]
    before = table_counts(sw_db)
    with pytest.raises(InputInvalid):
        load(tmp_path, data, owner)
    assert table_counts(sw_db) == before


# --- Test 8: dates -------------------------------------------------------------------------

def test_dates_round_trip_at_midnight(tmp_path, owner, sw_db, sw_client):
    from app.core.access import viewable_account_ids
    from app.models.user import User
    from app.services.forecast import cashflow_by_currency
    from app.services.statements import statement_history

    load(tmp_path, fixture("dates"), owner)
    m_end, m_first = txn(sw_db, owner, "Last day line"), txn(sw_db, owner, "First day line")
    assert wall(m_end.transaction_date) == datetime(2026, 3, 31, 0, 0)
    assert wall(m_first.transaction_date) == datetime(2026, 4, 1, 0, 0)
    fee = entry(sw_db, owner, "Monthly Fee")
    assert wall(fee.next_occurrence) == datetime(2026, 5, 1, 0, 0)

    user = sw_db.get(User, owner["id"])
    card = account(sw_db, owner, "Month End Card")
    history = statement_history(sw_db, card, datetime(2026, 4, 5),
                                viewable_account_ids(sw_db, user))
    assert [(h["close"].date(), h["balance"]) for h in history] == [
        (date(2026, 3, 31), D("100.00")), (date(2026, 4, 30), D("200.00"))]

    flow = cashflow_by_currency(sw_db, owner["id"], months=2, reference=datetime(2026, 4, 5),
                                fx=fx_rates())
    php = [next(r for r in p["by_currency"] if r["currency"] == "PHP") for p in flow["periods"]]
    assert (php[0]["unposted_expenses"], php[1]["unposted_expenses"]) == (300.0, 400.0)
    assert (php[0]["expenses"], php[1]["expenses"]) == (0.0, 50.0)

    headers = owner["headers"]
    body = sw_client.get(f"{API}/transactions/{m_end.id}", headers=headers).json()
    assert body["transaction_date"].startswith("2026-03-31T00:00:00")
    made = sw_client.post(f"{API}/budget-entries/{fee.id}/materialize", json={},
                          headers=headers)
    assert made.status_code == 201, made.text
    assert made.json()["transaction_date"].startswith("2026-05-01T00:00:00")
    assert wall(txn(sw_db, owner, "Monthly Fee").transaction_date) == datetime(2026, 5, 1)


# --- Test 9: atomicity ---------------------------------------------------------------------

def test_a_failure_after_some_rows_rolls_everything_back(tmp_path, owner, sw_db, monkeypatch):
    from fastapi import HTTPException

    from app.cutover_load import loader
    from app.cutover_load.loader import CutoverError

    real, calls = loader.add_transaction, []

    def failing(db, user, payload):
        calls.append(payload)
        if len(calls) > 5:
            raise HTTPException(status_code=400, detail="injected failure")
        return real(db, user, payload)

    monkeypatch.setattr(loader, "add_transaction", failing)
    before = table_counts(sw_db)
    with pytest.raises(CutoverError) as exc:
        load(tmp_path, fixture(), owner)
    assert exc.value.check == "write" and exc.value.detail == "injected failure"
    assert len(calls) == 6
    assert table_counts(sw_db) == before
    assert not (tmp_path / "run-record.json").exists()


def test_a_dry_run_changes_nothing_and_writes_no_run_record(tmp_path, owner, sw_db):
    before = table_counts(sw_db)
    report, record = load(tmp_path, fixture(), owner, dry_run=True)
    assert table_counts(sw_db) == before
    assert not record.exists()
    body = json.loads(report.read_text())
    assert body["dry_run"] is True and mode_of(report) == 0o600
    assert (body["database"], body["server_addr"]) == (TARGET["db"], TARGET["addr"])
    assert body["session_timezone"] == sw_db.execute(text("SHOW TimeZone")).scalar()
    assert by_key(body["accounts"], "card")["final"] == "-2210.00"
    assert body["loans"][0]["schedule"]["payments_made"] == 8
    assert {(i["key"], i["n"], i["m"]) for i in body["installments"]} == {
        ("e_laptop", 4, 12), ("e_phone", 6, 6)}
    assert body["row_counts"]["transactions"] == 13


# --- Test 10: the guard --------------------------------------------------------------------

def _seed_guard_case(case, db, who, other):
    """One row that breaks one rule of plan section 1.3."""
    from app.models.account import Account, AccountType
    from app.models.account_share import AccountShare
    from app.models.allocation import Allocation, AllocationType
    from app.models.budget_entry import BudgetEntry, BudgetEntryType
    from app.models.category import Category
    from app.models.tag import Tag, account_tags
    from app.models.tag_share import TagShare
    from app.models.transaction import Transaction, TransactionType
    from app.models.wishlist_item import WishlistItem

    theirs = Account(user_id=other["id"], name="Other bank", account_type=AccountType.CHECKING,
                     balance=0)
    db.add(theirs)
    db.flush()
    rows = {
        "accounts": lambda: Account(user_id=who["id"], name="Old", balance=0,
                                    account_type=AccountType.CHECKING),
        "transactions": lambda: Transaction(
            user_id=who["id"], account_id=theirs.id, amount=1, is_posted=False,
            transaction_type=TransactionType.DEBIT, transaction_date=datetime(2026, 1, 1)),
        "budget_entries": lambda: BudgetEntry(
            user_id=who["id"], name="Old", entry_type=BudgetEntryType.EXPENSE, amount=1,
            next_occurrence=datetime(2026, 1, 1)),
        "categories": lambda: Category(user_id=who["id"], name="Old"),
        "allocations": lambda: Allocation(user_id=who["id"], account_id=theirs.id, name="Old",
                                          allocation_type=list(AllocationType)[0]),
        "wishlist_items": lambda: WishlistItem(user_id=who["id"], name="Old", estimated_cost=1),
        "tags": lambda: Tag(user_id=who["id"], name="Old"),
        "tag_shares (Household tag)": lambda: TagShare(tag_id=who["household"],
                                                       user_id=other["id"]),
        "account_shares (received)": lambda: AccountShare(account_id=theirs.id,
                                                          user_id=who["id"], role="viewer"),
        "tag_shares (received)": lambda: TagShare(tag_id=hh_household(db, other),
                                                  user_id=who["id"]),
    }
    if case == "account_tags (Household tag)":
        db.execute(account_tags.insert().values(tag_id=who["household"], account_id=theirs.id))
    else:
        db.add(rows[case]())
    db.commit()


GUARD_CASES = ["accounts", "transactions", "budget_entries", "categories", "allocations",
               "wishlist_items", "tags", "account_tags (Household tag)",
               "tag_shares (Household tag)", "account_shares (received)",
               "tag_shares (received)"]


@pytest.mark.parametrize("case", GUARD_CASES)
def test_the_guard_refuses_each_rule(case, tmp_path, owner, sw_people, sw_db):
    from app.cutover_load.loader import CutoverError

    other = sw_people("Gus", "Other")
    _seed_guard_case(case, sw_db, owner, other)
    before = table_counts(sw_db)
    with pytest.raises(CutoverError) as exc:
        load(tmp_path, fixture(), owner)
    assert exc.value.check == "guard" and case in exc.value.detail
    assert table_counts(sw_db) == before


@pytest.mark.parametrize("case", ["missing", "unverified", "inactive", "demo", "case"])
def test_the_owner_must_be_one_active_verified_non_demo_user(case, tmp_path, owner, sw_people,
                                                             sw_db, sw_client):
    from app.cutover_load.loader import CutoverError
    from app.models.user import User

    who = dict(owner)
    sw_db.rollback()
    user = sw_db.get(User, owner["id"])
    if case == "missing":
        who["email"] = "nobody-here@example.com"
    elif case == "unverified":
        user.is_verified = False
    elif case == "inactive":
        user.is_active = False
    elif case == "demo":
        who["email"] = "Demo@Example.com"
    else:
        twin = sw_people("Twin", "Case")
        sw_db.get(User, twin["id"]).email = owner["email"].upper()
    sw_db.commit()
    before = table_counts(sw_db)
    with pytest.raises(CutoverError) as exc:
        load(tmp_path, fixture(), who)
    assert exc.value.check == "owner"
    assert table_counts(sw_db) == before


def test_an_alembic_mismatch_is_refused(tmp_path, owner, sw_db, monkeypatch):
    from app.cutover_load import loader

    monkeypatch.setattr(loader, "code_head", lambda: "0000not0head")
    before = table_counts(sw_db)
    with pytest.raises(loader.CutoverError) as exc:
        load(tmp_path, fixture(), owner)
    assert exc.value.check == "alembic"
    assert table_counts(sw_db) == before


# --- Test 11: the Household tag ------------------------------------------------------------

def test_a_missing_household_tag_is_refused_and_never_created(tmp_path, owner, sw_db):
    from app.cutover_load.loader import CutoverError

    sw_db.execute(text("DELETE FROM tags WHERE id = :t"), {"t": owner["household"]})
    sw_db.commit()
    before = table_counts(sw_db)
    with pytest.raises(CutoverError) as exc:
        load(tmp_path, fixture(), owner)
    assert exc.value.check == "household_tag"
    assert table_counts(sw_db) == before


# --- Test 12: the lock ---------------------------------------------------------------------

def test_a_second_run_is_refused_while_the_lock_is_held(tmp_path, owner, sw_db):
    from app.cutover_load.bootstrap import CUTOVER_LOCK_KEY, Refused

    engine = create_engine(TARGET["url"])
    try:
        with engine.connect() as holder:
            holder.begin()
            holder.execute(text("SELECT pg_advisory_xact_lock(:k)"), {"k": CUTOVER_LOCK_KEY})
            before = table_counts(sw_db)
            with pytest.raises(Refused) as exc:
                load(tmp_path, fixture(), owner)
            assert exc.value.check == "lock"
            assert "another cutover run is active" in exc.value.message
            assert table_counts(sw_db) == before
            holder.rollback()
    finally:
        engine.dispose()


# --- Tests 13 and 14: outputs, hermetic bootstrap, target ----------------------------------

HARNESS = """
import runpy, sys
script = sys.argv[1]
sys.argv = [script, *sys.argv[2:]]
code = 0
try:
    runpy.run_path(script, run_name="__main__")
except SystemExit as exc:
    code = exc.code
print("APP_IMPORTED=" + str("app.core.config" in sys.modules))
sys.exit(code)
"""


def run_wrapper(args, *, cwd, url=None, extra_env=None):
    env = {k: v for k, v in os.environ.items()
           if not k.startswith("PG") and k not in ("SECRET_KEY", "ENVIRONMENT")}
    env["DATABASE_URL"] = url or TARGET["url"]
    env.update(extra_env or {})
    return subprocess.run([sys.executable, "-I", "-c", HARNESS, SCRIPT, *args], cwd=cwd, env=env,
                          capture_output=True, text=True, timeout=120)


def target_args(host=None, db=None, addr=None):
    args = ["--expect-host", host or TARGET["host"], "--expect-db", db or TARGET["db"]]
    if addr:
        args += ["--expect-server-addr", addr]
    return args


def test_the_lock_key_is_the_cutover_checks():
    from app.cutover_load.bootstrap import CUTOVER_LOCK_KEY

    # Must equal CUTOVER_LOCK_KEY in app/cutover_check/bootstrap.py: the check takes
    # the shared lock on the same bigint key that the load and the reset take.
    assert CUTOVER_LOCK_KEY == 2_024_020_204


def test_an_output_inside_the_repo_is_refused_even_through_a_symlink(tmp_path, owner, sw_db):
    from app.cutover_load.outputs import repo_root

    path = write_input(tmp_path, fixture(), owner)
    inside = os.path.join(BACKEND, "cutover-report.json")
    link = tmp_path / "into-repo"
    link.symlink_to(os.path.join(repo_root(), "backend"))
    for report in (inside, str(link / "cutover-report.json")):
        done = run_wrapper(["--input", path, "--report", report, "--dry-run", *target_args()],
                           cwd=tmp_path)
        assert done.returncode == 1, done.stdout + done.stderr
        assert "refused: path" in done.stdout
        assert not os.path.exists(inside)
    inside_input = os.path.join(BACKEND, "cutover-input.json")
    done = run_wrapper(["--input", inside_input, "--report", str(tmp_path / "r.json"),
                        "--dry-run", *target_args()], cwd=tmp_path)
    assert "refused: path" in done.stdout


def test_a_relative_path_is_resolved_before_the_move_to_the_temp_directory(tmp_path, owner):
    """Run from inside the repo, a relative output path is refused as inside it: the
    path was resolved against the original directory, not the empty temp directory."""
    path = write_input(tmp_path, fixture(), owner)
    done = run_wrapper(["--input", path, "--report", "relative-report.json", "--dry-run",
                        *target_args()], cwd=BACKEND)
    assert done.returncode == 1
    assert "refused: path" in done.stdout and "APP_IMPORTED=False" in done.stdout
    assert not os.path.exists(os.path.join(BACKEND, "relative-report.json"))


def test_outputs_are_created_new_at_mode_0600(tmp_path):
    from app.cutover_load.bootstrap import Refused
    from app.cutover_load.outputs import create_private, replace_private

    path = str(tmp_path / "out.json")
    create_private(path, b"{}")
    assert mode_of(path) == 0o600
    with pytest.raises(Refused):
        create_private(path, b"{}")  # never overwrites
    replace_private(path, b'{"a": 1}')
    assert mode_of(path) == 0o600 and json.loads(open(path).read()) == {"a": 1}


def test_relative_paths_resolve_against_the_original_directory(tmp_path, owner, sw_db):
    write_input(tmp_path, fixture(), owner, "rel-input.json")
    before = table_counts(sw_db)
    done = run_wrapper(["--input", "rel-input.json", "--report", "rel-report.json",
                        "--dry-run", *target_args()], cwd=tmp_path)
    assert done.returncode == 0, done.stdout + done.stderr
    assert (tmp_path / "rel-report.json").exists()
    assert mode_of(tmp_path / "rel-report.json") == 0o600
    assert table_counts(sw_db) == before


def test_the_wrapper_ignores_a_local_env_file(tmp_path, owner, sw_db):
    (tmp_path / ".env").write_text(
        "DATABASE_URL=postgresql://someone@db.invalid:5432/elsewhere\n"
        "ENVIRONMENT=production\n")
    path = write_input(tmp_path, fixture(), owner)
    done = run_wrapper(["--input", path, "--report", str(tmp_path / "r.json"), "--dry-run",
                        *target_args(addr="192.0.2.1")], cwd=tmp_path)
    assert f"target: host={TARGET['host']} db={TARGET['db']}" in done.stdout
    assert "db.invalid" not in done.stdout + done.stderr
    assert "someone" not in done.stdout + done.stderr
    # Connected (the observed line) and refused before any write.
    assert f"observed: db={TARGET['db']} server_addr={TARGET['addr']}" in done.stdout
    assert "refused: expect_server_addr" in done.stdout


def test_an_expect_host_mismatch_is_refused_before_connecting(tmp_path, owner):
    path = write_input(tmp_path, fixture(), owner)
    other = "localhost" if TARGET["host"] != "localhost" else "127.0.0.1"
    done = run_wrapper(["--input", path, "--report", str(tmp_path / "r.json"), "--dry-run",
                        *target_args(host=other)], cwd=tmp_path)
    assert done.returncode == 1
    assert "refused: expect_host" in done.stdout
    assert "observed:" not in done.stdout and "APP_IMPORTED=False" in done.stdout


@pytest.mark.parametrize("query,env", [("host=db.invalid", {}), ("hostaddr=192.0.2.1", {}),
                                       ("", {"PGHOSTADDR": "192.0.2.1"}),
                                       ("", {"PGTZ": "Asia/Manila"}),
                                       ("options=-c%20search_path%3Dx", {}),
                                       ("sslmode=prefer&sslmode=disable", {})])
def test_target_overrides_are_refused_before_importing_the_app(query, env, tmp_path, owner):
    path = write_input(tmp_path, fixture(), owner)
    url = TARGET["url"] + (f"?{query}" if query else "")
    done = run_wrapper(["--input", path, "--report", str(tmp_path / "r.json"), "--dry-run",
                        *target_args()], cwd=tmp_path, url=url, extra_env=env)
    assert done.returncode == 1
    assert "refused:" in done.stdout and "observed:" not in done.stdout
    assert "APP_IMPORTED=False" in done.stdout
    assert "pw@" not in done.stdout + done.stderr  # never the password


def test_an_allowed_query_key_passes(tmp_path, owner):
    path = write_input(tmp_path, fixture(), owner)
    done = run_wrapper(["--input", path, "--report", str(tmp_path / "r.json"), "--dry-run",
                        *target_args(addr="192.0.2.1")], cwd=tmp_path,
                       url=TARGET["url"] + "?sslmode=prefer")
    assert f"observed: db={TARGET['db']}" in done.stdout
    assert "refused: expect_server_addr" in done.stdout


def test_an_expect_server_addr_mismatch_is_refused_after_connecting(tmp_path, owner, sw_db):
    from app.cutover_load.bootstrap import Refused

    before = table_counts(sw_db)
    with pytest.raises(Refused) as exc:
        load(tmp_path, fixture(), owner, addr="192.0.2.1")
    assert exc.value.check == "expect_server_addr"
    assert table_counts(sw_db) == before


def test_a_failure_prints_only_check_names_and_writes_details_to_the_report(tmp_path, owner):
    data = fixture()
    by_key(data["accounts"], "card")["balance_at_cutover"] = "-115.00"
    path = write_input(tmp_path, data, owner)
    report = tmp_path / "fail.json"
    done = run_wrapper(["--input", path, "--report", str(report), "--dry-run", *target_args()],
                       cwd=tmp_path)
    assert done.returncode == 1
    assert "FAIL card_opening [card]" in done.stdout
    assert "5.00" not in done.stdout and "115" not in done.stdout
    problem = json.loads(report.read_text())["problems"][0]
    assert problem["check"] == "card_opening" and "5.00" in problem["detail"]
    assert mode_of(report) == 0o600


# --- Test 15: reset ------------------------------------------------------------------------

def _demo_snapshot(db):
    db.rollback()
    ids = [r[0] for r in db.execute(text(
        "SELECT id FROM users WHERE email IN ('demo@example.com', 'demo.partner@example.com')"))]
    tables = {}
    for table in ("accounts", "transactions", "budget_entries", "categories", "allocations",
                  "tags"):
        tables[table] = db.execute(text(f"SELECT count(*) FROM {table} WHERE user_id = ANY(:u)"),
                                   {"u": ids}).scalar()
    spot = db.execute(text(
        "SELECT id, amount, description, transaction_date FROM transactions "
        "WHERE user_id = ANY(:u) ORDER BY id LIMIT 3"), {"u": ids}).all()
    balances = db.execute(text(
        "SELECT id, balance FROM accounts WHERE user_id = ANY(:u) ORDER BY id"), {"u": ids}).all()
    return ids, tables, spot, balances


def test_reset_restores_the_guard_and_leaves_other_users_alone(tmp_path, owner, sw_db,
                                                               sw_client):
    from app.cutover_load.loader import check_guard
    from app.models.user import User

    demo = _demo_snapshot(sw_db)
    assert demo[0], "the demo users are seeded by the app's lifespan"
    _, record = load(tmp_path, fixture(), owner)
    assert reset(record, owner["email"].upper()) == 0
    sw_db.rollback()
    check_guard(sw_db, sw_db.get(User, owner["id"]), owner["household"])
    assert counts(sw_db, owner["id"]) == {
        "accounts": 0, "transactions": 0, "budget_entries": 0, "categories": 0,
        "allocations": 0, "wishlist_items": 0, "tags": 1, "account_tags": 0,
        "transaction_tags": 0, "budget_entry_tags": 0, "account_shares": 0, "tag_shares": 0}
    assert _demo_snapshot(sw_db) == demo


def _break(case, db, who, record, other):
    from app.models.category import Category
    from app.models.transaction import Transaction, TransactionType

    db.rollback()  # a fresh transaction, so a server-side now() is after the load
    if case == "confirm":
        return "someone-else@example.com"
    if case == "database":
        edit_record(record, database="another_db")
    elif case == "server_addr":
        edit_record(record, server_addr="192.0.2.1")
    elif case == "owner_id":
        edit_record(record, owner_id=who["id"] + 100000)
    elif case == "foreign_row":
        bank = account(db, who, "Main Bank")
        db.add(Transaction(user_id=other["id"], account_id=bank.id, amount=1, is_posted=False,
                           transaction_type=TransactionType.CREDIT,
                           transaction_date=datetime(2026, 3, 20)))
    elif case == "last_login":
        db.execute(text("UPDATE users SET last_login = clock_timestamp() WHERE id = :u"),
                   {"u": who["id"]})
    elif case == "updated_after":
        db.execute(text("UPDATE transactions SET description = 'Edited later', "
                        "updated_at = clock_timestamp() WHERE id = "
                        "(SELECT min(id) FROM transactions WHERE user_id = :u)"), {"u": who["id"]})
    elif case == "created_after":
        db.add(Category(user_id=who["id"], name="Added later"))
    elif case == "link_deleted":
        db.execute(text("DELETE FROM transaction_tags WHERE transaction_id = "
                        "(SELECT min(transaction_id) FROM transaction_tags tt JOIN transactions t "
                        "ON t.id = tt.transaction_id WHERE t.user_id = :u)"), {"u": who["id"]})
    elif case == "signed_off":
        edit_record(record, signed_off_at="2026-03-10T12:00:00+00:00")
    db.commit()
    return who["email"]


RESET_REFUSALS = {"confirm": "confirm", "database": "target", "server_addr": "target",
                  "owner_id": "owner", "foreign_row": "foreign_references",
                  "last_login": "last_login", "updated_after": "changed_after_load",
                  "created_after": "row_counts", "link_deleted": "row_counts",
                  "signed_off": "signed_off"}


@pytest.mark.parametrize("case", sorted(RESET_REFUSALS))
def test_reset_refuses(case, tmp_path, owner, sw_people, sw_db):
    other = sw_people("Rex", "Other")
    _, record = load(tmp_path, fixture(), owner)
    confirm = _break(case, sw_db, owner, record, other)
    before = counts(sw_db, owner["id"])
    with pytest.raises(Exception) as exc:
        reset(record, confirm)
    assert getattr(exc.value, "check", None) == RESET_REFUSALS[case], exc.value
    assert counts(sw_db, owner["id"]) == before


def test_the_run_record_carries_the_loaded_state_fingerprint(tmp_path, owner, sw_db,
                                                             monkeypatch):
    from app.cutover_load import loader

    prepared = []
    real = loader.create_private

    def spy(path, payload):
        real(path, payload)
        if path.endswith("record.json"):
            prepared.append(json.loads(payload))

    monkeypatch.setattr(loader, "create_private", spy)
    _, record = load(tmp_path, fixture(), owner)
    rec = json.loads(record.read_text())
    assert len(rec["fingerprint"]) == 64 and rec["fingerprint"] == prepared[0]["fingerprint"]
    sw_db.rollback()
    assert loader.owner_fingerprint(sw_db, owner["id"])["sha256"] == rec["fingerprint"]


def test_reset_refuses_after_a_custom_tag_rename(tmp_path, owner, sw_db, sw_client):
    """A rename leaves the counts and the tag's created_at as they were."""
    from app.models.tag import Tag

    _, record = load(tmp_path, fixture(), owner)
    sw_db.rollback()
    tag = sw_db.query(Tag).filter(Tag.user_id == owner["id"], Tag.name == "Utilities").one()
    r = sw_client.put(f"{API}/tags/{tag.id}", json={"name": "Bills"}, headers=owner["headers"])
    assert r.status_code == 200, r.text
    before = counts(sw_db, owner["id"])
    with pytest.raises(Exception) as exc:
        reset(record, owner["email"])
    assert getattr(exc.value, "check", None) == "changed_after_load", exc.value
    assert counts(sw_db, owner["id"]) == before


def test_reset_refuses_after_a_household_link_is_swapped(tmp_path, owner, sw_db, sw_client):
    """A tag-only update moves no updated_at and keeps every count."""
    from app.models.tag import Tag

    _, record = load(tmp_path, fixture(), owner)
    rent = entry(sw_db, owner, "Rent")
    utilities = sw_db.query(Tag).filter(Tag.user_id == owner["id"],
                                        Tag.name == "Utilities").one()
    r = sw_client.put(f"{API}/budget-entries/{rent.id}", json={"tag_ids": [utilities.id]},
                      headers=owner["headers"])
    assert r.status_code == 200, r.text
    before = counts(sw_db, owner["id"])
    with pytest.raises(Exception) as exc:
        reset(record, owner["email"])
    assert getattr(exc.value, "check", None) == "changed_after_load", exc.value
    assert counts(sw_db, owner["id"]) == before


def test_a_no_op_touch_or_a_skewed_clock_leaves_reset_allowed(tmp_path, owner, sw_db):
    """Content unchanged: a later updated_at alone (a no-op save, or the app's
    clock five minutes ahead of the database's) does not block the reset."""
    _, record = load(tmp_path, fixture(), owner)
    sw_db.rollback()
    sw_db.execute(text("UPDATE transactions SET updated_at = clock_timestamp() "
                       "+ interval '5 minutes' WHERE user_id = :u"), {"u": owner["id"]})
    sw_db.commit()
    assert reset(record, owner["email"]) == 0
    assert counts(sw_db, owner["id"])["transactions"] == 0


def test_an_edit_is_caught_even_with_finished_at_five_minutes_ahead(tmp_path, owner, sw_db,
                                                                    sw_client):
    """A run record whose finished_at is five minutes in the future (clock skew)
    hides nothing: the fingerprint, not the timestamps, decides."""
    from datetime import timedelta

    from app.models.tag import Tag

    _, record = load(tmp_path, fixture(), owner)
    rec = json.loads(record.read_text())
    ahead = datetime.fromisoformat(rec["finished_at"]) + timedelta(minutes=5)
    edit_record(record, finished_at=ahead.isoformat())
    sw_db.rollback()
    tag = sw_db.query(Tag).filter(Tag.user_id == owner["id"], Tag.name == "Utilities").one()
    sw_client.put(f"{API}/tags/{tag.id}", json={"color": "#112233"}, headers=owner["headers"])
    with pytest.raises(Exception) as exc:
        reset(record, owner["email"])
    assert getattr(exc.value, "check", None) == "changed_after_load", exc.value


def test_finished_at_is_the_database_clock_after_the_commit(tmp_path, owner, sw_db,
                                                           monkeypatch):
    """finished_at is clock_timestamp() alone, never stretched to a row's
    (application-clock) updated_at."""
    from app.cutover_load import loader

    assert not hasattr(loader, "finished_clock")
    _, record = load(tmp_path, fixture(), owner)
    rec = json.loads(record.read_text())
    sw_db.rollback()
    now = sw_db.execute(text("SELECT clock_timestamp()")).scalar()
    assert datetime.fromisoformat(rec["started_at"]) < datetime.fromisoformat(
        rec["finished_at"]) <= now


def test_a_reset_dry_run_changes_nothing(tmp_path, owner, sw_db):
    _, record = load(tmp_path, fixture(), owner)
    before = table_counts(sw_db)
    assert reset(record, owner["email"], dry_run=True) == 0
    assert table_counts(sw_db) == before
    assert json.loads(record.read_text())["status"] == "complete"


# --- Test 16: sign-off ---------------------------------------------------------------------

def _check_report(tmp_path, record, name, **changes):
    """A hand-written cutover check report (STU-204's shape) for the record's owner."""
    rec = json.loads(record.read_text())
    body = {"report": "cutover-check", "version": 1, "overall": "pass",
            "owner_id": rec["owner_id"], "database": rec["database"],
            "server_addr": rec["server_addr"], "host": TARGET["host"],
            "frozen_sha256": "0" * 64, "session_timezone": rec["session_timezone"],
            "checked_at": "2026-03-10T12:00:00+00:00", "as_of": "2026-03-01",
            "posted_after": [],
            "blocks": [{"name": "balances", "status": "pass", "checked": 7, "failures": []}],
            **changes}
    path = tmp_path / name
    path.write_text(json.dumps(body))
    return path


def test_sign_off_refuses_a_failing_or_mismatched_check_then_closes_the_window(tmp_path, owner,
                                                                              sw_db):
    from app.cutover_load.bootstrap import Refused
    from app.cutover_load.reset import sign_off

    _, record = load(tmp_path, fixture(), owner)
    for name, changes in (("fail.json", {"overall": "fail"}),
                          ("kind.json", {"report": "cutover-load-review"}),
                          ("version.json", {"version": 2}),
                          ("tz.json", {"session_timezone": "Asia/Manila"
                                       if json.loads(record.read_text())["session_timezone"]
                                       != "Asia/Manila" else "Etc/UTC"}),
                          ("db.json", {"database": "another_db"}),
                          ("addr.json", {"server_addr": "192.0.2.1"}),
                          ("owner.json", {"owner_id": owner["id"] + 1})):
        with pytest.raises(Refused) as exc:
            sign_off(run_record_path=str(record),
                     check_report_path=str(_check_report(tmp_path, record, name, **changes)),
                     confirm=owner["email"], out=quiet)
        assert exc.value.check == "check_report", name
        assert json.loads(record.read_text())["signed_off_at"] is None
    good = _check_report(tmp_path, record, "good.json")
    with pytest.raises(Refused):
        sign_off(run_record_path=str(record), check_report_path=str(good),
                 confirm="someone-else@example.com", out=quiet)
    assert sign_off(run_record_path=str(record), check_report_path=str(good),
                    confirm=owner["email"], out=quiet) == 0
    signed = json.loads(record.read_text())
    assert signed["signed_off_at"] and signed["status"] == "complete"
    assert mode_of(record) == 0o600
    with pytest.raises(Refused) as exc:
        reset(record, owner["email"])
    assert exc.value.check == "signed_off"
    assert counts(sw_db, owner["id"])["transactions"] == 13


def test_sign_off_makes_no_database_connection(tmp_path, owner):
    _, record = load(tmp_path, fixture(), owner)
    good = _check_report(tmp_path, record, "good.json")
    done = run_wrapper(["--sign-off", "--run-record", str(record), "--check-report", str(good),
                        "--confirm", owner["email"]], cwd=tmp_path,
                       url="postgresql://nobody@db.invalid:1/none")
    assert done.returncode == 0, done.stdout + done.stderr
    assert "sign-off: pass" in done.stdout and "APP_IMPORTED=False" in done.stdout


# --- Test 17: Household --------------------------------------------------------------------

def test_the_spouse_sees_exactly_the_household_set_once_shared(tmp_path, owner, sw_people,
                                                               sw_db, sw_client):
    from app.tests.conftest import sw_share
    from app.models.tag_share import TagShare

    load(tmp_path, fixture(), owner)
    spouse = sw_people("Sky", "Spouse")
    joint = account(sw_db, owner, "Joint Bank")
    sw_share(sw_db, joint.id, spouse["id"], "editor", owner["id"])
    sw_db.add(TagShare(tag_id=owner["household"], user_id=spouse["id"]))
    sw_db.commit()

    sw_db.rollback()
    from app.models.budget_entry import BudgetEntry
    from app.models.transaction import Transaction

    loaded = {t.description: t.id for t in sw_db.query(Transaction).filter(
        Transaction.user_id == owner["id"])}
    seen = sw_client.get(f"{API}/transactions/", headers=spouse["headers"],
                         params={"limit": 200}).json()["items"]
    visible = {t["id"] for t in seen} & set(loaded.values())
    expected = {loaded[d] for d in ("Spouse deposit", "Rent March", "Household groceries")}
    assert visible == expected
    for private in ("Dollar purchase", "Card line one", "Car loan payment 8", "Wallet top-up"):
        r = sw_client.get(f"{API}/transactions/{loaded[private]}", headers=spouse["headers"])
        assert r.status_code == 404, private
    entries = sw_client.get(f"{API}/budget-entries/", headers=spouse["headers"],
                            params={"limit": 200}).json()
    owned_entries = {e.id for e in sw_db.query(BudgetEntry).filter(
        BudgetEntry.user_id == owner["id"])}
    seen_entries = [e for e in entries["items"] if e["id"] in owned_entries]
    assert [e["id"] for e in seen_entries] == [entry(sw_db, owner, "Rent").id]
    assert seen_entries[0]["view"] == "limited"  # the Household view of an owner entry
    accounts = {a["name"] for a in sw_client.get(
        f"{API}/accounts/", headers=spouse["headers"], params={"limit": 200}).json()["items"]}
    assert "Joint Bank" in accounts and "Main Bank" not in accounts


def test_the_input_fixture_carries_no_owner_figures():
    """Synthetic figures only: every money value is a round invented number."""
    data = fixture()
    values = [a["balance_at_cutover"] for a in data["accounts"]]
    values += [t.get("amount") or t.get("face_amount") for t in data["transactions"]]
    assert all(D(v) % 10 == 0 for v in values if v), values
    assert copy.deepcopy(data) == fixture()
