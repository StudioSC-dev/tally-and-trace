// Browser checks for STU-584: Repeat in the Add Transaction dialog. The transaction being
// added is recorded as the first occurrence of a new recurring entry, in one request.
//
// (a) "Netflix" posted today with Repeat monthly: exactly one POST, to
//     /transactions/repeating, carrying no budget_entry_id and no date in `repeat`, with no
//     second request; the row is in the list and the entry on Allocations. Semi-monthly is
//     not offered, and the preview names the schedule;
// (b) Repeat on hides the "Recurring entry (optional)" link select and clears a picked
//     link; a link picked with Repeat off keeps Repeat off. A card-to-bank (and bank-to-card)
//     transfer shows the toggle disabled with "A recurring transfer can't be paid into or
//     funded from a credit card"; bank to bank offers it;
// (c) a card installment of 12: the help says the amount is each payment, the cadence reads
//     "Charged monthly on each statement close", `repeat` has no anchor_day, and the
//     Installments tab then shows "11 of 12 left";
// (d) a refused save (autopay on a past unposted row) shows the server's reason inline,
//     creates nothing and keeps the form's values; the preview counts the missed payments.
//     An API without the endpoint (405) shows the Repeat section's error with Retry, and
//     Retry saves once the endpoint answers;
// (e) Edit of a repeated transaction shows no Repeat toggle and shows its linked entry;
//     "Save and add another" with Repeat on resets Repeat and its fields;
// (f) at 390px the Repeat fieldset has no horizontal scroll and its targets are 44px tall.
// Every scenario checks that no browser dialog fired.
//
// Starts its own API and web app against a throwaway database (./_local_stack.cjs) and
// seeds through the API. Not wired into CI and not part of `pnpm build`. Run steps: see
// ./README.md.
//
// Check kinds: [B] behavioural, [S] structural, [G] guard. The script ends with RESULT: k/m
// and exits 0 only when every check passed, 1 when any failed, 2 for setup.
//
// Usage: node frontend/e2e/repeat-transaction.cjs [scenario]
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

// The tab helpers record their own assertions through this.
useDueCheck((what, actual, expected) =>
  h.check(what, 'S', () => JSON.stringify(actual) === JSON.stringify(expected) || `actual ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`))

const CARD_REASON = "A recurring transfer can't be paid into or funded from a credit card"
const AUTOPAY_REASON = 'Turn autopay on from the recurring entry, where you confirm the payments it would post'
const pad = (n) => String(n).padStart(2, '0')
/** The browser's local day (the browser runs in this process's time zone), `offset` days from today. */
const day = (offset = 0) => {
  const date = new Date()
  date.setDate(date.getDate() + offset)
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

const formModal = (page, heading) => page.locator('div.fixed').filter({ has: page.getByRole('heading', { name: heading, exact: true }) })
const control = (modal, key) => modal.locator(`[data-field="${key}"]`)
const toggle = (modal) => modal.locator('[data-testid="repeat-toggle"]')
const fields = (modal) => modal.locator('[data-testid="repeat-fields"]')
const repeatControl = (modal, key) => fields(modal).locator(`[data-field="${key}"]`)
const linkLabel = (modal) => modal.getByText('Recurring entry (optional)', { exact: true })
// The link select is the dialog's one select whose first option ("None") has an empty value.
const linkSelect = (modal) => modal.locator('select:has(> option[value=""])')
const rowFor = (page, description) => page.locator('article[role="button"]').filter({ hasText: description }).first()
const isApiPost = (r) => r.method() === 'POST' && r.url().includes('/api/v1/')
/** Picks the link select's option whose text starts with `name`. */
async function pickLink(modal, name) {
  const value = await linkSelect(modal).locator('option').filter({ hasText: new RegExp(`^${name}`) }).first().getAttribute('value')
  await linkSelect(modal).selectOption(value)
}
const pathOf = (r) => new URL(r.url()).pathname.replace(/^\/api\/v1/, '').replace(/\/$/, '')

async function account(user, name, type = 'checking', extra = {}) {
  return client.post(user.token, '/accounts/', { name, account_type: type, balance: 100000, currency: 'PHP', ...extra })
}
/** A PHP card closing on the 28th, due 21 days later, paid from `bank`. */
const card = (user, bank, name) => account(user, name, 'credit', {
  balance: 0, credit_limit: 100000, billing_cycle_start: 28, days_until_due_date: 21, payment_account_id: bank.id,
})

async function openPage(browser, user, contextOptions = {}) {
  const { ctx, page } = await h.newPage(browser, contextOptions)
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

/**
 * Answers the next repeating POST with `status` and a JSON `body`, without reaching the
 * server. Returns { hits }.
 */
async function answerRepeating(page, status, body) {
  const state = { hits: 0 }
  await page.route((url) => url.pathname.endsWith('/transactions/repeating'), async (route, request) => {
    state.hits++
    const origin = request.headers().origin
    await route.fulfill({
      status,
      contentType: 'application/json',
      headers: { 'access-control-allow-origin': origin || '*', ...(origin ? { 'access-control-allow-credentials': 'true', vary: 'Origin' } : {}) },
      body: JSON.stringify(body),
    })
  }, { times: 1 })
  return state
}

/** Clicks a submit button and waits for the POST it sends; returns its response. */
async function submit(page, modal, name) {
  const [response] = await Promise.all([
    page.waitForResponse((r) => r.request().method() === 'POST' && r.url().includes('/transactions')),
    modal.getByRole('button', { name, exact: true }).click(),
  ])
  return response
}

// (a) One request, the row in the list and the entry on Allocations.
async function scenarioA(browser) {
  console.log('\n=== (a) Netflix posted today, Repeat monthly: one POST /transactions/repeating')
  const user = await h.makeUser(stack, 'repeata')
  const bank = await account(user, 'Rep Checking')
  const { ctx, page, native, posts } = await openPage(browser, user)
  try {
    const modal = await openAdd(page, bank.name)
    await control(modal, 'description').fill('Netflix')
    await control(modal, 'amount').fill('549')
    await h.check('a.toggle-off-by-default', 'B', async () => (!(await toggle(modal).isChecked())) || 'Repeat starts on')
    await toggle(modal).check()
    await fields(modal).waitFor()
    await h.check('a.no-semi-monthly', 'B', async () => {
      const values = await repeatControl(modal, 'cadence').locator('option').evaluateAll((os) => os.map((o) => o.value))
      return (values.length > 0 && !values.includes('semi_monthly')) || `cadences ${JSON.stringify(values)}`
    })
    await h.check('a.preview-names-the-day', 'B', async () => {
      const text = (await fields(modal).locator('[data-testid="schedule-preview"]').innerText()).trim()
      return text.startsWith(`Monthly · day ${Number(day(0).slice(8))}`) || `preview ${JSON.stringify(text)}`
    })
    posts.length = 0
    const response = await submit(page, modal, 'Create Transaction')
    await modal.waitFor({ state: 'detached' })
    await h.waitQuiet(page)
    await h.check('a.created-201', 'B', async () => response.status() === 201 || `status ${response.status()}`)
    await h.check('a.one-post-to-repeating', 'B', async () => {
      const writes = posts.map((p) => p.path)
      return JSON.stringify(writes) === JSON.stringify(['/transactions/repeating']) || `posts ${JSON.stringify(writes)}`
    })
    const sent = posts[0]?.body ?? {}
    await h.check('a.no-budget-entry-id', 'B', async () => !('budget_entry_id' in (sent.transaction ?? {})) || `transaction ${JSON.stringify(sent.transaction)}`)
    await h.check('a.repeat-body', 'B', async () => {
      const expected = { cadence: 'monthly', anchor_day: Number(day(0).slice(8)), day_rule: null, end_mode: 'indefinite', billing_kind: null, settlement: 'manual' }
      return JSON.stringify(sent.repeat) === JSON.stringify(expected) || `repeat ${JSON.stringify(sent.repeat)}`
    })
    await h.check('a.transaction-posted', 'B', async () =>
      (sent.transaction?.is_posted === true && sent.transaction?.description === 'Netflix') || `transaction ${JSON.stringify(sent.transaction)}`)
    await h.check('a.row-in-list', 'B', async () => {
      await rowFor(page, 'Netflix').waitFor({ timeout: 10000 })
      return true
    })
    const entries = await client.get(user.token, '/budget-entries/?limit=50')
    const netflix = (entries.items ?? entries).filter((e) => e.name === 'Netflix')
    await h.check('a.one-entry-advanced', 'B', async () =>
      (netflix.length === 1 && netflix[0].next_occurrence.slice(0, 10) > day(0)) || `entries ${JSON.stringify(netflix.map((e) => e.next_occurrence))}`)
    await page.goto(`${stack.webUrl}/allocations`)
    await h.check('a.entry-on-allocations', 'B', async () => {
      await page.locator('[data-testid^="kind-section-"] article').filter({ has: page.getByText('Netflix', { exact: true }) }).first().waitFor({ timeout: 10000 })
      return true
    })
  } finally {
    await d.checkNoNativeDialogs(h, 'a', native)
    await ctx.close()
  }
}

// (b) Repeat and a link to an existing entry exclude each other; card transfers can't repeat.
async function scenarioB(browser) {
  console.log('\n=== (b) Repeat hides the link select; a card transfer cannot repeat')
  const user = await h.makeUser(stack, 'repeatb')
  const bank = await account(user, 'Link Checking')
  const savings = await account(user, 'Link Savings', 'savings')
  const cc = await card(user, bank, 'Link Card')
  await client.post(user.token, '/budget-entries/', {
    name: 'Gym', entry_type: 'expense', amount: 1500, currency: 'PHP', cadence: 'monthly', account_id: bank.id,
    next_occurrence: `${day(5)}T00:00:00Z`,
  })
  const { ctx, page, native } = await openPage(browser, user)
  try {
    const modal = await openAdd(page, bank.name)
    await h.check('b.link-select-shown', 'S', async () => (await linkLabel(modal).count()) === 1 || 'no link select')
    await pickLink(modal, 'Gym')
    await h.check('b.link-picked', 'S', async () => (await linkSelect(modal).inputValue()) !== '' || 'link not picked')
    await h.check('b.link-keeps-repeat-off', 'B', async () => (!(await toggle(modal).isChecked())) || 'Repeat on after a link')
    await toggle(modal).check()
    await h.check('b.repeat-hides-link', 'B', async () => (await linkLabel(modal).count()) === 0 || 'link select still shown')
    await toggle(modal).uncheck()
    await h.check('b.repeat-cleared-link', 'B', async () => {
      await linkLabel(modal).waitFor()
      return (await linkSelect(modal).inputValue()) === '' || `link ${await linkSelect(modal).inputValue()}`
    })
    await pickLink(modal, 'Gym')
    await h.check('b.picking-link-leaves-repeat-off', 'B', async () => (!(await toggle(modal).isChecked())) || 'Repeat on')

    // Transfers: card to bank, bank to card, bank to bank.
    await modal.getByRole('button', { name: 'Transfer', exact: true }).click()
    await pick(control(modal, 'account_id'), bank.name)
    await pick(control(modal, 'transfer_to_account_id'), savings.name)
    await toggle(modal).check()
    await h.check('b.transfer-repeat-on', 'S', async () => (await toggle(modal).isChecked()) || 'Repeat off')
    await pick(control(modal, 'account_id'), cc.name)
    await pick(control(modal, 'transfer_to_account_id'), bank.name)
    await h.check('b.card-to-bank-disabled', 'B', async () => (await toggle(modal).isDisabled()) || 'toggle enabled')
    await h.check('b.card-to-bank-reason', 'B', async () => {
      const text = (await modal.locator('[data-testid="repeat-help"]').innerText()).trim()
      return text === CARD_REASON || `help ${JSON.stringify(text)}`
    })
    await pick(control(modal, 'account_id'), bank.name)
    await pick(control(modal, 'transfer_to_account_id'), cc.name)
    await h.check('b.bank-to-card-disabled', 'B', async () => (await toggle(modal).isDisabled()) || 'toggle enabled')
    await pick(control(modal, 'transfer_to_account_id'), savings.name)
    await h.check('b.bank-to-bank-offered', 'B', async () => (!(await toggle(modal).isDisabled())) || 'toggle disabled')
    await h.check('b.blocked-turns-repeat-off', 'B', async () =>
      (!(await toggle(modal).isChecked()) && (await fields(modal).count()) === 0) || 'Repeat back on after a blocked pair')
  } finally {
    await d.checkNoNativeDialogs(h, 'b', native)
    await ctx.close()
  }
}

// (c) A card installment of 12.
async function scenarioC(browser) {
  console.log('\n=== (c) card installment of 12: each payment, then "11 of 12 left"')
  const user = await h.makeUser(stack, 'repeatc')
  await consumePageOpen(client.api, user)
  const bank = await account(user, 'Inst Checking')
  const cc = await card(user, bank, 'Inst Card')
  const { ctx, page, native, posts } = await openPage(browser, user)
  try {
    const modal = await openAdd(page, cc.name)
    await control(modal, 'description').fill('Laptop plan')
    await control(modal, 'amount').fill('5000')
    await toggle(modal).check()
    await fields(modal).getByRole('button', { name: 'After runs', exact: true }).click()
    await repeatControl(modal, 'max_occurrences').fill('12')
    await h.check('c.kind-installment', 'B', async () => (await fields(modal).locator('[data-testid="repeat-kind"]').inputValue()) === 'installment' || 'not Installment')
    await h.check('c.help-each-payment', 'B', async () => {
      const text = (await modal.locator('[data-testid="repeat-help"]').innerText()).trim()
      return text.includes('The amount is each payment') || `help ${JSON.stringify(text)}`
    })
    await h.check('c.charged-on-close', 'B', async () => {
      const text = (await fields(modal).locator('[data-testid="installment-close-note"]').innerText()).trim()
      return text === 'Charged monthly on each statement close (the 28th)' || `note ${JSON.stringify(text)}`
    })
    posts.length = 0
    const response = await submit(page, modal, 'Create Transaction')
    await modal.waitFor({ state: 'detached' })
    await h.waitQuiet(page)
    await h.check('c.created-201', 'B', async () => response.status() === 201 || `status ${response.status()} ${await response.text()}`)
    const repeat = posts.find((p) => p.path === '/transactions/repeating')?.body?.repeat ?? {}
    await h.check('c.repeat-no-anchor-day', 'B', async () => {
      const expected = { cadence: 'monthly', end_mode: 'after_occurrences', max_occurrences: 12, billing_kind: null, settlement: 'manual' }
      return JSON.stringify(repeat) === JSON.stringify(expected) || `repeat ${JSON.stringify(repeat)}`
    })
    const plans = (await readTab(page, 'installments')).filter((r) => r.name === 'Laptop plan')
    await h.check('c.eleven-of-twelve-left', 'B', async () => (plans.length === 1 && plans[0].left === '11 of 12 left') || `rows ${JSON.stringify(plans.map((r) => r.left))}`)
  } finally {
    await d.checkNoNativeDialogs(h, 'c', native)
    await ctx.close()
  }
}

// (d) A refused save keeps everything; an API without the endpoint offers Retry.
async function scenarioD(browser) {
  console.log('\n=== (d) a refused save shows the reason and writes nothing; 405 offers Retry')
  const user = await h.makeUser(stack, 'repeatd')
  const bank = await account(user, 'Ref Checking')
  const { ctx, page, native, posts } = await openPage(browser, user)
  try {
    const modal = await openAdd(page, bank.name)
    await control(modal, 'description').fill('Rent past')
    await control(modal, 'transaction_date').fill(day(-40))
    await modal.getByRole('checkbox', { name: 'Mark as posted' }).uncheck()
    await control(modal, 'projected_amount').fill('12000')
    await toggle(modal).check()
    await h.check('d.preview-counts-missed', 'B', async () => {
      const text = (await modal.locator('[data-testid="repeat-missed"]').innerText()).trim()
      return /^\d+ payments? between then and today will show as missed$/.test(text) || `missed ${JSON.stringify(text)}`
    })
    await fields(modal).locator('[data-testid="repeat-settlement"]').selectOption('autopay')
    posts.length = 0
    const response = await submit(page, modal, 'Create Transaction')
    // The screen loader blocks input while the refusal's requests settle.
    await h.waitQuiet(page)
    await h.check('d.refused-422', 'B', async () => response.status() === 422 || `status ${response.status()}`)
    await h.check('d.reason-inline', 'B', async () => {
      const line = modal.locator('[data-testid="transaction-form-error"]')
      await line.waitFor({ timeout: 5000 })
      return (await line.innerText()).trim() === AUTOPAY_REASON || `error ${JSON.stringify(await line.innerText())}`
    })
    await h.check('d.form-kept', 'B', async () => {
      const kept = [
        await control(modal, 'description').inputValue(),
        await control(modal, 'projected_amount').inputValue(),
        await control(modal, 'transaction_date').inputValue(),
        await toggle(modal).isChecked(),
        await fields(modal).locator('[data-testid="repeat-settlement"]').inputValue(),
      ]
      return JSON.stringify(kept) === JSON.stringify(['Rent past', '12000', day(-40), true, 'autopay']) || `kept ${JSON.stringify(kept)}`
    })
    await h.check('d.one-request-only', 'B', async () => JSON.stringify(posts.map((p) => p.path)) === '["/transactions/repeating"]' || `posts ${JSON.stringify(posts.map((p) => p.path))}`)
    const entries = await client.get(user.token, '/budget-entries/?limit=50')
    const txns = await client.get(user.token, `/transactions/?limit=100&start_date=${day(-60)}&end_date=${day(5)}`)
    await h.check('d.nothing-created', 'B', async () => {
      const e = (entries.items ?? entries).filter((x) => x.name === 'Rent past').length
      const t = (txns.items ?? txns).filter((x) => x.description === 'Rent past').length
      return (e === 0 && t === 0) || `entries ${e}, transactions ${t}`
    })

    // A real 404 (a share revoked mid-form) is a refusal, not a missing endpoint.
    await fields(modal).locator('[data-testid="repeat-settlement"]').selectOption('manual')
    await answerRepeating(page, 404, { detail: 'Account not found' })
    await submit(page, modal, 'Create Transaction')
    await h.waitQuiet(page)
    await h.check('d.404-reason-inline', 'B', async () => {
      const line = modal.locator('[data-testid="transaction-form-error"]')
      await line.waitFor({ timeout: 5000 })
      return (await line.innerText()).trim() === 'Account not found' || `error ${JSON.stringify(await line.innerText())}`
    })
    await h.check('d.404-no-retry', 'B', async () => {
      const shown = (await modal.locator('[data-testid="repeat-unavailable"]').count()) + (await modal.locator('[data-testid="repeat-retry"]').count())
      return shown === 0 || 'Repeat shown as unavailable'
    })

    // A refused Repeat field shows under its own control; an unknown one on the section line.
    for (const [field, key] of [['settlement', 'settlement'], ['cadence', 'cadence'], ['end_mode', 'end_mode']]) {
      await answerRepeating(page, 422, { detail: [{ loc: ['body', 'repeat', field], msg: `${field} refused`, type: 'value_error' }] })
      await submit(page, modal, 'Create Transaction')
      await h.waitQuiet(page)
      await h.check(`d.${field}-error-on-control`, 'B', async () => {
        const error = modal.locator(`[data-testid="repeat-error-${key}"]`)
        await error.waitFor({ timeout: 5000 })
        const text = (await error.innerText()).trim()
        const target = repeatControl(modal, key)
        const invalid = await target.getAttribute('aria-invalid')
        const describedBy = await target.getAttribute('aria-describedby')
        const focused = await target.evaluate((el) => el === document.activeElement || el.contains(document.activeElement))
        return (text === `${field} refused` && invalid === 'true' && describedBy === `repeat-${key}-error` && focused) ||
          `text ${JSON.stringify(text)}, aria-invalid ${invalid}, describedby ${describedBy}, focused ${focused}`
      })
    }
    await answerRepeating(page, 422, { detail: [{ loc: ['body', 'repeat', 'lead_time_days'], msg: 'Extra inputs are not permitted', type: 'extra_forbidden' }] })
    await submit(page, modal, 'Create Transaction')
    await h.waitQuiet(page)
    await h.check('d.unknown-field-on-section-line', 'B', async () => {
      const line = modal.locator('[data-testid="repeat-error"]')
      await line.waitFor({ timeout: 5000 })
      return (await line.innerText()).trim() === 'Extra inputs are not permitted' || `error ${JSON.stringify(await line.innerText())}`
    })

    // An API from before the endpoint: 405, then Retry once it answers, with the button used.
    const oldAdd = await h.failWith(page, (r) => r.method() === 'POST' && r.url().includes('/transactions/repeating'), 405, { times: 1 })
    await submit(page, modal, 'Save and add another')
    await h.waitQuiet(page)
    await modal.locator('[data-testid="repeat-unavailable"]').waitFor({ timeout: 5000 })
    const [retriedAdd] = await Promise.all([
      page.waitForResponse((r) => r.request().method() === 'POST' && r.url().includes('/transactions/repeating')),
      modal.locator('[data-testid="repeat-retry"]').click(),
    ])
    await h.check('d.retry-keeps-add-another', 'B', async () => {
      if (retriedAdd.status() !== 201 || oldAdd.failed !== 1) return `status ${retriedAdd.status()}, failed ${oldAdd.failed}`
      await modal.locator('[data-testid="transaction-saved-notice"]').filter({ hasText: 'Saved "Rent past' }).waitFor({ timeout: 10000 })
      return (await modal.isVisible()) || 'dialog closed'
    })
    await oldAdd.stop()
    await h.waitQuiet(page)
    await control(modal, 'description').fill('Rent again')
    await control(modal, 'projected_amount').fill('12000')
    await toggle(modal).check()

    const old = await h.failWith(page, (r) => r.method() === 'POST' && r.url().includes('/transactions/repeating'), 405, { times: 1 })
    await submit(page, modal, 'Create Transaction')
    await h.waitQuiet(page)
    await h.check('d.unavailable-shown', 'B', async () => {
      await modal.locator('[data-testid="repeat-unavailable"]').waitFor({ timeout: 5000 })
      return true
    })
    await h.check('d.unavailable-keeps-form', 'B', async () => (await control(modal, 'description').inputValue()) === 'Rent again' || 'form cleared')
    const [retried] = await Promise.all([
      page.waitForResponse((r) => r.request().method() === 'POST' && r.url().includes('/transactions/repeating')),
      modal.locator('[data-testid="repeat-retry"]').click(),
    ])
    await h.check('d.retry-saves', 'B', async () =>
      (retried.status() === 201 && old.failed === 1) || `status ${retried.status()} ${await retried.text()}, sent ${retried.request().postData()}, failed ${old.failed}`)
    await modal.waitFor({ state: 'detached' })
    old.stop()
  } finally {
    await d.checkNoNativeDialogs(h, 'd', native)
    await ctx.close()
  }
}

async function openEdit(page, description) {
  const row = rowFor(page, description)
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

// (e) Edit shows the link, no toggle; Save and add another resets Repeat.
async function scenarioE(browser) {
  console.log('\n=== (e) Edit shows its entry and no Repeat; Save and add another resets Repeat')
  const user = await h.makeUser(stack, 'repeate')
  const bank = await account(user, 'Edit Checking')
  const { ctx, page, native, posts } = await openPage(browser, user)
  try {
    let modal = await openAdd(page, bank.name)
    await control(modal, 'description').fill('Spotify')
    await control(modal, 'amount').fill('199')
    await toggle(modal).check()
    await fields(modal).waitFor()
    posts.length = 0
    const response = await submit(page, modal, 'Save and add another')
    await h.check('e.add-another-repeating-201', 'B', async () =>
      (response.status() === 201 && posts[0]?.path === '/transactions/repeating') || `status ${response.status()} ${JSON.stringify(posts.map((p) => p.path))}`)
    await h.check('e.add-another-resets-repeat', 'B', async () => {
      await modal.locator('[data-testid="transaction-saved-notice"]').filter({ hasText: 'Saved "Spotify' }).waitFor({ timeout: 10000 })
      return (!(await toggle(modal).isChecked()) && (await fields(modal).count()) === 0) || 'Repeat still on'
    })
    await modal.getByRole('button', { name: 'Cancel', exact: true }).click()
    await modal.waitFor({ state: 'detached' })
    await h.waitQuiet(page)

    const entries = await client.get(user.token, '/budget-entries/?limit=50')
    const spotify = (entries.items ?? entries).find((e) => e.name === 'Spotify')
    modal = await openEdit(page, 'Spotify')
    await h.check('e.edit-no-toggle', 'B', async () => (await toggle(modal).count()) === 0 || 'Repeat toggle in Edit')
    await h.check('e.edit-shows-linked-entry', 'B', async () => {
      const value = await linkSelect(modal).inputValue()
      return (spotify !== undefined && value === String(spotify.id)) || `link ${value}, entry ${spotify?.id}`
    })
    await modal.getByRole('button', { name: 'Cancel', exact: true }).click()
    await modal.waitFor({ state: 'detached' })
  } finally {
    await d.checkNoNativeDialogs(h, 'e', native)
    await ctx.close()
  }
}

// (f) A phone-width dialog.
async function scenarioF(browser) {
  console.log('\n=== (f) at 390px: no horizontal scroll, 44px targets')
  const user = await h.makeUser(stack, 'repeatf')
  const bank = await account(user, 'Phone Checking')
  const { ctx, page, native } = await openPage(browser, user, { viewport: { width: 390, height: 844 } })
  try {
    const modal = await openAdd(page, bank.name)
    await toggle(modal).check()
    await fields(modal).getByRole('button', { name: 'On date', exact: true }).click()
    await fields(modal).getByRole('button', { name: 'After runs', exact: true }).click()
    await h.check('f.no-page-scroll', 'B', async () => {
      const [scroll, client] = await page.evaluate(() => [document.documentElement.scrollWidth, document.documentElement.clientWidth])
      return scroll <= client || `page ${scroll} > ${client}`
    })
    await h.check('f.no-fieldset-scroll', 'B', async () => {
      const [scroll, client] = await fields(modal).evaluate((el) => [el.scrollWidth, el.clientWidth])
      return scroll <= client || `fieldset ${scroll} > ${client}`
    })
    await h.check('f.targets-44px', 'B', async () => {
      const small = await modal.locator('[data-testid="repeat-section"]').evaluate((section) =>
        [...section.querySelectorAll('button, select, input:not([type="checkbox"]), label:has(input[type="checkbox"])')]
          .filter((el) => el.getClientRects().length > 0)
          .map((el) => [el.tagName, el.textContent.trim().slice(0, 20), Math.round(el.getBoundingClientRect().height)])
          .filter(([, , height]) => height < 44))
      return small.length === 0 || `under 44px: ${JSON.stringify(small)}`
    })
  } finally {
    await d.checkNoNativeDialogs(h, 'f', native)
    await ctx.close()
  }
}

const SCENARIOS = [['a', scenarioA], ['b', scenarioB], ['c', scenarioC], ['d', scenarioD], ['e', scenarioE], ['f', scenarioF]]

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
