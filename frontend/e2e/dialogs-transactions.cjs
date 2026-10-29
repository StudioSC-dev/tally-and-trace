// Browser checks for STU-410 on Transactions: the transaction form shows its errors inline,
// never in a browser popup. (a) an empty description (the browser's own required check,
// shown inline) and then no account selected; (b) the amount: zero, empty, the planned
// amount and the amount received on a transfer between currencies; (c) a refused save
// keeps the form open with the server's reason.
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
    await error.waitFor({ timeout: 5000 }).catch(() => null)
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

async function setup() {
  owner = await h.makeUser(stack, 'transactions')
  checking = await client.post(owner.token, '/accounts/', { name: 'Dlg Checking', account_type: 'checking', balance: 100000, currency: 'PHP' })
  dollars = await client.post(owner.token, '/accounts/', { name: 'Dlg Dollars', account_type: 'checking', balance: 1000, currency: 'USD' })
}

const SCENARIOS = [
  ['a', scenarioA],
  ['b', scenarioB],
  ['c', scenarioC],
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
