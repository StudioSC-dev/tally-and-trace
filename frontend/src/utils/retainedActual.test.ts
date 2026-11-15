import { describe, expect, it } from 'vitest'
import { keepsRetainedActual } from './retainedActual'

// Every input true or differing, so the foreign unposted edit is the one case that keeps the actual.
const base = {
  editing: true,
  sameAccount: true,
  isPosted: false,
  transactionType: 'debit',
  accountCurrency: 'PHP',
  faceCurrency: 'USD',
}

describe('keepsRetainedActual', () => {
  it('not_editing', () => expect(keepsRetainedActual({ ...base, editing: false })).toBe(false))
  it('account_changed', () => expect(keepsRetainedActual({ ...base, sameAccount: false })).toBe(false))
  it('posted', () => expect(keepsRetainedActual({ ...base, isPosted: true })).toBe(false))
  it('transfer', () => expect(keepsRetainedActual({ ...base, transactionType: 'transfer' })).toBe(false))
  it('same_currency', () => expect(keepsRetainedActual({ ...base, faceCurrency: 'PHP' })).toBe(false))
  it('foreign_unposted_edit', () => expect(keepsRetainedActual(base)).toBe(true))
})
