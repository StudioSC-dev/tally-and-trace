// Browser checks for STU-784: saving the Edit form for a posted row with no posting date
// must not stamp one. A card statement bills a posted row on the later of its transaction
// date and its posting date, so a stamped "now" moves an already-billed row onto the next
// statement.
//
// (a) AC1: a posted card row with no posting date, saved untouched, sends no posting_date
//     and the stored row still has none;
// (b) AC2: a posted row with a posting date, saved untouched, sends that date (UTC
//     midnight) and keeps it;
// (c) AC3: a date typed into Posting date is sent as UTC midnight of that day and stored;
// (d) AC4: unticking Mark as posted clears and disables the field and sends no posting_date;
// (e) guard, out of scope: Create with a posted row and no posting date still sends the
//     current time, unchanged by this fix.
// Every scenario checks that no browser dialog fired.
//
// Starts its own API and web app against a throwaway database (./_local_stack.cjs) and
// seeds through the API. Not wired into CI and not part of `pnpm build`. Run steps: see
// ./README.md.
//
// Check kinds: [B] behavioural, [G] guard. The script ends with RESULT: k/m and exits 0
// only when every check passed, 1 when any failed, 2 for setup.
//
// Usage: node frontend/e2e/posting-date-edit.cjs [scenario]
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
let stack, client, user, card

const pad = (n) => String(n).padStart(2, '0')
/** The browser's local day (the browser runs in this process's time zone), `offset` days from today. */
const day = (offset = 0) => {
  const date = new Date()
  date.setDate(date.getDate() + offset)
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}
const wire = (offset) => `${day(offset)}T00:00:00`
const utcMidnight = (offset) => `${day(offset)}T00:00:00.000Z`

const formModal = (page, heading) => page.locator('div.fixed').filter({ has: page.getByRole('heading', { name: heading, exact: true }) })
const control = (modal, key) => modal.locator(`[data-field="${key}"]`)
const postedBox = (modal) => modal.getByRole('checkbox', { name: 'Mark as posted' })
const isCreate = (r) => r.method() === 'POST' && new URL(r.url()).pathname.replace(/\/$/, '').endsWith('/transactions')
const isUpdate = (r) => r.method() === 'PUT' && /\/transactions\/\d+$/.test(new URL(r.url()).pathname)
const rowFor = (page, description) => page.locator('article[data-transaction-id]').filter({ hasText: description }).first()

const seed = (description, extra = {}) =>
  client.post(user.token, '/transactions/', {
    account_id: card.id, transaction_type: 'debit', amount: 25, currency: 'PHP', description,
    transaction_date: wire(-4), is_posted: true, ...extra,
  })
const stored = async (id) => (await client.get(user.token, `/transactions/${id}`)).posting_date

async function openPage(browser) {
  const { ctx, page } = await h.newPage(browser)
  page.setDefaultTimeout(10000)
  const native = d.trackNativeDialogs(page)
  await h.uiLogin(page, stack, user)
  await page.goto(`${stack.webUrl}/transactions`)
  await page.getByRole('button', { name: 'Add transaction' }).first().waitFor()
  await h.waitQuiet(page)
  return { ctx, page, native }
}

async function openEdit(page, description) {
  const row = rowFor(page, description)
  await row.waitFor()
  await h.waitQuiet(page)
  await row.click()
  const actions = formModal(page, 'Transaction actions')
  await actions.waitFor()
  await h.waitQuiet(page)
  await actions.getByRole('button', { name: 'Edit transaction', exact: true }).click()
  const modal = formModal(page, 'Edit transaction')
  await modal.waitFor()
  await h.waitQuiet(page)
  return modal
}

/** Saves the open form with `buttonName` and returns the JSON it sent. */
async function save(page, modal, buttonName, matcher) {
  const [request] = await Promise.all([page.waitForRequest(matcher), modal.getByRole('button', { name: buttonName, exact: true }).click()])
  await modal.waitFor({ state: 'detached' })
  await h.waitQuiet(page)
  return request.postDataJSON()
}

/** Runs `body` on a fresh signed-in page, then checks no browser dialog fired. */
async function withPage(browser, name, body) {
  const { ctx, page, native } = await openPage(browser)
  try {
    await body(page)
  } finally {
    await d.checkNoNativeDialogs(h, name, native)
    await ctx.close()
  }
}

// (a) AC1: a posted row with no posting date keeps none.
async function scenarioA(browser) {
  console.log('\n=== (a) a posted row with no posting date, saved untouched, keeps none')
  const row = await seed('No posting date')
  await h.check('a.seeded-without-posting-date', 'G', async () => (await stored(row.id)) === null || `seeded ${await stored(row.id)}`)
  await withPage(browser, 'a', async (page) => {
    const modal = await openEdit(page, 'No posting date')
    await h.check('a.field-empty-on-load', 'B', async () => (await control(modal, 'posting_date').inputValue()) === '' || 'field filled on load')
    const sent = await save(page, modal, 'Save changes', isUpdate)
    await h.check('a.payload-no-posting-date', 'B', async () => !('posting_date' in sent) || `posting_date ${JSON.stringify(sent.posting_date)}`)
    await h.check('a.payload-still-posted', 'B', async () => sent.is_posted === true || `is_posted ${sent.is_posted}`)
    await h.check('a.stored-keeps-none', 'B', async () => (await stored(row.id)) === null || `stored ${await stored(row.id)}`)
  })
}

// (b) AC2: a posted row with a posting date keeps it.
async function scenarioB(browser) {
  console.log('\n=== (b) a posted row with a posting date, saved untouched, keeps it')
  const row = await seed('Has posting date', { posting_date: wire(-2) })
  await withPage(browser, 'b', async (page) => {
    const modal = await openEdit(page, 'Has posting date')
    await h.check('b.field-shows-date', 'B', async () => (await control(modal, 'posting_date').inputValue()) === day(-2) || 'field not the stored day')
    const sent = await save(page, modal, 'Save changes', isUpdate)
    await h.check('b.payload-same-date', 'B', async () => sent.posting_date === utcMidnight(-2) || `posting_date ${JSON.stringify(sent.posting_date)}`)
    await h.check('b.stored-same-day', 'B', async () => String(await stored(row.id)).startsWith(day(-2)) || `stored ${await stored(row.id)}`)
  })
}

// (c) AC3: a date the user types is sent as UTC midnight of that day.
async function scenarioC(browser) {
  console.log('\n=== (c) a posting date typed on Edit is sent as UTC midnight and stored')
  const row = await seed('Gets posting date')
  await withPage(browser, 'c', async (page) => {
    const modal = await openEdit(page, 'Gets posting date')
    await control(modal, 'posting_date').fill(day(-1))
    const sent = await save(page, modal, 'Save changes', isUpdate)
    await h.check('c.payload-utc-midnight', 'B', async () => sent.posting_date === utcMidnight(-1) || `posting_date ${JSON.stringify(sent.posting_date)}`)
    await h.check('c.stored-typed-day', 'B', async () => String(await stored(row.id)).startsWith(day(-1)) || `stored ${await stored(row.id)}`)
  })
}

// (d) AC4: un-posting clears the posting date.
async function scenarioD(browser) {
  console.log('\n=== (d) unticking Mark as posted clears the posting date')
  const row = await seed('Unposts', { posting_date: wire(-2) })
  await withPage(browser, 'd', async (page) => {
    const modal = await openEdit(page, 'Unposts')
    await postedBox(modal).uncheck()
    await h.check('d.field-cleared-and-disabled', 'B', async () => {
      const value = await control(modal, 'posting_date').inputValue()
      const disabled = await control(modal, 'posting_date').isDisabled()
      return (value === '' && disabled) || `value ${JSON.stringify(value)}, disabled ${disabled}`
    })
    // The seeded row has no projected figure, and a pending row needs one.
    await control(modal, 'projected_amount').fill('25')
    const sent = await save(page, modal, 'Save changes', isUpdate)
    await h.check('d.payload-unposted', 'B', async () => sent.is_posted === false || `is_posted ${sent.is_posted}`)
    await h.check('d.payload-no-posting-date', 'B', async () => !('posting_date' in sent) || `posting_date ${JSON.stringify(sent.posting_date)}`)
    console.log(`  NOTE stored posting_date after unposting: ${JSON.stringify(await stored(row.id))}`)
  })
}

// (e) guard: Create is out of scope and still sends the current time.
async function scenarioE(browser) {
  console.log('\n=== (e) guard: Create with a posted row and no posting date is unchanged')
  await withPage(browser, 'e', async (page) => {
    await page.getByRole('button', { name: 'Add transaction' }).first().click()
    const modal = formModal(page, 'Add transaction')
    await modal.waitFor()
    await h.waitQuiet(page)
    await pick(control(modal, 'account_id'), card.name)
    await control(modal, 'description').fill('Create no posting date')
    await control(modal, 'posting_date').fill('')
    await control(modal, 'amount').fill('15')
    const before = Date.now()
    const sent = await save(page, modal, 'Add transaction', isCreate)
    const sentAt = Date.parse(String(sent.posting_date))
    await h.check('e.create-sends-now', 'G', async () =>
      (sentAt >= before - 60000 && sentAt <= Date.now() + 60000) || `posting_date ${JSON.stringify(sent.posting_date)}`)
  })
}

async function setup() {
  user = await h.makeUser(stack, 'postingedit')
  card = await client.post(user.token, '/accounts/', {
    name: 'Edit Card', account_type: 'credit', balance: 0, currency: 'PHP', credit_limit: 500000,
  })
}

const SCENARIOS = [['a', scenarioA], ['b', scenarioB], ['c', scenarioC], ['d', scenarioD], ['e', scenarioE]]

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
