// Browser checks for STU-644: an open dialog's backdrop covers the whole viewport on every page.
// The shared overlay (`fixed inset-0 overflow-y-auto bg-scrim/60`) is a sibling inside `space-y-6`
// containers on some pages, and that rule gave it a 24px margin-top, so the backdrop started 24px
// down and the top nav stayed visible above it.
//   accounts_backdrop_full_viewport: the Add account dialog open, at 390x844 and 1280x800: the
//       overlay's bounding box is x=0, y=0, the full viewport wide and tall, and the page's top
//       nav is under it (elementFromPoint at the top edge hits the overlay).
//   all_pages_backdrop_full_viewport: the same check for the transaction, account, recurring-entry,
//       category and tag dialogs (every dialog on the shared overlay that opens from a page).
//   dialog_layout_unchanged: at both sizes, each dialog's panel and action buttons sit where they
//       did on unfixed main, compared with ./dialog-backdrop.baseline/main.json: x and size within
//       1px, and y exactly the removed margin higher (+-1px): 24px for the transaction, recurring
//       and account dialogs, 16px for the centred category and tag dialogs.
//   overlay_regressions: dialog-tabbar.cjs (STU-635) and toast-placement.cjs (STU-629) run unchanged
//       as child processes; each must exit 0 and print RESULT k/k.
//   quality_gates: lint, tsc, build and the unit tests pass.
// The baseline was taken on unfixed main 9b36863 (before the fix) with BASELINE=write.
//
// Starts its own API and web app against a throwaway database (./_local_stack.cjs) and seeds
// through the API. Not wired into CI. Run steps: ./README.md. Condition waits only.
//
// Usage: node frontend/e2e/dialog-backdrop.cjs [scenario]     BASELINE=write to (re)take the baseline
const fs = require('fs')
const path = require('path')
const { spawnSync } = require('child_process')
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
const WRITE = process.env.BASELINE === 'write'
const BASELINE_FILE = path.join(__dirname, 'dialog-backdrop.baseline', 'main.json')
const FRONTEND = path.join(__dirname, '..')

let stack, client

const SIZES = { phone: { width: 390, height: 844 }, desktop: { width: 1280, height: 800 } }
const TOL = 1
// How far each dialog's panel and buttons rise once the overlay's margin-top is gone: the whole
// margin (space-y-6: 24px) for a dialog that starts at the top, half of the Settings page's
// space-y-8 margin (32px) for the two vertically centred dialogs.
const RISE = { transaction: 24, account: 24, recurring: 24, category: 16, tag: 16 }

const manilaToday = () => new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10)
const tid = (id) => `[data-testid="${id}"]`
const settle = (page) => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(r, 60)))))

/** Every dialog on the shared overlay that opens from a page: where, how to open it. */
const DIALOGS = [
  { name: 'transaction', route: '/transactions', open: (p) => p.getByRole('button', { name: 'Add transaction' }).first() },
  { name: 'account', route: '/accounts', open: (p) => p.getByRole('button', { name: 'Add account', exact: true }) },
  { name: 'recurring', route: '/allocations', open: (p) => p.getByRole('button', { name: 'Add recurring entry' }) },
  { name: 'category', route: '/settings', open: (p) => p.getByRole('button', { name: 'Add category', exact: true }) },
  { name: 'tag', route: '/settings', open: (p) => p.getByRole('button', { name: 'Add tag', exact: true }) },
]
const OVERLAY = '.fixed.inset-0.overflow-y-auto.bg-scrim\\/60'

/** A user with one account and a few rows (a fixed shape, so the layout is the same every run). */
async function seedUser(tag) {
  const user = await h.makeUser(stack, tag)
  const checking = await client.post(user.token, '/accounts/', { name: 'DB Checking', account_type: 'checking', balance: 500000, currency: 'PHP' })
  const today = manilaToday()
  for (let i = 0; i < 6; i++) {
    await client.post(user.token, '/transactions/', {
      account_id: checking.id, transaction_type: 'debit', amount: 100 + i, description: `DB Seed ${i}`,
      transaction_date: `${today}T00:00:00`,
    })
  }
  return user
}

async function openPage(browser, user, size, route) {
  const { ctx, page } = await h.newPage(browser, { timezoneId: 'Asia/Manila', viewport: size })
  page.setDefaultTimeout(10000)
  page.on('dialog', (dialog) => dialog.accept().catch(() => {}))
  await h.uiLogin(page, stack, user)
  await page.goto(`${stack.webUrl}${route}`)
  await h.waitQuiet(page)
  return { ctx, page }
}

const overlayOf = (page) => page.locator(OVERLAY).filter({ hasNot: page.locator(tid('confirm-dialog')) }).last()

async function openDialog(page, dialog) {
  const trigger = dialog.open(page)
  await trigger.waitFor()
  await trigger.click()
  const overlay = overlayOf(page)
  await overlay.waitFor()
  await h.waitQuiet(page)
  await settle(page)
  return overlay
}

/** Runs in the page: the overlay's box, the viewport and what is on top at the overlay's top edge. */
function measureOverlay(el) {
  const r = el.getBoundingClientRect()
  const x = Math.round(window.innerWidth / 2)
  const top = document.elementFromPoint(x, 2)
  const nav = document.querySelector('nav')
  return {
    rect: { x: r.x, y: r.y, w: r.width, h: r.height },
    viewport: { w: window.innerWidth, h: window.innerHeight },
    topEdgeIsOverlay: !!top && el.contains(top),
    topEdgeTag: top ? `${top.tagName.toLowerCase()}.${String(top.className).slice(0, 40)}` : null,
    navCount: document.querySelectorAll('nav').length,
    navFirstBottom: nav ? nav.getBoundingClientRect().bottom : null,
    marginTop: getComputedStyle(el).marginTop,
  }
}

/** Runs in the page: the dialog panel and every action button, as they sit with the overlay unscrolled. */
function layoutOf(el) {
  const rectOf = (n) => { const r = n.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height } }
  const label = (n) => (n.getAttribute('aria-label') || n.textContent || n.tagName).trim().replace(/\s+/g, ' ').slice(0, 32)
  const panel = el.querySelector('[class*="bg-surface"]')
  const actions = [...el.querySelectorAll('button')].filter((b) => {
    const r = b.getBoundingClientRect()
    return r.width >= 8 && r.height >= 8 && (b.getAttribute('type') === 'submit' || /^(cancel|close)$/i.test(label(b)))
  })
  return { panel: panel ? rectOf(panel) : null, actions: actions.map((b) => ({ label: label(b), ...rectOf(b) })) }
}

function assertFull(m) {
  const bad = []
  const { rect, viewport } = m
  if (Math.abs(rect.x) > 0.5) bad.push(`x=${rect.x}`)
  if (Math.abs(rect.y) > 0.5) bad.push(`y=${rect.y} (margin-top ${m.marginTop})`)
  if (Math.abs(rect.w - viewport.w) > 0.5) bad.push(`width ${rect.w} != ${viewport.w}`)
  if (Math.abs(rect.h - viewport.h) > 0.5) bad.push(`height ${rect.h} != ${viewport.h}`)
  if (!m.topEdgeIsOverlay) bad.push(`top edge is ${m.topEdgeTag}, not the overlay`)
  return bad.length === 0 ? true : bad.join('; ')
}

// ─── accounts_backdrop_full_viewport ───────────────────────────────────────
async function accountsBackdropFullViewport(browser) {
  console.log('\naccounts_backdrop_full_viewport: the Add account dialog covers the viewport at 390x844 and 1280x800')
  const user = await seedUser('dba')
  for (const [sizeName, size] of Object.entries(SIZES)) {
    const { ctx, page } = await openPage(browser, user, size, '/accounts')
    try {
      const overlay = await openDialog(page, DIALOGS[1])
      const m = await overlay.evaluate(measureOverlay)
      await h.check(`accounts_backdrop_full_viewport.${sizeName}.has-top-nav`, 'S', async () => m.navCount > 0 || 'no nav element on the page')
      await h.check(`accounts_backdrop_full_viewport.${sizeName}.y-is-0`, 'B', async () =>
        Math.abs(m.rect.y) <= 0.5 || `overlay y=${m.rect.y} (margin-top ${m.marginTop})`)
      await h.check(`accounts_backdrop_full_viewport.${sizeName}.full-box`, 'B', async () => assertFull(m))
    } finally {
      await ctx.close()
    }
  }
}

// ─── all_pages_backdrop_full_viewport ──────────────────────────────────────
async function allPagesBackdropFullViewport(browser) {
  console.log('\nall_pages_backdrop_full_viewport: every shared-overlay dialog covers the viewport at both sizes')
  const user = await seedUser('dbb')
  for (const [sizeName, size] of Object.entries(SIZES)) {
    for (const dialog of DIALOGS) {
      const { ctx, page } = await openPage(browser, user, size, dialog.route)
      try {
        const overlay = await openDialog(page, dialog)
        const m = await overlay.evaluate(measureOverlay)
        await h.check(`all_pages_backdrop_full_viewport.${sizeName}.${dialog.name}`, 'B', async () => assertFull(m))
      } finally {
        await ctx.close()
      }
    }
  }
}

// ─── baseline-backed layout ────────────────────────────────────────────────
function readBaseline() {
  return fs.existsSync(BASELINE_FILE) ? JSON.parse(fs.readFileSync(BASELINE_FILE, 'utf8')) : null
}
const rectDiff = (a, b) => Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y), Math.abs(a.w - b.w), Math.abs(a.h - b.h))

async function collectLayouts(browser, user) {
  const got = {}
  for (const [sizeName, size] of Object.entries(SIZES)) {
    got[sizeName] = {}
    for (const dialog of DIALOGS) {
      const { ctx, page } = await openPage(browser, user, size, dialog.route)
      try {
        const overlay = await openDialog(page, dialog)
        got[sizeName][dialog.name] = await overlay.evaluate(layoutOf)
      } finally {
        await ctx.close()
      }
    }
  }
  return got
}

async function dialogLayoutUnchanged(browser) {
  console.log('\ndialog_layout_unchanged: panel and action buttons rise by exactly the removed margin; x and size match main')
  const user = await seedUser('dbc')
  const got = await collectLayouts(browser, user)
  if (WRITE) {
    fs.mkdirSync(path.dirname(BASELINE_FILE), { recursive: true })
    fs.writeFileSync(BASELINE_FILE, `${JSON.stringify(got, null, 2)}\n`)
    console.log(`  baseline written: ${Object.keys(got).join(', ')}`)
    return
  }
  const base = readBaseline()
  await h.check('dialog_layout_unchanged.baseline-exists', 'G', async () => !!base || 'no baseline; run with BASELINE=write on main')
  if (!base) return
  for (const sizeName of Object.keys(SIZES)) {
    for (const dialog of DIALOGS) {
      await h.check(`dialog_layout_unchanged.${sizeName}.${dialog.name}`, 'B', async () => {
        const want = base[sizeName] && base[sizeName][dialog.name]
        const have = got[sizeName][dialog.name]
        if (!want) return 'no baseline for this dialog'
        if (!want.panel || !have.panel) return `panel not found (have ${!!have.panel}, baseline ${!!want.panel})`
        if (want.actions.length !== have.actions.length) return `${have.actions.length} action buttons, baseline ${want.actions.length}`
        const pairs = [{ label: 'panel', have: have.panel, want: want.panel }, ...have.actions.map((r, i) => ({ label: r.label, have: r, want: want.actions[i] }))]
        const bad = []
        for (const p of pairs) {
          const dy = p.have.y - p.want.y
          const rest = rectDiff({ ...p.have, y: 0 }, { ...p.want, y: 0 })
          if (rest > TOL || Math.abs(dy + RISE[dialog.name]) > TOL) bad.push({ label: p.label, dy, expected: -RISE[dialog.name], rest })
        }
        return bad.length === 0 || `moved: ${JSON.stringify(bad)}`
      })
    }
  }
}

// ─── overlay_regressions ───────────────────────────────────────────────────
function runChild(file) {
  const r = spawnSync(process.execPath, [path.join(__dirname, file)], { encoding: 'utf8', env: process.env, timeout: 900000, maxBuffer: 64 * 1024 * 1024 })
  const out = `${r.stdout || ''}${r.stderr || ''}`
  const m = out.match(/RESULT: (\d+)\/(\d+)/)
  console.log(`  ${file}: exit ${r.status}, ${m ? `RESULT ${m[1]}/${m[2]}` : 'no RESULT line'}`)
  if (r.status !== 0) return `${file} exited ${r.status}: ${out.split('\n').filter((l) => /FAIL/.test(l)).slice(0, 4).join(' | ')}`
  if (!m || m[1] !== m[2] || Number(m[2]) === 0) return `${file} did not pass in full: ${m ? `${m[1]}/${m[2]}` : 'no RESULT line'}`
  return true
}

async function overlayRegressions() {
  console.log('\noverlay_regressions: dialog-tabbar.cjs and toast-placement.cjs, unchanged, as child processes')
  await h.check('overlay_regressions.dialog-tabbar', 'B', async () => runChild('dialog-tabbar.cjs'))
  await h.check('overlay_regressions.toast-placement', 'B', async () => runChild('toast-placement.cjs'))
}

// ─── quality_gates ─────────────────────────────────────────────────────────
async function qualityGates() {
  console.log('\nquality_gates: lint, tsc, build, unit tests')
  const run = (id, args, env = {}) => h.check(`quality_gates.${id}`, 'B', async () => {
    const r = spawnSync('pnpm', args, { cwd: FRONTEND, encoding: 'utf8', env: { ...process.env, ...env } })
    return r.status === 0 || `exit ${r.status}: ${(r.stdout + r.stderr).split('\n').slice(-8).join(' | ')}`
  })
  await run('lint', ['run', 'lint'])
  await run('tsc', ['exec', 'tsc', '--noEmit'])
  await run('build', ['run', 'build'], { VITE_API_URL: 'https://tally-and-trace-api.onrender.com' })
  await run('unit', ['test'])
}

const SCENARIOS = {
  accounts_backdrop_full_viewport: accountsBackdropFullViewport,
  all_pages_backdrop_full_viewport: allPagesBackdropFullViewport,
  dialog_layout_unchanged: dialogLayoutUnchanged,
  overlay_regressions: overlayRegressions,
  quality_gates: qualityGates,
}

async function main() {
  const needsStack = !(only === 'quality_gates' || only === 'overlay_regressions')
  if (needsStack) {
    try {
      stack = await startLocalStack()
      client = h.apiClient(stack)
    } catch (error) {
      console.error(`SETUP FAILED: ${error && error.message ? error.message : error}`)
      process.exit(2)
    }
  }
  const browser = await chromium.launch()
  let code = 1
  try {
    for (const [name, run] of Object.entries(SCENARIOS)) {
      if (only && only !== name) continue
      if (WRITE && name !== 'dialog_layout_unchanged') continue
      try {
        await run(browser)
      } catch (error) {
        await h.check(`${name}.ran`, 'S', () => `threw ${error && error.stack ? error.stack : error}`)
      }
    }
    code = WRITE ? 0 : h.report()
  } finally {
    await browser.close()
    if (stack) await stack.stop()
  }
  process.exit(code)
}

main()
