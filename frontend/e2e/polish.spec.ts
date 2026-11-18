// STU-692: motion, focus, empty states and status as a dot and a word. Motion only answers an action and honours
// reduced motion, focus is visible for keyboards and quiet for mice, empty states invite the next step, and a state is
// shown as a dot and a word. The API is faked in the browser with the shared household fixture; there is no backend.
import path from 'node:path'
import { expect, test } from '@playwright/test'
import type { Locator, Page } from '@playwright/test'
import {
  emptyHousehold,
  household,
  householdDialogRoutes,
  householdSaveRoutes,
  householdWishlistRoutes,
  mockHousehold,
  noAccountsHousehold,
  noEnvelopesHousehold,
  STATUS_STATE_IDS,
  viewerEmptyHousehold,
  withStatusStates,
} from './support/fixtures/household'
import type { HouseholdData } from './support/fixtures/household'
import { addRoutes } from './support/mockApi'
import type { ApiMock, ApiRoute } from './support/mockApi'
import { shot } from './support/shot'

// Token values from docs/design-system.md, as computed rgb().
const ACCENT = { light: 'rgb(34, 72, 58)', dark: 'rgb(147, 205, 169)' }
const DANGER = 'rgb(174, 42, 32)'
const WARN = 'rgb(135, 80, 0)'
const OK = 'rgb(42, 100, 64)'
const MUTED = 'rgb(74, 89, 80)'
const SURFACE = 'rgb(242, 245, 240)'
const LINE = 'rgb(188, 201, 184)'
const TRANSPARENT = 'rgba(0, 0, 0, 0)'

type Scheme = 'light' | 'dark'
const SCHEMES: Scheme[] = ['light', 'dark']

/** A spinner is the one thing allowed to turn while a page loads. */
const SPINNER = '.animate-spin, .loading-spinner, [data-testid="spinner"]'

/** A viewport screenshot (a full-page one draws a fixed layer at the scroll offset), saved like `shot()`. */
async function viewportShot(page: Page, name: string): Promise<string> {
  const info = test.info()
  const spec = path.basename(info.file).replace(/\.spec\.ts$/, '')
  const file = path.join(info.project.outputDir, 'screens', `${spec}-${name}-${info.project.name}.png`)
  await page.screenshot({ path: file, animations: 'disabled' })
  return file
}

const slug = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')

interface OpenOptions {
  data?: HouseholdData
  extra?: ApiRoute[]
  scheme?: Scheme
  reducedMotion?: 'reduce' | 'no-preference'
}

/** Signs in, fakes the API from `data` (plus the wishlist and `extra`), opens `url` and waits for its heading. */
async function open(page: Page, url: string, heading: string, options: OpenOptions = {}): Promise<ApiMock> {
  const { data = household, extra = [], scheme = 'light', reducedMotion = 'no-preference' } = options
  await page.emulateMedia({ colorScheme: scheme, reducedMotion })
  const api = await mockHousehold(page, data)
  await addRoutes(page, [...householdWishlistRoutes(), ...extra])
  await page.goto(url)
  // The preview server serves each route's chunk on first visit; under a full parallel run that can pass 5s.
  await expect(page.getByRole('heading', { level: 1, name: heading })).toBeVisible({ timeout: 15_000 })
  await page.waitForLoadState('networkidle')
  return api
}

/** The covered routes: the four pages, with Allocations on each of its four tabs. */
const ROUTES = [
  { name: 'Dashboard', url: '/', heading: 'Dashboard' },
  { name: 'Transactions', url: '/transactions', heading: 'Transactions' },
  { name: 'Accounts', url: '/accounts', heading: 'Accounts' },
  { name: 'Allocations Recurring', url: '/allocations?tab=recurring', heading: 'Allocations' },
  { name: 'Allocations Budgets', url: '/allocations?tab=budgets', heading: 'Allocations' },
  { name: 'Allocations Savings', url: '/allocations?tab=savings', heading: 'Allocations' },
  { name: 'Allocations Wishlist', url: '/allocations?tab=wishlist', heading: 'Allocations' },
] as const

/** Every running animation or transition that is not a spinner, as "kind name on tag.classes". */
const runningMotion = (page: Page): Promise<string[]> =>
  page.evaluate((spinner) => {
    const out: string[] = []
    for (const a of document.getAnimations()) {
      if (a.playState !== 'running') continue
      const target = (a.effect as KeyframeEffect | null)?.target ?? null
      if (target instanceof Element && target.closest(spinner)) continue
      const kind = a instanceof CSSAnimation ? `animation ${a.animationName}` : a instanceof CSSTransition ? `transition ${a.transitionProperty}` : 'script animation'
      const where = target instanceof Element ? `${target.tagName.toLowerCase()}.${[...target.classList].join('.')}` : 'no target'
      out.push(`${kind} on ${where}`)
    }
    return out
  }, SPINNER)

/** The longest of an element's transition durations, in seconds. */
const longestTransition = (el: Locator): Promise<number> =>
  el.evaluate((e) => Math.max(...getComputedStyle(e).transitionDuration.split(',').map((d) => parseFloat(d) * (d.trim().endsWith('ms') ? 0.001 : 1))))

// ─── AC1 ────────────────────────────────────────────────────────────────────────────────────────

/**
 * Runs in the page before its own scripts: from the first frame until the test reads it, records every running
 * animation or transition that is not a spinner, once each.
 */
function recordMotion(spinner: string): void {
  const w = window as unknown as { __motion: string[]; __motionStop?: boolean }
  w.__motion = []
  const seen = new Set<string>()
  const tick = (): void => {
    for (const a of document.getAnimations()) {
      if (a.playState !== 'running') continue
      const target = (a.effect as KeyframeEffect | null)?.target ?? null
      if (target instanceof Element && target.closest(spinner)) continue
      const kind = a instanceof CSSAnimation ? `animation ${a.animationName}` : a instanceof CSSTransition ? `transition ${a.transitionProperty}` : 'script animation'
      const where = target instanceof Element ? `${target.tagName.toLowerCase()}.${[...target.classList].join('.')}` : 'no target'
      const key = `${kind} on ${where}`
      if (!seen.has(key)) {
        seen.add(key)
        w.__motion.push(key)
      }
    }
    if (!w.__motionStop) requestAnimationFrame(tick)
  }
  requestAnimationFrame(tick)
}

for (const r of ROUTES) {
  test(`nothing slides in: ${r.name}`, async ({ page }) => {
    await page.addInitScript(recordMotion, SPINNER)
    await open(page, r.url, r.heading)
    const recorded = await page.evaluate(() => {
      const w = window as unknown as { __motion: string[]; __motionStop?: boolean }
      w.__motionStop = true
      return w.__motion
    })
    expect(recorded, 'animations and transitions that ran from the first frame to the loaded page').toEqual([])
    const keyframes = await page.evaluate(() => {
      const found: string[] = []
      const walk = (list: CSSRuleList): void => {
        for (const rule of Array.from(list)) {
          if (rule instanceof CSSKeyframesRule && rule.name === 'fadeIn') found.push(rule.cssText)
          if ('cssRules' in rule && !(rule instanceof CSSKeyframesRule)) walk((rule as CSSGroupingRule).cssRules)
        }
      }
      for (const sheet of Array.from(document.styleSheets)) walk(sheet.cssRules)
      return found
    })
    expect(keyframes, 'one fadeIn keyframes rule').toHaveLength(1)
    expect(keyframes[0], 'fadeIn fades').toContain('opacity')
    expect(keyframes[0], 'fadeIn does not slide').not.toContain('transform')
    const fade = await page.evaluate(() => {
      const probe = document.createElement('div')
      probe.className = 'fade-in'
      document.body.append(probe)
      const s = getComputedStyle(probe)
      const out = { name: s.animationName, duration: s.animationDuration }
      probe.remove()
      return out
    })
    expect(fade.name, 'an element with .fade-in runs fadeIn').toBe('fadeIn')
    expect(fade.duration, 'at --dur-base').toBe('0.16s')
    await shot(page, `nothing-slides-in-${slug(r.name)}`)
  })
}

// ─── AC2 ────────────────────────────────────────────────────────────────────────────────────────

/** What hovering may not change, and the transitions that would animate a change. */
const hoverState = (el: Locator) =>
  el.evaluate((e) => {
    const s = getComputedStyle(e)
    return {
      transform: s.transform,
      boxShadow: s.boxShadow,
      borderColor: [s.borderTopColor, s.borderRightColor, s.borderBottomColor, s.borderLeftColor].join(' '),
      transitionProperty: s.transitionProperty,
      transitionDuration: s.transitionDuration,
    }
  })

const HOVER_TARGETS = [
  { name: 'account card', url: '/accounts', heading: 'Accounts', target: (p: Page) => p.locator('main article.card').first() },
  { name: 'budget envelope card', url: '/allocations?tab=budgets', heading: 'Allocations', target: (p: Page) => p.locator('main article.card').first() },
  { name: 'transactions list panel', url: '/transactions', heading: 'Transactions', target: (p: Page) => p.getByTestId('list-sheet').first() },
  { name: 'transaction list row', url: '/transactions', heading: 'Transactions', target: (p: Page) => p.locator('article[data-transaction-id]').first() },
  { name: 'recurring list row', url: '/allocations?tab=recurring', heading: 'Allocations', target: (p: Page) => p.locator('[data-testid^="kind-section-"] article').first() },
] as const

for (const h of HOVER_TARGETS) {
  test(`panels have no hover motion: ${h.name}`, async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop', 'hover is a desktop pointer')
    await open(page, h.url, h.heading)
    await page.mouse.move(0, 0)
    const el = h.target(page)
    await expect(el).toBeVisible()
    await el.scrollIntoViewIfNeeded()
    const before = await hoverState(el)
    // The pointer goes to the element's own top-left corner, inside its padding (a panel's rows cover its centre).
    const box = await el.boundingBox()
    expect(box, 'the element has a box').not.toBeNull()
    await page.mouse.move((box?.x ?? 0) + 4, (box?.y ?? 0) + 4)
    // Longer than any transition the app ever set (200ms), so a change would have landed.
    await page.waitForTimeout(400)
    const after = await hoverState(el)
    expect(after.transform, 'transform on hover').toBe(before.transform)
    expect(after.boxShadow, 'box-shadow on hover').toBe(before.boxShadow)
    expect(after.borderColor, 'border colour on hover').toBe(before.borderColor)
    const durations = after.transitionDuration.split(',').map((d) => d.trim())
    expect(after.transitionProperty === 'none' || durations.every((d) => d === '0s'), `transition ${after.transitionProperty} ${after.transitionDuration}`).toBe(true)
    await viewportShot(page, `no-hover-motion-${slug(h.name)}`)
  })
}

// ─── AC3 ────────────────────────────────────────────────────────────────────────────────────────

test('reduced motion stops motion: button, dialog panel, selection rule and spinner', async ({ page }) => {
  await open(page, '/transactions', 'Transactions', { reducedMotion: 'reduce' })
  const add = page.getByRole('button', { name: 'Add Transaction', exact: true }).first()
  await expect(add).toBeVisible()
  expect(await longestTransition(add), 'Add Transaction button transition-duration (s)').toBeLessThanOrEqual(0.001)
  const selection = page.locator('.seg.is-selected').first()
  await expect(selection).toBeVisible()
  expect(await longestTransition(selection), 'selection rule transition-duration (s)').toBeLessThanOrEqual(0.001)
  // A spinner ring as the Spinner component draws it, and the bare loading ring: neither turns.
  const spinners = await page.evaluate(() => {
    const ring = document.createElement('span')
    ring.className = 'inline-block animate-spin motion-reduce:animate-none rounded-full h-8 w-8 border-2 border-line border-t-ink'
    ring.dataset.testid = 'spinner'
    const bare = document.createElement('div')
    bare.className = 'loading-spinner'
    document.body.append(ring, bare)
    const out = [getComputedStyle(ring).animationName, getComputedStyle(bare).animationName]
    ring.remove()
    bare.remove()
    return out
  })
  expect(spinners, 'the Spinner ring and .loading-spinner animation-name').toEqual(['none', 'none'])
  await add.click()
  const panel = page.locator('.modal-backdrop').last().locator('.bg-surface').first()
  await expect(panel).toBeVisible()
  expect(await longestTransition(panel), 'dialog panel transition-duration (s)').toBeLessThanOrEqual(0.001)
  await expect.poll(() => runningMotion(page), { message: 'running non-spinner animations with the dialog open' }).toEqual([])
  await viewportShot(page, 'reduced-motion-dialog')
})

for (const r of ROUTES) {
  test(`reduced motion stops motion: nothing runs on ${r.name}`, async ({ page }) => {
    await open(page, r.url, r.heading, { reducedMotion: 'reduce' })
    await expect.poll(() => runningMotion(page), { message: 'running non-spinner animations' }).toEqual([])
    await shot(page, `reduced-motion-${slug(r.name)}`)
  })
}

// ─── AC4 ────────────────────────────────────────────────────────────────────────────────────────

interface Focused {
  name: string
  style: string
  width: string
  offset: string
  color: string
}

/** The focused element's outline, or null when focus is on the page itself. */
const focused = (page: Page): Promise<Focused | null> =>
  page.evaluate(() => {
    const el = document.activeElement
    if (!el || el === document.body || el === document.documentElement) return null
    const s = getComputedStyle(el)
    const label = (el.getAttribute('aria-label') ?? el.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 40)
    return { name: `${el.tagName.toLowerCase()} "${label}"`, style: s.outlineStyle, width: s.outlineWidth, offset: s.outlineOffset, color: s.outlineColor }
  })

for (const scheme of SCHEMES) {
  for (const r of ROUTES) {
    test(`every control shows a keyboard focus ring: ${r.name}, ${scheme}`, async ({ page }) => {
      await open(page, r.url, r.heading, { scheme })
      const seen: Focused[] = []
      for (let i = 0; i < 40; i += 1) {
        await page.keyboard.press('Tab')
        const f = await focused(page)
        if (f) seen.push(f)
      }
      expect(seen.length, 'controls reached with Tab').toBeGreaterThan(5)
      for (const f of seen) {
        expect.soft(f.style, `${f.name} outline-style`).not.toBe('none')
        expect.soft(f.width, `${f.name} outline-width`).toBe('2px')
        expect.soft(parseFloat(f.offset), `${f.name} outline-offset (${f.offset})`).toBeGreaterThan(0)
        expect.soft(f.color, `${f.name} outline colour`).toBe(ACCENT[scheme])
      }
      await viewportShot(page, `focus-ring-${slug(r.name)}-${scheme}`)
    })
  }
}

/** Buttons a mouse click focuses without moving focus elsewhere. */
const CLICKED = [
  // Its label turns from Show to Hide filters on the click.
  { name: 'Transactions filter toggle', url: '/transactions', heading: 'Transactions', button: (p: Page) => p.getByRole('button', { name: /^(Show|Hide) filters$/ }) },
  { name: 'Allocations tab', url: '/allocations?tab=recurring', heading: 'Allocations', button: (p: Page) => p.getByRole('button', { name: 'Budgets', exact: true }) },
] as const

for (const c of CLICKED) {
  test(`every control shows a keyboard focus ring: no ring after a mouse click on the ${c.name}`, async ({ page }) => {
    await open(page, c.url, c.heading)
    const button = c.button(page)
    await button.click()
    await expect(button).toBeFocused()
    const ring = await button.evaluate((e) => ({ style: getComputedStyle(e).outlineStyle, width: getComputedStyle(e).outlineWidth }))
    expect(ring.style === 'none' || ring.width === '0px', `outline ${ring.style} ${ring.width}`).toBe(true)
    await shot(page, `no-ring-after-click-${slug(c.name)}`)
  })
}

test('every control shows a keyboard focus ring: no .focus-ring:focus rule', async ({ page }) => {
  await open(page, '/transactions', 'Transactions')
  const selectors = await page.evaluate(() => {
    const out: string[] = []
    const walk = (list: CSSRuleList): void => {
      for (const rule of Array.from(list)) {
        if (rule instanceof CSSStyleRule) out.push(...rule.selectorText.split(',').map((s) => s.trim()))
        if ('cssRules' in rule && !(rule instanceof CSSKeyframesRule)) walk((rule as CSSGroupingRule).cssRules)
      }
    }
    for (const sheet of Array.from(document.styleSheets)) walk(sheet.cssRules)
    return out
  })
  expect(selectors.length, 'stylesheet selectors read').toBeGreaterThan(100)
  expect(selectors.filter((s) => s.endsWith('.focus-ring:focus')), 'selectors ending in .focus-ring:focus').toEqual([])
  expect(selectors.filter((s) => s.includes('focus-ring') && s.endsWith(':focus-visible')).length, '.focus-ring rules on :focus-visible').toBeGreaterThan(0)
  await shot(page, 'focus-ring-stylesheet')
})

// ─── AC5 ────────────────────────────────────────────────────────────────────────────────────────

const EMPTY_STATES = [
  {
    state: 'Accounts',
    url: '/accounts',
    heading: 'Accounts',
    data: noAccountsHousehold,
    extra: [],
    sentence: 'No accounts yet. Start by adding your first account.',
    dialog: 'Create Account',
  },
  {
    state: 'Budgets',
    url: '/allocations?tab=budgets',
    heading: 'Allocations',
    data: noEnvelopesHousehold,
    extra: [],
    sentence: 'No budget envelopes yet. Create one to keep monthly spending in check.',
    dialog: 'Create Budget Envelope',
  },
  {
    state: 'Savings',
    url: '/allocations?tab=savings',
    heading: 'Allocations',
    data: noEnvelopesHousehold,
    extra: [],
    sentence: 'No savings or goal envelopes yet. Create one to start building your future plans.',
    dialog: 'Create Savings Tracker',
  },
  {
    state: 'Recurring',
    url: '/allocations?tab=recurring',
    heading: 'Allocations',
    data: emptyHousehold,
    extra: [],
    sentence: 'No recurring entries yet. Add your regular income, bills and subscriptions to stay ahead.',
    dialog: 'Add Recurring Entry',
  },
  {
    state: 'Wishlist',
    url: '/allocations?tab=wishlist',
    heading: 'Allocations',
    data: emptyHousehold,
    extra: householdWishlistRoutes([]),
    sentence: 'Nothing on your wishlist yet.',
    dialog: 'Add item',
  },
] as const

/** The empty state's own box, then every ancestor up to <main> that is a card, as their chrome. */
const chromeOf = (el: Locator) =>
  el.evaluate((e) => {
    const box = (n: Element) => {
      const s = getComputedStyle(n)
      return {
        name: `${n.tagName.toLowerCase()}.${[...n.classList].join('.')}`,
        background: s.backgroundColor,
        borders: [s.borderTopWidth, s.borderRightWidth, s.borderBottomWidth, s.borderLeftWidth].join(' '),
        shadow: s.boxShadow,
      }
    }
    const cards: ReturnType<typeof box>[] = []
    for (let n = e.parentElement; n && n.tagName !== 'MAIN'; n = n.parentElement) if (n.matches('.card, .stat-card, [data-testid="list-sheet"]')) cards.push(box(n))
    return { own: box(e), textAlign: getComputedStyle(e).textAlign, cards }
  })

for (const s of EMPTY_STATES) {
  test(`empty states invite the next step: ${s.state}`, async ({ page }) => {
    await open(page, s.url, s.heading, { data: s.data, extra: [...s.extra] })
    const empty = page.getByTestId('empty-state')
    await expect(empty).toHaveCount(1)
    await expect(empty.locator('p')).toHaveText(s.sentence)
    const primary = empty.locator('[data-variant="primary"]')
    await expect(primary).toHaveCount(1)
    expect(await empty.evaluate((e) => {
      const p = e.querySelector('p')
      const b = e.querySelector('[data-variant="primary"]')
      return p !== null && b !== null && (p.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0
    }), 'the sentence precedes the button').toBe(true)
    const chrome = await chromeOf(empty)
    expect(['left', 'start'], `text-align ${chrome.textAlign}`).toContain(chrome.textAlign)
    expect(chrome.own.background, 'empty state background').toBe(TRANSPARENT)
    expect(chrome.own.borders, 'empty state border widths').toBe('0px 0px 0px 0px')
    expect(chrome.own.shadow, 'empty state box-shadow').toBe('none')
    expect(chrome.cards, 'card wrappers around the empty state').toEqual([])
    await shot(page, `empty-state-${slug(s.state)}`)
    await primary.click()
    await expect(page.getByRole('heading', { name: s.dialog, exact: true })).toBeVisible()
    await viewportShot(page, `empty-state-${slug(s.state)}-dialog`)
  })
}

/** A viewer owns no account and can add records to none, so these lists offer no create action. */
const VIEWER_STATES = EMPTY_STATES.filter((s) => s.state === 'Budgets' || s.state === 'Savings' || s.state === 'Recurring')

for (const s of VIEWER_STATES) {
  test(`empty states invite the next step: ${s.state}, viewer`, async ({ page }) => {
    await open(page, s.url, s.heading, { data: viewerEmptyHousehold })
    const empty = page.getByTestId('empty-state')
    await expect(empty).toHaveCount(1)
    await expect(empty.locator('p')).toHaveText(s.sentence)
    await expect(empty.locator('[data-variant="primary"]')).toHaveCount(0)
    await expect(empty.getByRole('button')).toHaveCount(0)
    await shot(page, `empty-state-${slug(s.state)}-viewer`)
  })
}

// ─── AC6 and AC7 ────────────────────────────────────────────────────────────────────────────────

const STATES = [
  { state: 'Overdue', url: '/', heading: 'Dashboard', colour: DANGER, find: (p: Page) => p.getByTestId('payable-due-state').filter({ hasText: /^Overdue$/ }).first() },
  { state: 'Due today', url: '/', heading: 'Dashboard', colour: WARN, find: (p: Page) => p.getByTestId('payable-due-state').filter({ hasText: /^Due today$/ }).first() },
  {
    state: 'Pending',
    url: '/transactions',
    heading: 'Transactions',
    colour: MUTED,
    find: (p: Page) => p.locator(`article[data-transaction-id="${STATUS_STATE_IDS.pendingTransaction}"]`).getByTestId('transaction-status'),
  },
  {
    state: 'Paid',
    url: '/allocations?tab=recurring',
    heading: 'Allocations',
    colour: OK,
    find: (p: Page) => p.getByTestId('installment-paid').first(),
  },
  {
    state: 'Posted',
    url: '/transactions',
    heading: 'Transactions',
    colour: OK,
    find: (p: Page) => p.getByTestId('transaction-status').filter({ hasText: /^Posted$/ }).first(),
  },
  {
    state: 'Charged (completed)',
    url: '/transactions',
    heading: 'Transactions',
    colour: OK,
    find: (p: Page) => p.locator(`[data-testid="due-row"][data-source="transaction:${STATUS_STATE_IDS.chargedTransaction}"]`).getByTestId('due-pending-state'),
  },
  {
    state: 'Auto-post on',
    url: '/allocations?tab=recurring',
    heading: 'Allocations',
    colour: OK,
    find: (p: Page) => p.locator('[data-testid="installment-auto-post-state"][data-state="on"]').first(),
  },
  {
    state: 'Auto-post off',
    url: '/allocations?tab=recurring',
    heading: 'Allocations',
    colour: MUTED,
    find: (p: Page) => p.locator('[data-testid="installment-auto-post-state"][data-state="off"]').first(),
  },
  {
    state: 'Not reviewed',
    url: '/allocations?tab=recurring',
    heading: 'Allocations',
    colour: WARN,
    find: (p: Page) => p.locator('[data-testid="installment-auto-post-state"][data-state="unreviewed"]').first(),
  },
] as const

/** The words each state shows. */
const WORDS: Record<(typeof STATES)[number]['state'], string> = {
  Overdue: 'Overdue',
  'Due today': 'Due today',
  Pending: 'Pending',
  Paid: 'Fully paid',
  Posted: 'Posted',
  'Charged (completed)': 'Charged',
  'Auto-post on': 'Auto-post on',
  'Auto-post off': 'Auto-post off',
  'Not reviewed': 'Not reviewed',
}

/** A StatusText's dot, word and box, with the first opaque background behind it (its row's). */
const statusOf = (el: Locator) =>
  el.evaluate((e) => {
    const dot = e.querySelector('[data-status-dot]')
    const word = e.querySelector('[data-status-word]')
    if (!dot || !word) return null
    const d = getComputedStyle(dot)
    const w = getComputedStyle(word)
    const s = getComputedStyle(e)
    let behind = 'rgb(255, 255, 255)'
    for (let n: Element | null = e; n; n = n.parentElement) {
      const bg = getComputedStyle(n).backgroundColor
      if (bg !== 'rgba(0, 0, 0, 0)' && bg !== 'transparent') {
        behind = bg
        break
      }
    }
    const dotBox = dot.getBoundingClientRect()
    return {
      dot: { width: dotBox.width, height: dotBox.height, radius: d.borderTopLeftRadius, background: d.backgroundColor, rounded: dot.classList.contains('rounded-full') },
      word: { text: word.textContent, color: w.color, size: w.fontSize, weight: w.fontWeight, background: w.backgroundColor },
      own: { background: s.backgroundColor, color: s.color, borders: [s.borderTopWidth, s.borderRightWidth, s.borderBottomWidth, s.borderLeftWidth].join(' '), shadow: s.boxShadow },
      behind,
    }
  })

/** WCAG contrast of two computed rgb() colours. */
function contrast(a: string, b: string): number {
  const lum = (c: string): number => {
    const [r, g, bl] = (c.match(/\d+(\.\d+)?/g) ?? []).slice(0, 3).map((v) => {
      const s = Number(v) / 255
      return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
    })
    return 0.2126 * (r ?? 0) + 0.7152 * (g ?? 0) + 0.0722 * (bl ?? 0)
  }
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x)
  return ((hi ?? 0) + 0.05) / ((lo ?? 0) + 0.05)
}

for (const s of STATES) {
  test(`status is a dot and a word: ${s.state}`, async ({ page }) => {
    await open(page, s.url, s.heading, { data: withStatusStates(household) })
    const el = s.find(page)
    await expect(el).toBeVisible()
    await el.scrollIntoViewIfNeeded()
    const st = await statusOf(el)
    expect(st, 'a StatusText with a dot and a word').not.toBeNull()
    if (!st) return
    expect(st.word.text, 'the word').toBe(WORDS[s.state])
    expect(st.dot.width, 'dot width').toBe(8)
    expect(st.dot.height, 'dot height').toBe(8)
    expect(st.dot.rounded, 'the dot is rounded-full').toBe(true)
    expect(st.dot.radius, 'dot border-radius').toBe('9999px')
    expect(st.word.color, 'word colour').toBe(s.colour)
    expect(st.dot.background, 'dot colour equals the word colour').toBe(st.word.color)
    expect(st.own.background, 'StatusText background').toBe(TRANSPARENT)
    expect(st.word.size, 'word font-size').toBe('13px')
    expect(st.word.weight, 'word font-weight').toBe('500')
    expect(contrast(st.word.color, st.behind), `contrast of ${st.word.color} on ${st.behind}`).toBeGreaterThanOrEqual(4.5)
    await shot(page, `status-dot-word-${slug(s.state)}`)
  })
}

for (const s of STATES) {
  test(`no filled status boxes: ${s.state}`, async ({ page }) => {
    await open(page, s.url, s.heading, { data: withStatusStates(household) })
    const el = s.find(page)
    await expect(el).toBeVisible()
    const st = await statusOf(el)
    expect(st, 'a StatusText with a dot and a word').not.toBeNull()
    if (!st) return
    expect(st.own.background, 'status container background').toBe(TRANSPARENT)
    expect(st.word.background, 'status word background').toBe(TRANSPARENT)
    expect(st.own.borders, 'status container border widths').toBe('0px 0px 0px 0px')
    expect(st.own.shadow, 'status container box-shadow').toBe('none')
    // Every other state indicator on the route, the same way.
    const all = await page.locator('.status-text').evaluateAll((els) =>
      els.map((e) => {
        const s = getComputedStyle(e)
        const word = e.querySelector('[data-status-word]')
        return {
          text: e.textContent,
          own: s.backgroundColor,
          word: word ? getComputedStyle(word).backgroundColor : 'missing',
          borders: [s.borderTopWidth, s.borderRightWidth, s.borderBottomWidth, s.borderLeftWidth].join(' '),
          shadow: s.boxShadow,
        }
      }),
    )
    expect(all.length, 'state indicators on the route').toBeGreaterThan(0)
    expect(all.filter((a) => a.own !== TRANSPARENT || a.word !== TRANSPARENT || a.borders !== '0px 0px 0px 0px' || a.shadow !== 'none'), 'filled state indicators').toEqual([])
    await shot(page, `no-filled-status-${slug(s.state)}`)
  })
}

// ─── AC8 ────────────────────────────────────────────────────────────────────────────────────────

const ACTIONS = [
  { label: 'Mark paid', testId: 'entry-mark-paid-button', name: 'Rent' },
  { label: 'Charged', testId: 'entry-charged-button', name: 'Netflix Standard' },
  { label: 'Posted', testId: 'entry-posted-button', name: 'Netflix Standard' },
] as const

for (const a of ACTIONS) {
  test(`status actions stay secondary: ${a.label} on ${a.name}`, async ({ page }) => {
    const entry = household.entries.find((e) => e.view !== 'limited' && e.name === a.name)
    if (!entry) throw new Error(`no entry ${a.name} in the fixture`)
    const api = await open(page, '/allocations?tab=recurring', 'Allocations', { extra: [...householdDialogRoutes(household), ...householdSaveRoutes(household)] })
    const row = page.locator('[data-testid^="kind-section-"] article').filter({ has: page.getByText(a.name, { exact: true }) })
    const button = row.getByTestId(a.testId)
    await expect(button).toHaveText(a.label)
    await expect(button).toHaveAttribute('data-variant', 'secondary')
    await button.click()
    const dialog = page.getByTestId('mark-paid-dialog')
    await expect(dialog).toBeVisible()
    await viewportShot(page, `status-action-${slug(a.label)}-dialog`)
    await dialog.locator('[data-variant="primary"]').first().click()
    await expect.poll(() => api.count('POST', `/budget-entries/${entry.id}/materialize`), { message: `${a.label} records one occurrence` }).toBe(1)
    await expect(dialog).toBeHidden()
    await shot(page, `status-action-${slug(a.label)}`)
  })
}

// ─── AC9 ────────────────────────────────────────────────────────────────────────────────────────

test('recurring search no match unchanged', async ({ page }) => {
  await open(page, '/allocations?tab=recurring', 'Allocations')
  await expect(page.locator('[data-testid^="kind-section-"] article').first()).toBeVisible()
  await page.getByTestId('recurring-search').fill('zzz no such entry')
  const none = page.getByTestId('recurring-search-empty')
  await expect(none).toBeVisible()
  await expect(none).toHaveText('No recurring entries match')
  // As at the PR base: a card with centred muted text.
  await expect(none).toHaveAttribute('class', 'card p-6 text-center text-muted')
  const look = await none.evaluate((e) => {
    const s = getComputedStyle(e)
    return {
      background: s.backgroundColor,
      borders: [s.borderTopWidth, s.borderRightWidth, s.borderBottomWidth, s.borderLeftWidth].join(' '),
      borderColor: [s.borderTopColor, s.borderRightColor, s.borderBottomColor, s.borderLeftColor].join(' '),
      shadow: s.boxShadow,
      align: s.textAlign,
      color: s.color,
    }
  })
  expect(look.background, 'background').toBe(SURFACE)
  expect(look.borders, 'border widths').toBe('1px 1px 1px 1px')
  expect(look.borderColor, 'border colour').toBe([LINE, LINE, LINE, LINE].join(' '))
  expect(look.shadow, 'box-shadow').toBe('none')
  expect(look.align, 'text-align').toBe('center')
  expect(look.color, 'text colour').toBe(MUTED)
  expect(await none.locator('button, a, input, select, textarea, [role="button"]').count(), 'controls inside the no-match line').toBe(0)
  await shot(page, 'recurring-search-no-match')
})
