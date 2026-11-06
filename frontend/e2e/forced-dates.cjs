// Browser check for the forced-dates UI (settlement plan, PR 5): Change date on the
// "Due and overdue" card's entry rows (Due and Upcoming, Subscriptions) and on a loan's
// open due dates; the ForceDateDialog (date, Clear while forced, the server's reason
// inline); "(moved from ...)" on the dashboard; Mark paid opening on the effective date.
// Starts its own API and web app against a throwaway database (./_local_stack.cjs). Not
// wired into CI and not part of `pnpm build`. Run steps: see ./README.md.
//
// Scenarios (each seeds its own user, so each can run alone):
//   (a) Change date on a Due row moves it out of Due into Upcoming (identity stays the
//       scheduled day, the date reads "(moved from ...)"); on an Upcoming row it moves the
//       row's date; each is one PUT
//   (b) the dialog shows the server's refusal inline (a date over 31 days away) and stays
//       open; Clear puts the occurrence back on its scheduled day and in Due
//   (c) Mark paid opens on the effective date (forced a day earlier)
//   (d) the loan page lists the next three open due dates with Change date; moving one
//       reads "(moved from ...)", and the API's schedule agrees
//   (e) the dashboard shows "(moved from ...)" on a moved entry, not on an unmoved one
//   (f) roles: an editor changes a date from the card; a viewer has no Change date on the
//       card or on the loan page and the API answers a viewer's PUT with 404
//   (g) a card subscription moved past the statement close confirms "Now on the statement
//       closing ..." and the statement total in the dashboard payables moves
//   (h) a date inside a closed statement shows the server's reason in the dialog
//
// Every scenario checks that no browser dialog fired.
//
// Usage: node frontend/e2e/forced-dates.cjs [a|b|c|d|e|f|g|h]
const { startLocalStack } = require('./_local_stack.cjs')
const { useDueCheck, openDueTab, readTab, rowsOf, showRow } = require('./_due_pages.cjs')
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
useDueCheck(check)

// ─── Days (YYYY-MM-DD, UTC arithmetic) ───────────────────────────────────────
const manilaToday = () => new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10)
const addDays = (day, n) => {
  const d = new Date(`${day}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().slice(0, 10)
}
const wire = (day) => `${day}T00:00:00`
const dom = (day) => Number(day.slice(8, 10))
const suffix = (d) => (d % 100 >= 11 && d % 100 <= 13 ? 'th' : ['th', 'st', 'nd', 'rd'][d % 10] || 'th')
/** As the app shows a day: "Oct 25th, 2026". */
const fmt = (day) => {
  const d = new Date(`${day}T00:00:00Z`)
  const month = new Intl.DateTimeFormat('en-US', { month: 'short', timeZone: 'UTC' }).format(d)
  return `${month} ${d.getUTCDate()}${suffix(d.getUTCDate())}, ${d.getUTCFullYear()}`
}
const moved = (forced, scheduled) => `${fmt(forced)} (moved from ${fmt(scheduled)})`
/** The first day on or after `from` that is a statement close day (day of month `cycleDay`, at most 28). */
const closeOnOrAfter = (from, cycleDay) => {
  let d = from
  while (dom(d) !== cycleDay) d = addDays(d, 1)
  return d
}

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
/** Forces an occurrence's date through the API (a seed); throws on a refusal. */
async function force(u, entryId, day, to) {
  const r = await api(u.token, 'PUT', `/budget-entries/${entryId}/occurrences/${day}/date`, { effective_date: to })
  if (r.status >= 300) throw new Error(`force ${r.status} ${JSON.stringify(r.json)}`)
  return r.json
}

async function makeUser(tag) {
  const email = `e2e-fd-${tag}-${Math.random().toString(16).slice(2, 8)}@example.com`
  const password = 'E2eTest!2345'
  const reg = await api('', 'POST', '/auth/register', { email, password, first_name: `User${tag}`, last_name: 'Test', default_currency: 'PHP' })
  if (reg.status !== 200 && reg.status !== 201) throw new Error(`register ${reg.status} ${JSON.stringify(reg.json)}`)
  stack.verifyUser(email) // aborts the run unless psql reports UPDATE 1
  const login = await api('', 'POST', '/auth/login', { email, password })
  if (login.status !== 200) throw new Error(`login ${login.status}`)
  return { email, password, tag, token: login.json.access_token }
}
const account = (u, name, balance = 100000) =>
  post(u.token, '/accounts/', { name, account_type: 'checking', balance, currency: 'PHP' })
/** A PHP card closing on `cycleDay`, due `due` days later, paid from `bank`. */
const card = (u, bank, name, cycleDay, due) => post(u.token, '/accounts/', {
  name, account_type: 'credit', balance: 0, currency: 'PHP', credit_limit: 100000,
  billing_cycle_start: cycleDay, days_until_due_date: due, payment_account_id: bank.id,
})
const entry = (u, fields) => post(u.token, '/budget-entries/', { entry_type: 'expense', currency: 'PHP', cadence: 'monthly', ...fields })
const loanOf = (u, name, first) => post(u.token, '/accounts/', {
  name, account_type: 'loan', loan_kind: 'auto', balance: -100000, currency: 'PHP',
  loan_annual_rate: 12, loan_term_months: 24, loan_payment_amount: 5000, loan_first_payment_date: first,
})

async function newPage(browser) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 1400 }, timezoneId: 'Asia/Manila' })
  const page = await ctx.newPage()
  const native = trackNativeDialogs(page)
  const puts = []
  page.on('response', (r) => {
    const m = new URL(r.url()).pathname.match(/\/(?:occurrences|loan-due-dates)\/([\d-]+)\/date$/)
    if (m && ['PUT', 'DELETE'].includes(r.request().method())) puts.push({ method: r.request().method(), day: m[1], status: r.status(), body: JSON.parse(r.request().postData() || '{}') })
  })
  if (process.env.DEBUG) page.on('response', (r) => { if (r.url().includes('/api/v1/')) console.log(`    [net] ${r.request().method()} ${r.url().replace(API, '')} -> ${r.status()}`) })
  return { ctx, page, native, puts }
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
async function openTransactions(page) {
  await page.goto(`${stack.webUrl}/transactions`)
  await page.locator('[data-testid="due-section"]').waitFor()
  await page.locator('[data-testid="due-count"]').filter({ hasNotText: '…' }).waitFor()
  await page.locator('[data-testid="due-upcoming-count"]').filter({ hasNotText: '…' }).waitFor()
  await settle(page)
}
const checkNoNative = (scenario, native) => check(`(${scenario}) no browser dialog fired`, native.count, 0)
const dialog = (page) => page.locator('[data-testid="force-date-dialog"]')
const markPaidDialog = (page) => page.locator('[data-testid="mark-paid-dialog"]')

/** The entry's Due-tab rows (recurring or missed), over every page. */
const dueRowsOf = async (page, name) => (await rowsOf(page, name)).filter((r) => r.kind !== 'pending')
/** The Upcoming tab's occurrence rows of an entry: [day, date text]. */
async function upcomingOf(page, entryId, slug = 'upcoming') {
  await openDueTab(page, slug)
  const rows = []
  for (const r of await readTab(page, slug)) {
    if (r.kind === 'occurrence' && r.source === `budget_entry:${entryId}`) rows.push(r.day)
  }
  return rows
}
const upcomingRow = async (page, entryId, day, slug = 'upcoming') => {
  await openDueTab(page, slug)
  return showRow(page, page.locator(`[data-testid="due-row"][data-kind="occurrence"][data-source="budget_entry:${entryId}"][data-day="${day}"]`))
}
const dateText = (row) => row.locator('[data-testid="upcoming-occurrence-date"]').textContent().then((t) => t?.trim())

/** Opens the dialog from `button`, fills `day` and saves. Returns the PUT's status, or null when nothing opened. */
async function changeDate(page, button, day, puts) {
  await button.click()
  const shown = await dialog(page).waitFor({ timeout: 10000 }).then(() => true, () => false)
  check('Change date opened the dialog', shown, true)
  if (!shown) return null
  await waitQuiet(page)
  await dialog(page).locator('[data-testid="force-date-input"]').fill(day)
  const before = puts.length
  await dialog(page).locator('[data-testid="force-date-save"]').click()
  await page.waitForResponse((r) => r.request().method() === 'PUT' && /\/date$/.test(new URL(r.url()).pathname))
  await page.waitForTimeout(200)
  return puts.length > before ? puts[puts.length - 1].status : null
}

// (a) Change date moves a Due row to Upcoming; on an Upcoming row it moves the date.
async function dueAndUpcoming(browser) {
  console.log('\n=== (a) Change date on a Due row and on an Upcoming row')
  const today = manilaToday()
  const u = await makeUser('a')
  const bank = await account(u, 'A Checking')
  const rent = await entry(u, { name: 'A Rent', amount: 15000, account_id: bank.id, next_occurrence: wire(today) })
  const gym = await entry(u, { name: 'A Gym', amount: 800, account_id: bank.id, next_occurrence: wire(addDays(today, 10)) })
  const { ctx, page, native, puts } = await newPage(browser)
  await uiLogin(page, u)
  await openTransactions(page)

  check('(a) the rent is a Due row, with Change date', (await dueRowsOf(page, 'A Rent')).map((r) => [r.kind, r.buttons.includes('due-mark-paid')]), [['recurring', true]])
  const row = await showRow(page, page.locator('[data-testid="due-row"][data-source="budget_entry:' + rent.id + '"]'))
  const status = await changeDate(page, row.locator('[data-testid="row-change-date"]'), addDays(today, 3), puts)
  check('(a) the Due row saved with one PUT', [status, puts.length, puts[0]?.day, puts[0]?.body], [200, 1, today, { effective_date: addDays(today, 3) }])
  await dialog(page).waitFor({ state: 'detached' })
  await settle(page)
  check('(a) the rent left Due', (await dueRowsOf(page, 'A Rent')).length, 0)
  const moved1 = await upcomingRow(page, rent.id, today)
  check('(a) it is in Upcoming under its scheduled day, reading "(moved from ...)"', [await moved1.count(), await dateText(moved1)], [1, moved(addDays(today, 3), today)])
  const api1 = (await get(u.token, `/budget-entries/upcoming-occurrences?start_date=${addDays(today, 1)}T00:00:00Z&end_date=${addDays(today, 30)}T23:59:59.999999Z&limit=500`)).items.filter((o) => o.entry_id === rent.id && o.occurrence_date === today)
  check('(a) the API agrees: occurrence_date is scheduled, effective_date is forced', api1.map((o) => [o.occurrence_date, o.effective_date]), [[today, addDays(today, 3)]])

  const gymDay = addDays(today, 10)
  const gymRow = await upcomingRow(page, gym.id, gymDay)
  const before = puts.length
  const status2 = await changeDate(page, gymRow.locator('[data-testid="occurrence-change-date"]'), addDays(today, 12), puts)
  check('(a) the Upcoming row saved with one PUT', [status2, puts.length - before], [200, 1])
  await dialog(page).waitFor({ state: 'detached' })
  await settle(page)
  const gymMoved = await upcomingRow(page, gym.id, gymDay)
  check('(a) the Upcoming row now reads the new date', await dateText(gymMoved), moved(addDays(today, 12), gymDay))
  checkNoNative('a', native)
  await ctx.close()
}

// (b) The server's refusal shows inline; Clear restores the date.
async function refusalAndClear(browser) {
  console.log('\n=== (b) the dialog shows the server\'s refusal inline; Clear restores the date')
  const today = manilaToday()
  const u = await makeUser('b')
  const bank = await account(u, 'B Checking')
  const rent = await entry(u, { name: 'B Rent', amount: 15000, account_id: bank.id, next_occurrence: wire(today) })
  await force(u, rent.id, today, addDays(today, 3))
  const refused = await api(u.token, 'PUT', `/budget-entries/${rent.id}/occurrences/${today}/date`, { effective_date: addDays(today, 45) })
  check('(b) control: the API refuses a date 45 days out with a plain-text reason', [refused.status, typeof refused.json.detail], [422, 'string'])
  const { ctx, page, native, puts } = await newPage(browser)
  await uiLogin(page, u)
  await openTransactions(page)

  const row = await upcomingRow(page, rent.id, today)
  const status = await changeDate(page, row.locator('[data-testid="occurrence-change-date"]'), addDays(today, 45), puts)
  check('(b) the PUT was refused', status, 422)
  const error = dialog(page).locator('[data-testid="force-date-error"]')
  await error.waitFor()
  check('(b) the dialog stays open and shows the server\'s reason', [await dialog(page).count(), (await error.textContent())?.trim()], [1, refused.json.detail])
  check('(b) the dialog offers Clear while the date is forced', await dialog(page).locator('[data-testid="force-date-clear"]').count(), 1)

  const before = puts.length
  await dialog(page).locator('[data-testid="force-date-clear"]').click()
  await dialog(page).waitFor({ state: 'detached' })
  await settle(page)
  check('(b) Clear sent one DELETE for the scheduled day', puts.slice(before).map((p) => [p.method, p.day, p.status]), [['DELETE', today, 204]])
  check('(b) the rent is back in Due', (await dueRowsOf(page, 'B Rent')).length, 1)
  check('(b) and out of Upcoming', (await upcomingOf(page, rent.id)).includes(today), false)
  const listed = (await get(u.token, `/budget-entries/${rent.id}/occurrences`)).occurrences.find((o) => o.occurrence_date === today)
  check('(b) the API reads the scheduled day again', listed.effective_date, today)
  checkNoNative('b', native)
  await ctx.close()
}

// (c) Mark paid opens on the effective date.
async function markPaidDate(browser) {
  console.log('\n=== (c) Mark paid opens on the effective date')
  const today = manilaToday()
  const u = await makeUser('c')
  const bank = await account(u, 'C Checking')
  const water = await entry(u, { name: 'C Water', amount: 900, account_id: bank.id, next_occurrence: wire(today) })
  const yesterday = addDays(today, -1)
  await force(u, water.id, today, yesterday)
  const { ctx, page, native } = await newPage(browser)
  await uiLogin(page, u)
  await openTransactions(page)
  const rows = await dueRowsOf(page, 'C Water')
  check('(c) the water bill is listed in Due, forced a day earlier', rows.length, 1)
  const row = await showRow(page, page.locator(`[data-testid="due-row"][data-source="budget_entry:${water.id}"]`))
  await row.locator('[data-testid="due-mark-paid"]').click()
  await markPaidDialog(page).locator('[data-testid="mark-paid-occurrence"]').waitFor()
  await waitQuiet(page)
  check('(c) the dialog opens on the scheduled day as the occurrence', await markPaidDialog(page).locator('[data-testid="mark-paid-occurrence"]').inputValue(), today)
  check('(c) and its date on the effective day', await markPaidDialog(page).locator('[data-testid="mark-paid-date"]').inputValue(), yesterday)
  checkNoNative('c', native)
  await ctx.close()
}

/** Opens a loan's actions modal on the Accounts page. */
async function openLoan(page, name) {
  await page.goto(`${stack.webUrl}/accounts`)
  await page.locator('article').first().waitFor()
  await settle(page)
  await page.locator('article').filter({ has: page.getByText(name, { exact: true }) }).locator('[role="button"]').first().click()
  await page.locator('[data-testid="loan-due-dates"]').waitFor()
  await waitQuiet(page)
}

// (d) The loan page lists the next three open due dates with Change date.
async function loanPage(browser) {
  console.log('\n=== (d) the loan page lists the next three open due dates, each with Change date')
  const today = manilaToday()
  const u = await makeUser('d')
  const first = addDays(today, 5)
  const loan = await loanOf(u, 'D Car loan', first)
  const { ctx, page, native, puts } = await newPage(browser)
  await uiLogin(page, u)
  await openLoan(page, 'D Car loan')
  const rows = page.locator('[data-testid="loan-due-date"]')
  check('(d) three open due dates are listed, the first on its scheduled day', [await rows.count(), await rows.first().getAttribute('data-day')], [3, first])
  check('(d) each has Change date', await page.locator('[data-testid="loan-change-date"]').count(), 3)
  const status = await changeDate(page, rows.first().locator('[data-testid="loan-change-date"]'), addDays(first, 2), puts)
  check('(d) one PUT to the loan due-date route', [status, puts[0]?.day], [200, first])
  await dialog(page).waitFor({ state: 'detached' })
  await settle(page)
  check('(d) the first due date reads "(moved from ...)"', (await rows.first().locator('[data-testid="loan-due-date-text"]').textContent())?.trim(), moved(addDays(first, 2), first))
  const schedule = await get(u.token, `/accounts/${loan.id}/loan-schedule`)
  check('(d) the API schedule agrees', [schedule.upcoming[0].due_date, schedule.upcoming[0].effective_date, schedule.next_due_effective_date], [first, addDays(first, 2), addDays(first, 2)])
  // A refusal (a date 40 days out) shows inline and Clear restores it.
  const refused = await changeDate(page, rows.first().locator('[data-testid="loan-change-date"]'), addDays(first, 40), puts)
  check('(d) a date out of reach is refused and the reason shown inline', [refused, ((await dialog(page).locator('[data-testid="force-date-error"]').textContent()) ?? '').trim() !== ''], [422, true])
  await dialog(page).locator('[data-testid="force-date-clear"]').click()
  await dialog(page).waitFor({ state: 'detached' })
  await settle(page)
  check('(d) Clear puts the first due date back', (await rows.first().locator('[data-testid="loan-due-date-text"]').textContent())?.trim(), fmt(first))
  checkNoNative('d', native)
  await ctx.close()
}

// (e) The dashboard shows "(moved from ...)".
async function dashboard(browser) {
  console.log('\n=== (e) the dashboard shows "(moved from ...)" on a moved entry; a moved loan due date shows its new date')
  const today = manilaToday()
  const u = await makeUser('e')
  const bank = await account(u, 'E Checking')
  const rent = await entry(u, { name: 'E Rent', amount: 15000, account_id: bank.id, next_occurrence: wire(addDays(today, 4)) })
  await entry(u, { name: 'E Plain', amount: 700, account_id: bank.id, next_occurrence: wire(addDays(today, 5)) })
  await force(u, rent.id, addDays(today, 4), addDays(today, 7))
  const { ctx, page, native } = await newPage(browser)
  await uiLogin(page, u)
  const rows = page.locator('[data-testid="payable-row"]')
  const rentRow = rows.filter({ hasText: 'E Rent' })
  check('(e) the rent reads its new date and where it moved from', (await rentRow.locator('[data-testid="payable-moved"]').textContent())?.trim(), `(moved from ${fmt(addDays(today, 4))})`)
  check('(e) the rent\'s date is the forced one', ((await rentRow.first().textContent()) ?? '').includes(fmt(addDays(today, 7))), true)
  check('(e) an unmoved payable says nothing', await rows.filter({ hasText: 'E Plain' }).locator('[data-testid="payable-moved"]').count(), 0)
  checkNoNative('e', native)
  await ctx.close()
}

// (f) Roles.
async function roles(browser) {
  console.log('\n=== (f) an editor changes a date; a viewer has no action')
  const today = manilaToday()
  const owner = await makeUser('f-owner')
  const editor = await makeUser('f-editor')
  const viewer = await makeUser('f-viewer')
  const stranger = await makeUser('f-stranger')
  const bank = await account(owner, 'F Joint')
  await post(owner.token, `/accounts/${bank.id}/shares`, { email: editor.email, role: 'editor' })
  await post(owner.token, `/accounts/${bank.id}/shares`, { email: viewer.email, role: 'viewer' })
  const rent = await entry(owner, { name: 'F Rent', amount: 15000, account_id: bank.id, next_occurrence: wire(addDays(today, 2)) })
  const loan = await loanOf(owner, 'F Loan', addDays(today, 5))
  await post(owner.token, `/accounts/${loan.id}/shares`, { email: viewer.email, role: 'viewer' })

  const e = await newPage(browser)
  await uiLogin(e.page, editor)
  await openTransactions(e.page)
  const row = await upcomingRow(e.page, rent.id, addDays(today, 2))
  check('(f) the editor sees Change date on the shared occurrence', await row.locator('[data-testid="occurrence-change-date"]').count(), 1)
  const status = await changeDate(e.page, row.locator('[data-testid="occurrence-change-date"]'), addDays(today, 4), e.puts)
  check('(f) the editor\'s change is saved', status, 200)
  await dialog(e.page).waitFor({ state: 'detached' })
  checkNoNative('f', e.native)
  await e.ctx.close()
  const after = (await get(owner.token, `/budget-entries/${rent.id}/occurrences`)).occurrences.find((o) => o.occurrence_date === addDays(today, 2))
  check('(f) the owner sees the editor\'s forced date', after.effective_date, addDays(today, 4))

  const v = await newPage(browser)
  await uiLogin(v.page, viewer)
  await openTransactions(v.page)
  check('(f) the viewer has no Change date on the card', await v.page.locator('[data-testid="occurrence-change-date"], [data-testid="row-change-date"]').count(), 0)
  await openLoan(v.page, 'F Loan')
  check('(f) the viewer sees the loan\'s due dates', await v.page.locator('[data-testid="loan-due-date"]').count() > 0, true)
  check('(f) and no Change date on them', await v.page.locator('[data-testid="loan-change-date"]').count(), 0)
  checkNoNative('f', v.native)
  await v.ctx.close()
  const body = { effective_date: addDays(today, 3) }
  check('(f) a viewer\'s and a stranger\'s PUT is a 404',
    [(await api(viewer.token, 'PUT', `/budget-entries/${rent.id}/occurrences/${addDays(today, 2)}/date`, body)).status,
      (await api(stranger.token, 'PUT', `/budget-entries/${rent.id}/occurrences/${addDays(today, 2)}/date`, body)).status,
      (await api(viewer.token, 'PUT', `/accounts/${loan.id}/loan-due-dates/${addDays(today, 5)}/date`, body)).status],
    [404, 404, 404])
}

// (g) A card subscription moved past the close confirms its statement.
async function cardStatement(browser) {
  console.log('\n=== (g) a card subscription moved past the close confirms the statement it falls on')
  const today = manilaToday()
  const u = await makeUser('g')
  const bank = await account(u, 'G Checking')
  const cycleDay = Math.min(28, dom(addDays(today, 12)))
  const close = closeOnOrAfter(today, cycleDay)
  const visa = await card(u, bank, 'G Visa', cycleDay, 5)
  const day = addDays(today, 2)
  const forcedTo = addDays(close, 2)
  const spotify = await entry(u, { name: 'G Spotify', amount: 500, account_id: visa.id, next_occurrence: wire(day) })
  // A recorded charge in the open cycle makes it a statement payable; the subscription adds to its total.
  await post(u.token, '/transactions/', { account_id: visa.id, transaction_type: 'debit', amount: 1000, description: 'G Lunch', transaction_date: wire(today), is_posted: true })
  console.log(`    cycle day ${cycleDay}, close ${close}, charge ${day} -> ${forcedTo}`)
  const { ctx, page, native, puts } = await newPage(browser)
  await uiLogin(page, u)
  const statementRows = () => page.locator('[data-testid="payable-row"]').filter({ hasText: 'G Visa' })
  const amountOf = async () => (await statementRows().locator('[data-testid="payable-amount"]').first().textContent().catch(() => null))?.replace(/[^0-9.]/g, '') ?? null
  check('(g) before: the statement\'s payable totals the lunch and the subscription', await amountOf(), '1500.00')
  await openTransactions(page)
  const row = await upcomingRow(page, spotify.id, day, 'subscriptions')
  check('(g) the subscription row has Change date', await row.locator('[data-testid="occurrence-change-date"]').count(), 1)
  const status = await changeDate(page, row.locator('[data-testid="occurrence-change-date"]'), forcedTo, puts)
  check('(g) the change was saved', status, 200)
  const confirmation = dialog(page).locator('[data-testid="force-date-confirmation"]')
  await confirmation.waitFor()
  const text = (await confirmation.textContent())?.trim() ?? ''
  const match = text.match(/^Now on the statement closing (.+)$/)
  check('(g) the dialog confirms the statement', match !== null, true)
  const nextClose = (await api(u.token, 'GET', `/accounts/${visa.id}/statements`)).json
  console.log(`    confirmation: ${text}; statements: ${JSON.stringify(nextClose).slice(0, 200)}`)
  check('(g) the confirmed close is after the forced date', match ? new Date(match[1].replace(/(\d+)(st|nd|rd|th)/, '$1')).getTime() >= new Date(`${forcedTo}T00:00:00Z`).getTime() - 86400000 : false, true)
  await dialog(page).locator('[data-testid="force-date-close"]').click()
  await dialog(page).waitFor({ state: 'detached' })
  await settle(page)
  await page.goto(`${stack.webUrl}/`)
  await page.locator('[data-testid="payables"], [data-onboarding="upcoming-expenses"]').first().waitFor()
  await settle(page)
  check('(g) after: the statement\'s payable total no longer holds the subscription', await amountOf(), '1000.00')
  checkNoNative('g', native)
  await ctx.close()
}

// (h) A closed statement's reason shows in the dialog.
async function closedStatement(browser) {
  console.log('\n=== (h) a date inside a closed statement shows the server\'s reason')
  const today = manilaToday()
  const u = await makeUser('h')
  const bank = await account(u, 'H Checking')
  const cycleDay = Math.min(28, dom(addDays(today, -3)))
  const visa = await card(u, bank, 'H Visa', cycleDay, 21)
  const day = addDays(today, 2)
  const inClosed = addDays(today, -10)
  const spotify = await entry(u, { name: 'H Spotify', amount: 500, account_id: visa.id, next_occurrence: wire(day) })
  const refused = await api(u.token, 'PUT', `/budget-entries/${spotify.id}/occurrences/${day}/date`, { effective_date: inClosed })
  check('(h) control: the API refuses a date in a closed statement with a plain-text reason', [refused.status, typeof refused.json.detail], [422, 'string'])
  const { ctx, page, native, puts } = await newPage(browser)
  await uiLogin(page, u)
  await openTransactions(page)
  const row = await upcomingRow(page, spotify.id, day, 'subscriptions')
  const status = await changeDate(page, row.locator('[data-testid="occurrence-change-date"]'), inClosed, puts)
  check('(h) the PUT was refused', status, 422)
  const error = dialog(page).locator('[data-testid="force-date-error"]')
  await error.waitFor()
  check('(h) the dialog shows the reason and stays open', [(await error.textContent())?.trim(), await dialog(page).count()], [refused.json.detail, 1])
  checkNoNative('h', native)
  await ctx.close()
}

;(async () => {
  stack = await startLocalStack()
  API = `${stack.apiUrl}/api/v1`
  const browser = await chromium.launch()
  const run = (k) => !only || only === k
  const steps = { a: dueAndUpcoming, b: refusalAndClear, c: markPaidDate, d: loanPage, e: dashboard, f: roles, g: cardStatement, h: closedStatement }
  for (const [k, fn] of Object.entries(steps)) if (run(k)) await fn(browser)
  await browser.close()
  stack.stop()
  console.log(`\nRESULT: ${pass}/${total} assertions passed`)
  process.exit(pass === total ? 0 : 1)
})().catch((e) => { console.error(e); stack?.stop(); console.log(`\nRESULT (aborted): ${pass}/${total} assertions passed`); process.exit(1) })
