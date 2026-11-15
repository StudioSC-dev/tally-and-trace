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
//   pr.source-commit   AC1   the PR lists 603ed45 and not the health commit      (needs PR_NUMBER)
//   pr.commit-format   AC8   one-line lowercase subjects, no body, no attribution (PR commits, else origin/main..HEAD)
//   pr.scope           AC10  only 603ed45's files, the two public assets and this suite (PR files, else origin/main..HEAD)
//   pr.audit-evidence  AC9   Opus and Sol "Verdict:" comments on the PR           (needs PR_NUMBER)
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
// PLAYWRIGHT_PATH (see ./README.md). Optional env: PR_NUMBER (the PR checks),
// AUDIT_GATE=open (accept one Verdict per auditor, the pre-open gate; default needs two).
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
const SOURCE_SHA = '603ed45'
const HEALTH_SHA = '8c707da'
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

const git = (...args) => execFileSync('git', args, { cwd: REPO, encoding: 'utf8' }).trim()
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
        const outlet = document.querySelector('main .fade-in')
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
      const outlet = document.querySelector('main .fade-in')
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
      await controls.getByText(`Step ${step} of ${total}`).waitFor({ timeout: 10000 })
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

// ─── pr.* (AC1, AC8, AC9, AC10) ──────────────────────────────────────────────

const sourceFiles = () => git('show', '--name-only', '--format=', SOURCE_SHA).split('\n').filter(Boolean)
const PERMITTED_ADDITIONS = ['frontend/public/icon.svg', 'frontend/public/manifest.webmanifest', 'frontend/e2e/pwa-shell.cjs']
// The two files where 603ed45 conflicted with STU-159's landed changes: hunks may differ there.
const RESOLVED_FILES = ['frontend/src/components/Layout.tsx', 'frontend/src/routes/settings.tsx']

/** The branch's commits, newest first: from the PR with gh, else origin/main..HEAD. */
function branchCommits() {
  if (PR_NUMBER) {
    return JSON.parse(gh('pr', 'view', PR_NUMBER, '--json', 'commits')).commits
      .map((c) => ({ subject: c.messageHeadline, body: c.messageBody || '' }))
  }
  const base = git('merge-base', 'origin/main', 'HEAD')
  return git('log', '--no-merges', '--format=%H', `${base}..HEAD`).split('\n').filter(Boolean)
    .map((sha) => ({ subject: git('log', '-1', '--format=%s', sha), body: git('log', '-1', '--format=%b', sha) }))
}

const changedFiles = () => {
  if (PR_NUMBER) return JSON.parse(gh('pr', 'view', PR_NUMBER, '--json', 'files')).files.map((f) => f.path)
  const base = git('merge-base', 'origin/main', 'HEAD')
  return git('diff', '--name-only', `${base}..HEAD`).split('\n').filter(Boolean)
}

/** Only the +/- lines of a file's diff, so hunk offsets and index lines do not matter. */
const changeLines = (text) => text.split('\n').filter((l) => /^[+-]/.test(l) && !/^(\+\+\+|---)/.test(l)).join('\n')

async function scenarioSourceCommit() {
  if (!PR_NUMBER) return skip('pr.source-commit', 'no PR_NUMBER')
  const pr = JSON.parse(gh('pr', 'view', PR_NUMBER, '--json', 'body'))
  await h.check('pr.source-commit.listed', 'B', async () =>
    pr.body.includes(SOURCE_SHA) || `PR description does not list ${SOURCE_SHA}`)
  await h.check('pr.source-commit.no-health', 'B', async () =>
    !pr.body.includes(HEALTH_SHA) || `PR description lists the health commit ${HEALTH_SHA}`)
  await h.check('pr.source-commit.picked', 'B', async () => {
    const base = git('merge-base', 'origin/main', 'HEAD')
    const subject = git('log', '-1', '--format=%s', SOURCE_SHA).replace(/^\w+\(\w+\): /, '')
    const picked = git('log', '--no-merges', '--format=%H', `${base}..HEAD`, '--grep', subject.replace(/,/g, ',?'), '-i').split('\n').filter(Boolean)
    if (picked.length !== 1) return `${picked.length} commits carry the ${SOURCE_SHA} subject`
    const files = git('show', '--name-only', '--format=', picked[0]).split('\n').filter(Boolean).sort()
    const want = sourceFiles().sort()
    return JSON.stringify(files) === JSON.stringify(want) || `picked commit files ${files} differ from ${SOURCE_SHA}'s ${want}`
  })
}

async function scenarioCommitFormat() {
  const commits = branchCommits()
  const source = PR_NUMBER ? `PR #${PR_NUMBER}` : 'origin/main..HEAD'
  await h.check('pr.commit-format.any', 'S', async () => commits.length > 0 || `no commits found in ${source}`)
  for (const c of commits) {
    await h.check(`pr.commit-format.${c.subject.slice(0, 40)}`, 'B', async () => {
      const problems = []
      if (!/^(feat|fix|refactor|test|docs|chore|style|perf|build|ci)\((api|web|mobile|shared|infra)\): \S/.test(c.subject)) problems.push('not a Conventional Commit with scope api|web|mobile|shared|infra')
      if (/[A-Z]/.test(c.subject)) problems.push('subject has capitals')
      if (/\.$/.test(c.subject)) problems.push('trailing period')
      if (c.body.trim() !== '') problems.push('has a body or trailers')
      if (/co-authored-by|claude|anthropic|generated with|\bAI\b/i.test(`${c.subject}\n${c.body}`)) problems.push('AI attribution')
      return problems.length === 0 || problems.join('; ')
    })
  }
}

async function scenarioScope() {
  const files = changedFiles()
  const allowed = new Set([...sourceFiles(), ...PERMITTED_ADDITIONS])
  await h.check('pr.scope.files', 'B', async () => {
    const extra = files.filter((f) => !allowed.has(f))
    return extra.length === 0 || `files outside ${SOURCE_SHA}, the two assets and this suite: ${extra.join(', ')}`
  })
  await h.check('pr.scope.source-files-present', 'B', async () => {
    const missing = sourceFiles().filter((f) => !files.includes(f))
    return missing.length === 0 || `${SOURCE_SHA} files not changed: ${missing.join(', ')}`
  })
  await h.check('pr.scope.assets-present', 'B', async () => {
    const missing = PERMITTED_ADDITIONS.slice(0, 2).filter((f) => !files.includes(f))
    return missing.length === 0 || `missing ${missing.join(', ')}`
  })
  // Outside the two conflict-resolved files the changes must be exactly the source commit's.
  const base = git('merge-base', 'origin/main', 'HEAD')
  for (const f of sourceFiles().filter((x) => !RESOLVED_FILES.includes(x))) {
    await h.check(`pr.scope.identical.${f.split('/').pop()}`, 'B', async () => {
      const mine = changeLines(git('diff', `${base}..HEAD`, '--', f))
      const theirs = changeLines(git('show', '--format=', SOURCE_SHA, '--', f))
      return mine === theirs || `${f} differs from ${SOURCE_SHA}'s change`
    })
  }
}

async function scenarioAuditEvidence() {
  if (!PR_NUMBER) return skip('pr.audit-evidence', 'no PR_NUMBER')
  const comments = JSON.parse(gh('pr', 'view', PR_NUMBER, '--json', 'comments')).comments
    .map((c) => c.body).filter((b) => b.includes('Verdict:'))
  const need = process.env.AUDIT_GATE === 'open' ? 1 : 2
  for (const [name, re] of [['opus', /opus/i], ['sol', /\bsol\b/i]]) {
    await h.check(`pr.audit-evidence.${name}`, 'B', async () => {
      const n = comments.filter((b) => re.test(b)).length
      return n >= need || `${n} "Verdict:" comment(s) naming ${name}, need ${need} (one per gate)`
    })
  }
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
  ['pr.source-commit', scenarioSourceCommit],
  ['pr.commit-format', scenarioCommitFormat],
  ['pr.scope', scenarioScope],
  ['pr.audit-evidence', scenarioAuditEvidence],
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
