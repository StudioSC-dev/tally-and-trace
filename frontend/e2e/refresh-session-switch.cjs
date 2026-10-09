// Regression check for STU-239: a token refresh must stay bound to the session
// that started it. Drives the real web app against a local API and a local DB.
// Not wired into CI and not part of `pnpm build`. Run steps: see ./README.md.
//
// Scenarios:
//   (a) A's refresh succeeds late, after logout + login as B in the same tab
//   (b) A's refresh fails late, after the same switch
//   (c) a normal refresh still works; a failed refresh still clears and redirects
//   (d) concurrent 401s in one session share a single /auth/refresh
//   (e) the startup /auth/me check fails late, after a login as B
//   (f) a 401 that lands after a failed refresh cleared the session starts no
//       second refresh and restores no token
//
// Usage: node frontend/e2e/refresh-session-switch.cjs [a|b|c|d|e|f]
const { execFileSync } = require('child_process')

const playwrightPath = process.env.PLAYWRIGHT_PATH || 'playwright'
let chromium
try {
  ;({ chromium } = require(playwrightPath))
} catch {
  console.error(`Cannot load Playwright from "${playwrightPath}". Set PLAYWRIGHT_PATH (see frontend/e2e/README.md).`)
  process.exit(2)
}

const API_ORIGIN = (process.env.E2E_API_URL || 'http://localhost:8000').replace(/\/$/, '')
const API = `${API_ORIGIN}/api/v1`
const BASE = (process.env.E2E_WEB_URL || 'http://localhost:5173').replace(/\/$/, '')

// Local DB only: the script writes to it (marks the test users verified).
const DB = (process.env.DATABASE_URL || '').replace(/^postgresql\+\w+:/, 'postgresql:')
const dbHost = (() => { try { return new URL(DB).hostname } catch { return '' } })()
if (!['127.0.0.1', 'localhost'].includes(dbHost)) {
  console.error('REFUSING: DATABASE_URL must point at a local Postgres (127.0.0.1 or localhost)')
  process.exit(2)
}

const only = process.argv[2]
let pass = 0, total = 0
function check(what, actual, expected) {
  total++
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (ok) pass++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${what}: actual=${JSON.stringify(actual)} expected=${JSON.stringify(expected)}`)
}

async function api(token, method, url, body) {
  const res = await fetch(`${API}${url}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await res.text()
  let json = null
  try { json = JSON.parse(text) } catch { json = text }
  return { status: res.status, json }
}

const sub = (token) => {
  try { return JSON.parse(Buffer.from(String(token).split('.')[1], 'base64url').toString()).sub } catch { return null }
}
const bearerSub = (req) => sub((req.headers()['authorization'] || '').replace(/^Bearer /, ''))
const isAccountsList = (url) => /\/accounts\/(\?|$)/.test(url)
const until = async (page, fn, ms = 5000) => { for (let i = 0; i < ms / 100 && !fn(); i++) await page.waitForTimeout(100) }
const gate = () => { let open; const p = new Promise((r) => { open = r }); return [p, open] }
const FAIL_401 = { status: 401, contentType: 'application/json', body: '{"detail":"Invalid or expired refresh token"}' }

async function makeUser(tag) {
  const email = `e2e-${tag}-${Math.random().toString(16).slice(2, 8)}@example.com`
  const password = 'E2eTest!2345'
  const reg = await api('', 'POST', '/auth/register', { email, password, first_name: `User${tag}`, last_name: 'Test', default_currency: 'PHP' })
  if (reg.status !== 200 && reg.status !== 201) throw new Error(`register ${reg.status} ${JSON.stringify(reg.json)}`)
  execFileSync('psql', [DB, '-q', '-c', `UPDATE users SET is_verified = true, onboarding_completed = true WHERE email = '${email}'`])
  const login = await api('', 'POST', '/auth/login', { email, password })
  if (login.status !== 200) throw new Error(`login ${login.status}`)
  const acct = await api(login.json.access_token, 'POST', '/accounts/', { name: `${tag}-acct`, account_type: 'checking', balance: 100, currency: 'PHP' })
  if (acct.status >= 300) throw new Error(`account ${acct.status} ${JSON.stringify(acct.json)}`)
  return { email, password, tag, token: login.json.access_token, me: (await api(login.json.access_token, 'GET', '/auth/me')).json }
}

async function newPage(browser) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } })
  const page = await ctx.newPage()
  if (process.env.DEBUG) page.on('response', (r) => { if (r.url().includes('/api/v1/')) console.log(`    [net] ${r.request().method()} ${r.url().replace(API, '')} -> ${r.status()} as ${bearerSub(r.request())}`) })
  return { ctx, page }
}

async function uiLogin(page, u) {
  if (!page.url().includes('/login')) await page.goto(`${BASE}/login`)
  await page.locator('#email').fill(u.email)
  await page.locator('#password').fill(u.password)
  const resp = page.waitForResponse((r) => r.url().endsWith('/auth/login') && r.request().method() === 'POST')
  await page.getByRole('button', { name: 'Sign in', exact: true }).click()
  const token = (await (await resp).json()).access_token
  await page.waitForURL((url) => url.pathname === '/')
  await page.waitForFunction((t) => localStorage.getItem('access_token') === t, token)
  return token
}

async function uiLogout(page, u) {
  await page.getByRole('button', { name: new RegExp(`User${u.tag} Test`) }).first().click()
  await page.getByRole('button', { name: 'Sign out' }).click()
  await page.waitForURL((url) => url.pathname === '/login')
}

const nav = (page, name) => page.locator(`a[data-onboarding="nav-${name}"]`).first().click()
const stored = (page) => page.evaluate(() => localStorage.getItem('access_token'))
const corrupt = (page) => page.evaluate(() => localStorage.setItem('access_token', 'garbage.token.value'))
const settle = async (page) => { await page.waitForLoadState('networkidle'); await page.waitForTimeout(1100) }
const path = (page) => new URL(page.url()).pathname
async function inPage(page, p) {
  return page.evaluate(async ([api, p]) => {
    const t = localStorage.getItem('access_token')
    const r = await fetch(`${api}${p}`, { headers: t ? { Authorization: `Bearer ${t}` } : {} })
    return { status: r.status, json: await r.json().catch(() => null) }
  }, [API, p])
}
async function cookieOwner(page) {
  const r = await page.evaluate(async (api) => {
    const r = await fetch(`${api}/auth/refresh`, { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: '{}' })
    return { status: r.status, json: await r.json().catch(() => null) }
  }, API)
  return r.status === 200 ? sub(r.json.access_token) : `status ${r.status}`
}

// (a) / (b): A's refresh is held across logout + login as B.
async function switchScenario(browser, A, B, label, releaseAs) {
  console.log(`\n=== (${label}) held refresh ${releaseAs === 'ok' ? 'success' : 'failure'} across A -> B switch`)
  const { ctx, page } = await newPage(browser)
  await page.goto(`${BASE}/login`)
  await uiLogin(page, A)
  await settle(page)

  const afterRelease = []
  let released = false
  page.on('request', (r) => { if (released && r.url().includes('/api/v1/')) afterRelease.push({ url: r.url().replace(API, ''), sub: bearerSub(r) }) })

  const [held, release] = gate()
  let refreshSeen = 0, serverAnswered = releaseAs !== 'ok'
  await page.route('**/api/v1/auth/refresh', async (route) => {
    if (++refreshSeen > 1) return route.continue()
    try {
      // On success the server rotates A's token now; the page sees it only on release.
      const resp = releaseAs === 'ok' ? await route.fetch() : null
      serverAnswered = true
      await held
      await route.fulfill(resp ? { response: resp } : FAIL_401)
    } catch { /* the page aborted the request */ }
  })

  await corrupt(page)
  await nav(page, 'accounts')
  await until(page, () => refreshSeen > 0 && serverAnswered)
  check(`(${label}) A's refresh is in flight and held`, refreshSeen, 1)

  await uiLogout(page, A)
  const bToken = await uiLogin(page, B)
  check(`(${label}) B logged in`, sub(await stored(page)), B.email)

  released = true
  release()
  await page.waitForTimeout(2500)

  check(`(${label}) stored token is still B's login token`, (await stored(page)) === bToken, true)
  check(`(${label}) no redirect to /login`, path(page), '/')
  check(`(${label}) /auth/me with stored token returns B`, (await inPage(page, '/auth/me')).json?.email, B.email)
  check(`(${label}) /accounts/ with stored token returns B's data`, ((await inPage(page, '/accounts/')).json?.items || []).map((a) => a.name), ['B-acct'])
  let appNames = 'no in-app request (nav unavailable)'
  try {
    const resp = page.waitForResponse((r) => isAccountsList(r.url()) && r.request().method() === 'GET', { timeout: 5000 })
    resp.catch(() => {})
    await page.locator('a[data-onboarding="nav-accounts"]').first().click({ timeout: 3000 })
    const body = await (await resp).json()
    appNames = body.items ? body.items.map((a) => a.name) : 'error body'
  } catch { /* reported by the check below */ }
  check(`(${label}) in-app /accounts/ returns B's data`, appNames, ['B-acct'])
  check(`(${label}) no request carrying A's token after release`, afterRelease.filter((r) => r.sub === A.email).map((r) => r.url), [])
  check(`(${label}) refresh cookie in the jar belongs to B`, await cookieOwner(page), B.email)
  await ctx.close()
}

// (c): single user, no switch.
async function normalScenario(browser, A) {
  console.log('\n=== (c) normal refresh, single user')
  const { ctx, page } = await newPage(browser)
  await page.goto(`${BASE}/login`)
  const aToken = await uiLogin(page, A)
  await settle(page)
  const refreshes = [], statuses = []
  page.on('response', (r) => {
    if (r.url().endsWith('/auth/refresh')) refreshes.push(r.status())
    if (isAccountsList(r.url()) && r.request().method() === 'GET') statuses.push(r.status())
  })
  await corrupt(page)
  const ok = page.waitForResponse((r) => isAccountsList(r.url()) && r.request().method() === 'GET' && r.status() === 200)
  await nav(page, 'accounts')
  const r = await ok
  const t = await stored(page)
  check('(c) refresh succeeded', refreshes, [200])
  check('(c) stored token refreshed (not corrupt, not the old one, still A)', [t !== 'garbage.token.value', t !== aToken, sub(t)], [true, true, A.email])
  check('(c) original request retried and returned A data', (await r.json()).items.map((a) => a.name), ['A-acct'])
  check('(c) /accounts/ statuses: 401 then 200', statuses.slice(0, 2), [401, 200])
  check('(c) still on /accounts', path(page), '/accounts')

  console.log('\n=== (c) failed refresh, single user, no switch')
  await nav(page, 'home')
  await page.waitForFunction(() => location.pathname === '/')
  await settle(page)
  await ctx.clearCookies() // no refresh cookie -> /auth/refresh 401
  refreshes.length = 0
  await corrupt(page)
  await nav(page, 'accounts')
  await page.waitForURL((url) => url.pathname === '/login', { timeout: 10000 }).catch(() => {})
  check('(c) refresh failed with 401', refreshes.includes(401), true)
  check('(c) redirected to /login', path(page), '/login')
  check('(c) session cleared', await page.evaluate(() => [localStorage.getItem('access_token'), localStorage.getItem('user')]), [null, null])
  await ctx.close()
}

// (d): the transactions page fires two queries at once; both 401 and must share one refresh.
async function coalesceScenario(browser, A) {
  console.log('\n=== (d) concurrent 401s share one refresh')
  const { ctx, page } = await newPage(browser)
  await page.goto(`${BASE}/login`)
  await uiLogin(page, A)
  await settle(page)
  const got401 = new Set(), retried200 = new Set()
  let refreshRequests = 0
  page.on('request', (r) => { if (r.url().endsWith('/auth/refresh')) refreshRequests++ })
  page.on('response', (r) => {
    const u = r.url()
    if (!u.includes('/api/v1/') || u.endsWith('/auth/refresh')) return
    if (r.status() === 401) got401.add(u)
    else if (r.status() === 200 && got401.has(u) && bearerSub(r.request()) === A.email) retried200.add(u)
  })
  // Hold the refresh so every concurrent 401 arrives while it is in flight.
  const [held, release] = gate()
  await page.route('**/api/v1/auth/refresh', async (route) => {
    try { const resp = await route.fetch(); await held; await route.fulfill({ response: resp }) } catch { /* aborted */ }
  })
  await corrupt(page)
  await nav(page, 'transactions')
  await until(page, () => got401.size >= 2)
  release()
  await until(page, () => retried200.size >= got401.size)
  await page.waitForTimeout(1000)
  check('(d) at least two requests got 401 concurrently', got401.size >= 2, true)
  check('(d) exactly one /auth/refresh request', refreshRequests, 1)
  check('(d) every 401 request was retried with 200', [...got401].filter((u) => !retried200.has(u)), [])
  check('(d) stored token belongs to A', sub(await stored(page)), A.email)
  await ctx.close()
}

// (e): the startup /auth/me check is held; B logs in through the real login
// mutation meanwhile; then the check fails.
async function startupScenario(browser, A, B) {
  console.log('\n=== (e) startup check fails late, after a login as B')
  const { ctx, page } = await newPage(browser)
  await page.goto(`${BASE}/login`)
  await page.evaluate(([t, u]) => { localStorage.setItem('access_token', t); localStorage.setItem('user', u) }, [A.token, JSON.stringify(A.me)])
  const [held, release] = gate()
  let meHeld = 0
  await page.route('**/api/v1/auth/me', async (route) => {
    if (meHeld++ > 0 || bearerSub(route.request()) !== A.email) return route.continue()
    try { await held; await route.fulfill({ status: 401, contentType: 'application/json', body: '{"detail":"Could not validate credentials"}' }) } catch { /* aborted */ }
  })
  await page.goto(`${BASE}/`)
  await until(page, () => meHeld > 0)
  check('(e) startup /auth/me is held', meHeld, 1)
  // Log B in through the app's own store and login mutation (the login form is
  // hidden while the startup check runs).
  const login = await page.evaluate(async ([email, password]) => {
    // Import the exact module URLs the app loaded (the dev server may add ?t=…),
    // so this is the app's own store and session state, not a second copy.
    const loaded = (file) => performance.getEntriesByType('resource').map((e) => e.name).find((n) => new URL(n).pathname === file) || file
    const { store } = await import(loaded('/src/store/index.ts'))
    const { authApi } = await import(loaded('/src/store/authApi.ts'))
    const startupPending = store.getState().authApi.queries['getCurrentUser(undefined)']?.status === 'pending'
    const res = await store.dispatch(authApi.endpoints.login.initiate({ email, password }))
    return { startupPending, token: res.data?.access_token ?? null }
  }, [B.email, B.password])
  check('(e) dynamic import reached the running app store', login.startupPending, true)
  await page.waitForFunction((t) => localStorage.getItem('access_token') === t, login.token)
  check('(e) B logged in during the startup check', sub(await stored(page)), B.email)
  release()
  await page.waitForTimeout(2000)
  check('(e) stored token is still B\'s', (await stored(page)) === login.token, true)
  check('(e) no redirect to /login', path(page), '/')
  check('(e) /auth/me with stored token returns B', (await inPage(page, '/auth/me')).json?.email, B.email)
  await ctx.close()
}

// (f): a failed refresh clears the session and starts the /login redirect; a
// 401 held until then must not start a second refresh or restore a token.
async function lateAfterClearScenario(browser, A) {
  console.log('\n=== (f) late 401 after a failed refresh cleared the session')
  const { ctx, page } = await newPage(browser)
  // page.evaluate blocks while the /login navigation is held, so the page
  // reports its access_token writes through the console instead.
  await page.addInitScript(() => {
    const { setItem, removeItem } = Storage.prototype
    Storage.prototype.setItem = function (k, v) { if (k === 'access_token') console.log(`[token] set ${v}`); return setItem.call(this, k, v) }
    Storage.prototype.removeItem = function (k) { if (k === 'access_token') console.log('[token] removed'); return removeItem.call(this, k) }
  })
  const tokenEvents = []
  page.on('console', (m) => { if (m.text().startsWith('[token] ')) tokenEvents.push(m.text().slice(8)) })
  await page.goto(`${BASE}/login`)
  await uiLogin(page, A)
  await settle(page)
  let refreshRequests = 0
  await page.route('**/api/v1/auth/refresh', async (route) => {
    // The first refresh fails (the server never sees it, so the cookie stays
    // valid and a second refresh would succeed); later ones go to the server.
    if (++refreshRequests === 1) return route.fulfill(FAIL_401)
    return route.continue()
  })
  // Hold the transactions list response (a 401) until after the clear.
  const [lateHeld, releaseLate] = gate()
  let lateSeen = false, lateDelivered = null
  await page.route((url) => url.pathname.endsWith('/transactions/') && url.searchParams.has('offset'), async (route) => {
    if (lateSeen) return route.continue()
    lateSeen = true
    try {
      const resp = await route.fetch()
      await lateHeld
      await route.fulfill({ response: resp })
      lateDelivered = resp.status()
    } catch { lateDelivered = 'aborted' }
  })
  // Hold the /login navigation so the old page keeps running after the clear.
  const [docHeld, releaseDoc] = gate()
  let docSeen = false
  await page.route((url) => url.origin === BASE && url.pathname === '/login', async (route) => {
    if (route.request().resourceType() !== 'document') return route.continue()
    docSeen = true
    await docHeld
    await route.continue().catch(() => {})
  })
  await corrupt(page)
  await nav(page, 'transactions')
  await until(page, () => docSeen && lateSeen)
  check('(f) failed refresh started the /login redirect', docSeen, true)
  await until(page, () => tokenEvents.includes('removed'))
  check('(f) session cleared by the failed refresh', tokenEvents.includes('removed'), true)
  const sinceClear = tokenEvents.length
  releaseLate()
  await page.waitForTimeout(2000)
  check('(f) the held 401 was delivered after the clear', lateDelivered, 401)
  check('(f) no second /auth/refresh after the clear', refreshRequests, 1)
  check('(f) no token restored after the clear', tokenEvents.slice(sinceClear).filter((e) => e.startsWith('set ')).map((e) => sub(e.slice(4))), [])
  releaseDoc()
  await page.waitForURL((url) => url.pathname === '/login', { timeout: 10000 }).catch(() => {})
  check('(f) lands on /login with no session', [path(page), await stored(page)], ['/login', null])
  await ctx.close()
}

;(async () => {
  const A = await makeUser('A')
  const B = await makeUser('B')
  const browser = await chromium.launch()
  const run = (k) => !only || only === k
  if (run('a')) await switchScenario(browser, A, B, 'a', 'ok')
  if (run('b')) await switchScenario(browser, A, B, 'b', 'fail')
  if (run('c')) await normalScenario(browser, A)
  if (run('d')) await coalesceScenario(browser, A)
  if (run('e')) await startupScenario(browser, A, B)
  if (run('f')) await lateAfterClearScenario(browser, A)
  await browser.close()
  console.log(`\nRESULT: ${pass}/${total} assertions passed`)
  process.exit(pass === total ? 0 : 1)
})().catch((e) => { console.error(e); console.log(`\nRESULT (aborted): ${pass}/${total} assertions passed`); process.exit(1) })
