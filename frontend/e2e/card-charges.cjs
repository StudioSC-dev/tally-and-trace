// Browser check for STU-343 (ported by STU-384): upcoming charges by card on
// the dashboard, which is read-only; recording (Posted, Charged, Post all due)
// happens in the Transactions page's "Due and overdue" section. Starts its own API and web app against a
// throwaway database (./_local_stack.cjs). Not wired into CI and not part of
// `pnpm build`. Run steps: see ./README.md.
//
// Scenarios:
//   (a) a card subscription is listed in the card section, not in the payables
//       or "Also coming up" (nor is a foreign one, converted or not)
//   (b) "N missed" is plain text on the dashboard; the section's Posted opens
//       Mark paid and "Post all N due" clears the missed row (N read from the API)
//   (c) an installment's Posted defaults to its occurrence date, with Charged
//       beside it; another statement cycle's day shows the cycle warning
//   (d) a viewer sees Limited rows and an overdue Limited row on the dashboard,
//       no buttons, and no buttons in the section either
//   (e) a pending card transaction has no Mark paid, and a future one is not in
//       the section
//
// Usage: node frontend/e2e/card-charges.cjs [a|b|c|d|e]
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
  const email = `e2e-cc-${tag}-${Math.random().toString(16).slice(2, 8)}@example.com`
  const password = 'E2eTest!2345'
  const reg = await api('', 'POST', '/auth/register', { email, password, first_name: `User${tag}`, last_name: 'Test', default_currency: 'PHP' })
  if (reg.status !== 200 && reg.status !== 201) throw new Error(`register ${reg.status} ${JSON.stringify(reg.json)}`)
  stack.verifyUser(email) // aborts the run unless psql reports UPDATE 1
  const login = await api('', 'POST', '/auth/login', { email, password })
  if (login.status !== 200) throw new Error(`login ${login.status}`)
  return { email, password, tag, token: login.json.access_token }
}
const checking = (u, balance = 100000) => post(u.token, '/accounts/', { name: `${u.tag} Checking`, account_type: 'checking', balance, currency: 'PHP' })
/** A card closing on day `close` of each month, due 21 days later, paid from `bank`. */
const card = (u, bank, name, close) => post(u.token, '/accounts/', {
  name, account_type: 'credit', balance: 0, currency: 'PHP',
  billing_cycle_start: close, days_until_due_date: 21, payment_account_id: bank.id,
})
const expense = (u, fields) => post(u.token, '/budget-entries/', { entry_type: 'expense', currency: 'PHP', cadence: 'monthly', ...fields })
const unposted = (u, account, day, amount, description) => post(u.token, '/transactions/', {
  account_id: account.id, transaction_type: 'debit', amount, description, transaction_date: wire(day), is_posted: false,
})
const snapshotCard = async (u, cardId) => (await get(u.token, '/dashboard/snapshot')).card_charges.find((c) => c.account_id === cardId)

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
/** Opens Transactions with the "Due and overdue" section loaded. */
async function openTransactions(page) {
  await page.goto(`${stack.webUrl}/transactions`)
  await page.locator('[data-testid="due-section"]').waitFor()
  await page.locator('[data-testid="due-count"]').filter({ hasNotText: '…' }).waitFor()
  await settle(page)
}
/** The section's recurring or missed rows for an entry, by name; `kind` narrows to one. */
const dueRows = (page, name, kind) =>
  page.locator(`[data-testid="due-row"]${kind ? `[data-kind="${kind}"]` : ':not([data-kind="pending"])'}`)
    .filter({ has: page.locator('p', { hasText: new RegExp(`^${name}$`) }) })
const gone = (locator) => locator.first().waitFor({ state: 'detached', timeout: 15000 }).catch(() => {})
const dialog = (page) => page.locator('[data-testid="mark-paid-dialog"]')
const cardSection = (page, name) =>
  page.locator('[data-testid="card-charges-card"]').filter({ has: page.locator('[data-testid="card-charges-name"]', { hasText: name }) })
const chargeRows = (section, name) =>
  section.locator('[data-testid="card-charge-row"]').filter({ has: section.page().getByText(name, { exact: true }) })
const payableRows = (page, name) =>
  page.locator('[data-testid="payable-row"]').filter({ has: page.getByText(name, { exact: true }) })
const otherRows = (page, name) =>
  page.locator('[data-testid="other-upcoming-row"]').filter({ has: page.getByText(name, { exact: true }) })
async function expandPayables(page) {
  const more = page.locator('[data-testid="payables-more"]')
  if (await more.count() && (await more.getAttribute('aria-expanded')) === 'false') await more.click()
}

// (a) A card subscription: in the card section, not in payables or "Also coming up".
async function subscriptionListedByCard(browser) {
  console.log('\n=== (a) a card subscription is listed by card, not as a payable or under "Also coming up"')
  const u = await makeUser('a')
  const bank = await checking(u)
  const today = manilaToday()
  const visa = await card(u, bank, 'Visa A', 24)
  const netflixDay = addDays(today, 5)
  const netflix = await expense(u, { name: 'Netflix', amount: 549, next_occurrence: wire(netflixDay), account_id: visa.id })
  // A foreign subscription: with no stored rate it is an unconverted row, which
  // "Also coming up" would otherwise list.
  const yen = await expense(u, { name: 'Yen app', amount: 1000, currency: 'JPY', next_occurrence: wire(addDays(today, 8)), account_id: visa.id })

  const { ctx, page } = await newPage(browser)
  const snapshotSeen = page.waitForResponse((r) => new URL(r.url()).pathname.endsWith('/dashboard/snapshot'))
  await uiLogin(page, u)
  const snapshot = await (await snapshotSeen).json()
  await settle(page)
  await expandPayables(page)

  const section = cardSection(page, 'Visa A')
  check('(a) the card has a section', await section.count(), 1)
  const netflixRow = chargeRows(section, 'Netflix')
  check('(a) Netflix is listed in the card section', await netflixRow.count(), 1)
  check('(a) as a subscription on its occurrence', [
    await netflixRow.locator('[data-testid="card-charge-kind"]').textContent(),
    (await netflixRow.textContent()).includes(fmt(netflixDay)),
  ], ['Subscription', true])
  check('(a) with its amount', (await netflixRow.locator('[data-testid="card-charge-amount"]').textContent())?.includes('549'), true)
  check('(a) and no Mark paid on the dashboard', await page.locator('[data-testid="card-charge-mark-paid"]').count(), 0)
  check('(a) Netflix is not a payable', await payableRows(page, 'Netflix').count(), 0)
  check('(a) Netflix is not under "Also coming up"', await otherRows(page, 'Netflix').count(), 0)

  check('(a) the foreign subscription is listed in the card section', await chargeRows(section, 'Yen app').count(), 1)
  check('(a) the foreign subscription is not a payable', await payableRows(page, 'Yen app').count(), 0)
  check('(a) the foreign subscription is not under "Also coming up"', await otherRows(page, 'Yen app').count(), 0)
  const yenUpcoming = snapshot.upcoming_this_month.find((i) => i.source === 'budget_entry' && i.source_id === yen.id)
  console.log(`    the snapshot's upcoming row for "Yen app" is ${yenUpcoming?.unconverted ? 'unconverted (the exclusion is what keeps it out)' : 'converted'}`)
  const netflixCharge = snapshot.card_charges.find((c) => c.account_id === visa.id)?.charges.find((c) => c.source_id === netflix.id)
  check('(a) the API lists Netflix by card with Mark paid', [netflixCharge?.source, netflixCharge?.occurrence_date, netflixCharge?.can_mark_paid], ['budget_entry', netflixDay, true])
  await ctx.close()
}

// (b) "N missed" → "Post all N due" clears the missed row.
async function missedPostAll(browser) {
  console.log('\n=== (b) "N missed" opens Mark paid; "Post all N due" clears the missed row')
  const u = await makeUser('b')
  const bank = await checking(u)
  const visa = await card(u, bank, 'Visa B', 24)
  const today = manilaToday()
  const ahead = addDays(today, 7)
  const anchor = Math.min(25, Math.max(5, Number(ahead.slice(8, 10))))
  const current = `${ahead.slice(0, 8)}${String(anchor).padStart(2, '0')}`
  const start = addMonths(current, -3, anchor)
  console.log(`    anchor day ${anchor}; next_occurrence ${start}; current occurrence ${current}`)
  const spotify = await expense(u, { name: 'Spotify', amount: 279, next_occurrence: wire(start), anchor_day: anchor, account_id: visa.id })

  const missed = (await snapshotCard(u, visa.id))?.missed.find((m) => m.entry_id === spotify.id)
  console.log(`    snapshot missed: count ${missed?.count}; due_count ${missed?.due_count}; oldest ${missed?.oldest}`)
  check('(b) the API reports missed months', (missed?.count ?? 0) >= 2, true)

  const { ctx, page } = await newPage(browser)
  await uiLogin(page, u)
  await settle(page)
  const section = cardSection(page, 'Visa B')
  const missedRow = section.locator('[data-testid="card-missed-row"]').filter({ hasText: 'Spotify' })
  check('(b) the missed row is listed', await missedRow.count(), 1)
  check('(b) it has no button', await missedRow.locator('button, [data-testid="card-missed-button"]').count(), 0)
  const missedText = missedRow.locator('[data-testid="card-missed-text"]')
  check('(b) the plain text reads the API\'s count and oldest month', (await missedText.textContent())?.replace(/\s+/g, ' ').trim(), `${missed.count} missed since ${fmt(missed.oldest)}`)

  await openTransactions(page)
  const dueMissed = dueRows(page, 'Spotify', 'missed')
  check('(b) the section lists the missed row', await dueMissed.count(), 1)
  const asked = page.waitForRequest((r) => new URL(r.url()).pathname.endsWith(`/budget-entries/${spotify.id}/occurrences`))
  await dueMissed.locator('[data-testid="due-posted"]').click()
  const include = new URL((await asked).url()).searchParams.get('include')
  await dialog(page).locator('[data-testid="mark-paid-occurrence"]').waitFor()
  check('(b) the dialog asked for the oldest missed month', include, missed.oldest)
  const listing = await get(u.token, `/budget-entries/${spotify.id}/occurrences?include=${include}`)
  const due = listing.occurrences.filter((o) => o.due && o.linked !== 'posted').map((o) => o.occurrence_date)
  console.log(`    /occurrences: due_unposted ${listing.due_unposted}; due ${due.join(', ')}`)
  check('(b) the API\'s due count matches the snapshot\'s', listing.due_unposted, missed.due_count)
  check('(b) the dialog opens on the oldest month', await dialog(page).locator('[data-testid="mark-paid-occurrence"]').inputValue(), missed.oldest)
  const postAll = dialog(page).locator('[data-testid="mark-paid-post-all"]')
  check('(b) the button shows the API\'s count and dates', (await postAll.textContent())?.trim(),
    `Post all ${listing.due_unposted} due (${fmt(due[0])} – ${fmt(due[due.length - 1])})`)

  const posted = page.waitForResponse((r) => r.url().endsWith(`/budget-entries/${spotify.id}/materialize-due`))
  await postAll.click()
  const res = await posted
  const result = await res.json()
  check('(b) Post all due is 200 with N created', [res.status(), result.results.map((r) => r.outcome)], [200, Array(listing.due_unposted).fill('created')])
  await dialog(page).waitFor({ state: 'detached' })
  // The snapshot refetch can start after the network first goes idle, so wait on the row itself.
  await gone(dueMissed)
  await settle(page)
  check('(b) the missed row is gone from the section', await dueRows(page, 'Spotify', 'missed').count(), 0)
  check('(b) the API reports nothing missed', ((await snapshotCard(u, visa.id))?.missed ?? []).length, 0)
  check('(b) the schedule is on the current occurrence', (await get(u.token, `/budget-entries/${spotify.id}`)).next_occurrence.slice(0, 10), current)
  await page.goto(`${stack.webUrl}/`)
  await page.locator('[data-testid="card-charges"]').waitFor()
  await settle(page)
  check('(b) the dashboard no longer lists the missed row', await cardSection(page, 'Visa B').locator('[data-testid="card-missed-row"]').count(), 0)
  check('(b) the current occurrence is listed as a charge', (await chargeRows(cardSection(page, 'Visa B'), 'Spotify').filter({ hasText: fmt(current) }).count()), 1)
  await ctx.close()
}

// (c) An installment defaults to its occurrence date; another cycle's day warns.
async function installmentDate(browser) {
  console.log('\n=== (c) an installment defaults to its occurrence date, with the cycle warning')
  const u = await makeUser('c')
  const bank = await checking(u)
  const today = manilaToday()
  // The card closes between today and the occurrence: today is on the statement
  // before the one the installment belongs to.
  const close = Math.min(28, Number(addDays(today, 10).slice(8, 10)))
  const occurrence = addDays(today, 20)
  console.log(`    card closes on day ${close}; installment occurrence ${occurrence}`)
  const visa = await card(u, bank, 'Visa C', close)
  const phone = await expense(u, {
    name: 'Phone', amount: 5000, next_occurrence: wire(occurrence), account_id: visa.id,
    end_mode: 'after_occurrences', max_occurrences: 12,
  })

  const { ctx, page } = await newPage(browser)
  await uiLogin(page, u)
  await settle(page)
  const row = chargeRows(cardSection(page, 'Visa C'), 'Phone')
  check('(c) the installment is listed on the card', [await row.count(), await row.locator('[data-testid="card-charge-kind"]').textContent()], [1, 'Installment'])
  check('(c) with no Mark paid on the dashboard', await row.locator('[data-testid="card-charge-mark-paid"], button').count(), 0)
  await openTransactions(page)
  const dueRow = dueRows(page, 'Phone')
  check('(c) the section lists the installment with Charged and Posted', [await dueRow.count(), await dueRow.locator('[data-testid="due-charged"]').count(), await dueRow.locator('[data-testid="due-posted"]').count()], [1, 1, 1])
  await dueRow.locator('[data-testid="due-posted"]').click()
  await dialog(page).locator('[data-testid="mark-paid-occurrence"]').waitFor()
  const date = dialog(page).locator('[data-testid="mark-paid-date"]')
  check('(c) the occurrence is the installment\'s month', await dialog(page).locator('[data-testid="mark-paid-occurrence"]').inputValue(), occurrence)
  check('(c) the date defaults to the occurrence date', await date.inputValue(), occurrence)
  check('(c) no cycle warning on the occurrence date', await dialog(page).locator('[data-testid="mark-paid-cycle-warning"]').count(), 0)
  await date.fill(today)
  check('(c) today, on the earlier statement, shows the cycle warning', await dialog(page).locator('[data-testid="mark-paid-cycle-warning"]').count(), 1)
  await date.fill(occurrence)
  check('(c) back on the occurrence date the warning goes', await dialog(page).locator('[data-testid="mark-paid-cycle-warning"]').count(), 0)
  const done = page.waitForResponse((r) => r.url().endsWith(`/budget-entries/${phone.id}/materialize`))
  await dialog(page).locator('[data-testid="mark-paid-submit"]').click()
  const res = await done
  const body = JSON.parse(res.request().postData() || '{}')
  check('(c) Mark paid records the occurrence on its own date', [res.status(), res.headers()['x-occurrence-recorded'], body.transaction_date], [201, occurrence, `${occurrence}T00:00:00Z`])
  await dialog(page).waitFor({ state: 'detached' })
  check('(c) the installment moved to the next month', (await get(u.token, `/budget-entries/${phone.id}`)).next_occurrence.slice(0, 10), addMonths(occurrence, 1))
  await ctx.close()
}

// (d) A viewer: Limited rows, one overdue, and no Mark paid.
async function viewerSeesLimited(browser) {
  console.log('\n=== (d) a viewer sees Limited rows, an overdue Limited row, and no Mark paid')
  const owner = await makeUser('d-owner')
  const viewer = await makeUser('d-viewer')
  const bank = await checking(owner)
  const today = manilaToday()
  const visa = await card(owner, bank, 'Joint Visa', 24)
  await expense(owner, { name: 'Netflix', amount: 549, next_occurrence: wire(addDays(today, 6)), account_id: visa.id })
  const pharmacyDay = addDays(today, -5)
  await unposted(owner, visa, pharmacyDay, 450, 'Pharmacy')
  await post(owner.token, `/accounts/${visa.id}/shares`, { email: viewer.email, role: 'viewer' })

  const api = await snapshotCard(viewer, visa.id)
  check('(d) the API lists the card for the viewer, every charge Limited', [api !== undefined, (api?.charges ?? []).every((c) => c.view === 'limited')], [true, true])
  check('(d) the API shows the viewer nothing missed', api?.missed, [])

  const { ctx, page } = await newPage(browser)
  await uiLogin(page, viewer)
  await settle(page)
  const section = cardSection(page, 'Joint Visa')
  check('(d) the card has a section', await section.count(), 1)
  const rowsShown = section.locator('[data-testid="card-charge-row"]')
  const views = await rowsShown.evaluateAll((els) => els.map((e) => e.getAttribute('data-view')))
  check('(d) every row is Limited', [views.length >= 2, views.every((v) => v === 'limited')], [true, true])
  const pharmacy = chargeRows(section, 'Pharmacy')
  check('(d) the overdue Limited row is Pharmacy, marked Overdue', [await pharmacy.count(), await pharmacy.locator('[data-testid="card-charge-overdue"]').count()], [1, 1])
  check('(d) it says when it was due', (await pharmacy.textContent()).includes(`was due ${fmt(pharmacyDay)}`), true)
  check('(d) no amount is shown on a Limited row', await section.locator('[data-testid="card-charge-amount"]').count(), 0)
  check('(d) no Mark paid in the card section', await page.locator('[data-testid="card-charges"] [data-testid="card-charge-mark-paid"], [data-testid="card-charges"] [data-testid="card-missed-button"]').count(), 0)

  // The section follows the same rule: no buttons for the owner's records; Limited rows per data-limited-rows.
  await openTransactions(page)
  const mode = await page.locator('[data-testid="due-section"]').getAttribute('data-limited-rows')
  console.log(`    data-limited-rows: ${mode}`)
  check('(d) the section setting is text or drop', ['text', 'drop'].includes(mode), true)
  check('(d) the section shows the viewer no action button', await page.locator('[data-testid="due-section"] button[data-testid^="due-"]:not([data-testid="due-section-toggle"]):not([data-testid="due-load-more"])').count(), 0)
  const limitedDue = page.locator('[data-testid="due-row"][data-view="limited"]')
  if (mode === 'drop') {
    check('(d) drop: the section has no Netflix or Pharmacy row', await page.locator('[data-testid="due-row"]').filter({ hasText: /Netflix|Pharmacy/ }).count(), 0)
  } else {
    check('(d) text: Netflix and Pharmacy appear as Limited rows without buttons',
      [await limitedDue.filter({ hasText: 'Netflix' }).count(), await limitedDue.filter({ hasText: 'Pharmacy' }).count(), await limitedDue.locator('button').count()], [1, 1, 0])
  }
  await ctx.close()
}

// (e) A pending card transaction is listed without Mark paid.
async function pendingHasNoMarkPaid(browser) {
  console.log('\n=== (e) a pending card transaction has no Mark paid')
  const u = await makeUser('e')
  const bank = await checking(u)
  const today = manilaToday()
  const visa = await card(u, bank, 'Visa E', 24)
  const lazada = await unposted(u, visa, addDays(today, 4), 1000, 'Lazada')
  const charge = (await snapshotCard(u, visa.id))?.charges.find((c) => c.source === 'transaction' && c.source_id === lazada.id)
  check('(e) the API lists it as pending with can_mark_paid false', [charge?.kind, charge?.can_mark_paid], ['pending', false])

  const { ctx, page } = await newPage(browser)
  await uiLogin(page, u)
  await settle(page)
  const row = chargeRows(cardSection(page, 'Visa E'), 'Lazada')
  check('(e) Lazada is listed on the card as Pending', [await row.count(), await row.locator('[data-testid="card-charge-kind"]').textContent()], [1, 'Pending'])
  check('(e) with no Mark paid', await row.locator('[data-testid="card-charge-mark-paid"], button').count(), 0)
  await openTransactions(page)
  check('(e) a future pending card row is not in the section', await page.locator('[data-testid="due-row"]').filter({ hasText: 'Lazada' }).count(), 0)
  await ctx.close()
}

;(async () => {
  stack = await startLocalStack()
  API = `${stack.apiUrl}/api/v1`
  const browser = await chromium.launch()
  const run = (k) => !only || only === k
  if (run('a')) await subscriptionListedByCard(browser)
  if (run('b')) await missedPostAll(browser)
  if (run('c')) await installmentDate(browser)
  if (run('d')) await viewerSeesLimited(browser)
  if (run('e')) await pendingHasNoMarkPaid(browser)
  await browser.close()
  stack.stop()
  console.log(`\nRESULT: ${pass}/${total} assertions passed`)
  process.exit(pass === total ? 0 : 1)
})().catch((e) => { console.error(e); stack?.stop(); console.log(`\nRESULT (aborted): ${pass}/${total} assertions passed`); process.exit(1) })
