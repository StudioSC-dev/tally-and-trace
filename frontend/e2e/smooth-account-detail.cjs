// Browser checks for STU-335 on the account detail page (plan 4 and 5.2, account-detail
// (a), (b1), (b2)): the transaction rows wait for the account and category names, so a
// transfer never reads "Other account" and a category never reads "Uncategorized" before
// the real name lands, and a failed names lookup shows rows with the fallbacks and a
// note. Starts its own API and web app against a throwaway database
// (./_local_stack.cjs) and seeds through the API; every expected value is read from the
// API. Not wired into CI and not part of `pnpm build`. Run steps: see ./README.md.
//
// Check kinds: [B] behavioural, [S] structural (a failed one makes the run invalid),
// [G] guard (holds at base and must keep holding). The script ends with RESULT: k/m and
// exits 0 only when every check passed, 1 when any failed, 2 for setup.
//
// Usage: node frontend/e2e/smooth-account-detail.cjs [scenario]
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

const FALLBACK_COUNTERPART = 'Other account'
const FALLBACK_CATEGORY = 'Uncategorized'

let stack, client, owner, checking, savings, category, card

const tid = (id) => `[data-testid="${id}"]`
const wire = (day) => `${day}T00:00:00`
const daysFromNow = (n) => daysAgo(-n)
const daysAgo = (n) => {
  const d = new Date(Date.now() + 8 * 3600 * 1000)
  d.setUTCDate(d.getUTCDate() - n)
  return d.toISOString().slice(0, 10)
}
/** A YYYY-MM-DD date `n` days before `day`. */
const before = (day, n) => {
  const d = new Date(`${day}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() - n)
  return d.toISOString().slice(0, 10)
}

/** The names lookup the page makes: `GET /accounts/?limit=1000` (not `/accounts/<id>`). */
const isAccountList = (r) => {
  if (r.method() !== 'GET') return false
  const url = new URL(r.url())
  return url.pathname.endsWith('/accounts/') && url.searchParams.get('limit') === '1000'
}

/** A fresh signed-in page that records whether either fallback text ever appeared in the body. */
async function openPage(browser) {
  const { ctx, page } = await h.newPage(browser)
  page.setDefaultTimeout(10000)
  await page.addInitScript((phrases) => {
    const seen = {}
    window.__detailSeen = seen
    const scan = () => {
      const text = document.body ? document.body.textContent || '' : ''
      for (const p of phrases) if (text.includes(p)) seen[p] = true
    }
    const start = () => {
      new MutationObserver(scan).observe(document.documentElement, { childList: true, subtree: true, characterData: true })
      scan()
    }
    if (document.documentElement) start()
    else document.addEventListener('DOMContentLoaded', start, { once: true })
  }, [FALLBACK_COUNTERPART, FALLBACK_CATEGORY])
  await h.uiLogin(page, stack, owner)
  return { ctx, page }
}

const seenFallbacks = (page) => page.evaluate(() => Object.keys(window.__detailSeen || {}))

const rows = (page) => page.locator(tid('account-transaction'))

// (a) Rows wait for the account names: the transfer's counterpart is never "Other account".
async function scenarioA(browser) {
  console.log('\n=== (a) account names held: rows wait, the counterpart never reads "Other account"')
  const { ctx, page } = await openPage(browser)
  let gate = null
  try {
    gate = await h.gate(page, isAccountList)
    await page.goto(`${stack.webUrl}/accounts/${checking.id}`)
    await h.check('a.held', 'S', async () => (await gate.waitHits(1)) || 'no /accounts/?limit=1000 request')
    await page.locator(tid('account-transactions')).waitFor()
    await h.sleep(800)
    await h.check('a.rows-wait', 'B', async () => {
      const n = await rows(page).count()
      return n === 0 || `${n} rows rendered while the names were held`
    })
    await h.check('a.names-pending-shown', 'B', async () =>
      (await page.locator(tid('account-transactions-names-pending')).isVisible()) || 'no account-transactions-names-pending while held')
    await h.check('a.loading-not-placeholder', 'B', async () => {
      const n = await page.locator(tid('account-transactions-loading')).count()
      return n === 0 || `account-transactions-loading on the names placeholder (${n})`
    })
    gate.release({ disarm: true })
    await rows(page).first().waitFor({ timeout: 5000 }).catch(() => null)
    await h.waitQuiet(page)
    await h.check('a.counterpart-matches-api', 'B', async () => {
      const text = ((await page.locator(tid('account-transaction-counterpart')).first().textContent().catch(() => null)) || '').trim()
      const expected = `To ${savings.name}`
      return text === expected || `shown "${text}" expected "${expected}"`
    })
    await h.check('a.category-matches-api', 'B', async () => {
      const shown = await page.getByText(category.name, { exact: true }).first().isVisible().catch(() => false)
      return shown || `category "${category.name}" is not shown`
    })
    await h.check('a.never-fallback', 'B', async () => {
      const seen = await seenFallbacks(page)
      return seen.length === 0 || `showed ${JSON.stringify(seen)}`
    })
  } finally {
    gate?.release({ disarm: true })
    await ctx.close()
  }
}

// (b1) guard and (b2): a failed names lookup still lists the rows, with fallbacks, and says so.
async function scenarioB(browser) {
  console.log('\n=== (b) account names fail: rows render with fallbacks and a note')
  const { ctx, page } = await openPage(browser)
  let fail = null
  try {
    fail = await h.failWith(page, isAccountList, 500)
    await page.goto(`${stack.webUrl}/accounts/${checking.id}`)
    await rows(page).first().waitFor({ timeout: 8000 }).catch(() => null)
    await h.waitQuiet(page)
    await h.check('b1.rows-render', 'G', async () => {
      const n = await rows(page).count()
      const { total } = await client.get(owner.token, `/transactions/?account_ids=${checking.id}&limit=1`).catch(() => ({ total: null }))
      return n > 0 || `no rows rendered (api total ${total}, failures ${fail.failed})`
    })
    await h.check('b1.fallback-name', 'G', async () => {
      const text = ((await page.locator(tid('account-transaction-counterpart')).first().textContent().catch(() => null)) || '').trim()
      return text === `To ${FALLBACK_COUNTERPART}` || `shown "${text}"`
    })
    await h.check('b2.names-error-note', 'B', async () => {
      const shown = await page.locator(tid('account-names-error')).waitFor({ timeout: 3000 }).then(() => true, () => false)
      return shown || 'no account-names-error note'
    })
  } finally {
    await fail?.stop()
    await ctx.close()
  }
}

// (d) The credit panel's loading card is shaped like the panel: the section below it holds still.
async function scenarioD(browser) {
  console.log('\n=== (d) credit held: the loading card holds the landed panel\'s place')
  const { ctx, page } = await openPage(browser)
  let gate = null
  try {
    gate = await h.gate(page, (r) => r.method() === 'GET' && new URL(r.url()).pathname.endsWith(`/cards/${card.id}/credit`))
    await page.goto(`${stack.webUrl}/accounts/${card.id}`)
    await h.check('d.held', 'S', async () => (await gate.waitHits(1)) || 'no credit detail request')
    const loading = page.locator(tid('card-credit-panel-loading'))
    await h.check('d.loading-shown', 'S', async () =>
      (await loading.waitFor({ timeout: 3000 }).then(() => true, () => false)) || 'no card-credit-panel-loading while held')
    await h.check('d.aria-busy', 'S', async () => {
      const busy = await loading.getAttribute('aria-busy').catch(() => null)
      return busy === 'true' || `aria-busy is ${busy}`
    })
    await h.sleep(300)
    const section = page.locator(tid('account-transactions'))
    const held = await section.boundingBox()
    const heldPanel = await loading.boundingBox()
    gate.release({ disarm: true })
    await page.locator(tid('card-credit-panel')).waitFor({ timeout: 5000 }).catch(() => null)
    await h.waitQuiet(page)
    const after = await section.boundingBox()
    const panel = await page.locator(tid('card-credit-panel')).boundingBox()
    if (process.env.DEBUG) {
      const parts = {}
      for (const id of ['card-pay-open', 'credit-summary', 'credit-available', 'credit-planned', 'credit-with-planned', 'credit-held', 'credit-incomplete', 'card-credit-opening', 'card-statement', 'card-open-cycle']) {
        parts[id] = await page.locator(tid(id)).first().boundingBox().catch(() => null)
      }
      console.log('  DEBUG held', JSON.stringify({ section: held, panel: heldPanel }), 'landed', JSON.stringify({ section: after, panel, parts }))
    }
    await h.check('d.panel-landed', 'S', async () => (panel !== null) || 'the landed panel did not show')
    await h.check('d.statement-present', 'S', async () => {
      const n = await page.locator(tid('card-statement')).count()
      return n >= 1 || 'no card-statement on the landed panel, so the seed has no closed statement'
    })
    await h.check('d.section-held-still', 'B', async () => {
      if (!held || !after) return 'no section box'
      return Math.abs(after.y - held.y) <= 8 || `section y ${held.y} while held, ${after.y} after (${Math.abs(after.y - held.y)} px)`
    })
  } finally {
    gate?.release({ disarm: true })
    await ctx.close()
  }
}

async function setup() {
  owner = await h.makeUser(stack, 'detail')
  checking = await client.post(owner.token, '/accounts/', { name: 'Detail Checking', account_type: 'checking', balance: 5000, currency: 'PHP' })
  savings = await client.post(owner.token, '/accounts/', { name: 'Detail Savings', account_type: 'savings', balance: 0, currency: 'PHP' })
  category = await client.post(owner.token, '/categories/', { name: 'Detail Groceries', color: '#16a34a', is_expense: true })
  await client.post(owner.token, '/transactions/', {
    account_id: checking.id, transaction_type: 'transfer', transfer_from_account_id: checking.id, transfer_to_account_id: savings.id,
    amount: 250, description: 'Detail transfer', transaction_date: wire(daysAgo(2)), is_posted: true,
  })
  // A card with one closed statement, an open cycle and a charge dated later, so the
  // landed panel shows the planned-charges line.
  // Defensive hardening, not a fix for an observed failure. The anchor is 10 days back so
  // the close day (the anchor's day, clamped to the 28th) is always 10-13 days ago, and the
  // posted charge is dated 3 days before it, clearly inside a closed statement with margin.
  // The backend cycle includes the close day itself, so a charge on it would also belong to
  // the closed statement. If the seed ever stopped producing a closed statement, the [S]
  // check d.statement-present makes the run invalid rather than silently passing.
  const anchor = daysAgo(10)
  const closeDom = Math.min(Number(anchor.slice(8, 10)), 28)
  const lastClose = `${anchor.slice(0, 8)}${String(closeDom).padStart(2, '0')}`
  const presets = await client.get(owner.token, '/accounts/minimum-due-presets')
  card = await client.post(owner.token, '/accounts/', {
    name: 'Detail Card', account_type: 'credit', balance: 0, currency: 'PHP', credit_limit: 50000,
    billing_cycle_start: closeDom, days_until_due_date: 21,
    minimum_due_rule: presets.find((p) => p.key === 'bdo').rule,
  })
  // A posted charge before the cycle closed, and an unposted one dated 3 days ahead.
  for (const [day, posted] of [[before(lastClose, 3), true], [daysFromNow(3), false]]) {
    await client.post(owner.token, '/transactions/', {
      account_id: card.id, transaction_type: 'debit', amount: 700, description: 'Detail card purchase',
      transaction_date: wire(day), is_posted: posted,
    })
  }
  await client.post(owner.token, '/transactions/', {
    account_id: checking.id, transaction_type: 'debit', amount: 90, category_id: category.id,
    description: 'Detail groceries', transaction_date: wire(daysAgo(3)), is_posted: true,
  })
}

const SCENARIOS = [
  ['a', scenarioA],
  ['b', scenarioB],
  ['d', scenarioD],
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
