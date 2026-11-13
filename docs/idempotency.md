# Idempotent creates (`Idempotency-Key`)

STU-604 (PERF-9). The contract the save outbox (PERF-10) relies on. Code: `backend/app/core/idempotency.py`.

## For a client

Send `Idempotency-Key: <uuid>` on a create. Make the UUID once per save and send the same one on every retry of
that save. The routes that honour it are listed in `OUTBOX_ENDPOINTS` (`core/idempotency.py`):

| Route | Used for |
|---|---|
| `POST /transactions/` | add a transaction |
| `POST /transactions/repeating` | add a transaction that repeats |
| `POST /transactions/{id}/repeat` | make a saved transaction repeat |
| `POST /cards/{id}/payments` | pay a card (one transfer) |
| `POST /budget-entries/` | add a recurring entry |
| `POST /budget-entries/{id}/materialize` | Mark paid, Charged (Due card Record) |
| `POST /budget-entries/{id}/materialize-due` | Post N due |

The Due card's Post of a pending row is `PUT /transactions/{id}` with `{"is_posted": true}`; it is idempotent by
body (a repeat leaves the one posted row) and takes no key. A retried `DELETE` that gets 404 is a success.

| Request | Answer |
|---|---|
| no header | as before |
| first request with a key | the route's normal answer; the answer is stored with the create |
| same user, key, route and body again | the stored status, body and headers, byte for byte; nothing is created |
| same key, other route (path included) or other body | 422 |
| key not a UUID | 422 |
| same key, another user | independent |
| first attempt failed (any non-2xx) | nothing stored; retry with the same key |
| same key while the first request is still running | waits for it, then replays its answer (or runs, if it failed) |

The body is compared as canonical JSON (parsed, keys sorted), so key order and spacing do not matter. A Mark paid
replay also returns the `X-Occurrence-*` headers. Keys live 7 days (the daily `post-due-installments` job deletes
older rows).

## For a route author

Add `idem: Idempotency = Depends(idempotency)` and replace the final `db.commit()` with `finish(idem, db, payload,
model=<response model>, status_code=...)`, building `payload` after `db.flush()`. Add the route to
`OUTBOX_ENDPOINTS`; `test_idempotent_creates_integration.py` fails if a listed route lacks the dependency or an
unlisted one has it.

## Notes

- Table `idempotency_keys` (migration `c3d5e7a9b1f4`). It has one column beyond the plan's, `response_headers`, for
  Mark paid's headers. PERF-7's data-version trigger must exclude this table.
- Retention is by `created_at`; there is no per-row expiry.
