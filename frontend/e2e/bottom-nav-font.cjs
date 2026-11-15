// Browser checks for STU-214: the mobile bottom nav stays inside a 390px viewport when the root
// font size is doubled, and does not change at the default size.
//
// (a) fits-200: at 390x844 with the root font size at 200%, all four tabs sit inside the viewport
//     and document.documentElement.scrollWidth <= 390 (Chromium and WebKit);
// (b) default-same: at the default root font size the nav's tab positions and its pixels match the
//     baseline taken from main 06a95a9 (before the change), in the same engine;
// (c) tour-tab: with the tour running at 200%, the Goals step highlights the Goals tab;
// (d) quality-gates: tsc, vite build and lint each exit 0.
//
// Baselines live in ./bottom-nav-font.baseline/ (a rects JSON and a PNG per engine). They were taken
// on main 06a95a9 with this script's BASELINE=write; the pixel check is only meaningful on the
// machine and fonts they were taken on, so regenerate them (on main, never on a changed nav) when the
// rendering environment changes. Rects are compared with a 0.5px tolerance.
//
// Starts its own API and web app against a throwaway database (./_local_stack.cjs). Not wired into
// CI. Run steps: see ./README.md. WebKit needs `playwright install webkit`.
//
// Check kinds: [B] behavioural, [S] structural, [G] guard. Ends with RESULT: k/m; exit 0 only when
// every check passed, 1 when any failed, 2 for setup.
//
// Usage: node frontend/e2e/bottom-nav-font.cjs [a|b|c|d]      BASELINE=write to (re)take the baselines
const fs = require('fs')
const os = require('os')
const path = require('path')
const { execFileSync } = require('child_process')
const { startLocalStack } = require('./_local_stack.cjs')
const h = require('./_smooth.cjs')

const playwrightPath = process.env.PLAYWRIGHT_PATH || 'playwright'
let pw
try {
  pw = require(playwrightPath)
} catch {
  console.error(`Cannot load Playwright from "${playwrightPath}". Set PLAYWRIGHT_PATH (see frontend/e2e/README.md).`)
  process.exit(2)
}

const only = process.argv[2]
const WRITE = process.env.BASELINE === 'write'
const ENGINES = ['chromium', 'webkit']
const VIEWPORT = { width: 390, height: 844 }
const BASELINE_DIR = path.join(__dirname, 'bottom-nav-font.baseline')
const FRONTEND = path.resolve(__dirname, '..')
const LABELS = ['Home', 'Accounts', 'Transactions', 'Goals']
const TOL = 0.5
let stack

/** Doubles the root font size on every page load, the way a large system text size does. */
const FONT_200 = () => {
  const apply = () => {
    const style = document.createElement('style')
    style.textContent = 'html { font-size: 200% !important; }'
    document.documentElement.appendChild(style)
  }
  if (document.documentElement) apply()
  else document.addEventListener('DOMContentLoaded', apply)
}

async function openHome(browser, user, { big }) {
  const { ctx, page } = await h.newPage(browser, { viewport: VIEWPORT })
  page.setDefaultTimeout(10000)
  if (big) await page.addInitScript(FONT_200)
  await h.uiLogin(page, stack, user)
  await page.locator('nav.fixed.bottom-0 [data-onboarding="nav-home"]').waitFor()
  await h.waitQuiet(page)
  return { ctx, page }
}

const tabRects = (page) =>
  page.locator('nav.fixed.bottom-0 [data-onboarding^="nav-"]').evaluateAll((els) =>
    els.map((el) => {
      const r = el.getBoundingClientRect()
      return { name: (el.textContent || '').trim(), x: r.x, y: r.y, w: r.width, h: r.height }
    }))

// Pages whose own content (not the nav) is still wider than 390px at 200%: the Dashboard period
// selector and the Transactions due tabs. Out of scope for STU-214, so the document-width check is
// asserted on the pages that are clean and only reported on these two.
const CLEAN_PAGES = ['/accounts', '/allocations']
const OTHER_PAGES = ['/', '/transactions']

async function scenarioA(browser, engine) {
  console.log(`\n=== (a) ${engine}: four tabs fit at 390px, 200% root font`)
  const user = await h.makeUser(stack, `a${engine.slice(0, 2)}`)
  const { ctx, page } = await openHome(browser, user, { big: true })
  try {
    await h.check(`a.${engine}.root-is-200`, 'G', async () => {
      const px = await page.evaluate(() => parseFloat(getComputedStyle(document.documentElement).fontSize))
      return px === 32 || `root font size ${px}px, expected 32`
    })
    for (const route of [...OTHER_PAGES.slice(0, 1), ...CLEAN_PAGES, ...OTHER_PAGES.slice(1)]) {
      if (route !== '/') {
        await page.goto(`${stack.webUrl}${route}`)
        await page.locator('nav.fixed.bottom-0 [data-onboarding="nav-home"]').waitFor()
        await h.waitQuiet(page)
      }
      await h.check(`a.${engine}.fits-200${route === '/' ? '' : route.replace('/', '-')}`, 'B', async () => {
        const rects = await tabRects(page)
        if (rects.length !== 4) return `${rects.length} tabs found`
        const out = rects.filter((r) => r.x < -TOL || r.x + r.w > VIEWPORT.width + TOL)
        if (out.length) return `outside the viewport: ${JSON.stringify(out.map((r) => [r.name, Math.round(r.x), Math.round(r.x + r.w)]))}`
        const navWidth = await page.locator('nav.fixed.bottom-0').evaluate((el) => el.scrollWidth)
        if (navWidth > VIEWPORT.width) return `the nav is ${navWidth}px wide`
        const names = rects.map((r) => r.name)
        if (JSON.stringify(names) !== JSON.stringify(LABELS)) return `names ${JSON.stringify(names)}`
        const scroll = await page.evaluate(() => document.documentElement.scrollWidth)
        if (scroll <= VIEWPORT.width) return true
        if (CLEAN_PAGES.includes(route)) return `scrollWidth ${scroll} > ${VIEWPORT.width}`
        console.log(`  NOTE ${route}: page content (not the nav) makes scrollWidth ${scroll}`)
        return true
      })
    }
  } finally {
    await ctx.close()
  }
}

async function scenarioB(browser, engine) {
  console.log(`\n=== (b) ${engine}: unchanged at the default font size`)
  const user = await h.makeUser(stack, `b${engine.slice(0, 2)}`)
  const { ctx, page } = await openHome(browser, user, { big: false })
  try {
    const nav = page.locator('nav.fixed.bottom-0')
    const png = path.join(BASELINE_DIR, `${engine}.png`)
    const json = path.join(BASELINE_DIR, `${engine}.json`)
    const rects = await tabRects(page)
    const shot = await nav.screenshot({ animations: 'disabled' })
    if (WRITE) {
      fs.mkdirSync(BASELINE_DIR, { recursive: true })
      fs.writeFileSync(png, shot)
      fs.writeFileSync(json, JSON.stringify(rects, null, 2) + '\n')
      console.log(`  WROTE ${path.relative(process.cwd(), png)} and ${path.relative(process.cwd(), json)}`)
      return
    }
    await h.check(`b.${engine}.baseline-exists`, 'G', () => (fs.existsSync(png) && fs.existsSync(json)) || 'no baseline; run with BASELINE=write on main')
    if (!fs.existsSync(png) || !fs.existsSync(json)) return
    await h.check(`b.${engine}.default-same-positions`, 'B', () => {
      const base = JSON.parse(fs.readFileSync(json, 'utf8'))
      if (base.length !== rects.length) return `${rects.length} tabs, baseline ${base.length}`
      const off = rects.map((r, i) => ['x', 'y', 'w', 'h'].filter((k) => Math.abs(r[k] - base[i][k]) > TOL).map((k) => `${r.name}.${k} ${r[k]} vs ${base[i][k]}`)).flat()
      return off.length === 0 || off.join('; ')
    })
    await h.check(`b.${engine}.default-same`, 'B', () => {
      const base = fs.readFileSync(png)
      if (Buffer.compare(base, shot) === 0) return true
      const out = path.join(os.tmpdir(), `bottom-nav-${engine}-actual.png`)
      fs.writeFileSync(out, shot)
      return `nav pixels differ from the baseline (actual written to ${out})`
    })
  } finally {
    await ctx.close()
  }
}

async function scenarioC(browser, engine) {
  console.log(`\n=== (c) ${engine}: the tour highlights the Goals tab at 200%`)
  const user = await h.makeUser(stack, `c${engine.slice(0, 2)}`)
  stack.psql(`UPDATE users SET onboarding_completed = false WHERE email = '${user.email}'`)
  const { ctx, page } = await h.newPage(browser, { viewport: VIEWPORT })
  page.setDefaultTimeout(10000)
  await page.addInitScript(FONT_200)
  try {
    await page.goto(`${stack.webUrl}/login`)
    await page.locator('#email').fill(user.email)
    await page.locator('#password').fill(user.password)
    await page.getByRole('button', { name: 'Sign in', exact: true }).click()
    const highlight = page.locator('[data-onboarding-highlight]')
    await highlight.waitFor()
    const next = page.getByRole('button', { name: 'Next', exact: true })
    for (let i = 0; i < 3; i++) {
      await next.click()
      await h.sleep(400)
    }
    await page.getByText('Set Financial Goals').waitFor()
    await h.sleep(600)
    await h.check(`c.${engine}.tour-tab`, 'B', async () => {
      const tab = await page.locator('nav.fixed.bottom-0 [data-onboarding="nav-allocations"]').boundingBox()
      const box = await highlight.boundingBox()
      if (!tab || !box) return 'tab or highlight not found'
      const inside = box.x <= tab.x + 0.5 && box.y <= tab.y + 0.5 && box.x + box.width >= tab.x + tab.width - 0.5 && box.y + box.height >= tab.y + tab.height - 0.5
      const centred = Math.abs(box.x + box.width / 2 - (tab.x + tab.width / 2)) <= 1 && Math.abs(box.y + box.height / 2 - (tab.y + tab.height / 2)) <= 1
      return (inside && centred) || `highlight ${JSON.stringify(box)} vs Goals tab ${JSON.stringify(tab)}`
    })
    await h.check(`c.${engine}.tour-tab-inside-viewport`, 'B', async () => {
      const tab = await page.locator('nav.fixed.bottom-0 [data-onboarding="nav-allocations"]').boundingBox()
      return (tab && tab.x >= -TOL && tab.x + tab.width <= VIEWPORT.width + TOL) || `Goals tab ${JSON.stringify(tab)}`
    })
  } finally {
    await ctx.close()
  }
}

async function scenarioD() {
  console.log('\n=== (d) quality gates: tsc, vite build, lint')
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'bottom-nav-build-'))
  const run = (id, args) =>
    h.check(`d.quality-gates.${id}`, 'G', () => {
      try {
        execFileSync('pnpm', args, { cwd: FRONTEND, stdio: 'pipe', timeout: 280000 })
        return true
      } catch (e) {
        return `exit ${e.status}: ${String(e.stdout || '').split('\n').slice(-8).join(' | ')}`
      }
    })
  try {
    await run('tsc', ['exec', 'tsc'])
    await run('vite-build', ['exec', 'vite', 'build', '--outDir', out, '--emptyOutDir'])
    await run('lint', ['run', 'lint'])
  } finally {
    fs.rmSync(out, { recursive: true, force: true })
  }
}

;(async () => {
  process.on('unhandledRejection', (e) => console.log(`  NOTE unhandled rejection: ${e && e.message ? e.message.split('\n')[0] : e}`))
  stack = await startLocalStack()
  const wanted = (process.env.ENGINES || ENGINES.join(',')).split(',')
  const scenarios = [['a', scenarioA], ['b', scenarioB], ['c', scenarioC]]
  for (const engine of wanted) {
    const browser = await pw[engine].launch()
    for (const [name, run] of scenarios) {
      if (only && only !== name) continue
      if (WRITE && name !== 'b') continue
      try {
        await run(browser, engine)
      } catch (e) {
        await h.check(`${name}.${engine}.completed`, 'B', async () => `scenario threw: ${e && e.stack ? e.stack.split('\n').slice(0, 3).join(' | ') : e}`)
      }
    }
    await browser.close()
  }
  if ((!only || only === 'd') && !WRITE) await scenarioD()
  stack.stop()
  process.exit(WRITE ? 0 : h.report())
})().catch((e) => { console.error(e); stack?.stop(); process.exit(2) })
