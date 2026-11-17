// STU-691: the tokens-only sweep. Colours and sizes in components come from tokens: the swatch and chart palettes are
// CSS variables, overlays use the scrim token, sizes sit on the 4px spacing scale, and saved tag and category
// colours are never rewritten. The API is faked in the browser with the shared household fixture; there is no backend.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test } from '@playwright/test'
import type { Locator, Page } from '@playwright/test'
import { apiRoute, mockApi } from './support/mockApi'
import type { ApiMock } from './support/mockApi'
import {
  colouredHousehold,
  customTags,
  household,
  LEGACY_SWATCHES,
  legacyTags,
  mockHousehold,
  upperBlueTag,
} from './support/fixtures/household'
import type { HouseholdData } from './support/fixtures/household'
import { shot } from './support/shot'
import type { Category, Tag } from '@tally-trace/shared'

// This spec lives in <repo>/frontend/e2e.
const FRONTEND = fileURLToPath(new URL('..', import.meta.url))
const SRC = path.join(FRONTEND, 'src')

type Theme = 'light' | 'dark'
const THEMES: Theme[] = ['light', 'dark']

/** Every `.ts`, `.tsx` and `.css` file under frontend/src, as `src/...` paths. */
function sourceFiles(dir: string = SRC): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
    const full = path.join(dir, d.name)
    if (d.isDirectory()) return sourceFiles(full)
    return /\.(ts|tsx|css)$/.test(d.name) ? [path.relative(FRONTEND, full)] : []
  })
}

/** Every match of `pattern` in the files, as `file:line: text`. A file in `skip` is not scanned. */
function scan(pattern: RegExp, skip: readonly string[] = []): string[] {
  const hits: string[] = []
  for (const file of sourceFiles()) {
    if (skip.includes(file)) continue
    fs.readFileSync(path.join(FRONTEND, file), 'utf8')
      .split('\n')
      .forEach((line, i) => {
        for (const m of line.matchAll(pattern)) hits.push(`${file}:${i + 1}: ${m[0]}`)
      })
  }
  return hits
}

const read = (rel: string): string => fs.readFileSync(path.join(FRONTEND, rel), 'utf8')

/** A viewport screenshot (a full-page one draws a fixed layer at the scroll offset), saved like `shot()`. */
async function viewportShot(page: Page, name: string): Promise<string> {
  const info = test.info()
  const spec = path.basename(info.file).replace(/\.spec\.ts$/, '')
  const file = path.join(info.project.outputDir, 'screens', `${spec}-${name}-${info.project.name}.png`)
  await page.screenshot({ path: file, animations: 'disabled' })
  return file
}

const token = (page: Page, name: string): Promise<string> =>
  page.evaluate((n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim(), `--${name}`)
const style = (el: Locator, prop: string): Promise<string> => el.evaluate((e, p) => getComputedStyle(e).getPropertyValue(p), prop)

/** A token's `r g b` channels as `[r, g, b]`. */
const channelsOf = (value: string): number[] => value.trim().split(/\s+/).map(Number)
/** A token's colour as getComputedStyle reports an opaque colour: `rgb(r, g, b)`. */
const rgbOf = (value: string): string => `rgb(${channelsOf(value).join(', ')})`

/** The channels of a computed `rgb(r, g, b)` or `rgba(r, g, b, a)`. */
const parseRgb = (value: string): number[] => (value.match(/[\d.]+/g) ?? []).map(Number)
const luminance = ([r, g, b]: number[]): number => {
  const lin = (c: number): number => {
    const s = (c ?? 0) / 255
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * lin(r ?? 0) + 0.7152 * lin(g ?? 0) + 0.0722 * lin(b ?? 0)
}
/** WCAG contrast ratio between two computed colours. */
const contrast = (a: string, b: string): number => {
  const [x, y] = [luminance(parseRgb(a)), luminance(parseRgb(b))]
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05)
}

/** Switches the page to `theme` the way the theme toggle does: `data-theme` on <html>. */
async function setTheme(page: Page, theme: Theme): Promise<void> {
  await page.evaluate((t) => document.documentElement.setAttribute('data-theme', t), theme)
  await expect(page.locator('html')).toHaveAttribute('data-theme', theme)
}

const swatchRgb = async (page: Page, n: number): Promise<string> => rgbOf(await token(page, `swatch-${n}`))

/** Opens `route` with `data` faked, ready for the page's own content. */
async function open(page: Page, route: string, data: HouseholdData = household): Promise<ApiMock> {
  const api = await mockHousehold(page, data)
  await page.goto(route)
  return api
}

/** Fakes the writes Settings can make for the coloured fixture, so a save is answered and recorded. */
async function allowWrites(page: Page, data: HouseholdData): Promise<void> {
  await mockApi(page, [], {
    allow: [
      ...data.tags.map((t) => apiRoute<Tag>('PUT', `/tags/${t.id}`, t)),
      ...data.categories.map((c) => apiRoute<Category>('PUT', `/categories/${c.id}`, c)),
    ],
  })
}

/** Whether a call changed server state (anything but a GET). */
const isWrite = (request: string): boolean => !request.startsWith('GET ')

// ─── AC1 ────────────────────────────────────────────────────────────────────────────────────────

/** The only files that may hold a colour literal: the token definitions and the palette module. */
const COLOUR_ALLOW = ['src/assets/index.css', 'src/utils/palette.ts']
const RAW_HEX = /#[0-9a-fA-F]{3,8}\b/g
// `rgb(var(--token))` reads a token; any other rgb( or rgba( is a raw colour.
const RAW_RGB = /\brgba?\((?!\s*var\()/g
const RAW_CLASS = /\b(?:bg|border|text)-(?:black|white)\b/g

test.describe('tokens-only sweep (STU-691)', () => {
  test('no raw colour in source', async ({ page }) => {
    await open(page, '/')
    await expect(page.getByRole('heading', { level: 1, name: 'Dashboard' })).toBeVisible()
    // The scan is not vacuous: each pattern finds a sample it must reject.
    expect('color: #7c3aed; fill: rgba(0, 0, 0, .5)'.match(RAW_HEX)).toHaveLength(1)
    expect('fill: rgba(0, 0, 0, .5); rgb(0 0 0)'.match(RAW_RGB)).toHaveLength(2)
    expect('bg-black/60 border-black/10 text-white'.match(RAW_CLASS)).toHaveLength(3)
    expect(sourceFiles().length).toBeGreaterThan(50)
    expect(COLOUR_ALLOW.every((f) => fs.existsSync(path.join(FRONTEND, f)))).toBe(true)

    expect(scan(RAW_HEX, COLOUR_ALLOW)).toEqual([])
    expect(scan(RAW_RGB, COLOUR_ALLOW)).toEqual([])
    expect(scan(RAW_CLASS)).toEqual([])
    await shot(page, 'no-raw-colour')
  })

  // ─── AC2 ────────────────────────────────────────────────────────────────────────────────────

  interface DialogPage {
    name: string
    route: string
    trigger: (p: Page) => Locator
  }
  const DIALOGS: DialogPage[] = [
    { name: 'accounts', route: '/accounts', trigger: (p) => p.getByRole('button', { name: 'Add Account', exact: true }) },
    { name: 'transactions', route: '/transactions', trigger: (p) => p.getByRole('button', { name: 'Add Transaction' }).first() },
    { name: 'allocations', route: '/allocations', trigger: (p) => p.getByRole('button', { name: 'Add Recurring Entry' }) },
    { name: 'settings categories', route: '/settings', trigger: (p) => p.getByRole('button', { name: 'Add category', exact: true }) },
    { name: 'settings tags', route: '/settings', trigger: (p) => p.getByRole('button', { name: 'Add tag', exact: true }) },
  ]
  for (const d of DIALOGS) {
    test(`backdrops use the scrim token: ${d.name}`, async ({ page }) => {
      await open(page, d.route)
      await expect(d.trigger(page)).toBeVisible()
      await d.trigger(page).click()
      const overlay = page.locator('.fixed.inset-0.overflow-y-auto.bg-scrim\\/60').last()
      await expect(overlay).toBeVisible()
      for (const theme of THEMES) {
        await setTheme(page, theme)
        const [r, g, b] = channelsOf(await token(page, 'scrim'))
        expect(await style(overlay, 'background-color')).toBe(`rgba(${r}, ${g}, ${b}, 0.6)`)
        await viewportShot(page, `backdrop-${d.name.replace(' ', '-')}-${theme}`)
      }
    })
  }

  // ─── AC3 ────────────────────────────────────────────────────────────────────────────────────

  /** Arbitrary pixel sizes that may stay, each with its reason. At most three. */
  const PX_ALLOW: { file: string; token: string; reason: string }[] = []
  const ARBITRARY_PX = /-\[\d+px\]/g
  const SCOPED = ['w-[59px]', 'h-[38px]', 'h-[150px]', 'min-h-[126px]', 'pl-[18px]']
  /** Each scoped class, where it was, what replaces it, and the size the replacement resolves to. */
  const REPLACED = [
    { was: 'w-[59px]', file: 'src/components/CardCreditPanel.tsx', now: 'w-14', prop: 'width', px: 56 },
    { was: 'h-[38px]', file: 'src/components/CardCreditPanel.tsx', now: 'h-10', prop: 'height', px: 40 },
    { was: 'h-[150px]', file: 'src/components/CashflowTimelineCard.tsx', now: 'h-36', prop: 'height', px: 144 },
    { was: 'min-h-[126px]', file: 'src/components/CardCreditPanel.tsx', now: 'min-h-32', prop: 'min-height', px: 128 },
    { was: 'pl-[18px]', file: 'src/components/SpendingBreakdownDialog.tsx', now: 'pl-5', prop: 'padding-left', px: 20 },
  ]

  test('no arbitrary pixel sizes', async ({ page }) => {
    await open(page, '/')
    await expect(page.getByRole('heading', { level: 1, name: 'Dashboard' })).toBeVisible()
    expect(PX_ALLOW.length).toBeLessThanOrEqual(3)
    expect(PX_ALLOW.every((a) => a.reason.length > 0 && !SCOPED.includes(a.token))).toBe(true)
    expect('h-[150px] min-h-[44px]'.match(ARBITRARY_PX)).toHaveLength(2)
    const allowed = new Set(PX_ALLOW.map((a) => `${a.file}: ${a.token}`))
    expect(scan(ARBITRARY_PX).filter((hit) => !allowed.has(hit.replace(/:\d+:/, ':')))).toEqual([])
    await shot(page, 'no-arbitrary-px')
  })

  for (const r of REPLACED) {
    test(`no arbitrary pixel sizes: ${r.was} becomes ${r.now}`, async ({ page }) => {
      await open(page, '/')
      await expect(page.getByRole('heading', { level: 1, name: 'Dashboard' })).toBeVisible()
      expect(read(r.file)).not.toContain(r.was)
      expect(read(r.file)).toContain(r.now)
      // A probe element carrying the replacement class resolves to a size on the 4px grid.
      const px = await page.evaluate(
        ({ cls, prop }) => {
          const el = document.createElement('div')
          el.className = cls
          document.getElementById('root')?.appendChild(el)
          const value = parseFloat(getComputedStyle(el).getPropertyValue(prop))
          el.remove()
          return value
        },
        { cls: r.now, prop: r.prop },
      )
      expect(px).toBe(r.px)
      expect(px % 4).toBe(0)
      await shot(page, `px-${r.now}`)
    })
  }

  // ─── AC4 ────────────────────────────────────────────────────────────────────────────────────

  for (const theme of THEMES) {
    test(`swatches and charts come from tokens: tag swatches, ${theme}`, async ({ page }) => {
      await open(page, '/settings', colouredHousehold)
      await setTheme(page, theme)
      await page.getByRole('button', { name: 'Add tag', exact: true }).click()
      const swatches = page.getByRole('button', { name: /^Colour #/ })
      await expect(swatches).toHaveCount(LEGACY_SWATCHES.length)
      for (const [i, l] of LEGACY_SWATCHES.entries()) {
        expect.soft(await style(swatches.nth(i), 'background-color'), `swatch ${l.swatch}`).toBe(await swatchRgb(page, l.swatch))
      }
      await viewportShot(page, `swatches-${theme}`)
    })

    // Categories without a saved colour: the slices are the chart tokens, in order.
    test(`swatches and charts come from tokens: chart slices, ${theme}`, async ({ page }) => {
      await open(page, '/transactions')
      await setTheme(page, theme)
      await page.getByRole('button', { name: 'Spending breakdown' }).click()
      const slices = page.locator('svg[aria-label="Spending by category"] circle')
      await expect(slices.first()).toBeVisible()
      const chart = await Promise.all([1, 2, 3, 4, 5].map(async (n) => rgbOf(await token(page, `chart-${n}`))))
      const muted = rgbOf(await token(page, 'muted'))
      const count = await slices.count()
      expect(count).toBeGreaterThan(1)
      expect(await style(slices.first(), 'stroke')).toBe(chart[0])
      expect(await style(slices.nth(1), 'stroke')).toBe(chart[1])
      for (let i = 0; i < count; i++) {
        expect.soft([...chart, muted], `slice ${i}`).toContain(await style(slices.nth(i), 'stroke'))
      }
      await viewportShot(page, `chart-${theme}`)
    })
  }

  // ─── AC5 ────────────────────────────────────────────────────────────────────────────────────

  const PALETTE_TAGS: Tag[] = [...legacyTags, upperBlueTag]
  for (const theme of THEMES) {
    test(`tag chips stay readable: ${theme}`, async ({ page }) => {
      await open(page, '/transactions', colouredHousehold)
      await setTheme(page, theme)
      const chips = page.locator('[data-testid="tag-chip"]')
      await expect(chips.first()).toBeVisible()
      // The palette itself: every swatch token against the chip's text colour.
      const ink = rgbOf(await token(page, 'ink'))
      for (let n = 1; n <= LEGACY_SWATCHES.length; n++) {
        expect.soft(await token(page, `swatch-${n}`), `--swatch-${n} is defined`).toMatch(/^\d+ \d+ \d+$/)
        expect.soft(contrast(await swatchRgb(page, n), ink), `swatch ${n} against ink`).toBeGreaterThanOrEqual(4.5)
      }
      // The chips as drawn: each tag on a palette swatch, text on its own background.
      for (const tag of PALETTE_TAGS) {
        const chip = chips.filter({ hasText: tag.name }).first()
        await expect(chip).toBeVisible()
        const ratio = contrast(await style(chip, 'color'), await style(chip, 'background-color'))
        expect.soft(ratio, `${tag.name} chip text on its background`).toBeGreaterThanOrEqual(4.5)
      }
      await shot(page, `chips-${theme}`)
    })
  }

  // ─── AC6 ────────────────────────────────────────────────────────────────────────────────────

  for (const theme of THEMES) {
    for (const l of LEGACY_SWATCHES) {
      const tag = legacyTags[l.swatch - 1]
      test(`saved tag colours still render: ${l.color} ${theme}`, async ({ page }) => {
        if (!tag) throw new Error(`no fixture tag for swatch ${l.swatch}`)
        await open(page, '/transactions', colouredHousehold)
        await setTheme(page, theme)
        const chip = page.locator('[data-testid="tag-chip"]', { hasText: tag.name }).first()
        await expect(chip).toBeVisible()
        const background = await swatchRgb(page, l.swatch)
        expect(await style(chip, 'background-color')).toBe(background)
        expect.soft(contrast(await style(chip, 'color'), background), 'chip text on the swatch').toBeGreaterThanOrEqual(4.5)
        await shot(page, `chip-swatch-${l.swatch}-${theme}`)

        // Settings preselects the swatch: only that one is pressed.
        await page.goto('/settings')
        await setTheme(page, theme)
        await page.getByRole('button', { name: `Edit tag ${tag.name}` }).click()
        const picked = page.getByRole('button', { name: /^Colour #/ })
        await expect(picked).toHaveCount(LEGACY_SWATCHES.length)
        for (const other of LEGACY_SWATCHES) {
          const button = page.getByRole('button', { name: `Colour ${other.color}` })
          await expect.soft(button).toHaveAttribute('aria-pressed', String(other.swatch === l.swatch))
        }
        expect(await style(page.getByRole('button', { name: `Colour ${l.color}` }), 'background-color')).toBe(background)
        await viewportShot(page, `preselected-${l.swatch}-${theme}`)
      })
    }
  }

  // ─── AC7 ────────────────────────────────────────────────────────────────────────────────────

  interface SavedColour {
    kind: 'tag' | 'category'
    name: string
    color: string
    legacy: boolean
  }
  const SAVED: SavedColour[] = [
    ...[legacyTags[2], upperBlueTag, ...customTags.filter((t) => !t.is_system)].flatMap((t) =>
      t ? [{ kind: 'tag' as const, name: t.name, color: t.color ?? '', legacy: LEGACY_SWATCHES.some((l) => l.color === t.color?.toLowerCase()) }] : [],
    ),
    ...colouredHousehold.categories.filter((c) => c.color).map((c) => ({
      kind: 'category' as const,
      name: c.name,
      color: c.color ?? '',
      legacy: LEGACY_SWATCHES.some((l) => l.color === c.color?.toLowerCase()),
    })),
  ]

  for (const saved of SAVED) {
    test(`saved colours remain unchanged: ${saved.kind} ${saved.name} ${saved.color}`, async ({ page }) => {
      const api = await open(page, '/settings', colouredHousehold)
      await allowWrites(page, colouredHousehold)
      const row = saved.kind === 'tag'
        ? page.locator('[data-testid="tag-row"]', { hasText: saved.name })
        : page.locator('li', { hasText: saved.name }).filter({ has: page.getByRole('button', { name: 'Edit', exact: true }) })
      const edit = saved.kind === 'tag' ? page.getByRole('button', { name: `Edit tag ${saved.name}` }) : row.getByRole('button', { name: 'Edit', exact: true })
      await expect(edit).toBeVisible()

      // A colour outside the palette keeps its own colour on the row dot, in both themes.
      if (!saved.legacy) {
        const [r, g, b] = [1, 3, 5].map((i) => parseInt(saved.color.slice(i, i + 2), 16))
        for (const theme of THEMES) {
          await setTheme(page, theme)
          expect.soft(await style(row.locator('span.rounded-full').first(), 'background-color'), `${saved.name} dot in ${theme}`).toBe(`rgb(${r}, ${g}, ${b})`)
        }
      }

      // Open and cancel: nothing is written.
      await edit.click()
      await expect(page.getByRole('button', { name: 'Cancel' })).toBeVisible()
      await page.getByRole('button', { name: 'Cancel' }).click()
      await expect(page.getByRole('button', { name: 'Cancel' })).toHaveCount(0)
      expect(api.requests().filter(isWrite)).toEqual([])

      // Save an unrelated field (the name): the colour in the write is the saved string, byte for byte.
      await edit.click()
      const nameField = saved.kind === 'tag' ? page.locator('#tag-name') : page.getByRole('dialog').or(page.locator('form')).getByRole('textbox').first()
      await nameField.fill(`${saved.name} renamed`)
      await viewportShot(page, `edit-${saved.kind}-${saved.name.replace(/\s+/g, '-')}`)
      await page.getByRole('button', { name: 'Update' }).click()
      const id = saved.kind === 'tag'
        ? colouredHousehold.tags.find((t) => t.name === saved.name)?.id
        : colouredHousehold.categories.find((c) => c.name === saved.name)?.id
      const path = saved.kind === 'tag' ? `/tags/${id}` : `/categories/${id}`
      await expect.poll(() => api.bodies('PUT', path).length).toBe(1)
      expect((api.bodies('PUT', path)[0] as { color: string }).color).toBe(saved.color)
    })
  }
})
