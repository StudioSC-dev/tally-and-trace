// STU-210: the colour tokens take Tailwind opacity modifiers (`bg-paper/85`, `divide-line/50`).
// Checked in a real browser against a local API and web app on a throwaway database
// (./_local_stack.cjs; the fixed user and seed are in ./_tokens_fixture.cjs). Not wired into
// CI and not part of `pnpm build`. Run steps: see ./README.md.
//
// Scenarios (one per acceptance criterion):
//   a.nav-translucent    AC1  the nav's computed background alpha is 0.85, light and dark
//   b.alpha-usages       AC2  every entry of tokens-alpha.inventory.json resolves to its alpha and token colour;
//                              b.inventory-complete: the inventory lists every occurrence in src
//   c.solid-same         AC3  ten sample elements keep the colours recorded in tokens-alpha.manifest.json
//   d.theme-switch       AC4  the data-theme path and the prefers-color-scheme (no data-theme) path still switch
//   e.direct-colour-vars AC5  no bare token variable sits in a colour expression outside rgb(...)
//   f.toolchain          AC6  `pnpm build` (tsc + vite build) and `pnpm lint` exit 0
//   h.visual-regression  AC8  every manifest route and state, both themes and viewports, matches the baseline
//                              screenshots except inside the inventoried opacity-modifier elements
//
// Regression data (AC3, AC8). The manifest and inventory were recorded on 75cba71, the post-STU-188
// main, before any token change. To re-record on such a tree (not on the changed tree):
//   node frontend/e2e/tokens-alpha.cjs --record-manifest              samples' computed colours into the manifest
//   node frontend/e2e/tokens-alpha.cjs --capture-shots <dir>          baseline screenshots + element rectangles + provenance
//   node frontend/e2e/tokens-alpha.cjs --measure-noise <dir> [n]      renderer noise envelope into the manifest (n repeats, default 4)
// --record-manifest also records every token's computed colour on the light, dark-class and dark-media paths.
// h.visual-regression needs the baseline directory: TOKENS_BASELINE_DIR=<dir>. The baseline is
// not checked in (binary, machine-specific); capture it from a worktree of the base commit on
// the same database. The baseline records the base SHA, a hash of the base web source, the
// fixture, manifest and inventory; h.baseline-binding refuses a baseline that is not the base
// commit's (base = TOKENS_BASE_SHA, else `git merge-base HEAD origin/main`). The run fails when it is not set. TOKENS_SAVE_DIR=<dir> keeps the
// screenshots that differ outside the allowed boxes.
//
// Visual rule: the comparison is exact (zero pixels) everywhere except inside the bounding
// boxes of the elements that carry a non-hover opacity-modifier class from the inventory
// (the baseline run records those boxes; the compared run adds its own). A screen is shot until two attempts
// match exactly outside them (at most four), and every attempt must stay inside the noise
// envelope measured on the base tree (manifest.renderNoise); one past it fails the screen. Pixels changed
// inside them are listed per screen; pixels changed outside fail the check.
//
// Revert-and-fail (AC7): put `paper: 'var(--paper)'` back in tailwind.config.js in place of
// `rgb(var(--paper) / <alpha-value>)`; a.nav-translucent must then fail.
//
// Setup: a throwaway database named tt_test_210_*, exported as DATABASE_URL, plus
// PLAYWRIGHT_PATH and VIRTUAL_ENV (see ./README.md).
//
// Check kinds: [B] behavioural, [S] structural, [G] guard. Ends with RESULT: k/m and exits
// 0 only when every check passed, 1 when any failed, 2 for setup.
//
// Usage: node frontend/e2e/tokens-alpha.cjs [scenario]
const fs = require('fs')
const pathMod = require('path')
const crypto = require('crypto')
const { spawnSync, execFileSync } = require('child_process')
const { startLocalStack } = require('./_local_stack.cjs')
const h = require('./_smooth.cjs')
const fx = require('./_tokens_fixture.cjs')

const playwrightPath = process.env.PLAYWRIGHT_PATH || 'playwright'
let chromium
try {
  ;({ chromium } = require(playwrightPath))
} catch {
  console.error(`Cannot load Playwright from "${playwrightPath}". Set PLAYWRIGHT_PATH (see frontend/e2e/README.md).`)
  process.exit(2)
}

const REPO = pathMod.resolve(__dirname, '..', '..')
const SRC = pathMod.join(REPO, 'frontend', 'src')
const THEMES = ['light', 'dark']
const argv = process.argv.slice(2)
const flag = (name) => argv.includes(name)
const flagValue = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined }
const only = argv.find((a, i) => !a.startsWith('--') && !['--capture-shots', '--measure-noise'].includes(argv[i - 1]) && !/^\d+$/.test(a))

const manifest = fx.readJson(fx.MANIFEST)
const inventory = fx.readJson(fx.INVENTORY)
const DESKTOP = { width: 1280, height: 800 }
// Software rasterising with no hinting or LCD text, so one machine draws the same text pixels on
// every run; without these two runs of one tree differed by a few thousand text pixels.
const PIXEL_TOLERANCE = Number(process.env.TOKENS_PIXEL_TOLERANCE || 0)
const RENDER_ARGS = ['--disable-gpu', '--disable-lcd-text', '--font-render-hinting=none', '--disable-font-subpixel-positioning', '--force-color-profile=srgb']

// ─── Colours ────────────────────────────────────────────────────────────────

const hexToRgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16))
/** [r, g, b, a] from a computed colour, or null. Handles rgb(), rgba() and the space syntax. */
function parseColour(text) {
  const m = /^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:\s*[,/]\s*([\d.]+%?))?\s*\)$/.exec(String(text || '').trim())
  if (!m) return null
  let a = m[4] === undefined ? 1 : m[4].endsWith('%') ? parseFloat(m[4]) / 100 : parseFloat(m[4])
  return [Number(m[1]), Number(m[2]), Number(m[3]), a]
}
const tokenRgb = (token, theme) => hexToRgb(manifest.tokens[token][THEMES.indexOf(theme)])
const sameRgb = (c, rgb) => c && c[0] === rgb[0] && c[1] === rgb[1] && c[2] === rgb[2]

// ─── Setup ──────────────────────────────────────────────────────────────────

let stack, client, user, browser, state

async function setup() {
  stack = await startLocalStack()
  client = h.apiClient(stack)
  user = await fx.ensureUser(stack, client)
  browser = await chromium.launch({ args: RENDER_ARGS })
  state = await fx.signedInState(browser, stack, user)
}

const tid = (id) => `[data-testid="${id}"]`
const isGet = (suffix) => (r) => r.method() === 'GET' && new URL(r.url()).pathname.endsWith(suffix)

/** The page from a fresh context for one theme and viewport. */
const pageFor = (theme, viewport = DESKTOP) => fx.openPage(browser, state, { theme, viewport })

// ─── Reaching the states the inventory and the screenshots need ─────────────

/** Adds Household "paid from other accounts" rows to the spending summary, from categories it already has. */
async function addHouseholdRows(page) {
  return h.rewrite(page, isGet('/transactions/summary/period'), (body) => {
    const row = (body.by_currency || [])[0]
    const names = Object.keys((row && row.category_breakdown) || {}).slice(0, 2)
    if (!row || names.length === 0) return body
    const breakdown = {}
    names.forEach((n, i) => { breakdown[n] = 700 + i * 300 })
    return {
      ...body,
      household_private: [{ currency: row.currency, total_expenses: 1700, transaction_count: names.length, category_breakdown: breakdown }],
    }
  })
}

async function openBreakdown(page, stackRef) {
  await addHouseholdRows(page)
  await fx.gotoRoute(page, stackRef, '/transactions')
  await page.getByRole('button', { name: 'Spending breakdown' }).click()
  await page.locator('section', { hasText: 'Household: paid from other accounts' }).waitFor({ timeout: 15000 })
  await fx.settle(page)
}

async function openAccountModal(page, stackRef) {
  await fx.gotoRoute(page, stackRef, '/accounts')
  await page.getByText('Everyday Checking').first().click()
  await page.getByRole('button', { name: 'Edit account' }).waitFor({ timeout: 15000 })
  await fx.settle(page)
}

/** Brings `page` to the named state. Returns a cleanup function. */
async function reach(page, stateName) {
  if (stateName.startsWith('route:')) {
    await fx.gotoRoute(page, stack, stateName.slice('route:'.length))
    return async () => {}
  }
  if (stateName === 'dashboard-timeline-pending') {
    const g = await h.gate(page, isGet('/forecast/timeline'))
    await page.goto(`${stack.webUrl}/`)
    await page.locator(tid('timeline-pending')).waitFor({ timeout: 30000 })
    return async () => g.release({ disarm: true })
  }
  if (stateName === 'wishlist-tab') {
    await fx.gotoRoute(page, stack, '/allocations')
    await page.getByRole('button', { name: 'Wishlist', exact: true }).click()
    await page.locator('ol.divide-line\\/50').waitFor({ timeout: 15000 })
    await fx.settle(page)
    return async () => {}
  }
  if (stateName === 'breakdown-dialog') { await openBreakdown(page, stack); return async () => {} }
  if (stateName === 'account-modal') { await openAccountModal(page, stack); return async () => {} }
  if (stateName === 'account-edit') {
    await openAccountModal(page, stack)
    await page.getByRole('button', { name: 'Edit account' }).click()
    await page.locator('.bg-surface\\/50').first().waitFor({ timeout: 15000 })
    await fx.settle(page)
    return async () => {}
  }
  throw new Error(`unknown state ${stateName}`)
}

// ─── Reading computed styles ────────────────────────────────────────────────

/** Computed `prop` of the element a selector (and optional index / child target) names; { found, value }. */
async function readStyle(page, { selector, index, target, property, hover }) {
  const locator = page.locator(selector).nth(index === undefined ? 0 : index)
  if ((await page.locator(selector).count()) === 0) return { found: 0, values: [] }
  if (hover) {
    await locator.scrollIntoViewIfNeeded()
    await locator.hover()
    await h.sleep(450)
  }
  return page.evaluate(({ selector, index, target, property, all }) => {
    const nodes = all ? Array.from(document.querySelectorAll(selector)) : [document.querySelectorAll(selector)[index || 0]]
    const values = nodes.filter(Boolean).map((n) => {
      const el = target ? n.querySelector(target) : n
      return el ? getComputedStyle(el)[property] : null
    })
    return { found: nodes.filter(Boolean).length, values }
  }, { selector, index, target, property, all: index === undefined && !hover })
}

// ─── Every token, every theme path ──────────────────────────────────────────

/** The three ways a token gets its value: the light default, the data-theme=dark block, the no-attribute media block. */
const TOKEN_PATHS = ['light', 'dark-class', 'dark-media']

/** Puts the page on one theme path. */
async function setPath(page, path) {
  if (path === 'light') { await page.emulateMedia({ colorScheme: 'light' }); await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'light')) }
  else if (path === 'dark-class') { await page.emulateMedia({ colorScheme: 'light' }); await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark')) }
  else { await page.emulateMedia({ colorScheme: 'dark' }); await page.evaluate(() => document.documentElement.removeAttribute('data-theme')) }
}

/**
 * One probe element per token. Its colour is the token as the stylesheet defines it, read
 * whatever the format (a hex value before the conversion, "r g b" channels after) and
 * resolved by the browser; the computed colour is returned. An unusable value comes back as
 * "invalid" rather than the colour the probe inherits.
 */
function probeTokens(page, tokens) {
  return page.evaluate((names) => {
    const root = getComputedStyle(document.documentElement)
    const out = {}
    for (const name of names) {
      const raw = root.getPropertyValue(`--${name}`).trim()
      const el = document.createElement('span')
      el.setAttribute('data-token-probe', name)
      el.style.color = raw.startsWith('#') ? raw : `rgb(${raw})`
      document.body.appendChild(el)
      out[name] = el.style.color === '' ? 'invalid' : getComputedStyle(el).color
      el.remove()
    }
    return out
  }, tokens)
}

// ─── Recording (run on the unchanged tree) ──────────────────────────────────

async function recordManifest() {
  const PROPS = ['color', 'backgroundColor', 'borderTopColor']
  for (const sample of manifest.samples) {
    sample.values = {}
    for (const theme of THEMES) {
      const { ctx, page } = await pageFor(theme)
      await fx.gotoRoute(page, stack, sample.route)
      const values = await page.evaluate(({ selector, props }) => {
        const el = document.querySelector(selector)
        if (!el) return null
        const cs = getComputedStyle(el)
        return Object.fromEntries(props.map((p) => [p, cs[p]]))
      }, { selector: sample.selector, props: PROPS })
      await ctx.close()
      if (!values) throw new Error(`sample ${sample.id}: no element for ${sample.selector} on ${sample.route} (${theme})`)
      sample.values[theme] = values
    }
  }
  // Every token's computed colour on every theme path, from the base stylesheet.
  manifest.tokenProbe = {}
  const { ctx, page } = await pageFor('light')
  await fx.gotoRoute(page, stack, '/')
  for (const path of TOKEN_PATHS) {
    await setPath(page, path)
    manifest.tokenProbe[path] = await probeTokens(page, Object.keys(manifest.tokens))
  }
  await ctx.close()
  manifest.recordedOn = manifest.baseCommit
  fs.writeFileSync(fx.MANIFEST, `${JSON.stringify(manifest, null, 2)}\n`)
  console.log(`recorded ${manifest.samples.length} samples into ${fx.MANIFEST}`)
}

/** The selector of every element whose appearance the change is meant to alter (non-hover inventory classes). */
function maskSelector() {
  const classes = [...new Set(inventory.entries.filter((e) => !e.hover).map((e) => e.class))]
  return classes.map((c) => `.${c.replace(/\//g, '\\/')}`).join(', ')
}

/** Every screen the visual comparison covers: manifest routes and states, per viewport and theme. */
function screens() {
  const out = []
  for (const vp of manifest.viewports) {
    for (const theme of THEMES) {
      for (const route of manifest.routes) out.push({ vp, theme, name: route === '/' ? 'home' : route.slice(1).replace(/\//g, '_'), stateName: `route:${route}` })
      for (const s of manifest.states) out.push({ vp, theme, name: s, stateName: s })
    }
  }
  return out.map((s) => ({ ...s, key: `${s.vp.name}-${s.theme}-${s.name}` }))
}

/** Screenshot (PNG buffer) and mask rectangles (page pixels) of one screen. */
async function shoot(screen) {
  const { ctx, page } = await pageFor(screen.theme, { width: screen.vp.width, height: screen.vp.height })
  try {
    const cleanup = await reach(page, screen.stateName)
    await page.evaluate(() => document.fonts.ready)
    await page.evaluate(() => window.scrollTo(0, 0))
    await h.sleep(300)
    const dialog = screen.stateName === 'breakdown-dialog' || screen.stateName === 'account-modal'
    const rects = await page.evaluate((sel) => Array.from(document.querySelectorAll(sel)).map((el) => {
      const r = el.getBoundingClientRect()
      return { x: r.left + window.scrollX, y: r.top + window.scrollY, w: r.width, h: r.height }
    }).filter((r) => r.w > 0 && r.h > 0), maskSelector())
    // A shot taken while a transition or a font swap is still settling differs from the next one:
    // take shots until two in a row are identical (at most eight).
    const take = () => page.screenshot({ fullPage: !dialog, animations: 'disabled', caret: 'hide' })
    let png = await take()
    for (let i = 0; i < 8; i++) {
      await h.sleep(250)
      const next = await take()
      const same = next.equals(png)
      png = next
      if (same) break
    }
    await cleanup()
    return { png, rects }
  } finally {
    await ctx.close()
  }
}


// ─── Binding a baseline to the base commit and the fixture ──────────────────

const sha256 = (...parts) => { const hash = crypto.createHash('sha256'); parts.forEach((x) => hash.update(x)); return hash.digest('hex') }
const git = (args, opts = {}) => execFileSync('git', args, { cwd: REPO, maxBuffer: 256 * 1024 * 1024, ...opts })
const SRC_ROOTS = ['frontend/src', 'frontend/tailwind.config.js', 'frontend/index.html']

/** The base commit: TOKENS_BASE_SHA when given, else `git merge-base HEAD origin/main`. */
function baseSha() {
  if (process.env.TOKENS_BASE_SHA) return git(['rev-parse', process.env.TOKENS_BASE_SHA], { encoding: 'utf8' }).trim()
  return git(['merge-base', 'HEAD', 'origin/main'], { encoding: 'utf8' }).trim()
}

/** Hash of the web source (src, tailwind config, index.html) as committed at `rev`, or in the working tree when rev is null. */
function sourceHash(rev) {
  let files
  if (rev) files = git(['ls-tree', '-r', '--name-only', rev, '--', ...SRC_ROOTS], { encoding: 'utf8' }).split('\n').filter(Boolean)
  else {
    const walk = (rel) => {
      const abs = pathMod.join(REPO, rel)
      if (!fs.existsSync(abs)) return []
      return fs.statSync(abs).isDirectory() ? fs.readdirSync(abs).flatMap((n) => walk(pathMod.join(rel, n))) : [rel]
    }
    files = SRC_ROOTS.flatMap(walk)
  }
  const hash = crypto.createHash('sha256')
  for (const f of files.sort()) {
    hash.update(`${f}\0`)
    hash.update(rev ? git(['show', `${rev}:${f}`]) : fs.readFileSync(pathMod.join(REPO, f)))
    hash.update('\0')
  }
  return hash.digest('hex')
}

/** Hash of the fixture: its seed source and what the database actually holds from it. */
async function fixtureHash() {
  const get = (url) => client.get(user.token, url)
  const accounts = (await get('/accounts/')).items.map((a) => [a.name, a.account_type, a.balance]).sort()
  const tags = (await get('/tags/')).map((t) => [t.name, t.color]).sort()
  const wishlist = (await get('/wishlist/')).map((w) => [w.name, w.estimated_cost, w.priority]).sort()
  return sha256(fs.readFileSync(pathMod.join(__dirname, '_tokens_fixture.cjs')), JSON.stringify({ accounts, tags, wishlist }))
}

const fileHash = (file) => {
  // The noise envelope is measured after the baseline is captured, so it is left out of the manifest's hash.
  if (file === fx.MANIFEST) { const m = JSON.parse(fs.readFileSync(file, 'utf8')); delete m.renderNoise; return sha256(JSON.stringify(m)) }
  return sha256(fs.readFileSync(file))
}
const rendererKey = () => sha256(JSON.stringify(RENDER_ARGS))

/** What a baseline records about where it came from. */
async function baselineMeta() {
  return {
    baseSha: baseSha(),
    capturedHead: git(['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    sourceHash: sourceHash(null),
    fixtureHash: await fixtureHash(),
    manifestHash: fileHash(fx.MANIFEST),
    inventoryHash: fileHash(fx.INVENTORY),
    rendererKey: rendererKey(),
  }
}

/** The reasons a baseline's meta is not the base commit's on this fixture, or []. */
async function refuseBaseline(meta) {
  if (!meta) return ['rects.json has no meta: capture the baseline again with --capture-shots']
  const want = baseSha()
  const bad = []
  if (meta.baseSha !== want) bad.push(`baseline is for ${meta.baseSha}, base is ${want}`)
  const baseSource = sourceHash(want)
  if (meta.sourceHash !== baseSource) bad.push('baseline screenshots were not captured from the base commit\'s web source')
  if (meta.fixtureHash !== await fixtureHash()) bad.push('fixture data differs from the baseline\'s')
  if (meta.manifestHash !== fileHash(fx.MANIFEST)) bad.push('manifest changed since the baseline')
  if (meta.inventoryHash !== fileHash(fx.INVENTORY)) bad.push('inventory changed since the baseline')
  if (meta.rendererKey !== rendererKey()) bad.push('renderer flags changed since the baseline')
  return bad
}

async function captureShots(dir) {
  fs.mkdirSync(dir, { recursive: true })
  const rects = {}
  for (const screen of screens()) {
    const { png, rects: r } = await shoot(screen)
    fs.writeFileSync(pathMod.join(dir, `${screen.key}.png`), png)
    rects[screen.key] = r
    console.log(`captured ${screen.key} (${r.length} mask boxes)`)
  }
  fs.writeFileSync(pathMod.join(dir, 'rects.json'), JSON.stringify({ meta: await baselineMeta(), rects }))
}

/** Pixel diff of two PNG buffers in a blank page; changed pixels inside and outside the boxes. */
async function diffPngs(page, a, b, boxes) {
  return page.evaluate(async ({ a, b, boxes, tolerance }) => {
    const load = (data) => new Promise((resolve, reject) => {
      const img = new Image()
      img.onload = () => resolve(img)
      img.onerror = () => reject(new Error('png did not decode'))
      img.src = `data:image/png;base64,${data}`
    })
    const [ia, ib] = await Promise.all([load(a), load(b)])
    if (ia.width !== ib.width || ia.height !== ib.height) return { sizeA: [ia.width, ia.height], sizeB: [ib.width, ib.height] }
    const w = ia.width, hgt = ia.height
    const px = (img) => {
      const c = document.createElement('canvas'); c.width = w; c.height = hgt
      const g = c.getContext('2d', { willReadFrequently: true }); g.drawImage(img, 0, 0)
      return g.getImageData(0, 0, w, hgt).data
    }
    const da = px(ia), db = px(ib)
    const inBox = new Uint8Array(w * hgt)
    for (const r of boxes) {
      for (let y = Math.max(0, Math.floor(r.y)); y < Math.min(hgt, Math.ceil(r.y + r.h)); y++) {
        for (let x = Math.max(0, Math.floor(r.x)); x < Math.min(w, Math.ceil(r.x + r.w)); x++) inBox[y * w + x] = 1
      }
    }
    let inside = 0, outside = 0, firstOutside = null, maxOutside = 0
    let minX = w, minY = hgt, maxX = -1, maxY = -1
    for (let i = 0; i < w * hgt; i++) {
      const o = i * 4
      const delta = Math.max(Math.abs(da[o] - db[o]), Math.abs(da[o + 1] - db[o + 1]), Math.abs(da[o + 2] - db[o + 2]), Math.abs(da[o + 3] - db[o + 3]))
      if (delta <= tolerance) continue
      if (inBox[i]) inside++
      else {
        outside++
        if (delta > maxOutside) maxOutside = delta
        const x = i % w, y = Math.floor(i / w)
        if (!firstOutside) firstOutside = [x, y]
        minX = Math.min(minX, x); minY = Math.min(minY, y); maxX = Math.max(maxX, x); maxY = Math.max(maxY, y)
      }
    }
    return { size: [w, hgt], inside, outside, maxOutside, firstOutside, outsideBox: outside ? [minX, minY, maxX, maxY] : null }
  }, { a: a.toString('base64'), b: b.toString('base64'), boxes, tolerance: PIXEL_TOLERANCE })
}

// ─── Scenarios ──────────────────────────────────────────────────────────────

async function scenarioA() {
  console.log('a. nav-translucent')
  for (const theme of THEMES) {
    await h.check(`a.nav-translucent.${theme}`, 'B', async () => {
      const { ctx, page } = await pageFor(theme)
      try {
        await fx.gotoRoute(page, stack, '/')
        const bg = parseColour(await page.evaluate(() => getComputedStyle(document.querySelector('nav')).backgroundColor))
        if (!bg) return 'nav background is not a colour'
        if (Math.abs(bg[3] - 0.85) > 0.005) return `nav background alpha ${bg[3]}, expected 0.85`
        if (!sameRgb(bg, tokenRgb('paper', theme))) return `nav background rgb ${bg.slice(0, 3)} is not the paper token`
      } finally { await ctx.close() }
    })
  }
}

async function scenarioB() {
  console.log('b. alpha-usages')
  await h.check('b.inventory-complete', 'S', async () => {
    const found = []
    const re = /\b((?:[a-z-]+:)*)(bg|text|border|divide|ring|fill|stroke|from|to|via|outline|shadow|placeholder|decoration|accent|caret)-(paper|surface|sunken|line|line-strong|ink|body|muted|ok|warn|info|danger)\/(\d+|\[)/g
    const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => (d.isDirectory() ? walk(pathMod.join(dir, d.name)) : [pathMod.join(dir, d.name)]))
    for (const file of walk(SRC).filter((f) => /\.(tsx?|css)$/.test(f))) {
      fs.readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
        for (const m of line.matchAll(re)) found.push(`${pathMod.relative(REPO, file)}:${i + 1}:${m[0]}`)
      })
    }
    const listed = inventory.entries.map((e) => `${e.file}:${e.line}:${e.class}`)
    const missing = found.filter((f) => !listed.includes(f))
    const stale = listed.filter((f) => !found.includes(f))
    if (inventory.entries.length !== inventory.counts.occurrences) return `inventory lists ${inventory.entries.length}, counts say ${inventory.counts.occurrences}`
    if (missing.length || stale.length) return `in src, not in inventory: ${JSON.stringify(missing)}; in inventory, not in src: ${JSON.stringify(stale)}`
  })
  const byState = {}
  for (const entry of inventory.entries) (byState[entry.state] ||= []).push(entry)
  const bad = []
  for (const theme of THEMES) {
    for (const [stateName, entries] of Object.entries(byState)) {
      const { ctx, page } = await pageFor(theme)
      try {
        const cleanup = await reach(page, stateName)
        for (const entry of entries) {
          const { found, values } = await readStyle(page, entry)
          if (!found) { bad.push(`${entry.id} (${theme}): no element for ${entry.selector}`); continue }
          for (const v of values) {
            const c = parseColour(v)
            if (!c) bad.push(`${entry.id} (${theme}): ${entry.property} is "${v}"`)
            else if (Math.abs(c[3] - entry.expectedAlpha) > 0.005) bad.push(`${entry.id} (${theme}): alpha ${c[3]}, expected ${entry.expectedAlpha}`)
            else if (!sameRgb(c, tokenRgb(entry.token, theme))) bad.push(`${entry.id} (${theme}): rgb ${c.slice(0, 3)} is not the ${entry.token} token`)
          }
        }
        await cleanup()
      } catch (e) {
        bad.push(`${stateName} (${theme}): ${String(e.message).split('\n')[0]}`)
      } finally { await ctx.close() }
    }
  }
  await h.check('b.alpha-usages', 'B', async () => (bad.length ? bad.join('; ') : true))
}

async function scenarioC() {
  console.log('c. solid-same')
  await h.check('c.solid-same.manifest-recorded', 'S', async () => (
    manifest.samples.length === 10 && manifest.samples.every((s) => s.values && s.values.light && s.values.dark) ? true : 'manifest does not hold ten recorded samples'
  ))
  const bad = []
  for (const theme of THEMES) {
    const { ctx, page } = await pageFor(theme)
    try {
      let route = null
      for (const sample of manifest.samples) {
        if (!sample.values) continue
        if (route !== sample.route) { await fx.gotoRoute(page, stack, sample.route); route = sample.route }
        const now = await page.evaluate((selector) => {
          const el = document.querySelector(selector)
          if (!el) return null
          const cs = getComputedStyle(el)
          return { color: cs.color, backgroundColor: cs.backgroundColor, borderTopColor: cs.borderTopColor }
        }, sample.selector)
        if (!now) { bad.push(`${sample.id} (${theme}): no element`); continue }
        for (const prop of ['color', 'backgroundColor', 'borderTopColor']) {
          if (now[prop] !== sample.values[theme][prop]) bad.push(`${sample.id} (${theme}) ${prop}: ${now[prop]} != recorded ${sample.values[theme][prop]}`)
        }
      }
    } finally { await ctx.close() }
  }
  await h.check('c.solid-same', 'B', async () => (bad.length ? bad.join('; ') : true))
}

async function scenarioD() {
  console.log('d. theme-switch')
  const probe = (page) => page.evaluate(() => ({
    htmlBg: getComputedStyle(document.documentElement).backgroundColor,
    bodyColor: getComputedStyle(document.body).color,
    attr: document.documentElement.getAttribute('data-theme'),
  }))
  const expectTheme = (got, theme) => {
    const bg = parseColour(got.htmlBg), fg = parseColour(got.bodyColor)
    if (!sameRgb(bg, tokenRgb('paper', theme))) return `${theme}: page background ${got.htmlBg}`
    if (!sameRgb(fg, tokenRgb('body', theme))) return `${theme}: body text ${got.bodyColor}`
    return null
  }
  await h.check('d.theme-switch.class', 'B', async () => {
    const { ctx, page } = await pageFor('light')
    try {
      await fx.gotoRoute(page, stack, '/')
      let bad = expectTheme(await probe(page), 'light')
      if (bad) return bad
      await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'))
      bad = expectTheme(await probe(page), 'dark')
      if (bad) return bad
      await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'light'))
      return expectTheme(await probe(page), 'light') || true
    } finally { await ctx.close() }
  })
  await h.check('d.theme-switch.toggle-button', 'B', async () => {
    const { ctx, page } = await pageFor('light')
    try {
      await fx.gotoRoute(page, stack, '/')
      await page.getByRole('button', { name: /dark|theme/i }).first().click()
      const bad = expectTheme(await probe(page), 'dark')
      return bad || true
    } finally { await ctx.close() }
  })
  await h.check('d.theme-switch.media', 'B', async () => {
    // The no-JS fallback: no data-theme attribute, so only the prefers-color-scheme rule can switch.
    const { ctx, page } = await pageFor('light')
    try {
      await fx.gotoRoute(page, stack, '/')
      await page.evaluate(() => document.documentElement.removeAttribute('data-theme'))
      for (const scheme of ['dark', 'light']) {
        await page.emulateMedia({ colorScheme: scheme })
        const got = await probe(page)
        if (got.attr !== null) return 'data-theme was not removed'
        const bad = expectTheme(got, scheme)
        if (bad) return `media ${bad}`
      }
    } finally { await ctx.close() }
  })
  await h.check('d.all-tokens', 'B', async () => {
    if (!manifest.tokenProbe) return 'manifest has no recorded tokenProbe'
    const { ctx, page } = await pageFor('light')
    const bad = []
    try {
      await fx.gotoRoute(page, stack, '/')
      for (const path of TOKEN_PATHS) {
        await setPath(page, path)
        const got = await probeTokens(page, Object.keys(manifest.tokens))
        for (const name of Object.keys(manifest.tokens)) {
          const want = (manifest.tokenProbe[path] || {})[name]
          if (!want) bad.push(`${path} ${name}: nothing recorded`)
          else if (got[name] !== want) bad.push(`${path} ${name}: ${got[name]} != recorded ${want}`)
        }
      }
    } finally { await ctx.close() }
    return bad.length ? bad.join('; ') : true
  })
  await h.check('d.theme-switch.media-first-paint', 'B', async () => {
    // No stored choice and a dark system: the blocking script in index.html picks dark.
    const ctx = await browser.newContext({ storageState: state, viewport: DESKTOP, colorScheme: 'dark' })
    const page = await ctx.newPage()
    try {
      await fx.gotoRoute(page, stack, '/')
      return expectTheme(await probe(page), 'dark') || true
    } finally { await ctx.close() }
  })
}

async function scenarioE() {
  console.log('e. direct-colour-vars')
  const tokens = Object.keys(manifest.tokens)
  const names = [...tokens, ...tokens.map((t) => `dark-${t}`)]
  const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => (d.isDirectory() ? walk(pathMod.join(dir, d.name)) : [pathMod.join(dir, d.name)]))
  const files = [...walk(SRC).filter((f) => /\.(tsx?|css)$/.test(f)), pathMod.join(REPO, 'frontend', 'index.html'), pathMod.join(REPO, 'frontend', 'tailwind.config.js')]
  await h.check('e.direct-colour-vars', 'S', async () => {
    const bare = []
    const re = new RegExp(`var\\(\\s*--(${names.join('|')})\\s*\\)`, 'g')
    for (const file of files) {
      fs.readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
        const code = line.replace(/\/\*.*?\*\//g, '').replace(/^\s*\/\/.*$/, '')
        for (const m of code.matchAll(re)) {
          const before = code.slice(0, m.index)
          // `--paper: var(--dark-paper)` aliases a channel triple; it is a declaration, not a colour expression.
          if (/^\s*--[\w-]+\s*:\s*$/.test(before)) continue
          if (/rgb\(\s*$/.test(before)) {
            // wrapped: rgb(var(--x)) or rgb(var(--x) / a) is the shape; the bare one is rgb(var(--x)) with no alpha, still wrapped.
            continue
          }
          bare.push(`${pathMod.relative(REPO, file)}:${i + 1}: ${line.trim()}`)
        }
      })
    }
    return bare.length ? bare.join('; ') : true
  })
  await h.check('e.direct-colour-vars.chart', 'B', async () => {
    const { ctx, page } = await pageFor('dark')
    try {
      await fx.gotoRoute(page, stack, '/forecast')
      const stroke = await page.evaluate(() => {
        const path = document.querySelector('svg path[stroke]')
        return path ? getComputedStyle(path).stroke : null
      })
      const c = parseColour(stroke)
      return sameRgb(c, tokenRgb('ink', 'dark')) ? true : `chart line stroke is ${stroke}`
    } finally { await ctx.close() }
  })
}

async function scenarioF() {
  console.log('f. toolchain')
  for (const [id, args] of [['build', ['build']], ['lint', ['lint']]]) {
    await h.check(`f.toolchain.${id}`, 'B', async () => {
      const res = spawnSync('pnpm', args, { cwd: pathMod.join(REPO, 'frontend'), encoding: 'utf8', timeout: 600000 })
      return res.status === 0 ? true : `pnpm ${args.join(' ')} exited ${res.status}: ${String(res.stdout + res.stderr).slice(-1500)}`
    })
  }
}

async function scenarioH() {
  console.log('h. visual-regression')
  const dir = process.env.TOKENS_BASELINE_DIR
  if (!dir || !fs.existsSync(pathMod.join(dir, 'rects.json'))) {
    await h.check('h.visual-regression', 'B', async () => 'TOKENS_BASELINE_DIR is not set to a baseline made with --capture-shots')
    return
  }
  const recorded = JSON.parse(fs.readFileSync(pathMod.join(dir, 'rects.json'), 'utf8'))
  const reasons = await refuseBaseline(recorded.meta)
  await h.check('h.baseline-binding', 'S', async () => (reasons.length ? reasons.join('; ') : true))
  if (reasons.length) return
  const baseRects = recorded.rects
  const envelope = manifest.renderNoise
  if (!envelope) {
    await h.check('h.visual-regression', 'B', async () => 'manifest has no renderNoise envelope: run --measure-noise on the base tree')
    return
  }
  const compare = await browser.newPage()
  const summary = []
  const bad = []
  for (const screen of screens()) {
    const baseFile = pathMod.join(dir, `${screen.key}.png`)
    if (!fs.existsSync(baseFile)) { bad.push(`${screen.key}: no baseline image`); continue }
    // The renderer is not bit-stable run to run, so a screen is shot until two attempts match
    // the baseline exactly outside the allowed boxes (at most four attempts). Every attempt must
    // stay inside the measured noise envelope: an attempt past it fails the screen, even when
    // a later attempt is clean, so an intermittent regression cannot pass on a retry.
    const log = []
    let exact = 0, verdict = null
    for (let attempt = 1; attempt <= 4 && !verdict; attempt++) {
      const shot = await shoot(screen)
      const boxes = [...(baseRects[screen.key] || []), ...shot.rects]
      const d = await diffPngs(compare, fs.readFileSync(baseFile), shot.png, boxes)
      if (d.sizeA) { verdict = `size ${d.sizeA} -> ${d.sizeB}`; log.push('size changed'); break }
      log.push(`${d.outside}px/delta ${d.maxOutside} (inside ${d.inside}px)`)
      if (d.outside > envelope.maxOutsidePixels || d.maxOutside > envelope.maxChannelDelta) {
        verdict = `attempt ${attempt}: ${d.outside}px, max delta ${d.maxOutside}, past the noise envelope (${envelope.maxOutsidePixels}px, delta ${envelope.maxChannelDelta}); first at ${d.firstOutside}, box ${d.outsideBox}`
        if (process.env.TOKENS_SAVE_DIR) {
          fs.mkdirSync(process.env.TOKENS_SAVE_DIR, { recursive: true })
          fs.writeFileSync(pathMod.join(process.env.TOKENS_SAVE_DIR, `${screen.key}.png`), shot.png)
        }
      } else if (d.outside === 0 && ++exact >= 2) break
    }
    if (!verdict && exact < 2) verdict = `fewer than two exact matches in 4 attempts`
    summary.push(`${screen.key}: attempts [${log.join('; ')}]${verdict ? ` FAIL` : ''}`)
    if (verdict) bad.push(`${screen.key}: ${verdict}`)
  }
  await compare.close()
  summary.forEach((l) => console.log(`    ${l}`))
  await h.check('h.visual-regression', 'B', async () => (bad.length ? bad.join('; ') : true))
}

/**
 * Measures the renderer's noise on the unchanged tree: every screen is shot `repeats` times
 * and compared with the baseline; the largest outside-the-boxes diff seen is the envelope.
 * Writes manifest.renderNoise. Run on the base tree only.
 */
async function measureNoise(dir, repeats) {
  const recorded = JSON.parse(fs.readFileSync(pathMod.join(dir, 'rects.json'), 'utf8'))
  const reasons = await refuseBaseline(recorded.meta)
  if (reasons.length) throw new Error(`measure the noise on the base tree against its own baseline: ${reasons.join('; ')}`)
  const compare = await browser.newPage()
  let maxOutsidePixels = 0, maxChannelDelta = 0
  const perScreen = {}
  for (const screen of screens()) {
    for (let i = 0; i < repeats; i++) {
      const shot = await shoot(screen)
      const boxes = [...(recorded.rects[screen.key] || []), ...shot.rects]
      const d = await diffPngs(compare, fs.readFileSync(pathMod.join(dir, `${screen.key}.png`)), shot.png, boxes)
      if (d.sizeA) throw new Error(`${screen.key}: size changed on the base tree`)
      maxOutsidePixels = Math.max(maxOutsidePixels, d.outside)
      maxChannelDelta = Math.max(maxChannelDelta, d.maxOutside)
      perScreen[screen.key] = Math.max(perScreen[screen.key] || 0, d.outside)
      if (d.outside) console.log(`  noise ${screen.key} repeat ${i + 1}: ${d.outside}px delta ${d.maxOutside}`)
    }
  }
  await compare.close()
  manifest.renderNoise = { maxOutsidePixels, maxChannelDelta, repeats, screens: Object.keys(perScreen).length, measuredOn: baseSha() }
  fs.writeFileSync(fx.MANIFEST, `${JSON.stringify(manifest, null, 2)}\n`)
  console.log(`envelope: ${JSON.stringify(manifest.renderNoise)}`)
}

// ─── Main ───────────────────────────────────────────────────────────────────

;(async () => {
  try {
    await setup()
  } catch (e) {
    console.error(`setup failed: ${e.message}`)
    process.exit(2)
  }
  try {
    if (flag('--record-manifest')) { await recordManifest(); return }
    if (flag('--measure-noise')) { await measureNoise(flagValue('--measure-noise'), Number(argv[argv.indexOf('--measure-noise') + 2] || 4)); return }
    if (flag('--capture-shots')) { await captureShots(flagValue('--capture-shots')); return }
    const scenarios = { a: scenarioA, b: scenarioB, c: scenarioC, d: scenarioD, e: scenarioE, f: scenarioF, h: scenarioH }
    for (const [key, fn] of Object.entries(scenarios)) if (!only || only === key) await fn()
    process.exitCode = h.report()
  } catch (e) {
    console.error(`run failed: ${e.stack || e.message}`)
    process.exitCode = 2
  } finally {
    if (browser) await browser.close()
    stack.stop()
    process.exit(process.exitCode || 0)
  }
})()
