// Browser check for STU-373 (Plan C W3): the Allocations page warns when card
// subscriptions and bills would fail. Under the Subscriptions and Card-billed bills
// headers it shows "Available credit on <card>" for each managed card that has an
// active entry there, and each entry card carries its worst upcoming credit check as a
// badge. Starts its own API and web app against a throwaway database
// (./_local_stack.cjs). PHP only, so no exchange rate is fetched. Not wired into CI
// and not part of `pnpm build`. Run steps: see ./README.md.
//
// Every expected figure is read from the API (GET /cards/credit), never hard-coded;
// dates are relative to the Manila today. Each scenario seeds its own owner and data,
// so any one letter runs alone.
//
// Waits on /cards/credit are soft (checkResponse, checkVisible): a missing request or
// element is a failed assertion, not an abort, so the script prints RESULT on a build
// that does not have the feature.
//
// Scenarios:
//   (a) one line per managed card with an active entry in each group, in name order;
//       none for a card without a limit or a card whose only bill is paused
//   (b) a subscription larger than the limit shows "Would exceed available credit"
//       with its occurrence date; ok entries show nothing
//   (c) a planned payment turns it into "OK with planned payment by <date>" and adds
//       the card's "with planned payment" line
//   (d) every badge equals the severity rule applied to the API's checks, and a capped
//       bill reads "1 more warning"
//   (e) an editor, a viewer and a tag viewer see no credit text under a held and a
//       failed request; an admin sees a placeholder, then the figure
//   (f) loading, error, and error with stale data
//   (g) a client-side move from Accounts fetches again; the cached figure stays up
//   (h) Manila's day turning refetches
//   (i) the statuses the PHP stack cannot produce (unchecked, incomplete, "at most"),
//       through a mocked response
//
// Usage: node frontend/e2e/allocations-credit.cjs [a|b|c|d|e|f|g|h|i]
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
let scenario = '-'
const perScenario = {}
function check(what, actual, expected) {
  total++
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  const s = (perScenario[scenario] ??= { pass: 0, total: 0 })
  s.total++
  if (ok) { pass++; s.pass++ }
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${what}: actual=${JSON.stringify(actual)} expected=${JSON.stringify(expected)}`)
}

// ─── Days (YYYY-MM-DD, UTC arithmetic) ───────────────────────────────────────
const manilaToday = () => new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10)
const addDays = (day, n) => {
  const d = new Date(`${day}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().slice(0, 10)
}
const suffix = (d) => (d % 100 >= 11 && d % 100 <= 13 ? 'th' : ['th', 'st', 'nd', 'rd'][d % 10] || 'th')
/** As the app shows a day: "Oct 25th, 2026". */
const fmt = (day) => {
  const d = new Date(`${day}T00:00:00Z`)
  const month = new Intl.DateTimeFormat('en-US', { month: 'short', timeZone: 'UTC' }).format(d)
  return `${month} ${d.getUTCDate()}${suffix(d.getUTCDate())}, ${d.getUTCFullYear()}`
}
/** As the app shows PHP money: "₱1,851.10". */
const peso = (n) => `₱${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2, useGrouping: true })}`
const wire = (day) => `${day}T00:00:00`
/** The headline a card line shows: the figure, "at most" when something is left out. */
const availText = (credit) => `${credit.complete ? '' : 'at most '}${peso(credit.available_now)}`

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
async function put(token, url, body) {
  const r = await api(token, 'PUT', url, body)
  if (r.status >= 300) throw new Error(`PUT ${url} ${r.status} ${JSON.stringify(r.json)}`)
  return r.json
}
const get = async (token, url) => {
  const r = await api(token, 'GET', url)
  if (r.status >= 300) throw new Error(`GET ${url} ${r.status} ${JSON.stringify(r.json)}`)
  return r.json
}

async function makeUser(tag) {
  const email = `e2e-alc-${tag}-${Math.random().toString(16).slice(2, 8)}@example.com`
  const password = 'E2eTest!2345'
  const reg = await api('', 'POST', '/auth/register', { email, password, first_name: `User${tag}`, last_name: 'Test', default_currency: 'PHP' })
  if (reg.status !== 200 && reg.status !== 201) throw new Error(`register ${reg.status} ${JSON.stringify(reg.json)}`)
  stack.verifyUser(email) // aborts the run unless psql reports UPDATE 1
  const login = await api('', 'POST', '/auth/login', { email, password })
  if (login.status !== 200) throw new Error(`login ${login.status}`)
  return { email, password, tag, token: login.json.access_token }
}
const checking = (u) => post(u.token, '/accounts/', { name: `${u.tag} Checking`, account_type: 'checking', balance: 100000, currency: 'PHP' })
/** A card closing on day 24 of each month, due 21 days later, paid from `bank`. No limit when `limit` is undefined. */
const card = (u, bank, name, limit) => post(u.token, '/accounts/', {
  name, account_type: 'credit', balance: 0, currency: 'PHP', credit_limit: limit,
  billing_cycle_start: 24, days_until_due_date: 21, payment_account_id: bank.id,
})
const expense = (u, fields) => post(u.token, '/budget-entries/', { entry_type: 'expense', currency: 'PHP', cadence: 'monthly', ...fields })
const creditItems = async (u) => (await get(u.token, '/cards/credit')).items
const cardCredit = async (u, cardId) => (await creditItems(u)).find((c) => c.account_id === cardId)
const expenseEntries = async (u) => (await get(u.token, '/budget-entries/?entry_type=expense&limit=200')).items

/**
 * One owner with a checking account and four cards: A (large limit), B and C (small
 * limits) and N (no limit), plus the entries each scenario reads. Names and days are
 * fixed so an assertion can say which entry it means.
 */
async function seed(tag) {
  const owner = await makeUser(tag)
  const today = manilaToday()
  const bank = await checking(owner)
  const A = await card(owner, bank, 'Card A', 500000)
  const B = await card(owner, bank, 'Card B', 10000)
  const C = await card(owner, bank, 'Card C', 10000)
  const N = await card(owner, bank, 'Card N', undefined)
  const e = {}
  e.smallSub = await expense(owner, { name: 'Small Sub', amount: 100, next_occurrence: wire(addDays(today, 6)), account_id: A.id })
  e.power = await expense(owner, { name: 'Power', amount: 200, next_occurrence: wire(addDays(today, 8)), account_id: A.id, billing_kind: 'bill' })
  e.bigSub = await expense(owner, { name: 'Big Sub', amount: 15000, next_occurrence: wire(addDays(today, 4)), account_id: B.id })
  // Weekly and capped at two, so both occurrences are at risk and nothing beyond is checked.
  e.cappedBill = await expense(owner, {
    name: 'Capped Bill', amount: 500, cadence: 'weekly', next_occurrence: wire(addDays(today, 9)), account_id: B.id,
    billing_kind: 'bill', end_mode: 'after_occurrences', max_occurrences: 2,
  })
  e.mediumSub = await expense(owner, { name: 'Medium Sub', amount: 12000, next_occurrence: wire(addDays(today, 5)), account_id: C.id })
  e.pausedBill = await expense(owner, {
    name: 'Paused Bill', amount: 300, next_occurrence: wire(addDays(today, 10)), account_id: C.id, billing_kind: 'bill', is_active: false,
  })
  e.noLimit = await expense(owner, { name: 'No Limit Sub', amount: 100, next_occurrence: wire(addDays(today, 7)), account_id: N.id })
  return { owner, today, bank, A, B, C, N, e }
}

// ─── Harness ─────────────────────────────────────────────────────────────────
const isCreditUrl = (url) => new URL(url).pathname.endsWith('/cards/credit')

async function newPage(browser) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 1000 } })
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

/** Setup: the page is open once its recurring groups render. */
async function openAllocations(page, key = 'subscription') {
  await page.goto(`${stack.webUrl}/allocations`)
  await page.locator(`[data-testid="kind-section-${key}"]`).waitFor()
}

const settle = async (page) => { await page.waitForLoadState('networkidle'); await page.waitForTimeout(500) }
const section = (page, key) => page.locator(`[data-testid="kind-section-${key}"]`)
const entryCard = (page, key, name) => section(page, key).locator('article').filter({ has: page.getByText(name, { exact: true }) })
const cardLine = (page, key, cardId) => section(page, key).locator(`[data-testid="kind-credit-line"][data-card-id="${cardId}"]`)
const lineCardIds = (page, key) =>
  section(page, key).locator('[data-testid="kind-credit-line"]').evaluateAll((els) => els.map((el) => Number(el.getAttribute('data-card-id'))))
// Reads on an element that may be missing are soft (null after 3 s), so an absent W3 element fails an assertion.
const READ_MS = 3000
const text = async (loc) => (await loc.first().textContent({ timeout: READ_MS }).catch(() => null))?.trim() ?? null
const attr = (loc, name) => loc.first().getAttribute(name, { timeout: READ_MS }).catch(() => null)
const countOf = async (page, ids) => Promise.all(ids.map((id) => page.locator(`[data-testid="${id}"]`).count()))

/** A visible-or-FAIL wait: a missing element is an assertion failure, not an abort. */
async function checkVisible(label, locator, timeout = 8000) {
  let seen = true
  try { await locator.first().waitFor({ state: 'visible', timeout }) } catch { seen = false }
  check(label, seen, true)
  return seen
}

/**
 * Registers the wait for the next GET /cards/credit response (optionally one with
 * `status`) before the caller triggers it; the returned function awaits it and records
 * PASS or FAIL. It never throws.
 */
function creditResponse(page, status, timeout = 15000) {
  const wait = page
    .waitForResponse((r) => r.request().method() === 'GET' && isCreditUrl(r.url()) && (status === undefined || r.status() === status), { timeout })
    .then((r) => r, () => null)
  return async (label) => {
    const r = await wait
    check(`${label}: a GET /cards/credit${status === undefined ? '' : ` answered ${status}`} came back`, r !== null, true)
    return r
  }
}

/** The same for a request, to prove one was sent. */
function creditRequest(page, timeout = 15000) {
  const wait = page
    .waitForRequest((r) => r.method() === 'GET' && isCreditUrl(r.url()), { timeout })
    .then((r) => r, () => null)
  return async (label) => {
    const r = await wait
    check(`${label}: a GET /cards/credit was sent`, r !== null, true)
    return r
  }
}

/**
 * Holds every GET /cards/credit until `release('pass' | 'fail')`: pass lets it through,
 * fail answers 500. An explicit promise, never a timer.
 */
async function holdCredit(target) {
  let release
  const gate = new Promise((resolve) => { release = resolve })
  await target.route('**/cards/credit', async (route) => {
    const how = await gate
    if (how === 'fail') await route.fulfill({ status: 500, contentType: 'application/json', body: '{}' })
    else await route.continue()
  })
  return { release }
}

function countCreditRequests(page) {
  const seen = { n: 0 }
  page.on('request', (r) => { if (r.method() === 'GET' && isCreditUrl(r.url())) seen.n++ })
  return seen
}

/** The six test ids no one without a managed card may see. */
const CREDIT_IDS = ['kind-credit-lines', 'kind-credit-line', 'kind-credit-loading', 'kind-credit-error', 'entry-credit-warning', 'credit-check-badge']

// Independent of the shared helper: the severity rule written out for the parity check.
const SEVERITY = ['at_risk', 'unchecked', 'incomplete', 'ok_with_planned']
const COUNTED = ['at_risk', 'unchecked', 'incomplete']
function expectedWarning(checks, entryId) {
  const mine = checks.filter((c) => c.source === 'budget_entry' && c.source_id === entryId && SEVERITY.includes(c.status))
  if (mine.length === 0) return null
  const best = [...mine].sort((a, b) =>
    SEVERITY.indexOf(a.status) - SEVERITY.indexOf(b.status) || (a.occurrence_date ?? a.date).localeCompare(b.occurrence_date ?? b.date))[0]
  const more = mine.filter((c) => c !== best && COUNTED.includes(c.status)).length
  const occurrence = best.occurrence_date ?? best.date
  const badge = {
    at_risk: 'Would exceed available credit',
    unchecked: 'No exchange rate: not checked',
    incomplete: 'Credit check incomplete',
    ok_with_planned: best.relies_on_planned ? `OK with planned payment by ${fmt(best.relies_on_planned)}` : 'OK with planned payment',
  }[best.status]
  return {
    status: best.status, badge, occurrence,
    note: `on ${fmt(occurrence)}${more > 0 ? ` · ${more} more ${more === 1 ? 'warning' : 'warnings'} in the next 30 days` : ''}`,
  }
}

/** What an entry card renders: its warning row, or null. */
async function renderedWarning(page, key, name) {
  const row = entryCard(page, key, name).locator('[data-testid="entry-credit-warning"]')
  if ((await row.count()) === 0) return null
  const badge = row.locator('[data-testid="credit-check-badge"]')
  return {
    status: await attr(badge, 'data-status'),
    badge: await text(badge),
    occurrence: await attr(row, 'data-occurrence'),
    note: await text(row.locator(':scope > span.text-muted')),
  }
}

// ─── (a) Card lines ──────────────────────────────────────────────────────────
async function cardLines(browser) {
  scenario = 'a'
  console.log('\n=== (a) one line per managed card with an active entry in each group')
  const w = await seed('a')
  const { ctx, page } = await newPage(browser)
  await uiLogin(page, w.owner)
  await openAllocations(page)
  await checkVisible('(a) a card line shows', page.locator('[data-testid="kind-credit-line"]'))
  await settle(page)
  check('(a) Subscriptions: lines for A, B and C in name order, none for N', await lineCardIds(page, 'subscription'), [w.A.id, w.B.id, w.C.id])
  check('(a) Card-billed bills: lines for A and B only (C\'s bill is paused, N has none)', await lineCardIds(page, 'bill'), [w.A.id, w.B.id])
  for (const [key, c] of [['subscription', w.A], ['subscription', w.B], ['subscription', w.C], ['bill', w.A], ['bill', w.B]]) {
    const credit = await cardCredit(w.owner, c.id)
    check(`(a) ${key}: ${c.name} reads the API's available_now`,
      await text(cardLine(page, key, c.id).locator('[data-testid="kind-credit-available"]')), availText(credit))
    check(`(a) ${key}: ${c.name} line names the card`, (await text(cardLine(page, key, c.id)))?.startsWith(`Available credit on ${c.name}:`), true)
  }
  check('(a) no planned line yet', await page.locator('[data-testid="kind-credit-with-planned"]').count(), 0)
  await ctx.close()
}

// ─── (b) Exceed badge ────────────────────────────────────────────────────────
async function exceedBadge(browser) {
  scenario = 'b'
  console.log('\n=== (b) a subscription larger than the limit shows "Would exceed available credit"')
  const w = await seed('b')
  const credit = await cardCredit(w.owner, w.B.id)
  const flagged = credit.checks.find((c) => c.source === 'budget_entry' && c.source_id === w.e.bigSub.id)
  check('(b) the API flags Big Sub at_risk', flagged?.status, 'at_risk')
  const { ctx, page } = await newPage(browser)
  await uiLogin(page, w.owner)
  await openAllocations(page)
  await checkVisible('(b) a warning row shows', page.locator('[data-testid="entry-credit-warning"]'))
  await settle(page)
  const big = entryCard(page, 'subscription', 'Big Sub')
  check('(b) Big Sub has one warning row', await big.locator('[data-testid="entry-credit-warning"]').count(), 1)
  const badge = big.locator('[data-testid="credit-check-badge"]')
  check('(b) it reads "Would exceed available credit"', [await text(badge), await attr(badge, 'data-status')], ['Would exceed available credit', 'at_risk'])
  const row = big.locator('[data-testid="entry-credit-warning"]')
  check('(b) it carries the API\'s occurrence date', await attr(row, 'data-occurrence'), flagged?.occurrence_date)
  check('(b) and says when', (await text(row.locator(':scope > span.text-muted')))?.startsWith(`on ${fmt(flagged?.occurrence_date ?? '')}`), true)
  for (const [key, name] of [['subscription', 'Small Sub'], ['bill', 'Power'], ['subscription', 'No Limit Sub'], ['bill', 'Paused Bill']]) {
    check(`(b) ${name} has no warning row`, await entryCard(page, key, name).locator('[data-testid="entry-credit-warning"]').count(), 0)
  }
  await ctx.close()
}

// ─── (c) Planned payment ─────────────────────────────────────────────────────
async function plannedPayment(browser) {
  scenario = 'c'
  console.log('\n=== (c) a planned payment shows "OK with planned payment by <date>"')
  const w = await seed('c')
  const { ctx, page } = await newPage(browser)
  await uiLogin(page, w.owner)
  await openAllocations(page)
  await checkVisible('(c) Medium Sub warns', entryCard(page, 'subscription', 'Medium Sub').locator('[data-testid="credit-check-badge"]'))
  check('(c) Medium Sub first reads "Would exceed available credit"',
    await text(entryCard(page, 'subscription', 'Medium Sub').locator('[data-testid="credit-check-badge"]')), 'Would exceed available credit')

  const before = await cardCredit(w.owner, w.C.id)
  const check0 = before.checks.find((c) => c.source === 'budget_entry' && c.source_id === w.e.mediumSub.id)
  const planned = addDays(w.today, 3)
  // Just enough that the subscription fits only with the payment.
  const amount = Math.ceil(-check0.available_after) + 1
  await post(w.owner.token, '/transactions/', {
    account_id: w.bank.id, transfer_from_account_id: w.bank.id, transfer_to_account_id: w.C.id, transaction_type: 'transfer', amount,
    description: 'Card payment', transaction_date: wire(planned), is_posted: false,
  })
  const after = await cardCredit(w.owner, w.C.id)
  const covered = after.checks.find((c) => c.source === 'budget_entry' && c.source_id === w.e.mediumSub.id)
  check('(c) the API says Medium Sub relies on the payment', [covered?.status, covered?.relies_on_planned], ['ok_with_planned', planned])
  await openAllocations(page)
  await checkVisible('(c) the OK badge shows', entryCard(page, 'subscription', 'Medium Sub').locator('[data-status="ok_with_planned"]'))
  const badge = entryCard(page, 'subscription', 'Medium Sub').locator('[data-testid="credit-check-badge"]')
  check('(c) the badge reads OK with planned payment by the date', [await text(badge), await attr(badge, 'data-status')],
    [`OK with planned payment by ${fmt(planned)}`, 'ok_with_planned'])
  check('(c) Card C\'s line carries the planned figure',
    await text(section(page, 'subscription').locator(`[data-testid="kind-credit-with-planned"][data-card-id="${w.C.id}"]`)),
    `${peso(after.available_with_planned)} with planned payment by ${fmt(planned)}`)
  await ctx.close()
}

// ─── (d) Every badge matches the API ─────────────────────────────────────────
async function parity(browser) {
  scenario = 'd'
  console.log('\n=== (d) every badge equals the severity rule on the API\'s checks')
  const w = await seed('d')
  const items = await creditItems(w.owner)
  const checksOf = (accountId) => items.find((c) => c.account_id === accountId)?.checks ?? []
  const { ctx, page } = await newPage(browser)
  await uiLogin(page, w.owner)
  await openAllocations(page)
  await checkVisible('(d) a warning row shows', page.locator('[data-testid="entry-credit-warning"]'))
  await settle(page)
  const entries = [
    ['subscription', 'Small Sub', w.e.smallSub, w.A], ['subscription', 'Big Sub', w.e.bigSub, w.B],
    ['subscription', 'Medium Sub', w.e.mediumSub, w.C], ['subscription', 'No Limit Sub', w.e.noLimit, w.N],
    ['bill', 'Power', w.e.power, w.A], ['bill', 'Capped Bill', w.e.cappedBill, w.B], ['bill', 'Paused Bill', w.e.pausedBill, w.C],
  ]
  for (const [key, name, entry, c] of entries) {
    check(`(d) ${name}: the badge matches the rule`, await renderedWarning(page, key, name), expectedWarning(checksOf(c.id), entry.id))
  }
  const capped = checksOf(w.B.id).filter((c) => c.source === 'budget_entry' && c.source_id === w.e.cappedBill.id)
  check('(d) the API lists exactly two Capped Bill checks, both at_risk', capped.map((c) => c.status), ['at_risk', 'at_risk'])
  check('(d) Capped Bill reads its first date and one more warning',
    (await renderedWarning(page, 'bill', 'Capped Bill'))?.note, `on ${fmt(addDays(w.today, 9))} · 1 more warning in the next 30 days`)
  await ctx.close()
}

// ─── (e) Who sees it ─────────────────────────────────────────────────────────
async function whoSees(browser) {
  scenario = 'e'
  console.log('\n=== (e) an editor, a viewer and a tag viewer see no credit text; an admin does')
  const w = await seed('e')
  const editor = await makeUser('e-editor')
  const viewer = await makeUser('e-viewer')
  const admin = await makeUser('e-admin')
  const tagViewer = await makeUser('e-tagviewer')

  // Big Sub and Card B carry the owner's Household tag, shared with the tag viewer.
  const household = (await get(w.owner.token, '/tags/')).find((t) => t.is_system)
  if (!household) throw new Error('STOP: the owner has no Household system tag')
  await put(w.owner.token, `/budget-entries/${w.e.bigSub.id}`, { tag_ids: [household.id] })
  await put(w.owner.token, `/accounts/${w.B.id}`, { tag_ids: [household.id] })
  for (const [u, role] of [[editor, 'editor'], [viewer, 'viewer'], [admin, 'admin']]) {
    await post(w.owner.token, `/accounts/${w.B.id}/shares`, { email: u.email, role })
  }
  await post(w.owner.token, '/tags/household/shares', { email: tagViewer.email })

  // The editor adds a subscription on Card B. It must be created, or the case is empty.
  const made = await api(editor.token, 'POST', '/budget-entries/', {
    entry_type: 'expense', currency: 'PHP', cadence: 'monthly', name: 'Editor Sub', amount: 50,
    next_occurrence: wire(addDays(w.today, 12)), account_id: w.B.id,
  })
  if (made.status !== 201) throw new Error(`STOP: the editor's POST /budget-entries/ answered ${made.status}, not 201: ${JSON.stringify(made.json)}`)

  // The viewer and the tag viewer each get an own subscription on a card with no limit,
  // so the Subscriptions section renders for them.
  for (const u of [viewer, tagViewer]) {
    const bank = await checking(u)
    const own = await card(u, bank, `${u.tag} Card`, undefined)
    await expense(u, { name: `${u.tag} Sub`, amount: 75, next_occurrence: wire(addDays(w.today, 6)), account_id: own.id })
  }

  for (const [who, u] of [['editor', editor], ['viewer', viewer], ['tag viewer', tagViewer]]) {
    console.log(`  -- ${who}`)
    check(`(e) ${who}: GET /cards/credit lists nothing`, await creditItems(u), [])
    const listed = await expenseEntries(u)
    const wanted = who === 'editor' ? listed.find((x) => x.name === 'Editor Sub') : listed.find((x) => x.id === w.e.bigSub.id)
    if (!wanted) throw new Error(`STOP: ${who} gets no expected entry from GET /budget-entries (${listed.map((x) => x.id).join(',')})`)
    if (who !== 'editor') check(`(e) ${who}: Big Sub is listed as limited`, wanted.view, 'limited')

    const { ctx, page } = await newPage(browser)
    const hold = await holdCredit(page)
    await uiLogin(page, u)
    const responses = [
      page.waitForResponse((r) => r.url().includes('/budget-entries') && r.url().includes('entry_type=expense') && r.request().method() === 'GET'),
      page.waitForResponse((r) => r.url().includes('/budget-entries') && r.url().includes('entry_type=income') && r.request().method() === 'GET'),
    ]
    await page.goto(`${stack.webUrl}/allocations`)
    await Promise.all(responses)
    await page.waitForTimeout(800) // the held request keeps the network from idling
    await checkVisible(`(e) ${who}: the Subscriptions section renders`, section(page, 'subscription'))
    if (who !== 'editor') {
      check(`(e) ${who}: a limited entry (Big Sub is one) renders under Shared with you`, (await section(page, 'shared').locator('article').count()) > 0, true)
    }
    check(`(e) ${who}: during the hold, no credit element`, await countOf(page, CREDIT_IDS), [0, 0, 0, 0, 0, 0])
    const failed = creditResponse(page, 500)
    hold.release('fail')
    await failed(`(e) ${who}`)
    await settle(page)
    check(`(e) ${who}: after the 500, still no credit element`, await countOf(page, CREDIT_IDS), [0, 0, 0, 0, 0, 0])
    await ctx.close()
  }

  console.log('  -- admin')
  const adminEntries = await expenseEntries(admin)
  const big = adminEntries.find((x) => x.id === w.e.bigSub.id)
  if (!big || big.view === 'limited') throw new Error(`STOP: the admin does not see Big Sub in full (${big ? big.view : 'missing'})`)
  const { ctx, page } = await newPage(browser)
  const hold = await holdCredit(page)
  await uiLogin(page, admin)
  await openAllocations(page)
  await checkVisible('(e) admin: during the hold the placeholder shows', section(page, 'subscription').locator('[data-testid="kind-credit-loading"]'))
  const passed = creditResponse(page, 200)
  hold.release('pass')
  await passed('(e) admin')
  await checkVisible('(e) admin: Card B\'s line shows', cardLine(page, 'subscription', w.B.id))
  const own = await cardCredit(admin, w.B.id)
  check('(e) admin: Card B\'s line equals the admin\'s own API figure',
    await text(cardLine(page, 'subscription', w.B.id).locator('[data-testid="kind-credit-available"]')), own && availText(own))
  await ctx.close()
}

// ─── (f) Loading, error, stale data ──────────────────────────────────────────
async function loadingAndErrors(browser) {
  scenario = 'f'
  console.log('\n=== (f) loading, error, and error with stale data')
  const w = await seed('f')
  const credit = await cardCredit(w.owner, w.A.id)

  // 1. Hold, then pass.
  {
    const { ctx, page } = await newPage(browser)
    const hold = await holdCredit(page)
    await uiLogin(page, w.owner)
    await openAllocations(page)
    await checkVisible('(f1) during the hold the placeholder shows', page.locator('[data-testid="kind-credit-loading"]'))
    check('(f1) during the hold there is no line and no warning row',
      [await page.locator('[data-testid="kind-credit-line"]').count(), await page.locator('[data-testid="entry-credit-warning"]').count()], [0, 0])
    check('(f1) and no zero figure', (await text(section(page, 'subscription')))?.includes('₱0.00'), false)
    const passed = creditResponse(page, 200)
    hold.release('pass')
    await passed('(f1)')
    await checkVisible('(f1) Card A\'s line shows', cardLine(page, 'subscription', w.A.id))
    check('(f1) Card A\'s line equals the API figure',
      await text(cardLine(page, 'subscription', w.A.id).locator('[data-testid="kind-credit-available"]')), availText(credit))
    await ctx.close()
  }

  // 2. Hold, then fail; Retry; 3. then stale data on the same page.
  {
    const { ctx, page } = await newPage(browser)
    const hold = await holdCredit(page)
    await uiLogin(page, w.owner)
    await openAllocations(page)
    const failed = creditResponse(page, 500)
    hold.release('fail')
    await failed('(f2)')
    await checkVisible('(f2) the error shows', page.locator('[data-testid="kind-credit-error"]'))
    check('(f2) the error says it could not load', (await text(page.locator('[data-testid="kind-credit-error"] p').first())), "Couldn't load available credit.")
    check('(f2) no line and no badge', [
      await page.locator('[data-testid="kind-credit-line"]').count(), await page.locator('[data-testid="credit-check-badge"]').count(),
    ], [0, 0])
    await page.unroute('**/cards/credit')
    const retried = creditResponse(page, 200)
    await page.locator('[data-testid="kind-credit-error"]').first().getByRole('button', { name: 'Retry' }).click({ timeout: 3000 }).catch(() => {})
    await retried('(f2) Retry')
    await checkVisible('(f2) after Retry Card A\'s line shows', cardLine(page, 'subscription', w.A.id))
    check('(f2) and equals the API figure',
      await text(cardLine(page, 'subscription', w.A.id).locator('[data-testid="kind-credit-available"]')), availText(credit))
    check('(f2) and Big Sub\'s badge is there', await entryCard(page, 'subscription', 'Big Sub').locator('[data-status="at_risk"]').count(), 1)

    // 3. The next fetch fails, with figures on screen.
    await page.route('**/cards/credit', (route) => route.fulfill({ status: 500, contentType: 'application/json', body: '{}' }))
    await page.locator('[data-onboarding="nav-accounts"]:visible').first().click()
    await page.waitForURL((url) => url.pathname === '/accounts')
    await settle(page)
    const stale = creditResponse(page, 500)
    await page.locator('[data-onboarding="nav-allocations"]:visible').first().click()
    await page.waitForURL((url) => url.pathname === '/allocations')
    await stale('(f3)')
    await checkVisible('(f3) the stale-data error shows', page.locator('[data-testid="kind-credit-error"]'))
    check('(f3) Card A\'s line still shows the earlier figure',
      await text(cardLine(page, 'subscription', w.A.id).locator('[data-testid="kind-credit-available"]')), availText(credit))
    check('(f3) Big Sub\'s badge is still there', await entryCard(page, 'subscription', 'Big Sub').locator('[data-status="at_risk"]').count(), 1)
    const err = page.locator('[data-testid="kind-credit-error"]').first()
    check('(f3) the error reads as a refresh failure', await text(err.locator('p')), "Couldn't refresh available credit. These figures may be out of date.")
    check('(f3) with a Retry button', await err.getByRole('button', { name: 'Retry' }).count(), 1)
    // The error follows the lines.
    check('(f3) the error comes after the lines', await page.locator('[data-testid="kind-credit-lines"]').first().evaluate(
      (el) => el.lastElementChild?.getAttribute('data-testid'), undefined, { timeout: READ_MS }).catch(() => null), 'kind-credit-error')
    await page.unroute('**/cards/credit')
    const retry2 = creditResponse(page, 200)
    await err.getByRole('button', { name: 'Retry' }).click({ timeout: 3000 }).catch(() => {})
    await retry2('(f3) Retry')
    await settle(page)
    check('(f3) after Retry the error is gone', await page.locator('[data-testid="kind-credit-error"]').count(), 0)
    check('(f3) and the line stays', await cardLine(page, 'subscription', w.A.id).count(), 1)
    await ctx.close()
  }
}

// ─── (g) Fresh fetch on client navigation ────────────────────────────────────
async function freshFetch(browser) {
  scenario = 'g'
  console.log('\n=== (g) a client-side move from Accounts fetches again, and the cached figure stays up')
  const w = await seed('g')
  const credit = await cardCredit(w.owner, w.A.id)
  const { ctx, page } = await newPage(browser)
  await uiLogin(page, w.owner)
  const warm = creditResponse(page, 200)
  await page.goto(`${stack.webUrl}/accounts`)
  await warm('(g) Accounts')
  await page.locator('[data-onboarding="nav-allocations"]:visible').first().waitFor()
  const hold = await holdCredit(page)
  const counter = countCreditRequests(page)
  const sent = creditRequest(page)
  await page.locator('[data-onboarding="nav-allocations"]:visible').first().click()
  await page.waitForURL((url) => url.pathname === '/allocations')
  await sent('(g) after the click')
  check('(g) one request was made after the click, with no reload', counter.n >= 1, true)
  await checkVisible('(g) during the refetch Card A\'s line shows the cached figure', cardLine(page, 'subscription', w.A.id))
  check('(g) it reads the cached figure', await text(cardLine(page, 'subscription', w.A.id).locator('[data-testid="kind-credit-available"]')), availText(credit))
  check('(g) and there is no placeholder', await page.locator('[data-testid="kind-credit-loading"]').count(), 0)
  const passed = creditResponse(page, 200)
  hold.release('pass')
  await passed('(g)')
  await settle(page)
  check('(g) after the response the line equals the API figure',
    await text(cardLine(page, 'subscription', w.A.id).locator('[data-testid="kind-credit-available"]')), availText(await cardCredit(w.owner, w.A.id)))
  await ctx.close()
}

// ─── (h) Day turn ────────────────────────────────────────────────────────────
async function dayTurn(browser) {
  scenario = 'h'
  console.log('\n=== (h) when Manila\'s day turns, credit is fetched again')
  const w = await seed('h')
  const { ctx, page } = await newPage(browser)
  // One minute before Manila's midnight at the end of today.
  await page.clock.install({ time: new Date(`${manilaToday()}T15:59:00Z`) })
  const first = creditResponse(page, 200)
  await uiLogin(page, w.owner)
  await openAllocations(page)
  await first('(h) first load')
  await settle(page)
  const counter = countCreditRequests(page)
  const next = creditResponse(page, undefined, 10000)
  await page.clock.fastForward('02:00')
  await next('(h) after midnight')
  check('(h) at least one more GET /cards/credit was made', counter.n >= 1, true)
  await ctx.close()
}

// ─── (i) Statuses the PHP stack cannot produce ───────────────────────────────
async function mockedStatuses(browser) {
  scenario = 'i'
  console.log('\n=== (i) "at most", unchecked and incomplete, through a mocked response')
  const w = await seed('i')
  const real = await cardCredit(w.owner, w.A.id)
  const { ctx, page } = await newPage(browser)
  await page.route('**/cards/credit', async (route) => {
    const res = await route.fetch()
    const json = await res.json()
    for (const item of json.items) {
      if (item.account_id !== w.A.id) continue
      item.complete = false
      for (const c of item.checks) {
        if (c.source === 'budget_entry' && c.source_id === w.e.smallSub.id) c.status = 'unchecked'
        if (c.source === 'budget_entry' && c.source_id === w.e.power.id) c.status = 'incomplete'
      }
    }
    await route.fulfill({ response: res, json })
  })
  await uiLogin(page, w.owner)
  await openAllocations(page)
  await checkVisible('(i) a card line shows', cardLine(page, 'subscription', w.A.id))
  await settle(page)
  check('(i) Card A reads "at most"', await text(cardLine(page, 'subscription', w.A.id).locator('[data-testid="kind-credit-available"]')), `at most ${peso(real.available_now)}`)
  const small = entryCard(page, 'subscription', 'Small Sub').locator('[data-testid="credit-check-badge"]')
  check('(i) Small Sub reads "No exchange rate: not checked"', [await text(small), await attr(small, 'data-status')], ['No exchange rate: not checked', 'unchecked'])
  const power = entryCard(page, 'bill', 'Power').locator('[data-testid="credit-check-badge"]')
  check('(i) Power reads "Credit check incomplete"', [await text(power), await attr(power, 'data-status')], ['Credit check incomplete', 'incomplete'])
  await ctx.close()
}

;(async () => {
  stack = await startLocalStack()
  API = `${stack.apiUrl}/api/v1`
  const browser = await chromium.launch()
  const run = (k) => !only || only === k
  if (run('a')) await cardLines(browser)
  if (run('b')) await exceedBadge(browser)
  if (run('c')) await plannedPayment(browser)
  if (run('d')) await parity(browser)
  if (run('e')) await whoSees(browser)
  if (run('f')) await loadingAndErrors(browser)
  if (run('g')) await freshFetch(browser)
  if (run('h')) await dayTurn(browser)
  if (run('i')) await mockedStatuses(browser)
  await browser.close()
  stack.stop()
  console.log('\nPer scenario:')
  for (const [k, s] of Object.entries(perScenario)) console.log(`  (${k}) ${s.pass}/${s.total}`)
  console.log(`\nRESULT: ${pass}/${total} assertions passed`)
  process.exit(pass === total ? 0 : 1)
})().catch((e) => { console.error(e); stack?.stop(); console.log(`\nRESULT (aborted): ${pass}/${total} assertions passed`); process.exit(1) })
