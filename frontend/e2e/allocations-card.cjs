// Browser check for STU-639: the Allocations page renders a savings allocation whose API
// `monthly_target` is null (a savings allocation saved without one) instead of crashing with
// "Cannot read properties of null (reading 'toLocaleString')". The card and the allocation
// modal showed the target through `format()` guarded only against undefined.
// Starts its own API and web app against a throwaway database (./_local_stack.cjs).
// Not wired into CI and not part of `pnpm build`. Run steps: see ./README.md.
//
// Suite: allocations_card. Scenarios:
//   savings_null_monthly_target              API monthly_target null: the Savings tab renders the
//       card, shows no "Monthly" figure (card and modal), no page error, the rest of the card is there
//   savings_monthly_target_existing_behavior  numeric (1,250.50), zero and undefined (field removed
//       from the API reply) targets: the card text is what it was before the fix (captured on main)
//
// Usage: node frontend/e2e/allocations-card.cjs [savings_null_monthly_target|savings_monthly_target_existing_behavior]
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
const dump = process.env.DUMP_CARDS === '1'
let pass = 0, total = 0
function check(what, actual, expected) {
  total++
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (ok) pass++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${what}: actual=${JSON.stringify(actual)} expected=${JSON.stringify(expected)}`)
}

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
  const email = `e2e-acard-${tag.toLowerCase()}-${Math.random().toString(16).slice(2, 8)}@example.com`
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

const settle = async (page) => { await page.waitForLoadState('networkidle'); await page.waitForTimeout(400) }
const cardNamed = (page, name) =>
  page.locator('article[role="button"]').filter({ has: page.getByText(name, { exact: true }) })

async function seed(tag, targets) {
  const user = await makeUser(tag)
  const bank = await post(user.token, '/accounts/', { name: `${tag} Checking`, account_type: 'checking', balance: 100000, currency: 'PHP' })
  const names = {}
  for (const [key, monthly] of Object.entries(targets)) {
    const name = `${tag} ${key}`
    names[key] = name
    await post(user.token, '/allocations/', {
      account_id: bank.id, name, allocation_type: 'savings', target_amount: 5000, current_amount: 1000,
      ...(monthly === undefined || monthly === 'omit' ? {} : { monthly_target: monthly }),
      is_active: true,
    })
  }
  return { user, names }
}

/** Open the Savings tab; `mutate` may rewrite the allocations list reply. */
async function openSavings(browser, user, { mutate } = {}) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 1000 }, timezoneId: 'Asia/Manila' })
  const page = await ctx.newPage()
  page.setDefaultTimeout(15000)
  const errors = []
  page.on('pageerror', (e) => errors.push(e.message))
  if (mutate) {
    await page.route(/\/allocations\/(\?.*)?$/, async (route) => {
      if (route.request().method() !== 'GET') return route.continue()
      const res = await route.fetch()
      const json = await res.json()
      const items = Array.isArray(json) ? json : json.items
      items.forEach(mutate)
      await route.fulfill({ response: res, json })
    })
  }
  await uiLogin(page, user)
  await page.goto(`${stack.webUrl}/allocations`)
  await page.getByRole('button', { name: 'Savings', exact: true }).waitFor()
  await page.getByRole('button', { name: 'Savings', exact: true }).click()
  await settle(page)
  return { ctx, page, errors }
}

const cardText = async (page, name) => (await cardNamed(page, name).innerText()).replace(/\s+/g, ' ').trim()

// Card text as captured on main (2d8eb26) before the fix, the card's name replaced by N.
const BASELINE = {
  numeric: 'N Savings SKeep Checking Monthly ₱1,250.50 Current ₱1,000.00 Target ₱5,000.00 20.0% funded Active',
  zero: 'N Savings SKeep Checking Monthly ₱0.00 Current ₱1,000.00 Target ₱5,000.00 20.0% funded Active',
  undef: 'N Savings SKeep Checking Current ₱1,000.00 Target ₱5,000.00 20.0% funded Active',
}

async function savingsNullMonthlyTarget(browser) {
  console.log('\n== savings_null_monthly_target')
  const { user, names } = await seed('SNull', { none: 'omit' })
  const apiRow = ((await api(user.token, 'GET', '/allocations/?limit=200')).json)
  const row = (apiRow.items ?? apiRow).find((a) => a.name === names.none)
  check('API monthly_target is null', row.monthly_target, null)
  const { ctx, page, errors } = await openSavings(browser, user)
  check('card renders', await cardNamed(page, names.none).count(), 1)
  if ((await cardNamed(page, names.none).count()) === 0) {
    check('no page error', errors, [])
    await ctx.close()
    return
  }
  const text = await cardText(page, names.none)
  check('card shows no Monthly figure', /Monthly/.test(text), false)
  check('rest of the card: name, current and target', [text.includes(names.none), text.includes('Current'), text.includes('Target')], [true, true, true])
  await cardNamed(page, names.none).click()
  await settle(page)
  check('modal opens with no monthly target line', [await page.getByText('Monthly target').count(), await page.getByText('Details').count()], [0, 1])
  check('no page error', errors, [])
  await ctx.close()
}

async function savingsMonthlyTargetExistingBehavior(browser) {
  console.log('\n== savings_monthly_target_existing_behavior')
  const { user, names } = await seed('SKeep', { numeric: 1250.5, zero: 0, undef: 'omit' })
  const { ctx, page, errors } = await openSavings(browser, user, {
    // A reply with the field missing altogether (undefined), which the API itself never sends.
    mutate: (a) => { if (a.name === names.undef) delete a.monthly_target },
  })
  const texts = {}
  for (const key of ['numeric', 'zero', 'undef']) texts[key] = await cardText(page, names[key])
  if (dump) console.log('DUMP', JSON.stringify(texts))
  check('numeric target card text', texts.numeric.replace(names.numeric, 'N'), BASELINE.numeric)
  check('zero target card text', texts.zero.replace(names.zero, 'N'), BASELINE.zero)
  check('undefined target card text', texts.undef.replace(names.undef, 'N'), BASELINE.undef)
  check('numeric shows a Monthly figure', /Monthly ₱1,250\.50/.test(texts.numeric), true)
  check('zero shows a Monthly figure', /Monthly ₱0\.00/.test(texts.zero), true)
  check('undefined shows no Monthly figure', /Monthly/.test(texts.undef), false)
  check('no page error', errors, [])
  await ctx.close()
}

;(async () => {
  stack = await startLocalStack()
  API = `${stack.apiUrl}/api/v1`
  const browser = await chromium.launch()
  const run = (k) => !only || only === k
  if (run('savings_null_monthly_target')) await savingsNullMonthlyTarget(browser)
  if (run('savings_monthly_target_existing_behavior')) await savingsMonthlyTargetExistingBehavior(browser)
  await browser.close()
  stack.stop()
  console.log(`\nRESULT: ${pass}/${total} assertions passed`)
  process.exit(pass === total ? 0 : 1)
})().catch((e) => { console.error(e); stack?.stop(); console.log(`\nRESULT (aborted): ${pass}/${total} assertions passed`); process.exit(1) })
