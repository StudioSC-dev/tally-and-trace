# Card close-day change runbook

A bank can move a card's statement closing day. The app keeps one closing day for
a card's whole history, so a new day re-places every row and re-keys every
statement. `PUT /accounts/{id}` refuses the change (409) while the card has a card
installment with payments left or a printed due. This script makes the change for
one card, in one transaction: all of it is written, or none of it.

- Code: `backend/app/services/close_day_change.py`, wrapper
  `backend/scripts/change_card_close_day.py`. The installment step reuses
  `backend/app/services/installment_redate.py` (docs/installment-redate.md).
- Tests: `backend/app/tests/test_close_day_change.py`.

## What it changes

- The card's `billing_cycle_start` becomes the new day. The stored statements
  (docs/statements-store.md) are rebuilt under it by the usual flush hook.
- Each printed due (`card_statement_due_overrides`) and each minimum due
  (`card_statement_minimums`) moves from its old close to the new close of the
  same month. The new day is clamped to the month's length, as the cycle code
  clamps it (a 31 is the 30th in November). The due date and the amount stay.
- Each card installment on the card with payments left (`max_occurrences > 0`,
  active or paused, whoever created it) is re-dated onto the new close, with the
  re-date's own mapping and checks: its `next_occurrence`, `anchor_day`, and each
  linked row's `transaction_date` and `occurrence_date`.
- Completed installments and their rows are not touched.

## Locks

In `core/locking.py` order: the budget lock of each installment's creator
(ascending owner id), each installment (ascending id), each linked row (ascending
id), then the card. The installments and their linked rows are read again under
the card lock and must not have changed. The re-date of each installment takes
the same locks again (all already held), then the budget allocations.

## When it refuses

Nothing is written, and every reason is printed, when:

- the card is not a credit card, has no statement cycle, or has only the legacy
  `due_date` set;
- the new day is not from 1 to 31, or is the day the card already has;
- a printed due or minimum due is not on a close of the card;
- a moved printed due would not be after its new close, or would be out of order
  with its neighbours (`statements.due_override_conflicts`);
- a moved minimum due would land on a statement that has not closed yet;
- any installment is refused by the re-date (for example a forced date in
  `payment_date_overrides`; see docs/installment-redate.md for the full list);
- an installment date on the old close would move anywhere but the new close of
  the same month. This is what a change to an earlier day does (a charge on the
  14th is past a close on the 13th), so such a change is refused while open
  installments sit on the close;
- after the write, any check fails:
  - an installment is not on the new close;
  - the card's total of statement line items, over every statement, differs;
  - a closed statement, its old close mapped to the new close of the same month,
    holds different rows, a different line count or a different line balance,
    and `--accept-history-shift` was not passed;
  - the stored statements do not match the rows (`statements_store.verify_card`).

With `--accept-history-shift` the change goes ahead when past statements change.
Either way the output lists each such statement (old close, new close) and the
ids of the rows that moved in and out.

## Who runs it and how

The owner runs it, in their own shell, with the production URL exported there.
Agents never hold production credentials. Only `DATABASE_URL` is needed; it is
read from the environment, never from a `.env`. `PGHOST`, `PGHOSTADDR`, `PGPORT`,
`PGDATABASE`, `PGSERVICE`, `PGSERVICEFILE`, `PGTZ` and `PGOPTIONS` must be unset,
and the URL must not use the transaction pooler (port 6543).

Dry run (the default; every change is made and checked, then rolled back):

```sh
DATABASE_URL=postgresql://USER:PASSWORD@HOST:5432/DBNAME \
  python backend/scripts/change_card_close_day.py \
  --card-id N --close-day D --expect-host HOST --expect-db DBNAME
```

Paste the dry-run output into the ticket and wait for the owner's go. If it lists
past statements that change and the owner accepts them, add
`--accept-history-shift`. Then apply:

```sh
DATABASE_URL=postgresql://USER:PASSWORD@HOST:5432/DBNAME \
  python backend/scripts/change_card_close_day.py \
  --card-id N --close-day D --expect-host HOST --expect-db DBNAME \
  [--accept-history-shift] --apply
```

The output lists ids, old and new dates, and refusal reasons. It never prints an
amount. A second run is refused: the card already closes on that day.
Exit codes: 0 changed (in a dry run: would change), 3 refused (nothing written),
1 an error (nothing written), 2 refused before connecting (the URL did not match
the `--expect-*` flags).
