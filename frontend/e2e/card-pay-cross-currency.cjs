// Browser check for STU-654: the card Pay dialog pays a credit card from an account in
// another currency. Starts its own API and web app against a throwaway database
// (./_local_stack.cjs). Not wired into CI. Run steps: see ./README.md.
//
// The card is in USD (USD 300 charged, statement closed); the cross-currency payer is a
// PHP account. No exchange rate is needed: the figures are typed.
//
// Scenarios (each at 390x844 and 1280x800):
//   pay_dialog_cross_currency          choosing the PHP payer shows "Amount sent (PHP)" and
//                                      relabels the amount "received by the card (USD)"; a
//                                      payment with both figures succeeds, the PHP account
//                                      moves by the sent figure and the card by the
//                                      received one; sent is required
//   pay_dialog_same_currency_unchanged a USD payer shows no sent field and the label stays
//                                      "Amount (USD)"; the payment moves both by the one figure
//
// Usage: node frontend/e2e/card-pay-cross-currency.cjs
const { startLocalStack } = require('./_local_stack.cjs')
const { waitQuiet } = require('./_smooth.cjs')

const playwrightPath = process.env.PLAYWRIGHT_PATH || 'playwright'
let chromium
try {
  ;({ chromium } = require(playwrightPath))
} catch {
  console.error(`Cannot load Playwright from "${playwrightPath}". Set PLAYWRIGHT_PATH (see frontend/e2e/README.md).`)
  process.exit(2)
}

let pass = 0, total = 0
function check(what, actual, expected) {
  total++
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (ok) pass++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${what}: actual=${JSON.stringify(actual)} expected=${JSON.stringify(expected)}`)
}

const manilaToday = () => new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10)
const addDays = (day, n) => {
  const d = new Date(`${day}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().slice(0, 10)
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
const get = async (token, url) => {
  const r = await api(token, 'GET', url)
  if (r.status >= 300) throw new Error(`GET ${url} ${r.status} ${JSON.stringify(r.json)}`)
  return r.json
}

async function makeUser(tag) {
  const email = `e2e-xpay-${tag}-${Math.random().toString(16).slice(2, 8)}@example.com`
  const password = 'E2eTest!2345'
  const reg = await api('', 'POST', '/auth/register', { email, password, first_name: `User${tag}`, last_name: 'Test', default_currency: 'PHP' })
  if (reg.status !== 200 && reg.status !== 201) throw new Error(`register ${reg.status} ${JSON.stringify(reg.json)}`)
  stack.verifyUser(email)
  const login = await api('', 'POST', '/auth/login', { email, password })
  if (login.status !== 200) throw new Error(`login ${login.status}`)
  return { email, password, token: login.json.access_token }
}

async function uiLogin(page, u) {
  await page.goto(`${stack.webUrl}/login`)
  await page.locator('#email').fill(u.email)
  await page.locator('#password').fill(u.password)
  await page.getByRole('button', { name: 'Sign in', exact: true }).click()
  await page.waitForURL((url) => url.pathname === '/')
}

const VIEWPORTS = [{ width: 390, height: 844 }, { width: 1280, height: 800 }]
const balanceOf = async (u, id) => (await get(u.token, `/accounts/${id}`)).balance

async function scenario(browser, viewport) {
  const tag = `${viewport.width}`
  console.log(`\n=== ${viewport.width}x${viewport.height}`)
  const today = manilaToday()
  const anchor = addDays(today, -5)
  const closeDom = Math.min(Number(anchor.slice(8, 10)), 28)
  const close = `${anchor.slice(0, 8)}${String(closeDom).padStart(2, '0')}`
  const u = await makeUser(tag)
  const mk = (name, currency, balance) => post(u.token, '/accounts/', { name, account_type: 'checking', balance, currency })
  const php = await mk(`PHP Checking ${tag}`, 'PHP', 50000)
  const usd = await mk(`USD Savings ${tag}`, 'USD', 1000)
  const card = await post(u.token, '/accounts/', {
    name: `USD Card ${tag}`, account_type: 'credit', balance: 0, currency: 'USD', credit_limit: 5000,
    billing_cycle_start: closeDom, days_until_due_date: 21, payment_account_id: usd.id,
  })
  await post(u.token, '/transactions/', {
    account_id: card.id, transaction_type: 'debit', amount: 300, currency: 'USD', description: 'Diner',
    transaction_date: `${addDays(close, -3)}T00:00:00`, is_posted: true,
  })

  const ctx = await browser.newContext({ viewport })
  const page = await ctx.newPage()
  try {
    await uiLogin(page, u)
    const open = async () => {
      await page.goto(`${stack.webUrl}/accounts/${card.id}`)
      await page.locator('[data-testid="card-credit-panel"]').waitFor()
      await waitQuiet(page)
      await page.locator('[data-testid="card-pay-open"]').click()
      const dialog = page.locator('[data-testid="card-pay-dialog"]')
      await dialog.locator('[data-testid="card-pay-amount"]').waitFor()
      await waitQuiet(page)
      return dialog
    }
    const noOverflow = async () => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)
    const text = async (l) => (await l.textContent())?.replace(/\s+/g, ' ').trim()

    // pay_dialog_same_currency_unchanged: the default payer is the card's USD account.
    let dialog = await open()
    check(`same_currency@${tag} the USD payer is preselected`, await dialog.locator('[data-testid="card-pay-from"]').inputValue(), String(usd.id))
    check(`same_currency@${tag} no sent field`, await dialog.locator('[data-testid="card-pay-sent"]').count(), 0)
    check(`same_currency@${tag} the label stays Amount (USD)`, await text(dialog.locator('[data-testid="card-pay-amount-label"]')), 'Amount (USD)')
    await dialog.locator('[data-testid="card-pay-amount"]').fill('25')
    let response = page.waitForResponse((r) => r.request().method() === 'POST' && new URL(r.url()).pathname.endsWith(`/cards/${card.id}/payments`))
    await dialog.locator('[data-testid="card-pay-submit"]').click()
    const same = await response
    check(`same_currency@${tag} POST is 201 with no received_amount`, [same.status(), (await same.json()).received_amount], [201, null])
    await dialog.waitFor({ state: 'detached' })
    check(`same_currency@${tag} USD account and card move by 25`, [await balanceOf(u, usd.id), await balanceOf(u, card.id)], [975, -275])

    // pay_dialog_cross_currency
    dialog = await open()
    const options = await dialog.locator('[data-testid="card-pay-from"] option').allTextContents()
    check(`cross_currency@${tag} the PHP account is offered`, options.some((o) => o.includes(php.name)), true)
    await dialog.locator('[data-testid="card-pay-from"]').selectOption(String(php.id))
    check(`cross_currency@${tag} the sent field shows, in PHP`, await text(dialog.locator('[data-testid="card-pay-sent-label"]')), 'Amount sent (PHP)')
    check(`cross_currency@${tag} the amount is the card's received figure`, await text(dialog.locator('[data-testid="card-pay-amount-label"]')), 'Amount received by the card (USD)')
    check(`cross_currency@${tag} no horizontal overflow`, await noOverflow(), true)
    await dialog.locator('[data-testid="card-pay-amount"]').fill('100')
    await dialog.locator('[data-testid="card-pay-submit"]').click()
    check(`cross_currency@${tag} sent is required`, await text(dialog.locator('[data-testid="card-pay-error"]')), 'Enter the amount to send in PHP')
    await dialog.locator('[data-testid="card-pay-sent"]').fill('5800')
    response = page.waitForResponse((r) => r.request().method() === 'POST' && new URL(r.url()).pathname.endsWith(`/cards/${card.id}/payments`))
    await dialog.locator('[data-testid="card-pay-submit"]').click()
    const cross = await response
    const body = await cross.json()
    check(`cross_currency@${tag} POST is 201 with sent and received`, [cross.status(), body.amount, body.received_amount], [201, 5800, 100])
    await dialog.waitFor({ state: 'detached' })
    check(`cross_currency@${tag} PHP moves by the sent figure, the card by the received`, [await balanceOf(u, php.id), await balanceOf(u, card.id)], [44200, -175])
  } finally {
    await ctx.close()
  }
}

;(async () => {
  stack = await startLocalStack()
  API = `${stack.apiUrl}/api/v1`
  const browser = await chromium.launch()
  try {
    for (const viewport of VIEWPORTS) await scenario(browser, viewport)
  } finally {
    await browser.close()
  }
  console.log(`\n${pass}/${total} checks passed`)
  process.exit(pass === total ? 0 : 1)
})().catch((e) => { console.error(e); process.exit(2) })
