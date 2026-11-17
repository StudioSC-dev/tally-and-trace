// STU-635 in the Playwright suite: at phone width the bottom tab bar never covers an open dialog's fields or
// action buttons. The API is faked in the browser; there is no backend. The original proof is dialog-tabbar.cjs.
import fs from 'node:fs'
import { expect, test } from '@playwright/test'
import type { Locator, Page } from '@playwright/test'
import type {
  Account,
  Allocation,
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
]

interface DialogCase {
  name: string
  route: string
  trigger: (page: Page) => Locator
}

const transaction: DialogCase = {
  name: 'transaction',
  route: '/transactions',
  trigger: (p) => p.getByRole('button', { name: 'Add Transaction' }).first(),
}

const otherDialogs: DialogCase[] = [
  { name: 'account', route: '/accounts', trigger: (p) => p.getByRole('button', { name: 'Add Account', exact: true }) },
  { name: 'recurring', route: '/allocations', trigger: (p) => p.getByRole('button', { name: 'Add Recurring Entry' }) },
  { name: 'category', route: '/settings', trigger: (p) => p.getByRole('button', { name: 'Add category', exact: true }) },
  { name: 'tag', route: '/settings', trigger: (p) => p.getByRole('button', { name: 'Add tag', exact: true }) },
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
      .slice(0, 32)
  const visible = (el: Element): boolean => {
    const r = el.getBoundingClientRect()
    return r.width >= 8 && r.height >= 8 && getComputedStyle(el).visibility !== 'hidden'
  }
  const fieldsOf = (): Element[] =>
    [...overlayEl.querySelectorAll('input:not([type="hidden"]), select, textarea')].filter(visible)
  const actionsOf = (): HTMLButtonElement[] =>
    [...overlayEl.querySelectorAll<HTMLButtonElement>('button')].filter(
      (el) => visible(el) && (el.getAttribute('type') === 'submit' || /^(cancel|close)$/i.test(label(el))),
    )
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
    return { fieldCount: fields.length, actionCount: actions.length, coveredFields, coveredActions }
  })()
}

async function saved(page: Page, name: string): Promise<void> {
  expect(fs.existsSync(await shot(page, name))).toBe(true)
}

test.describe('dialogs and the phone tab bar', () => {
  test('phone dialog actions are clear of the tab bar', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'phone', 'AC1 is asserted at the 390px phone project')
    const api = await start(page)
    const overlay = await openDialog(page, transaction)

    const probe = await overlay.evaluate(probeOverlay)
    expect.soft(probe.fieldCount, 'fields found').toBeGreaterThan(0)
    expect.soft(probe.actionCount, 'action buttons found').toBeGreaterThanOrEqual(2)
    expect(probe.coveredFields, 'fields under something else once scrolled into view').toEqual([])
    expect(probe.coveredActions, 'action button points that miss the button').toEqual([])
    await saved(page, 'transaction-end-of-scroll')

    await overlay.locator('input[placeholder="Add notes about this transaction"]').fill('Tab bar probe')
    await overlay.locator('[data-field="account_id"]').getByRole('button', { name: /^DT Checking/ }).click()
    await overlay.locator('input[type="number"][placeholder="0.00"]').first().fill('120')
    await overlay.getByRole('button', { name: /^Create Transaction$/ }).click()
    await expect.poll(() => api.count('POST', '/transactions/')).toBe(1)
    await saved(page, 'transaction-saved')
  })

  test('phone all dialogs are clear of the tab bar', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'phone', 'AC2 is asserted at the 390px phone project')
    await start(page)
    const covered: Record<string, string[]> = {}
    const counts: Record<string, number> = {}
    for (const dialog of otherDialogs) {
      const overlay = await openDialog(page, dialog)
      const probe = await overlay.evaluate(probeOverlay)
      counts[dialog.name] = Math.min(probe.fieldCount, probe.actionCount)
      covered[dialog.name] = [...probe.coveredFields, ...probe.coveredActions]
      await saved(page, `${dialog.name}-end-of-scroll`)
    }
    // Each dialog had at least one field and one action button to check.
    expect(Object.values(counts).every((n) => n > 0), `fields and actions per dialog: ${JSON.stringify(counts)}`).toBe(true)
    expect(covered, 'fields and action points covered, by dialog').toEqual({ account: [], recurring: [], category: [], tag: [] })
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
    expect(count).toBeGreaterThanOrEqual(2)
    for (let i = 0; i < count; i++) {
      const button = buttons.nth(i)
      await button.scrollIntoViewIfNeeded()
      await expect(button).toBeVisible()
      const box = await button.boundingBox()
      expect(box).not.toBeNull()
      expect(box?.y ?? -1).toBeGreaterThanOrEqual(0)
      expect((box?.y ?? 0) + (box?.height ?? 0)).toBeLessThanOrEqual(900)
      await button.click({ trial: true })
    }
    await saved(page, 'transaction')
  })
})
