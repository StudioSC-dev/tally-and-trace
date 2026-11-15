// Browser check for STU-638: the dates typed into the Allocations form (a savings
// target date, a budget's period start and end) are stored and shown back as typed,
// whatever the browser's time zone. The allocation date columns are naive and keep the
// UTC components as sent, so a local-midnight toISOString() stored the previous day
// east of UTC (and the form then showed that day back).
// Starts its own API and web app against a throwaway database (./_local_stack.cjs).
// Not wired into CI and not part of `pnpm build`. Run steps: see ./README.md.
//
// Suite: budget_date_round_trip. Scenarios:
//   entered_calendar_date_is_preserved   target date, period start and period end, each
//       entered through the form in UTC+8, UTC-8 and UTC, across a month and a year
//       boundary: the stored value, the API's reply, the edit form and the card all say D
//   existing_conversion_reproduction     the UTC+8 case that failed before the fix: the
//       original conversion (evaluated in the browser) gives the previous day, and the
//       form as it is now stores and shows D
//   unrelated_budget_fields_are_preserved   the same form keeps its non-date fields, in
//       the database, in the API's reply and in the edit form; an unchanged re-save
//       leaves them as they were
//
// Usage: node frontend/e2e/budget-date-round-trip.cjs [entered_calendar_date_is_preserved|existing_conversion_reproduction|unrelated_budget_fields_are_preserved]
const { startLocalStack } = require('./_local_stack.cjs')
const { pick } = require('./_picker.cjs')

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

// Fixed-offset zones, no daylight saving: +8, -8 and 0.
const ZONES = [
  { id: 'Asia/Manila', label: 'UTC+8' },
  { id: 'Pacific/Pitcairn', label: 'UTC-8' },
  { id: 'UTC', label: 'UTC' },
]
// Far enough ahead that the server never rolls a period on its own.
const CASES = [
  { name: 'month', start: '2031-03-01', end: '2031-04-01', target: '2031-03-01' },
  { name: 'year', start: '2031-01-01', end: '2032-01-01', target: '2032-01-01' },
]

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
  const email = `e2e-bdr-${tag}-${Math.random().toString(16).slice(2, 8)}@example.com`
  const password = 'E2eTest!2345'
  const reg = await api('', 'POST', '/auth/register', { email, password, first_name: `User${tag}`, last_name: 'Test', default_currency: 'PHP' })
  if (reg.status !== 200 && reg.status !== 201) throw new Error(`register ${reg.status} ${JSON.stringify(reg.json)}`)
  stack.verifyUser(email)
  const login = await api('', 'POST', '/auth/login', { email, password })
  if (login.status !== 200) throw new Error(`login ${login.status}`)
  return { email, password, tag, token: login.json.access_token }
}

async function uiLogin(page, u) {
  await page.goto(`${stack.webUrl}/login`)
  await page.locator('#email').fill(u.email)
  await page.locator('#password').fill(u.password)
  await page.getByRole('button', { name: 'Sign in', exact: true }).click()
  await page.waitForURL((url) => url.pathname === '/')
}

const field = (form, key) => form.locator(`[data-field="${key}"]`)
const budgetForm = (page) => page.locator('form').filter({ has: page.getByRole('button', { name: 'Create Budget Envelope' }) })
const savingsForm = (page) => page.locator('form').filter({ has: page.getByRole('button', { name: 'Create Savings Tracker' }) })
const editForm = (page) => page.locator('form').filter({ has: page.getByRole('button', { name: 'Update Allocation' }) })
const modal = (page) => page.getByLabel('Close allocation modal')
const settle = async (page) => { await page.waitForLoadState('networkidle'); await page.waitForTimeout(400) }
const cardNamed = (page, name) =>
  page.locator('article[role="button"]').filter({ has: page.getByText(name, { exact: true }) })
const label = (day) =>
  new Date(`${day}T00:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' })

/** A stored timestamp as the database holds it ('' when null), by allocation name. */
function stored(name, column) {
  const out = stack.psql(
    `SELECT 'V=' || coalesce(to_char(${column}, 'YYYY-MM-DD"T"HH24:MI:SS'), '') FROM allocations WHERE name = '${name}'`,
  )
  const m = /V=(\S*)/.exec(out)
  if (!m) throw new Error(`no allocations row named ${name}`)
  return m[1]
}
const byName = async (token, name) => {
  const list = await get(token, '/allocations/?limit=200')
  return (list.items ?? list).find((a) => a.name === name)
}

async function openTab(page, tab) {
  await page.goto(`${stack.webUrl}/allocations`)
  await page.getByRole('button', { name: tab, exact: true }).waitFor()
  await page.getByRole('button', { name: tab, exact: true }).click()
  await settle(page)
}

async function createBudget(page, bank, name, { start, end, amount = '1000', description } = {}) {
  await page.getByRole('button', { name: 'Add Allocation' }).click()
  const form = budgetForm(page)
  await form.waitFor()
  await field(form, 'account_id').selectOption(String(bank.id))
  await field(form, 'name').fill(name)
  if (description) await form.locator('textarea').fill(description)
  await pick(field(form, 'category_ids'), 'Utilities')
  await field(form, 'target_amount').fill(amount)
  // The end first: moving the start recomputes it.
  await field(form, 'period_start').fill(start)
  if (end) await field(form, 'period_end').fill(end)
  else await field(form, 'period_end').fill('')
  await form.getByRole('button', { name: 'Create Budget Envelope' }).click()
  await modal(page).waitFor({ state: 'detached' })
  await settle(page)
}

async function createSavings(page, bank, name, { target, amount = '5000' } = {}) {
  await page.getByRole('button', { name: 'Add Allocation' }).click()
  const form = savingsForm(page)
  await form.waitFor()
  await field(form, 'account_id').selectOption(String(bank.id))
  await field(form, 'name').fill(name)
  await field(form, 'target_amount').fill(amount)
  // A savings card with no monthly target crashes the page today (null monthly_target); not this ticket's.
  await field(form, 'monthly_target').fill('100')
  await field(form, 'target_date').fill(target)
  await form.getByRole('button', { name: 'Create Savings Tracker' }).click()
  await modal(page).waitFor({ state: 'detached' })
  await settle(page)
}

/** Opens a card's edit form and returns it. */
async function openEdit(page, name) {
  await cardNamed(page, name).click()
  await page.getByRole('button', { name: 'Edit allocation' }).click()
  const form = editForm(page)
  await form.waitFor()
  return form
}
async function closeEdit(page) {
  await page.getByRole('button', { name: 'Cancel', exact: true }).click()
  await modal(page).waitFor({ state: 'detached' })
}

async function world(tag) {
  const user = await makeUser(tag)
  const bank = await post(user.token, '/accounts/', { name: `${tag} Checking`, account_type: 'checking', balance: 100000, currency: 'PHP' })
  return { user, bank }
}

async function enteredCalendarDateIsPreserved(browser) {
  console.log('entered_calendar_date_is_preserved')
  const { user, bank } = await world('a')
  for (const zone of ZONES) {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 1000 }, timezoneId: zone.id })
    const page = await ctx.newPage()
    page.setDefaultTimeout(15000)
    await uiLogin(page, user)
    for (const c of CASES) {
      const tag = `${zone.label} ${c.name}`
      const budget = `B ${tag}`
      const only = `S ${tag}`
      const goal = `G ${tag}`
      await openTab(page, 'Budgets')
      await createBudget(page, bank, budget, { start: c.start, end: c.end })
      await createBudget(page, bank, only, { start: c.start })
      await openTab(page, 'Savings')
      await createSavings(page, bank, goal, { target: c.target })

      // Stored: the calendar day at midnight, as the database holds it.
      check(`${tag}: period_start stored`, stored(budget, 'period_start'), `${c.start}T00:00:00`)
      check(`${tag}: period_end stored`, stored(budget, 'period_end'), `${c.end}T00:00:00`)
      check(`${tag}: a start-only budget's period_start stored`, stored(only, 'period_start'), `${c.start}T00:00:00`)
      check(`${tag}: a start-only budget has no period_end`, stored(only, 'period_end'), '')
      check(`${tag}: target_date stored`, stored(goal, 'target_date'), `${c.target}T00:00:00`)
      // Returned by the API.
      const b = await byName(user.token, budget)
      check(`${tag}: API returns period_start`, b.period_start.slice(0, 10), c.start)
      check(`${tag}: API returns period_end`, b.period_end.slice(0, 10), c.end)
      check(`${tag}: API returns target_date`, (await byName(user.token, goal)).target_date.slice(0, 10), c.target)

      // Shown back: the edit form's date inputs and the card's start label.
      await openTab(page, 'Budgets')
      check(`${tag}: card shows the period start`, (await cardNamed(page, budget).innerText()).includes(label(c.start)), true)
      let form = await openEdit(page, budget)
      check(`${tag}: edit form period_start`, await field(form, 'period_start').inputValue(), c.start)
      check(`${tag}: edit form period_end`, await field(form, 'period_end').inputValue(), c.end)
      await closeEdit(page)
      form = await openEdit(page, only)
      check(`${tag}: edit form period_start (start only)`, await field(form, 'period_start').inputValue(), c.start)
      await closeEdit(page)
      await openTab(page, 'Savings')
      form = await openEdit(page, goal)
      check(`${tag}: edit form target_date`, await field(form, 'target_date').inputValue(), c.target)
      await closeEdit(page)
    }
    await ctx.close()
  }
}

async function existingConversionReproduction(browser) {
  console.log('existing_conversion_reproduction')
  const { user, bank } = await world('b')
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 1000 }, timezoneId: 'Asia/Manila' })
  const page = await ctx.newPage()
  page.setDefaultTimeout(15000)
  await uiLogin(page, user)
  const day = '2031-01-01'
  // The original conversion, run in the UTC+8 browser: the previous day, on a year boundary.
  const original = await page.evaluate((d) => new Date(`${d}T00:00:00`).toISOString(), day)
  check('original conversion in UTC+8 sends the previous day', original, '2030-12-31T16:00:00.000Z')
  // What the API keeps and returns for exactly that value (the evidence of the bug).
  const sent = await post(user.token, '/allocations/', {
    account_id: bank.id, name: 'Original conversion', allocation_type: 'budget', target_amount: 1000,
    period_frequency: 'monthly', period_start: original, configuration: {},
  })
  check('stored for the original conversion', stored('Original conversion', 'period_start'), '2030-12-31T16:00:00')
  check('returned for the original conversion (no zone)', sent.period_start, '2030-12-31T16:00:00')
  check('shown in a UTC+8 browser for the original conversion',
    await page.evaluate((v) => { const d = new Date(v); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` }, sent.period_start),
    '2030-12-31')

  // The form as it is now, same browser, same day.
  await openTab(page, 'Budgets')
  await createBudget(page, bank, 'Fixed conversion', { start: day, end: '2031-02-01' })
  check('fixed form: period_start stored', stored('Fixed conversion', 'period_start'), `${day}T00:00:00`)
  const form = await openEdit(page, 'Fixed conversion')
  check('fixed form: edit form period_start', await field(form, 'period_start').inputValue(), day)
  await closeEdit(page)
  await ctx.close()
}

async function unrelatedBudgetFieldsArePreserved(browser) {
  console.log('unrelated_budget_fields_are_preserved')
  const { user, bank } = await world('c')
  const categories = await get(user.token, '/categories/?limit=200')
  const utilities = (categories.items ?? categories).find((c) => c.name.toLowerCase() === 'utilities')
  if (!utilities) throw new Error('no Utilities category on a new account')
  const name = 'Fields budget'
  const description = 'Keeps its other fields'
  const wanted = {
    name, description, allocation_type: 'budget', account_id: bank.id, target_amount: 1500,
    current_amount: 0, period_frequency: 'monthly', is_active: true, category_ids: [utilities.id],
  }
  const pickFields = (a) => ({
    name: a.name, description: a.description, allocation_type: a.allocation_type, account_id: a.account_id,
    target_amount: a.target_amount, current_amount: a.current_amount, period_frequency: a.period_frequency,
    is_active: a.is_active, category_ids: a.configuration?.category_ids,
  })
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 1000 }, timezoneId: 'Asia/Manila' })
  const page = await ctx.newPage()
  page.setDefaultTimeout(15000)
  await uiLogin(page, user)
  await openTab(page, 'Budgets')
  await createBudget(page, bank, name, { start: '2031-03-01', end: '2031-04-01', amount: '1500', description })
  check('created: non-date fields in the API reply', pickFields(await byName(user.token, name)), wanted)
  check('created: non-date fields in the database',
    stack.psql(`SELECT 'V=' || target_amount::int || '|' || period_frequency || '|' || is_active || '|' || description || '|' || (configuration::json->'category_ids')::text FROM allocations WHERE name = '${name}'`).match(/V=(.+)/)?.[1].trim(),
    `1500|monthly|true|${description}|[${utilities.id}]`)
  const form = await openEdit(page, name)
  check('edit form: name', await field(form, 'name').inputValue(), name)
  check('edit form: description', await form.locator('textarea').inputValue(), description)
  check('edit form: target_amount', await field(form, 'target_amount').inputValue(), '1500')
  check('edit form: account', await field(form, 'account_id').inputValue(), String(bank.id))
  await form.getByRole('button', { name: 'Update Allocation' }).click()
  await modal(page).waitFor({ state: 'detached' })
  await settle(page)
  check('after an unchanged re-save: non-date fields', pickFields(await byName(user.token, name)), wanted)
  check('after an unchanged re-save: dates', [stored(name, 'period_start'), stored(name, 'period_end')],
    ['2031-03-01T00:00:00', '2031-04-01T00:00:00'])
  await ctx.close()
}

;(async () => {
  stack = await startLocalStack()
  API = `${stack.apiUrl}/api/v1`
  const browser = await chromium.launch()
  const run = (k) => !only || only === k
  if (run('entered_calendar_date_is_preserved')) await enteredCalendarDateIsPreserved(browser)
  if (run('existing_conversion_reproduction')) await existingConversionReproduction(browser)
  if (run('unrelated_budget_fields_are_preserved')) await unrelatedBudgetFieldsArePreserved(browser)
  await browser.close()
  stack.stop()
  console.log(`\nRESULT: ${pass}/${total} assertions passed`)
  process.exit(pass === total ? 0 : 1)
})().catch((e) => { console.error(e); stack?.stop(); console.log(`\nRESULT (aborted): ${pass}/${total} assertions passed`); process.exit(1) })
