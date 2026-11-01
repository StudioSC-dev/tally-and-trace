// Browser check for STU-474: several clean card installments are reviewed at once from
// the review notice on Transactions ("Due and overdue"). Starts its own API and web app
// against a throwaway database (./_local_stack.cjs). PHP only. Not wired into CI and not
// part of `pnpm build`. Run steps: see ./README.md.
//
// A "clean" installment is unreviewed with no month to record, so its review asks
// nothing. The script makes one by creating an installment from tomorrow and then
// clearing its review flags with psql, as the migration left the owner's older entries.
// Every expected figure is read from the API; dates are relative to Manila's today.
//
// Scenarios:
//   (a) the owner's case: 3 clean entries and 1 backdated entry with missed months. The
//       notice says 4; 3 checkboxes are enabled and the 4th is disabled with its reason
//       visible and linked by aria-describedby, and its Review button still opens the
//       dialog. Select all ticks 3 ("Review selected (3)"); Cancel in the confirm sends
//       nothing; Confirm shows "3 installments will start auto-posting." and sends one
//       review-installments POST with 3 items; the result reads "Auto-post is on for 3
//       installments"; the notice says 1; the API shows the 3 reviewed and on with the
//       card's transaction count unchanged; one snapshot request follows the POST
//   (b) stale: tick 2, rename one through the API, then confirm: one is reviewed and one
//       failure names the renamed entry; its row comes back enabled with a fresh binding,
//       and ticking it and confirming reviews it
//   (c) no longer clean: tick a posted-linked clean entry, delete its linked row through
//       the API, then confirm: a failure, nothing recorded, and after the refetch the row
//       is disabled with its reason
//   (d) the last rows reviewed: the notice unmounts and the result line is still shown
//   (e) roles: an editor ticks and reviews the owner's clean entry; a viewer sees no
//       notice and no checkboxes
//   (f) request failure: the POST is fulfilled with a 500; the confirm stays open with the
//       error, the screen loader clears, and Cancel keeps the selection and changes nothing
//   (g) the cap: 51 clean entries. Select all gives "Review selected (50)" and ticks the 50
//       lowest ids; the 51st checkbox is disabled and the visible limit line names it by
//       aria-describedby; Confirm sends one POST of exactly 50 distinct items with no 422;
//       afterwards the notice lists 1, with its checkbox enabled
//
// Every scenario tracks native dialogs (none may fire) and every request-starting action
// is followed by waitQuiet(page); see ./README.md.
//
// Usage: node frontend/e2e/installment-review-batch.cjs [a|b|c|d|e|f|g]
const { startLocalStack, consumePageOpen } = require('./_local_stack.cjs')
const { overlayPhase, sleep, waitQuiet } = require('./_smooth.cjs')
const dialogs = require('./_dialogs.cjs')

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
/** The shape _dialogs.cjs expects: h.check(name, kind, fn) where fn returns true or a failure text. */
const harness = {
  check: async (what, _kind, fn) => {
    const r = await fn()
    check(what, r === true ? true : r, true)
  },
}

const manilaToday = () => new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10)
const addDays = (day, n) => {
  const d = new Date(`${day}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().slice(0, 10)
}
const dom = (day) => Number(day.slice(8, 10))
const wire = (day) => `${day}T00:00:00`
/** About 65 days back, on a day of the month no later than the 28th: three months are missed. */
const backdatedStart = () => {
  const day = addDays(manilaToday(), -65)
  return dom(day) > 28 ? `${day.slice(0, 8)}28` : day
}
/** About 10 days back, on a day no later than the 28th: exactly one month is due. */
const recentStart = () => {
  const day = addDays(manilaToday(), -10)
  return dom(day) > 28 ? `${day.slice(0, 8)}28` : day
}

let stack, API
async function api(token, method, url, body, headers = {}) {
  const res = await fetch(`${API}${url}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers },
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
  const email = `e2e-irb-${tag}-${Math.random().toString(16).slice(2, 8)}@example.com`
  const password = 'E2eTest!2345'
  const reg = await api('', 'POST', '/auth/register', { email, password, first_name: `User${tag}`, last_name: 'Test', default_currency: 'PHP' })
  if (reg.status !== 200 && reg.status !== 201) throw new Error(`register ${reg.status} ${JSON.stringify(reg.json)}`)
  stack.verifyUser(email)
  const login = await api('', 'POST', '/auth/login', { email, password })
  if (login.status !== 200) throw new Error(`login ${login.status}`)
  return { email, password, tag, token: login.json.access_token }
}
/** A user who will open Transactions: takes their page-open claim now, before any entry exists. */
async function makeOpener(tag) {
  const u = await makeUser(tag)
  await consumePageOpen(api, u)
  return u
}
async function makeCard(u, name) {
  const bank = await post(u.token, '/accounts/', { name: `${name} Checking`, account_type: 'checking', balance: 100000, currency: 'PHP' })
  const card = await post(u.token, '/accounts/', {
    name, account_type: 'credit', balance: 0, currency: 'PHP', credit_limit: 1000000,
    billing_cycle_start: 28, days_until_due_date: 21, payment_account_id: bank.id,
  })
  return { bank, card }
}
const installment = (u, card, name, amount, next, count) => post(u.token, '/budget-entries/', {
  entry_type: 'expense', currency: 'PHP', cadence: 'monthly', name, amount,
  account_id: card.id, next_occurrence: wire(next), end_mode: 'after_occurrences', max_occurrences: count,
})
const entryNow = (u, id) => get(u.token, `/budget-entries/${id}`)
const flags = (e) => ({ reviewed: e.installment_reviewed, on: e.auto_post_enabled })
const cardRows = async (u, card) => (await get(u.token, `/transactions/?account_ids=${card.id}&limit=1000`)).items

/** Clears the review flags, as the migration left older entries: unreviewed, off. */
function clearReview(ids) {
  if (ids.length === 0 || !ids.every(Number.isInteger)) throw new Error('unexpected entry ids')
  const out = stack.psql(`UPDATE budget_entries SET installment_reviewed_at = NULL, auto_post_enabled = false WHERE id IN (${ids.join(',')})`)
  if (out !== `UPDATE ${ids.length}`) throw new Error(`clearing the review flags reported "${out}"`)
}
/** A clean unreviewed installment: created from tomorrow, then its flags cleared. */
async function cleanEntry(u, card, name) {
  const e = await installment(u, card, name, 1500, addDays(manilaToday(), 1), 12)
  clearReview([e.id])
  return e
}
const snapshotRow = async (u, id) => (await get(u.token, '/dashboard/snapshot')).installment_review.find((r) => r.entry_id === id)

async function newPage(browser) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 1000 } })
  const page = await ctx.newPage()
  const native = dialogs.trackNativeDialogs(page)
  if (process.env.DEBUG) page.on('response', (r) => { if (r.url().includes('/api/v1/')) console.log(`    [net] ${r.request().method()} ${r.url().replace(API, '')} -> ${r.status()}`) })
  return { ctx, page, native }
}
async function uiLogin(page, u) {
  await page.goto(`${stack.webUrl}/login`)
  await page.locator('#email').fill(u.email)
  await page.locator('#password').fill(u.password)
  await page.getByRole('button', { name: 'Sign in', exact: true }).click()
  await page.waitForURL((url) => url.pathname === '/')
  await waitQuiet(page)
}
async function openTransactions(page) {
  await page.goto(`${stack.webUrl}/transactions`)
  await page.locator('[data-testid="due-section"]').waitFor()
  await page.locator('[data-testid="due-count"]').filter({ hasNotText: '…' }).waitFor()
  await waitQuiet(page)
}

const text = async (locator) => (await locator.textContent())?.replace(/\s+/g, ' ').trim()
const testId = (page, id) => page.locator(`[data-testid="${id}"]`)
const noticeRow = (page, id) => page.locator(`[data-testid="due-review-notice-entry"][data-source="budget_entry:${id}"]`)
const tick = (page, id) => noticeRow(page, id).locator('[data-testid="due-review-notice-select"]')
const selectedButton = (page) => testId(page, 'due-review-selected')
const failures = (page) => testId(page, 'due-review-batch-failure')

async function waitCount(locator, n, ms = 15000) {
  const until = Date.now() + ms
  for (;;) {
    const count = await locator.count()
    if (count === n || Date.now() > until) return count
    await sleep(250)
  }
}
/** Counts the batch POSTs (with their items) and the snapshot GETs a page sends. */
function trackRequests(page) {
  const s = { posts: [], snapshots: 0 }
  page.on('request', (r) => {
    const url = r.url()
    if (r.method() === 'POST' && url.endsWith('/budget-entries/review-installments')) s.posts.push(JSON.parse(r.postData() || '{}'))
    if (r.method() === 'GET' && url.includes('/dashboard/snapshot')) s.snapshots++
  })
  return s
}
async function openNotice(page) {
  const toggle = testId(page, 'due-review-notice-toggle')
  await toggle.waitFor()
  if ((await toggle.getAttribute('aria-expanded')) !== 'true') await toggle.click()
  await testId(page, 'due-review-notice-list').waitFor()
  await waitQuiet(page)
}
/** Which of the given ids are ticked. */
async function tickedIds(page, ids) {
  const out = []
  for (const id of ids) if (await tick(page, id).isChecked()) out.push(id)
  return out
}
/** Opens the batch confirm and accepts it; returns once the confirm has closed. */
async function confirmBatch(page) {
  const cd = dialogs.confirmDialog(page)
  await waitQuiet(page)
  await selectedButton(page).click()
  await cd.dialog.waitFor()
  await cd.accept.click()
  await waitCount(cd.dialog, 0)
  await waitQuiet(page)
}

// ─── (a) the owner's case ────────────────────────────────────────────────────
async function ownersCase(browser) {
  console.log('(a) three clean installments are reviewed together; a fourth with missed months is not')
  const me = await makeOpener('a')
  const { card } = await makeCard(me, 'Visa A')
  const clean = [await cleanEntry(me, card, 'Laptop'), await cleanEntry(me, card, 'Phone'), await cleanEntry(me, card, 'Tablet')]
  const missed = await installment(me, card, 'Sofa', 2200, backdatedStart(), 12)
  const ids = clean.map((e) => e.id)
  const before = await cardRows(me, card)
  const row = await snapshotRow(me, missed.id)
  check('(a) the API gives the missed entry no binding and the clean ones a token',
    [row.clean_review, row.missed_count, (await Promise.all(ids.map((id) => snapshotRow(me, id)))).every((r) => r.clean_review !== null && r.missed_count === 0)], [null, 3, true])

  const { ctx, page, native } = await newPage(browser)
  const reqs = trackRequests(page)
  const cd = dialogs.confirmDialog(page)
  await uiLogin(page, me)
  await openTransactions(page)
  check('(a) the notice counts four', await text(testId(page, 'due-review-notice-toggle')), '4 card installments don\'t auto-post yet')
  await openNotice(page)
  check('(a) three checkboxes are enabled', await Promise.all(ids.map((id) => tick(page, id).isEnabled())), [true, true, true])
  const blocked = tick(page, missed.id)
  check('(a) the fourth is disabled', await blocked.isDisabled(), true)
  const reason = noticeRow(page, missed.id).locator('[data-testid="due-review-notice-reason"]')
  check('(a) its reason is visible', [await reason.isVisible(), await text(reason)], [true, '3 missed months to record · review it on its own'])
  const describedBy = await blocked.getAttribute('aria-describedby')
  check('(a) aria-describedby points at the reason', [describedBy, await reason.getAttribute('id')], [describedBy, describedBy])
  check('(a) the reason is the described text', describedBy ? await page.evaluate((id) => document.getElementById(id)?.textContent ?? null, describedBy) : null, '3 missed months to record · review it on its own')
  check('(a) the clean rows show no reason', await noticeRow(page, ids[0]).locator('[data-testid="due-review-notice-reason"]').count(), 0)
  await noticeRow(page, missed.id).locator('[data-testid="due-review-notice-review"]').click()
  await testId(page, 'installment-review-dialog').waitFor()
  await waitQuiet(page)
  check('(a) its Review button opens the dialog', await text(testId(page, 'installment-review-title')), 'Turn on auto-post for Sofa (Visa A)')
  await testId(page, 'installment-review-dialog').getByRole('button', { name: 'Close' }).click()
  check('(a) the dialog closed', await waitCount(testId(page, 'installment-review-dialog'), 0), 0)
  await waitQuiet(page)

  check('(a) nothing is ticked and the button is off', [await tickedIds(page, ids), await selectedButton(page).isDisabled(), await text(selectedButton(page))], [[], true, 'Review selected (0)'])
  await testId(page, 'due-review-notice-select-all').click()
  check('(a) Select all ticks the three clean rows', [await tickedIds(page, ids), await blocked.isChecked()], [ids, false])
  check('(a) the button reads (3)', [await text(selectedButton(page)), await selectedButton(page).isEnabled()], ['Review selected (3)', true])

  await selectedButton(page).click()
  await cd.dialog.waitFor()
  check('(a) the confirm asks', [await text(cd.title), await text(cd.message), await text(cd.accept)], ['Turn on auto-post', '3 installments will start auto-posting.', 'Turn on auto-post'])
  await cd.cancel.click()
  await waitCount(cd.dialog, 0)
  await sleep(500)
  check('(a) Cancel sends nothing and keeps the ticks', [reqs.posts.length, await tickedIds(page, ids)], [0, ids])

  await waitQuiet(page)
  const snapsBefore = reqs.snapshots
  await selectedButton(page).click()
  await cd.dialog.waitFor()
  await cd.accept.click()
  await waitCount(cd.dialog, 0)
  await waitQuiet(page)
  await testId(page, 'due-review-batch-result').waitFor()
  await sleep(500)
  check('(a) exactly one POST of the three, in id order', [reqs.posts.length, reqs.posts[0]?.items.map((i) => i.entry_id)], [1, ids])
  check('(a) the result line', await text(testId(page, 'due-review-batch-result')), 'Auto-post is on for 3 installments')
  check('(a) no failure', await failures(page).count(), 0)
  check('(a) the notice now counts one', await text(testId(page, 'due-review-notice-toggle')), "1 card installment doesn't auto-post yet")
  check('(a) no clean row is left, so the header is gone and the missed row is not ticked', [await selectedButton(page).count(), await tick(page, missed.id).isChecked()], [0, false])
  const after = await Promise.all(ids.map((id) => entryNow(me, id)))
  check('(a) the API shows the three reviewed and on', after.map(flags), ids.map(() => ({ reviewed: true, on: true })))
  check('(a) the missed one is untouched', flags(await entryNow(me, missed.id)), { reviewed: false, on: false })
  check('(a) the card\'s transaction count is unchanged', (await cardRows(me, card)).length, before.length)
  check('(a) one snapshot request follows the POST', reqs.snapshots - snapsBefore, 1)
  await dialogs.checkNoNativeDialogs(harness, 'a', native)
  await ctx.close()
}

// ─── (b) one entry goes stale after the snapshot ─────────────────────────────
async function stale(browser) {
  console.log('(b) an entry renamed after the list loaded fails alone and can be ticked again')
  const me = await makeOpener('b')
  const { card } = await makeCard(me, 'Visa B')
  const one = await cleanEntry(me, card, 'Camera')
  const two = await cleanEntry(me, card, 'Printer')
  const { ctx, page, native } = await newPage(browser)
  const reqs = trackRequests(page)
  await uiLogin(page, me)
  await openTransactions(page)
  await openNotice(page)
  await tick(page, one.id).check()
  await tick(page, two.id).check()
  check('(b) two are ticked', await text(selectedButton(page)), 'Review selected (2)')
  const renamed = await api(me.token, 'PUT', `/budget-entries/${two.id}`, { name: 'Printer 2' })
  check('(b) the rename is accepted', renamed.status, 200)
  await confirmBatch(page)
  await testId(page, 'due-review-batch-result').waitFor()
  check('(b) one POST of two', [reqs.posts.length, reqs.posts[0]?.items.length], [1, 2])
  check('(b) one is reviewed', await text(testId(page, 'due-review-batch-result')), 'Auto-post is on for 1 installment')
  const failed = failures(page)
  check('(b) one failure names the entry as it was ticked', [await failed.count(), await failed.first().getAttribute('data-source'), await text(failed.first())],
    [1, `budget_entry:${two.id}`, 'Printer: changed since the list loaded; select it again or use Review'])
  check('(b) the API: the first is on, the renamed one is not', [flags(await entryNow(me, one.id)), flags(await entryNow(me, two.id))], [{ reviewed: true, on: true }, { reviewed: false, on: false }])
  await waitQuiet(page)
  check('(b) the renamed row is back, enabled and not ticked', [await noticeRow(page, two.id).count(), await tick(page, two.id).isEnabled(), await tick(page, two.id).isChecked()], [1, true, false])
  await tick(page, two.id).check()
  await confirmBatch(page)
  await testId(page, 'due-review-batch-result').filter({ hasText: 'Auto-post is on for 1 installment' }).waitFor()
  check('(b) the second run sent a fresh binding and it is reviewed', [reqs.posts.length, flags(await entryNow(me, two.id))], [2, { reviewed: true, on: true }])
  check('(b) the first run\'s failure is gone', await failures(page).count(), 0)
  await dialogs.checkNoNativeDialogs(harness, 'b', native)
  await ctx.close()
}

// ─── (c) an entry stops being clean ──────────────────────────────────────────
/** An unreviewed installment whose one due month is already linked to a posted row: clean, and its walk is not empty. */
async function postedLinkedClean(u, card, name) {
  const start = recentStart()
  const e = await installment(u, card, name, 2500, start, 12)
  const typed = await post(u.token, '/transactions/', {
    account_id: card.id, transaction_type: 'debit', amount: 2500, description: `${name} typed by hand`, transaction_date: wire(addDays(start, 1)), is_posted: true,
  })
  const review = await get(u.token, `/budget-entries/${e.id}/auto-post-review`)
  const candidate = review.candidates.find((c) => c.occurrence_date.slice(0, 10) === start)
  if (!candidate || !candidate.transactions.some((t) => t.id === typed.id)) throw new Error('the typed charge was not offered as a candidate')
  await post(u.token, `/budget-entries/${e.id}/auto-post-review`, {
    entry_version: review.entry_version, review_token: review.review_token, links: [{ transaction_id: typed.id, occurrence_date: candidate.occurrence_date }],
  })
  // Back to how an older entry stands: unreviewed, off, its next date on the linked month.
  const out = stack.psql(`UPDATE budget_entries SET installment_reviewed_at = NULL, auto_post_enabled = false, next_occurrence = '${start}T00:00:00+00', max_occurrences = 12 WHERE id = ${e.id}`)
  if (out !== 'UPDATE 1') throw new Error(`resetting the entry reported "${out}"`)
  return { entry: e, typed }
}
async function noLongerClean(browser) {
  console.log('(c) a clean entry that gets a missed month before the confirm fails and shows why')
  const me = await makeOpener('c')
  const { card } = await makeCard(me, 'Visa C')
  const { entry, typed } = await postedLinkedClean(me, card, 'Oven')
  const row = await snapshotRow(me, entry.id)
  check('(c) the API calls it clean', [row.missed_count, row.clean_review !== null], [0, true])
  const { ctx, page, native } = await newPage(browser)
  const reqs = trackRequests(page)
  await uiLogin(page, me)
  await openTransactions(page)
  await openNotice(page)
  check('(c) its checkbox is enabled', await tick(page, entry.id).isEnabled(), true)
  await tick(page, entry.id).check()
  const gone = await api(me.token, 'DELETE', `/transactions/${typed.id}`)
  check('(c) the linked row is deleted', gone.status < 300, true)
  const rowsBefore = (await cardRows(me, card)).length
  await confirmBatch(page)
  await failures(page).first().waitFor()
  check('(c) one POST and a failure naming the entry', [reqs.posts.length, await failures(page).count(), (await text(failures(page).first()))?.startsWith('Oven: ')], [1, 1, true])
  check('(c) no success line', await testId(page, 'due-review-batch-result').count(), 0)
  check('(c) nothing was recorded or turned on', [(await cardRows(me, card)).length, rowsBefore, flags(await entryNow(me, entry.id))], [rowsBefore, rowsBefore, { reviewed: false, on: false }])
  await waitQuiet(page)
  check('(c) after the refetch the row is disabled with its reason', [await tick(page, entry.id).isDisabled(), await text(noticeRow(page, entry.id).locator('[data-testid="due-review-notice-reason"]'))],
    [true, '1 missed month to record · review it on its own'])
  await dialogs.checkNoNativeDialogs(harness, 'c', native)
  await ctx.close()
}

// ─── (d) the last rows reviewed ──────────────────────────────────────────────
async function lastRows(browser) {
  console.log('(d) reviewing every row unmounts the notice and keeps the result')
  const me = await makeOpener('d')
  const { card } = await makeCard(me, 'Visa D')
  const entries = [await cleanEntry(me, card, 'Fridge'), await cleanEntry(me, card, 'Washer')]
  const { ctx, page, native } = await newPage(browser)
  await uiLogin(page, me)
  await openTransactions(page)
  await openNotice(page)
  await testId(page, 'due-review-notice-select-all').check()
  check('(d) both are ticked', await text(selectedButton(page)), 'Review selected (2)')
  await confirmBatch(page)
  await testId(page, 'due-review-batch-result').waitFor()
  check('(d) the notice is gone', await waitCount(testId(page, 'due-review-notice'), 0), 0)
  check('(d) the result line is still shown', await text(testId(page, 'due-review-batch-result')), 'Auto-post is on for 2 installments')
  check('(d) the API shows both on', (await Promise.all(entries.map((e) => entryNow(me, e.id)))).map(flags), entries.map(() => ({ reviewed: true, on: true })))
  await dialogs.checkNoNativeDialogs(harness, 'd', native)
  await ctx.close()
}

// ─── (e) roles ───────────────────────────────────────────────────────────────
async function roles(browser) {
  console.log('(e) an editor reviews the owner\'s clean entry; a viewer sees no notice')
  const owner = await makeOpener('e-owner')
  const editor = await makeOpener('e-editor')
  const viewer = await makeOpener('e-viewer')
  const { bank, card } = await makeCard(owner, 'Visa E')
  await post(owner.token, `/accounts/${card.id}/shares`, { email: editor.email, role: 'editor' })
  await post(owner.token, `/accounts/${card.id}/shares`, { email: viewer.email, role: 'viewer' })
  await post(owner.token, `/accounts/${bank.id}/shares`, { email: viewer.email, role: 'viewer' })
  const entry = await cleanEntry(owner, card, 'Desk')

  {
    const { ctx, page, native } = await newPage(browser)
    await uiLogin(page, viewer)
    await openTransactions(page)
    check('(e) viewer: no notice and no checkboxes', [await testId(page, 'due-review-notice').count(), await testId(page, 'due-review-notice-select').count(), await testId(page, 'due-review-selected').count()], [0, 0, 0])
    await dialogs.checkNoNativeDialogs(harness, 'e.viewer', native)
    await ctx.close()
  }

  const { ctx, page, native } = await newPage(browser)
  const reqs = trackRequests(page)
  await uiLogin(page, editor)
  await openTransactions(page)
  check('(e) editor: the notice', await text(testId(page, 'due-review-notice-toggle')), "1 card installment doesn't auto-post yet")
  await openNotice(page)
  await tick(page, entry.id).check()
  check('(e) editor: the button reads (1)', await text(selectedButton(page)), 'Review selected (1)')
  const cd = dialogs.confirmDialog(page)
  await waitQuiet(page)
  await selectedButton(page).click()
  await cd.dialog.waitFor()
  check('(e) editor: the confirm is singular', await text(cd.message), '1 installment will start auto-posting.')
  await cd.accept.click()
  await waitCount(cd.dialog, 0)
  await waitQuiet(page)
  await testId(page, 'due-review-batch-result').waitFor()
  check('(e) editor: the result line', await text(testId(page, 'due-review-batch-result')), 'Auto-post is on for 1 installment')
  check('(e) editor: one POST of one item', [reqs.posts.length, reqs.posts[0]?.items.map((i) => i.entry_id)], [1, [entry.id]])
  check('(e) the owner sees it reviewed and on', flags(await entryNow(owner, entry.id)), { reviewed: true, on: true })
  await dialogs.checkNoNativeDialogs(harness, 'e', native)
  await ctx.close()
}

// ─── (f) the request fails ───────────────────────────────────────────────────
async function requestFails(browser) {
  console.log('(f) a failed request keeps the confirm open with its error; Cancel changes nothing')
  const me = await makeOpener('f')
  const { card } = await makeCard(me, 'Visa F')
  const entries = [await cleanEntry(me, card, 'Bike'), await cleanEntry(me, card, 'Helmet')]
  const ids = entries.map((e) => e.id)
  const { ctx, page, native } = await newPage(browser)
  const reqs = trackRequests(page)
  await uiLogin(page, me)
  await openTransactions(page)
  await openNotice(page)
  await testId(page, 'due-review-notice-select-all').check()
  await page.route('**/budget-entries/review-installments', (route) =>
    route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ detail: 'Server exploded' }) }))
  const cd = dialogs.confirmDialog(page)
  await waitQuiet(page)
  await selectedButton(page).click()
  await cd.dialog.waitFor()
  await cd.accept.click()
  await cd.error.waitFor()
  await waitQuiet(page)
  check('(f) the confirm stays open with an error', [await cd.dialog.count(), ((await text(cd.error)) ?? '').length > 0], [1, true])
  check('(f) the screen loader has cleared', await overlayPhase(page), 'hidden')
  check('(f) one POST was sent', reqs.posts.length, 1)
  await cd.cancel.click()
  await waitCount(cd.dialog, 0)
  await waitQuiet(page)
  check('(f) Cancel closed it and kept the selection', [await cd.dialog.count(), await tickedIds(page, ids), await text(selectedButton(page))], [0, ids, 'Review selected (2)'])
  check('(f) no result is shown', [await testId(page, 'due-review-batch-result').count(), await failures(page).count()], [0, 0])
  check('(f) nothing changed', (await Promise.all(ids.map((id) => entryNow(me, id)))).map(flags), ids.map(() => ({ reviewed: false, on: false })))
  await dialogs.checkNoNativeDialogs(harness, 'f', native)
  await ctx.close()
}

// ─── (g) the cap ─────────────────────────────────────────────────────────────
async function cap(browser) {
  console.log('(g) 51 clean installments: 50 at a time')
  const me = await makeOpener('g')
  const { card } = await makeCard(me, 'Visa G')
  const tomorrow = addDays(manilaToday(), 1)
  const ids = []
  for (let i = 0; i < 51; i++) ids.push((await installment(me, card, `Plan ${String(i).padStart(2, '0')}`, 100, tomorrow, 12)).id)
  clearReview(ids)
  const sorted = [...ids].sort((x, y) => x - y)
  const first50 = sorted.slice(0, 50)
  const last = sorted[50]
  const { ctx, page, native } = await newPage(browser)
  const reqs = trackRequests(page)
  await uiLogin(page, me)
  await openTransactions(page)
  check('(g) the notice counts 51', await text(testId(page, 'due-review-notice-toggle')), "51 card installments don't auto-post yet")
  await openNotice(page)
  check('(g) the limit line is hidden before the cap', await testId(page, 'due-review-notice-limit').count(), 0)
  await testId(page, 'due-review-notice-select-all').click()
  check('(g) the button reads (50)', await text(selectedButton(page)), 'Review selected (50)')
  check('(g) the 50 lowest ids are ticked', [await tickedIds(page, first50).then((t) => t.length), await tick(page, last).isChecked()], [50, false])
  check('(g) the 51st checkbox is disabled', await tick(page, last).isDisabled(), true)
  const limit = testId(page, 'due-review-notice-limit')
  const describedBy = await tick(page, last).getAttribute('aria-describedby')
  check('(g) the limit line is visible and names it', [await limit.isVisible(), await text(limit), describedBy, await limit.getAttribute('id')],
    [true, 'Up to 50 at a time; review the rest after these', describedBy, describedBy])
  check('(g) Select all reads checked', await testId(page, 'due-review-notice-select-all').isChecked(), true)
  await confirmBatch(page)
  await testId(page, 'due-review-batch-result').waitFor()
  const items = reqs.posts[0]?.items.map((i) => i.entry_id) ?? []
  check('(g) one POST of exactly 50 distinct items', [reqs.posts.length, items.length, new Set(items).size, items], [1, 50, 50, first50])
  check('(g) the result line has no 422', [await text(testId(page, 'due-review-batch-result')), await failures(page).count()], ['Auto-post is on for 50 installments', 0])
  await waitQuiet(page)
  check('(g) the notice lists one', await text(testId(page, 'due-review-notice-toggle')), "1 card installment doesn't auto-post yet")
  check('(g) its checkbox is enabled and the limit line is gone', [await tick(page, last).isEnabled(), await testId(page, 'due-review-notice-limit').count()], [true, 0])
  check('(g) the API: 50 on, the last untouched', [(await Promise.all(first50.map((id) => entryNow(me, id)))).every((e) => e.installment_reviewed && e.auto_post_enabled), flags(await entryNow(me, last))],
    [true, { reviewed: false, on: false }])
  await dialogs.checkNoNativeDialogs(harness, 'g', native)
  await ctx.close()
}

;(async () => {
  stack = await startLocalStack()
  API = `${stack.apiUrl}/api/v1`
  const browser = await chromium.launch()
  const run = (k) => !only || only === k
  if (run('a')) await ownersCase(browser)
  if (run('b')) await stale(browser)
  if (run('c')) await noLongerClean(browser)
  if (run('d')) await lastRows(browser)
  if (run('e')) await roles(browser)
  if (run('f')) await requestFails(browser)
  if (run('g')) await cap(browser)
  await browser.close()
  stack.stop()
  console.log(`\nRESULT: ${pass}/${total} assertions passed`)
  process.exit(pass === total ? 0 : total === 0 ? 2 : 1)
})().catch((e) => { console.error(e); stack?.stop(); console.log(`\nRESULT (aborted): ${pass}/${total} assertions passed`); process.exit(1) })
