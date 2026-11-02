// Browser checks for STU-497: the dashboard and the account page decide their days on
// Manila's calendar, whatever the browser's own time zone. Starts its own API and web app
// against a throwaway database (./_local_stack.cjs) and seeds through the API. Not wired
// into CI and not part of `pnpm build`. Run steps: see ./README.md.
//
// The backend clock is real and cannot be pinned, so the browser's zone is chosen at run
// time so that its day differs from Manila's: Etc/GMT+12 (UTC-12, the previous day) while
// the Manila hour is before 20, otherwise Pacific/Kiritimati (UTC+14, the next day). Each
// check fails under the old code in both directions.
//
//   (a) the dashboard reads a payable due Manila today as Pending, "Due today", and one due
//       Manila tomorrow as Planned, "1 day remaining";
//   (b) the account page lists the posted row dated Manila today and not the one dated
//       Manila tomorrow;
//   (c) the Transactions page's due-window request ends at `<Manila today + 30>T23:59:59.999999Z`.
//
// Check kinds: [B] behavioural, [S] structural (a failed one makes the run invalid).
// The script ends with RESULT: k/m and exits 0 only when every check passed, 1 when any
// failed, 2 for setup.
//
// Usage: node frontend/e2e/manila-day.cjs
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

const WINDOW_DAYS = 30
const MARGIN_MIN = 5

const addDays = (day, n) => {
  const d = new Date(`${day}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().slice(0, 10)
}
const manilaNow = () => new Date(Date.now() + 8 * 3600 * 1000)
const manilaToday = () => manilaNow().toISOString().slice(0, 10)
const manilaHour = () => manilaNow().getUTCHours()
const tid = (id) => `[data-testid="${id}"]`

/** Minutes until the next midnight in `timeZone` (Manila when omitted). */
function minutesToMidnight(timeZone = 'Asia/Manila') {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date())
  const get = (type) => Number(parts.find((p) => p.type === type).value)
  return 24 * 60 - (get('hour') * 60 + get('minute'))
}
/** Minutes since the last midnight in `timeZone`. */
const minutesSinceMidnight = (timeZone) => (24 * 60 - minutesToMidnight(timeZone)) % (24 * 60)

/** The zone whose local day differs from Manila's now, waiting out a nearby midnight of either. */
async function pickZone() {
  for (let i = 0; i < 20; i++) {
    const zone = manilaHour() < 20 ? 'Etc/GMT+12' : 'Pacific/Kiritimati'
    const near = (m) => m < MARGIN_MIN || m > 24 * 60 - MARGIN_MIN
    const nearMidnight = near(minutesToMidnight()) || near(minutesToMidnight(zone)) || near(minutesSinceMidnight(zone))
    if (!nearMidnight) return zone
    console.log(`  NOTE within ${MARGIN_MIN} minutes of a midnight (Manila or ${zone}); waiting`)
    await h.sleep(60_000)
  }
  throw new Error('a midnight stayed within reach for 20 minutes')
}

const wireAt = (day, time) => `${day}T${time}`

;(async () => {
  process.on('unhandledRejection', (e) => console.log(`  NOTE unhandled rejection: ${e && e.message ? e.message.split('\n')[0] : e}`))
  const zone = await pickZone()
  const stack = await startLocalStack()
  const client = h.apiClient(stack)
  const browser = await chromium.launch()
  let code = 2
  try {
    const today = manilaToday()
    const tomorrow = addDays(today, 1)

    const u = await h.makeUser(stack, 'md')
    const bank = await client.post(u.token, '/accounts/', { name: 'MD Checking', account_type: 'checking', balance: 100000, currency: 'PHP' })
    const bills = await client.post(u.token, '/accounts/', { name: 'MD Bills', account_type: 'checking', balance: 100000, currency: 'PHP' })
    for (const [day, name] of [[today, 'MD Payable Today'], [tomorrow, 'MD Payable Tomorrow']]) {
      await client.post(u.token, '/transactions/', {
        account_id: bills.id, transaction_type: 'debit', amount: 100, description: name, transaction_date: wireAt(day, '00:00:00'), is_posted: false,
      })
    }
    for (const [day, name] of [[today, 'MD Posted Today'], [tomorrow, 'MD Posted Tomorrow']]) {
      await client.post(u.token, '/transactions/', {
        account_id: bank.id, transaction_type: 'debit', amount: 50, description: name, transaction_date: wireAt(day, '12:00:00'), is_posted: true,
      })
    }

    const { ctx, page } = await h.newPage(browser, { timezoneId: zone })
    const requests = h.logRequests(page)
    try {
      const local = await h.localDay(page)
      console.log(`  zone ${zone}: browser day ${local}, Manila day ${today}`)
      await h.check('precondition.browser-day-differs', 'S', async () => local !== today || `browser day ${local} equals Manila's ${today}`)

      // (a) the dashboard
      console.log('\n=== (a) the dashboard reads its payables on the Manila day')
      await h.uiLogin(page, stack, u)
      await page.locator(tid('payable-row')).first().waitFor()
      await h.waitQuiet(page)
      const rows = await page.locator(tid('payable-row')).evaluateAll((els) =>
        els.map((el) => ({
          text: (el.textContent || '').replace(/\s+/g, ' ').trim(),
          status: el.querySelector('[data-testid="payable-status"]')?.getAttribute('aria-label') ?? null,
          due: (el.querySelector('.text-right p')?.textContent || '').trim(),
        })),
      )
      const rowFor = (name) => rows.find((r) => r.text.includes(name))
      await h.check('a.today-is-pending-and-due-today', 'B', async () => {
        const row = rowFor('MD Payable Today')
        return (row && row.status === 'Pending' && row.due === 'Due today') || `row ${JSON.stringify(row)}`
      })
      await h.check('a.tomorrow-is-planned-one-day', 'B', async () => {
        const row = rowFor('MD Payable Tomorrow')
        return (row && row.status === 'Planned' && row.due === '1 day remaining') || `row ${JSON.stringify(row)}`
      })

      // (c) the Transactions page's due window
      console.log('\n=== (c) the due window ends at the end of Manila today + 30')
      await page.goto(`${stack.webUrl}/transactions`)
      await h.sleep(1500)
      await h.waitQuiet(page)
      const expectedEnd = `${addDays(today, WINDOW_DAYS)}T23:59:59.999999Z`
      await h.check('c.due-window-end-date', 'B', async () => {
        const ends = requests
          .filter((r) => r.method === 'GET' && new URL(r.url).pathname.endsWith('/transactions/') && new URL(r.url).searchParams.get('is_posted') === 'false')
          .map((r) => new URL(r.url).searchParams.get('end_date'))
        return ends.includes(expectedEnd) || `end_date values ${JSON.stringify([...new Set(ends)])}, expected ${expectedEnd}`
      })

      // (b) the account page
      console.log('\n=== (b) the account page lists up to the end of the Manila day')
      await page.goto(`${stack.webUrl}/accounts/${bank.id}`)
      await page.locator(tid('account-detail')).waitFor()
      await h.waitQuiet(page)
      await page.locator(tid('account-transactions-loading')).waitFor({ state: 'detached', timeout: 10_000 }).catch(() => undefined)
      const shown = await page.locator(tid('account-transaction')).evaluateAll((els) => els.map((el) => (el.textContent || '').replace(/\s+/g, ' ')))
      await h.check('b.today-row-listed', 'B', async () => shown.some((t) => t.includes('MD Posted Today')) || `rows ${JSON.stringify(shown)}`)
      await h.check('b.tomorrow-row-not-listed', 'B', async () => !shown.some((t) => t.includes('MD Posted Tomorrow')) || `rows ${JSON.stringify(shown)}`)
    } finally {
      await ctx.close()
    }
    code = h.report()
  } catch (e) {
    console.error(e)
    code = 2
  } finally {
    await browser.close()
    stack.stop()
  }
  process.exit(code)
})().catch((e) => { console.error(e); process.exit(2) })
