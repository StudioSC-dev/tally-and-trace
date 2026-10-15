# Cutover load runbook

This runbook covers the one-time cutover load: putting the owner's balances,
cards, loans, recurring entries and the transactions since the cutover date
into the owner's Tally & Trace account, then resetting or signing it off.
The tool is `backend/scripts/cutover_load.py`, a thin wrapper over
`backend/app/cutover_load/`. The cutover check that verifies the result has
its own runbook, `docs/cutover-check.md`.

Everything here is run **by the owner, in their own shell**. The production
database URL is exported there and is never handed to an agent, written to a
file in the repo, or pasted into a ticket.

Hosts, addresses and paths below are placeholders:

| Placeholder | Meaning |
|---|---|
| `DB_HOST` | the host named in `DATABASE_URL` |
| `DB_NAME` | the database named in `DATABASE_URL` |
| `SERVER_ADDR` | the address the server reports, confirmed from the dry run |
| `OWNER_EMAIL` | the owner's login email |
| `~/cutover/` | a private directory **outside the repository** |

## What the tool guarantees

- **One transaction.** The load writes through the app's own write paths
  inside one database transaction. Any refusal or error rolls everything back.
- **One run at a time.** The load and the reset take a transaction-scoped
  advisory lock; a second run is refused ("another cutover run is active")
  instead of waiting.
- **Pinned target.** The URL comes only from `DATABASE_URL`. Before anything
  connects, the host and database must equal `--expect-host` and
  `--expect-db`, the URL may carry only the query keys `sslmode`,
  `sslrootcert`, `connect_timeout` and `application_name`, and none of
  `PGHOST`, `PGHOSTADDR`, `PGPORT`, `PGDATABASE`, `PGSERVICE`,
  `PGSERVICEFILE`, `PGTZ` or `PGOPTIONS` may be set. Port 6543 (a
  transaction pooler) is refused. After connecting, `current_database()`
  must equal `--expect-db` and the server address must equal
  `--expect-server-addr` (when given). A Unix-socket connection is refused.
- **No `.env`.** The wrapper resolves every path, then moves into an empty
  temporary directory before importing the app, so no `.env` file is read.
- **Private outputs.** The report and the run record must be outside the
  repository (symlinks are resolved), are created new at mode 0600, and an
  existing file is never overwritten. The terminal shows only the target,
  check names, keys, counts and pass or fail; figures and details go to the
  report file. An unexpected error, including one while setting up or while
  writing the report or the run record, prints only `error: <ErrorClass>`:
  no traceback, no path, no environment value.
- **Pre-load guard.** The owner must be one active, verified, non-demo user
  who owns nothing yet except the Household tag, and has received no shares.
  The Household tag must exist; the tool never creates it.

Exit codes:

| Code | Meaning |
|---|---|
| 0 | success |
| 1 | a refusal or error before the commit (`refused: ...`, `FAIL ...` or `error: <ErrorClass>`): nothing changed |
| 2 | a missing or wrong flag |
| 3 | `load: COMMITTED; run record incomplete` (the load committed, but the run record could not be marked complete), or `load: commit outcome UNKNOWN` (the COMMIT itself failed, for example on a lost connection, so it may or may not have committed). Either way run `--complete-record` (step 4) |

## Time zone

The date columns are `timestamptz`. Every cutover session (the load, the
reset, `--complete-record` and the cutover check) is pinned to **UTC** by the
code, whatever the server's default zone: the load writes each date as
midnight UTC of that day, and the check reads dates back in UTC. `PGTZ` and
`PGOPTIONS` are refused by both scripts, and the URL may not carry an
`options` key, so neither run can change its session time zone. The run
record, the dry-run report and the check report each record
`session_timezone`. The load refuses (`refused: session_timezone`) if its
session reports anything but `UTC`, and sign-off refuses unless the check's
zone equals the load's and is `UTC`.

## Connection mode

The load, the reset and `--complete-record` must use a **direct or
session-mode connection (port 5432)**, never the transaction pooler (port
6543) that the deployed app's `DATABASE_URL` may name. Through a transaction
pooler each transaction can be served by a different backend, so the server
address the tool pins and the session time zone it records would describe
whichever backend answered, not one stable session. The tool refuses port
6543.

## Migrations

Apply every pending migration (`alembic upgrade head`) to the target database
**before the first load**. Never run a migration between a load and its reset
or sign-off: the owner fingerprint hashes `SELECT * FROM transactions` (and
the other owned tables) with the column names included, so a new column
changes the fingerprint even while every value in it is NULL, and the reset
then refuses. The current example is `transactions.occurrence_date`. If a
load already exists, reset it or sign it off before migrating.

## Before the window

1. The owner and the spouse register and verify in the production UI. If the
   owner's user already holds test rows, register a fresh user for the owner
   or clear those rows in the UI first; the guard refuses otherwise.
2. Prepare the cutover input (`cutover-input` v1 JSON) in `~/cutover/`.
   For each loan, confirm that **no due date is partly paid at the cutover**
   (every due date before it is either fully paid or not paid at all) and
   set `"no_partial_due_at_cutover": true` in that loan's terms. The load
   refuses a loan without it, or with it false.
   A monthly, quarterly, semi-annual or annual recurring entry may carry
   **one** of two day fields: `"day_rule": "last_weekday"` (the last Monday to
   Friday of each month) or `"anchor_day": N` (day N, 1 to 31, on the month's
   last day when the month is shorter). Its `next_occurrence` must already be
   on that day, or the load refuses it (`FAIL day_rule [entry key]`, the
   expected date in the report). Leave both out and the entry is anchored on
   its `next_occurrence`'s day (a 31st gives `anchor_day` 31). Weekly,
   biweekly and semi-monthly entries take neither.
3. Announce the maintenance window: Hermes and any other automation are off,
   the spouse does not use the app, and the owner does not use the UI until
   the cutover check is signed off.

## 1. Dump

```sh
umask 077
pg_dump "$DATABASE_URL" -Fc -f ~/cutover/before-load.dump
sha256sum ~/cutover/before-load.dump     # keep this privately
```

## 2. Local rehearsal

Restore the dump into a local Postgres, export that local URL as
`DATABASE_URL`, and run the whole sequence below against it: the dry run, the
load, the cutover check, the reset, the load again and the check again. All
must pass before production is touched.

## 3. Dry run

```sh
export DATABASE_URL='<the production URL, host DB_HOST, database DB_NAME>'
python backend/scripts/cutover_load.py --dry-run \
    --input ~/cutover/input.json --report ~/cutover/dry-run-report.json \
    --expect-host DB_HOST --expect-db DB_NAME
```

The dry run validates the input, writes every row, checks the result, writes
the review report and rolls back. It prints:

```
target: host=DB_HOST db=DB_NAME
observed: db=DB_NAME server_addr=SERVER_ADDR
validation: pass (...)
assert: balances at the cutover and card statements pass
dry run: rolled back; review report written
```

Open `~/cutover/dry-run-report.json` and review:

- the observed database name and server address (confirm `SERVER_ADDR`;
  every later command passes it) and the session time zone;
- per account: the opening, the balance at the cutover date and the final
  balance;
- per card: the statements as of the cutover;
- per loan: the schedule (payments made, next due date, amount owed), with
  `schedule_owed` beside `balance_at_cutover` to compare;
- per installment: n of m;
- the row counts.

If the input is refused, the terminal lists `FAIL <check> [<key>]` lines
and the report holds each problem's detail. Fix the input and repeat.

## 4. Load

```sh
python backend/scripts/cutover_load.py \
    --input ~/cutover/input.json --report ~/cutover/load-report.json \
    --run-record ~/cutover/run-record.json \
    --expect-host DB_HOST --expect-db DB_NAME --expect-server-addr SERVER_ADDR
```

The run record is written as `prepared` before the commit and marked
`complete` with the database's `finished_at` after it. It holds the owner id
and email, the database name and server address, the session time zone, the
alembic revision, the git sha, the input's sha256, the start and finish times
(both read from the database clock), the owner's row counts, and a SHA-256
fingerprint of the owner's loaded state taken inside the load transaction.
It is a report, not a rollback source. Keep it until the window
closes; the reset and the sign-off both read it.

**If the load exits with code 3**, or a failure leaves a run record at
`prepared`, do not reload. Resolve the record:

```sh
python backend/scripts/cutover_load.py --complete-record \
    --run-record ~/cutover/run-record.json \
    --expect-host DB_HOST --expect-db DB_NAME --expect-server-addr SERVER_ADDR
```

It reads only. It refuses unless the target equals the record's and the
owner's state still has the fingerprint taken inside the load; it then marks
the record `complete` with the database clock's `finished_at`. If it refuses
with `changed_after_load` after `commit outcome UNKNOWN`, the outcome is still
unresolved: the commit may not have happened, or it did and the owner's rows
were edited afterwards. Do not reload on that refusal alone. Confirm
independently that the owner is empty (a dry run of the same input, whose
pre-load guard refuses an owner who owns anything); only then keep the old
record for reference and load again with new output paths. If the owner is not
empty, the load committed: stop and investigate before any reset.

## 5. Cutover check and sign-off

Run the cutover check in the same session with the same target flags (see
`docs/cutover-check.md`). When its report records an overall pass, close the
window:

```sh
python backend/scripts/cutover_load.py --sign-off \
    --run-record ~/cutover/run-record.json \
    --check-report ~/cutover/check-report.json --confirm OWNER_EMAIL
```

Sign-off makes no database connection. It refuses unless the run record is
`complete` and not yet signed off, `--confirm` is the record's owner email,
and the check report is a version 1 `cutover-check` report recording
`overall: pass` for the record's owner id, database, server address and
session time zone, with its `checked_at` at or after the record's
`finished_at` (so the check read the loaded state), and that session time
zone is `UTC`. It then writes `signed_off_at` into the run record (an atomic
replace, mode 0600). After sign-off the reset refuses.

**Mid-month load: the waiver.** After a mid-month load the Sheet starts on the
1st of the next month, so the check's sheet block refuses ("first_month starts
after as_of") and the report's overall is `fail`. If every other block passes,
sign off with that refusal waived, giving the reason in writing:

```sh
python backend/scripts/cutover_load.py --sign-off \
    --run-record ~/cutover/run-record.json \
    --check-report ~/cutover/check-report.json --confirm OWNER_EMAIL \
    --waive-block sheet --waiver-reason "loaded mid-month; the Sheet starts next month"
```

`--waive-block NAME` may be repeated; `--waiver-reason` is required with it and
must not be blank. On top of every check above, the waiver requires:

- the report lists exactly the eight version 1 blocks (`checkpoints`,
  `card_statements`, `card_routing`, `loans`, `recurring`, `occurrences`,
  `foreign_invariants`, `sheet`), each once, each `pass`, `fail` or `refused`;
- each named block is `refused` with a refusal on the allowlist, which today
  holds only the sheet block's "first_month starts after as_of" (its other
  refusals, posted rows on or after `as_of` and a sheet account that is not
  projection cash, and the loans block's refusal are never waivable);
- every block not named passes, and `posted_after` is empty.

It refuses a reason without a block, a block named twice, and waiver flags on a
report that already passed. The run record keeps a `waiver` object, the reason
and each waived block's name, status and refusal, and the terminal prints them.
Without the flags nothing changes: the report must record an overall pass.

## 6. On failure, before sign-off: reset

```sh
python backend/scripts/cutover_load.py --reset --dry-run \
    --run-record ~/cutover/run-record.json --confirm OWNER_EMAIL \
    --report ~/cutover/reset-dry-run-report.json \
    --expect-host DB_HOST --expect-db DB_NAME --expect-server-addr SERVER_ADDR
# then the same command without --dry-run (and with a new --report path)
```

`--report` is optional for the reset. When given (a new path), a refusal's
details go there at mode 0600: which check failed and which tables or counts
differ, never figures. The terminal shows only `FAIL <check> [<key>]`.

The reset deletes everything the owner owns except the user and the
Household tag, in one transaction. It refuses unless:

- the run record is `complete` and has no `signed_off_at`;
- `--confirm` matches the record's owner email, and that user has the
  record's owner id;
- the database and server address equal the record's;
- the owner has not logged in since the load started;
- the owner's row counts per table, link tables and shares included, equal
  the record's (this catches deletions);
- the fingerprint of the owner's rows equals the record's: every column but
  the timestamps, the tag links and the shares. This catches any edit since
  the load, including a tag rename or a swapped tag link, which move no
  timestamp and no count. Rows with a timestamp after `finished_at` but
  unchanged content (a no-op save, or clock skew) are listed, not refused;
- no other user's transaction, recurring entry or allocation references an
  owner account, category or entry.

Afterwards it checks that the pre-load guard passes again and that every
other user's row counts are unchanged. Then fix the input and reload from
step 3.

**Only if the reset refuses:** restore the dump from step 1. Its blast radius
is the whole database: it wipes every other user's changes since the dump.

## After the window

1. The owner creates the shares in the UI (the joint account and the
   Household tag to the spouse), and the spouse spot-checks the Household
   view.
2. Hermes and any automation are re-enabled.
3. The load-day rows, loaded as unposted, are posted in the UI as they clear.
4. HANDOVER records sanitised metadata only: counts, pass or fail and
   timestamps. No figures, account names, URLs or addresses.
