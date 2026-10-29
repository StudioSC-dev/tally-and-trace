// Shared harness for the page-smoothness and screen-loader browser checks (STU-335).
// Pure helpers over a Playwright page: route gates, held and rewritten responses, a
// text/attribute recorder, overlay waits, a request log and the check bookkeeping.
// It starts nothing itself; each smooth-*.cjs script starts its stack through
// ./_local_stack.cjs and passes it in where a helper needs the API.
//
// Rules the scripts rely on (plan section 5.1):
//   - every wait here is bounded and node-side (a fake page clock cannot stall it);
//   - nothing here throws past its caller except makeUser/uiLogin (setup, exit 2);
//   - routes layer: a request no layer claims, or one a layer releases, goes on to the
//     next layer with route.fallback(), so a gate, a rewrite and a failure compose.
//
// Browser-free self-test of the wait helpers: node frontend/e2e/_smooth.selftest.cjs
//
// Check kinds: B behavioural, S structural, G guard (holds at base and must keep holding).
//
// Usage:
//   const h = require('./_smooth.cjs')
//   const g = await h.gate(page, { method: 'POST', url: '/payments' })
//   try { ...; h.check('a.held', 'B', async () => g.hits === 1) } finally { g.release({ disarm: true }) }
//   process.exit(h.report())

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// ─── Matchers ────────────────────────────────────────────────────────────────

/**
 * A request matcher is one of:
 *   - a function (request) => boolean (Playwright Request);
 *   - a RegExp, tested against the request URL;
 *   - a string, a substring of the request URL (query string included);
 *   - { method?, url?, body? } where url is a string or RegExp as above and body, when
 *     given, is a string or RegExp tested against the request's post data.
 */
function toPredicate(matcher) {
  if (typeof matcher === 'function') return matcher
  if (matcher instanceof RegExp) {
    return (request) => { matcher.lastIndex = 0; return matcher.test(request.url()) }
  }
  if (typeof matcher === 'string') return (request) => request.url().includes(matcher)
  const url = matcher.url === undefined ? () => true : toPredicate(matcher.url)
  const body = matcher.body === undefined ? () => true : (request) => {
    const data = request.postData() || ''
    if (matcher.body instanceof RegExp) { matcher.body.lastIndex = 0; return matcher.body.test(data) }
    return data.includes(matcher.body)
  }
  return (request) =>
    (!matcher.method || request.method() === matcher.method.toUpperCase()) && url(request) && body(request)
}

const API_ROUTE = (url) => url.pathname.includes('/api/')

function deferred() {
  let resolve
  const promise = new Promise((r) => { resolve = r })
  return { promise, resolve }
}

/** The page's own clock (`performance.now()`), or null when the page cannot answer. */
async function pageNow(page) {
  try { return await page.evaluate(() => performance.now()) } catch { return null }
}

/** CORS headers for a fulfilled response: the app calls the API cross-origin with credentials. */
function corsHeaders(request) {
  const origin = request.headers().origin
  return {
    'access-control-allow-origin': origin || '*',
    ...(origin ? { 'access-control-allow-credentials': 'true', vary: 'Origin' } : {}),
  }
}

function failureBody(status) {
  return JSON.stringify({ detail: `stu335 injected failure ${status}` })
}

/** Registers one API route handler on the page and returns the function that removes it. */
async function addRoute(page, handler) {
  await page.route(API_ROUTE, handler)
  return async () => { try { await page.unroute(API_ROUTE, handler) } catch { /* page closed */ } }
}

// ─── Gates and held responses ────────────────────────────────────────────────

/**
 * Holds every matching request before it reaches the server, with route.continue
 * semantics after a promise, never abort.
 *
 * Returns { release({ disarm } = {}), hits, hitTimes, bodies, waitHits(n, ms), stop() }.
 * `hits`, `hitTimes` (page performance.now() at the hit, null when unreadable) and
 * `bodies` (request post data) are live getters. `release()` lets every held request
 * through and arms a fresh hold for later matches; `release({ disarm: true })` lets them
 * through and stops holding. With `failStatus`, released requests are fulfilled with that
 * status (a JSON error body) instead of being sent. `waitHits(n, ms = 3000)` resolves
 * true once `hits >= n`, false at the bound.
 */
async function gate(page, matcher, { failStatus } = {}) {
  const matches = toPredicate(matcher)
  const state = { hold: deferred(), armed: true, hits: 0, hitTimes: [], bodies: [] }
  const handler = async (route, request) => {
    if (!matches(request)) return route.fallback()
    const index = state.hits++
    state.bodies[index] = request.postData()
    const hold = state.hold
    const armed = state.armed
    const timed = pageNow(page).then((t) => { state.hitTimes[index] = t })
    if (armed) await hold.promise
    await timed
    if (failStatus !== undefined) {
      return route.fulfill({
        status: failStatus,
        contentType: 'application/json',
        headers: corsHeaders(request),
        body: failureBody(failStatus),
      })
    }
    return route.fallback()
  }
  const remove = await addRoute(page, handler)
  return {
    release({ disarm = false } = {}) {
      const old = state.hold
      if (disarm) state.armed = false
      else state.hold = deferred()
      old.resolve()
    },
    get hits() { return state.hits },
    get hitTimes() { return state.hitTimes },
    get bodies() { return state.bodies },
    async waitHits(n, ms = 3000) {
      const until = Date.now() + ms
      while (state.hits < n) {
        if (Date.now() > until) return false
        await sleep(25)
      }
      return true
    },
    stop: remove,
  }
}

/**
 * Lets matching requests reach the server, then holds the response before the page sees
 * it. With `transform(json, request)`, the delivered body is the returned value.
 *
 * Returns { release({ disarm } = {}), hits, hitTimes, bodies, waitHits(n, ms), stop() },
 * as `gate`; a hit is counted when the request is made, the response is what is held.
 */
async function holdResponse(page, matcher, { transform } = {}) {
  const matches = toPredicate(matcher)
  const state = { hold: deferred(), armed: true, hits: 0, hitTimes: [], bodies: [] }
  const handler = async (route, request) => {
    if (!matches(request)) return route.fallback()
    const index = state.hits++
    state.bodies[index] = request.postData()
    const hold = state.hold
    const armed = state.armed
    const timed = pageNow(page).then((t) => { state.hitTimes[index] = t })
    const response = await route.fetch()
    if (armed) await hold.promise
    await timed
    if (!transform) return route.fulfill({ response })
    const text = await response.text()
    let body = text
    try { body = JSON.stringify(await transform(JSON.parse(text), request)) } catch { /* pass through */ }
    return route.fulfill({ response, body })
  }
  const remove = await addRoute(page, handler)
  return {
    release({ disarm = false } = {}) {
      const old = state.hold
      if (disarm) state.armed = false
      else state.hold = deferred()
      old.resolve()
    },
    get hits() { return state.hits },
    get hitTimes() { return state.hitTimes },
    get bodies() { return state.bodies },
    async waitHits(n, ms = 3000) {
      const until = Date.now() + ms
      while (state.hits < n) {
        if (Date.now() > until) return false
        await sleep(25)
      }
      return true
    },
    stop: remove,
  }
}

/**
 * Rewrites the JSON body of every matching response with `fn(json, request)`. Returns
 * { hits, stop() }.
 */
async function rewrite(page, matcher, fn) {
  const matches = toPredicate(matcher)
  const state = { hits: 0 }
  const handler = async (route, request) => {
    if (!matches(request)) return route.fallback()
    state.hits++
    const response = await route.fetch()
    const text = await response.text()
    let body = text
    try { body = JSON.stringify(await fn(JSON.parse(text), request)) } catch { /* pass through */ }
    return route.fulfill({ response, body })
  }
  const remove = await addRoute(page, handler)
  return { get hits() { return state.hits }, stop: remove }
}

/**
 * Answers matching requests with `status` and a JSON error body, for the first `times`
 * matches (default: every match); later matches go on to the server. Returns
 * { hits, failed, stop() }: `hits` counts matches, `failed` the failures delivered.
 */
async function failWith(page, matcher, status, { times = Infinity } = {}) {
  const matches = toPredicate(matcher)
  const state = { hits: 0, failed: 0 }
  const handler = async (route, request) => {
    if (!matches(request)) return route.fallback()
    state.hits++
    if (state.failed >= times) return route.fallback()
    state.failed++
    return route.fulfill({
      status,
      contentType: 'application/json',
      headers: corsHeaders(request),
      body: failureBody(status),
    })
  }
  const remove = await addRoute(page, handler)
  return { get hits() { return state.hits }, get failed() { return state.failed }, stop: remove }
}

// ─── Recorder ────────────────────────────────────────────────────────────────

/**
 * Installs (before navigation) a MutationObserver that keeps every text, and every named
 * attribute value, each watched data-testid ever showed, in order, one entry per change
 * of an element's value. It also logs the page time of every `pointerdown` and `keydown`.
 * Call it before `page.goto`; the log restarts with each new document.
 *
 * options: { attributes = [], timestamps = false }. With `timestamps`, `textTimes` and
 * `attrTimes` hold the page `performance.now()` of each entry.
 */
async function recordTexts(page, testIds, { attributes = [], timestamps = false } = {}) {
  await page.addInitScript(({ ids, attrs, stamp }) => {
    const store = { ids, attrs, stamp, texts: {}, textTimes: {}, attrValues: {}, attrTimes: {}, inputs: [] }
    const last = new WeakMap()
    for (const id of ids) {
      store.texts[id] = []
      store.textTimes[id] = []
      store.attrValues[id] = {}
      store.attrTimes[id] = {}
      for (const a of attrs) { store.attrValues[id][a] = []; store.attrTimes[id][a] = [] }
    }
    const now = () => performance.now()
    const scan = () => {
      for (const id of ids) {
        for (const el of document.querySelectorAll(`[data-testid="${id}"]`)) {
          const seen = last.get(el) || { text: undefined, attrs: {} }
          const text = (el.textContent || '').replace(/\s+/g, ' ').trim()
          if (seen.text !== text) {
            seen.text = text
            store.texts[id].push(text)
            if (stamp) store.textTimes[id].push(now())
          }
          for (const a of attrs) {
            const value = el.getAttribute(a)
            if (value !== null && seen.attrs[a] !== value) {
              seen.attrs[a] = value
              store.attrValues[id][a].push(value)
              if (stamp) store.attrTimes[id][a].push(now())
            }
          }
          last.set(el, seen)
        }
      }
    }
    store.scan = scan
    store.clear = () => {
      for (const id of ids) {
        store.texts[id].length = 0
        store.textTimes[id].length = 0
        for (const a of attrs) { store.attrValues[id][a].length = 0; store.attrTimes[id][a].length = 0 }
      }
      store.inputs.length = 0
    }
    window.__stu335Texts = store
    const observer = new MutationObserver(scan)
    const start = () => {
      observer.observe(document.documentElement, {
        childList: true, subtree: true, characterData: true,
        attributes: true, attributeFilter: ['data-testid', ...attrs],
      })
      scan()
    }
    if (document.documentElement) start()
    else document.addEventListener('DOMContentLoaded', start, { once: true })
    for (const type of ['pointerdown', 'keydown']) {
      window.addEventListener(type, (e) => {
        store.inputs.push({ type, t: now(), key: type === 'keydown' ? e.key : undefined })
      }, true)
    }
  }, { ids: testIds, attrs: attributes, stamp: timestamps })
}

/**
 * The recorded history: { [testId]: { texts: string[], textTimes: number[],
 * attrs: { [name]: string[] }, attrTimes: { [name]: number[] } } }. Times are empty
 * unless `timestamps` was asked. A page with no recorder reads as {}.
 */
async function readTexts(page) {
  return page.evaluate(() => {
    const s = window.__stu335Texts
    if (!s) return {}
    s.scan()
    const out = {}
    for (const id of s.ids) {
      out[id] = {
        texts: [...s.texts[id]],
        textTimes: [...s.textTimes[id]],
        attrs: Object.fromEntries(s.attrs.map((a) => [a, [...s.attrValues[id][a]]])),
        attrTimes: Object.fromEntries(s.attrs.map((a) => [a, [...s.attrTimes[id][a]]])),
      }
    }
    return out
  })
}

/** The logged `pointerdown` and `keydown` events: [{ type, t, key }], page times. */
async function readInputs(page) {
  return page.evaluate(() => (window.__stu335Texts ? [...window.__stu335Texts.inputs] : []))
}

/** Forgets the history so far (and the input log). Values already shown are not re-recorded. */
async function resetTexts(page) {
  await page.evaluate(() => {
    const s = window.__stu335Texts
    if (!s) return
    s.scan()
    s.clear()
  })
}

// ─── Overlay waits ───────────────────────────────────────────────────────────

const OVERLAY = '[data-testid="busy-overlay"]'

/** The busy overlay's `data-phase`, or null when the page has no overlay. */
async function overlayPhase(page) {
  try {
    return await page.evaluate((sel) => document.querySelector(sel)?.getAttribute('data-phase') ?? null, OVERLAY)
  } catch { return null }
}

/** Waits (bounded, node-side polling) for the overlay's phase; true on arrival, false at the bound. */
async function waitPhase(page, phase, ms = 3000) {
  const until = Date.now() + ms
  for (;;) {
    if ((await overlayPhase(page)) === phase) return true
    if (Date.now() > until) return false
    await sleep(25)
  }
}

/**
 * Waits for the overlay to be `hidden` and to stay `hidden` for `settleMs` (default 150)
 * without a break; any other phase restarts the hold, so a request that starts just after
 * the triggering click does not slip past. `ms` bounds the whole wait. Never throws and no
 * check depends on it. Costs about `settleMs` per call.
 * With no overlay on the page (any commit before 5) it waits for network idle (bounded),
 * prints `NOTE no busy-overlay` and returns. At the bound with the overlay still showing
 * it prints `NOTE waitQuiet bound, phase=<phase>`; if the page clock did not advance over
 * 100 ms of real time it also prints `NOTE waitQuiet clock paused`.
 */
async function waitQuiet(page, ms = 5000, { settleMs = 150 } = {}) {
  const until = Date.now() + ms
  // The overlay mounts with the signed-in layout; give it a moment to appear.
  const present = Date.now() + Math.min(ms, 1000)
  let phase = await overlayPhase(page)
  while (phase === null && Date.now() < present) {
    await sleep(50)
    phase = await overlayPhase(page)
  }
  if (phase === null) {
    try { await page.waitForLoadState('networkidle', { timeout: ms }) } catch { /* bounded */ }
    console.log('  NOTE no busy-overlay')
    return
  }
  let hiddenSince = null
  for (;;) {
    const now = Date.now()
    if (phase !== 'hidden') hiddenSince = null
    else {
      hiddenSince ??= now
      if (now - hiddenSince >= settleMs) return
    }
    if (now >= until) break
    await sleep(25)
    phase = await overlayPhase(page)
  }
  if (phase !== 'hidden') {
    console.log(`  NOTE waitQuiet bound, phase=${phase}`)
    const before = await pageNow(page)
    await sleep(100)
    const after = await pageNow(page)
    if (before !== null && after !== null && after <= before) console.log('  NOTE waitQuiet clock paused')
  }
}

// ─── Pages and logs ──────────────────────────────────────────────────────────

/**
 * A fresh browser context and page. `contextOptions` are Playwright context options,
 * for example `{ timezoneId: 'Asia/Manila' }` for a scenario that crosses a day, or
 * `{ reducedMotion: 'reduce' }`. The viewport defaults to 1280x1000. Returns { ctx, page }.
 */
async function newPage(browser, contextOptions = {}) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 1000 }, ...contextOptions })
  const page = await ctx.newPage()
  return { ctx, page }
}

/**
 * A live list of every request the page makes: [{ method, url, t }], with `t` the page
 * `performance.now()` at the request (null when the page could not answer, for example
 * during a navigation). Static asset requests are included; filter by URL.
 */
function logRequests(page) {
  const log = []
  page.on('request', (request) => {
    const entry = { method: request.method(), url: request.url(), t: null }
    log.push(entry)
    pageNow(page).then((t) => { entry.t = t })
  })
  return log
}

/** The browser's local calendar day, `YYYY-MM-DD` (what `useToday` follows). */
async function localDay(page) {
  return page.evaluate(() => new Date().toLocaleDateString('en-CA'))
}

/**
 * Installs the page clock at Manila 23:59:00 of the Manila day `day` (`YYYY-MM-DD`), the
 * clock running, as card-pay.cjs does. Call it before `page.goto`, on a page opened with
 * `newPage(browser, { timezoneId: 'Asia/Manila' })` so the browser's day and Manila's turn
 * together (plan 5.1, Crossing a day).
 */
async function installDayClock(page, day) {
  await page.clock.install({ time: new Date(`${day}T15:59:00Z`) })
}

/**
 * Crosses the day: fastForward('02:00'), then a window `focus` event, so `useToday` and
 * `useManilaDay` recheck. Returns { before, after } local days. The scenario checks [S]
 * that `after` is the next day; a failed [S] makes the run invalid.
 */
async function crossDay(page) {
  const before = await localDay(page)
  await page.clock.fastForward('02:00')
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
  const after = await localDay(page)
  return { before, after }
}

/** Clicks at the centre of a recorded bounding box ({ x, y, width, height }). */
async function clickBox(page, box) {
  if (!box) throw new Error('clickBox: no bounding box')
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2)
}

/**
 * True when `locator` matches nothing for the whole of `ms` (default 750), polled
 * node-side every 50 ms; false as soon as it matches.
 */
async function expectAbsentFor(page, locator, ms = 750) {
  const until = Date.now() + ms
  do {
    if ((await locator.count()) > 0) return false
    await sleep(50)
  } while (Date.now() < until)
  return true
}

// ─── Checks ──────────────────────────────────────────────────────────────────

const KINDS = new Set(['B', 'S', 'G'])
const results = { total: 0, pass: 0 }

/**
 * Runs one named check. `id` is `<scenario>.<id>`; `kind` is B, S or G. `fn` may be
 * async: the check passes when it resolves to `true` or `undefined`, and fails when it
 * resolves to `false` or a string (the reason) or throws. A failure prints
 * `FAIL <id> [kind]: <reason>` and the scenario continues; this never throws.
 */
async function check(id, kind, fn) {
  if (!KINDS.has(kind)) throw new Error(`check ${id}: kind must be B, S or G, not ${kind}`)
  results.total++
  let reason = null
  try {
    const out = await fn()
    if (out === false) reason = 'returned false'
    else if (typeof out === 'string') reason = out
  } catch (e) {
    reason = `threw ${e && e.message ? e.message : e}`
  }
  if (reason === null) {
    results.pass++
    console.log(`  PASS ${id} [${kind}]`)
  } else {
    console.log(`  FAIL ${id} [${kind}]: ${reason}`)
  }
}

/** Prints `RESULT: k/m` and returns the exit code: 0 when k = m, else 1. Setup failures exit 2 in the script. */
function report() {
  console.log(`\nRESULT: ${results.pass}/${results.total}`)
  return results.pass === results.total ? 0 : 1
}

// ─── API seeding and sign-in ─────────────────────────────────────────────────

/**
 * An API client for the stack: { api, get, post, put, patch, del }. `api(token, method,
 * url, body)` returns { status, json } and never throws; the others return the JSON body
 * and throw on status >= 300. URLs are relative to `<apiUrl>/api/v1`.
 */
function apiClient(stack) {
  const base = `${stack.apiUrl}/api/v1`
  async function api(token, method, url, body) {
    const res = await fetch(`${base}${url}`, {
      method,
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    const text = await res.text()
    let json = null
    try { json = JSON.parse(text) } catch { json = text }
    return { status: res.status, json }
  }
  const strict = (method) => async (token, url, body) => {
    const r = await api(token, method, url, body)
    if (r.status >= 300) throw new Error(`${method} ${url} ${r.status} ${JSON.stringify(r.json)}`)
    return r.json
  }
  return {
    api,
    get: strict('GET'),
    post: strict('POST'),
    put: strict('PUT'),
    patch: strict('PATCH'),
    del: strict('DELETE'),
  }
}

/**
 * Registers, verifies (stack.verifyUser aborts the run unless psql reports UPDATE 1) and
 * logs in a throwaway user. Returns { email, password, tag, token }. Throws on failure:
 * the script treats that as setup (exit 2).
 */
async function makeUser(stack, tag, { currency = 'PHP' } = {}) {
  const { api } = apiClient(stack)
  const email = `e2e-smooth-${tag}-${Math.random().toString(16).slice(2, 8)}@example.com`
  const password = 'E2eTest!2345'
  const reg = await api('', 'POST', '/auth/register', {
    email, password, first_name: `User${tag}`, last_name: 'Test', default_currency: currency,
  })
  if (reg.status !== 200 && reg.status !== 201) throw new Error(`register ${reg.status} ${JSON.stringify(reg.json)}`)
  stack.verifyUser(email)
  const login = await api('', 'POST', '/auth/login', { email, password })
  if (login.status !== 200) throw new Error(`login ${login.status}`)
  return { email, password, tag, token: login.json.access_token }
}

/** Signs in through the login form and waits for the dashboard URL. Throws on failure (setup). */
async function uiLogin(page, stack, user) {
  await page.goto(`${stack.webUrl}/login`)
  await page.locator('#email').fill(user.email)
  await page.locator('#password').fill(user.password)
  await page.getByRole('button', { name: 'Sign in', exact: true }).click()
  await page.waitForURL((url) => url.pathname === '/')
}

module.exports = {
  sleep,
  gate,
  holdResponse,
  rewrite,
  failWith,
  recordTexts,
  readTexts,
  readInputs,
  resetTexts,
  overlayPhase,
  waitPhase,
  waitQuiet,
  newPage,
  logRequests,
  localDay,
  installDayClock,
  crossDay,
  clickBox,
  expectAbsentFor,
  check,
  report,
  apiClient,
  makeUser,
  uiLogin,
}
