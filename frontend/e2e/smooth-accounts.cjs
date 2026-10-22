// Browser checks for STU-335 on the Accounts page (plan 3.2, accounts scenarios in 5.2):
// the list stays on screen while it reloads, and a failed load shows an alert with Retry,
// never the empty text, and a card row holds a place for its available credit. Starts its own API and web app against a
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

let stack, client, owner, sharer, tag, alpha, bravo, ownerCard, sharedCard

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

/** As the app shows PHP money: "₱1,851.10". */
const peso = (n) => `₱${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

/** An account's row (`article`) on the list. */
const rowOf = (page, id) => page.locator('article', { has: page.locator(rowLink(id)) })

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

// (d) A managed card row holds the credit headline's place while /cards/credit loads.
async function scenarioD(browser) {
  console.log('\n=== (d) a managed card row holds a place for its available credit')
  const { ctx, page } = await openPage(browser)
  let gate = null
  try {
    gate = await h.gate(page, (r) => r.method() === 'GET' && new URL(r.url()).pathname.endsWith('/cards/credit'))
    await page.goto(`${stack.webUrl}/accounts`)
    await page.locator(rowLink(ownerCard.id)).waitFor()
    await h.check('d.held', 'S', async () => (await gate.waitHits(1)) || 'no /cards/credit request')
    await h.check('d.shared-row', 'S', async () =>
      (await page.locator(rowLink(sharedCard.id)).isVisible()) || 'the editor-shared card is not listed')
    await h.check('d.placeholder', 'S', async () => {
      const shown = await page.locator(tid(`account-credit-pending-${ownerCard.id}`)).waitFor({ timeout: 3000 }).then(() => true, () => false)
      return shown || 'no account-credit-pending for the owner card'
    })
    await h.check('d.no-placeholder-for-editor', 'S', async () => {
      const n = await page.locator(tid(`account-credit-pending-${sharedCard.id}`)).count()
      return n === 0 || `${n} placeholders on the editor-shared card`
    })
    await h.sleep(300)
    const held = await rowOf(page, ownerCard.id).boundingBox()
    gate.release({ disarm: true })
    const summary = page.locator(`${tid(`account-credit-${ownerCard.id}`)} ${tid('credit-available')}`)
    await summary.waitFor({ timeout: 5000 }).catch(() => null)
    await h.waitQuiet(page)
    await h.check('d.credit-matches-api', 'B', async () => {
      const { items } = await client.get(owner.token, '/cards/credit')
      const credit = items.find((c) => c.account_id === ownerCard.id)
      if (!credit) return 'the API serves no credit for the owner card'
      const expected = `Available ${credit.complete ? '' : 'at most '}${peso(credit.available_now)}`
      const shown = ((await summary.textContent().catch(() => null)) || '').replace(/\s+/g, ' ').trim()
      return shown === expected || `shown "${shown}" api "${expected}"`
    })
    await h.check('d.height-held', 'B', async () => {
      const after = await rowOf(page, ownerCard.id).boundingBox()
      if (!held || !after) return 'no row box'
      return Math.abs(after.height - held.height) <= 2 || `held ${held.height} px, landed ${after.height} px`
    })
  } finally {
    gate?.release({ disarm: true })
    await ctx.close()
  }
}

/** The household views request (`GET /household/`). */
const isViews = (r) => r.method() === 'GET' && new URL(r.url()).pathname.endsWith('/household/')

// (f) The first paint holds the list until the household views land, so the Shared section arrives with it.
async function scenarioF(browser) {
  console.log('\n=== (f) the accounts list paints together with its shared section')
  const { ctx, page } = await openPage(browser)
  let gate = null
  try {
    gate = await h.gate(page, isViews)
    const listSeen = page.waitForResponse((r) => isList()(r.request()))
    await page.goto(`${stack.webUrl}/accounts`)
    await h.check('f.held', 'S', async () => (await gate.waitHits(1)) || 'no /household/ request')
    // The list request itself is free: wait for it to land before reading the page.
    await listSeen
    // Let the response reach the store and the page render once, so a premature paint would show.
    await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(() => done(null)))))
    await h.check('f.no-rows-while-held', 'B', async () => {
      const rows = await page.locator('[data-testid^="account-detail-link-"]').count()
      return rows === 0 || `${rows} account rows painted while the household views were held`
    })
    await h.check('f.no-showing-while-held', 'B', async () => {
      const n = await page.getByText(/Showing \d+ of \d+ accounts/).count()
      return n === 0 || 'the "Showing X of Y" line painted while the household views were held'
    })
    gate.release({ disarm: true })
    await page.locator(rowLink(alpha.id)).waitFor({ timeout: 5000 }).catch(() => null)
    await h.waitQuiet(page)
    await h.check('f.rows-after', 'B', () => namesMatchApi(page, undefined))
    await h.check('f.shared-section', 'B', async () => {
      const section = page.locator(tid('accounts-section-shared'))
      const links = await section.locator(tid('household-links')).isVisible().catch(() => false)
      return links || 'no accounts-section-shared with household-links after the release'
    })
  } finally {
    gate?.release({ disarm: true })
    await ctx.close()
  }
}

// (f2) Guard: a failed views request neither hides the list nor leaves the loader up.
async function scenarioF2(browser) {
  console.log('\n=== (f2) guard: a failed household views request still paints the list')
  const { ctx, page } = await openPage(browser)
  let fail = null
  try {
    fail = await h.failWith(page, isViews, 500)
    await page.goto(`${stack.webUrl}/accounts`)
    await page.locator(rowLink(alpha.id)).waitFor({ timeout: 5000 }).catch(() => null)
    await h.waitQuiet(page)
    await h.check('f2.failed', 'S', async () => fail.failed >= 1 || 'the views request was never failed')
    await h.check('f2.rows', 'G', () => namesMatchApi(page, undefined))
    await h.check('f2.no-links', 'G', async () => {
      const n = await page.locator(tid('household-links')).count()
      return n === 0 || 'household-links shown although the views failed'
    })
    await h.check('f2.no-loader', 'G', async () => {
      const n = await page.getByText('Loading accounts...').count()
      return n === 0 || 'the loader is still up'
    })
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
  ownerCard = await client.post(owner.token, '/accounts/', {
    name: 'Charlie Card', account_type: 'credit', balance: 0, currency: 'PHP', credit_limit: 50000,
    billing_cycle_start: 15, days_until_due_date: 21,
  })
  sharer = await h.makeUser(stack, 'sharer')
  sharedCard = await client.post(sharer.token, '/accounts/', {
    name: 'Delta Card', account_type: 'credit', balance: 0, currency: 'PHP', credit_limit: 30000,
    billing_cycle_start: 10, days_until_due_date: 21,
  })
  await client.post(sharer.token, `/accounts/${sharedCard.id}/shares`, { email: owner.email, role: 'editor' })
}

const SCENARIOS = [
  ['a', scenarioA],
  ['c', scenarioC],
  ['e', scenarioE],
  ['d', scenarioD],
  ['f', scenarioF],
  ['f2', scenarioF2],
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
