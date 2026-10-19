// Browser check for STU-343: the Allocations page groups recurring entries by
// kind, offers Mark paid on a card, and the form picks a card expense's kind.
// Starts its own API and web app against a throwaway database
// (./_local_stack.cjs). Not wired into CI and not part of `pnpm build`.
// Run steps: see ./README.md.
//
// Scenarios:
//   (a) six dividers, in order: Subscriptions, Card installments, Cash expenses,
//       Card-billed bills, Income & transfers, Shared with you
//   (b) Mark paid on an installment advances "Next" and "Payment n of m"
//       without opening the edit form
//   (c) a Utilities entry added on "Automatic" lands under bills
//   (d) a capped Bill moves to bills; switching it back to Installment returns it
//   (e) a viewer sees no Mark paid
//
// Usage: node frontend/e2e/allocations-kinds.cjs [a|b|c|d|e]
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
const daysIn = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate()
/** `day` moved by n months, on day-of-month `anchor` (clamped to the month). */
const addMonths = (day, n, anchor = Number(day.slice(8, 10))) => {
  let y = Number(day.slice(0, 4))
  let m = Number(day.slice(5, 7)) + n
  while (m > 12) { m -= 12; y += 1 }
  while (m < 1) { m += 12; y -= 1 }
  return `${y}-${String(m).padStart(2, '0')}-${String(Math.min(anchor, daysIn(y, m))).padStart(2, '0')}`
}
const suffix = (d) => (d % 100 >= 11 && d % 100 <= 13 ? 'th' : ['th', 'st', 'nd', 'rd'][d % 10] || 'th')
/** As the app shows a day: "Oct 25th, 2026". */
const fmt = (day) => {
  const d = new Date(`${day}T00:00:00Z`)
  const month = new Intl.DateTimeFormat('en-US', { month: 'short', timeZone: 'UTC' }).format(d)
  return `${month} ${d.getUTCDate()}${suffix(d.getUTCDate())}, ${d.getUTCFullYear()}`
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
  const email = `e2e-ak-${tag}-${Math.random().toString(16).slice(2, 8)}@example.com`
  const password = 'E2eTest!2345'
  const reg = await api('', 'POST', '/auth/register', { email, password, first_name: `User${tag}`, last_name: 'Test', default_currency: 'PHP' })
  if (reg.status !== 200 && reg.status !== 201) throw new Error(`register ${reg.status} ${JSON.stringify(reg.json)}`)
  stack.verifyUser(email) // aborts the run unless psql reports UPDATE 1
  const login = await api('', 'POST', '/auth/login', { email, password })
  if (login.status !== 200) throw new Error(`login ${login.status}`)
  return { email, password, tag, token: login.json.access_token }
}
const checking = (u, name = `${u.tag} Checking`) =>
  post(u.token, '/accounts/', { name, account_type: 'checking', balance: 100000, currency: 'PHP' })
const card = (u, payFrom, name = `${u.tag} Card`) =>
  post(u.token, '/accounts/', {
    name, account_type: 'credit', balance: 0, currency: 'PHP', credit_limit: 500000,
    billing_cycle_start: 1, days_until_due_date: 20, payment_account_id: payFrom.id,
  })
const entry = (u, fields) =>
  post(u.token, '/budget-entries/', { entry_type: 'expense', currency: 'PHP', cadence: 'monthly', ...fields })

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

async function openAllocations(page) {
  await page.goto(`${stack.webUrl}/allocations`)
  await page.locator('[data-testid^="kind-section-"]').first().waitFor()
}

const section = (page, key) => page.locator(`[data-testid="kind-section-${key}"]`)
const cardNamed = (page, key, name) =>
  section(page, key).locator('article').filter({ has: page.getByText(name, { exact: true }) })
const editForm = (page) => page.getByLabel('Close allocation modal')
const settle = async (page) => { await page.waitForLoadState('networkidle'); await page.waitForTimeout(500) }

/** The text after "Next " in a card. */
async function nextOf(card) {
  const text = await card.getByText(/^Next /).first().innerText()
  return text.replace(/^Next /, '').trim()
}

/** One owner with a subscription, an installment, a cash expense, a bill and an income. */
async function seed(u) {
  const bank = await checking(u)
  const cc = await card(u, bank)
  // A new account starts with a Utilities category.
  const categories = await get(u.token, '/categories/?limit=200')
  const utilities = (categories.items ?? categories).find((c) => c.name.toLowerCase() === 'utilities')
  if (!utilities) throw new Error('no Utilities category on a new account')
  const today = manilaToday()
  const start = addDays(today, -1)
  const sub = await entry(u, { name: 'Streaming', amount: 500, account_id: cc.id, next_occurrence: wire(addDays(today, 5)) })
  const inst = await entry(u, {
    name: 'Phone plan', amount: 1200, account_id: cc.id, next_occurrence: wire(start),
    end_mode: 'after_occurrences', max_occurrences: 3,
  })
  const cash = await entry(u, { name: 'Gym', amount: 800, account_id: bank.id, next_occurrence: wire(addDays(today, 6)) })
  const bill = await entry(u, {
    name: 'Electric', amount: 2000, account_id: cc.id, next_occurrence: wire(addDays(today, 7)),
    category_id: utilities.id,
  })
  const income = await entry(u, {
    name: 'Salary', entry_type: 'income', amount: 30000, account_id: bank.id, next_occurrence: wire(addDays(today, 8)),
  })
  return { bank, cc, utilities, sub, inst, cash, bill, income, start }
}

async function dividers(browser) {
  console.log('(a) six dividers')
  const owner = await makeUser('a-owner')
  const me = await makeUser('a-me')
  const world = await seed(me)
  // Someone else's entry on an account shared with me as a viewer: the "Shared with you" divider.
  const theirBank = await checking(owner, 'Their joint')
  await entry(owner, { name: 'Their rent', amount: 9000, account_id: theirBank.id, next_occurrence: wire(addDays(manilaToday(), 4)) })
  await post(owner.token, `/accounts/${theirBank.id}/shares`, { email: me.email, role: 'viewer' })

  const { ctx, page } = await newPage(browser)
  await uiLogin(page, me)
  await openAllocations(page)
  const keys = await page.locator('[data-testid^="kind-section-"]').evaluateAll((els) =>
    els.map((el) => el.getAttribute('data-testid').replace('kind-section-', '')))
  check('(a) dividers in order', keys, ['subscription', 'installment', 'cash', 'bill', 'other', 'shared'])
  const headings = await page.locator('[data-testid^="kind-section-"] h2').allInnerTexts()
  check('(a) divider titles', headings, [
    'Subscriptions', 'Card installments', 'Cash expenses', 'Card-billed bills', 'Income & transfers', 'Shared with you',
  ])
  check('(a) Streaming is a subscription', await cardNamed(page, 'subscription', 'Streaming').count(), 1)
  check('(a) Phone plan is an installment', await cardNamed(page, 'installment', 'Phone plan').count(), 1)
  check('(a) Gym is a cash expense', await cardNamed(page, 'cash', 'Gym').count(), 1)
  check('(a) Electric (Utilities) is a bill', await cardNamed(page, 'bill', 'Electric').count(), 1)
  check('(a) Salary is income', await cardNamed(page, 'other', 'Salary').count(), 1)
  check('(a) the shared divider holds their entry', await section(page, 'shared').locator('article').count(), 1)
  check('(a) no Mark paid in the shared divider', await section(page, 'shared').getByText('Mark paid').count(), 0)
  await ctx.close()
  return world
}

async function markPaidInstallment(browser) {
  console.log('(b) Mark paid on an installment')
  const me = await makeUser('b')
  const world = await seed(me)
  const { ctx, page } = await newPage(browser)
  await uiLogin(page, me)
  await openAllocations(page)
  const card = cardNamed(page, 'installment', 'Phone plan')
  check('(b) Next is the first occurrence', await nextOf(card), fmt(world.start))
  check('(b) nothing paid yet', await card.getByText('3 payments planned').count(), 1)
  await card.getByTestId('entry-mark-paid-button').click()
  await page.locator('[data-testid="mark-paid-dialog"]').waitFor()
  await page.locator('[data-testid="mark-paid-occurrence"]').waitFor()
  check('(b) the edit form did not open', await editForm(page).count(), 0)
  await page.locator('[data-testid="mark-paid-submit"]').click()
  await page.locator('[data-testid="mark-paid-dialog"]').waitFor({ state: 'detached' })
  await settle(page)
  const after = cardNamed(page, 'installment', 'Phone plan')
  check('(b) Next advanced a month', await nextOf(after), fmt(addMonths(world.start, 1)))
  check('(b) Payment 1 of 3', await after.getByText('Payment 1 of 3').count(), 1)
  check('(b) the edit form still did not open', await editForm(page).count(), 0)
  await ctx.close()
}

/** Fills the Add Recurring Entry form for a card expense. */
async function fillForm(page, { name, amount, cardName, category }) {
  await page.getByRole('button', { name: 'Add Recurring Entry' }).click()
  await editForm(page).waitFor()
  const form = page.locator('form').filter({ has: page.getByRole('button', { name: 'Save Recurring Entry' }) })
  await form.locator('input[type="text"]').first().fill(name)
  await form.locator('input[type="number"]').first().fill(String(amount))
  await form.locator('select').filter({ has: page.locator('option', { hasText: 'Select account' }) }).selectOption({ label: cardName })
  if (category) {
    await form.locator('select').filter({ has: page.locator('option', { hasText: 'Uncategorized' }) }).selectOption({ label: category })
  }
  return form
}

async function automaticUtilities(browser) {
  console.log('(c) Utilities on Automatic lands under bills')
  const me = await makeUser('c')
  const world = await seed(me)
  const { ctx, page } = await newPage(browser)
  await uiLogin(page, me)
  await openAllocations(page)
  const form = await fillForm(page, { name: 'Water', amount: 650, cardName: world.cc.name, category: 'Utilities' })
  const kind = form.getByTestId('recurring-kind')
  check('(c) the kind select defaults to Automatic', await kind.inputValue(), 'automatic')
  check('(c) open-ended options', await kind.locator('option').allInnerTexts(), [
    'Automatic (Utilities → Bill)', 'Subscription', 'Bill',
  ])
  await form.getByRole('button', { name: 'Save Recurring Entry' }).click()
  await editForm(page).waitFor({ state: 'detached' })
  await settle(page)
  check('(c) Water is under bills', await cardNamed(page, 'bill', 'Water').count(), 1)
  check('(c) Water is not a subscription', await cardNamed(page, 'subscription', 'Water').count(), 0)
  await ctx.close()
}

async function cappedBill(browser) {
  console.log('(d) a capped Bill moves to bills and back')
  const me = await makeUser('d')
  await seed(me)
  const { ctx, page } = await newPage(browser)
  await uiLogin(page, me)
  await openAllocations(page)

  await cardNamed(page, 'installment', 'Phone plan').click()
  await editForm(page).waitFor()
  const form = page.locator('form').filter({ has: page.getByRole('button', { name: 'Update Recurring Entry' }) })
  const kind = form.getByTestId('recurring-kind')
  check('(d) capped options', await kind.locator('option').allInnerTexts(), ['Installment', 'Bill (amount varies)'])
  check('(d) opens on Installment', await kind.inputValue(), 'installment')
  await kind.selectOption('bill')
  await form.getByRole('button', { name: 'Update Recurring Entry' }).click()
  await editForm(page).waitFor({ state: 'detached' })
  await settle(page)
  check('(d) Phone plan moved to bills', await cardNamed(page, 'bill', 'Phone plan').count(), 1)
  check('(d) Phone plan left installments', await cardNamed(page, 'installment', 'Phone plan').count(), 0)

  await cardNamed(page, 'bill', 'Phone plan').click()
  await editForm(page).waitFor()
  const again = page.locator('form').filter({ has: page.getByRole('button', { name: 'Update Recurring Entry' }) })
  const kindAgain = again.getByTestId('recurring-kind')
  check('(d) reopens on Bill', await kindAgain.inputValue(), 'bill')
  await kindAgain.selectOption('installment')
  await again.getByRole('button', { name: 'Update Recurring Entry' }).click()
  await editForm(page).waitFor({ state: 'detached' })
  await settle(page)
  check('(d) Phone plan is back under installments', await cardNamed(page, 'installment', 'Phone plan').count(), 1)
  check('(d) Phone plan left bills', await cardNamed(page, 'bill', 'Phone plan').count(), 0)
  await ctx.close()
}

async function viewer(browser) {
  console.log('(e) a viewer sees no Mark paid')
  const owner = await makeUser('e-owner')
  const watcher = await makeUser('e-viewer')
  const world = await seed(owner)
  // The viewer sees the owner's entries only through shares on the accounts they use.
  await post(owner.token, `/accounts/${world.bank.id}/shares`, { email: watcher.email, role: 'viewer' })
  await post(owner.token, `/accounts/${world.cc.id}/shares`, { email: watcher.email, role: 'viewer' })

  const own = await newPage(browser)
  await uiLogin(own.page, owner)
  await openAllocations(own.page)
  check('(e) the owner has Mark paid buttons', (await own.page.getByTestId('entry-mark-paid-button').count()) > 0, true)
  await own.ctx.close()

  const { ctx, page } = await newPage(browser)
  await uiLogin(page, watcher)
  await openAllocations(page)
  await settle(page)
  check('(e) the viewer sees the shared entries', (await page.locator('article').count()) > 0, true)
  check('(e) the viewer sees no Mark paid', await page.getByTestId('entry-mark-paid-button').count(), 0)
  await ctx.close()
}

;(async () => {
  stack = await startLocalStack()
  API = `${stack.apiUrl}/api/v1`
  const browser = await chromium.launch()
  const run = (k) => !only || only === k
  if (run('a')) await dividers(browser)
  if (run('b')) await markPaidInstallment(browser)
  if (run('c')) await automaticUtilities(browser)
  if (run('d')) await cappedBill(browser)
  if (run('e')) await viewer(browser)
  await browser.close()
  stack.stop()
  console.log(`\nRESULT: ${pass}/${total} assertions passed`)
  process.exit(pass === total ? 0 : 1)
})().catch((e) => { console.error(e); stack?.stop(); console.log(`\nRESULT (aborted): ${pass}/${total} assertions passed`); process.exit(1) })
