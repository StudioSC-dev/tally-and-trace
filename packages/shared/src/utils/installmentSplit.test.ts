import { describe, it, expect } from 'vitest'
import {
  centavosToAmount,
  installmentInput,
  parseInstallmentMonths,
  parseInstallmentTotal,
  splitInstallment,
  trySplitInstallment,
} from './installmentSplit'
import { cappedPaymentDays, installmentScheduleDraft, repeatScheduleOf, scheduleRequest, type ScheduleContext } from './scheduleDraft'

const sum = (values: number[]) => values.reduce((total, value) => total + value, 0)

// STU-658 AC1: the bank rule (Metrobank, HSBC). Each payment but the last is the total ÷ N
// rounded half-up to the centavo, the last absorbs the difference, and they sum to the total.
describe('installment_split', () => {
  it('even_split: 12,000.00 over 12 is twelve payments of 1,000.00', () => {
    const split = splitInstallment(1_200_000, 12)
    expect(split).toMatchObject({ months: 12, first: 100_000, monthly: 100_000, last: 100_000 })
    expect(split.payments).toEqual(Array(12).fill(100_000))
    expect(sum(split.payments)).toBe(1_200_000)
  })

  it('last_higher: 10,000.00 over 3 is 3,333.33 twice then 3,333.34', () => {
    const split = splitInstallment(1_000_000, 3)
    expect(split.payments).toEqual([333_333, 333_333, 333_334])
    expect(sum(split.payments)).toBe(1_000_000)
    expect(centavosToAmount(split.first)).toBe(3333.33)
    expect(centavosToAmount(split.monthly)).toBe(3333.33)
    expect(centavosToAmount(split.last)).toBe(3333.34)
  })

  it('last_lower: 20,000.00 over 3 is 6,666.67 twice then 6,666.66', () => {
    const split = splitInstallment(2_000_000, 3)
    expect(split.payments).toEqual([666_667, 666_667, 666_666])
    expect(sum(split.payments)).toBe(2_000_000)
    expect(centavosToAmount(split.monthly)).toBe(6666.67)
    expect(centavosToAmount(split.last)).toBe(6666.66)
  })

  it('rounds half-up and puts the difference on the last, for many totals and counts', () => {
    for (const total of [7, 99, 100, 101, 150, 999_999, 1_000_000, 2_000_000, 123_456_789]) {
      for (const months of [1, 2, 3, 6, 7, 12, 24, 36, 360]) {
        const split = trySplitInstallment(total, months)
        const floor = Math.floor(total / months)
        const monthly = (total - floor * months) * 2 >= months ? floor + 1 : floor
        const last = total - monthly * (months - 1)
        if (monthly <= 0 || last <= 0) {
          expect(split).toBeNull()
          continue
        }
        if (split === null) throw new Error(`no split for ${total} over ${months}`)
        expect(split.payments).toHaveLength(months)
        expect(sum(split.payments)).toBe(total)
        expect(split.payments.slice(0, -1).every((payment) => payment === monthly)).toBe(true)
        expect(split.last).toBe(last)
        expect(split.first).toBe(split.payments[0])
      }
    }
  })

  it('one_month: the whole total is the first and only payment', () => {
    expect(splitInstallment(1_000_000, 1)).toEqual({ months: 1, first: 1_000_000, monthly: 1_000_000, last: 1_000_000, payments: [1_000_000] })
    expect(splitInstallment(1, 1).payments).toEqual([1])
  })

  it('two_months: the first is the rounded half and the last the rest', () => {
    expect(splitInstallment(1_000_001, 2)).toMatchObject({ first: 500_001, monthly: 500_001, last: 500_000, payments: [500_001, 500_000] })
    expect(splitInstallment(1_000_000, 2).payments).toEqual([500_000, 500_000])
  })

  it('nonpositive_payment_rejected: a monthly or last payment of zero or less is no split', () => {
    // Last zero: 0.01 over 2 rounds to 0.01 a month, leaving nothing for the last.
    expect(trySplitInstallment(1, 2)).toBeNull()
    expect(() => splitInstallment(1, 2)).toThrow(RangeError)
    // Monthly zero: 0.01 over 3 rounds to 0.00 a month.
    expect(trySplitInstallment(1, 3)).toBeNull()
    // Last negative: 0.05 over 8 rounds to 0.01 a month, seven of them more than the total.
    expect(trySplitInstallment(5, 8)).toBeNull()
    // Last zero with a total above the count: 0.06 over 4 is 0.02 a month, 0.06 for three.
    expect(trySplitInstallment(6, 4)).toBeNull()
    expect(installmentInput('0.01', '2')).toEqual({
      ok: false,
      field: 'installment_total',
      message: 'The purchase total is too small to split into 2 payments.',
    })
    expect(installmentInput('0.05', '8')).toMatchObject({ ok: false, field: 'installment_total' })
    expect(installmentInput('0.06', '4')).toMatchObject({ ok: false, field: 'installment_total' })
  })

  it('refuses a total or a count that is not a positive whole number', () => {
    expect(() => splitInstallment(0, 3)).toThrow(RangeError)
    expect(() => splitInstallment(100.5, 3)).toThrow(RangeError)
    expect(() => splitInstallment(100, 0)).toThrow(RangeError)
    expect(() => splitInstallment(100, 1.5)).toThrow(RangeError)
  })
})

describe('installment inputs (AC7)', () => {
  it('reads a total in whole centavos, with or without commas', () => {
    expect(parseInstallmentTotal('10,000.00')).toEqual({ ok: true, value: 1_000_000 })
    expect(parseInstallmentTotal(' 10000 ')).toEqual({ ok: true, value: 1_000_000 })
    expect(parseInstallmentTotal('0.5')).toEqual({ ok: true, value: 50 })
    expect(parseInstallmentTotal('.05')).toEqual({ ok: true, value: 5 })
    expect(parseInstallmentTotal('1234.5')).toEqual({ ok: true, value: 123_450 })
  })

  it.each([
    ['', 'Please enter the purchase total.'],
    ['   ', 'Please enter the purchase total.'],
    ['abc', 'Please enter the purchase total as a number.'],
    ['1e3', 'Please enter the purchase total as a number.'],
    ['0', 'The purchase total must be more than zero.'],
    ['0.00', 'The purchase total must be more than zero.'],
    ['-100', 'The purchase total must be more than zero.'],
    ['100.005', 'The purchase total can have at most two decimal places (centavos).'],
  ])('refuses the total %j', (text, message) => {
    expect(parseInstallmentTotal(text)).toEqual({ ok: false, message })
  })

  it('reads a whole number of months', () => {
    expect(parseInstallmentMonths('12')).toEqual({ ok: true, value: 12 })
    expect(parseInstallmentMonths(' 360 ')).toEqual({ ok: true, value: 360 })
  })

  it.each([
    ['', 'Please enter the number of months.'],
    ['six', 'Please enter the number of months as a number.'],
    ['0', 'The number of months must be more than zero.'],
    ['-3', 'The number of months must be more than zero.'],
    ['1.5', 'The number of months must be a whole number.'],
    ['361', 'The number of months can be at most 360.'],
  ])('refuses the months %j', (text, message) => {
    expect(parseInstallmentMonths(text)).toEqual({ ok: false, message })
  })

  it('checks the total, then the months, then a total too small to split', () => {
    expect(installmentInput('', '')).toMatchObject({ ok: false, field: 'installment_total' })
    expect(installmentInput('100', '')).toMatchObject({ ok: false, field: 'installment_months' })
    expect(installmentInput('0.02', '3')).toEqual({
      ok: false,
      field: 'installment_total',
      message: 'The purchase total is too small to split into 3 payments.',
    })
    expect(installmentInput('10,000.00', '3')).toEqual({ ok: true, split: splitInstallment(1_000_000, 3) })
  })
})

describe('installment schedule (AC3, AC4)', () => {
  const card = { account_type: 'credit', billing_cycle_start: 2 }
  const ctx: ScheduleContext = { stored: null, entryType: 'expense', account: card, accountId: 9, dateFixed: true }

  it('sends what Repeat sends for a card installment, with the months as its count', () => {
    const request = scheduleRequest(installmentScheduleDraft('2026-11-05T00:00', 3), ctx)
    expect(request).toEqual({
      ok: true,
      fields: {
        cadence: 'monthly',
        next_occurrence: '2026-11-05T00:00:00Z',
        end_mode: 'after_occurrences',
        end_date: undefined,
        max_occurrences: 3,
        billing_kind: null,
      },
    })
    if (!request.ok) return
    expect({ ...repeatScheduleOf(request.fields, 'manual'), amount: 3333.33 }).toEqual({
      cadence: 'monthly',
      end_mode: 'after_occurrences',
      end_date: undefined,
      max_occurrences: 3,
      billing_kind: null,
      settlement: 'manual',
      amount: 3333.33,
    })
  })

  it('names every payment on the statement closes, from the close holding the date', () => {
    expect(cappedPaymentDays(installmentScheduleDraft('2026-11-05T00:00', 3), ctx)).toEqual([
      '2026-12-02',
      '2027-01-02',
      '2027-02-02',
    ])
    expect(cappedPaymentDays(installmentScheduleDraft('2026-11-05T00:00', 1), ctx)).toEqual(['2026-12-02'])
  })

  it('is null for an unreadable date', () => {
    expect(cappedPaymentDays(installmentScheduleDraft('', 3), ctx)).toBeNull()
  })
})
