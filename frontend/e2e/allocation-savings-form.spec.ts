import { expect, test } from '@playwright/test'
import type { Locator, Page } from '@playwright/test'
import type { Account, Allocation, BudgetEntry, CardCredit, Category, PaginatedResponse, User } from '@tally-trace/shared'
import { landingStubs } from './support/landing'
import { apiRoute, mockApi } from './support/mockApi'
import type { ApiMock } from './support/mockApi'
import { shot } from './support/shot'
import { signedIn } from './support/signedIn'

// STU-778 in the browser: the savings form leads with its tracking mode, shows only the account field that mode
// needs, has no "Current amount" input, and says what a savings figure leaves out. The API is faked, so no stack is
// needed.

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
const dollar: Account = { ...account(3, 'Dollar savings'), currency: 'USD' }

const category = (id: number, name: string): Category => ({
  id,
  name,
  is_expense: true,
  kind: 'expense',
  is_active: true,
  created_at: '2026-01-01T00:00:00',
})
const groceries = category(5, 'Groceries')
const savingsCategory = category(6, 'Savings')

const baseSavings: Allocation = {
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
const usdSavings: Allocation = {
  ...baseSavings,
  id: 24,
  account_id: dollar.id,
  name: 'Dollar fund',
  target_amount: 3000,
  current_amount: 1200,
  monthly_target: 100,
  current_amount_source: 'Balance of Dollar savings',
  currency: 'USD',
  configuration: { goal_mode: 'target_balance' },
}
const incomplete: Allocation = {
  ...baseSavings,
  id: 22,
  account_id: null,
  name: 'Rainy day',
  current_amount: 700,
  current_amount_complete: false,
  current_amount_missing: ['USD'],
  current_amount_source: 'Savings transactions',
  configuration: { goal_mode: 'transaction_total', savings_category_id: savingsCategory.id },
}

const budget: Allocation = {
  id: 23,
  account_id: everyday.id,
  name: 'Groceries',
  allocation_type: 'budget',
  target_amount: 8000,
  current_amount: 0,
  current_amount_complete: true,
  current_amount_missing: [],
  current_amount_source: null,
  period_frequency: 'monthly',
  period_start: '2031-03-01T00:00:00',
  period_end: '2031-04-01T00:00:00',
  currency: 'PHP',
  is_active: true,
  created_at: '2026-01-01T00:00:00',
  configuration: { category_ids: [groceries.id] },
}

const page_ = <T>(items: T[]): PaginatedResponse<T> => ({ items, total: items.length, has_more: false })

async function openAllocations(page: Page, tab: 'Savings' | 'Budgets', categories: Category[] = [groceries, savingsCategory]): Promise<ApiMock> {
  await mockApi(page, [], {
    allow: [
      ...landingStubs().filter((r) => r.path !== '/allocations/'),
      apiRoute<Category[]>('GET', '/categories/', categories),
      apiRoute<PaginatedResponse<BudgetEntry>>('GET', '/budget-entries/', page_<BudgetEntry>([])),
      apiRoute<{ items: CardCredit[] }>('GET', '/cards/credit', { items: [] }),
      apiRoute<PaginatedResponse<Account>>('GET', '/accounts/', page_([everyday, joint, dollar])),
    ],
  })
  const api = await signedIn(page, user)
  await mockApi(page, [
    apiRoute<PaginatedResponse<Allocation>>('GET', '/allocations/', page_([baseSavings, incomplete, budget, usdSavings])),
    apiRoute<Allocation>('POST', '/allocations/', baseSavings),
    apiRoute<Allocation>('PUT', `/allocations/${incomplete.id}`, incomplete),
    apiRoute<Allocation>('PUT', `/allocations/${usdSavings.id}`, usdSavings),
  ])
  await page.goto('/allocations')
  await page.getByRole('button', { name: tab, exact: true }).click()
  return api
}

const addForm = async (page: Page, title: RegExp): Promise<Locator> => {
  await page.getByRole('button', { name: 'Add allocation' }).click()
  await expect(page.getByRole('heading', { name: title })).toBeVisible()
  return page.locator('form').filter({ has: page.getByRole('button', { name: /^Create / }) })
}

const labelsOf = (form: Locator): Promise<string[]> =>
  form.locator('label').evaluateAll((els) => els.filter((e) => e.getBoundingClientRect().width > 0).map((e) => (e as HTMLElement).innerText.trim()))

const field = (form: Locator, key: string): Locator => form.locator(`[data-field="${key}"]`)
const card = (page: Page, name: string): Locator =>
  page.locator('article[role="button"]').filter({ has: page.getByText(name, { exact: true }) })

const SAVINGS_TAIL = ['Name', 'Description', 'Currency', 'Target amount (optional)', 'Monthly target (optional)', 'Target date']

const createBody = (api: ApiMock): Record<string, unknown> => {
  const bodies = api.bodies('POST', '/allocations/') as Record<string, unknown>[]
  expect(bodies).toHaveLength(1)
  return bodies[0] as Record<string, unknown>
}

test.describe('savings form tracking mode (STU-778)', () => {
  test('tracking mode is the first savings field, above the account field', async ({ page }) => {
    await openAllocations(page, 'Savings')
    const form = await addForm(page, /^Create savings tracker/)
    const labels = await labelsOf(form)
    expect(labels[0]).toBe('Tracking mode')
    expect(labels).toEqual(['Tracking mode', 'Account', ...SAVINGS_TAIL])
    const modeBox = await form.getByRole('button', { name: 'Target account balance' }).boundingBox()
    const accountBox = await field(form, 'account_id').boundingBox()
    expect(modeBox && accountBox && modeBox.y < accountBox.y, 'Tracking mode sits above the Account select').toBe(true)
    const group = form.getByRole('group', { name: 'Tracking mode', exact: true })
    await expect(group).toBeVisible()
    await expect(group.getByRole('button', { name: /^Target account balance/ })).toHaveAttribute('aria-pressed', 'true')
    await expect(group.getByRole('button', { name: /^Combined account total/ })).toHaveAttribute('aria-pressed', 'false')
    await group.getByRole('button', { name: /^Savings transactions total/ }).click()
    await expect(group.getByRole('button', { name: /^Savings transactions total/ })).toHaveAttribute('aria-pressed', 'true')
    await expect(group.getByRole('button', { name: /^Target account balance/ })).toHaveAttribute('aria-pressed', 'false')
    await shot(page, 'savings-form-target-balance')
  })

  test('target account balance shows a single Account select', async ({ page }) => {
    const api = await openAllocations(page, 'Savings')
    const form = await addForm(page, /^Create savings tracker/)
    await expect(field(form, 'account_id')).toHaveCount(1)
    await expect(field(form, 'savings_account_ids')).toHaveCount(0)
    // Required: no account blocks the save with the form's own inline error.
    await field(form, 'name').fill('Trip fund')
    await form.getByRole('button', { name: 'Create savings tracker' }).click()
    await expect(page.getByTestId('field-error-account_id')).toBeVisible()
    expect(api.bodies('POST', '/allocations/')).toHaveLength(0)
    await field(form, 'account_id').selectOption(String(everyday.id))
    await form.getByRole('button', { name: 'Create savings tracker' }).click()
    await expect.poll(() => api.bodies('POST', '/allocations/').length).toBe(1)
    const body = createBody(api)
    expect(body).toHaveProperty('account_id', everyday.id)
    expect(body).not.toHaveProperty('current_amount')
  })

  test('combined account total shows only the Accounts to aggregate picker', async ({ page }) => {
    const api = await openAllocations(page, 'Savings')
    const form = await addForm(page, /^Create savings tracker/)
    await form.getByRole('button', { name: 'Combined account total' }).click()
    expect(await labelsOf(form)).toEqual(['Tracking mode', 'Accounts to aggregate', ...SAVINGS_TAIL])
    await expect(field(form, 'account_id')).toHaveCount(0)
    await expect(field(form, 'savings_account_ids')).toHaveCount(1)
    await field(form, 'name').fill('House fund')
    await field(form, 'savings_account_ids').getByRole('button', { name: /^Joint savings/ }).click()
    await field(form, 'savings_account_ids').getByRole('button', { name: /^Everyday/ }).click()
    await form.getByRole('button', { name: 'Create savings tracker' }).click()
    await expect.poll(() => api.bodies('POST', '/allocations/').length).toBe(1)
    const body = createBody(api)
    expect(body).toHaveProperty('configuration.account_ids', [joint.id, everyday.id])
    expect(body).toHaveProperty('account_id', joint.id)
    expect(body).not.toHaveProperty('current_amount')
    await shot(page, 'savings-form-combined')
  })

  test('savings transactions total shows no account field and keeps the Savings category hint', async ({ page }) => {
    const api = await openAllocations(page, 'Savings')
    const form = await addForm(page, /^Create savings tracker/)
    await form.getByRole('button', { name: 'Savings transactions total' }).click()
    expect(await labelsOf(form)).toEqual(['Tracking mode', ...SAVINGS_TAIL])
    await expect(field(form, 'account_id')).toHaveCount(0)
    await expect(field(form, 'savings_account_ids')).toHaveCount(0)
    await expect(form.getByText('We\'ll total any transactions categorized as "Savings".')).toBeVisible()
    await field(form, 'name').fill('Rainy day')
    await form.getByRole('button', { name: 'Create savings tracker' }).click()
    await expect.poll(() => api.bodies('POST', '/allocations/').length).toBe(1)
    const body = createBody(api)
    expect(body).toHaveProperty('account_id', null)
    expect(body).not.toHaveProperty('current_amount')
    await shot(page, 'savings-form-transactions')
  })

  test('the Savings category hint reads as a tip when there is no Savings category', async ({ page }) => {
    await openAllocations(page, 'Savings', [groceries])
    const form = await addForm(page, /^Create savings tracker/)
    await form.getByRole('button', { name: 'Savings transactions total' }).click()
    await expect(form.getByText('Tip: add a "Savings" category so we know which transactions to roll up.')).toBeVisible()
  })

  test('the savings form has no Current amount input; Monthly target is optional with helper text', async ({ page }) => {
    await openAllocations(page, 'Savings')
    const form = await addForm(page, /^Create savings tracker/)
    await expect(form.getByText('Current amount')).toHaveCount(0)
    await expect(field(form, 'current_amount')).toHaveCount(0)
    await expect(form.getByText('Monthly target (optional)', { exact: true })).toBeVisible()
    await expect(form.getByText('Optional amount you\'d like to set aside each month.')).toBeVisible()
    await expect(form.getByText('Target amount (optional)', { exact: true })).toBeVisible()
    await expect(form.getByText('Optional goal amount you\'d like to reach.')).toBeVisible()
  })

  test('the edit dialog shows a read-only Current progress with its source, and no Current amount input', async ({ page }) => {
    await openAllocations(page, 'Savings')
    await card(page, baseSavings.name).click()
    await page.getByRole('button', { name: 'Edit allocation' }).click()
    const form = page.locator('form').filter({ has: page.getByRole('button', { name: 'Update allocation' }) })
    await expect(form).toBeVisible()
    const progress = form.getByTestId('savings-current-progress')
    await expect(progress).toContainText('Current progress')
    await expect(progress).toContainText('1,000')
    await expect(progress).toContainText('Balance of Everyday')
    await expect(progress.locator('input')).toHaveCount(0)
    await expect(field(form, 'current_amount')).toHaveCount(0)
    await expect(form.getByTestId('savings-excluded-note')).toHaveCount(0)
    await shot(page, 'savings-edit-progress')
  })

  test('an incomplete figure names the excluded currencies in the form and on the card', async ({ page }) => {
    const api = await openAllocations(page, 'Savings')
    const note = 'Excludes USD: no exchange rate yet'
    await expect(card(page, incomplete.name).getByTestId('allocation-card-excluded-note')).toHaveText(note)
    await expect(card(page, baseSavings.name).getByTestId('allocation-card-excluded-note')).toHaveCount(0)
    await card(page, incomplete.name).click()
    await page.getByRole('button', { name: 'Edit allocation' }).click()
    const form = page.locator('form').filter({ has: page.getByRole('button', { name: 'Update allocation' }) })
    await expect(form.getByTestId('savings-excluded-note')).toHaveText(note)
    await expect(form.getByTestId('savings-current-progress')).toContainText('Savings transactions')
    // A savings save never sends the calculated figure.
    await form.getByRole('button', { name: 'Update allocation' }).click()
    await expect(form).toBeHidden()
    const puts = api.bodies('PUT', `/allocations/${incomplete.id}`) as Record<string, unknown>[]
    expect(puts).toHaveLength(1)
    expect(puts[0]).not.toHaveProperty('current_amount')
    expect(puts[0]).toHaveProperty('account_id', null)
  })

  test('currency defaults from the chosen account in target account balance mode', async ({ page }) => {
    const api = await openAllocations(page, 'Savings')
    const form = await addForm(page, /^Create savings tracker/)
    const currency = form.getByLabel('Currency', { exact: true })
    await expect(currency).toHaveValue('PHP')
    await field(form, 'account_id').selectOption(String(dollar.id))
    await expect(currency).toHaveValue('USD')
    await expect(form.getByTestId('target-amount-symbol')).toHaveText('$')
    await field(form, 'account_id').selectOption(String(everyday.id))
    await expect(currency).toHaveValue('PHP')
    await field(form, 'account_id').selectOption(String(dollar.id))
    await field(form, 'name').fill('Dollar trip')
    await form.getByRole('button', { name: 'Create savings tracker' }).click()
    await expect.poll(() => api.bodies('POST', '/allocations/').length).toBe(1)
    expect(createBody(api)).toHaveProperty('currency', 'USD')
  })

  test('currency defaults from the first aggregated account in combined total mode', async ({ page }) => {
    const api = await openAllocations(page, 'Savings')
    const form = await addForm(page, /^Create savings tracker/)
    await form.getByRole('button', { name: 'Combined account total' }).click()
    const currency = form.getByLabel('Currency', { exact: true })
    await expect(currency).toHaveValue('PHP')
    await field(form, 'savings_account_ids').getByRole('button', { name: /^Dollar savings/ }).click()
    await field(form, 'savings_account_ids').getByRole('button', { name: /^Everyday/ }).click()
    await expect(currency).toHaveValue('USD')
    await field(form, 'name').fill('Mixed fund')
    await form.getByRole('button', { name: 'Create savings tracker' }).click()
    await expect.poll(() => api.bodies('POST', '/allocations/').length).toBe(1)
    expect(createBody(api)).toHaveProperty('currency', 'USD')
  })

  test('currency is PHP in savings transactions total mode', async ({ page }) => {
    const api = await openAllocations(page, 'Savings')
    const form = await addForm(page, /^Create savings tracker/)
    await field(form, 'account_id').selectOption(String(dollar.id))
    await form.getByRole('button', { name: 'Savings transactions total' }).click()
    const currency = form.getByLabel('Currency', { exact: true })
    await expect(currency).toHaveValue('PHP')
    await field(form, 'name').fill('Rainy day')
    await form.getByRole('button', { name: 'Create savings tracker' }).click()
    await expect.poll(() => api.bodies('POST', '/allocations/').length).toBe(1)
    expect(createBody(api)).toHaveProperty('currency', 'PHP')
  })

  test('a currency the user picked survives an account change', async ({ page }) => {
    const api = await openAllocations(page, 'Savings')
    const form = await addForm(page, /^Create savings tracker/)
    const currency = form.getByLabel('Currency', { exact: true })
    await field(form, 'account_id').selectOption(String(dollar.id))
    await expect(currency).toHaveValue('USD')
    await currency.selectOption('EUR')
    await field(form, 'account_id').selectOption(String(everyday.id))
    await expect(currency).toHaveValue('EUR')
    await field(form, 'name').fill('Euro trip')
    await form.getByRole('button', { name: 'Create savings tracker' }).click()
    await expect.poll(() => api.bodies('POST', '/allocations/').length).toBe(1)
    expect(createBody(api)).toHaveProperty('currency', 'EUR')
  })

  test('the card, action modal and edit form show a USD allocation in USD', async ({ page }) => {
    const api = await openAllocations(page, 'Savings')
    const usdCard = card(page, usdSavings.name)
    await expect(usdCard).toContainText('$1,200.00')
    await expect(usdCard).toContainText('$3,000.00')
    await expect(usdCard).toContainText('Monthly $100.00')
    await expect(card(page, baseSavings.name)).toContainText('₱1,000.00')
    await usdCard.click()
    // Only the action modal writes the target as one run of text ("Target $3,000.00").
    await expect(page.getByText('Target $3,000.00', { exact: true })).toBeVisible()
    await expect(page.getByText('Monthly target $100.00', { exact: true })).toBeVisible()
    await expect(page.getByText('$1,200.00', { exact: true })).toHaveCount(2)
    await page.getByRole('button', { name: 'Edit allocation' }).click()
    const form = page.locator('form').filter({ has: page.getByRole('button', { name: 'Update allocation' }) })
    await expect(form.getByLabel('Currency', { exact: true })).toHaveValue('USD')
    await expect(form.getByTestId('savings-current-progress')).toContainText('$1,200.00')
    await expect(form.getByTestId('target-amount-symbol')).toHaveText('$')
    await expect(form.getByTestId('monthly-target-symbol')).toHaveText('$')
    await form.getByRole('button', { name: 'Update allocation' }).click()
    await expect(form).toBeHidden()
    const puts = api.bodies('PUT', `/allocations/${usdSavings.id}`) as Record<string, unknown>[]
    expect(puts).toHaveLength(1)
    expect(puts[0]).toHaveProperty('currency', 'USD')
  })

  test('the budget form is unchanged', async ({ page }) => {
    const api = await openAllocations(page, 'Budgets')
    const form = await addForm(page, /^Create budget envelope/)
    expect(await labelsOf(form)).toEqual(['Account', 'Name', 'Description', 'Tracked categories', 'Budget cadence', 'Period start', 'Period end (optional)', 'Amount already spent', 'Spending limit'])
    await expect(field(form, 'account_id')).toHaveCount(1)
    await expect(field(form, 'current_amount')).toHaveCount(1)
    await expect(form.getByText('Tracking mode')).toHaveCount(0)
    await expect(form.getByLabel('Currency', { exact: true })).toHaveCount(0)
    await field(form, 'account_id').selectOption(String(everyday.id))
    await field(form, 'name').fill('Dining')
    await field(form, 'target_amount').fill('3000')
    await field(form, 'current_amount').fill('250')
    await form.getByRole('button', { name: /Groceries/ }).first().click()
    await form.getByRole('button', { name: 'Create budget envelope' }).click()
    await expect.poll(() => api.bodies('POST', '/allocations/').length).toBe(1)
    const body = createBody(api)
    expect(body).toHaveProperty('account_id', everyday.id)
    expect(body).toHaveProperty('current_amount', 250)
    expect(body).not.toHaveProperty('currency')
  })
})
