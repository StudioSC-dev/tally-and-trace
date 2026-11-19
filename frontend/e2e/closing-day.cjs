// Browser check for STU-747 (AC6): changing a card's closing day in the account form, when the
// card has an installment with payments left, opens a confirm step that shows what moves, and
// applying it moves the installment onto the new close. Starts its own API and web app against
// a throwaway database (./_local_stack.cjs). Not wired into CI and not part of `pnpm build`.
// Run steps: see ./README.md.
//
// Scenario (run at 390x844 and at 1280x800, each with its own user and card):
//   a card closing on the 10th has an installment whose next charge is a coming 10th. In the
//   form the closing day goes to the 24th and Update account is pressed:
//     - the step opens with focus inside it, names "Installment #<id>" with its next charge
//       before and after, offers Change closing day, and has no horizontal scroll
//     - Cancel closes it, focus returns to Update account and the API still has the 10th
//     - Update account again, then Change closing day: the form closes, the API has the 24th
//       and the installment's next charge is the 24th of the same month
//     - the Installments tab on Transactions shows "Next charge" on that new date
//
// Escape closes the step and returns focus to Update account.
//
// Two more scenarios, each on its own card at 1280x800:
//   (history) an installment moves and an older posted charge sits on a statement the new day
//     would change: the step lists the past statement, Change closing day waits for the tick
//     "I understand past statements will change", and the API has the new day after it
//   (plain) no installment or due, only an older posted charge: no step ever appears, the only
//     closing-day requests are dry runs, the PUT saves, and the API has the new day
//
// Usage: node frontend/e2e/closing-day.cjs [phone|desktop|history|plain]
const { startLocalStack } = require('./_local_stack.cjs')
const { waitQuiet } = require('./_smooth.cjs')
const { openDueTab, useDueCheck } = require('./_due_pages.cjs')

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

const VIEWPORTS = [
  { name: 'phone', width: 390, height: 844 },
  { name: 'desktop', width: 1280, height: 800 },
]

// ─── Days (YYYY-MM-DD, UTC arithmetic) ───────────────────────────────────────
const manilaToday = () => new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10)
const addDays = (day, n) => {
  const d = new Date(`${day}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().slice(0, 10)
}
const addMonths = (day, n, anchor) => {
  let y = Number(day.slice(0, 4))
  let m = Number(day.slice(5, 7)) + n
  while (m > 12) { m -= 12; y += 1 }
  while (m < 1) { m += 12; y -= 1 }
  return `${y}-${String(m).padStart(2, '0')}-${String(anchor).padStart(2, '0')}`
}
/** The first `anchor`th at least three days ahead, so no charge is due or posted yet. */
const firstOn = (anchor) => {
  const today = manilaToday()
  const earliest = addDays(today, 3)
  const sameMonth = addMonths(today, 0, anchor)
  return sameMonth >= earliest ? sameMonth : addMonths(today, 1, anchor)
}
const wire = (day) => `${day}T00:00:00`
const ordinal = (n) => `${n}${n % 100 >= 11 && n % 100 <= 13 ? 'th' : ({ 1: 'st', 2: 'nd', 3: 'rd' })[n % 10] ?? 'th'}`
/** The app's date text: "Dec 24th, 2026". */
const shown = (day) =>
  `${new Date(`${day}T00:00:00Z`).toLocaleString('en-US', { month: 'short', timeZone: 'UTC' })} ${ordinal(Number(day.slice(8, 10)))}, ${day.slice(0, 4)}`

const OLD_CLOSE = 10
const NEW_CLOSE = 24

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
  const email = `e2e-cd-${tag}-${Math.random().toString(16).slice(2, 8)}@example.com`
  const password = 'E2eTest!2345'
  const reg = await api('', 'POST', '/auth/register', { email, password, first_name: `User${tag}`, last_name: 'Test', default_currency: 'PHP' })
  if (reg.status !== 200 && reg.status !== 201) throw new Error(`register ${reg.status} ${JSON.stringify(reg.json)}`)
  stack.verifyUser(email) // aborts the run unless psql reports UPDATE 1
  const login = await api('', 'POST', '/auth/login', { email, password })
  if (login.status !== 200) throw new Error(`login ${login.status}`)
  return { email, password, tag, token: login.json.access_token }
}

/** A card closing on the 10th with a six-payment monthly installment starting on a coming 10th. */
async function seed(u) {
  const bank = await post(u.token, '/accounts/', { name: `${u.tag} Checking`, account_type: 'checking', balance: 100000, currency: 'PHP' })
  const card = await post(u.token, '/accounts/', {
    name: `${u.tag} Visa`, account_type: 'credit', balance: 0, currency: 'PHP', credit_limit: 100000,
    billing_cycle_start: OLD_CLOSE, days_until_due_date: 21, payment_account_id: bank.id,
  })
  const start = firstOn(OLD_CLOSE)
  const entry = await post(u.token, '/budget-entries/', {
    entry_type: 'expense', currency: 'PHP', cadence: 'monthly', name: 'Laptop plan', amount: 2500,
    account_id: card.id, next_occurrence: wire(start), end_mode: 'after_occurrences', max_occurrences: 6,
  })
  return { card, entry, start }
}

async function uiLogin(page, u) {
  await page.goto(`${stack.webUrl}/login`)
  await page.locator('#email').fill(u.email)
  await page.locator('#password').fill(u.password)
  await page.getByRole('button', { name: 'Sign in', exact: true }).click()
  await page.waitForURL((url) => url.pathname === '/')
  await waitQuiet(page)
}

const testId = (page, id) => page.locator(`[data-testid="${id}"]`)
const text = async (locator) => (await locator.textContent())?.replace(/\s+/g, ' ').trim()

async function openForm(page, card) {
  await page.goto(`${stack.webUrl}/accounts`)
  await page.getByText(card.name, { exact: true }).first().waitFor()
  await waitQuiet(page)
  await page.locator('article').filter({ has: page.getByText(card.name, { exact: true }) }).locator('[role="button"]').first().click()
  await page.getByRole('button', { name: 'Edit account' }).click()
  await page.getByRole('button', { name: 'Show details' }).click()
}
const closeField = (page) => page.locator('label:text-is("Statement closes (day of month)") + select')

async function scenario(browser, viewport) {
  const tag = `${viewport.name}`
  console.log(`\n(${tag}) ${viewport.width}x${viewport.height}: a card's closing day changes with its installment`)
  const u = await makeUser(tag)
  const { card, entry, start } = await seed(u)
  const newNext = addMonths(start, 0, NEW_CLOSE)
  check(`(${tag}) the installment starts on the old close`, (await get(u.token, `/budget-entries/${entry.id}`)).next_occurrence.slice(0, 10), start)

  const ctx = await browser.newContext({ viewport: { width: viewport.width, height: viewport.height }, hasTouch: viewport.name === 'phone' })
  const page = await ctx.newPage()
  if (process.env.DEBUG) page.on('response', (r) => { if (r.url().includes('/api/v1/')) console.log(`    [net] ${r.request().method()} ${r.url().replace(API, '')} -> ${r.status()}`) })
  try {
    await uiLogin(page, u)
    await openForm(page, card)
    await closeField(page).selectOption(String(NEW_CLOSE))
    const update = page.getByRole('button', { name: 'Update account', exact: true })
    await update.click()

    const dialog = testId(page, 'close-day-dialog')
    await testId(page, 'close-day-confirm').waitFor()
    check(`(${tag}) the step is a modal dialog named for the change`, await page.evaluate(() => {
      const el = document.querySelector('[data-testid="close-day-dialog"]')
      const label = el?.getAttribute('aria-labelledby')
      return [el?.getAttribute('role'), el?.getAttribute('aria-modal'), label ? document.getElementById(label)?.textContent : null]
    }), ['dialog', 'true', 'Change the closing day'])
    check(`(${tag}) focus is inside the step`, await page.evaluate(() => document.querySelector('[data-testid="close-day-dialog"]')?.contains(document.activeElement) ?? false), true)
    check(`(${tag}) the headline gives the old and new day`, await text(testId(page, 'close-day-headline')), `The closing day moves from the ${ordinal(OLD_CLOSE)} to the ${ordinal(NEW_CLOSE)}.`)
    check(`(${tag}) the installment's next charge is shown before and after`, await text(testId(page, 'close-day-installments').locator('li')),
      `Installment #${entry.id}: the next charge moves from ${shown(start)} to ${shown(newNext)}.`)
    check(`(${tag}) no checkbox: no past statement changes`, await testId(page, 'close-day-ack').count(), 0)
    check(`(${tag}) the page does not scroll sideways`, await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), true)
    const box = await dialog.boundingBox()
    check(`(${tag}) the step fits the viewport width`, box !== null && box.x >= 0 && box.x + box.width <= viewport.width, true)
    check(`(${tag}) the API has changed nothing yet`, (await get(u.token, `/accounts/${card.id}`)).billing_cycle_start, OLD_CLOSE)

    // Cancel: the step closes, focus returns to Update account, nothing is saved.
    await testId(page, 'close-day-cancel').click()
    await dialog.waitFor({ state: 'detached' })
    check(`(${tag}) Cancel returns focus to Update account`, await update.evaluate((el) => el === document.activeElement), true)
    check(`(${tag}) the form is still open on the new day`, await closeField(page).inputValue(), String(NEW_CLOSE))
    check(`(${tag}) Cancel changed nothing`, (await get(u.token, `/accounts/${card.id}`)).billing_cycle_start, OLD_CLOSE)

    // Escape closes it the same way.
    await update.click()
    await testId(page, 'close-day-confirm').waitFor()
    await page.keyboard.press('Escape')
    await dialog.waitFor({ state: 'detached' })
    check(`(${tag}) Escape closes the step and returns focus to Update account`, await update.evaluate((el) => el === document.activeElement), true)

    // Confirm.
    await update.click()
    await testId(page, 'close-day-confirm').waitFor()
    await testId(page, 'close-day-confirm').click()
    await dialog.waitFor({ state: 'detached' })
    await update.waitFor({ state: 'detached' })
    await waitQuiet(page)
    check(`(${tag}) the API has the new closing day`, (await get(u.token, `/accounts/${card.id}`)).billing_cycle_start, NEW_CLOSE)
    check(`(${tag}) the installment's next charge is on the new close`, (await get(u.token, `/budget-entries/${entry.id}`)).next_occurrence.slice(0, 10), newNext)

    // The app shows it: the Installments tab's plan row.
    await page.goto(`${stack.webUrl}/transactions`)
    await page.locator('[data-testid="due-section"]').waitFor()
    await page.locator('[data-testid="due-count"]').filter({ hasNotText: '…' }).waitFor()
    await waitQuiet(page)
    await openDueTab(page, 'installments')
    const row = page.locator(`[data-testid="due-row"][data-kind="installment"][data-source="budget_entry:${entry.id}"]`)
    await row.waitFor()
    check(`(${tag}) the plan row is on the new close`, await row.getAttribute('data-day'), newNext)
    check(`(${tag}) the plan row says so`, (await text(row)).includes(`Next charge ${shown(newNext)}`), true)
  } finally {
    await ctx.close()
  }
}

/** An old posted charge a new closing day would move to another statement. */
const oldCharge = (u, card) => post(u.token, '/transactions/', {
  account_id: card.id, transaction_type: 'debit', amount: 100, description: 'Old charge',
  transaction_date: wire(`${addDays(manilaToday(), -40).slice(0, 8)}15`), is_posted: true,
})
async function seedCard(u, tag) {
  const bank = await post(u.token, '/accounts/', { name: `${tag} Checking`, account_type: 'checking', balance: 100000, currency: 'PHP' })
  return post(u.token, '/accounts/', {
    name: `${tag} Visa`, account_type: 'credit', balance: 0, currency: 'PHP', credit_limit: 100000,
    billing_cycle_start: OLD_CLOSE, days_until_due_date: 21, payment_account_id: bank.id,
  })
}

/** An installment and a closed statement a new day would change: the step asks for a tick. */
async function historyScenario(browser) {
  const tag = 'history'
  console.log(`\n(${tag}) 1280x800: an installment moves and past statements would change, so the step asks for a tick`)
  const u = await makeUser(tag)
  const card = await seedCard(u, tag)
  await post(u.token, '/budget-entries/', {
    entry_type: 'expense', currency: 'PHP', cadence: 'monthly', name: 'Phone plan', amount: 900,
    account_id: card.id, next_occurrence: wire(firstOn(OLD_CLOSE)), end_mode: 'after_occurrences', max_occurrences: 6,
  })
  await oldCharge(u, card)
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } })
  const page = await ctx.newPage()
  try {
    await uiLogin(page, u)
    await openForm(page, card)
    await closeField(page).selectOption(String(NEW_CLOSE))
    await page.getByRole('button', { name: 'Update account', exact: true }).click()
    const confirm = testId(page, 'close-day-confirm')
    await confirm.waitFor()
    check(`(${tag}) the step lists the past statement`, (await testId(page, 'close-day-history').locator('li').count()) > 0, true)
    check(`(${tag}) the checkbox is offered, unticked, with its words`, [await testId(page, 'close-day-ack').isChecked(), await text(testId(page, 'close-day-ack-label'))], [false, 'I understand past statements will change'])
    check(`(${tag}) Change closing day waits for the tick`, await confirm.isDisabled(), true)
    await testId(page, 'close-day-ack').check()
    check(`(${tag}) the tick enables it`, await confirm.isDisabled(), false)
    await confirm.click()
    await testId(page, 'close-day-dialog').waitFor({ state: 'detached' })
    await waitQuiet(page)
    check(`(${tag}) the API has the new closing day`, (await get(u.token, `/accounts/${card.id}`)).billing_cycle_start, NEW_CLOSE)
  } finally {
    await ctx.close()
  }
}

/** No installment or due, but an old charge: the form saves through the PUT as before, with no step. */
async function plainScenario(browser) {
  const tag = 'plain'
  console.log(`\n(${tag}) 1280x800: nothing to move, so no step and no apply: the PUT saves`)
  const u = await makeUser(tag)
  const card = await seedCard(u, tag)
  await oldCharge(u, card)
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } })
  const page = await ctx.newPage()
  const closingDay = []
  page.on('request', (r) => { if (r.url().includes('/closing-day')) closingDay.push(JSON.parse(r.postData() ?? '{}').dry_run) })
  try {
    await uiLogin(page, u)
    await openForm(page, card)
    await closeField(page).selectOption(String(NEW_CLOSE))
    await page.evaluate(() => {
      window.__sawStep = false
      new MutationObserver(() => {
        if (document.querySelector('[data-testid="close-day-dialog"]')) window.__sawStep = true
      }).observe(document.body, { childList: true, subtree: true })
    })
    const saved = page.waitForResponse((r) => r.request().method() === 'PUT' && new URL(r.url()).pathname.endsWith(`/accounts/${card.id}`))
    await page.getByRole('button', { name: 'Update account', exact: true }).click()
    check(`(${tag}) the PUT answers 200`, (await saved).status(), 200)
    await page.getByRole('button', { name: 'Update account', exact: true }).waitFor({ state: 'detached' })
    await waitQuiet(page)
    check(`(${tag}) no step ever appeared`, await page.evaluate(() => window.__sawStep), false)
    // The dev server's StrictMode runs the check twice; every request is a dry run, none applies.
    check(`(${tag}) only dry runs were sent to the closing-day route`, [closingDay.length > 0, closingDay.every((dry) => dry === true)], [true, true])
    check(`(${tag}) the API has the new closing day`, (await get(u.token, `/accounts/${card.id}`)).billing_cycle_start, NEW_CLOSE)
  } finally {
    await ctx.close()
  }
}

async function main() {
  stack = await startLocalStack()
  API = `${stack.apiUrl}/api/v1`
  const browser = await chromium.launch()
  try {
    for (const viewport of VIEWPORTS) {
      if (only && only !== viewport.name) continue
      await scenario(browser, viewport)
    }
    if (!only || only === 'history') await historyScenario(browser)
    if (!only || only === 'plain') await plainScenario(browser)
  } finally {
    await browser.close()
    stack.stop()
  }
  console.log(`\nRESULT: ${pass}/${total}`)
  process.exit(pass === total ? 0 : 1)
}

main().catch((e) => {
  console.error(e)
  try { stack?.stop() } catch { /* already stopped */ }
  process.exit(1)
})
