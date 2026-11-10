import { describe, it, expect } from 'vitest'
import {
  bankKindOf,
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
    })
  })

  it('a card installment starts on its statement close', () => {
    const preview = schedulePreview(
      draft({ end_mode: 'after_occurrences', max_occurrences: 12, kind_choice: 'installment' }),
      ctx({ account: card }),
    )
    expect(preview).toEqual({ label: 'Monthly · day 20', dates: ['Oct 20th, 2026', 'Nov 20th, 2026', 'Dec 20th, 2026'] })
  })

  it('the API\'s detail for a day off its date', () => {
    expect(schedulePreview(draft({ day: { kind: 'last_weekday' } }), ctx()))
      .toEqual({ error: 'next_occurrence must be the last weekday of its month (2026-10-30)' })
  })

  it('nothing outside the month family', () => {
    expect(schedulePreview(draft({ cadence: 'weekly' }), ctx())).toBeNull()
  })
})
