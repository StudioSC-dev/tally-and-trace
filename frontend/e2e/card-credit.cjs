// Browser check for STU-343 Plan C: available credit on the dashboard card panel and
// the Accounts list, the will-it-fail badges, and the minimum due rule in the card
// form. Starts its own API and web app against a throwaway database
// (./_local_stack.cjs). PHP only, so no exchange rate is fetched. Not wired into CI
// and not part of `pnpm build`. Run steps: see ./README.md.
//
// Every expected figure is read from the API (GET /cards/credit, /accounts/...),
// never hard-coded; dates are relative to the Manila today.
//
// Scenarios:
//   (a) the owner's card panel shows the available figure from GET /cards/credit, and
//       what it holds for installments
//   (b) a subscription larger than the credit shows "Would exceed available credit"
//   (c) a planned payment (a pending transfer into the card, dated today + 3) shows
//       "with planned payment by <date>", on the card and on the charge it covers
//   (d) the Accounts card rows show "Available ..." from the same API
//   (e) the edit form stores a bank preset (BDO), its edited floor, and None clears it;
//       Security Bank's empty effective date is handled
//   (f) an editor and a viewer see no credit text, and /cards/{id}/credit is 404
//   (g) charges dated later in the next 30 days come off on their date, are not in the
//       headline, and show on their own line apart from the installment hold; a charge
//       beyond the window counts nowhere
//
// Usage: node frontend/e2e/card-credit.cjs [a|b|c|d|e|f|g]
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
const suffix = (d) => (d % 100 >= 11 && d % 100 <= 13 ? 'th' : ['th', 'st', 'nd', 'rd'][d % 10] || 'th')
/** As the app shows a day: "Oct 25th, 2026". */
const fmt = (day) => {
  const d = new Date(`${day}T00:00:00Z`)
  const month = new Intl.DateTimeFormat('en-US', { month: 'short', timeZone: 'UTC' }).format(d)
  return `${month} ${d.getUTCDate()}${suffix(d.getUTCDate())}, ${d.getUTCFullYear()}`
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
const get = async (token, url) => {
  const r = await api(token, 'GET', url)
  if (r.status >= 300) throw new Error(`GET ${url} ${r.status} ${JSON.stringify(r.json)}`)
  return r.json
}

async function makeUser(tag) {
  const email = `e2e-crd-${tag}-${Math.random().toString(16).slice(2, 8)}@example.com`
  const password = 'E2eTest!2345'
  const reg = await api('', 'POST', '/auth/register', { email, password, first_name: `User${tag}`, last_name: 'Test', default_currency: 'PHP' })
  if (reg.status !== 200 && reg.status !== 201) throw new Error(`register ${reg.status} ${JSON.stringify(reg.json)}`)
  stack.verifyUser(email) // aborts the run unless psql reports UPDATE 1
  const login = await api('', 'POST', '/auth/login', { email, password })
  if (login.status !== 200) throw new Error(`login ${login.status}`)
  return { email, password, tag, token: login.json.access_token }
}
const checking = (u, balance = 100000) => post(u.token, '/accounts/', { name: `${u.tag} Checking`, account_type: 'checking', balance, currency: 'PHP' })
/** A card closing on day 24 of each month, due 21 days later, paid from `bank`. */
const card = (u, bank, name, limit) => post(u.token, '/accounts/', {
  name, account_type: 'credit', balance: 0, currency: 'PHP', credit_limit: limit,
  billing_cycle_start: 24, days_until_due_date: 21, payment_account_id: bank.id,
})
const expense = (u, fields) => post(u.token, '/budget-entries/', { entry_type: 'expense', currency: 'PHP', cadence: 'monthly', ...fields })
const cardCredit = async (u, cardId) => (await get(u.token, '/cards/credit')).items.find((c) => c.account_id === cardId)

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
  await page.locator('[data-testid="payables"], [data-onboarding="upcoming-expenses"]').first().waitFor()
}

const settle = async (page) => { await page.waitForLoadState('networkidle'); await page.waitForTimeout(500) }
const cardSection = (page, name) =>
  page.locator('[data-testid="card-charges-card"]').filter({ has: page.locator('[data-testid="card-charges-name"]', { hasText: name }) })
const chargeRows = (section, name) =>
  section.locator('[data-testid="card-charge-row"]').filter({ has: section.page().getByText(name, { exact: true }) })
const accountRow = (page, name) => page.locator('article').filter({ has: page.getByText(name, { exact: true }) })

// The owner and the three cards the scenarios share.
let owner, bank, cardA, cardB, cardC, plannedDay, subCDay

async function setup() {
  owner = await makeUser('owner')
  bank = await checking(owner)
  const today = manilaToday()

  // Card A: a posted purchase and a three-month installment, so something is held.
  cardA = await card(owner, bank, 'Card A', 50000)
  await post(owner.token, '/transactions/', {
    account_id: cardA.id, transaction_type: 'debit', amount: 1200, description: 'Groceries',
    transaction_date: wire(addDays(today, -2)), is_posted: true,
  })
  await expense(owner, {
    name: 'Phone installment', amount: 1000, next_occurrence: wire(addDays(today, 10)), account_id: cardA.id,
    end_mode: 'after_occurrences', max_occurrences: 3,
  })

  // Card B: a subscription larger than the whole limit.
  cardB = await card(owner, bank, 'Card B', 10000)
  await expense(owner, { name: 'Big Sub', amount: 15000, next_occurrence: wire(addDays(today, 4)), account_id: cardB.id })

  // Card C: a subscription that fits only once a planned payment (a pending transfer
  // from the bank into the card, dated today + 3) lands.
  cardC = await card(owner, bank, 'Card C', 10000)
  plannedDay = addDays(today, 3)
  subCDay = addDays(today, 5)
  await expense(owner, { name: 'Medium Sub', amount: 12000, next_occurrence: wire(subCDay), account_id: cardC.id })
  await post(owner.token, '/transactions/', {
    account_id: bank.id, transfer_from_account_id: bank.id, transfer_to_account_id: cardC.id, transaction_type: 'transfer', amount: 5000,
    description: 'Card payment', transaction_date: wire(plannedDay), is_posted: false,
  })
}

// (a) The card panel shows the API's available figure and what it holds.
async function panelShowsAvailable(browser) {
  console.log('\n=== (a) the card panel shows the available figure from GET /cards/credit')
  const credit = await cardCredit(owner, cardA.id)
  console.log(`    API: available_now ${credit.available_now}; complete ${credit.complete}; hold ${credit.opening.installment_hold}; limit ${credit.limit}`)
  check('(a) the API reserves the installment principal', credit.opening.installment_hold > 0, true)
  const { ctx, page } = await newPage(browser)
  await uiLogin(page, owner)
  await settle(page)
  const section = cardSection(page, 'Card A')
  check('(a) the card has a section', await section.count(), 1)
  check('(a) the headline reads the API\'s available_now',
    (await section.locator('[data-testid="credit-available"]').textContent())?.trim(),
    `Available ${credit.complete ? '' : 'at most '}${peso(credit.available_now)}`)
  check('(a) the line says what is held for installments',
    (await section.locator('[data-testid="credit-held"]').textContent())?.includes(`Includes ${peso(credit.opening.installment_hold)} held for installments`), true)
  check('(a) with no planned payment there is no planned line', await section.locator('[data-testid="credit-with-planned"]').count(), 0)
  const snapshot = (await get(owner.token, '/dashboard/snapshot')).card_charges.find((c) => c.account_id === cardA.id)
  check('(a) the snapshot carries the same figure', snapshot?.credit?.available_now, credit.available_now)
  await ctx.close()
}

// (b) A subscription larger than the credit is flagged.
async function exceedBadge(browser) {
  console.log('\n=== (b) a subscription larger than the credit shows "Would exceed available credit"')
  const credit = await cardCredit(owner, cardB.id)
  const flagged = credit.checks.find((c) => c.kind === 'subscription')
  check('(b) the API flags the subscription at_risk', [flagged?.status, flagged?.relies_on_planned], ['at_risk', null])
  const { ctx, page } = await newPage(browser)
  await uiLogin(page, owner)
  await settle(page)
  const row = chargeRows(cardSection(page, 'Card B'), 'Big Sub')
  check('(b) the subscription is listed', await row.count(), 1)
  const badge = row.locator('[data-testid="credit-check-badge"]')
  check('(b) it carries the exceed badge', [await badge.count(), (await badge.textContent())?.trim(), await badge.getAttribute('data-status')],
    [1, 'Would exceed available credit', 'at_risk'])
  await ctx.close()
}

// (c) A planned payment is flagged on the card and on the charge it covers.
async function plannedPayment(browser) {
  console.log('\n=== (c) a planned payment shows "with planned payment by <date>"')
  const credit = await cardCredit(owner, cardC.id)
  const planned = credit.planned_payments.find((p) => p.date === plannedDay)
  const covered = credit.checks.find((c) => c.kind === 'subscription')
  console.log(`    API: available_now ${credit.available_now}; with planned ${credit.available_with_planned} by ${credit.planned_by}; subscription ${covered?.status}`)
  check('(c) the API counts the planned payment', [planned?.counted, credit.planned_by], [true, plannedDay])
  check('(c) the API says the subscription relies on it', [covered?.status, covered?.relies_on_planned], ['ok_with_planned', plannedDay])
  const { ctx, page } = await newPage(browser)
  await uiLogin(page, owner)
  await settle(page)
  const section = cardSection(page, 'Card C')
  check('(c) the card line carries the planned figure',
    (await section.locator('[data-testid="credit-with-planned"]').textContent())?.trim(),
    `${peso(credit.available_with_planned)} with planned payment by ${fmt(plannedDay)}`)
  const badge = chargeRows(section, 'Medium Sub').locator('[data-testid="credit-check-badge"]')
  check('(c) the covered subscription reads OK with planned payment by the date',
    [(await badge.textContent())?.trim(), await badge.getAttribute('data-status')],
    [`OK with planned payment by ${fmt(plannedDay)}`, 'ok_with_planned'])
  await ctx.close()
}

// (d) The Accounts card rows show "Available ...".
async function accountsRows(browser) {
  console.log('\n=== (d) the Accounts card rows show "Available ..."')
  const { ctx, page } = await newPage(browser)
  await uiLogin(page, owner)
  await page.goto(`${stack.webUrl}/accounts`)
  await page.locator('[data-testid^="account-credit-"]').first().waitFor()
  await settle(page)
  for (const c of [cardA, cardB, cardC]) {
    const credit = await cardCredit(owner, c.id)
    const row = accountRow(page, c.name)
    const text = (await row.locator(`[data-testid="account-credit-${c.id}"] [data-testid="credit-available"]`).textContent())?.trim()
    check(`(d) ${c.name} reads the API's available_now`, text, `Available ${credit.complete ? '' : 'at most '}${peso(credit.available_now)}`)
  }
  const plannedLine = accountRow(page, cardC.name).locator('[data-testid="credit-with-planned"]')
  const creditC = await cardCredit(owner, cardC.id)
  check('(d) the planned-payment flag is on the card that has one',
    (await plannedLine.textContent())?.trim(), `${peso(creditC.available_with_planned)} with planned payment by ${fmt(plannedDay)}`)
  check('(d) the checking account has no credit line', await accountRow(page, bank.name).locator('[data-testid="credit-summary"]').count(), 0)
  await ctx.close()
}

// (e) The edit form stores a preset, its floor, and clears it.
async function ruleForm(browser) {
  console.log('\n=== (e) the edit form stores a bank preset and its floor, and None clears it')
  const presets = await get(owner.token, '/accounts/minimum-due-presets')
  const bdo = presets.find((p) => p.key === 'bdo')
  const security = presets.find((p) => p.key === 'security_bank')
  check('(e) the API lists five presets', presets.map((p) => p.key).sort(), ['bdo', 'bdo_installment', 'hsbc', 'metrobank', 'security_bank'])
  check('(e) Security Bank has no effective date', security.effective_from, '')
  check('(e) the card has no rule yet', (await get(owner.token, `/accounts/${cardB.id}`)).minimum_due_rule ?? null, null)

  const { ctx, page } = await newPage(browser)
  await uiLogin(page, owner)
  await page.goto(`${stack.webUrl}/accounts`)
  await page.locator('[data-testid^="account-credit-"]').first().waitFor()
  const openForm = async () => {
    await accountRow(page, cardB.name).locator('[role="button"]').first().click()
    await page.getByRole('button', { name: 'Edit account' }).click()
    await page.getByRole('button', { name: 'Show details' }).click()
    await page.locator('[data-testid="minimum-due-preset"]').waitFor()
    await page.locator('[data-testid="minimum-due-preset"] option[value="bdo"]').waitFor({ state: 'attached' })
  }
  const save = async () => {
    const saved = page.waitForResponse((r) => r.request().method() === 'PUT' && new URL(r.url()).pathname.endsWith(`/accounts/${cardB.id}`))
    await page.getByRole('button', { name: 'Update Account', exact: true }).click()
    const res = await saved
    await page.locator('[data-testid="minimum-due-preset"]').waitFor({ state: 'detached' })
    return res
  }

  await openForm()
  const select = page.locator('[data-testid="minimum-due-preset"]')
  check('(e) the form starts on None', await select.inputValue(), '')
  await select.selectOption('security_bank')
  check('(e) a preset with no effective date says so, without a blank date',
    (await page.locator('[data-testid="minimum-due-rule"]').textContent())?.includes("gives no effective date"), true)
  await select.selectOption('bdo')
  check('(e) the floor starts at the preset\'s', Number(await page.locator('[data-testid="minimum-due-floor"]').inputValue()), Number(bdo.rule.floor.PHP))
  check('(e) the BDO switch is offered', await page.locator('[data-testid="minimum-due-new-purchases"]').count(), 1)
  await page.locator('[data-testid="minimum-due-floor"]').fill('900')
  const res = await save()
  const stored = (await get(owner.token, `/accounts/${cardB.id}`)).minimum_due_rule
  check('(e) the save is 200', res.status(), 200)
  check('(e) the API stores the BDO preset', [stored?.preset, stored?.version, Number(stored?.base_percent)], ['bdo', 1, Number(bdo.rule.base_percent)])
  check('(e) with the edited floor', Number(stored?.floor?.PHP), 900)
  check('(e) and the preset\'s other terms', [stored?.rounding, stored?.added_terms], [bdo.rule.rounding, bdo.rule.added_terms])

  await openForm()
  check('(e) reopening shows the stored preset', await select.inputValue(), 'bdo')
  check('(e) and the stored floor', Number(await page.locator('[data-testid="minimum-due-floor"]').inputValue()), 900)
  await select.selectOption('')
  const cleared = await save()
  check('(e) None saves 200 and clears the rule', [cleared.status(), (await get(owner.token, `/accounts/${cardB.id}`)).minimum_due_rule ?? null], [200, null])
  await ctx.close()
}

// (f) An editor and a viewer see no credit text.
async function othersSeeNoCredit(browser) {
  console.log('\n=== (f) an editor and a viewer see no credit text, and /cards/{id}/credit is 404')
  const editor = await makeUser('editor')
  const viewer = await makeUser('viewer')
  await post(owner.token, `/accounts/${cardC.id}/shares`, { email: editor.email, role: 'editor' })
  await post(owner.token, `/accounts/${cardC.id}/shares`, { email: viewer.email, role: 'viewer' })
  for (const [who, u] of [['editor', editor], ['viewer', viewer]]) {
    const detail = await api(u.token, 'GET', `/cards/${cardC.id}/credit`)
    check(`(f) ${who}: GET /cards/{id}/credit is 404`, detail.status, 404)
    check(`(f) ${who}: GET /cards/credit lists nothing`, (await get(u.token, '/cards/credit')).items, [])
    const snapshotCard = (await get(u.token, '/dashboard/snapshot')).card_charges.find((c) => c.account_id === cardC.id)
    check(`(f) ${who}: the snapshot lists the card without a credit key`, [snapshotCard !== undefined, snapshotCard !== undefined && 'credit' in snapshotCard], [true, false])

    const { ctx, page } = await newPage(browser)
    await uiLogin(page, u)
    await settle(page)
    check(`(f) ${who}: the card section is there`, await cardSection(page, 'Card C').count(), 1)
    check(`(f) ${who}: no credit line or badge on the dashboard`,
      await page.locator('[data-testid="credit-summary"], [data-testid="credit-check-badge"]').count(), 0)
    await page.goto(`${stack.webUrl}/accounts`)
    await page.locator('article').first().waitFor()
    await settle(page)
    check(`(f) ${who}: no credit line on the Accounts page`, await page.locator('[data-testid="credit-summary"]').count(), 0)
    await ctx.close()
  }
}

// (g) Planned card charges come off on their date and show apart from the installment hold.
async function plannedCharges(browser) {
  console.log('\n=== (g) planned charges come off on their date and show apart from the installment hold')
  const today = manilaToday()
  const cardD = await card(owner, bank, 'Card D', 50000)
  await expense(owner, {
    name: 'Phone installment D', amount: 1000, next_occurrence: wire(addDays(today, 10)), account_id: cardD.id,
    end_mode: 'after_occurrences', max_occurrences: 3,
  })
  const pending = (description, amount, day) => post(owner.token, '/transactions/', {
    account_id: cardD.id, transaction_type: 'debit', amount, description,
    transaction_date: wire(day), is_posted: false,
  })
  await pending('Today charge', 2000, today)
  const planned = await pending('Planned charge', 4000, addDays(today, 7))
  const far = await pending('Far charge', 8000, addDays(today, 40))
  const subDay = addDays(today, 12)
  const sub = await expense(owner, { name: 'Sub D', amount: 500, next_occurrence: wire(subDay), account_id: cardD.id })

  const credit = await cardCredit(owner, cardD.id)
  console.log(`    API: available_now ${credit.available_now}; pending ${credit.opening.pending_total}; planned ${credit.planned_charges_total}`)
  check('(g) the API counts only the charge dated today',
    [credit.opening.pending_total, credit.opening.installment_hold, credit.planned_charges_total, credit.available_now],
    [2000, 3000, 4000, 45000])
  const txnCheck = (id) => credit.checks.find((c) => c.source === 'transaction' && c.source_id === id)
  check('(g) the planned charge comes off on its own date',
    [txnCheck(planned.id)?.date, txnCheck(planned.id)?.available_after], [addDays(today, 7), 41000])
  check('(g) the subscription after it sees the charge taken off',
    credit.checks.find((c) => c.source === 'budget_entry' && c.source_id === sub.id)?.available_after, 40500)
  check('(g) the charge beyond the window has no check', txnCheck(far.id), undefined)
  const snapshot = (await get(owner.token, '/dashboard/snapshot')).card_charges.find((c) => c.account_id === cardD.id)
  check('(g) the snapshot carries the same credit', snapshot?.credit, credit)

  const plannedLine = `${peso(4000)} in charges dated later in the next 30 days, taken off on their dates`
  const { ctx, page } = await newPage(browser)
  await uiLogin(page, owner)
  await settle(page)
  const section = cardSection(page, 'Card D')
  check('(g) the dashboard headline is the available figure',
    (await section.locator('[data-testid="credit-available"]').textContent())?.trim(), `Available ${peso(45000)}`)
  const held = (await section.locator('[data-testid="credit-held"]').textContent()) ?? ''
  check('(g) the hold line names the installments and not the planned charge',
    [held.includes(`Includes ${peso(3000)} held for installments`), held.includes('4,000')], [true, false])
  check('(g) the dashboard shows the planned charges on their own line',
    (await section.locator('[data-testid="credit-planned"]').textContent({ timeout: 3000 }).catch(() => null))?.trim(), plannedLine)
  await page.goto(`${stack.webUrl}/accounts/${cardD.id}`)
  await page.locator('[data-testid="card-credit-panel"]').waitFor()
  await settle(page)
  const panel = page.locator('[data-testid="card-credit-panel"]')
  check('(g) the account page shows the same line',
    (await panel.locator('[data-testid="credit-planned"]').textContent({ timeout: 3000 }).catch(() => null))?.trim(), plannedLine)
  check('(g) the opening line says what is counted now',
    (await panel.locator('[data-testid="card-credit-opening"]').textContent())?.includes(`pending counted now ${peso(2000)}`), true)
  await ctx.close()
}

;(async () => {
  stack = await startLocalStack()
  API = `${stack.apiUrl}/api/v1`
  const browser = await chromium.launch()
  const run = (k) => !only || only === k
  await setup()
  if (run('a')) await panelShowsAvailable(browser)
  if (run('b')) await exceedBadge(browser)
  if (run('c')) await plannedPayment(browser)
  if (run('d')) await accountsRows(browser)
  if (run('e')) await ruleForm(browser)
  if (run('f')) await othersSeeNoCredit(browser)
  if (run('g')) await plannedCharges(browser)
  await browser.close()
  stack.stop()
  console.log(`\nRESULT: ${pass}/${total} assertions passed`)
  process.exit(pass === total ? 0 : 1)
})().catch((e) => { console.error(e); stack?.stop(); console.log(`\nRESULT (aborted): ${pass}/${total} assertions passed`); process.exit(1) })
