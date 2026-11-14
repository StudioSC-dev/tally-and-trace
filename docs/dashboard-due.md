# `GET /dashboard/due`: the Due card's one request (STU-599, PERF-4)

The Transactions page's "Due and overdue" card (`frontend/src/components/transactions/DueAndOverdueSection.tsx`)
used to read the whole dashboard snapshot, then fire a second round for the pending rows its
missed rows link, plus two upcoming-occurrence requests and 1,000-row batches of unposted rows.
`/dashboard/due` returns all of that in one response, built from one request context with one
`collect_events` run over the 30-day window. The upcoming-transactions request
(`/transactions?start_date=<tomorrow>&end_date=<today+30>&order=asc&limit=100`) and the
installment plans (`/budget-entries/installment-plans`) stay as they are.

It is a conditional GET (`ETag`/`304`, `core/conditional.py`). Response model: `DashboardDue`
(`backend/app/schemas/dashboard.py`). `today` and every window are the Manila day.

## Field mapping for the card (PERF-8)

| Card today | `/dashboard/due` | Notes |
|---|---|---|
| `snapshot.payables`, `.upcoming_this_month`, `.card_charges`, `.missed`, `.card_statements_due`, `.installment_review`, `.installment_auto_post`, `.autopay_due`, `.auto_post_scheduled`, `.today` | the same keys, same values | Built by the same code as the snapshot (`routers/dashboard._due_lists`); a test asserts equality for every caller. `dueRecurringRows`, `subscriptionPastRows`, `dueStatementRows`, `dueReviewNotice`, `dueTodayLines`, `postNowCount`, `shouldPostOnOpen`, `pendingLinkIds`, `occurrenceCreditCheck` and `freshFor` can take the `/due` body where they take the snapshot (it has every field they read). |
| `usePendingTransactionsByIds(pendingLinkIds(snapshot))` (batches of 500, `is_posted=false`) | `linked_pending: Transaction[]` | Every id `pendingLinkIds` names, as `/transactions?ids=…&is_posted=false` returns them (newest first). No second round. |
| `useGetUpcomingOccurrencesQuery({start: today+1, end: today+30, plan: 'none', limit: 500})` | `upcoming_occurrences: UpcomingOccurrences` | Same shape and values: `{items, total, auto_post_scheduled}`. |
| the same with `plan: 'subscription'` | `subscription_occurrences: UpcomingOccurrences` | As above. |
| window batches `{is_posted: false, end_date: today+30, limit: 1000, offset: i*1000}` ("Load more") | `unposted: {items, total, page, page_size, has_more}`; `?unposted_page=N` | Only rows dated **on or before today** (later ones are in the upcoming-transactions request, which the card already merges), and only `full`/`shared_full` rows (the card drops `limited` ones). Newest first, 200 a page, `total` exact. `duePendingRows(unposted.items, linked_pending, due, today)` and `notPostedRows(unposted.items, today)` give the same rows as before, since both already skip rows after today and limited rows. "Load more" becomes the next `unposted_page`. |

What the card does not get from `/due` (and never read from the snapshot): balances, the monthly
summary, the cash-flow forecast, closings, goals, the wishlist, `currencies` and `fx` (each row
carries its own estimate labels).

## Size

Rows keep the snapshot's shapes, so the owner of the realistic dataset gets about 158 KB
(payables, upcoming and card charges about 97 KB, 64 unposted rows about 53 KB). That replaces
the snapshot (111 KB), the unposted window and the two occurrence requests the card made before.
