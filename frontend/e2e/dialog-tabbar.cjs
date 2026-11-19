// Browser checks for STU-635: at a phone width the bottom tab bar (BottomNav) never covers a
// dialog's fields or action buttons, with or without save toasts, and nothing else moves.
//   phone_dialog_actions_clear: 390x844, no toasts, the Add transaction dialog: every field
//       scrolled into view is unobscured by the tab bar, and at the end of the scroll every action
//       button (centre and inset corners, elementFromPoint) is unobscured and takes a click.
//   phone_all_dialogs_clear: the same check for the account, recurring-entry, category and tag
//       dialogs (all on the shared overlay).
//   phone_with_toasts_clear: 2 saves pending (held POSTs), the first scenario's check again; the
//       STU-629 toast-placement suite is then run unchanged as a child process and must pass in full.
//   desktop_unchanged: 1280x800, the action buttons of every dialog sit where they did on main (+-1px).
//   tabbar_unchanged: 390x844, no dialog open, the tab bar's bounding box matches main (+-1px).
//   quality_gates: lint, tsc and the build pass.
// The two "unchanged" scenarios compare with ./dialog-tabbar.baseline/main.json, taken on main
// cebf2c8 (before the fix) with BASELINE=write.
//
// Starts its own API and web app against a throwaway database (./_local_stack.cjs) and seeds
// through the API. Not wired into CI. Run steps: ./README.md. Condition waits only.
//
// Usage: node frontend/e2e/dialog-tabbar.cjs [scenario]     BASELINE=write to (re)take the baseline
const fs = require('fs')
const path = require('path')
const { spawnSync } = require('child_process')
const { startLocalStack } = require('./_local_stack.cjs')
const h = require('./_smooth.cjs')
const { pick } = require('./_picker.cjs')

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
const BASELINE_FILE = path.join(__dirname, 'dialog-tabbar.baseline', 'main.json')
const FRONTEND = path.join(__dirname, '..')

let stack, client

const PHONE = { width: 390, height: 844 }
const DESKTOP = { width: 1280, height: 800 }
const TOL = 1

const manilaToday = () => new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10)
const pathOf = (url) => new URL(url).pathname.replace(/\/$/, '')
const isCreate = (r) => r.method() === 'POST' && pathOf(r.url()).endsWith('/api/v1/transactions')
const tid = (id) => `[data-testid="${id}"]`
const settle = (page) => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(r, 60)))))

/** Every dialog on the shared overlay that the suite opens: where, how to open, its overlay. */
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
  const checking = await client.post(user.token, '/accounts/', { name: 'DT Checking', account_type: 'checking', balance: 500000, currency: 'PHP' })
  const today = manilaToday()
  for (let i = 0; i < 6; i++) {
    await client.post(user.token, '/transactions/', {
      account_id: checking.id, transaction_type: 'debit', amount: 100 + i, description: `DT Seed ${i}`,
      transaction_date: `${today}T00:00:00`,
    })
  }
  return { user, checking }
}

async function openPage(browser, user, size, route = '/transactions') {
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

/**
 * Runs in the page. For an open overlay: every field, scrolled to the centre of the overlay and
 * then (second pass) as it sits at the end of the scroll, must have no sampled point (centre and
 * the four inset corners) under the tab bar or the toast stack. Returns the problems found and the
 * overlay's action buttons as they sit at the end of the scroll.
 */
function probeOverlay(overlayEl) {
  const frames = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))
  const label = (el) => (el.getAttribute('aria-label') || el.textContent || el.getAttribute('name') || el.getAttribute('placeholder') || el.tagName).trim().replace(/\s+/g, ' ').slice(0, 32)
  const fieldsOf = () => [...overlayEl.querySelectorAll('input:not([type="hidden"]), select, textarea, button')].filter((el) => {
    const r = el.getBoundingClientRect()
    return r.width >= 8 && r.height >= 8 && getComputedStyle(el).visibility !== 'hidden'
  })
  const points = (el) => {
    const r = el.getBoundingClientRect()
    const dx = Math.min(4, r.width / 4)
    const dy = Math.min(4, r.height / 4)
    return [
      ['centre', r.left + r.width / 2, r.top + r.height / 2],
      ['topLeft', r.left + dx, r.top + dy], ['topRight', r.right - dx, r.top + dy],
      ['bottomLeft', r.left + dx, r.bottom - dy], ['bottomRight', r.right - dx, r.bottom - dy],
    ]
  }
  const covers = (el, when) => {
    const out = []
    for (const [name, x, y] of points(el)) {
      if (x < 0 || y < 0 || x >= window.innerWidth || y >= window.innerHeight) continue
      const top = document.elementFromPoint(x, y)
      if (!top || el.contains(top)) continue
      if (top.closest('nav.bottom-0')) out.push(`${label(el)} ${when} ${name}: under the tab bar`)
      else if (top.closest('[data-testid="toast-stack"]')) out.push(`${label(el)} ${when} ${name}: under a toast`)
    }
    return out
  }
  return (async () => {
    const problems = []
    const fields = fieldsOf()
    for (const el of fields) {
      el.scrollIntoView({ block: 'center', behavior: 'instant' })
      await frames()
      problems.push(...covers(el, 'scrolled to centre'))
    }
    overlayEl.scrollTo({ top: overlayEl.scrollHeight, behavior: 'instant' })
    await frames()
    for (const el of fieldsOf()) problems.push(...covers(el, 'at scroll end'))
    const actions = fieldsOf().filter((el) => el.tagName === 'BUTTON' && (el.getAttribute('type') === 'submit' || /^(cancel|close)$/i.test(label(el))))
    const nav = document.querySelector('nav.fixed.bottom-0')
    return {
      problems,
      fieldCount: fields.length,
      actionLabels: actions.map(label),
      actionRects: actions.map((el) => { const r = el.getBoundingClientRect(); return { label: label(el), x: r.x, y: r.y, w: r.width, h: r.height } }),
      navTop: nav ? nav.getBoundingClientRect().top : null,
    }
  })()
}

/** The phone check for one open dialog: placement of every field and action button, and that the buttons take a click. */
async function checkOpenDialog(page, overlay, prefix) {
  const probe = await overlay.evaluate(probeOverlay)
  await h.check(`${prefix}.has-fields-and-actions`, 'S', async () =>
    (probe.fieldCount > 0 && probe.actionLabels.length > 0) || `${probe.fieldCount} fields, actions: ${JSON.stringify(probe.actionLabels)}`)
  await h.check(`${prefix}.placement`, 'B', async () => (probe.problems.length === 0 ? true : [...new Set(probe.problems)].slice(0, 6).join('; ')))
  await h.check(`${prefix}.actions-clickable`, 'B', async () => {
    const buttons = overlay.locator('button[type="submit"], button:text-matches("^(Cancel|Close)$", "i")')
    const n = await buttons.count()
    for (let i = 0; i < n; i++) {
      const b = buttons.nth(i)
      if (!(await b.isVisible())) continue
      try {
        await b.click({ trial: true, timeout: 2500 })
      } catch (e) {
        return `action button ${i} not clickable: ${String(e.message).split('\n')[0]}`
      }
    }
    return true
  })
  return probe
}

/** Closes whatever dialog is open (Escape does not close every one: reload instead). */
async function reopen(page, route) {
  await page.goto(`${stack.webUrl}${route}`)
  await h.waitQuiet(page)
}

// ─── toast helpers (as in toast-placement.cjs) ─────────────────────────────
const toasts = (page) => page.locator(tid('save-toast'))
const formOf = (page) => page.locator('form').filter({ has: page.getByRole('button', { name: /^(Create|Update) Transaction$/ }) })

async function fillCreate(page, { accountName, amount, description }) {
  await page.getByRole('button', { name: 'Add transaction' }).first().click()
  const form = formOf(page)
  await form.waitFor()
  await form.locator('input[placeholder="Add notes about this transaction"]').fill(description)
  await pick(form.locator('[data-field="account_id"]'), accountName)
  await form.getByRole('button', { name: 'Expense', exact: true }).click()
  await form.locator('input[type="number"][placeholder="0.00"]').first().fill(String(amount))
  return form
}

async function createUI(page, opts) {
  const form = await fillCreate(page, opts)
  await form.locator('input[placeholder="Add notes about this transaction"]').press('Enter')
  await form.waitFor({ state: 'hidden' })
}

// ─── phone_dialog_actions_clear ────────────────────────────────────────────
async function phoneDialogActionsClear(browser) {
  console.log('\nphone_dialog_actions_clear: 390x844, no toasts, the Add transaction dialog')
  const { user } = await seedUser('dta')
  const { ctx, page } = await openPage(browser, user, PHONE)
  try {
    const overlay = await openDialog(page, DIALOGS[0])
    await h.check('phone_dialog_actions_clear.no-toasts', 'S', async () => (await toasts(page).count()) === 0 || 'toasts are showing')
    await checkOpenDialog(page, overlay, 'phone_dialog_actions_clear')
  } finally {
    await ctx.close()
  }
}

// ─── phone_all_dialogs_clear ───────────────────────────────────────────────
async function phoneAllDialogsClear(browser) {
  console.log('\nphone_all_dialogs_clear: 390x844, the account, recurring-entry, category and tag dialogs')
  const { user } = await seedUser('dtb')
  for (const dialog of DIALOGS.slice(1)) {
    const { ctx, page } = await openPage(browser, user, PHONE, dialog.route)
    try {
      const overlay = await openDialog(page, dialog)
      await checkOpenDialog(page, overlay, `phone_all_dialogs_clear.${dialog.name}`)
    } finally {
      await ctx.close()
    }
  }
}

// ─── phone_with_toasts_clear ───────────────────────────────────────────────
async function phoneWithToastsClear(browser) {
  console.log('\nphone_with_toasts_clear: 390x844, 2 saves pending, the Add transaction dialog')
  const { user, checking } = await seedUser('dtc')
  const { ctx, page } = await openPage(browser, user, PHONE)
  try {
    const held = await h.gate(page, isCreate)
    for (let i = 0; i < 2; i++) await createUI(page, { accountName: checking.name, amount: 200 + i, description: `DT Pending ${i + 1}` })
    await page.locator(`${tid('save-toast')}[data-state="pending"]`).nth(1).waitFor()
    if (!(await held.waitHits(1))) throw new Error('no POST reached the hold')
    await h.check('phone_with_toasts_clear.two-pending', 'S', async () => (await toasts(page).count()) === 2 || `${await toasts(page).count()} toasts`)
    const form = await fillCreate(page, { accountName: checking.name, amount: 999, description: 'DT Third' })
    const overlay = form.locator('xpath=ancestor::div[contains(@class,"fixed")][1]')
    await settle(page)
    await checkOpenDialog(page, overlay, 'phone_with_toasts_clear')
    held.release({ disarm: true })
  } finally {
    await ctx.close()
  }
  // AC3: the STU-629 suite, unchanged, as a child process with this run's env, passes in full.
  await h.check('phone_with_toasts_clear.toast-placement-suite', 'B', async () => {
    const r = spawnSync(process.execPath, [path.join(__dirname, 'toast-placement.cjs')], { encoding: 'utf8', env: process.env, timeout: 600000, maxBuffer: 64 * 1024 * 1024 })
    const out = `${r.stdout || ''}${r.stderr || ''}`
    const m = out.match(/RESULT: (\d+)\/(\d+)/)
    console.log(`  toast-placement: exit ${r.status}, ${m ? `RESULT ${m[1]}/${m[2]}` : 'no RESULT line'}`)
    if (r.status !== 0) return `toast-placement exited ${r.status}: ${out.split('\n').filter((l) => /FAIL/.test(l)).slice(0, 4).join(' | ')}`
    if (!m || m[1] !== m[2] || Number(m[2]) === 0) return `toast-placement did not pass in full: ${m ? `${m[1]}/${m[2]}` : 'no RESULT line'}`
    return true
  })
}

// ─── baseline-backed scenarios ─────────────────────────────────────────────
function readBaseline() {
  return fs.existsSync(BASELINE_FILE) ? JSON.parse(fs.readFileSync(BASELINE_FILE, 'utf8')) : null
}
function writeBaseline(patch) {
  const current = readBaseline() || {}
  fs.mkdirSync(path.dirname(BASELINE_FILE), { recursive: true })
  fs.writeFileSync(BASELINE_FILE, `${JSON.stringify({ ...current, ...patch }, null, 2)}\n`)
}
const rectDiff = (a, b) => Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y), Math.abs(a.w - b.w), Math.abs(a.h - b.h))

async function desktopUnchanged(browser) {
  console.log('\ndesktop_unchanged: 1280x800, action buttons match main (+-1px)')
  const { user } = await seedUser('dtd')
  const got = {}
  for (const dialog of DIALOGS) {
    const { ctx, page } = await openPage(browser, user, DESKTOP, dialog.route)
    try {
      const overlay = await openDialog(page, dialog)
      const probe = await overlay.evaluate(probeOverlay)
      got[dialog.name] = probe.actionRects
    } finally {
      await ctx.close()
    }
  }
  if (WRITE) {
    writeBaseline({ desktop: got })
    console.log('  baseline written: desktop')
    return
  }
  const base = (readBaseline() || {}).desktop
  await h.check('desktop_unchanged.baseline-exists', 'G', async () => !!base || 'no baseline; run with BASELINE=write on main')
  if (!base) return
  for (const dialog of DIALOGS) {
    await h.check(`desktop_unchanged.${dialog.name}`, 'B', async () => {
      const want = base[dialog.name]
      const have = got[dialog.name]
      if (!want) return 'no baseline for this dialog'
      if (want.length !== have.length) return `${have.length} action buttons, baseline ${want.length}`
      const bad = have.map((r, i) => ({ label: r.label, diff: rectDiff(r, want[i]) })).filter((r) => r.diff > TOL)
      return bad.length === 0 || `moved: ${JSON.stringify(bad)}`
    })
  }
}

async function tabbarUnchanged(browser) {
  console.log('\ntabbar_unchanged: 390x844, no dialog, the tab bar matches main (+-1px)')
  const { user } = await seedUser('dte')
  const { ctx, page } = await openPage(browser, user, PHONE)
  let got
  try {
    await settle(page)
    got = await page.locator('nav.fixed.bottom-0').evaluate((el) => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height } })
  } finally {
    await ctx.close()
  }
  if (WRITE) {
    writeBaseline({ tabbar: got })
    console.log(`  baseline written: tabbar ${JSON.stringify(got)}`)
    return
  }
  const base = (readBaseline() || {}).tabbar
  await h.check('tabbar_unchanged.baseline-exists', 'G', async () => !!base || 'no baseline; run with BASELINE=write on main')
  if (!base) return
  await h.check('tabbar_unchanged.box', 'B', async () => rectDiff(got, base) <= TOL || `box ${JSON.stringify(got)}, baseline ${JSON.stringify(base)}`)
}

// ─── quality_gates ─────────────────────────────────────────────────────────
async function qualityGates() {
  console.log('\nquality_gates: lint, tsc, build')
  const run = (id, args, env = {}) => h.check(`quality_gates.${id}`, 'B', async () => {
    const r = spawnSync('pnpm', args, { cwd: FRONTEND, encoding: 'utf8', env: { ...process.env, ...env } })
    return r.status === 0 || `exit ${r.status}: ${(r.stdout + r.stderr).split('\n').slice(-8).join(' | ')}`
  })
  await run('lint', ['run', 'lint'])
  await run('tsc', ['exec', 'tsc', '--noEmit'])
  await run('build', ['run', 'build'], { VITE_API_URL: 'https://tally-and-trace-api.onrender.com' })
}

const SCENARIOS = {
  phone_dialog_actions_clear: phoneDialogActionsClear,
  phone_all_dialogs_clear: phoneAllDialogsClear,
  phone_with_toasts_clear: phoneWithToastsClear,
  desktop_unchanged: desktopUnchanged,
  tabbar_unchanged: tabbarUnchanged,
  quality_gates: qualityGates,
}

async function main() {
  const needsStack = !(only === 'quality_gates')
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
      if (WRITE && !/_unchanged$/.test(name)) continue
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
