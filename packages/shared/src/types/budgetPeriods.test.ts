import { describe, expect, it } from 'vitest'
import type { Allocation, AllocationCarryOverInput, BudgetPeriod, BudgetTransaction, BudgetTransactionPage } from '../index'

// Bodies from a local API (STU-795): a PHP budget with carry on since January and a
// euro row January could not convert, read in February. Trimmed: nulls the older types
// model as absent are left out, the oldest window is shown without a limit, and the
// second row is shown as the limited variant a revoked share gives. `satisfies` makes
// the typecheck fail on any key the types lack or misname.
const budget = {
  id: 703, account_id: null, name: 'Groceries', allocation_type: 'budget',
  target_amount: 1000.0, current_amount: 40.0, currency: 'PHP',
  period_frequency: 'monthly', period_start: '2026-02-01T00:00:00',
  period_end: '2026-03-01T00:00:00', is_active: true,
  configuration: { account_ids: [982, 985], category_ids: [592] },
  current_amount_complete: true, current_amount_missing: [], current_amount_source: null, rank: null,
  carry_over_from: '2026-01-01T00:00:00', carry_in: 900.0, available: 1900.0, complete: true, missing: [],
  provisional: true, inherited_missing: ['EUR'],
  created_at: '2026-11-27T05:43:36.340722Z', updated_at: '2026-11-27T05:43:36.439495Z',
} satisfies Allocation

const periods = [
  {
    start: '2026-02-01T00:00:00Z', end: '2026-03-01T00:00:00Z', limit: 1000.0, carry_in: 900.0,
    available: 1900.0, spent: 40.0, remaining: 1860.0, complete: true, missing: [], provisional: true,
    inherited_missing: ['EUR'], estimated: false, before_created: true, is_current: true,
  },
  {
    start: '2026-01-01T00:00:00Z', end: '2026-02-01T00:00:00Z', limit: 1000.0, carry_in: 0.0,
    available: 1000.0, spent: 100.0, remaining: 900.0, complete: false, missing: ['EUR'],
    provisional: false, inherited_missing: [], estimated: false, before_created: true, is_current: false,
  },
  {
    start: '2025-12-01T00:00:00Z', end: '2026-01-01T00:00:00Z', limit: null, carry_in: 0.0,
    available: null, spent: 0.0, remaining: null, complete: true, missing: [], provisional: false,
    inherited_missing: [], estimated: true, before_created: true, is_current: false,
  },
] satisfies BudgetPeriod[]

const permissions = { can_edit: true, can_delete: true, can_post: false, can_revert: true, can_tag: true }

const page = {
  items: [
    {
      view: 'full', id: 24019, account_id: 985, category_id: 592, amount: 5.0, currency: 'EUR',
      transfer_fee: 0.0, received_amount: null, description: 'debit 5', transaction_type: 'debit',
      is_posted: true, transaction_date: '2026-01-04T00:00:00Z', is_reconciled: false, is_recurring: false,
      loan_payment_kind: null, tags: [], created_at: '2026-11-27T05:43:36.389020Z', permissions,
      created_by: 'Share P.', missing_rate: true,
    },
    {
      view: 'limited', id: 24018, permissions, created_by: 'Share P.', date: '2026-01-03T00:00:00Z',
      display_description: 'Expense', amount: 100.0, transfer_fee: null, currency: 'PHP',
      transaction_type: 'debit', is_posted: true, category_name: null,
      account: { id: null, name: 'Other account' }, counterpart: null, tags: [],
    },
  ],
  total: 2, has_more: false, currency_subtotals: { EUR: 5.0, PHP: 100.0 }, converted_total: 100.0,
} satisfies BudgetTransactionPage

const carry: AllocationCarryOverInput = { carry_over: true }

const missingRate = (row: BudgetTransaction): boolean | null => (row.view === 'full' ? row.missing_rate : null)

describe('budget envelope types (STU-795)', () => {
  it('reads the current window off a budget', () => {
    expect([budget.carry_in, budget.available, budget.provisional, budget.inherited_missing])
      .toEqual([900, 1900, true, ['EUR']])
    expect(carry.carry_over).toBe(true)
  })

  it('lists windows newest first, each start an explicit-offset instant', () => {
    const starts = periods.map((p) => Date.parse(p.start))
    expect(starts).toEqual([...starts].sort((a, b) => b - a))
    expect(periods.every((p) => /(Z|[+-]\d\d:\d\d)$/.test(p.start) && /(Z|[+-]\d\d:\d\d)$/.test(p.end))).toBe(true)
    expect(periods.filter((p) => p.is_current)).toHaveLength(1)
  })

  it('keeps missing_rate to full rows and the window total on the page', () => {
    expect(page.items.map(missingRate)).toEqual([true, null])
    expect(page.converted_total).toBe(periods[1].spent)
    const limited: BudgetTransaction = page.items[1]
    // @ts-expect-error a limited row has no missing_rate
    expect(limited.missing_rate).toBeUndefined()
  })
})
