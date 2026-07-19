import type { CurrencyCode } from '../utils/currency'

// ─── Account ────────────────────────────────────────────────────────────────

export type AccountType = 'cash' | 'e_wallet' | 'savings' | 'checking' | 'credit'

export interface Account {
  id: number
  name: string
  account_type: AccountType
  balance: number
  currency: CurrencyCode
  description?: string
  credit_limit?: number
  /** Day of month the payment is due. Legacy: prefer billing_cycle_start. */
  due_date?: number
  /** Day of month the statement closes. */
  billing_cycle_start?: number
  /** Days from statement close to payment due. Defaults to 21. */
  days_until_due_date?: number
  /** Credit cards: account the statement payment is funded from. */
  payment_account_id?: number | null
  /** Credit cards: account the statement payment spills to when the primary can't cover it. */
  payment_overflow_account_id?: number | null
  entity_id: number
  is_active: boolean
  created_at: string
  updated_at?: string
}

// ─── Category ───────────────────────────────────────────────────────────────

export type CategoryKind = 'income' | 'expense' | 'transfer'

export interface Category {
  id: number
  name: string
  description?: string
  color?: string
  is_expense: boolean
  /**
   * Directional role. `transfer` marks movements of the user's own money
   * (savings/investment contributions, card payments) — net-worth-neutral,
   * unlike true income/expense.
   */
  kind: CategoryKind
  is_active: boolean
  entity_id: number
  created_at: string
  updated_at?: string
}

// ─── Allocation ─────────────────────────────────────────────────────────────

export type AllocationType = 'savings' | 'budget' | 'goal'
export type BudgetPeriodFrequency = 'daily' | 'weekly' | 'monthly' | 'quarterly'

export interface Allocation {
  id: number
  account_id: number
  entity_id: number
  name: string
  allocation_type: AllocationType
  description?: string
  target_amount?: number
  current_amount: number
  monthly_target?: number
  target_date?: string
  period_frequency?: BudgetPeriodFrequency
  period_start?: string
  period_end?: string
  currency: CurrencyCode
  is_active: boolean
  created_at: string
  updated_at?: string
  configuration?: Record<string, unknown>
}

// ─── Budget Entry ────────────────────────────────────────────────────────────

export type BudgetEntryType = 'income' | 'expense'
export type RecurrenceFrequency =
  | 'daily'
  | 'weekly'
  | 'biweekly'
  | 'semi_monthly'
  | 'monthly'
  | 'quarterly'
  | 'semi_annual'
  | 'annual'
export type EndMode = 'indefinite' | 'on_date' | 'after_occurrences'

export interface BudgetEntry {
  id: number
  user_id: number
  entity_id: number
  entry_type: BudgetEntryType
  name: string
  description?: string
  amount: number
  currency: CurrencyCode
  cadence: RecurrenceFrequency
  next_occurrence: string
  lead_time_days: number
  /** Only meaningful when cadence === 'semi_monthly' (defaults 1 & 15). */
  semi_monthly_day_1?: number
  semi_monthly_day_2?: number
  end_mode: EndMode
  end_date?: string
  /** Installments: the "m" in "n of m". */
  max_occurrences?: number
  /**
   * Installments: the "n" in "n of m" — occurrences materialised so far, counted
   * from linked transactions. `null` for open-ended entries. Payments entered by
   * hand rather than via "Mark paid" aren't linked, so they don't count.
   */
  occurrences_paid?: number | null
  account_id?: number
  /** UC1: secondary funding source — payments draw from account_id first, overflow here. */
  overflow_account_id?: number
  category_id?: number
  allocation_id?: number
  is_autopay: boolean
  is_active: boolean
  created_at: string
  updated_at?: string
}

// ─── Transaction ─────────────────────────────────────────────────────────────

export type TransactionType = 'debit' | 'credit' | 'transfer'

export interface Transaction {
  id: number
  account_id: number
  entity_id: number
  category_id?: number
  allocation_id?: number
  budget_entry_id?: number
  amount: number
  currency: CurrencyCode
  projected_amount?: number
  projected_currency?: CurrencyCode
  original_amount?: number
  original_currency?: CurrencyCode
  exchange_rate?: number
  description?: string
  transaction_type: TransactionType
  transaction_date: string
  posting_date?: string
  receipt_url?: string
  invoice_url?: string
  is_posted: boolean
  is_reconciled: boolean
  is_recurring: boolean
  recurrence_frequency?: RecurrenceFrequency
  transfer_fee: number
  transfer_from_account_id?: number
  transfer_to_account_id?: number
  created_at: string
  updated_at?: string
}

// ─── Entity ──────────────────────────────────────────────────────────────────

export type EntityType = 'personal' | 'business'
export type EntityMembershipRole = 'owner' | 'member'

export interface Entity {
  id: number
  name: string
  entity_type: EntityType
  description?: string
  default_currency?: string
  is_active: boolean
  created_at: string
  updated_at?: string
}

export interface EntityMembership {
  id: number
  entity_id: number
  user_id: number
  role: EntityMembershipRole
  created_at: string
  updated_at?: string
}

export interface EntityWithMembers extends Entity {
  members: EntityMembership[]
}

// ─── Wishlist ────────────────────────────────────────────────────────────────

export type WishlistItemPriority = 'low' | 'medium' | 'high' | 'critical'

export interface WishlistItem {
  id: number
  user_id: number
  entity_id?: number
  name: string
  estimated_cost: number
  currency: CurrencyCode
  priority: WishlistItemPriority
  category_id?: number
  url?: string
  notes?: string
  target_date?: string
  is_purchased: boolean
  purchased_at?: string
  created_at: string
  updated_at?: string
}

export interface WishlistReadiness {
  item_id: number
  name: string
  estimated_cost: number
  monthly_disposable: number
  savings_rate: number
  months_needed: number
  estimated_purchase_date: string
  affordable_now: boolean
}

export interface WishlistPlanItem {
  item_id: number
  name: string
  estimated_cost: number
  estimated_purchase_date: string
  cumulative_months: number
}

export interface WishlistPlan {
  monthly_disposable: number
  savings_rate: number
  items: WishlistPlanItem[]
}

// ─── Shared Response Wrappers ─────────────────────────────────────────────────

export interface PaginatedResponse<T> {
  items: T[]
  total: number
  has_more: boolean
}

export interface AccountBalance {
  account_id: number
  current_balance: number
  calculated_balance: number
  balance_history: Array<{
    date: string
    balance: number
    transaction_id: number
  }>
}

export interface AllocationProgress {
  allocation_id: number
  current_amount: number
  target_amount?: number
  progress_percentage: number
  monthly_target?: number
  monthly_progress: number
  remaining_amount: number
  target_date?: string
  days_remaining?: number
}

export interface GoalsSummary {
  total_goals: number
  total_target_amount: number
  total_current_amount: number
  total_progress_percentage: number
  goals: Array<{
    id: number
    name: string
    target_amount?: number
    current_amount: number
    progress_percentage: number
    target_date?: string
  }>
}

export interface TransactionSummary {
  period: {
    start_date: string
    end_date: string
  }
  summary: {
    total_income: number
    total_expenses: number
    net_flow: number
    transaction_count: number
  }
  category_breakdown: Record<string, { income: number; expenses: number }>
}

// ─── Forecast ────────────────────────────────────────────────────────────────

export interface MonthlySummary {
  month: string
  income: number
  expenses: number
  net_flow: number
}

export interface CashFlowProjection {
  projection_start: string
  projection_end: string
  monthly_summary: MonthlySummary[]
}

export interface UpcomingBill {
  type: string
  name: string
  date: string
  amount: number
  currency: CurrencyCode
  entry_type: BudgetEntryType
  lead_time_days: number
  is_autopay: boolean
}

export interface NetDisposableIncome {
  period_start: string
  period_end: string
  total_income: number
  total_expenses: number
  net_disposable_income: number
  currency?: CurrencyCode
}

// ─── Cash-flow timeline (pre-due-date solvency) ───────────────────────────────

export interface CashflowTimelineEvent {
  date: string
  name: string
  /** Signed: positive = inflow, negative = outflow. */
  amount: number
  type: string
  /**
   * Where the event came from. `statement` is a credit card's derived payable for
   * one billing cycle — its `source_id` is the CARD's account id, not a transaction.
   */
  source: 'budget_entry' | 'transaction' | 'statement'
  source_id: number | null
  running_balance: number
}

export interface CashflowShortfall {
  date: string
  name: string
  balance_after: number
}

export interface AccountShortfall {
  date: string
  name: string
  account_id: number
  account_name: string | null
  /** How much the funding account is still short after overflow. */
  short_amount: number
  overflow_used: number
}

export interface CashflowTimeline {
  window_start: string
  window_end: string
  opening_balance: number
  lowest_balance: number
  /** null => the opening balance is the lowest point in the window. */
  trough_date: string | null
  closing_balance: number
  shortfall: boolean
  shortfalls: CashflowShortfall[]
  account_shortfalls: AccountShortfall[]
  events: CashflowTimelineEvent[]
}

// ─── Dashboard ───────────────────────────────────────────────────────────────

export interface DashboardSnapshot {
  account_balances: Array<{
    id: number
    name: string
    type: AccountType
    balance: number
    currency: CurrencyCode
  }>
  total_balance: number
  allocations_summary: Array<{
    id: number
    name: string
    type: AllocationType
    current_amount: number
    target_amount?: number
    currency: CurrencyCode
    progress_percent: number
    target_date?: string
  }>
  recent_transactions: Array<{
    id: number
    description?: string
    amount: number
    currency: CurrencyCode
    type: TransactionType
    date: string
    account_name?: string
    category_name?: string
  }>
  upcoming_events: UpcomingBill[]
  cash_flow_forecast: CashFlowProjection
  net_disposable_income: NetDisposableIncome
  wishlist_summary: Array<{
    id: number
    name: string
    estimated_cost: number
    currency: CurrencyCode
    priority: WishlistItemPriority
    target_date?: string
    is_ready: boolean
    readiness_reason: string
  }>
}
