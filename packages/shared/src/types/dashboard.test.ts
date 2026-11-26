import { describe, it, expect } from 'vitest'
import type {
  CardStatements, CashflowResponse, CashflowTimeline, DisposableResponse, LimitedCardStatements, TransactionSummary,
  UpcomingResponse,
} from '../index'
import type { DashboardSnapshot, WishlistOutlook, WishlistPlan, WishlistReadiness } from '../index'
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
    { id: 4, name: 'Sofa', cost: 15000, priority: 'high', affordable_by: '2027-03-01', note: null },
    {
      id: 5, name: 'Camera', cost: 900, priority: 'low', affordable_by: null,
      note: "No projected income or expenses in EUR, so this can't be judged yet.",
    },
    // STU-789: the projection status and note, as routers/dashboard.py builds them now.
    {
      id: 6, name: 'Bike', cost: 5000, priority: 'medium', affordable_by: null,
      note: 'Paid from a savings account, so it is not estimated',
      projection_status: 'paid_from_savings',
      projection_note: 'Paid from a savings account, so it is not estimated',
    },
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
  card_statements_due: [],
  missed: [],
  installment_review: [],
  installment_auto_post: [],
  autopay_due: [],
  auto_post_scheduled: false,
  currencies: ['PHP', 'USD'],
  fx: {
    rates: [{ base: 'USD', quote: 'PHP', rate: 58.0, as_of: '2026-10-13', source: 'currency-api', stale: false }],
    unconverted_count: 1,
  },
} satisfies DashboardSnapshot

describe('DashboardSnapshot', () => {
  it('has exactly the keys routers/dashboard.py returns', () => {
    expect(Object.keys(snapshot).sort()).toEqual([
      'account_closings', 'auto_post_scheduled', 'autopay_due', 'available_cash', 'balances', 'card_charges', 'card_statements_due',
      'currencies', 'forecast_next_3_months', 'fx', 'goals_progress', 'installment_auto_post', 'installment_review',
      'missed', 'monthly_summary', 'payables', 'upcoming_this_month', 'wishlist_next_up',
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

  it('keeps every wishlist next-up field, with the STU-789 fields optional', () => {
    const typed: DashboardSnapshot = snapshot
    const [dated, , paid] = typed.wishlist_next_up
    expect(Object.keys(paid ?? {}).sort()).toEqual([
      'affordable_by', 'cost', 'id', 'name', 'note', 'priority', 'projection_note', 'projection_status',
    ])
    expect(dated?.projection_status).toBeUndefined()
    expect(paid?.affordable_by).toBeNull()
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

// The wishlist responses (routers/wishlist.py) before and after STU-789. A body in the old
// shape still type-checks (every new field is optional); a body in the new shape keeps every
// old field with its type.
describe('wishlist responses on free flow (STU-789)', () => {
  it('types the plan in the old and the new shape', () => {
    const old = {
      monthly_disposable: 12000.0, savings_rate: 6000.0, installments: [],
      items: [{ item_id: 1, name: 'Sofa', estimated_cost: 15000, estimated_purchase_date: '2027-01-25', cumulative_months: 2, note: null }],
    } satisfies WishlistPlan
    const now = {
      monthly_disposable: 12000.0, savings_rate: 15000.0, installments: [],
      items: [
        {
          item_id: 2, name: 'Roof', estimated_cost: 50000, estimated_purchase_date: '2027-02-24', cumulative_months: 3,
          note: null, currency: 'PHP', priority: 'critical', basis: 'net_flow', projection_status: 'dated',
          projection_note: null, queue_note: null, net_flow_after: -30000.0, from_saving: 5000.0,
        },
        {
          item_id: 3, name: 'Lamp', estimated_cost: 15000, estimated_purchase_date: null, cumulative_months: 101,
          note: 'Waits behind an urgent need that has no date yet', currency: 'PHP', priority: 'high', basis: 'free_flow',
          projection_status: 'dated', projection_note: null, queue_note: 'Waits behind an urgent need that has no date yet',
          net_flow_after: null, from_saving: null,
        },
      ],
      net_flow: [{
        currency: 'PHP', status: 'ok', sample_months: 1, income: 30000.0, spending: 10000.0, debt_paid: 0.0,
        net_flow: 20000.0, saved: 5000.0, goal_top_up: 0.0, reserved: 5000.0, free_flow: 15000.0, shortfall: 0.0,
      }],
    } satisfies WishlistPlan
    expect(Object.keys(old).sort()).toEqual(['installments', 'items', 'monthly_disposable', 'savings_rate'])
    expect(Object.keys(now).sort()).toEqual(['installments', 'items', 'monthly_disposable', 'net_flow', 'savings_rate'])
    expect(now.items[1]?.estimated_purchase_date).toBeNull()
  })

  it('types readiness with the legacy fields kept and estimated_date added', () => {
    const old = {
      item_id: 1, name: 'Sofa', estimated_cost: 15000, currency: 'PHP', monthly_disposable: 12000.0,
      savings_rate: 6000.0, months_needed: 3, estimated_purchase_date: '2027-02-24', affordable_now: false, note: null,
    } satisfies WishlistReadiness
    const now = {
      ...old, savings_rate: 0.0, months_needed: 9999, estimated_purchase_date: '2054-04-12',
      note: 'Paid from a savings account, so it is not estimated', estimated_date: null, basis: 'free_flow',
      projection_status: 'paid_from_savings', projection_note: 'Paid from a savings account, so it is not estimated',
    } satisfies WishlistReadiness
    expect(typeof now.months_needed).toBe('number')
    expect(typeof now.estimated_purchase_date).toBe('string')
    expect(now.estimated_date).toBeNull()
  })

  it('types the outlook disposable check with basis and available', () => {
    const base = {
      item_id: 1, currency: 'PHP', payment_plan: 'full' as const, estimated_cost: 15000,
      months: [{ month: '2026-12', existing_installments: 0.0, this_item: 15000.0, total: 15000.0 }],
      note: null, credit_check: null,
    }
    const old = {
      ...base,
      disposable_check: { status: 'fits', currency: 'PHP', amount: 15000, monthly_disposable: 20000, after_purchase: 5000, reason: null },
    } satisfies WishlistOutlook
    const now = {
      ...base, projection_status: 'dated', projection_note: null,
      disposable_check: {
        status: 'fits', currency: 'PHP', amount: 15000, monthly_disposable: null, after_purchase: 0, reason: null,
        basis: 'free_flow', available: 15000,
      },
    } satisfies WishlistOutlook
    expect(old.disposable_check.status).toBe('fits')
    expect(now.disposable_check.available).toBe(15000)
  })
})
