// STU-685: every page shares one title size and one container (docs/design-system.md, "Page"). Each route's root is
// `.page` (the --page-max width, a 12px gutter on a phone and 24px on desktop, 32px between top-level sections), and
// its first block is `PageHeader`: the title in text-2xl 600 on a 44px line, the page's controls grouped on the right.
// The dashboard's tag filter, currency control and period group sit on the title's row on desktop and take the next
// row on a phone. The API is faked in the browser with the shared household fixture; there is no backend.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test } from '@playwright/test'
import type { Locator, Page } from '@playwright/test'
import { household, householdViewRoutes, householdWishlistRoutes, mockHousehold, wishlistRoutes, withDollars, withFiveCurrencies } from './support/fixtures/household'
import type { HouseholdData } from './support/fixtures/household'
import { ITEMS, PLAN_OK } from './support/fixtures/wishlistPlan'
import { addRoutes, apiRoute, sequenceRoute } from './support/mockApi'
import type { ApiRoute } from './support/mockApi'
import { shot } from './support/shot'

// This spec lives in <repo>/frontend/e2e.
const FRONTEND = fileURLToPath(new URL('..', import.meta.url))
const DOC = fs.readFileSync(path.join(FRONTEND, '..', 'docs', 'design-system.md'), 'utf8')

/** The eight routes the ticket names. `/household` and `/wishlist` redirect; each case checks the page it lands on. */
const ROUTES = [
  { name: 'dashboard', path: '/', title: 'Dashboard', lands: '/' },
  { name: 'transactions', path: '/transactions', title: 'Transactions', lands: '/transactions' },
  { name: 'allocations', path: '/allocations', title: 'Allocations', lands: '/allocations' },
  { name: 'accounts', path: '/accounts', title: 'Accounts', lands: '/accounts' },
  { name: 'settings', path: '/settings', title: 'Settings', lands: '/settings' },
  { name: 'forecast', path: '/forecast', title: 'Cash-flow timeline', lands: '/forecast' },
  { name: 'household', path: '/household', title: 'Your household', lands: '/accounts/household' },
  { name: 'wishlist', path: '/wishlist', title: 'Allocations', lands: '/allocations' },
] as const
type PageCase = (typeof ROUTES)[number]

/** Page titles: text-2xl 600 (docs/design-system.md, Type: `text-2xl` 24 / 32 for page titles; weights: 600 titles). */
const TITLE_FONT = { size: '24px', lineHeight: '32px', weight: '600' }

/** The page container's max width, as docs/design-system.md sets the `--page-max` token ("`--page-max` is 1280px"). */
const PAGE_MAX_PX = /`--page-max` is (\d+)px/.exec(DOC)?.[1]
/** The page gutter (docs/design-system.md, "Page"): 12px on a phone, 24px on desktop. */
const GUTTER: Record<string, number> = { phone: 12, desktop: 24 }
/** Space between top-level sections (docs/design-system.md, Spacing: "Sections are separated by 32 of space"). */
const SECTION_GAP = 32

/**
 * Where every page's title sits. <main> starts below the 64px spine band with 16px of air (`.below-nav`, 80px), the
 * page pads its top by 24px, and the title's 44px line centres the 32px h1: 80 + 24 + 6 = 110. The same on every page.
 */
const TITLE_TOP = 80 + 24 + (44 - 32) / 2
/** From the title's bottom to the next block below it: the rest of the 44px title line, then one section gap. */
const TITLE_TO_NEXT = (44 - 32) / 2 + SECTION_GAP
/** The desktop title's left edge: the 1280px page centred in the 1440px viewport, plus the 24px gutter. */
const DESKTOP_TITLE_LEFT = (1440 - 1280) / 2 + 24

/**
 * The dashboard's totals, period headings and the Transactions section order on `origin/main` a90df47 (before this
 * change), with the `household` fixture, read by this spec's own helpers. Identical in both projects.
 */
const BASE_TOTALS = {
  'period-income': '₱33,500.00',
  'period-expenses': '₱51,821.20',
  'period-net-flow': '−₱18,321.20',
  'net-worth': '₱329,764.35',
  'available-cash': '₱343,230.90',
}
const BASE_TRANSACTIONS_SECTIONS = ['due-section', 'transactions-list-card', 'role:status', 'holds:list-sheet']
/**
 * The Allocations tabs, in order, with each tab's create button (in the page header) and its `SectionIntro` heading
 * (STU-796: one layout on every tab).
 */
const ALLOCATION_TABS = [
  { label: 'Recurring', param: 'recurring', action: 'Add recurring entry', intro: 'Recurring entries' },
  { label: 'Budgets', param: 'budgets', action: 'Add budget', intro: 'Budget envelopes' },
  { label: 'Savings', param: 'savings', action: 'Add savings goal', intro: 'Savings & investment targets' },
  { label: 'Wishlist', param: 'wishlist', action: 'Add wishlist item', intro: 'Wishlist' },
] as const

interface Box {
  x: number
  y: number
  width: number
  height: number
}
const top = (b: Box): number => b.y
const bottom = (b: Box): number => b.y + b.height
const right = (b: Box): number => b.x + b.width
const centreY = (b: Box): number => b.y + b.height / 2

async function boxOf(el: Locator): Promise<Box> {
  const b = await el.boundingBox()
  if (!b) throw new Error('element has no box')
  return b
}

/** Opens a route signed in as the household's user, once its title is up, the data has settled and fonts are in. */
async function open(page: Page, r: Pick<PageCase, 'title' | 'lands'> & { path: string }, data: HouseholdData = household, extra: ApiRoute[] = []): Promise<void> {
  await mockHousehold(page, data)
  await addRoutes(page, [...householdViewRoutes(data), ...wishlistRoutes(data), ...extra])
  await page.goto(r.path)
  // The dev server compiles a route's chunk on its first visit; under a full parallel run that can pass 5s.
  await expect(page.getByRole('heading', { level: 1, name: r.title })).toBeVisible({ timeout: 15_000 })
  await expect(page).toHaveURL((url) => url.pathname === r.lands)
  await page.waitForLoadState('networkidle')
  await page.evaluate(() => document.fonts.ready)
}

/** The route's root: the one element <main> renders the page into. */
const pageRoot = (page: Page): Locator => page.locator('main [data-route-root] > *')

/**
 * The top of the first block under the title: the next of the header's own rows (controls that wrapped under the
 * title) or of the page's top-level sections, whichever starts first below the h1. Hidden and empty boxes are skipped.
 */
const nextBlockTop = (page: Page): Promise<number | null> =>
  page.locator('main h1').evaluate((h1) => {
    const titleBottom = h1.getBoundingClientRect().bottom
    const root = document.querySelector('main [data-route-root] > *')
    const header = root ? [...root.children].find((c) => c.contains(h1)) : undefined
    if (!root || !header) return null
    const blocks = [...[...header.children].filter((c) => !c.contains(h1)), ...[...root.children].filter((c) => c !== header)]
    const tops = blocks
      .map((c) => c.getBoundingClientRect())
      .filter((b) => b.height > 0 && b.top >= titleBottom - 0.5)
      .map((b) => b.top)
    return tops.length ? Math.min(...tops) : null
  })

/** The route root's visible top-level sections, in order, as `top bottom` pairs. */
const sectionEdges = (page: Page): Promise<{ key: string; top: number; bottom: number }[]> =>
  pageRoot(page).evaluate((root) =>
    [...root.children]
      .filter((c) => getComputedStyle(c).position !== 'fixed' && c.getBoundingClientRect().height > 0)
      .map((c) => {
        const b = c.getBoundingClientRect()
        const key = c.getAttribute('data-testid') ?? c.querySelector('h1, h2, h3')?.textContent?.trim() ?? c.tagName.toLowerCase()
        return { key, top: b.top, bottom: b.bottom }
      }),
  )

/**
 * A stable key per top-level section of the Transactions page, the header (the block holding the h1) left out: its
 * test id, else its role, else its first heading, else the first test id inside it. Read the same way on main and here.
 */
const transactionsSections = (page: Page): Promise<string[]> =>
  pageRoot(page).evaluate((root) =>
    [...root.children]
      .filter((c) => !c.querySelector('h1') && getComputedStyle(c).position !== 'fixed' && c.getBoundingClientRect().height > 0)
      .map((c) => {
        const id = c.getAttribute('data-testid')
        if (id) return id
        const role = c.getAttribute('role')
        if (role) return `role:${role}`
        const heading = c.querySelector('h2, h3')?.textContent?.trim()
        if (heading) return `heading:${heading}`
        return `holds:${c.querySelector('[data-testid]')?.getAttribute('data-testid') ?? c.tagName.toLowerCase()}`
      }),
  )

/** The dashboard header's controls: the tag filter (its label and select), the currency control and the period group. */
function dashboardControls(page: Page): { title: Locator; tag: Locator; currency: Locator; period: Locator } {
  return {
    title: page.locator('main h1'),
    tag: page.locator('main label').filter({ has: page.getByTestId('tag-filter') }),
    // The segments, or on a phone with more than two currencies the select that replaces them: whichever shows.
    currency: page.locator('[data-testid="currency-control"]:visible, [data-testid="currency-select"]:visible'),
    period: page.getByRole('group', { name: 'Period for actual totals' }),
  }
}

// ─── AC1 ────────────────────────────────────────────────────────────────────────────────────────

for (const r of ROUTES) {
  test(`every page title is the same size: ${r.name}`, async ({ page }) => {
    await open(page, r)
    const h1 = page.locator('main h1')
    expect(await h1.count(), 'one page title').toBe(1)
    const font = await h1.evaluate((e) => {
      const s = getComputedStyle(e)
      return { size: s.fontSize, lineHeight: s.lineHeight, weight: s.fontWeight }
    })
    expect(font, `the ${r.name} title is text-2xl (24px / 32px) at 600, like every page's`).toEqual(TITLE_FONT)
    await shot(page, `title-${r.name}`)
  })
}

// ─── AC2 ────────────────────────────────────────────────────────────────────────────────────────

for (const r of ROUTES) {
  test(`page containers share one rhythm: ${r.name}`, async ({ page }) => {
    await open(page, r)
    const title = await boxOf(page.locator('main h1'))
    expect(Math.abs(top(title) - TITLE_TOP), `the ${r.name} title's top y (${top(title)}) is ${TITLE_TOP}, as on every page`).toBeLessThanOrEqual(0.5)
    const next = await nextBlockTop(page)
    expect(next, `a block follows the ${r.name} title`).not.toBeNull()
    const gap = (next ?? 0) - bottom(title)
    expect(Math.abs(gap - TITLE_TO_NEXT), `the gap from the ${r.name} title to the next block (${gap}) is ${TITLE_TO_NEXT}, as on every page`).toBeLessThanOrEqual(0.5)
    await shot(page, `rhythm-${r.name}`)
  })
}

// ─── AC3 ────────────────────────────────────────────────────────────────────────────────────────

for (const r of ROUTES) {
  test(`page gutters are one token: ${r.name}`, async ({ page }, testInfo) => {
    await open(page, r)
    const title = await boxOf(page.locator('main h1'))
    if (testInfo.project.name === 'phone') {
      expect(title.x, `the ${r.name} title's left edge is the 12px phone gutter`).toBe(GUTTER.phone)
      const widths = await page.evaluate(() => ({ doc: document.documentElement.scrollWidth, root: document.querySelector('main [data-route-root] > *')?.scrollWidth ?? 0 }))
      expect(widths.doc, `the ${r.name} page never scrolls sideways (document scrollWidth)`).toBeLessThanOrEqual(390)
      expect(widths.root, `the ${r.name} page content fits the viewport (page scrollWidth)`).toBeLessThanOrEqual(390)
    } else {
      expect(title.x, `the ${r.name} title's left edge is ${DESKTOP_TITLE_LEFT}, as on every page`).toBe(DESKTOP_TITLE_LEFT)
    }
    await shot(page, `gutter-${r.name}`)
  })
}

// ─── AC4 ────────────────────────────────────────────────────────────────────────────────────────

test('dashboard header is one grouped row', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop', 'the one-row header is the desktop layout')
  // Two currencies, so the dashboard shows its currency control.
  await open(page, ROUTES[0], withDollars(household))
  const c = dashboardControls(page)
  await expect(c.currency).toBeVisible()
  const title = await boxOf(c.title)
  const controls = [
    { name: 'tag filter', box: await boxOf(c.tag) },
    { name: 'currency control', box: await boxOf(c.currency) },
    { name: 'period group', box: await boxOf(c.period) },
  ]
  for (const k of controls) {
    expect(Math.abs(centreY(k.box) - centreY(title)), `the ${k.name}'s centre y is within 2px of the title's`).toBeLessThanOrEqual(2)
    expect(right(title), `the title ends left of the ${k.name}`).toBeLessThan(k.box.x)
  }
  const centres = controls.map((k) => centreY(k.box))
  expect(Math.max(...centres) - Math.min(...centres), 'the three controls share one row (centre y within 2px)').toBeLessThanOrEqual(2)
  const ordered = [...controls].sort((a, b) => a.box.x - b.box.x)
  const gaps = ordered.slice(1).map((k, i) => ({ between: `${ordered[i].name} | ${k.name}`, gap: k.box.x - right(ordered[i].box) }))
  testInfo.annotations.push({ type: 'gaps', description: gaps.map((g) => `${g.between}: ${g.gap}px`).join('; ') })
  for (const g of gaps) {
    expect(g.gap, `${g.between}: no overlap`).toBeGreaterThanOrEqual(0)
    expect(g.gap, `${g.between}: at most 16px apart`).toBeLessThanOrEqual(16)
  }
  const contentRight = await pageRoot(page).evaluate((e) => e.getBoundingClientRect().right - parseFloat(getComputedStyle(e).paddingRight))
  const periodRight = right(controls[2].box)
  expect(Math.abs(periodRight - contentRight), `the period group ends on the page content's right edge (${periodRight} vs ${contentRight})`).toBeLessThanOrEqual(1)
  await shot(page, 'dashboard-header-desktop')
})

// ─── AC5 ────────────────────────────────────────────────────────────────────────────────────────

/** The currency variants the phone header must fit: two currencies keep the segments, five turn them into a select. */
const PHONE_CURRENCY_CASES = [
  { name: 'two currencies', data: withDollars(household), control: 'currency-control', choices: ['PHP', 'USD'] },
  { name: 'five currencies', data: withFiveCurrencies(household), control: 'currency-select', choices: ['PHP', 'USD', 'EUR', 'GBP', 'JPY'] },
] as const

for (const v of PHONE_CURRENCY_CASES) {
  test(`dashboard header stacks cleanly on phone: ${v.name}`, async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'phone', 'the stacked header is the phone layout')
    await open(page, ROUTES[0], v.data)
    const c = dashboardControls(page)
    await expect(c.currency).toHaveCount(1)
    await expect(c.currency).toHaveAttribute('data-testid', v.control)
    const choices = (await c.currency.locator('button, option').allInnerTexts()).map((t) => t.trim())
    expect(choices, `the currency control offers all ${v.choices.length} currencies`).toEqual([...v.choices])
    const title = await boxOf(c.title)
    // The page's first block, the one holding the title.
    const header = pageRoot(page).locator(':scope > *', { has: page.locator('h1') })
    // Nothing else in the header shares the title's row.
    const onTitleRow = await header.evaluate((h, titleBottom) => {
      const h1 = h.querySelector('h1')
      return [...h.querySelectorAll('*')]
        .filter((e) => e !== h1 && !e.contains(h1) && !h1?.contains(e))
        .filter((e) => {
          const b = e.getBoundingClientRect()
          return b.height > 0 && b.width > 0 && b.top < titleBottom
        })
        .map((e) => `${e.tagName.toLowerCase()} ${(e.textContent ?? '').trim().slice(0, 20)}`)
    }, bottom(title))
    expect(onTitleRow, 'the title is alone on the first header row').toEqual([])
    const controls = [
      { name: 'tag filter', box: await boxOf(c.tag) },
      { name: 'currency control', box: await boxOf(c.currency) },
      { name: 'period group', box: await boxOf(c.period) },
    ]
    for (const k of controls) expect(top(k.box), `the ${k.name} sits below the title`).toBeGreaterThanOrEqual(bottom(title))
    const centres = controls.map((k) => centreY(k.box))
    expect(Math.max(...centres) - Math.min(...centres), 'the three controls share the next row (centre y within 2px)').toBeLessThanOrEqual(2)
    const segmentTops = await c.period.locator('button').evaluateAll((all) => all.map((e) => e.getBoundingClientRect().top))
    expect(segmentTops.length, 'three period segments').toBe(3)
    expect(new Set(segmentTops).size, `the period segments share one y (${segmentTops.join(', ')})`).toBe(1)
    const period = await c.period.evaluate((e) => ({ scroll: e.scrollWidth, client: e.clientWidth }))
    expect(period.scroll, 'the period group does not scroll inside').toBeLessThanOrEqual(period.client)
    const headerWidths = await header.evaluate((e) => ({ scroll: e.scrollWidth, client: e.clientWidth }))
    expect(headerWidths.scroll, 'the header does not overflow sideways').toBeLessThanOrEqual(headerWidths.client)
    expect(await page.evaluate(() => document.documentElement.scrollWidth), 'the document does not overflow sideways').toBeLessThanOrEqual(390)
    await shot(page, `dashboard-header-phone-${v.name.replace(' ', '-')}`)
  })
}

// ─── AC6 ────────────────────────────────────────────────────────────────────────────────────────

for (const r of ROUTES) {
  test(`page containers use the specified tokens: ${r.name}`, async ({ page }, testInfo) => {
    await open(page, r)
    const root = pageRoot(page)
    expect(await root.count(), 'one page root').toBe(1)
    expect(await root.evaluate((e) => e.classList.contains('page')), `the ${r.name} root is the .page container`).toBe(true)
    const style = await root.evaluate((e) => {
      const s = getComputedStyle(e)
      return { maxWidth: s.maxWidth, padding: [s.paddingLeft, s.paddingRight] }
    })
    expect(PAGE_MAX_PX, 'docs/design-system.md sets the --page-max token in px').toBeDefined()
    expect(style.maxWidth, `the ${r.name} page is at most --page-max (${PAGE_MAX_PX}px) wide`).toBe(`${PAGE_MAX_PX}px`)
    const gutter = `${GUTTER[testInfo.project.name]}px`
    expect(style.padding, `the ${r.name} page's gutter is ${gutter} on each side`).toEqual([gutter, gutter])
    const sections = await sectionEdges(page)
    expect(sections.length, `the ${r.name} page has a header and at least one section`).toBeGreaterThanOrEqual(2)
    const gaps = sections.slice(1).map((s, i) => `${sections[i].key} -> ${s.key}: ${Math.round((s.top - sections[i].bottom) * 10) / 10}`)
    expect(gaps, `every gap between the ${r.name} page's top-level sections is ${SECTION_GAP}px`).toEqual(sections.slice(1).map((s, i) => `${sections[i].key} -> ${s.key}: ${SECTION_GAP}`))
    await shot(page, `container-${r.name}`)
  })
}

// ─── AC7 ────────────────────────────────────────────────────────────────────────────────────────

test('excluded page features are unchanged: dashboard totals', async ({ page }) => {
  await open(page, ROUTES[0])
  const totals: Record<string, string> = {}
  for (const id of Object.keys(BASE_TOTALS)) totals[id] = (await page.getByTestId(id).innerText()).trim()
  expect(totals, "the dashboard's totals read as they did on main").toEqual(BASE_TOTALS)
  await shot(page, 'unchanged-dashboard')
})

test('excluded page features are unchanged: transactions order', async ({ page }) => {
  await open(page, ROUTES[1])
  await expect(page.locator('article[data-transaction-id]').first()).toBeVisible()
  expect(await transactionsSections(page), "Transactions keeps main's section order").toEqual(BASE_TRANSACTIONS_SECTIONS)
  await shot(page, 'unchanged-transactions')
})

/** The Wishlist tab with items and a purchase plan, so the filter's place ahead of both can be read. */
const POPULATED_WISHLIST: ApiRoute[] = [...householdWishlistRoutes(ITEMS), apiRoute('GET', '/wishlist/plan', PLAN_OK)]

test('excluded page features are unchanged: allocations tabs', async ({ page }, testInfo) => {
  await open(page, ROUTES[2], household, POPULATED_WISHLIST)
  const nav = page.locator('main nav').filter({ has: page.getByRole('button', { name: 'Recurring', exact: true }) })
  const tabs = nav.getByRole('button')
  const labels = (await tabs.allInnerTexts()).map((t) => t.trim())
  expect(labels, 'the Allocations tabs keep their labels and order').toEqual(ALLOCATION_TABS.map((t) => t.label))
  const header = page.getByTestId('page-header')
  const actions = header.getByTestId('page-actions')
  const phone = testInfo.project.name === 'phone'
  const layouts: { tab: string; headerHeight: number; buttonX: number; buttonY: number; buttonWidth: number; buttonHeight: number }[] = []
  for (const [i, tab] of ALLOCATION_TABS.entries()) {
    await tabs.nth(i).click()
    const pressed = await tabs.evaluateAll((all) => all.map((e) => e.getAttribute('aria-pressed')))
    expect(pressed, `${tab.label} is the one selected tab`).toEqual(ALLOCATION_TABS.map((_, j) => String(j === i)))
    await expect(page.getByTestId('section-intro')).toHaveCount(1)

    // One create button, in the page header's actions, with the tab's label.
    expect((await actions.getByRole('button').allInnerTexts()).map((t) => t.trim()), `the ${tab.label} tab's header action`).toEqual([tab.action])
    // No other primary button in the tab body, apart from an empty state's action.
    const strays = await page.locator('main [data-variant="primary"]').evaluateAll((all) =>
      all.filter((e) => !e.closest('[data-testid="page-actions"]') && !e.closest('[data-testid="empty-state"]')).map((e) => (e.textContent ?? '').trim()),
    )
    expect(strays, `the ${tab.label} tab has no other primary button`).toEqual([])

    const h1 = await boxOf(page.locator('main h1'))
    const button = await boxOf(actions.getByRole('button', { name: tab.action, exact: true }))
    if (!phone) expect(Math.abs(top(button) - top(h1)), `the ${tab.label} button's top is within 4px of the title's`).toBeLessThanOrEqual(4)
    const head = await boxOf(header)
    layouts.push({ tab: tab.label, headerHeight: head.height, buttonX: button.x, buttonY: button.y - head.y, buttonWidth: button.width, buttonHeight: button.height })
    const widths = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth }))
    expect(widths.scroll, `the ${tab.label} tab does not overflow sideways`).toBeLessThanOrEqual(widths.client)

    // The one SectionIntro: a text-xl heading and its description, the first block after the tab nav.
    const intro = page.getByTestId('section-intro')
    const heading = intro.getByRole('heading', { level: 2, name: tab.intro, exact: true })
    await expect(heading).toBeVisible()
    await expect(heading, `${tab.label}'s intro heading is text-xl`).toHaveClass(/(^|\s)text-xl(\s|$)/)
    expect(((await intro.locator('p').innerText()) ?? '').trim().length, `${tab.label}'s intro has a description`).toBeGreaterThan(0)
    const between = await nav.evaluate((n, introTop) => {
      const intro = document.querySelector('[data-testid="section-intro"]')
      if (!intro) return ['no intro']
      const navBottom = n.getBoundingClientRect().bottom
      const root = n.closest('.page') ?? document.body
      const follows = !!(n.compareDocumentPosition(intro) & Node.DOCUMENT_POSITION_FOLLOWING)
      const found = [...root.querySelectorAll('*')]
        .filter((e) => !e.contains(intro) && !intro.contains(e) && !n.contains(e))
        .filter((e) => {
          const b = e.getBoundingClientRect()
          return b.height > 0 && b.width > 0 && b.top >= navBottom - 0.5 && b.top < introTop - 0.5
        })
        .map((e) => `${e.tagName.toLowerCase()} ${(e.textContent ?? '').trim().slice(0, 20)}`)
      return follows ? found : ['intro before nav']
    }, (await boxOf(intro)).y)
    expect(between, `nothing sits between the ${tab.label} nav and its intro`).toEqual([])

    // Each toolbar follows the intro, in order.
    const introBottom = bottom(await boxOf(intro))
    if (tab.param === 'recurring') {
      const search = bottom(await boxOf(page.getByTestId('recurring-search')))
      const tag = await boxOf(page.getByTestId('tag-filter'))
      expect(top(await boxOf(page.getByTestId('recurring-search'))), 'the search follows the intro').toBeGreaterThanOrEqual(introBottom)
      expect(top(tag), 'the tag filter follows the search').toBeGreaterThanOrEqual(search)
      expect(top(tag), 'the tag filter is ahead of the first group').toBeLessThan(top(await boxOf(page.getByTestId('kind-section-subscription'))))
    }
    if (tab.param === 'wishlist') {
      const note = page.getByTestId('purchase-note')
      await expect(note).toHaveText('Marking an item purchased does not record the payment. Its estimate moves only once you record the transaction.')
      const filter = await boxOf(page.getByLabel('Show purchased'))
      const noteBox = await boxOf(note)
      expect(top(noteBox) - introBottom, 'the purchase note sits right under the intro').toBeLessThanOrEqual(8)
      expect(top(noteBox), 'the purchase note follows the intro').toBeGreaterThanOrEqual(introBottom)
      expect(top(filter), 'Show purchased follows the note').toBeGreaterThanOrEqual(bottom(noteBox))
      expect(top(await boxOf(page.getByTestId('purchase-plan'))), 'the purchase plan follows the filter').toBeGreaterThanOrEqual(bottom(filter))
      expect(top(await boxOf(page.getByTestId(`wishlist-item-${ITEMS[0].id}`))), 'the item list follows the plan').toBeGreaterThanOrEqual(bottom(await boxOf(page.getByTestId('purchase-plan'))))
    }
    await shot(page, `allocations-tab-${tab.param}`)
  }
  // The header lays out the same on every tab: the same height, and the button in the same place at the same size.
  for (const l of layouts.slice(1)) {
    expect(l.headerHeight, `${l.tab}: header height matches ${layouts[0].tab}`).toBeCloseTo(layouts[0].headerHeight, 0)
    expect(l.buttonY, `${l.tab}: button offset in the header matches`).toBeCloseTo(layouts[0].buttonY, 0)
    // The button's label sets its width on desktop, where it hangs from the same right edge; on a phone it is full width.
    if (phone) {
      expect(l.buttonX, `${l.tab}: button left matches`).toBeCloseTo(layouts[0].buttonX, 0)
      expect(l.buttonWidth, `${l.tab}: button width matches`).toBeCloseTo(layouts[0].buttonWidth, 0)
    } else expect(l.buttonX + l.buttonWidth, `${l.tab}: button right edge matches`).toBeCloseTo(layouts[0].buttonX + layouts[0].buttonWidth, 0)
    expect(l.buttonHeight, `${l.tab}: button height matches`).toBeCloseTo(layouts[0].buttonHeight, 0)
  }
  await shot(page, 'unchanged-allocations')
})

// ─── Allocations create flows ───────────────────────────────────────────────────────────────────

/** Every input, select and radio the Wishlist form shows, as it reads now: the form's defaults, or an item's values. */
const wishlistFormValues = (page: Page): Promise<string[]> =>
  page.locator('form:has(input[placeholder="What are you saving for?"])').locator('input, select, textarea').evaluateAll((all) =>
    all.map((e) => {
      const input = e as HTMLInputElement
      return `${input.type}:${input.name || input.placeholder}:${input.type === 'radio' || input.type === 'checkbox' ? input.checked : input.value}`
    }),
  )

test('allocation header actions preserve create flows', async ({ page }) => {
  const refusal = { body: { detail: 'That card cannot take this installment.' }, status: 422 }
  const created = { body: { ...ITEMS[2], id: 990, name: 'Boiler' }, status: 201 }
  await open(page, ROUTES[2], household, [...POPULATED_WISHLIST, sequenceRoute<unknown>('POST', '/wishlist/', [refusal, created])])
  const api = await addRoutes(page, [])
  const header = page.getByTestId('page-actions')
  const tab = (label: string): Locator => page.locator('main nav').getByRole('button', { name: label, exact: true })
  const overlay = page.locator('.modal-backdrop')

  // Recurring, Budgets and Savings: the header action opens that tab's own form, with its preset.
  await header.getByRole('button', { name: 'Add recurring entry', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Add recurring entry', exact: true })).toBeVisible()
  await page.getByLabel('Close allocation modal').click()
  await expect(overlay).toHaveCount(0)
  await tab('Budgets').click()
  await header.getByRole('button', { name: 'Add budget', exact: true }).click()
  await expect(page.getByRole('heading', { name: /^Create budget envelope/ })).toBeVisible()
  await page.getByLabel('Close allocation modal').click()
  await expect(overlay).toHaveCount(0)
  await tab('Savings').click()
  await header.getByRole('button', { name: 'Add savings goal', exact: true }).click()
  await expect(page.getByRole('heading', { name: /^Create savings tracker/ })).toBeVisible()
  await page.getByLabel('Close allocation modal').click()
  await expect(overlay).toHaveCount(0)

  // Wishlist: the header action opens the add form.
  await tab('Wishlist').click()
  const add = header.getByRole('button', { name: 'Add wishlist item', exact: true })
  const name = page.getByPlaceholder('What are you saving for?')
  await add.click()
  await expect(page.getByRole('heading', { name: 'Add item', exact: true })).toBeVisible()
  const defaults = await wishlistFormValues(page)
  // Cancel closes it.
  await page.getByRole('button', { name: 'Cancel', exact: true }).click()
  await expect(overlay).toHaveCount(0)
  // A failed save keeps the form open with the entered values and the API's reason.
  await add.click()
  expect(await wishlistFormValues(page), 'reopening after a cancel starts from the defaults').toEqual(defaults)
  await name.fill('Boiler')
  await page.getByPlaceholder('0.00').first().fill('18000')
  await page.getByRole('button', { name: 'Add', exact: true }).click()
  await expect(page.getByTestId('wishlist-save-error')).toHaveText('That card cannot take this installment.')
  await expect(name).toHaveValue('Boiler')
  await expect(page.getByPlaceholder('0.00').first()).toHaveValue('18000')
  // Closing and reopening starts fresh, with no earlier error.
  await page.getByRole('button', { name: 'Cancel', exact: true }).click()
  await expect(overlay).toHaveCount(0)
  await add.click()
  await expect(page.getByTestId('wishlist-save-error')).toHaveCount(0)
  expect(await wishlistFormValues(page), 'reopening after a failed save starts from the defaults').toEqual(defaults)
  // A successful save closes it, and sends the entered values.
  await name.fill('Boiler')
  await page.getByPlaceholder('0.00').first().fill('18000')
  await page.getByRole('button', { name: 'Add', exact: true }).click()
  await expect(overlay).toHaveCount(0)
  expect(api.bodies('POST', '/wishlist/')[1], 'the save sends the form as before').toMatchObject({ name: 'Boiler', estimated_cost: 18000, currency: 'PHP', priority: 'medium', payment_plan: 'full' })
  await add.click()
  expect(await wishlistFormValues(page), 'reopening after a save starts from the defaults').toEqual(defaults)
  await page.getByRole('button', { name: 'Cancel', exact: true }).click()
  // Editing opens with that item's own values.
  const first = ITEMS[0]
  await page.getByTestId(`wishlist-item-${first.id}`).getByRole('button', { name: 'Edit', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Edit item', exact: true })).toBeVisible()
  await expect(name).toHaveValue(first.name)
  await page.getByRole('button', { name: 'Cancel', exact: true }).click()
  await expect(overlay).toHaveCount(0)
  await add.click()
  expect(await wishlistFormValues(page), 'adding after an edit starts from the defaults').toEqual(defaults)
  await page.getByRole('button', { name: 'Cancel', exact: true }).click()
})

test('allocation header actions preserve create flows: an empty wishlist', async ({ page }) => {
  const refusal = { body: { detail: 'That card cannot take this installment.' }, status: 422 }
  await open(page, { path: '/allocations?tab=wishlist', title: 'Allocations', lands: '/allocations' }, household, [
    sequenceRoute<unknown>('POST', '/wishlist/', [refusal, refusal, refusal, refusal]),
  ])
  const header = page.getByTestId('page-actions')
  const first = page.getByTestId('empty-state').getByRole('button', { name: 'Add your first item', exact: true })
  const name = page.getByPlaceholder('What are you saving for?')
  const overlay = page.locator('.modal-backdrop')
  await first.click()
  await expect(page.getByRole('heading', { name: 'Add item', exact: true })).toBeVisible()
  const defaults = await wishlistFormValues(page)
  // Cancel, the close button and a backdrop click each close it.
  await page.getByRole('button', { name: 'Cancel', exact: true }).click()
  await expect(overlay).toHaveCount(0)
  await first.click()
  await page.getByLabel('Close wishlist modal').click()
  await expect(overlay).toHaveCount(0)
  await first.click()
  await overlay.click({ position: { x: 4, y: 4 } })
  await expect(overlay).toHaveCount(0)
  // After a failed save, either create action reopens a fresh form with no error.
  for (const reopen of [header.getByRole('button', { name: 'Add wishlist item', exact: true }), first]) {
    await first.click()
    await name.fill('Boiler')
    await page.getByPlaceholder('0.00').first().fill('18000')
    await page.getByRole('button', { name: 'Add', exact: true }).click()
    await expect(page.getByTestId('wishlist-save-error')).toBeVisible()
    await overlay.click({ position: { x: 4, y: 4 } })
    await expect(overlay).toHaveCount(0)
    await reopen.click()
    await expect(page.getByTestId('wishlist-save-error')).toHaveCount(0)
    expect(await wishlistFormValues(page), 'reopening restores the defaults').toEqual(defaults)
    await page.getByRole('button', { name: 'Cancel', exact: true }).click()
    await expect(overlay).toHaveCount(0)
  }
})

test('Page documents the main action rule for tabbed pages', () => {
  const start = DOC.indexOf('### Page')
  expect(start, 'the design system has a Page section').toBeGreaterThanOrEqual(0)
  const next = DOC.slice(start + 1).search(/\n#{2,3} /)
  const section = DOC.slice(start, next === -1 ? undefined : start + 1 + next).replace(/\s+/g, ' ')
  expect(section).toContain("a page's main action sits in `PageHeader` on every tab, and a tab never adds its own header row")
})
