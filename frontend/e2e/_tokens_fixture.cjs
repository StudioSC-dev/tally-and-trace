// STU-210: the fixed user, seed data and page helpers shared by the token checks
// (./tokens-alpha.cjs). Nothing here asserts. The fixture is idempotent: it registers the
// user on the first run and signs in on the next, so a baseline run and a later run on the
// same throwaway database see the same data (the screenshot comparison depends on that).
const fs = require('fs')
const pathMod = require('path')
const h = require('./_smooth.cjs')

const MANIFEST = pathMod.join(__dirname, 'tokens-alpha.manifest.json')
const INVENTORY = pathMod.join(__dirname, 'tokens-alpha.inventory.json')

const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'))

const EMAIL = 'e2e-tokens-alpha@example.com'
const PASSWORD = 'E2eTest!2345'

const manilaToday = () => new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10)
const addDays = (day, n) => {
  const d = new Date(`${day}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().slice(0, 10)
}
const wire = (day) => `${day}T00:00:00`

/** Registers (first run) or signs in the fixed user; seeds once. Returns { token, user }. */
async function ensureUser(stack, client) {
  const login = () => client.api('', 'POST', '/auth/login', { email: EMAIL, password: PASSWORD })
  let res = await login()
  if (res.status !== 200) {
    const reg = await client.api('', 'POST', '/auth/register', {
      email: EMAIL, password: PASSWORD, first_name: 'Tokens', last_name: 'Alpha', default_currency: 'PHP',
    })
    if (reg.status !== 200 && reg.status !== 201) throw new Error(`register ${reg.status} ${JSON.stringify(reg.json)}`)
    stack.verifyUser(EMAIL)
    res = await login()
  }
  if (res.status !== 200) throw new Error(`login ${res.status}`)
  const token = res.json.access_token
  // Seeded once: a database that already has accounts keeps what it has.
  const accounts = await client.get(token, '/accounts/')
  const listed = accounts.items
  if (listed.length === 0) await seed(client, token)
  return { email: EMAIL, password: PASSWORD, token }
}

/**
 * Data that makes every inventoried element render: transactions (spending breakdown),
 * income and bills (the forecast table and stat tiles), a bill paid from an account that
 * cannot cover it (the funding shortfalls list), tags (settings) and wishlist items (the
 * purchase plan). Amounts and names are made up.
 */
async function seed(client, token) {
  const today = manilaToday()
  const checking = await client.post(token, '/accounts/', { name: 'Everyday Checking', account_type: 'checking', balance: 80000, currency: 'PHP' })
  const wallet = await client.post(token, '/accounts/', { name: 'Small Wallet', account_type: 'checking', balance: 300, currency: 'PHP' })
  await client.post(token, '/accounts/', {
    name: 'Rewards Card', account_type: 'credit', balance: -4200, currency: 'PHP', credit_limit: 50000,
    due_date: 20, billing_cycle_start: 1, days_until_due_date: 21, payment_account_id: checking.id,
  })
  const categories = await client.get(token, '/categories/')
  const expenseCats = (Array.isArray(categories) ? categories : []).filter((c) => c.kind === 'expense' || c.category_type === 'expense')
  const catIds = (expenseCats.length ? expenseCats : categories).slice(0, 3).map((c) => c.id)
  const spend = [[1200, 'Groceries run'], [450, 'Coffee beans'], [3200, 'Electric bill'], [980, 'Train pass'], [150, 'Snacks']]
  for (let i = 0; i < spend.length; i++) {
    await client.post(token, '/transactions/', {
      account_id: checking.id, transaction_type: 'debit', amount: spend[i][0], description: spend[i][1],
      transaction_date: wire(addDays(today, -(i % 3))), is_posted: true, ...(catIds.length ? { category_id: catIds[i % catIds.length] } : {}),
    })
  }
  await client.post(token, '/transactions/', {
    account_id: checking.id, transaction_type: 'credit', amount: 52000, description: 'Salary',
    transaction_date: wire(addDays(today, -2)), is_posted: true,
  })
  const entries = [
    ['income', 'Salary', 52000, checking.id, 12],
    ['expense', 'Rent', 18000, checking.id, 5],
    ['expense', 'Internet', 1800, checking.id, 9],
    ['expense', 'Phone plan', 900, wallet.id, 7],
    ['expense', 'Gym', 2500, wallet.id, 15],
  ]
  for (const [entry_type, name, amount, account_id, ahead] of entries) {
    await client.post(token, '/budget-entries/', {
      entry_type, name, amount, currency: 'PHP', cadence: 'monthly', account_id, next_occurrence: wire(addDays(today, ahead)),
    })
  }
  for (const [name, color] of [['Fixture sage', '#6b7f5e'], ['Fixture clay', '#8a6b4f']]) {
    await client.post(token, '/tags/', { name, color })
  }
  for (const [name, estimated_cost, priority] of [['Standing desk', 24000, 'high'], ['Camera lens', 38000, 'medium'], ['Weekend trip', 15000, 'low']]) {
    await client.post(token, '/wishlist/', { name, estimated_cost, priority, currency: 'PHP' })
  }
}

/** Saves a signed-in storage state once; every page then starts from it with its theme set. */
async function signedInState(browser, stack, user) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } })
  const page = await ctx.newPage()
  await h.uiLogin(page, stack, user)
  const state = await ctx.storageState()
  await ctx.close()
  return state
}

/** A page on a signed-in state with the stored theme set before first paint. */
async function openPage(browser, state, { theme, viewport }) {
  const ctx = await browser.newContext({ storageState: state, viewport, reducedMotion: 'reduce', colorScheme: theme })
  await ctx.addInitScript((t) => { try { localStorage.setItem('studiosc-theme', t) } catch { /* unavailable */ } }, theme)
  const page = await ctx.newPage()
  return { ctx, page }
}

/** Waits until the page has stopped fetching and no loading skeleton or busy region is left. */
async function settle(page) {
  await h.waitQuiet(page, 5000)
  await page.waitForFunction(() => !document.querySelector('[aria-busy="true"]'), null, { timeout: 15000 }).catch(() => {})
  await h.sleep(200)
}

async function gotoRoute(page, stack, route) {
  await page.goto(`${stack.webUrl}${route}`)
  await page.locator('nav').first().waitFor({ timeout: 30000 })
  await settle(page)
}

module.exports = { MANIFEST, INVENTORY, readJson, ensureUser, signedInState, openPage, settle, gotoRoute, EMAIL }
