// Browser-free self-test of allDueRows in ./_due_pages.cjs when the list shrinks mid-walk (STU-402).
// Usage: node frontend/e2e/_due_pages.selftest.cjs   (exit 1 on any failure)
const assert = require('node:assert/strict')
const d = require('./_due_pages.cjs')

const SIZE = 3
const names = (n) => Array.from({ length: n }, (_, i) => `r${i + 1}`)

/**
 * A fake page holding a paged "Due and overdue" list: 3 rows a page, the pager mounted only
 * while there is more than one page. `onClick(n, list)` runs on the nth Next/Previous click and
 * `onRead(n, list)` after the nth read of the rows on screen; both may edit `list.rows`, which
 * is how a refetch that drops the paid row is scripted. Counts clicks and reads.
 */
function fakePage(rowNames, { onClick = () => {}, onRead = () => {} } = {}) {
  const list = { rows: rowNames.map((name) => ({ name })), cur: 1, clicks: 0, reads: 0 }
  const pages = () => Math.max(1, Math.ceil(list.rows.length / SIZE))
  const mounted = () => list.rows.length > SIZE
  const settle = () => { list.cur = Math.min(list.cur, pages()) }
  const t0 = Date.now()
  const noPager = () => new Error('locator: no pager on the page')
  const button = (delta) => ({
    dispatchEvent: async () => {
      if (!mounted()) throw noPager()
      list.clicks += 1
      onClick(list.clicks, list)
      settle()
      if (mounted()) list.cur += delta
      settle()
    },
    isDisabled: async () => {
      if (!mounted()) throw noPager()
      return delta > 0 ? list.cur >= pages() : list.cur <= 1
    },
  })
  const pagerLocator = {
    count: async () => (mounted() ? 1 : 0),
    locator: (sel) =>
      sel === 'p'
        ? { first: () => ({ textContent: async () => `${(list.cur - 1) * SIZE + 1}–${Math.min(list.cur * SIZE, list.rows.length)} of ${list.rows.length}` }) }
        : {
            textContent: async () => String(list.cur),
            filter: ({ hasText }) => ({
              waitFor: async ({ timeout }) => {
                const until = Date.now() + timeout
                while (!(mounted() && hasText.test(String(list.cur)))) {
                  if (Date.now() > until) throw new Error('waitFor timeout')
                  await new Promise((r) => setTimeout(r, 20))
                }
              },
            }),
          },
    getByRole: (_role, { name }) => button(name === 'Next' ? 1 : -1),
  }
  const shown = () => list.rows.slice((list.cur - 1) * SIZE, list.cur * SIZE)
  const page = {
    on: () => {},
    evaluate: async (_fn, arg) => (typeof arg === 'string' ? false : Date.now() - t0),
    waitForLoadState: async () => {},
    waitForTimeout: (ms) => new Promise((r) => setTimeout(r, ms)),
    locator: (sel) => {
      if (sel === '[data-testid="due-pager"]') return pagerLocator
      if (sel === '[data-testid="due-row"]') {
        return {
          evaluateAll: async () => {
            const out = shown().map((r) => ({ name: r.name }))
            list.reads += 1
            onRead(list.reads, list)
            settle()
            return out
          },
        }
      }
      throw new Error(`fake page: unexpected selector ${sel}`)
    },
  }
  return { page, list }
}
const namesOf = (rows) => rows.map((r) => r.name)
const without = (rows, name) => { rows.splice(rows.findIndex((r) => r.name === name), 1) }

const cases = [
  ['a.pager-disappears: the paid row leaves as the walk steps, the list drops to one page, the rows come back once, in order', async () => {
    // 4 rows on 2 pages; the refetch removes r2 on the first Next, leaving 3 rows and no pager.
    const { page, list } = fakePage(names(4), { onClick: (n, l) => { if (n === 1) without(l.rows, 'r2') } })
    const rows = await d.allDueRows(page)
    assert.deepEqual(namesOf(rows), ['r1', 'r3', 'r4'])
    assert.equal(list.clicks, 1, 'only the first walk clicked')
  }],
  ['a2.pager-disappears: the paid row leaves after the step landed, the stale rows are dropped', async () => {
    // 7 rows on 3 pages; r1 leaves just after page 2 is read, so the pages move under the walk.
    const { page } = fakePage(names(7), { onRead: (n, l) => { if (n === 2) without(l.rows, 'r1') } })
    const rows = await d.allDueRows(page)
    assert.deepEqual(namesOf(rows), ['r2', 'r3', 'r4', 'r5', 'r6', 'r7'])
  }],
  ['b.stable-pager: every page is read once, in order', async () => {
    const { page, list } = fakePage(names(8))
    const rows = await d.allDueRows(page)
    assert.deepEqual(namesOf(rows), names(8))
    assert.equal(list.cur, 1, 'leaves the section on page 1')
    assert.equal(list.reads, 3)
  }],
  ['b2.stable-pager: a list with no pager is one read', async () => {
    const { page, list } = fakePage(names(2))
    assert.deepEqual(namesOf(await d.allDueRows(page)), ['r1', 'r2'])
    assert.equal(list.reads, 1)
  }],
  ['c.retry-exhausted: the pager goes away again in the restarted walk, so it rejects and starts no third walk', async () => {
    const checks = []
    d.useDueCheck(async (what, actual, expected) => { checks.push([what, actual, expected]) })
    // The first Next drops r2 (7 -> 6 rows, the pages move); the restarted walk's first click (Previous, back to page 1) drops 4 more rows, so no pager.
    const { page, list } = fakePage(names(7), {
      onClick: (n, l) => {
        if (n === 1) without(l.rows, 'r2')
        if (n === 2) l.rows.splice(2)
      },
    })
    await assert.rejects(d.allDueRows(page), (e) => e instanceof d.DueListShrunk && /pager/.test(e.message))
    assert.equal(list.clicks, 2, 'one click per walk, none after')
    assert.equal(list.reads, 2, 'two reads in the first walk, none in the second (it stops going back to page 1), no third walk')
    assert.equal(checks.length, 1)
    assert.equal(checks[0][0], 'the due list held still through the walk')
    d.useDueCheck(null)
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
