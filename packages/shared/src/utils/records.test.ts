import { describe, it, expect } from 'vitest'
import type { BudgetEntry, FullTransaction, LimitedTransaction, RecordPermissions, SharedFullTransaction } from '../index'
import { isDetailed, isLimited, isLimitedEvent, isOwnerFull, isSharedFull } from '../index'
import { entryName, transactionDate, transactionDescription } from './records'

const none: RecordPermissions = { can_edit: false, can_delete: false, can_post: false, can_revert: false, can_tag: false }

const full: FullTransaction = {
  view: 'full',
  id: 1,
  account_id: 10,
  category_id: 5,
  amount: 100,
  currency: 'PHP',
  description: 'Groceries',
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

const sharedFull: SharedFullTransaction = {
  ...(({ category_id: _c, ...rest }) => rest)(full),
  view: 'shared_full',
  category_name: 'Food',
}

const limited: LimitedTransaction = {
  view: 'limited',
  id: 2,
  permissions: none,
  created_by: 'Demo P.',
  date: '2026-10-02T00:00:00',
  display_description: 'Expense',
  amount: 50,
  transfer_fee: null,
  currency: 'PHP',
  transaction_type: 'debit',
  is_posted: true,
  category_name: null,
  account: { id: null, name: 'Other account' },
  counterpart: null,
  tags: [],
}

describe('view guards', () => {
  it('tell the three shapes apart', () => {
    expect(isOwnerFull(full)).toBe(true)
    expect(isSharedFull(sharedFull)).toBe(true)
    expect(isLimited(limited)).toBe(true)
    expect(isLimited(full)).toBe(false)
    expect(isDetailed(full)).toBe(true)
    expect(isDetailed(sharedFull)).toBe(true)
    expect(isDetailed(limited)).toBe(false)
  })

  it('narrow the union so Full-only fields are readable', () => {
    const rows = [full, sharedFull, limited]
    const ids = rows.filter(isOwnerFull).map((t) => t.category_id)
    expect(ids).toEqual([5])
  })
})

describe('record readers', () => {
  it('read the date and description from any shape', () => {
    expect(transactionDate(full)).toBe('2026-10-01T00:00:00')
    expect(transactionDate(limited)).toBe('2026-10-02T00:00:00')
    expect(transactionDescription(full)).toBe('Groceries')
    expect(transactionDescription(limited)).toBe('Expense')
  })

  it('give null for a missing description', () => {
    expect(transactionDescription({ ...full, description: undefined })).toBeNull()
  })

  it('read the entry name from Full and Limited entries', () => {
    const entry = {
      view: 'limited', id: 3, permissions: none, created_by: null, display_name: 'Expense', amount: 1,
      currency: 'PHP', entry_type: 'expense', cadence: 'monthly', next_occurrence: '2026-11-01T00:00:00',
      end_date: null, category_name: null, account: null, counterpart: null, tags: [],
    } satisfies BudgetEntry
    expect(entryName(entry)).toBe('Expense')
  })
})

describe('isLimitedEvent', () => {
  it('is true only for events with view "limited"', () => {
    expect(isLimitedEvent({ view: 'limited' as const })).toBe(true)
    expect(isLimitedEvent({ view: undefined })).toBe(false)
  })
})
