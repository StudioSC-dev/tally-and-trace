"""The projection's per-account queries do not grow with the card and loan count
(STU-470; Sentry STU-374, STU-459, STU-467).

``forecast.collect_events`` read each card's and loan's role from a fresh
``RecordAccess.load`` (an accounts query plus the shares and tags loads), per
card and per loan. The accounts are already in hand, so a snapshot or timeline
with 4 cards and 4 loans issues the same per-account queries as one with 1 and 1.
The snapshot's owed card statements look up the viewable accounts and the cards'
transactions once for all cards, not once per card.
Skips without a database.

Reference: Thursday 2027-03-18, 02:00 UTC (10:00 in Manila).
"""
import re
from datetime import datetime

import pytest
from sqlalchemy import event

from app.tests.conftest import API, sw_db_reachable
from app.tests.test_card_charges_integration import pin_clock
from app.tests.test_statement_minimum_integration import _account, _debit

pytestmark = pytest.mark.skipif(not sw_db_reachable(), reason="DATABASE_URL not reachable")

REF = datetime(2027, 3, 18, 2, 0)

# The per-account loads a role check pulled in: accounts by id, shares, tags.
ACCOUNT_BY_ID = re.compile(r"FROM accounts\s+WHERE accounts\.id IN", re.S)
# The shares load that follows an account load (``lazy="selectin"``), not a share filter.
SHARES = re.compile(r"SELECT account_shares\.account_id AS account_shares_account_id")
TAGS = re.compile(r"FROM account_tags\b|FROM tags\b")


def _loan(client, who, paying, n):
    return _account(client, who, f"Loan {n}", "loan", -90_000,
                    loan_kind="auto", loan_amortization="fixed", loan_annual_rate=6,
                    loan_term_months=12, loan_payment_amount=8_000,
                    loan_first_payment_date="2027-03-25", loan_payments_made_offset=0,
                    payment_account_id=paying)


def _build(client, who, checking, numbers):
    for n in numbers:
        card = _account(client, who, f"Card {n}", "credit", 0, billing_cycle_start=3,
                        days_until_due_date=21, credit_limit=200_000,
                        payment_account_id=checking)
        _debit(client, who, card, "2027-02-20", 1_000 + n)
        _loan(client, who, checking, n)


def _queries(client, who, path, **params):
    seen = []

    def record(conn, cursor, statement, parameters, context, executemany):
        seen.append(statement)

    from app.core.database import engine

    event.listen(engine, "before_cursor_execute", record)
    try:
        r = client.get(f"{API}{path}", headers=who["headers"], params=params)
    finally:
        event.remove(engine, "before_cursor_execute", record)
    assert r.status_code == 200, r.text
    return r.json(), {
        "accounts_by_id": sum(1 for s in seen if ACCOUNT_BY_ID.search(s)),
        "shares": sum(1 for s in seen if SHARES.search(s)),
        "tags": sum(1 for s in seen if TAGS.search(s)),
    }


@pytest.mark.parametrize("path,params", [
    ("/dashboard/snapshot", {}),
    ("/forecast/timeline", {"days": 60}),
])
def test_role_checks_do_not_query_per_card_or_loan(sw_client, sw_db, sw_people, monkeypatch,
                                                   path, params):
    pin_clock(monkeypatch, REF)
    me = sw_people()
    checking = _account(sw_client, me, "Checking", balance=50_000)
    _build(sw_client, me, checking, [0])
    body_one, one = _queries(sw_client, me, path, **params)
    _build(sw_client, me, checking, [1, 2, 3])  # 4 cards and 4 loans in all
    body_four, four = _queries(sw_client, me, path, **params)

    # The projection really carries the payables the role checks guard.
    text = str(body_four)
    for n in range(4):
        assert f"Loan {n}" in text and f"Card {n}" in text
    assert four == one, (one, four)


# The caller's viewable account ids, and the transactions touching a card read as
# ``_card_rows`` reads them (an OR over transfer columns, which only it issues).
VIEWABLE = re.compile(r"^\s*SELECT accounts\.id AS accounts_id\s+FROM accounts\s+"
                      r"WHERE accounts\.user_id = ", re.S)
CARD_ROWS = re.compile(r"FROM transactions\s+WHERE transactions\.account_id IN .*"
                       r"transactions\.transfer_to_account_id IN", re.S)


def test_snapshot_statements_due_reads_once_for_all_cards(sw_client, sw_db, sw_people,
                                                          monkeypatch):
    from app.core.database import engine

    pin_clock(monkeypatch, REF)
    me = sw_people()
    checking = _account(sw_client, me, "Checking", balance=50_000)

    def measure():
        seen = []

        def record(conn, cursor, statement, parameters, context, executemany):
            seen.append(statement)

        event.listen(engine, "before_cursor_execute", record)
        try:
            r = sw_client.get(f"{API}/dashboard/snapshot", headers=me["headers"])
        finally:
            event.remove(engine, "before_cursor_execute", record)
        assert r.status_code == 200, r.text
        return r.json(), {"viewable": sum(1 for s in seen if VIEWABLE.search(s)),
                          "card_rows": sum(1 for s in seen if CARD_ROWS.search(s))}

    _build(sw_client, me, checking, [0])
    body_one, one = measure()
    _build(sw_client, me, checking, [1, 2, 3])
    body_four, four = measure()
    assert len(body_four["card_statements_due"]) == 4  # the path really ran per card
    assert four == one, (one, four)
