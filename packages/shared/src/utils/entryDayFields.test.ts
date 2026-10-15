import { describe, it, expect } from 'vitest'
import {
  buildEntryDayFields,
  dateForDaySetting,
  daySettingOf,
  resolveEntryDayFields,
  type StoredDayRow,
} from './entryDayFields'

const legacy: StoredDayRow = { cadence: 'monthly', next_occurrence: '2026-10-31T00:00:00Z', anchor_day: null, day_rule: null }
const anchored: StoredDayRow = { cadence: 'monthly', next_occurrence: '2026-10-31T00:00:00Z', anchor_day: 31, day_rule: null }
const ruled: StoredDayRow = { cadence: 'monthly', next_occurrence: '2026-10-30T00:00:00Z', anchor_day: null, day_rule: 'last_weekday' }
const weekly: StoredDayRow = { cadence: 'weekly', next_occurrence: '2026-10-30T00:00:00Z', anchor_day: null, day_rule: null }

describe('buildEntryDayFields', () => {
  describe('create, month family: sends the chosen field and nulls the other', () => {
    it('a day of month', () => {
      expect(buildEntryDayFields({ cadence: 'monthly', day: { kind: 'day', day: 31 }, nextOccurrence: '2026-10-31T00:00:00Z' }))
        .toEqual({ anchor_day: 31, day_rule: null })
    })

    it('the last-weekday rule', () => {
      expect(buildEntryDayFields({ cadence: 'quarterly', day: { kind: 'last_weekday' }, nextOccurrence: '2026-10-30T00:00:00Z' }))
        .toEqual({ anchor_day: null, day_rule: 'last_weekday' })
    })

    it('"Same as date" sends the date\'s UTC day as the anchor', () => {
      expect(buildEntryDayFields({ cadence: 'monthly', day: { kind: 'same_as_date' }, nextOccurrence: '2026-10-30T20:00:00Z' }))
        .toEqual({ anchor_day: 30, day_rule: null })
    })
  })

  it('create outside the month family sends neither', () => {
    expect(buildEntryDayFields({ cadence: 'weekly', day: { kind: 'same_as_date' }, nextOccurrence: '2026-10-30T00:00:00Z' }))
      .toEqual({})
  })

  it('update of a legacy row left on "Same as date" omits both, even when the date moved', () => {
    expect(buildEntryDayFields({ cadence: 'monthly', day: daySettingOf(legacy), nextOccurrence: '2026-11-10T00:00:00Z', stored: legacy }))
      .toEqual({})
  })

  it('update of a legacy row given a day sends it', () => {
    expect(buildEntryDayFields({ cadence: 'monthly', day: { kind: 'day', day: 31 }, nextOccurrence: '2026-10-31T00:00:00Z', stored: legacy }))
      .toEqual({ anchor_day: 31, day_rule: null })
  })

  it('update of an anchored row with only the date changed omits both', () => {
    expect(buildEntryDayFields({ cadence: 'monthly', day: daySettingOf(anchored), nextOccurrence: '2026-11-10T00:00:00Z', stored: anchored }))
      .toEqual({})
  })

  it('an explicit Day change sends the new day and nulls the rule', () => {
    expect(buildEntryDayFields({ cadence: 'monthly', day: { kind: 'day', day: 15 }, nextOccurrence: '2026-10-15T00:00:00Z', stored: anchored }))
      .toEqual({ anchor_day: 15, day_rule: null })
  })

  it('switching anchor to rule and rule to anchor sends both explicitly', () => {
    expect(buildEntryDayFields({ cadence: 'monthly', day: { kind: 'last_weekday' }, nextOccurrence: '2026-10-30T00:00:00Z', stored: anchored }))
      .toEqual({ anchor_day: null, day_rule: 'last_weekday' })
    expect(buildEntryDayFields({ cadence: 'monthly', day: { kind: 'day', day: 31 }, nextOccurrence: '2026-10-31T00:00:00Z', stored: ruled }))
      .toEqual({ anchor_day: 31, day_rule: null })
  })

  it('a cadence leaving the month family sends both null', () => {
    expect(buildEntryDayFields({ cadence: 'weekly', day: daySettingOf(anchored), nextOccurrence: '2026-10-31T00:00:00Z', stored: anchored }))
      .toEqual({ anchor_day: null, day_rule: null })
  })

  it('unrelated edits omit both', () => {
    for (const stored of [legacy, anchored, ruled]) {
      expect(buildEntryDayFields({ cadence: stored.cadence, day: daySettingOf(stored), nextOccurrence: stored.next_occurrence, stored }))
        .toEqual({})
    }
    expect(buildEntryDayFields({ cadence: 'weekly', day: daySettingOf(weekly), nextOccurrence: weekly.next_occurrence, stored: weekly }))
      .toEqual({})
  })

  it('a row entering the month family with the control untouched omits both (the API derives)', () => {
    expect(buildEntryDayFields({ cadence: 'monthly', day: daySettingOf(weekly), nextOccurrence: weekly.next_occurrence, stored: weekly }))
      .toEqual({})
  })
})

describe('resolveEntryDayFields mirrors the API', () => {
  const resolve = (args: Parameters<typeof resolveEntryDayFields>[0]) => resolveEntryDayFields(args)

  it('derives the anchor on create', () => {
    expect(resolve({ cadence: 'monthly', nextOccurrence: '2026-10-31T00:00:00Z', sent: {} }))
      .toEqual({ ok: true, anchor_day: 31, day_rule: null })
  })

  it('refuses both fields, a rule off its date and an anchor off its date', () => {
    expect(resolve({ cadence: 'monthly', nextOccurrence: '2026-10-30T00:00:00Z', sent: { anchor_day: 30, day_rule: 'last_weekday' } }).ok).toBe(false)
    expect(resolve({ cadence: 'monthly', nextOccurrence: '2026-10-31T00:00:00Z', sent: { day_rule: 'last_weekday' } }))
      .toEqual({ ok: false, error: 'next_occurrence must be the last weekday of its month (2026-10-30)' })
    expect(resolve({ cadence: 'monthly', nextOccurrence: '2027-03-10T00:00:00Z', sent: { anchor_day: 31 } }))
      .toEqual({ ok: false, error: 'next_occurrence must fall on day 31 of its month (2027-03-31)' })
  })

  it('keeps a legacy row legacy and an anchored row on a clamped date', () => {
    expect(resolve({ cadence: 'monthly', nextOccurrence: '2026-11-10T00:00:00Z', sent: {}, stored: legacy }))
      .toEqual({ ok: true, anchor_day: null, day_rule: null })
    expect(resolve({ cadence: 'monthly', nextOccurrence: '2027-02-28T00:00:00Z', sent: {}, stored: anchored }))
      .toEqual({ ok: true, anchor_day: 31, day_rule: null })
  })

  it('re-anchors a row moved off its anchor and derives one entering the month family', () => {
    expect(resolve({ cadence: 'monthly', nextOccurrence: '2026-11-10T00:00:00Z', sent: {}, stored: anchored }))
      .toEqual({ ok: true, anchor_day: 10, day_rule: null })
    expect(resolve({ cadence: 'monthly', nextOccurrence: '2026-10-30T00:00:00Z', sent: {}, stored: weekly }))
      .toEqual({ ok: true, anchor_day: 30, day_rule: null })
  })

  it('clearing a rule derives from the date; leaving the month family clears both', () => {
    expect(resolve({ cadence: 'monthly', nextOccurrence: '2026-10-30T00:00:00Z', sent: { day_rule: null }, stored: ruled }))
      .toEqual({ ok: true, anchor_day: 30, day_rule: null })
    expect(resolve({ cadence: 'weekly', nextOccurrence: '2026-10-30T00:00:00Z', sent: { anchor_day: null, day_rule: null }, stored: ruled }))
      .toEqual({ ok: true, anchor_day: null, day_rule: null })
  })

  it('an anchor sent as null with no rule is a legacy row', () => {
    expect(resolve({ cadence: 'monthly', nextOccurrence: '2026-10-30T00:00:00Z', sent: { anchor_day: null }, stored: anchored }))
      .toEqual({ ok: true, anchor_day: null, day_rule: null })
  })
})

describe('dateForDaySetting', () => {
  it('choosing the rule fills the last weekday of the date\'s month, keeping the time', () => {
    expect(dateForDaySetting('2026-10-15T09:30', { kind: 'last_weekday' })).toBe('2026-10-30T09:30')
    expect(dateForDaySetting('2027-01-02T00:00', { kind: 'last_weekday' })).toBe('2027-01-29T00:00')
  })

  it('choosing a day fills that day, clamped to the month', () => {
    expect(dateForDaySetting('2027-02-10T00:00', { kind: 'day', day: 31 })).toBe('2027-02-28T00:00')
    expect(dateForDaySetting('2026-10-10T20:00', { kind: 'day', day: 31 })).toBe('2026-10-31T20:00')
  })

  it('"Same as date" leaves the date alone', () => {
    expect(dateForDaySetting('2026-10-10T20:00', { kind: 'same_as_date' })).toBe('2026-10-10T20:00')
  })
})
