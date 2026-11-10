// Browser check for STU-583: the Allocations tab is labelled "Recurring" and has a search box,
// and the Transactions Due card's Subscriptions tab links to it. Starts its own API and web app
// against a throwaway database (./_local_stack.cjs). Not wired into CI and not part of
// `pnpm build`. Run steps: see ./README.md.
//
// Scenarios (each seeds its own user, so each can run alone):
//   (a) the tab reads "Recurring" (no "Subscriptions" tab); `?tab=recurring` and the older
//       `?tab=subscriptions` both open it; a plain visit opens it too; `?tab=budgets` opens Budgets
//   (b) the search filters as the user types, with no request sent: by name, by account name, by
//       category name, a transfer by its destination account name, by amount text (plain and grouped), "NETFLIX" finds "Netflix", an empty
//       result reads "No recurring entries match", and clearing restores every seeded entry
//   (c) at 390px the box has an accessible label, is 44px tall, and the page does not scroll sideways
//   (d) the Due card's Subscriptions tab ends with "Manage recurring entries", which opens
//       /allocations?tab=recurring with the Recurring tab selected
//
// Every scenario checks that no browser dialog fired.
//
// Usage: node frontend/e2e/recurring-search.cjs [a|b|c|d]
const { startLocalStack } = require('./_local_stack.cjs')
const { openDueTab, useDueCheck } = require('./_due_pages.cjs')
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

const manilaToday = () => new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10)
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
const get = async (token, url) => {
  const r = await api(token, 'GET', url)
  if (r.status >= 300) throw new Error(`GET ${url} ${r.status} ${JSON.stringify(r.json)}`)
  return r.json
}

async function makeUser(tag) {
  const email = `e2e-rs-${tag}-${Math.random().toString(16).slice(2, 8)}@example.com`
  const password = 'E2eTest!2345'
  const reg = await api('', 'POST', '/auth/register', { email, password, first_name: `User${tag}`, last_name: 'Test', default_currency: 'PHP' })
  if (reg.status !== 200 && reg.status !== 201) throw new Error(`register ${reg.status} ${JSON.stringify(reg.json)}`)
  stack.verifyUser(email) // aborts the run unless psql reports UPDATE 1
  const login = await api('', 'POST', '/auth/login', { email, password })
  if (login.status !== 200) throw new Error(`login ${login.status}`)
  return { email, password, tag, token: login.json.access_token }
}

async function newPage(browser, width = 1280) {
  const ctx = await browser.newContext({ viewport: { width, height: 1000 } })
  const page = await ctx.newPage()
  const native = trackNativeDialogs(page)
  return { ctx, page, native }
}

async function uiLogin(page, u) {
  await page.goto(`${stack.webUrl}/login`)
  await page.locator('#email').fill(u.email)
  await page.locator('#password').fill(u.password)
  await page.getByRole('button', { name: 'Sign in', exact: true }).click()
  await page.waitForURL((url) => url.pathname === '/')
}

const searchBox = (page) => page.getByLabel('Search recurring entries')
const recurringTab = (page) => page.getByRole('button', { name: 'Recurring', exact: true })
const cards = (page) => page.locator('[data-testid^="kind-section-"] article')
const names = async (page) => (await page.waitForTimeout(250), await cards(page).locator('p.text-base.font-semibold').allInnerTexts()).map((t) => t.trim()).sort()

/** Six entries over three accounts and two categories: names, accounts, categories and amounts differ. */
async function seed(u) {
  const bank = await post(u.token, '/accounts/', { name: 'Maya Savings', account_type: 'checking', balance: 100000, currency: 'PHP' })
  const wallet = await post(u.token, '/accounts/', { name: 'BDO Everyday', account_type: 'checking', balance: 100000, currency: 'PHP' })
  const list = await get(u.token, '/categories/?limit=200')
  const cats = list.items ?? list
  const utilities = cats.find((c) => c.name.toLowerCase() === 'utilities')
  const gift = cats.find((c) => c.name.toLowerCase() !== 'utilities')
  if (!utilities || !gift) throw new Error('a new account lacks default categories')
  const day = addDays(manilaToday(), 6)
  const mk = (fields) =>
    post(u.token, '/budget-entries/', { entry_type: 'expense', currency: 'PHP', cadence: 'monthly', next_occurrence: wire(day), ...fields })
  await mk({ name: 'Netflix', amount: 549, account_id: bank.id, category_id: gift.id })
  await mk({ name: 'Spotify', amount: 149, account_id: bank.id, category_id: gift.id })
  await mk({ name: 'Meralco', amount: 3200, account_id: wallet.id, category_id: utilities.id })
  await mk({ name: 'Water bill', amount: 850.5, account_id: wallet.id, category_id: utilities.id })
  await mk({ name: 'Salary', entry_type: 'income', amount: 45000, account_id: bank.id })
  // A recurring transfer: its card shows the destination account, so a search finds it by that name.
  const kids = await post(u.token, '/accounts/', { name: 'Kids Fund', account_type: 'savings', balance: 0, currency: 'PHP' })
  await mk({ name: 'Monthly top-up', amount: 2500, account_id: wallet.id, transfer_to_account_id: kids.id })
  return { bank, wallet, kids, utilities, gift, count: 6 }
}

async function openRecurring(page, query = '') {
  await page.goto(`${stack.webUrl}/allocations${query}`)
  await page.locator('[data-testid^="kind-section-"]').first().waitFor()
}

async function tabs(browser) {
  console.log('(a) the Recurring tab and its URL values')
  const me = await makeUser('a')
  await seed(me)
  const { ctx, page, native } = await newPage(browser)
  await uiLogin(page, me)
  await openRecurring(page)
  check('(a) a Recurring tab', await recurringTab(page).count(), 1)
  check('(a) no Subscriptions tab', await page.getByRole('button', { name: 'Subscriptions', exact: true }).count(), 0)
  check('(a) a plain visit opens Recurring', await recurringTab(page).getAttribute('aria-pressed'), 'true')
  await page.getByRole('button', { name: 'Budgets', exact: true }).click()
  check('(a) Budgets selected after a click', await page.getByRole('button', { name: 'Budgets', exact: true }).getAttribute('aria-pressed'), 'true')
  for (const value of ['recurring', 'subscriptions']) {
    await page.goto(`${stack.webUrl}/allocations?tab=${value}`)
    await page.locator('[data-testid^="kind-section-"]').first().waitFor()
    check(`(a) ?tab=${value} selects Recurring`, await recurringTab(page).getAttribute('aria-pressed'), 'true')
    check(`(a) ?tab=${value} shows the recurring list`, await cards(page).count(), 6)
  }
  await page.goto(`${stack.webUrl}/allocations?tab=budgets`)
  await page.getByRole('button', { name: 'Budgets', exact: true }).waitFor()
  check('(a) ?tab=budgets opens Budgets', await page.getByRole('button', { name: 'Budgets', exact: true }).getAttribute('aria-pressed'), 'true')
  await page.goto(`${stack.webUrl}/allocations?tab=junk`)
  await recurringTab(page).waitFor()
  check('(a) an unknown ?tab= falls back to Recurring', await recurringTab(page).getAttribute('aria-pressed'), 'true')
  check('(a) no browser dialog fired', native.count, 0)
  await ctx.close()
}

async function search(browser) {
  console.log('(b) the search box')
  const me = await makeUser('b')
  await seed(me)
  const { ctx, page, native } = await newPage(browser)
  await uiLogin(page, me)
  await openRecurring(page)
  const requests = []
  page.on('request', (r) => { if (r.url().includes('/api/v1/')) requests.push(r.url()) })
  const box = searchBox(page)
  const all = await names(page)
  check('(b) six entries listed', all, ['Meralco', 'Monthly top-up', 'Netflix', 'Salary', 'Spotify', 'Water bill'])

  await box.pressSequentially('net')
  check('(b) by name, as typed', await names(page), ['Netflix'])
  await box.fill('NETFLIX')
  check('(b) case-insensitive: NETFLIX finds Netflix', await names(page), ['Netflix'])
  await box.fill('maya')
  check('(b) by account name', await names(page), ['Netflix', 'Salary', 'Spotify'])
  await box.fill('BDO')
  check('(b) by account name, upper case', await names(page), ['Meralco', 'Monthly top-up', 'Water bill'])
  await box.fill('kids fund')
  check('(b) a transfer by its destination account name', await names(page), ['Monthly top-up'])
  await box.fill('utilities')
  check('(b) by category name', await names(page), ['Meralco', 'Water bill'])
  await box.fill('3200')
  check('(b) by amount text', await names(page), ['Meralco'])
  await box.fill('45,000')
  check('(b) by grouped amount text', await names(page), ['Salary'])
  await box.fill('850.50')
  check('(b) by decimal amount text', await names(page), ['Water bill'])
  await box.fill('zzz-no-such')
  check('(b) no match shows the empty message', await page.getByText('No recurring entries match').count(), 1)
  check('(b) no match lists no entry', await cards(page).count(), 0)
  await box.fill('')
  check('(b) clearing restores every entry', await cards(page).count(), 6)
  check('(b) clearing hides the empty message', await page.getByText('No recurring entries match').count(), 0)
  check('(b) the filter is client-side: no request sent while searching', requests, [])
  check('(b) no browser dialog fired', native.count, 0)
  await ctx.close()
}

async function phone(browser) {
  console.log('(c) the search box at 390px')
  const me = await makeUser('c')
  await seed(me)
  const { ctx, page, native } = await newPage(browser, 390)
  await uiLogin(page, me)
  await openRecurring(page)
  const box = searchBox(page)
  check('(c) the box has an accessible label', await box.count(), 1)
  const rect = await box.boundingBox()
  check('(c) the box is at least 44px tall', rect.height >= 44, true)
  await box.fill('a')
  if (process.env.DEBUG) console.log(await page.evaluate(() => [...document.querySelectorAll('body *')].filter((el) => el.getBoundingClientRect().right > document.documentElement.clientWidth + 1).slice(0, 8).map((el) => `${el.tagName}.${el.className} ${Math.round(el.getBoundingClientRect().right)}`)))
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
  check('(c) the page does not scroll sideways', overflow <= 0, true)
  check('(c) no browser dialog fired', native.count, 0)
  await ctx.close()
}

async function dueLink(browser) {
  console.log('(d) the Due card links to the Recurring tab')
  const me = await makeUser('d')
  await seed(me)
  const { ctx, page, native } = await newPage(browser)
  await uiLogin(page, me)
  await page.goto(`${stack.webUrl}/transactions`)
  await waitQuiet(page)
  await openDueTab(page, 'subscriptions')
  const link = page.getByRole('link', { name: 'Manage recurring entries' })
  check('(d) one Manage recurring entries link', await link.count(), 1)
  check('(d) it points at /allocations?tab=recurring', await link.getAttribute('href'), '/allocations?tab=recurring')
  await link.click()
  await page.waitForURL((url) => url.pathname === '/allocations')
  await searchBox(page).waitFor()
  check('(d) the Recurring tab is selected', await recurringTab(page).getAttribute('aria-pressed'), 'true')
  check('(d) the URL carries tab=recurring', new URL(page.url()).searchParams.get('tab'), 'recurring')
  check('(d) no browser dialog fired', native.count, 0)
  await ctx.close()
}

;(async () => {
  stack = await startLocalStack()
  API = `${stack.apiUrl}/api/v1`
  const browser = await chromium.launch()
  const run = (k) => !only || only === k
  if (run('a')) await tabs(browser)
  if (run('b')) await search(browser)
  if (run('c')) await phone(browser)
  if (run('d')) await dueLink(browser)
  await browser.close()
  stack.stop()
  console.log(`\nRESULT: ${pass}/${total} assertions passed`)
  process.exit(pass === total ? 0 : 1)
})().catch((e) => { console.error(e); stack?.stop(); console.log(`\nRESULT (aborted): ${pass}/${total} assertions passed`); process.exit(1) })
