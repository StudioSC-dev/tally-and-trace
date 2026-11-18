// STU-677: sentence-case labels, plain counts and no template chrome. The API is faked in the browser with the shared
// household fixture (`allUpcomingHousehold` where a count has to reach two digits); there is no backend.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test } from '@playwright/test'
import type { Locator, Page } from '@playwright/test'
import { mockApi } from './support/mockApi'
import { shot } from './support/shot'
import { allUpcomingHousehold, household, mockHousehold } from './support/fixtures/household'
import type { HouseholdData } from './support/fixtures/household'

// This spec lives in <repo>/frontend/e2e.
const FRONTEND = fileURLToPath(new URL('..', import.meta.url))
const SRC = path.join(FRONTEND, 'src')

/** `muted` in the light theme (docs/design-system.md, Palette): #4A5950 as getComputedStyle reports it. */
const MUTED = 'rgb(74, 89, 80)'
/** The one date form the lists print, e.g. "Mar 12th, 2026". */
const DATE = /[A-Z][a-z]{2} \d{1,2}(?:st|nd|rd|th), \d{4}/g

async function open(page: Page, route: string, data: HouseholdData = household): Promise<void> {
  await mockHousehold(page, data)
  await page.goto(route)
  await expect(page.locator('main h1').first()).toBeVisible()
  await page.waitForLoadState('networkidle')
}

/** A viewport screenshot saved under shot()'s naming, for the dialogs (`position: fixed`). */
async function viewportShot(page: Page, name: string): Promise<void> {
  const info = test.info()
  const file = path.join(info.project.outputDir, 'screens', `labels-${name}-${info.project.name}.png`)
  await page.screenshot({ path: file, animations: 'disabled' })
}

/** The overlay of the open dialog (the shared `fixed inset-0` scrim around it). */
const overlay = (page: Page): Locator => page.locator('.fixed.inset-0.overflow-y-auto').last()
/** The first meta line of the list row titled `name` (the `Row` hooks from STU-681). */
const metaOf = (page: Page, name: string): Locator =>
  page.getByTestId('row').filter({ has: page.locator('[data-row-title]', { hasText: new RegExp(`^${name}$`) }) }).first().getByTestId('row-meta').first()

async function openAddTransaction(page: Page): Promise<Locator> {
  await open(page, '/transactions')
  await page.getByRole('button', { name: 'Add transaction' }).first().click()
  await expect(overlay(page).getByText('Transaction type')).toBeVisible()
  return overlay(page)
}

async function openRecurringEntry(page: Page): Promise<Locator> {
  await open(page, '/allocations?tab=recurring')
  await page.getByRole('button', { name: 'Add recurring entry' }).click()
  await expect(overlay(page).getByRole('heading', { name: 'Add recurring entry' })).toBeVisible()
  return overlay(page)
}

interface LabelStyle {
  text: string
  transform: string
  spacing: string
  size: string
  weight: string
  family: string
  color: string
}

/** The visible `.label` elements under `scope`, with the computed style AC1 names. */
const labelsIn = (scope: Locator): Promise<LabelStyle[]> =>
  scope.evaluate((root) => {
    const visible = (e: Element): boolean => {
      const b = e.getBoundingClientRect()
      const s = getComputedStyle(e)
      return b.width > 0 && b.height > 0 && s.visibility !== 'hidden' && s.display !== 'none'
    }
    return [...root.querySelectorAll('.label')].filter(visible).map((e) => {
      const s = getComputedStyle(e)
      return {
        text: (e as HTMLElement).innerText.trim(),
        transform: s.textTransform,
        spacing: s.letterSpacing,
        size: s.fontSize,
        weight: s.fontWeight,
        family: s.fontFamily,
        color: s.color,
      }
    })
  })

/** Every visible element under `scope` (and `scope` itself) whose text is transformed to capitals, as "tag:text". */
const uppercaseIn = (scope: Locator): Promise<{ scanned: number; found: string[] }> =>
  scope.evaluate((root) => {
    const all = [root, ...root.querySelectorAll('*')].filter((e) => {
      const b = e.getBoundingClientRect()
      return b.width > 0 && b.height > 0 && getComputedStyle(e).visibility !== 'hidden'
    })
    const found = all.filter((e) => getComputedStyle(e).textTransform === 'uppercase').map((e) => `${e.tagName}:${(e as HTMLElement).innerText.slice(0, 40)}`)
    return { scanned: all.length, found }
  })

/** The small headings and term labels that used to be tracked capitals, in document order. Hidden ones are skipped. */
const captionsIn = (scope: Locator): Promise<string[]> =>
  scope.evaluate((root) =>
    [...root.querySelectorAll('h3, h4, dt, th, .label')]
      .filter((e) => e.getBoundingClientRect().width > 0)
      .map((e) => (e as HTMLElement).innerText.trim()),
  )

interface Surface {
  name: string
  route: string
  /** The `.label` texts the surface shows, held here as the sentence-case expectation. */
  labels: string[]
  /** The captions (`h3`, `h4`, `dt`, `th`, `.label`, `label`) it shows. */
  captions: string[]
}

const DASHBOARD: Surface = {
  name: 'dashboard',
  route: '/',
  // STU-688: the leading panel's figure label and period heading, then its In, Out and Net rows.
  labels: ['Available cash', 'Month to date'],
  captions: [
    'Available cash',
    'Month to date',
    'In',
    'Out',
    'Net',
    'Opening',
    'Trough',
    'Close (60d)',
    'Today',
    'Net worth',
    'Projected',
    'Available cash',
    'Also coming up',
  ],
}
const TRANSACTIONS: Surface = {
  name: 'transactions',
  route: '/transactions',
  labels: ['Search transactions'],
  captions: ['Search transactions'],
}
const ALLOCATIONS: Surface = { name: 'allocations', route: '/allocations?tab=recurring', labels: [], captions: [] }

const RECURRING_LABELS = [
  'Name',
  'Entry type',
  'Account',
  'Category',
  'Overflow account (optional)',
  'Transfer to (optional)',
  'Currency',
  'Amount (PHP)',
  'Cadence',
  'Next occurrence',
  'Day',
  'Lead time (days)',
  'Link to budget (optional)',
  'Ends',
  'Tags (optional)',
  'Notes',
]
const SIGN_UP_LABELS = ['First name', 'Last name', 'Email address', 'Default currency', 'Password', 'Confirm password']

const ADD_TRANSACTION_LABELS = [
  'Description',
  'Account',
  'Category',
  'Transaction type',
  'Amount',
  'Transaction date',
  'Posting date (optional)',
  'Tags (optional)',
  'Recurring entry (optional)',
]

test.describe('Labels, counts and chrome (STU-677)', () => {
  for (const surface of [DASHBOARD, TRANSACTIONS, ALLOCATIONS]) {
    test(`labels are sentence case: ${surface.name}`, async ({ page }) => {
      await open(page, surface.route)
      const main = page.locator('main')
      const labels = await labelsIn(main)
      expect.soft(labels.map((l) => l.text), `${surface.name} .label texts`).toEqual(surface.labels)
      for (const l of labels) {
        expect.soft(l.transform, `"${l.text}" text-transform`).toBe('none')
        expect.soft(['normal', '0px'], `"${l.text}" letter-spacing ${l.spacing}`).toContain(l.spacing)
        expect.soft(l.size, `"${l.text}" font-size`).toBe('13px')
        expect.soft(l.weight, `"${l.text}" font-weight`).toBe('500')
        expect.soft(l.family.startsWith('"IBM Plex Sans"'), `"${l.text}" font-family ${l.family}`).toBe(true)
        expect.soft(l.color, `"${l.text}" colour is muted`).toBe(MUTED)
      }
      expect.soft(await captionsIn(main), `${surface.name} captions read in sentence case`).toEqual(surface.captions)
      const caps = await uppercaseIn(main)
      expect.soft(caps.scanned, 'the scan saw the page').toBeGreaterThan(50)
      expect.soft(caps.found, `${surface.name}: nothing in main is uppercase`).toEqual([])
      await shot(page, `labels-${surface.name}`)
    })
  }

  test('labels are sentence case: add transaction dialog', async ({ page }) => {
    const dialog = await openAddTransaction(page)
    const labels = await labelsIn(dialog)
    expect.soft(labels.map((l) => l.text), 'the dialog .label texts').toEqual(ADD_TRANSACTION_LABELS.filter((t) => t !== 'Mark as posted'))
    for (const l of labels) {
      expect.soft(l.transform, `"${l.text}" text-transform`).toBe('none')
      expect.soft(['normal', '0px'], `"${l.text}" letter-spacing ${l.spacing}`).toContain(l.spacing)
      expect.soft(l.size, `"${l.text}" font-size`).toBe('13px')
      expect.soft(l.weight, `"${l.text}" font-weight`).toBe('500')
      expect.soft(l.family.startsWith('"IBM Plex Sans"'), `"${l.text}" font-family ${l.family}`).toBe(true)
      expect.soft(l.color, `"${l.text}" colour is muted`).toBe(MUTED)
    }
    const caps = await uppercaseIn(dialog)
    expect.soft(caps.scanned, 'the scan saw the dialog').toBeGreaterThan(20)
    expect.soft(caps.found, 'nothing in the dialog is uppercase').toEqual([])
    await viewportShot(page, 'labels-add-transaction')
  })

  // The budget and savings forms of Allocations: every `<label>` reads in sentence case, as held here.
  const ALLOCATION_FORMS: { name: string; tab: string; mode?: string; labels: string[] }[] = [
    { name: 'budget form', tab: 'budgets', labels: ['Account', 'Name', 'Description', 'Tracked categories', 'Budget cadence', 'Period start', 'Period end (optional)', 'Amount already spent', 'Spending limit'] },
    { name: 'savings form', tab: 'savings', labels: ['Account', 'Name', 'Description', 'Tracking mode', 'Current amount', 'Target amount (optional)', 'Monthly target', 'Target date'] },
    { name: 'savings form, combined account total', tab: 'savings', mode: 'Combined account total', labels: ['Account', 'Name', 'Description', 'Tracking mode', 'Accounts to aggregate', 'Current amount', 'Target amount (optional)', 'Monthly target', 'Target date'] },
  ]
  for (const form of ALLOCATION_FORMS) {
    test(`labels are sentence case: allocations ${form.name}`, async ({ page }) => {
      await open(page, `/allocations?tab=${form.tab}`)
      await page.getByRole('button', { name: 'Add allocation' }).click()
      const dialog = overlay(page)
      await expect(dialog.getByRole('heading', { name: /^Create / })).toBeVisible()
      if (form.mode) await dialog.getByRole('button', { name: form.mode }).click()
      const labels = await dialog.locator('label').evaluateAll((els) => els.filter((e) => e.getBoundingClientRect().width > 0).map((e) => (e as HTMLElement).innerText.trim()))
      expect.soft(labels, `the ${form.name} label texts`).toEqual(form.labels)
      const caps = await uppercaseIn(dialog)
      expect.soft(caps.scanned, 'the scan saw the form').toBeGreaterThan(20)
      expect.soft(caps.found, 'nothing in the form is uppercase').toEqual([])
      await viewportShot(page, `labels-allocations-${form.name.replace(/[ ,]+/g, '-')}`)
    })
  }

  // Forms outside the four AC1 surfaces: every visible `<label>` reads in sentence case, as held here.
  const visibleLabels = (scope: Locator): Promise<string[]> =>
    scope.locator('label').evaluateAll((els) => els.filter((e) => e.getBoundingClientRect().width > 0).map((e) => (e as HTMLElement).innerText.trim()))

  test('labels are sentence case: sign-up form', async ({ page }) => {
    await mockApi(page, [])
    await page.goto('/register')
    await expect(page.getByLabel('First name')).toBeVisible()
    expect.soft(await visibleLabels(page.locator('main, form').first()), 'the sign-up label texts').toEqual(SIGN_UP_LABELS)
    await shot(page, 'labels-sign-up')
  })

  test('labels are sentence case: sign-in form', async ({ page }) => {
    await mockApi(page, [])
    await page.goto('/login')
    await expect(page.getByLabel('Email address')).toBeVisible()
    expect.soft(await visibleLabels(page.locator('form').first()), 'the sign-in label texts').toEqual(['Email address', 'Password', 'Remember me'])
    await shot(page, 'labels-sign-in')
  })

  const ACCOUNT_FORMS: { name: string; type: string | null; labels: string[] }[] = [
    { name: 'default', type: null, labels: ['Account name', 'Account type', 'Spending wallet', 'Account currency', 'Initial balance', 'Tags (optional)', 'Description (optional)'] },
    { name: 'credit card', type: 'credit', labels: ['Account name', 'Account type', 'Account currency', 'Initial balance', 'Tags (optional)', 'Description (optional)', 'Credit limit', 'Shares credit limit with', 'Due date (day of month)', 'Statement closes (day of month)', 'Days until due date', 'Paid from', 'Overflow to', 'Minimum due rule'] },
    { name: 'loan', type: 'loan', labels: ['Account name', 'Account type', 'Account currency', 'Initial balance', 'Tags (optional)', 'Description (optional)', 'Kind', 'Annual rate (%)', 'Term (months)', 'Payment amount', 'First payment date', 'Amortization', 'Payments already made', 'Paid from'] },
  ]
  for (const form of ACCOUNT_FORMS) {
    test(`labels are sentence case: add account form (${form.name})`, async ({ page }) => {
      await open(page, '/accounts')
      await page.getByRole('button', { name: 'Add account', exact: true }).click()
      const dialog = overlay(page)
      await expect(dialog.getByText('Account name')).toBeVisible()
      if (form.type) await dialog.locator('select').first().selectOption(form.type)
      if (form.type === 'credit') await dialog.getByRole('button', { name: 'Show details' }).click()
      expect.soft(await visibleLabels(dialog), `the ${form.name} account form label texts`).toEqual(form.labels)
      const caps = await uppercaseIn(dialog)
      expect.soft(caps.found, 'nothing in the form is uppercase').toEqual([])
      await viewportShot(page, `labels-account-${form.name.replace(/ /g, '-')}`)
    })
  }

  test('labels are sentence case: recurring entry form', async ({ page }) => {
    const dialog = await openRecurringEntry(page)
    expect.soft(await visibleLabels(dialog), 'the recurring entry label texts').toEqual(RECURRING_LABELS)
    await viewportShot(page, 'labels-recurring-entry')
  })

  test('counts read as numbers', async ({ page }) => {
    await open(page, '/transactions', allUpcomingHousehold)
    const ids = ['due-count', 'due-not-posted-count', 'due-upcoming-count', 'due-subscriptions-count', 'due-installments-count']
    for (const id of ids) {
      const badge = page.getByTestId(id)
      await expect.soft(badge, `${id} is on the page`).toBeVisible()
      expect.soft(['normal', '0px'], `${id} letter-spacing ${await badge.evaluate((e) => getComputedStyle(e).letterSpacing)}`).toContain(await badge.evaluate((e) => getComputedStyle(e).letterSpacing))
      expect.soft(await badge.evaluate((e) => getComputedStyle(e).backgroundColor), `${id} has no fill`).toBe('rgba(0, 0, 0, 0)')
      expect.soft(await badge.evaluate((e) => getComputedStyle(e).fontVariantNumeric), `${id} figures`).toContain('tabular-nums')
      expect.soft(await badge.evaluate((e) => getComputedStyle(e).fontSize), `${id} font-size`).toBe('12px')
      expect.soft(await badge.evaluate((e) => getComputedStyle(e).color), `${id} colour is muted`).toBe(MUTED)
    }
    const textWidth = (badge: Locator): Promise<number> =>
      badge.evaluate((e) => {
        const range = document.createRange()
        range.selectNodeContents(e)
        return range.getBoundingClientRect().width
      })
    const two = page.getByTestId('due-upcoming-count')
    await expect.soft(two, 'the upcoming count is 18').toHaveText('18')
    const one = page.getByTestId('due-count')
    await expect.soft(one, 'the due count is one digit').toHaveText('2')
    const ratio = (await textWidth(two)) / (await textWidth(one))
    expect.soft(ratio, `18 is ${ratio.toFixed(2)} times as wide as 2`).toBeGreaterThan(1.8)
    expect.soft(ratio, `18 is ${ratio.toFixed(2)} times as wide as 2`).toBeLessThan(2.2)
    await shot(page, 'counts')
  })

  test('period label is plain', async ({ page }) => {
    await open(page, '/')
    // STU-688: the period's totals moved to the leading panel, headed by the period itself.
    const heading = page.getByTestId('leading-figure').getByRole('heading', { name: /^Month to date$/i })
    await expect.soft(heading, 'one period heading').toHaveCount(1)
    expect.soft(await heading.innerText(), 'the period heading reads Month to date').toBe('Month to date')
    expect.soft(['normal', '0px'], 'heading letter-spacing').toContain(await heading.evaluate((e) => getComputedStyle(e).letterSpacing))
    expect.soft(await heading.evaluate((e) => getComputedStyle(e).textTransform), 'heading text-transform').toBe('none')
    await shot(page, 'period-label')
  })

  const chrome = /•|→| — /
  const chromeSurfaces: { name: string; text: (page: Page) => Promise<string>; anchor: string }[] = [
    { name: 'dashboard', anchor: 'Cash-flow timeline', text: async (p) => (await open(p, '/'), p.locator('main').innerText()) },
    { name: 'transactions', anchor: 'Date range:', text: async (p) => (await open(p, '/transactions'), p.locator('main').innerText()) },
    { name: 'allocations', anchor: 'Recurring expense', text: async (p) => (await open(p, '/allocations?tab=recurring'), p.locator('main').innerText()) },
    { name: 'add transaction dialog', anchor: 'Transaction type', text: async (p) => (await openAddTransaction(p)).innerText() },
    { name: 'recurring entry dialog', anchor: 'Add recurring entry', text: async (p) => (await openRecurringEntry(p)).innerText() },
    {
      // A credit-card account adds the Kind select, whose choices read "Automatic (Utilities to bill)".
      name: 'recurring entry dialog with a credit card selected',
      anchor: 'Automatic (Utilities to bill)',
      text: async (p) => {
        const dialog = await openRecurringEntry(p)
        await dialog.locator('select[data-field="account_id"]').selectOption({ label: 'HSBC Red Mastercard' })
        await expect(dialog.getByTestId('recurring-kind')).toBeVisible()
        return dialog.innerText()
      },
    },
  ]
  for (const surface of chromeSurfaces) {
    test(`no bullet, arrow or em-dash chrome: ${surface.name}`, async ({ page }) => {
      const text = await surface.text(page)
      expect.soft(text, `${surface.name} text was read`).toContain(surface.anchor)
      expect.soft(text.length, `${surface.name} text is not empty`).toBeGreaterThan(200)
      expect.soft(text.match(chrome)?.[0] ?? null, `${surface.name} has no bullet, arrow or em dash`).toBeNull()
      if (surface.name.includes('dialog')) await viewportShot(page, `chrome-${surface.name.replace(/ /g, '-')}`)
      else await shot(page, `chrome-${surface.name}`)
    })
  }

  test('date facts are preserved and links carry no arrow', async ({ page }) => {
    await open(page, '/transactions')
    const rows = page.locator('article[role="button"]')
    expect.soft(await rows.count(), 'the page lists its transactions').toBe(19)
    const texts = await rows.allInnerTexts()
    for (const text of texts) {
      const name = text.split('\n').find((l) => l.trim() !== '' && !DATE.test(l)) ?? text.slice(0, 20)
      DATE.lastIndex = 0
      expect.soft(text.match(DATE)?.length ?? 0, `"${name}" shows one date`).toBe(1)
      expect.soft(/\b(Today|Yesterday|Tomorrow)\b/i.test(text), `"${name}" has no relative-day label`).toBe(false)
    }
    // The row dated on the page's today keeps its date and drops the "Today" label.
    const today = page.locator('article[role="button"]', { hasText: 'Puregold weekly groceries' })
    expect.soft(await today.innerText(), 'the row dated today').toContain('Mar 12th, 2026')
    const range = page.getByText(/^Date range:/)
    expect.soft((await range.innerText()).replace(/\s+/g, ' '), 'the range keeps both endpoints').toBe('Date range: Mar 1st, 2026 to Mar 31st, 2026')
    await shot(page, 'date-facts')

    await open(page, '/')
    const details = page.getByRole('link', { name: 'Details', exact: true })
    await expect.soft(details, 'the Cash-flow card has one Details link').toHaveCount(1)
    expect.soft((await details.innerText()).trim(), 'the link reads Details').toBe('Details')
    expect.soft(await details.getAttribute('href'), 'the link goes to the forecast').toBe('/forecast')
    await shot(page, 'details-link')
  })

  test('no tracked-capital utilities remain in source', async ({ page }) => {
    const files: string[] = []
    const walk = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name)
        if (entry.isDirectory()) walk(full)
        else if (entry.name.endsWith('.tsx')) files.push(full)
      }
    }
    walk(SRC)
    expect.soft(files.length, 'the source tree was read').toBeGreaterThan(40)
    const found: string[] = []
    for (const file of files) {
      fs.readFileSync(file, 'utf8')
        .split('\n')
        .forEach((line, i) => {
          // "One uppercase letter" is the password rule's wording in SignupForm, not a class.
          if (line.trim() === 'One uppercase letter') return
          if (/(?<![\w-])(uppercase|tracking-wide)(?![\w-])/.test(line)) found.push(`${path.relative(SRC, file)}:${i + 1}`)
        })
    }
    expect.soft(found, 'no uppercase or tracking-wide class token in any .tsx').toEqual([])
    const css = fs.readFileSync(path.join(SRC, 'assets', 'index.css'), 'utf8')
    expect.soft(css.match(/\.(uppercase|tracking-wide)\b/)?.[0] ?? null, 'no shim restyles those utilities in the CSS').toBeNull()
    await open(page, '/transactions')
    await shot(page, 'source-scan')
  })

  test('meta strings use layout', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'phone', 'the 390px layout')
    await open(page, '/allocations?tab=recurring')
    const meta = metaOf(page, 'Netflix Standard')
    await expect.soft(meta, 'the line under the name').toBeVisible()
    expect.soft(await meta.locator(':scope > *').count(), 'the meta line is separate elements').toBeGreaterThan(1)
    expect.soft(await meta.innerText(), 'the meta line has no bullet').not.toContain('•')
    const boxes = await meta.locator(':scope > *').evaluateAll((els) => els.map((e) => e.getBoundingClientRect()).map((r) => ({ x: r.x, y: r.y, right: r.right, bottom: r.bottom })))
    expect.soft(boxes.length, 'at least three facts: kind, cadence, settlement').toBeGreaterThanOrEqual(3)
    expect.soft(await meta.locator(':scope > *').evaluateAll((els) => els.slice(0, 3).map((e) => (e as HTMLElement).innerText)), 'kind, cadence and settlement lead the line').toEqual(['Recurring expense', 'Monthly · day 9', 'Scheduled'])
    // Each fact sits on its own box: a gap of 8px or more beside the one before it, or on the line below it.
    boxes.slice(1).forEach((b, i) => {
      const before = boxes[i]
      const sameLine = b.y < before.bottom
      expect.soft(sameLine ? b.x - before.right : b.y - before.bottom, `fact ${i + 2} is set apart from fact ${i + 1}`).toBeGreaterThanOrEqual(sameLine ? 8 : 0)
    })
    await shot(page, 'meta-layout')
  })

  test('chrome cleanup preserves facts and actions', async ({ page }) => {
    // Allocations: each recurring entry's meta line keeps its kind, cadence and settlement.
    await open(page, '/allocations?tab=recurring')
    const entries: [string, string[]][] = [
      ['Netflix Standard', ['Recurring expense', 'Monthly · day 9', 'Scheduled']],
      ['Rent', ['Recurring expense', 'Monthly · day 1', 'Manual']],
      ['PLDT Fibr', ['Recurring expense', 'Monthly · day 6', 'Auto-pay']],
    ]
    for (const [name, facts] of entries) {
      const meta = await metaOf(page, name).innerText()
      for (const fact of facts) expect.soft(meta, `${name} keeps "${fact}"`).toContain(fact)
    }
    await expect.soft(page.getByText('Recurring income').first(), 'an income entry keeps its kind').toBeVisible()
    await shot(page, 'facts-allocations')

    // Transactions: a transfer row keeps both accounts, its category and who entered it; the range keeps both ends.
    await open(page, '/transactions')
    const transfer = await page.locator('article[role="button"]', { hasText: 'Move to emergency fund' }).innerText()
    for (const fact of ['BPI Payroll', 'Metrobank Savings', 'Savings transfer', 'by Mara S.', 'Transfer', 'Mar 8th, 2026']) {
      expect.soft(transfer, `the transfer row keeps "${fact}"`).toContain(fact)
    }
    const dinner = await page.locator('article[role="button"]', { hasText: 'Dinner, Manam' }).innerText()
    for (const fact of ['HSBC Red Mastercard', 'Dining out', 'by Mara S.', 'Japan trip', 'Mar 7th, 2026']) {
      expect.soft(dinner, `the tagged row keeps "${fact}"`).toContain(fact)
    }
    await shot(page, 'facts-transactions')

    // The row action still opens the action dialog and then the edit form for the same transaction.
    await page.getByText('Grab to Makati').click()
    await expect.soft(overlay(page).getByText('Transaction actions'), 'a row opens its action dialog').toBeVisible()
    await expect.soft(overlay(page).getByText('Grab to Makati'), 'the dialog is for that row').toBeVisible()
    await overlay(page).getByRole('button', { name: 'Edit transaction' }).click()
    await expect.soft(overlay(page).getByRole('heading', { name: 'Edit transaction' }), 'Edit opens the edit form').toBeVisible()
    await expect.soft(overlay(page).getByTestId('transaction-date'), 'the form holds that row date').toHaveValue('2026-03-11')
    expect.soft(await overlay(page).locator('input').evaluateAll((els) => els.map((e) => (e as HTMLInputElement).value)), 'the form holds that row description').toContain('Grab to Makati')
    await viewportShot(page, 'facts-row-action')

    // The Add transaction dialog's recurring-entry choices keep each entry's name, cadence and amount.
    const dialog = await openAddTransaction(page)
    const options = await dialog.locator('select option').allInnerTexts()
    for (const [name, cadence, amount] of [['Rent', 'Monthly', '₱22,000.00'], ['Palengke run', 'Weekly', '₱1,300.00'], ['Yaya salary', 'Twice a month', '₱4,500.00']]) {
      const option = options.find((o) => o.startsWith(name)) ?? ''
      expect.soft(option, `${name}'s choice keeps its cadence and amount`).toContain(`${cadence}, ${amount}`)
    }
    await viewportShot(page, 'facts-add-transaction')

    // The recurring-entry dialog keeps its fields under their sentence-case names.
    const recurring = await openRecurringEntry(page)
    for (const label of ['Name', 'Entry type', 'Account', 'Next occurrence', 'Lead time (days)']) {
      await expect.soft(recurring.locator('label', { hasText: new RegExp(`^${label.replace(/[()]/g, '\\$&')}$`) }), `the dialog has "${label}"`).toHaveCount(1)
    }
    await viewportShot(page, 'facts-recurring')

    // The Cash-flow card's Details link goes to the forecast page.
    await open(page, '/')
    await page.getByRole('link', { name: 'Details', exact: true }).click()
    await expect.soft(page, 'Details opens the forecast').toHaveURL(/\/forecast$/)
    await expect.soft(page.getByRole('heading', { level: 1, name: 'Cash-flow timeline' }), 'the forecast page shows').toBeVisible()
    await shot(page, 'facts-details')
  })

  test('chrome cleanup preserves facts and actions: dashboard', async ({ page }) => {
    // Every dashboard meta line, with the fixture-backed facts it showed at the PR base (c1910fd).
    await open(page, '/')
    const cashflow = page.locator('[data-onboarding="cashflow-timeline"]')
    const snapshot = page.locator('[data-onboarding="financial-snapshot"]')
    const leading = page.getByTestId('leading-figure')
    const tile = (name: string): Locator => page.getByTestId('quick-balance-tile').filter({ has: page.getByTestId('quick-balance-name').getByText(name, { exact: true }) })
    const payable = (name: string): Locator => page.getByTestId('payable-row').filter({ has: page.getByText(name, { exact: true }) })
    const upcoming = (index: number): Locator => page.getByTestId('other-upcoming-row').nth(index)
    const lines: [string, Locator, string[]][] = [
      ['the Cash-flow subtitle', cashflow, ['next 60 days', 'before payday', 'month-end']],
      ['the Cash-flow figures', cashflow, ['Opening', '₱84,250.40', 'Trough', '₱71,769.85', 'Close (60d)', '₱106,040.10', 'Mar 13, 2026']],
      ['the BPI Payroll quick balance', tile('BPI Payroll'), ['Debit', 'BPI Payroll', '₱84,250.40']],
      ['the HSBC quick balance', tile('HSBC Red Mastercard'), ['Credit', 'HSBC Red Mastercard', 'Owed', '₱18,742.30']],
      ['the GCash quick balance', tile('GCash'), ['E-wallet', 'GCash', '₱3,415.75']],
      // STU-688: the period totals sit under the leading figure as In, Out and Net.
      ['the period totals', leading, ['Available cash', '₱343,230.90', 'Month to date', 'In', '₱33,500.00', 'Out', '₱51,821.20', 'Net', '−₱18,321.20']],
      ['the snapshot today and projection', snapshot, ['Today', 'Net worth', '₱329,764.35', 'Projected', 'Available cash', '₱343,230.90']],
      ['the Emergency fund top-up payable', payable('Emergency fund top-up'), ['Mar 8th, 2026', '₱10,000.00', 'Scheduled', 'Manual', 'from BPI Payroll', 'Overdue']],
      ['the HMO dependent add-on payable', payable('HMO dependent add-on'), ['Mar 20th, 2026', '₱1,450.00', 'Scheduled', 'Manual', 'from BPI Payroll', '8 days remaining']],
      ['the Rent payable', payable('Rent'), ['Apr 1st, 2026', '₱22,000.00', 'Scheduled', 'Manual', 'from BPI Payroll', '20 days remaining']],
      ['the PLDT Fibr payable', payable('PLDT Fibr'), ['Apr 6th, 2026', '₱1,899.00', 'Scheduled', 'Autopay', 'from BPI Payroll', '25 days remaining']],
      ['the HSBC statement payable', payable('HSBC Red Mastercard statement'), ['Apr 9th, 2026', '₱6,261.75', 'Card statement', 'from BPI Payroll', '28 days remaining']],
      ['the Meralco payable', payable('Meralco'), ['Apr 10th, 2026', '₱4,600.00', 'Scheduled', 'Manual', 'from BPI Payroll', '29 days remaining']],
      ['the first Also coming up row', upcoming(0), ['Payroll', 'Mar 15th, 2026', 'Money in', 'Scheduled', '₱41,250.00']],
      ['the second Also coming up row', upcoming(1), ['Payroll', 'Mar 30th, 2026', 'Money in', 'Scheduled', '₱41,250.00']],
    ]
    for (const [what, scope, facts] of lines) {
      for (const fact of facts) await expect.soft(scope, `${what} keeps "${fact}"`).toContainText(fact)
    }
    await expect.soft(leading.getByRole('heading', { name: 'Month to date' }), 'the period heading keeps its period').toHaveText('Month to date')
    await expect.soft(page.getByTestId('payable-row'), 'every payable is still listed').toHaveCount(6)
    await expect.soft(page.getByTestId('other-upcoming-row'), 'both incoming payrolls are still listed').toHaveCount(2)
    await shot(page, 'facts-dashboard')
  })
})
