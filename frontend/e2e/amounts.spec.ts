// STU-680: money out is ink, money in is green with a sign, and red only means overdue, negative or failed
// (docs/design-system.md, "Amounts"). The API is faked in the browser with the shared household fixture; there is
// no backend.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test } from '@playwright/test'
import type { Locator, Page } from '@playwright/test'
import { accountDetailRoutes, calmHousehold, household, mockHousehold } from './support/fixtures/household'
import type { HouseholdData } from './support/fixtures/household'
import { addRoutes, errorRoute } from './support/mockApi'
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
const expenseRows = (scope: Locator): Locator => scope.locator('article').filter({ hasText: /Expense/ })
const incomeRows = (scope: Locator): Locator => scope.locator('article').filter({ hasText: /Income/ })

/** A viewport screenshot (for overlays), saved under `shot()`'s naming. */
async function viewportShot(page: Page, name: string): Promise<void> {
  const info = test.info()
  const spec = path.basename(info.file).replace(/\.spec\.ts$/, '')
  await page.screenshot({ path: path.join(info.project.outputDir, 'screens', `${spec}-${name}-${info.project.name}.png`), animations: 'disabled' })
}

/**
 * Every visible element inside `main` or a modal that is painted in the red pencil. A Delete button is the design
 * system's red-pencil outline variant (a destructive action, not an amount), so it is not counted.
 */
const redCount = (page: Page): Promise<number> =>
  page.evaluate(
    (red) =>
      [...document.querySelectorAll('main *, .modal-backdrop *')].filter((e) => {
        const box = e.getBoundingClientRect()
        const inDelete = (e.closest('button')?.textContent ?? '').trim().startsWith('Delete')
        return getComputedStyle(e).color === red && box.width > 0 && box.height > 0 && !inDelete
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
    for (const site of sites) {
      const source = readFrontend(site)
      expect(source, `${site} imports the shared amount helper`).toMatch(/from '(\.\.\/)+utils\/amount'/)
      expect(source, `${site} picks its amount colour through the helper`).toMatch(/(amountClass|balanceClass)\(/)
      expect(lines(source, /text-danger/).filter((l) => /usedAmount|current_amount|transferFeeLabel|amountLabel|amountClass|expenses|entry_type|transaction_type|direction|formatAmount|formatBalance/.test(l)), `${site}: no amount is coloured text-danger directly`).toEqual([])
      expect(lines(source, /text-ok/).filter((l) => /amountLabel|entry_type|transaction_type|direction|formatAmount|formatBalance/.test(l) || (site !== 'src/routes/index.tsx' && /balance/i.test(l))), `${site}: no amount or balance is coloured text-ok directly`).toEqual([])
    }
    for (const site of ['src/routes/accounts.tsx', 'src/routes/accounts_.$accountId.tsx']) {
      const balances = lines(readFrontend(site), /\bbalance\b[^\n]*(text-ok|text-danger)|(text-ok|text-danger)[^\n]*\bbalance\b/)
      expect(balances, `${site}: balances are classed through balanceClass`).toEqual([])
    }
    const helper = readFrontend('src/utils/amount.ts')
    expect(helper, 'the helper maps out, in and negative to the three classes').toMatch(/'amount-out'[\s\S]*'amount-in'[\s\S]*'amount-negative'/)
    await shot(page, 'classes-source')
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
