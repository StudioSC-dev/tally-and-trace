import { describe, it, expect } from 'vitest'
import {
  canPostAllDue,
  defaultMarkPaidDay,
  markPaidWireDate,
  postAllDueRange,
  readMaterializeHeaders,
  sameStatementCycle,
  skippedNotice,
  statementCycleClose,
} from './markPaid'

const card24 = { billing_cycle_start: 24 }

function headers(values: Record<string, string>) {
  const lower = new Map(Object.entries(values).map(([k, v]) => [k.toLowerCase(), v]))
  return { get: (name: string) => lower.get(name.toLowerCase()) ?? null }
}

describe('defaultMarkPaidDay', () => {
  it('uses the occurrence for a past subscription', () => {
    expect(defaultMarkPaidDay({ kind: 'subscription', occurrenceDate: '2026-10-18', today: '2026-10-20' })).toBe('2026-10-18')
  })

  it('caps a future cash occurrence at today', () => {
    expect(defaultMarkPaidDay({ kind: 'cash', occurrenceDate: '2026-11-01', today: '2026-10-17' })).toBe('2026-10-17')
  })

  it('keeps an installment on its occurrence even when it is ahead', () => {
    expect(defaultMarkPaidDay({ kind: 'installment', occurrenceDate: '2026-11-05', today: '2026-10-17' })).toBe('2026-11-05')
  })

  it('reads a wire occurrence by its UTC day', () => {
    expect(defaultMarkPaidDay({ kind: 'bill', occurrenceDate: '2026-10-18T00:00:00Z', today: '2026-10-20' })).toBe('2026-10-18')
  })
})

describe('markPaidWireDate', () => {
  it('appends midnight UTC', () => {
    expect(markPaidWireDate('2026-10-17')).toBe('2026-10-17T00:00:00Z')
  })

  it('rejects a non-day', () => {
    expect(() => markPaidWireDate('Oct 17')).toThrow(RangeError)
  })
})

describe('statementCycleClose', () => {
  it('closes on the close day itself', () => {
    expect(statementCycleClose(card24, '2026-10-24')).toBe('2026-10-24')
  })

  it('rolls to next month after the close day', () => {
    expect(statementCycleClose(card24, '2026-10-25')).toBe('2026-11-24')
  })

  it('rolls over a year end', () => {
    expect(statementCycleClose(card24, '2026-12-30')).toBe('2027-01-24')
  })

  it('clamps a day-31 close to a short month', () => {
    expect(statementCycleClose({ billing_cycle_start: 31 }, '2027-02-10')).toBe('2027-02-28')
  })

  it('derives the close from a legacy due day', () => {
    expect(statementCycleClose({ due_date: 14, days_until_due_date: 21 }, '2026-10-20')).toBe('2026-10-24')
  })

  it('defaults a legacy card to 21 days until due', () => {
    expect(statementCycleClose({ due_date: 14 }, '2026-10-20')).toBe('2026-10-24')
  })

  it('is null without cycle settings', () => {
    expect(statementCycleClose({}, '2026-10-20')).toBeNull()
  })
})

describe('sameStatementCycle', () => {
  it('is false across the close', () => {
    expect(sameStatementCycle(card24, '2026-11-05', '2026-10-18')).toBe(false)
  })

  it('is true inside one cycle', () => {
    expect(sameStatementCycle(card24, '2026-11-05', '2026-10-30')).toBe(true)
  })

  it('has nothing to warn about without cycle settings', () => {
    expect(sameStatementCycle({}, '2026-11-05', '2026-10-18')).toBe(true)
  })
})

describe('readMaterializeHeaders', () => {
  it('parses all four headers', () => {
    expect(
      readMaterializeHeaders(
        headers({
          'X-Occurrence-Outcome': 'posted_pending',
          'X-Occurrence-Recorded': '2026-10-18',
          'X-Occurrences-Skipped-Count': '3',
          'X-Occurrences-Skipped': '2026-07-18, 2026-08-18,2026-09-18',
        }),
      ),
    ).toEqual({
      outcome: 'posted_pending',
      recorded: '2026-10-18',
      skippedCount: 3,
      skipped: ['2026-07-18', '2026-08-18', '2026-09-18'],
    })
  })

  it('reads absent headers as nothing happened', () => {
    expect(readMaterializeHeaders(headers({}))).toEqual({ outcome: null, recorded: null, skippedCount: 0, skipped: [] })
  })

  it('reads a zero count without a skipped list', () => {
    const read = readMaterializeHeaders(headers({ 'X-Occurrence-Outcome': 'created', 'X-Occurrences-Skipped-Count': '0' }))
    expect(read.outcome).toBe('created')
    expect(read.skippedCount).toBe(0)
    expect(read.skipped).toEqual([])
  })

  it('drops an unknown outcome', () => {
    expect(readMaterializeHeaders(headers({ 'X-Occurrence-Outcome': 'mystery' })).outcome).toBeNull()
  })
})

describe('skippedNotice', () => {
  it('says nothing when none were skipped', () => {
    expect(skippedNotice(0, [])).toBeNull()
  })

  it('lists up to five dates', () => {
    expect(skippedNotice(3, ['2026-07-18', '2026-08-18', '2026-09-18'])).toBe(
      'Skipping 3 earlier occurrences: Jul 18th, 2026, Aug 18th, 2026, Sep 18th, 2026',
    )
  })

  it('uses the singular for one', () => {
    expect(skippedNotice(1, ['2026-09-18'])).toBe('Skipping 1 earlier occurrence: Sep 18th, 2026')
  })

  it('gives the count and the oldest above five', () => {
    const dates = Array.from({ length: 60 }, (_, i) => `2024-${String((i % 12) + 1).padStart(2, '0')}-01`)
    expect(skippedNotice(73, dates)).toBe('Skipping 73 earlier occurrences, the oldest on Jan 1st, 2024')
  })

  it('falls back to the count when the dates are missing', () => {
    expect(skippedNotice(2, [])).toBe('Skipping 2 earlier occurrences')
  })
})

describe('canPostAllDue', () => {
  it('is true for several due cash occurrences', () => {
    expect(canPostAllDue({ kind: 'cash', capped: false, sameCurrency: true, due_unposted: 3 })).toBe(true)
  })

  it('is true for a subscription', () => {
    expect(canPostAllDue({ kind: 'subscription', capped: false, sameCurrency: true, due_unposted: 2 })).toBe(true)
  })

  it('is false for a capped entry even when its kind is cash', () => {
    expect(canPostAllDue({ kind: 'cash', capped: true, sameCurrency: true, due_unposted: 4 })).toBe(false)
  })

  it('is false for one due occurrence', () => {
    expect(canPostAllDue({ kind: 'cash', capped: false, sameCurrency: true, due_unposted: 1 })).toBe(false)
  })

  it('is false for a bill, an installment and no kind', () => {
    expect(canPostAllDue({ kind: 'bill', capped: false, sameCurrency: true, due_unposted: 3 })).toBe(false)
    expect(canPostAllDue({ kind: 'installment', capped: false, sameCurrency: true, due_unposted: 3 })).toBe(false)
    expect(canPostAllDue({ kind: null, capped: false, sameCurrency: true, due_unposted: 3 })).toBe(false)
  })

  it('is false for a foreign-currency entry', () => {
    expect(canPostAllDue({ kind: 'subscription', capped: false, sameCurrency: false, due_unposted: 3 })).toBe(false)
  })
})

describe('postAllDueRange', () => {
  const occ = (date: string, due: boolean, linked: 'pending' | 'posted' | 'ambiguous' | null = null) => ({
    occurrence_date: date, due, linked, skipped_before: 0,
  })

  it('uses the server range even when no listed occurrence is due', () => {
    const listed = [occ('2026-10-20', false)]
    expect(postAllDueRange({ oldest_due: '2025-01-05', latest_due: '2026-09-05' }, listed)).toEqual({
      oldest: '2025-01-05', latest: '2026-09-05',
    })
  })

  it('is null when the server reports none, whatever is listed', () => {
    expect(postAllDueRange({ oldest_due: null, latest_due: null }, [occ('2026-09-05', true)])).toBeNull()
  })

  it('falls back to the listed unposted due occurrences when the fields are absent', () => {
    const listed = [occ('2026-07-05', true, 'posted'), occ('2026-08-05', true), occ('2026-09-05', true, 'pending'), occ('2026-10-20', false)]
    expect(postAllDueRange({}, listed)).toEqual({ oldest: '2026-08-05', latest: '2026-09-05' })
    expect(postAllDueRange({}, [occ('2026-10-20', false)])).toBeNull()
  })
})
