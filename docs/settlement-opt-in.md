# Settlement opt-in runbook

Turns autopay on for named budget entries and loans, and posts each one's
missed payments, each dated on its own day. It runs the same service code as the
toggle in the app (`posting.autopay_toggle_block` and `posting.turn_on_autopay`
for an entry, `posting.loan_block` and `posting.turn_on_loan_autopay` for a
loan), under the same locks.

- Code: `backend/app/services/settlement_opt_in.py`, wrapper
  `backend/scripts/set_settlement.py`.
- Test: `backend/app/tests/test_settlement_opt_in.py`.

## Who runs it and how

The owner runs it, in their own shell, with the production URL exported there.
Agents never hold production credentials. Only `DATABASE_URL` is needed; it is
read from the environment, never from a `.env`. `PGHOST`, `PGHOSTADDR`, `PGPORT`,
`PGDATABASE`, `PGSERVICE`, `PGSERVICEFILE`, `PGTZ` and `PGOPTIONS` must be unset,
and the URL must not use the transaction pooler (port 6543). The script refuses,
before it connects, unless the URL names exactly `--expect-host` and
`--expect-db`.

Records are chosen by hand: `--entry ID` and `--loan ID`, each repeatable, at
least one required. Nothing is selected implicitly.

Dry run (the default; each record is run for real inside its transaction and
rolled back, so it reports what `--apply` does on the same rows. No rows or
balances change, but the database's id counters advance, so the ids of later
rows may skip numbers):

```sh
DATABASE_URL=postgresql://USER:PASSWORD@HOST:5432/DBNAME \
  python backend/scripts/set_settlement.py \
  --expect-host HOST --expect-db DBNAME --entry ENTRY_ID

DATABASE_URL=postgresql://USER:PASSWORD@HOST:5432/DBNAME \
  python backend/scripts/set_settlement.py \
  --expect-host HOST --expect-db DBNAME --loan LOAN_ID
```

Paste the output into the ticket and wait for the owner's go. Then apply the
same command with `--apply` added:

```sh
DATABASE_URL=postgresql://USER:PASSWORD@HOST:5432/DBNAME \
  python backend/scripts/set_settlement.py \
  --expect-host HOST --expect-db DBNAME --entry ENTRY_ID --apply

DATABASE_URL=postgresql://USER:PASSWORD@HOST:5432/DBNAME \
  python backend/scripts/set_settlement.py \
  --expect-host HOST --expect-db DBNAME --loan LOAN_ID --apply
```

## What each record reports

- **Precheck.** `ok`, or `refused (<reason>)`. A refused record is left exactly
  as it was, in a dry run and under `--apply`. Entry reasons: `not_found`,
  `no_account`, `card_installment` (the review turns that on), `ended`,
  `paused`, and the toggle's `settlement_block` codes (`not_cash`,
  `spending_wallet`, `foreign_currency`). Loan reasons: `not_found`, `not_loan`,
  `changed`, and `loan_block`'s codes (`inactive`, `no_funding_account`,
  `no_access`, `no_schedule`, `no_rate`, `foreign_currency`, `recurring_entry`).
- **Due.** The count of past due dates no posted row stands for, and the dates.
  That count is computed in the run, under the locks, and handed to the toggle's
  call as the confirmed count. If it differs there, the record is refused
  (`http_409`) and nothing is written.
- **Would post / posted.** Transaction ids and dates. A row not yet written is
  `new` in a dry run.
- **Loan only.** `recurring transfer into loan:` lists the ids of any active
  recurring transfer into the loan, or `none`. One makes the precheck fail
  (`recurring_entry`), because autopay would pay the loan twice.
- **Held.** A stop for short funds (`insufficient_funds`), a possible duplicate
  (`held`) or a pending planned payment (`planned_payment`) is reported as
  `held:` and is not an error. The flag stays on, the payments posted before the
  stop stay, and the daily job retries the rest, as it does for any autopay.
- **Already on.** A record whose flag is already on is left alone
  (`already on, no change`). That is what makes a rerun change nothing.

The output holds ids, dates and reason codes. It never prints an amount, a name
or a connection string. Exit codes: 0 done (refused records are listed and left
unchanged), 1 an error, 2 refused before connecting.

## By hand, not by the script

The script cannot see the bank. Before `--apply` for a loan, the owner checks
that the stored payment amount equals what the bank actually debits (a
difference leaves a part-paid due date), and that each past due date it will post
was debited at the bank, and on which day. If a due date was debited on another
day, force that date first.

## After applying

Run the same command with `--apply` again: every record reads `already on, no
change`. The next job run with `dry_run=true` should show nothing further due,
other than payments reported as held.
