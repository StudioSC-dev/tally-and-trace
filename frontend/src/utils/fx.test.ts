import { describe, expect, it } from 'vitest'
import { formatCurrency } from './currency'
import { estimateText } from './fx'
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
