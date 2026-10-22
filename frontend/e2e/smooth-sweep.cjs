// Browser checks for STU-335 PR 2 on the shared loaders (plan 3.5 and 5.2, sweep (a) and
// (b)): the full-page "Verifying your email..." loader is announced as a status and its
// spinner stops under prefers-reduced-motion, and it still spins without that preference.
// Starts its own API and web app against a throwaway database (./_local_stack.cjs); no
// seeding is needed because the page is opened signed out. Not wired into CI and not part
// of `pnpm build`. Run steps: see ./README.md.
//
// Check kinds: [B] behavioural, [S] structural (a failed one makes the run invalid),
// [G] guard. The script ends with RESULT: k/m and exits 0 only when every check passed,
// 1 when any failed, 2 for setup.
//
// Usage: node frontend/e2e/smooth-sweep.cjs [scenario]
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

const VERIFYING = 'Verifying your email...'

let stack

const isVerifyPost = (r) => r.method() === 'POST' && new URL(r.url()).pathname.endsWith('/auth/verify-email')

/** Opens the verify-email page signed out with the verify POST held; returns what the scenarios read. */
async function openHeld(browser, reducedMotion) {
  const { ctx, page } = await h.newPage(browser, { reducedMotion })
  page.setDefaultTimeout(10000)
  const gate = await h.gate(page, isVerifyPost)
  await page.goto(`${stack.webUrl}/verify-email?token=stu335`)
  return { ctx, page, gate }
}

const loaderStatus = (page) => page.getByRole('status').filter({ hasText: VERIFYING })

const animationName = (page) =>
  loaderStatus(page).getByTestId('spinner').evaluate((el) => getComputedStyle(el).animationName)

async function scenarioA(browser) {
  console.log('\n=== (a) reduced motion: the verify loader is a status and its spinner does not spin')
  const { ctx, page, gate } = await openHeld(browser, 'reduce')
  try {
    await h.check('a.held', 'S', async () => (await gate.waitHits(1)) || 'no verify POST')
    await h.check('a.text-visible', 'S', async () =>
      (await page.getByText(VERIFYING).first().waitFor({ timeout: 3000 }).then(() => true, () => false)) || `no "${VERIFYING}"`)
    await h.check('a.status', 'B', async () => {
      const found = await loaderStatus(page).first().waitFor({ timeout: 2000 }).then(() => true, () => false)
      return found || `no status role containing "${VERIFYING}"`
    })
    await h.check('a.no-spin', 'B', async () => {
      const name = await animationName(page)
      return name === 'none' || `spinner animationName is "${name}"`
    })
  } finally {
    gate.release({ disarm: true })
    await ctx.close()
  }
}

async function scenarioB(browser) {
  console.log('\n=== (b) guard: without the preference the verify loader still spins and shows its text')
  const { ctx, page, gate } = await openHeld(browser, 'no-preference')
  try {
    await h.check('b.held', 'S', async () => (await gate.waitHits(1)) || 'no verify POST')
    await h.check('b.text-visible', 'G', async () =>
      (await page.getByText(VERIFYING).first().waitFor({ timeout: 3000 }).then(() => true, () => false)) || `no "${VERIFYING}"`)
    await h.check('b.spins', 'G', async () => {
      const name = await page.getByText(VERIFYING).locator('xpath=ancestor::div[1]').getByTestId('spinner')
        .evaluate((el) => getComputedStyle(el).animationName)
      return name !== 'none' || 'spinner does not animate'
    })
  } finally {
    gate.release({ disarm: true })
    await ctx.close()
  }
}

const SCENARIOS = [
  ['a', scenarioA],
  ['b', scenarioB],
]

;(async () => {
  process.on('unhandledRejection', (e) => console.log(`  NOTE unhandled rejection: ${e && e.message ? e.message.split('\n')[0] : e}`))
  try {
    stack = await startLocalStack()
  } catch (e) {
    console.error('SETUP FAILED', e)
    process.exit(2)
  }
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
