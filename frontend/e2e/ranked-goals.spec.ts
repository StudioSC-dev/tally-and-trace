import { expect, test } from '@playwright/test'
import type { Locator, Page, Route } from '@playwright/test'
import type { Allocation } from '@tally-trace/shared'
import { household, householdViewRoutes, householdWishlistRoutes, mockHousehold, rankedGoals } from './support/fixtures/household'
import { addRoutes } from './support/mockApi'
import { shot } from './support/shot'

// STU-787: the Savings tab's "Savings goals" section. The user's ranked goals sit in rank order above the paged list;
// a goal moves by pointer drag or by its move-up and move-down buttons, and each move sends the complete order.
// The API is faked in the browser, with a small stateful stand-in for the ranking routes (GET and PUT
// /allocations/ranked, the paged GET, and the create, pause and delete calls that change who is ranked); there is no
// backend. The stand-in can hold a reorder or a ranked read until the test releases it, so a test can act while a
// request is still in flight.

test.use({ locale: 'en-US' })

const [EMERGENCY, JAPAN, LAPTOP, GIFTS, CAR] = rankedGoals(household.allocations)
const START = [EMERGENCY, JAPAN, LAPTOP, GIFTS, CAR]
const START_NAMES = START.map((g) => g.name)
const START_IDS = START.map((g) => g.id)
const NEW_GOAL_ID = 90
/** A refusal as the API words one: a 422 with a string `detail`. */
const REFUSAL = 'ids must list every ranked goal exactly once'

/** A request the fake is holding until the test lets it answer. */
interface Held {
  release: () => void
}

interface Fake {
  /** The PUT /allocations/ranked bodies, in order. */
  puts: unknown[]
  /** The query strings of every paged GET /allocations/, in order. */
  pagedQueries: string[]
  /** How many GET /allocations/ranked calls were made. */
  rankedGets: () => number
  /**
   * Holds the next PUT /allocations/ranked. `commit` applies the order when the request arrives and answers 200 with
   * the list as it was then; `refuse` answers 422 and applies nothing. The answer goes out on `release()`.
   */
  holdNextReorder: (kind: 'commit' | 'refuse') => Held
  /** Holds the next GET /allocations/ranked: it reads the list when it arrives and answers on `release()`. */
  holdNextRankedGet: () => Held
}

const hold = (): { held: Held; wait: Promise<void> } => {
  let release = (): void => undefined
  const wait = new Promise<void>((resolve) => {
    release = resolve
  })
  return { held: { release }, wait }
}

/** The ranking routes, answering from one list so a reorder, create, pause or delete shows on the next GET. */
async function fakeRanking(page: Page, extra: Allocation[] = []): Promise<Fake> {
  const all: Allocation[] = [...household.allocations.map((a) => ({ ...a })), ...extra]
  let order: number[] = [...START_IDS]
  let rankedGets = 0
  const reorderQueue: { kind: 'commit' | 'refuse'; wait: Promise<void> }[] = []
  const rankedQueue: Promise<void>[] = []
  const fake: Fake = {
    puts: [],
    pagedQueries: [],
    rankedGets: () => rankedGets,
    holdNextReorder: (kind) => {
      const { held, wait } = hold()
      reorderQueue.push({ kind, wait })
      return held
    },
    holdNextRankedGet: () => {
      const { held, wait } = hold()
      rankedQueue.push(wait)
      return held
    },
  }

  const ranked = (): Allocation[] =>
    order.flatMap((id, index) => {
      const goal = all.find((a) => a.id === id)
      return goal ? [{ ...goal, rank: index + 1 }] : []
    })
  const json = (route: Route, status: number, body: unknown) =>
    route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) })

  await page.route('**/api/v1/allocations/**', async (route) => {
    const request = route.request()
    const url = new URL(request.url())
    const path = url.pathname.replace('/api/v1', '')
    const method = request.method()
    const idMatch = /^\/allocations\/(\d+)$/.exec(path)
    if (path === '/allocations/ranked' && method === 'GET') {
      rankedGets += 1
      const snapshot = ranked()
      const wait = rankedQueue.shift()
      if (wait) await wait
      return json(route, 200, { items: snapshot })
    }
    if (path === '/allocations/ranked' && method === 'PUT') {
      const body = request.postDataJSON() as { ids: number[] }
      fake.puts.push(body)
      const held = reorderQueue.shift()
      if (!held) {
        order = [...body.ids]
        return json(route, 200, { items: ranked() })
      }
      if (held.kind === 'commit') order = [...body.ids]
      const snapshot = ranked()
      await held.wait
      if (held.kind === 'refuse') return json(route, 422, { detail: REFUSAL })
      return json(route, 200, { items: snapshot })
    }
    if (path === '/allocations/' && method === 'GET') {
      fake.pagedQueries.push(url.search)
      const rest = url.searchParams.get('ranked') === 'false' ? all.filter((a) => !order.includes(a.id)) : all
      const limit = Number(url.searchParams.get('limit') ?? rest.length)
      const offset = Number(url.searchParams.get('offset') ?? 0)
      const items = rest.slice(offset, offset + limit)
      return json(route, 200, { items, total: rest.length, has_more: offset + items.length < rest.length })
    }
    if (path === '/allocations/' && method === 'POST') {
      const body = request.postDataJSON() as Partial<Allocation>
      const created = { ...START[0], ...body, id: NEW_GOAL_ID, is_active: true } as Allocation
      all.push(created)
      order = [...order, created.id]
      return json(route, 201, created)
    }
    if (idMatch && method === 'PUT') {
      const id = Number(idMatch[1])
      const body = request.postDataJSON() as Partial<Allocation>
      const goal = all.find((a) => a.id === id)
      if (!goal) return json(route, 404, { detail: 'Allocation not found' })
      Object.assign(goal, body)
      order = goal.is_active ? (order.includes(id) ? order : [...order, id]) : order.filter((x) => x !== id)
      return json(route, 200, goal)
    }
    if (idMatch && method === 'DELETE') {
      const id = Number(idMatch[1])
      const goal = all.find((a) => a.id === id)
      if (goal) goal.is_active = false
      order = order.filter((x) => x !== id)
      return json(route, 200, { message: 'Allocation deleted successfully' })
    }
    return route.fallback()
  })
  return fake
}

async function open(page: Page, extra: Allocation[] = []): Promise<Fake> {
  await mockHousehold(page, household)
  await addRoutes(page, [...householdViewRoutes(household), ...householdWishlistRoutes()])
  const fake = await fakeRanking(page, extra)
  await page.goto('/allocations?tab=savings')
  await expect(page.getByRole('heading', { level: 1, name: 'Allocations' })).toBeVisible({ timeout: 15_000 })
  await expect(page.getByTestId('ranked-goals')).toBeVisible()
  await expect(page.getByTestId('ranked-goal')).toHaveCount(START.length)
  await page.waitForLoadState('networkidle')
  return fake
}

const rows = (page: Page): Locator => page.getByTestId('ranked-goal')
const namesOf = (page: Page): Promise<string[]> =>
  rows(page).evaluateAll((all) => all.map((row) => row.querySelector('p.font-semibold')?.textContent?.trim() ?? ''))
const rowOf = (page: Page, name: string): Locator => rows(page).filter({ has: page.getByText(name, { exact: true }) })
const handleOf = (page: Page, name: string): Locator => rowOf(page, name).getByTestId('ranked-goal-handle')
const upOf = (page: Page, name: string): Locator => page.getByRole('button', { name: `Move ${name} up`, exact: true })
const downOf = (page: Page, name: string): Locator => page.getByRole('button', { name: `Move ${name} down`, exact: true })
const tab = (page: Page, name: 'Budgets' | 'Savings'): Locator => page.getByRole('button', { name, exact: true })

/**
 * Drags a goal's handle with real pointer events: into the top half of the goal's row `onto` (to go above it) or the
 * bottom half (to go below it). The two rows are adjacent, so both fit on a phone's screen.
 */
async function drag(page: Page, from: string, onto: string, half: 'top' | 'bottom' = 'top'): Promise<void> {
  await handleOf(page, from).scrollIntoViewIfNeeded()
  const start = await handleOf(page, from).boundingBox()
  const target = await rowOf(page, onto).boundingBox()
  if (!start || !target) throw new Error('no box to drag between')
  const x = start.x + start.width / 2
  await page.mouse.move(x, start.y + start.height / 2)
  await page.mouse.down()
  await page.mouse.move(x, half === 'top' ? target.y + 4 : target.y + target.height - 4, { steps: 12 })
  await page.mouse.up()
}

/** Adds a savings goal through the create form. */
async function createGoal(page: Page, name: string): Promise<void> {
  await page.getByRole('button', { name: 'Add allocation' }).click()
  const form = page.locator('form').filter({ has: page.getByRole('button', { name: 'Create savings tracker' }) })
  await form.locator('[data-field="name"]').fill(name)
  const savingsAccount = household.accounts.find((a) => a.account_type === 'savings' && a.my_role === 'owner')
  if (!savingsAccount) throw new Error('the household has no savings account of its own')
  await form.locator('[data-field="account_id"]').selectOption(String(savingsAccount.id))
  await form.getByRole('button', { name: 'Create savings tracker' }).click()
}

test.describe('ranked savings goals (STU-787)', () => {
  test('AC1: the Savings goals section lists every ranked goal in rank order from GET /allocations/ranked', async ({ page }) => {
    const fake = await open(page)
    await expect(page.getByTestId('ranked-goals').getByRole('heading', { name: 'Savings goals', level: 2 })).toBeVisible()
    expect(fake.rankedGets()).toBeGreaterThan(0)
    expect(await namesOf(page)).toEqual(START_NAMES)
    await expect(rows(page).first()).toHaveAttribute('data-rank', '1')
    await expect(rows(page).last()).toHaveAttribute('data-rank', String(START.length))
    // The section sits above the paged list.
    const section = await page.getByTestId('ranked-goals').boundingBox()
    const list = await page.getByRole('heading', { name: 'Savings & investment targets' }).boundingBox()
    expect(section && list && section.y < list.y, 'the ranked section is above the paged list').toBe(true)
    await shot(page, 'section')
  })

  test('AC2: the paged list asks for ranked=false and does not repeat a ranked goal', async ({ page }) => {
    const fake = await open(page)
    expect(fake.pagedQueries.length).toBeGreaterThan(0)
    for (const query of fake.pagedQueries) expect(new URLSearchParams(query).get('ranked')).toBe('false')
    // Each ranked goal shows once on the page: in the section, not again in the paged list.
    for (const name of START_NAMES) await expect(page.locator('main').getByText(name, { exact: true })).toHaveCount(1)
    await expect(page.getByTestId('ranked-goals').getByText(EMERGENCY.name, { exact: true })).toHaveCount(1)
  })

  test('AC3: a goal moves with the move-up and move-down buttons', async ({ page }) => {
    const fake = await open(page)
    await upOf(page, LAPTOP.name).click()
    await expect.poll(() => namesOf(page)).toEqual([EMERGENCY.name, LAPTOP.name, JAPAN.name, GIFTS.name, CAR.name])
    await downOf(page, EMERGENCY.name).click()
    await expect.poll(() => namesOf(page)).toEqual([LAPTOP.name, EMERGENCY.name, JAPAN.name, GIFTS.name, CAR.name])
    expect(fake.puts).toEqual([
      { ids: [EMERGENCY.id, LAPTOP.id, JAPAN.id, GIFTS.id, CAR.id] },
      { ids: [LAPTOP.id, EMERGENCY.id, JAPAN.id, GIFTS.id, CAR.id] },
    ])
  })

  test('AC3: the move buttons are reachable and work from the keyboard, and the ends do not move', async ({ page }) => {
    const fake = await open(page)
    // Reached by Tab from the page: the first row's down button comes after its up button.
    await upOf(page, EMERGENCY.name).focus()
    await page.keyboard.press('Tab')
    await expect(downOf(page, EMERGENCY.name)).toBeFocused()
    // Enter moves the goal; focus stays on the same button, so a second press moves it again.
    await page.keyboard.press('Enter')
    await expect.poll(() => namesOf(page)).toEqual([JAPAN.name, EMERGENCY.name, LAPTOP.name, GIFTS.name, CAR.name])
    await expect(downOf(page, EMERGENCY.name)).toBeFocused()
    await page.keyboard.press('Space')
    await expect.poll(() => namesOf(page)).toEqual([JAPAN.name, LAPTOP.name, EMERGENCY.name, GIFTS.name, CAR.name])
    await expect(downOf(page, EMERGENCY.name)).toBeFocused()
    expect(fake.puts).toHaveLength(2)
    // The top goal cannot go up and the bottom goal cannot go down: nothing is sent.
    await expect(upOf(page, JAPAN.name)).toHaveAttribute('aria-disabled', 'true')
    await upOf(page, JAPAN.name).click({ force: true })
    await expect(downOf(page, CAR.name)).toHaveAttribute('aria-disabled', 'true')
    await downOf(page, CAR.name).click({ force: true })
    expect(fake.puts).toHaveLength(2)
  })

  test('AC3: a goal moves by native pointer drag', async ({ page }) => {
    const fake = await open(page)
    // Up: the second goal onto the top half of the first.
    await drag(page, JAPAN.name, EMERGENCY.name)
    await expect.poll(() => namesOf(page)).toEqual([JAPAN.name, EMERGENCY.name, LAPTOP.name, GIFTS.name, CAR.name])
    expect(fake.puts).toEqual([{ ids: [JAPAN.id, EMERGENCY.id, LAPTOP.id, GIFTS.id, CAR.id] }])
    // Down: the first goal onto the bottom half of the second.
    await drag(page, JAPAN.name, EMERGENCY.name, 'bottom')
    await expect.poll(() => namesOf(page)).toEqual(START_NAMES)
    expect(fake.puts).toHaveLength(2)
    expect(fake.puts[1]).toEqual({ ids: START_IDS })
    await shot(page, 'after-drag')
  })

  test('AC3: a drag dropped where it started, or cancelled with Escape, sends nothing', async ({ page }) => {
    const fake = await open(page)
    await drag(page, JAPAN.name, JAPAN.name)
    await handleOf(page, GIFTS.name).scrollIntoViewIfNeeded()
    const start = await handleOf(page, GIFTS.name).boundingBox()
    const above = await rowOf(page, LAPTOP.name).boundingBox()
    if (!start || !above) throw new Error('no handle')
    await page.mouse.move(start.x + start.width / 2, start.y + start.height / 2)
    await page.mouse.down()
    await page.mouse.move(start.x + start.width / 2, above.y + 4, { steps: 8 })
    await expect(page.locator('[data-drop-target="true"]')).toHaveCount(1)
    await page.keyboard.press('Escape')
    await expect(page.locator('[data-drop-target="true"]')).toHaveCount(0)
    await page.mouse.up()
    expect(fake.puts).toHaveLength(0)
    expect(await namesOf(page)).toEqual(START_NAMES)
  })

  test('AC3: while a reorder is in flight no second one starts, also after a tab switch, and the saving state shows', async ({ page }) => {
    const fake = await open(page)
    const first = fake.holdNextReorder('commit')
    await downOf(page, EMERGENCY.name).click()
    await expect.poll(() => fake.puts.length).toBe(1)
    await expect(downOf(page, EMERGENCY.name)).toHaveAttribute('aria-disabled', 'true')
    await expect(handleOf(page, EMERGENCY.name)).toHaveAttribute('aria-disabled', 'true')
    // Leave the Savings tab and come back: a new section is mounted over the same request.
    await tab(page, 'Budgets').click()
    await tab(page, 'Savings').click()
    await expect(rows(page)).toHaveCount(START.length)
    await expect(downOf(page, EMERGENCY.name)).toHaveAttribute('aria-disabled', 'true')
    await expect(upOf(page, EMERGENCY.name)).toHaveAttribute('aria-disabled', 'true')
    await expect(handleOf(page, EMERGENCY.name)).toHaveAttribute('aria-disabled', 'true')
    await downOf(page, EMERGENCY.name).dispatchEvent('click')
    await drag(page, JAPAN.name, EMERGENCY.name)
    expect(fake.puts, 'no second PUT while the first is in flight').toHaveLength(1)
    first.release()
    await expect(downOf(page, EMERGENCY.name)).not.toHaveAttribute('aria-disabled', 'true')
    expect(await namesOf(page)).toEqual([JAPAN.name, EMERGENCY.name, LAPTOP.name, GIFTS.name, CAR.name])
    expect(fake.puts).toHaveLength(1)
  })

  test('AC3: a drag keeps hold of its goal when the ranked list refreshes under it', async ({ page }) => {
    const fake = await open(page)
    // Pausing Emergency fund drops it from the ranked list; the refresh is held while Japan trip is picked up.
    const refresh = fake.holdNextRankedGet()
    await rowOf(page, EMERGENCY.name).locator('article[role="button"]').click()
    await page.getByRole('button', { name: 'Pause allocation' }).click()
    await expect.poll(() => fake.rankedGets()).toBeGreaterThan(1)
    await page.getByRole('button', { name: 'Close allocation actions modal' }).click()
    await expect(rows(page)).toHaveCount(START.length)
    const start = await handleOf(page, JAPAN.name).boundingBox()
    if (!start) throw new Error('no handle')
    const x = start.x + start.width / 2
    await page.mouse.move(x, start.y + start.height / 2)
    await page.mouse.down()
    refresh.release()
    await expect(rows(page)).toHaveCount(START.length - 1)
    // Japan trip is first now. Drop it on the lower half of the second goal.
    const target = await rowOf(page, LAPTOP.name).boundingBox()
    if (!target) throw new Error('no target')
    await page.mouse.move(x, target.y + target.height - 4, { steps: 10 })
    await page.mouse.up()
    await expect.poll(() => fake.puts.length).toBe(1)
    expect(fake.puts[0]).toEqual({ ids: [LAPTOP.id, JAPAN.id, GIFTS.id, CAR.id] })
    await expect.poll(() => namesOf(page)).toEqual([LAPTOP.name, JAPAN.name, GIFTS.name, CAR.name])
  })

  test('AC4: a reorder sends the complete ordered list', async ({ page }) => {
    const fake = await open(page)
    await downOf(page, EMERGENCY.name).click()
    await expect.poll(() => fake.puts.length).toBe(1)
    const sent = fake.puts[0] as { ids: number[] }
    expect(Object.keys(fake.puts[0] as object)).toEqual(['ids'])
    expect(sent.ids).toHaveLength(START.length)
    expect([...sent.ids].sort()).toEqual([...START_IDS].sort())
    expect(sent.ids).toEqual([JAPAN.id, EMERGENCY.id, LAPTOP.id, GIFTS.id, CAR.id])
  })

  test('AC4: a refused reorder shows the attempted order while pending, then restores the previous order and shows the error', async ({ page }) => {
    const fake = await open(page)
    const refusal = fake.holdNextReorder('refuse')
    await downOf(page, EMERGENCY.name).click()
    await expect.poll(() => fake.puts.length).toBe(1)
    // Pending: the screen already shows the attempted order, and the request carries the complete list.
    expect(fake.puts[0]).toEqual({ ids: [JAPAN.id, EMERGENCY.id, LAPTOP.id, GIFTS.id, CAR.id] })
    await expect.poll(() => namesOf(page)).toEqual([JAPAN.name, EMERGENCY.name, LAPTOP.name, GIFTS.name, CAR.name])
    await expect(page.getByTestId('toast-message')).toHaveCount(0)
    refusal.release()
    await expect(page.getByTestId('toast-message')).toHaveText(REFUSAL)
    await expect.poll(() => namesOf(page)).toEqual(START_NAMES)
    await shot(page, 'refused')
  })

  test('AC4: a reorder answer that arrives after a new goal was added does not take the goal away', async ({ page }) => {
    const fake = await open(page)
    const pending = fake.holdNextReorder('commit')
    await downOf(page, EMERGENCY.name).click()
    await expect.poll(() => fake.puts.length).toBe(1)
    await createGoal(page, 'Wedding fund')
    await expect(rows(page)).toHaveCount(START.length + 1)
    pending.release()
    await expect(downOf(page, EMERGENCY.name)).not.toHaveAttribute('aria-disabled', 'true')
    await expect(rows(page)).toHaveCount(START.length + 1)
    expect(await namesOf(page)).toEqual([JAPAN.name, EMERGENCY.name, LAPTOP.name, GIFTS.name, CAR.name, 'Wedding fund'])
  })

  test('AC5: a new goal appears at the bottom of the section', async ({ page }) => {
    await open(page)
    await createGoal(page, 'Wedding fund')
    await expect(rows(page)).toHaveCount(START.length + 1)
    expect((await namesOf(page)).at(-1)).toBe('Wedding fund')
    expect((await namesOf(page)).slice(0, START.length)).toEqual(START_NAMES)
    await expect(rows(page).last()).toHaveAttribute('data-goal-id', String(NEW_GOAL_ID))
  })

  test('AC5: a deactivated goal leaves the section and joins the paged list', async ({ page }) => {
    await open(page)
    await rowOf(page, JAPAN.name).locator('article[role="button"]').click()
    await page.getByRole('button', { name: 'Pause allocation' }).click()
    await expect(rows(page)).toHaveCount(START.length - 1)
    expect(await namesOf(page)).toEqual(START_NAMES.filter((n) => n !== JAPAN.name))
    await page.getByRole('button', { name: 'Close allocation actions modal' }).click()
    // Paused, it is in the paged list below, no longer ranked.
    await expect(page.getByTestId('ranked-goals').getByText(JAPAN.name, { exact: true })).toHaveCount(0)
    await expect(page.locator('main').getByText(JAPAN.name, { exact: true })).toHaveCount(1)
  })

  test('AC5: a deleted goal leaves the section', async ({ page }) => {
    await open(page)
    await rowOf(page, GIFTS.name).locator('article[role="button"]').click()
    await page.getByRole('button', { name: 'Delete allocation' }).click()
    await page.getByTestId('confirm-dialog-confirm').click()
    await expect(rows(page)).toHaveCount(START.length - 1)
    expect(await namesOf(page)).toEqual(START_NAMES.filter((n) => n !== GIFTS.name))
  })
})
