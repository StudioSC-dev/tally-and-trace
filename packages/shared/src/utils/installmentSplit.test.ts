import { describe, it, expect } from 'vitest'
import {
  centavosToAmount,
  installmentInput,
  parseInstallmentMonths,
  parseInstallmentTotal,
  splitInstallment,
} from './installmentSplit'
import { cappedPaymentDays, installmentScheduleDraft, repeatScheduleOf, scheduleRequest, type ScheduleContext } from './scheduleDraft'

const sum = (values: number[]) => values.reduce((total, value) => total + value, 0)

// STU-631 AC1: the split sums to the total, every payment but the first is the total ÷ N
// rounded down to centavos, and the remainder goes on the first.
describe('installment_split', () => {
  it('even_split: 12,000.00 over 12 is twelve payments of 1,000.00', () => {
    const split = splitInstallment(1_200_000, 12)
    expect(split).toMatchObject({ months: 12, first: 100_000, rest: 100_000 })
    expect(split.payments).toEqual(Array(12).fill(100_000))
    expect(sum(split.payments)).toBe(1_200_000)
  })

  it('remainder_on_first: 10,000.00 over 3 is 3,333.34 then 3,333.33 twice', () => {
    const split = splitInstallment(1_000_000, 3)
    expect(split.payments).toEqual([333_334, 333_333, 333_333])
    expect(sum(split.payments)).toBe(1_000_000)
    expect(centavosToAmount(split.first)).toBe(3333.34)
    expect(centavosToAmount(split.rest)).toBe(3333.33)
  })

  it('remainder_on_first: the rest are the total ÷ N rounded down, for many totals and counts', () => {
    for (const total of [1, 7, 99, 100, 101, 999_999, 1_000_000, 123_456_789]) {
      for (const months of [1, 2, 3, 6, 7, 12, 24, 36, 360]) {
        if (total < months) continue
        const split = splitInstallment(total, months)
        const floor = Math.floor(total / months)
        expect(split.payments).toHaveLength(months)
        expect(sum(split.payments)).toBe(total)
        expect(split.payments.slice(1).every((payment) => payment === floor)).toBe(true)
        expect(split.first).toBe(floor + (total - floor * months))
        expect(split.first - floor).toBeLessThan(months)
      }
    }
  })

  it('one_month: the whole total is the first and only payment', () => {
    expect(splitInstallment(1_000_000, 1)).toEqual({ months: 1, first: 1_000_000, rest: 1_000_000, payments: [1_000_000] })
    expect(splitInstallment(1, 1).payments).toEqual([1])
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
