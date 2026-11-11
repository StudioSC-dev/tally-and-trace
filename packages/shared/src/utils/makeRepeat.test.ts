import { describe, it, expect } from 'vitest'
import type { FullTransaction, LimitedTransaction, RecordPermissions, SharedFullTransaction } from '../index'
import { canMakeRepeat } from './makeRepeat'

const none: RecordPermissions = { can_edit: false, can_delete: false, can_post: false, can_revert: false, can_tag: false }

const full: FullTransaction = {
  view: 'full',
  id: 1,
  account_id: 10,
  category_id: 5,
  amount: 100,
  currency: 'PHP',
  description: 'Rent',
  transaction_type: 'debit',
  transaction_date: '2026-10-01T00:00:00',
  is_posted: true,
  is_reconciled: false,
  is_recurring: false,
  transfer_fee: 0,
  tags: [],
  created_at: '2026-10-01T00:00:00',
  permissions: { ...none, can_edit: true },
  created_by: 'Seth P.',
}

describe('canMakeRepeat', () => {
  it('offers it on the owner\'s own editable row', () => {
    expect(canMakeRepeat(full, 'debit')).toBe(true)
  })

  it('refuses a shared_full row, even for an editor', () => {
    const shared: SharedFullTransaction = {
      ...(({ category_id: _c, ...rest }) => rest)(full),
      view: 'shared_full',
      category_name: 'Rent',
    }
    expect(canMakeRepeat(shared, 'debit')).toBe(false)
  })

  it('refuses a limited row', () => {
    const limited: LimitedTransaction = {
      view: 'limited', id: 2, permissions: none, created_by: null, date: '2026-10-01T00:00:00',
      display_description: null, amount: 1, transfer_fee: null, currency: 'PHP', transaction_type: 'debit',
      is_posted: true, category_name: null, account: null, counterpart: null, tags: [],
    }
    expect(canMakeRepeat(limited, 'debit')).toBe(false)
  })

  it('refuses when the caller cannot edit (viewer)', () => {
    expect(canMakeRepeat({ ...full, permissions: none }, 'debit')).toBe(false)
  })

  it('refuses a stored transfer', () => {
    expect(canMakeRepeat({ ...full, transaction_type: 'transfer' }, 'transfer')).toBe(false)
    expect(canMakeRepeat({ ...full, transaction_type: 'transfer' }, 'debit')).toBe(false)
  })

  it('refuses a row already linked to a recurring entry', () => {
    expect(canMakeRepeat({ ...full, budget_entry_id: 7 }, 'debit')).toBe(false)
  })

  it('refuses when the form is switched to transfer', () => {
    expect(canMakeRepeat(full, 'transfer')).toBe(false)
  })
})
