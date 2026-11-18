// STU-678: one Button component. Every action is a `Button` (or a link styled with `buttonClass`) in one of four
// variants from docs/design-system.md: primary (the spine fill), secondary (a line-strong outline), quiet (text only)
// and danger (the red-pencil outline). Row actions are secondary or quiet, no hand-rolled fill remains, and the
// migration keeps every control's label, icons, height and behaviour. The API is faked in the browser with the shared
// household fixture; there is no backend.
//
// The layout and behaviour baseline (`button.baseline.json`) is recorded once, on the PR base, before the buttons
// change: `BUTTON_RECORD=1 pnpm exec playwright test button -g "preserves surrounding" --workers=1`. A recording run
// only writes the baseline; it asserts nothing about the buttons.
//
// STU-687 reorders the Transactions page (a collapsed Due banner, one filter toolbar), so the entries for the surfaces
// on /transactions were re-recorded at that change: only the page's visible button list and text moved; every
// recorded request, dialog and row effect stayed the same.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test } from '@playwright/test'
import type { Locator, Page, Request } from '@playwright/test'
import type { Account, Category, QuickBalances, Tag, WishlistItem } from '@tally-trace/shared'
import { addRoutes, apiRoute, mockApi } from './support/mockApi'
import type { ApiMock, ApiRoute } from './support/mockApi'
import { shot } from './support/shot'
import { expandDue } from './support/transactions'
import {
  accountSharesRoute,
  createAccountRoute,
  createdAccount,
  household,
  householdCreateRoutes,
  householdDialogRoutes,
  householdRoutes,
  householdSaveRoutes,
  householdWishlist,
  householdWishlistRoutes,
  installmentReviewRoutes,
  mockHousehold,
  newAccountInput,
  savedAllocation,
  savedEntry,
  savedTransaction,
  sharedWithMatch,
  withInstallmentReview,
} from './support/fixtures/household'
import type { HouseholdData } from './support/fixtures/household'

// This spec lives in <repo>/frontend/e2e.
const FRONTEND = fileURLToPath(new URL('..', import.meta.url))
const SRC = path.join(FRONTEND, 'src')
const BASELINE = fileURLToPath(new URL('./button.baseline.json', import.meta.url))
const RECORD = process.env.BUTTON_RECORD === '1'

// The baseline holds clock-derived values, such as a new recurring entry's default start (a `datetime-local` field),
// so every page runs in the time zone the baseline was recorded in, whatever the host's own zone is.
test.use({ timezoneId: 'Asia/Manila' })

/** docs/design-system.md, light: spine `accent` #22483A, leaf `on-accent` #F2F5F0, `line-strong` #748870, `ink` #16241C, red pencil `danger` #AE2A20. */
const ACCENT = 'rgb(34, 72, 58)'
const ON_ACCENT = 'rgb(242, 245, 240)'
const LINE_STRONG = 'rgb(116, 136, 112)'
const INK = 'rgb(22, 36, 28)'
const DANGER = 'rgb(174, 42, 32)'
/** The old green action fill (`ok`, #2A6440) that AC2 bans on actions. */
const OLD_GREEN = 'rgb(42, 100, 64)'
const TRANSPARENT = 'rgba(0, 0, 0, 0)'
/** The page-header primary's desktop limit (AC6): at most 260px wide. */
const HEADER_MAX_PX = 260

/** Selection controls, owned by STU-679: AC2 skips them and AC6 checks they are untouched. */
const SELECTION = '[role="tab"], [aria-pressed], [aria-current], [role="switch"]'
/**
 * Every open dialog: the page modals (the shared `fixed inset-0 overflow-y-auto` overlay) and the component dialogs'
 * panels inside theirs. The last one in the document is on top.
 */
const DIALOG = '.fixed.inset-0.overflow-y-auto, [role="dialog"], [role="alertdialog"]'

/** A viewport screenshot (a full-page one draws a fixed layer at the scroll offset), saved like `shot()`. */
async function viewportShot(page: Page, name: string): Promise<string> {
  const info = test.info()
  const spec = path.basename(info.file).replace(/\.spec\.ts$/, '')
  const file = path.join(info.project.outputDir, 'screens', `${spec}-${name}-${info.project.name}.png`)
  await page.screenshot({ path: file, animations: 'disabled' })
  return file
}

/** Waits for transitions to finish, so a colour is read at rest rather than mid-change. */
const transitionsDone = (page: Page): Promise<unknown> =>
  page.evaluate(() => Promise.allSettled(document.getAnimations().filter((a) => a instanceof CSSTransition).map((a) => a.finished)))

async function settle(page: Page): Promise<void> {
  await page.waitForLoadState('networkidle')
  // A pointer left on a control would show its hover colour; park it in the corner.
  await page.mouse.move(0, 0)
  await transitionsDone(page)
}

const style = (el: Locator, prop: string): Promise<string> => el.evaluate((e, p) => getComputedStyle(e).getPropertyValue(p), prop)

/** The one transaction the action dialog tests open: a posted GCash ride. */
const ROW_TRANSACTION = 'Grab to Makati'
const rowTransactionId = (): number => {
  const t = household.transactions.find((x) => x.view !== 'limited' && x.description === ROW_TRANSACTION)
  if (!t) throw new Error(`no "${ROW_TRANSACTION}" in the fixture`)
  return t.id
}

/** Extra routes the dialogs' lookups and saves need, answered with typed fixture data. */
const extraRoutes = (data: HouseholdData): ApiRoute[] => [
  ...householdCreateRoutes(data),
  ...householdDialogRoutes(data),
  ...householdSaveRoutes(data),
  ...householdWishlistRoutes(),
  ...installmentReviewRoutes(),
  // The in-app Confirm's Delete sends the delete.
  apiRoute<Record<string, never>>('DELETE', `/transactions/${rowTransactionId()}`, {}),
]

async function openPage(page: Page, route: string, heading: string, extra: ApiRoute[] = [], data: HouseholdData = household): Promise<ApiMock> {
  const api = await mockHousehold(page, data)
  await mockApi(page, [...extraRoutes(data), ...extra])
  await page.goto(route)
  // The dev server compiles a route's chunk on its first visit; under a full parallel run that can pass 5s.
  await expect(page.getByRole('heading', { level: 1, name: heading })).toBeVisible({ timeout: 15_000 })
  await settle(page)
  return api
}

const dialogOf = (page: Page): Locator => page.locator(DIALOG).last()

async function openDialog(
  page: Page,
  route: string,
  heading: string,
  trigger: (page: Page) => Locator | Promise<Locator>,
  title: string | RegExp,
  extra: ApiRoute[] = [],
): Promise<ApiMock> {
  const api = await openPage(page, route, heading, extra)
  // Tracked from before the click, so a lookup the dialog starts as it opens is counted until it finishes.
  const requests = trackRequests(page)
  try {
    await (await trigger(page)).click()
    await expect(dialogOf(page).getByRole('heading', { name: title }).first()).toBeVisible()
    await untilStill(page, requests)
  } finally {
    requests.stop()
  }
  return api
}

const transactionRow = (page: Page, description: string): Locator => page.locator('article[data-transaction-id]').filter({ hasText: description }).first()

/** The account Add Account saves in the native-semantics tests, answered by the fixture's create route. */
const createdAccounts: Account[] = [createdAccount(household, 90, { ...newAccountInput, tag_ids: [...newAccountInput.tag_ids] })]

/** One place the tests look at: a page, or a dialog opened from one. */
interface Surface {
  key: string
  dialog: boolean
  open: (page: Page) => Promise<ApiMock>
  /**
   * The migrated controls (`[data-variant]`) the surface shows, by accessible name in document order. A name is
   * never shared with an unmigrated control on the same surface, so the nth entry with a name is the nth control
   * with that name.
   */
  migrated: string[]
  /**
   * Fills the surface's form so the named control submits a valid one: AC6 then compares a real save (its request,
   * arguments and result) rather than the form's validation.
   */
  fill?: Record<string, (page: Page) => Promise<void>>
  /** For a seeded save that adds or changes a list row: what the lists read once it lands, and that row. */
  saved?: Record<string, Saved>
}

/**
 * A save's resulting row. `routes` replace the list reads just before the click, so the refetch the save triggers
 * returns the saved record; `row` finds the rows it shows, and AC6 compares their text with the base's.
 */
interface Saved {
  routes: ApiRoute[]
  row: (page: Page) => Locator
}

/** Picks an account in a form's account picker, opening the folded field first when it is folded. */
async function pickAccount(page: Page, name: string): Promise<void> {
  const field = dialogOf(page).locator('[data-field="account_id"]')
  const chip = field.getByRole('button', { name: new RegExp(`^${name}`) })
  const change = field.locator('[data-picker-change][aria-expanded="false"]')
  await chip.or(change).first().waitFor()
  if ((await chip.count()) === 0) await change.click()
  await chip.first().click()
  await expect(field.locator('[data-picker-value]')).toContainText(name)
}

/** Valid forms for the saves AC6 clicks: each fills only what its form requires. */
const fillTransaction = async (page: Page): Promise<void> => {
  await dialogOf(page).getByPlaceholder('Add notes about this transaction').fill('Button check')
  await pickAccount(page, 'BPI Payroll')
  await dialogOf(page).locator('input[type="number"][placeholder="0.00"]').first().fill('120')
}
const fillInstallment = async (page: Page): Promise<void> => {
  await dialogOf(page).getByPlaceholder('Add notes about this transaction').fill('Button check laptop')
  // An installment asks for the purchase total, split over the months picked.
  await dialogOf(page).getByRole('textbox', { name: 'Purchase total' }).fill('12000')
}
const fillRecurring = async (page: Page): Promise<void> => {
  await dialogOf(page).locator('input[type="text"]').first().fill('Water delivery')
  await dialogOf(page).locator('select').first().selectOption('11')
  await dialogOf(page).locator('input[type="number"]').first().fill('350')
}
const fillAllocation = async (page: Page): Promise<void> => {
  await dialogOf(page).locator('input[type="text"]').first().fill('Pet care')
  await dialogOf(page).locator('select').first().selectOption('11')
  // A budget envelope tracks at least one category.
  await dialogOf(page).getByRole('button', { name: 'Dining out', exact: true }).click()
  // The empty amounts: a budget's spending limit, a savings tracker's target.
  for (const amount of await dialogOf(page).locator('input[type="number"]').all()) {
    if ((await amount.inputValue()) === '') await amount.fill('3000')
  }
}
const fillName = async (page: Page): Promise<void> => {
  await dialogOf(page).locator('input[type="text"], input:not([type])').first().fill('Pet care')
}
const fillWishlist = async (page: Page): Promise<void> => {
  await dialogOf(page).getByPlaceholder('What are you saving for?').fill('Standing desk')
  await dialogOf(page).locator('input[type="number"]').first().fill('12000')
}
const fillShare = async (page: Page): Promise<void> => {
  await page.getByTestId('share-email').fill('lia@example.com')
}
const fillHouseholdShare = async (page: Page): Promise<void> => {
  await page.getByTestId('household-share-email').fill('lia@example.com')
}

const fillAccount = async (page: Page): Promise<void> => {
  await dialogOf(page).getByPlaceholder('Enter account name').fill(newAccountInput.name)
}

/** The rows (list items, table rows and cards) that show `text`. */
const rowsWith = (page: Page, text: string): Locator => page.locator('li, tr, article').filter({ hasText: text })

const accountNamed = (name: string): Account => {
  const account = household.accounts.find((a) => a.name === name)
  if (!account) throw new Error(`the fixture has no ${name}`)
  return account
}
const PAYROLL = accountNamed('BPI Payroll')
const CARD = accountNamed('HSBC Red Mastercard')
const DINING_OUT = household.categories.find((c) => c.name === 'Dining out')?.id ?? 0
/** The category Settings lists first, whose Edit opens the category Update, and the tag whose Edit opens the tag Update. */
const FIRST_CATEGORY = household.categories[0]
const TRIP_TAG = 'Japan trip'
/** The name every seeded category, tag and allocation save sends. */
const SAVED_NAME = 'Pet care'

/** What the seeded saves leave in their lists: each list re-read with the saved record, and that record's row. */
const savedRow = (data: HouseholdData, text: string): Saved => ({ routes: householdRoutes(data), row: (p) => rowsWith(p, text) })
const SAVED_TRANSACTION = savedRow({ ...household, transactions: [savedTransaction(household, 990, 'Button check', 120, PAYROLL.id), ...household.transactions] }, 'Button check')
const SAVED_INSTALLMENT = savedRow(
  { ...household, transactions: [savedTransaction(household, 991, 'Button check laptop', 2000, CARD.id), ...household.transactions] },
  'Button check laptop',
)
const SAVED_ENTRY = savedRow({ ...household, entries: [...household.entries, savedEntry(household, 990, 'Water delivery', 350, PAYROLL.id)] }, 'Water delivery')
const SAVED_ALLOCATION = savedRow(
  {
    ...household,
    allocations: [
      ...household.allocations,
      savedAllocation({
        id: 69,
        name: SAVED_NAME,
        allocation_type: 'budget',
        account_id: PAYROLL.id,
        current_amount: 0,
        target_amount: 3000,
        period_frequency: 'monthly',
        period_start: '2026-03-01',
        period_end: '2026-04-01',
        configuration: { category_ids: [DINING_OUT] },
      }),
    ],
  },
  SAVED_NAME,
)
const newCategory: Category = { id: 90, name: SAVED_NAME, description: '', color: '#2563eb', is_expense: true, kind: 'expense', is_active: true, created_at: `${household.today}T09:00:00Z` }
const SAVED_CATEGORY = savedRow({ ...household, categories: [...household.categories, newCategory] }, SAVED_NAME)
const UPDATED_CATEGORY = savedRow({ ...household, categories: household.categories.map((c) => (c.id === FIRST_CATEGORY.id ? { ...c, name: SAVED_NAME } : c)) }, SAVED_NAME)
const newTag: Tag = { id: 90, name: SAVED_NAME, color: '#2563eb', is_system: false, created_at: `${household.today}T09:00:00Z` }
const SAVED_TAG = savedRow({ ...household, tags: [...household.tags, newTag] }, SAVED_NAME)
const UPDATED_TAG = savedRow({ ...household, tags: household.tags.map((t) => (t.name === TRIP_TAG ? { ...t, name: SAVED_NAME } : t)) }, SAVED_NAME)
/** The account AC6's Create Account saves: only the name is filled, so the rest is the form's defaults. */
const formAccount = createdAccount(household, 91, { name: newAccountInput.name, account_type: 'checking', balance: 0, description: '', currency: 'PHP', is_spending_wallet: false, is_active: true, tag_ids: [] })
const SAVED_ACCOUNT = savedRow({ ...household, accounts: [...household.accounts, formAccount] }, newAccountInput.name)
const newWish: WishlistItem = { id: 803, user_id: household.user.id, name: 'Standing desk', estimated_cost: 12000, currency: 'PHP', priority: 'medium', is_purchased: false, created_at: `${household.today}T09:00:00Z` }
const SAVED_WISH: Saved = { routes: householdWishlistRoutes([...householdWishlist, newWish]), row: (p) => rowsWith(p, newWish.name) }
const SAVED_SHARE: Saved = { routes: [accountSharesRoute(household, PAYROLL, [sharedWithMatch(household, PAYROLL)])], row: (p) => rowsWith(p, 'Lia M.') }

/** Quick balances Mara pinned in reverse order, so the editor offers Reset to defaults. */
const PINNED_BALANCES: QuickBalances = { ...household.quickBalances, pinned: true, tiles: [...household.quickBalances.tiles].reverse() }
const PINNED = { ...household, quickBalances: PINNED_BALANCES }
/** Reset to defaults saves no pins: the dashboard reads the default tiles again. */
const RESET_BALANCES: Saved = {
  routes: [apiRoute<QuickBalances>('PUT', '/dashboard/quick-balances', household.quickBalances), apiRoute<QuickBalances>('GET', '/dashboard/quick-balances', household.quickBalances)],
  row: (p) => p.getByTestId('quick-balance-tile'),
}

/** The categories Settings lists, each with Edit and Delete. */
const SETTINGS_CATEGORIES = household.categories.filter((c) => c.is_active)
/** The accounts the dashboard's Quick balances show, in order. */
const QUICK_BALANCES = household.quickBalances.tiles.map((t) => t.name)

/** The first budget envelope, whose panel opens the allocation actions. */
const BUDGET = household.allocations.find((a) => a.allocation_type === 'budget')?.name ?? ''

const PAGES: Surface[] = [
  { key: 'dashboard', dialog: false, open: (p) => openPage(p, '/', 'Dashboard'), migrated: ['Edit'] },
  {
    key: 'transactions',
    dialog: false,
    // STU-687: the Due card opens collapsed, so it is expanded to show its row actions; the list's controls are the
    // view switch with Spending breakdown, then one toolbar row ending in Filters.
    open: async (p) => {
      const api = await openPage(p, '/transactions', 'Transactions')
      await expandDue(p)
      return api
    },
    migrated: [
      'Add Transaction',
      'Hide due items',
      'Mark paid',
      'Change date',
      'Pay',
      'Spending breakdown',
      'View previous month',
      'View next month',
      'Filters',
      'Previous',
      'Next',
    ],
  },
  {
    key: 'allocations-recurring',
    dialog: false,
    open: async (p) => {
      const api = await openPage(p, '/allocations', 'Allocations')
      await expect(p.getByRole('button', { name: 'Recurring', exact: true })).toHaveAttribute('aria-pressed', 'true')
      return api
    },
    migrated: ['Add Recurring Entry', 'Charged', 'Posted', 'Charged', 'Posted', ...Array<string>(9).fill('Mark paid'), 'Mark received'],
  },
  { key: 'accounts', dialog: false, open: (p) => openPage(p, '/accounts', 'Accounts'), migrated: ['Add Account'] },
  {
    key: 'settings',
    dialog: false,
    open: (p) => openPage(p, '/settings', 'Settings'),
    migrated: [
      'JSON',
      'CSV (ZIP)',
      'Add category',
      ...SETTINGS_CATEGORIES.flatMap(() => ['Edit', 'Delete']),
      'Add tag',
      'Recolour tag Household',
      'Delete tag Household',
      'Edit tag Japan trip',
      'Delete tag Japan trip',
      'Look up',
    ],
    fill: { 'Look up': fillHouseholdShare },
  },
  {
    key: 'allocations-wishlist',
    dialog: false,
    open: async (p) => {
      const api = await openPage(p, '/allocations?tab=wishlist', 'Allocations')
      await expect(p.getByText(householdWishlist[0].name, { exact: true })).toBeVisible()
      await settle(p)
      return api
    },
    migrated: ['Add item', ...householdWishlist.flatMap(() => ['Savings target', 'Budget envelope', 'Mark as purchased', 'Edit', 'Delete'])],
  },
]

/** A page in a state that shows more migrated controls: the dashboard's Quick balances editor. */
const STATES: Surface[] = [
  {
    key: 'quick-balances-editor',
    dialog: false,
    open: async (p) => {
      const api = await openPage(p, '/', 'Dashboard')
      await p.getByTestId('quick-balances-edit').click()
      await expect(p.getByTestId('quick-balances-save')).toBeVisible()
      await settle(p)
      return api
    },
    migrated: ['Cancel', 'Save', ...QUICK_BALANCES.flatMap((name) => [`Move ${name} earlier`, `Move ${name} later`, `Remove ${name}`]), '+ Add account'],
  },
  {
    key: 'quick-balances-editor-pinned',
    dialog: false,
    open: async (p) => {
      const api = await openPage(p, '/', 'Dashboard', [], PINNED)
      await p.getByTestId('quick-balances-edit').click()
      await expect(p.getByTestId('quick-balances-reset')).toBeVisible()
      await settle(p)
      return api
    },
    migrated: ['Reset to defaults', 'Cancel', 'Save', ...PINNED_BALANCES.tiles.flatMap(({ name }) => [`Move ${name} earlier`, `Move ${name} later`, `Remove ${name}`]), '+ Add account'],
    saved: { 'Reset to defaults': RESET_BALANCES },
  },
]

const DIALOGS: Surface[] = [
  {
    key: 'transaction-create',
    dialog: true,
    open: (p) => openDialog(p, '/transactions', 'Transactions', (q) => q.getByRole('button', { name: 'Add Transaction', exact: true }).first(), 'Create Transaction'),
    migrated: ['Create Transaction', 'Save and add another', 'Cancel'],
    fill: { 'Create Transaction': fillTransaction, 'Save and add another': fillTransaction },
    saved: { 'Create Transaction': SAVED_TRANSACTION, 'Save and add another': SAVED_TRANSACTION },
  },
  {
    key: 'transaction-create-installment',
    dialog: true,
    open: async (p) => {
      const api = await surface('transaction-create').open(p)
      await pickAccount(p, 'HSBC Red Mastercard')
      await p.getByTestId('installment-toggle').check()
      await p.getByTestId('installment-months-6').click()
      await expect(p.getByTestId('installment-change')).toBeVisible()
      await settle(p)
      return api
    },
    migrated: ['Change', 'Create Transaction', 'Save and add another', 'Cancel'],
    fill: { 'Create Transaction': fillInstallment, 'Save and add another': fillInstallment },
    saved: { 'Create Transaction': SAVED_INSTALLMENT, 'Save and add another': SAVED_INSTALLMENT },
  },
  {
    key: 'transaction-actions',
    dialog: true,
    open: (p) => openDialog(p, '/transactions', 'Transactions', (q) => transactionRow(q, ROW_TRANSACTION), 'Transaction Actions'),
    migrated: ['Upload receipt', 'Mark as not posted', 'Edit Transaction', 'Delete Transaction'],
  },
  {
    key: 'transaction-delete-confirm',
    dialog: true,
    open: async (p) => {
      const api = await openDialog(p, '/transactions', 'Transactions', (q) => transactionRow(q, ROW_TRANSACTION), 'Transaction Actions')
      await dialogOf(p).getByRole('button', { name: 'Delete Transaction' }).click()
      await expect(p.getByRole('alertdialog')).toBeVisible()
      await settle(p)
      return api
    },
    migrated: ['Cancel', 'Delete transaction'],
  },
  {
    key: 'spending-breakdown',
    dialog: true,
    open: (p) => openDialog(p, '/transactions', 'Transactions', (q) => q.getByRole('button', { name: 'Spending breakdown' }), /Spending breakdown/i),
    migrated: ['Close'],
  },
  {
    key: 'due-mark-paid',
    dialog: true,
    open: (p) => openDialog(p, '/transactions', 'Transactions', async (q) => (await expandDue(q), q.getByTestId('due-mark-paid').first()), /./),
    migrated: ['Close', 'Mark paid', 'Cancel'],
  },
  {
    key: 'due-pay',
    dialog: true,
    open: (p) => openDialog(p, '/transactions', 'Transactions', async (q) => (await expandDue(q), q.getByTestId('due-pay').first()), /./),
    migrated: ['Close', 'Pay', 'Cancel'],
  },
  {
    key: 'due-change-date',
    dialog: true,
    open: (p) => openDialog(p, '/transactions', 'Transactions', async (q) => (await expandDue(q), q.getByTestId('row-change-date').first()), /./),
    migrated: ['Close', 'Save'],
  },
  {
    key: 'recurring-create',
    dialog: true,
    open: (p) => openDialog(p, '/allocations', 'Allocations', (q) => q.getByRole('button', { name: 'Add Recurring Entry', exact: true }), 'Add Recurring Entry'),
    migrated: ['Save Recurring Entry', 'Cancel'],
    fill: { 'Save Recurring Entry': fillRecurring },
    saved: { 'Save Recurring Entry': SAVED_ENTRY },
  },
  {
    key: 'recurring-charged',
    dialog: true,
    open: (p) => openDialog(p, '/allocations', 'Allocations', (q) => q.getByTestId('entry-charged-button').first(), /./),
    migrated: ['Close', 'Charged', 'Posted', 'Cancel'],
  },
  {
    key: 'account-create',
    dialog: true,
    open: (p) => openDialog(p, '/accounts', 'Accounts', (q) => q.getByRole('button', { name: 'Add Account', exact: true }), 'Create Account', [createAccountRoute([formAccount])]),
    migrated: ['Create Account', 'Cancel'],
    fill: { 'Create Account': fillAccount },
    saved: { 'Create Account': SAVED_ACCOUNT },
  },
  {
    key: 'account-actions',
    dialog: true,
    open: (p) => openDialog(p, '/accounts', 'Accounts', (q) => q.getByRole('button', { name: /BPI Payroll/ }).first(), /BPI Payroll/),
    migrated: ['View transactions', 'Mark as inactive', 'Edit account', 'Share account', 'Delete account'],
  },
  {
    key: 'share-account',
    dialog: true,
    open: async (p) => {
      const api = await surface('account-actions').open(p)
      await dialogOf(p).getByRole('button', { name: 'Share account' }).click()
      // Since STU-635 every overlay is z-60, so the actions modal, later in the document, paints over the share dialog
      // it opened (on main too). Closing it leaves the share dialog open and reachable.
      await p.getByRole('button', { name: 'Close account actions modal' }).click()
      await expect(p.getByTestId('share-email')).toBeVisible()
      await expect(p.getByText('Jun R.', { exact: true })).toBeVisible()
      await settle(p)
      return api
    },
    migrated: ['Remove', 'Look up'],
    fill: { 'Look up': fillShare },
  },
  {
    key: 'share-account-found',
    dialog: true,
    open: async (p) => {
      const api = await surface('share-account').open(p)
      await fillShare(p)
      await p.getByTestId('share-lookup').click()
      await expect(p.getByTestId('share-submit')).toBeVisible()
      await settle(p)
      return api
    },
    migrated: ['Remove', 'Look up', 'Share with Lia M.'],
    saved: { 'Share with Lia M.': SAVED_SHARE },
  },
  {
    key: 'installment-review',
    dialog: true,
    open: async (p) => {
      const api = await openPage(p, '/transactions', 'Transactions', [], withInstallmentReview(household))
      await expandDue(p)
      await p.getByRole('tab', { name: /^Installments/ }).click()
      await p.getByTestId('due-review').first().click()
      await expect(p.getByTestId('installment-review-submit')).toBeVisible()
      await settle(p)
      return api
    },
    migrated: ['Close', 'Record 1 month and turn on auto-post', 'Cancel'],
  },
  {
    key: 'settings-category',
    dialog: true,
    open: (p) => openDialog(p, '/settings', 'Settings', (q) => q.getByRole('button', { name: 'Add category', exact: true }), 'Add category'),
    migrated: ['Create', 'Cancel'],
    fill: { Create: fillName },
    saved: { Create: SAVED_CATEGORY },
  },
  {
    key: 'settings-category-edit',
    dialog: true,
    open: (p) => openDialog(p, '/settings', 'Settings', (q) => rowsWith(q, FIRST_CATEGORY.name).getByRole('button', { name: 'Edit', exact: true }).first(), 'Edit category'),
    migrated: ['Update', 'Cancel'],
    fill: { Update: fillName },
    saved: { Update: UPDATED_CATEGORY },
  },
  {
    key: 'settings-tag',
    dialog: true,
    open: (p) => openDialog(p, '/settings', 'Settings', (q) => q.getByRole('button', { name: 'Add tag', exact: true }), 'Add tag'),
    migrated: ['Create', 'Cancel'],
    fill: { Create: fillName },
    saved: { Create: SAVED_TAG },
  },
  {
    key: 'settings-tag-edit',
    dialog: true,
    open: (p) => openDialog(p, '/settings', 'Settings', (q) => q.getByRole('button', { name: `Edit tag ${TRIP_TAG}`, exact: true }), 'Edit tag'),
    migrated: ['Update', 'Cancel'],
    fill: { Update: fillName },
    saved: { Update: UPDATED_TAG },
  },
  {
    key: 'wishlist-item',
    dialog: true,
    open: (p) => openDialog(p, '/allocations?tab=wishlist', 'Allocations', (q) => q.getByRole('button', { name: 'Add item', exact: true }), 'Add item'),
    migrated: ['Add', 'Cancel'],
    fill: { Add: fillWishlist },
    saved: { Add: SAVED_WISH },
  },
  {
    key: 'allocation-create',
    dialog: true,
    open: (p) => openDialog(p, '/allocations?tab=budgets', 'Allocations', (q) => q.getByRole('button', { name: 'Add Allocation', exact: true }), 'Create Budget Envelope'),
    migrated: ['Create Budget Envelope', 'Cancel'],
    fill: { 'Create Budget Envelope': fillAllocation },
    saved: { 'Create Budget Envelope': SAVED_ALLOCATION },
  },
  {
    key: 'allocation-actions',
    dialog: true,
    open: (p) => openDialog(p, '/allocations?tab=budgets', 'Allocations', (q) => q.locator('main article.card').filter({ has: q.getByText(BUDGET, { exact: true }) }), BUDGET),
    migrated: ['Pause allocation', 'Edit allocation', 'Delete allocation'],
  },
  {
    key: 'payable-detail',
    dialog: true,
    open: (p) => openDialog(p, '/', 'Dashboard', (q) => q.getByTestId('payable-open').first(), /./),
    migrated: ['Close'],
  },
]

const SURFACES = [...PAGES, ...STATES, ...DIALOGS]
const surface = (key: string): Surface => {
  const s = SURFACES.find((x) => x.key === key)
  if (!s) throw new Error(`no surface ${key}`)
  return s
}
const scopeOf = (page: Page, s: Surface): Locator => (s.dialog ? dialogOf(page) : page.locator('body'))
const capture = (page: Page, s: Surface, name: string): Promise<string> => (s.dialog ? viewportShot(page, name) : shot(page, name))

/** One visible `button` or `a` in a scope, as the layout check compares it with the base. */
interface Control {
  name: string
  height: number
  icons: number
  variant: string | null
  selection: boolean
  /** A selection control's look, which the migration must leave alone. */
  look: string
  /** Whether STU-682's 44px coarse-pointer floor applies to it (`.button`, `.seg`, `.tap-target`). Not in the baseline. */
  floored?: boolean
}

/** Every visible `button` and `a` in the scope, in document order. */
const controlsIn = (scope: Locator): Promise<Control[]> =>
  scope.evaluate(
    (root, selection) =>
      Array.from(root.querySelectorAll('button, a'))
        .filter((e) => (e as HTMLElement).offsetParent !== null || getComputedStyle(e).position === 'fixed')
        .map((e) => {
          const cs = getComputedStyle(e)
          const isSelection = e.closest(selection) !== null
          return {
            name: (e.getAttribute('aria-label') ?? ((e.textContent ?? '').trim() || e.getAttribute('title') || '')).replace(/\s+/g, ' ').trim(),
            height: Math.round(e.getBoundingClientRect().height),
            icons: e.querySelectorAll('svg, img, [aria-hidden="true"]').length,
            variant: e.getAttribute('data-variant'),
            selection: isSelection,
            look: isSelection ? [cs.backgroundColor, cs.color, cs.fontWeight, cs.boxShadow, cs.borderTopColor, cs.borderRadius].join(' | ') : '',
            floored: e.matches('.button, .seg, .tap-target'),
          }
        }),
    SELECTION,
  )

/** The scope's text, whitespace collapsed: labels, status words and figures, independent of layout. */
const textOf = (scope: Locator): Promise<string> => scope.evaluate((root) => (root.textContent ?? '').replace(/\s+/g, ' ').trim())

/** What activating a control does: where the page is, what it asked the API, and what is on screen afterwards. */
interface Effect {
  url: string
  requests: string[]
  dialogs: number
  headings: string[]
  buttons: string[]
  /** The top dialog's fields after the click, as `type:value` (`type:true` for a ticked box): a reset form reads empty. */
  fields: string[]
  /** The text of each row a seeded save produced or changed (`Saved.row`), innermost first match only. */
  rows: string[]
}

/** The visible screen after a click: the URL, the open dialogs, the headings, every button and link, and the form. */
async function screenOf(page: Page, row?: Locator): Promise<Omit<Effect, 'requests'>> {
  const url = new URL(page.url())
  // evaluateAll reads whatever is open now and never waits, so a dialog that closes while it is read gives [].
  const fields = await page.locator(DIALOG).evaluateAll((roots) =>
    roots.length === 0
      ? []
      : Array.from(roots[roots.length - 1].querySelectorAll('input, select, textarea'))
          .filter((e) => (e as HTMLElement).offsetParent !== null)
          .map((e) => {
            const el = e as HTMLInputElement
            return el.type === 'checkbox' || el.type === 'radio' ? `${el.type}:${el.checked}` : `${el.type}:${el.value}`
          }),
  )
  // A row nested in another matching row counts once, as the innermost.
  const rows = row
    ? await row.evaluateAll((els) =>
        els
          .filter((e) => (e as HTMLElement).offsetParent !== null && !els.some((o) => o !== e && e.contains(o)))
          .map((e) => (e.textContent ?? '').replace(/\s+/g, ' ').trim()),
      )
    : []
  return {
    fields,
    rows,
    url: `${url.pathname}${url.search}`,
    dialogs: await page.locator(DIALOG).count(),
    headings: await page
      .locator('h1, h2, h3')
      .evaluateAll((els) => els.filter((e) => (e as HTMLElement).offsetParent !== null).map((e) => (e.textContent ?? '').replace(/\s+/g, ' ').trim())),
    buttons: (await controlsIn(page.locator('body'))).map((c) => c.name),
  }
}

/** How long the screen and the requests must hold still before a click's effect is read, and the most to wait. */
const QUIET_MS = 500
const QUIET_TRIES = 20

/** The requests a page has sent and not yet seen finish or fail, plus a count of every send, finish and failure. */
interface RequestTracker {
  inFlight: Set<Request>
  events: () => number
  stop: () => void
}

function trackRequests(page: Page): RequestTracker {
  const inFlight = new Set<Request>()
  let events = 0
  const sent = (r: Request): void => {
    events += 1
    inFlight.add(r)
  }
  const done = (r: Request): void => {
    events += 1
    inFlight.delete(r)
  }
  page.on('request', sent)
  page.on('requestfinished', done)
  page.on('requestfailed', done)
  return {
    inFlight,
    events: () => events,
    stop: () => {
      page.off('request', sent)
      page.off('requestfinished', done)
      page.off('requestfailed', done)
    },
  }
}

/**
 * Waits until a just-opened dialog has filled in: no request in flight, none sent or finished, and no change on screen
 * for QUIET_MS. `networkidle` alone returns at once after the first load, so a dialog's own lookups could still be in
 * flight and move its buttons under the next click. Throws if that never happens within QUIET_TRIES windows.
 */
async function untilStill(page: Page, requests: RequestTracker): Promise<void> {
  let screen = await screenOf(page)
  for (let i = 0; i < QUIET_TRIES; i += 1) {
    const count = requests.events()
    await settle(page)
    await page.waitForTimeout(QUIET_MS)
    const next = await screenOf(page)
    const still = requests.inFlight.size === 0 && requests.events() === count && JSON.stringify(next) === JSON.stringify(screen)
    screen = next
    if (still) return
  }
  const pending = [...requests.inFlight].map((r) => `${r.method()} ${r.url()}`)
  throw new Error(`the dialog did not settle within ${QUIET_TRIES} windows of ${QUIET_MS}ms (in flight: ${pending.join(', ') || 'none'})`)
}

async function effectOf(page: Page, target: Locator, row?: Locator): Promise<Effect> {
  const seen: string[] = []
  const onRequest = (r: Request): void => {
    const url = new URL(r.url())
    if (!url.pathname.startsWith('/api/v1/')) return
    seen.push(`${r.method()} ${url.pathname.slice('/api/v1'.length)}${url.search} ${r.postData() ?? ''}`.trim())
  }
  page.on('request', onRequest)
  await target.click()
  // A save refetches what it invalidates after it lands, and a dialog fills in after its lookups: read the effect
  // only once neither the requests nor the screen have changed for QUIET_MS.
  let screen = await screenOf(page, row)
  for (let i = 0; i < QUIET_TRIES; i += 1) {
    const count = seen.length
    await settle(page)
    await page.waitForTimeout(QUIET_MS)
    const next = await screenOf(page, row)
    const still = seen.length === count && JSON.stringify(next) === JSON.stringify(screen)
    screen = next
    if (still) break
  }
  page.off('request', onRequest)
  // Requests sent together may leave in either order; what matters is which were sent.
  return { ...screen, requests: [...seen].sort() }
}

interface ProjectBaseline {
  layout: Record<string, { controls: Control[]; text: string }>
  effects: Record<string, Effect>
}
type Baseline = Record<string, ProjectBaseline>

const readBaseline = (): Baseline => (fs.existsSync(BASELINE) ? (JSON.parse(fs.readFileSync(BASELINE, 'utf8')) as Baseline) : {})

/** The same record with its keys in sorted order. */
const byKey = <T,>(entries: Record<string, T>): Record<string, T> =>
  Object.fromEntries(Object.entries(entries).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))

/**
 * Writes one entry of the baseline: a recording run uses one worker, so read-modify-write is safe. Projects and
 * entries are written in key order, so the file does not depend on the order the tests ran in, and an entry recorded
 * again on its own lands where a full run would have put it.
 */
function record(project: string, update: (b: ProjectBaseline) => void): void {
  const all = readBaseline()
  const mine = all[project] ?? { layout: {}, effects: {} }
  update(mine)
  all[project] = { layout: byKey(mine.layout), effects: byKey(mine.effects) }
  fs.writeFileSync(BASELINE, `${JSON.stringify(byKey(all), null, 2)}\n`)
}

/** The nth visible `button` or `a` in the scope with this accessible name. */
async function controlAt(scope: Locator, name: string, nth: number): Promise<Locator> {
  const index = await scope.evaluate(
    (root, { want, n }) => {
      const every = Array.from(root.querySelectorAll('button, a'))
      const named = every
        .filter((e) => (e as HTMLElement).offsetParent !== null || getComputedStyle(e).position === 'fixed')
        .filter((e) => (e.getAttribute('aria-label') ?? ((e.textContent ?? '').trim() || e.getAttribute('title') || '')).replace(/\s+/g, ' ').trim() === want)
      const el = named[n]
      return el ? every.indexOf(el) : -1
    },
    { want: name, n: nth },
  )
  expect(index, `the control "${name}" #${nth + 1} is on the surface`).toBeGreaterThanOrEqual(0)
  return scope.locator('button, a').nth(index)
}

/** Each migrated control once, with its occurrence among controls of the same name. */
const migratedCases = (s: Surface): { name: string; nth: number; key: string }[] => {
  const seen = new Map<string, number>()
  return s.migrated.map((name) => {
    const nth = seen.get(name) ?? 0
    seen.set(name, nth + 1)
    return { name, nth, key: `${s.key} | ${name} | ${nth + 1}` }
  })
}

/** The four variants' examples from AC1, each opened on its own page. */
const EXAMPLES: { variant: string; open: (page: Page) => Promise<Locator> }[] = [
  {
    variant: 'primary',
    open: async (p) => {
      await openPage(p, '/transactions', 'Transactions')
      return p.getByRole('button', { name: 'Add Transaction', exact: true }).first()
    },
  },
  {
    variant: 'secondary',
    open: async (p) => {
      await openPage(p, '/transactions', 'Transactions')
      await expandDue(p)
      return p.getByTestId('due-mark-paid').first()
    },
  },
  {
    variant: 'quiet',
    open: async (p) => {
      await surface('transaction-create').open(p)
      return dialogOf(p).getByRole('button', { name: 'Cancel', exact: true })
    },
  },
  {
    variant: 'danger',
    open: async (p) => {
      await surface('transaction-delete-confirm').open(p)
      return p.getByRole('alertdialog').getByRole('button', { name: 'Delete transaction' })
    },
  },
]
const example = (variant: string): ((page: Page) => Promise<Locator>) => {
  const e = EXAMPLES.find((x) => x.variant === variant)
  if (!e) throw new Error(`no ${variant} example`)
  return e.open
}

test.describe('AC1: button variants match the system', () => {
  test('button variants match the system: primary (Add Transaction)', async ({ page }) => {
    test.skip(RECORD, 'a recording run only writes the baseline')
    const add = await example('primary')(page)
    await expect(add).toHaveAttribute('data-variant', 'primary')
    expect(await style(add, 'background-color'), 'primary fill: accent').toBe(ACCENT)
    expect(await style(add, 'color'), 'primary text: on-accent').toBe(ON_ACCENT)
    expect(await style(add, 'border-top-left-radius'), 'primary radius: radius-sm').toBe('4px')
    expect(await style(add, 'font-weight'), 'primary weight').toBe('600')
    await shot(page, 'variant-primary')
  })

  test('button variants match the system: secondary (a Due card Mark paid)', async ({ page }) => {
    test.skip(RECORD, 'a recording run only writes the baseline')
    const markPaid = await example('secondary')(page)
    await expect(markPaid).toHaveAttribute('data-variant', 'secondary')
    expect(await style(markPaid, 'background-color'), 'secondary background').toBe(TRANSPARENT)
    expect(await style(markPaid, 'border-top-width'), 'secondary border width').toBe('1px')
    expect(await style(markPaid, 'border-top-color'), 'secondary border: line-strong').toBe(LINE_STRONG)
    expect(await style(markPaid, 'color'), 'secondary text: ink').toBe(INK)
    await shot(page, 'variant-secondary')
  })

  test('button variants match the system: quiet (a dialog Cancel)', async ({ page }) => {
    test.skip(RECORD, 'a recording run only writes the baseline')
    const cancel = await example('quiet')(page)
    await expect(cancel).toHaveAttribute('data-variant', 'quiet')
    expect(await style(cancel, 'background-color'), 'quiet background').toBe(TRANSPARENT)
    // No border: the 1px edge every variant shares (it keeps the heights equal) is transparent on quiet.
    const borders = await cancel.evaluate((e) => {
      const cs = getComputedStyle(e)
      return [cs.borderTopColor, cs.borderRightColor, cs.borderBottomColor, cs.borderLeftColor]
    })
    expect(borders, 'quiet has no visible border').toEqual([TRANSPARENT, TRANSPARENT, TRANSPARENT, TRANSPARENT])
    await viewportShot(page, 'variant-quiet')
  })

  test('button variants match the system: danger (Delete in the in-app Confirm)', async ({ page }) => {
    test.skip(RECORD, 'a recording run only writes the baseline')
    const del = await example('danger')(page)
    await expect(del).toHaveAttribute('data-variant', 'danger')
    expect(await style(del, 'border-top-color'), 'danger border: red pencil').toBe(DANGER)
    expect(await style(del, 'color'), 'danger text: red pencil').toBe(DANGER)
    await viewportShot(page, 'variant-danger')
  })
})

test.describe('AC2: no hand-rolled fills remain', () => {
  for (const s of SURFACES) {
    test(`no hand-rolled fills remain: ${s.key}`, async ({ page }) => {
      test.skip(RECORD, 'a recording run only writes the baseline')
      await s.open(page)
      const found = await scopeOf(page, s).evaluate(
        (root, { selection, green, ink, clear }) =>
          Array.from(root.querySelectorAll('button, a'))
            .filter((e) => (e as HTMLElement).offsetParent !== null || getComputedStyle(e).position === 'fixed')
            .filter((e) => e.closest(selection) === null)
            .map((e) => {
              const bg = getComputedStyle(e).backgroundColor
              const name = (e.getAttribute('aria-label') ?? ((e.textContent ?? '').trim() || e.getAttribute('title') || '')).replace(/\s+/g, ' ').trim().slice(0, 40)
              return {
                control: `${e.tagName.toLowerCase()} "${name}"`,
                oldFill: bg === green || bg === ink,
                unstyledFill: e.tagName === 'BUTTON' && bg !== clear && e.getAttribute('data-variant') !== 'primary',
              }
            }),
        { selection: SELECTION, green: OLD_GREEN, ink: INK, clear: TRANSPARENT },
      )
      expect(found.length, 'the surface has controls to check').toBeGreaterThan(0)
      expect(found.filter((f) => f.oldFill).map((f) => f.control), 'controls with the old green or an ink fill').toEqual([])
      expect(found.filter((f) => f.unstyledFill).map((f) => f.control), 'buttons with a fill that are not data-variant="primary"').toEqual([])
      await capture(page, s, `fills-${s.key}`)
    })
  }
})

test.describe('AC3: row actions are secondary', () => {
  const ROW_VARIANTS = /^(secondary|quiet)$/

  test('row actions are secondary: Due card Hide, Mark paid and Change date', async ({ page }) => {
    test.skip(RECORD, 'a recording run only writes the baseline')
    await openPage(page, '/transactions', 'Transactions')
    // STU-687: the Due card opens collapsed; its row actions show once it is expanded.
    await expandDue(page)
    for (const id of ['due-section-toggle', 'due-mark-paid', 'row-change-date']) {
      const all = page.getByTestId(id)
      expect(await all.count(), `the Due card shows ${id}`).toBeGreaterThan(0)
      for (const el of await all.all()) await expect(el).toHaveAttribute('data-variant', ROW_VARIANTS)
    }
    await expect(page.getByTestId('due-section-toggle')).toHaveText('Hide')
    await shot(page, 'row-actions-due')
  })

  test('row actions are secondary: recurring rows Charged and Posted', async ({ page }) => {
    test.skip(RECORD, 'a recording run only writes the baseline')
    await surface('allocations-recurring').open(page)
    for (const id of ['entry-charged-button', 'entry-posted-button']) {
      const all = page.getByTestId(id)
      expect(await all.count(), `the Recurring tab shows ${id}`).toBeGreaterThan(0)
      for (const el of await all.all()) await expect(el).toHaveAttribute('data-variant', ROW_VARIANTS)
    }
    await shot(page, 'row-actions-recurring')
  })

  test('row actions are secondary: Wishlist row Edit, Mark as purchased and the allocation shortcuts', async ({ page }) => {
    test.skip(RECORD, 'a recording run only writes the baseline')
    await surface('allocations-wishlist').open(page)
    const rows = page.locator('article').filter({ has: page.getByRole('button', { name: 'Edit', exact: true }) })
    expect(await rows.count(), 'wishlist rows with an Edit').toBe(householdWishlist.length)
    for (const item of householdWishlist) {
      const row = rows.filter({ has: page.getByText(item.name, { exact: true }) })
      for (const name of ['Edit', 'Mark as purchased', 'Savings target', 'Budget envelope']) {
        await expect(row.getByRole('button', { name, exact: true }), `${item.name}: ${name}`).toHaveAttribute('data-variant', ROW_VARIANTS)
      }
    }
    await shot(page, 'row-actions-wishlist')
  })

  test('row actions are secondary: every row-level Edit', async ({ page }) => {
    test.skip(RECORD, 'a recording run only writes the baseline')
    let seen = 0
    for (const s of PAGES) {
      await s.open(page)
      for (const el of await page.getByRole('button', { name: /^Edit\b/ }).all()) {
        if (!(await el.isVisible())) continue
        seen += 1
        await expect(el, `${s.key}: an Edit`).toHaveAttribute('data-variant', ROW_VARIANTS)
      }
    }
    await openPage(page, '/settings', 'Settings')
    const rowEdits = page.getByRole('listitem').getByRole('button', { name: /^(Edit|Recolour)\b/ })
    expect(await rowEdits.count(), 'the category and tag rows have Edit').toBeGreaterThan(1)
    for (const el of await rowEdits.all()) {
      seen += 1
      await expect(el, 'a Settings row Edit').toHaveAttribute('data-variant', ROW_VARIANTS)
    }
    expect(seen, 'row-level Edits checked').toBeGreaterThan(2)
    await shot(page, 'row-actions-edit')
  })
})

test.describe('AC4: one primary per row', () => {
  for (const s of PAGES) {
    test(`one primary per row: ${s.key}`, async ({ page }) => {
      test.skip(RECORD, 'a recording run only writes the baseline')
      await s.open(page)
      const rows = await page.evaluate(() =>
        Array.from(document.querySelectorAll('article, li, tr, [data-testid$="-row"]')).map((r) => ({
          row: `${r.tagName.toLowerCase()} "${(r.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 40)}"`,
          primaries: r.querySelectorAll('[data-variant="primary"]').length,
        })),
      )
      expect(rows.length, 'the page has rows').toBeGreaterThan(0)
      expect(rows.filter((r) => r.primaries > 1), 'rows with more than one primary').toEqual([])
      await shot(page, `one-primary-${s.key}`)
    })
  }
})

test.describe('AC5: buttons have hover and disabled states', () => {
  /** What hover and disabled may change: background, border, text colour and opacity. */
  const looks = (el: Locator): Promise<string[]> =>
    el.evaluate((e) => {
      const cs = getComputedStyle(e)
      return [cs.backgroundColor, cs.borderTopColor, cs.color, cs.opacity]
    })

  for (const { variant } of EXAMPLES) {
    test(`buttons have hover and disabled states: ${variant} hover`, async ({ page }, testInfo) => {
      test.skip(testInfo.project.name !== 'desktop' || RECORD, 'hover is a desktop pointer state')
      const el = await example(variant)(page)
      await expect(el).toHaveAttribute('data-variant', variant)
      const rest = await looks(el)
      await el.hover()
      await transitionsDone(page)
      const hovered = await looks(el)
      if (variant === 'primary' || variant === 'secondary') {
        expect([hovered[0], hovered[1]], `${variant}: hover changes the background or border colour`).not.toEqual([rest[0], rest[1]])
      } else {
        expect(hovered, `${variant}: hover changes the background, border, text colour or opacity`).not.toEqual(rest)
      }
      await viewportShot(page, `hover-${variant}`)
    })

    test(`buttons have hover and disabled states: ${variant} disabled`, async ({ page }) => {
      test.skip(RECORD, 'a recording run only writes the baseline')
      const el = await example(variant)(page)
      await expect(el).toHaveAttribute('data-variant', variant)
      const rest = await looks(el)
      // The live control, disabled natively, so the variant's own `:disabled` rule applies.
      await el.evaluate((e) => {
        (e as HTMLButtonElement).disabled = true
      })
      await transitionsDone(page)
      await expect(el).toBeDisabled()
      expect(await style(el, 'cursor'), `${variant}: disabled cursor`).toBe('not-allowed')
      const off = await looks(el)
      expect(Number(off[3]) < Number(rest[3]) || off[2] !== rest[2], `${variant}: disabled has a reduced opacity or a muted colour (rest ${rest.join(', ')}; disabled ${off.join(', ')})`).toBe(true)
      await viewportShot(page, `disabled-${variant}`)
    })
  }
})

test.describe('AC6: button migration preserves surrounding behavior and layout', () => {
  for (const s of SURFACES) {
    test(`button migration preserves surrounding behavior and layout: ${s.key} layout`, async ({ page }, testInfo) => {
      await s.open(page)
      const scope = scopeOf(page, s)
      const controls = await controlsIn(scope)
      const text = await textOf(scope)
      await capture(page, s, `layout-${s.key}`)
      const project = testInfo.project.name
      if (RECORD) {
        record(project, (b) => {
          b.layout[s.key] = { controls, text }
        })
        return
      }
      const base = readBaseline()[project]?.layout[s.key]
      expect(base, `the baseline has ${s.key} for ${project}`).toBeDefined()
      if (!base) return
      expect(controls.filter((c) => c.variant !== null).map((c) => c.name), 'the migrated controls on the surface').toEqual(s.migrated)
      expect(controls.map((c) => c.name), 'every button and link keeps its accessible name, in order').toEqual(base.controls.map((c) => c.name))
      const migrated = controls.flatMap((c, i) => (c.variant === null ? [] : [{ c, b: base.controls[i] }]))
      expect(migrated.map(({ c }) => `${c.name}: ${c.icons}`), 'migrated controls keep their icons').toEqual(migrated.map(({ b }) => `${b.name}: ${b.icons}`))
      // STU-682: on a coarse pointer (the phone project) a control under the 44px floor is at least 44px tall, so its
      // base height there is floored at 44; desktop keeps every base height exactly.
      const floor = (h: number, c: Control | undefined): number => (project === 'phone' && c?.floored ? Math.max(h, 44) : h)
      const heights = migrated.map(({ c, b }) => ({ name: c.name, base: floor(b.height, c), now: c.height }))
      expect(heights.filter((h) => Math.abs(h.now - h.base) > 1), 'migrated controls more than 1px off their base height').toEqual([])
      const selectionNow = controls.filter((c) => c.selection).map((c) => `${c.name}: ${c.look}, ${c.height}px`)
      const selectionBase = base.controls.flatMap((c, i) => (c.selection ? [`${c.name}: ${c.look}, ${floor(c.height, controls[i])}px`] : []))
      expect(selectionNow, 'selection controls and tabs are untouched').toEqual(selectionBase)
      expect(text, 'labels and status text are untouched').toBe(base.text)
    })

    for (const c of migratedCases(s)) {
      test(`button migration preserves surrounding behavior and layout: ${c.key}`, async ({ page }, testInfo) => {
        await s.open(page)
        const seed = s.fill?.[c.name]
        if (seed) await seed(page)
        const saved = s.saved?.[c.name]
        if (saved) await addRoutes(page, saved.routes)
        const target = await controlAt(scopeOf(page, s), c.name, c.nth)
        const project = testInfo.project.name
        const enabled = await target.isEnabled()
        const effect = enabled ? await effectOf(page, target, saved?.row(page)) : null
        await viewportShot(page, `effect-${c.key.replace(/[^a-z0-9]+/gi, '-')}`)
        if (RECORD) {
          record(project, (b) => {
            if (effect) b.effects[c.key] = effect
            else delete b.effects[c.key]
          })
          return
        }
        const base = readBaseline()[project]?.effects[c.key]
        expect(effect === null, `${c.name} is disabled now as it was at the base`).toBe(base === undefined)
        expect(effect, `activating ${c.name} does what it did at the base`).toEqual(base ?? null)
      })
    }
  }

  test('button migration preserves surrounding behavior and layout: the page-header primary width', async ({ page }, testInfo) => {
    test.skip(RECORD, 'a recording run only writes the baseline')
    await surface('allocations-recurring').open(page)
    // AC6 as amended for STU-685: the primary sits in PageHeader on the title's row, inside the page content, and nothing scrolls sideways.
    const header = page.getByTestId('page-header')
    await expect(header.getByRole('button', { name: 'Add Recurring Entry', exact: true })).toHaveCount(1)
    const add = header.getByRole('button', { name: 'Add Recurring Entry', exact: true })
    const m = await add.evaluate((e) => {
      const root = e.closest('.page') as HTMLElement
      const head = e.closest('[data-testid="page-header"]') as HTMLElement
      const title = (head.querySelector('h1') as HTMLElement).getBoundingClientRect()
      const r = e.getBoundingClientRect()
      const rootBox = root.getBoundingClientRect()
      const rootStyle = getComputedStyle(root)
      return {
        width: r.width,
        left: r.left,
        right: r.right,
        centreY: r.top + r.height / 2,
        title: { top: title.top, bottom: title.bottom },
        contentLeft: rootBox.left + parseFloat(rootStyle.paddingLeft),
        contentRight: rootBox.right - parseFloat(rootStyle.paddingRight),
        header: { scroll: head.scrollWidth, client: head.clientWidth },
        doc: { scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth },
      }
    })
    // It fits beside "Allocations" on both projects, so it sits on the title's row: its centre y lies within the h1.
    expect(m.centreY, `Add Recurring Entry's centre y (${m.centreY}) is at or below the title's top (${m.title.top})`).toBeGreaterThanOrEqual(m.title.top)
    expect(m.centreY, `Add Recurring Entry's centre y (${m.centreY}) is at or above the title's bottom (${m.title.bottom})`).toBeLessThanOrEqual(m.title.bottom)
    expect(m.left, `Add Recurring Entry starts inside the page content (left ${m.left}, content left ${m.contentLeft})`).toBeGreaterThanOrEqual(m.contentLeft)
    expect(m.right, `Add Recurring Entry ends inside the page content (right ${m.right}, content right ${m.contentRight})`).toBeLessThanOrEqual(m.contentRight)
    expect(m.header.scroll, 'the page header does not overflow sideways').toBeLessThanOrEqual(m.header.client)
    expect(m.doc.scroll, 'the document does not overflow sideways').toBeLessThanOrEqual(m.doc.client)
    if (testInfo.project.name === 'desktop') expect(m.width, 'Add Recurring Entry: width on a desktop').toBeLessThanOrEqual(HEADER_MAX_PX)
    await shot(page, 'header-primary')
  })
})

test.describe('AC7: source has one button path', () => {
  /** Every `.ts`, `.tsx` and `.css` file under frontend/src, as `src/...` paths. */
  const sourceFiles = (dir: string = SRC): string[] =>
    fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
      const full = path.join(dir, d.name)
      if (d.isDirectory()) return sourceFiles(full)
      return /\.(ts|tsx|css)$/.test(d.name) ? [path.relative(FRONTEND, full)] : []
    })
  /** Every line matching `pattern`, as `file:line: text`. */
  const scan = (pattern: RegExp, files: string[] = sourceFiles()): string[] =>
    files.flatMap((file) =>
      fs
        .readFileSync(path.join(FRONTEND, file), 'utf8')
        .split('\n')
        .flatMap((line, i) => (pattern.test(line) ? [`${file}:${i + 1}: ${line.trim()}`] : [])),
    )
  const BUTTON_FILE = 'src/components/Button.tsx'
  const CSS_FILE = 'src/assets/index.css'
  /** `bg-ok` uses that are not actions: two status dots and a status icon. */
  const OK_FILLS = [
    { file: 'src/routes/settings.tsx', marker: "dot: 'bg-ok'" },
    { file: 'src/routes/index.tsx', marker: 'bg-ok' },
    { file: CSS_FILE, marker: '@apply bg-ok' },
  ]

  test('source has one button path', async ({ page }) => {
    test.skip(RECORD, 'a recording run only writes the baseline')
    const tsx = sourceFiles().filter((f) => /\.tsx?$/.test(f))
    expect(scan(/bg-ink text-paper/), 'bg-ink text-paper').toEqual([])
    expect(scan(/hover:bg-ok\b/), 'hover:bg-ok').toEqual([])
    const okFills = scan(/\bbg-ok\b/)
    expect(okFills.filter((hit) => !OK_FILLS.some((o) => hit.startsWith(`${o.file}:`) && hit.includes(o.marker))), 'bg-ok outside the status dots and icon').toEqual([])
    expect(okFills.filter((hit) => /<(button|a|Link)\b|onClick/.test(hit)), 'bg-ok on an action').toEqual([])
    expect(scan(/\bbtn-(primary|secondary|danger)\b/, tsx), 'React elements using btn-primary, btn-secondary or btn-danger').toEqual([])
    const helpers = scan(/\b(const|let|var|function)\s+(buttonClass|primaryButtonClass)\b/).map((h) => h.split(':')[0])
    expect(helpers, 'buttonClass helpers outside Button.tsx').toEqual([BUTTON_FILE])
    // A .btn-* rule kept in index.css would have to name its non-React consumer; there is none, so none is kept.
    expect(scan(/\.btn-[\w-]+/, [CSS_FILE]), '.btn-* rules in index.css').toEqual([])
    const variantFiles = [...new Set(scan(/\bbutton-(primary|secondary|quiet|danger)\b/).map((h) => h.split(':')[0]))].sort()
    expect(variantFiles, 'the variant classes are set only in Button.tsx and defined only in index.css').toEqual([CSS_FILE, BUTTON_FILE].sort())
    await openPage(page, '/transactions', 'Transactions')
    await shot(page, 'one-path')
  })
})

test.describe('AC8: button preserves native interaction semantics', () => {
  /** Counts the document's submit events in `window.__submits` (capture phase, so every form is seen). */
  const countSubmits = (page: Page): Promise<void> =>
    page.evaluate(() => {
      const w = window as unknown as { __submits: number }
      w.__submits = 0
      document.addEventListener('submit', () => (w.__submits += 1), true)
    })
  const submits = (page: Page): Promise<number> => page.evaluate(() => (window as unknown as { __submits: number }).__submits)
  const openCreateAccount = (page: Page): Promise<ApiMock> =>
    openDialog(page, '/accounts', 'Accounts', (q) => q.getByRole('button', { name: 'Add Account', exact: true }), 'Create Account', [createAccountRoute(createdAccounts)])

  test('button preserves native interaction semantics: an omitted type is a button and does not submit', async ({ page }) => {
    test.skip(RECORD, 'a recording run only writes the baseline')
    const api = await openCreateAccount(page)
    await countSubmits(page)
    const cancel = dialogOf(page).getByRole('button', { name: 'Cancel', exact: true })
    await expect(cancel).toHaveAttribute('data-variant', 'quiet')
    await expect(cancel).toHaveAttribute('type', 'button')
    expect(await cancel.evaluate((e) => (e as HTMLButtonElement).form !== null), 'Cancel sits inside the account form').toBe(true)
    await dialogOf(page).getByPlaceholder('Enter account name').fill(newAccountInput.name)
    await cancel.click()
    await expect(page.getByRole('heading', { name: 'Create Account' })).toBeHidden()
    await settle(page)
    expect(await submits(page), 'form submits from Cancel').toBe(0)
    expect(api.count('POST', '/accounts/'), 'accounts saved by Cancel').toBe(0)
    await shot(page, 'native-omitted-type')
  })

  test('button preserves native interaction semantics: type submit submits once', async ({ page }) => {
    test.skip(RECORD, 'a recording run only writes the baseline')
    const api = await openCreateAccount(page)
    await countSubmits(page)
    const create = dialogOf(page).getByRole('button', { name: 'Create Account', exact: true })
    await expect(create).toHaveAttribute('data-variant', 'primary')
    await expect(create).toHaveAttribute('type', 'submit')
    await dialogOf(page).getByPlaceholder('Enter account name').fill(newAccountInput.name)
    await create.click()
    await expect.poll(() => api.count('POST', '/accounts/'), { message: 'accounts saved' }).toBe(1)
    await settle(page)
    expect(await submits(page), 'form submits').toBe(1)
    expect(api.count('POST', '/accounts/'), 'accounts saved once the page settles').toBe(1)
    await shot(page, 'native-submit')
  })

  test('button preserves native interaction semantics: an enabled Button runs its handler once', async ({ page }) => {
    test.skip(RECORD, 'a recording run only writes the baseline')
    await openPage(page, '/transactions', 'Transactions')
    // STU-687: one Filters button whose aria-expanded says whether the filters are open.
    const toggle = page.getByRole('button', { name: 'Filters', exact: true })
    await expect(toggle).toHaveAttribute('data-variant', 'secondary')
    await toggle.click()
    await settle(page)
    // The handler flips the filters open; run twice, it would flip them shut again.
    await expect(toggle).toHaveAttribute('aria-expanded', 'true')
    await expect(page.getByTestId('transactions-filters')).toBeVisible()
    await shot(page, 'native-handler-once')
  })

  test('button preserves native interaction semantics: a disabled Button runs neither its handler nor a submit', async ({ page }) => {
    test.skip(RECORD, 'a recording run only writes the baseline')
    const api = await openPage(page, '/transactions', 'Transactions')
    // An app-disabled Button: the month cannot move past this one.
    const next = page.getByRole('button', { name: 'View next month' })
    await expect(next).toHaveAttribute('data-variant', 'secondary')
    await expect(next).toBeDisabled()
    const url = page.url()
    const before = api.requests().length
    await next.click({ force: true })
    await settle(page)
    expect(page.url(), 'the month did not move').toBe(url)
    expect(api.requests().length, 'requests after clicking a disabled Button').toBe(before)

    // A disabled submit Button: neither a click nor Enter in the form submits.
    const created = await openCreateAccount(page)
    await countSubmits(page)
    const create = dialogOf(page).getByRole('button', { name: 'Create Account', exact: true })
    await dialogOf(page).getByPlaceholder('Enter account name').fill(newAccountInput.name)
    await create.evaluate((e) => {
      (e as HTMLButtonElement).disabled = true
    })
    await expect(create).toBeDisabled()
    await create.click({ force: true })
    await dialogOf(page).getByPlaceholder('Enter account name').press('Enter')
    await settle(page)
    expect(await submits(page), 'submits from a disabled submit Button').toBe(0)
    expect(created.count('POST', '/accounts/'), 'accounts saved').toBe(0)
    await viewportShot(page, 'native-disabled')
  })
})
