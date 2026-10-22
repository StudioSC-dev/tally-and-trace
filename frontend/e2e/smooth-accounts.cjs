// Browser checks for STU-335 on the Accounts page (plan 3.2, accounts scenarios in 5.2):
// the list stays on screen while it reloads, and a failed load shows an alert with Retry,
// never the empty text. Starts its own API and web app against a
// throwaway database (./_local_stack.cjs) and seeds through the API; every expected figure
// is read from the API. Not wired into CI and not part of `pnpm build`. Run steps: see
// ./README.md.
//
// Check kinds: [B] behavioural, [S] structural (a failed one makes the run invalid),
// [G] guard (holds at base and must keep holding). The script ends with RESULT: k/m and
// exits 0 only when every check passed, 1 when any failed, 2 for setup.
//
// Usage: node frontend/e2e/smooth-accounts.cjs [scenario]
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

// The empty texts the list must never show while it has (or is about to have) rows.
const EMPTY_ALL = 'No accounts yet. Start by adding your first account.'
const EMPTY_TAG = 'No accounts have this tag.'

let stack, client, owner, tag, alpha, bravo

// ─── Page helpers ────────────────────────────────────────────────────────────

const tid = (id) => `[data-testid="${id}"]`
const rowLink = (id) => tid(`account-detail-link-${id}`)

/** The list's own request (`GET /accounts/?limit=1000`), optionally only the tagged one. */
const isList = ({ tagged } = {}) => (r) => {
  if (r.method() !== 'GET') return false
  const url = new URL(r.url())
  if (!url.pathname.endsWith('/accounts/') || url.searchParams.get('limit') !== '1000') return false
  return tagged === undefined || url.searchParams.has('tag') === tagged
}

/**
 * A fresh signed-in page that keeps, from its first document, whether either empty text
 * ever appeared anywhere in the body (a MutationObserver, so a one-frame flash counts).
 */
async function openPage(browser) {
  const { ctx, page } = await h.newPage(browser)
  page.setDefaultTimeout(10000)
  await page.addInitScript((phrases) => {
    const seen = {}
    window.__acctSeen = seen
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
  }, [EMPTY_ALL, EMPTY_TAG])
  await h.uiLogin(page, stack, owner)
  return { ctx, page }
}

/** The empty texts seen since the page opened. */
const seenEmpty = (page) => page.evaluate(() => Object.keys(window.__acctSeen || {}))

async function openAccounts(page) {
  await page.goto(`${stack.webUrl}/accounts`)
  await page.locator(rowLink(alpha.id)).waitFor()
  await h.waitQuiet(page)
}

/** Picks `tag` in the TagFilter with the keyboard (type-ahead on the focused select). */
async function pickTagByKeyboard(page) {
  const select = page.locator(tid('tag-filter'))
  await select.focus()
  await page.keyboard.type(tag.name.slice(0, 3).toLowerCase())
}

/** [S] the awaited list request carries the picked tag (read from the request, not the select). */
async function tagRequested(requestPromise) {
  const request = await requestPromise
  if (!request) return 'no tagged list request'
  const value = new URL(request.url()).searchParams.get('tag')
  return value === String(tag.id) || `tag=${value}`
}

/** The account names the list shows, sorted. */
const shownNames = (page) =>
  page.locator('[data-testid^="account-detail-link-"]').evaluateAll((links) =>
    links.map((a) => (a.getAttribute('aria-label') || '').replace(/^View transactions for /, '')).sort())

/** The API's list for the page's filter, names sorted. */
async function apiNames(tagId) {
  const body = await client.get(owner.token, `/accounts/?limit=1000${tagId === undefined ? '' : `&tag=${tagId}`}`)
  return body.items.map((a) => a.name).sort()
}

async function namesMatchApi(page, tagId) {
  const expected = await apiNames(tagId)
  const shown = await shownNames(page)
  return JSON.stringify(shown) === JSON.stringify(expected) || `shown ${JSON.stringify(shown)} api ${JSON.stringify(expected)}`
}

// ─── Scenarios ───────────────────────────────────────────────────────────────

// (a) A tag change keeps the rows and the TagFilter mounted while the list reloads.
async function scenarioA(browser) {
  console.log('\n=== (a) a reload keeps the list and the tag filter on screen')
  const { ctx, page } = await openPage(browser)
  let gate = null
  try {
    await openAccounts(page)
    await page.evaluate((sel) => { document.querySelector(sel).__stu335Mark = true }, tid('tag-filter'))
    gate = await h.gate(page, isList({ tagged: true }))
    const request = page.waitForRequest(isList({ tagged: true }), { timeout: 5000 }).catch(() => null)
    await pickTagByKeyboard(page)
    await h.check('a.held', 'S', async () => (await gate.waitHits(1)) || 'no tagged list request')
    await h.check('a.tag-picked', 'S', () => tagRequested(request))
    await h.sleep(500)
    await h.check('a.rows-kept', 'B', async () =>
      (await page.locator(rowLink(bravo.id)).isVisible()) || 'the untagged row left the screen while the list reloaded')
    await h.check('a.filter-kept', 'B', async () =>
      (await page.evaluate((sel) => document.querySelector(sel)?.__stu335Mark === true, tid('tag-filter'))) ||
      'the tag filter was unmounted')
    gate.release({ disarm: true })
    await page.locator(rowLink(bravo.id)).waitFor({ state: 'detached', timeout: 5000 }).catch(() => null)
    await h.waitQuiet(page)
    await h.check('a.focus-on-filter', 'B', async () => {
      const active = await page.evaluate(() => document.activeElement?.getAttribute('data-testid') ?? document.activeElement?.tagName ?? null)
      return active === 'tag-filter' || `focus on ${active}`
    })
    await h.check('a.tagged-rows', 'B', () => namesMatchApi(page, tag.id))
    await h.check('a.no-empty-text', 'B', async () => {
      const seen = await seenEmpty(page)
      return seen.length === 0 || `showed ${JSON.stringify(seen)}`
    })
  } finally {
    gate?.release({ disarm: true })
    await ctx.close()
  }
}

// (c) A failed first load shows the alert with Retry in place of the list.
async function scenarioC(browser) {
  console.log('\n=== (c) a failed first load shows an error with Retry, not "No accounts yet"')
  const { ctx, page } = await openPage(browser)
  let fail = null
  try {
    fail = await h.failWith(page, isList(), 500, { times: 1 })
    await page.goto(`${stack.webUrl}/accounts`)
    const alert = page.locator(tid('accounts-load-error'))
    await h.check('c.alert', 'B', async () => {
      const shown = await alert.waitFor({ timeout: 5000 }).then(() => true, () => false)
      return shown || `no accounts-load-error (failures delivered: ${fail.failed})`
    })
    await h.check('c.retry-shown', 'B', async () =>
      (await alert.locator(tid('accounts-retry')).isVisible()) || 'no accounts-retry in the alert')
    await h.waitQuiet(page)
    await h.check('c.no-empty-text', 'B', async () => {
      const absent = await h.expectAbsentFor(page, page.getByText(EMPTY_ALL), 1500)
      const seen = await seenEmpty(page)
      return (absent && seen.length === 0) || `showed ${JSON.stringify(seen)}, absent for 1.5 s: ${absent}`
    })
    await page.locator(tid('accounts-retry')).click({ timeout: 3000 }).catch(() => null)
    await page.locator(rowLink(alpha.id)).waitFor({ timeout: 5000 }).catch(() => null)
    await h.waitQuiet(page)
    await h.check('c.retry-lists', 'B', () => namesMatchApi(page, undefined))
    await h.check('c.alert-gone', 'B', async () => (await alert.count()) === 0 || 'the alert stayed after a successful Retry')
  } finally {
    await fail?.stop()
    await ctx.close()
  }
}

// (e) A failed reload keeps the rows live with the alert and Retry above them.
async function scenarioE(browser) {
  console.log('\n=== (e) a failed reload keeps the rows, with the alert and Retry above them')
  const { ctx, page } = await openPage(browser)
  let fail = null
  try {
    await openAccounts(page)
    fail = await h.failWith(page, isList({ tagged: true }), 500, { times: 1 })
    const request = page.waitForRequest(isList({ tagged: true }), { timeout: 5000 }).catch(() => null)
    await pickTagByKeyboard(page)
    await h.check('e.tag-picked', 'S', () => tagRequested(request))
    await page.locator(tid('accounts-load-error')).waitFor({ timeout: 5000 }).catch(() => null)
    await h.waitQuiet(page)
    await h.check('e.failed', 'S', async () => fail.failed === 1 || `failures delivered: ${fail.failed}`)
    await h.check('e.rows-kept', 'B', async () =>
      (await page.locator(rowLink(bravo.id)).isVisible()) || 'the retained rows are gone after the failed reload')
    await h.check('e.alert-above', 'B', async () => {
      const alert = await page.locator(tid('accounts-load-error')).boundingBox()
      const retry = await page.locator(`${tid('accounts-load-error')} ${tid('accounts-retry')}`).isVisible().catch(() => false)
      const firstRow = await page.locator('[data-testid^="account-detail-link-"]').first().boundingBox()
      if (!alert || !retry) return 'no alert with Retry'
      if (!firstRow) return 'no rows'
      return alert.y + alert.height <= firstRow.y || `alert bottom ${alert.y + alert.height} below row top ${firstRow.y}`
    })
    await h.check('e.no-empty-text', 'B', async () => {
      const absent = await h.expectAbsentFor(page, page.getByText(/No accounts (yet|have this tag)/), 1500)
      const seen = await seenEmpty(page)
      return (absent && seen.length === 0) || `showed ${JSON.stringify(seen)}, absent for 1.5 s: ${absent}`
    })
    await page.locator(tid('accounts-retry')).click({ timeout: 3000 }).catch(() => null)
    await page.locator(rowLink(bravo.id)).waitFor({ state: 'detached', timeout: 5000 }).catch(() => null)
    await h.waitQuiet(page)
    await h.check('e.retry-lists-tagged', 'B', () => namesMatchApi(page, tag.id))
  } finally {
    await fail?.stop()
    await ctx.close()
  }
}

async function setup() {
  owner = await h.makeUser(stack, 'acct')
  tag = await client.post(owner.token, '/tags/', { name: 'Quarterly' })
  alpha = await client.post(owner.token, '/accounts/', {
    name: 'Alpha Checking', account_type: 'checking', balance: 1200, currency: 'PHP', tag_ids: [tag.id],
  })
  bravo = await client.post(owner.token, '/accounts/', {
    name: 'Bravo Savings', account_type: 'savings', balance: 3400, currency: 'PHP',
  })
}

const SCENARIOS = [
  ['a', scenarioA],
  ['c', scenarioC],
  ['e', scenarioE],
]

;(async () => {
  // A stray rejection from a failed scenario is reported, never a crash without RESULT.
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
