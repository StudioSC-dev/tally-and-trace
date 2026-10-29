// Browser check for STU-343 (ported by STU-384): upcoming charges by card on
// the dashboard, which is read-only; recording (Posted, Charged, Post all due)
// happens in the Transactions page's "Due and overdue" section. Starts its own API and web app against a
// throwaway database (./_local_stack.cjs). Not wired into CI and not part of
// `pnpm build`. Run steps: see ./README.md.
//
// Scenarios:
//   (a) a card subscription is listed in the card section, not in the payables
//       or "Also coming up" (nor is a foreign one, converted or not)
//   (b) "N missed" is plain text on the dashboard and counts only the months with no
//       pending row (unlinked_count since oldest_unlinked); after Charged on the oldest
//       missed month (b2) it counts one fewer; the section's Posted opens Mark paid and
//       "Post all N due" clears the missed row (N read from the API)
//   (c) an installment's Posted defaults to its occurrence date, with Charged
//       beside it; another statement cycle's day shows the cycle warning
//   (d) a viewer sees Limited rows and an overdue Limited row on the dashboard,
//       no buttons, and no buttons in the section either
//   (e) a pending card transaction has no Mark paid, and a future one is not in
//       the section
//   (f) a pending foreign debit on a PHP card is listed by its face in its own
//       currency (USD) in the Transactions list, its Details, and the section, as
//       account detail already does (STU-462)
//
// The section shows 3 rows a page: every count and absence check reads all pages and
// every click first goes to the row's page (./_due_pages.cjs).
//
// Usage: node frontend/e2e/card-charges.cjs [a|b|c|d|e|f]
const { startLocalStack } = require('./_local_stack.cjs')
const { allDueRows, rowsOf, showRow } = require('./_due_pages.cjs')
const { waitQuiet } = require('./_smooth.cjs')

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
/** The section's recurring or missed rows for an entry, by name, on the page on screen; `kind` narrows to one. Reach one with showRow, count with rowsOf. */
const dueRows = (page, name, kind) =>
  page.locator(`[data-testid="due-row"]${kind ? `[data-kind="${kind}"]` : ':not([data-kind="pending"]):not([data-kind="statement"])'}`)
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

  let missed = (await snapshotCard(u, visa.id))?.missed.find((m) => m.entry_id === spotify.id)
  console.log(`    snapshot missed: count ${missed?.count}; unlinked ${missed?.unlinked_count}; due_count ${missed?.due_count}; oldest ${missed?.oldest}; oldest_unlinked ${missed?.oldest_unlinked}`)
  check('(b) the API reports missed months', (missed?.count ?? 0) >= 2, true)

  const { ctx, page } = await newPage(browser)
  await uiLogin(page, u)
  await settle(page)
  const section = cardSection(page, 'Visa B')
  const missedRow = section.locator('[data-testid="card-missed-row"]').filter({ hasText: 'Spotify' })
  check('(b) the missed row is listed', await missedRow.count(), 1)
  check('(b) it has no button', await missedRow.locator('button, [data-testid="card-missed-button"]').count(), 0)
  const missedText = missedRow.locator('[data-testid="card-missed-text"]')
  check('(b) the plain text reads the API\'s unlinked count and oldest unlinked month', (await missedText.textContent())?.replace(/\s+/g, ' ').trim(), `${missed.unlinked_count} missed since ${fmt(missed.oldest_unlinked)}`)

  // (b2) Charged on the oldest missed month leaves a pending row, which is no longer missed.
  const charged = await api(u.token, 'POST', `/budget-entries/${spotify.id}/materialize`, {
    occurrence_date: wire(missed.oldest), transaction_date: wire(missed.oldest), is_posted: false, advance: false,
  })
  check('(b2) Charged on the oldest missed month is 201', charged.status, 201)
  const unchargedCount = missed.unlinked_count
  missed = (await snapshotCard(u, visa.id))?.missed.find((m) => m.entry_id === spotify.id)
  console.log(`    after Charged: count ${missed?.count}; unlinked ${missed?.unlinked_count}; oldest ${missed?.oldest}; oldest_unlinked ${missed?.oldest_unlinked}`)
  check('(b2) the API still counts the Charged month in count, but not in unlinked_count', [missed.count > missed.unlinked_count, missed.unlinked_count], [true, unchargedCount - 1])
  await page.reload()
  await page.locator('[data-testid="card-charges"]').waitFor()
  await settle(page)
  check('(b2) the panel counts only the unrecorded months', (await missedText.textContent())?.replace(/\s+/g, ' ').trim(), `${missed.unlinked_count} missed since ${fmt(missed.oldest_unlinked)}`)

  await openTransactions(page)
  const dueMissed = dueRows(page, 'Spotify', 'missed')
  check('(b) the section lists the missed row', (await rowsOf(page, 'Spotify', 'missed')).length, 1)
  await showRow(page, dueMissed)
  const asked = page.waitForRequest((r) => new URL(r.url()).pathname.endsWith(`/budget-entries/${spotify.id}/occurrences`))
  await dueMissed.locator('[data-testid="due-posted"]').click()
  const include = new URL((await asked).url()).searchParams.get('include')
  await dialog(page).locator('[data-testid="mark-paid-occurrence"]').waitFor()
  check('(b) the dialog asked for the oldest unrecorded missed month', include, missed.oldest_unlinked)
  const listing = await get(u.token, `/budget-entries/${spotify.id}/occurrences?include=${include}`)
  const due = listing.occurrences.filter((o) => o.due && o.linked !== 'posted').map((o) => o.occurrence_date)
  console.log(`    /occurrences: due_unposted ${listing.due_unposted}; due ${due.join(', ')}`)
  check('(b) the API\'s due count matches the snapshot\'s', listing.due_unposted, missed.due_count)
  check('(b) the dialog opens on the oldest unrecorded month', await dialog(page).locator('[data-testid="mark-paid-occurrence"]').inputValue(), missed.oldest_unlinked)
  const postAll = dialog(page).locator('[data-testid="mark-paid-post-all"]')
  check('(b) the button shows the API\'s count and dates', (await postAll.textContent())?.trim(),
    `Post all ${listing.due_unposted} due (${fmt(due[0])} – ${fmt(due[due.length - 1])})`)

  const posted = page.waitForResponse((r) => r.url().endsWith(`/budget-entries/${spotify.id}/materialize-due`))
  await postAll.click()
  const res = await posted
  const result = await res.json()
  // The Charged month keeps its pending row, which Post all posts (posted_pending); the rest are created.
  const expectedOutcomes = listing.occurrences.filter((o) => o.due && o.linked !== 'posted').map((o) => (o.linked === 'pending' ? 'posted_pending' : 'created'))
  check('(b) Post all due is 200 with N results, the Charged month posted_pending', [res.status(), result.results.map((r) => r.outcome)], [200, expectedOutcomes])
  check('(b) exactly one is posted_pending, and N is the API\'s due count', [expectedOutcomes.filter((o) => o === 'posted_pending').length, expectedOutcomes.length], [1, listing.due_unposted])
  await dialog(page).waitFor({ state: 'detached' })
  // The snapshot refetch can start after the network first goes idle, so wait on the row itself.
  await gone(dueMissed)
  await settle(page)
  check('(b) the missed row is gone from every page of the section', (await rowsOf(page, 'Spotify', 'missed')).length, 0)
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
  const listedPhone = await rowsOf(page, 'Phone')
  check('(c) the section lists the installment with Charged and Posted', [listedPhone.length, listedPhone[0]?.buttons.filter((b) => b === 'due-charged').length, listedPhone[0]?.buttons.filter((b) => b === 'due-posted').length], [1, 1, 1])
  const dueRow = await showRow(page, dueRows(page, 'Phone'))
  await waitQuiet(page)
  await dueRow.locator('[data-testid="due-charged"]').click()
  await dialog(page).locator('[data-testid="mark-paid-occurrence"]').waitFor()
  check('(c) opened on Charged, the date is labelled "Charged on"', (await dialog(page).locator('label[for$="-day"]').textContent())?.trim(), 'Charged on')
  await dialog(page).getByRole('button', { name: 'Cancel', exact: true }).click()
  await dialog(page).waitFor({ state: 'detached' })
  await waitQuiet(page)
  await dueRow.locator('[data-testid="due-posted"]').click()
  await dialog(page).locator('[data-testid="mark-paid-occurrence"]').waitFor()
  await settle(page) // the occurrence list refetches once more after opening; a date typed before it lands is reset
  const date = dialog(page).locator('[data-testid="mark-paid-date"]')
  check('(c) the occurrence is the installment\'s month', await dialog(page).locator('[data-testid="mark-paid-occurrence"]').inputValue(), occurrence)
  check('(c) the date defaults to the occurrence date', await date.inputValue(), occurrence)
  check('(c) no cycle warning on the occurrence date', await dialog(page).locator('[data-testid="mark-paid-cycle-warning"]').count(), 0)
  check('(c) opened on Posted, the date is labelled "Posted on"', (await dialog(page).locator('label[for$="-day"]').textContent())?.trim(), 'Posted on')
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
  const shown = await allDueRows(page)
  const limitedDue = shown.filter((r) => r.view === 'limited')
  check('(d) no row on any page shows a button', shown.flatMap((r) => r.buttons), [])
  if (mode === 'drop') {
    check('(d) drop: the section has no Netflix or Pharmacy row on any page', shown.filter((r) => /Netflix|Pharmacy/.test(r.text)).length, 0)
  } else {
    check('(d) text: Netflix and Pharmacy appear as Limited rows without buttons',
      [limitedDue.filter((r) => r.text.includes('Netflix')).length, limitedDue.filter((r) => r.text.includes('Pharmacy')).length, limitedDue.flatMap((r) => r.buttons).length], [1, 1, 0])
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
  check('(e) a future pending card row is not in the section, on any page', (await allDueRows(page)).filter((r) => r.text.includes('Lazada')).length, 0)
  await ctx.close()
}

async function closeDetails(page) {
  const close = page.getByRole('button', { name: 'Close actions modal' })
  await close.click()
  await close.waitFor({ state: 'detached' })
  await waitQuiet(page)
}

// (f) A pending foreign debit: its face figure with its own currency, not the account's symbol.
async function pendingForeignFace(browser) {
  console.log('\n=== (f) a pending foreign debit is listed in the currency of its face')
  const u = await makeUser('f')
  const bank = await checking(u)
  const today = manilaToday()
  const visa = await card(u, bank, 'Visa F', 24)
  // Dated before today so it is also an overdue row in the "Due and overdue" section.
  const day = addDays(today, -2)
  const foreign = await post(u.token, '/transactions/', {
    account_id: visa.id, transaction_type: 'debit', currency: 'PHP', amount: 131, projected_amount: 131, projected_currency: 'USD',
    description: 'Foreign F', transaction_date: wire(day), is_posted: false,
  })
  check('(f) the API keeps the stored figures (PHP 131, face USD 131)', [foreign.currency, foreign.amount, foreign.projected_currency, foreign.projected_amount], ['PHP', 131, 'USD', 131])
  // A retained actual: the row's own currency is the foreign face, so only the account's currency gives the right figure ($80, not $4,700).
  const retained = await post(u.token, '/transactions/', {
    account_id: visa.id, transaction_type: 'debit', currency: 'USD', amount: 4700, projected_amount: 80, projected_currency: 'USD',
    description: 'Retained F', transaction_date: wire(day), is_posted: false,
  })
  // A row whose account is not in the page's (active) accounts list keeps its stored figure: an inactive account.
  const lost = await post(u.token, '/accounts/', {
    name: 'Gone F', account_type: 'checking', balance: 1000, currency: 'PHP',
  })
  await post(u.token, '/transactions/', {
    account_id: lost.id, transaction_type: 'debit', currency: 'PHP', amount: 77, projected_amount: 77, projected_currency: 'USD',
    description: 'Orphan F', transaction_date: wire(day), is_posted: false,
  })
  const closed = await api(u.token, 'PUT', `/accounts/${lost.id}`, { is_active: false })
  check('(f) the second account is deactivated', [closed.status, closed.json?.is_active], [200, false])
  check('(f) the API keeps the retained actual (USD 4700, face USD 80)', [retained.currency, retained.amount, retained.projected_currency, retained.projected_amount], ['USD', 4700, 'USD', 80])

  const { ctx, page } = await newPage(browser)
  await uiLogin(page, u)
  await openTransactions(page)
  await waitQuiet(page)
  // Explicit range that holds the seeded rows even on the 1st or 2nd of a month, when they fall in the previous one.
  await page.getByRole('button', { name: 'Show filters' }).click()
  await page.locator('xpath=//label[normalize-space()="Custom start date"]/following-sibling::input').fill(addDays(today, -3))
  await waitQuiet(page)
  const item = page.locator('article').filter({ has: page.getByText('Foreign F', { exact: true }) })
  check('(f) the Transactions list has the row once', await item.count(), 1)
  check('(f) its amount is $131.00, not ₱131.00', await item.locator('p.text-lg.font-bold').textContent(), '$131.00')
  check('(f) the Projected line is unchanged', (await item.textContent()).includes('Projected $131.00'), true)
  await item.click()
  const detailAmount = page.locator('dt', { hasText: /^Amount$/ }).locator('xpath=following-sibling::dd')
  await detailAmount.first().waitFor()
  check('(f) the Details amount is $131.00', await detailAmount.first().textContent(), '$131.00')
  await closeDetails(page)
  const orphan = page.locator('article').filter({ has: page.getByText('Orphan F', { exact: true }) })
  check('(f) a row whose account is not listed keeps its stored figure, ₱77.00', [await orphan.count(), await orphan.locator('p.text-lg.font-bold').textContent()], [1, '₱77.00'])
  const retainedItem = page.locator('article').filter({ has: page.getByText('Retained F', { exact: true }) })
  check('(f) the retained-actual row is listed once', await retainedItem.count(), 1)
  check('(f) its list amount is the face, $80.00', await retainedItem.locator('p.text-lg.font-bold').textContent(), '$80.00')
  await retainedItem.click()
  await detailAmount.first().waitFor()
  check('(f) its Details amount is the face, $80.00', await detailAmount.first().textContent(), '$80.00')
  await closeDetails(page)

  await openTransactions(page)
  const due = await rowsOf(page, 'Foreign F', 'pending')
  check('(f) the section lists it once, overdue', [due.length, due[0]?.overdue], [1, true])
  check('(f) the section row amount is $131.00', [due[0]?.text.includes('$131.00'), due[0]?.text.includes('₱131.00')], [true, false])

  const dueRetained = await rowsOf(page, 'Retained F', 'pending')
  check('(f) the section lists the retained-actual row once', dueRetained.length, 1)
  check('(f) its section amount is the face, $80.00', [dueRetained[0]?.text.includes('$80.00'), dueRetained[0]?.text.includes('4,700')], [true, false])

  await page.goto(`${stack.webUrl}/accounts/${visa.id}`)
  await waitQuiet(page)
  const amounts = page.locator('[data-testid="account-transaction-amount"]')
  await amounts.first().waitFor()
  const texts = (await amounts.allTextContents()).map((t) => t.trim())
  const face131 = texts.find((t) => t.includes('131.00')) ?? ''
  check('(f) account detail still shows the USD face (regression guard)', [face131.includes('$'), face131.includes('₱'), texts.some((t) => t.includes('80.00') && t.includes('$'))], [true, false, true])
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
  if (run('f')) await pendingForeignFace(browser)
  await browser.close()
  stack.stop()
  console.log(`\nRESULT: ${pass}/${total} assertions passed`)
  process.exit(pass === total ? 0 : 1)
})().catch((e) => { console.error(e); stack?.stop(); console.log(`\nRESULT (aborted): ${pass}/${total} assertions passed`); process.exit(1) })
