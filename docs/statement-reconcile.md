# Reconciling a card statement

A card statement can be reconciled against the bank's by hand from a JSON file. An
extractor (a person, a script, a model reading the PDF) turns the statement into the
JSON below; the app compares it with the card's rows, shows what would change, and on
the owner's go makes the app's statement equal the bank's.

- Code: `backend/app/services/statement_reconcile.py` (the pure diff),
  `backend/app/services/statement_reconcile_apply.py` (load, apply, verify; also behind
  `POST /cards/{account_id}/statements/reconcile`) and
  `backend/app/services/statement_reconcile_runner.py` (the script's driver).
- Script: `backend/scripts/reconcile_statement.py`.
- Tests: `backend/app/tests/test_statement_reconcile.py` (the diff),
  `test_statement_reconcile_schema.py` (the JSON),
  `test_statement_reconcile_integration.py` (the endpoint) and
  `test_statement_reconcile_runner.py` (the script).

## The JSON an extractor produces

The server never receives the statement file. The extractor sends a header and the
lines, in the card's currency. The schema is `BankStatement`
(`backend/app/schemas/statement_reconcile.py`); unknown fields are refused.

All figures here are made up.

```json
{
  "header": {
    "close_date": "2026-02-24",
    "total_due": "3450.50",
    "due_date": "2026-03-17",
    "minimum_due": "345.05",
    "previous_balance": "5000.00",
    "payments_and_credits": "5300.00"
  },
  "lines": [
    {"line_no": 1, "transaction_date": "2026-02-03", "posting_date": "2026-02-05",
     "description": "EXAMPLE GROCER", "amount": "1500.00", "kind": "charge"},
    {"line_no": 2, "transaction_date": "2026-02-10", "posting_date": "2026-02-12",
     "description": "EXAMPLE STREAMING", "amount": "2250.50", "kind": "charge",
     "original_amount": "39.99", "original_currency": "USD"},
    {"line_no": 3, "transaction_date": "2026-02-14", "posting_date": "2026-02-17",
     "description": "EXAMPLE SHOP REFUND", "amount": "300.00", "kind": "credit"},
    {"line_no": 4, "transaction_date": "2026-02-18",
     "description": "PAYMENT - THANK YOU", "amount": "5000.00", "kind": "payment"}
  ]
}
```

- `header.close_date` and `header.total_due` are required. `due_date` and `minimum_due`
  are the printed ones. When both `previous_balance` and `payments_and_credits` are
  given, the header must add up: `previous_balance + charges - credits - payments ==
  total_due`, else the file is refused.
- Every line has a unique `line_no` (1 or more), a `transaction_date`, a `description`,
  a positive `amount` with at most two decimals, and a `kind`. `posting_date` is optional.
  `original_amount` and `original_currency` (three capital letters) go together and give
  the foreign face of a line whose `amount` is in the card's currency.
- `kind` gives the sign. A `charge` adds to the statement's line balance, a `credit` (a
  refund) takes from it. A `payment` is a card payment, a transfer into the card; it is
  never a line item and never changes the line balance.
- Dates are `YYYY-MM-DD`. A `total_due` or `previous_balance` may be zero or negative
  (a credit balance).

## How the statement wins

The statement decides each line item's **amount**, its **dates**, that it is **posted**
and whether a row **exists** for it. The app keeps the row's **description, category and
tags**.

- A line with no matching row is created: posted, uncategorised, in the card's currency,
  with the line's description.
- A matching row on the cycle takes the line's amount and dates.
- A matching row off the cycle (an unposted row, or a row on a neighbouring statement) is
  moved onto it: posted, with the line's amount and dates.
- A row on the cycle that no line matches is **unposted**, never deleted. An unposted row
  sits on the cycle open today, so it leaves the closed statement. A row linked to a
  recurring entry is also unlinked from it (see the next section).
- A row linked to a recurring entry keeps its `transaction_date`; its posting date
  follows the line.
- Payments are matched to the card's payment transfers and never written.

Matching is deterministic: an exact amount and kind first (cycle rows before others,
nearest date, lowest row id), then a unique near match within one day.

## Unposting a row linked to a recurring entry

An installment (a recurring entry with a set number of payments) counts its payments
from the rows linked to it, and keeps the number of payments left on the entry. When the
statement unposts a row linked to a recurring entry, the apply does one of three things,
and the dry run says which in its `notes` (nothing is written by a dry run):

- **The installment's latest payment is given back.** The row was recorded as one of the
  installment's payments (Mark paid, Post due or auto-post) and no other linked row is on
  its day or later. The row is unposted and unlinked, so the paid count drops by one; the
  installment gets that payment back (one more left) and is due again on that payment's
  date; a completed installment is active again. Auto-post is turned off, as it is when a
  schedule edit moves the next date earlier, so the next run does not post the payment
  again; turn it back on after the review. This is the one path that moves an
  installment's schedule back past a recorded payment.
- **A row of any other recurring entry** (no set number of payments, such as a
  subscription) is unposted and unlinked; the entry's schedule is not changed.
- **Refused**, with nothing written: an installment payment that is not its latest (give
  the later ones back first, or handle the row by hand); a row linked to an installment
  by hand rather than recorded as a payment (it never used a payment up); and a row
  linked to a recurring transfer.

For example (made-up figures): a 6-payment laptop plan has payments recorded on
2026-01-24 and 2026-02-24, so 4 are left. The 2026-02-24 statement does not list the
February payment. The dry run notes "row 812: unposted and unlinked from installment 40;
its payment due 2026-02-24 is given back (5 left, the next due 2026-02-24)". After the
apply the plan shows 1 of 6 paid, 5 left, the next due 2026-02-24. Had the 2026-01-24
statement been the one missing its payment, the apply would be refused, since the
February payment is later.

The fingerprint covers what each such unpost does and the entry's figures it changes: if
the entry changes after the dry run (a payment recorded, auto-post turned on), the apply
is refused and the dry run must be run again.

## Action kinds

| Kind | Meaning |
| --- | --- |
| `matched` | a row already equals the line; nothing to do |
| `update` | a row on the statement takes the line's amount, dates or posted status |
| `move` | a row from outside the statement (unposted, or on a neighbouring statement) is posted onto it |
| `create` | no row for the line: one is added (it may name a recurring row it might duplicate) |
| `unpost` | a row on the statement that no line matches is unposted |
| `missing` | a payment line with no payment row; reported only, never written |

The header can differ too: `due`, `minimum_due` (both written on an apply) and `close`
(never written: see the refusals). A **warning** names a line whose resulting dates would
place the row outside the statement's window.

## The flow: dry run, fingerprint, apply, verify

1. **Dry run.** Nothing is written. The diff is printed with `balanced` (whether the
   actions would make the app's line balance equal the statement's) and a `fingerprint`
   that identifies this statement against these rows.
2. **Apply.** The same statement and the dry run's fingerprint. Under the card's lock the
   diff is computed again; if the fingerprint differs (the statement or the rows changed)
   or the diff is not balanced, nothing is written. Otherwise one transaction applies the
   header, the updates and moves, and the creates, through the same write paths as the
   app's own edits.
3. **Verify.** Still inside the transaction, the statement's line balance is read two
   ways (the stored statements, and a replay of the window's rows). Both must equal the
   bank's, or everything is rolled back and the gap is returned.
4. **Record.** Every line item on the statement is marked reconciled and the statement is
   recorded as reconciled (shown on the statements list).

A second dry run of the same file afterwards shows only `matched` actions.

## Refusals

Each refusal writes nothing.

- **The close does not match.** The statement closes on a day other than the card's
  cycle close. The rows would sit on other cycles, so the diff has no row actions. Change
  the closing day first (the closing-day change), then reconcile.
- **Not a closed statement**, or a card with no statement cycle, or an account that is not
  a credit card.
- **Not the card's owner or admin.** The access check is the service's, as on the
  endpoint: another user gets "Account not found".
- **Unposting a row linked to a recurring entry, in the cases listed above**: an
  installment payment that is not its latest, a row linked to an installment by hand, or
  a row linked to a recurring transfer. Handle that row by hand and run again.
- **The fingerprint differs, the diff is unbalanced, or a write path refuses a row.** The
  reason names the row or line.
- **The verify finds a gap.** Rolled back; the gap is reported.

## A savings, checking or e-wallet statement

A bank account's statement is reconciled the same way, through
`POST /accounts/{account_id}/statements/reconcile`: the same dry run, fingerprint, apply,
verify and `Idempotency-Key`, the same action kinds (`matched`, `update`, `move`,
`create`, `unpost`; never `missing`) and the same matching rules. The script above is for
cards only.

- Code: `diff_account_statement` in `backend/app/services/statement_reconcile.py`, and
  `load_account`, `verify_account` and `apply_account` in
  `backend/app/services/statement_reconcile_apply.py`.
- Tests: `backend/app/tests/test_statement_reconcile_account.py` (the JSON and the diff)
  and `test_statement_reconcile_account_integration.py` (the endpoint).

### The JSON

The schema is `AccountStatement`; unknown fields are refused. All figures are made up.

```json
{
  "header": {
    "period_start": "2026-02-01",
    "period_end": "2026-02-28",
    "opening_balance": "25000.00",
    "closing_balance": "48772.50"
  },
  "lines": [
    {"line_no": 1, "transaction_date": "2026-02-05",
     "description": "EXAMPLE POWER CO", "amount": "1200.00", "kind": "debit"},
    {"line_no": 2, "transaction_date": "2026-02-15",
     "description": "EXAMPLE PAYROLL", "amount": "30000.00", "kind": "credit"},
    {"line_no": 3, "transaction_date": "2026-02-20",
     "description": "TRANSFER TO SAVINGS", "amount": "5015.00", "kind": "debit"},
    {"line_no": 4, "transaction_date": "2026-02-28",
     "description": "SERVICE CHARGE", "amount": "12.50", "kind": "debit"}
  ]
}
```

- `header.period_start`, `header.period_end` (both included, the end not before the
  start) and `header.closing_balance` are required. `opening_balance` is optional; when it
  is given the header must add up: `opening_balance + credits - debits ==
  closing_balance`, else the file is refused with the gap.
- Lines have the same fields as a card's, in the account's currency. `kind` is `debit`
  (money out of the account) or `credit` (money in); a card's `charge` and `payment` are
  refused, and a card statement refuses `debit`.
- A transfer between two of the user's accounts is a `debit` on the statement of the
  account it left and a `credit` on the one it reached.

### What differs from a card

- **The period, not a cycle.** It must have ended (before Manila's today), else 422.
- **Which accounts.** A savings, checking, e-wallet or cash account; a cash account is read
  exactly as a savings account (a `debit` takes money out, a `credit` puts it in, and the
  balances are what the app shows). A card is refused (400) with a message naming
  `POST /cards/{id}/statements/reconcile`. A loan account is still refused (400): its
  balance is the negative of what is owed and a payment lowers it by the principal only,
  so what a loan statement's lines and balances mean is not settled yet.
- **Placement by `transaction_date`.** A posted row is in the period when its own
  `transaction_date` is, as the account's balance counts it; a `posting_date` never moves
  it. Rows the statement may claim: the posted rows in the period of the same length
  either side, and the unposted rows dated up to the end of the one after.
- **Each row by its effect on this account**, as the balance history reads it: a debit or
  credit on the account by its amount; a transfer out of it a `debit` of its amount plus
  its fee; a transfer into it a `credit` of what it received (its received amount when the
  currencies differ, else its amount).
- **No header writes**: the dry run's `header` is always empty.

### Transfers

A transfer is one row carrying both accounts' sides, so:

- it is matched on each account's statement and never created twice;
- it keeps both its dates whatever the line says (the other bank may print another day),
  so it is only paired with a line when its own date is in the period;
- any change to it (its amount, posting or unposting it) is refused, since it would
  change the other account too: "Row 41 is a transfer between accounts 7 and 9: changing
  it here would change both; edit the transfer and run the dry run again";
- a line that would be created while a transfer of the same kind and amount is dated off
  the period names it in `possible_duplicate_of`, and the apply is refused: "Line 3 may be
  transfer row 41, whose date keeps it off this period; change the transfer's date and run
  the dry run again".

Unposting a row linked to a recurring entry (salary, a bill, an installment, a loan
payment) is refused here, whatever the entry: a bank statement never gives a payment back.

### Verify

After the writes, inside the transaction, two checks; either failing rolls everything back
with a 409 whose detail has the figures and the `gap`:

1. The posted rows in the period, added to the opening balance (or, without one, the
   closing balance less the lines' change), give the closing balance. Fields:
   `app_change`, `statement_change`, `gap`.
2. The account's balance at the end of `period_end` (its stored balance, the one the app
   shows, less every posted row dated after) is the closing balance. Fields:
   `app_closing_balance`, `statement_closing_balance`, `gap`. This fails when the app's
   history before the period differs from the bank's opening, even if the period's rows
   match.

### Record

Every posted row in the period is marked reconciled (an unposted row is cleared), and
`account_statement_reconciliations` gets one row per account and `period_end`: the period,
the opening (empty when not given) and closing balances, the period's `change` (credits
less debits), the line count, who reconciled it and when. A later reconcile of a statement
ending on the same day replaces it. The apply's answer returns it as `reconciliation`.

## Running the script

The owner runs it in their own shell with the database URL exported there. Agents never
hold production credentials. Only `DATABASE_URL` is read, from the environment and never
from a `.env`. `PGHOST`, `PGHOSTADDR`, `PGPORT`, `PGDATABASE`, `PGSERVICE`,
`PGSERVICEFILE`, `PGTZ` and `PGOPTIONS` must be unset, and the URL must not use the
transaction pooler (port 6543).

Dry run (the default):

```sh
DATABASE_URL=postgresql://USER:PASSWORD@HOST:5432/DBNAME \
  python backend/scripts/reconcile_statement.py \
  --card-id 12 --file statement.json --actor-user-id 3 \
  --expect-host HOST --expect-db DBNAME
```

Paste the output into the ticket and wait for the owner's go. Then the same command with
`--apply` does a dry run to get the fingerprint and applies with it in the same run:

```sh
DATABASE_URL=postgresql://USER:PASSWORD@HOST:5432/DBNAME \
  python backend/scripts/reconcile_statement.py \
  --card-id 12 --file statement.json --actor-user-id 3 \
  --expect-host HOST --expect-db DBNAME --apply
```

- `--actor-user-id` is the user the reconcile acts as: an owner or admin of the card, and
  the `created_by_actor` of any row created. The service's own role check decides.
- The file is read and checked against the schema before the script connects.
- Output: ids, line numbers, dates, action kinds, field names, warnings and refusal
  reasons. It never prints an amount; a changed amount is printed as "amount changes". It
  says whether the diff is balanced and, after an apply, that the statement is recorded
  as reconciled.
- A dry run that an apply would refuse (a close mismatch, an unbalanced diff) exits 3. A
  dry run prints a `note:` line for each unpost of a row linked to a recurring entry,
  saying what the apply does with it or that it refuses it. A refused unpost and a verify
  gap stop the apply when it runs, and it writes nothing.
- Exit codes: 0 done (a dry run: the apply would go ahead), 3 refused (nothing written),
  1 an error, 2 refused before connecting (the file, the URL or the `--expect-*` flags).

## Reading a statement (for the extractor)

These notes are for Philippine card statements. Where one is a general pattern and not
checked against that issuer's statement, it says so. Check each against the statement in
hand before relying on it.

### What to read, whatever the issuer

- **Two dates per line.** Most statements print a transaction date (when the purchase
  was made) and a posting date (when the issuer booked it). Put the first in
  `transaction_date` and the second in `posting_date`. The statement's cycle is decided by
  the posting date, so a purchase made just before the close can post just after it and
  belong to the next statement. When only one date is printed, send it as
  `transaction_date` and leave `posting_date` out.
- **Amounts.** Send the amount in the card's currency. A foreign purchase prints the
  foreign figure and currency beside the peso one: `amount` is the peso figure,
  `original_amount` and `original_currency` the foreign one. Credits and refunds are often
  printed with a trailing "CR" or a minus: send them as `kind` `credit`, with a positive
  `amount`.
- **Payments.** A payment toward the card (usually described as a payment received, or
  "thank you") is `kind` `payment`. It is not a credit: do not send it as one. Payments
  are listed under "payments and credits" in the summary; a refund is a credit, a payment
  is not.
- **Installments.** An installment plan prints its monthly instalment as a normal line,
  with a line under the merchant such as `INSTALMENT 1 OF 3`, dated on the statement
  date. Send it as a `charge` with that date as `transaction_date` (and `posting_date` if
  printed), and keep the "1 OF 3" text in the `description`. The app's installment row for
  the month is matched by amount and date like any other row.
- **Header.** `close_date` is the statement date. `total_due` is the total amount due,
  `minimum_due` the minimum amount due and `due_date` the payment due date. Send
  `previous_balance` and `payments_and_credits` as printed so the file checks its own
  addition. Send only what the statement prints.
- **Fees and interest.** Finance charges, late fees and annual fees are charges: send
  them as lines.

### BDO

- General pattern, not verified against a BDO statement: the line table has a "Posting
  Date" and a "Transaction Date" column. The posting date decides the cycle.
- General pattern, not verified: instalment plans are printed as a line under the
  merchant, dated on the statement date, as described above.
- General pattern, not verified: payments appear as "Payment" lines in the summary and
  the transactions.

### Metrobank

- General pattern, not verified against a Metrobank statement: a posting date and a
  transaction date are both printed on each line.
- General pattern, not verified: instalment plans show as a line under the merchant with
  the "n OF m" counter, dated on the statement date.
- General pattern, not verified: payments are listed as payments received, with the
  payment date.

If an issuer prints the columns in the other order, or prints one date only, the
extractor follows the printed headings and not these notes.
