// Browser check for STU-465: the Transactions page splits its lists on Manila's day,
// and Upcoming lists recurring occurrences that are not recorded yet. Starts its own
// API and web app against a throwaway database (./_local_stack.cjs). Not wired into
// CI and not part of `pnpm build`. Run steps: see ./README.md.
//
// Scenarios (each seeds its own user, so each can run alone):
//   (a) the ticket's three salaries: each expected month is listed once, "Not
//       recorded" with Mark received; a month with a linked planned row is that row
//   (b) Mark received on a future occurrence: one materialise POST; the occurrence
//       leaves Upcoming and the recorded row is listed where its date puts it
//   (c) Mark paid on a cash expense; Charged on a card subscription's month, then
//       Posted on its next month
//   (d) card installments: auto-post on has no buttons and the auto-post label;
//       unreviewed has Review (and Charged, Posted on its first month only); off has
//       Charged and Posted on its first month and none on later ones
//   (e) a paused entry is not listed; after resuming, it is
//   (f) an editor's shared rows have buttons per the API's can_mark_paid; a viewer
//       sees none of the sharer's occurrences
//   (g) the page's filters apply to occurrences: Income only, an account, search, a tag
//   (h) look-ahead: the current month runs through the later of its end and Manila
//       today + 30 days ("through <date>"); the previous month has no Upcoming, and a
//       custom range (the next month's own days, or a few days) is exact
//   (i) over 100 items: "showing the next 100 of N"
//   (k) the partition is on the Manila day, with the real clock: in a browser zone
//       whose local day differs from Manila's, a planned row dated Manila today is in
//       the main list and one dated Manila tomorrow is in Upcoming, each once; an
//       occurrence due Manila today is in Due and overdue and one due Manila tomorrow
//       is in Upcoming
//   (l) the rollover trigger, on the browser clock only: crossing Manila's midnight
//       with no reload sends exactly one new request each for the main list, the
//       Upcoming transactions, the Upcoming occurrences and the dashboard snapshot,
//       and the Upcoming header's "through <date>" moves by one day; on a custom
//       range (no look-ahead, no "through") the main list, the Upcoming transactions and
//       the Upcoming occurrences still refetch once
//
// Every scenario checks that no browser dialog fired.
//
// Usage: node frontend/e2e/upcoming-occurrences.cjs [a|b|c|d|e|f|g|h|i|k|l]
const { startLocalStack } = require('./_local_stack.cjs')
const { allDueRows } = require('./_due_pages.cjs')
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
/** A PHP card closing on the 28th, due 21 days later, paid from `bank`. */
const card = (u, bank, name) => post(u.token, '/accounts/', {
  name, account_type: 'credit', balance: 0, currency: 'PHP', credit_limit: 100000,
  billing_cycle_start: 28, days_until_due_date: 21, payment_account_id: bank.id,
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
 * The names in each list on screen: `main` (transaction rows outside Upcoming and Due),
 * `upcoming` (Upcoming's rows, transactions and occurrences alike, in order).
 */
const lists = (page) => page.evaluate(() => {
  const up = document.querySelector('[data-testid="upcoming-transactions"]')
  const nameOf = (a) => (a.querySelector('[data-testid="upcoming-occurrence-name"]') ?? a.querySelector('p.text-base'))?.textContent.trim() ?? ''
  const all = [...document.querySelectorAll('article')]
  return {
    main: all.filter((a) => !up?.contains(a) && !a.closest('[data-testid="due-section"]')).map(nameOf),
    upcoming: up ? [...up.querySelectorAll('article')].map(nameOf) : [],
  }
})
const countOf = (names, name) => names.filter((n) => n === name).length
/** Upcoming's occurrence rows on screen. */
const occurrences = (page) => page.locator('[data-testid="upcoming-occurrence"]').evaluateAll((els) => els.map((e) => ({
  name: e.querySelector('[data-testid="upcoming-occurrence-name"]')?.textContent.trim() ?? '',
  day: e.dataset.day,
  source: e.dataset.source,
  note: e.querySelector('[data-testid="upcoming-occurrence-note"]')?.textContent.trim() ?? '',
  notRecorded: e.querySelector('[data-testid="upcoming-not-recorded"]')?.textContent.trim() === 'Not recorded',
  buttons: [...e.querySelectorAll('button[data-testid^="upcoming-"]')].map((b) => b.dataset.testid),
})))
/** One entry's occurrence rows, by entry id. */
const occurrencesOf = async (page, entryId) => (await occurrences(page)).filter((o) => o.source === `budget_entry:${entryId}`)
const occRow = (page, entryId, day) =>
  page.locator(`[data-testid="upcoming-occurrence"][data-source="budget_entry:${entryId}"][data-day="${day}"]`)
const upcomingHeader = async (page) => {
  const header = page.locator('[data-testid="upcoming-transactions"] > button')
  return (await header.count()) ? (await header.textContent())?.replace(/\s+/g, ' ').trim() : null
}
const throughText = async (page) => {
  const through = page.locator('[data-testid="upcoming-through"]')
  return (await through.count()) ? (await through.textContent())?.replace(/^\s*·\s*/, '').trim() : null
}
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
/** Clicks `button` on an occurrence row, submits the dialog with `submit`, and waits for it to close. */
async function record(page, row, button, submit = 'mark-paid-submit', occurrenceDate) {
  await row.locator(`[data-testid="${button}"]`).click()
  await dialog(page).locator('[data-testid="mark-paid-occurrence"]').waitFor()
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
  check('(a) the custom range is set', await setRange(page, first, through), [first, through])
  const expected = [[linked, [through]], [due, [first, through]], [third, [later]]]
  for (const [e, days] of expected) {
    const rows = await occurrencesOf(page, e.id)
    check(`(a) ${e.name}: each expected month once`, rows.map((r) => r.day), days)
    check(`(a) ${e.name}: every row reads Not recorded and offers Mark received`,
      rows.map((r) => [r.notRecorded, r.note, r.buttons]), days.map(() => [true, 'Not recorded', ['upcoming-mark-received']]))
  }
  const shown = await lists(page)
  check('(a) the linked planned row shows once in Upcoming, as a transaction row', countOf(shown.upcoming, 'A Linked Salary planned'), 1)
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
  const status = await record(page, occRow(page, salary.id, day), 'upcoming-mark-received', 'mark-paid-submit', day)
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
  console.log('\n=== (c) Mark paid on a cash expense; Charged then Posted on a card subscription')
  const today = manilaToday()
  const day = addDays(today, 2)
  const nextMonth = addMonths(day, 1)
  const u = await makeUser('c')
  const bank = await account(u, 'C Checking')
  const visa = await card(u, bank, 'C Visa')
  const rent = await entry(u, { name: 'C Rent', amount: 15000, account_id: bank.id, next_occurrence: wire(day) })
  const netflix = await entry(u, { name: 'C Netflix', amount: 549, account_id: visa.id, next_occurrence: wire(day) })
  const { ctx, page, native } = await newPage(browser)
  const posts = recordMaterialize(page)
  await uiLogin(page, u)
  await openTransactions(page)
  check('(c) the custom range is set', await setRange(page, addDays(today, 1), nextMonth), [addDays(today, 1), nextMonth])
  check('(c) Rent offers Mark paid on both months',
    (await occurrencesOf(page, rent.id)).map((r) => [r.day, r.buttons]), [[day, ['upcoming-mark-paid']], [nextMonth, ['upcoming-mark-paid']]])
  check('(c) Netflix offers Charged and Posted on both months',
    (await occurrencesOf(page, netflix.id)).map((r) => [r.day, r.buttons]), [[day, ['upcoming-charged', 'upcoming-posted']], [nextMonth, ['upcoming-charged', 'upcoming-posted']]])

  check('(c) Mark paid on Rent is created (201)', await record(page, occRow(page, rent.id, day), 'upcoming-mark-paid', 'mark-paid-submit', day), 201)
  check('(c) Rent\'s first month left Upcoming and the API has one posted row',
    [(await occurrencesOf(page, rent.id)).map((r) => r.day), (await linkedRows(u, rent.id)).map((t) => t.is_posted)], [[nextMonth], [true]])

  check('(c) Charged on Netflix is created (201)', await record(page, occRow(page, netflix.id, day), 'upcoming-charged', 'mark-paid-charged', day), 201)
  check('(c) Netflix\'s first month left Upcoming; the API has one pending row',
    [(await occurrencesOf(page, netflix.id)).map((r) => r.day), (await linkedRows(u, netflix.id)).map((t) => t.is_posted)], [[nextMonth], [false]])
  check('(c) Posted on Netflix\'s next month is created (201)', await record(page, occRow(page, netflix.id, nextMonth), 'upcoming-posted', 'mark-paid-submit', nextMonth), 201)
  check('(c) Netflix has no occurrence left; the API has one pending and one posted row',
    [(await occurrencesOf(page, netflix.id)).length, (await linkedRows(u, netflix.id)).map((t) => t.is_posted).sort()], [0, [false, true]])
  check('(c) three POSTs, one per click, with Charged sending is_posted false',
    posts.map((p) => [p.entryId, p.status, p.body.is_posted === false]), [[rent.id, 201, false], [netflix.id, 201, true], [netflix.id, 201, false]])
  checkNoNative('c', native)
  await ctx.close()
}

// (d) Card installments.
async function installments(browser) {
  console.log('\n=== (d) card installments: on, unreviewed and off')
  const today = manilaToday()
  const u = await makeUser('d')
  const bank = await account(u, 'D Checking')
  const visa = await card(u, bank, 'D Visa')
  const on = await installment(u, visa, 'D On', addDays(today, 3), 3)
  const unreviewed = await installment(u, visa, 'D Unreviewed', addDays(today, 4), 3)
  const off = await installment(u, visa, 'D Off', addDays(today, 5), 3)
  setReview(on.id, 'on')
  setReview(unreviewed.id, 'unreviewed')
  setReview(off.id, 'off')
  const months = (start) => [0, 1, 2].map((n) => addMonths(start, n))
  const { ctx, page, native } = await newPage(browser)
  await uiLogin(page, u)
  await openTransactions(page)
  check('(d) the custom range is set', await setRange(page, addDays(today, 1), addDays(today, 100)), [addDays(today, 1), addDays(today, 100)])

  const onRows = await occurrencesOf(page, on.id)
  check('(d) auto-post on: every month listed, with no buttons and the auto-post label',
    onRows.map((r) => [r.day, r.buttons, r.note]), months(addDays(today, 3)).map((d) => [d, [], 'Not recorded · Auto-posts each morning']))
  const unRows = await occurrencesOf(page, unreviewed.id)
  check('(d) unreviewed: Review on every month, Charged and Posted on the first only',
    unRows.map((r) => [r.day, r.buttons, r.note]), months(addDays(today, 4)).map((d, i) =>
      [d, i === 0 ? ['upcoming-review', 'upcoming-charged', 'upcoming-posted'] : ['upcoming-review'], 'Not recorded · Review to auto-post']))
  const offRows = await occurrencesOf(page, off.id)
  check('(d) off: Charged and Posted on the first month, none on the later ones',
    offRows.map((r) => [r.day, r.buttons, r.note]), months(addDays(today, 5)).map((d, i) =>
      [d, i === 0 ? ['upcoming-charged', 'upcoming-posted'] : [], 'Not recorded · Auto-post off · Mark paid']))

  await occRow(page, unreviewed.id, addDays(today, 4)).locator('[data-testid="upcoming-review"]').click()
  const review = page.locator('[data-testid="installment-review-dialog"]')
  await review.waitFor()
  check('(d) Review opens the installment review for that entry', (await page.locator('[data-testid="installment-review-title"]').textContent())?.includes('D Unreviewed'), true)
  await waitQuiet(page)
  await review.getByRole('button', { name: 'Cancel', exact: true }).click()
  await review.waitFor({ state: 'detached' })
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

  // The page's default range: the current month, looking ahead to Manila today + 30.
  const end = [monthEnd(today), addDays(today, 30)].sort()[1]
  const range = `?start_date=${addDays(today, 1)}T00:00:00Z&end_date=${end}T23:59:59Z`
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

// (g) Filters.
async function filters(browser) {
  console.log('\n=== (g) Income only, an account, search and a tag filter occurrences')
  const today = manilaToday()
  const u = await makeUser('g')
  const bankA = await account(u, 'G Bank A')
  const bankB = await account(u, 'G Bank B')
  const tag = await post(u.token, '/tags/', { name: 'G Tag' })
  await entry(u, { name: 'G Salary', entry_type: 'income', amount: 30000, account_id: bankA.id, next_occurrence: wire(addDays(today, 2)) })
  await entry(u, { name: 'G Rent', amount: 15000, account_id: bankA.id, next_occurrence: wire(addDays(today, 3)) })
  await entry(u, { name: 'G Gym', amount: 800, account_id: bankB.id, next_occurrence: wire(addDays(today, 4)), tag_ids: [tag.id] })
  const { ctx, page, native } = await newPage(browser)
  await uiLogin(page, u)
  await openTransactions(page)
  const names = async () => [...new Set((await occurrences(page)).map((o) => o.name))].sort()
  check('(g) unfiltered: all three', await names(), ['G Gym', 'G Rent', 'G Salary'])
  await page.getByRole('button', { name: 'Show filters' }).click()
  await waitQuiet(page)
  const reset = async () => {
    await page.getByRole('button', { name: 'Reset filters' }).click()
    await settle(page)
  }

  await page.getByRole('button', { name: 'Income', exact: true }).click()
  await settle(page)
  check('(g) Income only', await names(), ['G Salary'])
  await reset()
  await page.getByRole('button', { name: 'G Bank B', exact: true }).click()
  await settle(page)
  check('(g) one account', await names(), ['G Gym'])
  await reset()
  await page.locator('[data-testid="transactions-search"]').fill('Rent')
  await page.waitForTimeout(700)
  await settle(page)
  check('(g) search', await names(), ['G Rent'])
  await reset()
  await page.locator('[data-testid="tag-filter"]').selectOption(String(tag.id))
  await settle(page)
  check('(g) a tag', await names(), ['G Gym'])
  checkNoNative('g', native)
  await ctx.close()
}

// (h) The look-ahead.
async function lookAhead(browser) {
  console.log('\n=== (h) the current month looks ahead; other months and custom ranges are exact')
  const today = manilaToday()
  const start = addDays(today, 1)
  const u = await makeUser('h')
  const bank = await account(u, 'H Checking')
  const weekly = await entry(u, { name: 'H Weekly', cadence: 'weekly', amount: 100, account_id: bank.id, next_occurrence: wire(start) })
  const all = everyDays(start, addDays(today, 120), 7)
  const within = (from, to) => all.filter((d) => d >= from && d <= to)
  const end = monthEnd(today)
  const through = addDays(today, 30)
  const extended = through > end
  const { ctx, page, native } = await newPage(browser)
  await uiLogin(page, u)
  await openTransactions(page)
  console.log(`    month end ${end}; Manila today + 30 ${through}`)
  check('(h) the current month lists through the later of its end and today + 30',
    (await occurrencesOf(page, weekly.id)).map((r) => r.day), within(start, extended ? through : end))
  check('(h) its header says through when it is extended', await throughText(page), extended ? `through ${fmt(through)}` : null)
  const header = await upcomingHeader(page)
  check('(h) the header reads "Upcoming (N) · through <date>"', header?.startsWith(`Upcoming (${within(start, extended ? through : end).length})${extended ? ` · through ${fmt(through)}` : ''}`), true)

  await page.getByRole('button', { name: 'View previous month' }).click()
  await settle(page)
  check('(h) the previous month: no occurrence and no through', [(await occurrencesOf(page, weekly.id)).length, await throughText(page)], [0, null])

  await page.getByRole('button', { name: 'Reset filters' }).click()
  await settle(page)
  const nextStart = addDays(end, 1)
  const nextEnd = monthEnd(nextStart)
  check('(h) a custom range over the next month', await setRange(page, nextStart, nextEnd), [nextStart, nextEnd])
  check('(h) the next month shows only its own days, with no through',
    [(await occurrencesOf(page, weekly.id)).map((r) => r.day), await throughText(page)], [within(nextStart, nextEnd), null])
  check('(h) a short custom range', await setRange(page, start, addDays(today, 10)), [start, addDays(today, 10)])
  check('(h) a custom range is exact, with no through',
    [(await occurrencesOf(page, weekly.id)).map((r) => r.day), await throughText(page)], [within(start, addDays(today, 10)), null])
  checkNoNative('h', native)
  await ctx.close()
}

// (i) Over 100 items.
async function overHundred(browser) {
  console.log('\n=== (i) over 100 items: showing the next 100 of N')
  const today = manilaToday()
  const start = addDays(today, 1)
  const last = addDays(today, 210)
  const u = await makeUser('i')
  const bank = await account(u, 'I Checking')
  // Five weekly entries on five different weekdays: 30 occurrences each over the range.
  const weeklies = []
  for (let k = 1; k <= 5; k++) {
    weeklies.push(await entry(u, { name: `I Weekly ${k}`, cadence: 'weekly', amount: 10, account_id: bank.id, next_occurrence: wire(addDays(today, k)) }))
  }
  const days = weeklies.flatMap((_, i) => everyDays(addDays(today, i + 1), last, 7)).sort()
  await planned(u, bank, addDays(today, 2), 50, 'I Planned')
  const { ctx, page, native } = await newPage(browser)
  await uiLogin(page, u)
  await openTransactions(page)
  check('(i) the custom range is set', await setRange(page, start, last), [start, last])
  const header = await upcomingHeader(page)
  console.log(`    header: ${header}`)
  check('(i) the header counts 151 and shows the next 100',
    [header?.startsWith('Upcoming (151)'), header?.includes('showing the next 100 of 151, narrow the dates for more')], [true, true])
  const shown = await lists(page)
  check('(i) 100 rows: the planned row and 99 occurrences, soonest first',
    [shown.upcoming.length, countOf(shown.upcoming, 'I Planned'), (await occurrences(page)).map((o) => o.day)],
    [100, 1, days.slice(0, 99)])
  check('(i) the planned row is second: on its day the transaction comes before the occurrence', shown.upcoming.slice(0, 3), ['I Weekly 1', 'I Planned', 'I Weekly 2'])
  checkNoNative('i', native)
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
  await planned(u, bank, today, 100, 'K Today Row')
  await planned(u, bank, tomorrow, 100, 'K Tomorrow Row')
  const todayBill = await entry(u, { name: 'K Today Bill', amount: 700, account_id: bank.id, next_occurrence: wire(today) })
  const tomorrowBill = await entry(u, { name: 'K Tomorrow Bill', amount: 800, account_id: bank.id, next_occurrence: wire(tomorrow) })

  const { ctx, page, native } = await newPage(browser, { timezoneId: zone })
  const local = await page.evaluate(() => new Date().toLocaleDateString('en-CA'))
  console.log(`    zone ${zone}: local day ${local}, Manila day ${today}`)
  if (local === today) throw new Error(`(k) precondition: the browser's local day ${local} equals Manila's; the scenario cannot tell the days apart`)
  check('(k) precondition: the local day differs from Manila\'s', local !== today, true)
  await uiLogin(page, u)
  await openTransactions(page)
  check('(k) the custom range reads Manila today to Manila tomorrow', await setRange(page, today, tomorrow), [today, tomorrow])

  const shown = await lists(page)
  const dueRows = await allDueRows(page)
  const due = dueRows.map((r) => r.name)
  /** Due's rows for an entry's occurrence on `day` (a recurring row's second line starts with its day). */
  const dueOn = (entryId, day) => dueRows.filter((r) => r.source === `budget_entry:${entryId}` && r.sub.startsWith(fmt(day))).length
  console.log(`    main ${JSON.stringify(shown.main)}; upcoming ${JSON.stringify(shown.upcoming)}; due ${JSON.stringify(due)}`)
  check('(k) the Manila-today row is in the main list once, and nowhere else',
    [countOf(shown.main, 'K Today Row'), countOf(shown.upcoming, 'K Today Row'), due.filter((n) => n.includes('K Today Row')).length], [1, 0, 0])
  check('(k) the Manila-tomorrow row is in Upcoming once, and nowhere else',
    [countOf(shown.upcoming, 'K Tomorrow Row'), countOf(shown.main, 'K Tomorrow Row'), due.filter((n) => n.includes('K Tomorrow Row')).length], [1, 0, 0])
  const occs = await occurrences(page)
  check('(k) the occurrence due Manila today is in Due and overdue once, not in Upcoming or the main list',
    [dueOn(todayBill.id, today), occs.filter((o) => o.source === `budget_entry:${todayBill.id}` && o.day === today).length, countOf(shown.main, 'K Today Bill')], [1, 0, 0])
  check('(k) the occurrence due Manila tomorrow is in Upcoming once, on that day, and not in the main list',
    [occs.filter((o) => o.source === `budget_entry:${tomorrowBill.id}`).map((o) => o.day), countOf(shown.main, 'K Tomorrow Bill')], [[tomorrow], 0])
  checkNoNative('k', native)
  await ctx.close()
}

/** A GET of the transaction list, not the section's pending queries (no is_posted, no ids). */
const listRequest = (url) =>
  url.pathname.endsWith('/api/v1/transactions/') && !url.searchParams.has('is_posted') && url.searchParams.getAll('ids').length === 0

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
  check('(l) before midnight Upcoming runs through the day + 30', await throughText(page), `through ${fmt(addDays(day, 30))}`)

  const seen = { main: 0, upcoming: 0, otherList: 0, occurrences: 0, snapshot: 0, documents: 0 }
  page.on('request', (r) => {
    if (r.resourceType() === 'document') seen.documents++
    if (r.method() !== 'GET') return
    const url = new URL(r.url())
    if (url.pathname.endsWith('/api/v1/dashboard/snapshot')) seen.snapshot++
    if (url.pathname.endsWith('/api/v1/budget-entries/upcoming-occurrences') && (url.searchParams.get('start_date') ?? '').startsWith(addDays(next, 1))) seen.occurrences++
    if (!listRequest(url)) return
    const start = url.searchParams.get('start_date') ?? ''
    const end = url.searchParams.get('end_date') ?? ''
    if (start.startsWith(addDays(next, 1))) seen.upcoming++
    else if (end.startsWith(next)) seen.main++
    else seen.otherList++
  })
  // Playwright reads '02:00' as mm:ss: two minutes, 23:59 to 00:01 Manila.
  await page.clock.fastForward('02:00')
  await settle(page)
  const manila = await page.evaluate(() => new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10))
  check('(l) the page\'s Manila day turned', manila, next)
  check('(l) no reload', seen.documents, 0)
  check('(l) exactly one new request each: main list, Upcoming transactions, Upcoming occurrences, snapshot (and no other list request)',
    [seen.main, seen.upcoming, seen.occurrences, seen.snapshot, seen.otherList], [1, 1, 1, 1, 0])
  check('(l) the Upcoming header\'s "through" moved by one day', await throughText(page), `through ${fmt(addDays(next, 30))}`)
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
  check('(l) custom range: no look-ahead, so no "through"', await throughText(page), null)

  const seen = { main: 0, upcoming: 0, otherList: 0, occurrences: 0, documents: 0 }
  page.on('request', (r) => {
    if (r.resourceType() === 'document') seen.documents++
    if (r.method() !== 'GET') return
    const url = new URL(r.url())
    if (url.pathname.endsWith('/api/v1/budget-entries/upcoming-occurrences') && (url.searchParams.get('start_date') ?? '').startsWith(addDays(next, 1))) seen.occurrences++
    if (!listRequest(url)) return
    const from = url.searchParams.get('start_date') ?? ''
    const to = url.searchParams.get('end_date') ?? ''
    if (from.startsWith(addDays(next, 1)) && to.startsWith(end)) seen.upcoming++
    else if (from.startsWith(start) && to.startsWith(next)) seen.main++
    else seen.otherList++
  })
  await page.clock.fastForward('02:00')
  await settle(page)
  check('(l) custom range: no reload', seen.documents, 0)
  check('(l) custom range: exactly one new request each: main list through the new day, Upcoming transactions and occurrences from the day after it (and no other list request)',
    [seen.main, seen.upcoming, seen.occurrences, seen.otherList], [1, 1, 1, 0])
  checkNoNative('l', native)
  await ctx.close()
}

;(async () => {
  stack = await startLocalStack()
  API = `${stack.apiUrl}/api/v1`
  const browser = await chromium.launch()
  const run = (k) => !only || only === k
  const steps = { a: threeSalaries, b: markReceived, c: markPaidAndCard, d: installments, e: pausedEntry, f: sharedRows, g: filters, h: lookAhead, i: overHundred, k: partitionOnManilaDay, l: rolloverTrigger }
  for (const [k, fn] of Object.entries(steps)) if (run(k)) await fn(browser)
  await browser.close()
  stack.stop()
  console.log(`\nRESULT: ${pass}/${total} assertions passed`)
  process.exit(pass === total ? 0 : 1)
})().catch((e) => { console.error(e); stack?.stop(); console.log(`\nRESULT (aborted): ${pass}/${total} assertions passed`); process.exit(1) })
