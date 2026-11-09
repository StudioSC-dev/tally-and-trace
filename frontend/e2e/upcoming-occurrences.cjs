// Browser check for STU-465 and STU-511: the Transactions page splits its lists on Manila's
// day, and the "Due and overdue" card's Upcoming tab lists the next 30 days (T+1 to T+30):
// the planned transactions and the recurring occurrences not recorded yet. The window is
// fixed from the Manila day and ignores the month, the search and the filters. Starts its
// own API and web app against a throwaway database (./_local_stack.cjs). Not wired into
// CI and not part of `pnpm build`. Run steps: see ./README.md.
//
// Scenarios (each seeds its own user, so each can run alone):
//   (a) the ticket's three salaries: each month in the window is listed once on the
//       Upcoming tab, "Not recorded" with Mark received; a month with a linked planned
//       row is that row; the salaries stay in Upcoming (no plan)
//   (b) Mark received on a future occurrence: one materialise POST; the occurrence
//       leaves Upcoming and the recorded row is listed where its date puts it
//   (c) Mark paid on a weekly cash expense (Upcoming); Charged on a card subscription's
//       day, then Posted on its next day (both read from Subscriptions)
//   (d) card installments are one plan row each on the Installments tab ("3 of 3 left";
//       auto-post on has no buttons and the label, unreviewed has Review, Charged and
//       Posted, off has Charged and Posted), none in Upcoming; the later months are
//       not recordable, read from the API
//   (e) a paused entry is not listed; after resuming, it is
//   (f) an editor's shared rows have buttons per the API's can_mark_paid; a viewer
//       sees none of the sharer's occurrences
//   (g) the page's filters do not apply to the card: with Income only, an account, search
//       or a tag every tab is unchanged and no window request is sent
//   (h) the window is fixed: T+1 to T+30 from the Manila day ("Through <date>"), T+30
//       listed and T+31 not; the previous month and a custom range change nothing
//   (i) over 100 items: the badge is the total, "showing the next 100 of N", the pager reads
//       1-3 of 100, and one ascending window request (order=asc, limit=100) is sent
//   (j) Due and overdue holds Manila today and earlier only: with rows due today, in a few
//       days (cash, card, income, transfer) and a missed month, no Due row is dated after
//       today, none of the later entries is in Due, a card subscription due today is in
//       Subscriptions and a card installment in Installments, each entry's day is listed
//       once across the tabs, and a future linked pending row is in Upcoming only
//   (k) the partition is on the Manila day, with the real clock: in a browser zone
//       whose local day differs from Manila's, a planned row dated Manila today is in
//       the main list and one dated Manila tomorrow is in Upcoming, each once; a cash
//       occurrence due Manila today is in Due and overdue and one due Manila tomorrow
//       is in Upcoming, not in Due and overdue; a card subscription due Manila today is in
//       Subscriptions, not in Due
//   (l) the rollover trigger, on the browser clock only: crossing Manila's midnight
//       with no reload sends exactly one new request each for the main list, the Upcoming
//       transactions (order=asc, from the day after the new day to its + 30), the snapshot,
//       and one occurrences request per partition (plan=none, plan=subscription); the
//       panel's "Through <date>" moves by one day; on a custom range the same counts hold
//   (m) Upcoming is a tab: no upcoming-transactions section, the tab order is DUE_TABS,
//       compact rows with no article, tapping a row opens the action modal, Delete drops
//       the badge, page 2 survives a tab visit, and no Load more on Upcoming
//
// Every scenario checks that no browser dialog fired.
//
// Usage: node frontend/e2e/upcoming-occurrences.cjs [a|b|c|d|e|f|g|h|i|j|k|l|m]
const { startLocalStack } = require('./_local_stack.cjs')
const { pick } = require('./_picker.cjs')
const { useDueCheck, dialogOpened, expectDueTab, DUE_TABS, allDueRows, openDueTab, readTab, showRow, goToPage, pagerLabel, currentPage } = require('./_due_pages.cjs')
const { waitQuiet } = require('./_smooth.cjs')
const { trackNativeDialogs } = require('./_dialogs.cjs')
const { seedDays, closeDayOf } = require('./_seed_days.cjs')

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
const manilaHour = () => new Date(Date.now() + 8 * 3600 * 1000).getUTCHours()
const addDays = (day, n) => {
  const d = new Date(`${day}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().slice(0, 10)
}
const wire = (day) => `${day}T00:00:00`
const daysIn = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate()
/** `day` moved by n months, on its own day of the month (clamped to the month). */
const addMonths = (day, n) => {
  let y = Number(day.slice(0, 4))
  let m = Number(day.slice(5, 7)) + n
  while (m > 12) { m -= 12; y += 1 }
  while (m < 1) { m += 12; y -= 1 }
  return `${y}-${String(m).padStart(2, '0')}-${String(Math.min(Number(day.slice(8, 10)), daysIn(y, m))).padStart(2, '0')}`
}
const monthEnd = (day) => `${day.slice(0, 8)}${String(daysIn(Number(day.slice(0, 4)), Number(day.slice(5, 7)))).padStart(2, '0')}`
const suffix = (d) => (d % 100 >= 11 && d % 100 <= 13 ? 'th' : ['th', 'st', 'nd', 'rd'][d % 10] || 'th')
/** As the app shows a day: "Oct 25th, 2026". */
const fmt = (day) => {
  const d = new Date(`${day}T00:00:00Z`)
  const month = new Intl.DateTimeFormat('en-US', { month: 'short', timeZone: 'UTC' }).format(d)
  return `${month} ${d.getUTCDate()}${suffix(d.getUTCDate())}, ${d.getUTCFullYear()}`
}
/** Every `step` days from `from` through `to`. */
const everyDays = (from, to, step) => {
  const out = []
  for (let d = from; d <= to; d = addDays(d, step)) out.push(d)
  return out
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

async function makeUser(tag) {
  const email = `e2e-upc-${tag}-${Math.random().toString(16).slice(2, 8)}@example.com`
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
/** A PHP card closing on `closeDom`, due 21 days later, paid from `bank`. */
const card = (u, bank, name, closeDom = 28) => post(u.token, '/accounts/', {
  name, account_type: 'credit', balance: 0, currency: 'PHP', credit_limit: 100000,
  billing_cycle_start: closeDom, days_until_due_date: 21, payment_account_id: bank.id,
})
const entry = (u, fields) => post(u.token, '/budget-entries/', { entry_type: 'expense', currency: 'PHP', cadence: 'monthly', ...fields })
/** A monthly card installment: `count` payments from `next`. */
const installment = (u, cardAcct, name, next, count) =>
  entry(u, { name, amount: 1000, account_id: cardAcct.id, next_occurrence: wire(next), end_mode: 'after_occurrences', max_occurrences: count })
/** Sets an installment's review flags directly (reviewed with auto-post on or off, or not reviewed). */
function setReview(id, state) {
  if (!Number.isInteger(id)) throw new Error(`unexpected entry id ${id}`)
  const sql = state === 'unreviewed'
    ? `UPDATE budget_entries SET installment_reviewed_at = NULL, auto_post_enabled = false WHERE id = ${id}`
    : `UPDATE budget_entries SET installment_reviewed_at = now(), auto_post_enabled = ${state === 'on' ? 'true' : 'false'} WHERE id = ${id}`
  const out = stack.psql(sql)
  if (out !== 'UPDATE 1') throw new Error(`setting the review flags reported "${out}"`)
}
/** The rows the API links to an entry (the creator sees `budget_entry_id`). */
const linkedRows = async (u, entryId) => (await get(u.token, '/transactions/?limit=1000')).items.filter((t) => t.budget_entry_id === entryId)
/** A planned (unposted) debit with no entry. */
const planned = (u, acct, day, amount, description) => post(u.token, '/transactions/', {
  account_id: acct.id, transaction_type: 'debit', amount, description, transaction_date: wire(day), is_posted: false,
})

async function newPage(browser, contextOptions = {}) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 1400 }, timezoneId: 'Asia/Manila', ...contextOptions })
  const page = await ctx.newPage()
  const native = trackNativeDialogs(page)
  if (process.env.DEBUG) page.on('response', (r) => { if (r.url().includes('/api/v1/')) console.log(`    [net] ${r.request().method()} ${r.url().replace(API, '')} -> ${r.status()}`) })
  return { ctx, page, native }
}
async function uiLogin(page, u) {
  await page.goto(`${stack.webUrl}/login`)
  await page.locator('#email').fill(u.email)
  await page.locator('#password').fill(u.password)
  await page.getByRole('button', { name: 'Sign in', exact: true }).click()
  await page.waitForURL((url) => url.pathname === '/')
}
const settle = async (page) => { await page.waitForLoadState('networkidle'); await page.waitForTimeout(500); await waitQuiet(page) }
async function openTransactions(page) {
  await page.goto(`${stack.webUrl}/transactions`)
  await page.locator('[data-testid="due-section"]').waitFor()
  await page.locator('[data-testid="due-count"]').filter({ hasNotText: '…' }).waitFor()
  await expectDueTab(page, 'upcoming')
  await page.locator('[data-testid="due-upcoming-count"]').filter({ hasNotText: '…' }).waitFor()
  await settle(page)
}
/** Sets a custom range through the page's date inputs (the end first, so the range is never inverted). */
async function setRange(page, start, end) {
  const toggle = page.getByRole('button', { name: 'Show filters' })
  if (await toggle.count()) await toggle.click()
  const startInput = page.locator('xpath=//label[normalize-space()="Custom start date"]/following-sibling::input')
  const endInput = page.locator('xpath=//label[normalize-space()="Custom end date"]/following-sibling::input')
  // The screen loader blocks input while a request is in flight: wait for it before each fill.
  await waitQuiet(page)
  await endInput.fill(end)
  await waitQuiet(page)
  await startInput.fill(start)
  await settle(page)
  return [await startInput.inputValue(), await endInput.inputValue()]
}
/**
 * The names in each list on screen: `main` (the main list's transaction rows: articles
 * outside the card), `upcoming` (the Upcoming tab's rows over every page, transactions
 * and occurrences alike, in order). Reading `upcoming` selects the Upcoming tab.
 */
const lists = async (page) => {
  const main = await page.evaluate(() => {
    const nameOf = (a) => a.querySelector('p.text-base')?.textContent.trim() ?? ''
    return [...document.querySelectorAll('article')].filter((a) => !a.closest('[data-testid="due-section"]')).map(nameOf)
  })
  return { main, upcoming: (await readTab(page, 'upcoming')).map((r) => r.name) }
}
const countOf = (names, name) => names.filter((n) => n === name).length
/** The occurrence rows (data-kind="occurrence") of a tab, over every page, with the fields the checks read. Selects the tab. */
const occurrences = async (page, slug = 'upcoming') => (await readTab(page, slug))
  .filter((r) => r.kind === 'occurrence')
  .map((r) => ({ name: r.name, day: r.day, source: r.source, note: r.note ?? '', notRecorded: r.notRecorded, buttons: r.upcomingButtons, autoPost: r.autoPost }))
/** One entry's occurrence rows, by entry id. */
const occurrencesOf = async (page, entryId, slug = 'upcoming') => (await occurrences(page, slug)).filter((o) => o.source === `budget_entry:${entryId}`)
/** An occurrence row's locator, on the page of the tab that holds it (selects the tab first). */
async function occRow(page, entryId, day, slug = 'upcoming') {
  await openDueTab(page, slug)
  return showRow(page, page.locator(`[data-testid="due-row"][data-kind="occurrence"][data-source="budget_entry:${entryId}"][data-day="${day}"]`))
}
/** The badge and the "showing the next 100 of M" span of the Upcoming tab. */
const upcomingHeader = async (page) => {
  await openDueTab(page, 'upcoming')
  const shown = page.locator('[data-testid="due-panel-upcoming"] [data-testid="upcoming-shown"]')
  return {
    count: (await page.locator('[data-testid="due-upcoming-count"]').textContent())?.trim() ?? null,
    shown: (await shown.count()) ? (await shown.textContent())?.replace(/\s+/g, ' ').replace(/^\s*·\s*/, '').trim() : null,
  }
}
/** The Upcoming panel's "Through <date>" line (without the showing-the-next span), or null. */
const throughText = async (page) => {
  await openDueTab(page, 'upcoming')
  const through = page.locator('[data-testid="due-panel-upcoming"] [data-testid="due-through"]')
  if (!(await through.count())) return null
  return through.evaluate((el) => {
    const clone = el.cloneNode(true)
    clone.querySelector('[data-testid="upcoming-shown"]')?.remove()
    return clone.textContent.replace(/\s+/g, ' ').trim()
  })
}
/** Every window request the page sends (the Upcoming transactions with order=asc, or any occurrences), as { kind, params }. */
function recordWindowRequests(page) {
  const out = []
  page.on('request', (r) => {
    if (r.method() !== 'GET') return
    const url = new URL(r.url())
    if (url.pathname.endsWith('/api/v1/transactions/') && url.searchParams.get('order') === 'asc') out.push({ kind: 'transactions', params: url.searchParams })
    if (url.pathname.endsWith('/api/v1/budget-entries/upcoming-occurrences')) out.push({ kind: 'occurrences', params: url.searchParams })
  })
  return out
}
/** The tab's rows, as [source, day, name], for every tab in DUE_TABS. */
async function tabsSnapshot(page) {
  const out = {}
  for (const t of DUE_TABS) out[t.slug] = (await readTab(page, t.slug)).map((r) => [r.source, r.day, r.name])
  return out
}
/** The API's window for Upcoming: T+1 start of day through T+30 end of day. */
const apiWindow = (today) => `start_date=${addDays(today, 1)}T00:00:00Z&end_date=${addDays(today, 30)}T23:59:59.999999Z`
const dialog = (page) => page.locator('[data-testid="mark-paid-dialog"]')
/** Every materialise POST the page sends, as { entryId, status, body }. */
function recordMaterialize(page) {
  const out = []
  page.on('response', (r) => {
    const m = new URL(r.url()).pathname.match(/\/budget-entries\/(\d+)\/materialize$/)
    if (m && r.request().method() === 'POST') out.push({ entryId: Number(m[1]), status: r.status(), body: JSON.parse(r.request().postData() || '{}') })
  })
  return out
}
/**
 * Clicks `button` on an occurrence row, submits the dialog with `submit`, and waits for it to close. Returns the POST's
 * status. Asserts that the click opened the dialog (within 10 s); when it did not, returns null and records nothing else.
 */
async function record(page, row, button, submit = 'mark-paid-submit', occurrenceDate) {
  await row.locator(`[data-testid="${button}"]`).click()
  const shown = await dialog(page).locator('[data-testid="mark-paid-occurrence"]').waitFor({ timeout: 10000 }).then(() => true, () => false)
  check(`${button} opened the Mark paid dialog`, shown, true)
  if (!shown) return null
  await waitQuiet(page)
  const opened = await dialog(page).locator('[data-testid="mark-paid-occurrence"]').inputValue()
  if (occurrenceDate !== undefined) check(`the dialog opens on the row's day ${occurrenceDate}`, opened, occurrenceDate)
  const done = page.waitForResponse((r) => r.request().method() === 'POST' && /\/materialize$/.test(new URL(r.url()).pathname))
  await dialog(page).locator(`[data-testid="${submit}"]`).click()
  const res = await done
  await dialog(page).waitFor({ state: 'detached' })
  await row.waitFor({ state: 'detached', timeout: 15000 }).catch(() => {})
  await settle(page)
  return res.status()
}
const checkNoNative = (scenario, native) => check(`(${scenario}) no browser dialog fired`, native.count, 0)

// (a) The ticket's three salaries.
async function threeSalaries(browser) {
  console.log('\n=== (a) three salaries: each expected month once, Not recorded with Mark received; a linked month is its row')
  const today = manilaToday()
  const first = addDays(today, 1)
  const later = addDays(today, 5)
  const through = addMonths(first, 1)
  // The window is fixed, T+1 to T+30: a month ahead of T+1 is in it only when it falls on or before T+30.
  const inWindow = (days) => days.filter((d) => d <= addDays(today, 30))
  const u = await makeUser('a')
  const bank = await account(u, 'A Checking')
  const salary = (name, next) => entry(u, { name, entry_type: 'income', amount: 30000, account_id: bank.id, next_occurrence: wire(next) })
  const linked = await salary('A Linked Salary', first)
  const due = await salary('A Due Salary', first)
  const third = await salary('A Later Salary', later)
  await post(u.token, '/transactions/', {
    account_id: bank.id, transaction_type: 'credit', amount: 30000, description: 'A Linked Salary planned',
    transaction_date: wire(first), is_posted: false, budget_entry_id: linked.id,
  })
  const { ctx, page, native } = await newPage(browser)
  await uiLogin(page, u)
  await openTransactions(page)
  const expected = [[linked, inWindow([through])], [due, inWindow([first, through])], [third, [later]]]
  for (const [e, days] of expected) {
    const rows = await occurrencesOf(page, e.id)
    check(`(a) ${e.name}: each expected month once`, rows.map((r) => r.day), days)
    check(`(a) ${e.name}: every row reads Not recorded and offers Mark received`,
      rows.map((r) => [r.notRecorded, r.note, r.buttons]), days.map(() => [true, 'Not recorded', ['upcoming-mark-received']]))
  }
  const shown = await lists(page)
  check('(a) the linked planned row shows once in Upcoming, as a transaction row', countOf(shown.upcoming, 'A Linked Salary planned'), 1)
  check('(a) the salaries stay in Upcoming: every occurrence row is a plain income row, none in a plan', (await readTab(page, 'upcoming')).filter((r) => r.kind === 'occurrence').map((r) => r.plan), [...Array(inWindow([through, first, through, later]).length)].map(() => null))
  check('(a) and it is the only item on its day for its entry', (await occurrencesOf(page, linked.id)).filter((r) => r.day === first).length, 0)
  check('(a) Upcoming is in day order', (await occurrences(page)).map((o) => o.day), [...(await occurrences(page)).map((o) => o.day)].sort())
  checkNoNative('a', native)
  await ctx.close()
}

// (b) Mark received on a future occurrence.
async function markReceived(browser) {
  console.log('\n=== (b) Mark received on a future occurrence: one POST, the row moves')
  const today = manilaToday()
  const day = addDays(today, 3)
  const u = await makeUser('b')
  const bank = await account(u, 'B Checking')
  const salary = await entry(u, { name: 'B Salary', entry_type: 'income', amount: 30000, account_id: bank.id, next_occurrence: wire(day) })
  const { ctx, page, native } = await newPage(browser)
  const posts = recordMaterialize(page)
  await uiLogin(page, u)
  await openTransactions(page)
  check('(b) the occurrence is listed with Mark received', (await occurrencesOf(page, salary.id)).map((r) => [r.day, r.buttons]), [[day, ['upcoming-mark-received']]])
  const status = await record(page, await occRow(page, salary.id, day), 'upcoming-mark-received', 'mark-paid-submit', day)
  check('(b) exactly one materialise POST, created (201)', posts.map((p) => [p.entryId, p.status]), [[salary.id, 201]])
  check('(b) the POST answered 201', status, 201)
  check('(b) the occurrence left Upcoming', (await occurrencesOf(page, salary.id)).filter((r) => r.day === day).length, 0)
  const rows = await linkedRows(u, salary.id)
  check('(b) the API has one row for it', rows.length, 1)
  const rowDay = rows[0]?.transaction_date.slice(0, 10)
  const where = rowDay <= today ? 'main' : 'upcoming'
  console.log(`    recorded row "${rows[0]?.description}" dated ${rowDay}: expected in ${where}`)
  const shown = await lists(page)
  check(`(b) the recorded row is in the ${where === 'main' ? 'main list' : 'Upcoming list'} once, and not in the other`,
    [countOf(shown[where], rows[0]?.description), countOf(shown[where === 'main' ? 'upcoming' : 'main'], rows[0]?.description)], [1, 0])
  checkNoNative('b', native)
  await ctx.close()
}

// (c) Mark paid on a cash expense; Charged, then Posted, on a card subscription.
async function markPaidAndCard(browser) {
  console.log('\n=== (c) Mark paid on a cash expense (Upcoming); Charged then Posted on a card subscription (Subscriptions)')
  const today = manilaToday()
  const day = addDays(today, 2)
  // Weekly, so the second occurrence is always inside the fixed 30-day window.
  const second = addDays(day, 7)
  const last = addDays(today, 30)
  const u = await makeUser('c')
  const bank = await account(u, 'C Checking')
  const visa = await card(u, bank, 'C Visa')
  const rent = await entry(u, { name: 'C Rent', cadence: 'weekly', amount: 15000, account_id: bank.id, next_occurrence: wire(day) })
  const netflix = await entry(u, { name: 'C Netflix', cadence: 'weekly', amount: 549, account_id: visa.id, next_occurrence: wire(day) })
  const { ctx, page, native } = await newPage(browser)
  const posts = recordMaterialize(page)
  await uiLogin(page, u)
  await openTransactions(page)
  check('(c) Rent offers Mark paid on every weekly day, in Upcoming',
    (await occurrencesOf(page, rent.id)).map((r) => [r.day, r.buttons]), everyDays(day, last, 7).map((d) => [d, ['upcoming-mark-paid']]))
  check('(c) Netflix is not in Upcoming: a card subscription is on the Subscriptions tab',
    (await occurrencesOf(page, netflix.id)).length, 0)
  check('(c) Netflix offers Charged and Posted on every weekly day, in Subscriptions',
    (await occurrencesOf(page, netflix.id, 'subscriptions')).map((r) => [r.day, r.buttons]), everyDays(day, last, 7).map((d) => [d, ['upcoming-charged', 'upcoming-posted']]))

  check('(c) Mark paid on Rent is created (201)', await record(page, await occRow(page, rent.id, day), 'upcoming-mark-paid', 'mark-paid-submit', day), 201)
  check('(c) Rent\'s first day left Upcoming and the API has one posted row',
    [(await occurrencesOf(page, rent.id)).map((r) => r.day), (await linkedRows(u, rent.id)).map((t) => t.is_posted)], [everyDays(second, last, 7), [true]])

  check('(c) Charged on Netflix is created (201)', await record(page, await occRow(page, netflix.id, day, 'subscriptions'), 'upcoming-charged', 'mark-paid-charged', day), 201)
  check('(c) Netflix\'s first day left Subscriptions; the API has one pending row',
    [(await occurrencesOf(page, netflix.id, 'subscriptions')).map((r) => r.day), (await linkedRows(u, netflix.id)).map((t) => t.is_posted)], [everyDays(second, last, 7), [false]])
  check('(c) Posted on Netflix\'s next day is created (201)', await record(page, await occRow(page, netflix.id, second, 'subscriptions'), 'upcoming-posted', 'mark-paid-submit', second), 201)
  check('(c) Netflix\'s first two days left Subscriptions; the API has one pending and one posted row',
    [(await occurrencesOf(page, netflix.id, 'subscriptions')).map((r) => r.day), (await linkedRows(u, netflix.id)).map((t) => t.is_posted).sort()], [everyDays(addDays(second, 7), last, 7), [false, true]])
  check('(c) three POSTs, one per click, with Charged sending is_posted false',
    posts.map((p) => [p.entryId, p.status, p.body.is_posted === false]), [[rent.id, 201, false], [netflix.id, 201, true], [netflix.id, 201, false]])
  checkNoNative('c', native)
  await ctx.close()
}

// (d) Card installments: one plan row each on the Installments tab, none in Upcoming.
async function installments(browser) {
  console.log('\n=== (d) card installments: on, unreviewed and off are one plan row each in Installments')
  const today = manilaToday()
  const u = await makeUser('d')
  const bank = await account(u, 'D Checking')
  // One card per installment, each closing on its own date: the API keeps a card installment on its
  // statement close, and a close is at most the 28th, so the dates are seeded where none needs clamping.
  const [onDay, unreviewedDay, offDay] = seedDays(today, [3, 4, 5])
  const cardFor = (name, day) => card(u, bank, name, closeDayOf(day))
  const on = await installment(u, await cardFor('D Visa On', onDay), 'D On', onDay, 3)
  const unreviewed = await installment(u, await cardFor('D Visa Unreviewed', unreviewedDay), 'D Unreviewed', unreviewedDay, 3)
  const off = await installment(u, await cardFor('D Visa Off', offDay), 'D Off', offDay, 3)
  setReview(on.id, 'on')
  setReview(unreviewed.id, 'unreviewed')
  setReview(off.id, 'off')
  const months = (start) => [0, 1, 2].map((n) => addMonths(start, n))
  const { ctx, page, native } = await newPage(browser)
  await uiLogin(page, u)
  await openTransactions(page)

  const plans = await readTab(page, 'installments')
  const planOf = (e) => plans.filter((r) => r.kind === 'installment' && r.source === `budget_entry:${e.id}`)
  const view = (e, next) => planOf(e).map((r) => [r.name, r.left, r.text.includes(`Next charge ${fmt(next)}`), [...r.buttons].sort(), r.autoPost])
  const first = (e) => (e === on ? onDay : e === unreviewed ? unreviewedDay : offDay)
  check('(d) auto-post on: one plan row, "3 of 3 left", no buttons and the auto-post label',
    view(on, first(on)).map(([n, l, nx, b, a]) => [n, l, nx, b, a?.includes('Auto-posts each morning')]), [['D On', '3 of 3 left', true, [], true]])
  check('(d) unreviewed: one plan row with Review, Charged and Posted',
    view(unreviewed, first(unreviewed)).map(([n, l, nx, b, a]) => [n, l, nx, b, a?.includes('Review to auto-post')]),
    [['D Unreviewed', '3 of 3 left', true, ['due-charged', 'due-posted', 'due-review'], true]])
  check('(d) off: one plan row with Charged and Posted',
    view(off, first(off)).map(([n, l, nx, b, a]) => [n, l, nx, b, a === null || a.includes('Auto-post off')]), [['D Off', '3 of 3 left', true, ['due-charged', 'due-posted'], true]])
  check('(d) the installments have no row in Upcoming: the plan rows stand for them',
    [await occurrencesOf(page, on.id), await occurrencesOf(page, unreviewed.id), await occurrencesOf(page, off.id)].map((r) => r.length), [0, 0, 0])
  check('(d) no installment row in Due', (await readTab(page, 'due')).filter((r) => r.source?.startsWith('budget_entry:') && [on, unreviewed, off].some((e) => r.source === `budget_entry:${e.id}`)).length, 0)

  // Later months are not offered buttons: the API says which occurrence can be recorded (the plan row stands for the first).
  const listing = (await get(u.token, `/budget-entries/upcoming-occurrences?start_date=${addDays(today, 1)}T00:00:00Z&end_date=${addDays(today, 90)}T23:59:59Z&limit=500`)).items
  const apiRows = (e) => listing.filter((o) => o.entry_id === e.id).map((o) => [o.occurrence_date.slice(0, 10), o.recordable])
  check('(d) API, auto-post on: every month listed, none recordable', apiRows(on), months(first(on)).map((d) => [d, false]))
  check('(d) API, unreviewed: Charged and Posted on the first month only', apiRows(unreviewed), months(first(unreviewed)).map((d, i) => [d, i === 0]))
  check('(d) API, off: Charged and Posted on the first month only', apiRows(off), months(first(off)).map((d, i) => [d, i === 0]))

  // The two checks above read the Upcoming and Due tabs (readTab selects what it reads), so select Installments again.
  await openDueTab(page, 'installments')
  const unrow = await showRow(page, page.locator(`[data-testid="due-row"][data-kind="installment"][data-source="budget_entry:${unreviewed.id}"]`))
  await unrow.locator('[data-testid="due-review"]').click()
  const review = page.locator('[data-testid="installment-review-dialog"]')
  if (await dialogOpened(review, '(d) Review opened the installment review dialog')) {
    check('(d) Review opens the installment review for that entry', (await page.locator('[data-testid="installment-review-title"]').textContent())?.includes('D Unreviewed'), true)
    await waitQuiet(page)
    await review.getByRole('button', { name: 'Cancel', exact: true }).click()
    await review.waitFor({ state: 'detached' })
  }
  checkNoNative('d', native)
  await ctx.close()
}

// (e) A paused entry, then resumed.
async function pausedEntry(browser) {
  console.log('\n=== (e) a paused entry is not listed; after resuming, it is')
  const today = manilaToday()
  const u = await makeUser('e')
  const bank = await account(u, 'E Checking')
  const gym = await entry(u, { name: 'E Gym', amount: 800, account_id: bank.id, next_occurrence: wire(addDays(today, 2)), is_active: false })
  const { ctx, page, native } = await newPage(browser)
  await uiLogin(page, u)
  await openTransactions(page)
  check('(e) the paused entry is not listed', (await occurrencesOf(page, gym.id)).length, 0)
  const resumed = await api(u.token, 'PUT', `/budget-entries/${gym.id}`, { is_active: true })
  check('(e) resuming it is 200', resumed.status, 200)
  await openTransactions(page)
  const rows = await occurrencesOf(page, gym.id)
  console.log(`    listed after resuming: ${JSON.stringify(rows.map((r) => r.day))}`)
  check('(e) after resuming it is listed, with Mark paid', [rows.length > 0, rows[0]?.buttons], [true, ['upcoming-mark-paid']])
  checkNoNative('e', native)
  await ctx.close()
}

// (f) An editor and a viewer of the sharer's account.
async function sharedRows(browser) {
  console.log('\n=== (f) an editor gets the sharer\'s rows with buttons per can_mark_paid; a viewer gets none')
  const today = manilaToday()
  const owner = await makeUser('f-owner')
  const editor = await makeUser('f-editor')
  const viewer = await makeUser('f-viewer')
  const bank = await account(owner, 'F Joint')
  await post(owner.token, `/accounts/${bank.id}/shares`, { email: editor.email, role: 'editor' })
  await post(owner.token, `/accounts/${bank.id}/shares`, { email: viewer.email, role: 'viewer' })
  const rent = await entry(owner, { name: 'F Rent', amount: 15000, account_id: bank.id, next_occurrence: wire(addDays(today, 2)) })

    // The card's fixed window and its Upcoming partition: T+1 to T+30, plan=none.
  const range = `?${apiWindow(today)}&plan=none&limit=500`
  const editorApi = (await get(editor.token, `/budget-entries/upcoming-occurrences${range}`)).items.filter((o) => o.entry_id === rent.id)
  console.log(`    the editor's API rows: ${JSON.stringify(editorApi.map((o) => [o.view, o.can_mark_paid, o.recordable]))}`)
  check('(f) the API gives the editor shared_full rows', [editorApi.length > 0, editorApi.every((o) => o.view === 'shared_full')], [true, true])
  const e = await newPage(browser)
  await uiLogin(e.page, editor)
  await openTransactions(e.page)
  const editorRows = await occurrencesOf(e.page, rent.id)
  check('(f) the editor sees the sharer\'s occurrences, with buttons per can_mark_paid',
    editorRows.map((r) => [r.day, r.buttons]), editorApi.map((o) => [o.occurrence_date, o.recordable ? ['upcoming-mark-paid'] : []]))
  checkNoNative('f', e.native)
  await e.ctx.close()

  const viewerApi = (await get(viewer.token, `/budget-entries/upcoming-occurrences${range}`)).items.filter((o) => o.entry_id === rent.id)
  check('(f) the API gives the viewer none of them', viewerApi.length, 0)
  const v = await newPage(browser)
  await uiLogin(v.page, viewer)
  await openTransactions(v.page)
  check('(f) the viewer sees none of the sharer\'s occurrences', (await occurrencesOf(v.page, rent.id)).length, 0)
  checkNoNative('f', v.native)
  await v.ctx.close()
}

// (g) Filters leave every tab alone.
async function filters(browser) {
  console.log('\n=== (g) Income only, an account, search and a tag change no tab and send no window request')
  const today = manilaToday()
  const u = await makeUser('g')
  const bankA = await account(u, 'G Bank A')
  const bankB = await account(u, 'G Bank B')
  const tag = await post(u.token, '/tags/', { name: 'G Tag' })
  await entry(u, { name: 'G Salary', entry_type: 'income', amount: 30000, account_id: bankA.id, next_occurrence: wire(addDays(today, 2)) })
  await entry(u, { name: 'G Rent', amount: 15000, account_id: bankA.id, next_occurrence: wire(addDays(today, 3)) })
  await entry(u, { name: 'G Gym', amount: 800, account_id: bankB.id, next_occurrence: wire(addDays(today, 4)), tag_ids: [tag.id] })
  await planned(u, bankB, addDays(today, 5), 50, 'G Planned')
  const { ctx, page, native } = await newPage(browser)
  const windowRequests = recordWindowRequests(page)
  await uiLogin(page, u)
  await openTransactions(page)
  const names = async () => [...new Set((await occurrences(page)).map((o) => o.name))].sort()
  check('(g) unfiltered: all three occurrences', await names(), ['G Gym', 'G Rent', 'G Salary'])
  const base = await tabsSnapshot(page)
  check('(g) the planned row is in Upcoming', base.upcoming.filter((r) => r[2] === 'G Planned').length, 1)
  await page.getByRole('button', { name: 'Show filters' }).click()
  await waitQuiet(page)
  const reset = async () => {
    await page.getByRole('button', { name: 'Reset filters' }).click()
    await settle(page)
  }
  const apply = async (what, act) => {
    const before = windowRequests.length
    await act()
    await settle(page)
    check(`(g) ${what}: every tab is unchanged`, JSON.stringify(await tabsSnapshot(page)) === JSON.stringify(base), true)
    check(`(g) ${what}: no window request was sent`, windowRequests.length - before, 0)
  }

  await apply('Income only', () => page.getByRole('button', { name: 'Income', exact: true }).click())
  await reset()
  await apply('one account', () => pick(page, /^G Bank B$/))
  await reset()
  await apply('search', async () => { await page.locator('[data-testid="transactions-search"]').fill('Rent'); await page.waitForTimeout(700) })
  await reset()
  await apply('a tag', () => page.locator('[data-testid="tag-filter"]').selectOption(String(tag.id)))
  checkNoNative('g', native)
  await ctx.close()
}

// (h) The fixed window.
async function lookAhead(browser) {
  console.log('\n=== (h) Upcoming is the next 30 days from the Manila day, whatever the month or range')
  const today = manilaToday()
  const start = addDays(today, 1)
  const last = addDays(today, 30)
  const u = await makeUser('h')
  const bank = await account(u, 'H Checking')
  const weekly = await entry(u, { name: 'H Weekly', cadence: 'weekly', amount: 100, account_id: bank.id, next_occurrence: wire(start) })
  const edge = await entry(u, { name: 'H Edge', amount: 100, account_id: bank.id, next_occurrence: wire(last) })
  const beyond = await entry(u, { name: 'H Beyond', amount: 100, account_id: bank.id, next_occurrence: wire(addDays(last, 1)) })
  const weeklyDays = everyDays(start, last, 7)
  const { ctx, page, native } = await newPage(browser)
  await uiLogin(page, u)
  await openTransactions(page)
  const days = async (e) => (await occurrencesOf(page, e.id)).map((r) => r.day)
  const unchanged = async (what) => {
    check(`(h) ${what}: the same days, the same through`,
      [await days(weekly), await days(edge), await days(beyond), await throughText(page)], [weeklyDays, [last], [], `Through ${fmt(last)}`])
  }
  check('(h) "Through T+30" is in the panel', await throughText(page), `Through ${fmt(last)}`)
  check('(h) T+30 is listed and T+31 is not', [await days(edge), await days(beyond)], [[last], []])
  check('(h) the weekly entry is listed on every day through T+30', await days(weekly), weeklyDays)
  check('(h) the badge is the number of rows', (await upcomingHeader(page)).count, String(weeklyDays.length + 1))

  await page.getByRole('button', { name: 'View previous month' }).click()
  await settle(page)
  await unchanged('the previous month')

  await page.getByRole('button', { name: 'Reset filters' }).click()
  await settle(page)
  const nextStart = addDays(monthEnd(today), 1)
  const nextEnd = monthEnd(nextStart)
  check('(h) a custom range over the next month', await setRange(page, nextStart, nextEnd), [nextStart, nextEnd])
  await unchanged('the next month as a custom range')
  check('(h) a short custom range', await setRange(page, start, addDays(today, 10)), [start, addDays(today, 10)])
  await unchanged('a short custom range')
  checkNoNative('h', native)
  await ctx.close()
}

// (i) Over 100 items.
async function overHundred(browser) {
  console.log('\n=== (i) over 100 items: showing the next 100 of N, from one ascending request')
  const today = manilaToday()
  const start = addDays(today, 1)
  const u = await makeUser('i')
  const bank = await account(u, 'I Checking')
  // A weekly cash entry: occurrences on T+1, T+8, T+15, T+22 and T+29.
  const weekly = await entry(u, { name: 'I Weekly', cadence: 'weekly', amount: 10, account_id: bank.id, next_occurrence: wire(start) })
  const occDays = everyDays(start, addDays(today, 30), 7)
  // 150 planned rows, five a day over T+1..T+30.
  for (let from = 0; from < 150; from += 10) {
    await Promise.all(Array.from({ length: 10 }, (_, k) => from + k).map((n) => planned(u, bank, addDays(start, n % 30), 50, `I Planned ${n}`)))
  }
  const total = 150 + occDays.length
  const { ctx, page, native } = await newPage(browser)
  const windowRequests = recordWindowRequests(page)
  await uiLogin(page, u)
  await openTransactions(page)
  const header = await upcomingHeader(page)
  console.log(`    badge ${header.count}; shown: ${header.shown}`)
  check('(i) the badge counts every row: 150 planned and the weekly occurrences', header.count, String(total))
  check('(i) the panel says it shows the next 100 of N', header.shown?.startsWith(`showing the next 100 of ${total}`), true)
  check('(i) the pager reads 1-3 of 100', await pagerLabel(page), '1–3 of 100')
  check('(i) no Load more on Upcoming', await page.locator('[data-testid="due-load-more"]').count(), 0)
  const rows = await readTab(page, 'upcoming')
  const occ = rows.filter((r) => r.kind === 'occurrence')
  check('(i) 100 rows, soonest first', [rows.length, JSON.stringify(rows.map((r) => r.day)) === JSON.stringify([...rows.map((r) => r.day)].sort())], [100, true])
  check('(i) the weekly occurrences before the cut are listed, the later ones are not', occ.map((r) => r.day), occDays.slice(0, 3))
  check('(i) the first row is the soonest day', rows[0]?.day, start)
  const tx = windowRequests.filter((r) => r.kind === 'transactions')
  check('(i) exactly one window transactions request, order=asc, limit=100',
    [tx.length, tx[0]?.params.get('order'), tx[0]?.params.get('limit')], [1, 'asc', '100'])
  check('(i) no window transactions request with an offset above 0', tx.filter((r) => Number(r.params.get('offset') ?? '0') > 0).length, 0)
  check('(i) the weekly entry exists in the API', typeof weekly.id, 'number')
  checkNoNative('i', native)
  await ctx.close()
}

/** A Due row's day from its second line ("Nov 1st, 2026 · …"), or null for a row with no leading day. */
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
function dueRowDay(sub) {
  const m = /^([A-Z][a-z]{2}) (\d{1,2})(?:st|nd|rd|th), (\d{4})/.exec(sub)
  if (!m || !MONTHS.includes(m[1])) return null
  return `${m[3]}-${String(MONTHS.indexOf(m[1]) + 1).padStart(2, '0')}-${m[2].padStart(2, '0')}`
}

// (j) Due and overdue holds Manila today and earlier only.
async function dueIsTodayAndEarlier(browser) {
  console.log('\n=== (j) Due lists today and earlier only; card subscriptions and installments are on their own tabs; each day is listed once across the tabs')
  const today = manilaToday()
  const anchor = Math.min(25, Math.max(5, Number(today.slice(8, 10))))
  const u = await makeUser('j')
  const bank = await account(u, 'J Checking')
  const savings = await account(u, 'J Savings', 'savings', 5000)
  const visa = await card(u, bank, 'J Visa')
  const todayBill = await entry(u, { name: 'J Today Bill', amount: 700, account_id: bank.id, next_occurrence: wire(today) })
  const soon = await entry(u, { name: 'J Soon Bill', amount: 800, account_id: bank.id, next_occurrence: wire(addDays(today, 2)) })
  const netflix = await entry(u, { name: 'J Netflix', amount: 549, account_id: visa.id, next_occurrence: wire(addDays(today, 3)) })
  const salary = await entry(u, { name: 'J Salary', entry_type: 'income', amount: 30000, account_id: bank.id, next_occurrence: wire(addDays(today, 4)) })
  const save = await entry(u, { name: 'J Save', amount: 2000, account_id: bank.id, transfer_to_account_id: savings.id, next_occurrence: wire(addDays(today, 5)) })
  const old = await entry(u, { name: 'J Old Bill', amount: 900, account_id: bank.id, next_occurrence: wire(addMonths(today, -2).slice(0, 8) + String(anchor).padStart(2, '0')), anchor_day: anchor })
  const sub = await entry(u, { name: 'J Sub Today', amount: 300, account_id: visa.id, next_occurrence: wire(today) })
  const plan = await installment(u, visa, 'J Plan', addDays(today, 6), 3)
  // Netflix's first month is Charged ahead of its day: a pending row linked to it, dated today+3.
  const charged = await api(u.token, 'POST', `/budget-entries/${netflix.id}/materialize`, { is_posted: false })
  const linked = await linkedRows(u, netflix.id)
  check('(j) Netflix is Charged: one pending row linked to it, on today+3',
    [charged.status, linked.map((t) => [t.is_posted, t.transaction_date.slice(0, 10)])], [201, [[false, addDays(today, 3)]]])

  const { ctx, page, native } = await newPage(browser)
  await uiLogin(page, u)
  await openTransactions(page)
  const dueRows = await readTab(page, 'due')
  const upRows = await readTab(page, 'upcoming')
  const subRows = await readTab(page, 'subscriptions')
  const planRows = await readTab(page, 'installments')
  const occs = upRows.filter((r) => r.kind === 'occurrence')
  const upcomingRows = upRows.filter((r) => r.source?.startsWith('transaction:')).map((r) => r.name)
  console.log(`    due ${JSON.stringify(dueRows.map((r) => `${r.kind}:${r.name}:${dueRowDay(r.sub)}`))}`)
  console.log(`    upcoming occurrences ${JSON.stringify(occs.map((o) => `${o.name}:${o.day}`))}; upcoming rows ${JSON.stringify(upcomingRows)}`)
  console.log(`    subscriptions ${JSON.stringify(subRows.map((r) => `${r.kind}:${r.name}:${r.day ?? dueRowDay(r.sub)}`))}; plans ${JSON.stringify(planRows.map((r) => r.name))}`)

  check('(j) no Due row is dated after today',
    dueRows.filter((r) => r.kind !== 'missed' && (dueRowDay(r.sub) === null || dueRowDay(r.sub) > today)).map((r) => r.name), [])
  const later = [soon, netflix, salary, save]
  check('(j) none of the later entries is in Due', later.map((e) => dueRows.filter((r) => r.source === `budget_entry:${e.id}`).length), [0, 0, 0, 0])
  check('(j) the linked pending row is not in Due', dueRows.filter((r) => r.source === `transaction:${linked[0]?.id}`).length, 0)
  check('(j) Today Bill is in Due once, on today, and not in Upcoming on today',
    [dueRows.filter((r) => r.source === `budget_entry:${todayBill.id}` && dueRowDay(r.sub) === today).length,
      occs.filter((o) => o.source === `budget_entry:${todayBill.id}` && o.day === today).length], [1, 0])
  check('(j) the missed month is in Due once', dueRows.filter((r) => r.kind === 'missed' && r.source === `budget_entry:${old.id}`).length, 1)
  check('(j) the card subscription due today and the installment plan are not in Due',
    [sub, plan].map((e) => dueRows.filter((r) => r.source === `budget_entry:${e.id}`).length), [0, 0])
  check('(j) the card subscription due today is in Subscriptions once on today (its next month may also be in the window), the plan in Installments once, and neither in Upcoming',
    [subRows.filter((r) => r.source === `budget_entry:${sub.id}` && (r.day ?? dueRowDay(r.sub)) === today).length, planRows.filter((r) => r.source === `budget_entry:${plan.id}`).length,
      occs.filter((o) => o.source === `budget_entry:${sub.id}` || o.source === `budget_entry:${plan.id}`).length], [1, 1, 0])
  check('(j) each later entry\'s first day is in Upcoming once, "Not recorded"',
    [[soon, 2], [salary, 4], [save, 5]].map(([e, n]) => occs.filter((o) => o.source === `budget_entry:${e.id}` && o.day === addDays(today, n) && o.notRecorded).length), [1, 1, 1])
  check('(j) the linked pending row is in Upcoming once, and its month is not an occurrence on any tab',
    [countOf(upcomingRows, 'J Netflix'), [...occs, ...subRows].filter((o) => o.source === `budget_entry:${netflix.id}` && o.day === addDays(today, 3)).length], [1, 0])
  const pairs = [
    ...dueRows.filter((r) => r.kind === 'recurring').map((r) => `${r.source}@${dueRowDay(r.sub)}`),
    ...occs.map((o) => `${o.source}@${o.day}`),
    ...subRows.filter((r) => r.kind !== 'missed' && r.source?.startsWith('budget_entry:')).map((r) => `${r.source}@${r.day ?? dueRowDay(r.sub)}`),
  ]
  check('(j) each entry\'s day is listed once across Due, Upcoming and Subscriptions', pairs.filter((p, i) => pairs.indexOf(p) !== i), [])
  checkNoNative('j', native)
  await ctx.close()
}

// (k) The partition is on the Manila day, with the real clock.
async function partitionOnManilaDay(browser) {
  console.log('\n=== (k) the lists split on the Manila day in a zone whose local day differs')
  const today = manilaToday()
  const tomorrow = addDays(today, 1)
  // Etc/GMT+12 is UTC-12: 20 hours behind Manila, so its day is Manila's yesterday until 20:00 Manila.
  const zone = manilaHour() < 20 ? 'Etc/GMT+12' : 'Pacific/Kiritimati'
  const u = await makeUser('k')
  const bank = await account(u, 'K Checking')
  const visa = await card(u, bank, 'K Visa')
  await planned(u, bank, today, 100, 'K Today Row')
  await planned(u, bank, tomorrow, 100, 'K Tomorrow Row')
  const todayBill = await entry(u, { name: 'K Today Bill', amount: 700, account_id: bank.id, next_occurrence: wire(today) })
  const tomorrowBill = await entry(u, { name: 'K Tomorrow Bill', amount: 800, account_id: bank.id, next_occurrence: wire(tomorrow) })
  // A card subscription due Manila today: it is a Subscriptions row, not a Due row.
  const todaySub = await entry(u, { name: 'K Today Sub', amount: 549, account_id: visa.id, next_occurrence: wire(today) })

  const { ctx, page, native } = await newPage(browser, { timezoneId: zone })
  const local = await page.evaluate(() => new Date().toLocaleDateString('en-CA'))
  console.log(`    zone ${zone}: local day ${local}, Manila day ${today}`)
  if (local === today) throw new Error(`(k) precondition: the browser's local day ${local} equals Manila's; the scenario cannot tell the days apart`)
  check('(k) precondition: the local day differs from Manila\'s', local !== today, true)
  await uiLogin(page, u)
  await openTransactions(page)
  check('(k) the custom range reads Manila today to Manila tomorrow', await setRange(page, today, tomorrow), [today, tomorrow])

  // Read Due first (it is the selected tab); `lists` then selects Upcoming.
  const dueRows = await allDueRows(page)
  const shown = await lists(page)
  const due = dueRows.map((r) => r.name)
  /** Due's rows for an entry's occurrence on `day` (a recurring row's second line starts with its day). */
  const dueOn = (entryId, day) => dueRows.filter((r) => r.source === `budget_entry:${entryId}` && r.sub.startsWith(fmt(day))).length
  console.log(`    main ${JSON.stringify(shown.main)}; upcoming ${JSON.stringify(shown.upcoming)}; due ${JSON.stringify(due)}`)
  check('(k) the Manila-today row is in the main list once, and nowhere else',
    [countOf(shown.main, 'K Today Row'), countOf(shown.upcoming, 'K Today Row'), due.filter((n) => n.includes('K Today Row')).length], [1, 0, 0])
  check('(k) the Manila-tomorrow row is in Upcoming once, and nowhere else',
    [countOf(shown.upcoming, 'K Tomorrow Row'), countOf(shown.main, 'K Tomorrow Row'), due.filter((n) => n.includes('K Tomorrow Row')).length], [1, 0, 0])
  // The Manila-today row is a one-off: Due does not list it, Not posted yet does ("logged today", by Manila's day); tomorrow's is on neither.
  await openDueTab(page, 'not-posted')
  const notPosted = await allDueRows(page)
  check('(k) the Manila-today row is on Not posted yet once, "logged today"',
    [notPosted.filter((r) => r.text.includes('K Today Row')).length, notPosted.find((r) => r.text.includes('K Today Row'))?.logged], [1, 'logged today'])
  check('(k) the Manila-tomorrow row is on neither tab', [due.filter((n) => n.includes('K Tomorrow Row')).length, notPosted.filter((r) => r.text.includes('K Tomorrow Row')).length], [0, 0])
  const occs = await occurrences(page)
  const subRows = await readTab(page, 'subscriptions')
  check('(k) the card subscription due Manila today is in Subscriptions once, and not in Due or Upcoming',
    [subRows.filter((r) => r.source === `budget_entry:${todaySub.id}` && (r.day ?? dueRowDay(r.sub)) === today).length, dueRows.filter((r) => r.source === `budget_entry:${todaySub.id}`).length,
      occs.filter((o) => o.source === `budget_entry:${todaySub.id}`).length], [1, 0, 0])
  check('(k) the occurrence due Manila today is in Due and overdue once, not in Upcoming or the main list',
    [dueOn(todayBill.id, today), occs.filter((o) => o.source === `budget_entry:${todayBill.id}` && o.day === today).length, countOf(shown.main, 'K Today Bill')], [1, 0, 0])
  check('(k) the occurrence due Manila tomorrow is in Upcoming once, on that day, and not in the main list or Due and overdue',
    [occs.filter((o) => o.source === `budget_entry:${tomorrowBill.id}`).map((o) => o.day), countOf(shown.main, 'K Tomorrow Bill'), dueOn(tomorrowBill.id, tomorrow)], [[tomorrow], 0, 0])
  checkNoNative('k', native)
  await ctx.close()
}

/** A GET of the transaction list, not the section's pending queries (no is_posted, no ids). */
const listRequest = (url) =>
  url.pathname.endsWith('/api/v1/transactions/') && !url.searchParams.has('is_posted') && url.searchParams.getAll('ids').length === 0
/**
 * The occurrence requests for the window that starts on `from`, counted per partition.
 * Commit 6 sends `plan=none` only; the Subscriptions tab adds `plan=subscription` (commit 7).
 */
const PARTITIONS = ['none', 'subscription']
const newOccurrenceCounts = () => Object.fromEntries(PARTITIONS.map((p) => [p, 0]))
function countOccurrenceRequest(url, from, counts) {
  if (!url.pathname.endsWith('/api/v1/budget-entries/upcoming-occurrences')) return
  if (!(url.searchParams.get('start_date') ?? '').startsWith(from)) return
  const plan = url.searchParams.get('plan')
  if (plan !== null && plan in counts) counts[plan]++
}
/** One request per partition the card queries: `none` always, `subscription` once the Subscriptions tab exists. */
const expectedOccurrenceCounts = () => PARTITIONS.map((p) => (p === 'subscription' && !DUE_TABS.some((t) => t.slug === 'subscriptions') ? 0 : 1))

// (l) The rollover trigger, on the browser clock only.
async function rolloverTrigger(browser) {
  console.log('\n=== (l) crossing Manila midnight refetches each list once, with no reload')
  // A past mid-month day, so the day after it is in the same month. The API stays on the
  // real day: this checks only the page's own reaction to the new Manila day.
  const now = manilaToday()
  const day = `${addDays(`${now.slice(0, 8)}01`, -1).slice(0, 8)}15`
  const next = addDays(day, 1)
  const u = await makeUser('l')
  const bank = await account(u, 'L Checking')
  await planned(u, bank, addDays(day, 10), 100, 'L Later Row')

  // A UTC browser: its local day does not turn at Manila's midnight (16:00 UTC), only Manila's does.
  const { ctx, page, native } = await newPage(browser, { timezoneId: 'UTC' })
  await page.clock.install({ time: new Date(`${day}T15:59:00Z`) })
  await uiLogin(page, u)
  await openTransactions(page)
  const before = await lists(page)
  check('(l) before midnight the later planned row is in Upcoming', countOf(before.upcoming, 'L Later Row'), 1)
  check('(l) before midnight Upcoming runs through the day + 30', await throughText(page), `Through ${fmt(addDays(day, 30))}`)

  const seen = { main: 0, upcoming: 0, otherList: 0, occurrences: newOccurrenceCounts(), snapshot: 0, documents: 0 }
  page.on('request', (r) => {
    if (r.resourceType() === 'document') seen.documents++
    if (r.method() !== 'GET') return
    const url = new URL(r.url())
    if (url.pathname.endsWith('/api/v1/dashboard/snapshot')) seen.snapshot++
    countOccurrenceRequest(url, addDays(next, 1), seen.occurrences)
    if (!listRequest(url)) return
    const start = url.searchParams.get('start_date') ?? ''
    const end = url.searchParams.get('end_date') ?? ''
    if (url.searchParams.get('order') === 'asc' && start.startsWith(addDays(next, 1)) && end.startsWith(addDays(next, 30))) seen.upcoming++
    else if (end.startsWith(next)) seen.main++
    else seen.otherList++
  })
  // Playwright reads '02:00' as mm:ss: two minutes, 23:59 to 00:01 Manila.
  await page.clock.fastForward('02:00')
  await settle(page)
  const manila = await page.evaluate(() => new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10))
  check('(l) the page\'s Manila day turned', manila, next)
  check('(l) no reload', seen.documents, 0)
  check('(l) exactly one new request each: main list, Upcoming transactions, snapshot (and no other list request)',
    [seen.main, seen.upcoming, seen.snapshot, seen.otherList], [1, 1, 1, 0])
  check('(l) exactly one new occurrences request per partition (plan=none, plan=subscription)',
    PARTITIONS.map((p) => seen.occurrences[p]), expectedOccurrenceCounts())
  check('(l) the Upcoming panel\'s "Through" moved by one day', await throughText(page), `Through ${fmt(addDays(next, 30))}`)
  checkNoNative('l', native)
  await ctx.close()
  await rolloverCustomRange(browser, u, day, next)
}

/**
 * (l) again on a custom range around the day, which has no look-ahead: only the Manila day
 * itself can move the lists' split, so crossing midnight must still refetch each list once.
 */
async function rolloverCustomRange(browser, u, day, next) {
  const start = addDays(day, -5)
  const end = addDays(day, 20)
  const { ctx, page, native } = await newPage(browser, { timezoneId: 'UTC' })
  await page.clock.install({ time: new Date(`${day}T15:59:00Z`) })
  await uiLogin(page, u)
  await openTransactions(page)
  check('(l) custom range: the range reads the day - 5 to the day + 20', await setRange(page, start, end), [start, end])
  check('(l) custom range: before midnight the later planned row is in Upcoming', countOf((await lists(page)).upcoming, 'L Later Row'), 1)
  check('(l) custom range: the window is fixed, so "Through" is still the day + 30', await throughText(page), `Through ${fmt(addDays(day, 30))}`)

  const seen = { main: 0, upcoming: 0, otherList: 0, occurrences: newOccurrenceCounts(), documents: 0 }
  page.on('request', (r) => {
    if (r.resourceType() === 'document') seen.documents++
    if (r.method() !== 'GET') return
    const url = new URL(r.url())
    countOccurrenceRequest(url, addDays(next, 1), seen.occurrences)
    if (!listRequest(url)) return
    const from = url.searchParams.get('start_date') ?? ''
    const to = url.searchParams.get('end_date') ?? ''
    if (from.startsWith(addDays(next, 1)) && to.startsWith(addDays(next, 30))) seen.upcoming++
    else if (from.startsWith(start) && to.startsWith(next)) seen.main++
    else seen.otherList++
  })
  await page.clock.fastForward('02:00')
  await settle(page)
  check('(l) custom range: no reload', seen.documents, 0)
  check('(l) custom range: exactly one new request each: main list through the new day and Upcoming transactions, the window from the day after it (and no other list request)',
    [seen.main, seen.upcoming, seen.otherList], [1, 1, 0])
  check('(l) custom range: exactly one new occurrences request per partition (plan=none, plan=subscription)',
    PARTITIONS.map((p) => seen.occurrences[p]), expectedOccurrenceCounts())
  check('(l) custom range: the "Through" moved by one day', await throughText(page), `Through ${fmt(addDays(next, 30))}`)
  checkNoNative('l', native)
  await ctx.close()
}

// (m) Where Upcoming lives now: a tab of the card, with compact rows.
async function upcomingTabPlacement(browser) {
  console.log('\n=== (m) Upcoming is a tab: no page section, no articles, the modal on tap, paging kept, no Load more')
  const today = manilaToday()
  const u = await makeUser('m')
  const bank = await account(u, 'M Checking')
  for (let n = 1; n <= 5; n++) await planned(u, bank, addDays(today, n + 1), 10 * n, `M Row ${n}`)
  const { ctx, page, native } = await newPage(browser)
  await uiLogin(page, u)
  await openTransactions(page)
  const badge = async () => Number((await page.locator('[data-testid="due-upcoming-count"]').textContent())?.trim())

  check('(m) the page has no upcoming-transactions section', await page.locator('[data-testid="upcoming-transactions"]').count(), 0)
  check('(m) the tabs are in the DUE_TABS order',
    await page.locator('[data-testid="due-section"] [role="tab"]').evaluateAll((els) => els.map((e) => e.dataset.testid)), DUE_TABS.map((t) => t.tab))
  const rows = await readTab(page, 'upcoming')
  check('(m) the badge counts the five planned rows, and each is a compact transaction row',
    [await badge(), rows.map((r) => [r.kind, r.name])], [5, [1, 2, 3, 4, 5].map((n) => ['upcoming', `M Row ${n}`])])
  check('(m) Upcoming rows contain no article', await page.locator('[data-testid="due-panel-upcoming"] article').count(), 0)

  // Paging is read, not awaited: a step that does not land (5 s) leaves the page where it is and the check reads it.
  await goToPage(page, 2).catch(() => {})
  check('(m) page 2 of Upcoming', [await currentPage(page), await pagerLabel(page)], [2, '4–5 of 5'])
  await openDueTab(page, 'not-posted')
  await openDueTab(page, 'upcoming')
  check('(m) page 2 survives a visit to another tab', [await currentPage(page), await pagerLabel(page)], [2, '4–5 of 5'])
  await goToPage(page, 1)

  const target = await showRow(page, page.locator('[data-testid="due-row"][data-kind="upcoming"]').filter({ hasText: 'M Row 1' }))
  await target.locator('[data-testid="upcoming-transaction"]').click()
  const modal = page.locator('div.fixed').filter({ has: page.getByRole('heading', { name: 'Transaction Actions', exact: true }) })
  const modalShown = await modal.waitFor({ timeout: 10000 }).then(() => true, () => false)
  check('(m) tapping a row opens the action modal', modalShown, true)
  if (modalShown) {
    await waitQuiet(page)
    check('(m) tapping a row opens the action modal with Edit, Delete and Post',
      [await modal.getByRole('button', { name: 'Edit Transaction', exact: true }).count(), await modal.getByRole('button', { name: 'Delete Transaction', exact: true }).count(),
        await modal.getByRole('button', { name: 'Mark as Posted', exact: true }).count()], [1, 1, 1])
    await modal.getByRole('button', { name: 'Delete Transaction', exact: true }).click()
    const confirm = page.locator('[data-testid="confirm-dialog"]')
    if (await dialogOpened(confirm, '(m) Delete opened the in-app Confirm')) {
      await confirm.locator('[data-testid="confirm-dialog-confirm"]').click()
      await confirm.waitFor({ state: 'detached' })
      await modal.waitFor({ state: 'detached' })
      await settle(page)
      check('(m) Delete drops the badge by one and the row leaves', [await badge(), (await readTab(page, 'upcoming')).filter((r) => r.text.includes('M Row 1')).length], [4, 0])
    }
  }
  checkNoNative('m', native)
  await ctx.close()

  // A forced has_more: no Load more on Upcoming; the same force shows it on Due (the control).
  const forced = await newPage(browser)
  await forced.page.route((url) => url.pathname.endsWith('/api/v1/transactions/') && (url.searchParams.get('order') === 'asc' || url.searchParams.get('is_posted') === 'false'), async (route) => {
    const res = await route.fetch()
    const json = await res.json()
    await route.fulfill({ response: res, json: { ...json, has_more: true } })
  })
  await uiLogin(forced.page, u)
  await openTransactions(forced.page)
  await openDueTab(forced.page, 'due')
  check('(m) control: with has_more forced, Due shows Load more', await forced.page.locator('[data-testid="due-load-more"]').count(), 1)
  await openDueTab(forced.page, 'upcoming')
  check('(m) with has_more forced, Upcoming shows no Load more', await forced.page.locator('[data-testid="due-load-more"]').count(), 0)
  checkNoNative('m', forced.native)
  await forced.ctx.close()
}

;(async () => {
  stack = await startLocalStack()
  API = `${stack.apiUrl}/api/v1`
  const browser = await chromium.launch()
  const run = (k) => !only || only === k
  const steps = { a: threeSalaries, b: markReceived, c: markPaidAndCard, d: installments, e: pausedEntry, f: sharedRows, g: filters, h: lookAhead, i: overHundred, j: dueIsTodayAndEarlier, k: partitionOnManilaDay, l: rolloverTrigger, m: upcomingTabPlacement }
  for (const [k, fn] of Object.entries(steps)) if (run(k)) await fn(browser)
  await browser.close()
  stack.stop()
  console.log(`\nRESULT: ${pass}/${total} assertions passed`)
  process.exit(pass === total ? 0 : 1)
})().catch((e) => { console.error(e); stack?.stop(); console.log(`\nRESULT (aborted): ${pass}/${total} assertions passed`); process.exit(1) })
