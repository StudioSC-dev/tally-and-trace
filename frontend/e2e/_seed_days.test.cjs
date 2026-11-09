// Self-test for _seed_days.cjs: node frontend/e2e/_seed_days.test.cjs (no browser, no database).
const assert = require('assert')
const { seedDays, closeDayOf } = require('./_seed_days.cjs')

const dom = (day) => Number(day.slice(8, 10))
const addDays = (day, n) => {
  const d = new Date(`${day}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().slice(0, 10)
}
const SETS = [[3, 4, 5], [7], [7, 8, 9, 10], [6], [8, 9, 10], [1, 2, 3, 4]]
let checked = 0
// Every day of five years, so each day of every month (the 26th to 31st, February included) is a "today".
for (let today = '2024-01-01'; today < '2029-01-01'; today = addDays(today, 1)) {
  for (const offsets of SETS) {
    const days = seedDays(today, offsets)
    assert.strictEqual(days.length, offsets.length)
    assert.ok(days.every((d) => dom(d) <= 28), `${today} ${offsets}: ${days} past the 28th`)
    assert.strictEqual(new Set(days).size, days.length, `${today} ${offsets}: ${days} not distinct`)
    assert.deepStrictEqual([...days].sort(), days, `${today} ${offsets}: ${days} out of order`)
    assert.ok(days[0] > today, `${today} ${offsets}: ${days} not ahead of today`)
    // The spacing is as asked, and the shift is small enough to stay inside the 30-day windows.
    offsets.forEach((n, i) => assert.strictEqual(addDays(days[0], n - offsets[0]), days[i]))
    assert.ok(days[0] <= addDays(today, offsets[0] + 7), `${today} ${offsets}: moved ${days[0]} too far`)
    days.forEach((d) => assert.strictEqual(closeDayOf(d), dom(d)))
    checked++
  }
}
assert.throws(() => closeDayOf('2026-10-29'))
// The days the audit named: the 26th, 27th and 28th.
assert.deepStrictEqual(seedDays('2026-10-26', [3, 4, 5]), ['2026-11-01', '2026-11-02', '2026-11-03'])
assert.deepStrictEqual(seedDays('2026-11-09', [3, 4, 5]), ['2026-11-12', '2026-11-13', '2026-11-14'])
console.log(`RESULT: ${checked}/${checked} seed sets valid`)
