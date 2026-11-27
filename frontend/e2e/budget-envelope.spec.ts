import { expect, test } from '@playwright/test'
import type { Locator, Page, Route } from '@playwright/test'
import type {
  Account,
  Allocation,
  BudgetEntry,
  BudgetPeriod,
  BudgetTransaction,
  BudgetTransactionPage,
  FullBudgetTransaction,
  CardCredit,
  Category,
  PaginatedResponse,
  User,
} from '@tally-trace/shared'
import { householdWishlistRoutes } from './support/fixtures/household'
import { landingStubs } from './support/landing'
import { apiRoute, errorRoute, mockApi, queryRoute, sequenceRoute } from './support/mockApi'
import type { ApiMock, ApiRoute } from './support/mockApi'
import { shot } from './support/shot'
import { signedIn } from './support/signedIn'

// STU-798 in the browser: the budget envelope form (account picker, carry-over switch, no "Amount already spent"),
// the card and snapshot figures, the refetch on opening a dialog, and the envelope detail (period history and the
// transactions each window counts). The API is faked, so no stack is needed.

test.use({ locale: 'en-US' })

const user: User = {
  id: 1,
  email: 'e2e@example.com',
  first_name: 'Ada',
  last_name: 'Tester',
  default_currency: 'PHP',
  is_active: true,
  is_verified: true,
  onboarding_completed: true,
  created_at: '2026-01-01T00:00:00',
}

const account = (id: number, name: string): Account => ({
  id,
  name,
  account_type: 'checking',
  balance: 25000,
  currency: 'PHP',
  tags: [],
  my_role: 'owner',
  owner_name: null,
  permissions: {
    can_edit_settings: true,
    can_manage_shares: true,
    can_add_transactions: true,
    can_delete: true,
    can_view_details: true,
  },
})
const everyday = account(1, 'Everyday')
const joint = account(2, 'Joint savings')

const category = (id: number, name: string): Category => ({
  id,
  name,
  is_expense: true,
  kind: 'expense',
  is_active: true,
  created_at: '2026-01-01T00:00:00',
})
const groceries = category(5, 'Groceries')
const dining = category(7, 'Dining')
const savingsCategory = category(6, 'Savings')

const PERIOD_START = '2031-03-01T00:00:00'
const PERIOD_END = '2031-04-01T00:00:00'

/** A budget as the list and detail return it: carry off, a limit of 8,000, 2,500 spent, every rate known. */
const envelope = (over: Partial<Allocation> = {}): Allocation => ({
  id: 31,
  account_id: null,
  name: 'Groceries',
  allocation_type: 'budget',
  target_amount: 8000,
  current_amount: 2500,
  current_amount_complete: true,
  current_amount_missing: [],
  current_amount_source: null,
  period_frequency: 'monthly',
  period_start: PERIOD_START,
  period_end: PERIOD_END,
  currency: 'PHP',
  is_active: true,
  created_at: '2026-01-01T00:00:00',
  configuration: { category_ids: [groceries.id], account_ids: [] },
  carry_over_from: null,
  carry_in: 0,
  available: 8000,
  complete: true,
  missing: [],
  provisional: false,
  inherited_missing: [],
  ...over,
})

const savingsGoal: Allocation = {
  id: 21,
  account_id: everyday.id,
  name: 'Trip fund',
  allocation_type: 'savings',
  target_amount: 50000,
  current_amount: 1000,
  current_amount_complete: true,
  current_amount_missing: [],
  current_amount_source: 'Balance of Everyday',
  currency: 'PHP',
  is_active: true,
  created_at: '2026-01-01T00:00:00',
  configuration: { goal_mode: 'target_balance' },
}

const page_ = <T>(items: T[]): PaginatedResponse<T> => ({ items, total: items.length, has_more: false })

interface OpenOptions {
  /** The budgets the list returns, then any other routes. */
  list: Allocation[]
  routes?: ApiRoute[]
  tab?: 'Budgets' | 'Savings'
}

async function openAllocations(page: Page, { list, routes = [], tab = 'Budgets' }: OpenOptions): Promise<ApiMock> {
  await mockApi(page, [], {
    allow: [
      ...landingStubs().filter((r) => r.path !== '/allocations/'),
      apiRoute<Category[]>('GET', '/categories/', [groceries, dining, savingsCategory]),
      apiRoute<PaginatedResponse<BudgetEntry>>('GET', '/budget-entries/', page_<BudgetEntry>([])),
      apiRoute<{ items: CardCredit[] }>('GET', '/cards/credit', { items: [] }),
      apiRoute<PaginatedResponse<Account>>('GET', '/accounts/', page_([everyday, joint])),
    ],
  })
  const api = await signedIn(page, user)
  await mockApi(page, [apiRoute<PaginatedResponse<Allocation>>('GET', '/allocations/', page_(list)), ...routes])
  await page.goto('/allocations')
  await page.getByRole('button', { name: tab, exact: true }).click()
  return api
}

const card = (page: Page, name: string): Locator =>
  page.locator('article[role="button"]').filter({ has: page.getByText(name, { exact: true }) })

const addForm = async (page: Page): Promise<Locator> => {
  await page.getByRole('button', { name: 'Add budget' }).click()
  await expect(page.getByRole('heading', { name: /^Create budget envelope/ })).toBeVisible()
  return page.locator('form').filter({ has: page.getByRole('button', { name: /^Create / }) })
}

const editForm = async (page: Page, name = 'Groceries'): Promise<Locator> => {
  await card(page, name).click()
  await page.getByRole('button', { name: 'Edit allocation' }).click()
  const form = page.locator('form').filter({ has: page.getByRole('button', { name: 'Update allocation' }) })
  await expect(form).toBeVisible()
  return form
}

const field = (form: Locator, key: string): Locator => form.locator(`[data-field="${key}"]`)
const labelsOf = (form: Locator): Promise<string[]> =>
  form.locator('label').evaluateAll((els) => els.filter((e) => e.getBoundingClientRect().width > 0).map((e) => (e as HTMLElement).innerText.trim()))
const carrySwitch = (form: Locator): Locator => form.getByRole('switch', { name: 'Carry over to next period' })
const accountPicker = (form: Locator): Locator => field(form, 'budget_account_ids')
const pickCategory = (form: Locator): Promise<void> => form.getByRole('button', { name: /Groceries/ }).first().click()
const snapshot = (page: Page): Locator => page.locator('.modal-backdrop').filter({ has: page.getByText('Budget snapshot') })
const detail = (page: Page): Locator => page.getByTestId('budget-detail')

const bodiesOf = (api: ApiMock, method: 'POST' | 'PUT', path: string): Record<string, unknown>[] =>
  api.bodies(method, path) as Record<string, unknown>[]

/** The wire value of a date input's day, as the form sends it. */
const wire = (day: string): string => `${day}T00:00:00Z`

// ─── Form ────────────────────────────────────────────────────────────────────

test.describe('budget form (STU-798)', () => {
  test('Budget create and edit omit legacy inputs', async ({ page }) => {
    const env = envelope()
    const api = await openAllocations(page, {
      list: [env],
      routes: [
        apiRoute<Allocation>('GET', `/allocations/${env.id}`, env),
        apiRoute<Allocation>('POST', '/allocations/', env, 201),
        apiRoute<Allocation>('PUT', `/allocations/${env.id}`, env),
      ],
    })
    const form = await addForm(page)
    expect(await labelsOf(form)).toEqual([
      'Name', 'Description', 'Tracked categories', 'Accounts', 'Budget cadence', 'Period start', 'Period end (optional)', 'Spending limit (optional)',
    ])
    await expect(form.getByText('Amount already spent')).toHaveCount(0)
    await expect(field(form, 'current_amount')).toHaveCount(0)
    await expect(field(form, 'account_id')).toHaveCount(0)
    await expect(form.getByText('Select account')).toHaveCount(0)
    await field(form, 'name').fill('Dining')
    await field(form, 'target_amount').fill('3000')
    await pickCategory(form)
    await form.getByRole('button', { name: 'Create budget envelope' }).click()
    await expect.poll(() => bodiesOf(api, 'POST', '/allocations/').length).toBe(1)
    const created = bodiesOf(api, 'POST', '/allocations/')[0]
    expect(created).not.toHaveProperty('current_amount')
    expect(created).not.toHaveProperty('account_id')
    expect(created).toHaveProperty('configuration.category_ids', [groceries.id])
    await shot(page, 'budget-form-create')

    const edit = await editForm(page)
    await expect(edit.getByText('Amount already spent')).toHaveCount(0)
    await expect(field(edit, 'account_id')).toHaveCount(0)
    await edit.getByRole('button', { name: 'Update allocation' }).click()
    await expect(edit).toBeHidden()
    const puts = bodiesOf(api, 'PUT', `/allocations/${env.id}`)
    expect(puts).toHaveLength(1)
    expect(puts[0]).not.toHaveProperty('current_amount')
    expect(puts[0]).not.toHaveProperty('account_id')
  })

  test('Budget account selections load, save and clear', async ({ page }) => {
    const env = envelope({ configuration: { category_ids: [groceries.id], account_ids: [joint.id] } })
    const api = await openAllocations(page, {
      list: [env],
      routes: [
        apiRoute<Allocation>('GET', `/allocations/${env.id}`, env),
        apiRoute<Allocation>('POST', '/allocations/', env, 201),
        apiRoute<Allocation>('PUT', `/allocations/${env.id}`, env),
      ],
    })
    // A new envelope counts every account.
    const form = await addForm(page)
    const all = accountPicker(form).locator('[data-picker-leading="all"]')
    await expect(all).toHaveAttribute('aria-pressed', 'true')
    await expect(all).toBeDisabled()
    await field(form, 'name').fill('Dining')
    await field(form, 'target_amount').fill('3000')
    await pickCategory(form)
    await accountPicker(form).getByRole('button', { name: /^Everyday/ }).click()
    await accountPicker(form).getByRole('button', { name: /^Joint savings/ }).click()
    await expect(all).toHaveAttribute('aria-pressed', 'false')
    await form.getByRole('button', { name: 'Create budget envelope' }).click()
    await expect.poll(() => bodiesOf(api, 'POST', '/allocations/').length).toBe(1)
    expect(bodiesOf(api, 'POST', '/allocations/')[0]).toHaveProperty('configuration.account_ids', [everyday.id, joint.id])

    // Edit starts from the saved accounts, and All accounts clears them.
    const edit = await editForm(page)
    await expect(accountPicker(edit).getByRole('button', { name: /^Joint savings/ })).toHaveAttribute('aria-pressed', 'true')
    await expect(accountPicker(edit).getByRole('button', { name: /^Everyday/ })).toHaveAttribute('aria-pressed', 'false')
    await expect(accountPicker(edit).locator('[data-picker-leading="all"]')).toHaveAttribute('aria-pressed', 'false')
    await edit.getByRole('button', { name: 'Update allocation' }).click()
    await expect(edit).toBeHidden()
    expect(bodiesOf(api, 'PUT', `/allocations/${env.id}`)[0]).toHaveProperty('configuration.account_ids', [joint.id])

    const again = await editForm(page)
    await accountPicker(again).locator('[data-picker-leading="all"]').click()
    await expect(accountPicker(again).locator('[data-picker-leading="all"]')).toHaveAttribute('aria-pressed', 'true')
    await again.getByRole('button', { name: 'Update allocation' }).click()
    await expect(again).toBeHidden()
    const puts = bodiesOf(api, 'PUT', `/allocations/${env.id}`)
    expect(puts).toHaveLength(2)
    expect(puts[1]).toHaveProperty('configuration.account_ids', [])
  })

  test('Carry starts this period, turns off and requires a limit', async ({ page }) => {
    const carried = envelope({ carry_over_from: '2031-02-01T00:00:00', carry_in: 500, available: 8500 })
    const api = await openAllocations(page, {
      list: [carried],
      routes: [
        apiRoute<Allocation>('GET', `/allocations/${carried.id}`, carried),
        apiRoute<Allocation>('POST', '/allocations/', carried, 201),
        apiRoute<Allocation>('PUT', `/allocations/${carried.id}`, carried),
      ],
    })
    const form = await addForm(page)
    const sw = carrySwitch(form)
    const help = 'Leftover adds to next period; overspending is taken from it. Starts this period.'
    await expect(form.getByTestId('carry-help')).toHaveText(help)
    // New envelopes start off, and with no limit the switch is off and disabled.
    await expect(sw).toHaveAttribute('aria-checked', 'false')
    await expect(sw).toBeDisabled()
    await field(form, 'name').fill('Dining')
    await pickCategory(form)
    await field(form, 'target_amount').fill('3000')
    await expect(sw).toBeEnabled()
    await expect(sw).toHaveAttribute('aria-checked', 'false')
    await sw.click()
    await expect(sw).toHaveAttribute('aria-checked', 'true')
    // Clearing the limit turns it off and disables it again; typing a limit back restores the choice the user made.
    await field(form, 'target_amount').fill('')
    await expect(sw).toHaveAttribute('aria-checked', 'false')
    await expect(sw).toBeDisabled()
    await field(form, 'target_amount').fill('3000')
    await expect(sw).toHaveAttribute('aria-checked', 'true')
    const start = await field(form, 'period_start').inputValue()
    await shot(page, 'budget-form-carry')
    await form.getByRole('button', { name: 'Create budget envelope' }).click()
    await expect.poll(() => bodiesOf(api, 'POST', '/allocations/').length).toBe(1)
    // Turned on, it starts at this period's start.
    const created = bodiesOf(api, 'POST', '/allocations/')[0]
    expect(created).toHaveProperty('carry_over', true)
    expect(created).toHaveProperty('carry_over_from', wire(start))

    // Edit shows the saved carry; saved as it is, it keeps its saved start though a new period has begun.
    const edit = await editForm(page)
    await expect(carrySwitch(edit)).toHaveAttribute('aria-checked', 'true')
    await edit.getByRole('button', { name: 'Update allocation' }).click()
    await expect(edit).toBeHidden()
    let puts = bodiesOf(api, 'PUT', `/allocations/${carried.id}`)
    expect(puts[0]).toHaveProperty('carry_over', true)
    expect(puts[0]).toHaveProperty('carry_over_from', '2031-02-01T00:00:00')
    expect(puts[0]).not.toHaveProperty('carry_over_from', wire(PERIOD_START.slice(0, 10)))

    // Turned off, it sends null.
    const off = await editForm(page)
    await carrySwitch(off).click()
    await expect(carrySwitch(off)).toHaveAttribute('aria-checked', 'false')
    await off.getByRole('button', { name: 'Update allocation' }).click()
    await expect(off).toBeHidden()
    puts = bodiesOf(api, 'PUT', `/allocations/${carried.id}`)
    expect(puts[1]).toHaveProperty('carry_over', false)
    expect(puts[1]).toHaveProperty('carry_over_from', null)

    // Clearing the limit clears carry on save, and the limit goes as null.
    const cleared = await editForm(page)
    await field(cleared, 'target_amount').fill('')
    await expect(carrySwitch(cleared)).toHaveAttribute('aria-checked', 'false')
    await expect(carrySwitch(cleared)).toBeDisabled()
    await cleared.getByRole('button', { name: 'Update allocation' }).click()
    await expect(cleared).toBeHidden()
    puts = bodiesOf(api, 'PUT', `/allocations/${carried.id}`)
    expect(puts).toHaveLength(3)
    expect(puts[2]).toHaveProperty('carry_over', false)
    expect(puts[2]).toHaveProperty('carry_over_from', null)
    expect(puts[2]).toHaveProperty('target_amount', null)
  })

  test('Form explains which settings history uses', async ({ page }) => {
    await openAllocations(page, { list: [envelope()] })
    const form = await addForm(page)
    await expect(form.getByTestId('budget-history-note')).toHaveText("Period history uses this envelope's current categories and accounts.")
    await expect(form.getByTestId('budget-history-note')).toHaveCount(1)
  })
})

// ─── Card and snapshot dialog ────────────────────────────────────────────────

/** Opens an envelope's snapshot dialog; the detail read answers with `fresh` (the list's own copy by default). */
async function openSnapshot(page: Page, env: Allocation, fresh: Allocation = env): Promise<{ api: ApiMock; dialog: Locator }> {
  const api = await openAllocations(page, { list: [env], routes: [apiRoute<Allocation>('GET', `/allocations/${env.id}`, fresh)] })
  await card(page, env.name).click()
  const dialog = snapshot(page)
  await expect(dialog).toBeVisible()
  return { api, dialog }
}

const texts = async (scope: Locator, prefix: 'card' | 'snapshot', names: string[]): Promise<Record<string, string | null>> => {
  const out: Record<string, string | null> = {}
  for (const name of names) {
    const el = scope.getByTestId(`${prefix}-${name}`)
    out[name] = (await el.count()) === 0 ? null : ((await el.textContent()) ?? '').trim()
  }
  return out
}

test.describe('budget card and snapshot (STU-798)', () => {
  test('Card and snapshot agree on spent, available and carry', async ({ page }) => {
    const env = envelope({ carry_over_from: '2031-02-01T00:00:00', carry_in: 500, available: 8500, current_amount: 2500 })
    const { dialog } = await openSnapshot(page, env)
    const onCard = card(page, env.name)
    await expect(onCard.getByTestId('card-carry')).toHaveText('₱500.00')
    const names = ['limit', 'carry', 'available', 'spent', 'remaining', 'usage']
    const cardFigures = await texts(onCard, 'card', names)
    const dialogFigures = await texts(dialog, 'snapshot', names)
    expect(cardFigures).toEqual({
      limit: '₱8,000.00',
      carry: '₱500.00',
      available: '₱8,500.00',
      spent: '₱2,500.00',
      remaining: '₱6,000.00',
      usage: '29.4% of available used',
    })
    expect(dialogFigures).toEqual(cardFigures)
    await shot(page, 'budget-snapshot-carry')
  })

  test('Overspent envelopes show the overage without a usage ratio', async ({ page }) => {
    const over = envelope({ current_amount: 9000, available: 8000 })
    const { dialog } = await openSnapshot(page, over)
    for (const [scope, prefix] of [[card(page, over.name), 'card'], [dialog, 'snapshot']] as const) {
      await expect(scope.getByTestId(`${prefix}-over`)).toHaveText('Over by ₱1,000.00')
      await expect(scope.getByTestId(`${prefix}-over`)).toHaveClass(/text-danger/)
      await expect(scope.getByTestId('budget-usage-track')).toHaveCount(0)
      await expect(scope.getByTestId(`${prefix}-usage`)).toHaveCount(0)
      await expect(scope.getByTestId(`${prefix}-remaining`)).toHaveCount(0)
      await expect(scope.getByText(/% of (limit|available) used/)).toHaveCount(0)
    }
    await shot(page, 'budget-over')
  })

  test('Overspending against a carried-in debt is over available, not over the limit', async ({ page }) => {
    // 6,500 spent is under the 8,000 limit but over the 6,000 available once 2,000 of debt carries in.
    const env = envelope({ carry_over_from: '2031-02-01T00:00:00', carry_in: -2000, available: 6000, current_amount: 6500 })
    const { dialog } = await openSnapshot(page, env)
    await expect(card(page, env.name).getByTestId('card-carry')).toHaveText('−₱2,000.00')
    await expect(card(page, env.name).getByTestId('card-over')).toHaveText('Over by ₱500.00')
    await expect(dialog.getByTestId('snapshot-over')).toHaveText('Over by ₱500.00')
  })

  test('Zero spent and zero available show zero left', async ({ page }) => {
    const zero = envelope({ target_amount: 1000, carry_over_from: '2031-02-01T00:00:00', carry_in: -1000, available: 0, current_amount: 0 })
    const { dialog } = await openSnapshot(page, zero)
    for (const [scope, prefix] of [[card(page, zero.name), 'card'], [dialog, 'snapshot']] as const) {
      await expect(scope.getByTestId(`${prefix}-zero`)).toHaveText('0 left')
      await expect(scope.getByTestId('budget-usage-track')).toHaveCount(0)
      await expect(scope.getByTestId(`${prefix}-over`)).toHaveCount(0)
      await expect(scope.getByTestId(`${prefix}-remaining`)).toHaveCount(0)
    }
  })

  test('Current and inherited missing rates mark estimates', async ({ page }) => {
    const own = envelope({ id: 41, name: 'Own gap', complete: false, missing: ['USD'] })
    const inherited = envelope({ id: 42, name: 'Upstream gap', provisional: true, inherited_missing: ['EUR'] })
    const both = envelope({ id: 43, name: 'Both gaps', complete: false, missing: ['USD'], provisional: true, inherited_missing: ['EUR', 'USD'] })
    const exact = envelope({ id: 44, name: 'Exact' })
    const api = await openAllocations(page, {
      list: [own, inherited, both, exact],
      routes: [own, inherited, both, exact].map((e) => apiRoute<Allocation>('GET', `/allocations/${e.id}`, e)),
    })
    void api
    const expected: Array<[Allocation, string | null]> = [
      [own, 'Estimate — missing rates for USD'],
      [inherited, 'Estimate — missing rates for EUR'],
      [both, 'Estimate — missing rates for USD, EUR'],
      [exact, null],
    ]
    for (const [env, text] of expected) {
      const onCard = card(page, env.name)
      if (text) await expect(onCard.getByTestId('card-estimate')).toHaveText(text)
      else await expect(onCard.getByTestId('card-estimate')).toHaveCount(0)
      await onCard.click()
      const dialog = snapshot(page)
      await expect(dialog).toBeVisible()
      if (text) await expect(dialog.getByTestId('snapshot-estimate')).toHaveText(text)
      else await expect(dialog.getByTestId('snapshot-estimate')).toHaveCount(0)
      await page.getByRole('button', { name: 'Close allocation actions modal' }).click()
      await expect(dialog).toBeHidden()
    }
    await shot(page, 'budget-estimates')
  })

  test('Unlimited envelopes show spent without limit figures', async ({ page }) => {
    const unlimited = envelope({
      target_amount: undefined,
      monthly_target: undefined,
      available: null,
      current_amount: 1200,
      complete: false,
      missing: ['USD'],
    })
    const { dialog } = await openSnapshot(page, unlimited)
    for (const [scope, prefix] of [[card(page, unlimited.name), 'card'], [dialog, 'snapshot']] as const) {
      await expect(scope.getByTestId(`${prefix}-spent`)).toHaveText('₱1,200.00')
      await expect(scope.getByTestId(`${prefix}-estimate`)).toHaveText('Estimate — missing rates for USD')
      for (const hidden of ['limit', 'remaining', 'carry', 'available', 'over', 'zero', 'usage']) {
        await expect(scope.getByTestId(`${prefix}-${hidden}`)).toHaveCount(0)
      }
      await expect(scope.getByTestId('budget-usage-track')).toHaveCount(0)
      await expect(scope.getByText('Spending limit')).toHaveCount(0)
    }
    await shot(page, 'budget-unlimited')
  })

  test('Opening either dialog refreshes the card and dialog after a period roll', async ({ page }) => {
    // The list loaded before midnight; by the time the dialog opens the window has rolled and 5,500 carries in.
    const stale = envelope({ carry_over_from: '2031-02-01T00:00:00', carry_in: 0, available: 8000, current_amount: 2500 })
    const rolled = envelope({
      carry_over_from: '2031-02-01T00:00:00',
      period_start: '2031-04-01T00:00:00',
      period_end: '2031-05-01T00:00:00',
      carry_in: 5500,
      available: 13500,
      current_amount: 300,
    })
    const periods: BudgetPeriod[] = [
      period('2031-04-01', '2031-05-01', { limit: 8000, carry_in: 5500, available: 13500, spent: 300, remaining: 13200, is_current: true }),
      period('2031-03-01', '2031-04-01', { limit: 8000, carry_in: 0, available: 8000, spent: 2500, remaining: 5500 }),
    ]
    const api = await openAllocations(page, {
      list: [stale],
      routes: [
        sequenceRoute<Allocation>('GET', `/allocations/${stale.id}`, [{ body: rolled }]),
        apiRoute<BudgetPeriod[]>('GET', `/allocations/${stale.id}/periods`, periods),
        queryRoute<BudgetTransactionPage>('GET', `/allocations/${stale.id}/transactions`, () => countedPage([], 300)),
      ],
    })
    await expect(card(page, stale.name).getByTestId('card-spent')).toHaveText('₱2,500.00')
    expect(api.count('GET', `/allocations/${stale.id}`)).toBe(0)

    // Opening the snapshot dialog refetches; the fresh copy replaces the card's and the dialog's.
    await card(page, stale.name).click()
    const dialog = snapshot(page)
    await expect(dialog.getByTestId('snapshot-spent')).toHaveText('₱300.00')
    await expect(dialog.getByTestId('snapshot-carry')).toHaveText('₱5,500.00')
    await expect(dialog.getByTestId('snapshot-available')).toHaveText('₱13,500.00')
    expect(api.count('GET', `/allocations/${stale.id}`)).toBe(1)
    await expect(card(page, stale.name).getByTestId('card-spent')).toHaveText('₱300.00')
    await expect(card(page, stale.name).getByTestId('card-carry')).toHaveText('₱5,500.00')

    // Opening the history refetches too, and reads no history until that read is back.
    let release: () => void = () => undefined
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    await page.route(`**/api/v1/allocations/${stale.id}`, async (route: Route) => {
      await held
      await route.fallback()
    })
    await dialog.getByTestId('open-budget-history').click()
    await expect(page.getByTestId('budget-detail')).toBeVisible()
    await page.waitForTimeout(300)
    expect(api.requests().filter((r) => r === `GET /allocations/${stale.id}/periods`)).toHaveLength(0)
    expect(api.requests().filter((r) => r === `GET /allocations/${stale.id}/transactions`)).toHaveLength(0)
    await expect(page.getByTestId('budget-periods')).toHaveCount(0)
    release()
    await expect(page.getByTestId('budget-periods')).toBeVisible()
    await expect(detail(page).locator('[data-row-kind="budget-period"]')).toHaveCount(2)
    expect(api.count('GET', `/allocations/${stale.id}`)).toBe(2)
    expect(api.count('GET', `/allocations/${stale.id}/periods`)).toBe(1)
  })
})

// ─── Envelope detail ─────────────────────────────────────────────────────────

/** A window of an envelope; the end is exclusive. */
const period = (start: string, end: string, over: Partial<BudgetPeriod> = {}): BudgetPeriod => ({
  start: `${start}T00:00:00+00:00`,
  end: `${end}T00:00:00+00:00`,
  limit: 8000,
  carry_in: 0,
  available: 8000,
  spent: 0,
  remaining: 8000,
  complete: true,
  missing: [],
  provisional: false,
  inherited_missing: [],
  estimated: false,
  before_created: false,
  is_current: false,
  ...over,
})

const countedTx = (id: number, description: string, amount: number, day: string, over: Partial<FullBudgetTransaction> = {}): FullBudgetTransaction => ({
  view: 'full',
  id,
  account_id: everyday.id,
  amount,
  currency: 'PHP',
  description,
  transaction_type: 'debit',
  transaction_date: `${day}T00:00:00`,
  is_posted: true,
  is_reconciled: false,
  is_recurring: false,
  transfer_fee: 0,
  tags: [],
  category_id: groceries.id,
  created_at: `${day}T09:00:00`,
  permissions: { can_edit: true, can_delete: true, can_post: true, can_revert: true, can_tag: true },
  created_by: 'Ada T.',
  missing_rate: false,
  ...over,
})

const countedPage = (items: BudgetTransaction[], total: number, converted = total, hasMore = false): BudgetTransactionPage => ({
  items,
  total: items.length === 0 ? 0 : total,
  has_more: hasMore,
  currency_subtotals: { PHP: converted },
  converted_total: converted,
})

/** Twelve windows, newest first, from 2031-03 back to 2030-04, with one of each status the history marks. */
const twelveWindows = (): BudgetPeriod[] => {
  const months = ['2031-03', '2031-02', '2031-01', '2030-12', '2030-11', '2030-10', '2030-09', '2030-08', '2030-07', '2030-06', '2030-05', '2030-04']
  const next = (ym: string): string => {
    const [y, m] = ym.split('-').map(Number)
    return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`
  }
  return months.map((ym, i) => {
    const base = period(`${ym}-01`, `${next(ym)}-01`, { spent: 1000 + i * 100, remaining: 7000 - i * 100 })
    if (i === 0) return { ...base, is_current: true, carry_in: 250, available: 8250, remaining: 8250 - 1000 }
    if (i === 1) return { ...base, spent: 9500, remaining: -1500 }
    if (i === 2) return { ...base, complete: false, missing: ['USD'] }
    if (i === 3) return { ...base, provisional: true, inherited_missing: ['EUR'] }
    if (i === 9) return { ...base, estimated: true }
    if (i >= 10) return { ...base, estimated: true, before_created: true }
    return base
  })
}

const rowsOf = (scope: Locator, kind: string): Locator => scope.locator(`[data-row-kind="${kind}"]`)

test.describe('budget envelope detail (STU-798)', () => {
  test('Period history shows the newest windows and their status', async ({ page }) => {
    const env = envelope({ carry_over_from: '2030-12-01T00:00:00', carry_in: 250, available: 8250, current_amount: 1000 })
    const windows = twelveWindows()
    await openAllocations(page, {
      list: [env],
      routes: [
        apiRoute<Allocation>('GET', `/allocations/${env.id}`, env),
        apiRoute<BudgetPeriod[]>('GET', `/allocations/${env.id}/periods`, windows),
        queryRoute<BudgetTransactionPage>('GET', `/allocations/${env.id}/transactions`, () => countedPage([], 0, 1000)),
      ],
    })
    await card(page, env.name).click()
    await snapshot(page).getByTestId('open-budget-history').click()
    const periods = detail(page).getByTestId('budget-periods')
    const rows = rowsOf(periods, 'budget-period')
    await expect(rows).toHaveCount(12)
    // Newest first, as the API returned them.
    const starts = await rows.evaluateAll((els) => els.map((e) => e.getAttribute('data-start')))
    expect(starts).toEqual(windows.map((w) => w.start))
    expect([...starts].sort().reverse()).toEqual(starts)
    // Each row carries spent, available and remaining.
    await expect(rows.nth(0).getByTestId('period-spent')).toHaveText('Spent ₱1,000.00')
    await expect(rows.nth(0).getByTestId('period-available')).toHaveText('Available ₱8,250.00')
    await expect(rows.nth(0).getByTestId('period-remaining')).toHaveText('Remaining ₱7,250.00')
    await expect(rows.nth(0).getByTestId('period-current')).toHaveText('Current')
    await expect(rows.nth(1).getByTestId('period-remaining')).toHaveText('Over by ₱1,500.00')
    // Missing rates, own and inherited, before-creation and estimated windows are marked; plain ones are not.
    await expect(rows.nth(2).getByTestId('period-estimate')).toHaveText('Estimate — missing rates for USD')
    await expect(rows.nth(3).getByTestId('period-estimate')).toHaveText('Estimate — missing rates for EUR')
    await expect(rows.nth(9).getByTestId('period-estimated')).toHaveText('Estimated window')
    await expect(rows.nth(9).getByTestId('period-before-created')).toHaveCount(0)
    await expect(rows.nth(11).getByTestId('period-before-created')).toHaveText('Before created')
    await expect(rows.nth(11).getByTestId('period-estimated')).toHaveText('Estimated window')
    for (const i of [4, 5, 6, 7, 8]) {
      for (const mark of ['period-current', 'period-estimated', 'period-before-created', 'period-estimate']) {
        await expect(rows.nth(i).getByTestId(mark)).toHaveCount(0)
      }
    }
    await shot(page, 'budget-detail-periods')
  })

  test('Counted transactions follow the selected period and reconcile to spent', async ({ page }) => {
    const env = envelope({ current_amount: 2500 })
    const windows = [
      period('2031-03-01', '2031-04-01', { spent: 2500, remaining: 5500, is_current: true }),
      period('2031-02-01', '2031-03-01', { spent: 1800, remaining: 6200 }),
      period('2031-01-01', '2031-02-01', { spent: 0, remaining: 8000 }),
    ]
    const currentRows = Array.from({ length: 25 }, (_, i) =>
      countedTx(1000 + i, `Current row ${i + 1}`, 100, '2031-03-05', i === 3 ? { missing_rate: true, currency: 'USD', amount: 2 } : {}),
    )
    const febRows = Array.from({ length: 4 }, (_, i) => countedTx(2000 + i, `Feb row ${i + 1}`, 450, '2031-02-10'))
    const calls: Array<{ start: string | null; limit: string | null; offset: string | null }> = []
    const api = await openAllocations(page, {
      list: [env],
      routes: [
        apiRoute<Allocation>('GET', `/allocations/${env.id}`, env),
        apiRoute<BudgetPeriod[]>('GET', `/allocations/${env.id}/periods`, windows),
        queryRoute<BudgetTransactionPage>('GET', `/allocations/${env.id}/transactions`, (q) => {
          const start = q.get('period_start')
          // `queryRoute` also answers once with an empty query when it is registered; that is not a request.
          if (start !== null) calls.push({ start, limit: q.get('limit'), offset: q.get('offset') })
          const offset = Number(q.get('offset') ?? 0)
          const limit = Number(q.get('limit') ?? 10)
          if (start === windows[1].start) return countedPage(febRows.slice(offset, offset + limit), febRows.length, 1800)
          if (start === windows[2].start) return countedPage([], 0, 0)
          return countedPage(currentRows.slice(offset, offset + limit), currentRows.length, 2500, offset + limit < currentRows.length)
        }),
      ],
    })
    void api
    await card(page, env.name).click()
    await snapshot(page).getByTestId('open-budget-history').click()
    const counted = detail(page).getByTestId('budget-counted')
    const periodRows = rowsOf(detail(page).getByTestId('budget-periods'), 'budget-period')

    // The current window is selected on open: its rows, page one, 10 to a page.
    await expect(periodRows.nth(0)).toHaveAttribute('aria-current', 'true')
    await expect(rowsOf(counted, 'counted-transaction')).toHaveCount(10)
    expect(calls[0]).toEqual({ start: windows[0].start, limit: '10', offset: '0' })
    await expect(counted.getByTestId('counted-pager')).toContainText('1–10 of 25')
    // Every row links to its transaction; a row missing a rate is flagged, the others are not.
    const link = rowsOf(counted, 'counted-transaction').nth(0).getByRole('link', { name: 'Current row 1' })
    await expect(link).toHaveAttribute('href', /\/transactions\?edit=1000$/)
    await expect(counted.getByTestId('counted-missing-rate')).toHaveCount(1)
    await expect(rowsOf(counted, 'counted-transaction').nth(3).getByTestId('counted-missing-rate')).toHaveText('Missing rate')
    // The footer total is the window's spent.
    await expect(counted.getByTestId('counted-total')).toHaveText('₱2,500.00')
    await expect(periodRows.nth(0).getByTestId('period-spent')).toHaveText('Spent ₱2,500.00')

    // Page two of the same window.
    await counted.getByRole('button', { name: 'Next' }).click()
    await expect(counted.getByTestId('counted-pager')).toContainText('11–20 of 25')
    await expect(rowsOf(counted, 'counted-transaction').nth(0).getByRole('link')).toHaveText('Current row 11')
    expect(calls[calls.length - 1]).toEqual({ start: windows[0].start, limit: '10', offset: '10' })

    // Changing the window loads page one of that window.
    await periodRows.nth(1).getByRole('button').click()
    await expect(periodRows.nth(1)).toHaveAttribute('aria-current', 'true')
    await expect(rowsOf(counted, 'counted-transaction')).toHaveCount(4)
    await expect(rowsOf(counted, 'counted-transaction').nth(0).getByRole('link')).toHaveText('Feb row 1')
    expect(calls[calls.length - 1]).toEqual({ start: windows[1].start, limit: '10', offset: '0' })
    await expect(counted.getByTestId('counted-pager')).toContainText('1–4 of 4')
    await expect(counted.getByTestId('counted-total')).toHaveText('₱1,800.00')
    await expect(periodRows.nth(1).getByTestId('period-spent')).toHaveText('Spent ₱1,800.00')
    await shot(page, 'budget-detail-counted')

    // An empty window shows the empty state and that window's spent total.
    await periodRows.nth(2).getByRole('button').click()
    await expect(counted.getByTestId('counted-empty')).toBeVisible()
    await expect(counted.getByTestId('empty-state')).toContainText('No transactions are counted in this period.')
    await expect(rowsOf(counted, 'counted-transaction')).toHaveCount(0)
    await expect(counted.getByTestId('counted-total')).toHaveText('₱0.00')
  })

  test('Budget changes preserve other Allocations flows', async ({ page }) => {
    const env = envelope()
    const api = await openAllocations(page, {
      list: [savingsGoal, env],
      routes: [
        apiRoute<Allocation>('GET', `/allocations/${env.id}`, env),
        apiRoute<Allocation>('POST', '/allocations/', savingsGoal, 201),
        apiRoute<Allocation>('PUT', `/allocations/${savingsGoal.id}`, savingsGoal),
      ],
      tab: 'Savings',
    })
    // Savings: the same form (tracking mode, its account select), the same payload, no carry switch, and its dialog
    // reads nothing extra.
    await page.getByRole('button', { name: 'Add savings goal' }).click()
    const form = page.locator('form').filter({ has: page.getByRole('button', { name: /^Create / }) })
    expect(await labelsOf(form)).toEqual(['Tracking mode', 'Account', 'Name', 'Description', 'Currency', 'Target amount (optional)', 'Monthly target (optional)', 'Target date'])
    await expect(carrySwitch(form)).toHaveCount(0)
    await expect(field(form, 'budget_account_ids')).toHaveCount(0)
    await field(form, 'account_id').selectOption(String(everyday.id))
    await field(form, 'name').fill('Rainy day')
    await form.getByRole('button', { name: 'Create savings tracker' }).click()
    await expect.poll(() => bodiesOf(api, 'POST', '/allocations/').length).toBe(1)
    const body = bodiesOf(api, 'POST', '/allocations/')[0]
    expect(body).toHaveProperty('account_id', everyday.id)
    expect(body).not.toHaveProperty('carry_over')
    expect(body).not.toHaveProperty('carry_over_from')
    expect(body).not.toHaveProperty('configuration.account_ids')
    await card(page, savingsGoal.name).click()
    await expect(page.getByTestId('open-budget-history')).toHaveCount(0)
    await expect(page.getByText('Current progress')).toBeVisible()
    await page.getByRole('button', { name: 'Close allocation actions modal' }).click()
    expect(api.count('GET', `/allocations/${savingsGoal.id}`)).toBe(0)

    // The other tabs keep their header action and intro.
    await mockApi(page, householdWishlistRoutes([]))
    for (const [tab, add, intro] of [
      ['Recurring', 'Add recurring entry', 'Recurring entries'],
      ['Budgets', 'Add budget', 'Budget envelopes'],
      ['Savings', 'Add savings goal', 'Savings & investment targets'],
      ['Wishlist', 'Add wishlist item', null],
    ] as const) {
      await page.getByRole('button', { name: tab, exact: true }).click()
      await expect(page.getByTestId('page-actions').getByRole('button', { name: add, exact: true })).toBeVisible()
      if (intro) await expect(page.getByTestId('section-intro').getByRole('heading', { name: intro })).toBeVisible()
    }
  })

  test('Dialog read failures do not show stale figures or rows', async ({ page }) => {
    const env = envelope({ current_amount: 2500 })
    const windows = [
      period('2031-03-01', '2031-04-01', { spent: 2500, remaining: 5500, is_current: true }),
      period('2031-02-01', '2031-03-01', { spent: 1800, remaining: 6200 }),
    ]
    const rows = Array.from({ length: 3 }, (_, i) => countedTx(3000 + i, `Row ${i + 1}`, 100, '2031-03-05'))
    const api = await openAllocations(page, {
      list: [env],
      routes: [
        // The first envelope read fails (the snapshot dialog), the second succeeds (the history), the third fails.
        sequenceRoute<Allocation | { detail: string }>('GET', `/allocations/${env.id}`, [
          { body: { detail: 'down' }, status: 500 },
          { body: env },
          { body: { detail: 'down' }, status: 500 },
        ]),
        sequenceRoute<BudgetPeriod[] | { detail: string }>('GET', `/allocations/${env.id}/periods`, [
          { body: { detail: 'down' }, status: 500 },
          { body: windows },
        ]),
        queryRoute<BudgetTransactionPage>('GET', `/allocations/${env.id}/transactions`, () => countedPage(rows, rows.length, 300)),
      ],
    })

    // 1. The envelope refetch fails: the dialog says so and shows no figures; the card keeps its last good data.
    await card(page, env.name).click()
    const dialog = snapshot(page)
    await expect(dialog.getByTestId('snapshot-error')).toBeVisible()
    await expect(dialog.getByTestId('snapshot-figures')).toHaveCount(0)
    await expect(card(page, env.name).getByTestId('card-spent')).toHaveText('₱2,500.00')
    // Retry reads it again: the second answer succeeds.
    await dialog.getByTestId('snapshot-error').getByRole('button', { name: 'Retry' }).click()
    await expect(dialog.getByTestId('snapshot-spent')).toHaveText('₱2,500.00')

    // 2. The history's own envelope read fails (the third answer): history stays hidden and reads nothing.
    await dialog.getByTestId('open-budget-history').click()
    await expect(page.getByTestId('budget-detail-error')).toBeVisible()
    await expect(page.getByTestId('budget-periods')).toHaveCount(0)
    await expect(page.getByTestId('budget-counted')).toHaveCount(0)
    expect(api.count('GET', `/allocations/${env.id}/periods`)).toBe(0)
    expect(api.count('GET', `/allocations/${env.id}/transactions`)).toBe(0)
    await page.getByRole('button', { name: 'Close envelope history' }).click()

    // 3. Periods fail: that section shows an error and no rows; the counted section waits on a window.
    await mockApi(page, [sequenceRoute<Allocation>('GET', `/allocations/${env.id}`, [{ body: env }])])
    await card(page, env.name).click()
    await snapshot(page).getByTestId('open-budget-history').click()
    await expect(page.getByTestId('budget-periods-error')).toBeVisible()
    await expect(rowsOf(detail(page), 'budget-period')).toHaveCount(0)
    await expect(page.getByTestId('budget-counted')).toHaveCount(0)
    await page.getByTestId('budget-periods-error').getByRole('button', { name: 'Retry' }).click()
    await expect(rowsOf(detail(page), 'budget-period')).toHaveCount(2)
    await expect(rowsOf(detail(page), 'counted-transaction')).toHaveCount(3)

    // 4. Counted transactions fail for the next window: the error shows and the previous window's rows are gone.
    await page.route(`**/api/v1/allocations/${env.id}/transactions*`, async (route: Route) => {
      if (new URL(route.request().url()).searchParams.get('period_start') === windows[1].start) {
        await route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ detail: 'down' }) })
        return
      }
      await route.fallback()
    })
    await rowsOf(detail(page), 'budget-period').nth(1).getByRole('button').click()
    await expect(page.getByTestId('budget-counted-error')).toBeVisible()
    await expect(rowsOf(detail(page), 'counted-transaction')).toHaveCount(0)
    await expect(page.getByTestId('counted-total')).toHaveCount(0)
    await shot(page, 'budget-detail-failed-counted')
  })

  test('Failed budget saves preserve form values and list data', async ({ page }) => {
    const env = envelope()
    await openAllocations(page, {
      list: [env],
      routes: [
        apiRoute<Allocation>('GET', `/allocations/${env.id}`, env),
        errorRoute('POST', '/allocations/', 422, 'carry_over needs a target_amount or a monthly_target'),
        errorRoute('PUT', `/allocations/${env.id}`, 500, 'The server could not save this envelope'),
      ],
    })
    await expect(card(page, env.name)).toBeVisible()

    const form = await addForm(page)
    await field(form, 'name').fill('Dining')
    await form.locator('textarea').fill('Eating out')
    await field(form, 'target_amount').fill('3000')
    await pickCategory(form)
    await form.getByRole('button', { name: 'Create budget envelope' }).click()
    await expect(form.getByTestId('allocation-form-error')).toHaveText('carry_over needs a target_amount or a monthly_target')
    await expect(form).toBeVisible()
    await expect(field(form, 'name')).toHaveValue('Dining')
    await expect(field(form, 'target_amount')).toHaveValue('3000')
    await expect(form.getByRole('button', { name: /Groceries/ }).first()).toHaveAttribute('aria-pressed', 'true')
    // The list on screen is the one it was: no envelope was added and the saved one is unchanged.
    await expect(page.locator('article[role="button"]')).toHaveCount(1)
    await page.getByRole('button', { name: 'Cancel' }).click()

    const edit = await editForm(page)
    await field(edit, 'name').fill('Groceries and more')
    await field(edit, 'target_amount').fill('9000')
    await edit.getByRole('button', { name: 'Update allocation' }).click()
    await expect(edit.getByTestId('allocation-form-error')).toHaveText('The server could not save this envelope')
    await expect(edit).toBeVisible()
    await expect(field(edit, 'name')).toHaveValue('Groceries and more')
    await expect(field(edit, 'target_amount')).toHaveValue('9000')
    await page.getByRole('button', { name: 'Cancel' }).click()
    await expect(page.locator('article[role="button"]')).toHaveCount(1)
    await expect(card(page, 'Groceries').getByTestId('card-limit')).toHaveText('₱8,000.00')
    await expect(page.getByText('Groceries and more')).toHaveCount(0)
    await shot(page, 'budget-form-save-error')
  })
})
