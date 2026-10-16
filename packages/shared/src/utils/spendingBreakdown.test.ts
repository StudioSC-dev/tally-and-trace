import { describe, it, expect } from 'vitest'
import {
  buildSpendingBreakdown, isSyntheticRowName, summaryRange,
} from './spendingBreakdown'

const line = (expenses: number) => ({ income: 0, expenses })
const cat = (name: string, color?: string) => ({ name, color })

describe('buildSpendingBreakdown', () => {
  it('returns nothing for an empty breakdown', () => {
    expect(buildSpendingBreakdown({}, [])).toEqual({ total: 0, rows: [], slices: [] })
  })

  it('drops zero and negative rows', () => {
    const { rows, total } = buildSpendingBreakdown(
      { Food: line(50), Idle: line(0), 'Returned from wallets': line(-20) }, [])
    expect(rows.map((r) => r.name)).toEqual(['Food'])
    expect(total).toBe(50)
  })

  it('sorts by amount, then name, and the shares add up to 1', () => {
    const { rows } = buildSpendingBreakdown(
      { Zed: line(10), Alpha: line(10), Big: line(30), Mid: line(20) }, [])
    expect(rows.map((r) => r.name)).toEqual(['Big', 'Mid', 'Alpha', 'Zed'])
    expect(rows.reduce((s, r) => s + r.share, 0)).toBeCloseTo(1, 10)
    expect(rows[0]?.share).toBeCloseTo(30 / 70, 10)
  })

  it('makes a normal name drillable', () => {
    const { rows } = buildSpendingBreakdown({ Groceries: line(5) }, [cat('Groceries')])
    expect(rows[0]?.drillName).toBe('Groceries')
  })

  it('keeps a partner-only name drillable', () => {
    const { rows } = buildSpendingBreakdown({ 'Partner Fuel': line(5) }, [cat('Groceries')])
    expect(rows[0]?.drillName).toBe('Partner Fuel')
  })

  it('blocks the summary rows', () => {
    const { rows } = buildSpendingBreakdown({
      Uncategorized: line(4), 'Transfer fees': line(3), 'Interest: Car loan': line(2),
      'Unallocated wallet spend': line(1),
    }, [])
    expect(rows.map((r) => r.drillName)).toEqual([null, null, null, null])
  })

  it('blocks a synthetic name even when the caller owns a category of that name', () => {
    const { rows } = buildSpendingBreakdown({ 'Transfer fees': line(3) }, [cat('Transfer fees')])
    expect(rows[0]?.drillName).toBeNull()
  })

  it('recognises synthetic names', () => {
    expect(isSyntheticRowName('Returned from wallets')).toBe(true)
    expect(isSyntheticRowName('Interest: Mortgage')).toBe(true)
    expect(isSyntheticRowName('Interest')).toBe(false)
    expect(isSyntheticRowName('Groceries')).toBe(false)
  })

  it('takes the first same-name colour, trimmed, and treats blank as none', () => {
    const { rows } = buildSpendingBreakdown(
      { A: line(3), B: line(2), C: line(1) },
      [cat('A', '  #ff0000 '), cat('A', '#00ff00'), cat('B', '   '), cat('B', '#0000ff')])
    expect(rows.find((r) => r.name === 'A')?.color).toBe('#ff0000')
    expect(rows.find((r) => r.name === 'B')?.color).toBeUndefined()
    expect(rows.find((r) => r.name === 'C')?.color).toBeUndefined()
  })

  it('has no Other slice at exactly maxSlices rows', () => {
    const data = Object.fromEntries(['A', 'B', 'C'].map((n, i) => [n, line(10 - i)]))
    const { slices } = buildSpendingBreakdown(data, [], 3)
    expect(slices.map((s) => s.name)).toEqual(['A', 'B', 'C'])
    expect(slices.some((s) => s.isOther)).toBe(false)
  })

  it('folds the remainder into Other past maxSlices', () => {
    const data = Object.fromEntries(
      ['A', 'B', 'C', 'D', 'E'].map((n, i) => [n, line(50 - i * 10)]))
    const { slices, rows } = buildSpendingBreakdown(data, [], 3)
    expect(rows).toHaveLength(5)
    expect(slices.map((s) => s.name)).toEqual(['A', 'B', 'Other'])
    const other = slices[2]
    expect(other?.amount).toBe(30 + 20 + 10)
    expect(other?.drillName).toBeNull()
    expect(other?.isOther).toBe(true)
    expect(slices[0]?.offset).toBe(0)
    expect((other?.offset ?? 0) + (other?.share ?? 0)).toBeCloseTo(1, 10)
  })

  it('keeps slice keys unique when a real category is named other', () => {
    const data = { other: line(50), B: line(40), C: line(30), D: line(20), E: line(10) }
    const { slices, rows } = buildSpendingBreakdown(data, [], 3)
    expect(slices.some((s) => s.isOther)).toBe(true)
    expect(slices.some((s) => s.name === 'other')).toBe(true)
    const keys = slices.map((s) => s.key)
    expect(new Set(keys).size).toBe(keys.length)
    expect(new Set(rows.map((r) => r.key)).size).toBe(rows.length)
  })
})

describe('summaryRange', () => {
  it('sends both bounds when both are set', () => {
    expect(summaryRange('2026-10-01', '2026-10-31')).toEqual({
      start_date: '2026-10-01T00:00:00Z', end_date: '2026-10-31T23:59:59.999999Z',
    })
  })

  it('leaves out an open side', () => {
    expect(summaryRange('2026-10-01', '')).toEqual({ start_date: '2026-10-01T00:00:00Z' })
    expect(summaryRange('', '2026-10-31')).toEqual({ end_date: '2026-10-31T23:59:59.999999Z' })
    expect(summaryRange('', '')).toEqual({})
  })
})
