// STU-684: the top bar is the spine band (docs/design-system.md, "Top bar (the spine)"). The `spine` class on the nav
// sets the spine background and re-points ink, body, muted and line to the on-spine values inside it; the user menu
// panel takes the document values back; the active page is an on-spine underline. The tab bar and the top bar use the
// page titles' names, and the wordmark is in the text face. The API is faked in the browser with the shared household
// fixture; there is no backend.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test } from '@playwright/test'
import type { Locator, Page } from '@playwright/test'
import { household, mockHousehold } from './support/fixtures/household'
import { shot } from './support/shot'

// This spec lives in <repo>/frontend/e2e.
const FRONTEND = fileURLToPath(new URL('..', import.meta.url))
const read = (rel: string): string => fs.readFileSync(path.join(FRONTEND, rel), 'utf8')

type Theme = 'light' | 'dark'

// Design-system tokens (docs/design-system.md, Palette) as getComputedStyle reports them.
const TOKENS = {
  light: { spine: 'rgb(34, 72, 58)', onSpine: 'rgb(228, 234, 226)', surface: 'rgb(242, 245, 240)', ink: 'rgb(22, 36, 28)', body: 'rgb(45, 59, 51)', muted: 'rgb(74, 89, 80)', line: 'rgb(188, 201, 184)' },
  dark: { spine: 'rgb(28, 52, 40)', onSpine: 'rgb(229, 238, 231)', surface: 'rgb(23, 33, 27)', ink: 'rgb(229, 238, 231)', body: 'rgb(196, 209, 199)', muted: 'rgb(147, 165, 152)', line: 'rgb(41, 56, 47)' },
} as const

/** The four destinations both navs carry, the tour marker their links share, and the page's title. */
const DESTINATIONS = [
  { path: '/', marker: 'nav-home', title: 'Dashboard' },
  { path: '/accounts', marker: 'nav-accounts', title: 'Accounts' },
  { path: '/transactions', marker: 'nav-transactions', title: 'Transactions' },
  { path: '/allocations', marker: 'nav-allocations', title: 'Allocations' },
] as const

/**
 * The tab bar's height on the PR base (main b307b3d): `/`, light, Chromium, 390x844, the household fixture, after
 * fonts load (h-16 and its 1px top rule). Recorded with this spec's own measurement before the change.
 */
const BASE_TAB_BAR_HEIGHT = 65

const topBar = (page: Page): Locator => page.locator('nav.safe-area-top')
const tabBar = (page: Page): Locator => page.locator('nav.safe-area-bottom')

/** A viewport screenshot (a full-page one draws a fixed layer at the scroll offset), saved like `shot()`. */
async function viewportShot(page: Page, name: string): Promise<void> {
  const info = test.info()
  const spec = path.basename(info.file).replace(/\.spec\.ts$/, '')
  await page.screenshot({ path: path.join(info.project.outputDir, 'screens', `${spec}-${name}-${info.project.name}.png`), animations: 'disabled' })
}

/** Opens `url` signed in as the household's user, once the page's title is up and the data has settled. */
async function open(page: Page, url: string): Promise<void> {
  await mockHousehold(page)
  await page.goto(url)
  await expect(page.locator('main h1').first()).toBeVisible()
  await page.waitForLoadState('networkidle')
  await page.evaluate(() => document.fonts.ready)
}

/** Dark, set the way the theme toggle sets it: a click on the nav's toggle writes `data-theme` on <html>. */
async function toggleDark(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Toggle theme' }).click()
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
  // Links fade their colour (transition-colors): read them once the fades have finished.
  await page.evaluate(() => Promise.all(document.getAnimations().filter((a) => a instanceof CSSTransition).map((a) => a.finished)))
}

const css = (el: Locator, prop: string): Promise<string> => el.evaluate((e, p) => getComputedStyle(e).getPropertyValue(p), prop)

/** The WCAG contrast ratio of two `rgb(r, g, b)` colours, worked out here so the test does not trust the doc's figures. */
function contrast(a: string, b: string): number {
  const luminance = (c: string): number => {
    const [r, g, bl] = (c.match(/\d+/g) ?? []).slice(0, 3).map((v) => {
      const s = Number(v) / 255
      return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
    })
    return 0.2126 * r + 0.7152 * g + 0.0722 * bl
  }
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (hi + 0.05) / (lo + 0.05)
}

/** A link's bottom rule as `width style colour`, or `none` when it draws nothing (no width, no style or transparent). */
const ruleOf = (el: Locator): Promise<string> =>
  el.evaluate((e) => {
    const s = getComputedStyle(e)
    const drawn = parseFloat(s.borderBottomWidth) > 0 && s.borderBottomStyle !== 'none' && s.borderBottomColor !== 'rgba(0, 0, 0, 0)'
    return drawn ? `${s.borderBottomWidth} ${s.borderBottomStyle} ${s.borderBottomColor}` : 'none'
  })

/** The colour that shows behind an element: its own background, or the first ancestor's that is not transparent. */
const backdropOf = (el: Locator): Promise<string> =>
  el.evaluate((e) => {
    for (let n: Element | null = e; n; n = n.parentElement) {
      const bg = getComputedStyle(n).backgroundColor
      if (bg !== 'rgba(0, 0, 0, 0)') return bg
    }
    return 'none'
  })

// ─── AC1 ────────────────────────────────────────────────────────────────────────────────────────

for (const theme of ['light', 'dark'] as const satisfies readonly Theme[]) {
  test(`top bar is the spine band: ${theme}`, async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop', 'the AC names the desktop bar, where the page links show')
    await open(page, '/')
    if (theme === 'dark') await toggleDark(page)
    const bar = topBar(page)
    const t = TOKENS[theme]
    const background = await css(bar, 'background-color')
    expect(background, `the top bar is the ${theme} spine`).toBe(t.spine)
    const links = bar.locator('a:visible')
    expect(await links.count(), 'the wordmark and the five page links').toBe(6)
    const colours = await links.evaluateAll((all) => all.map((e) => `${(e.textContent ?? '').trim()}: ${getComputedStyle(e).color}`))
    const names = await links.evaluateAll((all) => all.map((e) => (e.textContent ?? '').trim()))
    expect(colours, `every top-bar link is on-spine (${t.onSpine})`).toEqual(names.map((n) => `${n}: ${t.onSpine}`))
    const ratio = contrast(t.onSpine, background)
    testInfo.annotations.push({ type: 'contrast', description: `${t.onSpine} on ${background}: ${ratio.toFixed(2)}:1` })
    expect(ratio, `link colour on the bar is at least 7:1 (${ratio.toFixed(2)})`).toBeGreaterThanOrEqual(7)
    await viewportShot(page, `spine-${theme}`)
  })
}

// ─── AC2 ────────────────────────────────────────────────────────────────────────────────────────

for (const d of DESTINATIONS) {
  test(`active page is an on-spine underline: ${d.title}`, async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop', 'the top-bar page links show on desktop only')
    await open(page, d.path)
    const bar = topBar(page)
    const active = bar.getByRole('link', { name: d.title, exact: true })
    await expect(active).toHaveAttribute('aria-current', 'page')
    expect(await ruleOf(active), `the ${d.title} link has a 2px on-spine bottom rule`).toBe(`2px solid ${TOKENS.light.onSpine}`)
    expect(await css(active, 'background-color'), 'the active link has no fill of its own').toBe('rgba(0, 0, 0, 0)')
    expect(await backdropOf(active), 'the active link shows the bar background').toBe(await css(bar, 'background-color'))
    // Every other link in the bar: the other page links and the wordmark.
    const others = bar.locator('a:visible').filter({ hasNotText: new RegExp(`^${d.title}$`) })
    const rules = await others.evaluateAll((all) =>
      all.map((e) => {
        const s = getComputedStyle(e)
        const drawn = parseFloat(s.borderBottomWidth) > 0 && s.borderBottomStyle !== 'none' && s.borderBottomColor !== 'rgba(0, 0, 0, 0)'
        return { name: (e.textContent ?? '').trim(), rule: `${drawn ? s.borderBottomColor : 'none'} ${s.boxShadow}`, current: e.getAttribute('aria-current') }
      }),
    )
    expect(rules.length, 'the wordmark and the four other page links').toBe(5)
    expect(rules.filter((r) => r.rule !== 'none none').map((r) => `${r.name}: ${r.rule}`), 'inactive links have no rule').toEqual([])
    // The wordmark links home too, so the router marks it current on the dashboard; it is not a page link.
    expect(rules.filter((r) => r.current === 'page' && !r.name.endsWith('Tally & Trace')).map((r) => r.name), 'no other page link is current').toEqual([])
    await viewportShot(page, `active-${d.marker}`)
    // Hovering an inactive link draws no rule either (Forecast is never one of the four destinations).
    const forecast = bar.getByRole('link', { name: 'Forecast', exact: true })
    await forecast.hover()
    await page.evaluate(() => Promise.all(document.getAnimations().filter((a) => a instanceof CSSTransition).map((a) => a.finished)))
    expect(await forecast.evaluate((e) => e.matches(':hover')), 'the pointer is on the Forecast link').toBe(true)
    expect(await ruleOf(forecast), 'a hovered inactive link has no bottom rule').toBe('none')
    expect(await css(forecast, 'box-shadow'), 'a hovered inactive link has no shadow rule').toBe('none')
    await viewportShot(page, `active-${d.marker}-hover`)
  })
}

// ─── AC3 ────────────────────────────────────────────────────────────────────────────────────────

for (const theme of ['light', 'dark'] as const satisfies readonly Theme[]) {
  test(`user menu keeps document colours: ${theme}`, async ({ page }) => {
    await open(page, '/')
    if (theme === 'dark') await toggleDark(page)
    const initials = `${household.user.first_name[0]}${household.user.last_name[0]}`
    await topBar(page).locator('button').filter({ hasText: initials }).click()
    const settings = topBar(page).getByRole('link', { name: 'Settings', exact: true })
    await expect(settings).toBeVisible()
    const panel = settings.locator('xpath=..')
    const name = panel.getByText(`${household.user.first_name} ${household.user.last_name}`, { exact: true })
    const t = TOKENS[theme]
    // The resolved document tokens on <html>, which the panel must match (and which the doc's table gives as `t`).
    const root = await page.evaluate(() => {
      const s = getComputedStyle(document.documentElement)
      const rgb = (n: string): string => `rgb(${s.getPropertyValue(n).trim().split(/\s+/).join(', ')})`
      return { surface: rgb('--surface'), ink: rgb('--ink') }
    })
    expect(root, `the resolved ${theme} surface and ink tokens`).toEqual({ surface: t.surface, ink: t.ink })
    expect(await css(panel, 'background-color'), `the panel is ${theme} surface`).toBe(root.surface)
    expect(await css(name, 'color'), `the panel's text is ${theme} ink`).toBe(root.ink)
    expect.soft(await css(settings, 'color'), `a menu item is ${theme} body`).toBe(t.body)
    expect.soft(await css(panel.getByText(household.user.email, { exact: true }), 'color'), `the email is ${theme} muted`).toBe(t.muted)
    expect.soft(await css(panel, 'border-top-color'), `the panel border is ${theme} line`).toBe(t.line)
    await viewportShot(page, `user-menu-${theme}`)
  })
}

// ─── AC4 ────────────────────────────────────────────────────────────────────────────────────────

for (const d of DESTINATIONS) {
  test(`nav label equals page title: ${d.title}`, async ({ page }, testInfo) => {
    await open(page, d.path)
    const desktop = testInfo.project.name === 'desktop'
    // The top bar's page links show on desktop; the tab bar shows on a phone.
    const link = (desktop ? topBar(page) : tabBar(page)).locator(`a[data-onboarding="${d.marker}"]`)
    await expect(link).toBeVisible()
    await expect(link).toHaveAttribute('href', d.path)
    const label = ((await link.textContent()) ?? '').trim()
    const h1 = page.locator('main h1')
    expect(await h1.count(), 'one page title').toBe(1)
    const title = ((await h1.textContent()) ?? '').trim()
    expect(title, `the ${d.path} page title`).toBe(d.title)
    expect(label, `the ${desktop ? 'top bar' : 'tab bar'} label for ${d.path} is the page title`).toBe(title)
    await viewportShot(page, `label-${d.marker}`)
  })
}

// ─── AC5 ────────────────────────────────────────────────────────────────────────────────────────

test('tab bar labels fit on one line', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'phone', 'the tab bar is phone only')
  await open(page, '/')
  const bar = tabBar(page)
  await expect(bar).toBeVisible()
  const labels = bar.locator('a[data-onboarding^="nav-"] > span:not([aria-hidden])')
  const measured = await labels.evaluateAll((all) =>
    all.map((e) => {
      const range = document.createRange()
      range.selectNodeContents(e)
      return {
        text: (e.textContent ?? '').trim(),
        y: e.getBoundingClientRect().y,
        lines: range.getClientRects().length,
        overflow: e.scrollWidth > e.clientWidth || (e.parentElement !== null && e.parentElement.scrollWidth > e.parentElement.clientWidth),
      }
    }),
  )
  expect.soft(measured.map((m) => m.text), 'the four labels').toEqual(DESTINATIONS.map((d) => d.title))
  expect(measured.map((m) => `${m.text}: ${m.y}`), 'the labels share one y').toEqual(measured.map((m) => `${m.text}: ${measured[0].y}`))
  expect(measured.filter((m) => m.overflow).map((m) => m.text), 'labels (or their tabs) wider than their box').toEqual([])
  expect(measured.map((m) => `${m.text}: ${m.lines}`), 'each label is one line of text').toEqual(measured.map((m) => `${m.text}: 1`))
  const height = (await bar.boundingBox())?.height ?? 0
  expect(Math.abs(height - BASE_TAB_BAR_HEIGHT), `the bar is ${height}px, the base was ${BASE_TAB_BAR_HEIGHT}px`).toBeLessThanOrEqual(2)
  await viewportShot(page, 'tab-bar')
})

// ─── AC6 ────────────────────────────────────────────────────────────────────────────────────────

test('wordmark is in the text face', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop', 'the wordmark is hidden below the md breakpoint')
  await open(page, '/')
  const wordmark = topBar(page).getByText('Tally & Trace', { exact: true })
  await expect(wordmark).toBeVisible()
  expect(await css(wordmark, 'font-family'), 'the wordmark is IBM Plex Sans').toMatch(/^"IBM Plex Sans"/)
  expect(await css(wordmark, 'font-weight'), 'the wordmark is 600').toBe('600')
  expect(await css(wordmark, 'font-style'), 'the wordmark is upright').toBe('normal')
  await viewportShot(page, 'wordmark')
})

// ─── AC7 ────────────────────────────────────────────────────────────────────────────────────────

test('spine is a component class, not a selector shim', async ({ page }) => {
  await open(page, '/')
  const rules = await page.evaluate(() => {
    const out: { selector: string; css: string }[] = []
    const walk = (list: CSSRuleList) => {
      for (const rule of Array.from(list)) {
        if (rule instanceof CSSStyleRule) out.push({ selector: rule.selectorText, css: rule.style.cssText })
        if ('cssRules' in rule) walk((rule as CSSGroupingRule).cssRules)
      }
    }
    for (const sheet of Array.from(document.styleSheets)) {
      // The web-font sheet is cross-origin and unreadable; every app rule is same-origin.
      if (sheet.href && new URL(sheet.href).origin !== location.origin) continue
      walk(sheet.cssRules)
    }
    return out
  })
  expect(rules.length, 'stylesheet rules were read').toBeGreaterThan(100)
  // Quotes and whitespace around combinators do not change a selector.
  const norm = (s: string): string => s.replace(/["']/g, '').replace(/\s*([>+~,])\s*/g, '$1').replace(/\s+/g, ' ').trim()
  const selectors = rules.flatMap((r) => norm(r.selector).split(','))
  expect(selectors.filter((s) => s.includes('nav.safe-area-top .bg-surface')), 'rules keyed on nav.safe-area-top .bg-surface').toEqual([])
  expect(selectors.filter((s) => s.includes('button[aria-current=page]')), "rules keyed on button[aria-current='page']").toEqual([])
  // The spine rule: the class sets the background and re-points the text and rule tokens.
  const spine = rules.filter((r) => norm(r.selector) === '.spine').map((r) => r.css).join(' ')
  for (const decl of ['background-color: rgb(var(--spine))', '--ink: var(--on-spine)', '--body: var(--on-spine)', '--muted: var(--on-spine-muted)', '--line: var(--on-spine-muted)']) {
    expect(spine, `the .spine rule sets ${decl}`).toContain(decl)
  }
  expect(await topBar(page).evaluate((e) => e.classList.contains('spine')), 'the top bar carries the spine class').toBe(true)
  const source = read('src/components/Navigation.tsx')
  expect(source.match(/<nav className="[^"]*"/)?.[0] ?? '', 'Navigation.tsx puts the spine class on the nav').toMatch(/\bspine\b/)
  expect(source, 'Navigation.tsx has no raw colour').not.toMatch(/#[0-9a-fA-F]{3,8}\b|rgba?\(/)
  await shot(page, 'spine-class')
})
