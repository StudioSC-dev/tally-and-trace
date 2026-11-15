// Browser checks for STU-213: the dead mobile menu in Navigation.tsx and the unused
// OnboardingStep.targetElement field are gone, and nothing visible changed.
//
//   a.unreachable-before-removal  AC1  evidence from the parent build (main e2e881d) recorded in
//                                      nav-dead-code.baseline/pre-removal.json: at 360, 390, 640, 768 and 1280px, in
//                                      both engines, the hamburger was in the DOM and could not be seen, hit with the
//                                      pointer or focused with Tab, and no dropdown could be open. This check reads
//                                      that record; it does not measure the current tree. To retake it: check out the
//                                      parent, copy this script in, and run
//                                      PRE_REMOVAL=write PARENT_SHA=<sha> node frontend/e2e/nav-dead-code.cjs a
//   a.no-hamburger                AC1  after the change neither the hamburger nor the dropdown is in the DOM,
//                                      and Navigation.tsx no longer holds their state or classes
//   b.nav-geometry                AC2  the top bar's bounding boxes and pixels at 390 and 1280px match the
//                                      baseline taken on main e2e881d, before the change
//   c.interface-field-removal     AC4  the OnboardingStep interface declares no targetElement; the component's
//                                      own local targetElement is still there
//   d.quality-gates               AC5  tsc, vite build and lint each exit 0
//
// AC3 (the tour still resolves every target by data-onboarding) is proved by onboarding-a11y.cjs g.keyboard-walk.
//
// Baselines live in ./nav-dead-code.baseline/ (a rects JSON and a PNG per engine and width). They were taken on
// main e2e881d, before the change, with BASELINE=write; the pixel check is only meaningful on the machine and
// fonts they were taken on, so regenerate them (on main, never on a changed nav) when the rendering environment
// changes. Rects are compared with a 0.5px tolerance.
//
// Starts its own API and web app against a throwaway database (./_local_stack.cjs). Not wired into CI. Run
// steps: see ./README.md. WebKit needs `playwright install webkit`.
//
// Check kinds: [B] behavioural, [S] structural, [G] guard. Ends with RESULT: k/m; exit 0 only when every check
// passed, 1 when any failed, 2 for setup.
//
// Usage: node frontend/e2e/nav-dead-code.cjs [a|b|c|d]     BASELINE=write to (re)take the baseline, ENGINES=chromium,webkit
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
const WIDTHS = [360, 390, 640, 768, 1280]
const GEOMETRY_WIDTHS = [390, 1280]
const HEIGHT = 900
const TOL = 0.5
const FRONTEND = path.resolve(__dirname, '..')
const BASELINE_DIR = path.join(__dirname, 'nav-dead-code.baseline')
const NAVIGATION = path.join(FRONTEND, 'src', 'components', 'Navigation.tsx')
const ONBOARDING = path.join(FRONTEND, 'src', 'components', 'onboarding', 'OnboardingFlow.tsx')
const TOP_NAV = 'nav.fixed.top-0'
const HAMBURGER_TEXT = 'Open main menu'
let stack
// PRE_REMOVAL=write on a checkout of the parent build records AC1's baseline evidence (see the header).
const PRE_WRITE = process.env.PRE_REMOVAL === 'write'
const PRE_FILE = path.join(BASELINE_DIR, 'pre-removal.json')
const pre = { parent: process.env.PARENT_SHA || '', results: {} }
let PRE = null
try { PRE = JSON.parse(fs.readFileSync(PRE_FILE, 'utf8')) } catch { /* reported by the checks */ }

async function openAt(browser, user, width) {
  const { ctx, page } = await h.newPage(browser, { viewport: { width, height: HEIGHT } })
  page.setDefaultTimeout(10000)
  await h.uiLogin(page, stack, user)
  await page.locator(`${TOP_NAV} a[href="/"]`).first().waitFor()
  await h.waitQuiet(page)
  return { ctx, page }
}

const hamburgers = (page) => page.locator(`${TOP_NAV} button`).filter({ hasText: HAMBURGER_TEXT })

/** Hamburger and dropdown reachability on the page as built: what the parent build is measured with. */
async function measureReachability(page) {
  const found = await hamburgers(page).count()
  const problems = []
  for (let i = 0; i < found; i++) {
    const one = hamburgers(page).nth(i)
    if (await one.isVisible()) problems.push('visible')
    if (await one.boundingBox()) problems.push('has a box')
    const hit = await one.evaluate((el) => {
      const r = el.getBoundingClientRect()
      const at = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)
      return !!at && (at === el || el.contains(at))
    })
    if (hit) problems.push('a pointer at its centre lands on it')
  }
  // Keyboard: walk the page's tab order from the top; the hamburger is never focused.
  await page.evaluate(() => { (document.activeElement instanceof HTMLElement) && document.activeElement.blur(); window.scrollTo(0, 0) })
  for (let i = 0; i < 50; i++) {
    await page.keyboard.press('Tab')
    // Match the focused element itself: a wrap to <body> has the label in its text too.
    const onIt = await page.evaluate((label) => {
      const el = document.activeElement
      return !!el && el.tagName === 'BUTTON' && (el.textContent || '').trim() === label
    }, HAMBURGER_TEXT)
    if (onIt) { problems.push(`Tab ${i + 1} focused it`); break }
  }
  // The dropdown exists only while its state is true, and only the hamburger set it.
  const dropdown = await page.locator(`${TOP_NAV} > div.sm\\:hidden`).count()
  if (dropdown > 0) problems.push('a dropdown is in the DOM')
  return { found, problems }
}

async function scenarioA(browser, engine) {
  console.log(`\n=== (a) ${engine}: no hamburger, no dropdown`)
  const user = await h.makeUser(stack, `a${engine.slice(0, 2)}`)
  for (const width of WIDTHS) {
    const { ctx, page } = await openAt(browser, user, width)
    try {
      if (PRE_WRITE) {
        pre.results[`${engine}-${width}`] = await measureReachability(page)
        continue
      }
      await h.check(`a.${engine}.${width}.unreachable-before-removal`, 'B', () => {
        // Evidence recorded on the parent build, not measured on this tree (where there is nothing to find).
        const rec = PRE && PRE.results[`${engine}-${width}`]
        if (!rec) return `no recorded parent result for ${engine} at ${width}px in pre-removal.json`
        if (rec.found < 1) return `the parent had no hamburger in the DOM at ${width}px, so the guard proves nothing`
        return rec.problems.length === 0 || `on the parent: ${rec.problems.join('; ')}`
      })
      await h.check(`a.${engine}.${width}.no-hamburger`, 'B', async () => {
        const problems = []
        if ((await hamburgers(page).count()) !== 0) problems.push(`the "${HAMBURGER_TEXT}" button is in the DOM`)
        if ((await page.getByText(HAMBURGER_TEXT).count()) !== 0) problems.push(`"${HAMBURGER_TEXT}" text is in the DOM`)
        if ((await page.locator(`${TOP_NAV} > div.sm\\:hidden`).count()) !== 0) problems.push('the dropdown container is in the DOM')
        return problems.length === 0 || problems.join('; ')
      })
    } finally {
      await ctx.close()
    }
  }
  await h.check(`a.${engine}.source-has-no-mobile-menu`, 'S', () => {
    const src = fs.readFileSync(NAVIGATION, 'utf8')
    const left = ['showMobileMenu', 'setShowMobileMenu', 'mobileNavLink', HAMBURGER_TEXT].filter((s) => src.includes(s))
    return left.length === 0 || `Navigation.tsx still has: ${left.join(', ')}`
  })
}

const barRects = (page) =>
  page.locator(TOP_NAV).evaluate((nav) => {
    const name = (el) => el.getAttribute('data-onboarding') || el.getAttribute('aria-label') || (el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 30) || el.tagName.toLowerCase()
    return [nav, ...Array.from(nav.querySelectorAll('a, button'))].map((el) => {
      const r = el.getBoundingClientRect()
      return { name: el === nav ? 'nav' : name(el), x: r.x, y: r.y, w: r.width, h: r.height }
    })
  })

async function scenarioB(browser, engine) {
  console.log(`\n=== (b) ${engine}: the top bar is unchanged at 390 and 1280px`)
  const user = await h.makeUser(stack, `bgeo`)
  for (const width of GEOMETRY_WIDTHS) {
    const { ctx, page } = await openAt(browser, user, width)
    try {
      const png = path.join(BASELINE_DIR, `${engine}-${width}.png`)
      const json = path.join(BASELINE_DIR, `${engine}-${width}.json`)
      const rects = await barRects(page)
      const shot = await page.locator(TOP_NAV).screenshot({ animations: 'disabled' })
      if (WRITE) {
        fs.mkdirSync(BASELINE_DIR, { recursive: true })
        fs.writeFileSync(png, shot)
        fs.writeFileSync(json, JSON.stringify(rects, null, 2) + '\n')
        console.log(`  WROTE ${path.relative(process.cwd(), png)} and ${path.relative(process.cwd(), json)}`)
        continue
      }
      await h.check(`b.${engine}.${width}.baseline-exists`, 'G', () => (fs.existsSync(png) && fs.existsSync(json)) || 'no baseline; run with BASELINE=write on main')
      if (!fs.existsSync(png) || !fs.existsSync(json)) continue
      await h.check(`b.${engine}.${width}.nav-geometry-boxes`, 'B', () => {
        // Boxes that are drawn: the removed hamburger had none (display: none), so it is not a drawn box.
        const drawn = (list) => list.filter((r) => r.w > 0 || r.h > 0)
        const base = drawn(JSON.parse(fs.readFileSync(json, 'utf8')))
        const now = drawn(rects)
        if (base.length !== now.length) return `${now.length} drawn boxes, baseline ${base.length}`
        const off = now.map((r, i) => ['name', 'x', 'y', 'w', 'h'].filter((k) => (k === 'name' ? r.name !== base[i].name : Math.abs(r[k] - base[i][k]) > TOL)).map((k) => `${r.name}.${k} ${r[k]} vs ${base[i][k]}`)).flat()
        return off.length === 0 || off.join('; ')
      })
      await h.check(`b.${engine}.${width}.nav-geometry-pixels`, 'B', () => {
        if (Buffer.compare(fs.readFileSync(png), shot) === 0) return true
        const out = path.join(os.tmpdir(), `nav-dead-code-${engine}-${width}-actual.png`)
        fs.writeFileSync(out, shot)
        return `top bar pixels differ from the baseline (actual written to ${out})`
      })
    } finally {
      await ctx.close()
    }
  }
}

/** The text of the `interface OnboardingStep { ... }` body, found with the TypeScript parser. */
function stepInterface(ts, source) {
  const file = ts.createSourceFile('OnboardingFlow.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  let found = null
  const visit = (node) => {
    if (ts.isInterfaceDeclaration(node) && node.name.text === 'OnboardingStep') found = node
    ts.forEachChild(node, visit)
  }
  visit(file)
  return found
}

async function scenarioC() {
  console.log('\n=== (c) interface field removal')
  const ts = require(path.join(FRONTEND, 'node_modules', 'typescript'))
  const source = fs.readFileSync(ONBOARDING, 'utf8')
  await h.check('c.interface-field-removal.interface-found', 'G', () => stepInterface(ts, source) !== null || 'no interface OnboardingStep in OnboardingFlow.tsx')
  await h.check('c.interface-field-removal.no-field', 'S', () => {
    const decl = stepInterface(ts, source)
    if (!decl) return 'no interface OnboardingStep'
    const names = decl.members.map((m) => (m.name && m.name.getText()) || '?')
    if (names.includes('targetElement')) return `OnboardingStep still declares targetElement (members: ${names.join(', ')})`
    return names.length > 0 || 'the interface has no members, the check is not looking at the right thing'
  })
  await h.check('c.interface-field-removal.local-variable-kept', 'S', () => {
    const file = ts.createSourceFile('OnboardingFlow.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
    let kept = false
    const visit = (node) => {
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === 'targetElement') {
        kept = /resolved\?\.step === currentStep \? resolved\.element : null/.test(node.initializer ? node.initializer.getText() : '')
      }
      ts.forEachChild(node, visit)
    }
    visit(file)
    return kept || 'the local `const targetElement = resolved?.step === currentStep ? resolved.element : null` is missing or changed'
  })
}

async function scenarioD() {
  console.log('\n=== (d) quality gates: tsc, vite build, lint')
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'nav-dead-code-build-'))
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
  const browserScenarios = [['a', scenarioA], ['b', scenarioB]]
  const needsStack = browserScenarios.some(([n]) => !only || only === n)
  if (needsStack) stack = await startLocalStack()
  const wanted = (process.env.ENGINES || ENGINES.join(',')).split(',')
  if (needsStack) {
    for (const engine of wanted) {
      const browser = await pw[engine].launch()
      for (const [name, run] of browserScenarios) {
        if (only && only !== name) continue
        if (WRITE && name !== 'b') continue
        if (PRE_WRITE && name !== 'a') continue
        try {
          await run(browser, engine)
        } catch (e) {
          await h.check(`${name}.${engine}.completed`, 'B', async () => `scenario threw: ${e && e.stack ? e.stack.split('\n').slice(0, 3).join(' | ') : e}`)
        }
      }
      await browser.close()
    }
  }
  if (PRE_WRITE) {
    fs.mkdirSync(BASELINE_DIR, { recursive: true })
    fs.writeFileSync(PRE_FILE, JSON.stringify(pre, null, 2) + '\n')
    console.log(`  WROTE ${PRE_FILE}`)
    stack?.stop()
    process.exit(0)
  }
  if ((!only || only === 'c') && !WRITE) await scenarioC()
  if ((!only || only === 'd') && !WRITE) await scenarioD()
  stack?.stop()
  process.exit(WRITE ? 0 : h.report())
})().catch((e) => { console.error(e); stack?.stop(); process.exit(2) })
