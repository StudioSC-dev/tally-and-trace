import { describe, it, expect } from 'vitest'
import { transferAccountFields } from './transfer'

describe('transferAccountFields', () => {
  it('keeps the source and destination of a transfer', () => {
    expect(transferAccountFields('transfer', 1, 2)).toEqual({
      transfer_from_account_id: 1,
      transfer_to_account_id: 2,
    })
  })

  it.each(['debit', 'credit'])('sends both as explicit nulls for a %s, even with stale accounts', (type) => {
    const fields = transferAccountFields(type, 1, 2)
    expect(fields).toEqual({ transfer_from_account_id: null, transfer_to_account_id: null })
    expect(Object.keys(fields)).toEqual(['transfer_from_account_id', 'transfer_to_account_id'])
  })
})
