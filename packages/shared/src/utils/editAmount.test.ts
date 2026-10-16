import { describe, expect, it } from 'vitest'
import { editFormProjectedAmount, toTotal } from './editAmount'

describe('toTotal', () => {
  it('adds the interest to the principal', () => {
    expect(toTotal(100, 10)).toBe(110)
  })
  it('treats a null or missing interest as zero', () => {
    expect(toTotal(100, null)).toBe(100)
    expect(toTotal(100)).toBe(100)
  })
  it('rounds to whole cents', () => {
    expect(toTotal(0.1, 0.2)).toBe(0.3)
    expect(toTotal(0, 0)).toBe(0)
  })
})

describe('editFormProjectedAmount', () => {
  const base = { amount: 250, currency: 'PHP', is_posted: false }

  it('falls back to the amount for an unposted row with null projected', () => {
    expect(editFormProjectedAmount({ ...base, projected_amount: null }, false)).toBe(250)
  })
  it('falls back to the amount for an unposted row with undefined projected', () => {
    expect(editFormProjectedAmount({ ...base }, false)).toBe(250)
  })
  it('falls back to the amount when the projected currency matches', () => {
    expect(editFormProjectedAmount({ ...base, projected_currency: 'PHP' }, false)).toBe(250)
  })
  it('returns undefined for an unposted row in a different projected currency', () => {
    expect(editFormProjectedAmount({ ...base, projected_currency: 'USD' }, false)).toBeUndefined()
  })
  it('uses the whole payment for an unposted loan payment', () => {
    expect(editFormProjectedAmount({ ...base, amount: 100, transfer_fee: 10 }, true)).toBe(110)
  })
  it('keeps an explicit projected amount on a loan payment', () => {
    expect(editFormProjectedAmount({ ...base, amount: 100, transfer_fee: 10, projected_amount: 95 }, true)).toBe(95)
  })
  it('keeps a foreign projected amount that differs from the amount', () => {
    expect(
      editFormProjectedAmount({ ...base, projected_amount: 4.5, projected_currency: 'USD' }, false),
    ).toBe(4.5)
  })
  it('returns undefined for a posted non-loan row with null projected', () => {
    expect(editFormProjectedAmount({ ...base, is_posted: true, projected_amount: null }, false)).toBeUndefined()
  })
  it('keeps a projected amount of 0', () => {
    expect(editFormProjectedAmount({ ...base, projected_amount: 0 }, false)).toBe(0)
  })
})
