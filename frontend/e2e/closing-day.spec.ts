import fs from 'node:fs'
import path from 'node:path'
import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'
import type {
  Account,
  BudgetEntry,
  CardCredit,
  CardStatements,
  Category,
  CloseDayChangeInput,
  CloseDayReport,
  DashboardDue,
  HouseholdShares,
  HouseholdView,
  InstallmentPlan,
  InstallmentPlans,
  MinimumDuePreset,
  PaginatedResponse,
  ReceivedHouseholdShare,
  ReceivedShare,
  Transaction,
  UpcomingOccurrences,
  User,
} from '@tally-trace/shared'
import { landingStubs } from './support/landing'
import { apiRoute, mockApi, queryRoute } from './support/mockApi'
import type { ApiRoute } from './support/mockApi'
import { signedIn } from './support/signedIn'

// STU-747 AC6 in the browser: a card with an open installment has its closing day changed in the account
// form. The confirm step lists the installment's next charge before and after, Confirm sends the apply (not
// a dry run), and the installment's next date shown on Transactions is on the new close. A card with nothing
// to move saves through the plain PUT: no step, no apply. The API is faked, so no stack is needed.

test.use({ locale: 'en-US' })

const VIEWPORTS = [
  { width: 390, height: 844 },
  { width: 1280, height: 800 },
]

// The browser clock is fixed to this Manila day, so "today" in the mocked answers matches the page's.
const NOW = new Date('2026-11-18T09:00:00+08:00')
const TODAY = '2026-11-18'
const OLD_CLOSE = 10
const NEW_CLOSE = 24
const OLD_NEXT = '2026-12-10'
const NEW_NEXT = '2026-12-24'
const ENTRY_ID = 7
const CARD_ID = 2

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

const permissions = {
  can_edit_settings: true,
  can_manage_shares: true,
  can_add_transactions: true,
  can_delete: true,
  can_view_details: true,
}

const checking: Account = {
  id: 1,
  name: 'Everyday Checking',
  account_type: 'checking',
  balance: 50000,
  currency: 'PHP',
  tags: [],
  my_role: 'owner',
  owner_name: 'Ada Tester',
  permissions,
  is_active: true,
}

const cardAt = (closeDay: number): Account => ({
  id: CARD_ID,
  name: 'Sample Visa',
  account_type: 'credit',
  balance: 0,
  currency: 'PHP',
  credit_limit: 100000,
  billing_cycle_start: closeDay,
  days_until_due_date: 21,
  payment_account_id: checking.id,
  tags: [],
  my_role: 'owner',
  owner_name: 'Ada Tester',
  permissions,
  is_active: true,
})

const planAt = (next: string): InstallmentPlan => ({
  view: 'full',
  entry_id: ENTRY_ID,
  name: 'Sample laptop plan',
  account_name: 'Sample Visa',
  amount: 2500,
  currency: 'PHP',
  next_charge: next,
  effective_date: null,
  missed: 0,
  payments_left: 6,
  payments_total: 6,
  can_mark_paid: true,
  auto_post: null,
  block_reason: null,
  can_review: false,
  recordable: false,
})

const report = (extra: Partial<CloseDayReport>): CloseDayReport => ({
  card_id: CARD_ID,
  dry_run: true,
  changed: false,
  refused: false,
  reasons: [],
  old_close_day: OLD_CLOSE,
  new_close_day: NEW_CLOSE,
  entries: [],
  printed_dues: [],
  minimum_dues: [],
  past_statements: [],
  history_shift_accepted: false,
  ...extra,
})

const movingInstallment = {
  entry_id: ENTRY_ID,
  old_next_occurrence: OLD_NEXT,
  new_next_occurrence: NEW_NEXT,
  old_anchor_day: OLD_CLOSE,
  new_anchor_day: NEW_CLOSE,
  rows: [],
}

const emptyPage = <T>(): PaginatedResponse<T> => ({ items: [], total: 0, has_more: false })
const accountsPage = (items: Account[]): PaginatedResponse<Account> => ({ items, total: items.length, has_more: false })
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
  today: TODAY,
  linked_pending: [],
  upcoming_occurrences: noOccurrences,
  subscription_occurrences: noOccurrences,
  unposted: { items: [], total: 0, page: 1, page_size: 20, has_more: false },
}

/** What the card's day and the installment's next charge are now: the apply changes both. */
interface World {
  closeDay: number
  next: string
}

/** One request to the closing-day route, as the page sent it. */
interface ClosingDayCall {
  body: CloseDayChangeInput
  idempotencyKey: string | undefined
}

const stubs = (world: World, withInstallment: boolean): ApiRoute[] => [
  ...landingStubs().filter((r) => r.path !== '/accounts/'),
  queryRoute<PaginatedResponse<Account>>('GET', '/accounts/', () => accountsPage([checking, cardAt(world.closeDay)])),
  apiRoute<Account>('PUT', `/accounts/${CARD_ID}`, cardAt(NEW_CLOSE)),
  apiRoute<{ items: CardCredit[] }>('GET', '/cards/credit', { items: [] }),
  apiRoute<CardStatements>('GET', `/accounts/${CARD_ID}/statements`, {
    view: 'full',
    account_id: CARD_ID,
    name: 'Sample Visa',
    currency: 'PHP',
    statements: [],
  }),
  apiRoute<MinimumDuePreset[]>('GET', '/accounts/minimum-due-presets', []),
  apiRoute<Category[]>('GET', '/categories/', []),
  apiRoute<PaginatedResponse<BudgetEntry>>('GET', '/budget-entries/', emptyPage<BudgetEntry>()),
  queryRoute<InstallmentPlans>('GET', '/budget-entries/installment-plans', () => ({
    items: withInstallment ? [planAt(world.next)] : [],
    auto_post_scheduled: true,
    today: TODAY,
  })),
  apiRoute<DashboardDue>('GET', '/dashboard/due', emptyDue),
  apiRoute<PaginatedResponse<Transaction>>('GET', '/transactions/', emptyPage<Transaction>()),
  apiRoute<ReceivedShare[]>('GET', '/shares/received', []),
  apiRoute<ReceivedHouseholdShare[]>('GET', '/shares/received/household', []),
  apiRoute<HouseholdShares>('GET', '/tags/household/shares', { tag_id: 1, shares: [] }),
  apiRoute<HouseholdView[]>('GET', '/household/', []),
]

/**
 * Signs in, fixes the clock and fakes the API. The closing-day route answers a dry run with `dryRun` and an
 * apply with the changed report, moving the card's day and the installment's next charge as the API would.
 */
async function openApp(page: Page, dryRun: CloseDayReport, withInstallment: boolean) {
  const world: World = { closeDay: OLD_CLOSE, next: OLD_NEXT }
  const calls: ClosingDayCall[] = []
  await page.clock.setFixedTime(NOW)
  await signedIn(page, user)
  const api = await mockApi(page, [], { allow: stubs(world, withInstallment) })
  await page.route(`**/api/v1/cards/${CARD_ID}/closing-day`, async (route) => {
    const body = route.request().postDataJSON() as CloseDayChangeInput
    calls.push({ body, idempotencyKey: route.request().headers()['idempotency-key'] })
    if (body.dry_run === false) {
      world.closeDay = body.close_day
      world.next = NEW_NEXT
      await route.fulfill({ json: report({ ...dryRun, dry_run: false, changed: true }) })
      return
    }
    await route.fulfill({ json: dryRun })
  })
  return { api, calls }
}

async function openForm(page: Page): Promise<void> {
  await page.goto('/accounts')
  const row = page.locator('article').filter({ has: page.getByText('Sample Visa', { exact: true }) })
  await expect(row).toBeVisible()
  await row.locator('[role="button"]').first().click()
  await page.getByRole('button', { name: 'Edit account' }).click()
  await page.getByRole('button', { name: 'Show details' }).click()
  await page.locator('label:text-is("Statement closes (day of month)") + select').selectOption(String(NEW_CLOSE))
}

/** A viewport screenshot (the step is a fixed overlay), saved under the project's screens folder and attached. */
async function viewportShot(page: Page, name: string): Promise<string> {
  const info = test.info()
  const size = page.viewportSize()
  const tag = size ? `${size.width}x${size.height}` : 'unsized'
  const file = path.join(info.project.outputDir, 'screens', `closing-day-${name}-${tag}-${info.project.name}.png`)
  await page.screenshot({ path: file, animations: 'disabled' })
  await info.attach(name, { path: file, contentType: 'image/png' })
  return file
}

for (const { width, height } of VIEWPORTS) {
  const size = `${width}x${height}`
  test.describe(`closing day ${size}`, () => {
    test.use({ viewport: { width, height } })

    test(`AC6 closing-day change moves the installment (${size})`, async ({ page }) => {
      const { api, calls } = await openApp(page, report({ entries: [movingInstallment] }), true)
      await openForm(page)
      await page.getByRole('button', { name: 'Update account', exact: true }).click()

      // The confirm step names the installment with its next charge before and after.
      const dialog = page.getByTestId('close-day-dialog')
      await expect(dialog).toBeVisible()
      await expect(page.getByTestId('close-day-headline')).toHaveText('The closing day moves from the 10th to the 24th.')
      await expect(page.getByTestId('close-day-installments').locator('li')).toHaveText('Installment #7: the next charge moves from Dec 10th, 2026 to Dec 24th, 2026.')
      await expect(page.getByTestId('close-day-ack')).toHaveCount(0)
      expect(fs.existsSync(await viewportShot(page, 'confirm-step'))).toBe(true)
      expect(calls.map((c) => c.body.dry_run)).not.toContain(false)

      await page.getByTestId('close-day-confirm').click()
      await expect(dialog).toBeHidden()

      // The apply was sent, not a dry run, with the day, no history shift and an idempotency key.
      await expect.poll(() => calls.filter((c) => c.body.dry_run === false).length).toBe(1)
      const apply = calls.filter((c) => c.body.dry_run === false)[0]
      expect(apply.body).toEqual({ close_day: NEW_CLOSE, dry_run: false, accept_history_shift: false })
      expect(apply.idempotencyKey).toBeTruthy()
      // The rest of the form then saves through the PUT, carrying the new day.
      await expect.poll(() => api.bodies('PUT', `/accounts/${CARD_ID}`).length).toBe(1)
      expect(api.bodies('PUT', `/accounts/${CARD_ID}`)[0]).toHaveProperty('billing_cycle_start', NEW_CLOSE)

      // The installment's next date shown in the app is on the new close.
      await page.goto('/transactions')
      await page.getByTestId('due-tab-installments').click()
      const plan = page.locator(`[data-testid="due-row"][data-kind="installment"][data-source="budget_entry:${ENTRY_ID}"]`)
      await expect(plan).toBeVisible()
      await expect(plan).toHaveAttribute('data-day', NEW_NEXT)
      await expect(plan).toContainText('Next charge Dec 24th, 2026')
      await expect(plan).not.toContainText('Dec 10th, 2026')
      expect(fs.existsSync(await viewportShot(page, 'installment-on-new-close'))).toBe(true)
    })

    test(`AC6 card with nothing to move saves without a step (${size})`, async ({ page }) => {
      const { api, calls } = await openApp(page, report({}), false)
      await openForm(page)
      await page.getByRole('button', { name: 'Update account', exact: true }).click()

      // No step is shown: the form saves through the PUT and closes.
      await expect.poll(() => api.bodies('PUT', `/accounts/${CARD_ID}`).length).toBe(1)
      expect(api.bodies('PUT', `/accounts/${CARD_ID}`)[0]).toHaveProperty('billing_cycle_start', NEW_CLOSE)
      await expect(page.getByRole('button', { name: 'Update account', exact: true })).toBeHidden()
      await expect(page.getByTestId('close-day-dialog')).toHaveCount(0)
      // Only dry runs reached the closing-day route; nothing was applied.
      expect(calls.length).toBeGreaterThan(0)
      expect(calls.map((c) => c.body.dry_run)).not.toContain(false)
      expect(fs.existsSync(await viewportShot(page, 'saved-without-step'))).toBe(true)
    })
  })
}
