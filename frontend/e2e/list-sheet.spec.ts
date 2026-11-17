// STU-681: a list is one surface with ruled rows, not a card per item (docs/design-system.md, "Ledger and Row", ban 5).
// Transactions and the Allocations Recurring tab list their records as `Row`s on a `ListSheet`; the dashboard has no
// box inside a box, and its quick balances are figures on their panel, separated by a rule. The API is faked in the
// browser with the shared household fixture; there is no backend.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test } from '@playwright/test'
import type { Locator, Page } from '@playwright/test'
import { entryOccurrencesRoute, household, mockHousehold } from './support/fixtures/household'
import { addRoutes } from './support/mockApi'
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

/** Allocations on its Recurring tab, once its entries are listed. */
async function openRecurring(page: Page): Promise<ApiMock> {
  const api = await open(page, '/allocations?tab=recurring')
  await expect(page.locator('[data-testid^="kind-section-"] article').first()).toBeVisible()
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
    expect.soft(r.radius, `row ${i + 1} (${r.name}) is square`).toEqual(['0px', '0px', '0px', '0px'])
  }
  expect(rules.slice(0, -1).filter((r) => r.bottom !== RULE).map((r) => r.name), 'rows without a rule, last excepted').toEqual([])
  expect(rules[rules.length - 1]?.bottom, 'the last row has no rule').toMatch(NO_RULE)
  expect(rules.filter((r) => r.radius.some((v) => v !== '0px')).map((r) => r.name), 'rows with a radius').toEqual([])
  await shot(page, 'rows-ruled')
})

// ─── AC3 ────────────────────────────────────────────────────────────────────────────────────────

interface Measured {
  name: string
  height: number
  metaLines: number
  metaHeight: number
  extra: number
}

/** Every row's height, its meta lines (count and rendered height) and whether anything sits under them. */
const measure = (rows: Locator): Promise<Measured[]> =>
  rows.evaluateAll((all) =>
    all.map((e) => {
      const metas = [...e.querySelectorAll<HTMLElement>('[data-testid="row-meta"]')]
      return {
        name: (e.querySelector('p')?.textContent ?? '').trim(),
        height: e.getBoundingClientRect().height,
        metaLines: metas.length,
        metaHeight: metas[0]?.getBoundingClientRect().height ?? 0,
        extra: e.querySelectorAll('[data-testid="row-extra"]').length,
      }
    }),
  )

/** Rows that carry exactly one meta line, rendered as one 16px line, and nothing under it. */
const qualifying = (rows: Measured[]): Measured[] => rows.filter((r) => r.metaLines === 1 && r.metaHeight <= 17 && r.extra === 0)

const PITCH_CASES = [
  {
    surface: 'transactions',
    // From the fixture: the month's rows with no tags carry one meta line and nothing under it.
    expected: monthRows.filter((t) => (t.tags?.length ?? 0) === 0).map((t) => (t.view === 'limited' ? '' : t.description)),
  },
  {
    surface: 'recurring',
    // From the fixture: a paused entry with no description or tags offers no action, so it is one meta line only.
    expected: household.entries
      .filter((e) => e.view !== 'limited' && !e.is_active && !e.description && (e.tags?.length ?? 0) === 0)
      .map((e) => (e.view === 'limited' ? '' : e.name)),
  },
] as const

for (const c of PITCH_CASES) {
  test(`rows keep an even pitch: ${c.surface}`, async ({ page }, testInfo) => {
    if (c.surface === 'transactions') await openTransactions(page)
    else await openRecurring(page)
    await page.evaluate(() => document.fonts.ready)
    const want = PITCH[testInfo.project.name]
    const rows = await measure(page.locator('main').getByTestId('list-sheet').getByTestId('row'))
    const one = qualifying(rows)
    expect(c.expected.length, `the fixture has at least two ${c.surface} rows with one meta line`).toBeGreaterThanOrEqual(2)
    expect(one.map((r) => r.name).sort(), `the ${c.surface} rows with one meta line are the fixture's`).toEqual([...c.expected].sort())
    for (const r of one) {
      expect.soft(Math.abs(r.height - want), `${c.surface} row "${r.name}" is ${want}px (measured ${r.height}px)`).toBeLessThanOrEqual(1)
    }
    expect(one.filter((r) => Math.abs(r.height - want) > 1).map((r) => `${r.name}: ${r.height}px`), `${c.surface} rows with one meta line that are not ${want}px`).toEqual([])
    await shot(page, `pitch-${c.surface}`)
  })
}

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
      expect.soft(r.radius, `${key}: row ${r.name} is square`).toEqual(['0px', '0px', '0px', '0px'])
    }
    total += rules.length
  }
  expect(total, "the sheets' rows match the fixture's recurring entries").toBe(household.entries.length)
  expect(await main.getByTestId('list-sheet').getByTestId('row').count(), 'rows on Recurring sheets').toBe(household.entries.length)
  await shot(page, 'recurring-sheet')
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

async function trigger(page: Page, target: Locator, gesture: Gesture): Promise<void> {
  if (gesture === 'click') {
    await target.click()
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
    await trigger(page, row, gesture)
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

const RECURRING = 'Meralco'
for (const gesture of GESTURES) {
  test(`rows still open their records and keep their actions: recurring row, ${gesture}`, async ({ page }) => {
    await openRecurring(page)
    await trigger(page, recurringRow(page, RECURRING), gesture)
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
      expect(await dialog.locator('.btn-primary').first().textContent(), 'the dialog leads with the same action').toBe(a.label)
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
    expect(rows, `${surface} rows measured`).toBe(surface === 'transactions' ? monthRows.length : household.entries.length)
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
