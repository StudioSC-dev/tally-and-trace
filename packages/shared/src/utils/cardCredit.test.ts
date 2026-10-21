import { describe, it, expect } from 'vitest'
import type { CardCredit, CreditCheck, CreditStatus } from '../types/api'
import { availableCreditText, creditCheckKey, creditStatusText, entryCreditWarnings } from './cardCredit'

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
