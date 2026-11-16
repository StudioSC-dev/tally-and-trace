// Browser checks for STU-631 and STU-658: a card purchase recorded as an installment from its
// total and number of months, in the Add Transaction dialog. The split follows the banks' rule
// (STU-658): each payment is the total ÷ months rounded half-up to the centavo, and the last
// absorbs the difference, so it can be higher or lower.
//
// offered_on_card_expense (STU-631 AC2): an expense on a credit card offers Installment; turning
//   it on shows the total and months (quick picks 3, 6, 12, 24 and a typed count), hides the
//   Amount field, the Repeat section and the recurring link;
// hidden_elsewhere (STU-631 AC2): income and a transfer on the card, an expense on a bank account
//   and Edit of a saved card expense show no Installment option;
// preview_shows_last_payment (AC5), 1280x800 and 390x844: 12,000.00 over 3 previews 4,000.00 a
//   month and no last payment; 10,000.00 over 3 previews a first payment of 3,333.33, then
//   3,333.33 for one month and a last payment of 3,333.34, on the statement closes; once saved,
//   the transaction, the installment's amount and final_amount and its payment days (the
//   forecast's) are the ones previewed;
// saved_last_higher (10,000.00/3), saved_last_lower (20,000.00/3), saved_two_months_final_amount
//   (10,000.01/2) (AC5), 1280x800 and 390x844: one POST /transactions/repeating whose transaction
//   is the first payment at the monthly amount and whose `repeat` is the card installment for
//   all the months plus `amount` (the monthly amount) and `final_amount` (the last payment); the
//   transaction and the installment are saved, the forecast lists the later payments on the
//   statement closes, the last at its own amount, and the Due card's Installments tab shows
//   "N-1 of N left" on the next close. At 390px the section has no horizontal scroll and 44px
//   targets;
// saved_one_month_no_repeat (AC5), 1280x800 and 390x844: one month saves the transaction at the
//   total through POST /transactions, with no installment entry;
// per_payment_repeat_unchanged (AC4): Repeat with After runs on the card still sends the
//   per-payment schedule with no `amount` or `final_amount`, and the installment's amount is the
//   one typed, with no final_amount;
// invalid_purchase_total, invalid_month_count (STU-631 AC7): blank, non-numeric, zero, negative,
//   fractional-centavo totals and fractional months show a field error (aria-invalid,
//   described by it, focused) and send nothing, so no transaction or installment is created;
// invalid_split_creates_no_records (AC9): a total too small for its months (0.01 over 2, 0.02
//   over 3) shows the field error and sends nothing.
// link_prefill_uses_occurrence_amount (STU-660 AC2), 1280x800 and 390x844: choosing an installment in
//   the "Recurring entry (optional)" select pre-fills the amount its next occurrence bills, from the
//   API's `next_occurrence_amount`: the final_amount when that is the last payment, the amount for
//   an entry with more payments left, one with no final_amount and an open-ended entry; the
//   linked row saves at that amount.
// Every scenario checks that no browser dialog fired.
//
// Starts its own API and web app against a throwaway database (./_local_stack.cjs) and seeds
// through the API. Not wired into CI and not part of `pnpm build`. Run steps: see ./README.md.
//
// Check kinds: [B] behavioural, [S] structural, [G] guard. The script ends with RESULT: k/m
// and exits 0 only when every check passed, 1 when any failed, 2 for setup.
//
// Usage: node frontend/e2e/installment-from-total.cjs [scenario name]
const { startLocalStack, consumePageOpen } = require('./_local_stack.cjs')
const h = require('./_smooth.cjs')
const d = require('./_dialogs.cjs')
const { pick } = require('./_picker.cjs')
const { useDueCheck, readTab } = require('./_due_pages.cjs')

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

/** The two sizes AC5's scenarios run at. */
const VIEWPORTS = [['desktop', { width: 1280, height: 800 }], ['phone', { width: 390, height: 844 }]]
const money = (value) => `₱${value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

useDueCheck((what, actual, expected) =>
  h.check(what, 'S', () => JSON.stringify(actual) === JSON.stringify(expected) || `actual ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`))

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
/** "Dec 28th, 2026" (the app's formatEntryDate) back to `2026-12-28`. */
const dayOfLabel = (label) => {
  const m = /^([A-Z][a-z]{2}) (\d{1,2})(?:st|nd|rd|th), (\d{4})$/.exec(label.trim())
  if (!m) return null
  return `${m[3]}-${String(MONTHS.indexOf(m[1]) + 1).padStart(2, '0')}-${m[2].padStart(2, '0')}`
}
/** `2026-12-28` plus `n` months, on the 28th (every month has one). */
const addMonths28 = (day, n) => {
  const date = new Date(`${day.slice(0, 8)}28T00:00:00Z`)
  date.setUTCMonth(date.getUTCMonth() + n)
  return date.toISOString().slice(0, 10)
}

const formModal = (page, heading) => page.locator('div.fixed').filter({ has: page.getByRole('heading', { name: heading, exact: true }) })
const control = (modal, key) => modal.locator(`[data-field="${key}"]`)
const section = (modal) => modal.locator('[data-testid="installment-section"]')
const toggle = (modal) => modal.locator('[data-testid="installment-toggle"]')
const fields = (modal) => modal.locator('[data-testid="installment-fields"]')
const preview = (modal) => modal.locator('[data-testid="installment-preview"]')
const linkLabel = (modal) => modal.getByText('Recurring entry (optional)', { exact: true })
const isApiPost = (r) => r.method() === 'POST' && r.url().includes('/api/v1/')
const pathOf = (r) => new URL(r.url()).pathname.replace(/^\/api\/v1/, '').replace(/\/$/, '')

async function account(user, name, type = 'checking', extra = {}) {
  return client.post(user.token, '/accounts/', { name, account_type: type, balance: 100000, currency: 'PHP', ...extra })
}
/** A PHP card whose statement closes on the 28th, due 21 days later, paid from `bank`. */
const card = (user, bank, name) => account(user, name, 'credit', {
  balance: 0, credit_limit: 200000, billing_cycle_start: 28, days_until_due_date: 21, payment_account_id: bank.id,
})

async function openPage(browser, user, contextOptions = {}) {
  const { ctx, page } = await h.newPage(browser, { timezoneId: 'Asia/Manila', ...contextOptions })
  page.setDefaultTimeout(10000)
  const native = d.trackNativeDialogs(page)
  const posts = []
  page.on('request', (r) => { if (isApiPost(r)) posts.push({ path: pathOf(r), body: r.postDataJSON() }) })
  await h.uiLogin(page, stack, user)
  await page.goto(`${stack.webUrl}/transactions`)
  await page.getByRole('button', { name: 'Add Transaction' }).first().waitFor()
  await h.waitQuiet(page)
  return { ctx, page, native, posts }
}

async function openAdd(page, accountName) {
  await page.getByRole('button', { name: 'Add Transaction' }).first().click()
  const modal = formModal(page, 'Create Transaction')
  await modal.waitFor()
  await h.waitQuiet(page)
  if (accountName) await pick(control(modal, 'account_id'), accountName)
  return modal
}

/** Fills in a card purchase of `total` over `months` with Installment on. */
async function fillInstallment(modal, description, total, months) {
  await control(modal, 'description').fill(description)
  await toggle(modal).check()
  await control(modal, 'installment_total').fill(total)
  await control(modal, 'installment_months').fill(months)
}

/** The preview: the first payment's figure and day, the monthly figure and count, the last payment's figure and day, every day. */
async function readPreview(modal) {
  const first = (await preview(modal).locator('[data-testid="installment-preview-first"]').innerText()).trim()
  const rest = (await preview(modal).locator('[data-testid="installment-preview-rest"]').count())
    ? (await preview(modal).locator('[data-testid="installment-preview-rest"]').innerText()).trim()
    : null
  const last = (await preview(modal).locator('[data-testid="installment-preview-last"]').count())
    ? (await preview(modal).locator('[data-testid="installment-preview-last"]').innerText()).trim()
    : null
  const dates = (await preview(modal).locator('[data-testid="installment-preview-dates"]').innerText()).trim()
  const firstMatch = /^First payment (\S+) on (.+)$/.exec(first)
  const restMatch = rest && /^Then (\S+) a month for (\d+) months?, /.exec(rest)
  const lastMatch = last && /^Last payment (\S+) on (.+)$/.exec(last)
  // "On the statement closes: Nov 28th, 2026, Dec 28th, 2026, ..." — each label has one comma.
  const labels = dates.replace(/^[^:]+:\s*/, '').match(/[A-Z][a-z]{2} \d{1,2}(?:st|nd|rd|th), \d{4}/g) ?? []
  return {
    first: firstMatch ? firstMatch[1] : null,
    firstDay: firstMatch ? dayOfLabel(firstMatch[2]) : null,
    rest: restMatch ? restMatch[1] : null,
    restCount: restMatch ? Number(restMatch[2]) : 0,
    last: lastMatch ? lastMatch[1] : null,
    lastDay: lastMatch ? dayOfLabel(lastMatch[2]) : null,
    onClose: dates.startsWith('On the statement closes'),
    days: labels.map(dayOfLabel),
  }
}

/** Clicks Create Transaction and waits for the POST it sends; returns its response. */
async function submit(page, modal) {
  const [response] = await Promise.all([
    page.waitForResponse((r) => r.request().method() === 'POST' && r.url().includes('/transactions')),
    modal.getByRole('button', { name: 'Create Transaction', exact: true }).click(),
  ])
  await modal.waitFor({ state: 'detached' })
  await h.waitQuiet(page)
  return response
}

const entryNamed = async (user, name) => {
  const all = await client.get(user.token, '/budget-entries/?limit=100')
  return (all.items ?? all).filter((e) => e.name === name)
}
const transactionsNamed = async (user, name) => {
  const all = await client.get(user.token, '/transactions/?limit=100')
  return (all.items ?? all).filter((t) => t.description === name)
}
/** The forecast's occurrences of an entry, a year ahead: [day, amount]. */
const forecastOf = async (user, name) => {
  const body = await client.get(user.token, '/forecast/upcoming?days=365')
  return body.items
    .filter((i) => i.source === 'budget_entry' && i.name === name)
    .map((i) => [i.occurrence_date ?? i.due_date, Number(i.amount)])
    .sort()
}

// AC2
async function offeredOnCardExpense(browser) {
  console.log('\n=== offered_on_card_expense (AC2)')
  const user = await h.makeUser(stack, 'ifta')
  const bank = await account(user, 'IFT Checking')
  const cc = await card(user, bank, 'IFT Card')
  const { ctx, page, native } = await openPage(browser, user)
  try {
    const modal = await openAdd(page, cc.name)
    await h.check('offered_on_card_expense.offered', 'B', async () => (await section(modal).count()) === 1 || 'no Installment option')
    await h.check('offered_on_card_expense.amount-before', 'B', async () => (await control(modal, 'amount').count()) === 1 || 'no Amount field before')
    await toggle(modal).check()
    await h.check('offered_on_card_expense.fields', 'B', async () =>
      ((await control(modal, 'installment_total').count()) === 1 && (await control(modal, 'installment_months').count()) === 1) || 'total or months missing')
    await h.check('offered_on_card_expense.quick-picks', 'B', async () => {
      const labels = await fields(modal).locator('[data-testid^="installment-months-"]').allInnerTexts()
      return JSON.stringify(labels.map((l) => l.trim())) === JSON.stringify(['3', '6', '12', '24']) || `picks ${JSON.stringify(labels)}`
    })
    await fields(modal).locator('[data-testid="installment-months-6"]').click()
    await h.check('offered_on_card_expense.quick-pick-fills', 'B', async () =>
      (await control(modal, 'installment_months').inputValue()) === '6' || `months ${await control(modal, 'installment_months').inputValue()}`)
    await h.check('offered_on_card_expense.amount-hidden', 'B', async () =>
      ((await control(modal, 'amount').count()) === 0 && (await control(modal, 'projected_amount').count()) === 0) || 'Amount still shown')
    await h.check('offered_on_card_expense.repeat-hidden', 'B', async () => (await modal.locator('[data-testid="repeat-section"]').count()) === 0 || 'Repeat still shown')
    await h.check('offered_on_card_expense.link-hidden', 'B', async () => (await linkLabel(modal).count()) === 0 || 'link select still shown')
    await toggle(modal).uncheck()
    await h.check('offered_on_card_expense.off-restores', 'B', async () =>
      ((await control(modal, 'amount').count()) === 1 && (await modal.locator('[data-testid="repeat-section"]').count()) === 1) || 'Amount or Repeat not back')
  } finally {
    await d.checkNoNativeDialogs(h, 'offered_on_card_expense', native)
    await ctx.close()
  }
}

// AC2
async function hiddenElsewhere(browser) {
  console.log('\n=== hidden_elsewhere (AC2)')
  const user = await h.makeUser(stack, 'iftb')
  const bank = await account(user, 'IFT Checking')
  const cc = await card(user, bank, 'IFT Card')
  const saved = await client.post(user.token, '/transactions/', {
    account_id: cc.id, transaction_type: 'debit', amount: 500, currency: 'PHP', description: 'Saved card buy',
    transaction_date: `${new Date().toISOString().slice(0, 10)}T00:00:00`, is_posted: true,
  })
  const { ctx, page, native } = await openPage(browser, user)
  try {
    const modal = await openAdd(page, cc.name)
    await modal.getByRole('button', { name: 'Income', exact: true }).click()
    await h.check('hidden_elsewhere.card-income', 'B', async () => (await section(modal).count()) === 0 || 'offered for income')
    await modal.getByRole('button', { name: 'Transfer', exact: true }).click()
    await h.check('hidden_elsewhere.card-transfer', 'B', async () => (await section(modal).count()) === 0 || 'offered for a transfer')
    await modal.getByRole('button', { name: 'Expense', exact: true }).click()
    await h.check('hidden_elsewhere.card-expense-back', 'B', async () => (await section(modal).count()) === 1 || 'not offered once back on Expense')
    await pick(control(modal, 'account_id'), bank.name)
    await h.check('hidden_elsewhere.bank-expense', 'B', async () => (await section(modal).count()) === 0 || 'offered on a bank account')
    await modal.getByRole('button', { name: 'Cancel', exact: true }).click()
    await modal.waitFor({ state: 'detached' })

    await page.reload()
    await h.waitQuiet(page)
    await page.locator('article[role="button"]').filter({ hasText: saved.description }).first().click()
    const actions = formModal(page, 'Transaction Actions')
    await actions.waitFor()
    await actions.getByRole('button', { name: 'Edit Transaction', exact: true }).click()
    const edit = formModal(page, 'Edit Transaction')
    await edit.waitFor()
    await h.waitQuiet(page)
    await h.check('hidden_elsewhere.edit', 'B', async () => (await section(edit).count()) === 0 || 'offered in Edit')
  } finally {
    await d.checkNoNativeDialogs(h, 'hidden_elsewhere', native)
    await ctx.close()
  }
}

/** The days are the card's 28th closes, a month apart, the first on the transaction's day. */
const onCloses = (shown, months) =>
  shown.onClose && shown.days.length === months && shown.firstDay === shown.days[0] &&
  shown.days.every((day, i) => day && day.endsWith('-28') && (i === 0 || day === addMonths28(shown.days[0], i)))

// AC5
async function previewShowsLastPayment(browser, tag, viewport) {
  const id = `preview_shows_last_payment.${tag}`
  console.log(`\n=== ${id} (AC5)`)
  const user = await h.makeUser(stack, `iftc${tag[0]}`)
  await consumePageOpen(client.api, user)
  const bank = await account(user, 'IFT Checking')
  const cc = await card(user, bank, 'IFT Card')
  const { ctx, page, native } = await openPage(browser, user, { viewport })
  const name = `Sofa ${tag}`
  try {
    const modal = await openAdd(page, cc.name)
    await fillInstallment(modal, name, '12,000.00', '3')
    await preview(modal).waitFor()
    const even = await readPreview(modal)
    await h.check(`${id}.even-no-last`, 'B', () =>
      (even.first === '₱4,000.00' && even.rest === '₱4,000.00' && even.restCount === 2 && even.last === null) || `preview ${JSON.stringify(even)}`)
    await control(modal, 'installment_total').fill('10,000.00')
    await h.waitQuiet(page)
    const shown = await readPreview(modal)
    await h.check(`${id}.figures`, 'B', () =>
      (shown.first === '₱3,333.33' && shown.rest === '₱3,333.33' && shown.restCount === 1 && shown.last === '₱3,333.34') ||
      `preview ${JSON.stringify(shown)}`)
    await h.check(`${id}.on-closes`, 'B', () =>
      (onCloses(shown, 3) && shown.lastDay === shown.days[2]) || `days ${JSON.stringify(shown)}`)
    await submit(page, modal)
    const [txn] = await transactionsNamed(user, name)
    const [entry] = await entryNamed(user, name)
    await h.check(`${id}.first-amount`, 'B', () => (txn && Number(txn.amount) === 3333.33) || `transaction ${JSON.stringify(txn && txn.amount)}`)
    await h.check(`${id}.entry-amounts`, 'B', () =>
      (entry && Number(entry.amount) === 3333.33 && Number(entry.final_amount) === 3333.34) ||
      `entry ${JSON.stringify(entry && [entry.amount, entry.final_amount])}`)
    await h.check(`${id}.next-day`, 'B', () =>
      (entry && entry.next_occurrence.slice(0, 10) === shown.days[1]) || `entry next ${entry && entry.next_occurrence}, preview ${shown.days[1]}`)
    await h.check(`${id}.forecast-days`, 'B', async () => {
      const forecast = await forecastOf(user, name)
      const expected = [[shown.days[1], 3333.33], [shown.days[2], 3333.34]]
      return JSON.stringify(forecast) === JSON.stringify(expected) || `forecast ${JSON.stringify(forecast)}, preview ${JSON.stringify(expected)}`
    })
  } finally {
    await d.checkNoNativeDialogs(h, id, native)
    await ctx.close()
  }
}

/** The 390px checks: no horizontal scroll, every target at least 44px. */
async function phoneLayout(page, modal, id) {
  await h.check(`${id}.no-page-scroll`, 'B', async () => {
    const [scroll, clientWidth] = await page.evaluate(() => [document.documentElement.scrollWidth, document.documentElement.clientWidth])
    return scroll <= clientWidth || `page ${scroll} > ${clientWidth}`
  })
  await h.check(`${id}.no-section-scroll`, 'B', async () => {
    const [scroll, clientWidth] = await fields(modal).evaluate((el) => [el.scrollWidth, el.clientWidth])
    return scroll <= clientWidth || `fieldset ${scroll} > ${clientWidth}`
  })
  await h.check(`${id}.targets-44px`, 'B', async () => {
    const small = await section(modal).evaluate((el) =>
      [...el.querySelectorAll('button, input:not([type="checkbox"]), label:has(input[type="checkbox"])')]
        .filter((node) => node.getClientRects().length > 0)
        .map((node) => [node.tagName, node.textContent.trim().slice(0, 20), Math.round(node.getBoundingClientRect().height)])
        .filter(([, , height]) => height < 44))
    return small.length === 0 || `under 44px: ${JSON.stringify(small)}`
  })
}

// AC5: `total` over `months` (2 or more) saves the first payment at `monthly` and an installment
// for the rest at `monthly` with `final_amount` `last`.
async function savedInstallmentFromTotal(browser, scenario, tag, viewport, { total, months, monthly, last }) {
  const id = `${scenario}.${tag}`
  console.log(`\n=== ${id} (AC5)`)
  const user = await h.makeUser(stack, `iftd${tag[0]}`)
  await consumePageOpen(client.api, user)
  const bank = await account(user, 'IFT Checking')
  const cc = await card(user, bank, 'IFT Card')
  const { ctx, page, native, posts } = await openPage(browser, user, { viewport })
  const name = `Laptop ${scenario} ${tag}`
  try {
    const modal = await openAdd(page, cc.name)
    await fillInstallment(modal, name, total, String(months))
    await preview(modal).waitFor()
    const shown = await readPreview(modal)
    await h.check(`${id}.preview`, 'B', () =>
      (shown.first === money(monthly) && shown.last === (last === monthly ? null : money(last)) &&
        shown.restCount === months - 1 - (last === monthly ? 0 : 1) && onCloses(shown, months)) || `preview ${JSON.stringify(shown)}`)
    if (viewport.width < 500) await phoneLayout(page, modal, id)
    posts.length = 0
    const response = await submit(page, modal)
    await h.check(`${id}.created-201`, 'B', async () => response.status() === 201 || `status ${response.status()} ${await response.text()}`)
    const sent = posts.filter((p) => p.path.startsWith('/transactions'))
    await h.check(`${id}.one-request`, 'B', () =>
      (sent.length === 1 && sent[0].path === '/transactions/repeating') || `posts ${JSON.stringify(sent.map((p) => p.path))}`)
    const body = sent[0]?.body ?? {}
    await h.check(`${id}.first-payment-sent`, 'B', () =>
      (body.transaction && body.transaction.amount === monthly && body.transaction.projected_amount === monthly && !('budget_entry_id' in body.transaction)) ||
      `transaction ${JSON.stringify(body.transaction)}`)
    await h.check(`${id}.repeat-sent`, 'B', () => {
      const expected = {
        cadence: 'monthly', end_mode: 'after_occurrences', max_occurrences: months, billing_kind: null, settlement: 'manual',
        amount: monthly, final_amount: last,
      }
      return JSON.stringify(body.repeat) === JSON.stringify(expected) || `repeat ${JSON.stringify(body.repeat)}`
    })
    const txns = await transactionsNamed(user, name)
    const entries = await entryNamed(user, name)
    await h.check(`${id}.one-transaction`, 'B', () =>
      (txns.length === 1 && Number(txns[0].amount) === monthly && txns[0].budget_entry_id === entries[0]?.id) ||
      `transactions ${JSON.stringify(txns.map((t) => [t.amount, t.budget_entry_id]))}`)
    await h.check(`${id}.one-installment`, 'B', () =>
      (entries.length === 1 && entries[0].kind === 'installment' && Number(entries[0].amount) === monthly &&
        Number(entries[0].final_amount) === last && entries[0].max_occurrences === months - 1) ||
      `entries ${JSON.stringify(entries.map((e) => [e.kind, e.amount, e.final_amount, e.max_occurrences]))}`)
    await h.check(`${id}.sums-to-total`, 'B', () => {
      const cents = (v) => Math.round(Number(v) * 100)
      const sum = cents(txns[0]?.amount) + (months - 2) * cents(entries[0]?.amount) + cents(entries[0]?.final_amount)
      return sum === cents(total.replace(/,/g, '')) || `payments sum to ${sum} centavos`
    })
    await h.check(`${id}.forecast-on-closes`, 'B', async () => {
      const forecast = await forecastOf(user, name)
      const expected = shown.days.slice(1).map((day, i) => [day, i === months - 2 ? last : monthly])
      return (JSON.stringify(forecast) === JSON.stringify(expected) && expected.every(([day]) => day.endsWith('-28'))) ||
        `forecast ${JSON.stringify(forecast)}, expected ${JSON.stringify(expected)}`
    })
    const plans = (await readTab(page, 'installments')).filter((r) => r.name === name)
    await h.check(`${id}.due-card`, 'B', () =>
      (plans.length === 1 && plans[0].left === `${months - 1} of ${months} left` && plans[0].day === shown.days[1]) ||
      `rows ${JSON.stringify(plans.map((r) => [r.left, r.day]))}, next close ${shown.days[1]}`)
  } finally {
    await d.checkNoNativeDialogs(h, id, native)
    await ctx.close()
  }
}

// AC5: one month is the purchase alone: the transaction at the total and no installment.
async function savedOneMonthNoRepeat(browser, tag, viewport) {
  const id = `saved_one_month_no_repeat.${tag}`
  console.log(`\n=== ${id} (AC5)`)
  const user = await h.makeUser(stack, `iftg${tag[0]}`)
  await consumePageOpen(client.api, user)
  const bank = await account(user, 'IFT Checking')
  const cc = await card(user, bank, 'IFT Card')
  const { ctx, page, native, posts } = await openPage(browser, user, { viewport })
  const name = `Headphones ${tag}`
  try {
    const modal = await openAdd(page, cc.name)
    await fillInstallment(modal, name, '4,999.99', '1')
    await preview(modal).waitFor()
    const shown = await readPreview(modal)
    await h.check(`${id}.preview`, 'B', () =>
      (shown.first === '₱4,999.99' && shown.rest === null && shown.last === null && shown.days.length === 1) || `preview ${JSON.stringify(shown)}`)
    if (viewport.width < 500) await phoneLayout(page, modal, id)
    posts.length = 0
    const response = await submit(page, modal)
    // POST /transactions answers 200 (POST /transactions/repeating 201).
    await h.check(`${id}.created`, 'B', async () => response.ok() || `status ${response.status()} ${await response.text()}`)
    const sent = posts.filter((p) => p.path.startsWith('/transactions'))
    await h.check(`${id}.no-repeat-request`, 'B', () =>
      (sent.length === 1 && sent[0].path === '/transactions' && !('repeat' in (sent[0].body ?? {}))) || `posts ${JSON.stringify(sent.map((p) => p.path))}`)
    const txns = await transactionsNamed(user, name)
    await h.check(`${id}.one-transaction`, 'B', () =>
      (txns.length === 1 && Number(txns[0].amount) === 4999.99 && txns[0].budget_entry_id == null) ||
      `transactions ${JSON.stringify(txns.map((t) => [t.amount, t.budget_entry_id]))}`)
    await h.check(`${id}.no-installment`, 'B', async () => {
      const entries = await entryNamed(user, name)
      return entries.length === 0 || `entries ${entries.length}`
    })
  } finally {
    await d.checkNoNativeDialogs(h, id, native)
    await ctx.close()
  }
}

// STU-660 AC2: the link select pre-fills the next occurrence's own amount, as the API gives it.
async function linkPrefillUsesOccurrenceAmount(browser, tag, viewport) {
  const id = `link_prefill_uses_occurrence_amount.${tag}`
  console.log(`\n=== ${id} (STU-660 AC2)`)
  const user = await h.makeUser(stack, `iftl${tag[0]}`)
  await consumePageOpen(client.api, user)
  const bank = await account(user, 'IFL Checking')
  const next = `${new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10)}T00:00:00Z`
  const make = (name, extra) => client.post(user.token, '/budget-entries/', {
    name, entry_type: 'expense', amount: 100, currency: 'PHP', cadence: 'monthly', account_id: bank.id,
    next_occurrence: next, ...extra,
  })
  const cases = [
    ['last payment', await make('IFL Last', { end_mode: 'after_occurrences', max_occurrences: 1, final_amount: 133.34 }), '133.34'],
    ['more left', await make('IFL More', { end_mode: 'after_occurrences', max_occurrences: 3, final_amount: 133.34 }), '100'],
    ['no final_amount', await make('IFL Plain', { end_mode: 'after_occurrences', max_occurrences: 1 }), '100'],
    ['open-ended', await make('IFL Open', {}), '100'],
  ]
  const { ctx, page, native, posts } = await openPage(browser, user, { viewport })
  try {
    for (const [label, entry, expected] of cases) {
      const modal = await openAdd(page, bank.name)
      await control(modal, 'description').fill(`IFL ${label}`)
      await modal.getByText('Recurring entry (optional)', { exact: true }).locator('xpath=../select').selectOption(String(entry.id))
      await h.check(`${id}.${label}`, 'B', async () => {
        const shown = await control(modal, 'amount').inputValue()
        return Number(shown) === Number(expected) || `amount ${shown}, expected ${expected}`
      })
      if (label === 'last payment') {
        posts.length = 0
        const response = await submit(page, modal)
        await h.check(`${id}.saved`, 'B', async () => response.ok() || `status ${response.status()}`)
        const rows = await transactionsNamed(user, 'IFL last payment')
        await h.check(`${id}.saved-at-final-amount`, 'B', () =>
          (rows.length === 1 && Number(rows[0].amount) === 133.34 && rows[0].budget_entry_id === entry.id) ||
          `rows ${JSON.stringify(rows.map((t) => [t.amount, t.budget_entry_id]))}`)
      } else {
        await modal.getByRole('button', { name: 'Cancel' }).first().click()
        await modal.waitFor({ state: 'detached' })
      }
    }
  } finally {
    await d.checkNoNativeDialogs(h, id, native)
    await ctx.close()
  }
}

// AC4
async function perPaymentFlowUnchanged(browser) {
  console.log('\n=== per_payment_repeat_unchanged (AC4)')
  const user = await h.makeUser(stack, 'ifte')
  await consumePageOpen(client.api, user)
  const bank = await account(user, 'IFT Checking')
  const cc = await card(user, bank, 'IFT Card')
  const { ctx, page, native, posts } = await openPage(browser, user)
  try {
    const modal = await openAdd(page, cc.name)
    await control(modal, 'description').fill('Phone plan')
    await control(modal, 'amount').fill('5000')
    await modal.locator('[data-testid="repeat-toggle"]').check()
    const repeatFields = modal.locator('[data-testid="repeat-fields"]')
    await repeatFields.getByRole('button', { name: 'After runs', exact: true }).click()
    await repeatFields.locator('[data-field="max_occurrences"]').fill('12')
    await h.check('per_payment_repeat_unchanged.help', 'B', async () => {
      const text = (await modal.locator('[data-testid="repeat-help"]').innerText()).trim()
      return text.includes('The amount is each payment') || `help ${JSON.stringify(text)}`
    })
    posts.length = 0
    const response = await submit(page, modal)
    await h.check('per_payment_repeat_unchanged.created-201', 'B', async () => response.status() === 201 || `status ${response.status()}`)
    const body = posts.find((p) => p.path === '/transactions/repeating')?.body ?? {}
    await h.check('per_payment_repeat_unchanged.repeat-sent', 'B', () => {
      const expected = { cadence: 'monthly', end_mode: 'after_occurrences', max_occurrences: 12, billing_kind: null, settlement: 'manual' }
      return JSON.stringify(body.repeat) === JSON.stringify(expected) || `repeat ${JSON.stringify(body.repeat)}`
    })
    const [entry] = await entryNamed(user, 'Phone plan')
    await h.check('per_payment_repeat_unchanged.amount-each', 'B', () =>
      (entry && Number(entry.amount) === 5000 && entry.max_occurrences === 11 && entry.final_amount == null) ||
      `entry ${JSON.stringify(entry && [entry.amount, entry.max_occurrences, entry.final_amount])}`)
  } finally {
    await d.checkNoNativeDialogs(h, 'per_payment_repeat_unchanged', native)
    await ctx.close()
  }
}

/** Each bad value shows its field's error and sends nothing; nothing is written. */
async function invalidCases(browser, scenario, key, good, cases, ac = 'STU-631 AC7') {
  console.log(`\n=== ${scenario} (${ac})`)
  const user = await h.makeUser(stack, `iftf${key === 'installment_total' ? 't' : 'm'}`)
  const bank = await account(user, 'IFT Checking')
  const cc = await card(user, bank, 'IFT Card')
  const { ctx, page, native, posts } = await openPage(browser, user)
  try {
    const modal = await openAdd(page, cc.name)
    await fillInstallment(modal, 'Bad input', key === 'installment_total' ? '' : good, key === 'installment_months' ? '' : good)
    for (const [label, value, message, months] of cases) {
      if (months !== undefined) await control(modal, 'installment_months').fill(months)
      await control(modal, key).fill(value)
      posts.length = 0
      await modal.getByRole('button', { name: 'Create Transaction', exact: true }).click()
      await page.waitForTimeout(300)
      const input = control(modal, key)
      await h.check(`${scenario}.${label}.error`, 'B', async () => {
        const error = modal.locator(`[data-testid="field-error-${key}"]`)
        const text = (await error.count()) ? (await error.innerText()).trim() : null
        return text === message || `error ${JSON.stringify(text)}, expected ${JSON.stringify(message)}`
      })
      await h.check(`${scenario}.${label}.a11y`, 'B', async () => {
        const [invalid, describedBy, focused] = await input.evaluate((el) => [el.getAttribute('aria-invalid'), el.getAttribute('aria-describedby'), document.activeElement === el])
        return (invalid === 'true' && describedBy === `transaction-${key}-error` && focused) || `aria-invalid ${invalid}, describedby ${describedBy}, focused ${focused}`
      })
      await h.check(`${scenario}.${label}.nothing-sent`, 'B', () => posts.length === 0 || `posts ${JSON.stringify(posts.map((p) => p.path))}`)
      await h.check(`${scenario}.${label}.dialog-open`, 'B', async () => (await modal.count()) === 1 || 'dialog closed')
    }
    await h.check(`${scenario}.nothing-created`, 'B', async () => {
      const txns = await transactionsNamed(user, 'Bad input')
      const entries = await entryNamed(user, 'Bad input')
      return (txns.length === 0 && entries.length === 0) || `transactions ${txns.length}, entries ${entries.length}`
    })
  } finally {
    await d.checkNoNativeDialogs(h, scenario, native)
    await ctx.close()
  }
}

const invalidPurchaseTotal = (browser) => invalidCases(browser, 'invalid_purchase_total', 'installment_total', '3', [
  ['blank', '', 'Please enter the purchase total.'],
  ['non-numeric', 'abc', 'Please enter the purchase total as a number.'],
  ['zero', '0', 'The purchase total must be more than zero.'],
  ['negative', '-100', 'The purchase total must be more than zero.'],
  ['fractional-centavo', '100.005', 'The purchase total can have at most two decimal places (centavos).'],
])
const invalidMonthCount = (browser) => invalidCases(browser, 'invalid_month_count', 'installment_months', '10000', [
  ['blank', '', 'Please enter the number of months.'],
  ['non-numeric', 'six', 'Please enter the number of months as a number.'],
  ['zero', '0', 'The number of months must be more than zero.'],
  ['negative', '-3', 'The number of months must be more than zero.'],
  ['fractional', '1.5', 'The number of months must be a whole number.'],
])

// AC9: rounding that leaves a payment at zero or below is refused before anything is sent.
const invalidSplit = (browser) => invalidCases(browser, 'invalid_split_creates_no_records', 'installment_total', '2', [
  ['one-centavo-over-2', '0.01', 'The purchase total is too small to split into 2 payments.'],
  ['two-centavos-over-3', '0.02', 'The purchase total is too small to split into 3 payments.', '3'],
], 'AC9')

/** Runs a scenario at both AC5 sizes. */
const atBothSizes = (run) => async (browser) => {
  for (const [tag, viewport] of VIEWPORTS) await run(browser, tag, viewport)
}
const saved = (scenario, split) =>
  [scenario, atBothSizes((browser, tag, viewport) => savedInstallmentFromTotal(browser, scenario, tag, viewport, split))]

const SCENARIOS = [
  ['offered_on_card_expense', offeredOnCardExpense],
  ['hidden_elsewhere', hiddenElsewhere],
  ['preview_shows_last_payment', atBothSizes(previewShowsLastPayment)],
  saved('saved_last_higher', { total: '10000', months: 3, monthly: 3333.33, last: 3333.34 }),
  saved('saved_last_lower', { total: '20,000.00', months: 3, monthly: 6666.67, last: 6666.66 }),
  saved('saved_two_months_final_amount', { total: '10000.01', months: 2, monthly: 5000.01, last: 5000 }),
  ['saved_one_month_no_repeat', atBothSizes(savedOneMonthNoRepeat)],
  ['link_prefill_uses_occurrence_amount', atBothSizes(linkPrefillUsesOccurrenceAmount)],
  ['per_payment_repeat_unchanged', perPaymentFlowUnchanged],
  ['invalid_purchase_total', invalidPurchaseTotal],
  ['invalid_month_count', invalidMonthCount],
  ['invalid_split_creates_no_records', invalidSplit],
]

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
