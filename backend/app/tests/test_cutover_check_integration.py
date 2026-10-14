"""The read-only cutover check (STU-204, plan v3 §2.5, tests §2.6 C3 1-9).

State is built through the app's own write paths (the HTTP API and the shared
``sw_`` fixtures), never through the cutover loader. Every figure is invented.
"""
import copy
import json
import os
import stat

import pytest

from app.cutover_check import bootstrap, schema

DATA = os.path.join(os.path.dirname(__file__), "data", "cutover_check")


def frozen_base() -> dict:
    with open(os.path.join(DATA, "frozen_base.json"), encoding="utf-8") as handle:
        return json.load(handle)


def refused(raw: dict, fragment: str) -> None:
    with pytest.raises(schema.FrozenError) as caught:
        schema.parse_frozen(raw)
    assert fragment in str(caught.value), str(caught.value)


# --- Schema (cutover-frozen v1) ----------------------------------------------------------------

def test_schema_accepts_the_base_fixture():
    frozen = schema.parse_frozen(frozen_base())
    assert frozen.as_of.isoformat() == "2031-03-10"
    assert str(frozen.card_statements[0].owed) == "600.00"


def test_schema_refuses_an_unknown_version():
    raw = frozen_base()
    raw["schema_version"] = 777
    refused(raw, "unknown schema_version")
    with pytest.raises(schema.FrozenError) as caught:
        schema.parse_frozen(raw)
    assert "777" not in str(caught.value)


SENTINEL_FIGURE = "987654.321"
SENTINEL_NAME = "Zanzibar Sentinel"


def sentinel_frozen() -> dict:
    """A frozen file whose errors would carry a figure, names and keys if echoed."""
    raw = frozen_base()
    raw["card_statements"][0]["owed"] = SENTINEL_FIGURE
    raw["card_statements"][0]["card"]["name"] = SENTINEL_NAME
    raw["recurring"][0]["name"] = SENTINEL_NAME
    raw["recurring"][0]["semi_monthly_days"] = [1, 15]
    raw["checkpoints"][0]["balances"].append(copy.deepcopy(raw["checkpoints"][0]["balances"][0]))
    raw["checkpoints"][0]["balances"][0]["account"]["name"] = SENTINEL_NAME
    raw["checkpoints"][0]["balances"][1]["account"]["name"] = SENTINEL_NAME
    raw["sheet"]["month_end"]["2031-07"] = SENTINEL_FIGURE
    raw["loans"][0][SENTINEL_NAME] = SENTINEL_FIGURE
    return raw


def test_schema_errors_carry_no_figures_names_or_keys():
    with pytest.raises(schema.FrozenError) as caught:
        schema.parse_frozen(sentinel_frozen())
    text = str(caught.value)
    assert "card_statements.0.owed" in text and "at most 2 places" in text, text
    assert "Extra inputs are not permitted" in text, text
    for leaked in (SENTINEL_FIGURE, "987654", SENTINEL_NAME, "2031-07", "input_value"):
        assert leaked not in text, (leaked, text)


def test_schema_refuses_unknown_keys():
    raw = frozen_base()
    raw["loans"][0]["surprise"] = 1
    refused(raw, "Extra inputs are not permitted")


def test_schema_refuses_money_finer_than_a_cent_or_not_a_string():
    raw = frozen_base()
    raw["card_statements"][0]["owed"] = "600.001"
    refused(raw, "at most 2 places")
    raw = frozen_base()
    raw["card_statements"][0]["owed"] = 600
    refused(raw, "decimal string")


def test_schema_refuses_a_duplicate_recurring_triple():
    raw = frozen_base()
    raw["recurring"].append(copy.deepcopy(raw["recurring"][0]))
    refused(raw, "unique by (name, account, destination)")


def test_schema_refuses_a_first_month_before_the_cutover():
    raw = frozen_base()
    raw["cutover_date"] = "2031-03-02"
    refused(raw, "first_month must start on or after cutover_date")


def test_schema_refuses_month_end_that_does_not_match_the_months():
    raw = frozen_base()
    del raw["sheet"]["month_end"]["2031-05"]
    refused(raw, "month_end must hold exactly")


def test_schema_refuses_more_than_three_loan_rows():
    raw = frozen_base()
    raw["loans"][0]["next_rows"].append({"due_date": "2031-07-20", "payment": "5000.00"})
    refused(raw, "first 3")


def test_schema_refuses_installment_without_after_occurrences():
    raw = frozen_base()
    raw["recurring"][0]["installment"] = {"n": 1, "m": 2}
    refused(raw, "installment goes with end_mode after_occurrences")


def test_schema_refuses_gaps_in_expected_months():
    raw = frozen_base()
    raw["recurring"][0]["expected"] = {"2031-03": 1, "2031-05": 1}
    refused(raw, "contiguous")


def test_schema_refuses_a_sheet_currency_other_than_its_account():
    raw = frozen_base()
    raw["sheet"]["currency"] = "USD"
    refused(raw, "sheet.currency must be the sheet account's currency")


@pytest.mark.parametrize("value", ["2031-03-10\n", "\u0662\u0660\u0663\u0661-03-10",
                                   "2031-02-30"])
def test_schema_date_errors_never_echo_the_input(value):
    raw = frozen_base()
    raw["as_of"] = value
    with pytest.raises(schema.FrozenError) as caught:
        schema.parse_frozen(raw)
    text = str(caught.value)
    assert "as_of: " in text and "YYYY-MM-DD" in text, text
    for leaked in (value, value.strip(), "isoformat", "\u0662"):
        assert leaked not in text, (leaked, text)


def test_schema_refuses_a_zero_dated_item():
    raw = frozen_base()
    raw["sheet"]["dated_items"][0]["amount"] = "0.00"
    refused(raw, "dated item amount cannot be zero")


# --- Bootstrap: URL validation (no connection) -------------------------------------------------

LOCAL = "postgresql://u:secret@127.0.0.1:5432/c3db"


def test_url_validation_accepts_a_plain_url_and_sslmode_prefer():
    assert bootstrap.validate_url(LOCAL, "127.0.0.1", "c3db", {}).host == "127.0.0.1"
    url = bootstrap.validate_url(LOCAL + "?sslmode=prefer", "127.0.0.1", "c3db", {})
    assert url.query["sslmode"] == "prefer"


@pytest.mark.parametrize("raw, fragment", [
    (LOCAL + "?host=10.0.0.9", "query key 'host' is not allowed"),
    (LOCAL + "?hostaddr=10.0.0.9", "query key 'hostaddr' is not allowed"),
    (LOCAL + "?port=6543", "query key 'port' is not allowed"),
    (LOCAL + "?dbname=other", "query key 'dbname' is not allowed"),
    (LOCAL + "?service=prod", "query key 'service' is not allowed"),
    (LOCAL + "?options=-csearch_path%3Dx", "query key 'options' is not allowed"),
    (LOCAL + "?sslmode=require&sslmode=disable", "query key 'sslmode' is repeated"),
    ("mysql://u:secret@127.0.0.1/c3db", "driver"),
    ("postgresql+asyncpg://u:secret@127.0.0.1/c3db", "driver"),
    ("postgresql://u:secret@/c3db", "exactly one host"),
    ("postgresql://u:secret@127.0.0.1:5432/other", "is not --expect-db"),
    ("postgresql://u:secret@10.1.1.1:5432/c3db", "is not --expect-host"),
])
def test_url_validation_refuses_target_overrides(raw, fragment):
    with pytest.raises(bootstrap.BootstrapError) as caught:
        bootstrap.validate_url(raw, "127.0.0.1", "c3db", {})
    assert fragment in str(caught.value)
    assert "secret" not in str(caught.value)


@pytest.mark.parametrize("name", bootstrap.FORBIDDEN_ENV)
def test_url_validation_refuses_libpq_environment_overrides(name):
    with pytest.raises(bootstrap.BootstrapError) as caught:
        bootstrap.validate_url(LOCAL, "127.0.0.1", "c3db", {name: "10.0.0.9"})
    assert name in str(caught.value)


def test_url_validation_refuses_pgtz():
    # PGTZ would set the server session's TimeZone, which dates are read in.
    with pytest.raises(bootstrap.BootstrapError, match="PGTZ is set"):
        bootstrap.validate_url(LOCAL, "127.0.0.1", "c3db", {"PGTZ": "America/New_York"})


def test_url_validation_refuses_a_missing_url():
    with pytest.raises(bootstrap.BootstrapError, match="DATABASE_URL is not set"):
        bootstrap.validate_url("", "127.0.0.1", "c3db", {})


# --- Bootstrap: output and input paths --------------------------------------------------------

def test_paths_inside_the_repo_are_refused_even_through_a_symlink(tmp_path):
    root = bootstrap.repo_root()
    with pytest.raises(bootstrap.BootstrapError, match="outside the repository"):
        bootstrap.require_outside_repo(os.path.join(root, "backend", "report.json"), "report")
    link = tmp_path / "into-repo"
    link.symlink_to(os.path.join(root, "backend"))
    with pytest.raises(bootstrap.BootstrapError, match="outside the repository"):
        bootstrap.require_outside_repo(str(link / "report.json"), "report")
    outside = bootstrap.require_outside_repo(str(tmp_path / "report.json"), "report")
    assert outside == os.path.realpath(tmp_path / "report.json")


def test_relative_paths_resolve_against_the_original_directory(tmp_path):
    resolved = bootstrap.absolute("out/report.json", cwd=str(tmp_path))
    assert resolved == os.path.realpath(tmp_path / "out" / "report.json")


def test_private_files_are_0600_and_never_replaced(tmp_path):
    path = str(tmp_path / "report.json")
    bootstrap.create_private(path, "{}")
    assert stat.S_IMODE(os.stat(path).st_mode) == 0o600
    with pytest.raises(FileExistsError):
        bootstrap.create_private(path, "{}")


# --- Database tests: skip gate --------------------------------------------------------------

def _gate() -> str:
    """Why the database tests must skip, or "" when they may run.

    The effective settings URL must be the exported one and pass the bootstrap's
    validation with a loopback host. After connecting, the server address must be
    loopback, or a private address: Docker port publishing (the local container
    and the CI service) reports the container's bridge address, never 127.0.0.1.
    """
    import ipaddress

    from sqlalchemy import create_engine, text
    from sqlalchemy.engine.url import make_url

    url = os.getenv("DATABASE_URL", "")
    if not url:
        return "no DATABASE_URL"
    from app.core.config import settings

    if settings.DATABASE_URL != url:
        return "the effective settings URL is not the exported DATABASE_URL"
    try:
        parsed = make_url(url)
        bootstrap.validate_url(url, parsed.host or "", parsed.database or "", os.environ)
    except Exception as exc:
        return f"DATABASE_URL fails the bootstrap rules: {exc}"
    if parsed.host not in ("localhost", "127.0.0.1", "::1"):
        return "DATABASE_URL host is not loopback"
    try:
        engine = create_engine(url)
        with engine.connect() as conn:
            addr = conn.execute(text("SELECT host(inet_server_addr())")).scalar()
        engine.dispose()
    except Exception:
        return "database unreachable"
    if addr is None:
        return "connected over a Unix socket"
    ip = ipaddress.ip_address(addr)
    if not (ip.is_loopback or ip.is_private):
        return f"server address {addr} is not local"
    return ""


GATE = _gate()
needs_db = pytest.mark.skipif(bool(GATE), reason=GATE or "database available")


@pytest.fixture(scope="module")
def target():
    """``(url, database, server address)`` of the test database, as the server reports them."""
    from sqlalchemy import create_engine, text
    from sqlalchemy.engine.url import make_url

    url = make_url(os.environ["DATABASE_URL"])
    engine = create_engine(url)
    with engine.connect() as conn:
        database, addr = conn.execute(
            text("SELECT current_database(), host(inet_server_addr())")).one()
    engine.dispose()
    return url, database, addr


def run_check(target, raw: dict, blocks=None) -> dict:
    from app.cutover_check import check

    url, database, addr = target
    return check.run(url, schema.parse_frozen(raw), expect_db=database,
                     expect_server_addr=addr, blocks=blocks)


def block(report: dict, name: str) -> dict:
    return next(b for b in report["blocks"] if b["name"] == name)


def messages(report: dict, name: str) -> list:
    return [f["message"] for f in block(report, name)["failures"]]


# --- The base world: the frozen_base.json fixture, built through the API ----------------------

def day(d: str) -> str:
    return f"{d}T00:00:00"


def txn(client, who, body):
    from app.tests.conftest import sw_post

    return sw_post(client, who, "/transactions/", body)["id"]


def build_world(client, people) -> dict:
    """Owner O with the accounts, rows and recurring entries frozen_base.json describes."""
    from app.tests.conftest import sw_post

    o = people("Owen", "Owner")
    post = lambda path, body: sw_post(client, o, path, body)  # noqa: E731
    bank = post("/accounts/", {"name": "Main bank", "account_type": "checking",
                               "balance": 50000})["id"]
    second = post("/accounts/", {"name": "Second bank", "account_type": "savings",
                                 "balance": 20000})["id"]
    card = post("/accounts/", {"name": "Main card", "account_type": "credit", "balance": 0,
                               "billing_cycle_start": 15, "days_until_due_date": 20,
                               "payment_account_id": bank,
                               "payment_overflow_account_id": second})["id"]
    loan = post("/accounts/", {"name": "Car loan", "account_type": "loan", "loan_kind": "auto",
                               "balance": -100000, "loan_annual_rate": 12,
                               "loan_term_months": 24, "loan_payment_amount": 5000,
                               "loan_first_payment_date": "2031-01-20",
                               "loan_payments_made_offset": 2,
                               "payment_account_id": bank})["id"]
    wallet = post("/accounts/", {"name": "Pocket wallet", "account_type": "cash",
                                 "balance": 1000, "is_spending_wallet": True})["id"]
    usd = post("/accounts/", {"name": "Dollar savings", "account_type": "savings",
                              "currency": "USD", "balance": 1000})["id"]

    def debit(account, amount, when, desc, kind="debit", posted=True):
        return txn(client, o, {"account_id": account, "amount": amount, "currency": "PHP",
                               "transaction_type": kind, "transaction_date": day(when),
                               "description": desc, "is_posted": posted})

    def transfer(src, dst, amount, when, desc, fee=0, posted=True, **extra):
        return txn(client, o, {"account_id": src, "transfer_from_account_id": src,
                               "transfer_to_account_id": dst, "amount": amount,
                               "transfer_fee": fee, "transaction_type": "transfer",
                               "transaction_date": day(when), "description": desc,
                               "is_posted": posted, **extra})

    rows = {
        "groceries": debit(card, 1000, "2031-02-10", "Groceries"),
        "fuel": debit(card, 600, "2031-02-20", "Fuel"),
        "card_payment": transfer(bank, card, 400, "2031-02-25", "Card payment"),
        "refund": debit(bank, 5000, "2031-03-01", "Refund", kind="credit"),
        "loan_payment": transfer(bank, loan, 4000, "2031-03-05", "Loan payment", fee=1000),
        "hardware": debit(bank, 1000, "2031-03-05", "Hardware store"),
        "move": transfer(bank, second, 2000, "2031-03-08", "Move to savings"),
    }

    def entry(body):
        return post("/budget-entries/", {"currency": "PHP", "cadence": "monthly", **body})["id"]

    entries = {
        "salary": entry({"name": "Salary", "entry_type": "income", "amount": 30000,
                         "account_id": bank, "next_occurrence": day("2031-03-25")}),
        "utilities": entry({"name": "Utilities", "entry_type": "expense", "amount": 2000,
                            "account_id": bank, "overflow_account_id": second,
                            "is_autopay": True, "next_occurrence": day("2031-03-20")}),
        "loan": entry({"name": "Car loan payment", "entry_type": "expense", "amount": 5000,
                       "account_id": bank, "transfer_to_account_id": loan,
                       "next_occurrence": day("2031-04-20")}),
        "phone": entry({"name": "Phone plan", "entry_type": "expense", "amount": 1000,
                        "account_id": card, "end_mode": "after_occurrences",
                        "max_occurrences": 4, "occurrences_paid_offset": 2,
                        "next_occurrence": day("2031-03-20")}),
        "snacks": entry({"name": "Snacks", "entry_type": "expense", "amount": 500,
                         "account_id": wallet, "next_occurrence": day("2031-03-15")}),
    }
    return {"o": o, "bank": bank, "second": second, "card": card, "loan": loan,
            "wallet": wallet, "usd": usd, "rows": rows, "entries": entries,
            "debit": debit, "transfer": transfer, "post": post}


def owner_frozen(world) -> dict:
    raw = frozen_base()
    raw["owner_email"] = world["o"]["email"]
    return raw


def sel(name, account_type, currency="PHP") -> dict:
    return {"name": name, "account_type": account_type, "currency": currency}


@pytest.fixture
def world(sw_client, sw_people):
    return build_world(sw_client, sw_people)


# --- 1. Pass case ---------------------------------------------------------------------------

@needs_db
def test_pass_case(world, target):
    report = run_check(target, owner_frozen(world))
    failing = [b for b in report["blocks"] if b["status"] != "pass"]
    assert failing == [], failing
    assert report["overall"] == "pass"
    assert report["owner_id"] == world["o"]["id"]
    assert (report["database"], report["server_addr"]) == target[1:]
    assert all(b["checked"] > 0 for b in report["blocks"]), report["blocks"]


# --- 2. Each check fails with a precise diff (balances, statements) ----------------------------

@needs_db
def test_a_balance_off_by_a_centavo_fails_with_the_difference(world, target):
    raw = owner_frozen(world)
    raw["checkpoints"][0]["balances"][0]["amount"] = "49600.01"
    report = run_check(target, raw)
    assert report["overall"] == "fail"
    [failure] = block(report, "checkpoints")["failures"]
    assert failure == {"message": "balance differs", "account": "Main bank (checking, PHP)",
                       "date": "2031-03-01", "point": "start_of_day", "expected": "49600.01",
                       "actual": "49600.00", "difference": "-0.01"}


@needs_db
def test_a_missing_and_an_extra_statement_row_are_named(world, target):
    raw = owner_frozen(world)
    raw["card_statements"][1]["close"] = "2031-03-16"
    failures = block(run_check(target, raw), "card_statements")["failures"]
    assert [(f["message"], f["close"]) for f in failures] == [
        ("frozen statement missing from the app", "2031-03-16"),
        ("app statement not in the frozen file", "2031-03-15"),
    ]
    assert failures[1]["owed"] == "600.00"


@needs_db
def test_a_wrong_due_date_fails(world, target):
    raw = owner_frozen(world)
    raw["card_statements"][0]["due"] = "2031-03-08"
    [failure] = block(run_check(target, raw), "card_statements")["failures"]
    assert failure["message"] == "statement due differs"
    assert (failure["expected"], failure["actual"]) == ("2031-03-08", "2031-03-07")


@needs_db
def test_an_unknown_selector_fails_instead_of_being_skipped(world, target):
    raw = owner_frozen(world)
    raw["checkpoints"][0]["balances"][0]["account"]["name"] = "No such bank"
    assert messages(run_check(target, raw), "checkpoints") == [
        "checkpoint 2031-03-01 start_of_day: selector matches 0 owner accounts"]


@needs_db
def test_a_posted_row_in_another_currency_fails_the_foreign_invariants(world, target, sw_db):
    from app.models.transaction import Transaction

    sw_db.query(Transaction).filter(Transaction.id == world["rows"]["hardware"]).update(
        {"currency": "USD"})
    sw_db.commit()
    [failure] = block(run_check(target, owner_frozen(world)), "foreign_invariants")["failures"]
    assert failure["message"] == "posted row not in its account's currency"
    assert failure["transaction_id"] == world["rows"]["hardware"]


# --- 3. Statements as of T ------------------------------------------------------------------

def history_as_of(db, card_id, owner_id, T):
    from datetime import timedelta

    from app.core.access import viewable_account_ids
    from app.models.account import Account
    from app.services.statements import statement_history

    card = db.get(Account, card_id)
    return statement_history(db, card, T - timedelta(days=1), viewable_account_ids(db, owner_id))


@needs_db
def test_statements_match_statement_history_when_nothing_is_excluded(world, target, sw_db):
    from datetime import datetime

    from app.cutover_check.statements import compared_set, computed_cycles
    from app.models.account import Account

    T = datetime(2031, 3, 10)
    card = sw_db.get(Account, world["card"])
    ours = compared_set(computed_cycles(sw_db, card, world["o"]["id"], T))
    theirs = history_as_of(sw_db, world["card"], world["o"]["id"], T)
    assert [(c["close"], c["due"], c["balance"], c["owed"]) for c in ours] == [
        (h["close"].date(), h["due"].date(), h["balance"], h["owed"]) for h in theirs]
    assert len(ours) == 2


@needs_db
@pytest.mark.parametrize("kind", ["pending_charge", "planned_payment", "posted_payment_after"])
def test_rows_outside_the_as_of_view_are_excluded(world, target, sw_db, kind):
    from datetime import datetime

    if kind == "pending_charge":
        world["debit"](world["card"], 300, "2031-03-05", "Pending charge", posted=False)
    elif kind == "planned_payment":
        world["transfer"](world["bank"], world["card"], 200, "2031-03-12", "Planned",
                          posted=False)
    else:
        world["transfer"](world["bank"], world["card"], 600, "2031-03-12", "Paid late")
    raw = owner_frozen(world)
    assert block(run_check(target, raw), "card_statements")["status"] == "pass"
    # The unfiltered statement history does see the row: the exclusion matters.
    theirs = history_as_of(sw_db, world["card"], world["o"]["id"], datetime(2031, 3, 10))
    assert [(h["balance"], h["owed"]) for h in theirs][:2] != [(1000, 600), (600, 600)]


@needs_db
def test_paid_historical_cycles_are_left_out_of_the_compared_set(world, target, sw_db):
    from datetime import datetime

    from app.cutover_check.statements import compared_set, computed_cycles
    from app.models.account import Account

    world["debit"](world["card"], 500, "2031-01-05", "Old charge")
    world["transfer"](world["bank"], world["card"], 500, "2031-01-20", "Old payment")
    cycles = computed_cycles(sw_db, sw_db.get(Account, world["card"]), world["o"]["id"],
                             datetime(2031, 3, 10))
    assert [str(c["close"]) for c in cycles] == ["2031-01-15", "2031-02-15", "2031-03-15"]
    assert [str(c["close"]) for c in compared_set(cycles)] == ["2031-02-15", "2031-03-15"]
    assert block(run_check(target, owner_frozen(world)), "card_statements")["status"] == "pass"


@needs_db
def test_an_unused_card_yields_an_empty_set(world, target):
    world["post"]("/accounts/", {"name": "Spare card", "account_type": "credit", "balance": 0,
                                 "billing_cycle_start": 5, "payment_account_id": world["bank"]})
    statements = block(run_check(target, owner_frozen(world)), "card_statements")
    assert statements["status"] == "pass"


@needs_db
def test_a_payment_from_a_card_without_cycle_settings_does_not_net(world, target):
    other = world["post"]("/accounts/", {"name": "Unbilled card", "account_type": "credit",
                                         "balance": 0})["id"]
    world["transfer"](other, world["card"], 300, "2031-03-02", "Balance move")
    assert block(run_check(target, owner_frozen(world)), "card_statements")["status"] == "pass"


# --- 7. Boundaries and currency -------------------------------------------------------------

@needs_db
@pytest.mark.parametrize("as_of", ["2031-03-03", "2031-03-10"])
def test_a_row_at_midnight_is_excluded_at_start_and_included_at_end_of_day(world, target, as_of):
    raw = owner_frozen(world)
    raw["as_of"] = as_of
    raw["sheet"]["dated_items"] = []
    bank = sel("Main bank", "checking")
    raw["checkpoints"] = [
        {"date": "2031-03-05", "point": "start_of_day",
         "balances": [{"account": bank, "amount": "54600.00"}]},
        {"date": "2031-03-05", "point": "end_of_day",
         "balances": [{"account": bank, "amount": "48600.00"}]},
    ]
    assert block(run_check(target, raw), "checkpoints")["status"] == "pass"


@needs_db
def test_a_cross_currency_transfer_with_a_fee_moves_each_side_by_its_own_figure(world, target):
    world["transfer"](world["usd"], world["bank"], 100, "2031-03-06", "Convert", fee=5,
                      received_amount=5000)
    raw = owner_frozen(world)
    usd, bank = sel("Dollar savings", "savings", "USD"), sel("Main bank", "checking")
    raw["checkpoints"] = [
        {"date": "2031-03-06", "point": "start_of_day",
         "balances": [{"account": usd, "amount": "1000.00"},
                      {"account": bank, "amount": "48600.00"}]},
        {"date": "2031-03-06", "point": "end_of_day",
         "balances": [{"account": usd, "amount": "895.00"},
                      {"account": bank, "amount": "53600.00"}]},
    ]
    report = run_check(target, raw)
    assert block(report, "checkpoints")["status"] == "pass"
    assert block(report, "foreign_invariants")["status"] == "pass"


# --- 8. Read-only and isolation -------------------------------------------------------------

@needs_db
def test_the_session_is_read_only_repeatable_read_even_after_an_internal_commit(target):
    from sqlalchemy import text
    from sqlalchemy.exc import DBAPIError

    from app.cutover_check import check

    url, database, addr = target
    with check.readonly_session(url, database, addr) as (db, _, _):
        assert db.execute(text("SHOW transaction_isolation")).scalar() == "repeatable read"
        assert db.execute(text("SHOW transaction_read_only")).scalar() == "on"
        assert db.execute(text("SHOW default_transaction_read_only")).scalar() == "on"
        db.commit()  # releases a savepoint only: the snapshot and its mode stay
        assert db.execute(text("SHOW transaction_read_only")).scalar() == "on"
        with pytest.raises(DBAPIError) as caught:
            db.execute(text("UPDATE users SET first_name = first_name"))
        assert "read-only transaction" in str(caught.value.orig)
    with check.readonly_session(url, database, addr) as (db, _, _):
        from app.models.category import Category

        db.add(Category(user_id=1, name="never"))
        with pytest.raises(DBAPIError) as caught:
            db.commit()
        assert "read-only transaction" in str(caught.value.orig)


@needs_db
def test_the_shared_lock_refuses_while_a_load_holds_it(target):
    from sqlalchemy import create_engine, text

    from app.cutover_check import check
    from app.cutover_check.bootstrap import CUTOVER_LOCK_KEY

    url, database, addr = target
    engine = create_engine(url)
    with engine.connect() as holder:
        with holder.begin():
            holder.execute(text("SELECT pg_advisory_xact_lock(:k)"), {"k": CUTOVER_LOCK_KEY})
            with pytest.raises(check.CheckRefused, match="holds the lock"):
                with check.readonly_session(url, database, addr):
                    pass
    engine.dispose()
    with check.readonly_session(url, database, addr):
        pass  # free again once the load's transaction ends


@needs_db
def test_the_shared_lock_blocks_a_load_until_the_check_ends(target):
    from sqlalchemy import create_engine, text

    from app.cutover_check import check
    from app.cutover_check.bootstrap import CUTOVER_LOCK_KEY

    url, database, addr = target
    engine = create_engine(url)
    try:
        with check.readonly_session(url, database, addr):
            with engine.connect() as load:
                with load.begin():
                    assert load.execute(text("SELECT pg_try_advisory_xact_lock(:k)"),
                                        {"k": CUTOVER_LOCK_KEY}).scalar() is False
                assert load.execute(text("SELECT pg_try_advisory_lock(:k)"),
                                    {"k": CUTOVER_LOCK_KEY}).scalar() is False
                load.rollback()
        with engine.connect() as load:
            with load.begin():
                assert load.execute(text("SELECT pg_try_advisory_xact_lock(:k)"),
                                    {"k": CUTOVER_LOCK_KEY}).scalar() is True
    finally:
        engine.dispose()


@needs_db
def test_the_lock_is_taken_before_the_snapshot(target, sw_people, monkeypatch):
    """A change committed before the lock is granted is in the snapshot: the
    snapshot cannot predate the lock."""
    from sqlalchemy import create_engine, text

    from app.cutover_check import check

    url, database, addr = target
    who = sw_people("Lars", "Lock")
    writer = create_engine(url)
    real = check.verify_target

    def verify_then_write(conn, *args):
        observed = real(conn, *args)
        with writer.begin() as w:  # lands after the target check, before the lock
            w.execute(text("UPDATE users SET first_name = 'Marker' WHERE id = :id"),
                      {"id": who["id"]})
        return observed

    monkeypatch.setattr(check, "verify_target", verify_then_write)
    try:
        with check.readonly_session(url, database, addr) as (db, _, _):
            seen = db.execute(text("SELECT first_name FROM users WHERE id = :id"),
                              {"id": who["id"]}).scalar()
    finally:
        writer.dispose()
    assert seen == "Marker"


@needs_db
def test_the_fx_provider_is_never_reached(world, target, monkeypatch):
    from app.services import fx

    def boom(*_a, **_k):
        raise AssertionError("the exchange-rate provider was reached")

    monkeypatch.setattr(fx.CurrencyApiProvider, "fetch", boom)
    monkeypatch.setattr(fx._refresher, "provider", fx.CurrencyApiProvider())
    built = []
    real = fx._offline_factory
    monkeypatch.setattr(fx, "_offline_factory", lambda db: built.append(db) or real(db))
    world["transfer"](world["usd"], world["bank"], 100, "2031-03-06", "Convert",
                      received_amount=5000)
    world["debit"](world["card"], 50, "2031-03-06", "Pending abroad", posted=False)
    run_check(target, owner_frozen(world))
    assert built, "the check builds its rates with FxRates.offline"


def test_the_check_imports_nothing_from_the_loader():
    import ast
    import subprocess
    import sys

    package = os.path.join(os.path.dirname(os.path.dirname(__file__)), "cutover_check")
    for name in sorted(os.listdir(package)):
        if not name.endswith(".py"):
            continue
        with open(os.path.join(package, name), encoding="utf-8") as handle:
            tree = ast.parse(handle.read())
        for node in ast.walk(tree):
            names = ([a.name for a in node.names] if isinstance(node, ast.Import)
                     else [node.module or ""] if isinstance(node, ast.ImportFrom) else [])
            assert not any("cutover_load" in n for n in names), (name, names)
    probe = ("import sys, pkgutil, importlib, app.cutover_check as p\n"
             "for m in pkgutil.iter_modules(p.__path__):\n"
             "    importlib.import_module('app.cutover_check.' + m.name)\n"
             "bad = [m for m in sys.modules if m.startswith('app.cutover_load') or m == 'app.main']\n"
             "print('BAD', bad)\n")
    env = {**os.environ, "DATABASE_URL": "postgresql://u:p@127.0.0.1:1/none"}
    out = subprocess.run([sys.executable, "-c", probe], cwd=os.path.dirname(os.path.dirname(package)),
                         env=env, capture_output=True, text=True, timeout=60)
    assert out.returncode == 0, out.stderr
    assert "BAD []" in out.stdout


# --- 9. Hermetic wrapper, target pinning and output paths -------------------------------------

WRAPPER = os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(__file__))),
                       "scripts", "cutover_check.py")


def run_wrapper(args, cwd, env_url=None, extra_env=None, probe=False):
    """The wrapper as a subprocess; ``probe`` also reports whether app settings were imported."""
    import subprocess
    import sys

    env = {k: v for k, v in os.environ.items() if not k.startswith("PG")}
    env["DATABASE_URL"] = env_url or os.environ.get("DATABASE_URL", "")
    env.update(extra_env or {})
    if probe:
        code = ("import runpy, sys\n"
                f"sys.argv = {[WRAPPER, *args]!r}\n"
                "try:\n"
                f"    runpy.run_path({WRAPPER!r}, run_name='__main__')\n"
                "except SystemExit as e:\n"
                "    print('EXIT', e.code)\n"
                "print('APP_SETTINGS_IMPORTED', 'app.core.config' in sys.modules)\n")
        cmd = [sys.executable, "-c", code]
    else:
        cmd = [sys.executable, WRAPPER, *args]
    return subprocess.run(cmd, cwd=cwd, env=env, capture_output=True, text=True, timeout=120)


def wrapper_args(target, frozen_path, report_path, **override):
    url, database, addr = target
    values = {"--frozen": frozen_path, "--report": report_path, "--expect-host": url.host,
              "--expect-db": database, "--expect-server-addr": addr}
    values.update({f"--{k.replace('_', '-')}": v for k, v in override.items()})
    return [part for pair in values.items() for part in pair]


def write_frozen(tmp_path, raw) -> str:
    path = tmp_path / "frozen.json"
    path.write_text(json.dumps(raw))
    return str(path)


@needs_db
def test_wrapper_ignores_a_dotenv_and_writes_a_private_report(world, target, tmp_path):
    (tmp_path / ".env").write_text(
        "DATABASE_URL=postgresql://x:y@conflict.invalid:5432/elsewhere\n")
    (tmp_path / "out").mkdir()
    frozen = write_frozen(tmp_path, owner_frozen(world))
    out = run_wrapper(wrapper_args(target, "frozen.json", "out/report.json"), cwd=str(tmp_path))
    assert out.returncode == 0, out.stdout + out.stderr
    assert f"target: host={target[0].host} db={target[1]}" in out.stdout
    assert "conflict.invalid" not in out.stdout
    assert target[0].password not in out.stdout + out.stderr
    report_path = tmp_path / "out" / "report.json"  # relative to where it was run
    assert stat.S_IMODE(os.stat(report_path).st_mode) == 0o600
    report = json.loads(report_path.read_text())
    assert (report["overall"], report["owner_id"]) == ("pass", world["o"]["id"])
    assert (report["database"], report["server_addr"]) == target[1:]
    assert report["frozen_sha256"]
    assert out.stdout.strip().splitlines()[-1] == "overall: PASS"
    assert os.path.exists(frozen)


@needs_db
def test_wrapper_exits_1_on_a_failing_check(world, target, tmp_path):
    raw = owner_frozen(world)
    raw["checkpoints"][0]["balances"][0]["amount"] = "1.00"
    frozen = write_frozen(tmp_path, raw)
    out = run_wrapper(wrapper_args(target, frozen, str(tmp_path / "r.json")), cwd=str(tmp_path))
    assert out.returncode == 1, out.stdout + out.stderr
    assert "checkpoints: FAIL" in out.stdout
    assert "49600" not in out.stdout  # figures stay in the private report
    assert json.loads((tmp_path / "r.json").read_text())["overall"] == "fail"


@needs_db
def test_wrapper_accepts_sslmode_prefer(world, target, tmp_path):
    frozen = write_frozen(tmp_path, owner_frozen(world))
    url = target[0].render_as_string(hide_password=False) + "?sslmode=prefer"
    out = run_wrapper(wrapper_args(target, frozen, str(tmp_path / "r.json")),
                      cwd=str(tmp_path), env_url=url)
    assert out.returncode == 0, out.stdout + out.stderr


@needs_db
def test_wrapper_refuses_a_server_address_mismatch_after_connecting(world, target, tmp_path):
    frozen = write_frozen(tmp_path, owner_frozen(world))
    out = run_wrapper(wrapper_args(target, frozen, str(tmp_path / "r.json"),
                                   expect_server_addr="192.0.2.1"), cwd=str(tmp_path))
    assert out.returncode == 2
    assert "is not --expect-server-addr 192.0.2.1" in out.stdout
    assert "target: host=" in out.stdout  # it got as far as connecting
    assert not (tmp_path / "r.json").exists()


def test_wrapper_refuses_an_expect_host_mismatch_before_connecting(tmp_path):
    # Nothing listens on port 1: a connection attempt would surface as a driver error.
    out = run_wrapper(["--frozen", str(tmp_path / "f.json"), "--report", str(tmp_path / "r.json"),
                       "--expect-host", "db.example.com", "--expect-db", "c3db",
                       "--expect-server-addr", "192.0.2.1"],
                      cwd=str(tmp_path), env_url="postgresql://u:pw@127.0.0.1:1/c3db")
    assert out.returncode == 2
    assert "is not --expect-host 'db.example.com'" in out.stdout
    assert "target:" not in out.stdout


def test_wrapper_never_prints_frozen_figures_or_names(tmp_path):
    # The frozen file is refused before connecting: nothing listens on port 1.
    frozen = write_frozen(tmp_path, sentinel_frozen())
    out = run_wrapper(["--frozen", frozen, "--report", str(tmp_path / "r.json"),
                       "--expect-host", "127.0.0.1", "--expect-db", "c3db",
                       "--expect-server-addr", "192.0.2.1"],
                      cwd=str(tmp_path), env_url="postgresql://u:pw@127.0.0.1:1/c3db")
    assert out.returncode == 2, out.stdout + out.stderr
    assert "frozen file is invalid" in out.stdout
    for leaked in (SENTINEL_FIGURE, "987654", SENTINEL_NAME, "2031-07"):
        assert leaked not in out.stdout + out.stderr, leaked
    assert not (tmp_path / "r.json").exists()


def test_wrapper_never_prints_a_malformed_date(tmp_path):
    raw = frozen_base()
    raw["as_of"] = "2031-03-10\n"
    frozen = write_frozen(tmp_path, raw)
    out = run_wrapper(["--frozen", frozen, "--report", str(tmp_path / "r.json"),
                       "--expect-host", "127.0.0.1", "--expect-db", "c3db",
                       "--expect-server-addr", "192.0.2.1"],
                      cwd=str(tmp_path), env_url="postgresql://u:pw@127.0.0.1:1/c3db")
    assert out.returncode == 2, out.stdout + out.stderr
    assert "frozen file is invalid" in out.stdout
    for leaked in ("2031-03-10", "isoformat"):
        assert leaked not in out.stdout + out.stderr, leaked


@pytest.mark.parametrize("url, extra_env, fragment", [
    ("postgresql://u:pw@127.0.0.1:1/c3db?host=10.0.0.9", {}, "query key 'host'"),
    ("postgresql://u:pw@127.0.0.1:1/c3db?hostaddr=10.0.0.9", {}, "query key 'hostaddr'"),
    ("postgresql://u:pw@127.0.0.1:1/c3db", {"PGHOSTADDR": "10.0.0.9"}, "PGHOSTADDR is set"),
])
def test_wrapper_refuses_target_overrides_before_importing_the_app(tmp_path, url, extra_env,
                                                                   fragment):
    out = run_wrapper(["--frozen", str(tmp_path / "f.json"), "--report", str(tmp_path / "r.json"),
                       "--expect-host", "127.0.0.1", "--expect-db", "c3db",
                       "--expect-server-addr", "192.0.2.1"],
                      cwd=str(tmp_path), env_url=url, extra_env=extra_env, probe=True)
    assert fragment in out.stdout, out.stdout + out.stderr
    assert "EXIT 2" in out.stdout
    assert "APP_SETTINGS_IMPORTED False" in out.stdout


def test_wrapper_refuses_paths_inside_the_repo(tmp_path):
    inside = os.path.join(bootstrap.repo_root(), "backend", "report.json")
    out = run_wrapper(["--frozen", str(tmp_path / "f.json"), "--report", inside,
                       "--expect-host", "127.0.0.1", "--expect-db", "c3db",
                       "--expect-server-addr", "192.0.2.1"],
                      cwd=str(tmp_path), env_url="postgresql://u:pw@127.0.0.1:1/c3db")
    assert out.returncode == 2
    assert "--report must live outside the repository" in out.stdout
    assert not os.path.exists(inside)
    link = tmp_path / "repo-link"
    link.symlink_to(bootstrap.repo_root())
    out = run_wrapper(["--frozen", str(link / "frozen.json"), "--report", str(tmp_path / "r.json"),
                       "--expect-host", "127.0.0.1", "--expect-db", "c3db",
                       "--expect-server-addr", "192.0.2.1"],
                      cwd=str(tmp_path), env_url="postgresql://u:pw@127.0.0.1:1/c3db")
    assert "--frozen must live outside the repository" in out.stdout


# --- 2. Each check fails with a precise diff (routing, loans, recurring) -----------------------

def recurring(raw, name) -> dict:
    return next(r for r in raw["recurring"] if r["name"] == name)


@needs_db
def test_wrong_card_routing_fails(world, target):
    raw = owner_frozen(world)
    raw["card_routing"][0]["overflow_account"] = None
    [failure] = block(run_check(target, raw), "card_routing")["failures"]
    assert failure == {"message": "card overflow_account differs",
                       "card": "Main card (credit, PHP)", "expected": None,
                       "actual": "Second bank (savings, PHP)"}


@needs_db
def test_an_unlisted_owner_card_fails_card_routing(world, target):
    world["post"]("/accounts/", {"name": "Spare card", "account_type": "credit", "balance": 0,
                                 "billing_cycle_start": 5})
    assert messages(run_check(target, owner_frozen(world)), "card_routing") == [
        "owner card not in the frozen card_routing"]


@needs_db
def test_a_wrong_loan_payer_fails(world, target):
    raw = owner_frozen(world)
    raw["loans"][0]["payment_account"] = sel("Second bank", "savings")
    [failure] = block(run_check(target, raw), "loans")["failures"]
    assert failure["message"] == "loan payment_account differs"
    assert failure["actual"] == "Main bank (checking, PHP)"


@needs_db
def test_a_wrong_loan_next_due_or_next_row_fails(world, target):
    raw = owner_frozen(world)
    raw["loans"][0]["next_due"] = "2031-05-20"
    raw["loans"][0]["next_rows"][1]["payment"] = "4999.00"
    failures = block(run_check(target, raw), "loans")["failures"]
    assert [(f["message"], f["expected"], f["actual"]) for f in failures] == [
        ("loan next_due differs", "2031-05-20", "2031-04-20"),
        ("loan next row 2 payment differs", "4999.00", "5000.00"),
    ]


@needs_db
@pytest.mark.parametrize("name, field, value, message", [
    ("Utilities", "overflow_account", None, "recurring overflow_account differs"),
    ("Utilities", "is_autopay", False, "recurring is_autopay differs"),
    ("Salary", "amount", "30001.00", "recurring amount differs"),
    ("Salary", "next_occurrence", "2031-03-26", "recurring next_occurrence differs"),
    ("Phone plan", "installment", {"n": 3, "m": 6}, "recurring installment differs"),
])
def test_a_wrong_recurring_definition_fails(world, target, name, field, value, message):
    raw = owner_frozen(world)
    recurring(raw, name)[field] = value
    failures = block(run_check(target, raw), "recurring")["failures"]
    assert [f["message"] for f in failures] == [message], failures
    if field == "installment":
        assert (failures[0]["expected"], failures[0]["actual"]) == ("3 of 6", "2 of 6")


@needs_db
def test_a_frozen_entry_matching_two_owner_entries_fails(world, target):
    world["post"]("/budget-entries/", {"name": "Salary", "entry_type": "income",
                                       "amount": 100, "account_id": world["bank"],
                                       "next_occurrence": day("2031-03-26")})
    failures = block(run_check(target, owner_frozen(world)), "recurring")["failures"]
    assert [f["message"] for f in failures] == ["frozen entry matches 2 owner entries"]
    assert len(failures[0]["entry_ids"]) == 2


@needs_db
def test_a_lookalike_overflow_account_of_another_user_fails(world, target, sw_client, sw_people,
                                                          sw_db):
    from app.models.budget_entry import BudgetEntry
    from app.tests.conftest import sw_post

    other = sw_people("Otto", "Other")
    twin = sw_post(sw_client, other, "/accounts/", {"name": "Second bank",
                                                    "account_type": "savings",
                                                    "balance": 0})["id"]
    entry = sw_db.get(BudgetEntry, world["entries"]["utilities"])
    entry.overflow_account_id = twin
    sw_db.commit()
    try:
        failures = block(run_check(target, owner_frozen(world)), "recurring")["failures"]
    finally:
        entry.overflow_account_id = world["second"]
        sw_db.commit()
    assert [f["message"] for f in failures] == ["recurring overflow_account differs"], failures
    assert failures[0]["expected"] == failures[0]["actual"] == "Second bank (savings, PHP)"


# --- 4. Occurrences -------------------------------------------------------------------------

def materialize(client, who, entry_id, **body):
    from app.tests.conftest import sw_post

    return sw_post(client, who, f"/budget-entries/{entry_id}/materialize",
                   {"advance": False, **body})


@needs_db
def test_a_semi_monthly_entry_expects_two_a_month(world, target):
    world["post"]("/budget-entries/", {
        "name": "Allowance", "entry_type": "expense", "amount": 1000, "currency": "PHP",
        "cadence": "semi_monthly", "semi_monthly_day_1": 1, "semi_monthly_day_2": 15,
        "account_id": world["second"], "next_occurrence": day("2031-03-15")})
    raw = owner_frozen(world)
    raw["recurring"].append({
        "name": "Allowance", "account": sel("Second bank", "savings"), "destination": None,
        "overflow_account": None, "entry_type": "expense", "amount": "1000.00",
        "currency": "PHP", "cadence": "semi_monthly", "semi_monthly_days": [1, 15],
        "next_occurrence": "2031-03-15", "end_mode": "indefinite", "is_autopay": False,
        "is_active": True, "expected": {"2031-03": 1, "2031-04": 2, "2031-05": 2}})
    report = run_check(target, raw)
    assert block(report, "occurrences")["status"] == "pass", block(report, "occurrences")
    assert block(report, "recurring")["status"] == "pass"
    recurring(raw, "Allowance")["expected"]["2031-04"] = 1
    [failure] = block(run_check(target, raw), "occurrences")["failures"]
    assert (failure["month"], failure["expected"], failure["actual"]) == ("2031-04", 1, 2)


@needs_db
def test_a_domestic_materialisation_without_advance_counts_once(world, target, sw_client):
    txn_body = materialize(sw_client, world["o"], world["entries"]["utilities"])
    assert txn_body["budget_entry_id"] == world["entries"]["utilities"]
    occ = block(run_check(target, owner_frozen(world)), "occurrences")
    assert occ["status"] == "pass", occ


@needs_db
def test_a_loan_materialisation_without_advance_counts_once(world, target, sw_client, sw_db):
    from app.models.transaction import Transaction

    body = materialize(sw_client, world["o"], world["entries"]["loan"])
    row = sw_db.get(Transaction, body["id"])
    assert row.amount + row.transfer_fee == 5000 and row.transfer_fee > 0  # split by the stamp
    occ = block(run_check(target, owner_frozen(world)), "occurrences")
    assert occ["status"] == "pass", occ


@needs_db
def test_a_foreign_materialisation_without_advance_counts_once(world, target, sw_client, sw_db):
    from app.models.transaction import Transaction

    entry_id = world["post"]("/budget-entries/", {
        "name": "Streaming", "entry_type": "expense", "amount": 10, "currency": "USD",
        "account_id": world["card"], "next_occurrence": day("2031-03-25")})["id"]
    body = materialize(sw_client, world["o"], entry_id, amount=600)
    row = sw_db.get(Transaction, body["id"])
    assert (row.amount, row.projected_amount, row.projected_currency.value) == (600, 10, "USD")
    raw = owner_frozen(world)
    raw["recurring"].append({
        "name": "Streaming", "account": sel("Main card", "credit"), "destination": None,
        "overflow_account": None, "entry_type": "expense", "amount": "10.00",
        "currency": "USD", "cadence": "monthly", "next_occurrence": "2031-03-25",
        "end_mode": "indefinite", "is_autopay": False, "is_active": True,
        "expected": {"2031-03": 1, "2031-04": 1}})
    occ = block(run_check(target, raw), "occurrences")
    assert occ["status"] == "pass", occ


@needs_db
def test_an_unlinked_import_and_a_projection_in_one_month_fail_as_a_duplicate(world, target):
    row = world["debit"](world["bank"], 2000, "2031-03-03", "Utilities March")
    [failure] = block(run_check(target, owner_frozen(world)), "occurrences")["failures"]
    assert failure == {"message": "occurrence count differs",
                       "entry": "Utilities on Main bank (checking, PHP)", "month": "2031-03",
                       "expected": 1, "actual": 2, "linked_ids": [], "unlinked_ids": [row],
                       "projected": 1}


@needs_db
def test_a_matching_imported_loan_payment_counts_by_principal_plus_interest(world, target):
    raw = owner_frozen(world)
    recurring(raw, "Car loan payment")["expected"]["2031-03"] = 0
    [failure] = block(run_check(target, raw), "occurrences")["failures"]
    assert failure["unlinked_ids"] == [world["rows"]["loan_payment"]]


@needs_db
def test_an_ambiguous_row_fails_until_description_contains_is_frozen(world, target):
    world["post"]("/budget-entries/", {
        "name": "Gym", "entry_type": "expense", "amount": 2000, "currency": "PHP",
        "account_id": world["bank"], "next_occurrence": day("2031-03-28")})
    row = world["debit"](world["bank"], 2000, "2031-02-20", "Power bill")
    raw = owner_frozen(world)
    recurring(raw, "Utilities")["expected"] = {"2031-02": 1, "2031-03": 1, "2031-04": 1}
    raw["recurring"].append({
        "name": "Gym", "account": sel("Main bank", "checking"), "destination": None,
        "overflow_account": None, "entry_type": "expense", "amount": "2000.00",
        "currency": "PHP", "cadence": "monthly", "next_occurrence": "2031-03-28",
        "end_mode": "indefinite", "is_autopay": False, "is_active": True,
        "expected": {"2031-03": 1, "2031-04": 1}})
    failures = block(run_check(target, raw), "occurrences")["failures"]
    ambiguous = [f for f in failures if f["message"] == "unlinked row matches several entries"]
    assert len(ambiguous) == 1 and ambiguous[0]["transaction_id"] == row
    assert ambiguous[0]["entries"] == ["Utilities on Main bank (checking, PHP)",
                                       "Gym on Main bank (checking, PHP)"]
    recurring(raw, "Utilities")["description_contains"] = "power"
    recurring(raw, "Gym")["description_contains"] = "gym"
    occ = block(run_check(target, raw), "occurrences")
    assert occ["status"] == "pass", occ


@needs_db
def test_a_frozen_expectation_on_a_wallet_funded_entry_is_refused(world, target):
    raw = owner_frozen(world)
    recurring(raw, "Snacks")["expected"] = {"2031-03": 1}
    assert messages(run_check(target, raw), "occurrences") == [
        "refused: a wallet-funded entry is not projected; freeze no expected for it"]


@needs_db
def test_an_active_entry_due_before_as_of_fails(world, target):
    raw = owner_frozen(world)
    raw["as_of"] = "2031-03-21"
    raw["sheet"]["dated_items"] = []
    assert "active entry with next_occurrence before as_of" in messages(
        run_check(target, raw), "occurrences")


# --- 6. Posted-after guard ------------------------------------------------------------------

@needs_db
def test_a_posted_row_after_as_of_makes_the_loan_and_sheet_blocks_refuse(world, target):
    row = world["debit"](world["bank"], 100, "2031-03-12", "Too late")
    report = run_check(target, owner_frozen(world))
    for name in ("loans", "sheet"):
        refused_block = block(report, name)
        assert refused_block["status"] == "refused"
        assert [f["transaction_id"] for f in refused_block["failures"]] == [row]
    assert [r["transaction_id"] for r in report["posted_after"]] == [row]
    assert report["overall"] == "fail"
    # The balance and statement blocks still run on their own boundaries.
    assert block(report, "checkpoints")["status"] == "pass"
    assert block(report, "card_statements")["status"] == "pass"


# --- 5. Sheet -------------------------------------------------------------------------------

def sheet_only():
    from app.cutover_check.sheet import check_sheet

    return [("sheet", check_sheet)]


@needs_db
def test_the_sheet_reads_its_own_account_not_the_partition(world, target, sw_db):
    from datetime import datetime
    from decimal import Decimal

    from app.services.forecast import cashflow_by_currency
    from app.services.fx import FxRates

    world["post"]("/budget-entries/", {
        "name": "Allowance", "entry_type": "expense", "amount": 1000, "currency": "PHP",
        "cadence": "semi_monthly", "account_id": world["second"],
        "next_occurrence": day("2031-03-15")})
    report = run_check(target, owner_frozen(world), blocks=sheet_only())
    assert block(report, "sheet")["status"] == "pass", block(report, "sheet")
    # The PHP partition's net moves with the second bank too: reading it would fail.
    periods = cashflow_by_currency(sw_db, world["o"]["id"], months=2,
                                   reference=datetime(2031, 3, 10),
                                   fx=FxRates.offline(sw_db))["periods"]
    php = next(r for r in periods[1]["by_currency"] if r["currency"] == "PHP")
    bank = next(a for a in php["by_account"] if a["account_id"] == world["bank"])
    assert Decimal(str(bank["closing_balance"])) - Decimal("74000") != Decimal(str(php["net"]))


@needs_db
def test_the_load_month_combines_realised_and_projected_movement(world, target):
    raw = owner_frozen(world)
    assert block(run_check(target, raw, blocks=sheet_only()), "sheet")["status"] == "pass"
    # Projected movement alone from the opening (49600 + 27400) misses the realised -3000.
    raw["sheet"]["month_end"]["2031-03"] = "77000.00"
    failures = block(run_check(target, raw, blocks=sheet_only()), "sheet")["failures"]
    assert [(f["message"], f["month"]) for f in failures] == [
        ("sheet closing differs", "2031-03"), ("sheet net differs", "2031-03"),
        ("sheet net differs", "2031-04")]
    assert failures[0]["actual"] == "74000.00"


@needs_db
def test_an_approved_difference_applies_cumulatively(world, target):
    raw = owner_frozen(world)
    raw["sheet"]["approved_differences"] = [
        {"month": "2031-03", "amount": "100.00", "reason": "a fee the Sheet does not track"}]
    raw["sheet"]["month_end"] = {"2031-03": "73900.00", "2031-04": "96300.00",
                                 "2031-05": "118300.00"}
    sheet_block = block(run_check(target, raw, blocks=sheet_only()), "sheet")
    assert sheet_block["status"] == "pass", sheet_block
    raw["sheet"]["month_end"] = {"2031-03": "73900.00", "2031-04": "96400.00",
                                 "2031-05": "118400.00"}  # applied to month 1 only
    failures = block(run_check(target, raw, blocks=sheet_only()), "sheet")["failures"]
    assert [(f["message"], f["month"]) for f in failures] == [
        ("sheet closing differs", "2031-04"), ("sheet net differs", "2031-04"),
        ("sheet closing differs", "2031-05")]


def small_frozen(email, account, months, opening, month_end, policy="excluded") -> dict:
    return {"schema_version": 1, "owner_email": email, "cutover_date": "2031-03-01",
            "as_of": "2031-03-10", "timezone": "Asia/Manila", "checkpoints": [],
            "card_statements": [], "card_routing": [], "loans": [], "recurring": [],
            "sheet": {"account": account, "currency": account["currency"],
                      "first_month": months[0], "months": months, "sheet_opening": opening,
                      "month_end": month_end, "opening_offset": "0.00",
                      "overflow_policy": policy, "approved_differences": [],
                      "dated_items": []}}


@needs_db
@pytest.mark.parametrize("policy, month_end", [
    ("excluded", {"2031-03": "-900.00", "2031-04": "-1900.00"}),
    ("included", {"2031-03": "0.00", "2031-04": "0.00"}),
])
def test_overflow_policy_included_and_excluded(sw_client, sw_people, target, policy, month_end):
    from app.tests.conftest import sw_post

    o = sw_people("Ola", "Owner")
    low = sw_post(sw_client, o, "/accounts/", {"name": "Low bank", "account_type": "checking",
                                               "balance": 100})["id"]
    reserve = sw_post(sw_client, o, "/accounts/", {"name": "Reserve",
                                                   "account_type": "savings",
                                                   "balance": 10000})["id"]
    sw_post(sw_client, o, "/budget-entries/", {
        "name": "Rent", "entry_type": "expense", "amount": 1000, "currency": "PHP",
        "account_id": low, "overflow_account_id": reserve,
        "next_occurrence": day("2031-03-20")})
    raw = small_frozen(o["email"], sel("Low bank", "checking"), ["2031-03", "2031-04"],
                       "100.00", month_end, policy)
    sheet_block = block(run_check(target, raw, blocks=sheet_only()), "sheet")
    assert sheet_block["status"] == "pass", sheet_block
    other = "included" if policy == "excluded" else "excluded"
    raw["sheet"]["overflow_policy"] = other
    assert block(run_check(target, raw, blocks=sheet_only()), "sheet")["status"] == "fail"


@needs_db
def test_a_missing_dated_item_fails(world, target):
    raw = owner_frozen(world)
    raw["sheet"]["dated_items"][0]["amount"] = "-1001.00"
    [failure] = block(run_check(target, raw, blocks=sheet_only()), "sheet")["failures"]
    assert failure["message"] == "dated item not found as a posted row on the sheet account"
    assert [r["transaction_id"] for r in failure["same_day_rows"]] == [
        world["rows"]["loan_payment"], world["rows"]["hardware"]]


@needs_db
def test_a_dated_item_matching_only_another_account_fails(world, target):
    world["debit"](world["second"], 1000, "2031-03-06", "Paint hardware")
    raw = owner_frozen(world)
    raw["sheet"]["dated_items"].append(
        {"date": "2031-03-06", "amount": "-1000.00", "description_contains": "paint"})
    [failure] = block(run_check(target, raw, blocks=sheet_only()), "sheet")["failures"]
    assert failure["message"] == "dated item not found as a posted row on the sheet account"
    assert failure["same_day_rows"] == []


def dated_failures(report) -> list:
    return [f for f in block(report, "sheet")["failures"]
            if f["message"] == "dated item not found as a posted row on the sheet account"]


@needs_db
def test_a_dated_item_matching_only_another_users_row_fails(world, target, sw_people, sw_db):
    from datetime import datetime

    from app.models.transaction import Transaction, TransactionType

    other = sw_people("Uma", "Other")
    row = Transaction(user_id=other["id"], account_id=world["bank"], amount=700,
                      currency="PHP", transaction_type=TransactionType.DEBIT,
                      transaction_date=datetime(2031, 3, 6), description="Paint store",
                      is_posted=True)
    sw_db.add(row)
    sw_db.commit()
    raw = owner_frozen(world)
    raw["sheet"]["dated_items"].append(
        {"date": "2031-03-06", "amount": "-700.00", "description_contains": "paint"})
    try:
        [failure] = dated_failures(run_check(target, raw, blocks=sheet_only()))
    finally:
        sw_db.delete(row)
        sw_db.commit()
    assert failure["date"] == "2031-03-06"
    assert failure["same_day_rows"] == []


@needs_db
def test_a_dated_item_matching_only_an_unposted_row_fails(world, target):
    world["debit"](world["bank"], 700, "2031-03-06", "Paint store", posted=False)
    raw = owner_frozen(world)
    raw["sheet"]["dated_items"].append(
        {"date": "2031-03-06", "amount": "-700.00", "description_contains": "paint"})
    [failure] = dated_failures(run_check(target, raw, blocks=sheet_only()))
    assert failure["date"] == "2031-03-06"
    assert failure["same_day_rows"] == []


@needs_db
def test_a_first_month_after_as_of_refuses_the_sheet(sw_client, sw_people, target):
    from app.tests.conftest import sw_post

    o = sw_people("Fay", "Owner")
    sw_post(sw_client, o, "/accounts/", {"name": "Only bank", "account_type": "checking",
                                         "balance": 1000})
    raw = small_frozen(o["email"], sel("Only bank", "checking"), ["2031-04"], "1000.00",
                       {"2031-04": "1000.00"})
    sheet_block = block(run_check(target, raw, blocks=sheet_only()), "sheet")
    assert sheet_block["status"] == "refused", sheet_block
    assert sheet_block["refused"] == "first_month starts after as_of"
    raw["as_of"] = "2031-04-01"  # the first of first_month is T itself: B(A, T) opens
    sheet_block = block(run_check(target, raw, blocks=sheet_only()), "sheet")
    assert sheet_block["status"] == "pass", sheet_block


# --- 7. Currency partitions and wallets in the Sheet ------------------------------------------

@needs_db
def test_a_usd_account_is_absent_from_the_php_row(world, target, sw_db):
    from datetime import datetime

    from app.services.forecast import cashflow_by_currency
    from app.services.fx import FxRates

    world["transfer"](world["usd"], world["bank"], 100, "2031-03-06", "Convert",
                      received_amount=5000)
    world["post"]("/budget-entries/", {
        "name": "Dollar income", "entry_type": "income", "amount": 50, "currency": "USD",
        "account_id": world["usd"], "next_occurrence": day("2031-03-20")})
    periods = cashflow_by_currency(sw_db, world["o"]["id"], months=1,
                                   reference=datetime(2031, 3, 10),
                                   fx=FxRates.offline(sw_db))["periods"]
    php = next(r for r in periods[0]["by_currency"] if r["currency"] == "PHP")
    assert world["usd"] not in [a["account_id"] for a in php["by_account"]]
    raw = owner_frozen(world)
    # The conversion landed 5000 in the bank on Mar 6: every Sheet figure moves by it.
    raw["sheet"]["sheet_opening"] = "49600.00"
    raw["sheet"]["month_end"] = {"2031-03": "79000.00", "2031-04": "101400.00",
                                 "2031-05": "123400.00"}
    sheet_block = block(run_check(target, raw, blocks=sheet_only()), "sheet")
    assert sheet_block["status"] == "pass", sheet_block


@needs_db
@pytest.mark.parametrize("account", [sel("Pocket wallet", "cash"), sel("Main card", "credit")])
def test_a_sheet_account_that_is_not_projection_cash_is_refused(world, target, account):
    raw = owner_frozen(world)
    raw["sheet"]["account"] = account
    sheet_block = block(run_check(target, raw, blocks=sheet_only()), "sheet")
    assert sheet_block["status"] == "refused"
    assert sheet_block["failures"][0]["message"].startswith(
        "refused: the sheet account must be projection cash")


@needs_db
def test_as_of_on_the_first_reads_the_closed_month_from_the_ledger(sw_client, sw_people, target):
    from app.tests.conftest import sw_post

    o = sw_people("Ada", "Owner")
    bank = sw_post(sw_client, o, "/accounts/", {"name": "Only bank", "account_type": "checking",
                                                "balance": 1000})["id"]
    sw_post(sw_client, o, "/transactions/", {
        "account_id": bank, "amount": 300, "currency": "PHP", "transaction_type": "debit",
        "transaction_date": day("2031-03-05"), "description": "Hardware"})
    sw_post(sw_client, o, "/budget-entries/", {
        "name": "Rent", "entry_type": "expense", "amount": 200, "currency": "PHP",
        "account_id": bank, "next_occurrence": day("2031-04-20")})
    raw = small_frozen(o["email"], sel("Only bank", "checking"), ["2031-03", "2031-04"],
                       "1000.00", {"2031-03": "700.00", "2031-04": "500.00"})
    raw["as_of"] = "2031-04-01"
    sheet_block = block(run_check(target, raw, blocks=sheet_only()), "sheet")
    assert sheet_block["status"] == "pass", sheet_block
