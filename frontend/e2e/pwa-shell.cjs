// STU-188: the PWA shell and mobile CSS from 603ed45, checked in a real browser against a
// local API and web app on a throwaway database (./_local_stack.cjs). Not wired into CI
// and not part of `pnpm build`. Run steps: see ./README.md.
//
// Scenarios (one per acceptance criterion):
//   a.safe-area        AC2   nav controls clear the top inset and the first heading clears the nav
//   b.dvh              AC3   the emitted .min-h-screen rule is 100dvh; an empty page does not overflow
//   c.assets           AC4   every link in index.html resolves; icon and manifest are real files
//   onboarding.mobile  AC5   the STU-159 tour completes at 390x844
//   onboarding.desktop AC5   the STU-159 tour completes at 1280x800
//   validation.frontend AC6  frontend lint and `pnpm build` pass (and the Frontend CI job, with PR_NUMBER)
//
// Safe-area fixture (AC2). A browser tab reports env(safe-area-inset-top) as 0, so the
// inset is injected with the DevTools command Emulation.setSafeAreaInsetsOverride
// ({ insets: { top } }), sent on a CDP session for the page (Chromium only). Everything
// is measured at 390x844 with the top inset at 0 px and at 24 px. To reproduce by hand:
// open DevTools > Sensors, or run the same CDP call from any Playwright script.
//
// Revert-and-fail (AC7): put `pt-20` back on <main> in src/components/Layout.tsx in place
// of `below-nav`; a.safe-area must then fail at 24 px.
//
// Setup: a throwaway database named tt_test_188_*, exported as DATABASE_URL, plus
// PLAYWRIGHT_PATH (see ./README.md). Optional env: PR_NUMBER (the Frontend CI check).
//
// Check kinds: [B] behavioural, [S] structural, [G] guard. Ends with RESULT: k/m and exits
// 0 only when every check passed, 1 when any failed, 2 for setup.
//
// Usage: node frontend/e2e/pwa-shell.cjs [scenario]
const { execFileSync, spawnSync } = require('child_process')
const pathMod = require('path')
const fs = require('fs')
const { startLocalStack } = require('./_local_stack.cjs')
const h = require('./_smooth.cjs')

const REPO = pathMod.resolve(__dirname, '..', '..')
const PR_NUMBER = process.env.PR_NUMBER || ''

const playwrightPath = process.env.PLAYWRIGHT_PATH || 'playwright'
let chromium
try {
  ;({ chromium } = require(playwrightPath))
} catch {
  console.error(`Cannot load Playwright from "${playwrightPath}". Set PLAYWRIGHT_PATH (see frontend/e2e/README.md).`)
  process.exit(2)
}

const only = process.argv[2]
let stack

// ─── Helpers ─────────────────────────────────────────────────────────────────

const gh = (...args) => execFileSync('gh', args, { cwd: REPO, encoding: 'utf8' }).trim()
const skip = (id, why) => console.log(`  SKIP ${id}: ${why}`)

/** A page at the given size with the top safe-area inset emulated (px). */
async function pageWithInset(browser, width, height, top) {
  const { ctx, page } = await h.newPage(browser, { viewport: { width, height } })
  const cdp = await ctx.newCDPSession(page)
  await cdp.send('Emulation.setSafeAreaInsetsOverride', { insets: { top, left: 0, bottom: 0, right: 0 } })
  return { ctx, page, cdp }
}

/** A signed-in user; `onboarded: false` leaves the tour pending. */
async function signedIn(page, tag, { onboarded = true } = {}) {
  const user = await h.makeUser(stack, tag)
  if (!onboarded) {
    const out = stack.psql(`UPDATE users SET onboarding_completed = false WHERE email = '${user.email}'`)
    if (out !== 'UPDATE 1') throw new Error(`could not reset onboarding: ${out}`)
  }
  await h.uiLogin(page, stack, user)
  return user
}

// ─── a. safe area (AC2) ──────────────────────────────────────────────────────

async function scenarioSafeArea(browser) {
  for (const inset of [0, 24]) {
    const { ctx, page } = await pageWithInset(browser, 390, 844, inset)
    try {
      await signedIn(page, `sa${inset}`)
      await page.locator('main h1').first().waitFor({ timeout: 20000 })
      await page.waitForTimeout(600) // the page's own fade-in
      // Fixture: a bare heading as the first thing in <main>, with no margin or padding, so
      // its position depends on the shell's offset alone (a real page adds its own spacing,
      // which would hide a shell that is a few pixels short).
      await page.evaluate(() => {
        const outlet = document.querySelector('main [data-route-root]')
        outlet.replaceChildren()
        const probe = document.createElement('h1')
        probe.textContent = 'Probe heading'
        probe.style.cssText = 'margin:0;padding:0;line-height:1.5'
        outlet.appendChild(probe)
      })
      const m = await page.evaluate(() => {
        const nav = document.querySelector('nav.safe-area-top')
        const heading = document.querySelector('main h1')
        const controls = Array.from(nav.querySelectorAll('a, button'))
          .map((el) => el.getBoundingClientRect())
          .filter((r) => r.width > 0 && r.height > 0)
        return {
          navPadTop: parseFloat(getComputedStyle(nav).paddingTop),
          navBottom: nav.getBoundingClientRect().bottom,
          controlsTop: controls.length ? Math.min(...controls.map((r) => r.top)) : null,
          controlCount: controls.length,
          headingTop: heading.getBoundingClientRect().top,
        }
      })
      await h.check(`a.safe-area.inset${inset}.applied`, 'S', async () =>
        m.navPadTop === inset || `nav padding-top ${m.navPadTop}px, expected the ${inset}px inset`)
      await h.check(`a.safe-area.inset${inset}.controls-clear-inset`, 'B', async () =>
        (m.controlCount > 0 && m.controlsTop >= inset) || `top control at ${m.controlsTop}px (${m.controlCount} controls), inset ${inset}px`)
      await h.check(`a.safe-area.inset${inset}.heading-clears-nav`, 'B', async () =>
        m.headingTop >= m.navBottom || `heading top ${m.headingTop}px is under the nav bottom ${m.navBottom}px`)
    } finally {
      await ctx.close()
    }
  }
}

// ─── b. dvh (AC3) ────────────────────────────────────────────────────────────

async function scenarioDvh(browser) {
  const { ctx, page } = await h.newPage(browser, { viewport: { width: 390, height: 844 } })
  try {
    await signedIn(page, 'dvh')
    await page.locator('main h1').first().waitFor({ timeout: 20000 })
    const rules = await page.evaluate(() => {
      const found = []
      const walk = (list) => {
        for (const rule of Array.from(list)) {
          if (rule.cssRules && !rule.selectorText) walk(rule.cssRules)
          else if (rule.selectorText === '.min-h-screen') found.push(rule.style.minHeight)
        }
      }
      for (const sheet of Array.from(document.styleSheets)) {
        try { walk(sheet.cssRules) } catch { /* cross-origin sheet */ }
      }
      return found
    })
    await h.check('b.dvh.rule', 'S', async () =>
      (rules.length > 0 && rules.every((v) => v === '100dvh')) || `.min-h-screen min-height values: ${JSON.stringify(rules)}`)

    // Empty-page fixture: the shell with nothing in <main>. Detached from React so a
    // re-render cannot put the content back while it is measured.
    await page.evaluate(() => {
      const outlet = document.querySelector('main [data-route-root]')
      outlet.replaceChildren()
      outlet.removeAttribute('class')
    })
    await page.waitForTimeout(200)
    const m = await page.evaluate(() => ({
      scrollH: document.documentElement.scrollHeight,
      innerH: window.innerHeight,
      shellH: document.querySelector('.min-h-screen').getBoundingClientRect().height,
    }))
    await h.check('b.dvh.no-overflow', 'B', async () =>
      (m.scrollH <= m.innerH && m.shellH <= m.innerH) || `scrollHeight ${m.scrollH}, shell ${m.shellH}, viewport ${m.innerH}`)
  } finally {
    await ctx.close()
  }
}

// ─── c. assets (AC4) ─────────────────────────────────────────────────────────

async function scenarioAssets() {
  const html = fs.readFileSync(pathMod.join(REPO, 'frontend', 'index.html'), 'utf8')
    .replace(/<!--[\s\S]*?-->/g, '')
  const links = Array.from(html.matchAll(/<link\b[^>]*>/gi)).map((m) => {
    const tag = m[0]
    const attr = (n) => (tag.match(new RegExp(`\\b${n}\\s*=\\s*"([^"]*)"`, 'i')) || [])[1]
    return { rel: attr('rel'), href: attr('href') }
  }).filter((l) => l.href)

  await h.check('c.assets.targets', 'S', async () => {
    const get = (rel) => links.find((l) => l.rel === rel)?.href
    const want = { icon: '/icon.svg', 'apple-touch-icon': '/icon.svg', manifest: '/manifest.webmanifest' }
    const bad = Object.entries(want).filter(([rel, href]) => get(rel) !== href).map(([rel]) => `${rel}=${get(rel)}`)
    return bad.length === 0 || `unexpected link targets: ${bad.join(', ')}`
  })

  for (const link of links) {
    const id = `c.assets.${link.rel}.${link.href.replace(/[^a-z0-9]+/gi, '_').slice(0, 40)}`
    if (link.rel === 'preconnect') continue // an origin hint, not a resource
    const url = new URL(link.href, stack.webUrl)
    if (url.origin === stack.webUrl) {
      await h.check(id, 'B', async () => {
        const res = await fetch(url)
        const type = res.headers.get('content-type') || ''
        const body = await res.text()
        if (res.status !== 200) return `HTTP ${res.status}`
        // The dev server answers an unknown path with index.html and a 200, so the
        // type and the body must say it is the real file.
        if (/text\/html/i.test(type)) return `served the app shell (${type}), not the file`
        if (link.href === '/manifest.webmanifest') {
          const j = JSON.parse(body)
          if (j.name !== 'Tally & Trace' || j.start_url !== '/' || j.display !== 'standalone') return `manifest fields: ${JSON.stringify({ n: j.name, s: j.start_url, d: j.display })}`
          if (!(j.icons || []).some((i) => i.src === '/icon.svg')) return 'manifest does not reference /icon.svg'
        } else if (link.href === '/icon.svg' && !/^\s*<svg\b/.test(body)) return 'icon is not an SVG'
        return true
      })
    } else {
      // External (the Google Fonts stylesheet): an offline run skips it, a bad status fails.
      let res
      try { res = await fetch(url) } catch (e) { skip(id, `offline (${e.cause?.code || e.message})`); continue }
      await h.check(id, 'B', async () => res.ok || `HTTP ${res.status}`)
    }
  }
}

// ─── onboarding (AC5) ────────────────────────────────────────────────────────

async function tour(browser, name, width, height) {
  const { ctx, page } = await h.newPage(browser, { viewport: { width, height } })
  const consoleErrors = []
  page.on('pageerror', (e) => consoleErrors.push(e.message))
  try {
    const user = await signedIn(page, name, { onboarded: false })
    const overlay = page.locator('[data-onboarding-overlay]')
    await overlay.waitFor({ timeout: 20000 })
    const controls = page.locator('[data-onboarding-controls]')
    const total = 8
    for (let step = 1; step <= total; step++) {
      await controls.getByText(`Step ${step} of ${total}`, { exact: true }).waitFor({ timeout: 10000 })
      await page.waitForTimeout(700) // route change, smooth scroll and the per-frame re-measure settle
      const g = await page.evaluate(() => {
        const box = (el) => { const r = el.getBoundingClientRect(); return { top: r.top, left: r.left, width: r.width, height: r.height } }
        const hi = document.querySelector('[data-onboarding-highlight]')
        const ctl = document.querySelector('[data-onboarding-controls]')
        return {
          highlight: hi ? box(hi) : null,
          controls: ctl ? box(ctl) : null,
          path: location.pathname,
          vw: window.innerWidth,
          vh: window.innerHeight,
        }
      })
      const expectedPath = ['/', '/accounts', '/transactions', '/allocations', '/', '/', '/', '/transactions'][step - 1]
      await h.check(`onboarding.${name}.step${step}.route`, 'B', async () =>
        g.path === expectedPath || `at ${g.path}, expected ${expectedPath} (navigation kept through the tour)`)
      await h.check(`onboarding.${name}.step${step}.spotlight`, 'B', async () => {
        if (!g.highlight) return 'no spotlight highlight: the target did not resolve'
        // The highlight must sit over a rendered element carrying the step's marker.
        const target = await page.evaluate((hl) => {
          const cx = hl.left + hl.width / 2, cy = hl.top + hl.height / 2
          const marked = Array.from(document.querySelectorAll('[data-onboarding]'))
            .filter((el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 })
          return marked.some((el) => {
            const r = el.getBoundingClientRect()
            return Math.abs((r.left + r.width / 2) - cx) <= 2 && Math.abs((r.top + r.height / 2) - cy) <= 2
              && Math.abs(hl.width - (r.width + 24)) <= 2 && Math.abs(hl.height - (r.height + 24)) <= 2
          })
        }, g.highlight)
        return target || `highlight ${JSON.stringify(g.highlight)} is not centred on a rendered data-onboarding element (12px padding)`
      })
      await h.check(`onboarding.${name}.step${step}.controls-visible`, 'B', async () =>
        (g.controls && g.controls.top >= 0 && g.controls.left >= 0 && g.controls.top + g.controls.height <= g.vh + 1 && g.controls.left + g.controls.width <= g.vw + 1)
        || `controls ${JSON.stringify(g.controls)} outside the ${g.vw}x${g.vh} viewport`)
      if (step < total) await controls.getByRole('button', { name: 'Next' }).click()
    }
    await controls.getByRole('button', { name: 'Get Started' }).click()
    await h.check(`onboarding.${name}.completes`, 'B', async () => {
      await overlay.waitFor({ state: 'detached', timeout: 15000 })
      return true
    })
    await h.check(`onboarding.${name}.persisted`, 'B', async () => {
      const out = stack.psql(`SELECT onboarding_completed FROM users WHERE email = '${user.email}'`)
      return /\bt\b/.test(out) || `onboarding_completed not true:\n${out}`
    })
    await h.check(`onboarding.${name}.no-page-errors`, 'G', async () => consoleErrors.length === 0 || consoleErrors.join(' | '))
  } finally {
    await ctx.close()
  }
}

// ─── validation.frontend (AC6) ───────────────────────────────────────────────

function run(cmd, args) {
  const r = spawnSync(cmd, args, { cwd: REPO, encoding: 'utf8', timeout: 280000, env: { PATH: process.env.PATH, HOME: process.env.HOME, CI: '1' } })
  return { status: r.status, tail: `${r.stdout || ''}${r.stderr || ''}`.split('\n').slice(-8).join('\n') }
}

async function scenarioValidation() {
  await h.check('validation.frontend.lint', 'B', async () => {
    const r = run('pnpm', ['--filter', 'tally-and-trace-frontend', 'lint'])
    return r.status === 0 || `exit ${r.status}\n${r.tail}`
  })
  await h.check('validation.frontend.build', 'B', async () => {
    const r = run('pnpm', ['build'])
    return r.status === 0 || `exit ${r.status}\n${r.tail}`
  })
  if (!PR_NUMBER) return skip('validation.frontend.ci', 'no PR_NUMBER (Frontend CI job result)')
  await h.check('validation.frontend.ci', 'B', async () => {
    const checks = JSON.parse(gh('pr', 'checks', PR_NUMBER, '--json', 'name,state,bucket'))
    const fe = checks.filter((c) => /^Frontend\b/.test(c.name))
    return (fe.length > 0 && fe.every((c) => c.bucket === 'pass')) || `Frontend checks: ${JSON.stringify(fe)}`
  })
}

// ─── Run ─────────────────────────────────────────────────────────────────────

const NEEDS_STACK = new Set(['a.safe-area', 'b.dvh', 'c.assets', 'onboarding.mobile', 'onboarding.desktop'])
const SCENARIOS = [
  ['a.safe-area', scenarioSafeArea],
  ['b.dvh', scenarioDvh],
  ['c.assets', scenarioAssets],
  ['onboarding.mobile', (b) => tour(b, 'mobile', 390, 844)],
  ['onboarding.desktop', (b) => tour(b, 'desktop', 1280, 800)],
  ['validation.frontend', scenarioValidation],
]

;(async () => {
  process.on('unhandledRejection', (e) => console.log(`  NOTE unhandled rejection: ${e && e.message ? e.message.split('\n')[0] : e}`))
  const selected = SCENARIOS.filter(([name]) => !only || only === name)
  if (selected.length === 0) { console.error(`unknown scenario ${only}`); process.exit(2) }
  let browser
  if (selected.some(([name]) => NEEDS_STACK.has(name))) {
    stack = await startLocalStack()
    browser = await chromium.launch()
  }
  for (const [name, run] of selected) {
    console.log(`\n${name}`)
    try {
      await run(browser)
    } catch (e) {
      await h.check(`${name}.completed`, 'B', async () => `scenario threw: ${e && e.stack ? e.stack.split('\n').slice(0, 3).join(' | ') : e}`)
    }
  }
  if (browser) await browser.close()
  if (stack) stack.stop()
  process.exit(h.report())
})().catch((e) => { console.error(e); stack?.stop(); process.exit(2) })
