import { describe, it, expect } from 'vitest'
import type { BudgetEntry, FullBudgetEntry, LimitedBudgetEntry, RecordPermissions, SharedFullBudgetEntry } from '../index'
import {
  DEFAULT_RECURRING_VIEW, clampRecurringPage, dueIndicator, entryAccountIds, filterRecurringEntries,
  hasRecurringFilter, recurringAccountOptions, recurringPageSlice, sortRecurringEntries, viewRecurringEntries,
} from './recurringList'

const perms: RecordPermissions = { can_edit: true, can_delete: true, can_post: true, can_revert: true, can_tag: true }

function full(id: number, over: Partial<FullBudgetEntry> = {}): FullBudgetEntry {
  return {
    view: 'full',
    id,
    entry_type: 'expense',
    name: `Entry ${id}`,
    amount: 100,
    currency: 'PHP',
    cadence: 'monthly',
    next_occurrence: '2026-10-20T00:00:00',
    lead_time_days: 0,
    end_mode: 'indefinite',
    is_active: true,
    kind: 'subscription',
    tags: [],
    created_at: '2026-01-01T00:00:00Z',
    permissions: perms,
    created_by: null,
    ...over,
  }
}

function limited(id: number, over: Partial<LimitedBudgetEntry> = {}): LimitedBudgetEntry {
  return {
    view: 'limited',
    id,
    permissions: perms,
    created_by: null,
    display_name: `Shared ${id}`,
    amount: 50,
    currency: 'PHP',
    entry_type: 'expense',
    cadence: 'monthly',
    next_occurrence: '2026-10-20T00:00:00',
    end_date: null,
    category_name: null,
    account: null,
    counterpart: null,
    tags: [],
    ...over,
  }
}

const ids = (entries: readonly BudgetEntry[]) => entries.map((e) => e.id)

describe('sorts and filters recurring entries through recurringList', () => {
  const rent = full(1, { name: 'Rent', amount: 900, next_occurrence: '2026-10-25T00:00:00', account_id: 10 })
  const gym = full(2, { name: 'gym', amount: 40, next_occurrence: '2026-10-05T00:00:00', account_id: 11, is_active: false })
  const cloud = full(3, { name: 'Cloud', amount: 40, next_occurrence: '2026-10-05T00:00:00', account_id: 10 })
  const move = full(4, { name: 'Move', amount: 300, next_occurrence: '2026-11-01T00:00:00', account_id: 10, transfer_to_account_id: 12, entry_type: 'expense' })
  const shared = limited(5, { display_name: 'Aircon', amount: 70, next_occurrence: '2026-10-10T00:00:00', account: { id: 11, name: 'Joint' }, counterpart: { id: null, name: 'Card payment' } })
  const all = [rent, gym, cloud, move, shared]

  it('sorts by due date, amount and name in either direction, ties by id', () => {
    expect(ids(sortRecurringEntries(all, 'due', 'asc'))).toEqual([2, 3, 5, 1, 4])
    expect(ids(sortRecurringEntries(all, 'due', 'desc'))).toEqual([4, 1, 5, 2, 3])
    expect(ids(sortRecurringEntries(all, 'amount', 'asc'))).toEqual([2, 3, 5, 4, 1])
    expect(ids(sortRecurringEntries(all, 'amount', 'desc'))).toEqual([1, 4, 5, 2, 3])
    expect(ids(sortRecurringEntries(all, 'name', 'asc'))).toEqual([5, 3, 2, 4, 1])
    expect(ids(sortRecurringEntries(all, 'name', 'desc'))).toEqual([1, 4, 2, 3, 5])
  })

  it('does not change the list it is given', () => {
    const copy = [...all]
    sortRecurringEntries(all, 'name', 'desc')
    expect(all).toEqual(copy)
  })

  it('filters by status, and a limited entry shows only under all', () => {
    expect(ids(filterRecurringEntries(all, { status: 'all', accountId: null }))).toEqual([1, 2, 3, 4, 5])
    expect(ids(filterRecurringEntries(all, { status: 'active', accountId: null }))).toEqual([1, 3, 4])
    expect(ids(filterRecurringEntries(all, { status: 'paused', accountId: null }))).toEqual([2])
  })

  it('filters by account, a transfer matching on either end and a limited entry on its refs', () => {
    expect(ids(filterRecurringEntries(all, { status: 'all', accountId: 12 }))).toEqual([4])
    expect(ids(filterRecurringEntries(all, { status: 'all', accountId: 10 }))).toEqual([1, 3, 4])
    expect(ids(filterRecurringEntries(all, { status: 'all', accountId: 11 }))).toEqual([2, 5])
    expect(ids(filterRecurringEntries(all, { status: 'active', accountId: 11 }))).toEqual([])
  })

  it('lists the exposed accounts once, by name', () => {
    expect(entryAccountIds(move)).toEqual([10, 12])
    expect(entryAccountIds(shared)).toEqual([11])
    expect(entryAccountIds(full(9))).toEqual([])
    const names = new Map([[10, 'Payroll'], [12, 'Savings']])
    expect(recurringAccountOptions(all, names)).toEqual([
      { id: 11, name: 'Joint' },
      { id: 10, name: 'Payroll' },
      { id: 12, name: 'Savings' },
    ])
    expect(recurringAccountOptions([gym])).toEqual([{ id: 11, name: 'Account 11' }])
  })

  it('views filter then sort', () => {
    expect(ids(viewRecurringEntries(all, { ...DEFAULT_RECURRING_VIEW, status: 'active', sort: 'amount', direction: 'desc' }))).toEqual([1, 4, 3])
    expect(hasRecurringFilter(DEFAULT_RECURRING_VIEW)).toBe(false)
    expect(hasRecurringFilter({ status: 'paused', accountId: null })).toBe(true)
    expect(hasRecurringFilter({ status: 'all', accountId: 3 })).toBe(true)
  })

  it('clamps a page to the last that exists and slices five at a time', () => {
    expect(clampRecurringPage(3, 11)).toBe(3)
    expect(clampRecurringPage(4, 11)).toBe(3)
    expect(clampRecurringPage(2, 10)).toBe(2)
    expect(clampRecurringPage(3, 10)).toBe(2)
    expect(clampRecurringPage(5, 0)).toBe(1)
    expect(clampRecurringPage(0, 7)).toBe(1)
    const twelve = Array.from({ length: 12 }, (_, i) => i + 1)
    expect(recurringPageSlice(twelve, 1)).toEqual([1, 2, 3, 4, 5])
    expect(recurringPageSlice(twelve, 3)).toEqual([11, 12])
    expect(recurringPageSlice(twelve, 9)).toEqual([11, 12])
  })

  it('offers and matches an account used only as an overflow source', () => {
    const topUp = full(6, { name: 'Top-up', account_id: 10, overflow_account_id: 13 })
    expect(entryAccountIds(topUp)).toEqual([10, 13])
    expect(recurringAccountOptions([topUp], new Map([[10, 'Main'], [13, 'Reserve']]))).toEqual([
      { id: 10, name: 'Main' },
      { id: 13, name: 'Reserve' },
    ])
    expect(ids(filterRecurringEntries([rent, topUp], { status: 'all', accountId: 13 }))).toEqual([6])
    expect(ids(filterRecurringEntries([rent, topUp], { status: 'all', accountId: 10 }))).toEqual([1, 6])
  })

  it('orders stored wall times by their own parts, whatever the browser zone', () => {
    // 02:30 and 03:00 on the spring-forward day in Los Angeles (02:30 does not exist there locally).
    const early = full(7, { next_occurrence: '2026-03-08T02:30:00Z' })
    const late = full(8, { next_occurrence: '2026-03-08T03:00:00Z' })
    const naive = full(9, { next_occurrence: '2026-03-08T02:45:00' })
    expect(ids(sortRecurringEntries([late, naive, early], 'due', 'asc'))).toEqual([7, 9, 8])
    expect(ids(sortRecurringEntries([early, late], 'due', 'desc'))).toEqual([8, 7])
  })
})

describe('dueIndicator', () => {
  const today = new Date(2026, 9, 20, 15, 30)
  const due = (day: number, over: Partial<FullBudgetEntry> = {}) =>
    dueIndicator(full(1, { next_occurrence: `2026-10-${String(day).padStart(2, '0')}T00:00:00`, ...over }), today)

  it('marks overdue, today, and the next seven days, and nothing beyond', () => {
    expect(due(19)).toEqual({ kind: 'overdue', days: 1 })
    expect(due(1)).toEqual({ kind: 'overdue', days: 19 })
    expect(due(20)).toEqual({ kind: 'today' })
    expect(due(21)).toEqual({ kind: 'soon', days: 1 })
    expect(due(27)).toEqual({ kind: 'soon', days: 7 })
    expect(due(28)).toBeNull()
  })

  it('reads a UTC-suffixed stored date by its own calendar day, in any browser zone', () => {
    expect(dueIndicator(full(1, { next_occurrence: '2026-10-20T00:00:00Z' }), today)).toEqual({ kind: 'today' })
    expect(dueIndicator(full(1, { next_occurrence: '2026-10-19T23:30:00Z' }), today)).toEqual({ kind: 'overdue', days: 1 })
    expect(dueIndicator(full(1, { next_occurrence: '2026-10-21T00:00:00Z' }), today)).toEqual({ kind: 'soon', days: 1 })
  })

  it('is for active full entries only, and not a fully paid one', () => {
    expect(due(19, { is_active: false })).toBeNull()
    expect(due(19, { end_mode: 'after_occurrences', max_occurrences: 0 })).toBeNull()
    expect(due(19, { end_mode: 'after_occurrences', max_occurrences: 2 })).toEqual({ kind: 'overdue', days: 1 })
    expect(dueIndicator(limited(2, { next_occurrence: '2026-10-19T00:00:00' }), today)).toBeNull()
    const sharedFull: SharedFullBudgetEntry = { ...full(3), view: 'shared_full', category_name: null }
    expect(dueIndicator({ ...sharedFull, next_occurrence: '2026-10-22T00:00:00' }, today)).toEqual({ kind: 'soon', days: 2 })
  })
})
