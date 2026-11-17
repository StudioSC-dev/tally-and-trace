import { describe, expect, it } from 'vitest'
import { formatCurrency } from './currency'
import { estimateText, formatCoded } from './fx'
import type { EstimateLabels } from './fx'

// The API sends a null original when a statement mixes currencies; the type only lists absence.
const noOriginal = { estimated: true, original_amount: null, original_currency: null } as unknown as EstimateLabels

// Characterization: these pin the current output of estimateText for each branch.
describe('estimateText', () => {
  it('unconverted_with_original', () => {
    const labels = { unconverted: true as const, original_amount: 80, original_currency: 'USD' as const }
    expect(estimateText(100, 'PHP', labels)).toBe('USD 80.00 (no rate yet)')
  })

  it('null_amount', () => {
    expect(estimateText(null, 'PHP', {})).toBe('—')
  })

  it('estimated_with_original', () => {
    const labels = { estimated: true as const, original_amount: 80, original_currency: 'USD' as const }
    expect(estimateText(4640, 'PHP', labels)).toBe('≈ PHP 4,640.00 (USD 80.00)')
  })

  it('estimated_without_original', () => {
    expect(estimateText(4640, 'PHP', noOriginal)).toBe('≈ PHP 4,640.00')
  })

  it('plain_amount', () => {
    expect(estimateText(100, 'PHP', {})).toBe(formatCurrency(100, 'PHP'))
  })

  it('helper_characterization_regressions', () => {
    const usd = { original_amount: 80, original_currency: 'USD' as const }
    expect(estimateText(100, 'PHP', { unconverted: true as const, ...usd })).toBe('USD 80.00 (no rate yet)')
    expect(estimateText(null, 'PHP', {})).toBe('—')
    expect(estimateText(4640, 'PHP', { estimated: true as const, ...usd })).toBe('≈ PHP 4,640.00 (USD 80.00)')
    expect(estimateText(4640, 'PHP', noOriginal)).toBe('≈ PHP 4,640.00')
    expect(estimateText(100, 'PHP', {})).toBe(formatCurrency(100, 'PHP'))
  })
})

describe('negative and zero figures', () => {
  it('write a negative plain figure with a minus sign before the symbol', () => {
    expect(estimateText(-100, 'PHP', {})).toBe('−₱100.00')
    expect(estimateText(-100, 'USD', {})).toBe('−$100.00')
    expect(estimateText(-0.004, 'PHP', {})).toBe('₱0.00')
  })

  it('write a negative coded figure with a minus sign before the code, and never sign zero', () => {
    expect(formatCoded(-80, 'USD')).toBe('−USD 80.00')
    expect(formatCoded(-0, 'USD')).toBe('USD 0.00')
    expect(formatCoded(-0.004, 'PHP')).toBe('PHP 0.00')
    const labels = { estimated: true as const, original_amount: -40, original_currency: 'USD' as const }
    expect(estimateText(-2320, 'PHP', labels)).toBe('≈ −PHP 2,320.00 (−USD 40.00)')
  })
})
