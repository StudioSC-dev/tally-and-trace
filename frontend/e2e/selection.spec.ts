// STU-679: selection is not an action. Every selectable control (segments, toggle chips, tabs, the pagers' current
// page and the Add Account Active switch) carries the selection rule from docs/design-system.md: a leaf background,
// ink 600 text and a 2px spine rule underneath, square, never the primary button's fill. The API is faked in the
// browser with the shared household fixture; there is no backend.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { expect, test } from '@playwright/test'
import type { Locator, Page } from '@playwright/test'
import type { Account, AccountInput, BudgetEntryInput, TransactionInput } from '@tally-trace/shared'
import { mockApi } from './support/mockApi'
import type { ApiMock } from './support/mockApi'
import { shot } from './support/shot'
import {
  allAccountDetailRoutes,
  createAccountRoute,
  createdAccount,
  household,
  householdCreateRoutes,
  householdViewRoutes,
  mockHousehold,
  newAccountInput,
  withAccountHistory,
  withDollarTimeline,
  withDollars,
  withLongDueLists,
  withMainAccount,
} from './support/fixtures/household'
import type { HouseholdData } from './support/fixtures/household'

const FRONTEND = fileURLToPath(new URL('..', import.meta.url))

/** docs/design-system.md, light: leaf `surface` #F2F5F0, `ink` #16241C, `body` #2D3B33, spine `accent` #22483A. */
const LEAF = 'rgb(242, 245, 240)'
const INK = 'rgb(22, 36, 28)'
const BODY = 'rgb(45, 59, 51)'
const ACCENT = 'rgb(34, 72, 58)'
const TRANSPARENT = 'rgba(0, 0, 0, 0)'
/** The spine rule as getComputedStyle reports `inset 0 -2px 0 rgb(var(--accent))`. */
const SPINE_RULE = /rgb\(34, 72, 58\) 0px -2px 0px 0px inset/
/** Dark: the primary's fill is the dark accent #93CDA9 and `ink` is #E5EEE7. */
const DARK_PRIMARY = 'rgb(147, 205, 169)'
const DARK_INK = 'rgb(229, 238, 231)'

type Name = string | RegExp
/** How a group marks its choice: `aria-pressed`, a tab's `aria-selected`, a pager's `aria-current`, a switch. */
type Kind = 'pressed' | 'tab' | 'current' | 'switch'

/** One inventoried group: where it lives, how to show it, the choice the tests make and what that choice does. */
interface Group {
  key: string
  route: string
  /** What the group is, for the inventory. */
  what: string
  kind: Kind
  /**
   * `toggle`: a multi-select group with no "all" option. A click adds or removes one option and leaves the others as
   * they were, so the one-selected rule does not apply (the ticket's Tags exception, used for every such picker).
   */
  multi?: 'toggle'
  /**
   * The group is colour swatches: each keeps its own fill and the chosen one is ringed in the ink token, so the
   * leaf background and spine rule do not apply to it.
   */
  swatch?: true
  /** The group is inside a dialog: screenshots are of the viewport. */
  dialog?: boolean
  /** Opens the route and shows the group, with `selected` chosen. */
  open: (page: Page) => Promise<ApiMock>
  /** The group's container. */
  group: (page: Page) => Locator
  /** Every selectable control in the group. */
  items?: (page: Page) => Locator
  selected: Name
  other: Name
  disabled?: Name
  /** Shows the group again after a pick folds it (a compact picker, the installment months). */
  reopen?: (page: Page) => Promise<void>
  /** The existing effect, as recorded in the inventory. */
  effect: string
  /** Checks the state before the pick. */
  before: (page: Page, seen: URL[]) => Promise<void>
  /** Checks the existing effect after the pick, before anything is saved. */
  after: (page: Page, seen: URL[]) => Promise<void>
  /**
   * Controls outside the group that the pick is expected to take off the page (descriptors as `compareUnrelated`
   * reports them), why, and a direct check that they are gone. Any other control that leaves the page fails the case.
   */
  gone?: { controls: string[]; why: string; check: (page: Page) => Promise<void> }
  /** Saves the form and checks what reaches the API, after the unrelated selections are checked. */
  submit?: (page: Page, api: ApiMock) => Promise<void>
}

const roleOf = (kind: Kind): 'button' | 'tab' | 'switch' => (kind === 'tab' ? 'tab' : kind === 'switch' ? 'switch' : 'button')
const itemsOf = (page: Page, g: Group): Locator => (g.items ? g.items(page) : g.group(page).getByRole(roleOf(g.kind)))
const optionOf = (page: Page, g: Group, name: Name): Locator =>
  g.kind === 'switch' ? g.group(page) : itemsOf(page, g).and(page.getByRole(roleOf(g.kind), { name, exact: typeof name === 'string' }))

/** Every `/api/v1` request URL the page makes, with its query. */
function recordRequests(page: Page): URL[] {
  const seen: URL[] = []
  page.on('request', (r) => {
    if (r.url().includes('/api/v1/')) seen.push(new URL(r.url()))
  })
  return seen
}
const lastCall = (seen: URL[], apiPath: string): URL | undefined => [...seen].reverse().find((u) => u.pathname === `/api/v1${apiPath}`)

async function settle(page: Page): Promise<void> {
  await page.waitForLoadState('networkidle')
  // A pointer left on a control would show its hover colour; park it in the corner.
  await page.mouse.move(0, 0)
  // Read colours at rest: a fill sampled mid-transition is neither the old nor the new one.
  await page.evaluate(() => Promise.allSettled(document.getAnimations().filter((a) => a instanceof CSSTransition).map((a) => a.finished)))
}

async function openPage(page: Page, route: string, heading: Name, data: HouseholdData = household, extra: Parameters<typeof mockApi>[1] = []): Promise<ApiMock> {
  const api = await mockHousehold(page, data)
  if (extra.length) await mockApi(page, extra)
  await page.goto(route)
  // The dev server compiles a route's chunk on its first visit; under a full parallel run that can pass 5s.
  await expect(page.getByRole('heading', { level: 1, name: heading })).toBeVisible({ timeout: 15_000 })
  await page.waitForLoadState('networkidle')
  return api
}

async function openFilters(page: Page, data: HouseholdData = household): Promise<ApiMock> {
  const api = await openPage(page, '/transactions', 'Transactions', data)
  await page.getByRole('button', { name: 'Show filters' }).click()
  await expect(page.getByRole('group', { name: 'Entered by' })).toBeVisible()
  return api
}

const dialogOf = (page: Page): Locator => page.locator('.fixed.inset-0.overflow-y-auto').last()

async function openTransactionDialog(page: Page): Promise<ApiMock> {
  const api = await openPage(page, '/transactions', 'Transactions', household, householdCreateRoutes(household))
  await page.getByRole('button', { name: 'Add Transaction', exact: true }).first().click()
  await expect(page.getByRole('heading', { name: 'Create Transaction' })).toBeVisible()
  return api
}

/** Picks an account in the transaction dialog's compact account field, which then folds to one line. */
async function pickAccount(page: Page, name: string): Promise<void> {
  await dialogOf(page).getByRole('group', { name: /^(From )?Account$/ }).getByRole('button', { name: new RegExp(`^${name}`) }).click()
  await expect(dialogOf(page).locator('[data-field="account_id"] [data-picker-value]')).toContainText(name)
}

/** The compact field's "Change" button, which opens its rows again. */
const changeOf = (page: Page, field: string): Locator => dialogOf(page).locator(`[data-field="${field}"] [data-picker-change]`)
/** The compact field's folded line: the chosen option's text. */
const lineOf = (page: Page, field: string): Locator => dialogOf(page).locator(`[data-field="${field}"] [data-picker-value]`)

async function openAllocations(page: Page): Promise<ApiMock> {
  return openPage(page, '/allocations', 'Allocations', household, householdCreateRoutes(household))
}

async function openRecurringDialog(page: Page): Promise<ApiMock> {
  const api = await openAllocations(page)
  await page.getByRole('button', { name: 'Add Recurring Entry', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Add Recurring Entry' })).toBeVisible()
  return api
}

async function openBudgetDialog(page: Page): Promise<ApiMock> {
  const api = await openAllocations(page)
  await page.getByRole('button', { name: 'Budgets', exact: true }).click()
  await page.getByRole('button', { name: 'Add Allocation', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Create Budget Envelope' })).toBeVisible()
  return api
}

/** The household's two creates on Add Account: the first saved inactive, the second active (the default). */
const createdAccounts: Account[] = [
  createdAccount(household, 90, { ...newAccountInput, tag_ids: [...newAccountInput.tag_ids], is_active: false }),
  createdAccount(household, 91, { ...newAccountInput, tag_ids: [...newAccountInput.tag_ids], is_active: true }),
]

async function openAccountDialog(page: Page, created: Account[] = createdAccounts): Promise<ApiMock> {
  const api = await openPage(page, '/accounts', 'Accounts', household, [createAccountRoute(created)])
  await page.getByRole('button', { name: 'Add Account', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Create Account' })).toBeVisible()
  return api
}

const accountTypeOf = (page: Page): Locator => dialogOf(page).locator('select').filter({ has: page.locator('option[value="e_wallet"]') })
const accountCurrencyOf = (page: Page): Locator => dialogOf(page).locator('select').filter({ has: page.locator('option[value="USD"]') })
const tagOf = (page: Page, name: string): Locator => dialogOf(page).getByRole('group', { name: 'Tags' }).getByRole('button', { name, exact: true })

/** Moves every Add Account field off its default, from the fixture's `newAccountInput`. */
async function seedAccount(page: Page): Promise<void> {
  const d = dialogOf(page)
  await d.getByPlaceholder('Enter account name').fill(newAccountInput.name)
  await accountTypeOf(page).selectOption(newAccountInput.account_type)
  await d.getByRole('checkbox', { name: 'Spending wallet' }).check()
  await accountCurrencyOf(page).selectOption(newAccountInput.currency)
  await d.getByPlaceholder('0.00').fill(String(newAccountInput.balance))
  await tagOf(page, 'Japan trip').click()
  await d.getByPlaceholder('Add a description for this account').fill(newAccountInput.description)
}

/** Every seeded Add Account value, read back from its control. */
async function expectAccountSeeded(page: Page): Promise<void> {
  await expect(dialogOf(page).getByPlaceholder('Enter account name')).toHaveValue(newAccountInput.name)
  await expect(accountTypeOf(page)).toHaveValue(newAccountInput.account_type)
  await expect(dialogOf(page).getByRole('checkbox', { name: 'Spending wallet' })).toBeChecked()
  await expect(accountCurrencyOf(page)).toHaveValue(newAccountInput.currency)
  await expect(dialogOf(page).getByPlaceholder('0.00')).toHaveValue(String(newAccountInput.balance))
  await expect(tagOf(page, 'Japan trip')).toHaveAttribute('aria-pressed', 'true')
  await expect(tagOf(page, 'Household')).toHaveAttribute('aria-pressed', 'false')
  await expect(dialogOf(page).getByPlaceholder('Add a description for this account')).toHaveValue(newAccountInput.description)
}

/** Fills the rest of Add Transaction and saves it. */
async function saveTransaction(page: Page, api: ApiMock): Promise<TransactionInput> {
  await dialogOf(page).getByPlaceholder('Add notes about this transaction').fill('Selection check')
  await pickAccount(page, 'BPI Payroll')
  await dialogOf(page).locator('input[type="number"][placeholder="0.00"]').first().fill('120')
  await dialogOf(page).getByRole('button', { name: 'Create Transaction', exact: true }).click()
  await expect.poll(() => api.bodies('POST', '/transactions/').length).toBe(1)
  return api.bodies('POST', '/transactions/')[0] as TransactionInput
}

/** Fills the rest of Add Recurring Entry and saves it. */
async function saveRecurringEntry(page: Page, api: ApiMock): Promise<BudgetEntryInput> {
  await dialogOf(page).locator('input[type="text"]').first().fill('Water delivery')
  await dialogOf(page).locator('select').first().selectOption('11')
  await dialogOf(page).locator('input[type="number"]').first().fill('350')
  await dialogOf(page).getByRole('button', { name: 'Save Recurring Entry', exact: true }).click()
  await expect.poll(() => api.bodies('POST', '/budget-entries/').length).toBe(1)
  return api.bodies('POST', '/budget-entries/')[0] as BudgetEntryInput
}

/** Fills the rest of the allocation dialog and saves it; returns the `configuration` sent. */
async function saveAllocation(page: Page, api: ApiMock, name: string): Promise<unknown> {
  await dialogOf(page).locator('input[type="text"]').first().fill(name)
  await dialogOf(page).locator('select').first().selectOption('11')
  // The empty amounts: a budget's spending limit, a savings tracker's target.
  for (const amount of await dialogOf(page).locator('input[type="number"]').all()) {
    if ((await amount.inputValue()) === '') await amount.fill('3000')
  }
  await dialogOf(page).locator('button[type="submit"]').click()
  await expect.poll(() => api.bodies('POST', '/allocations/').length).toBe(1)
  return (api.bodies('POST', '/allocations/')[0] as { configuration?: unknown }).configuration
}

const visibleText = (page: Page, text: string): Locator => page.getByText(text, { exact: true }).first()
const visiblePager = (page: Page): Locator => page.getByTestId('due-pager').filter({ visible: true })
const duePanel = (page: Page, slug: string): Locator => page.getByTestId(`due-panel-${slug}`)

/** A Due card tab's pager, in the variant where every tab holds more than one page of three. */
const duePager = (slug: string, tab: string, range: string, firstOnPage2: string): Group => ({
  key: `due-${slug}-pager`,
  route: '/transactions',
  what: `Due card ${tab} pager's current page (Pager.tsx, aria-current)`,
  kind: 'current',
  open: async (page) => {
    const api = await openPage(page, '/transactions', 'Transactions', withLongDueLists(household))
    await page.getByTestId(`due-tab-${slug}`).click()
    await expect(visiblePager(page)).toBeVisible()
    return api
  },
  group: visiblePager,
  items: (page) => visiblePager(page).getByRole('button', { name: /^\d+$/ }),
  selected: '1',
  other: '2',
  effect: `Page 2 lists ${range}, starting with ${firstOnPage2}`,
  before: async (page) => {
    await expect(duePanel(page, slug).getByText(firstOnPage2, { exact: true })).toHaveCount(0)
  },
  after: async (page) => {
    await expect(duePanel(page, slug).getByText(firstOnPage2, { exact: true })).toBeVisible()
    await expect(visiblePager(page)).toContainText(range)
  },
})

/** The conversion inventory: every converted group, one entry per place it is used, with its existing effect. */
const INVENTORY: Group[] = [
  {
    key: 'transactions-list-view',
    route: '/transactions',
    what: 'List view: To date / Scheduled (SegmentedControl)',
    kind: 'pressed',
    open: (page) => openPage(page, '/transactions', 'Transactions'),
    group: (page) => page.getByRole('group', { name: 'List view' }),
    selected: 'To date',
    other: 'Scheduled',
    effect: 'Scheduled sets ?view=scheduled and shows the scheduled view with the coming occurrences (Palengke run, 14 March)',
    before: async (page) => {
      await expect(page.getByTestId('scheduled-view')).toHaveCount(0)
      await expect(visibleText(page, 'Puregold weekly groceries')).toBeVisible()
    },
    after: async (page) => {
      await expect(page).toHaveURL(/view=scheduled/)
      await expect(page.getByTestId('scheduled-view')).toBeVisible()
      await expect(page.getByTestId('scheduled-view').getByText('Palengke run').first()).toBeVisible()
    },
    gone: {
      controls: ['Transactions pages › 1'],
      why: 'Scheduled replaces the month list, and the list pager goes with it',
      check: async (page) => {
        await expect(page.getByRole('navigation', { name: 'Transactions pages' })).toHaveCount(0)
      },
    },
  },
  {
    key: 'transactions-entered-by',
    route: '/transactions',
    what: 'Filters: Entered by, Everyone / Only mine (SegmentedControl)',
    kind: 'pressed',
    open: (page) => openFilters(page),
    group: (page) => page.getByRole('group', { name: 'Entered by' }),
    selected: 'Everyone',
    other: 'Only mine',
    effect: "Only mine asks the list for entered_by=me: Jun's joint-account rows leave, Mara's stay",
    before: async (page) => {
      await expect(visibleText(page, 'Palengke, Marikina market')).toBeVisible()
    },
    after: async (page, seen) => {
      await expect.poll(() => lastCall(seen, '/transactions/')?.searchParams.get('entered_by')).toBe('me')
      await expect(page.getByText('Palengke, Marikina market', { exact: true })).toHaveCount(0)
      await expect(visibleText(page, 'Puregold weekly groceries')).toBeVisible()
    },
  },
  {
    key: 'transactions-types',
    route: '/transactions',
    what: 'Filters: Transaction types, All types / Income / Expense / Transfer (Segment toggles)',
    kind: 'pressed',
    open: (page) => openFilters(page),
    group: (page) => page.getByRole('group', { name: 'Transaction types' }),
    selected: 'All types',
    other: 'Income',
    disabled: 'All types',
    effect: 'Income asks for transaction_types=credit: only income rows stay; All types is disabled while chosen',
    before: async (page) => {
      await expect(visibleText(page, 'Puregold weekly groceries')).toBeVisible()
    },
    after: async (page, seen) => {
      await expect.poll(() => lastCall(seen, '/transactions/')?.searchParams.getAll('transaction_types')).toEqual(['credit'])
      await expect(visibleText(page, 'Logo design, Kapé Co.')).toBeVisible()
      await expect(page.getByText('Puregold weekly groceries', { exact: true })).toHaveCount(0)
    },
  },
  {
    key: 'transactions-accounts',
    route: '/transactions',
    what: 'Filters: Accounts, All accounts / each account (AccountPicker chips, Segment)',
    kind: 'pressed',
    open: (page) => openFilters(page),
    group: (page) => page.locator('[data-field="filter_accounts"]'),
    selected: 'All accounts',
    other: /^GCash/,
    disabled: 'All accounts',
    effect: 'GCash asks for account_ids=13: only GCash rows stay; All accounts is disabled while chosen',
    before: async (page) => {
      await expect(visibleText(page, 'Puregold weekly groceries')).toBeVisible()
    },
    after: async (page, seen) => {
      await expect.poll(() => lastCall(seen, '/transactions/')?.searchParams.getAll('account_ids')).toEqual(['13'])
      await expect(visibleText(page, 'Grab to Makati')).toBeVisible()
      await expect(page.getByText('Puregold weekly groceries', { exact: true })).toHaveCount(0)
    },
  },
  {
    key: 'transactions-categories',
    route: '/transactions',
    what: 'Filters: Categories, All categories / No category / each category (CategoryPicker chips, Segment)',
    kind: 'pressed',
    open: (page) => openFilters(page),
    group: (page) => page.locator('[data-field="filter_categories"]'),
    items: (page) => page.locator('[data-field="filter_categories"] [aria-pressed]'),
    selected: 'All categories',
    other: 'Groceries',
    disabled: 'All categories',
    effect: "Groceries asks for category_names=Groceries: the grocery rows stay (Mara's and Jun's), the rest leave; All categories is disabled while chosen",
    before: async (page) => {
      await expect(visibleText(page, 'Grab to Makati')).toBeVisible()
    },
    after: async (page, seen) => {
      await expect.poll(() => lastCall(seen, '/transactions/')?.searchParams.getAll('category_names')).toEqual(['Groceries'])
      await expect(visibleText(page, 'Puregold weekly groceries')).toBeVisible()
      await expect(visibleText(page, 'Palengke, Marikina market')).toBeVisible()
      await expect(page.getByText('Grab to Makati', { exact: true })).toHaveCount(0)
    },
  },
  {
    key: 'transactions-list-pager',
    route: '/transactions',
    what: "Month list pager's current page (aria-current, selection class)",
    kind: 'current',
    open: async (page) => {
      const api = await openFilters(page)
      // From 1 February the list holds 28 rows: two pages of 25.
      await page.locator('input[type="date"]').first().fill('2026-02-01')
      await expect(page.getByTestId('transactions-pager').getByRole('button', { name: '2', exact: true })).toBeVisible()
      return api
    },
    group: (page) => page.getByTestId('transactions-pager'),
    items: (page) => page.getByTestId('transactions-pager').getByRole('button', { name: /^\d+$/ }),
    selected: '1',
    other: '2',
    effect: 'Page 2 asks for offset=25 and lists the three oldest rows',
    before: async (page) => {
      await expect(visibleText(page, 'Puregold weekly groceries')).toBeVisible()
    },
    after: async (page, seen) => {
      await expect.poll(() => lastCall(seen, '/transactions/')?.searchParams.get('offset')).toBe('25')
      await expect(visibleText(page, 'Jollibee family bucket')).toBeVisible()
      await expect(page.getByText('Puregold weekly groceries', { exact: true })).toHaveCount(0)
    },
  },
  {
    key: 'due-tabs',
    route: '/transactions',
    what: 'Due card tabs (Tabs, role=tab)',
    kind: 'tab',
    open: (page) => openPage(page, '/transactions', 'Transactions'),
    group: (page) => page.getByRole('tablist').filter({ has: page.getByTestId('due-tab-due') }),
    selected: /^Due and overdue/,
    other: /^Upcoming/,
    effect: 'Upcoming shows the Upcoming panel (the 16 non-subscription occurrences) and hides Due and overdue',
    before: async (page) => {
      await expect(page.getByTestId('due-panel-upcoming')).toBeHidden()
    },
    after: async (page) => {
      await expect(page.getByTestId('due-panel-upcoming')).toBeVisible()
      await expect(page.getByTestId('due-panel-due')).toBeHidden()
      await expect(page.getByTestId('due-upcoming-count')).toHaveText('16')
    },
  },
  duePager('due', 'Due and overdue', '4–5 of 5', 'Emergency fund top-up'),
  duePager('not-posted', 'Not posted yet', '4–4 of 4', 'Shopee order, pending'),
  {
    key: 'due-pager',
    route: '/transactions',
    what: "Due card Upcoming pager's current page (Pager.tsx, aria-current)",
    kind: 'current',
    open: async (page) => {
      const api = await openPage(page, '/transactions', 'Transactions')
      await page.getByTestId('due-tab-upcoming').click()
      await expect(visiblePager(page)).toBeVisible()
      return api
    },
    group: visiblePager,
    items: (page) => visiblePager(page).getByRole('button', { name: /^\d+$/ }),
    selected: '1',
    other: '2',
    effect: 'Page 2 lists the 4th to 6th upcoming occurrences (Globe Postpaid, 18 March, first)',
    before: async (page) => {
      await expect(page.getByTestId('due-panel-upcoming').getByText('Globe Postpaid')).toHaveCount(0)
    },
    after: async (page) => {
      await expect(page.getByTestId('due-panel-upcoming').getByText('Globe Postpaid').first()).toBeVisible()
      await expect(visiblePager(page)).toContainText('4–6 of 16')
    },
  },
  duePager('subscriptions', 'Subscriptions', '4–4 of 4', 'Netflix Standard'),
  duePager('installments', 'Installments', '4–4 of 4', 'Sofa, 12 months'),
  {
    key: 'transaction-dialog-type',
    route: '/transactions (Add Transaction)',
    what: 'Add Transaction: Transaction type, Income / Expense / Transfer (SegmentedControl)',
    kind: 'pressed',
    dialog: true,
    open: openTransactionDialog,
    group: (page) => dialogOf(page).getByRole('group', { name: 'Transaction type' }),
    selected: 'Expense',
    other: 'Transfer',
    effect: 'Transfer adds the Destination Account field',
    before: async (page) => {
      await expect(dialogOf(page).locator('#transaction-destination-label')).toHaveCount(0)
    },
    after: async (page) => {
      await expect(dialogOf(page).locator('#transaction-destination-label')).toHaveText('Destination Account')
    },
  },
  {
    key: 'transaction-dialog-account',
    route: '/transactions (Add Transaction)',
    what: 'Add Transaction: Account rows (AccountPicker compact rows, Segment)',
    kind: 'pressed',
    dialog: true,
    open: async (page) => {
      const api = await openTransactionDialog(page)
      await pickAccount(page, 'BPI Payroll')
      await changeOf(page, 'account_id').click()
      return api
    },
    group: (page) => dialogOf(page).getByRole('group', { name: 'Account' }),
    items: (page) => dialogOf(page).locator('[data-field="account_id"] [data-picker-option]'),
    selected: /^BPI Payroll/,
    other: /^HSBC Red Mastercard/,
    reopen: async (page) => {
      await changeOf(page, 'account_id').click()
    },
    effect: 'An expense on the HSBC card offers the Installment section; on BPI Payroll it does not',
    before: async (page) => {
      await expect(page.getByTestId('installment-section')).toHaveCount(0)
    },
    after: async (page) => {
      await expect(page.getByTestId('installment-section')).toBeVisible()
    },
  },
  {
    key: 'transaction-dialog-destination',
    route: '/transactions (Add Transaction, Transfer)',
    what: 'Add Transaction: Destination Account rows (AccountPicker compact rows, Segment)',
    kind: 'pressed',
    dialog: true,
    open: async (page) => {
      const api = await openTransactionDialog(page)
      await dialogOf(page).getByRole('group', { name: 'Transaction type' }).getByRole('button', { name: 'Transfer' }).click()
      await pickAccount(page, 'BPI Payroll')
      await dialogOf(page).getByRole('group', { name: 'Destination Account', exact: true }).getByRole('button', { name: /^Metrobank Savings/ }).click()
      await changeOf(page, 'transfer_to_account_id').click()
      return api
    },
    group: (page) => dialogOf(page).getByRole('group', { name: 'Destination Account', exact: true }),
    items: (page) => dialogOf(page).locator('[data-field="transfer_to_account_id"] [data-picker-option]'),
    selected: /^Metrobank Savings/,
    other: /^GCash/,
    reopen: async (page) => {
      await changeOf(page, 'transfer_to_account_id').click()
    },
    effect: 'GCash becomes the destination: the field reads GCash (PHP); the source, BPI Payroll, is never offered',
    before: async (page) => {
      await expect(lineOf(page, 'transfer_to_account_id')).toHaveText('Metrobank Savings (PHP)')
      await expect(dialogOf(page).locator('[data-field="transfer_to_account_id"] [data-picker-option]').filter({ hasText: 'BPI Payroll' })).toHaveCount(0)
    },
    after: async (page) => {
      await expect(lineOf(page, 'transfer_to_account_id')).toHaveText('GCash (PHP)')
      await expect(dialogOf(page).locator('[data-field="transfer_to_account_id"] [data-picker-option]').filter({ hasText: 'BPI Payroll' })).toHaveCount(0)
    },
  },
  {
    key: 'transaction-dialog-category',
    route: '/transactions (Add Transaction)',
    what: 'Add Transaction: Category rows, Uncategorized / each category (CategoryPicker compact rows, Segment)',
    kind: 'pressed',
    dialog: true,
    open: async (page) => {
      const api = await openTransactionDialog(page)
      await changeOf(page, 'category_id').click()
      return api
    },
    group: (page) => dialogOf(page).getByRole('group', { name: 'Category', exact: true }),
    items: (page) => dialogOf(page).locator('[data-field="category_id"] [data-picker-option]'),
    selected: 'Uncategorized',
    other: 'Groceries',
    reopen: async (page) => {
      await changeOf(page, 'category_id').click()
    },
    effect: 'Groceries becomes the category: the field reads Groceries; an expense offers expense categories only (no Salary)',
    before: async (page) => {
      await expect(lineOf(page, 'category_id')).toHaveText('Uncategorized')
      await expect(dialogOf(page).locator('[data-field="category_id"] [data-picker-option]').filter({ hasText: 'Salary' })).toHaveCount(0)
    },
    after: async (page) => {
      await expect(lineOf(page, 'category_id')).toHaveText('Groceries')
    },
    submit: async (page, api) => {
      expect((await saveTransaction(page, api)).category_id).toBe(22)
    },
  },
  {
    key: 'transaction-dialog-installment-months',
    route: '/transactions (Add Transaction)',
    what: 'Add Transaction: Installment months (Segment)',
    kind: 'pressed',
    dialog: true,
    open: async (page) => {
      const api = await openTransactionDialog(page)
      await pickAccount(page, 'HSBC Red Mastercard')
      await page.getByTestId('installment-toggle').check()
      await page.getByTestId('installment-months-6').click()
      await page.getByTestId('installment-change').click()
      return api
    },
    group: (page) => page.getByRole('group', { name: 'Months' }),
    selected: '6',
    other: '12',
    reopen: async (page) => {
      await page.getByTestId('installment-change').click()
    },
    effect: 'The months pick sets the plan: the months field reads 12',
    before: async (page) => {
      await expect(page.locator('#installment-months')).toHaveValue('6')
    },
    after: async (page) => {
      await expect(page.locator('#installment-months')).toHaveValue('12')
    },
  },
  {
    key: 'transaction-dialog-repeat-ends',
    route: '/transactions (Add Transaction, Repeat)',
    what: 'Add Transaction: Repeat, Ends, Keep running / On date / After runs (RecurringScheduleFields, SegmentedControl)',
    kind: 'pressed',
    dialog: true,
    open: async (page) => {
      const api = await openTransactionDialog(page)
      await page.getByTestId('repeat-toggle').check()
      await expect(page.getByTestId('repeat-fields')).toBeVisible()
      return api
    },
    group: (page) => page.getByTestId('repeat-fields').getByRole('group', { name: 'Ends' }),
    selected: 'Keep running',
    other: 'After runs',
    effect: 'After runs adds the number-of-runs field to the Repeat schedule, filled with 6',
    before: async (page) => {
      await expect(page.getByTestId('repeat-fields').locator('input[type="number"]')).toHaveCount(0)
    },
    after: async (page) => {
      await expect(page.getByTestId('repeat-fields').locator('input[type="number"]')).toHaveValue('6')
    },
  },
  {
    key: 'transaction-dialog-tags',
    route: '/transactions (Add Transaction)',
    what: 'Add Transaction: Tags (TagPicker, Segment toggles, multi-select)',
    kind: 'pressed',
    multi: 'toggle',
    dialog: true,
    open: async (page) => {
      const api = await openTransactionDialog(page)
      await tagOf(page, 'Household').click()
      return api
    },
    group: (page) => dialogOf(page).getByRole('group', { name: 'Tags' }),
    selected: 'Household',
    other: 'Japan trip',
    effect: 'Japan trip joins Household: the transaction is created with tag_ids [41, 42]',
    before: async (page) => {
      await expect(tagOf(page, 'Household')).toHaveAttribute('aria-pressed', 'true')
    },
    after: async (page) => {
      await expect(tagOf(page, 'Household')).toHaveAttribute('aria-pressed', 'true')
      await expect(tagOf(page, 'Japan trip')).toHaveAttribute('aria-pressed', 'true')
    },
    submit: async (page, api) => {
      expect([...((await saveTransaction(page, api)).tag_ids ?? [])].sort()).toEqual([41, 42])
    },
  },
  {
    key: 'dashboard-period',
    route: '/',
    what: 'Dashboard: Period for actual totals, week / month / year (SegmentedControl)',
    kind: 'pressed',
    open: (page) => openPage(page, '/', 'Dashboard'),
    group: (page) => page.getByRole('group', { name: 'Period for actual totals' }),
    selected: 'month',
    other: 'week',
    effect: 'Week relabels the actual totals "Week to Date" and asks the period summary for the last seven days, from 6 March',
    before: async (page) => {
      await expect(page.getByText('Actual Totals (Month to Date)')).toBeVisible()
    },
    after: async (page, seen) => {
      await expect(page.getByText('Actual Totals (Week to Date)')).toBeVisible()
      await expect.poll(() => lastCall(seen, '/transactions/summary/period')?.searchParams.get('start_date')?.slice(0, 10)).toBe('2026-03-06')
    },
  },
  {
    key: 'dashboard-currency',
    route: '/',
    what: 'Dashboard: Currency (CurrencyControl, SegmentedControl)',
    kind: 'pressed',
    open: (page) => openPage(page, '/', 'Dashboard', withDollars(household)),
    group: (page) => page.getByRole('group', { name: 'Currency' }),
    selected: 'PHP',
    other: 'USD',
    effect: "USD reads the snapshot's dollar row: its $1,250.00 balance shows",
    before: async (page) => {
      await expect(page.getByText('$1,250.00')).toHaveCount(0)
    },
    after: async (page) => {
      await expect(page.getByText('$1,250.00').first()).toBeVisible()
    },
  },
  {
    key: 'breakdown-currency',
    route: '/transactions (Spending breakdown)',
    what: 'Spending breakdown: Currency (CurrencyControl, SegmentedControl)',
    kind: 'pressed',
    dialog: true,
    open: async (page) => {
      const api = await openPage(page, '/transactions', 'Transactions', withDollars(household))
      await page.getByRole('button', { name: /Spending breakdown/ }).click()
      await expect(page.getByRole('dialog').getByRole('group', { name: 'Currency' })).toBeVisible()
      return api
    },
    group: (page) => page.getByRole('dialog').getByRole('group', { name: 'Currency' }),
    selected: 'PHP',
    other: 'USD',
    effect: "USD reads the summary's dollar row: Dining out, $86.40, is the only category",
    before: async (page) => {
      await expect(page.getByRole('dialog').getByText('$86.40')).toHaveCount(0)
    },
    after: async (page) => {
      await expect(page.getByRole('dialog').getByText('$86.40').filter({ visible: true }).first()).toBeVisible()
      await expect(page.getByRole('dialog')).toContainText('Posted spending in USD only.')
    },
  },
  {
    key: 'allocations-tabs',
    route: '/allocations',
    what: 'Allocations tab bar: Recurring / Budgets / Savings / Wishlist (Segment, layout unchanged)',
    kind: 'pressed',
    open: openAllocations,
    group: (page) => page.getByRole('button', { name: 'Recurring', exact: true }).locator('..'),
    selected: 'Recurring',
    other: 'Budgets',
    effect: 'Budgets lists the budget envelopes (Groceries, Dining out, Transport) and the add button becomes Add Allocation',
    before: async (page) => {
      await expect(page.getByRole('button', { name: 'Add Recurring Entry', exact: true })).toBeVisible()
    },
    after: async (page) => {
      await expect(page.getByRole('button', { name: 'Add Allocation', exact: true })).toBeVisible()
      await expect(page.getByText('Transport', { exact: true }).first()).toBeVisible()
    },
  },
  {
    key: 'allocations-cadence',
    route: '/allocations (Budgets, Add Allocation)',
    what: 'Create Budget Envelope: Budget cadence (Segment)',
    kind: 'pressed',
    dialog: true,
    open: openBudgetDialog,
    group: (page) => page.getByRole('group', { name: 'Budget cadence' }),
    selected: 'Monthly',
    other: 'Weekly',
    effect: 'Weekly resets the period end to a week after the start: 1 March to 8 March',
    before: async (page) => {
      await expect(dialogOf(page).locator('input[type="date"]').nth(1)).toHaveValue('2026-04-01')
    },
    after: async (page) => {
      await expect(dialogOf(page).locator('input[type="date"]').first()).toHaveValue('2026-03-01')
      await expect(dialogOf(page).locator('input[type="date"]').nth(1)).toHaveValue('2026-03-08')
    },
  },
  {
    key: 'allocations-tracked-categories',
    route: '/allocations (Budgets, Add Allocation)',
    what: 'Create Budget Envelope: Tracked Categories (CategoryPicker chips, Segment, multi-select)',
    kind: 'pressed',
    multi: 'toggle',
    dialog: true,
    open: async (page) => {
      const api = await openBudgetDialog(page)
      await dialogOf(page).locator('[data-field="category_ids"]').getByRole('button', { name: 'Groceries', exact: true }).click()
      return api
    },
    group: (page) => dialogOf(page).locator('[data-field="category_ids"]'),
    items: (page) => dialogOf(page).locator('[data-field="category_ids"] [aria-pressed]'),
    selected: 'Groceries',
    other: 'Dining out',
    effect: 'Dining out joins Groceries: the envelope is created tracking category_ids [22, 23]',
    before: async (page) => {
      await expect(dialogOf(page).locator('[data-field="category_ids"]').getByRole('button', { name: 'Groceries', exact: true })).toHaveAttribute('aria-pressed', 'true')
    },
    after: async (page) => {
      await expect(dialogOf(page).locator('[data-field="category_ids"]').getByRole('button', { name: 'Dining out', exact: true })).toHaveAttribute('aria-pressed', 'true')
    },
    submit: async (page, api) => {
      expect(await saveAllocation(page, api, 'Snacks')).toEqual({ category_ids: [22, 23] })
    },
  },
  {
    key: 'allocations-savings-accounts',
    route: '/allocations (Savings, Add Allocation)',
    what: 'Savings tracker: Accounts to aggregate (AccountPicker chips, Segment, multi-select)',
    kind: 'pressed',
    multi: 'toggle',
    dialog: true,
    open: async (page) => {
      const api = await openAllocations(page)
      await page.getByRole('button', { name: 'Savings', exact: true }).click()
      await page.getByRole('button', { name: 'Add Allocation', exact: true }).click()
      await dialogOf(page).getByRole('button', { name: /Combined account total/ }).click()
      await dialogOf(page).locator('[data-field="savings_account_ids"]').getByRole('button', { name: /^BPI Payroll/ }).click()
      return api
    },
    group: (page) => dialogOf(page).locator('[data-field="savings_account_ids"]'),
    items: (page) => dialogOf(page).locator('[data-field="savings_account_ids"] [aria-pressed]'),
    selected: /^BPI Payroll/,
    other: /^GCash/,
    effect: 'GCash joins BPI Payroll: the tracker is created aggregating account_ids [11, 13]',
    before: async (page) => {
      await expect(dialogOf(page).locator('[data-field="savings_account_ids"] [aria-pressed="true"]')).toHaveCount(1)
    },
    after: async (page) => {
      await expect(dialogOf(page).locator('[data-field="savings_account_ids"] [aria-pressed="true"]')).toHaveCount(2)
    },
    submit: async (page, api) => {
      expect(await saveAllocation(page, api, 'House fund')).toEqual({ goal_mode: 'multi_account', account_ids: [11, 13] })
    },
  },
  {
    key: 'recurring-entry-type',
    route: '/allocations (Add Recurring Entry)',
    what: 'Add Recurring Entry: Entry type, Expense / Income (SegmentedControl)',
    kind: 'pressed',
    dialog: true,
    open: openRecurringDialog,
    group: (page) => page.getByRole('group', { name: 'Entry type' }),
    selected: 'Expense',
    other: 'Income',
    effect: 'Income hides the "Transfer to" field (only an expense can be a recurring transfer)',
    before: async (page) => {
      await expect(dialogOf(page).getByText('Transfer to (optional)')).toBeVisible()
    },
    after: async (page) => {
      await expect(dialogOf(page).getByText('Transfer to (optional)')).toHaveCount(0)
    },
  },
  {
    key: 'recurring-entry-ends',
    route: '/allocations (Add Recurring Entry)',
    what: 'Add Recurring Entry: Ends, Keep running / On date / After runs (RecurringScheduleFields, SegmentedControl)',
    kind: 'pressed',
    dialog: true,
    open: openRecurringDialog,
    group: (page) => page.getByRole('group', { name: 'Ends' }),
    selected: 'Keep running',
    other: 'After runs',
    effect: 'After runs adds the number-of-runs field, filled with 6',
    before: async (page) => {
      await expect(dialogOf(page).getByText('End after')).toHaveCount(0)
    },
    after: async (page) => {
      await expect(dialogOf(page).locator('input[type="number"][value="6"]')).toHaveCount(1)
    },
  },
  {
    key: 'recurring-entry-tags',
    route: '/allocations (Add Recurring Entry)',
    what: 'Add Recurring Entry: Tags (TagPicker, Segment toggles, multi-select)',
    kind: 'pressed',
    multi: 'toggle',
    dialog: true,
    open: async (page) => {
      const api = await openRecurringDialog(page)
      await tagOf(page, 'Household').click()
      return api
    },
    group: (page) => dialogOf(page).getByRole('group', { name: 'Tags' }),
    selected: 'Household',
    other: 'Japan trip',
    effect: 'Japan trip joins Household: the entry is created with tag_ids [41, 42]',
    before: async (page) => {
      await expect(tagOf(page, 'Household')).toHaveAttribute('aria-pressed', 'true')
    },
    after: async (page) => {
      await expect(tagOf(page, 'Household')).toHaveAttribute('aria-pressed', 'true')
      await expect(tagOf(page, 'Japan trip')).toHaveAttribute('aria-pressed', 'true')
    },
    submit: async (page, api) => {
      expect([...((await saveRecurringEntry(page, api)).tag_ids ?? [])].sort()).toEqual([41, 42])
    },
  },
  {
    key: 'account-tags',
    route: '/accounts (Add Account)',
    what: 'Add Account: Tags (TagPicker, Segment toggles, multi-select)',
    kind: 'pressed',
    multi: 'toggle',
    dialog: true,
    open: async (page) => {
      const api = await openAccountDialog(page, [createdAccount(household, 92, { name: newAccountInput.name, tag_ids: [41, 42] })])
      await tagOf(page, 'Household').click()
      return api
    },
    group: (page) => dialogOf(page).getByRole('group', { name: 'Tags' }),
    selected: 'Household',
    other: 'Japan trip',
    effect: 'Japan trip joins Household: the Household notice stays and the account is created with tag_ids [41, 42]',
    before: async (page) => {
      await expect(page.getByTestId('household-account-notice')).toBeVisible()
    },
    after: async (page) => {
      await expect(page.getByTestId('household-account-notice')).toBeVisible()
    },
    submit: async (page, api) => {
      await dialogOf(page).getByPlaceholder('Enter account name').fill(newAccountInput.name)
      await page.getByRole('button', { name: 'Create Account', exact: true }).click()
      await expect.poll(() => api.bodies('POST', '/accounts/').length).toBe(1)
      expect([...((api.bodies('POST', '/accounts/')[0] as AccountInput).tag_ids ?? [])].sort()).toEqual([41, 42])
    },
  },
  {
    key: 'account-active-switch',
    route: '/accounts (Add Account)',
    what: 'Add Account: Active (role=switch, aria-checked; selected treatment when on)',
    kind: 'switch',
    dialog: true,
    open: (page) => openAccountDialog(page),
    group: (page) => page.getByRole('switch', { name: 'Active' }),
    items: (page) => page.getByRole('switch', { name: 'Active' }),
    selected: 'Active',
    other: 'Active',
    effect:
      'Off reads "Inactive" and the account is created with is_active false (answered inactive); on creates it with is_active true (answered active); every other field keeps its value',
    before: async (page) => {
      await expect(dialogOf(page).getByText('Active', { exact: true })).toBeVisible()
    },
    after: async (page) => {
      await expect(dialogOf(page).getByText('Inactive', { exact: true })).toBeVisible()
    },
  },
  {
    key: 'account-transactions-pager',
    route: '/accounts/13',
    what: "Account page: transactions pager's current page (Pager.tsx, aria-current)",
    kind: 'current',
    open: async (page) => {
      const data = withAccountHistory(household)
      const api = await openPage(page, '/accounts/13', 'GCash', data, allAccountDetailRoutes(data))
      await expect(page.getByTestId('account-transactions-pager').getByRole('button', { name: '2', exact: true })).toBeVisible()
      return api
    },
    group: (page) => page.getByTestId('account-transactions-pager'),
    items: (page) => page.getByTestId('account-transactions-pager').getByRole('button', { name: /^\d+$/ }),
    selected: '1',
    other: '2',
    effect: 'Page 2 asks for offset=25 and lists the five oldest GCash rows, down to "GCash top-up, 2 January"',
    before: async (page) => {
      await expect(page.getByText('GCash top-up, 2 January', { exact: true })).toHaveCount(0)
    },
    after: async (page, seen) => {
      await expect.poll(() => lastCall(seen, '/transactions/')?.searchParams.get('offset')).toBe('25')
      await expect(visibleText(page, 'GCash top-up, 2 January')).toBeVisible()
      await expect(page.getByTestId('account-transactions-pager')).toContainText('26–30 of 30')
    },
  },
  {
    key: 'forecast-scope',
    route: '/forecast',
    what: 'Forecast: Accounts, Main / All cash accounts (SegmentedControl)',
    kind: 'pressed',
    open: (page) => openPage(page, '/forecast', 'Cash-Flow Timeline', withMainAccount(household)),
    group: (page) => page.getByRole('group', { name: 'Accounts' }),
    selected: /^Main:/,
    other: 'All cash accounts',
    effect: 'All cash accounts asks the timeline without account_id (Main asks with account_id=11)',
    before: async (_page, seen) => {
      expect(lastCall(seen, '/forecast/timeline')?.searchParams.get('account_id')).toBe('11')
    },
    after: async (_page, seen) => {
      await expect.poll(() => lastCall(seen, '/forecast/timeline')?.searchParams.has('account_id')).toBe(false)
    },
  },
  {
    key: 'forecast-days',
    route: '/forecast',
    what: 'Forecast: Days ahead, 30 / 60 / 90 days (SegmentedControl; had no aria-pressed)',
    kind: 'pressed',
    open: (page) => openPage(page, '/forecast', 'Cash-Flow Timeline'),
    group: (page) => page.getByRole('group', { name: 'Days ahead' }),
    selected: '60 days',
    other: '30 days',
    effect: 'Thirty days asks the timeline for days=30 (the page opens on 60)',
    before: async (_page, seen) => {
      expect(lastCall(seen, '/forecast/timeline')?.searchParams.get('days')).toBe('60')
    },
    after: async (_page, seen) => {
      await expect.poll(() => lastCall(seen, '/forecast/timeline')?.searchParams.get('days')).toBe('30')
    },
  },
  {
    key: 'forecast-currency',
    route: '/forecast',
    what: 'Forecast: Currency (CurrencyControl, SegmentedControl)',
    kind: 'pressed',
    open: (page) => openPage(page, '/forecast', 'Cash-Flow Timeline', withDollarTimeline(household)),
    group: (page) => page.getByRole('group', { name: 'Currency' }),
    selected: 'PHP',
    other: 'USD',
    effect: 'USD reads the dollar row: its opening balance, $1,250.00, shows',
    before: async (page) => {
      await expect(page.getByText('$1,250.00')).toHaveCount(0)
    },
    after: async (page) => {
      await expect(page.getByText('$1,250.00').first()).toBeVisible()
    },
  },
  {
    key: 'household-tabs',
    route: '/accounts/household',
    what: 'Household view tabs (Tabs, role=tab)',
    kind: 'tab',
    open: (page) => openPage(page, '/accounts/household', 'Your Household', household, householdViewRoutes(household)),
    group: (page) => page.getByRole('tablist'),
    selected: 'Dashboard',
    other: 'Transactions',
    effect: "Transactions lists the Household-tagged rows (Meralco February bill) from /household/1/transactions",
    before: async (page) => {
      await expect(page.getByTestId('household-transaction')).toHaveCount(0)
    },
    after: async (page, seen) => {
      await expect(page.getByTestId('household-transaction-description').filter({ hasText: 'Meralco February bill' })).toBeVisible()
      expect(lastCall(seen, '/household/1/transactions')).toBeDefined()
    },
  },
  {
    key: 'settings-tag-colour',
    route: '/settings (Add tag)',
    what: 'Settings, Add tag: Colour swatches (Swatch, single-select, ringed in ink)',
    kind: 'pressed',
    swatch: true,
    dialog: true,
    open: async (page) => {
      const api = await openPage(page, '/settings', 'Settings')
      await page.getByRole('button', { name: 'Add tag', exact: true }).click()
      await expect(page.getByRole('group', { name: 'Colour' })).toBeVisible()
      return api
    },
    group: (page) => page.getByRole('group', { name: 'Colour' }),
    selected: 'Colour #2563eb',
    other: 'Colour #7c3aed',
    effect: 'Violet becomes the colour: the custom colour field reads #7c3aed, the string the form saves',
    before: async (page) => {
      await expect(page.getByRole('group', { name: 'Colour' }).locator('input[type="color"]')).toHaveValue('#2563eb')
    },
    after: async (page) => {
      await expect(page.getByRole('group', { name: 'Colour' }).locator('input[type="color"]')).toHaveValue('#7c3aed')
    },
  },
  {
    key: 'settings-category-colour',
    route: '/settings (Add category)',
    what: 'Settings, Add category: Colour swatches (Swatch, single-select, ringed in ink)',
    kind: 'pressed',
    swatch: true,
    dialog: true,
    open: async (page) => {
      const api = await openPage(page, '/settings', 'Settings')
      await page.getByRole('button', { name: 'Add category', exact: true }).click()
      await expect(page.getByRole('group', { name: 'Colour' })).toBeVisible()
      return api
    },
    group: (page) => page.getByRole('group', { name: 'Colour' }),
    selected: 'Colour #2563eb',
    other: 'Colour #7c3aed',
    effect: 'Violet becomes the colour: the custom colour field reads #7c3aed, the string the form saves',
    before: async (page) => {
      await expect(page.getByRole('group', { name: 'Colour' }).locator('input[type="color"]')).toHaveValue('#2563eb')
    },
    after: async (page) => {
      await expect(page.getByRole('group', { name: 'Colour' }).locator('input[type="color"]')).toHaveValue('#7c3aed')
    },
  },
]

/** Light-theme computed styles a selected control must have (supplementary to the direct checks in AC1). */
async function expectSelected(el: Locator, swatch?: true): Promise<void> {
  if (swatch) {
    await expect(el).toHaveClass(/\bis-selected\b/)
    await expect(el).toHaveCSS('border-top-width', '2px')
    await expect(el).toHaveCSS('border-top-color', INK)
    await expect(el).toHaveCSS('box-shadow', 'none')
    return
  }
  await expect(el).toHaveCSS('background-color', LEAF)
  await expect(el).toHaveCSS('color', INK)
  await expect(el).toHaveCSS('font-weight', '600')
  await expect(el).toHaveCSS('box-shadow', SPINE_RULE)
  for (const corner of ['top-left', 'top-right', 'bottom-right', 'bottom-left']) {
    await expect(el).toHaveCSS(`border-${corner}-radius`, '0px')
  }
}

/** Light-theme computed styles an unselected control must have (supplementary to the direct checks in AC3). */
async function expectQuiet(el: Locator, swatch?: true): Promise<void> {
  if (swatch) {
    await expect(el).not.toHaveClass(/\bis-selected\b/)
    await expect(el).toHaveCSS('border-top-color', TRANSPARENT)
    await expect(el).toHaveCSS('box-shadow', 'none')
    return
  }
  await expect(el).toHaveCSS('background-color', TRANSPARENT)
  await expect(el).toHaveCSS('color', BODY)
  await expect(el).toHaveCSS('font-weight', /^(400|500)$/)
  await expect(el).toHaveCSS('box-shadow', 'none')
}

/** The ARIA state of every control in the group, in order: `true` / `false` / null. */
const ariaStates = (items: Locator, kind: Kind): Promise<(string | null)[]> =>
  items.evaluateAll(
    (els, k) =>
      els.map((e) => {
        if (k === 'pressed') return e.getAttribute('aria-pressed')
        if (k === 'tab') return e.getAttribute('role') === 'tab' ? e.getAttribute('aria-selected') : 'not a tab'
        if (k === 'switch') return e.getAttribute('role') === 'switch' ? e.getAttribute('aria-checked') : 'not a switch'
        return e.getAttribute('aria-current') === 'page' ? 'true' : e.hasAttribute('aria-current') ? 'other' : 'false'
      }),
    kind,
  )

/** Each control's text and `aria-pressed`, sorted (a collapsed picker lists its chosen chips first), for a multi-select group. */
const pressedStates = (items: Locator): Promise<string[]> =>
  items.evaluateAll((els) => els.map((e) => `${e.textContent?.trim()}=${e.getAttribute('aria-pressed')}`).sort())

/** Asserts the group's ARIA marks exactly `name` as chosen. */
async function expectAriaChoice(page: Page, g: Group, name: Name): Promise<void> {
  const items = itemsOf(page, g)
  await expect(optionOf(page, g, name)).toBeVisible()
  const states = await ariaStates(items, g.kind)
  expect(states.length, `${g.key} has controls`).toBeGreaterThan(1)
  expect(states.filter((s) => s === 'true'), `${g.key}: exactly one control is marked chosen`).toEqual(['true'])
  expect(states.every((s) => s === 'true' || s === 'false'), `${g.key}: every control carries the attribute (${JSON.stringify(states)})`).toBe(true)
  const attr = g.kind === 'pressed' ? 'aria-pressed' : g.kind === 'tab' ? 'aria-selected' : 'aria-current'
  await expect(optionOf(page, g, name)).toHaveAttribute(attr, g.kind === 'current' ? 'page' : 'true')
}

/** Saves the evidence screenshot: full page, or the viewport for a dialog (a fixed overlay). */
async function evidence(page: Page, g: Group, name: string, focus?: Locator): Promise<void> {
  if (focus) await focus.scrollIntoViewIfNeeded()
  if (!g.dialog) {
    await shot(page, name)
    return
  }
  const info = test.info()
  await page.screenshot({ path: path.join(info.project.outputDir, 'screens', `selection-${name}-${info.project.name}.png`), animations: 'disabled' })
}

/** Clicks `name` in the group, then shows the group again if the click folded it. */
async function choose(page: Page, g: Group, name: Name): Promise<void> {
  await optionOf(page, g, name).click()
  if (g.reopen) await g.reopen(page)
  await settle(page)
}

/** One selectable control outside the group (pressed, tab, switch, or a current page or route), as it was before the pick. */
interface Watched {
  id: number
  /** Group label and control text, e.g. `Entered by › Only mine`. */
  desc: string
  was: string
  shown: boolean
}

/** What happened to the watched controls: values that moved, and controls that left the page. */
interface UnrelatedChanges {
  changed: string[]
  gone: string[]
}

/**
 * Marks every selectable control outside the group and records its descriptor, value and visibility in the test,
 * so a pick can be checked against them. The record lives here, not on the element, so a control that is removed
 * or replaced cannot drop out of the comparison.
 */
const watchUnrelated = (groupItems: Locator): Promise<Watched[]> =>
  groupItems.evaluateAll((own) => {
    const mine = new Set<Element>(own)
    const describe = (e: Element): string => {
      const box = e.closest('[role="group"], [role="tablist"], nav, [data-field]')
      const labelledBy = box?.getAttribute('aria-labelledby')
      const label = box?.getAttribute('aria-label') ?? (labelledBy ? document.getElementById(labelledBy)?.textContent : null) ?? box?.getAttribute('data-field') ?? ''
      const text = e.getAttribute('aria-label') ?? e.textContent ?? ''
      return `${label.replace(/\s+/g, ' ').trim()} › ${text.replace(/\s+/g, ' ').trim().slice(0, 60)}`
    }
    const valueOf = (e: Element): string => e.getAttribute('aria-pressed') ?? e.getAttribute('aria-selected') ?? e.getAttribute('aria-checked') ?? e.getAttribute('aria-current') ?? ''
    const all = [...document.querySelectorAll('[aria-pressed], [role="tab"], [role="switch"], [aria-current]')].filter((e) => !mine.has(e))
    return all.map((e, id) => {
      e.setAttribute('data-e2e-watch', String(id))
      return { id, desc: describe(e), was: valueOf(e), shown: e.checkVisibility() }
    })
  })

/**
 * Compares the watched controls with the page now. A marked control that is still there must keep its value. One
 * that was removed or replaced counts as gone, unless a control with the same descriptor and the same value stands
 * in its place (a remount); a stand-in with a different value is a change. A control that was visible and is now
 * hidden counts as gone.
 */
const compareUnrelated = (page: Page, watched: Watched[]): Promise<UnrelatedChanges> =>
  page.evaluate((list) => {
    const describe = (e: Element): string => {
      const box = e.closest('[role="group"], [role="tablist"], nav, [data-field]')
      const labelledBy = box?.getAttribute('aria-labelledby')
      const label = box?.getAttribute('aria-label') ?? (labelledBy ? document.getElementById(labelledBy)?.textContent : null) ?? box?.getAttribute('data-field') ?? ''
      const text = e.getAttribute('aria-label') ?? e.textContent ?? ''
      return `${label.replace(/\s+/g, ' ').trim()} › ${text.replace(/\s+/g, ' ').trim().slice(0, 60)}`
    }
    const valueOf = (e: Element): string => e.getAttribute('aria-pressed') ?? e.getAttribute('aria-selected') ?? e.getAttribute('aria-checked') ?? e.getAttribute('aria-current') ?? ''
    const unmarked = [...document.querySelectorAll('[aria-pressed], [role="tab"], [role="switch"], [aria-current]')].filter((e) => !e.hasAttribute('data-e2e-watch'))
    const changed: string[] = []
    const gone: string[] = []
    for (const w of list) {
      const el = document.querySelector(`[data-e2e-watch="${w.id}"]`)
      if (el) {
        if (valueOf(el) !== w.was) changed.push(`${w.desc}: ${w.was} → ${valueOf(el)}`)
        else if (w.shown && !el.checkVisibility()) gone.push(`${w.desc} (hidden)`)
        continue
      }
      const standIns = unmarked.filter((e) => describe(e) === w.desc && (!w.shown || e.checkVisibility()))
      if (standIns.length === 0) gone.push(w.desc)
      else if (!standIns.some((e) => valueOf(e) === w.was)) changed.push(`${w.desc}: ${w.was} → ${valueOf(standIns[0])} (replaced)`)
    }
    return { changed, gone }
  }, watched)

/** Waits for the next `POST /accounts/` answer. */
const accountCreated = (page: Page) => page.waitForResponse((r) => r.request().method() === 'POST' && new URL(r.url()).pathname === '/api/v1/accounts/')

test.describe('Selection is not an action (STU-679)', () => {
  for (const g of INVENTORY) {
    test(`selected controls use the spine rule: ${g.key}`, async ({ page }) => {
      await g.open(page)
      await settle(page)
      const selected = optionOf(page, g, g.selected)
      await expect(selected).toBeVisible()
      if (g.kind === 'switch') await expect(selected).toHaveAttribute('aria-checked', 'true')
      if (g.swatch) {
        await expectSelected(selected, g.swatch)
        await expect(selected).not.toHaveCSS('background-color', LEAF)
        await evidence(page, g, `ring-${g.key}`, selected)
        return
      }
      await expect(selected).toHaveCSS('background-color', LEAF)
      await expect(selected).toHaveCSS('color', INK)
      await expect(selected).toHaveCSS('font-weight', '600')
      await expect(selected).toHaveCSS('box-shadow', SPINE_RULE)
      await expect(selected).toHaveCSS('border-top-left-radius', '0px')
      await expect(selected).toHaveCSS('border-top-right-radius', '0px')
      await expect(selected).toHaveCSS('border-bottom-right-radius', '0px')
      await expect(selected).toHaveCSS('border-bottom-left-radius', '0px')
      await evidence(page, g, `spine-${g.key}`, selected)
    })

    test(`unselected controls are quiet: ${g.key}`, async ({ page }) => {
      await g.open(page)
      if (g.kind === 'switch') await g.group(page).click()
      await settle(page)
      const quiet = optionOf(page, g, g.other)
      await expect(quiet).toBeVisible()
      if (g.kind === 'switch') await expect(quiet).toHaveAttribute('aria-checked', 'false')
      else await expect(quiet).not.toHaveClass(/\bis-selected\b/)
      if (g.swatch) {
        await expectQuiet(quiet, g.swatch)
        await evidence(page, g, `quiet-${g.key}`, quiet)
        return
      }
      await expect(quiet).toHaveCSS('background-color', TRANSPARENT)
      await expect(quiet).toHaveCSS('color', BODY)
      await expect(quiet).toHaveCSS('font-weight', /^(400|500)$/)
      await expect(quiet).toHaveCSS('box-shadow', 'none')
      await evidence(page, g, `quiet-${g.key}`, quiet)
    })

    test(`selection follows the click: ${g.key}`, async ({ page }) => {
      await g.open(page)
      await settle(page)
      if (g.kind === 'switch') {
        const sw = g.group(page)
        await expect(sw).toHaveAttribute('role', 'switch')
        await expect(sw).toHaveAttribute('aria-checked', 'true')
        await expectSelected(sw)
        await sw.click()
        await settle(page)
        await expect(sw).toHaveAttribute('aria-checked', 'false')
        await expectQuiet(sw)
        await evidence(page, g, `follows-off-${g.key}`, sw)
        await sw.click()
        await settle(page)
        await expect(sw).toHaveAttribute('aria-checked', 'true')
        await expectSelected(sw)
        await evidence(page, g, `follows-${g.key}`, sw)
        return
      }
      const first = optionOf(page, g, g.selected)
      const second = optionOf(page, g, g.other)
      if (g.multi === 'toggle') {
        // Multi-select: every click is checked on its own, and the one-selected rule does not apply.
        const initial = await pressedStates(itemsOf(page, g))
        expect(initial.length, `${g.key} has controls`).toBeGreaterThan(1)
        expect(initial.every((s) => s.endsWith('=true') || s.endsWith('=false')), `every control carries aria-pressed (${JSON.stringify(initial)})`).toBe(true)
        await expect(first).toHaveAttribute('aria-pressed', 'true')
        await expect(second).toHaveAttribute('aria-pressed', 'false')
        const firstText = (await first.textContent())?.trim()
        const secondText = (await second.textContent())?.trim()
        // Clicking an unselected option selects it; the option already selected stays selected.
        await choose(page, g, g.other)
        await expect(second).toHaveAttribute('aria-pressed', 'true')
        await expectSelected(second)
        await expect(first).toHaveAttribute('aria-pressed', 'true')
        await expectSelected(first)
        expect(await pressedStates(itemsOf(page, g))).toEqual(initial.map((s) => (s === `${secondText}=false` ? `${secondText}=true` : s)).sort())
        await evidence(page, g, `follows-add-${g.key}`, second)
        // Clicking a selected option unselects it; the others keep their state.
        await choose(page, g, g.selected)
        await expect(first).toHaveAttribute('aria-pressed', 'false')
        await expectQuiet(first)
        await expect(second).toHaveAttribute('aria-pressed', 'true')
        await expectSelected(second)
        expect(await pressedStates(itemsOf(page, g))).toEqual(
          initial.map((s) => (s === `${secondText}=false` ? `${secondText}=true` : s === `${firstText}=true` ? `${firstText}=false` : s)).sort(),
        )
        await evidence(page, g, `follows-${g.key}`, second)
        return
      }
      await expectAriaChoice(page, g, g.selected)
      await expect(itemsOf(page, g).and(page.locator('.is-selected'))).toHaveCount(1)
      await choose(page, g, g.other)
      await expectAriaChoice(page, g, g.other)
      await expect(itemsOf(page, g).and(page.locator('.is-selected'))).toHaveCount(1)
      await expectSelected(second, g.swatch)
      await expectQuiet(first, g.swatch)
      await evidence(page, g, `follows-${g.key}`, second)
    })

    test(`selection preserves existing application behaviour: ${g.key}`, async ({ page }) => {
      const seen = recordRequests(page)
      const api = await g.open(page)
      await settle(page)
      if (g.kind === 'switch') await seedAccount(page)
      await g.before(page, seen)
      const watched = await watchUnrelated(itemsOf(page, g))
      if (g.disabled) {
        const off = optionOf(page, g, g.disabled)
        await expect(off).toBeDisabled()
        const calls = seen.length
        // A click event sent to the option itself: on the phone the filters end under the fixed bottom bar, where a
        // pointer click would land on the bar instead.
        await off.dispatchEvent('click')
        await settle(page)
        await expect(off).toHaveAttribute('aria-pressed', 'true')
        expect(seen.length, 'a disabled option asks for nothing').toBe(calls)
        await g.before(page, seen)
      }
      if (g.kind === 'switch') {
        const sw = g.group(page)
        await expectAccountSeeded(page)
        // Off: the label reads Inactive and every other field keeps its value.
        await sw.click()
        await settle(page)
        await expect(sw).toHaveAttribute('aria-checked', 'false')
        await g.after(page, seen)
        await expectAccountSeeded(page)
        // On again: the same.
        await sw.click()
        await settle(page)
        await expect(sw).toHaveAttribute('aria-checked', 'true')
        await expectAccountSeeded(page)
        // Off, then created: saved inactive with every seeded field, and answered inactive.
        await sw.click()
        await settle(page)
        await expect(sw).toHaveAttribute('aria-checked', 'false')
        await expectAccountSeeded(page)
        const unrelated = await compareUnrelated(page, watched)
        expect(unrelated.changed, `other selections keep their values (${watched.length} watched)`).toEqual([])
        expect(unrelated.gone, `no other selection leaves the page (${watched.length} watched)`).toEqual([])
        const inactive = accountCreated(page)
        await page.getByRole('button', { name: 'Create Account', exact: true }).click()
        expect(((await (await inactive).json()) as Account).is_active).toBe(false)
        expect(api.bodies('POST', '/accounts/')[0]).toMatchObject({ ...newAccountInput, is_active: false })
        // On (the dialog's default), then created: saved active and answered active.
        await page.getByRole('button', { name: 'Add Account', exact: true }).click()
        await expect(page.getByRole('switch', { name: 'Active' })).toHaveAttribute('aria-checked', 'true')
        await seedAccount(page)
        await expectAccountSeeded(page)
        const active = accountCreated(page)
        await page.getByRole('button', { name: 'Create Account', exact: true }).click()
        expect(((await (await active).json()) as Account).is_active).toBe(true)
        expect(api.bodies('POST', '/accounts/')[1]).toMatchObject({ ...newAccountInput, is_active: true })
        await evidence(page, g, `behaviour-${g.key}`)
        return
      }
      await choose(page, g, g.other)
      await g.after(page, seen)
      const unrelated = await compareUnrelated(page, watched)
      expect(unrelated.changed, `other selections on the page keep their values (${watched.length} watched)`).toEqual([])
      // Only the controls the inventory says the pick removes may leave, and each of them must be gone.
      expect(unrelated.gone, `controls that leave the page (${watched.length} watched)${g.gone ? `: ${g.gone.why}` : ''}`).toEqual(g.gone?.controls ?? [])
      if (g.gone) await g.gone.check(page)
      await evidence(page, g, `behaviour-${g.key}`)
      if (g.submit) await g.submit(page, api)
    })
  }

  const themes = [
    { theme: 'light', primary: ACCENT, ink: INK },
    { theme: 'dark', primary: DARK_PRIMARY, ink: DARK_INK },
  ] as const
  for (const { theme, primary, ink } of themes) {
    test(`selected never looks like the primary: transactions To date vs Add Transaction (${theme})`, async ({ page }) => {
      await page.addInitScript((t) => window.localStorage.setItem('studiosc-theme', t), theme)
      await openPage(page, '/transactions', 'Transactions')
      await expect(page.locator('html')).toHaveAttribute('data-theme', theme)
      await settle(page)
      const add = page.getByRole('button', { name: 'Add Transaction', exact: true }).first()
      await expect(add).toHaveCSS('background-color', primary)
      const toDate = page.getByTestId('view-to-date')
      await expect(toDate).toHaveAttribute('aria-pressed', 'true')
      const toDateBg = await toDate.evaluate((e) => getComputedStyle(e).backgroundColor)
      expect(toDateBg, 'To date is not the primary fill').not.toBe(await add.evaluate((e) => getComputedStyle(e).backgroundColor))
      expect(toDateBg).not.toBe(primary)
      await shot(page, `primary-transactions-${theme}`)
    })

    for (const g of INVENTORY) {
      test(`selected never looks like the primary: ${g.key} (${theme})`, async ({ page }) => {
        await page.addInitScript((t) => window.localStorage.setItem('studiosc-theme', t), theme)
        await g.open(page)
        await expect(page.locator('html')).toHaveAttribute('data-theme', theme)
        await settle(page)
        // Every chosen control on the page, and the group's own (a pager's current page is marked by aria-current).
        const chosen = page.locator('[aria-pressed="true"], [role="tab"][aria-selected="true"], [role="switch"][aria-checked="true"]').or(optionOf(page, g, g.selected))
        await expect(optionOf(page, g, g.selected)).toBeVisible()
        const fills = await chosen.evaluateAll((els) => els.map((e) => `${e.textContent?.trim().slice(0, 30)}: ${getComputedStyle(e).backgroundColor}`))
        expect(fills.length, 'chosen controls on the page').toBeGreaterThan(0)
        expect(fills.filter((f) => f.endsWith(`: ${primary}`) || f.endsWith(`: ${ink}`)), `no chosen control is filled with the primary (${primary}) or ink (${ink})`).toEqual([])
        await evidence(page, g, `primary-${g.key}-${theme}`, optionOf(page, g, g.selected))
      })
    }
  }

  test('due tabs keep their keyboard behaviour', async ({ page }) => {
    await openPage(page, '/transactions', 'Transactions')
    const tabs = page.getByRole('tablist').filter({ has: page.getByTestId('due-tab-due') }).getByRole('tab')
    await expect(tabs).toHaveCount(5)
    const chosen = () => tabs.evaluateAll((els) => els.map((e) => `${e.getAttribute('role')}:${e.getAttribute('aria-selected')}:${e.getAttribute('tabindex')}`))
    expect(await chosen()).toEqual(['tab:true:0', 'tab:false:-1', 'tab:false:-1', 'tab:false:-1', 'tab:false:-1'])
    await tabs.nth(0).focus()
    await page.keyboard.press('ArrowRight')
    await expect(tabs.nth(1)).toHaveAttribute('aria-selected', 'true')
    await expect(tabs.nth(1)).toBeFocused()
    expect(await chosen()).toEqual(['tab:false:-1', 'tab:true:0', 'tab:false:-1', 'tab:false:-1', 'tab:false:-1'])
    await page.keyboard.press('End')
    await expect(tabs.nth(4)).toHaveAttribute('aria-selected', 'true')
    await expect(tabs.nth(4)).toBeFocused()
    expect(await chosen()).toEqual(['tab:false:-1', 'tab:false:-1', 'tab:false:-1', 'tab:false:-1', 'tab:true:0'])
    await page.keyboard.press('Home')
    await expect(tabs.nth(0)).toHaveAttribute('aria-selected', 'true')
    await expect(tabs.nth(0)).toBeFocused()
    expect(await chosen()).toEqual(['tab:true:0', 'tab:false:-1', 'tab:false:-1', 'tab:false:-1', 'tab:false:-1'])
    await shot(page, 'due-tabs-keyboard')
  })

  test('selection is a component, not a selector shim', async ({ page }) => {
    await openPage(page, '/transactions', 'Transactions')
    const selectors = await page.evaluate(() => {
      const out: string[] = []
      const walk = (list: CSSRuleList) => {
        for (const rule of Array.from(list)) {
          if (rule instanceof CSSStyleRule) out.push(rule.selectorText)
          if ('cssRules' in rule) walk((rule as CSSGroupingRule).cssRules)
        }
      }
      for (const sheet of Array.from(document.styleSheets)) {
        if (sheet.href && new URL(sheet.href).origin !== location.origin) continue
        walk(sheet.cssRules)
      }
      return out
    })
    expect(selectors.length, 'stylesheet rules were read').toBeGreaterThan(100)
    const norm = (s: string): string => s.replace(/["']/g, '').replace(/\s+/g, ' ')
    const aria = selectors.map(norm).filter((s) => /\[aria-pressed=true\]|\[role=tab\]\[aria-selected=true\]|\[aria-current=page\]/.test(s))
    expect(aria, 'no stylesheet rule keys on aria-pressed, a selected tab or aria-current').toEqual([])
    expect(selectors.some((s) => s.includes('.seg.is-selected')), 'the selection rule is a class').toBe(true)

    // Every source file under frontend/src: no `bg-ink text-paper` in a conditional, and the ARIA selection markup
    // lives in the two shared components only.
    const listed = spawnSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '--', 'src'], { cwd: FRONTEND, encoding: 'utf8' })
    expect(listed.status, listed.stderr).toBe(0)
    const files = listed.stdout.split('\n').filter((f) => /\.(tsx?|css)$/.test(f))
    const conditional = /(\?|:|&&|\|\|)\s*[`'"][^`'"]*\bbg-ink text-paper\b/
    const hits: string[] = []
    const ariaSites: string[] = []
    for (const file of files) {
      const rel = file.replace(/^src\//, '')
      fs.readFileSync(path.join(FRONTEND, file), 'utf8')
        .split('\n')
        .forEach((line, i) => {
          if (conditional.test(line)) hits.push(`${rel}:${i + 1}`)
          if (/aria-pressed=|role="tab"/.test(line) && !/^\s*(\*|\/\/)/.test(line)) ariaSites.push(`${rel}:${i + 1}`)
        })
    }
    expect(files.length, 'source files were read').toBeGreaterThan(50)
    expect(hits, 'bg-ink text-paper conditionals in frontend/src').toEqual([])
    expect([...new Set(ariaSites.map((s) => s.split(':')[0]))].sort(), 'aria-pressed and role="tab" are rendered by the shared components only').toEqual([
      'components/SegmentedControl.tsx',
      'components/Tabs.tsx',
    ])
    await page.setContent(`<pre style="font: 13px/1.4 monospace; padding: 16px; white-space: pre-wrap"></pre>`)
    await page.locator('pre').evaluate(
      (el, text) => (el.textContent = text),
      [
        `${selectors.length} stylesheet rules read; ARIA-keyed selection selectors: ${JSON.stringify(aria)}`,
        `${files.length} source files read; bg-ink text-paper conditionals: ${JSON.stringify(hits)}`,
        `aria-pressed / role="tab" render sites: ${JSON.stringify(ariaSites)}`,
        '',
        'Conversion inventory:',
        ...INVENTORY.map((g) => `- ${g.route} | ${g.what} | ${g.effect}`),
      ].join('\n'),
    )
    await shot(page, 'no-shim')
  })
})
