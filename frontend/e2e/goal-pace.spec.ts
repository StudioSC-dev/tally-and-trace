import { expect, test } from '@playwright/test'
import type { Locator, Page } from '@playwright/test'
import type { Allocation, WishlistFreeFlow } from '@tally-trace/shared'
import { household, householdViewRoutes, householdWishlistRoutes, mockHousehold, rankedGoals } from './support/fixtures/household'
import type { HouseholdData } from './support/fixtures/household'
import {
  AFTER_EMERGENCY_TARGET_CUT,
  COVERED,
  CROSS_CURRENCY,
  GOAL_IDS,
  NOT_ESTIMATED,
  SHORT_BY_4000,
  SHORT_BY_4000_CAR_UP,
  SHORT_BY_500,
  WITH_OVERDUE,
  withDollarGoal,
} from './support/fixtures/freeFlow'
import { addRoutes, apiRoute, sequenceRoute } from './support/mockApi'
import type { ApiMock, ApiRoute } from './support/mockApi'
import { shot } from './support/shot'

// STU-790: each ranked savings goal on the Savings tab shows its monthly pace from GET /wishlist/free-flow, in the goal's
// own currency, and an underfunded flag with the uncovered amount when net flow does not cover its top-up. The API decides
// which goal gives way; the page shows what it answers. A goal past its date reads Overdue, a goal whose top-up cannot be
// placed reads Unreserved, and a caller with no estimate (two currencies, or no full month of history) sees the note
// instead of any pace or flag. Allocation writes and reorders read the free flow again. The API is faked in the browser.

test.use({ locale: 'en-US' })

const data: HouseholdData = withDollarGoal(household)
const GOALS = rankedGoals(data.allocations)
const nameOf = (id: number): string => {
  const goal = GOALS.find((g) => g.id === id)
  if (!goal) throw new Error(`no ranked goal ${id}`)
  return goal.name
}
const EMERGENCY = nameOf(GOAL_IDS.emergency)
const JAPAN = nameOf(GOAL_IDS.japan)
const LAPTOP = nameOf(GOAL_IDS.laptop)
const GIFTS = nameOf(GOAL_IDS.gifts)
const CAR = nameOf(GOAL_IDS.car)
const ALL = [EMERGENCY, JAPAN, LAPTOP, GIFTS, CAR]

const FLOW_PATH = '/wishlist/free-flow'
const INCOMPLETE_NOTE = 'Money in more than one currency is involved, so this cannot be estimated yet.'
const NO_HISTORY_NOTE = 'Monthly pace shows once you have one full month of history.'

/** Opens the Savings tab with `routes` answering after the household's own, and waits for the section to settle. */
async function open(page: Page, ...routes: ApiRoute[]): Promise<ApiMock> {
  await mockHousehold(page, data)
  const api = await addRoutes(page, [...householdViewRoutes(data), ...householdWishlistRoutes(), ...routes])
  await page.goto('/allocations?tab=savings')
  await expect(page.getByRole('heading', { level: 1, name: 'Allocations' })).toBeVisible({ timeout: 15_000 })
  await expect(page.getByTestId('ranked-goal')).toHaveCount(ALL.length)
  await page.waitForLoadState('networkidle')
  return api
}

const flowRoute = (flow: WishlistFreeFlow): ApiRoute => apiRoute<WishlistFreeFlow>('GET', FLOW_PATH, flow)
const row = (page: Page, name: string): Locator => page.getByTestId('ranked-goal').filter({ has: page.getByText(name, { exact: true }) })
const paceOf = (page: Page, name: string): Locator => row(page, name).getByTestId('ranked-goal-pace')
const flagOf = (page: Page, name: string): Locator => row(page, name).getByTestId('ranked-goal-underfunded')
const flags = (page: Page): Locator => page.getByTestId('ranked-goal-underfunded')

/** The ranked list as the API answers it after a reorder, for `PUT /allocations/ranked`. */
const rankedAfter = (order: number[]): ApiRoute =>
  apiRoute<{ items: Allocation[] }>('PUT', '/allocations/ranked', {
    items: order.flatMap((id, index) => {
      const goal = GOALS.find((g) => g.id === id)
      return goal ? [{ ...goal, rank: index + 1 }] : []
    }),
  })

test.describe('goal pace and underfunded flag (STU-790)', () => {
  test('AC1: each goal shows its monthly pace from GET /wishlist/free-flow, in its own currency', async ({ page }) => {
    const api = await open(page, flowRoute(COVERED))
    expect(api.count('GET', FLOW_PATH)).toBeGreaterThan(0)
    await expect(paceOf(page, EMERGENCY)).toHaveText('Needs ₱10,000.00 a month')
    await expect(paceOf(page, LAPTOP)).toHaveText('Needs ₱6,000.00 a month')
    await expect(paceOf(page, GIFTS)).toHaveText('Needs ₱2,000.00 a month')
    await expect(paceOf(page, CAR)).toHaveText('Needs ₱2,500.00 a month')
    // The Japan trip is a dollar goal: its pace is in dollars, never converted to pesos.
    await expect(paceOf(page, JAPAN)).toHaveText('Needs $800.00 a month')
    await expect(page.getByTestId('ranked-goal-pace')).toHaveCount(ALL.length)
    await expect(page.getByTestId('ranked-goals-flow-note')).toHaveCount(0)
    await shot(page, 'pace')
  })

  test('AC1: a goal that needs nothing this month says so, and a goal the API does not list shows no pace', async ({ page }) => {
    const reached: WishlistFreeFlow = {
      ...COVERED,
      goals: COVERED.goals.filter((g) => g.allocation_id !== GOAL_IDS.car).map((g) => (g.allocation_id === GOAL_IDS.gifts ? { ...g, pace: 0, top_up: 0 } : g)),
    }
    await open(page, flowRoute(reached))
    await expect(paceOf(page, GIFTS)).toHaveText('No monthly saving needed')
    await expect(row(page, CAR).getByTestId('ranked-goal-flow')).toHaveCount(0)
  })

  test('AC2: a small shortfall flags only the lowest-ranked goal, with the amount it is short', async ({ page }) => {
    await open(page, flowRoute(SHORT_BY_500))
    await expect(flags(page)).toHaveCount(1)
    await expect(flagOf(page, CAR)).toHaveText('Underfunded by ₱500.00 a month')
    for (const name of [EMERGENCY, JAPAN, LAPTOP, GIFTS]) await expect(flagOf(page, name)).toHaveCount(0)
    // The pace still shows beside the flag.
    await expect(paceOf(page, CAR)).toHaveText('Needs ₱2,500.00 a month')
    await shot(page, 'underfunded-one')
  })

  test('AC2: a larger shortfall flags the lowest-ranked goal first, then the next one up', async ({ page }) => {
    await open(page, flowRoute(SHORT_BY_4000))
    await expect(flags(page)).toHaveCount(2)
    await expect(flagOf(page, CAR)).toHaveText('Underfunded by ₱2,500.00 a month')
    await expect(flagOf(page, GIFTS)).toHaveText('Underfunded by ₱1,500.00 a month')
    for (const name of [EMERGENCY, JAPAN, LAPTOP]) await expect(flagOf(page, name)).toHaveCount(0)
    // The goals above the flagged ones are covered, and nothing marks them.
    const order = await page.getByTestId('ranked-goal').evaluateAll((all) => all.map((r) => r.getAttribute('data-goal-id')))
    expect(order).toEqual(ALL.map((n) => String(GOALS.find((g) => g.name === n)?.id)))
    await shot(page, 'underfunded-two')
  })

  test('AC2: no goal is flagged when every top-up is covered', async ({ page }) => {
    await open(page, flowRoute(COVERED))
    await expect(flags(page)).toHaveCount(0)
  })

  test('AC3: an overdue goal is labelled Overdue, and the others are not', async ({ page }) => {
    await open(page, flowRoute(WITH_OVERDUE))
    await expect(row(page, LAPTOP).getByTestId('ranked-goal-overdue')).toHaveText('Overdue')
    await expect(page.getByTestId('ranked-goal-overdue')).toHaveCount(1)
    await expect(paceOf(page, LAPTOP)).toHaveText('Needs ₱43,200.00 a month')
    await shot(page, 'overdue')
  })

  test('AC3: a goal whose top-up cannot be placed is labelled Unreserved, and the others are not', async ({ page }) => {
    await open(page, flowRoute(CROSS_CURRENCY))
    await expect(row(page, JAPAN).getByTestId('ranked-goal-unreserved')).toHaveText('Unreserved')
    await expect(page.getByTestId('ranked-goal-unreserved')).toHaveCount(1)
    await shot(page, 'unreserved')
  })

  test('AC4: a caller with money in more than one currency sees no pace or flag, and the note', async ({ page }) => {
    await open(page, flowRoute(CROSS_CURRENCY))
    await expect(page.getByTestId('ranked-goals-flow-note')).toHaveText(INCOMPLETE_NOTE)
    await expect(page.getByTestId('ranked-goal-pace')).toHaveCount(0)
    await expect(flags(page)).toHaveCount(0)
    await expect(page.getByTestId('ranked-goal')).toHaveCount(ALL.length)
    await shot(page, 'cross-currency')
  })

  test('AC4: a user with no full month of history sees no pace or flag, and the note', async ({ page }) => {
    await open(page, flowRoute(NOT_ESTIMATED))
    await expect(page.getByTestId('ranked-goals-flow-note')).toHaveText(NO_HISTORY_NOTE)
    await expect(page.getByTestId('ranked-goal-pace')).toHaveCount(0)
    await expect(flags(page)).toHaveCount(0)
    await expect(page.getByTestId('ranked-goal-unreserved')).toHaveCount(0)
    await expect(page.getByTestId('ranked-goal-overdue')).toHaveCount(0)
    await shot(page, 'not-estimated')
  })

  test('AC5: a reorder reads the free flow again and the flags follow the new order', async ({ page }) => {
    const order = [GOAL_IDS.emergency, GOAL_IDS.japan, GOAL_IDS.laptop, GOAL_IDS.car, GOAL_IDS.gifts]
    const api = await open(
      page,
      sequenceRoute<WishlistFreeFlow>('GET', FLOW_PATH, [{ body: SHORT_BY_4000 }, { body: SHORT_BY_4000_CAR_UP }]),
      rankedAfter(order),
    )
    await expect(flagOf(page, GIFTS)).toHaveText('Underfunded by ₱1,500.00 a month')
    await expect.poll(() => api.count('GET', FLOW_PATH)).toBe(1)
    await page.getByRole('button', { name: `Move ${CAR} up`, exact: true }).click()
    await expect.poll(() => api.count('GET', FLOW_PATH)).toBe(2)
    await expect(flagOf(page, CAR)).toHaveText('Underfunded by ₱2,000.00 a month')
    await expect(flagOf(page, GIFTS)).toHaveText('Underfunded by ₱2,000.00 a month')
    expect(api.bodies('PUT', '/allocations/ranked')).toEqual([{ ids: order }])
    await shot(page, 'after-reorder')
  })

  test('AC5: an allocation write reads the free flow again', async ({ page }) => {
    const japan = GOALS.find((g) => g.id === GOAL_IDS.japan)
    if (!japan) throw new Error('no Japan trip goal')
    const api = await open(
      page,
      sequenceRoute<WishlistFreeFlow>('GET', FLOW_PATH, [{ body: SHORT_BY_4000_CAR_UP }, { body: AFTER_EMERGENCY_TARGET_CUT }]),
      apiRoute<Allocation>('PUT', `/allocations/${GOAL_IDS.japan}`, { ...japan, is_active: false }),
    )
    await expect(paceOf(page, EMERGENCY)).toHaveText('Needs ₱10,000.00 a month')
    await expect.poll(() => api.count('GET', FLOW_PATH)).toBe(1)
    await row(page, JAPAN).locator('article[role="button"]').click()
    await page.getByRole('button', { name: 'Pause allocation' }).click()
    await expect.poll(() => api.count('GET', FLOW_PATH)).toBe(2)
    await expect(paceOf(page, EMERGENCY)).toHaveText('Needs ₱9,000.00 a month')
    await expect(flagOf(page, CAR)).toHaveText('Underfunded by ₱1,000.00 a month')
    expect(api.bodies('PUT', `/allocations/${GOAL_IDS.japan}`)).toHaveLength(1)
  })
})
