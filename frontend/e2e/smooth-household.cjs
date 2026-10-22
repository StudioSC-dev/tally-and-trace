// Browser checks for STU-335 PR 2's Household polish (plan 3.6 Q7, scenarios in 5.2): the
// title waits for the views instead of flipping from "Household" to the sharer's name.
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

const SCENARIOS = [
  ['a', scenarioA],
  ['a2', scenarioA2],
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
