# Browser regression checks

Standalone Playwright scripts that drive the real web app against a local API.
They are not part of `pnpm build`, the lint, or CI, and the repo does not depend
on Playwright. Run them by hand when you change the auth or session code.

| Script | Covers |
|---|---|
| `refresh-session-switch.cjs` | STU-239: a token refresh stays bound to the session that started it |
| `mark-paid-payables.cjs` | STU-343: expandable payables on the dashboard; Mark paid on a chosen occurrence and date; Post all due, recorded from the Transactions "Due and overdue" section (today and earlier) or the card's Upcoming or Subscriptions tab (later days); STU-463: the record dialog's date label reads "Paid on" for a cash expense |
| `card-charges.cjs` | STU-343: upcoming charges by card on the dashboard (read-only, missed count as text); Posted, Charged and Post all due from the card's Subscriptions tab (the missed Spotify row, STU-511), and an installment's Charged and Posted from its plan row on the Installments tab; STU-462: a pending foreign debit listed by its face currency in the Transactions list, its Details and the section (on its Not posted yet tab, "logged 2 days ago", STU-485); STU-463: the date label reads "Posted on" or "Charged on" by the opener |
| `allocations-kinds.cjs` | STU-343: Allocations groups recurring entries by kind; Charged and Posted on a card; the form picks a card expense's kind; a card installment added from the form reads "Charged monthly on each statement close" in place of the cadence and day pickers and an off-close date is saved on its statement's close (f) |
| `installment-edit.cjs` | STU-343 Plan B: moving a capped entry's next date keeps its last payment (count down, offset up); the edit form sends the version it loaded, so Save after Mark paid is refused with "This entry changed since you opened it; reopen it to edit" and writes nothing; a date after the last payment shows the server's reason inline; the count's final-month help |
| `installment-autopost.cjs` | STU-343 Plan B: a backdated card installment is reviewed before it auto-posts (the review notice, which stays on Due, Review on its plan row on the Installments tab, whose missed months are flagged there, not listed as rows, the dialog's months and duplicate candidates, Move the next date, linking a typed charge); a new one from tomorrow needs no review; Post now for a month due today; a month held as a possible duplicate; no review or auto-post for a viewer, Review for an editor; unposted months on the card panel (which points to Installments: "Review or Mark paid them in Installments"), Pay (with its unposted note) and the statement row in "Due and overdue", whose guidance reads "Review or Mark paid in Installments" (STU-511); a review that goes stale while its dialog is open refetches and records on the second submit; opening Transactions posts a due month with no click and sends no further request once nothing is postable (h); the page-open POST leaves the screen loader hidden and input working while held, though its refetches block (i); it is decided by a fresh snapshot, never the cached one, reached by client-side navigation from the dashboard (j); a throttled page-open POST starts no snapshot refetch (c). On Allocations a card installment reads Auto-post on, off or Not reviewed; an editor's Turn off switches it off and the job then posts nothing for it, and a viewer sees no state, Review or Turn off (f). Every scenario that opens Transactions takes the user's page-open claim first (`consumePageOpen`), except (h), (i) and (j), which test that POST itself |
| `installment-review-batch.cjs` | STU-474: several clean card installments are reviewed at once from the review notice: a checkbox only on a clean row, with a disabled row's reason visible and linked by `aria-describedby`; Select all and "Review selected (N)"; Cancel sends nothing, Confirm sends one POST and shows the result line (a); an entry renamed after the list loaded fails alone, names the entry and can be ticked again (b); one that stops being clean fails and shows its reason (c); the result stays after the last row leaves the notice (d); an editor reviews, a viewer sees no checkboxes (e); a 500 keeps the confirm open and Cancel keeps the selection (f); with 51 clean entries Select all takes the 50 lowest ids, the 51st is disabled with the visible limit line and the POST holds exactly 50 (g). Every scenario checks that no browser dialog fired |
| `due-and-overdue.cjs` | STU-384: the read-only dashboard; the Transactions page's "Due and overdue" section; Mark paid, Mark received, Charged and Posted on recurring rows (Netflix and Spotify, the card subscriptions, are read from the Subscriptions tab, (k) included, and the month Charged is a pending row that stays in Due, STU-511); missed months; pending rows; viewers; paused and ended entries; STU-394: 3 rows a page, overdue first; STU-399: Load-more batches stay live (p) and survive out-of-order refetches (q); STU-473: Mark posted sets the posting date (e, e2, e3, e5) and every posting date reads as its Manila day (e4); a posted date that puts a card row on another statement shows a hint in the Mark posted form (e6) and the edit form (e7), saving is never blocked, and a statement line posted on another day reads "posted <day>" (e8); STU-485: one-off pending rows (Coffee, the posting-form rows of e, e2, e3, e5, and the Load-more rows of p and q) are read from the Not posted yet tab, the viewer's Not posted yet tab is empty (h), and (n) hand-links its pending row so it stays in Due; (s) an overdue loan row and a shared viewer's Limited row on the dashboard read their real day and "Overdue", never "Due today" |
| `not-posted-yet.cjs` | STU-485: the Transactions card has tabs, "Due and overdue", "Not posted yet" and, since STU-511, "Upcoming" (every expectation about the tabs is built from `DUE_TABS` in `_due_pages.cjs`, so a new tab is one entry there). One-off pending rows dated today and earlier are on Not posted yet, oldest first, each as "logged N days ago" or "logged today" with Mark posted and no Overdue; Water bill (hand-linked), a Charged subscription and Rent stay in Due, and a row dated later is in Upcoming once, not in Due or Not posted yet (a); ARIA tab roles and relationships; keyboard and focus order: toggle, selected tab, selected panel, roving tabindex, arrow keys that walk and wrap over every tab, Home and End, and Tab leaving a collapsed card (b); Mark posted sends one PUT, the row leaves and the tab stays (c); the STU-474 notice, its checkboxes and Post now are on Due only and keep their state across a tab visit (d); every tab shows its badge and none switches by itself (e); "logged N days ago" counts Manila days in a browser in Los Angeles and moves at Manila midnight with no reload (f); owner, editor, viewer and tag viewer: a row tied to a paused entry stays in Due, a row whose entry was deleted is a one-off for an editor too (needs the delete-handler fix), Limited rows are on neither tab (g); collapsed, both panel shells stay hidden and empty with their relationships, the tab is kept while the page is open and not across a reload (h); each tab pages on its own (i); at 360 x 740 there is no sideways scroll, every tab and badge is in view, not clipped and at least 24 px tall, and End brings the last tab into view (j). Every scenario checks that no browser dialog fired |
| `card-credit.cjs` | STU-343 Plan C: available credit on the card panel and Accounts rows; the will-it-fail and planned-payment badges; the minimum due rule in the card form; no credit for an editor or viewer; (g) charges dated later in the next 30 days come off on their date, show on their own line apart from the installment hold, and a charge beyond the window counts nowhere; (h) a closed statement's and the open cycle's printed due date, entered and cleared from the card panel, read "(from your statement)" with the computed due in its title, and an out-of-order date shows the server's reason |
| `shared-limit.cjs` | Shared credit limit: a card created linked to another card's limit (Credit Limit hidden, the link sent, no limit sent), the "Shares limit with" line, both Accounts rows and the card panel showing one available figure, the select listing only eligible cards, the primary's form disabled and naming its linked cards, and None unlinking with null (an unchanged link is not sent). The same-available assertions need the API's shared calculation |
| `card-pay.cjs` | STU-343 Plan C: the card's credit panel on its account page; Pay with a suggested Full or Minimum, another amount, a planned payment and the excess note; the statement's own minimum; Manila's day in a UTC browser and at midnight; inactive cards and no payer; no panel or Pay for an editor or viewer; the card's statement row in "Due and overdue" (its figure, Pay from it, Minimum and Full, two owed statements as one Overdue row, no payment account) on any page, and none for an editor or viewer |
| `allocations-credit.cjs` | STU-373 Plan C W3: Allocations shows "Available credit on <card>" under Subscriptions and Card-billed bills for each managed card with an active entry there, and each entry's worst upcoming credit check as a badge; planned payments; no credit for an editor, viewer or tag viewer under a held and a failed request; loading, error and error with stale data; a fresh fetch on client navigation and when Manila's day turns |
| `record-dates.cjs` | STU-404: transaction dates run from 2000-01-01 to Manila today plus 5 years; the Add and Edit forms, Mark paid, card Pay and the loan payment form carry min and max and refuse an out-of-range date before any request, with an inline message in the transaction form and the dialogs' error lines elsewhere; no browser dialog fires |
| `manila-day.cjs` | STU-497: the dashboard and the account page decide their days on Manila's calendar, in a browser zone whose own day differs (Etc/GMT+12 before 20:00 Manila, otherwise Pacific/Kiritimati; a nearby midnight is waited out): a payable due Manila today reads Pending and "Due today", one due Manila tomorrow Planned and "1 day remaining" (a); the account page lists the row dated Manila today and not the one dated Manila tomorrow (b); the Transactions due-window request ends at `<Manila today + 30>T23:59:59.999999Z` (c) |
| `smooth-overlay.cjs` | STU-335: the screen loader. One overlay blocks input while any request is in flight and dims after 300 ms; shield, visible and held timing; a failed save; Reload page after 20 s; the search box stays typeable; dialog semantics and reduced motion; input isolation; Pay, Mark paid and Due blocked until their loads land; the stuck state is announced in the status line and, outside a search, adds no hint line; a tap on the covered page or the search box passes the touch guard without a console warning (`tap`) |
| `smooth-dashboard.cjs` | STU-335: no zero or empty flash before a dashboard figure loads; totals wait for the snapshot currency; Retry refetches only the failed queries without reloading; budget envelopes wait for the snapshot, so they do not move once shown; STU-466: the period window ends at the end of the Manila day, so a row dated today counts at Manila 00:30 (b2), also in a browser in Los Angeles whose own day is still the day before (b4), and an open dashboard moves its window at Manila midnight (b3); (b) runs on the real clock |
| `smooth-accounts.cjs` | STU-335: the Accounts list stays on screen while it reloads; a failed load shows an alert with Retry, never "No accounts yet"; a card row holds a place for its available credit; the list and the shared-accounts section paint together, and a failed household request still paints the list |
| `smooth-allocations.cjs` | STU-335: Allocations and its recurring sections stay on screen while they reload; a stale load-more page is dropped; a failed load shows an alert with Retry instead of an empty list; a failed wishlist load shows an error with Retry, never "Nothing on your wishlist yet." Every scenario checks that no browser dialog fired (STU-410) |
| `smooth-settings.cjs` | STU-335: the category and tag lists show a loader, never their empty text, while they load |
| `smooth-account-detail.cjs` | STU-335: account transaction rows wait for account and category names; a failed names lookup shows fallbacks and a note; the names placeholder has its own test id and is shown while names load, apart from the loading state; the card credit panel's loading state keeps the panel's shape, so the transactions below do not jump |
| `smooth-transactions.cjs` | STU-335: a failed first load shows an error with Retry, not "No transactions found"; a failed month change keeps the rows with the alert above |
| `smooth-sweep.cjs` | STU-335: the shared loaders are announced as a status and stop spinning under reduced motion; the spinner still animates otherwise |
| `smooth-due.cjs` | STU-335: the "Due and overdue" count shows a placeholder until the linked rows first load, never a number that then ticks up; STU-485 (f): with the window query held both badges read "…" and no empty text shows, and the Not posted yet badge then settles once, to its row count; STU-511 (g): with the Upcoming occurrences and transactions requests held on separate gates after a day turn, the Upcoming badge reads "…", no empty text shows, the panel shows none of the previous window's occurrence or transaction rows (and none of its transaction rows once only the transactions are held), and its history is only "…" and its final value |
| `smooth-household.cjs` | STU-335: the household title waits for the sharer's name (a failed request shows "Household" and the alert); household transaction rows wait for account names (a failed dashboard request shows rows and a note) |
| `dialogs-settings.cjs` | STU-410: deleting a category or a tag asks through the in-app Confirm dialog, never the browser's: its semantics, focus on Cancel, the Tab trap and Escape (a); Confirm deletes (b); a refused category delete keeps the dialog open with the server's reason (c); a refused tag delete shows in the tag list (d); a move to another page before accepting (e) or while the delete is held (f) closes it, with no request or no error. Every scenario checks that no browser dialog fired |
| `dialogs-sharing.cjs` | STU-410: changing a share's role (cancelled, then confirmed) (a, b), stopping an account share or the Household share (c), leaving a share or a Household (d), deleting a wishlist item (e) and deleting an account (f) ask through the in-app Confirm dialog, never the browser's; a refused wishlist or account delete keeps the dialog open with the server's reason; a refused active toggle shows in the account actions modal (g). Every scenario checks that no browser dialog fired |
| `dialogs-recurring.cjs` | STU-410: the recurring entry form shows a refused field inline, never in a browser popup: an empty name (a), no account (b), "After runs" with the count cleared (c) and an amount off the 0.01 step (e), a negative Lead Time (f) and a Day of month above 31 (g) each show the field's error with `aria-invalid`, `aria-describedby` and focus on it, and send nothing; a constrained control with no `data-field` shows the form-level message and takes focus (h); every submit clicks the real Save button. Deleting an entry asks through the in-app Confirm: a refused delete (409) keeps it open with the server's reason, Cancel keeps the form and returns focus to Delete, and a retry deletes the entry (d). Every scenario checks that no browser dialog fired |
| `dialogs-transactions.cjs` | STU-410: the transaction form shows its errors inline, never in a browser popup: an empty description (the browser's required check, shown inline) and then no account selected, with focus on the first account chip (a); the posted amount at zero, empty, below its minimum and off its step (the browser's own messages shown inline), the planned amount at zero, a control the form does not wire (its bubble suppressed, its message on the form's own line, with focus) and an empty amount received on a transfer between currencies (b); a refused save keeps the form open with the server's reason (c); a delete from the action modal asks through the in-app Confirm dialog, which keeps a refusal and closes both on success (d); a refused "Mark as not posted" shows in the action modal's error line (e); a link to a transaction that no longer exists shows the in-app toast, on Transactions and after the move back to the dashboard, until dismissed (f). Every scenario checks that no browser dialog fired |
| `dialogs-allocations.cjs` | STU-410: the allocation form shows a refused field inline, never in a browser popup: an empty name with a second field also invalid (a), a budget with no category (b), a negative current amount (d), an end date not after the start (e) and a combined-total tracker with no account (f) each show an error with `aria-invalid` (on a chip group, `aria-describedby` on the group and its chips) and focus on the field or its first chip, and send nothing; a savings-transactions tracker with no "Savings" category shows the form's own line (g); every submit clicks the real Save button. Deleting an allocation asks through the in-app Confirm: a refused delete (500) keeps it open with the server's reason, Cancel keeps the action modal and returns focus to Delete, and a retry deletes it (c). Every scenario checks that no browser dialog fired |
| `upcoming-occurrences.cjs` | STU-465, STU-511: the Transactions card's Upcoming tab is the next 30 days (T+1 to T+30) from the Manila day, fixed: the month, search and filters do not change it (g, h), "Through <date>" heads it and T+30 is listed with T+31 not (h). Rows are compact, with no article: a planned transaction opens the page's action modal on a tap (m), and a recurring occurrence has its own Mark paid, Mark received, Charged or Posted. The ticket's three salaries, each month once with Mark received, a linked planned row standing for its month (a); Mark received on a future occurrence sends one POST and the row moves where its date puts it (b); Mark paid on a cash expense, and Charged then Posted on a card subscription read from Subscriptions (c); card installments are one plan row each on Installments, with the later months' recordability read from the API (d); a paused entry, then resumed (e); an editor's rows with buttons per `can_mark_paid`, none for a viewer (f); over 100 items the badge is the total, "showing the next 100 of N", the pager reads 1-3 of 100, and exactly one ascending window request (`order=asc&limit=100`) is sent (i); "Due and overdue" holds Manila today and earlier only, card entries are on Subscriptions or Installments, and each entry's day is listed once across the tabs (j). The lists split on Manila's day in a browser zone whose local day differs (k); crossing Manila's midnight on the browser clock sends exactly one new request each for the main list, the Upcoming transactions, the snapshot and each occurrence partition (`plan=none`, `plan=subscription`), and "Through" moves by a day, on a custom range too (l); (m) Upcoming's placement: no page section, the tab order, no article, the action modal and Delete, page 2 kept across a tab visit, no Load more. Every scenario checks that no browser dialog fired |
| `save-and-add-another.cjs` | STU-475: "Save and add another" in the Create Transaction dialog: the row is saved, the dialog stays open with a `Saved "Coffee ₱180.00"` status line, description and amount cleared and focus on Description, then the primary button saves the last row and closes (a); the recurring link, tags and posting date are cleared while the category, date and posted mode are kept (b); a transfer keeps its destination and clears the fee and amount received (c); the screen loader stays hidden for the save and the refetches it starts, the fields locked only while the POST is held and the submit buttons until its refresh settles (d); an unrelated request and a primary save still block, and a save tried during the refresh waits, then sends fresh requests so the list and balance show both rows (d2); with 1005 rows in the Upcoming window, the page load sends exactly one window request (`order=asc&limit=100`, no offset above 0) and one held after Save and add another stays off the loader with no second request after release (d3); a primary save's refetches still block (d4); a refused save keeps everything and the server's reason, an empty amount and an out-of-range date show inline and clear the status line (e); Edit keeps one button (f); Cancel after a save closes the dialog and the next open is fresh (g); a foreign currency chosen while pending does not ride into the next posted entry (h); every field is locked while the POST is held (h2); Cancel, reopen and then the abandoned POST succeeding (i1) or failing (i2) touches nothing in the new dialog; closing the dialog mid-refresh hands the held refresh to the screen loader (j); after Cancel and reopen the submit buttons, Enter and a buttonless submit wait until the abandoned save and its refresh have settled, then the next save sends a fresh list request (k). Overlay phases are recorded from before login (`openWithPhaseRecorder`). Every scenario checks that no browser dialog fired |
| `plan-tabs.cjs` | STU-511: the card's Subscriptions and Installments tabs. (a) the split: each entry on exactly one tab, each badge equal to its rows; (b) a missed subscription is a missed row on Subscriptions and Charged moves it to Due as a pending row; (c) an installment is one plan row, "N of M left", Charged keeps the row and counts down, an overdue plan flags "N missed", Review and auto-post states, a paused plan absent; (d) the owner's credit badge on a card subscription, none for an editor or on Installments; (e) an overdue subscription occurrence is flagged; (f) empty, pager and the 500-occurrence cap seeded with more than 520 installment occurrences; (g) the Manila day in a Los Angeles browser; (h) STU-511 7b: a bank-paid subscription marked with the recurring form's Subscription choice moves to Subscriptions and back; (i) a held Manila day rollover keeps both badges at "…" until fresh data arrives, and Subscriptions stays at "…" while its occurrences are held after the snapshot lands, showing none of the previous window's occurrence rows; (j) when one source of Upcoming or Subscriptions fails and the other loads, the badge reads 0 and the error shows, and Retry recovers; (k) when a row moves between a tab's sources and the next refresh of one source fails, the badge keeps the last complete total instead of counting the row twice, and keeps it through Retry while each held request runs, never showing the mixed sum; (l) when the subscription occurrences fail while the snapshot comes back dated the old day, Subscriptions settles on its kept total with the error, never "…" for good; (m) on a first load where the Upcoming occurrences fail while the transactions are held, the badge reads 0 at once. The Upcoming, Subscriptions and Installments badges follow `dueTabBadge` in `@tally-trace/shared`. No browser dialog fires |
| `forced-dates.cjs` | Forced dates UI: Change date on a Due row (it leaves Due for Upcoming, reading "(moved from ...)") and on an Upcoming or Subscriptions row; the dialog shows the server's refusal inline and Clear restores the date (b); Mark paid opens on the effective date (c); the loan page lists the next three open due dates with Change date (d); the dashboard shows "(moved from ...)" (e); an editor changes a date, a viewer has no action and the API answers a viewer's or stranger's PUT with 404 (f); a card subscription moved past the close confirms the new statement and the statement total in the dashboard payables moves (g); a date in a closed statement shows its reason (h); Change date on a missed row, the oldest unlinked missed day: owner and editor have it, a view-only viewer gets no missed row, its forced date is pre-filled, a future date is refused while another missed day follows, a past day keeps the row missed with "since" on that day, Clear restores it (j); a single missed day moved into the future leaves the missed list for Upcoming as "(moved from ...)" and Clear brings it back (k); the same on the Subscriptions tab's missed row (l). Every scenario checks that no browser dialog fired |
| `settlement.cjs` | Settlement UI (autopay or manual): every dashboard cash entry and loan row names its settlement, a card subscription and income read Scheduled and a card subscription or transfer has no form control (a); the recurring form defaults to Manual and its toggle, and the loan page's, change the row from the server's returned flag (b); turning on over missed payments shows the count and posts each on its own day on confirm (c) and Cancel posts nothing (d); a blocked record shows plain wording and cannot be turned on (e); a payment held for funds is named on the dashboard (f); opening Transactions posts a due autopay entry and loan (g); an editor sees no loan control (h) |

`refresh-session-switch.cjs` expects an API and dev server you start yourself
(steps below). The newer scripts start their own through `_local_stack.cjs`
(see [Scripts that start their own stack](#scripts-that-start-their-own-stack)).

## Run

The scripts register users and write to the database. Use a **local, throwaway
Postgres only**. Never run the API from `backend/.env`, which may point at a
real database. The script refuses to run unless `DATABASE_URL` is on
`127.0.0.1` or `localhost`.

1. Start a local Postgres and create an empty database, for example:

   ```bash
   docker run -d --name tt-e2e-pg -e POSTGRES_PASSWORD=pw -p 127.0.0.1:55432:5432 postgres:16
   docker exec tt-e2e-pg psql -U postgres -c "CREATE DATABASE tt_e2e"
   ```

2. Run the API against it, with the backend virtualenv active. Export the
   settings in your shell: exported variables take priority over any
   `backend/.env`. Confirm the resolved database before migrating, and start the
   server from a directory with no `.env` file (settings read `.env` from the
   working directory):

   ```bash
   export DATABASE_URL='postgresql://postgres:pw@127.0.0.1:55432/tt_e2e'
   export SECRET_KEY='local-e2e-only'
   export ENVIRONMENT=development
   export BACKEND_CORS_ORIGINS_STR='http://localhost:5173'
   export FRONTEND_BASE_URL='http://localhost:5173'
   export RESEND_API_KEY='' SENTRY_DSN=''
   (cd backend && python -c "from app.core.config import settings; print(settings.DATABASE_URL)")  # must print the local URL
   (cd backend && alembic upgrade head)
   (cd /tmp && uvicorn app.main:app --app-dir "$OLDPWD/backend" --port 8000)
   ```

3. In another shell, start the dev server pointed at that API:

   ```bash
   cd frontend && VITE_API_URL=http://localhost:8000 pnpm dev --port 5173 --strictPort
   ```

4. Get Playwright outside the repo (no dependency is added here), then run the
   script from the repo root. `psql` must be on `PATH`, because the script
   marks its test users verified directly in the database.

   ```bash
   npm install --prefix /tmp/pw playwright@1.58.1
   npx --prefix /tmp/pw playwright install chromium
   export PLAYWRIGHT_PATH=/tmp/pw/node_modules/playwright
   export E2E_API_URL=http://localhost:8000 E2E_WEB_URL=http://localhost:5173
   node frontend/e2e/refresh-session-switch.cjs        # all scenarios
   node frontend/e2e/refresh-session-switch.cjs e      # one scenario: c..f
   ```

   `DATABASE_URL` must still be exported in this shell. Set `DEBUG=1` to log
   every API response. The script exits 0 only when every assertion passes, and
   prints `RESULT: <passed>/<total>`.

5. Drop the database afterwards, for example
   `docker rm -f tt-e2e-pg`.

## Scripts that start their own stack

`mark-paid-payables.cjs` (and later scripts) start the API and the web app
themselves through `_local_stack.cjs`, which is the only way they reach an API:

- `DATABASE_URL` must pass the backend test guard's URL rules: scheme
  `postgresql`, `postgresql+psycopg2` or `postgresql+psycopg`; host
  `127.0.0.1`, `localhost` or `::1` (one only); no query string or fragment;
  database `tally_trace_test` or `tt_test_<lowercase, digits, _>`. Anything
  else is refused before a process starts.
- Every child (alembic, uvicorn, `pnpm dev`, psql) gets one sanitised
  environment: only `PATH`, `HOME` and `VIRTUAL_ENV` are passed through, no
  `PG*` routing variable, `TT_DISABLE_DOTENV=1` (no `.env` file is read), the
  guarded `DATABASE_URL`, local-only `SECRET_KEY`, CORS and frontend URLs, and a
  local-only `JOB_TOKEN` (the installment job answers, and auto-post reads "each
  morning").
- Alembic runs from `backend/`; uvicorn runs from the temp directory on a free
  port; `pnpm dev` gets `VITE_API_URL` pointed at it.
- Marking a test user verified must report `UPDATE 1`, or the run aborts.
- The children are stopped when the script exits.

1. Create an empty throwaway database on a local Postgres, for example:

   ```bash
   docker run -d --name tt-e2e-pg -e POSTGRES_PASSWORD=pw -p 127.0.0.1:55432:5432 postgres:16
   docker exec tt-e2e-pg createdb -U postgres tt_test_e2e
   ```

2. Create the backend virtualenv once (from the repo root), if it is missing.
   The stack uses `$VIRTUAL_ENV`, else `backend/.venv`:

   ```bash
   (cd backend && uv venv .venv && uv pip install --python .venv/bin/python -r requirements.txt)
   ```

3. Get Playwright outside the repo (step 4 above), then run from the repo root
   with `psql` and `pnpm` on `PATH`:

   ```bash
   export DATABASE_URL='postgresql://postgres:pw@127.0.0.1:55432/tt_test_e2e'
   export PLAYWRIGHT_PATH=/tmp/pw/node_modules/playwright
   node frontend/e2e/mark-paid-payables.cjs        # all scenarios
   node frontend/e2e/mark-paid-payables.cjs b      # one scenario: a..e
   ```

   Set `DEBUG=1` to log the children's output and every API response. The
   script exits 0 only when every assertion passes, and prints
   `RESULT: <passed>/<total>`. Drop the database afterwards.

## Page smoothness and screen loader checks

The `smooth-*.cjs` scripts start their own stack, as above. Each takes an
optional scenario name (`node frontend/e2e/smooth-accounts.cjs c`), prints
`RESULT: <passed>/<total>`, and exits 0 only when every check passed, 1 when a
check failed, 2 when setup (stack, seed or login) failed. Each check is
behavioural, structural or a guard; a failed structural check means the run is
invalid, not that the app is wrong. Use a database name of its own per run, for
example `tt_test_stu335_a`, and run two scripts at once only with two databases.

```bash
export VIRTUAL_ENV=/path/to/a/venv/with/backend/requirements   # else backend/.venv
export DATABASE_URL='postgresql://postgres:pw@127.0.0.1:55432/tt_test_stu335_a'
export PLAYWRIGHT_PATH=/tmp/pw/node_modules/playwright
node frontend/e2e/smooth-overlay.cjs
node frontend/e2e/smooth-dashboard.cjs g2     # one scenario
```

Their shared helpers live in `_smooth.cjs`: held and gated responses, a request
recorder, the overlay's recorded `data-phase` history, and `waitQuiet(page)`.

The `dialogs-*.cjs` scripts (STU-410) start their own stack the same way and also use
`_dialogs.cjs`: `trackNativeDialogs(page)` counts, logs and dismisses every browser
alert, confirm or prompt, `checkNoNativeDialogs` is the check each scenario ends with (the
count is 0), and `confirmDialog(page)` gives the in-app Confirm dialog's locators.

Since the screen loader blocks input while any request is in flight, a script
that acts right after a navigation or a dialog opens must call
`waitQuiet(page)` first. It waits, bounded and never throwing, for the overlay
to be hidden. Scripts also must not click while they hold a request on purpose:
do the click before the hold starts or after it is released. The older scripts
(`card-pay`, `mark-paid-payables`, `due-and-overdue` and the shared
`_due_pages.cjs`) call `waitQuiet` for this reason.

A script that opens a card tab with `openDueTab` or `readTab` registers its
`check` with `useDueCheck(check)` first. `openDueTab` (and `expectDueTab`, for a
script that waits on a tab's badge before opening it) records an assertion that
the tab exists before it waits on it, and a page step that does not land records
a failed assertion, so a build without the tab or its paging fails an assertion
instead of a timeout.

In the same way, a script waits for a dialog, modal or form it opens with
`dialogOpened(locator, what)`: a bounded wait that records `what` as an
assertion and returns whether it opened, so a button that opens nothing fails
that assertion and the scenario ends instead of timing out.
