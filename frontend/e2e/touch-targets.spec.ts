// STU-682: every control a phone user taps is at least 44px tall and wide (docs/design-system.md rule 9), and desktop
// density does not grow. The 44px floor is one rule in `index.css`, keyed on a media condition the design system
// records; the phone project (`hasTouch`) matches it and the desktop project does not. The API is faked in the browser
// with the shared household fixture; there is no backend.
//
// The desktop sizes (`DESKTOP_BASE`) were recorded on the PR base, before any app code changed:
// `TOUCH_RECORD=<file> pnpm exec playwright test touch-targets --project=desktop -g "desktop density" --workers=1`
// writes them to <file>. A recording run asserts nothing.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test } from '@playwright/test'
import type { Locator, Page } from '@playwright/test'
import { household, householdViewRoutes, mockHousehold, wishlistRoutes } from './support/fixtures/household'
import { addRoutes } from './support/mockApi'
import { shot } from './support/shot'
import { expandDue } from './support/transactions'

// This spec lives in <repo>/frontend/e2e.
const FRONTEND = fileURLToPath(new URL('..', import.meta.url))
const CSS = fs.readFileSync(path.join(FRONTEND, 'src', 'assets', 'index.css'), 'utf8')
const DOC = fs.readFileSync(path.join(FRONTEND, '..', 'docs', 'design-system.md'), 'utf8')
const RECORD = process.env.TOUCH_RECORD

/** The smallest tap target on a coarse pointer, in CSS px (docs/design-system.md rule 9). */
const MIN_TARGET = 44
/** The phone project's viewport width (playwright.config.ts). */
const PHONE_WIDTH = 390

const PAGES = [
  { key: 'dashboard', path: '/', title: 'Dashboard' },
  { key: 'transactions', path: '/transactions', title: 'Transactions' },
  { key: 'allocations', path: '/allocations', title: 'Allocations' },
] as const
type PageKey = (typeof PAGES)[number]['key']
type PageCase = (typeof PAGES)[number]
const pageOf = (key: PageKey): PageCase => PAGES.find((p) => p.key === key) ?? PAGES[0]

/** Every element a pointer can activate: native controls, links with a target and role-based controls. */
const TARGETS = [
  'button',
  'a[href]',
  'select',
  'input:not([type="hidden"])',
  'textarea',
  'summary',
  '[role="button"]',
  '[role="link"]',
  '[role="tab"]',
  '[role="checkbox"]',
  '[role="radio"]',
  '[role="switch"]',
  '[role="menuitem"]',
  '[role="option"]',
  '[role="combobox"]',
].join(', ')

/**
 * Links inside a sentence are exempt from the floor (WCAG 2.5.8 "inline" exception): the line of text sets their
 * height. Each entry names the page, the link's text and why it is inline. Only a link that the page renders with
 * `display: inline` can match an entry.
 */
const INLINE_LINKS: readonly { page: PageKey; name: string; reason: string }[] = []

/** One tap target as measured: its identity, its clickable box and whether it sits inside a line of text. */
interface Target {
  id: string
  width: number
  height: number
  inline: boolean
  name: string
}

/** Opens a route signed in as the household's user, once its title is up, the data has settled and fonts are in. */
async function open(page: Page, p: PageCase): Promise<void> {
  await mockHousehold(page, household)
  await addRoutes(page, [...householdViewRoutes(household), ...wishlistRoutes(household)])
  await page.goto(p.path)
  await expect(page.getByRole('heading', { level: 1, name: p.title })).toBeVisible({ timeout: 15_000 })
  await page.waitForLoadState('networkidle')
  // STU-687: the Due card opens collapsed; it is expanded so its tabs and row actions are measured too.
  if (p.key === 'transactions') await expandDue(page)
  await page.evaluate(() => document.fonts.ready)
  await page.mouse.move(0, 0)
}

/** Scrolls to the foot of the page and back, so every target below the first screen has rendered and settled. */
async function scrollThrough(page: Page): Promise<void> {
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight))
  await page.waitForLoadState('networkidle')
  await page.evaluate(() => window.scrollTo(0, 0))
}

/**
 * Every visible tap target on the page, in document order, including those below the first screen. A checkbox or
 * radio is measured by its label when the label holds it (the label is what a finger hits). An element hidden from
 * view (`display: none`, `visibility: hidden`, a screen-reader-only clip) is skipped. The identity is the element's
 * test id, or its role and accessible name, with a count for repeats.
 */
const targetsOn = (page: Page): Promise<Target[]> =>
  page.evaluate((selector) => {
    const round = (n: number): number => Math.round(n * 100) / 100
    const nameOf = (e: Element): string =>
      (e.getAttribute('aria-label') ?? ((e instanceof HTMLElement ? e.innerText : '') || e.getAttribute('title') || e.getAttribute('placeholder') || ''))
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 48)
    const seen = new Map<string, number>()
    const found: { id: string; width: number; height: number; inline: boolean; name: string }[] = []
    for (const e of Array.from(document.querySelectorAll(selector))) {
      const toggle = e instanceof HTMLInputElement && (e.type === 'checkbox' || e.type === 'radio')
      const label = toggle ? e.closest('label') : null
      const area: Element = label ?? e
      if (!area.checkVisibility({ checkVisibilityCSS: true }) || area.getClientRects().length === 0) continue
      const box = area.getBoundingClientRect()
      const cs = getComputedStyle(area)
      // Screen-reader-only text (`sr-only`): a 1px clipped box no finger can reach.
      if (box.width <= 1 && box.height <= 1 && cs.position === 'absolute') continue
      const kind = e.getAttribute('role') ?? (e instanceof HTMLInputElement ? `input[${e.type}]` : e.tagName.toLowerCase())
      const testId = e.getAttribute('data-testid')
      const name = nameOf(toggle && label ? label : e)
      const base = testId ? `${kind}#${testId}` : `${kind} "${name}"`
      const n = (seen.get(base) ?? 0) + 1
      seen.set(base, n)
      found.push({
        id: n > 1 ? `${base} (${n})` : base,
        width: round(box.width),
        height: round(box.height),
        inline: e.tagName === 'A' && getComputedStyle(e).display === 'inline',
        name,
      })
    }
    return found
  }, TARGETS)

const isExempt = (p: PageKey, t: Target): boolean => t.inline && INLINE_LINKS.some((l) => l.page === p && l.name === t.name)
const tooSmall = (t: Target): boolean => t.width < MIN_TARGET || t.height < MIN_TARGET

/** Saves a viewport screenshot (fixed layers such as the tab bar drawn where they are) under `shot()`'s naming. */
async function viewportShot(page: Page, name: string): Promise<string> {
  const info = test.info()
  const spec = path.basename(info.file).replace(/\.spec\.ts$/, '')
  const file = path.join(info.project.outputDir, 'screens', `${spec}-${name}-${info.project.name}.png`)
  await page.screenshot({ path: file, animations: 'disabled' })
  return file
}

/** The named phone controls (the audit's list), one entry per control. `find` returns exactly that control. */
const NAMED: readonly { key: string; page: PageKey; find: (page: Page) => Locator }[] = [
  { key: 'Due card Hide', page: 'transactions', find: (p) => p.getByTestId('due-section-toggle') },
  { key: 'Due card Mark paid', page: 'transactions', find: (p) => p.getByTestId('due-section').getByTestId('due-mark-paid').first() },
  { key: 'Due card Change date', page: 'transactions', find: (p) => p.getByTestId('due-section').getByTestId('row-change-date').first() },
  { key: 'recurring entry Charged', page: 'allocations', find: (p) => p.getByTestId('entry-charged-button').first() },
  { key: 'recurring entry Posted', page: 'allocations', find: (p) => p.getByTestId('entry-posted-button').first() },
  ...['Due and overdue', 'Not posted yet', 'Upcoming', 'Subscriptions', 'Installments'].map((tab) => ({
    key: `Due card tab ${tab}`,
    page: 'transactions' as const,
    find: (p: Page) => p.getByTestId('due-section').getByRole('tab', { name: new RegExp(`^${tab}`) }),
  })),
  ...['week', 'month', 'year'].map((period) => ({
    key: `dashboard period segment ${period}`,
    page: 'dashboard' as const,
    find: (p: Page) => p.getByRole('group', { name: 'Period for actual totals' }).getByRole('button', { name: period, exact: true }),
  })),
  { key: 'Transactions month arrow previous', page: 'transactions', find: (p) => p.getByRole('button', { name: 'View previous month' }) },
  { key: 'Transactions month arrow next', page: 'transactions', find: (p) => p.getByRole('button', { name: 'View next month' }) },
  { key: 'Cash-flow card Details link', page: 'dashboard', find: (p) => p.locator('[data-onboarding="cashflow-timeline"]').getByRole('link', { name: 'Details' }) },
]

/**
 * Every tap target's desktop size on the three pages at the PR base, `origin/main` bf2f991, before this ticket's
 * sizing changes: `[identity, width, height]` in CSS px. Recorded with `TOUCH_RECORD` (see the header).
 */
const BASE_COMMIT = 'bf2f991'
const DESKTOP_BASE: Record<PageKey, readonly (readonly [string, number, number])[]> = {
  dashboard: [
    ['a "₱ Tally & Trace"', 142, 28],
    ['a "Dashboard"', 115, 38],
    ['a "Forecast"', 103, 38],
    ['a "Accounts"', 107, 38],
    ['a "Transactions"', 128, 38],
    ['a "Allocations"', 119, 38],
    ['button "Toggle theme"', 36, 36],
    ['button "MS Mara Santos"', 164, 48],
    ['select#tag-filter', 113, 40],
    ['button "Week"', 69, 32],
    ['button "Month"', 72, 32],
    ['button "Year"', 61, 32],
    ['button#quick-balances-edit', 61, 44],
    ['a#quick-balance-tile', 1182, 60],
    ['a#quick-balance-tile (2)', 1182, 61],
    ['a#quick-balance-tile (3)', 1182, 61],
    ['a "Details"', 46, 20],
    ['button#payable-open', 248, 60],
    ['button#payable-open (2)', 248, 60],
    ['button#payable-open (3)', 248, 60],
    ['button#payable-open (4)', 254, 60],
    ['button#payable-open (5)', 268, 60],
    ['button#payable-open (6)', 248, 60],
  ],
  transactions: [
    ['a "₱ Tally & Trace"', 142, 28],
    ['a "Dashboard"', 115, 38],
    ['a "Forecast"', 103, 38],
    ['a "Accounts"', 107, 38],
    ['a "Transactions"', 128, 38],
    ['a "Allocations"', 119, 38],
    ['button "Toggle theme"', 36, 36],
    ['button "MS Mara Santos"', 164, 48],
    ['button "Add Transaction"', 138, 38],
    ['button#due-section-toggle', 47, 26],
    // STU-687 (AC6): the Due tabs share one non-wrapping row, so each grows to fill it.
    ['tab#due-tab-due', 261.59, 32],
    ['tab#due-tab-not-posted', 245.61, 32],
    ['tab#due-tab-upcoming', 224.59, 32],
    ['tab#due-tab-subscriptions', 239.61, 32],
    ['tab#due-tab-installments', 234.59, 32],
    ['button#due-mark-paid', 74, 26],
    ['button#row-change-date', 89, 26],
    ['button#due-pay', 41, 24],
    ['button#view-to-date', 79, 44],
    ['button#view-scheduled', 99, 44],
    // STU-687 (AC4): search, the month picker and Filters share one toolbar row; the search fills what is left.
    ['input[text]#transactions-search', 556, 40],
    ['button "View previous month"', 38, 30],
    ['button "View next month"', 38, 30],
    ['button "Spending breakdown"', 182, 38],
    ['button#transactions-filters-toggle', 91, 38],
    ['button#row', 1230, 57],
    ['button#row (2)', 1230, 57],
    ['button#row (3)', 1230, 57],
    ['button#row (4)', 1230, 57],
    ['button#row (5)', 1230, 57],
    ['button#row (6)', 1230, 57],
    ['button#row (7)', 1230, 57],
    ['button#row (8)', 1230, 57],
    ['button#row (9)', 1230, 57],
    ['button#row (10)', 1230, 57],
    ['button#row (11)', 1230, 57],
    ['button#row (12)', 1230, 57],
    ['button#row (13)', 1230, 57],
    ['button#row (14)', 1230, 57],
    ['button#row (15)', 1230, 57],
    ['button#row (16)', 1230, 57],
    ['button#row (17)', 1230, 57],
    ['button#row (18)', 1230, 57],
    ['button#row (19)', 1230, 56],
    ['button "Previous"', 89, 38],
    ['button "1"', 32, 32],
    ['button "Next"', 64, 38],
    ['select "25 50 100"', 41, 26],
  ],
  allocations: [
    ['a "₱ Tally & Trace"', 142, 28],
    ['a "Dashboard"', 115, 38],
    ['a "Forecast"', 103, 38],
    ['a "Accounts"', 107, 38],
    ['a "Transactions"', 128, 38],
    ['a "Allocations"', 119, 38],
    ['button "Toggle theme"', 36, 36],
    ['button "MS Mara Santos"', 164, 48],
    ['button "Add Recurring Entry"', 163, 38],
    ['button "Recurring"', 96, 36],
    ['button "Budgets"', 85, 36],
    ['button "Savings"', 82, 36],
    ['button "Wishlist"', 84, 36],
    ['input[search]#recurring-search', 1232, 44],
    ['select#tag-filter', 113, 40],
    ['button#row', 1230, 57],
    ['button#entry-charged-button', 66, 24],
    ['button#entry-posted-button', 60, 24],
    ['button#row (2)', 1230, 57],
    ['button#entry-charged-button (2)', 66, 24],
    ['button#entry-posted-button (2)', 60, 24],
    ['button#row (3)', 1230, 56],
    ['button#row (4)', 1230, 57],
    ['button#entry-mark-paid-button', 74, 24],
    ['button#row (5)', 1230, 57],
    ['button#entry-mark-paid-button (2)', 74, 24],
    ['button#row (6)', 1230, 57],
    ['button#entry-mark-paid-button (3)', 74, 24],
    ['button#row (7)', 1230, 57],
    ['button#entry-mark-paid-button (4)', 74, 24],
    ['button#row (8)', 1230, 57],
    ['button#entry-mark-paid-button (5)', 74, 24],
    ['button#row (9)', 1230, 57],
    ['button#entry-mark-paid-button (6)', 74, 24],
    ['button#row (10)', 1230, 57],
    ['button#entry-mark-paid-button (7)', 74, 24],
    ['button#row (11)', 1230, 57],
    ['button#entry-mark-paid-button (8)', 74, 24],
    ['button#row (12)', 1230, 57],
    ['button#entry-mark-paid-button (9)', 74, 24],
    ['button#row (13)', 1230, 56],
    ['button#row (14)', 1230, 56],
    ['button#entry-mark-received-button', 98, 24],
  ],
}

/** The 44px rule's media condition in index.css: the `@media` blocks that set both 44px minimums. */
function cssConditions(): string[] {
  const found = new Set<string>()
  const media = /@media\s+([^{]+)\{/g
  for (let m = media.exec(CSS); m; m = media.exec(CSS)) {
    // The block runs to its matching brace.
    let depth = 1
    let i = media.lastIndex
    while (depth > 0 && i < CSS.length) {
      if (CSS[i] === '{') depth += 1
      else if (CSS[i] === '}') depth -= 1
      i += 1
    }
    const block = CSS.slice(media.lastIndex, i)
    if (/min-height:\s*44px/.test(block) && /min-width:\s*44px/.test(block)) found.add(m[1].trim())
  }
  return [...found]
}

/** The media condition docs/design-system.md rule 9 records, in backticks after `@media`. */
const docCondition = (): string | undefined => /^9\. \*\*Touch targets\*\*[^\n]*\n?[^\n]*`@media ([^`]+)`/m.exec(DOC)?.[1]?.trim()

test.describe('AC1: phone targets are at least 44px', () => {
  for (const c of NAMED) {
    test(`phone targets are at least 44px: ${c.key}`, async ({ page }, testInfo) => {
      test.skip(testInfo.project.name !== 'phone', 'AC1 is about the phone')
      await open(page, pageOf(c.page))
      const control = c.find(page)
      await expect(control).toHaveCount(1)
      await control.scrollIntoViewIfNeeded()
      await expect(control).toBeVisible()
      const box = await control.boundingBox()
      await viewportShot(page, `named-${c.key.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`)
      expect(box?.height ?? 0, `${c.key}: height`).toBeGreaterThanOrEqual(MIN_TARGET)
      expect(box?.width ?? 0, `${c.key}: width`).toBeGreaterThanOrEqual(MIN_TARGET)
    })
  }
})

test.describe('AC2: all phone tap targets are at least 44px', () => {
  for (const p of PAGES) {
    test(`all phone tap targets are at least 44px: ${p.key}`, async ({ page }, testInfo) => {
      test.skip(testInfo.project.name !== 'phone', 'AC2 is about the phone')
      await open(page, p)
      await scrollThrough(page)
      const targets = await targetsOn(page)
      await shot(page, `all-${p.key}`)
      await viewportShot(page, `all-${p.key}-viewport`)
      expect(targets.length, `${p.key}: tap targets found`).toBeGreaterThan(5)
      const offenders = targets.filter((t) => tooSmall(t) && !isExempt(p.key, t)).map((t) => `${t.id}: ${t.width}x${t.height}`)
      expect(offenders, `${p.key}: tap targets under ${MIN_TARGET}px (identity: width x height)`).toEqual([])
    })
  }

  test('all phone tap targets are at least 44px: every exempt link is an inline link on its page', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'phone', 'AC2 is about the phone')
    for (const l of INLINE_LINKS) expect(l.reason.length, `${l.page} "${l.name}": a reason`).toBeGreaterThan(0)
    const pages = [...new Set(INLINE_LINKS.map((l) => l.page))]
    for (const key of pages) {
      await open(page, pageOf(key))
      const targets = await targetsOn(page)
      for (const l of INLINE_LINKS.filter((x) => x.page === key)) {
        expect(targets.some((t) => t.inline && t.name === l.name), `${key} "${l.name}" is an inline link there`).toBe(true)
      }
    }
    await shot(page, 'inline-links')
  })
})

test.describe('AC3: desktop density is unchanged', () => {
  for (const p of PAGES) {
    test(`desktop density is unchanged: ${p.key}`, async ({ page }, testInfo) => {
      test.skip(testInfo.project.name !== 'desktop', 'AC3 is about the desktop')
      await open(page, p)
      await scrollThrough(page)
      const targets = await targetsOn(page)
      await shot(page, `desktop-${p.key}`)
      if (RECORD) {
        const prior = fs.existsSync(RECORD) ? (JSON.parse(fs.readFileSync(RECORD, 'utf8')) as Record<string, unknown>) : {}
        fs.writeFileSync(RECORD, `${JSON.stringify({ ...prior, [p.key]: targets.map((t) => [t.id, t.width, t.height]) }, null, 2)}\n`)
        return
      }
      const base = DESKTOP_BASE[p.key]
      expect(base.length, `${p.key}: sizes recorded at ${BASE_COMMIT}`).toBeGreaterThan(5)
      const now = new Map(targets.map((t) => [t.id, t]))
      const moved = base.flatMap(([id, width, height]) => {
        const t = now.get(id)
        if (!t) return [`${id}: missing`]
        return Math.abs(t.width - width) > 1 || Math.abs(t.height - height) > 1 ? [`${id}: ${width}x${height} at ${BASE_COMMIT}, now ${t.width}x${t.height}`] : []
      })
      expect(moved, `${p.key}: controls more than 1px off their ${BASE_COMMIT} size`).toEqual([])
    })
  }
})

test.describe('AC4: bigger targets cause no horizontal scroll', () => {
  for (const p of PAGES) {
    test(`bigger targets cause no horizontal scroll: ${p.key}`, async ({ page }, testInfo) => {
      test.skip(testInfo.project.name !== 'phone', 'AC4 is about the 390px phone')
      await open(page, p)
      await scrollThrough(page)
      await shot(page, `no-scroll-${p.key}`)
      const width = await page.evaluate(() => document.documentElement.scrollWidth)
      expect(width, `${p.key}: page scroll width`).toBeLessThanOrEqual(PHONE_WIDTH)
    })
  }
})

test.describe('AC5: the phone project meets the 44px media condition', () => {
  test('the phone project meets the 44px media condition', async ({ page }, testInfo) => {
    const conditions = cssConditions()
    expect(conditions, 'index.css has one media condition for the 44px rule').toHaveLength(1)
    const condition = conditions[0] ?? ''
    expect(docCondition(), 'docs/design-system.md rule 9 records the same condition').toBe(condition)
    await open(page, pageOf('dashboard'))
    await shot(page, 'media-condition')
    const matches = await page.evaluate((c) => window.matchMedia(c).matches, condition)
    expect(matches, `matchMedia("${condition}") in the ${testInfo.project.name} project`).toBe(testInfo.project.name === 'phone')
  })
})
