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

``statement_minimums`` walks a card's statements oldest first and gives each
its minimum: the override entered from the bank's statement when there is one,
else the estimate from the card's rule, with the overdue carry (section 2.5).
"""
from dataclasses import dataclass
from datetime import date
from decimal import ROUND_DOWN, ROUND_HALF_UP, ROUND_UP, Decimal
from typing import Dict, List, Optional, Tuple, Union

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


# --- a card's statements (section 2.5) -------------------------------------------------------

def _visible_installment_rows(db, card, redactor) -> set:
    """Ids of the rows linked to a card-installment entry on ``card`` (active or
    not) that the caller sees Full. A link to an entry the caller does not see
    Full is the creator's private reference, so such a row stays a purchase."""
    from app.core.redaction import FULL
    from app.models.budget_entry import BudgetEntry
    from app.services import forecast as fc
    from app.services.recurring_kinds import is_card_installment

    entries = [e for e in db.query(BudgetEntry).filter(BudgetEntry.account_id == card.id).all()
               if is_card_installment(e, card)]
    if not entries:
        return set()
    redactor.prepare(entries)
    visible = [e.id for e in entries
               if redactor.access.readable(e) and redactor.view(e) == FULL]
    return {txn_id for _, _, txn_id, _ in fc._linked_rows(db, visible)}


def statement_minimums(db, card, history: List[dict], rule: Optional[MinimumDueRule],
                       overrides: Dict[date, Decimal], limit: Optional[Decimal],
                       redactor) -> List[dict]:
    """Each statement's minimum amount due, parallel to ``history``
    (``statements.statement_history``), walked oldest first.

    Inputs at a statement's close: T is its ``outstanding``; I its lines linked
    to a card installment the caller sees Full (``_visible_installment_rows``);
    N its other debit lines; L = max(0, T - limit), 0 with no limit; and O the
    overdue carry. Each statement q has its own obligation
    ``own_q = max(0, M_q - O_q)``, M_q being its override when set, else its
    estimate (0 when neither exists). Payments into the card are applied once,
    in date order: each is spread oldest first over the unpaid obligations of
    the statements that closed before it was paid, so one payment can settle
    several, and only what is left once all of them are met is ignored here
    (one payment and the same sum split on one day count alike). O at a
    close c is the unpaid obligations of every statement due before c, from
    the payments dated on or before c. A payment on the due day is on time.

    Each result is ``{amount, remaining, source, reason, complete,
    assumptions, inputs}`` in Decimals: ``source`` "statement" (an override),
    "estimate" or "unavailable" (no rule and no override, ``reason``
    "no_rule"). ``remaining = min(clear_through, max(0, amount -
    paid_since_close))``. An estimate is incomplete, with
    ``unconverted_lines_left_out``, when a line on or before its close was
    left out for want of a rate; an override is complete.
    """
    from app.core.access import viewable_account_ids
    from app.services.statements import card_payments

    payments = card_payments(db, card, viewable_account_ids(db, redactor.user))
    installment_rows = _visible_installment_rows(db, card, redactor) if rule is not None else set()
    obligations: List[dict] = []  # {close, due, unpaid}, oldest first
    paid_up_to = 0
    results = []
    for statement in history:
        close, due = statement["close"].date(), statement["due"].date()
        while paid_up_to < len(payments) and payments[paid_up_to][0].date() <= close:
            when, amount = payments[paid_up_to]
            paid_up_to += 1
            left = amount
            for o in obligations:
                if left <= 0:
                    break
                if o["close"] < when.date() and o["unpaid"] > 0:
                    applied = min(left, o["unpaid"])
                    o["unpaid"] -= applied
                    left -= applied
        overdue = sum((o["unpaid"] for o in obligations if o["due"] < close), ZERO)

        total = statement["outstanding"]
        installments = new = ZERO
        for line in statement["lines"]:
            if line["amount"] <= 0:
                continue  # a refund is not a new charge
            if getattr(line["transaction"], "id", None) in installment_rows:
                installments += line["amount"]
            else:
                new += line["amount"]
        overlimit = max(ZERO, total - limit) if limit is not None else ZERO
        inputs = MinimumDueInputs(outstanding=total, installments=installments,
                                  new_transactions=new, overdue=overdue, overlimit=overlimit)

        override = overrides.get(close)
        if override is not None:
            amount = Decimal(override).quantize(CENT, rounding=ROUND_HALF_UP)
            result = {"amount": amount, "source": "statement", "reason": None,
                      "complete": True, "assumptions": [], "inputs": None}
        elif rule is not None:
            amount, assumptions = minimum_due(rule, inputs, card.currency)
            if statement["incomplete"]:
                assumptions = [a for a in ASSUMPTIONS
                               if a in set(assumptions) | {"unconverted_lines_left_out"}]
            result = {"amount": amount, "source": "estimate", "reason": None,
                      "complete": not statement["incomplete"], "assumptions": assumptions,
                      "inputs": inputs}
        else:
            amount = None
            result = {"amount": None, "source": "unavailable", "reason": "no_rule",
                      "complete": False, "assumptions": [], "inputs": None}
        result["remaining"] = None if amount is None else min(
            statement["clear_through"],
            max(ZERO, amount - statement["paid_since_close"]))
        results.append(result)
        obligations.append({"close": close, "due": due,
                            "unpaid": max(ZERO, (amount or ZERO) - overdue)})
    return results
