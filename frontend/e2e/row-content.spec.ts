// STU-689: each fact once per row. A row on Transactions or the Allocations Recurring tab says each thing one time:
// the entry's type is left out under a heading that already says it, the cadence is one item, "by <name>" appears
// only when the creator is not the viewer or the account is shared, and a row's meta is plain text (tags are the only
// chips) in at most three items to a line. The API is faked in the browser with the shared household fixture;
// there is no backend.
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { expect, test } from '@playwright/test'
import type { Locator, Page } from '@playwright/test'
import type { BudgetEntry, PaginatedResponse } from '@tally-trace/shared'
import {
  budgetEntriesFor,
  CREATOR_COMBOS,
  household,
  limitedRecurring,
  mockHousehold,
  SHARED_ACCOUNT_IDS,
  withCreatorCombos,
  withInstallmentAndBill,
  withStatusStates,
  withTagOverflow,
} from './support/fixtures/household'
import { addRoutes, queryRoute } from './support/mockApi'
import { shot } from './support/shot'

// Design-system tokens (docs/design-system.md, light theme) as getComputedStyle reports them.
const SUNKEN = 'rgb(214, 222, 211)'
const RADIUS_SM = '4px'
const TRANSPARENT = 'rgba(0, 0, 0, 0)'
/** A row with one meta line, between rules: 56px on desktop and 64px on a phone. */
const PITCH: Record<string, number> = { desktop: 56, phone: 64 }

/** The busy month plus the one creator-and-sharing combination it lacks, and another member's limited entries. */
const data = withInstallmentAndBill(withCreatorCombos({ ...household, entries: [...household.entries, ...limitedRecurring] }))
const VIEWER = 'Mara S.'

/** The word a cadence reads as on a row, written here so the test does not borrow the app's formatter. */
const CADENCE_WORD: Record<string, string> = {
  weekly: 'Weekly',
  biweekly: 'Every 2 weeks',
  semi_monthly: 'Twice a month',
  monthly: 'Monthly',
  quarterly: 'Quarterly',
  annual: 'Annual',
  yearly: 'Annual',
}

/** Transactions, once its rows are listed. */
async function openTransactions(page: Page): Promise<void> {
  await mockHousehold(page, data)
  await page.goto('/transactions')
  await expect(page.locator('article[data-transaction-id]').first()).toBeVisible()
  await page.waitForLoadState('networkidle')
  await page.evaluate(() => document.fonts.ready)
}

async function openRecurring(page: Page): Promise<void> {
  await mockHousehold(page, data)
  await addRoutes(page, [queryRoute<PaginatedResponse<BudgetEntry>>('GET', '/budget-entries/', (q) => budgetEntriesFor(data, q))])
  await page.goto('/allocations?tab=recurring')
  await expect(page.locator('[data-testid^="kind-section-"] article').first()).toBeVisible()
  for (const e of limitedRecurring) await expect(page.getByText(e.display_name ?? '', { exact: true })).toBeVisible()
  await page.waitForLoadState('networkidle')
  await page.evaluate(() => document.fonts.ready)
}

const rowNamed = (page: Page, name: string): Locator =>
  page.locator('article[data-testid="row"]').filter({ has: page.locator('[data-row-title]', { hasText: name }) }).first()

/** Every `by <name>` on the page's rows, as a count of the attribution hook. */
const attributions = (page: Page): Locator => page.locator('article[data-testid="row"] [data-testid="created-by"]')

// ─── AC1 ────────────────────────────────────────────────────────────────────────────────────────

const TYPE_UNDER_HEADING = /Recurring (expense|income)/i
const SECTIONS_THAT_SAY_EXPENSE = ['subscription', 'installment', 'cash', 'bill'] as const

for (const key of SECTIONS_THAT_SAY_EXPENSE) {
  test(`kind is not repeated under its heading: ${key}`, async ({ page }) => {
    await openRecurring(page)
    const section = page.getByTestId(`kind-section-${key}`)
    const rows = section.locator('article[data-testid="row"]')
    const texts = await rows.evaluateAll((all) => all.map((r) => (r as HTMLElement).innerText))
    expect(texts.length, `rows under ${key}`).toBeGreaterThan(0)
    for (const text of texts) expect.soft(text, 'no row repeats its heading as a type').not.toMatch(TYPE_UNDER_HEADING)
    await section.scrollIntoViewIfNeeded()
    await shot(page, `kind-once-${key}`)
  })
}

test('kind is not repeated under its heading: a row whose kind differs from its group still shows it', async ({ page }) => {
  await openRecurring(page)
  const shared = page.getByTestId('kind-section-shared')
  for (const e of limitedRecurring) {
    const label = e.entry_type === 'income' ? 'Recurring income' : 'Recurring expense'
    const row = shared.locator('article[data-testid="row"]').filter({ has: page.getByText(e.display_name ?? '', { exact: true }) })
    expect.soft(await row.innerText(), `${e.display_name} keeps its kind`).toContain(label)
  }
  expect(await shared.getByText(TYPE_UNDER_HEADING).count(), 'every row in the shared section names its kind').toBe(limitedRecurring.length)
  await shared.scrollIntoViewIfNeeded()
  await shot(page, 'kind-differs-keeps-kind')
})

// ─── AC2 ────────────────────────────────────────────────────────────────────────────────────────

for (const e of data.entries) {
  const name = e.view === 'limited' ? e.display_name ?? '' : e.name
  test(`cadence appears once per row: ${name}`, async ({ page }) => {
    await openRecurring(page)
    const word = CADENCE_WORD[e.cadence]
    expect(word, `a cadence word for ${e.cadence}`).toBeTruthy()
    const row = rowNamed(page, name)
    await expect(row).toBeVisible()
    const meta = (await row.getByTestId('row-meta').evaluateAll((all) => all.map((m) => (m as HTMLElement).innerText))).join(' ')
    expect(meta.match(new RegExp(word, 'gi'))?.length ?? 0, `${name}: "${word}" in its meta`).toBe(1)
    await row.scrollIntoViewIfNeeded()
    await shot(page, `cadence-once-${e.id}`)
  })
}

// ─── AC3 ────────────────────────────────────────────────────────────────────────────────────────

/** Whether a record shows "by": the creator is not the viewer, or the account is shared (from the fixture, not the app). */
const showsBy = (createdBy: string | null, accountIds: (number | null | undefined)[]): boolean =>
  createdBy !== null && (createdBy !== VIEWER || accountIds.some((id) => id != null && SHARED_ACCOUNT_IDS.includes(id)))

const TX_COMBOS = [
  { combo: 'same creator, personal account', description: 'Grab to Makati', by: null },
  { combo: 'same creator, shared account', description: 'Yaya salary, Feb 16–28', by: 'by Mara S.' },
  { combo: 'different creator, shared account', description: 'Palengke, Marikina market', by: 'by Jun R.' },
  { combo: 'different creator, personal account', description: CREATOR_COMBOS.transaction, by: 'by Jun R.' },
] as const

const ENTRY_COMBOS = [
  { combo: 'same creator, personal account', name: 'Rent', by: null },
  { combo: 'same creator, shared account', name: 'Palengke run', by: 'by Mara S.' },
  { combo: 'different creator, shared account', name: limitedRecurring[0].display_name ?? '', by: 'by Jun R.' },
  { combo: 'different creator, personal account', name: CREATOR_COMBOS.entry, by: 'by Jun R.' },
] as const

for (const c of TX_COMBOS) {
  test(`by follows creator and sharing rules: Transactions, ${c.combo}`, async ({ page }) => {
    await openTransactions(page)
    const row = rowNamed(page, c.description)
    await expect(row).toBeVisible()
    const by = row.getByTestId('created-by')
    if (c.by) await expect(by, `${c.description} names its creator`).toHaveText(c.by)
    else await expect(by, `${c.description} has no attribution`).toHaveCount(0)
    expect.soft(await row.innerText(), `${c.description}: attribution text`).toMatch(c.by ? new RegExp(c.by) : /^(?![\s\S]*\bby [A-Z])/)
    await row.scrollIntoViewIfNeeded()
    await shot(page, `by-transactions-${c.by ? 'shown' : 'none'}-${TX_COMBOS.indexOf(c)}`)
  })
}

for (const c of ENTRY_COMBOS) {
  test(`by follows creator and sharing rules: Allocations, ${c.combo}`, async ({ page }) => {
    await openRecurring(page)
    const row = rowNamed(page, c.name)
    await expect(row).toBeVisible()
    const by = row.getByTestId('created-by')
    if (c.by) await expect(by, `${c.name} names its creator`).toHaveText(c.by)
    else await expect(by, `${c.name} has no attribution`).toHaveCount(0)
    expect.soft(await row.innerText(), `${c.name}: attribution text`).toMatch(c.by ? new RegExp(c.by) : /^(?![\s\S]*\bby [A-Z])/)
    await row.scrollIntoViewIfNeeded()
    await shot(page, `by-allocations-${c.by ? 'shown' : 'none'}-${ENTRY_COMBOS.indexOf(c)}`)
  })
}

test('by follows creator and sharing rules: every Transactions row', async ({ page }) => {
  await openTransactions(page)
  const month = data.today.slice(0, 7)
  const want = data.transactions.filter((t) => t.view !== 'limited' && t.transaction_date.slice(0, 7) === month)
  const expected = want.filter(
    (t) => t.view !== 'limited' && showsBy(t.created_by, [t.account_id, t.transfer_from_account_id, t.transfer_to_account_id]),
  ).length
  expect(await attributions(page).count(), 'rows that name their creator, from the fixture').toBe(expected)
  expect(expected, 'the fixture has rows with and without attribution').toBeGreaterThan(0)
  expect(expected, 'and rows without').toBeLessThan(want.length)
  await shot(page, 'by-transactions-all')
})

test('by follows creator and sharing rules: every Recurring row', async ({ page }) => {
  await openRecurring(page)
  const expected = data.entries.filter((e) => (e.view === 'limited' ? e.created_by !== null : showsBy(e.created_by, [e.account_id, e.transfer_to_account_id]))).length
  expect(await attributions(page).count(), 'rows that name their creator, from the fixture').toBe(expected)
  expect(expected, 'the fixture has rows with and without attribution').toBeLessThan(data.entries.length)
  await shot(page, 'by-allocations-all')
})

// ─── AC4 ────────────────────────────────────────────────────────────────────────────────────────

interface MetaItem {
  text: string
  background: string
  radius: string
  tag: boolean
}
interface RowMeta {
  name: string
  lines: MetaItem[][]
}

/**
 * Each row's meta items, line by line. A line's items are the facts in it: its own spans, or the spans of the one
 * paragraph that holds them. The row's status word (`data-status`) is the row's state, not a fact, and a tag chip is a tag.
 */
const metaOf = (rows: Locator): Promise<RowMeta[]> =>
  rows.evaluateAll((all) =>
    all.map((row) => ({
      name: (row.querySelector('[data-row-title]')?.textContent ?? '').trim(),
      lines: [...row.querySelectorAll('[data-testid="row-meta"]')].map((line) =>
        [...line.children]
          .flatMap((c) => (c.tagName === 'P' ? [...c.children] : [c]))
          .filter((c) => !c.matches('[data-status]'))
          .map((c) => {
            const s = getComputedStyle(c)
            return { text: (c as HTMLElement).innerText.trim(), background: s.backgroundColor, radius: s.borderTopLeftRadius, tag: c.matches('[data-testid="tag-chip"]') }
          }),
      ),
    })),
  )

for (const surface of ['transactions', 'recurring'] as const) {
  test(`meta is plain text and tags are chips: ${surface}`, async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop', 'the desktop layout')
    if (surface === 'transactions') await openTransactions(page)
    else await openRecurring(page)
    const rows = await metaOf(page.locator('main').getByTestId('list-sheet').locator('article[data-testid="row"]'))
    expect(rows.length, `${surface} rows`).toBeGreaterThan(5)
    for (const r of rows) {
      for (const [i, all] of r.lines.entries()) {
        const line = all.filter((item) => !item.tag)
        expect.soft(line.length, `${r.name}: meta line ${i + 1} holds at most 3 items`).toBeLessThanOrEqual(3)
        for (const item of line) {
          expect.soft([item.background, item.radius], `${r.name}: "${item.text}" is plain text`).toEqual([TRANSPARENT, '0px'])
        }
      }
    }
    const chips = await page.locator('main').getByTestId('tag-chip').evaluateAll((all) =>
      all.map((c) => ({ background: getComputedStyle(c).backgroundColor, radius: getComputedStyle(c).borderTopLeftRadius, plain: c.classList.contains('bg-sunken') })),
    )
    expect(chips.length, `${surface} rows carry tag chips`).toBeGreaterThan(0)
    for (const chip of chips) expect.soft(chip.radius, 'a tag chip has the 4px chip radius').toBe(RADIUS_SM)
    for (const chip of chips.filter((c) => c.plain)) expect.soft(chip.background, 'a tag chip without a swatch has the chip background').toBe(SUNKEN)
    await shot(page, `plain-meta-${surface}`)
  })
}

// ─── AC5 ────────────────────────────────────────────────────────────────────────────────────────

for (const e of data.entries) {
  const name = e.view === 'limited' ? e.display_name ?? '' : e.name
  test(`rows do not wrap their amount at 390: ${name}`, async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'phone', 'the 390px layout')
    await openRecurring(page)
    const row = rowNamed(page, name)
    await expect(row).toBeVisible()
    // A limited entry has no opener, so its facts wrap onto a line of their own by design (STU-681: every fact stays
    // readable); its first meta line is measured, and the no-taller guard below holds its whole height. Every other
    // row cuts its meta to the one line, so all of its meta lines together are measured.
    const limited = e.view === 'limited'
    const m = await row.evaluate((r, onlyFirst) => ({
      amount: (r.querySelector('[data-testid="row-amount"]') as HTMLElement).getBoundingClientRect().height,
      meta: [...r.querySelectorAll('[data-testid="row-meta"]')]
        .filter((m) => m.querySelector('button') === null)
        .slice(0, onlyFirst ? 1 : undefined)
        .reduce((h, m) => h + m.getBoundingClientRect().height, 0),
      scroll: r.scrollWidth,
      client: r.clientWidth,
    }), limited)
    expect.soft(m.amount, `${name}: the amount is one line`).toBeLessThanOrEqual(28)
    expect.soft(m.meta, `${name}: the meta lines together (a line that holds a control is the row's action, not meta) are at most two lines`).toBeLessThanOrEqual(40)
    expect.soft(m.scroll, `${name}: no horizontal overflow`).toBeLessThanOrEqual(m.client)
    await row.scrollIntoViewIfNeeded()
    await shot(page, `rows-390-${e.id}`)
  })
}

// ─── AC6 ────────────────────────────────────────────────────────────────────────────────────────

const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b)
  return s[Math.floor(s.length / 2)]
}

for (const surface of ['transactions', 'recurring'] as const) {
  test(`trimmed rows reach the ruled pitch: ${surface}`, async ({ page }, testInfo) => {
    if (surface === 'transactions') await openTransactions(page)
    else await openRecurring(page)
    const heights = await page
      .locator('main')
      .getByTestId('list-sheet')
      .locator('article[data-testid="row"]')
      .evaluateAll((all) => all.map((r) => r.getBoundingClientRect().height - parseFloat(getComputedStyle(r).borderBottomWidth)))
    expect(heights.length, `${surface} rows`).toBeGreaterThan(5)
    expect(median(heights), `median ${surface} row height`).toBeCloseTo(PITCH[testInfo.project.name], 0)
    await shot(page, `pitch-${surface}`)
  })
}


// ─── No row is taller than it was before this change ────────────────────────────────────────────

/** Each row's height (px, box) at `0f24527`, as the AC6 appearance baseline recorded it: by project key, then title, in list order. */
const BEFORE = JSON.parse(fs.readFileSync(fileURLToPath(new URL('./row-content.heights.json', import.meta.url)), 'utf8')) as Record<string, Record<string, number[]>>

/** The datasets the baseline was recorded on. */
const recordedRecurring = { ...withStatusStates(household), entries: [...withStatusStates(household).entries, ...limitedRecurring] }
const recordedTransactions = withTagOverflow(withStatusStates(household))

for (const surface of ['recurring', 'transactions'] as const) {
  test(`trimmed rows reach the ruled pitch: no ${surface} row is taller than before`, async ({ page }, testInfo) => {
    const set = surface === 'recurring' ? recordedRecurring : recordedTransactions
    await mockHousehold(page, set)
    await addRoutes(page, [queryRoute<PaginatedResponse<BudgetEntry>>('GET', '/budget-entries/', (q) => budgetEntriesFor(set, q))])
    await page.goto(surface === 'recurring' ? '/allocations?tab=recurring' : '/transactions')
    const rows = surface === 'recurring' ? page.locator('[data-testid^="kind-section-"]').getByTestId('row') : page.locator('article[data-transaction-id]')
    await expect(rows.first()).toBeVisible()
    await page.waitForLoadState('networkidle')
    await page.evaluate(() => document.fonts.ready)
    const now = await rows.evaluateAll((all) => all.map((r) => ({ name: (r.querySelector('[data-row-title]')?.textContent ?? '').trim(), h: r.getBoundingClientRect().height })))
    const before = BEFORE[surface === 'recurring' ? testInfo.project.name : `transactions:${testInfo.project.name}`]
    const seen: Record<string, number> = {}
    const taller: string[] = []
    for (const r of now) {
      const i = (seen[r.name] = (seen[r.name] ?? -1) + 1)
      const was = before[r.name]?.[i]
      expect.soft(was, `${r.name} is in the recorded heights`).toBeDefined()
      if (was !== undefined && r.h > was + 1) taller.push(`${r.name}: ${was}px -> ${r.h}px`)
    }
    expect(now.length, `${surface} rows`).toBe(Object.values(before).flat().length)
    expect(taller, `${surface} rows taller than at 0f24527`).toEqual([])
    await shot(page, `no-taller-${surface}`)
  })
}
