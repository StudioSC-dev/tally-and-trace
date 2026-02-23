import { createApi, fetchBaseQuery } from '@reduxjs/toolkit/query/react'
import type {
  Account,
  Category,
  Allocation,
  BudgetEntry,
  Transaction,
  Entity,
  EntityWithMembers,
  WishlistItem,
  PaginatedResponse,
  AccountBalance,
  AllocationProgress,
  GoalsSummary,
  TransactionSummary,
  DashboardSnapshot,
  CashFlowProjection,
  UpcomingBill,
  NetDisposableIncome,
} from '@tally-trace/shared'
import { tokenStore } from '../utils/tokenStore'
import Constants from 'expo-constants'
import { Platform } from 'react-native'

// Re-export types for use in screens
export type {
  Account,
  Category,
  Allocation,
  BudgetEntry,
  Transaction,
  Entity,
  EntityWithMembers,
  WishlistItem,
  PaginatedResponse,
  AccountBalance,
  AllocationProgress,
  GoalsSummary,
  TransactionSummary,
  DashboardSnapshot,
  CashFlowProjection,
  UpcomingBill,
  NetDisposableIncome,
}

// Android emulator routes to the host machine via 10.0.2.2 (not localhost).
// iOS Simulator can use localhost directly.
const LOCAL_API_URL = Platform.OS === 'android'
  ? 'http://10.0.2.2:8000/api/v1'
  : 'http://localhost:8000/api/v1'

const API_BASE_URL =
  (Constants.expoConfig?.extra?.apiUrl as string | undefined) ??
  process.env.EXPO_PUBLIC_API_URL ??
  LOCAL_API_URL

const rawBaseQuery = fetchBaseQuery({
  baseUrl: API_BASE_URL,
  prepareHeaders: (headers) => {
    const token = tokenStore.getToken()
    if (token) {
      headers.set('authorization', `Bearer ${token}`)
    }
    return headers
  },
})

export const accountingApi = createApi({
  reducerPath: 'accountingApi',
  baseQuery: rawBaseQuery,
  tagTypes: ['Account', 'Category', 'Transaction', 'Allocation', 'BudgetEntry', 'Entity', 'Wishlist', 'Dashboard'],
  endpoints: (builder) => ({
    // ── Accounts ──────────────────────────────────────────────────────────────
    getAccounts: builder.query<PaginatedResponse<Account>, { account_type?: string; is_active?: boolean; limit?: number; offset?: number } | void>({
      query: (params) => ({ url: 'accounts/', params: params ?? {} }),
      providesTags: ['Account'],
    }),
    getAccount: builder.query<Account, number>({
      query: (id) => `accounts/${id}`,
      providesTags: ['Account'],
    }),
    createAccount: builder.mutation<Account, Partial<Account>>({
      query: (account) => ({ url: 'accounts/', method: 'POST', body: account }),
      invalidatesTags: ['Account'],
    }),
    updateAccount: builder.mutation<Account, { id: number; data: Partial<Account> }>({
      query: ({ id, data }) => ({ url: `accounts/${id}`, method: 'PUT', body: data }),
      invalidatesTags: ['Account'],
    }),
    deleteAccount: builder.mutation<void, number>({
      query: (id) => ({ url: `accounts/${id}`, method: 'DELETE' }),
      invalidatesTags: ['Account'],
    }),
    getAccountBalance: builder.query<AccountBalance, number>({
      query: (id) => `accounts/${id}/balance`,
      providesTags: ['Account'],
    }),

    // ── Categories ────────────────────────────────────────────────────────────
    getCategories: builder.query<Category[], { is_expense?: boolean; is_active?: boolean } | void>({
      query: (params) => ({ url: 'categories/', params: params ?? {} }),
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
    getAllocations: builder.query<PaginatedResponse<Allocation>, { account_id?: number; allocation_type?: string; is_active?: boolean; limit?: number; offset?: number } | void>({
      query: (params) => ({ url: 'allocations/', params: params ?? {} }),
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
      limit?: number
      offset?: number
    } | void>({
      query: (params) => ({ url: 'budget-entries/', params: params ?? {} }),
      providesTags: ['BudgetEntry'],
    }),
    createBudgetEntry: builder.mutation<BudgetEntry, Partial<BudgetEntry>>({
      query: (entry) => ({ url: 'budget-entries/', method: 'POST', body: entry }),
      invalidatesTags: ['BudgetEntry', 'Transaction', 'Allocation'],
    }),
    updateBudgetEntry: builder.mutation<BudgetEntry, { id: number; data: Partial<BudgetEntry> }>({
      query: ({ id, data }) => ({ url: `budget-entries/${id}`, method: 'PUT', body: data }),
      invalidatesTags: ['BudgetEntry', 'Transaction', 'Allocation'],
    }),
    deleteBudgetEntry: builder.mutation<void, number>({
      query: (id) => ({ url: `budget-entries/${id}`, method: 'DELETE' }),
      invalidatesTags: ['BudgetEntry', 'Transaction', 'Allocation'],
    }),

    // ── Transactions ──────────────────────────────────────────────────────────
    getTransactions: builder.query<PaginatedResponse<Transaction>, {
      account_ids?: number[]
      category_ids?: number[]
      transaction_types?: string[]
      start_date?: string
      end_date?: string
      search?: string
      limit?: number
      offset?: number
    } | void>({
      query: (params) => {
        if (!params) return { url: 'transactions/', params: {} }
        const searchParams = new URLSearchParams()
        params.account_ids?.forEach((id) => searchParams.append('account_ids', String(id)))
        params.category_ids?.forEach((id) => searchParams.append('category_ids', String(id)))
        params.transaction_types?.forEach((v) => searchParams.append('transaction_types', v))
        if (params.start_date) searchParams.set('start_date', params.start_date)
        if (params.end_date) searchParams.set('end_date', params.end_date)
        if (params.search) searchParams.set('search', params.search)
        if (typeof params.limit === 'number') searchParams.set('limit', String(params.limit))
        if (typeof params.offset === 'number') searchParams.set('offset', String(params.offset))
        return { url: 'transactions/', params: searchParams }
      },
      providesTags: ['Transaction'],
    }),
    getTransaction: builder.query<Transaction, number>({
      query: (id) => `transactions/${id}`,
      providesTags: ['Transaction'],
    }),
    createTransaction: builder.mutation<Transaction, Partial<Transaction>>({
      query: (transaction) => ({ url: 'transactions/', method: 'POST', body: transaction }),
      invalidatesTags: ['Transaction', 'Account', 'Allocation'],
    }),
    updateTransaction: builder.mutation<Transaction, { id: number; data: Partial<Transaction> }>({
      query: ({ id, data }) => ({ url: `transactions/${id}`, method: 'PUT', body: data }),
      invalidatesTags: ['Transaction', 'Account', 'Allocation'],
    }),
    deleteTransaction: builder.mutation<void, number>({
      query: (id) => ({ url: `transactions/${id}`, method: 'DELETE' }),
      invalidatesTags: ['Transaction', 'Account', 'Allocation'],
    }),
    getTransactionSummary: builder.query<TransactionSummary, { start_date: string; end_date: string }>({
      query: (params) => ({ url: 'transactions/summary/period', params }),
      providesTags: ['Transaction'],
    }),

    // ── Entities ──────────────────────────────────────────────────────────────
    getMyEntities: builder.query<Entity[], void>({
      query: () => 'entities/me',
      providesTags: ['Entity'],
    }),
    getEntity: builder.query<EntityWithMembers, number>({
      query: (id) => `entities/${id}`,
      providesTags: ['Entity'],
    }),
    createEntity: builder.mutation<Entity, { name: string; entity_type: string }>({
      query: (body) => ({ url: 'entities/', method: 'POST', body }),
      invalidatesTags: ['Entity'],
    }),
    updateEntity: builder.mutation<Entity, { id: number; data: { name?: string; entity_type?: string } }>({
      query: ({ id, data }) => ({ url: `entities/${id}`, method: 'PUT', body: data }),
      invalidatesTags: ['Entity'],
    }),
    deleteEntity: builder.mutation<void, number>({
      query: (id) => ({ url: `entities/${id}`, method: 'DELETE' }),
      invalidatesTags: ['Entity'],
    }),

    // ── Wishlist ──────────────────────────────────────────────────────────────
    getWishlistItems: builder.query<PaginatedResponse<WishlistItem>, { is_achieved?: boolean; limit?: number; offset?: number } | void>({
      query: (params) => ({ url: 'wishlist/', params: params ?? {} }),
      providesTags: ['Wishlist'],
    }),
    createWishlistItem: builder.mutation<WishlistItem, Partial<WishlistItem>>({
      query: (item) => ({ url: 'wishlist/', method: 'POST', body: item }),
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

    // ── Dashboard ─────────────────────────────────────────────────────────────
    getDashboardSnapshot: builder.query<DashboardSnapshot, void>({
      query: () => 'dashboard/snapshot',
      providesTags: ['Dashboard', 'Account', 'Transaction', 'Allocation'],
    }),

    // ── Forecast ─────────────────────────────────────────────────────────────
    getCashFlowProjection: builder.query<CashFlowProjection, { num_months?: number } | void>({
      query: (params) => ({ url: 'forecast/cash-flow-projection', params: params ?? {} }),
    }),
    getUpcomingBills: builder.query<UpcomingBill[], { num_days?: number } | void>({
      query: (params) => ({ url: 'forecast/upcoming-bills', params: params ?? {} }),
    }),
    getNetDisposableIncome: builder.query<NetDisposableIncome, void>({
      query: () => 'forecast/net-disposable-income',
    }),
  }),
})

export const {
  // Account
  useGetAccountsQuery,
  useGetAccountQuery,
  useCreateAccountMutation,
  useUpdateAccountMutation,
  useDeleteAccountMutation,
  useGetAccountBalanceQuery,
  // Category
  useGetCategoriesQuery,
  useCreateCategoryMutation,
  useUpdateCategoryMutation,
  useDeleteCategoryMutation,
  // Allocation
  useGetAllocationsQuery,
  useGetAllocationQuery,
  useCreateAllocationMutation,
  useUpdateAllocationMutation,
  useDeleteAllocationMutation,
  useGetAllocationProgressQuery,
  useGetGoalsSummaryQuery,
  // Budget entry
  useGetBudgetEntriesQuery,
  useCreateBudgetEntryMutation,
  useUpdateBudgetEntryMutation,
  useDeleteBudgetEntryMutation,
  // Transaction
  useGetTransactionsQuery,
  useGetTransactionQuery,
  useCreateTransactionMutation,
  useUpdateTransactionMutation,
  useDeleteTransactionMutation,
  useGetTransactionSummaryQuery,
  // Entity
  useGetMyEntitiesQuery,
  useGetEntityQuery,
  useCreateEntityMutation,
  useUpdateEntityMutation,
  useDeleteEntityMutation,
  // Wishlist
  useGetWishlistItemsQuery,
  useCreateWishlistItemMutation,
  useUpdateWishlistItemMutation,
  useDeleteWishlistItemMutation,
  // Dashboard
  useGetDashboardSnapshotQuery,
  // Forecast
  useGetCashFlowProjectionQuery,
  useGetUpcomingBillsQuery,
  useGetNetDisposableIncomeQuery,
} = accountingApi
