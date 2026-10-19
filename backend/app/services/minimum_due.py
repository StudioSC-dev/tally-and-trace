"""Minimum amount due: the pure formula and the bank presets (STU-343 Plan C, 2.4).

``minimum_due(rule, inputs, currency)`` estimates a statement's minimum amount
due from a card's ``MinimumDueRule`` and the statement's inputs:

    base  = max(0, T - sum of the excluded inputs)
    inner = base x base_percent/100 + sum of the floored terms
    mad   = max(inner, floor[currency] or 0) + sum of the added terms
    mad   = min(max(round(mad, rounding), 0), max(T, 0))

The last step clamps the estimate to [0, max(T, 0)]: never negative, never more
than is owed, and 0 when nothing is owed. It returns the amount (Decimal, 2 dp)
and the assumptions the estimate rests on (see ``ASSUMPTIONS``).

``PRESETS`` holds the five bank rules, served by
``GET /accounts/minimum-due-presets``.
"""
from dataclasses import dataclass
from decimal import ROUND_DOWN, ROUND_HALF_UP, ROUND_UP, Decimal
from typing import Dict, List, Tuple, Union

from app.models.user import CurrencyType
from app.schemas.minimum_due import MinimumDueRule

CENT = Decimal("0.01")
ZERO = Decimal("0")

_ROUNDING = {"half_up": ROUND_HALF_UP, "down": ROUND_DOWN, "up": ROUND_UP}

# What an estimate could not account for, in this order.
#   fees_not_itemised: always. Finance, late and overlimit fees are not modelled;
#     any recorded on the card are inside T. HSBC's separate fee terms count as 0.
#   annual_fee_not_set: the rule uses annual_fee_twelfth and annual_fee is null,
#     so the 1/12 share counts as 0.
#   floor_not_set_for_currency: the floor lacks the card's currency; it counts as 0.
#   installments_linked_only: the rule reads I, which counts only card rows linked
#     to a card-installment entry; an unlinked hand-typed installment is a purchase.
#   new_transactions_excluded: base_excludes has new_transactions (the unconfirmed
#     BDO footnote reading).
#   unconverted_lines_left_out: set by the statement walk, never here.
ASSUMPTIONS = (
    "fees_not_itemised", "annual_fee_not_set", "floor_not_set_for_currency",
    "installments_linked_only", "new_transactions_excluded", "unconverted_lines_left_out",
)


@dataclass(frozen=True)
class MinimumDueInputs:
    """A statement's inputs at its close, in the card's currency."""
    outstanding: Decimal  # T
    installments: Decimal = ZERO  # I
    new_transactions: Decimal = ZERO  # N
    overdue: Decimal = ZERO  # O
    overlimit: Decimal = ZERO  # L


def _term(rule: MinimumDueRule, term: str, inputs: MinimumDueInputs) -> Decimal:
    if term == "installments":
        return inputs.installments * (rule.installment_percent or ZERO) / 100
    if term == "overdue":
        return inputs.overdue
    if term == "overlimit":
        return inputs.overlimit
    if term == "annual_fee_twelfth":
        return (rule.annual_fee if rule.annual_fee is not None else ZERO) / 12
    if term == "max_overdue_overlimit":
        return max(inputs.overdue, inputs.overlimit)
    raise ValueError(f"Unknown minimum due term: {term}")


_EXCLUDED = {
    "installments": lambda i: i.installments,
    "overlimit": lambda i: i.overlimit,
    "overdue": lambda i: i.overdue,
    "new_transactions": lambda i: i.new_transactions,
}


def minimum_due(rule: MinimumDueRule, inputs: MinimumDueInputs,
                currency: Union[CurrencyType, str]) -> Tuple[Decimal, List[str]]:
    """The estimated minimum amount due and its assumptions (pure)."""
    currency = CurrencyType(currency)
    total = inputs.outstanding
    base = max(ZERO, total - sum((_EXCLUDED[x](inputs) for x in rule.base_excludes), ZERO))
    inner = base * rule.base_percent / 100 + sum(
        (_term(rule, t, inputs) for t in rule.floored_terms), ZERO)
    floor = rule.floor.get(currency)
    mad = max(inner, floor if floor is not None else ZERO) + sum(
        (_term(rule, t, inputs) for t in rule.added_terms), ZERO)
    mad = mad.quantize(CENT, rounding=_ROUNDING[rule.rounding])
    amount = min(max(mad, ZERO), max(total, ZERO)).quantize(CENT, rounding=ROUND_HALF_UP)

    terms = set(rule.floored_terms) | set(rule.added_terms)
    found = {"fees_not_itemised"}
    if "annual_fee_twelfth" in terms and rule.annual_fee is None:
        found.add("annual_fee_not_set")
    if floor is None:
        found.add("floor_not_set_for_currency")
    if "installments" in terms or "installments" in rule.base_excludes:
        found.add("installments_linked_only")
    if "new_transactions" in rule.base_excludes:
        found.add("new_transactions_excluded")
    return amount, [a for a in ASSUMPTIONS if a in found]


@dataclass(frozen=True)
class Preset:
    """A bank's rule. ``source`` is the bank wording it follows (not served)."""
    key: str
    label: str
    effective_from: str
    rule: MinimumDueRule
    source: str

    def served(self) -> dict:
        return {"key": self.key, "label": self.label, "effective_from": self.effective_from,
                "rule": self.rule.model_dump(mode="json")}


def _rule(**fields) -> MinimumDueRule:
    return MinimumDueRule(version=1, **fields)


BDO = Preset(
    key="bdo",
    label="BDO / BDO American Express (from 2024-02-25)",
    effective_from="2024-02-25",
    rule=_rule(
        preset="bdo", base_percent=Decimal("3"), base_excludes=["installments", "overlimit"],
        installment_percent=Decimal("3"),
        floor={CurrencyType.PHP: Decimal("850"), CurrencyType.USD: Decimal("17")},
        floored_terms=[], added_terms=["installments", "overdue", "overlimit"],
        annual_fee=None, rounding="down"),
    source=(
        "BDO advisory effective 2024-02-25, regular and American Express cards (summary; "
        "the advisory text is not kept in the repo): 3% of the outstanding balance less "
        "the monthly installment amortizations and any overlimit amount, or PHP 850 "
        "(USD 17 on a dollar card), whichever is higher; plus 3% of the monthly "
        "installment amortizations, any past due amount and any overlimit amount. A "
        "footnote may also exclude the period's new transactions from the base; that "
        "reading is the new_transactions switch, off by default (the higher minimum). "
        "Rounded down, which matches the October statement to the centavo."),
)

BDO_INSTALLMENT = Preset(
    key="bdo_installment",
    label="BDO Installment Card",
    effective_from="2024-02-25",
    rule=_rule(
        preset="bdo_installment", base_percent=Decimal("3"),
        base_excludes=["installments", "overlimit"], installment_percent=Decimal("100"),
        floor={CurrencyType.PHP: Decimal("850")},
        floored_terms=[], added_terms=["installments", "overdue", "overlimit"],
        annual_fee=None, rounding="down"),
    source=(
        "BDO advisory effective 2024-02-25, BDO Installment Card (summary; the advisory "
        "text is not kept in the repo): 3% of the outstanding balance less the monthly "
        "installment and cash installment amortizations and any overlimit amount, or PHP "
        "850, whichever is higher; plus 100% of the monthly installment and cash "
        "installment amortizations, any past due amount and any overlimit amount. The "
        "app has no separate cash installment: both kinds are subtracted from the base "
        "and added at 100%, so one installments input is exact."),
)

METROBANK = Preset(
    key="metrobank",
    label="Metrobank (from 2024-08-01)",
    effective_from="2024-08-01",
    rule=_rule(
        preset="metrobank", base_percent=Decimal("3.5"), base_excludes=["overlimit", "overdue"],
        installment_percent=None,
        floor={CurrencyType.PHP: Decimal("1000"), CurrencyType.USD: Decimal("20")},
        floored_terms=["overlimit", "overdue"], added_terms=[],
        annual_fee=None, rounding="up"),
    source=(
        "Metrobank, effective 2024-08-01 (summary; the bank's text is not kept in the "
        "repo): 3.5% of the outstanding balance less any overlimit and past due amounts, "
        "plus the overlimit and past due amounts, or PHP 1,000 (USD 20 on a dollar "
        "card), whichever is higher. Installment amortizations stay inside the "
        "outstanding balance. Rounded up, which matches the October statement to the "
        "centavo."),
)

SECURITY_BANK = Preset(
    key="security_bank",
    label="Security Bank",
    # No effective date: the rule follows the statement's own wording, which names none.
    effective_from="",
    rule=_rule(
        preset="security_bank", base_percent=Decimal("3"), base_excludes=[],
        installment_percent=None,
        floor={CurrencyType.PHP: Decimal("500"), CurrencyType.USD: Decimal("10")},
        floored_terms=[], added_terms=["overlimit", "overdue"],
        annual_fee=None, rounding="half_up"),
    source=(
        "Security Bank statement wording (summary; the statement is not kept in the "
        "repo): 3% of the outstanding balance or PHP 500 (USD 10 on a dollar card), "
        "whichever is higher, plus any overlimit and past due amounts. Rounded half-up, "
        "which matches the October statement."),
)

HSBC = Preset(
    key="hsbc",
    label="HSBC (from 2025-05-01)",
    effective_from="2025-05-01",
    rule=_rule(
        preset="hsbc", base_percent=Decimal("1"), base_excludes=["installments"],
        installment_percent=Decimal("100"), floor={CurrencyType.PHP: Decimal("1500")},
        floored_terms=["annual_fee_twelfth"],
        added_terms=["installments", "max_overdue_overlimit"],
        annual_fee=None, rounding="half_up"),
    source=(
        'HSBC advisory "Changes to your HSBC Credit Card Terms & Conditions effective '
        '01 May 2025": "Your Minimum Payment is the sum of: 1. 1% of the full current '
        "amount you owe, which includes your retail purchases, cash advance, cash advance "
        "fees and other fees and charges (excluding annual fee, overlimit fee, finance "
        "and late charge); 2. One-twelfth (1/12) of your annual fee, if applicable; and "
        "3. Overlimit fee, finance and late charge, if any OR PHP1,500, whichever amount "
        "is higher; PLUS 100% of the monthly instalment amount (principal and interest); "
        "and Any past due amount or overlimit amount, whichever is higher. For instances "
        "where your Total Due is less than the above, your Minimum Payment will be your "
        'Total Due." Installments are added after the floor, so the 1% base excludes '
        "them. The overlimit fee, finance and late charge term is not modelled "
        "(fees_not_itemised). The floor stays editable per card."),
)

PRESETS: Dict[str, Preset] = {
    p.key: p for p in (BDO, BDO_INSTALLMENT, METROBANK, SECURITY_BANK, HSBC)
}
