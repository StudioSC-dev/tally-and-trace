// Helpers for the "Due and overdue" section's pager, shared by the browser checks
// that read its rows. The section shows 3 rows a page, so a row can be on any page:
//   - allDueRows(page): every row on every page, read from page 1 to the last.
//     Use it for every count and every absence check ("not listed"); never
//     conclude a row is absent from the page on screen.
//   - rowsOf(page, name, kind): the rows of allDueRows that match a name.
//   - showRow(page, locator): go to the page that holds the locator and return it,
//     for clicking a button on it.
const { waitQuiet } = require('./_smooth.cjs')
const ROWS = '[data-testid="due-row"]'

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
  await pager(page).locator('button[aria-current="page"]').filter({ hasText: new RegExp(`^${to}$`) }).waitFor({ timeout: 5000 })
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
      name: paras[0]?.textContent.trim() ?? '',
      sub: paras[1]?.textContent.trim() ?? '',
      text: e.textContent.trim(),
      overdue: e.querySelector('[data-testid="due-overdue"]') !== null,
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

module.exports = { allDueRows, showLastRow, rowsOf, waitForRow, showRow, goToPage, currentPage, pagerLabel, hasPager, pager, nextButton, previousButton, readRows }
