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

/** Every visible element inside `main` that is painted in the red pencil. */
const redCount = (page: Page): Promise<number> =>
  page.evaluate(
    (red) =>
      [...document.querySelectorAll('main *')].filter((e) => {
        const box = e.getBoundingClientRect()
        return getComputedStyle(e).color === red && box.width > 0 && box.height > 0
      }).length,
    LIGHT.danger,
  )

test.describe('amount colours (STU-680)', () => {
  test('expenses are ink', async ({ page }) => {
    const list = await openTransactions(page)
    const spent = amountOf(expenseRows(list))
    const spentCount = await spent.count()
    expect(spentCount, 'Transactions lists expense rows').toBeGreaterThan(5)
    expect(await coloursOf(spent), 'every Transactions expense amount is ink').toEqual(new Array<string>(spentCount).fill(LIGHT.ink))
    await shot(page, 'expenses-transactions')

    const recurring = await openRecurring(page)
    const entries = amountOf(expenseRows(recurring))
    const entryCount = await entries.count()
    expect(entryCount, 'Allocations lists recurring expense entries').toBeGreaterThan(3)
    expect(await coloursOf(entries), 'every recurring expense amount is ink').toEqual(new Array<string>(entryCount).fill(LIGHT.ink))
    await shot(page, 'expenses-recurring')
  })

  test('income is green with a sign', async ({ page }) => {
    const list = await openTransactions(page)
    const earned = amountOf(incomeRows(list))
    const earnedCount = await earned.count()
    expect(earnedCount, 'Transactions lists income rows').toBeGreaterThan(1)
    expect(await coloursOf(earned), 'every Transactions income amount is green').toEqual(new Array<string>(earnedCount).fill(LIGHT.ok))
    expect((await textsOf(earned)).filter((t) => !t.startsWith('+')), 'every Transactions income amount starts with +').toEqual([])
    await shot(page, 'income-transactions')

    const recurring = await openRecurring(page)
    const entries = amountOf(incomeRows(recurring))
    const entryCount = await entries.count()
    expect(entryCount, 'Allocations lists recurring income entries').toBeGreaterThan(0)
    expect(await coloursOf(entries), 'every recurring income amount is green').toEqual(new Array<string>(entryCount).fill(LIGHT.ok))
    expect((await textsOf(entries)).filter((t) => !t.startsWith('+')), 'every recurring income amount starts with +').toEqual([])
    await shot(page, 'income-recurring')
  })

  for (const [name, url] of [
    ['dashboard', '/'],
    ['Transactions', '/transactions'],
    ['Allocations', '/allocations'],
  ] as const) {
    test(`red means overdue, negative or failed only: nothing red on a calm ${name}`, async ({ page }) => {
      await open(page, url, calmHousehold)
      await expect(page.locator('main')).toBeVisible()
      await page.waitForLoadState('networkidle')
      expect(await redCount(page), `elements painted in the red pencil on a calm ${name}`).toBe(0)
      await shot(page, `calm-${name.toLowerCase()}`)
    })
  }

  test('red means overdue, negative or failed only: the overdue payable is red', async ({ page }) => {
    await open(page, '/')
    const overdue = page.locator('[data-testid="payable-status"][aria-label="Overdue"]').first()
    await expect(overdue).toBeVisible()
    expect(await colourOf(overdue), 'the dashboard overdue payable badge').toBe(LIGHT.danger)
    await shot(page, 'overdue-dashboard')

    await page.goto('/transactions')
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
  amountRight: number
  amountTop: number
}

async function rowBoxes(page: Page, list: Locator): Promise<RowBox[]> {
  await page.evaluate(() => document.fonts.ready)
  return list.evaluate((main) => {
    const rows = [...main.querySelectorAll<HTMLElement>('article[data-transaction-id]')]
    const first = rows[0].getBoundingClientRect()
    const left = main.getBoundingClientRect().left
    return rows.map((row) => {
      const r = row.getBoundingClientRect()
      const a = row.querySelector<HTMLElement>('p.text-lg.font-bold')?.getBoundingClientRect()
      return {
        id: Number(row.dataset.transactionId),
        top: Math.round(r.top - first.top),
        height: Math.round(r.height),
        amountRight: Math.round((a?.right ?? 0) - left),
        amountTop: Math.round((a?.top ?? 0) - r.top),
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
  const near = (key: keyof RowBox): number[] => boxes.map((b, i) => b[key] - base[i][key])
  expect(Math.max(...near('top').map(Math.abs)), 'row spacing: largest shift of a row from its base position').toBeLessThanOrEqual(1)
  expect(Math.max(...near('height').map(Math.abs)), 'row height: largest change from base').toBeLessThanOrEqual(1)
  expect(Math.max(...near('amountRight').map(Math.abs)), 'amount column alignment: largest shift of the right edge').toBeLessThanOrEqual(1)
  expect(Math.max(...near('amountTop').map(Math.abs)), 'amount position inside its row: largest shift').toBeLessThanOrEqual(1)
})

test('amount colours hold in dark', async ({ page }) => {
  const list = await openTransactions(page)
  await toggleDark(page)
  expect(await colourOf(amountOf(expenseRows(list)).first()), 'an expense amount in dark').toBe(DARK.ink)
  expect(await colourOf(amountOf(incomeRows(list)).first()), 'an income amount in dark').toBe(DARK.ok)
  await shot(page, 'dark-transactions')
  await page.goto('/accounts')
  const owed = page.locator('.amount-negative').filter({ hasText: CARD_OWED })
  await expect(owed).toBeVisible()
  expect(await colourOf(owed), 'a negative balance in dark').toBe(DARK.danger)
  await shot(page, 'dark-accounts')
})

test.describe('amount classes', () => {
  test('amount colour is a class, not a selector shim', async ({ page }) => {
    const css = readFrontend('src/assets/index.css')
    expect(css.includes('article .text-lg.font-bold.text-danger'), 'the stylesheet has no render-shim selector').toBe(false)
    for (const cls of ['amount-out', 'amount-in', 'amount-negative']) {
      expect(css, `the stylesheet defines .${cls}`).toMatch(new RegExp(`\\.${cls}\\s*\\{`))
    }
    const transactions = readFrontend('src/routes/transactions.tsx')
    expect(/amountClass\s*=[^;]{0,400}text-danger/.test(transactions), 'transactions.tsx has no amountClass choosing text-danger').toBe(false)
    expect(/(debit|expense)[^\n]{0,40}text-danger/.test(transactions), 'transactions.tsx colours no debit text-danger').toBe(false)
    // Every call site in the ticket's Scope renders through the shared helper.
    const sites = [
      'src/routes/transactions.tsx',
      'src/routes/allocations.tsx',
      'src/routes/index.tsx',
      'src/routes/accounts.tsx',
      'src/routes/accounts_.$accountId.tsx',
      'src/components/AccountTransactionList.tsx',
    ]
    for (const site of sites) {
      const source = readFrontend(site)
      expect(source, `${site} imports the shared amount helper`).toMatch(/from '(\.\.\/)+utils\/amount'/)
      expect(source, `${site} picks its amount colour with amountClass(`).toMatch(/amountClass\(/)
    }
    const helper = readFrontend('src/utils/amount.ts')
    expect(helper, 'the helper maps out, in and negative to the three classes').toMatch(/'amount-out'[\s\S]*'amount-in'[\s\S]*'amount-negative'/)

    const list = await openTransactions(page)
    const classes = await amountOf(list.locator('article')).evaluateAll((all) => all.map((e) => [...e.classList].filter((c) => c.startsWith('amount-')).join(' ')))
    expect(classes.filter((c) => c === ''), 'every Transactions amount carries a semantic class').toEqual([])
    expect(new Set(classes), 'Transactions amounts use amount-out and amount-in').toEqual(new Set(['amount-out', 'amount-in']))
    await shot(page, 'classes-transactions')
  })

  for (const [theme, want] of THEMES) {
    test(`dashboard and card expenses are ink: ${theme}`, async ({ page }) => {
      await mockHousehold(page)
      await addRoutes(page, accountDetailRoutes(household, CARD_ID))
      await page.goto('/')
      if (theme === 'dark') await toggleDark(page)
      const total = page.getByTestId('period-expenses')
      await expect(total).toBeVisible()
      await expect(total).toHaveClass(/amount-out/)
      expect(await colourOf(total), `Total expenses in ${theme}`).toBe(want.ink)
      await shot(page, `expenses-dashboard-${theme}`)

      await page.goto(`/accounts/${CARD_ID}`)
      const debits = page.locator('[data-testid="account-transaction"][data-direction="out"]').getByTestId('account-transaction-amount')
      await expect(debits.first()).toBeVisible()
      const count = await debits.count()
      expect(count, 'the card lists debits').toBeGreaterThan(3)
      expect(await coloursOf(debits), `every card debit in ${theme}`).toEqual(new Array<string>(count).fill(want.ink))
      expect((await debits.evaluateAll((all) => all.filter((e) => !e.classList.contains('amount-out')).length)), 'every card debit uses amount-out').toBe(0)
      await shot(page, `expenses-card-${theme}`)
    })
  }

  for (const [theme, want] of THEMES) {
    test(`negative balances are signed danger amounts: ${theme}`, async ({ page }) => {
      await mockHousehold(page)
      await addRoutes(page, accountDetailRoutes(household, CARD_ID))
      await page.goto('/accounts')
      if (theme === 'dark') await toggleDark(page)
      const owed = page.locator('.amount-negative').filter({ hasText: CARD_OWED })
      await expect(owed).toBeVisible()
      expect((await owed.textContent())?.trim(), 'the card balance on Accounts has a leading minus').toMatch(/^−/)
      expect(await colourOf(owed), `the card balance on Accounts in ${theme}`).toBe(want.danger)
      await shot(page, `negative-accounts-${theme}`)

      await page.goto(`/accounts/${CARD_ID}`)
      const detail = page.getByTestId('account-detail-balance')
      await expect(detail).toBeVisible()
      await expect(detail).toHaveClass(/amount-negative/)
      expect((await detail.textContent())?.trim(), 'the card panel balance has a leading minus').toMatch(/^−/)
      expect(await colourOf(detail), `the card panel balance in ${theme}`).toBe(want.danger)
      await shot(page, `negative-card-${theme}`)
    })
  }
})
