import { describe, it, expect } from 'vitest'
import {
  addCadence,
  generateOccurrences,
  lastWeekday,
  ruleDate,
  stepOccurrence,
  type RecurringSchedule,
} from './recurrence'

// Every date here is UTC components (the budget-entry wire contract), and the
// suite runs at UTC+8, so a local-time slip shows up as a wrong day.
const u = (s: string) => new Date(s + 'T00:00:00Z')
const days = (arr: Date[]) => arr.map((o) => o.toISOString().slice(0, 10))
const FAR = u('2100-01-01')

const entry = (over: Partial<RecurringSchedule> & Pick<RecurringSchedule, 'cadence' | 'next_occurrence'>): RecurringSchedule => ({
  end_mode: 'indefinite',
  ...over,
})

/** The first `n` occurrences from `next_occurrence`. */
const firstN = (e: RecurringSchedule, n: number) =>
  days(generateOccurrences(e, new Date(e.next_occurrence), FAR, n))

describe('generateOccurrences', () => {
  it('weekly steps every 7 days', () => {
    expect(days(generateOccurrences(entry({ cadence: 'weekly', next_occurrence: '2026-08-01T00:00:00Z' }), u('2026-08-01'), u('2026-08-31'))))
      .toEqual(['2026-08-01', '2026-08-08', '2026-08-15', '2026-08-22', '2026-08-29'])
  })

  it('biweekly steps every 14 days', () => {
    expect(days(generateOccurrences(entry({ cadence: 'biweekly', next_occurrence: '2026-08-01T00:00:00Z' }), u('2026-08-01'), u('2026-08-31'))))
      .toEqual(['2026-08-01', '2026-08-15', '2026-08-29'])
  })

  it('semi_monthly fires on default days 1 & 15', () => {
    expect(days(generateOccurrences(entry({ cadence: 'semi_monthly', next_occurrence: '2026-08-01T00:00:00Z' }), u('2026-08-01'), u('2026-09-30'))))
      .toEqual(['2026-08-01', '2026-08-15', '2026-09-01', '2026-09-15'])
  })

  it('semi_monthly honours custom days', () => {
    expect(days(generateOccurrences(entry({ cadence: 'semi_monthly', next_occurrence: '2026-08-05T00:00:00Z', semi_monthly_day_1: 5, semi_monthly_day_2: 20 }), u('2026-08-01'), u('2026-08-31'))))
      .toEqual(['2026-08-05', '2026-08-20'])
  })

  it('semi_monthly clamps a day-31 to the month length (Feb -> 28)', () => {
    expect(days(generateOccurrences(entry({ cadence: 'semi_monthly', next_occurrence: '2026-02-01T00:00:00Z', semi_monthly_day_1: 15, semi_monthly_day_2: 31 }), u('2026-02-01'), u('2026-02-28'))))
      .toEqual(['2026-02-15', '2026-02-28'])
  })

  it('semi_monthly works in UTC components late in the UTC day', () => {
    expect(generateOccurrences(entry({ cadence: 'semi_monthly', next_occurrence: '2026-08-01T20:00:00Z' }), u('2026-08-01'), u('2026-08-31'))
      .map((o) => o.toISOString()))
      .toEqual(['2026-08-01T20:00:00.000Z', '2026-08-15T20:00:00.000Z'])
  })

  it('monthly steps by month', () => {
    expect(days(generateOccurrences(entry({ cadence: 'monthly', next_occurrence: '2026-08-01T00:00:00Z' }), u('2026-08-01'), u('2026-10-31'))))
      .toEqual(['2026-08-01', '2026-09-01', '2026-10-01'])
  })

  it('caps at max_occurrences', () => {
    expect(days(generateOccurrences(entry({ cadence: 'monthly', next_occurrence: '2026-08-01T00:00:00Z', end_mode: 'after_occurrences', max_occurrences: 2 }), u('2026-08-01'), u('2026-12-01'))))
      .toEqual(['2026-08-01', '2026-09-01'])
  })

  it('an exhausted installment (max_occurrences 0) has no occurrences', () => {
    expect(firstN(entry({ cadence: 'monthly', next_occurrence: '2026-08-01T00:00:00Z', end_mode: 'after_occurrences', max_occurrences: 0 }), 5))
      .toEqual([])
    expect(days(generateOccurrences(entry({ cadence: 'semi_monthly', next_occurrence: '2026-08-01T00:00:00Z', end_mode: 'after_occurrences', max_occurrences: 0 }), u('2026-08-01'), u('2026-12-01'))))
      .toEqual([])
  })

  it('max_occurrences 1 yields one occurrence', () => {
    expect(firstN(entry({ cadence: 'monthly', next_occurrence: '2026-08-01T00:00:00Z', end_mode: 'after_occurrences', max_occurrences: 1 }), 5))
      .toEqual(['2026-08-01'])
  })

  it('stops at end_date', () => {
    expect(days(generateOccurrences(entry({ cadence: 'monthly', next_occurrence: '2026-08-01T00:00:00Z', end_mode: 'on_date', end_date: '2026-09-15T00:00:00Z' }), u('2026-08-01'), u('2026-12-01'))))
      .toEqual(['2026-08-01', '2026-09-01'])
  })

  it('includes an occurrence on the end_date itself', () => {
    expect(firstN(entry({ cadence: 'monthly', anchor_day: 31, next_occurrence: '2026-10-31T00:00:00Z', end_mode: 'on_date', end_date: '2026-12-31T00:00:00Z' }), 6))
      .toEqual(['2026-10-31', '2026-11-30', '2026-12-31'])
  })

  it('excludes occurrences before the window when the anchor is in the past', () => {
    // Range end is inclusive (callers pass end-of-month).
    expect(days(generateOccurrences(entry({ cadence: 'monthly', next_occurrence: '2026-06-01T00:00:00Z' }), u('2026-08-01'), u('2026-09-30'))))
      .toEqual(['2026-08-01', '2026-09-01'])
  })

  it('anchor 31 returns to the 31st after a short month', () => {
    expect(firstN(entry({ cadence: 'monthly', anchor_day: 31, next_occurrence: '2026-10-31T00:00:00Z' }), 6))
      .toEqual(['2026-10-31', '2026-11-30', '2026-12-31', '2027-01-31', '2027-02-28', '2027-03-31'])
  })

  it('a legacy entry (no anchor, no rule) keeps clamping from the current day', () => {
    expect(firstN(entry({ cadence: 'monthly', next_occurrence: '2026-10-31T00:00:00Z' }), 6))
      .toEqual(['2026-10-31', '2026-11-30', '2026-12-30', '2027-01-30', '2027-02-28', '2027-03-28'])
  })

  it('leap-year anchors 29, 30 and 31 land on Feb 29 and return', () => {
    for (const day of [29, 30, 31]) {
      expect(firstN(entry({ cadence: 'monthly', anchor_day: day, next_occurrence: `2028-01-${day}T00:00:00Z` }), 3))
        .toEqual([`2028-01-${day}`, '2028-02-29', `2028-03-${day}`])
    }
  })

  it('quarterly anchor 31', () => {
    expect(firstN(entry({ cadence: 'quarterly', anchor_day: 31, next_occurrence: '2026-08-31T00:00:00Z' }), 5))
      .toEqual(['2026-08-31', '2026-11-30', '2027-02-28', '2027-05-31', '2027-08-31'])
  })

  it('semi-annual anchor 31', () => {
    expect(firstN(entry({ cadence: 'semi_annual', anchor_day: 31, next_occurrence: '2026-08-31T00:00:00Z' }), 3))
      .toEqual(['2026-08-31', '2027-02-28', '2027-08-31'])
  })

  it('annual anchor 29 returns to Feb 29 in the next leap year', () => {
    expect(firstN(entry({ cadence: 'annual', anchor_day: 29, next_occurrence: '2028-02-29T00:00:00Z' }), 5))
      .toEqual(['2028-02-29', '2029-02-28', '2030-02-28', '2031-02-28', '2032-02-29'])
  })

  it('last_weekday lands on the last Monday-Friday of each month', () => {
    expect(firstN(entry({ cadence: 'monthly', day_rule: 'last_weekday', next_occurrence: '2026-10-30T00:00:00Z' }), 5))
      .toEqual(['2026-10-30', '2026-11-30', '2026-12-31', '2027-01-29', '2027-02-26'])
    expect(firstN(entry({ cadence: 'monthly', day_rule: 'last_weekday', next_occurrence: '2028-01-31T00:00:00Z' }), 2))
      .toEqual(['2028-01-31', '2028-02-29'])
  })

  it('keeps the time of day on rule dates', () => {
    expect(generateOccurrences(entry({ cadence: 'monthly', day_rule: 'last_weekday', next_occurrence: '2026-10-30T20:30:00Z' }), u('2026-10-01'), FAR, 2)
      .map((o) => o.toISOString()))
      .toEqual(['2026-10-30T20:30:00.000Z', '2026-11-30T20:30:00.000Z'])
  })

  it('ignores the day fields on weekly, biweekly and semi-monthly entries', () => {
    const fields = { anchor_day: 31, day_rule: 'last_weekday' as const }
    expect(firstN(entry({ cadence: 'weekly', next_occurrence: '2026-08-01T00:00:00Z', ...fields }), 3))
      .toEqual(['2026-08-01', '2026-08-08', '2026-08-15'])
    expect(firstN(entry({ cadence: 'biweekly', next_occurrence: '2026-08-01T00:00:00Z', ...fields }), 3))
      .toEqual(['2026-08-01', '2026-08-15', '2026-08-29'])
    expect(days(generateOccurrences(entry({ cadence: 'semi_monthly', next_occurrence: '2026-08-01T00:00:00Z', ...fields }), u('2026-08-01'), u('2026-08-31'))))
      .toEqual(['2026-08-01', '2026-08-15'])
  })

  it('a capped installment with an anchor consumes the cap on rule dates', () => {
    expect(firstN(entry({ cadence: 'monthly', anchor_day: 31, next_occurrence: '2026-10-31T00:00:00Z', end_mode: 'after_occurrences', max_occurrences: 3 }), 10))
      .toEqual(['2026-10-31', '2026-11-30', '2026-12-31'])
  })

  it('reads an offset or naive next_occurrence as UTC components', () => {
    expect(firstN(entry({ cadence: 'monthly', anchor_day: 31, next_occurrence: '2026-11-01T07:00:00+08:00' }), 2))
      .toEqual(['2026-10-31', '2026-11-30'])
    expect(firstN(entry({ cadence: 'monthly', anchor_day: 31, next_occurrence: '2026-10-31T00:00:00' }), 2))
      .toEqual(['2026-10-31', '2026-11-30'])
  })
})

describe('addCadence', () => {
  it('advances weekly/biweekly by days', () => {
    expect(addCadence(u('2026-08-01'), 'weekly').toISOString().slice(0, 10)).toBe('2026-08-08')
    expect(addCadence(u('2026-08-01'), 'biweekly').toISOString().slice(0, 10)).toBe('2026-08-15')
  })

  it('clamps a month step instead of overflowing (Jan 31 + 1 month is Feb 28, not Mar 3)', () => {
    expect(addCadence(u('2026-01-31'), 'monthly').toISOString()).toBe('2026-02-28T00:00:00.000Z')
    expect(addCadence(u('2028-02-29'), 'annual').toISOString()).toBe('2029-02-28T00:00:00.000Z')
  })
})

describe('day rules', () => {
  it('lastWeekday moves a weekend month end to Friday', () => {
    expect(lastWeekday(2026, 10).toISOString().slice(0, 10)).toBe('2026-10-30')
    expect(lastWeekday(2027, 1).toISOString().slice(0, 10)).toBe('2027-01-29')
    expect(lastWeekday(2026, 11).toISOString().slice(0, 10)).toBe('2026-11-30')
  })

  it('ruleDate gives the rule or clamped anchor date, or null for a legacy entry', () => {
    expect(ruleDate({ day_rule: 'last_weekday' }, 2026, 10)?.toISOString().slice(0, 10)).toBe('2026-10-30')
    expect(ruleDate({ anchor_day: 31 }, 2027, 2)?.toISOString().slice(0, 10)).toBe('2027-02-28')
    expect(ruleDate({ anchor_day: null, day_rule: null }, 2027, 2)).toBeNull()
  })

  it('stepOccurrence steps from the month, not the clamped day', () => {
    const e = { cadence: 'monthly' as const, anchor_day: 31 }
    expect(stepOccurrence(e, new Date('2027-02-28T09:15:00Z')).toISOString()).toBe('2027-03-31T09:15:00.000Z')
  })
})
