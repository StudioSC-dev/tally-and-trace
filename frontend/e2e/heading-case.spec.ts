// STU-710: headings, card titles, dialog titles and buttons read in sentence case, and the transaction dialog keeps
// the verb of the control that opened it. The API is faked in the browser with the shared household fixture; there
// is no backend.
import fs from 'node:fs'
import path from 'node:path'
import { expect, test } from '@playwright/test'
import type { Locator, Page } from '@playwright/test'
import type { BudgetEntry, CardStatements } from '@tally-trace/shared'
import { apiRoute, errorRoute, meRoute, mockApi } from './support/mockApi'
import type { ApiRoute } from './support/mockApi'
import { shot } from './support/shot'
import { expandDue, openTransactionFilters } from './support/transactions'
import {
  accountDetailRoutes,
  cardStatements,
  createAccountRoute,
  emptyHousehold,
  household,
  householdCreateRoutes,
  householdDialogRoutes,
  householdSaveRoutes,
  householdViewRoutes,
  householdWishlistRoutes,
  installmentReviewRoutes,
  loanScheduleRoute,
  mockHousehold,
  withInstallmentReview,
  withLoan,
  withOnboarding,
  withUnpostedRide,
} from './support/fixtures/household'
import type { HouseholdData } from './support/fixtures/household'

/**
 * Every open dialog: the page modals (the shared `fixed inset-0 overflow-y-auto` overlay) and the component dialogs.
 * The last one in the document is on top.
 */
const DIALOG = '.fixed.inset-0.overflow-y-auto, [role="dialog"], [role="alertdialog"]'

/** What a surface shows: its `h1`–`h4` headings, its dialog titles and its buttons, each in document order, once. */
interface Seen {
  headings: string[]
  titles: string[]
  buttons: string[]
}

/** A viewport screenshot (a full-page one draws a fixed layer at the scroll offset), saved like `shot()`. */
async function viewportShot(page: Page, name: string): Promise<void> {
  const info = test.info()
  const file = path.join(info.project.outputDir, 'screens', `heading-case-${name}-${info.project.name}.png`)
  await page.screenshot({ path: file, animations: 'disabled' })
}

/** Reads what `root` shows. Hidden elements, and the 1px visually-hidden ones, are skipped. */
const seenIn = (scope: Locator): Promise<Seen> =>
  scope.evaluate((root, dialogSelector) => {
    const shown = (e: Element): boolean => {
      const b = e.getBoundingClientRect()
      if (b.width <= 1 || b.height <= 1) return false
      return e.checkVisibility({ visibilityProperty: true }) && e.closest('[aria-hidden="true"]') === null
    }
    const text = (e: Element): string => ((e as HTMLElement).innerText ?? '').replace(/\s+/g, ' ').trim()
    const once = (list: string[]): string[] => [...new Set(list.filter((t) => t !== ''))]
    const within = (selector: string): Element[] => [...(root.matches(selector) ? [root] : []), ...root.querySelectorAll(selector)].filter(shown)
    // Card titles are headings; an empty list's title is a large semibold line (in that style, a figure is an amount).
    const headings = within('h1, h2, h3, h4, p.text-lg.font-semibold')
      .filter((e) => e.tagName !== 'P' || /^[A-Za-z]/.test(text(e)))
      .map(text)
    const titles = within(dialogSelector).map((d) => {
      const labelledBy = d.getAttribute('aria-labelledby')
      const named = labelledBy ? document.getElementById(labelledBy) : null
      if (named) return text(named)
      const heading = [...d.querySelectorAll('h1, h2, h3, h4')].find(shown)
      return heading ? text(heading) : (d.getAttribute('aria-label') ?? '')
    })
    // A card that opens a dialog is `article[role=button]`; its text is the card, not a button label. A list row that
    // opens its record is no control itself (STU-683): its title is a button named after the record, listed here.
    const buttons = within('button, [role="button"]:not(article), a[data-variant]').map((e) => text(e) || e.getAttribute('aria-label') || e.getAttribute('title') || '')
    return { headings: once(headings), titles: once(titles), buttons: once(buttons) }
  }, DIALOG)

/** Waits until what the surface shows has held still for two reads in a row, so a lookup that fills it has landed. */
async function settled(page: Page, scope: () => Locator): Promise<Seen> {
  // A loading state keeps one request open on purpose, so the network never goes idle there.
  await page.waitForLoadState('networkidle', { timeout: 5_000 }).catch(() => undefined)
  await page.mouse.move(0, 0)
  let last = JSON.stringify(await seenIn(scope()))
  for (let i = 0; i < 20; i += 1) {
    await page.waitForTimeout(250)
    const now = await seenIn(scope())
    const json = JSON.stringify(now)
    if (json === last) return now
    last = json
  }
  return JSON.parse(last) as Seen
}

/** Extra routes the dialogs' lookups and saves need, answered with typed fixture data. */
const extraRoutes = (data: HouseholdData): ApiRoute[] => [
  ...(data.accounts.length > 0 ? householdCreateRoutes(data) : []),
  ...householdDialogRoutes(data),
  ...householdSaveRoutes(data),
  ...householdWishlistRoutes(),
  ...installmentReviewRoutes(),
  ...data.accounts.flatMap((a) => accountDetailRoutes(data, a.id)),
  apiRoute<CardStatements>('GET', `/accounts/${cardStatements.account_id}/statements`, cardStatements),
]

/** A request the page sends and never gets an answer to, so the page stays in its loading state. */
const hold = async (page: Page, path: string): Promise<void> => {
  await page.route((url) => url.pathname === `/api/v1${path}`, () => undefined)
}

/** Opens a signed-in page. `held` paths are asked for and never answered, so the page stays loading them. */
async function openPage(page: Page, route: string, data: HouseholdData = household, extra: ApiRoute[] = [], held: string[] = []): Promise<void> {
  await mockHousehold(page, data)
  await mockApi(page, [...extraRoutes(data), ...extra])
  // Registered after the mock's catch-all, so these win over it.
  for (const path of held) await hold(page, path)
  await page.goto(route)
  // A page shows its title, or, while loading or when there is nothing to show, a line of text in its place.
  await expect(page.locator('main h1, main p').first()).toBeVisible({ timeout: 15_000 })
}

const top = (page: Page): Locator => page.locator(DIALOG).last()

async function openDialog(page: Page, route: string, trigger: (page: Page) => Locator, data: HouseholdData = household, extra: ApiRoute[] = []): Promise<void> {
  await openPage(page, route, data, extra)
  await page.waitForLoadState('networkidle')
  await trigger(page).click()
  await expect(top(page)).toBeVisible()
}

/** STU-687: opens Transactions, expands the collapsed Due card, then clicks one of its row actions. */
async function openDueDialog(page: Page, trigger: (page: Page) => Locator): Promise<void> {
  await openPage(page, '/transactions')
  await page.waitForLoadState('networkidle')
  await expandDue(page)
  await trigger(page).click()
  await expect(top(page)).toBeVisible()
}

/** The first budget envelope and the first savings tracker in the fixture. */
const budgetName = household.allocations.find((a) => a.allocation_type === 'budget')?.name ?? ''
const budgetId = household.allocations.find((a) => a.allocation_type === 'budget')?.id ?? 0
const savingsName = household.allocations.find((a) => a.allocation_type !== 'budget')?.name ?? ''

const row = (page: Page, description: string): Locator => page.locator('article[data-transaction-id]').filter({ hasText: description }).first()
/** A whole name in any case, so a step that opens a surface works before and after the change. */
const named = (name: string): RegExp => new RegExp(`^${name}$`, 'i')

/** Opens Add transaction on Transactions. */
const openAdd = (p: Page, data: HouseholdData = household): Promise<void> =>
  openDialog(p, '/transactions', (q) => q.getByTestId('page-header').getByRole('button', { name: named('add transaction') }), data)

/** Picks an account in the transaction form's account picker, opening the folded field first when it is folded. */
async function pickAccount(page: Page, name: string): Promise<void> {
  const field = top(page).locator('[data-field="account_id"]')
  const chip = field.getByRole('button', { name: new RegExp(`^${name}`) })
  const change = field.locator('[data-picker-change][aria-expanded="false"]')
  await chip.or(change).first().waitFor()
  if ((await chip.count()) === 0) await change.click()
  await chip.first().click()
  await expect(field.locator('[data-picker-value]')).toContainText(name)
}

/** Adds a transaction the server refuses: the dialog closes and the save comes back as a failed toast. */
async function refusedSave(page: Page): Promise<void> {
  await openAdd(page)
  await mockApi(page, [errorRoute('POST', '/transactions/', 400, 'The amount is over the account limit.')])
  await top(page).getByPlaceholder('Add notes about this transaction').fill('Heading case check')
  await pickAccount(page, 'BPI Payroll')
  await top(page).locator('input[type="number"][placeholder="0.00"]').first().fill('120')
  await top(page).locator('button[type="submit"][data-variant="primary"]').click()
  await expect(page.getByTestId('save-toast-edit')).toBeVisible()
}

/** Opens a row's action dialog on Transactions. */
const openActions = (p: Page, description: string, data: HouseholdData = household): Promise<void> => openDialog(p, '/transactions', (q) => row(q, description), data)

/** A recurring row's name: the row opens its form from there (its middle holds the row's own buttons). */
const recurringRow = (page: Page, name: string): Locator =>
  page.locator('[data-testid^="kind-section-"] article').filter({ has: page.getByText(name, { exact: true }) }).first().getByText(name, { exact: true })
const allocationCard = (page: Page, name: string): Locator => page.locator('main article.card').filter({ has: page.getByText(name, { exact: true }) }).first()
const accountButton = (page: Page, name: string): Locator => page.getByRole('button', { name: new RegExp(name) }).first()

/** A first-run user on the dashboard, with the onboarding tour advanced to `step` (1 to 8). */
async function openOnboarding(page: Page, step: number): Promise<void> {
  await openPage(page, '/', withOnboarding(household))
  const bubble = page.getByRole('dialog').last()
  await expect(bubble).toBeVisible()
  for (let i = 1; i < step; i += 1) {
    await expect(bubble.getByText(`Step ${i} of 8`, { exact: true })).toBeVisible()
    await bubble.getByRole('button', { name: 'Next', exact: true }).click()
  }
  await expect(bubble.getByText(`Step ${step} of 8`, { exact: true })).toBeVisible()
}

interface Expected {
  headings: string[]
  titles: string[]
  buttons: string[]
}

interface Surface {
  name: string
  /** Opens the surface. */
  open: (page: Page) => Promise<void>
  /** True when the surface is the top dialog; otherwise it is the whole page, controls outside `main` included. */
  dialog?: boolean
}

const SURFACES: Surface[] = [
  // Pages, populated.
  { name: 'dashboard', open: (p) => openPage(p, '/') },
  { name: 'transactions', open: (p) => openPage(p, '/transactions') },
  {
    name: 'transactions, filters shown',
    // STU-687: the Due card opens collapsed and Filters is one toolbar button; this surface opens both, so the Due
    // card's tabs and row actions are read here while the plain page reads the collapsed banner.
    open: async (p) => {
      await openPage(p, '/transactions')
      await expandDue(p)
      await openTransactionFilters(p)
    },
  },
  { name: 'transactions, scheduled view', open: (p) => openPage(p, '/transactions?view=scheduled') },
  { name: 'allocations, recurring', open: (p) => openPage(p, '/allocations?tab=recurring') },
  { name: 'allocations, budgets', open: (p) => openPage(p, '/allocations?tab=budgets') },
  { name: 'allocations, savings', open: (p) => openPage(p, '/allocations?tab=savings') },
  { name: 'allocations, wishlist', open: (p) => openPage(p, '/allocations?tab=wishlist') },
  { name: 'accounts', open: (p) => openPage(p, '/accounts', withLoan(household), [loanScheduleRoute()]) },
  { name: 'account, checking', open: (p) => openPage(p, '/accounts/11') },
  { name: 'account, credit card', open: (p) => openPage(p, '/accounts/15') },
  { name: 'account, not found', open: (p) => openPage(p, '/accounts/999', household, [errorRoute('GET', '/accounts/999', 404, 'Account not found')]) },
  { name: 'household, dashboard', open: (p) => openPage(p, '/accounts/household', household, householdViewRoutes(household)) },
  ...['Transactions', 'Upcoming', 'Monthly'].map(
    (tab): Surface => ({
      name: `household, ${tab.toLowerCase()}`,
      open: async (p) => {
        await openPage(p, '/accounts/household', household, householdViewRoutes(household))
        await p.locator('main').getByRole('tab', { name: tab, exact: true }).click()
      },
    }),
  ),
  { name: 'forecast', open: (p) => openPage(p, '/forecast') },
  { name: 'settings', open: (p) => openPage(p, '/settings') },
  // Pages, empty.
  { name: 'dashboard, empty', open: (p) => openPage(p, '/', emptyHousehold) },
  { name: 'transactions, empty', open: (p) => openPage(p, '/transactions', emptyHousehold) },
  { name: 'allocations, recurring, empty', open: (p) => openPage(p, '/allocations?tab=recurring', emptyHousehold) },
  { name: 'allocations, budgets, empty', open: (p) => openPage(p, '/allocations?tab=budgets', { ...emptyHousehold, allocations: [] }) },
  { name: 'allocations, savings, empty', open: (p) => openPage(p, '/allocations?tab=savings', { ...emptyHousehold, allocations: [] }) },
  { name: 'accounts, empty', open: (p) => openPage(p, '/accounts', { ...emptyHousehold, accounts: [] }) },
  // Pages, loading.
  {
    name: 'dashboard, loading',
    open: (p) => openPage(p, '/', household, [], ['/dashboard/snapshot']),
  },
  {
    name: 'transactions, loading',
    open: (p) => openPage(p, '/transactions', household, [], ['/transactions/']),
  },
  {
    name: 'account, loading',
    open: (p) => openPage(p, '/accounts/11', household, [], ['/transactions/']),
  },
  // Pages, errors.
  { name: 'dashboard, error', open: (p) => openPage(p, '/', household, [errorRoute('GET', '/dashboard/snapshot', 500, 'Server error')]) },
  { name: 'transactions, error', open: (p) => openPage(p, '/transactions', household, [errorRoute('GET', '/transactions/', 500, 'Server error')]) },
  // Page states with more controls.
  {
    name: 'dashboard, quick balances editor',
    open: async (p) => {
      await openPage(p, '/')
      await p.getByTestId('quick-balances-edit').click()
    },
  },
  // Signed out.
  {
    name: 'sign in',
    open: async (p) => {
      await mockApi(p, [])
      await p.goto('/login')
      await expect(p.locator('h1').first()).toBeVisible()
    },
  },
  {
    name: 'sign in, email not verified',
    open: async (p) => {
      await mockApi(p, [errorRoute('POST', '/auth/login', 403, 'Email not verified')])
      await p.goto('/login')
      await p.getByLabel('Email address').fill('mara@example.com')
      await p.getByLabel('Password').fill('a-password')
      await p.getByRole('button', { name: 'Sign in', exact: true }).click()
      await expect(p.getByText('Email not verified')).toBeVisible()
    },
  },
  {
    name: 'sign up',
    open: async (p) => {
      await mockApi(p, [])
      await p.goto('/register')
      await expect(p.locator('h1').first()).toBeVisible()
    },
  },
  {
    name: 'verify email, loading',
    open: async (p) => {
      await mockApi(p, [])
      await hold(p, '/auth/verify-email')
      await p.goto('/verify-email?token=e2e')
      await expect(p.getByText('Verifying your email...')).toBeVisible()
    },
  },
  {
    name: 'verify email, success',
    open: async (p) => {
      await mockApi(p, [apiRoute<{ message: string }>('POST', '/auth/verify-email', { message: 'Email verified' })])
      await p.clock.install()
      await p.goto('/verify-email?token=e2e')
      await expect(p.locator('h2').first()).toBeVisible()
    },
  },
  {
    name: 'verify email, error',
    open: async (p) => {
      await mockApi(p, [errorRoute('POST', '/auth/verify-email', 400, 'This link has expired.')])
      await p.goto('/verify-email?token=e2e')
      await expect(p.locator('h2').first()).toBeVisible()
    },
  },
  // Onboarding, every step.
  ...[1, 2, 3, 4, 5, 6, 7, 8].map((step): Surface => ({ name: `onboarding, step ${step}`, dialog: true, open: (p) => openOnboarding(p, step) })),
  // Transactions dialogs.
  { name: 'add transaction dialog', dialog: true, open: (p) => openAdd(p) },
  {
    name: 'add transaction dialog, savings account',
    dialog: true,
    open: async (p) => {
      await openAdd(p)
      await pickAccount(p, 'Metrobank Savings')
    },
  },
  {
    name: 'add transaction dialog, transfer',
    dialog: true,
    open: async (p) => {
      await openAdd(p)
      await top(p).getByRole('group', { name: 'Transaction type' }).getByRole('button', { name: /transfer/i }).click()
    },
  },
  {
    name: 'add transaction dialog, installment',
    dialog: true,
    open: async (p) => {
      await openAdd(p)
      await pickAccount(p, 'HSBC Red Mastercard')
      await p.getByTestId('installment-toggle').check()
    },
  },
  {
    name: 'add transaction, refused save',
    open: async (p) => {
      await refusedSave(p)
    },
  },
  {
    name: 'add transaction dialog, reopened with the reason',
    dialog: true,
    open: async (p) => {
      await refusedSave(p)
      await p.getByTestId('save-toast-edit').click()
      await expect(top(p).getByRole('alert').first()).toBeVisible()
    },
  },
  { name: 'add transaction dialog, empty state trigger', dialog: true, open: (p) => openDialog(p, '/transactions', (q) => q.locator('main').getByRole('button', { name: named('add transaction') }).last(), emptyHousehold) },
  { name: 'transaction actions dialog', dialog: true, open: (p) => openActions(p, 'Grab to Makati') },
  { name: 'transaction actions dialog, transfer', dialog: true, open: (p) => openActions(p, 'Move to emergency fund') },
  { name: 'transaction actions dialog, not posted', dialog: true, open: (p) => openActions(p, 'Grab to Makati', withUnpostedRide(household)) },
  {
    name: 'transaction actions dialog, posting form',
    dialog: true,
    open: async (p) => {
      await openActions(p, 'Grab to Makati', withUnpostedRide(household))
      await top(p).getByRole('button', { name: named('mark as posted') }).click()
    },
  },
  { name: 'transaction actions dialog, read only', dialog: true, open: (p) => openActions(p, 'Palengke, Marikina market') },
  {
    name: 'edit transaction dialog',
    dialog: true,
    open: async (p) => {
      await openActions(p, 'Grab to Makati')
      await top(p).getByRole('button', { name: named('edit transaction') }).click()
    },
  },
  {
    name: 'delete transaction confirm',
    dialog: true,
    open: async (p) => {
      await openActions(p, 'Grab to Makati')
      await top(p).getByRole('button', { name: named('delete transaction') }).click()
      await expect(p.getByRole('alertdialog')).toBeVisible()
    },
  },
  { name: 'spending breakdown dialog', dialog: true, open: (p) => openDialog(p, '/transactions', (q) => q.getByRole('button', { name: named('spending breakdown') })) },
  // STU-687: the Due card opens collapsed; it is expanded before its row actions are clicked.
  { name: 'mark paid dialog', dialog: true, open: (p) => openDueDialog(p, (q) => q.getByTestId('due-mark-paid').first()) },
  { name: 'pay dialog', dialog: true, open: (p) => openDueDialog(p, (q) => q.getByTestId('due-pay').first()) },
  { name: 'change date dialog', dialog: true, open: (p) => openDueDialog(p, (q) => q.getByTestId('row-change-date').first()) },
  {
    name: 'installment review dialog',
    dialog: true,
    open: async (p) => {
      await openPage(p, '/transactions', withInstallmentReview(household))
      await expandDue(p)
      await p.getByRole('tab', { name: /^Installments/ }).click()
      await p.getByTestId('due-review').first().click()
      await expect(p.getByTestId('installment-review-submit')).toBeVisible()
    },
  },
  // Allocations dialogs.
  { name: 'add recurring entry dialog', dialog: true, open: (p) => openDialog(p, '/allocations?tab=recurring', (q) => q.getByRole('button', { name: named('add recurring entry') })) },
  { name: 'edit recurring entry dialog', dialog: true, open: (p) => openDialog(p, '/allocations?tab=recurring', (q) => recurringRow(q, 'Meralco')) },
  { name: 'charged dialog', dialog: true, open: (p) => openDialog(p, '/allocations?tab=recurring', (q) => q.getByTestId('entry-charged-button').first()) },
  { name: 'add budget envelope dialog', dialog: true, open: (p) => openDialog(p, '/allocations?tab=budgets', (q) => q.getByRole('button', { name: named('add allocation') })) },
  { name: 'add savings tracker dialog', dialog: true, open: (p) => openDialog(p, '/allocations?tab=savings', (q) => q.getByRole('button', { name: named('add allocation') })) },
  { name: 'budget envelope actions dialog', dialog: true, open: (p) => openDialog(p, '/allocations?tab=budgets', (q) => allocationCard(q, budgetName)) },
  { name: 'savings tracker actions dialog', dialog: true, open: (p) => openDialog(p, '/allocations?tab=savings', (q) => allocationCard(q, savingsName)) },
  {
    name: 'edit allocation dialog',
    dialog: true,
    open: async (p) => {
      await openDialog(p, '/allocations?tab=budgets', (q) => allocationCard(q, budgetName))
      await top(p).getByRole('button', { name: named('edit allocation') }).click()
    },
  },
  { name: 'add wishlist item dialog', dialog: true, open: (p) => openDialog(p, '/allocations?tab=wishlist', (q) => q.getByRole('button', { name: 'Add item', exact: true })) },
  { name: 'edit wishlist item dialog', dialog: true, open: (p) => openDialog(p, '/allocations?tab=wishlist', (q) => q.locator('main article').filter({ hasText: 'Work laptop' }).getByRole('button', { name: 'Edit', exact: true })) },
  // Accounts dialogs.
  { name: 'add account dialog', dialog: true, open: (p) => openDialog(p, '/accounts', (q) => q.getByRole('button', { name: named('add account') })) },
  {
    name: 'add account dialog, credit card',
    dialog: true,
    open: async (p) => {
      await openDialog(p, '/accounts', (q) => q.getByRole('button', { name: named('add account') }))
      await top(p).locator('select').first().selectOption('credit')
      await top(p).getByRole('button', { name: 'Show details' }).click()
    },
  },
  { name: 'account actions dialog', dialog: true, open: (p) => openDialog(p, '/accounts', (q) => accountButton(q, 'BPI Payroll')) },
  { name: 'card account actions dialog', dialog: true, open: (p) => openDialog(p, '/accounts', (q) => accountButton(q, 'HSBC Red Mastercard')) },
  { name: 'shared account actions dialog', dialog: true, open: (p) => openDialog(p, '/accounts', (q) => accountButton(q, 'BDO Joint household')) },
  { name: 'loan account actions dialog', dialog: true, open: (p) => openDialog(p, '/accounts', (q) => accountButton(q, 'Pag-IBIG housing loan'), withLoan(household), [loanScheduleRoute()]) },
  {
    name: 'loan record payment form',
    dialog: true,
    open: async (p) => {
      await openDialog(p, '/accounts', (q) => accountButton(q, 'Pag-IBIG housing loan'), withLoan(household), [loanScheduleRoute()])
      await top(p).getByRole('button', { name: 'Record payment', exact: true }).click()
    },
  },
  {
    name: 'edit account dialog',
    dialog: true,
    open: async (p) => {
      await openDialog(p, '/accounts', (q) => accountButton(q, 'HSBC Red Mastercard'))
      await top(p).getByRole('button', { name: named('edit account') }).click()
    },
  },
  {
    name: 'share account dialog',
    dialog: true,
    open: async (p) => {
      await openDialog(p, '/accounts', (q) => accountButton(q, 'BPI Payroll'))
      await top(p).getByRole('button', { name: 'Share account' }).click()
      await p.getByRole('button', { name: 'Close account actions modal' }).click()
      await expect(p.getByTestId('share-email')).toBeVisible()
    },
  },
  // Settings dialogs.
  { name: 'add category dialog', dialog: true, open: (p) => openDialog(p, '/settings', (q) => q.getByRole('button', { name: 'Add category', exact: true })) },
  { name: 'add tag dialog', dialog: true, open: (p) => openDialog(p, '/settings', (q) => q.getByRole('button', { name: 'Add tag', exact: true })) },
  { name: 'edit tag dialog', dialog: true, open: (p) => openDialog(p, '/settings', (q) => q.getByRole('button', { name: 'Edit tag Japan trip', exact: true })) },
  // Dashboard dialogs.
  { name: 'payable dialog', dialog: true, open: (p) => openDialog(p, '/', (q) => q.getByTestId('payable-open').first()) },
]

/**
 * What each surface shows, in document order, once each: its headings and card titles, its dialog titles and its
 * buttons. Each list is sentence case; capitals left are proper nouns and acronyms (PHP, GCash, HSBC, MTD, Metrobank,
 * BDO, BPI), names from the household fixture, and the start of a phrase. `phone` lists only what differs there.
 */
const EXPECTED: Record<string, Expected & { phone?: Partial<Expected> }> = {
  'dashboard': {
    headings: [
      'Dashboard',
      'Available cash',
      'Month to date',
      'Quick balances',
      'Cash-flow timeline',
      'Financial snapshot',
      'Today',
      'Projected',
      'Budget envelope status',
      'Upcoming payables',
      'Also coming up',
    ],
    titles: [],
    buttons: [
      'Toggle theme',
      'MS Mara Santos',
      'Week',
      'Month',
      'Year',
      'Edit',
      'Emergency fund top-up Mar 8th, 2026 · ₱10,000.00 Scheduled · Manual · from BPI Payroll',
      'HMO dependent add-on Mar 20th, 2026 · ₱1,450.00 Scheduled · Manual · from BPI Payroll',
      'Rent Apr 1st, 2026 · ₱22,000.00 Scheduled · Manual · from BPI Payroll',
      'PLDT Fibr Apr 6th, 2026 · ₱1,899.00 Scheduled · Autopay · from BPI Payroll',
      'HSBC Red Mastercard statement Apr 9th, 2026 · ₱6,261.75 Card statement · from BPI Payroll',
      'Meralco Apr 10th, 2026 · ₱4,600.00 Scheduled · Manual · from BPI Payroll',
    ],
    phone: {
      buttons: [
        'Toggle theme',
        'MS',
        'Week',
        'Month',
        'Year',
        'Edit',
        'Emergency fund top-up Mar 8th, 2026 · ₱10,000.00 Scheduled · Manual · from BPI Payroll',
        'HMO dependent add-on Mar 20th, 2026 · ₱1,450.00 Scheduled · Manual · from BPI Payroll',
        'Rent Apr 1st, 2026 · ₱22,000.00 Scheduled · Manual · from BPI Payroll',
        'PLDT Fibr Apr 6th, 2026 · ₱1,899.00 Scheduled · Autopay · from BPI Payroll',
        'HSBC Red Mastercard statement Apr 9th, 2026 · ₱6,261.75 Card statement · from BPI Payroll',
        'Meralco Apr 10th, 2026 · ₱4,600.00 Scheduled · Manual · from BPI Payroll',
      ],
    },
  },
  // STU-687: the Due card opens collapsed behind its Show toggle (Hide once open, on the filters-shown surface), Spending
  // breakdown sits beside the view switch and Filters ends the one toolbar row; an empty household has no Due card.
  'transactions': {
    headings: ['Transactions'],
    titles: [],
    buttons: [
      'Toggle theme',
      'MS Mara Santos',
      'Add transaction',
      'Show',
      'To date',
      'Scheduled',
      'Spending breakdown',
      'View previous month',
      'View next month',
      'Filters',
      'Puregold weekly groceries',
      'Lunch, Kanto Freestyle',
      'Grab to Makati',
      'Mercury Drug',
      'Meralco February bill',
      'Palengke, Marikina market',
      'Netflix Standard',
      'Move to emergency fund',
      'Dinner, Manam',
      'Logo design, Kapé Co.',
      'PLDT Fibr',
      'S&R bulk run',
      'Shell V-Power',
      'Spotify Duo',
      'Water refill, 4 gallons',
      'Coffee, Yardstick',
      'Yaya salary, Feb 16–28',
      'Household fund, March',
      'March rent',
      'Previous',
      '1',
      'Next',
    ],
    phone: {
      buttons: [
        'Toggle theme',
        'MS',
        'Add transaction',
        'Show',
        'To date',
        'Scheduled',
        'Spending breakdown',
        'View previous month',
        'View next month',
        'Filters',
        'Puregold weekly groceries',
        'Lunch, Kanto Freestyle',
        'Grab to Makati',
        'Mercury Drug',
        'Meralco February bill',
        'Palengke, Marikina market',
        'Netflix Standard',
        'Move to emergency fund',
        'Dinner, Manam',
        'Logo design, Kapé Co.',
        'PLDT Fibr',
        'S&R bulk run',
        'Shell V-Power',
        'Spotify Duo',
        'Water refill, 4 gallons',
        'Coffee, Yardstick',
        'Yaya salary, Feb 16–28',
        'Household fund, March',
        'March rent',
        'Previous',
        '1',
        'Next',
      ],
    },
  },
  'transactions, filters shown': {
    headings: ['Transactions', 'Accounts', 'Transaction types', 'Categories', 'Entered by', 'Tag'],
    titles: [],
    buttons: [
      'Toggle theme',
      'MS Mara Santos',
      'Add transaction',
      'Hide',
      'Due and overdue 2',
      'Not posted yet 0',
      'Upcoming 16',
      'Subscriptions 2',
      'Installments 0',
      'Mark paid',
      'Change date',
      'Pay',
      'To date',
      'Scheduled',
      'Spending breakdown',
      'View previous month',
      'View next month',
      'Filters',
      'All accounts',
      'BPI Payroll (PHP)',
      'Metrobank Savings (PHP)',
      'GCash (PHP)',
      'Cash on hand (PHP)',
      'HSBC Red Mastercard (PHP)',
      'BDO Joint household (PHP)',
      'All types',
      'Income',
      'Expense',
      'Transfer',
      'All categories',
      'No category',
      'Dining out',
      'Groceries',
      'Health',
      'Household help',
      'Rent',
      'All 11 categories ▾',
      'Everyone',
      'Only mine',
      'Puregold weekly groceries',
      'Lunch, Kanto Freestyle',
      'Grab to Makati',
      'Mercury Drug',
      'Meralco February bill',
      'Palengke, Marikina market',
      'Netflix Standard',
      'Move to emergency fund',
      'Dinner, Manam',
      'Logo design, Kapé Co.',
      'PLDT Fibr',
      'S&R bulk run',
      'Shell V-Power',
      'Spotify Duo',
      'Water refill, 4 gallons',
      'Coffee, Yardstick',
      'Yaya salary, Feb 16–28',
      'Household fund, March',
      'March rent',
      'Previous',
      '1',
      'Next',
    ],
    phone: {
      buttons: [
        'Toggle theme',
        'MS',
        'Add transaction',
        'Hide',
        'Due and overdue 2',
        'Not posted yet 0',
        'Upcoming 16',
        'Subscriptions 2',
        'Installments 0',
        'Mark paid',
        'Change date',
        'Pay',
        'To date',
        'Scheduled',
        'Spending breakdown',
        'View previous month',
        'View next month',
        'Filters',
        'All accounts',
        'BPI Payroll (PHP)',
        'Metrobank Savings (PHP)',
        'GCash (PHP)',
        'Cash on hand (PHP)',
        'HSBC Red Mastercard (PHP)',
        'BDO Joint household (PHP)',
        'All types',
        'Income',
        'Expense',
        'Transfer',
        'All categories',
        'No category',
        'Dining out',
        'Groceries',
        'Health',
        'Household help',
        'Rent',
        'All 11 categories ▾',
        'Everyone',
        'Only mine',
        'Puregold weekly groceries',
        'Lunch, Kanto Freestyle',
        'Grab to Makati',
        'Mercury Drug',
        'Meralco February bill',
        'Palengke, Marikina market',
        'Netflix Standard',
        'Move to emergency fund',
        'Dinner, Manam',
        'Logo design, Kapé Co.',
        'PLDT Fibr',
        'S&R bulk run',
        'Shell V-Power',
        'Spotify Duo',
        'Water refill, 4 gallons',
        'Coffee, Yardstick',
        'Yaya salary, Feb 16–28',
        'Household fund, March',
        'March rent',
        'Previous',
        '1',
        'Next',
      ],
    },
  },
  'transactions, scheduled view': {
    headings: ['Transactions'],
    titles: [],
    buttons: [
      'Toggle theme',
      'MS Mara Santos',
      'Add transaction',
      'Show',
      'To date',
      'Scheduled',
      'Filters',
      'Mark paid',
      'Change date',
      'Mark received',
      'Charged',
      'Posted',
      'Previous',
      'Next',
    ],
    phone: {
      buttons: [
        'Toggle theme',
        'MS',
        'Add transaction',
        'Show',
        'To date',
        'Scheduled',
        'Filters',
        'Mark paid',
        'Change date',
        'Mark received',
        'Charged',
        'Posted',
        'Previous',
        'Next',
      ],
    },
  },
  'allocations, recurring': {
    headings: ['Allocations', 'Subscriptions', 'Cash expenses', 'Income & transfers'],
    titles: [],
    buttons: [
      'Toggle theme',
      'MS Mara Santos',
      'Add recurring entry',
      'Recurring',
      'Budgets',
      'Savings',
      'Wishlist',
      'Netflix Standard',
      'Charged',
      'Posted',
      'Spotify Duo',
      'Disney+ Premium',
      'Rent',
      'Mark paid',
      'Meralco',
      'PLDT Fibr',
      'Emergency fund top-up',
      'HMO dependent add-on',
      'Globe Postpaid',
      'Maynilad water',
      'Palengke run',
      'Yaya salary',
      'Gym membership',
      'Payroll',
      'Mark received',
    ],
    phone: {
      buttons: [
        'Toggle theme',
        'MS',
        'Add recurring entry',
        'Recurring',
        'Budgets',
        'Savings',
        'Wishlist',
        'Netflix Standard',
        'Charged',
        'Posted',
        'Spotify Duo',
        'Disney+ Premium',
        'Rent',
        'Mark paid',
        'Meralco',
        '+1',
        'PLDT Fibr',
        'Emergency fund top-up',
        'HMO dependent add-on',
        'Globe Postpaid',
        'Maynilad water',
        'Palengke run',
        'Yaya salary',
        'Gym membership',
        'Payroll',
        'Mark received',
      ],
    },
  },
  'allocations, budgets': {
    headings: ['Allocations', 'Budget envelopes'],
    titles: [],
    buttons: ['Toggle theme', 'MS Mara Santos', 'Add allocation', 'Recurring', 'Budgets', 'Savings', 'Wishlist'],
    phone: {
      buttons: ['Toggle theme', 'MS', 'Add allocation', 'Recurring', 'Budgets', 'Savings', 'Wishlist'],
    },
  },
  'allocations, savings': {
    headings: ['Allocations', 'Savings & investment targets'],
    titles: [],
    buttons: ['Toggle theme', 'MS Mara Santos', 'Add allocation', 'Recurring', 'Budgets', 'Savings', 'Wishlist'],
    phone: {
      buttons: ['Toggle theme', 'MS', 'Add allocation', 'Recurring', 'Budgets', 'Savings', 'Wishlist'],
    },
  },
  'allocations, wishlist': {
    headings: ['Allocations', 'Wishlist'],
    titles: [],
    buttons: [
      'Toggle theme',
      'MS Mara Santos',
      'Recurring',
      'Budgets',
      'Savings',
      'Wishlist',
      'Add item',
      'Savings target',
      'Budget envelope',
      'Mark as purchased',
      'Edit',
      'Delete',
    ],
    phone: {
      buttons: [
        'Toggle theme',
        'MS',
        'Recurring',
        'Budgets',
        'Savings',
        'Wishlist',
        'Add item',
        'Savings target',
        'Budget envelope',
        'Mark as purchased',
        'Edit',
        'Delete',
      ],
    },
  },
  'accounts': {
    headings: [
      'Accounts',
      'Individual (6)',
      'Debit (2)',
      'Credit (1)',
      'E-wallet (1)',
      'Cash (1)',
      'Loan (1)',
      'Shared (1)',
      'Debit (1)',
    ],
    titles: [],
    buttons: [
      'Toggle theme',
      'MS Mara Santos',
      'Add account',
      'BPI Payroll Checking Currency: PHP ₱84,250.40 Active',
      'Metrobank Savings Savings Currency: PHP ₱212,600.00 Active',
      'HSBC Red Mastercard Credit Currency: PHP Limit ₱120,000.00 +21 days to due −₱18,742.30 Active',
      'GCash E Wallet Currency: PHP Not counted ₱3,415.75 Active',
      'Cash on hand Cash Currency: PHP Not counted ₱1,860.00 Active',
      'Pag-IBIG housing loan Loan Owed ₱1,180,000.00 Payments left 217 Next due Mar 15, 2026 Currency: PHP −₱1,180,000.00 Active',
      'BDO Joint household Checking Currency: PHP Editor Shared by Jun R. ₱46,380.50 Active',
    ],
    phone: {
      buttons: [
        'Toggle theme',
        'MS',
        'Add account',
        'BPI Payroll Checking Active Currency: PHP ₱84,250.40',
        'Metrobank Savings Savings Active Currency: PHP ₱212,600.00',
        'HSBC Red Mastercard Credit Active Currency: PHP Limit ₱120,000.00 +21 days to due −₱18,742.30',
        'GCash E Wallet Active Currency: PHP Not counted ₱3,415.75',
        'Cash on hand Cash Active Currency: PHP Not counted ₱1,860.00',
        'Pag-IBIG housing loan Loan Active Owed ₱1,180,000.00 Payments left 217 Next due Mar 15, 2026 Currency: PHP −₱1,180,000.00',
        'BDO Joint household Checking Active Currency: PHP Editor Shared by Jun R. ₱46,380.50',
      ],
    },
  },
  'account, checking': {
    headings: ['BPI Payroll', 'Transactions'],
    titles: [],
    buttons: ['Toggle theme', 'MS Mara Santos', 'Previous', '1', 'Next'],
    phone: {
      buttons: ['Toggle theme', 'MS', 'Previous', '1', 'Next'],
    },
  },
  'account, credit card': {
    headings: ['HSBC Red Mastercard', 'Credit and statements', 'Transactions'],
    titles: [],
    buttons: ['Toggle theme', 'MS Mara Santos', 'Pay', 'Previous', '1', 'Next'],
    phone: {
      buttons: ['Toggle theme', 'MS', 'Pay', 'Previous', '1', 'Next'],
    },
  },
  'account, not found': {
    headings: [],
    titles: [],
    buttons: ['Toggle theme', 'MS Mara Santos'],
    phone: {
      buttons: ['Toggle theme', 'MS'],
    },
  },
  'household, dashboard': {
    headings: ['Your household', 'Accounts', 'March 2026', 'Next 30 days'],
    titles: [],
    buttons: ['Toggle theme', 'MS Mara Santos', 'Dashboard', 'Transactions', 'Upcoming', 'Monthly'],
    phone: {
      buttons: ['Toggle theme', 'MS', 'Dashboard', 'Transactions', 'Upcoming', 'Monthly'],
    },
  },
  'household, transactions': {
    headings: ['Your household', 'Transactions'],
    titles: [],
    buttons: [
      'Toggle theme',
      'MS Mara Santos',
      'Dashboard',
      'Transactions',
      'Upcoming',
      'Monthly',
      'Previous',
      'Next',
    ],
    phone: {
      buttons: ['Toggle theme', 'MS', 'Dashboard', 'Transactions', 'Upcoming', 'Monthly', 'Previous', 'Next'],
    },
  },
  'household, upcoming': {
    headings: ['Your household', 'Next 30 days'],
    titles: [],
    buttons: ['Toggle theme', 'MS Mara Santos', 'Dashboard', 'Transactions', 'Upcoming', 'Monthly'],
    phone: {
      buttons: ['Toggle theme', 'MS', 'Dashboard', 'Transactions', 'Upcoming', 'Monthly'],
    },
  },
  'household, monthly': {
    headings: ['Your household', 'March 2026'],
    titles: [],
    buttons: ['Toggle theme', 'MS Mara Santos', 'Dashboard', 'Transactions', 'Upcoming', 'Monthly'],
    phone: {
      buttons: ['Toggle theme', 'MS', 'Dashboard', 'Transactions', 'Upcoming', 'Monthly'],
    },
  },
  'forecast': {
    headings: ['Cash-flow timeline', 'Scheduled items'],
    titles: [],
    buttons: ['Toggle theme', 'MS Mara Santos', '30 days', '60 days', '90 days'],
    phone: {
      buttons: ['Toggle theme', 'MS', '30 days', '60 days', '90 days'],
    },
  },
  'settings': {
    headings: [
      'Settings',
      'Cash-flow timeline',
      'Export your data',
      'Categories',
      'Tags',
      'Household sharing',
      'People who can see your household',
      'Add a person',
    ],
    titles: [],
    buttons: [
      'Toggle theme',
      'MS Mara Santos',
      'JSON',
      'CSV (ZIP)',
      'Add category',
      'Edit',
      'Delete',
      'Add tag',
      'Recolour',
      'Look up',
    ],
    phone: {
      buttons: [
        'Toggle theme',
        'MS',
        'JSON',
        'CSV (ZIP)',
        'Add category',
        'Edit',
        'Delete',
        'Add tag',
        'Recolour',
        'Look up',
      ],
    },
  },
  'dashboard, empty': {
    headings: [
      'Dashboard',
      'Available cash',
      'Month to date',
      'Quick balances',
      'Cash-flow timeline',
      'Financial snapshot',
      'Today',
      'Projected',
      'Budget envelope status',
      'Upcoming payables',
    ],
    titles: [],
    buttons: ['Toggle theme', 'MS Mara Santos', 'Week', 'Month', 'Year', 'Edit'],
    phone: {
      buttons: ['Toggle theme', 'MS', 'Week', 'Month', 'Year', 'Edit'],
    },
  },
  'transactions, empty': {
    headings: ['Transactions', 'No transactions found'],
    titles: [],
    buttons: [
      'Toggle theme',
      'MS Mara Santos',
      'Add transaction',
      'To date',
      'Scheduled',
      'Spending breakdown',
      'View previous month',
      'View next month',
      'Filters',
    ],
    phone: {
      buttons: [
        'Toggle theme',
        'MS',
        'Add transaction',
        'To date',
        'Scheduled',
        'Spending breakdown',
        'View previous month',
        'View next month',
        'Filters',
      ],
    },
  },
  'allocations, recurring, empty': {
    // STU-692: the empty list's own next step, a primary button under its sentence.
    headings: ['Allocations'],
    titles: [],
    buttons: ['Toggle theme', 'MS Mara Santos', 'Add recurring entry', 'Recurring', 'Budgets', 'Savings', 'Wishlist', 'Add a recurring entry'],
    phone: {
      buttons: ['Toggle theme', 'MS', 'Add recurring entry', 'Recurring', 'Budgets', 'Savings', 'Wishlist', 'Add a recurring entry'],
    },
  },
  'allocations, budgets, empty': {
    // STU-692: the empty list's own next step, a primary button under its sentence.
    headings: ['Allocations', 'Budget envelopes'],
    titles: [],
    buttons: ['Toggle theme', 'MS Mara Santos', 'Add allocation', 'Recurring', 'Budgets', 'Savings', 'Wishlist', 'Create a budget envelope'],
    phone: {
      buttons: ['Toggle theme', 'MS', 'Add allocation', 'Recurring', 'Budgets', 'Savings', 'Wishlist', 'Create a budget envelope'],
    },
  },
  'allocations, savings, empty': {
    // STU-692: the empty list's own next step, a primary button under its sentence.
    headings: ['Allocations', 'Savings & investment targets'],
    titles: [],
    buttons: ['Toggle theme', 'MS Mara Santos', 'Add allocation', 'Recurring', 'Budgets', 'Savings', 'Wishlist', 'Create a savings target'],
    phone: {
      buttons: ['Toggle theme', 'MS', 'Add allocation', 'Recurring', 'Budgets', 'Savings', 'Wishlist', 'Create a savings target'],
    },
  },
  'accounts, empty': {
    // STU-692: the empty list's own next step, a primary button under its sentence.
    headings: ['Accounts'],
    titles: [],
    buttons: ['Toggle theme', 'MS Mara Santos', 'Add account', 'Add your first account'],
    phone: {
      buttons: ['Toggle theme', 'MS', 'Add account', 'Add your first account'],
    },
  },
  'dashboard, loading': {
    headings: [
      'Dashboard',
      'Available cash',
      'Month to date',
      'Quick balances',
      'Cash-flow timeline',
      'Financial snapshot',
      'Today',
      'Projected',
      'Budget envelope status',
      'Upcoming payables',
    ],
    titles: [],
    buttons: ['Toggle theme', 'MS Mara Santos', 'Week', 'Month', 'Year', 'Edit'],
    phone: {
      buttons: ['Toggle theme', 'MS', 'Week', 'Month', 'Year', 'Edit'],
    },
  },
  'transactions, loading': {
    headings: [],
    titles: [],
    buttons: ['Toggle theme', 'MS Mara Santos'],
    phone: {
      buttons: ['Toggle theme', 'MS'],
    },
  },
  'account, loading': {
    headings: ['BPI Payroll', 'Transactions'],
    titles: [],
    buttons: ['Toggle theme', 'MS Mara Santos'],
    phone: {
      buttons: ['Toggle theme', 'MS'],
    },
  },
  'dashboard, error': {
    headings: ['Error loading data'],
    titles: [],
    buttons: ['Toggle theme', 'MS Mara Santos', 'Retry'],
    phone: {
      buttons: ['Toggle theme', 'MS', 'Retry'],
    },
  },
  'transactions, error': {
    headings: ['Transactions'],
    titles: [],
    buttons: [
      'Toggle theme',
      'MS Mara Santos',
      'Add transaction',
      'Show',
      'To date',
      'Scheduled',
      'Spending breakdown',
      'View previous month',
      'View next month',
      'Filters',
      'Retry',
    ],
    phone: {
      buttons: [
        'Toggle theme',
        'MS',
        'Add transaction',
        'Show',
        'To date',
        'Scheduled',
        'Spending breakdown',
        'View previous month',
        'View next month',
        'Filters',
        'Retry',
      ],
    },
  },
  'dashboard, quick balances editor': {
    headings: [
      'Dashboard',
      'Available cash',
      'Month to date',
      'Quick balances',
      'Cash-flow timeline',
      'Financial snapshot',
      'Today',
      'Projected',
      'Budget envelope status',
      'Upcoming payables',
      'Also coming up',
    ],
    titles: [],
    buttons: [
      'Toggle theme',
      'MS Mara Santos',
      'Week',
      'Month',
      'Year',
      'Cancel',
      'Save',
      '‹',
      '›',
      '✕',
      '+ Add account',
      'Emergency fund top-up Mar 8th, 2026 · ₱10,000.00 Scheduled · Manual · from BPI Payroll',
      'HMO dependent add-on Mar 20th, 2026 · ₱1,450.00 Scheduled · Manual · from BPI Payroll',
      'Rent Apr 1st, 2026 · ₱22,000.00 Scheduled · Manual · from BPI Payroll',
      'PLDT Fibr Apr 6th, 2026 · ₱1,899.00 Scheduled · Autopay · from BPI Payroll',
      'HSBC Red Mastercard statement Apr 9th, 2026 · ₱6,261.75 Card statement · from BPI Payroll',
      'Meralco Apr 10th, 2026 · ₱4,600.00 Scheduled · Manual · from BPI Payroll',
    ],
    phone: {
      buttons: [
        'Toggle theme',
        'MS',
        'Week',
        'Month',
        'Year',
        'Cancel',
        'Save',
        '‹',
        '›',
        '✕',
        '+ Add account',
        'Emergency fund top-up Mar 8th, 2026 · ₱10,000.00 Scheduled · Manual · from BPI Payroll',
        'HMO dependent add-on Mar 20th, 2026 · ₱1,450.00 Scheduled · Manual · from BPI Payroll',
        'Rent Apr 1st, 2026 · ₱22,000.00 Scheduled · Manual · from BPI Payroll',
        'PLDT Fibr Apr 6th, 2026 · ₱1,899.00 Scheduled · Autopay · from BPI Payroll',
        'HSBC Red Mastercard statement Apr 9th, 2026 · ₱6,261.75 Card statement · from BPI Payroll',
        'Meralco Apr 10th, 2026 · ₱4,600.00 Scheduled · Manual · from BPI Payroll',
      ],
    },
  },
  'sign in': {
    headings: ['Sign in'],
    titles: [],
    buttons: ['Sign in', 'Sign in as demo user', 'Sign in as demo partner'],
  },
  'sign in, email not verified': {
    headings: ['Sign in'],
    titles: [],
    buttons: ['Resend verification email', 'Sign in', 'Sign in as demo user', 'Sign in as demo partner'],
  },
  'sign up': {
    headings: ['Tally & Trace', 'Create your account'],
    titles: [],
    buttons: ['Show password', 'Create account'],
  },
  'verify email, loading': {
    headings: [],
    titles: [],
    buttons: [],
  },
  'verify email, success': {
    headings: ['Email verified!'],
    titles: [],
    buttons: ['Continue now'],
  },
  'verify email, error': {
    headings: ['Verification failed'],
    titles: [],
    buttons: ['Go to login'],
  },
  'onboarding, step 1': {
    headings: ['Welcome to your dashboard'],
    titles: ['Welcome to your dashboard'],
    buttons: ['Skip', 'Previous', 'Next'],
  },
  'onboarding, step 2': {
    headings: ['Manage your accounts'],
    titles: ['Manage your accounts'],
    buttons: ['Skip', 'Previous', 'Next'],
  },
  'onboarding, step 3': {
    headings: ['Record transactions'],
    titles: ['Record transactions'],
    buttons: ['Skip', 'Previous', 'Next'],
  },
  'onboarding, step 4': {
    headings: ['Set financial goals'],
    titles: ['Set financial goals'],
    buttons: ['Skip', 'Previous', 'Next'],
  },
  'onboarding, step 5': {
    headings: ['Available cash'],
    titles: ['Available cash'],
    buttons: ['Skip', 'Previous', 'Next'],
  },
  'onboarding, step 6': {
    headings: ['Budget envelope status'],
    titles: ['Budget envelope status'],
    buttons: ['Skip', 'Previous', 'Next'],
  },
  'onboarding, step 7': {
    headings: ['Upcoming planned expenses'],
    titles: ['Upcoming planned expenses'],
    buttons: ['Skip', 'Previous', 'Next'],
  },
  'onboarding, step 8': {
    headings: ['Spending breakdown'],
    titles: ['Spending breakdown'],
    buttons: ['Skip', 'Previous', 'Get started'],
  },
  'add transaction dialog': {
    headings: ['Add transaction'],
    titles: ['Add transaction'],
    buttons: [
      'Close transaction modal',
      'BPI Payroll(PHP)',
      'Metrobank Savings(PHP)',
      'GCash(PHP)',
      'Cash on hand(PHP)',
      'HSBC Red Mastercard(PHP)',
      'BDO Joint household(PHP)',
      'Change',
      'Income',
      'Expense',
      'Transfer',
      'Household',
      'Japan trip',
      'Add transaction',
      'Save and add another',
      'Cancel',
    ],
  },
  'add transaction dialog, savings account': {
    headings: ['Add transaction'],
    titles: ['Add transaction'],
    buttons: [
      'Close transaction modal',
      'Change',
      'Income',
      'Expense',
      'Transfer',
      'Switch to transfer',
      'Household',
      'Japan trip',
      'Add transaction',
      'Save and add another',
      'Cancel',
    ],
  },
  'add transaction dialog, transfer': {
    headings: ['Add transaction'],
    titles: ['Add transaction'],
    buttons: [
      'Close transaction modal',
      'BPI Payroll(PHP)',
      'Metrobank Savings(PHP)',
      'GCash(PHP)',
      'Cash on hand(PHP)',
      'HSBC Red Mastercard(PHP)',
      'BDO Joint household(PHP)',
      'Change',
      'Income',
      'Expense',
      'Transfer',
      'Household',
      'Japan trip',
      'Add transaction',
      'Save and add another',
      'Cancel',
    ],
  },
  'add transaction dialog, installment': {
    headings: ['Add transaction'],
    titles: ['Add transaction'],
    buttons: [
      'Close transaction modal',
      'Change',
      'Income',
      'Expense',
      'Transfer',
      'Household',
      'Japan trip',
      '3',
      '6',
      '12',
      '24',
      'Add transaction',
      'Save and add another',
      'Cancel',
    ],
  },
  'add transaction, refused save': {
    headings: ['Transactions'],
    titles: [],
    buttons: [
      'Toggle theme',
      'MS Mara Santos',
      'Add transaction',
      'Show',
      'To date',
      'Scheduled',
      'Spending breakdown',
      'View previous month',
      'View next month',
      'Filters',
      'Puregold weekly groceries',
      'Lunch, Kanto Freestyle',
      'Grab to Makati',
      'Mercury Drug',
      'Meralco February bill',
      'Palengke, Marikina market',
      'Netflix Standard',
      'Move to emergency fund',
      'Dinner, Manam',
      'Logo design, Kapé Co.',
      'PLDT Fibr',
      'S&R bulk run',
      'Shell V-Power',
      'Spotify Duo',
      'Water refill, 4 gallons',
      'Coffee, Yardstick',
      'Yaya salary, Feb 16–28',
      'Household fund, March',
      'March rent',
      'Previous',
      '1',
      'Next',
      'Edit',
      'Discard',
    ],
    phone: {
      buttons: [
        'Toggle theme',
        'MS',
        'Add transaction',
        'Show',
        'To date',
        'Scheduled',
        'Spending breakdown',
        'View previous month',
        'View next month',
        'Filters',
        'Puregold weekly groceries',
        'Lunch, Kanto Freestyle',
        'Grab to Makati',
        'Mercury Drug',
        'Meralco February bill',
        'Palengke, Marikina market',
        'Netflix Standard',
        'Move to emergency fund',
        'Dinner, Manam',
        'Logo design, Kapé Co.',
        'PLDT Fibr',
        'S&R bulk run',
        'Shell V-Power',
        'Spotify Duo',
        'Water refill, 4 gallons',
        'Coffee, Yardstick',
        'Yaya salary, Feb 16–28',
        'Household fund, March',
        'March rent',
        'Previous',
        '1',
        'Next',
        'Edit',
        'Discard',
      ],
    },
  },
  'add transaction dialog, reopened with the reason': {
    headings: ['Add transaction'],
    titles: ['Add transaction'],
    buttons: [
      'Close transaction modal',
      'Change',
      'Income',
      'Expense',
      'Transfer',
      'Household',
      'Japan trip',
      'Add transaction',
      'Save and add another',
      'Cancel',
    ],
  },
  'add transaction dialog, empty state trigger': {
    headings: ['Add transaction'],
    titles: ['Add transaction'],
    buttons: [
      'Close transaction modal',
      'BPI Payroll(PHP)',
      'Metrobank Savings(PHP)',
      'GCash(PHP)',
      'Cash on hand(PHP)',
      'HSBC Red Mastercard(PHP)',
      'BDO Joint household(PHP)',
      'Change',
      'Income',
      'Expense',
      'Transfer',
      'Household',
      'Japan trip',
      'Add transaction',
      'Save and add another',
      'Cancel',
    ],
  },
  'transaction actions dialog': {
    headings: ['Transaction actions', 'Dates', 'Details'],
    titles: ['Transaction actions'],
    buttons: ['Close actions modal', 'Upload receipt', 'Mark as not posted', 'Edit transaction', 'Delete transaction'],
  },
  'transaction actions dialog, transfer': {
    headings: ['Transaction actions', 'Dates', 'Details'],
    titles: ['Transaction actions'],
    buttons: ['Close actions modal', 'Upload receipt', 'Mark as not posted', 'Edit transaction', 'Delete transaction'],
  },
  'transaction actions dialog, not posted': {
    headings: ['Transaction actions', 'Dates', 'Details'],
    titles: ['Transaction actions'],
    buttons: ['Close actions modal', 'Upload receipt', 'Mark as posted', 'Edit transaction', 'Delete transaction'],
  },
  'transaction actions dialog, posting form': {
    headings: ['Transaction actions', 'Dates', 'Details'],
    titles: ['Transaction actions'],
    buttons: [
      'Close actions modal',
      'Upload receipt',
      'Mark as posted',
      'Edit transaction',
      'Delete transaction',
      'Use projected amount',
      'Save posted amount',
      'Cancel',
    ],
  },
  'transaction actions dialog, read only': {
    headings: ['Transaction actions', 'Dates', 'Details'],
    titles: ['Transaction actions'],
    buttons: ['Close actions modal', 'Edit transaction'],
  },
  'edit transaction dialog': {
    headings: ['Edit transaction'],
    titles: ['Edit transaction'],
    buttons: [
      'Close transaction modal',
      'Change',
      'Income',
      'Expense',
      'Transfer',
      'Household',
      'Japan trip',
      'Save changes',
      'Cancel',
    ],
  },
  'delete transaction confirm': {
    headings: ['Delete transaction?'],
    titles: ['Delete transaction?'],
    buttons: ['Cancel', 'Delete transaction'],
  },
  'spending breakdown dialog': {
    headings: ['Spending breakdown'],
    titles: ['Spending breakdown'],
    buttons: [
      'Close',
      'Rent ₱22,000.00 42.5%',
      'Groceries ₱10,990.30 21.2%',
      'Utilities ₱6,871.65 13.3%',
      'Household help ₱4,500.00 8.7%',
      'Transport ₱2,936.00 5.7%',
      'Dining out ₱2,770.00 5.3%',
      'Health ₱965.25 1.9%',
      'Subscriptions ₱788.00 1.5%',
    ],
  },
  'mark paid dialog': {
    headings: ['Mark Emergency fund top-up as paid'],
    titles: ['Mark Emergency fund top-up as paid'],
    buttons: ['Close', 'Mark paid', 'Cancel'],
  },
  'pay dialog': {
    headings: ['Pay HSBC Red Mastercard'],
    titles: ['Pay HSBC Red Mastercard'],
    buttons: ['Close', 'Pay', 'Cancel'],
  },
  'change date dialog': {
    headings: ['Change date: Emergency fund top-up'],
    titles: ['Change date: Emergency fund top-up'],
    buttons: ['Close', 'Save'],
  },
  'installment review dialog': {
    headings: ['Turn on auto-post for Laptop, 12 months (HSBC Red Mastercard)'],
    titles: ['Turn on auto-post for Laptop, 12 months (HSBC Red Mastercard)'],
    buttons: ['Close', 'Move the next date instead', 'Record 1 month and turn on auto-post', 'Cancel'],
  },
  'add recurring entry dialog': {
    headings: ['Add recurring entry'],
    titles: ['Add recurring entry'],
    buttons: [
      'Close allocation modal',
      'Expense',
      'Income',
      'Keep running',
      'On date',
      'After runs',
      'Household',
      'Japan trip',
      'Active',
      'Save recurring entry',
      'Cancel',
    ],
  },
  'edit recurring entry dialog': {
    headings: ['Add recurring entry'],
    titles: ['Add recurring entry'],
    buttons: [
      'Close allocation modal',
      'Expense',
      'Income',
      'Keep running',
      'On date',
      'After runs',
      'Household',
      'Japan trip',
      'Active',
      'Update recurring entry',
      'Cancel',
      'Delete recurring entry',
    ],
  },
  'charged dialog': {
    headings: ['Record Netflix Standard'],
    titles: ['Record Netflix Standard'],
    buttons: ['Close', 'Charged', 'Posted', 'Cancel'],
  },
  'add budget envelope dialog': {
    headings: ['Create budget envelope'],
    titles: ['Create budget envelope'],
    buttons: [
      'Close allocation modal',
      'Dining out',
      'Groceries',
      'Health',
      'Household help',
      'Rent',
      'All 11 categories ▾',
      'Daily',
      'Weekly',
      'Monthly',
      'Quarterly',
      'Active',
      'Create budget envelope',
      'Cancel',
    ],
  },
  'add savings tracker dialog': {
    headings: ['Create savings tracker'],
    titles: ['Create savings tracker'],
    buttons: [
      'Close allocation modal',
      "Target account balance Track a single account's balance against a goal.",
      'Combined account total Watch a collection of accounts grow together.',
      'Savings transactions total Sum the transfers tagged as savings over time.',
      'Active',
      'Create savings tracker',
      'Cancel',
    ],
  },
  'budget envelope actions dialog': {
    headings: ['Dining out', 'Budget snapshot', 'Details'],
    titles: ['Dining out'],
    buttons: ['Close allocation actions modal', 'Pause allocation', 'Edit allocation', 'Delete allocation'],
  },
  'savings tracker actions dialog': {
    headings: ['Emergency fund', 'Current progress', 'Details'],
    titles: ['Emergency fund'],
    buttons: ['Close allocation actions modal', 'Pause allocation', 'Edit allocation', 'Delete allocation'],
  },
  'edit allocation dialog': {
    headings: ['Edit allocation'],
    titles: ['Edit allocation'],
    buttons: [
      'Close allocation modal',
      'Dining out',
      'Groceries',
      'Health',
      'Household help',
      'Rent',
      'All 11 categories ▾',
      'Daily',
      'Weekly',
      'Monthly',
      'Quarterly',
      'Active',
      'Update allocation',
      'Cancel',
    ],
  },
  'add wishlist item dialog': {
    headings: ['Add item'],
    titles: ['Add item'],
    buttons: ['Add', 'Cancel'],
  },
  'edit wishlist item dialog': {
    headings: ['Edit item'],
    titles: ['Edit item'],
    buttons: ['Update', 'Cancel'],
  },
  'add account dialog': {
    headings: ['Create account'],
    titles: ['Create account'],
    buttons: ['Household', 'Japan trip', 'Active', 'Create account', 'Cancel'],
  },
  'add account dialog, credit card': {
    headings: ['Create account', 'Credit card settings'],
    titles: ['Create account'],
    buttons: ['Household', 'Japan trip', 'Hide details', 'Active', 'Create account', 'Cancel'],
  },
  'account actions dialog': {
    headings: ['BPI Payroll', 'Balance', 'Status'],
    titles: ['BPI Payroll'],
    buttons: [
      'Close account actions modal',
      'View transactions',
      'Mark as inactive',
      'Edit account',
      'Share account',
      'Delete account',
    ],
  },
  'card account actions dialog': {
    headings: ['HSBC Red Mastercard', 'Balance', 'Status', 'Statements'],
    titles: ['HSBC Red Mastercard'],
    buttons: [
      'Close account actions modal',
      'View transactions',
      'Mark as inactive',
      'Edit account',
      'Share account',
      'Delete account',
    ],
  },
  'shared account actions dialog': {
    headings: ['BDO Joint household', 'Balance', 'Status'],
    titles: ['BDO Joint household'],
    buttons: ['Close account actions modal', 'View transactions'],
  },
  'loan account actions dialog': {
    headings: ['Pag-IBIG housing loan', 'Balance', 'Status', 'Next due dates'],
    titles: ['Pag-IBIG housing loan'],
    buttons: [
      'Close account actions modal',
      'Change date',
      'Record payment',
      'Extra principal',
      'View transactions',
      'Mark as inactive',
      'Edit account',
      'Share account',
      'Delete account',
    ],
  },
  'loan record payment form': {
    headings: ['Pag-IBIG housing loan', 'Balance', 'Status', 'Next due dates', 'Record payment'],
    titles: ['Pag-IBIG housing loan'],
    buttons: [
      'Close account actions modal',
      'Change date',
      'Record payment',
      'Extra principal',
      'Save',
      'Cancel',
      'View transactions',
      'Mark as inactive',
      'Edit account',
      'Share account',
      'Delete account',
    ],
  },
  'edit account dialog': {
    headings: ['Edit account', 'Credit card settings'],
    titles: ['Edit account'],
    buttons: ['Household', 'Japan trip', 'Show details', 'Active', 'Update account', 'Cancel'],
  },
  'share account dialog': {
    headings: ['Share BPI Payroll', 'People with access', 'Add a person'],
    titles: ['Share BPI Payroll'],
    buttons: ['Close share dialog', 'Remove', 'Look up'],
  },
  'add category dialog': {
    headings: ['Add category'],
    titles: ['Add category'],
    buttons: [
      'Colour #2563eb',
      'Colour #7c3aed',
      'Colour #16a34a',
      'Colour #f97316',
      'Colour #db2777',
      'Colour #0891b2',
      'Colour #ca8a04',
      'Colour #dc2626',
      'Create',
      'Cancel',
    ],
  },
  'add tag dialog': {
    headings: ['Add tag'],
    titles: ['Add tag'],
    buttons: [
      'Colour #2563eb',
      'Colour #7c3aed',
      'Colour #16a34a',
      'Colour #f97316',
      'Colour #db2777',
      'Colour #0891b2',
      'Colour #ca8a04',
      'Colour #dc2626',
      'Create',
      'Cancel',
    ],
  },
  'edit tag dialog': {
    headings: ['Edit tag'],
    titles: ['Edit tag'],
    buttons: [
      'Colour #2563eb',
      'Colour #7c3aed',
      'Colour #16a34a',
      'Colour #f97316',
      'Colour #db2777',
      'Colour #0891b2',
      'Colour #ca8a04',
      'Colour #dc2626',
      'Update',
      'Cancel',
    ],
  },
  'payable dialog': {
    headings: ['Emergency fund top-up'],
    titles: ['Emergency fund top-up'],
    buttons: ['Close'],
  },
}

/** What `name` should show in this project. */
function expected(name: string, project: string): Expected {
  const all = EXPECTED[name]
  if (!all) throw new Error(`no expectation for ${name}`)
  const { phone, ...desktop } = all
  return project === 'phone' ? { ...desktop, ...phone } : desktop
}

/** Set to a file path to write what each surface shows, one JSON line per surface and project. */
const DUMP = process.env.HEADING_CASE_DUMP

/** Opens the surface and reads it once it has settled. */
async function look(page: Page, s: Surface): Promise<Seen> {
  await s.open(page)
  const seen = await settled(page, () => (s.dialog ? top(page) : page.locator('body')))
  if (DUMP) {
    const prior = fs.existsSync(DUMP) ? fs.readFileSync(DUMP, 'utf8') : ''
    fs.writeFileSync(DUMP, `${prior}${JSON.stringify({ project: test.info().project.name, name: s.name, seen })}\n`)
  }
  return seen
}

/** A dialog sits in a fixed layer, so it gets a viewport screenshot; a page gets a full-page one. */
async function capture(page: Page, s: Surface, scenario: string): Promise<void> {
  const name = `${scenario}-${s.name.replace(/[^a-z0-9]+/gi, '-')}`
  if (s.dialog) await viewportShot(page, name)
  else await shot(page, name)
}

// ─── AC1: headings are sentence case ───────────────────────────────────────────────────────────────
for (const s of SURFACES) {
  test(`headings are sentence case: ${s.name}`, async ({ page }, testInfo) => {
    const seen = await look(page, s)
    expect(seen.headings, `${s.name}: every heading and card title, in order`).toEqual(expected(s.name, testInfo.project.name).headings)
    await capture(page, s, 'headings')
  })
}

// ─── AC2: dialogs and buttons are sentence case ────────────────────────────────────────────────────
for (const s of SURFACES) {
  test(`dialogs and buttons are sentence case: ${s.name}`, async ({ page }, testInfo) => {
    const seen = await look(page, s)
    const want = expected(s.name, testInfo.project.name)
    expect.soft(seen.titles, `${s.name}: every dialog title`).toEqual(want.titles)
    expect.soft(seen.buttons, `${s.name}: every button, controls outside main included`).toEqual(want.buttons)
    await capture(page, s, 'buttons')
  })
}

// ─── AC3: a dialog keeps its trigger's verb ─────────────────────────────────────────────────────────

/** The transaction dialog's primary submit button. */
const submitOf = (page: Page): Locator => top(page).locator('button[type="submit"][data-variant="primary"]')

test("a dialog keeps its trigger's verb: Add transaction opens Add transaction", async ({ page }) => {
  await openPage(page, '/transactions')
  const trigger = page.getByTestId('page-header').getByRole('button', { name: 'Add transaction', exact: true })
  await expect(trigger, 'the trigger reads Add transaction').toHaveText('Add transaction')
  await trigger.click()
  await expect(top(page).getByRole('heading', { level: 2 }).first(), 'the dialog is titled Add transaction').toHaveText('Add transaction')
  await expect(submitOf(page), 'the submit button reads Add transaction').toHaveText('Add transaction')
  await expect(top(page).getByText(/create transaction/i), 'nothing in the dialog says Create').toHaveCount(0)
  await viewportShot(page, 'verb-add')
})

test("a dialog keeps its trigger's verb: the empty list's Add transaction opens Add transaction", async ({ page }) => {
  await openPage(page, '/transactions', emptyHousehold)
  const trigger = page.locator('main').getByRole('button', { name: 'Add transaction', exact: true })
  await expect(trigger, 'the header and the empty list each offer Add transaction').toHaveCount(2)
  await trigger.last().click()
  await expect(top(page).getByRole('heading', { level: 2 }).first(), 'the dialog is titled Add transaction').toHaveText('Add transaction')
  await expect(submitOf(page), 'the submit button reads Add transaction').toHaveText('Add transaction')
  await viewportShot(page, 'verb-add-empty')
})

test("a dialog keeps its trigger's verb: Edit transaction opens Edit transaction with Save changes", async ({ page }) => {
  await openActions(page, 'Grab to Makati')
  const trigger = top(page).getByRole('button', { name: 'Edit transaction', exact: true })
  await expect(trigger, 'the action reads Edit transaction').toHaveText('Edit transaction')
  await trigger.click()
  await expect(top(page).getByRole('heading', { level: 2 }).first(), 'the dialog is titled Edit transaction').toHaveText('Edit transaction')
  await expect(submitOf(page), 'the submit button reads Save changes').toHaveText('Save changes')
  await expect(top(page).getByRole('button', { name: /add transaction|update transaction/i }), 'no Add or Update in the edit dialog').toHaveCount(0)
  await viewportShot(page, 'verb-edit')
})

// ─── AC4: case changes preserve actions ─────────────────────────────────────────────────────────────

/**
 * The bodies Add transaction and Save changes send for the inputs below, as origin/main (bf2f991) sent them from
 * Create Transaction and Update Transaction, recorded from a run of these two tests on main.
 */
const MAIN_CREATE_BODY: Record<string, unknown> = {
  account_id: 11,
  amount: 120,
  currency: 'PHP',
  description: 'Heading case check',
  transaction_type: 'debit',
  transaction_date: '2026-03-12T00:00:00.000Z',
  posting_date: '2026-03-12T02:00:00.000Z',
  is_posted: true,
  transfer_fee: 0,
  transfer_from_account_id: null,
  transfer_to_account_id: null,
  tag_ids: [],
  projected_amount: 120,
  projected_currency: 'PHP',
  exchange_rate: 1,
}
const MAIN_EDIT_BODY: Record<string, unknown> = {
  account_id: 13,
  amount: 286,
  currency: 'PHP',
  description: 'Grab to Makati and back',
  transaction_type: 'debit',
  transaction_date: '2026-03-11T00:00:00.000Z',
  posting_date: '2026-03-12T02:00:00.000Z',
  is_posted: true,
  transfer_fee: 0,
  transfer_from_account_id: null,
  transfer_to_account_id: null,
  category_id: 25,
  projected_amount: 286,
  projected_currency: 'PHP',
  exchange_rate: 1,
}

const RIDE_ID = household.transactions.find((t) => t.view !== 'limited' && t.description === 'Grab to Makati')?.id ?? 0
const MERALCO = household.entries.find((e) => e.view !== 'limited' && e.name === 'Meralco')
/** The update Meralco's form sends, answered with the entry as it was. */
const meralcoUpdate = (): ApiRoute[] => (MERALCO ? [apiRoute<BudgetEntry>('PUT', `/budget-entries/${MERALCO.id}`, MERALCO)] : [])

async function fillTransaction(page: Page): Promise<void> {
  await top(page).getByPlaceholder('Add notes about this transaction').fill('Heading case check')
  await pickAccount(page, 'BPI Payroll')
  await top(page).locator('input[type="number"][placeholder="0.00"]').first().fill('120')
}

test('case changes preserve actions: Add transaction sends the same create as on main', async ({ page }, testInfo) => {
  const api = await (async () => {
    await openAdd(page)
    return mockApi(page, [])
  })()
  await fillTransaction(page)
  await submitOf(page).click()
  await expect.poll(() => api.bodies('POST', '/transactions/').length, { message: 'one create is sent' }).toBe(1)
  const body = api.bodies('POST', '/transactions/')[0]
  if (DUMP) fs.writeFileSync(`${DUMP}.create-${testInfo.project.name}.json`, JSON.stringify(body))
  expect(body, 'the create body').toEqual(MAIN_CREATE_BODY)
  await viewportShot(page, 'action-create')
})

test('case changes preserve actions: Save changes sends the same update as on main', async ({ page }, testInfo) => {
  await openActions(page, 'Grab to Makati')
  const api = await mockApi(page, [])
  await top(page).getByRole('button', { name: named('edit transaction') }).click()
  await top(page).getByPlaceholder('Add notes about this transaction').fill('Grab to Makati and back')
  await submitOf(page).click()
  await expect.poll(() => api.bodies('PUT', `/transactions/${RIDE_ID}`).length, { message: 'one update is sent' }).toBe(1)
  const body = api.bodies('PUT', `/transactions/${RIDE_ID}`)[0]
  if (DUMP) fs.writeFileSync(`${DUMP}.edit-${testInfo.project.name}.json`, JSON.stringify(body))
  expect(body, 'the update body').toEqual(MAIN_EDIT_BODY)
  await viewportShot(page, 'action-edit')
})

interface ActionCase {
  /** The renamed control, by its new text. */
  name: string
  /** Opens the surface the control is on and returns the control. */
  open: (page: Page) => Promise<Locator>
  /** Checks what clicking it did. */
  effect: (page: Page) => Promise<void>
}

/** How often each request was sent since the page opened. */
const sent = (page: Page): { count: (method: string, path: string) => number } => {
  const seen: string[] = []
  page.on('request', (r) => {
    const url = new URL(r.url())
    if (url.pathname.startsWith('/api/v1/')) seen.push(`${r.method()} ${url.pathname.slice('/api/v1'.length)}`)
  })
  return { count: (method, path) => seen.filter((s) => s === `${method} ${path}`).length }
}
const requests = new WeakMap<Page, ReturnType<typeof sent>>()
const countOf = (page: Page, method: string, path: string): number => requests.get(page)?.count(method, path) ?? 0

const ACTIONS: ActionCase[] = [
  {
    name: 'Add transaction',
    open: async (p) => (await openPage(p, '/transactions'), p.getByTestId('page-header').getByRole('button', { name: 'Add transaction', exact: true })),
    effect: async (p) => expect(top(p).getByRole('heading', { name: 'Add transaction', exact: true }), 'the add dialog opens').toBeVisible(),
  },
  {
    name: 'Add transaction (submit)',
    open: async (p) => (await openAdd(p), await fillTransaction(p), submitOf(p)),
    effect: async (p) => expect.poll(() => countOf(p, 'POST', '/transactions/'), { message: 'the transaction is created' }).toBe(1),
  },
  {
    name: 'Edit transaction',
    open: async (p) => (await openActions(p, 'Grab to Makati'), top(p).getByRole('button', { name: 'Edit transaction', exact: true })),
    effect: async (p) => expect(top(p).getByTestId('transaction-date'), 'the edit form holds the row').toHaveValue('2026-03-11'),
  },
  {
    name: 'Save changes',
    open: async (p) => {
      await openActions(p, 'Grab to Makati')
      await top(p).getByRole('button', { name: 'Edit transaction', exact: true }).click()
      return submitOf(p)
    },
    effect: async (p) => expect.poll(() => countOf(p, 'PUT', `/transactions/${RIDE_ID}`), { message: 'the transaction is updated' }).toBe(1),
  },
  {
    name: 'Delete transaction',
    open: async (p) => (await openActions(p, 'Grab to Makati'), top(p).getByRole('button', { name: 'Delete transaction', exact: true })),
    effect: async (p) => expect(p.getByRole('alertdialog').getByRole('heading', { name: 'Delete transaction?' }), 'the delete is confirmed first').toBeVisible(),
  },
  {
    name: 'Mark as posted',
    open: async (p) => (await openActions(p, 'Grab to Makati', withUnpostedRide(household)), top(p).getByRole('button', { name: 'Mark as posted', exact: true })),
    effect: async (p) => expect(top(p).getByRole('button', { name: 'Save posted amount', exact: true }), 'the posting form opens').toBeVisible(),
  },
  {
    name: 'Save posted amount',
    open: async (p) => {
      await openActions(p, 'Grab to Makati', withUnpostedRide(household))
      await top(p).getByRole('button', { name: 'Mark as posted', exact: true }).click()
      return top(p).getByRole('button', { name: 'Save posted amount', exact: true })
    },
    effect: async (p) => expect.poll(() => countOf(p, 'PUT', `/transactions/${RIDE_ID}`), { message: 'the posting is saved' }).toBe(1),
  },
  {
    name: 'Switch to transfer',
    open: async (p) => (await openAdd(p), await pickAccount(p, 'Metrobank Savings'), top(p).getByRole('button', { name: 'Switch to transfer', exact: true })),
    effect: async (p) => expect(top(p).getByRole('group', { name: 'Transaction type' }).getByRole('button', { name: /transfer/i }), 'the type is Transfer').toHaveAttribute('aria-pressed', 'true'),
  },
  {
    name: 'Add account',
    open: async (p) => (await openPage(p, '/accounts'), p.getByRole('button', { name: 'Add account', exact: true })),
    effect: async (p) => expect(top(p).getByRole('heading', { name: 'Create account', exact: true }), 'the account form opens').toBeVisible(),
  },
  {
    name: 'Create account',
    open: async (p) => {
      await openPage(p, '/accounts', household, [createAccountRoute([{ ...household.accounts[1], id: 90, name: 'Maya savings' }])])
      await p.getByRole('button', { name: 'Add account', exact: true }).click()
      await top(p).getByPlaceholder('Enter account name').fill('Maya savings')
      return top(p).getByRole('button', { name: 'Create account', exact: true })
    },
    effect: async (p) => expect.poll(() => countOf(p, 'POST', '/accounts/'), { message: 'the account is created' }).toBe(1),
  },
  {
    name: 'Update account',
    open: async (p) => {
      await openDialog(p, '/accounts', (q) => accountButton(q, 'BPI Payroll'))
      await top(p).getByRole('button', { name: 'Edit account', exact: true }).click()
      return top(p).getByRole('button', { name: 'Update account', exact: true })
    },
    effect: async (p) => expect.poll(() => countOf(p, 'PUT', '/accounts/11'), { message: 'the account is updated' }).toBe(1),
  },
  {
    name: 'Add recurring entry',
    open: async (p) => (await openPage(p, '/allocations?tab=recurring'), p.getByRole('button', { name: 'Add recurring entry', exact: true })),
    effect: async (p) => expect(top(p).getByRole('heading', { name: 'Add recurring entry', exact: true }), 'the recurring form opens').toBeVisible(),
  },
  {
    name: 'Save recurring entry',
    open: async (p) => {
      await openPage(p, '/allocations?tab=recurring')
      await p.getByRole('button', { name: 'Add recurring entry', exact: true }).click()
      await top(p).locator('input[type="text"]').first().fill('Water delivery')
      await top(p).locator('select').first().selectOption('11')
      await top(p).locator('input[type="number"]').first().fill('350')
      return top(p).getByRole('button', { name: 'Save recurring entry', exact: true })
    },
    effect: async (p) => expect.poll(() => countOf(p, 'POST', '/budget-entries/'), { message: 'the entry is created' }).toBe(1),
  },
  {
    name: 'Update recurring entry',
    open: async (p) => (await openDialog(p, '/allocations?tab=recurring', (q) => recurringRow(q, 'Meralco'), household, meralcoUpdate()), top(p).getByRole('button', { name: 'Update recurring entry', exact: true })),
    effect: async (p) => expect.poll(() => countOf(p, 'PUT', `/budget-entries/${MERALCO?.id ?? 0}`), { message: 'the entry is updated' }).toBe(1),
  },
  {
    name: 'Delete recurring entry',
    open: async (p) => (await openDialog(p, '/allocations?tab=recurring', (q) => recurringRow(q, 'Meralco')), top(p).getByRole('button', { name: 'Delete recurring entry', exact: true })),
    effect: async (p) => expect(p.getByRole('alertdialog').getByRole('heading', { name: 'Delete recurring entry' }), 'the delete is confirmed first').toBeVisible(),
  },
  {
    name: 'Add allocation',
    open: async (p) => (await openPage(p, '/allocations?tab=budgets'), p.getByRole('button', { name: 'Add allocation', exact: true })),
    effect: async (p) => expect(top(p).getByRole('heading', { name: 'Create budget envelope', exact: true }), 'the envelope form opens').toBeVisible(),
  },
  {
    name: 'Create budget envelope',
    open: async (p) => {
      await openPage(p, '/allocations?tab=budgets')
      await p.getByRole('button', { name: 'Add allocation', exact: true }).click()
      await top(p).locator('input[type="text"]').first().fill('Pet care')
      await top(p).locator('select').first().selectOption('11')
      await top(p).getByRole('button', { name: 'Dining out', exact: true }).click()
      for (const amount of await top(p).locator('input[type="number"]').all()) {
        if ((await amount.inputValue()) === '') await amount.fill('3000')
      }
      return top(p).getByRole('button', { name: 'Create budget envelope', exact: true })
    },
    effect: async (p) => expect.poll(() => countOf(p, 'POST', '/allocations/'), { message: 'the envelope is created' }).toBe(1),
  },
  {
    name: 'Create savings tracker',
    open: async (p) => {
      await openPage(p, '/allocations?tab=savings')
      await p.getByRole('button', { name: 'Add allocation', exact: true }).click()
      await top(p).locator('input[type="text"]').first().fill('Pet care fund')
      await top(p).locator('select').first().selectOption('12')
      for (const amount of await top(p).locator('input[type="number"]').all()) {
        if ((await amount.inputValue()) === '') await amount.fill('3000')
      }
      return top(p).getByRole('button', { name: 'Create savings tracker', exact: true })
    },
    effect: async (p) => expect.poll(() => countOf(p, 'POST', '/allocations/'), { message: 'the tracker is created' }).toBe(1),
  },
  {
    name: 'Update allocation',
    open: async (p) => {
      await openDialog(p, '/allocations?tab=budgets', (q) => allocationCard(q, budgetName))
      await top(p).getByRole('button', { name: 'Edit allocation', exact: true }).click()
      // The fixture's envelopes hold no category, and an envelope needs one to save.
      await top(p).getByRole('button', { name: 'Dining out', exact: true }).click()
      return top(p).getByRole('button', { name: 'Update allocation', exact: true })
    },
    effect: async (p) => expect.poll(() => countOf(p, 'PUT', `/allocations/${budgetId}`), { message: 'the allocation is updated' }).toBe(1),
  },
  {
    name: 'Go to login',
    open: async (p) => {
      await mockApi(p, [errorRoute('POST', '/auth/verify-email', 400, 'This link has expired.')])
      await p.goto('/verify-email?token=e2e')
      return p.getByRole('button', { name: 'Go to login', exact: true })
    },
    effect: async (p) => expect(p, 'it goes to sign in').toHaveURL(/\/login/),
  },
  {
    name: 'Continue now',
    open: async (p) => {
      await mockHousehold(p, household)
      await mockApi(p, [...extraRoutes(household), apiRoute<{ message: string }>('POST', '/auth/verify-email', { message: 'Email verified' })])
      await p.goto('/verify-email?token=e2e')
      return p.getByRole('button', { name: 'Continue now', exact: true })
    },
    effect: async (p) => expect(p, 'it goes to the dashboard').toHaveURL(/\/$/),
  },
  {
    name: 'Sign in as demo user',
    open: async (p) => {
      await mockApi(p, [errorRoute('POST', '/auth/login', 401, 'Incorrect email or password')])
      await p.goto('/login')
      return p.getByRole('button', { name: 'Sign in as demo user', exact: true })
    },
    effect: async (p) => expect.poll(() => countOf(p, 'POST', '/auth/login'), { message: 'it signs in' }).toBe(1),
  },
  {
    name: 'Sign in as demo partner',
    open: async (p) => {
      await mockApi(p, [errorRoute('POST', '/auth/login', 401, 'Incorrect email or password')])
      await p.goto('/login')
      return p.getByRole('button', { name: 'Sign in as demo partner', exact: true })
    },
    effect: async (p) => expect.poll(() => countOf(p, 'POST', '/auth/login'), { message: 'it signs in' }).toBe(1),
  },
  {
    name: 'Get started',
    open: async (p) => {
      await openOnboarding(p, 8)
      // Once completed, the server says so: the refetched user no longer starts the tour again.
      const done = { ...household.user, onboarding_completed: true }
      await mockApi(p, [apiRoute('PATCH', '/auth/complete-onboarding', done), meRoute(done)])
      return p.getByRole('dialog').last().getByRole('button', { name: 'Get started', exact: true })
    },
    effect: async (p) => {
      await expect.poll(() => countOf(p, 'PATCH', '/auth/complete-onboarding'), { message: 'onboarding is completed' }).toBe(1)
      await expect(p.getByText(/^Step \d of 8$/), 'the tour closes').toHaveCount(0)
    },
  },
]

for (const a of ACTIONS) {
  test(`case changes preserve actions: ${a.name}`, async ({ page }) => {
    requests.set(page, sent(page))
    const control = await a.open(page)
    await expect(control, `${a.name} reads in sentence case`).toHaveText(a.name.replace(/ \(submit\)$/, ''))
    await control.click()
    await a.effect(page)
    await viewportShot(page, `action-${a.name.replace(/[^a-z0-9]+/gi, '-')}`)
  })
}
