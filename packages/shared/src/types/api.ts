import type { CurrencyCode } from '../utils/currency'
import type { AccountPermissions, AccountRef, AccountRole, RecordPermissions } from './access'

// ─── Tag ─────────────────────────────────────────────────────────────────────

/** A tag as it appears on a record (`tags` in account, transaction and entry responses). */
export interface TagRef {
  id: number
  name: string
  /** `#RRGGBB`, or null when none is set. */
  color: string | null
  /** The Household tag: it can be recoloured but not renamed or deleted. */
  is_system: boolean
}

/** A tag as the tags endpoints return it. */
export interface Tag extends TagRef {
  created_at: string
}

/** POST /tags/. `name` is 1-50 characters, trimmed, unique per user ignoring case. */
export interface TagCreate {
  name: string
  /** `#RRGGBB`. */
  color?: string
}

/** PUT /tags/{id}. Omit a field to leave it unchanged. The system tag cannot be renamed. */
export interface TagUpdate {
  name?: string
  color?: string
}

/**
 * `tag_ids` on a create or update body. Create defaults to none. On update, omit it to
 * keep the record's tags, send a list to replace them, or `[]` to clear them (never
 * `null`). At most 50.
 */
export interface TagIdsInput {
  tag_ids?: number[]
}

// ─── Account ────────────────────────────────────────────────────────────────

export type AccountType = 'cash' | 'e_wallet' | 'savings' | 'checking' | 'credit' | 'loan'
export type LoanKind = 'personal' | 'auto' | 'home'
/** `fixed`: the bank's schedule. `reduce_term`: a prepayment shortens the term. */
export type LoanAmortization = 'fixed' | 'reduce_term'
export type LoanPaymentKind = 'scheduled' | 'prepayment'

export interface Account {
  id: number
  name: string
  account_type: AccountType
  balance: number
  currency: CurrencyCode
  /**
   * `description`, `credit_limit`, the routing ids and the loan terms below come back
   * null for an editor or viewer on a shared account. Hide them; don't show empty or zero.
   */
  description?: string | null
  credit_limit?: number | null
  /** Day of month the payment is due. Legacy: prefer billing_cycle_start. */
  due_date?: number
  /** Day of month the statement closes. */
  billing_cycle_start?: number
  /** Days from statement close to payment due. Defaults to 21. */
  days_until_due_date?: number
  /** Credit cards: account the statement payment is funded from. Loans: account payments are funded from. */
  payment_account_id?: number | null
  /** Credit cards: account the statement payment spills to when the primary can't cover it. */
  payment_overflow_account_id?: number | null
  /**
   * Spending wallet (cash on hand, e-wallet): the balance is shown but not counted
   * in available cash or projections. Topping it up is the expense.
   */
  is_spending_wallet: boolean
  /** Loans only (balance is negative while owed; owed = -balance). */
  loan_kind?: LoanKind | null
  /** Loans: nominal annual rate in percent (6.5 = 6.5%). */
  loan_annual_rate?: number | null
  loan_term_months?: number | null
  loan_payment_amount?: number | null
  /** Loans: ISO date (YYYY-MM-DD) of payment #1. */
  loan_first_payment_date?: string | null
  /** Loans: defaults to `reduce_term` for home loans, `fixed` otherwise. */
  loan_amortization?: LoanAmortization | null
  /**
   * Loans: scheduled payments made before the loan was tracked here. Later due dates
   * are settled by the posted `scheduled` payments' combined amount (principal +
   * interest), oldest first; legacy transfers (`loan_payment_kind` null) never count.
   * Lower it when a legacy transfer is moved out of the loan and back in (that stamps
   * it, so it is counted again).
   */
  loan_payments_made_offset?: number | null
  is_active: boolean
  /** The caller's tags on the account. */
  tags: TagRef[]
  created_at: string
  updated_at?: string
  /** The caller's role on the account. */
  my_role: AccountRole
  /** Who owns the account ("First L."). */
  owner_name: string | null
  permissions: AccountPermissions
}

/** POST /accounts/ and PUT /accounts/{id}. */
export type AccountInput = Partial<
  Omit<Account, 'id' | 'tags' | 'my_role' | 'owner_name' | 'permissions' | 'created_at' | 'updated_at'>
> &
  TagIdsInput

// ─── Loan payments and schedule ──────────────────────────────────────────────

/** POST /accounts/{id}/loan-payment. Money values have at most 2 decimals. */
export interface LoanPaymentRequest {
  /** Defaults to the loan's `payment_account_id`. */
  from_account_id?: number
  /** Total payment; with one of principal/interest the other is the difference. */
  amount?: number
  principal?: number
  interest?: number
  /** ISO datetime; defaults to now. */
  transaction_date?: string
  /** Defaults to true. */
  is_posted?: boolean
  description?: string
}

/** POST /accounts/{id}/loan-prepayment (extra principal; `reduce_term` loans only). */
export interface LoanPrepaymentRequest {
  from_account_id?: number
  amount: number
  transaction_date?: string
  is_posted?: boolean
  description?: string
}

export interface LoanScheduleSplit {
  principal: number
  interest: number
}

export interface LoanSchedulePayment {
  transaction_id: number
  /** ISO datetime. */
  date: string
  kind: LoanPaymentKind | null
  principal: number
  interest: number
}

export interface LoanScheduleRow {
  /** Payment number in the loan's term. */
  number: number
  /** ISO date. */
  due_date: string
  payment: number | null
  /** Null on a `fixed` loan: the bank's split is not known in advance. */
  principal: number | null
  interest: number | null
  balance_after: number | null
}

/** GET /accounts/{id}/loan-schedule for an owner, admin or editor. */
export interface LoanSchedule {
  view: 'full'
  account_id: number
  name: string
  loan_kind: LoanKind | null
  amortization: LoanAmortization
  /** What is still owed (= -balance, never below zero). */
  owed: number
  annual_rate: number | null
  payment_amount: number | null
  term_months: number | null
  first_payment_date: string | null
  payments_made: number
  payments_left: number | null
  next_due_date: string | null
  proposed_split: LoanScheduleSplit | null
  payments: LoanSchedulePayment[]
  upcoming: LoanScheduleRow[]
}

export interface LimitedLoanScheduleRow {
  /** ISO date: when the payment was made (`paid`) or falls due (`open`). */
  due_date: string
  /** Principal and interest together. */
  amount: number | null
  status: 'paid' | 'open'
}

/**
 * GET /accounts/{id}/loan-schedule for a viewer. No rate, term, amortisation, first
 * payment date, balance after, principal/interest split or row ids.
 */
export interface LimitedLoanSchedule {
  view: 'limited'
  name: string
  currency: CurrencyCode
  owed: number
  next_due_date: string | null
  payments_left: number | null
  rows: LimitedLoanScheduleRow[]
}

export type LoanScheduleResponse = LoanSchedule | LimitedLoanSchedule

// ─── Card statements ─────────────────────────────────────────────────────────

export type StatementStatus = 'paid' | 'overdue' | 'open'

export interface StatementLine {
  /** ISO datetime. */
  date: string
  display_description: string | null
  amount: number
  transaction_id: number
}

export interface Statement {
  close_date: string
  due_date: string
  amount_due: number
  currency: CurrencyCode
  status: StatementStatus
  /** The statement's total before payments. */
  statement_balance: number
  lines: StatementLine[]
}

/** GET /accounts/{id}/statements for an owner, admin or editor (credit accounts only). */
export interface CardStatements {
  view: 'full'
  account_id: number
  name: string
  currency: CurrencyCode
  statements: Statement[]
}

export interface LimitedStatementLine {
  date: string
  display_description: string | null
  amount: number
}

export interface LimitedStatement {
  close_date: string
  due_date: string
  amount_due: number
  currency: CurrencyCode
  status: StatementStatus
  lines: LimitedStatementLine[]
}

/** GET /accounts/{id}/statements for a viewer. */
export interface LimitedCardStatements {
  view: 'limited'
  name: string
  currency: CurrencyCode
  statements: LimitedStatement[]
}

export type CardStatementsResponse = CardStatements | LimitedCardStatements

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
  created_at: string
  updated_at?: string
}

// ─── Allocation ─────────────────────────────────────────────────────────────

export type AllocationType = 'savings' | 'budget' | 'goal'
export type BudgetPeriodFrequency = 'daily' | 'weekly' | 'monthly' | 'quarterly'

export interface Allocation {
  id: number
  account_id: number
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

/** The fields a recurring entry has in every shape except Limited. */
interface RecurringEntryDetail {
  id: number
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
  /** UC1: secondary funding source — payments draw from account_id first, overflow here. null clears it on edit. */
  overflow_account_id?: number | null
  /** Recurring transfer: occurrences move money from account_id to this non-credit account. */
  transfer_to_account_id?: number | null
  is_autopay: boolean
  is_active: boolean
  /** The caller's tags on the entry. */
  tags: TagRef[]
  created_at: string
  updated_at?: string
  permissions: RecordPermissions
  /** Who created the entry ("First L."). */
  created_by: string | null
}

/** `view` "full": the creator's own entry. */
export interface FullBudgetEntry extends RecurringEntryDetail {
  view: 'full'
  category_id?: number
  allocation_id?: number
}

/**
 * `view` "shared_full": an editor's or admin's view of someone else's entry. The
 * category and allocation stay the creator's, so only `category_name` (read-only) shows.
 */
export interface SharedFullBudgetEntry extends RecurringEntryDetail {
  view: 'shared_full'
  category_name: string | null
}

/** `view` "limited": the allowlist for everyone else. */
export interface LimitedBudgetEntry {
  view: 'limited'
  id: number
  permissions: RecordPermissions
  created_by: string | null
  display_name: string | null
  amount: number
  currency: CurrencyCode
  entry_type: BudgetEntryType
  cadence: RecurrenceFrequency
  next_occurrence: string
  end_date: string | null
  category_name: string | null
  account: AccountRef | null
  counterpart: AccountRef | null
  tags: TagRef[]
}

/** A recurring entry as the API returns it; narrow on `view` before reading a field Limited lacks. */
export type BudgetEntry = FullBudgetEntry | SharedFullBudgetEntry | LimitedBudgetEntry

/**
 * POST /budget-entries/ and PUT /budget-entries/{id}. A non-creator editing a
 * `shared_full` entry must not send `category_id` or `allocation_id`.
 */
export type BudgetEntryInput = Partial<
  Omit<
    FullBudgetEntry,
    'id' | 'view' | 'tags' | 'permissions' | 'created_by' | 'created_at' | 'updated_at' | 'occurrences_paid'
  >
> &
  TagIdsInput & {
    /** Installments paid before import with no linked transaction. */
    occurrences_paid_offset?: number
  }

// ─── Transaction ─────────────────────────────────────────────────────────────

export type TransactionType = 'debit' | 'credit' | 'transfer'

/** The fields a transaction has in every shape except Limited. */
interface TransactionDetail {
  id: number
  account_id: number
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
  is_posted: boolean
  is_reconciled: boolean
  is_recurring: boolean
  recurrence_frequency?: RecurrenceFrequency
  /** Loan payments: interest (the amount is principal). */
  transfer_fee: number
  transfer_from_account_id?: number
  transfer_to_account_id?: number
  /**
   * Set on every transfer into a loan recorded through the API (the loan payment and
   * prepayment endpoints, a generic create, a materialised recurring entry, an edit
   * that retargets a row into a loan, posting a legacy planned row). Null on other
   * transactions and on legacy transfers into a loan, which an otherwise unchanged
   * edit leaves null; a posted legacy transfer into a loan cannot be unposted.
   */
  loan_payment_kind?: LoanPaymentKind | null
  /** The caller's tags on the transaction. */
  tags: TagRef[]
  created_at: string
  updated_at?: string
  permissions: RecordPermissions
  /** Who created the transaction ("First L."). */
  created_by: string | null
}

/** `view` "full": the creator's own transaction. */
export interface FullTransaction extends TransactionDetail {
  view: 'full'
  category_id?: number
  allocation_id?: number
  budget_entry_id?: number
  receipt_url?: string
  invoice_url?: string
}

/**
 * `view` "shared_full": an editor's or admin's view of someone else's transaction.
 * Category, allocation, recurring-entry link and attachments stay the creator's, so
 * only `category_name` (read-only) shows and an edit must not send those fields.
 */
export interface SharedFullTransaction extends TransactionDetail {
  view: 'shared_full'
  category_name: string | null
}

/**
 * `view` "limited": the allowlist for everyone else. A payment into a loan or card the
 * caller can't view has a null `transfer_fee` and `amount` is the whole payment.
 */
export interface LimitedTransaction {
  view: 'limited'
  id: number
  permissions: RecordPermissions
  created_by: string | null
  /** ISO datetime. */
  date: string
  display_description: string | null
  amount: number
  transfer_fee: number | null
  currency: CurrencyCode
  transaction_type: TransactionType
  is_posted: boolean
  category_name: string | null
  account: AccountRef | null
  counterpart: AccountRef | null
  tags: TagRef[]
}

/** A transaction as the API returns it; narrow on `view` before reading a field Limited lacks. */
export type Transaction = FullTransaction | SharedFullTransaction | LimitedTransaction

/**
 * POST /transactions/ and PUT /transactions/{id}. A non-creator editing a
 * `shared_full` transaction must not send `category_id`, `allocation_id`,
 * `budget_entry_id`, `receipt_url` or `invoice_url`.
 */
export type TransactionInput = Partial<
  Omit<FullTransaction, 'id' | 'view' | 'tags' | 'permissions' | 'created_by' | 'created_at' | 'updated_at'>
> &
  TagIdsInput

// ─── Wishlist ────────────────────────────────────────────────────────────────

export type WishlistItemPriority = 'low' | 'medium' | 'high' | 'critical'

export interface WishlistItem {
  id: number
  user_id: number
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

/** A balance-history row the caller sees in full (`full` or `shared_full`). */
export interface DetailedBalanceHistoryEntry {
  view: 'full' | 'shared_full'
  date: string
  /** The row's signed effect on this account. */
  amount: number
  balance_after: number
  balance: number
  transaction_id: number
  display_description: string | null
}

/** A balance-history row for a record the caller sees Limited. */
export interface LimitedBalanceHistoryEntry {
  view: 'limited'
  date: string
  amount: number
  balance_after: number
  display_description: string | null
}

export type BalanceHistoryEntry = DetailedBalanceHistoryEntry | LimitedBalanceHistoryEntry

export interface AccountBalance {
  account_id: number
  current_balance: number
  calculated_balance: number
  balance_history: BalanceHistoryEntry[]
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

/** A full upcoming item in the dashboard's older summary shape. */
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

/** What a limited event is, without naming its (possibly hidden) source. */
export type LimitedEventKind = 'expense' | 'income' | 'transfer' | 'loan_payment' | 'card_payment'

/**
 * A projected event the caller sees Limited (upcoming, payables, timeline, dashboard).
 * Full events keep their old shape and have no `view` key, so narrow with
 * `isLimitedEvent`. `public_id` is opaque and only unique within one response.
 */
export interface LimitedEvent {
  view: 'limited'
  public_id: string
  /** ISO date. */
  date: string
  original_date: string | null
  overdue: boolean
  display_name: string
  face_amount: number
  /** Signed effect on the caller's cash. */
  cash_delta: number
  currency: CurrencyCode
  account: AccountRef | null
  kind: LimitedEventKind
}

/** A limited event on the timeline, with the running balance after it. */
export interface LimitedTimelineEvent extends LimitedEvent {
  running_balance: number
}

/** GET /forecast/upcoming: a full item has no `view` key. */
export interface UpcomingItem {
  view?: undefined
  name: string
  amount: number
  due_date: string
  entry_type: string
  source: 'budget_entry' | 'transaction' | 'statement' | 'loan'
  source_id: number | null
}

export type UpcomingItemOrEvent = UpcomingItem | LimitedEvent

/** A payable (cash outflow) as GET /forecast/payables and the dashboard list it; a full one has no `view` key. */
export interface Payable {
  view?: undefined
  due_date: string
  name: string
  amount: number
  source: 'budget_entry' | 'transaction' | 'statement' | 'loan'
  source_id: number | null
  account_id: number | null
  account_name: string | null
  overflow_account_id: number | null
  overflow_account_name: string | null
}

export type PayableOrEvent = Payable | LimitedEvent

/** Type guard for the forecast unions: a full event has no `view`. */
export function isLimitedEvent<T extends { view?: string }>(event: T): event is Extract<T, { view: 'limited' }> {
  return event.view === 'limited'
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
  /** A full event has no `view` key; a limited one is a `LimitedTimelineEvent`. */
  view?: undefined
  date: string
  name: string
  /** Signed: positive = inflow, negative = outflow. */
  amount: number
  type: string
  /**
   * Where the event came from. `statement` is a credit card's derived payable for
   * one billing cycle — its `source_id` is the CARD's account id, not a transaction.
   * `loan` is a loan's payable for one due date — its `source_id` is the LOAN's
   * account id, and the outflow sits on the loan's paying account. Any event paying
   * a loan the caller cannot access (`loan`, `transaction` or `budget_entry`) has a
   * null `source_id` and is a neutral "Loan payment".
   */
  source: 'budget_entry' | 'transaction' | 'statement' | 'loan'
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
  events: Array<CashflowTimelineEvent | LimitedTimelineEvent>
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
  upcoming_events: Array<UpcomingBill | LimitedEvent>
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
