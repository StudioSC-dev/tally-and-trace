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
  due_date?: number
  billing_cycle_start?: number
  days_until_due_date?: number
  entity_id: number
  is_active: boolean
  created_at: string
  updated_at?: string
}

// ─── Category ───────────────────────────────────────────────────────────────

export interface Category {
  id: number
  name: string
  description?: string
  color?: string
  is_expense: boolean
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
export type RecurrenceFrequency = 'daily' | 'weekly' | 'monthly' | 'quarterly' | 'semi_annual' | 'annual'
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
  end_mode: EndMode
  end_date?: string
  max_occurrences?: number
  account_id?: number
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

export type EntityType = 'household' | 'business' | 'personal'
export type EntityMembershipRole = 'owner' | 'admin' | 'member'

export interface Entity {
  id: number
  name: string
  entity_type: EntityType
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
  entity_id: number
  name: string
  description?: string
  estimated_cost: number
  currency: CurrencyCode
  priority: WishlistItemPriority
  target_date?: string
  is_achieved: boolean
  created_at: string
  updated_at?: string
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
