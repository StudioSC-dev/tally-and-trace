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
//   (c) Mark paid opens on the effective date (forced a day earlier; forced into the future)
//   (d) the loan page lists the next three open due dates with Change date; moving one
//       reads "(moved from ...)", and the API's schedule agrees
//   (e) the dashboard shows "(moved from ...)" on a moved entry and a moved loan due date, not on an unmoved one
//   (f) roles: an editor changes a date from the card; a viewer has no Change date on the
//       card or on the loan page and the API answers a viewer's PUT with 404
//   (g) a card subscription moved past the statement close confirms "Now on the statement
//       closing ..." and the statement total in the dashboard payables moves
//   (h) a date inside a closed statement shows the server's reason in the dialog
//   (i) an installment's plan row on the Installments tab reads "Next charge" on the effective date
//       with "(moved from ...)" once its occurrence is moved (the API's `next_charge` stays the
//       scheduled day, `effective_date` is the forced one), and back on the scheduled day after Clear
//   (j) a missed row's Change date: an owner and an editor have it, a view-only viewer gets no missed row
//       and no button; it opens on the oldest unlinked missed day with its forced date pre-filled; a future
//       date is refused (the server keeps the occurrences in order, so the count stays); another past day
//       keeps the row missed and "since" reads that day; Clear restores the original row
//   (k) a missed row with one occurrence: moved into the future it leaves the missed list and is an
//       Upcoming row "(moved from ...)"; Clear from that row brings the missed row back
//   (l) the Subscriptions tab's missed row (a card subscription) has Change date; moved into the future
//       it leaves the missed row and reads "(moved from ...)" there; Clear restores it
//
// Every scenario checks that no browser dialog fired.
//
// Usage: node frontend/e2e/forced-dates.cjs [a|b|c|d|e|f|g|h|i|j|k|l]
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
const loanOf = (u, name, first, extra = {}) => post(u.token, '/accounts/', {
  name, account_type: 'loan', loan_kind: 'auto', balance: -100000, currency: 'PHP',
  loan_annual_rate: 12, loan_term_months: 24, loan_payment_amount: 5000, loan_first_payment_date: first, ...extra,
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
  await page.keyboard.press('Escape')
  await markPaidDialog(page).waitFor({ state: 'detached' })

  // A future forced cash row opens on its forced date too, not today; the backend records it there.
  const gas = await entry(u, { name: 'C Gas', amount: 1200, account_id: bank.id, next_occurrence: wire(addDays(today, 10)) })
  const gasDay = addDays(today, 14)
  await force(u, gas.id, addDays(today, 10), gasDay)
  await openTransactions(page)
  await openDueTab(page, 'upcoming')
  const gasRow = await showRow(page, page.locator(`[data-testid="due-row"][data-kind="occurrence"][data-source="budget_entry:${gas.id}"][data-day="${addDays(today, 10)}"]`))
  await gasRow.locator('[data-testid="upcoming-mark-paid"]').click()
  await markPaidDialog(page).locator('[data-testid="mark-paid-occurrence"]').waitFor()
  await waitQuiet(page)
  check('(c) a future forced row opens on its forced date, not today', await markPaidDialog(page).locator('[data-testid="mark-paid-date"]').inputValue(), gasDay)
  const done = page.waitForResponse((r) => r.request().method() === 'POST' && /\/materialize$/.test(new URL(r.url()).pathname))
  await markPaidDialog(page).locator('[data-testid="mark-paid-submit"]').click()
  const res = await done
  check('(c) the backend accepts the future date on record (201)', res.status(), 201)
  const recorded = (await get(u.token, '/transactions/?limit=100')).items.find((t) => t.budget_entry_id === gas.id)
  console.log(`    recorded: ${JSON.stringify({ date: recorded?.transaction_date, is_posted: recorded?.is_posted, occurrence_date: recorded?.occurrence_date })}`)
  check('(c) the row is posted and dated on the forced day', [recorded?.transaction_date?.slice(0, 10), recorded?.is_posted], [gasDay, true])
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
  console.log('\n=== (e) the dashboard shows "(moved from ...)" on a moved entry and a moved loan due date')
  const today = manilaToday()
  const u = await makeUser('e')
  const bank = await account(u, 'E Checking')
  const rent = await entry(u, { name: 'E Rent', amount: 15000, account_id: bank.id, next_occurrence: wire(addDays(today, 4)) })
  const loan = await loanOf(u, 'E Loan', addDays(today, 6), { payment_account_id: bank.id })
  const forcedLoan = await api(u.token, 'PUT', `/accounts/${loan.id}/loan-due-dates/${addDays(today, 6)}/date`, { effective_date: addDays(today, 8) })
  check('(e) seed: the loan due date is forced', forcedLoan.status, 200)
  await entry(u, { name: 'E Plain', amount: 700, account_id: bank.id, next_occurrence: wire(addDays(today, 5)) })
  await force(u, rent.id, addDays(today, 4), addDays(today, 7))
  const { ctx, page, native } = await newPage(browser)
  await uiLogin(page, u)
  const rows = page.locator('[data-testid="payable-row"]')
  const rentRow = rows.filter({ hasText: 'E Rent' })
  check('(e) the rent reads its new date and where it moved from', (await rentRow.locator('[data-testid="payable-moved"]').textContent())?.trim(), `(moved from ${fmt(addDays(today, 4))})`)
  check('(e) the rent\'s date is the forced one', ((await rentRow.first().textContent()) ?? '').includes(fmt(addDays(today, 7))), true)
  const loanRow = rows.filter({ hasText: 'E Loan' }).first()
  check('(e) the loan reads its forced date and where it moved from',
    [((await loanRow.textContent()) ?? '').includes(fmt(addDays(today, 8))), (await loanRow.locator('[data-testid="payable-moved"]').textContent())?.trim()],
    [true, `(moved from ${fmt(addDays(today, 6))})`])
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

// (i) An installment's plan row reads its next charge on the effective date.
async function installmentPlanRow(browser) {
  console.log('\n=== (i) an installment\'s Next charge reads the effective date once its occurrence is moved')
  const today = manilaToday()
  const u = await makeUser('i')
  const bank = await account(u, 'I Checking')
  // A card installment is stored on its statement close (768a9b9): close the card on the entry's own day.
  const start = addDays(today, 3)
  const visa = await card(u, bank, 'I Visa', Math.min(28, dom(start)), 21)
  const plan = await entry(u, { name: 'I Sofa', amount: 1000, account_id: visa.id, next_occurrence: wire(start), end_mode: 'after_occurrences', max_occurrences: 4 })
  const scheduled = plan.next_occurrence.slice(0, 10)
  const forcedTo = addDays(scheduled, 5)
  const planOf = async () => (await get(u.token, '/budget-entries/installment-plans')).items.find((p) => p.entry_id === plan.id)
  check('(i) the API reads the scheduled day before a move', [(await planOf()).next_charge, (await planOf()).effective_date], [scheduled, scheduled])
  const { ctx, page, native, puts } = await newPage(browser)
  await uiLogin(page, u)
  await openTransactions(page)
  const planRow = async () => {
    const rows = (await readTab(page, 'installments')).filter((r) => r.kind === 'installment' && r.source === `budget_entry:${plan.id}`)
    return rows
  }
  const nextTextOf = (rows) => rows.map((r) => r.text.match(/Next charge (.*?)(?: · |$)/)?.[1]?.trim())
  check('(i) before: the plan reads the scheduled day', nextTextOf(await planRow()), [fmt(scheduled)])

  const row = await showRow(page, page.locator(`[data-testid="due-row"][data-kind="installment"][data-source="budget_entry:${plan.id}"]`))
  const status = await changeDate(page, row.locator('[data-testid="row-change-date"]'), forcedTo, puts)
  check('(i) Change date on the plan row saved with one PUT for the scheduled day', [status, puts.length, puts[0]?.day], [200, 1, scheduled])
  const confirmation = dialog(page).locator('[data-testid="force-date-confirmation"]')
  if (await confirmation.count()) await dialog(page).locator('[data-testid="force-date-close"]').click()
  await dialog(page).waitFor({ state: 'detached' })
  await settle(page)
  const moved1 = await planOf()
  check('(i) the API keeps next_charge on the scheduled day and gives the forced one as effective_date', [moved1.next_charge, moved1.effective_date], [scheduled, forcedTo])
  const rows = await planRow()
  check('(i) after the move: the plan reads the effective date, as the Due rows do', nextTextOf(rows), [moved(forcedTo, scheduled)])
  check('(i) the row is still keyed on the scheduled day', rows.map((r) => r.day), [scheduled])

  const reopened = await showRow(page, page.locator(`[data-testid="due-row"][data-kind="installment"][data-source="budget_entry:${plan.id}"]`))
  await reopened.locator('[data-testid="row-change-date"]').click()
  await dialog(page).locator('[data-testid="force-date-clear"]').waitFor()
  const before = puts.length
  await dialog(page).locator('[data-testid="force-date-clear"]').click()
  await dialog(page).waitFor({ state: 'detached' })
  await settle(page)
  check('(i) Clear sent one DELETE for the scheduled day', puts.slice(before).map((p) => [p.method, p.day, p.status]), [['DELETE', scheduled, 204]])
  check('(i) after Clear: the plan reads the scheduled day again', nextTextOf(await planRow()), [fmt(scheduled)])
  checkNoNative('i', native)
  await ctx.close()
}

// ─── Missed rows (j, k, l) ───────────────────────────────────────────────────
const missedRowOf = (page, entryId) => page.locator(`[data-testid="due-row"][data-kind="missed"][data-source="budget_entry:${entryId}"]`)
const missedText = async (page, entryId) => {
  const row = missedRowOf(page, entryId)
  if ((await row.count()) === 0) return null
  return (await row.locator('[data-testid="due-missed-text"]').textContent())?.replace(/\s+/g, ' ').trim() ?? null
}
const changeButtonOf = (page, entryId) => missedRowOf(page, entryId).locator('[data-testid="row-change-date"]')
/**
 * Fills the open dialog with `day`, saves and returns the PUT. After a refusal the first fill
 * is not taken by the dialog (the refusal stays and the field is put back), so it fills again until the refusal clears.
 */
async function saveInDialog(page, day, puts) {
  const before = puts.length
  const input = dialog(page).locator('[data-testid="force-date-input"]')
  const error = dialog(page).locator('[data-testid="force-date-error"]')
  for (let i = 0; i < 4; i++) {
    await input.fill(day)
    await page.waitForTimeout(300)
    // The dialog took the change when its refusal went away with it.
    if ((await input.inputValue()) === day && (await error.count()) === 0) break
  }
  await dialog(page).locator('[data-testid="force-date-save"]').click()
  await page.waitForResponse((r) => r.request().method() === 'PUT' && /\/date$/.test(new URL(r.url()).pathname))
  await page.waitForTimeout(200)
  return puts.slice(before)[0] ?? null
}
const missedOf = async (u, entryId) => {
  const snap = await get(u.token, '/dashboard/snapshot')
  return [...snap.missed, ...snap.card_charges.flatMap((c) => c.missed)].find((m) => m.entry_id === entryId) ?? null
}

// (j) Change date on a missed row: permission, pre-fill, refusal, a past day, Clear.
async function missedRowChangeDate(browser) {
  console.log('\n=== (j) a missed row\'s Change date: permission, pre-fill, refusal, a past day, Clear')
  const today = manilaToday()
  const owner = await makeUser('j-owner')
  const viewer = await makeUser('j-viewer')
  const editor = await makeUser('j-editor')
  const bank = await account(owner, 'J Joint')
  await post(owner.token, `/accounts/${bank.id}/shares`, { email: editor.email, role: 'editor' })
  await post(owner.token, `/accounts/${bank.id}/shares`, { email: viewer.email, role: 'viewer' })
  const oldest = addDays(today, -14)
  const second = addDays(today, -7)
  const rent = await entry(owner, { name: 'J Rent', cadence: 'weekly', amount: 100, account_id: bank.id, next_occurrence: wire(oldest) })
  const seeded = addDays(today, -13)
  await force(owner, rent.id, oldest, seeded)
  const m0 = await missedOf(owner, rent.id)
  check('(j) setup: two missed occurrences, the oldest forced', [m0?.unlinked_count, m0?.oldest_unlinked, m0?.oldest_effective], [2, oldest, seeded])

  const { ctx, page, native, puts } = await newPage(browser)
  await uiLogin(page, owner)
  await openTransactions(page)
  await showRow(page, missedRowOf(page, rent.id))
  check('(j) the owner\'s missed row has Change date, once', await changeButtonOf(page, rent.id).count(), 1)
  check('(j) the row reads the oldest\'s forced date and the count', await missedText(page, rent.id), `2 missed since ${fmt(seeded)}`)

  await changeButtonOf(page, rent.id).click()
  await dialog(page).waitFor({ timeout: 10000 })
  await waitQuiet(page)
  const input = dialog(page).locator('[data-testid="force-date-input"]')
  check('(j) the dialog opens for the oldest day, its forced date pre-filled', [(await dialog(page).locator('[data-testid="force-date-scheduled"]').textContent())?.replace(/\s+/g, ' ').trim(), await input.inputValue()], [`Scheduled ${fmt(oldest)} · now ${fmt(seeded)}`, seeded])
  check('(j) Clear is offered while it is forced', await dialog(page).locator('[data-testid="force-date-clear"]').count(), 1)

  const future = addDays(today, 2)
  const refused = await saveInDialog(page, future, puts)
  check('(j) a future date is sent for the oldest day and refused by the server', [refused?.day, refused?.body, refused?.status], [oldest, { effective_date: future }, 422])
  const error = dialog(page).locator('[data-testid="force-date-error"]')
  await error.waitFor()
  check('(j) the dialog stays open with the server\'s reason', [await dialog(page).count(), ((await error.textContent()) ?? '').trim().length > 0], [1, true])

  const toPast = addDays(today, -10)
  const saved = await saveInDialog(page, toPast, puts)
  check('(j) another past day is sent for the oldest day and saved', [saved?.day, saved?.body, saved?.status], [oldest, { effective_date: toPast }, 200])
  await dialog(page).waitFor({ state: 'detached' })
  await settle(page)
  check('(j) the row is still missed, its count unchanged and "since" on the new day', await missedText(page, rent.id), `2 missed since ${fmt(toPast)}`)
  const m1 = await missedOf(owner, rent.id)
  check('(j) the API agrees', [m1?.unlinked_count, m1?.oldest_unlinked, m1?.oldest_effective], [2, oldest, toPast])
  check('(j) the entry still has exactly one missed row', (await dueRowsOf(page, 'J Rent')).filter((r) => r.kind === 'missed').length, 1)

  await changeButtonOf(page, rent.id).click()
  await dialog(page).locator('[data-testid="force-date-clear"]').waitFor()
  check('(j) reopened, it is pre-filled with the new day', await dialog(page).locator('[data-testid="force-date-input"]').inputValue(), toPast)
  const before = puts.length
  await dialog(page).locator('[data-testid="force-date-clear"]').click()
  await dialog(page).waitFor({ state: 'detached' })
  await settle(page)
  check('(j) Clear sends one DELETE for the oldest day', puts.slice(before).map((p) => [p.method, p.day, p.status]), [['DELETE', oldest, 204]])
  check('(j) the original row is back', await missedText(page, rent.id), `2 missed since ${fmt(oldest)}`)
  check('(j) the second missed day is untouched', (await get(owner.token, `/budget-entries/${rent.id}/occurrences`)).occurrences.filter((o) => o.occurrence_date === second).map((o) => o.effective_date ?? o.occurrence_date), [second])
  checkNoNative('j', native)
  await ctx.close()

  const ed = await newPage(browser)
  await uiLogin(ed.page, editor)
  await openTransactions(ed.page)
  await showRow(ed.page, missedRowOf(ed.page, rent.id))
  check('(j) an editor sees the missed row with Change date', [await missedText(ed.page, rent.id), await changeButtonOf(ed.page, rent.id).count()], [`2 missed since ${fmt(oldest)}`, 1])
  check('(j) the API gives the editor can_mark_paid true', (await missedOf(editor, rent.id))?.can_mark_paid, true)
  checkNoNative('j', ed.native)
  await ed.ctx.close()

  const vw = await newPage(browser)
  await uiLogin(vw.page, viewer)
  await openTransactions(vw.page)
  check('(j) the viewer has no missed row for it (a view-only share gets Limited rows) and no Change date anywhere', [await missedRowOf(vw.page, rent.id).count(), await vw.page.locator('[data-testid="row-change-date"]').count()], [0, 0])
  check('(j) the API lists no missed entry for the viewer', await missedOf(viewer, rent.id), null)
  checkNoNative('j', vw.native)
  await vw.ctx.close()
}

// (k) A single missed occurrence moved into the future becomes an Upcoming row; Clear brings the row back.
async function missedRowFuture(browser) {
  console.log('\n=== (k) the only missed occurrence moved into the future is an Upcoming row; Clear restores the missed row')
  const today = manilaToday()
  const u = await makeUser('k')
  const bank = await account(u, 'K Checking')
  const oldest = addDays(today, -3)
  const gym = await entry(u, { name: 'K Gym', cadence: 'weekly', amount: 800, account_id: bank.id, next_occurrence: wire(oldest) })
  const { ctx, page, native, puts } = await newPage(browser)
  await uiLogin(page, u)
  await openTransactions(page)
  await showRow(page, missedRowOf(page, gym.id))
  check('(k) before: one missed row', await missedText(page, gym.id), `1 missed since ${fmt(oldest)}`)
  await changeButtonOf(page, gym.id).click()
  await dialog(page).waitFor({ timeout: 10000 })
  await waitQuiet(page)
  check('(k) the dialog opens on the scheduled day with nothing forced',
    [(await dialog(page).locator('[data-testid="force-date-scheduled"]').textContent())?.replace(/\s+/g, ' ').trim(), await dialog(page).locator('[data-testid="force-date-input"]').inputValue(), await dialog(page).locator('[data-testid="force-date-clear"]').count()],
    [`Scheduled ${fmt(oldest)}`, oldest, 0])
  const to = addDays(today, 2)
  const saved = await saveInDialog(page, to, puts)
  check('(k) the PUT names the oldest day and the new date', [saved?.day, saved?.body, saved?.status], [oldest, { effective_date: to }, 200])
  await dialog(page).waitFor({ state: 'detached' })
  await settle(page)
  check('(k) the missed row is gone', await missedRowOf(page, gym.id).count(), 0)
  check('(k) nothing of the entry is left in Due', (await dueRowsOf(page, 'K Gym')).length, 0)
  const row = await upcomingRow(page, gym.id, oldest)
  check('(k) it is an Upcoming row on its new date reading "(moved from ...)"', [await row.count(), await dateText(row)], [1, moved(to, oldest)])

  const before = puts.length
  await row.locator('[data-testid="occurrence-change-date"]').click()
  await dialog(page).locator('[data-testid="force-date-clear"]').waitFor()
  await dialog(page).locator('[data-testid="force-date-clear"]').click()
  await dialog(page).waitFor({ state: 'detached' })
  await settle(page)
  check('(k) Clear sends one DELETE for the scheduled day', puts.slice(before).map((p) => [p.method, p.day, p.status]), [['DELETE', oldest, 204]])
  await openDueTab(page, 'due')
  await showRow(page, missedRowOf(page, gym.id))
  check('(k) the missed row is back', await missedText(page, gym.id), `1 missed since ${fmt(oldest)}`)
  checkNoNative('k', native)
  await ctx.close()
}

// (l) The Subscriptions tab's missed row.
async function missedRowSubscription(browser) {
  console.log('\n=== (l) the Subscriptions tab\'s missed row has Change date')
  const today = manilaToday()
  const u = await makeUser('l')
  const bank = await account(u, 'L Checking')
  const cycleDay = Math.min(28, dom(addDays(today, 12)))
  const visa = await card(u, bank, 'L Visa', cycleDay, 5)
  const oldest = addDays(today, -4)
  const spotify = await entry(u, { name: 'L Spotify', amount: 500, account_id: visa.id, next_occurrence: wire(oldest) })
  const m0 = await missedOf(u, spotify.id)
  check('(l) setup: one missed month on the card', [m0?.unlinked_count, m0?.oldest_unlinked], [1, oldest])
  const { ctx, page, native, puts } = await newPage(browser)
  await uiLogin(page, u)
  await openTransactions(page)
  await openDueTab(page, 'subscriptions')
  const row = await showRow(page, missedRowOf(page, spotify.id))
  check('(l) the row is on the Subscriptions tab, with Change date', [await row.getAttribute('data-plan'), await row.locator('[data-testid="row-change-date"]').count()], ['subscription', 1])
  const to = addDays(today, 2)
  await row.locator('[data-testid="row-change-date"]').click()
  await dialog(page).waitFor({ timeout: 10000 })
  await waitQuiet(page)
  check('(l) the dialog opens for the oldest missed day (the card row carries no forced date, so the dialog looks it up)', (await dialog(page).locator('[data-testid="force-date-scheduled"]').textContent())?.replace(/\s+/g, ' ').trim(), `Scheduled ${fmt(oldest)}`)
  const saved = await saveInDialog(page, to, puts)
  check('(l) the PUT names the oldest missed day', [saved?.status, saved?.day, saved?.body], [200, oldest, { effective_date: to }])
  const confirmation = dialog(page).locator('[data-testid="force-date-confirmation"]')
  if (await confirmation.count()) await dialog(page).locator('[data-testid="force-date-close"]').click()
  await dialog(page).waitFor({ state: 'detached' })
  await settle(page)
  await openDueTab(page, 'subscriptions')
  check('(l) the missed row is gone', await missedRowOf(page, spotify.id).count(), 0)
  const moved1 = await upcomingRow(page, spotify.id, oldest, 'subscriptions')
  check('(l) the month reads "(moved from ...)" on Subscriptions', [await moved1.count(), await dateText(moved1)], [1, moved(to, oldest)])
  const before = puts.length
  await moved1.locator('[data-testid="occurrence-change-date"]').click()
  await dialog(page).locator('[data-testid="force-date-clear"]').waitFor()
  await dialog(page).locator('[data-testid="force-date-clear"]').click()
  await dialog(page).waitFor({ state: 'detached' })
  await settle(page)
  check('(l) Clear sends one DELETE', puts.slice(before).map((p) => [p.method, p.day, p.status]), [['DELETE', oldest, 204]])
  await openDueTab(page, 'subscriptions')
  await showRow(page, missedRowOf(page, spotify.id))
  check('(l) the missed row is back', await missedText(page, spotify.id), `1 missed since ${fmt(oldest)}`)
  checkNoNative('l', native)
  await ctx.close()
}

;(async () => {
  stack = await startLocalStack()
  API = `${stack.apiUrl}/api/v1`
  const browser = await chromium.launch()
  const run = (k) => !only || only === k
  const steps = { a: dueAndUpcoming, b: refusalAndClear, c: markPaidDate, d: loanPage, e: dashboard, f: roles, g: cardStatement, h: closedStatement, i: installmentPlanRow, j: missedRowChangeDate, k: missedRowFuture, l: missedRowSubscription }
  for (const [k, fn] of Object.entries(steps)) if (run(k)) await fn(browser)
  await browser.close()
  stack.stop()
  console.log(`\nRESULT: ${pass}/${total} assertions passed`)
  process.exit(pass === total ? 0 : 1)
})().catch((e) => { console.error(e); stack?.stop(); console.log(`\nRESULT (aborted): ${pass}/${total} assertions passed`); process.exit(1) })
