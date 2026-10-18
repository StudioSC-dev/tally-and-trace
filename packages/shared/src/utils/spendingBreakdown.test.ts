import { describe, it, expect } from 'vitest'
import {
  buildHouseholdPrivateBreakdown, buildSpendingBreakdown, isSyntheticRowName, summaryCurrencies,
  summaryRange,
} from './spendingBreakdown'
import type { TransactionSummaryHouseholdRow } from '../types/api'

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
    expect(rows[0]?.drill).toEqual({ names: ['Groceries'], uncategorized: false })
  })

  it('keeps a partner-only name drillable', () => {
    const { rows } = buildSpendingBreakdown({ 'Partner Fuel': line(5) }, [cat('Groceries')])
    expect(rows[0]?.drill).toEqual({ names: ['Partner Fuel'], uncategorized: false })
  })

  it('blocks the computed rows other than Uncategorized', () => {
    const { rows } = buildSpendingBreakdown({
      'Transfer fees': line(3), 'Interest: Car loan': line(2), 'Unallocated wallet spend': line(1),
    }, [])
    expect(rows.map((r) => r.drill)).toEqual([null, null, null])
  })

  it('drills the Uncategorized row into its name plus the uncategorized flag', () => {
    const { rows } = buildSpendingBreakdown({ Uncategorized: line(4) }, [])
    expect(rows[0]?.drill).toEqual({ names: ['Uncategorized'], uncategorized: true })
  })

  it('drills the same way when the caller owns a real Uncategorized category', () => {
    const { rows } = buildSpendingBreakdown({ Uncategorized: line(4) }, [cat('Uncategorized')])
    expect(rows[0]?.drill).toEqual({ names: ['Uncategorized'], uncategorized: true })
  })

  it('blocks a synthetic name even when the caller owns a category of that name', () => {
    const { rows } = buildSpendingBreakdown({ 'Transfer fees': line(3) }, [cat('Transfer fees')])
    expect(rows[0]?.drill).toBeNull()
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
    expect(other?.drill).toBeNull()
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

const hh = (currency: 'PHP' | 'USD', category_breakdown: Record<string, number>, count = 1): TransactionSummaryHouseholdRow => ({
  currency,
  total_expenses: Object.values(category_breakdown).reduce((a, b) => a + b, 0),
  transaction_count: count,
  category_breakdown,
})

describe('buildHouseholdPrivateBreakdown', () => {
  it('gives zeros for an empty, missing or unmatched currency', () => {
    const zero = { total: 0, count: 0, rows: [] }
    expect(buildHouseholdPrivateBreakdown([], 'PHP', [])).toEqual(zero)
    expect(buildHouseholdPrivateBreakdown(undefined, 'PHP', [])).toEqual(zero)
    expect(buildHouseholdPrivateBreakdown([hh('USD', { Food: 5 })], 'PHP', [])).toEqual(zero)
  })

  it('sorts, prefixes keys, drills, and applies category colours', () => {
    const { rows, total, count } = buildHouseholdPrivateBreakdown(
      [hh('PHP', { Utilities: 20, Food: 30, Uncategorized: 10 }, 3)], 'PHP', [cat('Food', '#ff0000')])
    expect(rows.map((r) => r.name)).toEqual(['Food', 'Utilities', 'Uncategorized'])
    expect(rows.map((r) => r.key)).toEqual(['household:Food', 'household:Utilities', 'household:Uncategorized'])
    expect(total).toBe(60)
    expect(count).toBe(3)
    expect(rows[0]?.color).toBe('#ff0000')
    expect(rows[1]?.drill).toEqual({ names: ['Utilities'], uncategorized: false })
    expect(rows[2]?.drill).toEqual({ names: ['Uncategorized'], uncategorized: true })
  })

  it('makes names the main breakdown reserves drillable', () => {
    const { rows } = buildHouseholdPrivateBreakdown(
      [hh('PHP', { 'Transfer fees': 4, 'Unallocated wallet spend': 3, 'Returned from wallets': 2, 'Interest: Car': 1 })],
      'PHP', [])
    expect(rows).toHaveLength(4)
    for (const r of rows) expect(r.drill).toEqual({ names: [r.name], uncategorized: false })
  })

  it('does not drop a long line into an Other slice', () => {
    const many = Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`C${i}`, i + 1]))
    expect(buildHouseholdPrivateBreakdown([hh('PHP', many)], 'PHP', []).rows).toHaveLength(9)
  })
})

describe('summaryCurrencies', () => {
  const byCurrency = (c: 'PHP' | 'USD' | 'JPY') =>
    ({ currency: c, total_income: 0, total_expenses: 0, moved_in: 0, moved_out: 0, net_flow: 0, transaction_count: 0, category_breakdown: {} })

  it('lists by_currency first, then extra household currencies without duplicates', () => {
    expect(summaryCurrencies({
      by_currency: [byCurrency('PHP'), byCurrency('JPY')],
      household_private: [hh('USD', { A: 1 }), hh('PHP', { A: 1 })],
    })).toEqual(['PHP', 'JPY', 'USD'])
  })

  it('is undefined without a summary', () => {
    expect(summaryCurrencies(undefined)).toBeUndefined()
  })
})
