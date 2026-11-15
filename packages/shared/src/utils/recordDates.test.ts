import { afterEach, describe, expect, it, vi } from 'vitest'
import { ENTRY_END_YEARS_AHEAD, ENTRY_NEXT_YEARS_AHEAD, RECORD_DATE_MIN, recordDateError, recordDateMax } from './recordDates'

describe('recordDateMax', () => {
  it('is five years after the given day', () => {
    expect(recordDateMax('2026-10-21')).toBe('2031-10-21')
  })

  it('clamps Feb 29 to Feb 28', () => {
    expect(recordDateMax('2028-02-29')).toBe('2033-02-28')
  })

  it('leaves Feb 28 alone, including into a leap year', () => {
    expect(recordDateMax('2019-02-28')).toBe('2024-02-28')
  })

  describe('default day', () => {
    afterEach(() => {
      vi.useRealTimers()
    })

    it('is the Manila day', () => {
      vi.useFakeTimers()
      vi.setSystemTime(new Date('2026-10-21T16:30:00Z'))
      expect(recordDateMax()).toBe('2031-10-22')
    })
  })
})

describe('recordDateError', () => {
  const today = '2026-10-21'
  const message = 'Choose a date from Jan 1st, 2000 to Oct 21st, 2031'

  it('exposes the lower bound', () => {
    expect(RECORD_DATE_MIN).toBe('2000-01-01')
  })

  it('is null at both bounds', () => {
    expect(recordDateError('2000-01-01', today)).toBeNull()
    expect(recordDateError('2031-10-21', today)).toBeNull()
    expect(recordDateError(today, today)).toBeNull()
  })

  it('is null for an empty optional value', () => {
    expect(recordDateError('', today)).toBeNull()
  })

  it('names the range for a date outside it', () => {
    expect(recordDateError('0006-05-10', today)).toBe(message)
    expect(recordDateError('1999-12-31', today)).toBe(message)
    expect(recordDateError('2031-10-22', today)).toBe(message)
  })

  it('names the range for something that is not a date', () => {
    expect(recordDateError('abc', today)).toBe(message)
    expect(recordDateError('2026-02-30', today)).toBe(message)
    expect(recordDateError('20266-05-10', today)).toBe(message)
  })

  describe('default day', () => {
    afterEach(() => {
      vi.useRealTimers()
    })

    it('is the Manila day', () => {
      vi.useFakeTimers()
      vi.setSystemTime(new Date('2026-10-21T16:30:00Z'))
      expect(recordDateError('2031-10-22')).toBeNull()
      expect(recordDateError('2031-10-23')).toBe('Choose a date from Jan 1st, 2000 to Oct 22nd, 2031')
    })
  })
})

describe('recurring-entry reach (STU-427)', () => {
  const today = '2026-10-21'

  it('bounds the next occurrence five years out and the end date thirty', () => {
    expect([ENTRY_NEXT_YEARS_AHEAD, ENTRY_END_YEARS_AHEAD]).toEqual([5, 30])
    expect(recordDateMax(today, ENTRY_NEXT_YEARS_AHEAD)).toBe('2031-10-21')
    expect(recordDateMax(today, ENTRY_END_YEARS_AHEAD)).toBe('2056-10-21')
    expect(recordDateMax('2028-02-29', ENTRY_END_YEARS_AHEAD)).toBe('2058-02-28')
  })

  it('names the end date range, inclusive at both bounds', () => {
    const message = 'Choose a date from Jan 1st, 2000 to Oct 21st, 2056'
    expect(recordDateError('2000-01-01', today, ENTRY_END_YEARS_AHEAD)).toBeNull()
    expect(recordDateError('2056-10-21', today, ENTRY_END_YEARS_AHEAD)).toBeNull()
    expect(recordDateError('1999-12-31', today, ENTRY_END_YEARS_AHEAD)).toBe(message)
    expect(recordDateError('2056-10-22', today, ENTRY_END_YEARS_AHEAD)).toBe(message)
  })
})
