import { describe, it, expect } from 'vitest'
import { manilaToday } from './cardPay'
import { periodWindow } from './periodWindow'

// Record dates are days stored at 00:00Z. At 00:30 Manila on Nov 1 (16:30Z on Oct 31)
// the old window ended at that instant, before the rows dated today.
describe('periodWindow at 00:30 Manila on 1 November', () => {
  const today = manilaToday(new Date('2026-10-31T16:30:00Z'))

  it('reads the Manila day', () => {
    expect(today).toBe('2026-11-01')
  })

  it('runs a month from its first day to the end of today', () => {
    const w = periodWindow('month', today)
    expect(w).toEqual({ start_date: '2026-11-01T00:00:00Z', end_date: '2026-11-01T23:59:59.999999Z' })
    const inside = (wire: string) => wire >= w.start_date && wire <= w.end_date
    expect(inside('2026-11-01T00:00:00Z')).toBe(true)
    expect(inside('2026-10-31T00:00:00Z')).toBe(false)
    expect(inside('2026-10-31T23:59:59.999999Z')).toBe(false)
  })

  it('runs a week across a month edge', () => {
    expect(periodWindow('week', today)).toEqual({ start_date: '2026-10-26T00:00:00Z', end_date: '2026-11-01T23:59:59.999999Z' })
  })

  it('runs a year from 1 January', () => {
    expect(periodWindow('year', today)).toEqual({ start_date: '2026-01-01T00:00:00Z', end_date: '2026-11-01T23:59:59.999999Z' })
  })
})

describe('periodWindow edges', () => {
  it('starts a week in the previous year in early January', () => {
    expect(periodWindow('week', '2027-01-03').start_date).toBe('2026-12-28T00:00:00Z')
  })

  it('ends a month on its last day', () => {
    expect(periodWindow('month', '2026-02-28')).toEqual({ start_date: '2026-02-01T00:00:00Z', end_date: '2026-02-28T23:59:59.999999Z' })
  })
})
