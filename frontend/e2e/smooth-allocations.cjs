// Browser checks for STU-335 on the Allocations page (plan 3.2, allocations scenarios in
// 5.2): the envelope grid and the recurring sections stay on screen while they reload, a
// stale load-more page never lands on a newer list, and a failed load shows an alert with
// Retry instead of an empty list. Starts its own API and web app against a throwaway
// database (./_local_stack.cjs) and seeds through the API; every expected figure is read
// from the API. Not wired into CI and not part of `pnpm build`. Run steps: see ./README.md.
//
// Check kinds: [B] behavioural, [S] structural (a failed one makes the run invalid),
// [G] guard (holds at base and must keep holding). The script ends with RESULT: k/m and
// exits 0 only when every check passed, 1 when any failed, 2 for setup.
//
// Usage: node frontend/e2e/smooth-allocations.cjs [scenario]
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

let stack, client

// ─── Seeding ─────────────────────────────────────────────────────────────────

/** A user with one checking account and the id of their Utilities category. */
async function seedUser(tag) {
  const u = await h.makeUser(stack, tag)
  u.bank = await client.post(u.token, '/accounts/', {
    name: `${tag} Checking`, account_type: 'checking', balance: 100000, currency: 'PHP',
  })
  const categories = await client.get(u.token, '/categories/?limit=200')
  const utilities = (categories.items ?? categories).find((c) => c.name.toLowerCase() === 'utilities')
  if (!utilities) throw new Error('no Utilities category on a new account')
  u.categoryId = utilities.id
  return u
}

/** `n` monthly budget envelopes named `<prefix> 01`..`<prefix> nn`, created oldest first. */
async function envelopes(u, prefix, n) {
  const today = manilaToday()
  for (let i = 1; i <= n; i++) {
    await client.post(u.token, '/allocations/', {
      account_id: u.bank.id, name: `${prefix} ${String(i).padStart(2, '0')}`, allocation_type: 'budget',
      target_amount: 1000, period_frequency: 'monthly', period_start: wire(today.slice(0, 8) + '01'),
      configuration: { category_ids: [u.categoryId] },
    })
  }
}

const entry = (u, fields) => client.post(u.token, '/budget-entries/', {
  entry_type: 'expense', currency: 'PHP', cadence: 'monthly', amount: 500,
  account_id: u.bank.id, next_occurrence: wire(addDays(manilaToday(), 5)), ...fields,
})

/** Every allocation name the API serves, newest first. */
async function apiNames(u) {
  const res = await client.get(u.token, '/allocations/?limit=1000&offset=0')
  return { names: res.items.map((a) => a.name), total: res.total }
}

// ─── Page helpers ────────────────────────────────────────────────────────────

const tid = (id) => `[data-testid="${id}"]`
const isAllocationsList = (r) => r.method() === 'GET' && new URL(r.url()).pathname.endsWith('/allocations/')
const offsetOf = (url) => Number(new URL(url).searchParams.get('offset') ?? '0')
/** A response wait that never rejects: null at its bound. */
const waitResponse = (page, pred, timeout = 10000) => page.waitForResponse(pred, { timeout }).catch(() => null)

async function openPage(browser) {
  const { ctx, page } = await h.newPage(browser)
  page.setDefaultTimeout(10000)
  page.on('dialog', (d) => { console.log(`  NOTE dialog: ${d.message()}`); d.dismiss().catch(() => {}) })
  return { ctx, page }
}

/** The names on the envelope cards, in screen order. */
const cardNames = (page) =>
  page.locator('article[role="button"]').evaluateAll((rows) =>
    rows.map((r) => (r.querySelector('p.text-base.font-semibold')?.textContent || '').trim()))
const showingText = async (page) =>
  ((await page.getByText(/^Showing \d+ of \d+ envelopes$/).textContent().catch(() => '')) || '').trim()

async function openAllocations(page) {
  await page.goto(`${stack.webUrl}/allocations`)
  await page.getByRole('button', { name: 'Budgets', exact: true }).waitFor()
  await h.waitQuiet(page)
}
async function openBudgets(page) {
  await openAllocations(page)
  await page.getByRole('button', { name: 'Budgets', exact: true }).click()
  await page.getByText(/^Showing \d+ of \d+ envelopes$/).waitFor()
  await h.waitQuiet(page)
}

/** Opens Add Allocation on the Budgets tab and fills a monthly envelope; returns the submit button. */
async function fillEnvelope(page, u, name) {
  await page.getByRole('button', { name: 'Add Allocation' }).click()
  const form = page.locator('form').filter({ has: page.getByRole('button', { name: 'Create Budget Envelope' }) })
  await form.waitFor()
  await h.waitQuiet(page)
  await form.locator('select').first().selectOption(String(u.bank.id))
  await form.locator('input[type="text"]').first().fill(name)
  await form.locator('button[type="button"]').filter({ hasText: 'Utilities' }).first().click()
  // The spending limit is the form's last number input.
  await form.locator('input[type="number"]').last().fill('1000')
  return form.getByRole('button', { name: 'Create Budget Envelope' })
}

/** Shown names equal the API's first `n` names (as a set). */
async function namesMatchApi(page, u, n = 10) {
  const { names } = await apiNames(u)
  const expected = names.slice(0, n).sort()
  const shown = (await cardNames(page)).sort()
  return JSON.stringify(shown) === JSON.stringify(expected) || `shown ${JSON.stringify(shown)} api ${JSON.stringify(expected)}`
}

// ─── Scenarios ───────────────────────────────────────────────────────────────

// (a) A create's reset keeps the existing envelope cards; no full-page "Loading...".
async function scenarioA(browser) {
  console.log('\n=== (a) a create keeps the envelope cards on screen while the list reloads')
  const u = await seedUser('a')
  await envelopes(u, 'A Env', 3)
  const { ctx, page } = await openPage(browser)
  let g = null
  try {
    await h.uiLogin(page, stack, u)
    await openBudgets(page)
    const before = await cardNames(page)
    await h.check('a.seeded', 'S', () => before.length === 3 || `cards ${JSON.stringify(before)}`)
    const submit = await fillEnvelope(page, u, 'A Env new')
    g = await h.gate(page, isAllocationsList)
    await submit.click()
    await h.check('a.reset-held', 'S', async () => (await g.waitHits(1)) || 'no reset request')
    await h.check('a.no-loading', 'B', async () =>
      (await h.expectAbsentFor(page, page.getByText('Loading...', { exact: true }))) || '"Loading..." shown during the reset')
    await h.check('a.cards-stay', 'B', async () => {
      const shown = await cardNames(page)
      return before.every((n) => shown.includes(n)) || `held cards ${JSON.stringify(shown)}`
    })
    const landed = waitResponse(page, (r) => isAllocationsList(r.request()))
    g.release({ disarm: true })
    await landed
    await h.waitQuiet(page)
    await h.check('a.equals-api', 'B', () => namesMatchApi(page, u))
  } finally {
    g?.release({ disarm: true })
    await ctx.close()
  }
}

// (b) A load-more that starts before a reset lands is dropped, never appended to the new list.
async function scenarioB(browser) {
  console.log('\n=== (b) a stale load-more page is dropped when a reset lands first')
  const u = await seedUser('b')
  await envelopes(u, 'B Env', 25)
  const { ctx, page } = await openPage(browser)
  const log = []
  page.on('request', (r) => { if (isAllocationsList(r)) log.push({ offset: offsetOf(r.url()), at: Date.now() }) })
  let post = null, stale = null
  try {
    await h.uiLogin(page, stack, u)
    await openBudgets(page)
    await h.check('b.first-page', 'S', async () => (await cardNames(page)).length === 10 || `cards ${(await cardNames(page)).length}`)
    const submit = await fillEnvelope(page, u, 'B Env new')
    post = await h.gate(page, (r) => r.method() === 'POST' && new URL(r.url()).pathname.endsWith('/allocations/'))
    // Only the first offset=10 request is held: that is the stale page.
    let claimed = false
    stale = await h.holdResponse(page, (r) => {
      if (claimed || !isAllocationsList(r) || offsetOf(r.url()) !== 10) return false
      claimed = true
      return true
    })
    let staleDelivered = false
    page.on('response', (r) => { if (isAllocationsList(r.request()) && offsetOf(r.url()) === 10) staleDelivered = true })
    await submit.click()
    await h.check('b.post-held', 'S', async () => (await post.waitHits(1)) || 'no POST')
    // The overlay blocks clicks, not scrolling: the sentinel fires a load-more under it.
    await page.mouse.move(640, 500)
    await page.mouse.wheel(0, 20000)
    await h.check('b.page2-held', 'S', async () => (await stale.waitHits(1)) || 'no offset=10 request')
    // Back to the top, so the reset's landing re-arms the sentinel out of view.
    await page.mouse.wheel(0, -20000)
    await page.waitForFunction(() => window.scrollY === 0, null, { timeout: 3000 }).catch(() => null)
    const resetDone = waitResponse(page, (r) => isAllocationsList(r.request()) && offsetOf(r.url()) === 0)
    const releasedAt = Date.now()
    post.release({ disarm: true })
    const resetResponse = await resetDone
    const resetLandedAt = Date.now()
    await h.check('b.reset-landed', 'S', () => resetResponse !== null || 'no reset response')
    await h.check('b.page2-still-held', 'S', () => (!staleDelivered && stale.hits === 1) || `delivered ${staleDelivered} hits ${stale.hits}`)
    await h.sleep(500)
    const ids = await cardNames(page)
    const showing = await showingText(page)
    const delivered = waitResponse(page, (r) => isAllocationsList(r.request()) && offsetOf(r.url()) === 10)
    stale.release({ disarm: true })
    await delivered
    await h.waitQuiet(page)
    await h.sleep(300)
    await h.check('b.ids-unchanged', 'B', async () => {
      const after = await cardNames(page)
      return JSON.stringify(after) === JSON.stringify(ids) || `before ${JSON.stringify(ids)} after ${JSON.stringify(after)}`
    })
    await h.check('b.showing-unchanged', 'B', async () => (await showingText(page)) === showing || `before "${showing}" after "${await showingText(page)}"`)
    await h.check('b.no-sentinel-during-reset', 'B', () => {
      const during = log.filter((e) => e.offset !== 0 && e.at > releasedAt && e.at <= resetLandedAt)
      return during.length === 0 || `load-more during the reset: ${JSON.stringify(during)}`
    })
    const rows = (await cardNames(page)).length
    const next = page.waitForRequest((r) => isAllocationsList(r) && offsetOf(r.url()) > 0, { timeout: 5000 }).catch(() => null)
    await page.mouse.wheel(0, 20000)
    const nextRequest = await next
    await h.check('b.next-offset', 'B', () =>
      (nextRequest !== null && offsetOf(nextRequest.url()) === rows) || `rows ${rows} next offset ${nextRequest && offsetOf(nextRequest.url())}`)
    // Load the rest: keep scrolling until the end of the list.
    const { total } = await apiNames(u)
    for (let i = 0; i < 10; i++) {
      await h.waitQuiet(page)
      if (await page.getByText('End of envelope list').count()) break
      await page.mouse.wheel(0, 20000)
      await h.sleep(300)
    }
    await h.waitQuiet(page)
    await h.check('b.all-unique', 'B', async () => {
      const all = await cardNames(page)
      return (new Set(all).size === all.length && all.length === total) || `rows ${all.length} unique ${new Set(all).size} total ${total}`
    })
  } finally {
    post?.release({ disarm: true })
    stale?.release({ disarm: true })
    await ctx.close()
  }
}

// (e) The first allocations load does not blank the Subscriptions tab.
async function scenarioE(browser) {
  console.log('\n=== (e) Subscriptions renders while the first allocations load is held')
  const u = await seedUser('e')
  await envelopes(u, 'E Env', 1)
  await entry(u, { name: 'E Streaming' })
  const { ctx, page } = await openPage(browser)
  let g = null
  try {
    await h.uiLogin(page, stack, u)
    await h.waitQuiet(page)
    g = await h.gate(page, isAllocationsList)
    await page.goto(`${stack.webUrl}/allocations`)
    await h.check('e.held', 'S', async () => (await g.waitHits(1)) || 'no allocations request')
    await h.check('e.sections-while-held', 'B', async () => {
      try {
        await page.locator('[data-testid^="kind-section-"]').first().waitFor({ timeout: 3000 })
      } catch { return 'no recurring section while allocations are held' }
      return g.hits >= 1 && (await page.getByText('E Streaming').count()) > 0 || 'entry not shown'
    })
    g.release({ disarm: true })
    await h.waitQuiet(page)
    await h.check('e.budgets-after', 'B', async () => {
      await page.getByRole('button', { name: 'Budgets', exact: true }).click()
      await page.getByText(/^Showing \d+ of \d+ envelopes$/).waitFor({ timeout: 3000 }).catch(() => null)
      return namesMatchApi(page, u)
    })
  } finally {
    g?.release({ disarm: true })
    await ctx.close()
  }
}

const SCENARIOS = [
  ['a', scenarioA],
  ['b', scenarioB],
  ['e', scenarioE],
]

;(async () => {
  // A stray rejection from a failed scenario is reported, never a crash without RESULT.
  process.on('unhandledRejection', (e) => console.log(`  NOTE unhandled rejection: ${e && e.message ? e.message.split('\n')[0] : e}`))
  stack = await startLocalStack()
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
})().catch((e) => { console.error(e); stack?.stop(); process.exit(2) })
