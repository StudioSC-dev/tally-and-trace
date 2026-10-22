// Browser checks for STU-335 on Settings (plan 3.2 and 5.2, settings (a) and (b)): the
// category and tag lists show a loader, never the empty text, while their queries are
// held. Starts its own API and web app against a throwaway database (./_local_stack.cjs)
// and seeds through the API; every expected value is read from the API. Not wired into CI
// and not part of `pnpm build`. Run steps: see ./README.md.
//
// Check kinds: [B] behavioural, [S] structural (a failed one makes the run invalid),
// [G] guard. The script ends with RESULT: k/m and exits 0 only when every check passed,
// 1 when any failed, 2 for setup.
//
// Usage: node frontend/e2e/smooth-settings.cjs [scenario]
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

const EMPTY_CATEGORIES = 'No categories yet.'
const EMPTY_TAGS = 'No tags yet.'

let stack, client, owner, category, tag

const tid = (id) => `[data-testid="${id}"]`

const isGet = (segment) => (r) => r.method() === 'GET' && new URL(r.url()).pathname.endsWith(segment)

/** A fresh signed-in page that records whether either empty text ever appeared in the body. */
async function openPage(browser) {
  const { ctx, page } = await h.newPage(browser)
  page.setDefaultTimeout(10000)
  await page.addInitScript((phrases) => {
    const seen = {}
    window.__settingsSeen = seen
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
  }, [EMPTY_CATEGORIES, EMPTY_TAGS])
  await h.uiLogin(page, stack, owner)
  return { ctx, page }
}

const seenEmpty = (page) => page.evaluate(() => Object.keys(window.__settingsSeen || {}))

async function scenarioList(browser, name, { segment, pending, emptyText, rowText, label }) {
  console.log(`\n=== (${name}) ${label} list holds a loader, never "${emptyText}", while it loads`)
  const { ctx, page } = await openPage(browser)
  let gate = null
  try {
    gate = await h.gate(page, isGet(segment))
    await page.goto(`${stack.webUrl}/settings`)
    await h.check(`${name}.held`, 'S', async () => (await gate.waitHits(1)) || `no ${segment} request`)
    await h.check(`${name}.pending`, 'S', async () => {
      const shown = await page.locator(tid(pending)).waitFor({ timeout: 3000 }).then(() => true, () => false)
      return shown || `no ${pending}`
    })
    await h.check(`${name}.no-empty-text`, 'B', async () => {
      const absent = await h.expectAbsentFor(page, page.getByText(emptyText), 1500)
      return absent || `"${emptyText}" shown while the request was held`
    })
    gate.release({ disarm: true })
    await page.getByText(rowText, { exact: true }).first().waitFor({ timeout: 5000 }).catch(() => null)
    await h.waitQuiet(page)
    await h.check(`${name}.row-matches-api`, 'B', async () =>
      (await page.getByText(rowText, { exact: true }).first().isVisible()) || `"${rowText}" is not listed`)
    await h.check(`${name}.never-empty`, 'B', async () => {
      const seen = await seenEmpty(page)
      return seen.length === 0 || `showed ${JSON.stringify(seen)}`
    })
  } finally {
    gate?.release({ disarm: true })
    await ctx.close()
  }
}

const scenarioA = (browser) =>
  scenarioList(browser, 'a', { segment: '/categories/', pending: 'categories-pending', emptyText: EMPTY_CATEGORIES, rowText: category.name, label: 'category' })
const scenarioB = (browser) =>
  scenarioList(browser, 'b', { segment: '/tags/', pending: 'tags-pending', emptyText: EMPTY_TAGS, rowText: tag.name, label: 'tag' })

async function setup() {
  owner = await h.makeUser(stack, 'settings')
  category = await client.post(owner.token, '/categories/', { name: 'Groceries Run', color: '#16a34a', is_expense: true })
  tag = await client.post(owner.token, '/tags/', { name: 'Quarterly' })
  // The seeded rows must come from the API, not from this script's literals.
  const cats = await client.get(owner.token, '/categories/')
  const tags = await client.get(owner.token, '/tags/')
  const catList = Array.isArray(cats) ? cats : cats.items
  const tagList = Array.isArray(tags) ? tags : tags.items
  if (!catList.some((c) => c.name === category.name) || !tagList.some((t) => t.name === tag.name)) {
    throw new Error('seeded category or tag is not served by the API')
  }
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
