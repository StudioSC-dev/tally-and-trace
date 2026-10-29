// Browser checks for STU-410 on Transactions: the transaction form shows its errors inline,
// never in a browser popup. (a) an empty description (the browser's own required check,
// shown inline) and then no account selected; (b) the amount: zero, empty, the planned
// amount and the amount received on a transfer between currencies; (c) a refused save
// keeps the form open with the server's reason; (d) a delete from the action modal asks
// through the in-app Confirm dialog, which keeps a refusal and closes both on success;
// (e) a refused "Mark as not posted" shows in the action modal's error line; (f) a link
// to a transaction that no longer exists shows the in-app toast, here and after the
// move back to the dashboard.
// Starts its own API and web app against a throwaway database (./_local_stack.cjs) and
// seeds through the API. Not wired into CI and not part of `pnpm build`. Run steps: see
// ./README.md.
//
// Check kinds: [B] behavioural, [S] structural (a failed one makes the run invalid),
// [G] guard. The script ends with RESULT: k/m and exits 0 only when every check passed,
// 1 when any failed, 2 for setup.
//
// Usage: node frontend/e2e/dialogs-transactions.cjs [scenario]
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

let stack, client, owner, checking, dollars

const pathOf = (url) => new URL(url).pathname.replace(/\/$/, '')
const isCreate = (r) => r.method() === 'POST' && pathOf(r.url()).endsWith('/transactions')
const createsIn = (log, from = 0) =>
  log.slice(from).filter((r) => r.method === 'POST' && pathOf(r.url).endsWith('/transactions')).length
const isRow = (method, id) => (r) => r.method() === method && pathOf(r.url()).endsWith(`/transactions/${id}`)
const deletesIn = (log, id) =>
  log.filter((r) => r.method === 'DELETE' && pathOf(r.url).endsWith(`/transactions/${id}`)).length

const formModal = (page, heading) =>
  page.locator('div.fixed').filter({ has: page.getByRole('heading', { name: heading, exact: true }) })
const fieldError = (modal, key) => modal.locator(`[data-testid="field-error-${key}"]`)
const control = (modal, key) => modal.locator(`[data-field="${key}"]`)
const textOf = async (locator) => ((await locator.textContent({ timeout: 3000 }).catch(() => null)) || '').trim()
const isFocused = (locator) => locator.evaluate((el) => el === document.activeElement).catch(() => false)

/** A fresh signed-in page on Transactions, its native dialogs tracked and its requests logged. */
async function openTransactions(browser) {
  const { ctx, page } = await h.newPage(browser)
  page.setDefaultTimeout(10000)
  const native = d.trackNativeDialogs(page)
  const log = h.logRequests(page)
  await h.uiLogin(page, stack, owner)
  await page.goto(`${stack.webUrl}/transactions`)
  await page.getByRole('button', { name: 'Add Transaction' }).first().waitFor()
  await h.waitQuiet(page)
  return { ctx, page, native, log }
}

async function openAddForm(page) {
  await page.getByRole('button', { name: 'Add Transaction' }).first().click()
  const modal = formModal(page, 'Create Transaction')
  await modal.waitFor()
  await h.waitQuiet(page)
  return modal
}

const submit = async (page, modal) => {
  await modal.getByRole('button', { name: 'Create Transaction', exact: true }).click()
  await page.waitForTimeout(300)
  await h.waitQuiet(page)
}

/** The field-error checks every inline case shares: text, ARIA, focus, the only error shown. */
async function checkFieldError(page, modal, prefix, key, wantText, focusTarget) {
  const error = fieldError(modal, key)
  await error.waitFor({ timeout: 3000 })
  const want = typeof wantText === 'function' ? await wantText() : wantText
  await h.check(`${prefix}.message`, 'B', async () => {
    const text = await textOf(error)
    return (text !== '' && text === want) || `field-error-${key} ${JSON.stringify(text)}, want ${JSON.stringify(want)}`
  })
  await h.check(`${prefix}.role-alert`, 'B', async () =>
    (await error.getAttribute('role').catch(() => null)) === 'alert' || 'the error is not role=alert')
  await h.check(`${prefix}.only-error`, 'B', async () => {
    const n = await modal.locator('[data-testid^="field-error-"]').count()
    return n === 1 || `${n} field errors shown`
  })
  const target = control(modal, key)
  await h.check(`${prefix}.described`, 'B', async () => {
    const [describedBy, errorId] = [await target.getAttribute('aria-describedby').catch(() => null), await error.getAttribute('id').catch(() => null)]
    return (!!errorId && describedBy === errorId) || `aria-describedby ${describedBy}, error id ${errorId}`
  })
  if (focusTarget) {
    await h.check(`${prefix}.focus`, 'B', async () =>
      (await isFocused(focusTarget)) || `active ${await d.activeTestId(page)}`)
  }
}

const rowFor = (page, description) => page.locator('article[role="button"]').filter({ hasText: description }).first()
const actionModal = (page) => formModal(page, 'Transaction Actions')
const toast = (page) => page.locator('[data-testid="toast"]')

const seedTransaction = (description, extra = {}) =>
  client.post(owner.token, '/transactions/', {
    account_id: checking.id,
    transaction_type: 'debit',
    amount: 25,
    currency: 'PHP',
    description,
    transaction_date: new Date().toISOString(),
    is_posted: true,
    ...extra,
  })

/** Opens a row's action modal from the list. */
async function openActions(page, description) {
  await rowFor(page, description).click()
  const modal = actionModal(page)
  await modal.waitFor()
  await h.waitQuiet(page)
  return modal
}

async function fillValid(modal, description) {
  await control(modal, 'description').fill(description)
  await control(modal, 'account_id').getByRole('button', { name: /^Dlg Checking/ }).click()
  await control(modal, 'amount').fill('42')
}

// (a) An empty description (the browser's required check, shown inline), then no account.
async function scenarioA(browser) {
  console.log('\n=== (a) Add Transaction: an empty description, then no account selected, shown inline')
  const { ctx, page, native, log } = await openTransactions(browser)
  try {
    const modal = await openAddForm(page)
    const description = control(modal, 'description')

    let from = log.length
    await submit(page, modal)
    // Two fields fail the browser's check in this attempt; only the first is shown and focused.
    await h.check('a.two-invalid', 'S', async () => {
      const flagged = [
        await description.evaluate((el) => el.validity.valueMissing),
        await control(modal, 'amount').evaluate((el) => el.validity.valueMissing),
      ]
      return flagged.every(Boolean) || `description and amount valueMissing: ${JSON.stringify(flagged)}`
    })
    await h.check('a.two-invalid.second-not-shown', 'B', async () =>
      (await fieldError(modal, 'amount').count()) === 0 || 'the second invalid field shows an error')
    await checkFieldError(page, modal, 'a.description', 'description',
      () => description.evaluate((el) => el.validationMessage), description)
    await h.check('a.description.invalid', 'B', async () =>
      (await description.getAttribute('aria-invalid')) === 'true' || 'aria-invalid is not "true"')
    await h.check('a.description.no-post', 'B', async () => {
      const n = createsIn(log, from)
      return n === 0 || `${n} POST /transactions`
    })

    await description.fill('Dialog A probe')
    await h.check('a.description.cleared-on-edit', 'B', async () =>
      (await fieldError(modal, 'description').count()) === 0 || 'the description error is still shown')
    await control(modal, 'amount').fill('42')
    from = log.length
    await submit(page, modal)
    const group = control(modal, 'account_id')
    const firstChip = group.getByRole('button').first()
    await checkFieldError(page, modal, 'a.account', 'account_id', 'Please select an account for this transaction.', firstChip)
    await h.check('a.account.group', 'B', async () => {
      const got = await group.evaluate((el) => ({
        role: el.getAttribute('role'),
        label: document.getElementById(el.getAttribute('aria-labelledby') || '')?.textContent?.trim() ?? null,
        invalid: el.getAttribute('aria-invalid'),
      }))
      return (got.role === 'group' && got.label === 'Account' && got.invalid === null) || `group ${JSON.stringify(got)}`
    })
    await h.check('a.account.chips-described', 'B', async () => {
      const ids = await group.getByRole('button').evaluateAll((els) => els.map((el) => el.getAttribute('aria-describedby')))
      return (ids.length > 0 && ids.every((id) => id === 'transaction-account_id-error')) || `chips ${JSON.stringify(ids)}`
    })
    await h.check('a.account.no-post', 'B', async () => {
      const n = createsIn(log, from)
      return n === 0 || `${n} POST /transactions`
    })

    await group.getByRole('button', { name: /^Dlg Checking/ }).click()
    await h.check('a.account.cleared-on-select', 'B', async () =>
      (await fieldError(modal, 'account_id').count()) === 0 || 'the account error is still shown')
    from = log.length
    await submit(page, modal)
    await modal.waitFor({ state: 'detached', timeout: 5000 })
    await h.check('a.control-saves', 'B', async () => {
      const n = createsIn(log, from)
      return (n === 1 && (await modal.count()) === 0) || `${n} POST /transactions, form open ${(await modal.count()) > 0}`
    })
  } finally {
    // Reached even when the scenario throws: a native dialog is a failure either way.
    await d.checkNoNativeDialogs(h, 'a', native)
    await ctx.close()
  }
}

// (b) The amount fields: zero and empty when posted, zero when planned, and the amount
// received on a posted transfer between currencies left empty.
async function scenarioB(browser) {
  console.log('\n=== (b) Add Transaction: the amount checks, shown inline')
  const { ctx, page, native, log } = await openTransactions(browser)
  try {
    const modal = await openAddForm(page)
    await fillValid(modal, 'Dialog B probe')
    const amount = control(modal, 'amount')
    const from = log.length

    await amount.fill('0')
    await submit(page, modal)
    await checkFieldError(page, modal, 'b.zero', 'amount', 'Please enter the actual amount posted to the account.', amount)
    await h.check('b.zero.invalid', 'B', async () =>
      (await amount.getAttribute('aria-invalid')) === 'true' || 'aria-invalid is not "true"')

    await amount.fill('')
    await h.check('b.empty.cleared-on-edit', 'B', async () =>
      (await fieldError(modal, 'amount').count()) === 0 || 'the amount error is still shown')
    await submit(page, modal)
    await h.check('b.empty.browser-flags', 'B', async () =>
      (await amount.evaluate((el) => el.validity.valueMissing)) || 'the browser does not flag the empty amount')
    await checkFieldError(page, modal, 'b.empty', 'amount', 'Please enter the actual amount posted to the account.', amount)

    // Bound violations, through the real Create button: the browser's own messages, inline.
    await amount.fill('-5')
    await submit(page, modal)
    await h.check('b.min.browser-flags', 'B', async () =>
      (await amount.evaluate((el) => el.validity.rangeUnderflow)) || 'the browser does not flag -5 as below min')
    await checkFieldError(page, modal, 'b.min', 'amount', () => amount.evaluate((el) => el.validationMessage), amount)
    await amount.fill('0.005')
    await submit(page, modal)
    await h.check('b.step.browser-flags', 'B', async () =>
      (await amount.evaluate((el) => el.validity.stepMismatch)) || 'the browser does not flag 0.005 as off its step')
    await checkFieldError(page, modal, 'b.step', 'amount', () => amount.evaluate((el) => el.validationMessage), amount)

    await modal.getByRole('checkbox', { name: 'Mark as posted' }).uncheck()
    const planned = control(modal, 'projected_amount')
    await planned.fill('0')
    await submit(page, modal)
    await checkFieldError(page, modal, 'b.planned', 'projected_amount', 'Please enter an amount greater than zero.', planned)

    // A constrained control the form does not know (added to the DOM here): the browser's
    // bubble is still suppressed, and the form's own line shows its message with focus.
    const unwired = await modal.locator('form').evaluateHandle((form) => {
      const input = document.createElement('input')
      input.required = true
      input.setAttribute('data-testid', 'unwired-control')
      input.addEventListener('invalid', (e) => { window.__unwiredPrevented = e.defaultPrevented })
      form.appendChild(input)
      return input
    })
    const ghost = modal.locator('[data-testid="unwired-control"]')
    await submit(page, modal)
    await h.check('b.unwired.bubble-suppressed', 'B', async () =>
      (await page.evaluate(() => window.__unwiredPrevented)) === true || 'the invalid event was not default-prevented')
    await h.check('b.unwired.form-line', 'B', async () => {
      const line = modal.locator('[data-testid="transaction-form-error"]')
      const [text, want] = [await textOf(line), await ghost.evaluate((el) => el.validationMessage)]
      return (text !== '' && text === want) || `form line ${JSON.stringify(text)}, want ${JSON.stringify(want)}`
    })
    await h.check('b.unwired.focus', 'B', async () => (await isFocused(ghost)) || `active ${await d.activeTestId(page)}`)
    await h.check('b.unwired.no-field-error', 'B', async () => {
      const n = await modal.locator('[data-testid^="field-error-"], [data-testid="record-date-error"]').count()
      return n === 0 || `${n} field errors shown`
    })
    await unwired.evaluate((el) => el.remove())
    await unwired.dispose()

    await modal.getByRole('button', { name: 'Transfer', exact: true }).click()
    await modal.getByRole('checkbox', { name: 'Mark as posted' }).check()
    await control(modal, 'transfer_to_account_id').getByRole('button', { name: /^Dlg Dollars/ }).click()
    await amount.fill('100')
    const received = control(modal, 'received_amount')
    await submit(page, modal)
    await h.check('b.received.browser-flags', 'B', async () =>
      (await received.evaluate((el) => el.validity.valueMissing)) || 'the browser does not flag the empty received amount')
    await checkFieldError(page, modal, 'b.received', 'received_amount', 'Please enter the amount received in USD.', received)
    await h.check('b.received.invalid', 'B', async () =>
      (await received.getAttribute('aria-invalid')) === 'true' || 'aria-invalid is not "true"')

    await h.check('b.no-post', 'B', async () => {
      const n = createsIn(log, from)
      return n === 0 || `${n} POST /transactions`
    })
    await h.check('b.form-open', 'B', async () => (await modal.isVisible()) || 'the form closed')
  } finally {
    // Reached even when the scenario throws: a native dialog is a failure either way.
    await d.checkNoNativeDialogs(h, 'b', native)
    await ctx.close()
  }
}

// (c) A refused save: the server's reason in the form, which stays open.
async function scenarioC(browser) {
  console.log('\n=== (c) Add Transaction: a refused save keeps the form open with the reason')
  const { ctx, page, native } = await openTransactions(browser)
  let fail = null
  try {
    const modal = await openAddForm(page)
    await fillValid(modal, 'Dialog C probe')
    fail = await h.failWith(page, isCreate, 500)
    await submit(page, modal)
    const error = modal.locator('[data-testid="transaction-form-error"]')
    await error.waitFor({ timeout: 5000 })
    await h.check('c.error-shown', 'B', async () => {
      const text = await textOf(error)
      return text.includes('stu335 injected failure 500') || `error ${JSON.stringify(text)}`
    })
    await h.check('c.error-role', 'B', async () =>
      (await error.getAttribute('role').catch(() => null)) === 'alert' || 'error line is not role=alert')
    await h.check('c.form-open', 'B', async () => (await modal.isVisible()) || 'the form closed')
    await h.check('c.one-post', 'B', async () => fail.hits === 1 || `${fail.hits} POST /transactions`)
    await h.check('c.kept-input', 'B', async () => {
      const value = await control(modal, 'description').inputValue().catch(() => null)
      return value === 'Dialog C probe' || `description ${JSON.stringify(value)}`
    })
  } finally {
    // Reached even when the scenario throws: a native dialog is a failure either way.
    await d.checkNoNativeDialogs(h, 'c', native)
    await fail?.stop()
    await ctx.close()
  }
}

// (d) Delete from the action modal: the Confirm keeps a refusal; a delete closes both.
async function scenarioD(browser) {
  console.log('\n=== (d) delete from the action modal: the in-app Confirm; a refusal stays in it; Confirm deletes')
  const row = await seedTransaction('Dialog D row')
  const { ctx, page, native, log } = await openTransactions(browser)
  const cd = d.confirmDialog(page)
  let fail = null
  try {
    const modal = await openActions(page, row.description)
    const opener = modal.getByRole('button', { name: 'Delete Transaction', exact: true })
    fail = await h.failWith(page, isRow('DELETE', row.id), 500, { times: 1 })
    await opener.click()
    await h.check('d.shown', 'B', async () =>
      (await cd.dialog.waitFor({ timeout: 3000 }).then(() => true, () => false)) || 'no confirm-dialog')
    await h.check('d.texts', 'B', async () => {
      const got = [await textOf(cd.title), await textOf(cd.message), await textOf(cd.accept)]
      const want = ['Delete transaction?', 'Delete the transaction "Dialog D row"?', 'Delete transaction']
      return JSON.stringify(got) === JSON.stringify(want) || `got ${JSON.stringify(got)}`
    })
    await h.check('d.focus-cancel', 'B', async () => {
      const active = await d.activeTestId(page)
      return active === 'confirm-dialog-cancel' || `active ${active}`
    })

    await cd.accept.click()
    await cd.error.waitFor({ timeout: 5000 })
    await h.waitQuiet(page)
    await h.check('d.refusal-in-dialog', 'B', async () => {
      const text = await textOf(cd.error)
      return text.includes('stu335 injected failure 500') || `error ${JSON.stringify(text)}`
    })
    await h.check('d.refusal-keeps-both', 'B', async () =>
      ((await cd.dialog.isVisible()) && (await modal.isVisible())) || 'a dialog closed after the refusal')
    await cd.cancel.click()
    await cd.dialog.waitFor({ state: 'detached', timeout: 3000 })
    await h.check('d.cancel-keeps-actions', 'B', async () =>
      ((await cd.dialog.count()) === 0 && (await modal.isVisible())) || 'the Confirm is open or the action modal closed')
    await h.check('d.cancel-focus-opener', 'B', async () =>
      (await isFocused(opener)) || `active ${await d.activeTestId(page)}`)

    await opener.click()
    await cd.dialog.waitFor({ timeout: 3000 })
    await cd.accept.click()
    await cd.dialog.waitFor({ state: 'detached', timeout: 5000 })
    await h.waitQuiet(page)
    await h.check('d.two-deletes', 'B', async () => {
      const n = deletesIn(log, row.id)
      return n === 2 || `${n} DELETE request(s)`
    })
    await h.check('d.both-closed', 'B', async () =>
      ((await cd.dialog.count()) === 0 && (await modal.count()) === 0) || 'a dialog is still open')
    await h.check('d.row-gone', 'B', async () =>
      (await h.expectAbsentFor(page, rowFor(page, row.description), 500)) || 'the row is still listed')
    await h.check('d.no-inert-left', 'B', async () => {
      const left = await d.leftoverInert(page)
      return left.length === 0 || `still inert: ${left.join(', ')}`
    })
  } finally {
    // Reached even when the scenario throws: a native dialog is a failure either way.
    await d.checkNoNativeDialogs(h, 'd', native)
    await fail?.stop()
    await ctx.close()
  }
}

// (e) A refused "Mark as not posted": the reason in the action modal's error line.
async function scenarioE(browser) {
  console.log('\n=== (e) a refused "Mark as not posted" shows in the action modal')
  const row = await seedTransaction('Dialog E row')
  const { ctx, page, native } = await openTransactions(browser)
  let fail = null
  try {
    const modal = await openActions(page, row.description)
    fail = await h.failWith(page, isRow('PUT', row.id), 500)
    await modal.getByRole('button', { name: 'Mark as not posted', exact: true }).click()
    const error = modal.locator('[data-testid="transaction-action-error"]')
    await error.waitFor({ timeout: 5000 })
    await h.waitQuiet(page)
    await h.check('e.error-shown', 'B', async () => {
      const text = await textOf(error)
      return text.includes('stu335 injected failure 500') || `error ${JSON.stringify(text)}`
    })
    await h.check('e.error-role', 'B', async () =>
      (await error.getAttribute('role').catch(() => null)) === 'alert' || 'error line is not role=alert')
    await h.check('e.modal-open', 'B', async () => (await modal.isVisible()) || 'the action modal closed')
    await h.check('e.one-put', 'B', async () => fail.hits === 1 || `${fail.hits} PUT request(s)`)
    await h.check('e.still-posted', 'B', async () => {
      const stored = await client.get(owner.token, `/transactions/${row.id}`)
      return stored.is_posted === true || `is_posted ${stored.is_posted}`
    })
    await modal.getByRole('button', { name: 'Close actions modal' }).click()
    await modal.waitFor({ state: 'detached', timeout: 3000 })
    await openActions(page, row.description)
    await h.check('e.cleared-on-reopen', 'B', async () =>
      (await page.locator('[data-testid="transaction-action-error"]').count()) === 0 || 'the old error is still shown')
  } finally {
    // Reached even when the scenario throws: a native dialog is a failure either way.
    await d.checkNoNativeDialogs(h, 'e', native)
    await fail?.stop()
    await ctx.close()
  }
}

// (f) A link to a transaction that no longer exists: the toast, the URL cleaned, Dismiss.
async function scenarioF(browser) {
  console.log('\n=== (f) a link to a deleted transaction shows the in-app toast')
  const row = await seedTransaction('Dialog F row')
  await client.del(owner.token, `/transactions/${row.id}`)
  const { ctx, page, native } = await openTransactions(browser)
  const message = 'This transaction is no longer available.'
  try {
    await page.goto(`${stack.webUrl}/transactions?edit=${row.id}`)
    await toast(page).waitFor({ timeout: 5000 })
    await h.waitQuiet(page)
    await h.check('f.toast', 'B', async () => {
      const text = await textOf(page.locator('[data-testid="toast-message"]'))
      return text === message || `toast ${JSON.stringify(text)}`
    })
    await h.check('f.toast-role', 'B', async () =>
      (await toast(page).getAttribute('role').catch(() => null)) === 'alert' || 'the toast is not role=alert')
    await h.check('f.url-cleaned', 'B', async () => {
      const url = new URL(page.url())
      return (url.pathname === '/transactions' && url.search === '') || `url ${url.pathname}${url.search}`
    })
    await h.check('f.stays', 'B', async () =>
      (await h.sleep(1500).then(() => toast(page).isVisible())) || 'the toast went away by itself')
    await page.locator('[data-testid="toast-dismiss"]').click()
    await h.check('f.dismissed', 'B', async () =>
      (await toast(page).waitFor({ state: 'detached', timeout: 3000 }).then(() => true, () => false)) || 'the toast is still shown')

    // From the dashboard the page moves back there; the toast goes with it.
    await page.goto(`${stack.webUrl}/transactions?edit=${row.id}&from=dashboard`)
    await page.waitForURL((url) => url.pathname === '/', { timeout: 5000 })
    await toast(page).waitFor({ timeout: 5000 })
    await h.waitQuiet(page)
    await h.check('f.dashboard', 'B', async () => {
      const url = new URL(page.url())
      const text = await textOf(page.locator('[data-testid="toast-message"]'))
      return (url.pathname === '/' && text === message) || `url ${url.pathname}, toast ${JSON.stringify(text)}`
    })
    await page.locator('[data-testid="toast-dismiss"]').click()
    await h.check('f.dashboard-dismissed', 'B', async () =>
      (await toast(page).waitFor({ state: 'detached', timeout: 3000 }).then(() => true, () => false)) || 'the toast is still shown')
  } finally {
    // Reached even when the scenario throws: a native dialog is a failure either way.
    await d.checkNoNativeDialogs(h, 'f', native)
    await ctx.close()
  }
}

async function setup() {
  owner = await h.makeUser(stack, 'transactions')
  checking = await client.post(owner.token, '/accounts/', { name: 'Dlg Checking', account_type: 'checking', balance: 100000, currency: 'PHP' })
  dollars = await client.post(owner.token, '/accounts/', { name: 'Dlg Dollars', account_type: 'checking', balance: 1000, currency: 'USD' })
}

const SCENARIOS = [
  ['a', scenarioA],
  ['b', scenarioB],
  ['c', scenarioC],
  ['d', scenarioD],
  ['e', scenarioE],
  ['f', scenarioF],
]

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
