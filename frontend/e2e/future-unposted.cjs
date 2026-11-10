// Browser checks for STU-582: a future Transaction Date in the Add Transaction dialog
// starts the row as not posted. "Mark as posted" starts ticked; when the user changes the
// date to a day after the browser's local today, the box unticks, the posting date clears
// and the amount fields swap exactly as unticking by hand does.
//
// (a) a future date unticks the box, clears the posting date and shows the same fields as
// a hand untick; the saved payload has is_posted false;
// (b) ticking the box again with the date still in the future keeps it ticked, shows the
// note "This date is in the future. It will be saved as already posted." and saves
// is_posted true;
// (c) moving the date back to today or earlier removes the note and never ticks the box;
// (d) Edit never changes the posted state on load: a posted future-dated row opens ticked
// with no note, and only a date change the user makes unticks it.
// Every scenario checks that no browser dialog fired.
//
// Starts its own API and web app against a throwaway database (./_local_stack.cjs) and
// seeds through the API. Not wired into CI and not part of `pnpm build`. Run steps: see
// ./README.md.
//
// Check kinds: [B] behavioural, [S] structural, [G] guard. The script ends with RESULT: k/m
// and exits 0 only when every check passed, 1 when any failed, 2 for setup.
//
// Usage: node frontend/e2e/future-unposted.cjs [scenario]
const { startLocalStack } = require('./_local_stack.cjs')
const h = require('./_smooth.cjs')
const d = require('./_dialogs.cjs')
const { pick } = require('./_picker.cjs')

const playwrightPath = process.env.PLAYWRIGHT_PATH || 'playwright'
let chromium
try {
  ;({ chromium } = require(playwrightPath))
} catch {
  console.error(`Cannot load Playwright from "${playwrightPath}". Set PLAYWRIGHT_PATH (see frontend/e2e/README.md).`)
  process.exit(2)
}

const only = process.argv[2]
let stack, client, user, account

const NOTE = 'This date is in the future. It will be saved as already posted.'
const pad = (n) => String(n).padStart(2, '0')
/** The browser's local day (the browser runs in this process's time zone), `offset` days from today. */
const day = (offset = 0) => {
  const date = new Date()
  date.setDate(date.getDate() + offset)
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

const formModal = (page, heading) => page.locator('div.fixed').filter({ has: page.getByRole('heading', { name: heading, exact: true }) })
const control = (modal, key) => modal.locator(`[data-field="${key}"]`)
const postedBox = (modal) => modal.getByRole('checkbox', { name: 'Mark as posted' })
const noteOf = (modal) => modal.locator('[data-testid="future-posted-note"]')
const isCreate = (r) => r.method() === 'POST' && new URL(r.url()).pathname.replace(/\/$/, '').endsWith('/transactions')
const isUpdate = (r) => r.method() === 'PUT' && /\/transactions\/\d+$/.test(new URL(r.url()).pathname)
const rowFor = (page, description) => page.locator('article[role="button"]').filter({ hasText: description }).first()

async function openPage(browser) {
  const { ctx, page } = await h.newPage(browser)
  page.setDefaultTimeout(10000)
  const native = d.trackNativeDialogs(page)
  await h.uiLogin(page, stack, user)
  await page.goto(`${stack.webUrl}/transactions`)
  await page.getByRole('button', { name: 'Add Transaction' }).first().waitFor()
  await h.waitQuiet(page)
  return { ctx, page, native }
}

async function openAdd(page) {
  await page.getByRole('button', { name: 'Add Transaction' }).first().click()
  const modal = formModal(page, 'Create Transaction')
  await modal.waitFor()
  await h.waitQuiet(page)
  await pick(control(modal, 'account_id'), account.name)
  return modal
}

/** The form's controls once the box is unticked or ticked: data-field keys plus the posting date. */
const shape = async (modal) => ({
  fields: await modal.locator('[data-field]').evaluateAll((els) => els.map((e) => e.getAttribute('data-field')).sort()),
  posting: await control(modal, 'posting_date').inputValue(),
  postingDisabled: await control(modal, 'posting_date').isDisabled(),
})

/** Fills the amount in whichever field the form shows, saves and returns the sent JSON. */
async function save(page, modal, buttonName, matcher, description) {
  if (description) await control(modal, 'description').fill(description)
  const amountKey = (await control(modal, 'amount').count()) ? 'amount' : 'projected_amount'
  if (!(await control(modal, amountKey).inputValue())) await control(modal, amountKey).fill('15')
  const [request] = await Promise.all([page.waitForRequest(matcher), modal.getByRole('button', { name: buttonName, exact: true }).click()])
  await modal.waitFor({ state: 'detached' })
  await h.waitQuiet(page)
  return request.postDataJSON()
}

// (a) a future date unticks the box exactly as unticking by hand.
async function scenarioA(browser) {
  console.log('\n=== (a) a future date unticks Mark as posted like unticking by hand')
  const { ctx, page, native } = await openPage(browser)
  try {
    let modal = await openAdd(page)
    await h.check('a.starts-ticked', 'B', async () => (await postedBox(modal).isChecked()) || 'not ticked on open')
    await postedBox(modal).uncheck()
    const byHand = await shape(modal)
    await postedBox(modal).check()
    await control(modal, 'transaction_date').fill(day(3))
    await h.check('a.unticked', 'B', async () => (!(await postedBox(modal).isChecked())) || 'still ticked')
    await h.check('a.posting-date-cleared', 'B', async () => {
      const s = await shape(modal)
      return (s.posting === '' && s.postingDisabled) || `posting ${JSON.stringify(s.posting)}, disabled ${s.postingDisabled}`
    })
    await h.check('a.same-shape-as-hand-untick', 'B', async () => {
      const s = await shape(modal)
      return JSON.stringify(s) === JSON.stringify(byHand) || `${JSON.stringify(s)} vs by hand ${JSON.stringify(byHand)}`
    })
    await h.check('a.no-note-when-unticked', 'B', async () => (await noteOf(modal).count()) === 0 || 'note shown')
    const sent = await save(page, modal, 'Create Transaction', isCreate, 'Future unposted')
    await h.check('a.payload-is-posted-false', 'B', async () => sent.is_posted === false || `is_posted ${sent.is_posted}`)
    await h.check('a.payload-no-posting-date', 'B', async () => !sent.posting_date || `posting_date ${sent.posting_date}`)
    // A past or same-day date does not untick the box.
    modal = await openAdd(page)
    await control(modal, 'transaction_date').fill(day(-2))
    await h.check('a.past-date-stays-ticked', 'B', async () => (await postedBox(modal).isChecked()) || 'unticked by a past date')
    await control(modal, 'transaction_date').fill(day(0))
    await h.check('a.today-stays-ticked', 'B', async () => (await postedBox(modal).isChecked()) || 'unticked by today')
  } finally {
    await d.checkNoNativeDialogs(h, 'a', native)
    await ctx.close()
  }
}

// (b) ticking it again keeps it ticked, with the note, and saves as posted.
async function scenarioB(browser) {
  console.log('\n=== (b) ticking again in the future stays ticked, shows the note, saves as posted')
  const { ctx, page, native } = await openPage(browser)
  try {
    const modal = await openAdd(page)
    await control(modal, 'transaction_date').fill(day(5))
    await h.check('b.unticked-first', 'B', async () => (!(await postedBox(modal).isChecked())) || 'still ticked')
    await postedBox(modal).check()
    await h.check('b.stays-ticked', 'B', async () => (await postedBox(modal).isChecked()) || 'unticked again')
    await h.check('b.note-text', 'B', async () => {
      await noteOf(modal).waitFor({ timeout: 5000 })
      const text = (await noteOf(modal).innerText()).trim()
      return text === NOTE || `text ${JSON.stringify(text)}`
    })
    const sent = await save(page, modal, 'Create Transaction', isCreate, 'Future posted')
    await h.check('b.payload-is-posted-true', 'B', async () => sent.is_posted === true || `is_posted ${sent.is_posted}`)
    await h.check('b.payload-date-is-future', 'B', async () => String(sent.transaction_date).startsWith(day(5)) || `transaction_date ${sent.transaction_date}`)
  } finally {
    await d.checkNoNativeDialogs(h, 'b', native)
    await ctx.close()
  }
}

// (c) moving the date back removes the note and never ticks the box.
async function scenarioC(browser) {
  console.log('\n=== (c) moving the date back removes the note and never ticks the box')
  const { ctx, page, native } = await openPage(browser)
  try {
    const modal = await openAdd(page)
    await control(modal, 'transaction_date').fill(day(4))
    await h.check('c.unticked', 'B', async () => (!(await postedBox(modal).isChecked())) || 'still ticked')
    await control(modal, 'transaction_date').fill(day(0))
    await h.check('c.today-does-not-tick', 'B', async () => (!(await postedBox(modal).isChecked())) || 'ticked by moving back to today')
    await h.check('c.today-no-note', 'B', async () => (await noteOf(modal).count()) === 0 || 'note shown')
    await control(modal, 'transaction_date').fill(day(4))
    await postedBox(modal).check()
    await noteOf(modal).waitFor({ timeout: 5000 })
    await control(modal, 'transaction_date').fill(day(-1))
    await h.check('c.past-removes-note', 'B', async () => {
      await noteOf(modal).waitFor({ state: 'detached', timeout: 5000 })
      return true
    })
    await h.check('c.past-keeps-ticked', 'B', async () => (await postedBox(modal).isChecked()) || 'unticked by moving back')
    await control(modal, 'transaction_date').fill(day(4))
    await h.check('c.future-again-unticks', 'B', async () => (!(await postedBox(modal).isChecked())) || 'still ticked')
  } finally {
    await d.checkNoNativeDialogs(h, 'c', native)
    await ctx.close()
  }
}

async function openEdit(page, description) {
  // A row dated after today is on the Due card's Upcoming tab, not the main list.
  const row = description.includes('future')
    ? page.locator('[data-testid="due-row"]').filter({ hasText: description }).first()
    : rowFor(page, description)
  if (description.includes('future')) await page.locator('[data-testid="due-tab-upcoming"]').click()
  await row.waitFor()
  await h.waitQuiet(page)
  await row.click()
  const actions = formModal(page, 'Transaction Actions')
  await actions.waitFor()
  await h.waitQuiet(page)
  await actions.getByRole('button', { name: 'Edit Transaction', exact: true }).click()
  const modal = formModal(page, 'Edit Transaction')
  await modal.waitFor()
  await h.waitQuiet(page)
  return modal
}

// (d) Edit never changes the posted state on load.
async function scenarioD(browser) {
  console.log('\n=== (d) Edit leaves the posted state alone on load; only a user date change unticks')
  const wire = (offset) => `${day(offset)}T00:00:00`
  const seed = (description, offset, extra = {}) =>
    client.post(user.token, '/transactions/', {
      account_id: account.id, transaction_type: 'debit', amount: 25, currency: 'PHP', description,
      transaction_date: wire(offset), is_posted: true, ...extra,
    })
  await seed('Edit future posted', 6)
  await seed('Edit past posted', -3)
  const { ctx, page, native } = await openPage(browser)
  try {
    let modal = await openEdit(page, 'Edit future posted')
    await h.check('d.future-row-loads-ticked', 'B', async () => (await postedBox(modal).isChecked()) || 'unticked on load')
    await h.check('d.future-row-no-note-on-load', 'B', async () => (await noteOf(modal).count()) === 0 || 'note shown on load')
    await h.check('d.future-row-date-kept', 'B', async () => (await control(modal, 'transaction_date').inputValue()) === day(6) || 'date changed on load')
    await control(modal, 'transaction_date').fill(day(7))
    await h.check('d.user-date-change-unticks', 'B', async () => (!(await postedBox(modal).isChecked())) || 'still ticked after the user changed the date')
    await modal.getByRole('button', { name: 'Cancel', exact: true }).click()
    await modal.waitFor({ state: 'detached' })
    await h.waitQuiet(page)

    modal = await openEdit(page, 'Edit past posted')
    await h.check('d.past-row-loads-ticked', 'B', async () => (await postedBox(modal).isChecked()) || 'unticked on load')
    await control(modal, 'transaction_date').fill(day(8))
    await h.check('d.past-row-future-date-unticks', 'B', async () => (!(await postedBox(modal).isChecked())) || 'still ticked')
    await modal.getByRole('button', { name: 'Cancel', exact: true }).click()
    await modal.waitFor({ state: 'detached' })
    await h.waitQuiet(page)

    modal = await openEdit(page, 'Edit future posted')
    await h.check('d.reopen-loads-ticked-no-note', 'B', async () =>
      ((await postedBox(modal).isChecked()) && (await noteOf(modal).count()) === 0) || 'state leaked from the previous dialog')
    const sent = await save(page, modal, 'Update Transaction', isUpdate)
    await h.check('d.untouched-save-stays-posted', 'B', async () => sent.is_posted === true || `is_posted ${sent.is_posted}`)
  } finally {
    await d.checkNoNativeDialogs(h, 'd', native)
    await ctx.close()
  }
}

async function setup() {
  user = await h.makeUser(stack, 'futureunposted')
  account = await client.post(user.token, '/accounts/', { name: 'Fut Checking', account_type: 'checking', balance: 1000, currency: 'PHP' })
}

const SCENARIOS = [['a', scenarioA], ['b', scenarioB], ['c', scenarioC], ['d', scenarioD]]

;(async () => {
  process.on('unhandledRejection', (e) => console.log(`  NOTE unhandled rejection: ${e && e.message ? e.message.split('\n')[0] : e}`))
  stack = await startLocalStack()
  client = h.apiClient(stack)
  const browser = await chromium.launch()
  try {
    await setup()
  } catch (e) {
    console.error('SETUP FAILED', e)
    stack.stop()
    process.exit(2)
  }
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
