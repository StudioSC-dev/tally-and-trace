// Browser check for STU-581 PR 4: a refused date in the Change date dialog offers Pay together
// (join the next payment) and Delay all (move this and every later payment, with Undo).
// Starts its own API and web app against a throwaway database (./_local_stack.cjs). The API
// must serve `GET /budget-entries/{id}/occurrences/{day}/date-options` (STU-581 PR 3). Not
// wired into CI and not part of `pnpm build`. Run steps: see ./README.md.
//
// Scenarios (each seeds its own user, so each can run alone):
//   (a) a missed monthly payment, the date set to the next payment's day: the server's refusal
//       and both choices show, with the previewed lines and total; Pay together sends one PUT
//       with mode "overlap" on that day; the missed row goes and two Upcoming rows read that day
//   (b) a date past the next payment: Pay together says it is the closest day; Delay all shows
//       the previewed moves and the repeat; it sends one PUT with mode "cascade" on the chosen
//       date; the dialog stays open with "Moved to ..." and Undo / Done; the missed row goes and
//       Upcoming shows the new dates; Done closes without another request
//   (c) Undo after a Delay all sends one POST to cascade-undo with its token (and no entry PUT);
//       the dialog closes and the missed row and the old schedule return
//   (d) a refusal with no choice (a date inside a closed statement, for a last payment, ended on its day) shows only the error, after
//       one date-options request that found neither choice; a loan's dialog never asks for or
//       shows choices
//   (e) a card subscription: the choices carry "statement closing" lines; after Delay all the
//       confirmation names the new statement and the dashboard payable's total drops the charge
//   (f) an API that answers date-options with 404, 405 or 422 leaves the original refusal alone
//   (g) at 390px the choices stack, their buttons are 44px tall and the page does not scroll sideways
//
// Every scenario checks that no browser dialog fired.
//
// Usage: node frontend/e2e/forced-date-choices.cjs [a|b|c|d|e|f|g]
const { startLocalStack } = require('./_local_stack.cjs')
const { useDueCheck, openDueTab, rowsOf, showRow } = require('./_due_pages.cjs')
const { waitQuiet } = require('./_smooth.cjs')
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

// ─── Days (YYYY-MM-DD, UTC arithmetic) ───────────────────────────────────────
const manilaToday = () => new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10)
const addDays = (day, n) => {
  const d = new Date(`${day}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().slice(0, 10)
}
/** The same day of the month `n` months on (callers keep the day at 28 or less). */
const addMonths = (day, n) => {
  const d = new Date(`${day}T00:00:00Z`)
  d.setUTCMonth(d.getUTCMonth() + n)
  return d.toISOString().slice(0, 10)
}
const wire = (day) => `${day}T00:00:00`
const dom = (day) => Number(day.slice(8, 10))
const suffix = (d) => (d % 100 >= 11 && d % 100 <= 13 ? 'th' : ['th', 'st', 'nd', 'rd'][d % 10] || 'th')
const ordinal = (d) => `${d}${suffix(d)}`
/** As the app shows a day: "Oct 25th, 2026". */
const fmt = (day) => {
  const d = new Date(`${day}T00:00:00Z`)
  const month = new Intl.DateTimeFormat('en-US', { month: 'short', timeZone: 'UTC' }).format(d)
  return `${month} ${d.getUTCDate()}${suffix(d.getUTCDate())}, ${d.getUTCFullYear()}`
}
const moved = (forced, scheduled) => `${fmt(forced)} (moved from ${fmt(scheduled)})`
/** The first day on or after `from` that is a statement close day (day of month `cycleDay`, at most 28). */
const closeOnOrAfter = (from, cycleDay) => {
  let d = from
  while (dom(d) !== cycleDay) d = addDays(d, 1)
  return d
}
/** A day `lo` to `hi` days before today whose day of the month is at most `maxDom`, so a month on keeps its day. */
const pastDay = (today, lo, hi, maxDom) => {
  for (let n = lo; n <= hi; n++) if (dom(addDays(today, -n)) <= maxDom) return addDays(today, -n)
  throw new Error('no suitable day')
}
/** A day `lo` to `hi` days after today whose day of the month is at most `maxDom`. */
const futureDay = (today, lo, hi, maxDom) => {
  for (let n = lo; n <= hi; n++) if (dom(addDays(today, n)) <= maxDom) return addDays(today, n)
  throw new Error('no suitable day')
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
  const email = `e2e-fc-${tag}-${Math.random().toString(16).slice(2, 8)}@example.com`
  const password = 'E2eTest!2345'
  const reg = await api('', 'POST', '/auth/register', { email, password, first_name: `User${tag}`, last_name: 'Test', default_currency: 'PHP' })
  if (reg.status !== 200 && reg.status !== 201) throw new Error(`register ${reg.status} ${JSON.stringify(reg.json)}`)
  stack.verifyUser(email) // aborts the run unless psql reports UPDATE 1
  const login = await api('', 'POST', '/auth/login', { email, password })
  if (login.status !== 200) throw new Error(`login ${login.status}`)
  return { email, password, tag, token: login.json.access_token }
}
const account = (u, name, balance = 100000) =>
  post(u.token, '/accounts/', { name, account_type: 'checking', balance, currency: 'PHP' })
/** A PHP card closing on `cycleDay`, due `due` days later, paid from `bank`. */
const card = (u, bank, name, cycleDay, due) => post(u.token, '/accounts/', {
  name, account_type: 'credit', balance: 0, currency: 'PHP', credit_limit: 100000,
  billing_cycle_start: cycleDay, days_until_due_date: due, payment_account_id: bank.id,
})
const entry = (u, fields) => post(u.token, '/budget-entries/', { entry_type: 'expense', currency: 'PHP', cadence: 'monthly', ...fields })
const loanOf = (u, name, first) => post(u.token, '/accounts/', {
  name, account_type: 'loan', loan_kind: 'auto', balance: -100000, currency: 'PHP',
  loan_annual_rate: 12, loan_term_months: 24, loan_payment_amount: 5000, loan_first_payment_date: first,
})
const optionsOf = (u, id, day, chosen) => get(u.token, `/budget-entries/${id}/occurrences/${day}/date-options?effective_date=${chosen}`)

/** A page with its request log: every PUT/DELETE on a date route, every cascade-undo, every date-options and entry PUT. */
async function newPage(browser, viewport = { width: 1280, height: 1400 }) {
  const ctx = await browser.newContext({ viewport, timezoneId: 'Asia/Manila' })
  const page = await ctx.newPage()
  const native = trackNativeDialogs(page)
  const log = []
  page.on('response', (r) => {
    const req = r.request()
    const path = new URL(r.url()).pathname
    let kind = null
    if (/\/(?:occurrences|loan-due-dates)\/[\d-]+\/date$/.test(path) && ['PUT', 'DELETE'].includes(req.method())) kind = 'date'
    else if (/\/date-options$/.test(path)) kind = 'options'
    else if (/\/cascade-undo$/.test(path)) kind = 'undo'
    else if (/\/budget-entries\/\d+$/.test(path) && req.method() !== 'GET') kind = 'entry'
    if (!kind) return
    const day = path.match(/\/(?:occurrences|loan-due-dates)\/([\d-]+)\//)?.[1] ?? null
    log.push({ kind, method: req.method(), day, status: r.status(), body: JSON.parse(req.postData() || '{}'), query: new URL(r.url()).search })
  })
  if (process.env.DEBUG) page.on('response', (r) => { if (r.url().includes('/api/v1/')) console.log(`    [net] ${r.request().method()} ${r.url().replace(API, '')} -> ${r.status()}`) })
  return { ctx, page, native, log }
}
const ofKind = (log, kind) => log.filter((l) => l.kind === kind)
async function uiLogin(page, u) {
  await page.goto(`${stack.webUrl}/login`)
  await page.locator('#email').fill(u.email)
  await page.locator('#password').fill(u.password)
  await page.getByRole('button', { name: 'Sign in', exact: true }).click()
  await page.waitForURL((url) => url.pathname === '/')
  await page.locator('[data-testid="payables"], [data-onboarding="upcoming-expenses"]').first().waitFor()
}
const settle = async (page) => { await page.waitForLoadState('networkidle'); await waitQuiet(page) }
async function openTransactions(page) {
  await page.goto(`${stack.webUrl}/transactions`)
  await page.locator('[data-testid="due-section"]').waitFor()
  await page.locator('[data-testid="due-count"]').filter({ hasNotText: '…' }).waitFor()
  await page.locator('[data-testid="due-upcoming-count"]').filter({ hasNotText: '…' }).waitFor()
  await settle(page)
}
const checkNoNative = (scenario, native) => check(`(${scenario}) no browser dialog fired`, native.count, 0)
const dialog = (page) => page.locator('[data-testid="force-date-dialog"]')
const choices = (page) => dialog(page).locator('[data-testid="date-choices"]')
const choice = (page, id) => dialog(page).locator(`[data-testid="date-choice-${id}"]`)
const choiceLines = async (page, id) => (await choice(page, id).locator('[data-testid="date-choice-line"]').allTextContents()).map((t) => t.trim())
const text = async (locator) => ((await locator.textContent()) ?? '').replace(/\s+/g, ' ').trim()

const missedRowOf = (page, entryId) => page.locator(`[data-testid="due-row"][data-kind="missed"][data-source="budget_entry:${entryId}"]`)
const changeButtonOf = (page, entryId) => missedRowOf(page, entryId).locator('[data-testid="row-change-date"]')
/** The entry's missed rows on the Due tab, over every page. */
const missedCount = async (page, name) => (await rowsOf(page, name)).filter((r) => r.kind === 'missed').length
/** The Upcoming tab's occurrence rows of an entry, by scheduled day. */
const upcomingRow = async (page, entryId, day, slug = 'upcoming') => {
  await openDueTab(page, slug)
  return showRow(page, page.locator(`[data-testid="due-row"][data-kind="occurrence"][data-source="budget_entry:${entryId}"][data-day="${day}"]`))
}
const dateText = (row) => row.locator('[data-testid="upcoming-occurrence-date"]').textContent().then((t) => t?.trim())
const missedOf = async (u, entryId) => {
  const snap = await get(u.token, '/dashboard/snapshot')
  return [...snap.missed, ...snap.card_charges.flatMap((c) => c.missed)].find((m) => m.entry_id === entryId) ?? null
}

/** Opens the missed row's Change date, fills `day` and saves; resolves when the refused PUT came back. */
async function refuseFromMissed(page, entryId, day, log) {
  await showRow(page, missedRowOf(page, entryId))
  await changeButtonOf(page, entryId).click()
  await dialog(page).waitFor({ timeout: 10000 })
  await waitQuiet(page)
  return fillAndSave(page, day, log)
}
async function fillAndSave(page, day, log) {
  await dialog(page).locator('[data-testid="force-date-input"]').fill(day)
  const before = ofKind(log, 'date').length
  const answered = page.waitForResponse((r) => r.request().method() === 'PUT' && /\/date$/.test(new URL(r.url()).pathname))
  await dialog(page).locator('[data-testid="force-date-save"]').click()
  await answered
  return before
}

/** A monthly payment missed once: its day, the next payment a month on (in the future) and a day past it. */
function missedMonth(today) {
  const d0 = pastDay(today, 18, 25, 24)
  const d1 = addMonths(d0, 1)
  return { d0, d1, past: addDays(d1, 2) }
}
const seedMissed = async (u, name) => {
  const bank = await account(u, `${name} Checking`)
  const days = missedMonth(manilaToday())
  const sub = await entry(u, { name: `${name} Netflix`, amount: 549, account_id: bank.id, next_occurrence: wire(days.d0) })
  return { bank, sub, ...days }
}

// (a) Pay together.
async function payTogether(browser) {
  console.log('\n=== (a) a refused date on the next payment\'s day offers both choices; Pay together joins it')
  const today = manilaToday()
  const u = await makeUser('a')
  const { sub, d0, d1 } = await seedMissed(u, 'A')
  const control = await api(u.token, 'PUT', `/budget-entries/${sub.id}/occurrences/${d0}/date`, { effective_date: d1 })
  check('(a) control: the strict PUT refuses the next payment\'s day with a plain-text reason', [control.status, typeof control.json.detail], [422, 'string'])
  const { ctx, page, native, log } = await newPage(browser)
  await uiLogin(page, u)
  await openTransactions(page)
  check('(a) the oldest payment is a missed row', await missedCount(page, 'A Netflix'), 1)

  const before = await refuseFromMissed(page, sub.id, d1, log)
  check('(a) the save was a strict PUT with no mode, and refused', ofKind(log, 'date').slice(before).map((l) => [l.day, l.body, l.status]), [[d0, { effective_date: d1 }, 422]])
  await choices(page).waitFor()
  check('(a) the dialog keeps the server\'s reason inline', [await text(dialog(page).locator('[data-testid="force-date-error"]')), await dialog(page).count()], [control.json.detail, 1])
  check('(a) it asked for the choices of the day it saved, once', ofKind(log, 'options').map((l) => [l.status, l.query]), [[200, `?effective_date=${d1}`]])
  check('(a) both choices are on offer', await Promise.all(['overlap', 'cascade'].map((id) => choice(page, id).getAttribute('data-available'))), ['true', 'true'])
  check('(a) Pay together previews both payments on that day', [await text(choice(page, 'overlap').locator('p').first()), await choiceLines(page, 'overlap')], [`Pay together on ${fmt(d1)}`, [`${fmt(d0)} → ${fmt(d1)} · ₱549.00`, `${fmt(d1)} · ₱549.00`]])
  check('(a) and their total, with no note while the day is the one asked for', [await text(choice(page, 'overlap').locator('[data-testid="date-choice-total"]')), await choice(page, 'overlap').locator('[data-testid="date-choice-note"]').count()], [`Total on ${fmt(d1)}: ₱1,098.00`, 0])
  check('(a) Delay all previews its moves', (await choiceLines(page, 'cascade')).slice(0, 1), [`${fmt(d0)} → ${fmt(d1)}`])

  const sent = ofKind(log, 'date').length
  await choice(page, 'overlap').locator('[data-testid="date-choice-overlap-button"]').click()
  await dialog(page).waitFor({ state: 'detached' })
  await settle(page)
  check('(a) Pay together sent one PUT for the missed day with mode overlap on the next payment\'s day', ofKind(log, 'date').slice(sent).map((l) => [l.method, l.day, l.body, l.status]), [['PUT', d0, { effective_date: d1, mode: 'overlap' }, 200]])
  check('(a) the missed row is gone', await missedCount(page, 'A Netflix'), 0)
  const first = await upcomingRow(page, sub.id, d0)
  const second = await upcomingRow(page, sub.id, d1)
  check('(a) two Upcoming rows read that day', [await dateText(first), await dateText(second)], [moved(d1, d0), fmt(d1)])
  const listed = (await get(u.token, `/budget-entries/${sub.id}/occurrences`)).occurrences.filter((o) => [d0, d1].includes(o.occurrence_date)).map((o) => [o.occurrence_date, o.effective_date ?? o.occurrence_date])
  check('(a) the API agrees: two payments on that day', listed, [[d0, d1], [d1, d1]])
  check('(a) the day is after today', d1 > today, true)
  checkNoNative('a', native)
  await ctx.close()
}

/** Seeds a missed monthly payment, refuses a date past the next payment and returns the open page. */
async function pastNextPayment(browser, tag) {
  const u = await makeUser(tag)
  const seed = await seedMissed(u, tag.toUpperCase())
  const opened = await newPage(browser)
  await uiLogin(opened.page, u)
  await openTransactions(opened.page)
  const before = await refuseFromMissed(opened.page, seed.sub.id, seed.past, opened.log)
  await choices(opened.page).waitFor()
  return { u, ...seed, ...opened, before }
}
const delayedDays = (past) => [past, addMonths(past, 1), addMonths(past, 2)]

// (b) Delay all.
async function delayAll(browser) {
  console.log('\n=== (b) a date past the next payment: Delay all moves this and every later payment')
  const { u, sub, d0, d1, past, ctx, page, native, log, before } = await pastNextPayment(browser, 'b')
  const control = await api(u.token, 'PUT', `/budget-entries/${sub.id}/occurrences/${d0}/date`, { effective_date: past })
  check('(b) control: the strict PUT refuses a date past the next payment', control.status, 422)
  check('(b) the save was refused', ofKind(log, 'date').slice(before).map((l) => l.status), [422])
  check('(b) Pay together says it is the closest day it can join the next payment', await text(choice(page, 'overlap').locator('[data-testid="date-choice-note"]')), `(${fmt(past)} is past the next payment; this is the closest day it can join it)`)
  const [m0, m1, m2] = delayedDays(past)
  const olds = [d0, d1, addMonths(d0, 2)]
  check('(b) Delay all previews the first moves and the repeat', await choiceLines(page, 'cascade'), [
    `${fmt(olds[0])} → ${fmt(m0)}`, `${fmt(olds[1])} → ${fmt(m1)}`, `${fmt(olds[2])} → ${fmt(m2)}`,
    `…and every later one on the ${ordinal(dom(past))}`,
  ])
  const sent = ofKind(log, 'date').length
  await choice(page, 'cascade').locator('[data-testid="date-choice-cascade-button"]').click()
  const confirmation = dialog(page).locator('[data-testid="force-date-cascade-confirmation"]')
  await confirmation.waitFor()
  check('(b) Delay all sent one PUT for the missed day with mode cascade on the chosen date', ofKind(log, 'date').slice(sent).map((l) => [l.method, l.day, l.body, l.status]), [['PUT', d0, { effective_date: past, mode: 'cascade' }, 200]])
  check('(b) the dialog stays open and confirms the move', [await dialog(page).count(), await text(confirmation)], [1, `Moved to ${fmt(past)}. Later payments follow on the ${ordinal(dom(past))}.`])
  check('(b) it offers Undo and Done', [await dialog(page).locator('[data-testid="force-date-undo"]').count(), await dialog(page).locator('[data-testid="force-date-done"]').count()], [1, 1])
  check('(b) the choices and the date field are gone', [await choices(page).count(), await dialog(page).locator('[data-testid="force-date-input"]').count()], [0, 0])

  const requests = log.length
  await dialog(page).locator('[data-testid="force-date-done"]').click()
  await dialog(page).waitFor({ state: 'detached' })
  await settle(page)
  check('(b) Done sent nothing', log.length, requests)
  check('(b) the missed row is gone', await missedCount(page, 'B Netflix'), 0)
  const row = await upcomingRow(page, sub.id, m0)
  check('(b) Upcoming shows the payment on the new date, no longer "moved"', [await row.count(), await dateText(row)], [1, fmt(m0)])
  const schedule = await get(u.token, `/budget-entries/${sub.id}`)
  check('(b) the API moved the schedule to the chosen date', schedule.next_occurrence.slice(0, 10), m0)
  checkNoNative('b', native)
  await ctx.close()
}

// (c) Undo.
async function undoDelay(browser) {
  console.log('\n=== (c) Undo puts the schedule back through cascade-undo')
  const { u, sub, d0, past, ctx, page, native, log } = await pastNextPayment(browser, 'c')
  await choice(page, 'cascade').locator('[data-testid="date-choice-cascade-button"]').click()
  await dialog(page).locator('[data-testid="force-date-cascade-confirmation"]').waitFor()
  await settle(page)
  check('(c) the cascade moved the schedule and the missed row left', [(await get(u.token, `/budget-entries/${sub.id}`)).next_occurrence.slice(0, 10), await missedOf(u, sub.id)], [past, null])

  const reply = log.filter((l) => l.kind === 'date').slice(-1)[0]
  check('(c) setup: the cascade was applied by a PUT', [reply.body.mode, reply.status], ['cascade', 200])
  const entryPuts = ofKind(log, 'entry').length
  await dialog(page).locator('[data-testid="force-date-undo"]').click()
  await dialog(page).waitFor({ state: 'detached' })
  await settle(page)
  const undos = ofKind(log, 'undo')
  check('(c) Undo sent one POST to cascade-undo with the token the cascade replied with', [undos.length, undos[0]?.method, undos[0]?.status, Object.keys(undos[0]?.body ?? {}), typeof undos[0]?.body?.undo_token], [1, 'POST', 200, ['undo_token'], 'string'])
  check('(c) and no PUT to the entry', ofKind(log, 'entry').length - entryPuts, 0)
  check('(c) the missed row returns', await missedCount(page, 'C Netflix'), 1)
  const restored = await get(u.token, `/budget-entries/${sub.id}`)
  const missed = await missedOf(u, sub.id)
  check('(c) the API has the old schedule and the missed payment back', [restored.next_occurrence.slice(0, 10), missed?.unlinked_count, missed?.oldest_unlinked], [d0, 1, d0])
  checkNoNative('c', native)
  await ctx.close()
}

// (d) No choice: a closed statement, and a loan.
async function noChoice(browser) {
  console.log('\n=== (d) with no choice available only the error shows; a loan never shows choices')
  const today = manilaToday()
  const u = await makeUser('d')
  const bank = await account(u, 'D Checking')
  const cycleDay = Math.min(28, dom(addDays(today, -3)))
  const visa = await card(u, bank, 'D Visa', cycleDay, 21)
  const day = addDays(today, 2)
  const inClosed = addDays(today, -10)
  const spotify = await entry(u, { name: 'D Spotify', amount: 500, account_id: visa.id, next_occurrence: wire(day), end_mode: 'on_date', end_date: wire(day) })
  const refused = await api(u.token, 'PUT', `/budget-entries/${spotify.id}/occurrences/${day}/date`, { effective_date: inClosed })
  const probe = await optionsOf(u, spotify.id, day, inClosed)
  check('(d) control: the API refuses a date in a closed statement for the last payment (no next payment to join) and offers neither choice', [refused.status, probe.overlap.available, probe.cascade.available], [422, false, false])
  await loanOf(u, 'D Car loan', addDays(today, 5))
  const { ctx, page, native, log } = await newPage(browser)
  await uiLogin(page, u)
  await openTransactions(page)
  const row = await upcomingRow(page, spotify.id, day)
  await row.locator('[data-testid="occurrence-change-date"]').click()
  await dialog(page).waitFor({ timeout: 10000 })
  await waitQuiet(page)
  await fillAndSave(page, inClosed, log)
  const error = dialog(page).locator('[data-testid="force-date-error"]')
  await error.waitFor()
  await settle(page)
  check('(d) the dialog shows the server\'s reason and stays open', [await text(error), await dialog(page).count()], [refused.json.detail, 1])
  check('(d) it asked once and found neither choice', ofKind(log, 'options').map((l) => l.status), [200])
  check('(d) so no choice shows', await choices(page).count(), 0)
  check('(d) Save is still there for another date', await dialog(page).locator('[data-testid="force-date-save"]').count(), 1)
  await page.keyboard.press('Escape')
  await dialog(page).waitFor({ state: 'detached' })

  const asked = ofKind(log, 'options').length
  await page.goto(`${stack.webUrl}/accounts`)
  await page.locator('article').first().waitFor()
  await settle(page)
  await page.locator('article').filter({ has: page.getByText('D Car loan', { exact: true }) }).locator('[role="button"]').first().click()
  await page.locator('[data-testid="loan-due-dates"]').waitFor()
  await waitQuiet(page)
  const first = page.locator('[data-testid="loan-due-date"]').first()
  await first.locator('[data-testid="loan-change-date"]').click()
  await dialog(page).waitFor({ timeout: 10000 })
  await waitQuiet(page)
  const dayOfLoan = await first.getAttribute('data-day')
  await fillAndSave(page, addDays(dayOfLoan, 40), log)
  await error.waitFor()
  await settle(page)
  check('(d) a loan\'s refusal shows its reason', ((await text(error)) !== ''), true)
  check('(d) and no choice shows, and no choices were asked for', [await choices(page).count(), ofKind(log, 'options').length - asked], [0, 0])
  check('(d) the loan id is the account\'s (the PUT went to the loan route)', ofKind(log, 'date').slice(-1)[0].status, 422)
  checkNoNative('d', native)
  await ctx.close()
}

// (e) A card subscription.
async function cardChoices(browser) {
  console.log('\n=== (e) a card subscription: statement lines, and the statement total moves after Delay all')
  const today = manilaToday()
  const u = await makeUser('e')
  const bank = await account(u, 'E Checking')
  const cycleDay = Math.min(28, dom(addDays(today, 12)))
  const visa = await card(u, bank, 'E Visa', cycleDay, 5)
  const day = futureDay(today, 2, 9, 24)
  const next = addMonths(day, 1)
  const chosen = addDays(next, 2)
  const spotify = await entry(u, { name: 'E Spotify', amount: 500, account_id: visa.id, next_occurrence: wire(day) })
  await post(u.token, '/transactions/', { account_id: visa.id, transaction_type: 'debit', amount: 1000, description: 'E Lunch', transaction_date: wire(today), is_posted: true })
  const probe = await optionsOf(u, spotify.id, day, chosen)
  const close = (d) => ` · statement closing ${fmt(d)}`
  check('(e) control: the API previews statement closes for both choices', [probe.overlap.statement_close !== null, probe.cascade.moves.every((m) => m.statement_close !== null)], [true, true])
  const { ctx, page, native, log } = await newPage(browser)
  await uiLogin(page, u)
  const rows = () => page.locator('[data-testid="payable-row"]').filter({ hasText: 'E Visa' })
  const amountOf = async () => (await rows().locator('[data-testid="payable-amount"]').first().textContent().catch(() => null))?.replace(/[^0-9.]/g, '') ?? null
  check('(e) before: the statement\'s payable totals the lunch and the subscription', await amountOf(), '1500.00')
  await openTransactions(page)
  const row = await upcomingRow(page, spotify.id, day, 'subscriptions')
  await row.locator('[data-testid="occurrence-change-date"]').click()
  await dialog(page).waitFor({ timeout: 10000 })
  await waitQuiet(page)
  await fillAndSave(page, chosen, log)
  await choices(page).waitFor()
  check('(e) Pay together\'s lines carry the statement it lands on', await choiceLines(page, 'overlap'), [
    `${fmt(day)} → ${fmt(next)} · ₱500.00${close(probe.overlap.statement_close)}`,
    `${fmt(next)} · ₱500.00${close(probe.overlap.statement_close)}`,
  ])
  check('(e) Delay all\'s moves carry theirs', (await choiceLines(page, 'cascade')).slice(0, probe.cascade.moves.length), probe.cascade.moves.map((m) => `${fmt(m.from)} → ${fmt(m.to)}${close(m.statement_close)}`))
  const sent = ofKind(log, 'date').length
  await choice(page, 'cascade').locator('[data-testid="date-choice-cascade-button"]').click()
  const confirmation = dialog(page).locator('[data-testid="force-date-cascade-confirmation"]')
  await confirmation.waitFor()
  check('(e) Delay all was sent on the chosen date', ofKind(log, 'date').slice(sent).map((l) => [l.body, l.status]), [[{ effective_date: chosen, mode: 'cascade' }, 200]])
  const said = await text(confirmation)
  check('(e) the confirmation names the move and the statement it now falls on', [said.startsWith(`Moved to ${fmt(chosen)}.`), /Now on the statement closing [A-Z][a-z]{2} \d+(st|nd|rd|th), \d{4}$/.test(said)], [true, true])
  await dialog(page).locator('[data-testid="force-date-done"]').click()
  await dialog(page).waitFor({ state: 'detached' })
  await settle(page)
  await page.goto(`${stack.webUrl}/`)
  await page.locator('[data-testid="payables"], [data-onboarding="upcoming-expenses"]').first().waitFor()
  await settle(page)
  check('(e) after: the statement\'s payable total no longer holds the subscription', await amountOf(), '1000.00')
  checkNoNative('e', native)
  await ctx.close()
}

// (f) An older API.
async function oldApi(browser) {
  console.log('\n=== (f) date-options answered 404, 405 or 422: only the original refusal shows')
  const u = await makeUser('f')
  const { sub, d0, d1 } = await seedMissed(u, 'F')
  const control = await api(u.token, 'PUT', `/budget-entries/${sub.id}/occurrences/${d0}/date`, { effective_date: d1 })
  const { ctx, page, native, log } = await newPage(browser)
  let status = 404
  let hits = 0
  await page.route('**/date-options*', (route) => {
    hits += 1
    return route.fulfill({ status, contentType: 'application/json', body: JSON.stringify({ detail: 'Not Found' }) })
  })
  await uiLogin(page, u)
  await openTransactions(page)
  for (const answer of [404, 405, 422]) {
    status = answer
    hits = 0
    const before = await refuseFromMissed(page, sub.id, d1, log)
    const error = dialog(page).locator('[data-testid="force-date-error"]')
    await error.waitFor()
    await settle(page)
    check(`(f) ${answer}: the strict PUT was refused and the options were asked for once`, [ofKind(log, 'date').slice(before).map((l) => l.status), hits], [[422], 1])
    check(`(f) ${answer}: only the original refusal shows, no choices`, [await text(error), await choices(page).count(), await dialog(page).count()], [control.json.detail, 0, 1])
    await page.keyboard.press('Escape')
    await dialog(page).waitFor({ state: 'detached' })
  }
  check('(f) nothing was changed', (await missedOf(u, sub.id))?.oldest_unlinked, d0)
  checkNoNative('f', native)
  await ctx.close()
}

// (g) Phone width.
async function phoneWidth(browser) {
  console.log('\n=== (g) at 390px the choices stack, buttons are 44px and nothing scrolls sideways')
  const u = await makeUser('g')
  const { sub, past } = await seedMissed(u, 'G')
  const { ctx, page, native, log } = await newPage(browser, { width: 390, height: 844 })
  await uiLogin(page, u)
  await openTransactions(page)
  await refuseFromMissed(page, sub.id, past, log)
  await choices(page).waitFor()
  const box = async (locator) => locator.boundingBox()
  const a = await box(choice(page, 'overlap'))
  const b = await box(choice(page, 'cascade'))
  check('(g) the choices stack: one above the other, the same left edge and width', [b.y >= a.y + a.height, Math.abs(a.x - b.x) < 1, Math.abs(a.width - b.width) < 1], [true, true, true])
  const buttons = [await box(choice(page, 'overlap').locator('button')), await box(choice(page, 'cascade').locator('button'))]
  check('(g) each button is at least 44px tall', buttons.map((x) => x.height >= 44), [true, true])
  check('(g) each fits inside the screen', [a, b, ...buttons].every((x) => x.x >= 0 && x.x + x.width <= 390), true)
  check('(g) the page and the dialog do not scroll sideways', await page.evaluate(() => {
    const dlg = document.querySelector('[data-testid="force-date-dialog"]')
    return [document.documentElement.scrollWidth <= document.documentElement.clientWidth, dlg.scrollWidth <= dlg.clientWidth]
  }), [true, true])
  const moves = await choiceLines(page, 'cascade')
  check('(g) the previews are there', moves.length >= 2, true)
  checkNoNative('g', native)
  await ctx.close()
}

;(async () => {
  stack = await startLocalStack()
  API = `${stack.apiUrl}/api/v1`
  const browser = await chromium.launch()
  const run = (k) => !only || only === k
  const steps = { a: payTogether, b: delayAll, c: undoDelay, d: noChoice, e: cardChoices, f: oldApi, g: phoneWidth }
  for (const [k, fn] of Object.entries(steps)) if (run(k)) await fn(browser)
  await browser.close()
  stack.stop()
  console.log(`\nRESULT: ${pass}/${total} assertions passed`)
  process.exit(pass === total ? 0 : 1)
})().catch((e) => { console.error(e); stack?.stop(); console.log(`\nRESULT (aborted): ${pass}/${total} assertions passed`); process.exit(1) })
