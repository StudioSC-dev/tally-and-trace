// STU-675: the Columnar pad design system (docs/design-system.md) and the theme layer that carries it. The API is
// faked in the browser with the shared household fixture; there is no backend.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { expect, test } from '@playwright/test'
import type { Locator, Page } from '@playwright/test'
import loadConfig from 'tailwindcss/loadConfig.js'
import resolveConfig from 'tailwindcss/resolveConfig.js'
import { shot } from './support/shot'
import { calmHousehold, emptyHousehold, household, mockHousehold, SHARED_ACCOUNT_IDS } from './support/fixtures/household'
import type { HouseholdData } from './support/fixtures/household'

// This spec lives in <repo>/frontend/e2e.
const FRONTEND = fileURLToPath(new URL('..', import.meta.url))
const REPO = path.join(FRONTEND, '..')
const readRepo = (rel: string): string => fs.readFileSync(path.join(REPO, rel), 'utf8')

/** Direction B, section B.1, light: every token the table names, by its CSS variable. */
const LIGHT: Record<string, string> = {
  paper: '#E4EAE2',
  surface: '#F2F5F0',
  sunken: '#D6DED3',
  line: '#BCC9B8',
  'line-strong': '#748870',
  ink: '#16241C',
  body: '#2D3B33',
  muted: '#4A5950',
  info: '#4A5950',
  accent: '#22483A',
  spine: '#22483A',
  'on-spine': '#E4EAE2',
  'on-spine-muted': '#B5CBBE',
  ok: '#2A6440',
  warn: '#875000',
  danger: '#AE2A20',
}

/** Direction B, section B.1, the dark set. */
const DARK: Record<string, string> = {
  paper: '#111915',
  surface: '#17211B',
  sunken: '#0C130F',
  line: '#29382F',
  'line-strong': '#5C7563',
  ink: '#E5EEE7',
  body: '#C4D1C7',
  muted: '#93A598',
  accent: '#93CDA9',
  spine: '#1C3428',
  'on-spine': '#E5EEE7',
  ok: '#8CC6A0',
  warn: '#E4B062',
  danger: '#F0968C',
}

const channelsOf = (hex: string): number[] => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16))
/** The token's value as CSS holds it: space-separated RGB channels. */
const channels = (hex: string): string => channelsOf(hex).join(' ')
/** The token's colour as getComputedStyle reports it. */
const rgb = (hex: string): string => `rgb(${channelsOf(hex).join(', ')})`
const squash = (s: string): string => s.replace(/\s+/g, ' ').trim()

const token = (page: Page, name: string): Promise<string> =>
  page.evaluate((n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim(), `--${name}`)
const style = (el: Locator, prop: string): Promise<string> => el.evaluate((e, p) => getComputedStyle(e).getPropertyValue(p), prop)

/**
 * A detached element carrying `className`, appended to #root so the app's cascade applies. Used for the classes no
 * markup on these pages uses yet (`.stat-card`, `.btn-danger`).
 */
async function probe(page: Page, className: string): Promise<Locator> {
  await page.evaluate((c) => {
    const el = document.createElement(c.startsWith('btn-') ? 'button' : 'div')
    el.className = c
    el.dataset.probe = c
    el.textContent = 'Probe'
    document.getElementById('root')?.appendChild(el)
  }, className)
  const el = page.locator(`[data-probe="${className}"]`)
  await expect(el).toBeAttached()
  return el
}

async function openDashboard(page: Page, data: HouseholdData = household): Promise<void> {
  await mockHousehold(page, data)
  await page.goto('/')
  await expect(page.getByRole('heading', { level: 1, name: 'Dashboard' })).toBeVisible()
  await page.waitForLoadState('networkidle')
}

/** Dark, set the way the theme toggle sets it: a click on the nav's toggle writes `data-theme` on <html>. */
async function toggleDark(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Toggle theme' }).click()
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
}

test.describe('Columnar pad design tokens (STU-675)', () => {
  test('design system doc adopts Columnar pad only', async ({ page }) => {
    const doc = readRepo('docs/design-system.md')
    for (const required of ['Columnar pad', 'IBM Plex Sans', 'Phosphor', 'spine']) {
      expect.soft(doc, `doc contains "${required}"`).toContain(required)
    }
    for (const banned of ['Manila folder', 'Direction A', 'Source Sans', 'Lucide']) {
      expect.soft(doc, `doc does not contain "${banned}"`).not.toContain(banned)
    }
    expect.soft(doc.toLowerCase(), 'doc does not mention "manila" in any case').not.toContain('manila')
    // No plan/critique method section, and no two-direction framing.
    expect.soft(doc, 'no method heading').not.toMatch(/^#+ .*(method|critique|plan, critique)/im)
    expect.soft(doc, 'no "Plan 1" step').not.toMatch(/plan 1/i)
    expect.soft(doc, 'no second direction').not.toMatch(/two directions|direction b\b/i)

    const sections = ['Brief', 'Shared rules', 'Palette', 'Type', 'Spacing', 'Radius', 'Elevation', 'Icons', 'Motion', 'Components', 'Layout concept']
    for (const heading of sections) {
      expect.soft(doc, `doc has a "## ${heading}" section`).toMatch(new RegExp(`^## ${heading}$`, 'm'))
    }
    expect.soft(doc, 'light palette table').toMatch(/^### Light$/m)
    expect.soft(doc, 'dark palette table').toMatch(/^### Dark$/m)
    const rules = [
      'Tokens only',
      'Amounts',
      'Selection is not an action',
      'Labels are sentence case',
      'Radius and elevation encode level',
      'Lists are one surface with ruled rows',
      'Motion answers an action',
      'One icon set',
      'Touch targets',
      'One face',
    ]
    for (const rule of rules) expect.soft(doc, `shared rule "${rule}"`).toMatch(new RegExp(`^\\d+\\. \\*\\*${rule}`, 'm'))

    const hexes = new Set([...Object.values(LIGHT), ...Object.values(DARK)])
    for (const hex of hexes) expect.soft(doc.toUpperCase(), `B.1 hex ${hex} appears`).toContain(hex)

    for (const step of ['12 / 16', '14 / 20', '15 / 24', '18 / 26', '21 / 28', '24 / 32', '32 / 40']) {
      expect.soft(doc, `type scale step ${step}`).toContain(step)
    }
    expect.soft(doc, 'weights').toMatch(/400 body, 500 labels, 600 titles/)
    expect.soft(doc, 'spacing base').toMatch(/4px base/)
    expect.soft(doc, 'rows 56/64').toMatch(/56px \(desktop\) and 64px \(phone\)/)
    for (const r of ['4px', '6px', '12px']) expect.soft(doc, `radius ${r}`).toContain(r)
    expect.soft(doc, 'elevation').toContain('0 20px 40px -18px rgb(12 19 15 / .45)')
    expect.soft(doc, 'icon size').toMatch(/Phosphor.*Regular weight, 20px/)
    expect.soft(doc, 'motion').toContain('cubic-bezier(.3,0,.2,1)')
    expect.soft(doc, 'motion durations').toMatch(/100ms[\s\S]*160ms/)

    for (const name of ['Button', 'SegmentedControl` / `Tabs', 'ListSheet` and `Row', 'StatusText', 'EmptyState', 'Icon']) {
      const line = doc.split('\n').find((l) => l.startsWith(`| \`${name}\``))
      expect.soft(line, `component inventory row for ${name}`).toMatch(/\| planned \|/)
    }

    await page.setContent(`<pre style="font: 13px/1.4 monospace; padding: 16px; white-space: pre-wrap"></pre>`)
    await page.locator('pre').evaluate((el, text) => {
      el.textContent = text
    }, doc)
    expect(fs.existsSync(await shot(page, 'design-system-doc'))).toBe(true)
  })

  test('light tokens match Columnar pad', async ({ page }) => {
    await openDashboard(page)
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')
    for (const [name, hex] of Object.entries(LIGHT)) {
      expect.soft(await token(page, name), `--${name} is ${hex}`).toBe(channels(hex))
    }
    expect.soft(await token(page, 'on-accent'), '--on-accent is the leaf').toBe(channels(LIGHT.surface))
    expect.soft(await token(page, 'scrim'), '--scrim').toBe('12 19 15')

    expect.soft(await style(page.locator('body'), 'background-color'), 'body background is paper').toBe(rgb(LIGHT.paper))
    expect.soft(await style(await probe(page, 'stat-card'), 'background-color'), '.stat-card background is surface').toBe(rgb(LIGHT.surface))
    const h1 = page.getByRole('heading', { level: 1, name: 'Dashboard' })
    expect.soft(await style(h1, 'color'), 'dashboard h1 is ink').toBe(rgb(LIGHT.ink))
    for (const status of ['ok', 'warn', 'danger'] as const) {
      const text = page.locator(`.text-${status}:visible`).first()
      await expect(text, `a visible .text-${status} on the dashboard`).toBeVisible()
      expect.soft(await style(text, 'color'), `${status} text`).toBe(rgb(LIGHT[status]))
    }

    const lightMeta = page.locator('meta[name="theme-color"][media="(prefers-color-scheme: light)"]')
    const darkMeta = page.locator('meta[name="theme-color"][media="(prefers-color-scheme: dark)"]')
    expect.soft((await lightMeta.getAttribute('content'))?.toUpperCase(), 'light theme-color is the light paper').toBe(LIGHT.paper)
    expect.soft((await darkMeta.getAttribute('content'))?.toUpperCase(), 'dark theme-color is the spine').toBe(DARK.spine)
    await shot(page, 'light-dashboard')

    // The dashboard has no .card; the Transactions list sits on one.
    await page.goto('/transactions')
    const card = page.getByTestId('transactions-list-card')
    await expect(card).toBeVisible()
    expect.soft(await style(card, 'background-color'), '.card background is surface').toBe(rgb(LIGHT.surface))
    const primary = page.locator('.btn-primary:visible').first()
    const secondary = page.locator('.btn-secondary:visible').first()
    await expect(primary).toBeVisible()
    await expect(secondary).toBeVisible()
    expect.soft(await style(primary, 'background-color'), '.btn-primary background is accent').toBe(rgb(LIGHT.accent))
    expect.soft(await style(primary, 'color'), '.btn-primary text is on-accent').toBe('rgb(242, 245, 240)')
    expect.soft(await style(secondary, 'border-top-color'), '.btn-secondary border is line-strong').toBe(rgb(LIGHT['line-strong']))
    await shot(page, 'light-transactions')
  })

  test('dark tokens match Columnar pad', async ({ page }) => {
    await openDashboard(page)
    await toggleDark(page)
    for (const [name, hex] of Object.entries(DARK)) {
      expect.soft(await token(page, name), `--${name} is ${hex}`).toBe(channels(hex))
    }
    expect.soft(await token(page, 'spine'), '--spine').toBe('28 52 40')
    expect.soft(await token(page, 'scrim'), '--scrim is the same in dark').toBe('12 19 15')
    expect.soft(await style(page.locator('body'), 'background-color'), 'body background').toBe('rgb(17, 25, 21)')
    expect.soft(await style(page.getByRole('heading', { level: 1, name: 'Dashboard' }), 'color'), 'h1 colour').toBe('rgb(229, 238, 231)')
    await shot(page, 'dark-dashboard')

    // The toggle stored the choice, so the next page opens dark too.
    await page.goto('/transactions')
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
    const card = page.getByTestId('transactions-list-card')
    await expect(card).toBeVisible()
    expect.soft(await style(card, 'background-color'), '.card background').toBe('rgb(23, 33, 27)')
    const primary = page.locator('.btn-primary:visible').first()
    await expect(primary).toBeVisible()
    expect.soft(await style(primary, 'background-color'), '.btn-primary background').toBe('rgb(147, 205, 169)')
    await shot(page, 'dark-transactions')
  })

  test('paper texture is gone', async ({ page }) => {
    await openDashboard(page)
    for (const pseudo of ['::before', '::after']) {
      const read = await page.evaluate((p) => {
        const s = getComputedStyle(document.body, p)
        return { content: s.content, backgroundImage: s.backgroundImage }
      }, pseudo)
      expect.soft(['none', 'normal'], `body${pseudo} content (${read.content})`).toContain(read.content)
      expect.soft(read.backgroundImage, `body${pseudo} background-image`).toBe('none')
    }
    const css = readRepo('frontend/src/assets/index.css')
    expect.soft(css, 'no grain opacity token').not.toContain('--grain-opacity')
    expect.soft(css, 'no mottle opacity token').not.toContain('--mottle-opacity')
    expect.soft(css, 'no noise texture').not.toContain('feTurbulence')
    expect.soft(await token(page, 'grain-opacity'), 'no grain token at runtime').toBe('')
    expect.soft(await token(page, 'mottle-opacity'), 'no mottle token at runtime').toBe('')
    await shot(page, 'no-texture')
  })

  test('radius and elevation ladder', async ({ page }) => {
    await openDashboard(page)
    const statCard = await probe(page, 'stat-card')
    expect.soft(await style(statCard, 'border-radius'), '.stat-card radius').toBe('6px')
    expect.soft(await style(statCard, 'box-shadow'), '.stat-card shadow').toBe('none')

    // Every .btn-* class the stylesheets define, read from the CSSOM, so a new variant is covered too.
    const variants = await page.evaluate(() => {
      const found = new Set<string>()
      const walk = (rules: CSSRuleList) => {
        for (const rule of Array.from(rules)) {
          if (rule instanceof CSSStyleRule) for (const m of rule.selectorText.matchAll(/\.(btn-[a-z-]+)/g)) found.add(m[1])
          if ('cssRules' in rule) walk((rule as CSSGroupingRule).cssRules)
        }
      }
      for (const sheet of Array.from(document.styleSheets)) {
        // The web-font sheet is cross-origin and unreadable; every app rule is same-origin.
        if (sheet.href && new URL(sheet.href).origin !== location.origin) continue
        walk(sheet.cssRules)
      }
      return [...found].sort()
    })
    expect.soft(variants, 'the button variants').toEqual(['btn-danger', 'btn-primary', 'btn-secondary'])
    for (const variant of variants) {
      expect.soft(await style(await probe(page, variant), 'border-radius'), `.${variant} radius`).toBe('4px')
    }
    await shot(page, 'ladder-dashboard')

    await page.goto('/transactions')
    const card = page.getByTestId('transactions-list-card')
    await expect(card).toBeVisible()
    expect.soft(await style(card, 'border-radius'), '.card radius').toBe('6px')
    expect.soft(await style(card, 'box-shadow'), '.card shadow').toBe('none')
    for (const variant of ['btn-primary', 'btn-secondary']) {
      const button = page.locator(`.${variant}:visible`).first()
      await expect(button).toBeVisible()
      expect.soft(await style(button, 'border-radius'), `a rendered .${variant} radius`).toBe('4px')
    }
    const row = page.locator('[data-testid="due-row"]:visible').first()
    await expect(row).toBeVisible()
    expect.soft(await style(row, 'border-radius'), 'a ruled list row is square').toBe('0px')
    await shot(page, 'ladder-transactions')

    await page.goto('/accounts')
    await page.getByRole('button', { name: 'Add Account', exact: true }).click()
    const panel = page.locator('.fixed.inset-0.overflow-y-auto.bg-black\\/60 > .min-h-full > *').last()
    await expect(panel).toBeVisible()
    await expect(panel.getByRole('heading', { name: 'Create Account' })).toBeVisible()
    expect.soft(await style(panel, 'border-radius'), 'dialog radius').toBe('12px')
    const shadow = await style(panel, 'box-shadow')
    expect.soft(shadow, 'dialog shadow').not.toBe('none')
    expect.soft(shadow, 'dialog shadow is --elev-dialog').toBe('rgba(12, 19, 15, 0.45) 0px 20px 40px -18px')
    // The dialog is a fixed overlay: a viewport screenshot, saved under shot()'s naming.
    const info = test.info()
    await page.screenshot({ path: path.join(info.project.outputDir, 'screens', `design-tokens-ladder-dialog-${info.project.name}.png`), animations: 'disabled' })
  })

  test('type scale and mappings match Columnar pad', async ({ page }) => {
    await openDashboard(page)
    const body = page.locator('body')
    expect.soft(await style(body, 'font-size'), 'body font-size').toBe('15px')
    expect.soft(await style(body, 'line-height'), 'body line-height').toBe('24px')

    const tokens: Record<string, string> = {
      'radius-sm': '4px',
      'radius-md': '6px',
      'radius-lg': '12px',
      'elev-dialog': '0 20px 40px -18px rgb(12 19 15 / .45)',
      'dur-fast': '100ms',
      'dur-base': '160ms',
      ease: 'cubic-bezier(.3,0,.2,1)',
    }
    for (const [name, value] of Object.entries(tokens)) {
      expect.soft(squash(await token(page, name)), `--${name}`).toBe(value)
    }

    const config = resolveConfig(loadConfig(path.join(FRONTEND, 'tailwind.config.js')))
    const theme = config.theme as unknown as {
      fontSize: Record<string, [string, { lineHeight: string }]>
      colors: Record<string, unknown>
      borderRadius: Record<string, string>
      boxShadow: Record<string, string>
      transitionDuration: Record<string, string>
      transitionTimingFunction: Record<string, string>
    }
    const px = (rem: string): number => parseFloat(rem) * 16
    const scale: Record<string, [number, number]> = {
      xs: [12, 16],
      sm: [14, 20],
      base: [15, 24],
      lg: [18, 26],
      xl: [21, 28],
      '2xl': [24, 32],
      '3xl': [32, 40],
    }
    for (const [step, [size, lineHeight]] of Object.entries(scale)) {
      const [s, opts] = theme.fontSize[step] ?? ['', { lineHeight: '' }]
      expect.soft([px(s), px(opts.lineHeight)], `text-${step} is ${size} / ${lineHeight}`).toEqual([size, lineHeight])
    }
    for (const color of ['accent', 'on-accent', 'spine', 'on-spine', 'on-spine-muted', 'scrim']) {
      expect.soft(theme.colors[color], `colour ${color}`).toBe(`rgb(var(--${color}) / <alpha-value>)`)
    }
    for (const r of ['sm', 'md', 'lg']) expect.soft(theme.borderRadius[r], `rounded-${r}`).toBe(`var(--radius-${r})`)
    expect.soft(theme.boxShadow.dialog, 'shadow-dialog').toBe('var(--elev-dialog)')
    expect.soft(theme.transitionDuration.fast, 'duration-fast').toBe('var(--dur-fast)')
    expect.soft(theme.transitionDuration.base, 'duration-base').toBe('var(--dur-base)')
    expect.soft(theme.transitionTimingFunction.standard, 'ease-standard').toBe('var(--ease)')
    await shot(page, 'type-scale')
  })

  test('no render shims and deferred changes untouched', async ({ page }) => {
    await openDashboard(page)
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
    const lastCompound = (s: string): string => s.split(/[ >+~]/).pop() ?? ''
    const complexes = rules.flatMap((r) => norm(r.selector).split(',').map((selector) => ({ selector, css: r.css })))
    const shims: Record<string, (c: { selector: string; css: string }) => boolean> = {
      ':has(> article.card)': (c) => c.selector.includes(':has(>article.card)'),
      '.uppercase override': (c) => c.selector === '.uppercase' && !c.css.includes('text-transform: uppercase'),
      '.tracking-wide override': (c) => c.selector === '.tracking-wide' && !c.css.includes('letter-spacing: 0.025em'),
      "bare [aria-pressed='true']": (c) => lastCompound(c.selector).includes('[aria-pressed=true]') && !lastCompound(c.selector).includes('.'),
      "bare [role='tab'][aria-selected='true']": (c) =>
        lastCompound(c.selector).includes('[role=tab][aria-selected=true]') && !lastCompound(c.selector).includes('.'),
      'nav.safe-area-top .bg-surface': (c) => c.selector.includes('nav.safe-area-top .bg-surface'),
      'article .text-lg.font-bold.text-danger': (c) => c.selector.includes('article .text-lg.font-bold.text-danger'),
      "[aria-current='page']": (c) => c.selector.includes('[aria-current=page]'),
    }
    for (const [name, matches] of Object.entries(shims)) {
      expect.soft(complexes.filter(matches).map((c) => c.selector), `no rule for the ${name} shim`).toEqual([])
    }
    await shot(page, 'no-shims')
  })

  test('no render shims and deferred changes untouched: deferred files match the PR base', () => {
    const git = (args: string[]) => spawnSync('git', args, { cwd: REPO, encoding: 'utf8' })
    const branch = process.env.GITHUB_BASE_REF || 'main'
    const ref = `origin/${branch}`
    if (git(['rev-parse', '--verify', '--quiet', ref]).status !== 0) {
      // A CI checkout is shallow and has only the merge commit: fetch the base branch tip.
      const fetched = git(['fetch', '--no-tags', '--depth=1', 'origin', `+refs/heads/${branch}:refs/remotes/${ref}`])
      expect(fetched.status, `fetch ${ref}: ${fetched.stderr}`).toBe(0)
    }
    const mergeBase = git(['merge-base', 'HEAD', ref])
    const base = mergeBase.status === 0 ? mergeBase.stdout.trim() : ref
    const SPEC = 'frontend/e2e/design-tokens.spec.ts'
    // These checks bind the PR that adds this spec (STU-675). Later tickets own the deferred files, so once the spec
    // is on the base branch the check has nothing to guard.
    test.skip(git(['cat-file', '-e', `${base}:${SPEC}`]).status === 0, `${SPEC} is already on ${ref}`)

    const atBase = (rel: string): string => {
      const shown = git(['show', `${base}:${rel}`])
      expect(shown.status, `read ${rel} at ${base}: ${shown.stderr}`).toBe(0)
      return shown.stdout
    }
    const lines = (text: string, pattern: RegExp): string[] => text.split('\n').filter((l) => pattern.test(l)).map((l) => l.trim())

    // Components and the top bar's markup: nothing under frontend/src changes but the token sheet.
    const changed = git(['diff', '--name-only', base, '--', 'frontend/src'])
    const added = git(['ls-files', '--others', '--exclude-standard', '--', 'frontend/src'])
    expect(changed.status, changed.stderr).toBe(0)
    const touched = [...changed.stdout.split('\n'), ...added.stdout.split('\n')].filter((f) => f && f !== 'frontend/src/assets/index.css')
    expect.soft(touched, 'component, route and top bar files are unchanged').toEqual([])

    // Fonts (STU-676): every font-family declaration and font source, in all four places they live.
    const fontLine = /font-family|--font-(sans|serif|mono)|fontFamily|(sans|serif|mono): \[|fonts\.g|@fontsource/
    for (const file of ['frontend/src/assets/index.css', 'frontend/tailwind.config.js', 'frontend/index.html', 'frontend/package.json']) {
      expect.soft(lines(readRepo(file), fontLine), `font declarations in ${file}`).toEqual(lines(atBase(file), fontLine))
    }

    // The top bar (STU-684): no rule for the nav or its safe-area band changes.
    const navLine = /\bnav\b|safe-area-top/
    const css = readRepo('frontend/src/assets/index.css')
    const baseCss = atBase('frontend/src/assets/index.css')
    expect.soft(lines(css, navLine), 'top bar rules in index.css').toEqual(lines(baseCss, navLine))

    // The .card hover (STU-692): the hover and transition utilities on .card and .stat-card stay as they were.
    const hoverOf = (text: string, cls: string): string[] => {
      const block = text.match(new RegExp(`\\n\\s*\\.${cls} \\{([^}]*)\\}`))?.[1] ?? ''
      return block.split(/\s+/).filter((t) => /^(hover:|transition|duration-)/.test(t))
    }
    for (const cls of ['card', 'stat-card']) {
      const before = hoverOf(baseCss, cls)
      expect.soft(before.length, `.${cls} had hover rules at the base`).toBeGreaterThan(0)
      expect.soft(hoverOf(css, cls), `.${cls} hover rules`).toEqual(before)
    }
  })

  const pages = [
    { name: 'dashboard', path: '/', heading: 'Dashboard' },
    { name: 'transactions', path: '/transactions', heading: 'Transactions' },
    { name: 'allocations', path: '/allocations', heading: 'Allocations' },
  ]
  const variants: [string, HouseholdData][] = [
    ['household', household],
    ['calmHousehold', calmHousehold],
    ['emptyHousehold', emptyHousehold],
  ]
  for (const [variant, data] of variants) {
    for (const p of pages) {
      test(`household fixtures render and satisfy their data contracts: ${p.name} (${variant})`, async ({ page }) => {
        const errors: string[] = []
        page.on('console', (m) => {
          if (m.type() === 'error') errors.push(m.text())
        })
        page.on('pageerror', (e) => errors.push(e.message))
        const api = await mockHousehold(page, data)
        await page.goto(p.path)
        await expect(page.getByRole('heading', { level: 1, name: p.heading })).toBeVisible()
        await page.waitForLoadState('networkidle')
        expect(api.requests().length, 'the page called the faked API').toBeGreaterThan(0)
        // mockApi soft-fails any unmocked call; this names the calls in the report as well.
        expect(api.requests().filter((r) => !r.startsWith('GET ')), 'only reads on load').toEqual([])
        expect(errors, 'no console errors').toEqual([])
        await shot(page, `${p.name}-${variant}`)
      })
    }
  }

  test('household fixtures render and satisfy their data contracts: household data', () => {
    const shared = household.transactions.filter((t) => t.view !== 'limited' && SHARED_ACCOUNT_IDS.includes(t.account_id))
    expect.soft(shared.length, 'shared-account transactions').toBeGreaterThanOrEqual(3)
    expect.soft(shared.some((t) => t.view === 'shared_full'), 'someone else entered a shared row').toBe(true)
    const days = household.transactions.map((t) => (t.view === 'limited' ? t.date : t.transaction_date).slice(0, 10)).sort()
    const span = (Date.parse(days[days.length - 1]) - Date.parse(days[0])) / 86_400_000
    expect.soft(span, 'transactions span a month').toBeGreaterThanOrEqual(28)
    expect.soft(household.entries.length, 'recurring entries').toBeGreaterThan(0)
    expect.soft(household.payables.filter((p) => p.overdue).length, 'an overdue payable').toBe(1)
    const cards = household.accounts.filter((a) => a.account_type === 'credit')
    const withStatement = cards.filter((a) => household.snapshot.card_statements_due.some((s) => s.account_id === a.id))
    expect.soft(withStatement.length, 'a card with a statement').toBe(1)
    expect.soft(household.due.card_statements_due, 'the Due card sees the statement').toEqual(household.snapshot.card_statements_due)
    expect.soft(household.occurrences.length, 'upcoming occurrences').toBe(18)
    const listed = household.due.upcoming_occurrences.items.length + household.due.subscription_occurrences.items.length
    expect.soft(listed, 'the Due card lists all 18').toBe(18)
    expect.soft(household.quickBalances.tiles.length, 'quick balances').toBeGreaterThan(0)
  })

  test('household fixtures render and satisfy their data contracts: calmHousehold data', () => {
    const calm = calmHousehold
    expect.soft(calm.payables.filter((p) => p.overdue), 'no overdue payable').toEqual([])
    expect.soft(calm.snapshot.payables.filter((p) => p.overdue), 'no overdue payable on the dashboard').toEqual([])
    expect.soft(calm.cardStatements.filter((s) => s.overdue), 'no overdue statement').toEqual([])
    expect.soft(calm.snapshot.missed, 'nothing missed').toEqual([])
    expect.soft(calm.accounts.filter((a) => a.balance < 0).map((a) => a.name), 'no negative balance').toEqual([])
    expect.soft(calm.quickBalances.tiles.filter((t) => t.balance < 0).map((t) => t.name), 'no negative tile').toEqual([])
    expect.soft(calm.summary.summary.net_flow, 'net flow').toBeGreaterThanOrEqual(0)
    expect.soft(calm.snapshot.monthly_summary.monthly_disposable, 'disposable').toBeGreaterThanOrEqual(0)
    expect.soft(calm.timeline.shortfall, 'no shortfall').toBe(false)
    expect.soft(calm.timeline.lowest_balance, 'lowest projected balance').toBeGreaterThanOrEqual(0)
    expect.soft(calm.occurrences.filter((o) => o.auto_post === 'blocked'), 'nothing failed to auto-post').toEqual([])
    expect.soft(calm.snapshot.installment_auto_post, 'no auto-post problems').toEqual([])
  })

  test('household fixtures render and satisfy their data contracts: emptyHousehold data', () => {
    expect.soft(emptyHousehold.transactions, 'no transactions').toEqual([])
    expect.soft(emptyHousehold.entries, 'no recurring entries').toEqual([])
    expect.soft(emptyHousehold.occurrences, 'no occurrences').toEqual([])
    expect.soft(emptyHousehold.accounts.length, 'the accounts are still there').toBeGreaterThan(0)
  })
})
