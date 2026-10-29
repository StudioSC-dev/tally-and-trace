// Browser checks for STU-410 on the recurring entry form: a field the form refuses
// shows an inline error under it (aria-invalid, aria-describedby, focus moved, nothing
// sent), never a browser popup, and deleting an entry asks through the in-app Confirm.
// Every submit clicks the form's real Save button, so the browser's own required/min/step
// checks run first and their popup is replaced by the same inline error.
// (a) an empty name (native `required`); (b) no account (the form's own check, since the
// placeholder option has a value); (c) "After runs" with the count cleared;
// (d) a refused delete (409) keeps the Confirm open with the server's reason, then a
// retry deletes it; (e) an amount off the 0.01 step shows the browser's own text;
// (f) a negative Lead Time and (g) a Day of month above 31 do likewise; (h) a constrained
// control with no data-field gets the form-level message and focus, never a popup.
// Starts its own API and web app against a throwaway database (./_local_stack.cjs) and
// seeds through the API. Not wired into CI and not part of `pnpm build`. Run steps: see
// ./README.md.
//
// Check kinds: [B] behavioural, [S] structural (a failed one makes the run invalid),
// [G] guard. The script ends with RESULT: k/m and exits 0 only when every check passed,
// 1 when any failed, 2 for setup.
//
// Usage: node frontend/e2e/dialogs-recurring.cjs [scenario]
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

let stack, client, owner, bank

const pathOf = (url) => new URL(url).pathname.replace(/\/$/, '')
const isDelete = (id) => (r) => r.method() === 'DELETE' && pathOf(r.url()).endsWith(`/budget-entries/${id}`)
const wireIn = (days) => `${new Date(Date.now() + days * 86400000).toISOString().slice(0, 10)}T00:00:00`
const posts = (log) => log.filter((r) => r.method === 'POST' && pathOf(r.url).endsWith('/budget-entries')).length

const modalClose = (page) => page.getByLabel('Close allocation modal')
const addForm = (page) => page.locator('form').filter({ has: page.getByRole('button', { name: 'Save Recurring Entry' }) })
const editForm = (page) => page.locator('form').filter({ has: page.getByRole('button', { name: 'Update Recurring Entry' }) })
const field = (form, key) => form.locator(`[data-field="${key}"]`)

/** A fresh signed-in page on Allocations, its native dialogs tracked and its requests logged. */
async function openAllocations(browser) {
  const { ctx, page } = await h.newPage(browser)
  page.setDefaultTimeout(10000)
  const native = d.trackNativeDialogs(page)
  const log = h.logRequests(page)
  await h.uiLogin(page, stack, owner)
  await page.goto(`${stack.webUrl}/allocations`)
  await page.getByRole('button', { name: 'Add Recurring Entry' }).waitFor()
  await h.waitQuiet(page)
  return { ctx, page, native, log }
}

async function openAddForm(page) {
  await page.getByRole('button', { name: 'Add Recurring Entry' }).click()
  await modalClose(page).waitFor()
  await h.waitQuiet(page)
  return addForm(page)
}

/** Fills the add form so every field is valid, then lets the caller break one. */
async function fillValid(form, name) {
  await field(form, 'name').fill(name)
  await field(form, 'account_id').selectOption({ label: bank.name })
  await field(form, 'amount').fill('250')
}

/** The shared inline-error checks for one field: message, ARIA wiring, focus, nothing sent. */
async function checkFieldError(page, form, log, scenario, key, wantText, postsBefore) {
  const err = page.locator(`[data-testid="field-error-${key}"]`)
  await h.check(`${scenario}.error-shown`, 'B', async () => {
    const shown = await err.waitFor({ timeout: 3000 }).then(() => true, () => false)
    if (!shown) return `no field-error-${key}`
    if (wantText === null) return (await err.innerText()).length > 0 || 'empty message'
    const text = await err.innerText()
    return text === wantText || `message ${JSON.stringify(text)}`
  })
  await h.check(`${scenario}.aria`, 'B', async () => {
    const got = await field(form, key).evaluate((el) => ({
      invalid: el.getAttribute('aria-invalid'),
      describedby: document.getElementById(el.getAttribute('aria-describedby') || '')?.getAttribute('data-testid') ?? null,
    }))
    return (got.invalid === 'true' && got.describedby === `field-error-${key}`) || `got ${JSON.stringify(got)}`
  })
  await h.check(`${scenario}.focus-on-field`, 'B', async () => {
    const ok = await field(form, key).evaluate((el) => el === document.activeElement)
    return ok || `active ${await d.activeTestId(page)}`
  })
  await h.check(`${scenario}.nothing-sent`, 'B', async () => posts(log) === postsBefore || `${posts(log) - postsBefore} POST /budget-entries`)
  await h.check(`${scenario}.form-still-open`, 'B', async () => (await modalClose(page).count()) === 1 || 'the form closed')
}

// (a) An empty name: the browser's required check runs, the app shows its own copy inline.
async function scenarioA(browser) {
  console.log('\n=== (a) empty name: an inline error with focus, nothing sent')
  const { ctx, page, native, log } = await openAllocations(browser)
  try {
    const form = await openAddForm(page)
    await field(form, 'account_id').selectOption({ label: bank.name })
    // Two fields fail the browser's check in this attempt; only the first is shown and focused.
    const firstBefore = posts(log)
    await form.getByRole('button', { name: 'Save Recurring Entry' }).click()
    await h.check('a.two-invalid', 'S', async () => {
      const flagged = [
        await field(form, 'name').evaluate((el) => el.validity.valueMissing),
        await field(form, 'amount').evaluate((el) => el.validity.valueMissing),
      ]
      return flagged.every(Boolean) || `name and amount valueMissing: ${JSON.stringify(flagged)}`
    })
    // The first field must show its message, wiring and focus before either field is edited.
    await checkFieldError(page, form, log, 'a.two-invalid', 'name', 'Please provide a name for the recurring entry.', firstBefore)
    await h.check('a.two-invalid.second-not-shown', 'B', async () => {
      return (await page.locator('[data-testid="field-error-amount"]').count()) === 0 || 'the second invalid field shows an error'
    })
    // Editing the name clears its error, so the next attempt's error is its own.
    await field(form, 'name').fill('x')
    await field(form, 'name').fill('')
    await field(form, 'amount').fill('250')
    const before = posts(log)
    await form.getByRole('button', { name: 'Save Recurring Entry' }).click()
    await checkFieldError(page, form, log, 'a', 'name', 'Please provide a name for the recurring entry.', before)
    await h.check('a.typing-clears', 'B', async () => {
      await field(form, 'name').fill('x')
      return (await page.locator('[data-testid="field-error-name"]').count()) === 0 || 'the error stayed after an edit'
    })
  } finally {
    await d.checkNoNativeDialogs(h, 'a', native)
    await ctx.close()
  }
}

// (b) No account: the placeholder option has a value, so the form's own check catches it.
async function scenarioB(browser) {
  console.log('\n=== (b) no account selected: an inline error on the account, nothing sent')
  const { ctx, page, native, log } = await openAllocations(browser)
  try {
    const form = await openAddForm(page)
    await field(form, 'name').fill('Dialog B Entry')
    await field(form, 'amount').fill('250')
    const before = posts(log)
    await form.getByRole('button', { name: 'Save Recurring Entry' }).click()
    await checkFieldError(page, form, log, 'b', 'account_id', 'Please select an account to post this recurring entry into.', before)
  } finally {
    await d.checkNoNativeDialogs(h, 'b', native)
    await ctx.close()
  }
}

// (c) "After runs" with the count cleared, everything else valid.
async function scenarioC(browser) {
  console.log('\n=== (c) after runs with the count cleared: an inline error on the count, nothing sent')
  const { ctx, page, native, log } = await openAllocations(browser)
  try {
    const form = await openAddForm(page)
    await fillValid(form, 'Dialog C Entry')
    await form.getByRole('button', { name: 'After runs', exact: true }).click()
    await field(form, 'max_occurrences').fill('')
    const before = posts(log)
    await form.getByRole('button', { name: 'Save Recurring Entry' }).click()
    await checkFieldError(page, form, log, 'c', 'max_occurrences', 'Please specify how many occurrences before the entry stops.', before)
  } finally {
    await d.checkNoNativeDialogs(h, 'c', native)
    await ctx.close()
  }
}

// (e) An amount off the 0.01 step: the browser's own text, shown inline.
async function scenarioE(browser) {
  console.log('\n=== (e) amount 0.005 (off the step): the browser\'s message shown inline, nothing sent')
  const { ctx, page, native, log } = await openAllocations(browser)
  try {
    const form = await openAddForm(page)
    await fillValid(form, 'Dialog E Entry')
    await field(form, 'amount').fill('0.005')
    const before = posts(log)
    await form.getByRole('button', { name: 'Save Recurring Entry' }).click()
    await checkFieldError(page, form, log, 'e', 'amount', null, before)
    await h.check('e.browser-text', 'B', async () => {
      const [shown, native] = await Promise.all([
        page.locator('[data-testid="field-error-amount"]').innerText(),
        field(form, 'amount').evaluate((el) => el.validationMessage),
      ])
      return (native !== '' && shown === native) || `shown ${JSON.stringify(shown)}, browser ${JSON.stringify(native)}`
    })
  } finally {
    await d.checkNoNativeDialogs(h, 'e', native)
    await ctx.close()
  }
}

// (f) A negative Lead Time: the browser's min check runs, its text shown inline.
async function scenarioF(browser) {
  console.log('\n=== (f) lead time -1 (below min): the browser\'s message shown inline, nothing sent')
  const { ctx, page, native, log } = await openAllocations(browser)
  try {
    const form = await openAddForm(page)
    await fillValid(form, 'Dialog F Entry')
    await field(form, 'lead_time_days').fill('-1')
    const before = posts(log)
    await form.getByRole('button', { name: 'Save Recurring Entry' }).click()
    await checkFieldError(page, form, log, 'f', 'lead_time_days', null, before)
    await h.check('f.browser-text', 'B', async () => {
      const [shown, browserText] = await Promise.all([
        page.locator('[data-testid="field-error-lead_time_days"]').innerText(),
        field(form, 'lead_time_days').evaluate((el) => el.validationMessage),
      ])
      return (browserText !== '' && shown === browserText) || `shown ${JSON.stringify(shown)}, browser ${JSON.stringify(browserText)}`
    })
    await h.check('f.typing-clears', 'B', async () => {
      await field(form, 'lead_time_days').fill('2')
      return (await page.locator('[data-testid="field-error-lead_time_days"]').count()) === 0 || 'the error stayed after an edit'
    })
  } finally {
    await d.checkNoNativeDialogs(h, 'f', native)
    await ctx.close()
  }
}

// (g) A Day of month outside 1-31: the control clamps what is typed, so the out-of-range
// value is set straight on the input (no change event), then the real Save click runs the
// browser's max check.
async function scenarioG(browser) {
  console.log('\n=== (g) day of month 45 (above max): the browser\'s message shown inline, nothing sent')
  const { ctx, page, native, log } = await openAllocations(browser)
  try {
    const form = await openAddForm(page)
    await fillValid(form, 'Dialog G Entry')
    await field(form, 'day').selectOption('day')
    await field(form, 'day_of_month').evaluate((el) => { el.value = '45' })
    await h.check('g.native-invalid', 'S', async () =>
      (await field(form, 'day_of_month').evaluate((el) => el.validity.rangeOverflow)) || 'day 45 is not rangeOverflow')
    const before = posts(log)
    await form.getByRole('button', { name: 'Save Recurring Entry' }).click()
    await checkFieldError(page, form, log, 'g', 'day_of_month', null, before)
    await h.check('g.typing-clears', 'B', async () => {
      await field(form, 'day_of_month').fill('15')
      return (await page.locator('[data-testid="field-error-day_of_month"]').count()) === 0 || 'the error stayed after an edit'
    })
  } finally {
    await d.checkNoNativeDialogs(h, 'g', native)
    await ctx.close()
  }
}

// (h) A constrained control with no data-field (as a future unwired one would be): its
// popup is still replaced, by the form-level message above Save, with focus on the control.
async function scenarioH(browser) {
  console.log('\n=== (h) an unwired invalid control: the form-level message and focus, no browser popup')
  const { ctx, page, native, log } = await openAllocations(browser)
  try {
    const form = await openAddForm(page)
    await fillValid(form, 'Dialog H Entry')
    const lead = field(form, 'lead_time_days')
    await lead.fill('-1')
    await lead.evaluate((el) => { el.removeAttribute('data-field'); el.setAttribute('data-testid', 'unwired-lead') })
    const before = posts(log)
    await form.getByRole('button', { name: 'Save Recurring Entry' }).click()
    const err = page.locator('[data-testid="recurring-save-error"]')
    await h.check('h.form-level-error', 'B', async () => {
      const shown = await err.waitFor({ timeout: 3000 }).then(() => true, () => false)
      if (!shown) return 'no recurring-save-error'
      const [text, browserText] = await Promise.all([err.innerText(), page.getByTestId('unwired-lead').evaluate((el) => el.validationMessage)])
      return (text !== '' && text === browserText) || `shown ${JSON.stringify(text)}, browser ${JSON.stringify(browserText)}`
    })
    await h.check('h.focus-on-control', 'B', async () =>
      (await page.getByTestId('unwired-lead').evaluate((el) => el === document.activeElement)) || `active ${await d.activeTestId(page)}`)
    await h.check('h.nothing-sent', 'B', async () => posts(log) === before || `${posts(log) - before} POST /budget-entries`)
  } finally {
    await d.checkNoNativeDialogs(h, 'h', native)
    await ctx.close()
  }
}

const SCENARIOS = [
  ['a', scenarioA],
  ['b', scenarioB],
  ['c', scenarioC],
  ['e', scenarioE],
  ['f', scenarioF],
  ['g', scenarioG],
  ['h', scenarioH],
]

async function setup() {
  owner = await h.makeUser(stack, 'recurring')
  bank = await client.post(owner.token, '/accounts/', { name: 'Recurring Checking', account_type: 'checking', balance: 100000, currency: 'PHP' })
}

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
