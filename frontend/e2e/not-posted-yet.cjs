// Browser check for STU-485: the "Not posted yet" tab beside "Due and overdue" on the
// Transactions page. One card, two tabs. One-off pending rows (no recurring link) dated
// today and earlier are on Not posted yet, each as "logged N days ago" or "logged today";
// pending recurring charges and rows tied to a recurring entry stay in Due and overdue.
// Starts its own API and web app against a throwaway database (./_local_stack.cjs). Not
// wired into CI and not part of `pnpm build`. Run steps: see ./README.md.
//
// Needs the API with STU-485's delete-handler fix (deleting a recurring entry clears
// is_recurring on the rows linked to it), which (g) reads through the API.
//
// Every scenario seeds its own users, so each can run alone. Dates are relative to
// Manila's today. Every scenario tracks native dialogs (none may fire), and every
// request-starting action is followed by waitQuiet(page); see ./README.md.
//
// Scenarios:
//   (a) the split: tablist, tab and tabpanel roles with their aria-controls and
//       aria-labelledby; Due holds the hand-linked Water bill, a Charged Netflix row and
//       Rent; Not posted yet holds Coffee, Fee and Lunch, oldest first, with "logged ..."
//       text, Mark posted and no Overdue; Later (tomorrow+) is in neither
//   (b) keyboard and focus order: toggle, selected tab, selected panel; roving tabindex;
//       arrow keys wrap, Home and End; collapsed, Tab leaves the card
//   (c) Mark posted on Not posted yet: one PUT, the row leaves, the badge drops, the tab stays
//   (d) STU-474's review notice, its checkboxes and Post now live on Due only; the ticks
//       survive a visit to Not posted yet
//   (e) empty tabs: both tabs show at 0, nothing switches by itself
//   (f) the Manila day in a Los Angeles browser: "logged N days ago" counts Manila days,
//       and moves at Manila midnight with no reload
//   (g) roles and tied non-card rows: owner, editor, viewer, tag viewer; a row tied to a
//       paused entry stays in Due; a row whose entry was deleted is a one-off for everyone
//   (h) collapsed: both panel shells stay, hidden and empty, with their relationships;
//       the tab is remembered while the page is open, never across a reload
//   (i) each tab pages on its own
//   (j) at 360 x 740: no sideways scroll; every tab is in the viewport, not clipped and at
//       least 24 px tall; End brings the last tab into view; every badge is visible
//
// The tab-structure expectations in (a), (b) and (h) are built from DUE_TABS
// (./_due_pages.cjs), so a new tab is one entry there.
//
// Usage: node frontend/e2e/not-posted-yet.cjs [a|b|c|d|e|f|g|h|i|j]
// Exit 0 when every check passed, 1 when one failed, 2 when the stack did not start.
const { startLocalStack, consumePageOpen } = require('./_local_stack.cjs')
const { DUE_TABS, allDueRows, rowsOf, showRow, goToPage, currentPage, pagerLabel, hasPager, openDueTab } = require('./_due_pages.cjs')
const { waitQuiet } = require('./_smooth.cjs')
const dialogs = require('./_dialogs.cjs')

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
async function put(token, url, body) {
  const r = await api(token, 'PUT', url, body)
  if (r.status >= 300) throw new Error(`PUT ${url} ${r.status} ${JSON.stringify(r.json)}`)
  return r.json
}
const get = async (token, url) => {
  const r = await api(token, 'GET', url)
  if (r.status >= 300) throw new Error(`GET ${url} ${r.status} ${JSON.stringify(r.json)}`)
  return r.json
}

async function makeUser(tag) {
  const email = `e2e-nps-${tag}-${Math.random().toString(16).slice(2, 8)}@example.com`
  const password = 'E2eTest!2345'
  const reg = await api('', 'POST', '/auth/register', { email, password, first_name: `User${tag}`, last_name: 'Test', default_currency: 'PHP' })
  if (reg.status !== 200 && reg.status !== 201) throw new Error(`register ${reg.status} ${JSON.stringify(reg.json)}`)
  stack.verifyUser(email) // aborts the run unless psql reports UPDATE 1
  const login = await api('', 'POST', '/auth/login', { email, password })
  if (login.status !== 200) throw new Error(`login ${login.status}`)
  return { email, password, tag, token: login.json.access_token }
}
/** A user who will open Transactions with installments: takes their page-open claim now, before any entry exists. */
async function makeOpener(tag) {
  const u = await makeUser(tag)
  await consumePageOpen(api, u)
  return u
}
const account = (u, name, type = 'checking', balance = 100000) =>
  post(u.token, '/accounts/', { name, account_type: type, balance, currency: 'PHP' })
/** A card closing on day `close` of each month, due 21 days later, paid from `bank`. */
const card = (u, bank, name, close = 24) => post(u.token, '/accounts/', {
  name, account_type: 'credit', balance: 0, currency: 'PHP', credit_limit: 1000000,
  billing_cycle_start: close, days_until_due_date: 21, payment_account_id: bank.id,
})
const entry = (u, fields) => post(u.token, '/budget-entries/', { entry_type: 'expense', currency: 'PHP', cadence: 'monthly', ...fields })
/** A pending debit; `entryId` hand-links it to a recurring entry. */
const unposted = (u, acct, day, amount, description, entryId) => post(u.token, '/transactions/', {
  account_id: acct.id, transaction_type: 'debit', amount, description, transaction_date: wire(day), is_posted: false,
  ...(entryId === undefined ? {} : { budget_entry_id: entryId }),
})
/** A one-occurrence entry whose only month was `daysAgo` days back, and the pending row that stands for it. */
async function linkedPending(u, acct, entryName, rowName, daysAgo, today) {
  const day = addDays(today, -daysAgo)
  const plan = await entry(u, {
    name: entryName, amount: 900, account_id: acct.id, next_occurrence: wire(day),
    end_mode: 'after_occurrences', max_occurrences: 1,
  })
  const row = await unposted(u, acct, day, 900, rowName, plan.id)
  return { plan, row }
}

/** A page with its native-dialog tracker pushed onto `natives`. */
async function newPage(browser, natives, contextOptions = {}) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 1400 }, ...contextOptions })
  const page = await ctx.newPage()
  natives.push(dialogs.trackNativeDialogs(page))
  if (process.env.DEBUG) page.on('response', (r) => { if (r.url().includes('/api/v1/')) console.log(`    [net] ${r.request().method()} ${r.url().replace(API, '')} -> ${r.status()}`) })
  return { ctx, page }
}
async function uiLogin(page, u) {
  await page.goto(`${stack.webUrl}/login`)
  await page.locator('#email').fill(u.email)
  await page.locator('#password').fill(u.password)
  await page.getByRole('button', { name: 'Sign in', exact: true }).click()
  await page.waitForURL((url) => url.pathname === '/')
  await waitQuiet(page)
}
const settle = async (page) => { await page.waitForLoadState('networkidle'); await page.waitForTimeout(500) }
async function openTransactions(page) {
  await page.goto(`${stack.webUrl}/transactions`)
  await page.locator('[data-testid="due-section"]').waitFor()
  await page.locator('[data-testid="due-count"]').filter({ hasNotText: '…' }).waitFor()
  await settle(page)
  await waitQuiet(page)
}
/** Signs in and opens Transactions with the card loaded; the Due tab is selected. */
async function openCard(browser, natives, u, contextOptions = {}) {
  const { ctx, page } = await newPage(browser, natives, contextOptions)
  await uiLogin(page, u)
  await openTransactions(page)
  return { ctx, page }
}
const checkNoNative = (scenario, natives) =>
  check(`(${scenario}) no browser dialog fired`, natives.reduce((n, t) => n + t.count, 0), 0)

const tid = (id) => `[data-testid="${id}"]`
// The card's tabs, in order (./_due_pages.cjs): N of them, the first selected on load.
const N = DUE_TABS.length
const FIRST = DUE_TABS[0]
const LAST = DUE_TABS[N - 1]
const NOT_POSTED = DUE_TABS.find((t) => t.slug === 'not-posted')
const text = async (locator) => (await locator.textContent())?.replace(/\s+/g, ' ').trim()
const dueBadge = async (page) => text(page.locator(tid('due-count')))
const npBadge = async (page) => text(page.locator(tid('due-not-posted-count')))
const names = (rows) => rows.map((r) => r.name)
const selectedTab = (page) => page.evaluate(() =>
  document.querySelector('[role="tab"][aria-selected="true"]')?.getAttribute('data-testid') ?? null)
/** Waits for the Not posted badge to read `value` (bounded, never throws). */
const waitForNpBadge = (page, value, ms = 15000) =>
  page.locator(tid('due-not-posted-count')).filter({ hasText: new RegExp(`^${value}$`) }).waitFor({ timeout: ms }).catch(() => {})

/** The card's tab and panel relationships, read from the DOM. */
const structure = (page) => page.evaluate(() => {
  const section = document.querySelector('[data-testid="due-section"]')
  const all = (sel) => [...section.querySelectorAll(sel)]
  const tabs = all('[role="tab"]').map((tab) => {
    const panel = document.getElementById(tab.getAttribute('aria-controls') ?? '')
    return {
      tab: tab.getAttribute('data-testid'),
      selected: tab.getAttribute('aria-selected'),
      tabindex: tab.getAttribute('tabindex'),
      panel: panel?.getAttribute('data-testid') ?? null,
      panelRole: panel?.getAttribute('role') ?? null,
      labelledBack: panel ? document.getElementById(panel.getAttribute('aria-labelledby') ?? '') === tab : false,
      hidden: panel ? panel.hidden : null,
      children: panel ? panel.childElementCount : null,
    }
  })
  const toggle = section.querySelector('[data-testid="due-section-toggle"]')
  const controls = (toggle?.getAttribute('aria-controls') ?? '').split(/\s+/).filter(Boolean)
  return {
    tablists: all('[role="tablist"]').length,
    tabs,
    panels: all('[role="tabpanel"]').length,
    toggleControls: controls.map((id) => document.getElementById(id)?.getAttribute('data-testid') ?? null),
  }
})

/** The page's own posting form, opened from a row's button: save the posted amount. */
async function savePosted(page, txnId) {
  const put = page.waitForResponse((r) => r.request().method() === 'PUT' && new URL(r.url()).pathname.endsWith(`/transactions/${txnId}`))
  await page.getByRole('button', { name: 'Save Posted Amount' }).click()
  return put
}
/** Posting keeps the actions modal open, and its overlay blocks later clicks: close it. */
async function closeActions(page) {
  const close = page.getByRole('button', { name: 'Close actions modal' })
  await close.click()
  await close.waitFor({ state: 'hidden' })
}
const gone = (locator) => locator.first().waitFor({ state: 'detached', timeout: 15000 }).catch(() => {})
const rowByName = (page, name) =>
  page.locator(tid('due-row')).filter({ has: page.locator('p', { hasText: new RegExp(`^${name}$`) }) })

// ─── Seeds ───────────────────────────────────────────────────────────────────
/** The three one-offs that are on Not posted yet: Lunch (today), Coffee (-5, card) and Fee (-1). */
async function oneOffs(u, bank, visa, today) {
  const lunch = await unposted(u, bank, today, 250, 'Lunch')
  const coffee = await unposted(u, visa, addDays(today, -5), 180, 'Coffee')
  const fee = await unposted(u, bank, addDays(today, -1), 35, 'Fee')
  return { lunch, coffee, fee }
}

// (a) The split.
async function theSplit(browser) {
  console.log('\n=== (a) one-offs on Not posted yet, tied and recurring rows in Due')
  const natives = []
  const u = await makeUser('a')
  const today = manilaToday()
  const bank = await account(u, 'A Checking')
  const visa = await card(u, bank, 'A Visa')
  await oneOffs(u, bank, visa, today)
  await unposted(u, bank, addDays(today, 3), 90, 'Later')
  await linkedPending(u, bank, 'Water', 'Water bill', 20, today)
  const netflix = await entry(u, { name: 'Netflix', amount: 549, account_id: visa.id, next_occurrence: wire(today) })
  const charged = await api(u.token, 'POST', `/budget-entries/${netflix.id}/materialize`, { is_posted: false })
  check('(a) Netflix is Charged: one pending row (201)', charged.status, 201)
  await entry(u, { name: 'Rent', amount: 15000, account_id: bank.id, next_occurrence: wire(today) })

  const { ctx, page } = await openCard(browser, natives, u)
  const s = await structure(page)
  check(`(a) one tablist, ${N} tabs, ${N} tabpanels`, [s.tablists, s.tabs.length, s.panels], [1, N, N])
  check('(a) Due is selected, no other tab is', s.tabs.map((t) => [t.tab, t.selected]), DUE_TABS.map((t) => [t.tab, t === FIRST ? 'true' : 'false']))
  check('(a) each tab controls a tabpanel that is labelled by it back',
    s.tabs.map((t) => [t.panel, t.panelRole, t.labelledBack]), DUE_TABS.map((t) => [t.panel, 'tabpanel', true]))
  check('(a) every inactive panel is hidden and has no children', s.tabs.map((t) => [t.hidden, t.children === 0]),
    DUE_TABS.map((t) => (t === FIRST ? [false, false] : [true, true])))

  const due = await allDueRows(page)
  check('(a) Due holds exactly Water bill, Netflix and Rent', [due.length, ['Water bill', 'Netflix', 'Rent'].map((n) => due.filter((r) => r.text.includes(n)).length)], [3, [1, 1, 1]])
  check('(a) no one-off is in Due', ['Lunch', 'Coffee', 'Fee', 'Later'].map((n) => due.filter((r) => r.name === n).length), [0, 0, 0, 0])
  check('(a) the Due badge is the number of rows over every page', Number(await dueBadge(page)), due.length)

  await openDueTab(page, 'not-posted')
  const np = await allDueRows(page)
  check('(a) Not posted yet lists Coffee, Fee and Lunch, oldest first', names(np), ['Coffee', 'Fee', 'Lunch'])
  check('(a) each reads how long ago it was logged', np.map((r) => r.logged), ['logged 5 days ago', 'logged 1 day ago', 'logged today'])
  check('(a) no row is marked Overdue and each has Mark posted', [np.map((r) => r.overdue), np.map((r) => r.buttons)], [[false, false, false], [['due-mark-posted'], ['due-mark-posted'], ['due-mark-posted']]])
  check('(a) the badge reads 3', await npBadge(page), '3')
  check('(a) Later, Water bill and Netflix are not on it', ['Later', 'Water bill', 'Netflix'].map((n) => np.filter((r) => r.text.includes(n)).length), [0, 0, 0])
  const s2 = await structure(page)
  check('(a) now Not posted yet is selected and every other shell is empty and hidden',
    s2.tabs.map((t) => [t.tab, t.selected, t.hidden, t.children === 0]),
    DUE_TABS.map((t) => (t === NOT_POSTED ? [t.tab, 'true', false, false] : [t.tab, 'false', true, true])))
  checkNoNative('a', natives)
  await ctx.close()
}

// (b) Keyboard and focus order.
async function keyboard(browser) {
  console.log('\n=== (b) keyboard and focus order')
  const natives = []
  const u = await makeUser('b')
  const today = manilaToday()
  const bank = await account(u, 'B Checking')
  const visa = await card(u, bank, 'B Visa')
  await oneOffs(u, bank, visa, today)
  await entry(u, { name: 'Rent', amount: 15000, account_id: bank.id, next_occurrence: wire(today) })
  const { ctx, page } = await openCard(browser, natives, u)

  const active = () => dialogs.activeTestId(page)
  /** Presses a key, then waits (bounded) for focus to land on `expected`; returns where it is. */
  const press = async (key, expected) => {
    await page.keyboard.press(key)
    const until = Date.now() + 2000
    let at = await active()
    while (at !== expected && Date.now() < until) { await page.waitForTimeout(50); at = await active() }
    return at
  }
  const selected = async () => (await structure(page)).tabs.filter((t) => t.selected === 'true').map((t) => t.tab)
  const inCard = () => page.evaluate(() => document.activeElement?.closest('[data-testid="due-section"]') !== null && document.activeElement !== document.body)

  await waitQuiet(page)
  await page.locator(tid('due-section-toggle')).focus()
  check('(b) the toggle has focus', await active(), 'due-section-toggle')
  check('(b) Tab: the selected tab', await press('Tab', FIRST.tab), FIRST.tab)
  check('(b) roving tabindex: 0 on the selected tab, -1 on every other', (await structure(page)).tabs.map((t) => t.tabindex),
    DUE_TABS.map((t) => (t === FIRST ? '0' : '-1')))
  check('(b) Tab: the selected panel', await press('Tab', FIRST.panel), FIRST.panel)
  check('(b) Shift+Tab: back to the selected tab', await press('Shift+Tab', FIRST.tab), FIRST.tab)
  check('(b) Shift+Tab: back to the toggle, skipping the other tabs', await press('Shift+Tab', 'due-section-toggle'), 'due-section-toggle')

  await press('Tab', FIRST.tab)
  // ArrowRight walks every tab in DUE_TABS order; Tab and Shift+Tab move between each tab and its panel.
  for (const t of DUE_TABS.slice(1)) {
    check(`(b) ArrowRight: focus and selection move to ${t.tab}`, [await press('ArrowRight', t.tab), await selected()], [t.tab, [t.tab]])
    check(`(b) the panel switched with the tab (${t.panel})`, (await structure(page)).tabs.map((x) => x.hidden), DUE_TABS.map((x) => x !== t))
    check(`(b) Tab from it: ${t.panel}`, await press('Tab', t.panel), t.panel)
    check(`(b) Shift+Tab: back to ${t.tab}`, await press('Shift+Tab', t.tab), t.tab)
  }
  const before = DUE_TABS[N - 2]
  check('(b) ArrowRight on the last tab wraps to the first', [await press('ArrowRight', FIRST.tab), await selected()], [FIRST.tab, [FIRST.tab]])
  check('(b) ArrowLeft on the first tab wraps to the last', [await press('ArrowLeft', LAST.tab), await selected()], [LAST.tab, [LAST.tab]])
  check('(b) ArrowLeft moves to the previous tab', [await press('ArrowLeft', before.tab), await selected()], [before.tab, [before.tab]])
  check('(b) End: the last tab', [await press('End', LAST.tab), await selected()], [LAST.tab, [LAST.tab]])
  check('(b) Home: the first tab', [await press('Home', FIRST.tab), await selected()], [FIRST.tab, [FIRST.tab]])
  await waitQuiet(page)

  // Collapsed: both panels are hidden, so Tab from the selected tab leaves the card.
  await page.locator(tid('due-section-toggle')).click()
  await page.locator(`${tid('due-section-toggle')}[aria-expanded="false"]`).waitFor()
  await page.locator(tid('due-section-toggle')).focus()
  check('(b) collapsed: Tab from the toggle reaches the selected tab', await press('Tab', 'due-tab-due'), 'due-tab-due')
  await page.keyboard.press('Tab')
  check('(b) collapsed: the next Tab leaves the card', await inCard(), false)
  check('(b) collapsed: Shift+Tab returns to the selected tab', await press('Shift+Tab', 'due-tab-due'), 'due-tab-due')
  checkNoNative('b', natives)
  await ctx.close()
}

// (c) Mark posted.
async function markPosted(browser) {
  console.log('\n=== (c) Mark posted on Not posted yet: one PUT, the row leaves, the tab stays')
  const natives = []
  const u = await makeUser('c')
  const today = manilaToday()
  const bank = await account(u, 'C Checking')
  const visa = await card(u, bank, 'C Visa')
  const rows = await oneOffs(u, bank, visa, today)
  const { ctx, page } = await openCard(browser, natives, u)
  await openDueTab(page, 'not-posted')
  const puts = []
  page.on('request', (r) => { if (r.method() === 'PUT' && new URL(r.url()).pathname.endsWith(`/transactions/${rows.fee.id}`)) puts.push(r) })
  check('(c) the badge reads 3 before', await npBadge(page), '3')
  await (await showRow(page, rowByName(page, 'Fee'))).locator(tid('due-mark-posted')).click()
  const res = await savePosted(page, rows.fee.id)
  check('(c) posting Fee returns 200 and sends one PUT', [res.status(), puts.length], [200, 1])
  await closeActions(page)
  await gone(rowByName(page, 'Fee'))
  await waitForNpBadge(page, '2')
  await waitQuiet(page)
  check('(c) Fee left the tab and the badge reads 2', [(await rowsOf(page, 'Fee', 'pending')).length, await npBadge(page)], [0, '2'])
  check('(c) Not posted yet is still selected', await selectedTab(page), 'due-tab-not-posted')
  const txn = (await get(u.token, `/transactions/${rows.fee.id}`))
  check('(c) the API has Fee posted', txn.is_posted, true)
  checkNoNative('c', natives)
  await ctx.close()
}

// (d) STU-474 is on Due only.
async function reviewOnDueOnly(browser) {
  console.log('\n=== (d) the review notice, its checkboxes and Post now are on Due only')
  const natives = []
  const u = await makeOpener('d')
  const today = manilaToday()
  const bank = await account(u, 'D Checking')
  const visa = await card(u, bank, 'D Visa', 28)
  await unposted(u, bank, addDays(today, -2), 60, 'D Lunch')
  // A clean, unreviewed installment: created from tomorrow, then its review flags cleared as the migration left older entries.
  const inst = await entry(u, {
    name: 'Laptop', amount: 1500, account_id: visa.id, next_occurrence: wire(addDays(today, 1)),
    end_mode: 'after_occurrences', max_occurrences: 12,
  })
  const out = stack.psql(`UPDATE budget_entries SET installment_reviewed_at = NULL, auto_post_enabled = false WHERE id IN (${Number(inst.id)})`)
  check('(d) clearing the review flags updated one entry', out, 'UPDATE 1')

  const { ctx, page } = await openCard(browser, natives, u)
  const toggle = page.locator(tid('due-review-notice-toggle'))
  await toggle.waitFor()
  if ((await toggle.getAttribute('aria-expanded')) !== 'true') await toggle.click()
  await page.locator(tid('due-review-notice-list')).waitFor()
  await waitQuiet(page)
  const box = page.locator(`${tid('due-review-notice-entry')}[data-source="budget_entry:${inst.id}"] ${tid('due-review-notice-select')}`)
  await box.check()
  check('(d) on Due the notice is open and the box is ticked', [await toggle.getAttribute('aria-expanded'), await box.isChecked()], ['true', true])

  await openDueTab(page, 'not-posted')
  const gone474 = ['due-review-notice', 'due-review-notice-toggle', 'due-review-notice-select', 'due-review-notice-select-all', 'due-review-selected', 'due-post-now', 'due-review-batch']
  const counts = []
  for (const id of gone474) counts.push(await page.locator(tid(id)).count())
  check('(d) on Not posted yet there is no notice, checkbox, selection button or Post now', counts, gone474.map(() => 0))
  check('(d) Not posted yet still lists D Lunch', names(await allDueRows(page)), ['D Lunch'])

  await openDueTab(page, 'due')
  check('(d) back on Due the notice is still expanded and the box still ticked',
    [await page.locator(tid('due-review-notice-toggle')).getAttribute('aria-expanded'), await box.isChecked()], ['true', true])
  checkNoNative('d', natives)
  await ctx.close()
}

// (e) Empty tabs.
async function emptyTabs(browser) {
  console.log('\n=== (e) both tabs show at 0 and the selection never switches by itself')
  const natives = []
  const today = manilaToday()
  {
    const u = await makeUser('e1')
    const bank = await account(u, 'E1 Checking')
    await unposted(u, bank, today, 40, 'E1 Lunch')
    await unposted(u, bank, addDays(today, -1), 35, 'E1 Fee')
    const { ctx, page } = await openCard(browser, natives, u)
    await waitForNpBadge(page, '2')
    check('(e) only one-offs: Due is empty, its badge 0, and Due is still selected',
      [await text(page.locator(tid('due-empty'))), await dueBadge(page), await selectedTab(page)], ['Nothing due or overdue in the next 30 days.', '0', 'due-tab-due'])
    check('(e) and the Not posted badge reads 2', await npBadge(page), '2')
    await ctx.close()
  }
  {
    const u = await makeUser('e2')
    const bank = await account(u, 'E2 Checking')
    await entry(u, { name: 'Rent', amount: 15000, account_id: bank.id, next_occurrence: wire(today) })
    const { ctx, page } = await openCard(browser, natives, u)
    await openDueTab(page, 'not-posted')
    check('(e) only Rent: Not posted yet shows its empty text with badge 0',
      [await text(page.locator(tid('due-not-posted-empty'))), await npBadge(page)], ['Nothing waiting to post.', '0'])
    check('(e) the tab that emptied stays selected and Due has its Rent row', [await selectedTab(page), await dueBadge(page)], ['due-tab-not-posted', '1'])
    check('(e) Not posted yet has no rows', await page.locator(tid('due-row')).count(), 0)
    await ctx.close()
  }
  checkNoNative('e', natives)
}

// (f) The Manila day, in a Los Angeles browser.
async function manilaDay(browser) {
  console.log('\n=== (f) "logged N days ago" counts Manila days, in a browser in Los Angeles')
  const natives = []
  const D = manilaToday()
  const u = await makeUser('f')
  const bank = await account(u, 'F Checking')
  await unposted(u, bank, addDays(D, -2), 20, 'F Old')
  await unposted(u, bank, addDays(D, -1), 30, 'F Mid')
  await unposted(u, bank, D, 40, 'F New')
  const { ctx, page } = await newPage(browser, natives, { timezoneId: 'America/Los_Angeles' })
  // Manila 23:58 on D-1 (15:58 UTC), two minutes before its midnight: the browser's own day is D-1 too.
  await page.clock.install({ time: new Date(`${addDays(D, -1)}T15:58:00Z`) })
  await uiLogin(page, u)
  await openTransactions(page)
  await openDueTab(page, 'not-posted')
  const days = () => page.evaluate(() => ({
    local: new Date().toLocaleDateString('en-CA'),
    manila: new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10),
  }))
  let d = await days()
  check('(f) before midnight the browser\'s day equals Manila\'s (both D-1)', [d.local, d.manila], [addDays(D, -1), addDays(D, -1)])
  let rows = await allDueRows(page)
  check('(f) before midnight: D-2 reads "logged 1 day ago", D-1 reads "logged today", D is absent',
    [names(rows), rows.map((r) => r.logged)], [['F Old', 'F Mid'], ['logged 1 day ago', 'logged today']])

  // Three minutes (Playwright reads '03:00' as mm:ss): 23:58 to 00:01 Manila, past midnight and the 30 s day poll. No reload.
  await page.clock.fastForward('03:00')
  await waitForNpBadge(page, '3')
  await settle(page)
  await waitQuiet(page)
  d = await days()
  check('(f) after midnight the browser\'s day (D-1) differs from Manila\'s (D)', [d.local, d.manila], [addDays(D, -1), D])
  rows = await allDueRows(page)
  check('(f) after midnight: "logged 2 days ago", "logged 1 day ago", and D appears as "logged today"',
    [names(rows), rows.map((r) => r.logged)], [['F Old', 'F Mid', 'F New'], ['logged 2 days ago', 'logged 1 day ago', 'logged today']])
  check('(f) Not posted yet is still selected', await selectedTab(page), 'due-tab-not-posted')
  checkNoNative('f', natives)
  await ctx.close()
}

// (g) Roles and tied non-card rows.
async function roles(browser) {
  console.log('\n=== (g) owner, editor, viewer and tag viewer; tied rows stay in Due')
  const natives = []
  const today = manilaToday()
  const owner = await makeUser('g-owner')
  const editor = await makeUser('g-editor')
  const viewer = await makeUser('g-viewer')
  const tagViewer = await makeUser('g-tagviewer')
  const joint = await account(owner, 'G Joint')
  await post(owner.token, `/accounts/${joint.id}/shares`, { email: editor.email, role: 'editor' })
  await post(owner.token, `/accounts/${joint.id}/shares`, { email: viewer.email, role: 'viewer' })
  await post(owner.token, '/tags/household/shares', { email: tagViewer.email })
  const household = (await get(owner.token, '/tags/')).find((t) => t.is_system)
  if (!household) throw new Error('STOP: the owner has no Household system tag')

  const snack = await unposted(owner, joint, addDays(today, -2), 80, 'Snack')
  await put(owner.token, `/transactions/${snack.id}`, { tag_ids: [household.id] })
  await linkedPending(owner, joint, 'Water', 'Water bill', 20, today)
  // Gym fee is tied to Gym, which is then paused: no missed row, but the row keeps its link.
  const gym = await entry(owner, { name: 'Gym', amount: 800, account_id: joint.id, next_occurrence: wire(addDays(today, -3)) })
  const gymFee = await unposted(owner, joint, addDays(today, -3), 800, 'Gym fee', gym.id)
  const paused = await api(owner.token, 'PUT', `/budget-entries/${gym.id}`, { is_active: false })
  check('(g) Gym is paused (200)', [paused.status, paused.json?.is_active], [200, false])
  const missedGym = (await get(owner.token, '/dashboard/snapshot')).missed.filter((m) => m.entry_id === gym.id)
  check('(g) the API shows no missed row for Gym', missedGym, [])
  // Old Plan fee is tied to Old Plan, which the owner then deletes: the row becomes a plain one-off.
  const oldPlan = await entry(owner, { name: 'Old Plan', amount: 400, account_id: joint.id, next_occurrence: wire(addDays(today, -4)) })
  const oldFee = await unposted(owner, joint, addDays(today, -4), 400, 'Old Plan fee', oldPlan.id)
  const deleted = await api(owner.token, 'DELETE', `/budget-entries/${oldPlan.id}`)
  check('(g) the owner deletes Old Plan (204)', deleted.status, 204)

  // The owner.
  {
    const { ctx, page } = await openCard(browser, natives, owner)
    const due = await allDueRows(page)
    check('(g) owner: Due holds Water bill and Gym fee, both overdue',
      [due.filter((r) => r.text.includes('Water bill')).map((r) => r.overdue), due.filter((r) => r.text.includes('Gym fee')).map((r) => r.overdue)], [[true], [true]])
    check('(g) owner: Snack and Old Plan fee are not in Due', ['Snack', 'Old Plan fee'].map((n) => due.filter((r) => r.text.includes(n)).length), [0, 0])
    await openDueTab(page, 'not-posted')
    check('(g) owner: Not posted yet holds Old Plan fee and Snack', names(await allDueRows(page)), ['Old Plan fee', 'Snack'])
    await ctx.close()
  }

  // The editor: shared_full rows, read through is_recurring.
  {
    const fee = await get(editor.token, `/transactions/${oldFee.id}`)
    check('(g) editor: the API shows Old Plan fee as shared_full with is_recurring false', [fee.view, fee.is_recurring], ['shared_full', false])
    const gymRow = await get(editor.token, `/transactions/${gymFee.id}`)
    check('(g) editor: the API shows Gym fee as shared_full with is_recurring true', [gymRow.view, gymRow.is_recurring], ['shared_full', true])
    const { ctx, page } = await openCard(browser, natives, editor)
    const due = await allDueRows(page)
    const water = due.filter((r) => r.text.includes('Water bill'))
    const gymDue = due.filter((r) => r.text.includes('Gym fee'))
    check('(g) editor: Water bill and Gym fee are in Due as shared_full, Gym fee overdue',
      [water.map((r) => r.view), gymDue.map((r) => r.view), gymDue.map((r) => r.overdue)], [['shared_full'], ['shared_full'], [true]])
    await openDueTab(page, 'not-posted')
    const np = await allDueRows(page)
    check('(g) editor: Not posted yet holds Old Plan fee and Snack, each with Mark posted', [names(np), np.map((r) => r.buttons)],
      [['Old Plan fee', 'Snack'], [['due-mark-posted'], ['due-mark-posted']]])
    check('(g) editor: Water bill and Gym fee are not on it', ['Water bill', 'Gym fee'].map((n) => np.filter((r) => r.text.includes(n)).length), [0, 0])
    await ctx.close()
  }

  // The viewer and the tag viewer see other people's rows as Limited: none on Not posted yet.
  for (const [who, u] of [['viewer', viewer], ['tag viewer', tagViewer]]) {
    const { ctx, page } = await openCard(browser, natives, u)
    await openDueTab(page, 'not-posted')
    check(`(g) ${who}: the badge reads 0 and the empty text shows`, [await npBadge(page), await page.locator(tid('due-not-posted-empty')).count(), await page.locator(tid('due-row')).count()], ['0', 1, 0])
    await ctx.close()
  }

  // The viewer's own one-off, on their own account, is listed.
  {
    const own = await account(viewer, 'G Viewer Checking')
    await unposted(viewer, own, addDays(today, -1), 25, 'V Own')
    const { ctx, page } = await openCard(browser, natives, viewer)
    await openDueTab(page, 'not-posted')
    check('(g) viewer: their own one-off is listed', [await npBadge(page), names(await allDueRows(page))], ['1', ['V Own']])
    await ctx.close()
  }
  checkNoNative('g', natives)
}

// (h) Collapsed state and memory.
async function collapsed(browser) {
  console.log('\n=== (h) collapsed: shells stay, empty and hidden; the tab is kept while the page is open')
  const natives = []
  const u = await makeUser('h')
  const today = manilaToday()
  const bank = await account(u, 'H Checking')
  const visa = await card(u, bank, 'H Visa')
  await oneOffs(u, bank, visa, today)
  await entry(u, { name: 'Rent', amount: 15000, account_id: bank.id, next_occurrence: wire(today) })
  const { ctx, page } = await openCard(browser, natives, u)
  const toggle = page.locator(tid('due-section-toggle'))
  await openDueTab(page, 'not-posted')
  const expandedAfter = async (value) => { await page.locator(`${tid('due-section-toggle')}[aria-expanded="${value}"]`).waitFor(); await waitQuiet(page) }

  await toggle.click()
  await expandedAfter('false')
  const s = await structure(page)
  check(`(h) collapsed: all ${N} tabpanel shells exist`, [s.panels, s.tabs.map((t) => t.panel)], [N, DUE_TABS.map((t) => t.panel)])
  check('(h) collapsed: every shell is hidden and has no children', s.tabs.map((t) => [t.hidden, t.children]), DUE_TABS.map(() => [true, 0]))
  check('(h) collapsed: no row and no list', [await page.locator(tid('due-row')).count(), await page.locator(tid('due-list')).count()], [0, 0])
  check('(h) each tab controls its shell and is labelled back', s.tabs.map((t) => [t.panelRole, t.labelledBack]), DUE_TABS.map(() => ['tabpanel', true]))
  check(`(h) the toggle controls all ${N} existing shells`, s.toggleControls, DUE_TABS.map((t) => t.panel))
  const shown = []
  for (const t of DUE_TABS) shown.push([t.slug, await page.locator(tid(t.tab)).isVisible(), await page.locator(tid(t.badge)).isVisible()])
  check('(h) every tab and its badge stay visible', shown, DUE_TABS.map((t) => [t.slug, true, true]))

  await toggle.click()
  await expandedAfter('true')
  check('(h) Show: Not posted yet is still selected, with its rows', [await selectedTab(page), names(await allDueRows(page))], ['due-tab-not-posted', ['Coffee', 'Fee', 'Lunch']])

  await toggle.click()
  await expandedAfter('false')
  await page.locator(tid('due-tab-due')).click()
  await expandedAfter('true')
  await page.locator(`${tid('due-tab-due')}[aria-selected="true"]`).waitFor()
  check('(h) collapsed, then the Due tab: the card opens on Due', [await toggle.getAttribute('aria-expanded'), await selectedTab(page), await page.locator(tid('due-list')).count()], ['true', 'due-tab-due', 1])

  await openDueTab(page, 'not-posted')
  await openTransactions(page) // a reload
  check('(h) after a reload Due is selected', await selectedTab(page), 'due-tab-due')
  checkNoNative('h', natives)
  await ctx.close()
}

// (i) Separate pagers.
async function pagers(browser) {
  console.log('\n=== (i) each tab pages on its own')
  const natives = []
  const u = await makeUser('i')
  const today = manilaToday()
  const bank = await account(u, 'I Checking')
  for (let n = 1; n <= 4; n++) await entry(u, { name: `I Bill ${n}`, amount: 1000, account_id: bank.id, next_occurrence: wire(today) })
  for (let n = 1; n <= 7; n++) await unposted(u, bank, addDays(today, -n), 10 + n, `I One ${n}`)
  const { ctx, page } = await openCard(browser, natives, u)
  check('(i) Due has 4 rows over 2 pages', [await dueBadge(page), await pagerLabel(page)], ['4', '1–3 of 4'])
  await goToPage(page, 2)
  check('(i) Due is on page 2', [await currentPage(page), await pagerLabel(page)], [2, '4–4 of 4'])

  await openDueTab(page, 'not-posted')
  check('(i) Not posted yet starts on page 1 of 7', [await npBadge(page), await hasPager(page), await currentPage(page), await pagerLabel(page)], ['7', true, 1, '1–3 of 7'])
  await goToPage(page, 3)
  check('(i) Not posted yet goes to page 3', [await currentPage(page), await pagerLabel(page)], [3, '7–7 of 7'])

  await openDueTab(page, 'due')
  check('(i) back on Due it is still on page 2', [await currentPage(page), await pagerLabel(page)], [2, '4–4 of 4'])
  checkNoNative('i', natives)
  await ctx.close()
}

// (j) The tablist on a phone.
async function narrow(browser) {
  console.log('\n=== (j) at 360 x 740 every tab and badge is on screen, with no sideways scroll')
  const natives = []
  const u = await makeUser('j')
  const today = manilaToday()
  const bank = await account(u, 'J Checking')
  const visa = await card(u, bank, 'J Visa')
  await oneOffs(u, bank, visa, today)
  await entry(u, { name: 'Rent', amount: 15000, account_id: bank.id, next_occurrence: wire(today) })
  const { ctx, page } = await openCard(browser, natives, u, { viewport: { width: 360, height: 740 } })
  await waitForNpBadge(page, '3')
  await page.locator('[role="tablist"]').first().scrollIntoViewIfNeeded()
  await waitQuiet(page)

  /** Each tab's box: in the viewport, not clipped by an ancestor or by its own content, and its badge inside it. */
  const boxes = () => page.evaluate((tabs) => {
    const vw = window.innerWidth, vh = window.innerHeight, e = 0.5
    const inside = (r, o) => r.left >= o.left - e && r.right <= o.right + e && r.top >= o.top - e && r.bottom <= o.bottom + e
    const view = { left: 0, top: 0, right: vw, bottom: vh }
    const clippedBy = (el) => {
      const r = el.getBoundingClientRect()
      for (let a = el.parentElement; a; a = a.parentElement) {
        const cs = getComputedStyle(a)
        if (cs.overflowX !== 'visible' || cs.overflowY !== 'visible') {
          if (!inside(r, a.getBoundingClientRect())) return a.tagName.toLowerCase()
        }
      }
      return null
    }
    return tabs.map((t) => {
      const tab = document.querySelector(`[data-testid="${t.tab}"]`)
      const badge = document.querySelector(`[data-testid="${t.badge}"]`)
      const r = tab.getBoundingClientRect()
      return {
        slug: t.slug,
        inView: inside(r, view),
        clippedBy: clippedBy(tab),
        overflows: tab.scrollWidth > tab.clientWidth,
        tall: r.height >= 24,
        badgeInTab: badge ? inside(badge.getBoundingClientRect(), r) : false,
      }
    })
  }, DUE_TABS)

  const width = await page.evaluate(() => document.documentElement.scrollWidth)
  check(`(j) no sideways scroll at 360 px (scrollWidth ${width})`, width <= 360, true)
  check('(j) every tab is in the viewport, not clipped, at least 24 px tall, with its badge inside it', await boxes(),
    DUE_TABS.map((t) => ({ slug: t.slug, inView: true, clippedBy: null, overflows: false, tall: true, badgeInTab: true })))
  const badges = []
  for (const t of DUE_TABS) badges.push([t.badge, await page.locator(tid(t.badge)).isVisible()])
  check('(j) every badge is visible', badges, DUE_TABS.map((t) => [t.badge, true]))

  await page.locator(tid(FIRST.tab)).focus()
  await page.keyboard.press('End')
  await page.locator(`${tid(LAST.tab)}[aria-selected="true"]`).waitFor({ timeout: 5000 })
  await waitQuiet(page)
  const last = (await boxes()).find((b) => b.slug === LAST.slug)
  check('(j) after End the last tab is selected, focused and in view, not clipped',
    [await selectedTab(page), await dialogs.activeTestId(page), last.inView, last.clippedBy], [LAST.tab, LAST.tab, true, null])
  checkNoNative('j', natives)
  await ctx.close()
}

;(async () => {
  try {
    stack = await startLocalStack()
  } catch (e) {
    console.error('SETUP FAILED', e)
    process.exit(2)
  }
  API = `${stack.apiUrl}/api/v1`
  const browser = await chromium.launch()
  const steps = { a: theSplit, b: keyboard, c: markPosted, d: reviewOnDueOnly, e: emptyTabs, f: manilaDay, g: roles, h: collapsed, i: pagers, j: narrow }
  for (const [k, fn] of Object.entries(steps)) {
    if (only && only !== k) continue
    try {
      await fn(browser)
    } catch (e) {
      check(`(${k}) the scenario ran to the end`, `threw: ${e && e.stack ? e.stack.split('\n').slice(0, 3).join(' | ') : e}`, 'completed')
    }
  }
  await browser.close()
  stack.stop()
  console.log(`\nRESULT: ${pass}/${total} assertions passed`)
  process.exit(pass === total ? 0 : 1)
})().catch((e) => { console.error(e); stack?.stop(); console.log(`\nRESULT (aborted): ${pass}/${total} assertions passed`); process.exit(1) })
