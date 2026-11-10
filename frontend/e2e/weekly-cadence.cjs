// Browser checks for STU-584 PR 6: Weekly and Every 2 weeks in the schedule fields that the
// recurring entry form and Repeat in the Add Transaction dialog share.
//
// (a) the recurring entry form offers Weekly and Every 2 weeks and shows "Day of week" for
//     them (not the month Day control); picking Friday on a Monday date moves the date forward
//     to that Friday, never earlier; the preview reads "Every 2 weeks · Friday" with the next
//     dates; it saves cadence biweekly with no day fields, and Allocations reads
//     "Every 2 weeks · Friday";
// (b) Repeat in Add Transaction offers both (and still not semi-monthly), shows the day of the
//     week read-only, and the entry's first occurrence is the transaction's own day: the POST
//     sends cadence biweekly with no day fields and the entry's next date is 14 days on;
// (c) a card installment still shows "Charged monthly on each statement close" with no cadence
//     choice and no Day of week, even when the form held Weekly, and saves monthly;
// (d) the link select in Add Transaction and the Transaction Actions modal read "Every 2 weeks";
// (e) Delay all on a bi-weekly entry's missed payment previews "every 14 days".
// Every scenario checks that no browser dialog fired.
//
// Starts its own API and web app against a throwaway database (./_local_stack.cjs) and seeds
// through the API. Not wired into CI and not part of `pnpm build`. Run steps: see ./README.md.
//
// Check kinds: [B] behavioural, [S] structural, [G] guard. The script ends with RESULT: k/m
// and exits 0 only when every check passed, 1 when any failed, 2 for setup.
//
// Usage: node frontend/e2e/weekly-cadence.cjs [a|b|c|d|e]
const { startLocalStack } = require('./_local_stack.cjs')
const h = require('./_smooth.cjs')
const d = require('./_dialogs.cjs')
const { pick } = require('./_picker.cjs')
const { useDueCheck, showRow } = require('./_due_pages.cjs')

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

useDueCheck((what, actual, expected) =>
  h.check(what, 'S', () => JSON.stringify(actual) === JSON.stringify(expected) || `actual ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`))

const pad = (n) => String(n).padStart(2, '0')
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
/** The browser's local day, `offset` days from today. */
const day = (offset = 0) => {
  const date = new Date()
  date.setDate(date.getDate() + offset)
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}
const addDays = (value, n) => {
  const date = new Date(`${value}T00:00:00Z`)
  date.setUTCDate(date.getUTCDate() + n)
  return date.toISOString().slice(0, 10)
}
const weekdayName = (value) => WEEKDAYS[new Date(`${value}T00:00:00Z`).getUTCDay()]
/** The first Monday at least 21 days out. */
const futureMonday = () => {
  let value = day(21)
  while (weekdayName(value) !== 'Monday') value = addDays(value, 1)
  return value
}
const manilaToday = () => new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10)

const addForm = (page) => page.locator('form').filter({ has: page.getByRole('button', { name: 'Save Recurring Entry' }) })
const field = (form, key) => form.locator(`[data-field="${key}"]`)
const formModal = (page, heading) => page.locator('div.fixed').filter({ has: page.getByRole('heading', { name: heading, exact: true }) })
const toggle = (modal) => modal.locator('[data-testid="repeat-toggle"]')
const fields = (modal) => modal.locator('[data-testid="repeat-fields"]')
const rowFor = (page, description) => page.locator('article[role="button"]').filter({ hasText: description }).first()
const linkSelect = (modal) => modal.locator('select:has(> option[value=""])')
const isApiPost = (r) => r.method() === 'POST' && r.url().includes('/api/v1/')
const pathOf = (r) => new URL(r.url()).pathname.replace(/^\/api\/v1/, '').replace(/\/$/, '')
const optionValues = (select) => select.locator('option').evaluateAll((os) => os.map((o) => o.value))
const optionTexts = (select) => select.locator('option').evaluateAll((os) => os.map((o) => (o.textContent ?? '').trim()))

const account = (user, name, type = 'checking', extra = {}) =>
  client.post(user.token, '/accounts/', { name, account_type: type, balance: 100000, currency: 'PHP', ...extra })

async function openPage(browser, user, path, ready, contextOptions = {}) {
  const { ctx, page } = await h.newPage(browser, contextOptions)
  page.setDefaultTimeout(10000)
  const native = d.trackNativeDialogs(page)
  const posts = []
  page.on('request', (r) => { if (isApiPost(r)) posts.push({ path: pathOf(r), body: r.postDataJSON() }) })
  await h.uiLogin(page, stack, user)
  await page.goto(`${stack.webUrl}${path}`)
  await ready(page).waitFor()
  await h.waitQuiet(page)
  return { ctx, page, native, posts }
}
const onAllocations = (browser, user) => openPage(browser, user, '/allocations', (p) => p.getByRole('button', { name: 'Add Recurring Entry' }))
const onTransactions = (browser, user) => openPage(browser, user, '/transactions', (p) => p.getByRole('button', { name: 'Add Transaction' }).first())

async function openRecurringForm(page) {
  await page.getByRole('button', { name: 'Add Recurring Entry' }).click()
  const form = addForm(page)
  await form.waitFor()
  await h.waitQuiet(page)
  return form
}
async function openAdd(page, accountName) {
  await page.getByRole('button', { name: 'Add Transaction' }).first().click()
  const modal = formModal(page, 'Create Transaction')
  await modal.waitFor()
  await h.waitQuiet(page)
  if (accountName) await pick(field(modal, 'account_id'), accountName)
  return modal
}
const entriesOf = async (user) => {
  const all = await client.get(user.token, '/budget-entries/?limit=50')
  return all.items ?? all
}

// (a) The recurring entry form.
async function scenarioA(browser) {
  console.log('\n=== (a) the recurring form: Weekly and Every 2 weeks with Day of week')
  const user = await h.makeUser(stack, 'wka')
  const bank = await account(user, 'Wk Checking')
  const { ctx, page, native, posts } = await onAllocations(browser, user)
  try {
    const form = await openRecurringForm(page)
    await field(form, 'name').fill('Cleaner')
    await field(form, 'account_id').selectOption({ label: bank.name })
    await field(form, 'amount').fill('800')
    await h.check('a.offers-weekly-and-biweekly', 'B', async () => {
      const values = await optionValues(field(form, 'cadence'))
      return (values.includes('weekly') && values.includes('biweekly')) || `cadences ${JSON.stringify(values)}`
    })
    await h.check('a.option-names', 'B', async () => {
      const texts = await optionTexts(field(form, 'cadence'))
      return (texts.includes('Weekly') && texts.includes('Every 2 weeks')) || `names ${JSON.stringify(texts)}`
    })
    await h.check('a.monthly-has-no-day-of-week', 'B', async () =>
      ((await form.locator('[data-testid="weekday-select"]').count()) === 0 && (await field(form, 'day').count()) === 1) || 'weekday shown for monthly')
    const monday = futureMonday()
    const date = form.locator('input[type="datetime-local"]').first()
    await date.fill(`${monday}T09:00`)
    await field(form, 'cadence').selectOption('biweekly')
    const weekday = form.locator('[data-testid="weekday-select"]')
    await h.check('a.day-of-week-replaces-day', 'B', async () =>
      ((await weekday.count()) === 1 && (await field(form, 'day').count()) === 0 && (await form.getByText('Day of week', { exact: true }).count()) === 1) || 'Day of week control missing or the month Day control still shown')
    await h.check('a.defaults-to-the-dates-weekday', 'B', async () => (await weekday.inputValue()) === '1' || `value ${await weekday.inputValue()}`)
    await h.check('a.preview-on-the-date', 'B', async () => {
      const text = (await form.locator('[data-testid="schedule-preview"]').innerText()).replace(/\s+/g, ' ').trim()
      return text.startsWith('Every 2 weeks · Monday') || `preview ${JSON.stringify(text)}`
    })
    await weekday.selectOption({ label: 'Friday' })
    const friday = addDays(monday, 4)
    await h.check('a.friday-moves-the-date-forward', 'B', async () => (await date.inputValue()) === `${friday}T09:00` || `date ${await date.inputValue()}, expected ${friday}`)
    await h.check('a.preview-lists-the-next-three', 'B', async () => {
      const text = (await form.locator('[data-testid="schedule-preview"]').innerText()).replace(/\s+/g, ' ').trim()
      const parts = text.split('Next:')
      const dates = (parts[1] ?? '').split(',').length
      return (parts[0].trim() === 'Every 2 weeks · Friday' && dates >= 6) || `preview ${JSON.stringify(text)}`
    })
    await weekday.selectOption({ label: 'Friday' })
    await h.check('a.same-weekday-stays', 'B', async () => (await date.inputValue()) === `${friday}T09:00` || `date ${await date.inputValue()}`)
    posts.length = 0
    await form.getByRole('button', { name: 'Save Recurring Entry' }).click()
    await form.waitFor({ state: 'detached' })
    await h.waitQuiet(page)
    await h.check('a.saved-biweekly-without-day-fields', 'B', async () => {
      const body = posts.find((p) => p.path === '/budget-entries')?.body
      return (body?.cadence === 'biweekly' && !('anchor_day' in body) && !('day_rule' in body)) || `body ${JSON.stringify(body)}`
    })
    const saved = (await entriesOf(user)).find((e) => e.name === 'Cleaner')
    await h.check('a.stored-on-that-friday', 'B', async () =>
      (saved?.cadence === 'biweekly' && saved.next_occurrence.slice(0, 10) === friday) || `entry ${JSON.stringify(saved && [saved.cadence, saved.next_occurrence])}`)
    await h.check('a.allocations-reads-every-2-weeks-friday', 'B', async () => {
      const card = page.locator('article').filter({ hasText: 'Cleaner' }).first()
      await card.waitFor()
      const text = (await card.innerText()).replace(/\s+/g, ' ')
      return text.includes('Every 2 weeks · Friday') || `card ${JSON.stringify(text)}`
    })
  } finally {
    await d.checkNoNativeDialogs(h, 'a', native)
    await ctx.close()
  }
}

// (b) Repeat in Add Transaction.
async function scenarioB(browser) {
  console.log('\n=== (b) Repeat in Add Transaction offers Weekly and Every 2 weeks')
  const user = await h.makeUser(stack, 'wkb')
  const bank = await account(user, 'Rep Checking')
  const { ctx, page, native, posts } = await onTransactions(browser, user)
  try {
    const modal = await openAdd(page, bank.name)
    await field(modal, 'description').fill('Gym')
    await field(modal, 'amount').fill('300')
    await toggle(modal).check()
    await fields(modal).waitFor()
    const cadence = fields(modal).locator('[data-field="cadence"]')
    await h.check('b.offers-weekly-and-biweekly-not-semi-monthly', 'B', async () => {
      const values = await optionValues(cadence)
      return (values.includes('weekly') && values.includes('biweekly') && !values.includes('semi_monthly')) || `cadences ${JSON.stringify(values)}`
    })
    await cadence.selectOption('biweekly')
    const weekday = fields(modal).locator('[data-testid="weekday-select"]')
    await h.check('b.day-of-week-is-the-transactions-day-and-fixed', 'B', async () => {
      const text = (await weekday.locator('option:checked').innerText()).trim()
      return (text === weekdayName(day(0)) && (await weekday.isDisabled()) && (await weekday.locator('option').count()) === 1) || `day ${text}, disabled ${await weekday.isDisabled()}`
    })
    await h.check('b.preview-names-the-schedule', 'B', async () => {
      const text = (await fields(modal).locator('[data-testid="schedule-preview"]').innerText()).replace(/\s+/g, ' ').trim()
      return text.startsWith(`Every 2 weeks · ${weekdayName(day(0))}`) || `preview ${JSON.stringify(text)}`
    })
    posts.length = 0
    const [response] = await Promise.all([
      page.waitForResponse((r) => r.request().method() === 'POST' && r.url().includes('/transactions')),
      modal.getByRole('button', { name: 'Create Transaction', exact: true }).click(),
    ])
    await modal.waitFor({ state: 'detached' })
    await h.waitQuiet(page)
    await h.check('b.created-201', 'B', async () => response.status() === 201 || `status ${response.status()}`)
    await h.check('b.sent-biweekly-with-no-day-fields', 'B', async () => {
      const sent = posts.find((p) => p.path === '/transactions/repeating')?.body?.repeat
      return (sent?.cadence === 'biweekly' && !('anchor_day' in sent) && !('day_rule' in sent) && !('next_occurrence' in sent)) || `repeat ${JSON.stringify(sent)}`
    })
    const gym = (await entriesOf(user)).find((e) => e.name === 'Gym')
    await h.check('b.first-occurrence-is-the-transactions-day', 'B', async () => {
      const txs = await client.get(user.token, '/transactions/?limit=20')
      const tx = (txs.items ?? txs).find((t) => t.description === 'Gym')
      return (gym !== undefined && tx !== undefined && tx.budget_entry_id === gym.id && gym.cadence === 'biweekly' && gym.next_occurrence.slice(0, 10) === addDays(String(tx.transaction_date).slice(0, 10), 14)) ||
        `entry ${JSON.stringify(gym && [gym.cadence, gym.next_occurrence])}, tx ${JSON.stringify(tx && [tx.transaction_date, tx.budget_entry_id])}`
    })
  } finally {
    await d.checkNoNativeDialogs(h, 'b', native)
    await ctx.close()
  }
}

// (c) A card installment stays monthly.
async function scenarioC(browser) {
  console.log('\n=== (c) a card installment keeps "Charged monthly on each statement close"')
  const user = await h.makeUser(stack, 'wkc')
  const bank = await account(user, 'Pay Checking')
  const cc = await account(user, 'Wk Card', 'credit', {
    balance: 0, credit_limit: 100000, billing_cycle_start: 28, days_until_due_date: 21, payment_account_id: bank.id,
  })
  const { ctx, page, native, posts } = await onAllocations(browser, user)
  try {
    const form = await openRecurringForm(page)
    await field(form, 'name').fill('Laptop')
    await field(form, 'account_id').selectOption({ label: cc.name })
    await field(form, 'amount').fill('1000')
    await field(form, 'cadence').selectOption('weekly')
    await h.check('c.weekly-shows-day-of-week-on-a-card-subscription', 'B', async () =>
      (await form.locator('[data-testid="weekday-select"]').count()) === 1 || 'no Day of week for an open-ended card entry')
    await form.getByRole('button', { name: 'After runs', exact: true }).click()
    await h.check('c.installment-note-and-no-cadence-choice', 'B', async () => {
      const note = form.locator('[data-testid="installment-close-note"]')
      await note.waitFor()
      const text = (await note.innerText()).trim()
      return (text.startsWith('Charged monthly on each statement close') && (await field(form, 'cadence').count()) === 0) || `note ${JSON.stringify(text)}`
    })
    await h.check('c.no-day-of-week-for-an-installment', 'B', async () =>
      (await form.locator('[data-testid="weekday-select"]').count()) === 0 || 'Day of week shown')
    posts.length = 0
    await form.getByRole('button', { name: 'Save Recurring Entry' }).click()
    await form.waitFor({ state: 'detached' })
    await h.waitQuiet(page)
    await h.check('c.saved-monthly', 'B', async () => {
      const body = posts.find((p) => p.path === '/budget-entries')?.body
      const saved = (await entriesOf(user)).find((e) => e.name === 'Laptop')
      return (body?.cadence === 'monthly' && saved?.cadence === 'monthly') || `sent ${JSON.stringify(body?.cadence)}, stored ${JSON.stringify(saved?.cadence)}`
    })
  } finally {
    await d.checkNoNativeDialogs(h, 'c', native)
    await ctx.close()
  }
}

// (d) The link select and the action modal.
async function scenarioD(browser) {
  console.log('\n=== (d) the link select and the Transaction Actions modal read "Every 2 weeks"')
  const user = await h.makeUser(stack, 'wkd')
  const bank = await account(user, 'Link Checking')
  const entry = await client.post(user.token, '/budget-entries/', {
    entry_type: 'expense', currency: 'PHP', cadence: 'biweekly', name: 'Fortnightly', amount: 450,
    account_id: bank.id, next_occurrence: `${day(30)}T09:00:00`,
  })
  await client.post(user.token, '/transactions/', {
    account_id: bank.id, amount: 450, currency: 'PHP', description: 'Fortnightly paid', transaction_type: 'debit',
    transaction_date: `${day(0)}T09:00:00`, budget_entry_id: entry.id, is_posted: true,
  })
  const { ctx, page, native } = await onTransactions(browser, user)
  try {
    const modal = await openAdd(page, bank.name)
    await h.check('d.link-option-reads-every-2-weeks', 'B', async () => {
      const texts = await optionTexts(linkSelect(modal))
      return texts.some((t) => t.startsWith('Fortnightly') && t.includes('Every 2 weeks')) || `options ${JSON.stringify(texts)}`
    })
    await modal.getByRole('button', { name: 'Cancel', exact: true }).click()
    await modal.waitFor({ state: 'detached' })
    const row = rowFor(page, 'Fortnightly paid')
    await row.waitFor()
    await h.waitQuiet(page)
    await row.click()
    const actions = formModal(page, 'Transaction Actions')
    await actions.waitFor()
    await h.check('d.action-modal-cadence-reads-every-2-weeks', 'B', async () => {
      const text = (await actions.innerText()).replace(/\s+/g, ' ')
      return /Cadence\s*Every 2 weeks/.test(text) || `modal ${JSON.stringify(text.slice(0, 400))}`
    })
  } finally {
    await d.checkNoNativeDialogs(h, 'd', native)
    await ctx.close()
  }
}

// (e) Delay all on a bi-weekly entry.
async function scenarioE(browser) {
  console.log('\n=== (e) Delay all on a bi-weekly entry previews "every 14 days"')
  const user = await h.makeUser(stack, 'wke')
  const bank = await account(user, 'Late Checking')
  const today = manilaToday()
  const first = addDays(today, -10)
  const next = addDays(first, 14)
  const chosen = addDays(next, 2)
  const entry = await client.post(user.token, '/budget-entries/', {
    entry_type: 'expense', currency: 'PHP', cadence: 'biweekly', name: 'Late Cleaner', amount: 500,
    account_id: bank.id, next_occurrence: `${first}T00:00:00`,
  })
  const { ctx, page, native } = await openPage(browser, user, '/transactions', (p) => p.locator('[data-testid="due-section"]'), { timezoneId: 'Asia/Manila' })
  try {
    await page.locator('[data-testid="due-count"]').filter({ hasNotText: '…' }).waitFor()
    await h.waitQuiet(page)
    const missed = page.locator(`[data-testid="due-row"][data-kind="missed"][data-source="budget_entry:${entry.id}"]`)
    await showRow(page, missed)
    await missed.locator('[data-testid="row-change-date"]').click()
    const dialog = page.locator('[data-testid="force-date-dialog"]')
    await dialog.waitFor()
    await h.waitQuiet(page)
    await dialog.locator('[data-testid="force-date-input"]').fill(chosen)
    await dialog.locator('[data-testid="force-date-save"]').click()
    const cascade = dialog.locator('[data-testid="date-choice-cascade"]')
    await cascade.waitFor()
    await h.check('e.delay-all-offered', 'B', async () => (await cascade.getAttribute('data-available')) === 'true' || 'Delay all unavailable')
    await h.check('e.preview-says-every-14-days', 'B', async () => {
      const lines = (await cascade.locator('[data-testid="date-choice-line"]').allTextContents()).map((t) => t.trim())
      return lines.includes('…and every later one every 14 days') || `lines ${JSON.stringify(lines)}`
    })
  } finally {
    await d.checkNoNativeDialogs(h, 'e', native)
    await ctx.close()
  }
}

const SCENARIOS = [['a', scenarioA], ['b', scenarioB], ['c', scenarioC], ['d', scenarioD], ['e', scenarioE]]

;(async () => {
  process.on('unhandledRejection', (e) => console.log(`  NOTE unhandled rejection: ${e && e.message ? e.message.split('\n')[0] : e}`))
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
