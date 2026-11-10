import { describe, it, expect } from 'vitest'
import type { RecurrenceFrequency } from '../types/api'
import { dateForWeekday } from './entryDayFields'
import {
  bankKindOf,
  cadenceChoices,
  formatCadenceLabel,
  formatScheduleLabel,
  isLastWeekdayOfMonth,
  repeatFieldControl,
  repeatingRefusal,
  repeatScheduleOf,
  scheduleRequest,
  schedulePreview,
  scheduleState,
  type ScheduleContext,
  type ScheduleDraft,
  type StoredSchedule,
} from './scheduleDraft'

const draft = (over: Partial<ScheduleDraft> = {}): ScheduleDraft => ({
  cadence: 'monthly',
  next_occurrence: '2026-10-15T09:00',
  day: { kind: 'same_as_date' },
  end_mode: 'indefinite',
  end_date: undefined,
  max_occurrences: undefined,
  kind_choice: 'automatic',
  bank_kind: 'other',
  settlement: 'manual',
  ...over,
})

const bank = { account_type: 'debit' }
const card = { account_type: 'credit', billing_cycle_start: 20 }
const ctx = (over: Partial<ScheduleContext> = {}): ScheduleContext => ({
  stored: null,
  entryType: 'expense',
  transferToAccountId: undefined,
  account: bank,
  accountId: 7,
  ...over,
})

describe('scheduleRequest: the recurring form\'s checks and fields', () => {
  it('an open-ended monthly expense on a bank account sends the date\'s day and Other as null', () => {
    expect(scheduleRequest(draft(), ctx())).toEqual({
      ok: true,
      fields: {
        cadence: 'monthly',
        next_occurrence: '2026-10-15T09:00:00Z',
        anchor_day: 15,
        day_rule: null,
        end_mode: 'indefinite',
        end_date: undefined,
        max_occurrences: undefined,
        billing_kind: null,
      },
    })
  })

  it('no date', () => {
    expect(scheduleRequest(draft({ next_occurrence: '' }), ctx()))
      .toEqual({ ok: false, field: 'next_occurrence', message: 'Please choose the next occurrence date and time.' })
  })

  it('an unreadable date', () => {
    expect(scheduleRequest(draft({ next_occurrence: '2026-10-15' }), ctx()))
      .toEqual({ ok: false, field: 'next_occurrence', message: 'Please choose a valid next occurrence date and time.' })
  })

  it('"On date" with no end date', () => {
    expect(scheduleRequest(draft({ end_mode: 'on_date' }), ctx()))
      .toEqual({ ok: false, field: 'end_date', message: 'Please select the end date.' })
  })

  it('"On date" with an end date sends it as wire wall time', () => {
    const result = scheduleRequest(draft({ end_mode: 'on_date', end_date: '2027-01-01T00:00' }), ctx())
    expect(result.ok && result.fields.end_date).toBe('2027-01-01T00:00:00Z')
  })

  it('"After runs" with a count of 0', () => {
    expect(scheduleRequest(draft({ end_mode: 'after_occurrences', max_occurrences: 0 }), ctx()))
      .toEqual({ ok: false, field: 'max_occurrences', message: 'Please specify how many occurrences before the entry stops.' })
  })

  it('a day of month off its date is refused on the Day control with the API\'s detail', () => {
    expect(scheduleRequest(draft({ day: { kind: 'day', day: 20 } }), ctx())).toEqual({
      ok: false,
      field: 'day',
      message: 'next_occurrence must fall on day 20 of its month (2026-10-20)',
    })
  })

  it('a card installment on create sends no day fields, monthly, and Installment as null', () => {
    const result = scheduleRequest(
      draft({ cadence: 'quarterly', end_mode: 'after_occurrences', max_occurrences: 12, kind_choice: 'installment' }),
      ctx({ account: card }),
    )
    expect(result).toEqual({
      ok: true,
      fields: {
        cadence: 'monthly',
        next_occurrence: '2026-10-15T09:00:00Z',
        end_mode: 'after_occurrences',
        end_date: undefined,
        max_occurrences: 12,
        billing_kind: null,
      },
    })
    expect(result.ok && 'anchor_day' in result.fields).toBe(false)
  })

  it('a bank Subscription sends billing_kind "subscription"', () => {
    const result = scheduleRequest(draft({ bank_kind: 'subscription' }), ctx())
    expect(result.ok && result.fields.billing_kind).toBe('subscription')
  })

  it('a card subscription left on Automatic sends no billing_kind', () => {
    const result = scheduleRequest(draft(), ctx({ account: card }))
    expect(result.ok && 'billing_kind' in result.fields).toBe(false)
  })

  it('an edit sends a kind only when the pick moved off the stored one', () => {
    const stored: StoredSchedule = {
      cadence: 'monthly', next_occurrence: '2026-10-15T09:00:00Z', anchor_day: 15, day_rule: null,
      end_mode: 'indefinite', max_occurrences: null, billing_kind: 'subscription', kind: 'cash', account_id: 7,
    }
    const kept = scheduleRequest(draft({ day: { kind: 'day', day: 15 }, bank_kind: bankKindOf(stored.billing_kind) }), ctx({ stored }))
    expect(kept.ok && 'billing_kind' in kept.fields).toBe(false)
    const moved = scheduleRequest(draft({ day: { kind: 'day', day: 15 }, bank_kind: 'other' }), ctx({ stored }))
    expect(moved.ok && moved.fields.billing_kind).toBe(null)
    // The Day control unchanged from the stored row sends no day fields.
    expect(kept.ok && 'anchor_day' in kept.fields).toBe(false)
  })
})

describe('scheduleState', () => {
  it('a card expense shows the Kind select, a bank one the bank kind, income neither', () => {
    expect(scheduleState(draft(), ctx({ account: card }))).toMatchObject({ showKindSelect: true, showBankKindSelect: false })
    expect(scheduleState(draft(), ctx())).toMatchObject({ showKindSelect: false, showBankKindSelect: true })
    expect(scheduleState(draft(), ctx({ entryType: 'income' }))).toMatchObject({ showKindSelect: false, showBankKindSelect: false })
  })

  it('a capped card expense is charged on the close; a capped bill is not', () => {
    const capped = draft({ end_mode: 'after_occurrences', max_occurrences: 6 })
    expect(scheduleState(capped, ctx({ account: card }))).toMatchObject({ chargedOnClose: true, cardCloseDay: 20, kindValue: 'installment' })
    expect(scheduleState({ ...capped, kind_choice: 'bill' }, ctx({ account: card }))).toMatchObject({ chargedOnClose: false })
  })

  it('offers every Day choice on create and drops "Same as date" on an anchored stored row', () => {
    expect(scheduleState(draft(), ctx()).dayChoices).toEqual(['same_as_date', 'day', 'last_weekday'])
    const stored: StoredSchedule = {
      cadence: 'monthly', next_occurrence: '2026-10-15T09:00:00Z', anchor_day: 15, day_rule: null, end_mode: 'indefinite',
    }
    expect(scheduleState(draft({ day: { kind: 'day', day: 15 } }), ctx({ stored })).dayChoices).toEqual(['day', 'last_weekday'])
  })
})

describe('schedulePreview', () => {
  it('gives the label and the next three dates', () => {
    expect(schedulePreview(draft({ next_occurrence: '2026-01-31T00:00', day: { kind: 'day', day: 31 } }), ctx())).toEqual({
      label: 'Monthly · day 31',
      dates: ['Jan 31st, 2026', 'Feb 28th, 2026', 'Mar 31st, 2026'],
      missed: null,
    })
  })

  it('a card installment starts on its statement close', () => {
    const preview = schedulePreview(
      draft({ end_mode: 'after_occurrences', max_occurrences: 12, kind_choice: 'installment' }),
      ctx({ account: card }),
    )
    expect(preview).toEqual({ label: 'Monthly · day 20', dates: ['Oct 20th, 2026', 'Nov 20th, 2026', 'Dec 20th, 2026'], missed: null })
  })

  it('the API\'s detail for a day off its date', () => {
    expect(schedulePreview(draft({ day: { kind: 'last_weekday' } }), ctx()))
      .toEqual({ error: 'next_occurrence must be the last weekday of its month (2026-10-30)' })
  })

  it('weekly shows its weekday and next dates; no readable date shows nothing', () => {
    expect(schedulePreview(draft({ cadence: 'weekly' }), ctx())).toMatchObject({ label: 'Weekly · Thursday' })
    expect(schedulePreview(draft({ cadence: 'weekly', next_occurrence: '' }), ctx())).toBeNull()
  })
})

// Repeat in Add Transaction: the transaction's date is the first occurrence.
const fixed = (over: Partial<ScheduleContext> = {}) => ctx({ dateFixed: true, ...over })

describe('a fixed date (Repeat in Add Transaction)', () => {
  it('offers Last weekday only when the date is its month\'s last weekday', () => {
    expect(isLastWeekdayOfMonth('2026-10-30T00:00')).toBe(true)
    expect(isLastWeekdayOfMonth('2026-10-31T00:00')).toBe(false)
    expect(scheduleState(draft({ next_occurrence: '2026-10-30T00:00' }), fixed()).dayChoices).toEqual(['same_as_date', 'last_weekday'])
    expect(scheduleState(draft({ next_occurrence: '2026-10-29T00:00' }), fixed()).dayChoices).toEqual(['same_as_date'])
  })

  it('a Day choice the date no longer satisfies falls back to "Same as date"', () => {
    const moved = draft({ next_occurrence: '2026-10-29T00:00', day: { kind: 'last_weekday' } })
    expect(scheduleState(moved, fixed()).day).toEqual({ kind: 'same_as_date' })
    const result = scheduleRequest(moved, fixed())
    expect(result.ok && result.fields.anchor_day).toBe(29)
    expect(result.ok && result.fields.day_rule).toBe(null)
  })

  it('Last weekday on its date sends the rule', () => {
    const result = scheduleRequest(draft({ next_occurrence: '2026-10-30T00:00', day: { kind: 'last_weekday' } }), fixed())
    expect(result.ok && result.fields).toMatchObject({ anchor_day: null, day_rule: 'last_weekday' })
  })

  it('never offers semi-monthly', () => {
    expect(cadenceChoices({ dateFixed: true })).not.toContain('semi_monthly')
    expect(scheduleState(draft(), fixed()).cadenceChoices).toEqual(['weekly', 'biweekly', 'monthly', 'quarterly', 'semi_annual', 'annual'])
  })

  it('a card installment omits anchor_day: the server sets it to the close day', () => {
    const result = scheduleRequest(
      draft({ next_occurrence: '2026-11-10T00:00', end_mode: 'after_occurrences', max_occurrences: 12, kind_choice: 'installment' }),
      fixed({ account: card }),
    )
    expect(result.ok).toBe(true)
    expect(result.ok && repeatScheduleOf(result.fields, 'manual')).toEqual({
      cadence: 'monthly',
      end_mode: 'after_occurrences',
      end_date: undefined,
      max_occurrences: 12,
      billing_kind: null,
      settlement: 'manual',
    })
  })

  it('repeat carries no date and the settlement picked', () => {
    const result = scheduleRequest(draft(), fixed())
    const repeat = result.ok ? repeatScheduleOf(result.fields, 'autopay') : null
    expect(repeat).toEqual({
      cadence: 'monthly', anchor_day: 15, day_rule: null, end_mode: 'indefinite', end_date: undefined,
      max_occurrences: undefined, billing_kind: null, settlement: 'autopay',
    })
    expect(repeat && 'next_occurrence' in repeat).toBe(false)
  })

  it('the preview counts the payments a past date leaves missed', () => {
    const preview = schedulePreview(draft({ next_occurrence: '2026-07-15T00:00' }), fixed(), '2026-11-10')
    expect(preview).toEqual({
      label: 'Monthly · day 15',
      dates: ['Jul 15th, 2026', 'Aug 15th, 2026', 'Sep 15th, 2026'],
      missed: '3 payments between then and today will show as missed',
    })
  })

  it('one missed payment reads in the singular; today itself is not missed', () => {
    expect(schedulePreview(draft({ next_occurrence: '2026-10-10T00:00' }), fixed(), '2026-11-11'))
      .toMatchObject({ missed: '1 payment between then and today will show as missed' })
    expect(schedulePreview(draft({ next_occurrence: '2026-10-10T00:00' }), fixed(), '2026-11-10'))
      .toMatchObject({ missed: null })
  })

  it('today or a later date misses nothing, and an unfixed date never counts', () => {
    expect(schedulePreview(draft({ next_occurrence: '2026-11-10T00:00' }), fixed(), '2026-11-10')).toMatchObject({ missed: null })
    expect(schedulePreview(draft({ next_occurrence: '2026-07-15T00:00' }), ctx(), '2026-11-10')).toMatchObject({ missed: null })
  })
})

describe('repeatingRefusal', () => {
  it('reads the first error\'s request location', () => {
    expect(repeatingRefusal([{ loc: ['body', 'transaction', 'description'], msg: 'String should have at least 1 character' }]))
      .toEqual({ part: 'transaction', field: 'description', message: 'String should have at least 1 character' })
    expect(repeatingRefusal([{ loc: ['body', 'repeat', 'max_occurrences'], msg: 'too many' }]))
      .toEqual({ part: 'repeat', field: 'max_occurrences', message: 'too many' })
    expect(repeatingRefusal([{ loc: ['body', 'repeat'], msg: 'ends' }])).toEqual({ part: 'repeat', field: null, message: 'ends' })
  })

  it('a string detail names no field', () => {
    expect(repeatingRefusal('Turn autopay on from the recurring entry')).toEqual({ part: null, field: null, message: 'Turn autopay on from the recurring entry' })
    expect(repeatingRefusal(undefined)).toBeNull()
  })

  it('maps every RepeatSchedule field onto its control', () => {
    expect(repeatFieldControl('cadence')).toBe('cadence')
    expect(repeatFieldControl('anchor_day')).toBe('day')
    expect(repeatFieldControl('day_rule')).toBe('day')
    expect(repeatFieldControl('end_mode')).toBe('end_mode')
    expect(repeatFieldControl('end_date')).toBe('end_date')
    expect(repeatFieldControl('max_occurrences')).toBe('max_occurrences')
    expect(repeatFieldControl('billing_kind')).toBe('kind')
    expect(repeatFieldControl('settlement')).toBe('settlement')
  })

  it('leaves an unknown repeat field, or none, to the Repeat section line', () => {
    expect(repeatFieldControl('next_occurrence')).toBeNull()
    expect(repeatFieldControl('lead_time_days')).toBeNull()
    expect(repeatFieldControl(null)).toBeNull()
  })
})

describe('weekly and every-two-weeks labels', () => {
  const all: RecurrenceFrequency[] = ['daily', 'weekly', 'biweekly', 'semi_monthly', 'monthly', 'quarterly', 'semi_annual', 'annual']

  it('names the cadences, and no cadence reads as its raw value', () => {
    expect(formatCadenceLabel('biweekly')).toBe('Every 2 weeks')
    expect(formatCadenceLabel('semi_monthly')).toBe('Twice a month')
    for (const cadence of all) {
      expect(formatCadenceLabel(cadence)).not.toBe(cadence)
      expect(formatCadenceLabel(cadence)).toBeTruthy()
    }
  })

  it('a weekly schedule label carries the weekday of its date', () => {
    // 2026-10-13 is a Tuesday.
    expect(formatScheduleLabel('weekly', { next_occurrence: '2026-10-13T09:00:00Z' })).toBe('Weekly · Tuesday')
    expect(formatScheduleLabel('biweekly', { next_occurrence: '2026-10-16T00:00' })).toBe('Every 2 weeks · Friday')
    expect(formatScheduleLabel('biweekly', {})).toBe('Every 2 weeks')
    expect(formatScheduleLabel('monthly', { anchor_day: 5, next_occurrence: '2026-10-05T00:00:00Z' })).toBe('Monthly · day 5')
  })
})

describe('weekday and preview for weekly and every-two-weeks', () => {
  it('moves a date forward to the picked weekday, never earlier', () => {
    // 2026-10-12 is a Monday, 2026-10-15 a Thursday.
    expect(dateForWeekday('2026-10-12T09:30', 4)).toBe('2026-10-15T09:30')
    expect(dateForWeekday('2026-10-15T09:30', 4)).toBe('2026-10-15T09:30')
    expect(dateForWeekday('2026-10-15T09:30', 1)).toBe('2026-10-19T09:30')
    expect(dateForWeekday('2026-10-15T09:30', 0)).toBe('2026-10-18T09:30')
  })

  it('previews the next three weekly and bi-weekly dates', () => {
    const weekly = schedulePreview(draft({ cadence: 'weekly', next_occurrence: '2026-10-15T09:00' }), ctx())
    expect(weekly).toEqual({
      label: 'Weekly · Thursday',
      dates: ['Oct 15th, 2026', 'Oct 22nd, 2026', 'Oct 29th, 2026'],
      missed: null,
    })
    const biweekly = schedulePreview(draft({ cadence: 'biweekly', next_occurrence: '2026-10-15T09:00' }), ctx())
    expect(biweekly).toEqual({
      label: 'Every 2 weeks · Thursday',
      dates: ['Oct 15th, 2026', 'Oct 29th, 2026', 'Nov 12th, 2026'],
      missed: null,
    })
  })

  it('a weekly save sends no day fields', () => {
    const result = scheduleRequest(draft({ cadence: 'biweekly' }), ctx())
    expect(result.ok && result.fields.cadence).toBe('biweekly')
    expect(result.ok && 'anchor_day' in result.fields).toBe(false)
  })

  it('a fixed past date counts the weekly payments left missed', () => {
    const preview = schedulePreview(draft({ cadence: 'weekly', next_occurrence: '2026-10-01T00:00' }), fixed(), '2026-10-20')
    expect(preview && !('error' in preview) && preview.missed).toBe('2 payments between then and today will show as missed')
  })

  it('a card installment on a statement cycle stays monthly whatever the draft holds', () => {
    const state = scheduleState(
      draft({ cadence: 'weekly', end_mode: 'after_occurrences', max_occurrences: 12, kind_choice: 'installment' }),
      fixed({ account: card }),
    )
    expect(state.cadence).toBe('monthly')
    expect(state.chargedOnClose).toBe(true)
  })

  it('a card installment on a card with no statement cycle is monthly too, with no cadence choice', () => {
    const noCycle = { account_type: 'credit' }
    const installment = draft({ cadence: 'weekly', end_mode: 'after_occurrences', max_occurrences: 12, kind_choice: 'installment' })
    const state = scheduleState(installment, fixed({ account: noCycle }))
    expect(state.cadence).toBe('monthly')
    expect(state.cadenceLocked).toBe(true)
    expect(state.cadenceChoices).toEqual(['monthly'])
    expect(state.chargedOnClose).toBe(false)
    const result = scheduleRequest(installment, ctx({ account: noCycle }))
    expect(result.ok && result.fields.cadence).toBe('monthly')
    // A bill on the same card keeps the choice, and a weekly card subscription is untouched.
    const bill = scheduleState({ ...installment, kind_choice: 'bill' }, fixed({ account: noCycle }))
    expect([bill.cadence, bill.cadenceLocked]).toEqual(['weekly', false])
    expect(scheduleState(draft({ cadence: 'weekly' }), ctx({ account: noCycle })).cadence).toBe('weekly')
  })
})
