import type {
  Account,
  Allocation,
  CashflowTimeline,
  DashboardSnapshot,
  PaginatedResponse,
  QuickBalances,
  Tag,
  TransactionSummary,
} from '@tally-trace/shared'
import { apiRoute } from './mockApi'
import type { ApiRoute } from './mockApi'

const emptyPage = <T>(): PaginatedResponse<T> => ({ items: [], total: 0, has_more: false })

const emptySnapshot: DashboardSnapshot = {
  balances: { total: 0, by_account: [], by_currency: [] },
  upcoming_this_month: [],
  monthly_summary: { monthly_income: 0, monthly_expenses: 0, monthly_disposable: 0, by_currency: [] },
  forecast_next_3_months: [],
  goals_progress: [],
  wishlist_next_up: [],
  available_cash: 0,
  account_closings: [],
  payables: [],
  card_charges: [],
  card_statements_due: [],
  missed: [],
  installment_review: [],
  installment_auto_post: [],
  autopay_due: [],
  auto_post_scheduled: true,
  currencies: [],
  fx: { rates: [], unconverted_count: 0 },
}

const emptyTimeline: CashflowTimeline = {
  window_start: '2026-01-01',
  window_end: '2026-01-31',
  opening_balance: 0,
  lowest_balance: 0,
  trough_date: null,
  closing_balance: 0,
  shortfall: false,
  shortfalls: [],
  account_shortfalls: [],
  by_account: [],
  unassigned_closing: 0,
  overflow_moves: [],
  events: [],
  by_currency: [],
  currencies: [],
  fx: { rates: [], unconverted_count: 0 },
}

const emptySummary: TransactionSummary = {
  period: { start_date: null, end_date: null },
  summary: { total_income: 0, total_expenses: 0, net_flow: 0, transaction_count: 0 },
  category_breakdown: {},
  by_currency: [],
  household_private: [],
}

const emptyQuickBalances: QuickBalances = { pinned: false, max_tiles: 4, tiles: [] }

/** The calls the signed-in landing page (`/`) makes on load, answered with empty typed data. */
export const landingStubs = (): ApiRoute[] => [
  apiRoute<PaginatedResponse<Account>>('GET', '/accounts/', emptyPage<Account>()),
  apiRoute<PaginatedResponse<Allocation>>('GET', '/allocations/', emptyPage<Allocation>()),
  apiRoute<{ items: Allocation[] }>('GET', '/allocations/ranked', { items: [] }),
  apiRoute<QuickBalances>('GET', '/dashboard/quick-balances', emptyQuickBalances),
  apiRoute<DashboardSnapshot>('GET', '/dashboard/snapshot', emptySnapshot),
  apiRoute<CashflowTimeline>('GET', '/forecast/timeline', emptyTimeline),
  apiRoute<Tag[]>('GET', '/tags/', []),
  apiRoute<TransactionSummary>('GET', '/transactions/summary/period', emptySummary),
]
