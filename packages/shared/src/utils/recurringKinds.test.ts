import { describe, it, expect } from 'vitest'
import type { BudgetEntry, FullBudgetEntry, LimitedBudgetEntry, RecordPermissions, RecurringKind } from '../index'
import { KIND_LABELS, KIND_ORDER, billingKindChoices, groupByKind } from './recurringKinds'

const perms: RecordPermissions = { can_edit: true, can_delete: true, can_post: true, can_revert: true, can_tag: true }

function full(id: number, kind: RecurringKind | null): FullBudgetEntry {
  return {
    view: 'full',
    id,
    entry_type: kind === null ? 'income' : 'expense',
    name: `Entry ${id}`,
    amount: 100,
    currency: 'PHP',
    cadence: 'monthly',
    next_occurrence: '2026-10-20T00:00:00Z',
    lead_time_days: 0,
    end_mode: 'indefinite',
    is_autopay: false,
    is_active: true,
    kind,
    tags: [],
    created_at: '2026-01-01T00:00:00Z',
    permissions: perms,
    created_by: null,
  }
}

function limited(id: number): LimitedBudgetEntry {
  return {
    view: 'limited',
    id,
    permissions: perms,
    created_by: null,
    display_name: null,
    amount: 1,
    currency: 'PHP',
    entry_type: 'expense',
    cadence: 'monthly',
    next_occurrence: '2026-10-20T00:00:00Z',
    end_date: null,
    category_name: null,
    account: null,
    counterpart: null,
    tags: [],
  }
}

describe('groupByKind', () => {
  it('orders sections as subscriptions, installments, cash, bills, other, shared', () => {
    const entries: BudgetEntry[] = [
      limited(1),
      full(2, null),
      full(3, 'bill'),
      full(4, 'cash'),
      full(5, 'installment'),
      full(6, 'subscription'),
    ]
    expect(groupByKind(entries).map((g) => g.key)).toEqual(['subscription', 'installment', 'cash', 'bill', 'other', 'shared'])
    expect(groupByKind(entries).map((g) => g.label)).toEqual([
      'Subscriptions',
      'Card installments',
      'Cash expenses',
      'Card-billed bills',
      'Income & transfers',
      'Shared with you',
    ])
  })

  it('sends limited entries to shared and kindless entries to other', () => {
    const groups = groupByKind<BudgetEntry>([limited(1), full(2, null)])
    expect(groups.find((g) => g.key === 'shared')?.entries.map((e) => e.id)).toEqual([1])
    expect(groups.find((g) => g.key === 'other')?.entries.map((e) => e.id)).toEqual([2])
  })

  it('drops empty groups and keeps order within one', () => {
    const groups = groupByKind([full(1, 'cash'), full(2, 'cash')])
    expect(groups).toHaveLength(1)
    expect(groups[0]?.entries.map((e) => e.id)).toEqual([1, 2])
  })

  it('returns nothing for no entries', () => {
    expect(groupByKind([])).toEqual([])
  })

  it('has a label for every group in KIND_ORDER', () => {
    for (const key of KIND_ORDER) expect(KIND_LABELS[key]).toBeTruthy()
  })
})

describe('billingKindChoices', () => {
  it('offers Automatic, Subscription and Bill when open-ended', () => {
    const choices = billingKindChoices(false)
    expect(choices.map((c) => c.id)).toEqual(['automatic', 'subscription', 'bill'])
    expect(choices.map((c) => c.billingKind)).toEqual([undefined, 'subscription', 'bill'])
  })

  it('offers Installment (clears the override) and Bill when capped', () => {
    const choices = billingKindChoices(true)
    expect(choices.map((c) => c.id)).toEqual(['installment', 'bill'])
    expect(choices.map((c) => c.billingKind)).toEqual([null, 'bill'])
  })
})
