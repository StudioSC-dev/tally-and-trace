// Browser check for STU-343 Plan B (B2): card installments are reviewed before they
// auto-post, and months that are due can be posted from Due and overdue, the card's
// credit panel and the Pay dialog. Starts its own API and web app against a throwaway
// database (./_local_stack.cjs, which sets JOB_TOKEN, so the job endpoint answers and an
// installment that is on reads "Auto-posts each morning"). PHP only. Not wired into CI
// and not part of `pnpm build`. Run steps: see ./README.md.
//
// Every expected month, count and figure is read from the API; dates are relative to
// Manila's today.
//
// Scenarios:
//   (a) a backdated installment with a hand-typed duplicate: its missed row reads
//       "Review to auto-post" with Review, and the review notice lists it. The dialog
//       lists the API's missed months and the candidate; "Move the next date instead"
//       opens the edit form and Cancel comes back. Linking the candidate, then "Record 3
//       months and turn on auto-post": the missed row is gone and the API shows one
//       linked row per month (the typed one among them), reviewed and on
//   (b) a new installment created in the form with its first date tomorrow: the API shows
//       it reviewed and on, and Due and overdue shows no review notice
//   (c) a reviewed installment due today: a due-today line with "Auto-posts each
//       morning" and "Post 1 due installment month now"; clicking it shows "Posted 1",
//       and the button and the line are gone; the API has the linked row
//   (d) a reviewed installment due today with a candidate the day before: the job holds
//       it (possible_duplicate), so its line reads "Possible duplicate · Review" and there
//       is no Post now; Review, recording without linking, posts the month and the line
//       is gone, leaving the candidate unlinked
//   (e) on a joint card, a viewer sees no review notice, no Review, no Post now, no
//       auto-post label and no full row for the entry (Limited rows carry no button);
//       the editor sees the notice and Review on the missed row, and completes a review
//       from the notice
//   (k) the review goes stale while its dialog is open (the entry is renamed through the
//       API): submitting shows "This installment changed since you opened the review", the
//       dialog refetches and shows the new name, and a second submit records the months
//   (f) on Allocations a new installment reads "Auto-post on"; an editor's Turn off makes
//       it read "Auto-post off" with Review, and the job then posts nothing for it; a
//       viewer sees no auto-post state, Review or Turn off
//   (g) a reviewed installment with two months on closed cycles and no recorded statement:
//       the account page's credit panel says "2 installment months not yet posted" with
//       the API's dates, Pay says "Post the installment months first"; Post now posts 2,
//       the block goes, Pay opens on the API's statements with Full prefilled and no
//       unposted note, and "Posted 2" stays. The same card with auto-post off points to
//       Due and overdue instead, Pay says why, and Due and overdue lists the card for its
//       unposted months alone (no Pay, "Review or Mark paid below"), the missed row
//       reading "Auto-post off · Mark paid". A card with a recorded statement and two
//       postable unposted months opens Pay with "Full leaves out 2 installment months
//       not yet posted" and Post due installments now
//   (h) a reviewed installment due today is posted by opening Transactions, with no click:
//       "Posted 1 due installment month", the API has the linked row, the due-today line
//       is gone, leaving and coming back sends no page-open request, and a viewer opening
//       Transactions sends none
//   (i) the screen loader stays hidden while the page-open POST is held and input works;
//       the refetches the post starts do block (the known limit)
//   (j) the page-open POST is decided by a fresh snapshot, never a cached one: reached by
//       client-side navigation from the dashboard, which shares the snapshot cache entry
//       (j.1 cached 0 / fresh 1 posts; j.2 cached 1 / fresh 0 does not; j.3 the same JSON
//       twice still posts, which fails an effect keyed on the snapshot alone)
//
// Every request-starting action is followed by waitQuiet(page) (the screen loader
// blocks input while a request is in flight; see ./README.md). Nothing is clicked or
// typed while a request is held, except in (i), which holds the exempt page-open POST.
//
// From commit 11, opening Transactions fires the page-open POST. Every scenario that
// opens Transactions therefore takes each user's 15-minute claim BEFORE it creates its
// entries (consumePageOpen, via makeOpener): the later page open is throttled and the
// button, the job or the review is what posts. (h), (i) and (j) test the page-open POST
// itself and do not. (g) and its variants open only the card's account page, which has no
// page-open trigger; (g2) opens Transactions with auto-post off, so nothing is postable.
//
// Usage: node frontend/e2e/installment-autopost.cjs [a|b|c|d|e|f|g|h|i|j|k]
const util = require('node:util')
const { startLocalStack, consumePageOpen } = require('./_local_stack.cjs')
const { allDueRows, showRow } = require('./_due_pages.cjs')
const { gate, logRequests, overlayPhase, readTexts, recordTexts, resetTexts, sleep, waitPhase, waitQuiet } = require('./_smooth.cjs')

const playwrightPath = process.env.PLAYWRIGHT_PATH || 'playwright'
let chromium
try {
  ;({ chromium } = require(playwrightPath))
} catch {
  console.error(`Cannot load Playwright from "${playwrightPath}". Set PLAYWRIGHT_PATH (see frontend/e2e/README.md).`)
  process.exit(2)
}

const only = process.argv[2]
let pass = 0, total = 0
function check(what, actual, expected) {
  total++
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (ok) pass++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${what}: actual=${JSON.stringify(actual)} expected=${JSON.stringify(expected)}`)
}

// ─── Days (YYYY-MM-DD, UTC arithmetic) ───────────────────────────────────────
const manilaToday = () => new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10)
const addDays = (day, n) => {
  const d = new Date(`${day}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().slice(0, 10)
}
const dom = (day) => Number(day.slice(8, 10))
const daysIn = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate()
/** `day` moved by n months, on day-of-month `anchor` (clamped to the month). */
const addMonths = (day, n, anchor = Number(day.slice(8, 10))) => {
  let y = Number(day.slice(0, 4))
  let m = Number(day.slice(5, 7)) + n
  while (m > 12) { m -= 12; y += 1 }
  while (m < 1) { m += 12; y -= 1 }
  return `${y}-${String(m).padStart(2, '0')}-${String(Math.min(anchor, daysIn(y, m))).padStart(2, '0')}`
}
const suffix = (d) => (d % 100 >= 11 && d % 100 <= 13 ? 'th' : ['th', 'st', 'nd', 'rd'][d % 10] || 'th')
/** As the app shows a day: "Oct 25th, 2026". */
const fmt = (day) => {
  const d = new Date(`${day}T00:00:00Z`)
  const month = new Intl.DateTimeFormat('en-US', { month: 'short', timeZone: 'UTC' }).format(d)
  return `${month} ${d.getUTCDate()}${suffix(d.getUTCDate())}, ${d.getUTCFullYear()}`
}
const wire = (day) => `${day}T00:00:00`
/**
 * About 65 days back, on a day of the month no later than the 28th: monthly from it,
 * three months fall due before today (the last at least 3 days ago) and the fourth is
 * at least 3 weeks ahead.
 */
const backdatedStart = () => {
  const day = addDays(manilaToday(), -65)
  return dom(day) > 28 ? `${day.slice(0, 8)}28` : day
}

let stack, API
async function api(token, method, url, body, headers = {}) {
  const res = await fetch(`${API}${url}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await res.text()
  let json = null
  try { json = JSON.parse(text) } catch { json = text }
  return { status: res.status, json }
}
async function post(token, url, body) {
  const r = await api(token, 'POST', url, body)
  if (r.status >= 300) throw new Error(`POST ${url} ${r.status} ${JSON.stringify(r.json)}`)
  return r.json
}
const get = async (token, url) => {
  const r = await api(token, 'GET', url)
  if (r.status >= 300) throw new Error(`GET ${url} ${r.status} ${JSON.stringify(r.json)}`)
  return r.json
}

async function makeUser(tag) {
  const email = `e2e-iap-${tag}-${Math.random().toString(16).slice(2, 8)}@example.com`
  const password = 'E2eTest!2345'
  const reg = await api('', 'POST', '/auth/register', { email, password, first_name: `User${tag}`, last_name: 'Test', default_currency: 'PHP' })
  if (reg.status !== 200 && reg.status !== 201) throw new Error(`register ${reg.status} ${JSON.stringify(reg.json)}`)
  stack.verifyUser(email) // aborts the run unless psql reports UPDATE 1
  const login = await api('', 'POST', '/auth/login', { email, password })
  if (login.status !== 200) throw new Error(`login ${login.status}`)
  return { email, password, tag, token: login.json.access_token }
}

/** A user who will open Transactions: takes their page-open claim now, before any entry exists. */
async function makeOpener(tag) {
  const u = await makeUser(tag)
  await consumePageOpen(api, u)
  return u
}

/** A PHP card closing on `closeDom`, due 21 days later, paid from a checking account. */
async function makeCard(u, name, closeDom = 28) {
  const bank = await post(u.token, '/accounts/', { name: `${name} Checking`, account_type: 'checking', balance: 100000, currency: 'PHP' })
  const card = await post(u.token, '/accounts/', {
    name, account_type: 'credit', balance: 0, currency: 'PHP', credit_limit: 100000,
    billing_cycle_start: closeDom, days_until_due_date: 21, payment_account_id: bank.id,
  })
  return { bank, card }
}
/** A monthly card installment: `count` payments from `next`. */
const installment = (u, card, name, amount, next, count) => post(u.token, '/budget-entries/', {
  entry_type: 'expense', currency: 'PHP', cadence: 'monthly', name, amount,
  account_id: card.id, next_occurrence: wire(next), end_mode: 'after_occurrences', max_occurrences: count,
})
/** A hand-typed posted charge on the card, linked to nothing. */
const charge = (u, card, amount, day, description) => post(u.token, '/transactions/', {
  account_id: card.id, transaction_type: 'debit', amount, description, transaction_date: wire(day), is_posted: true,
})
const entryNow = (u, id) => get(u.token, `/budget-entries/${id}`)
const flags = (e) => ({ reviewed: e.installment_reviewed, on: e.auto_post_enabled })
/** The card's rows linked to the entry (the creator sees `budget_entry_id`). */
const linkedRows = async (u, card, entryId) =>
  (await get(u.token, `/transactions/?account_ids=${card.id}&limit=1000`)).items.filter((t) => t.budget_entry_id === entryId)
/** Sets the review flags directly: reviewing through the API would record the months. */
function setReviewed(id, on) {
  if (!Number.isInteger(id)) throw new Error(`unexpected entry id ${id}`)
  const out = stack.psql(`UPDATE budget_entries SET installment_reviewed_at = now(), auto_post_enabled = ${on ? 'true' : 'false'} WHERE id = ${id}`)
  if (out !== 'UPDATE 1') throw new Error(`setting the review flags reported "${out}"`)
}

async function newPage(browser) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 1000 } })
  const page = await ctx.newPage()
  if (process.env.DEBUG) page.on('response', (r) => { if (r.url().includes('/api/v1/')) console.log(`    [net] ${r.request().method()} ${r.url().replace(API, '')} -> ${r.status()}`) })
  return { ctx, page }
}

async function uiLogin(page, u) {
  await page.goto(`${stack.webUrl}/login`)
  await page.locator('#email').fill(u.email)
  await page.locator('#password').fill(u.password)
  await page.getByRole('button', { name: 'Sign in', exact: true }).click()
  await page.waitForURL((url) => url.pathname === '/')
  await waitQuiet(page)
}

async function openTransactions(page) {
  await page.goto(`${stack.webUrl}/transactions`)
  await page.locator('[data-testid="due-section"]').waitFor()
  await page.locator('[data-testid="due-count"]').filter({ hasNotText: '…' }).waitFor()
  await waitQuiet(page)
}
async function openPanel(page, cardId) {
  await page.goto(`${stack.webUrl}/accounts/${cardId}`)
  await page.locator('[data-testid="card-credit-panel"]').waitFor()
  await waitQuiet(page)
}

const text = async (locator) => (await locator.textContent())?.replace(/\s+/g, ' ').trim()
const testId = (page, id) => page.locator(`[data-testid="${id}"]`)
const reviewDialog = (page) => testId(page, 'installment-review-dialog')
const dueToday = (page, entryId) => page.locator(`[data-testid="due-today-line"][data-source="budget_entry:${entryId}"]`)
const missedRow = (page, entryId) => page.locator(`[data-testid="due-row"][data-kind="missed"][data-source="budget_entry:${entryId}"]`)
/** The entry's missed rows over every page. */
const missedRows = async (page, entryId) =>
  (await allDueRows(page)).filter((r) => r.kind === 'missed' && r.source === `budget_entry:${entryId}`)

/** Waits (bounded) until `locator` has `n` matches; returns the last count seen. */
async function waitCount(page, locator, n, ms = 15000) {
  const until = Date.now() + ms
  for (;;) {
    const count = await locator.count()
    if (count === n || Date.now() > until) return count
    await page.waitForTimeout(250)
  }
}

async function openReview(page, button) {
  await button.click()
  await reviewDialog(page).waitFor()
  await testId(page, 'installment-review-submit').waitFor()
  await waitQuiet(page)
}
async function submitReview(page) {
  await testId(page, 'installment-review-submit').click()
  await waitQuiet(page)
  return waitCount(page, reviewDialog(page), 0)
}

// ─── (a) review a backdated installment, linking its duplicate ────────────────
async function reviewWithDuplicate(browser) {
  console.log('(a) a backdated installment is reviewed, its duplicate linked')
  const me = await makeOpener('a')
  const { card } = await makeCard(me, 'Visa A')
  const start = backdatedStart()
  const entry = await installment(me, card, 'Laptop', 2500, start, 12)
  const typed = await charge(me, card, 2500, addDays(addMonths(start, 1), 1), 'Laptop typed by hand')
  const api0 = await get(me.token, `/budget-entries/${entry.id}/auto-post-review`)
  const months = api0.missed.map((m) => m.occurrence_date)
  check('(a) the API lists three missed months', months, [start, addMonths(start, 1), addMonths(start, 2)])
  check('(a) the typed charge is the second month\'s candidate', api0.candidates.map((c) => [c.occurrence_date, c.transactions.map((t) => t.id)]), [[addMonths(start, 1), [typed.id]]])
  check('(a) it starts unreviewed and off', flags(await entryNow(me, entry.id)), { reviewed: false, on: false })

  const { ctx, page } = await newPage(browser)
  await uiLogin(page, me)
  await openTransactions(page)
  check('(a) the review notice counts it', await text(testId(page, 'due-review-notice-toggle')), "1 card installment doesn't auto-post yet")
  const row = await showRow(page, missedRow(page, entry.id))
  check('(a) the missed row reads "Review to auto-post"', await text(row.locator('[data-testid="due-auto-post"]')), 'Review to auto-post')
  check('(a) the missed row has Review', await row.locator('[data-testid="due-review"]').count(), 1)
  await openReview(page, row.locator('[data-testid="due-review"]'))
  const dialog = reviewDialog(page)
  check('(a) the dialog names the entry and the card', await text(testId(page, 'installment-review-title')), 'Turn on auto-post for Laptop (Visa A)')
  check('(a) the dialog lists the API\'s missed months',
    await dialog.locator('[data-testid="installment-review-month"]').evaluateAll((els) => els.map((e) => e.dataset.month)), months)
  check('(a) the month texts', await dialog.locator('[data-testid="installment-review-month"]').allInnerTexts(), months.map(fmt))
  const group = dialog.locator(`[data-testid="installment-review-candidates"][data-month="${addMonths(start, 1)}"]`)
  check('(a) the candidate is offered under its month',
    await group.locator('[data-testid="installment-review-candidate"]').evaluateAll((els) => els.map((e) => Number(e.dataset.transactionId))), [typed.id])
  check('(a) the toggle names the month', (await text(group.locator('label'))).startsWith(`This is the ${fmt(addMonths(start, 1))} charge`), true)
  check('(a) the button counts the months', await text(testId(page, 'installment-review-submit')), 'Record 3 months and turn on auto-post')

  // "Move the next date instead" opens the entry's edit form; Cancel comes back to the review.
  await testId(page, 'installment-review-move-date').click()
  const update = page.getByRole('button', { name: 'Update Recurring Entry' })
  await update.waitFor()
  await waitQuiet(page)
  check('(a) the edit form replaced the review', await reviewDialog(page).count(), 0)
  await page.getByRole('button', { name: 'Cancel', exact: true }).click()
  await testId(page, 'installment-review-submit').waitFor()
  await waitQuiet(page)
  check('(a) Cancel came back to the review', [await update.count(), await reviewDialog(page).count()], [0, 1])

  await group.locator('[data-testid="installment-review-link"]').check()
  check('(a) the dialog closed after recording', await submitReview(page), 0)
  check('(a) the missed row is gone', (await missedRows(page, entry.id)).length, 0)
  check('(a) the review notice is gone', await testId(page, 'due-review-notice').count(), 0)
  const linked = await linkedRows(me, card, entry.id)
  check('(a) one linked row per month', linked.length, 3)
  check('(a) the typed charge is one of them', linked.some((t) => t.id === typed.id), true)
  check('(a) the typed charge kept its date', linked.find((t) => t.id === typed.id)?.transaction_date.slice(0, 10), addDays(addMonths(start, 1), 1))
  const after = await entryNow(me, entry.id)
  check('(a) reviewed and on, three months recorded', [flags(after), after.max_occurrences, after.next_occurrence.slice(0, 10)],
    [{ reviewed: true, on: true }, 9, addMonths(start, 3)])
  await ctx.close()
}

// ─── (b) a new installment from tomorrow needs no review ─────────────────────
async function newFromTomorrow(browser) {
  console.log('(b) a new installment from tomorrow is reviewed and on')
  const me = await makeOpener('b')
  const { card } = await makeCard(me, 'Visa B')
  const tomorrow = addDays(manilaToday(), 1)
  const { ctx, page } = await newPage(browser)
  await uiLogin(page, me)
  await page.goto(`${stack.webUrl}/allocations`)
  await page.getByRole('button', { name: 'Add Recurring Entry' }).waitFor()
  await waitQuiet(page)
  await page.getByRole('button', { name: 'Add Recurring Entry' }).click()
  await page.getByLabel('Close allocation modal').waitFor()
  await waitQuiet(page)
  const form = page.locator('form').filter({ has: page.getByRole('button', { name: 'Save Recurring Entry' }) })
  await form.locator('input[type="text"]').first().fill('Camera')
  await form.locator('input[type="number"]').first().fill('4000')
  await form.locator('select').filter({ has: page.locator('option', { hasText: 'Select account' }) }).selectOption({ label: card.name })
  await form.locator('[data-field="next_occurrence"]').fill(`${tomorrow}T00:00`)
  await form.getByRole('button', { name: 'After runs', exact: true }).click()
  await form.locator('[data-field="max_occurrences"]').fill('6')
  await form.getByRole('button', { name: 'Save Recurring Entry' }).click()
  await waitQuiet(page)
  check('(b) the form closed', await waitCount(page, page.getByLabel('Close allocation modal'), 0), 0)
  const created = (await get(me.token, '/budget-entries/?limit=100')).items.filter((e) => e.name === 'Camera')
  check('(b) one Camera installment, from tomorrow', created.map((e) => [e.kind, e.next_occurrence.slice(0, 10), e.max_occurrences]), [['installment', tomorrow, 6]])
  check('(b) the API shows it reviewed and on', created[0] ? flags(created[0]) : null, { reviewed: true, on: true })
  await openTransactions(page)
  check('(b) no review notice', await testId(page, 'due-review-notice').count(), 0)
  check('(b) nothing to post', await testId(page, 'due-post-now').count(), 0)
  await ctx.close()
}

// ─── (c) Post now for a month due today ──────────────────────────────────────
async function postNowToday(browser) {
  console.log('(c) a reviewed installment due today is posted from Post now')
  const me = await makeOpener('c')
  const { card } = await makeCard(me, 'Visa C')
  const today = manilaToday()
  const entry = await installment(me, card, 'Phone', 1800, today, 6)
  check('(c) created reviewed and on', flags(await entryNow(me, entry.id)), { reviewed: true, on: true })
  const snap = await get(me.token, '/dashboard/snapshot')
  check('(c) the job is configured', snap.auto_post_scheduled, true)
  check('(c) the snapshot counts one postable month',
    snap.installment_auto_post.map((r) => [r.entry_id, r.state, r.due_count, r.postable_count]), [[entry.id, 'on', 1, 1]])

  const { ctx, page } = await newPage(browser)
  const late = watchSnapshotAfterPageOpen(page)
  await uiLogin(page, me)
  await openTransactions(page)
  // The throttle is already taken, so the page-open POST posts 0 and must start no refetch.
  for (const until = Date.now() + 4000; !late.answered && Date.now() < until;) await sleep(100)
  await sleep(1500)
  check('(c.throttled-no-refetch) a throttled page-open POST starts no snapshot refetch',
    [late.answered, late.answer?.throttled, late.answer?.posted, late.late], [true, true, 0, 0])
  check('(c) the due-today line', await text(dueToday(page, entry.id)), 'Phone · 1 due today · Auto-posts each morning')
  check('(c) the line has no Review', await dueToday(page, entry.id).locator('[data-testid="due-today-review"]').count(), 0)
  check('(c) Post now counts the month', await text(testId(page, 'due-post-now')), 'Post 1 due installment month now')
  await testId(page, 'due-post-now').click()
  await waitQuiet(page)
  await testId(page, 'due-post-now-result').waitFor()
  check('(c) Posted 1', await text(testId(page, 'due-post-now-result')), 'Posted 1')
  check('(c) the button is gone', await waitCount(page, testId(page, 'due-post-now'), 0), 0)
  check('(c) the due-today line is gone', await waitCount(page, dueToday(page, entry.id), 0), 0)
  check('(c) Posted 1 stays', await text(testId(page, 'due-post-now-result')), 'Posted 1')
  const linked = await linkedRows(me, card, entry.id)
  check('(c) the API has the month\'s row, on its day', linked.map((t) => [t.transaction_date.slice(0, 10), t.is_posted]), [[today, true]])
  await ctx.close()
}

// ─── (d) a held month: Review, then record without linking ───────────────────
async function heldMonth(browser) {
  console.log('(d) a month held by a possible duplicate is reviewed')
  const me = await makeOpener('d')
  const { card } = await makeCard(me, 'Visa D')
  const today = manilaToday()
  const entry = await installment(me, card, 'Fridge', 3100, today, 6)
  const typed = await charge(me, card, 3100, addDays(today, -1), 'Fridge typed by hand')
  const job = await api('', 'POST', '/jobs/post-due-installments', undefined, { 'X-Job-Token': 'local-e2e-only' })
  check('(d) the job ran and held at least one month', [job.status, (job.json.skipped?.possible_duplicate ?? 0) >= 1], [200, true])
  const row = (await get(me.token, '/dashboard/snapshot')).installment_auto_post.find((r) => r.entry_id === entry.id)
  check('(d) the snapshot holds it', row && [row.state, row.due_count, row.postable_count, row.can_review], ['held', 1, 0, true])
  check('(d) the job wrote nothing for it', (await linkedRows(me, card, entry.id)).length, 0)

  const { ctx, page } = await newPage(browser)
  await uiLogin(page, me)
  await openTransactions(page)
  check('(d) the due-today line', await text(dueToday(page, entry.id).locator('[data-testid="due-today-text"]')), 'Fridge · 1 due today · Possible duplicate · Review')
  check('(d) no Post now', await testId(page, 'due-post-now').count(), 0)
  await openReview(page, dueToday(page, entry.id).locator('[data-testid="due-today-review"]'))
  check('(d) the dialog offers the typed charge',
    await reviewDialog(page).locator('[data-testid="installment-review-candidate"]').evaluateAll((els) => els.map((e) => Number(e.dataset.transactionId))), [typed.id])
  check('(d) the button records the month', await text(testId(page, 'installment-review-submit')), 'Record 1 month and turn on auto-post')
  check('(d) the dialog closed after recording', await submitReview(page), 0)
  check('(d) the line is gone', await waitCount(page, dueToday(page, entry.id), 0), 0)
  const linked = await linkedRows(me, card, entry.id)
  check('(d) the month was posted as a new row on its day', linked.map((t) => [t.id === typed.id, t.transaction_date.slice(0, 10)]), [[false, today]])
  const after = await entryNow(me, entry.id)
  check('(d) the entry moved on a month', [after.max_occurrences, after.next_occurrence.slice(0, 10)], [5, addMonths(today, 1)])
  await ctx.close()
}

// ─── (e) roles on a joint card ───────────────────────────────────────────────
async function roles(browser) {
  console.log('(e) an editor reviews; a viewer sees no review or auto-post')
  const owner = await makeOpener('e-owner')
  const editor = await makeOpener('e-editor')
  const viewer = await makeOpener('e-viewer')
  const { bank, card } = await makeCard(owner, 'Visa E')
  await post(owner.token, `/accounts/${card.id}/shares`, { email: editor.email, role: 'editor' })
  await post(owner.token, `/accounts/${card.id}/shares`, { email: viewer.email, role: 'viewer' })
  await post(owner.token, `/accounts/${bank.id}/shares`, { email: viewer.email, role: 'viewer' })
  const start = backdatedStart()
  const entry = await installment(owner, card, 'Sofa', 2200, start, 12)

  {
    const { ctx, page } = await newPage(browser)
    await uiLogin(page, viewer)
    await openTransactions(page)
    const rows = await allDueRows(page)
    check('(e) viewer: no review notice', await testId(page, 'due-review-notice').count(), 0)
    check('(e) viewer: no Post now', await testId(page, 'due-post-now').count(), 0)
    check('(e) viewer: no due-today line', await testId(page, 'due-today-line').count(), 0)
    check('(e) viewer: no full row for the entry', rows.filter((r) => r.source === `budget_entry:${entry.id}`).length, 0)
    check('(e) viewer: no Review anywhere', rows.filter((r) => r.buttons.includes('due-review')).length, 0)
    check('(e) viewer: no auto-post label anywhere', rows.filter((r) => /auto-post|Possible duplicate/i.test(r.text)).length, 0)
    check('(e) viewer: Limited rows carry no button', rows.filter((r) => r.view === 'limited' && r.buttons.length > 0).length, 0)
    await ctx.close()
  }

  const { ctx, page } = await newPage(browser)
  await uiLogin(page, editor)
  await openTransactions(page)
  check('(e) editor: the review notice', await text(testId(page, 'due-review-notice-toggle')), "1 card installment doesn't auto-post yet")
  const row = await showRow(page, missedRow(page, entry.id))
  check('(e) editor: the missed row has Review', await row.locator('[data-testid="due-review"]').count(), 1)
  await testId(page, 'due-review-notice-toggle').click()
  const listed = page.locator(`[data-testid="due-review-notice-entry"][data-source="budget_entry:${entry.id}"]`)
  check('(e) editor: the notice lists the entry', await text(listed.locator('span').first()), 'Sofa · Visa E · 3 missed')
  await openReview(page, listed.locator('[data-testid="due-review-notice-review"]'))
  check('(e) editor: the button counts the months', await text(testId(page, 'installment-review-submit')), 'Record 3 months and turn on auto-post')
  check('(e) editor: the dialog closed after recording', await submitReview(page), 0)
  check('(e) editor: the notice is gone', await waitCount(page, testId(page, 'due-review-notice'), 0), 0)
  const after = await entryNow(owner, entry.id)
  check('(e) the owner sees it reviewed and on, three months recorded', [flags(after), after.max_occurrences], [{ reviewed: true, on: true }, 9])
  check('(e) one linked row per month', (await linkedRows(owner, card, entry.id)).length, 3)
  await ctx.close()
}

// ─── (f) Allocations: auto-post state, Review and Turn off ───────────────────
async function allocationsAutoPost(browser) {
  console.log('(f) Allocations shows auto-post; an editor turns it off; a viewer cannot')
  // Allocations opens no page-open POST, so no consumePageOpen is needed.
  const owner = await makeUser('f-owner')
  const editor = await makeUser('f-editor')
  const viewer = await makeUser('f-viewer')
  const { bank, card } = await makeCard(owner, 'Visa F')
  await post(owner.token, `/accounts/${card.id}/shares`, { email: editor.email, role: 'editor' })
  await post(owner.token, `/accounts/${card.id}/shares`, { email: viewer.email, role: 'viewer' })
  await post(owner.token, `/accounts/${bank.id}/shares`, { email: viewer.email, role: 'viewer' })
  const today = manilaToday()
  // Due today, so the job would post the month if auto-post stayed on.
  const entry = await installment(owner, card, 'Oven', 3300, today, 6)
  check('(f) a new installment is created reviewed and on', flags(await entryNow(owner, entry.id)), { reviewed: true, on: true })

  const state = (page) => page.locator(`[data-testid="installment-auto-post"][data-source="budget_entry:${entry.id}"]`)
  const stateText = (page) => state(page).locator('[data-testid="installment-auto-post-state"]')
  const openAllocations = async (page) => {
    await page.goto(`${stack.webUrl}/allocations`)
    await page.getByRole('button', { name: 'Add Recurring Entry' }).waitFor()
    await waitQuiet(page)
  }

  {
    const { ctx, page } = await newPage(browser)
    await uiLogin(page, viewer)
    await openAllocations(page)
    await page.waitForTimeout(1500)
    // A viewer reads the entry as a Limited card, so this guards the Limited path. A Full card
    // without can_edit cannot show the state: the creator is the only Full viewer of an entry
    // they cannot edit, and demoting them to viewer deactivates their entries (shares.py
    // deactivate_entries), so the can_edit gate on Review and Turn off has no e2e view.
    check('(f) viewer: the entry is listed, as a Limited card', await testId(page, 'kind-section-shared').locator('article', { hasText: 'Oven' }).count(), 1)
    check('(f) viewer: no auto-post state, Review or Turn off',
      [await testId(page, 'installment-auto-post').count(), await testId(page, 'installment-review').count(), await testId(page, 'installment-turn-off').count()], [0, 0, 0])
    await ctx.close()
  }

  const { ctx, page } = await newPage(browser)
  await uiLogin(page, editor)
  await openAllocations(page)
  check('(f) editor: the card reads "Auto-post on"', await waitText(stateText(page), 'Auto-post on'), 'Auto-post on')
  check('(f) editor: Turn off, and no Review', [await state(page).locator('[data-testid="installment-turn-off"]').count(), await state(page).locator('[data-testid="installment-review"]').count()], [1, 0])
  // Both buttons stopPropagation, so neither opens the card's own edit form (its close button is the probe).
  const editForm = page.getByRole('button', { name: 'Close allocation modal' })
  await state(page).locator('[data-testid="installment-turn-off"]').click()
  await waitQuiet(page)
  check('(f) editor: the card reads "Auto-post off"', await waitText(stateText(page), 'Auto-post off'), 'Auto-post off')
  check('(f) editor: Turn off did not open the edit form', await editForm.count(), 0)
  check('(f) editor: Review replaces Turn off', [await state(page).locator('[data-testid="installment-turn-off"]').count(), await state(page).locator('[data-testid="installment-review"]').count()], [0, 1])
  await openReview(page, state(page).locator('[data-testid="installment-review"]'))
  await reviewDialog(page).getByRole('button', { name: 'Close' }).click()
  check('(f) editor: Review opened its dialog, and closing it leaves the edit form shut',
    [await waitCount(page, reviewDialog(page), 0), await editForm.count()], [0, 0])
  check('(f) the API shows it reviewed and off', flags(await entryNow(owner, entry.id)), { reviewed: true, on: false })
  const job = await api('', 'POST', '/jobs/post-due-installments', undefined, { 'X-Job-Token': 'local-e2e-only' })
  check('(f) the job ran and posted nothing for it', [job.status, (await linkedRows(owner, card, entry.id)).length, (await entryNow(owner, entry.id)).max_occurrences], [200, 0, 6])
  await ctx.close()
}

// ─── (g) unposted months on a card with no recorded statement ────────────────
/** A card closing on the day-of-month of (today - 5), within 2-28, and its last close before today. */
function closedCycles() {
  const today = manilaToday()
  const closeDom = Math.min(28, Math.max(2, dom(addDays(today, -5))))
  const thisMonth = `${today.slice(0, 8)}${String(closeDom).padStart(2, '0')}`
  const lastClose = thisMonth < today ? thisMonth : addMonths(thisMonth, -1)
  // The day before each of the last two closes: one month on each closed cycle.
  const second = addDays(lastClose, -1)
  return { closeDom, lastClose, first: addMonths(second, -1), second }
}

async function seedUnposted(tag, on, recorded = false) {
  const me = await makeUser(tag)
  const cycles = closedCycles()
  const { card } = await makeCard(me, `Visa ${tag.toUpperCase()}`, cycles.closeDom)
  // A hand-typed charge a cycle before the installment's first month records a statement.
  if (recorded) await charge(me, card, 700, addMonths(cycles.first, -1), 'Typed before')
  const entry = await installment(me, card, 'Watch', 1500, cycles.first, 2)
  check(`(${tag}) created unreviewed and off`, flags(await entryNow(me, entry.id)), { reviewed: false, on: false })
  setReviewed(entry.id, on)
  return { me, card, entry, cycles }
}

async function unpostedPanel(browser) {
  console.log('(g) a card with unposted installment months and no recorded statement')
  const { me, card, entry } = await seedUnposted('g', true)
  const before = await get(me.token, `/cards/${card.id}/credit`)
  check('(g) the API: no statement, two postable months', [before.statements.length, before.unposted?.count, before.unposted?.postable], [0, 2, 2])

  const { ctx, page } = await newPage(browser)
  await uiLogin(page, me)
  await openPanel(page, card.id)
  check('(g) the unposted block', await text(testId(page, 'card-unposted-text')),
    `2 installment months not yet posted · oldest closed ${fmt(before.unposted.oldest_close)}, due ${fmt(before.unposted.oldest_due)}`)
  check('(g) Pay says to post first', await text(testId(page, 'card-pay-disabled-reason')), 'Post the installment months first')
  check('(g) Pay is disabled', await testId(page, 'card-pay-open').isDisabled(), true)
  check('(g) no Review link', await testId(page, 'card-unposted-review').count(), 0)
  check('(g) "No closed statement yet" stays', await testId(page, 'card-statements-empty').count(), 1)

  await testId(page, 'card-unposted-post').click()
  await waitQuiet(page)
  check('(g) the block is gone', await waitCount(page, testId(page, 'card-unposted'), 0), 0)
  const after = await get(me.token, `/cards/${card.id}/credit`)
  const today = manilaToday()
  const closes = after.statements.filter((s) => s.close_date < today).map((s) => s.close_date).reverse()
  await waitCount(page, testId(page, 'card-statement'), closes.length)
  check('(g) the panel lists the API\'s statements',
    await testId(page, 'card-statement').evaluateAll((els) => els.map((e) => e.dataset.close)), closes)
  check('(g) Pay is enabled', [await testId(page, 'card-pay-open').isDisabled(), await testId(page, 'card-pay-disabled-reason').count()], [false, 0])
  check('(g) Posted 2 survives the refetch', await text(testId(page, 'card-unposted-result')), 'Posted 2')
  check('(g) the API: nothing unposted, both months linked', [after.unposted, (await linkedRows(me, card, entry.id)).length], [null, 2])

  await testId(page, 'card-pay-open').click()
  const dialog = testId(page, 'card-pay-dialog')
  await dialog.locator('[data-testid="card-pay-amount"]').waitFor()
  await waitQuiet(page)
  const latest = after.statements[after.statements.length - 1]
  check('(g) Full is the API\'s clear_through', Number(await dialog.locator('[data-testid="card-pay-amount"]').inputValue()), latest.clear_through)
  check('(g) no unposted note', await dialog.locator('[data-testid="card-pay-unposted-note"]').count(), 0)
  await ctx.close()

  console.log('(g) the same card with auto-post off')
  const off = await seedUnposted('g2', false)
  const offDetail = await get(off.me.token, `/cards/${off.card.id}/credit`)
  check('(g2) the API: two months, none postable', [offDetail.unposted?.count, offDetail.unposted?.postable], [2, 0])
  const second = await newPage(browser)
  const p2 = second.page
  await uiLogin(p2, off.me)
  await openPanel(p2, off.card.id)
  check('(g2) the block points to Due and overdue', await text(testId(p2, 'card-unposted-review')), 'Review or Mark paid them in Due and overdue')
  check('(g2) the link goes to Transactions', await testId(p2, 'card-unposted-review').locator('a').getAttribute('href'), '/transactions')
  check('(g2) no Post now', await testId(p2, 'card-unposted-post').count(), 0)
  check('(g2) Pay says why', await text(testId(p2, 'card-pay-disabled-reason')), 'Review or Mark paid the installment months in Due and overdue first')

  const due = (await get(off.me.token, '/dashboard/snapshot')).card_statements_due.find((s) => s.account_id === off.card.id)
  check('(g2) the snapshot lists the card for its unposted months', due && [due.clear_through, due.unposted_installments, due.unposted_postable], [0, 2, 0])
  await openTransactions(p2)
  const statement = await showRow(p2, p2.locator(`[data-testid="due-row"][data-kind="statement"][data-source="statement:${off.card.id}"]`))
  check('(g2) the row says what is unposted', await text(statement.locator('[data-testid="due-unposted-text"]')), `${off.card.name} · 2 installment months not yet posted`)
  check('(g2) the row has no Pay and no Post now', [await statement.locator('[data-testid="due-pay"]').count(), await statement.locator('[data-testid="due-unposted-post"]').count()], [0, 0])
  check('(g2) the row points below', await text(statement.locator('[data-testid="due-unposted-guidance"]')), 'Review or Mark paid below')
  check('(g2) the row is overdue as the API says', await statement.locator('[data-testid="due-overdue"]').count(), due?.overdue ? 1 : 0)
  const missed = await showRow(p2, missedRow(p2, off.entry.id))
  check('(g2) the missed row reads "Auto-post off · Mark paid"', await text(missed.locator('[data-testid="due-auto-post"]')), 'Auto-post off · Mark paid')
  check('(g2) the missed row has no Review', await missed.locator('[data-testid="due-review"]').count(), 0)
  await second.ctx.close()

  console.log('(g3) Pay shows the unposted note when a statement is recorded')
  const third = await seedUnposted('g3', true, true)
  const g3Detail = await get(third.me.token, `/cards/${third.card.id}/credit`)
  check('(g3) the API: a statement, two postable months', [g3Detail.statements.length > 0, g3Detail.unposted?.count, g3Detail.unposted?.postable], [true, 2, 2])
  const g3 = await newPage(browser)
  await uiLogin(g3.page, third.me)
  await openPanel(g3.page, third.card.id)
  check('(g3) Pay is enabled', [await testId(g3.page, 'card-pay-open').isDisabled(), await testId(g3.page, 'card-pay-disabled-reason').count()], [false, 0])
  await testId(g3.page, 'card-pay-open').click()
  const g3Dialog = testId(g3.page, 'card-pay-dialog')
  await g3Dialog.locator('[data-testid="card-pay-amount"]').waitFor()
  await waitQuiet(g3.page)
  const g3Note = g3Dialog.locator('[data-testid="card-pay-unposted-note"]')
  const g3NoteCount = await waitCount(g3.page, g3Note, 1, 5000)
  check('(g3) the Pay dialog notes the unposted months', g3NoteCount === 1 ? await text(g3Note) : null, 'Full leaves out 2 installment months not yet posted')
  check('(g3) it offers Post now and no Review line', [await g3Dialog.locator('[data-testid="card-pay-unposted-post"]').count(), await g3Dialog.locator('[data-testid="card-pay-unposted-review"]').count()], [1, 0])
  await g3.ctx.close()
}

// ─── Page-open helpers ───────────────────────────────────────────────────────
const isPageOpenPath = (url) => /\/budget-entries\/post-due-installments$/.test(new URL(url).pathname)
const isSnapshot = (r) => r.method() === 'GET' && new URL(r.url()).pathname.endsWith('/dashboard/snapshot')
const isPostDue = (r) => r.method() === 'POST' && isPageOpenPath(r.url())
const openResult = (page) => testId(page, 'due-page-open-result')
const POSTED_ONE = 'Posted 1 due installment month'

/** A request log for counts, and the bodies of the post-due-installments POSTs (logRequests keeps no bodies). */
function watchPostDue(page) {
  const log = logRequests(page)
  const bodies = []
  page.on('request', (r) => { if (isPostDue(r)) bodies.push(r.postData() || '') })
  return { count: () => log.filter((e) => e.method === 'POST' && isPageOpenPath(e.url)).length, bodies }
}
const triggers = (bodies) => bodies.map((b) => { try { return JSON.parse(b) } catch { return b } })

/**
 * Counts snapshot GETs sent after the page-open POST's response (the POST's own refetch), and keeps
 * that response's JSON. Playwright emits `response` on headers, before RTK sees the body, so a
 * refetch it starts is always sent after the flag is set.
 */
function watchSnapshotAfterPageOpen(page) {
  const seen = { answered: false, answer: null, late: 0 }
  page.on('response', (res) => {
    if (!isPostDue(res.request())) return
    seen.answered = true
    res.json().then((j) => { seen.answer = j }, () => {})
  })
  page.on('request', (r) => { if (seen.answered && isSnapshot(r)) seen.late++ })
  return seen
}

/** Waits (bounded) for `locator`'s text to equal `want`; returns the last text seen. Never throws. */
async function waitText(locator, want, ms = 8000) {
  const until = Date.now() + ms
  let last = null
  for (;;) {
    last = (await locator.count()) ? await text(locator) : null
    if (last === want || Date.now() > until) return last
    await sleep(100)
  }
}

// ─── (h) opening Transactions posts a due month ──────────────────────────────
async function postOnOpen(browser) {
  console.log('(h) opening Transactions posts a reviewed installment due today')
  // No consumePageOpen: this is the page-open POST itself.
  const owner = await makeUser('h-owner')
  const viewer = await makeUser('h-viewer')
  const { bank, card } = await makeCard(owner, 'Visa H')
  await post(owner.token, `/accounts/${card.id}/shares`, { email: viewer.email, role: 'viewer' })
  await post(owner.token, `/accounts/${bank.id}/shares`, { email: viewer.email, role: 'viewer' })
  const today = manilaToday()
  const entry = await installment(owner, card, 'Tablet', 2900, today, 6)

  // A viewer can post nothing, so their page open sends nothing. They open first, so the owner still has the month.
  {
    const { ctx, page } = await newPage(browser)
    const watch = watchPostDue(page)
    await uiLogin(page, viewer)
    await openTransactions(page)
    await page.waitForTimeout(1500)
    check('(h) a viewer opening Transactions sends no page-open request', watch.count(), 0)
    check('(h) the month is still unposted', (await linkedRows(owner, card, entry.id)).length, 0)
    await ctx.close()
  }

  const { ctx, page } = await newPage(browser)
  const watch = watchPostDue(page)
  await uiLogin(page, owner)
  await openTransactions(page)
  const line = await waitText(openResult(page), POSTED_ONE)
  await waitQuiet(page)
  check('(h) opening Transactions, with no click, shows the posted line', line, POSTED_ONE)
  check('(h) exactly one page-open request, with the page_open trigger', [watch.count(), triggers(watch.bodies)], [1, [{ trigger: 'page_open' }]])
  const linked = await linkedRows(owner, card, entry.id)
  check('(h) the API has the month\'s row, on its day', linked.map((t) => [t.transaction_date.slice(0, 10), t.is_posted]), [[today, true]])
  check('(h) the due-today line is gone', await waitCount(page, dueToday(page, entry.id), 0), 0)
  check('(h) no Post now', await testId(page, 'due-post-now').count(), 0)

  // Away and back: a new mount, but nothing is postable now, so no request.
  const sent = watch.count()
  await page.goto(`${stack.webUrl}/allocations`)
  await page.getByRole('button', { name: 'Add Recurring Entry' }).waitFor()
  await waitQuiet(page)
  await openTransactions(page)
  await page.waitForTimeout(1500)
  check('(h) leaving and coming back sends no page-open request', watch.count() - sent, 0)
  check('(h) the month was posted once', (await linkedRows(owner, card, entry.id)).length, 1)
  await ctx.close()
}

// ─── (i) the screen loader stays hidden for the page-open POST ───────────────
async function pageOpenIsQuiet(browser) {
  console.log('(i) the page-open POST does not block input or gray the screen')
  // No consumePageOpen: the POST must be sent.
  const me = await makeUser('i')
  const { card } = await makeCard(me, 'Visa I')
  const today = manilaToday()
  const entry = await installment(me, card, 'Printer', 2100, today, 6)

  const { ctx, page } = await newPage(browser)
  let openGate = null
  let snapGate = null
  try {
    await recordTexts(page, ['busy-overlay'], { attributes: ['data-phase'] })
    await uiLogin(page, me)
    openGate = await gate(page, isPostDue)
    await page.goto(`${stack.webUrl}/transactions`)
    await testId(page, 'due-section').waitFor()
    await waitQuiet(page)
    const hit = await openGate.waitHits(1)
    check('(i) the page-open POST was sent and is held', [hit, hit ? JSON.parse(openGate.bodies[0] || '{}') : null], [true, { trigger: 'page_open' }])

    // The POST is held and exempt: the overlay never leaves hidden.
    await resetTexts(page)
    await page.waitForTimeout(1200)
    const phases = ((await readTexts(page))['busy-overlay'] || { attrs: {} }).attrs['data-phase'] || []
    check('(i.no-block) no shield or visible phase while the POST is held', phases.filter((p) => p === 'shield' || p === 'visible'), [])
    check('(i.no-block) the overlay is hidden', await overlayPhase(page), 'hidden')

    // The one permitted click during a hold: the held request is exempt, so input works.
    // (Post now is not clicked here: that request is not exempt and would block input.)
    const toggle = testId(page, 'due-section-toggle')
    await toggle.click()
    const collapsed = await toggle.getAttribute('aria-expanded')
    await toggle.click()
    const expanded = await toggle.getAttribute('aria-expanded')
    check('(i.input-works) the section toggles while the POST is held', [collapsed, expanded], ['false', 'true'])

    // Release the POST while its refetch is held: the refetches are not exempt, so they block (the known limit).
    snapGate = await gate(page, isSnapshot)
    openGate.release({ disarm: true })
    const snapHit = await snapGate.waitHits(1)
    const visibleNow = snapHit ? await waitPhase(page, 'visible') : false
    check('(i.refetch-blocks) the post\'s snapshot refetch grays the screen', [snapHit, visibleNow], [true, true])
    snapGate.release({ disarm: true })
    await waitQuiet(page)
    check('(i) the posted line is shown', await waitText(openResult(page), POSTED_ONE), POSTED_ONE)
    check('(i) the API has the month\'s row', (await linkedRows(me, card, entry.id)).length, 1)
  } finally {
    openGate?.release({ disarm: true })
    snapGate?.release({ disarm: true })
    await ctx.close()
  }
}

// ─── (j) the page-open POST is decided by a fresh snapshot ───────────────────
const navToTransactions = async (page) => {
  await page.locator('a[data-onboarding="nav-transactions"]:visible').first().click()
  await testId(page, 'due-section').waitFor()
}
/** A user with a card, logged in on the dashboard, whose snapshot is cached there. */
async function onDashboard(browser, tag, dueToday) {
  const me = await makeUser(tag)
  const { card } = await makeCard(me, `Visa ${tag.toUpperCase()}`)
  const entry = dueToday ? await installment(me, card, 'Lamp', 1200, manilaToday(), 6) : null
  const { ctx, page } = await newPage(browser)
  const watch = watchPostDue(page)
  const snapshots = []
  page.on('response', (res) => { if (isSnapshot(res.request())) snapshots.push(res.json().catch(() => null)) })
  await uiLogin(page, me)
  await page.goto(`${stack.webUrl}/`)
  await waitQuiet(page)
  return { me, card, entry, ctx, page, watch, snapshots }
}

async function freshSnapshot(browser) {
  console.log('(j) the page-open POST is decided by a fresh snapshot, not a cached one')
  // No consumePageOpen anywhere here: each part reads the page-open POST itself.

  console.log('(j.1) cached 0, fresh 1')
  {
    const s = await onDashboard(browser, 'j1', false)
    // Node-side, so the browser's cache is not invalidated: the dashboard's snapshot still says nothing is postable.
    const entry = await installment(s.me, s.card, 'Lamp', 1200, manilaToday(), 6)
    await navToTransactions(s.page)
    const line = await waitText(openResult(s.page), POSTED_ONE)
    await waitQuiet(s.page)
    check('(j.fresh-posts) the fresh snapshot posts: line, one request, its body, the row',
      [line, s.watch.count(), triggers(s.watch.bodies), (await linkedRows(s.me, s.card, entry.id)).length],
      [POSTED_ONE, 1, [{ trigger: 'page_open' }], 1])
    await s.ctx.close()
  }

  console.log('(j.2) cached 1, fresh 0')
  {
    const s = await onDashboard(browser, 'j2', true)
    const backstop = await post(s.me.token, '/budget-entries/post-due-installments', { trigger: 'button' })
    check('(j.2) the backstop posted the month and took no throttle claim', [backstop.throttled, backstop.posted], [false, 1])
    await navToTransactions(s.page)
    await waitQuiet(s.page)
    await s.page.waitForTimeout(1500)
    check('(j.fresh-skips) the fresh snapshot has nothing: no page-open request, the month posted once',
      [s.watch.count(), (await linkedRows(s.me, s.card, s.entry.id)).length], [0, 1])
    await s.ctx.close()
  }

  console.log('(j.3) cached 1, fresh 1, the same JSON')
  {
    const s = await onDashboard(browser, 'j3', true)
    const before = s.snapshots.length
    await navToTransactions(s.page)
    const line = await waitText(openResult(s.page), POSTED_ONE)
    await waitQuiet(s.page)
    const bodies = await Promise.all(s.snapshots)
    // The dashboard's last snapshot and the Transactions mount's first: nothing changed between them.
    check('(j.same-json) the two snapshots are deep-equal',
      before > 0 && bodies.length > before && util.isDeepStrictEqual(bodies[before - 1], bodies[before]), true)
    check('(j.same-posts) the same JSON still posts once', [line, s.watch.count(), triggers(s.watch.bodies)], [POSTED_ONE, 1, [{ trigger: 'page_open' }]])
    await s.ctx.close()
  }
}

// ─── (k) a review gone stale while its dialog is open ────────────────────────
async function staleReview(browser) {
  console.log('(k) the review goes stale while the dialog is open')
  const me = await makeOpener('k')
  const { card } = await makeCard(me, 'Visa K')
  const start = backdatedStart()
  const entry = await installment(me, card, 'Camera', 1800, start, 12)
  const { ctx, page } = await newPage(browser)
  await uiLogin(page, me)
  await openTransactions(page)
  const row = await showRow(page, missedRow(page, entry.id))
  await openReview(page, row.locator('[data-testid="due-review"]'))
  check('(k) the dialog names the entry', await text(testId(page, 'installment-review-title')), 'Turn on auto-post for Camera (Visa K)')

  // The review token binds the entry's version, so renaming it makes the open dialog stale.
  const renamed = await api(me.token, 'PUT', `/budget-entries/${entry.id}`, { name: 'Camera lens' })
  check('(k) the rename is accepted', renamed.status, 200)

  await testId(page, 'installment-review-submit').click()
  await waitQuiet(page)
  const error = testId(page, 'installment-review-error')
  const errorCount = await waitCount(page, error, 1, 8000)
  check('(k) the stale submit says so', errorCount === 1 ? await text(error) : null, 'This installment changed since you opened the review')
  check('(k) the dialog refetched and shows the new name', await waitCount(page, page.locator('[data-testid="installment-review-title"]', { hasText: 'Camera lens' }), 1), 1)
  check('(k) the dialog is still open and nothing was recorded', [await reviewDialog(page).count(), (await linkedRows(me, card, entry.id)).length], [1, 0])
  check('(k) still unreviewed and off', flags(await entryNow(me, entry.id)), { reviewed: false, on: false })

  await waitQuiet(page)
  check('(k) the second submit closes the dialog', await submitReview(page), 0)
  const after = await entryNow(me, entry.id)
  check('(k) reviewed and on, three months recorded', [flags(after), (await linkedRows(me, card, entry.id)).length], [{ reviewed: true, on: true }, 3])
  await ctx.close()
}

;(async () => {
  stack = await startLocalStack()
  API = `${stack.apiUrl}/api/v1`
  const browser = await chromium.launch()
  const run = (k) => !only || only === k
  if (run('a')) await reviewWithDuplicate(browser)
  if (run('b')) await newFromTomorrow(browser)
  if (run('c')) await postNowToday(browser)
  if (run('d')) await heldMonth(browser)
  if (run('e')) await roles(browser)
  if (run('f')) await allocationsAutoPost(browser)
  if (run('g')) await unpostedPanel(browser)
  if (run('h')) await postOnOpen(browser)
  if (run('i')) await pageOpenIsQuiet(browser)
  if (run('j')) await freshSnapshot(browser)
  if (run('k')) await staleReview(browser)
  await browser.close()
  stack.stop()
  console.log(`\nRESULT: ${pass}/${total} assertions passed`)
  process.exit(pass === total ? 0 : 1)
})().catch((e) => { console.error(e); stack?.stop(); console.log(`\nRESULT (aborted): ${pass}/${total} assertions passed`); process.exit(1) })
