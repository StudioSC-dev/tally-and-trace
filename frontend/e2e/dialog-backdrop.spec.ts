import fs from 'node:fs'
import { expect, test } from '@playwright/test'
import type { Locator, Page } from '@playwright/test'
import type {
  Account,
  BudgetEntry,
  CardCredit,
  Category,
  DashboardDue,
  HouseholdShares,
  HouseholdView,
  InstallmentPlans,
  PaginatedResponse,
  ReceivedHouseholdShare,
  ReceivedShare,
  Transaction,
  UpcomingOccurrences,
  User,
} from '@tally-trace/shared'
import { landingStubs } from './support/landing'
import { apiRoute, mockApi } from './support/mockApi'
import type { ApiRoute } from './support/mockApi'
import { signedIn } from './support/signedIn'
import { shot } from './support/shot'

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

// The shared overlay (`fixed inset-0 overflow-y-auto bg-black/60`), excluding the confirm dialog (z-[100]).
const OVERLAY = '.fixed.inset-0.overflow-y-auto.bg-black\\/60:not(.z-\\[100\\])'
const TOL = 1

const emptyPage = <T>(): PaginatedResponse<T> => ({ items: [], total: 0, has_more: false })
// One writable account: the Transactions page only offers Add Transaction when there is one.
const checking: Account = {
  id: 1,
  name: 'Checking',
  account_type: 'checking',
  balance: 5000,
  currency: 'PHP',
  tags: [],
  my_role: 'owner',
  owner_name: 'Ada Tester',
  permissions: {
    can_edit_settings: true,
    can_manage_shares: true,
    can_add_transactions: true,
    can_delete: true,
    can_view_details: true,
  },
  is_active: true,
}

const noOccurrences: UpcomingOccurrences = { items: [], total: 0, auto_post_scheduled: true }

const emptyDue: DashboardDue = {
  payables: [],
  upcoming_this_month: [],
  card_charges: [],
  missed: [],
  card_statements_due: [],
  installment_review: [],
  installment_auto_post: [],
  autopay_due: [],
  auto_post_scheduled: true,
  today: '2026-01-15',
  linked_pending: [],
  upcoming_occurrences: noOccurrences,
  subscription_occurrences: noOccurrences,
  unposted: { items: [], total: 0, page: 1, page_size: 20, has_more: false },
}

/** What the four pages call on load, beyond the signed-in landing calls, answered with empty typed data. */
const pageStubs = (): ApiRoute[] => [
  ...landingStubs(),
  apiRoute<PaginatedResponse<Account>>('GET', '/accounts/', { items: [checking], total: 1, has_more: false }),
  apiRoute<{ items: CardCredit[] }>('GET', '/cards/credit', { items: [] }),
  apiRoute<Category[]>('GET', '/categories/', []),
  apiRoute<PaginatedResponse<BudgetEntry>>('GET', '/budget-entries/', emptyPage<BudgetEntry>()),
  apiRoute<InstallmentPlans>('GET', '/budget-entries/installment-plans', {
    items: [],
    auto_post_scheduled: true,
    today: '2026-01-15',
  }),
  apiRoute<DashboardDue>('GET', '/dashboard/due', emptyDue),
  apiRoute<PaginatedResponse<Transaction>>('GET', '/transactions/', emptyPage<Transaction>()),
  apiRoute<ReceivedShare[]>('GET', '/shares/received', []),
  apiRoute<ReceivedHouseholdShare[]>('GET', '/shares/received/household', []),
  apiRoute<HouseholdShares>('GET', '/tags/household/shares', { tag_id: 1, shares: [] }),
  apiRoute<HouseholdView[]>('GET', '/household/', []),
]

interface DialogCase {
  name: string
  route: string
  trigger: (page: Page) => Locator
}

const ACCOUNT: DialogCase = {
  name: 'account',
  route: '/accounts',
  trigger: (p) => p.getByRole('button', { name: 'Add Account', exact: true }),
}

const OTHERS: DialogCase[] = [
  { name: 'transaction', route: '/transactions', trigger: (p) => p.getByRole('button', { name: 'Add Transaction' }).first() },
  { name: 'recurring', route: '/allocations', trigger: (p) => p.getByRole('button', { name: 'Add Recurring Entry' }) },
  { name: 'category', route: '/settings', trigger: (p) => p.getByRole('button', { name: 'Add category', exact: true }) },
  { name: 'tag', route: '/settings', trigger: (p) => p.getByRole('button', { name: 'Add tag', exact: true }) },
]

async function openDialog(page: Page, c: DialogCase): Promise<Locator> {
  await signedIn(page, user)
  await mockApi(page, [], { allow: pageStubs() })
  await page.goto(c.route)
  const trigger = c.trigger(page)
  await expect(trigger).toBeVisible()
  await trigger.click()
  const overlay = page.locator(OVERLAY).last()
  await expect(overlay).toBeVisible()
  return overlay
}

interface Measure {
  rect: { x: number; y: number; w: number; h: number }
  viewport: { w: number; h: number }
}

async function measure(page: Page, overlay: Locator): Promise<Measure> {
  const box = await overlay.boundingBox()
  expect(box).not.toBeNull()
  const viewport = await page.evaluate(() => ({ w: window.innerWidth, h: window.innerHeight }))
  return { rect: { x: box?.x ?? NaN, y: box?.y ?? NaN, w: box?.width ?? NaN, h: box?.height ?? NaN }, viewport }
}

test.describe('dialog backdrop (STU-644)', () => {
  test('accounts backdrop covers the full viewport', async ({ page }) => {
    const overlay = await openDialog(page, ACCOUNT)
    await expect
      .poll(async () => Math.abs((await measure(page, overlay)).rect.y), { message: 'overlay top edge (y)' })
      .toBeLessThanOrEqual(TOL)
    const m = await measure(page, overlay)
    expect(Math.abs(m.rect.y), 'overlay starts at y=0').toBeLessThanOrEqual(TOL)
    expect(Math.abs(m.rect.x)).toBeLessThanOrEqual(TOL)
    expect(Math.abs(m.rect.w - m.viewport.w)).toBeLessThanOrEqual(TOL)
    expect(Math.abs(m.rect.h - m.viewport.h)).toBeLessThanOrEqual(TOL)
    expect(fs.existsSync(await shot(page, 'accounts-backdrop'))).toBe(true)
  })

  test('all pages backdrop covers the full viewport', async ({ page }) => {
    for (const c of OTHERS) {
      await test.step(c.name, async () => {
        const overlay = await openDialog(page, c)
        const m = await measure(page, overlay)
        expect.soft(Math.abs(m.rect.y), `${c.name}: overlay y`).toBeLessThanOrEqual(TOL)
        expect.soft(Math.abs(m.rect.w - m.viewport.w), `${c.name}: overlay width`).toBeLessThanOrEqual(TOL)
        expect.soft(Math.abs(m.rect.h - m.viewport.h), `${c.name}: overlay height`).toBeLessThanOrEqual(TOL)
        await shot(page, `${c.name}-backdrop`)
      })
    }
  })

  test('top nav is covered by the backdrop', async ({ page }) => {
    const overlay = await openDialog(page, ACCOUNT)
    const covered = await overlay.evaluate((el) => {
      const top = document.elementFromPoint(Math.round(window.innerWidth / 2), 0)
      return !!top && el.contains(top)
    })
    expect(covered, 'element at the top-centre point is the overlay or inside it').toBe(true)
    expect(fs.existsSync(await shot(page, 'top-nav-covered'))).toBe(true)
  })
})
