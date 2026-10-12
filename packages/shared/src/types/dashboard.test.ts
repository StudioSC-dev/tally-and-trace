import { describe, it, expect } from 'vitest'
import type { DashboardSnapshot } from '../index'
import { isLimitedEvent } from '../index'

// A real GET /dashboard/snapshot body (a sharee of a joint account, from a local
// API), trimmed to one forecast period and with one goal and one wishlist item
// in the shape routers/dashboard.py builds them. `satisfies` makes the typecheck
// fail on any key the type lacks or misnames.
const snapshot = {
  balances: {
    total: 7000.0,
    by_account: [
      { id: 6, name: 'Joint Account', balance: 4000.0, currency: 'PHP', is_spending_wallet: false },
      { id: 7, name: 'Partner Checking', balance: 3000.0, currency: 'PHP', is_spending_wallet: false },
      // Seen through a Household tag share: no settings.
      { id: 8, name: 'Household Savings', balance: 0.0, currency: 'USD' },
    ],
  },
  upcoming_this_month: [
    {
      view: 'limited', public_id: 'e1', date: '2026-10-14', original_date: null, overdue: false,
      display_name: 'Transfer', face_amount: 300.0, cash_delta: -300.0, currency: 'PHP',
      account: { id: 6, name: 'Joint Account' }, kind: 'transfer',
    },
    { name: 'Rent', amount: 2500.0, due_date: '2026-11-01', entry_type: 'expense', source: 'budget_entry', source_id: 6 },
  ],
  monthly_summary: { monthly_income: 0.0, monthly_expenses: 2500.0, monthly_disposable: -2500.0 },
  forecast_next_3_months: [
    {
      period_label: 'October 2026', period_start: '2026-10-11T00:00:00', period_end: '2026-11-01T00:00:00',
      opening_balance: 7000.0, income: 0.0, expenses: 0.0, unposted_expenses: 300.0, statement_payables: 0.0,
      net: -300.0, closing_balance: 6700.0,
      by_account: [
        { account_id: 6, account_name: 'Joint Account', closing_balance: 3700.0 },
        { account_id: 7, account_name: 'Partner Checking', closing_balance: 3000.0 },
      ],
      unassigned_closing: 0.0,
      overflow_moves: [],
    },
  ],
  goals_progress: [
    { id: 3, name: 'Emergency fund', target_amount: 10000, current_amount: 2500, progress_pct: 25.0, remaining: 7500 },
  ],
  wishlist_next_up: [
    { id: 4, name: 'Sofa', cost: 15000, priority: 'high', affordable_by: '2027-03-01' },
  ],
  available_cash: 7000.0,
  account_closings: [
    {
      period_label: 'October 2026', period_start: '2026-10-11T00:00:00', period_end: '2026-11-01T00:00:00',
      by_account: [{ account_id: 6, account_name: 'Joint Account', closing_balance: 3700.0 }],
      unassigned_closing: 0.0,
      overflow_moves: [{
        date: '2026-10-20', name: 'Electric Bill', from_account_id: 7, from_account_name: 'Partner Checking',
        to_account_id: 6, to_account_name: 'Joint Account', amount: 200.0,
      }],
    },
  ],
  payables: [
    {
      due_date: '2026-11-01', name: 'Rent', amount: 2500.0, source: 'budget_entry', source_id: 6, account_id: 6,
      account_name: 'Joint Account', overflow_account_id: null, overflow_account_name: null,
    },
  ],
} satisfies DashboardSnapshot

describe('DashboardSnapshot', () => {
  it('has exactly the keys routers/dashboard.py returns', () => {
    expect(Object.keys(snapshot).sort()).toEqual([
      'account_closings', 'available_cash', 'balances', 'forecast_next_3_months', 'goals_progress',
      'monthly_summary', 'payables', 'upcoming_this_month', 'wishlist_next_up',
    ])
  })

  it('omits the spending-wallet setting on an account seen through a tag share', () => {
    const typed: DashboardSnapshot = snapshot
    expect(typed.balances.by_account.map((a) => a.is_spending_wallet)).toEqual([false, false, undefined])
  })

  it('narrows upcoming items into limited and full events', () => {
    const typed: DashboardSnapshot = snapshot
    const [limited, full] = typed.upcoming_this_month
    expect(limited && isLimitedEvent(limited) ? limited.cash_delta : null).toBe(-300)
    expect(full && !isLimitedEvent(full) ? full.due_date : null).toBe('2026-11-01')
  })
})
