// STU-687: on Transactions the list leads. The Due card is a one-line banner (count and most urgent item, with an
// expand control) and is absent only when all five of its tabs are empty; the list's controls
// are one toolbar row (search, month picker, Filters) and every other filter opens in a disclosure under it. The API is
// faked in the browser with the shared household fixture; there is no backend.
import path from 'node:path'
import { expect, test } from '@playwright/test'
import type { Locator, Page } from '@playwright/test'
import type { Transaction } from '@tally-trace/shared'
import { household, mockHousehold, withNothingDue, withOnlyInstallments, withOnlyUpcoming } from './support/fixtures/household'
import type { HouseholdData } from './support/fixtures/household'
import { shot } from './support/shot'

/** The first list row's highest allowed top, per project (AC1; 882 and 614 before this change). */
const FOLD: Record<string, number> = { phone: 460, desktop: 420 }
/** The tallest the collapsed Due banner and the toolbar may be (AC2, AC4). */
const BAR_MAX = 56
/** The phone project's viewport width (playwright.config.ts). */
const PHONE_WIDTH = 390

/**
 * The filter controls the page offered on `main` (before this change), with the accessible names read there: the
 * Accounts and Categories pickers (labelled by their headings), the Transaction types and Entered by groups, the tag
 * select and the custom date range's start and end. `main` has no sort-order control, so there is none to list.
 */
const FILTERS: readonly { name: string; find: (page: Page) => Locator }[] = [
  { name: 'accounts', find: (p) => p.locator('[data-field="filter_accounts"]') },
  { name: 'transaction types', find: (p) => p.getByRole('group', { name: 'Transaction types' }) },
  { name: 'categories', find: (p) => p.locator('[data-field="filter_categories"]') },
  { name: 'entered by', find: (p) => p.getByRole('group', { name: 'Entered by' }) },
  { name: 'tag', find: (p) => p.getByTestId('tag-filter') },
  { name: 'custom start date', find: (p) => p.getByLabel('Custom start date') },
  { name: 'custom end date', find: (p) => p.getByLabel('Custom end date') },
]

/** Saves a viewport screenshot, for views with the fixed tab bar, under `shot()`'s naming. */
async function viewportShot(page: Page, name: string): Promise<void> {
  const info = test.info()
  const spec = path.basename(info.file).replace(/\.spec\.ts$/, '')
  await page.screenshot({ path: path.join(info.project.outputDir, 'screens', `${spec}-${name}-${info.project.name}.png`), animations: 'disabled' })
}

/** Opens Transactions signed in as the household's user, once its rows are listed, the data has settled and fonts are in. */
async function open(page: Page, data: HouseholdData = household): Promise<void> {
  await mockHousehold(page, data)
  await page.goto('/transactions')
  await expect(page.getByRole('heading', { level: 1, name: 'Transactions' })).toBeVisible({ timeout: 15_000 })
  await expect(rows(page).first()).toBeVisible()
  await page.waitForLoadState('networkidle')
  await page.evaluate(() => document.fonts.ready)
}

const rows = (page: Page): Locator => page.locator('article[data-transaction-id]')
const dueSection = (page: Page): Locator => page.getByTestId('due-section')
const dueToggle = (page: Page): Locator => page.getByTestId('due-section-toggle')
const filtersButton = (page: Page): Locator => page.getByRole('button', { name: 'Filters', exact: true })

async function boxOf(el: Locator): Promise<{ x: number; y: number; width: number; height: number }> {
  const b = await el.boundingBox()
  if (!b) throw new Error('element has no box')
  return b
}

/** The listed rows' ids, top to bottom. */
const listedIds = (page: Page): Promise<number[]> =>
  rows(page).evaluateAll((els) => els.map((e) => Number(e.getAttribute('data-transaction-id'))))

/** The banner's text line: its height and its computed line height, to tell one line from two. */
const lineOf = (el: Locator): Promise<{ height: number; lineHeight: number }> =>
  el.evaluate((e) => ({ height: e.getBoundingClientRect().height, lineHeight: parseFloat(getComputedStyle(e).lineHeight) }))

// ─── The fixture's answers, as the list shows them ─────────────────────────────────────────────────────────────

const dayOf = (t: Transaction): string => (t.view === 'limited' ? t.date : t.transaction_date).slice(0, 10)
const describe = (t: Transaction): string => (t.view === 'limited' ? t.display_description : t.description) ?? ''
const categoryOf = (t: Transaction): string | undefined =>
  t.view === 'shared_full' ? (t.category_name ?? undefined) : t.view === 'full' ? household.categories.find((c) => c.id === t.category_id)?.name : undefined
const touches = (t: Transaction, id: number): boolean =>
  t.view !== 'limited' && [t.account_id, t.transfer_from_account_id, t.transfer_to_account_id].includes(id)
/** The ids of the rows dated `start` to `end` that pass `keep`, newest first (date, then id, as the API sorts). */
const expectedIds = (start: string, end: string, keep: (t: Transaction) => boolean = () => true): number[] =>
  household.transactions
    .filter((t) => dayOf(t) >= start && dayOf(t) <= end && keep(t))
    .sort((a, b) => -((a.view === 'limited' ? a.date : a.transaction_date).localeCompare(b.view === 'limited' ? b.date : b.transaction_date) || a.id - b.id))
    .map((t) => t.id)
/** The month the page opens on: the frozen clock's March 2026. */
const MARCH = ['2026-03-01', '2026-03-31'] as const
const GCASH_ID = household.accounts.find((a) => a.name === 'GCash')?.id ?? -1
const TRIP_TAG = household.tags.find((t) => t.name === 'Japan trip')

// ─── AC1 ─────────────────────────────────────────────────────────────────────────────────────────────────────

test('first transaction row is above the fold', async ({ page }, testInfo) => {
  await open(page)
  const first = await boxOf(rows(page).first())
  await viewportShot(page, 'above-the-fold')
  expect(first.y, `the first row's top (${first.y}) is at most ${FOLD[testInfo.project.name]}`).toBeLessThanOrEqual(FOLD[testInfo.project.name])
  if (testInfo.project.name === 'phone') {
    const tabBarTop = (await boxOf(page.locator('nav.fixed.bottom-0'))).y
    const inside = await rows(page).evaluateAll(
      (els, limit) => els.filter((e) => { const b = e.getBoundingClientRect(); return b.top >= 0 && b.bottom <= limit }).length,
      tabBarTop,
    )
    expect(inside, `rows fully inside the viewport above the tab bar (top ${tabBarTop})`).toBeGreaterThanOrEqual(3)
  }
})

// ─── AC2 ─────────────────────────────────────────────────────────────────────────────────────────────────────

test('due card is a one-line banner', async ({ page }) => {
  await open(page)
  const section = dueSection(page)
  await expect(section).toHaveAttribute('data-state', 'collapsed')
  const banner = await boxOf(section)
  expect(banner.height, `the collapsed Due banner's height (${banner.height})`).toBeLessThanOrEqual(BAR_MAX)
  const text = page.getByTestId('due-banner-text')
  const line = await lineOf(text)
  expect(line.height, `the banner text is one line (height ${line.height}, line height ${line.lineHeight})`).toBeLessThanOrEqual(line.lineHeight + 1)
  await shot(page, 'banner-collapsed')
  const bannerCount = (await page.getByTestId('due-banner-count').innerText()).trim()
  const bannerItem = (await page.getByTestId('due-banner-item').innerText()).trim()
  await expect(section.getByRole('tab')).toHaveCount(0)

  await dueToggle(page).click()
  await expect(dueToggle(page)).toHaveAttribute('aria-expanded', 'true')
  await expect(section).toHaveAttribute('data-state', 'expanded')
  await expect(section.getByRole('tab', { name: /^Due and overdue/ })).toBeVisible()
  await expect(section.getByRole('tab', { name: /^Not posted yet/ })).toBeVisible()
  await expect(section.getByRole('tab', { name: /^Upcoming/ })).toBeVisible()
  await expect(section.getByRole('tab', { name: /^Due and overdue/ })).toHaveAttribute('aria-selected', 'true')
  const firstDue = page.getByTestId('due-panel-due').getByTestId('due-row').first()
  await expect(firstDue).toBeVisible()
  const firstName = (await firstDue.locator('p').first().innerText()).trim()
  const dueCount = (await page.getByTestId('due-count').innerText()).trim()
  await shot(page, 'banner-expanded')
  expect(bannerItem, 'the banner names the item the Due section lists first').toBe(firstName)
  expect(bannerCount, "the banner's count is the Due and overdue tab's").toBe(`${dueCount} due`)

  await dueToggle(page).click()
  await expect(section.getByRole('tab')).toHaveCount(0)
  await expect(section).toHaveAttribute('data-state', 'collapsed')
  expect((await boxOf(section)).height, 'collapsing returns the banner').toBeLessThanOrEqual(BAR_MAX)
  await shot(page, 'banner-collapsed-again')
})

// ─── AC3 ─────────────────────────────────────────────────────────────────────────────────────────────────────

test('due card is absent when empty', async ({ page, context }) => {
  await open(page)
  await expect(dueSection(page)).toHaveCount(1)
  const bannerHeight = (await boxOf(dueSection(page))).height
  const withBanner = (await boxOf(rows(page).first())).y
  await shot(page, 'absent-banner-run')

  const empty = await context.newPage()
  const nothing = withNothingDue(household)
  // All five Due card lists are empty in this run, not only Due and overdue, Not posted yet and Upcoming.
  expect(nothing.due.payables.length + nothing.due.card_statements_due.length + nothing.due.upcoming_this_month.length, 'nothing due').toBe(0)
  expect(nothing.due.upcoming_occurrences.items.length + nothing.due.subscription_occurrences.items.length, 'no occurrences').toBe(0)
  expect(nothing.installmentPlans.length, 'no installment plans').toBe(0)
  await open(empty, nothing)
  await expect(empty.getByTestId('due-section')).toHaveCount(0)
  const withoutBanner = (await boxOf(rows(empty).first())).y
  await shot(empty, 'absent-empty-run')
  expect(await empty.getByTestId('due-section').count(), 'the empty run renders no Due section').toBe(0)
  expect(withBanner - withoutBanner, `the list moves up by at least the banner's height (${bannerHeight})`).toBeGreaterThanOrEqual(bannerHeight)
  expect(await listedIds(empty), 'the same transactions are listed in both runs').toEqual(await listedIds(page))
})

// ─── AC4 ─────────────────────────────────────────────────────────────────────────────────────────────────────

test('filters are one toolbar row', async ({ page }) => {
  await open(page)
  const toolbar = page.getByTestId('transactions-toolbar')
  const controls = {
    search: page.getByTestId('transactions-search'),
    'month picker': page.getByTestId('transactions-month'),
    'previous month': page.getByRole('button', { name: 'View previous month' }),
    'next month': page.getByRole('button', { name: 'View next month' }),
    Filters: filtersButton(page),
  }
  const centres: Record<string, number> = {}
  for (const [name, el] of Object.entries(controls)) {
    await expect(el).toBeVisible()
    const b = await boxOf(el)
    centres[name] = b.y + b.height / 2
  }
  await shot(page, 'toolbar')
  const reference = centres.search
  for (const [name, y] of Object.entries(centres)) {
    expect(Math.abs(y - reference), `${name}'s centre y (${y}) is within 2px of the search's (${reference})`).toBeLessThanOrEqual(2)
  }
  const height = (await boxOf(toolbar)).height
  expect(height, `the toolbar's height (${height})`).toBeLessThanOrEqual(BAR_MAX)
})

// ─── AC5 ─────────────────────────────────────────────────────────────────────────────────────────────────────

test('every filter is still reachable', async ({ page }) => {
  await open(page)
  const button = filtersButton(page)
  await expect(button).toHaveAttribute('aria-expanded', 'false')
  for (const f of FILTERS) await expect(f.find(page), `${f.name} is hidden while Filters is closed`).toHaveCount(0)
  await expect(page.getByText(/^Date range:/)).toHaveCount(0)
  expect(await page.evaluate(() => document.body.textContent?.includes('→') ?? false), 'no element contains →').toBe(false)
  await shot(page, 'filters-closed')

  await button.click()
  await expect(button).toHaveAttribute('aria-expanded', 'true')
  const panel = page.locator(`#${await button.getAttribute('aria-controls')}`)
  await expect(panel).toBeVisible()
  for (const f of FILTERS) await expect(panel.locator(f.find(page)), `${f.name} shows inside the open Filters`).toBeVisible()
  await expect(page.getByText(/^Date range:/)).toHaveCount(1)
  await expect(panel.getByText(/^Date range:/)).toBeVisible()
  expect(await page.evaluate(() => document.body.textContent?.includes('→') ?? false), 'no element contains → with Filters open').toBe(false)
  await shot(page, 'filters-open')

  await button.click()
  await expect(button).toHaveAttribute('aria-expanded', 'false')
  for (const f of FILTERS) await expect(f.find(page), `${f.name} is hidden again once Filters closes`).toHaveCount(0)
  await expect(page.getByText(/^Date range:/)).toHaveCount(0)
  await shot(page, 'filters-closed-again')
})

// ─── AC6 ─────────────────────────────────────────────────────────────────────────────────────────────────────

test('due tabs sit on one row at 390', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'phone', 'AC6 is about the 390px phone')
  await open(page)
  await dueToggle(page).click()
  const tablist = dueSection(page).getByRole('tablist')
  const tabs = tablist.getByRole('tab')
  await expect(tabs.first()).toBeVisible()
  await shot(page, 'tabs-one-row')
  // The card has five tabs; the first three (Due and overdue, Not posted yet, Upcoming) are the ones the ticket names.
  const ys = await tabs.evaluateAll((els) => els.map((e) => e.getBoundingClientRect().top))
  for (const y of ys) expect(Math.abs(y - ys[0]), `every tab's top (${y}) is within 1px of the first's (${ys[0]})`).toBeLessThanOrEqual(1)
  expect(await tablist.evaluate((e) => getComputedStyle(e).flexWrap), 'the tab row does not wrap').toBe('nowrap')
  expect(await page.evaluate(() => document.documentElement.scrollWidth), 'page scroll width').toBeLessThanOrEqual(PHONE_WIDTH)
  // None is clipped: each tab's label fits its button, and the row scrolls each tab wholly into view.
  const count = await tabs.count()
  for (let i = 0; i < count; i += 1) {
    const tab = tabs.nth(i)
    expect(await tab.evaluate((e) => e.scrollWidth <= e.clientWidth), `tab ${i + 1}'s label is not cut`).toBe(true)
    await tab.scrollIntoViewIfNeeded()
    const t = await boxOf(tab)
    const row = await boxOf(tablist)
    expect(t.x >= row.x - 0.5 && t.x + t.width <= row.x + row.width + 0.5, `tab ${i + 1} (${t.x}..${t.x + t.width}) lies inside the tab row (${row.x}..${row.x + row.width})`).toBe(true)
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth), 'page scroll width after scrolling the tabs').toBeLessThanOrEqual(PHONE_WIDTH)
  await shot(page, 'tabs-last-in-view')
})

// ─── AC7 ─────────────────────────────────────────────────────────────────────────────────────────────────────

test('upcoming-only items keep the due banner', async ({ page }) => {
  const data = withOnlyUpcoming(household)
  const item = data.due.upcoming_occurrences.items[0]
  await open(page, data)
  const section = dueSection(page)
  await expect(section).toBeVisible()
  await expect(page.getByTestId('due-banner-item')).toHaveText(item.name)
  await expect(page.getByTestId('due-banner-count')).toHaveText('1 upcoming')
  const banner = await boxOf(section)
  expect(banner.height, `the banner's height (${banner.height})`).toBeLessThanOrEqual(BAR_MAX)
  const line = await lineOf(page.getByTestId('due-banner-text'))
  expect(line.height, `the banner text is one line (height ${line.height})`).toBeLessThanOrEqual(line.lineHeight + 1)
  await shot(page, 'upcoming-only-collapsed')

  await dueToggle(page).click()
  await expect(section.getByRole('tab', { name: /^Upcoming/ })).toHaveAttribute('aria-selected', 'true')
  const upcomingRow = page.getByTestId('due-panel-upcoming').getByTestId('due-row')
  await expect(upcomingRow).toHaveCount(1)
  await expect(upcomingRow.first()).toContainText(item.name)
  await shot(page, 'upcoming-only-expanded')
})

test('installments-only items keep the due banner', async ({ page }) => {
  const data = withOnlyInstallments(household)
  const item = data.installmentPlans[0]
  await open(page, data)
  const section = dueSection(page)
  await expect(section).toBeVisible()
  await expect(page.getByTestId('due-banner-item')).toHaveText(item.name)
  await expect(page.getByTestId('due-banner-count')).toHaveText('1 installment plan')
  const banner = await boxOf(section)
  expect(banner.height, `the banner's height (${banner.height})`).toBeLessThanOrEqual(BAR_MAX)
  const line = await lineOf(page.getByTestId('due-banner-text'))
  expect(line.height, `the banner text is one line (height ${line.height})`).toBeLessThanOrEqual(line.lineHeight + 1)
  await shot(page, 'installments-only-collapsed')

  await dueToggle(page).click()
  await expect(section.getByRole('tab', { name: /^Installments/ })).toHaveAttribute('aria-selected', 'true')
  const planRow = page.getByTestId('due-panel-installments').getByTestId('due-row')
  await expect(planRow).toHaveCount(1)
  await expect(planRow.first()).toContainText(item.name)
  await shot(page, 'installments-only-expanded')
})

// ─── AC8 ─────────────────────────────────────────────────────────────────────────────────────────────────────

interface FilterCase {
  name: string
  /** The filter's ids, newest first. */
  expected: number[]
  apply: (page: Page) => Promise<void>
  clear: (page: Page) => Promise<void>
  /** Opens Filters first. */
  panel?: boolean
}

const MARCH_IDS = expectedIds(...MARCH)
const pressIn = (page: Page, field: string, name: string | RegExp): Promise<void> =>
  page.locator(`[data-field="${field}"]`).getByRole('button', { name, exact: typeof name === 'string' }).first().click()

const CASES: readonly FilterCase[] = [
  {
    name: 'search',
    expected: expectedIds(...MARCH, (t) => describe(t).toLowerCase().includes('palengke')),
    apply: (p) => p.getByTestId('transactions-search').fill('palengke'),
    clear: (p) => p.getByTestId('transactions-search').fill(''),
  },
  {
    name: 'month navigation',
    expected: expectedIds('2026-02-01', '2026-02-28'),
    apply: (p) => p.getByRole('button', { name: 'View previous month' }).click(),
    clear: (p) => p.getByRole('button', { name: 'View next month' }).click(),
  },
  {
    name: 'accounts',
    panel: true,
    expected: expectedIds(...MARCH, (t) => touches(t, GCASH_ID)),
    apply: (p) => pressIn(p, 'filter_accounts', /^GCash/),
    clear: (p) => pressIn(p, 'filter_accounts', 'All accounts'),
  },
  {
    name: 'transaction types',
    panel: true,
    expected: expectedIds(...MARCH, (t) => t.transaction_type === 'credit'),
    apply: (p) => p.getByRole('group', { name: 'Transaction types' }).getByRole('button', { name: 'Income', exact: true }).click(),
    clear: (p) => p.getByRole('group', { name: 'Transaction types' }).getByRole('button', { name: 'All types', exact: true }).click(),
  },
  {
    name: 'categories',
    panel: true,
    expected: expectedIds(...MARCH, (t) => categoryOf(t) === 'Groceries'),
    apply: (p) => pressIn(p, 'filter_categories', 'Groceries'),
    clear: (p) => pressIn(p, 'filter_categories', 'All categories'),
  },
  {
    name: 'entered by',
    panel: true,
    expected: expectedIds(...MARCH, (t) => t.view === 'full'),
    apply: (p) => p.getByRole('group', { name: 'Entered by' }).getByRole('button', { name: 'Only mine', exact: true }).click(),
    clear: (p) => p.getByRole('group', { name: 'Entered by' }).getByRole('button', { name: 'Everyone', exact: true }).click(),
  },
  {
    name: 'tag',
    panel: true,
    expected: expectedIds(...MARCH, (t) => t.view !== 'limited' && t.tags.some((tag) => tag.id === TRIP_TAG?.id)),
    apply: async (p) => void (await p.getByTestId('tag-filter').selectOption({ label: TRIP_TAG?.name ?? '' })),
    clear: async (p) => void (await p.getByTestId('tag-filter').selectOption({ label: 'All tags' })),
  },
  {
    name: 'custom date range',
    panel: true,
    expected: expectedIds('2026-03-05', '2026-03-07'),
    apply: async (p) => {
      await p.getByLabel('Custom start date').fill('2026-03-05')
      await p.getByLabel('Custom end date').fill('2026-03-07')
    },
    clear: (p) => p.getByRole('button', { name: 'Reset filters', exact: true }).click(),
  },
]

for (const c of CASES) {
  test(`transaction filters and add action retain their behavior: ${c.name}`, async ({ page }) => {
    await open(page)
    expect(c.expected.length, `${c.name}: the fixture tells this filter's rows apart`).toBeGreaterThan(0)
    expect(c.expected, `${c.name}: the fixture tells this filter's rows apart`).not.toEqual(MARCH_IDS)
    await expect.poll(() => listedIds(page), 'the month opens with March, newest first').toEqual(MARCH_IDS)
    if (c.panel) await filtersButton(page).click()
    await c.apply(page)
    await expect.poll(() => listedIds(page), `${c.name}: the rows it keeps, in the list's order`).toEqual(c.expected)
    await shot(page, `filter-${c.name.replace(/\s+/g, '-')}`)
    await c.clear(page)
    await expect.poll(() => listedIds(page), `${c.name}: clearing it restores the original list`).toEqual(MARCH_IDS)
  })
}

test('transaction filters and add action retain their behavior: no match', async ({ page }) => {
  await open(page)
  await page.getByTestId('transactions-search').fill('no such purchase')
  await expect(page.getByText('No transactions found')).toBeVisible()
  expect(await rows(page).count(), 'a search that matches nothing lists no rows').toBe(0)
  await shot(page, 'filter-no-match')
  await page.getByTestId('transactions-search').fill('')
  await expect.poll(() => listedIds(page), 'clearing the search restores the original list').toEqual(MARCH_IDS)
})

test('transaction filters and add action retain their behavior: add transaction', async ({ page }) => {
  await open(page)
  const header = page.getByTestId('page-header')
  const primaries = header.locator('[data-variant="primary"]')
  await expect(primaries).toHaveCount(1)
  await expect(primaries).toHaveText('Add Transaction')
  expect(await page.locator('main [data-variant="primary"]:visible').count(), 'Add Transaction is the only primary on the page').toBe(1)
  await primaries.click()
  await expect(page.getByRole('heading', { name: 'Create Transaction' })).toBeVisible()
  await shot(page, 'add-transaction')
})
