# Stored card statements

STU-601 (PERF-6). Closed credit-card statements are stored and kept current as rows change, so a read
stops replaying a card's whole history. Code: `backend/app/services/statements_store.py`, the read paths in
`backend/app/services/statements.py` and `backend/app/services/card_credit.py`.

## What is stored and why

A **closed** statement is a cycle whose close is before the Manila day of the read. A closed cycle holds
posted rows only: an unposted row sits on the cycle open on the day it is read (`statements.statement_day`).
So a closed cycle's line-item balance and line count depend on no reader, no day and no exchange rate (a
posted row is in the card's currency or carries its stored rate). Those two figures are what is stored.
Everything else (due, printed due, payments, owed, status, `clear_through`, outstanding) depends on the
reader's visible accounts, the day or the payments, and is still computed on read, from the stored figures
plus the payment rows.

| Table | Key | Columns |
|---|---|---|
| `card_statements` | `(card_id, close)` | `window_start`, `line_balance` (numeric 15,2), `line_count`, `close_day`, `computed_at` |
| `card_statement_state` | `card_id` | `materialized_through` (the last close stored), `close_day` (the close day it was stored under) |

Both cascade on the card's delete. One row per closed cycle from the cycle holding the card's first posted
line through `materialized_through`, empty cycles included. The migration (`d6f8a2c4e1b7`) only creates the
tables; nothing is backfilled.

## Reads

`statements_store.read_card_rows` gives the read the stored cycles through a bound (the earlier of
`materialized_through` and the card's last close before the day read) and only the rows placed after it,
plus the payments. `statement_summaries`, `get_statement_payables`, `card_credit.statements_due`,
`amount_due` and `closed_statements` all read this way. The lines of a statement
(`GET /accounts/{id}/statements`, `statement_history`) are still replayed in full.

**Catch-up.** When time has closed a cycle since the last write, the read first stores it, in a short
transaction of its own, committed at once. It takes the card's lock with `pg_try_advisory_xact_lock`: when the
lock is held (a writer, the request's own session, another catch-up) the card is skipped and the read replays
those cycles from the rows, which gives the same answer.

## Writes (write-through)

A session hook (`before_flush`/`after_flush`, registered on every `Session` in `app/core/database.py`) sees
every new, changed and deleted `Transaction`, and every `Account` whose billing settings change. Inside the
same transaction it:

- recomputes, from the rows, every stored cycle the row was or is placed on (the old placement read from the
  database before the flush, the new one after it);
- deletes and repopulates the card's rows when its close day changes (`billing_cycle_start`, a legacy
  card's `due_date` or `days_until_due_date`, its type). A failure rolls back with the write: the old rows
  stay.

**Locks.** Every writer and the catch-up take `pg_advisory_xact_lock(601, card_id)` per touched credit card,
in card-id order, held to commit. A catch-up that computed a cycle before a back-dated write is overwritten by
the writer's recompute (which waits for the lock); a catch-up during an open write skips the card.

**Bulk writes.** A write that bypasses the ORM (raw SQL, `query(...).update/delete`) is not seen by the hook.
It must call `statements_store.reset_cards` (the card's rows are forgotten; the next read rebuilds them) in
the same transaction. Today: the demo reset (`core/seed.py::_delete_demo_data`) and the cutover reset
(`cutover_load/reset.py::delete_owner_rows`). `test_statements_store_guard.py` scans `app/` and `scripts/`
and fails on any new bulk write to `transactions` or `accounts` that is not reviewed in its `ALLOWED` list.

## Kill switch

`STATEMENTS_STORE=off` (or `0`, `false`, `no`) makes every read replay every row, as before PERF-6. The write
hook always runs, so turning the store back on is safe at any time.

## Read API

`GET /api/v1/cards/{id}/statements?from=&to=` returns the card's closed statements and the cycle open today,
oldest first (`from`/`to` filter by close date): `close_date, window_start, due_date, computed_due_date,
due_overridden, owed, status, line_count, is_closed, incomplete`, and for an owner, admin or editor also `balance,
clear_through, outstanding, paid_since_close` and `card_id`. `GET /api/v1/cards/{id}/statements/{close_date}`
adds the statement's lines (descriptions follow `app/core/redaction.py`; the full view adds `transaction_id`,
`posted_date` and `unconverted_lines`). Any direct role on the card may read; a viewer gets the limited view;
a tag viewer and anyone else get 404, as `GET /accounts/{id}/statements`.

## Command

```
python -m app.scripts.statements_store --expect-host HOST --expect-db NAME (--dry-run | --apply) [--card ID ...]
```

`--expect-host`/`--expect-db` must match `DATABASE_URL` (it refuses otherwise, exit 2). `--dry-run` runs in a
read-only transaction, writes nothing, and prints per card: ids, stored row counts, and yes/no for
`materialized`, `behind`, `rows_equal` and `summaries_equal` (no amounts), then `all_equal`. `--apply` brings
each card up to date under its lock (idempotent: same materialiser, same lock, upsert). Exit 0 all equal, 3 a
difference, 1 an error.

Running it against production, even `--dry-run`, needs the owner's sign-off (plan Q2).
