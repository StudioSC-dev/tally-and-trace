// Browser check for STU-384: the "Due and overdue" section on the Transactions
// page. Starts its own API and web app against a throwaway database
// (./_local_stack.cjs). Not wired into CI and not part of `pnpm build`.
// Run steps: see ./README.md.
//
// Scenarios (one owner is seeded with every kind of row; the steps use
// different rows, so each can also run alone):
//   (a) the dashboard is read-only: no Mark paid anywhere, a plain-text missed
//       count, view-only detail dialogs; a recurring entry is still deletable
//       from Allocations
//   (b) the section lists recurring, missed and pending rows with the right
//       buttons; a row due today is listed once
//   (c) Mark paid on a cash expense records it and clears the row
//   (d) Charged then Posted on a card subscription: one pending debit, then
//       exactly one posted row
//   (e) Mark posted on a pending card transaction
//   (f) Mark received on an income
//   (g) the expense category list has Gifts & Donations, the income one not
//   (h) a view-only viewer gets no buttons; Limited rows follow the
//       data-limited-rows setting
//   (i) a paused entry is not listed; resuming it skips the paused months
//   (j) missed cash, income and transfer occurrences are listed with the API's
//       counts; "Post all N due" clears a row
//   (k) Charged on a missed month leaves one fewer and a single pending row
//   (l) an ended installment is not listed and cannot be recorded
//   (m) more than 500 linked pending ids are fetched in batches of 500 and
//       merged; a failed batch shows an error in the section
//   (n) the section shows 3 rows a page, overdue first (a fresh user with
//       exactly 7 rows): the pager, the order, Next and Previous, the first page
//       on a fresh load, and the last page emptying (Mark paid) lands on the
//       new last page and stays there when the list grows again
//   (o) opening Transactions in-app from the dashboard refetches the snapshot
//       (a day can turn while the dashboard is open)
//   (p) Load more batches stay live: a row posted from an earlier batch leaves,
//       a row that slides across the batch boundary stays, and a new day
//       restarts the window
//   (q) out-of-order window refetches: a row is posted from the page under test,
//       the batch responses are held and released in either order, the selected
//       page survives and a row in two batches counts once
//
// The section is paged, so a row can be on any page: every count and every
// absence check reads all pages (./_due_pages.cjs).
//
// Usage: node frontend/e2e/due-and-overdue.cjs [a|b|c|d|e|f|g|h|i|j|k|l|m|n|o|p|q]
const { startLocalStack } = require('./_local_stack.cjs')
const { allDueRows, rowsOf, waitForRow, showRow, goToPage, currentPage, pagerLabel, hasPager, nextButton, previousButton } = require('./_due_pages.cjs')
const { waitQuiet } = require('./_smooth.cjs')

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

let stack, API
async function api(token, method, url, body) {
  const res = await fetch(`${API}${url}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
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
  const email = `e2e-due-${tag}-${Math.random().toString(16).slice(2, 8)}@example.com`
  const password = 'E2eTest!2345'
  const reg = await api('', 'POST', '/auth/register', { email, password, first_name: `User${tag}`, last_name: 'Test', default_currency: 'PHP' })
  if (reg.status !== 200 && reg.status !== 201) throw new Error(`register ${reg.status} ${JSON.stringify(reg.json)}`)
  stack.verifyUser(email) // aborts the run unless psql reports UPDATE 1
  const login = await api('', 'POST', '/auth/login', { email, password })
  if (login.status !== 200) throw new Error(`login ${login.status}`)
  return { email, password, tag, token: login.json.access_token }
}
const account = (u, name, type = 'checking', balance = 100000) =>
  post(u.token, '/accounts/', { name, account_type: type, balance, currency: 'PHP' })
/** A card closing on day `close` of each month, due 21 days later, paid from `bank`. */
const card = (u, bank, name, close = 24) => post(u.token, '/accounts/', {
  name, account_type: 'credit', balance: 0, currency: 'PHP',
  billing_cycle_start: close, days_until_due_date: 21, payment_account_id: bank.id,
})
const entry = (u, fields) => post(u.token, '/budget-entries/', { entry_type: 'expense', currency: 'PHP', cadence: 'monthly', ...fields })
const unposted = (u, acct, day, amount, description) => post(u.token, '/transactions/', {
  account_id: acct.id, transaction_type: 'debit', amount, description, transaction_date: wire(day), is_posted: false,
})
const snapshotOf = (u) => get(u.token, '/dashboard/snapshot')
const accountBalance = async (u, id) => (await get(u.token, `/accounts/${id}`)).balance
/** Every transaction the user can read (the e2e users have a handful). */
const allTransactions = async (u) => (await get(u.token, '/transactions/?limit=1000')).items

async function newPage(browser, contextOptions = {}) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 1400 }, ...contextOptions })
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
}
const settle = async (page) => { await page.waitForLoadState('networkidle'); await page.waitForTimeout(500) }
/** Signs in and opens Transactions with the section loaded. */
async function openDue(browser, u) {
  const { ctx, page } = await newPage(browser)
  await uiLogin(page, u)
  await openTransactions(page)
  return { ctx, page }
}
async function openTransactions(page) {
  await page.goto(`${stack.webUrl}/transactions`)
  await page.locator('[data-testid="due-section"]').waitFor()
  await page.locator('[data-testid="due-count"]').filter({ hasNotText: '…' }).waitFor()
  await settle(page)
}

const dialog = (page) => page.locator('[data-testid="mark-paid-dialog"]')
/** A recurring or missed row by its entry name, on the page on screen: reach it with showRow, count with rowsOf. */
const recRows = (page, name, kind) =>
  page.locator(`[data-testid="due-row"]${kind ? `[data-kind="${kind}"]` : ':not([data-kind="pending"]):not([data-kind="statement"])'}`)
    .filter({ has: page.locator('p', { hasText: new RegExp(`^${name}$`) }) })
/** A pending row by its description, on the page on screen. */
const pendRows = (page, name) => page.locator('[data-testid="due-row"][data-kind="pending"]').filter({ hasText: name })
const gone = (locator) => locator.first().waitFor({ state: 'detached', timeout: 15000 }).catch(() => {})
const ACTION_BUTTONS = 'button[data-testid="due-mark-paid"], button[data-testid="due-mark-received"], button[data-testid="due-charged"], button[data-testid="due-posted"], button[data-testid="due-mark-posted"]'

/** The page's own posting form, opened from a pending row's button: save the posted amount. */
async function savePosted(page, txnId) {
  const put = page.waitForResponse((r) => r.request().method() === 'PUT' && new URL(r.url()).pathname.endsWith(`/transactions/${txnId}`))
  await page.getByRole('button', { name: 'Save Posted Amount' }).click()
  return put
}

/** In-flight requests while seeding filler rows. */
const FILLER_CONCURRENCY = 8
/**
 * `fillerCount` pending "Filler" debits dated today+5 (future and unlinked, so the section never
 * lists them), then the `named` rows ([description, day]) in order. Returns the named rows by description.
 */
async function seedWindow(u, acct, fillerCount, named) {
  const today = manilaToday()
  for (let start = 0; start < fillerCount; start += FILLER_CONCURRENCY) {
    const n = Math.min(FILLER_CONCURRENCY, fillerCount - start)
    await Promise.all(Array.from({ length: n }, () => unposted(u, acct, addDays(today, 5), 10, 'Filler')))
  }
  const rows = {}
  for (const [name, day] of named) rows[name] = await unposted(u, acct, day, 100, name)
  return rows
}

// ─── Seed ────────────────────────────────────────────────────────────────────
let world
/** One owner with every kind of row the section lists. */
async function seed() {
  if (world) return world
  const u = await makeUser('main')
  const today = manilaToday()
  // Stale entries sit on a day-of-month that every month has, so each month is one occurrence.
  const anchor = Math.min(25, Math.max(5, Number(today.slice(8, 10))))
  const stale = (months) => addMonths(today, -months, anchor)
  const checking = await account(u, 'Main Checking')
  const savings = await account(u, 'Main Savings', 'savings', 5000)
  const visa = await card(u, checking, 'Main Visa')
  const rent = await entry(u, { name: 'Rent', amount: 15000, account_id: checking.id, next_occurrence: wire(addDays(today, 3)) })
  const netflix = await entry(u, { name: 'Netflix', amount: 549, account_id: visa.id, next_occurrence: wire(addDays(today, 2)) })
  const spotify = await entry(u, { name: 'Spotify', amount: 279, account_id: visa.id, next_occurrence: wire(stale(2)), anchor_day: anchor })
  const salary = await entry(u, { name: 'Salary', entry_type: 'income', amount: 30000, account_id: checking.id, next_occurrence: wire(addDays(today, 5)) })
  const coffee = await unposted(u, visa, addDays(today, -3), 180, 'Coffee')
  const oldRent = await entry(u, { name: 'Old Rent', amount: 12000, account_id: checking.id, next_occurrence: wire(stale(2)), anchor_day: anchor })
  const oldSalary = await entry(u, { name: 'Old Salary', entry_type: 'income', amount: 25000, account_id: checking.id, next_occurrence: wire(stale(1)), anchor_day: anchor })
  const save = await entry(u, { name: 'Save', amount: 2000, account_id: checking.id, transfer_to_account_id: savings.id, next_occurrence: wire(addDays(today, 4)) })
  const oldSave = await entry(u, { name: 'Old Save', amount: 1000, account_id: checking.id, transfer_to_account_id: savings.id, next_occurrence: wire(stale(1)), anchor_day: anchor })
  const todayBill = await entry(u, { name: 'Today Bill', amount: 700, account_id: checking.id, next_occurrence: wire(today) })
  const gym = await entry(u, { name: 'Gym', amount: 800, account_id: checking.id, next_occurrence: wire(stale(2)), anchor_day: anchor, is_active: false })
  world = { u, today, anchor, checking, savings, visa, rent, netflix, spotify, salary, coffee, oldRent, oldSalary, save, oldSave, todayBill, gym }
  console.log(`    seeded one owner; stale entries on day ${anchor}`)
  return world
}
const missedFor = (snapshot, entryId) =>
  snapshot.missed.find((m) => m.entry_id === entryId) ??
  snapshot.card_charges.flatMap((c) => c.missed).find((m) => m.entry_id === entryId)

// (a) The dashboard is read-only.
async function dashboardReadOnly(browser) {
  console.log('\n=== (a) the dashboard is read-only')
  const w = await seed()
  // A future pending debit on a cash account is a "transaction" payable on the dashboard.
  await unposted(w.u, w.checking, addDays(w.today, 6), 321, 'Pending Bill')
  const { ctx, page } = await newPage(browser)
  await uiLogin(page, w.u)
  await page.locator('[data-testid="payables"]').waitFor()
  await settle(page)
  const more = page.locator('[data-testid="payables-more"]')
  if (await more.count() && (await more.getAttribute('aria-expanded')) === 'false') await more.click()
  check('(a) no payable Mark paid button', await page.locator('[data-testid="payable-mark-paid-button"]').count(), 0)
  check('(a) no card charge Mark paid button', await page.locator('[data-testid="card-charge-mark-paid"]').count(), 0)
  check('(a) no missed-count button', await page.locator('[data-testid="card-missed-button"]').count(), 0)
  const missedText = page.locator('[data-testid="card-missed-text"]')
  const missed = missedFor(await snapshotOf(w.u), w.spotify.id)
  check('(a) the missed count is plain text, with its oldest month', [await missedText.count() > 0, (await missedText.first().textContent())?.includes(`since ${fmt(missed.oldest)}`)], [true, true])

  const payableRows = page.locator('[data-testid="payable-row"]')
  const rentOpen = payableRows.filter({ has: page.getByText('Rent', { exact: true }) }).locator('[data-testid="payable-open"]')
  const pendingOpen = payableRows.filter({ has: page.getByText('Pending Bill', { exact: true }) }).locator('[data-testid="payable-open"]')
  check('(a) Rent and the pending transaction are openable payables', [await rentOpen.count(), await pendingOpen.count()], [1, 1])
  for (const [label, opener] of [['Rent', rentOpen], ['the pending transaction', pendingOpen]]) {
    await opener.click()
    const detail = page.locator('[data-testid="payable-dialog"]')
    await detail.waitFor()
    check(`(a) ${label}: the dialog has no Mark paid, Edit or Delete`,
      await detail.locator('[data-testid="payable-mark-paid"], [data-testid="payable-edit"], [data-testid="payable-delete"]').count(), 0)
    check(`(a) ${label}: the dialog points to Allocations and Transactions`,
      (await detail.locator('[data-testid="payable-edit-hint"]').textContent())?.trim(),
      'Edit recurring entries in Allocations and transactions on the Transactions page.')
    await detail.getByRole('button', { name: 'Close' }).click()
    await detail.waitFor({ state: 'detached' })
  }

  await page.goto(`${stack.webUrl}/allocations`)
  await settle(page)
  const rentCard = page.locator('article').filter({ has: page.getByText('Rent', { exact: true }) })
  check('(a) Allocations lists Rent once', await rentCard.count(), 1)
  await rentCard.click()
  await page.getByRole('button', { name: 'Delete Recurring Entry' }).waitFor()
  check('(a) Rent opens its form with a delete control', await page.getByRole('button', { name: 'Delete Recurring Entry' }).count(), 1)
  await ctx.close()
}

// (b) The listing.
async function listing(browser) {
  console.log('\n=== (b) the section lists recurring, missed and pending rows with the right buttons')
  const w = await seed()
  const { ctx, page } = await openDue(browser, w.u)
  const toggle = page.locator('[data-testid="due-section-toggle"]')
  const list = page.locator('[data-testid="due-list"]')
  check('(b) the section starts open', await toggle.getAttribute('aria-expanded'), 'true')
  const all = await allDueRows(page)
  check('(b) the count is the number of rows over every page', Number(await page.locator('[data-testid="due-count"]').textContent()), all.length)
  check('(b) the first page has at most 3 rows, and a pager only past 3', [await page.locator('[data-testid="due-row"]').count(), await hasPager(page)],
    [Math.min(3, all.length), all.length > 3])
  await toggle.click()
  check('(b) the toggle collapses the section', [await toggle.getAttribute('aria-expanded'), await list.count()], ['false', 0])
  await toggle.click()
  check('(b) and opens it again', [await toggle.getAttribute('aria-expanded'), await list.count()], ['true', 1])

  const rent = await rowsOf(page, 'Rent')
  check('(b) Rent: Mark paid', [rent.length, rent[0]?.buttons], [1, ['due-mark-paid']])
  const netflix = await rowsOf(page, 'Netflix')
  check('(b) Netflix: Charged, Posted', [netflix.length, netflix[0]?.buttons], [1, ['due-charged', 'due-posted']])
  const spotify = await rowsOf(page, 'Spotify', 'missed')
  const snapshot = await snapshotOf(w.u)
  const missed = missedFor(snapshot, w.spotify.id)
  check('(b) Spotify: a missed row with the API\'s count', [spotify.length, spotify[0]?.sub],
    [1, `${missed.unlinked_count} missed since ${fmt(missed.oldest_unlinked)}`])
  check('(b) Spotify missed: Charged, Posted', spotify[0]?.buttons, ['due-charged', 'due-posted'])
  const salary = await rowsOf(page, 'Salary')
  check('(b) Salary: Mark received', [salary.length, salary[0]?.buttons], [1, ['due-mark-received']])
  const save = await rowsOf(page, 'Save')
  check('(b) Save: Mark paid', [save.length, save[0]?.buttons], [1, ['due-mark-paid']])
  const coffee = await rowsOf(page, 'Coffee', 'pending')
  check('(b) Coffee: a pending row, Overdue, Mark posted', [coffee.length, coffee[0]?.overdue, coffee[0]?.buttons],
    [1, true, ['due-mark-posted']])
  const todayBill = all.filter((r) => r.text.includes('Today Bill'))
  check('(b) Today Bill is listed once, as a recurring row', [todayBill.length, todayBill[0]?.kind], [1, 'recurring'])
  check('(b) the paused Gym is not listed', all.filter((r) => r.text.includes('Gym')).length, 0)
  await ctx.close()
}

// (c) Mark paid on a cash expense.
async function markPaidRent(browser) {
  console.log('\n=== (c) Mark paid on Rent records it and clears the row')
  const w = await seed()
  const { ctx, page } = await openDue(browser, w.u)
  await (await showRow(page, recRows(page, 'Rent'))).locator('[data-testid="due-mark-paid"]').click()
  await dialog(page).locator('[data-testid="mark-paid-occurrence"]').waitFor()
  const done = page.waitForResponse((r) => r.url().endsWith(`/budget-entries/${w.rent.id}/materialize`))
  await dialog(page).locator('[data-testid="mark-paid-submit"]').click()
  const res = await done
  check('(c) the dialog posts the occurrence (201)', res.status(), 201)
  await dialog(page).waitFor({ state: 'detached' })
  await gone(recRows(page, 'Rent'))
  check('(c) the Rent row is gone from every page', (await rowsOf(page, 'Rent')).length, 0)
  const posted = (await allTransactions(w.u)).filter((t) => t.budget_entry_id === w.rent.id)
  check('(c) one posted row for Rent', posted.map((t) => t.is_posted), [true])
  await ctx.close()
}

// (d) Charged, then Posted, on a card subscription.
async function chargedThenPosted(browser) {
  console.log('\n=== (d) Charged then Posted on Netflix: one pending debit, then exactly one posted row')
  const w = await seed()
  const before = await accountBalance(w.u, w.visa.id)
  const { ctx, page } = await openDue(browser, w.u)
  await (await showRow(page, recRows(page, 'Netflix'))).locator('[data-testid="due-charged"]').click()
  await dialog(page).locator('[data-testid="mark-paid-occurrence"]').waitFor()
  check('(d) the dialog is titled "Record Netflix"', (await dialog(page).getByRole('heading').first().textContent())?.trim(), 'Record Netflix')
  const done = page.waitForResponse((r) => r.url().endsWith(`/budget-entries/${w.netflix.id}/materialize`))
  await dialog(page).locator('[data-testid="mark-paid-charged"]').click()
  const res = await done
  const body = JSON.parse(res.request().postData() || '{}')
  check('(d) Charged sends is_posted false and is created (201)', [body.is_posted, res.status()], [false, 201])
  await dialog(page).waitFor({ state: 'detached' })
  check('(d) the card balance has not moved', await accountBalance(w.u, w.visa.id), before)
  const pending = (await allTransactions(w.u)).filter((t) => t.budget_entry_id === w.netflix.id)
  check('(d) one pending row linked to Netflix', pending.map((t) => t.is_posted), [false])

  await waitForRow(page, 'Netflix', 'pending')
  const listed = await rowsOf(page, 'Netflix', 'pending')
  check('(d) the charge is listed once as a pending row with Posted', [listed.length, listed[0]?.buttons], [1, ['due-posted']])
  await (await showRow(page, pendRows(page, 'Netflix'))).locator('[data-testid="due-posted"]').click()
  const put = await savePosted(page, pending[0].id)
  check('(d) Posted posts the same row (200)', put.status(), 200)
  await gone(pendRows(page, 'Netflix'))
  check('(d) the pending row leaves the section', (await rowsOf(page, 'Netflix', 'pending')).length, 0)
  const after = (await allTransactions(w.u)).filter((t) => t.budget_entry_id === w.netflix.id)
  check('(d) exactly one posted row remains', [after.length, after.map((t) => t.is_posted)], [1, [true]])
  await ctx.close()
}

// (e) Mark posted on a pending card transaction.
async function markPostedCoffee(browser) {
  console.log('\n=== (e) Mark posted on Coffee posts it and it leaves the section')
  const w = await seed()
  const { ctx, page } = await openDue(browser, w.u)
  await (await showRow(page, pendRows(page, 'Coffee'))).locator('[data-testid="due-mark-posted"]').click()
  const put = await savePosted(page, w.coffee.id)
  check('(e) the page\'s posting flow saves it (200)', put.status(), 200)
  await gone(pendRows(page, 'Coffee'))
  check('(e) the Coffee row leaves the section', (await rowsOf(page, 'Coffee', 'pending')).length, 0)
  const txn = (await allTransactions(w.u)).find((t) => t.id === w.coffee.id)
  check('(e) Coffee is posted', txn?.is_posted, true)
  await ctx.close()
}

// (f) Mark received on an income.
async function markReceivedSalary(browser) {
  console.log('\n=== (f) Mark received on Salary')
  const w = await seed()
  const { ctx, page } = await openDue(browser, w.u)
  await (await showRow(page, recRows(page, 'Salary'))).locator('[data-testid="due-mark-received"]').click()
  await dialog(page).locator('[data-testid="mark-paid-occurrence"]').waitFor()
  check('(f) the dialog is titled "Mark Salary as received"', (await dialog(page).getByRole('heading').first().textContent())?.trim(), 'Mark Salary as received')
  const done = page.waitForResponse((r) => r.url().endsWith(`/budget-entries/${w.salary.id}/materialize`))
  await dialog(page).locator('[data-testid="mark-paid-submit"]').click()
  check('(f) Mark received posts the occurrence (201)', (await done).status(), 201)
  await dialog(page).waitFor({ state: 'detached' })
  await gone(recRows(page, 'Salary'))
  check('(f) the Salary row is gone from every page', (await rowsOf(page, 'Salary')).length, 0)
  await ctx.close()
}

// (g) The Gifts category.
async function gifts(browser) {
  console.log('\n=== (g) Gifts & Donations is an expense category, not an income one')
  const w = await seed()
  const { ctx, page } = await openDue(browser, w.u)
  await page.getByRole('button', { name: 'Add Transaction' }).first().click()
  const modal = page.locator('div.fixed').filter({ has: page.getByRole('heading', { name: 'Create Transaction' }) })
  await modal.waitFor()
  const gifts = modal.getByRole('button', { name: 'Gifts & Donations', exact: true })
  await modal.getByRole('button', { name: 'Expense', exact: true }).click()
  check('(g) the expense categories have Gifts & Donations', await gifts.count(), 1)
  await modal.getByRole('button', { name: 'Income', exact: true }).click()
  check('(g) the income categories do not', await gifts.count(), 0)
  await ctx.close()
}

// (h) A viewer.
async function viewer(browser) {
  console.log('\n=== (h) a view-only viewer gets no buttons; Limited rows follow data-limited-rows')
  const owner = await makeUser('h-owner')
  const view = await makeUser('h-viewer')
  const today = manilaToday()
  const bank = await account(owner, 'Joint Checking')
  const visa = await card(owner, bank, 'Joint Visa')
  const anchor = Math.min(25, Math.max(5, Number(today.slice(8, 10))))
  await entry(owner, { name: 'Netflix', amount: 549, account_id: visa.id, next_occurrence: wire(addDays(today, 2)) })
  await entry(owner, { name: 'Spotify', amount: 279, account_id: visa.id, next_occurrence: wire(addMonths(today, -2, anchor)), anchor_day: anchor })
  await unposted(owner, visa, addDays(today, -3), 180, 'Coffee')
  await post(owner.token, `/accounts/${visa.id}/shares`, { email: view.email, role: 'viewer' })

  const snapshot = await snapshotOf(view)
  const limitedItems = new Map([
    ...snapshot.payables.filter((p) => p.view === 'limited'),
    ...snapshot.card_charges.flatMap((c) => c.charges).filter((c) => c.view === 'limited'),
  ].map((item) => [item.public_id, item.display_name]))
  const limitedIds = limitedItems
  console.log(`    the viewer's snapshot has ${limitedIds.size} Limited item(s): ${[...limitedIds.values()].join(', ')}`)
  const { ctx, page } = await openDue(browser, view)
  const mode = await page.locator('[data-testid="due-section"]').getAttribute('data-limited-rows')
  console.log(`    data-limited-rows: ${mode}`)
  check('(h) the setting is text or drop', ['text', 'drop'].includes(mode), true)
  const shown = await allDueRows(page)
  check('(h) no row on any page shows a button', [await page.locator(`[data-testid="due-section"] ${ACTION_BUTTONS}`).count(), shown.flatMap((r) => r.buttons)], [0, []])
  const limited = shown.filter((r) => r.view === 'limited')
  if (mode === 'drop') {
    check('(h) drop: no Limited rows', limited.length, 0)
    check('(h) drop: no rows at all', shown.length, 0)
    check('(h) drop: no pager', await hasPager(page), false)
  } else {
    check('(h) text: each Limited item is listed once', [limitedIds.size > 0, limited.length], [true, limitedIds.size])
    check('(h) text: the rows carry the API\'s display names', limited.map((r) => r.name).sort(), [...limitedItems.values()].sort())
    check('(h) text: every row is Limited', shown.length, limited.length)
    // 3 rows or fewer fit on one page; more get a pager.
    check(`(h) text: ${limitedIds.size <= 3 ? 'no pager' : 'a pager'} for ${limitedIds.size} Limited item(s)`, await hasPager(page), limitedIds.size > 3)
  }
  // The dashboard keeps showing the viewer its Limited charges as text.
  await page.goto(`${stack.webUrl}/`)
  await page.locator('[data-testid="card-charges"]').waitFor()
  await settle(page)
  const dash = page.locator('[data-testid="card-charge-row"][data-view="limited"]')
  check('(h) the dashboard still shows the viewer Limited charges', (await dash.count()) > 0, true)
  await ctx.close()
}

// (i) A paused entry, then resumed.
async function pausedEntry(browser) {
  console.log('\n=== (i) a paused entry is not listed; resuming skips the paused months')
  const w = await seed()
  const { ctx, page } = await openDue(browser, w.u)
  check('(i) the paused Gym is not listed on any page', (await allDueRows(page)).filter((r) => r.text.includes('Gym')).length, 0)
  check('(i) the API lists no missed Gym', missedFor(await snapshotOf(w.u), w.gym.id), undefined)

  await page.goto(`${stack.webUrl}/allocations`)
  await page.locator('[data-testid^="kind-section-"]').first().waitFor()
  await page.locator('[data-testid="kind-section-cash"] article').filter({ has: page.getByText('Gym', { exact: true }) }).click()
  await page.getByRole('button', { name: 'Paused', exact: true }).waitFor()
  check('(i) no resume note while paused', await page.locator('[data-testid="recurring-resume-note"]').count(), 0)
  await page.getByRole('button', { name: 'Paused', exact: true }).click()
  check('(i) the skip note shows on resume', await page.locator('[data-testid="recurring-resume-note"]').count(), 1)
  const put = page.waitForResponse((r) => r.request().method() === 'PUT' && new URL(r.url()).pathname.endsWith(`/budget-entries/${w.gym.id}`))
  await page.getByRole('button', { name: 'Update Recurring Entry' }).click()
  const res = await put
  const body = JSON.parse(res.request().postData() || '{}')
  check('(i) the save is 200 and sends is_active true with no next_occurrence', [res.status(), body.is_active, 'next_occurrence' in body], [200, true, false])
  const next = (await get(w.u.token, `/budget-entries/${w.gym.id}`)).next_occurrence.slice(0, 10)
  console.log(`    next_occurrence after resume: ${next}`)
  check('(i) the API\'s next_occurrence is on or after today', next >= w.today, true)
  check('(i) the API lists no missed Gym', missedFor(await snapshotOf(w.u), w.gym.id), undefined)
  await openTransactions(page)
  check('(i) no missed Gym row appears on any page', (await rowsOf(page, 'Gym', 'missed')).length, 0)
  await ctx.close()
}

// (j) Missed cash, income and transfer.
async function missedKinds(browser) {
  console.log('\n=== (j) missed cash, income and transfer occurrences; Post all N due clears a row')
  const w = await seed()
  const snapshot = await snapshotOf(w.u)
  const { ctx, page } = await openDue(browser, w.u)
  const cases = [
    ['Old Rent', w.oldRent, 'due-mark-paid'],
    ['Old Salary', w.oldSalary, 'due-mark-received'],
    ['Old Save', w.oldSave, 'due-mark-paid'],
  ]
  for (const [name, e, button] of cases) {
    const missed = missedFor(snapshot, e.id)
    const rows = await rowsOf(page, name, 'missed')
    check(`(j) ${name}: one missed row with the API's count`, [rows.length, rows[0]?.sub],
      [1, `${missed.unlinked_count} missed since ${fmt(missed.oldest_unlinked)}`])
    check(`(j) ${name}: ${button}`, rows[0]?.buttons, [button])
  }

  const row = await showRow(page, recRows(page, 'Old Rent', 'missed'))
  const n = missedFor(snapshot, w.oldRent.id).unlinked_count
  await row.locator('[data-testid="due-mark-paid"]').click()
  await dialog(page).locator('[data-testid="mark-paid-occurrence"]').waitFor()
  // Post all counts every due occurrence, today's included, so N is the API's due_unposted, not the missed count.
  const listed = await get(w.u.token, `/budget-entries/${w.oldRent.id}/occurrences?include=${missedFor(snapshot, w.oldRent.id).oldest_unlinked}`)
  const due = listed.due_unposted
  console.log(`    missed ${n}; due_unposted ${due}`)
  const postAll = dialog(page).locator('[data-testid="mark-paid-post-all"]')
  check('(j) the dialog offers Post all N due with the API\'s due count', ((await postAll.textContent()) ?? '').trim().startsWith(`Post all ${due} due`), true)
  const done = page.waitForResponse((r) => r.url().endsWith(`/budget-entries/${w.oldRent.id}/materialize-due`))
  await postAll.click()
  const res = await done
  check('(j) Post all due is 200 with N created', [res.status(), (await res.json()).results.map((r) => r.outcome)], [200, Array(due).fill('created')])
  await dialog(page).waitFor({ state: 'detached' })
  await gone(recRows(page, 'Old Rent', 'missed'))
  check('(j) the Old Rent missed row is gone from every page', (await rowsOf(page, 'Old Rent', 'missed')).length, 0)
  check('(j) the API reports nothing missed for it', missedFor(await snapshotOf(w.u), w.oldRent.id), undefined)
  await ctx.close()
}

// (k) Charged on a missed month.
async function chargedMissed(browser) {
  console.log('\n=== (k) Charged on Spotify\'s oldest missed month: one fewer missed, one pending row')
  const w = await seed()
  const before = missedFor(await snapshotOf(w.u), w.spotify.id)
  console.log(`    unlinked_count ${before.unlinked_count}; oldest_unlinked ${before.oldest_unlinked}`)
  const { ctx, page } = await openDue(browser, w.u)
  const row = await showRow(page, recRows(page, 'Spotify', 'missed'))
  await row.locator('[data-testid="due-charged"]').click()
  await dialog(page).locator('[data-testid="mark-paid-occurrence"]').waitFor()
  check('(k) the dialog opens on the oldest missed month', await dialog(page).locator('[data-testid="mark-paid-occurrence"]').inputValue(), before.oldest_unlinked)
  const done = page.waitForResponse((r) => r.url().endsWith(`/budget-entries/${w.spotify.id}/materialize`))
  await dialog(page).locator('[data-testid="mark-paid-charged"]').click()
  const res = await done
  const body = JSON.parse(res.request().postData() || '{}')
  check('(k) Charged sends is_posted false for that month (201)', [res.status(), body.is_posted], [201, false])
  await dialog(page).waitFor({ state: 'detached' })
  const after = missedFor(await snapshotOf(w.u), w.spotify.id)
  const left = before.unlinked_count - 1
  check('(k) the API reports one fewer missed month', after?.unlinked_count ?? 0, left)
  await page.waitForFunction(
    (text) => !text || [...document.querySelectorAll('[data-testid="due-missed-text"]')].some((e) => e.textContent.startsWith(text)),
    left > 0 ? `${left} missed since` : '', { timeout: 15000 }).catch(() => {})
  await settle(page)
  const text = left > 0 ? (await rowsOf(page, 'Spotify', 'missed'))[0]?.sub : null
  check('(k) the missed row shows one fewer', text, left > 0 ? `${left} missed since ${fmt(after.oldest_unlinked)}` : null)
  const pending = await rowsOf(page, 'Spotify', 'pending')
  check('(k) the charged month is listed once as a pending row with Posted', [pending.length, pending[0]?.buttons], [1, ['due-posted']])
  await ctx.close()
}

// (l) An ended installment.
async function endedInstallment(browser) {
  console.log('\n=== (l) an ended installment is not listed and cannot be recorded')
  const w = await seed()
  const gadget = await entry(w.u, {
    name: 'Gadget', amount: 3000, account_id: w.visa.id, next_occurrence: wire(addDays(w.today, 1)),
    end_mode: 'after_occurrences', max_occurrences: 1,
  })
  const last = await api(w.u.token, 'POST', `/budget-entries/${gadget.id}/materialize`, {})
  check('(l) the last payment is recorded (201)', last.status, 201)
  const ended = await get(w.u.token, `/budget-entries/${gadget.id}`)
  check('(l) the entry has ended', ended.is_active, false)
  const { ctx, page } = await openDue(browser, w.u)
  check('(l) the ended installment is not listed on any page', (await allDueRows(page)).filter((r) => r.text.includes('Gadget')).length, 0)
  const again = await api(w.u.token, 'POST', `/budget-entries/${gadget.id}/materialize`, {})
  check('(l) recording it again is refused: 409 "This entry has ended"', [again.status, again.json?.detail], [409, 'This entry has ended'])
  await ctx.close()
}

// (m) Linked pending ids past the API's 500-id limit.
async function manyLinkedIds(browser) {
  console.log('\n=== (m) 601 linked pending ids: batches of 500, merged; a failed batch shows an error')
  const u = await makeUser('m')
  const today = manilaToday()
  const anchor = Math.min(25, Math.max(5, Number(today.slice(8, 10))))
  const bank = await account(u, 'M Checking')
  const start = addMonths(today, -2, anchor)
  const water = await entry(u, { name: 'Water', amount: 900, account_id: bank.id, next_occurrence: wire(start), anchor_day: anchor })
  const linked = await post(u.token, '/transactions/', {
    account_id: bank.id, transaction_type: 'debit', amount: 900, description: 'Water bill',
    transaction_date: wire(start), is_posted: false, budget_entry_id: water.id,
  })
  const real = missedFor(await snapshotOf(u), water.id)
  check('(m) the API names the linked pending row', real?.pending_transaction_ids, [linked.id])

  const { ctx, page } = await newPage(browser)
  await uiLogin(page, u)
  // 600 more ids no one can read (they match nothing) on Water's missed row.
  const padding = Array.from({ length: 600 }, (_, i) => 900_000_000 + i)
  await page.route((url) => url.pathname.endsWith('/api/v1/dashboard/snapshot'), async (route) => {
    const res = await route.fetch()
    const body = await res.json()
    for (const m of body.missed) if (m.entry_id === water.id) m.pending_transaction_ids = [...m.pending_transaction_ids, ...padding]
    await route.fulfill({ response: res, json: body })
  })
  const batches = []
  page.on('response', (r) => {
    const url = new URL(r.url())
    if (url.pathname.endsWith('/api/v1/transactions/') && url.searchParams.getAll('ids').length > 0) {
      batches.push({ size: url.searchParams.getAll('ids').length, status: r.status() })
    }
  })
  await openTransactions(page)
  check('(m) the ids are asked for in two batches of at most 500, both 200',
    batches.map((b) => [b.size, b.status]).sort((a, b) => b[0] - a[0]), [[500, 200], [101, 200]])
  check('(m) the linked pending row is listed once', (await rowsOf(page, 'Water bill', 'pending')).length, 1)
  check('(m) no error line', await page.locator('[data-testid="due-pending-error"]').count(), 0)

  // A failed batch.
  await page.route((url) => url.pathname.endsWith('/api/v1/transactions/') && url.searchParams.getAll('ids').length > 0,
    (route) => route.fulfill({ status: 500, json: { detail: 'boom' } }))
  await openTransactions(page)
  const error = page.locator('[data-testid="due-pending-error"]')
  await error.waitFor({ timeout: 15000 }).catch(() => {})
  check('(m) a failed batch shows an error in the section', (await error.textContent().catch(() => null))?.trim(), 'Could not load some pending transactions.')
  await ctx.close()
}

// (n) Pagination and order, on a fresh user with exactly 7 rows.
async function pagination(browser) {
  console.log('\n=== (n) 3 rows a page, overdue first: a fresh user with exactly 7 rows')
  const u = await makeUser('n')
  const today = manilaToday()
  const anchor = Math.min(25, Math.max(5, Number(today.slice(8, 10))))
  const stale = (months) => addMonths(today, -months, anchor)
  const bank = await account(u, 'N Checking')
  const cash = (name, day, extra = {}) => entry(u, { name, amount: 1000, account_id: bank.id, next_occurrence: wire(day), ...extra })
  // Overdue: two entries whose occurrences passed unrecorded (the backend lists those as missed rows,
  // one per entry) and that end with the last of them, so no later occurrence adds a row; and a pending
  // transaction dated 20 days ago.
  await cash('Zulu Old', stale(3), { anchor_day: anchor, end_mode: 'after_occurrences', max_occurrences: 3 })
  await cash('Mid Fee', stale(1), { anchor_day: anchor, end_mode: 'after_occurrences', max_occurrences: 1 })
  await unposted(u, bank, addDays(today, -20), 180, 'Coffee')
  // Not overdue: due today and in the next 9 days. Zeta Bill is the last row, on page 3.
  await cash('Today Bill', today)
  await cash('Rent', addDays(today, 3))
  await entry(u, { name: 'Salary', entry_type: 'income', amount: 30000, account_id: bank.id, next_occurrence: wire(addDays(today, 5)) })
  await cash('Zeta Bill', addDays(today, 9))

  const { ctx, page } = await openDue(browser, u)
  const names = async () => (await page.locator('[data-testid="due-row"]').evaluateAll((els) => els.map((e) => e.querySelector('p')?.textContent.trim())))
  const badge = async () => (await page.locator('[data-testid="due-count"]').textContent())?.trim()
  const all = await allDueRows(page)
  check('(n) exactly 7 rows: the 2 overdue entries are missed rows, plus 1 pending and 4 recurring',
    [all.length, all.map((r) => r.kind).sort()], [7, ['missed', 'missed', 'pending', 'recurring', 'recurring', 'recurring', 'recurring']])
  check('(n) the badge is the total', await badge(), '7')
  check('(n) the pager reads 1–3 of 7', await pagerLabel(page), '1–3 of 7')
  check('(n) page 1 has exactly 3 rows, oldest overdue first (the overdue pending row is among them)', await names(), ['Zulu Old', 'Mid Fee', 'Coffee'])
  const first = await allDueRows(page)
  check('(n) all 3 rows on page 1 are overdue', first.slice(0, 3).map((r) => r.kind === 'missed' || r.overdue), [true, true, true])
  check('(n) the overdue pending row is ahead of every non-overdue recurring row',
    first.findIndex((r) => r.name === 'Coffee') < first.findIndex((r) => r.name === 'Today Bill'), true)
  check('(n) the order over all pages', first.map((r) => r.name), ['Zulu Old', 'Mid Fee', 'Coffee', 'Today Bill', 'Rent', 'Salary', 'Zeta Bill'])

  await nextButton(page).click()
  await page.locator('[data-testid="due-pager"] button[aria-current="page"]').filter({ hasText: /^2$/ }).waitFor()
  check('(n) Next goes to page 2: 4–6 of 7, the badge unchanged', [await pagerLabel(page), await names(), await badge()], ['4–6 of 7', ['Today Bill', 'Rent', 'Salary'], '7'])
  await previousButton(page).click()
  await page.locator('[data-testid="due-pager"] button[aria-current="page"]').filter({ hasText: /^1$/ }).waitFor()
  check('(n) Previous goes back to page 1', [await pagerLabel(page), await names()], ['1–3 of 7', ['Zulu Old', 'Mid Fee', 'Coffee']])

  await goToPage(page, 3)
  check('(n) page 3 has the last row, 7–7 of 7', [await pagerLabel(page), await names()], ['7–7 of 7', ['Zeta Bill']])
  await openTransactions(page)
  check('(n) a fresh load lands on page 1', [await currentPage(page), await pagerLabel(page)], [1, '1–3 of 7'])

  // The last page empties: the view lands on the new last page, not an empty one.
  await goToPage(page, 3)
  await page.locator('[data-testid="due-row"]').filter({ has: page.locator('p', { hasText: /^Zeta Bill$/ }) }).locator('[data-testid="due-mark-paid"]').click()
  await dialog(page).locator('[data-testid="mark-paid-occurrence"]').waitFor()
  const done = page.waitForResponse((r) => r.url().endsWith('/materialize'))
  await dialog(page).locator('[data-testid="mark-paid-submit"]').click()
  check('(n) Mark paid on the only row of page 3 is created (201)', (await done).status(), 201)
  await dialog(page).waitFor({ state: 'detached' })
  await page.locator('[data-testid="due-count"]').filter({ hasText: /^6$/ }).waitFor({ timeout: 15000 }).catch(() => {})
  await settle(page)
  check('(n) the view lands on the new last page, not an empty one', [await badge(), await currentPage(page), await pagerLabel(page), await names()],
    ['6', 2, '4–6 of 6', ['Today Bill', 'Rent', 'Salary']])

  // The clamp sticks: when the list grows back to 7 rows, page 2 stays page 2.
  await cash('Eta Bill', addDays(today, 10))
  await cash('Theta Bill', addDays(today, 11))
  await page.locator('[data-testid="due-row"]').filter({ has: page.locator('p', { hasText: /^Salary$/ }) }).locator('[data-testid="due-mark-received"]').click()
  await dialog(page).locator('[data-testid="mark-paid-occurrence"]').waitFor()
  await dialog(page).locator('[data-testid="mark-paid-submit"]').click()
  await dialog(page).waitFor({ state: 'detached' })
  await page.locator('[data-testid="due-count"]').filter({ hasText: /^7$/ }).waitFor({ timeout: 15000 }).catch(() => {})
  await settle(page)
  check('(n) after the list grows back to 7 the view stays on page 2', [await badge(), await currentPage(page), await pagerLabel(page), await names()],
    ['7', 2, '4–6 of 7', ['Today Bill', 'Rent', 'Eta Bill']])
  await ctx.close()
}

// (o) In-app navigation from the dashboard to Transactions.
async function inAppRefetch(browser) {
  console.log('\n=== (o) opening Transactions in-app from the dashboard refetches the snapshot')
  const w = await seed()
  const { ctx, page } = await newPage(browser)
  await uiLogin(page, w.u)
  await page.locator('[data-testid="payables"]').waitFor()
  await settle(page)
  const snap = page.waitForResponse((r) => r.request().method() === 'GET' && new URL(r.url()).pathname.endsWith('/api/v1/dashboard/snapshot'), { timeout: 15000 }).catch(() => null)
  await page.locator('a[data-onboarding="nav-transactions"]:visible').first().click()
  await page.waitForURL((url) => url.pathname === '/transactions')
  check('(o) the section asks for a fresh snapshot after the in-app navigation', (await snap)?.status() ?? null, 200)
  await ctx.close()
}

/** A GET of the section's window query (no ids, no start_date), optionally at one of `offsets`. */
const isWindowUrl = (url, offsets) =>
  url.pathname.endsWith('/api/v1/transactions/') &&
  url.searchParams.get('is_posted') === 'false' && url.searchParams.get('limit') === '1000' &&
  url.searchParams.has('end_date') && !url.searchParams.has('ids') && !url.searchParams.has('start_date') &&
  (offsets === undefined || offsets.includes(url.searchParams.get('offset')))
const isWindowRequest = (request, offsets) => request.method() === 'GET' && isWindowUrl(new URL(request.url()), offsets)
/** The next response of the window query at `offset`, or null after `ms`. */
const windowResponse = (page, offset, ms = 15000) =>
  page.waitForResponse((r) => isWindowRequest(r.request(), [offset]), { timeout: ms }).catch(() => null)
/** The section's rows on the page on screen, by their first line. */
const dueNames = (page) => page.locator('[data-testid="due-row"]').evaluateAll((els) => els.map((e) => e.querySelector('p')?.textContent.trim()))
const dueBadge = async (page) => (await page.locator('[data-testid="due-count"]').textContent())?.trim()
const waitForBadge = (page, text, ms = 15000) =>
  page.locator('[data-testid="due-count"]').filter({ hasText: new RegExp(`^${text}$`) }).waitFor({ timeout: ms }).catch(() => {})
const loadMoreButton = (page) => page.locator('[data-testid="due-load-more"]')
/** A pending row whose description is exactly `name`, on the page on screen (pendRows matches any substring, ignoring case). */
const pendRow = (page, name) =>
  page.locator('[data-testid="due-row"][data-kind="pending"]').filter({ has: page.locator('p', { hasText: new RegExp(`^${name}$`) }) })
/** Posting keeps the actions modal open, and its overlay blocks later clicks: close it. */
async function closeActions(page) {
  const close = page.getByRole('button', { name: 'Close actions modal' })
  await close.click()
  await close.waitFor({ state: 'hidden' })
}
/** Mark posted on the pending row named `name` (on the page on screen), then save: the PUT's status. */
async function postFromSection(page, name, txnId) {
  await pendRow(page, name).locator('[data-testid="due-mark-posted"]').click()
  return (await savePosted(page, txnId)).status()
}

// (p) Load-more batches stay live.
async function loadMoreLive(browser) {
  console.log('\n=== (p) Load more batches stay live: a posted row leaves, a slid row stays, a new day restarts the window')
  const u = await makeUser('p')
  const today = manilaToday()
  const bank = await account(u, 'P Checking')
  const t0 = Date.now()
  const rows = await seedWindow(u, bank, 999, [['Early', addDays(today, -3)], ['Edge', addDays(today, -4)], ['Tail', addDays(today, -6)]])
  console.log(`    seeded 1002 pending rows in ${((Date.now() - t0) / 1000).toFixed(1)} s`)
  const first = await get(u.token, '/transactions/?is_posted=false&limit=1000&offset=0')
  check('(p) API: batch 0 has more and ends with Early', [first.has_more, first.items.at(-1)?.description], [true, 'Early'])
  const second = await get(u.token, '/transactions/?is_posted=false&limit=1000&offset=1000')
  check('(p) API: batch 1 is Edge and Tail', second.items.map((t) => t.description), ['Edge', 'Tail'])

  const { ctx, page } = await openDue(browser, u)
  check('(p) before Load more: badge 1, Early only, Load more offered',
    [await dueBadge(page), await dueNames(page), await loadMoreButton(page).isVisible()], ['1', ['Early'], true])
  await loadMoreButton(page).click()
  await waitForBadge(page, '3')
  await settle(page)
  check('(p) after Load more: Tail, Edge, Early on one page, Load more hidden',
    [await dueNames(page), await loadMoreButton(page).isVisible()], [['Tail', 'Edge', 'Early'], false])

  // Post Early, the last row of batch 0: Edge slides from batch 1 into batch 0.
  await pendRow(page, 'Early').locator('[data-testid="due-mark-posted"]').click()
  const refetched = [windowResponse(page, '0'), windowResponse(page, '1000')]
  const early = await savePosted(page, rows.Early.id)
  check('(p) posting Early saves it (200)', early.status(), 200)
  await closeActions(page)
  await Promise.all(refetched)
  await gone(pendRow(page, 'Early'))
  await settle(page)
  const afterEarly = await dueNames(page)
  check('(p) the row posted from the earlier batch is gone', [afterEarly.includes('Early'), (await rowsOf(page, 'Early', 'pending')).length], [false, 0])
  check('(p) the row that slid across the batch boundary is still listed', await dueNames(page), ['Tail', 'Edge'])

  // A new day, in a second context whose clock is two minutes before Manila's midnight.
  const night = await newPage(browser, { timezoneId: 'Asia/Manila' })
  await night.page.clock.install({ time: new Date(`${today}T15:58:00Z`) })
  await uiLogin(night.page, u)
  await openTransactions(night.page)
  await loadMoreButton(night.page).click()
  await waitForBadge(night.page, '2')
  await settle(night.page)
  let secondBatch = 0
  night.page.on('request', (r) => { if (isWindowRequest(r, ['1000'])) secondBatch++ })
  // Playwright reads '03:00' as mm:ss: three minutes, 23:58 to 00:01 Manila.
  await night.page.clock.fastForward('03:00')
  await loadMoreButton(night.page).waitFor({ timeout: 15000 }).catch(() => {})
  await settle(night.page)
  check('(p) a new day restarts the window: one batch, Load more again',
    [await dueNames(night.page), await dueBadge(night.page), await loadMoreButton(night.page).isVisible()], [['Edge'], '1', true])
  check('(p) no request for the second batch after the day turned', secondBatch, 0)
  await night.ctx.close()

  // Back on the first page (real clock): post Tail, the only row of the last loaded batch.
  const tail = await postFromSection(page, 'Tail', rows.Tail.id)
  if (tail !== 200) throw new Error(`(p) posting Tail returned ${tail}: the first context's session may have ended after the second login; stopping`)
  check('(p) posting Tail from the first context saves it (200)', tail, 200)
  await closeActions(page)
  await waitForBadge(page, '1')
  await settle(page)
  check('(p) the row posted from the last loaded batch is gone', (await rowsOf(page, 'Tail', 'pending')).length, 0)
  check('(p) after posting from the last batch only Edge is listed and Load more is hidden',
    [await dueNames(page), await loadMoreButton(page).isVisible()], [['Edge'], false])
  await ctx.close()
}

// (q) Out-of-order window refetches.
async function outOfOrderRefetch(browser) {
  console.log('\n=== (q) out-of-order window refetches: the selected page survives and a row in two batches counts once')
  const u = await makeUser('q')
  const today = manilaToday()
  const bank = await account(u, 'Q Checking')
  const names = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H']
  const t0 = Date.now()
  const rows = await seedWindow(u, bank, 996, names.map((name, i) => [name, addDays(today, -(i + 1))]))
  console.log(`    seeded 1004 pending rows in ${((Date.now() - t0) / 1000).toFixed(1)} s`)
  const second = await get(u.token, '/transactions/?is_posted=false&limit=1000&offset=1000')
  check('(q) API: batch 1 is E, F, G, H', second.items.map((t) => t.description), ['E', 'F', 'G', 'H'])

  const { ctx, page } = await openDue(browser, u)
  await loadMoreButton(page).click()
  await waitForBadge(page, '8')
  await settle(page)
  check('(q) after Load more: 8 rows, H G F on page 1', [await dueBadge(page), await dueNames(page)], ['8', ['H', 'G', 'F']])

  /**
   * Holds the next GET of each window batch (offset 0 and 1000). Returns the held routes, or null
   * (after releasing whatever was held and removing the route) unless exactly those two were held in 10 s.
   */
  const hold = async () => {
    const held = []
    const matcher = (url) => isWindowUrl(url, ['0', '1000'])
    const handler = (route) => {
      if (route.request().method() !== 'GET') return route.continue()
      held.push({ route, offset: new URL(route.request().url()).searchParams.get('offset') })
    }
    await page.route(matcher, handler)
    return {
      wait: async (round) => {
        const until = Date.now() + 10000
        while (held.length < 2 && Date.now() < until) await page.waitForTimeout(100)
        const offsets = held.map((h) => h.offset).sort()
        check(`(q) round ${round}: both window batches were requested and held`, offsets, ['0', '1000'])
        if (JSON.stringify(offsets) === JSON.stringify(['0', '1000'])) return true
        await Promise.all(held.map((h) => h.route.continue().catch(() => {})))
        await page.unroute(matcher, handler)
        return false
      },
      release: async (offset) => {
        const h = held.find((x) => x.offset === offset)
        const response = page.waitForResponse((r) => r.request() === h.route.request(), { timeout: 15000 }).catch(() => null)
        await h.route.continue()
        return (await response)?.status() ?? null
      },
      remove: () => page.unroute(matcher, handler),
    }
  }

  /**
   * Mark posted on `name`, a row of the page on screen: opens the form, waits for the screen loader to
   * clear, arms the hold, then saves, so the hold catches the window refetch that this post starts.
   * Returns { held, status }.
   */
  const postHeld = async (name, txnId) => {
    await pendRow(page, name).locator('[data-testid="due-mark-posted"]').click()
    await page.getByRole('button', { name: 'Save Posted Amount' }).waitFor()
    await waitQuiet(page)
    const held = await hold()
    return { held, status: (await savePosted(page, txnId)).status() }
  }

  // Round 1, page 3. The section lists the oldest first, 3 a page: H G F | E D C | B A. Batch 0 holds
  // the 996 fillers (today+5, never listed) and the 4 newest named rows A B C D; batch 1 is E F G H.
  // B is on page 3 and in batch 0, so posting it frees a batch-0 slot: for a row to be pushed into
  // batch 1, two rows must move in, so the API moves H and G to yesterday (the old round moved only H,
  // because it posted G from batch 1). After the post, batch 0 = A H G C, batch 1 = D E F.
  // Batch 1 lands first: old batch 0 (A B C D) + new batch 1 (D E F) = 6 rows with D once, so the
  // badge reads 6 and the view shows page 2, 4–6 of 6 (a double count reads 7; no merge keeps 8).
  // Batch 0 then lands: A H G C D E F = 7, and the selected page 3 is back: 7–7 of 7.
  await goToPage(page, 3)
  check('(q) round 1: page 3 is on screen with B on it', [await currentPage(page), await pendRow(page, 'B').count()], [3, 1])
  const moveH = await api(u.token, 'PUT', `/transactions/${rows.H.id}`, { transaction_date: wire(addDays(today, -1)) })
  check('(q) round 1: the API moves H to yesterday (200)', moveH.status, 200)
  const moveG = await api(u.token, 'PUT', `/transactions/${rows.G.id}`, { transaction_date: wire(addDays(today, -1)) })
  check('(q) round 1: the API moves G to yesterday (200)', moveG.status, 200)
  let posted = await postHeld('B', rows.B.id)
  let held = posted.held
  check('(q) round 1: posting B from page 3 saves it (200)', posted.status, 200)
  if (await held.wait(1)) {
    const late = await held.release('1000')
    await waitForBadge(page, '6')
    check('(q) round 1: while batch 0 is held the badge reads 6 and the pager reads 4–6 of 6',
      [await dueBadge(page), await currentPage(page), await pagerLabel(page)], ['6', 2, '4–6 of 6'])
    const early = await held.release('0')
    check('(q) round 1: both held window responses completed with 200', [late, early], [200, 200])
    await held.remove()
    await waitForBadge(page, '7')
    await waitQuiet(page)
    await closeActions(page)
    await settle(page)
    check('(q) round 1: page 3 survives the out-of-order refetch',
      [await currentPage(page), await pagerLabel(page), await dueBadge(page)], [3, '7–7 of 7', '7'])
  }

  // Round 2, page 2. Now listed oldest first: F E D C, then A H G (all yesterday, in either order), so
  // C is 4th, on page 2; batch 0 = A H G C, batch 1 = D E F. The API moves F to yesterday and C is
  // posted from page 2: batch 0 = A H G F, batch 1 = D E. Batch 0 lands first: new batch 0 (A H G F) +
  // old batch 1 (D E F) = 6 rows with F once, so the badge reads 6 (a double count, or no merge, reads
  // 7) and page 2 reads 4–6 of 6. Batch 1 then lands: A H G F D E = 6, still page 2.
  const moveF = await api(u.token, 'PUT', `/transactions/${rows.F.id}`, { transaction_date: wire(addDays(today, -1)) })
  check('(q) round 2: the API moves F to yesterday (200)', moveF.status, 200)
  await goToPage(page, 2)
  check('(q) round 2: page 2 is on screen with C on it', [await currentPage(page), await pendRow(page, 'C').count()], [2, 1])
  posted = await postHeld('C', rows.C.id)
  held = posted.held
  check('(q) round 2: posting C from page 2 saves it (200)', posted.status, 200)
  if (await held.wait(2)) {
    const early = await held.release('0')
    await waitForBadge(page, '6')
    check('(q) round 2: the row in two batches counts once while batch 1 is held: badge 6, page 2, 4–6 of 6',
      [await dueBadge(page), await currentPage(page), await pagerLabel(page)], ['6', 2, '4–6 of 6'])
    const late = await held.release('1000')
    check('(q) round 2: both held window responses completed with 200', [early, late], [200, 200])
    await held.remove()
    await waitQuiet(page)
    await closeActions(page)
    await settle(page)
    // Reading other pages moves the view, so the page is read first.
    const onScreen = [await currentPage(page), await pagerLabel(page), await dueBadge(page)]
    const all = (await allDueRows(page)).map((r) => r.name)
    check('(q) round 2: page 2 survives', onScreen, [2, '4–6 of 6', '6'])
    check('(q) round 2: every row is listed once', [all.length === new Set(all).size, [...all].sort()], [true, ['A', 'D', 'E', 'F', 'G', 'H']])
  }
  await ctx.close()
}

;(async () => {
  stack = await startLocalStack()
  API = `${stack.apiUrl}/api/v1`
  const browser = await chromium.launch()
  const run = (k) => !only || only === k
  const steps = { a: dashboardReadOnly, b: listing, c: markPaidRent, d: chargedThenPosted, e: markPostedCoffee, f: markReceivedSalary, g: gifts, h: viewer, i: pausedEntry, j: missedKinds, k: chargedMissed, l: endedInstallment, m: manyLinkedIds, n: pagination, o: inAppRefetch, p: loadMoreLive, q: outOfOrderRefetch }
  for (const [k, fn] of Object.entries(steps)) if (run(k)) await fn(browser)
  await browser.close()
  stack.stop()
  console.log(`\nRESULT: ${pass}/${total} assertions passed`)
  process.exit(pass === total ? 0 : 1)
})().catch((e) => { console.error(e); stack?.stop(); console.log(`\nRESULT (aborted): ${pass}/${total} assertions passed`); process.exit(1) })
