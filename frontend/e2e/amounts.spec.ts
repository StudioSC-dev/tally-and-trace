// STU-680: money out is ink, money in is green with a sign, and red only means overdue, negative or failed
// (docs/design-system.md, "Amounts"). The API is faked in the browser with the shared household fixture; there is
// no backend.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test } from '@playwright/test'
import type { Locator, Page } from '@playwright/test'
import { accountDetailRoutes, budgetEntriesFor, calmHousehold, household, limitedRecurring, mockHousehold } from './support/fixtures/household'
import type { HouseholdData } from './support/fixtures/household'
import { addRoutes, apiRoute, errorRoute, queryRoute } from './support/mockApi'
import type { BudgetEntry, CardStatementsResponse, PaginatedResponse } from '@tally-trace/shared'
import { shot } from './support/shot'

// This spec lives in <repo>/frontend/e2e.
const FRONTEND = fileURLToPath(new URL('..', import.meta.url))
const readFrontend = (rel: string): string => fs.readFileSync(path.join(FRONTEND, rel), 'utf8')
const BASELINE = fileURLToPath(new URL('./amounts-layout.baseline.json', import.meta.url))

// Design-system tokens (docs/design-system.md) as getComputedStyle reports them.
const LIGHT = { ink: 'rgb(22, 36, 28)', ok: 'rgb(42, 100, 64)', danger: 'rgb(174, 42, 32)' }
const DARK = { ink: 'rgb(229, 238, 231)', ok: 'rgb(140, 198, 160)', danger: 'rgb(240, 150, 140)' }
const THEMES = [
  ['light', LIGHT],
  ['dark', DARK],
] as const

const CARD_ID = 15
/** The card's balance in the fixture, as the page prints its magnitude. */
const CARD_OWED = '18,742.30'
/** The two places an amount is read. */
const LISTS = ['transactions', 'recurring'] as const
/** Budget envelopes in the fixture at 50, 80 (exactly), 85, 100 (exactly) and 120 percent of their limits, with the fill and track colours the design system gives each level. */
const ENVELOPES = [
  { name: 'Dining out', level: '50%', fill: ['rgb(74, 89, 80)', 'rgb(147, 165, 152)'] },
  { name: 'Transport', level: '80%', fill: ['rgb(135, 80, 0)', 'rgb(228, 176, 98)'] },
  { name: 'Groceries', level: '85%', fill: ['rgb(135, 80, 0)', 'rgb(228, 176, 98)'] },
  { name: 'Utilities', level: '100%', fill: ['rgb(135, 80, 0)', 'rgb(228, 176, 98)'] },
  { name: 'Shopping', level: '120%', fill: ['rgb(174, 42, 32)', 'rgb(240, 150, 140)'] },
] as const
const TRACK = ['rgb(214, 222, 211)', 'rgb(12, 19, 15)'] as const

const fillOf = (el: Locator): Promise<string> => el.evaluate((e) => getComputedStyle(e).backgroundColor)
const colourOf = (el: Locator): Promise<string> => el.evaluate((e) => getComputedStyle(e).color)
const coloursOf = (els: Locator): Promise<string[]> => els.evaluateAll((all) => all.map((e) => getComputedStyle(e).color))
const textsOf = (els: Locator): Promise<string[]> => els.evaluateAll((all) => all.map((e) => (e.textContent ?? '').trim()))

async function open(page: Page, url: string, data: HouseholdData = household): Promise<void> {
  await mockHousehold(page, data)
  await page.goto(url)
}

async function toggleDark(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Toggle theme' }).click()
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
}

/** Transactions, once its rows are listed. */
async function openTransactions(page: Page, data: HouseholdData = household): Promise<Locator> {
  await open(page, '/transactions', data)
  await expect(page.getByTestId('transactions-list-card')).toBeVisible()
  const list = page.locator('main')
  await expect(list.locator('article[data-transaction-id]').first()).toBeVisible()
  return list
}

/** Allocations on its Recurring tab, once its entries are listed. */
async function openRecurring(page: Page, data: HouseholdData = household): Promise<Locator> {
  await open(page, '/allocations?tab=recurring', data)
  await expect(page.locator('article').first()).toBeVisible()
  return page.locator('main')
}

const amountOf = (rows: Locator): Locator => rows.locator('p.text-lg.font-bold')
const expenseRows = (scope: Locator): Locator => scope.locator('article').filter({ hasText: /[Ee]xpense/ })
const incomeRows = (scope: Locator): Locator => scope.locator('article').filter({ hasText: /[Ii]ncome/ })

/** A viewport screenshot (for overlays), saved under `shot()`'s naming. */
async function viewportShot(page: Page, name: string): Promise<void> {
  const info = test.info()
  const spec = path.basename(info.file).replace(/\.spec\.ts$/, '')
  await page.screenshot({ path: path.join(info.project.outputDir, 'screens', `${spec}-${name}-${info.project.name}.png`), animations: 'disabled' })
}

/**
 * Every visible element inside `main` or a modal whose text or background is painted in the red pencil. A Delete button is the design
 * system's red-pencil outline variant (a destructive action, not an amount), so it is not counted.
 */
const redCount = (page: Page): Promise<number> =>
  page.evaluate(
    (red) =>
      [...document.querySelectorAll('main *, .modal-backdrop *')].filter((e) => {
        const box = e.getBoundingClientRect()
        const inDelete = (e.closest('button')?.textContent ?? '').trim().startsWith('Delete')
        const style = getComputedStyle(e)
        return (style.color === red || style.backgroundColor === red) && box.width > 0 && box.height > 0 && !inDelete
      }).length,
    LIGHT.danger,
  )

test.describe('amount colours (STU-680)', () => {
  for (const surface of LISTS) {
    test(`expenses are ink: ${surface}`, async ({ page }) => {
      const scope = surface === 'transactions' ? await openTransactions(page) : await openRecurring(page)
      const spent = amountOf(expenseRows(scope))
      const count = await spent.count()
      expect(count, `${surface} lists expense rows`).toBeGreaterThan(3)
      expect(await coloursOf(spent), `every ${surface} expense amount is ink`).toEqual(new Array<string>(count).fill(LIGHT.ink))
      await shot(page, `expenses-${surface}`)
    })

    test(`income is green with a sign: ${surface}`, async ({ page }) => {
      const scope = surface === 'transactions' ? await openTransactions(page) : await openRecurring(page)
      const earned = amountOf(incomeRows(scope))
      const count = await earned.count()
      expect(count, `${surface} lists income rows`).toBeGreaterThan(0)
      expect(await coloursOf(earned), `every ${surface} income amount is green`).toEqual(new Array<string>(count).fill(LIGHT.ok))
      expect((await textsOf(earned)).filter((t) => !t.startsWith('+')), `every ${surface} income amount starts with +`).toEqual([])
      await shot(page, `income-${surface}`)
    })
  }

  for (const [name, url] of [
    ['dashboard', '/'],
    ['Transactions', '/transactions'],
    ['Allocations', '/allocations'],
    ['Budgets', '/allocations?tab=budgets'],
  ] as const) {
    test(`red means overdue, negative or failed only: nothing red on a calm ${name}`, async ({ page }) => {
      await open(page, url, calmHousehold)
      await expect(page.locator('main')).toBeVisible()
      await page.waitForLoadState('networkidle')
      expect(await redCount(page), `elements painted in the red pencil on a calm ${name}`).toBe(0)
      await shot(page, `calm-${name.toLowerCase()}`)
    })
  }

  test('red means overdue, negative or failed only: nothing red in a calm budget modal', async ({ page }) => {
    await open(page, '/allocations?tab=budgets', calmHousehold)
    const budget = page.locator('article').filter({ hasText: 'Groceries' }).first()
    await expect(budget).toBeVisible()
    await expect(budget.getByText('Spent this period')).toBeVisible()
    expect(await colourOf(budget.getByText('Spent this period').locator('xpath=following-sibling::span')), 'Spent this period on the card').toBe(LIGHT.ink)
    await budget.click()
    const dialog = page.locator('.modal-backdrop')
    await expect(dialog.getByText(/^Spent/)).toBeVisible()
    expect(await redCount(page), 'elements painted in the red pencil in a calm budget modal').toBe(0)
    await viewportShot(page, 'calm-budget-modal')
  })

  test('red means overdue, negative or failed only: nothing red in a calm transfer with a fee', async ({ page }) => {
    const list = await openTransactions(page, calmHousehold)
    await list.locator('article[data-transaction-id]').filter({ hasText: 'Move to emergency fund' }).click()
    const fee = page.locator('.modal-backdrop').getByText('Transfer Fee')
    await expect(fee).toBeVisible()
    expect(await colourOf(fee.locator('xpath=following-sibling::dd')), 'the transfer fee amount').toBe(LIGHT.ink)
    expect(await redCount(page), 'elements painted in the red pencil in a calm transfer').toBe(0)
    await viewportShot(page, 'calm-transfer')
  })

  test('red means overdue, negative or failed only: the overdue payable is red', async ({ page }) => {
    await open(page, '/')
    const overdue = page.locator('[data-testid="payable-status"][aria-label="Overdue"]').first()
    await expect(overdue).toBeVisible()
    expect(await colourOf(overdue), 'the dashboard overdue payable badge').toBe(LIGHT.danger)
    await shot(page, 'overdue-dashboard')
  })

  test('red means overdue, negative or failed only: the overdue label on Transactions is red', async ({ page }) => {
    await open(page, '/transactions')
    const due = page.getByTestId('due-overdue').first()
    await expect(due).toBeVisible()
    expect(await colourOf(due), 'the Transactions overdue label').toBe(LIGHT.danger)
    await shot(page, 'overdue-transactions')
  })

  test('red means overdue, negative or failed only: the negative card balance is red', async ({ page }) => {
    await open(page, '/accounts')
    const balance = page.locator('.amount-negative').filter({ hasText: CARD_OWED })
    await expect(balance).toBeVisible()
    expect(await colourOf(balance), 'the card balance on Accounts').toBe(LIGHT.danger)
    await shot(page, 'negative-accounts')
  })

  test('red means overdue, negative or failed only: a failed save is red', async ({ page }) => {
    const list = await openTransactions(page)
    const row = list.locator('article[data-transaction-id]').filter({ hasText: 'Posted' }).first()
    const id = await row.getAttribute('data-transaction-id')
    await addRoutes(page, [errorRoute('PUT', `/transactions/${id}`, 500, 'Could not save this change.')])
    await row.click()
    await page.getByRole('button', { name: 'Mark as not posted' }).click()
    const alert = page.getByTestId('transaction-action-error')
    await expect(alert).toBeVisible()
    expect(await colourOf(alert), 'the failed-save alert').toBe(LIGHT.danger)
    await viewportShot(page, 'failed-save')
  })
})

/** What the amount column does on Transactions: tops relative to the first row, the right edge relative to the page body, so what sits above the list does not matter. */
interface RowBox {
  id: number
  top: number
  height: number
  /** Right edge of the amount's rendered text (a DOM Range), not of its box. */
  textRight: number
  /** Top of the amount's rendered text inside its row. */
  textTop: number
  align: string
}

async function rowBoxes(page: Page, list: Locator): Promise<RowBox[]> {
  await page.evaluate(() => document.fonts.ready)
  return list.evaluate((main) => {
    const rows = [...main.querySelectorAll<HTMLElement>('article[data-transaction-id]')]
    const first = rows[0].getBoundingClientRect()
    const left = main.getBoundingClientRect().left
    return rows.map((row) => {
      const r = row.getBoundingClientRect()
      const el = row.querySelector<HTMLElement>('p.text-lg.font-bold')
      const range = document.createRange()
      if (el) range.selectNodeContents(el)
      const t = range.getBoundingClientRect()
      return {
        id: Number(row.dataset.transactionId),
        top: Math.round(r.top - first.top),
        height: Math.round(r.height),
        textRight: Math.round(t.right - left),
        textTop: Math.round(t.top - r.top),
        align: el ? getComputedStyle(el).textAlign : '',
      }
    })
  })
}

test('amount styling preserves transaction layout', async ({ page }, testInfo) => {
  const list = await openTransactions(page)
  const boxes = await rowBoxes(page, list)
  await shot(page, 'layout')
  // `AMOUNTS_RECORD=1` rewrites the baseline: it is recorded once, on the PR base, before the amounts are restyled.
  const project = testInfo.project.name
  if (process.env.AMOUNTS_RECORD) {
    const all = fs.existsSync(BASELINE) ? (JSON.parse(fs.readFileSync(BASELINE, 'utf8')) as Record<string, RowBox[]>) : {}
    all[project] = boxes
    fs.writeFileSync(BASELINE, `${JSON.stringify(all, null, 2)}\n`)
    return
  }
  const base = (JSON.parse(fs.readFileSync(BASELINE, 'utf8')) as Record<string, RowBox[]>)[project]
  expect(base?.length, 'the baseline has rows for this project').toBeGreaterThan(5)
  expect(boxes.map((b) => b.id), 'row order').toEqual(base.map((b) => b.id))
  expect(boxes.map((b) => b.align), 'the amount keeps its text-align').toEqual(base.map((b) => b.align))
  const near = (key: 'top' | 'height' | 'textRight' | 'textTop'): number[] => boxes.map((b, i) => b[key] - base[i][key])
  expect(Math.max(...near('top').map(Math.abs)), 'row spacing: largest shift of a row from its base position').toBeLessThanOrEqual(1)
  expect(Math.max(...near('height').map(Math.abs)), 'row height: largest change from base').toBeLessThanOrEqual(1)
  expect(Math.max(...near('textRight').map(Math.abs)), 'amount column alignment: largest shift of the text right edge').toBeLessThanOrEqual(1)
  expect(Math.max(...near('textTop').map(Math.abs)), 'amount text position inside its row: largest shift').toBeLessThanOrEqual(1)
})

for (const surface of ['transactions', 'accounts'] as const) {
  test(`amount colours hold in dark: ${surface}`, async ({ page }) => {
    if (surface === 'transactions') {
      const list = await openTransactions(page)
      await toggleDark(page)
      expect(await colourOf(amountOf(expenseRows(list)).first()), 'an expense amount in dark').toBe(DARK.ink)
      expect(await colourOf(amountOf(incomeRows(list)).first()), 'an income amount in dark').toBe(DARK.ok)
    } else {
      await open(page, '/accounts')
      await toggleDark(page)
      const owed = page.locator('.amount-negative').filter({ hasText: CARD_OWED })
      await expect(owed).toBeVisible()
      expect(await colourOf(owed), 'a negative balance in dark').toBe(DARK.danger)
    }
    await shot(page, `dark-${surface}`)
  })
}

test.describe('envelope bars', () => {
  for (const surface of ['dashboard', 'Allocations'] as const) {
    for (const [theme] of THEMES) {
      for (const envelope of ENVELOPES) {
        test(`envelope bars are red only over budget: ${surface}, ${envelope.name} at ${envelope.level}, ${theme}`, async ({ page }) => {
          const index = theme === 'light' ? 0 : 1
          await open(page, surface === 'dashboard' ? '/' : '/allocations?tab=budgets')
          if (theme === 'dark') await toggleDark(page)
          const row = surface === 'dashboard'
            ? page.getByTestId('envelope-row').filter({ hasText: envelope.name })
            : page.locator('article').filter({ hasText: envelope.name })
          const fill = row.getByTestId('budget-usage-fill')
          await expect(fill).toBeVisible()
          await expect.poll(() => fillOf(fill), { message: `the ${envelope.level} fill on ${surface} in ${theme}` }).toBe(envelope.fill[index])
          await expect.poll(() => fillOf(row.getByTestId('budget-usage-track')), { message: `the track at ${envelope.level} on ${surface} in ${theme}` }).toBe(TRACK[index])
          await shot(page, `envelope-${surface.toLowerCase()}-${envelope.level.replace('%', '')}-${theme}`)
        })
      }
    }
  }
})

test.describe('amount classes', () => {
  test('amount colour is a class, not a selector shim: source', async ({ page }) => {
    await page.goto('about:blank')
    const css = readFrontend('src/assets/index.css')
    expect(css.includes('article .text-lg.font-bold.text-danger'), 'the stylesheet has no render-shim selector').toBe(false)
    for (const cls of ['amount-out', 'amount-in', 'amount-negative']) {
      expect(css, `the stylesheet defines .${cls}`).toMatch(new RegExp(`\\.${cls}\\s*\\{`))
    }
    const transactions = readFrontend('src/routes/transactions.tsx')
    expect(/amountClass\s*=[^;]{0,400}text-danger/.test(transactions), 'transactions.tsx has no amountClass choosing text-danger').toBe(false)
    // Every call site in the ticket's Scope renders through the shared helper, and none picks text-ok or text-danger for an amount itself.
    const sites = [
      'src/routes/transactions.tsx',
      'src/routes/allocations.tsx',
      'src/routes/index.tsx',
      'src/routes/accounts.tsx',
      'src/routes/accounts_.$accountId.tsx',
      'src/components/AccountTransactionList.tsx',
      'src/components/transactions/UpcomingOccurrenceRow.tsx',
    ]
    const lines = (source: string, pattern: RegExp): string[] => source.split('\n').filter((l) => pattern.test(l))
    const count = (source: string, pattern: RegExp): number => (source.match(pattern) ?? []).length
    for (const site of sites) {
      const source = readFrontend(site)
      expect(source, `${site} imports the shared amount helper`).toMatch(/from '(\.\.\/)+utils\/amount'/)
      expect(lines(source, /text-danger/).filter((l) => /usedAmount|current_amount|transferFeeLabel|amountLabel|amountClass|expenses|entry_type|transaction_type|direction|formatAmount|formatBalance/.test(l)), `${site}: no amount is coloured text-danger directly`).toEqual([])
      expect(lines(source, /text-ok/).filter((l) => /amountLabel|entry_type|transaction_type|direction|formatAmount|formatBalance/.test(l) || (site !== 'src/routes/index.tsx' && /balance/i.test(l))), `${site}: no amount or balance is coloured text-ok directly`).toEqual([])
    }
    // Per site: the amount markup takes its class from the helper, and only from the helper. Any literal colour
    // beside an amount's markup, or a lost helper call, fails here even when the rendered colour is unchanged.
    const amountMarkup = /(text-lg font-bold|text-2xl font-bold \$\{|usedAmount\)|current_amount\)|Transfer Fee|transferFeeLabel|upcoming-occurrence-amount|account-transaction-amount)/
    const sourceOf = Object.fromEntries(sites.map((site) => [site, readFrontend(site)] as const))
    for (const site of sites) {
      const literal = lines(sourceOf[site], /className=/).filter((l) => amountMarkup.test(l) && /\btext-(ok|ink|danger|body|muted)\b/.test(l) && !/row\.amount|format\(allocation\.current_amount\)|current_amount\)\}<\/p>/.test(l))
      expect(literal, `${site}: no amount element names a literal text colour`).toEqual([])
    }
    const expectCalls = (site: string, pattern: RegExp, n: number, what: string): void => {
      expect(count(sourceOf[site], pattern), `${site}: ${what}`).toBe(n)
    }
    expectCalls('src/routes/allocations.tsx', /text-lg font-bold \$\{amountClass\(/g, 2, 'both recurring entry amounts take amountClass(')
    expectCalls('src/routes/allocations.tsx', /font-semibold \$\{amountClass\('out'\)\}`\}>\{format\((usedAmount|actionAllocation\.current_amount)\)/g, 2, 'the budget card and modal Spent amounts are amount-out')
    expectCalls('src/routes/allocations.tsx', /formatAmount\(/g, 2, 'both recurring entry amounts are formatted with formatAmount(')
    expectCalls('src/routes/transactions.tsx', /const amountClassName = amountClass\(amountKind\)/g, 1, 'the row class comes from amountClass(amountKind)')
    expectCalls('src/routes/transactions.tsx', /\$\{actionMeta\?\.amountClass \?\? ''\} font-medium/g, 1, 'the action modal Amount row uses the row class')
    expectCalls('src/routes/transactions.tsx', /text-right \$\{amountClass\('out'\)\}`\}>\{actionTransferMeta\.transferFeeLabel/g, 1, 'the transfer fee is amount-out')
    expectCalls('src/routes/accounts.tsx', /text-lg font-bold \$\{balanceClass\((account|actionAccount)\.balance\)\}/g, 2, 'the Accounts list and modal balances take balanceClass(')
    expectCalls('src/routes/accounts_.$accountId.tsx', /text-2xl font-bold \$\{balanceClass\(account\.balance\)\}/g, 1, 'the detail balance takes balanceClass(')
    expectCalls('src/components/AccountTransactionList.tsx', /const amountClassName = amountClass\(leg\.effectKnown && leg\.direction === 'in' \? 'in' : 'out'\)/g, 1, 'the row amount takes amountClass(')
    expectCalls('src/components/transactions/UpcomingOccurrenceRow.tsx', /const amountClassName = amountClass\(/g, 1, 'the occurrence amount takes amountClass(')
    expectCalls('src/routes/index.tsx', /color: amountClass\('out'\)/g, 1, 'Total expenses takes amountClass(')
    const helper = readFrontend('src/utils/amount.ts')
    expect(helper, 'the helper maps out, in and negative to the three classes').toMatch(/'amount-out'[\s\S]*'amount-in'[\s\S]*'amount-negative'/)
    await shot(page, 'classes-source')
  })

  /** The semantic class an amount carries (`amount-*`), or '' when it names none. */
  const semanticOf = (els: Locator): Promise<string[]> =>
    els.evaluateAll((all) => all.map((e) => [...e.classList].filter((c) => c.startsWith('amount-')).join(' ')))
  const same = (n: number, cls: string): string[] => new Array<string>(n).fill(cls)

  test('amount colour is a class, not a selector shim: recurring entries', async ({ page }) => {
    const main = await openRecurring(page)
    const full = main.locator('article:not([data-row-kind="limited-entry"])')
    for (const [kind, cls] of [['Income', 'amount-in'], ['Expense', 'amount-out']] as const) {
      const amounts = amountOf(full.filter({ hasText: new RegExp(`Recurring ${kind.toLowerCase()}`) }))
      const count = await amounts.count()
      expect(count, `the full renderer lists recurring ${kind} entries`).toBeGreaterThan(0)
      expect(await semanticOf(amounts), `every full recurring ${kind} amount`).toEqual(same(count, cls))
    }
    await shot(page, 'classes-recurring')
  })

  test('amount colour is a class, not a selector shim: limited recurring entries', async ({ page }) => {
    await mockHousehold(page)
    const withLimited = { ...household, entries: [...household.entries, ...limitedRecurring] }
    await addRoutes(page, [queryRoute<PaginatedResponse<BudgetEntry>>('GET', '/budget-entries/', (q) => budgetEntriesFor(withLimited, q))])
    await page.goto('/allocations?tab=recurring')
    const limited = page.locator('[data-row-kind="limited-entry"]')
    await expect(limited.first()).toBeVisible()
    expect(await limited.count(), 'the limited renderer lists both entries').toBe(2)
    for (const [kind, cls] of [['Income', 'amount-in'], ['Expense', 'amount-out']] as const) {
      const amounts = amountOf(limited.filter({ hasText: new RegExp(`Recurring ${kind.toLowerCase()}`) }))
      expect(await semanticOf(amounts), `the limited recurring ${kind} amount`).toEqual([cls])
    }
    expect(await textsOf(amountOf(limited.filter({ hasText: /Recurring income/ }))), 'the limited income amount starts with +').toEqual(['+₱3,500.00'])
    await shot(page, 'classes-limited-recurring')
  })

  test('amount colour is a class, not a selector shim: budget card spent', async ({ page }) => {
    await open(page, '/allocations?tab=budgets')
    const spent = page.getByText('Spent this period').locator('xpath=following-sibling::span')
    await expect(spent.first()).toBeVisible()
    const count = await spent.count()
    expect(count, 'the Budgets tab lists budget cards').toBeGreaterThan(2)
    expect(await semanticOf(spent), 'every budget card Spent amount').toEqual(same(count, 'amount-out'))
    await shot(page, 'classes-budget-card')
  })

  test('amount colour is a class, not a selector shim: budget modal spent', async ({ page }) => {
    await open(page, '/allocations?tab=budgets')
    await page.locator('article').filter({ hasText: 'Groceries' }).first().click()
    const spent = page.locator('.modal-backdrop').getByText(/^Spent/).locator('span')
    await expect(spent).toBeVisible()
    expect(await semanticOf(spent), 'the budget modal Spent amount').toEqual(['amount-out'])
    await viewportShot(page, 'classes-budget-modal')
  })

  for (const [kind, description, cls] of [
    ['expense', 'Puregold weekly groceries', 'amount-out'],
    ['income', 'Logo design, Kapé Co.', 'amount-in'],
  ] as const) {
    test(`amount colour is a class, not a selector shim: transaction modal ${kind}`, async ({ page }) => {
      const list = await openTransactions(page)
      await list.locator('article[data-transaction-id]').filter({ hasText: description }).click()
      const amount = page.locator('.modal-backdrop').getByText('Amount', { exact: true }).locator('xpath=following-sibling::dd')
      await expect(amount).toBeVisible()
      expect(await semanticOf(amount), `the modal Amount row for an ${kind}`).toEqual([cls])
      await viewportShot(page, `classes-transaction-modal-${kind}`)
    })
  }

  test('amount colour is a class, not a selector shim: transfer fee', async ({ page }) => {
    const list = await openTransactions(page)
    await list.locator('article[data-transaction-id]').filter({ hasText: 'Move to emergency fund' }).click()
    const fee = page.locator('.modal-backdrop').getByText('Transfer Fee').locator('xpath=following-sibling::dd')
    await expect(fee).toBeVisible()
    expect(await semanticOf(fee), 'the transfer fee amount').toEqual(['amount-out'])
    await viewportShot(page, 'classes-transfer-fee')
  })

  test('amount colour is a class, not a selector shim: Accounts list balances', async ({ page }) => {
    await open(page, '/accounts')
    const balances = page.locator('main p.text-lg.font-bold')
    await expect(balances.first()).toBeVisible()
    const classes = await semanticOf(balances)
    expect(classes.length, 'Accounts lists a balance per account').toBe(household.accounts.length)
    expect(classes.filter((c) => c === 'amount-negative').length, 'one negative balance (the card)').toBe(1)
    expect(classes.filter((c) => c === 'amount-out').length, 'every other balance is amount-out').toBe(household.accounts.length - 1)
    await shot(page, 'classes-accounts-balances')
  })

  for (const [name, cls] of [['GCash', 'amount-out'], ['HSBC Red Mastercard', 'amount-negative']] as const) {
    test(`amount colour is a class, not a selector shim: Accounts action modal, ${name}`, async ({ page }) => {
      await open(page, '/accounts')
      await addRoutes(page, [
        apiRoute<CardStatementsResponse>('GET', `/accounts/${CARD_ID}/statements`, { view: 'full', account_id: CARD_ID, name, currency: 'PHP', statements: [] }),
      ])
      await page.getByText(name, { exact: true }).first().click()
      const balance = page.locator('.modal-backdrop p.text-lg.font-bold')
      await expect(balance).toBeVisible()
      expect(await semanticOf(balance), `the modal balance for ${name}`).toEqual([cls])
      await viewportShot(page, `classes-accounts-modal-${name.split(' ')[0].toLowerCase()}`)
    })
  }

  for (const [id, label, cls] of [[11, 'a positive balance', 'amount-out'], [15, 'a negative balance', 'amount-negative']] as const) {
    test(`amount colour is a class, not a selector shim: account detail, ${label}`, async ({ page }) => {
      await mockHousehold(page)
      await addRoutes(page, accountDetailRoutes(household, id))
      await page.goto(`/accounts/${id}`)
      const detail = page.getByTestId('account-detail-balance')
      await expect(detail).toBeVisible()
      expect(await semanticOf(detail), `the detail balance (${label})`).toEqual([cls])
      await shot(page, `classes-account-detail-${id}`)
    })
  }

  test('amount colour is a class, not a selector shim: card and account transactions', async ({ page }) => {
    await mockHousehold(page)
    await addRoutes(page, [...accountDetailRoutes(household, CARD_ID), ...accountDetailRoutes(household, 11)])
    await page.goto(`/accounts/${CARD_ID}`)
    const debits = page.locator('[data-testid="account-transaction"][data-direction="out"]').getByTestId('account-transaction-amount')
    await expect(debits.first()).toBeVisible()
    expect(await semanticOf(debits), 'every card debit').toEqual(same(await debits.count(), 'amount-out'))
    await shot(page, 'classes-card-debits')
    await page.goto('/accounts/11')
    const credits = page.locator('[data-testid="account-transaction"][data-direction="in"]').getByTestId('account-transaction-amount')
    await expect(credits.first()).toBeVisible()
    expect(await semanticOf(credits), 'every payroll credit').toEqual(same(await credits.count(), 'amount-in'))
    expect((await textsOf(credits)).filter((t) => !t.startsWith('+')), 'every credit starts with +').toEqual([])
    await shot(page, 'classes-account-credits')
  })

  test('amount colour is a class, not a selector shim: upcoming occurrences', async ({ page }) => {
    await open(page, '/transactions')
    await page.getByTestId('due-tab-upcoming').click()
    const amounts = page.getByTestId('upcoming-occurrence-amount')
    await expect(amounts.first()).toBeVisible()
    const count = await amounts.count()
    expect(count, 'Upcoming lists occurrences').toBeGreaterThan(2)
    const texts = await textsOf(amounts)
    const classes = await semanticOf(amounts)
    expect(classes.filter((c, i) => c !== (texts[i].startsWith('+') ? 'amount-in' : 'amount-out')), 'each occurrence amount takes the class its sign says').toEqual([])
    expect(new Set(classes), 'Upcoming shows both income and expense occurrences').toEqual(new Set(['amount-in', 'amount-out']))
    await shot(page, 'classes-upcoming')
  })

  test('amount colour is a class, not a selector shim: rendered', async ({ page }) => {
    const list = await openTransactions(page)
    const classes = await amountOf(list.locator('article')).evaluateAll((all) => all.map((e) => [...e.classList].filter((c) => c.startsWith('amount-')).join(' ')))
    expect(classes.filter((c) => c === ''), 'every Transactions amount carries a semantic class').toEqual([])
    expect(new Set(classes), 'Transactions amounts use amount-out and amount-in').toEqual(new Set(['amount-out', 'amount-in']))
    await shot(page, 'classes-transactions')
  })

  for (const [theme, want] of THEMES) {
    test(`dashboard and card expenses are ink: dashboard, ${theme}`, async ({ page }) => {
      await open(page, '/')
      if (theme === 'dark') await toggleDark(page)
      const total = page.getByTestId('period-expenses')
      await expect(total).toBeVisible()
      await expect(total).toHaveClass(/amount-out/)
      expect(await colourOf(total), `Total expenses in ${theme}`).toBe(want.ink)
      await shot(page, `expenses-dashboard-${theme}`)
    })

    test(`dashboard and card expenses are ink: card, ${theme}`, async ({ page }) => {
      await mockHousehold(page)
      await addRoutes(page, accountDetailRoutes(household, CARD_ID))
      await page.goto(`/accounts/${CARD_ID}`)
      if (theme === 'dark') await toggleDark(page)
      const debits = page.locator('[data-testid="account-transaction"][data-direction="out"]').getByTestId('account-transaction-amount')
      await expect(debits.first()).toBeVisible()
      const count = await debits.count()
      expect(count, 'the card lists debits').toBeGreaterThan(3)
      expect(await coloursOf(debits), `every card debit in ${theme}`).toEqual(new Array<string>(count).fill(want.ink))
      expect(await debits.evaluateAll((all) => all.filter((e) => !e.classList.contains('amount-out')).length), 'every card debit uses amount-out').toBe(0)
      await shot(page, `expenses-card-${theme}`)
    })

    test(`negative balances are signed danger amounts: accounts, ${theme}`, async ({ page }) => {
      await open(page, '/accounts')
      if (theme === 'dark') await toggleDark(page)
      const owed = page.locator('.amount-negative').filter({ hasText: CARD_OWED })
      await expect(owed).toBeVisible()
      expect((await owed.textContent())?.trim(), 'the card balance on Accounts has a leading minus').toMatch(/^−/)
      expect(await colourOf(owed), `the card balance on Accounts in ${theme}`).toBe(want.danger)
      await shot(page, `negative-accounts-${theme}`)
    })

    test(`negative balances are signed danger amounts: card, ${theme}`, async ({ page }) => {
      await mockHousehold(page)
      await addRoutes(page, accountDetailRoutes(household, CARD_ID))
      await page.goto(`/accounts/${CARD_ID}`)
      if (theme === 'dark') await toggleDark(page)
      const detail = page.getByTestId('account-detail-balance')
      await expect(detail).toBeVisible()
      await expect(detail).toHaveClass(/amount-negative/)
      expect((await detail.textContent())?.trim(), 'the card panel balance has a leading minus').toMatch(/^−/)
      expect(await colourOf(detail), `the card panel balance in ${theme}`).toBe(want.danger)
      await shot(page, `negative-card-${theme}`)
    })

    test(`non-negative balances are ink: accounts, ${theme}`, async ({ page }) => {
      await open(page, '/accounts')
      if (theme === 'dark') await toggleDark(page)
      const balances = page.locator('p.text-lg.font-bold.amount-out')
      await expect(balances.first()).toBeVisible()
      const count = await balances.count()
      expect(count, 'Accounts lists non-negative balances').toBeGreaterThan(3)
      expect(await coloursOf(balances), `every non-negative balance in ${theme}`).toEqual(new Array<string>(count).fill(want.ink))
      await shot(page, `balances-ink-${theme}`)
    })
  }
})
