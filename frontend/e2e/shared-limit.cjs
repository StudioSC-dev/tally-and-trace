// Browser check for the shared credit limit: a card linked to another card's limit in the
// card form, the "Shares limit with" line, one available figure on both cards, and unlink.
// Starts its own API and web app against a throwaway database (./_local_stack.cjs). PHP
// only, so no exchange rate is fetched. Not wired into CI and not part of `pnpm build`.
// Run steps: see ./README.md.
//
// Every expected figure is read from the API (GET /cards/credit, /accounts/...), never
// hard-coded, apart from the owner's own setup amounts.
//
// Scenarios:
//   (a) creating a card with "Shares credit limit with: BDO Amex" hides Credit Limit, sends
//       the link and no limit, and the Accounts row then reads "Shares limit with BDO Amex"
//   (b) both Accounts rows show the same "Available" figure, equal to the API's and to the
//       limit less what both cards owe (needs the shared calculation: the API's PR 2)
//   (c) the select lists only eligible cards: no other currency, no linked card, not itself
//   (d) the primary's form shows "Shared with ... Change it on that card" with the select
//       disabled
//   (e) the secondary's edit form unlinks: None sends null, the link and the line go, and
//       Credit Limit comes back
//   Every scenario also checks that no native browser dialog fired.
//
// Usage: node frontend/e2e/shared-limit.cjs [a|b|c|d|e]   (b needs a, and e needs a)
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

/** As the app shows PHP money: "₱1,851.10". */
const peso = (n) => `₱${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2, useGrouping: true })}`
const manilaToday = () => new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10)

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
  const email = `e2e-shl-${tag}-${Math.random().toString(16).slice(2, 8)}@example.com`
  const password = 'E2eTest!2345'
  const reg = await api('', 'POST', '/auth/register', { email, password, first_name: `User${tag}`, last_name: 'Test', default_currency: 'PHP' })
  if (reg.status !== 200 && reg.status !== 201) throw new Error(`register ${reg.status} ${JSON.stringify(reg.json)}`)
  stack.verifyUser(email) // aborts the run unless psql reports UPDATE 1
  const login = await api('', 'POST', '/auth/login', { email, password })
  if (login.status !== 200) throw new Error(`login ${login.status}`)
  return { email, password, tag, token: login.json.access_token }
}

async function newPage(browser) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 1000 } })
  const page = await ctx.newPage()
  const native = dialogs.trackNativeDialogs(page)
  if (process.env.DEBUG) page.on('response', (r) => { if (r.url().includes('/api/v1/')) console.log(`    [net] ${r.request().method()} ${r.url().replace(API, '')} -> ${r.status()}`) })
  return { ctx, page, native }
}

async function uiLogin(page, u) {
  await page.goto(`${stack.webUrl}/login`)
  await page.locator('#email').fill(u.email)
  await page.locator('#password').fill(u.password)
  await page.getByRole('button', { name: 'Sign in', exact: true }).click()
  await page.waitForURL((url) => url.pathname === '/')
  await page.locator('[data-testid="payables"], [data-onboarding="upcoming-expenses"]').first().waitFor()
}

const settle = async (page) => { await page.waitForLoadState('networkidle'); await page.waitForTimeout(500) }
const accountRow = (page, name) => page.locator('article').filter({ has: page.getByText(name, { exact: true }) })
const openAccounts = async (page) => {
  await page.goto(`${stack.webUrl}/accounts`)
  await page.locator('article').first().waitFor()
  await settle(page)
}
const typeSelect = (page) => page.locator('select').filter({ has: page.locator('option[value="credit"]') })
const linkSelect = (page) => page.locator('#account-shares-limit-with')
const limitLabel = (page) => page.locator('label.label').filter({ hasText: /^Credit Limit$/ })
const optionNames = async (select) => select.locator('option').evaluateAll((os) => os.map((o) => o.textContent?.trim()))
const noDialog = (scenario, native) => check(`${scenario} no native dialog fired`, native.count, 0)

const AMEX_LIMIT = 480000
const AMEX_OWED = 100000
let owner, bank, amex, usdCard, platinum

async function setup() {
  owner = await makeUser('owner')
  bank = await post(owner.token, '/accounts/', { name: 'Security Bank', account_type: 'checking', balance: 900000, currency: 'PHP' })
  amex = await post(owner.token, '/accounts/', {
    name: 'BDO Amex', account_type: 'credit', balance: 0, currency: 'PHP', credit_limit: AMEX_LIMIT,
    billing_cycle_start: 4, days_until_due_date: 25, payment_account_id: bank.id,
  })
  usdCard = await post(owner.token, '/accounts/', { name: 'Dollar Card', account_type: 'credit', balance: 0, currency: 'USD', credit_limit: 5000 })
  // The Amex owes something, so the shared available figure is not just the limit.
  await post(owner.token, '/transactions/', {
    account_id: amex.id, transaction_type: 'debit', amount: AMEX_OWED, description: 'Big purchase',
    transaction_date: `${manilaToday()}T00:00:00`, is_posted: true,
  })
}

async function fillNewCard(page, name) {
  await page.getByRole('button', { name: 'Add Account', exact: true }).click()
  await page.getByPlaceholder('Enter account name').fill(name)
  await typeSelect(page).selectOption('credit')
  await page.getByRole('button', { name: 'Show details' }).click()
  await linkSelect(page).waitFor()
}

// (a) Create a card linked to the Amex's limit.
async function createLinked(browser) {
  console.log('\n=== (a) creating a card with "Shares credit limit with" hides Credit Limit and links it')
  const { ctx, page, native } = await newPage(browser)
  await uiLogin(page, owner)
  await openAccounts(page)
  await fillNewCard(page, 'BDO Platinum Mastercard')
  check('(a) Credit Limit shows while no card is chosen', await limitLabel(page).count(), 1)
  await linkSelect(page).selectOption(String(amex.id))
  check('(a) choosing the Amex hides Credit Limit', await limitLabel(page).count(), 0)
  check('(a) and says whose limit is used',
    (await page.locator('[data-testid="account-form-uses-limit"]').textContent())?.trim(), `Uses BDO Amex's limit of ${peso(AMEX_LIMIT)}`)
  const sent = page.waitForRequest((r) => r.method() === 'POST' && new URL(r.url()).pathname.endsWith('/accounts/'))
  await page.getByRole('button', { name: 'Create Account', exact: true }).click()
  const body = (await sent).postDataJSON()
  check('(a) the request carries the link and no limit', [body.shares_limit_with_account_id, 'credit_limit' in body], [amex.id, false])
  await page.getByRole('button', { name: 'Create Account', exact: true }).waitFor({ state: 'detached' })
  await settle(page)
  platinum = (await get(owner.token, '/accounts/')).items.find((a) => a.name === 'BDO Platinum Mastercard')
  check('(a) the API stores the link with no limit of its own', [platinum?.shares_limit_with_account_id, platinum?.credit_limit ?? null], [amex.id, null])
  check('(a) the row reads "Shares limit with BDO Amex"',
    (await page.locator(`[data-testid="account-shares-limit-${platinum.id}"]`).textContent())?.trim(), 'Shares limit with BDO Amex')
  check('(a) the Amex row does not', await page.locator(`[data-testid="account-shares-limit-${amex.id}"]`).count(), 0)
  noDialog('(a)', native)
  await ctx.close()
}

// (b) Both cards show the same available credit.
async function sameAvailable(browser) {
  console.log('\n=== (b) both Accounts rows show the same available credit')
  const items = (await get(owner.token, '/cards/credit')).items
  const creditAmex = items.find((c) => c.account_id === amex.id)
  const creditPlat = items.find((c) => c.account_id === platinum.id)
  console.log(`    API: Amex available ${creditAmex?.available_now}; Platinum available ${creditPlat?.available_now}`)
  check('(b) the API serves the Platinum a credit', creditPlat !== undefined, true)
  check('(b) the API gives both the same figure, the limit less what is owed',
    [creditAmex?.available_now, creditPlat?.available_now], [AMEX_LIMIT - AMEX_OWED, AMEX_LIMIT - AMEX_OWED])
  check('(b) and each names the other', [creditAmex?.shared_with, creditPlat?.shared_with],
    [[{ account_id: platinum.id, name: 'BDO Platinum Mastercard' }], [{ account_id: amex.id, name: 'BDO Amex' }]])
  const { ctx, page, native } = await newPage(browser)
  await uiLogin(page, owner)
  await openAccounts(page)
  const text = async (c) => (await accountRow(page, c.name).locator(`[data-testid="account-credit-${c.id}"] [data-testid="credit-available"]`).textContent({ timeout: 5000 }).catch(() => null))?.trim()
  const want = `Available ${peso(AMEX_LIMIT - AMEX_OWED)}`
  check('(b) the Amex row reads the shared figure', await text(amex), want)
  check('(b) the Platinum row reads the same figure', await text(platinum), want)
  check('(b) the Amex row is marked shared', (await accountRow(page, amex.name).textContent())?.includes(`Limit ${peso(AMEX_LIMIT)} · shared`), true)
  await page.goto(`${stack.webUrl}/accounts/${platinum.id}`)
  await page.locator('[data-testid="card-credit-panel"]').waitFor()
  await settle(page)
  check('(b) the Platinum panel names the shared limit',
    (await page.locator('[data-testid="credit-shared-limit"]').textContent({ timeout: 3000 }).catch(() => null))?.trim(), `Shared ${peso(AMEX_LIMIT)} limit with BDO Amex`)
  check('(b) and the opening line covers both cards',
    (await page.locator('[data-testid="card-credit-opening"]').textContent({ timeout: 3000 }).catch(() => null))?.startsWith('Across both cards:'), true)
  noDialog('(b)', native)
  await ctx.close()
}

// (c) The select lists only eligible cards.
async function eligibleOnly(browser) {
  console.log('\n=== (c) the select lists only eligible cards')
  const { ctx, page, native } = await newPage(browser)
  await uiLogin(page, owner)
  await openAccounts(page)
  // A new PHP card: the Amex is the only candidate. The USD card is another currency and
  // the Platinum is itself linked.
  await fillNewCard(page, 'Another Card')
  check('(c) a new PHP card may pick the Amex only', await optionNames(linkSelect(page)), ['None', 'BDO Amex'])
  await page.getByRole('button', { name: 'Cancel', exact: true }).click()
  // The Platinum's own form: it is not offered itself, the USD card or a linked card.
  await accountRow(page, platinum.name).locator('[role="button"]').first().click()
  await page.getByRole('button', { name: 'Edit account' }).click()
  await page.getByRole('button', { name: 'Show details' }).click()
  await linkSelect(page).waitFor()
  check('(c) the Platinum may pick the Amex only', await optionNames(linkSelect(page)), ['None', 'BDO Amex'])
  check('(c) and starts on the Amex', await linkSelect(page).inputValue(), String(amex.id))
  noDialog('(c)', native)
  await ctx.close()
}

// (d) The primary's form names its linked cards and disables the select.
async function primaryForm(browser) {
  console.log('\n=== (d) the primary\'s form names its linked cards and disables the select')
  const { ctx, page, native } = await newPage(browser)
  await uiLogin(page, owner)
  await openAccounts(page)
  await accountRow(page, amex.name).locator('[role="button"]').first().click()
  await page.getByRole('button', { name: 'Edit account' }).click()
  await page.getByRole('button', { name: 'Show details' }).click()
  await linkSelect(page).waitFor()
  check('(d) the select is disabled', await linkSelect(page).isDisabled(), true)
  check('(d) it names the Platinum and says where to change it',
    (await page.locator('[data-testid="account-form-shared-with"]').textContent())?.trim(), 'Shared with BDO Platinum Mastercard. Change it on that card.')
  check('(d) the Amex keeps its own Credit Limit field', await limitLabel(page).count(), 1)
  noDialog('(d)', native)
  await ctx.close()
}

// (e) Unlinking from the secondary's form.
async function unlink(browser) {
  console.log('\n=== (e) None unlinks the card')
  const { ctx, page, native } = await newPage(browser)
  await uiLogin(page, owner)
  await openAccounts(page)
  await accountRow(page, platinum.name).locator('[role="button"]').first().click()
  await page.getByRole('button', { name: 'Edit account' }).click()
  await page.getByRole('button', { name: 'Show details' }).click()
  await linkSelect(page).waitFor()
  check('(e) Credit Limit is hidden while linked', await limitLabel(page).count(), 0)
  await linkSelect(page).selectOption('')
  check('(e) None brings Credit Limit back', await limitLabel(page).count(), 1)
  const sent = page.waitForRequest((r) => r.method() === 'PUT' && new URL(r.url()).pathname.endsWith(`/accounts/${platinum.id}`))
  await page.getByRole('button', { name: 'Update Account', exact: true }).click()
  const body = (await sent).postDataJSON()
  check('(e) the request sends the link as null', body.shares_limit_with_account_id, null)
  await page.getByRole('button', { name: 'Update Account', exact: true }).waitFor({ state: 'detached' })
  await settle(page)
  const stored = await get(owner.token, `/accounts/${platinum.id}`)
  check('(e) the API stores no link', stored.shares_limit_with_account_id ?? null, null)
  check('(e) the row no longer reads "Shares limit with"', await page.locator(`[data-testid="account-shares-limit-${platinum.id}"]`).count(), 0)
  check('(e) the Amex row is no longer marked shared', (await accountRow(page, amex.name).textContent())?.includes('· shared'), false)
  // An edit that changes nothing about the link leaves it out of the request.
  await accountRow(page, platinum.name).locator('[role="button"]').first().click()
  await page.getByRole('button', { name: 'Edit account' }).click()
  const second = page.waitForRequest((r) => r.method() === 'PUT' && new URL(r.url()).pathname.endsWith(`/accounts/${platinum.id}`))
  await page.getByRole('button', { name: 'Update Account', exact: true }).click()
  check('(e) an unchanged link is not sent', 'shares_limit_with_account_id' in (await second).postDataJSON(), false)
  noDialog('(e)', native)
  await ctx.close()
}

;(async () => {
  stack = await startLocalStack()
  API = `${stack.apiUrl}/api/v1`
  const browser = await chromium.launch()
  const run = (k) => !only || only === k
  await setup()
  if (run('a') || only === 'b' || only === 'c' || only === 'd' || only === 'e') {
    // Every later scenario needs the linked card (a), so it is built first when one is named alone.
    await createLinked(browser)
  }
  if (run('b')) await sameAvailable(browser)
  if (run('c')) await eligibleOnly(browser)
  if (run('d')) await primaryForm(browser)
  if (run('e')) await unlink(browser)
  await browser.close()
  stack.stop()
  console.log(`\nRESULT: ${pass}/${total} assertions passed`)
  process.exit(pass === total ? 0 : 1)
})().catch((e) => { console.error(e); stack?.stop(); console.log(`\nRESULT (aborted): ${pass}/${total} assertions passed`); process.exit(1) })
