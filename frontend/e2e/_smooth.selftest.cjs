// Browser-free self-test of the wait helpers in ./_smooth.cjs (STU-430).
// Usage: node frontend/e2e/_smooth.selftest.cjs   (exit 1 on any failure)
const assert = require('node:assert/strict')
const h = require('./_smooth.cjs')

/**
 * A fake page. `phaseAt(ms)` scripts the overlay phase from the elapsed time (null = no
 * overlay). evaluate(fn, arg): a string arg is the overlay probe, no arg is pageNow.
 */
function fakePage(phaseAt) {
  const t0 = Date.now()
  return {
    evaluate: async (_fn, arg) => (typeof arg === 'string' ? phaseAt(Date.now() - t0) : Date.now() - t0),
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
  ['a: a request starting after the first hidden keeps the wait going', async () => {
    const { took } = await timed(fakePage((ms) => (ms < 60 || ms >= 400 ? 'hidden' : 'visible')))
    assert.ok(took >= 400, `returned at ${took} ms, before the overlay came and went`)
  }],
  ['e: a brief visible blip resets the hidden hold', async () => {
    // hidden 0-100, visible 100-130, hidden again: the hold restarts at ~130, so the return is ~280.
    // Without the reset the stale t=0 hold is already past settleMs and it returns at ~150.
    const { took } = await timed(fakePage((ms) => (ms >= 100 && ms < 130 ? 'visible' : 'hidden')))
    assert.ok(took >= 260 && took < 600, `took ${took} ms`)
  }],
  ['b: hidden throughout returns after the settle', async () => {
    const { took } = await timed(fakePage(() => 'hidden'))
    assert.ok(took >= 150 && took < 400, `took ${took} ms`)
  }],
  ['c: visible forever returns at the bound with the note', async () => {
    const { took, logs } = await timed(fakePage(() => 'visible'), 300)
    assert.ok(took >= 300 && took < 700, `took ${took} ms`)
    assert.ok(logs.some((l) => l.includes('NOTE waitQuiet bound, phase=visible')), `logs ${JSON.stringify(logs)}`)
  }],
  ['d: no overlay takes the unchanged path', async () => {
    const { took, logs } = await timed(fakePage(() => null), 300)
    assert.ok(took < 1500, `took ${took} ms`)
    assert.ok(logs.some((l) => l.includes('NOTE no busy-overlay')), `logs ${JSON.stringify(logs)}`)
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
