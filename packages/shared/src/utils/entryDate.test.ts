import { describe, it, expect } from 'vitest'
import { entryCalendarDate, entryDay, formatEntryDate, fromWireWallTime, parseEntryDate, toWireWallTime } from './entryDate'

// Budget-entry dates are wall time stored as UTC components: what the owner
// types is what the API stores, whatever the browser's zone (UTC+8 here).
describe.each(['next_occurrence', 'end_date'])('%s wire values', () => {
  it('sends the typed wall time as UTC components', () => {
    expect(toWireWallTime('2026-10-30T20:00')).toBe('2026-10-30T20:00:00Z')
  })

  it('fills the input from the stored UTC components', () => {
    expect(fromWireWallTime('2026-10-31T00:00:00Z')).toBe('2026-10-31T00:00')
  })

  it('shows the stored calendar date', () => {
    expect(formatEntryDate('2026-10-30T20:00:00Z')).toBe('Oct 30th, 2026')
  })

  it('round-trips the wall time three times unchanged', () => {
    let input = '2026-10-30T20:00'
    let wire = ''
    for (let i = 0; i < 3; i++) {
      wire = toWireWallTime(input)
      input = fromWireWallTime(wire)
    }
    expect(input).toBe('2026-10-30T20:00')
    expect(wire).toBe('2026-10-30T20:00:00Z')
  })
})

describe('wall-time helpers', () => {
  it('drops seconds from the input and refuses a malformed one', () => {
    expect(toWireWallTime('2026-10-30T20:00:59')).toBe('2026-10-30T20:00:00Z')
    expect(() => toWireWallTime('2026-10-30')).toThrow(RangeError)
  })

  it('reads an offset value through its UTC components', () => {
    expect(fromWireWallTime('2026-10-31T08:00:00+08:00')).toBe('2026-10-31T00:00')
    expect(formatEntryDate('2026-10-31T07:00:00+08:00')).toBe('Oct 30th, 2026')
  })

  it('reads a value without a zone as UTC components, not local time', () => {
    expect(parseEntryDate('2026-10-31T00:00:00').toISOString()).toBe('2026-10-31T00:00:00.000Z')
    expect(fromWireWallTime('2026-10-31T00:00:00')).toBe('2026-10-31T00:00')
  })

  it('gives the calendar day as local midnight for day arithmetic', () => {
    const day = entryCalendarDate('2026-10-30T20:00:00Z')
    expect([day.getFullYear(), day.getMonth() + 1, day.getDate(), day.getHours()]).toEqual([2026, 10, 30, 0])
  })

  it('reports an unreadable value', () => {
    expect(formatEntryDate('not a date')).toBe('Invalid date')
    expect(fromWireWallTime('not a date')).toBe('')
  })
})

// STU-309 AC1 and AC2: the transaction edit form shows the stored calendar day D in
// every browser zone. Run under TZ=Asia/Manila, America/Los_Angeles and UTC.
describe('edit_prefill_zones', () => {
  it('pre-fills the stored day for a naive D 00:00, a Z value and a Date', () => {
    expect(entryDay('2026-10-30T00:00:00')).toBe('2026-10-30')
    expect(entryDay('2026-10-30T00:00:00Z')).toBe('2026-10-30')
    expect(entryDay('2026-10-30T00:00:00.000000')).toBe('2026-10-30')
    expect(entryDay('2026-10-30')).toBe('2026-10-30')
    expect(entryDay(new Date('2026-10-30T00:00:00Z'))).toBe('2026-10-30')
  })

  it('keeps the day across month and year edges', () => {
    expect(entryDay('2026-03-01T00:00:00')).toBe('2026-03-01')
    expect(entryDay('2027-01-01T00:00:00')).toBe('2027-01-01')
    expect(entryDay('2028-02-29T00:00:00')).toBe('2028-02-29')
  })

  it('reports an unreadable value as empty', () => {
    expect(entryDay('not a date')).toBe('')
  })

  it('saves an untouched edit as the stored value (the create form sends D as UTC midnight)', () => {
    const day = entryDay('2026-10-30T00:00:00')
    expect(new Date(day).toISOString()).toBe('2026-10-30T00:00:00.000Z')
  })
})
