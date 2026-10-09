import { createApi } from '@reduxjs/toolkit/query/react'
import { baseQueryWithReauth } from './baseQuery'

// ─── Re-export shared types so existing imports continue to work ──────────────
export type {
  CurrencyCode,
  Account,
  AccountType,
  Category,
  Allocation,
  AllocationType,
  BudgetPeriodFrequency,
  BudgetEntry,
  BudgetEntryType,
  RecurrenceFrequency,
  EndMode,
  Transaction,
  FullTransaction,
  SharedFullTransaction,
  LimitedTransaction,
  TransactionType,
  FullBudgetEntry,
  SharedFullBudgetEntry,
  LimitedBudgetEntry,
  RecordView,
  RecordPermissions,
  AccountRole,
  AccountPermissions,
  AccountRef,
  ShareRole,
  UserMatch,
  AccountShare,
  AccountShares,
  ReceivedShare,
  WishlistItem,
  WishlistItemPriority,
  PaginatedResponse,
  AccountBalance,
  AllocationProgress,
  GoalsSummary,
  TransactionSummary,
  MonthlySummary,
  CashFlowProjection,
  UpcomingBill,
  NetDisposableIncome,
  DashboardSnapshot,
  CashflowTimeline,
  CashflowTimelineEvent,
  CashflowShortfall,
  AccountShortfall,
  WishlistPlan,
  WishlistReadiness,
  WishlistPlanItem,
  LoanKind,
  LoanAmortization,
  LoanPaymentKind,
  LoanPaymentRequest,
  LoanPrepaymentRequest,
  LoanSchedule,
  LoanScheduleRow,
  LimitedLoanSchedule,
  LoanScheduleResponse,
  CardStatementsResponse,
  BalanceHistoryEntry,
  LimitedEvent,
  LimitedTimelineEvent,
  Tag,
  TagRef,
  TagCreate,
  TagUpdate,
  AccountInput,
  BudgetEntryInput,
  TransactionInput,
} from '@tally-trace/shared'

import type {
  Account,
  Category,
  Allocation,
  BudgetEntry,
  Transaction,
  PaginatedResponse,
  AccountBalance,
  AllocationProgress,
  GoalsSummary,
  TransactionSummary,
  CashflowTimeline,
  WishlistItem,
  WishlistPlan,
  LoanPaymentRequest,
  LoanPrepaymentRequest,
  LoanScheduleResponse,
  CardStatementsResponse,
  AccountShares,
  AccountShare,
  ReceivedShare,
  ShareCreate,
  ShareUpdate,
  UserMatch,
  Tag,
  TagCreate,
  TagUpdate,
  AccountInput,
  BudgetEntryInput,
  TransactionInput,
} from '@tally-trace/shared'

// ─── RTK Query API ────────────────────────────────────────────────────────────

export const accountingApi = createApi({
  reducerPath: 'accountingApi',
  baseQuery: baseQueryWithReauth,
  tagTypes: ['Account', 'Category', 'Transaction', 'Allocation', 'BudgetEntry', 'Wishlist', 'Tag', 'Share', 'ReceivedShare'],
  endpoints: (builder) => ({
    // ── Accounts ──────────────────────────────────────────────────────────────
    getAccounts: builder.query<PaginatedResponse<Account>, { account_type?: string; is_active?: boolean; tag?: number; limit?: number; offset?: number }>({
      query: (params) => ({ url: 'accounts/', params }),
      providesTags: ['Account'],
    }),
    getAccount: builder.query<Account, number>({
      query: (id) => `accounts/${id}`,
      providesTags: ['Account'],
    }),
    createAccount: builder.mutation<Account, AccountInput>({
      query: (account) => ({ url: 'accounts/', method: 'POST', body: account }),
      // An account's tags are effective tags on its transactions and entries.
      invalidatesTags: (_result, _error, account) =>
        account.tag_ids && account.tag_ids.length > 0 ? ['Account', 'Transaction', 'BudgetEntry'] : ['Account'],
    }),
    updateAccount: builder.mutation<Account, { id: number; data: AccountInput }>({
      query: ({ id, data }) => ({ url: `accounts/${id}`, method: 'PUT', body: data }),
      invalidatesTags: (_result, _error, { data }) =>
        data.tag_ids !== undefined ? ['Account', 'Transaction', 'BudgetEntry'] : ['Account'],
    }),
    deleteAccount: builder.mutation<void, number>({
      query: (id) => ({ url: `accounts/${id}`, method: 'DELETE' }),
      invalidatesTags: ['Account'],
    }),
    // An owner, admin or editor gets the full schedule; a viewer gets the limited one.
    getLoanSchedule: builder.query<LoanScheduleResponse, number>({
      query: (id) => `accounts/${id}/loan-schedule`,
      providesTags: ['Account'],
    }),
    // Credit accounts only (anything else is a 400).
    getAccountStatements: builder.query<CardStatementsResponse, number>({
      query: (id) => `accounts/${id}/statements`,
      providesTags: ['Account', 'Transaction'],
    }),
    recordLoanPayment: builder.mutation<Transaction, { id: number; data: LoanPaymentRequest }>({
      query: ({ id, data }) => ({ url: `accounts/${id}/loan-payment`, method: 'POST', body: data }),
      invalidatesTags: ['Account', 'Transaction', 'Allocation'],
    }),
    recordLoanPrepayment: builder.mutation<Transaction, { id: number; data: LoanPrepaymentRequest }>({
      query: ({ id, data }) => ({ url: `accounts/${id}/loan-prepayment`, method: 'POST', body: data }),
      invalidatesTags: ['Account', 'Transaction', 'Allocation'],
    }),
    getAccountBalance: builder.query<AccountBalance, number>({
      query: (id) => `accounts/${id}/balance`,
      providesTags: ['Account'],
    }),

    // ── Categories ────────────────────────────────────────────────────────────
    getCategories: builder.query<Category[], { is_expense?: boolean; is_active?: boolean }>({
      query: (params) => ({ url: 'categories/', params }),
      providesTags: ['Category'],
    }),
    getCategory: builder.query<Category, number>({
      query: (id) => `categories/${id}`,
      providesTags: ['Category'],
    }),
    createCategory: builder.mutation<Category, Partial<Category>>({
      query: (category) => ({ url: 'categories/', method: 'POST', body: category }),
      invalidatesTags: ['Category'],
    }),
    updateCategory: builder.mutation<Category, { id: number; data: Partial<Category> }>({
      query: ({ id, data }) => ({ url: `categories/${id}`, method: 'PUT', body: data }),
      invalidatesTags: ['Category'],
    }),
    deleteCategory: builder.mutation<void, number>({
      query: (id) => ({ url: `categories/${id}`, method: 'DELETE' }),
      invalidatesTags: ['Category'],
    }),

    // ── Allocations ───────────────────────────────────────────────────────────
    getAllocations: builder.query<PaginatedResponse<Allocation>, { account_id?: number; allocation_type?: string; is_active?: boolean; limit?: number; offset?: number }>({
      query: (params) => ({ url: 'allocations/', params }),
      providesTags: ['Allocation'],
    }),
    getAllocation: builder.query<Allocation, number>({
      query: (id) => `allocations/${id}`,
      providesTags: ['Allocation'],
    }),
    createAllocation: builder.mutation<Allocation, Partial<Allocation>>({
      query: (allocation) => ({ url: 'allocations/', method: 'POST', body: allocation }),
      invalidatesTags: ['Allocation'],
    }),
    updateAllocation: builder.mutation<Allocation, { id: number; data: Partial<Allocation> }>({
      query: ({ id, data }) => ({ url: `allocations/${id}`, method: 'PUT', body: data }),
      invalidatesTags: ['Allocation'],
    }),
    deleteAllocation: builder.mutation<void, number>({
      query: (id) => ({ url: `allocations/${id}`, method: 'DELETE' }),
      invalidatesTags: ['Allocation'],
    }),
    getAllocationProgress: builder.query<AllocationProgress, number>({
      query: (id) => `allocations/${id}/progress`,
      providesTags: ['Allocation'],
    }),
    getGoalsSummary: builder.query<GoalsSummary, void>({
      query: () => 'allocations/summary/goals',
      providesTags: ['Allocation'],
    }),

    // ── Budget Entries ────────────────────────────────────────────────────────
    getBudgetEntries: builder.query<PaginatedResponse<BudgetEntry>, {
      entry_type?: 'income' | 'expense'
      is_active?: boolean
      tag?: number
      before?: string
      after?: string
      limit?: number
      offset?: number
    }>({
      query: (params) => ({ url: 'budget-entries/', params }),
      providesTags: ['BudgetEntry'],
    }),
    createBudgetEntry: builder.mutation<BudgetEntry, BudgetEntryInput>({
      query: (entry) => ({ url: 'budget-entries/', method: 'POST', body: entry }),
      invalidatesTags: ['BudgetEntry', 'Transaction', 'Allocation'],
    }),
    updateBudgetEntry: builder.mutation<BudgetEntry, { id: number; data: BudgetEntryInput }>({
      query: ({ id, data }) => ({ url: `budget-entries/${id}`, method: 'PUT', body: data }),
      invalidatesTags: ['BudgetEntry', 'Transaction', 'Allocation'],
    }),
    deleteBudgetEntry: builder.mutation<void, number>({
      query: (id) => ({ url: `budget-entries/${id}`, method: 'DELETE' }),
      invalidatesTags: ['BudgetEntry', 'Transaction', 'Allocation'],
    }),
    materializeBudgetEntry: builder.mutation<Transaction, { id: number; data?: { transaction_date?: string; amount?: number; advance?: boolean } }>({
      query: ({ id, data }) => ({ url: `budget-entries/${id}/materialize`, method: 'POST', body: data ?? {} }),
      invalidatesTags: ['BudgetEntry', 'Transaction', 'Account', 'Allocation'],
    }),

    // ── Transactions ──────────────────────────────────────────────────────────
    getTransactions: builder.query<PaginatedResponse<Transaction>, {
      account_ids?: number[]
      category_ids?: number[]
      allocation_id?: number
      transaction_types?: string[]
      start_date?: string
      end_date?: string
      is_reconciled?: boolean
      tag?: number
      search?: string
      limit?: number
      offset?: number
    }>({
      query: (params) => {
        const searchParams = new URLSearchParams()
        params?.account_ids?.forEach((id) => searchParams.append('account_ids', String(id)))
        params?.category_ids?.forEach((id) => searchParams.append('category_ids', String(id)))
        params?.transaction_types?.forEach((v) => searchParams.append('transaction_types', v))
        if (typeof params?.allocation_id === 'number') searchParams.set('allocation_id', String(params.allocation_id))
        if (params?.start_date) searchParams.set('start_date', params.start_date)
        if (params?.end_date) searchParams.set('end_date', params.end_date)
        if (typeof params?.is_reconciled === 'boolean') searchParams.set('is_reconciled', String(params.is_reconciled))
        if (typeof params?.tag === 'number') searchParams.set('tag', String(params.tag))
        if (params?.search) searchParams.set('search', params.search)
        if (typeof params?.limit === 'number') searchParams.set('limit', String(params.limit))
        if (typeof params?.offset === 'number') searchParams.set('offset', String(params.offset))
        return { url: 'transactions/', params: searchParams }
      },
      providesTags: ['Transaction'],
    }),
    getTransaction: builder.query<Transaction, number>({
      query: (id) => `transactions/${id}`,
      providesTags: ['Transaction'],
    }),
    createTransaction: builder.mutation<Transaction, TransactionInput>({
      query: (transaction) => ({ url: 'transactions/', method: 'POST', body: transaction }),
      invalidatesTags: ['Transaction', 'Account', 'Allocation'],
    }),
    updateTransaction: builder.mutation<Transaction, { id: number; data: TransactionInput }>({
      query: ({ id, data }) => ({ url: `transactions/${id}`, method: 'PUT', body: data }),
      invalidatesTags: ['Transaction', 'Account', 'Allocation'],
    }),
    deleteTransaction: builder.mutation<void, number>({
      query: (id) => ({ url: `transactions/${id}`, method: 'DELETE' }),
      invalidatesTags: ['Transaction', 'Account', 'Allocation'],
    }),
    uploadReceipt: builder.mutation<{ message: string; file_url: string }, { transaction_id: number; file: File }>({
      query: ({ transaction_id, file }) => {
        const formData = new FormData()
        formData.append('file', file)
        return { url: `transactions/${transaction_id}/upload-receipt`, method: 'POST', body: formData }
      },
      invalidatesTags: ['Transaction'],
    }),
    getTransactionSummary: builder.query<TransactionSummary, { start_date: string; end_date: string; account_id?: number; tag?: number }>({
      query: (params) => ({ url: 'transactions/summary/period', params }),
      providesTags: ['Transaction'],
    }),

    // ── Forecast ──────────────────────────────────────────────────────────────
    getForecastTimeline: builder.query<CashflowTimeline, { days?: number; tag?: number } | void>({
      query: (params) => ({ url: 'forecast/timeline', params: params ?? {} }),
      providesTags: ['Account', 'BudgetEntry', 'Transaction'],
    }),

    // ── Tags ──────────────────────────────────────────────────────────────────
    // A rename, recolour or delete changes the tags embedded in every record, so those
    // lists refresh too.
    getTags: builder.query<Tag[], void>({
      query: () => 'tags/',
      providesTags: ['Tag'],
    }),
    createTag: builder.mutation<Tag, TagCreate>({
      query: (body) => ({ url: 'tags/', method: 'POST', body }),
      invalidatesTags: ['Tag'],
    }),
    updateTag: builder.mutation<Tag, { id: number; data: TagUpdate }>({
      query: ({ id, data }) => ({ url: `tags/${id}`, method: 'PUT', body: data }),
      invalidatesTags: ['Tag', 'Account', 'Transaction', 'BudgetEntry'],
    }),
    deleteTag: builder.mutation<void, number>({
      query: (id) => ({ url: `tags/${id}`, method: 'DELETE' }),
      invalidatesTags: ['Tag', 'Account', 'Transaction', 'BudgetEntry'],
    }),

    // ── Shares ────────────────────────────────────────────────────────────────
    // Owner or admin only (and never a demo user: those get 403). Any share change
    // refreshes the shares and the accounts, which carry the role and owner name.
    getAccountShares: builder.query<AccountShares, number>({
      query: (accountId) => `accounts/${accountId}/shares`,
      providesTags: ['Share'],
    }),
    createAccountShare: builder.mutation<AccountShare, { accountId: number; data: ShareCreate }>({
      query: ({ accountId, data }) => ({ url: `accounts/${accountId}/shares`, method: 'POST', body: data }),
      invalidatesTags: ['Share', 'Account'],
    }),
    // Demoting or removing a share deactivates the recurring entries that person kept on
    // the account and changes how its records read, so these refresh like leaveShare.
    updateAccountShare: builder.mutation<AccountShare, { accountId: number; shareId: number; data: ShareUpdate }>({
      query: ({ accountId, shareId, data }) => ({
        url: `accounts/${accountId}/shares/${shareId}`,
        method: 'PATCH',
        body: data,
      }),
      invalidatesTags: ['Share', 'Account', 'Transaction', 'BudgetEntry', 'Allocation'],
    }),
    deleteAccountShare: builder.mutation<void, { accountId: number; shareId: number }>({
      query: ({ accountId, shareId }) => ({ url: `accounts/${accountId}/shares/${shareId}`, method: 'DELETE' }),
      invalidatesTags: ['Share', 'Account', 'Transaction', 'BudgetEntry', 'Allocation'],
    }),
    // Shares other people made to the caller.
    getReceivedShares: builder.query<ReceivedShare[], void>({
      query: () => 'shares/received',
      providesTags: ['ReceivedShare'],
    }),
    // Leaving drops the account and every record, entry and projection that came through it.
    leaveShare: builder.mutation<void, number>({
      query: (shareId) => ({ url: `shares/received/${shareId}`, method: 'DELETE' }),
      invalidatesTags: ['ReceivedShare', 'Share', 'Account', 'Transaction', 'BudgetEntry', 'Allocation'],
    }),
    // Exact, case-insensitive email match; 404 "No matching user" otherwise; 429 when
    // the caller looks up too often (10 per 60 seconds).
    lookupUser: builder.query<UserMatch, string>({
      query: (email) => ({ url: 'users/lookup', params: { email } }),
      keepUnusedDataFor: 0,
    }),

    // ── Wishlist ──────────────────────────────────────────────────────────────
    getWishlist: builder.query<WishlistItem[], { is_purchased?: boolean } | void>({
      query: (params) => ({ url: 'wishlist/', params: params ?? {} }),
      providesTags: ['Wishlist'],
    }),
    getWishlistPlan: builder.query<WishlistPlan, void>({
      query: () => 'wishlist/plan',
      providesTags: ['Wishlist', 'BudgetEntry'],
    }),
    createWishlistItem: builder.mutation<WishlistItem, Partial<WishlistItem>>({
      query: (body) => ({ url: 'wishlist/', method: 'POST', body }),
      invalidatesTags: ['Wishlist'],
    }),
    updateWishlistItem: builder.mutation<WishlistItem, { id: number; data: Partial<WishlistItem> }>({
      query: ({ id, data }) => ({ url: `wishlist/${id}`, method: 'PUT', body: data }),
      invalidatesTags: ['Wishlist'],
    }),
    deleteWishlistItem: builder.mutation<void, number>({
      query: (id) => ({ url: `wishlist/${id}`, method: 'DELETE' }),
      invalidatesTags: ['Wishlist'],
    }),
  }),
})

export const {
  // Account hooks
  useGetAccountsQuery,
  useLazyGetAccountsQuery,
  useGetAccountQuery,
  useLazyGetAccountQuery,
  useCreateAccountMutation,
  useUpdateAccountMutation,
  useDeleteAccountMutation,
  useGetAccountBalanceQuery,
  useGetLoanScheduleQuery,
  useGetAccountStatementsQuery,
  useRecordLoanPaymentMutation,
  useRecordLoanPrepaymentMutation,

  // Category hooks
  useGetCategoriesQuery,
  useGetCategoryQuery,
  useCreateCategoryMutation,
  useUpdateCategoryMutation,
  useDeleteCategoryMutation,

  // Allocation hooks
  useGetAllocationsQuery,
  useLazyGetAllocationsQuery,
  useGetAllocationQuery,
  useCreateAllocationMutation,
  useUpdateAllocationMutation,
  useDeleteAllocationMutation,
  useGetAllocationProgressQuery,
  useGetGoalsSummaryQuery,

  // Budget entry hooks
  useGetBudgetEntriesQuery,
  useLazyGetBudgetEntriesQuery,
  useCreateBudgetEntryMutation,
  useUpdateBudgetEntryMutation,
  useDeleteBudgetEntryMutation,
  useMaterializeBudgetEntryMutation,

  // Transaction hooks
  useGetTransactionsQuery,
  useLazyGetTransactionsQuery,
  useGetTransactionQuery,
  useCreateTransactionMutation,
  useUpdateTransactionMutation,
  useDeleteTransactionMutation,
  useUploadReceiptMutation,
  useGetTransactionSummaryQuery,

  // Tag hooks
  useGetTagsQuery,
  useCreateTagMutation,
  useUpdateTagMutation,
  useDeleteTagMutation,

  // Share hooks
  useGetAccountSharesQuery,
  useCreateAccountShareMutation,
  useUpdateAccountShareMutation,
  useDeleteAccountShareMutation,
  useGetReceivedSharesQuery,
  useLeaveShareMutation,
  useLazyLookupUserQuery,

  // Forecast hooks
  useGetForecastTimelineQuery,

  // Wishlist hooks
  useGetWishlistQuery,
  useGetWishlistPlanQuery,
  useCreateWishlistItemMutation,
  useUpdateWishlistItemMutation,
  useDeleteWishlistItemMutation,
} = accountingApi
