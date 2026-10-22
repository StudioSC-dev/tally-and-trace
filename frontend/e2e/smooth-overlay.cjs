// Browser checks for STU-335's screen loader (plan 3.7, overlay scenarios in 5.2): one
// app-wide overlay that blocks input while any RTK request is in flight and dims the
// screen after 300 ms. Starts its own API and web app against a throwaway database
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
const { allDueRows, showRow } = require('./_due_pages.cjs')

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
const isGet = (suffix) => (r) => r.method() === 'GET' && pathIs(suffix)(r)

/** A response (or request) wait that never rejects: null at its bound, so a failed scenario cannot crash the run. */
const waitResponse = (page, pred) => page.waitForResponse(pred, { timeout: 10000 }).catch(() => null)
const waitRequest = (page, pred) => page.waitForRequest(pred, { timeout: 10000 }).catch(() => null)

/** A fresh page that records the overlay's phase and stuck history from its first document. */
async function openPage(browser, contextOptions = {}, { clock = null } = {}) {
  const { ctx, page } = await h.newPage(browser, contextOptions)
  page.setDefaultTimeout(10000)
  if (clock) await page.clock.install({ time: clock })
  await h.recordTexts(page, ['busy-overlay', 'busy-status'], { attributes: ['data-phase', 'data-stuck'], timestamps: true })
  const requests = h.logRequests(page)
  return { ctx, page, requests }
}

/** The recorded `data-phase` values and their page times since the last resetTexts. */
async function phaseHistory(page) {
  const t = (await h.readTexts(page))['busy-overlay'] || { attrs: {}, attrTimes: {} }
  return { phases: t.attrs['data-phase'] || [], times: t.attrTimes['data-phase'] || [] }
}
async function statusTexts(page) {
  return ((await h.readTexts(page))['busy-status'] || { texts: [] }).texts
}
const visible = (page, ms = 3000) => h.waitPhase(page, 'visible', ms)
const clears = (page, ms = 5000) => h.waitPhase(page, 'hidden', ms)
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

/** Each statement's owed figure on the panel equals the API's. */
async function panelMatchesApi(page, cardId) {
  const detail = await creditOf(owner, cardId)
  const shown = await page.locator(tid('card-statement')).evaluateAll((rows) =>
    rows.map((r) => [r.getAttribute('data-close'), (r.querySelector('[data-testid="card-statement-owed"]')?.textContent || '').trim()]))
  const expected = detail.statements.map((s) => [s.close_date, peso(s.owed)])
  const sort = (a) => [...a].sort((x, y) => x[0].localeCompare(y[0]))
  return JSON.stringify(sort(shown)) === JSON.stringify(sort(expected)) || `shown ${JSON.stringify(shown)} api ${JSON.stringify(expected)}`
}

// ─── Scenarios ───────────────────────────────────────────────────────────────

// (a) The owner's flow: Pay a card, the save and its reload block, the dialog survives.
async function scenarioA(browser) {
  console.log('\n=== (a) owner\'s flow: Pay blocks input until the save and its reload land')
  const card = await makeCard(owner, 'Card A')
  const { ctx, page } = await openPage(browser)
  const post = { gate: null }, credit = { gate: null }
  try {
    await h.uiLogin(page, stack, owner)
    await openCardPanel(page, card.id)
    const dialog = await openPayDialog(page)
    const cancelBox = await boxOf(dialog.getByRole('button', { name: 'Cancel' }))
    post.gate = await payGate(page, card.id)
    credit.gate = await creditGate(page, card.id)
    await h.resetTexts(page)
    await dialog.locator(tid('card-pay-submit')).click()
    await page.keyboard.press('Escape')
    await h.check('a.visible', 'B', async () => (await visible(page)) || 'never visible')
    await h.check('a.escape-in-shield', 'S', async () => {
      const inputs = await h.readInputs(page)
      const { phases, times } = await phaseHistory(page)
      const esc = inputs.find((i) => i.type === 'keydown' && i.key === 'Escape')
      const shownAt = times[phases.indexOf('visible')]
      return (esc && shownAt !== undefined && esc.t < shownAt) || `escape ${JSON.stringify(esc)} visible at ${shownAt}`
    })
    await h.check('a.delay', 'B', async () => {
      const inputs = await h.readInputs(page)
      const down = inputs.find((i) => i.type === 'pointerdown')
      const { phases, times } = await phaseHistory(page)
      const shownAt = times[phases.indexOf('visible')]
      return (down && shownAt - down.t >= 280) || `pointerdown ${down && down.t} visible ${shownAt}`
    })
    await h.check('a.status-saving', 'B', async () => (await text(page.locator(tid('busy-status')))) === 'Saving…' || await text(page.locator(tid('busy-status'))))
    await h.clickBox(page, cancelBox)
    await h.check('a.cancel-blocked', 'B', async () => (await dialog.isVisible()) || 'dialog closed')
    await page.keyboard.press('Enter')
    await page.keyboard.press('Escape')
    await h.sleep(300)
    await h.check('a.no-second-post', 'B', async () => post.gate.hits === 1 || `hits ${post.gate.hits}`)
    await h.check('a.escape-at-visible', 'B', async () => {
      const focusInHost = await page.evaluate(() => !!document.activeElement?.closest('[data-busy-host]'))
      await page.keyboard.press('Escape')
      await h.sleep(200)
      return ((await dialog.isVisible()) && focusInHost) || `dialog ${await dialog.isVisible()} focus in host ${focusInHost}`
    })
    const posted = waitResponse(page, (r) => r.request().method() === 'POST' && pathIs(`/cards/${card.id}/payments`)(r))
    post.gate.release({ disarm: true })
    await posted
    await h.sleep(1500)
    await h.check('a.held-by-reload', 'B', async () => (await h.overlayPhase(page)) === 'visible' || `phase ${await h.overlayPhase(page)}`)
    credit.gate.release({ disarm: true })
    await h.check('a.clears', 'B', async () => (await clears(page)) || `phase ${await h.overlayPhase(page)}`)
    await h.check('a.panel-equals-api', 'B', () => panelMatchesApi(page, card.id))
    await h.check('a.focus-opener', 'B', async () => (await activeTestId(page)) === 'card-pay-open' || `active ${await activeTestId(page)}`)
  } finally {
    post.gate?.release({ disarm: true })
    credit.gate?.release({ disarm: true })
    await ctx.close()
  }
}

// (b) One reload, nothing else in flight: a minimum save holds the overlay through its reload.
async function scenarioB(browser) {
  console.log('\n=== (b) a minimum save holds the overlay through exactly one reload')
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
    await h.check('b.visible', 'B', async () => (await visible(page)) || 'never visible')
    await h.clickBox(page, saveBox)
    await h.sleep(300)
    await h.check('b.no-second-put', 'B', async () => put.hits === 1 || `hits ${put.hits}`)
    const putDone = waitResponse(page, (r) => r.request().method() === 'PUT' && r.url().endsWith('minimum-due'))
    put.release({ disarm: true })
    await putDone
    await h.sleep(500)
    await h.check('b.held-by-reload', 'B', async () => (await h.overlayPhase(page)) === 'visible' || `phase ${await h.overlayPhase(page)}`)
    credit.release({ disarm: true })
    await h.check('b.clears', 'B', async () => (await clears(page)) || `phase ${await h.overlayPhase(page)}`)
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
  } finally {
    for (const g of gates) g.release({ disarm: true })
    await ctx.close()
  }
}

/** Advances a paused page clock to a moment just ahead and pauses there (plan 5.1). */
async function pauseNow(page) {
  const t = await page.evaluate(() => Date.now())
  await page.clock.pauseAt(t + 50)
}

// (h) Timing: shield at once, visible from 300 ms, at least 300 ms visible, a fast save never shows.
async function scenarioH(browser) {
  console.log('\n=== (h) timing: shield at once, visible after 300 ms, held 300 ms, a fast save never dims')
  const card = await makeCard(owner, 'Card H')
  const { ctx, page } = await openPage(browser, {}, { clock: new Date() })
  const gates = []
  try {
    await h.uiLogin(page, stack, owner)
    await openCardPanel(page, card.id)
    await page.locator(tid('card-minimum-edit')).first().click()
    await page.locator(tid('card-minimum-input')).fill('111.10')
    const saveBox = await boxOf(page.locator(tid('card-minimum-save')))
    await pauseNow(page)
    const put = await h.gate(page, { method: 'PUT', url: /minimum-due$/ })
    gates.push(put)
    await page.locator(tid('card-minimum-save')).click()
    await put.waitHits(1)
    await page.clock.runFor(250)
    await h.check('h.shield-at-250', 'B', async () => {
      const phase = await h.overlayPhase(page)
      await h.clickBox(page, saveBox)
      await h.sleep(300)
      return (phase === 'shield' && put.hits === 1) || `phase ${phase} hits ${put.hits}`
    })
    await page.clock.runFor(60)
    await h.check('h.visible-at-310', 'B', async () => (await h.overlayPhase(page)) === 'visible' || `phase ${await h.overlayPhase(page)}`)
    const putDone = waitResponse(page, (r) => r.request().method() === 'PUT' && r.url().endsWith('minimum-due'))
    const creditDone = waitResponse(page, (r) => r.request().method() === 'GET' && pathIs(`/cards/${card.id}/credit`)(r))
    put.release({ disarm: true })
    await putDone
    await creditDone
    await h.sleep(200)
    await page.clock.runFor(40)
    await h.check('h.min-visible', 'B', async () => (await h.overlayPhase(page)) === 'visible' || `phase ${await h.overlayPhase(page)}`)
    await page.clock.runFor(400)
    await h.check('h.hidden-after', 'B', async () => (await h.overlayPhase(page)) === 'hidden' || `phase ${await h.overlayPhase(page)}`)

    // Fast: a save that lands inside 300 ms never dims the screen.
    await page.locator(tid('card-minimum-edit')).first().click()
    await page.locator(tid('card-minimum-input')).fill('112.20')
    await pauseNow(page)
    const fast = await h.gate(page, { method: 'PUT', url: /minimum-due$/ })
    gates.push(fast)
    await h.resetTexts(page)
    await page.locator(tid('card-minimum-save')).click()
    await fast.waitHits(1)
    await page.clock.runFor(100)
    const fastPut = waitResponse(page, (r) => r.request().method() === 'PUT' && r.url().endsWith('minimum-due'))
    const fastCredit = waitResponse(page, (r) => r.request().method() === 'GET' && pathIs(`/cards/${card.id}/credit`)(r))
    fast.release({ disarm: true })
    await fastPut
    await fastCredit
    await h.sleep(200)
    await page.clock.runFor(400)
    await h.check('h.fast-never-visible', 'B', async () => {
      const { phases } = await phaseHistory(page)
      return (!phases.includes('visible') && phases.includes('shield')) || `phases ${JSON.stringify(phases)}`
    })
  } finally {
    for (const g of gates) g.release({ disarm: true })
    await ctx.close()
  }
}

// (i) A failed save: the overlay clears in one episode and the error is reachable.
async function scenarioI(browser) {
  console.log('\n=== (i) a failed save clears the overlay and shows the dialog error')
  const card = await makeCard(owner, 'Card I')
  const { ctx, page } = await openPage(browser)
  let post = null
  try {
    await h.uiLogin(page, stack, owner)
    await openCardPanel(page, card.id)
    const dialog = await openPayDialog(page)
    post = await h.gate(page, { method: 'POST', url: new RegExp(`/cards/${card.id}/payments$`) }, { failStatus: 500 })
    await dialog.locator(tid('card-pay-submit')).click()
    await h.check('i.visible', 'B', async () => (await visible(page)) || 'never visible')
    await h.resetTexts(page)
    const releasedAt = Date.now()
    post.release({ disarm: true })
    await h.check('i.clears-fast', 'B', async () => ((await clears(page, 1000)) && Date.now() - releasedAt <= 1200) || `phase ${await h.overlayPhase(page)}`)
    await h.sleep(500)
    await h.check('i.one-episode', 'B', async () => {
      const { phases } = await phaseHistory(page)
      const after = phases.slice(phases.indexOf('hidden') + 1)
      return (phases.includes('hidden') && after.length === 0) || `phases ${JSON.stringify(phases)}`
    })
    await h.check('i.error-shown', 'B', async () => (await dialog.locator(tid('card-pay-error')).isVisible()) || 'no card-pay-error')
    await dialog.getByRole('button', { name: 'Cancel' }).click()
    await h.check('i.cancel-closes', 'B', async () => (await h.expectAbsentFor(page, page.locator(tid('card-pay-dialog')), 500)) || 'dialog still open')
  } finally {
    post?.release({ disarm: true })
    await ctx.close()
  }
}

// (o) A load that never settles: after STUCK_MS the card offers Reload page (o1), and a
// focused search box reaches it with Tab (o2).
async function scenarioO(browser) {
  console.log('\n=== (o) o1: a save that never settles offers Reload page after 20 s')
  const card = await makeCard(owner, 'Card O')
  const { ctx, page } = await openPage(browser, {}, { clock: new Date() })
  let post = null
  try {
    await h.uiLogin(page, stack, owner)
    await openCardPanel(page, card.id)
    const dialog = await openPayDialog(page)
    const cancelBox = await boxOf(dialog.getByRole('button', { name: 'Cancel' }))
    await pauseNow(page)
    post = await payGate(page, card.id)
    await dialog.locator(tid('card-pay-submit')).click()
    await post.waitHits(1)
    await page.clock.runFor(STUCK_MS + 100)
    await h.sleep(200)
    await h.check('o1.stuck', 'B', async () => {
      const stuck = await page.locator(OVERLAY).getAttribute('data-stuck')
      const reload = page.locator(tid('busy-reload'))
      const card = await page.locator(OVERLAY).textContent()
      return (stuck === 'true' && (await reload.isVisible()) && card.includes('This is taking longer than usual.')) || `stuck ${stuck} text "${card}"`
    })
    await h.check('o1.status-stuck', 'B', async () => {
      const status = await text(page.locator(tid('busy-status')))
      return status === 'This is taking longer than usual.' || `status "${status}"`
    })
    await h.check('o1.no-tab-hint', 'B', async () => {
      const holders = await page.evaluate(() => Array.from(document.querySelectorAll('body *'))
        .filter((el) => Array.from(el.childNodes).some((n) => n.nodeType === Node.TEXT_NODE && (n.textContent || '').includes('Press Tab to reach Reload page.')))
        .map((el) => el.outerHTML.slice(0, 120)))
      return holders.length === 0 || `hint held by ${JSON.stringify(holders)}`
    })
    await h.clickBox(page, cancelBox)
    await h.sleep(300)
    await h.check('o1.cancel-blocked', 'B', async () => (await dialog.isVisible()) || 'dialog closed')
    await h.check('o1.one-post', 'B', async () => post.hits === 1 || `hits ${post.hits}`)
    const loaded = page.waitForEvent('load', { timeout: 10000 }).then(() => true, () => false)
    await page.locator(tid('busy-reload')).click()
    await h.check('o1.reloads', 'B', async () => (await loaded) || 'no load event')
  } finally {
    post?.release({ disarm: true })
    await ctx.close()
  }
  await scenarioO2(browser)
  await scenarioO2Press(browser)
}

// ─── Search passthrough helpers (commit 6a) ──────────────────────────────────

const SEARCH = tid('transactions-search')
const BOX = '[data-busy-passthrough-box]'
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
const apiRequests = (log) => log.filter((r) => r.url.includes('/api/')).length

// (o) o2: a focused search box stuck for 20 s keeps focus and typing; Tab reaches Reload.
async function scenarioO2(browser) {
  console.log('\n=== (o) o2: a stuck search load: focus stays in the box, Tab reaches Reload page')
  const { ctx, page, requests } = await openPage(browser, {}, { clock: new Date() })
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
    await page.clock.runFor(STUCK_MS + 100)
    await h.sleep(200)
    await h.check('o2.stuck', 'B', async () => (await page.locator(OVERLAY).getAttribute('data-stuck')) === 'true' || 'not stuck')
    await h.check('o2.card-stuck-once', 'B', async () => {
      const card = await text(page.locator(OVERLAY))
      const count = (needle) => card.split(needle).length - 1
      return (count('This is taking longer than usual.') === 1 && count('Press Tab to reach Reload page.') === 1) || `card "${card}"`
    })
    await h.check('o2.status-stuck', 'B', async () => {
      const status = await text(page.locator(tid('busy-status')))
      return status === 'This is taking longer than usual. Press Tab to reach Reload page.' || `status "${status}"`
    })
    await h.check('o2.focus-kept', 'B', async () => (await activeTestId(page)) === 'transactions-search' || `active ${await activeTestId(page)}`)
    await h.check('o2.reload-exposed', 'B', async () => {
      const r = await page.getByRole('button', { name: 'Reload page' }).evaluate((el) => ({
        id: el.getAttribute('data-testid'), hidden: el.closest('[aria-hidden="true"]') !== null,
      })).catch((e) => ({ error: e.message.split('\n')[0] }))
      return (r.id === 'busy-reload' && r.hidden === false) || JSON.stringify(r)
    })
    await page.keyboard.type('c')
    await h.check('o2.typing', 'B', async () => (await search.inputValue()) === 'abc' || `value "${await search.inputValue()}"`)
    const label = await monthLabel(page)
    const before = apiRequests(requests)
    await h.clickBox(page, await boxOf(page.locator(PREV_MONTH)))
    await h.sleep(300)
    await h.check('o2.month-blocked', 'B', async () => {
      const after = await monthLabel(page)
      return (after === label && apiRequests(requests) === before) || `label "${label}" -> "${after}", ${apiRequests(requests) - before} requests`
    })
    await page.keyboard.press('Tab')
    await h.check('o2.tab-to-reload', 'B', async () => (await activeTestId(page)) === 'busy-reload' || `active ${await activeTestId(page)}`)
    await h.check('o2.passthrough-ended', 'B', async () => {
      const r = await page.evaluate(([sel, box]) => ({
        raised: document.querySelector(box)?.classList.contains('z-[10051]') ?? null,
        inert: document.querySelector(sel)?.closest('[inert]') !== null,
      }), [SEARCH, BOX])
      return (r.raised === false && r.inert === true) || JSON.stringify(r)
    })
    const value = await search.inputValue()
    const beforeKey = apiRequests(requests)
    await page.keyboard.press('x')
    await h.sleep(200)
    await h.check('o2.letter-blocked', 'B', async () => {
      const inputs = await page.evaluate(() => Array.from(document.querySelectorAll('input')).map((i) => i.value).join('|'))
      return ((await search.inputValue()) === value && !inputs.includes('x') && apiRequests(requests) === beforeKey) || `value "${await search.inputValue()}" inputs ${inputs}`
    })
    const loaded = page.waitForEvent('load', { timeout: 10000 }).then(() => true, () => false)
    await page.keyboard.press('Enter')
    await h.check('o2.enter-reloads', 'B', async () => (await loaded) || 'no load event')
  } finally {
    gate?.release({ disarm: true })
    await ctx.close()
  }
}

// (o) o2: a mouse press near Reload page's bottom edge during a stuck search reloads the page.
// The press ends the passthrough; the card must not move Reload out from under the pointer.
async function scenarioO2Press(browser) {
  console.log('\n=== (o) o2: a press near the bottom of Reload page during a stuck search reloads')
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
    await h.check('o2.press-search-hit', 'S', async () => (await gate.waitHits(1)) || 'the search request never started')
    await page.clock.runFor(STUCK_MS + 100)
    await h.sleep(200)
    await h.check('o2.press-stuck', 'S', async () => (await activeTestId(page)) === 'transactions-search' || `active ${await activeTestId(page)}`)
    await page.evaluate(() => { window.__stu335Marker = 1 })
    const box = await boxOf(page.locator(tid('busy-reload')))
    const x = box.x + box.width / 2
    const y = box.y + box.height - 3
    const loaded = page.waitForEvent('load', { timeout: 10000 }).then(() => true, () => false)
    await page.mouse.move(x, y)
    await page.mouse.down()
    await h.sleep(100)
    await page.mouse.up()
    await h.check('o2.press-reloads', 'B', async () => {
      if (!(await loaded)) return 'no load event'
      const marker = await page.evaluate(() => window.__stu335Marker ?? null)
      return marker === null || 'the window marker survived'
    })
  } finally {
    gate?.release({ disarm: true })
    await ctx.close()
  }
}

// (r) Accessibility: the dialog semantics, reduced motion, the status and the inert shell.
async function scenarioR(browser) {
  console.log('\n=== (r) accessibility: dialog semantics, reduced motion, status, inert shell')
  const card = await makeCard(owner, 'Card R')
  const { ctx, page } = await openPage(browser, { reducedMotion: 'reduce' })
  const gates = []
  try {
    await h.uiLogin(page, stack, owner)
    await openCardPanel(page, card.id)
    await page.locator(tid('card-minimum-edit')).first().click()
    await page.locator(tid('card-minimum-input')).fill('99.90')
    const put = await h.gate(page, { method: 'PUT', url: /minimum-due$/ })
    const credit = await creditGate(page, card.id)
    gates.push(put, credit)
    await h.resetTexts(page)
    await page.locator(tid('card-minimum-save')).click()
    await visible(page)
    await h.check('r.dialog-semantics', 'S', async () => {
      const a = await page.locator(OVERLAY).evaluate((el) => [el.getAttribute('role'), el.getAttribute('aria-modal'), el.getAttribute('aria-label')])
      return JSON.stringify(a) === JSON.stringify(['dialog', 'true', 'Please wait']) || JSON.stringify(a)
    })
    await h.check('r.reduced-motion', 'B', async () => {
      const m = await page.locator(OVERLAY).evaluate((el) => [
        getComputedStyle(el.querySelector('[data-testid="spinner"]')).animationName,
        getComputedStyle(el).transitionDuration,
      ])
      return (m[0] === 'none' && m[1] === '0s') || JSON.stringify(m)
    })
    await h.check('r.shell-inert-while-blocked', 'B', async () => (await page.evaluate(() => document.querySelector('[data-app-shell]').hasAttribute('inert'))) || 'shell not inert')
    const putDone = waitResponse(page, (r) => r.request().method() === 'PUT' && r.url().endsWith('minimum-due'))
    put.release({ disarm: true })
    await putDone
    await h.sleep(500)
    credit.release({ disarm: true })
    await clears(page)
    await h.check('r.status-saving-until-hidden', 'B', async () => {
      const texts = await statusTexts(page)
      return JSON.stringify(texts) === JSON.stringify(['Saving…', '']) || JSON.stringify(texts)
    })
    await h.check('r.shell-not-inert-after', 'B', async () => (await page.evaluate(() => !document.querySelector('[data-app-shell]').hasAttribute('inert'))) || 'shell still inert')
  } finally {
    for (const g of gates) g.release({ disarm: true })
    await ctx.close()
  }
}

/** Starts the Pay save the way a script would, without an input event the guard could see. */
const startPaySave = (page) => page.evaluate(() => document.querySelector('[data-testid="card-pay-submit"]').click())

// (q) Input isolation: nothing typed or pressed while blocked reaches the app.
async function scenarioQ(browser) {
  console.log('\n=== (q) input isolation while blocked')
  // q0: under a paused clock, a key in shield changes nothing.
  {
    const card = await makeCard(owner, 'Card Q0')
    const { ctx, page } = await openPage(browser, {}, { clock: new Date() })
    let post = null
    try {
      await h.uiLogin(page, stack, owner)
      await openCardPanel(page, card.id)
      const dialog = await openPayDialog(page)
      const amount = dialog.locator(tid('card-pay-amount'))
      await amount.focus()
      const before = await amount.inputValue()
      await pauseNow(page)
      post = await payGate(page, card.id)
      await startPaySave(page)
      await post.waitHits(1)
      await page.clock.runFor(100)
      await page.keyboard.type('9')
      await h.check('q0.shield-at-key', 'B', async () => {
        const phase = await h.overlayPhase(page)
        const after = await amount.inputValue()
        return (phase === 'shield' && after === before) || `phase ${phase} amount ${before} -> ${after}`
      })
    } finally {
      post?.release({ disarm: true })
      await ctx.close()
    }
  }
  // q2: typing and Escape while a save is held change nothing.
  {
    const card = await makeCard(owner, 'Card Q2')
    const { ctx, page } = await openPage(browser)
    let post = null
    try {
      await h.uiLogin(page, stack, owner)
      await openCardPanel(page, card.id)
      const dialog = await openPayDialog(page)
      const amount = dialog.locator(tid('card-pay-amount'))
      await amount.focus()
      const before = await amount.inputValue()
      post = await payGate(page, card.id)
      await startPaySave(page)
      await post.waitHits(1)
      const phases = []
      await page.keyboard.type('9')
      phases.push(await h.overlayPhase(page))
      await page.keyboard.press('Escape')
      phases.push(await h.overlayPhase(page))
      await h.sleep(300)
      await h.check('q2.blocked-at-each-input', 'B', async () => phases.every((p) => p !== 'hidden' && p !== null) || JSON.stringify(phases))
      await h.check('q2.unchanged', 'B', async () => {
        const after = await amount.inputValue()
        return (post.hits === 1 && after === before && (await dialog.isVisible())) || `hits ${post.hits} amount ${before} -> ${after} open ${await dialog.isVisible()}`
      })
    } finally {
      post?.release({ disarm: true })
      await ctx.close()
    }
  }
  // q3: an IME composition the blur commits keeps the field and the state together.
  {
    const card = await makeCard(owner, 'Card Q3')
    const { ctx, page } = await openPage(browser)
    let post = null
    try {
      await h.uiLogin(page, stack, owner)
      await openCardPanel(page, card.id)
      const dialog = await openPayDialog(page)
      const amount = dialog.locator(tid('card-pay-amount'))
      await amount.fill('')
      await amount.focus()
      const cdp = await ctx.newCDPSession(page)
      post = await h.gate(page, { method: 'POST', url: new RegExp(`/cards/${card.id}/payments$`) }, { failStatus: 500 })
      await cdp.send('Input.imeSetComposition', { text: '5', selectionStart: 1, selectionEnd: 1 })
      await startPaySave(page)
      await post.waitHits(1)
      const phases = [await h.overlayPhase(page)]
      const beforeInsert = await amount.inputValue()
      await cdp.send('Input.insertText', { text: '7' })
      phases.push(await h.overlayPhase(page))
      await h.sleep(200)
      const afterInsert = await amount.inputValue()
      await h.check('q3.blocked-at-each-input', 'B', async () => phases.every((p) => p !== 'hidden' && p !== null) || JSON.stringify(phases))
      await h.check('q3.insert-ignored', 'B', async () => afterInsert === beforeInsert || `${beforeInsert} -> ${afterInsert}`)
      post.release()
      await clears(page)
      const shown = await amount.inputValue()
      const second = waitRequest(page, (r) => r.method() === 'POST' && pathIs(`/cards/${card.id}/payments`)(r))
      await dialog.locator(tid('card-pay-submit')).click()
      await post.waitHits(2)
      const req = await second
      await h.check('q3.display-and-state-agree', 'B', async () => {
        const body = JSON.parse((req && req.postData()) || '{}')
        return (shown !== '' && Number(body.amount) === Number(shown)) || `shown "${shown}" posted ${JSON.stringify(body)}`
      })
      post.release({ disarm: true })
      await clears(page)
      await h.check('q3.typing-works-after', 'G', async () => {
        await amount.fill('')
        await amount.pressSequentially('12')
        return (await amount.inputValue()) === '12' || await amount.inputValue()
      })
    } finally {
      post?.release({ disarm: true })
      await ctx.close()
    }
  }
  await scenarioQ1(browser)
  await scenarioQ4(browser)
  await scenarioQ5(browser)
}

// (j) A cold dialog's first load blocks until it lands, then focus is in the dialog.
async function scenarioJ(browser) {
  console.log('\n=== (j) a cold Pay from Due blocks until its first load lands')
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
    await h.check('j.visible', 'B', async () => (await visible(page)) || 'never visible')
    await h.clickBox(page, await boxOf(dialog.getByRole('button', { name: 'Cancel' })))
    await h.sleep(300)
    await h.check('j.cancel-blocked', 'B', async () => (await dialog.isVisible()) || 'dialog closed')
    credit.release({ disarm: true })
    await h.check('j.clears', 'B', async () => (await clears(page)) || `phase ${await h.overlayPhase(page)}`)
    await h.check('j.focus-in-dialog', 'B', async () => (await page.evaluate(() => !!document.activeElement?.closest('[data-testid="card-pay-dialog"]'))) || `active ${await activeTestId(page)}`)
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

/** Fills and submits the create-transaction modal (an expense on `accountName`). */
async function createTransactionUI(page, { accountName, amount, description }) {
  await page.getByRole('button', { name: 'Add Transaction' }).first().click()
  const form = page.locator('form').filter({ has: page.getByRole('button', { name: 'Create Transaction' }) })
  await form.waitFor()
  await h.waitQuiet(page)
  await form.locator('input[placeholder="Add notes about this transaction"]').fill(description)
  await form.locator('button[type="button"]').filter({ hasText: `${accountName}(PHP)` }).or(form.locator('button[type="button"]').filter({ hasText: accountName })).first().click()
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

// (c) A lazy reload after a create blocks until it lands.
async function scenarioC(browser) {
  console.log('\n=== (c) a lazy reload after a create blocks until it lands')
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
    const linkBox = await boxOf(navLink(page, '/forecast'))
    reload = await h.gate(page, (r) => r.method() === 'GET' && new URL(r.url()).pathname.endsWith('/accounts/') && new URL(r.url()).searchParams.get('limit') === '1000')
    await page.getByRole('button', { name: 'Create Account' }).click()
    await h.check('c.reload-hit', 'S', async () => (await reload.waitHits(1)) || 'the list reload never started')
    await h.check('c.visible', 'B', async () => (await visible(page)) || 'never visible')
    const before = page.url()
    await h.clickBox(page, linkBox)
    await h.sleep(500)
    await h.check('c.nav-blocked', 'B', async () => page.url() === before || `navigated to ${page.url()}`)
    reload.release({ disarm: true })
    await h.check('c.clears', 'B', async () => (await clears(page)) || `phase ${await h.overlayPhase(page)}`)
    await h.check('c.listed', 'B', async () => (await page.getByText('Overlay C Wallet').first().isVisible()) || 'new account not listed')
  } finally {
    reload?.release({ disarm: true })
    await ctx.close()
  }
}

// (k) Mark paid from Due: the record's reloads block; the row's buttons do nothing meanwhile.
async function scenarioK(browser) {
  console.log('\n=== (k) Mark paid from Due blocks until the snapshot and the list land')
  const u = await h.makeUser(stack, 'k')
  const checking = await client.post(u.token, '/accounts/', { name: 'K Checking', account_type: 'checking', balance: 50000, currency: 'PHP' })
  const rent = await entry(u, { name: 'K Rent', amount: 1500, account_id: checking.id, next_occurrence: wire(addDays(today, 3)) })
  const { ctx, page } = await openPage(browser)
  const gates = []
  try {
    await h.uiLogin(page, stack, u)
    await openTransactions(page)
    const row = await showRow(page, dueRecurring(page, 'K Rent'))
    const buttonBox = await boxOf(row.locator(tid('due-mark-paid')))
    await row.locator(tid('due-mark-paid')).click()
    const dialog = page.locator(tid('mark-paid-dialog'))
    await dialog.locator(tid('mark-paid-occurrence')).waitFor()
    await h.waitQuiet(page)
    const snap = await h.gate(page, isSnapshot)
    const list = await h.gate(page, isMainList(addDays(today, 1)))
    gates.push(snap, list)
    const done = waitResponse(page, (r) => r.url().endsWith(`/budget-entries/${rent.id}/materialize`))
    await dialog.locator(tid('mark-paid-submit')).click()
    await done
    await h.check('k.reloads-hit', 'S', async () => ((await snap.waitHits(1)) && (await list.waitHits(1))) || `snapshot ${snap.hits} list ${list.hits}`)
    await h.check('k.visible', 'B', async () => (await visible(page)) || 'never visible')
    await h.clickBox(page, buttonBox)
    await h.sleep(500)
    await h.check('k.row-buttons-blocked', 'B', async () => (await page.locator(tid('mark-paid-dialog')).count()) === 0 || 'a dialog opened')
    snap.release({ disarm: true })
    await h.sleep(300)
    await h.check('k.visible-while-list-held', 'B', async () => (await h.overlayPhase(page)) === 'visible' || `phase ${await h.overlayPhase(page)}`)
    list.release({ disarm: true })
    await h.check('k.clears', 'B', async () => (await clears(page)) || `phase ${await h.overlayPhase(page)}`)
    await h.check('k.dialog-closed-row-gone', 'B', async () => {
      const open = await page.locator(tid('mark-paid-dialog')).count()
      const rows = (await allDueRows(page)).filter((r) => r.text.includes('K Rent'))
      return (open === 0 && rows.length === 0) || `dialog ${open} rows ${rows.length}`
    })
    await h.check('k.focus-not-body', 'B', async () => (await page.evaluate(() => document.activeElement !== document.body && document.activeElement !== null)) || 'focus on body')
  } finally {
    for (const g of gates) g.release({ disarm: true })
    await ctx.close()
  }
}

// (d) Due's first load from a cached snapshot: stale rows are not actionable.
async function scenarioD(browser) {
  console.log('\n=== (d) Due first load from cache: the stale row cannot be acted on')
  const u = await h.makeUser(stack, 'd')
  const checking = await client.post(u.token, '/accounts/', { name: 'D Checking', account_type: 'checking', balance: 50000, currency: 'PHP' })
  const bill = await entry(u, { name: 'D Bill', amount: 800, account_id: checking.id, next_occurrence: wire(addDays(today, 2)) })
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
    await h.check('d.visible', 'B', async () => (await visible(page)) || 'never visible')
    const stale = page.locator(`${tid('due-row')}[data-kind="recurring"]`).filter({ hasText: 'D Bill' }).locator(tid('due-mark-paid'))
    await h.check('d.stale-row-shown', 'S', async () => (await stale.count()) > 0 || 'no stale row to click (cache not painted)')
    if ((await stale.count()) > 0) {
      await h.clickBox(page, await boxOf(stale.first()))
      await h.sleep(500)
    }
    await h.check('d.stale-row-blocked', 'B', async () => (await page.locator(tid('mark-paid-dialog')).count()) === 0 || 'MarkPaidDialog opened')
    snap.release({ disarm: true })
    await h.check('d.clears', 'B', async () => (await clears(page)) || `phase ${await h.overlayPhase(page)}`)
    await h.check('d.row-gone', 'B', async () => (await allDueRows(page)).filter((r) => r.text.includes('D Bill')).length === 0 || 'row still listed')
  } finally {
    snap?.release({ disarm: true })
    await ctx.close()
  }
}

// (e) A lazy first load in-app blocks, says Loading…, and makes one episode under StrictMode.
async function scenarioE(browser) {
  console.log('\n=== (e) a lazy first load blocks and says Loading…')
  const { ctx, page } = await openPage(browser)
  let g = null
  try {
    await h.uiLogin(page, stack, owner)
    await page.locator(tid('net-worth')).waitFor()
    await h.waitQuiet(page)
    g = await h.gate(page, (r) => r.method() === 'GET' && new URL(r.url()).pathname.endsWith('/allocations/'))
    await h.resetTexts(page)
    await navLink(page, '/allocations').click()
    await h.check('e.hit', 'S', async () => (await g.waitHits(1)) || 'no allocations request')
    await h.check('e.visible', 'B', async () => (await visible(page)) || 'never visible')
    await h.check('e.status-loading', 'B', async () => (await text(page.locator(tid('busy-status')))) === 'Loading…' || await text(page.locator(tid('busy-status'))))
    g.release({ disarm: true })
    await h.check('e.clears', 'B', async () => (await clears(page)) || `phase ${await h.overlayPhase(page)}`)
    await h.check('e.one-visible-run', 'B', async () => {
      const { phases } = await phaseHistory(page)
      return phases.filter((p) => p === 'visible').length === 1 || JSON.stringify(phases)
    })
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

// (f) Loads that now block: a period change (f1) and Card Pay's day-turn refetch (f2).
async function scenarioF(browser) {
  console.log('\n=== (f) f1: a dashboard period change blocks; f2: a day-turn refetch blocks Card Pay')
  {
    const { ctx, page, requests } = await openPage(browser)
    let g = null
    try {
      await h.uiLogin(page, stack, owner)
      await page.locator(tid('net-worth')).waitFor()
      await h.waitQuiet(page)
      const group = page.getByRole('group', { name: 'Period for actual totals' })
      const monthBox = await boxOf(group.getByRole('button', { name: 'month' }))
      g = await h.gate(page, (r) => r.method() === 'GET' && new URL(r.url()).pathname.endsWith('/transactions/summary/period'))
      await h.resetTexts(page)
      await group.getByRole('button', { name: 'year' }).click()
      await h.check('f1.shield-at-once', 'B', async () => {
        const phase = await h.overlayPhase(page)
        const since = await nowOf(page)
        await h.clickBox(page, monthBox)
        await h.sleep(400)
        const extra = requestsSince(requests, since, (r) => new URL(r.url).pathname.endsWith('/transactions/summary/period'))
        return (phase === 'shield' && extra.length === 0 && g.hits === 1) || `phase ${phase} extra ${extra.length} hits ${g.hits}`
      })
      await h.check('f1.visible-later', 'B', async () => (await visible(page)) || 'never visible')
      g.release({ disarm: true })
      await h.check('f1.clears', 'B', async () => (await clears(page)) || `phase ${await h.overlayPhase(page)}`)
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
      const submitBox = await boxOf(dialog.locator(tid('card-pay-submit')))
      const since = await nowOf(page)
      credit = await creditGate(page, card.id)
      await beforeCrossing(page, 'f2', requests, day, since, { cardId: card.id })
      const crossed = await h.crossDay(page)
      await h.check('f2.crossed', 'S', async () => crossed.after === addDays(day, 1) || JSON.stringify(crossed))
      await h.check('f2.refetch-hit', 'S', async () => (await credit.waitHits(1)) || `no credit GET; requests ${JSON.stringify(requests.filter((r) => r.url.includes('/api/')).slice(-8).map((r) => r.url))}`)
      const postsBefore = requests.filter((r) => r.method === 'POST' && r.url.endsWith(`/cards/${card.id}/payments`)).length
      await h.clickBox(page, submitBox)
      await h.sleep(500)
      await h.check('f2.submit-blocked', 'B', async () => {
        const posts = requests.filter((r) => r.method === 'POST' && r.url.endsWith(`/cards/${card.id}/payments`)).length
        return posts === postsBefore || `posts ${postsBefore} -> ${posts}`
      })
      await h.check('f2.amount-kept', 'B', async () => (await dialog.locator(tid('card-pay-amount')).inputValue()) === '123.45' || await dialog.locator(tid('card-pay-amount')).inputValue())
      credit.release({ disarm: true })
      await h.check('f2.clears', 'B', async () => (await clears(page)) || `phase ${await h.overlayPhase(page)}`)
      const posted = waitResponse(page, (r) => r.request().method() === 'POST' && pathIs(`/cards/${card.id}/payments`)(r))
      await dialog.locator(tid('card-pay-submit')).click()
      await posted
      await h.sleep(300)
      await h.check('f2.one-post', 'B', async () => {
        const posts = requests.filter((r) => r.method === 'POST' && r.url.endsWith(`/cards/${card.id}/payments`)).length
        return posts === postsBefore + 1 || `posts ${posts - postsBefore}`
      })
    } finally {
      credit?.release({ disarm: true })
      await ctx.close()
    }
  }
}

// (g) fetchReceipt is exempt; a tag create is the control.
async function scenarioG(browser) {
  console.log('\n=== (g) a receipt fetch never blocks; a tag create does')
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
    await h.resetTexts(page)
    await page.locator(tid('view-receipt')).click()
    await receipt.waitHits(1)
    await h.sleep(300)
    const label = await text(page.locator(tid('view-receipt')))
    await h.sleep(1200)
    await h.check('g.no-block', 'B', async () => {
      const { phases } = await phaseHistory(page)
      return (!phases.includes('shield') && !phases.includes('visible')) || JSON.stringify(phases)
    })
    await h.check('g.loading-label', 'B', async () => label === 'Loading receipt…' || label)
    receipt.release({ disarm: true })

    await page.goto(`${stack.webUrl}/settings`)
    await page.locator(tid('tags-section')).waitFor()
    await h.waitQuiet(page)
    await page.locator(tid('tags-section')).getByRole('button', { name: 'Add tag' }).click()
    await page.locator('#tag-name').fill('overlay-g')
    const tagPost = await h.gate(page, { method: 'POST', url: /\/tags\/$/ })
    gates.push(tagPost)
    await page.getByRole('button', { name: 'Create', exact: true }).click()
    await h.check('g.control-visible', 'B', async () => (await visible(page)) || 'the control never blocked')
    tagPost.release({ disarm: true })
    await clears(page)
  } finally {
    for (const g of gates) g.release({ disarm: true })
    await ctx.close()
  }
}

// (g3) An exempt request in flight does not delay a save's reload.
async function scenarioG3(browser) {
  console.log('\n=== (g3) a held receipt fetch does not open a gap between a save and its reload')
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
    await h.resetTexts(page)
    await form.getByRole('button', { name: 'Create Transaction' }).click()
    await h.check('g3.reload-while-receipt-held', 'B', async () => ((await snap.waitHits(1, 5000)) && receipt.hits === 1) || `snapshot hits ${snap.hits}`)
    await h.sleep(500)
    const { phases: during } = await phaseHistory(page)
    snap.release({ disarm: true })
    await h.check('g3.no-gap', 'B', async () => (during.length > 0 && !during.includes('hidden')) || JSON.stringify(during))
    await h.check('g3.clears', 'B', async () => (await clears(page)) || `phase ${await h.overlayPhase(page)}`)
    receipt.release({ disarm: true })
  } finally {
    for (const g of gates) g.release({ disarm: true })
    await ctx.close()
  }
}

// (l) A save during the day-turn loads: one episode until the last of them lands.
async function scenarioL(browser) {
  console.log('\n=== (l) a save during the day-turn loads holds the overlay until the last lands')
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
    await h.resetTexts(page)
    await page.locator(tid('card-minimum-save')).click()
    await put.waitHits(1)
    const crossed = await h.crossDay(page)
    await h.check('l.crossed', 'S', async () => crossed.after === next || JSON.stringify(crossed))
    await h.check('l.day-turn-hit', 'S', async () => ((await credit.waitHits(1)) && (await txns.waitHits(1))) ||
      `credit ${credit.hits} txns ${txns.hits}; requests ${JSON.stringify(requests.filter((r) => r.url.includes('/api/')).slice(-10).map((r) => r.url))}`)
    await h.check('l.visible', 'B', async () => (await visible(page)) || 'never visible')
    const putDone = waitResponse(page, (r) => r.request().method() === 'PUT' && r.url().endsWith('minimum-due'))
    put.release({ disarm: true })
    await putDone
    const creditHits = credit.hits
    await h.sleep(750)
    await h.check('l.joined', 'B', async () => credit.hits === creditHits || `new credit GETs ${credit.hits - creditHits}; ${JSON.stringify(requests.filter(isCredit(card.id)).map((r) => r.t))}`)
    await h.sleep(750)
    await h.check('l.visible-after-save', 'B', async () => (await h.overlayPhase(page)) === 'visible' || `phase ${await h.overlayPhase(page)}`)
    const creditDone = waitResponse(page, (r) => r.request().method() === 'GET' && pathIs(`/cards/${card.id}/credit`)(r))
    credit.release({ disarm: true })
    await creditDone
    await h.sleep(300)
    await h.check('l.held-by-transactions', 'B', async () => (await h.overlayPhase(page)) !== 'hidden' || 'hidden while the transactions GET is held')
    const txnsDone = waitResponse(page, (r) => r.request().method() === 'GET' && r.url().includes('/transactions/') && r.url().includes(`end_date=${next}`))
    txns.release({ disarm: true })
    await txnsDone.catch(() => null)
    const { phases } = await phaseHistory(page)
    await h.check('l.no-gap', 'B', async () => (phases.length > 0 && !phases.includes('hidden')) || JSON.stringify(phases))
    await h.check('l.clears', 'B', async () => (await clears(page)) || `phase ${await h.overlayPhase(page)}`)
    await h.check('l.minimum-equals-api', 'B', async () => {
      const latest = latestOf(await creditOf(owner, card.id))
      const shown = await text(page.locator(`${tid('card-statement')}[data-close="${latest.close_date}"] ${tid('card-statement-minimum')}`))
      return shown.includes(peso(latest.minimum_due.amount)) || `shown "${shown}" api ${latest.minimum_due.amount}`
    })
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

// (q1) An autosave select: keys after the save starts change nothing.
async function scenarioQ1(browser) {
  console.log('  -- q1: an autosave select ignores keys while its save is held')
  const editor = await h.makeUser(stack, 'q1ed')
  const shared = await client.post(owner.token, '/accounts/', { name: 'Overlay Q1 Shared', account_type: 'checking', balance: 100, currency: 'PHP' })
  await client.post(owner.token, `/accounts/${shared.id}/shares`, { email: editor.email, role: 'editor' })
  const { ctx, page } = await openPage(browser)
  let patch = null
  try {
    page.on('dialog', (d) => d.accept())
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
    patch = await h.gate(page, { method: 'PATCH', url: new RegExp(`/accounts/${shared.id}/shares/\\d+$`) })
    await select.selectOption(target)
    await patch.waitHits(1)
    const phases = []
    await page.keyboard.press('ArrowDown'); phases.push(await h.overlayPhase(page))
    await page.keyboard.press('ArrowDown'); phases.push(await h.overlayPhase(page))
    await page.keyboard.type('a'); phases.push(await h.overlayPhase(page))
    await h.check('q1.blocked-at-each-input', 'B', async () => phases.every((p) => p !== 'hidden' && p !== null) || JSON.stringify(phases))
    patch.release({ disarm: true })
    await clears(page)
    await h.check('q1.one-change', 'B', async () => {
      const shown = await select.inputValue()
      return (patch.hits === 1 && shown === target) || `hits ${patch.hits} select ${shown} wanted ${target}`
    })
  } finally {
    patch?.release({ disarm: true })
    await ctx.close()
  }
}

// (q4) A submitted form's number field takes no wheel steps while blocked.
async function scenarioQ4(browser) {
  console.log('  -- q4: a number field takes no wheel steps while its form saves')
  const { ctx, page } = await openPage(browser)
  let post = null
  try {
    await h.uiLogin(page, stack, owner)
    await openTransactions(page)
    const form = await createTransactionUI(page, { accountName: 'Owner Checking', amount: 50, description: 'Overlay Q4' })
    const amount = form.locator('input[type="number"][placeholder="0.00"]').first()
    await amount.focus()
    post = await h.gate(page, (r) => r.method() === 'POST' && new URL(r.url()).pathname.endsWith('/transactions/'))
    await form.evaluate((f) => f.requestSubmit())
    await post.waitHits(1)
    const box = await boxOf(amount)
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    await page.mouse.wheel(0, -300)
    await page.mouse.wheel(0, 300)
    await h.sleep(300)
    await h.check('q4.no-wheel-step', 'B', async () => (await amount.inputValue()) === '50' || await amount.inputValue())
  } finally {
    post?.release({ disarm: true })
    await ctx.close()
  }
}

// (q5) Browser shortcuts keep their default; other keys lose it.
async function scenarioQ5(browser) {
  console.log('  -- q5: F5 and Ctrl+R keep their browser default while blocked; a letter does not')
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
    const kept = await page.evaluate(() => {
      const out = {}
      for (const [name, init] of [['F5', { key: 'F5' }], ['Ctrl+R', { key: 'r', ctrlKey: true }], ['a', { key: 'a' }]]) {
        window.__q5.length = 0
        document.body.dispatchEvent(new KeyboardEvent('keydown', { ...init, bubbles: true, cancelable: true }))
        out[name] = window.__q5[0] ? window.__q5[0].defaultPrevented : 'not seen'
      }
      return out
    })
    await h.check('q5.shortcuts-keep-default', 'B', async () => (kept.F5 === false && kept['Ctrl+R'] === false && kept.a === true) || JSON.stringify(kept))
  } finally {
    put?.release({ disarm: true })
    await ctx.close()
  }
}

// (s) The Transactions destination lookup blocks, and a failed lookup clears.
async function scenarioS(browser) {
  console.log('\n=== (s) a failing destination lookup blocks, then clears')
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
    await h.check('s.visible', 'B', async () => (await visible(page)) || 'never visible')
    await h.sleep(Math.max(0, 1000 - 300))
    lookup.release({ disarm: true })
    await h.check('s.clears', 'B', async () => (await clears(page)) || `phase ${await h.overlayPhase(page)}`)
    await page.getByRole('button', { name: 'Close actions modal' }).click()
    await h.check('s.modal-closes', 'B', async () => (await h.expectAbsentFor(page, page.getByRole('heading', { name: 'Transaction Actions' }), 500)) || 'modal still open')
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
    await h.check('t.visible', 'B', async () => (await visible(page)) || 'never visible')
    shares.release({ disarm: true })
    await h.check('t.clears', 'B', async () => (await clears(page)) || `phase ${await h.overlayPhase(page)}`)
    await h.check('t.list-renders', 'B', async () => (await page.locator(tid('share-email')).isVisible()) || 'share form not rendered')
    await h.check('t.focus-inside', 'B', async () => (await page.evaluate(() => !!document.activeElement?.closest('[data-testid="share-dialog"]'))) || `active ${await activeTestId(page)}`)
    await h.check('t.aria-modal', 'S', async () => (await page.locator(`${tid('share-dialog')} [role="dialog"][aria-modal="true"]`).count()) === 1 || 'no aria-modal')
  } finally {
    shares?.release({ disarm: true })
    await ctx.close()
  }
}

// (u) Unmount cleanup: a same-document sign-out (u1), and the 401 redirect guard (u2).
async function scenarioU(browser) {
  console.log('\n=== (u) u1: sign-out mid-block leaves nothing inert; u2: a 401 redirect guard')
  {
    const u = await h.makeUser(stack, 'u1')
    const { ctx, page } = await openPage(browser)
    let logout = null
    try {
      await page.addInitScript(() => {
        window.__inertLog = []
        const start = () => new MutationObserver((records) => {
          for (const r of records) {
            const el = r.target
            // oldValue null: the attribute was absent before this change, so it was added.
            window.__inertLog.push({ shell: el.hasAttribute('data-app-shell'), on: r.oldValue === null, t: performance.now() })
          }
        }).observe(document.documentElement, { attributes: true, attributeOldValue: true, subtree: true, attributeFilter: ['inert'] })
        if (document.documentElement) start()
        else document.addEventListener('DOMContentLoaded', start, { once: true })
      })
      await h.uiLogin(page, stack, u)
      await openTransactions(page)
      await page.evaluate(() => { window.__stu335Marker = 1 })
      logout = await h.gate(page, { method: 'POST', url: /\/auth\/logout$/ })
      await page.getByRole('button', { name: /User u1 Test|Useru1 Test/ }).click()
      const clickedAt = await nowOf(page)
      await page.getByRole('button', { name: 'Sign out' }).first().click()
      await h.check('u1.block-started', 'S', async () => {
        await h.sleep(300)
        const log = await page.evaluate(() => window.__inertLog)
        return log.some((e) => e.shell && e.on && e.t >= clickedAt) || `clicked at ${clickedAt}; log ${JSON.stringify(log)}`
      })
      await h.check('u1.login-shown', 'B', async () => {
        try {
          await page.waitForURL((url) => url.pathname === '/login', { timeout: 3000 })
          await page.locator('#email').waitFor({ timeout: 3000 })
          return true
        } catch (e) { return `url ${page.url()}` }
      })
      await h.check('u1.same-document', 'B', async () => (await page.evaluate(() => window.__stu335Marker)) === 1 || 'document replaced')
      await h.check('u1.nothing-inert', 'B', async () => (await inertCount(page)) === 0 || `${await inertCount(page)} inert`)
      await h.check('u1.host-gone', 'B', async () => (await page.evaluate(() =>
        document.querySelector('[data-busy-host]') === null && document.querySelector('[data-busy-passthrough-box].z-\\[10051\\]') === null)) || 'host or raised box left behind')
      await h.check('u1.typing-works', 'B', async () => {
        await page.locator('#email').fill('')
        await page.locator('#email').pressSequentially('abc')
        return (await page.locator('#email').inputValue()) === 'abc' || await page.locator('#email').inputValue()
      })
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

// (v) A render hop (views, then the default dashboard) stays one episode.
async function scenarioV(browser) {
  console.log('\n=== (v) Household: views then the default dashboard are one episode')
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
    await h.check('v.visible', 'B', async () => (await visible(page)) || 'never visible')
    await h.resetTexts(page)
    views.release({ disarm: true })
    await h.check('v.dashboard-hit', 'S', async () => (await dash.waitHits(1)) || 'no dashboard request')
    await h.sleep(500)
    const { phases } = await phaseHistory(page)
    dash.release({ disarm: true })
    await h.check('v.no-gap', 'B', async () => !phases.includes('hidden') || JSON.stringify(phases))
    await h.check('v.clears', 'B', async () => (await clears(page)) || `phase ${await h.overlayPhase(page)}`)
  } finally {
    for (const g of gates) g.release({ disarm: true })
    await ctx.close()
  }
}

// (z) The export's download is never cancelled by a block.
async function scenarioZ(browser) {
  console.log('\n=== (z) an export download completes while the screen is blocked')
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
    const phaseAtDownload = await h.overlayPhase(page)
    await h.check('z.download-while-blocked', 'B', async () =>
      (d !== null && d.suggestedFilename().startsWith('tally_trace_export_') && phaseAtDownload !== 'hidden') ||
      `download ${d && d.suggestedFilename()} phase ${phaseAtDownload}`)
    tagPost.release({ disarm: true })
    await h.check('z.clears', 'B', async () => (await clears(page)) || `phase ${await h.overlayPhase(page)}`)
    await h.check('z.nothing-inert', 'B', async () => (await inertCount(page)) === 0 || `${await inertCount(page)} inert`)
  } finally {
    for (const g of gates) g.release({ disarm: true })
    await ctx.close()
  }
}

/**
 * Opens a dialog from a focused opener with its first load held, presses Escape at once
 * and again at `visible`, releases, waits, and closes it with `closeName`. Returns the
 * dialog's state after the Escapes and the focused element after the close.
 */
async function openerRoundTrip(page, { opener, held, dialog, closeName }) {
  await opener.focus()
  await page.keyboard.press('Enter')
  await page.keyboard.press('Escape')
  const hit = await held.waitHits(1)
  await visible(page)
  await page.keyboard.press('Escape')
  await h.sleep(200)
  const openAfterEscapes = (await dialog.count()) > 0 && (await dialog.isVisible())
  held.release({ disarm: true })
  await h.waitQuiet(page)
  if (openAfterEscapes) await dialog.getByRole('button', { name: closeName, exact: true }).click()
  await h.sleep(300)
  const marker = await opener.evaluate((el) => el === document.activeElement).catch(() => false)
  return { hit, openAfterEscapes, focusOnOpener: marker, active: await activeTestId(page) }
}

// (w) Dialog openers survive the screen loader's blur (StrictMode dev stack).
async function scenarioW(browser) {
  console.log('\n=== (w) each dialog returns focus to its opener after a blocked first load')
  const u = await h.makeUser(stack, 'w')
  const checking = await client.post(u.token, '/accounts/', { name: 'W Checking', account_type: 'checking', balance: 50000, currency: 'PHP' })
  const presets = await client.get(u.token, '/accounts/minimum-due-presets')
  const wCard = await client.post(u.token, '/accounts/', {
    name: 'W Card', account_type: 'credit', balance: 0, currency: 'PHP', credit_limit: 50000,
    billing_cycle_start: closeDom, days_until_due_date: 21, minimum_due_rule: presets.find((p) => p.key === 'bdo').rule, payment_account_id: checking.id,
  })
  await client.post(u.token, '/transactions/', { account_id: wCard.id, transaction_type: 'debit', amount: 900, description: 'W purchase', transaction_date: wire(addDays(close, -3)), is_posted: true })
  const bill = await entry(u, { name: 'W Bill', amount: 700, account_id: checking.id, next_occurrence: wire(addDays(today, 3)) })
  await client.post(u.token, '/transactions/', { account_id: checking.id, transaction_type: 'debit', amount: 120, description: 'W spend', transaction_date: wire(today), is_posted: true })
  const { ctx, page } = await openPage(browser)
  const gates = []
  try {
    await h.uiLogin(page, stack, u)
    // w1: Card Pay from the account page.
    await openCardPanel(page, wCard.id)
    const credit = await creditGate(page, wCard.id)
    gates.push(credit)
    const w1 = await openerRoundTrip(page, {
      opener: page.locator(tid('card-pay-open')), held: credit, dialog: page.locator(tid('card-pay-dialog')), closeName: 'Cancel',
    })
    await h.check('w1.held', 'S', async () => w1.hit || 'the mount refetch never started')
    await h.check('w1.open-after-escapes', 'B', async () => w1.openAfterEscapes || 'dialog closed by Escape')
    await h.check('w1.focus-opener', 'B', async () => w1.focusOnOpener || `active ${w1.active}`)

    // w2: Mark paid from a Due row.
    await openTransactions(page)
    const row = await showRow(page, dueRecurring(page, 'W Bill'))
    const occurrences = await h.gate(page, (r) => r.method() === 'GET' && new URL(r.url()).pathname.endsWith(`/budget-entries/${bill.id}/occurrences`))
    gates.push(occurrences)
    const w2 = await openerRoundTrip(page, {
      opener: row.locator(tid('due-mark-paid')), held: occurrences, dialog: page.locator(tid('mark-paid-dialog')), closeName: 'Cancel',
    })
    await h.check('w2.held', 'S', async () => w2.hit || 'the occurrences load never started')
    await h.check('w2.open-after-escapes', 'B', async () => w2.openAfterEscapes || 'dialog closed by Escape')
    await h.check('w2.focus-opener', 'B', async () => w2.focusOnOpener || `active ${w2.active}`)

    // w3: the spending breakdown (opened from Transactions).
    const summary = await h.gate(page, (r) => r.method() === 'GET' && new URL(r.url()).pathname.endsWith('/transactions/summary/period'))
    gates.push(summary)
    const w3 = await openerRoundTrip(page, {
      opener: page.getByRole('button', { name: 'Spending breakdown' }), held: summary, dialog: page.locator(tid('spending-breakdown-dialog')), closeName: 'Close',
    })
    await h.check('w3.held', 'S', async () => w3.hit || 'the breakdown load never started')
    await h.check('w3.open-after-escapes', 'B', async () => w3.openAfterEscapes || 'dialog closed by Escape')
    await h.check('w3.focus-opener', 'B', async () => w3.focusOnOpener || `active ${w3.active}`)
  } finally {
    for (const g of gates) g.release({ disarm: true })
    await ctx.close()
  }
}

// ─── Main ────────────────────────────────────────────────────────────────────

// (y) The search passthrough: the focused search box keeps focus and every kind of typing
// while its own load runs, raised above the scrim; the rest of the page stays blocked.
async function scenarioY(browser) {
  console.log('\n=== (y) search passthrough: typing continues in the search box while its load runs')
  const u = await h.makeUser(stack, 'y')
  const acct = await client.post(u.token, '/accounts/', { name: 'Y Checking', account_type: 'checking', balance: 5000, currency: 'PHP' })
  for (const description of ['Yarn abcdefgh shop', 'Yeast abcdefgh bakery', 'Yam stall']) {
    await client.post(u.token, '/transactions/', {
      account_id: acct.id, transaction_type: 'debit', amount: 10, description, transaction_date: wire(today), is_posted: true,
    })
  }
  const { ctx, page, requests } = await openPage(browser, { permissions: ['clipboard-read', 'clipboard-write'] })
  let gate = null
  try {
    await h.uiLogin(page, stack, u)
    await openTransactions(page)
    // The runtime stacking-context walk: no ancestor of the box (to <html>) may form one.
    await h.check('y.no-stacking-context', 'S', async () => {
      await page.evaluate(() => Promise.all(document.getAnimations().map((a) => a.finished.catch(() => null))))
      const found = await page.evaluate((box) => {
        const out = []
        for (let el = document.querySelector(box)?.parentElement; el; el = el.parentElement) {
          const cs = getComputedStyle(el)
          const reasons = []
          if (cs.position !== 'static' && cs.zIndex !== 'auto') reasons.push(`z-index ${cs.zIndex}`)
          if (cs.position === 'fixed' || cs.position === 'sticky') reasons.push(cs.position)
          if (Number(cs.opacity) < 1) reasons.push(`opacity ${cs.opacity}`)
          if (cs.transform !== 'none') reasons.push(`transform ${cs.transform}`)
          if (cs.filter !== 'none') reasons.push('filter')
          if (cs.backdropFilter && cs.backdropFilter !== 'none') reasons.push('backdrop-filter')
          if (cs.isolation === 'isolate') reasons.push('isolation')
          if (cs.mixBlendMode !== 'normal') reasons.push('mix-blend-mode')
          if (/transform|opacity|filter|z-index/.test(cs.willChange)) reasons.push(`will-change ${cs.willChange}`)
          if (/paint|layout|strict|content/.test(cs.contain)) reasons.push(`contain ${cs.contain}`)
          if (reasons.length) out.push(`${el.tagName}.${el.className}: ${reasons.join(', ')}`)
        }
        return out
      }, BOX)
      console.log(`  stacking contexts above the box: ${JSON.stringify(found)}`)
      return found.length === 0 || found.join(' | ')
    })
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
    await h.check('y.visible', 'S', async () => (await visible(page)) || `phase ${await h.overlayPhase(page)}`)
    const boxCentre = await boxOf(search)
    const monthBox = await boxOf(page.locator(PREV_MONTH))
    const label = await monthLabel(page)
    await h.check('y.box-above-scrim', 'B', async () => {
      const r = await page.evaluate(([sel, box, x, y]) => {
        const hit = document.elementFromPoint(x, y)
        return {
          phase: document.querySelector('[data-testid="busy-overlay"]').getAttribute('data-phase'),
          hit: hit?.getAttribute('data-testid') ?? hit?.tagName ?? null,
          bg: getComputedStyle(document.querySelector(box)).backgroundColor,
        }
      }, [SEARCH, BOX, boxCentre.x + boxCentre.width / 2, boxCentre.y + boxCentre.height / 2])
      const m = /rgba?\(([^)]+)\)/.exec(r.bg)
      const parts = m ? m[1].split(',').map((x) => x.trim()) : []
      const alpha = parts.length === 4 ? Number(parts[3]) : parts.length === 3 ? 1 : 0
      return (r.phase === 'visible' && r.hit === 'transactions-search' && alpha === 1) || JSON.stringify(r)
    })
    await h.check('y.month-covered', 'B', async () => {
      const r = await page.evaluate(([sel, x, y]) => {
        const hit = document.elementFromPoint(x, y)
        const button = document.querySelector(sel)
        return { phase: document.querySelector('[data-testid="busy-overlay"]').getAttribute('data-phase'), covered: !!hit && hit !== button && !button.contains(hit), hit: hit?.getAttribute('data-testid') ?? hit?.tagName ?? null }
      }, [PREV_MONTH, monthBox.x + monthBox.width / 2, monthBox.y + monthBox.height / 2])
      return (r.phase === 'visible' && r.covered) || JSON.stringify(r)
    })
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
    const phaseBeforeLast = await h.overlayPhase(page)
    await page.keyboard.press('Tab')
    await step('tab')
    const before = apiRequests(requests)
    await h.clickBox(page, monthBox)
    await step('click-month')
    await h.check('y.visible-before-last-key', 'B', async () => phaseBeforeLast === 'visible' || `phase ${phaseBeforeLast}`)
    await h.check('y.month-click-blocked', 'B', async () => {
      await h.sleep(300)
      const after = await monthLabel(page)
      const sentByClick = apiRequests(requests) - before
      return (after === label && sentByClick === 0) || `label "${label}" -> "${after}", ${sentByClick} requests`
    })
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
    await h.check('y.clears', 'B', async () => (await clears(page)) || `phase ${await h.overlayPhase(page)}`)
    await h.check('y.restored', 'B', async () => {
      const r = await page.evaluate((box) => {
        const el = document.querySelector(box)
        return { z: el?.classList.contains('z-[10051]'), bg: el?.classList.contains('bg-surface'), inert: document.querySelectorAll('[inert]').length }
      }, BOX)
      return (r.z === false && r.bg === false && r.inert === 0) || JSON.stringify(r)
    })
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
  } finally {
    gate?.release({ disarm: true })
    await ctx.close()
  }
  await scenarioY2(browser, { spec: true })
  await scenarioY2(browser, { spec: false })
}

// (y) y2: the page unmounts under a held search (browser Back): removing the focused box
// need not fire focusout, so the passthrough ends on detach and the whole shell blocks.
// Chromium fires blur and focusout on the box as it is removed; the spec's focus fixup
// (and Firefox) fires neither. y2 swallows both before the overlay sees them, so the run
// takes the spec's path [B]; y2c keeps Chromium's own events, a guard [G].
async function scenarioY2(browser, { spec }) {
  const n = spec ? 'y2' : 'y2c'
  const kind = spec ? 'B' : 'G'
  console.log(`\n=== (y) ${n}: browser Back during a held search ends the passthrough (${spec ? 'no focusout on removal' : "Chromium's focusout"})`)
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
    await h.check(`${n}.search-hit`, 'S', async () => (await gate.waitHits(1)) || 'the search request never started')
    await h.check(`${n}.visible`, 'S', async () => (await visible(page)) || `phase ${await h.overlayPhase(page)}`)
    await h.check(`${n}.passthrough-started`, 'S', async () => {
      const r = await page.evaluate((box) => ({
        raised: document.querySelector(box)?.classList.contains('z-[10051]') ?? null,
        active: document.activeElement?.getAttribute('data-testid') ?? null,
      }), BOX)
      return (r.raised === true && r.active === 'transactions-search') || JSON.stringify(r)
    })
    if (spec) {
      await page.evaluate((sel) => {
        const el = document.querySelector(sel)
        for (const type of ['blur', 'focusout']) {
          window.addEventListener(type, (e) => { if (e.target === el) e.stopImmediatePropagation() }, { capture: true })
        }
      }, SEARCH)
    }
    await page.goBack({ timeout: 5000 }).catch(() => null)
    await h.check(`${n}.same-document`, 'S', async () => {
      try { await page.waitForURL((url) => url.pathname === '/', { timeout: 3000 }) } catch { return `url ${page.url()}` }
      const r = await page.evaluate((sel) => ({ marker: window.__y2Marker ?? null, box: document.querySelector(sel) !== null }), SEARCH)
      return (r.marker === 1 && r.box === false) || JSON.stringify(r)
    })
    await h.sleep(300)
    await h.check(`${n}.passthrough-ended`, kind, async () => {
      const r = await page.evaluate((overlay) => ({
        raised: document.querySelectorAll('[class~="z-[10051]"]').length,
        layerHidden: document.querySelector(overlay)?.getAttribute('aria-hidden') ?? null,
        phase: document.querySelector(overlay)?.getAttribute('data-phase') ?? null,
        shellInert: document.querySelector('[data-app-shell]')?.hasAttribute('inert') ?? null,
      }), OVERLAY)
      return (r.raised === 0 && r.layerHidden === null && r.phase === 'visible' && r.shellInert === true) || JSON.stringify(r)
    })
    await h.check(`${n}.focus-in-overlay`, kind, async () => {
      const r = await page.evaluate(() => ({
        inHost: document.querySelector('[data-busy-host]')?.contains(document.activeElement) ?? false,
        active: document.activeElement?.getAttribute('data-testid') ?? document.activeElement?.tagName ?? null,
      }))
      return r.inHost || JSON.stringify(r)
    })
    gate.release({ disarm: true })
    await h.check(`${n}.clears`, kind, async () => (await clears(page)) || `phase ${await h.overlayPhase(page)}`)
    await h.check(`${n}.no-inert`, kind, async () => (await inertCount(page)) === 0 || `inert ${await inertCount(page)}`)
    await h.check(`${n}.next-page-usable`, kind, async () => {
      await h.waitQuiet(page)
      await navLink(page, '/transactions').click()
      try { await page.waitForURL((url) => url.pathname === '/transactions', { timeout: 3000 }) } catch { return `url ${page.url()}` }
      await search.waitFor({ timeout: 5000 }).catch(() => null)
      await h.waitQuiet(page)
      await search.click()
      await search.pressSequentially('zq')
      return (await search.inputValue()) === 'zq' || `value "${await search.inputValue()}"`
    })
  } finally {
    gate?.release({ disarm: true })
    await ctx.close()
  }
}

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
  ['h', scenarioH],
  ['i', scenarioI],
  ['o', scenarioO],
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
