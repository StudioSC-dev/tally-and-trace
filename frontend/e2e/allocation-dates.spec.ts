import fs from 'node:fs'
import { expect, test } from '@playwright/test'
import type { Locator, Page } from '@playwright/test'
import type { Account, Allocation, BudgetEntry, CardCredit, Category, PaginatedResponse, User } from '@tally-trace/shared'
import { landingStubs } from './support/landing'
import { apiRoute, mockApi, sequenceRoute } from './support/mockApi'
import type { ApiMock } from './support/mockApi'
import { shot } from './support/shot'
import { signedIn } from './support/signedIn'

// STU-640 in the browser: clearing an optional allocation date on edit sends null, an untouched date is left
// out of the save, and the required period start cannot be cleared. The API is faked, so no stack is needed.

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

const account: Account = {
  id: 1,
  name: 'Everyday',
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
}

const groceries: Category = {
  id: 5,
  name: 'Groceries',
  is_expense: true,
  kind: 'expense',
  is_active: true,
  created_at: '2026-01-01T00:00:00',
}

/** The API holds these two dates as nullable naive timestamps, and returns null once one is cleared. */
type StoredAllocation = Omit<Allocation, 'target_date' | 'period_end'> & {
  target_date?: string | null
  period_end?: string | null
}

const GOAL_ID = 11
const BUDGET_ID = 12

const goal: StoredAllocation = {
  id: GOAL_ID,
  account_id: account.id,
  name: 'Trip fund',
  allocation_type: 'savings',
  target_amount: 50000,
  current_amount: 1000,
  target_date: '2031-09-15T00:00:00',
  currency: 'PHP',
  is_active: true,
  created_at: '2026-01-01T00:00:00',
  configuration: { goal_mode: 'target_balance' },
}

const budget: StoredAllocation = {
  id: BUDGET_ID,
  account_id: account.id,
  name: 'Groceries',
  allocation_type: 'budget',
  target_amount: 8000,
  current_amount: 0,
  period_frequency: 'monthly',
  period_start: '2031-03-01T00:00:00',
  period_end: '2031-04-01T00:00:00',
  currency: 'PHP',
  is_active: true,
  created_at: '2026-01-01T00:00:00',
  configuration: { category_ids: [groceries.id] },
}

// A budget card names the last day of its period, one before the stored (exclusive) end.
const BUDGET_START_CHIP = 'Starts Mar 1, 2031'
const BUDGET_END_CHIP = 'Ends Mar 31, 2031'
const GOAL_TARGET_TEXT = 'Target 9/15/2031'

const page_ = <T>(items: T[]): PaginatedResponse<T> => ({ items, total: items.length, has_more: false })

/**
 * Opens the Allocations page signed in. The allocation list answers with `lists` in order (the first load, then
 * the refresh after a save); the last list repeats.
 */
async function openAllocations(page: Page, tab: 'Savings' | 'Budgets', lists: StoredAllocation[][]): Promise<ApiMock> {
  await mockApi(page, [], {
    allow: [
      ...landingStubs().filter((r) => r.path !== '/allocations/'),
      apiRoute<Category[]>('GET', '/categories/', [groceries]),
      apiRoute<PaginatedResponse<BudgetEntry>>('GET', '/budget-entries/', page_<BudgetEntry>([])),
      apiRoute<{ items: CardCredit[] }>('GET', '/cards/credit', { items: [] }),
      apiRoute<PaginatedResponse<Account>>('GET', '/accounts/', page_([account])),
    ],
  })
  const api = await signedIn(page, user)
  await mockApi(page, [
    sequenceRoute<PaginatedResponse<StoredAllocation>>(
      'GET',
      '/allocations/',
      lists.map((items) => ({ body: page_(items) })),
    ),
  ])
  await page.goto('/allocations')
  await page.getByRole('button', { name: tab, exact: true }).click()
  return api
}

const card = (page: Page, name: string): Locator =>
  page.locator('article[role="button"]').filter({ has: page.getByText(name, { exact: true }) })

// The date chips on a card: "Target <date>" on a savings card, "Ends <date>" on a budget card. The savings
// card also has a "Target" amount label, which has no date after it, so the chip needs text after the word.
const targetChip = (page: Page, name: string): Locator =>
  card(page, name).locator('span').filter({ hasText: /^\s*Target\s+\S/ })
const endChip = (page: Page, name: string): Locator =>
  card(page, name).locator('span').filter({ hasText: /^\s*Ends\s+\S/ })

const editForm = (page: Page): Locator =>
  page.locator('form').filter({ has: page.getByRole('button', { name: 'Update Allocation' }) })

async function openEdit(page: Page, name: string): Promise<Locator> {
  await card(page, name).click()
  await page.getByRole('button', { name: 'Edit allocation' }).click()
  const form = editForm(page)
  await expect(form).toBeVisible()
  return form
}

const field = (form: Locator, key: string): Locator => form.locator(`[data-field="${key}"]`)

/** The PUT bodies sent for one allocation. */
const updates = (api: ApiMock, id: number): Record<string, unknown>[] =>
  api.bodies('PUT', `/allocations/${id}`) as Record<string, unknown>[]

const DATE_KEYS = ['target_date', 'period_start', 'period_end']
const day = (value: unknown): string => String(value).slice(0, 10)

async function save(form: Locator): Promise<void> {
  await form.getByRole('button', { name: 'Update Allocation' }).click()
  await expect(form).toBeHidden()
}

test.describe('allocation dates on edit', () => {
  test('clears an optional date on edit', async ({ page }) => {
    const savedGoal: StoredAllocation = { ...goal, target_date: null }
    const savedBudget: StoredAllocation = { ...budget, period_end: null }
    const api = await openAllocations(page, 'Savings', [[goal, budget], [savedGoal, budget], [savedGoal, savedBudget]])
    await mockApi(page, [
      apiRoute<StoredAllocation>('PUT', `/allocations/${GOAL_ID}`, savedGoal),
      apiRoute<StoredAllocation>('PUT', `/allocations/${BUDGET_ID}`, savedBudget),
    ])
    await expect(card(page, goal.name)).toContainText(GOAL_TARGET_TEXT)
    await expect(targetChip(page, goal.name)).toHaveCount(1)

    // Savings: clear the target date.
    let form = await openEdit(page, goal.name)
    await expect(field(form, 'target_date')).toHaveValue('2031-09-15')
    await field(form, 'target_date').fill('')
    await save(form)
    await expect.poll(() => updates(api, GOAL_ID).length).toBe(1)
    expect(updates(api, GOAL_ID)[0]).toHaveProperty('target_date', null)

    await expect(targetChip(page, goal.name)).toHaveCount(0)
    form = await openEdit(page, goal.name)
    await expect(field(form, 'target_date')).toHaveValue('')
    await shot(page, 'savings-target-cleared')
    await page.getByRole('button', { name: 'Cancel', exact: true }).click()
    await expect(form).toBeHidden()

    // Budget: clear the period end; the start stays.
    await page.getByRole('button', { name: 'Budgets', exact: true }).click()
    await expect(card(page, budget.name)).toContainText(BUDGET_END_CHIP)
    await expect(endChip(page, budget.name)).toHaveCount(1)
    form = await openEdit(page, budget.name)
    await expect(field(form, 'period_end')).toHaveValue('2031-04-01')
    await field(form, 'period_end').fill('')
    await save(form)
    await expect.poll(() => updates(api, BUDGET_ID).length).toBe(1)
    expect(updates(api, BUDGET_ID)[0]).toHaveProperty('period_end', null)

    await expect(endChip(page, budget.name)).toHaveCount(0)
    await expect(card(page, budget.name)).toContainText(BUDGET_START_CHIP)
    form = await openEdit(page, budget.name)
    await expect(field(form, 'period_end')).toHaveValue('')
    await expect(field(form, 'period_start')).toHaveValue('2031-03-01')
    const file = await shot(page, 'budget-end-cleared')
    expect(fs.existsSync(file)).toBe(true)
  })

  test('untouched dates are kept on edit', async ({ page }) => {
    const api = await openAllocations(page, 'Savings', [[goal, budget]])
    await mockApi(page, [
      apiRoute<StoredAllocation>('PUT', `/allocations/${GOAL_ID}`, goal),
      apiRoute<StoredAllocation>('PUT', `/allocations/${BUDGET_ID}`, budget),
    ])

    let form = await openEdit(page, goal.name)
    await field(form, 'name').fill('Trip fund renamed')
    await save(form)

    await page.getByRole('button', { name: 'Budgets', exact: true }).click()
    form = await openEdit(page, budget.name)
    await field(form, 'name').fill('Groceries renamed')
    await save(form)

    await expect.poll(() => updates(api, GOAL_ID).length + updates(api, BUDGET_ID).length).toBe(2)
    const sent = [updates(api, GOAL_ID)[0], updates(api, BUDGET_ID)[0]]
    expect(sent.map((b) => b.name)).toEqual(['Trip fund renamed', 'Groceries renamed'])
    // Every date key a body carries is the stored calendar day, and none is null.
    const stored: Record<number, Record<string, string>> = {
      [GOAL_ID]: { target_date: day(goal.target_date) },
      [BUDGET_ID]: { period_start: day(budget.period_start), period_end: day(budget.period_end) },
    }
    for (const [id, body] of [[GOAL_ID, sent[0]], [BUDGET_ID, sent[1]]] as const) {
      for (const key of DATE_KEYS.filter((k) => k in body)) {
        expect(body[key], `${key} sent for allocation ${id}`).not.toBeNull()
        expect(day(body[key])).toMatch(/^\d{4}-\d{2}-\d{2}$/)
        expect(day(body[key]), `${key} sent for allocation ${id}`).toBe(stored[id][key])
      }
    }
    const file = await shot(page, 'renamed')
    expect(fs.existsSync(file)).toBe(true)
  })

  test('a refused clear shows an inline error', async ({ page }) => {
    const api = await openAllocations(page, 'Budgets', [[goal, budget]])
    await mockApi(page, [apiRoute<StoredAllocation>('PUT', `/allocations/${BUDGET_ID}`, budget)])
    await expect(card(page, budget.name)).toContainText(BUDGET_START_CHIP)

    const form = await openEdit(page, budget.name)
    await field(form, 'period_start').fill('')
    await form.getByRole('button', { name: 'Update Allocation' }).click()

    const error = page.getByTestId('field-error-period_start')
    await expect(error).toBeVisible()
    await expect(error).toHaveText('Provide a start date for this budget period.')
    await expect(form).toBeVisible()
    // The page does not go to the API: no update request, before or after the error settles.
    expect(api.count('PUT', `/allocations/${BUDGET_ID}`)).toBe(0)
    expect(updates(api, BUDGET_ID)).toEqual([])
    const file = await shot(page, 'inline-error')
    expect(fs.existsSync(file)).toBe(true)

    await page.getByRole('button', { name: 'Cancel', exact: true }).click()
    await expect(form).toBeHidden()
    await expect(card(page, budget.name)).toContainText(BUDGET_START_CHIP)
  })

  test('mock helper change is additive', async ({ page }) => {
    const first = { ok: 1 }
    const second = { ok: 2 }
    const api = await mockApi(page, [
      sequenceRoute<{ ok: number }>('GET', '/seq', [{ body: first }, { body: second, status: 201 }]),
      apiRoute<{ ok: boolean }>('POST', '/echo', { ok: true }),
    ])
    await page.goto('/login')
    const out = await page.evaluate(async () => {
      const get = async () => {
        const r = await fetch('/api/v1/seq')
        return { status: r.status, body: (await r.json()) as { ok: number } }
      }
      const a = await get()
      const b = await get()
      const c = await get()
      await fetch('/api/v1/echo', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ n: 1 }) })
      await fetch('/api/v1/echo', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ n: 2 }) })
      return [a, b, c]
    })
    // Each call gets the next reply and the last one repeats; a plain route still answers as before.
    expect(out).toEqual([
      { status: 200, body: first },
      { status: 201, body: second },
      { status: 201, body: second },
    ])
    expect(api.bodies('POST', '/echo')).toEqual([{ n: 1 }, { n: 2 }])
    expect(api.bodies('GET', '/seq')).toEqual([])
    expect(api.count('GET', '/seq')).toBe(3)
    const file = await shot(page, 'helper')
    expect(fs.existsSync(file)).toBe(true)
  })
})
