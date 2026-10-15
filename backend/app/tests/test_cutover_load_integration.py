"""The cutover load against a real database (STU-202; plan v3, sections 2.2 to 2.4, 2.6).

Runs ``app.cutover_load`` in-process (and ``scripts/cutover_load.py`` as a
subprocess for the bootstrap cases) on the synthetic fixtures in
``data/cutover_load/`` (invented round figures). Every input and output file
lives in pytest's temporary directory, outside the repository.

**Skip gate.** These tests write and reset rows, so they run only against a
local database: the effective ``settings.DATABASE_URL`` must equal the exported
``DATABASE_URL``, the URL must pass the cutover's own URL validation with a
host of ``localhost``, ``127.0.0.1`` or ``::1``, and the server must report a
loopback address or one in the Docker bridge range 172.16.0.0/12 (a database
in a local container reports its container address, never a loopback one).
"""
import ipaddress
import json
import os
import stat
import subprocess
import sys
import threading
from datetime import date, datetime, timedelta
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
DOCKER_BRIDGE = ipaddress.ip_network("172.16.0.0/12")
D = Decimal


def gate_allows(host: str, address: str) -> bool:
    """The gate's host and server-address rule: a loopback URL host, and a server
    address that is loopback or in the Docker bridge range (a local container
    reports its bridge address, such as 172.17.0.x)."""
    if host not in LOCAL_HOSTS:
        return False
    ip = ipaddress.ip_address(address)
    return ip.is_loopback or ip in DOCKER_BRIDGE


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
    if not gate_allows(parsed.host, address):
        return False, "the server address is neither loopback nor the Docker bridge", None
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


def test_day_fields_load_as_given_and_a_day_31_entry_gets_anchor_31(tmp_path, owner, sw_db):
    """STU-315: a rule is stored with the rule (never an anchor), an anchor as
    given, and an entry with neither on the 31st is anchored on 31."""
    data = fixture()
    by_key(data["budget_entries"], "e_rent").update(next_occurrence="2026-04-30",
                                                    day_rule="last_weekday")
    by_key(data["budget_entries"], "e_loan")["anchor_day"] = 20
    by_key(data["budget_entries"], "e_stream")["next_occurrence"] = "2026-05-31"
    load(tmp_path, data, owner)
    rent = entry(sw_db, owner, "Rent")
    assert (rent.day_rule, rent.anchor_day) == ("last_weekday", None)
    assert wall(rent.next_occurrence) == datetime(2026, 4, 30)
    loan_entry = entry(sw_db, owner, "Car Loan Payment")
    assert (loan_entry.day_rule, loan_entry.anchor_day) == (None, 20)
    stream = entry(sw_db, owner, "Streaming")
    assert (stream.day_rule, stream.anchor_day) == (None, 31)
    assert entry(sw_db, owner, "Salary").anchor_day is None  # semi-monthly


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

def test_a_load_whose_session_is_not_on_utc_is_refused(tmp_path, owner, sw_db, monkeypatch):
    """STU-315 (defence in depth): every engine pins UTC; should a session still
    read another zone, the load refuses before writing anything."""
    import app.cutover_load.loader as loader
    from app.cutover_load.bootstrap import Refused

    before = counts(sw_db, owner["id"])
    monkeypatch.setattr(loader, "UTC_SESSION_OPTIONS", "-c timezone=Asia/Manila")
    with pytest.raises(Refused) as exc:
        load(tmp_path, fixture(), owner)
    assert exc.value.check == "session_timezone"
    assert counts(sw_db, owner["id"]) == before
    assert not (tmp_path / "run-report.json").exists()
    assert not (tmp_path / "run-record.json").exists()


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
    loan = body["loans"][0]
    assert loan["schedule"]["payments_made"] == 8
    # The schedule's owed beside balance_at_cutover, for the owner to compare.
    assert (loan["balance_at_cutover"], loan["schedule_owed"]) == ("-300000.00", "293000.00")
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
    from app.models.tag import Tag, account_tags, budget_entry_tags, transaction_tags
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
    elif case == "transaction_tags (Household tag)":
        row = Transaction(user_id=other["id"], account_id=theirs.id, amount=1, is_posted=False,
                          transaction_type=TransactionType.DEBIT,
                          transaction_date=datetime(2026, 1, 1))
        db.add(row)
        db.flush()
        db.execute(transaction_tags.insert().values(tag_id=who["household"],
                                                    transaction_id=row.id))
    elif case == "budget_entry_tags (Household tag)":
        row = BudgetEntry(user_id=other["id"], name="Theirs", entry_type=BudgetEntryType.EXPENSE,
                          amount=1, next_occurrence=datetime(2026, 1, 1))
        db.add(row)
        db.flush()
        db.execute(budget_entry_tags.insert().values(tag_id=who["household"],
                                                     budget_entry_id=row.id))
    else:
        db.add(rows[case]())
    db.commit()


GUARD_CASES = ["accounts", "transactions", "budget_entries", "categories", "allocations",
               "wishlist_items", "tags", "account_tags (Household tag)",
               "transaction_tags (Household tag)", "budget_entry_tags (Household tag)",
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
            # In a thread with a hard deadline: a loader that waited for the lock
            # (pg_advisory_xact_lock) would fail here instead of hanging the suite.
            outcome = {}

            def attempt():
                try:
                    load(tmp_path, fixture(), owner)
                except BaseException as exc:  # noqa: BLE001 - recorded for the asserts
                    outcome["error"] = exc

            runner = threading.Thread(target=attempt, daemon=True)
            runner.start()
            runner.join(timeout=30)
            waited = runner.is_alive()
            holder.rollback()  # releases the lock, so a waiting loader can finish
            runner.join(timeout=30)
            assert not waited, "the loader waited for the lock instead of refusing"
            exc = outcome.get("error")
            assert isinstance(exc, Refused) and exc.check == "lock", exc
            assert "another cutover run is active" in exc.message
            assert table_counts(sw_db) == before
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


def test_a_settings_error_prints_only_its_class(tmp_path, owner):
    """Production settings without a SECRET_KEY fail validation on import; the
    wrapper prints the error class only: no traceback, no environment value."""
    sentinel = "https://zq9sentinel@example.com/1"
    env = {"ENVIRONMENT": "production", "SENTRY_DSN": sentinel}
    path = write_input(tmp_path, fixture(), owner)
    args = ["--input", path, "--report", str(tmp_path / "r.json"), "--dry-run",
            *target_args()]
    done = run_wrapper(args, cwd=tmp_path, extra_env=env)
    assert done.returncode == 1, done.stdout + done.stderr
    assert "error: ValidationError" in done.stdout
    shown = done.stdout + done.stderr
    assert "Traceback" not in shown and "zq9sentinel" not in shown
    assert "production" not in shown


SENTINEL_DIR = "private-bank-987654.32"


@pytest.mark.parametrize("output", ["report", "run_record"])
def test_a_failed_output_write_prints_only_its_class(output, tmp_path, owner, sw_db):
    """An output file that cannot be written: the class only, never the path."""
    path = write_input(tmp_path, fixture(), owner)
    missing = tmp_path / SENTINEL_DIR  # this directory does not exist
    report = (missing if output == "report" else tmp_path) / "r.json"
    record = (missing if output == "run_record" else tmp_path) / "record.json"
    before = counts(sw_db, owner["id"])
    done = run_wrapper(["--input", path, "--report", str(report), "--run-record", str(record),
                        *target_args(addr=TARGET["addr"])], cwd=tmp_path)
    assert done.returncode == 1, done.stdout + done.stderr
    assert "error: FileNotFoundError" in done.stdout
    assert "Traceback" not in done.stderr
    assert "987654" not in done.stdout + done.stderr
    assert not os.path.exists(tmp_path / "record.json")
    if output == "run_record":  # the review report is discarded; the failure report replaces it
        written = json.loads((tmp_path / "r.json").read_text())
        assert written["kind"] == "cutover-load-failure"
        assert written["problems"] == [{"check": "error", "key": "-",
                                        "detail": "FileNotFoundError"}]
    sw_db.rollback()
    assert counts(sw_db, owner["id"]) == before


def test_an_unexpected_bootstrap_error_prints_only_its_class(tmp_path):
    code = ("import runpy, sys, tempfile\n"
            "def mkdtemp(*args, **kwargs):\n"
            f"    raise PermissionError(13, 'Permission denied', '/x/{SENTINEL_DIR}/tmp')\n"
            "tempfile.mkdtemp = mkdtemp\n"
            f"sys.argv = {[SCRIPT, '--input', str(tmp_path / 'in.json'), '--report', str(tmp_path / 'r.json'), '--dry-run', '--expect-host', '127.0.0.1', '--expect-db', 'c2db']!r}\n"
            f"runpy.run_path({SCRIPT!r}, run_name='__main__')\n")
    env = {k: v for k, v in os.environ.items() if not k.startswith("PG")}
    env["DATABASE_URL"] = "postgresql://u:pw@127.0.0.1:1/c2db"
    done = subprocess.run([sys.executable, "-I", "-c", code], cwd=tmp_path, env=env,
                          capture_output=True, text=True, timeout=120)
    assert done.returncode == 1, done.stdout + done.stderr
    assert "error: PermissionError" in done.stdout
    assert "Traceback" not in done.stderr
    assert "987654" not in done.stdout + done.stderr


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
                                       ("", {"PGOPTIONS": "-c TimeZone=Asia/Manila"}),
                                       ("", {"PGOPTIONS": "-c search_path=elsewhere"}),
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


@pytest.mark.parametrize("url", [
    # An unencoded "@" in a password: the parser takes "zq9xk@127.0.0.1" as the host.
    "postgresql://u:pa@zq9xk@127.0.0.1:5432/db",
    "postgresql://u:pw@127.0.0.1:5432/zq9xk",
    "postgresql://u:pw@127.0.0.1:5432/db?zq9xk=1",
    "zq9xk://u:pw@127.0.0.1:5432/db",
])
def test_a_refusal_never_echoes_a_part_of_the_url(url, tmp_path):
    done = run_wrapper(["--input", str(tmp_path / "in.json"), "--report",
                        str(tmp_path / "r.json"), "--dry-run",
                        "--expect-host", "127.0.0.1", "--expect-db", "db"],
                       cwd=tmp_path, url=url)
    assert done.returncode == 1 and "refused:" in done.stdout
    assert "zq9xk" not in done.stdout + done.stderr


def test_the_transaction_pooler_port_is_refused(tmp_path, owner):
    """Port 6543 (a transaction pooler): the server address and session settings
    would describe whichever backend serves each transaction."""
    path = write_input(tmp_path, fixture(), owner)
    # Set, not replaced in the text: a URL without a port would otherwise stay as
    # it is and run a dry run. Rendered only for the subprocess environment.
    pooled = make_url(TARGET["url"]).set(port=6543).render_as_string(hide_password=False)
    assert make_url(pooled).port == 6543
    done = run_wrapper(["--input", path, "--report", str(tmp_path / "r.json"), "--dry-run",
                        *target_args()], cwd=tmp_path, url=pooled)
    assert done.returncode == 1
    assert "refused: url" in done.stdout and "6543" in done.stdout
    assert "APP_IMPORTED=False" in done.stdout


@pytest.mark.parametrize("host,address,allowed", [
    ("127.0.0.1", "127.0.0.1", True), ("localhost", "::1", True),
    ("127.0.0.1", "172.17.0.3", True), ("127.0.0.1", "172.31.255.1", True),
    ("127.0.0.1", "10.0.0.5", False), ("127.0.0.1", "192.168.1.20", False),
    ("127.0.0.1", "203.0.113.7", False), ("db.example.com", "172.17.0.3", False),
])
def test_the_gate_accepts_only_loopback_or_the_docker_bridge(host, address, allowed):
    assert gate_allows(host, address) is allowed


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


@pytest.mark.parametrize("existing", ["report", "record"])
def test_an_existing_output_is_refused_before_connecting(existing, tmp_path, owner, sw_db):
    """Checked first, so a refusal can never leave a stale prepared record."""
    from app.cutover_load.bootstrap import Refused

    (tmp_path / f"run-{existing}.json").write_text("{}")
    shown = []
    before = table_counts(sw_db)
    from app.cutover_load.bootstrap import validate_url
    from app.cutover_load.loader import run_load

    url = validate_url(TARGET["url"], expect_host=TARGET["host"], expect_db=TARGET["db"])
    with pytest.raises(Refused) as exc:
        run_load(url=url, input_path=write_input(tmp_path, fixture(), owner),
                 report_path=str(tmp_path / "run-report.json"),
                 run_record_path=str(tmp_path / "run-record.json"), dry_run=False,
                 expect_db=TARGET["db"], expect_server_addr=TARGET["addr"], out=shown.append)
    assert exc.value.check == "path" and shown == []  # before connecting
    assert table_counts(sw_db) == before
    other = "record" if existing == "report" else "report"
    assert not (tmp_path / f"run-{other}.json").exists()


# --- A failure after the commit ------------------------------------------------------------

def _complete(record, **kw):
    from app.cutover_load.bootstrap import validate_url
    from app.cutover_load.loader import complete_record

    url = validate_url(TARGET["url"], expect_host=TARGET["host"], expect_db=TARGET["db"])
    return complete_record(url=url, run_record_path=str(record), expect_db=TARGET["db"],
                           expect_server_addr=kw.get("addr", TARGET["addr"]), out=quiet)


def _load_failing_after_commit(tmp_path, owner, monkeypatch):
    from app.cutover_load import loader

    def broken(path, payload):
        raise OSError("disk full")

    monkeypatch.setattr(loader, "replace_private", broken)
    with pytest.raises(loader.CommittedIncomplete):
        load(tmp_path, fixture(), owner)
    monkeypatch.undo()
    return tmp_path / "run-record.json"


def _commit_failing(monkeypatch, *, commits: bool):
    """The load's COMMIT raises once: after committing (a connection lost on the
    reply), or without committing."""
    from sqlalchemy.engine.base import RootTransaction

    real = RootTransaction.commit
    calls = []

    def flaky(self):
        if calls:
            return real(self)
        calls.append(1)
        if commits:
            real(self)
        else:
            self.rollback()
        raise ConnectionError("connection lost during COMMIT")

    monkeypatch.setattr(RootTransaction, "commit", flaky)


@pytest.mark.parametrize("committed", [True, False])
def test_a_failed_commit_is_outcome_unknown_and_complete_record_decides(committed, tmp_path,
                                                                        owner, sw_db,
                                                                        monkeypatch):
    from app.cutover_load import loader

    _commit_failing(monkeypatch, commits=committed)
    with pytest.raises(loader.CommitOutcomeUnknown):
        load(tmp_path, fixture(), owner)
    monkeypatch.undo()
    record = tmp_path / "run-record.json"
    assert json.loads(record.read_text())["status"] == "prepared"
    assert counts(sw_db, owner["id"])["transactions"] == (13 if committed else 0)
    if committed:
        assert _complete(record) == 0
        assert json.loads(record.read_text())["status"] == "complete"
    else:
        with pytest.raises(Exception) as exc:
            _complete(record)
        assert getattr(exc.value, "check", None) == "changed_after_load"
        assert json.loads(record.read_text())["status"] == "prepared"


@pytest.mark.parametrize("failing", ["report", "record"])
def test_an_output_write_failure_leaves_no_stale_file(failing, tmp_path, owner, sw_db,
                                                      monkeypatch):
    from app.cutover_load import loader

    real = loader.create_private

    def broken(path, payload):
        if path.endswith(f"run-{failing}.json"):
            raise OSError("disk full")
        real(path, payload)

    monkeypatch.setattr(loader, "create_private", broken)
    before = table_counts(sw_db)
    with pytest.raises(OSError):
        load(tmp_path, fixture(), owner)
    assert not (tmp_path / "run-record.json").exists()
    assert not (tmp_path / "run-report.json").exists()
    assert table_counts(sw_db) == before


def _fsync_fails_for(monkeypatch, suffix):
    """``os.fsync`` raises for a file whose name ends with ``suffix``: a failure after
    ``create_private`` has already created the file."""
    real = os.fsync

    def fsync(fd):
        if os.readlink(f"/proc/self/fd/{fd}").endswith(suffix):
            raise OSError(28, "No space left on device")
        real(fd)

    monkeypatch.setattr(os, "fsync", fsync)


def test_create_private_removes_its_file_when_the_write_fails(tmp_path, monkeypatch):
    from app.cutover_load.outputs import create_private

    _fsync_fails_for(monkeypatch, "out.json")
    with pytest.raises(OSError):
        create_private(str(tmp_path / "out.json"), b"{}")
    assert not os.path.lexists(tmp_path / "out.json")


def test_create_private_never_removes_a_file_that_was_already_there(tmp_path):
    from app.cutover_load.bootstrap import Refused
    from app.cutover_load.outputs import create_private

    theirs = tmp_path / "theirs.json"
    theirs.write_text("kept")
    with pytest.raises(Refused):
        create_private(str(theirs), b"{}")
    assert theirs.read_text() == "kept"


@pytest.mark.parametrize("failing", ["report", "record"])
def test_a_failed_output_fsync_leaves_no_file_and_no_rows(failing, tmp_path, owner, sw_db,
                                                          monkeypatch):
    _fsync_fails_for(monkeypatch, f"run-{failing}.json")
    before = table_counts(sw_db)
    with pytest.raises(OSError):
        load(tmp_path, fixture(), owner)
    assert not (tmp_path / "run-record.json").exists()
    assert not (tmp_path / "run-report.json").exists()
    assert table_counts(sw_db) == before


def test_the_wrapper_exits_3_when_the_commit_outcome_is_unknown(capsys):
    import importlib.util

    from app.cutover_load.loader import CommitOutcomeUnknown

    spec = importlib.util.spec_from_file_location("cutover_load_wrapper", SCRIPT)
    wrapper = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(wrapper)
    assert wrapper.refuse(CommitOutcomeUnknown("ConnectionError"), None) == 3
    shown = capsys.readouterr().out
    assert "commit outcome UNKNOWN" in shown and "--complete-record" in shown


def test_a_failure_after_the_commit_is_reported_and_recovered(tmp_path, owner, sw_db,
                                                              monkeypatch):
    record = _load_failing_after_commit(tmp_path, owner, monkeypatch)
    assert json.loads(record.read_text())["status"] == "prepared"
    assert counts(sw_db, owner["id"])["transactions"] == 13  # committed
    assert _complete(record) == 0
    rec = json.loads(record.read_text())
    assert rec["status"] == "complete" and rec["finished_at"]
    assert mode_of(record) == 0o600
    with pytest.raises(Exception) as exc:
        _complete(record)  # only a prepared record
    assert getattr(exc.value, "check", None) == "run_record"
    assert reset(record, owner["email"]) == 0


def test_complete_record_refuses_when_the_state_differs(tmp_path, owner, sw_db, monkeypatch):
    record = _load_failing_after_commit(tmp_path, owner, monkeypatch)
    sw_db.rollback()
    sw_db.execute(text("UPDATE categories SET name = 'Renamed' WHERE id = "
                       "(SELECT min(id) FROM categories WHERE user_id = :u)"), {"u": owner["id"]})
    sw_db.commit()
    with pytest.raises(Exception) as exc:
        _complete(record)
    assert getattr(exc.value, "check", None) == "changed_after_load"
    assert json.loads(record.read_text())["status"] == "prepared"
    with pytest.raises(Exception) as exc:
        _complete(record, addr="192.0.2.1")
    assert getattr(exc.value, "check", None) == "expect_server_addr"


def test_the_wrapper_exits_3_when_the_load_committed_but_the_record_is_incomplete(capsys):
    import importlib.util

    from app.cutover_load.loader import CommittedIncomplete

    spec = importlib.util.spec_from_file_location("cutover_load_wrapper", SCRIPT)
    wrapper = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(wrapper)
    assert wrapper.refuse(CommittedIncomplete("OSError"), None) == 3
    shown = capsys.readouterr().out
    assert "load: COMMITTED; run record incomplete" in shown and "--complete-record" in shown


def test_complete_record_needs_the_target_flags(tmp_path):
    done = run_wrapper(["--complete-record", "--run-record", str(tmp_path / "x.json")],
                       cwd=tmp_path)
    assert done.returncode == 2 and "this mode needs" in done.stderr
    assert "--expect-server-addr" in done.stderr.split("this mode needs")[1]


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


def _owner_allocation(db, who, record):
    """An owner allocation, recorded as if the load had made it: the run record's
    counts and fingerprint are taken again, so only the foreign row differs."""
    from app.cutover_load.loader import owner_counts, owner_fingerprint
    from app.models.allocation import Allocation, AllocationType

    db.rollback()
    held = Allocation(user_id=who["id"], account_id=account(db, who, "Main Bank").id,
                      name="Rainy Day", allocation_type=AllocationType.SAVINGS)
    db.add(held)
    db.commit()
    fingerprint = owner_fingerprint(db, who["id"])
    edit_record(record, row_counts=owner_counts(db, who["id"]),
                fingerprint=fingerprint["sha256"], fingerprint_tables=fingerprint["tables"])
    db.commit()
    return held.id


FOREIGN_CASES = ("transaction_allocation", "entry_allocation", "wishlist_category",
                 "payment_account", "payment_overflow_account")


@pytest.mark.parametrize("case", FOREIGN_CASES)
def test_reset_refuses_another_users_reference_to_the_owner(case, tmp_path, owner,
                                                             sw_people, sw_db):
    from app.models.account import Account, AccountType
    from app.models.budget_entry import BudgetEntry, BudgetEntryType
    from app.models.category import Category
    from app.models.transaction import Transaction, TransactionType
    from app.models.wishlist_item import WishlistItem

    other = sw_people("Rex", "Other")
    _, record = load(tmp_path, fixture(), owner)
    held = _owner_allocation(sw_db, owner, record) if case.endswith("allocation") else None
    sw_db.rollback()
    bank = account(sw_db, owner, "Main Bank")
    wallet = Account(user_id=other["id"], name="Other Wallet", account_type=AccountType.CASH)
    sw_db.add(wallet)
    sw_db.flush()
    if case == "transaction_allocation":
        sw_db.add(Transaction(user_id=other["id"], account_id=wallet.id, allocation_id=held,
                              amount=1, is_posted=False, transaction_type=TransactionType.DEBIT,
                              transaction_date=datetime(2026, 3, 20)))
    elif case == "entry_allocation":
        sw_db.add(BudgetEntry(user_id=other["id"], entry_type=BudgetEntryType.EXPENSE,
                              name="Other Bill", amount=1, allocation_id=held,
                              next_occurrence=datetime(2026, 4, 1)))
    elif case == "wishlist_category":
        mine = sw_db.query(Category).filter(Category.user_id == owner["id"]).first()
        sw_db.add(WishlistItem(user_id=other["id"], name="Other Wish", estimated_cost=1,
                               category_id=mine.id))
    elif case == "payment_account":
        wallet.payment_account_id = bank.id
    elif case == "payment_overflow_account":
        wallet.payment_overflow_account_id = bank.id
    sw_db.commit()
    before = counts(sw_db, owner["id"])
    with pytest.raises(Exception) as exc:
        reset(record, owner["email"])
    assert getattr(exc.value, "check", None) == "foreign_references", exc.value
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


def test_the_fingerprint_does_not_depend_on_the_session_time_zone(tmp_path, owner):
    from sqlalchemy.orm import Session

    from app.cutover_load.loader import owner_fingerprint

    _, record = load(tmp_path, fixture(), owner)
    engine = create_engine(TARGET["url"])
    try:
        found = {}
        for zone in ("UTC", "Asia/Manila"):
            with engine.connect() as conn:
                conn.execute(text(f"SET TIME ZONE '{zone}'"))
                found[zone] = owner_fingerprint(Session(bind=conn), owner["id"])["sha256"]
    finally:
        engine.dispose()
    assert found["UTC"] == found["Asia/Manila"] == json.loads(record.read_text())["fingerprint"]


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


def test_a_reset_refusal_writes_its_details_to_an_optional_report(tmp_path, owner, sw_people,
                                                                 sw_db):
    other = sw_people("Rex", "Other")
    _, record = load(tmp_path, fixture(), owner)
    _break("link_deleted", sw_db, owner, record, other)
    report = tmp_path / "reset-report.json"
    done = run_wrapper(["--reset", "--run-record", str(record), "--confirm", owner["email"],
                        "--report", str(report), *target_args(addr=TARGET["addr"])],
                       cwd=tmp_path)
    assert done.returncode == 1
    assert "FAIL row_counts [owner]" in done.stdout and "transaction_tags" not in done.stdout
    problem = json.loads(report.read_text())["problems"][0]
    assert problem["check"] == "row_counts" and "transaction_tags" in problem["detail"]
    assert mode_of(report) == 0o600


def test_a_reset_report_that_exists_is_refused_before_connecting(tmp_path, owner, sw_db):
    from app.cutover_load.bootstrap import Refused, validate_url
    from app.cutover_load.reset import run_reset

    _, record = load(tmp_path, fixture(), owner)
    (tmp_path / "old-report.json").write_text("{}")
    url = validate_url(TARGET["url"], expect_host=TARGET["host"], expect_db=TARGET["db"])
    shown = []
    with pytest.raises(Refused) as exc:
        run_reset(url=url, run_record_path=str(record), confirm=owner["email"], dry_run=False,
                  expect_db=TARGET["db"], expect_server_addr=TARGET["addr"],
                  report_path=str(tmp_path / "old-report.json"), out=shown.append)
    assert exc.value.check == "path" and shown == []
    assert counts(sw_db, owner["id"])["transactions"] == 13


@pytest.mark.parametrize("edit", [False, True])
def test_an_application_clock_five_minutes_ahead(edit, tmp_path, owner, sw_db, sw_client,
                                                 monkeypatch):
    """The routers stamp updated_at with the application's clock (utc_now). Five
    minutes ahead, the loaded rows carry future timestamps, finished_at stays on
    the database clock, and reset still decides by content: a no-op passes, a
    real edit is refused."""
    import app.routers.accounts as accounts_router
    from app.core.time import utc_now
    from app.models.tag import Tag

    monkeypatch.setattr(accounts_router, "utc_now",
                        lambda: utc_now() + timedelta(minutes=5))
    _, record = load(tmp_path, fixture(), owner)
    monkeypatch.undo()
    rec = json.loads(record.read_text())
    finished = datetime.fromisoformat(rec["finished_at"])
    sw_db.rollback()
    now = sw_db.execute(text("SELECT clock_timestamp()")).scalar()
    newest = sw_db.execute(text("SELECT max(updated_at) FROM accounts WHERE user_id = :u"),
                           {"u": owner["id"]}).scalar()
    assert newest > now > finished  # future-stamped rows; finished_at on the DB clock
    assert newest - finished > timedelta(minutes=4)
    if edit:
        tag = sw_db.query(Tag).filter(Tag.user_id == owner["id"],
                                      Tag.name == "Utilities").one()
        sw_client.put(f"{API}/tags/{tag.id}", json={"name": "Bills"},
                      headers=owner["headers"])
        with pytest.raises(Exception) as exc:
            reset(record, owner["email"])
        assert getattr(exc.value, "check", None) == "changed_after_load", exc.value
    else:
        assert reset(record, owner["email"]) == 0
        assert counts(sw_db, owner["id"])["accounts"] == 0


def test_reset_runs_at_repeatable_read(tmp_path, owner, sw_db, monkeypatch):
    """One snapshot: the deletes act on the state the fingerprint was taken of."""
    from app.cutover_load import loader

    _, record = load(tmp_path, fixture(), owner)
    seen = []
    real = loader.owner_fingerprint

    def spy(db, owner_id):
        seen.append(db.execute(text("SHOW transaction_isolation")).scalar())
        return real(db, owner_id)

    monkeypatch.setattr(loader, "owner_fingerprint", spy)
    assert reset(record, owner["email"], dry_run=True) == 0
    assert seen == ["repeatable read"]


def test_reset_takes_the_lock_before_its_snapshot(tmp_path, owner):
    """The lock is the first statement of the reset's transaction: a REPEATABLE READ
    snapshot is fixed by the first statement, so nothing is read before the lock."""
    from sqlalchemy import event
    from sqlalchemy.engine import Engine

    _, record = load(tmp_path, fixture(), owner)
    statements = []

    def spy(conn, cursor, statement, parameters, context, executemany):
        statements.append(statement)

    event.listen(Engine, "before_cursor_execute", spy)
    try:
        assert reset(record, owner["email"], dry_run=True) == 0
    finally:
        event.remove(Engine, "before_cursor_execute", spy)
    lock = next(i for i, s in enumerate(statements) if "pg_try_advisory_xact_lock" in s)
    target = next(i for i, s in enumerate(statements) if "current_database()" in s)
    assert lock < target, statements[:max(lock, target) + 1]


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
            "checked_at": rec["finished_at"], "as_of": "2026-03-01",
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
    finished = datetime.fromisoformat(json.loads(record.read_text())["finished_at"])
    for name, changes in (("fail.json", {"overall": "fail"}),
                          ("early.json", {"checked_at": (finished - timedelta(seconds=1))
                                                         .isoformat()}),
                          ("undated.json", {"checked_at": None}),
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


def test_sign_off_refuses_a_check_report_not_read_on_utc(tmp_path, owner):
    """STU-315: even when the record and the report agree, a zone other than UTC
    (a load or check from before the pin) is refused."""
    from app.cutover_load.bootstrap import Refused
    from app.cutover_load.reset import sign_off

    _, record = load(tmp_path, fixture(), owner)
    assert json.loads(record.read_text())["session_timezone"] == "UTC"
    edit_record(record, session_timezone="Asia/Manila")
    report = _check_report(tmp_path, record, "manila.json")
    with pytest.raises(Refused) as exc:
        sign_off(run_record_path=str(record), check_report_path=str(report),
                 confirm=owner["email"], out=quiet)
    assert exc.value.check == "check_report" and "UTC" in exc.value.message
    assert json.loads(record.read_text())["signed_off_at"] is None


def test_sign_off_makes_no_database_connection(tmp_path, owner):
    _, record = load(tmp_path, fixture(), owner)
    good = _check_report(tmp_path, record, "good.json")
    done = run_wrapper(["--sign-off", "--run-record", str(record), "--check-report", str(good),
                        "--confirm", owner["email"]], cwd=tmp_path,
                       url="postgresql://nobody@db.invalid:1/none")
    assert done.returncode == 0, done.stdout + done.stderr
    assert "sign-off: pass" in done.stdout and "APP_IMPORTED=False" in done.stdout


# --- STU-315: the sign-off waiver ----------------------------------------------------------

MID_MONTH = "first_month starts after as_of"


def _mid_month_check(tmp_path, owner):
    """The load, then the real cutover check with the Sheet starting the month after
    ``as_of`` (a mid-month load): every block passes but the sheet, which refuses."""
    from app.cutover_check.check import dump, run
    from app.cutover_check.schema import parse_frozen

    _, record = load(tmp_path, fixture(), owner)
    frozen = {**fixture("frozen"), "owner_email": owner["email"]}
    frozen["sheet"].update(first_month="2026-04", months=["2026-04"],
                           month_end={"2026-04": "0.00"}, dated_items=[])
    report = run(make_url(TARGET["url"]), parse_frozen(frozen), expect_db=TARGET["db"],
                 expect_server_addr=TARGET["addr"])
    path = tmp_path / "check-mid-month.json"
    path.write_text(dump(report))
    return record, path, report


def _waive(record, report_path, owner, blocks=("sheet",), reason="loaded mid-month",
           out=quiet):
    from app.cutover_load.reset import sign_off

    return sign_off(run_record_path=str(record), check_report_path=str(report_path),
                    confirm=owner["email"], waive_blocks=list(blocks), waiver_reason=reason,
                    out=out)


def test_the_check_report_blocks_are_the_sign_off_set():
    from app.cutover_check.check import BLOCKS
    from app.cutover_load.reset import CHECK_BLOCKS

    assert tuple(name for name, _ in BLOCKS) == CHECK_BLOCKS


def test_a_waived_mid_month_sheet_refusal_signs_off_and_is_recorded(tmp_path, owner):
    from app.cutover_load.bootstrap import Refused
    from app.cutover_load.reset import sign_off

    record, path, report = _mid_month_check(tmp_path, owner)
    statuses = {b["name"]: b["status"] for b in report["blocks"]}
    assert report["overall"] == "fail" and report["posted_after"] == []
    assert statuses.pop("sheet") == "refused" and set(statuses.values()) == {"pass"}, report
    assert next(b for b in report["blocks"] if b["name"] == "sheet")["refused"] == MID_MONTH
    with pytest.raises(Refused):  # without the flags the rule is unchanged: overall pass
        sign_off(run_record_path=str(record), check_report_path=str(path),
                 confirm=owner["email"], out=quiet)
    lines = []
    assert _waive(record, path, owner, reason="  loaded mid-month  ", out=lines.append) == 0
    signed = json.loads(record.read_text())
    assert signed["signed_off_at"] and signed["status"] == "complete"
    assert signed["waiver"] == {"reason": "loaded mid-month", "blocks": [
        {"name": "sheet", "status": "refused", "refused": MID_MONTH}]}
    assert mode_of(record) == 0o600
    assert any("sheet" in line and MID_MONTH in line for line in lines), lines
    assert any("loaded mid-month" in line for line in lines), lines
    with pytest.raises(Refused) as exc:
        reset(record, owner["email"])
    assert exc.value.check == "signed_off"


def test_a_sign_off_without_flags_records_no_waiver(tmp_path, owner):
    from app.cutover_load.reset import sign_off

    _, record = load(tmp_path, fixture(), owner)
    before = json.loads(record.read_text())
    assert sign_off(run_record_path=str(record),
                    check_report_path=str(_check_report(tmp_path, record, "good.json")),
                    confirm=owner["email"], out=quiet) == 0
    after = json.loads(record.read_text())
    assert set(after) == set(before) and after["signed_off_at"]
    assert {k: v for k, v in after.items() if k != "signed_off_at"} == {
        k: v for k, v in before.items() if k != "signed_off_at"}


def _blocks_with(report, name, **changes):
    return [{**b, **changes} if b["name"] == name else b for b in report["blocks"]]


def test_the_waiver_refuses_anything_but_named_allowlisted_refusals(tmp_path, owner):
    from app.cutover_load.bootstrap import Refused

    record, path, report = _mid_month_check(tmp_path, owner)
    row = {"transaction_id": 1, "date": "2026-03-12", "type": "debit", "amount": "1.00",
           "account_id": 1, "posted": True, "description": "late"}
    blocks = report["blocks"]
    cases = {
        "sheet_posted_after": (_blocks_with(report, "sheet",
                                            refused="posted rows dated on or after as_of"),
                               {}, "refusal is not waivable"),
        "sheet_not_cash": (_blocks_with(report, "sheet",
                                        refused="the sheet account is not projection cash"),
                           {}, "refusal is not waivable"),
        "loans_guard": (_blocks_with(report, "loans", status="refused",
                                     refused="posted rows dated on or after as_of"),
                        {"waive": ("sheet", "loans")}, "loans block's refusal is not waivable"),
        "failed_named": (_blocks_with(report, "sheet", status="fail"), {}, "did not refuse"),
        "unnamed_non_pass": (_blocks_with(report, "recurring", status="fail"), {},
                             "recurring block did not pass"),
        "missing_block": ([b for b in blocks if b["name"] != "occurrences"], {},
                          "complete version 1 set"),
        "duplicate_block": (blocks + [blocks[0]], {}, "complete version 1 set"),
        "unknown_block": (blocks + [{"name": "extra", "status": "pass", "checked": 1,
                                     "failures": []}], {}, "complete version 1 set"),
        "unknown_status": (_blocks_with(report, "recurring", status="skipped"), {},
                           "unknown status"),
        "unknown_waived_name": (blocks, {"waive": ("sheet", "balances")},
                                "balances is not a check block"),
        "posted_after": (blocks, {"report": {"posted_after": [row]}}, "posted rows"),
        "overall_pass": (blocks, {"report": {"overall": "pass"}}, "without a waiver"),
        "no_blocks": (None, {}, "lists no blocks"),
        "list_name": (blocks + [{"name": ["sheet"], "status": "pass"}], {},
                      "complete version 1 set"),
        "list_status": (_blocks_with(report, "recurring", status=["pass"]), {},
                        "unknown status"),
    }
    for name, (case_blocks, opts, fragment) in cases.items():
        copy = tmp_path / f"check-{name}.json"
        copy.write_text(json.dumps({**report, "blocks": case_blocks, **opts.get("report", {})}))
        with pytest.raises(Refused) as exc:
            _waive(record, copy, owner, blocks=opts.get("waive", ("sheet",)))
        assert fragment in exc.value.message, (name, exc.value.message)
        assert json.loads(record.read_text())["signed_off_at"] is None, name
    for blocks_flag, reason in ((["sheet", "sheet"], "loaded mid-month"),
                                (["sheet"], None), (["sheet"], ""), (["sheet"], " \t\n "),
                                ([], "loaded mid-month")):
        with pytest.raises(Refused) as exc:
            _waive(record, path, owner, blocks=blocks_flag, reason=reason)
        assert exc.value.check == "waiver", (blocks_flag, reason)
    assert json.loads(record.read_text())["signed_off_at"] is None
    # Every existing sign-off check still applies on the waiver path.
    finished = datetime.fromisoformat(json.loads(record.read_text())["finished_at"])
    for name, changes in (("early", {"checked_at": (finished - timedelta(seconds=1))
                                     .isoformat()}),
                          ("owner", {"owner_id": owner["id"] + 1}),
                          ("db", {"database": "another_db"}),
                          ("tz", {"session_timezone": "Asia/Manila"})):
        copy = tmp_path / f"check-target-{name}.json"
        copy.write_text(json.dumps({**report, **changes}))
        with pytest.raises(Refused) as exc:
            _waive(record, copy, owner)
        assert exc.value.check == "check_report", name
    with pytest.raises(Refused) as exc:
        from app.cutover_load.reset import sign_off

        sign_off(run_record_path=str(record), check_report_path=str(path),
                 confirm="someone-else@example.com", waive_blocks=["sheet"],
                 waiver_reason="loaded mid-month", out=quiet)
    assert exc.value.check == "confirm"
    assert json.loads(record.read_text())["signed_off_at"] is None


def test_the_wrapper_signs_off_with_a_waiver_and_refuses_a_bare_reason(tmp_path, owner):
    record, path, _ = _mid_month_check(tmp_path, owner)
    bare = run_wrapper([*sign_off_args(record, path, owner["email"]),
                        "--waiver-reason", "loaded mid-month"], cwd=tmp_path)
    assert bare.returncode == 1 and "refused: waiver" in bare.stdout, bare.stdout + bare.stderr
    stray = run_wrapper(["--waive-block", "sheet", "--waiver-reason", "x", "--input", "in.json",
                         "--report", "r.json", *target_args()], cwd=tmp_path)
    assert stray.returncode == 2, stray.stdout + stray.stderr
    done = run_wrapper([*sign_off_args(record, path, owner["email"]), "--waive-block", "sheet",
                        "--waiver-reason", "loaded mid-month"], cwd=tmp_path,
                       url="postgresql://nobody@db.invalid:1/none")
    assert done.returncode == 0, done.stdout + done.stderr
    assert "APP_IMPORTED=False" in done.stdout and "waived: sheet" in done.stdout
    assert json.loads(record.read_text())["waiver"]["blocks"][0]["name"] == "sheet"


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


def test_the_fixture_balances_and_amounts_are_round_numbers():
    """Every balance and transaction amount in the fixture is a multiple of 10."""
    data = fixture()
    values = [a["balance_at_cutover"] for a in data["accounts"]]
    values += [t.get("amount") or t.get("face_amount") for t in data["transactions"]]
    assert all(D(v) % 10 == 0 for v in values if v), values


# --- End to end: the load, then the cutover check, then the sign-off -----------------------

CHECK_SCRIPT = os.path.join(BACKEND, "scripts", "cutover_check.py")


def test_the_load_and_the_check_share_one_lock_key():
    from app.cutover_check.bootstrap import CUTOVER_LOCK_KEY as check_key
    from app.cutover_load.bootstrap import CUTOVER_LOCK_KEY as load_key

    assert load_key == check_key == 2_024_020_204


def run_check(tmp_path, frozen, report):
    env = {k: v for k, v in os.environ.items()
           if not k.startswith("PG") and k not in ("SECRET_KEY", "ENVIRONMENT")}
    env["DATABASE_URL"] = TARGET["url"]
    return subprocess.run([sys.executable, "-I", CHECK_SCRIPT, "--frozen", str(frozen),
                           "--report", str(report), "--expect-host", TARGET["host"],
                           "--expect-db", TARGET["db"], "--expect-server-addr", TARGET["addr"]],
                          cwd=tmp_path, env=env, capture_output=True, text=True, timeout=300)


def sign_off_args(record, check_report, confirm):
    return ["--sign-off", "--run-record", str(record), "--check-report", str(check_report),
            "--confirm", confirm]


def test_the_load_then_the_check_then_the_sign_off_end_to_end(tmp_path, owner, sw_db):
    """Both wrappers as real subprocesses: the load, then the read-only check against
    frozen figures for the same fixture (``frozen.json``, invented round figures), then
    the sign-off with the check's own report and edited copies of it."""
    path = write_input(tmp_path, fixture(), owner)
    report, record = tmp_path / "load-report.json", tmp_path / "record.json"
    done = run_wrapper(["--input", path, "--report", str(report), "--run-record", str(record),
                        *target_args(addr=TARGET["addr"])], cwd=tmp_path)
    assert done.returncode == 0, done.stdout + done.stderr
    assert json.loads(record.read_text())["status"] == "complete"

    frozen = tmp_path / "frozen.json"
    frozen.write_text(json.dumps({**fixture("frozen"), "owner_email": owner["email"]}))
    check_report = tmp_path / "check-report.json"
    done = run_check(tmp_path, frozen, check_report)
    checked = json.loads(check_report.read_text())
    failures = {b["name"]: b["failures"] for b in checked["blocks"] if b["failures"]}
    assert done.returncode == 0 and checked["overall"] == "pass", failures
    assert all(b["checked"] > 0 for b in checked["blocks"]), checked["blocks"]
    rec = json.loads(record.read_text())
    for key in ("owner_id", "database", "server_addr", "session_timezone"):
        assert checked[key] == rec[key], key
    assert datetime.fromisoformat(checked["checked_at"]) >= datetime.fromisoformat(
        rec["finished_at"])

    def variant(name, **changes):
        copy = tmp_path / f"check-{name}.json"
        copy.write_text(json.dumps({**checked, **changes}))
        return copy

    early = (datetime.fromisoformat(rec["finished_at"]) - timedelta(seconds=1)).isoformat()
    for copy in (variant("fail", overall="fail"),
                 variant("owner", owner_id=checked["owner_id"] + 100000),
                 variant("early", checked_at=early)):
        done = run_wrapper(sign_off_args(record, copy, owner["email"]), cwd=tmp_path)
        assert done.returncode == 1, (copy.name, done.stdout + done.stderr)
        assert "refused: check_report" in done.stdout, copy.name
        assert json.loads(record.read_text())["signed_off_at"] is None, copy.name

    done = run_wrapper(sign_off_args(record, check_report, owner["email"]), cwd=tmp_path)
    assert done.returncode == 0, done.stdout + done.stderr
    assert "sign-off: pass" in done.stdout
    assert json.loads(record.read_text())["signed_off_at"]


def test_the_check_is_refused_while_a_load_holds_the_lock(tmp_path, owner):
    """A holder connection takes the load's exclusive transaction lock on the shared
    key, as ``run_load`` does; the check's shared lock is then refused."""
    from app.cutover_load.bootstrap import CUTOVER_LOCK_KEY

    frozen = tmp_path / "frozen.json"
    frozen.write_text(json.dumps({**fixture("frozen"), "owner_email": owner["email"]}))
    engine = create_engine(TARGET["url"])
    try:
        with engine.connect() as holder:
            assert holder.execute(text("SELECT pg_try_advisory_xact_lock(:k)"),
                                  {"k": CUTOVER_LOCK_KEY}).scalar() is True
            done = run_check(tmp_path, frozen, tmp_path / "check-report.json")
            holder.rollback()
    finally:
        engine.dispose()
    assert done.returncode == 2, done.stdout + done.stderr
    assert "refused: a cutover load or reset holds the lock" in done.stdout
    assert not (tmp_path / "check-report.json").exists()


def test_one_changed_input_row_fails_the_check_and_names_it(tmp_path, owner):
    """Plan v3: changing one input row makes the check fail and name that row. The
    spouse deposit on the joint account is loaded at 5100 instead of 5000; the check
    against the unchanged frozen figures fails on that account's balance only."""
    data = fixture()
    by_key(data["transactions"], "spouse_dep")["amount"] = "5100.00"
    path = write_input(tmp_path, data, owner)
    done = run_wrapper(["--input", path, "--report", str(tmp_path / "load-report.json"),
                        "--run-record", str(tmp_path / "record.json"),
                        *target_args(addr=TARGET["addr"])], cwd=tmp_path)
    assert done.returncode == 0, done.stdout + done.stderr

    frozen = tmp_path / "frozen.json"
    frozen.write_text(json.dumps({**fixture("frozen"), "owner_email": owner["email"]}))
    check_report = tmp_path / "check-report.json"
    done = run_check(tmp_path, frozen, check_report)
    assert done.returncode == 1, done.stdout + done.stderr
    assert "checkpoints: FAIL" in done.stdout and "overall: FAIL" in done.stdout
    checked = json.loads(check_report.read_text())
    assert checked["overall"] == "fail"
    failing = {b["name"]: b["failures"] for b in checked["blocks"] if b["status"] != "pass"}
    assert list(failing) == ["checkpoints"], failing
    assert failing["checkpoints"] == [{
        "message": "balance differs", "account": "Joint Bank (savings, PHP)",
        "date": "2026-03-09", "point": "end_of_day", "expected": "25000.00",
        "actual": "25100.00", "difference": "100.00"}]
