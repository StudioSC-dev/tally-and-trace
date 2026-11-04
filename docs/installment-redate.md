# Card installment re-date runbook

Card installments are charged on the statement close: monthly, anchored on the
card's close day, with each occurrence, `occurrence_date` and `transaction_date`
on the close. New installments are stored that way when they are created. This
script converts the ones stored before, and it is the only conversion path.

- Code: `backend/app/services/installment_redate.py`, wrapper
  `backend/scripts/redate_card_installments.py`.
- Tests: `backend/app/tests/test_installment_redate.py` (the script) and
  `backend/app/tests/test_installment_close_integration.py` (the write path and
  the close-day guard).

## What stays legacy until the script runs

The API never converts an existing row. These rows keep their stored schedule
and behave as they did before:

- every card installment created before this change;
- a row that becomes a card installment through an update: its account changed
  to a card, a cap set, `billing_kind` moved off `bill`;
- a normalised installment moved to a card with a different close day.

An update is refused (422, "This installment is charged on the statement close")
only when it would take an already-normalised entry off the close: a different
cadence, `anchor_day` or `day_rule`, or a `next_occurrence` off the close. A
card's close day cannot change (409) while it has a card installment with
payments left, active or paused.

## What it converts

Every legacy card installment on a card with a statement cycle, active or
paused, with `max_occurrences > 0`. For each one, inside its own savepoint:

- each linked row (the creator's rows `_linked_rows` counts with
  `occurrence_match`) gets `transaction_date` and `occurrence_date` set to the
  close of the statement its `transaction_date` is on;
- the entry gets `next_occurrence` on the close of its own statement (time of day
  kept), `anchor_day` = the close day and `day_rule` = null;
- `is_active`, `max_occurrences` and `occurrences_paid_offset` are never written.

Row dates go through `redate_row`, which re-sums the budgets the row counts
toward at its old and new dates and touches no balance.

## When it refuses an entry

The entry and its rows are left exactly as they were, and the reason is
printed, when:

- the cadence is not monthly;
- a linked row is not on the installment's card (for example a bank debit
  linked by hand);
- a row's occurrence day and its `transaction_date` are on different
  statements;
- two linked rows are on the same statement;
- a posted row would land on or after the new `next_occurrence`, or a pending
  row after it;
- a new row date is outside the record-date range;
- after the write (checked inside the savepoint, then rolled back), any of these
  differs from before, with the entry's old days mapped to their closes:
  - the held-month assignment of the entry's (creator, card) universe through
    today + 62 days, including which charge holds each month;
  - the card's billed installment months as the forecast computes them, with
    the window starting today and on every remaining occurrence (old day and
    new close) from today on;
  - the entry's linked-row membership;
  - `max_occurrences`, `occurrences_paid_offset` and the paid count;
  - the line-item balance of each affected statement.

## Who runs it and how

The owner runs it, in their own shell, with the production URL exported there.
Agents never hold production credentials. Only `DATABASE_URL` is needed; it is
read from the environment, never from a `.env`. `PGHOST`, `PGHOSTADDR`, `PGPORT`,
`PGDATABASE`, `PGSERVICE`, `PGSERVICEFILE`, `PGTZ` and `PGOPTIONS` must be
unset, and the URL must not use the transaction pooler (port 6543).

Dry run (the default; each entry's change is made, checked, then rolled back
before the next entry, so no lock is held across entries; each entry is
checked against the stored data, without the earlier entries' changes):

```sh
DATABASE_URL=postgresql://USER:PASSWORD@HOST:5432/DBNAME \
  python backend/scripts/redate_card_installments.py \
  --expect-host HOST --expect-db DBNAME
```

Paste the dry-run output into the ticket and wait for the owner's go. Then
apply, in a window the owner picks (each entry is locked on its own; no
maintenance window is needed):

```sh
DATABASE_URL=postgresql://USER:PASSWORD@HOST:5432/DBNAME \
  python backend/scripts/redate_card_installments.py \
  --expect-host HOST --expect-db DBNAME --apply
```

The output lists entry and transaction ids, old and new dates, and refusal
reasons. It never prints an amount. A second run reports `changes: 0 entries`.
Exit codes: 0 done (refused entries are listed and left unchanged), 1 an error,
2 refused before connecting (the URL did not match the `--expect-*` flags).

## Expected production plan

- Card A (close 4): no change.
- Card B (close 5): one entry, the 28th moves to the next 5th.
- Card C (close 2): two entries (the 25th and the 27th) move to the next 2nd,
  plus two linked rows from the 27th to the next 2nd.

Any refusal is reported to the owner before anything else is done.
