// Browser checks for STU-335 PR 2's Household polish (plan 3.6 Q7, scenarios in 5.2): the
// title waits for the views instead of flipping from "Household" to the sharer's name, and
// the Transactions tab waits for the dashboard's account names before it lists rows.
// Starts its own API and web app against a throwaway database (./_local_stack.cjs) and
// seeds through the API; every expected figure is read from the API. Not wired into CI and
// not part of `pnpm build`. Run steps: see ./README.md.
//
// Check kinds: [B] behavioural, [S] structural (a failed one makes the run invalid),
// [G] guard (holds at base and must keep holding). The script ends with RESULT: k/m and
// exits 0 only when every check passed, 1 when any failed, 2 for setup.
//
// Usage: node frontend/e2e/smooth-household.cjs [scenario]
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

let stack, client

const tid = (id) => `[data-testid="${id}"]`
const isViews = (r) => r.method() === 'GET' && new URL(r.url()).pathname.endsWith('/household/')

/** Owner A and recipient B: A shares the Household tag with B. */
async function seedShare(tag) {
  const a = await h.makeUser(stack, `${tag}-a`)
  const b = await h.makeUser(stack, `${tag}-b`)
  await client.post(a.token, '/tags/household/shares', { email: b.email })
  const views = await client.get(b.token, '/household/')
  const theirs = views.find((v) => !v.is_self)
  if (!theirs) throw new Error(`STOP: B has no Household view of A: ${JSON.stringify(views)}`)
  return { a, b, sharerId: theirs.sharer_id, title: `${theirs.sharer_name}'s Household` }
}

async function openPage(browser) {
  const { ctx, page } = await h.newPage(browser)
  page.setDefaultTimeout(10000)
  await h.recordTexts(page, ['household-title'])
  return { ctx, page }
}

// (a) The views are held: the title is a placeholder, never "Household" and then the name.
async function scenarioA(browser) {
  console.log('\n=== (a) views held: the title never reads "Household" before the sharer\'s name')
  const w = await seedShare('hh-a')
  const { ctx, page } = await openPage(browser)
  let g
  try {
    g = await h.gate(page, isViews)
    await h.uiLogin(page, stack, w.b)
    await page.goto(`${stack.webUrl}/accounts/household`)
    await h.check('a.views-held', 'S', async () => (await g.waitHits(1)) || 'views never requested')
    await h.sleep(750)
    await h.check('a.title-pending', 'S', async () => (await page.locator(tid('household-title-pending')).count()) === 1 || 'no household-title-pending while held')
    await h.check('a.no-title-while-held', 'B', async () => (await page.locator(tid('household-title')).count()) === 0 || 'household-title shown while held')
    g.release({ disarm: true })
    await page.locator(tid('household-title')).waitFor()
    await h.waitQuiet(page)
    const texts = (await h.readTexts(page))['household-title'].texts
    await h.check('a.history-is-the-name', 'B', async () => JSON.stringify(texts) === JSON.stringify([w.title]) || `title history ${JSON.stringify(texts)}, api ${JSON.stringify(w.title)}`)
    await h.check('a.pending-gone', 'B', async () => (await page.locator(tid('household-title-pending')).count()) === 0 || 'placeholder still shown')
  } finally {
    g?.release({ disarm: true })
    await ctx.close()
  }
}

// (a2) The views fail: the existing "Household" fallback and the alert.
async function scenarioA2(browser) {
  console.log('\n=== (a2) views fail: the "Household" title and an alert')
  const w = await seedShare('hh-a2')
  const { ctx, page } = await openPage(browser)
  let f
  try {
    f = await h.failWith(page, isViews, 500)
    await h.uiLogin(page, stack, w.b)
    await page.goto(`${stack.webUrl}/accounts/household`)
    await page.getByRole('alert').first().waitFor()
    await h.waitQuiet(page)
    await h.check('a2.fallback-title', 'G', async () => {
      const shown = ((await page.locator(tid('household-title')).textContent().catch(() => null)) || '').trim()
      return shown === 'Household' || `title "${shown}"`
    })
    await h.check('a2.alert', 'G', async () => (await page.getByRole('alert').count()) >= 1 || 'no alert')
    await h.check('a2.no-endless-placeholder', 'G', async () => (await page.locator(tid('household-title-pending')).count()) === 0 || 'placeholder still shown after the failure')
  } finally {
    await f?.stop()
    await ctx.close()
  }
}

const isDashboard = (r) => r.method() === 'GET' && /\/household\/\d+\/dashboard$/.test(new URL(r.url()).pathname)

/** A shares a Household-tagged account with one transaction; B holds it as an editor, so B reads the record in full. */
async function seedFull(tag) {
  const w = await seedShare(tag)
  const name = `Joint ${tag}`
  const account = await client.post(w.a.token, '/accounts/', { name, account_type: 'checking', balance: 50000, currency: 'PHP' })
  const household = (await client.get(w.a.token, '/tags/')).find((t) => t.is_system)
  if (!household) throw new Error('STOP: A has no Household system tag')
  await client.put(w.a.token, `/accounts/${account.id}`, { tag_ids: [household.id] })
  await client.post(w.a.token, `/accounts/${account.id}/shares`, { email: w.b.email, role: 'editor' })
  await client.post(w.a.token, '/transactions/', {
    account_id: account.id, transaction_type: 'debit', amount: 321, description: `Groceries ${tag}`,
    transaction_date: `${new Date().toISOString().slice(0, 10)}T00:00:00`, is_posted: true,
  })
  const listed = await client.get(w.b.token, `/household/${w.sharerId}/transactions?limit=20&offset=0`)
  const row = listed.items[0]
  if (!row || row.view === 'limited') throw new Error(`STOP: B does not read the record in full: ${JSON.stringify(row)}`)
  const dashboard = await client.get(w.b.token, `/household/${w.sharerId}/dashboard`)
  if (!dashboard.accounts.some((a) => a.name === name)) throw new Error(`STOP: the dashboard lacks ${name}: ${JSON.stringify(dashboard.accounts)}`)
  return { ...w, name }
}

/** Opens B's view of A's Household on the Transactions tab with the dashboard request intercepted by `setup`. */
async function openTransactionsTab(browser, w, setup) {
  const { ctx, page } = await h.newPage(browser)
  page.setDefaultTimeout(10000)
  await h.recordTexts(page, ['household-transaction'])
  const handle = await setup(page)
  await h.uiLogin(page, stack, w.b)
  await page.goto(`${stack.webUrl}/accounts/household?sharer=${w.sharerId}`)
  // The dashboard tab opens first and its request is the one set up; settle it, then open the tab.
  await page.locator(tid('household-tab-transactions')).waitFor()
  await h.waitQuiet(page)
  await page.locator(tid('household-tab-transactions')).click()
  return { ctx, page, handle }
}

// (b) The dashboard is held (on the request the Transactions tab makes): no row until the account names are there.
async function scenarioB(browser) {
  console.log('\n=== (b) dashboard held: no transaction row until its account name can be shown')
  const w = await seedFull('hh-b')
  const { ctx, page, handle: g } = await openTransactionsTab(browser, w, async (p) => {
    // The dashboard tab's own request fails once, so opening the Transactions tab asks again: that second request is the one held.
    const held = await h.gate(p, isDashboard)
    const first = await h.failWith(p, isDashboard, 500, { times: 1 })
    return {
      get hits() { return held.hits },
      waitHits: (n, ms) => held.waitHits(n, ms),
      release: (o) => held.release(o),
      async stop() { await first.stop(); await held.stop() },
    }
  })
  try {
    await h.check('b.dashboard-held', 'S', async () => (await g.waitHits(1)) || 'dashboard never requested')
    await page.locator(tid('household-transactions')).waitFor()
    await h.sleep(750)
    await h.check('b.loading-shown', 'S', async () => (await page.locator(tid('household-transactions-loading')).count()) === 1 || 'no household-transactions-loading while held')
    await h.check('b.no-rows-while-held', 'B', async () => (await page.locator(tid('household-transaction')).count()) === 0 || 'a transaction row showed while the names were held')
    g.release({ disarm: true })
    await page.locator(tid('household-transaction')).first().waitFor()
    await h.waitQuiet(page)
    const texts = (await h.readTexts(page))['household-transaction'].texts
    await h.check('b.rows-listed', 'S', async () => texts.length > 0 || 'no row text recorded')
    await h.check('b.every-text-has-the-name', 'B', async () => texts.every((t) => t.includes(w.name)) || `row text history ${JSON.stringify(texts)}, account ${w.name}`)
    await h.check('b.loading-gone', 'B', async () => (await page.locator(tid('household-transactions-loading')).count()) === 0 || 'skeleton still shown')
  } finally {
    g.release({ disarm: true })
    await g.stop()
    await ctx.close()
  }
}

// (c1) guard / (c2) The dashboard fails: the rows still render (c1), with a note that the
// account names could not be loaded (c2).
async function failedNames(browser, id, title, checks) {
  console.log(`\n=== (${id}) ${title}`)
  const w = await seedFull(`hh-${id}`)
  const { ctx, page, handle: f } = await openTransactionsTab(browser, w, (p) => h.failWith(p, isDashboard, 500))
  try {
    await page.locator(tid('household-transaction')).first().waitFor()
    await h.waitQuiet(page)
    await checks(page)
  } finally {
    await f?.stop()
    await ctx.close()
  }
}
const scenarioC1 = (browser) => failedNames(browser, 'c1', 'dashboard fails: the rows still render', async (page) => {
  await h.check('c1.rows-render', 'G', async () => (await page.locator(tid('household-transaction')).count()) >= 1 || 'no rows after the dashboard failed')
  await h.check('c1.no-endless-loading', 'G', async () => (await page.locator(tid('household-transactions-loading')).count()) === 0 || 'skeleton still shown after the failure')
})
const scenarioC2 = (browser) => failedNames(browser, 'c2', 'dashboard fails: a note says the names are missing', async (page) => {
  await h.check('c2.names-error', 'B', async () => {
    const shown = ((await page.locator(tid('household-names-error')).textContent().catch(() => null)) || '').trim()
    return shown === 'Account names could not be loaded.' || `household-names-error "${shown}"`
  })
})

const SCENARIOS = [
  ['a', scenarioA],
  ['a2', scenarioA2],
  ['b', scenarioB],
  ['c1', scenarioC1],
  ['c2', scenarioC2],
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
