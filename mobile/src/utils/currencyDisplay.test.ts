import { describe, expect, it } from 'vitest'
import { formatCurrency } from '@tally-trace/shared'
import type { FxMeta, UpcomingItem } from '@tally-trace/shared'
import { fullItemAmountLabel, isCrossCurrencyTransfer, ratesAttribution, totalsByCurrency } from './currencyDisplay'

// Characterization: these pin the current output of each helper branch.
const item = (extra: Record<string, unknown>) => ({ amount: 869.42, currency: 'PHP', ...extra }) as unknown as UpcomingItem

describe('totalsByCurrency', () => {
  it('totals_two_currencies_in_order', () => {
    const accounts = [
      { currency: 'PHP', balance: 100 },
      { currency: 'USD', balance: 5 },
      { currency: 'PHP', balance: 50 },
    ]
    expect(totalsByCurrency(accounts)).toEqual([
      { currency: 'PHP', total: 150 },
      { currency: 'USD', total: 5 },
    ])
  })

  it('totals_empty', () => expect(totalsByCurrency([])).toEqual([]))
})

describe('fullItemAmountLabel', () => {
  const none = { primary: null, original: null }
  it('label_unconverted', () => expect(fullItemAmountLabel(item({ unconverted: true }), 'PHP')).toEqual(none))
  it('label_null_amount', () => expect(fullItemAmountLabel(item({ amount: null }), 'PHP')).toEqual(none))

  it('label_estimated_with_original', () => {
    const it = item({ estimated: true, original_amount: 14.99, original_currency: 'USD' })
    expect(fullItemAmountLabel(it, 'PHP')).toEqual({ primary: '≈ PHP 869.42', original: '(USD 14.99)' })
  })

  it('label_estimated_without_original', () => {
    const it = item({ estimated: true, unconverted: false, original_amount: null })
    expect(fullItemAmountLabel(it, 'PHP')).toEqual({ primary: '≈ PHP 869.42', original: null })
  })

  it('label_plain', () => {
    expect(fullItemAmountLabel(item({}), 'PHP')).toEqual({ primary: formatCurrency(869.42, 'PHP'), original: null })
  })
})

describe('ratesAttribution', () => {
  it('attribution_none', () => {
    expect(ratesAttribution(undefined)).toBeNull()
    expect(ratesAttribution({ rates: [] } as unknown as FxMeta)).toBeNull()
  })

  it('attribution_dedupes_sources', () => {
    const fx = { rates: [{ source: 'currency-api' }, { source: 'currency-api' }] } as unknown as FxMeta
    expect(ratesAttribution(fx)).toBe('Rates: currency-api')
  })
})

describe('isCrossCurrencyTransfer', () => {
  const accounts = [
    { id: 1, currency: 'PHP' },
    { id: 2, currency: 'USD' },
    { id: 3, currency: 'PHP' },
  ]
  const transfer = { transaction_type: 'transfer', account_id: 1 }

  it('cross_not_transfer', () => {
    expect(isCrossCurrencyTransfer({ transaction_type: 'debit', account_id: 1, transfer_to_account_id: 2 }, accounts)).toBe(false)
  })
  it('cross_both_found_differ', () => {
    expect(isCrossCurrencyTransfer({ ...transfer, transfer_to_account_id: 2 }, accounts)).toBe(true)
  })
  it('cross_both_found_same', () => {
    expect(isCrossCurrencyTransfer({ ...transfer, transfer_to_account_id: 3 }, accounts)).toBe(false)
  })
  it('cross_missing_destination_received', () => {
    expect(isCrossCurrencyTransfer({ ...transfer, transfer_to_account_id: 99, received_amount: 50 }, accounts)).toBe(true)
  })
  it('cross_missing_destination_no_received', () => {
    expect(isCrossCurrencyTransfer({ ...transfer, transfer_to_account_id: 99, received_amount: null }, accounts)).toBe(false)
  })
})
