"""STU306Acceptance: retiring the single-currency projection helpers (STU-306).

``get_upcoming_items``, ``upcoming_items`` and ``get_payables`` (services/forecast.py)
were test-only references no route called. Their regression tests now read the
per-currency lists the routes use (``app/tests/projection_lists.py``) with unchanged
expected values, and the helpers are gone. ``INVENTORY`` is every collected scenario
that reached a helper on main 06a95a9, recorded before the move.

The type check (``timeline_event_rejects_unconverted``) is
``packages/shared/src/types/api.test-d.ts``, compiled by ``pnpm build``.
"""
import inspect
import os
import pathlib
import re
import subprocess
import sys
import xml.etree.ElementTree as ET

import pytest

from app.tests.conftest import sw_db_reachable

BACKEND = pathlib.Path(__file__).resolve().parents[2]
TESTS = "app/tests/"
RETIRED = ("get_upcoming_items", "upcoming_items", "get_payables")

# Every collected scenario that called a retired helper, directly or through a
# module helper, on main 06a95a9 (54 test functions, 70 scenarios).
INVENTORY = [
    "test_account_scope_parity_integration.py::test_account_scoped_projection_matches_the_single_owner_baseline",
    "test_account_scope_parity_integration.py::test_own_entries_on_an_inactive_own_account_move_no_cash",
    "test_household_projection_integration.py::test_household_occurrences_on_a_private_card_wallet_and_accountless_entry",
    "test_household_projection_integration.py::test_a_household_charge_on_a_privately_routed_card_less_the_joint_payment[0-100.0]",
    "test_household_projection_integration.py::test_a_household_charge_on_a_privately_routed_card_less_the_joint_payment[40-60.0]",
    "test_household_projection_integration.py::test_a_household_charge_on_a_privately_routed_card_less_the_joint_payment[100-None]",
    "test_household_projection_integration.py::test_a_mixed_statement_paid_from_joint_covers_the_household_line_first[50]",
    "test_household_projection_integration.py::test_a_mixed_statement_paid_from_joint_covers_the_household_line_first[100]",
    "test_household_projection_integration.py::test_a_household_bill_on_a_card_routed_to_joint_counts_once",
    "test_household_projection_integration.py::test_a_hidden_primary_with_joint_overflow_leaves_the_bill_at_face",
    "test_household_projection_integration.py::test_partner_records_on_joint_never_reach_the_tag_viewers_projection",
    "test_household_projection_integration.py::test_a_household_tagged_card_in_scope_projects_its_statement_without_detail",
    "test_household_projection_integration.py::test_a_recurring_household_charge_is_settled_after_the_transaction_rows",
    "test_household_projection_integration.py::test_transaction_and_recurring_household_charges_in_the_engines_order",
    "test_household_projection_integration.py::test_a_record_seen_directly_and_through_the_tag_share_appears_once",
    "test_household_views_integration.py::test_upcoming_view_lists_the_occurrence_once_and_no_private_spending",
    "test_loan_payables_integration.py::test_loan_payment_on_the_4th_leaves_the_paying_account_exactly_once",
    "test_loan_payables_integration.py::test_unposted_scheduled_payment_replaces_that_dates_payable",
    "test_loan_payables_integration.py::test_partial_planned_payment_suppresses_only_its_covered_amount",
    "test_loan_payables_integration.py::test_unposted_unmarked_transfer_into_the_loan_replaces_the_payable",
    "test_loan_payables_integration.py::test_recurring_transfer_into_the_loan_replaces_the_payable",
    "test_loan_payables_integration.py::test_materialised_recurring_loan_transfer_counts_once_and_advances_the_schedule",
    "test_loan_payables_integration.py::test_generic_transfer_into_a_loan_is_a_scheduled_payment",
    "test_loan_payables_integration.py::test_planned_prepayment_is_a_payable_and_does_not_cover_the_due_date",
    "test_loan_payables_integration.py::test_an_unposted_transfer_retargeted_into_a_loan_settles_its_due_date_once_posted",
    "test_loan_payables_integration.py::test_a_posted_transfer_retargeted_into_a_loan_settles_its_due_date",
    "test_loan_payables_integration.py::test_a_wallet_funded_recurring_loan_payment_covers_and_settles_its_due_date",
    "test_loan_payables_integration.py::test_a_card_funded_transfer_into_a_loan_settles_its_due_date_once",
    "test_loan_payables_integration.py::test_a_loan_paid_from_an_account_outside_the_scope_leaves_cash_only_in_its_view",
    "test_loan_payables_integration.py::test_a_payment_planned_next_year_leaves_this_months_due_date_projected",
    "test_loan_payables_integration.py::test_a_planned_payment_a_few_days_late_still_covers_its_due_date",
    "test_loan_payables_integration.py::test_a_loan_the_caller_cannot_access_is_a_neutral_payment_on_its_paying_account",
    "test_loan_payables_integration.py::test_a_payment_into_a_loan_the_caller_cannot_access_is_a_neutral_payment[8000-planned]",
    "test_loan_payables_integration.py::test_a_payment_into_a_loan_the_caller_cannot_access_is_a_neutral_payment[8000-recurring]",
    "test_loan_payables_integration.py::test_a_payment_into_a_loan_the_caller_cannot_access_is_a_neutral_payment[5000-planned]",
    "test_loan_payables_integration.py::test_a_payment_into_a_loan_the_caller_cannot_access_is_a_neutral_payment[5000-recurring]",
    "test_loan_payables_integration.py::test_posting_a_legacy_planned_transfer_into_a_loan_settles_its_due_date",
    "test_loan_payables_integration.py::test_posting_a_legacy_planned_transfer_with_no_fee_is_not_split[no_fee]",
    "test_loan_payables_integration.py::test_posting_a_legacy_planned_transfer_with_no_fee_is_not_split[null_fee]",
    "test_loan_payables_integration.py::test_a_transfer_retargeted_into_a_loan_without_a_fee_does_not_reuse_its_old_fee[no_fee]",
    "test_loan_payables_integration.py::test_a_transfer_retargeted_into_a_loan_without_a_fee_does_not_reuse_its_old_fee[null_fee]",
    "test_loan_payables_integration.py::test_a_transfer_retargeted_into_a_loan_keeps_an_explicit_fee",
    "test_projection_engine_integration.py::test_transfer_into_scope_from_outside_adds_the_amount[source]",
    "test_projection_engine_integration.py::test_transfer_into_scope_from_outside_adds_the_amount[destination]",
    "test_projection_engine_integration.py::test_cross_scope_transfer_touching_an_in_scope_card_is_listed_but_not_cash[into_card-outside]",
    "test_projection_engine_integration.py::test_cross_scope_transfer_touching_an_in_scope_card_is_listed_but_not_cash[into_card-card]",
    "test_projection_engine_integration.py::test_cross_scope_transfer_touching_an_in_scope_card_is_listed_but_not_cash[from_card-outside]",
    "test_projection_engine_integration.py::test_cross_scope_transfer_touching_an_in_scope_card_is_listed_but_not_cash[from_card-card]",
    "test_projection_engine_integration.py::test_overdue_cash_advance_is_cash_on_the_window_start_and_billed_on_its_statement",
    "test_projection_engine_integration.py::test_card_cash_advance_is_cash_now_and_repaid_through_its_statement",
    "test_projection_engine_integration.py::test_overdue_unposted_transactions_land_at_the_window_start_in_every_view",
    "test_projection_engine_integration.py::test_planned_card_payment_is_the_cash_and_nets_the_statement[12000.00-None]",
    "test_projection_engine_integration.py::test_planned_card_payment_is_the_cash_and_nets_the_statement[5000.00--7000.00]",
    "test_projection_engine_integration.py::test_unpaid_statement_due_before_the_window_is_overdue_on_the_start_in_every_view",
    "test_projection_engine_integration.py::test_card_installment_is_paid_exactly_once_inside_the_right_statement",
    "test_projection_engine_integration.py::test_payment_from_a_card_the_caller_cant_view_nets_the_statement",
    "test_projection_engine_integration.py::test_payment_from_an_unbilled_card_shared_with_the_caller_leaves_the_statement_payable",
    "test_projection_engine_integration.py::test_payment_from_an_inactive_unbilled_card_does_not_net_the_statement",
    "test_projection_engine_integration.py::test_refund_beyond_its_statement_reduces_the_next_payable_in_every_view",
    "test_projection_engine_integration.py::test_upcoming_items_come_from_collect_events",
    "test_projection_engine_integration.py::test_planned_payment_pays_the_oldest_unpaid_statement_and_each_peso_leaves_once",
    "test_projection_engine_integration.py::test_cash_entry_recorded_without_advancing_is_paid_once_in_payables_and_closings[True]",
    "test_projection_engine_integration.py::test_cash_entry_recorded_without_advancing_is_paid_once_in_payables_and_closings[False]",
    "test_shared_projection_integration.py::test_limited_events_have_the_allowlist_shape",
    "test_spending_wallet_projection_integration.py::test_statement_paid_from_a_wallet_does_not_take_cash_twice",
    "test_spending_wallet_projection_integration.py::test_top_ups_are_payables_so_timeline_monthly_and_payables_agree",
    "test_spending_wallet_projection_integration.py::test_recurring_transfers_materialised_without_advancing_move_money_once",
    "test_statement_timeline_integration.py::test_refund_in_a_later_cycle_bills_nothing_in_any_window[30]",
    "test_statement_timeline_integration.py::test_refund_in_a_later_cycle_bills_nothing_in_any_window[60]",
    "test_statement_timeline_integration.py::test_refund_in_a_later_cycle_bills_nothing_in_any_window[90]",
]

# The suites the move touched, plus the disposable figures' (the shared entry query).
AFFECTED = sorted({n.split("::")[0] for n in INVENTORY} | {
    "test_currency_projection_integration.py", "test_disposable_end_date_integration.py",
    "test_demo_projection_currency_integration.py"})


@pytest.fixture(scope="module")
def affected_run(tmp_path_factory):
    """One run of the affected suites in a fresh interpreter: (exit code, {node: outcome})."""
    if not sw_db_reachable():
        pytest.skip("no database available")
    report = tmp_path_factory.mktemp("stu306") / "report.xml"
    proc = subprocess.run(
        [sys.executable, "-m", "pytest", "-q", "-p", "no:cacheprovider",
         f"--junitxml={report}", *(TESTS + f for f in AFFECTED)],
        cwd=BACKEND, env=os.environ.copy(), capture_output=True, text=True, timeout=3000)
    outcomes = {}
    for case in ET.parse(report).getroot().iter("testcase"):
        module = case.get("classname").rsplit(".", 1)[-1]
        failed = case.find("failure") is not None or case.find("error") is not None
        skipped = case.find("skipped") is not None
        outcomes[f"{module}.py::{case.get('name')}"] = (
            "failed" if failed else "skipped" if skipped else "passed")
    return proc.returncode, outcomes, proc.stdout[-3000:]


class TestSTU306Acceptance:
    def test_migrated_helper_regressions_preserve_expected_values(self, affected_run):
        """AC1: every recorded scenario still runs, against the per-currency lists, and passes."""
        _, outcomes, tail = affected_run
        assert {n: outcomes.get(n) for n in INVENTORY} == {n: "passed" for n in INVENTORY}, tail
        for module in {n.split("::")[0] for n in INVENTORY}:
            source = (BACKEND / TESTS / module).read_text()
            assert "projection_lists import" in source, module

    def test_retired_helpers_are_absent(self):
        """AC2: no definition, import or call of a retired helper is left in the backend."""
        from app.services import forecast

        assert [name for name in RETIRED if hasattr(forecast, name)] == []
        pattern = re.compile(r"(?<![\w.])(" + "|".join(RETIRED) + r")\b")
        here = pathlib.Path(__file__).resolve()
        hits = [f"{path.relative_to(BACKEND)}:{i}"
                for path in sorted((BACKEND / "app").rglob("*.py")) if path != here
                for i, line in enumerate(path.read_text().splitlines(), 1)
                if pattern.search(line)]
        assert hits == []

    def test_disposable_functions_share_entry_query(self, sw_people, sw_db, monkeypatch):
        """AC3: both disposable functions read their entries through ``_disposable_entries``."""
        from app.core.context import RequestContext
        from app.services import forecast

        for fn in (forecast.get_disposable_income, forecast.disposable_by_currency):
            assert "db.query(BudgetEntry)" not in inspect.getsource(fn), fn.__name__
        calls = []
        shared = forecast._disposable_entries

        def spy(*args, **kwargs):
            calls.append(inspect.stack()[1].function)
            return shared(*args, **kwargs)

        monkeypatch.setattr(forecast, "_disposable_entries", spy)
        uid = sw_people("Shared", "Query")["id"]
        scalar = forecast.get_disposable_income(sw_db, uid)
        body = forecast.disposable_by_currency(RequestContext(sw_db, uid))
        assert calls == ["get_disposable_income", "disposable_by_currency"]
        assert {k: body[k] for k in forecast.DISPOSABLE_KEYS} == scalar

    def test_stale_helper_reference_fails(self):
        """Revert-and-fail: a test still naming a retired helper cannot import it."""
        for name in RETIRED:
            with pytest.raises(ImportError):
                exec(f"from app.services.forecast import {name}", {})

    def test_affected_suite_behavior_is_unchanged(self, affected_run):
        """AC8: every affected suite passes as a whole, nothing failing or skipped."""
        code, outcomes, tail = affected_run
        assert code == 0, tail
        assert outcomes and [n for n, o in outcomes.items() if o != "passed"] == [], tail
