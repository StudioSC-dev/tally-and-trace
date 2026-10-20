import { describe, it, expect } from 'vitest'
import type {
  CardStatements, CashflowResponse, CashflowTimeline, DisposableResponse, LimitedCardStatements, TransactionSummary,
  UpcomingResponse,
} from '../index'
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
    by_currency: [
      { currency: 'PHP', total: 7000.0, available_cash: 7000.0 },
      { currency: 'USD', total: 0.0, available_cash: 0.0 },
    ],
  },
  upcoming_this_month: [
    {
      view: 'limited', public_id: 'e1', date: '2026-10-14', original_date: null, overdue: false,
      display_name: 'Transfer', face_amount: 300.0, cash_delta: -300.0, currency: 'PHP',
      account: { id: 6, name: 'Joint Account' }, kind: 'transfer',
    },
    {
      name: 'Rent', amount: 2500.0, due_date: '2026-11-01', entry_type: 'expense', source: 'budget_entry', source_id: 6,
      currency: 'PHP',
    },
    // A USD bill on the PHP account, estimated at the stored rate.
    {
      name: 'Hosting', amount: 580.0, due_date: '2026-11-03', entry_type: 'expense', source: 'budget_entry', source_id: 7,
      currency: 'PHP', estimated: true, original_amount: 10.0, original_currency: 'USD', rate: 58.0,
      rate_as_of: '2026-10-13', rate_stale: false,
    },
    // No stored rate for JPY: listed, but it moves no cash.
    {
      name: 'Tokyo hotel', amount: null, due_date: '2026-11-04', entry_type: 'expense', source: 'transaction', source_id: 9,
      currency: 'PHP', unconverted: true, original_amount: 20000.0, original_currency: 'JPY',
    },
  ],
  monthly_summary: {
    monthly_income: 0.0, monthly_expenses: 2500.0, monthly_disposable: -2500.0,
    by_currency: [
      { currency: 'PHP', monthly_income: 0.0, monthly_expenses: 2500.0, moved_in: 0.0, moved_out: 0.0, monthly_disposable: -2500.0 },
      { currency: 'USD', monthly_income: 0.0, monthly_expenses: 0.0, moved_in: 0.0, moved_out: 0.0, monthly_disposable: 0.0 },
    ],
  },
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
      by_currency: [
        {
          currency: 'PHP', opening_balance: 7000.0, income: 0.0, expenses: 0.0, unposted_expenses: 300.0,
          statement_payables: 0.0, moved_in: 0.0, moved_out: 0.0, loan_payables: 0.0, net: -300.0, closing_balance: 6700.0,
          by_account: [
            { account_id: 6, account_name: 'Joint Account', closing_balance: 3700.0, currency: 'PHP' },
            { account_id: 7, account_name: 'Partner Checking', closing_balance: 3000.0, currency: 'PHP' },
          ],
          unassigned_closing: 0.0,
          overflow_moves: [],
        },
        {
          currency: 'USD', opening_balance: 0.0, income: 0.0, expenses: 0.0, unposted_expenses: 0.0,
          statement_payables: 0.0, moved_in: 0.0, moved_out: 0.0, loan_payables: 0.0, net: 0.0, closing_balance: 0.0,
          by_account: [],
          unassigned_closing: 0.0,
          overflow_moves: [],
        },
      ],
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
      by_currency: [
        {
          currency: 'PHP',
          by_account: [{ account_id: 6, account_name: 'Joint Account', closing_balance: 3700.0, currency: 'PHP' }],
          unassigned_closing: 0.0,
          overflow_moves: [{
            date: '2026-10-20', name: 'Electric Bill', from_account_id: 7, from_account_name: 'Partner Checking',
            to_account_id: 6, to_account_name: 'Joint Account', amount: 200.0, currency: 'PHP',
          }],
        },
      ],
    },
  ],
  payables: [
    {
      due_date: '2026-11-01', name: 'Rent', amount: 2500.0, source: 'budget_entry', source_id: 6, account_id: 6,
      account_name: 'Joint Account', overflow_account_id: null, overflow_account_name: null, currency: 'PHP',
    },
  ],
  card_charges: [],
  missed: [],
  currencies: ['PHP', 'USD'],
  fx: {
    rates: [{ base: 'USD', quote: 'PHP', rate: 58.0, as_of: '2026-10-13', source: 'currency-api', stale: false }],
    unconverted_count: 1,
  },
} satisfies DashboardSnapshot

describe('DashboardSnapshot', () => {
  it('has exactly the keys routers/dashboard.py returns', () => {
    expect(Object.keys(snapshot).sort()).toEqual([
      'account_closings', 'available_cash', 'balances', 'card_charges', 'currencies', 'forecast_next_3_months', 'fx',
      'goals_progress', 'missed', 'monthly_summary', 'payables', 'upcoming_this_month', 'wishlist_next_up',
    ])
  })

  it('omits the spending-wallet setting on an account seen through a tag share', () => {
    const typed: DashboardSnapshot = snapshot
    expect(typed.balances.by_account.map((a) => a.is_spending_wallet)).toEqual([false, false, undefined])
  })

  it('splits balances, the monthly summary and each forecast period by currency, default first', () => {
    const typed: DashboardSnapshot = snapshot
    expect(typed.currencies).toEqual(['PHP', 'USD'])
    expect(typed.balances.by_currency.map((r) => r.currency)).toEqual(['PHP', 'USD'])
    expect(typed.monthly_summary.by_currency.map((r) => r.currency)).toEqual(['PHP', 'USD'])
    // The scalars are the default currency's row.
    expect(typed.balances.total).toBe(typed.balances.by_currency[0]?.total)
    expect(typed.forecast_next_3_months[0]?.closing_balance).toBe(typed.forecast_next_3_months[0]?.by_currency[0]?.closing_balance)
  })

  it('labels an estimated upcoming item and leaves an unconverted one without an amount', () => {
    const typed: DashboardSnapshot = snapshot
    const items = typed.upcoming_this_month.filter((i) => !isLimitedEvent(i))
    const estimated = items.find((i) => i.estimated)
    const unconverted = items.find((i) => i.unconverted)
    expect(estimated?.original_currency).toBe('USD')
    expect(unconverted?.amount).toBeNull()
    expect(typed.fx.unconverted_count).toBe(1)
  })

  it('narrows upcoming items into limited and full events', () => {
    const typed: DashboardSnapshot = snapshot
    const [limited, full] = typed.upcoming_this_month
    expect(limited && isLimitedEvent(limited) ? limited.cash_delta : null).toBe(-300)
    expect(full && !isLimitedEvent(full) ? full.due_date : null).toBe('2026-11-01')
  })
})

// The other projection endpoints, in the shapes routers/forecast.py and the statement and
// summary routers build. `satisfies` fails the typecheck on any key the type lacks.
const meta = {
  currencies: ['PHP', 'USD'],
  fx: { rates: [], unconverted_count: 0 },
} satisfies Pick<CashflowResponse, 'currencies' | 'fx'>

describe('per-currency projection responses', () => {
  it('types /forecast/upcoming with currencies and fx but no by_currency', () => {
    const body = {
      items: [{
        name: 'Rent', amount: 25000.0, due_date: '2026-11-05', entry_type: 'expense', source: 'budget_entry',
        source_id: 1, currency: 'PHP',
      }],
      days: 30,
      ...meta,
    } satisfies UpcomingResponse
    expect(Object.keys(body).sort()).toEqual(['currencies', 'days', 'fx', 'items'])
  })

  it('types /forecast/cashflow, /disposable and /timeline with a row per currency', () => {
    const cashflow = { periods: [], months: 6, ...meta } satisfies CashflowResponse
    const disposable = {
      monthly_income: 100.0, monthly_expenses: 40.0, monthly_disposable: 60.0,
      by_currency: [{ currency: 'PHP', monthly_income: 100.0, monthly_expenses: 40.0, moved_in: 0.0, moved_out: 0.0, monthly_disposable: 60.0 }],
      ...meta,
    } satisfies DisposableResponse
    const row = {
      opening_balance: 10.0, lowest_balance: 10.0, trough_date: null, closing_balance: 10.0, shortfall: false,
      shortfalls: [], account_shortfalls: [], by_account: [], unassigned_closing: 0.0, overflow_moves: [],
      events: [{ date: '2026-11-09', name: 'Rent', amount: -5.0, type: 'expense', source: 'budget_entry' as const, source_id: 1, event_id: 'e1', running_balance: 5.0, currency: 'PHP' as const }],
    }
    const timeline = {
      window_start: '2026-10-13', window_end: '2026-12-12', ...row,
      by_currency: [{ currency: 'PHP', ...row }],
      ...meta,
    } satisfies CashflowTimeline
    expect(cashflow.periods).toEqual([])
    expect(disposable.by_currency[0]?.currency).toBe('PHP')
    expect(timeline.by_currency[0]?.events[0]?.running_balance).toBe(5)
  })

  it('types the period summary and the full and limited statements', () => {
    const summary = {
      period: { start_date: '2026-10-01', end_date: '2026-10-31' },
      summary: { total_income: 10.0, total_expenses: 4.0, net_flow: 6.0, transaction_count: 3 },
      category_breakdown: { Food: { income: 0.0, expenses: 4.0 } },
      by_currency: [{
        currency: 'PHP', total_income: 10.0, total_expenses: 4.0, moved_in: 0.0, moved_out: 0.0, net_flow: 6.0,
        transaction_count: 3, category_breakdown: { Food: { income: 0.0, expenses: 4.0 } },
      }],
      household_private: [{
        currency: 'PHP', total_expenses: 55.55, transaction_count: 1, category_breakdown: { Utilities: 55.55 },
      }],
    } satisfies TransactionSummary
    const full = {
      view: 'full', account_id: 1, name: 'Card', currency: 'PHP',
      statements: [{
        close_date: '2026-10-15', due_date: '2026-11-05', amount_due: 100.0, currency: 'PHP', status: 'open',
        statement_balance: 100.0, lines: [], incomplete: true,
        unconverted_lines: [{
          date: '2026-10-02T00:00:00', amount: null, unconverted: true, original_amount: 20000.0,
          original_currency: 'JPY', display_description: 'Hotel', transaction_id: 4,
        }],
      }],
    } satisfies CardStatements
    const limited = {
      view: 'limited', name: 'Card', currency: 'PHP',
      statements: [{ close_date: '2026-10-15', due_date: '2026-11-05', amount_due: 100.0, currency: 'PHP', status: 'open', lines: [], incomplete: true }],
    } satisfies LimitedCardStatements
    expect(summary.by_currency).toHaveLength(1)
    expect(summary.household_private[0]?.category_breakdown.Utilities).toBe(55.55)
    expect(full.statements[0]?.incomplete).toBe(true)
    expect(Object.keys(limited.statements[0] ?? {})).toContain('incomplete')
  })
})
