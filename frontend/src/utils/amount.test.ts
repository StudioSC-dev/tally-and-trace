import { describe, expect, it } from 'vitest'
import { amountSign, formatAmount, formatBalance, formatSigned } from './amount'

describe('formatSigned', () => {
  it('leads a negative amount with a minus sign, never a hyphen', () => {
    expect(formatSigned(-18321.2, 'PHP')).toBe('−₱18,321.20')
    expect(formatSigned(-86.4, 'USD')).toBe('−$86.40')
    expect(formatSigned(-1234.5, 'EUR')).toBe('−1 234,50 €')
  })

  it('leaves a positive amount as plain currency', () => {
    expect(formatSigned(84250.4, 'PHP')).toBe('₱84,250.40')
  })

  it('never signs a zero: 0, -0 and amounts under half the smallest unit', () => {
    for (const amount of [0, -0, 0.004, -0.004]) expect(formatSigned(amount, 'PHP')).toBe('₱0.00')
    expect(formatSigned(-0.4, 'JPY')).toBe('¥0')
  })

  it('signs an amount that rounds to one smallest unit below zero', () => {
    expect(formatSigned(-0.005, 'PHP')).toBe('−₱0.01')
  })
})

describe('formatAmount and formatBalance', () => {
  it('use the same minus sign and leave zero unsigned', () => {
    expect(formatBalance(-18742.3, 'PHP')).toBe('−₱18,742.30')
    expect(formatBalance(-0, 'PHP')).toBe('₱0.00')
    expect(formatAmount('out', -50, 'PHP')).toBe('−₱50.00')
    expect(formatAmount('negative', -0.004, 'PHP')).toBe('₱0.00')
    expect(formatAmount('in', 0, 'PHP')).toBe('₱0.00')
    expect(formatAmount('in', 41250, 'PHP')).toBe('+₱41,250.00')
  })
})

describe('amountSign', () => {
  it('is + above zero, a minus sign below, and nothing for a figure that reads as zero', () => {
    expect(amountSign(80, 'PHP')).toBe('+')
    expect(amountSign(-80, 'PHP')).toBe('−')
    for (const amount of [0, -0, 0.004, -0.004]) expect(amountSign(amount, 'PHP')).toBe('')
  })
})
