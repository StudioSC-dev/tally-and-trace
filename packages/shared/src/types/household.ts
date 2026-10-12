import type { CurrencyCode } from '../utils/currency'
import type { Account, PaginatedResponse, Transaction, UpcomingItemOrEvent } from './api'

// ─── Household views ─────────────────────────────────────────────────────────
// A Household view shows one sharer's Household-tagged accounts and records, read-only.
// There are no allocations or budget categories in it. Amounts are never added across
// currencies: every total is one line per currency.

/** GET /household/: a view the caller can open. The caller's own comes first (`is_self`). */
export interface HouseholdView {
  sharer_id: number
  sharer_name: string
  is_self: boolean
}

export interface HouseholdSharer {
  id: number
  name: string
}

/** One currency's totals for one month. Only non-zero currencies are listed. */
export interface HouseholdMonthCurrency {
  currency: CurrencyCode
  income: number
  expense: number
  fees: number
  /** Transfers into the view's accounts from outside it. */
  moved_in: number
  /** Transfers out of the view's accounts to outside it. */
  moved_out: number
  /** What the view's accounts did not pay of Household bills that sit on other accounts. */
  paid_from_other_accounts: number
}

/** `recorded`: posted transactions. `current` and `projected`: the projection. */
export type HouseholdMonthKind = 'recorded' | 'current' | 'projected'

export interface HouseholdMonthRow {
  /** YYYY-MM. */
  month: string
  kind: HouseholdMonthKind
  currencies: HouseholdMonthCurrency[]
}

/** GET /household/{sharer_id}/dashboard. */
export interface HouseholdDashboard {
  sharer: HouseholdSharer
  /** The view's accounts, as GET /accounts/ lists them (a `tag_viewer` shows a few fields). */
  accounts: Account[]
  /** The current month. */
  month: HouseholdMonthRow
  /** The next 30 days. */
  upcoming: UpcomingItemOrEvent[]
}

/** GET /household/{sharer_id}/transactions. Every row carries its own permission flags. */
export type HouseholdTransactions = PaginatedResponse<Transaction>

/** GET /household/{sharer_id}/upcoming. */
export interface HouseholdUpcoming {
  sharer: HouseholdSharer
  items: UpcomingItemOrEvent[]
  days: number
}

/** GET /household/{sharer_id}/monthly (at most 36 months; a bad range is a 422). */
export interface HouseholdMonthly {
  sharer: HouseholdSharer
  /** YYYY-MM. */
  from: string
  /** YYYY-MM. */
  to: string
  months: HouseholdMonthRow[]
}
