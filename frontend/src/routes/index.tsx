import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useGetAccountsQuery, useGetTransactionsQuery, useGetCategoriesQuery, useGetBudgetEntriesQuery, useGetAllocationsQuery } from '../store/api'
import type { Transaction, BudgetEntry, Allocation } from '../store/api'
import { useState, useEffect, useMemo } from 'react'
import { useAuth } from '../contexts/AuthContext'
import { useCurrency } from '../hooks/useCurrency'
import { formatCurrency } from '../utils/currency'

const FALLBACK_CATEGORY_COLORS = ['#2563eb', '#7c3aed', '#16a34a', '#f97316', '#db2777']

type ExpenditureInsight = {
  id: number
  name: string
  amount: number
  transactions: Transaction[]
  displayColor: string
  percentage: number
}

export const Route = createFileRoute('/')({
  component: Dashboard,
})

const MS_PER_DAY = 1000 * 60 * 60 * 24

const addCadence = (date: Date, cadence: BudgetEntry['cadence']) => {
  const next = new Date(date.getTime())
  switch (cadence) {
    case 'monthly':
      next.setMonth(next.getMonth() + 1)
      break
    case 'quarterly':
      next.setMonth(next.getMonth() + 3)
      break
    case 'semi_annual':
      next.setMonth(next.getMonth() + 6)
      break
    case 'annual':
      next.setFullYear(next.getFullYear() + 1)
      break
    default:
      break
  }
  return next
}

const addDays = (date: Date, days: number) => {
  const next = new Date(date.getTime())
  next.setDate(next.getDate() + days)
  return next
}

const getOrdinalSuffix = (day: number) => {
  if (day % 100 >= 11 && day % 100 <= 13) return 'th'
  switch (day % 10) {
    case 1: return 'st'
    case 2: return 'nd'
    case 3: return 'rd'
    default: return 'th'
  }
}

const formatDateWithOrdinal = (value: Date) => {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return 'Unknown date'
  const month = new Intl.DateTimeFormat('en-US', { month: 'short' }).format(date)
  const day = date.getDate()
  const year = date.getFullYear()
  return `${month} ${day}${getOrdinalSuffix(day)}, ${year}`
}

const generateOccurrencesWithinRange = (
  entry: BudgetEntry,
  rangeStart: Date,
  rangeEnd: Date,
  maxIterations = 24
) => {
  const occurrences: Date[] = []
  if (!entry.next_occurrence) return occurrences

  let occurrence = new Date(entry.next_occurrence)
  if (Number.isNaN(occurrence.getTime())) return occurrences

  const endDateLimit =
    entry.end_mode === 'on_date' && entry.end_date ? new Date(entry.end_date) : null
  let occurrencesRemaining =
    entry.end_mode === 'after_occurrences' && entry.max_occurrences
      ? entry.max_occurrences
      : Infinity

  for (let i = 0; i < maxIterations && occurrencesRemaining > 0 && occurrence <= rangeEnd; i++) {
    if (endDateLimit && occurrence > endDateLimit) break
    if (occurrence >= rangeStart && occurrence <= rangeEnd) {
      occurrences.push(new Date(occurrence))
    }
    occurrencesRemaining--
    if (occurrencesRemaining <= 0) break
    const nextOccurrence = addCadence(occurrence, entry.cadence)
    if (nextOccurrence.getTime() === occurrence.getTime()) break
    occurrence = nextOccurrence
  }

  return occurrences
}

export function Dashboard() {
  const { isAuthenticated, isLoading: authLoading } = useAuth()
  const navigate = useNavigate()
  const { format, currencyCode } = useCurrency()

  useEffect(() => {
    if (!authLoading && !isAuthenticated) {
      navigate({ to: '/login', search: { message: undefined } })
    }
  }, [isAuthenticated, authLoading, navigate])

  const [selectedPeriod, setSelectedPeriod] = useState<'week' | 'month' | 'year'>('month')

  const { data: accountsData, isLoading: accountsLoading, error: accountsError } =
    useGetAccountsQuery({ is_active: true, limit: 1000 }, { skip: !isAuthenticated })
  const { data: transactionsData, isLoading: transactionsLoading, error: transactionsError } =
    useGetTransactionsQuery({ limit: 1000 }, { skip: !isAuthenticated })
  const { data: categoriesData, isLoading: categoriesLoading, error: categoriesError } =
    useGetCategoriesQuery({ is_active: true }, { skip: !isAuthenticated })
  const { data: budgetEntriesData, isLoading: budgetEntriesLoading, error: budgetEntriesError } =
    useGetBudgetEntriesQuery({ is_active: true, limit: 200 }, { skip: !isAuthenticated })
  const { data: allocationsData, isLoading: allocationsLoading, error: allocationsError } =
    useGetAllocationsQuery({ limit: 1000, offset: 0 }, { skip: !isAuthenticated })

  const accounts = useMemo(() => accountsData?.items ?? [], [accountsData])
  const transactions = useMemo(() => transactionsData?.items ?? [], [transactionsData])
  const categories = categoriesData ?? []
  const budgetEntries = useMemo(() => budgetEntriesData?.items ?? [], [budgetEntriesData])
  const allocations = useMemo(() => allocationsData?.items ?? [], [allocationsData])
  const budgetAllocations = useMemo(
    () => allocations.filter((a) => a.allocation_type === 'budget' && a.is_active),
    [allocations]
  )

  const dateRange = useMemo(() => {
    const now = new Date()
    const startDate = new Date(now.getFullYear(), now.getMonth(), now.getDate())
    startDate.setHours(0, 0, 0, 0)
    switch (selectedPeriod) {
      case 'week': startDate.setDate(now.getDate() - 6); break
      case 'month': startDate.setMonth(now.getMonth(), 1); break
      case 'year': startDate.setMonth(0, 1); break
    }
    return { start_date: startDate.toISOString(), end_date: now.toISOString() }
  }, [selectedPeriod])

  const currentMonthStart = useMemo(() => {
    const base = new Date()
    return new Date(base.getFullYear(), base.getMonth(), 1)
  }, [])

  const currentMonthEnd = useMemo(() => {
    const base = new Date()
    return new Date(base.getFullYear(), base.getMonth() + 1, 0, 23, 59, 59, 999)
  }, [])

  const monthTransactionsBySchedule = useMemo(() => {
    const map = new Map<number, Transaction[]>()
    transactions.forEach((transaction) => {
      if (!transaction.budget_entry_id || !transaction.is_posted) return
      const txDate = new Date(transaction.transaction_date)
      if (txDate < currentMonthStart || txDate > currentMonthEnd) return
      const key = transaction.budget_entry_id
      const existing = map.get(key)
      if (existing) existing.push(transaction)
      else map.set(key, [transaction])
    })
    return map
  }, [transactions, currentMonthStart, currentMonthEnd])

  const scheduleSummaries = useMemo(() => {
    return budgetEntries
      .filter((entry) => entry.is_active)
      .map((entry) => {
        const occurrences = generateOccurrencesWithinRange(entry, currentMonthStart, currentMonthEnd)
        const forecastTotal = occurrences.length * entry.amount
        const actualTransactions = monthTransactionsBySchedule.get(entry.id) ?? []
        const actualTotal = actualTransactions.reduce((sum, t) => sum + t.amount, 0)
        const nextOccurrence =
          occurrences.length > 0
            ? occurrences[0]
            : entry.next_occurrence
            ? new Date(entry.next_occurrence)
            : null
        return { entry, occurrences, forecastTotal, actualTotal, currency: entry.currency, entryType: entry.entry_type, nextOccurrence, actualTransactions }
      })
      .filter((summary) => summary.occurrences.length > 0 || summary.actualTotal > 0)
  }, [budgetEntries, currentMonthStart, currentMonthEnd, monthTransactionsBySchedule])

  const projectionsSummary = useMemo(() => {
    const totals = { income: { forecast: 0, actual: 0 }, expense: { forecast: 0, actual: 0 } }
    scheduleSummaries.forEach((summary) => {
      if (summary.currency !== currencyCode) return
      if (summary.entryType === 'income') {
        totals.income.forecast += summary.forecastTotal
        totals.income.actual += summary.actualTotal
      } else {
        totals.expense.forecast += summary.forecastTotal
        totals.expense.actual += summary.actualTotal
      }
    })
    return totals
  }, [scheduleSummaries, currencyCode])

  const projectedIncome = projectionsSummary.income.forecast
  const projectedExpenses = projectionsSummary.expense.forecast
  const projectedNetFlow = projectedIncome - projectedExpenses

  const upcomingReminders = useMemo(() => {
    const start = new Date()
    const end = addDays(start, 30)
    return budgetEntries
      .filter((entry) => entry.is_active)
      .flatMap((entry) => {
        const occurrences = generateOccurrencesWithinRange(entry, start, end)
        return occurrences.map((occurrence) => {
          const rawReminder = entry.lead_time_days && entry.lead_time_days > 0
            ? addDays(occurrence, -entry.lead_time_days)
            : new Date(occurrence.getTime())
          const reminderDate = rawReminder < start ? start : rawReminder
          return {
            entry,
            occurrence,
            reminderDate,
            daysUntil: Math.max(0, Math.ceil((occurrence.getTime() - start.getTime()) / MS_PER_DAY)),
          }
        })
      })
      .sort((a, b) => a.occurrence.getTime() - b.occurrence.getTime())
  }, [budgetEntries])

  const totalBalance = accounts.reduce((sum, account) => sum + account.balance, 0)

  const { periodIncome, periodExpenses, periodNet } = useMemo(() => {
    const start = new Date(dateRange.start_date)
    const end = new Date(dateRange.end_date)
    let income = 0
    let expenses = 0
    transactions.forEach((transaction) => {
      if (!transaction.is_posted) return
      const txDate = new Date(transaction.transaction_date)
      if (txDate < start || txDate > end) return
      if (transaction.transaction_type === 'credit') income += transaction.amount
      else if (transaction.transaction_type === 'debit') expenses += transaction.amount
    })
    return { periodIncome: income, periodExpenses: expenses, periodNet: income - expenses }
  }, [transactions, dateRange])

  const projectedBalanceEnd = totalBalance + (projectedNetFlow - periodNet)
  const showProjections = selectedPeriod !== 'year' && scheduleSummaries.length > 0
  const projectionPeriodLabel = selectedPeriod === 'week' ? 'week' : 'month'
  const periodHeadingLabel = selectedPeriod === 'year' ? 'Year to Date' : selectedPeriod === 'month' ? 'Month to Date' : 'Week to Date'
  const periodTag = selectedPeriod === 'year' ? 'YTD' : selectedPeriod === 'month' ? 'MTD' : 'WTD'

  const upcomingPlannedExpenses = useMemo(() => {
    const reference = new Date()
    const targetMonth = reference.getMonth()
    const targetYear = reference.getFullYear()
    return upcomingReminders
      .filter((reminder) => reminder.entry.entry_type === 'expense')
      .filter((reminder) => {
        const occ = reminder.occurrence
        return occ.getMonth() === targetMonth && occ.getFullYear() === targetYear
      })
      .slice(0, 6)
      .map((reminder) => {
        const entry = reminder.entry
        const account = entry.account_id ? accounts.find((acc) => acc.id === entry.account_id) : undefined
        const projectedBalance = account ? account.balance - entry.amount : null
        let willOverdraw = false
        if (account) {
          if (account.account_type === 'credit' && typeof account.credit_limit === 'number' && account.credit_limit > 0) {
            willOverdraw = account.balance + entry.amount > account.credit_limit
          } else if (account.account_type !== 'credit' && projectedBalance !== null) {
            willOverdraw = projectedBalance < 0
          }
        }
        const status: 'danger' | 'autopay' | 'manual' = willOverdraw ? 'danger' : entry.is_autopay ? 'autopay' : 'manual'
        return { reminder, account, projectedBalance, status }
      })
  }, [upcomingReminders, accounts])

  const budgetEnvelopeSummaries = useMemo(() => {
    return budgetAllocations
      .map((allocation) => {
        const limit = allocation.target_amount ?? allocation.monthly_target ?? 0
        if (!limit || limit <= 0) return null
        const spent = allocation.current_amount ?? 0
        const remaining = Math.max(limit - spent, 0)
        const usagePercentage = Math.min(Math.max((spent / limit) * 100, 0), 100)
        return { allocation, limit, spent, remaining, usagePercentage }
      })
      .filter((value): value is { allocation: Allocation; limit: number; spent: number; remaining: number; usagePercentage: number } => value !== null)
  }, [budgetAllocations])

  const renderPlannedExpenseIcon = (status: 'danger' | 'autopay' | 'manual') => {
    if (status === 'danger') {
      return (
        <span className="inline-flex h-8 w-8 items-center justify-center rounded-full bg-rose-100 dark:bg-rose-500/10 text-rose-600 dark:text-rose-400">
          <svg className="h-4 w-4" viewBox="0 0 20 20" fill="currentColor">
            <polygon points="10,1 18,6 18,14 10,19 2,14 2,6" />
            <rect x="9" y="7" width="2" height="5" fill="white" rx="1" />
            <rect x="9" y="13" width="2" height="2" fill="white" rx="1" />
          </svg>
        </span>
      )
    }
    if (status === 'autopay') {
      return (
        <span className="inline-flex h-8 w-8 items-center justify-center rounded-full bg-emerald-500 dark:bg-emerald-500/80 text-white">
          <svg className="h-4 w-4" viewBox="0 0 20 20" fill="currentColor">
            <path fillRule="evenodd" d="M16.704 5.29a1 1 0 00-1.408-1.42l-6.32 6.263-2.272-2.26a1 1 0 10-1.408 1.419l2.976 2.958a1 1 0 001.408 0l7.024-6.96z" clipRule="evenodd" />
          </svg>
        </span>
      )
    }
    return (
      <span className="inline-flex h-8 w-8 items-center justify-center rounded-full bg-amber-100 dark:bg-amber-500/10 text-amber-600 dark:text-amber-400">
        <svg className="h-4 w-4" viewBox="0 0 20 20" fill="currentColor">
          <path d="M10.894 2.553c-.346-.598-1.442-.598-1.788 0l-7 12.092c-.339.586.086 1.355.894 1.355h14c.808 0 1.233-.769.894-1.355l-7-12.092z" />
          <path d="M9 13h2v2H9v-2zm0-6h2v5H9V7z" fill="white" />
        </svg>
      </span>
    )
  }

  const getTransactionsForPeriod = () => {
    return transactions.filter(transaction => {
      const transactionDate = new Date(transaction.transaction_date)
      const startDate = new Date(dateRange.start_date)
      const endDate = new Date(dateRange.end_date)
      return transactionDate >= startDate && transactionDate <= endDate
    })
  }

  const periodTransactions = getTransactionsForPeriod()

  const getExpenditureByCategory = () => {
    if (periodTransactions.length === 0 || categories.length === 0) return []
    const filteredTransactions = periodTransactions.filter(t => t.transaction_type === 'debit')
    const categoryTotals = new Map()
    const categoryTransactions = new Map()
    filteredTransactions.forEach(transaction => {
      if (transaction.category_id) {
        const category = categories.find(cat => cat.id === transaction.category_id)
        if (category) {
          categoryTotals.set(category.id, (categoryTotals.get(category.id) || 0) + transaction.amount)
          if (!categoryTransactions.has(category.id)) categoryTransactions.set(category.id, [])
          categoryTransactions.get(category.id).push(transaction)
        }
      }
    })
    return Array.from(categoryTotals.entries())
      .map(([categoryId, total]) => {
        const category = categories.find(cat => cat.id === categoryId)
        const topTransactions: Transaction[] = [...(categoryTransactions.get(categoryId) || [])]
          .sort((a, b) => b.amount - a.amount)
          .slice(0, 3)
        return { id: categoryId, name: category?.name || 'Unknown', color: category?.color || '#6B7280', amount: total, transactions: topTransactions }
      })
      .sort((a, b) => b.amount - a.amount)
      .slice(0, 5)
  }

  const topExpenditureCategories = getExpenditureByCategory()
  const totalExpenditureAmount = useMemo(
    () => topExpenditureCategories.reduce((sum, category) => sum + category.amount, 0),
    [topExpenditureCategories]
  )
  const expenditureInsights = useMemo<ExpenditureInsight[]>(() => {
    if (topExpenditureCategories.length === 0 || totalExpenditureAmount <= 0) return []
    return topExpenditureCategories.map((category, index) => {
      const color = category.color && category.color.trim() ? category.color : FALLBACK_CATEGORY_COLORS[index % FALLBACK_CATEGORY_COLORS.length]
      return { ...category, displayColor: color, percentage: (category.amount / totalExpenditureAmount) * 100 }
    })
  }, [topExpenditureCategories, totalExpenditureAmount])

  const expenditureChartStyle = useMemo(() => {
    if (expenditureInsights.length === 0) return { backgroundImage: 'conic-gradient(#334155 0% 100%)' }
    let cumulative = 0
    const segments = expenditureInsights.map((item, index) => {
      const start = cumulative
      cumulative += item.percentage
      if (index === expenditureInsights.length - 1 || cumulative > 100) cumulative = 100
      return `${item.displayColor} ${start}% ${cumulative}%`
    })
    return { backgroundImage: `conic-gradient(${segments.join(', ')})` }
  }, [expenditureInsights])

  const allLoading = accountsLoading && transactionsLoading && categoriesLoading && budgetEntriesLoading && allocationsLoading

  if (authLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50 dark:bg-slate-950">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-500"></div>
      </div>
    )
  }

  if (!isAuthenticated) return null

  if (accountsError) console.error('Accounts error:', accountsError)
  if (transactionsError) console.error('Transactions error:', transactionsError)
  if (categoriesError) console.error('Categories error:', categoriesError)
  if (allocationsError) console.error('Allocations error:', allocationsError)

  const getErrorDetail = (error: unknown): string | undefined => {
    if (!error || typeof error !== 'object') return undefined
    const withData = error as { data?: unknown }
    if (withData.data && typeof withData.data === 'object') {
      const maybeDetail = (withData.data as { detail?: unknown }).detail
      if (typeof maybeDetail === 'string') return maybeDetail
    }
    if ('message' in error && typeof (error as { message?: unknown }).message === 'string') {
      return (error as { message: string }).message
    }
    return undefined
  }

  if (allLoading) {
    return (
      <div className="flex items-center justify-center min-h-96">
        <div className="text-center">
          <div className="loading-spinner mx-auto mb-4"></div>
          <p className="text-gray-600 dark:text-slate-400 font-medium">Loading your financial data...</p>
        </div>
      </div>
    )
  }

  if (accountsError || transactionsError || categoriesError || budgetEntriesError || allocationsError) {
    return (
      <div className="flex items-center justify-center min-h-96">
        <div className="text-center">
          <div className="w-16 h-16 bg-red-100 dark:bg-red-500/10 rounded-full flex items-center justify-center mx-auto mb-4">
            <svg className="w-8 h-8 text-red-600 dark:text-red-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.964-.833-2.732 0L3.732 16.5c-.77.833.192 2.5 1.732 2.5z" />
            </svg>
          </div>
          <h3 className="text-lg font-semibold text-gray-900 dark:text-white mb-2">Error Loading Data</h3>
          <p className="text-gray-600 dark:text-slate-400 mb-4">There was an issue loading your financial data.</p>
          <div className="text-sm text-gray-500 dark:text-slate-500 space-y-1">
            {accountsError && <p>• Accounts: {getErrorDetail(accountsError) ?? 'Failed to load'}</p>}
            {transactionsError && <p>• Transactions: {getErrorDetail(transactionsError) ?? 'Failed to load'}</p>}
            {categoriesError && <p>• Categories: {getErrorDetail(categoriesError) ?? 'Failed to load'}</p>}
            {budgetEntriesError && <p>• Schedules: {getErrorDetail(budgetEntriesError) ?? 'Failed to load'}</p>}
            {allocationsError && <p>• Budgets: {getErrorDetail(allocationsError) ?? 'Failed to load'}</p>}
          </div>
          <button
            onClick={() => window.location.reload()}
            className="mt-4 px-4 py-2 bg-blue-500 text-white rounded-lg hover:bg-blue-600 transition-colors duration-200"
          >
            Retry
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8 space-y-8">
      {/* Header */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-white">Dashboard</h1>
          <p className="text-sm text-gray-500 dark:text-slate-400 mt-1">Your financial overview</p>
        </div>
        <div className="flex space-x-1 bg-gray-100 dark:bg-slate-800 rounded-lg p-1">
          {(['week', 'month', 'year'] as const).map((period) => (
            <button
              key={period}
              onClick={() => setSelectedPeriod(period)}
              className={`px-4 py-1.5 rounded-md text-sm font-medium transition-colors duration-200 capitalize ${
                selectedPeriod === period
                  ? 'bg-white dark:bg-slate-700 text-gray-900 dark:text-white shadow-sm'
                  : 'text-gray-600 dark:text-slate-400 hover:text-gray-900 dark:hover:text-white'
              }`}
            >
              {period}
            </button>
          ))}
        </div>
      </div>

      {/* Financial Snapshot */}
      <div className="bg-white dark:bg-slate-900/50 rounded-xl border border-gray-200 dark:border-slate-800 shadow-sm" data-onboarding="financial-snapshot">
        <div className="p-4 sm:p-6 border-b border-gray-200 dark:border-slate-800">
          <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
            <div>
              <h2 className="text-lg font-semibold text-gray-900 dark:text-white">Financial Snapshot</h2>
              <p className="text-sm text-gray-500 dark:text-slate-400">
                {selectedPeriod === 'year'
                  ? 'Tracking year-to-date performance.'
                  : 'Comparing actuals with projections for the current period.'}
              </p>
            </div>
            <span className="badge badge-info capitalize">{periodHeadingLabel}</span>
          </div>
        </div>
        <div className={`p-4 sm:p-6 grid gap-6 ${showProjections ? 'lg:grid-cols-2' : 'grid-cols-1'}`}>
          <div className="space-y-4">
            <h3 className="text-xs font-semibold text-gray-500 dark:text-slate-500 uppercase tracking-wide">
              Actual Totals ({periodHeadingLabel})
            </h3>
            <dl className="space-y-3">
              {[
                { label: 'Total balance', value: format(totalBalance), color: '' },
                { label: `Total income (${periodTag})`, value: format(periodIncome), color: 'text-emerald-600 dark:text-emerald-400' },
                { label: `Total expenses (${periodTag})`, value: format(periodExpenses), color: 'text-rose-600 dark:text-rose-400' },
                { label: `Net flow (${periodTag})`, value: format(periodNet), color: periodNet >= 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-rose-600 dark:text-rose-400' },
              ].map(({ label, value, color }) => (
                <div key={label} className="flex items-center justify-between">
                  <dt className="text-sm text-gray-500 dark:text-slate-400">{label}</dt>
                  <dd className={`text-base font-semibold ${color || 'text-gray-900 dark:text-white'}`}>{value}</dd>
                </div>
              ))}
            </dl>
          </div>
          {showProjections && (
            <div className="space-y-4">
              <h3 className="text-xs font-semibold text-gray-500 dark:text-slate-500 uppercase tracking-wide">
                Projected End of {projectionPeriodLabel}
              </h3>
              <dl className="space-y-3">
                {[
                  { label: 'Projected balance', value: format(projectedBalanceEnd), color: '' },
                  { label: 'Projected income', value: format(projectedIncome), color: 'text-emerald-600 dark:text-emerald-400' },
                  { label: 'Projected expenses', value: format(projectedExpenses), color: 'text-rose-600 dark:text-rose-400' },
                  { label: 'Projected net flow', value: format(projectedNetFlow), color: projectedNetFlow >= 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-rose-600 dark:text-rose-400' },
                ].map(({ label, value, color }) => (
                  <div key={label} className="flex items-center justify-between">
                    <dt className="text-sm text-gray-500 dark:text-slate-400">{label}</dt>
                    <dd className={`text-base font-semibold ${color || 'text-gray-900 dark:text-white'}`}>{value}</dd>
                  </div>
                ))}
              </dl>
              <p className="text-xs text-gray-500 dark:text-slate-500">
                Net realized so far:{' '}
                <span className={`font-medium ${periodNet >= 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-rose-600 dark:text-rose-400'}`}>
                  {format(periodNet)}
                </span>
              </p>
            </div>
          )}
        </div>
      </div>

      {/* Two column grid */}
      <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
        {/* Budget Envelopes */}
        <div className="bg-white dark:bg-slate-900/50 rounded-xl border border-gray-200 dark:border-slate-800 shadow-sm" data-onboarding="budget-envelopes">
          <div className="p-4 sm:p-6 border-b border-gray-200 dark:border-slate-800">
            <div className="flex items-center justify-between">
              <div>
                <h2 className="text-lg font-semibold text-gray-900 dark:text-white">Budget Envelope Status</h2>
                <p className="text-sm text-gray-500 dark:text-slate-400">Current month spending against your envelope limits.</p>
              </div>
              <span className="badge badge-info">{budgetEnvelopeSummaries.length}</span>
            </div>
          </div>
          <div className="p-4 sm:p-6 space-y-5">
            {budgetEnvelopeSummaries.length === 0 ? (
              <p className="text-sm text-gray-500 dark:text-slate-500">No active budget envelopes yet.</p>
            ) : (
              budgetEnvelopeSummaries.map(({ allocation, limit, spent, remaining, usagePercentage }) => (
                <div key={allocation.id} className="space-y-3">
                  <div className="flex items-start justify-between gap-4">
                    <div>
                      <p className="font-medium text-gray-900 dark:text-white">{allocation.name}</p>
                      {allocation.description && (
                        <p className="text-xs text-gray-500 dark:text-slate-500">{allocation.description}</p>
                      )}
                    </div>
                    <div className="text-right flex-shrink-0">
                      <p className="text-sm font-semibold text-gray-900 dark:text-white">Remaining {format(remaining)}</p>
                      <p className="text-xs text-gray-500 dark:text-slate-500">Limit {format(limit)} · Spent {format(spent)}</p>
                    </div>
                  </div>
                  <BudgetUsageBar usagePercentage={usagePercentage} />
                </div>
              ))
            )}
          </div>
        </div>

        {/* Upcoming Planned Expenses */}
        <div className="bg-white dark:bg-slate-900/50 rounded-xl border border-gray-200 dark:border-slate-800 shadow-sm" data-onboarding="upcoming-expenses">
          <div className="p-4 sm:p-6 border-b border-gray-200 dark:border-slate-800">
            <div className="flex items-center justify-between">
              <div>
                <h2 className="text-lg font-semibold text-gray-900 dark:text-white">Upcoming Planned Expenses</h2>
                <p className="text-sm text-gray-500 dark:text-slate-400">Recurring expenses scheduled for the remainder of this month.</p>
              </div>
              <span className="badge badge-info">{upcomingPlannedExpenses.length}</span>
            </div>
          </div>
          {upcomingPlannedExpenses.length === 0 ? (
            <div className="p-4 sm:p-6 text-sm text-gray-500 dark:text-slate-500">No upcoming planned expenses detected.</div>
          ) : (
            <div className="divide-y divide-gray-100 dark:divide-slate-800">
              {upcomingPlannedExpenses.map(({ reminder, account, projectedBalance, status }) => {
                const entry = reminder.entry
                return (
                  <div key={`${entry.id}-${reminder.occurrence.toISOString()}`} className="p-5 flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
                    <div className="flex items-start gap-3">
                      {renderPlannedExpenseIcon(status)}
                      <div>
                        <p className="font-medium text-gray-900 dark:text-white">{entry.name}</p>
                        <p className="text-sm text-gray-500 dark:text-slate-400">
                          {formatDateWithOrdinal(reminder.occurrence)} · {formatCurrency(entry.amount, entry.currency)}
                        </p>
                        <p className="text-xs text-gray-400 dark:text-slate-600">
                          {entry.is_autopay ? 'Autopay enabled' : 'Manual payment required'}
                          {account ? ` · ${account.name}` : ''}
                        </p>
                      </div>
                    </div>
                    <div className="text-right space-y-1 flex-shrink-0">
                      {account && projectedBalance !== null && (
                        <p className={`text-sm font-semibold ${projectedBalance < 0 ? 'text-rose-600 dark:text-rose-400' : 'text-gray-900 dark:text-white'}`}>
                          After: {formatCurrency(projectedBalance, account.currency)}
                        </p>
                      )}
                      <p className="text-xs text-gray-500 dark:text-slate-500">
                        {reminder.daysUntil === 0 ? 'Due today' : `${reminder.daysUntil} day${reminder.daysUntil === 1 ? '' : 's'} remaining`}
                      </p>
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </div>
      </div>

      {/* Top Expenditure Categories */}
      <div className="bg-white dark:bg-slate-900/50 rounded-xl border border-gray-200 dark:border-slate-800 shadow-sm" data-onboarding="top-categories">
        <div className="p-4 sm:p-6 border-b border-gray-200 dark:border-slate-800">
          <div className="flex items-center justify-between">
            <h2 className="text-lg font-semibold text-gray-900 dark:text-white">
              Top Expenditure Categories ({selectedPeriod === 'year' ? 'YTD' : 'Current period'})
            </h2>
            <span className="badge badge-info">{expenditureInsights.length} categories</span>
          </div>
        </div>
        <div className="p-4 sm:p-6">
          {expenditureInsights.length === 0 ? (
            <div className="text-center py-8">
              <div className="w-16 h-16 bg-gray-100 dark:bg-slate-800 rounded-full flex items-center justify-center mx-auto mb-4">
                <svg className="w-8 h-8 text-gray-400 dark:text-slate-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" />
                </svg>
              </div>
              <p className="text-gray-500 dark:text-slate-400 font-medium">No spending recorded yet.</p>
              <p className="text-sm text-gray-400 dark:text-slate-600 mt-1">Record expenses to see category insights.</p>
            </div>
          ) : (
            <div className="grid gap-6 lg:grid-cols-[minmax(0,260px)_minmax(0,1fr)] lg:items-center">
              <div className="flex justify-center">
                <div className="relative h-44 w-44 sm:h-52 sm:w-52 rounded-full border border-gray-200 dark:border-slate-700 shadow-inner" style={expenditureChartStyle}>
                  <div className="absolute inset-0 flex flex-col items-center justify-center gap-1 text-sm">
                    <span className="text-xs uppercase tracking-wide text-gray-500 dark:text-slate-500">Total spend</span>
                    <span className="text-base font-semibold text-gray-900 dark:text-white">{format(totalExpenditureAmount)}</span>
                  </div>
                </div>
              </div>
              <div className="overflow-x-auto">
                <table className="min-w-full divide-y divide-gray-200 dark:divide-slate-800 text-sm">
                  <thead>
                    <tr className="text-left text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-slate-500">
                      <th className="py-2">Category</th>
                      <th className="py-2 text-right">Amount</th>
                      <th className="py-2 text-right">Share</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100 dark:divide-slate-800/50">
                    {expenditureInsights.map((category, index) => (
                      <tr key={category.id} className="hover:bg-gray-50 dark:hover:bg-slate-800/50 transition-colors duration-150">
                        <td className="py-2 pr-4">
                          <div className="flex items-center gap-2">
                            <span className="h-2.5 w-2.5 rounded-full flex-shrink-0" style={{ backgroundColor: category.displayColor }}></span>
                            <span className="font-medium text-gray-900 dark:text-white truncate">
                              #{index + 1}&nbsp;{category.name}
                            </span>
                          </div>
                        </td>
                        <td className="py-2 text-right font-medium text-gray-900 dark:text-white">{format(category.amount)}</td>
                        <td className="py-2 text-right text-gray-500 dark:text-slate-400">{category.percentage.toFixed(1)}%</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

function BudgetUsageBar({ usagePercentage }: { usagePercentage: number }) {
  const clampedUsage = Math.min(Math.max(usagePercentage, 0), 100)
  const remainingColor = clampedUsage >= 100 ? 'bg-gray-200 dark:bg-slate-700' : clampedUsage >= 80 ? 'bg-amber-100 dark:bg-amber-900/30' : 'bg-emerald-100 dark:bg-emerald-900/30'
  const usageColor = clampedUsage >= 100 ? 'bg-rose-700' : clampedUsage >= 80 ? 'bg-rose-500' : 'bg-rose-400'

  return (
    <div className={`relative w-full overflow-hidden h-2 rounded-full transition-colors duration-300 ${remainingColor}`}>
      {clampedUsage > 0 && (
        <div
          className={`absolute right-0 top-0 h-full transition-all duration-300 ${usageColor}`}
          style={{ width: `${clampedUsage}%` }}
        />
      )}
    </div>
  )
}
