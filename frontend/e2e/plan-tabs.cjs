// Browser check for STU-511 commits 7 and 7b: the Transactions page's "Due and overdue" card
// has Subscriptions and Installments tabs, and a bank-paid recurring expense can be marked a
// subscription in the recurring-entry form. Starts its own API and web app against a throwaway
// database (./_local_stack.cjs). Not wired into CI and not part of `pnpm build`. Run steps:
// see ./README.md.
//
// Scenarios (each seeds its own user, so each can run alone):
//   (a) the split: a card subscription due today and one in 5 days are on Subscriptions, a
//       card installment is one plan row on Installments, a card bill and a bank bill stay in
//       Due, a card subscription with an end date and an income stay in Upcoming; each entry
//       is on exactly one tab and each badge equals its rows
//   (b) a missed card subscription is a missed row on Subscriptions (not in Due), Charged on
//       it sends one materialise, the missed row leaves and the pending row is in Due
//   (c) installment plans: "10 of 12 left" with Charged and Posted; Charged keeps the row and
//       counts down (still 12 in all); an overdue plan is first with "2 missed" and Posted
//       opens on its oldest month; Review opens the review; auto-post on has no buttons; a
//       paused plan is absent
//   (d) the credit badge: the owner sees at_risk on a card subscription, an editor sees the
//       row without one, and no Installments row has one
//   (e) a past-due bank subscription is a missed row on Subscriptions, not an Overdue recurring row
//   (f) empty texts and badges 0; each tab pages on its own; 120 in-window subscription
//       occurrences; the 500-occurrence cap: with more than 520 installment occurrences
//       before T+20, a card subscription at T+20 is still on Subscriptions
//   (g) the Manila day in a Los Angeles browser: a card subscription due Manila today is a
//       Subscriptions row of today, one due Manila tomorrow a future row, neither in Due
//   (h) commit 7b: Spotify (bank, open-ended) marked Subscription in the recurring form moves
//       its months to Subscriptions and out of Due and Upcoming, Rent does not move; the
//       select is absent on a card, income and capped entry; set back to Other it returns. The
//       update bodies are read off the wire: billing_kind is sent only when the pick moved, never
//       for a card entry or a capped entry
//   (i) a held Manila day rollover, staged in the browser (the backend clock is real): the
//       Subscriptions and Installments badges read "..." while the day's requests are held,
//       never the old day's counts, show the new counts after release, and a later response
//       that still carries the old day keeps them at "..."; the snapshot is released before the
//       subscription occurrences, and Subscriptions stays at "..." until both are in
//   (j) one source of a tab fails and the other loads (Upcoming: the transactions or the
//       occurrences; Subscriptions: the snapshot or the subscription occurrences): the badge
//       reads 0, not the other source's part, the error shows, and Retry recovers
//   (k) a row moves between a tab's sources and the next refresh of one source fails: the
//       badge keeps the tab's last complete total, not the fresh source plus the failed one's
//       cache (Upcoming: a recorded occurrence; Subscriptions: an entry moved to today)
//
// Every scenario checks that no browser dialog fired. Check kinds: a failed setup
// precondition aborts the run with exit 2; an assertion failure exits 1.
//
// Usage: node frontend/e2e/plan-tabs.cjs [a|b|c|d|e|f|g|h|i|j|k]
const { startLocalStack, consumePageOpen } = require('./_local_stack.cjs')
const { useDueCheck, dialogOpened, expectDueTab, DUE_TABS, openDueTab, readTab, showRow, goToPage, pagerLabel, currentPage } = require('./_due_pages.cjs')
const { waitQuiet, recordTexts, readTexts, resetTexts, sleep } = require('./_smooth.cjs')
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
/** A setup fact the scenario stands on: when it does not hold the run aborts (exit 2), it is not an assertion. */
class SetupError extends Error {}
function precondition(what, ok, detail) {
  if (!ok) throw new SetupError(`precondition failed: ${what}${detail === undefined ? '' : ` (${JSON.stringify(detail)})`}`)
  console.log(`  [SETUP] ${what}`)
}

// ─── Days (YYYY-MM-DD, UTC arithmetic) ───────────────────────────────────────
const manilaToday = () => new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10)
const addDays = (day, n) => {
  const d = new Date(`${day}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().slice(0, 10)
}
const wire = (day) => `${day}T00:00:00`
const daysIn = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate()
/** `day` moved by n months, on its own day of the month (clamped to the month). */
const addMonths = (day, n) => {
  let y = Number(day.slice(0, 4))
  let m = Number(day.slice(5, 7)) + n
  while (m > 12) { m -= 12; y += 1 }
  while (m < 1) { m += 12; y -= 1 }
  return `${y}-${String(m).padStart(2, '0')}-${String(Math.min(Number(day.slice(8, 10)), daysIn(y, m))).padStart(2, '0')}`
}
/** `day`, or the 28th of its month when it is later: a monthly schedule from it never clamps. */
const safeDay = (day) => (Number(day.slice(8, 10)) > 28 ? `${day.slice(0, 8)}28` : day)
const suffix = (d) => (d % 100 >= 11 && d % 100 <= 13 ? 'th' : ['th', 'st', 'nd', 'rd'][d % 10] || 'th')
/** As the app shows a day: "Oct 25th, 2026". */
const fmt = (day) => {
  const d = new Date(`${day}T00:00:00Z`)
  const month = new Intl.DateTimeFormat('en-US', { month: 'short', timeZone: 'UTC' }).format(d)
  return `${month} ${d.getUTCDate()}${suffix(d.getUTCDate())}, ${d.getUTCFullYear()}`
}
const uniq = (xs) => [...new Set(xs)]

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
  const email = `e2e-pln-${tag}-${Math.random().toString(16).slice(2, 8)}@example.com`
  const password = 'E2eTest!2345'
  const reg = await api('', 'POST', '/auth/register', { email, password, first_name: `User${tag}`, last_name: 'Test', default_currency: 'PHP' })
  if (reg.status !== 200 && reg.status !== 201) throw new Error(`register ${reg.status} ${JSON.stringify(reg.json)}`)
  stack.verifyUser(email) // aborts the run unless psql reports UPDATE 1
  const login = await api('', 'POST', '/auth/login', { email, password })
  if (login.status !== 200) throw new Error(`login ${login.status}`)
  return { email, password, tag, token: login.json.access_token }
}
/** A user who will open Transactions with installments: takes their page-open claim before any entry exists. */
async function makeOpener(tag) {
  const u = await makeUser(tag)
  await consumePageOpen(api, u)
  return u
}
const account = (u, name, type = 'checking', balance = 100000, extra = {}) =>
  post(u.token, '/accounts/', { name, account_type: type, balance, currency: 'PHP', ...extra })
/** A PHP card closing on the 28th, due 21 days later, paid from `bank`. */
const card = (u, bank, name, limit = 100000) => post(u.token, '/accounts/', {
  name, account_type: 'credit', balance: 0, currency: 'PHP', credit_limit: limit,
  billing_cycle_start: 28, days_until_due_date: 21, payment_account_id: bank.id,
})
const entry = (u, fields) => post(u.token, '/budget-entries/', { entry_type: 'expense', currency: 'PHP', cadence: 'monthly', ...fields })
/** A monthly card installment: `count` payments remaining from `next`. */
const installment = (u, cardAcct, name, next, count, extra = {}) =>
  entry(u, { name, amount: 1000, account_id: cardAcct.id, next_occurrence: wire(next), end_mode: 'after_occurrences', max_occurrences: count, ...extra })
/** Sets an installment's review flags directly (reviewed with auto-post on or off, or not reviewed). */
function setReview(id, state) {
  if (!Number.isInteger(id)) throw new Error(`unexpected entry id ${id}`)
  const sql = state === 'unreviewed'
    ? `UPDATE budget_entries SET installment_reviewed_at = NULL, auto_post_enabled = false WHERE id = ${id}`
    : `UPDATE budget_entries SET installment_reviewed_at = now(), auto_post_enabled = ${state === 'on' ? 'true' : 'false'} WHERE id = ${id}`
  const out = stack.psql(sql)
  if (out !== 'UPDATE 1') throw new Error(`setting the review flags reported "${out}"`)
}
/** Runs `fn(i)` for i in 0..n-1, `size` at a time. */
async function inBatches(n, size, fn) {
  for (let from = 0; from < n; from += size) {
    await Promise.all(Array.from({ length: Math.min(size, n - from) }, (_, k) => fn(from + k)))
  }
}
/** The snapshot's missed item for an entry (a card's missed items are under the card). */
const missedFor = (snapshot, entryId) =>
  snapshot.missed.find((m) => m.entry_id === entryId) ?? snapshot.card_charges.flatMap((c) => c.missed).find((m) => m.entry_id === entryId)

async function newPage(browser, contextOptions = {}) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 1400 }, timezoneId: 'Asia/Manila', ...contextOptions })
  const page = await ctx.newPage()
  const native = trackNativeDialogs(page)
  if (process.env.DEBUG) page.on('response', (r) => { if (r.url().includes('/api/v1/')) console.log(`    [net] ${r.request().method()} ${r.url().replace(API, '')} -> ${r.status()}`) })
  return { ctx, page, native }
}
async function uiLogin(page, u) {
  await page.goto(`${stack.webUrl}/login`)
  await page.locator('#email').fill(u.email)
  await page.locator('#password').fill(u.password)
  await page.getByRole('button', { name: 'Sign in', exact: true }).click()
  await page.waitForURL((url) => url.pathname === '/')
}
const settle = async (page) => { await page.waitForLoadState('networkidle'); await page.waitForTimeout(500); await waitQuiet(page) }
const badgeId = (slug) => DUE_TABS.find((t) => t.slug === slug).badge
/** Opens Transactions and waits for the Due, Subscriptions and Installments badges to be figures. */
async function openTransactions(page) {
  await page.goto(`${stack.webUrl}/transactions`)
  await page.locator('[data-testid="due-section"]').waitFor()
  for (const slug of ['due', 'subscriptions', 'installments']) {
    await expectDueTab(page, slug)
    await page.locator(`[data-testid="${badgeId(slug)}"]`).filter({ hasNotText: '…' }).waitFor()
  }
  await settle(page)
}
const badgeOf = async (page, slug) => (await page.locator(`[data-testid="${badgeId(slug)}"]`).textContent())?.trim() ?? null
const sourceOf = (e) => `budget_entry:${e.id}`
const rowsFor = (rows, e) => rows.filter((r) => r.source === sourceOf(e))
const dialog = (page) => page.locator('[data-testid="mark-paid-dialog"]')
/** Every materialise POST the page sends, as { entryId, status, body }. */
function recordMaterialize(page) {
  const out = []
  page.on('response', (r) => {
    const m = new URL(r.url()).pathname.match(/\/budget-entries\/(\d+)\/materialize$/)
    if (m && r.request().method() === 'POST') out.push({ entryId: Number(m[1]), status: r.status(), body: JSON.parse(r.request().postData() || '{}') })
  })
  return out
}
/**
 * Clicks `button` on `row`, submits the dialog with `submit`, and waits for it to close. Returns the dialog's opening
 * occurrence. Asserts that the click opened the dialog (within 10 s); when it did not, returns null and records nothing else.
 */
async function record(page, row, button, submit) {
  await row.locator(`[data-testid="${button}"]`).click()
  const shown = await dialog(page).locator('[data-testid="mark-paid-occurrence"]').waitFor({ timeout: 10000 }).then(() => true, () => false)
  check(`${button} opened the Mark paid dialog`, shown, true)
  if (!shown) return null
  await waitQuiet(page)
  const opened = await dialog(page).locator('[data-testid="mark-paid-occurrence"]').inputValue()
  const done = page.waitForResponse((r) => r.request().method() === 'POST' && /\/materialize$/.test(new URL(r.url()).pathname))
  await dialog(page).locator(`[data-testid="${submit}"]`).click()
  await done
  await dialog(page).waitFor({ state: 'detached' })
  await settle(page)
  return opened
}
const checkNoNative = (scenario, native) => check(`(${scenario}) no browser dialog fired`, native.count, 0)

// (a) The split.
async function theSplit(browser) {
  console.log('\n=== (a) subscriptions, installments, bills and one-offs each land on exactly one tab')
  const today = manilaToday()
  const u = await makeOpener('a')
  const bank = await account(u, 'A Checking')
  const visa = await card(u, bank, 'A Visa')
  // Quarterly, so no entry has a second month inside the 30-day window and each is on one tab.
  const q = { cadence: 'quarterly' }
  const netflix = await entry(u, { name: 'Netflix', amount: 549, account_id: visa.id, next_occurrence: wire(today), ...q })
  const disney = await entry(u, { name: 'Disney', amount: 369, account_id: visa.id, next_occurrence: wire(addDays(today, 5)), ...q })
  const asics = await entry(u, { name: 'Asics', amount: 4200, account_id: visa.id, next_occurrence: wire(addDays(today, 6)), end_mode: 'on_date', end_date: wire(addDays(today, 60)), ...q })
  const bdo = await installment(u, visa, 'BDO balance convert', safeDay(addDays(today, 7)), 10, { occurrences_paid_offset: 2 })
  const meralco = await entry(u, { name: 'Meralco', amount: 3100, account_id: visa.id, next_occurrence: wire(today), billing_kind: 'bill', ...q })
  const rent = await entry(u, { name: 'Rent', amount: 15000, account_id: bank.id, next_occurrence: wire(today), ...q })
  const salary = await entry(u, { name: 'Salary', entry_type: 'income', amount: 30000, account_id: bank.id, next_occurrence: wire(addDays(today, 10)), ...q })

  const { ctx, page, native } = await newPage(browser)
  await uiLogin(page, u)
  await openTransactions(page)
  const tabs = {}
  for (const slug of ['due', 'subscriptions', 'installments', 'upcoming']) tabs[slug] = await readTab(page, slug)
  const names = (slug) => uniq(tabs[slug].map((r) => r.name))
  check('(a) Subscriptions holds Netflix (today) and Disney, in that order', names('subscriptions'), ['Netflix', 'Disney'])
  check('(a) every Subscriptions row is marked as a subscription', uniq(tabs.subscriptions.map((r) => r.plan)), ['subscription'])
  check('(a) Netflix is the row of today and Disney a future occurrence',
    [rowsFor(tabs.subscriptions, netflix).map((r) => r.kind), rowsFor(tabs.subscriptions, disney).map((r) => [r.kind, r.day])],
    [['recurring'], [['occurrence', addDays(today, 5)]]])
  check('(a) Installments holds the BDO plan, one plan row', tabs.installments.map((r) => [r.kind, r.name, r.plan]), [['installment', 'BDO balance convert', 'installment']])
  check('(a) Due holds Meralco (a card bill) and Rent', tabs.due.filter((r) => r.kind !== 'pending').map((r) => r.name).sort(), ['Meralco', 'Rent'])
  check('(a) Upcoming holds Asics (an end date) and the salary', names('upcoming').sort(), ['Asics', 'Salary'])
  const entries = [netflix, disney, asics, bdo, meralco, rent, salary]
  check('(a) each entry is on exactly one tab', entries.map((e) => Object.keys(tabs).filter((slug) => rowsFor(tabs[slug], e).length > 0).length), entries.map(() => 1))
  const badges = {}
  for (const slug of Object.keys(tabs)) badges[slug] = Number(await badgeOf(page, slug))
  check('(a) each badge equals its rows over every page', badges, Object.fromEntries(Object.keys(tabs).map((slug) => [slug, tabs[slug].length])))
  checkNoNative('a', native)
  await ctx.close()
}

// (b) A missed subscription.
async function missedSubscription(browser) {
  console.log('\n=== (b) a missed card subscription is a missed row on Subscriptions; Charged moves the month to Due as pending')
  const today = manilaToday()
  const u = await makeUser('b')
  const bank = await account(u, 'B Checking')
  const visa = await card(u, bank, 'B Visa')
  const start = safeDay(addDays(today, -20))
  const spotify = await entry(u, { name: 'Spotify', amount: 279, account_id: visa.id, next_occurrence: wire(start) })
  const before = missedFor(await get(u.token, '/dashboard/snapshot'), spotify.id)
  precondition('Spotify has exactly one unrecorded missed month', before?.unlinked_count === 1, before)

  const { ctx, page, native } = await newPage(browser)
  const posts = recordMaterialize(page)
  await uiLogin(page, u)
  await openTransactions(page)
  check('(b) Spotify is not in Due', (await readTab(page, 'due')).filter((r) => r.name === 'Spotify' && r.kind !== 'pending').length, 0)
  const subs = await readTab(page, 'subscriptions')
  const missed = subs.filter((r) => r.kind === 'missed' && r.name === 'Spotify')
  check('(b) Subscriptions lists one missed row "1 missed since {T-20}"', [missed.length, missed[0]?.sub, missed[0]?.plan], [1, `1 missed since ${fmt(before.oldest_unlinked)}`, 'subscription'])
  const warn = await showRow(page, page.locator('[data-testid="due-row"][data-kind="missed"]').filter({ hasText: 'Spotify' }))
  check('(b) the missed text is the warning colour', await warn.locator('[data-testid="due-missed-text"]').evaluate((el) => el.classList.contains('text-warn')), true)
  check('(b) the next month is a future occurrence on Subscriptions', subs.filter((r) => r.kind === 'occurrence' && r.name === 'Spotify').map((r) => r.day > today), [true])

  const opened = await record(page, warn, 'due-charged', 'mark-paid-charged')
  check('(b) the dialog opened on the oldest missed month', opened, before.oldest_unlinked)
  check('(b) Charged sent one materialise: 201, not posted', posts.map((p) => [p.entryId, p.status, p.body.is_posted]), [[spotify.id, 201, false]])
  check('(b) the API reports nothing unrecorded', missedFor(await get(u.token, '/dashboard/snapshot'), spotify.id)?.unlinked_count ?? 0, 0)
  const after = await readTab(page, 'subscriptions')
  check('(b) the missed row left Subscriptions', after.filter((r) => r.kind === 'missed').length, 0)
  const due = (await readTab(page, 'due')).filter((r) => r.kind === 'pending' && r.text.includes('Spotify'))
  check('(b) the charged month is a pending row in Due, with Posted', [due.length, due[0]?.buttons], [1, ['due-posted']])
  checkNoNative('b', native)
  await ctx.close()
}

// (c) Installment plans.
async function installmentPlans(browser) {
  console.log('\n=== (c) installments are one plan row each: N of M left, Charged and Posted, overdue, Review, auto-post, paused')
  const today = manilaToday()
  const u = await makeOpener('c')
  const bank = await account(u, 'C Checking')
  const visa = await card(u, bank, 'C Visa')
  const bdoStart = safeDay(addDays(today, 7))
  const bdo = await installment(u, visa, 'BDO balance convert', bdoStart, 10, { occurrences_paid_offset: 2 })
  setReview(bdo.id, 'off')
  const oldStart = safeDay(addDays(today, -40))
  const old = await installment(u, visa, 'Old Plan', oldStart, 5)
  setReview(old.id, 'off')
  const unreviewed = await installment(u, visa, 'Unrev Plan', addDays(today, 8), 6)
  setReview(unreviewed.id, 'unreviewed')
  const on = await installment(u, visa, 'On Plan', addDays(today, 9), 6)
  setReview(on.id, 'on')
  const paused = await installment(u, visa, 'Paused Plan', addDays(today, 10), 6, { is_active: false })

  const { ctx, page, native } = await newPage(browser)
  const posts = recordMaterialize(page)
  await uiLogin(page, u)
  await openTransactions(page)
  const plans = await readTab(page, 'installments')
  const planOf = (rows, e) => rows.find((r) => r.kind === 'installment' && r.source === sourceOf(e))
  check('(c) the plans are in order: the overdue one first, then by next charge', plans.map((r) => r.name), ['Old Plan', 'BDO balance convert', 'Unrev Plan', 'On Plan'])
  check('(c) a paused plan is absent', plans.filter((r) => r.name === 'Paused Plan').length, 0)
  const bdoRow = planOf(plans, bdo)
  check('(c) BDO reads "10 of 12 left" and "Next charge {T+7}", with Charged and Posted',
    [bdoRow?.left, bdoRow?.text.includes(`Next charge ${fmt(bdoStart)}`), [...(bdoRow?.buttons ?? [])].sort()], ['10 of 12 left', true, ['due-charged', 'due-posted']])
  const oldRow = planOf(plans, old)
  check('(c) the plan with next charge T-40 reads "5 of 5 left", Overdue and "2 missed"',
    [oldRow?.left, oldRow?.overdue, oldRow?.text.includes('2 missed'), oldRow?.text.includes(`Next charge ${fmt(oldStart)}`)], ['5 of 5 left', true, true, true])
  check('(c) the unreviewed plan has Review, Charged and Posted', [...(planOf(plans, unreviewed)?.buttons ?? [])].sort(), ['due-charged', 'due-posted', 'due-review'])
  const onRow = planOf(plans, on)
  check('(c) auto-post on: no buttons, plus the label', [onRow?.buttons, onRow?.autoPost?.includes('Auto-posts each morning')], [[], true])
  check('(c) no plan has a credit badge', plans.map((r) => r.credit), plans.map(() => null))

  // Charged on BDO: one materialise, the row stays and counts down; the total is still 12.
  const bdoLive = await showRow(page, page.locator(`[data-testid="due-row"][data-kind="installment"][data-source="${sourceOf(bdo)}"]`))
  await record(page, bdoLive, 'due-charged', 'mark-paid-charged')
  check('(c) Charged sent one materialise: 201, not posted', posts.map((p) => [p.entryId, p.status, p.body.is_posted]), [[bdo.id, 201, false]])
  const afterBdo = planOf(await readTab(page, 'installments'), bdo)
  check('(c) the BDO row stays, now "9 of 12 left" with the next month', [afterBdo?.left, afterBdo?.text.includes(`Next charge ${fmt(addMonths(bdoStart, 1))}`)], ['9 of 12 left', true])
  const bdoNow = await get(u.token, `/budget-entries/${bdo.id}`)
  check('(c) occurrences_paid + max_occurrences is still 12', bdoNow.occurrences_paid + bdoNow.max_occurrences, 12)

  // Posted on the overdue plan: the dialog opens on T-40; then the row shows the next month and 1 missed.
  const oldLive = await showRow(page, page.locator(`[data-testid="due-row"][data-kind="installment"][data-source="${sourceOf(old)}"]`))
  const opened = await record(page, oldLive, 'due-posted', 'mark-paid-submit')
  check('(c) Posted opened the dialog on the oldest month, T-40', opened, oldStart)
  const afterOld = planOf(await readTab(page, 'installments'), old)
  check('(c) after it is recorded the row reads "4 of 5 left", the next month and "1 missed"',
    [afterOld?.left, afterOld?.text.includes(`Next charge ${fmt(addMonths(oldStart, 1))}`), afterOld?.text.includes('1 missed'), afterOld?.overdue], ['4 of 5 left', true, true, true])

  // Review on the unreviewed plan opens the review for that entry.
  const unrevLive = await showRow(page, page.locator(`[data-testid="due-row"][data-kind="installment"][data-source="${sourceOf(unreviewed)}"]`))
  await unrevLive.locator('[data-testid="due-review"]').click()
  const review = page.locator('[data-testid="installment-review-dialog"]')
  if (await dialogOpened(review, '(c) Review opened the installment review dialog')) {
    check('(c) Review opens the installment review for that plan', (await page.locator('[data-testid="installment-review-title"]').textContent())?.includes('Unrev Plan'), true)
    await waitQuiet(page)
    await review.getByRole('button', { name: 'Cancel', exact: true }).click()
    await review.waitFor({ state: 'detached' })
  }
  check('(c) the paused plan was never listed', [paused.is_active, (await readTab(page, 'installments')).filter((r) => r.name === 'Paused Plan').length], [false, 0])
  checkNoNative('c', native)
  await ctx.close()
}

// (d) The credit badge.
async function creditBadge(browser) {
  console.log('\n=== (d) the owner sees the credit badge on a card subscription; an editor does not; no Installments row has one')
  const today = manilaToday()
  const owner = await makeOpener('d')
  const editor = await makeOpener('d-editor')
  const bank = await account(owner, 'D Checking')
  const visa = await card(owner, bank, 'D Visa', 10000)
  // Larger than the whole limit: flagged at_risk.
  const disney = await entry(owner, { name: 'Disney', amount: 15000, account_id: visa.id, next_occurrence: wire(addDays(today, 5)), cadence: 'quarterly' })
  const plan = await installment(owner, visa, 'D Plan', addDays(today, 6), 6, { amount: 15000 })
  await post(owner.token, `/accounts/${visa.id}/shares`, { email: editor.email, role: 'editor' })
  const credit = await get(owner.token, `/cards/${visa.id}/credit`)
  precondition('the API flags the subscription at_risk', credit.credit?.checks?.some((c) => c.source_id === disney.id && c.status === 'at_risk'), credit.credit)
  // The Installments check below means something only if the API has a credit check for D Plan's next charge.
  const planNext = (await get(owner.token, '/budget-entries/installment-plans')).items.find((p) => p.entry_id === plan.id)?.next_charge
  precondition('the API has a credit check for D Plan\'s next charge', planNext !== undefined && planNext !== null &&
    credit.credit?.checks?.some((c) => c.source === 'budget_entry' && c.source_id === plan.id && c.occurrence_date === planNext), { planNext, checks: credit.credit?.checks })
  console.log(`  [SETUP] D Plan's check on ${planNext} has status ${credit.credit.checks.find((c) => c.source_id === plan.id && c.occurrence_date === planNext).status}`)

  const o = await newPage(browser)
  await uiLogin(o.page, owner)
  await openTransactions(o.page)
  const ownerSubs = await readTab(o.page, 'subscriptions')
  check('(d) owner: the Disney row carries the at_risk badge', rowsFor(ownerSubs, disney).map((r) => r.credit), ['at_risk'])
  check('(d) owner: no Installments row has a badge', (await readTab(o.page, 'installments')).filter((r) => rowsFor([r], plan).length === 1).map((r) => r.credit), [null])
  checkNoNative('d', o.native)
  await o.ctx.close()

  const e = await newPage(browser)
  await uiLogin(e.page, editor)
  await openTransactions(e.page)
  const editorSubs = await readTab(e.page, 'subscriptions')
  check('(d) editor: the Disney row is listed, with no badge', rowsFor(editorSubs, disney).map((r) => r.credit), [null])
  check('(d) editor: no Installments row has a badge', (await readTab(e.page, 'installments')).map((r) => r.credit).filter((c) => c !== null), [])
  checkNoNative('d', e.native)
  await e.ctx.close()
}

// (e) A past-due bank subscription is a missed row, never a recurring "Overdue" row.
async function overdueFlag(browser) {
  console.log('\n=== (e) a past-due bank subscription is a missed row on Subscriptions, not an Overdue recurring row and not in Due')
  const today = manilaToday()
  const u = await makeUser('e')
  // Only a capped entry (an installment) is listed overdue by the projection; an open-ended
  // schedule's missed occurrences are dropped there and reach the user as a missed row.
  const bank = await account(u, 'E Bank', 'checking', 100000)
  const gym = await entry(u, { name: 'E Streaming', amount: 400, account_id: bank.id, next_occurrence: wire(addDays(today, -3)), billing_kind: 'subscription' })
  const snapshot = await get(u.token, '/dashboard/snapshot')
  const before = missedFor(snapshot, gym.id)
  precondition('the entry is a missed item with one unrecorded month', before?.unlinked_count === 1, before)
  precondition('no overdue payable is listed for it', !(snapshot.payables || []).some((p) => p.source === 'budget_entry' && p.source_id === gym.id && p.overdue), snapshot.payables)

  const { ctx, page, native } = await newPage(browser)
  await uiLogin(page, u)
  await openTransactions(page)
  const subs = rowsFor(await readTab(page, 'subscriptions'), gym)
  check('(e) Subscriptions has one missed row and no recurring row', [subs.filter((r) => r.kind === 'missed').length, subs.filter((r) => r.kind === 'recurring').length], [1, 0])
  check('(e) the missed row is on the subscription plan and reads "1 missed since"', [subs.find((r) => r.kind === 'missed')?.plan, subs.find((r) => r.kind === 'missed')?.sub], ['subscription', `1 missed since ${fmt(before.oldest_unlinked)}`])
  check('(e) no Subscriptions row for it carries the overdue flag', subs.map((r) => r.overdue), subs.map(() => false))
  check('(e) it is not in Due', rowsFor(await readTab(page, 'due'), gym).length, 0)
  checkNoNative('e', native)
  await ctx.close()
}

// (f) Empty, pager and cap.
async function emptyPagerCap(browser) {
  console.log('\n=== (f) empty texts, each tab pages on its own, 120 in-window occurrences, and the 500-occurrence cap')
  const today = manilaToday()

  // Empty.
  {
    const u = await makeUser('f-empty')
    const { ctx, page, native } = await newPage(browser)
    await uiLogin(page, u)
    await openTransactions(page)
    await openDueTab(page, 'subscriptions')
    check('(f) empty Subscriptions: the text and badge 0',
      [(await page.locator('[data-testid="due-subscriptions-empty"]').textContent())?.trim(), await badgeOf(page, 'subscriptions')], ['No subscription charges due or in the next 30 days.', '0'])
    await openDueTab(page, 'installments')
    check('(f) empty Installments: the text and badge 0',
      [(await page.locator('[data-testid="due-installments-empty"]').textContent())?.trim(), await badgeOf(page, 'installments')], ['No active installment plans.', '0'])
    checkNoNative('f', native)
    await ctx.close()
  }

  // Seven plans and four subscriptions: each tab pages on its own.
  {
    const u = await makeOpener('f-pager')
    const bank = await account(u, 'F Checking')
    const visa = await card(u, bank, 'F Visa')
    for (let n = 1; n <= 7; n++) await installment(u, visa, `F Plan ${n}`, addDays(today, n + 1), 12)
    for (let n = 1; n <= 4; n++) await entry(u, { name: `F Sub ${n}`, amount: 100 * n, account_id: visa.id, next_occurrence: wire(addDays(today, n + 1)), cadence: 'quarterly' })
    const { ctx, page, native } = await newPage(browser)
    await uiLogin(page, u)
    await openTransactions(page)
    await openDueTab(page, 'installments')
    check('(f) seven plans read "1–3 of 7"', await pagerLabel(page), '1–3 of 7')
    await goToPage(page, 2)
    await openDueTab(page, 'subscriptions')
    check('(f) Subscriptions pages on its own: still page 1, "1–3 of 4"', [await currentPage(page), await pagerLabel(page)], [1, '1–3 of 4'])
    await goToPage(page, 2)
    await openDueTab(page, 'installments')
    check('(f) Installments is still on its page 2', await currentPage(page), 2)
    await openDueTab(page, 'subscriptions')
    check('(f) and Subscriptions on its own page 2', await currentPage(page), 2)
    check('(f) the badges are the totals', [await badgeOf(page, 'installments'), await badgeOf(page, 'subscriptions')], ['7', '4'])
    checkNoNative('f', native)
    await ctx.close()
  }

  // 120 in-window subscription occurrences: 24 weekly card subscriptions from T+1 give five each.
  {
    const u = await makeUser('f-120')
    const bank = await account(u, 'F2 Checking')
    const visa = await card(u, bank, 'F2 Visa', 10000000)
    await inBatches(24, 8, (n) => entry(u, { name: `F2 Weekly ${n}`, amount: 10, cadence: 'weekly', account_id: visa.id, next_occurrence: wire(addDays(today, 1)) }))
    const { ctx, page, native } = await newPage(browser)
    await uiLogin(page, u)
    await openTransactions(page)
    const rows = await readTab(page, 'subscriptions')
    check('(f) 120 occurrences: the badge reads 120, every row is listed and nothing says the list is cut',
      [await badgeOf(page, 'subscriptions'), rows.length, await page.locator('[data-testid="due-occurrences-capped"]').count()], ['120', 120, 0])
    checkNoNative('f', native)
    await ctx.close()
  }

  // The cap: over 500 installment occurrences ahead of one card subscription at T+20.
  {
    const u = await makeOpener('f-cap')
    const bank = await account(u, 'F3 Checking')
    const visa = await card(u, bank, 'F3 Visa', 100000000)
    // Weekly from T+1: T+1, T+8 and T+15 fall before T+20, so 175 plans give 525 such months.
    const plans = 175
    const started = Date.now()
    await inBatches(plans, 8, (n) => installment(u, visa, `F3 Cap ${n}`, addDays(today, 1), 10, { cadence: 'weekly', amount: 10 }))
    const sub = await entry(u, { name: 'F3 Late Sub', amount: 99, account_id: visa.id, next_occurrence: wire(addDays(today, 20)), cadence: 'quarterly' })
    console.log(`    seeded ${plans} weekly installments and one subscription in ${((Date.now() - started) / 1000).toFixed(1)}s`)
    const window = `start_date=${addDays(today, 1)}T00:00:00Z&end_date=${addDays(today, 30)}T23:59:59.999999Z`
    const all = await get(u.token, `/budget-entries/upcoming-occurrences?${window}&limit=500`)
    const lastDay = all.items[all.items.length - 1]?.occurrence_date?.slice(0, 10)
    precondition('the unfiltered occurrences total is over 500', all.total > 500, all.total)
    precondition('the 500 items listed all fall before T+20, so the subscription is cut off', all.items.length === 500 && lastDay < addDays(today, 20), lastDay)
    precondition('and the unfiltered list does not hold the subscription', all.items.every((o) => o.entry_id !== sub.id))

    const { ctx, page, native } = await newPage(browser)
    await uiLogin(page, u)
    await openTransactions(page)
    const rows = await readTab(page, 'subscriptions')
    check('(f) the subscription is listed on Subscriptions with badge 1', [rows.map((r) => [r.name, r.kind, r.day]), await badgeOf(page, 'subscriptions')],
      [[['F3 Late Sub', 'occurrence', addDays(today, 20)]], '1'])
    check('(f) the Installments badge counts the plans', await badgeOf(page, 'installments'), String(plans))
    checkNoNative('f', native)
    await ctx.close()
  }
}

// (g) The Manila day, in a Los Angeles browser.
async function manilaDay(browser) {
  console.log('\n=== (g) in a Los Angeles browser, Manila today is a row of today on Subscriptions and Manila tomorrow a future row')
  const today = manilaToday()
  const tomorrow = addDays(today, 1)
  const u = await makeUser('g')
  const bank = await account(u, 'G Checking')
  const visa = await card(u, bank, 'G Visa')
  const todaySub = await entry(u, { name: 'G Today Sub', amount: 549, account_id: visa.id, next_occurrence: wire(today), cadence: 'quarterly' })
  const tomorrowSub = await entry(u, { name: 'G Tomorrow Sub', amount: 369, account_id: visa.id, next_occurrence: wire(tomorrow), cadence: 'quarterly' })
  const { ctx, page, native } = await newPage(browser, { timezoneId: 'America/Los_Angeles' })
  console.log(`    browser local day ${await page.evaluate(() => new Date().toLocaleDateString('en-CA'))}, Manila day ${today}`)
  await uiLogin(page, u)
  await openTransactions(page)
  const subs = await readTab(page, 'subscriptions')
  check('(g) the Manila-today subscription is a row of today on Subscriptions', rowsFor(subs, todaySub).map((r) => r.kind), ['recurring'])
  check('(g) the Manila-tomorrow subscription is a future row on T+1', rowsFor(subs, tomorrowSub).map((r) => [r.kind, r.day]), [['occurrence', tomorrow]])
  const due = await readTab(page, 'due')
  check('(g) neither is in Due', [rowsFor(due, todaySub).length, rowsFor(due, tomorrowSub).length], [0, 0])
  checkNoNative('g', native)
  await ctx.close()
}

// (h) A bank-paid subscription (commit 7b).
async function bankSubscription(browser) {
  console.log('\n=== (h) a bank-paid recurring expense marked Subscription moves to Subscriptions; the select is absent where it does not apply')
  const today = manilaToday()
  const u = await makeOpener('h')
  const bank = await account(u, 'H Checking')
  const visa = await card(u, bank, 'H Visa')
  // Weekly from today: today's month is in Due, the next four are in Upcoming, until it is marked.
  const spotify = await entry(u, { name: 'Spotify', amount: 279, cadence: 'weekly', account_id: bank.id, next_occurrence: wire(today) })
  const rent = await entry(u, { name: 'Rent', amount: 15000, cadence: 'quarterly', account_id: bank.id, next_occurrence: wire(today) })
  const netflix = await entry(u, { name: 'H Netflix', amount: 549, account_id: visa.id, next_occurrence: wire(addDays(today, 5)), cadence: 'quarterly' })
  const gadget = await entry(u, { name: 'H Gadget', amount: 2000, account_id: bank.id, next_occurrence: wire(addDays(today, 3)), end_mode: 'after_occurrences', max_occurrences: 6 })
  const salary = await entry(u, { name: 'H Salary', entry_type: 'income', amount: 30000, account_id: bank.id, next_occurrence: wire(addDays(today, 9)), cadence: 'quarterly' })
  const phone = await installment(u, visa, 'H Phone', addDays(today, 4), 6)

  const { ctx, page, native } = await newPage(browser)
  // Every entry update the page sends, as { id, body }: what the form put on the wire, key by key.
  const puts = []
  page.on('request', (r) => {
    const m = new URL(r.url()).pathname.match(/\/budget-entries\/(\d+)$/)
    if (m && r.method() === 'PUT') puts.push({ id: Number(m[1]), body: JSON.parse(r.postData() || '{}') })
  })
  /** The billing_kind of the last update sent for `e`: 'absent' when the key is not in the body, 'no update' when none was sent. */
  const sentKind = (e) => {
    const last = puts.filter((p) => p.id === e.id).at(-1)
    if (last === undefined) return 'no update'
    return 'billing_kind' in last.body ? last.body.billing_kind : 'absent'
  }
  await uiLogin(page, u)
  const where = async () => {
    await openTransactions(page)
    const out = {}
    for (const slug of ['due', 'upcoming', 'subscriptions']) out[slug] = (await readTab(page, slug)).filter((r) => r.source === sourceOf(spotify)).length
    out.rentDue = rowsFor(await readTab(page, 'due'), rent).length
    return out
  }
  const before = await where()
  check('(h) unmarked, Spotify has a month in Due and four in Upcoming, none in Subscriptions; Rent is in Due',
    [before.due, before.upcoming, before.subscriptions, before.rentDue], [1, 4, 0, 1])

  const openEdit = async (name, section) => {
    await page.goto(`${stack.webUrl}/allocations`)
    await page.locator('[data-testid^="kind-section-"]').first().waitFor()
    await settle(page)
    await page.locator(`[data-testid="kind-section-${section}"] article`).filter({ has: page.getByText(name, { exact: true }) }).click()
    const form = page.locator('form').filter({ has: page.getByRole('button', { name: 'Update Recurring Entry' }) })
    // A form that does not open is a failed assertion; the caller ends the scenario on null.
    if (!(await dialogOpened(form, `(h) ${name} opened its edit form`))) return null
    await waitQuiet(page)
    return form
  }
  const save = async (form) => {
    await form.getByRole('button', { name: 'Update Recurring Entry' }).click()
    await form.waitFor({ state: 'detached' })
    await settle(page)
  }

  // The select shows only for an open-ended bank expense.
  const notShown = []
  for (const [name, section] of [['H Netflix', 'subscription'], ['H Salary', 'other'], ['H Gadget', 'cash'], ['H Phone', 'installment']]) {
    const f = await openEdit(name, section)
    if (f === null) return ctx.close()
    notShown.push([name, await f.getByTestId('recurring-bank-kind').count()])
    await page.getByLabel('Close allocation modal').first().click()
    await f.waitFor({ state: 'detached' })
  }
  check('(h) the select is absent on a card entry, on income and on a capped entry (bank and card)', notShown, [['H Netflix', 0], ['H Salary', 0], ['H Gadget', 0], ['H Phone', 0]])
  const cardBefore = (await get(u.token, `/budget-entries/${netflix.id}`)).billing_kind
  const cardForm = await openEdit('H Netflix', 'subscription')
  if (cardForm === null) return ctx.close()
  await save(cardForm)
  check('(h) saving a card entry leaves its billing kind as it was', (await get(u.token, `/budget-entries/${netflix.id}`)).billing_kind, cardBefore)
  check('(h) saving a card entry sends no billing_kind key', sentKind(netflix), 'absent')
  const gadgetForm = await openEdit('H Gadget', 'cash')
  if (gadgetForm === null) return ctx.close()
  await save(gadgetForm)
  check('(h) saving a capped bank entry (no select) sends no billing_kind key', sentKind(gadget), 'absent')

  const form = await openEdit('Spotify', 'cash')
  if (form === null) return ctx.close()
  const select = form.getByTestId('recurring-bank-kind')
  const selectShown = await select.count()
  check('(h) the open-ended bank expense has the select', selectShown, 1)
  if (selectShown !== 1) {
    // Without the select nothing below can be driven: the scenario ends on the failed assertion.
    await ctx.close()
    return
  }
  check('(h) the select is on Other, with Subscription and Other', [await select.inputValue(), await select.locator('option').allInnerTexts()], ['other', ['Subscription', 'Other']])
  await select.selectOption('subscription')
  await save(form)
  check('(h) changing the pick to Subscription sends billing_kind "subscription"', sentKind(spotify), 'subscription')
  check('(h) the API stores billing_kind subscription', (await get(u.token, `/budget-entries/${spotify.id}`)).billing_kind, 'subscription')
  const marked = await where()
  check('(h) marked, Spotify is on Subscriptions (today and the next four) and no longer in Due or Upcoming; Rent is unchanged',
    [marked.due, marked.upcoming, marked.subscriptions, marked.rentDue], [0, 0, 5, 1])
  check('(h) no Spotify row has a credit badge (it is not a card)', (await readTab(page, 'subscriptions')).filter((r) => r.source === sourceOf(spotify)).map((r) => r.credit), [null, null, null, null, null])

  const untouched = await openEdit('Spotify', 'cash')
  if (untouched === null) return ctx.close()
  check('(h) the edit form loads the stored choice', await untouched.getByTestId('recurring-bank-kind').inputValue(), 'subscription')
  await save(untouched)
  check('(h) an edit that leaves the pick sends no billing_kind key, and the API keeps subscription',
    [sentKind(spotify), (await get(u.token, `/budget-entries/${spotify.id}`)).billing_kind], ['absent', 'subscription'])
  const again = await openEdit('Spotify', 'cash')
  if (again === null) return ctx.close()
  const selectAgain = again.getByTestId('recurring-bank-kind')
  await selectAgain.selectOption('other')
  await save(again)
  check('(h) changing the pick to Other sends billing_kind null', sentKind(spotify), null)
  check('(h) set back to Other, the API clears billing_kind', (await get(u.token, `/budget-entries/${spotify.id}`)).billing_kind ?? null, null)
  const back = await where()
  check('(h) Spotify is back in Due and Upcoming, none in Subscriptions', [back.due, back.upcoming, back.subscriptions, back.rentDue], [1, 4, 0, 1])
  checkNoNative('h', native)
  await ctx.close()
}

// (i) A held day rollover, staged in the browser.
async function heldRollover(browser) {
  console.log('\n=== (i) a held Manila day change: the badges read "..." until fresh data arrives, and stale data keeps them there')
  const day = manilaToday()
  const next = addDays(day, 1)
  const u = await makeOpener('i')
  const bank = await account(u, 'I Checking')
  const visa = await card(u, bank, 'I Visa')
  await entry(u, { name: 'I Sub A', amount: 100, account_id: visa.id, next_occurrence: wire(addDays(day, 3)), cadence: 'quarterly' })
  await entry(u, { name: 'I Sub B', amount: 200, account_id: visa.id, next_occurrence: wire(addDays(day, 4)), cadence: 'quarterly' })
  await installment(u, visa, 'I Plan A', addDays(day, 9), 6)
  await installment(u, visa, 'I Plan B', addDays(day, 10), 6)
  const BADGES = [badgeId('subscriptions'), badgeId('installments')]

  const { ctx, page, native } = await newPage(browser, { timezoneId: 'UTC' })
  await recordTexts(page, BADGES)
  // Just before Manila midnight of the real day: responses carry today = day.
  await page.clock.install({ time: new Date(`${day}T15:59:00Z`) })

  // Each route is held (when armed) on its own gate and then fulfilled with the real response
  // rewritten: `today`, and one subscription occurrence and one plan removed.
  const KINDS = ['snapshot', 'plans', 'subs', 'none']
  const openGate = () => ({ held: Promise.resolve(), open: () => {} })
  const heldGate = () => { const g = {}; g.held = new Promise((resolve) => { g.open = resolve }); return g }
  const stage = { active: false, gates: Object.fromEntries(KINDS.map((k) => [k, openGate()])), today: next, hits: { snapshot: 0, plans: 0, subs: 0, none: 0 } }
  const kindOf = (url) => {
    const p = url.pathname
    if (p.endsWith('/dashboard/snapshot')) return 'snapshot'
    if (p.endsWith('/budget-entries/installment-plans')) return 'plans'
    if (p.endsWith('/budget-entries/upcoming-occurrences')) return url.searchParams.get('plan') === 'subscription' ? 'subs' : url.searchParams.get('plan') === 'none' ? 'none' : null
    return null
  }
  const rewrite = (kind, json) => {
    if (kind === 'snapshot') return { ...json, today: stage.today }
    if (kind === 'plans') return { ...json, today: stage.today, items: json.items.slice(1) }
    if (kind === 'subs') return { ...json, items: json.items.slice(1), total: Math.max(0, json.total - 1) }
    return json
  }
  await page.route((url) => kindOf(url) !== null, async (route) => {
    const kind = kindOf(new URL(route.request().url()))
    if (!stage.active) return route.fallback()
    stage.hits[kind]++
    await stage.gates[kind].held
    const res = await route.fetch()
    await route.fulfill({ response: res, json: rewrite(kind, await res.json()) })
  })

  await uiLogin(page, u)
  await openTransactions(page)
  check('(i) before midnight the badges read the real counts, 2 and 2', [await badgeOf(page, 'subscriptions'), await badgeOf(page, 'installments')], ['2', '2'])
  await openDueTab(page, 'subscriptions')

  // Arm the hold, then cross Manila midnight (two page minutes: 23:59 to 00:01).
  await resetTexts(page)
  stage.active = true
  stage.today = next
  stage.gates = Object.fromEntries(KINDS.map((k) => [k, heldGate()]))
  await page.clock.fastForward('02:00')
  const until = Date.now() + 10000
  while (Date.now() < until && !Object.values(stage.hits).every((n) => n >= 1)) await sleep(200)
  precondition('the new day sent its snapshot, plans and both occurrence requests, all held', Object.values(stage.hits).every((n) => n >= 1), stage.hits)
  await sleep(600)
  check('(i) while held: both badges read "..."', [await badgeOf(page, 'subscriptions'), await badgeOf(page, 'installments')], ['…', '…'])
  check('(i) while held: no empty text is shown', await page.locator('[data-testid="due-subscriptions-empty"], [data-testid="due-installments-empty"]').count(), 0)

  // The snapshot and the plans land first, with the subscription occurrences still held:
  // Subscriptions waits for both of its sources, so it stays at "...".
  for (const k of ['snapshot', 'plans', 'none']) stage.gates[k].open()
  await page.locator(`[data-testid="${BADGES[1]}"]`).filter({ hasNotText: '…' }).waitFor({ timeout: 15000 }).catch(() => {})
  await sleep(600)
  check('(i) the snapshot and plans in, the subscription occurrences held: Subscriptions reads "...", Installments the new count',
    [await badgeOf(page, 'subscriptions'), await badgeOf(page, 'installments')], ['…', '1'])
  check('(i) and no Subscriptions empty text is shown', await page.locator('[data-testid="due-subscriptions-empty"]').count(), 0)
  stage.gates.subs.open()
  for (const id of BADGES) await page.locator(`[data-testid="${id}"]`).filter({ hasNotText: '…' }).waitFor({ timeout: 15000 })
  await settle(page)
  check('(i) after release: the badges show the rewritten counts, 1 and 1', [await badgeOf(page, 'subscriptions'), await badgeOf(page, 'installments')], ['1', '1'])
  const history = await readTexts(page)
  for (const [slug, id] of [['subscriptions', BADGES[0]], ['installments', BADGES[1]]]) {
    const texts = history[id]?.texts ?? []
    check(`(i) the ${slug} badge went from "..." to the new count and never showed the old one`, [texts[0], texts.includes('2'), texts[texts.length - 1]], ['…', false, '1'])
  }

  // A later response that still carries the old day: the badges go back to "..." and stay there.
  stage.hits = { snapshot: 0, plans: 0, subs: 0, none: 0 }
  stage.today = day
  stage.gates = Object.fromEntries(KINDS.map((k) => [k, openGate()]))
  await page.locator('nav a[href="/"]').first().click()
  await page.waitForURL((url) => url.pathname === '/')
  await settle(page)
  await page.locator('nav a[href="/transactions"]').first().click()
  await page.waitForURL((url) => url.pathname === '/transactions')
  await settle(page)
  precondition('the return to Transactions refetched the snapshot and the plans', stage.hits.snapshot >= 1 && stage.hits.plans >= 1, stage.hits)
  await sleep(600)
  check('(i) a response still dated the old day keeps both badges at "..."', [await badgeOf(page, 'subscriptions'), await badgeOf(page, 'installments')], ['…', '…'])
  await page.locator(`[data-testid="${DUE_TABS.find((t) => t.slug === 'subscriptions').tab}"]`).click()
  check('(i) and no empty text is shown', await page.locator('[data-testid="due-subscriptions-empty"], [data-testid="due-installments-empty"]').count(), 0)
  checkNoNative('i', native)
  await page.unrouteAll({ behavior: 'ignoreErrors' })
  await ctx.close()
}

// (j) One source of a tab fails and the other loads. Every route fails from the first request,
// so no source ever has data for the day: the badge reads 0 (D7: the last good figure for the
// same day, or 0), never the part the other source carried, and the tab shows its error.
async function oneSourceFails(browser) {
  console.log('\n=== (j) one source of Upcoming or Subscriptions fails and the other loads: the badge reads 0 and the error shows')
  const today = manilaToday()
  const u = await makeUser('j')
  const bank = await account(u, 'J Checking')
  const visa = await card(u, bank, 'J Visa')
  await post(u.token, '/transactions/', {
    account_id: bank.id, transaction_type: 'debit', amount: 50, description: 'J Planned',
    transaction_date: wire(addDays(today, 2)), is_posted: false,
  })
  await entry(u, { name: 'J Bill', amount: 800, account_id: bank.id, next_occurrence: wire(addDays(today, 3)) })
  await entry(u, { name: 'J Today Sub', amount: 549, account_id: visa.id, next_occurrence: wire(today), cadence: 'quarterly' })
  await entry(u, { name: 'J Later Sub', amount: 369, account_id: visa.id, next_occurrence: wire(addDays(today, 5)), cadence: 'quarterly' })
  const SOURCES = {
    transactions: (url) => url.pathname.endsWith('/api/v1/transactions/') && url.searchParams.get('order') === 'asc',
    occurrences: (url) => url.pathname.endsWith('/budget-entries/upcoming-occurrences') && url.searchParams.get('plan') === 'none',
    snapshot: (url) => url.pathname.endsWith('/dashboard/snapshot'),
    'subscription occurrences': (url) => url.pathname.endsWith('/budget-entries/upcoming-occurrences') && url.searchParams.get('plan') === 'subscription',
  }
  /** Signs in with `source` failing (500) from the first request, opens Transactions and the tab; returns the page. */
  async function failing(source, slug) {
    const opened = await newPage(browser)
    const hits = { n: 0 }
    if (source !== null) {
      await opened.page.route((url) => SOURCES[source](url), async (route) => {
        hits.n++
        await route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ detail: 'failed on purpose (plan-tabs j)' }) })
      })
    }
    await uiLogin(opened.page, u)
    await opened.page.goto(`${stack.webUrl}/transactions`)
    await opened.page.locator('[data-testid="due-section"]').waitFor()
    await opened.page.locator(`[data-testid="${badgeId(slug)}"]`).filter({ hasNotText: '…' }).waitFor({ timeout: 15000 }).catch(() => {})
    await openDueTab(opened.page, slug)
    await settle(opened.page)
    if (source !== null) precondition(`the ${source} request was sent and failed`, hits.n >= 1, hits)
    return { ...opened, hits }
  }
  const panel = (page, slug) => page.locator(`[data-testid="${DUE_TABS.find((t) => t.slug === slug).panel}"]`)
  const windowError = async (page, slug) => [
    await panel(page, slug).locator('[data-testid="due-window-error"]').count(),
    await panel(page, slug).locator('[data-testid="due-window-retry"]').count(),
  ]

  // The control: nothing fails, so each tab counts both of its sources.
  {
    const { ctx, page, native } = await failing(null, 'upcoming')
    check('(j) control: Upcoming counts J Planned and J Bill, Subscriptions J Today Sub and J Later Sub', [await badgeOf(page, 'upcoming'), await badgeOf(page, 'subscriptions')], ['2', '2'])
    checkNoNative('j', native)
    await ctx.close()
  }
  for (const [source, slug, failedRetry] of [['occurrences', 'upcoming', true], ['transactions', 'upcoming', true], ['subscription occurrences', 'subscriptions', true], ['snapshot', 'subscriptions', false]]) {
    const { ctx, page, native } = await failing(source, slug)
    check(`(j) only the ${source} request fails: the ${slug} badge reads 0, not the other source's part`, await badgeOf(page, slug), '0')
    if (failedRetry) {
      check(`(j) only the ${source} request fails: the ${slug} tab shows the error with Retry`, await windowError(page, slug), [1, 1])
    } else {
      check(`(j) only the ${source} request fails: the card says it could not load what is due`,
        await page.locator('[data-testid="due-section"] [role="alert"]').filter({ hasText: 'Could not load what is due.' }).count(), 1)
    }
    check(`(j) only the ${source} request fails: no empty text on ${slug}`, await panel(page, slug).locator(`[data-testid="due-${slug}-empty"]`).count(), 0)
    if (failedRetry) {
      // Retry once the source answers again: the badge counts both sources.
      await page.unrouteAll({ behavior: 'ignoreErrors' })
      await panel(page, slug).locator('[data-testid="due-window-retry"]').click()
      await page.locator(`[data-testid="${badgeId(slug)}"]`).filter({ hasText: /^2$/ }).waitFor({ timeout: 15000 }).catch(() => {})
      await settle(page)
      check(`(j) after Retry with the ${source} request answering: the ${slug} badge reads 2 and the error is gone`, [await badgeOf(page, slug), await windowError(page, slug)], ['2', [0, 0]])
    }
    checkNoNative('j', native)
    await page.unrouteAll({ behavior: 'ignoreErrors' })
    await ctx.close()
  }
}

// (k) A row moves between a tab's sources and then the refresh of one source fails. The failed
// source keeps its earlier data in the cache, so adding it to the fresh source would count the
// moved row twice; the badge shows the tab's last complete total for the day instead (D7).
// Upcoming: K Bill's occurrence on T+3 is recorded on T+3, so it moves from the occurrences to
// the transactions, and the occurrences refresh fails. Subscriptions: K Sub moves from T+5 to
// today through the API (an occurrence to a snapshot row), and the same refresh (the record
// invalidates every source) brings the snapshot but fails the subscription occurrences.
async function staleSourceAfterMove(browser) {
  console.log('\n=== (k) a row moves between sources and one refresh fails: each badge keeps its last complete total, not a sum that counts the row twice')
  const today = manilaToday()
  const billDay = addDays(today, 3)
  const u = await makeUser('k')
  const bank = await account(u, 'K Checking')
  const visa = await card(u, bank, 'K Visa')
  const bill = await entry(u, { name: 'K Bill', amount: 800, account_id: bank.id, next_occurrence: wire(billDay) })
  const sub = await entry(u, { name: 'K Sub', amount: 369, account_id: visa.id, next_occurrence: wire(addDays(today, 5)), cadence: 'quarterly' })
  const { ctx, page, native } = await newPage(browser)
  const failing = { on: false, hits: { none: 0, subscription: 0 }, snapshots: 0 }
  await page.route((url) => url.pathname.endsWith('/budget-entries/upcoming-occurrences') || url.pathname.endsWith('/dashboard/snapshot'), async (route) => {
    const url = new URL(route.request().url())
    if (!failing.on) return route.fallback()
    if (url.pathname.endsWith('/dashboard/snapshot')) { failing.snapshots++; return route.fallback() }
    const plan = url.searchParams.get('plan')
    if (plan !== 'none' && plan !== 'subscription') return route.fallback()
    failing.hits[plan]++
    await route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ detail: 'failed on purpose (plan-tabs k)' }) })
  })
  await uiLogin(page, u)
  await openTransactions(page)
  await openDueTab(page, 'upcoming')
  check('(k) loaded: Upcoming counts K Bill\'s occurrence and Subscriptions K Sub\'s, 1 and 1', [await badgeOf(page, 'upcoming'), await badgeOf(page, 'subscriptions')], ['1', '1'])

  // K Sub moves to today on the server; the page has not refetched yet.
  const moved = await api(u.token, 'PUT', `/budget-entries/${sub.id}`, { next_occurrence: wire(today) })
  precondition('the API moved K Sub to today', moved.status === 200, moved.status)
  // Record K Bill's T+3 occurrence on T+3 with both occurrence refreshes failing.
  failing.on = true
  const row = await showRow(page, page.locator(`[data-testid="due-row"][data-kind="occurrence"][data-source="${sourceOf(bill)}"][data-day="${billDay}"]`))
  await row.locator('[data-testid="upcoming-mark-paid"]').click()
  const shown = await dialog(page).locator('[data-testid="mark-paid-occurrence"]').waitFor({ timeout: 10000 }).then(() => true, () => false)
  check('upcoming-mark-paid opened the Mark paid dialog', shown, true)
  if (!shown) {
    await ctx.close()
    return
  }
  await waitQuiet(page)
  await dialog(page).locator('input[type="date"][id$="-day"]').fill(billDay)
  const done = page.waitForResponse((r) => r.request().method() === 'POST' && /\/materialize$/.test(new URL(r.url()).pathname))
  await dialog(page).locator('[data-testid="mark-paid-submit"]').click()
  precondition('the record was created', (await done).status() === 201)
  await dialog(page).waitFor({ state: 'detached' })
  await settle(page)
  const until = Date.now() + 10000
  while (Date.now() < until && !(failing.hits.none >= 1 && failing.hits.subscription >= 1 && failing.snapshots >= 1)) await sleep(200)
  precondition('the record refetched the snapshot and failed both occurrence refreshes', failing.hits.none >= 1 && failing.hits.subscription >= 1 && failing.snapshots >= 1, failing)
  const recorded = (await get(u.token, `/transactions/?limit=100`)).items.filter((t) => t.budget_entry_id === bill.id).map((t) => t.transaction_date.slice(0, 10))
  precondition('K Bill was recorded on T+3, inside the Upcoming window', JSON.stringify(recorded) === JSON.stringify([billDay]), recorded)
  await sleep(600)

  const windowError = async (slug) => {
    const panel = page.locator(`[data-testid="${DUE_TABS.find((t) => t.slug === slug).panel}"]`)
    return [await panel.locator('[data-testid="due-window-error"]').count(), await panel.locator('[data-testid="due-window-retry"]').count()]
  }
  check('(k) Upcoming: the occurrences refresh failed after K Bill moved to the transactions: the badge keeps the last complete total 1, not 2',
    await badgeOf(page, 'upcoming'), '1')
  check('(k) Upcoming shows the error with Retry', await windowError('upcoming'), [1, 1])
  await page.locator(`[data-testid="${DUE_TABS.find((t) => t.slug === 'subscriptions').tab}"]`).click()
  await waitQuiet(page)
  check('(k) Subscriptions: the occurrences refresh failed after K Sub moved to the snapshot: the badge keeps the last complete total 1, not 2',
    await badgeOf(page, 'subscriptions'), '1')
  check('(k) Subscriptions shows the error with Retry', await windowError('subscriptions'), [1, 1])

  // Retry with the occurrences answering: each badge is its true total again.
  failing.on = false
  await page.locator('[data-testid="due-panel-subscriptions"] [data-testid="due-window-retry"]').click()
  await openDueTab(page, 'upcoming')
  await page.locator('[data-testid="due-panel-upcoming"] [data-testid="due-window-retry"]').click()
  await page.locator('[data-testid="due-panel-upcoming"] [data-testid="due-window-error"]').waitFor({ state: 'detached', timeout: 15000 }).catch(() => {})
  await settle(page)
  const up = await readTab(page, 'upcoming')
  const subs = await readTab(page, 'subscriptions')
  check('(k) after Retry: Upcoming lists K Bill once, as a transaction row, and Subscriptions K Sub today; both badges read 1',
    [rowsFor(up, bill).length + up.filter((r) => r.kind === 'upcoming' && r.text.includes('K Bill')).length, rowsFor(subs, sub).map((r) => r.kind), await badgeOf(page, 'upcoming'), await badgeOf(page, 'subscriptions')],
    [1, ['recurring'], '1', '1'])
  checkNoNative('k', native)
  await page.unrouteAll({ behavior: 'ignoreErrors' })
  await ctx.close()
}

;(async () => {
  stack = await startLocalStack()
  API = `${stack.apiUrl}/api/v1`
  const browser = await chromium.launch()
  const run = (k) => !only || only === k
  const steps = { a: theSplit, b: missedSubscription, c: installmentPlans, d: creditBadge, e: overdueFlag, f: emptyPagerCap, g: manilaDay, h: bankSubscription, i: heldRollover, j: oneSourceFails, k: staleSourceAfterMove }
  for (const [k, fn] of Object.entries(steps)) if (run(k)) await fn(browser)
  await browser.close()
  stack.stop()
  console.log(`\nRESULT: ${pass}/${total} assertions passed`)
  process.exit(pass === total ? 0 : 1)
})().catch((e) => {
  console.error(e)
  stack?.stop()
  console.log(`\nRESULT (aborted): ${pass}/${total} assertions passed`)
  process.exit(e instanceof SetupError ? 2 : 1)
})
