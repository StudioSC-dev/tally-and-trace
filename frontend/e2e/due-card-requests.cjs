// Browser checks for STU-603 (PERF-8): the Transactions page's Due card reads
// `GET /dashboard/due`, refetches by its own `Due` tag, and falls back to the older queries
// when the API has no such route.
//   (a) AC3 opening Transactions: the card sends three reads (/dashboard/due, the upcoming transactions,
//       the installment plans) and the page at most 8 in all (11 before); none of them is the dashboard
//       snapshot, a linked-ids read or an upcoming-occurrences read.
//   (b) AC2 one save from Transactions (the outbox drains once): at most 4 API requests after
//       it, none of them the snapshot, a linked-ids read or an upcoming-occurrences read.
//   (c) AC4 day rollover: with the page clock crossing Manila midnight the Due card reads "…"
//       and then the new day's data, without navigation.
//   (c2) an answer still dated the old day keeps Upcoming at "…" (the card shows a day's data only for that day).
//   (c3) an answer dated another day than the page decides nothing: no Due row, no page-open POST.
//   (d) AC5 fallback: with `/dashboard/due` answered 404 the card renders the rows it rendered
//       from `/due`, from the older queries.
//   (e) the stale-data guard (STU-603 comment): while the Due data refetches, Post on a pending
//       row is disabled: with `/dashboard/due` held, and (older API) with the window query held.
//   (f) a Due-card save invalidates `Due`: after Mark paid drains, `/dashboard/due` is read again
//       and the paid row has left; a Transactions save leaves Accounts and Allocations alone.
//   (f1, f2) Post now and every Upcoming or Subscriptions occurrence button are disabled while their source refetches.
//   (g) the toast stack does not cover the Due card's last rows (STU-605 QA note).
//   (h) a Transactions save leaves no stale figure: after one, the account page shows the new balance and the
//       dashboard envelope the new amount on the next visit, though both were cached before it.
//
// Starts its own API and web app against a throwaway database (./_local_stack.cjs) and seeds
// through the API. Not wired into CI. Run steps: ./README.md. Condition waits only.
//
// Usage: node frontend/e2e/due-card-requests.cjs [scenario]
const { startLocalStack } = require('./_local_stack.cjs')
const h = require('./_smooth.cjs')
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
let stack, client

const manilaToday = () => new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10)
const addDays = (day, n) => {
  const d = new Date(`${day}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().slice(0, 10)
}
const wire = (day) => `${day}T00:00:00`
const tid = (id) => `[data-testid="${id}"]`
const pathOf = (url) => new URL(url).pathname.replace(/^.*\/api\/v1/, '').replace(/\/$/, '')
const label = (url) => `${pathOf(url)}${new URL(url).search}`

const isSnapshot = (url) => pathOf(url) === '/dashboard/snapshot'
const isDue = (url) => pathOf(url) === '/dashboard/due'
const isLinkedIds = (url) => pathOf(url) === '/transactions' && new URL(url).searchParams.has('ids')
const isOccurrences = (url) => pathOf(url) === '/budget-entries/upcoming-occurrences'
const isUnpostedWindow = (url) =>
  pathOf(url) === '/transactions' && new URL(url).searchParams.get('is_posted') === 'false' && new URL(url).searchParams.has('end_date')
const isCreate = (r) => r.method() === 'POST' && pathOf(r.url()) === '/transactions'

/** Every API request (not only GETs) the page sends while `run` goes on: ['METHOD /path?query']. */
async function record(page, run) {
  const seen = []
  const onRequest = (request) => {
    if (request.url().includes('/api/v1/')) seen.push({ method: request.method(), url: request.url() })
  }
  page.on('request', onRequest)
  try {
    await run()
    await h.waitQuiet(page)
    await h.sleep(300)
    await h.waitQuiet(page)
  } finally {
    page.off('request', onRequest)
  }
  return seen
}
const show = (seen) => seen.map((r) => `${r.method} ${label(r.url)}`).join(' | ')

async function seedUser(tag) {
  const user = await h.makeUser(stack, tag)
  const checking = await client.post(user.token, '/accounts/', { name: `${tag} Checking`, account_type: 'checking', balance: 50000, currency: 'PHP' })
  const today = manilaToday()
  // A missed monthly cash expense, an overdue pending row, a recurring entry still to come.
  const rent = await client.post(user.token, '/budget-entries/', {
    entry_type: 'expense', currency: 'PHP', cadence: 'monthly', name: `${tag} Rent`, amount: 900,
    account_id: checking.id, next_occurrence: wire(addDays(today, -35)),
  })
  const pending = await client.post(user.token, '/transactions/', {
    account_id: checking.id, transaction_type: 'debit', amount: 77, description: `${tag} Pending bill`,
    transaction_date: wire(addDays(today, -3)), is_posted: false,
  })
  await client.post(user.token, '/transactions/', {
    account_id: checking.id, transaction_type: 'debit', amount: 12, description: `${tag} Posted lunch`,
    transaction_date: wire(today), is_posted: true,
  })
  return { user, checking, rent, pending, tag }
}

/** A signed-in page on the dashboard (so the page open to measure starts from a loaded app). */
async function signedIn(browser, user, contextOptions = {}) {
  const { ctx, page } = await h.newPage(browser, { timezoneId: 'Asia/Manila', ...contextOptions })
  page.setDefaultTimeout(10000)
  await h.uiLogin(page, stack, user)
  return { ctx, page }
}

const dueCard = (page) => page.locator(tid('due-and-overdue'))

async function openTransactions(page) {
  await page.goto(`${stack.webUrl}/transactions`)
  await page.getByRole('button', { name: 'Add Transaction' }).first().waitFor()
}

const formOf = (page) => page.locator('form').filter({ has: page.getByRole('button', { name: /^(Create|Update) Transaction$/ }) })
const dueRows = (page) => page.locator(tid('due-row'))

/** Fills the Create dialog with an expense; returns the form. */
async function fillCreate(page, { accountName, amount, description }) {
  await page.getByRole('button', { name: 'Add Transaction' }).first().click()
  const form = formOf(page)
  await form.waitFor()
  await form.locator('input[placeholder="Add notes about this transaction"]').fill(description)
  await pick(form.locator('[data-field="account_id"]'), accountName)
  await form.getByRole('button', { name: 'Expense', exact: true }).click()
  await form.locator('input[type="number"][placeholder="0.00"]').first().fill(String(amount))
  return form
}

/** Clicks Create and waits for the "Saved" toast: the outbox drained. */
async function submitAndWaitSaved(page, form) {
  await form.getByRole('button', { name: 'Create Transaction', exact: true }).click()
  await page.locator(`${tid('save-toast')}[data-state="saved"]`).first().waitFor({ timeout: 15000 })
}

const REMOVED = [
  ['the dashboard snapshot', isSnapshot],
  ['a linked-ids read', isLinkedIds],
  ['an upcoming-occurrences read', isOccurrences],
]

// (a) AC3
async function scenarioA(browser) {
  console.log('\n(a) opening Transactions fires at most 6 API requests')
  const seeded = await seedUser('dra')
  const { ctx, page } = await signedIn(browser, seeded.user)
  try {
    const seen = await record(page, () => openTransactions(page))
    console.log(`  ${seen.length} requests: ${show(seen)}`)
    await h.check('a.rows-shown', 'S', async () => {
      await dueRows(page).first().waitFor({ timeout: 10000 })
      return true
    })
    // The card's own reads: /dashboard/due, the upcoming transactions and the installment plans. The page's
    // other reads (the session, accounts, categories, recurring entries, the main list) are not the card's.
    const card = seen.filter((r) => isDue(r.url) || pathOf(r.url) === '/budget-entries/installment-plans' ||
      (pathOf(r.url) === '/transactions' && new URL(r.url.toString()).searchParams.get('order') === 'asc'))
    await h.check('a.card-sends-three', 'B', async () => card.length === 3 || `the card sent ${card.length}: ${show(card)}`)
    // Before: 11 (the snapshot, the unposted window, upcoming transactions, two occurrence reads, plans, plus the page's 5).
    await h.check('a.at-most-8', 'B', async () => seen.length <= 8 || `${seen.length} requests`)
    for (const [name, is] of REMOVED) {
      await h.check(`a.no-${name.replace(/ /g, '-')}`, 'B', async () => !seen.some((r) => is(r.url)) || `${name} was sent`)
    }
  } finally {
    await ctx.close()
  }
}

// (b) AC2
async function scenarioB(browser) {
  console.log('\n(b) one save from Transactions: at most 4 API requests after it')
  const seeded = await seedUser('drb')
  const { ctx, page } = await signedIn(browser, seeded.user)
  try {
    await openTransactions(page)
    await dueRows(page).first().waitFor()
    await h.waitQuiet(page)
    const form = await fillCreate(page, { accountName: seeded.checking.name, amount: 321, description: 'DR B Coffee' })
    await h.waitQuiet(page)
    const seen = await record(page, () => submitAndWaitSaved(page, form))
    console.log(`  ${seen.length} requests: ${show(seen)}`)
    const after = seen.filter((r) => r.method === 'GET')
    await h.check('b.saved-once', 'S', async () => seen.filter((r) => r.method === 'POST').length === 1 || 'not one POST')
    await h.check('b.at-most-4', 'B', async () => after.length <= 4 || `${after.length} requests after the save`)
    await h.check('b.due-refetched-by-its-tag', 'B', async () => seen.some((r) => isDue(r.url)) || 'a save did not refetch /dashboard/due')
    await h.check('b.accounts-and-allocations-left-alone', 'B', async () => {
      const hit = seen.filter((r) => ['/accounts', '/allocations'].includes(pathOf(r.url)))
      return hit.length === 0 || `a transaction save refetched ${show(hit)}`
    })
    for (const [name, is] of REMOVED) {
      await h.check(`b.no-${name.replace(/ /g, '-')}`, 'B', async () => !seen.some((r) => is(r.url)) || `${name} was sent`)
    }
  } finally {
    await ctx.close()
  }
}


const getOf = (is) => (r) => r.method() === 'GET' && is(r.url())

/** The visible text of every row on the Due tab's current page, whitespace folded. */
async function dueRowTexts(page) {
  return (await dueRows(page).allTextContents()).map((t) => t.replace(/\s+/g, ' ').trim())
}

/** Every tab's row texts (first page), by slug. */
async function tabRows(page) {
  const out = {}
  for (const slug of ['due', 'not-posted', 'upcoming', 'subscriptions', 'installments']) {
    await page.locator(tid(`due-tab-${slug}`)).click()
    await page.locator(`${tid(`due-panel-${slug}`)}:not([hidden])`).waitFor()
    await h.waitQuiet(page)
    out[slug] = await dueRowTexts(page)
  }
  await page.locator(tid('due-tab-due')).click()
  return out
}

/** The five tab badges, as shown. */
async function badges(page) {
  const out = {}
  for (const id of ['due-count', 'due-not-posted-count', 'due-upcoming-count', 'due-subscriptions-count', 'due-installments-count']) {
    out[id] = ((await page.locator(tid(id)).textContent({ timeout: 3000 }).catch(() => null)) || '').trim()
  }
  return out
}

async function settledBadges(page) {
  await h.waitQuiet(page)
  for (let i = 0; i < 40; i++) {
    const b = await badges(page)
    if (!Object.values(b).includes('…') && !Object.values(b).includes('')) return b
    await h.sleep(250)
  }
  return badges(page)
}

/** One user with everything the card lists: a missed entry, an overdue pending row, upcoming and subscription entries. */
async function seedFull(tag) {
  const seeded = await seedUser(tag)
  const today = manilaToday()
  const { user, checking } = seeded
  await client.post(user.token, '/budget-entries/', {
    entry_type: 'expense', currency: 'PHP', cadence: 'monthly', name: `${tag} Upcoming bill`, amount: 800,
    account_id: checking.id, next_occurrence: wire(addDays(today, 3)),
  })
  await client.post(user.token, '/budget-entries/', {
    entry_type: 'expense', currency: 'PHP', cadence: 'monthly', name: `${tag} Streaming`, amount: 549, plan_kind: 'subscription',
    account_id: checking.id, next_occurrence: wire(addDays(today, 5)),
  })
  await client.post(user.token, '/transactions/', {
    account_id: checking.id, transaction_type: 'debit', amount: 60, description: `${tag} Planned`,
    transaction_date: wire(addDays(today, 2)), is_posted: false,
  })
  return seeded
}

// (c) AC4
async function scenarioC(browser) {
  console.log('\n(c) day rollover: the Upcoming figure reads "…" and then the new day, with no navigation')
  const seeded = await seedFull('drc')
  const day = manilaToday()
  const next = addDays(day, 1)
  const { ctx, page } = await signedIn(browser, seeded.user, {})
  let held
  try {
    // The backend clock is real: the browser sits two minutes before Manila midnight of the real
    // day, and the held /due answer says it is the next day, as a server past midnight would.
    await page.clock.install({ time: new Date(`${day}T15:58:00Z`) })
    await openTransactions(page)
    await page.evaluate(() => { window.__noNavigation = true })
    await h.check('c.upcoming-settled', 'S', async () => {
      await page.locator(tid('due-upcoming-count')).filter({ hasNotText: '…' }).waitFor({ timeout: 10000 })
      return true
    })
    await h.waitQuiet(page)
    const before = await badges(page)
    const rowsBefore = await dueRows(page).count()
    await h.check('c.due-rows-before', 'S', async () => rowsBefore > 0 || 'the Due tab lists no row before midnight')
    held = await h.holdResponse(page, getOf(isDue), { transform: (json) => ({ ...json, today: next }) })
    await h.rewrite(page, getOf((u) => pathOf(u) === '/budget-entries/installment-plans'), (json) => ({ ...json, today: next }))
    await page.clock.fastForward('03:00')
    await h.check('c.crossed', 'S', async () => (await h.localDay(page)) === next || 'the page day did not turn')
    await h.check('c.new-day-request', 'S', async () => (await held.waitHits(1, 5000)) || 'the card sent no /dashboard/due request after midnight')
    await h.check('c.upcoming-reads-pending', 'B', async () => {
      const shown = ((await page.locator(tid('due-upcoming-count')).textContent()) || '').trim()
      return shown === '…' || `Upcoming read "${shown}" while the new day's data was held`
    })
    // The old day's answer is still cached, and none of it is shown for the new day: no Due row, the Due badge pending.
    await h.check('c.due-rows-hidden', 'B', async () => {
      const n = await dueRows(page).count()
      return n === 0 || `${n} Due row(s) from the previous day shown while the new day's data was held`
    })
    await h.check('c.due-badge-pending', 'B', async () => {
      const shown = ((await page.locator(tid('due-count')).textContent()) || '').trim()
      return shown === '…' || `the Due badge read "${shown}" while the new day's data was held`
    })
    held.release({ disarm: true })
    await page.locator(tid('due-upcoming-count')).filter({ hasNotText: '…' }).waitFor({ timeout: 10000 })
    await h.waitQuiet(page)
    await h.check('c.due-rows-back', 'B', async () => (await dueRows(page).count()) > 0 || 'the Due rows did not come back')
    const after = await badges(page)
    await h.check('c.new-day-data', 'B', async () =>
      after['due-upcoming-count'] === before['due-upcoming-count'] && !Object.values(after).includes('…') ||
      `before ${JSON.stringify(before)} after ${JSON.stringify(after)}`)
    await h.check('c.no-navigation', 'B', async () => (await page.evaluate(() => window.__noNavigation === true)) || 'the page reloaded')
  } finally {
    held?.release({ disarm: true })
    await ctx.close()
  }
}

// (c2) AC4: an answer dated the old day is never shown as the new day's
async function scenarioC2(browser) {
  console.log('\n(c2) the page day turns and /dashboard/due still says the old day: Upcoming stays "…", never the old day\'s count')
  const seeded = await seedFull('drc2')
  const day = manilaToday()
  const { ctx, page } = await signedIn(browser, seeded.user, {})
  try {
    await page.clock.install({ time: new Date(`${day}T15:58:00Z`) })
    await openTransactions(page)
    await page.locator(tid('due-upcoming-count')).filter({ hasNotText: '…' }).waitFor({ timeout: 10000 })
    await h.waitQuiet(page)
    const seen = await record(page, async () => {
      await page.clock.fastForward('03:00')
      await h.check('c2.crossed', 'S', async () => (await h.localDay(page)) === addDays(day, 1) || 'the page day did not turn')
    })
    await h.check('c2.due-read-again', 'S', async () => seen.some((r) => isDue(r.url)) || `no /dashboard/due request after midnight: ${show(seen)}`)
    await h.sleep(500)
    await h.check('c2.upcoming-stays-pending', 'B', async () => {
      const shown = ((await page.locator(tid('due-upcoming-count')).textContent()) || '').trim()
      return shown === '…' || `Upcoming read "${shown}" from an answer dated the old day`
    })
    await h.check('c2.no-empty-text', 'B', async () => (await page.locator(tid('due-upcoming-empty')).count()) === 0 || 'an empty text is shown')
  } finally {
    await ctx.close()
  }
}

// (c3) an answer dated another day decides nothing: no row, and no page-open POST
async function scenarioC3(browser) {
  console.log('\n(c3) /dashboard/due dated another day than the page: no Due row, no page-open POST')
  const user = await h.makeUser(stack, 'drc3')
  const today = manilaToday()
  const day = today.slice(8, 10)
  const bank = await client.post(user.token, '/accounts/', { name: 'drc3 Checking', account_type: 'checking', balance: 100000, currency: 'PHP' })
  const card = await client.post(user.token, '/accounts/', {
    name: 'drc3 Visa', account_type: 'credit', balance: 0, currency: 'PHP', credit_limit: 100000,
    billing_cycle_start: Math.min(28, Number(day)), days_until_due_date: 21, payment_account_id: bank.id,
  })
  await client.post(user.token, '/budget-entries/', {
    entry_type: 'expense', currency: 'PHP', cadence: 'monthly', name: 'drc3 Lamp', amount: 1200,
    account_id: card.id, next_occurrence: wire(today), end_mode: 'after_occurrences', max_occurrences: 6,
  })
  await client.post(user.token, '/transactions/', {
    account_id: bank.id, transaction_type: 'debit', amount: 40, description: 'drc3 Pending',
    transaction_date: wire(addDays(today, -2)), is_posted: false,
  })
  const isPageOpenPost = (r) => r.method() === 'POST' && pathOf(r.url()) === '/budget-entries/post-due-installments'
  // Control: on the real day the page-open POST is sent and the rows show.
  const control = await signedIn(browser, user)
  let posts = 0
  try {
    control.page.on('request', (r) => { if (isPageOpenPost(r)) posts++ })
    await openTransactions(control.page)
    await control.page.locator(tid('due-not-posted-count')).filter({ hasText: /^1$/ }).waitFor({ timeout: 10000 })
    await h.waitQuiet(control.page)
    await h.check('c3.control-posts-on-open', 'S', async () => posts === 1 || `the control sent ${posts} page-open POSTs`)
  } finally {
    await control.ctx.close()
  }
  // The page's clock is a day behind the API's: every /due answer is dated the day after the page's.
  const { ctx, page } = await signedIn(browser, user, {})
  try {
    await page.clock.install({ time: new Date(`${addDays(today, -1)}T06:00:00Z`) })
    let stalePosts = 0
    page.on('request', (r) => { if (isPageOpenPost(r)) stalePosts++ })
    const seen = await record(page, async () => {
      await page.goto(`${stack.webUrl}/transactions`)
      await page.getByRole('button', { name: 'Add Transaction' }).first().waitFor()
      await h.sleep(1500)
    })
    await h.check('c3.due-read', 'S', async () => seen.some((r) => isDue(r.url)) || `no /dashboard/due request: ${show(seen)}`)
    await h.check('c3.no-page-open-post', 'B', async () => stalePosts === 0 || `${stalePosts} page-open POST(s) decided from an answer dated another day`)
    await h.check('c3.no-rows-and-badge-pending', 'B', async () => {
      const badge = ((await page.locator(tid('due-not-posted-count')).textContent()) || '').trim()
      await page.locator(tid('due-tab-not-posted')).click()
      const n = await dueRows(page).count()
      return (n === 0 && badge === '…') || `${n} row(s) shown and the Not posted yet badge read "${badge}" for an answer dated another day`
    })
  } finally {
    await ctx.close()
  }
}

// (d) AC5
async function scenarioD(browser) {
  console.log('\n(d) /dashboard/due answered 404: the card renders the rows it rendered from /due')
  const seeded = await seedFull('drd')
  const first = await signedIn(browser, seeded.user)
  let reference
  try {
    await openTransactions(first.page)
    await dueRows(first.page).first().waitFor()
    reference = { badges: await settledBadges(first.page), rows: await tabRows(first.page) }
  } finally {
    await first.ctx.close()
  }
  const { ctx, page } = await signedIn(browser, seeded.user)
  try {
    const failed = await h.failWith(page, getOf(isDue), 404)
    const seen = await record(page, async () => {
      await openTransactions(page)
      await dueRows(page).first().waitFor()
    })
    console.log(`  ${seen.length} requests: ${show(seen)}`)
    const shown = { badges: await settledBadges(page), rows: await tabRows(page) }
    await h.check('d.due-answered-404', 'S', async () => failed.failed >= 1 || 'the 404 was never served')
    await h.check('d.older-queries-read', 'S', async () =>
      (seen.some((r) => isSnapshot(r.url)) && seen.some((r) => isOccurrences(r.url)) && seen.some((r) => isUnpostedWindow(r.url))) ||
      `the fallback did not read the older queries: ${show(seen)}`)
    await h.check('d.no-error-shown', 'B', async () => (await page.getByText('Could not load what is due.').count()) === 0 || 'the card shows its load error')
    await h.check('d.same-rows', 'B', async () => JSON.stringify(shown.rows) === JSON.stringify(reference.rows) || `fallback ${JSON.stringify(shown.rows)} vs /due ${JSON.stringify(reference.rows)}`)
    await h.check('d.same-badges', 'B', async () => JSON.stringify(shown.badges) === JSON.stringify(reference.badges) || `fallback ${JSON.stringify(shown.badges)} vs /due ${JSON.stringify(reference.badges)}`)
    await h.check('d.rows-not-empty', 'S', async () => Object.values(reference.rows).flat().length >= 5 || `only ${JSON.stringify(reference.rows)}`)
  } finally {
    await ctx.close()
  }
}

// (e) the stale-data guard
async function scenarioE(browser, { fallback }) {
  const name = fallback ? 'e2' : 'e1'
  console.log(`\n(${name}) Post on a pending row is disabled while the row source refetches${fallback ? ' (older API: the window query)' : ' (/dashboard/due)'}`)
  const seeded = await seedFull(`dr${name}`)
  const { ctx, page } = await signedIn(browser, seeded.user)
  let g
  try {
    if (fallback) await h.failWith(page, getOf(isDue), 404)
    await openTransactions(page)
    await page.locator(tid('due-tab-not-posted')).click()
    const post = page.locator(tid('due-mark-posted')).first()
    await post.waitFor()
    await h.waitQuiet(page)
    await h.check(`${name}.enabled-when-settled`, 'S', async () => (await post.isEnabled()) || 'Post is disabled with nothing refetching')
    // The row source is held; a save elsewhere on the page invalidates it.
    g = await h.gate(page, getOf(fallback ? isUnpostedWindow : isDue))
    const form = await fillCreate(page, { accountName: seeded.checking.name, amount: 15, description: `DR ${name} Snack` })
    await form.getByRole('button', { name: 'Create Transaction', exact: true }).click()
    await h.check(`${name}.refetch-held`, 'S', async () => (await g.waitHits(1, 10000)) || 'the save sent no refetch of the row source')
    await h.sleep(500)
    await h.check(`${name}.post-disabled`, 'B', async () => (await post.isDisabled()) || 'Post is enabled while the row source refetches')
    g.release({ disarm: true })
    await h.waitQuiet(page)
    await h.check(`${name}.post-enabled-again`, 'B', async () => {
      await post.waitFor()
      return (await post.isEnabled()) || 'Post stays disabled after the refetch landed'
    })
  } finally {
    g?.release({ disarm: true })
    await ctx.close()
  }
}

// (f) the stale-data guard reaches Post now and the occurrence rows
async function scenarioF(browser, { fallback }) {
  const name = fallback ? 'f2' : 'f1'
  console.log(`\n(${name}) Post now and the occurrence actions are disabled while their source refetches${fallback ? ' (older API: the occurrence query)' : ' (/dashboard/due)'}`)
  const seeded = await seedFull(`dr${name}`)
  const { user } = seeded
  const today = manilaToday()
  const bank = await client.post(user.token, '/accounts/', { name: `${name} Pay`, account_type: 'checking', balance: 100000, currency: 'PHP' })
  const card = await client.post(user.token, '/accounts/', {
    name: `${name} Visa`, account_type: 'credit', balance: 0, currency: 'PHP', credit_limit: 100000,
    billing_cycle_start: Math.min(28, Number(today.slice(8, 10))), days_until_due_date: 21, payment_account_id: bank.id,
  })
  await client.post(user.token, '/budget-entries/', {
    entry_type: 'expense', currency: 'PHP', cadence: 'monthly', name: `${name} Lamp`, amount: 1200,
    account_id: card.id, next_occurrence: wire(today), end_mode: 'after_occurrences', max_occurrences: 6,
  })
  // Opening Transactions would post the month at once; a viewer-day trick is not needed: hold the POST so Post now stays.
  const { ctx, page } = await signedIn(browser, user)
  let g, post
  try {
    if (fallback) await h.failWith(page, getOf(isDue), 404)
    post = await h.gate(page, (r) => r.method() === 'POST' && pathOf(r.url()) === '/budget-entries/post-due-installments')
    await openTransactions(page)
    await h.waitQuiet(page)
    const postNow = page.locator(tid('due-post-now'))
    await postNow.waitFor({ timeout: 10000 })
    const occurrenceButtons = page.locator(`${tid('due-panel-upcoming')} [data-testid="upcoming-occurrence"] button`)
    const occurrenceStates = async () => {
      await page.locator(tid('due-tab-upcoming')).click()
      await occurrenceButtons.first().waitFor({ timeout: 10000 })
      return occurrenceButtons.evaluateAll((els) => els.map((el) => el.disabled))
    }
    await h.check(`${name}.enabled-when-settled`, 'S', async () => {
      const postEnabled = await postNow.isEnabled()
      const states = await occurrenceStates()
      await page.locator(tid('due-tab-due')).click()
      return (postEnabled && states.length > 0 && states.every((d) => !d)) || `Post now enabled ${postEnabled}, occurrence buttons disabled ${JSON.stringify(states)}`
    })
    // The sources are held; a save elsewhere on the page invalidates them.
    g = await h.gate(page, getOf(fallback ? isOccurrences : isDue))
    const form = await fillCreate(page, { accountName: seeded.checking.name, amount: 15, description: `DR ${name} Snack` })
    await form.getByRole('button', { name: 'Create Transaction', exact: true }).click()
    await h.check(`${name}.refetch-held`, 'S', async () => (await g.waitHits(1, 10000)) || 'the save sent no refetch of the source')
    await h.sleep(500)
    if (!fallback) await h.check(`${name}.post-now-disabled`, 'B', async () => (await postNow.isDisabled()) || 'Post now is enabled while /dashboard/due refetches')
    await h.check(`${name}.occurrence-actions-disabled`, 'B', async () => {
      const states = await occurrenceStates()
      return (states.length > 0 && states.every(Boolean)) || `occurrence buttons disabled: ${JSON.stringify(states)}`
    })
    g.release({ disarm: true })
    await h.waitQuiet(page)
    await h.check(`${name}.enabled-again`, 'B', async () =>
      (await occurrenceStates()).every((d) => !d) || 'an occurrence button stays disabled after the refetch landed')
  } finally {
    g?.release({ disarm: true })
    post?.release({ disarm: true })
    await ctx.close()
  }
}

// (g) STU-605 QA note: the toast stack must not cover the Due card's rows at the end of the page.
async function scenarioG(browser) {
  console.log('\n(g) with toasts showing and the page scrolled to its end, no Due row button sits under the stack')
  const seeded = await seedFull('drg')
  for (const width of [1280, 390]) {
    const { ctx, page } = await signedIn(browser, seeded.user, { viewport: { width, height: 900 } })
    let g
    try {
      await openTransactions(page)
      await dueRows(page).first().waitFor()
      await h.waitQuiet(page)
      g = await h.gate(page, isCreate)
      for (const n of [1, 2, 3]) {
        const form = await fillCreate(page, { accountName: seeded.checking.name, amount: 10 + n, description: `DR G ${width} ${n}` })
        // The pending toasts of the earlier saves may sit over the button at a narrow width: dispatch the click.
        await form.getByRole('button', { name: 'Create Transaction', exact: true }).dispatchEvent('click')
        await form.waitFor({ state: 'hidden' })
      }
      await page.locator(tid('toast-stack')).waitFor()
      for (const slug of ['due', 'not-posted', 'upcoming', 'subscriptions']) {
        await page.locator(tid(`due-tab-${slug}`)).click()
        await h.sleep(150)
        const covered = await page.evaluate(() => {
          window.scrollTo(0, document.documentElement.scrollHeight)
          const stack = document.querySelector('[data-testid="toast-stack"]').getBoundingClientRect()
          const hit = []
          for (const row of document.querySelectorAll('[data-testid="due-row"]')) {
            for (const el of row.querySelectorAll('button, a')) {
              const r = el.getBoundingClientRect()
              if (r.width === 0 || r.height === 0) continue
              const overlap = r.left < stack.right && r.right > stack.left && r.top < stack.bottom && r.bottom > stack.top
              if (overlap) hit.push((el.textContent || '').trim().slice(0, 20))
            }
          }
          return hit
        })
        await h.check(`g.${width}.${slug}-clear-of-toasts`, 'B', async () => covered.length === 0 || `covered at the page end: ${covered.join(', ')}`)
      }
    } finally {
      g?.release({ disarm: true })
      await ctx.close()
    }
  }
}

// (h) a Transactions save leaves no stale balance or budget amount behind
const money = (n) => Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const goTo = async (page, nav, path) => {
  await page.locator(`a[data-onboarding="${nav}"]:visible`).first().click()
  await page.waitForURL((url) => url.pathname === path)
  await h.waitQuiet(page)
}

async function scenarioH(browser) {
  console.log('\n(h) after a save on Transactions, the account page and the dashboard envelope show the new figures right away')
  const seeded = await seedUser('drh')
  const { user, checking } = seeded
  const category = await client.post(user.token, '/categories/', { name: 'DRH Food', color: '#16a34a', is_expense: true })
  const budget = await client.post(user.token, '/allocations/', {
    account_id: checking.id, name: 'DRH Groceries', allocation_type: 'budget', target_amount: 9000, period_frequency: 'monthly',
    configuration: { category_ids: [category.id] },
  })
  const { ctx, page } = await signedIn(browser, user)
  try {
    const balanceOf = async () => (await client.get(user.token, `/accounts/${checking.id}`)).balance
    const usedOf = async () => (await client.get(user.token, `/allocations/${budget.id}`)).current_amount
    const detailBalance = async () => (await page.locator(tid('account-detail-balance')).innerText()).replace(/\s+/g, ' ')
    const envelopes = async () => (await page.locator('[data-onboarding="budget-envelopes"]').innerText()).replace(/\s+/g, ' ')
    const openDetail = async () => {
      await goTo(page, 'nav-accounts', '/accounts')
      await page.locator(`a[href="/accounts/${checking.id}"]`).first().click()
      await page.locator(tid('account-detail-balance')).waitFor()
      await h.waitQuiet(page)
    }
    // Both pages are read first, so their data is cached when the save happens (the dashboard is where the
    // user starts; the account page and the envelope read through the shared cache, not a fresh request on mount).
    const balanceBefore = await balanceOf()
    await openDetail()
    await h.check('h.detail-shows-old-balance', 'S', async () => (await detailBalance()).includes(money(balanceBefore)) || `the page reads ${await detailBalance()}`)
    await goTo(page, 'nav-home', '/')
    await h.check('h.envelope-listed', 'S', async () => (await envelopes()).includes('DRH Groceries') || 'the envelope is not listed')
    await goTo(page, 'nav-transactions', '/transactions')
    await dueRows(page).first().waitFor()
    const form = await fillCreate(page, { accountName: checking.name, amount: 321, description: 'DR H Groceries run' })
    await pick(form.locator('[data-field="category_id"]'), 'DRH Food')
    await submitAndWaitSaved(page, form)
    const balanceAfter = await balanceOf()
    const usedAfter = await usedOf()
    await h.check('h.api-moved', 'S', async () => (balanceAfter !== balanceBefore && usedAfter === 321) || `balance ${balanceBefore} -> ${balanceAfter}, budget used ${usedAfter}`)
    await openDetail()
    await h.check('h.detail-shows-new-balance', 'B', async () => {
      const text = await detailBalance()
      return text.includes(money(balanceAfter)) || `the page reads ${text}, the API says ${money(balanceAfter)}`
    })
    await goTo(page, 'nav-home', '/')
    await h.check('h.envelope-shows-new-amount', 'B', async () => {
      const text = await envelopes()
      return text.includes(money(usedAfter)) || `the envelope reads ${text}, the API says ${money(usedAfter)}`
    })
  } finally {
    await ctx.close()
  }
}

const SCENARIOS = [
  ['a', scenarioA],
  ['b', scenarioB],
  ['c', scenarioC],
  ['c2', scenarioC2],
  ['c3', scenarioC3],
  ['d', scenarioD],
  ['e', (b) => scenarioE(b, { fallback: false })],
  ['e2', (b) => scenarioE(b, { fallback: true })],
  ['f1', (b) => scenarioF(b, { fallback: false })],
  ['f2', (b) => scenarioF(b, { fallback: true })],
  ['g', scenarioG],
  ['h', scenarioH],
]

;(async () => {
  process.on('unhandledRejection', (e) => console.log(`  NOTE unhandled rejection: ${e && e.message ? e.message.split('\n')[0] : e}`))
  stack = await startLocalStack()
  client = h.apiClient(stack)
  stack.psql('UPDATE fx_rates SET fetched_at = now()')
  const browser = await chromium.launch()
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
