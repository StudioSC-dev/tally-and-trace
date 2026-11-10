import { describe, it, expect } from 'vitest'
import type { FullBudgetEntry, LimitedBudgetEntry, RecordPermissions } from '../index'
import { matchesRecurringSearch, parseAllocationsTab } from './recurringSearch'

const perms: RecordPermissions = { can_edit: true, can_delete: true, can_post: true, can_revert: true, can_tag: true }

const full = (name: string, amount: number): FullBudgetEntry => ({
  view: 'full', id: 1, entry_type: 'expense', name, amount, currency: 'PHP', cadence: 'monthly',
  next_occurrence: '2026-10-20T00:00:00Z', lead_time_days: 0, end_mode: 'indefinite', is_active: true,
  permissions: perms, created_by: null, tags: [],
} as unknown as FullBudgetEntry)

describe('matchesRecurringSearch', () => {
  it('matches the entry name, case-insensitively', () => {
    expect(matchesRecurringSearch(full('Netflix', 549), 'NETFLIX')).toBe(true)
    expect(matchesRecurringSearch(full('Netflix', 549), 'flix')).toBe(true)
    expect(matchesRecurringSearch(full('Netflix', 549), 'spotify')).toBe(false)
  })
  it('matches the account and category names', () => {
    const names = { accountName: 'BDO Checking', categoryName: 'Entertainment' }
    expect(matchesRecurringSearch(full('Netflix', 549), 'bdo', names)).toBe(true)
    expect(matchesRecurringSearch(full('Netflix', 549), 'ENTERTAIN', names)).toBe(true)
    expect(matchesRecurringSearch(full('Netflix', 549), 'bdo')).toBe(false)
  })
  it('matches the amount text, plain, with decimals and grouped', () => {
    expect(matchesRecurringSearch(full('Rent', 15000), '15000')).toBe(true)
    expect(matchesRecurringSearch(full('Rent', 15000), '15,000')).toBe(true)
    expect(matchesRecurringSearch(full('Rent', 549.5), '549.50')).toBe(true)
    expect(matchesRecurringSearch(full('Rent', 549.5), '999')).toBe(false)
  })
  it('matches every entry on a blank query', () => {
    expect(matchesRecurringSearch(full('Rent', 1), '')).toBe(true)
    expect(matchesRecurringSearch(full('Rent', 1), '   ')).toBe(true)
  })
  it('matches a limited entry on its display name and shown names', () => {
    const limited = {
      view: 'limited', id: 2, permissions: perms, created_by: null, display_name: 'Their rent', amount: 9000,
      currency: 'PHP', entry_type: 'expense', cadence: 'monthly', next_occurrence: '2026-10-20T00:00:00Z',
      end_date: null, category_name: null, account: null, counterpart: null, tags: [],
    } as LimitedBudgetEntry
    expect(matchesRecurringSearch(limited, 'their')).toBe(true)
    expect(matchesRecurringSearch(limited, 'joint', { accountName: 'Their joint' })).toBe(true)
    expect(matchesRecurringSearch(limited, 'mine')).toBe(false)
  })
})

describe('parseAllocationsTab', () => {
  it('opens the recurring tab for recurring and the older subscriptions value', () => {
    expect(parseAllocationsTab('recurring')).toBe('subscriptions')
    expect(parseAllocationsTab('subscriptions')).toBe('subscriptions')
  })
  it('keeps the other tabs and drops anything else', () => {
    expect(parseAllocationsTab('budgets')).toBe('budgets')
    expect(parseAllocationsTab('savings')).toBe('savings')
    expect(parseAllocationsTab('wishlist')).toBe('wishlist')
    expect(parseAllocationsTab('nope')).toBeUndefined()
    expect(parseAllocationsTab(undefined)).toBeUndefined()
    expect(parseAllocationsTab(3)).toBeUndefined()
  })
})
