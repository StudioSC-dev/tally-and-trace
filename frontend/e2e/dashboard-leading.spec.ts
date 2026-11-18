// STU-688: the dashboard leads with one figure. A leaf panel under the header holds "Available cash" as the largest
// text on the page (`text-3xl`, 32 / 40 at 600, docs/design-system.md "Type": "the leading figure"), with the selected
// period's In, Out and Net as ruled lines under it. The quick balances come second and the Cash-flow timeline third
// ("Layout concept"). The API is faked in the browser with the shared household fixture; there is no backend.
import path from 'node:path'
import { expect, test } from '@playwright/test'
import type { Locator, Page } from '@playwright/test'
import { PROJECTION, household, mockHousehold, periodSummaryFor, periodSummaryRoute, withFxNotice, withProjection } from './support/fixtures/household'
import type { HouseholdData } from './support/fixtures/household'
import { addRoutes } from './support/mockApi'
import { shot } from './support/shot'

/** How long a page may take to first render: the dev server compiles each route on its first visit. */
const READY_MS = 15_000

/** The first viewport's height in each project (playwright.config.ts). */
const VIEWPORT_HEIGHT: Record<string, number> = { desktop: 900, phone: 844 }

/** The leading figure's type (docs/design-system.md, Type: `text-3xl` 32 / 40, "the leading figure"; 600 figures). */
const LEADING_FONT = { size: '32px', lineHeight: '40px', weight: '600' }

/** The fixture's peso balances today: available cash is the figure the dashboard leads with. */
const BALANCES = household.snapshot.balances.by_currency[0]

/**
 * The dashboard's period windows on the fixture's Manila day (2026-03-12), by day: a week is the last 7 days including
 * today, a month and a year run from their first day to today.
 */
const WINDOWS = {
  week: { start: '2026-03-06', end: '2026-03-12' },
  month: { start: '2026-03-01', end: '2026-03-12' },
  year: { start: '2026-01-01', end: '2026-03-12' },
} as const
type Period = keyof typeof WINDOWS

/** A peso amount as the app writes it: a minus sign (U+2212) before a negative, grouped digits, two decimals. */
const peso = (amount: number): string =>
  `${amount < 0 ? '−' : ''}₱${Math.abs(amount).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

/** The In, Out and Net texts the fixture gives for a period. */
function expectedTotals(period: Period): string[] {
  const row = periodSummaryFor(household, WINDOWS[period].start, WINDOWS[period].end).by_currency[0]
  return [peso(row.total_income), peso(row.total_expenses), peso(row.net_flow)]
}

const leading = (page: Page): Locator => page.getByTestId('leading-figure')
const figure = (page: Page): Locator => page.getByTestId('leading-figure-amount')
const quickBalances = (page: Page): Locator => page.getByTestId('quick-balances')
const timeline = (page: Page): Locator => page.locator('[data-onboarding="cashflow-timeline"]')
/** The In, Out and Net values, in that order. */
const totals = (page: Page): Locator[] => ['period-income', 'period-expenses', 'period-net-flow'].map((id) => leading(page).getByTestId(id))
const totalsText = async (page: Page): Promise<string[]> => Promise.all(totals(page).map(async (t) => (await t.innerText()).trim()))

/** Opens the dashboard signed in, once the leading figure, the quick balances and the fonts are in. */
async function open(page: Page, data: HouseholdData = household, extra: () => Promise<unknown> = async () => undefined): Promise<void> {
  await mockHousehold(page, data)
  await extra()
  await page.goto('/')
  await expect(figure(page)).toBeVisible({ timeout: READY_MS })
  await expect(page.getByTestId('quick-balance-tile').first()).toBeVisible({ timeout: READY_MS })
  await page.waitForLoadState('networkidle')
  await page.evaluate(() => document.fonts.ready)
}

/** A screenshot of the first viewport only, saved under `shot()`'s naming. */
async function viewportShot(page: Page, name: string): Promise<void> {
  const info = test.info()
  const spec = path.basename(info.file).replace(/\.spec\.ts$/, '')
  await page.screenshot({ path: path.join(info.project.outputDir, 'screens', `${spec}-${name}-${info.project.name}.png`), animations: 'disabled' })
}

async function boxOf(el: Locator): Promise<{ x: number; y: number; width: number; height: number }> {
  const b = await el.boundingBox()
  if (!b) throw new Error('element has no box')
  return b
}

// ─── AC1 ────────────────────────────────────────────────────────────────────────────────────────

test('leading figure is in the first viewport', async ({ page }, testInfo) => {
  await open(page)
  const box = await boxOf(leading(page))
  const height = VIEWPORT_HEIGHT[testInfo.project.name]
  expect(box.y, 'the leading panel starts inside the first viewport').toBeGreaterThanOrEqual(0)
  expect(box.y + box.height, `the leading panel's bottom is at most ${height}, inside the first viewport`).toBeLessThanOrEqual(height)
  await expect(leading(page), 'the panel names its figure').toContainText('Available cash')
  await expect(figure(page), "the figure is the fixture's available cash").toHaveText(peso(BALANCES.available_cash))
  await expect(leading(page), "the panel shows the fixture's peso figure").toContainText(peso(BALANCES.available_cash))
  await viewportShot(page, 'first-viewport')
})

// ─── AC2 ────────────────────────────────────────────────────────────────────────────────────────

test('the leading figure is the largest text', async ({ page }) => {
  await open(page)
  const font = await figure(page).evaluate((e) => {
    const s = getComputedStyle(e)
    return { size: s.fontSize, lineHeight: s.lineHeight, weight: s.fontWeight }
  })
  expect(font, 'the leading figure is text-3xl (32px / 40px) at 600').toEqual(LEADING_FONT)
  // Every visible element that draws text of its own, other than the figure, with its computed font size.
  const large = await page.evaluate(() => {
    const own = (e: Element): string => [...e.childNodes].filter((n) => n.nodeType === Node.TEXT_NODE).map((n) => n.textContent ?? '').join('').trim()
    return [...document.body.querySelectorAll('*')]
      .filter((e) => e.getAttribute('data-testid') !== 'leading-figure-amount' && own(e) !== '')
      .filter((e) => {
        const r = e.getBoundingClientRect()
        const s = getComputedStyle(e)
        return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none'
      })
      .filter((e) => parseFloat(getComputedStyle(e).fontSize) >= 32)
      .map((e) => `${e.tagName.toLowerCase()} "${own(e).slice(0, 30)}" ${getComputedStyle(e).fontSize}`)
  })
  expect(large, 'no other visible text on the dashboard is 32px or larger').toEqual([])
  await shot(page, 'largest-text')
})

// ─── AC3 ────────────────────────────────────────────────────────────────────────────────────────

/** Each period, reached by the toggle from another one: the default month, or the week for the month itself. */
const PERIOD_CASES: readonly { period: Period; from: Period }[] = [
  { period: 'week', from: 'month' },
  { period: 'month', from: 'week' },
  { period: 'year', from: 'month' },
]

for (const c of PERIOD_CASES) {
  test(`period totals sit with the leading figure: ${c.period}`, async ({ page }) => {
    await open(page, household, () => addRoutes(page, [periodSummaryRoute(household)]))
    const group = page.getByRole('group', { name: 'Period for actual totals' })
    const want = expectedTotals(c.period)
    const before = expectedTotals(c.from)
    expect(want, `the fixture's ${c.period} totals differ from its ${c.from} totals`).not.toEqual(before)
    if (c.from !== 'month') await group.getByRole('button', { name: c.from }).click()
    await expect.poll(() => totalsText(page), { message: `the panel starts on the ${c.from} totals` }).toEqual(before)
    await group.getByRole('button', { name: c.period }).click()
    await expect.poll(() => totalsText(page), { message: `the toggle changes In, Out and Net to the ${c.period} totals` }).toEqual(want)
    for (const t of totals(page)) await expect(t, 'each period value is inside the leading panel').toHaveCount(1)
    const rights = await Promise.all(totals(page).map(async (t) => {
      const b = await boxOf(t)
      return b.x + b.width
    }))
    expect(Math.max(...rights) - Math.min(...rights), `In, Out and Net share one right edge (${rights.join(', ')})`).toBeLessThanOrEqual(1)
    await shot(page, `period-${c.period}`)
  })
}

// ─── AC4 ────────────────────────────────────────────────────────────────────────────────────────

test('dashboard order is figure, accounts, chart', async ({ page }) => {
  await open(page)
  await expect(timeline(page)).toBeVisible()
  const sections = [leading(page), quickBalances(page), timeline(page)]
  const handles = await Promise.all(sections.map((s) => s.elementHandle()))
  const following = await page.evaluate(([a, b, c]) => {
    const follows = (x: Node | null, y: Node | null): boolean => !!x && !!y && (x.compareDocumentPosition(y) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0
    return [follows(a, b), follows(b, c)]
  }, handles)
  expect(following, 'in the document: the leading figure, then the quick balances, then the Cash-flow timeline').toEqual([true, true])
  const ys = await Promise.all(sections.map(async (s) => (await boxOf(s)).y))
  expect(ys[0], `the quick balances (y ${ys[1]}) sit below the leading figure (y ${ys[0]})`).toBeLessThan(ys[1])
  expect(ys[1], `the Cash-flow timeline (y ${ys[2]}) sits below the quick balances (y ${ys[1]})`).toBeLessThan(ys[2])
  await shot(page, 'order')
})

// ─── AC5 ────────────────────────────────────────────────────────────────────────────────────────

/**
 * The snapshot held on the busy month, and on the same month with exchange-rate facts, whose FX notice only appears once
 * the snapshot lands: neither may move the quick balances.
 */
const HELD_CASES: readonly { name: string; data: HouseholdData; fx: boolean }[] = [
  { name: 'busy month', data: household, fx: false },
  { name: 'with an FX notice', data: withFxNotice(household), fx: true },
]

for (const c of HELD_CASES) {
  test(`leading figure waits for the snapshot: ${c.name}`, async ({ page }) => {
    // Every text the figure ever shows, from the first document on.
    await page.addInitScript(() => {
      const seen: string[] = []
      ;(window as unknown as { __leadingTexts: string[] }).__leadingTexts = seen
      new MutationObserver(() => {
        const text = document.querySelector('[data-testid="leading-figure-amount"]')?.textContent?.trim()
        if (text !== undefined && seen[seen.length - 1] !== text) seen.push(text)
      }).observe(document, { subtree: true, childList: true, characterData: true })
    })
    await mockHousehold(page, c.data)
    let release = (): void => undefined
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    await page.route((url) => url.pathname.endsWith('/api/v1/dashboard/snapshot'), async (route) => {
      await held
      await route.fallback()
    })
    await page.goto('/')
    const panel = leading(page)
    const pending = panel.getByTestId('leading-figure-pending')
    await expect(pending).toBeVisible({ timeout: READY_MS })
    await expect(page.getByTestId('quick-balance-tile').first()).toBeVisible({ timeout: READY_MS })
    await page.evaluate(() => document.fonts.ready)
    await expect(pending.getByRole('status'), 'the placeholder is announced as a status').toHaveText('Loading available cash')
    const heldText = await panel.innerText()
    expect(heldText, 'no zero figure while the snapshot is held').not.toContain('0.00')
    expect(heldText, 'no peso zero while the snapshot is held').not.toContain('₱0')
    expect(heldText, 'no figure at all while the snapshot is held').not.toMatch(/\d/)
    await expect(figure(page)).toHaveCount(0)
    await shot(page, `snapshot-held-${c.fx ? 'fx' : 'plain'}`)
    const heldY = (await boxOf(quickBalances(page))).y
    release()
    await expect(figure(page), "the figure lands as the fixture's available cash").toHaveText(peso(BALANCES.available_cash))
    await expect(pending).toHaveCount(0)
    if (c.fx) await expect(page.getByTestId('fx-notice'), 'the snapshot brings its FX notice').toBeVisible()
    await page.waitForLoadState('networkidle')
    const landedY = (await boxOf(quickBalances(page))).y
    expect(Math.abs(landedY - heldY), `the quick balances move ${landedY - heldY}px when the snapshot lands`).toBeLessThanOrEqual(4)
    const history = await page.evaluate(() => (window as unknown as { __leadingTexts: string[] }).__leadingTexts)
    expect(history, 'the figure only ever shows the fixture value, never a zero first').toEqual([peso(BALANCES.available_cash)])
    await shot(page, `snapshot-released-${c.fx ? 'fx' : 'plain'}`)
  })
}

// ─── AC6 ────────────────────────────────────────────────────────────────────────────────────────

test('totals appear once', async ({ page }) => {
  const data = withProjection(household)
  await open(page, data)
  const labels = (await leading(page).locator('dt').allInnerTexts()).map((t) => t.trim())
  expect(labels, 'the leading panel has one In, one Out and one Net row').toEqual(['In', 'Out', 'Net'])
  const main = await page.locator('main').innerText()
  for (const old of ['Total income', 'Total expenses', 'Net flow']) {
    expect(main, `"${old}" appears nowhere on the dashboard`).not.toContain(old)
  }
  // The projection keeps its labels and the fixture's figures, below the Cash-flow timeline.
  const projection = page.getByTestId('projection')
  const projected = data.snapshot.forecast_next_3_months[0].by_currency[0]
  const rows = await projection.locator(':scope > div').evaluateAll((all) =>
    all.map((row) => [row.querySelector('dt')?.textContent?.trim() ?? '', row.querySelector('dd')?.textContent?.trim() ?? '']),
  )
  expect(rows, 'the projection keeps its labels and fixture-driven values').toEqual([
    ['Available cash', peso(BALANCES.available_cash)],
    ['Projected recurring income (rest of month)', peso(PROJECTION.income)],
    ['Projected net flow (today to month end)', peso(projected.net)],
    ['Projected month-end cash', peso(projected.closing_balance)],
  ])
  const timelineBottom = await boxOf(timeline(page)).then((b) => b.y + b.height)
  expect((await boxOf(projection)).y, 'the projection sits below the Cash-flow timeline').toBeGreaterThan(timelineBottom)
  await shot(page, 'totals-once')
})
