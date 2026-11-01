// Browser check for STU-465: the Transactions page splits its lists on Manila's day,
// and Upcoming lists recurring occurrences that are not recorded yet. Starts its own
// API and web app against a throwaway database (./_local_stack.cjs). Not wired into
// CI and not part of `pnpm build`. Run steps: see ./README.md.
//
// Scenarios (each seeds its own user, so each can run alone):
//   (k) the partition is on the Manila day, with the real clock: in a browser zone
//       whose local day differs from Manila's, a planned row dated Manila today is in
//       the main list and one dated Manila tomorrow is in Upcoming, each once
//   (l) the rollover trigger, on the browser clock only: crossing Manila's midnight
//       with no reload sends exactly one new request each for the main list, the
//       Upcoming transactions and the dashboard snapshot
//
// Every scenario checks that no browser dialog fired.
//
// Usage: node frontend/e2e/upcoming-occurrences.cjs [k|l]
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
const checkNoNative = (scenario, native) => check(`(${scenario}) no browser dialog fired`, native.count, 0)

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

  const { ctx, page, native } = await newPage(browser, { timezoneId: zone })
  const local = await page.evaluate(() => new Date().toLocaleDateString('en-CA'))
  console.log(`    zone ${zone}: local day ${local}, Manila day ${today}`)
  if (local === today) throw new Error(`(k) precondition: the browser's local day ${local} equals Manila's; the scenario cannot tell the days apart`)
  check('(k) precondition: the local day differs from Manila\'s', local !== today, true)
  await uiLogin(page, u)
  await openTransactions(page)
  check('(k) the custom range reads Manila today to Manila tomorrow', await setRange(page, today, tomorrow), [today, tomorrow])

  const shown = await lists(page)
  const due = (await allDueRows(page)).map((r) => r.name)
  console.log(`    main ${JSON.stringify(shown.main)}; upcoming ${JSON.stringify(shown.upcoming)}; due ${JSON.stringify(due)}`)
  check('(k) the Manila-today row is in the main list once, and nowhere else',
    [countOf(shown.main, 'K Today Row'), countOf(shown.upcoming, 'K Today Row'), due.filter((n) => n.includes('K Today Row')).length], [1, 0, 0])
  check('(k) the Manila-tomorrow row is in Upcoming once, and nowhere else',
    [countOf(shown.upcoming, 'K Tomorrow Row'), countOf(shown.main, 'K Tomorrow Row'), due.filter((n) => n.includes('K Tomorrow Row')).length], [1, 0, 0])
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

  const seen = { main: 0, upcoming: 0, otherList: 0, snapshot: 0, documents: 0 }
  page.on('request', (r) => {
    if (r.resourceType() === 'document') seen.documents++
    if (r.method() !== 'GET') return
    const url = new URL(r.url())
    if (url.pathname.endsWith('/api/v1/dashboard/snapshot')) seen.snapshot++
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
  check('(l) exactly one new request each: main list, Upcoming transactions, snapshot (and no other list request)',
    [seen.main, seen.upcoming, seen.snapshot, seen.otherList], [1, 1, 1, 0])
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

  const seen = { main: 0, upcoming: 0, otherList: 0, documents: 0 }
  page.on('request', (r) => {
    if (r.resourceType() === 'document') seen.documents++
    if (r.method() !== 'GET') return
    const url = new URL(r.url())
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
  check('(l) custom range: exactly one new request each: main list through the new day, Upcoming from the day after it (and no other list request)',
    [seen.main, seen.upcoming, seen.otherList], [1, 1, 0])
  checkNoNative('l', native)
  await ctx.close()
}

;(async () => {
  stack = await startLocalStack()
  API = `${stack.apiUrl}/api/v1`
  const browser = await chromium.launch()
  const run = (k) => !only || only === k
  const steps = { k: partitionOnManilaDay, l: rolloverTrigger }
  for (const [k, fn] of Object.entries(steps)) if (run(k)) await fn(browser)
  await browser.close()
  stack.stop()
  console.log(`\nRESULT: ${pass}/${total} assertions passed`)
  process.exit(pass === total ? 0 : 1)
})().catch((e) => { console.error(e); stack?.stop(); console.log(`\nRESULT (aborted): ${pass}/${total} assertions passed`); process.exit(1) })
