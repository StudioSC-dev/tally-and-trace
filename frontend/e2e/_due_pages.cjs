// Helpers for the "Due and overdue" section's pager, shared by the browser checks
// that read its rows. The section shows 3 rows a page, so a row can be on any page:
//   - allDueRows(page): every row on every page, read from page 1 to the last.
//     Use it for every count and every absence check ("not listed"); never
//     conclude a row is absent from the page on screen.
//   - rowsOf(page, name, kind): the rows of allDueRows that match a name.
//   - showRow(page, locator): go to the page that holds the locator and return it,
//     for clicking a button on it.
//   - openDueTab(page, slug): select a tab of the card by its slug in DUE_TABS ('due',
//     'not-posted', 'upcoming', 'subscriptions' or 'installments'). Only the selected tab's panel is mounted, so every helper here reads
//     the tab on screen; one-off pending rows are on 'not-posted', everything else on 'due'.
//   - readTab(page, slug): open a tab and return every row on every page, with `day`, `plan`,
//     `left` (N of M left), `upcomingButtons` and `credit`.
//   - useDueCheck(check): every script that opens a tab registers its check(what, actual, expected) first.
//     expectDueTab(page, slug) records that the card has the tab before a script waits on its badge,
//     and a page step that does not land records a failed assertion before it throws.
//   - dialogOpened(locator, what): a bounded wait for a dialog or modal, recorded as an assertion; returns a boolean.
//   - DUE_TABS: the card's tabs in order, each { slug, tab, badge, panel } (test ids).
const { waitQuiet } = require('./_smooth.cjs')
const ROWS = '[data-testid="due-row"]'

// The calling script's assertion recorder, `check(what, actual, expected)`, set with useDueCheck.
let dueCheck = null
// The tabs already found on each page, so a tab's existence is asserted once per page.
const tabsSeen = new WeakMap()
/** Registers the script's `check(what, actual, expected)`: expectDueTab and openDueTab record through it, and so does a page step that does not land. */
function useDueCheck(fn) {
  dueCheck = fn
}

const pager = (page) => page.locator('[data-testid="due-pager"]')
const hasPager = async (page) => (await pager(page).count()) > 0
const currentPage = async (page) => Number(await pager(page).locator('button[aria-current="page"]').textContent())
const nextButton = (page) => pager(page).getByRole('button', { name: 'Next', exact: true })
const previousButton = (page) => pager(page).getByRole('button', { name: 'Previous', exact: true })

/** "1–3 of 7", or null with no pager. */
async function pagerLabel(page) {
  return (await hasPager(page)) ? (await pager(page).locator('p').first().textContent())?.trim() ?? null : null
}

async function step(page, button, to) {
  // Read-only paging: dispatch the click, so an open dialog or form over the page does not block it.
  await button.dispatchEvent('click')
  try {
    await pager(page).locator('button[aria-current="page"]').filter({ hasText: new RegExp(`^${to}$`) }).waitFor({ timeout: 5000 })
  } catch (e) {
    // A step that does not land is a failed assertion (when the script registered its check), then the error.
    if (dueCheck !== null) await dueCheck(`the pager reached page ${to}`, await currentPage(page).catch(() => null), to)
    throw e
  }
}

/** Step to page `n` with Previous and Next; the list has no pager while it fits on one page. */
async function goToPage(page, n) {
  await waitQuiet(page)
  if (!(await hasPager(page))) {
    if (n !== 1) throw new Error(`no pager, so no page ${n}`)
    return
  }
  let cur = await currentPage(page)
  while (cur < n) { await step(page, nextButton(page), cur + 1); cur += 1 }
  while (cur > n) { await step(page, previousButton(page), cur - 1); cur -= 1 }
}

/** The rows on the page on screen. */
const readRows = (page) =>
  page.locator(ROWS).evaluateAll((els) => els.map((e) => {
    const paras = [...e.querySelectorAll('p')]
    return {
      kind: e.dataset.kind,
      view: e.dataset.view,
      source: e.dataset.source ?? null,
      // An Upcoming row, a plan row or a future subscription row: its day, its plan and "N of M left".
      day: e.dataset.day ?? e.querySelector('[data-day]')?.dataset.day ?? null,
      plan: e.dataset.plan ?? null,
      left: e.querySelector('[data-testid="due-payments-left"]')?.textContent.trim() ?? null,
      autoPost: e.querySelector('[data-testid="due-auto-post"]')?.textContent.trim() ?? null,
      // An Upcoming or Subscriptions occurrence row's own buttons (upcoming-*), and a card row's credit badge status.
      upcomingButtons: [...e.querySelectorAll('button[data-testid^="upcoming-"]')].map((b) => b.dataset.testid),
      note: e.querySelector('[data-testid="upcoming-occurrence-note"]')?.textContent.trim() ?? null,
      notRecorded: e.querySelector('[data-testid="upcoming-not-recorded"]')?.textContent.trim() === 'Not recorded',
      credit: e.querySelector('[data-testid="credit-check-badge"]')?.dataset.status ?? null,
      name: paras[0]?.textContent.trim() ?? '',
      sub: paras[1]?.textContent.trim() ?? '',
      text: e.textContent.trim(),
      overdue: e.querySelector('[data-testid="due-overdue"]') !== null,
      // A Not posted yet row only: "logged 5 days ago" and the whole-day count behind it.
      logged: e.querySelector('[data-testid="due-logged"]')?.textContent.trim() ?? null,
      loggedDays: e.dataset.loggedDays ?? null,
      buttons: [...e.querySelectorAll('button[data-testid^="due-"]')].map((b) => b.dataset.testid),
    }
  }))

/** Every row on every page in list order; leaves the section on page 1. */
async function allDueRows(page) {
  await goToPage(page, 1)
  const out = []
  for (;;) {
    out.push(...(await readRows(page)))
    if (!(await hasPager(page)) || (await nextButton(page).isDisabled())) break
    await step(page, nextButton(page), (await currentPage(page)) + 1)
  }
  await goToPage(page, 1)
  return out
}

/** Does this row match? A pending row by its text, any other by its exact name, optionally of one kind. */
const matches = (row, name, kind) =>
  kind === 'pending'
    ? row.kind === 'pending' && row.text.includes(name)
    : row.kind !== 'pending' && (kind === undefined || row.kind === kind) && row.name === name

/** The rows matching `name` (and `kind`: recurring, missed or pending; and `text`, which the row must contain), over every page. */
async function rowsOf(page, name, kind, text) {
  return (await allDueRows(page)).filter((row) => matches(row, name, kind) && (text === undefined || row.text.includes(text)))
}

/** Wait until some page lists a row matching `name` (and `kind`); returns the matches. */
async function waitForRow(page, name, kind, ms = 15000) {
  const until = Date.now() + ms
  for (;;) {
    const found = await rowsOf(page, name, kind)
    if (found.length > 0 || Date.now() > until) return found
    await page.waitForTimeout(300)
  }
}

/** Go to the first page holding `locator` (a locator over due rows) and return it. */
async function showRow(page, locator) {
  await goToPage(page, 1)
  for (;;) {
    if ((await locator.count()) > 0 || !(await hasPager(page)) || (await nextButton(page).isDisabled())) return locator
    await step(page, nextButton(page), (await currentPage(page)) + 1)
  }
}

/** As showRow, but the last page holding `locator`, so its `.last()` is the last such row in list order. */
async function showLastRow(page, locator) {
  await goToPage(page, 1)
  let hit = 1
  for (;;) {
    if ((await locator.count()) > 0) hit = (await hasPager(page)) ? await currentPage(page) : 1
    if (!(await hasPager(page)) || (await nextButton(page).isDisabled())) break
    await step(page, nextButton(page), (await currentPage(page)) + 1)
  }
  await goToPage(page, hit)
  return locator
}

/** The card's tabs in order: each one's slug and the test ids of its tab, its badge and its panel. */
const DUE_TABS = [
  { slug: 'due', tab: 'due-tab-due', badge: 'due-count', panel: 'due-panel-due' },
  { slug: 'not-posted', tab: 'due-tab-not-posted', badge: 'due-not-posted-count', panel: 'due-panel-not-posted' },
  { slug: 'upcoming', tab: 'due-tab-upcoming', badge: 'due-upcoming-count', panel: 'due-panel-upcoming' },
  { slug: 'subscriptions', tab: 'due-tab-subscriptions', badge: 'due-subscriptions-count', panel: 'due-panel-subscriptions' },
  { slug: 'installments', tab: 'due-tab-installments', badge: 'due-installments-count', panel: 'due-panel-installments' },
]

/**
 * Waits up to `ms` for a dialog, modal or form (`locator`) and records `what` as an assertion
 * (actual true or false) through the registered check. Returns whether it showed, so the caller
 * skips what needs it: a missing dialog is a failed assertion, never a timeout.
 */
async function dialogOpened(locator, what, ms = 10000) {
  if (dueCheck === null) throw new Error('dialogOpened: call useDueCheck(check) first')
  const shown = await locator.waitFor({ timeout: ms }).then(() => true, () => false)
  await dueCheck(what, shown, true)
  return shown
}

/**
 * Records that the card has the tab `which` (once per page while it does; every time it does not,
 * and then throws), so a build without the tab fails an assertion instead of a timeout.
 */
async function expectDueTab(page, which) {
  const { tab } = DUE_TABS.find((t) => t.slug === which) ?? {}
  if (!tab) throw new Error(`expectDueTab: unknown tab "${which}"`)
  if (dueCheck === null) throw new Error('openDueTab: call useDueCheck(check) first')
  // The card renders every tab it has at once; the count is read once the card is there.
  await page.locator('[data-testid="due-section"]').waitFor({ timeout: 15000 }).catch(() => {})
  const seen = tabsSeen.get(page) ?? new Set()
  tabsSeen.set(page, seen)
  const found = await page.locator(`[data-testid="${tab}"]`).count()
  if (found !== 1 || !seen.has(which)) await dueCheck(`the due card has the ${which} tab`, found, 1)
  if (found !== 1) throw new Error(`the ${which} tab is not on the page (${found} found)`)
  seen.add(which)
}

/**
 * Selects a tab of the "Due and overdue" card: first records an assertion that the tab
 * exists (once per page and tab while it does; every time it does not, and then throws,
 * so a build without the tab fails an assertion instead of a timeout). Then clicks it
 * (opening the card if it is collapsed), waits for aria-selected, for its badge to be a
 * figure and not "…", then waitQuiet. It waits for quiet first, so the tab is read from settled data.
 */
async function openDueTab(page, which) {
  const { tab, badge } = DUE_TABS.find((t) => t.slug === which) ?? {}
  if (!tab) throw new Error(`openDueTab: unknown tab "${which}"`)
  await waitQuiet(page)
  await expectDueTab(page, which)
  await page.locator(`[data-testid="${tab}"]`).click()
  await page.locator(`[data-testid="${tab}"][aria-selected="true"]`).waitFor({ timeout: 5000 })
  await page.locator(`[data-testid="${badge}"]`).filter({ hasNotText: '…' }).waitFor({ timeout: 15000 })
  await waitQuiet(page)
}

/**
 * Opens the tab `slug` and returns every row on every page (readRows' fields, so the
 * `upcoming-*` buttons and the credit status are on each row). Leaves the tab selected, on page 1.
 */
async function readTab(page, slug) {
  await openDueTab(page, slug)
  return allDueRows(page)
}

module.exports = { DUE_TABS, useDueCheck, dialogOpened, expectDueTab, readTab, openDueTab, allDueRows, showLastRow, rowsOf, waitForRow, showRow, goToPage, currentPage, pagerLabel, hasPager, pager, nextButton, previousButton, readRows }
