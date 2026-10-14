# Cutover check runbook (STU-204)

The cutover check compares the database with a file of frozen figures and reports
every difference. It runs after the cutover load, inside the maintenance window,
and its report is what `cutover_load.py --sign-off` accepts. It never writes.

- Code: `backend/app/cutover_check/` (`schema.py`, `check.py`, `statements.py`,
  `sheet.py`, `bootstrap.py`), wrapper `backend/scripts/cutover_check.py`.
- It imports nothing from `app.cutover_load`; a test enforces this.
- Tests: `backend/app/tests/test_cutover_check_integration.py`.

## Who runs it

The owner runs every production command, in their own shell, with the production
URL exported there. Agents never hold production credentials. Hostnames and
addresses below are placeholders.

## Before you run it

1. The maintenance window is on: no UI use by the owner, no spouse use, no Hermes
   or other automation, from the load until sign-off.
2. The load has finished (or the local rehearsal's load has). The check takes the
   cutover advisory lock in shared mode and refuses while a load or reset holds it.
3. The frozen file exists **outside the repository**, at mode 0600 (see below).
4. You know the server address the production dry run reported and you confirmed.

## Running it

```sh
umask 077
export DATABASE_URL='postgresql://USER:PASSWORD@db.example.com:5432/DBNAME?sslmode=require'
python backend/scripts/cutover_check.py \
  --frozen ~/cutover/frozen.json \
  --report ~/cutover/check-report.json \
  --expect-host db.example.com \
  --expect-db DBNAME \
  --expect-server-addr 203.0.113.10
```

- `DATABASE_URL` is read from the environment only; there is no URL flag.
- Relative paths are resolved against the directory you run it from.
- `--frozen` and `--report` must resolve outside the repository (symlinks
  included). `--report` must be a new file; it is created at mode 0600.

### What it refuses before checking (exit code 2)

- `PGHOST`, `PGHOSTADDR`, `PGPORT`, `PGDATABASE`, `PGSERVICE` or `PGSERVICEFILE`
  is set.
- The URL's driver is not `postgresql` or `postgresql+psycopg2`, it has no host
  or several, or its host or database differs from `--expect-host` / `--expect-db`.
- The URL has a query key other than `sslmode`, `sslrootcert`, `connect_timeout`
  or `application_name`, or repeats one. `host`, `hostaddr`, `port`, `dbname`,
  `service` and `options` are all refused.
- After connecting: `current_database()` is not `--expect-db`, or
  `inet_server_addr()` is null (a Unix socket) or not `--expect-server-addr`.
- The cutover lock is held, the owner email matches no user or several, or the
  frozen file is invalid.

These checks run before any other app module is imported: the wrapper first moves
into an empty temporary directory, so no `.env` file is ever read.

### Output

Stdout carries only the target line, the observed database and server address,
one line per block (name, pass/fail/refused, counts) and the overall result.
Figures and row details go to the report only. Driver errors are printed as
their class name, never their message.

| Exit code | Meaning |
|---|---|
| 0 | Every block passed. |
| 1 | At least one block failed or refused; read the report. |
| 2 | Refused before checking; no report was written. |

## The session

- The engine sets `default_transaction_read_only=on` in the connection options
  (code-supplied, not a URL key).
- One transaction at `REPEATABLE READ`, `READ ONLY`, holding
  `pg_try_advisory_xact_lock_shared` on the cutover key. The ORM session joins it
  with `create_savepoint`, so an internal `commit()` neither ends the snapshot nor
  writes. Everything is rolled back at the end.
- Exchange rates come from the stored rates only (`FxRates.offline`); the rate
  provider is never called.
- **Time zone.** The date columns are `timestamptz` in the database, so dates are
  read in the session time zone. The report records it as `session_timezone`.
  Run the load and the check with the same server default (do not set `TZ` or
  `PGTZ` differently between them).

## The frozen file (`cutover-frozen` v1)

JSON, unknown keys refused. Money is a decimal string with at most 2 places, dates
are `YYYY-MM-DD`, months `YYYY-MM`. An account is a selector
`{"name", "account_type", "currency"}` that must match exactly one of the owner's
accounts. The file never refers to the cutover input.

| Key | What it pins |
|---|---|
| `schema_version` | `1`; anything else is refused. |
| `owner_email`, `cutover_date`, `as_of`, `timezone` | The owner, the dates (`as_of` ≥ `cutover_date`), `"Asia/Manila"`. |
| `checkpoints[]` | `date`, `point` (`start_of_day` or `end_of_day`), `balances[]` of `{account, amount}`. |
| `card_statements[]` | `card`, `close`, `due`, `balance`, `owed`: the compared set below. |
| `card_routing[]` | `card`, `payment_account`, `overflow_account` (selector or null). Every owner card is listed. |
| `loans[]` | `loan`, `payment_account`, `owed`, `payments_made`, `payments_left`, `next_due`, `next_rows[]` (up to 3: `due_date`, `payment`, optional `principal`, `interest`). Every owner loan is listed. |
| `recurring[]` | `name`, `account`, `destination`, `overflow_account`, `entry_type`, `amount`, `currency`, `cadence`, `semi_monthly_days` (semi-monthly only), `next_occurrence`, `end_mode`, `end_date`, `max_occurrences`, `is_autopay`, `is_active`, optional `description_contains`, `installment` `{n, m}` (after-occurrences only), `expected` `{"YYYY-MM": count}` over contiguous months. Unique by (name, account, destination); every owner entry is listed. |
| `sheet` | `account`, `currency` (the account's), `first_month`, `months[]` (contiguous, from `first_month`), `sheet_opening`, `month_end{}` (exactly `months`), `opening_offset`, `overflow_policy` (`excluded` or `included`), `approved_differences[]` (`month`, `amount`, `reason`), `dated_items[]` (`date` before `as_of`, a non-zero `amount`, `description_contains`). |

`sheet.first_month` must start on or after `cutover_date`: with a cutover on the 1st
the cutover month is valid; a mid-month cutover starts the Sheet the month after.
Its 1st must also be on or before `as_of`, because the opening is read from the
ledger; a later `first_month` makes the sheet block refuse ("first_month starts
after as_of").

A wallet-funded recurring entry that is not a transfer is never projected, so it
carries no `expected`; giving it one fails the occurrences block. Every other
entry needs `expected`.

## What each block checks

`T` is `as_of` at 00:00. Each failure lists the missing, extra or differing rows;
nothing is absorbed. B(account, C) is the stored balance less the effect of every
posted row dated at or after C, whoever created it (a credit adds, a debit
subtracts; a transfer takes `amount + fee` from its source and adds
`received_amount`, else `amount`, to its destination).

1. **checkpoints**: B(account, C) for each listed account, exact to the centavo.
   C is the date's 00:00 for `start_of_day` and the next day's 00:00 for
   `end_of_day`. C never depends on `as_of`.
2. **card_statements**: the app's own statement helpers on the card's rows that
   are posted and dated before T, with the unbilled-source set computed as the app
   does. The compared set is every cycle still owing, plus the cycle holding
   T − 1 day even at zero; paid historical cycles are left out. A card with no
   posted line has an empty set. Every owner card is compared.
3. **card_routing**: each card's payment and overflow accounts.
4. **loans**: the payer, then `build_schedule`: owed, payments made and left, the
   next due date, the first 3 upcoming rows.
5. **recurring**: each frozen entry names exactly one owner entry; every field
   matches, including the overflow account and autopay; installments read n of m
   (linked transactions plus the offset, and n plus `max_occurrences`).
6. **occurrences**: per entry and month, linked transactions + unlinked matching
   transactions + projected occurrences equals `expected`. An unlinked row
   matches by account and type (a transfer by source and destination), by money
   (a loan payment by principal plus interest, a foreign entry by its face, else
   amount and currency) and by `description_contains` when given. A row matching
   two entries fails as ambiguous: freeze `description_contains` to separate them.
   Projected occurrences are the projection's own budget-entry events from T, so
   months before T count transactions only. Every active entry must have
   `next_occurrence` on or after T.
7. **foreign_invariants**: every posted debit or credit is in its account's
   currency; every posted cross-currency transfer has `received_amount`.
8. **sheet**: the opening, each month's closing and each month's net, with
   approved differences applied cumulatively. The opening is B(A, 1st of
   `first_month`), less `opening_offset`. Months ending on or before T close
   at B(A, first of the next month); the month holding T, and later ones, close at
   the projection's per-account closing for A in the Sheet's currency (never the
   currency partition's `net`). With `overflow_policy` `included`, overflow moves
   into A less those out of it are added cumulatively. Dated items must exist as
   the owner's posted rows on A (either side of a transfer) with that date, effect
   and description. The account must be
   projection cash (not a card, loan or spending wallet).

**Posted-after guard.** If any posted row on an owner account is dated on or after
T, the loans and sheet blocks refuse and list those rows. The balance and
statement blocks still run on their own boundaries.

## The report

A JSON file at mode 0600 outside the repository:

| Field | Meaning |
|---|---|
| `report`, `version` | `"cutover-check"`, `1`. |
| `overall` | `"pass"` or `"fail"`. |
| `owner_id` | The owner checked. |
| `database`, `server_addr`, `host` | The target as observed; `--sign-off` compares these with the run record. |
| `frozen_sha256` | Digest of the frozen file. |
| `checked_at`, `session_timezone` | Database clock and the zone dates were read in. |
| `as_of`, `posted_after[]` | T and any posted rows on or after it. |
| `blocks[]` | `name`, `status` (`pass`, `fail`, `refused`), `checked`, `failures[]`. |

Keep the report private. HANDOVER and PR text carry only sanitised metadata:
block names, counts, pass or fail, and timestamps.

## After it

- **Pass:** run `cutover_load.py --sign-off --run-record PATH --check-report PATH
  --confirm <owner email>`. After sign-off the reset refuses.
- **Fail:** read the report, then reset (`cutover_load.py --reset ...`), fix the
  input or the frozen figures, reload and check again. See `docs/cutover-load.md`.

## Local rehearsal

Restore the production dump to a local Postgres and run the same sequence there
first. Point `--expect-host` at the local host, and read the server address the
check must expect with `SELECT host(inet_server_addr())` over the same TCP
connection: a Docker-published port reports the container's address, not
`127.0.0.1`.
