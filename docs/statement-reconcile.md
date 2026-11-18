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
  sits on the cycle open today, so it leaves the closed statement.
- A row linked to a recurring entry keeps its `transaction_date`; its posting date
  follows the line.
- Payments are matched to the card's payment transfers and never written.

Matching is deterministic: an exact amount and kind first (cycle rows before others,
nearest date, lowest row id), then a unique near match within one day.

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
- **Unposting a row linked to an installment (a recurring entry) is refused.** There is
  no write path that moves the entry's paid count and schedule back. Follow-up: STU-761.
  Until then, handle that row by hand and run again.
- **The fingerprint differs, the diff is unbalanced, or a write path refuses a row.** The
  reason names the row or line.
- **The verify finds a gap.** Rolled back; the gap is reported.

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
  refusal only an apply can find (an installment-linked unpost, a verify gap) shows when
  the apply runs, and writes nothing.
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
