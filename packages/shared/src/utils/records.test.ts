import { describe, it, expect } from 'vitest'
import type {
  BudgetEntry, FullTransaction, LimitedEvent, LimitedTransaction, RecordPermissions, SharedFullTransaction,
} from '../index'
import { isDetailed, isLimited, isLimitedEvent, isOwnerFull, isSharedFull } from '../index'
import type { Account, CashflowTimelineEvent, LimitedTimelineEvent, TimelineEventAccount } from '../index'
import {
  entryName, isPinnableAccount, timelineEventAccountLabel, timelineEventAmount, timelineEventName, transactionDate,
  transactionDescription, upcomingItemAmount,
} from './records'

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

describe('timeline event readers', () => {
  const fullEvent = {
    date: '2026-10-05', name: 'Rent', amount: -500, type: 'expense', source: 'budget_entry' as const,
    source_id: 7, running_balance: 100,
  }
  const limitedEvent = {
    view: 'limited' as const, public_id: 'e1', date: '2026-10-06', original_date: null, overdue: false,
    display_name: 'Loan payment', face_amount: 300, cash_delta: -300, currency: 'PHP' as const,
    account: { id: null, name: 'Other account' }, kind: 'loan_payment' as const, running_balance: 50,
  }

  it('read the name and cash effect from either shape', () => {
    expect(timelineEventName(fullEvent)).toBe('Rent')
    expect(timelineEventAmount(fullEvent)).toBe(-500)
    expect(timelineEventName(limitedEvent)).toBe('Loan payment')
    expect(timelineEventAmount(limitedEvent)).toBe(-300)
  })
})

describe('upcoming item amounts', () => {
  const limited: LimitedEvent = {
    view: 'limited', public_id: 'e1', date: '2026-10-20', original_date: null, overdue: false,
    display_name: 'Expense', face_amount: 300, cash_delta: 0, currency: 'PHP',
    account: { id: 5, name: 'Shared card' }, kind: 'expense',
  }

  it('lists a limited card charge billed later at its face amount, as money out', () => {
    expect(upcomingItemAmount(limited)).toEqual({ amount: 300, direction: 'out' })
  })

  it('reads income and transfers by their kind and cash side', () => {
    expect(upcomingItemAmount({ ...limited, kind: 'income' as const, cash_delta: 300 })).toEqual({ amount: 300, direction: 'in' })
    expect(upcomingItemAmount({ ...limited, kind: 'transfer' as const, cash_delta: 250 })).toEqual({ amount: 300, direction: 'in' })
    expect(upcomingItemAmount({ ...limited, kind: 'transfer' as const, cash_delta: -300 })).toEqual({ amount: 300, direction: 'out' })
    expect(upcomingItemAmount({ ...limited, kind: 'card_payment' as const, cash_delta: -300 })).toEqual({ amount: 300, direction: 'out' })
  })

  it('lists a Household occurrence at its face amount, not its zero cash effect, with no direction', () => {
    const occurrence: LimitedEvent = { ...limited, kind: 'household', face_amount: 1200, cash_delta: 0, account: { id: null, name: 'Card payment' } }
    expect(upcomingItemAmount(occurrence)).toEqual({ amount: 1200, direction: null })
  })

  it('keeps a full item as before', () => {
    const full = { name: 'Rent', amount: 500, due_date: '2026-11-01', entry_type: 'expense', source: 'budget_entry' as const, source_id: 7 }
    expect(upcomingItemAmount(full)).toEqual({ amount: 500, direction: 'out' })
    expect(upcomingItemAmount({ ...full, entry_type: 'income' })).toEqual({ amount: 500, direction: 'in' })
  })
})

describe('timelineEventAccountLabel', () => {
  const event: CashflowTimelineEvent = {
    date: '2026-11-05', name: 'Rent', amount: -500, type: 'expense', source: 'budget_entry',
    source_id: 7, running_balance: 100, currency: 'PHP',
  }
  const leg = (account_name: string | null, amount: number, currency: 'PHP' | 'USD' = 'PHP'): TimelineEventAccount => ({
    account_id: account_name === null ? null : 1, account_name, amount, currency,
  })
  const limited: LimitedTimelineEvent = {
    view: 'limited', public_id: 'e1', date: '2026-11-06', original_date: null, overdue: false,
    display_name: 'Loan payment', face_amount: 300, cash_delta: -300, currency: 'PHP',
    account: { id: 4, name: 'Joint account' }, kind: 'loan_payment', running_balance: 50,
  }

  it('names a limited event by its account, or a dash without one', () => {
    expect(timelineEventAccountLabel(limited)).toBe('Joint account')
    expect(timelineEventAccountLabel({ ...limited, account: null })).toBe('—')
  })

  it('shows a dash for a full event with no legs', () => {
    expect(timelineEventAccountLabel(event)).toBe('—')
    expect(timelineEventAccountLabel({ ...event, accounts: [] })).toBe('—')
  })

  it('names one leg, or Unassigned for an accountless one', () => {
    expect(timelineEventAccountLabel({ ...event, accounts: [leg('Checking', -500)] })).toBe('Checking')
    expect(timelineEventAccountLabel({ ...event, accounts: [leg(null, -500)] })).toBe('Unassigned')
  })

  it('reads a same-currency transfer as from → to, whatever the leg order', () => {
    const accounts = [leg('Savings', -2025), leg('Checking', 2000)]
    expect(timelineEventAccountLabel({ ...event, accounts })).toBe('Savings → Checking')
    expect(timelineEventAccountLabel({ ...event, accounts: [...accounts].reverse() })).toBe('Savings → Checking')
  })

  it('adds currency codes to a cross-currency transfer', () => {
    const accounts = [leg('PHP Checking', -5800, 'PHP'), leg('USD Savings', 100, 'USD')]
    expect(timelineEventAccountLabel({ ...event, accounts })).toBe('PHP Checking (PHP) → USD Savings (USD)')
  })

  it('joins legs of the same sign, or more than two, with commas', () => {
    expect(timelineEventAccountLabel({ ...event, accounts: [leg('A', -1), leg('B', -2)] })).toBe('A, B')
    expect(timelineEventAccountLabel({ ...event, accounts: [leg('A', -1), leg('B', 2), leg(null, 3)] }))
      .toBe('A, B, Unassigned')
    expect(timelineEventAccountLabel({ ...event, accounts: [leg('A', 0), leg('B', 2)] })).toBe('A, B')
  })
})

describe('isPinnableAccount', () => {
  const base: Pick<Account, 'account_type' | 'is_active' | 'is_spending_wallet' | 'my_role'> = {
    account_type: 'checking', is_active: true, is_spending_wallet: false, my_role: 'owner',
  }

  it('accepts an active cash account held directly', () => {
    expect(isPinnableAccount(base)).toBe(true)
    for (const my_role of ['admin', 'editor', 'viewer'] as const) {
      expect(isPinnableAccount({ ...base, my_role })).toBe(true)
    }
    for (const account_type of ['cash', 'e_wallet', 'savings'] as const) {
      expect(isPinnableAccount({ ...base, account_type })).toBe(true)
    }
    expect(isPinnableAccount({ account_type: 'savings', my_role: 'owner' })).toBe(true)
  })

  it('rejects a Household tag viewer, an inactive account, a card, a loan and a wallet', () => {
    expect(isPinnableAccount({ ...base, my_role: 'tag_viewer' })).toBe(false)
    expect(isPinnableAccount({ ...base, is_active: false })).toBe(false)
    expect(isPinnableAccount({ ...base, account_type: 'credit' })).toBe(false)
    expect(isPinnableAccount({ ...base, account_type: 'loan' })).toBe(false)
    expect(isPinnableAccount({ ...base, is_spending_wallet: true })).toBe(false)
  })
})
