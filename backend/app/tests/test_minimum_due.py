"""The minimum amount due formula and bank presets (STU-343 Plan C, 2.4; pure).

Every expected figure is the plan's (section 4.1, commit 3), from synthetic inputs.
"""
from decimal import Decimal

import pytest
from pydantic import ValidationError

from app.schemas.minimum_due import MinimumDueRule
from app.services.minimum_due import PRESETS, MinimumDueInputs, minimum_due


def D(value) -> Decimal:
    return Decimal(str(value))


def rule(key, **changes) -> MinimumDueRule:
    return PRESETS[key].rule.model_copy(update=changes)


def mad(r, currency="PHP", **inputs):
    return minimum_due(r, MinimumDueInputs(**{k: D(v) for k, v in inputs.items()}), currency)


TABLE = dict(outstanding=55_000, installments=10_000, new_transactions=45_000)
ARREARS = dict(outstanding=210_000, overlimit=10_000, overdue=2_000)


@pytest.mark.parametrize("key, changes, expected", [
    ("bdo", {}, "1650.00"),
    ("bdo", {"base_excludes": ["installments", "overlimit", "new_transactions"]}, "1150.00"),
    ("bdo_installment", {}, "11350.00"),
    ("metrobank", {}, "1925.00"),
    ("security_bank", {}, "1650.00"),
    ("hsbc", {}, "11500.00"),
])
def test_preset_table(key, changes, expected):
    amount, _ = mad(rule(key, **changes), **TABLE)
    assert amount == D(expected)


def test_hsbc_without_an_annual_fee_says_so():
    _, assumptions = mad(rule("hsbc"), **TABLE)
    assert "annual_fee_not_set" in assumptions


def test_new_transactions_switch_is_an_assumption():
    _, assumptions = mad(rule("bdo", base_excludes=["installments", "overlimit",
                                                     "new_transactions"]), **TABLE)
    assert "new_transactions_excluded" in assumptions
    _, assumptions = mad(rule("bdo"), **TABLE)
    assert "new_transactions_excluded" not in assumptions


@pytest.mark.parametrize("key, expected", [
    ("bdo", "18000.00"),
    ("metrobank", "18930.00"),
    ("security_bank", "18300.00"),
    ("hsbc", "12100.00"),
])
def test_overdue_and_overlimit(key, expected):
    amount, _ = mad(rule(key), **ARREARS)
    assert amount == D(expected)


def test_hsbc_annual_fee_twelfth_is_inside_the_floor():
    amount, assumptions = mad(rule("hsbc", annual_fee=D(2400)), outstanding=200_000)
    assert amount == D("2200.00")
    assert "annual_fee_not_set" not in assumptions
    amount, _ = mad(rule("hsbc"), outstanding=200_000)
    assert amount == D("2000.00")
    amount, _ = mad(rule("hsbc", annual_fee=D(2400)), **ARREARS)
    assert amount == D("12300.00")


def test_hsbc_raised_floor_adds_installments_after_it():
    amount, _ = mad(rule("hsbc", floor={"PHP": D(5000)}), **TABLE)
    assert amount == D("15000.00")


def test_capped_at_the_outstanding_balance():
    amount, _ = mad(rule("bdo"), outstanding=600)
    assert amount == D("600.00")


def test_nothing_owed_is_zero():
    amount, _ = mad(rule("bdo"), outstanding=-50)
    assert amount == D("0.00")


def test_usd_floor():
    amount, assumptions = mad(rule("bdo"), currency="USD", outstanding=300)
    assert amount == D("17.00")
    assert "floor_not_set_for_currency" not in assumptions


def test_a_currency_the_floor_does_not_list_counts_as_zero():
    amount, assumptions = mad(rule("bdo"), currency="EUR", outstanding=600)
    assert amount == D("18.00")
    assert "floor_not_set_for_currency" in assumptions


def test_bdo_rounds_down():
    amount, _ = mad(rule("bdo"), outstanding="33333.33")
    assert amount == D("999.99")


def test_metrobank_rounds_up():
    amount, _ = mad(rule("metrobank"), outstanding="100000.03")
    assert amount == D("3500.01")


def test_assumptions_always_name_fees_and_follow_the_rule():
    _, assumptions = mad(rule("security_bank"), **TABLE)
    assert assumptions == ["fees_not_itemised"]
    _, assumptions = mad(rule("bdo"), **TABLE)
    assert assumptions == ["fees_not_itemised", "installments_linked_only"]


def test_the_clamp_holds_for_an_unvalidated_negative_term():
    unvalidated = MinimumDueRule.model_construct(
        version=1, preset="custom", base_percent=D(1), base_excludes=[],
        installment_percent=None, floor={}, floored_terms=[],
        added_terms=["annual_fee_twelfth"], annual_fee=D(-1_200_000), rounding="half_up")
    amount, _ = mad(unvalidated, outstanding=1_000)
    assert amount == D("0.00")


def test_every_preset_is_a_valid_rule_served_with_string_decimals():
    assert set(PRESETS) == {"bdo", "bdo_installment", "metrobank", "security_bank", "hsbc"}
    for preset in PRESETS.values():
        served = preset.served()
        assert set(served) == {"key", "label", "effective_from", "rule"}
        assert MinimumDueRule.model_validate(served["rule"]) == preset.rule
        assert isinstance(served["rule"]["base_percent"], str)
        assert all(isinstance(v, str) for v in served["rule"]["floor"].values())
        assert preset.source
    hsbc = PRESETS["hsbc"].served()["rule"]
    assert hsbc == {
        "version": 1, "preset": "hsbc", "base_percent": "1", "base_excludes": ["installments"],
        "installment_percent": "100", "floor": {"PHP": "1500"},
        "floored_terms": ["annual_fee_twelfth"],
        "added_terms": ["installments", "max_overdue_overlimit"],
        "annual_fee": None, "rounding": "half_up"}


VALID = {"version": 1, "preset": "custom", "base_percent": "3", "base_excludes": [],
         "installment_percent": "3", "floor": {"PHP": "500"}, "floored_terms": [],
         "added_terms": ["installments"], "annual_fee": None, "rounding": "half_up"}

INVALID = [
    {"floored_terms": ["overdue"], "added_terms": ["overdue"]},
    {"installment_percent": None},
    {"added_terms": ["installments", "installments"]},
    {"base_excludes": ["overdue", "overdue"]},
    {"installment_percent": "-3"},
    {"installment_percent": "101"},
    {"annual_fee": "-1"},
    {"floor": {"PHP": "-1"}},
    {"base_percent": "NaN"},
    {"base_percent": "Infinity"},
    {"annual_fee": "NaN"},
    {"floor": {"PHP": "Infinity"}},
    {"base_percent": "0"},
    {"base_percent": "100.01"},
    {"added_terms": ["installments", "max_overdue_overlimit", "overdue"]},
    {"floored_terms": ["overlimit"], "added_terms": ["installments", "max_overdue_overlimit"]},
]


def test_a_valid_custom_rule_round_trips():
    parsed = MinimumDueRule.model_validate(VALID)
    assert parsed.model_dump(mode="json") == VALID


@pytest.mark.parametrize("change", INVALID)
def test_validators_refuse(change):
    with pytest.raises(ValidationError):
        MinimumDueRule.model_validate({**VALID, **change})
