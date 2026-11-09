// Browser check for STU-578 PR 3: the dashboard's Quick balances section. Starts its own
// API and web app against a throwaway database (./_local_stack.cjs). PHP only, so no
// exchange rate is fetched. Not wired into CI and not part of `pnpm build`. Run steps: see
// ./README.md.
//
// Every expected figure is read from the API (GET /dashboard/quick-balances and
// GET /cards/{id}/credit), never hard-coded; dates are relative to the Manila today. The
// owner holds Security Bank (checking), BDO Amex (a card with a limit, a closed statement
// and charges not yet on one), BDO Platinum Mastercard (linked to the Amex's limit) and
// GCash (e-wallet). With no pins the section shows the defaults, in slot order.
//
// Scenarios:
//   (a) the section sits above the Cash-Flow Timeline, owner-shape tiles in slot order
//   (b) the card tile shows Due with its date, the Unbilled line, then Available with
//       "shared with BDO Platinum Mastercard"; the other tiles show their balance
//   (c) tapping a tile opens /accounts/<id>
//   (d) at 390px: 2 columns, the credit tile spans the row, no horizontal scroll, 44px targets
//   (e) a failed quick-balances request shows the section's Retry while the rest of the
//       dashboard renders; Retry loads the tiles
//   (f) recording a payment from Security Bank to the card updates both tiles without a
//       reload
//   (g) a user with no card and no e-wallet sees one tile; a user with no accounts sees
//       no section
//
// Usage: node frontend/e2e/quick-balances.cjs [a|b|c|d|e|f|g]
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
const manilaToday = () => new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10)
const addDays = (day, n) => {
  const d = new Date(`${day}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().slice(0, 10)
}
/** As a tile shows a due date: "Nov 25". */
const short = (day) => {
  const d = new Date(`${day}T00:00:00Z`)
  return `${new Intl.DateTimeFormat('en-US', { month: 'short', timeZone: 'UTC' }).format(d)} ${d.getUTCDate()}`
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
async function get(token, url) {
  const r = await api(token, 'GET', url)
  if (r.status >= 300) throw new Error(`GET ${url} ${r.status} ${JSON.stringify(r.json)}`)
  return r.json
}
async function makeUser(tag) {
  const email = `e2e-qb-${tag}-${Math.random().toString(16).slice(2, 8)}@example.com`
  const password = 'E2eTest!2345'
  const reg = await api('', 'POST', '/auth/register', { email, password, first_name: `User${tag}`, last_name: 'Test', default_currency: 'PHP' })
  if (reg.status !== 200 && reg.status !== 201) throw new Error(`register ${reg.status} ${JSON.stringify(reg.json)}`)
  stack.verifyUser(email) // aborts the run unless psql reports UPDATE 1
  const login = await api('', 'POST', '/auth/login', { email, password })
  if (login.status !== 200) throw new Error(`login ${login.status}`)
  return { email, password, tag, token: login.json.access_token }
}
const debit = (u, accountId, amount, day, description) => post(u.token, '/transactions/', {
  account_id: accountId, transaction_type: 'debit', amount, description, transaction_date: wire(day), is_posted: true,
})
const quick = (u) => get(u.token, '/dashboard/quick-balances')

// The close day: Manila's (today - 5), its day-of-month clamped to 28 (so already closed).
let today, closeDom, close, owner, bank, amex, platinum, gcash

async function setup() {
  today = manilaToday()
  const anchor = addDays(today, -5)
  closeDom = Math.min(Number(anchor.slice(8, 10)), 28)
  close = `${anchor.slice(0, 8)}${String(closeDom).padStart(2, '0')}`
  console.log(`    Manila today ${today}; the Amex closes on day ${closeDom}; latest close ${close}`)
  owner = await makeUser('owner')
  bank = await post(owner.token, '/accounts/', { name: 'Security Bank', account_type: 'checking', balance: 84210.55, currency: 'PHP' })
  gcash = await post(owner.token, '/accounts/', { name: 'GCash', account_type: 'e_wallet', balance: 3402.1, currency: 'PHP' })
  const presets = await get(owner.token, '/accounts/minimum-due-presets')
  amex = await post(owner.token, '/accounts/', {
    name: 'BDO Amex', account_type: 'credit', balance: 0, currency: 'PHP', credit_limit: 400000,
    billing_cycle_start: closeDom, days_until_due_date: 21, minimum_due_rule: presets.find((p) => p.key === 'bdo').rule,
    payment_account_id: bank.id,
  })
  platinum = await post(owner.token, '/accounts/', {
    name: 'BDO Platinum Mastercard', account_type: 'credit', balance: 0, currency: 'PHP', shares_limit_with_account_id: amex.id,
  })
  // On the closed statement, and one charge after the close (not on a statement yet).
  await debit(owner, amex.id, 20000, addDays(close, -3), 'Amex statement purchase')
  await debit(owner, amex.id, 4500.25, addDays(close, 1), 'Amex unbilled purchase')
  await debit(owner, platinum.id, 300, addDays(close, 1), 'Platinum purchase')
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
const text = async (locator) => ((await locator.textContent()) || '').replace(/\s+/g, ' ').trim()
const tiles = (page) => page.locator('[data-testid="quick-balance-tile"]')
const tile = (page, accountId) => page.locator(`[data-testid="quick-balance-tile"][data-account-id="${accountId}"]`)
async function openDashboard(page) {
  await page.locator('[data-testid="quick-balance-tile"]').first().waitFor()
  await settle(page)
}
const tileIds = async (page) => (await tiles(page).evaluateAll((els) => els.map((e) => Number(e.getAttribute('data-account-id')))))

// (a) Above the Cash-Flow Timeline, in slot order.
async function placement(browser) {
  console.log('\n=== (a) the section sits above the Cash-Flow Timeline, owner-shape tiles in slot order')
  const body = await quick(owner)
  check('(a) the API has no pins and the defaults in slot order', [body.pinned, body.tiles.map((t) => [t.account_id, t.slot])],
    [false, [[bank.id, 'debit'], [amex.id, 'credit'], [gcash.id, 'e_wallet']]])
  const { ctx, page } = await newPage(browser)
  await uiLogin(page, owner)
  await openDashboard(page)
  check('(a) the tiles are Security Bank, BDO Amex, GCash, in that order', await tileIds(page), [bank.id, amex.id, gcash.id])
  const before = await page.evaluate(() => {
    const section = document.querySelector('[data-testid="quick-balances"]')
    const timeline = document.querySelector('[data-onboarding="cashflow-timeline"]')
    return !!section && !!timeline && !!(section.compareDocumentPosition(timeline) & Node.DOCUMENT_POSITION_FOLLOWING)
  })
  check('(a) the section comes before the Cash-Flow Timeline in the page', before, true)
  check('(a) the heading', await text(page.locator('#quick-balances-heading')), 'Quick balances')
  await ctx.close()
}

// (b) The tile figures.
async function figures(browser) {
  console.log('\n=== (b) the card tile shows Due with its date, Unbilled, then Available shared with the Platinum')
  const body = await quick(owner)
  const card = body.tiles.find((t) => t.account_id === amex.id)
  const detail = await get(owner.token, `/cards/${amex.id}/credit`)
  const latest = detail.statements[detail.statements.length - 1]
  check('(b) the API has a closed statement owed, with the due date', [latest.close_date, latest.clear_through > 0], [close, true])
  check('(b) the API tile carries that statement and the unbilled charge',
    [card.card.amount_due, card.card.due_date, card.card.overdue, card.card.unbilled], [latest.clear_through, latest.due_date, false, 4500.25])
  const { ctx, page } = await newPage(browser)
  await uiLogin(page, owner)
  await openDashboard(page)
  const amexTile = tile(page, amex.id)
  check('(b) the card tile names the account and its group', [await text(amexTile.locator('[data-testid="quick-balance-name"]')), (await text(amexTile)).startsWith('Credit')], ['BDO Amex', true])
  check('(b) Due shows the statement amount with its due date', await text(amexTile.locator('[data-testid="quick-balance-due"]')),
    `Due ${peso(latest.clear_through)} · ${short(latest.due_date.slice(0, 10))}`)
  check('(b) Unbilled shows the charges not yet on a statement', await text(amexTile.locator('[data-testid="quick-balance-unbilled"]')), `Unbilled ${peso(4500.25)}`)
  check('(b) Available shows the shared limit\'s figure', await text(amexTile.locator('[data-testid="quick-balance-available"]')), `Available ${peso(card.credit.available_now)}`)
  check('(b) shared with the Platinum', await text(amexTile.locator('[data-testid="quick-balance-shared"]')), 'shared with BDO Platinum Mastercard')
  check('(b) the lines read in order: Due, Unbilled, Available, shared',
    await amexTile.locator('[data-testid^="quick-balance-"][data-testid$="due"], [data-testid="quick-balance-unbilled"], [data-testid="quick-balance-available"], [data-testid="quick-balance-shared"]').evaluateAll((els) => els.map((e) => e.getAttribute('data-testid'))),
    ['quick-balance-due', 'quick-balance-unbilled', 'quick-balance-available', 'quick-balance-shared'])
  check('(b) the debit tile shows its balance', await text(tile(page, bank.id).locator('[data-testid="quick-balance-balance"]')), peso(84210.55))
  check('(b) the e-wallet tile shows its balance and its group', [await text(tile(page, gcash.id).locator('[data-testid="quick-balance-balance"]')), (await text(tile(page, gcash.id))).startsWith('E-wallet')], [peso(3402.1), true])
  await ctx.close()
}

// (c) A tile is a link to the account.
async function tapTile(browser) {
  console.log('\n=== (c) tapping a tile opens /accounts/<id>')
  const { ctx, page } = await newPage(browser)
  await uiLogin(page, owner)
  await openDashboard(page)
  await tile(page, amex.id).click()
  await page.waitForURL((url) => url.pathname === `/accounts/${amex.id}`)
  check('(c) the card tile opens the card\'s page', new URL(page.url()).pathname, `/accounts/${amex.id}`)
  await page.locator('[data-testid="account-detail"]').waitFor()
  await page.goBack()
  await openDashboard(page)
  await tile(page, bank.id).click()
  await page.waitForURL((url) => url.pathname === `/accounts/${bank.id}`)
  check('(c) the debit tile opens its page', new URL(page.url()).pathname, `/accounts/${bank.id}`)
  await ctx.close()
}

// (d) Phone layout.
async function phone(browser) {
  console.log('\n=== (d) at 390px: 2 columns, the credit tile spans the row, no horizontal scroll, 44px targets')
  const { ctx, page } = await newPage(browser, { viewport: { width: 390, height: 844 } })
  await uiLogin(page, owner)
  await openDashboard(page)
  const m = await page.evaluate(() => {
    const grid = document.querySelector('[data-testid="quick-balance-tile"]').parentElement
    const rect = (id) => {
      const r = document.querySelector(`[data-testid="quick-balance-tile"][data-type="${id}"]`).getBoundingClientRect()
      return { x: r.x, w: r.width, h: r.height }
    }
    const g = grid.getBoundingClientRect()
    return {
      columns: getComputedStyle(grid).gridTemplateColumns.split(' ').length,
      gridWidth: g.width,
      checking: rect('checking'), credit: rect('credit'), wallet: rect('e_wallet'),
      scrollW: document.documentElement.scrollWidth, clientW: document.documentElement.clientWidth,
      heights: [...document.querySelectorAll('[data-testid="quick-balance-tile"]')].map((e) => e.getBoundingClientRect().height),
    }
  })
  check('(d) the grid has 2 columns', m.columns, 2)
  check('(d) the credit tile spans the row', Math.abs(m.credit.w - m.gridWidth) < 1, true)
  check('(d) the other tiles take one column each', [m.checking.w < m.gridWidth * 0.6, m.wallet.w < m.gridWidth * 0.6], [true, true])
  check('(d) no horizontal scroll', m.scrollW <= m.clientW, true)
  check('(d) every tile is at least 44px tall', m.heights.every((h) => h >= 44), true)
  await ctx.close()
}

// (e) The section fails alone.
async function failure(browser) {
  console.log('\n=== (e) a failed quick-balances request shows Retry while the rest of the dashboard renders')
  const { ctx, page } = await newPage(browser)
  let fail = true
  await page.route('**/dashboard/quick-balances', (route) => (fail
    ? route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ detail: 'boom' }) })
    : route.continue()))
  await uiLogin(page, owner)
  await page.locator('[data-testid="quick-balances-error"]').waitFor()
  await settle(page)
  check('(e) the section says it could not load', await text(page.locator('[data-testid="quick-balances-error"] p')), 'Couldn\'t load balances')
  check('(e) no tiles', await tiles(page).count(), 0)
  check('(e) the rest of the dashboard renders', [
    await page.locator('[data-onboarding="cashflow-timeline"]').count(),
    await page.locator('[data-onboarding="financial-snapshot"]').count(),
    await page.locator('[data-testid="dashboard-retry"]').count(),
  ], [1, 1, 0])
  const retry = page.locator('[data-testid="quick-balances-retry"]')
  check('(e) Retry is at least 44px tall', (await retry.boundingBox()).height >= 44, true)
  fail = false
  await retry.click()
  await openDashboard(page)
  check('(e) Retry loads the tiles', await tileIds(page), [bank.id, amex.id, gcash.id])
  await ctx.close()
}

// (f) A payment updates both tiles.
async function payment(browser) {
  console.log('\n=== (f) recording a payment from Security Bank to the card updates both tiles without a reload')
  const user = await makeUser('payer')
  const b = await post(user.token, '/accounts/', { name: 'Pay Bank', account_type: 'checking', balance: 50000, currency: 'PHP' })
  const presets = await get(user.token, '/accounts/minimum-due-presets')
  const c = await post(user.token, '/accounts/', {
    name: 'Pay Card', account_type: 'credit', balance: 0, currency: 'PHP', credit_limit: 100000,
    billing_cycle_start: closeDom, days_until_due_date: 21, minimum_due_rule: presets.find((p) => p.key === 'bdo').rule,
    payment_account_id: b.id,
  })
  await debit(user, c.id, 20000, addDays(close, -3), 'Pay Card purchase')
  const before = await quick(user)
  const cardBefore = before.tiles.find((t) => t.account_id === c.id)
  check('(f) the card starts with 20000 due', cardBefore.card.amount_due, 20000)

  const { ctx, page } = await newPage(browser)
  await uiLogin(page, user)
  await openDashboard(page)
  check('(f) the tiles start at the API\'s figures', [
    await text(tile(page, b.id).locator('[data-testid="quick-balance-balance"]')),
    (await text(tile(page, c.id).locator('[data-testid="quick-balance-due"]'))).startsWith(`Due ${peso(20000)}`),
  ], [peso(50000), true])
  await page.evaluate(() => { window.__qbMarker = 1 })
  await tile(page, c.id).click()
  await page.locator('[data-testid="card-credit-panel"]').waitFor()
  await settle(page)
  await page.locator('[data-testid="card-pay-open"]').click()
  const dialog = page.locator('[data-testid="card-pay-dialog"]')
  await dialog.locator('[data-testid="card-pay-amount"]').waitFor()
  await settle(page)
  await dialog.locator('[data-testid="card-pay-amount"]').fill('5000')
  const paid = page.waitForResponse((r) => r.request().method() === 'POST' && new URL(r.url()).pathname.endsWith(`/cards/${c.id}/payments`))
  await dialog.locator('[data-testid="card-pay-submit"]').click()
  check('(f) the payment is 201', (await paid).status(), 201)
  await dialog.waitFor({ state: 'detached' })
  await settle(page)

  const after = await quick(user)
  const cardAfter = after.tiles.find((t) => t.account_id === c.id)
  const bankAfter = after.tiles.find((t) => t.account_id === b.id)
  check('(f) the API lowered both figures', [bankAfter.balance, cardAfter.card.amount_due], [45000, 15000])
  await page.goBack()
  await page.locator('[data-testid="quick-balance-tile"]').first().waitFor()
  await tile(page, b.id).locator('[data-testid="quick-balance-balance"]').filter({ hasText: peso(45000) }).waitFor({ timeout: 10000 }).catch(() => {})
  await tile(page, c.id).locator('[data-testid="quick-balance-due"]').filter({ hasText: peso(15000) }).waitFor({ timeout: 10000 }).catch(() => {})
  check('(f) the bank tile shows the new balance', await text(tile(page, b.id).locator('[data-testid="quick-balance-balance"]')), peso(45000))
  check('(f) the card tile shows the lower amount due', (await text(tile(page, c.id).locator('[data-testid="quick-balance-due"]'))).startsWith(`Due ${peso(15000)}`), true)
  check('(f) the page was not reloaded', await page.evaluate(() => window.__qbMarker), 1)
  await ctx.close()
}

// (g) Few accounts.
async function fewAccounts(browser) {
  console.log('\n=== (g) no card and no e-wallet gives one tile; no accounts gives no section')
  const one = await makeUser('one')
  const only = await post(one.token, '/accounts/', { name: 'Only Checking', account_type: 'checking', balance: 100, currency: 'PHP' })
  const none = await makeUser('none')
  check('(g) the API: one tile, and none', [(await quick(one)).tiles.map((t) => t.account_id), (await quick(none)).tiles], [[only.id], []])

  const a = await newPage(browser)
  await uiLogin(a.page, one)
  await openDashboard(a.page)
  check('(g) one tile, the checking account', await tileIds(a.page), [only.id])
  await a.ctx.close()

  const b = await newPage(browser)
  const answered = b.page.waitForResponse((r) => new URL(r.url()).pathname.endsWith('/dashboard/quick-balances'))
  await uiLogin(b.page, none)
  check('(g) the request succeeds', (await answered).status(), 200)
  await b.page.locator('[data-onboarding="cashflow-timeline"]').waitFor()
  await settle(b.page)
  check('(g) no section for a user with no accounts', await b.page.locator('[data-testid="quick-balances"]').count(), 0)
  await b.ctx.close()
}

;(async () => {
  stack = await startLocalStack()
  API = `${stack.apiUrl}/api/v1`
  const browser = await chromium.launch()
  const run = (k) => !only || only === k
  await setup()
  if (run('a')) await placement(browser)
  if (run('b')) await figures(browser)
  if (run('c')) await tapTile(browser)
  if (run('d')) await phone(browser)
  if (run('e')) await failure(browser)
  if (run('f')) await payment(browser)
  if (run('g')) await fewAccounts(browser)
  await browser.close()
  stack.stop()
  console.log(`\nRESULT: ${pass}/${total} assertions passed`)
  process.exit(pass === total ? 0 : 1)
})().catch((e) => { console.error(e); stack?.stop(); console.log(`\nRESULT (aborted): ${pass}/${total} assertions passed`); process.exit(1) })
