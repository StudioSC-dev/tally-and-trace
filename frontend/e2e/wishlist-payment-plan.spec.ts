// STU-780: the wishlist plans a purchase by account and payment plan. The form has "Pay from", "Payment" (Full or
// Installments) and, for Installments only, "Months" (2 to 60), and Installments limits "Pay from" to credit cards.
// An installment item reads "₱X/mo × N months"; every item shows a budget badge and an item paid by card a card badge;
// the detail shows the "Installment outlook"; the Purchase plan lists installments apart from the save-up queue.
// Marking an installment item purchased shows the card installment was created, and a refusal (409, no exchange rate)
// shows the API's message and leaves the item unpurchased; un-marking asks first and links to Recurring. The API is
// faked in the browser with the shared household fixture; there is no backend.
import { expect, test } from '@playwright/test'
import type { Locator, Page } from '@playwright/test'
import type { Account, WishlistCheckStatus, WishlistItem, WishlistOutlook, WishlistPlan } from '@tally-trace/shared'
import { household, householdViewRoutes, mockHousehold } from './support/fixtures/household'
import { addRoutes, apiRoute, errorRoute, queryRoute } from './support/mockApi'
import type { ApiMock, ApiRoute } from './support/mockApi'

const accountNamed = (name: string): Account => {
  const account = household.accounts.find((a) => a.name === name)
  if (!account) throw new Error(`the fixture has no ${name}`)
  return account
}
const PAYROLL = accountNamed('BPI Payroll')
const CARD = accountNamed('HSBC Red Mastercard')
const CARDS = household.accounts.filter((a) => a.account_type === 'credit' && a.my_role === 'owner')

const base = {
  user_id: household.user.id,
  currency: 'PHP' as const,
  created_at: '2026-02-01T09:00:00Z',
}
const DESK: WishlistItem = { ...base, id: 901, name: 'Standing desk', estimated_cost: 12000, priority: 'medium', is_purchased: false, payment_plan: 'full', account_id: PAYROLL.id }
const LAPTOP: WishlistItem = { ...base, id: 902, name: 'Work laptop', estimated_cost: 65000, priority: 'high', is_purchased: false, payment_plan: 'installment', installment_months: 12, account_id: CARD.id }
const CAMERA: WishlistItem = { ...base, id: 903, name: 'Mirrorless camera', estimated_cost: 24000, priority: 'low', is_purchased: false, payment_plan: 'installment', installment_months: 6, account_id: CARD.id }
const PHONE: WishlistItem = {
  ...base,
  id: 904,
  name: 'Phone',
  estimated_cost: 30000,
  priority: 'medium',
  is_purchased: true,
  purchased_at: '2026-03-01T09:00:00Z',
  payment_plan: 'installment',
  installment_months: 10,
  account_id: CARD.id,
  installment_entry_id: 77,
}
// Bought in full, with no card installment: switching it to Installments creates one.
const BOOK: WishlistItem = { ...base, id: 906, name: 'Reading chair', estimated_cost: 18000, priority: 'low', is_purchased: true, purchased_at: '2026-03-02T09:00:00Z', payment_plan: 'full', account_id: PAYROLL.id }
const ALL = [DESK, LAPTOP, CAMERA, PHONE, BOOK]

const KEPT_NOTICE = 'The card installment keeps running in Recurring and the forecast; delete it there if this purchase did not happen'
const CREATED_NOTICE = 'Created a card installment of 12 monthly payments in PHP; it is in Recurring and the forecast'
const NO_RATE = 'No exchange rate from USD to PHP is stored yet, so the installment can\'t be created; try again later'

const MONTHS = ['2026-04', '2026-05', '2026-06', '2026-07', '2026-08', '2026-09', '2026-10', '2026-11', '2026-12', '2027-01', '2027-02', '2027-03']
const DISPOSABLE = 5000

interface Checks {
  disposable: WishlistCheckStatus
  credit?: WishlistCheckStatus
}

/** An installment's outlook: 12 months, the card's existing installments in the first six, the last payment a little lower. */
function outlookOf(item: WishlistItem, checks: Checks, monthly?: number, final?: number): WishlistOutlook {
  const installment = item.payment_plan === 'installment'
  const count = item.installment_months ?? 1
  return {
    item_id: item.id,
    currency: item.currency,
    payment_plan: item.payment_plan,
    estimated_cost: item.estimated_cost,
    installment_months: item.installment_months ?? null,
    monthly_amount: installment ? (monthly ?? null) : null,
    final_amount: installment ? (final ?? null) : null,
    months: MONTHS.map((month, i) => {
      const existing = i < 6 ? 1500 : 0
      const mine = !installment ? (i === 0 ? item.estimated_cost : 0) : i < count - 1 ? (monthly ?? 0) : i === count - 1 ? (final ?? 0) : 0
      return { month, existing_installments: existing, this_item: mine, total: existing + mine }
    }),
    disposable_check: { status: checks.disposable, currency: item.currency, amount: monthly ?? item.estimated_cost, monthly_disposable: checks.disposable === 'unknown' ? null : DISPOSABLE, available: checks.disposable === 'unknown' ? null : DISPOSABLE },
    credit_check: checks.credit ? { status: checks.credit, currency: 'PHP', amount: item.estimated_cost, available: 80000, limit: 120000 } : null,
  }
}

const OUTLOOKS: WishlistOutlook[] = [
  outlookOf(DESK, { disposable: 'fits' }),
  outlookOf(LAPTOP, { disposable: 'over', credit: 'fits' }, 5416.67, 5416.63),
  outlookOf(CAMERA, { disposable: 'unknown', credit: 'unknown' }, 4000, 4000),
  outlookOf(PHONE, { disposable: 'fits', credit: 'fits' }, 3000, 3000),
]

const PLAN: WishlistPlan = {
  monthly_disposable: DISPOSABLE,
  savings_rate: 2500,
  items: [{ item_id: DESK.id, name: DESK.name, estimated_cost: DESK.estimated_cost, estimated_purchase_date: '2026-09-01', cumulative_months: 5 }],
  installments: [
    { item_id: LAPTOP.id, name: LAPTOP.name, estimated_cost: LAPTOP.estimated_cost, currency: 'PHP', account_id: CARD.id, installment_months: 12, monthly_amount: 5416.67, final_amount: 5416.63 },
    { item_id: CAMERA.id, name: CAMERA.name, estimated_cost: CAMERA.estimated_cost, currency: 'PHP', account_id: CARD.id, installment_months: 6, monthly_amount: 4000, final_amount: 4000 },
  ],
}

/** The wishlist's reads, and a reply for each item's update (`puts`, by item id; the default echoes the item flipped). */
function wishlistRoutes(puts: Record<number, ApiRoute> = {}): ApiRoute[] {
  return [
    queryRoute<WishlistItem[]>('GET', '/wishlist/', (q) => (q.get('is_purchased') === 'false' ? ALL.filter((i) => !i.is_purchased) : ALL)),
    apiRoute<WishlistPlan>('GET', '/wishlist/plan', PLAN),
    apiRoute<WishlistItem>('POST', '/wishlist/', { ...DESK, id: 905, name: 'Camera lens' }, 201),
    ...OUTLOOKS.map((o) => apiRoute<WishlistOutlook>('GET', `/wishlist/${o.item_id}/outlook`, o)),
    ...ALL.map((i) => puts[i.id] ?? apiRoute<WishlistItem>('PUT', `/wishlist/${i.id}`, { ...i, is_purchased: !i.is_purchased })),
  ]
}

async function open(page: Page, puts: Record<number, ApiRoute> = {}): Promise<ApiMock> {
  await mockHousehold(page, household)
  const mock = await addRoutes(page, [...householdViewRoutes(household), ...wishlistRoutes(puts)])
  await page.goto('/allocations?tab=wishlist')
  await expect(page.getByTestId('wishlist-item-902')).toBeVisible({ timeout: 15_000 })
  return mock
}

const cardOf = (page: Page, item: WishlistItem): Locator => page.getByTestId(`wishlist-item-${item.id}`)
const formOf = (page: Page): Locator => page.locator('form').filter({ has: page.getByPlaceholder('What are you saving for?') })
const toastText = (page: Page): Locator => page.getByTestId('toast-message')

async function openForm(page: Page): Promise<Locator> {
  await page.getByRole('button', { name: 'Add wishlist item', exact: true }).click()
  const form = formOf(page)
  await expect(form).toBeVisible()
  return form
}

test.describe('wishlist payment plan', () => {
  test('the form asks Pay from, Payment and, for Installments only, Months (2 to 60)', async ({ page }) => {
    const mock = await open(page)
    const form = await openForm(page)
    const payment = form.getByRole('group', { name: 'Payment' })
    await expect(form.getByLabel('Pay from')).toBeVisible()
    await expect(payment.getByRole('button', { name: 'Full', exact: true })).toHaveAttribute('aria-pressed', 'true')
    await expect(payment.getByRole('button', { name: 'Installments', exact: true })).toHaveAttribute('aria-pressed', 'false')
    await expect(form.getByLabel('Months')).toHaveCount(0)

    await payment.getByRole('button', { name: 'Installments', exact: true }).click()
    await expect(payment.getByRole('button', { name: 'Installments', exact: true })).toHaveAttribute('aria-pressed', 'true')
    const months = form.getByLabel('Months')
    await expect(months).toBeVisible()
    await expect(months).toHaveAttribute('min', '2')
    await expect(months).toHaveAttribute('max', '60')

    await payment.getByRole('button', { name: 'Full', exact: true }).click()
    await expect(form.getByLabel('Months')).toHaveCount(0)

    // Saving sends the plan.
    await form.getByPlaceholder('What are you saving for?').fill('Camera lens')
    await form.locator('input[type="number"]').first().fill('18000')
    await payment.getByRole('button', { name: 'Installments', exact: true }).click()
    await form.getByLabel('Pay from').selectOption(String(CARD.id))
    await form.getByLabel('Months').fill('9')
    await form.getByRole('button', { name: 'Add', exact: true }).click()
    await expect(form).toHaveCount(0)
    expect(mock.bodies('POST', '/wishlist/')).toEqual([
      expect.objectContaining({ name: 'Camera lens', estimated_cost: 18000, payment_plan: 'installment', installment_months: 9, account_id: CARD.id }),
    ])
  })

  test('Installments limits Pay from to credit cards', async ({ page }) => {
    await open(page)
    const form = await openForm(page)
    const options = form.getByLabel('Pay from').locator('option')
    // Full: any of the caller's own accounts that is not a loan.
    await expect(options.filter({ hasText: PAYROLL.name })).toHaveCount(1)
    await expect(options.filter({ hasText: CARD.name })).toHaveCount(1)
    await form.getByLabel('Pay from').selectOption(String(PAYROLL.id))

    await form.getByRole('group', { name: 'Payment' }).getByRole('button', { name: 'Installments', exact: true }).click()
    // A non-card account cannot stay chosen for an installment, and only cards are offered.
    await expect(form.getByLabel('Pay from')).toHaveValue('0')
    const names = await options.allTextContents()
    expect(names.filter((n) => n.trim() !== 'Select a credit card')).toEqual(CARDS.map((c) => `${c.name} (${c.currency})`).sort())
    await expect(options.filter({ hasText: PAYROLL.name })).toHaveCount(0)
  })

  test('Pay from lists a card shared with the caller as editor, and not one shared as viewer', async ({ page }) => {
    const permissions = { can_edit_settings: false, can_manage_shares: false, can_add_transactions: true, can_delete: false, can_view_details: true }
    const editorCard: Account = { ...CARD, id: 71, name: 'Shared Visa', my_role: 'editor', is_shared: true, permissions }
    const viewerCard: Account = { ...CARD, id: 72, name: 'Viewer Visa', my_role: 'viewer', is_shared: true, permissions: { ...permissions, can_add_transactions: false } }
    const data = { ...household, accounts: [...household.accounts, editorCard, viewerCard] }
    await mockHousehold(page, data)
    const mock = await addRoutes(page, [...householdViewRoutes(data), ...wishlistRoutes()])
    await page.goto('/allocations?tab=wishlist')
    await expect(cardOf(page, LAPTOP)).toBeVisible({ timeout: 15_000 })
    const form = await openForm(page)
    const options = form.getByLabel('Pay from').locator('option')
    await expect(options.filter({ hasText: 'Shared Visa' })).toHaveCount(1)
    await expect(options.filter({ hasText: 'Viewer Visa' })).toHaveCount(0)
    // It is offered for an installment too, and saves as the account.
    await form.getByRole('group', { name: 'Payment' }).getByRole('button', { name: 'Installments', exact: true }).click()
    await expect(options.filter({ hasText: 'Shared Visa' })).toHaveCount(1)
    await expect(options.filter({ hasText: 'Viewer Visa' })).toHaveCount(0)
    await form.getByPlaceholder('What are you saving for?').fill('Camera lens')
    await form.locator('input[type="number"]').first().fill('18000')
    await form.getByLabel('Pay from').selectOption(String(editorCard.id))
    await form.getByLabel('Months').fill('9')
    await form.getByRole('button', { name: 'Add', exact: true }).click()
    await expect(form).toHaveCount(0)
    expect(mock.bodies('POST', '/wishlist/')).toEqual([expect.objectContaining({ account_id: editorCard.id, payment_plan: 'installment' })])
  })

  test('the outlook is requested only where it is shown: unpurchased items, and a purchased one only once its detail opens', async ({ page }) => {
    const mock = await open(page)
    const unpurchased = ALL.filter((i) => !i.is_purchased)
    // Every unpurchased item's badges are drawn, so each asks once; the purchased phone asks for nothing.
    await expect(cardOf(page, DESK).getByTestId('budget-badge')).toBeVisible()
    await expect(cardOf(page, LAPTOP).getByTestId('budget-badge')).toBeVisible()
    await expect(cardOf(page, CAMERA).getByTestId('budget-badge')).toBeVisible()
    const outlookGets = (): string[] => mock.requests().filter((r) => /^GET \/wishlist\/\d+\/outlook$/.test(r))
    expect(outlookGets().length, 'at most one outlook GET per unpurchased item').toBeLessThanOrEqual(unpurchased.length)
    for (const i of unpurchased) expect(mock.count('GET', `/wishlist/${i.id}/outlook`), `outlook GETs for ${i.name}`).toBe(1)
    expect(mock.count('GET', `/wishlist/${PHONE.id}/outlook`)).toBe(0)

    // Listing purchased items too does not ask for theirs.
    await page.getByLabel('Show purchased').check()
    const phone = cardOf(page, PHONE)
    await expect(phone).toBeVisible()
    await expect(phone.getByTestId('installment-line')).toBeVisible()
    // It still reads its monthly amount, worked out from the price and months, with no request.
    await expect(phone.getByTestId('installment-line')).toContainText('₱3,000.00/mo × 10 months')
    expect(mock.count('GET', `/wishlist/${PHONE.id}/outlook`)).toBe(0)
    expect(outlookGets().length).toBeLessThanOrEqual(unpurchased.length)

    // Opening its detail asks once.
    await phone.getByRole('button', { name: 'Show outlook' }).click()
    await expect(phone.getByTestId('installment-outlook')).toBeVisible()
    expect(mock.count('GET', `/wishlist/${PHONE.id}/outlook`)).toBe(1)
  })

  test('an installment item reads the monthly amount and months in the item currency', async ({ page }) => {
    await open(page)
    await expect(cardOf(page, LAPTOP).getByTestId('installment-line')).toContainText('₱5,416.67/mo × 12 months')
    await expect(cardOf(page, CAMERA).getByTestId('installment-line')).toContainText('₱4,000.00/mo × 6 months')
    await expect(cardOf(page, DESK).getByTestId('installment-line')).toHaveCount(0)
  })

  test('each item shows a budget badge, and an item paid by card a card badge', async ({ page }) => {
    await open(page)
    const desk = cardOf(page, DESK)
    await expect(desk.getByTestId('budget-badge')).toHaveText('Fits your monthly budget')
    await expect(desk.getByTestId('card-badge')).toHaveCount(0)

    const laptop = cardOf(page, LAPTOP)
    await expect(laptop.getByTestId('budget-badge')).toHaveText('Over your monthly budget')
    await expect(laptop.getByTestId('card-badge')).toHaveText('Fits card limit')

    const camera = cardOf(page, CAMERA)
    await expect(camera.getByTestId('budget-badge')).toHaveText('Not enough data')
    await expect(camera.getByTestId('card-badge')).toHaveText('Card limit unknown')
  })

  test('the over-limit card badge', async ({ page }) => {
    const over = { ...OUTLOOKS[1], credit_check: { status: 'over' as const, currency: 'PHP', amount: 65000, available: 20000, limit: 120000 } }
    await mockHousehold(page, household)
    await addRoutes(page, [...householdViewRoutes(household), ...wishlistRoutes(), apiRoute<WishlistOutlook>('GET', '/wishlist/902/outlook', over)])
    await page.goto('/allocations?tab=wishlist')
    await expect(cardOf(page, LAPTOP).getByTestId('card-badge')).toHaveText('Over card limit')
  })

  test('the detail shows the Installment outlook month by month', async ({ page }) => {
    await open(page)
    const laptop = cardOf(page, LAPTOP)
    await expect(laptop.getByTestId('installment-outlook')).toHaveCount(0)
    await laptop.getByRole('button', { name: 'Show outlook' }).click()
    const outlook = laptop.getByTestId('installment-outlook')
    await expect(outlook.getByRole('heading', { name: 'Installment outlook' })).toBeVisible()
    const headers = outlook.getByRole('columnheader')
    await expect(headers).toHaveText(['Month', 'Existing installments', 'This item', 'Left each month after this item'])
    await expect(outlook.getByRole('row')).toHaveCount(1 + MONTHS.length)
    // Apr 2026: the card's existing installments, this item, and the disposable income less this item.
    const first = outlook.getByTestId('outlook-month-2026-04')
    await expect(first.getByRole('cell')).toHaveText(['₱1,500.00', '₱5,416.67', '₱-416.67'])
    // The last payment is the final amount; later months carry no payment.
    await expect(outlook.getByTestId('outlook-month-2027-03').getByRole('cell')).toHaveText(['₱0.00', '₱5,416.63', '₱-416.63'])
    await laptop.getByRole('button', { name: 'Hide outlook' }).click()
    await expect(laptop.getByTestId('installment-outlook')).toHaveCount(0)
  })

  test('a month with no stored rate shows a dash for this item and what is left', async ({ page }) => {
    const gap = { ...OUTLOOKS[1], months: OUTLOOKS[1].months.map((m, i) => (i === 0 ? { ...m, this_item: null, total: null } : m)) }
    await mockHousehold(page, household)
    await addRoutes(page, [...householdViewRoutes(household), ...wishlistRoutes(), apiRoute<WishlistOutlook>('GET', '/wishlist/902/outlook', gap)])
    await page.goto('/allocations?tab=wishlist')
    const laptop = cardOf(page, LAPTOP)
    await laptop.getByRole('button', { name: 'Show outlook' }).click()
    await expect(laptop.getByTestId('outlook-month-2026-04').getByRole('cell')).toHaveText(['₱1,500.00', '—', '—'])
    await expect(laptop.getByTestId('outlook-month-2026-05').getByRole('cell')).toHaveText(['₱1,500.00', '₱5,416.67', '₱-416.67'])
  })

  test('the Purchase plan lists installments apart from the save-up queue', async ({ page }) => {
    await open(page)
    const plan = page.getByTestId('purchase-plan')
    const queue = plan.getByTestId('plan-queue')
    await expect(queue.getByRole('listitem')).toHaveCount(1)
    await expect(queue).toContainText(DESK.name)
    await expect(queue).not.toContainText(LAPTOP.name)
    const installments = plan.getByTestId('plan-installments')
    await expect(installments.getByRole('heading', { name: 'Paid by installments' })).toBeVisible()
    await expect(installments.getByRole('listitem')).toHaveCount(2)
    await expect(installments.getByRole('listitem').nth(0)).toContainText(`${LAPTOP.name}`)
    await expect(installments.getByRole('listitem').nth(0)).toContainText('₱5,416.67/mo × 12 months')
    await expect(installments.getByRole('listitem').nth(1)).toContainText('₱4,000.00/mo × 6 months')
    await expect(installments).not.toContainText(DESK.name)
  })

  test('marking an installment item purchased shows that its card installment was created', async ({ page }) => {
    const mock = await open(page, {
      902: apiRoute<WishlistItem>('PUT', '/wishlist/902', { ...LAPTOP, is_purchased: true, purchased_at: '2026-03-12T09:00:00Z', installment_entry_id: 78, notice: CREATED_NOTICE }),
    })
    await cardOf(page, LAPTOP).getByRole('button', { name: 'Mark as purchased' }).click()
    await expect(toastText(page)).toHaveText(CREATED_NOTICE)
    expect(mock.bodies('PUT', '/wishlist/902')).toEqual([{ is_purchased: true }])
  })

  test('a 409 on purchase shows the API message and the item stays unpurchased', async ({ page }) => {
    const mock = await open(page, { 903: errorRoute('PUT', '/wishlist/903', 409, NO_RATE) })
    const camera = cardOf(page, CAMERA)
    await camera.getByRole('button', { name: 'Mark as purchased' }).click()
    await expect(camera.getByRole('alert')).toHaveText(NO_RATE)
    expect(mock.count('PUT', '/wishlist/903')).toBe(1)
    // Unpurchased: still listed as to buy, not struck through, and it can be tried again.
    await expect(camera.getByRole('button', { name: 'Mark as purchased' })).toBeVisible()
    await expect(camera.getByText(CAMERA.name, { exact: true })).not.toHaveClass(/line-through/)
    await expect(page.getByTestId('toast')).toHaveCount(0)
  })

  test('a refused edit shows the API message in the form and keeps it open', async ({ page }) => {
    const message = 'This item\'s card installment was already created; change it in Recurring instead'
    await open(page, { 902: errorRoute('PUT', '/wishlist/902', 409, message) })
    await cardOf(page, LAPTOP).getByRole('button', { name: 'Edit', exact: true }).click()
    const form = formOf(page)
    await form.getByRole('button', { name: 'Update', exact: true }).click()
    await expect(form.getByRole('alert')).toHaveText(message)
    await expect(form).toBeVisible()
  })

  test('editing a purchased full item to Installments shows the notice and refreshes the recurring and account data', async ({ page }) => {
    const mock = await open(page, {
      906: apiRoute<WishlistItem>('PUT', '/wishlist/906', { ...BOOK, payment_plan: 'installment', installment_months: 12, account_id: CARD.id, installment_entry_id: 79, notice: CREATED_NOTICE }),
    })
    await page.getByLabel('Show purchased').check()
    await cardOf(page, BOOK).getByRole('button', { name: 'Edit', exact: true }).click()
    const form = formOf(page)
    await form.getByRole('group', { name: 'Payment' }).getByRole('button', { name: 'Installments', exact: true }).click()
    await form.getByLabel('Pay from').selectOption(String(CARD.id))
    await form.getByLabel('Months').fill('12')
    const accountGets = (): number => mock.requests().filter((r) => r === 'GET /accounts/').length
    const before = accountGets()
    await form.getByRole('button', { name: 'Update', exact: true }).click()
    await expect(form).toHaveCount(0)
    await expect(toastText(page)).toHaveText(CREATED_NOTICE)
    expect(mock.bodies('PUT', '/wishlist/906')).toEqual([expect.objectContaining({ payment_plan: 'installment', installment_months: 12, account_id: CARD.id })])
    // The new recurring entry moves the card's credit, so the accounts are read again (Due and BudgetEntry go the same way).
    await expect.poll(accountGets).toBeGreaterThan(before)
  })

  test('a purchased item whose installment is linked is compared like any other: available less its payment', async ({ page }) => {
    await open(page)
    await page.getByLabel('Show purchased').check()
    const phone = cardOf(page, PHONE)
    await phone.getByRole('button', { name: 'Show outlook' }).click()
    const outlook = phone.getByTestId('installment-outlook')
    // STU-791: the API's rate is built from posted transactions, which do not count an unposted installment, so the
    // old "already counts in your plan" shortcut is gone and this item's payment comes off the rate like any other.
    await expect(outlook.getByTestId('outlook-month-2026-04').getByRole('cell')).toHaveText(['₱1,500.00', '₱3,000.00', '₱2,000.00'])
    await expect(outlook.getByTestId('outlook-month-2027-03').getByRole('cell')).toHaveText(['₱0.00', '₱0.00', '₱5,000.00'])
  })

  test('once the card installment exists, the price, currency and payment are locked', async ({ page }) => {
    await open(page)
    await page.getByLabel('Show purchased').check()
    await cardOf(page, PHONE).getByRole('button', { name: 'Edit', exact: true }).click()
    const form = formOf(page)
    await expect(form.locator('input[type="number"]').first()).toBeDisabled()
    await expect(form.getByLabel('Currency')).toBeDisabled()
    await expect(form.getByLabel('Pay from')).toBeDisabled()
    await expect(form.getByRole('group', { name: 'Payment' }).getByRole('button', { name: 'Installments', exact: true })).toBeDisabled()
    await expect(form.getByLabel('Months')).toBeDisabled()
    await expect(form).toContainText('card installment was created')
  })

  test.describe('un-marking', () => {
    async function openPurchased(page: Page, puts: Record<number, ApiRoute> = {}): Promise<{ mock: ApiMock; phone: Locator }> {
      const mock = await open(page, puts)
      await page.getByLabel('Show purchased').check()
      const phone = cardOf(page, PHONE)
      await expect(phone).toBeVisible()
      return { mock, phone }
    }
    const dialog = (page: Page): Locator => page.getByTestId('confirm-dialog')

    test('asks first, says the installment keeps running in Recurring and links to it', async ({ page }) => {
      const { mock, phone } = await openPurchased(page)
      await phone.getByRole('button', { name: 'Mark as not purchased' }).click()
      await expect(dialog(page)).toBeVisible()
      await expect(page.getByTestId('confirm-dialog-title')).toHaveText('Mark as not purchased?')
      await expect(page.getByTestId('confirm-dialog-message')).toContainText('keeps running in Recurring')
      const link = page.getByTestId('confirm-dialog-link')
      await expect(link).toHaveText('Open Recurring')
      expect(mock.count('PUT', '/wishlist/904')).toBe(0)

      // Cancel changes nothing.
      await page.getByTestId('confirm-dialog-cancel').click()
      await expect(dialog(page)).toHaveCount(0)
      expect(mock.count('PUT', '/wishlist/904')).toBe(0)

      // The link goes to Recurring, closes the dialog and un-marks nothing.
      await phone.getByRole('button', { name: 'Mark as not purchased' }).click()
      await link.click()
      await expect(page).toHaveURL(/\/allocations\?tab=recurring/)
      await expect(dialog(page)).toHaveCount(0)
      expect(mock.count('PUT', '/wishlist/904')).toBe(0)
    })

    test('confirming un-marks and shows the notice that the installment stays', async ({ page }) => {
      const { mock, phone } = await openPurchased(page, {
        904: apiRoute<WishlistItem>('PUT', '/wishlist/904', { ...PHONE, is_purchased: false, purchased_at: undefined, notice: KEPT_NOTICE }),
      })
      await phone.getByRole('button', { name: 'Mark as not purchased' }).click()
      await page.getByTestId('confirm-dialog-confirm').click()
      await expect(dialog(page)).toHaveCount(0)
      expect(mock.bodies('PUT', '/wishlist/904')).toEqual([{ is_purchased: false }])
      await expect(toastText(page)).toHaveText(KEPT_NOTICE)
    })
  })
})
