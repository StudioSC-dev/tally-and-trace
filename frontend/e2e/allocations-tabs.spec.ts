// STU-686: the Allocations tab bar (Recurring, Budgets, Savings, Wishlist) sits on one row on a phone. Below `sm` it
// is a four-column grid of equal cells, so no tab wraps, clips or scrolls at 390px or 360px; from `sm` up the tabs keep
// their desktop size. The tabs sit straight under the page header, with no bordered box and no helper line. Their
// semantics are unchanged: pressed buttons (`Segment`, `aria-pressed`) and the `?tab=` URL contract that
// `recurring-search.cjs` checks. The API is faked in the browser with the shared household fixture; there is no backend.
import { expect, test } from '@playwright/test'
import type { Locator, Page } from '@playwright/test'
import { household, householdViewRoutes, householdWishlistRoutes, mockHousehold } from './support/fixtures/household'
import { addRoutes } from './support/mockApi'
import { shot } from './support/shot'

/** The four tabs in order, the `?tab=` value that opens each, and a line only its panel shows (fixture data). */
const TABS = [
  { key: 'recurring', label: 'Recurring', panel: (page: Page): Locator => page.getByTestId('recurring-search') },
  { key: 'budgets', label: 'Budgets', panel: (page: Page): Locator => page.locator('main').getByText('Groceries', { exact: true }) },
  { key: 'savings', label: 'Savings', panel: (page: Page): Locator => page.locator('main').getByText('Emergency fund', { exact: true }) },
  { key: 'wishlist', label: 'Wishlist', panel: (page: Page): Locator => page.locator('main').getByText('Work laptop', { exact: true }) },
] as const
type TabCase = (typeof TABS)[number]
const LABELS = TABS.map((t) => t.label)

/** Every supported `?tab=` value and the tab it selects: `subscriptions` is the older name for Recurring. */
const QUERIES: readonly { query: string; tab: TabCase }[] = [
  { query: 'recurring', tab: TABS[0] },
  { query: 'subscriptions', tab: TABS[0] },
  { query: 'budgets', tab: TABS[1] },
  { query: 'savings', tab: TABS[2] },
  { query: 'wishlist', tab: TABS[3] },
]

/** The leaf token (`--surface`, #F2F5F0) and the spine token (`--accent`, #22483A) as computed colours. */
const LEAF = 'rgb(242, 245, 240)'
const SPINE_RULE = 'rgb(34, 72, 58) 0px -2px 0px 0px inset'

/** The smallest tap target on a coarse pointer (docs/design-system.md rule 9). */
const MIN_TARGET = 44
/** The tallest the desktop bar may be: one row of tabs. */
const DESKTOP_BAR_MAX = 56

const notPhone = (name: string): boolean => name !== 'phone'

async function open(page: Page, query: string | null): Promise<void> {
  await mockHousehold(page, household)
  await addRoutes(page, [...householdViewRoutes(household), ...householdWishlistRoutes()])
  await page.goto(query === null ? '/allocations' : `/allocations?tab=${query}`)
  await expect(page.getByRole('heading', { level: 1, name: 'Allocations' })).toBeVisible({ timeout: 15_000 })
  await page.waitForLoadState('networkidle')
  await page.evaluate(() => document.fonts.ready)
  await page.mouse.move(0, 0)
}

const barOf = (page: Page): Locator => page.locator('main nav').filter({ has: page.getByRole('button', { name: 'Recurring', exact: true }) })
const tabsOf = (page: Page): Locator => barOf(page).getByRole('button')
const tabOf = (page: Page, label: string): Locator => barOf(page).getByRole('button', { name: label, exact: true })

/** One tab's box, its own overflow and its label's laid-out text box (a Range over its contents). */
interface TabMetrics {
  label: string
  left: number
  right: number
  top: number
  width: number
  height: number
  scrollWidth: number
  clientWidth: number
  textOverflow: string
  textLeft: number
  textRight: number
  textWidth: number
}

const measure = (page: Page): Promise<TabMetrics[]> =>
  tabsOf(page).evaluateAll((all) =>
    all.map((e) => {
      const box = e.getBoundingClientRect()
      const range = document.createRange()
      range.selectNodeContents(e)
      const text = range.getBoundingClientRect()
      return {
        label: (e.textContent ?? '').trim(),
        left: box.left,
        right: box.right,
        top: box.top,
        width: box.width,
        height: box.height,
        scrollWidth: e.scrollWidth,
        clientWidth: e.clientWidth,
        textOverflow: getComputedStyle(e).textOverflow,
        textLeft: text.left,
        textRight: text.right,
        textWidth: text.width,
      }
    }),
  )

/** The bar's own overflow and height, and the border widths of the element that holds it. */
const barMetrics = (page: Page): Promise<{ scrollWidth: number; clientWidth: number; height: number; parentBorder: string[] }> =>
  barOf(page).evaluate((bar) => {
    const parent = bar.parentElement
    const cs = parent ? getComputedStyle(parent) : null
    return {
      scrollWidth: bar.scrollWidth,
      clientWidth: bar.clientWidth,
      height: bar.getBoundingClientRect().height,
      parentBorder: cs ? [cs.borderTopWidth, cs.borderRightWidth, cs.borderBottomWidth, cs.borderLeftWidth] : [],
    }
  })

const docWidth = (page: Page): Promise<number> => page.evaluate(() => document.documentElement.scrollWidth)
const spread = (values: number[]): number => Math.max(...values) - Math.min(...values)

/** The AC1 checks: four tabs, in order, on one row, at one height and one width. */
async function expectOneRow(page: Page, view: string): Promise<void> {
  const tabs = await measure(page)
  expect(tabs.map((t) => t.label), `${view}: the four tabs, in order`).toEqual(LABELS)
  expect(spread(tabs.map((t) => t.top)), `${view}: the tabs' tops are within 1px (one row): ${tabs.map((t) => t.top).join(', ')}`).toBeLessThanOrEqual(1)
  expect(spread(tabs.map((t) => t.height)), `${view}: the tabs have one height: ${tabs.map((t) => t.height).join(', ')}`).toBeLessThanOrEqual(0.5)
  expect(spread(tabs.map((t) => t.width)), `${view}: the tabs' widths are within 1px: ${tabs.map((t) => t.width).join(', ')}`).toBeLessThanOrEqual(1)
}

/** The AC2 checks against a viewport `width` wide: every tab in view, none scrolling, every label whole. */
async function expectNoneClipped(page: Page, view: string, width: number): Promise<void> {
  const tabs = await measure(page)
  expect(tabs.length, `${view}: four tabs measured`).toBe(4)
  for (const t of tabs) {
    expect(t.left, `${view}: ${t.label} starts at or right of x 0`).toBeGreaterThanOrEqual(0)
    expect(t.right, `${view}: ${t.label} ends at or left of x ${width}`).toBeLessThanOrEqual(width)
    expect(t.scrollWidth, `${view}: ${t.label} does not overflow its own box`).toBeLessThanOrEqual(t.clientWidth)
    expect(t.textOverflow, `${view}: ${t.label} is not ellipsised`).not.toBe('ellipsis')
    expect(t.textWidth, `${view}: ${t.label}'s text (${t.textWidth}px) fits its tab (${t.width}px)`).toBeLessThanOrEqual(t.width)
    expect(t.textLeft >= t.left && t.textRight <= t.right, `${view}: ${t.label}'s text lies inside its tab (${t.textLeft}-${t.textRight} in ${t.left}-${t.right})`).toBe(true)
  }
}

/** The AC3 checks against a viewport `width` wide: the page does not scroll sideways and the bar is not a scroller. */
async function expectNoSideScroll(page: Page, view: string, width: number): Promise<void> {
  expect(await docWidth(page), `${view}: the document is at most ${width}px wide`).toBeLessThanOrEqual(width)
  const bar = await barMetrics(page)
  expect(bar.scrollWidth, `${view}: the tab bar's content fits it (${bar.scrollWidth} <= ${bar.clientWidth})`).toBeLessThanOrEqual(bar.clientWidth)
}

for (const view of TABS) {
  test(`allocations tabs sit on one row at 390: ${view.key}`, async ({ page }, testInfo) => {
    test.skip(notPhone(testInfo.project.name), 'AC1 is a phone check')
    await open(page, view.key)
    await expect(tabOf(page, view.label)).toHaveAttribute('aria-pressed', 'true')
    expect(page.viewportSize()?.width, 'the phone viewport').toBe(390)
    await expectOneRow(page, view.key)
    await shot(page, `one-row-390-${view.key}`)
  })
}

for (const view of TABS) {
  test(`no tab is clipped or truncated: ${view.key}`, async ({ page }, testInfo) => {
    test.skip(notPhone(testInfo.project.name), 'AC2 is a phone check')
    await open(page, view.key)
    await expect(tabOf(page, view.label)).toHaveAttribute('aria-pressed', 'true')
    await expectNoneClipped(page, view.key, 390)
    await shot(page, `not-clipped-390-${view.key}`)
  })
}

for (const view of TABS) {
  test(`no horizontal scroll from the tab bar: ${view.key}`, async ({ page }, testInfo) => {
    test.skip(notPhone(testInfo.project.name), 'AC3 is a phone check')
    await open(page, view.key)
    await expect(tabOf(page, view.label)).toHaveAttribute('aria-pressed', 'true')
    await expectNoSideScroll(page, view.key, 390)
    await shot(page, `no-side-scroll-390-${view.key}`)
  })
}

for (const view of TABS) {
  test(`tabs still fit at 360 wide: ${view.key}`, async ({ page }, testInfo) => {
    test.skip(notPhone(testInfo.project.name), 'AC4 is a phone check')
    await page.setViewportSize({ width: 360, height: 740 })
    await open(page, view.key)
    await expect(tabOf(page, view.label)).toHaveAttribute('aria-pressed', 'true')
    expect(page.viewportSize()?.width, 'the narrow phone viewport').toBe(360)
    await expectOneRow(page, `${view.key} at 360`)
    await expectNoneClipped(page, `${view.key} at 360`, 360)
    await expectNoSideScroll(page, `${view.key} at 360`, 360)
    await shot(page, `fit-360-${view.key}`)
  })
}

test('tabs are touch-sized and one row on desktop: phone 390', async ({ page }, testInfo) => {
  test.skip(notPhone(testInfo.project.name), 'the 44px floor applies to the phone')
  await open(page, null)
  const tabs = await measure(page)
  expect(tabs.map((t) => t.label), 'the four tabs').toEqual(LABELS)
  for (const t of tabs) {
    expect(t.height, `${t.label} is at least ${MIN_TARGET}px high`).toBeGreaterThanOrEqual(MIN_TARGET)
    expect(t.width, `${t.label} is at least ${MIN_TARGET}px wide`).toBeGreaterThanOrEqual(MIN_TARGET)
  }
  await shot(page, 'touch-sized-390')
})

test('tabs are touch-sized and one row on desktop: desktop 1440', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop', 'the desktop row is a 1440px check')
  await open(page, null)
  expect(page.viewportSize()?.width, 'the desktop viewport').toBe(1440)
  const tabs = await measure(page)
  expect(tabs.map((t) => t.label), 'the four tabs').toEqual(LABELS)
  expect(spread(tabs.map((t) => t.top)), `the tabs share one row: ${tabs.map((t) => t.top).join(', ')}`).toBeLessThanOrEqual(1)
  expect((await barMetrics(page)).height, `the bar is at most ${DESKTOP_BAR_MAX}px high`).toBeLessThanOrEqual(DESKTOP_BAR_MAX)
  await shot(page, 'one-row-1440')
})

for (const view of TABS) {
  test(`tab bar has no helper copy: ${view.key}`, async ({ page }) => {
    await open(page, view.key)
    await expect(tabOf(page, view.label)).toHaveAttribute('aria-pressed', 'true')
    await expect(page.getByText('Switch tabs to view')).toHaveCount(0)
    expect((await barMetrics(page)).parentBorder, "the tab bar's parent has no border").toEqual(['0px', '0px', '0px', '0px'])
    await shot(page, `no-helper-${view.key}`)
  })
}

/** Asserts that `selected` is the only pressed tab and that only its panel is shown. */
async function expectSelected(page: Page, selected: TabCase, how: string): Promise<void> {
  await expect(tabOf(page, selected.label)).toHaveAttribute('aria-pressed', 'true')
  expect(await tabsOf(page).evaluateAll((all) => all.map((e) => e.getAttribute('aria-pressed'))), `${how}: aria-pressed is set on ${selected.label} only`).toEqual(TABS.map((t) => String(t.key === selected.key)))
  await expect(selected.panel(page).first()).toBeVisible()
  for (const other of TABS.filter((t) => t.key !== selected.key)) {
    await expect(other.panel(page), `${how}: the ${other.label} panel is not shown`).toHaveCount(0)
  }
}

for (const q of QUERIES) {
  test(`tab switching still works: ?tab=${q.query} selects ${q.tab.label}`, async ({ page }) => {
    await open(page, q.query)
    await expectSelected(page, q.tab, `?tab=${q.query}`)
    await shot(page, `switch-query-${q.query}`)
  })
}

for (const target of TABS) {
  test(`tab switching still works: clicking ${target.label}`, async ({ page }) => {
    // Start on another tab, so the click is what selects the target.
    const start = target.key === 'wishlist' ? 'recurring' : 'wishlist'
    await open(page, start)
    await expect(tabOf(page, target.label)).toHaveAttribute('aria-pressed', 'false')
    await tabOf(page, target.label).click()
    await expectSelected(page, target, `after clicking ${target.label}`)
    await shot(page, `switch-click-${target.key}`)
  })
}

for (const view of TABS) {
  test(`selected tab uses the spine rule: ${view.key}`, async ({ page }) => {
    await open(page, view.key)
    const tab = tabOf(page, view.label)
    await expect(tab).toHaveAttribute('aria-pressed', 'true')
    await expect.poll(() => tab.evaluate((e) => getComputedStyle(e).backgroundColor), `${view.label} has the leaf background`).toBe(LEAF)
    await expect.poll(() => tab.evaluate((e) => getComputedStyle(e).boxShadow), `${view.label} has the 2px spine rule, inset at its foot`).toBe(SPINE_RULE)
    await shot(page, `spine-rule-${view.key}`)
  })
}
