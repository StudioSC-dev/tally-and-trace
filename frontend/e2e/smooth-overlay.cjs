// Browser checks for the page under load with no screen loader (STU-335's scenarios, turned
// round by STU-605). STU-335 blocked input with one app-wide overlay while any request was
// in flight; STU-605 deleted it. Each scenario now holds the same request and asserts the
// new rule: no `busy-overlay` element ever exists, the page takes input while the request is
// held, the figures already on screen stay while a refetch is held, and the outcome lands
// once it is released. A dialog that still awaits its own save (Pay and the minimum due on
// an account's card panel, a share's role) keeps its own pending state; the Transactions
// page and the Due card save in the background (see ./background-saves.cjs). An area slow
// for 20 s offers an inline "Still loading. Reload" (`slow-reload`) instead of the overlay's
// Reload page. Starts its own API and web app against a throwaway database
// (./_local_stack.cjs) and seeds through the API; every expected figure is read from the
// API. Not wired into CI and not part of `pnpm build`. Run steps: see ./README.md.
//
// Check kinds: [B] behavioural, [S] structural (a failed one makes the run invalid),
// [G] guard (holds at base and must keep holding). The script ends with RESULT: k/m and
// exits 0 only when every check passed, 1 when any failed, 2 for setup.
//
// Usage: node frontend/e2e/smooth-overlay.cjs [scenario]
const { startLocalStack } = require('./_local_stack.cjs')
const h = require('./_smooth.cjs')
const dialogs = require('./_dialogs.cjs')
const { allDueRows, showRow } = require('./_due_pages.cjs')
const { pick } = require('./_picker.cjs')

const playwrightPath = process.env.PLAYWRIGHT_PATH || 'playwright'
let chromium
try {
  ;({ chromium } = require(playwrightPath))
} catch {
  console.error(`Cannot load Playwright from "${playwrightPath}". Set PLAYWRIGHT_PATH (see frontend/e2e/README.md).`)
  process.exit(2)
}

const only = process.argv[2]
const STUCK_MS = 20000

// ─── Days (YYYY-MM-DD, UTC arithmetic) ───────────────────────────────────────
const manilaDay = (ms) => new Date(ms + 8 * 3600 * 1000).toISOString().slice(0, 10)
const manilaToday = () => manilaDay(Date.now())
const addDays = (day, n) => {
  const d = new Date(`${day}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().slice(0, 10)
}
const wire = (day) => `${day}T00:00:00`
/** As the app shows PHP money: "₱1,851.10". */
const peso = (n) => `₱${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

let stack, client, owner, bank, today, closeDom, close, bdoRule

// ─── Seeding ─────────────────────────────────────────────────────────────────

/** A card closing on `closeDom` (one closed statement owed), due 21 days later, BDO rule. */
async function makeCard(u, name, { payer = bank, limit = 50000, debits = [[2000, close], [500, addDays(today, 3)]] } = {}) {
  const card = await client.post(u.token, '/accounts/', {
    name, account_type: 'credit', balance: 0, currency: 'PHP', credit_limit: limit,
    billing_cycle_start: closeDom, days_until_due_date: 21, minimum_due_rule: bdoRule,
    ...(payer ? { payment_account_id: payer.id } : {}),
  })
  for (const [amount, cycleClose] of debits) {
    await client.post(u.token, '/transactions/', {
      account_id: card.id, transaction_type: 'debit', amount, description: `${name} purchase`,
      transaction_date: wire(addDays(cycleClose, -3)), is_posted: true,
    })
  }
  return card
}
const creditOf = (u, cardId) => client.get(u.token, `/cards/${cardId}/credit`)
const latestOf = (detail) => detail.statements[detail.statements.length - 1]

// ─── Page helpers ────────────────────────────────────────────────────────────

const OVERLAY = '[data-testid="busy-overlay"]'
const tid = (id) => `[data-testid="${id}"]`
const text = async (locator) => ((await locator.textContent()) || '').replace(/\s+/g, ' ').trim()
const pathIs = (suffix) => (r) => new URL(r.url()).pathname.endsWith(suffix)

/** A response wait that never rejects: null at its bound, so a failed scenario cannot crash the run. */
const waitResponse = (page, pred) => page.waitForResponse(pred, { timeout: 10000 }).catch(() => null)

/**
 * A fresh page with a probe, installed before its first document, that notes whether a busy
 * overlay element ever appeared (`overlaySeen`), and a request log.
 */
async function openPage(browser, contextOptions = {}, { clock = null } = {}) {
  const { ctx, page } = await h.newPage(browser, contextOptions)
  page.setDefaultTimeout(10000)
  if (clock) await page.clock.install({ time: clock })
  await page.addInitScript((sel) => {
    window.__overlaySeen = false
    const probe = () => { if (document.querySelector(sel)) window.__overlaySeen = true }
    const start = () => { new MutationObserver(probe).observe(document.documentElement, { childList: true, subtree: true }); probe() }
    if (document.documentElement) start()
    else document.addEventListener('DOMContentLoaded', start, { once: true })
  }, OVERLAY)
  const requests = h.logRequests(page)
  return { ctx, page, requests }
}

/** The `<id>` check that no busy overlay was ever in the page. */
const checkNoOverlay = (id, page) => h.check(id, 'B', async () => {
  const seen = await page.evaluate(() => window.__overlaySeen).catch(() => null)
  return seen === false || `overlay probe ${seen}`
})
/** True when nothing covers `locator`'s centre: the hit test there lands on it or inside it. */
const uncovered = (page, locator) => locator.evaluate((el) => {
  const r = el.getBoundingClientRect()
  const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)
  return (!!hit && (hit === el || el.contains(hit))) || `hit ${hit?.getAttribute('data-testid') ?? hit?.tagName ?? null}`
})
const shellInert = (page) => page.evaluate(() => ['#root', '[data-app-shell]'].filter((s) => document.querySelector(s)?.hasAttribute('inert')))
const activeTestId = (page) => page.evaluate(() => document.activeElement?.getAttribute('data-testid') ?? document.activeElement?.tagName ?? null)
const inertCount = (page) => page.evaluate(() => document.querySelectorAll('[inert]').length)
const boxOf = (locator) => locator.boundingBox()

/** Requests in `log` matching `pred` made after page time `since`. */
const requestsSince = (log, since, pred) => log.filter((r) => r.t !== null && r.t >= since && pred(r))
const nowOf = (page) => page.evaluate(() => performance.now())

async function openAccount(page, accountId) {
  await page.goto(`${stack.webUrl}/accounts/${accountId}`)
  await page.locator(tid('account-detail')).waitFor()
  await h.waitQuiet(page)
}
async function openCardPanel(page, cardId) {
  await openAccount(page, cardId)
  await page.locator(tid('card-credit-panel')).waitFor()
  await h.waitQuiet(page)
}
async function openPayDialog(page) {
  await page.locator(tid('card-pay-open')).click()
  const dialog = page.locator(tid('card-pay-dialog'))
  await dialog.locator(tid('card-pay-amount')).waitFor()
  await h.waitQuiet(page)
  return dialog
}
const payGate = (page, cardId) => h.gate(page, { method: 'POST', url: new RegExp(`/cards/${cardId}/payments$`) })
const creditGate = (page, cardId) => h.gate(page, (r) => r.method() === 'GET' && new URL(r.url()).pathname.endsWith(`/cards/${cardId}/credit`))
const isCredit = (cardId) => (r) => r.method === 'GET' && new URL(r.url).pathname.endsWith(`/cards/${cardId}/credit`)
/** The owed figure each statement row shows: [[close, text]]. */
const shownStatements = (page) => page.locator(tid('card-statement')).evaluateAll((rows) =>
  rows.map((r) => [r.getAttribute('data-close'), (r.querySelector('[data-testid="card-statement-owed"]')?.textContent || '').trim()]))

/** Each statement's owed figure on the panel equals the API's. */
async function panelMatchesApi(page, cardId) {
  const detail = await creditOf(owner, cardId)
  const shown = await shownStatements(page)
  const expected = detail.statements.map((s) => [s.close_date, peso(s.owed)])
  const sort = (a) => [...a].sort((x, y) => x[0].localeCompare(y[0]))
  return JSON.stringify(sort(shown)) === JSON.stringify(sort(expected)) || `shown ${JSON.stringify(shown)} api ${JSON.stringify(expected)}`
}

/** Advances a paused page clock to a moment just ahead and pauses there (plan 5.1). */
async function pauseNow(page) {
  const t = await page.evaluate(() => Date.now())
  await page.clock.pauseAt(t + 50)
}

// ─── Scenarios ───────────────────────────────────────────────────────────────

// (a) The owner's flow: Pay a card from its panel. The dialog awaits its own save (one POST,
// "Paying…"), nothing covers the page, the dialog closes once the save lands without waiting
// for the reload, and the panel keeps its figures until the reload lands.
async function scenarioA(browser) {
  console.log('\n=== (a) owner\'s flow: Pay awaits its save in the dialog; nothing blocks; figures stay until the reload')
  const card = await makeCard(owner, 'Card A')
  const { ctx, page } = await openPage(browser)
  const post = { gate: null }, credit = { gate: null }
  try {
    await h.uiLogin(page, stack, owner)
    await openCardPanel(page, card.id)
    const before = await shownStatements(page)
    const dialog = await openPayDialog(page)
    post.gate = await payGate(page, card.id)
    credit.gate = await creditGate(page, card.id)
    await dialog.locator(tid('card-pay-submit')).click()
    await h.check('a.held', 'S', async () => (await post.gate.waitHits(1)) || 'the payment request never started')
    await h.check('a.paying', 'B', async () => {
      const submit = dialog.locator(tid('card-pay-submit'))
      const got = { label: await text(submit), disabled: await submit.isDisabled() }
      return (got.label === 'Paying…' && got.disabled) || JSON.stringify(got)
    })
    await page.keyboard.press('Enter')
    await dialog.locator(tid('card-pay-submit')).click({ force: true, timeout: 1000 }).catch(() => {})
    await h.sleep(300)
    await h.check('a.no-second-post', 'B', async () => post.gate.hits === 1 || `hits ${post.gate.hits}`)
    await h.check('a.dialog-uncovered', 'B', () => uncovered(page, dialog.getByRole('button', { name: 'Cancel' })))
    const posted = waitResponse(page, (r) => r.request().method() === 'POST' && pathIs(`/cards/${card.id}/payments`)(r))
    post.gate.release({ disarm: true })
    await posted
    await h.check('a.closes-before-reload', 'B', async () => {
      const closed = await dialog.waitFor({ state: 'detached', timeout: 5000 }).then(() => true, () => false)
      return (closed && credit.gate.hits >= 1) || `closed ${closed}, credit GETs held ${credit.gate.hits}`
    })
    await h.check('a.figures-kept-while-reload', 'B', async () => {
      const during = await shownStatements(page)
      return (during.length > 0 && JSON.stringify(during) === JSON.stringify(before)) || `before ${JSON.stringify(before)} during ${JSON.stringify(during)}`
    })
    credit.gate.release({ disarm: true })
    await h.waitQuiet(page)
    await h.check('a.panel-equals-api', 'B', () => panelMatchesApi(page, card.id))
    await h.check('a.focus-opener', 'B', async () => (await activeTestId(page)) === 'card-pay-open' || `active ${await activeTestId(page)}`)
    await checkNoOverlay('a.no-overlay', page)
  } finally {
    post.gate?.release({ disarm: true })
    credit.gate?.release({ disarm: true })
    await ctx.close()
  }
}

// (b) A minimum save on the card panel: one PUT, the page uncovered while it is held, exactly
// one reload, the figure equal to the API's.
async function scenarioB(browser) {
  console.log('\n=== (b) a minimum save: one PUT, nothing covered, exactly one reload')
  const card = await makeCard(owner, 'Card B')
  const { ctx, page, requests } = await openPage(browser)
  const gates = []
  try {
    await h.uiLogin(page, stack, owner)
    await openCardPanel(page, card.id)
    await page.locator(tid('card-minimum-edit')).first().click()
    await page.locator(tid('card-minimum-input')).fill('321.50')
    const saveBox = await boxOf(page.locator(tid('card-minimum-save')))
    const put = await h.gate(page, { method: 'PUT', url: /minimum-due$/ })
    const credit = await creditGate(page, card.id)
    gates.push(put, credit)
    await page.locator(tid('card-minimum-save')).click()
    await put.waitHits(1)
    await h.clickBox(page, saveBox)
    await h.sleep(300)
    await h.check('b.no-second-put', 'B', async () => put.hits === 1 || `hits ${put.hits}`)
    await h.check('b.page-uncovered', 'B', () => uncovered(page, page.locator(tid('card-pay-open'))))
    await h.check('b.shell-not-inert', 'B', async () => (await shellInert(page)).length === 0 || JSON.stringify(await shellInert(page)))
    const putDone = waitResponse(page, (r) => r.request().method() === 'PUT' && r.url().endsWith('minimum-due'))
    put.release({ disarm: true })
    await putDone
    await h.check('b.reload-held', 'S', async () => (await credit.waitHits(1)) || 'the save started no reload')
    await h.check('b.figures-kept-while-reload', 'B', async () => (await page.locator(tid('card-statement')).count()) > 0 || 'the statements left the panel')
    credit.release({ disarm: true })
    await h.waitQuiet(page)
    await h.sleep(750)
    await h.check('b.one-reload', 'B', async () => {
      const n = requestsSince(requests, put.hitTimes[0], isCredit(card.id)).length
      return n === 1 || `credit GETs after the PUT: ${n}`
    })
    await h.check('b.minimum-equals-api', 'B', async () => {
      const latest = latestOf(await creditOf(owner, card.id))
      const shown = await text(page.locator(`${tid('card-statement')}[data-close="${latest.close_date}"] ${tid('card-statement-minimum')}`))
      return shown.includes(peso(latest.minimum_due.amount)) || `shown "${shown}" api ${latest.minimum_due.amount}`
    })
    await checkNoOverlay('b.no-overlay', page)
  } finally {
    for (const g of gates) g.release({ disarm: true })
    await ctx.close()
  }
}

// (i) A failed Pay from the card panel: the error is shown in the dialog, Cancel closes it.
async function scenarioI(browser) {
  console.log('\n=== (i) a failed Pay shows the dialog error; Cancel closes it')
  const card = await makeCard(owner, 'Card I')
  const { ctx, page } = await openPage(browser)
  let post = null
  try {
    await h.uiLogin(page, stack, owner)
    await openCardPanel(page, card.id)
    const dialog = await openPayDialog(page)
    post = await h.gate(page, { method: 'POST', url: new RegExp(`/cards/${card.id}/payments$`) }, { failStatus: 500 })
    await dialog.locator(tid('card-pay-submit')).click()
    await post.waitHits(1)
    post.release({ disarm: true })
    await h.check('i.error-shown', 'B', async () =>
      (await dialog.locator(tid('card-pay-error')).waitFor({ timeout: 5000 }).then(() => true, () => false)) || 'no card-pay-error')
    await dialog.getByRole('button', { name: 'Cancel' }).click()
    await h.check('i.cancel-closes', 'B', async () => (await h.expectAbsentFor(page, page.locator(tid('card-pay-dialog')), 500)) || 'dialog still open')
    await checkNoOverlay('i.no-overlay', page)
  } finally {
    post?.release({ disarm: true })
    await ctx.close()
  }
}

// (o) A load that never settles: o1, a Pay save held 20 s leaves the dialog's Cancel working;
// o2, a search held 20 s shows the inline "Still loading. Reload" while the search box keeps
// focus and typing and the rest of the page works.
async function scenarioO(browser) {
  console.log('\n=== (o) o1: a Pay save held 20 s blocks nothing')
  const card = await makeCard(owner, 'Card O')
  const { ctx, page } = await openPage(browser, {}, { clock: new Date() })
  let post = null
  try {
    await h.uiLogin(page, stack, owner)
    await openCardPanel(page, card.id)
    const dialog = await openPayDialog(page)
    await pauseNow(page)
    post = await payGate(page, card.id)
    await dialog.locator(tid('card-pay-submit')).click()
    await post.waitHits(1)
    await page.clock.runFor(STUCK_MS + 100)
    await h.sleep(200)
    await h.check('o1.no-reload-offer', 'B', async () => (await page.getByRole('button', { name: 'Reload page' }).count()) === 0 || 'a Reload page offer appeared')
    await dialog.getByRole('button', { name: 'Cancel' }).click()
    await h.check('o1.cancel-works', 'B', async () => (await h.expectAbsentFor(page, dialog, 300)) || 'dialog still open')
    await h.check('o1.one-post', 'B', async () => post.hits === 1 || `hits ${post.hits}`)
    await checkNoOverlay('o1.no-overlay', page)
  } finally {
    post?.release({ disarm: true })
    await ctx.close()
  }
  await scenarioO2(browser)
}

/** Every console message and Log-domain entry (where Chromium reports interventions) from now on. */
async function watchConsole(ctx, page) {
  const messages = []
  page.on('console', (m) => messages.push(`console ${m.type()}: ${m.text()}`))
  const cdp = await ctx.newCDPSession(page)
  cdp.on('Log.entryAdded', ({ entry }) => messages.push(`log ${entry.source} ${entry.level}: ${entry.text}`))
  await cdp.send('Log.enable')
  return messages
}
const interventions = (messages) => {
  const bad = messages.filter((m) => /intervention|passive/i.test(m))
  return bad.length === 0 || JSON.stringify(bad)
}

// (tap) Touch taps while a request is held: they reach the page, with no passive-listener
// intervention logged.
async function scenarioTap(browser) {
  console.log('\n=== (tap) touch taps while a request is held reach the page without a console warning')
  const card = await makeCard(owner, 'Card Tap')
  let { ctx, page } = await openPage(browser, { hasTouch: true })
  const post = { gate: null }
  try {
    await h.uiLogin(page, stack, owner)
    await openCardPanel(page, card.id)
    const dialog = await openPayDialog(page)
    const cancelBox = await boxOf(dialog.getByRole('button', { name: 'Cancel' }))
    post.gate = await payGate(page, card.id)
    await dialog.locator(tid('card-pay-submit')).click()
    await h.check('tap.held', 'S', async () => (await post.gate.waitHits(1)) || 'the payment request never started')
    const messages = await watchConsole(ctx, page)
    await page.touchscreen.tap(cancelBox.x + cancelBox.width / 2, cancelBox.y + cancelBox.height / 2)
    await h.check('tap.cancel-works', 'B', async () => (await h.expectAbsentFor(page, dialog, 300)) || 'dialog still open')
    await h.check('tap.one-post', 'G', async () => post.gate.hits === 1 || `hits ${post.gate.hits}`)
    await h.check('tap.cancel-no-intervention', 'G', () => interventions(messages))
  } finally {
    post.gate?.release({ disarm: true })
    await ctx.close()
  }

  ;({ ctx, page } = await openPage(browser, { hasTouch: true }))
  let gate = null
  try {
    await h.uiLogin(page, stack, owner)
    await openTransactions(page)
    const search = page.locator(SEARCH)
    await search.click()
    ;({ g: gate } = await searchGate(page))
    await search.pressSequentially('ab')
    await h.check('tap.search-held', 'S', async () => (await gate.waitHits(1)) || 'the search request never started')
    const messages = await watchConsole(ctx, page)
    const box = await boxOf(search)
    await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2)
    await page.keyboard.type('c')
    await h.check('tap.search-takes-input', 'B', async () => {
      const r = { active: await activeTestId(page), value: await search.inputValue() }
      return (r.active === 'transactions-search' && r.value === 'abc') || JSON.stringify(r)
    })
    await h.check('tap.search-no-intervention', 'B', () => interventions(messages))
    await checkNoOverlay('tap.no-overlay', page)
  } finally {
    gate?.release({ disarm: true })
    await ctx.close()
  }
}

// ─── Search helpers ──────────────────────────────────────────────────────────

const SEARCH = tid('transactions-search')
const PREV_MONTH = 'button[aria-label="View previous month"]'
const monthLabel = (page) => text(page.locator(`${PREV_MONTH} + span`))
/** Main-list GETs that carry a `search` param; `urls` records each hit. */
async function searchGate(page) {
  const urls = []
  const g = await h.gate(page, (r) => {
    if (r.method() !== 'GET') return false
    const url = new URL(r.url())
    if (!url.pathname.endsWith('/transactions/') || !url.searchParams.has('search')) return false
    urls.push(url)
    return true
  })
  return { g, urls }
}

// (o) o2: a search held 20 s: the inline slow-reload offer, focus and typing kept, the month
// control still works, and the offer reloads the page.
async function scenarioO2(browser) {
  console.log('\n=== (o) o2: a stuck search load: inline "Still loading. Reload"; the page keeps working')
  const { ctx, page } = await openPage(browser, {}, { clock: new Date() })
  let gate = null
  try {
    await h.uiLogin(page, stack, owner)
    await openTransactions(page)
    const search = page.locator(SEARCH)
    await search.click()
    await pauseNow(page)
    ;({ g: gate } = await searchGate(page))
    await search.pressSequentially('ab')
    await page.clock.runFor(500)
    await h.check('o2.search-hit', 'S', async () => (await gate.waitHits(1)) || 'the search request never started')
    await h.check('o2.no-offer-early', 'B', async () => (await page.locator(tid('slow-reload')).count()) === 0 || 'slow-reload before 20 s')
    await page.clock.runFor(STUCK_MS + 100)
    await h.sleep(200)
    await h.check('o2.slow-reload', 'B', async () => {
      const offer = page.locator(tid('slow-reload'))
      return ((await offer.count()) === 1 && (await text(offer)).startsWith('Still loading.')) || `slow-reload ${await offer.count()}`
    })
    await h.check('o2.focus-kept', 'B', async () => (await activeTestId(page)) === 'transactions-search' || `active ${await activeTestId(page)}`)
    await page.keyboard.type('c')
    await h.check('o2.typing', 'B', async () => (await search.inputValue()) === 'abc' || `value "${await search.inputValue()}"`)
    const label = await monthLabel(page)
    await page.locator(PREV_MONTH).click()
    await page.clock.runFor(100)
    await h.check('o2.month-works', 'B', async () => {
      const after = await monthLabel(page)
      return after !== label || `label stayed "${label}"`
    })
    const loaded = page.waitForEvent('load', { timeout: 10000 }).then(() => true, () => false)
    await page.locator(tid('slow-reload-button')).click()
    await h.check('o2.reloads', 'B', async () => (await loaded) || 'no load event')
    await checkNoOverlay('o2.no-overlay', page)
  } finally {
    gate?.release({ disarm: true })
    await ctx.close()
  }
}

// (r) Nothing goes inert or modal while a save is held: no "Please wait" dialog, the shell and
// #root keep taking input.
async function scenarioR(browser) {
  console.log('\n=== (r) a held save: no modal loader, nothing inert')
  const card = await makeCard(owner, 'Card R')
  const { ctx, page } = await openPage(browser, { reducedMotion: 'reduce' })
  const gates = []
  try {
    await h.uiLogin(page, stack, owner)
    await openCardPanel(page, card.id)
    await page.locator(tid('card-minimum-edit')).first().click()
    await page.locator(tid('card-minimum-input')).fill('99.90')
    const put = await h.gate(page, { method: 'PUT', url: /minimum-due$/ })
    gates.push(put)
    await page.locator(tid('card-minimum-save')).click()
    await put.waitHits(1)
    await h.check('r.no-wait-dialog', 'B', async () => (await page.getByRole('dialog', { name: 'Please wait' }).count()) === 0 || 'a "Please wait" dialog exists')
    await h.check('r.shell-not-inert-while-saving', 'B', async () => (await shellInert(page)).length === 0 || JSON.stringify(await shellInert(page)))
    put.release({ disarm: true })
    await h.waitQuiet(page)
    await h.check('r.shell-not-inert-after', 'B', async () => (await inertCount(page)) === 0 || `${await inertCount(page)} inert`)
    await checkNoOverlay('r.no-overlay', page)
  } finally {
    for (const g of gates) g.release({ disarm: true })
    await ctx.close()
  }
}

/** Starts the Pay save the way a script would. */
const startPaySave = (page) => page.evaluate(() => document.querySelector('[data-testid="card-pay-submit"]').click())

// (q) Input while a save is held reaches the app.
async function scenarioQ(browser) {
  console.log('\n=== (q) input while a save is held reaches the app')
  // q2: typing reaches the Pay dialog's field and Escape closes it while its save is held.
  {
    const card = await makeCard(owner, 'Card Q2')
    const { ctx, page } = await openPage(browser)
    let post = null
    try {
      await h.uiLogin(page, stack, owner)
      await openCardPanel(page, card.id)
      const dialog = await openPayDialog(page)
      const amount = dialog.locator(tid('card-pay-amount'))
      post = await payGate(page, card.id)
      await startPaySave(page)
      await post.waitHits(1)
      await amount.focus()
      const before = await amount.inputValue()
      await page.keyboard.type('9')
      await h.check('q2.typing-reaches-field', 'B', async () => {
        const after = await amount.inputValue()
        return after === `${before}9` || `amount ${before} -> ${after}`
      })
      await page.keyboard.press('Escape')
      await h.check('q2.escape-closes', 'B', async () => (await h.expectAbsentFor(page, dialog, 300)) || 'dialog still open')
      await h.check('q2.one-post', 'B', async () => post.hits === 1 || `hits ${post.hits}`)
      await checkNoOverlay('q2.no-overlay', page)
    } finally {
      post?.release({ disarm: true })
      await ctx.close()
    }
  }
  await scenarioQ1(browser)
  await scenarioQ1c(browser)
  await scenarioQ4(browser)
  await scenarioQ5(browser)
}

// (j) A cold Pay from Due: while its first load is held the dialog's Cancel works; once the
// load lands, focus is in the dialog.
async function scenarioJ(browser) {
  console.log('\n=== (j) a cold Pay from Due takes input while its first load is held')
  const card = await makeCard(owner, 'Card J')
  const { ctx, page } = await openPage(browser)
  let credit = null
  try {
    await h.uiLogin(page, stack, owner)
    await page.goto(`${stack.webUrl}/transactions`)
    await page.locator(tid('due-section')).waitFor()
    await page.locator(tid('due-count')).filter({ hasNotText: '…' }).waitFor()
    await h.waitQuiet(page)
    const row = page.locator(`${tid('due-row')}[data-kind="statement"][data-source="statement:${card.id}"]`)
    await showRow(page, row)
    await h.waitQuiet(page)
    credit = await creditGate(page, card.id)
    await row.locator(tid('due-pay')).click()
    const dialog = page.locator(tid('card-pay-dialog'))
    await dialog.waitFor()
    await h.check('j.load-held', 'S', async () => (await credit.waitHits(1)) || 'the first load never started')
    await dialog.getByRole('button', { name: 'Cancel' }).click()
    await h.check('j.cancel-works', 'B', async () => (await h.expectAbsentFor(page, dialog, 300)) || 'dialog still open')
    credit.release({ disarm: true })
    await h.waitQuiet(page)
    await row.locator(tid('due-pay')).click()
    await dialog.locator(tid('card-pay-amount')).waitFor()
    await h.check('j.focus-in-dialog', 'B', async () => (await page.evaluate(() => !!document.activeElement?.closest('[data-testid="card-pay-dialog"]'))) || `active ${await activeTestId(page)}`)
    await checkNoOverlay('j.no-overlay', page)
  } finally {
    credit?.release({ disarm: true })
    await ctx.close()
  }
}

// ─── Pages and seeds for the remaining scenarios ─────────────────────────────

const entry = (u, fields) => client.post(u.token, '/budget-entries/', { entry_type: 'expense', currency: 'PHP', cadence: 'monthly', ...fields })
const isSnapshot = (r) => r.method() === 'GET' && new URL(r.url()).pathname.endsWith('/dashboard/snapshot')
/** The Transactions main list: no ids, no is_posted, end_date on or before `day`. */
const isMainList = (day) => (r) => {
  if (r.method() !== 'GET') return false
  const url = new URL(r.url())
  if (!url.pathname.endsWith('/transactions/')) return false
  const p = url.searchParams
  return !p.has('ids') && !p.has('is_posted') && p.has('start_date') && (p.get('end_date') || '').slice(0, 10) <= day
}
const navLink = (page, href) => page.locator(`nav a[href="${href}"]`).first()

async function openTransactions(page) {
  await page.goto(`${stack.webUrl}/transactions`)
  await page.locator(tid('due-section')).waitFor()
  await page.locator(tid('due-count')).filter({ hasNotText: '…' }).waitFor()
  await h.waitQuiet(page)
}
const dueRecurring = (page, name) => page.locator(`${tid('due-row')}[data-kind="recurring"]`).filter({ hasText: name })
/** The transaction's row on the Transactions list. */
const txnRow = (page, description) => page.locator('article[role="button"]').filter({ hasText: description }).first()
const saveToast = (page, description) => page.locator(tid('save-toast')).filter({ hasText: description })
/** Waits (bounded) for the save toast naming `description` to be in `state`; true on arrival. */
const waitToast = (page, description, state, ms = 10000) =>
  saveToast(page, description).and(page.locator(`[data-state="${state}"]`)).first().waitFor({ timeout: ms }).then(() => true, () => false)

/** Fills the create-transaction modal (an expense on `accountName`); returns the form. */
async function createTransactionUI(page, { accountName, amount, description }) {
  await page.getByRole('button', { name: 'Add Transaction' }).first().click()
  const form = page.locator('form').filter({ has: page.getByRole('button', { name: 'Create Transaction' }) })
  await form.waitFor()
  await h.waitQuiet(page)
  await form.locator('input[placeholder="Add notes about this transaction"]').fill(description)
  await pick(form.locator('[data-field="account_id"]'), accountName)
  await form.getByRole('button', { name: 'Expense', exact: true }).click()
  await form.locator('input[type="number"][placeholder="0.00"]').first().fill(String(amount))
  return form
}

/** A transaction with a receipt uploaded through the API. */
async function txnWithReceipt(u, account, description) {
  const txn = await client.post(u.token, '/transactions/', {
    account_id: account.id, transaction_type: 'debit', amount: 75, description,
    transaction_date: wire(today), is_posted: true,
  })
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64')
  const form = new FormData()
  form.append('file', new Blob([png], { type: 'image/png' }), 'receipt.png')
  const res = await fetch(`${stack.apiUrl}/api/v1/transactions/${txn.id}/upload-receipt`, {
    method: 'POST', headers: { Authorization: `Bearer ${u.token}` }, body: form,
  })
  if (res.status >= 300) throw new Error(`upload-receipt ${res.status} ${await res.text()}`)
  return txn
}
const isReceipt = (txnId) => (r) => new URL(r.url()).pathname.endsWith(`/transactions/${txnId}/receipt`)

// (c) The list reload after an account create is held: navigation works meanwhile, and the
// new account is listed once it lands.
async function scenarioC(browser) {
  console.log('\n=== (c) a held reload after a create blocks nothing; the account is listed once it lands')
  const { ctx, page } = await openPage(browser)
  let reload = null
  try {
    await h.uiLogin(page, stack, owner)
    await page.goto(`${stack.webUrl}/accounts`)
    await page.getByRole('button', { name: 'Add Account' }).waitFor()
    await h.waitQuiet(page)
    await page.getByRole('button', { name: 'Add Account' }).click()
    await page.locator('input[placeholder="Enter account name"]').fill('Overlay C Wallet')
    await page.locator('input[type="number"][placeholder="0.00"]').first().fill('1234')
    reload = await h.gate(page, (r) => r.method() === 'GET' && new URL(r.url()).pathname.endsWith('/accounts/') && new URL(r.url()).searchParams.get('limit') === '1000')
    await page.getByRole('button', { name: 'Create Account' }).click()
    await h.check('c.reload-hit', 'S', async () => (await reload.waitHits(1)) || 'the list reload never started')
    await h.check('c.listed-account-kept', 'B', async () => (await page.getByText('Owner Checking').first().isVisible()) || 'the existing accounts left the page')
    await navLink(page, '/forecast').click()
    await h.check('c.nav-works', 'B', async () => {
      try { await page.waitForURL((url) => url.pathname === '/forecast', { timeout: 3000 }); return true } catch { return `url ${page.url()}` }
    })
    reload.release({ disarm: true })
    await navLink(page, '/accounts').click()
    await h.check('c.listed', 'B', async () =>
      (await page.getByText('Overlay C Wallet').first().waitFor({ timeout: 5000 }).then(() => true, () => false)) || 'new account not listed')
    await checkNoOverlay('c.no-overlay', page)
  } finally {
    reload?.release({ disarm: true })
    await ctx.close()
  }
}

// (k) Mark paid from Due: the dialog closes at once, a toast follows the save; while the
// snapshot refetch is held the row's buttons are disabled (stale-data guard); then the row goes.
async function scenarioK(browser) {
  console.log('\n=== (k) Mark paid from Due closes at once; the row waits, disabled, for the refetch')
  const u = await h.makeUser(stack, 'k')
  const checking = await client.post(u.token, '/accounts/', { name: 'K Checking', account_type: 'checking', balance: 50000, currency: 'PHP' })
  // Due today: Due and overdue lists today and earlier, never a later day.
  const rent = await entry(u, { name: 'K Rent', amount: 1500, account_id: checking.id, next_occurrence: wire(today) })
  const { ctx, page } = await openPage(browser)
  const gates = []
  try {
    await h.uiLogin(page, stack, u)
    await openTransactions(page)
    const row = await showRow(page, dueRecurring(page, 'K Rent'))
    await row.locator(tid('due-mark-paid')).click()
    const dialog = page.locator(tid('mark-paid-dialog'))
    await dialog.locator(tid('mark-paid-occurrence')).waitFor()
    await h.waitQuiet(page)
    const save = await h.gate(page, (r) => r.method() === 'POST' && r.url().endsWith(`/budget-entries/${rent.id}/materialize`))
    const snap = await h.gate(page, isSnapshot)
    const list = await h.gate(page, isMainList(addDays(today, 1)))
    gates.push(save, snap, list)
    await dialog.locator(tid('mark-paid-submit')).click()
    await h.check('k.dialog-closes-at-once', 'B', async () => {
      const hit = await save.waitHits(1)
      const closed = await dialog.waitFor({ state: 'detached', timeout: 3000 }).then(() => true, () => false)
      return (hit && closed) || `save held ${hit}, dialog closed ${closed}`
    })
    await h.check('k.pending-toast', 'B', async () => (await waitToast(page, 'K Rent', 'pending', 3000)) || `toasts: ${await text(page.locator(tid('toast-stack'))).catch(() => '')}`)
    save.release({ disarm: true })
    await h.check('k.reloads-hit', 'S', async () => ((await snap.waitHits(1)) && (await list.waitHits(1))) || `snapshot ${snap.hits} list ${list.hits}`)
    const stale = dueRecurring(page, 'K Rent').locator(tid('due-mark-paid'))
    await h.check('k.row-buttons-disabled', 'B', async () => {
      if ((await stale.count()) === 0) return true
      return (await stale.first().isDisabled()) || 'the row\'s Mark paid is enabled while the snapshot refetches'
    })
    if ((await stale.count()) > 0) await stale.first().click({ force: true, timeout: 1000 }).catch(() => {})
    await h.sleep(300)
    await h.check('k.row-buttons-blocked', 'B', async () => (await page.locator(tid('mark-paid-dialog')).count()) === 0 || 'a dialog opened')
    snap.release({ disarm: true })
    list.release({ disarm: true })
    await h.check('k.saved-toast', 'B', async () => (await waitToast(page, 'K Rent', 'saved')) || 'no Saved toast')
    await h.waitQuiet(page)
    await h.check('k.row-gone', 'B', async () => {
      const rows = (await allDueRows(page)).filter((r) => r.text.includes('K Rent'))
      return rows.length === 0 || `rows ${rows.length}`
    })
    await checkNoOverlay('k.no-overlay', page)
  } finally {
    for (const g of gates) g.release({ disarm: true })
    await ctx.close()
  }
}

// (d) Due's first load from a cached snapshot: the stale row's buttons are disabled until the
// refetch lands, then the row is gone.
async function scenarioD(browser) {
  console.log('\n=== (d) Due first load from cache: the stale row cannot be acted on')
  const u = await h.makeUser(stack, 'd')
  const checking = await client.post(u.token, '/accounts/', { name: 'D Checking', account_type: 'checking', balance: 50000, currency: 'PHP' })
  // Due today: Due and overdue lists today and earlier, never a later day.
  const bill = await entry(u, { name: 'D Bill', amount: 800, account_id: checking.id, next_occurrence: wire(today) })
  const { ctx, page } = await openPage(browser)
  let snap = null
  try {
    await h.uiLogin(page, stack, u)
    await page.locator(tid('net-worth')).waitFor()
    await h.waitQuiet(page)
    await client.post(u.token, `/budget-entries/${bill.id}/materialize`, {})
    snap = await h.gate(page, isSnapshot)
    await navLink(page, '/transactions').click()
    await page.locator(tid('due-section')).waitFor()
    await h.check('d.snapshot-hit', 'S', async () => (await snap.waitHits(1)) || 'no snapshot refetch')
    const stale = page.locator(`${tid('due-row')}[data-kind="recurring"]`).filter({ hasText: 'D Bill' }).locator(tid('due-mark-paid'))
    await h.check('d.stale-row-shown', 'S', async () => (await stale.count()) > 0 || 'no stale row to click (cache not painted)')
    await h.check('d.stale-row-disabled', 'B', async () => ((await stale.count()) > 0 && (await stale.first().isDisabled())) || 'the stale row\'s Mark paid is enabled')
    if ((await stale.count()) > 0) {
      await stale.first().click({ force: true, timeout: 1000 }).catch(() => {})
      await h.sleep(500)
    }
    await h.check('d.stale-row-blocked', 'B', async () => (await page.locator(tid('mark-paid-dialog')).count()) === 0 || 'MarkPaidDialog opened')
    snap.release({ disarm: true })
    await h.waitQuiet(page)
    await h.check('d.row-gone', 'B', async () => (await allDueRows(page)).filter((r) => r.text.includes('D Bill')).length === 0 || 'row still listed')
    await checkNoOverlay('d.no-overlay', page)
  } finally {
    snap?.release({ disarm: true })
    await ctx.close()
  }
}

// (e) A page's first load held: the page and the navigation take input meanwhile.
async function scenarioE(browser) {
  console.log('\n=== (e) a held first load blocks nothing')
  const { ctx, page } = await openPage(browser)
  let g = null
  try {
    await h.uiLogin(page, stack, owner)
    await page.locator(tid('net-worth')).waitFor()
    await h.waitQuiet(page)
    g = await h.gate(page, (r) => r.method() === 'GET' && new URL(r.url()).pathname.endsWith('/allocations/'))
    await navLink(page, '/allocations').click()
    await h.check('e.hit', 'S', async () => (await g.waitHits(1)) || 'no allocations request')
    await h.check('e.nav-uncovered', 'B', () => uncovered(page, navLink(page, '/transactions')))
    await navLink(page, '/transactions').click()
    await h.check('e.nav-works', 'B', async () => {
      try { await page.waitForURL((url) => url.pathname === '/transactions', { timeout: 3000 }); return true } catch { return `url ${page.url()}` }
    })
    g.release({ disarm: true })
    await checkNoOverlay('e.no-overlay', page)
  } finally {
    g?.release({ disarm: true })
    await ctx.close()
  }
}

/** The 5.1 before-checks for a day crossing: still the day, no credit or next-day list GET since `since`. */
async function beforeCrossing(page, label, requests, day, since, { cardId }) {
  const local = await h.localDay(page)
  const early = requests.filter((r) => r.t !== null && r.t >= since && (
    isCredit(cardId)(r) ||
    (r.method === 'GET' && new URL(r.url).pathname.endsWith('/transactions/') && (new URL(r.url).searchParams.get('end_date') || '').slice(0, 10) > day)))
  await h.check(`${label}.before-crossing`, 'S', async () => (local === day && early.length === 0) || `local ${local} early ${JSON.stringify(early.map((r) => r.url))}`)
}

// (f) f1: a period change held: another period press takes effect at once. f2: Card Pay's
// day-turn refetch held: the dialog keeps the typed amount, and a submit after it posts once.
async function scenarioF(browser) {
  console.log('\n=== (f) f1: a held period change; f2: a held day-turn refetch under Card Pay')
  {
    const { ctx, page } = await openPage(browser)
    let g = null
    try {
      await h.uiLogin(page, stack, owner)
      await page.locator(tid('net-worth')).waitFor()
      await h.waitQuiet(page)
      const group = page.getByRole('group', { name: 'Period for actual totals' })
      g = await h.gate(page, (r) => r.method() === 'GET' && new URL(r.url()).pathname.endsWith('/transactions/summary/period'))
      await group.getByRole('button', { name: 'year' }).click()
      await h.check('f1.held', 'S', async () => (await g.waitHits(1)) || 'the year totals request never started')
      await group.getByRole('button', { name: 'month' }).click()
      await h.check('f1.month-press-works', 'B', async () => {
        const pressed = await group.getByRole('button', { name: 'month' }).getAttribute('aria-pressed')
        return pressed === 'true' || `month aria-pressed ${pressed}`
      })
      g.release({ disarm: true })
      await h.waitQuiet(page)
      await checkNoOverlay('f1.no-overlay', page)
    } finally {
      g?.release({ disarm: true })
      await ctx.close()
    }
  }
  {
    const card = await makeCard(owner, 'Card F2')
    const day = manilaToday()
    const { ctx, page, requests } = await openPage(browser, { timezoneId: 'Asia/Manila' })
    let credit = null
    try {
      await h.installDayClock(page, day)
      await h.uiLogin(page, stack, owner)
      await openCardPanel(page, card.id)
      const dialog = await openPayDialog(page)
      await dialog.locator(tid('card-pay-amount')).fill('123.45')
      const since = await nowOf(page)
      credit = await creditGate(page, card.id)
      await beforeCrossing(page, 'f2', requests, day, since, { cardId: card.id })
      const crossed = await h.crossDay(page)
      await h.check('f2.crossed', 'S', async () => crossed.after === addDays(day, 1) || JSON.stringify(crossed))
      await h.check('f2.refetch-hit', 'S', async () => (await credit.waitHits(1)) || `no credit GET; requests ${JSON.stringify(requests.filter((r) => r.url.includes('/api/')).slice(-8).map((r) => r.url))}`)
      await h.check('f2.dialog-uncovered', 'B', () => uncovered(page, dialog.getByRole('button', { name: 'Cancel' })))
      await h.check('f2.amount-kept', 'B', async () => (await dialog.locator(tid('card-pay-amount')).inputValue()) === '123.45' || await dialog.locator(tid('card-pay-amount')).inputValue())
      const postsBefore = requests.filter((r) => r.method === 'POST' && r.url.endsWith(`/cards/${card.id}/payments`)).length
      credit.release({ disarm: true })
      await h.waitQuiet(page)
      const posted = waitResponse(page, (r) => r.request().method() === 'POST' && pathIs(`/cards/${card.id}/payments`)(r))
      await dialog.locator(tid('card-pay-submit')).click()
      await posted
      await h.sleep(300)
      await h.check('f2.one-post', 'B', async () => {
        const posts = requests.filter((r) => r.method === 'POST' && r.url.endsWith(`/cards/${card.id}/payments`)).length
        return posts === postsBefore + 1 || `posts ${posts - postsBefore}`
      })
      await checkNoOverlay('f2.no-overlay', page)
    } finally {
      credit?.release({ disarm: true })
      await ctx.close()
    }
  }
}

// (g) A held receipt fetch shows its own label; a held tag create blocks nothing either.
async function scenarioG(browser) {
  console.log('\n=== (g) a held receipt fetch and a held tag create block nothing')
  const txn = await txnWithReceipt(owner, bank, 'Overlay G receipt')
  const { ctx, page } = await openPage(browser)
  const gates = []
  try {
    await h.uiLogin(page, stack, owner)
    await openTransactions(page)
    await txnRow(page, 'Overlay G receipt').click()
    await page.locator(tid('view-receipt')).waitFor()
    await h.waitQuiet(page)
    const receipt = await h.gate(page, isReceipt(txn.id))
    gates.push(receipt)
    await page.locator(tid('view-receipt')).click()
    await receipt.waitHits(1)
    await h.sleep(300)
    const label = await text(page.locator(tid('view-receipt')))
    await h.check('g.loading-label', 'B', async () => label === 'Loading receipt…' || label)
    await h.check('g.close-uncovered', 'B', () => uncovered(page, page.getByRole('button', { name: 'Close actions modal' })))
    receipt.release({ disarm: true })

    await page.goto(`${stack.webUrl}/settings`)
    await page.locator(tid('tags-section')).waitFor()
    await h.waitQuiet(page)
    await page.locator(tid('tags-section')).getByRole('button', { name: 'Add tag' }).click()
    await page.locator('#tag-name').fill('overlay-g')
    const tagPost = await h.gate(page, { method: 'POST', url: /\/tags\/$/ })
    gates.push(tagPost)
    await page.getByRole('button', { name: 'Create', exact: true }).click()
    await tagPost.waitHits(1)
    await h.check('g.control-uncovered', 'B', () => uncovered(page, page.locator('#tag-name')))
    tagPost.release({ disarm: true })
    await h.check('g.tag-listed', 'B', async () =>
      (await page.locator(tid('tags-section')).getByText('overlay-g').first().waitFor({ timeout: 5000 }).then(() => true, () => false)) || 'the new tag is not listed')
    await checkNoOverlay('g.no-overlay', page)
  } finally {
    for (const g of gates) g.release({ disarm: true })
    await ctx.close()
  }
}

// (g3) A held receipt fetch does not hold back a background save or the reload after it.
async function scenarioG3(browser) {
  console.log('\n=== (g3) a held receipt fetch does not hold back a save or its reload')
  const txn = await txnWithReceipt(owner, bank, 'Overlay G3 receipt')
  const { ctx, page } = await openPage(browser)
  const gates = []
  try {
    await h.uiLogin(page, stack, owner)
    await openTransactions(page)
    await txnRow(page, 'Overlay G3 receipt').click()
    await page.locator(tid('view-receipt')).waitFor()
    await h.waitQuiet(page)
    const receipt = await h.gate(page, isReceipt(txn.id))
    gates.push(receipt)
    await page.locator(tid('view-receipt')).click()
    await receipt.waitHits(1)
    await page.getByRole('button', { name: 'Close actions modal' }).click()
    const form = await createTransactionUI(page, { accountName: 'Owner Checking', amount: 42, description: 'Overlay G3 new' })
    const snap = await h.gate(page, isSnapshot)
    gates.push(snap)
    await form.getByRole('button', { name: 'Create Transaction' }).click()
    await h.check('g3.form-closes-at-once', 'B', async () => (await h.expectAbsentFor(page, form, 300)) || 'the form is still open')
    await h.check('g3.reload-while-receipt-held', 'B', async () => ((await snap.waitHits(1, 5000)) && receipt.hits === 1) || `snapshot hits ${snap.hits}`)
    await h.check('g3.saved', 'B', async () => (await waitToast(page, 'Overlay G3 new', 'saved')) || 'no Saved toast')
    snap.release({ disarm: true })
    receipt.release({ disarm: true })
    await checkNoOverlay('g3.no-overlay', page)
  } finally {
    for (const g of gates) g.release({ disarm: true })
    await ctx.close()
  }
}

// (l) A save during the day-turn loads: the save's reload joins the day-turn one, and the
// minimum shown equals the API's once they land.
async function scenarioL(browser) {
  console.log('\n=== (l) a save during the day-turn loads: one joined reload, the figure equals the API')
  const card = await makeCard(owner, 'Card L')
  const day = manilaToday()
  const next = addDays(day, 1)
  const { ctx, page, requests } = await openPage(browser, { timezoneId: 'Asia/Manila' })
  const gates = []
  try {
    await h.installDayClock(page, day)
    await h.uiLogin(page, stack, owner)
    await openCardPanel(page, card.id)
    const since = await nowOf(page)
    await page.locator(tid('card-minimum-edit')).first().click()
    await page.locator(tid('card-minimum-input')).fill('222.20')
    const put = await h.gate(page, { method: 'PUT', url: /minimum-due$/ })
    const credit = await creditGate(page, card.id)
    const txns = await h.gate(page, (r) => r.method() === 'GET' && new URL(r.url()).pathname.endsWith('/transactions/') && (new URL(r.url()).searchParams.get('end_date') || '').startsWith(next))
    gates.push(put, credit, txns)
    await beforeCrossing(page, 'l', requests, day, since, { cardId: card.id })
    await page.locator(tid('card-minimum-save')).click()
    await put.waitHits(1)
    const crossed = await h.crossDay(page)
    await h.check('l.crossed', 'S', async () => crossed.after === next || JSON.stringify(crossed))
    await h.check('l.day-turn-hit', 'S', async () => ((await credit.waitHits(1)) && (await txns.waitHits(1))) ||
      `credit ${credit.hits} txns ${txns.hits}; requests ${JSON.stringify(requests.filter((r) => r.url.includes('/api/')).slice(-10).map((r) => r.url))}`)
    await h.check('l.page-uncovered', 'B', () => uncovered(page, page.locator(tid('card-pay-open'))))
    const putDone = waitResponse(page, (r) => r.request().method() === 'PUT' && r.url().endsWith('minimum-due'))
    put.release({ disarm: true })
    await putDone
    const creditHits = credit.hits
    await h.sleep(750)
    await h.check('l.joined', 'B', async () => credit.hits === creditHits || `new credit GETs ${credit.hits - creditHits}; ${JSON.stringify(requests.filter(isCredit(card.id)).map((r) => r.t))}`)
    credit.release({ disarm: true })
    txns.release({ disarm: true })
    await h.waitQuiet(page)
    await h.check('l.minimum-equals-api', 'B', async () => {
      const latest = latestOf(await creditOf(owner, card.id))
      const shown = await text(page.locator(`${tid('card-statement')}[data-close="${latest.close_date}"] ${tid('card-statement-minimum')}`))
      return shown.includes(peso(latest.minimum_due.amount)) || `shown "${shown}" api ${latest.minimum_due.amount}`
    })
    await checkNoOverlay('l.no-overlay', page)
  } finally {
    for (const g of gates) g.release({ disarm: true })
    await ctx.close()
  }
}

/** Opens the account actions modal for `name` on the Accounts page. */
async function openAccountActions(page, name) {
  await page.locator('div[role="button"]').filter({ hasText: name }).first().click()
  await page.locator(tid('share-account')).waitFor()
}

// (q1) An autosave select: the role change asks through the in-app Confirm; once accepted and
// its save held, nothing goes inert; released, the role is changed once.
async function scenarioQ1(browser) {
  console.log('  -- q1: an autosave select: nothing inert while its save is held, one change')
  const editor = await h.makeUser(stack, 'q1ed')
  const shared = await client.post(owner.token, '/accounts/', { name: 'Overlay Q1 Shared', account_type: 'checking', balance: 100, currency: 'PHP' })
  await client.post(owner.token, `/accounts/${shared.id}/shares`, { email: editor.email, role: 'editor' })
  const { ctx, page } = await openPage(browser)
  const native = dialogs.trackNativeDialogs(page)
  const cd = dialogs.confirmDialog(page)
  let patch = null
  try {
    await h.uiLogin(page, stack, owner)
    await page.goto(`${stack.webUrl}/accounts`)
    await page.getByText('Overlay Q1 Shared').first().waitFor()
    await h.waitQuiet(page)
    await openAccountActions(page, 'Overlay Q1 Shared')
    await page.locator(tid('share-account')).click()
    const select = page.locator(tid('share-row-role')).first()
    await select.waitFor()
    await h.waitQuiet(page)
    const options = await select.locator('option').evaluateAll((os) => os.map((o) => o.value))
    const current = await select.inputValue()
    const target = options.find((v) => v !== current)
    await select.focus()
    await select.selectOption(target)
    await cd.dialog.waitFor({ timeout: 3000 })
    patch = await h.gate(page, { method: 'PATCH', url: new RegExp(`/accounts/${shared.id}/shares/\\d+$`) })
    await cd.accept.click()
    await patch.waitHits(1)
    await cd.dialog.waitFor({ state: 'detached', timeout: 3000 }).catch(() => {})
    await h.check('q1.nothing-inert-while-held', 'B', async () => {
      const left = await dialogs.leftoverInert(page)
      return left.length === 0 || `inert: ${JSON.stringify(left)}`
    })
    patch.release({ disarm: true })
    await h.waitQuiet(page)
    await h.check('q1.one-change', 'B', async () => {
      const shown = await select.inputValue()
      return (patch.hits === 1 && shown === target) || `hits ${patch.hits} select ${shown} wanted ${target}`
    })
    await checkNoOverlay('q1.no-overlay', page)
    await dialogs.checkNoNativeDialogs(h, 'q1', native)
  } finally {
    patch?.release({ disarm: true })
    await ctx.close()
  }
}

// (q1c) Cancelling the role change's Confirm with Escape: focus returns to the select, it
// keeps the old role and no request is sent. No request is held at any point.
async function scenarioQ1c(browser) {
  console.log('  -- q1c: cancelling the role change keeps the select, its focus and the role')
  const editor = await h.makeUser(stack, 'q1ced')
  const shared = await client.post(owner.token, '/accounts/', { name: 'Overlay Q1c Shared', account_type: 'checking', balance: 100, currency: 'PHP' })
  await client.post(owner.token, `/accounts/${shared.id}/shares`, { email: editor.email, role: 'editor' })
  const { ctx, page } = await openPage(browser)
  const native = dialogs.trackNativeDialogs(page)
  const cd = dialogs.confirmDialog(page)
  const log = h.logRequests(page)
  try {
    await h.uiLogin(page, stack, owner)
    await page.goto(`${stack.webUrl}/accounts`)
    await page.getByText('Overlay Q1c Shared').first().waitFor()
    await h.waitQuiet(page)
    await openAccountActions(page, 'Overlay Q1c Shared')
    await page.locator(tid('share-account')).click()
    const select = page.locator(tid('share-row-role')).first()
    await select.waitFor()
    await h.waitQuiet(page)
    const current = await select.inputValue()
    const options = await select.locator('option').evaluateAll((os) => os.map((o) => o.value))
    const target = options.find((v) => v !== current)
    await select.focus()
    await select.selectOption(target)
    await cd.dialog.waitFor({ timeout: 3000 })
    await page.keyboard.press('Escape')
    await cd.dialog.waitFor({ state: 'detached', timeout: 3000 })
    await h.waitQuiet(page)
    await h.check('q1c.focus-select', 'B', async () => {
      const onSelect = await select.evaluate((el) => el === document.activeElement).catch(() => false)
      return onSelect || `active ${await activeTestId(page)}`
    })
    await h.check('q1c.role-unchanged', 'B', async () => {
      const shown = await select.inputValue()
      return shown === current || `select shows ${shown}, wanted ${current}`
    })
    await h.check('q1c.nothing-sent', 'B', async () => {
      const n = log.filter((r) => r.method === 'PATCH').length
      return n === 0 || `${n} PATCH request(s)`
    })
    await dialogs.checkNoNativeDialogs(h, 'q1c', native)
  } finally {
    await ctx.close()
  }
}

// (q4) A submitted Create form closes at once while its POST is held; a pending toast follows it.
async function scenarioQ4(browser) {
  console.log('  -- q4: a submitted Create form closes at once while its POST is held')
  const { ctx, page } = await openPage(browser)
  let post = null
  try {
    await h.uiLogin(page, stack, owner)
    await openTransactions(page)
    const form = await createTransactionUI(page, { accountName: 'Owner Checking', amount: 50, description: 'Overlay Q4' })
    post = await h.gate(page, (r) => r.method() === 'POST' && new URL(r.url()).pathname.endsWith('/transactions/'))
    await form.evaluate((f) => f.requestSubmit())
    await post.waitHits(1)
    await h.check('q4.form-closes-at-once', 'B', async () => (await h.expectAbsentFor(page, form, 300)) || 'the form is still open')
    // A pending toast names the figure and the account ("Saving ₱50.00 to Owner Checking…").
    await h.check('q4.pending-toast', 'B', async () => (await waitToast(page, '₱50.00', 'pending', 3000)) || 'no pending toast')
    post.release({ disarm: true })
    await h.check('q4.saved', 'B', async () => (await waitToast(page, 'Overlay Q4', 'saved')) || 'no Saved toast')
    await checkNoOverlay('q4.no-overlay', page)
  } finally {
    post?.release({ disarm: true })
    await ctx.close()
  }
}

// (q5) While a save is held no key loses its default: browser shortcuts and letters alike.
async function scenarioQ5(browser) {
  console.log('  -- q5: F5, Ctrl+R and a letter keep their default while a save is held')
  const card = await makeCard(owner, 'Card Q5')
  const { ctx, page } = await openPage(browser)
  let put = null
  try {
    await page.addInitScript(() => {
      window.__q5 = []
      window.addEventListener('keydown', (e) => { window.__q5.push(e) }, true)
    })
    await h.uiLogin(page, stack, owner)
    await openCardPanel(page, card.id)
    await page.locator(tid('card-minimum-edit')).first().click()
    await page.locator(tid('card-minimum-input')).fill('55.50')
    put = await h.gate(page, { method: 'PUT', url: /minimum-due$/ })
    await page.locator(tid('card-minimum-save')).click()
    await put.waitHits(1)
    // Read after the event finished dispatching, so a bubble-phase preventDefault counts.
    const kept = await page.evaluate(() => {
      const out = {}
      for (const [name, init] of [['F5', { key: 'F5' }], ['Ctrl+R', { key: 'r', ctrlKey: true }], ['a', { key: 'a' }]]) {
        window.__q5.length = 0
        document.body.dispatchEvent(new KeyboardEvent('keydown', { ...init, bubbles: true, cancelable: true }))
        out[name] = window.__q5[0] ? window.__q5[0].defaultPrevented : 'not seen'
      }
      return out
    })
    await h.check('q5.keys-keep-default', 'B', async () => (kept.F5 === false && kept['Ctrl+R'] === false && kept.a === false) || JSON.stringify(kept))
  } finally {
    put?.release({ disarm: true })
    await ctx.close()
  }
}

// (s) The Transactions destination lookup held: the action modal opens and closes meanwhile,
// and a failed lookup leaves the page working.
async function scenarioS(browser) {
  console.log('\n=== (s) a held, then failing, destination lookup blocks nothing')
  const dest = await client.post(owner.token, '/accounts/', { name: 'Overlay S Dest', account_type: 'savings', balance: 0, currency: 'PHP' })
  await client.post(owner.token, '/transactions/', {
    account_id: bank.id, transaction_type: 'transfer', transfer_from_account_id: bank.id, transfer_to_account_id: dest.id, amount: 60,
    description: 'Overlay S transfer', transaction_date: wire(today), is_posted: false,
  })
  await client.put(owner.token, `/accounts/${dest.id}`, { is_active: false })
  const { ctx, page } = await openPage(browser)
  let lookup = null
  try {
    await h.uiLogin(page, stack, owner)
    await openTransactions(page)
    lookup = await h.gate(page, (r) => r.method() === 'GET' && new URL(r.url()).pathname.endsWith(`/accounts/${dest.id}`), { failStatus: 500 })
    await txnRow(page, 'Overlay S transfer').click()
    await h.check('s.lookup-hit', 'S', async () => (await lookup.waitHits(1)) || 'no destination lookup')
    await page.getByRole('button', { name: 'Close actions modal' }).click()
    await h.check('s.modal-closes-while-held', 'B', async () => (await h.expectAbsentFor(page, page.getByRole('heading', { name: 'Transaction Actions' }), 500)) || 'modal still open')
    lookup.release({ disarm: true })
    await h.waitQuiet(page)
    await txnRow(page, 'Overlay S transfer').click()
    await page.getByRole('button', { name: 'Close actions modal' }).click()
    await h.check('s.modal-closes', 'B', async () => (await h.expectAbsentFor(page, page.getByRole('heading', { name: 'Transaction Actions' }), 500)) || 'modal still open')
    await checkNoOverlay('s.no-overlay', page)
  } finally {
    lookup?.release({ disarm: true })
    await ctx.close()
  }
}

// (t) An inline modal's first load: focus lands inside it.
async function scenarioT(browser) {
  console.log('\n=== (t) the inline share dialog keeps focus after its load')
  const acct = await client.post(owner.token, '/accounts/', { name: 'Overlay T Account', account_type: 'checking', balance: 100, currency: 'PHP' })
  const { ctx, page } = await openPage(browser)
  let shares = null
  try {
    await h.uiLogin(page, stack, owner)
    await page.goto(`${stack.webUrl}/accounts`)
    await page.getByText('Overlay T Account').first().waitFor()
    await h.waitQuiet(page)
    await openAccountActions(page, 'Overlay T Account')
    await h.waitQuiet(page)
    shares = await h.gate(page, (r) => r.method() === 'GET' && new URL(r.url()).pathname.endsWith(`/accounts/${acct.id}/shares`))
    await page.locator(tid('share-account')).focus()
    await page.keyboard.press('Enter')
    await h.check('t.hit', 'S', async () => (await shares.waitHits(1)) || 'no shares request')
    shares.release({ disarm: true })
    await h.waitQuiet(page)
    await h.check('t.list-renders', 'B', async () => (await page.locator(tid('share-email')).isVisible()) || 'share form not rendered')
    await h.check('t.focus-inside', 'B', async () => (await page.evaluate(() => !!document.activeElement?.closest('[data-testid="share-dialog"]'))) || `active ${await activeTestId(page)}`)
    await h.check('t.aria-modal', 'S', async () => (await page.locator(`${tid('share-dialog')} [role="dialog"][aria-modal="true"]`).count()) === 1 || 'no aria-modal')
    await checkNoOverlay('t.no-overlay', page)
  } finally {
    shares?.release({ disarm: true })
    await ctx.close()
  }
}

// (u) Sign-out with its request held (u1), and the 401 redirect guard (u2).
async function scenarioU(browser) {
  console.log('\n=== (u) u1: sign-out with its request held leaves nothing inert; u2: a 401 redirect guard')
  {
    const u = await h.makeUser(stack, 'u1')
    const { ctx, page } = await openPage(browser)
    let logout = null
    try {
      await h.uiLogin(page, stack, u)
      await openTransactions(page)
      await page.evaluate(() => { window.__stu335Marker = 1 })
      logout = await h.gate(page, { method: 'POST', url: /\/auth\/logout$/ })
      await page.getByRole('button', { name: /User u1 Test|Useru1 Test/ }).click()
      await page.getByRole('button', { name: 'Sign out' }).first().click()
      await h.check('u1.logout-held', 'S', async () => (await logout.waitHits(1)) || 'the logout request never started')
      await h.check('u1.login-shown', 'B', async () => {
        try {
          await page.waitForURL((url) => url.pathname === '/login', { timeout: 3000 })
          await page.locator('#email').waitFor({ timeout: 3000 })
          return true
        } catch (e) { return `url ${page.url()}` }
      })
      await h.check('u1.same-document', 'B', async () => (await page.evaluate(() => window.__stu335Marker)) === 1 || 'document replaced')
      await h.check('u1.nothing-inert', 'B', async () => (await inertCount(page)) === 0 || `${await inertCount(page)} inert`)
      await h.check('u1.typing-works', 'B', async () => {
        await page.locator('#email').fill('')
        await page.locator('#email').pressSequentially('abc')
        return (await page.locator('#email').inputValue()) === 'abc' || await page.locator('#email').inputValue()
      })
      await checkNoOverlay('u1.no-overlay', page)
    } finally {
      logout?.release({ disarm: true })
      await ctx.close()
    }
  }
  {
    const u = await h.makeUser(stack, 'u2')
    const { ctx, page } = await openPage(browser)
    const stops = []
    try {
      await h.uiLogin(page, stack, u)
      await page.locator(tid('net-worth')).waitFor()
      await h.waitQuiet(page)
      const refresh = await h.gate(page, { url: /\/auth\/refresh$/ }, { failStatus: 401 })
      refresh.release({ disarm: true })
      const fail = await h.failWith(page, isSnapshot, 401)
      stops.push(refresh, fail)
      await navLink(page, '/transactions').click()
      await h.check('u2.login', 'G', async () => {
        try { await page.waitForURL((url) => url.pathname === '/login', { timeout: 5000 }); await page.locator('#email').waitFor({ timeout: 3000 }); return true } catch { return `url ${page.url()}` }
      })
      await h.check('u2.nothing-inert', 'G', async () => (await inertCount(page)) === 0 || `${await inertCount(page)} inert`)
      await h.check('u2.typing-works', 'G', async () => {
        await page.locator('#email').pressSequentially('xyz')
        return (await page.locator('#email').inputValue()).endsWith('xyz') || await page.locator('#email').inputValue()
      })
    } finally {
      for (const s of stops) await s.stop()
      await ctx.close()
    }
  }
}

// (v) Household: views, then the default dashboard, each held: the page takes input throughout.
async function scenarioV(browser) {
  console.log('\n=== (v) Household: held views then dashboard block nothing')
  const u = await h.makeUser(stack, 'v')
  const { ctx, page } = await openPage(browser)
  const gates = []
  try {
    await h.uiLogin(page, stack, u)
    await page.locator(tid('net-worth')).waitFor()
    await h.waitQuiet(page)
    const views = await h.gate(page, (r) => r.method() === 'GET' && new URL(r.url()).pathname.endsWith('/household/'))
    const dash = await h.gate(page, (r) => r.method() === 'GET' && /\/household\/\d+\/dashboard$/.test(new URL(r.url()).pathname))
    gates.push(views, dash)
    await page.evaluate(() => { window.history.pushState({}, '', '/accounts/household'); window.dispatchEvent(new PopStateEvent('popstate')) })
    await h.check('v.views-hit', 'S', async () => (await views.waitHits(1)) || 'no views request')
    await h.check('v.nav-uncovered-views', 'B', () => uncovered(page, navLink(page, '/transactions')))
    views.release({ disarm: true })
    await h.check('v.dashboard-hit', 'S', async () => (await dash.waitHits(1)) || 'no dashboard request')
    await h.check('v.nav-uncovered-dashboard', 'B', () => uncovered(page, navLink(page, '/transactions')))
    dash.release({ disarm: true })
    await h.waitQuiet(page)
    await checkNoOverlay('v.no-overlay', page)
  } finally {
    for (const g of gates) g.release({ disarm: true })
    await ctx.close()
  }
}

// (z) The export's download completes while a tag save is held.
async function scenarioZ(browser) {
  console.log('\n=== (z) an export download completes while a save is held')
  const { ctx, page } = await openPage(browser)
  const gates = []
  try {
    await h.uiLogin(page, stack, owner)
    await page.goto(`${stack.webUrl}/settings`)
    await page.locator(tid('tags-section')).waitFor()
    await h.waitQuiet(page)
    const exp = await h.gate(page, (r) => r.method() === 'GET' && new URL(r.url()).pathname.endsWith('/data/export.json'))
    gates.push(exp)
    await page.getByRole('button', { name: 'JSON', exact: true }).click()
    await exp.waitHits(1)
    await page.locator(tid('tags-section')).getByRole('button', { name: 'Add tag' }).click()
    await page.locator('#tag-name').fill('overlay-z')
    const tagPost = await h.gate(page, { method: 'POST', url: /\/tags\/$/ })
    gates.push(tagPost)
    await page.getByRole('button', { name: 'Create', exact: true }).click()
    await tagPost.waitHits(1)
    const download = page.waitForEvent('download', { timeout: 3000 }).then((d) => d, () => null)
    exp.release({ disarm: true })
    const d = await download
    await h.check('z.download-while-saving', 'B', async () =>
      (d !== null && d.suggestedFilename().startsWith('tally_trace_export_') && tagPost.hits === 1) ||
      `download ${d && d.suggestedFilename()}`)
    tagPost.release({ disarm: true })
    await h.waitQuiet(page)
    await h.check('z.nothing-inert', 'B', async () => (await inertCount(page)) === 0 || `${await inertCount(page)} inert`)
    await checkNoOverlay('z.no-overlay', page)
  } finally {
    for (const g of gates) g.release({ disarm: true })
    await ctx.close()
  }
}

/**
 * Opens a dialog from a focused opener with its first load held, closes it with Escape while
 * the load is still held, and releases. Returns whether the load was held, whether Escape
 * closed it, and whether focus is back on the opener.
 */
async function openerRoundTrip(page, { opener, held, dialog }) {
  await opener.focus()
  await page.keyboard.press('Enter')
  const hit = await held.waitHits(1)
  const opened = await dialog.waitFor({ timeout: 3000 }).then(() => true, () => false)
  await page.keyboard.press('Escape')
  const closed = opened && (await h.expectAbsentFor(page, dialog, 300))
  held.release({ disarm: true })
  await h.waitQuiet(page)
  const marker = await opener.evaluate((el) => el === document.activeElement).catch(() => false)
  return { hit, closed, focusOnOpener: marker, active: await activeTestId(page) }
}

// (w) Dialog openers: Escape closes a dialog while its first load is held, and focus returns
// to the opener.
async function scenarioW(browser) {
  console.log('\n=== (w) Escape closes each dialog during its held first load; focus returns to its opener')
  const u = await h.makeUser(stack, 'w')
  const checking = await client.post(u.token, '/accounts/', { name: 'W Checking', account_type: 'checking', balance: 50000, currency: 'PHP' })
  const presets = await client.get(u.token, '/accounts/minimum-due-presets')
  const wCard = await client.post(u.token, '/accounts/', {
    name: 'W Card', account_type: 'credit', balance: 0, currency: 'PHP', credit_limit: 50000,
    billing_cycle_start: closeDom, days_until_due_date: 21, minimum_due_rule: presets.find((p) => p.key === 'bdo').rule, payment_account_id: checking.id,
  })
  await client.post(u.token, '/transactions/', { account_id: wCard.id, transaction_type: 'debit', amount: 900, description: 'W purchase', transaction_date: wire(addDays(close, -3)), is_posted: true })
  // Due today: Due and overdue lists today and earlier, never a later day.
  const bill = await entry(u, { name: 'W Bill', amount: 700, account_id: checking.id, next_occurrence: wire(today) })
  await client.post(u.token, '/transactions/', { account_id: checking.id, transaction_type: 'debit', amount: 120, description: 'W spend', transaction_date: wire(today), is_posted: true })
  const { ctx, page } = await openPage(browser)
  const gates = []
  try {
    await h.uiLogin(page, stack, u)
    // w1: Card Pay from the account page.
    await openCardPanel(page, wCard.id)
    const credit = await creditGate(page, wCard.id)
    gates.push(credit)
    const w1 = await openerRoundTrip(page, { opener: page.locator(tid('card-pay-open')), held: credit, dialog: page.locator(tid('card-pay-dialog')) })
    await h.check('w1.held', 'S', async () => w1.hit || 'the mount refetch never started')
    await h.check('w1.escape-closes', 'B', async () => w1.closed || 'Escape did not close the dialog')
    await h.check('w1.focus-opener', 'B', async () => w1.focusOnOpener || `active ${w1.active}`)

    // w2: Mark paid from a Due row.
    await openTransactions(page)
    const row = await showRow(page, dueRecurring(page, 'W Bill'))
    const occurrences = await h.gate(page, (r) => r.method() === 'GET' && new URL(r.url()).pathname.endsWith(`/budget-entries/${bill.id}/occurrences`))
    gates.push(occurrences)
    const w2 = await openerRoundTrip(page, { opener: row.locator(tid('due-mark-paid')), held: occurrences, dialog: page.locator(tid('mark-paid-dialog')) })
    await h.check('w2.held', 'S', async () => w2.hit || 'the occurrences load never started')
    await h.check('w2.escape-closes', 'B', async () => w2.closed || 'Escape did not close the dialog')
    await h.check('w2.focus-opener', 'B', async () => w2.focusOnOpener || `active ${w2.active}`)

    // w3: the spending breakdown (opened from Transactions).
    const summary = await h.gate(page, (r) => r.method() === 'GET' && new URL(r.url()).pathname.endsWith('/transactions/summary/period'))
    gates.push(summary)
    const w3 = await openerRoundTrip(page, { opener: page.getByRole('button', { name: 'Spending breakdown' }), held: summary, dialog: page.locator(tid('spending-breakdown-dialog')) })
    await h.check('w3.held', 'S', async () => w3.hit || 'the breakdown load never started')
    await h.check('w3.escape-closes', 'B', async () => w3.closed || 'Escape did not close the dialog')
    await h.check('w3.focus-opener', 'B', async () => w3.focusOnOpener || `active ${w3.active}`)
    await checkNoOverlay('w.no-overlay', page)
  } finally {
    for (const g of gates) g.release({ disarm: true })
    await ctx.close()
  }
}

// (y) A held search: the search box keeps focus and every kind of typing, the last search is
// the one sent, the list equals the API's, and the month control works.
async function scenarioY(browser) {
  console.log('\n=== (y) typing continues in the search box while its load is held')
  const u = await h.makeUser(stack, 'y')
  const acct = await client.post(u.token, '/accounts/', { name: 'Y Checking', account_type: 'checking', balance: 5000, currency: 'PHP' })
  for (const description of ['Yarn abcdefgh shop', 'Yeast abcdefgh bakery', 'Yam stall']) {
    await client.post(u.token, '/transactions/', {
      account_id: acct.id, transaction_type: 'debit', amount: 10, description, transaction_date: wire(today), is_posted: true,
    })
  }
  const { ctx, page } = await openPage(browser, { permissions: ['clipboard-read', 'clipboard-write'] })
  let gate = null
  try {
    await h.uiLogin(page, stack, u)
    await openTransactions(page)
    await page.evaluate(() => navigator.clipboard.writeText('ef'))
    const search = page.locator(SEARCH)
    await search.click()
    await page.evaluate((sel) => {
      window.__yFocusOut = []
      document.querySelector(sel).addEventListener('focusout', (e) => window.__yFocusOut.push(e.relatedTarget?.tagName ?? 'null'))
    }, SEARCH)
    const gated = await searchGate(page)
    gate = gated.g
    const focused = []
    const step = async (name) => focused.push([name, await activeTestId(page)])
    await search.pressSequentially('ab')
    await step('ab')
    await h.check('y.search-hit', 'S', async () => (await gate.waitHits(1)) || 'the search request never started')
    await page.keyboard.type('c')
    await step('c')
    await h.sleep(400)
    await page.keyboard.type('d')
    await step('d')
    await page.keyboard.press('Control+V')
    await step('paste')
    const cdp = await ctx.newCDPSession(page)
    await cdp.send('Input.imeSetComposition', { text: 'gh', selectionStart: 2, selectionEnd: 2 })
    await cdp.send('Input.insertText', { text: 'gh' })
    await step('ime')
    await page.keyboard.press('Control+A')
    await page.keyboard.press('Control+X')
    await step('cut')
    await page.keyboard.press('Control+V')
    await step('paste-back')
    const valueAfter = await search.inputValue()
    await h.check('y.focus-kept', 'B', async () => {
      const outs = await page.evaluate(() => window.__yFocusOut)
      const lost = focused.filter(([, id]) => id !== 'transactions-search')
      return (lost.length === 0 && outs.length === 0) || `lost ${JSON.stringify(lost)} focusout ${JSON.stringify(outs)}`
    })
    await h.check('y.value', 'B', async () => valueAfter === 'abcdefgh' || `value "${valueAfter}"`)
    const sent = await (async () => {
      const until = Date.now() + 3000
      while (Date.now() < until) {
        if (gated.urls.some((url) => url.searchParams.get('search') === 'abcdefgh')) return true
        await h.sleep(50)
      }
      return false
    })()
    const lastUrl = gated.urls[gated.urls.length - 1]
    await h.check('y.last-search', 'B', async () => (sent && lastUrl?.searchParams.get('search') === 'abcdefgh') || `searches ${JSON.stringify(gated.urls.map((url) => url.searchParams.get('search')))}`)
    gate.release({ disarm: true })
    await h.check('y.list-matches-api', 'B', async () => {
      await h.waitQuiet(page)
      // The main list is the abcdefgh request with the earliest start (the other runs from tomorrow).
      const main = gated.urls
        .filter((url) => url.searchParams.get('search') === 'abcdefgh')
        .sort((x, y) => (x.searchParams.get('start_date') || '').localeCompare(y.searchParams.get('start_date') || ''))[0]
      if (!main) return 'no main-list request carried search=abcdefgh'
      const query = main.search
      const rows = await client.get(u.token, `/transactions/${query}`)
      const expected = (Array.isArray(rows) ? rows : rows.items || []).map((t) => t.description).sort()
      const shown = (await page.locator('article[role="button"]').allTextContents()).map((t) => t.replace(/\s+/g, ' '))
      const ok = expected.length === shown.length && expected.every((d) => shown.some((t) => t.includes(d)))
      return (ok && expected.length === 2) || `api ${JSON.stringify(expected)} shown ${JSON.stringify(shown)} query ${query}`
    })
    // A held search does not hold back the month control.
    gate = (await searchGate(page)).g
    await page.keyboard.type('z')
    await gate.waitHits(1)
    const label = await monthLabel(page)
    await page.locator(PREV_MONTH).click()
    await h.check('y.month-click-works', 'B', async () => {
      const after = await monthLabel(page)
      return after !== label || `label stayed "${label}"`
    })
    await checkNoOverlay('y.no-overlay', page)
  } finally {
    gate?.release({ disarm: true })
    await ctx.close()
  }
  await scenarioY2(browser)
}

// (y) y2: the page unmounts under a held search (browser Back): the next page works, nothing
// is left inert, and the search box works on return.
async function scenarioY2(browser) {
  console.log('\n=== (y) y2: browser Back during a held search')
  const { ctx, page } = await openPage(browser)
  let gate = null
  try {
    await h.uiLogin(page, stack, owner)
    await h.waitQuiet(page)
    await navLink(page, '/transactions').click()
    await page.waitForURL((url) => url.pathname === '/transactions')
    await page.locator(tid('due-section')).waitFor()
    await page.locator(tid('due-count')).filter({ hasNotText: '…' }).waitFor()
    await h.waitQuiet(page)
    await page.evaluate(() => { window.__y2Marker = 1 })
    const search = page.locator(SEARCH)
    await search.click()
    ;({ g: gate } = await searchGate(page))
    await search.pressSequentially('ab')
    await h.check('y2.search-hit', 'S', async () => (await gate.waitHits(1)) || 'the search request never started')
    await page.goBack({ timeout: 5000 }).catch(() => null)
    await h.check('y2.same-document', 'S', async () => {
      try { await page.waitForURL((url) => url.pathname === '/', { timeout: 3000 }) } catch { return `url ${page.url()}` }
      const r = await page.evaluate((sel) => ({ marker: window.__y2Marker ?? null, box: document.querySelector(sel) !== null }), SEARCH)
      return (r.marker === 1 && r.box === false) || JSON.stringify(r)
    })
    await h.check('y2.page-uncovered', 'B', () => uncovered(page, navLink(page, '/transactions')))
    gate.release({ disarm: true })
    await h.check('y2.no-inert', 'B', async () => (await inertCount(page)) === 0 || `inert ${await inertCount(page)}`)
    await h.check('y2.next-page-usable', 'B', async () => {
      await h.waitQuiet(page)
      await navLink(page, '/transactions').click()
      try { await page.waitForURL((url) => url.pathname === '/transactions', { timeout: 3000 }) } catch { return `url ${page.url()}` }
      await search.waitFor({ timeout: 5000 }).catch(() => null)
      await h.waitQuiet(page)
      await search.click()
      await search.pressSequentially('zq')
      return (await search.inputValue()) === 'zq' || `value "${await search.inputValue()}"`
    })
    await checkNoOverlay('y2.no-overlay', page)
  } finally {
    gate?.release({ disarm: true })
    await ctx.close()
  }
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function setup() {
  today = manilaToday()
  const anchor = addDays(today, -5)
  closeDom = Math.min(Number(anchor.slice(8, 10)), 28)
  close = `${anchor.slice(0, 8)}${String(closeDom).padStart(2, '0')}`
  owner = await h.makeUser(stack, 'owner')
  const presets = await client.get(owner.token, '/accounts/minimum-due-presets')
  bdoRule = presets.find((p) => p.key === 'bdo').rule
  bank = await client.post(owner.token, '/accounts/', { name: 'Owner Checking', account_type: 'checking', balance: 100000, currency: 'PHP' })
}

const SCENARIOS = [
  ['a', scenarioA],
  ['b', scenarioB],
  ['i', scenarioI],
  ['o', scenarioO],
  ['tap', scenarioTap],
  ['r', scenarioR],
  ['q', scenarioQ],
  ['j', scenarioJ],
  ['c', scenarioC],
  ['k', scenarioK],
  ['d', scenarioD],
  ['e', scenarioE],
  ['f', scenarioF],
  ['g', scenarioG],
  ['g3', scenarioG3],
  ['l', scenarioL],
  ['s', scenarioS],
  ['t', scenarioT],
  ['u', scenarioU],
  ['v', scenarioV],
  ['z', scenarioZ],
  ['w', scenarioW],
  ['y', scenarioY],
]

;(async () => {
  // A stray rejection from a failed scenario is reported, never a crash without RESULT.
  process.on('unhandledRejection', (e) => console.log(`  NOTE unhandled rejection: ${e && e.message ? e.message.split('\n')[0] : e}`))
  if (only && !SCENARIOS.some(([name]) => name === only)) {
    console.error(`Unknown scenario "${only}". Scenarios: ${SCENARIOS.map(([name]) => name).join(', ')}`)
    process.exit(2)
  }
  stack = await startLocalStack()
  client = h.apiClient(stack)
  const browser = await chromium.launch()
  try {
    await setup()
  } catch (e) {
    console.error('SETUP FAILED', e)
    stack.stop()
    process.exit(2)
  }
  for (const [name, run] of SCENARIOS) {
    if (only && only !== name) continue
    try {
      await run(browser)
    } catch (e) {
      await h.check(`${name}.completed`, 'B', async () => `scenario threw: ${e && e.stack ? e.stack.split('\n').slice(0, 3).join(' | ') : e}`)
    }
  }
  await browser.close()
  stack.stop()
  process.exit(h.report())
})().catch((e) => { console.error(e); stack?.stop(); process.exit(2) })
