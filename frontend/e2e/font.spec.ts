// STU-676: one face. Every glyph is IBM Plex Sans, served from the app's own origin through @fontsource, with no request
// to Google Fonts. The API is faked in the browser with the shared household fixture; there is no backend.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test } from '@playwright/test'
import type { Locator, Page } from '@playwright/test'
import { mockHousehold } from './support/fixtures/household'
import { shot } from './support/shot'

// This spec lives in <repo>/frontend/e2e.
const FRONTEND = fileURLToPath(new URL('..', import.meta.url))
const read = (rel: string): string => fs.readFileSync(path.join(FRONTEND, rel), 'utf8')

interface PageCase {
  name: string
  path: string
  /** The page's first content row, once the mocked data has rendered (used by the fallback scenario). */
  row: (page: Page) => Locator
}

/** The three pages. `row` is the fixed locator for the first content row of each. */
const PAGES: PageCase[] = [
  { name: 'dashboard', path: '/', row: (page) => page.getByTestId('quick-balance-tile').first() },
  { name: 'transactions', path: '/transactions', row: (page) => page.locator('article[data-transaction-id]').first() },
  { name: 'allocations', path: '/allocations', row: (page) => page.locator('[data-testid^="kind-section-"] article').first() },
]

async function open(page: Page, c: PageCase): Promise<void> {
  await mockHousehold(page)
  await page.goto(c.path)
  await expect(c.row(page)).toBeVisible()
  await page.waitForLoadState('networkidle')
}

test.describe('One face: IBM Plex Sans (STU-676)', () => {
  for (const c of PAGES) {
    test(`every element uses IBM Plex Sans (${c.name})`, async ({ page }) => {
      await open(page, c)
      const found = await page.evaluate(() => {
        const offenders: string[] = []
        let checked = 0
        for (const el of Array.from(document.querySelectorAll('body *'))) {
          if (el.closest('svg')) continue
          if (!el.checkVisibility() || el.getClientRects().length === 0) continue
          checked += 1
          const family = getComputedStyle(el).fontFamily
          if (!family.startsWith('"IBM Plex Sans"')) offenders.push(`${el.tagName.toLowerCase()}.${el.getAttribute('class') ?? ''}: ${family}`)
        }
        return { checked, offenders }
      })
      expect.soft(found.checked, 'visible elements were checked').toBeGreaterThan(20)
      expect(found.offenders, 'visible elements whose font-family does not start with "IBM Plex Sans"').toEqual([])
      await shot(page, `all-plex-${c.name}`)
    })
  }

  for (const c of PAGES) {
    test(`no Google Fonts request (${c.name})`, async ({ page, baseURL }) => {
      const urls: string[] = []
      page.on('request', (r) => urls.push(r.url()))
      await open(page, c)
      const google = urls.filter((u) => /fonts\.googleapis\.com|fonts\.gstatic\.com/.test(new URL(u).host))
      expect(google, 'requests to Google Fonts hosts').toEqual([])
      const own = urls.filter((u) => new URL(u).origin === new URL(baseURL ?? '').origin && /\.woff2$/.test(new URL(u).pathname))
      expect(own.length, 'a .woff2 served from the app origin').toBeGreaterThan(0)
      expect.soft(read('index.html'), 'index.html has no preconnect to Google Fonts').not.toMatch(/preconnect[^>]*fonts\.g(oogleapis|static)\.com/)
      await shot(page, `no-google-${c.name}`)
    })
  }

  test('peso sign is served by Plex', async ({ page }) => {
    await open(page, PAGES[0])
    await expect(page.getByTestId('quick-balance-balance').first()).toContainText('₱')
    const found = await page.evaluate(async () => {
      await document.fonts.ready
      const inRange = (range: string, cp: number): boolean =>
        range.split(',').some((part) => {
          const [lo, hi] = part.trim().replace(/^U\+/i, '').split('-')
          const from = parseInt(lo, 16)
          return cp >= from && cp <= (hi === undefined ? from : parseInt(hi, 16))
        })
      const plex = Array.from(document.fonts).filter((f) => f.family.replace(/["']/g, '') === 'IBM Plex Sans')
      return {
        check: [400, 500, 600].map((w) => document.fonts.check(`${w} 15px "IBM Plex Sans"`)),
        pesoFace: plex.filter((f) => f.status === 'loaded' && inRange(f.unicodeRange, 0x20b1)).length,
        loaded: plex.filter((f) => f.status === 'loaded').length,
      }
    })
    expect.soft(found.check, 'document.fonts.check for weights 400, 500, 600').toEqual([true, true, true])
    expect(found.pesoFace, 'loaded IBM Plex Sans faces whose unicode-range includes U+20B1').toBeGreaterThan(0)
    await shot(page, 'peso')
  })

  test('figures are tabular', async ({ page }) => {
    await open(page, PAGES[0])
    const widths = await page.evaluate(async () => {
      await document.fonts.load('400 15px "IBM Plex Sans"', '1111.11')
      const measure = (text: string): number => {
        const span = document.createElement('span')
        span.textContent = text
        document.body.appendChild(span)
        const w = span.getBoundingClientRect().width
        span.remove()
        return w
      }
      return { narrow: measure('1111.11'), wide: measure('8888.88') }
    })
    expect.soft(widths.narrow, 'the span has a width').toBeGreaterThan(20)
    expect(Math.abs(widths.narrow - widths.wide), `1111.11 is ${widths.narrow}px, 8888.88 is ${widths.wide}px`).toBeLessThanOrEqual(0.5)
    await shot(page, 'tabular')
  })

  test('only Plex is declared', async ({ page }) => {
    const pkg = JSON.parse(read('package.json')) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> }
    const deps = { ...pkg.dependencies, ...pkg.devDependencies }
    expect.soft(Object.keys(deps), 'package.json lists @fontsource/ibm-plex-sans').toContain('@fontsource/ibm-plex-sans')
    expect.soft(Object.keys(deps).filter((n) => /^@fontsource/.test(n)), 'no other @fontsource package').toEqual(['@fontsource/ibm-plex-sans'])
    for (const file of ['src/assets/index.css', 'index.html']) {
      const text = read(file)
      for (const banned of ['Inter', 'Instrument Serif', 'JetBrains Mono']) expect.soft(text, `${file} does not contain ${banned}`).not.toContain(banned)
    }
    await open(page, PAGES[0])
    await shot(page, 'declared')
  })

  for (const c of PAGES) {
    test(`fallback stack keeps the pages readable (${c.name})`, async ({ page }) => {
      // Fresh context per test (the `page` fixture). Every font file is aborted, woff as well as woff2, so the
      // @font-face falls through to the system stack instead of to the woff copy.
      let aborted = 0
      await page.route(/\.woff2?(\?.*)?$/, async (route) => {
        aborted += 1
        await route.abort()
      })
      await mockHousehold(page)
      await page.goto(c.path)
      const row = c.row(page)
      await expect(row).toBeVisible()
      const before = (await row.boundingBox())?.y ?? NaN
      await page.evaluate(async () => {
        await document.fonts.ready
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
      })
      const after = (await row.boundingBox())?.y ?? NaN
      expect.soft(aborted, 'font files were requested and aborted').toBeGreaterThan(0)
      expect(Math.abs(after - before), `first row y moved from ${before} to ${after}`).toBeLessThanOrEqual(2)
      await expect(row.getByText(/\d/).first(), 'the row still shows its figures').toBeVisible()
      await expect(page.getByRole('heading', { level: 1 }), 'the page heading is visible').toBeVisible()
      await shot(page, `fallback-${c.name}`)
    })
  }

  // Values recorded from main before this change (all in px or keywords, none depends on the face).
  test('wordmark and label styling stays unchanged (wordmark)', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop', 'the wordmark is hidden below the md breakpoint')
    await open(page, PAGES[0])
    const wordmark = page.getByText('Tally & Trace', { exact: true })
    await expect(wordmark).toBeVisible()
    await expect.soft(wordmark).toHaveCSS('font-size', '18px')
    await expect.soft(wordmark).toHaveCSS('font-weight', '400')
    await expect.soft(wordmark).toHaveCSS('font-family', /^"IBM Plex Sans"/)
    await shot(page, 'wordmark')
  })

  test('wordmark and label styling stays unchanged (search label)', async ({ page }) => {
    await open(page, PAGES[1])
    const label = page.locator('.label:visible', { hasText: 'Search transactions' })
    await expect(label).toHaveText('Search transactions')
    await expect.soft(label).toHaveCSS('font-size', '11px')
    await expect.soft(label).toHaveCSS('text-transform', 'uppercase')
    await expect.soft(label).toHaveCSS('font-family', /^"IBM Plex Sans"/)
    await shot(page, 'label')
  })

  for (const text of ['Home', 'Accounts', 'Transactions', 'Goals']) {
    test(`wordmark and label styling stays unchanged (tab bar ${text})`, async ({ page }, testInfo) => {
      test.skip(testInfo.project.name !== 'phone', 'the tab bar is phone only')
      await open(page, PAGES[0])
      const label = page.locator('.label:visible', { hasText: new RegExp(`^${text}$`) })
      await expect(label).toHaveText(text)
      await expect.soft(label).toHaveCSS('font-size', '11px')
      await expect.soft(label).toHaveCSS('text-transform', 'uppercase')
      await expect.soft(label).toHaveCSS('font-family', /^"IBM Plex Sans"/)
      // The tab bar is position: fixed, so a viewport screenshot, saved under shot()'s naming.
      const info = test.info()
      await page.screenshot({ path: path.join(info.project.outputDir, 'screens', `font-tabbar-${text.toLowerCase()}-${info.project.name}.png`), animations: 'disabled' })
    })
  }
})
