// STU-708: a negative amount is written one way everywhere, `−₱1,234.56` (a minus sign, U+2212, before the currency
// symbol), and a zero is never signed. The API is faked in the browser with the shared household fixture; there is no
// backend.
import { expect, test } from '@playwright/test'
import type { Locator, Page } from '@playwright/test'
import path from 'node:path'
import {
  STATEMENT_REFUNDS,
  ZERO_EVENT_NAME,
  ZERO_FIGURE_CASES,
  ZERO_ROWS,
  accountDetailRoutes,
  calmHousehold,
  cardStatements,
  household,
  householdViewRoutes,
  mockHousehold,
  withBalance,
  withDollars,
  withZeroRows,
  withZeroTimelineEvent,
} from './support/fixtures/household'
import type { HouseholdData } from './support/fixtures/household'
import { addRoutes, apiRoute } from './support/mockApi'
import type { ApiRoute } from './support/mockApi'
import type { CardStatements } from '@tally-trace/shared'
import { shot } from './support/shot'
import { expandDue } from './support/transactions'

/** The one negative format: a minus sign, the peso sign, grouped digits and two decimals. */
const NEGATIVE_PESOS = /^−₱[0-9,]+\.[0-9]{2}$/
/**
 * A hyphen written next to a currency symbol, either side, or after a currency code ("PHP -80.00"), with a little
 * context so a failure shows where it is.
 */
const HYPHEN_SIGNED = /.{0,24}(?:-₱|₱-|-\$|\$-|\b[A-Z]{3} -[0-9]).{0,8}/g
/** How long a page may take to first render: the dev server compiles each route on its first visit. */
const READY_MS = 15_000

/** The fixture's peso totals for the month to date, and its balances today. */
const MONTH = household.summary.by_currency[0]
const BALANCES = household.snapshot.balances.by_currency[0]
const CARD = household.accounts.find((a) => a.account_type === 'credit')

/** An amount the page printed, read back as a number whichever minus it was written with (U+2212 or a hyphen). */
const valueOf = (text: string): number => Number(text.replace(/[−-]/, '-').replace(/[₱,]/g, ''))

async function toggleDark(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Toggle theme' }).click()
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
}

/** The dashboard, once its actual totals and quick balances have landed. */
async function openDashboard(page: Page, data: HouseholdData = household): Promise<void> {
  await mockHousehold(page, data)
  await page.goto('/')
  await expect(page.getByTestId('period-net-flow')).toBeVisible({ timeout: READY_MS })
  await expect(page.getByTestId('quick-balance-tile').first()).toBeVisible({ timeout: READY_MS })
}

/** The text of one quick-balance line without its caption ("Owed"): the amount alone. */
const figureOf = (line: Locator): Promise<string> =>
  line.evaluate((e) => [...e.childNodes].filter((n) => n.nodeType === Node.TEXT_NODE).map((n) => n.textContent ?? '').join('').trim())

/** A viewport screenshot (for a dialog, which is fixed), saved under `shot()`'s naming. */
async function viewportShot(page: Page, name: string): Promise<void> {
  const info = test.info()
  const spec = path.basename(info.file).replace(/\.spec\.ts$/, '')
  await page.screenshot({ path: path.join(info.project.outputDir, 'screens', `${spec}-${name}-${info.project.name}.png`), animations: 'disabled' })
}

/** The card's ID in the fixture, whose statements carry the refunds. */
const CARD_ID = cardStatements.account_id

/**
 * The surfaces AC3 reads, each with what shows once it has loaded. `extra` adds routes a page needs beyond the
 * household's, and `then` opens the tab the amounts are on.
 */
const SURFACES: readonly {
  name: string
  url: string
  ready: (page: Page) => Locator
  dollars?: boolean
  extra?: (data: HouseholdData) => ApiRoute[]
  then?: (page: Page) => Promise<void>
}[] = [
  { name: 'dashboard', url: '/', ready: (page) => page.getByTestId('period-net-flow') },
  { name: 'dashboard in dollars', url: '/', ready: (page) => page.getByTestId('period-net-flow'), dollars: true },
  { name: 'transactions', url: '/transactions', ready: (page) => page.locator('article[data-transaction-id]').first() },
  { name: 'allocations recurring', url: '/allocations', ready: (page) => page.locator('main article').first() },
  { name: 'allocations budgets', url: '/allocations?tab=budgets', ready: (page) => page.locator('main').getByText('Transport', { exact: true }).first() },
  { name: 'accounts', url: '/accounts', ready: (page) => page.locator('main').getByText('HSBC Red Mastercard').first() },
  {
    name: 'transactions upcoming',
    url: '/transactions',
    ready: (page) => page.getByTestId('due-section-toggle'),
    then: async (page) => {
      // STU-687: the Due card opens collapsed, with no tabs until it is expanded.
      await expandDue(page)
      await page.getByTestId('due-tab-upcoming').click()
      await expect(page.getByTestId('upcoming-occurrence-amount').first()).toBeVisible()
    },
  },
  {
    name: 'household view transactions',
    url: '/accounts/household',
    ready: (page) => page.getByTestId('household-tab-transactions'),
    extra: (data) => householdViewRoutes(data),
    then: async (page) => {
      await page.getByTestId('household-tab-transactions').click()
      await expect(page.getByTestId('household-transaction-amount').first()).toBeVisible()
    },
  },
  { name: 'forecast', url: '/forecast', ready: (page) => page.getByTestId('timeline-amount').first() },
]
const VARIANTS = [
  ['busy', household],
  ['calm', calmHousehold],
] as const
const THEMES = ['light', 'dark'] as const

test('negative amounts use one format: dashboard net flow', async ({ page }) => {
  expect(MONTH.net_flow, 'the fixture month spends more than it earns').toBeLessThan(0)
  await openDashboard(page)
  const net = page.getByTestId('period-net-flow')
  expect((await net.innerText()).trim(), 'Net flow is a minus sign, then the peso sign').toMatch(NEGATIVE_PESOS)
  await shot(page, 'net-flow')
})

for (const c of ZERO_FIGURE_CASES) {
  test(`zero is never signed: quick balance, formatter input ${c.input} (${c.name})`, async ({ page }) => {
    await openDashboard(page, withBalance(household, c.accountId, c.balance))
    const line = page.locator(`[data-testid="quick-balance-tile"][data-account-id="${c.accountId}"]`).getByTestId(`quick-balance-${c.line}`)
    await expect(line).toBeVisible()
    const figure = await figureOf(line)
    expect(figure, `the ${c.line} figure for input ${c.input} reads as plain zero`).toBe('₱0.00')
    expect(await line.innerText(), `the ${c.line} line for input ${c.input} has no sign`).not.toMatch(/[-−]/)
    await shot(page, `zero-${c.input}`)
  })
}

test('negative amounts use one format: card statement refunds', async ({ page }) => {
  await mockHousehold(page)
  await addRoutes(page, [apiRoute<CardStatements>('GET', `/accounts/${CARD_ID}/statements`, cardStatements)])
  await page.goto('/accounts')
  await page.locator('main').getByText(cardStatements.name, { exact: true }).first().click({ timeout: READY_MS })
  const dialog = page.locator('.modal-backdrop')
  const statement = dialog.getByTestId('statement').first()
  await statement.locator('summary').click()
  const amountOn = (description: string): Locator => statement.locator('li').filter({ hasText: description }).locator('span[title], span.text-ink').last()
  const returned = amountOn('Uniqlo Glorietta return')
  await expect(returned).toBeVisible()
  expect(STATEMENT_REFUNDS.pesos, 'the returned purchase is a credit').toBeLessThan(0)
  expect((await returned.innerText()).trim(), 'the returned purchase is a minus sign, then the peso sign').toBe('−₱1,250.00')
  expect((await amountOn('Klook refund').innerText()).trim(), 'the dollar refund estimate signs both figures with a minus sign').toBe('≈ −PHP 2,320.00 (−USD 40.00)')
  expect((await dialog.innerText()).match(HYPHEN_SIGNED) ?? [], 'the card dialog writes no amount with a hyphen').toEqual([])
  await returned.scrollIntoViewIfNeeded()
  await viewportShot(page, 'statement-refunds')
})

/** Where a zero row is listed, and how to find its amount there. */
const ZERO_ROW_SURFACES: readonly { name: string; open: (page: Page, data: HouseholdData, accountId: number) => Promise<void>; amount: (page: Page, description: string) => Locator }[] = [
  {
    name: 'transactions',
    open: async (page, data) => {
      await mockHousehold(page, data)
      await page.goto('/transactions')
    },
    amount: (page, description) => page.locator('article[data-transaction-id]').filter({ hasText: description }).locator('p.text-lg.font-bold'),
  },
  {
    name: 'account page',
    open: async (page, data, accountId) => {
      await mockHousehold(page, data)
      await addRoutes(page, accountDetailRoutes(data, accountId))
      await page.goto(`/accounts/${accountId}`)
    },
    amount: (page, description) => page.getByTestId('account-transaction').filter({ hasText: description }).getByTestId('account-transaction-amount'),
  },
  {
    name: 'household view',
    open: async (page, data) => {
      await mockHousehold(page, data)
      await addRoutes(page, householdViewRoutes(data))
      await page.goto('/accounts/household')
      await page.getByTestId('household-tab-transactions').click({ timeout: READY_MS })
    },
    amount: (page, description) => page.getByTestId('household-transaction').filter({ hasText: description }).getByTestId('household-transaction-amount'),
  },
]

for (const surface of ZERO_ROW_SURFACES) {
  for (const row of ZERO_ROWS) {
    test(`zero is never signed: ${surface.name} row, zero ${row.type}`, async ({ page }) => {
      await surface.open(page, withZeroRows(household), row.accountId)
      const amount = surface.amount(page, row.description)
      await expect(amount).toBeVisible({ timeout: READY_MS })
      expect((await amount.innerText()).trim(), `the zero ${row.type} on the ${surface.name} reads as plain zero`).toBe('₱0.00')
      await amount.scrollIntoViewIfNeeded()
      await shot(page, `zero-row-${surface.name.replace(/ /g, '-')}-${row.type}`)
    })
  }
}

test('zero is never signed: forecast zero event', async ({ page }) => {
  await mockHousehold(page, withZeroTimelineEvent(household))
  await page.goto('/forecast')
  const amount = page.locator('tr').filter({ hasText: ZERO_EVENT_NAME }).getByTestId('timeline-amount')
  await expect(amount).toBeVisible({ timeout: READY_MS })
  expect((await amount.innerText()).trim(), 'the zero forecast event reads as plain zero').toBe('₱0.00')
  await shot(page, 'zero-forecast-event')
})

for (const surface of SURFACES) {
  for (const [variant, data] of VARIANTS) {
    if (surface.dollars && variant !== 'busy') continue
    for (const theme of THEMES) {
      test(`no hyphen-signed amounts remain: ${surface.name}, ${variant}, ${theme}`, async ({ page }) => {
        await mockHousehold(page, surface.dollars ? withDollars(data) : data)
        if (surface.extra) await addRoutes(page, surface.extra(data))
        await page.goto(surface.url)
        await expect(surface.ready(page)).toBeVisible({ timeout: READY_MS })
        if (surface.then) await surface.then(page)
        if (surface.dollars) {
          await page.getByRole('group', { name: 'Currency' }).getByRole('button', { name: 'USD' }).click()
          await expect(page.getByTestId('period-net-flow')).toContainText('86.40')
        }
        if (theme === 'dark') await toggleDark(page)
        await page.waitForLoadState('networkidle')
        const text = await page.locator('main').innerText()
        expect(text.match(HYPHEN_SIGNED) ?? [], `${surface.name} (${variant}, ${theme}) writes no amount with a hyphen`).toEqual([])
        await shot(page, `no-hyphen-${surface.name.replace(/ /g, '-')}-${variant}-${theme}`)
      })
    }
  }
}

test('format change preserves values: dashboard summary rows', async ({ page }) => {
  await openDashboard(page)
  const read = async (id: string): Promise<number> => valueOf((await page.getByTestId(id).innerText()).trim())
  expect(await read('period-income'), 'Total income is the fixture month income').toBe(MONTH.total_income)
  expect(await read('period-expenses'), 'Total expenses is the fixture month spending').toBe(MONTH.total_expenses)
  expect(await read('period-net-flow'), 'Net flow is the fixture month net flow').toBe(MONTH.net_flow)
  expect(await read('net-worth'), 'Net worth is the fixture total').toBe(BALANCES.total)
  expect(await read('available-cash'), 'Available cash is the fixture available cash').toBe(BALANCES.available_cash)
  await shot(page, 'summary-values')
})

test('format change preserves values: accounts negative card', async ({ page }) => {
  expect(CARD?.balance, 'the fixture card is owed').toBe(-18742.3)
  await mockHousehold(page)
  await page.goto('/accounts')
  const owed = page.locator('main .amount-negative').filter({ hasText: '18,742.30' })
  await expect(owed).toBeVisible({ timeout: READY_MS })
  expect((await owed.innerText()).trim(), 'the card balance on Accounts').toBe('−₱18,742.30')
  await shot(page, 'accounts-card')
})
