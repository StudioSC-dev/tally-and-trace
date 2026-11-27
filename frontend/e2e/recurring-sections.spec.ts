// STU-799: the Allocations Recurring tab loads every entry (paged by the API's `after_id` cursor, only while the tab
// is open) and gives each section (`KIND_ORDER` group) its own paging (5 a page), sort, status filter and account
// filter. The API is faked in the browser: a stateful stand-in for `GET /budget-entries/` that answers as the API does
// (a cursor request returns the ids above `after_id` in ascending id order; any other request keeps next-occurrence
// order and offset paging), and for the delete and update of one entry. It can hold or fail a request so a test acts
// while one is in flight. There is no backend.
import { expect, test } from '@playwright/test'
import type { Locator, Page } from '@playwright/test'
import type { BudgetEntry, CardCredit, EntryOccurrences, FullBudgetEntry, LimitedBudgetEntry, PaginatedResponse, RecordPermissions } from '@tally-trace/shared'
import { household, householdViewRoutes, householdWishlistRoutes, limitedRecurring, mockHousehold } from './support/fixtures/household'
import type { HouseholdData } from './support/fixtures/household'
import { addRoutes, apiRoute } from './support/mockApi'

test.use({ locale: 'en-US' })

const PERMS: RecordPermissions = { can_edit: true, can_delete: true, can_post: true, can_revert: true, can_tag: true }
/** The household's accounts: BPI Payroll, Metrobank Savings, GCash, Cash on hand, the HSBC card and the joint account. */
const [PAYROLL, SAVINGS, GCASH, CASH, CARD, JOINT] = [11, 12, 13, 14, 15, 16]
const HOUSEHOLD_TAG = { id: 41, name: 'Household', color: '#3f6b5c', is_system: true }
const TRIP_TAG = { id: 42, name: 'Japan trip', color: '#a35f2a', is_system: false }

const two = (n: number): string => String(n).padStart(2, '0')
/** `2026-03-12` is the fixed "today" of the household fixture; `day(0)` is today, `day(-1)` yesterday. */
const day = (offset: number): string => {
  const d = new Date(Date.UTC(2026, 2, 12 + offset))
  return `${d.getUTCFullYear()}-${two(d.getUTCMonth() + 1)}-${two(d.getUTCDate())}T00:00:00`
}

let nextId = 3000
function entry(name: string, over: Partial<FullBudgetEntry> = {}): FullBudgetEntry {
  return {
    view: 'full',
    id: ++nextId,
    entry_type: 'expense',
    name,
    amount: 100,
    currency: 'PHP',
    cadence: 'monthly',
    next_occurrence: day(30),
    lead_time_days: 0,
    end_mode: 'indefinite',
    account_id: PAYROLL,
    is_active: true,
    kind: 'cash',
    settlement: 'manual',
    tags: [],
    created_at: '2025-06-01T00:00:00',
    permissions: PERMS,
    created_by: 'Mara S.',
    ...over,
  }
}

/** `count` cash entries named `<prefix> 01`..; due dates run up with the number, ids too. */
const cashEntries = (count: number, prefix = 'Cash bill', over: Partial<FullBudgetEntry> = {}): FullBudgetEntry[] =>
  Array.from({ length: count }, (_, i) => entry(`${prefix} ${two(i + 1)}`, { next_occurrence: day(20 + i), amount: 100 + i, ...over }))

const subscriptions = (count: number, prefix = 'Sub bill', over: Partial<FullBudgetEntry> = {}): FullBudgetEntry[] =>
  Array.from({ length: count }, (_, i) =>
    entry(`${prefix} ${two(i + 1)}`, { account_id: CARD, kind: 'subscription', next_occurrence: day(20 + i), amount: 50 + i, ...over }),
  )

/** What a request answers the way the API does, from `entries` and the query. */
function answer(entries: BudgetEntry[], query: URLSearchParams): PaginatedResponse<BudgetEntry> {
  const tag = query.get('tag')
  const after = query.get('after_id')
  const offset = Number(query.get('offset') ?? 0)
  const limit = Number(query.get('limit') ?? 50)
  let matches = entries.filter((e) => tag === null || e.tags.some((t) => t.id === Number(tag)))
  if (after !== null) {
    matches = matches.filter((e) => e.id > Number(after)).sort((a, b) => a.id - b.id)
  } else {
    matches = [...matches].sort((a, b) => a.next_occurrence.localeCompare(b.next_occurrence) || a.id - b.id)
  }
  const items = matches.slice(offset, offset + limit)
  return { items, total: matches.length, has_more: offset + items.length < matches.length }
}

interface Fake {
  entries: BudgetEntry[]
  /** The query of every list request, in order. */
  gets: URLSearchParams[]
  /** The ids each answered list request returned. */
  served: number[][]
  /** Runs before the nth list request (1-based) is answered; `fail` answers it with a 500. */
  hook?: (n: number, query: URLSearchParams, fake: Fake) => Promise<'fail' | undefined> | 'fail' | undefined
}

const json = (body: unknown, status = 200): { status: number; contentType: string; body: string } => ({
  status,
  contentType: 'application/json',
  body: JSON.stringify(body),
})

async function installEntries(page: Page, entries: BudgetEntry[], hook?: Fake['hook']): Promise<Fake> {
  const fake: Fake = { entries: [...entries], gets: [], served: [], hook }
  await page.route(
    (url) => url.pathname === '/api/v1/budget-entries/',
    async (route) => {
      const request = route.request()
      if (request.method() !== 'GET') return route.fallback()
      const query = new URL(request.url()).searchParams
      fake.gets.push(query)
      const verdict = await fake.hook?.(fake.gets.length, query, fake)
      if (verdict === 'fail') return route.fulfill(json({ detail: 'The page failed' }, 500))
      const body = answer(fake.entries, query)
      fake.served.push(body.items.map((e) => e.id))
      return route.fulfill(json(body))
    },
  )
  await page.route(
    (url) => /^\/api\/v1\/budget-entries\/\d+$/.test(url.pathname),
    async (route) => {
      const request = route.request()
      const id = Number(new URL(request.url()).pathname.split('/').pop())
      if (request.method() === 'DELETE') {
        fake.entries = fake.entries.filter((e) => e.id !== id)
        return route.fulfill({ status: 204 })
      }
      if (request.method() === 'PUT') {
        const found = fake.entries.find((e) => e.id === id)
        const sent = request.postDataJSON() as { is_active?: boolean }
        if (!found || found.view !== 'full') return route.fulfill(json({ detail: 'not found' }, 404))
        const updated: FullBudgetEntry = { ...found, is_active: sent.is_active ?? found.is_active }
        fake.entries = fake.entries.map((e) => (e.id === id ? updated : e))
        return route.fulfill(json(updated))
      }
      return route.fallback()
    },
  )
  return fake
}

/** A card's credit, so a section with an active entry on it shows "Available credit on <card>". */
const CARD_CREDIT: CardCredit = {
  account_id: CARD,
  currency: 'PHP',
  limit: 120000,
  as_of: '2026-03-12',
  available_now: 98000,
  available_with_planned: 96000,
  planned_by: '2026-04-01',
  complete: true,
  uncounted_shared: 0,
  unknown_count: 0,
  opening: { balance_owed: 22000, pending_total: 0, installment_hold: 0, missed_total: 0 },
  planned_charges_total: 0,
  missed: [],
  planned_payments: [],
  checks: [],
  fx: [],
  fx_buffer_pct: 0,
}

interface OpenOptions {
  query?: string
  hook?: Fake['hook']
  credit?: boolean
}

async function open(page: Page, entries: BudgetEntry[], options: OpenOptions = {}): Promise<Fake> {
  const data: HouseholdData = { ...household, entries }
  await mockHousehold(page, data)
  await addRoutes(page, [...householdViewRoutes(household), ...householdWishlistRoutes()])
  if (options.credit) await addRoutes(page, [apiRoute<{ items: CardCredit[] }>('GET', '/cards/credit', { items: [CARD_CREDIT] })])
  const fake = await installEntries(page, entries, options.hook)
  await page.goto(`/allocations${options.query ?? '?tab=recurring'}`)
  await expect(page.getByRole('heading', { level: 1, name: 'Allocations' })).toBeVisible({ timeout: 15_000 })
  // The Recurring tab shows its sections once the first load has settled.
  if (options.query === undefined && options.hook === undefined && entries.length > 0) await expect(page.locator('[data-testid^="kind-section-"]').first()).toBeVisible()
  return fake
}

const section = (page: Page, key: string): Locator => page.getByTestId(`kind-section-${key}`)
const titles = (page: Page, key: string): Promise<string[]> => section(page, key).locator('[data-row-title]').allInnerTexts()
const count = (page: Page, key: string): Locator => section(page, key).locator('header span')
const pager = (page: Page, key: string): Locator => page.getByTestId(`${key}-pager`)
const goToPage = (page: Page, key: string, n: number): Promise<void> =>
  pager(page, key).getByRole('button', { name: String(n), exact: true }).click()
const pickStatus = (page: Page, key: string, label: 'All' | 'Active' | 'Paused'): Promise<void> =>
  page.getByTestId(`${key}-status`).getByRole('button', { name: label, exact: true }).click()
const pickDirection = (page: Page, key: string, label: 'Ascending' | 'Descending'): Promise<void> =>
  page.getByTestId(`${key}-direction`).getByRole('button', { name: label, exact: true }).click()
const searchBox = (page: Page): Locator => page.getByTestId('recurring-search')
const rowOf = (page: Page, name: string): Locator =>
  page.locator('article[data-testid="row"]').filter({ has: page.locator('[data-row-title]', { hasText: new RegExp(`^${name}$`) }) })
const DIALOG = '.fixed.inset-0.overflow-y-auto, [role="dialog"], [role="alertdialog"]'
const top = (page: Page): Locator => page.locator(DIALOG).last()
const tab = (page: Page, label: string): Locator => page.getByRole('button', { name: label, exact: true })

/** A gate a hook can wait on until the test opens it. */
function gate(): { wait: Promise<void>; open: () => void } {
  let release = (): void => undefined
  const wait = new Promise<void>((resolve) => {
    release = resolve
  })
  return { wait, open: release }
}

const settle = (page: Page): Promise<void> => page.waitForTimeout(400)

test.describe('Recurring sections', () => {
  test('loads more than 200 entries across API pages while Recurring is open', async ({ page }) => {
    // Display order (next date) runs against id order, so only a cursor on the id returns every entry once.
    const many = Array.from({ length: 230 }, (_, i) => entry(`Bill ${String(i + 1).padStart(3, '0')}`, { next_occurrence: day(60 - (i % 28)) }))
    const fake = await open(page, many)
    await expect(count(page, 'cash')).toHaveText('230')
    expect(fake.gets).toHaveLength(2)
    const [first, second] = fake.gets
    expect(first.get('after_id'), 'the first request is a cursor request from the start').toBe('0')
    expect(first.get('limit')).toBe('200')
    expect(first.has('offset'), 'no offset beside a cursor').toBe(false)
    expect(second.get('after_id'), "the next request sends the previous page's last id").toBe(String(many[199].id))
    expect(fake.served.flat()).toEqual(many.map((e) => e.id))
    await expect(pager(page, 'cash')).toContainText('1–5 of 230')
    await goToPage(page, 'cash', 46)
    await expect(pager(page, 'cash')).toContainText('226–230 of 230')
  })

  test('stops requesting pages when Recurring closes', async ({ page }) => {
    const many = cashEntries(430)
    const held = gate()
    const fake = await open(page, many, { hook: async (n) => (n === 2 ? held.wait.then(() => undefined) : undefined) })
    await expect.poll(() => fake.gets.length, { message: 'the second page is asked for and held' }).toBe(2)
    await tab(page, 'Budgets').click()
    held.open()
    await settle(page)
    expect(fake.gets, 'no third page once the tab is closed').toHaveLength(2)
    await expect(page.getByTestId('kind-section-cash')).toHaveCount(0)
    // Opening the tab again loads the whole list again.
    await tab(page, 'Recurring').click()
    await expect(count(page, 'cash')).toHaveText('430')
    expect(fake.gets.length).toBe(5)
  })

  test('stops requesting pages when the Allocations route closes with a page held', async ({ page }) => {
    const held = gate()
    const fake = await open(page, cashEntries(430), { hook: async (n) => (n === 2 ? held.wait.then(() => undefined) : undefined) })
    await expect.poll(() => fake.gets.length, { message: 'the second page is asked for and held' }).toBe(2)
    await page.getByRole('link', { name: 'Dashboard', exact: true }).first().click()
    await expect(page.getByRole('heading', { level: 1, name: 'Dashboard' })).toBeVisible()
    held.open()
    await settle(page)
    expect(fake.gets, 'no third page once the route is left').toHaveLength(2)
  })

  test('does not refetch Recurring when a Wishlist purchase invalidates entries after Recurring was visited', async ({ page }) => {
    const fake = await open(page, cashEntries(3))
    await expect(count(page, 'cash')).toHaveText('3')
    expect(fake.gets).toHaveLength(1)
    await tab(page, 'Wishlist').click()
    await expect(page.getByRole('button', { name: 'Mark as purchased' }).first()).toBeVisible()
    await settle(page)
    await page.getByRole('button', { name: 'Mark as purchased' }).first().click()
    await settle(page)
    expect(fake.gets, 'a purchase invalidates budget entries but Recurring is closed').toHaveLength(1)
  })

  test('does not ask for recurring entries while another tab is open', async ({ page }) => {
    const fake = await open(page, cashEntries(3), { query: '?tab=savings' })
    await expect(page.locator('main').getByText('Emergency fund', { exact: true })).toBeVisible()
    await tab(page, 'Wishlist').click()
    await settle(page)
    expect(fake.gets).toHaveLength(0)
  })

  test('loads every surviving match after an earlier entry is deleted or reordered', async ({ page }) => {
    const many = Array.from({ length: 430 }, (_, i) => entry(`Bill ${String(i + 1).padStart(3, '0')}`, { next_occurrence: day(60 - (i % 28)) }))
    const gone = many[0].id
    const moved = many[1].id
    const live = await open(page, many, {
      hook: (n, _query, fake) => {
        if (n === 2) {
          // Between page one and page two: an earlier entry goes, another moves to the front of the display order,
          // and a later one moves to the back.
          fake.entries = fake.entries.filter((e) => e.id !== gone)
          fake.entries = fake.entries.map((e) =>
            e.id === moved
              ? { ...e, next_occurrence: day(400) }
              : e.id === many[250].id
              ? { ...e, next_occurrence: day(-100) }
              : e,
          )
        }
        return undefined
      },
    })
    const fake = live
    await expect(count(page, 'cash')).toHaveText('430')
    const served = fake.served.flat()
    expect(new Set(served).size, 'no entry is returned twice').toBe(served.length)
    const surviving = fake.entries.map((e) => e.id)
    expect(surviving.filter((id) => !served.includes(id)), 'every surviving entry was returned').toEqual([])
    expect(served).toContain(gone)
    expect(served.length).toBe(430)
  })

  test('discards the previous tag load when it finishes after the current load', async ({ page }) => {
    const household41 = [entry('Household one', { tags: [HOUSEHOLD_TAG] }), entry('Household two', { tags: [HOUSEHOLD_TAG] })]
    const trip42 = [entry('Trip one', { tags: [TRIP_TAG] }), entry('Trip two', { tags: [TRIP_TAG] })]
    const held = gate()
    const fake = await open(page, [...household41, ...trip42], {
      hook: async (_n, query) => (query.get('tag') === '41' ? held.wait.then(() => undefined) : undefined),
    })
    await expect(count(page, 'cash')).toHaveText('4')
    await page.getByTestId('tag-filter').selectOption('41')
    await expect.poll(() => fake.gets.filter((q) => q.get('tag') === '41').length).toBe(1)
    await page.getByTestId('tag-filter').selectOption('42')
    await expect.poll(async () => (await titles(page, 'cash')).sort()).toEqual(['Trip one', 'Trip two'])
    held.open()
    await settle(page)
    expect((await titles(page, 'cash')).sort(), 'the older load does not replace the current list').toEqual(['Trip one', 'Trip two'])
    await expect(count(page, 'cash')).toHaveText('2')
  })

  test('keeps the last complete list when a later page fails and reloads on Retry', async ({ page }) => {
    const many = cashEntries(430)
    const fake = await open(page, many, { hook: (n) => (n === 5 ? 'fail' : undefined) })
    await expect(count(page, 'cash')).toHaveText('430')
    // 430 entries are three requests. Leaving and coming back reloads: the first request of the reload (the 4th) lands,
    // its second page (the 5th) fails.
    await tab(page, 'Budgets').click()
    await tab(page, 'Recurring').click()
    await expect(page.getByTestId('recurring-load-error')).toBeVisible()
    expect(fake.gets).toHaveLength(5)
    await expect(count(page, 'cash'), 'the last complete list stays').toHaveText('430')
    await expect(pager(page, 'cash')).toContainText('1–5 of 430')
    // One entry is gone by the time the user retries.
    fake.entries = fake.entries.slice(0, 429)
    await page.getByTestId('recurring-retry').click()
    await expect(page.getByTestId('recurring-load-error')).toHaveCount(0)
    await expect(count(page, 'cash')).toHaveText('429')
    expect(fake.gets).toHaveLength(8)
  })

  test('treats a page that does not advance the cursor as a failed load and keeps the last complete list', async ({ page }) => {
    const many = cashEntries(430)
    const fake = await open(page, many)
    await expect(count(page, 'cash')).toHaveText('430')
    expect(fake.gets).toHaveLength(3)
    // The API now repeats the first page whatever the cursor, and says there is more.
    await page.unroute((url) => url.pathname === '/api/v1/budget-entries/')
    const repeats: number[] = []
    await page.route(
      (url) => url.pathname === '/api/v1/budget-entries/',
      (route) => {
        if (route.request().method() !== 'GET') return route.fallback()
        repeats.push(1)
        return route.fulfill(json({ items: many.slice(0, 200), total: 430, has_more: true }))
      },
    )
    await tab(page, 'Budgets').click()
    await tab(page, 'Recurring').click()
    await expect(page.getByTestId('recurring-load-error')).toBeVisible()
    await settle(page)
    expect(repeats.length, 'it stops after the repeated page instead of looping').toBeLessThanOrEqual(3)
    await expect(count(page, 'cash'), 'the last complete list stays').toHaveText('430')
  })

  test('pages each section independently and clamps after deleting or pausing an entry', async ({ page }) => {
    const fake = await open(page, [...cashEntries(11), ...subscriptions(6)])
    await expect(pager(page, 'cash')).toContainText('1–5 of 11')
    await expect(pager(page, 'subscription')).toContainText('1–5 of 6')
    expect(await titles(page, 'cash')).toEqual(['Cash bill 01', 'Cash bill 02', 'Cash bill 03', 'Cash bill 04', 'Cash bill 05'])
    await goToPage(page, 'cash', 3)
    await expect(pager(page, 'cash')).toContainText('11–11 of 11')
    await expect(pager(page, 'subscription'), 'the other section keeps its page').toContainText('1–5 of 6')
    await goToPage(page, 'subscription', 2)
    expect(await titles(page, 'subscription')).toEqual(['Sub bill 06'])

    // Delete the only entry on the cash section's last page: the page moves to the last one that exists.
    await rowOf(page, 'Cash bill 11').getByTestId('row-open').click()
    await top(page).getByRole('button', { name: 'Delete recurring entry', exact: true }).click()
    await top(page).getByRole('button', { name: 'Delete entry', exact: true }).click()
    await expect(pager(page, 'cash')).toContainText('6–10 of 10')
    expect(await titles(page, 'cash')).toEqual(['Cash bill 06', 'Cash bill 07', 'Cash bill 08', 'Cash bill 09', 'Cash bill 10'])
    await expect(pager(page, 'subscription')).toContainText('6–6 of 6')
    expect(fake.entries.some((e) => e.view === 'full' && e.name === 'Cash bill 11')).toBe(false)

    // Pause the last subscription while the Active filter is on: five remain, so there is one page.
    await pickStatus(page, 'subscription', 'Active')
    await expect(pager(page, 'subscription')).toContainText('1–5 of 6')
    await goToPage(page, 'subscription', 2)
    await rowOf(page, 'Sub bill 06').getByTestId('row-open').click()
    await top(page).getByRole('button', { name: 'Active', exact: true }).click()
    await top(page).getByRole('button', { name: 'Update recurring entry', exact: true }).click()
    await expect(pager(page, 'subscription')).toHaveCount(0)
    expect(await titles(page, 'subscription')).toEqual(['Sub bill 01', 'Sub bill 02', 'Sub bill 03', 'Sub bill 04', 'Sub bill 05'])
  })

  test('sorts one section by due date, amount, or name in either direction', async ({ page }) => {
    const mixed = [
      entry('Delta', { amount: 300, next_occurrence: day(8) }),
      entry('alpha', { amount: 100, next_occurrence: day(13) }),
      entry('Charlie', { amount: 500, next_occurrence: day(3) }),
      entry('bravo', { amount: 200, next_occurrence: day(6) }),
      entry('Echo', { amount: 400, next_occurrence: day(10) }),
    ]
    await open(page, [...mixed, ...subscriptions(2)])
    const cash = (): Promise<string[]> => titles(page, 'cash')
    expect(await cash(), 'next due, ascending, is the default').toEqual(['Charlie', 'bravo', 'Delta', 'Echo', 'alpha'])
    await pickDirection(page, 'cash', 'Descending')
    expect(await cash()).toEqual(['alpha', 'Echo', 'Delta', 'bravo', 'Charlie'])
    await page.getByTestId('cash-sort').selectOption('amount')
    expect(await cash()).toEqual(['Charlie', 'Echo', 'Delta', 'bravo', 'alpha'])
    await pickDirection(page, 'cash', 'Ascending')
    expect(await cash()).toEqual(['alpha', 'bravo', 'Delta', 'Echo', 'Charlie'])
    await page.getByTestId('cash-sort').selectOption('name')
    expect(await cash(), 'by name, ignoring case').toEqual(['alpha', 'bravo', 'Charlie', 'Delta', 'Echo'])
    await pickDirection(page, 'cash', 'Descending')
    expect(await cash()).toEqual(['Echo', 'Delta', 'Charlie', 'bravo', 'alpha'])
    expect(await titles(page, 'subscription'), "another section's order is its own").toEqual(['Sub bill 01', 'Sub bill 02'])
    await expect(page.getByTestId('subscription-sort')).toHaveValue('due')
  })

  test('filters by status, shows limited entries only under All, and hides status in Shared with you', async ({ page }) => {
    const mixed = [
      entry('Active one', { next_occurrence: day(10) }),
      entry('Active two', { next_occurrence: day(11) }),
      entry('Paused one', { next_occurrence: day(12), is_active: false }),
      entry('Paused two', { next_occurrence: day(13), is_active: false }),
    ]
    await open(page, [...mixed, ...limitedRecurring])
    await expect(page.getByTestId('shared-status'), 'the API withholds status from a limited entry').toHaveCount(0)
    await expect(page.getByTestId('cash-status')).toBeVisible()
    expect((await titles(page, 'shared')).sort()).toEqual(['Condo parking rental income', 'Water refill service'])
    expect(await titles(page, 'cash')).toEqual(['Active one', 'Active two', 'Paused one', 'Paused two'])
    await pickStatus(page, 'cash', 'Active')
    expect(await titles(page, 'cash')).toEqual(['Active one', 'Active two'])
    await pickStatus(page, 'cash', 'Paused')
    expect(await titles(page, 'cash')).toEqual(['Paused one', 'Paused two'])
    await pickStatus(page, 'cash', 'All')
    expect(await titles(page, 'cash')).toHaveLength(4)
    expect((await titles(page, 'shared')).sort(), 'the shared section is unchanged').toEqual(['Condo parking rental income', 'Water refill service'])
  })

  test('offers exposed accounts and matches transfers on either end', async ({ page }) => {
    const rows = [
      entry('Pay in', { entry_type: 'income', kind: null, account_id: PAYROLL, next_occurrence: day(10) }),
      entry('Top-up', { kind: null, account_id: SAVINGS, transfer_to_account_id: PAYROLL, next_occurrence: day(11) }),
      entry('Wallet fill', { kind: null, account_id: GCASH, transfer_to_account_id: CASH, next_occurrence: day(12) }),
    ]
    await open(page, rows)
    const select = page.getByTestId('other-account')
    await expect(select.locator('option')).toHaveText(['All accounts', 'BPI Payroll', 'Cash on hand', 'GCash', 'Metrobank Savings'])
    await select.selectOption({ label: 'BPI Payroll' })
    expect(await titles(page, 'other'), 'an income on it and a transfer into it').toEqual(['Pay in', 'Top-up'])
    await select.selectOption({ label: 'Metrobank Savings' })
    expect(await titles(page, 'other'), 'a transfer out of it').toEqual(['Top-up'])
    await select.selectOption({ label: 'Cash on hand' })
    expect(await titles(page, 'other'), "a transfer's destination").toEqual(['Wallet fill'])
    await select.selectOption({ label: 'All accounts' })
    expect(await titles(page, 'other')).toEqual(['Pay in', 'Top-up', 'Wallet fill'])
  })

  test('resets affected sections to page one when search, tag, or section filters change', async ({ page }) => {
    const tagged = { tags: [HOUSEHOLD_TAG] }
    await open(page, [...cashEntries(12, 'Bill cash', tagged), ...subscriptions(7, 'Bill sub', tagged)])
    const bothOnPageTwo = async (): Promise<void> => {
      await goToPage(page, 'cash', 2)
      await goToPage(page, 'subscription', 2)
      await expect(pager(page, 'cash')).toContainText('6–10 of 12')
      await expect(pager(page, 'subscription')).toContainText('6–7 of 7')
    }
    await bothOnPageTwo()
    // A section's own filter resets that section only.
    await pickStatus(page, 'cash', 'Active')
    await expect(pager(page, 'cash')).toContainText('1–5 of 12')
    await expect(pager(page, 'subscription')).toContainText('6–7 of 7')
    await goToPage(page, 'cash', 2)
    await page.getByTestId('cash-account').selectOption({ label: 'BPI Payroll' })
    await expect(pager(page, 'cash')).toContainText('1–5 of 12')
    await expect(pager(page, 'subscription')).toContainText('6–7 of 7')
    // The page search resets both.
    await goToPage(page, 'cash', 2)
    await searchBox(page).fill('Bill')
    await expect(pager(page, 'cash')).toContainText('1–5 of 12')
    await expect(pager(page, 'subscription')).toContainText('1–5 of 7')
    // So does the tag filter.
    await bothOnPageTwo()
    await page.getByTestId('tag-filter').selectOption('41')
    await expect(pager(page, 'cash')).toContainText('1–5 of 12')
    await expect(pager(page, 'subscription')).toContainText('1–5 of 7')
  })

  test('keeps the credit summary unchanged across section filters and pages', async ({ page }) => {
    const rows = [
      ...subscriptions(7),
      entry('Joint sub', { kind: 'subscription', account_id: JOINT, next_occurrence: day(40) }),
      entry('Old sub', { kind: 'subscription', account_id: CARD, is_active: false, next_occurrence: day(41) }),
    ]
    await open(page, rows, { credit: true })
    const lines = section(page, 'subscription').getByTestId('kind-credit-lines')
    await expect(lines).toContainText('Available credit on HSBC Red Mastercard')
    const before = await lines.innerText()
    const same = async (what: string): Promise<void> => expect(await lines.innerText(), what).toBe(before)
    await goToPage(page, 'subscription', 2)
    await same('page two')
    await pickStatus(page, 'subscription', 'Paused')
    expect(await titles(page, 'subscription')).toEqual(['Old sub'])
    await same('the Paused filter')
    await pickStatus(page, 'subscription', 'All')
    await page.getByTestId('subscription-account').selectOption({ label: 'BDO Joint household' })
    expect(await titles(page, 'subscription')).toEqual(['Joint sub'])
    await same('an account filter that leaves one entry on another account')
    // The page search is not a section filter: it does change what the summary is about.
    await page.getByTestId('subscription-account').selectOption({ label: 'All accounts' })
    await searchBox(page).fill('Joint')
    await expect(section(page, 'subscription').getByTestId('kind-credit-lines')).toHaveCount(0)
  })

  test('computes the credit summary from every loaded entry, not the visible page', async ({ page }) => {
    // The only credit-bearing entry sits on page two; page one has none.
    const rows = [
      ...subscriptions(6, 'Joint sub', { account_id: JOINT, tags: [HOUSEHOLD_TAG] }),
      entry('Card sub', { kind: 'subscription', account_id: CARD, next_occurrence: day(60) }),
    ]
    await open(page, rows, { credit: true })
    const lines = section(page, 'subscription').getByTestId('kind-credit-lines')
    await expect(pager(page, 'subscription')).toContainText('1–5 of 7')
    expect(await titles(page, 'subscription'), 'page one holds no card entry').not.toContain('Card sub')
    await expect(lines, 'the summary shows on a page without the card entry').toContainText('Available credit on HSBC Red Mastercard')
    await goToPage(page, 'subscription', 2)
    expect(await titles(page, 'subscription')).toContain('Card sub')
    await expect(lines).toContainText('Available credit on HSBC Red Mastercard')
    // A tag that excludes the card entry removes the summary on every page.
    await page.getByTestId('tag-filter').selectOption('41')
    await expect(pager(page, 'subscription')).toContainText('1–5 of 6')
    await expect(section(page, 'subscription').getByTestId('kind-credit-lines')).toHaveCount(0)
  })

  test('mutes paused entries and shows the Paused badge', async ({ page }) => {
    await open(page, [entry('Running', { next_occurrence: day(30) }), entry('On hold', { next_occurrence: day(31), is_active: false })])
    const held = rowOf(page, 'On hold')
    await expect(held.getByTestId('paused-badge')).toHaveText('Paused')
    await expect(held).toHaveAttribute('data-paused', 'true')
    expect(await held.evaluate((el) => getComputedStyle(el).opacity), 'the row is muted').toBe('0.6')
    const running = rowOf(page, 'Running')
    await expect(running.getByTestId('paused-badge')).toHaveCount(0)
    expect(await running.evaluate((el) => getComputedStyle(el).opacity)).toBe('1')
    await expect(held.getByTestId('row-badges')).toContainText('Paused')
  })

  test('shows due-today, seven-day, and overdue indicators only for full active entries', async ({ page }) => {
    const rows = [
      entry('Late', { next_occurrence: day(-1) }),
      entry('Today', { next_occurrence: day(0) }),
      entry('Tomorrow', { next_occurrence: day(1) }),
      // A second section, so no row waits on a second page.
      entry('Seventh day', { account_id: CARD, kind: 'subscription', next_occurrence: day(7) }),
      entry('Eighth day', { account_id: CARD, kind: 'subscription', next_occurrence: day(8) }),
      entry('Paused late', { account_id: CARD, kind: 'subscription', next_occurrence: day(-5), is_active: false }),
      entry('Paid off', { account_id: CARD, kind: 'subscription', next_occurrence: day(-3), end_mode: 'after_occurrences', max_occurrences: 0, occurrences_paid: 3 }),
    ]
    const late: LimitedBudgetEntry = { ...limitedRecurring[0], display_name: 'Others late', next_occurrence: day(-2) }
    await open(page, [...rows, late])
    const indicator = (name: string): Locator => rowOf(page, name).getByTestId('due-indicator')
    await expect(indicator('Late')).toHaveText('Overdue')
    await expect(indicator('Late')).toHaveAttribute('data-status', 'danger')
    await expect(indicator('Today')).toHaveAttribute('data-status', 'warn')
    await expect(indicator('Today')).toHaveText('Due today')
    await expect(indicator('Tomorrow')).toHaveText('Due in 1 day')
    await expect(indicator('Seventh day')).toHaveText('Due in 7 days')
    await expect(indicator('Eighth day')).toHaveCount(0)
    await expect(indicator('Paused late'), 'a paused entry has none').toHaveCount(0)
    await expect(indicator('Paid off'), 'a fully paid entry has none').toHaveCount(0)
    await expect(rowOf(page, 'Paid off').getByTestId('installment-paid')).toBeVisible()
    await expect(indicator('Others late'), "someone else's limited entry has none").toHaveCount(0)
  })

  test('keeps the section header and restores matches when Clear filters is used', async ({ page }) => {
    const rows = [
      entry('Alpha active', { next_occurrence: day(10), amount: 900 }),
      entry('Beta active', { next_occurrence: day(11), amount: 100 }),
      ...subscriptions(3),
    ]
    await open(page, rows)
    await pickStatus(page, 'subscription', 'Paused')
    await page.getByTestId('cash-sort').selectOption('amount')
    await pickStatus(page, 'cash', 'Paused')
    const cash = section(page, 'cash')
    await expect(cash.getByRole('heading', { name: 'Cash expenses' })).toBeVisible()
    await expect(page.getByTestId('cash-empty')).toContainText('No matching entries in this section')
    await expect(page.getByTestId('cash-clear-filters')).toBeVisible()
    await page.getByTestId('cash-account').selectOption({ label: 'BPI Payroll' })
    await page.getByTestId('cash-clear-filters').click()
    expect(await titles(page, 'cash'), "back to every match, still sorted by the section's own sort").toEqual(['Beta active', 'Alpha active'])
    await expect(page.getByTestId('cash-status').getByRole('button', { name: 'All', exact: true })).toHaveAttribute('aria-pressed', 'true')
    await expect(page.getByTestId('cash-account')).toHaveValue('')
    await expect(page.getByTestId('cash-sort')).toHaveValue('amount')
    await expect(page.getByTestId('subscription-status').getByRole('button', { name: 'Paused', exact: true }), "another section's filter").toHaveAttribute('aria-pressed', 'true')
    await expect(page.getByTestId('cash-clear-filters')).toHaveCount(0)
  })

  test('keeps the section empty when a page filter still excludes all entries after Clear filters', async ({ page }) => {
    await open(page, [entry('Plain rent', { next_occurrence: day(10) }), entry('Old gym', { next_occurrence: day(11), is_active: false }), ...subscriptions(2, 'Netflix')])
    await pickStatus(page, 'cash', 'Paused')
    await searchBox(page).fill('Netflix')
    // The search leaves the cash section nothing, but its filter keeps it on the page, with its header.
    await expect(page.getByTestId('cash-empty')).toBeVisible()
    await expect(section(page, 'cash').getByRole('heading', { name: 'Cash expenses' })).toBeVisible()
    await page.getByTestId('cash-clear-filters').click()
    await expect(section(page, 'cash').getByRole('heading', { name: 'Cash expenses' })).toBeVisible()
    await expect(page.getByTestId('cash-empty')).toContainText('No matching entries in this section')
    await expect(page.getByTestId('cash-clear-filters')).toHaveCount(0)
    expect(await titles(page, 'subscription'), 'the search still applies').toEqual(['Netflix 01', 'Netflix 02'])
    // A new search lets the section go when it has nothing and no filter.
    await searchBox(page).fill('Plain')
    await expect(section(page, 'cash')).toBeVisible()
    await searchBox(page).fill('Netflix')
    await expect(section(page, 'cash')).toHaveCount(0)
  })

  test('keeps a section with a filter, its message and Clear filters when a tag excludes all its entries', async ({ page }) => {
    const rows = [entry('Plain rent', { next_occurrence: day(10) }), entry('Old gym', { next_occurrence: day(11), is_active: false }), ...subscriptions(2, 'Netflix', { tags: [TRIP_TAG] })]
    await open(page, rows)
    await pickStatus(page, 'cash', 'Paused')
    await page.getByTestId('tag-filter').selectOption('42')
    await expect(page.getByTestId('tag-filter')).toHaveValue('42')
    expect(await titles(page, 'subscription')).toEqual(['Netflix 01', 'Netflix 02'])
    const cash = section(page, 'cash')
    await expect(cash.getByRole('heading', { name: 'Cash expenses' })).toBeVisible()
    await expect(page.getByTestId('cash-empty')).toContainText('No matching entries in this section')
    await expect(page.getByTestId('cash-clear-filters')).toBeVisible()
    await page.getByTestId('cash-clear-filters').click()
    await expect(cash.getByRole('heading', { name: 'Cash expenses' })).toBeVisible()
    await expect(page.getByTestId('cash-empty')).toBeVisible()
    // With no filter left the tag alone lets the section go.
    await page.getByTestId('tag-filter').selectOption('')
    await expect(page.getByTestId('cash-empty')).toHaveCount(0)
    expect(await titles(page, 'cash')).toEqual(['Plain rent', 'Old gym'])
  })

  test('preserves existing Recurring entry actions and behavior in the other Allocations tabs', async ({ page }) => {
    const meralco = entry('Meralco', { amount: 4600, next_occurrence: day(5) })
    const fake = await open(page, [meralco, ...subscriptions(1)])
    await addRoutes(page, [
      apiRoute<EntryOccurrences>('GET', `/budget-entries/${meralco.id}/occurrences`, {
        entry_id: meralco.id, today: '2026-03-12', capped: false, kind: 'cash', due_unposted: 0, omitted: 0, occurrences: [],
      }),
    ])
    // Recurring: Mark paid opens its dialog, a title opens the edit form, Add opens the empty form.
    await rowOf(page, 'Meralco').getByTestId('entry-mark-paid-button').click()
    await expect(page.getByTestId('mark-paid-dialog')).toContainText('Mark Meralco as paid')
    await page.getByTestId('mark-paid-dialog').getByRole('button', { name: 'Cancel', exact: true }).click()
    await expect(page.getByTestId('mark-paid-dialog')).toHaveCount(0)
    await rowOf(page, 'Meralco').getByTestId('row-open').click()
    await expect(top(page).getByRole('button', { name: 'Update recurring entry', exact: true })).toBeVisible()
    await top(page).getByRole('button', { name: 'Cancel', exact: true }).click()
    await page.getByRole('button', { name: 'Add recurring entry', exact: true }).first().click()
    await expect(top(page).getByRole('button', { name: 'Save recurring entry', exact: true })).toBeVisible()
    await top(page).getByRole('button', { name: 'Cancel', exact: true }).click()
    const asked = fake.gets.length

    await tab(page, 'Budgets').click()
    await expect(page.locator('main').getByText('Groceries', { exact: true })).toBeVisible()
    await page.getByRole('button', { name: 'Add budget', exact: true }).click()
    await expect(page.getByRole('heading', { name: 'Create budget envelope', exact: true })).toBeVisible()
    await top(page).getByRole('button', { name: 'Cancel', exact: true }).click()
    await tab(page, 'Savings').click()
    await expect(page.locator('main').getByText('Emergency fund', { exact: true })).toBeVisible()
    await page.getByRole('button', { name: 'Add savings goal', exact: true }).click()
    await expect(page.getByRole('heading', { name: 'Create savings tracker', exact: true })).toBeVisible()
    await top(page).getByRole('button', { name: 'Cancel', exact: true }).click()
    await tab(page, 'Wishlist').click()
    await expect(page.locator('main').getByText('Work laptop', { exact: true })).toBeVisible()
    await page.getByRole('button', { name: 'Add wishlist item', exact: true }).click()
    await expect(page.getByRole('heading', { name: 'Add item', exact: true })).toBeVisible()
    expect(fake.gets.length, 'the other tabs ask for no recurring entries').toBe(asked)
  })
})
