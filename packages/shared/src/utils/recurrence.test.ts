import { describe, it, expect } from 'vitest'
import { generateOccurrences, addCadence, type RecurringSchedule } from './recurrence'

const d = (s: string) => new Date(s + 'T00:00:00')
const fmt = (arr: Date[]) => arr.map((o) => `${o.getMonth() + 1}/${o.getDate()}`)

const entry = (over: Partial<RecurringSchedule> & Pick<RecurringSchedule, 'cadence' | 'next_occurrence'>): RecurringSchedule => ({
  end_mode: 'indefinite',
  ...over,
})

describe('generateOccurrences', () => {
  it('weekly steps every 7 days', () => {
    expect(fmt(generateOccurrences(entry({ cadence: 'weekly', next_occurrence: '2026-08-01T00:00:00' }), d('2026-08-01'), d('2026-08-31'))))
      .toEqual(['8/1', '8/8', '8/15', '8/22', '8/29'])
  })

  it('biweekly steps every 14 days', () => {
    expect(fmt(generateOccurrences(entry({ cadence: 'biweekly', next_occurrence: '2026-08-01T00:00:00' }), d('2026-08-01'), d('2026-08-31'))))
      .toEqual(['8/1', '8/15', '8/29'])
  })

  it('semi_monthly fires on default days 1 & 15', () => {
    expect(fmt(generateOccurrences(entry({ cadence: 'semi_monthly', next_occurrence: '2026-08-01T00:00:00' }), d('2026-08-01'), d('2026-09-30'))))
      .toEqual(['8/1', '8/15', '9/1', '9/15'])
  })

  it('semi_monthly honours custom days', () => {
    expect(fmt(generateOccurrences(entry({ cadence: 'semi_monthly', next_occurrence: '2026-08-05T00:00:00', semi_monthly_day_1: 5, semi_monthly_day_2: 20 }), d('2026-08-01'), d('2026-08-31'))))
      .toEqual(['8/5', '8/20'])
  })

  it('semi_monthly clamps a day-31 to the month length (Feb -> 28)', () => {
    expect(fmt(generateOccurrences(entry({ cadence: 'semi_monthly', next_occurrence: '2026-02-01T00:00:00', semi_monthly_day_1: 15, semi_monthly_day_2: 31 }), d('2026-02-01'), d('2026-02-28'))))
      .toEqual(['2/15', '2/28'])
  })

  it('monthly steps by month', () => {
    expect(fmt(generateOccurrences(entry({ cadence: 'monthly', next_occurrence: '2026-08-01T00:00:00' }), d('2026-08-01'), d('2026-10-31'))))
      .toEqual(['8/1', '9/1', '10/1'])
  })

  it('caps at max_occurrences', () => {
    expect(fmt(generateOccurrences(entry({ cadence: 'monthly', next_occurrence: '2026-08-01T00:00:00', end_mode: 'after_occurrences', max_occurrences: 2 }), d('2026-08-01'), d('2026-12-01'))))
      .toEqual(['8/1', '9/1'])
  })

  it('stops at end_date', () => {
    expect(fmt(generateOccurrences(entry({ cadence: 'monthly', next_occurrence: '2026-08-01T00:00:00', end_mode: 'on_date', end_date: '2026-09-15T00:00:00' }), d('2026-08-01'), d('2026-12-01'))))
      .toEqual(['8/1', '9/1'])
  })

  it('excludes occurrences before the window when the anchor is in the past', () => {
    // Anchor is 2026-06-01, but the window starts 2026-08-01, so Jun/Jul are dropped.
    // Range end is inclusive (callers pass end-of-month).
    expect(fmt(generateOccurrences(entry({ cadence: 'monthly', next_occurrence: '2026-06-01T00:00:00' }), d('2026-08-01'), d('2026-09-30'))))
      .toEqual(['8/1', '9/1'])
  })
})

describe('addCadence', () => {
  it('advances weekly/biweekly by days', () => {
    expect(addCadence(d('2026-08-01'), 'weekly').getDate()).toBe(8)
    expect(addCadence(d('2026-08-01'), 'biweekly').getDate()).toBe(15)
  })
})
