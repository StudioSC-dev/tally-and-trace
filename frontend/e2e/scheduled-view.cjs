// Browser check for STU-584 PR 2: the Transactions page's Scheduled view. The "Search and
// Filters" card has a To date | Scheduled switch; Scheduled lists everything after Manila's
// today from GET /transactions/scheduled (future one-off transactions and unrecorded recurring
// occurrences, merged by day on the server, paged by cursor), under the page's own search and
// filters. Starts its own API and web app against a throwaway database (./_local_stack.cjs).
// Not wired into CI and not part of `pnpm build`. Run steps: see ./README.md.
//
// Scenarios (each seeds its own user, so each can run alone):
//   (a) a one-off dated T+45, which no section of the page listed before, and an annual
//       occurrence at T+300 are listed in day order, with the nearer rows between and the
//       default range of tomorrow through a year ahead
//   (b) search "rent" and the account filter narrow both kinds of row; switching to To date
//       and back keeps the search and the filter
//   (c) row actions: a transaction row opens the action modal, and changing its date in Edit
//       moves it; Mark as Posted posts it; an occurrence's Mark paid sends one materialise POST
//       and the row goes; Change date opens its dialog
//   (d) the pager: 60 rows at 25 a page read 1-25, 26-50, 51-60 going Next, Previous returns
//       to 26-50, a filter change and a page-size change go back to page 1
//   (e) "See everything scheduled" on the Due card's Upcoming and Subscriptions panels switches
//       the view and the URL to ?view=scheduled, and a reload keeps it
//   (f) a viewer's own occurrence has no record buttons; a Household tag viewer's Limited
//       transaction row is listed and its occurrence is not
//   (g) at 390px no horizontal scroll and 44px targets
//   (h) an old API (422 on /transactions/scheduled) gives an inline error with Retry in the
//       list card while the rest of the page works; Retry loads the list once the API answers
//   (i) Through past today + 730 shows the recurring-payments note, and the From and Through
//       inputs are read "From" and "Through"
//
// Every scenario checks that no browser dialog fired.
//
// Usage: node frontend/e2e/scheduled-view.cjs [a|b|c|d|e|f|g|h|i]
const { startLocalStack } = require('./_local_stack.cjs')
const { pick } = require('./_picker.cjs')
const { useDueCheck, openDueTab } = require('./_due_pages.cjs')
const { waitQuiet } = require('./_smooth.cjs')
const { trackNativeDialogs } = require('./_dialogs.cjs')

const playwrightPath = process.env.PLAYWRIGHT_PATH || 'playwright'
let chromium
try {
  ;({ chromium } = require(playwrightPath))
} catch {
  console.error(`Cannot load Playwright from "${playwrightPath}". Set PLAYWRIGHT_PATH (see frontend/e2e/README.md).`)
  process.exit(2)
}

const only = process.argv[2]
let pass = 0, total = 0
function check(what, actual, expected) {
  total++
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (ok) pass++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${what}: actual=${JSON.stringify(actual)} expected=${JSON.stringify(expected)}`)
}
useDueCheck(check)
const checkNoNative = (scenario, native) => check(`(${scenario}) no browser dialog fired`, native.count, 0)

// ─── Days (YYYY-MM-DD, UTC arithmetic) ───────────────────────────────────────
const manilaToday = () => new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10)
const addDays = (day, n) => {
  const d = new Date(`${day}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().slice(0, 10)
}
const wire = (day) => `${day}T00:00:00`

let stack, API
async function api(token, method, url, body) {
  const res = await fetch(`${API}${url}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await res.text()
  let json = null
  try { json = JSON.parse(text) } catch { json = text }
  return { status: res.status, json }
}
async function post(token, url, body) {
  const r = await api(token, 'POST', url, body)
  if (r.status >= 300) throw new Error(`POST ${url} ${r.status} ${JSON.stringify(r.json)}`)
  return r.json
}
const get = async (token, url) => {
  const r = await api(token, 'GET', url)
  if (r.status >= 300) throw new Error(`GET ${url} ${r.status} ${JSON.stringify(r.json)}`)
  return r.json
}

async function makeUser(tag) {
  const email = `e2e-sv-${tag}-${Math.random().toString(16).slice(2, 8)}@example.com`
  const password = 'E2eTest!2345'
  const reg = await api('', 'POST', '/auth/register', { email, password, first_name: `User${tag}`, last_name: 'Test', default_currency: 'PHP' })
  if (reg.status !== 200 && reg.status !== 201) throw new Error(`register ${reg.status} ${JSON.stringify(reg.json)}`)
  stack.verifyUser(email) // aborts the run unless psql reports UPDATE 1
  const login = await api('', 'POST', '/auth/login', { email, password })
  if (login.status !== 200) throw new Error(`login ${login.status}`)
  return { email, password, tag, token: login.json.access_token }
}
const account = (u, name, balance = 100000) =>
  post(u.token, '/accounts/', { name, account_type: 'checking', balance, currency: 'PHP' })
/** A planned (unposted) debit with no entry. */
const planned = (u, acct, day, description, amount = 100, extra = {}) => post(u.token, '/transactions/', {
  account_id: acct.id, transaction_type: 'debit', amount, description, transaction_date: wire(day), is_posted: false, ...extra,
})
const entry = (u, fields) => post(u.token, '/budget-entries/', { entry_type: 'expense', currency: 'PHP', cadence: 'annual', amount: 500, ...fields })

async function newPage(browser, contextOptions = {}) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 1400 }, timezoneId: 'Asia/Manila', ...contextOptions })
  const page = await ctx.newPage()
  const native = trackNativeDialogs(page)
  if (process.env.DEBUG) page.on('response', (r) => { if (r.url().includes('/api/v1/')) console.log(`    [net] ${r.request().method()} ${r.url().replace(API, '')} -> ${r.status()}`) })
  return { ctx, page, native }
}
async function uiLogin(page, u) {
  await page.goto(`${stack.webUrl}/login`)
  await page.locator('#email').fill(u.email)
  await page.locator('#password').fill(u.password)
  await page.getByRole('button', { name: 'Sign in', exact: true }).click()
  await page.waitForURL((url) => url.pathname === '/')
}

// ─── The page ────────────────────────────────────────────────────────────────
const VIEW = '[data-testid="scheduled-view"]'
const LIST = '[data-testid="scheduled-list"]'
/** The view has settled: not fetching, and a list, an empty line or an error shown. */
async function scheduledReady(page) {
  await page.locator(`${VIEW}[aria-busy="false"]`).waitFor({ timeout: 15000 })
  await page.locator(`${LIST}, [data-testid="scheduled-empty"], [data-testid="scheduled-error"]`).first().waitFor({ timeout: 15000 })
  await waitQuiet(page)
}
async function openTransactions(page, query = '') {
  await page.goto(`${stack.webUrl}/transactions${query}`)
  await page.locator('[data-testid="due-section"]').waitFor()
  await page.locator('[data-testid="due-count"]').filter({ hasNotText: '…' }).waitFor()
  await waitQuiet(page)
}
const openScheduled = async (page) => {
  await openTransactions(page, '?view=scheduled')
  await scheduledReady(page)
}
/** The Scheduled list's rows in order. */
const readRows = (page) =>
  page.locator(`${LIST} > li`).evaluateAll((els) => els.map((e) => ({
    kind: e.dataset.kind,
    view: e.dataset.view ?? null,
    day: e.dataset.day ?? null,
    source: e.dataset.source ?? null,
    name: (e.querySelector('[data-testid="upcoming-occurrence-name"]') ?? e.querySelector('p'))?.textContent.trim() ?? '',
    text: e.textContent.replace(/\s+/g, ' ').trim(),
    buttons: [...e.querySelectorAll('button')].map((b) => b.dataset.testid).filter((t) => t && t !== 'upcoming-transaction'),
  })))
const names = async (page) => (await readRows(page)).map((r) => r.name)
/** Waits (bounded) until the list's names equal `want`, then returns what is listed. */
async function namesBecome(page, want) {
  await page
    .waitForFunction(
      ([list, expected]) => {
        const busy = document.querySelector('[data-testid="scheduled-view"]')?.getAttribute('aria-busy')
        const got = [...document.querySelectorAll(`${list} > li`)].map((e) => (e.querySelector('[data-testid="upcoming-occurrence-name"]') ?? e.querySelector('p'))?.textContent.trim())
        return busy === 'false' && JSON.stringify(got) === JSON.stringify(expected)
      },
      [LIST, want],
      { timeout: 10000 },
    )
    .catch(() => {})
  await waitQuiet(page)
  return names(page)
}
const rangeText = async (page) => (await page.locator('[data-testid="scheduled-range-text"]').textContent())?.trim() ?? null
/** Waits (bounded) for the pager's "Showing a–b of n" to read `want`, then returns it. */
async function rangeBecomes(page, want) {
  await page
    .waitForFunction(
      (expected) => {
        const busy = document.querySelector('[data-testid="scheduled-view"]')?.getAttribute('aria-busy')
        return busy === 'false' && document.querySelector('[data-testid="scheduled-range-text"]')?.textContent.trim() === expected
      },
      want,
      { timeout: 10000 },
    )
    .catch(() => {})
  await waitQuiet(page)
  return rangeText(page)
}
const pressed = (page, which) => page.locator(`[data-testid="view-${which}"]`).getAttribute('aria-pressed')
const search = (page) => page.locator('[data-testid="transactions-search"]')
async function showFilters(page) {
  const toggle = page.getByRole('button', { name: 'Show filters' })
  if (await toggle.count()) await toggle.click()
}
const actionModal = (page) => page.locator('div.fixed').filter({ has: page.getByRole('heading', { name: 'Transaction Actions', exact: true }) })

// (a) The T+45 one-off and the T+300 annual occurrence.
async function farRows(browser) {
  console.log('\n=== (a) a one-off at T+45 and an annual occurrence at T+300, in day order')
  const today = manilaToday()
  const u = await makeUser('a')
  const bank = await account(u, 'A Checking')
  await planned(u, bank, addDays(today, 2), 'A Near row')
  await planned(u, bank, addDays(today, 45), 'A Far row')
  await entry(u, { name: 'A Annual', account_id: bank.id, next_occurrence: wire(addDays(today, 300)) })
  await planned(u, bank, addDays(today, 200), 'A Middle row')
  const { ctx, page, native } = await newPage(browser)
  await uiLogin(page, u)
  // Before: no section lists the T+45 row (the main list ends today, Upcoming is T+1 to T+30).
  await openTransactions(page)
  await openDueTab(page, 'upcoming')
  check('(a) the To date view and the Due card do not list the T+45 row', await page.getByText('A Far row').count(), 0)
  check('(a) To date is the pressed view', [await pressed(page, 'to-date'), await pressed(page, 'scheduled')], ['true', 'false'])
  await page.locator('[data-testid="view-scheduled"]').click()
  await scheduledReady(page)
  const rows = await readRows(page)
  console.log(`    listed: ${JSON.stringify(rows.map((r) => [r.kind, r.day, r.name]))}`)
  check('(a) the rows are in day order, both kinds', rows.map((r) => [r.name, r.day]),
    [['A Near row', addDays(today, 2)], ['A Far row', addDays(today, 45)], ['A Middle row', addDays(today, 200)], ['A Annual', addDays(today, 300)]])
  check('(a) the kinds', rows.map((r) => r.kind), ['upcoming', 'upcoming', 'upcoming', 'occurrence'])
  check('(a) the occurrence says Not recorded', rows[3].text.includes('Not recorded'), true)
  check('(a) the URL carries view=scheduled', new URL(page.url()).searchParams.get('view'), 'scheduled')
  check('(a) the month arrows and the Spending breakdown are hidden',
    [await page.getByRole('button', { name: 'View previous month' }).count(), await page.getByRole('button', { name: /Spending breakdown/ }).count()], [0, 0])
  const api1 = await get(u.token, `/transactions/scheduled?limit=100`)
  check('(a) the page lists what the API returns', rows.map((r) => r.day), api1.items.map((i) => i.day))
  check('(a) the range reads tomorrow through a year ahead',
    (await page.locator('p', { hasText: 'Date range:' }).textContent()).replace(/\s+/g, ' ').includes('→'), true)
  await page.locator('[data-testid="view-to-date"]').click()
  await page.locator(VIEW).waitFor({ state: 'detached' })
  check('(a) To date is back, with no view in the URL', [await pressed(page, 'to-date'), new URL(page.url()).searchParams.get('view')], ['true', null])
  checkNoNative('a', native)
  await ctx.close()
}

// (b) Search and the account filter narrow both kinds; the switch keeps them.
async function searchAndAccount(browser) {
  console.log('\n=== (b) search and the account filter narrow both kinds of row; the switch keeps them')
  const today = manilaToday()
  const u = await makeUser('b')
  const x = await account(u, 'B Bank X')
  const y = await account(u, 'B Bank Y')
  await planned(u, x, addDays(today, 5), 'B Rent txn X')
  await planned(u, x, addDays(today, 6), 'B Gym txn X')
  await planned(u, y, addDays(today, 7), 'B Rent txn Y')
  await entry(u, { name: 'B Rent plan X', account_id: x.id, next_occurrence: wire(addDays(today, 9)) })
  await entry(u, { name: 'B Phone plan Y', account_id: y.id, next_occurrence: wire(addDays(today, 10)) })
  await entry(u, { name: 'B Water plan X', account_id: x.id, next_occurrence: wire(addDays(today, 11)) })
  const { ctx, page, native } = await newPage(browser)
  await uiLogin(page, u)
  await openScheduled(page)
  const all = ['B Rent txn X', 'B Gym txn X', 'B Rent txn Y', 'B Rent plan X', 'B Phone plan Y', 'B Water plan X']
  check('(b) six rows, both kinds', await namesBecome(page, all), all)
  await search(page).fill('rent')
  check('(b) search "rent" narrows both kinds', await namesBecome(page, ['B Rent txn X', 'B Rent txn Y', 'B Rent plan X']), ['B Rent txn X', 'B Rent txn Y', 'B Rent plan X'])
  await showFilters(page)
  await pick(page.locator('[data-field="filter_accounts"]'), 'B Bank X')
  check('(b) the account filter narrows both kinds', await namesBecome(page, ['B Rent txn X', 'B Rent plan X']), ['B Rent txn X', 'B Rent plan X'])
  await page.locator('[data-testid="view-to-date"]').click()
  await page.locator(VIEW).waitFor({ state: 'detached' })
  check('(b) To date keeps the search text', await search(page).inputValue(), 'rent')
  await page.locator('[data-testid="view-scheduled"]').click()
  await scheduledReady(page)
  check('(b) back in Scheduled the search and the account still apply', await namesBecome(page, ['B Rent txn X', 'B Rent plan X']), ['B Rent txn X', 'B Rent plan X'])
  check('(b) the search box still reads rent', await search(page).inputValue(), 'rent')
  checkNoNative('b', native)
  await ctx.close()
}

// (c) Row actions.
async function rowActions(browser) {
  console.log('\n=== (c) row actions: Edit moves a row, Mark as Posted posts it, Mark paid sends one POST, Change date opens its dialog')
  const today = manilaToday()
  const u = await makeUser('c')
  const bank = await account(u, 'C Checking')
  const edit = await planned(u, bank, addDays(today, 20), 'C Edit me')
  await planned(u, bank, addDays(today, 21), 'C Post me', 250)
  const pay = await entry(u, { name: 'C Pay', account_id: bank.id, next_occurrence: wire(addDays(today, 22)) })
  await entry(u, { name: 'C Move', account_id: bank.id, next_occurrence: wire(addDays(today, 23)) })
  const { ctx, page, native } = await newPage(browser)
  await uiLogin(page, u)
  const materialize = []
  page.on('response', (r) => {
    if (r.request().method() === 'POST' && /\/budget-entries\/\d+\/materialize$/.test(new URL(r.url()).pathname)) materialize.push(r.status())
  })
  await openScheduled(page)
  check('(c) four rows', await namesBecome(page, ['C Edit me', 'C Post me', 'C Pay', 'C Move']), ['C Edit me', 'C Post me', 'C Pay', 'C Move'])

  // A transaction row opens the action modal; Edit changes its date and the row moves.
  await page.locator(`${LIST} li`).filter({ hasText: 'C Edit me' }).locator('[data-testid="upcoming-transaction"]').click()
  const modal = actionModal(page)
  await modal.waitFor({ timeout: 10000 })
  check('(c) a transaction row opens the action modal with Edit, Delete and Mark as Posted',
    [await modal.getByRole('button', { name: 'Edit Transaction', exact: true }).count(), await modal.getByRole('button', { name: 'Delete Transaction', exact: true }).count(),
      await modal.getByRole('button', { name: 'Mark as Posted', exact: true }).count()], [1, 1, 1])
  await modal.getByRole('button', { name: 'Edit Transaction', exact: true }).click()
  const form = page.locator('div.fixed').filter({ has: page.getByRole('heading', { name: 'Edit Transaction', exact: true }) })
  await form.waitFor()
  await waitQuiet(page)
  await form.locator('[data-testid="transaction-date"]').fill(addDays(today, 40))
  const put = page.waitForResponse((r) => r.request().method() === 'PUT' && new URL(r.url()).pathname.endsWith(`/transactions/${edit.id}`))
  await form.getByRole('button', { name: 'Update Transaction', exact: true }).click()
  check('(c) saving the new date is 200', (await put).status(), 200)
  await form.waitFor({ state: 'detached' })
  check('(c) the edited row moved after the others', await namesBecome(page, ['C Post me', 'C Pay', 'C Move', 'C Edit me']), ['C Post me', 'C Pay', 'C Move', 'C Edit me'])
  check('(c) and reads its new day', (await readRows(page)).find((r) => r.name === 'C Edit me')?.day, addDays(today, 40))

  // Mark as Posted posts the row.
  await page.locator(`${LIST} li`).filter({ hasText: 'C Post me' }).locator('[data-testid="upcoming-transaction"]').click()
  await modal.waitFor({ timeout: 10000 })
  await waitQuiet(page)
  await modal.getByRole('button', { name: 'Mark as Posted', exact: true }).click()
  const posted = page.waitForResponse((r) => ['PUT', 'POST'].includes(r.request().method()) && /\/transactions\//.test(new URL(r.url()).pathname))
  await modal.getByRole('button', { name: 'Save Posted Amount', exact: true }).click()
  check('(c) Mark as Posted is accepted', (await posted).status() < 300, true)
  await waitQuiet(page)
  // The action modal may stay open on the posted row: close it when it does.
  const closeModal = page.getByRole('button', { name: 'Close actions modal' })
  if (await closeModal.count()) await closeModal.click()
  await modal.waitFor({ state: 'detached', timeout: 10000 })
  const postedApi = (await get(u.token, '/transactions/?limit=100')).items.find((t) => t.description === 'C Post me')
  check('(c) the API has it posted', postedApi?.is_posted, true)
  await page.locator(`${LIST} li`).filter({ hasText: 'C Post me' }).getByText('Posted').first().waitFor({ timeout: 10000 }).catch(() => {})
  check('(c) the row now reads Posted', (await readRows(page)).find((r) => r.name === 'C Post me')?.text.includes('Posted'), true)

  // Mark paid: one POST, and the row goes.
  const payRow = page.locator(`${LIST} li`).filter({ hasText: 'C Pay' })
  await payRow.locator('[data-testid="upcoming-mark-paid"]').click()
  const dlg = page.locator('[data-testid="mark-paid-dialog"]')
  await dlg.locator('[data-testid="mark-paid-occurrence"]').waitFor({ timeout: 10000 })
  await waitQuiet(page)
  check('(c) the dialog opens on the row\'s day', await dlg.locator('[data-testid="mark-paid-occurrence"]').inputValue(), addDays(today, 22))
  await dlg.locator('[data-testid="mark-paid-submit"]').click()
  await dlg.waitFor({ state: 'detached', timeout: 15000 })
  check('(c) Mark paid sent one POST', materialize.length, 1)
  check('(c) the occurrence row goes', await namesBecome(page, ['C Post me', 'C Move', 'C Edit me']), ['C Post me', 'C Move', 'C Edit me'])
  check('(c) the API has the entry recorded once', (await get(u.token, '/transactions/?limit=100')).items.filter((t) => t.budget_entry_id === pay.id).length, 1)

  // Change date opens the dialog.
  await page.locator(`${LIST} li`).filter({ hasText: 'C Move' }).locator('[data-testid="occurrence-change-date"]').click()
  check('(c) Change date opens its dialog', await page.locator('[data-testid="force-date-dialog"]').waitFor({ timeout: 10000 }).then(() => true, () => false), true)
  await page.locator('[data-testid="force-date-close"]').click()
  checkNoNative('c', native)
  await ctx.close()
}

// (d) The cursor pager.
async function pager(browser) {
  console.log('\n=== (d) 60 rows at 25 a page: 1-25, 26-50, 51-60; Previous; filter and page-size changes go back to page 1')
  const today = manilaToday()
  const u = await makeUser('d')
  const bank = await account(u, 'D Checking', 1000000)
  for (let n = 1; n <= 60; n++) await planned(u, bank, addDays(today, 2 + n), `D Row ${String(n).padStart(2, '0')}`, 10)
  const { ctx, page, native } = await newPage(browser)
  await uiLogin(page, u)
  const requests = []
  page.on('request', (r) => { if (new URL(r.url()).pathname.endsWith('/transactions/scheduled')) requests.push(new URL(r.url()).searchParams) })
  await openScheduled(page)
  const next = page.locator('[data-testid="scheduled-next"]')
  const previous = page.locator('[data-testid="scheduled-previous"]')
  check('(d) page 1 reads 1-25 of 60', await rangeBecomes(page, 'Showing 1–25 of 60'), 'Showing 1–25 of 60')
  check('(d) it lists 25 rows from D Row 01', [(await readRows(page)).length, (await names(page))[0]], [25, 'D Row 01'])
  check('(d) Previous is off on page 1', await previous.isDisabled(), true)
  await next.click()
  check('(d) page 2 reads 26-50', await rangeBecomes(page, 'Showing 26–50 of 60'), 'Showing 26–50 of 60')
  check('(d) it starts at D Row 26', (await names(page))[0], 'D Row 26')
  await next.click()
  check('(d) page 3 reads 51-60', await rangeBecomes(page, 'Showing 51–60 of 60'), 'Showing 51–60 of 60')
  check('(d) it lists the last 10 and Next is off', [(await readRows(page)).length, (await names(page)).at(-1), await next.isDisabled()], [10, 'D Row 60', true])
  await previous.click()
  check('(d) Previous returns to 26-50', await rangeBecomes(page, 'Showing 26–50 of 60'), 'Showing 26–50 of 60')
  check('(d) the pager sent no offset', requests.every((p) => !p.has('offset')), true)
  // A filter change on page 2 goes back to page 1.
  check('(d) on page 2 before the filter', (await names(page))[0], 'D Row 26')
  await search(page).fill('D Row 5')
  check('(d) a filter change goes back to page 1', await rangeBecomes(page, 'Showing 1–10 of 10'), 'Showing 1–10 of 10')
  check('(d) the last request has no cursor', requests.at(-1).has('cursor'), false)
  await search(page).fill('')
  check('(d) clearing it reads 1-25 of 60', await rangeBecomes(page, 'Showing 1–25 of 60'), 'Showing 1–25 of 60')
  await next.click()
  await rangeBecomes(page, 'Showing 26–50 of 60')
  await page.locator('[data-testid="scheduled-page-size"]').selectOption('50')
  check('(d) a page-size change goes back to page 1', await rangeBecomes(page, 'Showing 1–50 of 60'), 'Showing 1–50 of 60')
  checkNoNative('d', native)
  await ctx.close()
}

// (e) The Due card links to the view.
async function dueLink(browser) {
  console.log('\n=== (e) "See everything scheduled" switches the view and the URL; a reload keeps it')
  const today = manilaToday()
  const u = await makeUser('e')
  const bank = await account(u, 'E Checking')
  await planned(u, bank, addDays(today, 50), 'E Later row')
  const { ctx, page, native } = await newPage(browser)
  await uiLogin(page, u)
  await openTransactions(page)
  for (const slug of ['upcoming', 'subscriptions']) {
    await openDueTab(page, slug)
    check(`(e) the ${slug} panel has the link`, await page.locator(`[data-testid="due-panel-${slug}"] [data-testid="see-scheduled-link"]`).count(), 1)
  }
  check('(e) the Subscriptions link sits beside Manage recurring entries',
    await page.locator('[data-testid="due-panel-subscriptions"] [data-testid="manage-recurring-link"]').count(), 1)
  await openDueTab(page, 'upcoming')
  await page.locator('[data-testid="due-panel-upcoming"] [data-testid="see-scheduled-link"]').click()
  await scheduledReady(page)
  check('(e) the view is Scheduled', [await pressed(page, 'scheduled'), await pressed(page, 'to-date')], ['true', 'false'])
  check('(e) the URL carries view=scheduled', new URL(page.url()).searchParams.get('view'), 'scheduled')
  check('(e) the list is on screen', await page.locator('[data-testid="transactions-list-card"]').evaluate((el) => {
    const r = el.getBoundingClientRect()
    return r.top < window.innerHeight && r.bottom > 0
  }), true)
  check('(e) it lists the T+50 row', await names(page), ['E Later row'])
  await page.reload()
  await page.locator(VIEW).waitFor()
  await scheduledReady(page)
  check('(e) a reload keeps the view', [await pressed(page, 'scheduled'), await names(page)], ['true', ['E Later row']])
  checkNoNative('e', native)
  await ctx.close()
}

// (f) Shared and household viewers.
async function viewers(browser) {
  console.log('\n=== (f) a viewer\'s occurrence has no record buttons; a tag viewer sees the Limited row and no occurrence')
  const today = manilaToday()
  const owner = await makeUser('f-owner')
  const editor = await makeUser('f-editor')
  const holder = await makeUser('f-tag')
  const joint = await account(owner, 'F Joint')
  const editorOwn = await account(editor, 'F Editor own')
  await post(owner.token, `/accounts/${joint.id}/shares`, { email: editor.email, role: 'editor' })
  await planned(owner, joint, addDays(today, 6), 'F Joint txn')
  await entry(owner, { name: 'F Owner plan', account_id: joint.id, next_occurrence: wire(addDays(today, 7)) })

  // The editor records an entry on the joint account, then is made a viewer: their own entry lists, with nothing to record.
  await entry(editor, { name: 'F Editor plan', account_id: joint.id, next_occurrence: wire(addDays(today, 8)) })
  const asEditor = await get(editor.token, '/transactions/scheduled?limit=100')
  const editorView = asEditor.items.filter((i) => i.kind === 'occurrence').map((i) => [i.occurrence.name, i.occurrence.recordable])
  console.log(`    the editor's occurrences: ${JSON.stringify(editorView)}`)
  const e1 = await newPage(browser)
  await uiLogin(e1.page, editor)
  await openScheduled(e1.page)
  const editorRows = await readRows(e1.page)
  check('(f) the editor lists the sharer\'s rows with record buttons where recordable',
    editorRows.filter((r) => r.kind === 'occurrence').map((r) => [r.name, r.buttons.some((b) => /^upcoming-(mark|charged|posted)/.test(b))]),
    editorView)
  await e1.ctx.close()
  const demoted = stack.psql(`UPDATE account_shares SET role = 'viewer' WHERE account_id = ${joint.id} AND role = 'editor'`)
  check('(f) the editor was made a viewer', demoted, 'UPDATE 1')
  const asViewer = await get(editor.token, '/transactions/scheduled?limit=100')
  const viewerOccurrences = asViewer.items.filter((i) => i.kind === 'occurrence')
  console.log(`    the viewer's occurrences: ${JSON.stringify(viewerOccurrences.map((i) => [i.occurrence.name, i.occurrence.recordable]))}`)
  const v = await newPage(browser)
  await uiLogin(v.page, editor)
  await openScheduled(v.page)
  const viewerRows = await readRows(v.page)
  check('(f) the viewer lists the shared transaction row', viewerRows.some((r) => r.name === 'F Joint txn'), true)
  check('(f) the viewer\'s occurrence rows are the API\'s', viewerRows.filter((r) => r.kind === 'occurrence').map((r) => r.name), viewerOccurrences.map((i) => i.occurrence.name))
  check('(f) the viewer has an occurrence of their own to look at', viewerOccurrences.length > 0, true)
  check('(f) no occurrence row has a record button, Review or Change date', viewerRows.filter((r) => r.kind === 'occurrence').map((r) => r.buttons), viewerOccurrences.map(() => []))
  checkNoNative('f', v.native)
  await v.ctx.close()

  // A Household tag viewer: the Limited transaction row is listed, its occurrence is not.
  const tags = await get(owner.token, '/tags/')
  const household = (tags.items ?? tags).find((t) => t.is_system && t.name === 'Household')
  if (!household) throw new Error(`no Household tag: ${JSON.stringify(tags)}`)
  const home = await account(owner, 'F Home')
  await post(owner.token, '/tags/household/shares', { email: holder.email })
  await planned(owner, home, addDays(today, 9), 'F Home txn', 100, { tag_ids: [household.id] })
  await entry(owner, { name: 'F Home plan', account_id: home.id, next_occurrence: wire(addDays(today, 10)), tag_ids: [household.id] })
  const asHolder = await get(holder.token, '/transactions/scheduled?limit=100')
  console.log(`    the tag viewer's API rows: ${JSON.stringify(asHolder.items.map((i) => [i.kind, i.transaction?.view ?? i.occurrence?.view]))}`)
  const t = await newPage(browser)
  await uiLogin(t.page, holder)
  await openScheduled(t.page)
  const holderRows = await readRows(t.page)
  check('(f) the tag viewer\'s Limited transaction row is listed', holderRows.map((r) => [r.kind, r.view]), asHolder.items.map((i) => [i.kind === 'transaction' ? 'upcoming' : 'occurrence', i.transaction?.view ?? i.occurrence?.view]))
  check('(f) it is the one Limited row and no occurrence is listed', [holderRows.length, holderRows[0]?.view, holderRows.filter((r) => r.kind === 'occurrence').length], [1, 'limited', 0])
  checkNoNative('f', t.native)
  await t.ctx.close()
  void editorOwn
}

// (g) 390px.
async function phone(browser) {
  console.log('\n=== (g) at 390px: no horizontal scroll and 44px targets')
  const today = manilaToday()
  const u = await makeUser('g')
  const bank = await account(u, 'G Checking')
  for (let n = 1; n <= 30; n++) await planned(u, bank, addDays(today, 1 + n), `G Row ${String(n).padStart(2, '0')}`, 10)
  await entry(u, { name: 'G Annual', account_id: bank.id, next_occurrence: wire(addDays(today, 3)) })
  const { ctx, page, native } = await newPage(browser, { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true })
  await uiLogin(page, u)
  await openScheduled(page)
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
  check('(g) the page does not scroll sideways', overflow <= 0, true)
  const small = await page.evaluate(() => {
    const scope = [...document.querySelectorAll('[data-testid="scheduled-view"] button, [data-testid="scheduled-view"] select, [data-testid="view-to-date"], [data-testid="view-scheduled"]')]
    return scope.filter((el) => el.getBoundingClientRect().height > 0).map((el) => ({ id: el.dataset.testid ?? el.textContent.trim(), h: Math.round(el.getBoundingClientRect().height), w: Math.round(el.getBoundingClientRect().width) })).filter((x) => x.h < 44 || x.w < 44)
  })
  check('(g) every Scheduled button, the select and the view switch are at least 44px', small, [])
  check('(g) the list has rows (the check is not vacuous)', (await readRows(page)).length >= 25, true)
  const occButtons = await page.locator(`${LIST} li[data-kind="occurrence"] button`).count()
  check('(g) the occurrence row has its buttons', occButtons >= 2, true)
  checkNoNative('g', native)
  await ctx.close()
}

// (h) An old API answers 422.
async function oldApi(browser) {
  console.log('\n=== (h) an old API (422 on /transactions/scheduled): an inline error with Retry, the page keeps working')
  const today = manilaToday()
  const u = await makeUser('h')
  const bank = await account(u, 'H Checking')
  await planned(u, bank, addDays(today, 12), 'H Row')
  const { ctx, page, native } = await newPage(browser)
  await uiLogin(page, u)
  let fail = true
  await page.route((url) => url.pathname.endsWith('/transactions/scheduled'), (route) =>
    fail ? route.fulfill({ status: 422, json: { detail: [{ msg: 'Input should be a valid integer' }] } }) : route.continue())
  await openTransactions(page, '?view=scheduled')
  await page.locator('[data-testid="scheduled-error"]').waitFor({ timeout: 15000 })
  check('(h) an inline error shows in the Scheduled view under the list card', await page.locator('[data-testid="scheduled-view"] [data-testid="scheduled-error"]').count(), 1)
  check('(h) with a Retry button', await page.locator('[data-testid="scheduled-retry"]').count(), 1)
  check('(h) no list and no pager', [await page.locator(LIST).count(), await page.locator('[data-testid="scheduled-pager"]').count()], [0, 0])
  check('(h) the Due card still loads', await page.locator('[data-testid="due-count"]').filter({ hasNotText: '…' }).count(), 1)
  check('(h) the view switch still works', await page.locator('[data-testid="view-to-date"]').isEnabled(), true)
  fail = false
  await page.locator('[data-testid="scheduled-retry"]').click()
  await scheduledReady(page)
  check('(h) Retry loads the list once the API answers', await names(page), ['H Row'])
  check('(h) the error is gone', await page.locator('[data-testid="scheduled-error"]').count(), 0)
  checkNoNative('h', native)
  await ctx.close()
}

// (i) The recurring-payments note and the From and Through inputs.
async function throughNote(browser) {
  console.log('\n=== (i) Through past today + 730 shows the recurring note; the inputs read From and Through')
  const today = manilaToday()
  const u = await makeUser('i')
  const bank = await account(u, 'I Checking')
  await planned(u, bank, addDays(today, 900), 'I Far row')
  await entry(u, { name: 'I Annual', account_id: bank.id, next_occurrence: wire(addDays(today, 5)) })
  const { ctx, page, native } = await newPage(browser)
  await uiLogin(page, u)
  await openScheduled(page)
  check('(i) no note by default', await page.locator('[data-testid="scheduled-through-note"]').count(), 0)
  await showFilters(page)
  check('(i) the date inputs are From and Through', [await page.getByLabel('From', { exact: true }).count(), await page.getByLabel('Through', { exact: true }).count()], [1, 1])
  check('(i) no custom start and end labels', await page.getByText('Custom start date').count(), 0)
  const through = addDays(today, 1000)
  // The screen loader blocks input while a request is in flight.
  await waitQuiet(page)
  await page.locator('[data-testid="scheduled-through"]').fill(through)
  await page.locator('[data-testid="scheduled-through-note"]').waitFor({ timeout: 10000 })
  await scheduledReady(page)
  const horizon = new Date(`${addDays(today, 730)}T00:00:00Z`)
  const note = (await page.locator('[data-testid="scheduled-through-note"]').textContent())?.trim()
  check('(i) the note names the horizon', note?.startsWith('Recurring payments are listed through ') && note.endsWith('; one-off transactions continue after it'), true)
  check('(i) the note\'s day is today + 730', note?.includes(String(horizon.getUTCFullYear())), true)
  const listed = await get(u.token, `/transactions/scheduled?limit=100&end_date=${through}T23:59:59.999999Z`)
  check('(i) the API says occurrences stop at today + 730', listed.occurrences_through, addDays(today, 730))
  const rows = await readRows(page)
  check('(i) the T+900 one-off is listed and the annual occurrence is too (its next is inside the horizon)', rows.some((r) => r.name === 'I Far row'), true)
  check('(i) Reset filters clears the custom Through', await page.getByRole('button', { name: 'Reset filters' }).count(), 1)
  await page.getByRole('button', { name: 'Reset filters' }).click()
  await page.locator('[data-testid="scheduled-through-note"]').waitFor({ state: 'detached', timeout: 10000 })
  check('(i) the note is gone after the reset', await page.locator('[data-testid="scheduled-through-note"]').count(), 0)
  checkNoNative('i', native)
  await ctx.close()
}

;(async () => {
  stack = await startLocalStack()
  API = `${stack.apiUrl}/api/v1`
  const browser = await chromium.launch()
  const run = (k) => !only || only === k
  if (run('a')) await farRows(browser)
  if (run('b')) await searchAndAccount(browser)
  if (run('c')) await rowActions(browser)
  if (run('d')) await pager(browser)
  if (run('e')) await dueLink(browser)
  if (run('f')) await viewers(browser)
  if (run('g')) await phone(browser)
  if (run('h')) await oldApi(browser)
  if (run('i')) await throughNote(browser)
  await browser.close()
  stack.stop()
  console.log(`\nRESULT: ${pass}/${total} assertions passed`)
  process.exit(pass === total ? 0 : 1)
})().catch((e) => { console.error(e); stack?.stop(); console.log(`\nRESULT (aborted): ${pass}/${total} assertions passed`); process.exit(1) })
