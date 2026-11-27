// STU-683: no control inside another. A recurring row used to be `role="button"` holding its own buttons (Charged,
// Posted, Review, "+N"), so a keyboard or screen-reader user met a button inside a button and a click on Charged could
// also open the row. Now the row's title is the control and the actions sit beside it; the title's hit area stretches
// over the row, so a click anywhere but an action still opens the entry. The API is faked in the browser with the
// shared household fixture; there is no backend.
//
// The AC6 baseline (`nested-controls.baseline.json`) is recorded once, on the PR base (STU-692's head, before this
// ticket's app change): `NESTED_RECORD=1 pnpm exec playwright test nested-controls -g "appearance" --workers=1`. A
// recording run only writes the baseline; it asserts nothing about the rows. The Transactions rows' baseline is
// recorded the same way, on the same base, with `-g "transaction rows preserve appearance and pointer behaviour: appearance"`.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test } from '@playwright/test'
import type { Locator, Page } from '@playwright/test'
import type { BudgetEntry, FullBudgetEntry, PaginatedResponse, SharedFullBudgetEntry } from '@tally-trace/shared'
import { a11y } from './support/a11y'
import {
  budgetEntriesFor,
  household,
  householdDialogRoutes,
  householdSaveRoutes,
  householdViewRoutes,
  householdWishlistRoutes,
  limitedRecurring,
  mockHousehold,
  TAG_OVERFLOW,
  withStatusStates,
  withTagOverflow,
} from './support/fixtures/household'
import type { HouseholdData } from './support/fixtures/household'
import { addRoutes, queryRoute } from './support/mockApi'
import type { ApiMock } from './support/mockApi'
import { shot } from './support/shot'

const BASELINE = fileURLToPath(new URL('./nested-controls.baseline.json', import.meta.url))
const RECORD = process.env.NESTED_RECORD === '1'

/** Writes `looks` into the baseline under `key`. Recording is a local, one-off step on the PR base: CI never records. */
function recordBaseline(key: string, looks: RowLook[]): void {
  if (process.env.CI) throw new Error('NESTED_RECORD is set on CI: the baseline is recorded once, locally, on the PR base, never on CI')
  fs.writeFileSync(BASELINE, `${JSON.stringify({ ...readBaseline(), [key]: looks }, null, 2)}\n`)
}

/** The ticket's nested-control selector (AC1, AC5): a control that is a descendant of another control. */
const NESTED = '[role=button] button, [role=button] a, button button, a button'

/**
 * The household with every row form the Recurring tab draws: the busy month's entries (tags, paused rows, Charged and
 * Posted, Mark paid, Mark received), STU-692's card installments (Review, Turn off, Fully paid) and another member's
 * two limited entries.
 */
const states = withStatusStates(household)
const recurring: HouseholdData = { ...states, entries: [...states.entries, ...limitedRecurring] }

/** The full entries a row opens for editing, by name. */
const editable = recurring.entries.filter((e): e is FullBudgetEntry | SharedFullBudgetEntry => e.view !== 'limited' && e.permissions.can_edit)
const entryNamed = (name: string) => {
  const found = editable.find((e) => e.name === name)
  if (!found) throw new Error(`no editable entry ${name} in the fixture`)
  return found
}

/** A viewport screenshot (a full-page one draws a fixed layer at the scroll offset), saved like `shot()`. */
async function viewportShot(page: Page, name: string): Promise<void> {
  const info = test.info()
  const spec = path.basename(info.file).replace(/\.spec\.ts$/, '')
  await page.screenshot({ path: path.join(info.project.outputDir, 'screens', `${spec}-${name}-${info.project.name}.png`), animations: 'disabled' })
}

const slug = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')

/** Signs in, fakes the API from `data` (plus the views, the wishlist, the dialogs and the saves), opens `url`. */
async function open(page: Page, url: string, heading: string, data: HouseholdData = recurring): Promise<ApiMock> {
  const api = await mockHousehold(page, data)
  await addRoutes(page, [
    queryRoute<PaginatedResponse<BudgetEntry>>('GET', '/budget-entries/', (q) => budgetEntriesFor(data, q)),
    ...householdViewRoutes(data),
    ...householdWishlistRoutes(),
    ...householdDialogRoutes(data),
    ...householdSaveRoutes(data),
  ])
  await page.goto(url)
  // The preview server serves each route's chunk on first visit; under a full parallel run that can pass 5s.
  await expect(page.getByRole('heading', { level: 1, name: heading })).toBeVisible({ timeout: 15_000 })
  await page.waitForLoadState('networkidle')
  await page.evaluate(() => document.fonts.ready)
  return api
}

/** Allocations on its Recurring tab, once every entry, full and limited, is listed. */
async function openRecurring(page: Page): Promise<ApiMock> {
  const api = await open(page, '/allocations?tab=recurring', 'Allocations')
  const rows = page.locator('[data-testid^="kind-section-"]').getByTestId('row')
  await expect(rows.first()).toBeVisible()
  // STU-799: the headers count every entry (the tab has loaded them all); a section lists 5 of them a page.
  const counts = (): Promise<number[]> =>
    page.locator('[data-testid^="kind-section-"] header span').evaluateAll((els) => els.map((e) => Number(e.textContent)))
  await expect.poll(async () => (await counts()).reduce((a, b) => a + b, 0), { message: 'every recurring entry counted' }).toBe(recurring.entries.length)
  await expect.poll(async () => rows.count(), { message: 'the first page of each section listed' }).toBe((await counts()).reduce((a, n) => a + Math.min(5, n), 0))
  await page.mouse.move(0, 0)
  return api
}

/** The recurring row whose title is `name`. */
const recurringRow = (page: Page, name: string): Locator =>
  page.locator('[data-testid^="kind-section-"]').getByTestId('row').filter({ has: page.locator('[data-row-title]', { hasText: new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`) }) })

/** STU-799: a section lists 5 entries a page, so a row past page 1 is reached through the page search. */
async function findRow(page: Page, name: string): Promise<Locator> {
  await page.getByLabel('Search recurring entries').fill(name)
  return recurringRow(page, name)
}

/** The open recurring-entry edit dialog. */
const editDialog = (page: Page): Locator => page.locator('form').filter({ has: page.getByRole('button', { name: 'Update recurring entry' }) })

// ─── AC1 ────────────────────────────────────────────────────────────────────────────────────────

test('recurring rows contain no nested controls', async ({ page }) => {
  await openRecurring(page)
  const rows = page.locator('[data-testid^="kind-section-"]').getByTestId('row')
  // Every row form is on the page: actions, details with their own buttons, and a "+N" on the phone.
  expect(await rows.locator('button').count(), 'buttons drawn inside recurring rows').toBeGreaterThan(5)
  await shot(page, 'recurring')
  const nested = await page.locator(NESTED).evaluateAll((all) => all.map((e) => `${e.tagName.toLowerCase()} "${(e.textContent ?? '').trim().slice(0, 40)}"`))
  expect(nested, `matches of ${NESTED} on the Recurring tab`).toEqual([])
  expect(await page.locator(NESTED).count(), 'nested-control count').toBe(0)
})

// ─── AC2 ────────────────────────────────────────────────────────────────────────────────────────

test('the row title is the control: one control per row, named after the entry', async ({ page }) => {
  await openRecurring(page)
  await shot(page, 'title-controls')
  for (const e of editable) {
    const row = await findRow(page, e.name)
    await expect(row, `${e.name}: one row`).toHaveCount(1)
    expect(await row.getAttribute('role'), `${e.name}: the row itself is not a control`).toBeNull()
    expect(await row.getByRole('button', { name: e.name, exact: true }).count(), `${e.name}: controls named after the entry`).toBe(1)
  }
})

type Gesture = 'click' | 'Enter' | 'Space'
const GESTURES: Gesture[] = ['click', 'Enter', 'Space']
/** An entry with Charged and Posted beside its title, so the title is not the row's only control. */
const WITH_ACTIONS = 'Netflix Standard'
/** An editable entry that draws a tag chip on its title line (STU-799: found by the page search, as it may not be on page 1). */
const TAGGED = (editable.find((e) => e.tags.length > 0) ?? editable[0]).name

for (const gesture of GESTURES) {
  test(`the row title is the control: ${gesture} opens the edit dialog`, async ({ page }) => {
    await openRecurring(page)
    const title = (await findRow(page, WITH_ACTIONS)).getByRole('button', { name: WITH_ACTIONS, exact: true })
    if (gesture === 'click') await title.click()
    else {
      await title.focus()
      await expect(title).toBeFocused()
      await page.keyboard.press(gesture)
    }
    await expect(editDialog(page)).toBeVisible()
    await expect(editDialog(page).locator('[data-field="name"]')).toHaveValue(WITH_ACTIONS)
    await viewportShot(page, `title-${gesture.toLowerCase()}`)
    expect(await editDialog(page).count(), 'edit dialogs open').toBe(1)
    expect(await page.getByTestId('mark-paid-dialog').count(), 'opening the entry records nothing').toBe(0)
  })
}

// ─── AC3 ────────────────────────────────────────────────────────────────────────────────────────

/**
 * Each card action on its row, the button in the record dialog that sends it, and what the request says about posting:
 * Charged sends `is_posted: false` (charged, not yet posted); Posted sends no `is_posted` field, so the record is posted.
 */
const ACTIONS = [
  { label: 'Charged', testId: 'entry-charged-button', submit: 'mark-paid-charged', sendsIsPosted: true },
  { label: 'Posted', testId: 'entry-posted-button', submit: 'mark-paid-submit', sendsIsPosted: false },
] as const

for (const a of ACTIONS) {
  test(`row actions do not open the row: ${a.label}`, async ({ page }) => {
    const entry = entryNamed(WITH_ACTIONS)
    const path = `/budget-entries/${entry.id}/materialize`
    const api = await openRecurring(page)
    const button = (await findRow(page, WITH_ACTIONS)).getByTestId(a.testId)
    await expect(button).toHaveText(a.label)
    await button.click()
    const dialog = page.getByTestId('mark-paid-dialog')
    await expect(dialog).toBeVisible()
    expect(await dialog.getByRole('heading').first().textContent(), 'the record dialog is for the row').toBe(`Record ${WITH_ACTIONS}`)
    expect(await editDialog(page).count(), `${a.label} opens no edit dialog`).toBe(0)
    await expect(dialog.getByTestId('mark-paid-occurrence').first()).toBeVisible()
    await dialog.getByTestId(a.submit).click()
    await expect(dialog).toBeHidden()
    await expect.poll(() => api.count('POST', path), { message: `${a.label}: POST ${path}` }).toBe(1)
    // Settled: nothing more is sent, and the row did not open behind the dialog.
    await page.waitForLoadState('networkidle')
    await viewportShot(page, `action-${slug(a.label)}`)
    expect(api.count('POST', path), `${a.label}: POST ${path} sent exactly once`).toBe(1)
    const sent = api.bodies('POST', path)[0] as Record<string, unknown> | undefined
    expect(sent, `${a.label}: the request has a body`).toBeDefined()
    expect(sent?.occurrence_date, `${a.label}: the occurrence recorded`).toMatch(/^\d{4}-\d{2}-\d{2}/)
    expect(sent?.transaction_date, `${a.label}: the date recorded`).toMatch(/^\d{4}-\d{2}-\d{2}/)
    expect(Object.hasOwn(sent ?? {}, 'is_posted'), `${a.label}: is_posted is sent`).toBe(a.sendsIsPosted)
    if (a.sendsIsPosted) expect(sent?.is_posted, `${a.label}: is_posted`).toBe(false)
    expect(await editDialog(page).count(), `${a.label}: edit dialogs open`).toBe(0)
  })
}

// ─── AC4 ────────────────────────────────────────────────────────────────────────────────────────

test('keyboard order is title then actions', async ({ page }) => {
  await openRecurring(page)
  const row = await findRow(page, WITH_ACTIONS)
  const title = row.getByRole('button', { name: WITH_ACTIONS, exact: true })
  await title.focus()
  await expect(title).toBeFocused()
  await page.keyboard.press('Tab')
  await expect(row.getByTestId('entry-charged-button')).toBeFocused()
  await page.keyboard.press('Tab')
  await expect(row.getByTestId('entry-posted-button')).toBeFocused()
  await viewportShot(page, 'keyboard-order')
  await page.keyboard.press('Tab')
  expect(await row.evaluate((r) => r.contains(document.activeElement)), 'focus has left the row after Posted').toBe(false)
})

// ─── AC5 ────────────────────────────────────────────────────────────────────────────────────────

/** The main pages: the dashboard, Transactions (its rows and Due card) and Allocations on each of its four tabs. */
const PAGES = [
  { name: 'Dashboard', url: '/', heading: 'Dashboard', ready: (p: Page) => p.locator('main') },
  { name: 'Transactions', url: '/transactions', heading: 'Transactions', ready: (p: Page) => p.getByTestId('due-section') },
  { name: 'Allocations Recurring', url: '/allocations?tab=recurring', heading: 'Allocations', ready: (p: Page) => p.locator('[data-testid^="kind-section-"]').first() },
  { name: 'Allocations Budgets', url: '/allocations?tab=budgets', heading: 'Allocations', ready: (p: Page) => p.locator('main') },
  { name: 'Allocations Savings', url: '/allocations?tab=savings', heading: 'Allocations', ready: (p: Page) => p.locator('main') },
  { name: 'Allocations Wishlist', url: '/allocations?tab=wishlist', heading: 'Allocations', ready: (p: Page) => p.locator('main') },
] as const

for (const p of PAGES) {
  test(`no nested controls on the main pages: ${p.name}`, async ({ page }) => {
    await open(page, p.url, p.heading)
    await expect(p.ready(page)).toBeVisible()
    if (p.name === 'Transactions') {
      await expect(page.locator('article[data-transaction-id]').first()).toBeVisible()
      // The Due card's rows are on the page.
      expect(await page.getByTestId('due-section').locator('button').count(), 'controls in the Due card').toBeGreaterThan(0)
    }
    await shot(page, `page-${slug(p.name)}`)
    expect(await page.locator(NESTED).count(), `${p.name}: matches of ${NESTED}`).toBe(0)
    const findings = await a11y(page)
    expect(findings.filter((f) => f.rule === 'nested-interactive'), `${p.name}: critical nested-interactive findings`).toEqual([])
    // axe rates nested-interactive "serious", which a11y() records as an annotation rather than returning.
    const serious = test.info().annotations.filter((a) => a.type === 'a11y-serious' && (a.description ?? '').startsWith('nested-interactive '))
    expect(serious.map((a) => a.description), `${p.name}: nested-interactive findings`).toEqual([])
  })
}

// The Transactions list with a row whose tags overflow its title line, so the row draws its "+N" tag button.
const overflowing: HouseholdData = withTagOverflow(withStatusStates(household))

/** The Transactions list, once its rows and the overflowing row's "+N" are drawn. */
async function openTransactions(page: Page): Promise<ApiMock> {
  const api = await open(page, '/transactions', 'Transactions', overflowing)
  await expect(txRow(page, TAG_OVERFLOW.id).getByTestId('row-tags-more')).toBeVisible()
  await page.mouse.move(0, 0)
  return api
}

/** The Transactions row for the transaction `id`. */
const txRow = (page: Page, id: number): Locator => page.locator(`article[data-transaction-id="${id}"]`)

/** The open Transaction actions dialog. */
const actionDialog = (page: Page): Locator => page.locator('.modal-backdrop').filter({ hasText: 'Transaction actions' })

test('no nested controls on the main pages: Transactions with a "+N" tag button', async ({ page }) => {
  await openTransactions(page)
  const row = txRow(page, TAG_OVERFLOW.id)
  const more = row.getByTestId('row-tags-more')
  await shot(page, 'page-transactions-tag-overflow')
  expect(await more.count(), 'the overflowing row draws one "+N"').toBe(1)
  expect(await page.locator(NESTED).count(), `Transactions: matches of ${NESTED}`).toBe(0)
  expect(await row.getAttribute('role'), 'the row itself is not a control').toBeNull()
  expect(await row.getByRole('button', { name: TAG_OVERFLOW.description, exact: true }).count(), 'one control named after the transaction').toBe(1)
  expect(await more.evaluate((m) => m.closest('button:not([data-testid="row-tags-more"]), a, [role=button]') === null), '"+N" sits inside no other control').toBe(true)
  const findings = await a11y(page)
  expect(findings.filter((f) => f.rule === 'nested-interactive'), 'Transactions: critical nested-interactive findings').toEqual([])
  const serious = test.info().annotations.filter((a) => a.type === 'a11y-serious' && (a.description ?? '').startsWith('nested-interactive '))
  expect(serious.map((a) => a.description), 'Transactions: nested-interactive findings').toEqual([])
})

// ─── AC6 ────────────────────────────────────────────────────────────────────────────────────────

/** One drawn text run in a row: its words, where they sit in the row, and how they are drawn. */
interface TextRun {
  text: string
  x: number
  y: number
  w: number
  h: number
  style: string
}

/** One painted box in a row (a background, a border or a shadow): where it sits and how it is drawn. */
interface PaintedBox {
  x: number
  y: number
  w: number
  h: number
  style: string
}

/** What a row looks like and how it answers a mouse: its box, its text, its painted boxes, its hover and its cursor. */
interface RowLook {
  name: string
  x: number
  /** The row's top in the document: recorded, not compared (see `sy`). */
  y: number
  /** The row's top inside its list sheet, which is what the comparison uses for the row's vertical place. */
  sy: number
  w: number
  h: number
  row: string
  texts: TextRun[]
  boxes: PaintedBox[]
  hover?: string
  cursor?: string
}

/**
 * Reads a row's look: everything is relative to the row's own box; the row's box is relative to the document, and its
 * top also relative to the list sheet that holds it.
 */
const lookOf = (row: Locator): Promise<RowLook> =>
  row.evaluate((r) => {
    const round = (n: number): number => Math.round(n * 100) / 100
    const box = r.getBoundingClientRect()
    const rel = (b: DOMRect) => ({ x: round(b.left - box.left), y: round(b.top - box.top), w: round(b.width), h: round(b.height) })
    const shown = (e: Element): boolean => e.checkVisibility({ checkVisibilityCSS: true, visibilityProperty: true }) && e.getClientRects().length > 0
    const texts: { text: string; x: number; y: number; w: number; h: number; style: string }[] = []
    const walker = document.createTreeWalker(r, NodeFilter.SHOW_TEXT)
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const text = (n.textContent ?? '').replace(/\s+/g, ' ').trim()
      const parent = n.parentElement
      if (!text || !parent || !shown(parent)) continue
      const range = document.createRange()
      range.selectNodeContents(n)
      const s = getComputedStyle(parent)
      texts.push({
        text,
        ...rel(range.getBoundingClientRect()),
        style: [s.color, s.fontFamily, s.fontSize, s.fontWeight, s.fontStyle, s.lineHeight, s.letterSpacing, s.textTransform, s.textDecorationLine, s.textOverflow, s.opacity].join(' | '),
      })
    }
    const boxes: { x: number; y: number; w: number; h: number; style: string }[] = []
    for (const e of [r, ...Array.from(r.querySelectorAll('*'))]) {
      if (!shown(e)) continue
      const s = getComputedStyle(e)
      const sides = ['top', 'right', 'bottom', 'left'].map((side) => `${s.getPropertyValue(`border-${side}-width`)} ${s.getPropertyValue(`border-${side}-style`)} ${s.getPropertyValue(`border-${side}-color`)}`)
      const bordered = sides.some((b) => !b.startsWith('0px'))
      const filled = s.backgroundColor !== 'rgba(0, 0, 0, 0)' || s.backgroundImage !== 'none'
      if (!bordered && !filled && s.boxShadow === 'none') continue
      const radius = ['top-left', 'top-right', 'bottom-right', 'bottom-left'].map((c) => s.getPropertyValue(`border-${c}-radius`))
      boxes.push({ ...rel(e.getBoundingClientRect()), style: [s.backgroundColor, s.backgroundImage, ...sides, ...radius, s.boxShadow, s.opacity].join(' | ') })
    }
    const s = getComputedStyle(r)
    return {
      name: (r.querySelector('[data-row-title]')?.textContent ?? '').trim(),
      x: round(box.left + window.scrollX),
      y: round(box.top + window.scrollY),
      sy: round(box.top - (r.closest('[data-testid="list-sheet"]') ?? document.documentElement).getBoundingClientRect().top),
      w: round(box.width),
      h: round(box.height),
      row: [s.backgroundColor, s.opacity, s.paddingTop, s.paddingRight, s.paddingBottom, s.paddingLeft].join(' | '),
      texts,
      boxes,
    }
  })

/** The row's background while the pointer rests in its top-left padding, and the cursor shown there. */
async function hoverOf(page: Page, row: Locator): Promise<{ hover: string; cursor: string }> {
  await row.scrollIntoViewIfNeeded()
  await row.hover({ position: { x: 8, y: 8 } })
  const result = await row.evaluate((r) => {
    const b = r.getBoundingClientRect()
    const under = document.elementFromPoint(b.left + 8, b.top + 8)
    return { hover: getComputedStyle(r).backgroundColor, cursor: under ? getComputedStyle(under).cursor : 'none' }
  })
  await page.mouse.move(0, 0)
  return result
}

type Baseline = Record<string, RowLook[]>
const readBaseline = (): Baseline => (fs.existsSync(BASELINE) ? (JSON.parse(fs.readFileSync(BASELINE, 'utf8')) as Baseline) : {})
const near = (a: number, b: number): boolean => Math.abs(a - b) <= 0.5

/** Every way `now` differs from `base`, as readable lines; empty when they match. */
function differences(base: RowLook, now: RowLook): string[] {
  const out: string[] = []
  const at = `${base.name}:`
  // A row's vertical place is its top inside its list sheet, not in the document: content above the list (a page's
  // intro line, a tab bar) moves every sheet without changing how a row looks. Any change to a row's own place in its
  // sheet (padding or a row above it growing, a row's order) still shows here, and the sheet screenshots stay saved.
  for (const k of ['x', 'sy', 'w', 'h'] as const) if (!near(base[k], now[k])) out.push(`${at} row ${k} ${base[k]} -> ${now[k]}`)
  for (const k of ['row', 'hover', 'cursor'] as const) if (base[k] !== now[k]) out.push(`${at} ${k} "${base[k]}" -> "${now[k]}"`)
  if (base.texts.length !== now.texts.length) out.push(`${at} ${base.texts.length} text runs -> ${now.texts.length}`)
  base.texts.forEach((t, i) => {
    const n = now.texts[i]
    if (!n) return
    if (t.text !== n.text || t.style !== n.style || !near(t.x, n.x) || !near(t.y, n.y) || !near(t.w, n.w) || !near(t.h, n.h)) out.push(`${at} text ${JSON.stringify(t)} -> ${JSON.stringify(n)}`)
  })
  if (base.boxes.length !== now.boxes.length) out.push(`${at} ${base.boxes.length} painted boxes -> ${now.boxes.length}`)
  base.boxes.forEach((b, i) => {
    const n = now.boxes[i]
    if (!n) return
    if (b.style !== n.style || !near(b.x, n.x) || !near(b.y, n.y) || !near(b.w, n.w) || !near(b.h, n.h)) out.push(`${at} box ${JSON.stringify(b)} -> ${JSON.stringify(n)}`)
  })
  return out
}

test('recurring rows preserve appearance and pointer behaviour: appearance', async ({ page }, testInfo) => {
  await openRecurring(page)
  const rows = page.locator('[data-testid^="kind-section-"]').getByTestId('row')
  const looks: RowLook[] = []
  for (let i = 0; i < (await rows.count()); i += 1) {
    const row = rows.nth(i)
    const look = await lookOf(row)
    // An entry the caller can edit answers the pointer; a limited entry has no opener, then and now.
    looks.push({ ...look, ...(await hoverOf(page, row)) })
  }
  await page.evaluate(() => window.scrollTo(0, 0))
  await shot(page, 'appearance')
  for (const [i, s] of (await page.locator('[data-testid^="kind-section-"]').getByTestId('list-sheet').all()).entries()) {
    await s.screenshot({ path: path.join(testInfo.project.outputDir, 'screens', `nested-controls-appearance-sheet-${i + 1}-${testInfo.project.name}.png`), animations: 'disabled' })
  }
  if (RECORD) {
    recordBaseline(testInfo.project.name, looks)
    return
  }
  const base = readBaseline()[testInfo.project.name] ?? []
  // STU-799: the baseline was re-recorded for the first page of each Recurring section (5 entries a page).
  expect(base.length, `the baseline has the ${testInfo.project.name} rows`).toBe(looks.length)
  expect(looks.map((l) => l.name), 'the same rows in the same order').toEqual(base.map((l) => l.name))
  const changed = base.flatMap((b, i) => (looks[i] ? differences(b, looks[i]) : [`${b.name}: missing`]))
  expect(changed, 'differences from the baseline recorded before this change').toEqual([])
})

/**
 * Places in a row that are not an action: its padding, its meta line, its amount and a tag chip. Each is clicked with
 * the mouse at that spot, as a person would: whatever is drawn on top there takes the click.
 */
const AREAS = [
  { name: 'padding', find: (row: Locator) => row, at: () => ({ x: 8, y: 8 }) },
  { name: 'meta line', find: (row: Locator) => row.getByTestId('row-meta').first(), at: (b: Box) => ({ x: b.width / 2, y: b.height / 2 }) },
  { name: 'amount', find: (row: Locator) => row.getByTestId('row-amount'), at: (b: Box) => ({ x: b.width / 2, y: b.height / 2 }) },
  { name: 'tag chip', find: (row: Locator) => row.getByTestId('row-tags').getByTestId('tag-chip').first(), at: (b: Box) => ({ x: b.width / 2, y: b.height / 2 }) },
] as const
type Box = { x: number; y: number; width: number; height: number }

for (const area of AREAS) {
  test(`recurring rows preserve appearance and pointer behaviour: a click on the ${area.name} opens the entry once`, async ({ page }) => {
    test.skip(RECORD, 'a recording run only writes the baseline')
    await openRecurring(page)
    let opened = 0
    await page.exposeFunction('__opened', () => {
      opened += 1
    })
    // Counts each time an edit dialog is added to the page.
    await page.evaluate(() => {
      const w = window as unknown as { __opened: () => void }
      new MutationObserver((records) => {
        for (const r of records)
          for (const n of Array.from(r.addedNodes))
            if (n instanceof Element && [n, ...Array.from(n.querySelectorAll('button'))].some((b) => b.textContent === 'Update recurring entry')) w.__opened()
      }).observe(document.body, { childList: true, subtree: true })
    })
    // Netflix Standard draws no chip on its title line, so the chip is clicked on the first editable row that does.
    const row =
      area.name === 'tag chip'
        ? (await findRow(page, TAGGED)).filter({ has: page.getByTestId('row-tags').getByTestId('tag-chip') }).first()
        : await findRow(page, WITH_ACTIONS)
    const name = ((await row.locator('[data-row-title]').textContent()) ?? '').trim()
    const target = area.find(row)
    await target.scrollIntoViewIfNeeded()
    const box = await target.boundingBox()
    if (!box) throw new Error(`no box for the ${area.name}`)
    const at = area.at(box)
    await page.mouse.click(box.x + at.x, box.y + at.y)
    await expect(editDialog(page)).toBeVisible()
    await expect(editDialog(page).locator('[data-field="name"]')).toHaveValue(name)
    await page.waitForLoadState('networkidle')
    await viewportShot(page, `click-${slug(area.name)}`)
    expect(opened, 'edit dialogs opened by one click').toBe(1)
    expect(await editDialog(page).count(), 'edit dialogs on the page').toBe(1)
    expect(await page.getByTestId('mark-paid-dialog').count(), 'the click records nothing').toBe(0)
  })
}

// ─── AC6 on the Transactions rows ───────────────────────────────────────────────────────────────

/** The Transactions rows' looks, keyed apart from the recurring rows in the same baseline file. */
const txKey = (project: string): string => `transactions:${project}`

test('transaction rows preserve appearance and pointer behaviour: appearance', async ({ page }, testInfo) => {
  await openTransactions(page)
  const rows = page.locator('article[data-transaction-id]')
  const looks: RowLook[] = []
  for (let i = 0; i < (await rows.count()); i += 1) {
    const row = rows.nth(i)
    const look = await lookOf(row)
    looks.push({ ...look, ...(await hoverOf(page, row)) })
  }
  await page.evaluate(() => window.scrollTo(0, 0))
  await shot(page, 'transactions-appearance')
  for (const [i, s] of (await page.getByTestId('list-sheet').all()).entries()) {
    await s.screenshot({ path: path.join(testInfo.project.outputDir, 'screens', `nested-controls-transactions-sheet-${i + 1}-${testInfo.project.name}.png`), animations: 'disabled' })
  }
  if (RECORD) {
    recordBaseline(txKey(testInfo.project.name), looks)
    return
  }
  const base = readBaseline()[txKey(testInfo.project.name)] ?? []
  expect(base.length, `the baseline has the ${testInfo.project.name} transaction rows`).toBeGreaterThan(0)
  expect(looks.map((l) => l.name), 'the same rows in the same order').toEqual(base.map((l) => l.name))
  const changed = base.flatMap((b, i) => (looks[i] ? differences(b, looks[i]) : [`${b.name}: missing`]))
  expect(changed, 'differences from the baseline recorded before this change').toEqual([])
})

for (const area of AREAS) {
  test(`transaction rows preserve appearance and pointer behaviour: a click on the ${area.name} opens the actions once`, async ({ page }) => {
    test.skip(RECORD, 'a recording run only writes the baseline')
    await openTransactions(page)
    let opened = 0
    await page.exposeFunction('__opened', () => {
      opened += 1
    })
    // Counts each time a Transaction actions dialog is added to the page.
    await page.evaluate(() => {
      const w = window as unknown as { __opened: () => void }
      new MutationObserver((records) => {
        for (const r of records)
          for (const n of Array.from(r.addedNodes))
            if (n instanceof Element && [n, ...Array.from(n.querySelectorAll('h2'))].some((h) => h.tagName === 'H2' && h.textContent === 'Transaction actions')) w.__opened()
      }).observe(document.body, { childList: true, subtree: true })
    })
    // On a phone the overflowing row's chips all fold into its "+N", so the chip is clicked on the first row that draws one.
    const row =
      area.name === 'tag chip'
        ? page.locator('article[data-transaction-id]').filter({ has: page.getByTestId('row-tags').getByTestId('tag-chip') }).first()
        : txRow(page, TAG_OVERFLOW.id)
    const name = ((await row.locator('[data-row-title]').textContent()) ?? '').trim()
    const target = area.find(row)
    await target.scrollIntoViewIfNeeded()
    const box = await target.boundingBox()
    if (!box) throw new Error(`no box for the ${area.name}`)
    const at = area.at(box)
    await page.mouse.click(box.x + at.x, box.y + at.y)
    await expect(actionDialog(page)).toBeVisible()
    await expect(actionDialog(page).locator('h2 + p')).toHaveText(name)
    await page.waitForLoadState('networkidle')
    await viewportShot(page, `transaction-click-${slug(area.name)}`)
    expect(opened, 'action dialogs opened by one click').toBe(1)
    expect(await actionDialog(page).count(), 'action dialogs on the page').toBe(1)
  })
}

for (const gesture of GESTURES) {
  test(`transaction rows preserve appearance and pointer behaviour: ${gesture} on the title opens the actions`, async ({ page }) => {
    test.skip(RECORD, 'a recording run only writes the baseline')
    await openTransactions(page)
    const title = txRow(page, TAG_OVERFLOW.id).getByRole('button', { name: TAG_OVERFLOW.description, exact: true })
    if (gesture === 'click') await title.click()
    else {
      await title.focus()
      await expect(title).toBeFocused()
      await page.keyboard.press(gesture)
    }
    await expect(actionDialog(page)).toBeVisible()
    await viewportShot(page, `transaction-title-${gesture.toLowerCase()}`)
    expect(await actionDialog(page).count(), 'action dialogs on the page').toBe(1)
  })
}

test('transaction rows preserve appearance and pointer behaviour: "+N" shows the tags and opens nothing', async ({ page }) => {
  test.skip(RECORD, 'a recording run only writes the baseline')
  await openTransactions(page)
  const row = txRow(page, TAG_OVERFLOW.id)
  const more = row.getByTestId('row-tags-more')
  await expect(more).toHaveAttribute('aria-expanded', 'false')
  await more.click()
  await expect(more).toHaveAttribute('aria-expanded', 'true')
  await expect(row.locator('[data-row-tags-rest]')).toBeVisible()
  await page.waitForLoadState('networkidle')
  await viewportShot(page, 'transaction-tags-more')
  expect(await actionDialog(page).count(), '"+N" opens no action dialog').toBe(0)
  // Keyboard: Tab from the title reaches "+N", and Enter on it toggles the tags without opening the row.
  const title = row.getByRole('button', { name: TAG_OVERFLOW.description, exact: true })
  await title.focus()
  await page.keyboard.press('Tab')
  await expect(more).toBeFocused()
  await page.keyboard.press('Enter')
  await expect(more).toHaveAttribute('aria-expanded', 'false')
  expect(await actionDialog(page).count(), 'Enter on "+N" opens no action dialog').toBe(0)
})
