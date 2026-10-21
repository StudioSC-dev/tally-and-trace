import { describe, it, expect } from 'vitest'
import type { CardCredit, CreditCheck, CreditStatus } from '../types/api'
import { availableCreditText, creditCheckKey, creditStatusText, entryCreditWarning, entryCreditWarnings, plannedChargesText } from './cardCredit'

function check(over: Partial<CreditCheck> = {}): CreditCheck {
  return {
    source: 'budget_entry',
    source_id: 7,
    date: '2027-04-12',
    occurrence_date: '2027-04-12',
    kind: 'bill',
    amount: 1799,
    available_after: 100,
    available_after_without_planned: 100,
    status: 'ok',
    relies_on_planned: null,
    ...over,
  }
}

const credit: Pick<CardCredit, 'currency' | 'available_now' | 'available_with_planned' | 'planned_by' | 'complete'> = {
  currency: 'PHP',
  available_now: 1851.1,
  available_with_planned: 11851.1,
  planned_by: '2027-04-01',
  complete: true,
}

describe('creditCheckKey', () => {
  it('uses the occurrence date for an entry', () => {
    expect(creditCheckKey(check({ date: '2027-04-13', occurrence_date: '2027-04-12' }))).toBe('budget_entry:7:2027-04-12')
  })

  it('uses the date for a transaction', () => {
    expect(creditCheckKey(check({ source: 'transaction', source_id: 9, date: '2027-03-22', occurrence_date: null })))
      .toBe('transaction:9:2027-03-22')
  })
})

describe('creditStatusText', () => {
  const cases: Array<[CreditStatus, string | null, string]> = [
    ['ok', null, 'OK'],
    ['ok_with_planned', '2027-04-01', 'OK with planned payment by Apr 1st, 2027'],
    ['at_risk', null, 'Would exceed available credit'],
    ['installment', null, 'Installment: already held'],
    ['unchecked', null, 'No exchange rate: not checked'],
    ['incomplete', null, 'Credit check incomplete'],
  ]
  it.each(cases)('%s', (status, relies, text) => {
    expect(creditStatusText({ status, relies_on_planned: relies })).toBe(text)
  })
})

describe('availableCreditText', () => {
  it('reads the figure and the planned line', () => {
    expect(availableCreditText(credit)).toEqual({
      available: '₱1,851.10',
      withPlanned: '₱11,851.10 with planned payment by Apr 1st, 2027',
    })
  })

  it('says "at most" when the figure is incomplete', () => {
    expect(availableCreditText({ ...credit, complete: false }).available).toBe('at most ₱1,851.10')
  })

  it('has no planned line without a planned payment', () => {
    expect(availableCreditText({ ...credit, available_with_planned: 1851.1, planned_by: null }).withPlanned).toBeNull()
  })
})

describe('plannedChargesText', () => {
  it('reads the amount in the card currency', () => {
    expect(plannedChargesText({ currency: 'PHP', planned_charges_total: 4000 })).toBe(
      '₱4,000.00 in charges dated later in the next 30 days, taken off on their dates',
    )
    expect(plannedChargesText({ currency: 'USD', planned_charges_total: 4000 })).toBe(
      '$4,000.00 in charges dated later in the next 30 days, taken off on their dates',
    )
  })

  it('is null for zero', () => {
    expect(plannedChargesText({ currency: 'PHP', planned_charges_total: 0 })).toBeNull()
  })

  it('is null when the field is missing', () => {
    const missing = { currency: 'PHP' } as Pick<CardCredit, 'currency' | 'planned_charges_total'>
    expect(plannedChargesText(missing)).toBeNull()
  })
})

describe('entryCreditWarnings', () => {
  it('keeps the non-ok checks of one entry in date order', () => {
    const checks = [
      check({ occurrence_date: '2027-05-12', date: '2027-05-12', status: 'at_risk' }),
      check({ occurrence_date: '2027-04-12', date: '2027-04-12', status: 'ok_with_planned', relies_on_planned: '2027-04-01' }),
      check({ occurrence_date: '2027-03-12', date: '2027-03-12', status: 'ok' }),
      check({ source_id: 8, status: 'at_risk' }),
      check({ source: 'transaction', source_id: 7, occurrence_date: null, status: 'at_risk' }),
    ]
    expect(entryCreditWarnings(checks, 7).map((c) => c.occurrence_date)).toEqual(['2027-04-12', '2027-05-12'])
  })
})

describe('entryCreditWarning', () => {
  it('returns null for no checks, and for only ok and installment checks', () => {
    expect(entryCreditWarning([], 7)).toBeNull()
    expect(entryCreditWarning([check({ status: 'ok' }), check({ status: 'installment' })], 7)).toBeNull()
  })

  // The more severe check is dated later, so date order cannot give the right answer.
  const severity: Array<[CreditStatus, CreditStatus, number]> = [
    ['at_risk', 'unchecked', 1],
    ['unchecked', 'incomplete', 1],
    ['incomplete', 'ok_with_planned', 0],
  ]
  it.each(severity)('%s beats %s in either input order', (severe, mild, more) => {
    const a = check({ status: severe, date: '2027-04-20', occurrence_date: '2027-04-20' })
    const b = check({ status: mild, date: '2027-04-05', occurrence_date: '2027-04-05' })
    for (const input of [[a, b], [b, a]]) {
      const got = entryCreditWarning(input, 7)
      expect(got?.check).toBe(a)
      expect(got?.more).toBe(more)
    }
  })

  it('picks the earliest of two checks with the same status', () => {
    const may = check({ status: 'at_risk', date: '2027-05-12', occurrence_date: '2027-05-12' })
    const apr = check({ status: 'at_risk', date: '2027-04-12', occurrence_date: '2027-04-12' })
    const got = entryCreditWarning([may, apr], 7)
    expect(got?.check).toBe(apr)
    expect(got?.more).toBe(1)
  })

  it('counts warnings only in more', () => {
    const got = entryCreditWarning([
      check({ status: 'at_risk', occurrence_date: '2027-04-01', date: '2027-04-01' }),
      check({ status: 'incomplete', occurrence_date: '2027-04-08', date: '2027-04-08' }),
      check({ status: 'ok_with_planned', occurrence_date: '2027-04-15', date: '2027-04-15' }),
      check({ status: 'ok_with_planned', occurrence_date: '2027-04-22', date: '2027-04-22' }),
    ], 7)
    expect(got?.check.status).toBe('at_risk')
    expect(got?.more).toBe(1)
  })

  it('ignores other entries and transaction checks with the same id', () => {
    expect(entryCreditWarning([
      check({ source_id: 8, status: 'at_risk' }),
      check({ source: 'transaction', source_id: 7, status: 'at_risk', occurrence_date: null }),
    ], 7)).toBeNull()
  })

  it('falls back to date when occurrence_date is null', () => {
    const late = check({ status: 'at_risk', date: '2027-04-20', occurrence_date: null })
    const early = check({ status: 'at_risk', date: '2027-04-05', occurrence_date: null })
    expect(entryCreditWarning([late, early], 7)?.check).toBe(early)
  })

  it('does not change its input', () => {
    const input = [
      check({ status: 'incomplete', date: '2027-04-20', occurrence_date: '2027-04-20' }),
      check({ status: 'at_risk', date: '2027-04-05', occurrence_date: '2027-04-05' }),
    ]
    const copy = structuredClone(input)
    entryCreditWarning(input, 7)
    expect(input).toEqual(copy)
  })
})
