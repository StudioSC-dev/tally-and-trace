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

/**
 * An account as the API returns it. One reached only through a Household tag share
 * (`my_role: 'tag_viewer'`) carries just `id`, `name`, `account_type`, `currency`,
 * `balance`, `owner_name`, `tags` and all-false `permissions`; `is_active`,
 * `is_spending_wallet` and `created_at` are absent on it, and its statements, loan
 * schedule, shares and settings answer 404.
 */
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
  is_spending_wallet?: boolean
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
  is_active?: boolean
  /** The caller's tags on the account. */
  tags: TagRef[]
  created_at?: string
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

/**
 * GET /accounts/{id}/loan-schedule for an owner, admin or editor. Loan terms are the
 * owner's and admins' only: for an editor, `amortization`, `annual_rate`,
 * `payment_amount`, `term_months`, `first_payment_date` and `proposed_split` are null,
 * and so are each upcoming row's `principal`, `interest` and `balance_after`.
 */
export interface LoanSchedule {
  view: 'full'
  account_id: number
  name: string
  loan_kind: LoanKind | null
  amortization: LoanAmortization | null
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

export interface StatementLine extends Partial<Estimate> {
  /** ISO datetime. */
  date: string
  display_description: string | null
  /** In the card's currency (signed: a credit is negative). Estimate labels appear when it was converted. */
  amount: number
  transaction_id: number
}

/**
 * A full-view statement line left out of the totals because no rate is stored for its
 * currency. `amount` is null; `original_amount` and `original_currency` are the line's own.
 */
export interface UnconvertedStatementLine {
  /** ISO datetime. */
  date: string
  amount: null
  unconverted: true
  original_amount: number
  original_currency: CurrencyCode
  display_description: string | null
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
  /** Lines left out of the totals (no stored rate); always present, usually empty. */
  unconverted_lines: UnconvertedStatementLine[]
  /** Present (true) only when a line was left out, so the totals are incomplete. */
  incomplete?: true
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
  /** Present (true) only when a line was left out; carries no currency or figure. */
  incomplete?: true
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
/** A month-family entry's day rule: the last Monday-Friday of each month. */
export type DayRule = 'last_weekday'

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
  /**
   * Month-family entries (monthly, quarterly, semi-annual, annual): the intended
   * day of the month, 1-31, clamped to short months but never drifting. Used
   * when `day_rule` is null. Both null is the legacy schedule, which steps from
   * the current day.
   */
  anchor_day?: number | null
  /** Month-family entries: a day rule instead of `anchor_day` (never both). */
  day_rule?: DayRule | null
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
  /**
   * Transfers: what the destination received, in its own currency. Null (or absent)
   * means the same as `amount`; required to post a transfer between currencies.
   * Not on `LimitedTransaction`.
   */
  received_amount?: number | null
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
  /** An uploaded receipt is `/api/v1/transactions/{id}/receipt`, fetched with the bearer token. */
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

/** POST /budget-entries/{id}/materialize. */
export interface BudgetEntryMaterializeInput {
  /** Defaults to the entry's `next_occurrence`. */
  transaction_date?: string
  /**
   * What was charged, in the account's currency. Required when the entry's currency
   * differs from its account's.
   */
  amount?: number
  /** Advance `next_occurrence` to the following one. Defaults to true. */
  advance?: boolean
  /** Transfer entries only: the fee charged on the source. */
  transfer_fee?: number
  /**
   * Transfer entries only: what the destination received, in its own currency.
   * Required when the destination's currency differs from the source's.
   */
  received_amount?: number
}

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
  /** The bounds that were sent; null on a side the request left open. */
  period: {
    start_date: string | null
    end_date: string | null
  }
  summary: {
    total_income: number
    total_expenses: number
    net_flow: number
    transaction_count: number
  }
  category_breakdown: Record<string, { income: number; expenses: number }>
  /**
   * The `summary` and `category_breakdown` above are the default currency only
   * (`summary.transaction_count` stays the total). One row per currency, default first.
   */
  by_currency: TransactionSummaryCurrencyRow[]
}

/** One currency's row of GET /transactions/summary/period; a row counts in its account's currency. */
export interface TransactionSummaryCurrencyRow {
  currency: CurrencyCode
  total_income: number
  total_expenses: number
  /** Cross-currency transfers between cash accounts: neither income nor expense. */
  moved_in: number
  moved_out: number
  /** `total_income - total_expenses + moved_in - moved_out`. */
  net_flow: number
  transaction_count: number
  category_breakdown: Record<string, { income: number; expenses: number }>
}

// ─── Forecast ────────────────────────────────────────────────────────────────

/*
 * Every projection is split by account currency (STU-236). On each response the bare
 * scalars (`total`, `monthly_income`, a period's `income` and `closing_balance`, a
 * timeline's `closing_balance`, `available_cash`, ...) mean the user's DEFAULT
 * currency only, and `by_currency` carries one row per currency, default first. Never
 * add a scalar to a figure in another currency. `currencies` lists the currencies to
 * offer (select `currencies[0]`); `fx` describes the rates the full rows used.
 */

/**
 * The labels on a full row whose figure was converted into the row's currency at a
 * stored rate (`estimated`), or could not be (`unconverted`, no stored rate). They
 * are absent from a row that needed no conversion, and from every Limited row.
 */
export interface Estimate {
  /** The figure is an estimate at `rate`, not an actual charge. */
  estimated: true
  /** Instead of `estimated`: no rate is stored, so the row's `amount` is null or left out of totals. */
  unconverted: true
  /**
   * The row's own figure, in `original_currency`. `original_amount`, `original_currency`
   * and `rate` are absent on a statement estimated from more than one currency.
   */
  original_amount?: number
  original_currency?: CurrencyCode
  /** Units of the row's `currency` per unit of `original_currency`. */
  rate?: number
  /** ISO date the rate is for. */
  rate_as_of: string
  /** The stored rate is more than 24 hours old. */
  rate_stale: boolean
}

/** One pair in `fx.rates`: only pairs used by full rows. */
export interface FxRate {
  base: CurrencyCode
  quote: CurrencyCode
  /** Units of `quote` per unit of `base`. */
  rate: number
  /** ISO date. */
  as_of: string
  /** The rate provider, e.g. `currency-api`; show it as the attribution. */
  source: string
  stale: boolean
}

/** `fx` on a projection response. */
export interface FxMeta {
  rates: FxRate[]
  /** Full rows with no stored rate; they are listed but moved no cash. */
  unconverted_count: number
}

/** The keys every projection response adds next to its scalars. */
export interface ProjectionMeta {
  /** Viewable accounts' currencies plus those of full rows; no placeholder. Select `[0]`. */
  currencies: CurrencyCode[]
  fx: FxMeta
}

export interface MonthlySummary {
  month: string
  income: number
  expenses: number
  net_flow: number
}

/** GET /forecast/cashflow. Each period's scalars are the default currency only. */
export interface CashflowResponse extends ProjectionMeta {
  periods: ForecastPeriod[]
  months: number
}

export interface CashFlowProjection {
  projection_start: string
  projection_end: string
  monthly_summary: MonthlySummary[]
}

/** A full upcoming item in the dashboard's older summary shape. */
export interface UpcomingBill {
  /** Absent on a full event; lets `isLimitedEvent` narrow the union. */
  view?: undefined
  type: string
  name: string
  date: string
  amount: number
  currency: CurrencyCode
  entry_type: BudgetEntryType
  lead_time_days: number
  is_autopay: boolean
}

/**
 * What a limited event is, without naming its (possibly hidden) source. `household` is
 * the sharer's Household-tagged bill on an account outside the Household view: it has
 * `cash_delta` 0 (it moves none of the viewer's cash), so list its `face_amount`, and
 * it does not say whether it is money in or out.
 */
export type LimitedEventKind = 'expense' | 'income' | 'transfer' | 'loan_payment' | 'card_payment' | 'household'

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
export interface UpcomingItem extends Partial<Estimate> {
  view?: undefined
  name: string
  /** In `currency`. Null only when `unconverted` (no stored rate). */
  amount: number | null
  due_date: string
  entry_type: string
  source: 'budget_entry' | 'transaction' | 'statement' | 'loan'
  source_id: number | null
  /**
   * Present (true) on the caller's own Household occurrence in their own Household
   * view: a Household-tagged bill on an account outside the view. `amount` is what
   * is still unpaid by the view's accounts.
   */
  household_occurrence?: true
  /**
   * The currency of `amount`: the item's cash leg, or its in-scope account. A
   * cross-currency event is one item per currency. Present on every full item.
   */
  currency?: CurrencyCode
}

/** GET /forecast/upcoming. No `by_currency`: the list has no totals. */
export interface UpcomingResponse extends ProjectionMeta {
  items: UpcomingItemOrEvent[]
  days: number
}

export type UpcomingItemOrEvent = UpcomingItem | LimitedEvent

/** A payable (cash outflow) as GET /forecast/payables and the dashboard list it; a full one has no `view` key. */
export interface Payable extends Partial<Estimate> {
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
  /** The currency of `amount`. */
  currency?: CurrencyCode
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

/** One currency's row of GET /forecast/disposable and the snapshot's `monthly_summary`. */
export interface MonthlyDisposableCurrencyRow {
  currency: CurrencyCode
  monthly_income: number
  monthly_expenses: number
  /** Money moved across currencies between cash accounts: neither income nor expense. */
  moved_in: number
  moved_out: number
  /** `monthly_income - monthly_expenses + moved_in - moved_out`. */
  monthly_disposable: number
}

/** GET /forecast/disposable: the scalars are the default currency only. */
export interface DisposableResponse extends MonthlyDisposable, ProjectionMeta {
  by_currency: MonthlyDisposableCurrencyRow[]
}

// ─── Cash-flow timeline (pre-due-date solvency) ───────────────────────────────

export interface CashflowTimelineEvent extends Partial<Estimate> {
  /** A full event has no `view` key; a limited one is a `LimitedTimelineEvent`. */
  view?: undefined
  /** The currency of `amount` and `running_balance`: the currency row the event sits in. */
  currency?: CurrencyCode
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
  /** Present on `by_currency` rows and on the default-currency scalars. */
  currency?: CurrencyCode
}

export interface AccountShortfall {
  currency?: CurrencyCode
  date: string
  name: string
  account_id: number
  account_name: string | null
  /** How much the funding account is still short after overflow. */
  short_amount: number
  overflow_used: number
}

/** What one currency's timeline holds (and, for the default currency, the response's scalars). */
export interface CashflowTimelineBody {
  opening_balance: number
  lowest_balance: number
  /** null => the opening balance is the lowest point in the window. */
  trough_date: string | null
  closing_balance: number
  shortfall: boolean
  shortfalls: CashflowShortfall[]
  account_shortfalls: AccountShortfall[]
  /** Each projection-cash account's opening and closing balance over the window. */
  by_account: TimelineAccountBalance[]
  unassigned_closing: number
  overflow_moves: OverflowMove[]
  events: Array<CashflowTimelineEvent | LimitedTimelineEvent>
}

/** One account's opening and closing balance over a timeline window. */
export interface TimelineAccountBalance {
  account_id: number
  account_name: string | null
  opening_balance: number
  closing_balance: number
  currency?: CurrencyCode
}

/** One currency's timeline: every figure and event is in `currency`. */
export interface CashflowTimelineCurrencyRow extends CashflowTimelineBody {
  currency: CurrencyCode
}

/**
 * GET /forecast/timeline. The scalars (balances, shortfalls, events) are the default
 * currency's timeline only; `by_currency` has one row per currency, default first.
 */
export interface CashflowTimeline extends CashflowTimelineBody, ProjectionMeta {
  window_start: string
  window_end: string
  by_currency: CashflowTimelineCurrencyRow[]
}

// ─── Dashboard ───────────────────────────────────────────────────────────────

/** One account in the dashboard's balances: every active account the caller can view. */
export interface DashboardAccountBalance {
  id: number
  name: string
  balance: number
  currency: CurrencyCode
  /**
   * Shown, but not counted in available cash or projections. Absent on an account
   * seen only through a Household tag share (`tag_viewer`), which shows no settings.
   */
  is_spending_wallet?: boolean
}

/** A virtual pull from an overflow account to cover a shortfall on its primary. */
export interface OverflowMove {
  date: string
  name: string
  from_account_id: number
  from_account_name: string | null
  to_account_id: number
  to_account_name: string | null
  amount: number
  /** On `by_currency` rows; both accounts are in this currency. */
  currency?: CurrencyCode
}

/** One projection-cash account's closing balance at the end of a forecast period. */
export interface AccountClosing {
  account_id: number
  account_name: string | null
  closing_balance: number
  /** On `by_currency` rows. */
  currency?: CurrencyCode
}

/** One period of the month-by-month cash-flow projection. */
export interface ForecastPeriod {
  period_label: string
  period_start: string
  period_end: string
  opening_balance: number
  income: number
  expenses: number
  unposted_expenses: number
  statement_payables: number
  net: number
  closing_balance: number
  by_account: AccountClosing[]
  unassigned_closing: number
  overflow_moves: OverflowMove[]
  /** The scalars above are the default currency only; one row per currency, default first. */
  by_currency: ForecastPeriodCurrencyRow[]
}

/**
 * One currency's figures for a forecast period. `net` is `income - expenses -
 * unposted_expenses - statement_payables + moved_in - moved_out + loan_payables`,
 * where `loan_payables` is the signed (zero or negative) sum of loan payments.
 */
export interface ForecastPeriodCurrencyRow extends Omit<ForecastPeriod, 'period_label' | 'period_start' | 'period_end' | 'by_currency'> {
  currency: CurrencyCode
  /** Money moved across currencies between cash accounts: neither income nor expense. */
  moved_in: number
  moved_out: number
  loan_payables: number
}

/** Monthly income and expenses, normalised from each recurring entry's cadence. */
export interface MonthlyDisposable {
  monthly_income: number
  monthly_expenses: number
  monthly_disposable: number
}

/** One currency's balances in the snapshot. */
export interface BalanceCurrencyRow {
  currency: CurrencyCode
  /** Every active account in `currency`, cards and loans included (owed is negative). */
  total: number
  /** Pooled projection cash in `currency`. */
  available_cash: number
}

/** One currency's closings in the snapshot's `account_closings`. */
export interface AccountClosingCurrencyRow {
  currency: CurrencyCode
  by_account: AccountClosing[]
  unassigned_closing: number
  overflow_moves: OverflowMove[]
}

/** GET /dashboard/snapshot, exactly as the backend returns it. */
export interface DashboardSnapshot {
  balances: {
    /** The default currency's total only; see `by_currency`. */
    total: number
    by_account: DashboardAccountBalance[]
    by_currency: BalanceCurrencyRow[]
  }
  /** Everything due in the next 30 days; limited events have `view: 'limited'`. */
  upcoming_this_month: UpcomingItemOrEvent[]
  monthly_summary: MonthlyDisposable & { by_currency: MonthlyDisposableCurrencyRow[] }
  forecast_next_3_months: ForecastPeriod[]
  goals_progress: Array<{
    id: number
    name: string
    target_amount: number | null
    current_amount: number
    progress_pct: number
    remaining: number
  }>
  /** The top three unpurchased wishlist items, with when they could be afforded. */
  wishlist_next_up: Array<{
    id: number
    name: string
    cost: number
    priority: WishlistItemPriority
    affordable_by: string
  }>
  /** Pooled projection cash (card balances are owed, not held). */
  /** The default currency's pooled projection cash; see `balances.by_currency`. */
  available_cash: number
  account_closings: Array<Pick<ForecastPeriod,
    'period_label' | 'period_start' | 'period_end' | 'by_account' | 'unassigned_closing'
    | 'overflow_moves'> & { by_currency: AccountClosingCurrencyRow[] }>
  /** Cash outflows due in the next 30 days; limited events have `view: 'limited'`. */
  payables: PayableOrEvent[]
  currencies: CurrencyCode[]
  fx: FxMeta
}
