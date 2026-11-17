// STU-635 in the Playwright suite: at phone width the bottom tab bar never covers an open dialog's fields or
// action buttons. The API is faked in the browser; there is no backend. The original proof is dialog-tabbar.cjs.
import fs from 'node:fs'
import { expect, test } from '@playwright/test'
import type { Locator, Page } from '@playwright/test'
import type {
  Account,
  Allocation,
  FullBudgetEntry,
  Category,
  CardCredit,
  DescriptionSuggestion,
  DashboardDue,
  FullTransaction,
  HouseholdShares,
  HouseholdView,
  InstallmentPlans,
  BudgetEntry,
  PaginatedResponse,
  ReceivedHouseholdShare,
  ReceivedShare,
  Tag,
  Transaction,
  UpcomingOccurrences,
  User,
} from '@tally-trace/shared'
import { landingStubs } from './support/landing'
import { apiRoute, mockApi } from './support/mockApi'
import type { ApiMock, ApiRoute } from './support/mockApi'
import { shot } from './support/shot'
import { signedIn } from './support/signedIn'

const user: User = {
  id: 1,
  email: 'ada@example.com',
  first_name: 'Ada',
  last_name: 'Tester',
  default_currency: 'PHP',
  is_active: true,
  is_verified: true,
  onboarding_completed: true,
  created_at: '2026-01-01T00:00:00',
}

const checking: Account = {
  id: 11,
  name: 'DT Checking',
  account_type: 'checking',
  balance: 50000,
  currency: 'PHP',
  is_active: true,
  tags: [],
  my_role: 'owner',
  is_shared: false,
  owner_id: 1,
  owner_name: 'Ada T.',
  permissions: {
    can_edit_settings: true,
    can_manage_shares: true,
    can_add_transactions: true,
    can_delete: true,
    can_view_details: true,
  },
  created_at: '2026-01-01T00:00:00',
}

const created: FullTransaction = {
  view: 'full',
  id: 501,
  account_id: checking.id,
  amount: 120,
  currency: 'PHP',
  description: 'Tab bar probe',
  transaction_type: 'debit',
  transaction_date: '2026-01-15T00:00:00',
  is_posted: true,
  is_reconciled: false,
  is_recurring: false,
  transfer_fee: 0,
  tags: [],
  created_at: '2026-01-15T00:00:00',
  permissions: { can_edit: true, can_delete: true, can_post: true, can_revert: true, can_tag: true },
  created_by: 'Ada T.',
}

const createdEntry: FullBudgetEntry = {
  view: 'full',
  id: 601,
  entry_type: 'expense',
  name: 'Rent',
  amount: 100,
  currency: 'PHP',
  cadence: 'monthly',
  next_occurrence: '2026-02-01',
  lead_time_days: 0,
  end_mode: 'indefinite',
  account_id: checking.id,
  is_active: true,
  tags: [],
  created_at: '2026-01-15T00:00:00',
  permissions: { can_edit: true, can_delete: true, can_post: true, can_revert: true, can_tag: true },
  created_by: 'Ada T.',
}

const createdCategory: Category = {
  id: 701,
  name: 'Groceries',
  is_expense: true,
  kind: 'expense',
  is_active: true,
  created_at: '2026-01-15T00:00:00',
}

const createdTag: Tag = { id: 801, name: 'Trip', color: '#2563eb', is_system: false, created_at: '2026-01-15T00:00:00' }

const emptyPage = <T>(): PaginatedResponse<T> => ({ items: [], total: 0, has_more: false })
const noOccurrences: UpcomingOccurrences = { items: [], total: 0, auto_post_scheduled: true }

const due: DashboardDue = {
  today: '2026-01-15',
  payables: [],
  upcoming_this_month: [],
  card_charges: [],
  missed: [],
  card_statements_due: [],
  installment_review: [],
  installment_auto_post: [],
  autopay_due: [],
  auto_post_scheduled: true,
  linked_pending: [],
  upcoming_occurrences: noOccurrences,
  subscription_occurrences: noOccurrences,
  unposted: { items: [], total: 0, page: 1, page_size: 50, has_more: false },
}

/** Every call the five pages make, answered with typed data. One writable account, nothing else. */
const pageStubs = (): ApiRoute[] => [
  ...landingStubs().filter((r) => r.path !== '/accounts/'),
  apiRoute<PaginatedResponse<Account>>('GET', '/accounts/', { items: [checking], total: 1, has_more: false }),
  apiRoute<Category[]>('GET', '/categories/', []),
  apiRoute<PaginatedResponse<BudgetEntry>>('GET', '/budget-entries/', emptyPage<BudgetEntry>()),
  apiRoute<InstallmentPlans>('GET', '/budget-entries/installment-plans', {
    items: [],
    auto_post_scheduled: true,
    today: '2026-01-15',
  }),
  apiRoute<PaginatedResponse<Transaction>>('GET', '/transactions/', emptyPage<Transaction>()),
  apiRoute<DashboardDue>('GET', '/dashboard/due', due),
  apiRoute<{ items: CardCredit[] }>('GET', '/cards/credit', { items: [] }),
  apiRoute<HouseholdView[]>('GET', '/household/', []),
  apiRoute<ReceivedShare[]>('GET', '/shares/received', []),
  apiRoute<ReceivedHouseholdShare[]>('GET', '/shares/received/household', []),
  apiRoute<HouseholdShares>('GET', '/tags/household/shares', { tag_id: 1, shares: [] }),
  apiRoute<PaginatedResponse<Allocation>>('GET', '/allocations/', emptyPage<Allocation>()),
  apiRoute<Tag[]>('GET', '/tags/', []),
  apiRoute<{ items: DescriptionSuggestion[] }>('GET', '/transactions/description-suggestions', { items: [] }),
  apiRoute<FullTransaction>('POST', '/transactions/', created, 201),
  apiRoute<Account>('POST', '/accounts/', { ...checking, id: 12, name: 'New account' }, 201),
  apiRoute<FullBudgetEntry>('POST', '/budget-entries/', createdEntry, 201),
  apiRoute<Category>('POST', '/categories/', createdCategory, 201),
  apiRoute<Tag>('POST', '/tags/', createdTag, 201),
]

interface DialogCase {
  name: string
  route: string
  trigger: (page: Page) => Locator
  /** Controls that must be in the field probe, by label (aria-label, text, name or placeholder), so an omission cannot pass. */
  controls: string[]
  /** The fewest fields (inputs, selects, textareas and the buttons that act as fields) the probe must see. */
  minFields: number
  /** Fills the minimum valid values, then returns the primary action button. */
  fill: (overlay: Locator) => Promise<Locator>
  /** The create request the primary action sends. */
  request: { method: 'POST'; path: string }
}

const swatches = [
  'Colour #2563eb',
  'Colour #7c3aed',
  'Colour #16a34a',
  'Colour #f97316',
  'Colour #db2777',
  'Colour #0891b2',
  'Colour #ca8a04',
  'Colour #dc2626',
]

const transaction: DialogCase = {
  name: 'transaction',
  route: '/transactions',
  trigger: (p) => p.getByRole('button', { name: 'Add Transaction' }).first(),
  controls: [
    'Close transaction modal',
    'Add notes about this transaction',
    'Search accounts',
    'DT Checking(PHP)',
    'Change',
    'Income',
    'Expense',
    'Transfer',
    '0.00',
  ],
  minFields: 12,
  fill: async (overlay) => {
    await overlay.locator('input[placeholder="Add notes about this transaction"]').fill('Tab bar probe')
    await overlay.locator('[data-field="account_id"]').getByRole('button', { name: /^DT Checking/ }).click()
    await overlay.locator('input[type="number"][placeholder="0.00"]').first().fill('120')
    return overlay.getByRole('button', { name: /^Create Transaction$/ })
  },
  request: { method: 'POST', path: '/transactions/' },
}

const otherDialogs: DialogCase[] = [
  {
    name: 'account',
    route: '/accounts',
    trigger: (p) => p.getByRole('button', { name: 'Add Account', exact: true }),
    controls: ['Enter account name', 'Add a description for this account'],
    minFields: 8,
    fill: async (overlay) => {
      await overlay.getByPlaceholder('Enter account name').fill('New account')
      return overlay.getByRole('button', { name: 'Create Account', exact: true })
    },
    request: { method: 'POST', path: '/accounts/' },
  },
  {
    name: 'recurring',
    route: '/allocations',
    trigger: (p) => p.getByRole('button', { name: 'Add Recurring Entry' }),
    controls: ['Close allocation modal', 'Expense', 'Income', 'Keep running', 'On date', 'After runs', 'Active'],
    minFields: 18,
    fill: async (overlay) => {
      await overlay.locator('input[type="text"]').first().fill('Rent')
      await overlay.locator('select').first().selectOption({ label: 'DT Checking' })
      await overlay.locator('input[type="number"]').first().fill('100')
      return overlay.getByRole('button', { name: 'Save Recurring Entry', exact: true })
    },
    request: { method: 'POST', path: '/budget-entries/' },
  },
  {
    name: 'category',
    route: '/settings',
    trigger: (p) => p.getByRole('button', { name: 'Add category', exact: true }),
    controls: swatches,
    minFields: 12,
    fill: async (overlay) => {
      await overlay.locator('input[type="text"]').first().fill('Groceries')
      return overlay.getByRole('button', { name: 'Create', exact: true })
    },
    request: { method: 'POST', path: '/categories/' },
  },
  {
    name: 'tag',
    route: '/settings',
    trigger: (p) => p.getByRole('button', { name: 'Add tag', exact: true }),
    controls: [...swatches, 'Custom colour'],
    minFields: 10,
    fill: async (overlay) => {
      await overlay.locator('input[type="text"]').first().fill('Trip')
      return overlay.getByRole('button', { name: 'Create', exact: true })
    },
    request: { method: 'POST', path: '/tags/' },
  },
]

const OVERLAY = '.fixed.inset-0.overflow-y-auto.bg-black\\/60'

async function start(page: Page): Promise<ApiMock> {
  await signedIn(page, user)
  return mockApi(page, pageStubs())
}

async function openDialog(page: Page, dialog: DialogCase): Promise<Locator> {
  await page.goto(dialog.route)
  const trigger = dialog.trigger(page)
  await expect(trigger).toBeVisible()
  await trigger.click()
  const overlay = page.locator(OVERLAY).last()
  await expect(overlay).toBeVisible()
  await expect(overlay.locator('input, select, textarea').first()).toBeVisible()
  return overlay
}

interface Probe {
  fieldCount: number
  actionCount: number
  /** A field whose centre, once scrolled into view, is under something other than the field. */
  coveredFields: string[]
  /** The label of every field the probe scrolled to. */
  fieldLabels: string[]
  /** An action button, at the end of the scroll, whose centre or inset corner hits something else. */
  coveredActions: string[]
}

/** Runs in the page. Scrolls every field into view, then the overlay to its end, and samples with elementFromPoint. */
function probeOverlay(overlayEl: Element): Promise<Probe> {
  const frames = (): Promise<void> => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())))
  const label = (el: Element): string =>
    (el.getAttribute('aria-label') || el.textContent || el.getAttribute('name') || el.getAttribute('placeholder') || el.tagName)
      .trim()
      .replace(/\s+/g, ' ')
      .slice(0, 60)
  const visible = (el: Element): boolean => {
    const r = el.getBoundingClientRect()
    return r.width >= 8 && r.height >= 8 && getComputedStyle(el).visibility !== 'hidden'
  }
  const isAction = (el: Element): boolean =>
    el.tagName === 'BUTTON' && (el.getAttribute('type') === 'submit' || /^(cancel|close)$/i.test(label(el)))
  // Inputs, selects and textareas, and the buttons the app uses as fields (pickers, type controls, toggles, swatches).
  const fieldsOf = (): Element[] =>
    [...overlayEl.querySelectorAll('input:not([type="hidden"]), select, textarea, button')].filter(
      (el) => visible(el) && !isAction(el),
    )
  const actionsOf = (): HTMLButtonElement[] =>
    [...overlayEl.querySelectorAll<HTMLButtonElement>('button')].filter((el) => visible(el) && isAction(el))
  const hit = (el: Element, x: number, y: number): boolean => {
    const top = document.elementFromPoint(x, y)
    return top !== null && el.contains(top)
  }
  return (async () => {
    const coveredFields: string[] = []
    const fields = fieldsOf()
    for (const el of fields) {
      el.scrollIntoView({ block: 'center', behavior: 'instant' })
      await frames()
      const r = el.getBoundingClientRect()
      if (!hit(el, r.left + r.width / 2, r.top + r.height / 2)) coveredFields.push(label(el))
    }
    overlayEl.scrollTo({ top: overlayEl.scrollHeight, behavior: 'instant' })
    await frames()
    const coveredActions: string[] = []
    const actions = actionsOf()
    for (const el of actions) {
      const r = el.getBoundingClientRect()
      const inset = 2
      const samples: Array<[string, number, number]> = [
        ['centre', r.left + r.width / 2, r.top + r.height / 2],
        ['top-left', r.left + inset, r.top + inset],
        ['top-right', r.right - inset, r.top + inset],
        ['bottom-left', r.left + inset, r.bottom - inset],
        ['bottom-right', r.right - inset, r.bottom - inset],
      ]
      for (const [where, x, y] of samples) if (!hit(el, x, y)) coveredActions.push(`${label(el)} ${where}`)
    }
    return { fieldCount: fields.length, actionCount: actions.length, coveredFields, fieldLabels: fields.map(label), coveredActions }
  })()
}

/** Controls the dialog must have that the probe did not see. */
const missingControls = (probe: Probe, dialog: DialogCase): string[] =>
  dialog.controls.filter((name) => !probe.fieldLabels.includes(name))

async function saved(page: Page, name: string): Promise<void> {
  expect(fs.existsSync(await shot(page, name))).toBe(true)
}

test.describe('dialogs and the phone tab bar', () => {
  test('phone dialog actions are clear of the tab bar', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'phone', 'AC1 is asserted at the 390px phone project')
    const api = await start(page)
    const overlay = await openDialog(page, transaction)

    const probe = await overlay.evaluate(probeOverlay)
    expect.soft(probe.fieldCount, 'fields found').toBeGreaterThanOrEqual(transaction.minFields)
    expect.soft(probe.actionCount, 'action buttons found').toBeGreaterThanOrEqual(3)
    expect.soft(missingControls(probe, transaction), 'controls the probe did not scroll to').toEqual([])
    expect(probe.coveredFields, 'fields under something else once scrolled into view').toEqual([])
    expect(probe.coveredActions, 'action button points that miss the button').toEqual([])
    await saved(page, 'transaction-end-of-scroll')

    await (await transaction.fill(overlay)).click()
    await expect.poll(() => api.count('POST', '/transactions/')).toBe(1)
    await saved(page, 'transaction-saved')
  })

  test('phone all dialogs are clear of the tab bar', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'phone', 'AC2 is asserted at the 390px phone project')
    const api = await start(page)
    const covered: Record<string, string[]> = {}
    const missing: Record<string, string[]> = {}
    const short: Record<string, number> = {}
    const posts: Record<string, number> = {}
    for (const dialog of otherDialogs) {
      const overlay = await openDialog(page, dialog)
      const probe = await overlay.evaluate(probeOverlay)
      covered[dialog.name] = [...probe.coveredFields, ...probe.coveredActions]
      missing[dialog.name] = missingControls(probe, dialog)
      short[dialog.name] = probe.fieldCount >= dialog.minFields && probe.actionCount >= 2 ? 0 : probe.fieldCount
      await saved(page, `${dialog.name}-end-of-scroll`)
      await (await dialog.fill(overlay)).click()
      await expect.poll(() => api.count(dialog.request.method, dialog.request.path)).toBe(1)
      posts[dialog.name] = api.count(dialog.request.method, dialog.request.path)
    }
    const names = otherDialogs.map((d) => d.name)
    const none = Object.fromEntries(names.map((n) => [n, [] as string[]]))
    expect(covered, 'fields and action points covered, by dialog').toEqual(none)
    expect(missing, 'controls the probe did not scroll to, by dialog').toEqual(none)
    expect(short, 'dialogs with fewer fields or actions than expected').toEqual(Object.fromEntries(names.map((n) => [n, 0])))
    expect(posts, 'create requests sent by the primary action, by dialog').toEqual(Object.fromEntries(names.map((n) => [n, 1])))
  })

  test('tab bar shows with no dialog open', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'phone', 'AC3 is asserted at the 390px phone project')
    await start(page)
    await page.goto('/transactions')
    const bar = page.locator('nav.fixed.bottom-0')
    await expect(bar).toBeVisible()
    await expect(page.locator(OVERLAY)).toHaveCount(0)

    const geometry = await bar.evaluate((el) => {
      const r = el.getBoundingClientRect()
      const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)
      return { bottom: r.bottom, viewport: window.innerHeight, centreInBar: top !== null && el.contains(top) }
    })
    expect(geometry.viewport).toBe(844)
    // The safe-area inset is 0 in Chromium, so the bar's bottom edge is the viewport's.
    expect(Math.abs(geometry.bottom - geometry.viewport)).toBeLessThanOrEqual(1)
    expect(geometry.centreInBar, 'the element at the tab bar centre is inside the tab bar').toBe(true)
    await saved(page, 'tab-bar')
  })

  test('desktop has no tab bar over dialogs', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop', 'AC4 is asserted at the 1440px desktop project')
    await start(page)
    const overlay = await openDialog(page, transaction)
    await expect(page.locator('nav.fixed.bottom-0')).toBeHidden()

    const buttons = overlay.locator('button[type="submit"], button:text-matches("^(Cancel|Close)$", "i")')
    const count = await buttons.count()
    expect(count).toBeGreaterThanOrEqual(3)
    expect(page.viewportSize()).toEqual({ width: 1440, height: 900 })
    for (let i = 0; i < count; i++) {
      const button = buttons.nth(i)
      await button.scrollIntoViewIfNeeded()
      await expect(button).toBeVisible()
      const box = await button.boundingBox()
      expect(box).not.toBeNull()
      const { x, y, width, height } = box ?? { x: -1, y: -1, width: 0, height: 0 }
      expect(x, 'left edge inside the viewport').toBeGreaterThanOrEqual(0)
      expect(y, 'top edge inside the viewport').toBeGreaterThanOrEqual(0)
      expect(x + width, 'right edge inside the viewport').toBeLessThanOrEqual(1440)
      expect(y + height, 'bottom edge inside the viewport').toBeLessThanOrEqual(900)
      // Centre and the four corners, inset 2px, must hit the button or something inside it.
      const misses = await button.evaluate((el) => {
        const r = el.getBoundingClientRect()
        const inset = 2
        const samples: Array<[string, number, number]> = [
          ['centre', r.left + r.width / 2, r.top + r.height / 2],
          ['top-left', r.left + inset, r.top + inset],
          ['top-right', r.right - inset, r.top + inset],
          ['bottom-left', r.left + inset, r.bottom - inset],
          ['bottom-right', r.right - inset, r.bottom - inset],
        ]
        return samples.filter(([, px, py]) => !el.contains(document.elementFromPoint(px, py))).map(([where]) => where)
      })
      expect(misses, `points of button ${i} that miss it`).toEqual([])
      await button.click({ trial: true })
    }
    await saved(page, 'transaction')
  })
})
