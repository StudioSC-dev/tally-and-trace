// STU-743: the taste fixes from the redesign's visual checks. The phone tab labels have room, small captions and
// status text are quiet (docs/design-system.md: 12-13px, 400-500, `muted`), "Mark as not posted" is not a warning, the
// Settings custom colour swatch is empty until a colour is chosen, and the dashboard tag filter exposes a long name.
// The API is faked in the browser with the shared household fixture; there is no backend.
import path from 'node:path'
import { expect, test } from '@playwright/test'
import type { Locator, Page } from '@playwright/test'
import type { Transaction } from '@tally-trace/shared'
import { LONG_TAG, household, mockHousehold, withDollars, withLongTag } from './support/fixtures/household'
import type { HouseholdData } from './support/fixtures/household'
import { addRoutes, apiRoute } from './support/mockApi'
import { shot } from './support/shot'

const READY_MS = 15_000

/** The four phone tab labels at the PR base (BottomNav.tsx): exact text, in order. */
const TAB_LABELS = ['Dashboard', 'Accounts', 'Transactions', 'Allocations']
/** The bar's height at the PR base (`h-16`). */
const BAR_HEIGHT = 64

/** docs/design-system.md tokens, as the browser computes them. */
const MUTED = 'rgb(74, 89, 80)'
const WARN = { light: 'rgb(135, 80, 0)', dark: 'rgb(228, 176, 98)' }
const LINE_STRONG = { light: 'rgb(116, 136, 112)', dark: 'rgb(92, 117, 99)' }

type Scheme = 'light' | 'dark'

async function open(page: Page, url: string, ready: Locator | ((p: Page) => Locator), data: HouseholdData = household, scheme: Scheme = 'light'): Promise<void> {
  await page.emulateMedia({ colorScheme: scheme })
  await mockHousehold(page, data)
  await page.goto(url)
  await expect(typeof ready === 'function' ? ready(page) : ready).toBeVisible({ timeout: READY_MS })
  await page.waitForLoadState('networkidle')
  await page.evaluate(() => document.fonts.ready)
}

/** A viewport screenshot, for fixed layers (tab bar, dialogs), saved under `shot()`'s naming. */
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

const typeOf = (el: Locator): Promise<{ weight: number; size: string; color: string }> =>
  el.evaluate((e) => {
    const s = getComputedStyle(e)
    return { weight: Number(s.fontWeight), size: s.fontSize, color: s.color }
  })

const quickBalances = (page: Page): Locator => page.getByTestId('quick-balance-tile').first()
const rows = (page: Page): Locator => page.locator('article[data-transaction-id]')

// ─── AC1 ────────────────────────────────────────────────────────────────────────────────────────

test('tab labels have room', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'phone', 'the tab bar is the phone layout')
  await open(page, '/', page.getByRole('heading', { level: 1, name: 'Dashboard' }))
  const labels = page.locator('nav.safe-area-bottom span.label')
  await expect(labels).toHaveCount(4)
  expect((await labels.allInnerTexts()).map((t) => t.trim()), 'the labels keep their text and order from the PR base').toEqual(TAB_LABELS)
  const boxes = []
  for (let i = 0; i < 4; i += 1) boxes.push(await boxOf(labels.nth(i)))
  testInfo.annotations.push({ type: 'boxes', description: JSON.stringify(boxes.map((b) => [Math.round(b.x), Math.round(b.width)])) })
  for (let i = 1; i < 4; i += 1) {
    const gap = boxes[i].x - (boxes[i - 1].x + boxes[i - 1].width)
    expect(gap, `labels ${TAB_LABELS[i - 1]} and ${TAB_LABELS[i]} are at least 8px apart`).toBeGreaterThanOrEqual(8)
  }
  expect(boxes[0].x, 'the first label is at least 8px from the left edge').toBeGreaterThanOrEqual(8)
  expect(390 - (boxes[3].x + boxes[3].width), 'the last label is at least 8px from the right edge').toBeGreaterThanOrEqual(8)
  const lines = await labels.evaluateAll((all) => all.map((e) => Math.round(e.getBoundingClientRect().height / parseFloat(getComputedStyle(e).lineHeight))))
  expect(lines, 'each label is one line').toEqual([1, 1, 1, 1])
  const bar = await boxOf(page.locator('nav.safe-area-bottom > div'))
  expect(Math.abs(bar.height - BAR_HEIGHT), 'the bar height is unchanged from the base').toBeLessThanOrEqual(2)
  await viewportShot(page, 'tab-labels')
})

// ─── AC2 ────────────────────────────────────────────────────────────────────────────────────────

const quiet = (t: { weight: number; size: string; color: string }): string[] => [
  [400, 500].includes(t.weight) ? '' : `weight ${t.weight}`,
  ['12px', '13px'].includes(t.size) ? '' : `size ${t.size}`,
  t.color === MUTED ? '' : `colour ${t.color}`,
].filter((x) => x !== '')

test('captions are quiet: dashboard', async ({ page }) => {
  await open(page, '/', quickBalances(page), household)
  const captions = page.locator('[data-testid="quick-balance-tile"] > div:first-child > p:first-child')
  expect(await captions.count(), 'there are kind captions').toBeGreaterThan(0)
  const kinds = new Set((await captions.allInnerTexts()).map((t) => t.trim()))
  for (const k of ['Debit', 'Credit', 'E-wallet']) expect.soft([...kinds].some((t) => t.startsWith(k)), `the fixture shows a ${k} caption`).toBe(true)
  for (let i = 0; i < (await captions.count()); i += 1) expect.soft(quiet(await typeOf(captions.nth(i))), `kind caption ${i}`).toEqual([])
  const owed = page.getByTestId('quick-balance-owed').first().locator('span').first()
  await expect(owed, 'the Owed line label').toHaveText('Owed')
  expect(quiet(await typeOf(owed)), 'the Owed line label').toEqual([])
  const also = page.getByRole('heading', { level: 3, name: 'Also coming up' })
  await expect(also).toBeVisible()
  expect(quiet(await typeOf(also)), 'the Also coming up heading').toEqual([])
  await shot(page, 'captions-dashboard')
})

test('captions are quiet: transaction row status', async ({ page }) => {
  // The fixture's list has no unposted row dated on or before today, so one is added: a posted expense, not posted.
  const source = household.transactions.find((t) => t.view !== 'limited' && t.is_posted && t.transaction_type === 'debit' && t.transaction_date <= household.today)
  if (!source) throw new Error('the fixture has no posted expense')
  const pending = { ...source, id: 9001, description: 'Pending clone', is_posted: false }
  await open(page, '/transactions', rows(page).first(), { ...household, transactions: [pending, ...household.transactions] })
  const seen = new Set<string>()
  for (const word of ['Expense', 'Income', 'Posted', 'Pending']) {
    const status = rows(page).locator('[data-testid="row-meta"] > span').filter({ hasText: new RegExp(`^${word}$`) })
    const n = await status.count()
    if (n === 0) continue
    seen.add(word)
    for (let i = 0; i < n; i += 1) expect.soft(quiet(await typeOf(status.nth(i))), `${word} status text ${i}`).toEqual([])
  }
  expect([...seen].sort(), 'the fixture lists all four status words').toEqual(['Expense', 'Income', 'Pending', 'Posted'])
  await shot(page, 'captions-transactions')
})

// ─── AC3 ────────────────────────────────────────────────────────────────────────────────────────

for (const scheme of ['light', 'dark'] as const) {
  test(`undo is not a warning: ${scheme}`, async ({ page }) => {
    await open(page, '/transactions', rows(page).first(), household, scheme)
    await rows(page).filter({ hasText: 'Posted' }).first().click()
    const undo = page.getByRole('button', { name: 'Mark as not posted' })
    await expect(undo).toBeVisible()
    expect(['secondary', 'quiet'], 'the variant is neutral').toContain(await undo.getAttribute('data-variant'))
    const colours = await undo.evaluate((e) => {
      const s = getComputedStyle(e)
      return [s.color, s.borderTopColor, s.backgroundColor]
    })
    for (const c of colours) expect(c, 'no colour of the control is the warn token').not.toBe(WARN[scheme])
    await viewportShot(page, `undo-${scheme}`)
  })
}

// ─── AC4 ────────────────────────────────────────────────────────────────────────────────────────

for (const dialog of [
  { name: 'tag', open: 'Add tag' },
  { name: 'category', open: 'Add category' },
] as const) {
  for (const scheme of ['light', 'dark'] as const) {
    test(`custom swatch is neutral until chosen: ${dialog.name} ${scheme}`, async ({ page }) => {
      await open(page, '/settings', page.getByRole('button', { name: dialog.open, exact: true }), household, scheme)
      await page.getByRole('button', { name: dialog.open, exact: true }).click()
      const picker = page.getByLabel(/custom/i)
      await expect(picker, 'the custom swatch has an accessible name with "custom"').toHaveCount(1)
      const swatch = page.getByTestId('custom-swatch')
      const look = () => swatch.evaluate((e) => {
        const s = getComputedStyle(e)
        return { bg: s.backgroundColor, width: s.borderTopWidth, color: s.borderTopColor, style: s.borderTopStyle }
      })
      expect(await look(), 'no custom colour: transparent, a 1px line-strong border').toEqual({ bg: 'rgba(0, 0, 0, 0)', width: '1px', color: LINE_STRONG[scheme], style: 'solid' })
      await viewportShot(page, `swatch-empty-${dialog.name}-${scheme}`)
      await picker.fill('#123456')
      expect((await look()).bg, 'a chosen custom colour fills the swatch').toBe('rgb(18, 52, 86)')
      await viewportShot(page, `swatch-chosen-${dialog.name}-${scheme}`)
    })
  }
}

// ─── AC5 ────────────────────────────────────────────────────────────────────────────────────────

test('truncated tag names are exposed', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'phone', 'the clipped filter is the phone layout')
  await open(page, '/', page.getByTestId('tag-filter'), withLongTag(household))
  const filter = page.getByTestId('tag-filter')
  await filter.selectOption(String(LONG_TAG.id))
  await expect(filter).toHaveValue(String(LONG_TAG.id))
  const clipped = await filter.evaluate((e, name) => {
    const s = getComputedStyle(e)
    const probe = document.createElement('span')
    probe.style.cssText = `position:absolute;visibility:hidden;white-space:nowrap;font:${s.font}`
    probe.textContent = name
    document.body.appendChild(probe)
    const text = probe.getBoundingClientRect().width
    probe.remove()
    return { text, room: e.clientWidth - parseFloat(s.paddingLeft) - parseFloat(s.paddingRight) }
  }, LONG_TAG.name)
  expect(clipped.text, `the label (${clipped.text}px) is wider than the closed select's room (${clipped.room}px)`).toBeGreaterThan(clipped.room)
  expect(await filter.getAttribute('aria-label'), 'the accessible name has the full tag name').toContain(LONG_TAG.name)
  await expect(page.getByRole('combobox', { name: new RegExp(LONG_TAG.name) })).toHaveCount(1)
  expect(await filter.getAttribute('title'), 'the title has the full tag name').toContain(LONG_TAG.name)
  const widths = await page.evaluate(() => {
    const header = document.querySelector('main h1')?.parentElement?.parentElement
    return { doc: document.documentElement.scrollWidth, header: header ? header.scrollWidth - header.clientWidth : 0 }
  })
  expect(widths.doc, 'the page has no horizontal overflow').toBeLessThanOrEqual(390)
  expect(widths.header, 'the dashboard header has no horizontal overflow').toBeLessThanOrEqual(0)
  await shot(page, 'tag-filter')
})

// ─── AC6 ────────────────────────────────────────────────────────────────────────────────────────

test('taste fixes change only their targets: quick balances and the header', async ({ page }, testInfo) => {
  await open(page, '/', quickBalances(page), withDollars(household))
  const phone = testInfo.project.name === 'phone'
  const tiles = await page.getByTestId('quick-balance-tile').evaluateAll((all) =>
    all.map((t) => ({ id: t.getAttribute('data-account-id'), figures: (t.querySelector('[data-testid="quick-balance-figures"]')?.textContent ?? '').replace(/\s+/g, ' ').trim() })))
  const expected = household.accounts.filter((a) => tiles.some((t) => t.id === String(a.id)))
  expect(tiles.length, 'the fixture pins tiles').toBeGreaterThan(0)
  expect(expected.length, 'every tile is a fixture account').toBe(tiles.length)
  for (const t of tiles) {
    const account = household.accounts.find((a) => String(a.id) === t.id)
    const digits = Math.abs(account?.balance ?? 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
    expect.soft(t.figures, `account ${t.id} keeps its fixture balance ${digits}`).toContain(digits)
  }
  const title = await boxOf(page.locator('main h1'))
  const tag = await boxOf(page.locator('main label').filter({ has: page.getByTestId('tag-filter') }))
  const period = await boxOf(page.getByRole('group', { name: 'Period for actual totals' }))
  const centre = (b: { y: number; height: number }): number => b.y + b.height / 2
  if (phone) {
    expect(tag.y, 'the tag filter sits below the title').toBeGreaterThanOrEqual(title.y + title.height)
    expect(Math.abs(centre(tag) - centre(period)), 'the controls share the next row').toBeLessThanOrEqual(2)
  } else {
    expect(Math.abs(centre(tag) - centre(title)), 'the tag filter is on the title row').toBeLessThanOrEqual(2)
    expect(Math.abs(centre(period) - centre(title)), 'the period group is on the title row').toBeLessThanOrEqual(2)
  }
  await shot(page, 'unchanged-dashboard')
})

test('taste fixes change only their targets: transactions', async ({ page }) => {
  const api = await mockHousehold(page, household)
  await page.goto('/transactions')
  await expect(rows(page).first()).toBeVisible({ timeout: READY_MS })
  const row = rows(page).filter({ hasText: 'Posted' }).first()
  const id = Number(await row.getAttribute('data-transaction-id'))
  const found = household.transactions.find((t) => t.id === id)
  if (!found || found.view === 'limited') throw new Error(`fixture transaction ${id} not found`)
  const txn = found
  await addRoutes(page, [apiRoute<Transaction>('PUT', `/transactions/${id}`, { ...txn, is_posted: false })])
  const amount = Math.abs(txn.amount).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
  await expect(row, 'the row keeps its fixture figure').toContainText(amount)
  await row.click()
  await page.getByRole('button', { name: 'Mark as not posted' }).click()
  await expect.poll(() => api.bodies('PUT', `/transactions/${id}`).length, 'one update is sent').toBe(1)
  expect(api.bodies('PUT', `/transactions/${id}`)[0], 'the same request as at the base').toEqual({ is_posted: false, amount: txn.projected_amount ?? txn.amount, currency: txn.currency })
  await viewportShot(page, 'unchanged-transactions')
})
