// Browser checks for STU-410 on the allocation form: a field the form refuses shows an
// inline error under it (aria-invalid or, on a chip group, aria-describedby; focus moved;
// nothing sent), never a browser popup. Every submit clicks the form's real Save button, so the
// browser's own required/min checks run first and their popup is replaced by the same
// inline error.
// (a) an empty name (native `required`), with a second field also invalid; (b) a budget
// with no category (the form's own check); (d) a negative current amount
// (the `min 0` bound) shows the browser's own text; (e) an end date not after the start;
// (f) a combined-total tracker with no account chosen; (g) a savings-transactions tracker
// with no "Savings" category shows the form's own line.
// Starts its own API and web app against a throwaway database (./_local_stack.cjs) and
// seeds through the API. Not wired into CI and not part of `pnpm build`. Run steps: see
// ./README.md.
//
// Check kinds: [B] behavioural, [S] structural (a failed one makes the run invalid),
// [G] guard. The script ends with RESULT: k/m and exits 0 only when every check passed,
// 1 when any failed, 2 for setup.
//
// Usage: node frontend/e2e/dialogs-allocations.cjs [scenario]
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
const posts = (log) => log.filter((r) => r.method === 'POST' && pathOf(r.url).endsWith('/allocations')).length
const today = () => new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10)

const budgetForm = (page) => page.locator('form').filter({ has: page.getByRole('button', { name: 'Create Budget Envelope' }) })
const savingsForm = (page) => page.locator('form').filter({ has: page.getByRole('button', { name: 'Create Savings Tracker' }) })
const field = (form, key) => form.locator(`[data-field="${key}"]`)
const errorOf = (page, key) => page.locator(`[data-testid="field-error-${key}"]`)

/** A fresh signed-in page on Allocations, its native dialogs tracked and its requests logged. */
async function openAllocations(browser, tab) {
  const { ctx, page } = await h.newPage(browser)
  page.setDefaultTimeout(10000)
  const native = d.trackNativeDialogs(page)
  const log = h.logRequests(page)
  await h.uiLogin(page, stack, owner)
  await page.goto(`${stack.webUrl}/allocations`)
  await page.getByRole('button', { name: tab, exact: true }).waitFor()
  await h.waitQuiet(page)
  await page.getByRole('button', { name: tab, exact: true }).click()
  await h.waitQuiet(page)
  return { ctx, page, native, log }
}

async function openAddForm(page, formOf) {
  await page.getByRole('button', { name: 'Add Allocation' }).click()
  const form = formOf(page)
  await form.waitFor()
  await h.waitQuiet(page)
  return form
}

/** Fills a budget envelope so every field is valid, then lets the caller break one. */
async function fillValidBudget(form, name) {
  await field(form, 'account_id').selectOption(String(bank.id))
  await field(form, 'name').fill(name)
  await form.locator('[data-field="category_ids"] button').filter({ hasText: 'Utilities' }).first().click()
  await field(form, 'target_amount').fill('1000')
}

/** The shared inline-error checks for a form control: message, ARIA wiring, focus, nothing sent. */
async function checkFieldError(page, form, log, scenario, key, wantText, postsBefore) {
  const err = errorOf(page, key)
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
  await checkSentNothing(page, log, scenario, postsBefore)
}

async function checkSentNothing(page, log, scenario, postsBefore) {
  await h.check(`${scenario}.nothing-sent`, 'B', async () => posts(log) === postsBefore || `${posts(log) - postsBefore} POST /allocations`)
  await h.check(`${scenario}.form-still-open`, 'B', async () => (await page.getByLabel('Close allocation modal').count()) === 1 || 'the form closed')
}

/** The picker-group checks (Q3): the group and every chip point at the error; focus is on the first chip. */
async function checkGroupError(page, form, log, scenario, key, wantText, postsBefore) {
  await h.check(`${scenario}.error-shown`, 'B', async () => {
    const shown = await errorOf(page, key).waitFor({ timeout: 3000 }).then(() => true, () => false)
    if (!shown) return `no field-error-${key}`
    const text = await errorOf(page, key).innerText()
    return text === wantText || `message ${JSON.stringify(text)}`
  })
  await h.check(`${scenario}.group-aria`, 'B', async () => {
    const got = await field(form, key).evaluate((el, id) => ({
      role: el.getAttribute('role'),
      invalid: el.getAttribute('aria-invalid'),
      describedby: el.getAttribute('aria-describedby'),
      labelled: Boolean(document.getElementById(el.getAttribute('aria-labelledby') || '')),
      chips: [...el.querySelectorAll('button')].map((b) => b.getAttribute('aria-describedby')),
      target: id,
    }), `allocation-${key}-error`)
    const ok = got.role === 'group' && got.invalid === null && got.describedby === got.target && got.labelled &&
      got.chips.length > 0 && got.chips.every((c) => c === got.target)
    return ok || `got ${JSON.stringify(got)}`
  })
  await h.check(`${scenario}.focus-on-first-chip`, 'B', async () => {
    const ok = await field(form, key).evaluate((el) => document.activeElement === el.querySelector('button'))
    return ok || `active ${await d.activeTestId(page)}`
  })
  await checkSentNothing(page, log, scenario, postsBefore)
}

// (a) An empty name: the browser's required check runs, the app shows its own copy inline.
async function scenarioA(browser) {
  console.log('\n=== (a) empty name: an inline error with focus, nothing sent')
  const { ctx, page, native, log } = await openAllocations(browser, 'Budgets')
  try {
    const form = await openAddForm(page, budgetForm)
    await field(form, 'account_id').selectOption(String(bank.id))
    const before = posts(log)
    await form.getByRole('button', { name: 'Create Budget Envelope' }).click()
    // Two fields fail the browser's check in this attempt; only the first is shown and focused.
    await h.check('a.two-invalid', 'S', async () => {
      const flagged = [
        await field(form, 'name').evaluate((el) => el.validity.valueMissing),
        await field(form, 'target_amount').evaluate((el) => el.validity.valueMissing),
      ]
      return flagged.every(Boolean) || `name and target_amount valueMissing: ${JSON.stringify(flagged)}`
    })
    // The first field must show its message, wiring and focus before either field is edited.
    await checkFieldError(page, form, log, 'a', 'name', 'Please enter a name for this allocation.', before)
    await h.check('a.second-not-shown', 'B', async () =>
      (await errorOf(page, 'target_amount').count()) === 0 || 'the second invalid field shows an error')
    await h.check('a.typing-clears', 'B', async () => {
      await field(form, 'name').fill('x')
      return (await errorOf(page, 'name').count()) === 0 || 'the error stayed after an edit'
    })
  } finally {
    await d.checkNoNativeDialogs(h, 'a', native)
    await ctx.close()
  }
}

// (b) A budget with everything filled but no category: the form's own check.
async function scenarioB(browser) {
  console.log('\n=== (b) a budget with no category: an inline error on the category chips, nothing sent')
  const { ctx, page, native, log } = await openAllocations(browser, 'Budgets')
  try {
    const form = await openAddForm(page, budgetForm)
    await field(form, 'account_id').selectOption(String(bank.id))
    await field(form, 'name').fill('Dialog B Envelope')
    await field(form, 'target_amount').fill('1000')
    const before = posts(log)
    await form.getByRole('button', { name: 'Create Budget Envelope' }).click()
    await checkGroupError(page, form, log, 'b', 'category_ids', 'Select at least one category for this budget envelope.', before)
    await h.check('b.choosing-clears', 'B', async () => {
      await form.locator('[data-field="category_ids"] button').first().click()
      return (await errorOf(page, 'category_ids').count()) === 0 || 'the error stayed after choosing a category'
    })
  } finally {
    await d.checkNoNativeDialogs(h, 'b', native)
    await ctx.close()
  }
}

// (d) A negative current amount: the browser's min check runs, its text shown inline.
async function scenarioD(browser) {
  console.log('\n=== (d) current amount -5 (below min): the browser\'s message shown inline, nothing sent')
  const { ctx, page, native, log } = await openAllocations(browser, 'Budgets')
  try {
    const form = await openAddForm(page, budgetForm)
    await fillValidBudget(form, 'Dialog D Envelope')
    await field(form, 'current_amount').fill('-5')
    const before = posts(log)
    await form.getByRole('button', { name: 'Create Budget Envelope' }).click()
    await checkFieldError(page, form, log, 'd', 'current_amount', null, before)
    await h.check('d.browser-text', 'B', async () => {
      const [shown, browserText] = await Promise.all([
        errorOf(page, 'current_amount').innerText(),
        field(form, 'current_amount').evaluate((el) => el.validationMessage),
      ])
      return (browserText !== '' && shown === browserText) || `shown ${JSON.stringify(shown)}, browser ${JSON.stringify(browserText)}`
    })
    await h.check('d.typing-clears', 'B', async () => {
      await field(form, 'current_amount').fill('5')
      return (await errorOf(page, 'current_amount').count()) === 0 || 'the error stayed after an edit'
    })
  } finally {
    await d.checkNoNativeDialogs(h, 'd', native)
    await ctx.close()
  }
}

// (e) An end date that is not after the start: the form's own check, on the end date.
async function scenarioE(browser) {
  console.log('\n=== (e) period end before the start: an inline error on the end date, nothing sent')
  const { ctx, page, native, log } = await openAllocations(browser, 'Budgets')
  try {
    const form = await openAddForm(page, budgetForm)
    await fillValidBudget(form, 'Dialog E Envelope')
    await field(form, 'period_end').fill('2020-01-01')
    const before = posts(log)
    await form.getByRole('button', { name: 'Create Budget Envelope' }).click()
    await checkFieldError(page, form, log, 'e', 'period_end', 'Budget end date must be after the start date.', before)
  } finally {
    await d.checkNoNativeDialogs(h, 'e', native)
    await ctx.close()
  }
}

// (f) A combined-total savings tracker with no account chosen.
async function scenarioF(browser) {
  console.log('\n=== (f) a combined-total tracker with no account: an inline error on the account chips, nothing sent')
  const { ctx, page, native, log } = await openAllocations(browser, 'Savings')
  try {
    const form = await openAddForm(page, savingsForm)
    await field(form, 'account_id').selectOption(String(bank.id))
    await field(form, 'name').fill('Dialog F Tracker')
    await form.getByRole('button', { name: 'Combined account total' }).click()
    const before = posts(log)
    await form.getByRole('button', { name: 'Create Savings Tracker' }).click()
    await checkGroupError(page, form, log, 'f', 'savings_account_ids', 'Choose at least one account to aggregate for this savings tracker.', before)
  } finally {
    await d.checkNoNativeDialogs(h, 'f', native)
    await ctx.close()
  }
}

// (g) A savings-transactions tracker with no "Savings" category: no field to fix, so the form's own line.
async function scenarioG(browser) {
  console.log('\n=== (g) a savings-transactions tracker with no Savings category: the form line, nothing sent')
  const { ctx, page, native, log } = await openAllocations(browser, 'Savings')
  try {
    const form = await openAddForm(page, savingsForm)
    await field(form, 'account_id').selectOption(String(bank.id))
    await field(form, 'name').fill('Dialog G Tracker')
    await form.getByRole('button', { name: 'Savings transactions total' }).click()
    const before = posts(log)
    await form.getByRole('button', { name: 'Create Savings Tracker' }).click()
    const line = page.locator('[data-testid="allocation-form-error"]')
    await h.check('g.line-shown', 'B', async () => {
      const shown = await line.waitFor({ timeout: 3000 }).then(() => true, () => false)
      if (!shown) return 'no allocation-form-error'
      const text = await line.innerText()
      return text === 'Create a "Savings" category first so we can total those transactions.' || `message ${JSON.stringify(text)}`
    })
    await checkSentNothing(page, log, 'g', before)
    await h.check('g.mode-change-clears', 'B', async () => {
      await form.getByRole('button', { name: 'Target account balance' }).click()
      await h.waitQuiet(page)
      const gone = await line.waitFor({ state: 'detached', timeout: 2000 }).then(() => true, () => false)
      return gone || 'the line stayed after changing the goal mode'
    })
    await form.getByRole('button', { name: 'Savings transactions total' }).click()
    await form.getByRole('button', { name: 'Create Savings Tracker' }).click()
    await line.waitFor({ timeout: 3000 }).catch(() => null)
    await h.check('g.saving-again-clears', 'B', async () => {
      await form.getByRole('button', { name: 'Target account balance' }).click()
      await form.getByRole('button', { name: 'Create Savings Tracker' }).click()
      await page.getByLabel('Close allocation modal').waitFor({ state: 'detached', timeout: 5000 }).catch(() => null)
      return (await line.count()) === 0 || 'the line stayed'
    })
  } finally {
    await d.checkNoNativeDialogs(h, 'g', native)
    await ctx.close()
  }
}

const SCENARIOS = [
  ['a', scenarioA],
  ['b', scenarioB],
  ['d', scenarioD],
  ['e', scenarioE],
  ['f', scenarioF],
  ['g', scenarioG],
]

async function setup() {
  owner = await h.makeUser(stack, 'allocdlg')
  bank = await client.post(owner.token, '/accounts/', { name: 'Alloc Checking', account_type: 'checking', balance: 100000, currency: 'PHP' })
  const categories = await client.get(owner.token, '/categories/?limit=200')
  const list = categories.items ?? categories
  const utilities = list.find((c) => c.name.toLowerCase() === 'utilities')
  if (!utilities) throw new Error('no Utilities category on a new account')
  // (g) needs a user with no "Savings" category; a new user starts with one, so remove it.
  for (const c of list.filter((c) => c.name.toLowerCase() === 'savings')) {
    const res = await client.api(owner.token, 'DELETE', `/categories/${c.id}`)
    if (res.status >= 300) throw new Error(`could not remove the Savings category: ${res.status}`)
  }
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
