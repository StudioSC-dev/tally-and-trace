import { afterEach, describe, it, expect } from 'vitest'
import type { LimitedTransaction, Transaction } from '../types/api'
import {
  addDays, dayEndWire, dayStartWire, listBounds, localToday, pageItems, pageWindow, relativeEntryDay,
  statusFromDate, transactionStatus, wallDay,
} from './transactionList'

// Transaction dates are wall time stored as UTC components. The suite runs in
// Asia/Manila (UTC+8), where a row at 16:00Z or later is already the next local day.
describe('wallDay', () => {
  it('reads the UTC calendar day whatever the time', () => {
    expect(wallDay('2026-10-14T23:30:00Z')).toBe('2026-10-14')
    expect(wallDay('2026-10-14T00:15:00Z')).toBe('2026-10-14')
  })

  it('treats a value without a zone as UTC components', () => {
    expect(wallDay('2026-10-14T23:30:00')).toBe('2026-10-14')
  })

  it('returns an empty string for garbage', () => {
    expect(wallDay('not a date')).toBe('')
    expect(wallDay('')).toBe('')
  })
})

describe('localToday', () => {
  it('uses the viewer\'s local components', () => {
    // 17:00Z is 01:00 the next day in Manila.
    expect(localToday(new Date('2026-10-16T17:00:00Z'))).toBe('2026-10-17')
    expect(localToday(new Date('2026-10-16T15:59:00Z'))).toBe('2026-10-16')
  })
})

describe('addDays', () => {
  it('rolls over month and year ends', () => {
    expect(addDays('2026-10-31', 1)).toBe('2026-11-01')
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01')
  })

  it('handles leap years', () => {
    expect(addDays('2028-02-28', 1)).toBe('2028-02-29')
    expect(addDays('2027-02-28', 1)).toBe('2027-03-01')
  })

  it('steps back across a month', () => {
    expect(addDays('2026-11-01', -1)).toBe('2026-10-31')
  })

  it('refuses a malformed day', () => {
    expect(() => addDays('2026-10', 1)).toThrow(RangeError)
  })
})

describe('day bounds', () => {
  it('builds the first and last instant of a day', () => {
    expect(dayStartWire('2026-10-16')).toBe('2026-10-16T00:00:00Z')
    expect(dayEndWire('2026-10-16')).toBe('2026-10-16T23:59:59.999999Z')
  })
})

describe('statusFromDate', () => {
  const today = '2026-10-16'

  it('lets posted win over any date', () => {
    expect(statusFromDate('2026-12-01T00:00:00Z', true, today)).toBe('posted')
    expect(statusFromDate('2026-09-01T00:00:00Z', true, today)).toBe('posted')
  })

  it('calls an unposted row on or before today pending', () => {
    expect(statusFromDate('2026-10-01T00:00:00Z', false, today)).toBe('pending')
    expect(statusFromDate('2026-10-16T00:00:00Z', false, today)).toBe('pending')
  })

  it('calls an unposted row after today planned', () => {
    expect(statusFromDate('2026-12-01T00:00:00Z', false, today)).toBe('planned')
  })

  it('reads the wall day, not the instant', () => {
    expect(statusFromDate('2026-10-16T23:30:00Z', false, today)).toBe('pending')
    expect(statusFromDate('2026-10-17T00:15:00Z', false, today)).toBe('planned')
  })

  it('treats an unreadable date as pending', () => {
    expect(statusFromDate('nonsense', false, today)).toBe('pending')
  })
})

describe('transactionStatus', () => {
  const today = '2026-10-16'
  const limited: LimitedTransaction = {
    view: 'limited',
    id: 1,
    permissions: { can_edit: false, can_delete: false, can_post: false, can_revert: false, can_tag: false },
    created_by: null,
    date: '2026-12-01T00:00:00Z',
    display_description: null,
    amount: 10,
    transfer_fee: null,
    currency: 'PHP',
    transaction_type: 'debit',
    is_posted: false,
    category_name: null,
    account: null,
    counterpart: null,
    tags: [],
  }

  it('reads a Limited row through its date', () => {
    expect(transactionStatus(limited, today)).toBe('planned')
    expect(transactionStatus({ ...limited, date: '2026-10-01T00:00:00Z' }, today)).toBe('pending')
    expect(transactionStatus({ ...limited, is_posted: true }, today)).toBe('posted')
  })

  it('reads a full row through its transaction date', () => {
    const full = {
      view: 'full',
      id: 2,
      transaction_date: '2026-10-01T00:00:00Z',
      is_posted: false,
    } as unknown as Transaction
    expect(transactionStatus(full, today)).toBe('pending')
  })
})

describe('listBounds', () => {
  const today = '2026-10-16'

  it('splits an open filter at today', () => {
    expect(listBounds('', '', today)).toEqual({
      main: { end: '2026-10-16T23:59:59.999999Z' },
      upcoming: { start: '2026-10-17T00:00:00Z' },
    })
  })

  it('leaves Upcoming null for a range entirely in the past', () => {
    expect(listBounds('2026-09-01', '2026-09-30', today)).toEqual({
      main: { start: '2026-09-01T00:00:00Z', end: '2026-09-30T23:59:59.999999Z' },
      upcoming: null,
    })
  })

  it('leaves main null for a range entirely in the future', () => {
    expect(listBounds('2026-12-01', '2026-12-31', today)).toEqual({
      main: null,
      upcoming: { start: '2026-12-01T00:00:00Z', end: '2026-12-31T23:59:59.999999Z' },
    })
  })

  it('splits a range that straddles today', () => {
    expect(listBounds('2026-10-01', '2026-10-31', today)).toEqual({
      main: { start: '2026-10-01T00:00:00Z', end: '2026-10-16T23:59:59.999999Z' },
      upcoming: { start: '2026-10-17T00:00:00Z', end: '2026-10-31T23:59:59.999999Z' },
    })
  })

  it('keeps today in main and starts Upcoming tomorrow', () => {
    expect(listBounds('2026-10-16', '2026-10-16', today)).toEqual({
      main: { start: '2026-10-16T00:00:00Z', end: '2026-10-16T23:59:59.999999Z' },
      upcoming: null,
    })
    expect(listBounds('2026-10-17', '2026-10-17', today)).toEqual({
      main: null,
      upcoming: { start: '2026-10-17T00:00:00Z', end: '2026-10-17T23:59:59.999999Z' },
    })
  })

  it('handles one open end', () => {
    expect(listBounds('2026-10-01', '', today)).toEqual({
      main: { start: '2026-10-01T00:00:00Z', end: '2026-10-16T23:59:59.999999Z' },
      upcoming: { start: '2026-10-17T00:00:00Z' },
    })
    expect(listBounds('', '2026-10-31', today)).toEqual({
      main: { end: '2026-10-16T23:59:59.999999Z' },
      upcoming: { start: '2026-10-17T00:00:00Z', end: '2026-10-31T23:59:59.999999Z' },
    })
  })
})

describe('relativeEntryDay', () => {
  const today = '2026-10-16'

  it('labels today, yesterday and tomorrow by wall day', () => {
    expect(relativeEntryDay('2026-10-16T16:45:00Z', today)).toBe('Today')
    expect(relativeEntryDay('2026-10-15T00:00:00Z', today)).toBe('Yesterday')
    expect(relativeEntryDay('2026-10-17T23:00:00Z', today)).toBe('Tomorrow')
  })

  it('falls back to the calendar day', () => {
    expect(relativeEntryDay('2026-10-30T00:00:00Z', today)).toBe('Oct 30th, 2026')
  })
})

describe('pageWindow', () => {
  it('gives an empty window for no rows', () => {
    expect(pageWindow(0, 1, 25)).toEqual({ from: 0, to: 0, pages: 0, page: 1 })
    expect(pageWindow(0, 4, 25)).toEqual({ from: 0, to: 0, pages: 0, page: 1 })
  })

  it('handles an exact multiple', () => {
    expect(pageWindow(50, 2, 25)).toEqual({ from: 26, to: 50, pages: 2, page: 2 })
  })

  it('handles a partial last page', () => {
    expect(pageWindow(181, 8, 25)).toEqual({ from: 176, to: 181, pages: 8, page: 8 })
    expect(pageWindow(181, 1, 25)).toEqual({ from: 1, to: 25, pages: 8, page: 1 })
  })

  it('clamps a page past the end', () => {
    expect(pageWindow(181, 99, 25)).toEqual({ from: 176, to: 181, pages: 8, page: 8 })
    expect(pageWindow(181, 0, 25).page).toBe(1)
  })
})

// Setting TZ at runtime re-reads the zone on the next Date call (Node, forks pool).
describe('zone independence', () => {
  const original = process.env.TZ
  afterEach(() => {
    if (original === undefined) delete process.env.TZ
    else process.env.TZ = original
  })

  it('gives the same strings in a western zone', () => {
    process.env.TZ = 'America/Los_Angeles'
    // Guard: the zone really changed (UTC-7 in October), or this test proves nothing.
    expect(new Date('2026-10-16T12:00:00Z').getTimezoneOffset()).toBe(420)

    expect(wallDay('2026-10-14T00:15:00Z')).toBe('2026-10-14')
    expect(wallDay('2026-10-14T23:30:00Z')).toBe('2026-10-14')
    expect(listBounds('2026-10-01', '2026-10-31', '2026-10-16')).toEqual({
      main: { start: '2026-10-01T00:00:00Z', end: '2026-10-16T23:59:59.999999Z' },
      upcoming: { start: '2026-10-17T00:00:00Z', end: '2026-10-31T23:59:59.999999Z' },
    })
    expect(relativeEntryDay('2026-10-15T00:00:00Z', '2026-10-16')).toBe('Yesterday')
    expect(relativeEntryDay('2026-10-30T00:00:00Z', '2026-10-16')).toBe('Oct 30th, 2026')
    // 2026-10-17T05:00Z is still the 16th in Los Angeles.
    expect(localToday(new Date('2026-10-17T05:00:00Z'))).toBe('2026-10-16')
  })
})

describe('pageItems', () => {
  it('shows a single page', () => {
    expect(pageItems(1, 1)).toEqual([1])
  })

  it('shows every page when there are few', () => {
    expect(pageItems(5, 3)).toEqual([1, 2, 3, 4, 5])
  })

  it('marks gaps with 0', () => {
    expect(pageItems(12, 6)).toEqual([1, 0, 5, 6, 7, 0, 12])
    expect(pageItems(12, 1)).toEqual([1, 2, 0, 12])
    expect(pageItems(12, 12)).toEqual([1, 0, 11, 12])
  })

  it('shows nothing without pages', () => {
    expect(pageItems(0, 1)).toEqual([])
  })
})
