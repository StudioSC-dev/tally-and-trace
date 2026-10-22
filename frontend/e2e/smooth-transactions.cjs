// Browser checks for STU-335 on the Transactions page (plan 3.6 Q3 and 5.2, transactions
// (a) and (b)): a failed list load shows an alert with Retry, never "No transactions
// found", and a failed reload keeps the rows on screen with the alert above them. Starts
// its own API and web app against a throwaway database (./_local_stack.cjs) and seeds
// through the API; every expected value is read from the API. Not wired into CI and not
// part of `pnpm build`. Run steps: see ./README.md.
//
// Check kinds: [B] behavioural, [S] structural (a failed one makes the run invalid),
// [G] guard. The script ends with RESULT: k/m and exits 0 only when every check passed,
// 1 when any failed, 2 for setup.
//
// Usage: node frontend/e2e/smooth-transactions.cjs [scenario]
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

const only = process.argv[2]

const EMPTY = 'No transactions found'

let stack, client, owner, account, thisMonth, prevMonth

const tid = (id) => `[data-testid="${id}"]`
const wire = (day) => `${day}T00:00:00`
const manilaNow = () => new Date(Date.now() + 8 * 3600 * 1000)
const firstOfMonth = (monthsBack) => {
  const d = manilaNow()
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - monthsBack, 1)).toISOString().slice(0, 10)
}

/**
 * The page's main list: no ids, no is_posted, and a start_date on or before the first of
 * the current month. The Upcoming list starts after today, so it never matches.
 */
const isMain = (r) => {
  if (r.method() !== 'GET') return false
  const url = new URL(r.url())
  if (!url.pathname.endsWith('/transactions/')) return false
  const p = url.searchParams
  return !p.has('ids') && !p.has('is_posted') && (p.get('start_date') || '9999').slice(0, 10) <= thisMonth
}
/** The main list for a month that starts before the current one. */
const isPreviousMonthMain = (r) =>
  isMain(r) && (new URL(r.url()).searchParams.get('start_date') || '').slice(0, 10) < thisMonth

/** A fresh signed-in page that records whether the empty text ever appeared in the body. */
async function openPage(browser) {
  const { ctx, page } = await h.newPage(browser)
  page.setDefaultTimeout(10000)
  await page.addInitScript((phrase) => {
    window.__txnSeen = false
    const scan = () => {
      if (document.body && (document.body.textContent || '').includes(phrase)) window.__txnSeen = true
    }
    const start = () => {
      new MutationObserver(scan).observe(document.documentElement, { childList: true, subtree: true, characterData: true })
      scan()
    }
    if (document.documentElement) start()
    else document.addEventListener('DOMContentLoaded', start, { once: true })
  }, EMPTY)
  await h.uiLogin(page, stack, owner)
  return { ctx, page }
}

const everShownEmpty = (page) => page.evaluate(() => window.__txnSeen === true)
const rowFor = (page, description) => page.locator('article[role="button"]').filter({ hasText: description }).first()
const rowCount = (page) => page.locator('article[role="button"]').count()

/** The API's total for the exact list request the page sent. */
async function apiTotalFor(request) {
  const url = new URL(request.url())
  const params = new URLSearchParams(url.searchParams)
  params.set('limit', '1')
  params.set('offset', '0')
  const body = await client.get(owner.token, `/transactions/?${params.toString()}`)
  return body.total
}

// (a) A failed first load shows the alert with Retry in place of the empty state.
async function scenarioA(browser) {
  console.log('\n=== (a) a failed first load shows an error with Retry, not "No transactions found"')
  const { ctx, page } = await openPage(browser)
  let fail = null
  try {
    fail = await h.failWith(page, isMain, 500, { times: 1 })
    await page.goto(`${stack.webUrl}/transactions`)
    const alert = page.locator(tid('transactions-load-error'))
    await h.check('a.alert', 'B', async () => {
      const shown = await alert.waitFor({ timeout: 6000 }).then(() => true, () => false)
      return shown || `no transactions-load-error (failures delivered: ${fail.failed})`
    })
    await h.check('a.retry-shown', 'B', async () =>
      (await alert.locator(tid('transactions-retry')).isVisible()) || 'no transactions-retry in the alert')
    await h.check('a.no-empty-text', 'B', async () => {
      const absent = await h.expectAbsentFor(page, page.getByText(EMPTY), 1500)
      const seen = await everShownEmpty(page)
      return (absent && !seen) || `"${EMPTY}" shown (absent for 1.5 s: ${absent}, ever seen: ${seen})`
    })
    const listed = page.waitForResponse((r) => isMain(r.request()) && r.status() === 200, { timeout: 8000 }).catch(() => null)
    await page.locator(tid('transactions-retry')).click({ timeout: 3000 }).catch(() => null)
    const response = await listed
    await rowFor(page, 'Txn this month 1').waitFor({ timeout: 6000 }).catch(() => null)
    await h.waitQuiet(page)
    await h.check('a.retry-lists', 'B', async () => {
      if (!response) return 'no successful list response after Retry'
      const total = await apiTotalFor(response.request())
      const shown = await rowCount(page)
      return shown === total || `shown ${shown} rows, api total ${total}`
    })
    await h.check('a.alert-gone', 'B', async () => (await alert.count()) === 0 || 'the alert stayed after a successful Retry')
  } finally {
    await fail?.stop()
    await ctx.close()
  }
}

// (b) A failed reload keeps the current rows live, with the alert and Retry above them.
async function scenarioB(browser) {
  console.log('\n=== (b) a failed month change keeps the rows, with the alert and Retry above them')
  const { ctx, page } = await openPage(browser)
  let fail = null
  try {
    await page.goto(`${stack.webUrl}/transactions`)
    await rowFor(page, 'Txn this month 1').waitFor()
    await h.waitQuiet(page)
    fail = await h.failWith(page, isPreviousMonthMain, 500, { times: 1 })
    await page.getByRole('button', { name: 'View previous month' }).click()
    const alert = page.locator(tid('transactions-load-error'))
    await alert.waitFor({ timeout: 6000 }).catch(() => null)
    await h.waitQuiet(page)
    await h.check('b.failed', 'S', async () => fail.failed === 1 || `failures delivered: ${fail.failed}`)
    await h.check('b.rows-kept', 'B', async () =>
      (await rowFor(page, 'Txn this month 1').isVisible()) || 'the current rows are gone after the failed reload')
    await h.check('b.alert-above', 'B', async () => {
      const box = await alert.boundingBox()
      const retry = await alert.locator(tid('transactions-retry')).isVisible().catch(() => false)
      const row = await page.locator('article[role="button"]').first().boundingBox()
      if (!box || !retry) return 'no alert with Retry'
      if (!row) return 'no rows'
      return box.y + box.height <= row.y || `alert bottom ${box.y + box.height} below row top ${row.y}`
    })
    await h.check('b.no-empty-text', 'B', async () => {
      const absent = await h.expectAbsentFor(page, page.getByText(EMPTY), 1500)
      const seen = await everShownEmpty(page)
      return (absent && !seen) || `"${EMPTY}" shown (absent for 1.5 s: ${absent}, ever seen: ${seen})`
    })
    const listed = page.waitForResponse((r) => isPreviousMonthMain(r.request()) && r.status() === 200, { timeout: 8000 }).catch(() => null)
    await page.locator(tid('transactions-retry')).click({ timeout: 3000 }).catch(() => null)
    const response = await listed
    await rowFor(page, 'Txn previous month').waitFor({ timeout: 6000 }).catch(() => null)
    await h.waitQuiet(page)
    await h.check('b.retry-lists-previous-month', 'B', async () => {
      if (!response) return 'no successful previous-month response after Retry'
      const total = await apiTotalFor(response.request())
      const shown = await rowCount(page)
      const prev = await rowFor(page, 'Txn previous month').isVisible()
      return (shown === total && prev) || `shown ${shown} rows, api total ${total}, previous-month row visible ${prev}`
    })
  } finally {
    await fail?.stop()
    await ctx.close()
  }
}

async function setup() {
  owner = await h.makeUser(stack, 'txns')
  account = await client.post(owner.token, '/accounts/', { name: 'Txn Checking', account_type: 'checking', balance: 9000, currency: 'PHP' })
  thisMonth = firstOfMonth(0)
  prevMonth = firstOfMonth(1)
  for (const [i, day] of [[1, thisMonth], [2, thisMonth]]) {
    await client.post(owner.token, '/transactions/', {
      account_id: account.id, transaction_type: 'debit', amount: 10 * i, description: `Txn this month ${i}`,
      transaction_date: wire(day), is_posted: true,
    })
  }
  await client.post(owner.token, '/transactions/', {
    account_id: account.id, transaction_type: 'debit', amount: 33, description: 'Txn previous month',
    transaction_date: wire(prevMonth), is_posted: true,
  })
}

const SCENARIOS = [
  ['a', scenarioA],
  ['b', scenarioB],
]

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
