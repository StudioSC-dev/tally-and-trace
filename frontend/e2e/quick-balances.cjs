// Browser check for STU-578 PRs 3 and 4: the dashboard's Quick balances section and its pinning. Starts its own
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
//   (d) at 390px: 2 columns, debit and e-wallet side by side with the credit tile full width below, no horizontal scroll, 44px targets
//   (e) a failed quick-balances request shows the section's Retry while the rest of the
//       dashboard renders; Retry loads the tiles
//   (f) recording a payment from Security Bank to the card updates both tiles without a
//       reload
//   (g) a user with no card and no e-wallet sees one tile; a user with no accounts sees
//       no section
//   (o) an admin of one card in a shared-limit pair sees its Due but no Available and no "No limit set"
//   (r) an owner's unshared card with no limit shows a muted "No limit set" where Available would be; the
//       Amex (a limit) does not (the shared-limit card is (o))
//
// Pinning (PR 4), each with a fresh user; every scenario also checks no browser dialog fired:
//   (h) Edit starts from the shown tiles; Move later, Move earlier, Remove and Save send the
//       full ordered list in one PUT
//   (i) Add account lists the pinnable accounts not shown, grouped, without a tag viewer's
//       account; it is disabled at 6
//   (j) Reset to defaults sends [] and the default tiles return
//   (k) Cancel sends nothing and restores the tiles
//   (l) pins saved in one browser context show in a second context of the same user
//   (m) a refused save shows the server's reason inline, and a later save works
//   (q) a tab already open shows pins another context saved once it regains focus, with no reload
//   (n) saving pins does not refetch the dashboard snapshot
//   (p) the editor at 390px: no horizontal scroll, every control 44px
//
// Usage: node frontend/e2e/quick-balances.cjs [a|b|c|d|e|f|g|h|i|j|k|l|m|n|o|p|q|r]
const { startLocalStack } = require('./_local_stack.cjs')
const dialogs = require('./_dialogs.cjs')

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

const nativeTrackers = []
const nativeCount = () => nativeTrackers.reduce((n, t) => n + t.count, 0)
async function newPage(browser, options = {}) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 1000 }, ...options })
  const page = await ctx.newPage()
  nativeTrackers.push(dialogs.trackNativeDialogs(page))
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
    const top = (id) => document.querySelector(`[data-testid="quick-balance-tile"][data-type="${id}"]`).getBoundingClientRect().top
    const g = grid.getBoundingClientRect()
    return {
      columns: getComputedStyle(grid).gridTemplateColumns.split(' ').length,
      gridWidth: g.width,
      checking: rect('checking'), checkingTop: top('checking'), walletTop: top('e_wallet'), creditTop: top('credit'), credit: rect('credit'), wallet: rect('e_wallet'),
      scrollW: document.documentElement.scrollWidth, clientW: document.documentElement.clientWidth,
      heights: [...document.querySelectorAll('[data-testid="quick-balance-tile"]')].map((e) => e.getBoundingClientRect().height),
    }
  })
  check('(d) the grid has 2 columns', m.columns, 2)
  check('(d) the credit tile spans the row', Math.abs(m.credit.w - m.gridWidth) < 1, true)
  check('(d) the other tiles take one column each', [m.checking.w < m.gridWidth * 0.6, m.wallet.w < m.gridWidth * 0.6], [true, true])
  check('(d) the debit and e-wallet tiles share the first row', Math.abs(m.checkingTop - m.walletTop) < 1, true)
  check('(d) the credit tile sits below them', m.creditTop > m.checkingTop + m.checking.h - 1, true)
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

// ─── Pinning ─────────────────────────────────────────────────────────────────
const put = async (token, url, body) => {
  const r = await api(token, 'PUT', url, body)
  if (r.status >= 300) throw new Error(`PUT ${url} ${r.status} ${JSON.stringify(r.json)}`)
  return r.json
}
const noDialog = (scenario) => check(`(${scenario}) no browser dialog fired in any scenario so far`, nativeCount(), 0)

/** The user's account ids shown as tiles, in order, from the API. */
const shownIds = async (u) => (await quick(u)).tiles.map((t) => t.account_id)

/**
 * A user with seven accounts of every pinnable group (so a 6-pin cap can be reached with
 * accounts to spare): Security Bank, GCash, Card A, Card B, Savings One, Cash Box, Spare.
 */
async function seedPinUser(tag) {
  const u = await makeUser(tag)
  const mk = (name, account_type, balance = 100) => post(u.token, '/accounts/', { name, account_type, balance, currency: 'PHP' })
  u.bank = await mk('Security Bank', 'checking', 5000)
  u.gcash = await mk('GCash', 'e_wallet', 700)
  u.cardA = await mk('Card A', 'credit', 0)
  u.cardB = await mk('Card B', 'credit', 0)
  u.savings = await mk('Savings One', 'savings', 900)
  u.cash = await mk('Cash Box', 'cash', 50)
  u.spare = await mk('Spare Checking', 'checking', 0)
  await debit(u, u.cardA.id, 100, addDays(today, -1), 'Card A purchase')
  u.defaults = await shownIds(u)
  return u
}

/** Records every PUT body to the pins and every GET of the snapshot and of the tiles. */
function capture(page) {
  const state = { puts: [], snapshots: 0, tileGets: 0 }
  page.on('request', (r) => {
    const path = new URL(r.url()).pathname
    if (path.endsWith('/dashboard/quick-balances')) {
      if (r.method() === 'PUT') state.puts.push(JSON.parse(r.postData() || 'null'))
      else if (r.method() === 'GET') state.tileGets++
    } else if (path.endsWith('/dashboard/snapshot') && r.method() === 'GET') state.snapshots++
  })
  return state
}
const tidSel = (id) => `[data-testid="${id}"]`
const editRowIds = (page) => page.locator(tidSel('quick-balance-edit-row')).evaluateAll((els) => els.map((e) => Number(e.getAttribute('data-account-id'))))
async function openEditor(page) {
  await page.locator(tidSel('quick-balances-edit')).click()
  await page.locator(tidSel('quick-balances-editor')).waitFor()
  await settle(page)
}
const openFor = async (browser, u, options) => {
  const { ctx, page } = await newPage(browser, options)
  const seen = capture(page)
  await uiLogin(page, u)
  await openDashboard(page)
  return { ctx, page, seen }
}

// (h) Edit starts from the shown tiles; the full ordered list goes in one PUT.
async function editAndSave(browser) {
  console.log('\n=== (h) Edit starts from the shown tiles; Move, Remove and Save send the full ordered list once')
  const u = await seedPinUser('edit')
  const [d1, d2, d3] = u.defaults
  const { ctx, page, seen } = await openFor(browser, u)
  check('(h) no Reset to defaults while nothing is pinned', [await tiles(page).count(), await page.locator(tidSel('quick-balances-reset')).count()], [3, 0])
  await openEditor(page)
  check('(h) the editor starts from the shown tiles, in order', await editRowIds(page), [d1, d2, d3])
  check('(h) the tile links are gone in edit mode', await tiles(page).count(), 0)
  check('(h) the first row cannot move earlier, the last cannot move later',
    [await page.locator(tidSel(`quick-balance-move-earlier-${d1}`)).isDisabled(), await page.locator(tidSel(`quick-balance-move-later-${d3}`)).isDisabled()], [true, true])
  await page.locator(tidSel(`quick-balance-move-later-${d1}`)).click()
  check('(h) Move later puts the first after the second', await editRowIds(page), [d2, d1, d3])
  check('(h) focus stays on the moved row\'s button', await page.evaluate(() => document.activeElement?.getAttribute('data-testid')), `quick-balance-move-later-${d1}`)
  await page.locator(tidSel(`quick-balance-move-earlier-${d3}`)).click()
  check('(h) Move earlier puts the last before the second', await editRowIds(page), [d2, d3, d1])
  await page.locator(tidSel(`quick-balance-remove-${d2}`)).click()
  check('(h) Remove drops the row', await editRowIds(page), [d3, d1])
  check('(h) nothing is sent before Save', seen.puts.length, 0)
  await page.locator(tidSel('quick-balances-save')).click()
  await page.locator(tidSel('quick-balances-editor')).waitFor({ state: 'detached' })
  await settle(page)
  check('(h) Save sent the full ordered list in one PUT', seen.puts, [{ account_ids: [d3, d1] }])
  check('(h) the tiles show the saved order', await tileIds(page), [d3, d1])
  const body = await quick(u)
  check('(h) the API stored the pins', [body.pinned, body.tiles.map((t) => t.account_id)], [true, [d3, d1]])
  await openEditor(page)
  check('(h) Reset to defaults is offered once pinned', await page.locator(tidSel('quick-balances-reset')).count(), 1)
  noDialog('h')
  await ctx.close()
}

// (i) Add account.
async function addAccount(browser) {
  console.log('\n=== (i) Add account lists the pinnable accounts not shown, grouped, without a tag viewer\'s; disabled at 6')
  const u = await seedPinUser('add')
  const other = await makeUser('addother')
  const theirs = await post(other.token, '/accounts/', { name: 'Their Shared', account_type: 'checking', balance: 10, currency: 'PHP' })
  await post(other.token, `/accounts/${theirs.id}/shares`, { email: u.email, role: 'viewer' })
  const tagged = await post(other.token, '/accounts/', { name: 'Their Household Tagged', account_type: 'checking', balance: 10, currency: 'PHP' })
  await post(other.token, '/tags/household/shares', { email: u.email })
  const household = (await get(other.token, '/tags/')).find((t) => t.is_system)
  await put(other.token, `/accounts/${tagged.id}`, { tag_ids: [household.id] })
  const listed = (await get(u.token, '/accounts/?is_active=true&limit=1000')).items
  const roleOf = (id) => listed.find((a) => a.id === id)?.my_role
  check('(i) the API lists the viewer-shared account and the tag-viewer one', [roleOf(theirs.id), roleOf(tagged.id)], ['viewer', 'tag_viewer'])

  const { ctx, page, seen } = await openFor(browser, u)
  await openEditor(page)
  const addBtn = page.locator(tidSel('quick-balances-add'))
  await addBtn.click()
  const optionIds = async () => (await page.locator(tidSel('quick-balance-add-option')).evaluateAll((els) => els.map((e) => Number(e.getAttribute('data-account-id'))))).sort((a, b) => a - b)
  const expected = listed.filter((a) => a.my_role !== 'tag_viewer' && !u.defaults.includes(a.id)).map((a) => a.id).sort((a, b) => a - b)
  check('(i) the list is every pinnable account not already shown', await optionIds(), expected)
  check('(i) the tag viewer\'s account is not offered, the viewer-shared one is', [(await optionIds()).includes(tagged.id), (await optionIds()).includes(theirs.id)], [false, true])
  const headings = await page.locator(`${tidSel('quick-balances-add-panel')} p.uppercase`).allTextContents()
  check('(i) grouped under Debit, Credit, Cash, then Shared with its own groups', headings, ['Debit', 'Credit', 'Cash', 'Shared', 'Debit'])
  check('(i) the count reads 3 of 6', await text(page.locator(tidSel('quick-balances-count'))), '3 of 6')
  await page.locator(`${tidSel('quick-balance-add-option')}[data-account-id="${u.cash.id}"]`).click()
  check('(i) a pick adds a row and closes the list', [await editRowIds(page), await page.locator(tidSel('quick-balances-add-panel')).count()], [[...u.defaults, u.cash.id], 0])
  await addBtn.click()
  check('(i) the picked account is no longer offered', (await optionIds()).includes(u.cash.id), false)
  await page.locator(`${tidSel('quick-balance-add-option')}[data-account-id="${u.savings.id}"]`).click()
  await addBtn.click()
  await page.locator(`${tidSel('quick-balance-add-option')}[data-account-id="${u.cardB.id}"]`).click()
  check('(i) six rows', (await editRowIds(page)).length, 6)
  check('(i) Add account is disabled at 6 and the count says so', [await addBtn.isDisabled(), await text(page.locator(tidSel('quick-balances-count')))], [true, '6 of 6 (the most you can pin)'])
  await page.locator(tidSel(`quick-balance-remove-${u.cash.id}`)).click()
  check('(i) removing one enables it again', await addBtn.isDisabled(), false)
  await addBtn.click()
  await page.locator(`${tidSel('quick-balance-add-option')}[data-account-id="${u.cash.id}"]`).click()
  await page.locator(tidSel('quick-balances-save')).click()
  await page.locator(tidSel('quick-balances-editor')).waitFor({ state: 'detached' })
  check('(i) Save sent the six in order', seen.puts, [{ account_ids: [...u.defaults, u.savings.id, u.cardB.id, u.cash.id] }])
  check('(i) six tiles the moment the editor closes, and the API agrees', [(await tileIds(page)).length, (await shownIds(u)).length], [6, 6])
  noDialog('i')
  await ctx.close()
}

// (j) Reset to defaults.
async function resetDefaults(browser) {
  console.log('\n=== (j) Reset to defaults sends [] and the default tiles return')
  const u = await seedPinUser('reset')
  await put(u.token, '/dashboard/quick-balances', { account_ids: [u.savings.id, u.cash.id] })
  check('(j) pinned: two tiles', await shownIds(u), [u.savings.id, u.cash.id])
  const { ctx, page, seen } = await openFor(browser, u)
  check('(j) the page shows the pins', await tileIds(page), [u.savings.id, u.cash.id])
  await openEditor(page)
  await page.locator(tidSel('quick-balances-reset')).click()
  await page.locator(tidSel('quick-balances-editor')).waitFor({ state: 'detached' })
  await settle(page)
  check('(j) Reset sent [] in one PUT', seen.puts, [{ account_ids: [] }])
  check('(j) the default tiles are back', await tileIds(page), u.defaults)
  const body = await quick(u)
  check('(j) the API is back to the defaults', [body.pinned, body.tiles.map((t) => t.account_id)], [false, u.defaults])
  noDialog('j')
  await ctx.close()
}

// (k) Cancel.
async function cancelEdit(browser) {
  console.log('\n=== (k) Cancel sends nothing and restores the tiles')
  const u = await seedPinUser('cancel')
  const { ctx, page, seen } = await openFor(browser, u)
  await openEditor(page)
  await page.locator(tidSel(`quick-balance-remove-${u.defaults[0]}`)).click()
  await page.locator(tidSel(`quick-balance-move-later-${u.defaults[1]}`)).click()
  check('(k) the draft changed', await editRowIds(page), [u.defaults[2], u.defaults[1]])
  await page.locator(tidSel('quick-balances-cancel')).click()
  await page.locator(tidSel('quick-balances-editor')).waitFor({ state: 'detached' })
  await settle(page)
  check('(k) nothing was sent', seen.puts, [])
  check('(k) the tiles are as they were', await tileIds(page), u.defaults)
  check('(k) the API still has no pins', (await quick(u)).pinned, false)
  await openEditor(page)
  check('(k) editing again starts from the shown tiles, not the abandoned draft', await editRowIds(page), u.defaults)
  noDialog('k')
  await ctx.close()
}

// (l) A second browser context of the same user.
async function secondContext(browser) {
  console.log('\n=== (l) pins saved in one browser context show in a second context of the same user')
  const u = await seedPinUser('devices')
  const one = await openFor(browser, u)
  await openEditor(one.page)
  await one.page.locator(tidSel(`quick-balance-move-later-${u.defaults[0]}`)).click()
  await one.page.locator(tidSel('quick-balances-save')).click()
  await one.page.locator(tidSel('quick-balances-editor')).waitFor({ state: 'detached' })
  await settle(one.page)
  const want = [u.defaults[1], u.defaults[0], u.defaults[2]]
  check('(l) the first context shows the new order', await tileIds(one.page), want)
  const two = await openFor(browser, u, { viewport: { width: 390, height: 844 } })
  check('(l) the second context, logged in separately, shows it too', await tileIds(two.page), want)
  check('(l) the second context never saved anything', two.seen.puts, [])
  noDialog('l')
  await one.ctx.close()
  await two.ctx.close()
}

// (q) A tab that was already open.
async function focusRefresh(browser) {
  console.log('\n=== (q) a tab already open shows pins another context saved once it regains focus, with no reload')
  const u = await seedPinUser('focus')
  const a = await openFor(browser, u)
  const b = await openFor(browser, u, { viewport: { width: 390, height: 844 } })
  await b.page.evaluate(() => { window.__qbMarker = 1 })
  check('(q) both contexts start on the defaults', [await tileIds(a.page), await tileIds(b.page)], [u.defaults, u.defaults])
  await openEditor(a.page)
  await a.page.locator(tidSel(`quick-balance-move-later-${u.defaults[0]}`)).click()
  await a.page.locator(tidSel('quick-balances-save')).click()
  await a.page.locator(tidSel('quick-balances-editor')).waitFor({ state: 'detached' })
  await settle(a.page)
  const want = [u.defaults[1], u.defaults[0], u.defaults[2]]
  check('(q) the API holds the new order', await shownIds(u), want)
  check('(q) the second tab still shows the old order until it is focused', await tileIds(b.page), u.defaults)
  await b.page.evaluate(() => { window.dispatchEvent(new Event('focus')) })
  await b.page.locator(`${tidSel('quick-balance-tile')}[data-account-id="${want[0]}"]`).first().waitFor({ timeout: 5000 }).catch(() => {})
  await settle(b.page)
  check('(q) on focus the second tab shows the new order', await tileIds(b.page), want)
  check('(q) without a reload', await b.page.evaluate(() => window.__qbMarker), 1)
  noDialog('q')
  await a.ctx.close()
  await b.ctx.close()
}

// (m) A refused save.
async function refusedSave(browser) {
  console.log('\n=== (m) a refused save shows the server\'s reason inline, and a later save works')
  const u = await seedPinUser('refused')
  const { ctx, page, seen } = await openFor(browser, u)
  await openEditor(page)
  await page.locator(tidSel('quick-balances-add')).click()
  await page.locator(`${tidSel('quick-balance-add-option')}[data-account-id="${u.spare.id}"]`).click()
  const del = await api(u.token, 'DELETE', `/accounts/${u.spare.id}`)
  check('(m) the spare account is deleted behind the editor', del.status < 300, true)
  await page.locator(tidSel('quick-balances-save')).click()
  const alert = page.locator(tidSel('quick-balances-save-error'))
  await alert.waitFor()
  const reason = (await api(u.token, 'PUT', '/dashboard/quick-balances', { account_ids: [...u.defaults, u.spare.id] })).json
  check('(m) the refusal shows the server\'s own reason', [await text(alert), await alert.getAttribute('role')], [reason.detail, 'alert'])
  check('(m) the editor stays open with the draft', await editRowIds(page), [...u.defaults, u.spare.id])
  check('(m) the stored pins did not change', (await quick(u)).pinned, false)
  await page.locator(tidSel(`quick-balance-remove-${u.spare.id}`)).click()
  await page.locator(tidSel('quick-balances-save')).click()
  await page.locator(tidSel('quick-balances-editor')).waitFor({ state: 'detached' })
  check('(m) saving without the deleted account works', [seen.puts.length, await tileIds(page)], [2, u.defaults])
  noDialog('m')
  await ctx.close()
}

// (n) The snapshot is not refetched.
async function noSnapshotRefetch(browser) {
  console.log('\n=== (n) saving pins does not refetch the dashboard snapshot')
  const u = await seedPinUser('snapshot')
  const { ctx, page, seen } = await openFor(browser, u)
  check('(n) the dashboard loaded the snapshot once', seen.snapshots, 1)
  await openEditor(page)
  await page.locator(tidSel(`quick-balance-move-later-${u.defaults[0]}`)).click()
  await page.locator(tidSel('quick-balances-save')).click()
  await page.locator(tidSel('quick-balances-editor')).waitFor({ state: 'detached' })
  await settle(page)
  check('(n) one PUT went out', seen.puts.length, 1)
  check('(n) the snapshot was not requested again', seen.snapshots, 1)
  check('(n) the PUT\'s own answer filled the tiles: they were not requested again either', seen.tileGets, 1)
  noDialog('n')
  await ctx.close()
}

// (p) The editor on a phone.
async function phoneEditor(browser) {
  console.log('\n=== (p) the editor at 390px: no horizontal scroll, every control 44px')
  const u = await seedPinUser('phoneedit')
  await put(u.token, '/dashboard/quick-balances', { account_ids: [u.defaults[0], u.cardA.id, u.gcash.id, u.cardB.id, u.savings.id, u.cash.id] })
  const { ctx, page } = await openFor(browser, u, { viewport: { width: 390, height: 844 } })
  await openEditor(page)
  const m = await page.evaluate(() => {
    const boxes = [...document.querySelectorAll('[data-testid="quick-balances"] button')].map((b) => {
      const r = b.getBoundingClientRect()
      return { id: b.getAttribute('data-testid') || b.textContent, w: r.width, h: r.height }
    })
    const section = document.querySelector('[data-testid="quick-balances"]').getBoundingClientRect()
    return { boxes, scrollW: document.documentElement.scrollWidth, clientW: document.documentElement.clientWidth, right: section.right }
  })
  check('(p) no horizontal scroll', m.scrollW <= m.clientW, true)
  check('(p) every button is at least 44px each way', m.boxes.filter((b) => b.w < 44 || b.h < 44).map((b) => b.id), [])
  check('(p) the editor has its six rows and the controls', [m.boxes.length >= 6 * 3 + 4], [true])
  noDialog('p')
  await ctx.close()
}

// (o) A card whose shared limit the caller can't see in full.
async function partialGroup(browser) {
  console.log('\n=== (o) an admin of one card in a shared-limit pair sees no Available line and no "No limit set"')
  const admin = await makeUser('admin')
  await post(owner.token, `/accounts/${platinum.id}/shares`, { email: admin.email, role: 'admin' })
  const t = (await quick(admin)).tiles.find((x) => x.account_id === platinum.id)
  check('(o) the API gives the admin the card figures and no credit', [t !== undefined, t?.card !== undefined, t?.credit === undefined], [true, true, true])
  const { ctx, page } = await newPage(browser)
  await uiLogin(page, admin)
  await openDashboard(page)
  const card = tile(page, platinum.id)
  check('(o) the tile shows Due', await card.locator('[data-testid="quick-balance-due"]').count(), 1)
  // The accounts list has loaded (openDashboard waits for the network to go idle), so an absent line is not a race.
  check('(o) no Available line and no "No limit set"', [await card.locator('[data-testid="quick-balance-available"]').count(), (await text(card)).includes('No limit set')], [0, false])
  await ctx.close()
}

// (r) A card with no credit limit and no shared limit.
async function noLimitCard(browser) {
  console.log('\n=== (r) an owner\'s unshared card with no limit shows "No limit set"; a card with a limit does not')
  const u = await makeUser('nolimit')
  const plain = await post(u.token, '/accounts/', { name: 'Plain Card', account_type: 'credit', balance: 0, currency: 'PHP' })
  const t = (await quick(u)).tiles.find((x) => x.account_id === plain.id)
  check('(r) the API gives the owner the card figures and no credit', [t !== undefined, t?.card !== undefined, t?.credit === undefined], [true, true, true])
  const { ctx, page } = await newPage(browser)
  await uiLogin(page, u)
  await openDashboard(page)
  const card = tile(page, plain.id)
  const noLimit = card.locator('[data-testid="quick-balance-available"]')
  await noLimit.waitFor()
  check('(r) the tile reads "No limit set", with no caption', [await noLimit.count(), await text(noLimit)], [1, 'No limit set'])
  check('(r) the line is muted', await noLimit.evaluate((el) => el.classList.contains('text-muted')), true)
  check('(r) the Due line stays first', await card.locator('[data-testid^="quick-balance-"]').evaluateAll((els) => els.map((e) => e.getAttribute('data-testid')).filter((id) => id === 'quick-balance-due' || id === 'quick-balance-available')),
    ['quick-balance-due', 'quick-balance-available'])

  // The Amex has a limit (the Platinum sharing it is covered by (o)), so it does not say "No limit set".
  const pair = await newPage(browser)
  await uiLogin(pair.page, owner)
  await pair.page.locator('[data-testid="quick-balance-tile"]').first().waitFor()
  await pair.page.waitForLoadState('networkidle')
  check('(r) the Amex shows its Available figure, not "No limit set"', (await text(tile(pair.page, amex.id))).includes('No limit set'), false)
  await ctx.close()
  await pair.ctx.close()
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
  if (run('h')) await editAndSave(browser)
  if (run('i')) await addAccount(browser)
  if (run('j')) await resetDefaults(browser)
  if (run('k')) await cancelEdit(browser)
  if (run('l')) await secondContext(browser)
  if (run('m')) await refusedSave(browser)
  if (run('n')) await noSnapshotRefetch(browser)
  if (run('o')) await partialGroup(browser)
  if (run('p')) await phoneEditor(browser)
  if (run('q')) await focusRefresh(browser)
  if (run('r')) await noLimitCard(browser)
  check('no browser dialog fired in the whole run', nativeCount(), 0)
  await browser.close()
  stack.stop()
  console.log(`\nRESULT: ${pass}/${total} assertions passed`)
  process.exit(pass === total ? 0 : 1)
})().catch((e) => { console.error(e); stack?.stop(); console.log(`\nRESULT (aborted): ${pass}/${total} assertions passed`); process.exit(1) })
