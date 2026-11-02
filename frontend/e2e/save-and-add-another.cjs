// Browser checks for STU-475 on Transactions: "Save and add another" in the Create
// Transaction dialog. (a) the happy path and the final primary save; (b) what is cleared
// and kept, including the recurring link, tags and posting date; (c) a transfer between
// currencies; (d) the screen loader stays off for the save and its refresh, and the submit
// buttons wait for that refresh; (d2) an unrelated request and a primary save still block,
// and a save made after the refresh sends fresh requests; (d3) the upcoming tail
// request, sent after an await, stays off the loader; (d4) a primary save's refetches
// still block; (e) a refused save and the inline errors; (f) Edit has no such button;
// (g) Cancel after a save; (h) a pending foreign currency does not ride into a posted
// entry; (h2) the form is locked while the POST is held; (i1, i2) Cancel, reopen, then
// the abandoned POST settles (success, failure); (j) closing the dialog mid-refresh hands
// the refresh back to the screen loader; (j2) closing it before the upcoming tail starts
// sends that tail loud; (k) a reopened dialog cannot save until an abandoned save and its
// refresh have settled.
// Starts its own API and web app against a throwaway database (./_local_stack.cjs) and
// seeds through the API. Not wired into CI and not part of `pnpm build`. Run steps: see
// ./README.md.
//
// Check kinds: [B] behavioural, [S] structural (a failed one makes the run invalid),
// [G] guard. The script ends with RESULT: k/m and exits 0 only when every check passed,
// 1 when any failed, 2 for setup.
//
// Phase-recording scenarios (d, d2, d3, d4, e, j, j2) go through `openWithPhaseRecorder`: the
// recorder is installed before login (`addInitScript` only reaches documents loaded after
// it), the history is reset once the page has settled, and an [S] `recorder-installed`
// check proves the instrumentation exists before any phase assertion.
//
// Usage: node frontend/e2e/save-and-add-another.cjs [scenario]
const { startLocalStack } = require('./_local_stack.cjs')
const h = require('./_smooth.cjs')
const d = require('./_dialogs.cjs')

const playwrightPath = process.env.PLAYWRIGHT_PATH || 'playwright'
let chromium
try {
  ;({ chromium } = require(playwrightPath))
} catch {
  console.error(`Cannot load Playwright from "${playwrightPath}". Set PLAYWRIGHT_PATH (see frontend/e2e/README.md).`)
  process.exit(2)
}

const only = process.argv[2]

let stack, client

// ─── Days ────────────────────────────────────────────────────────────────────
const today = () => new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10)
const addDays = (day, n) => {
  const date = new Date(`${day}T00:00:00Z`)
  date.setUTCDate(date.getUTCDate() + n)
  return date.toISOString().slice(0, 10)
}
const wire = (day) => `${day}T00:00:00`

// ─── Request matchers ────────────────────────────────────────────────────────
const pathOf = (url) => new URL(url).pathname.replace(/\/$/, '')
const param = (r, key) => new URL(r.url()).searchParams.get(key)
const isCreate = (r) => r.method() === 'POST' && pathOf(r.url()).endsWith('/transactions')
const isTxGet = (r) => r.method() === 'GET' && pathOf(r.url()).endsWith('/transactions')
const startDay = (r) => (param(r, 'start_date') || '').slice(0, 10)
/** The main list: no search, a range that starts on or before Manila today. */
const isMainList = (r) => isTxGet(r) && !param(r, 'search') && !(startDay(r) > today())
/** Upcoming's transaction requests: no search, a range that starts after Manila today. */
const isUpcomingList = (r) => isTxGet(r) && !param(r, 'search') && startDay(r) > today()
const isUpcomingHead = (r) => isUpcomingList(r) && Number(param(r, 'offset') ?? '0') === 0
const isUpcomingTail = (r) => isUpcomingList(r) && Number(param(r, 'offset') ?? '0') > 0
const isSearchList = (term) => (r) => isTxGet(r) && param(r, 'search') === term
const isAccountsList = (r) => r.method() === 'GET' && pathOf(r.url()).endsWith('/accounts')
const isSnapshot = (r) => r.method() === 'GET' && new URL(r.url()).pathname.endsWith('/dashboard/snapshot')

// ─── Locators ────────────────────────────────────────────────────────────────
const formModal = (page, heading) =>
  page.locator('div.fixed').filter({ has: page.getByRole('heading', { name: heading, exact: true }) })
const createModal = (page) => formModal(page, 'Create Transaction')
const control = (modal, key) => modal.locator(`[data-field="${key}"]`)
const fieldError = (modal, key) => modal.locator(`[data-testid="field-error-${key}"]`)
const noticeOf = (modal) => modal.locator('[data-testid="transaction-saved-notice"]')
const formErrorOf = (modal) => modal.locator('[data-testid="transaction-form-error"]')
const primaryOf = (modal) => modal.getByRole('button', { name: 'Create Transaction', exact: true })
const anotherOf = (modal) => modal.locator('[data-testid="save-and-add-another"]')
const cancelOf = (modal) => modal.getByRole('button', { name: 'Cancel', exact: true })
const postedBox = (modal) => modal.getByRole('checkbox', { name: 'Mark as posted' })
const recurringSelect = (modal) => modal.locator('select:has(option[value=""])')
const chip = (scope, name) => scope.getByRole('button', { name: new RegExp(`^${name}`) })
const rowFor = (page, description) => page.locator('article[role="button"]').filter({ hasText: description }).first()
const textOf = async (locator) => ((await locator.textContent({ timeout: 3000 }).catch(() => null)) || '').trim()
const isFocused = (locator) => locator.evaluate((el) => el === document.activeElement).catch(() => false)
const activeField = (page) => page.evaluate(() => document.activeElement?.getAttribute('data-field') ?? null)

/** Polls (bounded, node-side) until `read()` satisfies `ok`; returns the last value read. */
async function until(read, ok, ms = 6000) {
  const stop = Date.now() + ms
  let last
  for (;;) {
    last = await read().catch(() => undefined)
    if (ok(last) || Date.now() > stop) return last
    await h.sleep(50)
  }
}
const waitNotice = (modal, want, ms) =>
  until(() => textOf(noticeOf(modal)), (t) => (want === undefined ? t !== '' : t === want), ms)
const waitFocus = (locator, ms = 3000) => until(() => isFocused(locator), (v) => v === true, ms)
/** Waits (bounded) until both submit buttons are enabled; true on arrival. */
const waitButtons = (modal, ms = 6000) =>
  until(async () => (await anotherOf(modal).isEnabled()) && (await primaryOf(modal).isEnabled()), (v) => v === true, ms)

// ─── Phases ──────────────────────────────────────────────────────────────────
const phasesOf = async (page) => ((await h.readTexts(page))['busy-overlay'] || { attrs: {} }).attrs['data-phase'] || []
const blockedIn = (phases) => phases.filter((p) => p === 'shield' || p === 'visible')

/**
 * The app's own `quietPending()`: imports the exact module URL the app loaded (the dev server
 * may add ?t=…), so this reads the running store's state, not a second copy.
 */
const quietPendingOf = (page) => page.evaluate(async () => {
  const file = '/src/store/busy.ts'
  const url = performance.getEntriesByType('resource').map((e) => e.name).find((n) => new URL(n).pathname === file) || file
  const { quietPending } = await import(url)
  return quietPending()
})

// ─── Setup and pages ─────────────────────────────────────────────────────────
/**
 * A user with a PHP checking account called "Sav Checking" and, on request, a USD account,
 * an expense category, a tag, and a recurring expense entry with an allocation.
 */
async function seedUser(tag, { dollars = false, category = false, tagName = false, entry = false } = {}) {
  const user = await h.makeUser(stack, tag)
  const checking = await client.post(user.token, '/accounts/', { name: 'Sav Checking', account_type: 'checking', balance: 100000, currency: 'PHP' })
  const seeds = { user, checking }
  if (dollars) seeds.dollars = await client.post(user.token, '/accounts/', { name: 'Sav Dollars', account_type: 'checking', balance: 1000, currency: 'USD' })
  if (category || entry) seeds.category = await client.post(user.token, '/categories/', { name: 'Sav Food', color: '#16a34a', is_expense: true })
  if (tagName) seeds.tag = await client.post(user.token, '/tags/', { name: 'Sav Tag' })
  if (entry) {
    seeds.allocation = await client.post(user.token, '/allocations/', {
      account_id: checking.id, name: 'Sav Envelope', allocation_type: 'budget', target_amount: 1000,
      period_frequency: 'monthly', period_start: wire(`${today().slice(0, 8)}01`),
      configuration: { category_ids: [seeds.category.id] },
    })
    seeds.entry = await client.post(user.token, '/budget-entries/', {
      entry_type: 'expense', currency: 'PHP', cadence: 'monthly', name: 'Sav Rent', amount: 500,
      account_id: checking.id, category_id: seeds.category.id, allocation_id: seeds.allocation.id,
      next_occurrence: wire(addDays(today(), 10)),
    })
  }
  return seeds
}

/** Request bodies of every POST /transactions the page makes, parsed, in order. */
function watchCreates(page) {
  const bodies = []
  page.on('request', (r) => {
    if (!isCreate(r)) return
    try { bodies.push(JSON.parse(r.postData() || '{}')) } catch { bodies.push(null) }
  })
  return bodies
}

async function openAddForm(page) {
  await h.waitQuiet(page)
  await page.getByRole('button', { name: 'Add Transaction' }).first().click()
  const modal = createModal(page)
  await modal.waitFor()
  await h.waitQuiet(page)
  return modal
}

/**
 * A fresh signed-in page on Transactions with the Create dialog open, its native dialogs
 * tracked and its requests logged. With `recorder`, the overlay's `data-phase` history is
 * recorded (Phase recorder rule): installed before login, reset after the page settles,
 * and proven present by the [S] `<scenario>.recorder-installed` check.
 */
async function openPage(browser, user, scenario, { recorder = false, dialog = true } = {}) {
  const { ctx, page } = await h.newPage(browser, { timezoneId: 'Asia/Manila' })
  page.setDefaultTimeout(10000)
  const native = d.trackNativeDialogs(page)
  const log = h.logRequests(page)
  const creates = watchCreates(page)
  if (recorder) await h.recordTexts(page, ['busy-overlay'], { attributes: ['data-phase'] })
  await h.uiLogin(page, stack, user)
  await page.goto(`${stack.webUrl}/transactions`)
  await page.getByRole('button', { name: 'Add Transaction' }).first().waitFor()
  await h.waitQuiet(page)
  const modal = dialog ? await openAddForm(page) : null
  await h.waitQuiet(page)
  if (recorder) {
    await h.resetTexts(page)
    await h.check(`${scenario}.recorder-installed`, 'S', async () => {
      const defined = (await h.readTexts(page))['busy-overlay'] !== undefined
      const present = await page.evaluate(() => !!window.__stu335Texts)
      return (defined && present) || `overlay history defined ${defined}, recorder present ${present}`
    })
  }
  return { ctx, page, native, log, creates, modal }
}
const openWithPhaseRecorder = (browser, user, scenario, options) => openPage(browser, user, scenario, { ...options, recorder: true })

/** Description, the account chip (if not already selected) and the posted amount. */
async function fillEntry(modal, description, amount, account = 'Sav Checking') {
  await control(modal, 'description').fill(description)
  const accountChip = chip(control(modal, 'account_id'), account)
  if ((await accountChip.getAttribute('data-selected')) !== 'true') await accountChip.click()
  await control(modal, 'amount').fill(String(amount))
}

async function clickAnother(page, modal) {
  await h.waitQuiet(page)
  await anotherOf(modal).click()
}
async function clickPrimary(page, modal) {
  await h.waitQuiet(page)
  await primaryOf(modal).click()
}

/** The API's rows whose description is in `names`. */
async function apiRows(user, names) {
  const list = await client.get(user.token, '/transactions/?limit=200')
  const items = Array.isArray(list) ? list : list.items
  return items.filter((row) => names.includes(row.description))
}

const isoDay = (iso) => String(iso).slice(0, 10)

// (a) The happy path: two add-another saves, then the primary button.
async function scenarioA(browser) {
  console.log('\n=== (a) Save and add another: three rows, the dialog stays open until the primary save')
  const seed = await seedUser('a', { category: true })
  const { ctx, page, native, creates } = await openPage(browser, seed.user, 'a')
  try {
    const modal = createModal(page)
    await modal.waitFor()
    await chip(modal, 'Expense').click()
    await chip(modal, 'Sav Food').click()
    const dateBefore = await control(modal, 'transaction_date').inputValue()
    await fillEntry(modal, 'Coffee', 180)
    await clickAnother(page, modal)
    await waitNotice(modal)

    await h.check('a.one-post-typed-body', 'B', async () => {
      const body = creates[0]
      const ok = creates.length === 1 && body && body.description === 'Coffee' && Number(body.amount) === 180 &&
        body.account_id === seed.checking.id && body.transaction_type === 'debit' && body.is_posted === true
      return ok || `${creates.length} POST(s), body ${JSON.stringify(creates[0])}`
    })
    await h.check('a.dialog-open', 'B', async () => (await modal.isVisible()) || 'the dialog closed')
    await h.check('a.notice-text', 'B', async () => {
      const text = await textOf(noticeOf(modal))
      return text === 'Saved "Coffee ₱180.00"' || `notice ${JSON.stringify(text)}`
    })
    await h.check('a.notice-role', 'B', async () =>
      (await noticeOf(modal).getAttribute('role')) === 'status' || 'the notice is not role=status')
    await h.check('a.cleared', 'B', async () => {
      const [description, amount] = [await control(modal, 'description').inputValue(), await control(modal, 'amount').inputValue()]
      return (description === '' && amount === '') || `description ${JSON.stringify(description)}, amount ${JSON.stringify(amount)}`
    })
    await h.check('a.kept', 'B', async () => {
      const got = {
        account: await chip(control(modal, 'account_id'), 'Sav Checking').getAttribute('data-selected'),
        type: await chip(modal, 'Expense').evaluate((el) => el.classList.contains('bg-ink')),
        category: await chip(modal, 'Sav Food').evaluate((el) => el.classList.contains('bg-ink')),
        date: await control(modal, 'transaction_date').inputValue(),
        posted: await postedBox(modal).isChecked(),
      }
      const ok = got.account === 'true' && got.type && got.category && got.date === dateBefore && got.posted
      return ok || `kept ${JSON.stringify(got)}, date before ${dateBefore}`
    })
    await h.check('a.focus-description', 'B', async () =>
      (await waitFocus(control(modal, 'description'))) || `active field ${await activeField(page)}`)

    await control(modal, 'description').fill('Tea')
    await control(modal, 'amount').fill('95')
    await clickAnother(page, modal)
    await waitNotice(modal, 'Saved "Tea ₱95.00"')
    await h.check('a.second-add-another', 'B', async () => {
      const text = await textOf(noticeOf(modal))
      return (creates.length === 2 && text === 'Saved "Tea ₱95.00"') || `${creates.length} POST(s), notice ${JSON.stringify(text)}`
    })

    await control(modal, 'description').fill('Snack')
    await control(modal, 'amount').fill('40')
    await clickPrimary(page, modal)
    await modal.waitFor({ state: 'detached', timeout: 6000 }).catch(() => {})
    await h.check('a.primary-saves-and-closes', 'B', async () =>
      (creates.length === 3 && (await modal.count()) === 0) || `${creates.length} POST(s), dialog open ${(await modal.count()) > 0}`)
    await h.waitQuiet(page)
    await h.check('a.api-holds-three', 'B', async () => {
      const rows = await apiRows(seed.user, ['Coffee', 'Tea', 'Snack'])
      return rows.length === 3 || `${rows.length} of 3 rows: ${JSON.stringify(rows.map((r) => r.description))}`
    })
    await h.check('a.list-shows-three', 'B', async () => {
      const counts = await until(
        async () => [await rowFor(page, 'Coffee').count(), await rowFor(page, 'Tea').count(), await rowFor(page, 'Snack').count()],
        (c) => c.every((n) => n > 0))
      return counts.every((n) => n > 0) || `list rows ${JSON.stringify(counts)}`
    })

    const again = await openAddForm(page)
    await h.check('a.reopen-fresh', 'B', async () => {
      const got = {
        description: await control(again, 'description').inputValue(),
        amount: await control(again, 'amount').inputValue(),
        selected: await control(again, 'account_id').locator('[data-selected="true"]').count(),
        notices: await noticeOf(again).count(),
        notice: await textOf(noticeOf(again)),
      }
      const ok = got.description === '' && got.amount === '' && got.selected === 0 && got.notices === 1 && got.notice === ''
      return ok || `reopened ${JSON.stringify(got)}`
    })
  } finally {
    await d.checkNoNativeDialogs(h, 'a', native)
    await ctx.close()
  }
}

// (b) The cleared and kept matrix: the recurring link, the tag and the posting date go;
// category, date and the posted mode stay.
async function scenarioB(browser) {
  console.log('\n=== (b) Save and add another: the recurring link, tags and posting date are cleared')
  const seed = await seedUser('b', { entry: true, tagName: true })
  const { ctx, page, native, creates } = await openPage(browser, seed.user, 'b')
  try {
    const modal = createModal(page)
    await recurringSelect(modal).selectOption(String(seed.entry.id))
    await fillEntry(modal, 'Rent', 500)
    await chip(modal.locator('[data-testid="tag-picker"]'), 'Sav Tag').click()
    const day = today()
    await control(modal, 'posting_date').fill(day)
    const dateBefore = await control(modal, 'transaction_date').inputValue()
    await clickAnother(page, modal)
    await waitNotice(modal)

    await h.check('b.first-body-linked', 'S', async () => {
      const body = creates[0]
      const ok = body && body.budget_entry_id === seed.entry.id && body.allocation_id === seed.allocation.id &&
        Array.isArray(body.tag_ids) && body.tag_ids.includes(seed.tag.id) && !!body.posting_date
      return ok || `first body ${JSON.stringify(body)}`
    })
    await h.check('b.recurring-none', 'B', async () => {
      const value = await recurringSelect(modal).inputValue()
      return value === '' || `recurring select ${JSON.stringify(value)}`
    })
    await h.check('b.no-tag-selected', 'B', async () => {
      const pressed = await modal.locator('[data-testid="tag-picker"] button[aria-pressed="true"]').count()
      return pressed === 0 || `${pressed} tag chip(s) selected`
    })
    await h.check('b.posting-date-empty', 'B', async () => {
      const value = await control(modal, 'posting_date').inputValue()
      return value === '' || `posting date ${JSON.stringify(value)}`
    })
    await h.check('b.kept', 'B', async () => {
      const got = {
        category: await chip(modal, 'Sav Food').evaluate((el) => el.classList.contains('bg-ink')),
        date: await control(modal, 'transaction_date').inputValue(),
        posted: await postedBox(modal).isChecked(),
      }
      return (got.category && got.date === dateBefore && got.posted) || `kept ${JSON.stringify(got)}, date before ${dateBefore}`
    })

    await control(modal, 'description').fill('Other')
    await control(modal, 'amount').fill('20')
    await clickAnother(page, modal)
    await waitNotice(modal, 'Saved "Other ₱20.00"')
    await h.check('b.second-body-unlinked', 'B', async () => {
      const body = creates[1]
      const ok = creates.length === 2 && body &&
        (body.budget_entry_id === undefined || body.budget_entry_id === null) &&
        (body.allocation_id === undefined || body.allocation_id === null) &&
        Array.isArray(body.tag_ids) && body.tag_ids.length === 0
      return ok || `${creates.length} POST(s), second body ${JSON.stringify(body)}`
    })
  } finally {
    await d.checkNoNativeDialogs(h, 'b', native)
    await ctx.close()
  }
}

// (c) A transfer between currencies: the destination stays, the fee and received amount go.
async function scenarioC(browser) {
  console.log('\n=== (c) Save and add another: a transfer keeps its destination, clears fee and received')
  const seed = await seedUser('c', { dollars: true })
  const { ctx, page, native, creates } = await openPage(browser, seed.user, 'c')
  try {
    const modal = createModal(page)
    await chip(modal, 'Transfer').click()
    await control(modal, 'description').fill('Move one')
    await chip(control(modal, 'account_id'), 'Sav Checking').click()
    await chip(control(modal, 'transfer_to_account_id'), 'Sav Dollars').click()
    await control(modal, 'amount').fill('100')
    await control(modal, 'received_amount').fill('2')
    await control(modal, 'transfer_fee').fill('5')
    await clickAnother(page, modal)
    await waitNotice(modal)

    await h.check('c.first-posted', 'S', async () => creates.length === 1 || `${creates.length} POST(s)`)
    await h.check('c.destination-kept', 'B', async () =>
      (await chip(control(modal, 'transfer_to_account_id'), 'Sav Dollars').getAttribute('data-selected')) === 'true' ||
      'the destination chip is not selected')
    await h.check('c.fee-and-received-empty', 'B', async () => {
      const got = [await control(modal, 'transfer_fee').inputValue(), await control(modal, 'received_amount').inputValue(), await control(modal, 'amount').inputValue()]
      return got.every((v) => v === '') || `fee, received, amount ${JSON.stringify(got)}`
    })

    await control(modal, 'description').fill('Move two')
    await control(modal, 'amount').fill('100')
    const before = creates.length
    await clickAnother(page, modal)
    await fieldError(modal, 'received_amount').waitFor({ timeout: 3000 }).catch(() => {})
    await h.check('c.received-required-again', 'B', async () =>
      (await fieldError(modal, 'received_amount').count()) === 1 || 'no received-amount error on the next save')
    await h.check('c.no-second-post', 'B', async () => creates.length === before || `${creates.length - before} extra POST(s)`)
  } finally {
    await d.checkNoNativeDialogs(h, 'c', native)
    await ctx.close()
  }
}

// (d) The screen loader stays off for the save and the refetches it starts.
async function scenarioD(browser) {
  console.log('\n=== (d) The screen loader stays off for the save and its refresh')
  const seed = await seedUser('d')
  const { ctx, page, native, creates } = await openWithPhaseRecorder(browser, seed.user, 'd')
  const gates = []
  try {
    const modal = createModal(page)
    await fillEntry(modal, 'Coffee', 180)
    const postGate = await h.gate(page, isCreate)
    const listGate = await h.gate(page, isMainList)
    const snapGate = await h.gate(page, isSnapshot)
    gates.push(postGate, listGate, snapGate)
    await clickAnother(page, modal)
    await postGate.waitHits(1)
    await page.waitForTimeout(700)
    await h.check('d.post-no-block', 'B', async () => {
      const got = {
        hit: postGate.hits,
        blocked: blockedIn(await phasesOf(page)),
        another: await anotherOf(modal).isDisabled(),
        primary: await primaryOf(modal).isDisabled(),
      }
      // Enter has nowhere to land while the fields are disabled: it must not submit again.
      await page.keyboard.press('Enter')
      await page.waitForTimeout(150)
      const ok = got.hit === 1 && got.blocked.length === 0 && got.another && got.primary && postGate.hits === 1 && creates.length === 1
      return ok || `${JSON.stringify(got)}, POSTs after Enter ${postGate.hits}`
    })

    // The in-flight guard itself: a submit with no button and no focus (requestSubmit with no
    // submitter) must not start a second POST while the first is held.
    await modal.locator('form').evaluate((form) => form.requestSubmit())
    await page.waitForTimeout(300)
    await h.check('d.inflight-guard', 'B', async () =>
      (postGate.hits === 1 && creates.length === 1) || `POSTs after requestSubmit: gate ${postGate.hits}, requests ${creates.length}`)

    postGate.release({ disarm: true })
    const listHit = await listGate.waitHits(1)
    const snapHit = await snapGate.waitHits(1)
    await h.check('d.gets-received', 'S', async () =>
      (listHit && snapHit) || `list gate hit ${listHit}, snapshot gate hit ${snapHit}`)
    await waitNotice(modal)
    await page.waitForTimeout(700)
    await page.keyboard.type('Tea')
    // The fields stay usable while the refresh is held; the submit buttons wait for it.
    await h.check('d.refetch-no-block', 'B', async () => {
      const got = {
        blocked: blockedIn(await phasesOf(page)),
        typed: await control(modal, 'description').inputValue(),
        focus: await activeField(page),
        notice: await textOf(noticeOf(modal)),
        anotherDisabled: await anotherOf(modal).isDisabled(),
        primaryDisabled: await primaryOf(modal).isDisabled(),
      }
      const ok = got.blocked.length === 0 && got.typed === 'Tea' && got.focus === 'description' &&
        got.notice === 'Saved "Coffee ₱180.00"' && got.anotherDisabled && got.primaryDisabled
      return ok || JSON.stringify(got)
    })

    // A submit with no button (requestSubmit) while the refresh is held must not save: the
    // save's own refetches would join the held, older requests.
    await control(modal, 'amount').fill('20')
    const postsBefore = creates.length
    await modal.locator('form').evaluate((form) => form.requestSubmit())
    await page.waitForTimeout(400)
    await h.check('d.save-waits-for-refresh', 'B', async () =>
      creates.length === postsBefore || `POSTs while the refresh is held: ${creates.length - postsBefore}`)

    listGate.release({ disarm: true })
    snapGate.release({ disarm: true })
    await h.waitQuiet(page)
    await h.check('d.row-appears', 'B', async () => {
      const n = await until(() => rowFor(page, 'Coffee').count(), (c) => c > 0)
      return n > 0 || 'the saved row is not in the list'
    })

    // Control: the primary button with its POST held does block, so the recorder can see it.
    await waitButtons(modal)
    const holdPrimary = await h.gate(page, isCreate)
    gates.push(holdPrimary)
    await clickPrimary(page, modal)
    await holdPrimary.waitHits(1)
    const sawVisible = await h.waitPhase(page, 'visible', 3000)
    await h.check('d.control-primary-blocks', 'G', async () => sawVisible || 'the primary save never reached visible')
    holdPrimary.release({ disarm: true })
    await modal.waitFor({ state: 'detached', timeout: 6000 }).catch(() => {})
    await h.waitQuiet(page)
  } finally {
    for (const gate of gates) gate.release({ disarm: true })
    await d.checkNoNativeDialogs(h, 'd', native)
    await ctx.close()
  }
}

// (d2) Unrelated requests and a primary save still block; a save waits for the refresh and is fresh.
async function scenarioD2(browser) {
  console.log('\n=== (d2) An unrelated request and a primary save still block; a save after the refresh is fresh')
  const seed = await seedUser('d2')
  const { ctx, page, native } = await openWithPhaseRecorder(browser, seed.user, 'd2')
  const gates = []
  try {
    const modal = createModal(page)
    await fillEntry(modal, 'Coffee', 180)
    const search = page.locator('[data-testid="transactions-search"]')
    const postGate = await h.gate(page, isCreate)
    const searchOne = await h.gate(page, isSearchList('zz'))
    gates.push(postGate, searchOne)
    await clickAnother(page, modal)
    await postGate.waitHits(1)

    // While the quiet POST is held, an unrelated request (a new search key) must block.
    await h.resetTexts(page)
    await search.fill('zz', { force: true })
    await searchOne.waitHits(1, 5000)
    await page.waitForTimeout(500)
    await h.check('d2.unrelated-during-post', 'B', async () => {
      const blocked = blockedIn(await phasesOf(page))
      return blocked.length > 0 || `phases ${JSON.stringify(await phasesOf(page))}`
    })
    searchOne.release({ disarm: true })
    const settled = await h.waitPhase(page, 'hidden', 5000)
    await h.check('d2.idle-before-refresh', 'S', async () => settled || 'the overlay did not return to hidden')

    // Release the quiet POST with the refetches it starts held, then block again unrelatedly.
    const refresh = await h.gate(page, isSearchList('zz'))
    const searchTwo = await h.gate(page, isSearchList('yy'))
    gates.push(refresh, searchTwo)
    postGate.release({ disarm: true })
    const refreshHit = await refresh.waitHits(1, 5000)
    await h.check('d2.refresh-started', 'S', async () => refreshHit || 'the save started no list refetch')
    await waitNotice(modal)
    await h.resetTexts(page)
    await search.fill('yy', { force: true })
    await searchTwo.waitHits(1, 5000)
    await page.waitForTimeout(500)
    await h.check('d2.unrelated-during-refresh', 'B', async () => {
      const blocked = blockedIn(await phasesOf(page))
      return blocked.length > 0 || `phases ${JSON.stringify(await phasesOf(page))}`
    })
    searchTwo.release({ disarm: true })
    await h.waitPhase(page, 'hidden', 5000)

    // The refresh GETs are still held: the submit buttons wait for them, the fields do not.
    await h.check('d2.buttons-wait-for-refresh', 'B', async () => {
      const got = {
        another: await anotherOf(modal).isDisabled(),
        primary: await primaryOf(modal).isDisabled(),
        description: await control(modal, 'description').isEnabled(),
      }
      return (got.another && got.primary && got.description) || JSON.stringify(got)
    })
    refresh.release({ disarm: true })
    await h.check('d2.buttons-enabled', 'S', async () => (await waitButtons(modal)) || 'the buttons stayed disabled after the refresh')

    // A primary save counts (its POST is not exempt).
    await control(modal, 'description').fill('Tea')
    await control(modal, 'amount').fill('20')
    const primaryGate = await h.gate(page, isCreate)
    gates.push(primaryGate)
    await h.resetTexts(page)
    await primaryOf(modal).click()
    await primaryGate.waitHits(1, 5000)
    await page.waitForTimeout(500)
    await h.check('d2.overlapping-save-counts', 'B', async () => {
      const blocked = blockedIn(await phasesOf(page))
      return (primaryGate.hits === 1 && blocked.length > 0) || `POSTs ${primaryGate.hits}, phases ${JSON.stringify(await phasesOf(page))}`
    })
    primaryGate.release({ disarm: true })
    await modal.waitFor({ state: 'detached', timeout: 6000 }).catch(() => {})
    // The list is filtered by the search; clear it so the saved rows can show.
    await h.waitPhase(page, 'hidden', 5000)
    await search.fill('', { force: true })
    await h.waitQuiet(page)
    await h.waitPhase(page, 'hidden', 5000)

    // A second save tried while the first save's refresh is held must wait. Once it is made,
    // the requests it starts must be new ones, sent after it settled (not joined to the held,
    // older ones), so the list and the balance show both rows.
    const events = []
    page.on('request', (r) => { if (isMainList(r) || isSnapshot(r) || isAccountsList(r)) events.push({ kind: 'get', r }) })
    page.on('response', (res) => {
      const r = res.request()
      if (isCreate(r) && (r.postData() || '').includes('"Dinner"')) events.push({ kind: 'second-post-done' })
    })
    const again = await openAddForm(page)
    await fillEntry(again, 'Lunch', 30)
    const held = [await h.gate(page, isMainList), await h.gate(page, isSnapshot), await h.gate(page, isAccountsList)]
    gates.push(...held)
    await clickAnother(page, again)
    await waitNotice(again, 'Saved "Lunch ₱30.00"')
    await held[0].waitHits(1, 5000)
    await control(again, 'description').fill('Dinner')
    await control(again, 'amount').fill('40')
    // A disabled button ignores even a forced click; without the wait this saves at once.
    await primaryOf(again).click({ force: true, timeout: 2000 }).catch(() => {})
    await page.waitForTimeout(500)
    for (const gate of held) gate.release({ disarm: true })
    if ((await again.count()) > 0) {
      await waitButtons(again)
      await clickPrimary(page, again)
      await again.waitFor({ state: 'detached', timeout: 6000 }).catch(() => {})
    }
    await h.waitQuiet(page)
    await h.check('d2.second-save-fresh', 'B', async () => {
      const done = events.findIndex((e) => e.kind === 'second-post-done')
      if (done < 0) return 'the second save never completed'
      const after = events.slice(done + 1).filter((e) => e.kind === 'get').map((e) => e.r)
      const fresh = { list: after.filter(isMainList), snapshot: after.filter(isSnapshot), accounts: after.filter(isAccountsList) }
      const counts = Object.fromEntries(Object.entries(fresh).map(([k, v]) => [k, v.length]))
      if (Object.values(counts).some((n) => n === 0)) return `requests sent after the second save settled ${JSON.stringify(counts)}`
      const res = await fresh.accounts[fresh.accounts.length - 1].response()
      const body = res ? await res.json().catch(() => null) : null
      const items = Array.isArray(body) ? body : (body && body.items) || []
      const shown = items.find((a) => a.id === seed.checking.id)?.balance
      const truth = (await client.get(seed.user.token, `/accounts/${seed.checking.id}`)).balance
      const listed = [
        await until(() => rowFor(page, 'Lunch').count(), (c) => c > 0),
        await until(() => rowFor(page, 'Dinner').count(), (c) => c > 0),
      ]
      const ok = shown !== undefined && Number(shown) === Number(truth) && listed.every((n) => n > 0)
      return ok || `balance on the page ${shown}, server ${truth}, rows listed (Lunch, Dinner) ${JSON.stringify(listed)}, ${JSON.stringify(counts)}`
    })
  } finally {
    for (const gate of gates) gate.release({ disarm: true })
    await d.checkNoNativeDialogs(h, 'd2', native)
    await ctx.close()
  }
}

// (d3) The upcoming tail request, sent after the head response, stays off the loader.
async function scenarioD3(browser) {
  console.log('\n=== (d3) The upcoming tail request, sent after an await, stays off the screen loader')
  const seed = await seedUser('d3')
  const start = addDays(today(), 1)
  const rows = Array.from({ length: 105 }, (_, i) => i)
  for (let from = 0; from < rows.length; from += 15) {
    await Promise.all(rows.slice(from, from + 15).map((i) =>
      client.post(seed.user.token, '/transactions/', {
        account_id: seed.checking.id, transaction_type: 'debit', amount: 10, description: `Planned ${i}`,
        transaction_date: wire(addDays(start, i % 20)), is_posted: false,
      })))
  }
  const { ctx, page, native, log } = await openWithPhaseRecorder(browser, seed.user, 'd3')
  const gates = []
  try {
    const modal = createModal(page)
    await h.check('d3.setup-tail-requested', 'S', async () => {
      const tails = log.filter((e) => e.method === 'GET' && isUpcomingTail({ method: () => e.method, url: () => e.url }))
      return tails.length >= 1 || 'the page load sent no upcoming tail request'
    })
    await fillEntry(modal, 'Coffee', 180)
    const headGate = await h.gate(page, isUpcomingHead)
    gates.push(headGate)
    let tailResponses = 0
    page.on('response', (res) => { if (isUpcomingTail(res.request())) tailResponses++ })
    await clickAnother(page, modal)
    await headGate.waitHits(1, 5000)
    // The invalidation also refetches the tail entry; let that one finish.
    await until(async () => tailResponses, (n) => n >= 1, 5000)
    await h.check('d3.invalidation-tail-done', 'S', async () => tailResponses >= 1 || 'the invalidation sent no tail refetch')
    const tailGate = await h.gate(page, isUpcomingTail)
    gates.push(tailGate)
    await h.resetTexts(page)
    headGate.release({ disarm: true })
    const tailHit = await tailGate.waitHits(1, 5000)
    await page.waitForTimeout(700)
    await h.check('d3.tail-started', 'S', async () => tailHit || 'no tail request after the head response')
    await h.check('d3.tail-no-block', 'B', async () => {
      const blocked = blockedIn(await phasesOf(page))
      return blocked.length === 0 || `phases ${JSON.stringify(await phasesOf(page))}`
    })
    tailGate.release({ disarm: true })
    await h.waitQuiet(page)
  } finally {
    for (const gate of gates) gate.release({ disarm: true })
    await d.checkNoNativeDialogs(h, 'd3', native)
    await ctx.close()
  }
}

// (d4) A primary save's refetches still count: the integration oracle for the matcher.
async function scenarioD4(browser) {
  console.log('\n=== (d4) A primary save\'s refetches still block the screen')
  const seed = await seedUser('d4')
  const { ctx, page, native } = await openWithPhaseRecorder(browser, seed.user, 'd4')
  const gates = []
  try {
    const modal = createModal(page)
    await fillEntry(modal, 'First', 30)
    await clickAnother(page, modal)
    await waitNotice(modal)
    await page.waitForTimeout(500)
    await h.check('d4.add-another-no-block', 'B', async () => {
      const blocked = blockedIn(await phasesOf(page))
      const notice = await textOf(noticeOf(modal))
      return (blocked.length === 0 && notice === 'Saved "First ₱30.00"') || `phases ${JSON.stringify(await phasesOf(page))}, notice ${JSON.stringify(notice)}`
    })
    await h.waitQuiet(page)

    const listGate = await h.gate(page, isMainList)
    gates.push(listGate)
    await control(modal, 'description').fill('Plain')
    await control(modal, 'amount').fill('40')
    await clickPrimary(page, modal)
    const hit = await listGate.waitHits(1, 5000)
    const visible = hit ? await h.waitPhase(page, 'visible', 3000) : false
    await page.waitForTimeout(600)
    // A guard: a primary save's refresh still shows the loader. The matcher's own oracle is the
    // shared negative isQuietSettle test, since the explicit refresh is loud either way.
    await h.check('d4.plain-refetch-counts', 'G', async () => {
      const phase = await h.overlayPhase(page)
      return (hit && visible && phase === 'visible') || `list GET held ${hit}, reached visible ${visible}, phase after 600 ms ${phase}`
    })
    listGate.release({ disarm: true })
    const hidden = await h.waitPhase(page, 'hidden', 5000)
    await h.check('d4.back-to-hidden', 'B', async () => hidden || 'the overlay did not return to hidden')
    await h.check('d4.row-in-list', 'B', async () => {
      const n = await until(() => rowFor(page, 'Plain').count(), (c) => c > 0)
      return n > 0 || 'the primary save\'s row is not in the list'
    })
  } finally {
    for (const gate of gates) gate.release({ disarm: true })
    await d.checkNoNativeDialogs(h, 'd4', native)
    await ctx.close()
  }
}

// (e) Errors: a refused save, an empty amount and an out-of-range date.
async function scenarioE(browser) {
  console.log('\n=== (e) Save and add another: a refused save and the inline errors')
  const seed = await seedUser('e')
  const { ctx, page, native, creates } = await openWithPhaseRecorder(browser, seed.user, 'e')
  const gates = []
  try {
    const modal = createModal(page)
    await fillEntry(modal, 'Err probe', 50)
    const fail = await h.failWith(page, isCreate, 500, { times: 1 })
    const listGate = await h.gate(page, isMainList)
    gates.push(fail, listGate)
    await clickAnother(page, modal)
    await formErrorOf(modal).waitFor({ timeout: 5000 }).catch(() => {})
    await listGate.waitHits(1, 3000)
    await page.waitForTimeout(700)
    await h.check('e.server-reason', 'B', async () => {
      const text = await textOf(formErrorOf(modal))
      return text.includes('stu335 injected failure 500') || `form error ${JSON.stringify(text)}`
    })
    await h.check('e.nothing-cleared', 'B', async () => {
      const got = [await control(modal, 'description').inputValue(), await control(modal, 'amount').inputValue(),
        await chip(control(modal, 'account_id'), 'Sav Checking').getAttribute('data-selected')]
      return (got[0] === 'Err probe' && got[1] === '50' && got[2] === 'true') || `kept ${JSON.stringify(got)}`
    })
    await h.check('e.status-mounted-empty', 'B', async () => {
      const [n, text] = [await noticeOf(modal).count(), await textOf(noticeOf(modal))]
      return (n === 1 && text === '') || `status elements ${n}, text ${JSON.stringify(text)}`
    })
    // The fields are usable at once; the buttons wait for the refetches the refusal started.
    await h.check('e.fields-enabled', 'B', async () => {
      const got = [await control(modal, 'description').isEnabled(), await control(modal, 'amount').isEnabled(),
        await anotherOf(modal).isDisabled(), await primaryOf(modal).isDisabled()]
      return got.every(Boolean) || `description, amount enabled; another, primary disabled ${JSON.stringify(got)}`
    })
    await h.check('e.failure-no-block', 'B', async () => {
      const blocked = blockedIn(await phasesOf(page))
      return (listGate.hits >= 1 && blocked.length === 0) || `list GET held ${listGate.hits}, phases ${JSON.stringify(await phasesOf(page))}`
    })
    listGate.release({ disarm: true })
    await h.check('e.buttons-enabled', 'B', async () => (await waitButtons(modal)) || 'the buttons stayed disabled after the refetch')
    // The focus waited for the used button to be enabled again.
    await h.check('e.focus-on-used-button', 'B', async () => (await waitFocus(anotherOf(modal))) || `active ${await d.activeTestId(page)}`)
    await h.waitQuiet(page)

    // A save that works leaves a status line to be cleared by the next failed attempt.
    await clickAnother(page, modal)
    await waitNotice(modal, 'Saved "Err probe ₱50.00"')

    // An empty amount: the field's own error, focus on it, no POST.
    await control(modal, 'description').fill('Dated')
    let before = creates.length
    await clickAnother(page, modal)
    await fieldError(modal, 'amount').waitFor({ timeout: 3000 }).catch(() => {})
    await h.check('e.amount-inline', 'B', async () => {
      const got = {
        errors: await fieldError(modal, 'amount').count(),
        invalid: await control(modal, 'amount').getAttribute('aria-invalid'),
        focused: await waitFocus(control(modal, 'amount')),
        posts: creates.length - before,
      }
      return (got.errors === 1 && got.invalid === 'true' && got.focused && got.posts === 0) || JSON.stringify(got)
    })
    await h.check('e.amount-clears-notice', 'B', async () => {
      const text = await textOf(noticeOf(modal))
      return text === '' || `status text ${JSON.stringify(text)}`
    })

    // A save that works, then an out-of-range date.
    await control(modal, 'amount').fill('25')
    await clickAnother(page, modal)
    await waitNotice(modal, 'Saved "Dated ₱25.00"')
    await control(modal, 'description').fill('Late')
    await control(modal, 'amount').fill('30')
    await control(modal, 'transaction_date').fill('2099-12-31')
    before = creates.length
    await clickAnother(page, modal)
    await modal.locator('[data-testid="record-date-error"]').first().waitFor({ timeout: 3000 }).catch(() => {})
    await h.check('e.date-error', 'B', async () => {
      const got = { errors: await modal.locator('[data-testid="record-date-error"]').count(), posts: creates.length - before }
      return (got.errors >= 1 && got.posts === 0) || JSON.stringify(got)
    })
    await h.check('e.date-clears-notice', 'B', async () => {
      const text = await textOf(noticeOf(modal))
      return text === '' || `status text ${JSON.stringify(text)}`
    })
    await h.check('e.date-values-unchanged', 'B', async () => {
      const got = [await control(modal, 'description').inputValue(), await control(modal, 'amount').inputValue(),
        await control(modal, 'transaction_date').inputValue()]
      return (got[0] === 'Late' && got[1] === '30' && got[2] === '2099-12-31') || `values ${JSON.stringify(got)}`
    })
  } finally {
    for (const gate of gates) gate.release?.({ disarm: true })
    await Promise.all(gates.map((gate) => gate.stop?.()))
    await d.checkNoNativeDialogs(h, 'e', native)
    await ctx.close()
  }
}

// (f) Edit keeps one button.
async function scenarioF(browser) {
  console.log('\n=== (f) Edit has no Save and add another')
  const seed = await seedUser('f')
  await client.post(seed.user.token, '/transactions/', {
    account_id: seed.checking.id, transaction_type: 'debit', amount: 25, currency: 'PHP', description: 'Edit me',
    transaction_date: new Date().toISOString(), is_posted: true,
  })
  const { ctx, page, native } = await openPage(browser, seed.user, 'f', { dialog: false })
  try {
    await rowFor(page, 'Edit me').waitFor()
    await h.waitQuiet(page)
    await rowFor(page, 'Edit me').click()
    const actions = formModal(page, 'Transaction Actions')
    await actions.waitFor()
    await h.waitQuiet(page)
    await actions.getByRole('button', { name: 'Edit Transaction', exact: true }).click()
    const modal = formModal(page, 'Edit Transaction')
    await modal.waitFor()
    await h.waitQuiet(page)
    await h.check('f.update-button', 'G', async () =>
      (await modal.getByRole('button', { name: 'Update Transaction', exact: true }).count()) === 1 || 'no Update Transaction button')
    await h.check('f.no-add-another', 'G', async () => {
      const [button, notice] = [await anotherOf(modal).count(), await noticeOf(modal).count()]
      return (button === 0 && notice === 0) || `add-another buttons ${button}, status elements ${notice}`
    })
  } finally {
    await d.checkNoNativeDialogs(h, 'f', native)
    await ctx.close()
  }
}

// (g) Cancel after a save closes the dialog; the next open is fresh.
async function scenarioG(browser) {
  console.log('\n=== (g) Cancel after a save closes the dialog; the next open is fresh')
  const seed = await seedUser('g')
  const { ctx, page, native } = await openPage(browser, seed.user, 'g')
  try {
    const modal = createModal(page)
    await fillEntry(modal, 'Saved first', 70)
    await clickAnother(page, modal)
    await waitNotice(modal)
    await control(modal, 'description').fill('Half typed')
    await h.waitQuiet(page)
    await cancelOf(modal).click()
    await modal.waitFor({ state: 'detached', timeout: 5000 }).catch(() => {})
    await h.check('g.cancel-closes', 'B', async () => (await modal.count()) === 0 || 'the dialog is still open')
    const again = await openAddForm(page)
    await h.check('g.next-open-fresh', 'B', async () => {
      const got = {
        description: await control(again, 'description').inputValue(),
        amount: await control(again, 'amount').inputValue(),
        selected: await control(again, 'account_id').locator('[data-selected="true"]').count(),
        notice: await textOf(noticeOf(again)),
        error: await formErrorOf(again).count(),
      }
      return (got.description === '' && got.amount === '' && got.selected === 0 && got.notice === '' && got.error === 0) || JSON.stringify(got)
    })
    await h.check('g.saved-row-kept', 'B', async () =>
      (await apiRows(seed.user, ['Saved first'])).length === 1 || 'the saved row is missing')
  } finally {
    await d.checkNoNativeDialogs(h, 'g', native)
    await ctx.close()
  }
}

// (h) A foreign currency chosen while pending must not ride into the next posted entry.
async function scenarioH(browser) {
  console.log('\n=== (h) Pending, posted, add another: no stale hidden currency')
  const seed = await seedUser('h')
  const { ctx, page, native, creates } = await openPage(browser, seed.user, 'h')
  try {
    const modal = createModal(page)
    await control(modal, 'description').fill('Cash in')
    await chip(control(modal, 'account_id'), 'Sav Checking').click()
    await postedBox(modal).uncheck()
    await modal.locator('select').selectOption('USD')
    await control(modal, 'projected_amount').fill('10')
    await postedBox(modal).check()
    await control(modal, 'amount').fill('560')
    await clickAnother(page, modal)
    await waitNotice(modal)

    await h.check('h.first-usd', 'S', async () => {
      const body = creates[0]
      const rows = await apiRows(seed.user, ['Cash in'])
      const stored = rows[0]
      const ok = body && body.projected_currency === 'USD' && stored && stored.original_currency === 'USD'
      return ok || `first body currency ${body && body.projected_currency}, stored original_currency ${stored && stored.original_currency}`
    })
    await h.check('h.no-currency-select', 'B', async () => {
      const n = await modal.locator('select').count()
      return n === 0 || `${n} select(s) shown for a posted row`
    })
    await control(modal, 'description').fill('Tea')
    await control(modal, 'amount').fill('180')
    await clickAnother(page, modal)
    await waitNotice(modal, 'Saved "Tea ₱180.00"')
    await h.check('h.second-payload', 'B', async () => {
      const body = creates[1]
      return (creates.length === 2 && body && body.projected_currency === 'PHP') ||
        `${creates.length} POST(s), second projected_currency ${body && body.projected_currency}`
    })
    await h.check('h.second-stored', 'B', async () => {
      const stored = (await apiRows(seed.user, ['Tea']))[0]
      if (!stored) return 'the second row is not stored'
      const rate = stored.exchange_rate === null || stored.exchange_rate === undefined ? 1 : Number(stored.exchange_rate)
      const ok = stored.original_currency !== 'USD' && rate === 1 && Number(stored.amount) === 180
      return ok || `stored original_currency ${stored.original_currency}, rate ${stored.exchange_rate}, amount ${stored.amount}`
    })
  } finally {
    await d.checkNoNativeDialogs(h, 'h', native)
    await ctx.close()
  }
}

// (h2) The form is locked while the POST is held.
async function scenarioH2(browser) {
  console.log('\n=== (h2) Edits during the held POST are locked')
  const seed = await seedUser('h2', { entry: true, tagName: true })
  const { ctx, page, native } = await openPage(browser, seed.user, 'h2')
  let hold = null
  try {
    const modal = createModal(page)
    await control(modal, 'description').fill('Hold test')
    await chip(control(modal, 'account_id'), 'Sav Checking').click()
    await postedBox(modal).uncheck()
    const currency = modal.locator('select:not(:has(option[value=""]))')
    await currency.selectOption('USD')
    await control(modal, 'projected_amount').fill('10')

    const locks = {
      posted: postedBox(modal),
      currency,
      account: control(modal, 'account_id').getByRole('button').first(),
      type: chip(modal, 'Expense'),
      category: chip(modal, 'Sav Food'),
      tag: modal.locator('[data-testid="tag-picker"] button').first(),
      recurring: recurringSelect(modal),
      description: control(modal, 'description'),
    }
    await h.check('h2.controls-present', 'S', async () => {
      const missing = []
      for (const [name, locator] of Object.entries(locks)) if ((await locator.count()) === 0) missing.push(name)
      return missing.length === 0 || `missing controls: ${missing.join(', ')}`
    })

    hold = await h.gate(page, isCreate)
    await clickAnother(page, modal)
    await hold.waitHits(1)
    await page.waitForTimeout(300)
    await h.check('h2.locked-during-save', 'B', async () => {
      const enabled = []
      for (const [name, locator] of Object.entries(locks)) if (!(await locator.first().isDisabled())) enabled.push(name)
      const cancelEnabled = await cancelOf(modal).isEnabled()
      return (enabled.length === 0 && cancelEnabled) || `still enabled: ${enabled.join(', ') || 'none'}, Cancel enabled ${cancelEnabled}`
    })
    // A disabled input ignores a forced click: the mode must not flip mid-flight.
    await locks.posted.click({ force: true, timeout: 2000 }).catch(() => {})
    hold.release({ disarm: true })
    await waitNotice(modal)
    await h.check('h2.mode-kept-pending', 'B', async () => {
      const got = {
        posted: await postedBox(modal).isChecked(),
        currencyShown: await currency.isVisible(),
        currency: await currency.inputValue().catch(() => null),
        notice: await textOf(noticeOf(modal)),
      }
      const ok = !got.posted && got.currencyShown && got.currency === 'USD' && got.notice.startsWith('Saved "Hold test')
      return ok || JSON.stringify(got)
    })
    await waitButtons(modal)
    await h.check('h2.unlocked-and-focused', 'B', async () => {
      const got = {
        another: await anotherOf(modal).isEnabled(),
        primary: await primaryOf(modal).isEnabled(),
        description: await control(modal, 'description').isEnabled(),
        focused: await waitFocus(control(modal, 'description')),
      }
      return (got.another && got.primary && got.description && got.focused) || JSON.stringify(got)
    })
  } finally {
    hold?.release({ disarm: true })
    await d.checkNoNativeDialogs(h, 'h2', native)
    await ctx.close()
  }
}

// (i1) Cancel, reopen, then the abandoned POST succeeds.
async function scenarioI1(browser) {
  console.log('\n=== (i1) Cancel, reopen, release: success')
  const seed = await seedUser('i1')
  const { ctx, page, native } = await openPage(browser, seed.user, 'i1')
  let hold = null
  try {
    const modal = createModal(page)
    await fillEntry(modal, 'Abandoned', 60)
    hold = await h.gate(page, isCreate)
    await clickAnother(page, modal)
    await hold.waitHits(1)
    await h.waitQuiet(page)
    await cancelOf(modal).click()
    await modal.waitFor({ state: 'detached', timeout: 5000 }).catch(() => {})
    const again = await openAddForm(page)
    await control(again, 'description').fill('Fresh')
    // The fields are usable at once; the submit buttons wait for the abandoned save (see k).
    await h.check('i1.new-dialog-fields-enabled', 'B', async () => {
      const got = [await anotherOf(again).isDisabled(), await primaryOf(again).isDisabled(), await control(again, 'description').isEnabled(), await control(again, 'amount').isEnabled()]
      return got.every(Boolean) || `disabled: another, primary; enabled: description, amount ${JSON.stringify(got)}`
    })
    hold.release({ disarm: true })
    await h.sleep(1200)
    await h.waitQuiet(page)
    await h.check('i1.new-dialog-open', 'B', async () => (await again.isVisible()) || 'the new dialog closed')
    await h.check('i1.description-kept', 'B', async () => {
      const value = await control(again, 'description').inputValue()
      return value === 'Fresh' || `description ${JSON.stringify(value)}`
    })
    await h.check('i1.status-empty', 'B', async () => {
      const text = await textOf(noticeOf(again))
      return text === '' || `status ${JSON.stringify(text)}`
    })
    await h.check('i1.focus-not-stolen', 'B', async () =>
      (await isFocused(control(again, 'description'))) || `active field ${await activeField(page)}`)
    // The released POST is still on its way to the server: poll, bounded, rather than read once.
    await h.check('i1.api-holds-row', 'B', async () => {
      const rows = await until(() => apiRows(seed.user, ['Abandoned']), (r) => r.length === 1, 10000)
      return rows.length === 1 || 'the abandoned save did not store its row'
    })
    await h.check('i1.list-refreshes', 'B', async () => {
      const n = await until(() => rowFor(page, 'Abandoned').count(), (c) => c > 0)
      return n > 0 || 'the list does not show the abandoned save\'s row'
    })
  } finally {
    hold?.release({ disarm: true })
    await d.checkNoNativeDialogs(h, 'i1', native)
    await ctx.close()
  }
}

// (i2) Cancel, reopen, then the abandoned POST fails.
async function scenarioI2(browser) {
  console.log('\n=== (i2) Cancel, reopen, release: failure')
  const seed = await seedUser('i2')
  const { ctx, page, native } = await openPage(browser, seed.user, 'i2')
  let hold = null
  try {
    const modal = createModal(page)
    await fillEntry(modal, 'Abandoned', 60)
    hold = await h.gate(page, isCreate, { failStatus: 500 })
    await clickAnother(page, modal)
    await hold.waitHits(1)
    await h.waitQuiet(page)
    await cancelOf(modal).click()
    await modal.waitFor({ state: 'detached', timeout: 5000 }).catch(() => {})
    const again = await openAddForm(page)
    await control(again, 'description').fill('Fresh')
    hold.release({ disarm: true })
    await h.sleep(1200)
    await h.waitQuiet(page)
    await h.check('i2.no-form-error', 'B', async () => {
      const n = await formErrorOf(again).count()
      return n === 0 || `form error shown: ${JSON.stringify(await textOf(formErrorOf(again)))}`
    })
    await h.check('i2.nothing-cleared', 'B', async () => {
      const value = await control(again, 'description').inputValue()
      return (value === 'Fresh' && (await again.isVisible())) || `description ${JSON.stringify(value)}`
    })
    await h.check('i2.buttons-enabled', 'B', async () => {
      const got = [await anotherOf(again).isEnabled(), await primaryOf(again).isEnabled()]
      return got.every(Boolean) || `enabled: another, primary ${JSON.stringify(got)}`
    })
  } finally {
    hold?.release({ disarm: true })
    await d.checkNoNativeDialogs(h, 'i2', native)
    await ctx.close()
  }
}

// (j) Closing the dialog while its quiet refresh is held hands that refresh to the loader.
async function scenarioJ(browser) {
  console.log('\n=== (j) Cancel mid-refresh: the held refresh shows the screen loader')
  const seed = await seedUser('j')
  const { ctx, page, native } = await openWithPhaseRecorder(browser, seed.user, 'j')
  const gates = []
  try {
    const modal = createModal(page)
    await fillEntry(modal, 'Coffee', 180)
    const listGate = await h.gate(page, isMainList)
    const snapGate = await h.gate(page, isSnapshot)
    gates.push(listGate, snapGate)
    await clickAnother(page, modal)
    await waitNotice(modal, 'Saved "Coffee ₱180.00"')
    const held = await listGate.waitHits(1, 5000)
    await h.check('j.refresh-held', 'S', async () => held || 'the save started no list refetch')
    await page.waitForTimeout(300)
    await h.check('j.quiet-before-close', 'S', async () => {
      const blocked = blockedIn(await phasesOf(page))
      return blocked.length === 0 || `phases ${JSON.stringify(await phasesOf(page))}`
    })
    await cancelOf(modal).click()
    await modal.waitFor({ state: 'detached', timeout: 5000 }).catch(() => {})
    await page.waitForTimeout(1000)
    await h.check('j.close-releases-quiet', 'B', async () => {
      const blocked = blockedIn(await phasesOf(page))
      return blocked.length > 0 || `phases ${JSON.stringify(await phasesOf(page))}`
    })
    listGate.release({ disarm: true })
    snapGate.release({ disarm: true })
    const hidden = await h.waitPhase(page, 'hidden', 5000)
    await h.check('j.back-to-hidden', 'B', async () => hidden || 'the overlay did not return to hidden')
    await h.check('j.row-in-list', 'B', async () => {
      const n = await until(() => rowFor(page, 'Coffee').count(), (c) => c > 0)
      return n > 0 || 'the saved row is not in the list'
    })
  } finally {
    for (const gate of gates) gate.release({ disarm: true })
    await d.checkNoNativeDialogs(h, 'j', native)
    await ctx.close()
  }
}

// (j2) Closing the dialog before the upcoming tail starts sends that tail loud.
async function scenarioJ2(browser) {
  console.log('\n=== (j2) Close before the upcoming tail: the tail shows the screen loader')
  const seed = await seedUser('j2')
  const start = addDays(today(), 1)
  const rows = Array.from({ length: 105 }, (_, i) => i)
  for (let from = 0; from < rows.length; from += 15) {
    await Promise.all(rows.slice(from, from + 15).map((i) =>
      client.post(seed.user.token, '/transactions/', {
        account_id: seed.checking.id, transaction_type: 'debit', amount: 10, description: `Planned ${i}`,
        transaction_date: wire(addDays(start, i % 20)), is_posted: false,
      })))
  }
  const { ctx, page, native, log } = await openWithPhaseRecorder(browser, seed.user, 'j2')
  const gates = []
  try {
    const modal = createModal(page)
    await h.check('j2.setup-tail-requested', 'S', async () => {
      const tails = log.filter((e) => e.method === 'GET' && isUpcomingTail({ method: () => e.method, url: () => e.url }))
      return tails.length >= 1 || 'the page load sent no upcoming tail request'
    })
    await fillEntry(modal, 'Coffee', 180)
    const headGate = await h.gate(page, isUpcomingHead)
    gates.push(headGate)
    let tailResponses = 0
    page.on('response', (res) => { if (isUpcomingTail(res.request())) tailResponses++ })
    await clickAnother(page, modal)
    await headGate.waitHits(1, 5000)
    await waitNotice(modal, 'Saved "Coffee ₱180.00"')
    // The invalidation also refetches the tail entry; let that one finish.
    await until(async () => tailResponses, (n) => n >= 1, 5000)
    await h.check('j2.invalidation-tail-done', 'S', async () => tailResponses >= 1 || 'the invalidation sent no tail refetch')
    // The probe reads the app's own state: the held head is quiet before the close.
    await h.check('j2.quiet-probe', 'S', async () => {
      const pending = await quietPendingOf(page).catch((e) => `probe failed: ${e.message}`)
      return pending === true || `quietPending() before the close ${JSON.stringify(pending)}`
    })
    await cancelOf(modal).click()
    await modal.waitFor({ state: 'detached', timeout: 5000 }).catch(() => {})
    const tailGate = await h.gate(page, isUpcomingTail)
    gates.push(tailGate)
    headGate.release({ disarm: true })
    const tailHit = await tailGate.waitHits(1, 5000)
    await h.check('j2.tail-started', 'S', async () => tailHit || 'no tail request after the head response')
    await page.waitForTimeout(700)
    await h.check('j2.tail-loud', 'B', async () => {
      const got = { quiet: await quietPendingOf(page).catch((e) => `probe failed: ${e.message}`), phase: await h.overlayPhase(page) }
      return (got.quiet === false && (got.phase === 'shield' || got.phase === 'visible')) || JSON.stringify(got)
    })
    tailGate.release({ disarm: true })
    const hidden = await h.waitPhase(page, 'hidden', 5000)
    await h.check('j2.back-to-hidden', 'B', async () => hidden || 'the overlay did not return to hidden')
  } finally {
    for (const gate of gates) gate.release({ disarm: true })
    await d.checkNoNativeDialogs(h, 'j2', native)
    await ctx.close()
  }
}

// (k) Cancel mid-POST, reopen: no save until the abandoned save and its refresh have settled.
async function scenarioK(browser) {
  console.log('\n=== (k) Cancel, reopen: the submit buttons wait for the abandoned save and its refresh')
  const seed = await seedUser('k')
  const { ctx, page, native, creates } = await openPage(browser, seed.user, 'k')
  const gates = []
  try {
    const modal = createModal(page)
    await fillEntry(modal, 'Abandoned', 60)
    const postGate = await h.gate(page, isCreate)
    gates.push(postGate)
    await clickAnother(page, modal)
    await postGate.waitHits(1)
    await h.waitQuiet(page)
    await cancelOf(modal).click()
    await modal.waitFor({ state: 'detached', timeout: 5000 }).catch(() => {})
    const again = await openAddForm(page)
    await fillEntry(again, 'Fresh', 25)

    // Neither button, Enter nor a submit with no button may save while A's POST is held.
    const tryToSave = async () => {
      await control(again, 'amount').press('Enter')
      await again.locator('form').evaluate((form) => form.requestSubmit())
      await page.waitForTimeout(400)
    }
    const state = async () => ({
      another: await anotherOf(again).isDisabled(),
      primary: await primaryOf(again).isDisabled(),
      description: await control(again, 'description').isEnabled(),
      amount: await control(again, 'amount').isEnabled(),
    })
    const blocked = (got) => got.another && got.primary && got.description && got.amount
    const during = await state()
    await h.check('k.buttons-wait-for-post', 'B', async () => blocked(during) || JSON.stringify(during))
    await tryToSave()
    await h.check('k.no-save-during-post', 'B', async () =>
      (postGate.hits === 1 && creates.length === 1) || `POSTs: gate ${postGate.hits}, requests ${creates.length}`)

    // A's POST settles; the refresh its success starts is held.
    const held = [await h.gate(page, isMainList), await h.gate(page, isSnapshot), await h.gate(page, isAccountsList)]
    gates.push(...held)
    postGate.release({ disarm: true })
    const listHit = await held[0].waitHits(1, 5000)
    await h.check('k.refresh-held', 'S', async () => listHit || 'the abandoned save started no list refresh')
    await page.waitForTimeout(500)
    const refreshing = await state()
    await h.check('k.buttons-wait-for-refresh', 'B', async () => blocked(refreshing) || JSON.stringify(refreshing))
    await tryToSave()
    await h.check('k.no-save-during-refresh', 'B', async () =>
      creates.length === 1 || `POSTs while A's refresh is held: ${creates.length - 1}`)

    // Once A's refresh settles the buttons enable in this dialog, with no reopen.
    const events = []
    page.on('request', (r) => { if (isMainList(r)) events.push({ kind: 'list', r }) })
    page.on('response', (res) => {
      const r = res.request()
      if (isCreate(r) && (r.postData() || '').includes('"Fresh"')) events.push({ kind: 'b-post-done' })
    })
    for (const gate of held) gate.release({ disarm: true })
    await h.check('k.buttons-enabled', 'B', async () => (await waitButtons(again)) || JSON.stringify(await state()))
    await clickAnother(page, again)
    await waitNotice(again, 'Saved "Fresh ₱25.00"')
    await h.waitQuiet(page)
    await h.check('k.b-saved-fresh', 'B', async () => {
      const done = events.findIndex((e) => e.kind === 'b-post-done')
      if (done < 0) return 'B\'s save never completed'
      const lists = events.slice(done + 1).filter((e) => e.kind === 'list').length
      const n = await until(() => rowFor(page, 'Fresh').count(), (c) => c > 0)
      return (lists > 0 && n > 0) || `list GETs started after B succeeded ${lists}, B's row listed ${n}`
    })
  } finally {
    for (const gate of gates) gate.release({ disarm: true })
    await d.checkNoNativeDialogs(h, 'k', native)
    await ctx.close()
  }
}

const SCENARIOS = [
  ['a', scenarioA],
  ['b', scenarioB],
  ['c', scenarioC],
  ['d', scenarioD],
  ['d2', scenarioD2],
  ['d3', scenarioD3],
  ['d4', scenarioD4],
  ['e', scenarioE],
  ['f', scenarioF],
  ['g', scenarioG],
  ['h', scenarioH],
  ['h2', scenarioH2],
  ['i1', scenarioI1],
  ['i2', scenarioI2],
  ['j', scenarioJ],
  ['j2', scenarioJ2],
  ['k', scenarioK],
]

;(async () => {
  process.on('unhandledRejection', (e) => console.log(`  NOTE unhandled rejection: ${e && e.message ? e.message.split('\n')[0] : e}`))
  if (only && !SCENARIOS.some(([name]) => name === only)) {
    console.error(`Unknown scenario "${only}". Scenarios: ${SCENARIOS.map(([name]) => name).join(', ')}`)
    process.exit(2)
  }
  stack = await startLocalStack()
  client = h.apiClient(stack)
  const browser = await chromium.launch()
  for (const [name, run] of SCENARIOS) {
    if (only && only !== name) continue
    try {
      await run(browser)
    } catch (e) {
      await h.check(`${name}.completed`, 'B', async () => `scenario threw: ${e && e.stack ? e.stack.split('\n').slice(0, 3).join(' | ') : e}`)
    }
  }
  await browser.close()
  stack.stop()
  process.exit(h.report())
})().catch((e) => { console.error(e); stack?.stop(); process.exit(2) })
