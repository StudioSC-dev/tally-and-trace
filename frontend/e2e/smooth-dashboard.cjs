// Browser checks for STU-335's dashboard loaders (plan section 2 "Dashboard", 3.6 Q2,
// scenarios in 5.2): no zero flash before a figure loads, the snapshot's currency before
// any total, and a Retry that refetches only the failed queries. Starts its own API and
// web app against a throwaway database (./_local_stack.cjs) and seeds through the API;
// every expected figure is read from the API. Not wired into CI and not part of
// `pnpm build`. Run steps: see ./README.md.
//
// Check kinds: [B] behavioural, [S] structural (a failed one makes the run invalid),
// [G] guard (holds at base and must keep holding). The script ends with RESULT: k/m and
// exits 0 only when every check passed, 1 when any failed, 2 for setup.
//
// Usage: node frontend/e2e/smooth-dashboard.cjs [scenario]
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

// ─── Days (YYYY-MM-DD, UTC arithmetic) ───────────────────────────────────────
const manilaToday = () => new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10)
const addDays = (day, n) => {
  const d = new Date(`${day}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().slice(0, 10)
}
const wire = (day) => `${day}T00:00:00`
/** As the app shows PHP money: "₱1,851.10". */
const peso = (n) => `₱${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

let stack, client, today

// ─── Helpers ─────────────────────────────────────────────────────────────────

const tid = (id) => `[data-testid="${id}"]`
const pathIs = (suffix) => (r) => new URL(r.url()).pathname.endsWith(suffix)
const isGet = (suffix) => (r) => r.method() === 'GET' && pathIs(suffix)(r)
const isSnapshot = isGet('/dashboard/snapshot')
const isSummary = isGet('/transactions/summary/period')
const isEntries = isGet('/budget-entries/')
const isAllocations = isGet('/allocations/')
const shownTexts = (texts, id) => (texts[id] || { texts: [] }).texts
const textOf = async (locator) => ((await locator.textContent()) || '').replace(/\s+/g, ' ').trim()

/** A user with a checking account, income and an expense this month, one envelope and one autopay schedule due in 10 days. */
async function seed(tag, { currency = 'PHP' } = {}) {
  const u = await h.makeUser(stack, tag, { currency })
  const bank = await client.post(u.token, '/accounts/', { name: `Checking ${tag}`, account_type: 'checking', balance: 100000, currency })
  for (const [type, amount, description] of [['credit', 5000, 'Salary'], ['debit', 1200, 'Groceries run']]) {
    await client.post(u.token, '/transactions/', {
      account_id: bank.id, transaction_type: type, amount, description, transaction_date: wire(today), is_posted: true,
    })
  }
  await client.post(u.token, '/allocations/', {
    account_id: bank.id, name: `Envelope ${tag}`, allocation_type: 'budget', target_amount: 3000, period_frequency: 'monthly',
  })
  await client.post(u.token, '/budget-entries/', {
    entry_type: 'expense', currency, cadence: 'monthly', name: `Gym ${tag}`, amount: 750, account_id: bank.id,
    is_autopay: true, next_occurrence: wire(addDays(today, 10)),
  })
  return { ...u, bank }
}

const snapshotOf = (u) => client.get(u.token, '/dashboard/snapshot')
const rowOf = (rows, currency) => rows.find((r) => r.currency === currency)

/** The summary the page asked for, replayed through the API: [income, expenses, net] as peso text. */
async function summaryFor(u, requests, currency = 'PHP') {
  const asked = requests.find((r) => r.method === 'GET' && new URL(r.url).pathname.endsWith('/transactions/summary/period'))
  if (!asked) return null
  const url = new URL(asked.url)
  const summary = await client.get(u.token, `/transactions/summary/period${url.search}`)
  const row = rowOf(summary.by_currency, currency)
  return row ? [peso(row.total_income), peso(row.total_expenses), peso(row.net_flow)] : null
}

/** A section's busy semantics (plan 3.3): its aria-busy, its role="status" count, and whether one is nested in another. */
const busyOf = (container) => container.evaluate((el) => ({
  busy: el.getAttribute('aria-busy'),
  statuses: el.querySelectorAll('[role="status"]').length,
  nested: el.closest('[role="status"]') !== null || el.querySelector('[role="status"] [role="status"]') !== null,
}))
const heldBusy = async (container) => {
  const r = await busyOf(container)
  return (r.busy === 'true' && r.statuses === 1 && !r.nested) || JSON.stringify(r)
}
const settledBusy = async (container) => {
  const r = await busyOf(container)
  return (r.busy !== 'true' && r.statuses === 0) || JSON.stringify(r)
}
const totalsGroup = (page) => page.locator(tid('actual-totals')).locator('xpath=..')
const projectionGroup = (page) => page.locator(tid('projection')).locator('xpath=..')
const netWorthGroup = (page) => page.locator('[data-onboarding="financial-snapshot"] dt', { hasText: /^Net worth$/ })
  .locator('xpath=ancestor::div[contains(concat(" ", normalize-space(@class), " "), " border-t ")][1]')

const WATCHED = ['net-worth', 'available-cash', 'period-income', 'period-expenses', 'period-net-flow', 'payables-count', 'payable-status']

/**
 * A fresh page that records the dashboard's figures from its first document. `clockAt`
 * (an ISO instant) pins the page clock there, running, in the Asia/Manila zone.
 */
async function openPage(browser, { clockAt } = {}) {
  const { ctx, page } = await h.newPage(browser, clockAt ? { timezoneId: 'Asia/Manila' } : {})
  if (clockAt) await page.clock.install({ time: new Date(clockAt) })
  page.setDefaultTimeout(10000)
  await h.recordTexts(page, WATCHED, { attributes: ['aria-label'] })
  const requests = h.logRequests(page)
  return { ctx, page, requests }
}

// ─── Scenarios ───────────────────────────────────────────────────────────────

// (a) The snapshot is held: no zero, no empty state for anything it feeds.
async function scenarioA(browser) {
  console.log('\n=== (a) snapshot held: balances and payables never flash zero or empty')
  const u = await seed('a')
  const { ctx, page, requests } = await openPage(browser)
  let g
  try {
    g = await h.gate(page, isSnapshot)
    await h.uiLogin(page, stack, u)
    await h.check('a.snapshot-held', 'S', async () => (await g.waitHits(1)) || 'snapshot never requested')
    await page.locator(tid('actual-totals')).waitFor()
    await h.sleep(500)
    await h.check('a.net-worth-pending', 'S', async () => (await page.locator(tid('net-worth-pending')).count()) === 1 || 'no net-worth-pending')
    await h.check('a.projection-rows', 'S', async () => {
      const rows = await page.locator(`${tid('projection')} > div`).count()
      return rows === 4 || `${rows} projection rows`
    })
    await h.check('a.net-worth-busy', 'B', () => heldBusy(netWorthGroup(page)))
    await h.check('a.projection-busy', 'B', () => heldBusy(projectionGroup(page)))
    await h.check('a.no-empty-payables', 'B', async () =>
      (await h.expectAbsentFor(page, page.getByText('No upcoming payables in the next 30 days.'), 750)) || 'empty payables text shown while held')
    g.release({ disarm: true })
    await page.locator(tid('net-worth')).waitFor()
    await h.waitQuiet(page)
    const snap = await snapshotOf(u)
    const balance = rowOf(snap.balances.by_currency, 'PHP')
    const texts = await h.readTexts(page)
    await h.check('a.net-worth-never-zero', 'B', async () => !shownTexts(texts, 'net-worth').includes(peso(0)) || `net-worth history ${JSON.stringify(shownTexts(texts, 'net-worth'))}`)
    await h.check('a.available-never-zero', 'B', async () => !shownTexts(texts, 'available-cash').includes(peso(0)) || `available-cash history ${JSON.stringify(shownTexts(texts, 'available-cash'))}`)
    await h.check('a.count-never-zero', 'B', async () => !shownTexts(texts, 'payables-count').includes('0') || `payables-count history ${JSON.stringify(shownTexts(texts, 'payables-count'))}`)
    await h.check('a.empty-never-shown', 'B', async () => (await h.expectAbsentFor(page, page.getByText('No upcoming payables in the next 30 days.'), 750)) || 'empty payables text after release')
    await h.check('a.final-values', 'B', async () => {
      const shown = [await textOf(page.locator(tid('net-worth'))), await textOf(page.locator(tid('available-cash'))), await textOf(page.locator(tid('payables-count')))]
      const expected = [peso(balance.total), peso(balance.available_cash), String(snap.payables.length)]
      return JSON.stringify(shown) === JSON.stringify(expected) || `shown ${JSON.stringify(shown)} api ${JSON.stringify(expected)}`
    })
    await h.check('a.net-worth-settled', 'B', () => settledBusy(netWorthGroup(page)))
    await h.check('a.projection-settled', 'B', () => settledBusy(projectionGroup(page)))
    await h.check('a.projection-complete', 'S', async () => ((await page.locator(`${tid('projection')} > div`).count()) === 4) || 'projection did not settle on 4 rows')
    void requests
  } finally {
    g?.release({ disarm: true })
    await ctx.close()
  }
}

// (b) The period summary is held: the actual totals never read zero.
async function scenarioB(browser) {
  console.log('\n=== (b) summary held: actual totals never flash zero')
  const u = await seed('b')
  // The page clock is pinned to Manila midday of the seeded day (04:00Z). The dashboard's
  // period window ends at the real instant `now`, so between Manila 00:00 and 08:00 a row
  // dated Manila today (00:00Z) falls after it and the API sums it as 0. That is an app gap
  // (STU-466), not this scenario's concern; the pin keeps the run independent of the wall clock.
  const { ctx, page, requests } = await openPage(browser, { clockAt: `${today}T04:00:00Z` })
  let g
  try {
    g = await h.gate(page, isSummary)
    await h.uiLogin(page, stack, u)
    await h.check('b.page-day-is-seeded-day', 'S', async () => {
      const day = await h.localDay(page)
      return day === today || `page day ${day}, seeded day ${today}`
    })
    await h.check('b.summary-held', 'S', async () => (await g.waitHits(1)) || 'summary never requested')
    await page.locator(tid('net-worth')).waitFor()
    await h.sleep(500)
    await h.check('b.totals-pending', 'S', async () => (await page.locator(tid('period-income-pending')).count()) === 1 || 'no period-income-pending')
    await h.check('b.totals-busy', 'B', () => heldBusy(totalsGroup(page)))
    g.release({ disarm: true })
    await page.locator(tid('period-income')).waitFor()
    await h.waitQuiet(page)
    const texts = await h.readTexts(page)
    await h.check('b.totals-settled', 'B', () => settledBusy(totalsGroup(page)))
    for (const id of ['period-income', 'period-expenses', 'period-net-flow']) {
      await h.check(`b.${id}-never-zero`, 'B', async () => !shownTexts(texts, id).includes(peso(0)) || `${id} history ${JSON.stringify(shownTexts(texts, id))}`)
    }
    await h.check('b.final-values', 'B', async () => {
      const expected = await summaryFor(u, requests)
      if (!expected) return 'no summary request to replay'
      const shown = [await textOf(page.locator(tid('period-income'))), await textOf(page.locator(tid('period-expenses'))), await textOf(page.locator(tid('period-net-flow')))]
      return (JSON.stringify(shown) === JSON.stringify(expected) && expected[0] !== peso(0)) || `shown ${JSON.stringify(shown)} api ${JSON.stringify(expected)}`
    })
  } finally {
    g?.release({ disarm: true })
    await ctx.close()
  }
}

// (c) Allocations are held: no empty envelope text, no zero badge.
async function scenarioC(browser) {
  console.log('\n=== (c) allocations held: envelopes never flash empty or zero')
  const u = await seed('c')
  const { ctx, page } = await openPage(browser)
  let g
  try {
    g = await h.gate(page, isAllocations)
    await h.uiLogin(page, stack, u)
    await h.check('c.allocations-held', 'S', async () => (await g.waitHits(1)) || 'allocations never requested')
    await page.locator(tid('net-worth')).waitFor()
    await h.sleep(500)
    await h.check('c.envelopes-pending', 'S', async () => (await page.locator(tid('envelopes-pending')).count()) === 1 || 'no envelopes-pending')
    await h.check('c.no-empty-envelopes', 'B', async () =>
      (await h.expectAbsentFor(page, page.getByText('No active budget envelopes yet.'), 750)) || 'empty envelope text shown while held')
    await h.check('c.badge-not-zero', 'B', async () => {
      const badge = page.locator('[data-onboarding="budget-envelopes"] .badge')
      return (await h.expectAbsentFor(page, badge.filter({ hasText: /^0$/ }), 750)) || 'badge read 0 while held'
    })
    g.release({ disarm: true })
    await page.locator('[data-onboarding="budget-envelopes"] .badge').waitFor()
    await h.waitQuiet(page)
    await h.check('c.final-badge', 'B', async () => {
      const api = await client.get(u.token, '/allocations/?limit=1000&offset=0')
      const expected = String(api.items.filter((a) => a.allocation_type === 'budget' && a.is_active).length)
      const shown = await textOf(page.locator('[data-onboarding="budget-envelopes"] .badge'))
      return shown === expected || `shown ${shown} api ${expected}`
    })
  } finally {
    g?.release({ disarm: true })
    await ctx.close()
  }
}

// (f) Budget entries are held: no payable reads "Pay manually" until its autopay flag is known.
async function scenarioF(browser) {
  console.log('\n=== (f) budget entries held: no payable reads "Pay manually" before the flag lands')
  const u = await seed('f')
  const { ctx, page } = await openPage(browser)
  let g
  try {
    g = await h.gate(page, isEntries)
    await h.uiLogin(page, stack, u)
    await h.check('f.entries-held', 'S', async () => (await g.waitHits(1)) || 'budget entries never requested')
    await page.locator(tid('net-worth')).waitFor()
    await h.sleep(500)
    await h.check('f.payables-pending', 'S', async () => (await page.locator(tid('payables-pending')).count()) === 1 || 'no payables-pending')
    await h.check('f.no-manual-while-held', 'B', async () => {
      const labels = await page.locator(tid('payable-status')).evaluateAll((els) => els.map((e) => e.getAttribute('aria-label')))
      return !labels.includes('Pay manually') || `labels while held ${JSON.stringify(labels)}`
    })
    g.release({ disarm: true })
    await page.locator(tid('payable-status')).first().waitFor()
    await h.waitQuiet(page)
    await h.check('f.row-reads-autopay', 'B', async () => {
      const labels = await page.locator(tid('payable-status')).evaluateAll((els) => els.map((e) => e.getAttribute('aria-label')))
      return labels.includes('Autopay') || `labels ${JSON.stringify(labels)}`
    })
    const texts = await h.readTexts(page)
    await h.check('f.history-never-manual', 'B', async () => {
      const labels = (texts['payable-status'] || { attrs: {} }).attrs['aria-label'] || []
      return !labels.includes('Pay manually') || `aria-label history ${JSON.stringify(labels)}`
    })
  } finally {
    g?.release({ disarm: true })
    await ctx.close()
  }
}

// (d) The profile says USD, every account is PHP, the snapshot is held: nothing reads in USD.
async function scenarioD(browser) {
  console.log('\n=== (d) snapshot held with a USD profile: no USD figure and no "No USD cash" line')
  const u = await seed('d')
  const { ctx, page } = await openPage(browser)
  let g, me
  try {
    me = await h.rewrite(page, isGet('/auth/me'), (json) => ({ ...json, default_currency: 'USD' }))
    g = await h.gate(page, isSnapshot)
    await h.uiLogin(page, stack, u)
    await h.check('d.snapshot-held', 'S', async () => (await g.waitHits(1)) || 'snapshot never requested')
    await h.check('d.profile-rewritten', 'S', async () => me.hits >= 1 || 'no /auth/me response was rewritten')
    await page.locator(tid('actual-totals')).waitFor()
    const timelineLine = page.getByText('No USD cash is projected in this window.')
    await h.sleep(750)
    await h.check('d.timeline-pending', 'S', async () => (await page.locator(tid('timeline-pending')).count()) === 1 || 'no timeline-pending while held')
    await h.check('d.no-usd-timeline-while-held', 'B', async () => (await h.expectAbsentFor(page, timelineLine, 750)) || 'timeline said "No USD cash" while held')
    g.release({ disarm: true })
    await page.locator(tid('net-worth')).waitFor()
    await h.waitQuiet(page)
    await h.check('d.no-usd-timeline-after', 'B', async () => (await h.expectAbsentFor(page, timelineLine, 1500)) || 'timeline said "No USD cash" after release')
    const texts = await h.readTexts(page)
    for (const id of ['net-worth', 'available-cash', 'period-income', 'period-expenses', 'period-net-flow']) {
      await h.check(`d.${id}-no-dollar`, 'B', async () => !shownTexts(texts, id).some((t) => t.includes('$')) || `${id} history ${JSON.stringify(shownTexts(texts, id))}`)
    }
    await h.check('d.final-values', 'B', async () => {
      const balance = rowOf((await snapshotOf(u)).balances.by_currency, 'PHP')
      const shown = [await textOf(page.locator(tid('net-worth'))), await textOf(page.locator(tid('available-cash')))]
      const expected = [peso(balance.total), peso(balance.available_cash)]
      return JSON.stringify(shown) === JSON.stringify(expected) || `shown ${JSON.stringify(shown)} api ${JSON.stringify(expected)}`
    })
  } finally {
    g?.release({ disarm: true })
    await me?.stop()
    await ctx.close()
  }
}

// (g) The snapshot and allocations fail once on the first load; Retry refetches just those two.
// (g2) The snapshot fails twice: the screen comes back after the first Retry and the second loads.
async function retryRun(browser, name, snapshotFailures) {
  const u = await seed(name)
  const { ctx, page, requests } = await openPage(browser)
  let snapFail, allocFail
  try {
    snapFail = await h.failWith(page, isSnapshot, 500, { times: snapshotFailures })
    allocFail = await h.failWith(page, isAllocations, 500, { times: 1 })
    await h.uiLogin(page, stack, u)
    const retry = page.getByRole('button', { name: 'Retry', exact: true })
    await h.check(`${name}.error-screen`, 'B', async () => {
      await retry.waitFor({ timeout: 5000 })
      return (await page.getByText('Error Loading Data').count()) === 1 || 'no error screen'
    })
    await h.check(`${name}.retry-testid`, 'S', async () => (await page.locator(tid('dashboard-retry')).count()) === 1 || 'no dashboard-retry testid')
    await h.waitQuiet(page)
    await page.evaluate(() => { window.__stu335Marker = 1 })
    const count = (pred) => requests.filter(pred).length
    const asSnapshot = (r) => r.method === 'GET' && new URL(r.url).pathname.endsWith('/dashboard/snapshot')
    const asAllocations = (r) => r.method === 'GET' && new URL(r.url).pathname.endsWith('/allocations/')
    const marked = () => page.evaluate(() => window.__stu335Marker === 1)
    const before = { snapshot: count(asSnapshot), allocations: count(asAllocations), total: requests.length }
    await retry.click()
    if (snapshotFailures === 1) {
      await page.locator(tid('net-worth')).waitFor({ timeout: 8000 }).catch(() => {})
      await h.waitQuiet(page)
      await h.sleep(750)
      const snap = await snapshotOf(u)
      const balance = rowOf(snap.balances.by_currency, 'PHP')
      await h.check(`${name}.marker-survives`, 'B', async () => (await marked()) || 'the page reloaded (marker gone)')
      await h.check(`${name}.one-more-each`, 'B', async () => {
        const got = { snapshot: count(asSnapshot) - before.snapshot, allocations: count(asAllocations) - before.allocations }
        return (got.snapshot === 1 && got.allocations === 1) || `extra requests ${JSON.stringify(got)}`
      })
      await h.check(`${name}.only-failed-queries`, 'B', async () => {
        const after = requests.slice(before.total)
        const other = after.filter((r) => /\/transactions\/summary\/period|\/budget-entries\/|\/auth\/me/.test(new URL(r.url).pathname))
        return other.length === 0 || `refetched ${JSON.stringify(other.map((r) => `${r.method} ${new URL(r.url).pathname}`))}`
      })
      await h.check(`${name}.values`, 'B', async () => {
        const api = await client.get(u.token, '/allocations/?limit=1000&offset=0')
        const badge = String(api.items.filter((a) => a.allocation_type === 'budget' && a.is_active).length)
        const shown = [await textOf(page.locator(tid('net-worth'))), await textOf(page.locator('[data-onboarding="budget-envelopes"] .badge'))]
        const expected = [peso(balance.total), badge]
        return JSON.stringify(shown) === JSON.stringify(expected) || `shown ${JSON.stringify(shown)} api ${JSON.stringify(expected)}`
      })
    } else {
      const until = Date.now() + 5000
      while (snapFail.failed < snapshotFailures && Date.now() < until) await h.sleep(50)
      await retry.waitFor({ timeout: 5000 }).catch(() => {})
      await h.check(`${name}.screen-returns`, 'B', async () => (await retry.count()) === 1 || 'error screen did not return after the first Retry')
      await h.check(`${name}.marker-survives-first`, 'B', async () => (await marked()) || 'the page reloaded on the first Retry')
      await h.waitQuiet(page)
      await retry.click()
      await page.locator(tid('net-worth')).waitFor({ timeout: 8000 }).catch(() => {})
      await h.waitQuiet(page)
      const balance = rowOf((await snapshotOf(u)).balances.by_currency, 'PHP')
      await h.check(`${name}.second-retry-loads`, 'B', async () => {
        const shown = await textOf(page.locator(tid('net-worth')))
        return shown === peso(balance.total) || `net-worth "${shown}", api ${peso(balance.total)}`
      })
      await h.check(`${name}.marker-survives`, 'B', async () => (await marked()) || 'the page reloaded')
    }
  } finally {
    await snapFail?.stop()
    await allocFail?.stop()
    await ctx.close()
  }
}
const scenarioG = (browser) => (console.log('\n=== (g) Retry refetches only the failed queries, with no reload'), retryRun(browser, 'g', 1))
const scenarioG2 = (browser) => (console.log('\n=== (g2) a Retry that fails again brings the screen back; the next one loads'), retryRun(browser, 'g2', 2))

// An envelope row, found by structure so the scenario also runs where the row has no test id.
const ENVELOPE_ROW = '[data-onboarding="budget-envelopes"] .space-y-5 > .space-y-3'

// (h) The snapshot is held while allocations land: no envelope row, no numeric badge. Once
// it lands, FxNotice and the card charges appear with the envelopes in one render, so the
// first envelope row does not move.
async function scenarioH(browser) {
  console.log('\n=== (h) snapshot held, allocations landed: envelopes wait, then do not move')
  const u = await seed('h')
  const visa = await client.post(u.token, '/accounts/', {
    name: 'Visa h', account_type: 'credit', balance: 0, currency: 'PHP',
    billing_cycle_start: 24, days_until_due_date: 21, payment_account_id: u.bank.id,
  })
  await client.post(u.token, '/budget-entries/', {
    entry_type: 'expense', currency: 'PHP', cadence: 'monthly', name: 'Netflix h', amount: 549, account_id: visa.id,
    next_occurrence: wire(addDays(today, 5)),
  })
  await client.post(u.token, '/budget-entries/', {
    entry_type: 'expense', currency: 'JPY', cadence: 'monthly', name: 'Yen app h', amount: 1000, account_id: visa.id,
    next_occurrence: wire(addDays(today, 8)),
  })
  const { ctx, page } = await openPage(browser)
  // The envelope row's page-top at its first appearance, and at every later frame.
  await page.addInitScript((sel) => {
    const seen = { first: null, tops: [] }
    window.__stu335Env = seen
    const top = () => {
      const el = document.querySelector(sel)
      return el ? Math.round((el.getBoundingClientRect().top + window.scrollY) * 10) / 10 : null
    }
    const tick = () => {
      const t = top()
      if (t !== null) {
        if (seen.first === null) seen.first = t
        seen.tops.push(t)
      }
      requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
  }, ENVELOPE_ROW)
  let g
  try {
    g = await h.gate(page, isSnapshot)
    const allocationsSeen = page.waitForResponse((r) => r.request().method() === 'GET' && pathIs('/allocations/')(r.request()))
    await h.uiLogin(page, stack, u)
    await h.check('h.snapshot-held', 'S', async () => (await g.waitHits(1)) || 'snapshot never requested')
    await allocationsSeen
    await page.locator(tid('actual-totals')).waitFor()
    await h.sleep(750)
    await h.check('h.envelopes-pending', 'S', async () => (await page.locator(tid('envelopes-pending')).count()) === 1 || 'no envelopes-pending while held')
    await h.check('h.no-envelope-row-while-held', 'B', async () => (await page.locator(ENVELOPE_ROW).count()) === 0 || 'an envelope row showed while the snapshot was held')
    await h.check('h.no-badge-while-held', 'B', async () => (await page.locator('[data-onboarding="budget-envelopes"] .badge').count()) === 0 || 'a numeric badge showed while the snapshot was held')
    g.release({ disarm: true })
    await page.locator(ENVELOPE_ROW).first().waitFor()
    await h.sleep(500)
    await h.waitQuiet(page)
    const env = await page.evaluate(() => window.__stu335Env)
    await h.check('h.first-row-does-not-move', 'B', async () => {
      const last = env.tops[env.tops.length - 1]
      return Math.abs(last - env.first) <= 1 || `first row top ${env.first}, later ${last}, history ${JSON.stringify([...new Set(env.tops)])}`
    })
    const snap = await snapshotOf(u)
    await h.check('h.unconverted-banner-matches-api', 'G', async () => {
      const expected = snap.fx.unconverted_count > 0 ? 1 : 0
      const shown = await page.locator(tid('unconverted-banner')).count()
      return shown === expected || `banner ${shown}, api unconverted_count ${snap.fx.unconverted_count}`
    })
    await h.check('h.card-charges-match-api', 'G', async () => {
      const shown = await page.locator(tid('card-charges-name')).allTextContents()
      const expected = snap.card_charges.map((c) => c.account_name)
      return JSON.stringify(shown.map((t) => t.trim())) === JSON.stringify(expected) || `shown ${JSON.stringify(shown)} api ${JSON.stringify(expected)}`
    })
    await h.check('h.card-charges-present', 'S', async () => (await page.locator(tid('card-charges-name')).count()) >= 1 || 'no card charges rendered')
  } finally {
    g?.release({ disarm: true })
    await ctx.close()
  }
}

const SCENARIOS = [
  ['a', scenarioA],
  ['b', scenarioB],
  ['c', scenarioC],
  ['f', scenarioF],
  ['d', scenarioD],
  ['g', scenarioG],
  ['g2', scenarioG2],
  ['h', scenarioH],
]

;(async () => {
  // A stray rejection from a failed scenario is reported, never a crash without RESULT.
  process.on('unhandledRejection', (e) => console.log(`  NOTE unhandled rejection: ${e && e.message ? e.message.split('\n')[0] : e}`))
  stack = await startLocalStack()
  client = h.apiClient(stack)
  today = manilaToday()
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
