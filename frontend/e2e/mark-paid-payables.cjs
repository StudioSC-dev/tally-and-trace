// Browser check for STU-343: expandable payables and Mark paid on a chosen
// occurrence and date. Starts its own API and web app against a throwaway
// database (./_local_stack.cjs). Not wired into CI and not part of `pnpm build`.
// Run steps: see ./README.md.
//
// Scenarios:
//   (a) seven payables show six rows; "+1 more" expands to rent; Mark paid with
//       yesterday's date removes the row and dates the transaction yesterday
//   (b) a stale rent: the dialog shows the /occurrences response's due count and
//       dates; "Post all N due" posts N rows on their occurrences; the current
//       rent payable stays and Mark paid on it completes
//   (c) a stale capped cash installment: overdue rows, only the oldest month is
//       offered, and no "Post all" button
//   (d) a loan transfer payable posts as a scheduled loan payment split into
//       principal and interest
//   (e) every materialise request body carries occurrence_date
//   (f) an amount typed for one occurrence is cleared when another is chosen:
//       a pending-linked occurrence shows a blank field and sends no amount
//
// Usage: node frontend/e2e/mark-paid-payables.cjs [a|b|c|d|e|f]
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
  const email = `e2e-mp-${tag}-${Math.random().toString(16).slice(2, 8)}@example.com`
  const password = 'E2eTest!2345'
  const reg = await api('', 'POST', '/auth/register', { email, password, first_name: `User${tag}`, last_name: 'Test', default_currency: 'PHP' })
  if (reg.status !== 200 && reg.status !== 201) throw new Error(`register ${reg.status} ${JSON.stringify(reg.json)}`)
  stack.verifyUser(email) // aborts the run unless psql reports UPDATE 1
  const login = await api('', 'POST', '/auth/login', { email, password })
  if (login.status !== 200) throw new Error(`login ${login.status}`)
  return { email, password, tag, token: login.json.access_token }
}
const checking = (u, balance) => post(u.token, '/accounts/', { name: `${u.tag} Checking`, account_type: 'checking', balance, currency: 'PHP' })
const expense = (u, fields) => post(u.token, '/budget-entries/', { entry_type: 'expense', currency: 'PHP', cadence: 'monthly', ...fields })
const entryTransactions = async (u, entryId) =>
  (await get(u.token, '/transactions/?limit=200')).items.filter((t) => t.budget_entry_id === entryId)

// Every materialise request any page sends, for (e).
const materializeBodies = []

async function newPage(browser) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 1000 } })
  const page = await ctx.newPage()
  page.on('request', (r) => {
    if (r.method() === 'POST' && /\/budget-entries\/\d+\/materialize$/.test(new URL(r.url()).pathname)) {
      materializeBodies.push(r.postData() || '')
    }
  })
  if (process.env.DEBUG) page.on('response', (r) => { if (r.url().includes('/api/v1/')) console.log(`    [net] ${r.request().method()} ${r.url().replace(API, '')} -> ${r.status()}`) })
  return { ctx, page }
}

async function uiLogin(page, u) {
  await page.goto(`${stack.webUrl}/login`)
  await page.locator('#email').fill(u.email)
  await page.locator('#password').fill(u.password)
  await page.getByRole('button', { name: 'Sign in', exact: true }).click()
  await page.waitForURL((url) => url.pathname === '/')
  await page.locator('[data-testid="payables"], [data-onboarding="upcoming-expenses"]').first().waitFor()
}

const rows = (page) => page.locator('[data-testid="payable-row"]')
const rowsNamed = (page, name) => rows(page).filter({ has: page.getByText(name, { exact: true }) })
const dialog = (page) => page.locator('[data-testid="mark-paid-dialog"]')
const settle = async (page) => { await page.waitForLoadState('networkidle'); await page.waitForTimeout(500) }
const parseBody = (raw) => { try { return JSON.parse(raw) } catch { return null } }

/** Opens Mark paid on a row; returns the `include` the dialog asked /occurrences for. */
async function openMarkPaid(page, row, entryId) {
  const asked = page.waitForRequest((r) => new URL(r.url()).pathname.endsWith(`/budget-entries/${entryId}/occurrences`))
  await row.locator('[data-testid="payable-mark-paid-button"]').click()
  const request = await asked
  await dialog(page).waitFor()
  await dialog(page).locator('[data-testid="mark-paid-occurrence"]').waitFor()
  return new URL(request.url()).searchParams.get('include')
}

/** Anchor day for a stale monthly schedule: Manila's today + 7, its day of month clamped into 5-25. */
function staleSchedule() {
  const today = manilaToday()
  const ahead = addDays(today, 7)
  const anchor = Math.min(25, Math.max(5, Number(ahead.slice(8, 10))))
  const current = `${ahead.slice(0, 8)}${String(anchor).padStart(2, '0')}`
  return { today, anchor, current, start: addMonths(current, -3, anchor) }
}

// (a) Seven payables, six shown; "+1 more" reaches rent; Mark paid dated yesterday.
async function expandAndMarkPaid(browser) {
  console.log('\n=== (a) seven payables, "+1 more", Mark paid with yesterday\'s date')
  const u = await makeUser('a')
  const bank = await checking(u, 100000)
  const today = manilaToday()
  for (let i = 1; i <= 6; i++) {
    await expense(u, { name: `Bill ${i}`, amount: 100 * i, next_occurrence: wire(addDays(today, 2 + i)), account_id: bank.id })
  }
  const rentDay = addDays(today, 12)
  const rent = await expense(u, { name: 'Rent', amount: 20000, next_occurrence: wire(rentDay), account_id: bank.id })

  const { ctx, page } = await newPage(browser)
  await uiLogin(page, u)
  await settle(page)
  check('(a) the payables count reads 7', (await page.locator('[data-testid="payables-count"]').textContent())?.trim(), '7')
  check('(a) six rows are shown', await rows(page).count(), 6)
  check('(a) rent is not among them', await rowsNamed(page, 'Rent').count(), 0)
  const more = page.locator('[data-testid="payables-more"]')
  check('(a) the toggle reads "+1 more in the next 30 days"', (await more.textContent())?.trim(), '+1 more in the next 30 days')
  await more.click()
  check('(a) expanded: seven rows', await rows(page).count(), 7)
  check('(a) expanded: rent is listed', await rowsNamed(page, 'Rent').count(), 1)

  await openMarkPaid(page, rowsNamed(page, 'Rent').first(), rent.id)
  const select = dialog(page).locator('[data-testid="mark-paid-occurrence"]')
  check('(a) the dialog opens on the clicked occurrence', await select.inputValue(), rentDay)
  check('(a) a future occurrence defaults to today', await dialog(page).locator('[data-testid="mark-paid-date"]').inputValue(), today)
  const yesterday = addDays(today, -1)
  await dialog(page).locator('[data-testid="mark-paid-date"]').fill(yesterday)
  const done = page.waitForResponse((r) => r.url().endsWith(`/budget-entries/${rent.id}/materialize`))
  await dialog(page).locator('[data-testid="mark-paid-submit"]').click()
  const res = await done
  check('(a) Mark paid is 201 created', [res.status(), res.headers()['x-occurrence-outcome']], [201, 'created'])
  await dialog(page).waitFor({ state: 'detached' })
  await settle(page)
  check('(a) the rent row is gone', await rowsNamed(page, 'Rent').count(), 0)
  const txns = await entryTransactions(u, rent.id)
  check('(a) one posted rent transaction dated yesterday', txns.map((t) => [t.is_posted, t.transaction_date.slice(0, 10)]), [[true, yesterday]])
  check('(a) rent moved on a month', (await get(u.token, `/budget-entries/${rent.id}`)).next_occurrence.slice(0, 10), addMonths(rentDay, 1))
  await ctx.close()
}

// (b) A stale rent: Post all N due, N read from /occurrences; then the current one.
async function staleRent(browser) {
  console.log('\n=== (b) stale rent: "Post all N due", then Mark paid on the current rent')
  const u = await makeUser('b')
  const bank = await checking(u, 200000)
  const { anchor, current, start } = staleSchedule()
  console.log(`    anchor day ${anchor}; next_occurrence ${start}; current occurrence ${current}`)
  const rent = await expense(u, { name: 'Rent', amount: 15000, next_occurrence: wire(start), anchor_day: anchor, account_id: bank.id })

  const { ctx, page } = await newPage(browser)
  await uiLogin(page, u)
  await settle(page)
  const more = page.locator('[data-testid="payables-more"]')
  if (await more.count()) await more.click()
  const rentRows = rowsNamed(page, 'Rent')
  check('(b) rent is listed in the payables', (await rentRows.count()) > 0, true)
  const include = await openMarkPaid(page, rentRows.first(), rent.id)
  check('(b) the dialog asked for the clicked occurrence', typeof include === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(include), true)
  const listing = await get(u.token, `/budget-entries/${rent.id}/occurrences${include ? `?include=${include}` : ''}`)
  const n = listing.due_unposted
  const due = listing.occurrences.filter((o) => o.due && o.linked !== 'posted').map((o) => o.occurrence_date)
  console.log(`    /occurrences: due_unposted ${n}; due ${due.join(', ')}`)
  check('(b) the API reports at least two due', n >= 2, true)
  const optionTexts = await dialog(page).locator('[data-testid="mark-paid-occurrence"] option').allTextContents()
  check('(b) the select lists every occurrence the API returned', listing.occurrences.every((o) => optionTexts.some((t) => t.startsWith(fmt(o.occurrence_date)))), true)
  const postAll = dialog(page).locator('[data-testid="mark-paid-post-all"]')
  check('(b) the button shows the API\'s count and dates', (await postAll.textContent())?.trim(), `Post all ${n} due (${fmt(due[0])} – ${fmt(due[due.length - 1])})`)

  const posted = page.waitForResponse((r) => r.url().endsWith(`/budget-entries/${rent.id}/materialize-due`))
  await postAll.click()
  const res = await posted
  const result = await res.json()
  check('(b) Post all due is 200 with N created', [res.status(), result.results.map((r) => r.outcome)], [200, Array(n).fill('created')])
  await dialog(page).waitFor({ state: 'detached' })
  const txns = await entryTransactions(u, rent.id)
  check('(b) N posted rows dated on their occurrences', txns.map((t) => [t.is_posted, t.transaction_date.slice(0, 10)]).sort(), due.map((d) => [true, d]))
  check('(b) the schedule is on the current occurrence', (await get(u.token, `/budget-entries/${rent.id}`)).next_occurrence.slice(0, 10), current)

  await settle(page)
  if (await more.count() && (await more.getAttribute('aria-expanded')) === 'false') await more.click()
  const currentRow = rowsNamed(page, 'Rent').filter({ hasText: fmt(current) })
  check('(b) the current rent payable remains', await currentRow.count(), 1)
  await openMarkPaid(page, currentRow.first(), rent.id)
  check('(b) the dialog opens on the current occurrence', await dialog(page).locator('[data-testid="mark-paid-occurrence"]').inputValue(), current)
  check('(b) nothing earlier is skipped now', await dialog(page).locator('[data-testid="mark-paid-skipped"]').count(), 0)
  const done = page.waitForResponse((r) => r.url().endsWith(`/budget-entries/${rent.id}/materialize`))
  await dialog(page).locator('[data-testid="mark-paid-submit"]').click()
  const last = await done
  check('(b) Mark paid on the current rent is 201', [last.status(), last.headers()['x-occurrence-recorded']], [201, current])
  await dialog(page).waitFor({ state: 'detached' })
  await settle(page)
  check('(b) the current rent row is gone', await rowsNamed(page, 'Rent').filter({ hasText: fmt(current) }).count(), 0)
  check('(b) rent moved past the current occurrence', (await get(u.token, `/budget-entries/${rent.id}`)).next_occurrence.slice(0, 10), addMonths(current, 1, anchor))
  await ctx.close()
}

// (c) A stale capped cash installment: oldest month only, no Post all.
async function staleInstallment(browser) {
  console.log('\n=== (c) stale capped cash installment: oldest month only, no "Post all"')
  const u = await makeUser('c')
  const bank = await checking(u, 100000)
  const { anchor, start } = staleSchedule()
  const gadget = await expense(u, {
    name: 'Gadget', amount: 2000, next_occurrence: wire(start), anchor_day: anchor, account_id: bank.id,
    end_mode: 'after_occurrences', max_occurrences: 12,
  })
  const listing = await get(u.token, `/budget-entries/${gadget.id}/occurrences`)
  console.log(`    /occurrences: capped ${listing.capped}; due_unposted ${listing.due_unposted}`)
  check('(c) the API reports at least three overdue months', listing.due_unposted >= 3, true)

  const { ctx, page } = await newPage(browser)
  await uiLogin(page, u)
  await settle(page)
  const more = page.locator('[data-testid="payables-more"]')
  if (await more.count()) await more.click()
  const gadgetRows = rowsNamed(page, 'Gadget')
  const statuses = await gadgetRows.locator('[data-testid="payable-status"]').evaluateAll((els) => els.map((e) => e.getAttribute('aria-label')))
  check('(c) the missed months show as overdue', statuses.includes('Overdue'), true)
  // The latest listed row, so the dialog is asked for a later month than the oldest.
  await openMarkPaid(page, gadgetRows.last(), gadget.id)
  const options = await dialog(page).locator('[data-testid="mark-paid-occurrence"] option').evaluateAll((els) => els.map((e) => e.value))
  check('(c) only the oldest month is offered', options, [start])
  check('(c) no "Post all" button', await dialog(page).locator('[data-testid="mark-paid-post-all"]').count(), 0)
  const done = page.waitForResponse((r) => r.url().endsWith(`/budget-entries/${gadget.id}/materialize`))
  await dialog(page).locator('[data-testid="mark-paid-submit"]').click()
  const res = await done
  check('(c) Mark paid records the oldest month', [res.status(), res.headers()['x-occurrence-recorded']], [201, start])
  await dialog(page).waitFor({ state: 'detached' })
  check('(c) the installment moved to the next month', (await get(u.token, `/budget-entries/${gadget.id}`)).next_occurrence.slice(0, 10), addMonths(start, 1, anchor))
  await ctx.close()
}

// (d) A loan transfer payable posts with the principal/interest split.
async function loanPayment(browser) {
  console.log('\n=== (d) loan transfer payable posts split into principal and interest')
  const u = await makeUser('d')
  const bank = await checking(u, 50000)
  const today = manilaToday()
  const due = addDays(today, 5)
  const loan = await post(u.token, '/accounts/', {
    name: 'Car loan', account_type: 'loan', loan_kind: 'auto', currency: 'PHP',
    balance: -100000, loan_annual_rate: 12, loan_term_months: 24, loan_payment_amount: 5000, loan_first_payment_date: due,
  })
  const entry = await expense(u, { name: 'Car loan payment', amount: 5000, next_occurrence: wire(due), account_id: bank.id, transfer_to_account_id: loan.id })

  const { ctx, page } = await newPage(browser)
  await uiLogin(page, u)
  await settle(page)
  const row = rowsNamed(page, 'Car loan payment').filter({ has: page.locator('[data-testid="payable-mark-paid-button"]') })
  check('(d) the loan transfer is a payable with Mark paid', await row.count(), 1)
  await openMarkPaid(page, row.first(), entry.id)
  check('(d) no amount fields for a same-currency transfer', await dialog(page).locator('[data-testid="mark-paid-amount"], [data-testid="mark-paid-received"]').count(), 0)
  const done = page.waitForResponse((r) => r.url().endsWith(`/budget-entries/${entry.id}/materialize`))
  await dialog(page).locator('[data-testid="mark-paid-submit"]').click()
  const res = await done
  const body = parseBody(res.request().postData() || '')
  check('(d) the body sends no amount and no transfer_fee', [body && 'amount' in body, body && 'transfer_fee' in body], [false, false])
  const txn = await res.json()
  check('(d) posted as a scheduled loan payment', [res.status(), txn.loan_payment_kind, txn.is_posted], [201, 'scheduled', true])
  check('(d) principal 4,000 and interest 1,000', [txn.amount, txn.transfer_fee], [4000, 1000])
  await dialog(page).waitFor({ state: 'detached' })
  check('(d) Checking paid the whole 5,000', (await get(u.token, `/accounts/${bank.id}`)).balance, 45000)
  check('(d) the loan balance fell by the principal', (await get(u.token, `/accounts/${loan.id}`)).balance, -96000)
  await ctx.close()
}

// (f) Switching occurrence drops the figure typed for the previous one.
async function switchOccurrenceClearsAmount(browser) {
  console.log('\n=== (f) an amount typed for one occurrence is not carried to a pending-linked one')
  const u = await makeUser('f')
  const bank = await checking(u, 200000)
  // A variable bill is a card expense billed as a bill.
  const visa = await post(u.token, '/accounts/', {
    name: 'Visa F', account_type: 'credit', balance: 0, currency: 'PHP',
    billing_cycle_start: 5, days_until_due_date: 21, payment_account_id: bank.id,
  })
  const { anchor, start } = staleSchedule()
  const pendingDay = addMonths(start, 1, anchor)
  const rent = await expense(u, { name: 'Rent', amount: 15000, next_occurrence: wire(start), anchor_day: anchor, account_id: visa.id, billing_kind: 'bill' })
  const pending = await post(u.token, '/transactions/', {
    account_id: visa.id, transaction_type: 'debit', amount: 4321, description: 'Rent',
    transaction_date: wire(pendingDay), is_posted: false, budget_entry_id: rent.id,
  })

  const { ctx, page } = await newPage(browser)
  await uiLogin(page, u)
  await settle(page)
  const asked = page.waitForRequest((r) => new URL(r.url()).pathname.endsWith(`/budget-entries/${rent.id}/occurrences`))
  await page.locator('[data-testid="card-charges-card"]').filter({ has: page.getByText('Visa F', { exact: true }) })
    .locator('[data-testid="card-charge-row"]').filter({ has: page.locator('[data-testid="card-charge-mark-paid"]') })
    .first().locator('[data-testid="card-charge-mark-paid"]').click()
  await asked
  await dialog(page).locator('[data-testid="mark-paid-occurrence"]').waitFor()
  const select = dialog(page).locator('[data-testid="mark-paid-occurrence"]')
  const amount = dialog(page).locator('[data-testid="mark-paid-amount"]')
  await select.selectOption(start)
  check('(f) an unlinked bill prefills its usual amount', await amount.inputValue(), '15000')
  await amount.fill('777')
  await select.selectOption(pendingDay)
  check('(f) the pending-linked occurrence is selected', await select.inputValue(), pendingDay)
  check('(f) its amount field is blank, not 777', await amount.inputValue(), '')
  const done = page.waitForResponse((r) => r.url().endsWith(`/budget-entries/${rent.id}/materialize`))
  await dialog(page).locator('[data-testid="mark-paid-submit"]').click()
  const res = await done
  const body = parseBody(res.request().postData() || '')
  check('(f) the body names the pending occurrence and sends no amount', [body && 'amount' in body, body && body.occurrence_date.slice(0, 10)], [false, pendingDay])
  check('(f) the pending row is posted', [res.status(), res.headers()['x-occurrence-outcome']], [200, 'posted_pending'])
  await dialog(page).waitFor({ state: 'detached' })
  check('(f) the pending row keeps its recorded amount', (await get(u.token, `/transactions/${pending.id}`)).amount, 4321)
  await ctx.close()
}

// (e) Every materialise body named its occurrence.
function everyBodyNamesItsOccurrence() {
  console.log('\n=== (e) every materialise request body carries occurrence_date')
  const bodies = materializeBodies.map(parseBody)
  check('(e) at least one materialise request was sent', bodies.length > 0, true)
  check('(e) every body has an occurrence_date', bodies.filter((b) => !b || typeof b.occurrence_date !== 'string').length, 0)
  check('(e) no body sends transfer_fee', bodies.filter((b) => b && 'transfer_fee' in b).length, 0)
}

;(async () => {
  stack = await startLocalStack()
  API = `${stack.apiUrl}/api/v1`
  const browser = await chromium.launch()
  const run = (k) => !only || only === k
  // (e) reads the bodies the other scenarios send, so on its own it runs (a) first.
  if (run('a') || only === 'e') await expandAndMarkPaid(browser)
  if (run('b')) await staleRent(browser)
  if (run('c')) await staleInstallment(browser)
  if (run('d')) await loanPayment(browser)
  if (run('e')) everyBodyNamesItsOccurrence()
  if (run('f')) await switchOccurrenceClearsAmount(browser)
  await browser.close()
  stack.stop()
  console.log(`\nRESULT: ${pass}/${total} assertions passed`)
  process.exit(pass === total ? 0 : 1)
})().catch((e) => { console.error(e); stack?.stop(); console.log(`\nRESULT (aborted): ${pass}/${total} assertions passed`); process.exit(1) })
