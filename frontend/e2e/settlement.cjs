// Browser check for the settlement UI (settlement plan, PR 8): how a payment settles
// (autopay or manual) on the dashboard, in the recurring form and on the loan page.
// Starts its own API and web app against a throwaway database (./_local_stack.cjs). Not
// wired into CI and not part of `pnpm build`. Run steps: see ./README.md.
//
// Scenarios (each seeds its own user, so each can run alone). The number in brackets is
// the plan's acceptance criterion it proves:
//   (a) [1, 9] every dashboard cash entry and loan row names its settlement ("Scheduled ·
//       Autopay · from X", "Loan payment · Manual"); a card subscription and a transfer
//       name none and read "Scheduled", and the form shows them no Settlement control
//   (b) [2] the toggle on an entry (the recurring form) and on a loan (the loan page)
//       changes the row, and the flag shown is the one the server returned; a new entry
//       defaults to Manual and can be created as Autopay
//   (c) [3] turning on over missed occurrences shows the count and posts each on its own
//       day on confirm (an entry and a loan)
//   (d) [4] Cancel posts nothing and leaves it Manual (an entry and a loan)
//   (e) [5] a blocked record shows its reason in plain words, no code, and cannot be turned
//       on (a loan with no payment account, an entry on a spending wallet, an entry in
//       another currency)
//   (f) [6] a payment held for funds shows its reason on the dashboard (an entry and a loan)
//   (g) [7] opening Transactions posts a due autopay payment, an entry and a loan
//   (h) the loan toggle is an owner's: an editor sees no Settlement control and the API
//       answers the editor's preview with 404
//
// Every scenario checks that no browser dialog fired.
//
// Usage: node frontend/e2e/settlement.cjs [a|b|c|d|e|f|g|h]
const { startLocalStack } = require('./_local_stack.cjs')
const { waitQuiet } = require('./_smooth.cjs')
const { trackNativeDialogs } = require('./_dialogs.cjs')

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
const wire = (day) => `${day}T00:00:00`
const day10 = (value) => String(value).slice(0, 10)

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
  const email = `e2e-st-${tag}-${Math.random().toString(16).slice(2, 8)}@example.com`
  const password = 'E2eTest!2345'
  const reg = await api('', 'POST', '/auth/register', { email, password, first_name: `User${tag}`, last_name: 'Test', default_currency: 'PHP' })
  if (reg.status !== 200 && reg.status !== 201) throw new Error(`register ${reg.status} ${JSON.stringify(reg.json)}`)
  stack.verifyUser(email) // aborts the run unless psql reports UPDATE 1
  const login = await api('', 'POST', '/auth/login', { email, password })
  if (login.status !== 200) throw new Error(`login ${login.status}`)
  return { email, password, tag, token: login.json.access_token }
}
const account = (u, name, balance = 100000, extra = {}) =>
  post(u.token, '/accounts/', { name, account_type: 'checking', balance, currency: 'PHP', ...extra })
const card = (u, bank, name) => post(u.token, '/accounts/', {
  name, account_type: 'credit', balance: 0, currency: 'PHP', credit_limit: 100000,
  billing_cycle_start: 25, days_until_due_date: 21, payment_account_id: bank.id,
})
const entry = (u, fields) => post(u.token, '/budget-entries/', { entry_type: 'expense', currency: 'PHP', cadence: 'monthly', ...fields })
const loanOf = (u, name, first, extra = {}) => post(u.token, '/accounts/', {
  name, account_type: 'loan', loan_kind: 'auto', balance: -100000, currency: 'PHP',
  loan_annual_rate: 12, loan_term_months: 24, loan_payment_amount: 5000, loan_first_payment_date: first, ...extra,
})
/** Turns autopay on through the API (a seed). `expectedDue` is the missed count it confirms. */
const autopayOn = async (u, kind, id, expectedDue = 0) => {
  const r = await api(u.token, 'POST', kind === 'loan' ? `/accounts/${id}/auto-post` : `/budget-entries/${id}/auto-post`, { enabled: true, expected_due: expectedDue })
  if (r.status !== 200) throw new Error(`autopay on ${kind} ${id}: ${r.status} ${JSON.stringify(r.json)}`)
  return r.json
}
const balanceOf = async (u, id) => (await get(u.token, `/accounts/${id}`)).balance
const settlementOf = async (u, id) => (await get(u.token, `/budget-entries/${id}`)).settlement
const entriesOf = async (u) => { const r = await get(u.token, '/budget-entries/'); return Array.isArray(r) ? r : r.items }
const entryRows = async (u, entryId) =>
  (await get(u.token, '/transactions/?limit=1000')).items.filter((t) => t.budget_entry_id === entryId)

async function newPage(browser) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 1400 }, timezoneId: 'Asia/Manila' })
  const page = await ctx.newPage()
  const native = trackNativeDialogs(page)
  const calls = []
  page.on('response', (r) => {
    const path = new URL(r.url()).pathname
    const m = path.match(/\/(budget-entries|accounts)\/(\d+)\/(auto-post|auto-post-preview)$/)
    if (m) calls.push({ method: r.request().method(), what: m[3], id: Number(m[2]), status: r.status(), body: JSON.parse(r.request().postData() || '{}') })
    if (path.endsWith('/budget-entries/post-due-installments')) {
      r.json().then((json) => calls.push({ method: 'POST', what: 'post-due', status: r.status(), body: JSON.parse(r.request().postData() || '{}'), json })).catch(() => undefined)
    }
  })
  if (process.env.DEBUG) page.on('response', (r) => { if (r.url().includes('/api/v1/')) console.log(`    [net] ${r.request().method()} ${r.url().replace(API, '')} -> ${r.status()}`) })
  return { ctx, page, native, calls }
}
async function uiLogin(page, u) {
  await page.goto(`${stack.webUrl}/login`)
  await page.locator('#email').fill(u.email)
  await page.locator('#password').fill(u.password)
  await page.getByRole('button', { name: 'Sign in', exact: true }).click()
  await page.waitForURL((url) => url.pathname === '/')
  await page.locator('[data-testid="payables"], [data-onboarding="upcoming-expenses"]').first().waitFor()
}
const settle = async (page) => { await page.waitForLoadState('networkidle'); await page.waitForTimeout(500); await waitQuiet(page) }
const checkNoNative = (scenario, native) => check(`(${scenario}) no browser dialog fired`, native.count, 0)

async function openDashboard(page) {
  await page.goto(`${stack.webUrl}/`)
  await page.locator('[data-testid="payables"], [data-onboarding="upcoming-expenses"]').first().waitFor()
  await settle(page)
  const all = page.getByRole('button', { name: /show all|view all/i })
  if (await all.count()) await all.first().click()
}
const payableRow = (page, name) => page.locator('[data-testid="payable-row"]').filter({ hasText: name }).first()
const detailOf = async (page, name) => (await payableRow(page, name).locator('[data-testid="payable-detail"]').textContent())?.trim()
const statusOf = async (page, name) => payableRow(page, name).locator('[data-testid="payable-status"]').getAttribute('aria-label')

async function openAllocations(page) {
  await page.goto(`${stack.webUrl}/allocations`)
  await page.locator('[data-testid^="kind-section-"]').first().waitFor()
  await settle(page)
}
const section = (page, key) => page.locator(`[data-testid="kind-section-${key}"]`)
const cardNamed = (page, key, name) => section(page, key).locator('article').filter({ has: page.getByText(name, { exact: true }) })
const formClose = (page) => page.getByLabel('Close allocation modal')
const editForm = (page) => page.locator('form').filter({ has: page.getByRole('button', { name: 'Update Recurring Entry' }) })
const addForm = (page) => page.locator('form').filter({ has: page.getByRole('button', { name: 'Save Recurring Entry' }) })
const confirmDialog = (page) => page.locator('[data-testid="confirm-dialog"]')

/** Opens an entry's edit form from the Allocations page. */
async function openEdit(page, key, name) {
  await cardNamed(page, key, name).click()
  await formClose(page).waitFor()
  await editForm(page).getByRole('button', { name: 'Update Recurring Entry' }).waitFor()
}
async function openLoan(page, name) {
  await page.goto(`${stack.webUrl}/accounts`)
  await page.locator('article').first().waitFor()
  await settle(page)
  await page.locator('article').filter({ has: page.getByText(name, { exact: true }) }).locator('[role="button"]').first().click()
  await page.locator('[data-testid="loan-due-dates"], [data-testid="settlement-control"]').first().waitFor()
  await waitQuiet(page)
}
const loanControl = (page) => page.locator('[data-testid="settlement-control"]')
const loanState = (page) => loanControl(page).locator('[data-testid="settlement-state"]').textContent().then((t) => t?.trim())
const noCode = (text) => !/[a-z]+_[a-z_]+/.test(text ?? '')

// (a) Every cash entry and loan row names its settlement; the rest read Scheduled.
async function dashboardRows(browser) {
  console.log('\n=== (a) every dashboard cash entry and loan row names its settlement')
  const today = manilaToday()
  const u = await makeUser('a')
  const bank = await account(u, 'A Checking')
  const visa = await post(u.token, '/accounts/', { name: 'A Visa', account_type: 'credit', balance: 0, currency: 'PHP', credit_limit: 100000 })
  await entry(u, { name: 'A Salary', entry_type: 'income', amount: 30000, account_id: bank.id, next_occurrence: wire(addDays(today, 2)) })
  const manual = await entry(u, { name: 'A Rent', amount: 15000, account_id: bank.id, next_occurrence: wire(addDays(today, 3)) })
  const auto = await entry(u, { name: 'A Gym', amount: 800, account_id: bank.id, next_occurrence: wire(addDays(today, 4)) })
  await autopayOn(u, 'entry', auto.id)
  await entry(u, { name: 'A Netflix', amount: 549, account_id: visa.id, next_occurrence: wire(addDays(today, 5)) })
  const savings = await account(u, 'A Savings', 5000)
  await entry(u, { name: 'A Topup', amount: 2000, account_id: bank.id, transfer_to_account_id: savings.id, next_occurrence: wire(addDays(today, 6)) })
  const manualLoan = await loanOf(u, 'A Manual loan', addDays(today, 7), { payment_account_id: bank.id })
  const autoLoan = await loanOf(u, 'A Auto loan', addDays(today, 8), { payment_account_id: bank.id })
  await autopayOn(u, 'loan', autoLoan.id)
  const snapshot = await get(u.token, '/dashboard/snapshot')
  if (process.env.DEBUG) console.log('UPCOMING', JSON.stringify(snapshot.upcoming_this_month.map((p) => [p.name, p.source, p.settlement, p.due_date])))
  if (process.env.DEBUG) console.log(JSON.stringify(snapshot.payables.map((p) => [p.name, p.source, p.settlement])))
  check('(a) control: the snapshot carries each settlement', snapshot.payables.map((p) => [p.name, p.settlement ?? null]).sort(), [
    ['A Auto loan payment', 'autopay'], ['A Gym', 'autopay'], ['A Manual loan payment', 'manual'], ['A Netflix', null], ['A Rent', 'manual'],
  ])
  void manual; void manualLoan
  const { ctx, page, native } = await newPage(browser)
  await uiLogin(page, u)
  await openDashboard(page)
  check('(a) a manual cash entry reads Manual', [await detailOf(page, 'A Rent'), await statusOf(page, 'A Rent')], ['Scheduled · Manual · from A Checking', 'Pay manually'])
  check('(a) an autopay cash entry reads Autopay', [await detailOf(page, 'A Gym'), await statusOf(page, 'A Gym')], ['Scheduled · Autopay · from A Checking', 'Autopay'])
  check('(a) a manual loan reads Manual', await detailOf(page, 'A Manual loan payment'), 'Loan payment · Manual · from A Checking')
  check('(a) an autopay loan reads Autopay', await detailOf(page, 'A Auto loan payment'), 'Loan payment · Autopay · from A Checking')
  // Rows that name no settlement read Scheduled: a card subscription on a card with no statement cycle sits in the
  // payables, and income in the also-coming-up list.
  const netflix = ((await detailOf(page, 'A Netflix').catch(() => '')) ?? '')
  check('(a) a card subscription reads Scheduled and names no settlement', [netflix.startsWith('Scheduled'), /Autopay|Manual/.test(netflix), await statusOf(page, 'A Netflix').catch(() => null)], [true, false, 'Scheduled'])
  const salary = (await page.locator('[data-testid="other-upcoming-row"]').filter({ hasText: 'A Salary' }).locator('[data-testid="other-upcoming-detail"]').first().textContent().catch(() => null)) ?? ''
  check('(a) income reads Scheduled and names no settlement', [salary.includes('Scheduled'), /Autopay|Manual/.test(salary)], [true, false])
  await openAllocations(page)
  await openEdit(page, 'subscription', 'A Netflix')
  check('(a) a card subscription has no Settlement control', await editForm(page).getByTestId('recurring-settlement').count(), 0)
  await formClose(page).click()
  await formClose(page).waitFor({ state: 'detached' })
  await openEdit(page, 'other', 'A Topup')
  check('(a) a transfer has no Settlement control', await editForm(page).getByTestId('recurring-settlement').count(), 0)
  await formClose(page).click()
  await formClose(page).waitFor({ state: 'detached' })
  await openEdit(page, 'cash', 'A Rent')
  check('(a) a cash expense has the control', await editForm(page).getByTestId('recurring-settlement').count(), 1)
  await formClose(page).click()
  checkNoNative('a', native)
  await ctx.close()
}

// (b) The toggle on an entry and a loan changes the row.
async function toggles(browser) {
  console.log('\n=== (b) the toggle on an entry and a loan changes the row')
  const today = manilaToday()
  const u = await makeUser('b')
  const bank = await account(u, 'B Checking')
  const rent = await entry(u, { name: 'B Rent', amount: 15000, account_id: bank.id, next_occurrence: wire(addDays(today, 3)) })
  const loan = await loanOf(u, 'B Loan', addDays(today, 6), { payment_account_id: bank.id })
  const { ctx, page, native, calls } = await newPage(browser)
  await uiLogin(page, u)
  await openDashboard(page)
  check('(b) before: the rent reads Manual', await detailOf(page, 'B Rent'), 'Scheduled · Manual · from B Checking')

  // The new-entry form defaults to Manual, and an entry saved so is Manual.
  await openAllocations(page)
  await page.getByRole('button', { name: 'Add Recurring Entry' }).click()
  await formClose(page).waitFor()
  const add = addForm(page)
  await add.locator('select').filter({ has: page.locator('option', { hasText: 'Select account' }) }).selectOption({ label: 'B Checking' })
  check('(b) the new-entry form defaults to Manual', await add.getByTestId('recurring-settlement').inputValue(), 'manual')
  await add.locator('input[type="text"]').first().fill('B Water')
  await add.locator('input[type="number"]').first().fill('300')
  await add.getByRole('button', { name: 'Save Recurring Entry' }).click()
  await formClose(page).waitFor({ state: 'detached' })
  await settle(page)
  const water = (await entriesOf(u)).find((e) => e.name === 'B Water')
  check('(b) an entry saved on the default is Manual', water.settlement, 'manual')

  // The entry's toggle, through the form: Autopay, then back to Manual.
  await openEdit(page, 'cash', 'B Rent')
  await editForm(page).getByTestId('recurring-settlement').selectOption('autopay')
  const before = calls.length
  await editForm(page).getByRole('button', { name: 'Update Recurring Entry' }).click()
  await formClose(page).waitFor({ state: 'detached' })
  await settle(page)
  const on = calls.slice(before).filter((c) => c.method === 'POST' && c.what === 'auto-post')
  check('(b) one toggle call, enabled, confirming no missed payments', on.map((c) => [c.id, c.status, c.body]), [[rent.id, 200, { enabled: true, expected_due: 0 }]])
  check('(b) the API agrees', await settlementOf(u, rent.id), 'autopay')
  await openDashboard(page)
  check('(b) the rent row now reads Autopay', [await detailOf(page, 'B Rent'), await statusOf(page, 'B Rent')], ['Scheduled · Autopay · from B Checking', 'Autopay'])
  await openAllocations(page)
  await openEdit(page, 'cash', 'B Rent')
  check('(b) the form reopens on Autopay', await editForm(page).getByTestId('recurring-settlement').inputValue(), 'autopay')
  await editForm(page).getByTestId('recurring-settlement').selectOption('manual')
  await editForm(page).getByRole('button', { name: 'Update Recurring Entry' }).click()
  await formClose(page).waitFor({ state: 'detached' })
  await settle(page)
  check('(b) back to Manual in the API', await settlementOf(u, rent.id), 'manual')
  await openDashboard(page)
  check('(b) the rent row reads Manual again', await detailOf(page, 'B Rent'), 'Scheduled · Manual · from B Checking')

  // A new entry created as Autopay: the toggle follows the create.
  await openAllocations(page)
  await page.getByRole('button', { name: 'Add Recurring Entry' }).click()
  await formClose(page).waitFor()
  const add2 = addForm(page)
  await add2.locator('select').filter({ has: page.locator('option', { hasText: 'Select account' }) }).selectOption({ label: 'B Checking' })
  await add2.locator('input[type="text"]').first().fill('B Internet')
  await add2.locator('input[type="number"]').first().fill('1200')
  await add2.getByTestId('recurring-settlement').selectOption('autopay')
  await add2.getByRole('button', { name: 'Save Recurring Entry' }).click()
  // The form's default date is today, so one payment is already due and is confirmed first.
  await confirmDialog(page).waitFor()
  check('(b) a new entry dated today asks before posting its one due payment', (await confirmDialog(page).locator('[data-testid="confirm-dialog-message"]').textContent())?.trim(), 'This will post 1 missed payment, dated on its own day.')
  await confirmDialog(page).locator('[data-testid="confirm-dialog-confirm"]').click()
  await formClose(page).waitFor({ state: 'detached' })
  await settle(page)
  const internet = (await entriesOf(u)).find((e) => e.name === 'B Internet')
  check('(b) an entry created as Autopay ends Autopay', internet.settlement, 'autopay')

  // The loan's toggle on the loan page.
  await openLoan(page, 'B Loan')
  check('(b) the loan starts Manual', await loanState(page), 'Manual')
  const loanBefore = calls.length
  await loanControl(page).getByTestId('settlement-toggle').click()
  await page.locator('[data-testid="settlement-control"][data-settlement="autopay"]').waitFor()
  await settle(page)
  const loanOn = calls.slice(loanBefore).filter((c) => c.method === 'POST' && c.what === 'auto-post')
  check('(b) one toggle call for the loan', loanOn.map((c) => [c.id, c.status, c.body]), [[loan.id, 200, { enabled: true, expected_due: 0 }]])
  check('(b) the loan reads Autopay', await loanState(page), 'Autopay')
  check('(b) the API agrees on the loan', (await get(u.token, `/accounts/${loan.id}/loan-schedule`)).settlement, 'autopay')
  await openDashboard(page)
  check('(b) the loan row reads Autopay', await detailOf(page, 'B Loan payment'), 'Loan payment · Autopay · from B Checking')
  await openLoan(page, 'B Loan')
  await loanControl(page).getByTestId('settlement-toggle').click()
  await page.locator('[data-testid="settlement-control"][data-settlement="manual"]').waitFor()
  await settle(page)
  check('(b) turned off, the loan reads Manual', [await loanState(page), (await get(u.token, `/accounts/${loan.id}/loan-schedule`)).settlement], ['Manual', 'manual'])
  checkNoNative('b', native)
  await ctx.close()
}

// (c) Turning on over missed occurrences shows the count and posts on confirm.
async function catchUp(browser) {
  console.log('\n=== (c) turning on over missed occurrences shows the count and posts on confirm')
  const today = manilaToday()
  const u = await makeUser('c')
  const bank = await account(u, 'C Checking')
  const first = addDays(today, -14)
  const water = await entry(u, { name: 'C Water', cadence: 'weekly', amount: 500, account_id: bank.id, next_occurrence: wire(first) })
  const preview = await get(u.token, `/budget-entries/${water.id}/auto-post-preview`)
  check('(c) control: the server counts three missed', [preview.block, preview.due_count, preview.oldest], [null, 3, first])
  const loanFirst = addDays(today, -1)
  const loan = await loanOf(u, 'C Loan', loanFirst, { payment_account_id: bank.id })
  const loanPreview = await get(u.token, `/accounts/${loan.id}/auto-post-preview`)
  check('(c) control: the server counts the loan\'s missed due dates', [loanPreview.block, loanPreview.due_count > 0], [null, true])
  const { ctx, page, native, calls } = await newPage(browser)
  await uiLogin(page, u)
  await openAllocations(page)
  await openEdit(page, 'cash', 'C Water')
  await editForm(page).getByTestId('recurring-settlement').selectOption('autopay')
  await editForm(page).getByRole('button', { name: 'Update Recurring Entry' }).click()
  await confirmDialog(page).waitFor()
  check('(c) the dialog shows the count', (await confirmDialog(page).locator('[data-testid="confirm-dialog-message"]').textContent())?.trim(), 'This will post 3 missed payments, each dated on its own day.')
  check('(c) nothing is posted before Confirm', [(await entryRows(u, water.id)).length, await settlementOf(u, water.id)], [0, 'manual'])
  const before = calls.length
  await confirmDialog(page).locator('[data-testid="confirm-dialog-confirm"]').click()
  await formClose(page).waitFor({ state: 'detached' })
  await settle(page)
  const sent = calls.slice(before).filter((c) => c.method === 'POST' && c.what === 'auto-post')
  check('(c) the confirmed count goes back as expected_due', sent.map((c) => [c.status, c.body]), [[200, { enabled: true, expected_due: 3 }]])
  const rows = await entryRows(u, water.id)
  check('(c) three payments posted, each on its own day', rows.map((t) => [day10(t.transaction_date), t.is_posted]).sort(), [[first, true], [addDays(first, 7), true], [addDays(first, 14), true]].sort())
  check('(c) the entry is Autopay and the balance moved by three', [await settlementOf(u, water.id), await balanceOf(u, bank.id)], ['autopay', 100000 - 1500])

  const dueLoan = (await get(u.token, `/accounts/${loan.id}/auto-post-preview`)).due_count
  const bankBefore = await balanceOf(u, bank.id)
  await openLoan(page, 'C Loan')
  const start = calls.length
  await loanControl(page).getByTestId('settlement-toggle').click()
  await confirmDialog(page).waitFor()
  check('(c) the loan dialog shows its count', (await confirmDialog(page).locator('[data-testid="confirm-dialog-message"]').textContent())?.trim(),
    dueLoan === 1 ? 'This will post 1 missed payment, dated on its own day.' : `This will post ${dueLoan} missed payments, each dated on its own day.`)
  await confirmDialog(page).locator('[data-testid="confirm-dialog-confirm"]').click()
  await page.locator('[data-testid="settlement-control"][data-settlement="autopay"]').waitFor()
  await settle(page)
  const loanSent = calls.slice(start).filter((c) => c.method === 'POST' && c.what === 'auto-post')
  check('(c) the loan toggle confirmed its count', loanSent.map((c) => [c.status, c.body]), [[200, { enabled: true, expected_due: dueLoan }]])
  check('(c) the loan reads Autopay and its payment came out of the bank', [await loanState(page), (await balanceOf(u, bank.id)) < bankBefore], ['Autopay', true])
  checkNoNative('c', native)
  await ctx.close()
}

// (d) Cancel posts nothing.
async function cancel(browser) {
  console.log('\n=== (d) Cancel posts nothing')
  const today = manilaToday()
  const u = await makeUser('d')
  const bank = await account(u, 'D Checking')
  const water = await entry(u, { name: 'D Water', cadence: 'weekly', amount: 500, account_id: bank.id, next_occurrence: wire(addDays(today, -14)) })
  const loan = await loanOf(u, 'D Loan', addDays(today, -1), { payment_account_id: bank.id })
  const { ctx, page, native, calls } = await newPage(browser)
  await uiLogin(page, u)
  await openAllocations(page)
  await openEdit(page, 'cash', 'D Water')
  await editForm(page).getByTestId('recurring-settlement').selectOption('autopay')
  await editForm(page).getByRole('button', { name: 'Update Recurring Entry' }).click()
  await confirmDialog(page).waitFor()
  const before = calls.length
  await confirmDialog(page).locator('[data-testid="confirm-dialog-cancel"]').click()
  await formClose(page).waitFor({ state: 'detached' })
  await settle(page)
  check('(d) no toggle call was sent', calls.slice(before).filter((c) => c.method === 'POST' && c.what === 'auto-post').length, 0)
  check('(d) nothing posted, still Manual, balance untouched', [(await entryRows(u, water.id)).length, await settlementOf(u, water.id), await balanceOf(u, bank.id)], [0, 'manual', 100000])

  await openLoan(page, 'D Loan')
  await loanControl(page).getByTestId('settlement-toggle').click()
  await confirmDialog(page).waitFor()
  const start = calls.length
  await confirmDialog(page).locator('[data-testid="confirm-dialog-cancel"]').click()
  await confirmDialog(page).waitFor({ state: 'detached' })
  await settle(page)
  check('(d) the loan sent no toggle call', calls.slice(start).filter((c) => c.method === 'POST' && c.what === 'auto-post').length, 0)
  check('(d) the loan still reads Manual and nothing was paid', [await loanState(page), (await get(u.token, `/accounts/${loan.id}/loan-schedule`)).settlement, await balanceOf(u, bank.id)], ['Manual', 'manual', 100000])
  checkNoNative('d', native)
  await ctx.close()
}

// (e) A blocked record shows its reason and cannot be turned on.
async function blocked(browser) {
  console.log('\n=== (e) a blocked record shows its reason and cannot be turned on')
  const today = manilaToday()
  const u = await makeUser('e')
  const bank = await account(u, 'E Checking')
  const wallet = await account(u, 'E Wallet', 3000, { is_spending_wallet: true })
  const usd = await account(u, 'E Dollars', 500, { currency: 'USD' })
  const loan = await loanOf(u, 'E Loan', addDays(today, 5))
  const walletEntry = await entry(u, { name: 'E Lunch', amount: 100, account_id: wallet.id, next_occurrence: wire(addDays(today, 3)) })
  const usdEntry = await entry(u, { name: 'E Hosting', amount: 10, currency: 'USD', account_id: usd.id, next_occurrence: wire(addDays(today, 3)) })
  const pesoOnUsd = await entry(u, { name: 'E Mismatch', amount: 100, account_id: bank.id, next_occurrence: wire(addDays(today, 3)) })
  await api(u.token, 'PUT', `/budget-entries/${pesoOnUsd.id}`, { account_id: usd.id })
  void walletEntry; void usdEntry
  const control = await api(u.token, 'POST', `/accounts/${loan.id}/auto-post`, { enabled: true, expected_due: 0 })
  check('(e) control: the API refuses the loan with no payment account', control.status, 400)
  const { ctx, page, native, calls } = await newPage(browser)
  await uiLogin(page, u)

  await openLoan(page, 'E Loan')
  const text = (await loanControl(page).getByTestId('settlement-block').textContent())?.trim()
  check('(e) the loan shows why, in plain words', [text, noCode(text)], ['Choose an account to pay this loan from first.', true])
  check('(e) and its toggle is off', await loanControl(page).getByTestId('settlement-toggle').isDisabled(), true)
  const loanCalls = calls.filter((c) => c.method === 'POST' && c.what === 'auto-post').length
  check('(e) nothing was sent for it', loanCalls, 0)

  await openAllocations(page)
  await openEdit(page, 'cash', 'E Lunch')
  const select = editForm(page).getByTestId('recurring-settlement')
  const help = (await editForm(page).getByTestId('recurring-settlement-help').textContent())?.trim()
  check('(e) a spending wallet\'s control is off with its reason', [await select.isDisabled(), help, noCode(help)], [true, 'Spending from a wallet cannot be paid by autopay.', true])
  await formClose(page).click()
  await formClose(page).waitFor({ state: 'detached' })

  await openEdit(page, 'cash', 'E Mismatch')
  const select2 = editForm(page).getByTestId('recurring-settlement')
  const help2 = (await editForm(page).getByTestId('recurring-settlement-help').textContent())?.trim()
  check('(e) an entry in another currency than its account is off with its reason', [await select2.isDisabled(), help2, noCode(help2)], [true, 'This is in a different currency than the account it is paid from.', true])
  await formClose(page).click()
  checkNoNative('e', native)
  await ctx.close()
}

// (f) A held payment shows its reason on the dashboard.
async function heldNotice(browser) {
  console.log('\n=== (f) a payment held for funds shows its reason on the dashboard')
  const today = manilaToday()
  const u = await makeUser('f')
  const poor = await account(u, 'F Poor', 1000)
  const rent = await entry(u, { name: 'F Rent', amount: 5000, account_id: poor.id, next_occurrence: wire(today) })
  await autopayOn(u, 'entry', rent.id, 1)
  const loan = await loanOf(u, 'F Loan', today, { payment_account_id: poor.id })
  await autopayOn(u, 'loan', loan.id, 1)
  const snapshot = await get(u.token, '/dashboard/snapshot')
  check('(f) control: both are held for funds', snapshot.autopay_due.map((r) => [r.name, r.state, r.block_reason]).sort(), [['F Loan', 'held', 'insufficient_funds'], ['F Rent', 'held', 'insufficient_funds']])
  const { ctx, page, native } = await newPage(browser)
  await uiLogin(page, u)
  await openDashboard(page)
  const notices = (await page.locator('[data-testid="autopay-notice"]').allTextContents()).map((t) => t.trim()).sort()
  check('(f) the dashboard says why each could not post', notices, ['F Loan could not post: not enough in F Poor', 'F Rent could not post: not enough in F Poor'])
  check('(f) no reason code is shown', notices.every(noCode), true)
  checkNoNative('f', native)
  await ctx.close()
}

// (g) Opening Transactions posts a due autopay payment.
async function pageOpen(browser) {
  console.log('\n=== (g) opening Transactions posts a due autopay payment')
  const today = manilaToday()
  const u = await makeUser('g')
  const bank = await account(u, 'G Checking', 1000)
  const rent = await entry(u, { name: 'G Rent', amount: 5000, account_id: bank.id, next_occurrence: wire(today) })
  await autopayOn(u, 'entry', rent.id, 1)
  const loan = await loanOf(u, 'G Loan', today, { payment_account_id: bank.id })
  await autopayOn(u, 'loan', loan.id, 1)
  // Funds arrive; the autopay payments are still unposted until a run reaches them.
  await post(u.token, '/transactions/', { account_id: bank.id, transaction_type: 'credit', amount: 50000, description: 'G Salary', transaction_date: wire(today), is_posted: true })
  const held = (await get(u.token, '/dashboard/snapshot')).autopay_due
  check('(g) control: both wait, now postable', held.map((r) => [r.name, r.postable_count]).sort(), [['G Loan', 1], ['G Rent', 1]])
  check('(g) control: no rent row yet', (await entryRows(u, rent.id)).length, 0)
  const { ctx, page, native, calls } = await newPage(browser)
  await uiLogin(page, u)
  await page.goto(`${stack.webUrl}/transactions`)
  await page.locator('[data-testid="due-section"]').waitFor()
  await settle(page)
  const runs = calls.filter((c) => c.what === 'post-due')
  check('(g) the page-open run was sent once, and posted both', [runs.length, runs[0]?.body, runs[0]?.json?.posted], [1, { trigger: 'page_open' }, 2])
  check('(g) the page says what posted, with no installment wording', (await page.locator('[data-testid="due-page-open-result"]').textContent({ timeout: 10000 }).catch(() => null))?.trim(), 'Posted 2 due payments')
  const rows = await entryRows(u, rent.id)
  check('(g) the rent posted on its own day, linked', rows.map((t) => [day10(t.transaction_date), t.is_posted]), [[today, true]])
  check('(g) the bank paid the rent and the loan payment', (await balanceOf(u, bank.id)) < 1000 + 50000 - 5000, true)
  check('(g) nothing is left due', (await get(u.token, '/dashboard/snapshot')).autopay_due, [])
  checkNoNative('g', native)
  await ctx.close()
}

// (h) The loan toggle is an owner's.
async function editorLoan(browser) {
  console.log('\n=== (h) an editor sees no loan Settlement control')
  const today = manilaToday()
  const owner = await makeUser('h-owner')
  const editor = await makeUser('h-editor')
  const bank = await account(owner, 'H Checking')
  const loan = await loanOf(owner, 'H Loan', addDays(today, 5), { payment_account_id: bank.id })
  await post(owner.token, `/accounts/${loan.id}/shares`, { email: editor.email, role: 'editor' })
  const { ctx, page, native, calls } = await newPage(browser)
  await uiLogin(page, editor)
  await openLoan(page, 'H Loan')
  check('(h) the editor sees the loan page', await page.locator('[data-testid="loan-due-dates"]').count(), 1)
  check('(h) and no Settlement control', await loanControl(page).count(), 0)
  check('(h) and no preview was asked for', calls.filter((c) => c.what === 'auto-post-preview').length, 0)
  const schedule = await get(editor.token, `/accounts/${loan.id}/loan-schedule`)
  check('(h) the editor\'s schedule carries no settlement', schedule.settlement ?? null, null)
  check('(h) the API answers the editor\'s preview and toggle with 404',
    [(await api(editor.token, 'GET', `/accounts/${loan.id}/auto-post-preview`)).status, (await api(editor.token, 'POST', `/accounts/${loan.id}/auto-post`, { enabled: true, expected_due: 0 })).status], [404, 404])
  checkNoNative('h', native)
  await ctx.close()
}

;(async () => {
  stack = await startLocalStack()
  API = `${stack.apiUrl}/api/v1`
  const browser = await chromium.launch()
  const run = (k) => !only || only === k
  const steps = { a: dashboardRows, b: toggles, c: catchUp, d: cancel, e: blocked, f: heldNotice, g: pageOpen, h: editorLoan }
  for (const [k, fn] of Object.entries(steps)) if (run(k)) await fn(browser)
  await browser.close()
  stack.stop()
  console.log(`\nRESULT: ${pass}/${total} assertions passed`)
  process.exit(pass === total ? 0 : 1)
})().catch((e) => { console.error(e); stack?.stop(); console.log(`\nRESULT (aborted): ${pass}/${total} assertions passed`); process.exit(1) })
