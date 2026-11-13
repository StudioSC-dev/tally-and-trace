// Browser-free self-test of the wait helpers in ./_smooth.cjs (STU-430, STU-605).
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
]

;(async () => {
  let failed = 0
  for (const [name, fn] of cases) {
    try { await fn(); console.log(`  PASS ${name}`) } catch (e) { failed++; console.log(`  FAIL ${name}: ${e.message}`) }
  }
  console.log(`\nRESULT: ${cases.length - failed}/${cases.length}`)
  process.exit(failed ? 1 : 0)
})()
