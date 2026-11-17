// STU-679: selection is not an action. Every selectable control (segments, toggle chips, tabs, the pager's current
// page and the Add Account Active switch) carries the selection rule from docs/design-system.md: a leaf background,
// ink 600 text and a 2px spine rule underneath, square, never the primary button's fill. The API is faked in the
// browser with the shared household fixture; there is no backend.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { expect, test } from '@playwright/test'
import type { Locator, Page } from '@playwright/test'
import type { Account } from '@tally-trace/shared'
import { apiRoute, mockApi } from './support/mockApi'
import type { ApiMock } from './support/mockApi'
import { shot } from './support/shot'
import {
  household,
  householdViewRoutes,
  mockHousehold,
  withDollarTimeline,
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
/** How a group marks its choice: `aria-pressed`, a tab's `aria-selected`, the pager's `aria-current`, a switch. */
type Kind = 'pressed' | 'tab' | 'current' | 'switch'

/** One inventoried group: where it lives, how to show it, the choice the tests make and what that choice does. */
interface Group {
  key: string
  route: string
  /** What the group is, for the inventory. */
  what: string
  kind: Kind
  /** `toggle`: a multi-select group with no "all" chip, so a second pick adds to the first. */
  multi?: 'toggle'
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
  /** Checks the existing effect after the pick. */
  after: (page: Page, seen: URL[]) => Promise<void>
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
}

async function openPage(page: Page, route: string, heading: Name, data: HouseholdData = household, extra: Parameters<typeof mockApi>[1] = []): Promise<ApiMock> {
  const api = await mockHousehold(page, data)
  if (extra.length) await mockApi(page, extra)
  await page.goto(route)
  await expect(page.getByRole('heading', { level: 1, name: heading })).toBeVisible()
  await page.waitForLoadState('networkidle')
  return api
}

async function openFilters(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Show filters' }).click()
  await expect(page.getByRole('group', { name: 'Entered by' })).toBeVisible()
}

const dialogOf = (page: Page): Locator => page.locator('.fixed.inset-0.overflow-y-auto').last()

async function openTransactionDialog(page: Page): Promise<ApiMock> {
  const api = await openPage(page, '/transactions', 'Transactions')
  await page.getByRole('button', { name: 'Add Transaction', exact: true }).first().click()
  await expect(page.getByRole('heading', { name: 'Create Transaction' })).toBeVisible()
  return api
}

/** Picks an account in the transaction dialog's compact account field, which then folds to one line. */
async function pickAccount(page: Page, name: string): Promise<void> {
  await dialogOf(page).getByRole('group', { name: 'Account' }).getByRole('button', { name: new RegExp(`^${name}`) }).click()
  await expect(dialogOf(page).getByRole('button', { name: /^Change Account/ })).toBeVisible()
}

async function openAllocations(page: Page): Promise<ApiMock> {
  return openPage(page, '/allocations', 'Allocations')
}

const createdAccount: Account = {
  id: 90,
  name: 'Maya savings',
  account_type: 'checking',
  balance: 0,
  currency: 'PHP',
  is_active: true,
  tags: [],
  my_role: 'owner',
  is_shared: false,
  owner_id: 1,
  owner_name: 'Mara S.',
  permissions: { can_edit_settings: true, can_manage_shares: true, can_add_transactions: true, can_delete: true, can_view_details: true },
  created_at: '2026-03-12T02:00:00',
}

async function openAccountDialog(page: Page): Promise<ApiMock> {
  const api = await openPage(page, '/accounts', 'Accounts', household, [apiRoute<Account>('POST', '/accounts/', createdAccount, 201)])
  await page.getByRole('button', { name: 'Add Account', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Create Account' })).toBeVisible()
  return api
}

const visibleText = (page: Page, text: string): Locator => page.getByText(text, { exact: true }).first()

/** The conversion inventory: every group Scope converts, one entry per group, with its existing effect. */
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
  },
  {
    key: 'transactions-entered-by',
    route: '/transactions',
    what: 'Filters: Entered by, Everyone / Only mine (SegmentedControl)',
    kind: 'pressed',
    open: async (page) => {
      const api = await openPage(page, '/transactions', 'Transactions')
      await openFilters(page)
      return api
    },
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
    open: async (page) => {
      const api = await openPage(page, '/transactions', 'Transactions')
      await openFilters(page)
      return api
    },
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
    what: 'Filters: Accounts chips, All accounts / each account (GroupedPicker chips, Segment)',
    kind: 'pressed',
    open: async (page) => {
      const api = await openPage(page, '/transactions', 'Transactions')
      await openFilters(page)
      return api
    },
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
    key: 'transactions-list-pager',
    route: '/transactions',
    what: "Month list pager's current page (aria-current, selection class)",
    kind: 'current',
    open: async (page) => {
      const api = await openPage(page, '/transactions', 'Transactions')
      await openFilters(page)
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
  {
    key: 'due-pager',
    route: '/transactions',
    what: "Due card Upcoming pager's current page (Pager.tsx, aria-current)",
    kind: 'current',
    open: async (page) => {
      const api = await openPage(page, '/transactions', 'Transactions')
      await page.getByTestId('due-tab-upcoming').click()
      await expect(page.getByTestId('due-pager').filter({ visible: true })).toBeVisible()
      return api
    },
    group: (page) => page.getByTestId('due-pager').filter({ visible: true }),
    items: (page) => page.getByTestId('due-pager').filter({ visible: true }).getByRole('button', { name: /^\d+$/ }),
    selected: '1',
    other: '2',
    effect: 'Page 2 lists the 4th to 6th upcoming occurrences (Globe Postpaid, 18 March, first)',
    before: async (page) => {
      await expect(page.getByTestId('due-panel-upcoming').getByText('Globe Postpaid')).toHaveCount(0)
    },
    after: async (page) => {
      await expect(page.getByTestId('due-panel-upcoming').getByText('Globe Postpaid').first()).toBeVisible()
      await expect(page.getByTestId('due-pager').filter({ visible: true })).toContainText('4–6 of 16')
    },
  },
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
    what: 'Add Transaction: Account rows (GroupedPicker compact rows, Segment)',
    kind: 'pressed',
    dialog: true,
    open: async (page) => {
      const api = await openTransactionDialog(page)
      await pickAccount(page, 'BPI Payroll')
      await dialogOf(page).getByRole('button', { name: /^Change Account/ }).click()
      return api
    },
    group: (page) => dialogOf(page).getByRole('group', { name: 'Account' }),
    items: (page) => dialogOf(page).locator('[data-field="account_id"] [data-picker-option]'),
    selected: /^BPI Payroll/,
    other: /^HSBC Red Mastercard/,
    reopen: async (page) => {
      await dialogOf(page).getByRole('button', { name: /^Change Account/ }).click()
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
    open: async (page) => {
      const api = await openAllocations(page)
      await page.getByRole('button', { name: 'Budgets', exact: true }).click()
      await page.getByRole('button', { name: 'Add Allocation', exact: true }).click()
      await expect(page.getByRole('heading', { name: 'Create Budget Envelope' })).toBeVisible()
      return api
    },
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
    key: 'recurring-entry-type',
    route: '/allocations (Add Recurring Entry)',
    what: 'Add Recurring Entry: Entry type, Expense / Income (SegmentedControl)',
    kind: 'pressed',
    dialog: true,
    open: async (page) => {
      const api = await openAllocations(page)
      await page.getByRole('button', { name: 'Add Recurring Entry', exact: true }).click()
      await expect(page.getByRole('heading', { name: 'Add Recurring Entry' })).toBeVisible()
      return api
    },
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
    what: 'Add Recurring Entry: Ends, Keep running / On date / After runs (SegmentedControl; the same component is Repeat on Add Transaction)',
    kind: 'pressed',
    dialog: true,
    open: async (page) => {
      const api = await openAllocations(page)
      await page.getByRole('button', { name: 'Add Recurring Entry', exact: true }).click()
      await expect(page.getByRole('heading', { name: 'Add Recurring Entry' })).toBeVisible()
      return api
    },
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
    key: 'tag-picker',
    route: '/accounts (Add Account)',
    what: 'Tags (TagPicker, Segment toggles; the same component is on Add Transaction and Add Recurring Entry)',
    kind: 'pressed',
    multi: 'toggle',
    dialog: true,
    open: async (page) => {
      const api = await openAccountDialog(page)
      await page.getByRole('group', { name: 'Tags' }).getByRole('button', { name: 'Household' }).click()
      return api
    },
    group: (page) => page.getByRole('group', { name: 'Tags' }),
    selected: 'Household',
    other: 'Japan trip',
    effect: 'Household on an account shows the Household notice; with Japan trip alone the notice goes',
    before: async (page) => {
      await expect(page.getByTestId('household-account-notice')).toBeVisible()
    },
    after: async (page) => {
      await expect(page.getByTestId('household-account-notice')).toHaveCount(0)
    },
  },
  {
    key: 'account-active-switch',
    route: '/accounts (Add Account)',
    what: 'Add Account: Active (role=switch, aria-checked; selected treatment when on)',
    kind: 'switch',
    dialog: true,
    open: openAccountDialog,
    group: (page) => page.getByRole('switch', { name: 'Active' }),
    selected: 'Active',
    other: 'Active',
    effect: 'Off reads "Inactive" and the new account is created with is_active false; on creates it with is_active true',
    before: async (page) => {
      await expect(dialogOf(page).getByText('Active', { exact: true })).toBeVisible()
    },
    after: async (page) => {
      await expect(dialogOf(page).getByText('Inactive', { exact: true })).toBeVisible()
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
    what: 'Currency (CurrencyControl, SegmentedControl; the same component is on the dashboard and the spending breakdown)',
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
]

/** Light-theme computed styles a selected control must have. */
async function expectSelected(el: Locator): Promise<void> {
  await expect(el).toHaveCSS('background-color', LEAF)
  await expect(el).toHaveCSS('color', INK)
  await expect(el).toHaveCSS('font-weight', '600')
  await expect(el).toHaveCSS('box-shadow', SPINE_RULE)
  for (const corner of ['top-left', 'top-right', 'bottom-right', 'bottom-left']) {
    await expect(el).toHaveCSS(`border-${corner}-radius`, '0px')
  }
}

/** Light-theme computed styles an unselected control must have. */
async function expectQuiet(el: Locator): Promise<void> {
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

/** Asserts the group's ARIA marks exactly `name` as chosen. */
async function expectAriaChoice(page: Page, g: Group, name: Name): Promise<void> {
  const items = itemsOf(page, g)
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

/** Marks every selectable control outside the group and records its state, so a pick can be checked against them. */
const watchUnrelated = (groupItems: Locator): Promise<number> =>
  groupItems.evaluateAll((own) => {
    const mine = new Set<Element>(own)
    const all = [...document.querySelectorAll('[aria-pressed], [role="tab"], [role="switch"]')].filter((e) => !mine.has(e))
    all.forEach((e, i) => {
      e.setAttribute('data-e2e-watch', String(i))
      e.setAttribute('data-e2e-was', e.getAttribute('aria-pressed') ?? e.getAttribute('aria-selected') ?? e.getAttribute('aria-checked') ?? '')
    })
    return all.length
  })
const changedUnrelated = (page: Page): Promise<string[]> =>
  page.evaluate(() =>
    [...document.querySelectorAll('[data-e2e-watch]')]
      .filter((e) => (e.getAttribute('aria-pressed') ?? e.getAttribute('aria-selected') ?? e.getAttribute('aria-checked') ?? '') !== e.getAttribute('data-e2e-was'))
      .map((e) => `${e.textContent?.trim()}: ${e.getAttribute('data-e2e-was')}`),
  )

test.describe('Selection is not an action (STU-679)', () => {
  for (const g of INVENTORY) {
    test(`selected controls use the spine rule: ${g.key}`, async ({ page }) => {
      await g.open(page)
      await settle(page)
      const selected = optionOf(page, g, g.selected)
      await expect(selected).toBeVisible()
      if (g.kind === 'switch') await expect(selected).toHaveAttribute('aria-checked', 'true')
      await expectSelected(selected)
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
      await expectQuiet(quiet)
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
      await expectAriaChoice(page, g, g.selected)
      await expect(itemsOf(page, g).and(page.locator('.is-selected'))).toHaveCount(1)
      await choose(page, g, g.other)
      // A multi-select toggle group keeps the first pick until it is pressed again.
      if (g.multi === 'toggle') await choose(page, g, g.selected)
      await expectAriaChoice(page, g, g.other)
      await expect(itemsOf(page, g).and(page.locator('.is-selected'))).toHaveCount(1)
      await expectSelected(optionOf(page, g, g.other))
      await expectQuiet(optionOf(page, g, g.selected))
      await evidence(page, g, `follows-${g.key}`, optionOf(page, g, g.other))
    })

    test(`selection preserves existing application behaviour: ${g.key}`, async ({ page }) => {
      const seen = recordRequests(page)
      const api = await g.open(page)
      await settle(page)
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
        await g.group(page).click()
        await settle(page)
        await g.after(page, seen)
        // Off, then created: the account is saved inactive.
        await dialogOf(page).getByPlaceholder('Enter account name').fill('Maya savings')
        await page.getByRole('button', { name: 'Create Account', exact: true }).click()
        await expect.poll(() => api.bodies('POST', '/accounts/').length).toBe(1)
        expect((api.bodies('POST', '/accounts/')[0] as { is_active?: boolean }).is_active).toBe(false)
        // On (the dialog's default), then created: saved active.
        await page.getByRole('button', { name: 'Add Account', exact: true }).click()
        await expect(page.getByRole('switch', { name: 'Active' })).toHaveAttribute('aria-checked', 'true')
        await dialogOf(page).getByPlaceholder('Enter account name').fill('Maya savings')
        await page.getByRole('button', { name: 'Create Account', exact: true }).click()
        await expect.poll(() => api.bodies('POST', '/accounts/').length).toBe(2)
        expect((api.bodies('POST', '/accounts/')[1] as { is_active?: boolean }).is_active).toBe(true)
      } else {
        await choose(page, g, g.other)
        if (g.multi === 'toggle') await choose(page, g, g.selected)
        await g.after(page, seen)
      }
      expect(await changedUnrelated(page), `other selections on the page keep their values (${watched} watched)`).toEqual([])
      await evidence(page, g, `behaviour-${g.key}`)
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
        const chosen = page.locator('[aria-pressed="true"], [role="tab"][aria-selected="true"], [role="switch"][aria-checked="true"]')
        await expect(chosen.first()).toBeAttached()
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
    expect(ariaSites.map((s) => s.split(':')[0]).sort(), 'aria-pressed and role="tab" are rendered by the shared components only').toEqual([
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
