// Browser check for STU-602 (PERF-7, AC2): opening the Transactions page a second time,
// with no write in between, is answered with 304 Not Modified on every opted-in API
// request. The browser's HTTP cache sends If-None-Match by itself; the web app has no
// code for it. Starts its own API and web app against a throwaway database
// (./_local_stack.cjs) and seeds through the API. Not wired into CI and not part of
// `pnpm build`. Run steps: see ./README.md.
//
// No page.route() here: request interception turns Chromium's HTTP cache off.
//
// Check kinds: [B] behavioural, [S] structural (a failed one makes the run invalid).
// The script ends with RESULT: k/m and exits 0 only when every check passed, 1 when any
// failed, 2 for setup.
//
// Usage: node frontend/e2e/etag-revalidate.cjs
const { startLocalStack } = require('./_local_stack.cjs')
const h = require('./_smooth.cjs')

const playwrightPath = process.env.PLAYWRIGHT_PATH || 'playwright'
let chromium
try {
  ;({ chromium } = require(playwrightPath))
} catch {
  console.error(`Cannot load Playwright from "${playwrightPath}". Set PLAYWRIGHT_PATH (see frontend/e2e/README.md).`)
  process.exit(2)
}

// The GETs that carry an ETag (backend app/core/conditional.py), by path under /api/v1.
const OPTED_IN = [
  /\/dashboard\/snapshot$/,
  /\/budget-entries\/installment-plans$/,
  /\/budget-entries\/upcoming-occurrences$/,
  /\/budget-entries\/$/,
  /\/transactions\/$/,
  /\/accounts\/$/,
  /\/categories\/$/,
]

const optedIn = (url) => {
  const path = new URL(url).pathname.replace(/^.*\/api\/v1/, '')
  return OPTED_IN.some((re) => re.test(path))
}

let stack, client, owner

const wire = (day) => `${day}T00:00:00`
const manilaDay = (offsetDays = 0) =>
  new Date(Date.now() + 8 * 3600 * 1000 + offsetDays * 86400 * 1000).toISOString().slice(0, 10)

/** The database's data version (backend app/core/data_version.py). */
const dataVersion = () => Number(stack.psql('SELECT version FROM data_version').split('\n')[2].trim())

/**
 * Every opted-in GET the page sends while `run` goes on: [{ url, status, sent }], read from
 * Chrome DevTools Protocol network events. `status` is the status on the wire: the page
 * (and Playwright's `response.status()`) sees a revalidated answer as the cached 200, so
 * only `Network.responseReceivedExtraInfo` shows the server's 304. `sent` is the
 * If-None-Match the browser's cache added. `seen.writes` lists the API requests that were
 * not GETs.
 */
async function recordApi(page, run) {
  const seen = []
  seen.writes = []
  const cdp = await page.context().newCDPSession(page)
  const byId = new Map()
  // The ExtraInfo events may arrive before or after requestWillBeSent: kept by id,
  // joined at the end.
  const sentHeaders = new Map()
  const wire = new Map()
  const header = (headers, name) => {
    const key = Object.keys(headers || {}).find((k) => k.toLowerCase() === name)
    return key ? headers[key] : null
  }
  cdp.on('Network.requestWillBeSent', ({ requestId, request }) => {
    if (!request.url.includes('/api/')) return
    if (request.method !== 'GET') { seen.writes.push(`${request.method} ${new URL(request.url).pathname}`); return }
    if (!optedIn(request.url) || byId.has(requestId)) return
    const entry = { url: request.url, status: null, sent: null, etag: null }
    byId.set(requestId, entry)
    seen.push(entry)
  })
  cdp.on('Network.requestWillBeSentExtraInfo', ({ requestId, headers }) => sentHeaders.set(requestId, headers))
  cdp.on('Network.responseReceivedExtraInfo', ({ requestId, statusCode, headers }) =>
    wire.set(requestId, { statusCode, headers }))
  await cdp.send('Network.enable')
  try {
    await run()
    await h.sleep(500)
  } finally {
    await cdp.detach().catch(() => null)
  }
  for (const [id, entry] of byId) {
    entry.sent = header(sentHeaders.get(id), 'if-none-match')
    const got = wire.get(id)
    if (got) { entry.status = got.statusCode; entry.etag = header(got.headers, 'etag') }
  }
  return seen
}

async function openTransactions(page) {
  await page.goto(`${stack.webUrl}/transactions`)
  await page.locator('article[role="button"]').filter({ hasText: 'Etag lunch 1' }).first().waitFor({ timeout: 15000 })
  await h.waitQuiet(page)
}

async function scenarioA(browser) {
  console.log('\n=== (a) a repeat Transactions page open with no write between is answered with 304s')
  const { ctx, page } = await h.newPage(browser)
  page.setDefaultTimeout(15000)
  try {
    await h.uiLogin(page, stack, owner)
    const first = await recordApi(page, () => openTransactions(page))
    await h.check('a.first-open-200', 'S', async () => {
      const ok = first.filter((r) => r.status === 200)
      return (first.length > 0 && ok.length === first.length) ||
        `first open: ${first.map((r) => `${r.status} ${new URL(r.url).pathname}`).join(', ') || 'no opted-in request'}`
    })
    // The first open's page-open POST takes the 15-minute installment slot, a real
    // write, often after the GETs were answered; the next open refetches at that
    // version. The open after that is the repeat open measured here.
    await recordApi(page, () => openTransactions(page))
    const version = dataVersion()
    const second = await recordApi(page, () => openTransactions(page))
    await h.check('a.no-write-between', 'S', async () => {
      const now = dataVersion()
      return now === version || `the data version moved ${version} -> ${now} (writes: ${second.writes.join(', ') || 'none'})`
    })
    if (process.env.DEBUG) for (const r of second) console.log(`  ${r.status} ${r.url} inm=${r.sent} etag=${r.etag}`)
    await h.check('a.second-open-requests', 'S', async () =>
      second.length > 0 || 'the second open sent no opted-in request')
    await h.check('a.all-revalidated', 'B', async () => {
      const missing = second.filter((r) => !r.sent)
      return missing.length === 0 ||
        `sent without If-None-Match: ${missing.map((r) => new URL(r.url).pathname).join(', ')}`
    })
    await h.check('a.all-304', 'B', async () => {
      const not304 = second.filter((r) => r.status !== 304)
      return not304.length === 0 ||
        `not 304: ${not304.map((r) => `${r.status} ${new URL(r.url).pathname}${new URL(r.url).search}`).join(', ')}`
    })
    await h.check('a.rows-shown', 'B', async () =>
      (await page.locator('article[role="button"]').filter({ hasText: 'Etag lunch 2' }).count()) > 0 ||
      'the rows are not shown after the 304s')
    console.log(`  second open: ${second.length} opted-in requests, ${second.filter((r) => r.status === 304).length} answered 304`)
  } finally {
    await ctx.close()
  }
}

async function scenarioB(browser) {
  console.log('\n=== (b) after a write, the next open gets 200s with the new data')
  const { ctx, page } = await h.newPage(browser)
  page.setDefaultTimeout(15000)
  try {
    await h.uiLogin(page, stack, owner)
    await recordApi(page, () => openTransactions(page))
    await client.post(owner.token, '/transactions/', {
      account_id: owner.account, transaction_type: 'debit', amount: 7, description: 'Etag lunch new',
      transaction_date: wire(manilaDay(0)), is_posted: true,
    })
    const after = await recordApi(page, () => openTransactions(page))
    await h.check('b.200s', 'B', async () => {
      const notOk = after.filter((r) => r.status !== 200)
      return (after.length > 0 && notOk.length === 0) ||
        `not 200 after a write: ${notOk.map((r) => `${r.status} ${new URL(r.url).pathname}`).join(', ')}`
    })
    await h.check('b.new-row', 'B', async () => {
      const row = page.locator('article[role="button"]').filter({ hasText: 'Etag lunch new' }).first()
      return (await row.waitFor({ timeout: 6000 }).then(() => true, () => false)) || 'the new row is not shown'
    })
  } finally {
    await ctx.close()
  }
}

async function setup() {
  // The migrations seed placeholder rates fetched at 1970, and this stack has no rate
  // provider to refresh them. While any stored rate is stale the API never answers 304
  // (backend app/core/conditional.py), as in production until the refresh lands.
  stack.psql('UPDATE fx_rates SET fetched_at = now()')
  owner = await h.makeUser(stack, 'etag')
  const account = await client.post(owner.token, '/accounts/', {
    name: 'Etag Checking', account_type: 'checking', balance: 9000, currency: 'PHP' })
  owner.account = account.id
  for (const i of [1, 2]) {
    await client.post(owner.token, '/transactions/', {
      account_id: account.id, transaction_type: 'debit', amount: 10 * i, description: `Etag lunch ${i}`,
      transaction_date: wire(manilaDay(0)), is_posted: true,
    })
  }
}

const SCENARIOS = [
  ['a', scenarioA],
  ['b', scenarioB],
]

const only = process.argv[2]

;(async () => {
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
