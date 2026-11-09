// Browser checks for the native account and category dropdowns, which keep their <select>
// and gain <optgroup> headings: accounts under Debit, Credit, E-wallet, Cash and Loan (the
// Accounts page's labels), categories under Expense, Income and Transfer.
// (a) the recurring entry form: Account (S2), Category (S3), Overflow account (S4) and
//     Transfer to (S5) are grouped, each keeps its own filter (S2 and S4 list no loan, S5
//     lists the loan and no card), the placeholder stays first and outside any group, every
//     option is listed once, and the option values and saved payload are unchanged;
// (b) the allocation form's Account (S1); (c) the card Pay dialog's Pay from (S6), only
//     eligible payers; (d) the loan page's payment account (S7); (e) the account form's Paid
//     From and Overflow To on a card (S8, S9, the stored placeholder first) and Paid From on a
//     loan (S10, loan currency only); (f) Settings' Main account (S11, "name (currency)" text,
//     "None" first) and saving still works; (g) a card whose saved payer is no longer offered
//     keeps its "Current account" option after the placeholder, selected.
// Starts its own API and web app against a throwaway database (./_local_stack.cjs) and seeds
// through the API. Not wired into CI and not part of `pnpm build`. Run steps: see ./README.md.
//
// Check kinds: [B] behavioural, [S] structural, [G] guard. The script ends with RESULT: k/m
// and exits 0 only when every check passed, 1 when any failed, 2 for setup.
//
// Usage: node frontend/e2e/picker-optgroups.cjs [scenario]
const { startLocalStack } = require('./_local_stack.cjs')
const h = require('./_smooth.cjs')

const playwrightPath = process.env.PLAYWRIGHT_PATH || 'playwright'
let chromium
try {
  ;({ chromium } = require(playwrightPath))
} catch {
  console.error(`Cannot load Playwright from "${playwrightPath}". Set PLAYWRIGHT_PATH (see frontend/e2e/README.md).`)
  process.exit(2)
}

const only = process.argv[2]
let stack, client, owner, A

const manilaToday = () => new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10)
const addDays = (day, n) => {
  const d = new Date(`${day}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().slice(0, 10)
}
const wire = (day) => `${day}T00:00:00`

/**
 * A select's structure: the options outside any group (in order) and each optgroup's label
 * with its options, as [value, text] pairs.
 */
async function shape(select) {
  return select.evaluate((el) => {
    const pair = (o) => [o.value, o.textContent.replace(/\s+/g, ' ').trim()]
    const loose = []
    const groups = []
    for (const child of el.children) {
      if (child.tagName === 'OPTION') loose.push(pair(child))
      else if (child.tagName === 'OPTGROUP') groups.push({ label: child.label, options: [...child.children].map(pair) })
    }
    return { loose, groups }
  })
}
const labelsOf = (s) => s.groups.map((g) => g.label)
const idsOf = (s) => s.groups.flatMap((g) => g.options.map(([v]) => Number(v)))
const namesIn = (s, label) => (s.groups.find((g) => g.label === label)?.options ?? []).map(([, t]) => t)
const same = (got, want) => JSON.stringify(got) === JSON.stringify(want) || `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`

async function newPage(browser) {
  const { ctx, page } = await h.newPage(browser)
  page.setDefaultTimeout(10000)
  await h.uiLogin(page, stack, owner)
  return { ctx, page }
}
const field = (form, key) => form.locator(`[data-field="${key}"]`)

// (a) The recurring entry form.
async function scenarioA(browser) {
  console.log('\n=== (a) recurring entry form: Account, Category, Overflow account and Transfer to are grouped')
  const { ctx, page } = await newPage(browser)
  try {
    await page.goto(`${stack.webUrl}/allocations`)
    await page.getByRole('button', { name: 'Add Recurring Entry' }).click()
    await page.getByLabel('Close allocation modal').waitFor()
    await h.waitQuiet(page)
    const form = page.locator('form').filter({ has: page.getByRole('button', { name: 'Save Recurring Entry' }) })
    const account = await shape(field(form, 'account_id'))
    await h.check('a.account.groups', 'B', async () => same(labelsOf(account), ['Debit', 'Credit', 'E-wallet', 'Cash']))
    await h.check('a.account.placeholder-first-and-outside', 'B', async () => same(account.loose, [['0', 'Select account']]))
    await h.check('a.account.no-loan-and-filtered-set', 'B', async () => same(idsOf(account).sort(), [A.bank.id, A.bank2.id, A.card.id, A.wallet.id, A.cash.id, A.usd.id, A.payCard.id, A.orphan.id].sort()))
    await h.check('a.account.sorted-by-name-within-group', 'B', async () => same(namesIn(account, 'Debit'), ['Alpha Checking', 'Dollar Checking', 'Zeta Savings']))
    await h.check('a.account.option-text-is-the-name', 'B', async () => same(namesIn(account, 'Cash'), ['Pocket Cash']))
    await h.check('a.account.listed-once', 'S', async () => new Set(idsOf(account)).size === idsOf(account).length || 'duplicate option')

    const category = await shape(form.locator('select').filter({ has: page.locator('option', { hasText: 'Uncategorized' }) }))
    await h.check('a.category.groups-by-kind', 'B', async () => labelsOf(category).join('|') === 'Expense|Income|Transfer' || `got ${labelsOf(category)}`)
    await h.check('a.category.uncategorized-first-and-outside', 'B', async () => same(category.loose, [['0', 'Uncategorized']]))
    await h.check('a.category.each-in-its-kind', 'B', async () => {
      const inKind = (label) => category.groups.find((g) => g.label === label).options.map(([v]) => Number(v))
      return (inKind('Income').includes(A.income.id) && inKind('Expense').includes(A.expense.id) && inKind('Transfer').includes(A.transfer.id)) || 'a category is in the wrong kind'
    })
    await h.check('a.category.all-listed-once', 'S', async () => {
      const ids = idsOf(category)
      return (new Set(ids).size === ids.length && ids.length === A.categoryCount) || `${ids.length} of ${A.categoryCount}`
    })

    const overflow = await shape(form.locator('select').filter({ has: page.locator('option', { hasText: /^None$/ }) }))
    await h.check('a.overflow.filter-kept', 'B', async () => same(overflow.loose, [['0', 'None']]) === true && same(idsOf(overflow).sort(), [A.bank.id, A.bank2.id, A.cash.id, A.card.id, A.usd.id, A.payCard.id, A.orphan.id].sort()))
    await h.check('a.overflow.no-spending-wallet-or-loan', 'B', async () => !idsOf(overflow).includes(A.wallet.id) && !idsOf(overflow).includes(A.loan.id) || 'a wallet or loan is offered')

    await field(form, 'account_id').selectOption(String(A.bank.id))
    const transfer = await shape(form.locator('select').filter({ has: page.locator('option', { hasText: 'None (a payment)' }) }))
    await h.check('a.transfer.placeholder-first-and-outside', 'B', async () => same(transfer.loose, [['0', 'None (a payment)']]))
    await h.check('a.transfer.filter-kept', 'B', async () => same(idsOf(transfer).sort(), [A.bank2.id, A.wallet.id, A.cash.id, A.loan.id, A.usd.id].sort()))
    await h.check('a.transfer.loan-in-its-own-group', 'B', async () => same(namesIn(transfer, 'Loan'), ['Car Loan']))

    // The saved payload is unchanged: ids as numbers.
    await field(form, 'name').fill('Optgroup rent')
    await field(form, 'amount').fill('250')
    await field(form, 'account_id').selectOption(String(A.bank2.id))
    await form.locator('select').filter({ has: page.locator('option', { hasText: 'Uncategorized' }) }).selectOption(String(A.expense.id))
    const saved = page.waitForRequest((r) => r.method() === 'POST' && new URL(r.url()).pathname.endsWith('/budget-entries/'))
    await form.getByRole('button', { name: 'Save Recurring Entry' }).click()
    const body = (await saved).postDataJSON()
    await h.check('a.payload-unchanged', 'B', async () =>
      (body.account_id === A.bank2.id && body.category_id === A.expense.id && !body.transfer_to_account_id && !body.overflow_account_id) || `body ${JSON.stringify(body)}`)
  } finally {
    await ctx.close()
  }
}

// (b) The allocation form's Account.
async function scenarioB(browser) {
  console.log('\n=== (b) allocation form: Account is grouped')
  const { ctx, page } = await newPage(browser)
  try {
    await page.goto(`${stack.webUrl}/allocations`)
    await page.getByRole('button', { name: 'Budgets', exact: true }).waitFor()
    await h.waitQuiet(page)
    await page.getByRole('button', { name: 'Budgets', exact: true }).click()
    await h.waitQuiet(page)
    await page.getByRole('button', { name: 'Add Allocation' }).click()
    const sel = page.locator('select[data-field="account_id"]')
    await sel.waitFor()
    await h.waitQuiet(page)
    const s = await shape(sel)
    await h.check('b.groups', 'B', async () => same(labelsOf(s), ['Debit', 'Credit', 'E-wallet', 'Cash', 'Loan']))
    await h.check('b.placeholder-first-and-outside', 'B', async () => same(s.loose, [['0', 'Select account']]))
    await h.check('b.own-accounts-set', 'B', async () => same(idsOf(s).sort(), [A.bank.id, A.bank2.id, A.card.id, A.wallet.id, A.cash.id, A.usd.id, A.loan.id, A.payCard.id, A.orphan.id].sort()))
    await h.check('b.value-selectable', 'B', async () => {
      await sel.selectOption(String(A.bank.id))
      return (await sel.inputValue()) === String(A.bank.id) || 'value not set'
    })
  } finally {
    await ctx.close()
  }
}

// (c) The card Pay dialog.
async function scenarioC(browser) {
  console.log('\n=== (c) card Pay dialog: Pay from is grouped and lists only eligible payers')
  const { ctx, page } = await newPage(browser)
  try {
    await page.goto(`${stack.webUrl}/accounts/${A.payCard.id}`)
    await page.locator('[data-testid="card-credit-panel"]').waitFor()
    await h.waitQuiet(page)
    await page.locator('[data-testid="card-pay-open"]').click()
    const sel = page.locator('[data-testid="card-pay-from"]')
    await sel.waitFor()
    await h.waitQuiet(page)
    const s = await shape(sel)
    await h.check('c.groups', 'B', async () => same(labelsOf(s), ['Debit', 'E-wallet', 'Cash']))
    await h.check('c.no-placeholder', 'B', async () => same(s.loose, []))
    await h.check('c.eligible-payers-only', 'B', async () => same(idsOf(s).sort(), [A.bank.id, A.bank2.id, A.wallet.id, A.cash.id].sort()))
    await h.check('c.default-payer-kept', 'B', async () => (await sel.inputValue()) === String(A.bank.id) || `selected ${await sel.inputValue()}`)
  } finally {
    await ctx.close()
  }
}

// (d) The loan page's payment form.
async function scenarioD(browser) {
  console.log('\n=== (d) loan payment form: the payment account is grouped')
  const { ctx, page } = await newPage(browser)
  try {
    await page.goto(`${stack.webUrl}/accounts`)
    await page.locator('article').first().waitFor()
    await h.waitQuiet(page)
    await page.locator('article').filter({ has: page.getByText('Car Loan', { exact: true }) }).locator('[role="button"]').first().click()
    await page.getByRole('button', { name: 'Record payment', exact: true }).first().click()
    const sel = page.locator('select').filter({ has: page.locator('option', { hasText: 'Select account' }) })
    await sel.waitFor()
    await h.waitQuiet(page)
    const s = await shape(sel)
    await h.check('d.groups', 'B', async () => same(labelsOf(s), ['Debit', 'Cash']))
    await h.check('d.placeholder-first-and-outside', 'B', async () => same(s.loose, [['', 'Select account']]))
    await h.check('d.loan-currency-only', 'B', async () => same(idsOf(s).sort(), [A.bank.id, A.bank2.id, A.cash.id].sort()))
  } finally {
    await ctx.close()
  }
}

// (e) The account form.
async function scenarioE(browser) {
  console.log('\n=== (e) account form: Paid From and Overflow To (card), Paid From (loan) are grouped')
  const { ctx, page } = await newPage(browser)
  try {
    await page.goto(`${stack.webUrl}/accounts`)
    const after = (text) => page.locator('label', { hasText: text }).locator('xpath=following-sibling::select').first()
    await page.getByRole('button', { name: 'Add Account', exact: true }).click()
    await page.getByPlaceholder('Enter account name').fill('Form card')
    await page.locator('select').filter({ has: page.locator('option[value="credit"]') }).first().selectOption('credit')
    await page.getByRole('button', { name: 'Show details' }).click()
    const paid = after('Paid From')
    const over = after('Overflow To')
    await paid.waitFor()
    const p = await shape(paid)
    await h.check('e.card-paid-from.groups', 'B', async () => same(labelsOf(p), ['Debit', 'Cash']))
    await h.check('e.card-paid-from.placeholder-first-and-outside', 'B', async () => same(p.loose, [['', 'Not set']]))
    await h.check('e.card-paid-from.set', 'B', async () => same(idsOf(p).sort(), [A.bank.id, A.bank2.id, A.cash.id, A.usd.id].sort()))
    await paid.selectOption(String(A.bank.id))
    const o = await shape(over)
    await h.check('e.card-overflow.groups', 'B', async () => same(labelsOf(o), ['Debit', 'Cash']))
    await h.check('e.card-overflow.not-the-payer', 'B', async () => same(idsOf(o).sort(), [A.bank2.id, A.cash.id, A.usd.id].sort()))
    await h.check('e.card-overflow.placeholder-first-and-outside', 'B', async () => same(o.loose, [['', 'Not set']]))

    await page.locator('select').filter({ has: page.locator('option[value="credit"]') }).first().selectOption('loan')
    const lp = after('Paid From')
    await lp.waitFor()
    const l = await shape(lp)
    await h.check('e.loan-paid-from.groups', 'B', async () => same(labelsOf(l), ['Debit', 'Cash']))
    await h.check('e.loan-paid-from.placeholder-first-and-outside', 'B', async () => same(l.loose, [['', 'Not set']]))
    await h.check('e.loan-paid-from.currency-filter', 'B', async () => same(idsOf(l).sort(), [A.bank.id, A.bank2.id, A.cash.id].sort()))
  } finally {
    await ctx.close()
  }
}

// (f) Settings' Main account.
async function scenarioF(browser) {
  console.log('\n=== (f) Settings: Main account is grouped, saves the same value')
  const { ctx, page } = await newPage(browser)
  try {
    await page.goto(`${stack.webUrl}/settings`)
    const sel = page.locator('#main-account')
    await sel.waitFor()
    await h.waitQuiet(page)
    const s = await shape(sel)
    await h.check('f.groups', 'B', async () => labelsOf(s).join('|') === 'Debit|Cash' || `got ${labelsOf(s)}`)
    await h.check('f.none-first-and-outside', 'B', async () => same(s.loose, [['', 'None (all cash accounts)']]))
    await h.check('f.pinnable-set-and-text', 'B', async () => {
      const t = namesIn(s, 'Debit')
      return same(t, ['Alpha Checking (PHP)', 'Dollar Checking (USD)', 'Zeta Savings (PHP)'])
    })
    const put = page.waitForResponse((r) => r.request().method() !== 'GET' && /\/auth\/me|\/users\/me|main/.test(r.url()))
    await sel.selectOption(String(A.bank2.id))
    const res = await put.catch(() => null)
    await h.waitQuiet(page)
    await h.check('f.saved-value', 'B', async () => {
      const me = await client.get(owner.token, '/auth/me')
      return me.main_account_id === A.bank2.id || `main_account_id ${me.main_account_id} (${res ? res.status() : 'no request'})`
    })
    await h.check('f.value-kept-after-save', 'B', async () => (await sel.inputValue()) === String(A.bank2.id) || `selected ${await sel.inputValue()}`)
  } finally {
    await ctx.close()
  }
}

// (g) A card whose saved payer is no longer offered keeps its "Current account" option, selected.
async function scenarioG(browser) {
  console.log('\n=== (g) card Paid From: a saved payer that is not offered shows "Current account", selected')
  const { ctx, page } = await newPage(browser)
  try {
    await page.goto(`${stack.webUrl}/accounts`)
    await page.locator('article').first().waitFor()
    await h.waitQuiet(page)
    await page.locator('article').filter({ has: page.getByText('Orphan Card', { exact: true }) }).locator('[role="button"]').first().click()
    await page.getByRole('button', { name: 'Edit account' }).click()
    await page.getByRole('button', { name: 'Show details' }).click()
    const paid = page.locator('label', { hasText: 'Paid From' }).locator('xpath=following-sibling::select').first()
    await paid.waitFor()
    const s = await shape(paid)
    await h.check('g.setup-payer-not-offered', 'S', async () => !idsOf(s).includes(A.gone.id) || 'the inactive payer is offered')
    await h.check('g.current-account-after-placeholder', 'B', async () => same(s.loose, [['', 'Not set'], [String(A.gone.id), 'Current account']]))
    await h.check('g.current-account-selected', 'B', async () => (await paid.inputValue()) === String(A.gone.id) || `selected ${await paid.inputValue()}`)
    await h.check('g.offered-payers-grouped', 'B', async () => labelsOf(s).join('|') === 'Debit|Cash' || `got ${labelsOf(s)}`)
  } finally {
    await ctx.close()
  }
}

const SCENARIOS = [['a', scenarioA], ['b', scenarioB], ['c', scenarioC], ['d', scenarioD], ['e', scenarioE], ['f', scenarioF], ['g', scenarioG]]

async function setup() {
  owner = await h.makeUser(stack, 'optgroups')
  const mk = (name, account_type, extra = {}) =>
    client.post(owner.token, '/accounts/', { name, account_type, balance: 100000, currency: 'PHP', ...extra })
  const today = manilaToday()
  const anchor = addDays(today, -5)
  const closeDom = Math.min(Number(anchor.slice(8, 10)), 28)
  const close = `${anchor.slice(0, 8)}${String(closeDom).padStart(2, '0')}`
  // Created out of name order, to see the sort.
  const bank2 = await mk('Zeta Savings', 'savings')
  const bank = await mk('Alpha Checking', 'checking')
  const wallet = await mk('Gcash Wallet', 'e_wallet', { is_spending_wallet: true })
  const cash = await mk('Pocket Cash', 'cash')
  const card = await mk('Blue Card', 'credit', { balance: 0, credit_limit: 50000, billing_cycle_start: 20, days_until_due_date: 21 })
  const loan = await mk('Car Loan', 'loan', {
    balance: -100000, loan_kind: 'auto', loan_annual_rate: 12, loan_term_months: 24, loan_payment_amount: 5000,
    loan_first_payment_date: wire(addDays(today, 7)),
  })
  // A USD account: never an eligible payer of a PHP card or loan.
  const usd = await client.post(owner.token, '/accounts/', { name: 'Dollar Checking', account_type: 'checking', balance: 1000, currency: 'USD' })
  const presets = await client.get(owner.token, '/accounts/minimum-due-presets')
  const payCard = await client.post(owner.token, '/accounts/', {
    name: 'Statement Card', account_type: 'credit', balance: 0, currency: 'PHP', credit_limit: 50000,
    billing_cycle_start: closeDom, days_until_due_date: 21, payment_account_id: bank.id,
    minimum_due_rule: presets.find((p) => p.key === 'bdo').rule,
  })
  await client.post(owner.token, '/transactions/', {
    account_id: payCard.id, transaction_type: 'debit', amount: 2000, description: 'Purchase',
    transaction_date: wire(addDays(close, -3)), is_posted: true,
  })
  const gone = await mk('Closed Checking', 'checking')
  const orphan = await client.post(owner.token, '/accounts/', {
    name: 'Orphan Card', account_type: 'credit', balance: 0, currency: 'PHP', credit_limit: 50000,
    billing_cycle_start: 10, days_until_due_date: 21, payment_account_id: gone.id,
  })
  await client.put(owner.token, `/accounts/${gone.id}`, { is_active: false })
  const cats = await client.get(owner.token, '/categories/')
  const list = Array.isArray(cats) ? cats : cats.items
  const kindOf = (c) => c.kind ?? (c.is_expense ? 'expense' : 'income')
  const first = (k) => list.find((c) => kindOf(c) === k)
  A = {
    bank, bank2, wallet, cash, card, loan, payCard, usd, gone, orphan,
    income: first('income'), expense: first('expense'), transfer: first('transfer'), categoryCount: list.length,
  }
  if (!A.income || !A.expense || !A.transfer) throw new Error('default categories of every kind are missing')
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
