// Browser checks for STU-335 PR 2's "Due and overdue" count (plan 3.6 Q9c, scenario (e) in
// 5.2): the badge waits for the linked pending batches' first load instead of ticking up
// when they land. Starts its own API and web app against a throwaway database
// (./_local_stack.cjs) and seeds through the API; every expected figure is read from the
// page's own rows. Not wired into CI and not part of `pnpm build`. Run steps: see
// ./README.md.
//
// Check kinds: [B] behavioural, [S] structural (a failed one makes the run invalid),
// [G] guard. The script ends with RESULT: k/m and exits 0 only when every check passed,
// 1 when any failed, 2 for setup.
//
// Usage: node frontend/e2e/smooth-due.cjs [scenario]
const { startLocalStack } = require('./_local_stack.cjs')
const { allDueRows } = require('./_due_pages.cjs')
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

// ─── Days (YYYY-MM-DD, UTC arithmetic) ───────────────────────────────────────
const manilaToday = () => new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10)
const daysIn = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate()
/** `day` moved by n months, on day-of-month `anchor` (clamped to the month). */
const addMonths = (day, n, anchor) => {
  let y = Number(day.slice(0, 4))
  let m = Number(day.slice(5, 7)) + n
  while (m > 12) { m -= 12; y += 1 }
  while (m < 1) { m += 12; y -= 1 }
  return `${y}-${String(m).padStart(2, '0')}-${String(Math.min(anchor, daysIn(y, m))).padStart(2, '0')}`
}
const wire = (day) => `${day}T00:00:00`

let stack, client

const tid = (id) => `[data-testid="${id}"]`
const pathIs = (suffix) => (r) => new URL(r.url()).pathname.endsWith(suffix)
/** The window query: transactions with no `ids`. */
const isWindow = (r) => r.method() === 'GET' && pathIs('/transactions/')(r) && new URL(r.url()).searchParams.getAll('ids').length === 0
/** A linked batch: transactions asked for by `ids`. */
const isLinkedBatch = (r) => r.method() === 'GET' && pathIs('/transactions/')(r) && new URL(r.url()).searchParams.getAll('ids').length > 0

// (e) A missed subscription with a linked pending transaction that only the linked batch
// delivers: the badge never shows a count the batch then changes.
async function scenarioE(browser) {
  console.log('\n=== (e) linked batch held: the due count never ticks up when it lands')
  const u = await h.makeUser(stack, 'due-e')
  const today = manilaToday()
  const anchor = Math.min(25, Math.max(5, Number(today.slice(8, 10))))
  const start = addMonths(today, -2, anchor)
  const bank = await client.post(u.token, '/accounts/', { name: 'Checking due-e', account_type: 'checking', balance: 100000, currency: 'PHP' })
  const water = await client.post(u.token, '/budget-entries/', {
    entry_type: 'expense', currency: 'PHP', cadence: 'monthly', name: 'Water', amount: 900, account_id: bank.id,
    next_occurrence: wire(start), anchor_day: anchor,
  })
  const linked = await client.post(u.token, '/transactions/', {
    account_id: bank.id, transaction_type: 'debit', amount: 900, description: 'Water bill',
    transaction_date: wire(start), is_posted: false, budget_entry_id: water.id,
  })
  const { ctx, page } = await h.newPage(browser, { viewport: { width: 1280, height: 1400 } })
  page.setDefaultTimeout(10000)
  await h.recordTexts(page, ['due-count'])
  let drop, g
  try {
    // The window query does not return the linked row, so only the linked batch can.
    drop = await h.rewrite(page, isWindow, (json) => ({ ...json, items: json.items.filter((t) => t.id !== linked.id) }))
    g = await h.gate(page, isLinkedBatch)
    await h.uiLogin(page, stack, u)
    await page.goto(`${stack.webUrl}/transactions`)
    await h.check('e.linked-batch-held', 'S', async () => (await g.waitHits(1)) || 'linked batch never requested')
    await page.locator(tid('due-count')).waitFor()
    await h.sleep(750)
    await h.check('e.count-pending', 'B', async () => {
      const shown = ((await page.locator(tid('due-count')).textContent()) || '').trim()
      return shown === '…' || `due-count read "${shown}" while the batch was held`
    })
    await h.check('e.no-empty-text-while-held', 'B', async () =>
      (await h.expectAbsentFor(page, page.locator(tid('due-empty')), 500)) || 'due-empty shown while the batch was held')
    g.release({ disarm: true })
    await page.locator(tid('due-list')).waitFor()
    await h.waitQuiet(page)
    await h.sleep(500)
    const rows = await allDueRows(page)
    const texts = (await h.readTexts(page))['due-count'].texts
    await h.check('e.linked-row-listed', 'S', async () => rows.some((r) => r.kind === 'pending' && r.text.includes('Water bill')) || 'the linked pending row is not listed')
    await h.check('e.history-only-pending-and-final', 'B', async () => {
      const allowed = new Set(['…', String(rows.length)])
      return texts.every((t) => allowed.has(t)) || `due-count history ${JSON.stringify(texts)}, rows ${rows.length}`
    })
    await h.check('e.final-equals-rows', 'B', async () => {
      const shown = ((await page.locator(tid('due-count')).textContent()) || '').trim()
      return shown === String(rows.length) || `due-count "${shown}", ${rows.length} rows across the pager`
    })
  } finally {
    g?.release({ disarm: true })
    await drop?.stop()
    await ctx.close()
  }
}

const SCENARIOS = [
  ['e', scenarioE],
]

;(async () => {
  process.on('unhandledRejection', (e) => console.log(`  NOTE unhandled rejection: ${e && e.message ? e.message.split('\n')[0] : e}`))
  try {
    stack = await startLocalStack()
  } catch (e) {
    console.error('SETUP FAILED', e)
    process.exit(2)
  }
  client = h.apiClient(stack)
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
})().catch((e) => { console.error(e); stack?.stop(); process.exit(1) })
