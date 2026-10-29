// Browser check for STU-404: transaction dates are bounded (2000-01-01 to Manila today
// plus 5 years) and checked before anything is sent. Starts its own API and web app
// against a throwaway database (./_local_stack.cjs). PHP only, so no exchange rate is
// fetched. Not wired into CI and not part of `pnpm build`. Run steps: see ./README.md.
//
// Days are computed from the Manila today. The messages are the client's own: the
// server's ISO-format message differs on purpose, so a request that reaches the server
// and comes back 422 does not satisfy the client-message checks. A `dialog` listener on
// every page counts browser-native popups for the whole script and the last check
// asserts there were none.
//
// Scenarios:
//   (a) Add transaction form, native validation: the date inputs carry min and max;
//       0006-05-10 and max + 1 day are rejected by the browser with no POST and no new
//       row; today saves
//   (b) the same form with native validation switched off: an inline message under the
//       date input (aria-invalid, no POST, no browser dialog)
//   (c) Edit: the browser's rejection shown inline (STU-410) with no PUT; then, with
//       native validation off, the client's inline message and no PUT
//   (d) Mark paid: min/max on the date; the dialog's error line; no /materialize request
//   (e) card Pay: min/max on the date; the dialog's error line; no payment request
//   (f) loan payment: min/max on the date; the panel's error line; no loan-payment request
//
// The screen loader (STU-335) blocks input while any request is in flight, so every form
// or dialog waits for it (`waitQuiet`) after it opens and before anything is filled.
//
// Usage: node frontend/e2e/record-dates.cjs [a|b|c|d|e|f]
const { startLocalStack } = require('./_local_stack.cjs')
const { showRow } = require('./_due_pages.cjs')
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
/** Today + 5 calendar years; Feb 29 becomes Feb 28. */
const maxDay = (today) => {
  const year = Number(today.slice(0, 4)) + 5
  const md = today.slice(5)
  return `${year}-${md === '02-29' ? '02-28' : md}`
}
const suffix = (d) => (d % 100 >= 11 && d % 100 <= 13 ? 'th' : ['th', 'st', 'nd', 'rd'][d % 10] || 'th')
/** As the app shows a day: "Oct 25th, 2026". */
const fmt = (day) => {
  const d = new Date(`${day}T00:00:00Z`)
  const month = new Intl.DateTimeFormat('en-US', { month: 'short', timeZone: 'UTC' }).format(d)
  return `${month} ${d.getUTCDate()}${suffix(d.getUTCDate())}, ${d.getUTCFullYear()}`
}
const wire = (day) => `${day}T00:00:00`

const TOO_EARLY = '0006-05-10'
let TODAY, MAX, TOO_LATE, MESSAGE

let stack, API
let dialogs = 0
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

async function makeUser(tag) {
  const email = `e2e-rd-${tag}-${Math.random().toString(16).slice(2, 8)}@example.com`
  const password = 'E2eTest!2345'
  const reg = await api('', 'POST', '/auth/register', { email, password, first_name: `User${tag}`, last_name: 'Test', default_currency: 'PHP' })
  if (reg.status !== 200 && reg.status !== 201) throw new Error(`register ${reg.status} ${JSON.stringify(reg.json)}`)
  stack.verifyUser(email) // aborts the run unless psql reports UPDATE 1
  const login = await api('', 'POST', '/auth/login', { email, password })
  if (login.status !== 200) throw new Error(`login ${login.status}`)
  return { email, password, tag, token: login.json.access_token }
}
const checking = (u, name, balance = 100000) => post(u.token, '/accounts/', { name, account_type: 'checking', balance, currency: 'PHP' })
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** A page whose requests are counted by method and path suffix, and whose dialogs are counted and dismissed. */
async function newPage(browser) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 1000 } })
  const page = await ctx.newPage()
  const requests = []
  page.on('request', (r) => requests.push({ method: r.method(), path: new URL(r.url()).pathname }))
  page.on('dialog', (d) => { dialogs++; console.log(`    [dialog] ${d.type()}: ${d.message()}`); d.dismiss().catch(() => {}) })
  if (process.env.DEBUG) page.on('response', (r) => { if (r.url().includes('/api/v1/')) console.log(`    [net] ${r.request().method()} ${r.url().replace(API, '')} -> ${r.status()}`) })
  /** Requests of `method` whose path ends with `suffix`, since `mark()` was last called. */
  let from = 0
  const sent = (method, suffix) => requests.slice(from).filter((r) => r.method === method && r.path.replace(/\/$/, '').endsWith(suffix)).length
  const mark = () => { from = requests.length }
  return { ctx, page, sent, mark }
}

async function uiLogin(page, u) {
  await page.goto(`${stack.webUrl}/login`)
  await page.locator('#email').fill(u.email)
  await page.locator('#password').fill(u.password)
  await page.getByRole('button', { name: 'Sign in', exact: true }).click()
  await page.waitForURL((url) => url.pathname === '/')
  await page.locator('[data-testid="payables"], [data-onboarding="upcoming-expenses"]').first().waitFor()
}
const settle = async (page) => { await page.waitForLoadState('networkidle'); await page.waitForTimeout(500) }

/** Switches native validation off for the form holding `input`, and drops the input's min and max. */
const disableNative = (input) => input.evaluate((el) => {
  el.removeAttribute('min')
  el.removeAttribute('max')
  if (el.form) el.form.noValidate = true
})
const bounds = (input) => input.evaluate((el) => [el.getAttribute('min'), el.getAttribute('max')])
const validity = (input) => input.evaluate((el) => ({ under: el.validity.rangeUnderflow, over: el.validity.rangeOverflow }))
/** An attribute, or null when the element is missing (no 30 s wait for an element that never comes). */
const attr = (locator, name) => locator.getAttribute(name, { timeout: 3000 }).catch(() => null)
const text = async (locator) => (await locator.textContent({ timeout: 3000 }).catch(() => null))?.replace(/\s+/g, ' ').trim()

let owner, bank, cardPayer, card, loan

async function setup() {
  owner = await makeUser('owner')
  bank = await checking(owner, 'Dates Checking')
  cardPayer = bank
  card = await post(owner.token, '/accounts/', {
    name: 'Dates Card', account_type: 'credit', balance: 0, currency: 'PHP', credit_limit: 50000,
    billing_cycle_start: 24, days_until_due_date: 21, payment_account_id: bank.id,
  })
  await post(owner.token, '/transactions/', {
    account_id: card.id, transaction_type: 'debit', amount: 2000, description: 'Dates card purchase',
    transaction_date: wire(addDays(TODAY, -40)), is_posted: true,
  })
  loan = await post(owner.token, '/accounts/', {
    name: 'Dates Loan', account_type: 'loan', loan_kind: 'auto', balance: -100000, currency: 'PHP',
    loan_annual_rate: 10, loan_term_months: 12, loan_payment_amount: 9000,
    loan_first_payment_date: addDays(TODAY, 20),
  })
}

// ─── The Add / Edit transaction form ─────────────────────────────────────────
const formModal = (page, heading) =>
  page.locator('div.fixed').filter({ has: page.getByRole('heading', { name: heading, exact: true }) })

async function openAddForm(page) {
  await page.goto(`${stack.webUrl}/transactions`)
  await page.getByRole('button', { name: 'Add Transaction' }).first().click()
  const modal = formModal(page, 'Create Transaction')
  await modal.waitFor()
  await waitQuiet(page)
  return modal
}
async function fillAdd(modal, description) {
  await modal.locator('input[type="text"]').first().fill(description)
  await modal.getByRole('button', { name: /^Dates Checking/ }).click()
  await modal.locator('input[type="number"][placeholder="0.00"]').first().fill('123')
}
/** The transaction date input: the first date input in the form. */
const dateInput = (modal) => modal.locator('input[type="date"]').first()
const rows = (page, description) => page.locator('article').filter({ hasText: description })

// (a) Native validation on the Add form.
async function addNative(browser) {
  console.log('\n=== (a) Add transaction: min and max on the date, rejected by the browser with no request')
  const { ctx, page, sent, mark } = await newPage(browser)
  await uiLogin(page, owner)
  const modal = await openAddForm(page)
  await fillAdd(modal, 'Date probe')
  const input = dateInput(modal)
  check('(a) the date input carries min and max', await bounds(input), ['2000-01-01', MAX])

  const attempt = async (day, key, label) => {
    await input.fill(day)
    mark()
    await modal.getByRole('button', { name: 'Create Transaction', exact: true }).click()
    await page.waitForTimeout(2000)
    const v = await validity(input)
    check(`(a) ${label}: the browser flags it`, key === 'under' ? v.under : v.over, true)
    check(`(a) ${label}: no POST /transactions`, sent('POST', '/transactions'), 0)
    check(`(a) ${label}: no new row`, await rows(page, 'Date probe').count(), 0)
  }
  await attempt(TOO_EARLY, 'under', '0006-05-10')
  await attempt(TOO_LATE, 'over', 'max + 1 day')

  await input.fill(TODAY)
  mark()
  const saved = page.waitForResponse((r) => r.request().method() === 'POST' && new URL(r.url()).pathname.replace(/\/$/, '').endsWith('/transactions'))
  await modal.getByRole('button', { name: 'Create Transaction', exact: true }).click()
  check('(a) control: today saves', [200, 201].includes((await saved).status()), true)
  await ctx.close()
}

// (b) The client check on the Add form.
async function addClient(browser) {
  console.log('\n=== (b) Add transaction: the inline message under the date input')
  const { ctx, page, sent, mark } = await newPage(browser)
  await uiLogin(page, owner)
  const modal = await openAddForm(page)
  await fillAdd(modal, 'Date probe b')
  const input = dateInput(modal)
  await disableNative(input)
  await input.fill(TOO_EARLY)
  mark()
  await modal.getByRole('button', { name: 'Create Transaction', exact: true }).click()
  await page.waitForTimeout(2000)
  const error = modal.locator('[data-testid="record-date-error"]')
  check('(b) the message sits under the date input', await text(error), MESSAGE)
  check('(b) the input is marked invalid', await attr(input, 'aria-invalid'), 'true')
  check('(b) it is described by the message',
    [await attr(input, 'aria-describedby'), await attr(error, 'id')].every((v, _, a) => v && v === a[0]), true)
  check('(b) focus moved to the date input', await input.evaluate((el) => el === document.activeElement), true)
  check('(b) no POST /transactions', sent('POST', '/transactions'), 0)
  check('(b) no new row', await rows(page, 'Date probe b').count(), 0)
  await input.fill(TODAY)
  check('(b) changing the date clears the message', await error.count(), 0)
  await ctx.close()
}

// (c) The Edit form.
async function edit(browser) {
  console.log('\n=== (c) Edit transaction: native rejection, then the inline message')
  const seeded = await post(owner.token, '/transactions/', {
    account_id: bank.id, transaction_type: 'debit', amount: 77, description: 'Edit me',
    transaction_date: wire(TODAY), is_posted: true,
  })
  const { ctx, page, sent, mark } = await newPage(browser)
  await uiLogin(page, owner)
  await page.goto(`${stack.webUrl}/transactions`)
  await rows(page, 'Edit me').first().waitFor()
  await waitQuiet(page)
  await rows(page, 'Edit me').first().click()
  await waitQuiet(page)
  await page.getByRole('button', { name: 'Edit Transaction', exact: true }).click()
  const modal = formModal(page, 'Edit Transaction')
  await modal.waitFor()
  await waitQuiet(page)
  const input = dateInput(modal)
  check('(c) the edit form\'s date input carries min and max', await bounds(input), ['2000-01-01', MAX])
  await input.fill(TOO_EARLY)
  mark()
  await modal.getByRole('button', { name: 'Update Transaction', exact: true }).click()
  await page.waitForTimeout(2000)
  // The browser's own message, shown inline (STU-410). The input's value is not read
  // here: Playwright's fill does not reach this form's React state, so the re-render
  // that shows the message puts the stored date back into the input.
  const nativeError = modal.locator('[data-testid="record-date-error"]')
  check('(c) native: the inline date message is shown', ((await text(nativeError)) || '').length > 0, true)
  check('(c) native: no PUT', sent('PUT', `/transactions/${seeded.id}`), 0)

  await disableNative(input)
  await input.fill(TOO_EARLY)
  mark()
  await modal.getByRole('button', { name: 'Update Transaction', exact: true }).click()
  await page.waitForTimeout(2000)
  const error = modal.locator('[data-testid="record-date-error"]')
  check('(c) client: the inline message', await text(error), MESSAGE)
  check('(c) client: the input is marked invalid', await attr(input, 'aria-invalid'), 'true')
  check('(c) client: no PUT', sent('PUT', `/transactions/${seeded.id}`), 0)
  await ctx.close()
}

// (d) Mark paid.
async function markPaid(browser) {
  console.log('\n=== (d) Mark paid: min and max, the dialog\'s error line, no request')
  const entry = await post(owner.token, '/budget-entries/', {
    entry_type: 'expense', currency: 'PHP', cadence: 'monthly', name: 'Dates Rent', amount: 500,
    next_occurrence: wire(addDays(TODAY, -2)), account_id: bank.id,
  })
  const { ctx, page, sent, mark } = await newPage(browser)
  await uiLogin(page, owner)
  await page.goto(`${stack.webUrl}/transactions`)
  await page.locator('[data-testid="due-section"]').waitFor()
  await page.locator('[data-testid="due-count"]').filter({ hasNotText: '…' }).waitFor()
  await settle(page)
  const row = page.locator('[data-testid="due-row"]').filter({ has: page.locator('p', { hasText: /^Dates Rent$/ }) })
  await (await showRow(page, row)).first().locator('[data-testid="due-mark-paid"]').click()
  const dialog = page.locator('[data-testid="mark-paid-dialog"]')
  await dialog.locator('[data-testid="mark-paid-occurrence"]').waitFor()
  await waitQuiet(page)
  const input = dialog.locator('[data-testid="mark-paid-date"]')
  check('(d) the date input carries min and max', await bounds(input), ['2000-01-01', MAX])
  await disableNative(input)
  await input.fill(TOO_EARLY)
  mark()
  await dialog.locator('[data-testid="mark-paid-submit"]').click()
  await page.waitForTimeout(2000)
  check('(d) the dialog shows the message', await text(dialog.locator('[data-testid="mark-paid-error"]')), MESSAGE)
  check('(d) no request to /materialize', sent('POST', `/budget-entries/${entry.id}/materialize`), 0)
  await ctx.close()
}

// (e) Card Pay.
async function cardPay(browser) {
  console.log('\n=== (e) card Pay: min and max, the dialog\'s error line, no request')
  const { ctx, page, sent, mark } = await newPage(browser)
  await uiLogin(page, owner)
  await page.goto(`${stack.webUrl}/accounts/${card.id}`)
  await page.locator('[data-testid="card-credit-panel"]').waitFor()
  await settle(page)
  await page.locator('[data-testid="card-pay-open"]').click()
  const dialog = page.locator('[data-testid="card-pay-dialog"]')
  const amount = dialog.locator('[data-testid="card-pay-amount"]')
  await amount.waitFor()
  await waitQuiet(page)
  if (!(Number(await amount.inputValue()) > 0)) await amount.fill('100')
  const input = dialog.locator('[data-testid="card-pay-date"]')
  check('(e) the date input carries min and max', await bounds(input), ['2000-01-01', MAX])
  await disableNative(input)
  await input.fill(TOO_EARLY)
  mark()
  await dialog.locator('[data-testid="card-pay-submit"]').click()
  await page.waitForTimeout(2000)
  check('(e) the dialog shows the message', await text(dialog.locator('[data-testid="card-pay-error"]')), MESSAGE)
  check('(e) no request to /cards/{id}/payments', sent('POST', `/cards/${card.id}/payments`), 0)
  await ctx.close()
}

// (f) Loan payment.
async function loanPayment(browser) {
  console.log('\n=== (f) loan payment: min and max, the panel\'s error line, no request')
  const { ctx, page, sent, mark } = await newPage(browser)
  await uiLogin(page, owner)
  await page.goto(`${stack.webUrl}/accounts`)
  await page.locator('article').first().waitFor()
  await settle(page)
  await page.locator('article').filter({ has: page.getByText('Dates Loan', { exact: true }) }).locator('[role="button"]').first().click()
  await page.getByRole('button', { name: 'Record payment', exact: true }).first().click()
  const form = page.locator('form').filter({ has: page.getByRole('heading', { name: 'Record payment', exact: true }) })
  const input = form.locator('input[type="date"]')
  await input.waitFor()
  await waitQuiet(page)
  check('(f) the date input has its test id', await form.locator('[data-testid="loan-payment-date"]').count(), 1)
  check('(f) the date input carries min and max', await bounds(input), ['2000-01-01', MAX])
  await disableNative(input)
  await input.fill(TOO_EARLY)
  mark()
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await page.waitForTimeout(2000)
  check('(f) the panel shows the message', await text(form.getByRole('alert')), MESSAGE)
  check('(f) no request to /accounts/{id}/loan-payment', sent('POST', `/accounts/${loan.id}/loan-payment`), 0)
  await ctx.close()
}

;(async () => {
  // Days come from the Manila today; wait out midnight so a run never straddles it.
  const untilMidnight = () => 86400000 - ((Date.now() + 8 * 3600 * 1000) % 86400000)
  if (untilMidnight() < 2 * 60 * 1000) {
    console.log('    within 2 minutes of Manila midnight: waiting for the new day')
    await wait(untilMidnight() + 2000)
  }
  TODAY = manilaToday()
  MAX = maxDay(TODAY)
  TOO_LATE = addDays(MAX, 1)
  MESSAGE = `Choose a date from Jan 1st, 2000 to ${fmt(MAX)}`
  console.log(`    Manila today ${TODAY}; allowed 2000-01-01 to ${MAX}`)

  stack = await startLocalStack()
  API = `${stack.apiUrl}/api/v1`
  const browser = await chromium.launch()
  const run = (k) => !only || only === k
  await setup()
  if (run('a')) await addNative(browser)
  if (run('b')) await addClient(browser)
  if (run('c')) await edit(browser)
  if (run('d')) await markPaid(browser)
  if (run('e')) await cardPay(browser)
  if (run('f')) await loanPayment(browser)
  check('no browser dialog fired in the whole script', dialogs, 0)
  await browser.close()
  stack.stop()
  console.log(`\nRESULT: ${pass}/${total} assertions passed`)
  process.exit(pass === total ? 0 : 1)
})().catch((e) => { console.error(e); stack?.stop(); console.log(`\nRESULT (aborted): ${pass}/${total} assertions passed`); process.exit(1) })
