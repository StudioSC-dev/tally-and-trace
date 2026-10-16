import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useGetAccountsQuery, useGetCategoriesQuery, useGetBudgetEntriesQuery, useGetAllocationsQuery, useGetDashboardSnapshotQuery, useGetTransactionSummaryQuery, useMaterializeBudgetEntryMutation } from '../store/api'
import type { Allocation } from '../store/api'
import { useState, useEffect, useMemo } from 'react'
import { useAuth } from '../contexts/AuthContext'
import { useCurrency } from '../hooks/useCurrency'
import { formatCurrency, getCurrencySymbol } from '../utils/currency'
import type { CurrencyCode } from '../utils/currency'
import { estimateText, estimateTitle } from '../utils/fx'
import type { EstimateLabels } from '../utils/fx'
import { CurrencyControl } from '../components/CurrencyControl'
import { useSelectedCurrency } from '../hooks/useSelectedCurrency'
import { FxNotice } from '../components/FxNotice'
import { CashflowTimelineCard } from '../components/CashflowTimelineCard'
import { TagFilter } from '../components/TagFilter'
import { apiErrorMessage } from '../utils/apiError'
import { isDetailed, isLimitedEvent, localToday, statusFromDate, upcomingItemAmount } from '@tally-trace/shared'
import type { LimitedEvent, Payable, UpcomingItemOrEvent } from '@tally-trace/shared'

const FALLBACK_CATEGORY_COLORS = ['#2563eb', '#7c3aed', '#16a34a', '#f97316', '#db2777']
const MAX_PAYABLES_SHOWN = 6
const MAX_OTHER_UPCOMING_SHOWN = 4

type ExpenditureInsight = {
  id: string
  name: string
  amount: number
  displayColor: string
  percentage: number
}

export const Route = createFileRoute('/')({
  component: Dashboard,
})

const MS_PER_DAY = 1000 * 60 * 60 * 24

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

/** A backend ISO date or datetime ("2026-10-31", "2026-10-31T00:00:00") as a local calendar day. */
const parseCalendarDay = (iso: string): Date => {
  const [year = 0, month = 1, day = 1] = iso.slice(0, 10).split('-').map(Number)
  return new Date(year, month - 1, day)
}

/** Whole days from today to a calendar day, never below 0. */
const daysUntil = (day: Date): number => {
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  return Math.max(0, Math.round((day.getTime() - today.getTime()) / MS_PER_DAY))
}

/** The "Mark paid" dialog: which figures the API needs for this entry. */
type PayDialogState = {
  entryId: number
  name: string
  /** The row as listed, e.g. "≈ PHP 4,640.00 (USD 80.00)": a hint, never a default value. */
  estimate: string
  needsCharged: boolean
  needsReceived: boolean
  chargedCurrency: CurrencyCode
  receivedCurrency: CurrencyCode
  charged: string
  received: string
  error: string | null
  submitting: boolean
}

type PayableRow = {
  key: string
  name: string
  day: Date
  amount: number
  /** The currency of `amount`. */
  currency: CurrencyCode
  /** The estimate labels: the row was converted from another currency. */
  labels: EstimateLabels
  detail: string
  overdue: boolean
  budgetEntryId: number | null
  /** What kind of payable this is; only scheduled entries have a known autopay state. */
  kind: 'scheduled' | 'statement' | 'loan' | 'shared' | 'planned' | 'pending'
}

const payableRow = (fallback: CurrencyCode) => (payable: Payable | LimitedEvent, index: number): PayableRow => {
  if (isLimitedEvent(payable)) {
    // Face amount, never `cash_delta` (0 for a charge billed on a later statement).
    return {
      key: `${payable.public_id}-${index}`,
      name: payable.display_name,
      day: parseCalendarDay(payable.date),
      amount: payable.face_amount,
      currency: payable.currency,
      labels: {},
      detail: payable.account ? `Shared account · ${payable.account.name}` : 'Shared item',
      overdue: payable.overdue,
      budgetEntryId: null,
      kind: 'shared',
    }
  }
  const pays = payable.account_name ? ` · from ${payable.account_name}` : ''
  const overflow = payable.overflow_account_name ? ` (overflow: ${payable.overflow_account_name})` : ''
  // An unposted transaction is Pending once its day has come and Planned before it.
  const transactionKind = statusFromDate(payable.due_date, false, localToday()) === 'planned' ? 'planned' : 'pending'
  const label = payable.source === 'statement' ? 'Card statement' : payable.source === 'loan' ? 'Loan payment' : payable.source === 'budget_entry' ? 'Scheduled' : transactionKind === 'planned' ? 'Planned' : 'Pending'
  return {
    key: `${payable.source}-${payable.source_id ?? 'x'}-${payable.due_date}-${index}`,
    name: payable.name,
    day: parseCalendarDay(payable.due_date),
    amount: payable.amount,
    currency: payable.currency ?? fallback,
    labels: payable,
    detail: `${label}${pays}${overflow}`,
    overdue: false,
    budgetEntryId: payable.source === 'budget_entry' ? payable.source_id : null,
    kind: payable.source === 'statement' ? 'statement' : payable.source === 'loan' ? 'loan' : payable.source === 'transaction' ? transactionKind : 'scheduled',
  }
}

/**
 * An upcoming item that is not a cash outflow listed in the payables: a Household bill, money
 * coming in, or a full row with no stored rate (it moves no cash and is counted nowhere, so
 * it is listed here in its own currency whichever way it goes).
 */
const isOtherUpcoming = (item: UpcomingItemOrEvent): boolean => {
  if (!isLimitedEvent(item) && item.unconverted === true) return true
  const household = isLimitedEvent(item) ? item.kind === 'household' : item.household_occurrence === true
  return household || upcomingItemAmount(item).direction === 'in'
}

export function Dashboard() {
  const { isAuthenticated, isLoading: authLoading } = useAuth()
  const navigate = useNavigate()
  const { currencyCode: defaultCurrency } = useCurrency()

  useEffect(() => {
    if (!authLoading && !isAuthenticated) {
      navigate({ to: '/login', search: { message: undefined } })
    }
  }, [isAuthenticated, authLoading, navigate])

  const [selectedPeriod, setSelectedPeriod] = useState<'week' | 'month' | 'year'>('month')
  const [selectedTag, setSelectedTag] = useState<number | undefined>(undefined)
  const tagParam = useMemo(() => (selectedTag !== undefined ? { tag: selectedTag } : {}), [selectedTag])
  const [postingId, setPostingId] = useState<number | null>(null)
  const [materializeEntry] = useMaterializeBudgetEntryMutation()
  // The "Mark paid" dialog: open for a payable that needs the figure actually charged.
  const [payDialog, setPayDialog] = useState<PayDialogState | null>(null)

  const handleMarkPaid = async (entryId: number) => {
    setPostingId(entryId)
    try {
      await materializeEntry({ id: entryId }).unwrap()
    } catch (error) {
      console.error('Error posting budget entry:', error)
      alert(apiErrorMessage(error) || 'Could not mark the entry as paid. Please try again.')
    } finally {
      setPostingId(null)
    }
  }

  const handleSubmitPayDialog = async () => {
    if (!payDialog) return
    const charged = payDialog.needsCharged ? parseFloat(payDialog.charged) : undefined
    const received = payDialog.needsReceived ? parseFloat(payDialog.received) : undefined
    if (charged !== undefined && !(charged > 0)) {
      setPayDialog({ ...payDialog, error: `Enter the amount charged in ${payDialog.chargedCurrency}` })
      return
    }
    if (received !== undefined && !(received > 0)) {
      setPayDialog({ ...payDialog, error: `Enter the amount received in ${payDialog.receivedCurrency}` })
      return
    }
    setPayDialog({ ...payDialog, error: null, submitting: true })
    try {
      await materializeEntry({
        id: payDialog.entryId,
        data: {
          ...(charged !== undefined ? { amount: charged } : {}),
          ...(received !== undefined ? { received_amount: received } : {}),
        },
      }).unwrap()
      setPayDialog(null)
    } catch (error) {
      // The API's reason ("Enter the amount charged in PHP", ...) stays in the dialog.
      setPayDialog({ ...payDialog, submitting: false, error: apiErrorMessage(error) || 'Could not mark the entry as paid. Please try again.' })
    }
  }

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

  const { data: snapshot, isLoading: snapshotLoading, error: snapshotError } =
    useGetDashboardSnapshotQuery(tagParam, { skip: !isAuthenticated })
  const { data: periodSummary, isLoading: summaryLoading, error: summaryError } =
    useGetTransactionSummaryQuery({ ...dateRange, ...tagParam }, { skip: !isAuthenticated })
  const { data: categoriesData, isLoading: categoriesLoading, error: categoriesError } =
    useGetCategoriesQuery({ is_active: true }, { skip: !isAuthenticated })
  // Only for "Mark paid": the payables carry no permissions, so the entries the caller may post are looked up here.
  const { data: budgetEntriesData, isLoading: budgetEntriesLoading, error: budgetEntriesError } =
    useGetBudgetEntriesQuery({ is_active: true, limit: 200 }, { skip: !isAuthenticated })
  const { data: allocationsData, isLoading: allocationsLoading, error: allocationsError } =
    useGetAllocationsQuery({ limit: 1000, offset: 0 }, { skip: !isAuthenticated })
  // Only for "Mark paid": the currency of the account an entry pays from and into.
  const { data: accountsData } = useGetAccountsQuery({ limit: 200 }, { skip: !isAuthenticated })

  // The currency every total below is read in: the default one, or the first the user holds.
  const [currency, setCurrency] = useSelectedCurrency(snapshot?.currencies, defaultCurrency)
  const format = (amount: number) => formatCurrency(amount, currency)
  // Budget envelopes are always in the default currency.
  const formatDefault = (amount: number) => formatCurrency(amount, defaultCurrency)

  const postableEntryIds = useMemo(
    () => new Set((budgetEntriesData?.items ?? []).filter(isDetailed).filter((e) => e.permissions.can_post).map((e) => e.id)),
    [budgetEntriesData]
  )
  const autopayEntryIds = useMemo(
    () => new Set((budgetEntriesData?.items ?? []).filter(isDetailed).filter((e) => e.is_autopay).map((e) => e.id)),
    [budgetEntriesData]
  )
  const allocations = useMemo(() => allocationsData?.items ?? [], [allocationsData])
  const budgetAllocations = useMemo(
    () => allocations.filter((a) => a.allocation_type === 'budget' && a.is_active),
    [allocations]
  )

  // The backend's projection: month 0 runs from today to the 1st of next month, opening at available cash.
  // The scalars are the default currency only, so every figure is read from the selected currency's row.
  const nextPeriod = snapshot?.forecast_next_3_months[0]
  const nextPeriodRow = nextPeriod?.by_currency.find((r) => r.currency === currency)
  const closings = snapshot?.account_closings[0]?.by_currency.find((r) => r.currency === currency)
  const balanceRow = snapshot?.balances.by_currency.find((r) => r.currency === currency)
  const summaryRow = periodSummary?.by_currency.find((r) => r.currency === currency)
  const periodCategories = useMemo(() => summaryRow?.category_breakdown ?? {}, [summaryRow])
  const payableRows = useMemo(() => (snapshot?.payables ?? []).map(payableRow(defaultCurrency)), [snapshot, defaultCurrency])
  const accountCurrencies = useMemo(
    () => new Map((accountsData?.items ?? []).map((a) => [a.id, a.currency as CurrencyCode])),
    [accountsData]
  )
  const entriesById = useMemo(
    () => new Map((budgetEntriesData?.items ?? []).filter(isDetailed).map((e) => [e.id, e])),
    [budgetEntriesData]
  )

  // "Mark paid" posts at once, unless the entry is in another currency than the account it pays
  // from (or moves money into another currency): then the figure actually charged is needed.
  const startMarkPaid = (row: PayableRow) => {
    if (row.budgetEntryId === null) return
    const entry = entriesById.get(row.budgetEntryId)
    const sourceCurrency = entry?.account_id !== undefined ? accountCurrencies.get(entry.account_id) : undefined
    const destinationCurrency = entry?.transfer_to_account_id != null ? accountCurrencies.get(entry.transfer_to_account_id) : undefined
    const chargedCurrency = sourceCurrency ?? row.currency
    const needsCharged = entry !== undefined && sourceCurrency !== undefined ? entry.currency !== sourceCurrency : row.labels.estimated === true
    const needsReceived = destinationCurrency !== undefined && destinationCurrency !== chargedCurrency
    if (!needsCharged && !needsReceived) {
      void handleMarkPaid(row.budgetEntryId)
      return
    }
    setPayDialog({
      entryId: row.budgetEntryId,
      name: row.name,
      estimate: estimateText(row.amount, row.currency, row.labels),
      needsCharged,
      needsReceived,
      chargedCurrency,
      receivedCurrency: destinationCurrency ?? chargedCurrency,
      charged: '',
      received: '',
      error: null,
      submitting: false,
    })
  }
  const otherUpcoming = useMemo(() => (snapshot?.upcoming_this_month ?? []).filter(isOtherUpcoming), [snapshot])

  const periodIncome = summaryRow?.total_income ?? 0
  const periodExpenses = summaryRow?.total_expenses ?? 0
  const periodNet = summaryRow?.net_flow ?? 0
  const periodHeadingLabel = selectedPeriod === 'year' ? 'Year to Date' : selectedPeriod === 'month' ? 'Month to Date' : 'Week to Date'
  const periodTag = selectedPeriod === 'year' ? 'YTD' : selectedPeriod === 'month' ? 'MTD' : 'WTD'
  // period_end is exclusive (the 1st of next month); step back a calendar day, immune to DST.
  const projectionEnd = (() => {
    if (!nextPeriod) return null
    const end = parseCalendarDay(nextPeriod.period_end)
    return new Date(end.getFullYear(), end.getMonth(), end.getDate() - 1)
  })()

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

  type PayableStatus = 'danger' | 'autopay' | 'manual' | 'statement' | 'loan' | 'shared' | 'planned' | 'pending'
  const STATUS_LABELS: Record<PayableStatus, string> = {
    danger: 'Overdue',
    autopay: 'Autopay',
    manual: 'Pay manually',
    statement: 'Statement',
    loan: 'Loan payment',
    shared: 'Shared item',
    planned: 'Planned',
    pending: 'Pending',
  }

  const renderPlannedExpenseIcon = (status: PayableStatus) => {
    const label = STATUS_LABELS[status]
    if (status === 'danger') {
      return (
        <span role="img" aria-label={label} title={label} data-testid="payable-status" className="inline-flex h-8 w-8 items-center justify-center rounded-full border border-danger text-danger">
          <svg aria-hidden="true" className="h-4 w-4" viewBox="0 0 20 20" fill="currentColor">
            <polygon points="10,1 18,6 18,14 10,19 2,14 2,6" />
            <rect x="9" y="7" width="2" height="5" fill="white" rx="1" />
            <rect x="9" y="13" width="2" height="2" fill="white" rx="1" />
          </svg>
        </span>
      )
    }
    if (status === 'autopay') {
      return (
        <span role="img" aria-label={label} title={label} data-testid="payable-status" className="inline-flex h-8 w-8 items-center justify-center rounded-full bg-ok text-paper">
          <svg aria-hidden="true" className="h-4 w-4" viewBox="0 0 20 20" fill="currentColor">
            <path fillRule="evenodd" d="M16.704 5.29a1 1 0 00-1.408-1.42l-6.32 6.263-2.272-2.26a1 1 0 10-1.408 1.419l2.976 2.958a1 1 0 001.408 0l7.024-6.96z" clipRule="evenodd" />
          </svg>
        </span>
      )
    }
    if (status === 'manual') {
      return (
        <span role="img" aria-label={label} title={label} data-testid="payable-status" className="inline-flex h-8 w-8 items-center justify-center rounded-full text-warn">
          <svg aria-hidden="true" className="h-4 w-4" viewBox="0 0 20 20" fill="currentColor">
            <path d="M10.894 2.553c-.346-.598-1.442-.598-1.788 0l-7 12.092c-.339.586.086 1.355.894 1.355h14c.808 0 1.233-.769.894-1.355l-7-12.092z" />
            <path d="M9 13h2v2H9v-2zm0-6h2v5H9V7z" fill="white" />
          </svg>
        </span>
      )
    }
    // Statements, loan payments, planned transactions and shared items: no autopay state is known, so a neutral mark, not the manual warning.
    return (
      <span role="img" aria-label={label} title={label} data-testid="payable-status" className="inline-flex h-8 w-8 items-center justify-center rounded-full border border-line text-muted">
        <svg aria-hidden="true" className="h-4 w-4" viewBox="0 0 20 20" fill="currentColor">
          <path d="M10 2a8 8 0 100 16 8 8 0 000-16zm1 12H9V9h2v5zm0-6H9V6h2v2z" />
        </svg>
      </span>
    )
  }

  // Shares are of the rows listed: the ring and table list spending-wallet debits that the period expenses figure nets out.
  const listedTotal = useMemo(
    () => Object.values(periodCategories).reduce((sum, row) => sum + Math.max(row.expenses, 0), 0),
    [periodCategories],
  )

  // The wallet-aware backend summary names categories; the chart colours them from the caller's own.
  const expenditureInsights = useMemo<ExpenditureInsight[]>(() => {
    if (!periodSummary) return []
    const categories = categoriesData ?? []
    const positive = Object.entries(periodCategories).filter(([, row]) => row.expenses > 0)
    if (listedTotal <= 0) return []
    return positive
      .sort(([, a], [, b]) => b.expenses - a.expenses)
      .slice(0, 5)
      .map(([name, row], index) => {
        const color = categories.find((cat) => cat.name === name)?.color?.trim()
        return {
          id: name,
          name,
          amount: row.expenses,
          displayColor: color || FALLBACK_CATEGORY_COLORS[index % FALLBACK_CATEGORY_COLORS.length] || '#6B7280',
          percentage: (row.expenses / listedTotal) * 100,
        }
      })
  }, [periodSummary, periodCategories, categoriesData, listedTotal])

  const expenditureChartStyle = useMemo(() => {
    if (expenditureInsights.length === 0) return { backgroundImage: 'conic-gradient(#334155 0% 100%)' }
    let cumulative = 0
    const segments = expenditureInsights.map((item) => {
      const start = cumulative
      cumulative += item.percentage
      return `${item.displayColor} ${start}% ${Math.min(cumulative, 100)}%`
    })
    // Whatever the top five leave out is drawn neutral so the ring still adds up to the listed spend.
    if (cumulative < 100) segments.push(`#334155 ${cumulative}% 100%`)
    return { backgroundImage: `conic-gradient(${segments.join(', ')})` }
  }, [expenditureInsights])

  const allLoading = snapshotLoading && summaryLoading && categoriesLoading && budgetEntriesLoading && allocationsLoading

  if (authLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-paper">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-ink"></div>
      </div>
    )
  }

  if (!isAuthenticated) return null

  if (snapshotError) console.error('Snapshot error:', snapshotError)
  if (summaryError) console.error('Summary error:', summaryError)
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
          <p className="text-body font-medium">Loading your financial data...</p>
        </div>
      </div>
    )
  }

  if (snapshotError || summaryError || categoriesError || budgetEntriesError || allocationsError) {
    return (
      <div className="flex items-center justify-center min-h-96">
        <div className="text-center">
          <div className="w-16 h-16 rounded-full flex items-center justify-center mx-auto mb-4">
            <svg className="w-8 h-8 text-danger" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.964-.833-2.732 0L3.732 16.5c-.77.833.192 2.5 1.732 2.5z" />
            </svg>
          </div>
          <h3 className="text-lg font-semibold text-ink mb-2">Error Loading Data</h3>
          <p className="text-body mb-4">There was an issue loading your financial data.</p>
          <div className="text-sm text-muted space-y-1">
            {snapshotError && <p>• Balances and projection: {getErrorDetail(snapshotError) ?? 'Failed to load'}</p>}
            {summaryError && <p>• Period totals: {getErrorDetail(summaryError) ?? 'Failed to load'}</p>}
            {categoriesError && <p>• Categories: {getErrorDetail(categoriesError) ?? 'Failed to load'}</p>}
            {budgetEntriesError && <p>• Schedules: {getErrorDetail(budgetEntriesError) ?? 'Failed to load'}</p>}
            {allocationsError && <p>• Budgets: {getErrorDetail(allocationsError) ?? 'Failed to load'}</p>}
          </div>
          <button
            onClick={() => window.location.reload()}
            className="mt-4 px-4 py-2 bg-ink text-paper hover:bg-ink transition-colors duration-200"
          >
            Retry
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="max-w-7xl mx-auto px-3 sm:px-4 lg:px-6 py-8 space-y-8">
      {/* Header */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold text-ink">Dashboard</h1>
          <p className="text-sm text-muted mt-1">Your financial overview</p>
        </div>
        <TagFilter value={selectedTag} onChange={setSelectedTag} />
        <CurrencyControl currencies={snapshot?.currencies} value={currency} onChange={setCurrency} />
        <div className="flex flex-col gap-1">
          <div className="flex space-x-1 bg-sunken p-1" role="group" aria-label="Period for actual totals">
            {(['week', 'month', 'year'] as const).map((period) => (
              <button
                key={period}
                aria-pressed={selectedPeriod === period}
                onClick={() => setSelectedPeriod(period)}
                className={`px-4 py-1.5 text-sm font-medium transition-colors duration-200 capitalize ${ selectedPeriod === period ? 'bg-surface text-ink' : 'text-body hover:text-ink' }`}
              >
                {period}
              </button>
            ))}
          </div>
          <p className="text-xs text-muted" data-testid="period-note">Period applies to actuals (totals and categories), not the projection.</p>
        </div>
      </div>

      <FxNotice fx={snapshot?.fx} />

      {/* Cash-Flow Timeline (pre-due-date solvency) */}
      <CashflowTimelineCard tag={selectedTag} currency={currency} />

      {/* Financial Snapshot */}
      <div className="bg-surface border border-line" data-onboarding="financial-snapshot">
        <div className="p-4 sm:p-6 border-b border-line">
          <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
            <div>
              <h2 className="text-lg font-semibold text-ink">Financial Snapshot</h2>
              <p className="text-sm text-muted">
                {`Actuals cover ${selectedPeriod === 'year' ? 'year to date' : selectedPeriod === 'month' ? 'month to date' : 'week to date'}; the projection runs from today to month end.`}
              </p>
            </div>
            <span className="badge badge-info capitalize">{periodHeadingLabel}</span>
          </div>
        </div>
        <div className="p-4 sm:p-6 grid gap-6 lg:grid-cols-2">
          <div className="space-y-4">
            <h3 className="text-xs font-semibold text-muted uppercase tracking-wide">
              Actual Totals ({periodHeadingLabel})
            </h3>
            <dl className="space-y-3" data-testid="actual-totals">
              {[
                { id: 'income', label: `Total income (${periodTag})`, value: format(periodIncome), color: 'text-ok' },
                { id: 'expenses', label: `Total expenses (${periodTag})`, value: format(periodExpenses), color: 'text-danger' },
                { id: 'net-flow', label: `Net flow (${periodTag})`, value: format(periodNet), color: periodNet >= 0 ? 'text-ok' : 'text-danger' },
              ].map(({ id, label, value, color }) => (
                <div key={id} className="flex items-center justify-between">
                  <dt className="text-sm text-muted">{label}</dt>
                  <dd className={`text-base font-semibold ${color}`} data-testid={`period-${id}`}>{value}</dd>
                </div>
              ))}
            </dl>
            <div className="border-t border-line pt-3">
              <h4 className="text-xs font-semibold text-muted uppercase tracking-wide mb-2">Today</h4>
              <dl>
                <div className="flex items-center justify-between">
                  <dt className="text-sm text-muted">Net worth</dt>
                  <dd className="text-base font-semibold text-ink" data-testid="net-worth">{format(balanceRow?.total ?? 0)}</dd>
                </div>
              </dl>
              <p className="mt-1 text-xs text-muted">
                All your accounts, shared and Household accounts, cards and loans included. Not the same as available cash.
              </p>
            </div>
          </div>
          <div className="space-y-4">
            <h3 className="text-xs font-semibold text-muted uppercase tracking-wide">
              Projected{projectionEnd ? ` to ${formatDateWithOrdinal(projectionEnd)}` : ''}
            </h3>
            <dl className="space-y-3" data-testid="projection">
              {[
                { id: 'available-cash', label: 'Available cash', value: format(balanceRow?.available_cash ?? 0), color: 'text-ink' },
                ...(nextPeriodRow ? [
                  { id: 'projected-income', label: 'Projected recurring income (rest of month)', value: format(nextPeriodRow.income), color: 'text-ok' },
                  { id: 'projected-net-flow', label: 'Projected net flow (today to month end)', value: format(nextPeriodRow.net), color: nextPeriodRow.net >= 0 ? 'text-ok' : 'text-danger' },
                  { id: 'projected-balance', label: 'Projected month-end cash', value: format(nextPeriodRow.closing_balance), color: nextPeriodRow.closing_balance >= 0 ? 'text-ink' : 'text-danger' },
                ] : []),
              ].map(({ id, label, value, color }) => (
                <div key={id} className="flex items-center justify-between">
                  <dt className="text-sm text-muted">{label}</dt>
                  <dd className={`text-base font-semibold ${color}`} data-testid={id}>{value}</dd>
                </div>
              ))}
            </dl>
            <p className="text-xs text-muted">
              Available cash includes shared and Household accounts you can see; cards, loans and spending wallets are left out. Projected month-end cash is available cash plus the rest of this month's planned flows.
              {selectedTag !== undefined ? ' With a tag filter, only tagged events move the projection; balances stay whole.' : ''}
            </p>
            {closings && (closings.by_account.length > 0 || closings.unassigned_closing !== 0) && (
              <div data-testid="account-closings">
                <h4 className="text-xs font-semibold text-muted uppercase tracking-wide mb-2">Closing balance by account</h4>
                <dl className="space-y-2">
                  {closings.by_account.map((closing) => (
                    <div key={closing.account_id} className="flex items-center justify-between">
                      <dt className="text-sm text-muted">{closing.account_name ?? `Account ${closing.account_id}`}</dt>
                      <dd className="text-sm font-medium text-ink" data-testid={`closing-${closing.account_id}`}>{format(closing.closing_balance)}</dd>
                    </div>
                  ))}
                  {closings.unassigned_closing !== 0 && (
                    <div className="flex items-center justify-between">
                      <dt className="text-sm text-muted">Unassigned</dt>
                      <dd className="text-sm font-medium text-ink" data-testid="closing-unassigned">{format(closings.unassigned_closing)}</dd>
                    </div>
                  )}
                </dl>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Two column grid */}
      <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
        {/* Budget Envelopes */}
        <div className="bg-surface border border-line" data-onboarding="budget-envelopes">
          <div className="p-4 sm:p-6 border-b border-line">
            <div className="flex items-center justify-between">
              <div>
                <h2 className="text-lg font-semibold text-ink">Budget Envelope Status</h2>
                <p className="text-sm text-muted">Current month spending against your envelope limits.</p>
              </div>
              <span className="badge badge-info">{budgetEnvelopeSummaries.length}</span>
            </div>
          </div>
          <div className="p-4 sm:p-6 space-y-5">
            {budgetEnvelopeSummaries.length === 0 ? (
              <p className="text-sm text-muted">No active budget envelopes yet.</p>
            ) : (
              budgetEnvelopeSummaries.map(({ allocation, limit, spent, remaining, usagePercentage }) => (
                <div key={allocation.id} className="space-y-3">
                  <div className="flex items-start justify-between gap-4">
                    <div>
                      <p className="font-medium text-ink">{allocation.name}</p>
                      {allocation.description && (
                        <p className="text-xs text-muted">{allocation.description}</p>
                      )}
                    </div>
                    <div className="text-right flex-shrink-0">
                      <p className="text-sm font-semibold text-ink">Remaining {formatDefault(remaining)}</p>
                      <p className="text-xs text-muted">Limit {formatDefault(limit)} · Spent {formatDefault(spent)}</p>
                    </div>
                  </div>
                  <BudgetUsageBar usagePercentage={usagePercentage} />
                </div>
              ))
            )}
          </div>
        </div>

        {/* Upcoming payables */}
        <div className="bg-surface border border-line" data-onboarding="upcoming-expenses">
          <div className="p-4 sm:p-6 border-b border-line">
            <div className="flex items-center justify-between">
              <div>
                <h2 className="text-lg font-semibold text-ink">Upcoming Payables</h2>
                <p className="text-sm text-muted">Cash going out in the next 30 days: bills, card statements and loan payments.</p>
              </div>
              <span className="badge badge-info" data-testid="payables-count">{payableRows.length}</span>
            </div>
          </div>
          {payableRows.length === 0 ? (
            <div className="p-4 sm:p-6 text-sm text-muted">No upcoming payables in the next 30 days.</div>
          ) : (
            <div className="divide-y divide-line" data-testid="payables">
              {payableRows.slice(0, MAX_PAYABLES_SHOWN).map((row) => {
                const status: PayableStatus = row.overdue ? 'danger' : row.kind !== 'scheduled' ? row.kind : row.budgetEntryId !== null && autopayEntryIds.has(row.budgetEntryId) ? 'autopay' : 'manual'
                const remaining = daysUntil(row.day)
                return (
                  <div key={row.key} className="p-5 flex flex-col gap-3 md:flex-row md:items-center md:justify-between" data-testid="payable-row">
                    <div className="flex items-start gap-3">
                      {renderPlannedExpenseIcon(status)}
                      <div>
                        <p className="font-medium text-ink">{row.name}</p>
                        <p className="text-sm text-muted">
                          {formatDateWithOrdinal(row.day)} · <span data-testid="payable-amount" title={estimateTitle(row.labels)}>{estimateText(row.amount, row.currency, row.labels)}</span>
                        </p>
                        <p className="text-xs text-muted">{row.detail}</p>
                      </div>
                    </div>
                    <div className="text-right space-y-1 flex-shrink-0">
                      <p className="text-xs text-muted">
                        {row.overdue ? 'Overdue' : remaining === 0 ? 'Due today' : `${remaining} day${remaining === 1 ? '' : 's'} remaining`}
                      </p>
                      {row.budgetEntryId !== null && postableEntryIds.has(row.budgetEntryId) && (
                        <button
                          onClick={() => startMarkPaid(row)}
                          disabled={postingId === row.budgetEntryId}
                          className="mt-1 inline-flex items-center gap-1 bg-ok px-2.5 py-1 text-xs font-semibold text-paper hover:bg-ok disabled:opacity-50 transition-colors"
                        >
                          {postingId === row.budgetEntryId ? 'Posting…' : 'Mark paid'}
                        </button>
                      )}
                    </div>
                  </div>
                )
              })}
              {payableRows.length > MAX_PAYABLES_SHOWN && (
                <p className="p-4 text-xs text-muted">+{payableRows.length - MAX_PAYABLES_SHOWN} more in the next 30 days</p>
              )}
            </div>
          )}
          {otherUpcoming.length > 0 && (
            <div className="border-t border-line p-4 sm:p-6 space-y-3" data-testid="other-upcoming">
              <h3 className="text-xs font-semibold text-muted uppercase tracking-wide">Also coming up</h3>
              {otherUpcoming.slice(0, MAX_OTHER_UPCOMING_SHOWN).map((item, index) => {
                // The face amount, never a limited event's `cash_delta` (0 for a Household bill).
                const { amount, direction } = upcomingItemAmount(item)
                // Each item reads in its own currency. A full one may be an estimate, or have no rate (no figure).
                const itemCurrency = item.currency ?? defaultCurrency
                const itemLabels: EstimateLabels = isLimitedEvent(item) ? {} : item
                const amountText = isLimitedEvent(item)
                  ? formatCurrency(amount, itemCurrency)
                  : estimateText(item.unconverted ? null : amount, itemCurrency, itemLabels)
                const name = isLimitedEvent(item) ? item.display_name : item.name
                const day = parseCalendarDay(isLimitedEvent(item) ? item.date : item.due_date)
                const household = isLimitedEvent(item) ? item.kind === 'household' : item.household_occurrence === true
                const note = household ? 'Household bill, not paid from your cash' : direction === 'in' ? 'Money in' : ''
                return (
                  <div key={`${name}-${index}`} className="flex items-start justify-between gap-3" data-testid="other-upcoming-row">
                    <div>
                      <p className="text-sm font-medium text-ink">{name}</p>
                      <p className="text-xs text-muted">{formatDateWithOrdinal(day)}{note ? ` · ${note}` : ''}</p>
                    </div>
                    <p className="text-sm font-semibold text-ink flex-shrink-0" data-testid="other-upcoming-amount" title={estimateTitle(itemLabels)}>{amountText}</p>
                  </div>
                )
              })}
              {otherUpcoming.length > MAX_OTHER_UPCOMING_SHOWN && (
                <p className="text-xs text-muted">+{otherUpcoming.length - MAX_OTHER_UPCOMING_SHOWN} more</p>
              )}
            </div>
          )}
        </div>
      </div>

      {payDialog && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" data-testid="pay-dialog-overlay">
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="pay-dialog-title"
            className="w-full max-w-md bg-surface border border-line p-5 sm:p-6 space-y-4"
            onKeyDown={(e) => { if (e.key === 'Escape') setPayDialog(null) }}
          >
            <div>
              <h2 id="pay-dialog-title" className="text-lg font-semibold text-ink">Mark {payDialog.name} as paid</h2>
              <p className="mt-1 text-sm text-muted" data-testid="pay-dialog-estimate">
                Listed as {payDialog.estimate}. Enter what was actually {payDialog.needsCharged ? 'charged' : 'moved'}; the estimate is only a guide.
              </p>
            </div>
            {payDialog.needsCharged && (
              <div>
                <label className="label" htmlFor="pay-charged">Amount charged ({payDialog.chargedCurrency})</label>
                <div className="relative">
                  <span className="absolute inset-y-0 left-0 pl-3 flex items-center text-muted text-sm">{getCurrencySymbol(payDialog.chargedCurrency)}</span>
                  <input
                    id="pay-charged"
                    type="number"
                    step="0.01"
                    min="0"
                    autoFocus
                    value={payDialog.charged}
                    onChange={(e) => setPayDialog({ ...payDialog, charged: e.target.value, error: null })}
                    className="input-field pl-7 focus-ring"
                    placeholder="0.00"
                  />
                </div>
              </div>
            )}
            {payDialog.needsReceived && (
              <div>
                <label className="label" htmlFor="pay-received">Amount received ({payDialog.receivedCurrency})</label>
                <div className="relative">
                  <span className="absolute inset-y-0 left-0 pl-3 flex items-center text-muted text-sm">{getCurrencySymbol(payDialog.receivedCurrency)}</span>
                  <input
                    id="pay-received"
                    type="number"
                    step="0.01"
                    min="0"
                    autoFocus={!payDialog.needsCharged}
                    value={payDialog.received}
                    onChange={(e) => setPayDialog({ ...payDialog, received: e.target.value, error: null })}
                    className="input-field pl-7 focus-ring"
                    placeholder="0.00"
                  />
                </div>
              </div>
            )}
            {payDialog.error && <p className="text-sm text-danger" role="alert" data-testid="pay-dialog-error">{payDialog.error}</p>}
            <div className="flex flex-wrap gap-2">
              <button type="button" onClick={handleSubmitPayDialog} disabled={payDialog.submitting} className="btn-primary focus-ring disabled:opacity-50">
                {payDialog.submitting ? 'Posting…' : 'Mark paid'}
              </button>
              <button type="button" onClick={() => setPayDialog(null)} className="btn-secondary focus-ring">Cancel</button>
            </div>
          </div>
        </div>
      )}

      {/* Top Expenditure Categories */}
      <div className="bg-surface border border-line" data-onboarding="top-categories">
        <div className="p-4 sm:p-6 border-b border-line">
          <div className="flex items-center justify-between">
            <h2 className="text-lg font-semibold text-ink">
              Top Expenditure Categories ({periodTag})
            </h2>
            <span className="badge badge-info">{expenditureInsights.length} categories</span>
          </div>
        </div>
        <div className="p-4 sm:p-6">
          {expenditureInsights.length === 0 ? (
            <div className="text-center py-8">
              <div className="w-16 h-16 bg-sunken rounded-full flex items-center justify-center mx-auto mb-4">
                <svg className="w-8 h-8 text-muted" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" />
                </svg>
              </div>
              <p className="text-muted font-medium">No spending recorded yet.</p>
              <p className="text-sm text-muted mt-1">Record expenses to see category insights.</p>
            </div>
          ) : (
            <div className="grid gap-6 lg:grid-cols-[minmax(0,260px)_minmax(0,1fr)] lg:items-center">
              <div className="flex justify-center">
                <div className="relative h-44 w-44 sm:h-52 sm:w-52 rounded-full border border-line shadow-inner" style={expenditureChartStyle}>
                  <div className="absolute inset-0 flex flex-col items-center justify-center gap-1 text-sm">
                    <span className="text-xs uppercase tracking-wide text-muted">Spend by category</span>
                    <span className="text-base font-semibold text-ink">{format(listedTotal)}</span>
                  </div>
                </div>
              </div>
              <div className="overflow-x-auto">
                <p className="mb-2 text-xs text-muted" data-testid="category-note">Includes spending from wallets; may differ from period expenses, which net wallet top-ups and returns.</p>
                <table className="min-w-full divide-y divide-line text-sm">
                  <thead>
                    <tr className="text-left text-xs font-semibold uppercase tracking-wide text-muted">
                      <th className="py-2">Category</th>
                      <th className="py-2 text-right">Amount</th>
                      <th className="py-2 text-right">Share</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-line/50">
                    {expenditureInsights.map((category, index) => (
                      <tr key={category.id} className="hover:bg-sunken/50 transition-colors duration-150">
                        <td className="py-2 pr-4">
                          <div className="flex items-center gap-2">
                            <span className="h-2.5 w-2.5 rounded-full flex-shrink-0" style={{ backgroundColor: category.displayColor }}></span>
                            <span className="font-medium text-ink truncate">
                              #{index + 1}&nbsp;{category.name}
                            </span>
                          </div>
                        </td>
                        <td className="py-2 text-right font-medium text-ink">{format(category.amount)}</td>
                        <td className="py-2 text-right text-muted">{category.percentage.toFixed(1)}%</td>
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
  const remainingColor = clampedUsage >= 100 ? 'bg-sunken' : clampedUsage >= 80 ? '' : ' '
  const usageColor = clampedUsage >= 100 ? 'bg-danger' : clampedUsage >= 80 ? 'bg-danger' : 'bg-danger'

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
