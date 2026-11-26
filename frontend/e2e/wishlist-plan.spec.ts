import { expect, test } from '@playwright/test'
import type { Locator, Page } from '@playwright/test'
import type { Allocation, DashboardSnapshot, WishlistFreeFlow, WishlistItem, WishlistOutlook, WishlistPlan } from '@tally-trace/shared'
import {
  createAccountRoute,
  createdAccount,
  household,
  householdCreateRoutes,
  householdViewRoutes,
  mockHousehold,
  newAccountInput,
  rankedGoals,
} from './support/fixtures/household'
import { COVERED, SHORT_BY_500 } from './support/fixtures/freeFlow'
import {
  IDS,
  INCOMPLETE_NOTE,
  ITEMS,
  ITEM_BY_ID,
  NOT_ESTIMATED_NOTE,
  NO_PROJECTION_NOTE,
  PAID_FROM_SAVINGS_NOTE,
  PLAN_AFTER_WRITE,
  PLAN_INCOMPLETE,
  PLAN_INSTALLMENTS_ONLY,
  PLAN_INSTALLMENTS_ONLY_NOT_ESTIMATED,
  PLAN_NOT_ESTIMATED,
  PLAN_NO_PROJECTION,
  PLAN_OVERSPENT,
  PLAN_OK,
  PLAN_SHORT,
  PLAN_TWO_CURRENCIES,
  PLAN_TWO_URGENT,
  PLAN_WITH_INSTALLMENT,
  PLAN_YEAR,
  outlookOf,
  repairItem,
} from './support/fixtures/wishlistPlan'
import { addRoutes, apiRoute, queryRoute, sequenceRoute } from './support/mockApi'
import type { ApiMock, ApiRoute } from './support/mockApi'
import { shot } from './support/shot'

// STU-791: the wishlist panel shows where its dates come from. The "Assuming..." sentence is three monthly figures per
// currency (net flow, kept for saving, free for the wishlist) and, when the history is under 12 months, "based on your
// last N full months"; the row-status and shortfall messages show when they apply. Urgent needs are listed first, each
// with its net flow after the purchase and what comes out of saving, and wants follow. An item with no date shows its
// note in place of one, and a paid-from-savings item shows its note and no date. Amounts read in each item's own
// currency. The item form describes Critical as an urgent need and the rest as wants. Marking an item purchased says the
// estimate moves only once the transaction is recorded. Writes refresh the plan, outlook and dashboard reads. The API is
// faked in the browser; there is no backend.

test.use({ locale: 'en-US' })

const SHORTFALL_TEXT = 'Net flow is ₱3,000.00 a month short of what you keep for saving, so nothing is free for the wishlist.'
const PLAN_PATH = '/wishlist/plan'
const SNAPSHOT_PATH = '/dashboard/snapshot'
const outlookPath = (id: number): string => `/wishlist/${id}/outlook`

const planRoute = (plan: WishlistPlan): ApiRoute => apiRoute<WishlistPlan>('GET', PLAN_PATH, plan)

/** The wishlist's reads for `items`, and a reply for each item's update and for a create. */
function wishlistRoutes(plan: ApiRoute, items: WishlistItem[] = ITEMS, outlooks: ApiRoute[] = []): ApiRoute[] {
  const outlookIds = new Set(outlooks.map((o) => o.path))
  return [
    queryRoute<WishlistItem[]>('GET', '/wishlist/', (q) => (q.get('is_purchased') === 'false' ? items.filter((i) => !i.is_purchased) : items)),
    plan,
    apiRoute<WishlistItem>('POST', '/wishlist/', { ...ITEM_BY_ID(IDS.desk), id: 990, name: 'Added item' }, 201),
    ...items.filter((i) => !outlookIds.has(outlookPath(i.id))).map((i) => apiRoute<WishlistOutlook>('GET', outlookPath(i.id), outlookOf(i, 18000))),
    ...outlooks,
    ...items.map((i) => apiRoute<WishlistItem>('PUT', `/wishlist/${i.id}`, { ...i, is_purchased: true })),
  ]
}

/** Opens the Wishlist tab with `plan` answering the plan, once the Purchase plan has settled. */
async function open(page: Page, plan: WishlistPlan | ApiRoute, extra: ApiRoute[] = [], outlooks: ApiRoute[] = []): Promise<ApiMock> {
  await mockHousehold(page, household)
  const planAnswer = 'method' in plan ? plan : planRoute(plan)
  const api = await addRoutes(page, [...householdViewRoutes(household), ...wishlistRoutes(planAnswer, ITEMS, outlooks), ...extra])
  await page.goto('/allocations?tab=wishlist')
  await expect(page.getByTestId('purchase-plan')).toBeVisible({ timeout: 15_000 })
  await expect(page.getByTestId(`wishlist-item-${IDS.desk}`)).toBeVisible()
  await page.waitForLoadState('networkidle')
  return api
}

const panel = (page: Page): Locator => page.getByTestId('purchase-plan')
const figure = (page: Page, which: 'net' | 'kept' | 'free'): Locator => panel(page).getByTestId(`flow-${which}`)
const figureValue = (page: Page, which: 'net' | 'kept' | 'free'): Locator => figure(page, which).locator('dd')
const planItem = (page: Page, id: number): Locator => panel(page).getByTestId(`plan-item-${id}`)
const cardOf = (page: Page, id: number): Locator => page.getByTestId(`wishlist-item-${id}`)

test.describe('wishlist plan and priority wording (STU-791)', () => {
  test('AC1: three monthly figures replace the "Assuming" sentence, with the sample size under 12 months', async ({ page }) => {
    const api = await open(page, PLAN_OK)
    expect(api.count('GET', PLAN_PATH)).toBeGreaterThan(0)
    await expect(panel(page).getByText(/Assuming/)).toHaveCount(0)
    for (const which of ['net', 'kept', 'free'] as const) await expect(figure(page, which)).toBeVisible()
    await expect(figure(page, 'net').locator('dt')).toHaveText('Net flow')
    await expect(figureValue(page, 'net')).toHaveText('₱60,000.00')
    await expect(figure(page, 'kept').locator('dt')).toHaveText('Kept for saving')
    await expect(figureValue(page, 'kept')).toHaveText('₱42,000.00')
    await expect(figure(page, 'free').locator('dt')).toHaveText('Free for the wishlist')
    await expect(figureValue(page, 'free')).toHaveText('₱18,000.00')
    const sample = panel(page).getByTestId('flow-sample')
    await expect(sample).toBeVisible()
    await expect(sample).toHaveText('Based on your last 4 full months')
    await shot(page, 'figures')
  })

  test('AC1: no sample note once the figures rest on a full 12 months', async ({ page }) => {
    await open(page, PLAN_YEAR)
    await expect(figureValue(page, 'net')).toBeVisible()
    await expect(panel(page).getByTestId('flow-sample')).toHaveCount(0)
  })

  test('AC1: each currency gets its own three figures, in its own currency', async ({ page }) => {
    await open(page, PLAN_TWO_CURRENCIES)
    const php = panel(page).getByTestId('flow-PHP')
    const usd = panel(page).getByTestId('flow-USD')
    await expect(php).toBeVisible()
    await expect(usd).toBeVisible()
    await expect(php.getByTestId('flow-net').locator('dd')).toHaveText('₱60,000.00')
    await expect(php.getByTestId('flow-free').locator('dd')).toHaveText('₱18,000.00')
    await expect(usd.getByTestId('flow-net').locator('dd')).toHaveText('$900.00')
    await expect(usd.getByTestId('flow-kept').locator('dd')).toHaveText('$300.00')
    await expect(usd.getByTestId('flow-free').locator('dd')).toHaveText('$600.00')
    await shot(page, 'two-currencies')
  })

  test('AC2: a user with no full month of history is told what is needed, and sees no figures', async ({ page }) => {
    await open(page, PLAN_NOT_ESTIMATED)
    const status = panel(page).getByTestId('flow-status')
    await expect(status).toBeVisible()
    await expect(status).toHaveText(NOT_ESTIMATED_NOTE)
    await expect(panel(page).getByTestId('flow-net')).toHaveCount(0)
    await expect(panel(page).getByTestId('flow-sample')).toHaveCount(0)
    await shot(page, 'not-estimated')
  })

  test('AC2: money in more than one currency says it cannot be estimated yet, and sees no figures', async ({ page }) => {
    await open(page, PLAN_INCOMPLETE)
    const status = panel(page).getByTestId('flow-status')
    await expect(status).toBeVisible()
    await expect(status).toHaveText(INCOMPLETE_NOTE)
    await expect(panel(page).getByTestId('flow-net')).toHaveCount(0)
    await expect(panel(page).getByTestId('flow-free')).toHaveCount(0)
    await shot(page, 'incomplete')
  })

  test('AC2: a currency with no income says there is no projection, and sees no figures', async ({ page }) => {
    await open(page, PLAN_NO_PROJECTION)
    const status = panel(page).getByTestId('flow-status')
    await expect(status).toBeVisible()
    await expect(status).toHaveText(NO_PROJECTION_NOTE)
    await expect(panel(page).getByTestId('flow-net')).toHaveCount(0)
    await shot(page, 'no-projection')
  })

  test('AC2: a shortfall is named beside the figures, and no message shows when goals are covered', async ({ page }) => {
    await open(page, PLAN_SHORT)
    const shortfall = panel(page).getByTestId('flow-shortfall')
    await expect(shortfall).toBeVisible()
    await expect(shortfall).toHaveText(SHORTFALL_TEXT)
    await expect(figureValue(page, 'free')).toHaveText('₱0.00')
    await shot(page, 'shortfall')
  })

  test('AC2: covered goals show no status or shortfall message', async ({ page }) => {
    await open(page, PLAN_OK)
    await expect(figureValue(page, 'free')).toBeVisible()
    await expect(panel(page).getByTestId('flow-shortfall')).toHaveCount(0)
    await expect(panel(page).getByTestId('flow-status')).toHaveCount(0)
  })

  test('AC2: outgoings above income with nothing kept for saving is a shortfall that does not blame goals', async ({ page }) => {
    await open(page, PLAN_OVERSPENT)
    const shortfall = panel(page).getByTestId('flow-shortfall')
    await expect(shortfall).toBeVisible()
    await expect(shortfall).toHaveText(SHORTFALL_TEXT)
    await expect(shortfall).not.toContainText('goals')
    await expect(figureValue(page, 'net')).toHaveText('₱-3,000.00')
    await expect(figureValue(page, 'kept')).toHaveText('₱0.00')
    await shot(page, 'overspent')
  })

  test('AC1: a plan with only installment items still shows the three figures and the note', async ({ page }) => {
    await mockHousehold(page, household)
    await addRoutes(page, [...householdViewRoutes(household), ...wishlistRoutes(planRoute(PLAN_INSTALLMENTS_ONLY), ITEMS.filter((i) => i.id === IDS.phone))])
    await page.goto('/allocations?tab=wishlist')
    await expect(panel(page)).toBeVisible({ timeout: 15_000 })
    await expect(panel(page).getByTestId('plan-installments')).toBeVisible()
    await expect(panel(page).getByTestId('plan-wants')).toHaveCount(0)
    for (const which of ['net', 'kept', 'free'] as const) await expect(figure(page, which)).toBeVisible()
    await expect(figureValue(page, 'net')).toHaveText('₱60,000.00')
    await expect(panel(page).getByTestId('flow-sample')).toHaveText('Based on your last 4 full months')
  })

  test('AC2: a plan with only installment items still says when there is no estimate', async ({ page }) => {
    await mockHousehold(page, household)
    await addRoutes(page, [...householdViewRoutes(household), ...wishlistRoutes(planRoute(PLAN_INSTALLMENTS_ONLY_NOT_ESTIMATED), ITEMS.filter((i) => i.id === IDS.phone))])
    await page.goto('/allocations?tab=wishlist')
    await expect(panel(page).getByTestId('plan-installments')).toBeVisible({ timeout: 15_000 })
    await expect(panel(page).getByTestId('flow-status')).toBeVisible()
    await expect(panel(page).getByTestId('flow-status')).toHaveText(NOT_ESTIMATED_NOTE)
  })

  test('AC4: a long projection note fits its row, beside the name and below it, on every viewport', async ({ page }) => {
    await open(page, PLAN_INCOMPLETE)
    const viewport = page.viewportSize()
    for (const id of [IDS.repair, IDS.desk]) {
      const item = planItem(page, id)
      const note = item.getByTestId('plan-note')
      await expect(note).toBeVisible()
      await expect(note).toHaveText(INCOMPLETE_NOTE)
      const [itemBox, noteBox, scroll] = await Promise.all([
        item.boundingBox(),
        note.boundingBox(),
        item.evaluate((el) => ({ scroll: el.scrollWidth, client: el.clientWidth })),
      ])
      expect(itemBox && noteBox && noteBox.x >= itemBox.x - 0.5 && noteBox.x + noteBox.width <= itemBox.x + itemBox.width + 0.5, `the note sits inside item ${id}`).toBe(true)
      expect(scroll.scroll, `item ${id} does not scroll sideways`).toBeLessThanOrEqual(scroll.client)
    }
    const page_ = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth }))
    expect(page_.scroll, `the page does not scroll sideways at ${viewport?.width}px`).toBeLessThanOrEqual(page_.client)
    await shot(page, 'long-note')
  })

  test('AC3: Urgent needs lists each critical item with its net flow after the purchase and what comes out of saving', async ({ page }) => {
    await open(page, PLAN_TWO_URGENT)
    const urgent = panel(page).getByTestId('plan-urgent')
    await expect(urgent).toBeVisible()
    await expect(urgent.getByRole('heading', { name: 'Urgent needs' })).toBeVisible()
    await expect(urgent.getByTestId(`plan-item-${IDS.repair}`)).toBeVisible()
    await expect(urgent.getByTestId(`plan-item-${IDS.boiler}`)).toBeVisible()
    await expect(urgent.getByTestId(`plan-item-${IDS.desk}`)).toHaveCount(0)

    const repair = planItem(page, IDS.repair)
    await expect(repair.getByTestId('plan-net-flow-after')).toBeVisible()
    await expect(repair.getByTestId('plan-net-flow-after')).toHaveText('Net flow if you bought it this month: ₱36,000.00 instead of ₱60,000.00')
    await expect(repair.getByTestId('plan-from-saving')).toBeVisible()
    await expect(repair.getByTestId('plan-from-saving')).toHaveText('About ₱6,000.00 of it comes out of saving')
    // The second need takes nothing out of saving.
    const boiler = planItem(page, IDS.boiler)
    await expect(boiler.getByTestId('plan-net-flow-after')).toHaveText('Net flow if you bought it this month: ₱42,000.00 instead of ₱60,000.00')
    await expect(boiler.getByTestId('plan-from-saving')).toHaveText('None of it comes out of saving')
    await shot(page, 'urgent')
  })

  test('AC3: Wants follows Urgent needs, in the API order, and holds no critical item', async ({ page }) => {
    await open(page, PLAN_OK)
    const urgent = panel(page).getByTestId('plan-urgent')
    const wants = panel(page).getByTestId('plan-wants')
    await expect(wants.getByRole('heading', { name: 'Wants' })).toBeVisible()
    const urgentBox = await urgent.boundingBox()
    const wantsBox = await wants.boundingBox()
    expect(urgentBox && wantsBox && urgentBox.y < wantsBox.y, 'Urgent needs sits above Wants').toBe(true)
    await expect(wants.getByTestId(`plan-item-${IDS.repair}`)).toHaveCount(0)
    const names = await wants.getByTestId('plan-queue').locator('li').evaluateAll((rows) => rows.map((r) => r.querySelector('.font-medium')?.textContent))
    expect(names).toEqual(['Standing desk', 'Camera lens', 'Espresso machine', 'Piano'])
    // Each currency has its own queue and a paid-from-savings item is outside it, so no row carries a shared position.
    for (const row of await wants.getByTestId('plan-queue').locator('li').all()) await expect(row).not.toHaveText(/^\d/)
  })

  test('AC3: with no critical item there is no Urgent needs section', async ({ page }) => {
    await open(page, { ...PLAN_OK, items: PLAN_OK.items.filter((i) => i.priority !== 'critical') })
    await expect(panel(page).getByTestId('plan-wants')).toBeVisible()
    await expect(panel(page).getByTestId('plan-urgent')).toHaveCount(0)
    await expect(panel(page).getByRole('heading', { name: 'Urgent needs' })).toHaveCount(0)
  })

  test('AC4: a dated item shows its date, and an item the queue leaves undated shows the queue note in its place', async ({ page }) => {
    await open(page, PLAN_OK)
    const desk = planItem(page, IDS.desk)
    await expect(desk.getByTestId('plan-date')).toBeVisible()
    await expect(desk.getByTestId('plan-date')).toHaveText('~Jun 25, 2026 · 4 mo')
    await expect(desk.getByTestId('plan-note')).toHaveCount(0)
    const espresso = planItem(page, IDS.espresso)
    await expect(espresso.getByTestId('plan-note')).toBeVisible()
    await expect(espresso.getByTestId('plan-note')).toHaveText('More than 5 years away behind earlier items')
    await expect(espresso.getByTestId('plan-date')).toHaveCount(0)
    await shot(page, 'dates-and-notes')
  })

  test('AC4: a paid-from-savings item shows its note and no date', async ({ page }) => {
    await open(page, PLAN_OK)
    const piano = planItem(page, IDS.vault)
    await expect(piano.getByTestId('plan-note')).toBeVisible()
    await expect(piano.getByTestId('plan-note')).toHaveText(PAID_FROM_SAVINGS_NOTE)
    await expect(piano.getByTestId('plan-date')).toHaveCount(0)
  })

  test('AC4: an item with no estimate shows its projection note in place of a date', async ({ page }) => {
    await open(page, PLAN_NOT_ESTIMATED)
    await expect(planItem(page, IDS.repair).getByTestId('plan-note')).toHaveText(NOT_ESTIMATED_NOTE)
    await expect(planItem(page, IDS.desk).getByTestId('plan-note')).toHaveText(NOT_ESTIMATED_NOTE)
    await expect(panel(page).getByTestId('plan-date')).toHaveCount(0)
  })

  test('AC4: a projection note shows when the API sends it without the combined note', async ({ page }) => {
    // The API fills `note` from the projection note or the queue note; this reads the two from their own fields,
    // so an answer that carries only those still shows why there is no date (cautious reading of "projection_note or queue_note").
    const bare: WishlistPlan = {
      ...PLAN_OK,
      items: [
        { ...PLAN_OK.items[1], estimated_purchase_date: null, note: null, projection_status: 'no_room', projection_note: 'Nothing is left after your savings goals' },
        { ...PLAN_OK.items[2], estimated_purchase_date: null, note: null, queue_note: 'More than 5 years away behind earlier items' },
      ],
    }
    await open(page, bare)
    await expect(planItem(page, IDS.desk).getByTestId('plan-note')).toHaveText('Nothing is left after your savings goals')
    await expect(planItem(page, IDS.lens).getByTestId('plan-note')).toHaveText('More than 5 years away behind earlier items')
  })

  test('AC5: readiness is never read, and a legacy placeholder date is never shown for an item that is not dated', async ({ page }) => {
    // The web app has no readiness query; this pins it, and pins that the plan's date shows only for a `dated` item.
    const legacy: WishlistPlan = {
      ...PLAN_OK,
      items: [
        // The API's compatibility sentinel for a paid-from-savings item, sent in the plan's date field by mistake.
        { ...PLAN_OK.items[4], estimated_purchase_date: '2054-04-12', cumulative_months: 9999 },
        { ...PLAN_OK.items[1], projection_status: 'no_room', estimated_purchase_date: '2054-04-12', projection_note: 'Nothing is left after your savings goals', note: 'Nothing is left after your savings goals' },
      ],
    }
    const api = await open(page, legacy)
    await expect(planItem(page, IDS.vault).getByTestId('plan-note')).toBeVisible()
    await expect(planItem(page, IDS.desk).getByTestId('plan-note')).toBeVisible()
    await expect(panel(page).getByTestId('plan-date')).toHaveCount(0)
    await expect(page.getByText(/2054/)).toHaveCount(0)
    expect(api.requests().filter((r) => r.includes('/readiness'))).toEqual([])
  })

  test('AC6: the outlook table leaves what the outlook\'s available figure has after the item', async ({ page }) => {
    const phone = ITEM_BY_ID(IDS.phone)
    await open(page, PLAN_WITH_INSTALLMENT, [], [apiRoute<WishlistOutlook>('GET', outlookPath(phone.id), outlookOf(phone, 20000))])
    await cardOf(page, phone.id).getByRole('button', { name: 'Show outlook' }).click()
    const month = page.getByTestId('outlook-month-2026-04')
    await expect(month).toBeVisible()
    // 20,000 available less the item's 4,000: never the recurring-entry figure (90,000) the answer still carries.
    await expect(month.locator('td').last()).toHaveText('₱16,000.00')
    await expect(page.getByTestId('outlook-month-2026-09').locator('td').last()).toHaveText('₱16,000.00')
    await shot(page, 'outlook-available')
  })

  test('AC6: the leftover shows nothing when the outlook has no available figure', async ({ page }) => {
    const phone = ITEM_BY_ID(IDS.phone)
    await open(page, PLAN_WITH_INSTALLMENT, [], [apiRoute<WishlistOutlook>('GET', outlookPath(phone.id), outlookOf(phone, null))])
    await cardOf(page, phone.id).getByRole('button', { name: 'Show outlook' }).click()
    const month = page.getByTestId('outlook-month-2026-04')
    await expect(month).toBeVisible()
    // The other columns still show; the leftover cell is empty.
    await expect(month.locator('td').nth(1)).toHaveText('₱4,000.00')
    await expect(month.locator('td').last()).toBeEmpty()
  })

  test("AC7: each amount reads in its item's own currency", async ({ page }) => {
    await open(page, PLAN_TWO_CURRENCIES)
    await expect(planItem(page, IDS.desk).getByTestId('plan-cost')).toHaveText('₱27,000.00')
    const chair = planItem(page, IDS.chair)
    await expect(chair.getByTestId('plan-cost')).toBeVisible()
    await expect(chair.getByTestId('plan-cost')).toHaveText('$800.00')
    await expect(cardOf(page, IDS.chair)).toContainText('$800.00')
    // An urgent need in a currency other than the default reads in it too.
    await shot(page, 'own-currency')
  })

  test("AC7: an urgent need's net flow lines read in its own currency", async ({ page }) => {
    const dollarRepair = repairItem({ currency: 'USD', estimated_cost: 800, net_flow_after: 100, from_saving: 50 })
    const plan: WishlistPlan = { ...PLAN_TWO_CURRENCIES, items: [dollarRepair, ...PLAN_TWO_CURRENCIES.items] }
    await open(page, plan)
    const line = planItem(page, IDS.repair).getByTestId('plan-net-flow-after')
    await expect(line).toBeVisible()
    await expect(line).toHaveText('Net flow if you bought it this month: $100.00 instead of $900.00')
    await expect(planItem(page, IDS.repair).getByTestId('plan-from-saving')).toHaveText('About $50.00 of it comes out of saving')
  })

  test('AC8: the form describes Critical as an urgent need that comes before saving, and the rest as wants', async ({ page }) => {
    const api = await open(page, PLAN_OK)
    await page.getByRole('button', { name: 'Add item', exact: true }).click()
    const form = page.locator('form').filter({ has: page.getByPlaceholder('What are you saving for?') })
    const priority = form.getByTestId('wishlist-priority')
    await expect(priority).toBeVisible()
    const critical = priority.getByRole('radio', { name: /^Critical/ })
    const want = priority.getByRole('radio', { name: /^A want/ })
    await expect(critical).toBeVisible()
    await expect(priority.getByText('An urgent need. It comes before your savings.')).toBeVisible()
    await expect(want).toBeVisible()
    await expect(priority.getByText('Saved for after your savings, in this order.')).toBeVisible()
    const levels = priority.getByRole('group', { name: 'How much you want it' })
    for (const level of ['High', 'Medium', 'Low']) await expect(levels.getByRole('button', { name: level, exact: true })).toBeVisible()
    // The first priority is a want, Medium.
    await expect(want).toBeChecked()
    await expect(levels.getByRole('button', { name: 'Medium', exact: true })).toHaveAttribute('aria-pressed', 'true')
    await shot(page, 'priority-want')

    await critical.check()
    await expect(critical).toBeChecked()
    for (const level of ['High', 'Medium', 'Low']) await expect(levels.getByRole('button', { name: level, exact: true })).toHaveAttribute('aria-pressed', 'false')
    await form.getByPlaceholder('What are you saving for?').fill('Boiler')
    await form.getByPlaceholder('0.00').first().fill('18000')
    await shot(page, 'priority-critical')
    await form.getByRole('button', { name: 'Add', exact: true }).click()
    await expect.poll(() => api.bodies('POST', '/wishlist/').length).toBe(1)
    expect(api.bodies('POST', '/wishlist/')[0]).toHaveProperty('priority', 'critical')
  })

  test('AC8: picking a level makes the item a want at that level, and an edit opens on the item\'s own level', async ({ page }) => {
    const api = await open(page, PLAN_OK)
    await cardOf(page, IDS.desk).getByRole('button', { name: 'Edit', exact: true }).click()
    const form = page.locator('form').filter({ has: page.getByPlaceholder('What are you saving for?') })
    const priority = form.getByTestId('wishlist-priority')
    const levels = priority.getByRole('group', { name: 'How much you want it' })
    // The standing desk is High.
    await expect(priority.getByRole('radio', { name: /^A want/ })).toBeChecked()
    await expect(levels.getByRole('button', { name: 'High', exact: true })).toHaveAttribute('aria-pressed', 'true')
    await levels.getByRole('button', { name: 'Low', exact: true }).click()
    await expect(levels.getByRole('button', { name: 'Low', exact: true })).toHaveAttribute('aria-pressed', 'true')
    await form.getByRole('button', { name: 'Update', exact: true }).click()
    await expect.poll(() => api.bodies('PUT', `/wishlist/${IDS.desk}`).length).toBe(1)
    expect(api.bodies('PUT', `/wishlist/${IDS.desk}`)[0]).toHaveProperty('priority', 'low')

    // An urgent need opens with Critical chosen.
    await cardOf(page, IDS.repair).getByRole('button', { name: 'Edit', exact: true }).click()
    await expect(page.getByTestId('wishlist-priority').getByRole('radio', { name: /^Critical/ })).toBeChecked()
  })

  test('AC9: the panel says marking an item purchased moves the estimate only once the transaction is recorded', async ({ page }) => {
    const api = await open(page, PLAN_OK)
    const note = page.getByTestId('purchase-note')
    await expect(note).toBeVisible()
    await expect(note).toHaveText('Marking an item purchased does not record the payment. Its estimate moves only once you record the transaction.')
    await cardOf(page, IDS.desk).getByRole('button', { name: 'Mark as purchased', exact: true }).click()
    await expect.poll(() => api.bodies('PUT', `/wishlist/${IDS.desk}`).length).toBe(1)
    expect(api.bodies('PUT', `/wishlist/${IDS.desk}`)[0]).toEqual({ is_purchased: true })
    await expect(note).toBeVisible()
    await shot(page, 'purchase-note')
  })

  test('AC10: an allocation write refreshes the plan, outlook, free flow and dashboard reads', async ({ page }) => {
    const created: Allocation = { ...household.allocations[0], id: 99, name: 'Standing desk' }
    const api = await openEverything(page, [apiRoute<Allocation>('POST', '/allocations/', created, 201)])
    await cardOf(page, IDS.desk).getByRole('button', { name: 'Savings target' }).click()
    const form = page.locator('form').filter({ has: page.getByRole('button', { name: /^Create / }) })
    await form.locator('[data-field="account_id"]').selectOption({ label: 'Metrobank Savings' })
    await form.getByRole('button', { name: 'Create savings tracker' }).click()
    await expect.poll(() => api.count('POST', '/allocations/')).toBe(1)
    // Every read the page can have cached is read a second time, and its new answer is on screen. The web has no
    // readiness query, so there is nothing to refresh or assert for readiness.
    await goTo(page, 'nav-home', 'Dashboard')
    await expect.poll(() => api.count('GET', SNAPSHOT_PATH)).toBe(2)
    await expect(leadingFigure(page)).toHaveText('₱73,210.50')
    await visitWishlistTab(page)
    await expect.poll(() => api.count('GET', PLAN_PATH)).toBe(2)
    await expect(figureValue(page, 'net')).toHaveText('₱64,000.00')
    await expect.poll(() => api.count('GET', outlookPath(IDS.desk))).toBe(2)
    await expect(cardOf(page, IDS.desk).getByTestId('budget-badge')).toHaveText('Over your monthly budget')
    await page.getByRole('button', { name: 'Savings', exact: true }).click()
    await expect.poll(() => api.count('GET', FLOW_PATH)).toBe(2)
    await expect(page.getByTestId('ranked-goal-underfunded')).toBeVisible()
    await expect(page.getByTestId('ranked-goal-underfunded')).toHaveText('Underfunded by ₱500.00 a month')
  })

  test('AC10: an account write refreshes the plan, outlook, free flow and dashboard reads', async ({ page }) => {
    const created = createdAccount(household, 90, { ...newAccountInput, tag_ids: [...newAccountInput.tag_ids] })
    const api = await openEverything(page, [createAccountRoute([created])])
    await goTo(page, 'nav-accounts', 'Accounts')
    await page.getByRole('button', { name: 'Add account', exact: true }).click()
    const dialog = page.locator('.fixed.inset-0.overflow-y-auto').last()
    await dialog.getByPlaceholder('Enter account name').fill(newAccountInput.name)
    await dialog.getByRole('button', { name: 'Create account', exact: true }).click()
    await expect.poll(() => api.count('POST', '/accounts/')).toBe(1)
    // Every read the page can have cached is read a second time, and its new answer is on screen. The web has no
    // readiness query, so there is nothing to refresh or assert for readiness.
    await goTo(page, 'nav-home', 'Dashboard')
    await expect.poll(() => api.count('GET', SNAPSHOT_PATH)).toBe(2)
    await expect(leadingFigure(page)).toHaveText('₱73,210.50')
    await visitWishlistTab(page)
    await expect.poll(() => api.count('GET', PLAN_PATH)).toBe(2)
    await expect(figureValue(page, 'net')).toHaveText('₱64,000.00')
    await expect.poll(() => api.count('GET', outlookPath(IDS.desk))).toBe(2)
    await expect(cardOf(page, IDS.desk).getByTestId('budget-badge')).toHaveText('Over your monthly budget')
    await page.getByRole('button', { name: 'Savings', exact: true }).click()
    await expect.poll(() => api.count('GET', FLOW_PATH)).toBe(2)
    await expect(page.getByTestId('ranked-goal-underfunded')).toBeVisible()
    await expect(page.getByTestId('ranked-goal-underfunded')).toHaveText('Underfunded by ₱500.00 a month')
  })

  test('AC10: a transaction write refreshes the plan, outlook, free flow and dashboard reads', async ({ page }) => {
    const api = await openEverything(page, householdCreateRoutes(household).filter((r) => r.path === '/transactions/'))
    await goTo(page, 'nav-transactions', 'Transactions')
    await page.getByRole('button', { name: 'Add transaction', exact: true }).first().click()
    const dialog = page.locator('.fixed.inset-0.overflow-y-auto').last()
    await expect(dialog.getByRole('heading', { name: 'Add transaction' })).toBeVisible()
    await dialog.getByPlaceholder('Add notes about this transaction').fill('Desk deposit')
    await dialog.getByRole('group', { name: /^(From account|Account)$/ }).getByRole('button', { name: /^BPI Payroll/ }).click()
    await dialog.locator('input[type="number"][placeholder="0.00"]').first().fill('120')
    await dialog.getByRole('button', { name: 'Add transaction', exact: true }).click()
    await expect.poll(() => api.count('POST', '/transactions/')).toBe(1)
    // Every read the page can have cached is read a second time, and its new answer is on screen. The web has no
    // readiness query, so there is nothing to refresh or assert for readiness.
    await goTo(page, 'nav-home', 'Dashboard')
    await expect.poll(() => api.count('GET', SNAPSHOT_PATH)).toBe(2)
    await expect(leadingFigure(page)).toHaveText('₱73,210.50')
    await visitWishlistTab(page)
    await expect.poll(() => api.count('GET', PLAN_PATH)).toBe(2)
    await expect(figureValue(page, 'net')).toHaveText('₱64,000.00')
    await expect.poll(() => api.count('GET', outlookPath(IDS.desk))).toBe(2)
    await expect(cardOf(page, IDS.desk).getByTestId('budget-badge')).toHaveText('Over your monthly budget')
    await page.getByRole('button', { name: 'Savings', exact: true }).click()
    await expect.poll(() => api.count('GET', FLOW_PATH)).toBe(2)
    await expect(page.getByTestId('ranked-goal-underfunded')).toBeVisible()
    await expect(page.getByTestId('ranked-goal-underfunded')).toHaveText('Underfunded by ₱500.00 a month')
  })

  test('AC10: reordering savings goals refreshes the plan, outlook, free flow and dashboard reads', async ({ page }) => {
    const goals = rankedGoals(household.allocations)
    const order = goals.map((g) => g.id)
    const last = goals[goals.length - 1]
    ;[order[order.length - 2], order[order.length - 1]] = [order[order.length - 1], order[order.length - 2]]
    const api = await openEverything(page, [
      apiRoute<{ items: Allocation[] }>('PUT', '/allocations/ranked', { items: order.flatMap((id, index) => goals.filter((g) => g.id === id).map((g) => ({ ...g, rank: index + 1 }))) }),
    ])
    await page.getByRole('button', { name: 'Savings', exact: true }).click()
    await page.getByRole('button', { name: `Move ${last.name} up`, exact: true }).click()
    await expect.poll(() => api.bodies('PUT', '/allocations/ranked').length).toBe(1)
    // Every read the page can have cached is read a second time, and its new answer is on screen. The web has no
    // readiness query, so there is nothing to refresh or assert for readiness.
    await goTo(page, 'nav-home', 'Dashboard')
    await expect.poll(() => api.count('GET', SNAPSHOT_PATH)).toBe(2)
    await expect(leadingFigure(page)).toHaveText('₱73,210.50')
    await visitWishlistTab(page)
    await expect.poll(() => api.count('GET', PLAN_PATH)).toBe(2)
    await expect(figureValue(page, 'net')).toHaveText('₱64,000.00')
    await expect.poll(() => api.count('GET', outlookPath(IDS.desk))).toBe(2)
    await expect(cardOf(page, IDS.desk).getByTestId('budget-badge')).toHaveText('Over your monthly budget')
    await page.getByRole('button', { name: 'Savings', exact: true }).click()
    await expect.poll(() => api.count('GET', FLOW_PATH)).toBe(2)
    await expect(page.getByTestId('ranked-goal-underfunded')).toBeVisible()
    await expect(page.getByTestId('ranked-goal-underfunded')).toHaveText('Underfunded by ₱500.00 a month')
  })

  test('AC10: adding a wishlist item refreshes the plan, outlook, free flow and dashboard reads', async ({ page }) => {
    const api = await openEverything(page)
    await page.getByRole('button', { name: 'Add item', exact: true }).click()
    const form = page.locator('form').filter({ has: page.getByPlaceholder('What are you saving for?') })
    await form.getByPlaceholder('What are you saving for?').fill('Added item')
    await form.getByPlaceholder('0.00').first().fill('9000')
    await form.getByRole('button', { name: 'Add', exact: true }).click()
    await expect.poll(() => api.bodies('POST', '/wishlist/').length).toBe(1)
    // Every read the page can have cached is read a second time, and its new answer is on screen. The web has no
    // readiness query, so there is nothing to refresh or assert for readiness.
    await goTo(page, 'nav-home', 'Dashboard')
    await expect.poll(() => api.count('GET', SNAPSHOT_PATH)).toBe(2)
    await expect(leadingFigure(page)).toHaveText('₱73,210.50')
    await visitWishlistTab(page)
    await expect.poll(() => api.count('GET', PLAN_PATH)).toBe(2)
    await expect(figureValue(page, 'net')).toHaveText('₱64,000.00')
    await expect.poll(() => api.count('GET', outlookPath(IDS.desk))).toBe(2)
    await expect(cardOf(page, IDS.desk).getByTestId('budget-badge')).toHaveText('Over your monthly budget')
    await page.getByRole('button', { name: 'Savings', exact: true }).click()
    await expect.poll(() => api.count('GET', FLOW_PATH)).toBe(2)
    await expect(page.getByTestId('ranked-goal-underfunded')).toBeVisible()
    await expect(page.getByTestId('ranked-goal-underfunded')).toHaveText('Underfunded by ₱500.00 a month')
  })

  test('AC10: deleting a wishlist item refreshes the plan, outlook, free flow and dashboard reads', async ({ page }) => {
    const api = await openEverything(page, [apiRoute<Record<string, never>>('DELETE', `/wishlist/${IDS.desk}`, {})])
    await cardOf(page, IDS.desk).getByRole('button', { name: 'Delete', exact: true }).click()
    await page.getByRole('button', { name: 'Delete item', exact: true }).click()
    await expect.poll(() => api.count('DELETE', `/wishlist/${IDS.desk}`)).toBe(1)
    // Every read the page can have cached is read a second time, and its new answer is on screen. The web has no
    // readiness query, so there is nothing to refresh or assert for readiness.
    await goTo(page, 'nav-home', 'Dashboard')
    await expect.poll(() => api.count('GET', SNAPSHOT_PATH)).toBe(2)
    await expect(leadingFigure(page)).toHaveText('₱73,210.50')
    await visitWishlistTab(page)
    await expect.poll(() => api.count('GET', PLAN_PATH)).toBe(2)
    await expect(figureValue(page, 'net')).toHaveText('₱64,000.00')
    await expect.poll(() => api.count('GET', outlookPath(IDS.desk))).toBe(2)
    await expect(cardOf(page, IDS.desk).getByTestId('budget-badge')).toHaveText('Over your monthly budget')
    await page.getByRole('button', { name: 'Savings', exact: true }).click()
    await expect.poll(() => api.count('GET', FLOW_PATH)).toBe(2)
    await expect(page.getByTestId('ranked-goal-underfunded')).toBeVisible()
    await expect(page.getByTestId('ranked-goal-underfunded')).toHaveText('Underfunded by ₱500.00 a month')
  })

  test('AC10: editing a wishlist item refreshes the plan, outlook, free flow and dashboard reads', async ({ page }) => {
    const api = await openEverything(page)
    await cardOf(page, IDS.desk).getByRole('button', { name: 'Edit', exact: true }).click()
    const form = page.locator('form').filter({ has: page.getByPlaceholder('What are you saving for?') })
    await form.getByPlaceholder('What are you saving for?').fill('Standing desk, oak')
    await form.getByRole('button', { name: 'Update', exact: true }).click()
    await expect.poll(() => api.bodies('PUT', `/wishlist/${IDS.desk}`).length).toBe(1)
    // Every read the page can have cached is read a second time, and its new answer is on screen. The web has no
    // readiness query, so there is nothing to refresh or assert for readiness.
    await goTo(page, 'nav-home', 'Dashboard')
    await expect.poll(() => api.count('GET', SNAPSHOT_PATH)).toBe(2)
    await expect(leadingFigure(page)).toHaveText('₱73,210.50')
    await visitWishlistTab(page)
    await expect.poll(() => api.count('GET', PLAN_PATH)).toBe(2)
    await expect(figureValue(page, 'net')).toHaveText('₱64,000.00')
    await expect.poll(() => api.count('GET', outlookPath(IDS.desk))).toBe(2)
    await expect(cardOf(page, IDS.desk).getByTestId('budget-badge')).toHaveText('Over your monthly budget')
    await page.getByRole('button', { name: 'Savings', exact: true }).click()
    await expect.poll(() => api.count('GET', FLOW_PATH)).toBe(2)
    await expect(page.getByTestId('ranked-goal-underfunded')).toBeVisible()
    await expect(page.getByTestId('ranked-goal-underfunded')).toHaveText('Underfunded by ₱500.00 a month')
  })

  test('AC10: marking a wishlist item purchased refreshes the plan, outlook, free flow and dashboard reads', async ({ page }) => {
    const api = await openEverything(page)
    await cardOf(page, IDS.desk).getByRole('button', { name: 'Mark as purchased', exact: true }).click()
    await expect.poll(() => api.bodies('PUT', `/wishlist/${IDS.desk}`).length).toBe(1)
    // Every read the page can have cached is read a second time, and its new answer is on screen. The web has no
    // readiness query, so there is nothing to refresh or assert for readiness.
    await goTo(page, 'nav-home', 'Dashboard')
    await expect.poll(() => api.count('GET', SNAPSHOT_PATH)).toBe(2)
    await expect(leadingFigure(page)).toHaveText('₱73,210.50')
    await visitWishlistTab(page)
    await expect.poll(() => api.count('GET', PLAN_PATH)).toBe(2)
    await expect(figureValue(page, 'net')).toHaveText('₱64,000.00')
    await expect.poll(() => api.count('GET', outlookPath(IDS.desk))).toBe(2)
    await expect(cardOf(page, IDS.desk).getByTestId('budget-badge')).toHaveText('Over your monthly budget')
    await page.getByRole('button', { name: 'Savings', exact: true }).click()
    await expect.poll(() => api.count('GET', FLOW_PATH)).toBe(2)
    await expect(page.getByTestId('ranked-goal-underfunded')).toBeVisible()
    await expect(page.getByTestId('ranked-goal-underfunded')).toHaveText('Underfunded by ₱500.00 a month')
  })
})

const FLOW_PATH = '/wishlist/free-flow'

/** The household's snapshot with its available cash and next-up list changed: what the API answers after a write. */
function snapshotWith(availableCash: number, nextUp: DashboardSnapshot['wishlist_next_up']): DashboardSnapshot {
  const { snapshot } = household
  return {
    ...snapshot,
    wishlist_next_up: nextUp,
    balances: { ...snapshot.balances, by_currency: snapshot.balances.by_currency.map((r) => (r.currency === 'PHP' ? { ...r, available_cash: availableCash } : r)) },
  }
}
const NEXT_UP_BEFORE: DashboardSnapshot['wishlist_next_up'] = [
  { id: IDS.desk, name: 'Standing desk', cost: 27000, priority: 'high', affordable_by: '2026-06-25', note: null, projection_status: 'dated', projection_note: null },
]
const NEXT_UP_AFTER: DashboardSnapshot['wishlist_next_up'] = [
  { id: IDS.lens, name: 'Camera lens', cost: 45000, priority: 'medium', affordable_by: '2026-09-25', note: null, projection_status: 'dated', projection_note: null },
]
const SNAPSHOT_BEFORE = snapshotWith(48200, NEXT_UP_BEFORE)
const SNAPSHOT_AFTER = snapshotWith(73210.5, NEXT_UP_AFTER)

const leadingFigure = (page: Page): Locator => page.getByTestId('leading-figure-amount')

/**
 * Opens the dashboard, then the Savings tab, then the Wishlist tab, each by following a link so the store keeps what
 * it holds. Every read the page can have cached is then cached with its first answer: the dashboard snapshot, the
 * free flow and ranked goals, the plan and the desk's outlook. Each is registered to answer differently the second time.
 */
async function openEverything(page: Page, extra: ApiRoute[] = []): Promise<ApiMock> {
  await mockHousehold(page, household)
  const api = await addRoutes(page, [
    ...householdViewRoutes(household),
    ...wishlistRoutes(
      sequenceRoute<WishlistPlan>('GET', PLAN_PATH, [{ body: PLAN_OK }, { body: PLAN_AFTER_WRITE }]),
      ITEMS,
      [sequenceRoute<WishlistOutlook>('GET', outlookPath(IDS.desk), [{ body: outlookOf(ITEM_BY_ID(IDS.desk), 18000) }, { body: overBudget() }])],
    ),
    sequenceRoute<DashboardSnapshot>('GET', SNAPSHOT_PATH, [{ body: SNAPSHOT_BEFORE }, { body: SNAPSHOT_AFTER }]),
    sequenceRoute<WishlistFreeFlow>('GET', FLOW_PATH, [{ body: COVERED }, { body: SHORT_BY_500 }]),
    ...extra,
  ])
  await page.goto('/')
  await expect(leadingFigure(page)).toHaveText('₱48,200.00', { timeout: 15_000 })
  await goTo(page, 'nav-allocations', 'Allocations')
  await page.getByRole('button', { name: 'Savings', exact: true }).click()
  await expect(page.getByTestId('ranked-goal-pace').first()).toBeVisible()
  await page.getByRole('button', { name: 'Wishlist', exact: true }).click()
  await expect(figureValue(page, 'net')).toHaveText('₱60,000.00')
  await expect(cardOf(page, IDS.desk).getByTestId('budget-badge')).toHaveText('Fits your monthly budget')
  await page.waitForLoadState('networkidle')
  for (const path of [SNAPSHOT_PATH, PLAN_PATH, FLOW_PATH, outlookPath(IDS.desk)]) {
    expect(api.count('GET', path), `${path} is read once before the write`).toBe(1)
  }
  return api
}

/** Back on the Wishlist tab by following links, so what the store holds is kept. */
async function visitWishlistTab(page: Page): Promise<void> {
  await goTo(page, 'nav-allocations', 'Allocations')
  await page.getByRole('button', { name: 'Wishlist', exact: true }).click()
}

/** The desk's outlook after a write: its price no longer fits the month. */
function overBudget(): WishlistOutlook {
  const desk = ITEM_BY_ID(IDS.desk)
  const fits = outlookOf(desk, 18000)
  return { ...fits, disposable_check: { ...fits.disposable_check, status: 'over', available: 5000 } }
}

/** Follows a nav link without reloading the page, so the store keeps what it holds. */
async function goTo(page: Page, marker: string, title: string): Promise<void> {
  await page.locator(`[data-onboarding="${marker}"]:visible`).first().click()
  await expect(page.locator('main h1').first()).toHaveText(title)
}
