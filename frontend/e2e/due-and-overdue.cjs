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
//
// Usage: node frontend/e2e/due-and-overdue.cjs [a|b|c|d|e|f|g|h|i|j|k|l]
const { startLocalStack } = require('./_local_stack.cjs')

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

async function newPage(browser) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 1400 } })
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
const dueRows = (page) => page.locator('[data-testid="due-row"]')
/** A recurring or missed row by its entry name. */
const recRows = (page, name, kind) =>
  page.locator(`[data-testid="due-row"]${kind ? `[data-kind="${kind}"]` : ':not([data-kind="pending"])'}`)
    .filter({ has: page.locator('p', { hasText: new RegExp(`^${name}$`) }) })
/** A pending row by its description. */
const pendRows = (page, name) => page.locator('[data-testid="due-row"][data-kind="pending"]').filter({ hasText: name })
const buttonIds = (row) =>
  row.locator('button[data-testid^="due-"]').evaluateAll((els) => els.map((e) => e.getAttribute('data-testid')))
const gone = (locator) => locator.first().waitFor({ state: 'detached', timeout: 15000 }).catch(() => {})
const ACTION_BUTTONS = 'button[data-testid="due-mark-paid"], button[data-testid="due-mark-received"], button[data-testid="due-charged"], button[data-testid="due-posted"], button[data-testid="due-mark-posted"]'

/** The page's own posting form, opened from a pending row's button: save the posted amount. */
async function savePosted(page, txnId) {
  const put = page.waitForResponse((r) => r.request().method() === 'PUT' && new URL(r.url()).pathname.endsWith(`/transactions/${txnId}`))
  await page.getByRole('button', { name: 'Save Posted Amount' }).click()
  return put
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
  check('(b) the count is the number of rows', Number(await page.locator('[data-testid="due-count"]').textContent()), await dueRows(page).count())
  await toggle.click()
  check('(b) the toggle collapses the section', [await toggle.getAttribute('aria-expanded'), await list.count()], ['false', 0])
  await toggle.click()
  check('(b) and opens it again', [await toggle.getAttribute('aria-expanded'), await list.count()], ['true', 1])

  const rent = recRows(page, 'Rent')
  check('(b) Rent: Mark paid', [await rent.count(), await buttonIds(rent)], [1, ['due-mark-paid']])
  const netflix = recRows(page, 'Netflix')
  check('(b) Netflix: Charged, Posted', [await netflix.count(), await buttonIds(netflix)], [1, ['due-charged', 'due-posted']])
  const spotify = recRows(page, 'Spotify', 'missed')
  const snapshot = await snapshotOf(w.u)
  const missed = missedFor(snapshot, w.spotify.id)
  check('(b) Spotify: a missed row with the API\'s count', [await spotify.count(), (await spotify.locator('[data-testid="due-missed-text"]').textContent())?.trim()],
    [1, `${missed.unlinked_count} missed since ${fmt(missed.oldest_unlinked)}`])
  check('(b) Spotify missed: Charged, Posted', await buttonIds(spotify), ['due-charged', 'due-posted'])
  const salary = recRows(page, 'Salary')
  check('(b) Salary: Mark received', [await salary.count(), await buttonIds(salary)], [1, ['due-mark-received']])
  const save = recRows(page, 'Save')
  check('(b) Save: Mark paid', [await save.count(), await buttonIds(save)], [1, ['due-mark-paid']])
  const coffee = pendRows(page, 'Coffee')
  check('(b) Coffee: a pending row, Overdue, Mark posted', [await coffee.count(), await coffee.locator('[data-testid="due-overdue"]').count(), await buttonIds(coffee)],
    [1, 1, ['due-mark-posted']])
  const todayBill = dueRows(page).filter({ hasText: 'Today Bill' })
  check('(b) Today Bill is listed once, as a recurring row', [await todayBill.count(), await todayBill.getAttribute('data-kind')], [1, 'recurring'])
  check('(b) the paused Gym is not listed', await dueRows(page).filter({ hasText: 'Gym' }).count(), 0)
  await ctx.close()
}

// (c) Mark paid on a cash expense.
async function markPaidRent(browser) {
  console.log('\n=== (c) Mark paid on Rent records it and clears the row')
  const w = await seed()
  const { ctx, page } = await openDue(browser, w.u)
  await recRows(page, 'Rent').locator('[data-testid="due-mark-paid"]').click()
  await dialog(page).locator('[data-testid="mark-paid-occurrence"]').waitFor()
  const done = page.waitForResponse((r) => r.url().endsWith(`/budget-entries/${w.rent.id}/materialize`))
  await dialog(page).locator('[data-testid="mark-paid-submit"]').click()
  const res = await done
  check('(c) the dialog posts the occurrence (201)', res.status(), 201)
  await dialog(page).waitFor({ state: 'detached' })
  await gone(recRows(page, 'Rent'))
  check('(c) the Rent row is gone', await recRows(page, 'Rent').count(), 0)
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
  await recRows(page, 'Netflix').locator('[data-testid="due-charged"]').click()
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

  const row = pendRows(page, 'Netflix')
  await row.locator('[data-testid="due-posted"]').waitFor()
  check('(d) the charge is listed once as a pending row with Posted', [await row.count(), await buttonIds(row)], [1, ['due-posted']])
  await row.locator('[data-testid="due-posted"]').click()
  const put = await savePosted(page, pending[0].id)
  check('(d) Posted posts the same row (200)', put.status(), 200)
  await gone(pendRows(page, 'Netflix'))
  check('(d) the pending row leaves the section', await pendRows(page, 'Netflix').count(), 0)
  const after = (await allTransactions(w.u)).filter((t) => t.budget_entry_id === w.netflix.id)
  check('(d) exactly one posted row remains', [after.length, after.map((t) => t.is_posted)], [1, [true]])
  await ctx.close()
}

// (e) Mark posted on a pending card transaction.
async function markPostedCoffee(browser) {
  console.log('\n=== (e) Mark posted on Coffee posts it and it leaves the section')
  const w = await seed()
  const { ctx, page } = await openDue(browser, w.u)
  await pendRows(page, 'Coffee').locator('[data-testid="due-mark-posted"]').click()
  const put = await savePosted(page, w.coffee.id)
  check('(e) the page\'s posting flow saves it (200)', put.status(), 200)
  await gone(pendRows(page, 'Coffee'))
  check('(e) the Coffee row leaves the section', await pendRows(page, 'Coffee').count(), 0)
  const txn = (await allTransactions(w.u)).find((t) => t.id === w.coffee.id)
  check('(e) Coffee is posted', txn?.is_posted, true)
  await ctx.close()
}

// (f) Mark received on an income.
async function markReceivedSalary(browser) {
  console.log('\n=== (f) Mark received on Salary')
  const w = await seed()
  const { ctx, page } = await openDue(browser, w.u)
  await recRows(page, 'Salary').locator('[data-testid="due-mark-received"]').click()
  await dialog(page).locator('[data-testid="mark-paid-occurrence"]').waitFor()
  check('(f) the dialog is titled "Mark Salary as received"', (await dialog(page).getByRole('heading').first().textContent())?.trim(), 'Mark Salary as received')
  const done = page.waitForResponse((r) => r.url().endsWith(`/budget-entries/${w.salary.id}/materialize`))
  await dialog(page).locator('[data-testid="mark-paid-submit"]').click()
  check('(f) Mark received posts the occurrence (201)', (await done).status(), 201)
  await dialog(page).waitFor({ state: 'detached' })
  await gone(recRows(page, 'Salary'))
  check('(f) the Salary row is gone', await recRows(page, 'Salary').count(), 0)
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
  check('(h) no row shows a button', await page.locator(`[data-testid="due-section"] ${ACTION_BUTTONS}`).count(), 0)
  const limited = page.locator('[data-testid="due-row"][data-view="limited"]')
  if (mode === 'drop') {
    check('(h) drop: no Limited rows', await limited.count(), 0)
    check('(h) drop: no rows at all', await dueRows(page).count(), 0)
  } else {
    check('(h) text: each Limited item is listed once', [limitedIds.size > 0, await limited.count()], [true, limitedIds.size])
    check('(h) text: the rows carry the API\'s display names', (await limited.locator('p.text-ink').allInnerTexts()).sort(), [...limitedItems.values()].sort())
    check('(h) text: every row is Limited', await dueRows(page).count(), await limited.count())
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
  check('(i) the paused Gym is not listed', await dueRows(page).filter({ hasText: 'Gym' }).count(), 0)
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
  check('(i) no missed Gym row appears', await recRows(page, 'Gym', 'missed').count(), 0)
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
    const row = recRows(page, name, 'missed')
    check(`(j) ${name}: one missed row with the API's count`, [await row.count(), (await row.locator('[data-testid="due-missed-text"]').textContent())?.trim()],
      [1, `${missed.unlinked_count} missed since ${fmt(missed.oldest_unlinked)}`])
    check(`(j) ${name}: ${button}`, await buttonIds(row), [button])
  }

  const row = recRows(page, 'Old Rent', 'missed')
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
  check('(j) the Old Rent missed row is gone', await recRows(page, 'Old Rent', 'missed').count(), 0)
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
  const row = recRows(page, 'Spotify', 'missed')
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
  const text = left > 0 ? (await recRows(page, 'Spotify', 'missed').locator('[data-testid="due-missed-text"]').textContent())?.trim() : null
  check('(k) the missed row shows one fewer', text, left > 0 ? `${left} missed since ${fmt(after.oldest_unlinked)}` : null)
  const pending = pendRows(page, 'Spotify')
  check('(k) the charged month is listed once as a pending row with Posted', [await pending.count(), await buttonIds(pending)], [1, ['due-posted']])
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
  check('(l) the ended installment is not listed', await dueRows(page).filter({ hasText: 'Gadget' }).count(), 0)
  const again = await api(w.u.token, 'POST', `/budget-entries/${gadget.id}/materialize`, {})
  check('(l) recording it again is refused: 409 "This entry has ended"', [again.status, again.json?.detail], [409, 'This entry has ended'])
  await ctx.close()
}

;(async () => {
  stack = await startLocalStack()
  API = `${stack.apiUrl}/api/v1`
  const browser = await chromium.launch()
  const run = (k) => !only || only === k
  const steps = { a: dashboardReadOnly, b: listing, c: markPaidRent, d: chargedThenPosted, e: markPostedCoffee, f: markReceivedSalary, g: gifts, h: viewer, i: pausedEntry, j: missedKinds, k: chargedMissed, l: endedInstallment }
  for (const [k, fn] of Object.entries(steps)) if (run(k)) await fn(browser)
  await browser.close()
  stack.stop()
  console.log(`\nRESULT: ${pass}/${total} assertions passed`)
  process.exit(pass === total ? 0 : 1)
})().catch((e) => { console.error(e); stack?.stop(); console.log(`\nRESULT (aborted): ${pass}/${total} assertions passed`); process.exit(1) })
