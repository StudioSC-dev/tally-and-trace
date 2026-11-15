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
//   (j) recurring entries (STU-427): next occurrence up to today + 5 years, end date up to
//       today + 30 years.
//       j.recurring-bounds: the Add Recurring Entry form's two date inputs carry their own
//         min and max; each bound is refused inline (the browser's check, then the client
//         check with native validation off) with no POST; in-range dates save
//       j.recurring-legacy-dates: an entry stored with both dates out of range opens with
//         no min or max on them and saves an unrelated edit; editing one date checks that
//         date only, and the other stays exempt
//   (h) STU-309 AC1, h.edit-prefill-zones: Edit on a row stored as D 00:00 pre-fills D in a
//       browser zone of UTC+8, UTC-8 and UTC
//   (i) STU-309 AC2, i.edit-save-keeps-date: saving an Edit without touching the date leaves
//       the stored date as D 00:00, in each of those zones
//   (l) STU-309 AC4, l.edit-preserves-other-records: that save changes no other transaction
//   (m) STU-309 AC4, m.change-scope-guard: the diff against origin/main has no migration,
//       backend or data-rewrite file and only the expected runtime files
//
// The screen loader (STU-335) blocks input while any request is in flight, so every form
// or dialog waits for it (`waitQuiet`) after it opens and before anything is filled.
//
// Usage: node frontend/e2e/record-dates.cjs [a|b|c|d|e|f|h|i|j|j.recurring-bounds|j.recurring-legacy-dates|l|m]
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
/** Today + `years` (5 by default) calendar years; Feb 29 becomes Feb 28. */
const maxDay = (today, years = 5) => {
  const year = Number(today.slice(0, 4)) + years
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
let END_MAX, END_MESSAGE

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
async function newPage(browser, timezoneId) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 1000 }, ...(timezoneId ? { timezoneId } : {}) })
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

  // STU-582: the future date above unticked "Mark as posted", and moving the date back to
  // today never re-ticks it. The control saves a posted row, so tick the box again.
  const posted = modal.getByLabel('Mark as posted')
  check('(a) a future date unticked "Mark as posted" (STU-582)', await posted.isChecked(), false)
  await input.fill(TODAY)
  check('(a) moving the date back to today leaves the box unticked', await posted.isChecked(), false)
  await posted.check()
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

// (h) (i) (l) STU-309: the Edit form's date in three browser zones.
const ZONES = [['UTC+8', 'Asia/Manila'], ['UTC-8', 'Etc/GMT+8'], ['UTC', 'UTC']]
async function editZones(browser, scenarios) {
  console.log('\n=== (h, i, l) Edit transaction: the stored day D 00:00 in UTC+8, UTC-8 and UTC')
  const day = addDays(TODAY, -3)
  const other = await post(owner.token, '/transactions/', {
    account_id: bank.id, transaction_type: 'debit', amount: 11, description: 'Edit bystander',
    transaction_date: wire(addDays(TODAY, -5)), is_posted: true,
  })
  const read = async (id) => (await api(owner.token, 'GET', `/transactions/${id}`)).json
  const otherBefore = JSON.stringify(await read(other.id))
  for (const [label, zone] of ZONES) {
    const description = `Zone ${label}`
    const seeded = await post(owner.token, '/transactions/', {
      account_id: bank.id, transaction_type: 'debit', amount: 33, description,
      transaction_date: wire(day), is_posted: true,
    })
    const { ctx, page, sent, mark } = await newPage(browser, zone)
    check(`(${label}) the browser zone is ${zone}`, await page.evaluate(() => Intl.DateTimeFormat().resolvedOptions().timeZone), zone)
    await uiLogin(page, owner)
    await page.goto(`${stack.webUrl}/transactions`)
    await rows(page, description).first().waitFor()
    await waitQuiet(page)
    await rows(page, description).first().click()
    await waitQuiet(page)
    await page.getByRole('button', { name: 'Edit Transaction', exact: true }).click()
    const modal = formModal(page, 'Edit Transaction')
    await modal.waitFor()
    await waitQuiet(page)
    check(`h.edit-prefill-zones ${label}: the edit form pre-fills ${day}`, await dateInput(modal).inputValue(), day)
    mark()
    await modal.getByRole('button', { name: 'Update Transaction', exact: true }).click()
    await page.waitForTimeout(2500)
    check(`i.edit-save-keeps-date ${label}: one PUT`, sent('PUT', `/transactions/${seeded.id}`), 1)
    const saved = await read(seeded.id)
    check(`i.edit-save-keeps-date ${label}: the stored date is unchanged`, saved.transaction_date.slice(0, 19).replace(' ', 'T'), wire(day))
    await ctx.close()
  }
  check('l.edit-preserves-other-records: another transaction is untouched by the edits', JSON.stringify(await read(other.id)) === otherBefore, true)

  // The ticket describes the wire value as naive ("D 00:00" with no zone). This API answers
  // with a Z (the column is timestamptz), so the same check runs once more with the zone
  // designator stripped from the responses, to pin the naive shape in every browser zone.
  await post(owner.token, '/transactions/', {
    account_id: bank.id, transaction_type: 'debit', amount: 44, description: 'Naive wire',
    transaction_date: wire(day), is_posted: true,
  })
  for (const [label, zone] of ZONES) {
    const { ctx, page } = await newPage(browser, zone)
    await page.route('**/api/v1/transactions**', async (route) => {
      if (route.request().method() !== 'GET') return route.continue()
      const response = await route.fetch()
      const body = (await response.text()).replace(/("(?:transaction_date)":"[^"]*?)(?:Z|[+-]00:00)"/g, '$1"')
      const { 'content-length': _length, 'content-encoding': _encoding, etag: _etag, ...headers } = response.headers()
      return route.fulfill({ status: response.status(), headers, body })
    })
    await uiLogin(page, owner)
    await page.goto(`${stack.webUrl}/transactions`)
    await rows(page, 'Naive wire').first().waitFor()
    await waitQuiet(page)
    await rows(page, 'Naive wire').first().click()
    await waitQuiet(page)
    await page.getByRole('button', { name: 'Edit Transaction', exact: true }).click()
    const modal = formModal(page, 'Edit Transaction')
    await modal.waitFor()
    await waitQuiet(page)
    check(`h.edit-prefill-zones ${label}, naive wire value: pre-fills ${day}`, await dateInput(modal).inputValue(), day)
    await ctx.close()
  }
}

// (m) The change touches no migration, backend or data-rewrite file.
function scopeGuard() {
  console.log('\n=== (m) Change scope: no migration, backend or data rewrite')
  const { execFileSync } = require('node:child_process')
  const files = execFileSync('git', ['diff', '--name-only', 'origin/main'], { encoding: 'utf8' }).split('\n').filter(Boolean)
  const allowed = [
    'frontend/src/routes/transactions.tsx', 'frontend/e2e/record-dates.cjs', 'frontend/e2e/README.md',
    'packages/shared/package.json', 'packages/shared/src/utils/entryDate.ts', 'packages/shared/src/utils/entryDate.test.ts',
  ]
  check('m.change-scope-guard: no migration or backend file changed', files.filter((f) => f.startsWith('backend/') || /migration|alembic/i.test(f)), [])
  check('m.change-scope-guard: only the expected files changed', files.filter((f) => !allowed.includes(f)), [])
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

// ─── (j) The recurring entry form (STU-427) ──────────────────────────────────
const recurringForm = (page, button) => page.locator('form').filter({ has: page.getByRole('button', { name: button, exact: true }) })
const recurringField = (form, key) => form.locator(`[data-field="${key}"]`)
const recurringError = (form, key) => form.locator(`[data-testid="field-error-${key}"]`)
const isEntryWrite = (method, id) => (r) =>
  r.request().method() === method && new URL(r.url()).pathname.replace(/\/$/, '').endsWith(id ? `/budget-entries/${id}` : '/budget-entries')

async function openRecurring(browser) {
  const opened = await newPage(browser)
  await uiLogin(opened.page, owner)
  await opened.page.goto(`${stack.webUrl}/allocations`)
  await opened.page.getByRole('button', { name: 'Add Recurring Entry' }).waitFor()
  await waitQuiet(opened.page)
  return opened
}

/** Fills `input` with `value`, saves, and checks the field's inline message and that nothing was sent. */
async function refusedDate(page, form, sent, mark, { scenario, key, input, value, flag, message, button, method, path }) {
  await input.fill(value)
  mark()
  await form.getByRole('button', { name: button, exact: true }).click()
  await page.waitForTimeout(1500)
  if (flag) {
    const v = await validity(input)
    check(`${scenario}: ${key} ${value}: the browser flags it`, flag === 'under' ? v.under : v.over, true)
  }
  check(`${scenario}: ${key} ${value}: the inline message`, await text(recurringError(form, key)), message)
  check(`${scenario}: ${key} ${value}: the input is marked invalid`, await attr(input, 'aria-invalid'), 'true')
  check(`${scenario}: ${key} ${value}: nothing sent`, sent(method, path), 0)
}

// j.recurring-bounds: both dates, both bounds, on the Add form.
async function recurringBounds(browser) {
  const scenario = 'j.recurring-bounds'
  console.log(`\n=== (${scenario}) Add Recurring Entry: each date's min and max, refused inline with no request`)
  const { ctx, page, sent, mark } = await openRecurring(browser)
  await page.getByRole('button', { name: 'Add Recurring Entry' }).click()
  const form = recurringForm(page, 'Save Recurring Entry')
  await form.waitFor()
  await waitQuiet(page)
  await recurringField(form, 'name').fill('Bounded gym')
  await recurringField(form, 'account_id').selectOption({ label: 'Dates Checking' })
  await recurringField(form, 'amount').fill('250')
  await form.getByRole('button', { name: 'On date', exact: true }).click()
  const next = recurringField(form, 'next_occurrence')
  const end = recurringField(form, 'end_date')
  await end.fill(`${TODAY}T00:00`)
  check(`${scenario}: the next occurrence carries min and max`, await bounds(next), ['2000-01-01T00:00', `${MAX}T23:59`])
  check(`${scenario}: the end date carries min and max`, await bounds(end), ['2000-01-01T00:00', `${END_MAX}T23:59`])

  const common = { scenario, button: 'Save Recurring Entry', method: 'POST', path: '/budget-entries' }
  const tooLateEnd = addDays(END_MAX, 1)
  for (const [key, input, value, flag, message] of [
    ['next_occurrence', next, '1999-12-31T23:59', 'under', MESSAGE],
    ['next_occurrence', next, `${TOO_LATE}T00:00`, 'over', MESSAGE],
  ]) await refusedDate(page, form, sent, mark, { ...common, key, input, value, flag, message })
  await next.fill(`${TODAY}T09:00`)
  for (const [key, input, value, flag, message] of [
    ['end_date', end, '1999-12-31T23:59', 'under', END_MESSAGE],
    ['end_date', end, `${tooLateEnd}T00:00`, 'over', END_MESSAGE],
  ]) await refusedDate(page, form, sent, mark, { ...common, key, input, value, flag, message })

  // The client's own check, with the browser's switched off.
  await disableNative(next)
  await disableNative(end)
  await end.fill(`${TODAY}T00:00`)
  await refusedDate(page, form, sent, mark, { ...common, key: 'next_occurrence', input: next, value: `${TOO_LATE}T00:00`, message: MESSAGE })
  await next.fill(`${TODAY}T09:00`)
  await refusedDate(page, form, sent, mark, { ...common, key: 'end_date', input: end, value: `${tooLateEnd}T00:00`, message: END_MESSAGE })

  // Both bounds themselves save.
  await next.fill(`${MAX}T09:00`)
  await end.fill(`${END_MAX}T23:59`)
  mark()
  const saved = page.waitForResponse(isEntryWrite('POST'))
  await form.getByRole('button', { name: 'Save Recurring Entry', exact: true }).click()
  const response = await saved
  check(`${scenario}: control: the last allowed dates save`, response.status(), 201)
  const body = await response.json().catch(() => ({}))
  check(`${scenario}: control: as sent`, [String(body.next_occurrence).slice(0, 10), String(body.end_date).slice(0, 10)], [MAX, END_MAX])
  await ctx.close()
}

// j.recurring-legacy-dates: a stored entry with both dates out of range still saves.
async function recurringLegacyDates(browser) {
  const scenario = 'j.recurring-legacy-dates'
  console.log(`\n=== (${scenario}) Edit an entry stored with out-of-range dates`)
  const legacyEnd = `${Number(END_MAX.slice(0, 4)) + 1}-06-30`
  const entry = await post(owner.token, '/budget-entries/', {
    entry_type: 'expense', currency: 'PHP', cadence: 'weekly', name: 'Legacy laundry', amount: 90,
    next_occurrence: wire(TODAY), end_mode: 'on_date', end_date: wire(TODAY), account_id: bank.id,
  })
  stack.psql(`UPDATE budget_entries SET next_occurrence = '1999-12-05 00:00', end_date = '${legacyEnd} 00:00' WHERE id = ${Number(entry.id)}`)
  const stored = async () => {
    const r = await api(owner.token, 'GET', `/budget-entries/${entry.id}`)
    return [r.json.name, String(r.json.next_occurrence).slice(0, 10), String(r.json.end_date).slice(0, 10)]
  }
  const { ctx, page, sent, mark } = await openRecurring(browser)
  const openEdit = async () => {
    await page.goto(`${stack.webUrl}/allocations`)
    await page.locator('article').filter({ has: page.getByText('Legacy laundry', { exact: true }) }).first().click()
    const form = recurringForm(page, 'Update Recurring Entry')
    await form.waitFor()
    await waitQuiet(page)
    return form
  }
  const update = async (form) => {
    mark()
    const saved = page.waitForResponse(isEntryWrite('PUT', entry.id))
    await form.getByRole('button', { name: 'Update Recurring Entry', exact: true }).click()
    return (await saved).status()
  }

  let form = await openEdit()
  const next = recurringField(form, 'next_occurrence')
  const end = recurringField(form, 'end_date')
  check(`${scenario}: the stored dates load`, [await next.inputValue(), await end.inputValue()], ['1999-12-05T00:00', `${legacyEnd}T00:00`])
  check(`${scenario}: untouched, the next occurrence has no min or max`, await bounds(next), [null, null])
  check(`${scenario}: untouched, the end date has no min or max`, await bounds(end), [null, null])
  await recurringField(form, 'name').fill('Legacy laundry')
  await recurringField(form, 'amount').fill('95')
  check(`${scenario}: an unrelated edit saves`, await update(form), 200)
  check(`${scenario}: both dates kept`, await stored(), ['Legacy laundry', '1999-12-05', legacyEnd])

  // Editing the end date checks it; the untouched next occurrence stays exempt.
  form = await openEdit()
  const end2 = recurringField(form, 'end_date')
  const next2 = recurringField(form, 'next_occurrence')
  await refusedDate(page, form, sent, mark, {
    scenario, key: 'end_date', input: end2, value: `${addDays(END_MAX, 1)}T00:00`, flag: 'over', message: END_MESSAGE,
    button: 'Update Recurring Entry', method: 'PUT', path: `/budget-entries/${entry.id}`,
  })
  check(`${scenario}: the next occurrence, untouched, still has no min or max`, await bounds(next2), [null, null])
  await end2.fill(`${addDays(TODAY, 30)}T00:00`)
  check(`${scenario}: an in-range end date saves beside the stored next occurrence`, await update(form), 200)
  check(`${scenario}: next occurrence kept, end date moved`, await stored(), ['Legacy laundry', '1999-12-05', addDays(TODAY, 30)])

  // Editing the next occurrence checks it.
  form = await openEdit()
  const next3 = recurringField(form, 'next_occurrence')
  await refusedDate(page, form, sent, mark, {
    scenario, key: 'next_occurrence', input: next3, value: '1999-12-12T00:00', flag: 'under', message: MESSAGE,
    button: 'Update Recurring Entry', method: 'PUT', path: `/budget-entries/${entry.id}`,
  })
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
  END_MAX = maxDay(TODAY, 30)
  END_MESSAGE = `Choose a date from Jan 1st, 2000 to ${fmt(END_MAX)}`
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
  if (run('j') || only === 'j.recurring-bounds') await recurringBounds(browser)
  if (run('j') || only === 'j.recurring-legacy-dates') await recurringLegacyDates(browser)
  if (run('h') || run('i') || run('l')) await editZones(browser)
  if (run('m')) scopeGuard()
  check('no browser dialog fired in the whole script', dialogs, 0)
  await browser.close()
  stack.stop()
  console.log(`\nRESULT: ${pass}/${total} assertions passed`)
  process.exit(pass === total ? 0 : 1)
})().catch((e) => { console.error(e); stack?.stop(); console.log(`\nRESULT (aborted): ${pass}/${total} assertions passed`); process.exit(1) })
