// Browser check for STU-343 Plan C: Pay a credit card from its account page, with a
// suggested Full or Minimum amount. Starts its own API and web app against a throwaway
// database (./_local_stack.cjs). PHP only, so no exchange rate is fetched. Not wired
// into CI and not part of `pnpm build`. Run steps: see ./README.md.
//
// Every expected figure is read from the API (GET /cards/{id}/credit), never
// hard-coded; dates are relative to the Manila today. Each card closes on the Manila
// day-of-month of (today - 5), clamped to 1-28, is due 21 days later, carries the BDO
// minimum due rule and has its debits dated close - 3.
//
// Scenarios (account page):
//   (b) another amount on today + 7 is recorded pending, and the planned flag shows
//   (c) entering the statement's minimum makes the dialog's Minimum read "from your statement"
//   (e) a USD account is not offered, and a direct POST from it is 400
//   (f) an editor and a viewer get no credit panel, and POST is 404
//   (g) an amount above Full shows the "more than the <close> statement" note and is
//       recorded in full
//   (j) in a UTC browser at about 18:00Z, the dialog's default date is Manila's day and
//       its statement is the API's latest
//   (k) when Manila's day turns with the page open, the panel and the dialog refetch and
//       move to the statement that just closed, without a reload
//   (l) an inactive card's Pay says so; with no account to pay from, the dialog says so
//
// Usage: node frontend/e2e/card-pay.cjs [b|c|e|f|g|j|k|l]
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
const manilaDay = (ms) => new Date(ms + 8 * 3600 * 1000).toISOString().slice(0, 10)
const manilaToday = () => manilaDay(Date.now())
const addDays = (day, n) => {
  const d = new Date(`${day}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().slice(0, 10)
}
/** The same day-of-month one month earlier (the day is at most 28). */
const monthBefore = (day) => {
  const d = new Date(`${day}T00:00:00Z`)
  d.setUTCMonth(d.getUTCMonth() - 1)
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
  const email = `e2e-pay-${tag}-${Math.random().toString(16).slice(2, 8)}@example.com`
  const password = 'E2eTest!2345'
  const reg = await api('', 'POST', '/auth/register', { email, password, first_name: `User${tag}`, last_name: 'Test', default_currency: 'PHP' })
  if (reg.status !== 200 && reg.status !== 201) throw new Error(`register ${reg.status} ${JSON.stringify(reg.json)}`)
  stack.verifyUser(email) // aborts the run unless psql reports UPDATE 1
  const login = await api('', 'POST', '/auth/login', { email, password })
  if (login.status !== 200) throw new Error(`login ${login.status}`)
  return { email, password, tag, token: login.json.access_token }
}
const account = (u, name, currency = 'PHP', balance = 100000) =>
  post(u.token, '/accounts/', { name, account_type: 'checking', balance, currency })
const debit = (u, cardId, amount, day, description) => post(u.token, '/transactions/', {
  account_id: cardId, transaction_type: 'debit', amount, description, transaction_date: wire(day), is_posted: true,
})
const detailOf = (u, cardId) => get(u.token, `/cards/${cardId}/credit`)
const latest = (detail) => detail.statements[detail.statements.length - 1]

// The close day: Manila's (today - 5), its day-of-month clamped to 28 (earlier, so
// still closed).
let today, closeDom, close, prevClose, bdoRule
let owner, bank, usd

/** A card closing on `closeDom`, due 21 days later, BDO rule, paid from `payer` when given. */
async function makeCard(u, name, { payer = null, limit = 50000, debits = [[2000, close]] } = {}) {
  const created = await post(u.token, '/accounts/', {
    name, account_type: 'credit', balance: 0, currency: 'PHP', credit_limit: limit,
    billing_cycle_start: closeDom, days_until_due_date: 21, minimum_due_rule: bdoRule,
    ...(payer ? { payment_account_id: payer.id } : {}),
  })
  for (const [amount, cycleClose] of debits) await debit(u, created.id, amount, addDays(cycleClose, -3), `${name} purchase`)
  return created
}

async function newPage(browser, options = {}) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 1000 }, ...options })
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

const settle = async (page) => { await page.waitForLoadState('networkidle'); await page.waitForTimeout(300) }
async function openAccount(page, accountId) {
  await page.goto(`${stack.webUrl}/accounts/${accountId}`)
  await page.locator('[data-testid="account-detail"]').waitFor()
  await settle(page)
}
async function openPanel(page, cardId) {
  await openAccount(page, cardId)
  await page.locator('[data-testid="card-credit-panel"]').waitFor()
}
async function openDialog(page) {
  await page.locator('[data-testid="card-pay-open"]').click()
  const dialog = page.locator('[data-testid="card-pay-dialog"]')
  await dialog.locator('[data-testid="card-pay-amount"]').waitFor()
  return dialog
}
const text = async (locator) => (await locator.textContent())?.replace(/\s+/g, ' ').trim()
const payResponse = (page, cardId) =>
  page.waitForResponse((r) => r.request().method() === 'POST' && new URL(r.url()).pathname.endsWith(`/cards/${cardId}/payments`))

async function setup() {
  today = manilaToday()
  const anchor = addDays(today, -5)
  closeDom = Math.min(Number(anchor.slice(8, 10)), 28)
  close = `${anchor.slice(0, 8)}${String(closeDom).padStart(2, '0')}`
  prevClose = monthBefore(close)
  console.log(`    Manila today ${today}; cards close on day ${closeDom}; latest close ${close}, previous ${prevClose}`)
  owner = await makeUser('owner')
  const presets = await get(owner.token, '/accounts/minimum-due-presets')
  bdoRule = presets.find((p) => p.key === 'bdo').rule
  bank = await account(owner, 'owner Checking')
  usd = await account(owner, 'owner Dollars', 'USD', 1000)
}

// (b) Another amount on today + 7 is recorded pending and flagged as planned.
async function plannedPayment(browser) {
  console.log('\n=== (b) another amount on today + 7 is pending, and the planned flag shows')
  const card = await makeCard(owner, 'Card B', { payer: bank })
  const before = latest(await detailOf(owner, card.id))
  check('(b) the card has a closed statement owed', [before?.close_date, before?.clear_through > 0], [close, true])
  const day = addDays(today, 7)
  const { ctx, page } = await newPage(browser)
  await uiLogin(page, owner)
  await openPanel(page, card.id)
  const dialog = await openDialog(page)
  check('(b) Full is prefilled', Number(await dialog.locator('[data-testid="card-pay-amount"]').inputValue()), before.clear_through)
  check('(b) the payer defaults to the card\'s payment account', Number(await dialog.locator('[data-testid="card-pay-from"]').inputValue()), bank.id)
  await dialog.locator('[data-testid="card-pay-amount"]').fill('500')
  await dialog.locator('[data-testid="card-pay-date"]').fill(day)
  check('(b) the dialog flags a planned payment', await text(dialog.locator('[data-testid="card-pay-planned-note"]')),
    `Planned payment: counts toward available credit from ${fmt(day)}`)
  const paid = payResponse(page, card.id)
  await dialog.locator('[data-testid="card-pay-submit"]').click()
  const res = await paid
  const txn = await res.json()
  check('(b) the payment is 201', res.status(), 201)
  check('(b) recorded pending, on the day, for the amount', [txn.is_posted, txn.transaction_date.slice(0, 10), txn.amount], [false, day, 500])
  await dialog.waitFor({ state: 'detached' })
  const credit = (await detailOf(owner, card.id)).credit
  check('(b) the API counts the planned payment', credit.planned_by, day)
  await page.locator('[data-testid="card-credit-panel"] [data-testid="credit-with-planned"]').waitFor()
  check('(b) the panel shows the planned flag', await text(page.locator('[data-testid="card-credit-panel"] [data-testid="credit-with-planned"]')),
    `${peso(credit.available_with_planned)} with planned payment by ${fmt(day)}`)
  await ctx.close()
}

// (c) The statement's own minimum replaces the estimate in the dialog.
async function overrideMinimum(browser) {
  console.log('\n=== (c) entering the statement\'s minimum makes Minimum read "from your statement"')
  const card = await makeCard(owner, 'Card C', { payer: bank })
  const before = latest(await detailOf(owner, card.id))
  check('(c) the API estimates the minimum first', before.minimum_due.source, 'estimate')
  const { ctx, page } = await newPage(browser)
  await uiLogin(page, owner)
  await openPanel(page, card.id)
  const row = page.locator(`[data-testid="card-statement"][data-close="${close}"]`)
  check('(c) the panel lists the closed statement as an estimate', await text(row.locator('[data-testid="card-statement-minimum-source"]')), '(estimate)')
  check('(c) with the fee hint', await row.locator('[data-testid="card-statement-fee-hint"]').count(), 1)
  let dialog = await openDialog(page)
  check('(c) the dialog\'s Minimum starts as an estimate', await text(dialog.locator('[data-testid="card-pay-minimum-source"]')), '(estimate)')
  await dialog.getByRole('button', { name: 'Cancel' }).click()
  await dialog.waitFor({ state: 'detached' })

  await row.locator('[data-testid="card-minimum-edit"]').click()
  await row.locator('[data-testid="card-minimum-input"]').fill('321.45')
  const saved = page.waitForResponse((r) => r.request().method() === 'PUT' && r.url().includes(`/cards/${card.id}/statements/${close}/minimum-due`))
  await row.locator('[data-testid="card-minimum-save"]').click()
  check('(c) the save is 200', (await saved).status(), 200)
  await row.locator('[data-testid="card-minimum-clear"]').waitFor()
  const after = latest(await detailOf(owner, card.id))
  check('(c) the API now takes the minimum from the statement', [after.minimum_due.source, after.minimum_due.amount], ['statement', 321.45])
  check('(c) the panel reads "from your statement"', await text(row.locator('[data-testid="card-statement-minimum-source"]')), '(from your statement)')
  dialog = await openDialog(page)
  check('(c) the dialog\'s Minimum reads "from your statement"', await text(dialog.locator('[data-testid="card-pay-minimum-source"]')), '(from your statement)')
  check('(c) for the API\'s remaining', (await text(dialog.locator('[data-testid="card-pay-minimum"]')))?.startsWith(`Minimum ${peso(after.minimum_due.remaining)}`), true)
  await dialog.locator('[data-testid="card-pay-minimum"]').click()
  check('(c) choosing Minimum fills that amount', Number(await dialog.locator('[data-testid="card-pay-amount"]').inputValue()), after.minimum_due.remaining)
  await ctx.close()
}

// (e) A USD account can't pay a PHP card.
async function foreignPayer(browser) {
  console.log('\n=== (e) a USD account is not offered, and a direct POST is 400')
  const card = await makeCard(owner, 'Card E', { payer: bank })
  const { ctx, page } = await newPage(browser)
  await uiLogin(page, owner)
  await openPanel(page, card.id)
  const dialog = await openDialog(page)
  const options = await dialog.locator('[data-testid="card-pay-from"] option').allTextContents()
  check('(e) the PHP account is offered', options.includes(bank.name), true)
  check('(e) the USD account is not', options.includes(usd.name), false)
  await ctx.close()
  const direct = await api(owner.token, 'POST', `/cards/${card.id}/payments`, { amount: 100, from_account_id: usd.id, payment_date: today })
  check('(e) a direct POST from the USD account is 400', direct.status, 400)
  check('(e) and says to pay from a PHP account', String(direct.json?.detail).startsWith('Pay this card from a PHP account'), true)
}

// (f) Only an owner or admin gets the panel and may Pay.
async function othersGetNoPanel(browser) {
  console.log('\n=== (f) an editor and a viewer get no credit panel, and POST is 404')
  const card = await makeCard(owner, 'Card F', { payer: bank })
  const editor = await makeUser('editor')
  const viewer = await makeUser('viewer')
  await post(owner.token, `/accounts/${card.id}/shares`, { email: editor.email, role: 'editor' })
  await post(owner.token, `/accounts/${card.id}/shares`, { email: viewer.email, role: 'viewer' })
  for (const [who, u] of [['editor', editor], ['viewer', viewer]]) {
    const own = await account(u, `${who} Checking`)
    const { ctx, page } = await newPage(browser)
    await uiLogin(page, u)
    await openAccount(page, card.id)
    check(`(f) ${who}: the account page shows the card`, await text(page.locator('[data-testid="account-detail-title"]')), 'Card F')
    check(`(f) ${who}: no credit panel and no Pay`,
      await page.locator('[data-testid="card-credit-panel"], [data-testid="card-pay-open"], [data-testid="card-credit-panel-loading"]').count(), 0)
    await ctx.close()
    const direct = await api(u.token, 'POST', `/cards/${card.id}/payments`, { amount: 100, from_account_id: own.id, payment_date: today })
    check(`(f) ${who}: POST /cards/{id}/payments is 404`, direct.status, 404)
  }
}

// (g) An amount above Full pays the next statement too, and is recorded in full.
async function excessAmount(browser) {
  console.log('\n=== (g) an amount above Full shows the excess note and is recorded in full')
  const card = await makeCard(owner, 'Card G', { payer: bank })
  const full = latest(await detailOf(owner, card.id)).clear_through
  const amount = full + 1000
  const { ctx, page } = await newPage(browser)
  await uiLogin(page, owner)
  await openPanel(page, card.id)
  const dialog = await openDialog(page)
  check('(g) no excess note at Full', await dialog.locator('[data-testid="card-pay-excess-note"]').count(), 0)
  await dialog.locator('[data-testid="card-pay-amount"]').fill(String(amount))
  check('(g) the excess note names the statement', await text(dialog.locator('[data-testid="card-pay-excess-note"]')),
    `${peso(1000)} more than the ${fmt(close)} statement; the rest pays your next statement.`)
  check('(g) today is not a planned payment', await dialog.locator('[data-testid="card-pay-planned-note"]').count(), 0)
  const paid = payResponse(page, card.id)
  await dialog.locator('[data-testid="card-pay-submit"]').click()
  const res = await paid
  const txn = await res.json()
  check('(g) recorded in full and posted today', [res.status(), txn.amount, txn.is_posted, txn.transaction_date.slice(0, 10)], [201, amount, true, today])
  await dialog.waitFor({ state: 'detached' })
  check('(g) the statement is cleared', latest(await detailOf(owner, card.id)).clear_through, 0)
  await ctx.close()
}

// (j) The dialog uses Manila's day, not the browser's.
async function manilaDayInUtc(browser) {
  console.log('\n=== (j) in a UTC browser at about 18:00Z the default date is Manila\'s day')
  const card = await makeCard(owner, 'Card J', { payer: bank })
  const apiLatest = latest(await detailOf(owner, card.id))
  const instant = new Date(`${new Date().toISOString().slice(0, 10)}T18:00:00Z`)
  const expected = manilaDay(instant.getTime())
  console.log(`    browser clock ${instant.toISOString()}: UTC day ${instant.toISOString().slice(0, 10)}, Manila day ${expected}`)
  const { ctx, page } = await newPage(browser, { timezoneId: 'UTC' })
  await page.clock.setFixedTime(instant)
  await uiLogin(page, owner)
  check('(j) the browser\'s own day is the UTC day', await page.evaluate(() => {
    const d = new Date()
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  }), instant.toISOString().slice(0, 10))
  await openPanel(page, card.id)
  const dialog = await openDialog(page)
  check('(j) the default date is Manila\'s day for that instant', await dialog.locator('[data-testid="card-pay-date"]').inputValue(), expected)
  check('(j) the statement is the API\'s latest', await text(dialog.locator('[data-testid="card-pay-title"]')),
    `Pay Card J: ${fmt(apiLatest.close_date)} statement, due ${fmt(apiLatest.due_date)}`)
  check('(j) Full is its clear_through', Number(await dialog.locator('[data-testid="card-pay-amount"]').inputValue()), apiLatest.clear_through)
  await ctx.close()
}

// (k) Manila's midnight passes with the page open.
async function dayRollover(browser) {
  console.log('\n=== (k) when Manila\'s day turns, the panel and the dialog move to the statement that just closed')
  const card = await makeCard(owner, 'Card K', { payer: bank, debits: [[1000, prevClose], [2000, close]] })
  const detail = await detailOf(owner, card.id)
  const older = detail.statements.find((s) => s.close_date === prevClose)
  const newer = detail.statements.find((s) => s.close_date === close)
  check('(k) the API lists both closed statements', [older?.clear_through > 0, newer?.clear_through > older?.clear_through], [true, true])
  // The browser's clock one minute before Manila's midnight at the end of the latest
  // close day: to the browser, that statement closes today and is not closed yet.
  const { ctx, page } = await newPage(browser)
  await page.clock.install({ time: new Date(`${close}T15:59:00Z`) })
  await uiLogin(page, owner)
  await openPanel(page, card.id)
  const panel = page.locator('[data-testid="card-credit-panel"]')
  check('(k) before midnight the panel lists only the older statement',
    await panel.locator('[data-testid="card-statement"]').evaluateAll((rows) => rows.map((r) => r.getAttribute('data-close'))), [prevClose])
  const dialog = await openDialog(page)
  check('(k) before midnight the dialog suggests the older statement', await text(dialog.locator('[data-testid="card-pay-title"]')),
    `Pay Card K: ${fmt(prevClose)} statement, due ${fmt(older.due_date)}`)
  check('(k) and its Full', Number(await dialog.locator('[data-testid="card-pay-amount"]').inputValue()), older.clear_through)
  check('(k) and the date is that day', await dialog.locator('[data-testid="card-pay-date"]').inputValue(), close)

  let refetches = 0
  page.on('response', (r) => { if (r.request().method() === 'GET' && new URL(r.url()).pathname.endsWith(`/cards/${card.id}/credit`)) refetches++ })
  await page.clock.fastForward('02:00')
  await dialog.locator('[data-testid="card-pay-title"]').filter({ hasText: fmt(close) }).waitFor({ timeout: 10000 })
  await settle(page)
  check('(k) after midnight the card detail was refetched', refetches > 0, true)
  check('(k) the dialog suggests the statement that just closed', await text(dialog.locator('[data-testid="card-pay-title"]')),
    `Pay Card K: ${fmt(close)} statement, due ${fmt(newer.due_date)}`)
  check('(k) Full follows it', Number(await dialog.locator('[data-testid="card-pay-amount"]').inputValue()), newer.clear_through)
  check('(k) the date rolls over', await dialog.locator('[data-testid="card-pay-date"]').inputValue(), addDays(close, 1))
  await dialog.getByRole('button', { name: 'Cancel' }).click()
  check('(k) the panel lists both statements, newest first',
    await panel.locator('[data-testid="card-statement"]').evaluateAll((rows) => rows.map((r) => r.getAttribute('data-close'))), [close, prevClose])
  await ctx.close()
}

// (l) The edge states: an inactive card, and no account to pay from.
async function edgeStates(browser) {
  console.log('\n=== (l) an inactive card says so; with no account to pay from, the dialog says so')
  const inactive = await makeCard(owner, 'Card L inactive', { debits: [] })
  await put(owner.token, `/accounts/${inactive.id}`, { is_active: false })
  const solo = await makeUser('solo')
  await account(solo, 'solo Dollars', 'USD', 1000)
  const lonely = await makeCard(solo, 'Card L lonely')

  const { ctx, page } = await newPage(browser)
  await uiLogin(page, owner)
  await openPanel(page, inactive.id)
  check('(l) an inactive card disables Pay and says why',
    [await page.locator('[data-testid="card-pay-open"]').isDisabled(), await text(page.locator('[data-testid="card-pay-disabled-reason"]'))],
    [true, 'This card is inactive'])
  await ctx.close()

  const second = await newPage(browser)
  await uiLogin(second.page, solo)
  await openPanel(second.page, lonely.id)
  const dialog = await openDialog(second.page)
  check('(l) with no eligible payer the dialog says so and cannot submit',
    [await text(dialog.locator('[data-testid="card-pay-no-payer"]')), await dialog.locator('[data-testid="card-pay-submit"]').isDisabled()],
    ['No PHP account you can pay from.', true])
  await second.ctx.close()
}

;(async () => {
  stack = await startLocalStack()
  API = `${stack.apiUrl}/api/v1`
  const browser = await chromium.launch()
  const run = (k) => !only || only === k
  await setup()
  if (run('b')) await plannedPayment(browser)
  if (run('c')) await overrideMinimum(browser)
  if (run('e')) await foreignPayer(browser)
  if (run('f')) await othersGetNoPanel(browser)
  if (run('g')) await excessAmount(browser)
  if (run('j')) await manilaDayInUtc(browser)
  if (run('k')) await dayRollover(browser)
  if (run('l')) await edgeStates(browser)
  await browser.close()
  stack.stop()
  console.log(`\nRESULT: ${pass}/${total} assertions passed`)
  process.exit(pass === total ? 0 : 1)
})().catch((e) => { console.error(e); stack?.stop(); console.log(`\nRESULT (aborted): ${pass}/${total} assertions passed`); process.exit(1) })
