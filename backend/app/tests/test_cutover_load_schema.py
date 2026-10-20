"""The cutover input schema and its validation (STU-202; plan v3, sections 2.1 and 2.6).

No database: these run the parser and every rule that needs none on the
synthetic fixture ``data/cutover_load/base.json`` (invented round figures),
changed one rule at a time.
"""
import copy
import json
import os
from datetime import date
from decimal import Decimal

import pytest
from pydantic import ValidationError

from app.cutover_load.schema import parse_input
from app.cutover_load.validate import InputInvalid, validate_input

BASE = os.path.join(os.path.dirname(__file__), "data", "cutover_load", "base.json")


def base() -> dict:
    with open(BASE, encoding="utf-8") as fh:
        return json.load(fh)


def plan_of(data: dict):
    return validate_input(parse_input(json.dumps(data).encode()))


def problems_of(data: dict):
    with pytest.raises(InputInvalid) as exc:
        plan_of(data)
    return exc.value.problems


def checks(problems):
    return {(p.check, p.key) for p in problems}


def account(data, key):
    return next(a for a in data["accounts"] if a["key"] == key)


def row(data, key):
    return next(t for t in data["transactions"] if t["key"] == key)


def entry(data, key):
    return next(e for e in data["budget_entries"] if e["key"] == key)


def test_base_fixture_is_valid_and_computes_openings():
    plan = plan_of(base())
    assert plan.openings["bank"] == Decimal("50040.00")  # + the pre-cutover card payment
    assert plan.openings["card"] == Decimal("0")
    assert plan.openings["loan"] == Decimal("-300000.00")
    assert plan.openings["usd"] == Decimal("1000.00")
    assert [(s["close"], s["owed"]) for s in plan.card_sets["card"]] == [
        (date(2026, 2, 15), Decimal("60.00")), (date(2026, 3, 15), Decimal("60.00"))]
    assert plan.card_sets["spare"] == []
    keys = [t.key for t in plan.transactions]
    assert keys == sorted(keys, key=lambda k: (row(base(), k)["date"], k))
    phone = next(p for p in plan.entries if p.entry.key == "e_phone")
    assert (phone.is_active, phone.max_occurrences, phone.occurrences_paid_offset) == (False, 0, 6)
    laptop = next(p for p in plan.entries if p.entry.key == "e_laptop")
    assert (laptop.is_active, laptop.max_occurrences, laptop.occurrences_paid_offset) == (
        True, 8, 4)


# --- Test 18: schema ----------------------------------------------------------------------

def test_unknown_schema_version_is_refused():
    data = base()
    data["schema_version"] = 2
    with pytest.raises(ValidationError):
        plan_of(data)


@pytest.mark.parametrize("where", ["top", "account", "card", "transaction", "entry"])
def test_unknown_keys_are_refused(where):
    data = base()
    target = {"top": data, "account": account(data, "bank"),
              "card": account(data, "card")["card"], "transaction": row(data, "rent_mar"),
              "entry": entry(data, "e_rent")}[where]
    target["surprise"] = 1
    with pytest.raises(ValidationError):
        plan_of(data)


@pytest.mark.parametrize("value", ["10.001", "1e3", 10.5, "ten"])
def test_money_is_a_decimal_string_with_two_places(value):
    data = base()
    row(data, "rent_mar")["amount"] = value
    with pytest.raises(ValidationError):
        plan_of(data)


def test_dates_are_iso_local_dates():
    data = base()
    row(data, "rent_mar")["date"] = "2026-3-1"
    with pytest.raises(ValidationError):
        plan_of(data)


def test_unresolved_keys_are_refused():
    data = base()
    row(data, "rent_mar")["account_key"] = "nowhere"
    row(data, "hh_bill")["category_key"] = "nothing"
    entry(data, "e_rent")["transfer_to_account_key"] = "nobody"
    account(data, "card")["card"]["payment_account_key"] = "ghost"
    row(data, "topup")["tags"] = ["Unlisted"]
    found = checks(problems_of(data))
    assert {("reference", "rent_mar"), ("reference", "hh_bill"), ("reference", "e_rent"),
            ("reference", "card"), ("reference", "topup")} <= found


def test_duplicate_selectors_and_keys_are_refused():
    data = base()
    data["accounts"].append({**copy.deepcopy(account(data, "joint")), "key": "joint2",
                             "tags": []})
    data["transactions"].append(copy.deepcopy(row(data, "load_day")))
    found = checks(problems_of(data))
    assert ("duplicate_selector", "Joint Bank") in found
    assert ("duplicate_key", "load_day") in found


def test_a_listed_household_tag_is_refused():
    data = base()
    data["tags"].append({"name": "household"})
    assert ("reserved_tag", "household") in checks(problems_of(data))


@pytest.mark.parametrize("total,paid,ok", [(12, 13, False), (400, 10, False), (12, 12, True)])
def test_installment_arithmetic(total, paid, ok):
    data = base()
    entry(data, "e_laptop")["installment"] = {"total": total, "paid_count": paid}
    if ok:
        laptop = next(p for p in plan_of(data).entries if p.entry.key == "e_laptop")
        assert (laptop.is_active, laptop.max_occurrences) == (False, 0)
    else:
        assert ("installment", "e_laptop") in checks(problems_of(data))


def test_installment_needs_after_occurrences_and_back():
    data = base()
    entry(data, "e_laptop")["end_mode"] = "indefinite"
    entry(data, "e_rent")["end_mode"] = "after_occurrences"
    found = checks(problems_of(data))
    assert {("installment", "e_laptop"), ("installment", "e_rent")} <= found


# --- Test 2: the cutover boundary ---------------------------------------------------------

def test_a_card_line_the_day_before_the_cutover_counts():
    data = base()
    data["transactions"].append({"key": "c_feb28", "date": "2026-02-28", "type": "debit",
                                 "account_key": "card", "amount": "10.00", "is_posted": True})
    problems = problems_of(data)
    opening = next(p for p in problems if p.check == "card_opening")
    assert "10.00" in opening.detail
    account(data, "card")["balance_at_cutover"] = "-130.00"
    account(data, "card")["card"]["statements_at_cutover"][1]["owed"] = "70.00"
    assert plan_of(data).card_sets["card"][-1]["owed"] == Decimal("70.00")


def test_a_payment_the_day_before_the_cutover_adjusts_the_bank_opening():
    data = base()
    row(data, "c_pay")["date"] = "2026-02-28"
    assert plan_of(data).openings["bank"] == Decimal("50040.00")
    row(data, "c_pay")["date"] = "2026-03-01"
    data_after = data
    # Dated on the cutover date it is no longer pre-cutover: the bank's opening is its
    # balance at the cutover, and the card statements no longer net it.
    problems = problems_of(data_after)
    assert ("card_opening", "card") in checks(problems)


def test_a_bank_debit_before_the_cutover_is_refused():
    data = base()
    data["transactions"].append({"key": "b_feb", "date": "2026-02-27", "type": "debit",
                                 "account_key": "bank", "amount": "10.00", "is_posted": True})
    assert ("pre_cutover", "b_feb") in checks(problems_of(data))


def test_a_pre_cutover_transfer_from_a_card_or_unposted_is_refused():
    data = base()
    row(data, "c_pay")["is_posted"] = False
    data["transactions"].append({"key": "c2c", "date": "2026-02-26", "type": "transfer",
                                 "account_key": "spare", "to_account_key": "card",
                                 "amount": "1.00", "is_posted": True})
    found = checks(problems_of(data))
    assert {("pre_cutover", "c_pay"), ("pre_cutover", "c2c")} <= found


def test_a_posted_row_on_the_load_day_is_refused():
    data = base()
    row(data, "load_day")["is_posted"] = True
    assert ("load_day", "load_day") in checks(problems_of(data))


# --- Test 3: partial payment --------------------------------------------------------------

def test_a_partial_payment_entered_as_a_card_credit_is_refused():
    data = base()
    data["transactions"].remove(row(data, "c_pay"))
    data["transactions"].append({"key": "c_credit", "date": "2026-02-25", "type": "credit",
                                 "account_key": "card", "amount": "40.00", "is_posted": True})
    account(data, "bank")["balance_at_cutover"] = "50040.00"
    found = checks(problems_of(data))
    # The credit is a line of the open cycle: the older statement still owes 100.
    assert ("card_statements", "card") in found


# --- Test 4: card opening and statements --------------------------------------------------

def test_a_card_opening_of_five_is_refused_and_reported():
    data = base()
    account(data, "card")["balance_at_cutover"] = "-115.00"
    opening = next(p for p in problems_of(data) if p.check == "card_opening")
    assert opening.key == "card" and "5.00" in opening.detail


def test_statements_that_do_not_match_are_refused():
    data = base()
    account(data, "card")["card"]["statements_at_cutover"][0]["owed"] = "61.00"
    problem = next(p for p in problems_of(data) if p.check == "card_statements")
    assert "60.00" in problem.detail and "61.00" in problem.detail


def test_a_paid_historical_cycle_is_not_compared_and_listing_it_is_refused():
    data = base()
    data["transactions"] += [
        {"key": "c_dec", "date": "2025-12-20", "type": "debit", "account_key": "card",
         "amount": "30.00", "is_posted": True},
        {"key": "c_dec_pay", "date": "2026-01-05", "type": "transfer", "account_key": "bank",
         "to_account_key": "card", "amount": "30.00", "is_posted": True},
    ]
    plan = plan_of(data)  # the paid cycle closing 2026-01-15 is computed, not compared
    assert [s["close"] for s in plan.card_sets["card"]] == [date(2026, 2, 15), date(2026, 3, 15)]
    account(data, "card")["card"]["statements_at_cutover"].insert(
        0, {"close": "2026-01-15", "owed": "0.00"})
    assert ("card_statements", "card") in checks(problems_of(data))


def test_the_open_cycle_must_be_listed():
    data = base()
    account(data, "card")["card"]["statements_at_cutover"].pop()
    problem = next(p for p in problems_of(data) if p.check == "card_statements")
    assert "2026-03-15" in problem.detail


def test_an_unused_card_loads_empty_and_a_listed_statement_is_refused():
    assert plan_of(base()).card_sets["spare"] == []
    data = base()
    account(data, "spare")["card"]["statements_at_cutover"] = [
        {"close": "2026-03-05", "owed": "0.00"}]
    assert ("card_statements", "spare") in checks(problems_of(data))


# --- Test 5: loans ------------------------------------------------------------------------

def test_a_transfer_into_a_loan_without_a_fee_is_refused():
    data = base()
    del row(data, "loan_8")["transfer_fee"]
    assert ("loan_payment", "loan_8") in checks(problems_of(data))


def test_loan_terms_are_checked():
    data = base()
    account(data, "loan")["balance_at_cutover"] = "0.00"
    account(data, "loan")["loan"]["payments_made_offset"] = 37
    found = {p.detail for p in problems_of(data) if p.key == "loan"}
    assert any("below 0" in d for d in found)
    assert any("term_months" in d for d in found)


@pytest.mark.parametrize("value", ["missing", False, None])
def test_a_loan_without_the_partial_due_confirmation_is_refused(value):
    """Decision 16: no loan due date may be partly paid at the cutover. The input
    cannot show it, so C1 records the owner's confirmation per loan."""
    data = base()
    terms = account(data, "loan")["loan"]
    if value == "missing":
        terms.pop("no_partial_due_at_cutover", None)
    else:
        terms["no_partial_due_at_cutover"] = value
    assert ("loan_partial_due", "loan") in checks(problems_of(data))


def test_a_confirmed_loan_passes():
    data = base()
    account(data, "loan")["loan"]["no_partial_due_at_cutover"] = True
    plan_of(data)


def test_a_loan_row_before_the_cutover_is_refused():
    data = base()
    row(data, "loan_8")["date"] = "2026-02-20"
    assert ("pre_cutover", "loan_8") in checks(problems_of(data))


# --- Test 6: recurring entries ------------------------------------------------------------

def test_an_active_entry_before_the_load_date_is_refused():
    data = base()
    entry(data, "e_salary")["next_occurrence"] = "2026-03-09"
    assert ("recurring", "e_salary") in checks(problems_of(data))


def test_an_entry_on_or_before_its_last_imported_line_is_refused():
    data = base()
    entry(data, "e_rent")["last_imported_line_key"] = "load_day"
    entry(data, "e_rent")["next_occurrence"] = "2026-03-10"
    assert ("recurring", "e_rent") in checks(problems_of(data))


def test_a_matching_imported_line_on_the_next_occurrence_is_refused():
    data = base()
    entry(data, "e_rent")["next_occurrence"] = "2026-03-10"
    del entry(data, "e_rent")["last_imported_line_key"]
    data["transactions"].append({"key": "rent_apr", "date": "2026-03-10", "type": "debit",
                                 "account_key": "bank", "amount": "15000.00",
                                 "is_posted": False, "description": "Rent April"})
    problem = next(p for p in problems_of(data) if p.check == "recurring")
    assert problem.key == "e_rent" and "rent_apr" in problem.detail


def test_an_imported_loan_payment_is_matched_by_principal_plus_interest():
    data = base()
    row(data, "loan_8").update({"date": "2026-04-20", "is_posted": False})
    problem = next(p for p in problems_of(data) if p.check == "recurring")
    assert problem.key == "e_loan" and "loan_8" in problem.detail


def test_a_foreign_entry_is_matched_by_its_face():
    data = base()
    entry(data, "e_stream")["next_occurrence"] = "2026-03-10"
    row(data, "card_fx_pending")["face_amount"] = "10.00"
    problem = next(p for p in problems_of(data) if p.check == "recurring")
    assert problem.key == "e_stream" and "card_fx_pending" in problem.detail


def test_a_row_matching_two_entries_is_ambiguous_until_described():
    data = base()
    data["budget_entries"].append({
        "key": "e_parking", "name": "Parking", "entry_type": "expense", "amount": "15000.00",
        "currency": "PHP", "cadence": "monthly", "next_occurrence": "2026-04-01",
        "account_key": "bank"})
    problem = next(p for p in problems_of(data) if p.check == "ambiguous_match")
    assert problem.key == "rent_mar" and "e_rent" in problem.detail
    entry(data, "e_rent")["description_contains"] = "rent"
    entry(data, "e_parking")["description_contains"] = "parking"
    plan_of(data)


def test_a_duplicate_recurring_identity_is_refused():
    data = base()
    data["budget_entries"].append({**copy.deepcopy(entry(data, "e_rent")), "key": "e_rent2",
                                   "amount": "1.00", "last_imported_line_key": None})
    assert ("duplicate_entry", "Rent") in checks(problems_of(data))


def test_a_fully_paid_installment_loads_inactive():
    phone = next(p for p in plan_of(base()).entries if p.entry.key == "e_phone")
    assert phone.is_active is False and phone.entry.is_active is True


# --- STU-315: a recurring entry's day fields --------------------------------------------

def test_a_last_weekday_entry_on_its_last_weekday_is_accepted():
    data = base()
    entry(data, "e_rent").update(next_occurrence="2026-10-30", day_rule="last_weekday")
    rent = next(p for p in plan_of(data).entries if p.entry.key == "e_rent")
    assert (rent.entry.day_rule, rent.entry.anchor_day) == ("last_weekday", None)


def test_a_last_weekday_entry_off_its_last_weekday_is_refused():
    data = base()
    entry(data, "e_rent").update(next_occurrence="2026-10-31", day_rule="last_weekday")
    problem = next(p for p in problems_of(data) if p.key == "e_rent")
    assert problem.check == "day_rule" and "2026-10-30" in problem.detail


def test_a_day_field_on_a_semi_monthly_entry_is_refused():
    for field, value in (("day_rule", "last_weekday"), ("anchor_day", 15)):
        data = base()
        entry(data, "e_salary")[field] = value
        assert ("day_rule", "e_salary") in checks(problems_of(data)), field


def test_an_anchor_must_be_the_next_occurrence_day_clamped():
    data = base()
    entry(data, "e_rent").update(next_occurrence="2026-04-30", anchor_day=31)
    assert plan_of(data).entries[0].entry.anchor_day == 31
    entry(data, "e_rent")["next_occurrence"] = "2026-05-10"
    assert ("day_rule", "e_rent") in checks(problems_of(data))


def test_an_anchor_and_a_rule_together_are_refused():
    data = base()
    entry(data, "e_rent").update(next_occurrence="2026-04-30", anchor_day=30,
                                 day_rule="last_weekday")
    assert ("day_rule", "e_rent") in checks(problems_of(data))


@pytest.mark.parametrize("field,value", [("anchor_day", 0), ("anchor_day", 32),
                                         ("day_rule", "first_weekday")])
def test_day_fields_out_of_range_are_refused_by_the_schema(field, value):
    data = base()
    entry(data, "e_rent")[field] = value
    with pytest.raises(ValidationError):
        plan_of(data)


# --- Test 7: currency rules ---------------------------------------------------------------

def test_a_posted_cross_currency_transfer_needs_received_amount():
    data = base()
    del row(data, "usd_move")["received_amount"]
    assert ("currency", "usd_move") in checks(problems_of(data))


def test_a_card_in_a_cross_currency_transfer_is_refused():
    data = base()
    data["transactions"].append({"key": "usd_card", "date": "2026-03-05", "type": "transfer",
                                 "account_key": "usd", "to_account_key": "card",
                                 "amount": "10.00", "received_amount": "580.00",
                                 "is_posted": True})
    assert ("currency", "usd_card") in checks(problems_of(data))


def test_foreign_rows_carry_the_right_figures():
    data = base()
    del row(data, "card_fx")["amount"]  # posted foreign: needs the actual amount
    row(data, "card_fx_pending")["amount"] = "20.00"  # unposted foreign: the face only
    row(data, "usd_spend")["face_currency"] = "USD"  # a face needs its figure
    found = checks(problems_of(data))
    assert {("currency", "card_fx"), ("currency", "card_fx_pending"),
            ("currency", "usd_spend")} <= found


def test_routing_stays_in_one_currency():
    data = base()
    account(data, "card")["card"]["payment_account_key"] = "usd"
    account(data, "loan")["loan"]["payment_account_key"] = "usd"
    found = {(p.check, p.key) for p in problems_of(data)}
    assert {("currency", "card"), ("currency", "loan")} <= found


def test_a_category_name_may_repeat_across_kinds_only():
    data = base()
    data["categories"].append({"key": "salary_out", "name": "Salary", "kind": "expense"})
    plan_of(data)  # an income and an expense "Salary" pass
    data["categories"].append({"key": "salary_out2", "name": "Salary", "kind": "expense"})
    problems = problems_of(data)
    assert ("duplicate_category", "Salary") in checks(problems)
    assert any(p.detail == "category 'Salary' (expense) is used more than once"
               for p in problems)
