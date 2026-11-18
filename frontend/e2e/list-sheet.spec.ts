// STU-681: a list is one surface with ruled rows, not a card per item (docs/design-system.md, "Ledger and Row", ban 5).
// Transactions and the Allocations Recurring tab list their records as `Row`s on a `ListSheet`; the dashboard has no
// box inside a box, and its quick balances are figures on their panel, separated by a rule. The API is faked in the
// browser with the shared household fixture; there is no backend.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test } from '@playwright/test'
import type { Locator, Page } from '@playwright/test'
import type { BudgetEntry, PaginatedResponse } from '@tally-trace/shared'
import { budgetEntriesFor, colouredHousehold, entryOccurrencesRoute, household, limitedRecurring, mockHousehold } from './support/fixtures/household'
import { addRoutes, errorRoute, queryRoute } from './support/mockApi'
import type { ApiMock } from './support/mockApi'
import { shot } from './support/shot'

// This spec lives in <repo>/frontend/e2e.
const FRONTEND = fileURLToPath(new URL('..', import.meta.url))
const read = (rel: string): string => fs.readFileSync(path.join(FRONTEND, rel), 'utf8')

// Design-system tokens (docs/design-system.md, light theme) as getComputedStyle reports them.
const SURFACE = 'rgb(242, 245, 240)'
const SUNKEN = 'rgb(214, 222, 211)'
const LINE = 'rgb(188, 201, 184)'
const RADIUS_MD = '6px'
/** A row with one meta line, between rules: 56px on desktop and 64px on a phone. */
const PITCH: Record<string, number> = { desktop: 56, phone: 64 }

/** The month Transactions opens on (the frozen clock's month), as the fixture dates its rows. */
const MONTH = household.today.slice(0, 7)
const monthRows = household.transactions.filter((t) => t.view !== 'limited' && t.transaction_date.slice(0, 7) === MONTH)
/** A calendar day as the app writes it on a row ("Mar 20th, 2026"), worked out here so the test does not borrow the app's formatter. */
function entryDay(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number)
  const month = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][m - 1]
  const suffix = d % 10 === 1 && d !== 11 ? 'st' : d % 10 === 2 && d !== 12 ? 'nd' : d % 10 === 3 && d !== 13 ? 'rd' : 'th'
  return `${month} ${d}${suffix}, ${y}`
}
/** The Recurring tab's entries: the household's own, plus another member's two that Mara sees as limited. */
const recurring = { ...household, entries: [...household.entries, ...limitedRecurring] }

/** A viewport screenshot (a full-page one draws a fixed layer at the scroll offset), saved like `shot()`. */
async function viewportShot(page: Page, name: string): Promise<void> {
  const info = test.info()
  const spec = path.basename(info.file).replace(/\.spec\.ts$/, '')
  await page.screenshot({ path: path.join(info.project.outputDir, 'screens', `${spec}-${name}-${info.project.name}.png`), animations: 'disabled' })
}

async function open(page: Page, url: string): Promise<ApiMock> {
  const api = await mockHousehold(page)
  await page.goto(url)
  return api
}

/** Transactions, once its rows are listed. */
async function openTransactions(page: Page): Promise<ApiMock> {
  const api = await open(page, '/transactions')
  await expect(page.locator('article[data-transaction-id]').first()).toBeVisible()
  await page.waitForLoadState('networkidle')
  return api
}

/** Allocations on its Recurring tab, with the limited entries listed too, once its entries are listed. */
async function openRecurring(page: Page): Promise<ApiMock> {
  const api = await mockHousehold(page)
  await addRoutes(page, [queryRoute<PaginatedResponse<BudgetEntry>>('GET', '/budget-entries/', (q) => budgetEntriesFor(recurring, q))])
  await page.goto('/allocations?tab=recurring')
  await expect(page.locator('[data-testid^="kind-section-"] article').first()).toBeVisible()
  // By name, so the opener works on the PR base too (AC6 must hold there).
  for (const e of limitedRecurring) await expect(page.getByText(e.display_name ?? '', { exact: true })).toBeVisible()
  await page.waitForLoadState('networkidle')
  return api
}

interface SheetStyle {
  background: string
  borders: string[]
  radius: string[]
  shadow: string
}

const sheetStyle = (sheet: Locator): Promise<SheetStyle> =>
  sheet.evaluate((e) => {
    const s = getComputedStyle(e)
    const sides = ['top', 'right', 'bottom', 'left']
    return {
      background: s.backgroundColor,
      borders: sides.map((side) => `${s.getPropertyValue(`border-${side}-width`)} ${s.getPropertyValue(`border-${side}-style`)} ${s.getPropertyValue(`border-${side}-color`)}`),
      radius: ['top-left', 'top-right', 'bottom-right', 'bottom-left'].map((c) => s.getPropertyValue(`border-${c}-radius`)),
      shadow: s.boxShadow,
    }
  })

interface RowRule {
  name: string
  bottom: string
  radius: string[]
}

const rowRules = (rows: Locator): Promise<RowRule[]> =>
  rows.evaluateAll((all) =>
    all.map((e) => {
      const s = getComputedStyle(e)
      return {
        name: (e.querySelector('p')?.textContent ?? '').trim(),
        bottom: `${s.borderBottomWidth} ${s.borderBottomStyle} ${s.borderBottomColor}`,
        radius: ['top-left', 'top-right', 'bottom-right', 'bottom-left'].map((c) => s.getPropertyValue(`border-${c}-radius`)),
      }
    }),
  )

const RULE = `1px solid ${LINE}`
const NO_RULE = /^0px /
/**
 * A row is square but for the corners it shares with the sheet (STU-692): the sheet clips nothing, so a focused row's
 * ring shows in full, and the first and last rows round their outer corners to the sheet's inner radius instead.
 */
const INNER = '5px'
const cornersOf = (i: number, n: number): string[] => [
  i === 0 ? INNER : '0px',
  i === 0 ? INNER : '0px',
  i === n - 1 ? INNER : '0px',
  i === n - 1 ? INNER : '0px',
]
const offCorners = (rules: RowRule[]): string[] =>
  rules.filter((r, i) => r.radius.join(' ') !== cornersOf(i, rules.length).join(' ')).map((r) => `${r.name}: ${r.radius.join(' ')}`)

// ─── AC1 ────────────────────────────────────────────────────────────────────────────────────────

test('transactions are one sheet', async ({ page }) => {
  await openTransactions(page)
  const main = page.locator('main')
  const sheets = main.getByTestId('list-sheet')
  expect(await sheets.count(), 'Transactions lists its rows on one sheet').toBe(1)
  const sheet = sheets.first()
  expect(await sheet.locator('.card, article.card').count(), '.card or article.card elements inside the list').toBe(0)
  const style = await sheetStyle(sheet)
  expect(style.background, 'the sheet is leaf (surface)').toBe(SURFACE)
  expect(style.borders, 'one 1px line border on every side').toEqual(new Array<string>(4).fill(`1px solid ${LINE}`))
  expect(style.radius, 'radius-md on every corner').toEqual(new Array<string>(4).fill(RADIUS_MD))
  expect(style.shadow, 'no shadow').toBe('none')
  expect(await sheet.getByTestId('row').count(), "the sheet's rows match the fixture's rows for the month").toBe(monthRows.length)
  expect(await main.locator('article[data-transaction-id]').count(), 'every transaction row on the page').toBe(monthRows.length)
  expect(await sheet.locator('article[data-transaction-id]').count(), 'every transaction row sits on the sheet').toBe(monthRows.length)
  await shot(page, 'transactions-sheet')
})

// ─── AC2 ────────────────────────────────────────────────────────────────────────────────────────

test('rows are ruled', async ({ page }) => {
  await openTransactions(page)
  const rules = await rowRules(page.getByTestId('list-sheet').getByTestId('row'))
  expect(rules.length, 'rows on the sheet').toBe(monthRows.length)
  for (const [i, r] of rules.entries()) {
    if (i < rules.length - 1) expect.soft(r.bottom, `row ${i + 1} (${r.name}) has a 1px line rule under it`).toBe(RULE)
    else expect.soft(r.bottom, `the last row (${r.name}) has no rule`).toMatch(NO_RULE)
    expect.soft(r.radius, `row ${i + 1} (${r.name}) is square but for the sheet's corners`).toEqual(cornersOf(i, rules.length))
  }
  expect(rules.slice(0, -1).filter((r) => r.bottom !== RULE).map((r) => r.name), 'rows without a rule, last excepted').toEqual([])
  expect(rules[rules.length - 1]?.bottom, 'the last row has no rule').toMatch(NO_RULE)
  expect(offCorners(rules), "rows rounded anywhere but the sheet's corners").toEqual([])
  await shot(page, 'rows-ruled')
})

// ─── AC3 ────────────────────────────────────────────────────────────────────────────────────────

interface Measured {
  name: string
  kind: string | null
  height: number
  metaLines: number
  actions: number
  /** Whether the row carries tags, shown as chips or summarised as "+N". */
  tagged: boolean
}

/** How far a row's measured pitch may drift from the fixture (subpixel layout), in px. */
const PITCH_SLACK = 0.5

/** Every row's pitch (its height between rules: the box less its bottom rule), its meta lines, and whether it carries its own controls or tags. */
const measure = (rows: Locator): Promise<Measured[]> =>
  rows.evaluateAll((all) =>
    all.map((e) => ({
      name: (e.querySelector('[data-row-title]')?.textContent ?? '').trim(),
      kind: e.getAttribute('data-row-kind'),
      height: e.getBoundingClientRect().height - parseFloat(getComputedStyle(e).borderBottomWidth),
      metaLines: e.querySelectorAll('[data-testid="row-meta"]').length,
      actions: e.querySelectorAll('[data-testid="row-actions"] button').length,
      tagged: e.querySelector('[data-testid="row-tags"]') !== null,
    })),
  )

const offPitch = (rows: Measured[], want: number): string[] => rows.filter((r) => Math.abs(r.height - want) > PITCH_SLACK).map((r) => `${r.name}: ${r.height}px`)

const PITCH_CASES = [
  {
    surface: 'transactions',
    // From the fixture: every transaction row carries one meta line; its tags sit on the title line.
    expected: monthRows.map((t) => (t.view === 'limited' ? '' : t.description)),
  },
  {
    surface: 'recurring',
    // From the fixture: every full entry with no description carries one meta line; its tags sit on the title line and
    // its Mark paid, Mark received, Charged or Posted in the trailing area. A limited entry carries two (its facts wrap).
    expected: recurring.entries.filter((e) => e.view !== 'limited' && !e.description).map((e) => (e.view === 'limited' ? '' : e.name)),
  },
] as const

for (const c of PITCH_CASES) {
  test(`rows keep an even pitch: ${c.surface}`, async ({ page }, testInfo) => {
    if (c.surface === 'transactions') await openTransactions(page)
    else await openRecurring(page)
    await page.evaluate(() => document.fonts.ready)
    const want = PITCH[testInfo.project.name]
    const rows = await measure(page.locator('main').getByTestId('list-sheet').getByTestId('row'))
    const one = rows.filter((r) => r.metaLines === 1)
    expect(c.expected.length, `the fixture has at least two ${c.surface} rows with one meta line`).toBeGreaterThanOrEqual(2)
    expect(one.map((r) => r.name).sort(), `the ${c.surface} rows with one meta line are the fixture's`).toEqual([...c.expected].sort())
    // The rows with one meta line include rows with tags and, on Recurring, rows with their own controls.
    expect(one.filter((r) => r.tagged).length, `${c.surface} rows with tags among them`).toBeGreaterThanOrEqual(2)
    if (c.surface === 'recurring') {
      expect(one.filter((r) => r.actions > 0).length, 'active recurring rows with their controls among them').toBeGreaterThanOrEqual(2)
      const limited = rows.filter((r) => r.kind === 'limited-entry')
      expect(limited.length, 'the limited entries are listed').toBe(limitedRecurring.length)
      expect(limited.filter((r) => r.metaLines < 2).map((r) => r.name), 'limited entries with fewer than two meta lines').toEqual([])
    }
    for (const r of one) {
      expect.soft(Math.abs(r.height - want), `${c.surface} row "${r.name}" is ${want}px (measured ${r.height}px)`).toBeLessThanOrEqual(PITCH_SLACK)
    }
    expect(offPitch(one, want), `${c.surface} rows with one meta line that are not ${want}px`).toEqual([])
    await shot(page, `pitch-${c.surface}`)
  })
}

/** The fixture's transaction with the most tags: more than a phone's title line can hold. */
const MANY = colouredHousehold.transactions.find((t) => t.view !== 'limited' && t.description === 'Tag colour check')
/** The title keeps at least this much of its line (or all of itself, when shorter). */
const TITLE_MIN = 96

/**
 * Checks a tagged row's title line: the title keeps its minimum (or all of itself) from its first character, every
 * chip and "+N" sits between the title (and any badge) and the amount's box, the chips shown are the first tags in
 * order with a "+N" naming the rest, and the row holds one meta line at the project's pitch. Returns the tags in "+N".
 */
async function checkTagLine(row: Locator, tags: string[], project: string, label: string): Promise<string[]> {
  const m = await row.evaluate((r) => {
    const box = (e: Element) => {
      const b = e.getBoundingClientRect()
      return { left: b.left, right: b.right, top: b.top, bottom: b.bottom, width: b.width }
    }
    const title = r.querySelector<HTMLElement>('[data-row-title]')
    const range = document.createRange()
    if (title?.firstChild) {
      range.setStart(title.firstChild, 0)
      range.setEnd(title.firstChild, 1)
    }
    const badges = r.querySelector('[data-testid="row-badges"]')
    const marks = [...r.querySelectorAll<HTMLElement>('[data-testid="row-tags"] > [data-testid="tag-chip"], [data-testid="row-tags-more"]')]
    return {
      height: r.getBoundingClientRect().height - parseFloat(getComputedStyle(r).borderBottomWidth),
      metaLines: r.querySelectorAll('[data-testid="row-meta"]').length,
      title: title ? { ...box(title), natural: title.scrollWidth, scrolled: title.scrollLeft, firstChar: range.getBoundingClientRect().left } : null,
      badges: badges ? box(badges) : null,
      amount: box(r.querySelector('[data-testid="row-amount"]') as Element),
      chips: marks.filter((e) => e.dataset.testid === 'tag-chip').map((e) => ({ name: (e.textContent ?? '').trim(), ...box(e) })),
      more: marks.filter((e) => e.dataset.testid === 'row-tags-more').map((e) => ({ text: (e.textContent ?? '').trim(), label: e.getAttribute('aria-label') ?? '', ...box(e) })),
    }
  })
  const title = m.title
  if (!title) throw new Error(`${label}: the row has no title`)
  // The title stays readable: its minimum width (or all of it when shorter), starting at its first character.
  expect(title.width, `${label}: the title keeps ${TITLE_MIN}px or all of itself (measured ${title.width}px of ${title.natural}px)`).toBeGreaterThanOrEqual(Math.min(title.natural, TITLE_MIN) - 1)
  expect(title.scrolled, `${label}: the title is not scrolled`).toBe(0)
  expect(Math.abs(title.firstChar - title.left), `${label}: the title's first character is at its left edge`).toBeLessThanOrEqual(1)
  // Nothing on the title line paints over the title, a badge or the amount.
  const after = m.badges ? m.badges.right : title.right
  if (m.badges) {
    expect.soft(m.badges.left, `${label}: the badge starts after the title`).toBeGreaterThanOrEqual(title.right - 0.5)
    expect.soft(m.badges.right, `${label}: the badge ends before the amount's box`).toBeLessThanOrEqual(m.amount.left + 0.5)
  }
  for (const c of [...m.chips, ...m.more]) {
    const name = 'name' in c ? c.name : c.text
    expect.soft(c.left, `${label}: ${name} starts after the title${m.badges ? ' and the badge' : ''}`).toBeGreaterThanOrEqual(after - 0.5)
    expect.soft(c.right, `${label}: ${name} ends before the amount's box`).toBeLessThanOrEqual(m.amount.left + 0.5)
  }
  // What shows is the tags in order, then "+N" for the rest, which names them for a screen reader.
  const shown = m.chips.map((c) => c.name)
  const rest = tags.slice(shown.length)
  expect(shown, `${label}: the shown chips are the first tags`).toEqual(tags.slice(0, shown.length))
  if (project === 'phone') expect(rest.length, `${label}: a phone cannot fit every tag, so some are summarised`).toBeGreaterThan(0)
  expect(m.more.map((x) => x.text), `${label}: a "+N" for the tags that do not fit`).toEqual(rest.length > 0 ? [`+${rest.length}`] : [])
  if (rest.length > 0) expect(m.more[0].label, `${label}: "+N" names the rest`).toBe(`Show ${rest.length} more tags: ${rest.join(', ')}`)
  // The row holds the pitch.
  const want = PITCH[project]
  expect(m.metaLines, `${label}: the row carries one meta line`).toBe(1)
  expect(Math.abs(m.height - want), `${label}: the row is ${want}px (measured ${m.height}px)`).toBeLessThanOrEqual(PITCH_SLACK)
  return rest
}

async function openManyTags(page: Page): Promise<{ row: Locator; tags: string[] }> {
  if (!MANY || MANY.view === 'limited') throw new Error('no multi-tag transaction in the fixture')
  const tags = (MANY.tags ?? []).map((t) => t.name)
  expect(tags.length, 'the fixture row carries many tags').toBeGreaterThanOrEqual(8)
  await mockHousehold(page, colouredHousehold)
  await page.goto('/transactions')
  const row = page.locator('article[data-transaction-id]').filter({ has: page.getByText(MANY.description ?? '', { exact: true }) })
  await expect(row).toHaveCount(1)
  await page.evaluate(() => document.fonts.ready)
  return { row, tags }
}

test('rows keep an even pitch: many tags', async ({ page }, testInfo) => {
  const { row, tags } = await openManyTags(page)
  const rest = await checkTagLine(row, tags, testInfo.project.name, 'many tags')
  await row.scrollIntoViewIfNeeded()
  await viewportShot(page, 'many-tags')
  if (rest.length > 0) {
    // "+N" opens a line with the rest, by click or by keyboard, without opening the row.
    const more = row.getByTestId('row-tags-more')
    await more.click()
    await expect(more).toHaveAttribute('aria-expanded', 'true')
    expect(await row.locator('[data-row-tags-rest] [data-testid="tag-chip"]').allTextContents(), 'the opened line lists the rest').toEqual(rest)
    expect(await actionModal(page).count(), '"+N" does not open the row').toBe(0)
    await viewportShot(page, 'many-tags-open')
    await more.focus()
    await page.keyboard.press('Enter')
    await expect(more).toHaveAttribute('aria-expanded', 'false')
    expect(await row.locator('[data-row-tags-rest]').count(), 'Enter closes the line again').toBe(0)
    expect(await actionModal(page).count(), 'Enter on "+N" does not open the row').toBe(0)
  }
})

test('rows keep an even pitch: many tags while saving', async ({ page }, testInfo) => {
  const { row, tags } = await openManyTags(page)
  await checkTagLine(row, tags, testInfo.project.name, 'before the save')
  // Hold the delete, so the row keeps its "Deleting…" badge on the title line.
  await page.route('**/api/v1/transactions/**', (route) => (route.request().method() === 'DELETE' ? undefined : route.fallback()))
  await row.click({ position: { x: 8, y: 8 } })
  await actionModal(page).getByRole('button', { name: 'Delete Transaction' }).click()
  await page.getByRole('button', { name: 'Delete transaction', exact: true }).click()
  await expect(row.getByTestId('row-saving')).toHaveText('Deleting…')
  // The tags refit around the badge in the same frame: no resize of the line is needed.
  await checkTagLine(row, tags, testInfo.project.name, 'while deleting')
  await row.scrollIntoViewIfNeeded()
  await viewportShot(page, 'many-tags-saving')
  await page.unrouteAll({ behavior: 'ignoreErrors' })
})

/** Adds an expense from the Add Transaction dialog; the API refuses it, so it stays on the list as a pending row, which is returned. */
async function addRefusedTransaction(page: Page, description: string): Promise<Locator> {
  await addRoutes(page, [errorRoute('POST', '/transactions/', 422, 'The amount is over this account’s limit')])
  await page.getByRole('button', { name: 'Add Transaction' }).first().click()
  const form = page.locator('form').filter({ has: page.getByRole('button', { name: 'Create Transaction', exact: true }) })
  await expect(form).toBeVisible()
  await form.locator('input[placeholder="Add notes about this transaction"]').fill(description)
  const accountField = form.locator('[data-field="account_id"]')
  const chip = accountField.getByRole('button', { name: /^Cash on hand/ })
  const change = accountField.locator('[data-picker-change][aria-expanded="false"]')
  await chip.or(change).first().waitFor()
  if ((await chip.count()) === 0) await change.click()
  await chip.first().click()
  await form.getByRole('button', { name: 'Expense', exact: true }).click()
  await form.locator('input[type="number"][placeholder="0.00"]').first().fill('777')
  await form.getByRole('button', { name: 'Create Transaction', exact: true }).click()
  await expect(form).toBeHidden()
  // By its save state, so the AC6 cases run on the PR base too; the pitch case checks the row kind itself.
  const row = page.locator('article[data-state]').filter({ hasText: description })
  await expect(row).toHaveAttribute('data-state', 'failed')
  return row
}

test('rows keep an even pitch: pending row', async ({ page }, testInfo) => {
  await openTransactions(page)
  const pending = await addRefusedTransaction(page, 'Refused lunch')
  const sheet = page.locator('main').getByTestId('list-sheet')
  expect(await sheet.count(), 'Transactions still lists one sheet').toBe(1)
  await expect(pending, 'the pending row keeps the row hook').toHaveAttribute('data-testid', 'row')
  await expect(pending, 'the pending row names its kind').toHaveAttribute('data-row-kind', 'pending-row')
  expect(await sheet.locator('[data-row-kind="pending-row"]').count(), 'the pending row sits on the sheet').toBe(1)
  expect(await sheet.getByTestId('row').count(), 'the sheet lists the month and the pending row').toBe(monthRows.length + 1)
  const rules = await rowRules(sheet.getByTestId('row'))
  expect(rules.slice(0, -1).filter((r) => r.bottom !== RULE).map((r) => r.name), 'rows without a rule, last excepted').toEqual([])
  expect(rules[rules.length - 1]?.bottom, 'the last row has no rule').toMatch(NO_RULE)
  expect(offCorners(rules), "rows rounded anywhere but the sheet's corners").toEqual([])
  await page.evaluate(() => document.fonts.ready)
  const [measured] = await measure(pending)
  const want = PITCH[testInfo.project.name]
  expect(measured.metaLines, 'the pending row carries one meta line').toBe(1)
  expect(Math.abs(measured.height - want), `the pending row is ${want}px (measured ${measured.height}px)`).toBeLessThanOrEqual(PITCH_SLACK)
  await shot(page, 'pitch-pending')
})

// ─── AC4 ────────────────────────────────────────────────────────────────────────────────────────

test('recurring entries are one sheet', async ({ page }) => {
  await openRecurring(page)
  const main = page.locator('main')
  const sections = main.locator('[data-testid^="kind-section-"]')
  const sectionCount = await sections.count()
  expect(sectionCount, 'the Recurring tab lists kind sections').toBeGreaterThan(1)
  expect(await sections.locator('.card').count(), '.card elements in the Recurring list').toBe(0)
  let total = 0
  for (let i = 0; i < sectionCount; i++) {
    const section = sections.nth(i)
    const key = await section.getAttribute('data-testid')
    const sheets = section.getByTestId('list-sheet')
    expect.soft(await sheets.count(), `${key} lists its entries on one sheet`).toBe(1)
    const style = await sheetStyle(sheets.first())
    expect.soft(style.background, `${key}: the sheet is leaf (surface)`).toBe(SURFACE)
    expect.soft(style.borders, `${key}: one 1px line border`).toEqual(new Array<string>(4).fill(`1px solid ${LINE}`))
    expect.soft(style.radius, `${key}: radius-md`).toEqual(new Array<string>(4).fill(RADIUS_MD))
    expect.soft(style.shadow, `${key}: no shadow`).toBe('none')
    const rules = await rowRules(sheets.first().getByTestId('row'))
    expect.soft(rules.length, `${key}: every entry is a row on the sheet`).toBe(await section.locator('article').count())
    for (const [j, r] of rules.entries()) {
      if (j < rules.length - 1) expect.soft(r.bottom, `${key}: row ${r.name} has a 1px line rule under it`).toBe(RULE)
      else expect.soft(r.bottom, `${key}: the last row (${r.name}) has no rule`).toMatch(NO_RULE)
      expect.soft(r.radius, `${key}: row ${r.name} is square but for the sheet's corners`).toEqual(cornersOf(j, rules.length))
    }
    total += rules.length
  }
  expect(total, "the sheets' rows match the fixture's recurring entries, limited ones included").toBe(recurring.entries.length)
  expect(await main.getByTestId('list-sheet').getByTestId('row').count(), 'rows on Recurring sheets').toBe(recurring.entries.length)
  const limited = main.getByTestId('list-sheet').locator('[data-row-kind="limited-entry"]')
  expect(await limited.count(), 'the limited entries are rows on a sheet').toBe(limitedRecurring.length)
  expect(await limited.evaluateAll((all) => all.map((e) => e.getAttribute('data-testid'))), 'limited entries keep the row hook').toEqual(
    new Array<string>(limitedRecurring.length).fill('row'),
  )
  await shot(page, 'recurring-sheet')
})

test('recurring entries are one sheet: limited entries keep their facts readable', async ({ page }) => {
  await openRecurring(page)
  for (const e of limitedRecurring) {
    const row = page.locator('[data-testid^="kind-section-"] article').filter({ has: page.getByText(e.display_name ?? '', { exact: true }) })
    await expect(row).toHaveCount(1)
    // Every fact a limited entry carries, from the fixture. The row has no opener, so each must be readable on the row.
    const facts = [
      `Next ${entryDay(e.next_occurrence)}`,
      ...(e.account ? [`Account: ${e.account.name}`] : []),
      ...(e.counterpart ? [`Transfer to: ${e.counterpart.name}`] : []),
      ...(e.category_name ? [`Category: ${e.category_name}`] : []),
      ...(e.end_date ? [`Ends ${entryDay(e.end_date)}`] : []),
      ...(e.created_by ? [`by ${e.created_by}`] : []),
    ]
    const shown = await row.evaluate((r, want) => {
      const box = r.getBoundingClientRect()
      const spans = [...r.querySelectorAll<HTMLElement>('span')]
      const clipped = [...r.querySelectorAll<HTMLElement>('*')]
        .filter((m) => m.scrollWidth > m.clientWidth + 1 && getComputedStyle(m).overflowX !== 'visible')
        .map((m) => m.textContent ?? '')
      return {
        clipped,
        facts: want.map((text) => {
          const span = spans.find((s) => (s.textContent ?? '').replace(/\s+/g, ' ').trim() === text)
          if (!span) return { text, found: false, inside: false }
          const b = span.getBoundingClientRect()
          return { text, found: true, inside: b.width > 0 && b.left >= box.left - 0.5 && b.right <= box.right + 0.5 && b.top >= box.top - 0.5 && b.bottom <= box.bottom + 0.5 }
        }),
      }
    }, facts)
    expect(shown.clipped, `${e.display_name}: text cut off`).toEqual([])
    for (const f of shown.facts) {
      expect.soft(f.found, `${e.display_name}: "${f.text}" is on the row`).toBe(true)
      expect.soft(f.inside, `${e.display_name}: "${f.text}" is drawn inside the row`).toBe(true)
    }
    expect(shown.facts.filter((f) => !f.found || !f.inside).map((f) => f.text), `${e.display_name}: facts not readable`).toEqual([])
  }
  expect(limitedRecurring.some((e) => e.account && e.end_date && e.category_name && e.created_by), 'one fixture entry carries every optional fact').toBe(true)
  await page.getByText(limitedRecurring[0].display_name ?? '', { exact: true }).scrollIntoViewIfNeeded()
  await viewportShot(page, 'limited-facts')
})

// ─── AC5 ────────────────────────────────────────────────────────────────────────────────────────

interface BoxCheck {
  boxes: number
  nested: string[]
  sunken: string[]
}

/** Bordered surface or sunken boxes in `main`, those inside another, and anything sunken in Quick balances. */
const boxCheck = (page: Page): Promise<BoxCheck> =>
  page.evaluate(
    ({ fills, sunkenFill }) => {
      const boxed = (e: Element): boolean => {
        if (e.getClientRects().length === 0) return false
        const s = getComputedStyle(e)
        const bordered = ['top', 'right', 'bottom', 'left'].some(
          (side) => parseFloat(s.getPropertyValue(`border-${side}-width`)) > 0 && s.getPropertyValue(`border-${side}-style`) !== 'none',
        )
        return bordered && fills.includes(s.backgroundColor)
      }
      const name = (e: Element): string => `${e.tagName.toLowerCase()}.${e.getAttribute('class') ?? ''}`
      const boxes = [...document.querySelectorAll('main *')].filter(boxed)
      const nested = boxes.filter((e) => {
        for (let p = e.parentElement; p; p = p.parentElement) if (boxed(p)) return true
        return false
      })
      const quick = document.querySelector('[data-testid="quick-balances"]')
      const sunken = quick ? [...quick.querySelectorAll('*')].filter((e) => getComputedStyle(e).backgroundColor === sunkenFill) : []
      return { boxes: boxes.length, nested: nested.map(name), sunken: sunken.map(name) }
    },
    { fills: [SURFACE, SUNKEN], sunkenFill: SUNKEN },
  )

async function openDashboard(page: Page): Promise<void> {
  await open(page, '/')
  await expect(page.getByTestId('quick-balance-tile').first()).toBeVisible()
  await expect(page.getByTestId('payables')).toBeVisible()
  await page.waitForLoadState('networkidle')
}

test('dashboard has no box inside a box', async ({ page }) => {
  await openDashboard(page)
  const found = await boxCheck(page)
  expect(found.boxes, 'the dashboard has bordered panels to check').toBeGreaterThan(2)
  expect(found.nested, 'bordered surface or sunken boxes inside another such box').toEqual([])
  expect(found.sunken, 'elements in Quick balances with a sunken background').toEqual([])
  const quick = page.getByTestId('quick-balances')
  const lines = quick.getByTestId('quick-balance-tile')
  const ruled = await lines.evaluateAll((all) =>
    all.map((e) => {
      const s = getComputedStyle(e)
      return { top: `${s.borderTopWidth} ${s.borderTopStyle} ${s.borderTopColor}`, bottom: `${s.borderBottomWidth} ${s.borderBottomStyle} ${s.borderBottomColor}` }
    }),
  )
  expect(ruled.length, 'one account line per quick balance in the fixture').toBe(household.quickBalances.tiles.length)
  for (const [i, r] of ruled.entries()) {
    if (i === 0) continue
    expect.soft([r.top, r.bottom].includes(RULE), `account line ${i + 1} has a 1px line rule above or below (top ${r.top}, bottom ${r.bottom})`).toBe(true)
  }
  expect(ruled.slice(1).filter((r) => r.top !== RULE && r.bottom !== RULE).length, 'account lines after the first without a rule').toBe(0)
  await shot(page, 'dashboard-no-box-in-box')
})

for (const state of ['editing', 'adding an account'] as const) {
  test(`dashboard has no box inside a box: ${state}`, async ({ page }) => {
    await openDashboard(page)
    await page.getByTestId('quick-balances-edit').click()
    const editor = page.getByTestId('quick-balances-editor')
    await expect(editor).toBeVisible()
    expect(await editor.getByTestId('quick-balance-edit-row').count(), 'the editor lists the shown accounts').toBe(household.quickBalances.tiles.length)
    if (state === 'adding an account') {
      await page.getByTestId('quick-balances-add').click()
      await expect(page.getByTestId('quick-balances-add-panel')).toBeVisible()
      expect(await page.getByTestId('quick-balance-add-option').count(), 'the add panel offers accounts').toBeGreaterThan(0)
    }
    const found = await boxCheck(page)
    expect(found.nested, `${state}: bordered surface or sunken boxes inside another such box`).toEqual([])
    expect(found.sunken, `${state}: elements in Quick balances with a sunken background`).toEqual([])
    await shot(page, `dashboard-${state.replace(/\s+/g, '-')}`)
  })
}

// ─── AC6 ────────────────────────────────────────────────────────────────────────────────────────

const txRow = (page: Page, description: string): Locator =>
  page.locator('article[data-transaction-id]').filter({ has: page.getByText(description, { exact: true }) })
const recurringRow = (page: Page, name: string): Locator =>
  page.locator('[data-testid^="kind-section-"] article').filter({ has: page.getByText(name, { exact: true }) })
const actionModal = (page: Page): Locator => page.locator('.modal-backdrop').filter({ hasText: 'Transaction Actions' })
const recurringForm = (page: Page): Locator => page.locator('form').filter({ has: page.getByRole('button', { name: 'Update Recurring Entry' }) })

type Gesture = 'click' | 'Enter' | 'Space'
const GESTURES: Gesture[] = ['click', 'Enter', 'Space']

/**
 * Clicks `target`, or focuses it and presses the key. A row is clicked in its own top-left padding, since its centre
 * can hold one of its controls on a phone; a control is clicked at its centre.
 */
async function trigger(page: Page, target: Locator, gesture: Gesture, on: 'row' | 'control' = 'control'): Promise<void> {
  if (gesture === 'click') {
    await target.click(on === 'row' ? { position: { x: 8, y: 8 } } : undefined)
    return
  }
  await target.focus()
  await expect(target).toBeFocused()
  await page.keyboard.press(gesture)
}

const TX = 'Grab to Makati'
for (const gesture of ['click', 'Enter'] as const) {
  test(`rows still open their records and keep their actions: transaction row, ${gesture}`, async ({ page }) => {
    await openTransactions(page)
    const row = txRow(page, TX)
    const id = Number(await row.getAttribute('data-transaction-id'))
    expect(household.transactions.find((t) => t.id === id && t.view !== 'limited' && t.description === TX), 'the row is the fixture record').toBeTruthy()
    await trigger(page, row, gesture, 'row')
    const modal = actionModal(page)
    await expect(modal).toBeVisible()
    expect(await modal.locator('h2 + p').textContent(), 'the details dialog names the row it opened from').toBe(TX)
    await viewportShot(page, `open-transaction-${gesture.toLowerCase()}`)
  })
}

test('rows still open their records and keep their actions: transaction Edit', async ({ page }) => {
  await openTransactions(page)
  await txRow(page, TX).click()
  await actionModal(page).getByRole('button', { name: 'Edit Transaction' }).click()
  const form = page.locator('.modal-backdrop').filter({ has: page.getByRole('heading', { name: 'Edit Transaction' }) })
  await expect(form).toBeVisible()
  expect(await form.locator('input').evaluateAll((all, d) => all.some((e) => (e as HTMLInputElement).value === d), TX), 'the edit form holds the same record').toBe(true)
  await viewportShot(page, 'edit-transaction')
})

for (const gesture of ['click', 'Enter'] as const) {
  test(`rows still open their records and keep their actions: pending row, ${gesture}`, async ({ page }) => {
    await openTransactions(page)
    const pending = await addRefusedTransaction(page, 'Refused lunch')
    await trigger(page, pending, gesture, 'row')
    const form = page.locator('form').filter({ has: page.getByRole('button', { name: 'Create Transaction', exact: true }) })
    await expect(form).toBeVisible()
    await expect(form.locator('input[placeholder="Add notes about this transaction"]'), 'the form reopens on the same unsaved entry').toHaveValue('Refused lunch')
    await viewportShot(page, `open-pending-${gesture.toLowerCase()}`)
  })
}

const RECURRING = 'Meralco'
for (const gesture of GESTURES) {
  test(`rows still open their records and keep their actions: recurring row, ${gesture}`, async ({ page }) => {
    await openRecurring(page)
    // STU-683: a click lands anywhere on the row; a key goes to the row's title, the one control that opens it.
    const row = recurringRow(page, RECURRING)
    await trigger(page, gesture === 'click' ? row : row.getByRole('button', { name: RECURRING, exact: true }), gesture, 'row')
    const form = recurringForm(page)
    await expect(form).toBeVisible()
    await expect(form.locator('[data-field="name"]')).toHaveValue(RECURRING)
    expect(await page.getByTestId('mark-paid-dialog').count(), 'opening the row records nothing').toBe(0)
    await viewportShot(page, `open-recurring-${gesture.toLowerCase()}`)
  })
}

/** Each row action in the fixture, the entry it is on, and the dialog it opens at the PR base. */
const ACTIONS = [
  { label: 'Mark paid', testId: 'entry-mark-paid-button', name: 'Rent', title: 'Mark Rent as paid' },
  { label: 'Mark received', testId: 'entry-mark-received-button', name: 'Payroll', title: 'Mark Payroll as received' },
  { label: 'Charged', testId: 'entry-charged-button', name: 'Netflix Standard', title: 'Record Netflix Standard' },
  { label: 'Posted', testId: 'entry-posted-button', name: 'Netflix Standard', title: 'Record Netflix Standard' },
] as const

for (const a of ACTIONS) {
  for (const gesture of GESTURES) {
    test(`rows still open their records and keep their actions: ${a.label} on ${a.name}, ${gesture}`, async ({ page }) => {
      const entry = household.entries.find((e) => e.view !== 'limited' && e.name === a.name)
      if (!entry) throw new Error(`no entry ${a.name} in the fixture`)
      const api = await openRecurring(page)
      await addRoutes(page, [entryOccurrencesRoute(household, entry.id)])
      const button = recurringRow(page, a.name).getByTestId(a.testId)
      await expect(button).toHaveText(a.label)
      await trigger(page, button, gesture)
      const dialog = page.getByTestId('mark-paid-dialog')
      await expect(dialog).toBeVisible()
      expect(await dialog.getByRole('heading').first().textContent(), 'the dialog is for the same record').toBe(a.title)
      // STU-678 replaced .btn-primary with the Button component's primary variant.
      expect(await dialog.locator('[data-variant="primary"]').first().textContent(), 'the dialog leads with the same action').toBe(a.label)
      await expect.poll(() => api.count('GET', `/budget-entries/${entry.id}/occurrences`), { message: "the dialog reads the same record's occurrences" }).toBeGreaterThan(0)
      expect(await recurringForm(page).count(), 'the action does not also open the row').toBe(0)
      await viewportShot(page, `action-${a.testId}-${gesture.toLowerCase()}`)
    })
  }
}

// ─── AC7 ────────────────────────────────────────────────────────────────────────────────────────

test('list sheet is a component and other allocation panels are unchanged: source and stylesheet', async ({ page }) => {
  await openTransactions(page)
  const selectors = await page.evaluate(() => {
    const out: string[] = []
    const walk = (list: CSSRuleList) => {
      for (const rule of Array.from(list)) {
        if (rule instanceof CSSStyleRule) out.push(rule.selectorText)
        if ('cssRules' in rule) walk((rule as CSSGroupingRule).cssRules)
      }
    }
    for (const sheet of Array.from(document.styleSheets)) {
      if (sheet.href && new URL(sheet.href).origin !== location.origin) continue
      walk(sheet.cssRules)
    }
    return out
  })
  expect(selectors.length, 'stylesheet rules were read').toBeGreaterThan(100)
  const norm = (s: string): string => s.replace(/["']/g, '').replace(/\s*([>+~,])\s*/g, '$1').replace(/\s+/g, ' ')
  expect(selectors.filter((s) => norm(s).includes(':has(>article.card)')), 'selectors containing :has(> article.card)').toEqual([])
  expect(read('src/assets/index.css').includes(':has(> article.card)'), 'index.css has no :has(> article.card)').toBe(false)
  const transactions = read('src/routes/transactions.tsx')
  const rowCards = transactions.split('\n').filter((l) => /className=/.test(l) && /\bcard\b/.test(l) && l.includes('p-4 sm:p-5'))
  expect(rowCards, 'transactions.tsx classNames with both card and p-4 sm:p-5').toEqual([])
  for (const site of ['src/routes/transactions.tsx', 'src/routes/allocations.tsx']) {
    const source = read(site)
    expect(source, `${site} imports ListSheet`).toMatch(/import \{ ListSheet \} from '\.\.\/components\/ListSheet'/)
    expect(source, `${site} imports Row`).toMatch(/import \{ Row \} from '\.\.\/components\/Row'/)
  }
  expect(read('src/components/Row.tsx'), 'Row carries the row hook').toContain('data-testid="row"')
  expect(read('src/components/Row.tsx'), 'Row carries the meta hook').toContain('data-testid="row-meta"')
  expect(read('src/components/ListSheet.tsx'), 'ListSheet carries its hook').toContain('data-testid="list-sheet"')
  await shot(page, 'component-source')
})

const PANELS = [
  {
    tab: 'Budgets',
    url: '/allocations?tab=budgets',
    names: household.allocations.filter((a) => a.allocation_type === 'budget').map((a) => a.name),
    progress: '% of limit used',
  },
  {
    tab: 'Savings',
    url: '/allocations?tab=savings',
    names: household.allocations.filter((a) => a.allocation_type !== 'budget').map((a) => a.name),
    progress: '% funded',
  },
] as const

for (const p of PANELS) {
  for (const gesture of ['click', 'Enter'] as const) {
    test(`list sheet is a component and other allocation panels are unchanged: ${p.tab}, ${gesture}`, async ({ page }) => {
      await open(page, p.url)
      const cards = page.locator('main article.card')
      await expect(cards.first()).toBeVisible()
      expect(await cards.count(), `every ${p.tab} allocation is a .card panel`).toBe(p.names.length)
      expect(await page.locator('main').getByTestId('list-sheet').count(), `${p.tab} has no list sheet`).toBe(0)
      const style = await sheetStyle(cards.first())
      expect(style.background, 'the panel is leaf').toBe(SURFACE)
      expect(style.radius, 'the panel keeps radius-md').toEqual(new Array<string>(4).fill(RADIUS_MD))
      for (const name of p.names) {
        const card = cards.filter({ has: page.getByText(name, { exact: true }) })
        expect.soft(await card.count(), `${name} is one panel`).toBe(1)
        expect.soft(await card.getByText(p.progress).count(), `${name} shows its progress`).toBe(1)
        if (p.tab === 'Budgets') expect.soft(await card.getByTestId('budget-usage-fill').count(), `${name} draws its usage bar`).toBe(1)
      }
      expect(await page.locator('main article.card').filter({ hasText: p.progress }).count(), `${p.tab} panels with their progress`).toBe(p.names.length)
      const first = cards.filter({ has: page.getByText(p.names[0], { exact: true }) })
      await trigger(page, first, gesture)
      const modal = page.locator('.modal-backdrop').filter({ has: page.getByRole('button', { name: 'Edit allocation' }) })
      await expect(modal).toBeVisible()
      expect(await modal.getByText(p.names[0], { exact: true }).count(), "the panel's dialog is for the same allocation").toBeGreaterThan(0)
      await viewportShot(page, `panels-${p.tab.toLowerCase()}-${gesture.toLowerCase()}`)
    })
  }
}

// ─── AC8 ────────────────────────────────────────────────────────────────────────────────────────

interface AmountEdge {
  name: string
  align: string
  /** Right edge of the amount's rendered text (a DOM Range). */
  text: number
  /** Right edge of the row's amount slot. */
  slot: number
}

const amountEdges = (rows: Locator): Promise<AmountEdge[]> =>
  rows.evaluateAll((all) =>
    all.map((row) => {
      const slot = row.querySelector<HTMLElement>('[data-testid="row-amount"]')
      const amount = slot?.querySelector<HTMLElement>('p')
      const range = document.createRange()
      if (amount) range.selectNodeContents(amount)
      return {
        name: (row.querySelector('p')?.textContent ?? '').trim(),
        align: amount ? getComputedStyle(amount).textAlign : '',
        text: amount ? range.getBoundingClientRect().right : NaN,
        slot: slot ? slot.getBoundingClientRect().right : NaN,
      }
    }),
  )

for (const surface of ['transactions', 'recurring'] as const) {
  test(`amounts and quick balances align right: ${surface}`, async ({ page }) => {
    if (surface === 'transactions') await openTransactions(page)
    else await openRecurring(page)
    await page.evaluate(() => document.fonts.ready)
    const sheets = page.locator('main').getByTestId('list-sheet')
    const count = await sheets.count()
    expect(count, `${surface} has a sheet`).toBeGreaterThan(0)
    let rows = 0
    for (let i = 0; i < count; i++) {
      const edges = await amountEdges(sheets.nth(i).getByTestId('row'))
      rows += edges.length
      for (const e of edges) {
        expect.soft(e.align, `${e.name}: the amount is right-aligned`).toBe('right')
        expect.soft(Math.abs(e.text - e.slot), `${e.name}: the amount text ends at its slot's right edge`).toBeLessThanOrEqual(1)
      }
      const rights = edges.map((e) => e.text)
      expect(Math.max(...rights) - Math.min(...rights), `sheet ${i + 1}: every amount shares one right edge`).toBeLessThanOrEqual(1)
    }
    expect(rows, `${surface} rows measured`).toBe(surface === 'transactions' ? monthRows.length : recurring.entries.length)
    await shot(page, `align-${surface}`)
  })
}

test('amounts and quick balances align right: quick balances', async ({ page }) => {
  await open(page, '/')
  await expect(page.getByTestId('quick-balance-tile').first()).toBeVisible()
  await page.evaluate(() => document.fonts.ready)
  const figures = await page.getByTestId('quick-balance-tile').evaluateAll((all) =>
    all.flatMap((tile) =>
      [...tile.querySelectorAll<HTMLElement>('[data-testid^="quick-balance-"]')]
        .filter((e) => ['balance', 'owed', 'due', 'unbilled', 'available', 'shared'].some((id) => e.dataset.testid === `quick-balance-${id}`))
        .map((e) => {
          const range = document.createRange()
          range.selectNodeContents(e)
          return { id: `${tile.getAttribute('data-account-id')}:${e.dataset.testid}`, align: getComputedStyle(e).textAlign, right: range.getBoundingClientRect().right }
        }),
    ),
  )
  expect(figures.length, 'one figure per quick balance at least').toBeGreaterThanOrEqual(household.quickBalances.tiles.length)
  for (const f of figures) expect.soft(f.align, `${f.id} is right-aligned`).toBe('right')
  const rights = figures.map((f) => f.right)
  expect(Math.max(...rights) - Math.min(...rights), 'the quick-balance figures share one right edge').toBeLessThanOrEqual(1)
  await shot(page, 'align-quick-balances')
})
