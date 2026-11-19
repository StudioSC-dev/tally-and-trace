// STU-690: one icon set. Every icon is a Phosphor Regular icon at 20px in `currentColor`, drawn by the one `Icon`
// component (frontend/src/components/Icon.tsx); no emoji and no text glyph stands in for an icon. The API is faked in
// the browser with the shared household fixture; there is no backend.
//
// AC7's text and names check compares each surface with `icons.baseline.json`, recorded once on the PR base, before
// the icons changed: `ICONS_RECORD=1 pnpm exec playwright test icons -g "icon replacement preserves existing
// behaviour: .* text and names" --workers=1`. A recording run only writes the baseline; it asserts nothing.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test } from '@playwright/test'
import type { Locator, Page } from '@playwright/test'
import type { Account, User } from '@tally-trace/shared'
import { addRoutes, apiRoute, mockApi } from './support/mockApi'
import type { ApiMock, ApiRoute } from './support/mockApi'
import { shot } from './support/shot'
import {
  createAccountRoute,
  createdAccount,
  household,
  householdCreateRoutes,
  householdDialogRoutes,
  householdRoutes,
  householdSaveRoutes,
  householdWishlistRoutes,
  householdWishlistWithLink,
  mockHousehold,
  newAccountInput,
  savedTransaction,
  withFxNotice,
  withShortfalls,
} from './support/fixtures/household'
import type { HouseholdData } from './support/fixtures/household'

// This spec lives in <repo>/frontend/e2e.
const FRONTEND = fileURLToPath(new URL('..', import.meta.url))
const SRC = path.join(FRONTEND, 'src')
const BASELINE = fileURLToPath(new URL('./icons.baseline.json', import.meta.url))
const RECORD = process.env.ICONS_RECORD === '1'

// The baseline holds clock-derived text, so every page runs in the time zone it was recorded in.
test.use({ timezoneId: 'Asia/Manila' })

/** AC1: any emoji, and the text glyphs that stood in for icons. */
const EMOJI = /\p{Extended_Pictographic}/u
const GLYPHS = ['⚠', '✕', '✓', '○', '→'] as const
/** Every character the change removed: AC1's glyphs plus the other glyph icons it replaced, and emoji. */
const REMOVED = /[\p{Extended_Pictographic}\u{FE0F}⚠✕✓○→×‹›▾▴↗]/gu
/** The charts draw their own SVG and are exempt (there is no Recharts in the app; `.recharts-surface` is kept). */
const CHART = 'svg.recharts-surface, svg[role="img"][aria-label^="Projected running balance"], svg[role="img"][aria-label="Spending by category"]'
/** Every open dialog; the last one in the document is on top. */
const DIALOG = '.fixed.inset-0.overflow-y-auto, [role="dialog"], [role="alertdialog"]'

/** A viewport screenshot (a full-page one draws a fixed layer at the scroll offset), saved like `shot()`. */
async function viewportShot(page: Page, name: string): Promise<string> {
  const info = test.info()
  const spec = path.basename(info.file).replace(/\.spec\.ts$/, '')
  const file = path.join(info.project.outputDir, 'screens', `${spec}-${name}-${info.project.name}.png`)
  await page.screenshot({ path: file, animations: 'disabled' })
  return file
}

const transitionsDone = (page: Page): Promise<unknown> =>
  page.evaluate(() => Promise.allSettled(document.getAnimations().filter((a) => a instanceof CSSTransition).map((a) => a.finished)))

async function settle(page: Page): Promise<void> {
  await page.waitForLoadState('networkidle')
  // A pointer left on a control would show its hover colour; park it off every control.
  await page.mouse.move(0, 400)
  await transitionsDone(page)
}

const dialogOf = (page: Page): Locator => page.locator(DIALOG).last()

/** The calls the pages' dialogs and saves make, beyond the household's page loads. */
const extraRoutes = (data: HouseholdData): ApiRoute[] => [
  ...householdCreateRoutes(data),
  ...householdDialogRoutes(data),
  ...householdSaveRoutes(data),
  ...householdWishlistRoutes(),
]

async function openPage(page: Page, route: string, heading: string, data: HouseholdData = household, extra: ApiRoute[] = []): Promise<ApiMock> {
  const api = await mockHousehold(page, data)
  await mockApi(page, [...extraRoutes(data), ...extra])
  await page.goto(route)
  await expect(page.getByRole('heading', { level: 1, name: heading })).toBeVisible({ timeout: 15_000 })
  await settle(page)
  return api
}

async function openDialog(page: Page, route: string, heading: string, trigger: (page: Page) => Locator, title: string | RegExp, extra: ApiRoute[] = []): Promise<ApiMock> {
  const api = await openPage(page, route, heading, household, extra)
  await trigger(page).click()
  await expect(dialogOf(page).getByRole('heading', { name: title }).first()).toBeVisible()
  await settle(page)
  return api
}

/** The sign-up page, signed out. No call is mocked: an API call fails the test. */
async function openSignUp(page: Page): Promise<ApiMock> {
  const api = await mockApi(page, [])
  await page.goto('/register')
  await expect(page.getByRole('heading', { name: 'Create your account' })).toBeVisible({ timeout: 15_000 })
  await settle(page)
  return api
}

/** Picks an account in the transaction form's compact picker, opening the folded field first when it is folded. */
async function pickAccount(page: Page, name: string): Promise<void> {
  const field = dialogOf(page).locator('[data-field="account_id"]')
  const chip = field.getByRole('button', { name: new RegExp(`^${name}`) })
  const change = field.locator('[data-picker-change][aria-expanded="false"]')
  await chip.or(change).first().waitFor()
  if ((await chip.count()) === 0) await change.click()
  await chip.first().click()
  await expect(field.locator('[data-picker-value]')).toContainText(name)
}

const ROW_TRANSACTION = 'Grab to Makati'
const transactionRow = (page: Page, description: string): Locator => page.locator('article[data-transaction-id]').filter({ hasText: description }).first()
const BUDGET = household.allocations.find((a) => a.allocation_type === 'budget')?.name ?? ''
const SAVINGS_ACCOUNT = household.accounts.find((a) => a.account_type === 'savings')?.name ?? ''
const QUICK_BALANCES = household.quickBalances.tiles.map((t) => t.name)
const formAccount: Account = createdAccount(household, 91, { ...newAccountInput, tag_ids: [...newAccountInput.tag_ids] })

/** A transaction the saved-toast state saves; the list re-reads with it. */
const SAVED = { ...household, transactions: [savedTransaction(household, 990, 'Icon check', 120, household.accounts[0].id), ...household.transactions] }

/** A page or a page state the rendered checks run on. `target` is the replaced icon the state exists to show. */
interface Surface {
  key: string
  /** One of AC1's six pages. */
  page: boolean
  open: (page: Page) => Promise<unknown>
  target: (page: Page) => Locator
}

const topBar = (page: Page): Locator => page.locator('nav.spine')
const tabBar = (page: Page): Locator => page.locator('nav.fixed.bottom-0')
/** The top bar's page links on desktop, the tab bar's on a phone: the navigation the project shows. */
const navIcons = (page: Page): Locator => page.locator('nav.spine a[data-onboarding] svg:visible, nav.fixed.bottom-0 a svg:visible')

const SURFACES: Surface[] = [
  { key: 'dashboard', page: true, open: (p) => openPage(p, '/', 'Dashboard'), target: (p) => p.getByTestId('payable-status').locator('svg') },
  { key: 'transactions', page: true, open: (p) => openPage(p, '/transactions', 'Transactions'), target: (p) => p.getByRole('button', { name: 'View previous month' }).locator('svg') },
  { key: 'allocations', page: true, open: (p) => openPage(p, '/allocations', 'Allocations'), target: navIcons },
  { key: 'accounts', page: true, open: (p) => openPage(p, '/accounts', 'Accounts'), target: navIcons },
  { key: 'settings', page: true, open: (p) => openPage(p, '/settings', 'Settings'), target: (p) => topBar(p).getByRole('button', { name: 'Toggle theme' }).locator('svg') },
  { key: 'sign-up', page: true, open: openSignUp, target: (p) => p.getByRole('button', { name: 'Show password' }).locator('svg') },
  {
    key: 'sign-up requirements',
    page: false,
    open: async (p) => {
      await openSignUp(p)
      // Lower case and a digit pass; length, upper case and a special character do not.
      await p.locator('#password').fill('abc1')
      await expect(p.getByText('Password requirements:')).toBeVisible()
      await settle(p)
    },
    target: (p) => p.locator('li svg[data-icon="check"], li svg[data-icon="requirement-unmet"]'),
  },
  {
    key: 'sign-up error',
    page: false,
    open: async (p) => {
      await openSignUp(p)
      await p.locator('#firstName').fill('Mara')
      await p.locator('#lastName').fill('Santos')
      await p.locator('#email').fill('mara@example.com')
      await p.locator('#password').fill('abc1')
      await p.locator('#confirmPassword').fill('abc1')
      await p.getByRole('button', { name: 'Create account' }).click()
      await expect(p.getByText('Password does not meet all requirements')).toBeVisible()
      await settle(p)
    },
    target: (p) => p.locator('svg[data-icon="error"]'),
  },
  {
    key: 'dashboard shortfall',
    page: false,
    open: (p) => openPage(p, '/', 'Dashboard', withShortfalls(household)),
    target: (p) => p.getByTestId('shortfall-banner').locator('svg').or(p.getByText(/funding shortfall/).locator('xpath=..').locator('svg[data-icon="warning"]')),
  },
  { key: 'dashboard fx notice', page: false, open: (p) => openPage(p, '/', 'Dashboard', withFxNotice(household)), target: (p) => p.getByTestId('unconverted-banner').locator('svg') },
  {
    key: 'quick balances editor',
    page: false,
    open: async (p) => {
      await openPage(p, '/', 'Dashboard')
      await p.getByTestId('quick-balances-edit').click()
      await expect(p.getByTestId('quick-balances-save')).toBeVisible()
      await settle(p)
    },
    target: (p) => p.getByTestId('quick-balance-edit-row').locator('svg'),
  },
  {
    key: 'user menu',
    page: false,
    open: async (p) => {
      await openPage(p, '/', 'Dashboard')
      await topBar(p).getByRole('button', { name: /MS/ }).click()
      await expect(p.getByRole('link', { name: 'Settings' })).toBeVisible()
      await settle(p)
    },
    target: (p) => topBar(p).locator('svg[data-icon="settings"], svg[data-icon="sign-out"]'),
  },
  {
    key: 'transaction filters',
    page: false,
    open: async (p) => {
      await openPage(p, '/transactions', 'Transactions')
      await p.getByRole('button', { name: 'Filters', exact: true }).click()
      await p.getByRole('group', { name: 'Entered by' }).getByRole('button', { name: 'Only mine' }).click()
      await p.getByRole('button', { name: /^All \d+ categories/ }).click()
      await expect(p.getByRole('button', { name: 'Remove the Only mine filter' })).toBeVisible()
      await settle(p)
    },
    target: (p) => p.getByRole('button', { name: 'Remove the Only mine filter' }).locator('svg').or(p.locator('[data-picker-toggle] svg')),
  },
  {
    key: 'transaction actions',
    page: false,
    open: (p) => openDialog(p, '/transactions', 'Transactions', (q) => transactionRow(q, ROW_TRANSACTION), 'Transaction actions'),
    target: (p) => dialogOf(p).locator('svg'),
  },
  {
    key: 'transaction create picker',
    page: false,
    open: async (p) => {
      await openDialog(p, '/transactions', 'Transactions', (q) => q.getByRole('button', { name: 'Add transaction', exact: true }).first(), 'Add transaction')
      await pickAccount(p, SAVINGS_ACCOUNT)
      // Open the picked field again: its panel marks the current value.
      await dialogOf(p).locator('[data-field="account_id"] [data-picker-change]').click()
      await expect(dialogOf(p).locator('[data-picker-check]')).toBeVisible()
      await settle(p)
    },
    target: (p) => dialogOf(p).locator('[data-picker-check] svg[data-icon="check"]').or(dialogOf(p).locator('svg[data-icon="info"]')),
  },
  {
    key: 'saved toast',
    page: false,
    open: async (p) => {
      await openDialog(p, '/transactions', 'Transactions', (q) => q.getByRole('button', { name: 'Add transaction', exact: true }).first(), 'Add transaction')
      await dialogOf(p).getByPlaceholder('Add notes about this transaction').fill('Icon check')
      await pickAccount(p, household.accounts[0].name)
      await dialogOf(p).locator('input[type="number"][placeholder="0.00"]').first().fill('120')
      await addRoutes(p, householdRoutes(SAVED))
      await dialogOf(p).getByRole('button', { name: 'Add transaction', exact: true }).click()
      await expect(p.getByTestId('save-toast-dismiss')).toBeVisible()
      await settle(p)
    },
    target: (p) => p.getByTestId('save-toast-dismiss').locator('svg'),
  },
  {
    key: 'spending breakdown',
    page: false,
    open: (p) => openDialog(p, '/transactions', 'Transactions', (q) => q.getByRole('button', { name: 'Spending breakdown' }), /Spending breakdown/i),
    target: (p) => p.getByRole('button', { name: 'Spending breakdown' }).locator('svg'),
  },
  {
    key: 'account create',
    page: false,
    open: async (p) => {
      await openDialog(p, '/accounts', 'Accounts', (q) => q.getByRole('button', { name: 'Add account', exact: true }), 'Create account', [createAccountRoute([formAccount])])
      await dialogOf(p).locator('select').first().selectOption('credit')
      await expect(dialogOf(p).getByRole('button', { name: 'Show details' })).toBeVisible()
      await settle(p)
    },
    target: (p) => dialogOf(p).getByRole('button', { name: 'Close account modal' }).locator('svg').or(dialogOf(p).getByRole('button', { name: 'Show details' }).locator('svg')),
  },
  {
    key: 'account actions',
    page: false,
    open: (p) => openDialog(p, '/accounts', 'Accounts', (q) => q.getByRole('button', { name: /BPI Payroll/ }).first(), /BPI Payroll/),
    target: (p) => dialogOf(p).locator('svg'),
  },
  {
    key: 'share account',
    page: false,
    open: async (p) => {
      await openDialog(p, '/accounts', 'Accounts', (q) => q.getByRole('button', { name: /BPI Payroll/ }).first(), /BPI Payroll/)
      await dialogOf(p).getByRole('button', { name: 'Share account' }).click()
      await p.getByRole('button', { name: 'Close account actions modal' }).click()
      await expect(p.getByTestId('share-email')).toBeVisible()
      await settle(p)
    },
    target: (p) => p.getByRole('button', { name: 'Close share dialog' }).locator('svg'),
  },
  {
    key: 'recurring create',
    page: false,
    open: (p) => openDialog(p, '/allocations', 'Allocations', (q) => q.getByRole('button', { name: 'Add recurring entry', exact: true }), 'Add recurring entry'),
    target: (p) => dialogOf(p).locator('svg[data-icon="close"], svg[data-icon="pause"]'),
  },
  {
    key: 'allocation create',
    page: false,
    open: (p) => openDialog(p, '/allocations?tab=budgets', 'Allocations', (q) => q.getByRole('button', { name: 'Add allocation', exact: true }), 'Create budget envelope'),
    target: (p) => dialogOf(p).locator('svg[data-icon="close"], svg[data-icon="pause"]'),
  },
  {
    key: 'allocation actions',
    page: false,
    open: (p) => openDialog(p, '/allocations?tab=budgets', 'Allocations', (q) => q.locator('main article.card').filter({ has: q.getByText(BUDGET, { exact: true }) }), BUDGET),
    target: (p) => dialogOf(p).locator('svg'),
  },
  {
    key: 'wishlist',
    page: false,
    open: async (p) => {
      await openPage(p, '/allocations?tab=wishlist', 'Allocations', household, householdWishlistRoutes(householdWishlistWithLink))
      await expect(p.getByText(householdWishlistWithLink[0].name, { exact: true })).toBeVisible()
      await settle(p)
    },
    target: (p) => p.getByRole('link', { name: 'Link' }).locator('svg').or(p.getByRole('button', { name: 'Mark as purchased' }).locator('svg')),
  },
  {
    key: 'wishlist item',
    page: false,
    open: (p) => openDialog(p, '/allocations?tab=wishlist', 'Allocations', (q) => q.getByRole('button', { name: 'Add item', exact: true }), 'Add item'),
    target: (p) => p.getByRole('button', { name: 'Close wishlist modal' }).locator('svg'),
  },
]

/** `innerText` of the body: the text a reader sees, without hidden elements. */
const bodyText = (page: Page): Promise<string> => page.locator('body').evaluate((b) => (b as HTMLElement).innerText)

/** Every visible button and link, by accessible name, in document order. */
const controlNames = (page: Page): Promise<string[]> =>
  page.locator('body').evaluate((root) =>
    Array.from(root.querySelectorAll('button, a'))
      .filter((e) => (e as HTMLElement).offsetParent !== null || getComputedStyle(e).position === 'fixed')
      .map((e) => (e.getAttribute('aria-label') ?? ((e.textContent ?? '').trim() || e.getAttribute('title') || '')).replace(/\s+/g, ' ').trim()),
  )

/** One svg as the icon checks read it. */
interface SvgFacts {
  where: string
  viewBox: string | null
  width: string | null
  height: string | null
  rendered: boolean
  box: string
  fill: string
  parentColor: string
  ariaHidden: string | null
}

/** Every svg in the body that is not a chart (nor inside one). */
const iconFacts = (page: Page): Promise<SvgFacts[]> =>
  page.locator('body').evaluate((root, chart) => {
    const label = (e: Element): string => {
      const host = e.closest('button, a, li, p, div, span')
      const name = host?.getAttribute('aria-label') ?? host?.getAttribute('data-testid') ?? (host?.textContent ?? '').trim().slice(0, 40)
      return `${e.getAttribute('data-icon') ?? 'svg'} in ${host?.tagName.toLowerCase() ?? '?'} "${name}"`
    }
    return Array.from(root.querySelectorAll('svg'))
      .filter((s) => !s.closest(chart))
      .map((s) => {
        const r = s.getBoundingClientRect()
        const parent = s.parentElement
        return {
          where: label(s),
          viewBox: s.getAttribute('viewBox'),
          width: s.getAttribute('width'),
          height: s.getAttribute('height'),
          rendered: s.getClientRects().length > 0,
          box: `${Math.round(r.width * 100) / 100}x${Math.round(r.height * 100) / 100}`,
          fill: getComputedStyle(s).fill,
          parentColor: parent ? getComputedStyle(parent).color : '',
          ariaHidden: s.getAttribute('aria-hidden'),
        }
      })
  }, CHART)

/** Buttons and links whose only content is an svg, with their `aria-label`. */
const iconOnlyControls = (page: Page): Promise<{ where: string; label: string | null }[]> =>
  page.locator('body').evaluate((root) =>
    Array.from(root.querySelectorAll('button, a'))
      .filter((e) => (e.textContent ?? '').trim() === '' && e.querySelector('svg') !== null)
      .map((e) => ({ where: `${e.tagName.toLowerCase()} ${e.getAttribute('data-testid') ?? e.getAttribute('title') ?? e.outerHTML.slice(0, 80)}`, label: e.getAttribute('aria-label') })),
  )

const normalise = (text: string): string => text.replace(REMOVED, '').replace(/\s+/g, ' ').trim()

interface SurfaceBaseline {
  text: string
  names: string[]
}
type Baseline = Record<string, Record<string, SurfaceBaseline>>

const readBaseline = (): Baseline => (fs.existsSync(BASELINE) ? (JSON.parse(fs.readFileSync(BASELINE, 'utf8')) as Baseline) : {})

/** Writes one surface of the baseline: a recording run uses one worker, so read-modify-write is safe. */
function record(project: string, key: string, entry: SurfaceBaseline): void {
  const all = readBaseline()
  const mine = { ...(all[project] ?? {}), [key]: entry }
  all[project] = Object.fromEntries(Object.entries(mine).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
  const sorted = Object.fromEntries(Object.entries(all).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
  fs.writeFileSync(BASELINE, `${JSON.stringify(sorted, null, 2)}\n`)
}

const slug = (key: string): string => key.replace(/[^a-z0-9]+/gi, '-')

test.describe('AC1: no emoji or glyph icons in text', () => {
  for (const s of SURFACES) {
    test(`no emoji or glyph icons in text: ${s.key}`, async ({ page }) => {
      test.skip(RECORD, 'a recording run only writes the baseline')
      await s.open(page)
      await expect(s.target(page).first()).toBeAttached()
      if (s.page) await shot(page, `text-${slug(s.key)}`)
      else await viewportShot(page, `text-${slug(s.key)}`)
      const text = await bodyText(page)
      expect(text.length, 'the page has text to check').toBeGreaterThan(0)
      expect(text.match(new RegExp(EMOJI.source, 'gu')) ?? [], 'emoji in the text').toEqual([])
      expect(GLYPHS.filter((g) => text.includes(g)), 'glyph icons in the text').toEqual([])
    })
  }
})

test.describe('AC2: option labels are plain words', () => {
  test('option labels are plain words', async ({ page }) => {
    test.skip(RECORD, 'a recording run only writes the baseline')
    await openDialog(page, '/accounts', 'Accounts', (q) => q.getByRole('button', { name: 'Add account', exact: true }), 'Create account', [createAccountRoute([formAccount])])
    const select = dialogOf(page).locator('select').first()
    await expect(select.locator('option[value="credit"]')).toBeAttached()
    await select.focus()
    await viewportShot(page, 'account-type-options')
    const labels = await select.locator('option').allTextContents()
    expect(labels, 'the account type options').toEqual(['Checking', 'Savings', 'Credit Card', 'Cash', 'E-Wallet', 'Loan'])
    expect(labels.filter((l) => !/^[A-Za-z][A-Za-z &-]*$/.test(l)), 'options that are not plain words').toEqual([])
  })
})

test.describe('AC3: all icons are one set at one size', () => {
  for (const s of SURFACES) {
    test(`all icons are one set at one size: ${s.key}`, async ({ page }) => {
      test.skip(RECORD, 'a recording run only writes the baseline')
      await s.open(page)
      await expect(s.target(page).first()).toBeAttached()
      await viewportShot(page, `icons-${slug(s.key)}`)
      const facts = await iconFacts(page)
      expect(facts.length, 'the surface draws icons').toBeGreaterThan(0)
      expect(facts.filter((f) => f.viewBox !== '0 0 256 256').map((f) => `${f.where}: ${f.viewBox}`), 'icons not on the Phosphor 256 grid').toEqual([])
      expect(facts.filter((f) => f.width !== '20' || f.height !== '20').map((f) => `${f.where}: ${f.width}x${f.height}`), 'icons not sized 20').toEqual([])
      expect(facts.filter((f) => f.rendered && f.box !== '20x20').map((f) => `${f.where}: ${f.box}`), 'rendered icons not 20x20px').toEqual([])
      expect(facts.filter((f) => f.fill !== f.parentColor).map((f) => `${f.where}: fill ${f.fill}, parent ${f.parentColor}`), 'icons not filled with the parent colour').toEqual([])
    })
  }
})

test.describe('AC4: icon-only controls are labelled', () => {
  for (const s of SURFACES) {
    test(`icon-only controls are labelled: ${s.key}`, async ({ page }) => {
      test.skip(RECORD, 'a recording run only writes the baseline')
      await s.open(page)
      await expect(s.target(page).first()).toBeAttached()
      await viewportShot(page, `labels-${slug(s.key)}`)
      const controls = await iconOnlyControls(page)
      expect(controls.filter((c) => (c.label ?? '').trim() === '').map((c) => c.where), 'icon-only controls without an aria-label').toEqual([])
      const facts = await iconFacts(page)
      expect(facts.length, 'the surface draws icons').toBeGreaterThan(0)
      expect(facts.filter((f) => f.ariaHidden !== 'true').map((f) => f.where), 'decorative icons not hidden from assistive technology').toEqual([])
    })
  }
})

test.describe('AC5: source has one icon path', () => {
  /** Every `.ts` and `.tsx` file under frontend/src, as paths relative to frontend/. */
  const sourceFiles = (dir: string = SRC): string[] =>
    fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
      const full = path.join(dir, d.name)
      if (d.isDirectory()) return sourceFiles(full)
      return /\.tsx?$/.test(d.name) ? [path.relative(FRONTEND, full)] : []
    })
  const read = (rel: string): string => fs.readFileSync(path.join(FRONTEND, rel), 'utf8')
  const ICON = 'src/components/Icon.tsx'
  const CHARTS = ['src/components/RunningBalanceChart.tsx', 'src/components/SpendingBreakdownDialog.tsx']

  test('source has one icon path: no svg literal outside Icon and the charts', async ({ page }) => {
    test.skip(RECORD, 'a recording run only writes the baseline')
    const files = sourceFiles()
    expect(files, 'Icon.tsx exists').toContain(ICON)
    const withSvg = files.filter((f) => /<svg\b/.test(read(f)))
    await page.setContent(`<pre style="font: 13px/1.4 monospace; padding: 16px">${['svg literals:', ...withSvg].join('\n')}</pre>`)
    await shot(page, 'source-svg')
    expect(withSvg.filter((f) => f !== ICON && !CHARTS.includes(f)), 'files with an svg literal outside Icon.tsx and the charts').toEqual([])
    // The donut is the dialog's one svg; the running-balance chart is its component's.
    expect(CHARTS.map((f) => `${f}: ${read(f).match(/<svg\b/g)?.length ?? 0}`), 'each chart draws one svg').toEqual(CHARTS.map((f) => `${f}: 1`))
  })

  test('source has one icon path: one icon package, imported only by Icon', async ({ page }) => {
    test.skip(RECORD, 'a recording run only writes the baseline')
    const pkg = JSON.parse(read('package.json')) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> }
    const deps = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies })
    const importers = sourceFiles().filter((f) => /from\s+['"]@phosphor-icons\/react|import\(\s*['"]@phosphor-icons\/react|require\(\s*['"]@phosphor-icons\/react/.test(read(f)))
    await page.setContent(`<pre style="font: 13px/1.4 monospace; padding: 16px">${['dependencies:', ...deps, '', 'phosphor importers:', ...importers].join('\n')}</pre>`)
    await shot(page, 'source-package')
    expect(deps, 'the icon set is a dependency').toContain('@phosphor-icons/react')
    expect(deps.filter((d) => /^(lucide-react|heroicons|@heroicons\/.*|react-icons)$/.test(d)), 'other icon sets').toEqual([])
    expect(importers, 'files importing @phosphor-icons/react').toEqual([ICON])
  })

  test('source has one icon path: Icon fixes weight, size and colour', async ({ page }) => {
    test.skip(RECORD, 'a recording run only writes the baseline')
    const icon = read(ICON)
    await page.setContent(`<pre style="font: 13px/1.4 monospace; padding: 16px"></pre>`)
    await page.locator('pre').evaluate((el, text) => {
      el.textContent = text
    }, icon)
    await shot(page, 'source-icon')
    // Each icon is imported on its own, from its own module.
    expect(icon.match(/from '@phosphor-icons\/react'/g) ?? [], 'a whole-package import').toEqual([])
    expect(icon, 'the one component takes only a name').toMatch(/export function Icon\(\{ name \}: \{ name: IconName \}\)/)
    expect(icon, 'Regular weight').toMatch(/weight="regular"/)
    expect(icon, '20px').toMatch(/size=\{20\}/)
    expect(icon, 'currentColor').toMatch(/color="currentColor"/)
    expect(icon, 'decorative by default').toMatch(/aria-hidden="true"/)
    // Nothing a caller passes reaches the glyph: no spread props.
    expect(icon.match(/\{\.\.\.\w+\}/g) ?? [], 'props spread onto the glyph').toEqual([])
  })

  test('source has one icon path: every icon consumer uses Icon', async ({ page }) => {
    test.skip(RECORD, 'a recording run only writes the baseline')
    // A glyph or emoji in code (outside comments) is an icon drawn without Icon.
    const strip = (src: string): string => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1')
    const hits = sourceFiles().flatMap((f) =>
      strip(read(f))
        .split('\n')
        .flatMap((line, i) => (/[\p{Extended_Pictographic}⚠✕✓○→×‹›▾▴↗]/u.test(line) ? [`${f}:${i + 1}: ${line.trim().slice(0, 80)}`] : [])),
    )
    const consumers = sourceFiles().filter((f) => f !== ICON && /<Icon\b/.test(read(f)))
    await page.setContent(`<pre style="font: 13px/1.4 monospace; padding: 16px">${['Icon consumers:', ...consumers, '', 'glyphs in code:', ...hits].join('\n')}</pre>`)
    await shot(page, 'source-consumers')
    expect(hits, 'emoji or glyph icons in code').toEqual([])
    expect(consumers.length, 'files drawing icons through Icon').toBeGreaterThan(10)
  })
})

/** The navigation items: the top bar's on desktop, the tab bar's on a phone. */
const NAV: { project: 'desktop' | 'phone'; label: string; route: string; heading: string; other: string; otherHeading: string }[] = [
  { project: 'desktop', label: 'Dashboard', route: '/', heading: 'Dashboard', other: '/accounts', otherHeading: 'Accounts' },
  { project: 'desktop', label: 'Forecast', route: '/forecast', heading: 'Cash-flow timeline', other: '/', otherHeading: 'Dashboard' },
  { project: 'desktop', label: 'Accounts', route: '/accounts', heading: 'Accounts', other: '/', otherHeading: 'Dashboard' },
  { project: 'desktop', label: 'Transactions', route: '/transactions', heading: 'Transactions', other: '/', otherHeading: 'Dashboard' },
  { project: 'desktop', label: 'Allocations', route: '/allocations', heading: 'Allocations', other: '/', otherHeading: 'Dashboard' },
  { project: 'phone', label: 'Dashboard', route: '/', heading: 'Dashboard', other: '/accounts', otherHeading: 'Accounts' },
  { project: 'phone', label: 'Accounts', route: '/accounts', heading: 'Accounts', other: '/', otherHeading: 'Dashboard' },
  { project: 'phone', label: 'Transactions', route: '/transactions', heading: 'Transactions', other: '/', otherHeading: 'Dashboard' },
  { project: 'phone', label: 'Allocations', route: '/allocations', heading: 'Allocations', other: '/', otherHeading: 'Dashboard' },
]
const navLink = (page: Page, project: string, label: string): Locator =>
  (project === 'desktop' ? topBar(page) : tabBar(page)).getByRole('link', { name: label, exact: true })

/** The item's icon: its markup (geometry and every attribute) and its colour. */
const navIcon = (link: Locator): Promise<{ markup: string; fill: string; linkColor: string }> =>
  link.locator('svg').evaluate((s) => ({ markup: s.outerHTML, fill: getComputedStyle(s).fill, linkColor: getComputedStyle(s.closest('a') as Element).color }))

test.describe('AC6: active icons differ by colour only', () => {
  for (const n of NAV) {
    test(`active icons differ by colour only: ${n.project === 'desktop' ? 'top bar' : 'tab bar'} ${n.label}`, async ({ page }, testInfo) => {
      test.skip(RECORD, 'a recording run only writes the baseline')
      test.skip(testInfo.project.name !== n.project, `the ${n.project === 'desktop' ? 'top bar' : 'tab bar'} shows its links on ${n.project}`)
      await openPage(page, n.route, n.heading)
      const link = navLink(page, n.project, n.label)
      await expect(link.locator('svg')).toBeVisible()
      await expect(link).toHaveAttribute('aria-current', 'page')
      const active = await navIcon(link)
      await viewportShot(page, `active-${slug(n.label)}`)
      await page.goto(n.other)
      await expect(page.getByRole('heading', { level: 1, name: n.otherHeading })).toBeVisible({ timeout: 15_000 })
      await settle(page)
      await expect(link).not.toHaveAttribute('aria-current', 'page')
      const inactive = await navIcon(link)
      await viewportShot(page, `inactive-${slug(n.label)}`)
      expect(inactive.markup, 'the same geometry and attributes in both states').toBe(active.markup)
      expect(active.fill, 'the active icon takes the active link colour').toBe(active.linkColor)
      expect(inactive.fill, 'the inactive icon takes the inactive link colour').toBe(inactive.linkColor)
      // The tab bar marks the active item by colour; the top bar marks it with its rule, in one colour. Either way the icon follows its link.
      expect(inactive.fill !== active.fill, 'the icon colour changes exactly when the link colour does').toBe(inactive.linkColor !== active.linkColor)
    })
  }
})

test.describe('AC7: icon replacement preserves existing behaviour', () => {
  for (const s of SURFACES) {
    test(`icon replacement preserves existing behaviour: ${s.key} text and names`, async ({ page }, testInfo) => {
      await s.open(page)
      const text = await bodyText(page)
      const names = await controlNames(page)
      await viewportShot(page, `same-${slug(s.key)}`)
      const project = testInfo.project.name
      if (RECORD) {
        record(project, s.key, { text, names })
        return
      }
      await expect(s.target(page).first()).toBeAttached()
      const base = readBaseline()[project]?.[s.key]
      expect(base, `the baseline has ${s.key} for ${project}`).toBeDefined()
      if (!base) return
      // Visible text loses only the icon characters (and the emoji before the account-type words).
      expect(normalise(text), 'the visible text, icon characters aside').toBe(normalise(base.text))
      // Every control keeps its name; one that had none (an icon-only close) may now have one.
      expect(names.length, 'the same controls').toBe(base.names.length)
      const changed = names.flatMap((name, i) => (normalise(base.names[i]) === '' || normalise(name) === normalise(base.names[i]) ? [] : [`${base.names[i]} -> ${name}`]))
      expect(changed, 'controls whose accessible name changed').toEqual([])
    })
  }

  for (const n of NAV) {
    test(`icon replacement preserves existing behaviour: ${n.project === 'desktop' ? 'top bar' : 'tab bar'} ${n.label} goes to its page`, async ({ page }, testInfo) => {
      test.skip(RECORD, 'a recording run only writes the baseline')
      test.skip(testInfo.project.name !== n.project, `the ${n.project === 'desktop' ? 'top bar' : 'tab bar'} shows its links on ${n.project}`)
      await openPage(page, n.other, n.otherHeading)
      await navLink(page, n.project, n.label).click()
      await expect(page.getByRole('heading', { level: 1, name: n.heading })).toBeVisible({ timeout: 15_000 })
      await viewportShot(page, `goes-${slug(n.label)}`)
      expect(new URL(page.url()).pathname, `${n.label} opens its page`).toBe(n.route)
    })
  }

  test('icon replacement preserves existing behaviour: the user menu opens Settings', async ({ page }) => {
    test.skip(RECORD, 'a recording run only writes the baseline')
    await openPage(page, '/', 'Dashboard')
    await topBar(page).getByRole('button', { name: /MS/ }).click()
    await page.getByRole('link', { name: 'Settings' }).click()
    await expect(page.getByRole('heading', { level: 1, name: 'Settings' })).toBeVisible({ timeout: 15_000 })
    await viewportShot(page, 'user-menu-settings')
    expect(new URL(page.url()).pathname, 'Settings opens the settings page').toBe('/settings')
  })

  test('icon replacement preserves existing behaviour: the theme toggle switches the theme', async ({ page }) => {
    test.skip(RECORD, 'a recording run only writes the baseline')
    await openPage(page, '/', 'Dashboard')
    const toggle = topBar(page).getByRole('button', { name: 'Toggle theme' })
    const before = await page.locator('html').getAttribute('data-theme')
    const iconBefore = await toggle.locator('svg').getAttribute('data-icon')
    await toggle.click()
    await expect(page.locator('html')).not.toHaveAttribute('data-theme', before ?? '')
    await viewportShot(page, 'theme-toggled')
    const after = await page.locator('html').getAttribute('data-theme')
    expect([before, after].sort(), 'the toggle swaps light and dark').toEqual(['dark', 'light'])
    expect(await toggle.locator('svg').getAttribute('data-icon'), 'the icon shows the theme the toggle goes to').not.toBe(iconBefore)
  })

  test('icon replacement preserves existing behaviour: quick balance controls move and remove', async ({ page }) => {
    test.skip(RECORD, 'a recording run only writes the baseline')
    await surface('quick balances editor').open(page)
    const names = page.getByTestId('quick-balance-edit-name')
    await expect(names).toHaveText(QUICK_BALANCES)
    await page.getByRole('button', { name: `Move ${QUICK_BALANCES[1]} earlier` }).click()
    await expect(names).toHaveText([QUICK_BALANCES[1], QUICK_BALANCES[0], ...QUICK_BALANCES.slice(2)])
    await page.getByRole('button', { name: `Move ${QUICK_BALANCES[1]} later` }).click()
    await expect(names).toHaveText(QUICK_BALANCES)
    await page.getByRole('button', { name: `Remove ${QUICK_BALANCES[0]}` }).click()
    await viewportShot(page, 'quick-balances-moved')
    await expect(names).toHaveText(QUICK_BALANCES.slice(1))
  })

  test('icon replacement preserves existing behaviour: month arrows and filter chips', async ({ page }) => {
    test.skip(RECORD, 'a recording run only writes the baseline')
    const api = await openPage(page, '/transactions', 'Transactions')
    // The month the arrows step through sits between them.
    const month = page.getByRole('button', { name: 'View previous month' }).locator('xpath=following-sibling::span[1]')
    await expect(month).toHaveText('March 2026')
    await page.getByRole('button', { name: 'View previous month' }).click()
    await expect(month).toHaveText('February 2026')
    await page.getByRole('button', { name: 'View next month' }).click()
    await expect(month).toHaveText('March 2026')
    await page.getByRole('button', { name: 'Filters', exact: true }).click()
    await page.getByRole('group', { name: 'Entered by' }).getByRole('button', { name: 'Only mine' }).click()
    const chip = page.getByRole('button', { name: 'Remove the Only mine filter' })
    await expect(chip).toBeVisible()
    const mineCalls = api.requests().length
    await chip.click()
    await viewportShot(page, 'filter-chip-removed')
    await expect(chip).toHaveCount(0)
    await expect(page.getByRole('group', { name: 'Entered by' }).getByRole('button', { name: 'Everyone' })).toHaveAttribute('aria-pressed', 'true')
    expect(api.requests().length, 'removing the chip reloads the list').toBeGreaterThan(mineCalls)
  })

  test('icon replacement preserves existing behaviour: pickers select and expand', async ({ page }) => {
    test.skip(RECORD, 'a recording run only writes the baseline')
    await openDialog(page, '/transactions', 'Transactions', (q) => q.getByRole('button', { name: 'Add transaction', exact: true }).first(), 'Add transaction')
    const field = dialogOf(page).locator('[data-field="account_id"]')
    await pickAccount(page, SAVINGS_ACCOUNT)
    await field.locator('[data-picker-change]').click()
    const checked = field.locator('[data-picker-option][data-selected="true"]')
    await expect(checked).toHaveCount(1)
    await expect(checked).toContainText(SAVINGS_ACCOUNT)
    await expect(checked.locator('svg[data-icon="check"]')).toHaveCount(1)
    await expect(field.locator('[data-picker-option]:not([data-selected="true"]) [data-picker-check]')).toHaveCount(0)
    await viewportShot(page, 'picker-selected')
    await dialogOf(page).getByRole('button', { name: 'Cancel', exact: true }).click()

    await page.getByRole('button', { name: 'Filters', exact: true }).click()
    const toggle = page.locator('[data-picker-toggle]').first()
    await expect(toggle).toHaveAttribute('aria-expanded', 'false')
    await expect(toggle.locator('svg[data-icon="caret-down"]')).toHaveCount(1)
    await toggle.click()
    await expect(toggle).toHaveAttribute('aria-expanded', 'true')
    await expect(toggle).toHaveText('Show fewer')
    await viewportShot(page, 'picker-expanded')
    expect(await toggle.locator('svg').getAttribute('data-icon'), 'the open toggle points up').toBe('caret-up')
  })

  test('icon replacement preserves existing behaviour: account type values are saved', async ({ page }) => {
    test.skip(RECORD, 'a recording run only writes the baseline')
    const api = await openDialog(page, '/accounts', 'Accounts', (q) => q.getByRole('button', { name: 'Add account', exact: true }), 'Create account', [createAccountRoute([formAccount])])
    const select = dialogOf(page).locator('select').first()
    const options = await select.locator('option').evaluateAll((els) => els.map((e) => `${(e as HTMLOptionElement).value}=${e.textContent}`))
    expect(options, 'each option keeps its value').toEqual(['checking=Checking', 'savings=Savings', 'credit=Credit Card', 'cash=Cash', 'e_wallet=E-Wallet', 'loan=Loan'])
    await select.selectOption({ label: 'Savings' })
    await dialogOf(page).getByPlaceholder('Enter account name').fill(newAccountInput.name)
    await dialogOf(page).getByRole('button', { name: 'Create account', exact: true }).click()
    await expect.poll(() => api.bodies('POST', '/accounts/').length).toBe(1)
    await viewportShot(page, 'account-type-saved')
    expect((api.bodies('POST', '/accounts/')[0] as { account_type?: string }).account_type, 'the picked type is sent').toBe('savings')
  })

  test('icon replacement preserves existing behaviour: credit details toggle and dialogs close', async ({ page }) => {
    test.skip(RECORD, 'a recording run only writes the baseline')
    await surface('account create').open(page)
    await dialogOf(page).getByRole('button', { name: 'Show details' }).click()
    await expect(dialogOf(page).getByRole('button', { name: 'Hide details' }).locator('svg[data-icon="caret-up"]')).toHaveCount(1)
    await dialogOf(page).getByRole('button', { name: 'Hide details' }).click()
    await expect(dialogOf(page).getByRole('button', { name: 'Show details' })).toBeVisible()
    await page.getByRole('button', { name: 'Close account modal' }).click()
    await expect(page.getByRole('heading', { name: 'Create account' })).toHaveCount(0)
    await transactionRowActions(page)
    await page.getByRole('button', { name: 'Close actions modal' }).click()
    await expect(page.getByRole('heading', { name: 'Transaction actions' })).toHaveCount(0)
    await viewportShot(page, 'dialogs-closed')
    expect(await page.locator(DIALOG).count(), 'no dialog left open').toBe(0)
  })

  test('icon replacement preserves existing behaviour: sign-up validation', async ({ page }) => {
    test.skip(RECORD, 'a recording run only writes the baseline')
    const created: User = { ...household.user, id: 77, email: 'mara@example.com', is_verified: false, onboarding_completed: false }
    const api = await openSignUp(page)
    await addRoutes(page, [apiRoute<User>('POST', '/auth/register', created, 201)])
    const requirement = (text: string): Locator => page.locator('li', { hasText: text })
    await page.locator('#password').fill('abc1')
    await expect(requirement('One lowercase letter').locator('svg[data-icon="check"]')).toHaveCount(1)
    await expect(requirement('One number').locator('svg[data-icon="check"]')).toHaveCount(1)
    for (const unmet of ['At least 8 characters', 'One uppercase letter', 'One special character']) {
      await expect(requirement(unmet).locator('svg[data-icon="requirement-unmet"]')).toHaveCount(1)
    }
    // The eye shows and hides the password.
    await expect(page.locator('#password')).toHaveAttribute('type', 'password')
    await page.getByRole('button', { name: 'Show password' }).first().click()
    await expect(page.locator('#password')).toHaveAttribute('type', 'text')
    await page.getByRole('button', { name: 'Hide password' }).first().click()
    await expect(page.locator('#password')).toHaveAttribute('type', 'password')

    await page.locator('#firstName').fill('Mara')
    await page.locator('#lastName').fill('Santos')
    await page.locator('#email').fill('mara@example.com')
    await page.locator('#confirmPassword').fill('abc1')
    await page.getByRole('button', { name: 'Create account' }).click()
    await expect(page.getByText('Password does not meet all requirements')).toBeVisible()
    await page.locator('#password').fill('Abcdef1!')
    for (const met of ['At least 8 characters', 'One uppercase letter', 'One lowercase letter', 'One number', 'One special character']) {
      await expect(requirement(met).locator('svg[data-icon="check"]')).toHaveCount(1)
    }
    await page.getByRole('button', { name: 'Create account' }).click()
    await expect(page.getByText('Passwords do not match').first()).toBeVisible()
    expect(api.count('POST', '/auth/register'), 'nothing is sent while the form is invalid').toBe(0)
    await page.locator('#confirmPassword').fill('Abcdef1!')
    await viewportShot(page, 'sign-up-valid')
    await page.getByRole('button', { name: 'Create account' }).click()
    await expect.poll(() => api.count('POST', '/auth/register')).toBe(1)
    expect(api.bodies('POST', '/auth/register')[0], 'the form sends what was typed').toEqual({
      email: 'mara@example.com',
      password: 'Abcdef1!',
      first_name: 'Mara',
      last_name: 'Santos',
      default_currency: 'PHP',
    })
  })
})

function surface(key: string): Surface {
  const s = SURFACES.find((x) => x.key === key)
  if (!s) throw new Error(`no surface ${key}`)
  return s
}

/** Opens the transaction row's actions dialog from the page already open. */
async function transactionRowActions(page: Page): Promise<void> {
  await page.goto('/transactions')
  await expect(page.getByRole('heading', { level: 1, name: 'Transactions' })).toBeVisible({ timeout: 15_000 })
  await settle(page)
  await transactionRow(page, ROW_TRANSACTION).click()
  await expect(dialogOf(page).getByRole('heading', { name: 'Transaction actions' })).toBeVisible()
}
