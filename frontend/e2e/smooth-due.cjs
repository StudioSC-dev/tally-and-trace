// Browser checks for STU-335 PR 2's "Due and overdue" count (plan 3.6 Q9c, scenario (e) in
// 5.2): the badge waits for the linked pending batches' first load instead of ticking up
// when they land. Starts its own API and web app against a throwaway database
// (./_local_stack.cjs) and seeds through the API; every expected figure is read from the
// page's own rows. Not wired into CI and not part of `pnpm build`. Run steps: see
// ./README.md.
//
// (f) is STU-485's: the same for the Not posted yet badge, while the window query is held.
// (g) is STU-511's: the Upcoming badge and panel while its occurrences request is held after a day turn.
//
// Check kinds: [B] behavioural, [S] structural (a failed one makes the run invalid),
// [G] guard. The script ends with RESULT: k/m and exits 0 only when every check passed,
// 1 when any failed, 2 for setup.
//
// Usage: node frontend/e2e/smooth-due.cjs [scenario]
const { startLocalStack } = require('./_local_stack.cjs')
const { useDueCheck, expectDueTab, allDueRows, openDueTab, readTab } = require('./_due_pages.cjs')
const h = require('./_smooth.cjs')
// openDueTab's "the due card has the <slug> tab" assertion, as a [B] check named tab.<slug>.
useDueCheck((what, actual, expected) => h.check(`tab.${what.split(' ').at(-2)}`, 'B', async () => actual === expected || `${what}: actual=${actual} expected=${expected}`))

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
const addDays = (day, n) => {
  const d = new Date(`${day}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().slice(0, 10)
}
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
/** The section's own window query: pending rows, 1000 a batch, no ids and no start date (the main list sends no is_posted). */
const isSectionWindow = (r) => {
  if (!isWindow(r)) return false
  const q = new URL(r.url()).searchParams
  return q.get('is_posted') === 'false' && q.get('limit') === '1000' && !q.has('start_date')
}
/** The Upcoming card's occurrences request (the plan=none partition, until Subscriptions adds its own). */
const isUpcomingOccurrences = (r) => {
  if (r.method() !== 'GET' || !pathIs('/budget-entries/upcoming-occurrences')(r)) return false
  return new URL(r.url()).searchParams.get('plan') === 'none'
}
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

// (f) STU-485: the window query held. Both badges (Due and Not posted yet) read "…", neither
// tab's empty text shows, and when the batch lands the Not posted yet badge never shows a
// figure that then changes: its history is "…" and the final value.
async function scenarioF(browser) {
  console.log('\n=== (f) window batch held: both badges read "…", no due-empty, then Not posted settles once')
  const u = await h.makeUser(stack, 'due-f')
  const today = manilaToday()
  const bank = await client.post(u.token, '/accounts/', { name: 'Checking due-f', account_type: 'checking', balance: 100000, currency: 'PHP' })
  for (const [days, name, amount] of [[3, 'F Coffee', 180], [1, 'F Fee', 35]]) {
    await client.post(u.token, '/transactions/', {
      account_id: bank.id, transaction_type: 'debit', amount, description: name,
      transaction_date: wire(addDays(today, -days)), is_posted: false,
    })
  }
  const { ctx, page } = await h.newPage(browser, { viewport: { width: 1280, height: 1400 } })
  page.setDefaultTimeout(10000)
  await h.recordTexts(page, ['due-count', 'due-not-posted-count'])
  let g
  try {
    g = await h.gate(page, isSectionWindow)
    await h.uiLogin(page, stack, u)
    await page.goto(`${stack.webUrl}/transactions`)
    await h.check('f.window-held', 'S', async () => (await g.waitHits(1)) || 'window query never requested')
    await page.locator(tid('due-section')).waitFor()
    await page.locator(tid('due-not-posted-count')).waitFor()
    await h.sleep(750)
    const badge = async (id) => ((await page.locator(tid(id)).textContent()) || '').trim()
    await h.check('f.both-badges-pending', 'B', async () => {
      const shown = [await badge('due-count'), await badge('due-not-posted-count')]
      return (shown[0] === '…' && shown[1] === '…') || `badges read ${JSON.stringify(shown)} while the window was held`
    })
    await h.check('f.no-due-empty-text-while-held', 'B', async () =>
      (await h.expectAbsentFor(page, page.locator(tid('due-empty')), 500)) || 'due-empty shown while the window was held')
    g.release({ disarm: true })
    await page.locator(tid('due-not-posted-count')).filter({ hasNotText: '…' }).waitFor()
    await h.waitQuiet(page)
    await h.sleep(500)
    await openDueTab(page, 'not-posted')
    const rows = await allDueRows(page)
    const texts = (await h.readTexts(page))['due-not-posted-count'].texts
    await h.check('f.rows-listed', 'S', async () => rows.length === 2 || `Not posted yet lists ${rows.length} row(s), expected F Coffee and F Fee`)
    await h.check('f.history-only-pending-and-final', 'B', async () => {
      const allowed = new Set(['…', String(rows.length)])
      return texts.every((t) => allowed.has(t)) || `due-not-posted-count history ${JSON.stringify(texts)}, rows ${rows.length}`
    })
    await h.check('f.final-equals-rows', 'B', async () => {
      const shown = await badge('due-not-posted-count')
      return shown === String(rows.length) || `due-not-posted-count "${shown}", ${rows.length} rows across the pager`
    })
  } finally {
    g?.release({ disarm: true })
    await ctx.close()
  }
}

// (g) STU-511: the Upcoming occurrences request held. The Upcoming tab is open and settled first;
// the Manila day then turns on the browser clock, which changes the window's arguments and sends
// a new occurrences request, and that one is held. The badge reads "…", the panel stays mounted
// with no empty text, and when the request lands the badge's history is only "…" and its final value.
// (A held request keeps the screen loader up and its capture guard swallows input, so the tab is
// selected before the hold and nothing is clicked while it lasts.)
async function scenarioG(browser) {
  console.log('\n=== (g) day turns with the Upcoming tab open, occurrences request held: badge "…", panel mounted, no empty text, then it settles once')
  const u = await h.makeUser(stack, 'due-g')
  const day = manilaToday()
  const bank = await client.post(u.token, '/accounts/', { name: 'Checking due-g', account_type: 'checking', balance: 100000, currency: 'PHP' })
  await client.post(u.token, '/transactions/', {
    account_id: bank.id, transaction_type: 'debit', amount: 50, description: 'G Planned',
    transaction_date: wire(addDays(day, 2)), is_posted: false,
  })
  await client.post(u.token, '/budget-entries/', {
    entry_type: 'expense', currency: 'PHP', cadence: 'monthly', name: 'G Bill', amount: 800, account_id: bank.id,
    next_occurrence: wire(addDays(day, 3)),
  })
  const { ctx, page } = await h.newPage(browser, { viewport: { width: 1280, height: 1400 } })
  page.setDefaultTimeout(10000)
  // A UTC browser two minutes before Manila midnight (16:00 UTC) of the real day.
  await page.clock.install({ time: new Date(`${day}T15:58:00Z`) })
  await h.recordTexts(page, ['due-upcoming-count'])
  let g
  try {
    await h.uiLogin(page, stack, u)
    await page.goto(`${stack.webUrl}/transactions`)
    await page.locator(tid('due-section')).waitFor()
    await expectDueTab(page, 'upcoming')
    await page.locator(tid('due-upcoming-count')).filter({ hasNotText: '…' }).waitFor()
    await openDueTab(page, 'upcoming')
    await h.waitQuiet(page)
    await h.sleep(500)
    await h.resetTexts(page)
    g = await h.gate(page, isUpcomingOccurrences)
    // Playwright reads '03:00' as mm:ss: three minutes, past Manila midnight.
    await page.clock.fastForward('03:00')
    await h.check('g.occurrences-held', 'S', async () => (await g.waitHits(1)) || 'the new day sent no occurrences request')
    await h.sleep(750)
    const badge = async () => ((await page.locator(tid('due-upcoming-count')).textContent()) || '').trim()
    await h.check('g.badge-pending', 'B', async () => {
      const shown = await badge()
      return shown === '…' || `due-upcoming-count read "${shown}" while the occurrences request was held`
    })
    await h.check('g.panel-mounted-while-held', 'S', async () => {
      const panel = page.locator(tid('due-panel-upcoming'))
      const got = { selected: await page.locator(`${tid('due-tab-upcoming')}[aria-selected="true"]`).count(), hidden: await panel.getAttribute('hidden'), children: await panel.evaluate((el) => el.children.length) }
      return (got.selected === 1 && got.hidden === null && got.children > 0) || `panel ${JSON.stringify(got)}`
    })
    await h.check('g.no-empty-text-while-held', 'B', async () =>
      (await h.expectAbsentFor(page, page.locator(tid('due-upcoming-empty')), 500)) || 'due-upcoming-empty shown while the occurrences request was held')
    g.release({ disarm: true })
    await page.locator(tid('due-upcoming-count')).filter({ hasNotText: '…' }).waitFor()
    await h.waitQuiet(page)
    await h.sleep(500)
    const rows = await readTab(page, 'upcoming')
    const texts = (await h.readTexts(page))['due-upcoming-count'].texts
    await h.check('g.rows-listed', 'S', async () => rows.length === 2 || `Upcoming lists ${rows.length} row(s), expected G Planned and G Bill`)
    await h.check('g.history-only-pending-and-final', 'B', async () => {
      const allowed = new Set(['…', String(rows.length)])
      return texts.every((t) => allowed.has(t)) || `due-upcoming-count history ${JSON.stringify(texts)}, rows ${rows.length}`
    })
    await h.check('g.final-equals-rows', 'B', async () => {
      const shown = await badge()
      return shown === String(rows.length) || `due-upcoming-count "${shown}", ${rows.length} rows across the pager`
    })
  } finally {
    g?.release({ disarm: true })
    await ctx.close()
  }
}

const SCENARIOS = [
  ['e', scenarioE],
  ['f', scenarioF],
  ['g', scenarioG],
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
