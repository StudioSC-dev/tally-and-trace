"""Monthly free flow from posted transactions and savings goals (STU-788).

Plan: ``.claude/plans/wishlist-net-flow-plan.md`` section 2; each test name
carries the acceptance criterion it pins (``ac1`` ... ``ac20``).

Most tests write rows straight to the database (the transaction routes have
their own tests) and call the service with a fixed Manila "today" of
15 Nov 2026. Unless a test says otherwise, an anchor row on 10 Sep makes the
window October 2026 alone (``sample_months`` 1), so every figure is the
October total. The route tests at the end use the real clock. Every user is
made fresh by ``sw_people`` and removed with everything they made.

Skips without a database.
"""
import secrets
from datetime import date, datetime, timedelta, timezone
from decimal import Decimal

import pytest
from sqlalchemy import event

from app.tests.conftest import API, sw_db_reachable, sw_share

pytestmark = pytest.mark.skipif(not sw_db_reachable(), reason="DATABASE_URL not reachable")

TODAY = date(2026, 11, 15)
OCT = datetime(2026, 10, 10)
# From 15 Nov 2026, a target on 30 Apr 2027 has 5 full months left (Dec..Apr).
DUE = datetime(2027, 4, 30)
SAME = object()


def D(value) -> Decimal:
    return Decimal(str(value))


class World:
    """One caller (``me``) and the helpers every test builds from."""

    def __init__(self, client, db, people):
        self.client, self.db, self.people = client, db, people
        self.me = people("Free", "Flow")
        self._rank = {}

    # --- records ---------------------------------------------------------------------

    def account(self, kind="checking", currency="PHP", balance=0, owner=None) -> int:
        from app.models.account import Account, AccountType
        from app.models.user import CurrencyType

        owner = owner or self.me
        a = Account(user_id=owner["id"], name=f"{kind} {currency}",
                    account_type=AccountType(kind), balance=D(balance),
                    currency=CurrencyType(currency))
        self.db.add(a)
        self.db.commit()
        return a.id

    def category(self, owner=None) -> int:
        from app.models.category import Category

        owner = owner or self.me
        c = Category(user_id=owner["id"], name=f"Savings {secrets.token_hex(3)}")
        self.db.add(c)
        self.db.commit()
        return c.id

    def txn(self, account, kind, amount, *, to=None, fee=0, day=OCT, currency=SAME,
            category=None, by=None, posted=True) -> int:
        from app.models.account import Account
        from app.models.transaction import Transaction, TransactionType
        from app.models.user import CurrencyType

        if currency is SAME:
            currency = self.db.get(Account, account).currency
        elif currency is not None:
            currency = CurrencyType(currency)
        t = Transaction(
            user_id=(by or self.me)["id"], account_id=account,
            transaction_type=TransactionType(kind), amount=D(amount), currency=currency,
            transfer_fee=D(fee), transaction_date=day, is_posted=posted,
            category_id=category, description="row")
        if kind == "transfer":
            t.transfer_from_account_id, t.transfer_to_account_id = account, to
        self.db.add(t)
        self.db.commit()
        return t.id

    def anchor(self, account, day=datetime(2026, 9, 10)):
        """A zero row before the window: it starts the window the month after."""
        return self.txn(account, "debit", 0, day=day)

    def goal(self, *, kind="savings", mode=None, account=None, accounts=None, category=None,
             target=None, monthly=None, due=None, currency="PHP", current=0, owner=None,
             created=datetime(2026, 1, 1, tzinfo=timezone.utc), active=True) -> int:
        from app.models.allocation import Allocation, AllocationType
        from app.models.user import CurrencyType

        owner = owner or self.me
        configuration = None
        if mode == "multi_account":
            configuration = {"goal_mode": mode, "account_ids": accounts}
        elif mode == "transaction_total":
            configuration = {"goal_mode": mode, "savings_category_id": category}
        elif mode is not None:
            configuration = {"goal_mode": mode}
        rank = self._rank.get(owner["id"], 0) + 1
        self._rank[owner["id"]] = rank
        a = Allocation(
            user_id=owner["id"], account_id=account, name=f"Goal {rank}",
            allocation_type=AllocationType(kind),
            target_amount=None if target is None else D(target),
            monthly_target=None if monthly is None else D(monthly),
            current_amount=D(current), currency=CurrencyType(currency),
            configuration=configuration, target_date=due, is_active=active,
            rank=rank if active else None, created_at=created)
        self.db.add(a)
        self.db.commit()
        return a.id

    def rerank(self, *ids):
        from app.models.allocation import Allocation

        for place, i in enumerate(ids, start=1):
            self.db.get(Allocation, i).rank = place
        self.db.commit()

    # --- reading ---------------------------------------------------------------------

    def compute(self, who=None, today=TODAY):
        from app.core.context import RequestContext
        from app.services import free_flow

        self.db.expire_all()
        return free_flow.compute(RequestContext(self.db, (who or self.me)["id"], today=today))


@pytest.fixture
def w(sw_client, sw_db, sw_people):
    return World(sw_client, sw_db, sw_people)


def figures(result, currency="PHP"):
    r = result.row(currency)
    assert r is not None, [x.currency for x in result.rows]
    return {k: getattr(r, k) for k in ("status", "sample_months", "income", "spending",
                                       "debt_paid", "net_flow", "saved", "goal_top_up",
                                       "reserved", "free_flow", "shortfall")}


def goal(result, allocation_id):
    return next(g for g in result.goals if g.allocation_id == allocation_id)


def statuses(result):
    return {r.currency: r.status for r in result.rows}


# --- AC1: scope ---------------------------------------------------------------------------

def test_ac1_only_own_accounts_count_and_an_outside_account_never_enters(w):
    partner = w.people("Pat", "Partner")
    pool = w.account()
    w.anchor(pool)
    w.txn(pool, "credit", 10_000)
    joint = w.account(owner=partner)                        # shared with me as admin
    joint_savings = w.account("savings", balance=900_000, owner=partner)
    sw_share(w.db, joint, w.me["id"], "admin", partner["id"])
    sw_share(w.db, joint_savings, w.me["id"], "editor", partner["id"])
    w.txn(joint, "credit", 50_000, by=partner)
    w.txn(joint, "debit", 7_000)                            # posted by me, on their account
    g = w.goal(mode="target_balance", account=joint_savings, target=50_000, due=DUE)

    result = w.compute()
    f = figures(result)
    assert (f["income"], f["spending"]) == (D(10_000), D(0))
    # The outside balance is never counted: the goal holds nothing and reserves its pace.
    assert goal(result, g).pace == D(10_000)
    assert [r.currency for r in result.rows] == ["PHP"]


def test_ac1_another_users_row_on_an_own_account_counts_but_its_category_is_not_read(w):
    partner = w.people("Pat", "Partner")
    pool, savings = w.account(), w.account("savings")
    w.anchor(pool)
    w.txn(pool, "credit", 20_000)
    cat = w.category()
    g = w.goal(mode="transaction_total", category=cat, monthly=1_000)
    # Rows the partner posted on my accounts: they moved my money, so they count.
    w.txn(pool, "credit", 5_000, by=partner)
    w.txn(pool, "transfer", 1_000, to=savings, category=cat, by=partner)

    result = w.compute()
    f = figures(result)
    assert (f["income"], f["saved"]) == (D(25_000), D(1_000))
    # Its category is not read: the tagged deposit does not feed my category goal.
    assert goal(result, g).fed == D(0)
    assert goal(result, g).top_up == D(1_000)


def test_ac1_the_stored_currency_of_another_users_row_is_read(w):
    partner = w.people("Pat", "Partner")
    pool = w.account()
    w.anchor(pool)
    w.txn(pool, "credit", 20_000)
    w.txn(pool, "debit", 10, currency="USD", by=partner)    # stored USD on a PHP account
    assert statuses(w.compute()) == {"PHP": "incomplete", "USD": "incomplete"}


# --- AC2: the row table -------------------------------------------------------------------

# (row, expected change to income, spending, debt_paid, saved). Every transfer is
# 1,000 with a 15 fee; a baseline Pool-to-Savings 10,000 keeps ``saved`` above 0.
ROW_TABLE = [
    ("1 credit on Pool", ("pool", "credit", None), (1_000, 0, 0, 0)),
    ("2 debit on Pool", ("pool", "debit", None), (0, 1_000, 0, 0)),
    ("3 credit on Savings", ("savings", "credit", None), (0, 0, 0, 0)),
    ("3 credit on Loan", ("loan", "credit", None), (0, 0, 0, 0)),
    ("3 debit on Loan", ("loan", "debit", None), (0, 0, 0, 0)),
    ("3a debit on Savings", ("savings", "debit", None), (0, 1_000, 0, -1_000)),
    ("4 Pool to Pool", ("pool", "transfer", "pool2"), (0, 15, 0, 0)),
    ("6 Pool to Savings", ("pool", "transfer", "savings"), (0, 15, 0, 1_000)),
    ("7 Savings to Pool", ("savings", "transfer", "pool"), (0, 0, 0, -1_000)),
    ("8 Pool to Loan", ("pool", "transfer", "loan"), (0, 15, 1_000, 0)),
    ("9 Pool to outside", ("pool", "transfer", "outside"), (0, 1_015, 0, 0)),
    ("10 Loan to Pool", ("loan", "transfer", "pool"), (0, 0, 0, 0)),
    ("10 Loan to Savings", ("loan", "transfer", "savings"), (0, 0, 0, 0)),
    ("10 outside to Pool", ("outside", "transfer", "pool"), (0, 0, 0, 0)),
    ("11 Savings to Loan", ("savings", "transfer", "loan"), (0, 15, 1_000, -1_015)),
    ("12 Savings to outside", ("savings", "transfer", "outside"), (0, 1_015, 0, -1_015)),
    ("13 Savings to Savings", ("savings", "transfer", "savings2"), (0, 0, 0, 0)),
]


@pytest.mark.parametrize("label,row,change", ROW_TABLE, ids=[r[0] for r in ROW_TABLE])
def test_ac2_each_line_of_the_row_table_and_a_fee_counts_once(w, label, row, change):
    stranger = w.people("Sam", "Stranger")
    acc = {"pool": w.account(), "pool2": w.account("e_wallet"),
           "savings": w.account("savings"), "savings2": w.account("savings"),
           "loan": w.account("loan"), "outside": w.account(owner=stranger)}
    w.anchor(acc["pool"])
    w.txn(acc["pool"], "transfer", 10_000, to=acc["savings"])          # baseline saving
    source, kind, to = row
    by = stranger if source == "outside" else None
    if kind == "transfer":
        w.txn(acc[source], "transfer", 1_000, to=acc[to], fee=15, by=by)
    else:
        w.txn(acc[source], kind, 1_000)

    f = figures(w.compute())
    income, spending, debt, saved = change
    assert (f["income"], f["spending"], f["debt_paid"], f["saved"]) == (
        D(income), D(spending), D(debt), D(10_000 + saved)), label


def test_ac2_a_row_with_no_stored_currency_reads_as_its_accounts_currency():
    # ``transactions.currency`` is NOT NULL in the database today, so a row with no
    # stored currency cannot be written; the rule is pinned on a grouped row.
    from collections import namedtuple

    from app.models.transaction import TransactionType
    from app.services.free_flow import POOL, _Own, classify

    Row = namedtuple("Row", "month source counter type currency category amount fee")
    own = {7: _Own(7, POOL, "USD", D(0))}
    out = classify([Row(None, 7, None, TransactionType.CREDIT, None, None, D(300), D(0))], own)
    assert out.cross is False
    assert out.currencies == {"USD"}
    assert out.terms["USD"].income == D(300)


# --- AC3, AC4, AC5 ------------------------------------------------------------------------

def test_ac3_savings_to_wallet_then_wallet_to_checking_adds_no_income(w):
    checking, wallet, savings = w.account(), w.account("e_wallet"), w.account("savings")
    w.anchor(checking)
    w.txn(checking, "transfer", 10_000, to=savings)
    w.txn(savings, "transfer", 4_000, to=wallet)
    w.txn(wallet, "transfer", 4_000, to=checking)
    f = figures(w.compute())
    assert (f["income"], f["spending"], f["saved"]) == (D(0), D(0), D(6_000))


def test_ac3_borrowed_money_adds_no_net_flow(w):
    checking, loan = w.account(), w.account("loan", balance=-50_000)
    w.anchor(checking)
    w.txn(checking, "credit", 20_000)
    w.txn(loan, "transfer", 50_000, to=checking)       # the loan is paid out
    w.txn(loan, "credit", 50_000)
    f = figures(w.compute())
    assert (f["income"], f["net_flow"]) == (D(20_000), D(20_000))


def test_ac3_a_wallet_top_up_and_the_spending_from_it_count_once(w):
    checking, wallet = w.account(), w.account("cash")
    w.anchor(checking)
    w.txn(checking, "credit", 20_000)
    w.txn(checking, "transfer", 3_000, to=wallet)
    w.txn(wallet, "debit", 3_000)
    f = figures(w.compute())
    assert (f["spending"], f["net_flow"]) == (D(3_000), D(17_000))


def test_ac4_a_bill_and_a_loan_payment_from_savings_are_spending_and_lower_saved(w):
    checking, savings, loan = w.account(), w.account("savings"), w.account("loan")
    w.anchor(checking)
    w.txn(checking, "credit", 30_000)
    w.txn(checking, "transfer", 10_000, to=savings)
    w.txn(savings, "debit", 500)                                  # a bill paid from Savings
    w.txn(savings, "transfer", 1_000, to=loan, fee=50)            # a loan payment
    f = figures(w.compute())
    assert (f["spending"], f["debt_paid"], f["saved"]) == (D(550), D(1_000), D(8_450))


def test_ac5_a_row_from_a_shared_account_never_counts_and_a_transfer_into_one_is_spending(w):
    partner = w.people("Pat", "Partner")
    checking = w.account()
    joint = w.account(owner=partner)
    sw_share(w.db, joint, w.me["id"], "editor", partner["id"])
    w.anchor(checking)
    w.txn(checking, "credit", 10_000)
    w.txn(joint, "transfer", 5_000, to=checking)            # from the shared account
    w.txn(joint, "transfer", 2_000, to=checking, by=partner)
    w.txn(checking, "transfer", 1_200, to=joint, fee=10)    # into it: row 9
    f = figures(w.compute())
    assert (f["income"], f["spending"]) == (D(10_000), D(1_210))


# --- AC6: the window ----------------------------------------------------------------------

def test_ac6_full_manila_months_the_latest_twelve_and_not_the_current_month(w):
    checking = w.account()
    w.txn(checking, "credit", 1, day=datetime(2025, 1, 5))                # starts history
    w.txn(checking, "credit", 999, day=datetime(2025, 10, 31))            # before the window
    w.txn(checking, "credit", 1_200, day=datetime(2025, 11, 1))           # first month
    w.txn(checking, "credit", 2_400, day=datetime(2026, 9, 30, 16, 30))   # 1 Oct in Manila
    w.txn(checking, "credit", 777, day=datetime(2026, 10, 31, 17, 0))     # 1 Nov in Manila
    w.txn(checking, "credit", 555, day=datetime(2026, 11, 3))             # this month
    f = figures(w.compute())
    assert f["sample_months"] == 12
    assert f["income"] == D(300)          # (1,200 + 2,400) / 12


def test_ac6_the_window_starts_the_month_after_the_earliest_row(w):
    checking = w.account()
    w.txn(checking, "credit", 600, day=datetime(2026, 8, 20))     # its month is left out
    w.txn(checking, "credit", 1_000, day=datetime(2026, 9, 2))
    w.txn(checking, "credit", 2_000, day=datetime(2026, 10, 2))
    f = figures(w.compute())
    assert (f["sample_months"], f["income"]) == (2, D(1_500))


def test_ac6_one_grouped_query_with_collapsed_keys_loads_a_bounded_number_of_rows(w):
    from app.services import free_flow

    stranger = w.people("Sam", "Stranger")
    checking, savings = w.account(), w.account("savings")
    outsiders = [w.account(owner=stranger) for _ in range(3)]
    tracked = w.category()
    w.goal(mode="transaction_total", category=tracked, monthly=100)
    untracked = [w.category() for _ in range(5)]
    w.anchor(checking)
    for i in range(40):
        w.txn(checking, "debit", 10, category=untracked[i % 5])        # one key
    for o in outsiders:
        w.txn(checking, "transfer", 10, to=o)                          # one key
    w.txn(checking, "transfer", 10, to=savings, category=tracked)      # its own key
    w.txn(checking, "transfer", 10, to=savings, category=untracked[0])

    start, end = datetime(2026, 9, 30, 16), datetime(2026, 10, 31, 16)
    rows = free_flow.grouped_rows(w.db, w.me["id"], {checking, savings}, start, end, {tracked})
    assert len(rows) == 4
    outside = [r for r in rows if r.counter == free_flow.OUTSIDE]
    assert len(outside) == 1 and outside[0].amount == D(30)

    # The statements run do not grow with the number of transactions.
    def count():
        seen = []
        engine = w.db.get_bind()
        listener = lambda *args: seen.append(args[2])  # noqa: E731
        event.listen(engine, "before_cursor_execute", listener)
        try:
            w.compute()
        finally:
            event.remove(engine, "before_cursor_execute", listener)
        return seen

    before = count()
    for _ in range(30):
        w.txn(checking, "debit", 5, category=untracked[1])
    after = count()
    assert len(after) == len(before)
    assert sum("GROUP BY" in s and "free_flow_rows" in s for s in after) == 1


# --- AC7: the figures ---------------------------------------------------------------------

def test_ac7_the_figures_as_defined(w):
    checking, savings, loan = w.account(), w.account("savings"), w.account("loan")
    other_savings = w.account("savings")
    w.anchor(checking)
    w.txn(checking, "credit", 50_000)
    w.txn(checking, "debit", 20_000)
    w.txn(checking, "transfer", 5_000, to=loan)
    w.txn(checking, "transfer", 8_000, to=savings)
    w.txn(savings, "transfer", 3_000, to=checking)
    g = w.goal(mode="target_balance", account=other_savings, monthly=2_000)
    result = w.compute()
    assert figures(result) == {
        "status": "ok", "sample_months": 1, "income": D(50_000), "spending": D(20_000),
        "debt_paid": D(5_000), "net_flow": D(25_000), "saved": D(5_000),
        "goal_top_up": D(2_000), "reserved": D(7_000), "free_flow": D(18_000),
        "shortfall": D(0)}
    assert goal(result, g).fed == D(0)


def test_ac7_saving_that_comes_back_lowers_saved_never_below_zero(w):
    checking, savings = w.account(), w.account("savings", balance=50_000)
    w.anchor(checking)
    w.txn(checking, "credit", 10_000)
    w.txn(checking, "transfer", 1_000, to=savings)
    w.txn(savings, "transfer", 4_000, to=checking)
    f = figures(w.compute())
    assert (f["saved"], f["income"], f["net_flow"]) == (D(0), D(10_000), D(10_000))


def test_ac7_a_shortfall_in_one_currency_zeroes_free_flow_in_the_others(w):
    php, usd = w.account(), w.account(currency="USD")
    w.anchor(php)
    w.txn(php, "credit", 10_000)
    w.txn(usd, "credit", 100)
    w.txn(usd, "debit", 90)
    g = w.goal(mode="target_balance", account=w.account("savings", "USD"), monthly=50,
               currency="USD")
    result = w.compute()
    p, u = figures(result), figures(result, "USD")
    assert (u["net_flow"], u["reserved"], u["shortfall"]) == (D(10), D(50), D(40))
    assert (p["net_flow"], p["shortfall"], p["free_flow"]) == (D(10_000), D(0), D(0))
    assert goal(result, g).top_up == D(50)


# --- AC8: single currency first -----------------------------------------------------------

def _two_incomes(w):
    php, usd = w.account(), w.account(currency="USD")
    w.anchor(php)
    w.txn(php, "credit", 10_000)
    w.txn(usd, "credit", 500)
    return php, usd


def _assert_incomplete_everywhere(result):
    assert result.status == "incomplete"
    for r in result.rows:
        assert r.status == "incomplete"
        assert (r.net_flow, r.free_flow, r.shortfall, r.reserved, r.goal_top_up) == (
            None, None, None, None, None)
    for g in result.goals:
        assert (g.pace, g.fed, g.top_up, g.underfunded) == (None, None, None, None)


def test_ac8_a_transfer_between_own_accounts_in_different_currencies(w):
    php, usd = _two_incomes(w)
    w.txn(php, "transfer", 5_800, to=usd)
    result = w.compute()
    _assert_incomplete_everywhere(result)
    assert statuses(result) == {"PHP": "incomplete", "USD": "incomplete"}


def test_ac8_a_card_paid_from_another_currency(w):
    php, usd = _two_incomes(w)
    card = w.account("credit", "USD")
    w.txn(card, "debit", 50)
    w.txn(php, "transfer", 2_900, to=card)
    _assert_incomplete_everywhere(w.compute())


def test_ac8_a_row_whose_stored_currency_is_not_its_accounts(w):
    php, usd = _two_incomes(w)
    w.txn(php, "debit", 20, currency="USD")
    _assert_incomplete_everywhere(w.compute())


def test_ac8_a_goal_counting_money_in_another_currency(w):
    _two_incomes(w)
    w.goal(mode="target_balance", account=w.account("savings", "USD", balance=10),
           monthly=100, currency="PHP")
    _assert_incomplete_everywhere(w.compute())


def test_ac8_a_category_goal_counting_a_row_in_another_currency(w):
    php, usd = _two_incomes(w)
    cat = w.category()
    w.goal(mode="transaction_total", category=cat, monthly=100, currency="PHP")
    w.txn(usd, "debit", 5, category=cat)
    _assert_incomplete_everywhere(w.compute())


def test_ac8_a_goal_with_a_missing_rate(w):
    # The test rates hold no EUR: the progress this goal counts has a missing rate.
    _two_incomes(w)
    w.goal(mode="multi_account", accounts=[w.account("savings", "EUR", balance=5)],
           monthly=100)
    _assert_incomplete_everywhere(w.compute())


def test_ac8_a_goal_with_a_top_up_in_a_currency_with_no_income(w):
    _two_incomes(w)
    g = w.goal(kind="goal", monthly=100, currency="EUR")
    result = w.compute()
    _assert_incomplete_everywhere(result)
    assert goal(result, g).unreserved is True
    assert statuses(result) == {"PHP": "incomplete", "USD": "incomplete", "EUR": "incomplete"}


def test_ac8_a_transfer_to_an_outside_account_never_triggers_it(w):
    stranger = w.people("Sam", "Stranger")
    php, usd = _two_incomes(w)
    w.txn(php, "transfer", 5_800, to=w.account(currency="USD", owner=stranger))
    result = w.compute()
    assert statuses(result) == {"PHP": "ok", "USD": "ok"}
    assert figures(result)["spending"] == D(5_800)


# --- AC9: row status ----------------------------------------------------------------------

def test_ac9_no_full_month_is_not_estimated_before_anything_else(w):
    php, usd = w.account(), w.account(currency="USD")
    w.txn(php, "credit", 10_000, day=datetime(2026, 11, 2))
    w.txn(php, "transfer", 100, to=usd, day=datetime(2026, 11, 3))   # cross, but no window
    g = w.goal(kind="goal", monthly=100)
    result = w.compute()
    assert result.status == "not_estimated"
    assert statuses(result) == {"PHP": "not_estimated", "USD": "not_estimated"}
    for r in result.rows:
        assert r.sample_months == 0
        assert all(getattr(r, k) is None for k in ("income", "spending", "debt_paid", "net_flow",
                                                   "saved", "goal_top_up", "reserved",
                                                   "free_flow", "shortfall"))
    assert goal(result, g).pace is None


def test_ac9_a_new_user_is_not_estimated(w):
    w.account()
    assert w.compute().status == "not_estimated"


def test_ac9_a_cross_currency_caller_is_incomplete_with_or_without_income(w):
    php, usd = w.account(), w.account(currency="USD")
    w.anchor(php)
    w.txn(php, "credit", 10_000)                  # USD has no income
    w.txn(php, "transfer", 580, to=usd)
    result = w.compute()
    assert statuses(result) == {"PHP": "incomplete", "USD": "incomplete"}
    p = figures(result)
    # The classified figures are kept, marked partial by the status.
    assert (p["income"], p["spending"], p["saved"]) == (D(10_000), D(0), D(0))


def test_ac9_no_income_is_no_projection_and_otherwise_ok(w):
    php, usd = w.account(), w.account(currency="USD")
    w.anchor(php)
    w.txn(php, "credit", 10_000)
    w.txn(usd, "debit", 20)
    result = w.compute()
    assert statuses(result) == {"PHP": "ok", "USD": "no_projection"}
    u = figures(result, "USD")
    assert (u["net_flow"], u["free_flow"], u["shortfall"]) == (None, None, None)
    assert (u["spending"], u["saved"], u["reserved"]) == (D(20), D(0), D(0))
    # A no-projection currency has no shortfall, so it takes nothing from the others.
    assert figures(result)["free_flow"] == D(10_000)


# --- AC10, AC11: goals and pace -----------------------------------------------------------

def test_ac10_a_goal_that_cannot_reserve_never_blocks(w):
    php = w.account()
    w.anchor(php)
    w.txn(php, "credit", 10_000)
    eur = w.account("savings", "EUR", balance=100)
    usd = w.account("savings", "USD", balance=100)
    skipped = [
        w.goal(mode="target_balance", account=eur, target=5_000),            # no date, no monthly
        w.goal(mode="target_balance", account=usd, target=5_000, monthly=0),
        w.goal(mode="multi_account", accounts=[eur, usd], due=DUE),           # date, no amount
        w.goal(kind="goal", target=1_000, currency="EUR"),
    ]
    can = w.goal(mode="target_balance", account=w.account("savings"), monthly=500)
    result = w.compute()
    assert statuses(result)["PHP"] == "ok"
    assert [g.allocation_id for g in result.goals] == [can]
    assert not set(skipped) & {g.allocation_id for g in result.goals}


@pytest.mark.parametrize("target,current,monthly,due,pace", [
    (1_000, 1_000, None, DUE, 0),            # already reached
    (1_000, 0, None, datetime(2027, 2, 28), D("333.34")),  # 3 months, rounded up
    (10_000, 4_000, 500, None, 500),          # no date: the monthly target
    (10_000, 9_800, 500, None, 200),          # ...never more than is left
    (None, 0, 750, DUE, 750),                 # no amount: monthly target, date ignored
])
def test_ac11_each_row_of_the_pace_table(w, target, current, monthly, due, pace):
    php = w.account()
    w.anchor(php)
    w.txn(php, "credit", 100_000)
    g = w.goal(kind="goal", target=target, current=current, monthly=monthly, due=due)
    assert goal(w.compute(), g).pace == D(pace)


def test_ac11_a_monthly_target_of_zero_has_pace_zero(w):
    from app.models.allocation import Allocation
    from app.services.free_flow import can_reserve, pace_of

    a = Allocation(target_amount=D(5_000), monthly_target=D(0), target_date=None)
    assert can_reserve(a) is False
    assert pace_of(a, D(0), TODAY) == (D(0), False)
    php = w.account()
    w.anchor(php)
    w.txn(php, "credit", 1_000)
    w.goal(kind="goal", target=5_000, monthly=0)
    result = w.compute()
    assert result.goals == [] and figures(result)["goal_top_up"] == D(0)


@pytest.mark.parametrize("target,months", [
    (date(2027, 2, 1), 2),      # a date on the 1st does not count its month
    (date(2027, 1, 31), 2),     # the last day counts its month
    (date(2027, 2, 28), 3),
    (date(2026, 11, 30), 1),    # this month
    (date(2026, 11, 1), 1),
    (date(2026, 6, 15), 1),     # the past
])
def test_ac11_months_left(target, months):
    from app.services.free_flow import months_left

    assert months_left(target, TODAY) == months


def test_ac11_a_goal_past_its_date_reserves_all_it_needs_and_is_overdue(w):
    php = w.account()
    w.anchor(php)
    w.txn(php, "credit", 100_000)
    late = w.goal(kind="goal", target=9_000, current=1_000, due=datetime(2026, 10, 1))
    on_time = w.goal(kind="goal", target=9_000, current=1_000, due=DUE)
    result = w.compute()
    assert (goal(result, late).pace, goal(result, late).overdue) == (D(8_000), True)
    assert (goal(result, on_time).pace, goal(result, on_time).overdue) == (D(1_600), False)


# --- AC12: what a goal counts -------------------------------------------------------------

def test_ac12_a_balance_goal_counts_nothing_on_a_checking_or_wallet_account(w):
    checking = w.account(balance=40_000)
    wallet = w.account("e_wallet", balance=5_000)
    w.anchor(checking)
    w.txn(checking, "credit", 100_000)
    one = w.goal(mode="target_balance", account=checking, target=10_000, due=DUE)
    two = w.goal(mode="multi_account", accounts=[wallet, checking], target=5_000, due=DUE)
    result = w.compute()
    assert (goal(result, one).pace, goal(result, two).pace) == (D(2_000), D(1_000))


def test_ac12_a_category_goal_ignores_outside_accounts_and_its_displayed_progress_is_kept(w):
    partner = w.people("Pat", "Partner")
    checking, savings = w.account(), w.account("savings")
    joint = w.account(owner=partner)
    sw_share(w.db, joint, w.me["id"], "editor", partner["id"])
    w.anchor(checking)
    w.txn(checking, "credit", 100_000)
    cat = w.category()
    g = w.goal(mode="transaction_total", category=cat, target=10_000, due=DUE)
    w.txn(checking, "transfer", 2_000, to=savings, category=cat)   # counts
    w.txn(joint, "debit", 3_000, category=cat)                     # on an outside account
    w.txn(checking, "transfer", 1_000, to=joint, category=cat)     # to an outside account
    assert goal(w.compute(), g).pace == D(1_600)                   # (10,000 - 2,000) / 5

    r = w.client.get(f"{API}/allocations/{g}", headers=w.me["headers"])
    assert r.status_code == 200, r.text
    assert r.json()["current_amount"] == 6_000.0   # savings_progress is unchanged


# --- AC13: shared money is given out in rank order ----------------------------------------

def _income(w):
    checking = w.account()
    w.anchor(checking)
    w.txn(checking, "credit", 100_000)
    return checking


def test_ac13_two_goals_on_one_account_do_not_both_claim_it(w):
    _income(w)
    savings = w.account("savings", balance=10_000)
    first = w.goal(mode="target_balance", account=savings, target=8_000, due=DUE)
    second = w.goal(mode="multi_account", accounts=[savings], target=8_000, due=DUE)
    result = w.compute()
    assert (goal(result, first).pace, goal(result, second).pace) == (D(0), D(1_200))


def test_ac13_two_goals_on_one_category_do_not_both_claim_it(w):
    checking = _income(w)
    cat = w.category()
    w.txn(checking, "transfer", 10_000, to=w.account("savings"), category=cat)
    first = w.goal(mode="transaction_total", category=cat, target=8_000, due=DUE)
    second = w.goal(mode="transaction_total", category=cat, target=8_000, due=DUE)
    result = w.compute()
    assert (goal(result, first).pace, goal(result, second).pace) == (D(0), D(1_200))


def _category_and_balance(w):
    checking = _income(w)
    savings = w.account("savings", balance=15_000)
    cat = w.category()
    w.txn(checking, "transfer", 10_000, to=savings, category=cat,
          day=datetime(2026, 8, 1))
    return savings, cat


def test_ac13_a_higher_category_goal_takes_the_shared_transfers_first(w):
    savings, cat = _category_and_balance(w)
    tagged = w.goal(mode="transaction_total", category=cat, target=8_000, due=DUE)
    balance = w.goal(mode="target_balance", account=savings, target=20_000, due=DUE)
    result = w.compute()
    # The balance goal loses only the 8,000 the category goal took: 15,000 - 8,000.
    assert goal(result, tagged).pace == D(0)
    assert goal(result, balance).pace == D(2_600)          # (20,000 - 7,000) / 5


def test_ac13_a_higher_balance_goal_takes_the_shared_transfers_first(w):
    savings, cat = _category_and_balance(w)
    balance = w.goal(mode="target_balance", account=savings, target=12_000, due=DUE)
    tagged = w.goal(mode="transaction_total", category=cat, target=8_000, due=DUE)
    result = w.compute()
    # The 12,000 taken first is the 10,000 tagged, then 2,000 of the rest.
    assert goal(result, balance).pace == D(0)
    assert goal(result, tagged).pace == D(1_600)           # 8,000 / 5: nothing left


def test_ac13_one_category_claim_is_taken_once_across_several_balances(w):
    # Audit finding 3: a 10,000 claim came off each of two accounts in full.
    checking = _income(w)
    a = w.account("savings", balance=10_000)
    b = w.account("savings", balance=10_000)
    cat = w.category()
    w.txn(checking, "transfer", 10_000, to=a, category=cat, day=datetime(2026, 8, 1))
    w.txn(checking, "transfer", 10_000, to=b, category=cat, day=datetime(2026, 8, 1))
    w.goal(mode="transaction_total", category=cat, target=10_000, due=DUE)
    both = w.goal(mode="multi_account", accounts=[a, b], target=20_000, due=DUE)
    assert goal(w.compute(), both).pace == D(2_000)        # current 10,000


@pytest.mark.parametrize("listed", ["untagged_first", "tagged_first"])
def test_ac13_a_higher_goal_takes_shared_money_first_whatever_its_account_order(w, listed):
    # Audit finding 5: listing the untagged account first let the higher goal skip
    # the shared deposit.
    checking = _income(w)
    untagged = w.account("savings", balance=10_000)
    tagged_into = w.account("savings", balance=10_000)
    cat = w.category()
    w.txn(checking, "transfer", 10_000, to=tagged_into, category=cat, day=datetime(2026, 8, 1))
    ids = [untagged, tagged_into] if listed == "untagged_first" else [tagged_into, untagged]
    w.goal(mode="multi_account", accounts=ids, target=10_000, due=DUE)
    tagged = w.goal(mode="transaction_total", category=cat, target=10_000, due=DUE)
    assert goal(w.compute(), tagged).pace == D(2_000)      # current 0


def test_ac13_a_negative_savings_balance_counts_in_a_combined_current(w):
    # Audit finding 6: the -10,000 balance was clamped to 0 and the goal read as done.
    _income(w)
    up = w.account("savings", balance=10_000)
    down = w.account("savings", balance=-10_000)
    g = w.goal(mode="multi_account", accounts=[up, down], target=10_000, due=DUE)
    assert goal(w.compute(), g).pace == D(2_000)           # combined balance 0


# --- AC14: fed ----------------------------------------------------------------------------

def _monthly(w, savings, cat, first="balance"):
    balance = dict(mode="target_balance", account=savings, monthly=1_000)
    tagged = dict(mode="transaction_total", category=cat, monthly=1_000)
    a = w.goal(**(balance if first == "balance" else tagged))
    b = w.goal(**(tagged if first == "balance" else balance))
    return a, b


@pytest.mark.parametrize("first", ["balance", "category"])
def test_ac14_money_feeds_one_goal_only_in_rank_order_across_modes(w, first):
    checking = _income(w)
    savings = w.account("savings")
    cat = w.category()
    w.txn(checking, "transfer", 1_000, to=savings, category=cat)   # one month's transfers
    top, below = _monthly(w, savings, cat, first)
    result = w.compute()
    assert (goal(result, top).fed, goal(result, below).fed) == (D(1_000), D(0))
    assert (goal(result, top).top_up, goal(result, below).top_up) == (D(0), D(1_000))


def test_ac14_two_goals_sharing_one_months_transfers_never_feed_the_same_peso(w):
    checking = _income(w)
    savings = w.account("savings")
    cat = w.category()
    w.txn(checking, "transfer", 600, to=savings, category=cat)
    w.txn(checking, "transfer", 600, to=savings, category=cat)
    a = w.goal(mode="transaction_total", category=cat, monthly=1_000)
    b = w.goal(mode="transaction_total", category=cat, monthly=1_000)
    c = w.goal(mode="target_balance", account=savings, monthly=1_000)
    result = w.compute()
    fed = [goal(result, i).fed for i in (a, b, c)]
    assert fed == [D(1_000), D(200), D(0)]
    assert sum(fed) == figures(result)["saved"] == D(1_200)


def test_ac14_fed_never_exceeds_saved(w):
    checking = _income(w)
    tagged_into, elsewhere = w.account("savings"), w.account("savings", balance=5_000)
    cat = w.category()
    w.txn(checking, "transfer", 1_000, to=tagged_into, category=cat)
    w.txn(elsewhere, "transfer", 800, to=checking)                  # saving that came back
    g = w.goal(mode="transaction_total", category=cat, monthly=1_000)
    result = w.compute()
    assert figures(result)["saved"] == D(200)
    assert goal(result, g).fed == D(200)


@pytest.mark.parametrize("left_to", ["pool", "savings"])
def test_ac14_a_tagged_deposit_that_left_its_account_feeds_nothing(w, left_to):
    checking = _income(w)
    first, second = w.account("savings"), w.account("savings")
    cat = w.category()
    w.txn(checking, "transfer", 1_000, to=first, category=cat)
    w.txn(first, "transfer", 1_000, to=checking if left_to == "pool" else second)
    w.txn(checking, "transfer", 1_000, to=w.account("savings"))     # saving elsewhere
    g = w.goal(mode="transaction_total", category=cat, monthly=1_000)
    result = w.compute()
    assert figures(result)["saved"] > D(0)
    assert goal(result, g).fed == D(0)


def test_ac14_salary_credited_to_a_checking_account_a_goal_tracks_is_not_fed(w):
    checking = _income(w)
    g = w.goal(mode="target_balance", account=checking, monthly=1_000)
    result = w.compute()
    assert (goal(result, g).fed, goal(result, g).top_up) == (D(0), D(1_000))


# --- AC15 ---------------------------------------------------------------------------------

@pytest.mark.parametrize("first", ["category", "balance"])
def test_ac15_tagged_money_moved_on_to_a_balance_goals_account_is_counted_once(w, first):
    checking = _income(w)
    paid_into = w.account("savings", balance=0)
    moved_to = w.account("savings", balance=10_000)
    cat = w.category()
    w.txn(checking, "transfer", 10_000, to=paid_into, category=cat, day=datetime(2026, 8, 1))
    w.txn(paid_into, "transfer", 10_000, to=moved_to, day=datetime(2026, 8, 2))
    tagged_kw = dict(mode="transaction_total", category=cat, target=10_000, due=DUE)
    balance_kw = dict(mode="target_balance", account=moved_to, target=10_000, due=DUE)
    if first == "category":
        top, below = w.goal(**tagged_kw), w.goal(**balance_kw)
    else:
        top, below = w.goal(**balance_kw), w.goal(**tagged_kw)
    result = w.compute()
    # The higher-ranked goal is complete; the lower-ranked one gives the money up.
    assert (goal(result, top).pace, goal(result, below).pace) == (D(0), D(2_000))


# --- AC16, AC17, AC18 ---------------------------------------------------------------------

def test_ac16_saving_toward_a_goal_type_row_is_never_fed_and_its_pace_is_reserved(w):
    # Plan 2.4 limitation (audit-opus#11): a goal-type row has no fed.
    checking = _income(w)
    w.txn(checking, "transfer", 1_000, to=w.account("savings"))
    g = w.goal(kind="goal", monthly=1_000)
    result = w.compute()
    assert (goal(result, g).fed, goal(result, g).top_up) == (D(0), D(1_000))
    f = figures(result)
    assert (f["saved"], f["goal_top_up"], f["reserved"]) == (D(1_000), D(1_000), D(2_000))


def test_ac17_a_top_up_is_reserved_only_in_the_goals_currency(w):
    php, usd = w.account(), w.account(currency="USD")
    w.anchor(php)
    w.txn(php, "credit", 10_000)
    w.txn(usd, "credit", 500)
    g = w.goal(kind="goal", monthly=100, currency="USD")
    result = w.compute()
    assert goal(result, g).top_up == D(100)
    assert (figures(result)["goal_top_up"], figures(result, "USD")["goal_top_up"]) == (
        D(0), D(100))


def test_ac17_saving_into_one_account_plus_an_unfed_goal_on_another_reserves_the_sum(w):
    checking = _income(w)
    w.txn(checking, "transfer", 1_000, to=w.account("savings"))
    w.goal(mode="target_balance", account=w.account("savings"), monthly=500)
    f = figures(w.compute())
    assert (f["saved"], f["goal_top_up"], f["reserved"]) == (D(1_000), D(500), D(1_500))


def test_ac18_the_lowest_ranked_goals_top_up_gives_way_first(w):
    checking = w.account()
    w.anchor(checking)
    w.txn(checking, "credit", 10_000)
    w.txn(checking, "debit", 8_000)
    top = w.goal(kind="goal", monthly=1_500)
    low = w.goal(kind="goal", monthly=1_500)
    result = w.compute()
    assert (goal(result, top).underfunded, goal(result, low).underfunded) == (D(0), D(1_000))
    f = figures(result)
    assert (f["shortfall"], f["free_flow"]) == (D(1_000), D(0))
    w.rerank(low, top)
    result = w.compute()
    assert (goal(result, low).underfunded, goal(result, top).underfunded) == (D(0), D(1_000))


# --- AC19: the route ----------------------------------------------------------------------

def _last_month(day=10):
    from app.core.time import manila_today

    first = manila_today().replace(day=1)
    return (first - timedelta(days=1)).replace(day=day)


def _get(w, who=None):
    r = w.client.get(f"{API}/wishlist/free-flow", headers=(who or w.me)["headers"])
    assert r.status_code == 200, r.text
    return r.json()


def _real_world(w):
    """``me`` with one full month on the real clock."""
    checking, savings = w.account(), w.account("savings")
    last = datetime.combine(_last_month(), datetime.min.time())
    w.anchor(checking, day=last - timedelta(days=40))
    w.txn(checking, "credit", 30_000, day=last)
    w.txn(checking, "debit", 10_000, day=last)
    w.txn(checking, "transfer", 4_000, to=savings, day=last)
    return checking, savings, last


def test_ac19_the_route_returns_the_rows_and_goals_fields(w):
    _, savings, _ = _real_world(w)
    g = w.goal(mode="target_balance", account=savings, monthly=5_000)
    body = _get(w)
    assert set(body) == {"rows", "goals", "limitations"}
    assert body["rows"] and set(body["rows"][0]) == {
        "currency", "status", "sample_months", "income", "spending", "debt_paid", "net_flow",
        "saved", "goal_top_up", "reserved", "free_flow", "shortfall"}
    php = next(r for r in body["rows"] if r["currency"] == "PHP")
    assert php["status"] == "ok" and php["sample_months"] >= 1
    assert body["goals"] == [{
        "allocation_id": g, "rank": 1, "currency": "PHP", "pace": 5_000.0,
        "fed": php["saved"], "top_up": 5_000.0 - php["saved"],
        "underfunded": 0.0, "unreserved": False, "overdue": False}]


def test_ac19_free_flow_is_registered_before_the_item_route():
    from app.routers.wishlist import router

    paths = [r.path for r in router.routes]
    assert paths.index("/free-flow") < paths.index("/{item_id}")


def test_ac19_another_users_goals_never_enter(w):
    _real_world(w)
    alone = _get(w)
    other = w.people("Oli", "Other")
    w.goal(kind="goal", monthly=9_000, owner=other)
    w.goal(mode="target_balance", account=w.account("savings", owner=other), monthly=500,
           owner=other)
    assert _get(w) == alone
    assert alone["goals"] == []


def test_ac19_a_user_with_no_shares_gets_the_same_figures_as_without_sharing(w):
    checking, _, last = _real_world(w)
    alone = _get(w)
    partner = w.people("Pat", "Partner")
    theirs = w.account(owner=partner)
    w.txn(theirs, "credit", 99_000, by=partner, day=last)
    w.txn(theirs, "transfer", 7_000, to=checking, by=partner, day=last)
    sw_share(w.db, theirs, w.me["id"], "admin", partner["id"])     # theirs, shared with me
    sw_share(w.db, checking, partner["id"], "editor", w.me["id"])  # mine, shared with them
    assert _get(w) == alone


# --- AC20: limitations --------------------------------------------------------------------

def test_ac20_the_limitations_list_the_relabelled_account_cases_as_not_detected(w):
    from app.models.account import Account
    from app.models.user import CurrencyType
    from app.services.free_flow import LIMITATIONS

    relabel = [t for t in LIMITATIONS if "relabelled" in t]
    assert len(relabel) == 1
    assert "re-stamped" in relabel[0] and "no rows" in relabel[0]
    assert "neither is detected" in relabel[0]

    # A savings account relabelled by hand, with no rows in the window, is not detected.
    _income(w)
    savings = w.account("savings", balance=500)
    w.db.get(Account, savings).currency = CurrencyType.USD
    w.db.commit()
    w.txn(w.account(currency="USD"), "credit", 50)
    w.goal(mode="target_balance", account=savings, target=600, due=DUE, currency="USD")
    result = w.compute()
    assert statuses(result) == {"PHP": "ok", "USD": "ok"}
    assert list(result.limitations) == list(LIMITATIONS)
