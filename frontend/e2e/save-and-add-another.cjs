// Browser checks for STU-475 on Transactions: "Save and add another" in the Create
// Transaction dialog. (a) the happy path and the final primary save; (b) what is cleared
// and kept, including the recurring link, tags and posting date; (c) a transfer between
// currencies; (d) the save clears the form at once (`Saving "<desc> <figure>"…`), the
// form stays usable, a second save queues behind a held one (FIFO) and the primary button
// closes the dialog at once; (d2) an unrelated request is never held back by a save, and the
// refresh after the queue drains is fresh; (d3) with over 1000 rows in the Upcoming window,
// one ascending window request after the save, and nothing blocks; (d4) a primary save's held
// refresh keeps the list on screen; (e) a refused save (a failed toast whose Edit brings the
// entry back with the refusal inline) and the inline errors; (f) Edit has no such button;
// (g) Cancel after a save; (h) a pending foreign currency does not ride into a posted entry;
// (h2) nothing is locked while the POST is held; (i1, i2) Cancel, reopen, then the earlier
// POST settles (success, failure: a failed toast with Retry); (j) closing the dialog
// mid-refresh blocks nothing; (k) a reopened dialog's save queues behind the held one.
// STU-605: saves run in the background through the save outbox; there is no screen loader.
// Starts its own API and web app against a throwaway database (./_local_stack.cjs) and
// seeds through the API. Not wired into CI and not part of `pnpm build`. Run steps: see
// ./README.md.
//
// Check kinds: [B] behavioural, [S] structural (a failed one makes the run invalid),
// [G] guard. The script ends with RESULT: k/m and exits 0 only when every check passed,
// 1 when any failed, 2 for setup.
//
// Every page carries a probe, installed before login, that notes any busy overlay element;
// an [S] `<scenario>.overlay-probe` check proves it reads false once the page has settled.
//
// Usage: node frontend/e2e/save-and-add-another.cjs [scenario]
const { startLocalStack } = require('./_local_stack.cjs')
const h = require('./_smooth.cjs')
const d = require('./_dialogs.cjs')
const { pick, chipOf } = require('./_picker.cjs')

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
/** The card's Upcoming transaction requests: no search, a range that starts after Manila today. */
const isUpcomingList = (r) => isTxGet(r) && !param(r, 'search') && startDay(r) > today()
/** The card's Upcoming window request: ascending, so one request holds the soonest rows and the total. */
const isUpcomingWindow = (r) => isUpcomingList(r) && param(r, 'order') === 'asc'
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
const chip = chipOf
// The dialog's pickers are compact (STU-580): a chosen value shows as one line, 'true' when it starts with `name`.
const chosen = async (group, name) => {
  const line = group.locator('[data-picker-value]')
  return (await line.count()) === 1 && ((await line.textContent()) || '').trim().startsWith(name) ? 'true' : 'false'
}
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

// ─── Background saves (STU-605) ─────────────────────────────────────────────
// The screen loader is gone: Save and add another queues the save in the outbox, clears the
// form at once and says `Saving "<desc> <figure>"…`; the request goes in the background, one
// at a time, and a toast reports the outcome.
// A pending toast names the figure and the account ("Saving ₱180.00 to Sav Checking…"); a
// saved or failed one names the description.
const toastFor = (page, description) => page.locator('[data-testid="save-toast"]').filter({ hasText: description })
/** Waits (bounded) for the save toast naming `description` to be in `state`; true on arrival. */
const waitToast = (page, description, state, ms = 10000) =>
  toastFor(page, description).and(page.locator(`[data-state="${state}"]`)).first().waitFor({ timeout: ms }).then(() => true, () => false)
/** Waits (bounded) until `creates` holds at least `n` POST bodies; returns the count. */
const waitCreates = (creates, n, ms = 6000) => until(async () => creates.length, (c) => c >= n, ms)
/** Whether a busy overlay element was ever in the page (it must never be, STU-605). */
const overlaySeen = (page) => page.evaluate(() => window.__overlaySeen === true).catch(() => null)

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
 * tracked and its requests logged. A probe installed before login sets `__overlaySeen` if a
 * busy overlay element ever appears (STU-605: none may); `overlaySeen(page)` reads it.
 */
async function openPage(browser, user, scenario, { dialog = true } = {}) {
  const { ctx, page } = await h.newPage(browser, { timezoneId: 'Asia/Manila' })
  page.setDefaultTimeout(10000)
  const native = d.trackNativeDialogs(page)
  const log = h.logRequests(page)
  const creates = watchCreates(page)
  await page.addInitScript(() => {
    window.__overlaySeen = false
    const probe = () => { if (document.querySelector('[data-testid="busy-overlay"]')) window.__overlaySeen = true }
    const start = () => { new MutationObserver(probe).observe(document.documentElement, { childList: true, subtree: true }); probe() }
    if (document.documentElement) start()
    else document.addEventListener('DOMContentLoaded', start, { once: true })
  })
  await h.uiLogin(page, stack, user)
  await page.goto(`${stack.webUrl}/transactions`)
  await page.getByRole('button', { name: 'Add Transaction' }).first().waitFor()
  await h.waitQuiet(page)
  const modal = dialog ? await openAddForm(page) : null
  await h.waitQuiet(page)
  await h.check(`${scenario}.overlay-probe`, 'S', async () =>
    (await overlaySeen(page)) === false || `overlay probe ${await overlaySeen(page)} before the scenario began`)
  return { ctx, page, native, log, creates, modal }
}

/** Description, the account chip (if not already selected) and the posted amount. */
async function fillEntry(modal, description, amount, account = 'Sav Checking') {
  await control(modal, 'description').fill(description)
  const accountChip = chip(control(modal, 'account_id'), account)
  const selected = (await accountChip.count()) > 0 && (await accountChip.getAttribute('data-selected')) === 'true'
  if (!selected) await pick(control(modal, 'account_id'), account)
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
    await pick(control(modal, 'category_id'), 'Sav Food')
    const dateBefore = await control(modal, 'transaction_date').inputValue()
    await fillEntry(modal, 'Coffee', 180)
    await clickAnother(page, modal)
    await waitNotice(modal)
    await waitCreates(creates, 1)

    await h.check('a.one-post-typed-body', 'B', async () => {
      const body = creates[0]
      const ok = creates.length === 1 && body && body.description === 'Coffee' && Number(body.amount) === 180 &&
        body.account_id === seed.checking.id && body.transaction_type === 'debit' && body.is_posted === true
      return ok || `${creates.length} POST(s), body ${JSON.stringify(creates[0])}`
    })
    await h.check('a.dialog-open', 'B', async () => (await modal.isVisible()) || 'the dialog closed')
    await h.check('a.notice-text', 'B', async () => {
      const text = await textOf(noticeOf(modal))
      return text === 'Saving "Coffee ₱180.00"…' || `notice ${JSON.stringify(text)}`
    })
    await h.check('a.notice-role', 'B', async () =>
      (await noticeOf(modal).getAttribute('role')) === 'status' || 'the notice is not role=status')
    await h.check('a.cleared', 'B', async () => {
      const [description, amount] = [await control(modal, 'description').inputValue(), await control(modal, 'amount').inputValue()]
      return (description === '' && amount === '') || `description ${JSON.stringify(description)}, amount ${JSON.stringify(amount)}`
    })
    await h.check('a.kept', 'B', async () => {
      const got = {
        account: await chosen(control(modal, 'account_id'), 'Sav Checking'),
        type: await chip(modal, 'Expense').evaluate((el) => el.classList.contains('bg-ink')),
        category: await chosen(control(modal, 'category_id'), 'Sav Food'),
        date: await control(modal, 'transaction_date').inputValue(),
        posted: await postedBox(modal).isChecked(),
      }
      const ok = got.account === 'true' && got.type && got.category === 'true' && got.date === dateBefore && got.posted
      return ok || `kept ${JSON.stringify(got)}, date before ${dateBefore}`
    })
    await h.check('a.focus-description', 'B', async () =>
      (await waitFocus(control(modal, 'description'))) || `active field ${await activeField(page)}`)

    await control(modal, 'description').fill('Tea')
    await control(modal, 'amount').fill('95')
    await clickAnother(page, modal)
    await waitNotice(modal, 'Saving "Tea ₱95.00"…')
    await waitCreates(creates, 2)
    await h.check('a.second-add-another', 'B', async () => {
      const text = await textOf(noticeOf(modal))
      return (creates.length === 2 && text === 'Saving "Tea ₱95.00"…') || `${creates.length} POST(s), notice ${JSON.stringify(text)}`
    })

    await control(modal, 'description').fill('Snack')
    await control(modal, 'amount').fill('40')
    await clickPrimary(page, modal)
    await modal.waitFor({ state: 'detached', timeout: 6000 }).catch(() => {})
    await waitCreates(creates, 3)
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
    await waitCreates(creates, 1)

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
        category: await chosen(control(modal, 'category_id'), 'Sav Food'),
        date: await control(modal, 'transaction_date').inputValue(),
        posted: await postedBox(modal).isChecked(),
      }
      return (got.category === 'true' && got.date === dateBefore && got.posted) || `kept ${JSON.stringify(got)}, date before ${dateBefore}`
    })

    await control(modal, 'description').fill('Other')
    await control(modal, 'amount').fill('20')
    await clickAnother(page, modal)
    await waitNotice(modal, 'Saving "Other ₱20.00"…')
    await waitCreates(creates, 2)
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
    await pick(control(modal, 'account_id'), 'Sav Checking')
    await pick(control(modal, 'transfer_to_account_id'), 'Sav Dollars')
    await control(modal, 'amount').fill('100')
    await control(modal, 'received_amount').fill('2')
    await control(modal, 'transfer_fee').fill('5')
    await clickAnother(page, modal)
    await waitNotice(modal)
    await waitCreates(creates, 1)

    await h.check('c.first-posted', 'S', async () => creates.length === 1 || `${creates.length} POST(s)`)
    await h.check('c.destination-kept', 'B', async () =>
      (await chosen(control(modal, 'transfer_to_account_id'), 'Sav Dollars')) === 'true' ||
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

// (d) The save leaves the form at once: cleared, usable, one request at a time, nothing blocks.
async function scenarioD(browser) {
  console.log('\n=== (d) Save and add another clears at once; the saves queue; nothing blocks')
  const seed = await seedUser('d')
  const { ctx, page, native, creates } = await openPage(browser, seed.user, 'd')
  const gates = []
  try {
    const modal = createModal(page)
    await fillEntry(modal, 'Coffee', 180)
    const postGate = await h.gate(page, isCreate)
    gates.push(postGate)
    await clickAnother(page, modal)
    await postGate.waitHits(1)
    await h.check('d.post-no-block', 'B', async () => {
      const got = {
        hit: postGate.hits,
        notice: await textOf(noticeOf(modal)),
        description: await control(modal, 'description').inputValue(),
        another: await anotherOf(modal).isEnabled(),
        primary: await primaryOf(modal).isEnabled(),
        descriptionEnabled: await control(modal, 'description').isEnabled(),
        pending: await waitToast(page, '₱180.00', 'pending', 3000),
        overlay: await overlaySeen(page),
      }
      const ok = got.hit === 1 && got.notice === 'Saving "Coffee ₱180.00"…' && got.description === '' &&
        got.another && got.primary && got.descriptionEnabled && got.pending && got.overlay === false
      return ok || JSON.stringify(got)
    })

    // An empty form submitted with no button (requestSubmit) is refused by validation: no POST.
    await modal.locator('form').evaluate((form) => form.requestSubmit())
    await page.waitForTimeout(300)
    await h.check('d.inflight-guard', 'B', async () =>
      (postGate.hits === 1 && creates.length === 1) || `POSTs after an empty requestSubmit: gate ${postGate.hits}, requests ${creates.length}`)

    // A second save while the first is held is queued behind it, not sent alongside.
    await control(modal, 'description').fill('Tea')
    await control(modal, 'amount').fill('20')
    await anotherOf(modal).click()
    await waitNotice(modal, 'Saving "Tea ₱20.00"…')
    await page.waitForTimeout(400)
    await h.check('d.second-queued', 'B', async () =>
      (postGate.hits === 1 && creates.length === 1) || `POSTs while the first is held: gate ${postGate.hits}, requests ${creates.length}`)

    // Released: both go, in order, and the list refreshes once the queue drains.
    const listGate = await h.gate(page, isMainList)
    gates.push(listGate)
    postGate.release({ disarm: true })
    await waitCreates(creates, 2)
    await h.check('d.fifo', 'B', async () =>
      (creates.length === 2 && creates[0]?.description === 'Coffee' && creates[1]?.description === 'Tea') ||
      `bodies ${JSON.stringify(creates.map((b) => b && b.description))}`)
    const listHit = await listGate.waitHits(1, 5000)
    await h.check('d.gets-received', 'S', async () => listHit || 'the drained queue started no list refetch')
    await page.keyboard.type('Rice')
    await h.check('d.refetch-no-block', 'B', async () => {
      const got = {
        typed: await control(modal, 'description').inputValue(),
        focus: await activeField(page),
        another: await anotherOf(modal).isEnabled(),
        overlay: await overlaySeen(page),
      }
      return (got.typed === 'Rice' && got.focus === 'description' && got.another && got.overlay === false) || JSON.stringify(got)
    })
    listGate.release({ disarm: true })
    await h.waitQuiet(page)
    await h.check('d.row-appears', 'B', async () => {
      const n = await until(async () => [await rowFor(page, 'Coffee').count(), await rowFor(page, 'Tea').count()], (c) => c.every((x) => x > 0))
      return n.every((x) => x > 0) || `rows (Coffee, Tea) ${JSON.stringify(n)}`
    })

    // The primary button closes the dialog at once, its POST held behind it.
    const holdPrimary = await h.gate(page, isCreate)
    gates.push(holdPrimary)
    await control(modal, 'amount').fill('15')
    await clickPrimary(page, modal)
    await holdPrimary.waitHits(1)
    await h.check('d.primary-closes-at-once', 'B', async () =>
      ((await modal.count()) === 0 && (await waitToast(page, '₱15.00', 'pending', 3000)) && (await overlaySeen(page)) === false) ||
      `dialog open ${(await modal.count()) > 0}, overlay ${await overlaySeen(page)}`)
    holdPrimary.release({ disarm: true })
    await h.check('d.primary-saved', 'B', async () => (await waitToast(page, 'Rice', 'saved')) || 'no Saved toast for Rice')
    await h.waitQuiet(page)
  } finally {
    for (const gate of gates) gate.release({ disarm: true })
    await d.checkNoNativeDialogs(h, 'd', native)
    await ctx.close()
  }
}

// (d2) Unrelated requests are never held back by a save; the drained queue refreshes once,
// with requests sent after the last save settled.
async function scenarioD2(browser) {
  console.log('\n=== (d2) An unrelated request goes while a save is held; the refresh after the drain is fresh')
  const seed = await seedUser('d2')
  const { ctx, page, native } = await openPage(browser, seed.user, 'd2')
  const gates = []
  try {
    const modal = createModal(page)
    await fillEntry(modal, 'Coffee', 180)
    const search = page.locator('[data-testid="transactions-search"]')
    const postGate = await h.gate(page, isCreate)
    gates.push(postGate)
    await clickAnother(page, modal)
    await postGate.waitHits(1)

    // While the save is held, an unrelated request (a new search key) is sent and answered.
    const searched = page.waitForResponse((res) => isSearchList('zz')(res.request()), { timeout: 5000 }).then(() => true, () => false)
    await search.fill('zz', { force: true })
    await h.check('d2.unrelated-during-post', 'B', async () =>
      ((await searched) && postGate.hits === 1 && (await overlaySeen(page)) === false) || `search answered ${await searched}, overlay ${await overlaySeen(page)}`)
    await search.fill('', { force: true })

    // The dialog is usable while the save is held: a second save queues.
    const events = []
    page.on('request', (r) => { if (isMainList(r) || isSnapshot(r) || isAccountsList(r)) events.push({ kind: 'get', r }) })
    page.on('response', (res) => {
      const r = res.request()
      if (isCreate(r) && (r.postData() || '').includes('"Dinner"')) events.push({ kind: 'second-post-done' })
    })
    await fillEntry(modal, 'Dinner', 40)
    await primaryOf(modal).click()
    await h.check('d2.buttons-never-wait', 'B', async () => (await modal.count()) === 0 || 'the primary save did not close the dialog')
    postGate.release({ disarm: true })
    await waitToast(page, 'Dinner', 'saved')
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
        await until(() => rowFor(page, 'Coffee').count(), (c) => c > 0),
        await until(() => rowFor(page, 'Dinner').count(), (c) => c > 0),
      ]
      const ok = shown !== undefined && Number(shown) === Number(truth) && listed.every((n) => n > 0)
      return ok || `balance on the page ${shown}, server ${truth}, rows listed (Coffee, Dinner) ${JSON.stringify(listed)}, ${JSON.stringify(counts)}`
    })
  } finally {
    for (const gate of gates) gate.release({ disarm: true })
    await d.checkNoNativeDialogs(h, 'd2', native)
    await ctx.close()
  }
}

// (d3) Over 1000 future rows: one ascending window request, nothing after it, nothing blocks.
async function scenarioD3(browser) {
  console.log('\n=== (d3) 1005 rows in the Upcoming window: one ascending request after Save and add another')
  const seed = await seedUser('d3')
  const start = addDays(today(), 1)
  const rows = Array.from({ length: 1005 }, (_, i) => i)
  const seedStart = Date.now()
  for (let from = 0; from < rows.length; from += 15) {
    await Promise.all(rows.slice(from, from + 15).map((i) =>
      client.post(seed.user.token, '/transactions/', {
        account_id: seed.checking.id, transaction_type: 'debit', amount: 10, description: `Planned ${i}`,
        transaction_date: wire(addDays(start, i % 30)), is_posted: false,
      })))
  }
  console.log(`    seeded ${rows.length} rows through the API in ${((Date.now() - seedStart) / 1000).toFixed(1)} s`)
  const { ctx, page, native, log } = await openPage(browser, seed.user, 'd3')
  const gates = []
  try {
    const modal = createModal(page)
    const asRequest = (e) => ({ method: () => e.method, url: () => e.url })
    await h.check('d3.setup-one-window-request', 'S', async () => {
      const windows = log.filter((e) => e.method === 'GET' && isUpcomingWindow(asRequest(e)))
      const shapes = windows.map((e) => [new URL(e.url).searchParams.get('order'), new URL(e.url).searchParams.get('limit'), Number(new URL(e.url).searchParams.get('offset') ?? '0')])
      const wrong = windows.length !== 1 || shapes[0][0] !== 'asc' || shapes[0][1] !== '100' || shapes[0][2] !== 0
      return !wrong || `the page load sent ${windows.length} window request(s): ${JSON.stringify(shapes)}`
    })
    await h.check('d3.setup-no-offset-above-zero', 'S', async () => {
      const later = log.filter((e) => e.method === 'GET' && isUpcomingList(asRequest(e)) && Number(new URL(e.url).searchParams.get('offset') ?? '0') > 0)
      return later.length === 0 || `${later.length} upcoming request(s) with an offset above 0`
    })
    await fillEntry(modal, 'Coffee', 180)
    const windowGate = await h.gate(page, isUpcomingWindow)
    gates.push(windowGate)
    let windowRequests = 0
    page.on('request', (r) => { if (isUpcomingList(r)) windowRequests++ })
    await clickAnother(page, modal)
    await windowGate.waitHits(1, 5000)
    await h.check('d3.window-refetched', 'S', async () => windowGate.hits >= 1 || 'the invalidation sent no window refetch')
    await page.keyboard.type('Tea')
    await h.check('d3.window-no-block', 'B', async () => {
      const got = { typed: await control(modal, 'description').inputValue(), overlay: await overlaySeen(page) }
      return (got.typed === 'Tea' && got.overlay === false) || JSON.stringify(got)
    })
    windowGate.release({ disarm: true })
    await h.waitQuiet(page)
    await page.waitForTimeout(700)
    await h.check('d3.no-second-window-request', 'B', async () => windowRequests === 1 || `${windowRequests} Upcoming request(s) after the save, expected exactly 1`)
  } finally {
    for (const gate of gates) gate.release({ disarm: true })
    await d.checkNoNativeDialogs(h, 'd3', native)
    await ctx.close()
  }
}

// (d4) A primary save's refresh: the dialog closed at once, the list keeps its rows while the
// refresh is held, and the saved row lands once it is released.
async function scenarioD4(browser) {
  console.log('\n=== (d4) A primary save\'s refresh blocks nothing and keeps the list on screen')
  const seed = await seedUser('d4')
  const { ctx, page, native } = await openPage(browser, seed.user, 'd4')
  const gates = []
  try {
    const modal = createModal(page)
    await fillEntry(modal, 'First', 30)
    await clickAnother(page, modal)
    await waitNotice(modal)
    await h.check('d4.add-another-no-block', 'B', async () => {
      const notice = await textOf(noticeOf(modal))
      return (notice === 'Saving "First ₱30.00"…' && (await overlaySeen(page)) === false) || `overlay ${await overlaySeen(page)}, notice ${JSON.stringify(notice)}`
    })
    await h.waitQuiet(page)
    await until(() => rowFor(page, 'First').count(), (c) => c > 0)

    const listGate = await h.gate(page, isMainList)
    gates.push(listGate)
    await control(modal, 'description').fill('Plain')
    await control(modal, 'amount').fill('40')
    await clickPrimary(page, modal)
    const hit = await listGate.waitHits(1, 5000)
    await h.check('d4.plain-refetch-no-block', 'B', async () => {
      const got = { hit, dialog: await modal.count(), first: await rowFor(page, 'First').count(), overlay: await overlaySeen(page) }
      return (got.hit && got.dialog === 0 && got.first > 0 && got.overlay === false) || JSON.stringify(got)
    })
    listGate.release({ disarm: true })
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
  const { ctx, page, native, creates } = await openPage(browser, seed.user, 'e')
  const gates = []
  try {
    const modal = createModal(page)
    await fillEntry(modal, 'Err probe', 50)
    const fail = await h.failWith(page, isCreate, 400, { times: 1 })
    gates.push(fail)
    await clickAnother(page, modal)
    // The refusal arrives after the form cleared: a failed toast, whose Edit brings the entry back.
    const failed = await waitToast(page, 'Err probe', 'failed')
    await h.check('e.failed-toast', 'B', async () => {
      const t = failed ? await textOf(toastFor(page, 'Err probe').locator('[data-testid="save-toast-message"]')) : ''
      const got = { failed, t, retry: await toastFor(page, 'Err probe').locator('[data-testid="save-toast-retry"]').count(), overlay: await overlaySeen(page) }
      return (failed && t.includes('Couldn\'t save "Err probe"') && t.includes('stu335 injected failure 400') && got.retry === 0 && got.overlay === false) || JSON.stringify(got)
    })
    await toastFor(page, 'Err probe').locator('[data-testid="save-toast-edit"]').click()
    await formErrorOf(modal).waitFor({ timeout: 5000 }).catch(() => {})
    await h.check('e.server-reason', 'B', async () => {
      const text = await textOf(formErrorOf(modal))
      return text.includes('stu335 injected failure 400') || `form error ${JSON.stringify(text)}`
    })
    await h.check('e.nothing-cleared', 'B', async () => {
      const got = [await control(modal, 'description').inputValue(), await control(modal, 'amount').inputValue(),
        await chosen(control(modal, 'account_id'), 'Sav Checking')]
      return (got[0] === 'Err probe' && got[1] === '50' && got[2] === 'true') || `kept ${JSON.stringify(got)}`
    })
    await h.check('e.status-mounted-empty', 'B', async () => {
      const [n, text] = [await noticeOf(modal).count(), await textOf(noticeOf(modal))]
      return (n === 1 && text === '') || `status elements ${n}, text ${JSON.stringify(text)}`
    })
    // The fields and the buttons are usable at once: nothing waits for a refetch.
    await h.check('e.fields-enabled', 'B', async () => {
      const got = [await control(modal, 'description').isEnabled(), await control(modal, 'amount').isEnabled(),
        await anotherOf(modal).isEnabled(), await primaryOf(modal).isEnabled()]
      return got.every(Boolean) || `description, amount, another, primary enabled ${JSON.stringify(got)}`
    })
    await h.check('e.toast-gone-after-edit', 'B', async () =>
      (await h.expectAbsentFor(page, toastFor(page, 'Err probe'), 500)) || 'the failed toast is still shown')
    await h.waitQuiet(page)

    // A save that works leaves a status line to be cleared by the next failed attempt.
    await clickAnother(page, modal)
    await waitNotice(modal, 'Saving "Err probe ₱50.00"…')

    // An empty amount: the field's own error, focus on it, no POST.
    await h.waitQuiet(page)
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
    await waitNotice(modal, 'Saving "Dated ₱25.00"…')
    await h.waitQuiet(page)
    await control(modal, 'description').fill('Late')
    await control(modal, 'amount').fill('30')
    await control(modal, 'transaction_date').fill('2099-12-31')
    // STU-582: a future date unticks Mark as posted; tick it again so this save is the posted one it was.
    await modal.getByRole('checkbox', { name: 'Mark as posted' }).check()
    before = creates.length
    await clickAnother(page, modal)
    await modal.locator('[data-testid="record-date-error"]').first().waitFor({ timeout: 3000 }).catch(() => {})
    await page.waitForTimeout(300)
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
    await pick(control(modal, 'account_id'), 'Sav Checking')
    await postedBox(modal).uncheck()
    await modal.locator('select').selectOption('USD')
    await control(modal, 'projected_amount').fill('10')
    await postedBox(modal).check()
    await control(modal, 'amount').fill('560')
    await clickAnother(page, modal)
    await waitNotice(modal)
    await waitCreates(creates, 1)
    await waitToast(page, 'Cash in', 'saved')

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
    await waitNotice(modal, 'Saving "Tea ₱180.00"…')
    await waitCreates(creates, 2)
    await waitToast(page, 'Tea', 'saved')
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

// (h2) Nothing is locked while the POST is held: the form is cleared and usable at once, and
// the pending mode and currency the user chose stay for the next entry.
async function scenarioH2(browser) {
  console.log('\n=== (h2) The form stays usable while the POST is held')
  const seed = await seedUser('h2', { entry: true, tagName: true })
  const { ctx, page, native, creates } = await openPage(browser, seed.user, 'h2')
  let hold = null
  try {
    const modal = createModal(page)
    await control(modal, 'description').fill('Hold test')
    await pick(control(modal, 'account_id'), 'Sav Checking')
    await postedBox(modal).uncheck()
    const currency = modal.locator('select:not(:has(option[value=""]))')
    await currency.selectOption('USD')
    await control(modal, 'projected_amount').fill('10')

    const controls = {
      posted: postedBox(modal),
      currency,
      account: control(modal, 'account_id').getByRole('button').first(),
      type: chip(modal, 'Expense'),
      category: control(modal, 'category_id').getByRole('button').first(),
      tag: modal.locator('[data-testid="tag-picker"] button').first(),
      recurring: recurringSelect(modal),
      description: control(modal, 'description'),
      another: anotherOf(modal),
      primary: primaryOf(modal),
    }
    await h.check('h2.controls-present', 'S', async () => {
      const missing = []
      for (const [name, locator] of Object.entries(controls)) if ((await locator.count()) === 0) missing.push(name)
      return missing.length === 0 || `missing controls: ${missing.join(', ')}`
    })

    hold = await h.gate(page, isCreate)
    await clickAnother(page, modal)
    await hold.waitHits(1)
    await h.check('h2.usable-during-save', 'B', async () => {
      const disabled = []
      for (const [name, locator] of Object.entries(controls)) if (await locator.first().isDisabled()) disabled.push(name)
      return disabled.length === 0 || `disabled while the POST is held: ${disabled.join(', ')}`
    })
    await h.check('h2.mode-kept-pending', 'B', async () => {
      const got = {
        posted: await postedBox(modal).isChecked(),
        currencyShown: await currency.isVisible(),
        currency: await currency.inputValue().catch(() => null),
        notice: await textOf(noticeOf(modal)),
      }
      const ok = !got.posted && got.currencyShown && got.currency === 'USD' && got.notice.startsWith('Saving "Hold test')
      return ok || JSON.stringify(got)
    })
    await h.check('h2.focused', 'B', async () => (await waitFocus(control(modal, 'description'))) || `active field ${await activeField(page)}`)
    hold.release({ disarm: true })
    await h.check('h2.saved', 'B', async () => {
      const ok = await waitToast(page, 'Hold test', 'saved')
      return (ok && creates.length === 1 && creates[0]?.projected_currency === 'USD') || `saved ${ok}, bodies ${JSON.stringify(creates)}`
    })
  } finally {
    hold?.release({ disarm: true })
    await d.checkNoNativeDialogs(h, 'h2', native)
    await ctx.close()
  }
}

// (i1) Cancel, reopen, then the earlier POST succeeds: it was never abandoned, only queued.
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
    await cancelOf(modal).click()
    await modal.waitFor({ state: 'detached', timeout: 5000 }).catch(() => {})
    await page.getByRole('button', { name: 'Add Transaction' }).first().click()
    const again = createModal(page)
    await again.waitFor()
    await control(again, 'description').fill('Fresh')
    // Everything is usable at once: nothing waits for the earlier save.
    await h.check('i1.new-dialog-fields-enabled', 'B', async () => {
      const got = [await anotherOf(again).isEnabled(), await primaryOf(again).isEnabled(), await control(again, 'description').isEnabled(), await control(again, 'amount').isEnabled()]
      return got.every(Boolean) || `enabled: another, primary, description, amount ${JSON.stringify(got)}`
    })
    hold.release({ disarm: true })
    await h.check('i1.saved-toast', 'B', async () => (await waitToast(page, 'Abandoned', 'saved')) || 'no Saved toast for the earlier save')
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
    await h.check('i1.api-holds-row', 'B', async () => {
      const rows = await until(() => apiRows(seed.user, ['Abandoned']), (r) => r.length === 1, 10000)
      return rows.length === 1 || 'the earlier save did not store its row'
    })
    await h.check('i1.list-refreshes', 'B', async () => {
      const n = await until(() => rowFor(page, 'Abandoned').count(), (c) => c > 0)
      return n > 0 || 'the list does not show the earlier save\'s row'
    })
  } finally {
    hold?.release({ disarm: true })
    await d.checkNoNativeDialogs(h, 'i1', native)
    await ctx.close()
  }
}

// (i2) Cancel, reopen, then the earlier POST fails: a failed toast, the new dialog untouched.
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
    await cancelOf(modal).click()
    await modal.waitFor({ state: 'detached', timeout: 5000 }).catch(() => {})
    await page.getByRole('button', { name: 'Add Transaction' }).first().click()
    const again = createModal(page)
    await again.waitFor()
    await control(again, 'description').fill('Fresh')
    hold.release({ disarm: true })
    await h.check('i2.failed-toast', 'B', async () => {
      const failed = await waitToast(page, 'Abandoned', 'failed')
      const retry = await toastFor(page, 'Abandoned').locator('[data-testid="save-toast-retry"]').count()
      return (failed && retry === 1) || `failed ${failed}, Retry buttons ${retry}`
    })
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

// (j) Closing the dialog while the refresh after its save is held: nothing blocks, the list
// keeps its rows, and the saved row lands once the refresh is released.
async function scenarioJ(browser) {
  console.log('\n=== (j) Cancel mid-refresh: nothing blocks, the list stays on screen')
  const seed = await seedUser('j')
  await client.post(seed.user.token, '/transactions/', {
    account_id: seed.checking.id, transaction_type: 'debit', amount: 12, currency: 'PHP', description: 'Earlier row',
    transaction_date: new Date().toISOString(), is_posted: true,
  })
  const { ctx, page, native } = await openPage(browser, seed.user, 'j')
  const gates = []
  try {
    const modal = createModal(page)
    await fillEntry(modal, 'Coffee', 180)
    const listGate = await h.gate(page, isMainList)
    const snapGate = await h.gate(page, isSnapshot)
    gates.push(listGate, snapGate)
    await clickAnother(page, modal)
    await waitNotice(modal, 'Saving "Coffee ₱180.00"…')
    const held = await listGate.waitHits(1, 5000)
    await h.check('j.refresh-held', 'S', async () => held || 'the save started no list refetch')
    await cancelOf(modal).click()
    await modal.waitFor({ state: 'detached', timeout: 5000 }).catch(() => {})
    await h.check('j.close-no-block', 'B', async () => {
      const got = { dialog: await modal.count(), earlier: await rowFor(page, 'Earlier row').count(), overlay: await overlaySeen(page) }
      return (got.dialog === 0 && got.earlier > 0 && got.overlay === false) || JSON.stringify(got)
    })
    await h.check('j.page-takes-input', 'B', async () => {
      await page.getByRole('button', { name: 'Add Transaction' }).first().click()
      const ok = await createModal(page).waitFor({ timeout: 3000 }).then(() => true, () => false)
      if (ok) await cancelOf(createModal(page)).click()
      return ok || 'the Create dialog did not open while the refresh was held'
    })
    listGate.release({ disarm: true })
    snapGate.release({ disarm: true })
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

// (k) Cancel mid-POST, reopen: the new dialog saves at once; its save queues behind the
// first, which goes first; both rows land.
async function scenarioK(browser) {
  console.log('\n=== (k) Cancel, reopen: the next save queues behind the held one')
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
    await cancelOf(modal).click()
    await modal.waitFor({ state: 'detached', timeout: 5000 }).catch(() => {})
    await page.getByRole('button', { name: 'Add Transaction' }).first().click()
    const again = createModal(page)
    await again.waitFor()
    await fillEntry(again, 'Fresh', 25)
    await h.check('k.buttons-enabled', 'B', async () => {
      const got = [await anotherOf(again).isEnabled(), await primaryOf(again).isEnabled()]
      return got.every(Boolean) || `enabled: another, primary ${JSON.stringify(got)}`
    })
    await anotherOf(again).click()
    await waitNotice(again, 'Saving "Fresh ₱25.00"…')
    await page.waitForTimeout(400)
    await h.check('k.queued-behind-first', 'B', async () =>
      (postGate.hits === 1 && creates.length === 1) || `POSTs while the first is held: gate ${postGate.hits}, requests ${creates.length}`)
    const events = []
    page.on('request', (r) => { if (isMainList(r)) events.push({ kind: 'list', r }) })
    page.on('response', (res) => {
      const r = res.request()
      if (isCreate(r) && (r.postData() || '').includes('"Fresh"')) events.push({ kind: 'b-post-done' })
    })
    postGate.release({ disarm: true })
    await waitToast(page, 'Fresh', 'saved')
    await h.waitQuiet(page)
    await h.check('k.fifo', 'B', async () =>
      (creates.length === 2 && creates[0]?.description === 'Abandoned' && creates[1]?.description === 'Fresh') ||
      `bodies ${JSON.stringify(creates.map((b) => b && b.description))}`)
    await h.check('k.b-saved-fresh', 'B', async () => {
      const done = events.findIndex((e) => e.kind === 'b-post-done')
      if (done < 0) return 'B\'s save never completed'
      const lists = events.slice(done + 1).filter((e) => e.kind === 'list').length
      const n = [await until(() => rowFor(page, 'Fresh').count(), (c) => c > 0), await rowFor(page, 'Abandoned').count()]
      return (lists > 0 && n.every((x) => x > 0)) || `list GETs started after B succeeded ${lists}, rows (Fresh, Abandoned) ${JSON.stringify(n)}`
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
