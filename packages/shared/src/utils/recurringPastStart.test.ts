import { describe, it, expect } from 'vitest'
import type { RecurrenceFrequency } from '../types/api'
import { generateOccurrences } from './recurrence'
import {
  moveToNextYear,
  pastStartWarning,
  schedulePreview,
  type ScheduleContext,
  type ScheduleDraft,
} from './scheduleDraft'

// STU-630: a next occurrence before today in the recurring entry form. The owner's case:
// a monthly entry meant for January 2027 saved on 5 January 2026, read on 15 November 2026.
const TODAY = '2026-11-15'

const draft = (over: Partial<ScheduleDraft> = {}): ScheduleDraft => ({
  cadence: 'monthly',
  next_occurrence: '2026-01-05T09:00',
  day: { kind: 'same_as_date' },
  end_mode: 'indefinite',
  end_date: undefined,
  max_occurrences: undefined,
  kind_choice: 'automatic',
  bank_kind: 'other',
  settlement: 'manual',
  ...over,
})

const ctx = (over: Partial<ScheduleContext> = {}): ScheduleContext => ({
  stored: null,
  entryType: 'income',
  transferToAccountId: undefined,
  account: { account_type: 'debit' },
  accountId: 1,
  ...over,
})

describe('recurring_past_start', () => {
  describe('warning_names_first_used_date', () => {
    // The first step on or after today, as the forecast walks an open-ended entry.
    const cases: [RecurrenceFrequency, string, string][] = [
      ['monthly', '2026-01-05T09:00', 'Dec 5th, 2026'],
      // 5 Jan 2026 is a Monday; 15 Nov 2026 a Sunday.
      ['weekly', '2026-01-05T09:00', 'Nov 16th, 2026'],
      // The 1st and the 15th: today's own occurrence counts.
      ['semi_monthly', '2026-01-05T09:00', 'Nov 15th, 2026'],
      ['quarterly', '2026-01-05T09:00', 'Jan 5th, 2027'],
      ['annual', '2026-01-05T09:00', 'Jan 5th, 2027'],
    ]
    for (const [cadence, value, first] of cases) {
      it(`${cadence}: names ${first}`, () => {
        const warning = pastStartWarning(draft({ cadence, next_occurrence: value }), ctx(), TODAY)
        expect(warning?.message).toBe(`This date is in the past. The first occurrence will be ${first}.`)
      })
    }

    it('gives the day it names', () => {
      expect(pastStartWarning(draft(), ctx(), TODAY)?.firstDay).toBe('2026-12-05')
    })

    it('equals the shared walk from today (generateOccurrences), for every cadence', () => {
      const cadences: RecurrenceFrequency[] = ['daily', 'weekly', 'biweekly', 'semi_monthly', 'monthly', 'quarterly', 'semi_annual', 'annual']
      for (const cadence of cadences) {
        const warning = pastStartWarning(draft({ cadence, next_occurrence: '2024-07-31T09:00' }), ctx(), TODAY)
        const walked = generateOccurrences(
          { cadence, next_occurrence: '2024-07-31T09:00:00Z', anchor_day: cadence === 'monthly' || cadence === 'quarterly' || cadence === 'semi_annual' || cadence === 'annual' ? 31 : null, day_rule: null },
          new Date(`${TODAY}T00:00:00Z`),
          new Date('2028-01-01T00:00:00Z'),
          2000,
        )[0]
        expect(warning?.firstDay, cadence).toBe(walked.toISOString().slice(0, 10))
      }
    })

    it('follows the Day control: day 31 clamps to Nov 30', () => {
      const warning = pastStartWarning(
        draft({ next_occurrence: '2026-01-31T09:00', day: { kind: 'day', day: 31 } }),
        ctx(),
        TODAY,
      )
      expect(warning?.message).toBe('This date is in the past. The first occurrence will be Nov 30th, 2026.')
    })

    it('follows the Day control: last weekday', () => {
      const warning = pastStartWarning(
        draft({ next_occurrence: '2026-01-30T09:00', day: { kind: 'last_weekday' } }),
        ctx(),
        TODAY,
      )
      expect(warning?.message).toBe('This date is in the past. The first occurrence will be Nov 30th, 2026.')
    })

    it('an edit keeps the stored twice-a-month days', () => {
      const stored = {
        cadence: 'semi_monthly' as const,
        next_occurrence: '2026-12-10T09:00:00Z',
        end_mode: 'indefinite',
        semi_monthly_day_1: 10,
        semi_monthly_day_2: 25,
      }
      const warning = pastStartWarning(draft({ cadence: 'semi_monthly' }), ctx({ stored }), TODAY)
      expect(warning?.firstDay).toBe('2026-11-25')
    })

    it('Edit shows the same warning as Add', () => {
      const stored = { cadence: 'monthly' as const, next_occurrence: '2026-12-05T09:00:00Z', end_mode: 'indefinite' }
      expect(pastStartWarning(draft(), ctx({ stored }), TODAY)).toEqual(pastStartWarning(draft(), ctx(), TODAY))
    })

    it('a capped entry owes its date: the first is the date itself, overdue', () => {
      const warning = pastStartWarning(
        draft({ next_occurrence: '2026-10-05T09:00', end_mode: 'after_occurrences', max_occurrences: 3 }),
        ctx(),
        TODAY,
      )
      expect(warning).toEqual({
        message: 'This date is in the past. The first occurrence will be Oct 5th, 2026, shown as overdue.',
        firstDay: '2026-10-05',
      })
    })

    it('an end date before today leaves no occurrence', () => {
      const warning = pastStartWarning(
        draft({ end_mode: 'on_date', end_date: '2026-06-01T00:00' }),
        ctx(),
        TODAY,
      )
      expect(warning).toEqual({
        message: 'This date is in the past, and the schedule has no occurrence left from today.',
        firstDay: null,
      })
    })

    it('Repeat (a fixed date) has no warning: its preview counts the missed payments', () => {
      expect(pastStartWarning(draft(), ctx({ dateFixed: true }), TODAY)).toBeNull()
    })
  })

  describe('move_to_next_year', () => {
    it('sets the year to the year after today, keeping month, day and time', () => {
      expect(moveToNextYear('2026-01-05T09:30', TODAY)).toBe('2027-01-05T09:30')
    })

    it('the warning goes away', () => {
      const moved = moveToNextYear('2026-01-05T09:30', TODAY)
      expect(pastStartWarning(draft({ next_occurrence: moved }), ctx(), TODAY)).toBeNull()
    })

    it('stays inside the next occurrence bounds (today plus 5 years)', () => {
      expect(moveToNextYear('2026-12-31T23:59', TODAY) <= '2031-11-15').toBe(true)
    })
  })

  describe('move_older_date_to_next_year', () => {
    it('a date years back moves to next year, not one year on', () => {
      expect(moveToNextYear('2019-03-10T08:00', TODAY)).toBe('2027-03-10T08:00')
      expect(pastStartWarning(draft({ next_occurrence: '2027-03-10T08:00' }), ctx(), TODAY)).toBeNull()
    })
  })

  describe('move_leap_day_to_next_year', () => {
    it('29 February becomes 28 February when next year is not a leap year', () => {
      expect(moveToNextYear('2024-02-29T07:00', TODAY)).toBe('2027-02-28T07:00')
    })

    it('29 February stays when next year is a leap year', () => {
      expect(moveToNextYear('2024-02-29T07:00', '2027-05-01')).toBe('2028-02-29T07:00')
    })
  })

  describe('no_warning_for_future', () => {
    it("today's date, at any time, has no warning", () => {
      expect(pastStartWarning(draft({ next_occurrence: `${TODAY}T00:00` }), ctx(), TODAY)).toBeNull()
      expect(pastStartWarning(draft({ next_occurrence: `${TODAY}T23:59` }), ctx(), TODAY)).toBeNull()
    })

    it('a future date has no warning, in every cadence', () => {
      for (const cadence of ['monthly', 'weekly', 'semi_monthly', 'quarterly', 'annual'] as const) {
        expect(pastStartWarning(draft({ cadence, next_occurrence: '2026-11-16T09:00' }), ctx(), TODAY)).toBeNull()
      }
    })

    it('yesterday has one', () => {
      expect(pastStartWarning(draft({ next_occurrence: '2026-11-14T23:59' }), ctx(), TODAY)).not.toBeNull()
    })

    it('an unreadable date has none', () => {
      expect(pastStartWarning(draft({ next_occurrence: '' }), ctx(), TODAY)).toBeNull()
    })
  })

  describe('existing_recurrence_results_unchanged', () => {
    it('the preview still lists the next three dates from the picked date', () => {
      expect(schedulePreview(draft(), ctx(), TODAY)).toEqual({
        label: 'Monthly · day 5',
        dates: ['Jan 5th, 2026', 'Feb 5th, 2026', 'Mar 5th, 2026'],
        missed: null,
      })
    })

    it("Repeat's missed count is unchanged", () => {
      const preview = schedulePreview(draft({ next_occurrence: '2026-09-05T09:00' }), ctx({ dateFixed: true }), TODAY)
      expect(preview && !('error' in preview) ? preview.missed : null).toBe('2 payments between then and today will show as missed')
    })

    it('a day the API would refuse is still its error', () => {
      const preview = schedulePreview(
        draft({ next_occurrence: '2026-01-05T09:00', day: { kind: 'last_weekday' } }),
        ctx(),
        TODAY,
      )
      expect(preview && 'error' in preview).toBe(true)
    })

    it('the shared walk steps as before', () => {
      const dates = generateOccurrences(
        { cadence: 'monthly', next_occurrence: '2026-01-31T09:00:00Z', anchor_day: 31, day_rule: null },
        new Date('2026-01-01T00:00:00Z'),
        new Date('2026-05-01T00:00:00Z'),
      ).map((d) => d.toISOString().slice(0, 10))
      expect(dates).toEqual(['2026-01-31', '2026-02-28', '2026-03-31', '2026-04-30'])
    })
  })
})
