import { expect, test } from '@playwright/test'
import type { Locator, Page } from '@playwright/test'
import type { Allocation, WishlistFreeFlow } from '@tally-trace/shared'
import { household, householdViewRoutes, householdWishlistRoutes, mockHousehold, rankedGoals } from './support/fixtures/household'
import type { HouseholdData } from './support/fixtures/household'
import {
  COVERED,
  CROSS_CURRENCY,
  flowForGoals,
  GOAL_IDS,
  NEW_GOAL_ID,
  NOT_ESTIMATED,
  PHP_ONLY_UNRESERVED,
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
const NO_INCOME_NOTE = 'A goal needs saving in PHP, but there is no PHP income to reserve it from, so this cannot be estimated yet.'
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
    await expect(paceOf(page, EMERGENCY)).toBeVisible()
    await expect(paceOf(page, EMERGENCY)).toHaveText('Needs ₱10,000.00 a month')
    await expect(paceOf(page, LAPTOP)).toBeVisible()
    await expect(paceOf(page, LAPTOP)).toHaveText('Needs ₱6,000.00 a month')
    await expect(paceOf(page, GIFTS)).toBeVisible()
    await expect(paceOf(page, GIFTS)).toHaveText('Needs ₱2,000.00 a month')
    await expect(paceOf(page, CAR)).toBeVisible()
    await expect(paceOf(page, CAR)).toHaveText('Needs ₱2,500.00 a month')
    // The Japan trip is a dollar goal: its pace is in dollars, never converted to pesos.
    await expect(paceOf(page, JAPAN)).toBeVisible()
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
    await expect(paceOf(page, GIFTS)).toBeVisible()
    await expect(paceOf(page, GIFTS)).toHaveText('No monthly saving needed')
    await expect(row(page, CAR).getByTestId('ranked-goal-flow')).toHaveCount(0)
  })

  test('AC2: a small shortfall flags only the lowest-ranked goal, with the amount it is short', async ({ page }) => {
    await open(page, flowRoute(SHORT_BY_500))
    await expect(flags(page)).toHaveCount(1)
    await expect(flagOf(page, CAR)).toBeVisible()
    await expect(flagOf(page, CAR)).toHaveText('Underfunded by ₱500.00 a month')
    await expect(flagOf(page, CAR)).toHaveAttribute('data-status', 'warn')
    for (const name of [EMERGENCY, JAPAN, LAPTOP, GIFTS]) await expect(flagOf(page, name)).toHaveCount(0)
    // The pace still shows beside the flag.
    await expect(paceOf(page, CAR)).toBeVisible()
    await expect(paceOf(page, CAR)).toHaveText('Needs ₱2,500.00 a month')
    await shot(page, 'underfunded-one')
  })

  test('AC2: a larger shortfall flags the lowest-ranked goal first, then the next one up', async ({ page }) => {
    await open(page, flowRoute(SHORT_BY_4000))
    await expect(flags(page)).toHaveCount(2)
    await expect(flagOf(page, CAR)).toBeVisible()
    await expect(flagOf(page, CAR)).toHaveText('Underfunded by ₱2,500.00 a month')
    await expect(flagOf(page, CAR)).toHaveAttribute('data-status', 'warn')
    await expect(flagOf(page, GIFTS)).toBeVisible()
    await expect(flagOf(page, GIFTS)).toHaveText('Underfunded by ₱1,500.00 a month')
    await expect(flagOf(page, GIFTS)).toHaveAttribute('data-status', 'warn')
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
    await expect(row(page, LAPTOP).getByTestId('ranked-goal-overdue')).toBeVisible()
    await expect(row(page, LAPTOP).getByTestId('ranked-goal-overdue')).toHaveText('Overdue')
    await expect(row(page, LAPTOP).getByTestId('ranked-goal-overdue')).toHaveAttribute('data-status', 'danger')
    await expect(page.getByTestId('ranked-goal-overdue')).toHaveCount(1)
    await expect(paceOf(page, LAPTOP)).toBeVisible()
    await expect(paceOf(page, LAPTOP)).toHaveText('Needs ₱43,200.00 a month')
    await shot(page, 'overdue')
  })

  test('AC3: a goal whose top-up cannot be placed is labelled Unreserved, and the others are not', async ({ page }) => {
    await open(page, flowRoute(CROSS_CURRENCY))
    await expect(row(page, JAPAN).getByTestId('ranked-goal-unreserved')).toBeVisible()
    await expect(row(page, JAPAN).getByTestId('ranked-goal-unreserved')).toHaveText('Unreserved')
    await expect(row(page, JAPAN).getByTestId('ranked-goal-unreserved')).toHaveAttribute('data-status', 'warn')
    await expect(page.getByTestId('ranked-goal-unreserved')).toHaveCount(1)
    await shot(page, 'unreserved')
  })

  test('AC4: a caller with money in more than one currency sees no pace or flag, and the note', async ({ page }) => {
    await open(page, flowRoute(CROSS_CURRENCY))
    await expect(page.getByTestId('ranked-goals-flow-note')).toBeVisible()
    await expect(page.getByTestId('ranked-goals-flow-note')).toHaveText(INCOMPLETE_NOTE)
    await expect(page.getByTestId('ranked-goal-pace')).toHaveCount(0)
    await expect(flags(page)).toHaveCount(0)
    await expect(page.getByTestId('ranked-goal')).toHaveCount(ALL.length)
    await shot(page, 'cross-currency')
  })

  test('AC4: a single-currency caller with an unreserved goal is told about the missing income, not a second currency', async ({ page }) => {
    await open(page, flowRoute(PHP_ONLY_UNRESERVED))
    await expect(page.getByTestId('ranked-goals-flow-note')).toBeVisible()
    await expect(page.getByTestId('ranked-goals-flow-note')).toHaveText(NO_INCOME_NOTE)
    await expect(page.getByTestId('ranked-goals-flow-note')).not.toContainText('more than one currency')
    await expect(row(page, EMERGENCY).getByTestId('ranked-goal-unreserved')).toBeVisible()
    await expect(row(page, EMERGENCY).getByTestId('ranked-goal-unreserved')).toHaveText('Unreserved')
    await expect(row(page, EMERGENCY).getByTestId('ranked-goal-unreserved')).toHaveAttribute('data-status', 'warn')
    await expect(page.getByTestId('ranked-goal-pace')).toHaveCount(0)
    await expect(flags(page)).toHaveCount(0)
  })

  test('AC4: a user with no full month of history sees no pace or flag, and the note', async ({ page }) => {
    await open(page, flowRoute(NOT_ESTIMATED))
    await expect(page.getByTestId('ranked-goals-flow-note')).toBeVisible()
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
    await expect(flagOf(page, GIFTS)).toBeVisible()
    await expect(flagOf(page, GIFTS)).toHaveText('Underfunded by ₱1,500.00 a month')
    await expect(flagOf(page, GIFTS)).toHaveAttribute('data-status', 'warn')
    await expect.poll(() => api.count('GET', FLOW_PATH)).toBe(1)
    await page.getByRole('button', { name: `Move ${CAR} up`, exact: true }).click()
    await expect.poll(() => api.count('GET', FLOW_PATH)).toBe(2)
    await expect(flagOf(page, CAR)).toBeVisible()
    await expect(flagOf(page, CAR)).toHaveText('Underfunded by ₱2,000.00 a month')
    await expect(flagOf(page, CAR)).toHaveAttribute('data-status', 'warn')
    await expect(flagOf(page, GIFTS)).toBeVisible()
    await expect(flagOf(page, GIFTS)).toHaveText('Underfunded by ₱2,000.00 a month')
    await expect(flagOf(page, GIFTS)).toHaveAttribute('data-status', 'warn')
    expect(api.bodies('PUT', '/allocations/ranked')).toEqual([{ ids: order }])
    await shot(page, 'after-reorder')
  })

  /**
   * The Savings tab with a stateful fake of the ranked goals and the free flow: a pause, delete or create changes the
   * goals the fake holds, and the free flow it answers next is worked out from them (`flowForGoals`).
   */
  async function openWithWrites(page: Page): Promise<ApiMock> {
    const held: Allocation[] = GOALS.map((g) => ({ ...g }))
    const live = (method: ApiRoute['method'], path: string, respond: () => unknown, status = 200): ApiRoute => ({ method, path, status, body: {}, respond })
    const without = (id: number): Allocation | undefined => {
      const index = held.findIndex((g) => g.id === id)
      return index < 0 ? undefined : held.splice(index, 1)[0]
    }
    const created: Allocation = { ...GOALS[0], id: NEW_GOAL_ID, name: 'Wedding fund', currency: 'PHP', is_active: true }
    return open(
      page,
      live('GET', '/allocations/ranked', () => ({ items: held.map((g, index) => ({ ...g, rank: index + 1 })) })),
      live('GET', FLOW_PATH, () => flowForGoals(held)),
      live('PUT', `/allocations/${GOAL_IDS.gifts}`, () => ({ ...without(GOAL_IDS.gifts), is_active: false })),
      live('DELETE', `/allocations/${GOAL_IDS.laptop}`, () => {
        without(GOAL_IDS.laptop)
        return { message: 'Allocation deleted successfully' }
      }),
      live('POST', '/allocations/', () => {
        held.push(created)
        return created
      }, 201),
    )
  }

  test('AC5: pausing a goal reads the free flow again, and the paused goal leaves it', async ({ page }) => {
    const api = await openWithWrites(page)
    await expect(flagOf(page, GIFTS)).toBeVisible()
    await expect(flagOf(page, GIFTS)).toHaveText('Underfunded by ₱1,500.00 a month')
    await expect(flagOf(page, GIFTS)).toHaveAttribute('data-status', 'warn')
    await expect(flagOf(page, CAR)).toBeVisible()
    await expect(flagOf(page, CAR)).toHaveText('Underfunded by ₱2,500.00 a month')
    await expect(flagOf(page, CAR)).toHaveAttribute('data-status', 'warn')
    await expect.poll(() => api.count('GET', FLOW_PATH)).toBe(1)
    await row(page, GIFTS).locator('article[role="button"]').click()
    await page.getByRole('button', { name: 'Pause allocation' }).click()
    await expect.poll(() => api.count('GET', FLOW_PATH)).toBeGreaterThanOrEqual(2)
    // The gifts no longer hold back the car: it now gets the 500 pesos left over.
    await expect(row(page, GIFTS)).toHaveCount(0)
    await expect(flagOf(page, CAR)).toBeVisible()
    await expect(flagOf(page, CAR)).toHaveText('Underfunded by ₱2,000.00 a month')
    await expect(flagOf(page, CAR)).toHaveAttribute('data-status', 'warn')
    await expect(flags(page)).toHaveCount(1)
    expect(api.bodies('PUT', `/allocations/${GOAL_IDS.gifts}`)).toHaveLength(1)
  })

  test('AC5: deleting a goal reads the free flow again, and the goals below it are covered', async ({ page }) => {
    const api = await openWithWrites(page)
    await expect(flags(page)).toHaveCount(2)
    await expect.poll(() => api.count('GET', FLOW_PATH)).toBe(1)
    await row(page, LAPTOP).locator('article[role="button"]').click()
    await page.getByRole('button', { name: 'Delete allocation' }).click()
    await page.getByTestId('confirm-dialog-confirm').click()
    await expect.poll(() => api.count('GET', FLOW_PATH)).toBeGreaterThanOrEqual(2)
    await expect(row(page, LAPTOP)).toHaveCount(0)
    // Without the laptop's 6,000, the gifts and the car fit.
    await expect(flags(page)).toHaveCount(0)
    await expect(paceOf(page, CAR)).toBeVisible()
    await expect(paceOf(page, CAR)).toHaveText('Needs ₱2,500.00 a month')
  })

  test('AC5: creating a goal reads the free flow again, and the new goal gets its pace at the bottom', async ({ page }) => {
    const api = await openWithWrites(page)
    await expect.poll(() => api.count('GET', FLOW_PATH)).toBe(1)
    await page.getByRole('button', { name: 'Add allocation' }).click()
    const form = page.locator('form').filter({ has: page.getByRole('button', { name: 'Create savings tracker' }) })
    await form.locator('[data-field="name"]').fill('Wedding fund')
    const savingsAccount = household.accounts.find((a) => a.account_type === 'savings' && a.my_role === 'owner')
    if (!savingsAccount) throw new Error('the household has no savings account of its own')
    await form.locator('[data-field="account_id"]').selectOption(String(savingsAccount.id))
    await form.getByRole('button', { name: 'Create savings tracker' }).click()
    await expect.poll(() => api.count('GET', FLOW_PATH)).toBeGreaterThanOrEqual(2)
    await expect(page.getByTestId('ranked-goal')).toHaveCount(ALL.length + 1)
    // Only the new read knows the new goal: its pace and the shortfall it adds.
    await expect(paceOf(page, 'Wedding fund')).toBeVisible()
    await expect(paceOf(page, 'Wedding fund')).toHaveText('Needs ₱1,500.00 a month')
    await expect(flagOf(page, 'Wedding fund')).toBeVisible()
    await expect(flagOf(page, 'Wedding fund')).toHaveText('Underfunded by ₱1,500.00 a month')
    await expect(flagOf(page, 'Wedding fund')).toHaveAttribute('data-status', 'warn')
    await expect(flags(page)).toHaveCount(3)
  })
})
