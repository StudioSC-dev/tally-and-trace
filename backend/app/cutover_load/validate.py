"""Validation of a ``cutover-input`` file, before any write (plan v3, section 2.1).

``validate_input`` runs every rule that needs no database (rules 1 to 9) and
returns a ``LoadPlan``: the computed account openings, the transactions in
load order and each recurring entry's stored fields. Every failure is a
``Problem`` naming its check and the input key; ``InputInvalid`` carries them
all. Rule 10 (the owner's Household tag exists) needs the database and is
checked by the loader.

``card_cycles`` is the card-statement computation of the cutover check
(section 2.5, check 2): the card's posted rows dated before a boundary, split
into line items and payments by the app's own helpers, walked cycle by cycle
to the cycle containing the day before the boundary. It runs here on the
input rows and in the loader on the stored rows.
"""

from dataclasses import dataclass, field
from datetime import date, datetime, timedelta
from decimal import Decimal
from types import SimpleNamespace
from typing import Dict, Iterable, List, Optional, Tuple

from app.models.account import AccountType
from app.models.budget_entry import BudgetEntryType
from app.models.tag import HOUSEHOLD_TAG_NAME
from app.models.transaction import TransactionType
from app.services.statements import (
    _split_card_rows, allocate_payments, iter_cycles_from, statement_balance,
)
from app.cutover_load.schema import AccountIn, BudgetEntryIn, CutoverInput, TransactionIn

ZERO = Decimal("0")
MAX_OCCURRENCES = 360


@dataclass(frozen=True)
class Problem:
    check: str
    key: str
    detail: str

    def __str__(self) -> str:
        return f"{self.check} [{self.key}]: {self.detail}"


class InputInvalid(Exception):
    def __init__(self, problems: List[Problem]):
        super().__init__(f"{len(problems)} validation problem(s)")
        self.problems = problems


@dataclass
class EntryPlan:
    entry: BudgetEntryIn
    is_active: bool
    end_mode: str
    max_occurrences: Optional[int]
    occurrences_paid_offset: int


@dataclass
class LoadPlan:
    data: CutoverInput
    accounts: Dict[str, AccountIn]
    openings: Dict[str, Decimal]
    transactions: List[TransactionIn]
    entries: List[EntryPlan]
    card_sets: Dict[str, List[dict]] = field(default_factory=dict)

    @property
    def boundary(self) -> datetime:
        return day_start(self.data.cutover_date)


def day_start(day: date) -> datetime:
    """A calendar date as the naive ``D 00:00`` the app stores (plan section 1.7)."""
    return datetime(day.year, day.month, day.day, 0, 0)


def naive(value: datetime) -> datetime:
    """A stored date as the app reads it (``forecast._naive``): its tzinfo dropped.

    ``transaction_date`` is a ``timestamptz`` column in the database although
    the model declares it naive, so stored rows read back aware (in the
    session time zone); input rows are naive, and a naive value written or
    compared in SQL is read in the session time zone too.
    """
    return value.replace(tzinfo=None) if value.tzinfo else value


def is_card(account: AccountIn) -> bool:
    return account.account_type == AccountType.CREDIT


def is_loan(account: AccountIn) -> bool:
    return account.account_type == AccountType.LOAN


def is_foreign(row: TransactionIn) -> bool:
    return row.face_currency is not None


def row_amount(row: TransactionIn) -> Optional[Decimal]:
    """The ``amount`` the row is stored with: its own, or its face when unposted foreign."""
    if row.amount is None and row.face_amount is not None and not row.is_posted:
        return row.face_amount
    return row.amount


def row_effect(row: TransactionIn, account_key: str) -> Decimal:
    """The posted row's effect on ``account_key`` (plan section 1.6); 0 when unposted."""
    if not row.is_posted:
        return ZERO
    amount = row_amount(row) or ZERO
    if row.type == TransactionType.CREDIT:
        return amount if row.account_key == account_key else ZERO
    if row.type == TransactionType.DEBIT:
        return -amount if row.account_key == account_key else ZERO
    effect = ZERO
    if row.account_key == account_key:
        effect -= amount + (row.transfer_fee or ZERO)
    if row.to_account_key == account_key:
        effect += row.received_amount if row.received_amount is not None else amount
    return effect


def card_namespace(card_terms) -> SimpleNamespace:
    """What ``resolve_cycle_fields`` reads of a card, from its input terms."""
    return SimpleNamespace(billing_cycle_start=card_terms.billing_cycle_start,
                           days_until_due_date=card_terms.days_until_due_date,
                           due_date=None)


def row_namespace(row: TransactionIn) -> SimpleNamespace:
    """An input row shaped as the statement helpers read a stored one (ids are keys)."""
    transfer = row.type == TransactionType.TRANSFER
    return SimpleNamespace(
        transaction_type=row.type,
        amount=row_amount(row) or ZERO,
        transaction_date=day_start(row.date),
        account_id=row.account_key,
        transfer_from_account_id=row.account_key if transfer else None,
        transfer_to_account_id=row.to_account_key if transfer else None,
        transfer_fee=row.transfer_fee or ZERO,
        received_amount=row.received_amount,
        is_posted=row.is_posted,
    )


def card_cycles(card, card_id, rows: Iterable, unbilled: frozenset,
                boundary: datetime) -> List[dict]:
    """The card's compared set as of ``boundary`` (plan section 2.5, check 2).

    Only posted rows dated before ``boundary`` count. A card with no line item
    has an empty set and walks no cycle. Otherwise every cycle from the one
    holding the first line through the one holding the day before
    ``boundary`` is balanced and the payments allocated oldest first; the set
    is each cycle that still owes something plus that last cycle, even at 0.
    Each is ``{close, due, balance, owed}`` with dates.
    """
    kept = [r for r in rows if r.is_posted and naive(r.transaction_date) < boundary]
    lines, payments = _split_card_rows(card_id, kept, unbilled)
    if not lines:
        return []
    days = [line.transaction_date.date() for line in lines]
    through = (boundary - timedelta(days=1)).date()
    cycles = list(iter_cycles_from(card, min(days), datetime.min, through=through))
    balances = [statement_balance(lines, c["window_start"], c["close"]) for c in cycles]
    owed = allocate_payments(balances, [amount for _, amount in payments])
    compared = []
    for i, (cycle, balance, left) in enumerate(zip(cycles, balances, owed)):
        if left > 0 or i == len(cycles) - 1:
            compared.append({"close": cycle["close"].date(), "due": cycle["due"].date(),
                             "balance": balance, "owed": left})
    return compared


def _duplicates(values: Iterable) -> List:
    seen, dupes = set(), []
    for value in values:
        if value in seen and value not in dupes:
            dupes.append(value)
        seen.add(value)
    return dupes


class _Checker:
    def __init__(self, data: CutoverInput):
        self.data = data
        self.problems: List[Problem] = []
        self.accounts = {a.key: a for a in data.accounts}
        self.categories = {c.key: c for c in data.categories}
        self.transactions = {t.key: t for t in data.transactions}
        self.tag_names = {t.name for t in data.tags}

    def fail(self, check: str, key: str, detail: str) -> None:
        self.problems.append(Problem(check, key, detail))

    def account(self, key: Optional[str], owner_key: str, what: str) -> Optional[AccountIn]:
        if key is None:
            return None
        account = self.accounts.get(key)
        if account is None:
            self.fail("reference", owner_key, f"{what} '{key}' is not an input account")
        return account

    # --- Rule 1: keys, references, selectors ------------------------------------------

    def check_uniqueness(self) -> None:
        d = self.data
        for label, keys in (("account", [a.key for a in d.accounts]),
                            ("category", [c.key for c in d.categories]),
                            ("transaction", [t.key for t in d.transactions]),
                            ("budget entry", [e.key for e in d.budget_entries])):
            for key in _duplicates(keys):
                self.fail("duplicate_key", key, f"{label} key '{key}' is used more than once")
        for name, kind, cur in _duplicates(
                (a.name, a.account_type.value, a.currency.value) for a in d.accounts):
            self.fail("duplicate_selector", name,
                      f"more than one account is {{{name}, {kind}, {cur}}}")
        for name in _duplicates(c.name for c in d.categories):
            self.fail("duplicate_category", name, f"category name '{name}' is used more than once")
        for name in _duplicates(t.name.lower() for t in d.tags):
            self.fail("duplicate_tag", name, f"tag name '{name}' is used more than once")
        for tag in d.tags:
            if tag.name.lower() == HOUSEHOLD_TAG_NAME.lower():
                self.fail("reserved_tag", tag.name,
                          "the Household tag is the owner's system tag; don't list it")
        for name, account, dest in _duplicates(
                (e.name, e.account_key, e.transfer_to_account_key) for e in d.budget_entries):
            self.fail("duplicate_entry", name,
                      f"more than one recurring entry is ({name}, {account}, {dest})")
        if d.load_date < d.cutover_date:
            self.fail("dates", "load_date", "load_date is before cutover_date")

    def check_tags(self, owner_key: str, tags: List[str]) -> None:
        for name in _duplicates(tags):
            self.fail("reference", owner_key, f"tag '{name}' is listed twice")
        for name in tags:
            if name != HOUSEHOLD_TAG_NAME and name not in self.tag_names:
                self.fail("reference", owner_key, f"tag '{name}' is not an input tag")

    def check_category(self, owner_key: str, key: Optional[str]) -> None:
        if key is not None and key not in self.categories:
            self.fail("reference", owner_key, f"category '{key}' is not an input category")

    # --- Accounts (shape, routing currency, loan terms) ---------------------------------

    def check_accounts(self) -> None:
        for a in self.data.accounts:
            self.check_tags(a.key, a.tags)
            if is_card(a) != (a.card is not None):
                self.fail("account_shape", a.key,
                          "a credit card needs card terms, and only a credit card has them")
            if is_loan(a) != (a.loan is not None):
                self.fail("account_shape", a.key,
                          "a loan needs loan terms, and only a loan has them")
            if a.card is not None:
                for field_name in ("payment_account_key", "payment_overflow_account_key"):
                    target = self.account(getattr(a.card, field_name), a.key, field_name)
                    if target is not None and target.currency != a.currency:
                        self.fail("currency", a.key,
                                  f"{field_name} is in another currency than the card")
                closes = [s.close for s in a.card.statements_at_cutover]
                for close in _duplicates(closes):
                    self.fail("card_statements", a.key, f"statement {close} is listed twice")
            if a.loan is not None:
                payer = self.account(a.loan.payment_account_key, a.key, "payment_account_key")
                if payer is not None and payer.currency != a.currency:
                    self.fail("currency", a.key, "a loan's payer must be in the loan's currency")
                if a.loan.payments_made_offset > a.loan.term_months:
                    self.fail("loan", a.key, "payments_made_offset is more than term_months")

    # --- Transactions: references, boundary (rule 2), currency (6), loans (7) -----------

    def check_transactions(self) -> None:
        cutover, load = self.data.cutover_date, self.data.load_date
        for t in self.data.transactions:
            self.check_tags(t.key, t.tags)
            self.check_category(t.key, t.category_key)
            source = self.account(t.account_key, t.key, "account_key")
            transfer = t.type == TransactionType.TRANSFER
            dest = None
            if transfer:
                if t.to_account_key is None:
                    self.fail("reference", t.key, "a transfer needs to_account_key")
                elif t.to_account_key == t.account_key:
                    self.fail("reference", t.key, "a transfer's accounts must differ")
                else:
                    dest = self.account(t.to_account_key, t.key, "to_account_key")
            else:
                for name in ("to_account_key", "transfer_fee", "received_amount"):
                    if getattr(t, name) is not None:
                        self.fail("shape", t.key, f"{name} applies only to a transfer")
            if source is None or (transfer and dest is None):
                continue
            self._check_money(t, source, dest)
            if t.is_posted and t.date >= load:
                self.fail("load_day", t.key,
                          "a row dated on or after load_date must be unposted")
            if t.date < cutover:
                self._check_pre_cutover(t, source, dest)

    def _check_money(self, t: TransactionIn, source: AccountIn, dest: Optional[AccountIn]) -> None:
        if (t.face_amount is None) != (t.face_currency is None):
            self.fail("currency", t.key, "face_amount and face_currency go together")
            return
        if dest is not None:
            if is_foreign(t):
                self.fail("currency", t.key, "a transfer carries no face")
            if t.amount is None:
                self.fail("shape", t.key, "a transfer needs an amount")
                return
            if source.currency == dest.currency:
                if t.received_amount is not None and t.received_amount != t.amount:
                    self.fail("currency", t.key,
                              "both accounts are in one currency; received_amount must be empty")
            else:
                if is_card(source) or is_card(dest):
                    self.fail("currency", t.key,
                              "a credit card can't take part in a cross-currency transfer")
                if t.is_posted and (t.received_amount is None or t.received_amount <= 0):
                    self.fail("currency", t.key,
                              "a posted cross-currency transfer needs received_amount")
            if is_loan(dest):
                if t.transfer_fee is None:
                    self.fail("loan_payment", t.key,
                              "a transfer into a loan needs an explicit transfer_fee (interest)")
                if dest.currency != source.currency:
                    self.fail("currency", t.key, "a loan is paid in its own currency")
            return
        if is_foreign(t):
            if t.face_currency == source.currency:
                self.fail("currency", t.key,
                          "face_currency is the account's currency; give only amount")
            if t.is_posted:
                if t.amount is None or t.amount <= 0:
                    self.fail("currency", t.key, "a posted foreign row needs the actual amount "
                                                 "in the account's currency")
            elif t.amount is not None:
                self.fail("currency", t.key, "an unposted foreign row carries only its face")
        elif t.amount is None:
            self.fail("shape", t.key, "the row needs an amount")

    def _check_pre_cutover(self, t: TransactionIn, source: AccountIn,
                           dest: Optional[AccountIn]) -> None:
        if t.type != TransactionType.TRANSFER:
            if not is_card(source):
                self.fail("pre_cutover", t.key,
                          "only a card's debits and credits may be dated before the cutover")
            return
        if not (t.is_posted and dest is not None and is_card(dest)
                and not is_card(source) and not is_loan(source)):
            self.fail("pre_cutover", t.key,
                      "a transfer dated before the cutover must be a posted payment "
                      "from a non-card, non-loan account into a card")

    # --- Openings (rules 3 and 5) and card history (rule 4) -----------------------------

    def openings(self) -> Tuple[Dict[str, Decimal], Dict[str, List[dict]]]:
        cutover = self.data.cutover_date
        boundary = day_start(cutover)
        pre = [t for t in self.data.transactions if t.date < cutover]
        openings: Dict[str, Decimal] = {}
        card_sets: Dict[str, List[dict]] = {}
        for a in self.data.accounts:
            opening = a.balance_at_cutover - sum(
                (row_effect(t, a.key) for t in pre), ZERO)
            if is_card(a):
                if opening != 0:
                    self.fail("card_opening", a.key,
                              f"balance_at_cutover less the pre-cutover rows is {opening}, "
                              "not 0: import the missing lines")
                openings[a.key] = ZERO
                if a.card is None:
                    continue
                rows = [row_namespace(t) for t in pre
                        if a.key in (t.account_key, t.to_account_key)]
                computed = card_cycles(card_namespace(a.card), a.key, rows, frozenset(), boundary)
                card_sets[a.key] = computed
                self._compare_statements(a, computed)
            elif is_loan(a):
                openings[a.key] = a.balance_at_cutover
                if a.balance_at_cutover >= 0:
                    self.fail("loan", a.key, "a loan's balance_at_cutover must be below 0")
            else:
                openings[a.key] = opening
        return openings, card_sets

    def _compare_statements(self, a: AccountIn, computed: List[dict]) -> None:
        listed = {s.close: s.owed for s in a.card.statements_at_cutover}
        found = {c["close"]: c["owed"] for c in computed}
        for close in sorted(set(listed) | set(found)):
            if close not in found:
                self.fail("card_statements", a.key,
                          f"statement {close} is listed but is not in the compared set")
            elif close not in listed:
                self.fail("card_statements", a.key,
                          f"statement {close} (owed {found[close]}) is in the compared set "
                          "but not listed")
            elif listed[close] != found[close]:
                self.fail("card_statements", a.key,
                          f"statement {close} owes {found[close]}, listed {listed[close]}")

    # --- Recurring entries (rules 8 and 9) ----------------------------------------------

    def entries(self) -> List[EntryPlan]:
        plans = []
        for e in self.data.budget_entries:
            self.check_tags(e.key, e.tags)
            self.check_category(e.key, e.category_key)
            for name in ("account_key", "transfer_to_account_key", "overflow_account_key"):
                self.account(getattr(e, name), e.key, name)
            if e.transfer_to_account_key is not None and e.account_key is None:
                self.fail("reference", e.key, "a recurring transfer needs account_key")
            if e.last_imported_line_key is not None and \
                    e.last_imported_line_key not in self.transactions:
                self.fail("reference", e.key,
                          f"last_imported_line_key '{e.last_imported_line_key}' "
                          "is not an input transaction")
            plans.append(self._installment(e))
        self._check_matches(plans)
        return plans

    def _installment(self, e: BudgetEntryIn) -> EntryPlan:
        if e.installment is None:
            if e.end_mode == "after_occurrences":
                self.fail("installment", e.key, "end_mode after_occurrences needs an installment")
            return EntryPlan(e, e.is_active, e.end_mode, None, 0)
        if e.end_mode != "after_occurrences":
            self.fail("installment", e.key, "an installment's end_mode is after_occurrences")
        total, paid = e.installment.total, e.installment.paid_count
        if paid > total:
            self.fail("installment", e.key, "paid_count is more than total")
            return EntryPlan(e, e.is_active, "after_occurrences", None, 0)
        if total - paid > MAX_OCCURRENCES:
            self.fail("installment", e.key, f"more than {MAX_OCCURRENCES} occurrences remain")
        active = e.is_active and paid < total
        return EntryPlan(e, active, "after_occurrences", total - paid, paid)

    def _entry_matches(self, e: BudgetEntryIn, t: TransactionIn) -> bool:
        account = self.accounts.get(e.account_key) if e.account_key else None
        if account is None or t.account_key != e.account_key:
            return False
        if e.transfer_to_account_key is not None:
            if t.type != TransactionType.TRANSFER or t.to_account_key != e.transfer_to_account_key:
                return False
        else:
            wanted = (TransactionType.CREDIT if e.entry_type == BudgetEntryType.INCOME
                      else TransactionType.DEBIT)
            if t.type != wanted:
                return False
        dest = self.accounts.get(e.transfer_to_account_key) if e.transfer_to_account_key else None
        if dest is not None and is_loan(dest):
            money = (t.amount or ZERO) + (t.transfer_fee or ZERO) == e.amount
        elif e.currency != account.currency:
            money = (t.face_amount, t.face_currency) == (e.amount, e.currency)
        else:
            money = row_amount(t) == e.amount
        if not money:
            return False
        if e.description_contains is not None:
            return e.description_contains.lower() in (t.description or "").lower()
        return True

    def _check_matches(self, plans: List[EntryPlan]) -> None:
        load = self.data.load_date
        matched: Dict[str, List[str]] = {}
        for plan in plans:
            e = plan.entry
            rows = [t for t in self.data.transactions if self._entry_matches(e, t)]
            for t in rows:
                matched.setdefault(t.key, []).append(e.key)
            if not plan.is_active:
                continue
            if e.next_occurrence < load:
                self.fail("recurring", e.key, "an active entry's next_occurrence is before load_date")
            line = self.transactions.get(e.last_imported_line_key or "")
            if line is not None and e.next_occurrence <= line.date:
                self.fail("recurring", e.key,
                          "next_occurrence must be after the last imported line's date")
            for t in rows:
                if t.date >= e.next_occurrence:
                    self.fail("recurring", e.key,
                              f"imported row '{t.key}' matches this entry and is dated on or "
                              "after its next_occurrence")
        for row_key, entry_keys in matched.items():
            if len(entry_keys) > 1:
                self.fail("ambiguous_match", row_key,
                          f"matches more than one recurring entry ({', '.join(entry_keys)}); "
                          "add description_contains")


_STRUCTURAL = frozenset({"reference", "duplicate_key", "shape", "account_shape"})


def validate_input(data: CutoverInput) -> LoadPlan:
    """Rules 1 to 9 of plan section 2.1; raises ``InputInvalid`` listing every problem."""
    checker = _Checker(data)
    checker.check_uniqueness()
    checker.check_accounts()
    checker.check_transactions()
    # Openings need every reference resolved; other problems still let them be reported.
    unresolved = any(p.check in _STRUCTURAL for p in checker.problems)
    openings, card_sets = ({}, {}) if unresolved else checker.openings()
    entries = checker.entries()
    if checker.problems:
        raise InputInvalid(checker.problems)
    ordered = sorted(data.transactions, key=lambda t: (t.date, t.key))
    return LoadPlan(data=data, accounts=checker.accounts, openings=openings,
                    transactions=ordered, entries=entries, card_sets=card_sets)
