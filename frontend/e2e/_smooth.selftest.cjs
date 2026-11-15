// Browser-free self-test of the wait helpers and uiLogin in ./_smooth.cjs (STU-430, STU-605, STU-508).
// Usage: node frontend/e2e/_smooth.selftest.cjs   (exit 1 on any failure)
const assert = require('node:assert/strict')
const h = require('./_smooth.cjs')

/**
 * A fake page. `requests` scripts API requests as [startMs, endMs] from creation (endMs
 * Infinity = never finishes); `pendingAt(ms)` scripts whether a save toast is pending.
 * It emits Playwright's request / requestfinished events on that schedule; evaluate(fn,
 * arg) with a string arg is the pending-toast probe.
 */
function fakePage({ requests = [], pendingAt = () => false } = {}) {
  const t0 = Date.now()
  const handlers = { request: [], requestfinished: [], requestfailed: [] }
  const emit = (type, req) => handlers[type].forEach((fn) => fn(req))
  requests.forEach(([start, end], i) => {
    const req = { url: () => `http://api.test/api/v1/r${i}` }
    setTimeout(() => emit('request', req), start)
    if (Number.isFinite(end)) setTimeout(() => emit('requestfinished', req), end)
  })
  return {
    on: (type, fn) => { if (handlers[type]) handlers[type].push(fn) },
    evaluate: async (_fn, arg) => (typeof arg === 'string' ? pendingAt(Date.now() - t0) : Date.now() - t0),
    waitForLoadState: async () => {},
  }
}

/**
 * A fake login page (STU-508). The form's `#email` field appears `readyAfterMs` after the
 * page is created (Infinity: never); a fill before that fails after 10 s like Playwright's
 * default timeout, and waitFor honours its own timeout. `calls` logs what uiLogin did, in order.
 */
function fakeLoginPage({ readyAfterMs = 0, gotoFailures = 0 } = {}) {
  const t0 = Date.now()
  const calls = []
  let failures = gotoFailures
  const ready = () => Date.now() - t0 >= readyAfterMs
  const until = async (timeout, what) => {
    const end = Date.now() + timeout
    while (!ready()) {
      if (Date.now() >= end) throw new Error(`Timeout ${timeout}ms exceeded waiting for ${what}`)
      await h.sleep(10)
    }
  }
  const field = (sel) => ({
    waitFor: async ({ timeout } = {}) => { calls.push(['waitFor', sel, timeout]); await until(timeout ?? 10000, sel) },
    fill: async (value) => { calls.push(['fill', sel, value]); await until(10000, sel) },
  })
  const page = {
    calls,
    goto: async (url, opts) => {
      calls.push(['goto', url, opts])
      if (failures > 0) { failures -= 1; throw new Error('net::ERR_CONNECTION_REFUSED') }
    },
    locator: (sel) => field(sel),
    getByRole: (role, opts) => ({ click: async () => { calls.push(['click', role, opts]) } }),
    waitForURL: async (pred) => { calls.push(['waitForURL', pred(new URL('http://web.test/')), pred(new URL('http://web.test/login'))]) },
  }
  return page
}
const stackAt = { webUrl: 'http://web.test' }
const aUser = { email: 'a@example.com', password: 'pw-1' }

async function timed(page, ...args) {
  const logs = []
  const orig = console.log
  console.log = (...a) => logs.push(a.join(' '))
  const t0 = Date.now()
  try { await h.waitQuiet(page, ...args) } finally { console.log = orig }
  return { took: Date.now() - t0, logs }
}

const cases = [
  ['a: a request starting after the first quiet moment keeps the wait going', async () => {
    const { took } = await timed(fakePage({ requests: [[60, 400]] }))
    assert.ok(took >= 400, `returned at ${took} ms, before the request came and went`)
  }],
  ['e: a brief request blip resets the quiet hold', async () => {
    // quiet 0-100, a request 100-130, quiet again: the hold restarts at ~130, so the return is ~280.
    // Without the reset the stale t=0 hold is already past settleMs and it returns at ~150.
    const { took } = await timed(fakePage({ requests: [[100, 130]] }))
    assert.ok(took >= 260 && took < 600, `took ${took} ms`)
  }],
  ['b: quiet throughout returns after the settle', async () => {
    const { took } = await timed(fakePage())
    assert.ok(took >= 150 && took < 400, `took ${took} ms`)
  }],
  ['c: a request that never finishes returns at the bound with the note', async () => {
    const { took, logs } = await timed(fakePage({ requests: [[0, Infinity]] }), 300)
    assert.ok(took >= 300 && took < 700, `took ${took} ms`)
    assert.ok(logs.some((l) => l.includes('NOTE waitQuiet bound, inflight=1')), `logs ${JSON.stringify(logs)}`)
  }],
  ['d: a pending save toast keeps the wait going with no request in flight', async () => {
    const { took, logs } = await timed(fakePage({ pendingAt: (ms) => ms < 350 }))
    assert.ok(took >= 500 && took < 900, `took ${took} ms`)
    assert.ok(!logs.some((l) => l.includes('NOTE')), `logs ${JSON.stringify(logs)}`)
  }],
  ['f: a save toast pending forever returns at the bound with the note', async () => {
    const { took, logs } = await timed(fakePage({ pendingAt: () => true }), 300)
    assert.ok(took >= 300 && took < 700, `took ${took} ms`)
    assert.ok(logs.some((l) => l.includes('NOTE waitQuiet bound, inflight=0')), `logs ${JSON.stringify(logs)}`)
  }],
  ['uiLogin a.waits-for-ready: no field is filled before the page serves it', async () => {
    const page = fakeLoginPage({ readyAfterMs: 300 })
    const t0 = Date.now()
    await h.uiLogin(page, stackAt, aUser)
    assert.ok(Date.now() - t0 >= 300, 'returned before the page was ready')
    const order = page.calls.map((c) => c[0])
    assert.ok(order.indexOf('waitFor') < order.indexOf('fill'), `calls ${JSON.stringify(order)}`)
  }],
  ['uiLogin b.slow-first-load: a stack that answers after 20 s signs in', async () => {
    const page = fakeLoginPage({ readyAfterMs: 20000 })
    const t0 = Date.now()
    await h.uiLogin(page, stackAt, aUser)
    const took = Date.now() - t0
    assert.ok(took >= 20000 && took < 21500, `took ${took} ms`)
    assert.deepEqual(page.calls.filter((c) => c[0] === 'fill').map((c) => c[2]), [aUser.email, aUser.password])
  }],
  ['uiLogin c.ready-page-no-delay: a ready page costs one navigation, one wait, no retry and no delay', async () => {
    const page = fakeLoginPage()
    const t0 = Date.now()
    await h.uiLogin(page, stackAt, aUser)
    const took = Date.now() - t0
    assert.ok(took < 100, `took ${took} ms`)
    assert.equal(page.calls.filter((c) => c[0] === 'goto').length, 1)
    assert.equal(page.calls.filter((c) => c[0] === 'waitFor').length, 1)
  }],
  ['uiLogin c2: a navigation that errors is retried until the stack answers', async () => {
    const page = fakeLoginPage({ gotoFailures: 2 })
    await h.uiLogin(page, stackAt, aUser)
    assert.equal(page.calls.filter((c) => c[0] === 'goto').length, 3)
  }],
  ['uiLogin d.never-ready-times-out: the wait is finite and rejects within the deadline', async () => {
    const page = fakeLoginPage({ readyAfterMs: Infinity })
    const t0 = Date.now()
    await assert.rejects(h.uiLogin(page, stackAt, aUser, { readyDeadlineMs: 700 }), /login page not ready within 700 ms/)
    const took = Date.now() - t0
    assert.ok(took >= 650 && took < 1200, `took ${took} ms`)
    assert.equal(page.calls.filter((c) => c[0] === 'fill').length, 0, 'nothing was filled')
    assert.equal(h.LOGIN_READY_DEADLINE_MS, 60000)
    const refused = fakeLoginPage({ gotoFailures: 1000 })
    const t1 = Date.now()
    await assert.rejects(h.uiLogin(refused, stackAt, aUser, { readyDeadlineMs: 700 }), /login page not ready within 700 ms/)
    assert.ok(Date.now() - t1 < 1500, 'a stack that never answers also rejects within the deadline')
  }],
  ['uiLogin e.readiness-failure-exits-2: a script whose setup handler catches the rejection exits 2', async () => {
    // The scripts end in `.catch((e) => { stack?.stop(); process.exit(2) })`; run that shape in a child.
    const { spawnSync } = require('node:child_process')
    const code = `
      const h = require(${JSON.stringify(require.resolve('./_smooth.cjs'))})
      const page = { goto: async () => {}, locator: () => ({ waitFor: () => new Promise((_, rej) => setTimeout(() => rej(new Error('Timeout')), 300)) }) }
      ;(async () => { await h.uiLogin(page, { webUrl: 'http://web.test' }, { email: 'a@example.com', password: 'x' }, { readyDeadlineMs: 400 }); process.exit(h.report()) })()
        .catch((e) => { console.error(e.message); process.exit(2) })`
    const r = spawnSync(process.execPath, ['-e', code], { encoding: 'utf8' })
    assert.equal(r.status, 2, `exit ${r.status}: ${r.stderr}`)
    assert.match(r.stderr, /login page not ready/)
  }],
  ['uiLogin f.existing-login-behaviour: same navigation, fields, submit and URL wait; a warm second login too', async () => {
    const page = fakeLoginPage()
    await h.uiLogin(page, stackAt, aUser)
    const [first] = page.calls
    assert.equal(first[0], 'goto')
    assert.equal(first[1], 'http://web.test/login')
    const strip = (calls) => calls.filter((c) => c[0] !== 'goto' && c[0] !== 'waitFor')
    assert.deepEqual(strip(page.calls), [
      ['fill', '#email', aUser.email],
      ['fill', '#password', aUser.password],
      ['click', 'button', { name: 'Sign in', exact: true }],
      ['waitForURL', true, false],
    ])
    const warm = page.calls.length
    const t0 = Date.now()
    await h.uiLogin(page, stackAt, aUser)
    assert.ok(Date.now() - t0 < 100, 'a warm login adds no delay')
    assert.deepEqual(page.calls.slice(warm).map((c) => c[0]), ['goto', 'waitFor', 'fill', 'fill', 'click', 'waitForURL'])
  }],
]

;(async () => {
  let failed = 0
  for (const [name, fn] of cases) {
    try { await fn(); console.log(`  PASS ${name}`) } catch (e) { failed++; console.log(`  FAIL ${name}: ${e.message}`) }
  }
  console.log(`\nRESULT: ${cases.length - failed}/${cases.length}`)
  process.exit(failed ? 1 : 0)
})()
