import { describe, it, expect } from 'vitest'
import { dueTabBadge, type DueBadge, type DueBadgeSource } from './dueSection'

// The precedence table, written as data: each source's state maps to one label, the tab takes
// the first label in PRECEDENCE that any of its sources has, and RESULT says what that label shows.
type Label = 'failed' | 'nothing-today' | 'fetching' | 'complete'
const PRECEDENCE: readonly Label[] = ['failed', 'nothing-today', 'fetching', 'complete']
const labelOf = (s: DueBadgeSource): Label =>
  s.failed ? 'failed' : !s.hasData || !s.fresh ? 'nothing-today' : s.fetching ? 'fetching' : 'complete'
const RESULT: Record<Label, (kept: number | undefined, sum: number) => DueBadge> = {
  failed: (kept) => ({ figure: kept ?? 0, complete: false }),
  'nothing-today': () => ({ figure: 'pending', complete: false }),
  fetching: (kept) => ({ figure: kept ?? 'pending', complete: false }),
  complete: (_kept, sum) => ({ figure: sum, complete: true }),
}
const expected = (sources: DueBadgeSource[], kept: number | undefined): DueBadge => {
  const labels = new Set(sources.map(labelOf))
  const label = PRECEDENCE.find((l) => labels.has(l)) ?? 'complete'
  return RESULT[label](kept, sources.reduce((sum, s) => sum + s.count, 0))
}

const BOOLS = [false, true] as const
/** Every state of one source: a dated source (the snapshot, the plans) can be stale; an undated one is always fresh. */
const statesOf = (count: number, dated: boolean): DueBadgeSource[] =>
  BOOLS.flatMap((hasData) =>
    (dated ? BOOLS : [true] as const).flatMap((fresh) =>
      BOOLS.flatMap((fetching) => BOOLS.map((failed) => ({ hasData, fresh, fetching, failed, count })))))
const KEPT = [undefined, 7] as const
const show = (s: DueBadgeSource) => `${s.hasData ? 'data' : 'none'}${s.fresh ? '' : '(old day)'}${s.fetching ? ' fetching' : ''}${s.failed ? ' failed' : ''}`

const SHAPES: Record<string, DueBadgeSource[][]> = {
  // Installments: the plans, dated.
  'one source (the plans)': statesOf(2, true).map((a) => [a]),
  // Upcoming: the transactions and the occurrences, both undated.
  'two sources (Upcoming)': statesOf(2, false).flatMap((a) => statesOf(3, false).map((b) => [a, b])),
  // Subscriptions: the snapshot (dated) and the occurrences.
  'Subscriptions (snapshot and occurrences)': statesOf(2, true).flatMap((a) => statesOf(3, false).map((b) => [a, b])),
}

describe('dueTabBadge: every combination of source states against the precedence table', () => {
  for (const [shape, combos] of Object.entries(SHAPES)) {
    it(`${shape}: ${combos.length * KEPT.length} cases`, () => {
      let n = 0
      for (const sources of combos) {
        for (const kept of KEPT) {
          expect(dueTabBadge(sources, kept), `${sources.map(show).join(' + ')}, kept ${kept}`).toEqual(expected(sources, kept))
          n++
        }
      }
      expect(n).toBe(combos.length * KEPT.length)
    })
  }
  it('the shapes cover 16, 64 and 128 source combinations', () => {
    expect(Object.values(SHAPES).map((c) => c.length)).toEqual([16, 64, 128])
  })
})

const src = (over: Partial<DueBadgeSource> = {}): DueBadgeSource =>
  ({ hasData: true, fresh: true, fetching: false, failed: false, count: 1, ...over })

describe('dueTabBadge: named cases', () => {
  it('a failure while a sibling is still held on a first load reads 0 at once, not "…"', () => {
    const held = src({ hasData: false, fetching: true })
    const failed = src({ hasData: false, failed: true })
    expect(dueTabBadge([held, failed], undefined)).toEqual({ figure: 0, complete: false })
    expect(dueTabBadge([held, failed], 4)).toEqual({ figure: 4, complete: false })
  })
  it('a failure alongside a snapshot dated the old day settles on the kept total or 0, never "…"', () => {
    const stale = src({ fresh: false })
    const failed = src({ failed: true })
    expect(dueTabBadge([stale, failed], 3)).toEqual({ figure: 3, complete: false })
    expect(dueTabBadge([stale, failed], undefined)).toEqual({ figure: 0, complete: false })
  })
  it('a Retry in flight (error cleared, stale cache, fetching) keeps the kept total, never the mixed sum', () => {
    const fresh = src({ count: 1 })
    const retrying = src({ count: 1, fetching: true })
    expect(dueTabBadge([fresh, retrying], 1)).toEqual({ figure: 1, complete: false })
    expect(dueTabBadge([fresh, retrying], undefined)).toEqual({ figure: 'pending', complete: false })
  })
  it('the first load reads "…" until every source lands, then the sum, complete', () => {
    const loading = src({ hasData: false, fetching: true })
    expect(dueTabBadge([loading, loading], undefined)).toEqual({ figure: 'pending', complete: false })
    expect(dueTabBadge([src({ count: 2 }), loading], undefined)).toEqual({ figure: 'pending', complete: false })
    expect(dueTabBadge([src({ count: 2 }), src({ count: 3 })], undefined)).toEqual({ figure: 5, complete: true })
  })
  it('a day rollover reads "…" while the new day loads or a response is still dated the old day, even with a kept total', () => {
    // The caller passes no kept total from another day, and a new day's window is a new request with no data.
    expect(dueTabBadge([src({ hasData: false, fetching: true }), src({ hasData: false, fetching: true })], undefined))
      .toEqual({ figure: 'pending', complete: false })
    // plan-tabs (i): the snapshot comes back still dated the old day.
    expect(dueTabBadge([src({ fresh: false }), src()], 1)).toEqual({ figure: 'pending', complete: false })
    expect(dueTabBadge([src({ fresh: false, fetching: true }), src()], 1)).toEqual({ figure: 'pending', complete: false })
  })
  it('no sources is complete with 0', () => {
    expect(dueTabBadge([], undefined)).toEqual({ figure: 0, complete: true })
  })
})
