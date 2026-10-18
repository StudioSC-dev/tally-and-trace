import { createFileRoute, useCanGoBack, useNavigate, useRouter } from '@tanstack/react-router'
import { useLazyGetTransactionsQuery, useGetAccountsQuery, useLazyGetAccountQuery, useGetCategoriesQuery, useGetBudgetEntriesQuery, useGetTransactionQuery, useCreateTransactionMutation, useUpdateTransactionMutation, useDeleteTransactionMutation, useFetchReceiptMutation } from '../store/api'
import { useState, useEffect, useMemo, useRef, useCallback } from 'react'
import type {
  Account,
  Transaction,
  FullBudgetEntry,
  FullTransaction,
  RecordPermissions,
  SharedFullTransaction,
} from '../store/api'
import { editFormProjectedAmount, formatEntryDate, isLimited, isOwnerFull, isSharedFull, listBounds, localToday, pageWindow, relativeEntryDay, toTotal, transactionDate, transactionDescription, transactionStatus, transferAccountFields } from '@tally-trace/shared'
import type { ListRange, TransactionStatus } from '@tally-trace/shared'
import { apiErrorMessage } from '../utils/apiError'
import { useLatestRef, useRequestGeneration } from '../hooks/useRequestGeneration'
import { useToday } from '../hooks/useToday'
import { useAuth } from '../contexts/AuthContext'
import { currentSessionGeneration } from '../store/baseQuery'
import { formatCurrency, getCurrencySymbol, CurrencyCode, CURRENCY_CONFIGS } from '../utils/currency'
import { SpendingBreakdownDialog } from '../components/SpendingBreakdownDialog'
import { TagChips } from '../components/TagChips'
import { TagFilter } from '../components/TagFilter'
import { TagPicker } from '../components/TagPicker'
import { tagIdsIfChanged, tagIdsOf } from '../utils/tags'
import { keepsRetainedActual } from '../utils/retainedActual'

const TRANSACTION_TYPE_LABELS: Record<Transaction['transaction_type'], string> = {
  credit: 'Income',
  debit: 'Expense',
  transfer: 'Transfer',
}

type CategoryKind = 'income' | 'expense' | 'transfer'

// Each transaction type has a natural category kind: income for credit,
// expense for debit, and transfer (savings/investment contributions, card
// payments) for transfer. The picker only offers categories that match.
const TYPE_TO_KIND: Record<Transaction['transaction_type'], CategoryKind> = {
  credit: 'income',
  debit: 'expense',
  transfer: 'transfer',
}

// Tolerate categories created before `kind` existed by falling back to is_expense.
const categoryKind = (category: { kind?: CategoryKind; is_expense?: boolean }): CategoryKind =>
  category.kind ?? (category.is_expense === false ? 'income' : 'expense')

// The API takes at most this many category names per request.
const MAX_CATEGORY_NAMES = 50

const RECURRENCE_LABELS: Record<string, string> = {
  daily: 'Daily',
  weekly: 'Weekly',
  monthly: 'Monthly',
  quarterly: 'Quarterly',
  semi_annual: 'Semi-Annual',
  annual: 'Annual',
}

const getOrdinalSuffix = (day: number) => {
  if (day % 100 >= 11 && day % 100 <= 13) {
    return 'th'
  }
  switch (day % 10) {
    case 1:
      return 'st'
    case 2:
      return 'nd'
    case 3:
      return 'rd'
    default:
      return 'th'
  }
}

const formatDateWithOrdinal = (date: Date) => {
  if (Number.isNaN(date.getTime())) {
    return 'Invalid date'
  }
  const month = new Intl.DateTimeFormat('en-US', { month: 'short' }).format(date)
  const day = date.getDate()
  const year = date.getFullYear()
  return `${month} ${day}${getOrdinalSuffix(day)}, ${year}`
}

const formatRelativeDate = (dateString: string) => {
  const date = new Date(dateString)
  if (Number.isNaN(date.getTime())) {
    return 'Unknown date'
  }
  const today = new Date()
  const startOfToday = new Date(today.getFullYear(), today.getMonth(), today.getDate())
  const startOfDate = new Date(date.getFullYear(), date.getMonth(), date.getDate())
  const diffInMs = startOfToday.getTime() - startOfDate.getTime()
  const diffInDays = Math.round(diffInMs / (1000 * 60 * 60 * 24))

  if (diffInDays === 0) {
    return 'Today'
  }
  if (diffInDays === 1) {
    return 'Yesterday'
  }
  if (diffInDays === -1) {
    return 'Tomorrow'
  }

  return formatDateWithOrdinal(date)
}

// An unposted row is Pending once its day has come and Planned before; see `transactionStatus`.
const STATUS_LABELS: Record<TransactionStatus, string> = { posted: 'Posted', pending: 'Pending', planned: 'Planned' }
const STATUS_BADGE_CLASSES: Record<TransactionStatus, string> = {
  posted: 'text-ink',
  pending: 'bg-sunken text-warn',
  planned: 'bg-sunken text-body',
}
const STATUS_TEXT_CLASSES: Record<TransactionStatus, string> = { posted: 'text-ok', pending: 'text-warn', planned: 'text-muted' }

const PAGE_SIZES = [25, 50, 100] as const
type PageSize = (typeof PAGE_SIZES)[number]
const PAGE_SIZE_STORAGE_KEY = 'transactions.pageSize'
const SEARCH_DEBOUNCE_MS = 450
// One request's worth of Upcoming rows; the API allows up to 1000 per request.
const UPCOMING_LIMIT = 100

const readStoredPageSize = (): PageSize => {
  try {
    const stored = Number(localStorage.getItem(PAGE_SIZE_STORAGE_KEY))
    return PAGE_SIZES.find((size) => size === stored) ?? PAGE_SIZES[0]
  } catch {
    return PAGE_SIZES[0]
  }
}

type TransactionQuery = {
  account_ids?: number[]
  category_names?: string[]
  entered_by?: 'me'
  transaction_types?: string[]
  start_date?: string
  end_date?: string
  search?: string
  tag?: number
  limit?: number
  offset?: number
}

/** A list range as the API's date filters; an open end sends nothing. */
const rangeParams = (range: ListRange): TransactionQuery => ({
  ...(range.start !== undefined ? { start_date: range.start } : {}),
  ...(range.end !== undefined ? { end_date: range.end } : {}),
})

/** Page numbers to show, with 0 standing for a gap: 1 … 4 5 6 … 12. */
const pageItems = (pages: number, page: number): number[] => {
  const wanted = new Set([1, pages, page - 1, page, page + 1])
  const shown = [...wanted].filter((value) => value >= 1 && value <= pages).sort((a, b) => a - b)
  const items: number[] = []
  shown.forEach((value, index) => {
    const previous = shown[index - 1]
    if (previous !== undefined && value - previous > 1) {
      items.push(0)
    }
    items.push(value)
  })
  return items
}

const getMonthStart = (date: Date) => new Date(date.getFullYear(), date.getMonth(), 1)

const getMonthEnd = (date: Date) => new Date(date.getFullYear(), date.getMonth() + 1, 0)

const isSameMonth = (a: Date, b: Date) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth()

// A loan payment stores its principal as the amount and its interest as the fee;
// the form and the posting flow work with the whole payment, in whole cents.
const toPrincipal = (total: number, interest?: number | null) =>
  Math.round((total - (interest ?? 0)) * 100) / 100

// A transaction the caller sees in full or shared-full (never Limited): the only
// shapes that carry the fields an edit form, a posting or a loan check reads.
type DetailedTransaction = FullTransaction | SharedFullTransaction

// Whether the stored row is already a transfer into the account (an edit of it
// is never split by the server, see routers/transactions.py).
const paysLoan = (transaction: DetailedTransaction | null, accountId: number | undefined) =>
  transaction !== null &&
  accountId !== undefined &&
  transaction.transaction_type === 'transfer' &&
  transaction.transfer_to_account_id === accountId

// Whether a row is a loan payment: `loan` / `not_loan`, `pending` while its
// destination is being looked up, `unavailable` when that lookup found nothing.
type LoanPaymentStatus = 'loan' | 'not_loan' | 'pending' | 'unavailable'

const NO_PERMISSIONS: RecordPermissions = {
  can_edit: false,
  can_delete: false,
  can_post: false,
  can_revert: false,
  can_tag: false,
}

const DESTINATION_UNAVAILABLE =
  "This transfer's destination account can't be found, so it is read-only here."

const formatMonthYear = (date: Date) =>
  date.toLocaleDateString(undefined, { month: 'long', year: 'numeric' })

const formatDateInput = (date: Date) => {
  const year = date.getFullYear()
  const month = `${date.getMonth() + 1}`.padStart(2, '0')
  const day = `${date.getDate()}`.padStart(2, '0')
  return `${year}-${month}-${day}`
}

const parseDateInput = (value: string) => {
  const [year, month, day] = value.split('-').map(Number)
  return new Date(year, (month || 1) - 1, day || 1)
}

export const Route = createFileRoute('/transactions')({
  component: TransactionsPage,
  // `?edit=<id>` opens that transaction; `from=dashboard` goes back there when it closes.
  validateSearch: (search: Record<string, unknown>): { edit?: number; from?: 'dashboard' } => {
    const edit = Number(search.edit)
    return {
      edit: Number.isInteger(edit) && edit > 0 ? edit : undefined,
      from: search.from === 'dashboard' ? 'dashboard' : undefined,
    }
  },
})

type TransactionFormState = {
  account_id: number
  category_id?: number
  allocation_id?: number
  budget_entry_id?: number
  amount?: number
  currency: CurrencyCode
  projected_amount?: number
  projected_currency?: CurrencyCode
  original_amount?: number
  original_currency?: CurrencyCode
  exchange_rate?: number
  // A transfer between currencies: what the destination received, in its own currency.
  received_amount?: number
  // Undefined while the field is blank: a payment into a loan then leaves the
  // principal/interest split to the server.
  transfer_fee?: number
  description: string
  transaction_type: Transaction['transaction_type']
  transaction_date: string
  posting_date?: string
  is_posted: boolean
  transfer_from_account_id?: number
  transfer_to_account_id?: number
  // The tags picked in the form; an edit sends them only when they changed.
  tag_ids: number[]
}

type PostingFormState = {
  visible: boolean
  amount: string
  error: string | null
  projectedAmount: number | null
  projectedCurrency: CurrencyCode
  accountCurrency: CurrencyCode
  needsConversion: boolean
  // A transfer into another currency also needs what the destination received.
  needsReceived: boolean
  destinationCurrency: CurrencyCode
  received: string
  // The caller may post but not edit (the owner resolving a creator's record): the only
  // figure sent is the one the row needs, beside `is_posted`.
  statusOnly: boolean
}

const emptyPostingForm = (currency: CurrencyCode): PostingFormState => ({
  visible: false,
  amount: '',
  error: null,
  projectedAmount: null,
  projectedCurrency: currency,
  accountCurrency: currency,
  needsConversion: false,
  needsReceived: false,
  destinationCurrency: currency,
  received: '',
  statusOnly: false,
})

export function TransactionsPage() {
  const { user, isAuthenticated, isLoading: authLoading } = useAuth()
  const navigate = useNavigate()
  const fallbackCurrency = (user?.default_currency as CurrencyCode) || 'PHP'

  useEffect(() => {
    if (!authLoading && !isAuthenticated) {
      navigate({ to: '/login', search: { message: undefined } })
    }
  }, [isAuthenticated, authLoading, navigate])

  const createInitialFormState = (overrides: Partial<TransactionFormState> = {}): TransactionFormState => ({
    account_id: 0,
    category_id: undefined,
    allocation_id: undefined,
    budget_entry_id: undefined,
    amount: undefined,
    currency: fallbackCurrency,
    projected_amount: undefined,
    projected_currency: fallbackCurrency,
    original_amount: undefined,
    original_currency: undefined,
    exchange_rate: undefined,
    received_amount: undefined,
    transfer_fee: undefined,
    description: '',
    transaction_type: 'debit',
    transaction_date: localToday(),
    posting_date: undefined,
    is_posted: true,
    transfer_from_account_id: undefined,
    transfer_to_account_id: undefined,
    tag_ids: [],
    ...overrides,
  })

  const [isCreateModalOpen, setIsCreateModalOpen] = useState(false)
  const [editingTransaction, setEditingTransaction] = useState<DetailedTransaction | null>(null)
  const [isActionModalOpen, setIsActionModalOpen] = useState(false)
  const [actionTransaction, setActionTransaction] = useState<Transaction | null>(null)
  const [fetchReceipt, { isLoading: isReceiptLoading }] = useFetchReceiptMutation()
  const [receipt, setReceipt] = useState<{ url: string; type: string; transactionId: number } | null>(null)
  const [receiptError, setReceiptError] = useState<string | null>(null)
  const receiptFor = useRef<number | null>(null)
  // The object URL is owned here, not by `receipt` state, so one accepted
  // before its state commits is still revoked.
  const receiptUrl = useRef<string | null>(null)
  const releaseReceiptUrl = useCallback(() => {
    if (receiptUrl.current) URL.revokeObjectURL(receiptUrl.current)
    receiptUrl.current = null
  }, [])
  // A result that lands after the page unmounts must find no pending request.
  useEffect(() => () => {
    receiptFor.current = null
    releaseReceiptUrl()
  }, [releaseReceiptUrl])
  const [postingFormState, setPostingFormState] = useState<PostingFormState>(emptyPostingForm(fallbackCurrency))
  const [searchTerm, setSearchTerm] = useState('')
  const [showFilters, setShowFilters] = useState(false)
  const [isBreakdownOpen, setIsBreakdownOpen] = useState(false)
  const [selectedAccountIds, setSelectedAccountIds] = useState<number[]>([])
  const [selectedCategoryNames, setSelectedCategoryNames] = useState<string[]>([])
  const [enteredBy, setEnteredBy] = useState<'everyone' | 'me'>('everyone')
  const [selectedTypes, setSelectedTypes] = useState<Transaction['transaction_type'][]>([])
  const [selectedTag, setSelectedTag] = useState<number | undefined>(undefined)
  const resetPostingFormState = useCallback(() => {
    setPostingFormState(emptyPostingForm(fallbackCurrency))
  }, [fallbackCurrency])
  const defaultMonthStartRef = useRef(getMonthStart(new Date()))
  const defaultMonthEndRef = useRef(getMonthEnd(defaultMonthStartRef.current))
  const [currentMonth, setCurrentMonth] = useState<Date>(defaultMonthStartRef.current)
  const [startDate, setStartDate] = useState<string>(() => formatDateInput(defaultMonthStartRef.current))
  const [endDate, setEndDate] = useState<string>(() => formatDateInput(defaultMonthEndRef.current))
  const [isCustomRange, setIsCustomRange] = useState(false)
  const [formData, setFormData] = useState<TransactionFormState>(() => createInitialFormState())
  const currencyOptions = useMemo(() => Object.keys(CURRENCY_CONFIGS) as CurrencyCode[], [])
  const transactionTypeOptions = useMemo(
    () => [
      { value: 'credit' as Transaction['transaction_type'], label: 'Income' },
      { value: 'debit' as Transaction['transaction_type'], label: 'Expense' },
      { value: 'transfer' as Transaction['transaction_type'], label: 'Transfer' },
    ],
    []
  )
  const resetFilters = useCallback(() => {
    const freshStart = getMonthStart(new Date())
    const freshEnd = getMonthEnd(freshStart)
    defaultMonthStartRef.current = freshStart
    defaultMonthEndRef.current = freshEnd
    setSearchTerm('')
    setSelectedAccountIds((prev) => (prev.length ? [] : prev))
    setSelectedCategoryNames((prev) => (prev.length ? [] : prev))
    setEnteredBy('everyone')
    setSelectedTypes((prev) => (prev.length ? [] : prev))
    setSelectedTag(undefined)
    setCurrentMonth(freshStart)
    setStartDate(formatDateInput(freshStart))
    setEndDate(formatDateInput(freshEnd))
    setIsCustomRange(false)
  }, [])

  const defaultMonthStartString = formatDateInput(defaultMonthStartRef.current)
  const defaultMonthEndString = formatDateInput(defaultMonthEndRef.current)

  const hasActiveFilters = useMemo(
    () =>
      Boolean(
        searchTerm.trim() ||
          selectedAccountIds.length ||
          selectedCategoryNames.length ||
          enteredBy !== 'everyone' ||
          selectedTypes.length ||
          selectedTag !== undefined ||
          isCustomRange ||
          startDate !== defaultMonthStartString ||
          endDate !== defaultMonthEndString
      ),
    [
      searchTerm,
      selectedAccountIds,
      selectedCategoryNames,
      enteredBy,
      selectedTypes,
      selectedTag,
      isCustomRange,
      startDate,
      endDate,
      defaultMonthStartString,
      defaultMonthEndString,
    ]
  )

  const dateRangeSummary = useMemo(() => {
    if (!startDate && !endDate) {
      return 'All dates'
    }
    const startLabel = startDate ? formatDateWithOrdinal(parseDateInput(startDate)) : 'Beginning'
    const endLabel = endDate ? formatDateWithOrdinal(parseDateInput(endDate)) : 'Present'
    return `${startLabel} → ${endLabel}`
  }, [startDate, endDate])

  // The dialog reads the same dates; an open side is "Any date".
  const breakdownRangeLabel = useMemo(() => {
    const startLabel = startDate ? formatDateWithOrdinal(parseDateInput(startDate)) : 'Any date'
    const endLabel = endDate ? formatDateWithOrdinal(parseDateInput(endDate)) : 'Any date'
    return `${startLabel} → ${endLabel}`
  }, [startDate, endDate])

  const todayMonthStart = useMemo(() => getMonthStart(new Date()), [])
  const currentMonthLabel = useMemo(() => formatMonthYear(currentMonth), [currentMonth])
  const isAtCurrentMonth = useMemo(
    () => isSameMonth(currentMonth, todayMonthStart),
    [currentMonth, todayMonthStart]
  )

  const handleMonthChange = useCallback(
    (direction: 'prev' | 'next') => {
      setIsCustomRange(false)
      setCurrentMonth((prev) => {
        if (direction === 'next' && isSameMonth(prev, todayMonthStart)) {
          return prev
        }
        const next = new Date(prev)
        next.setMonth(prev.getMonth() + (direction === 'next' ? 1 : -1))
        return getMonthStart(next)
      })
    },
    [todayMonthStart]
  )

  const toggleAccountFilter = useCallback((id: number) => {
    setSelectedAccountIds((prev) =>
      prev.includes(id) ? prev.filter((value) => value !== id) : [...prev, id]
    )
  }, [])

  const toggleCategoryFilter = useCallback((name: string) => {
    setSelectedCategoryNames((prev) => {
      if (prev.includes(name)) return prev.filter((value) => value !== name)
      return prev.length >= MAX_CATEGORY_NAMES ? prev : [...prev, name]
    })
  }, [])

  const toggleTypeFilter = useCallback((value: Transaction['transaction_type']) => {
    setSelectedTypes((prev) =>
      prev.includes(value) ? prev.filter((item) => item !== value) : [...prev, value]
    )
  }, [])

  const handleCustomStartDateChange = useCallback((value: string) => {
    setIsCustomRange(true)
    setStartDate(value)
    if (value) {
      setCurrentMonth(getMonthStart(parseDateInput(value)))
    }
  }, [])

  const handleCustomEndDateChange = useCallback((value: string) => {
    setIsCustomRange(true)
    setEndDate(value)
  }, [])

  useEffect(() => {
    if (isCustomRange) {
      return
    }
    const nextStart = formatDateInput(currentMonth)
    const nextEnd = formatDateInput(getMonthEnd(currentMonth))
    setStartDate((prev) => (prev === nextStart ? prev : nextStart))
    setEndDate((prev) => (prev === nextEnd ? prev : nextEnd))
  }, [currentMonth, isCustomRange])

  const [triggerTransactions] = useLazyGetTransactionsQuery()
  const beginTransactionsRequest = useRequestGeneration()
  const beginUpcomingRequest = useRequestGeneration()
  const { data: accountsData, isLoading: isAccountsLoading } = useGetAccountsQuery(
    { is_active: true, limit: 100 },
    { skip: !isAuthenticated }
  )
  const {
    data: categoriesData,
    isLoading: isCategoriesLoading,
  } = useGetCategoriesQuery({ is_active: true }, { skip: !isAuthenticated })
  const {
    data: budgetEntriesData,
    isLoading: budgetEntriesLoading,
  } = useGetBudgetEntriesQuery({ is_active: true, limit: 200 }, { skip: !isAuthenticated })
  
  const [createTransaction] = useCreateTransactionMutation()
  const [updateTransaction] = useUpdateTransactionMutation()
  const [deleteTransaction] = useDeleteTransactionMutation()

  const accounts = useMemo(() => accountsData?.items ?? [], [accountsData])
  // The form's account pickers offer only accounts the caller may add transactions to
  // (a viewer's shared account can be read and filtered by, never written to).
  const writableAccounts = useMemo(
    () => accounts.filter((account) => account.permissions.can_add_transactions),
    [accounts]
  )
  // Destinations looked up by id because they are not in `accounts` (inactive,
  // or past its first 100); null when the lookup found no such account.
  const [triggerAccount] = useLazyGetAccountQuery()
  const [resolvedDestinations, setResolvedDestinations] = useState<Record<number, Account | null>>({})
  const destinationLookups = useRef(new Set<number>())
  const categories = useMemo(() => categoriesData ?? [], [categoriesData])
  // One chip per name: the filter matches by name, so same-name categories are one choice.
  const categoryFilterNames = useMemo(
    () => Array.from(new Set(categories.map((category) => category.name))),
    [categories]
  )
  // Only the caller's own entries can be linked to a transaction: a shared or limited
  // entry belongs to someone else, whose category and allocation the caller can't use.
  const budgetEntries = useMemo(() => (budgetEntriesData?.items ?? []).filter(isOwnerFull), [budgetEntriesData])
  const today = useToday()
  const [transactions, setTransactions] = useState<Transaction[]>([])
  const [totalTransactions, setTotalTransactions] = useState(0)
  const [upcomingTransactions, setUpcomingTransactions] = useState<Transaction[]>([])
  const [upcomingTotal, setUpcomingTotal] = useState(0)
  const [isUpcomingOpen, setIsUpcomingOpen] = useState(true)
  // The full-page spinner is for the first load only; later loads keep the rows on screen.
  // It ends once both lists have settled, so the empty state never shows before Upcoming is known.
  const [mainSettled, setMainSettled] = useState(false)
  const [upcomingSettled, setUpcomingSettled] = useState(false)
  const [isMainLoading, setIsMainLoading] = useState(false)
  const [isUpcomingLoading, setIsUpcomingLoading] = useState(false)
  const isInitialLoading = !(mainSettled && upcomingSettled)
  const isRefreshing = isMainLoading || isUpcomingLoading

  const [pageSize, setPageSizeState] = useState<PageSize>(readStoredPageSize)
  // The search term enters the filter key 450ms after the last keystroke.
  const [debouncedSearch, setDebouncedSearch] = useState(searchTerm)
  useEffect(() => {
    // `effectiveSearch` makes a reset a single fetch; clearing here at once stops a stale term coming back.
    if (searchTerm.trim() === '') {
      setDebouncedSearch('')
      return
    }
    const timer = setTimeout(() => setDebouncedSearch(searchTerm), SEARCH_DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [searchTerm])

  // Everything that changes which rows are listed. The page is stored with the key it
  // was chosen under, so any change of filter, page size or day falls back to page 1
  // in the same render, with no second fetch.
  // A cleared search applies in the render that clears it, so a filter reset sends one fetch.
  const effectiveSearch = searchTerm.trim() === '' ? '' : debouncedSearch.trim()
  const filterKey = useMemo(
    () => JSON.stringify([startDate, endDate, selectedAccountIds, selectedCategoryNames, enteredBy, selectedTypes, effectiveSearch, selectedTag ?? null, pageSize, today]),
    [startDate, endDate, selectedAccountIds, selectedCategoryNames, enteredBy, selectedTypes, effectiveSearch, selectedTag, pageSize, today]
  )
  const [pageState, setPageState] = useState<{ key: string; page: number }>({ key: '', page: 1 })
  const page = pageState.key === filterKey ? pageState.page : 1
  // Re-key the stored page when the filters change, so a round trip (page 2, another
  // filter, back) lands on page 1. `page` is already 1 for a mismatched key, so this
  // changes nothing the fetches depend on.
  useEffect(() => {
    setPageState((prev) => (prev.key === filterKey ? prev : { key: filterKey, page: 1 }))
  }, [filterKey])
  const goToPage = useCallback((next: number) => setPageState({ key: filterKey, page: next }), [filterKey])
  const setPageSize = useCallback((next: PageSize) => {
    try {
      localStorage.setItem(PAGE_SIZE_STORAGE_KEY, String(next))
    } catch {
      // Storage can be blocked; the choice then lasts for this visit only.
    }
    setPageSizeState(next)
  }, [])

  // The filter's two requests: the main list (on or before today) and Upcoming (after).
  const bounds = useMemo(() => listBounds(startDate, endDate, today), [startDate, endDate, today])
  const filterParams = useMemo(() => {
    const params: TransactionQuery = {}
    if (selectedAccountIds.length > 0) {
      params.account_ids = selectedAccountIds
    }
    if (selectedTypes.length > 0) {
      params.transaction_types = selectedTypes
    }
    if (selectedCategoryNames.length > 0) {
      params.category_names = selectedCategoryNames
    }
    if (enteredBy === 'me') {
      params.entered_by = 'me'
    }
    if (selectedTag !== undefined) {
      params.tag = selectedTag
    }
    if (effectiveSearch) {
      params.search = effectiveSearch
    }
    return params
  }, [selectedAccountIds, selectedTypes, selectedCategoryNames, enteredBy, selectedTag, effectiveSearch])

  const loadTransactions = useCallback(
    async () => {
      if (!isAuthenticated) {
        return
      }
      const isCurrent = beginTransactionsRequest(true)
      let refetching = false
      try {
        setIsMainLoading(true)
        if (bounds.main === null) {
          setTransactions([])
          setTotalTransactions(0)
          return
        }
        const offset = (page - 1) * pageSize
        const result = await triggerTransactions({ ...filterParams, ...rangeParams(bounds.main), limit: pageSize, offset }).unwrap()
        if (!isCurrent()) return
        // The page ran past the end (rows were deleted or moved): go straight to the last one.
        if (result.total > 0 && offset >= result.total) {
          refetching = true
          goToPage(pageWindow(result.total, page, pageSize).pages)
          return
        }
        setTransactions(result.items)
        setTotalTransactions(result.total)
      } catch (error) {
        if (!isCurrent()) return
        console.error('Error loading transactions:', error)
        setTransactions([])
        setTotalTransactions(0)
      } finally {
        if (isCurrent() && !refetching) {
          setIsMainLoading(false)
          setMainSettled(true)
        }
      }
    },
    [beginTransactionsRequest, bounds.main, filterParams, goToPage, isAuthenticated, page, pageSize, triggerTransactions]
  )

  // Upcoming shows the nearest rows after today, soonest first. The server lists newest
  // first, so the nearest ones are the last of the range: fetch the head to learn the
  // total, and the tail too only when there are more than one request holds.
  const loadUpcoming = useCallback(
    async () => {
      if (!isAuthenticated) {
        return
      }
      const isCurrent = beginUpcomingRequest(true)
      try {
        setIsUpcomingLoading(true)
        if (bounds.upcoming === null) {
          setUpcomingTransactions([])
          setUpcomingTotal(0)
          return
        }
        const query = { ...filterParams, ...rangeParams(bounds.upcoming), limit: UPCOMING_LIMIT }
        const head = await triggerTransactions({ ...query, offset: 0 }).unwrap()
        if (!isCurrent()) return
        let items = head.items
        if (head.total > UPCOMING_LIMIT) {
          const tail = await triggerTransactions({ ...query, offset: head.total - UPCOMING_LIMIT }).unwrap()
          if (!isCurrent()) return
          items = tail.items
        }
        setUpcomingTransactions(head.total === 0 ? [] : [...items].reverse())
        setUpcomingTotal(head.total)
      } catch (error) {
        if (!isCurrent()) return
        console.error('Error loading upcoming transactions:', error)
        setUpcomingTransactions([])
        setUpcomingTotal(0)
      } finally {
        if (isCurrent()) {
          setIsUpcomingLoading(false)
          setUpcomingSettled(true)
        }
      }
    },
    [beginUpcomingRequest, bounds.upcoming, filterParams, isAuthenticated, triggerTransactions]
  )

  // After any create, edit, delete, post or un-post a row can move between the lists,
  // so both are fetched again under the filters and page now on screen.
  const refreshLists = useCallback(async () => {
    await Promise.all([loadTransactions(), loadUpcoming()])
  }, [loadTransactions, loadUpcoming])
  const refreshListsRef = useLatestRef(refreshLists)

  useEffect(() => {
    if (authLoading || !isAuthenticated) {
      return
    }
    void loadTransactions()
  }, [authLoading, isAuthenticated, loadTransactions])

  useEffect(() => {
    if (authLoading || !isAuthenticated) {
      return
    }
    void loadUpcoming()
  }, [authLoading, isAuthenticated, loadUpcoming])

  useEffect(() => {
    if (!isActionModalOpen) {
      resetPostingFormState()
    }
  }, [isActionModalOpen, resetPostingFormState])

  const transferDestinationOptions = useMemo(
    () =>
      writableAccounts.filter(
        (account) =>
          account.id !== (formData.transfer_from_account_id ?? formData.account_id) && account.id !== 0
      ),
    [writableAccounts, formData.account_id, formData.transfer_from_account_id]
  )

  const matchingBudgetEntries = useMemo(() => {
    if (formData.transaction_type === 'transfer') {
      return []
    }
    const targetType = formData.transaction_type === 'credit' ? 'income' : 'expense'
    return budgetEntries.filter((entry) => entry.is_active && entry.entry_type === targetType)
  }, [budgetEntries, formData.transaction_type])

  const selectedBudgetEntry = formData.budget_entry_id
    ? budgetEntries.find((entry) => entry.id === formData.budget_entry_id)
    : undefined

  // Only offer categories whose kind matches the current type; a transfer now
  // gets its own (savings/investment/contribution) categories.
  const categoryKindForType = TYPE_TO_KIND[formData.transaction_type]
  const visibleCategories = useMemo(
    () => categories.filter((category) => categoryKind(category) === categoryKindForType),
    [categories, categoryKindForType]
  )

  const selectedFormAccount = useMemo(
    () => accounts.find((account) => account.id === formData.account_id),
    [accounts, formData.account_id]
  )
  const destinationFormAccount = useMemo(
    () => accounts.find((account) => account.id === formData.transfer_to_account_id),
    [accounts, formData.transfer_to_account_id]
  )
  // A stored row is a loan payment when the server marked it one; an unmarked
  // (legacy) transfer is one when its destination is a loan, looked up by id
  // when it is not in `accounts`.
  const loanPaymentStatus = useCallback(
    (transaction: Transaction): LoanPaymentStatus => {
      // A Limited row can't be edited, posted or reverted, so it is never classified.
      if (isLimited(transaction)) {
        return 'not_loan'
      }
      if (transaction.loan_payment_kind) {
        return 'loan'
      }
      const destinationId = transaction.transfer_to_account_id
      if (transaction.transaction_type !== 'transfer' || destinationId == null) {
        return 'not_loan'
      }
      const destination =
        accounts.find((account) => account.id === destinationId) ?? resolvedDestinations[destinationId]
      if (destination === null) {
        return 'unavailable'
      }
      if (destination === undefined) {
        return 'pending'
      }
      return destination.account_type === 'loan' ? 'loan' : 'not_loan'
    },
    [accounts, resolvedDestinations]
  )
  const isLoanPayment = (transaction: Transaction) => loanPaymentStatus(transaction) === 'loan'
  // Editing, posting or reverting a row waits until it is classified; a row
  // whose destination can't be found is read-only.
  const actionLoanStatus: LoanPaymentStatus = actionTransaction
    ? loanPaymentStatus(actionTransaction)
    : 'not_loan'
  const actionLocked = actionLoanStatus === 'pending' || actionLoanStatus === 'unavailable'
  // Every control follows the row's server-computed flags, never its view kind.
  const actionPermissions = actionTransaction?.permissions ?? NO_PERMISSIONS

  useEffect(() => {
    if (!accountsData) {
      return
    }
    for (const transaction of [actionTransaction, editingTransaction]) {
      const destinationId = transaction && !isLimited(transaction) ? transaction.transfer_to_account_id : undefined
      if (!transaction || destinationId == null || loanPaymentStatus(transaction) !== 'pending') {
        continue
      }
      if (destinationLookups.current.has(destinationId)) {
        continue
      }
      destinationLookups.current.add(destinationId)
      triggerAccount(destinationId, true)
        .unwrap()
        .then((account) => {
          setResolvedDestinations((prev) => ({ ...prev, [destinationId]: account }))
        })
        .catch((error: unknown) => {
          if ((error as { status?: unknown } | undefined)?.status === 404) {
            setResolvedDestinations((prev) => ({ ...prev, [destinationId]: null }))
          }
        })
        .finally(() => {
          destinationLookups.current.delete(destinationId)
        })
    }
  }, [accountsData, actionTransaction, editingTransaction, loanPaymentStatus, triggerAccount])

  // The fee once `account` is picked as the destination of the form's transfer.
  const destinationTransferFee = (account: Account, fee: number | undefined) => {
    // Back to the row's stored destination: its stored fee again.
    if (paysLoan(editingTransaction, account.id)) {
      return editingTransaction?.transfer_fee ?? 0
    }
    // Newly paying a loan: the fee becomes the interest, left blank so the
    // server splits the amount at the loan's rate.
    if (account.account_type === 'loan') {
      return undefined
    }
    // A legacy (unmarked) loan payment moved to a non-loan account: the amount
    // stays the whole payment and nothing else leaves the source.
    if (
      editingTransaction !== null &&
      !editingTransaction.loan_payment_kind &&
      isLoanPayment(editingTransaction)
    ) {
      return 0
    }
    return fee
  }

  // A transfer into a loan is a loan payment: its fee is the interest. The
  // stored destination of the row being edited is classified like the row.
  const transferIntoLoan =
    formData.transaction_type === 'transfer' &&
    (destinationFormAccount?.account_type === 'loan' ||
      (editingTransaction !== null &&
        formData.transfer_to_account_id === editingTransaction.transfer_to_account_id &&
        isLoanPayment(editingTransaction)))

  // Account-type-aware nudge toward the correct dual-perspective framing.
  const contextHint = useMemo<{ text: string; suggestTransfer: boolean } | null>(() => {
    const type = formData.transaction_type
    if (type !== 'transfer') {
      if (selectedFormAccount?.account_type === 'savings' && type === 'debit') {
        return {
          text: 'Taking money out of savings is usually a transfer to another account, not an expense — record it as a Transfer so your net worth stays accurate.',
          suggestTransfer: true,
        }
      }
      if (selectedFormAccount?.account_type === 'savings' && type === 'credit') {
        return {
          text: 'Interest earned? Income is correct. But if you are moving your own money into savings, use a Transfer so it does not count as income.',
          suggestTransfer: true,
        }
      }
      if (selectedFormAccount?.account_type === 'credit' && type === 'debit') {
        return {
          text: 'This records a new charge on the card and increases what you owe. Paying the card off later is a Transfer from your funding account.',
          suggestTransfer: false,
        }
      }
      return null
    }
    if (destinationFormAccount?.account_type === 'credit') {
      return { text: 'Card payment: this reduces the balance you owe on the destination card.', suggestTransfer: false }
    }
    if (destinationFormAccount?.account_type === 'savings') {
      return { text: 'Savings contribution: the amount leaves the source account and lands in savings. Net worth is unchanged.', suggestTransfer: false }
    }
    return null
  }, [formData.transaction_type, selectedFormAccount, destinationFormAccount])

  const isLoading = isInitialLoading || isAccountsLoading || isCategoriesLoading || budgetEntriesLoading

  // A transfer between currencies sends one figure and receives another.
  const crossCurrencyTransfer =
    formData.transaction_type === 'transfer' &&
    selectedFormAccount !== undefined &&
    destinationFormAccount !== undefined &&
    selectedFormAccount.currency !== destinationFormAccount.currency
  const destinationCurrency = (destinationFormAccount?.currency as CurrencyCode | undefined) ?? formData.currency
  const formCurrencySymbol = getCurrencySymbol(formData.currency)
  const resolvedProjectedCurrency = formData.projected_currency ?? formData.currency
  const projectedCurrencySymbol = getCurrencySymbol(resolvedProjectedCurrency)

  const handleAccountSelect = (value: number) => {
    const accountId = Number.isNaN(value) ? 0 : value
    const nextAccount = accounts.find((account) => account.id === accountId)
    setFormData((prev) => ({
      ...prev,
      account_id: accountId,
      currency: nextAccount ? (nextAccount.currency as CurrencyCode) : fallbackCurrency,
      projected_currency:
        prev.projected_currency ?? (nextAccount ? (nextAccount.currency as CurrencyCode) : fallbackCurrency),
      transfer_from_account_id:
        prev.transaction_type === 'transfer' ? accountId || prev.transfer_from_account_id : prev.transfer_from_account_id,
      transfer_to_account_id:
        prev.transaction_type === 'transfer' && prev.transfer_to_account_id === accountId
          ? undefined
          : prev.transfer_to_account_id,
    }))
  }

  const handleTypeChange = (nextType: Transaction['transaction_type']) => {
    setFormData((prev) => {
      let nextBudgetEntryId = prev.budget_entry_id
      if (nextType === 'transfer') {
        nextBudgetEntryId = undefined
      } else if (nextBudgetEntryId) {
        const linkedEntry = budgetEntries.find((entry) => entry.id === nextBudgetEntryId)
        const expectedType = nextType === 'credit' ? 'income' : 'expense'
        if (!linkedEntry || linkedEntry.entry_type !== expectedType) {
          nextBudgetEntryId = undefined
        }
      }

      // Keep the category only if its kind still fits the new type
      // (an expense category makes no sense on a transfer, and vice versa).
      let nextCategoryId = prev.category_id
      if (nextCategoryId) {
        const linkedCategory = categories.find((cat) => cat.id === nextCategoryId)
        if (!linkedCategory || categoryKind(linkedCategory) !== TYPE_TO_KIND[nextType]) {
          nextCategoryId = undefined
        }
      }

      return {
        ...prev,
        transaction_type: nextType,
        budget_entry_id: nextBudgetEntryId,
        category_id: nextCategoryId,
        allocation_id: nextType === 'transfer' ? undefined : prev.allocation_id,
        transfer_fee: nextType === 'transfer' ? prev.transfer_fee : undefined,
        transfer_from_account_id:
          nextType === 'transfer' ? prev.account_id || prev.transfer_from_account_id : undefined,
        transfer_to_account_id:
          nextType === 'transfer'
            ? prev.transfer_to_account_id && prev.transfer_to_account_id !== (prev.account_id || prev.transfer_from_account_id)
              ? prev.transfer_to_account_id
              : undefined
            : undefined,
      }
    })
  }

  const openActionModal = (transaction: Transaction) => {
    resetPostingFormState()
    releaseReceiptUrl()
    setReceipt(null)
    setReceiptError(null)
    receiptFor.current = transaction.id
    setActionTransaction(transaction)
    setIsActionModalOpen(true)
  }

  const closeActionModal = () => {
    setIsActionModalOpen(false)
    setActionTransaction(null)
    releaseReceiptUrl()
    setReceipt(null)
    setReceiptError(null)
    receiptFor.current = null
    resetPostingFormState()
  }

  // The receipt is fetched with the auth header and shown from an object URL,
  // revoked when it is replaced, the modal closes or the page unmounts.
  const handleViewReceipt = async (transactionId: number) => {
    setReceiptError(null)
    const generation = currentSessionGeneration()
    try {
      const result = await fetchReceipt(transactionId).unwrap()
      if (receiptFor.current !== transactionId || generation !== currentSessionGeneration()) {
        URL.revokeObjectURL(result.url)
        return
      }
      releaseReceiptUrl()
      receiptUrl.current = result.url
      setReceipt({ ...result, transactionId })
    } catch (error) {
      if (receiptFor.current === transactionId) {
        setReceiptError(apiErrorMessage(error) || 'Could not load the receipt.')
      }
    }
  }

  const resetForm = () => {
    setFormData(createInitialFormState())
    setEditingTransaction(null)
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (editingTransaction && loanPaymentStatus(editingTransaction) === 'pending') {
      alert('Still checking this transfer\'s destination account. Try again in a moment.')
      return
    }
    if (editingTransaction && loanPaymentStatus(editingTransaction) === 'unavailable') {
      alert(DESTINATION_UNAVAILABLE)
      return
    }
    try {
      if (!formData.account_id) {
        alert('Please select an account for this transaction.')
        return
      }
      if (formData.transaction_type === 'transfer' && !formData.transfer_to_account_id) {
        alert('Please select a destination account for this transfer.')
        return
      }

      const selectedAccount = accounts.find((account) => account.id === formData.account_id)
      const accountCurrency = (selectedAccount?.currency as CurrencyCode) || fallbackCurrency
      const projectedCurrency = formData.projected_currency ?? accountCurrency
      const destinationAccount = accounts.find((account) => account.id === formData.transfer_to_account_id)
      const crossing =
        formData.transaction_type === 'transfer' &&
        destinationAccount !== undefined &&
        destinationAccount.currency !== accountCurrency
      if (crossing && formData.is_posted && !(formData.received_amount !== undefined && formData.received_amount > 0)) {
        alert(`Please enter the amount received in ${destinationAccount.currency}.`)
        return
      }

      let projectedAmount = formData.projected_amount
      if (!formData.is_posted) {
        if (!projectedAmount || projectedAmount <= 0) {
          alert('Please enter an amount greater than zero.')
          return
        }
      }

      let actualAmount = formData.amount
      if (formData.is_posted) {
        if (actualAmount === undefined || actualAmount <= 0) {
          alert('Please enter the actual amount posted to the account.')
          return
        }
        if (!projectedAmount || projectedAmount <= 0) {
          projectedAmount = actualAmount
        }
      } else {
        actualAmount = projectedAmount
      }

      // For a transfer into a loan the amount entered is the whole payment; the
      // stored amount is its principal, so interest is taken out of it. Blank
      // interest on a row newly paying the loan is left out so the server splits
      // the amount; on a row already paying it the server never splits, so blank
      // is sent as 0 and the payment stays the amount entered.
      let principal = actualAmount
      let transferFee: number | undefined =
        formData.transaction_type === 'transfer' ? formData.transfer_fee ?? 0 : 0
      if (transferIntoLoan) {
        if (formData.transfer_fee === undefined) {
          transferFee = paysLoan(editingTransaction, formData.transfer_to_account_id)
            ? 0
            : undefined
        } else {
          if (actualAmount !== undefined) {
            if (formData.transfer_fee > actualAmount) {
              alert('The interest cannot be more than the payment amount.')
              return
            }
            principal = toPrincipal(actualAmount, formData.transfer_fee)
          }
        }
      }

      const payload: Record<string, unknown> = {
        account_id: formData.account_id,
        amount: principal,
        currency: accountCurrency,
        description: formData.description,
        transaction_type: formData.transaction_type,
        transaction_date: new Date(formData.transaction_date).toISOString(),
        posting_date:
          formData.is_posted && formData.posting_date
            ? new Date(formData.posting_date).toISOString()
            : formData.is_posted
            ? new Date().toISOString()
            : undefined,
        is_posted: formData.is_posted,
        transfer_fee: transferFee,
        // Any other type sends both as null, so an edit away from a transfer clears them.
        ...transferAccountFields(
          formData.transaction_type,
          formData.transfer_from_account_id ?? formData.account_id,
          formData.transfer_to_account_id,
        ),
        category_id: formData.category_id,
        allocation_id: formData.transaction_type === 'transfer' ? undefined : formData.allocation_id,
        budget_entry_id: formData.transaction_type === 'transfer' ? undefined : formData.budget_entry_id,
        // An edit sends the tags only when they changed; omitting them keeps them.
        ...(editingTransaction
          ? tagIdsIfChanged(formData.tag_ids, tagIdsOf(editingTransaction.tags))
          : { tag_ids: formData.tag_ids }),
        projected_amount: projectedAmount ?? undefined,
        projected_currency: projectedCurrency,
        // Only a transfer between currencies carries what the destination received.
        ...(crossing ? { received_amount: formData.received_amount ?? null } : {}),
      }

      // Someone else's transaction on a shared account keeps its creator's category,
      // allocation and schedule link: the server refuses an edit that sends them.
      if (editingTransaction && isSharedFull(editingTransaction)) {
        delete payload.category_id
        delete payload.allocation_id
        delete payload.budget_entry_id
      }

      if (formData.is_posted) {
        if (projectedAmount && projectedAmount > 0) {
          payload.exchange_rate =
            projectedCurrency !== accountCurrency || actualAmount !== projectedAmount
              ? (actualAmount as number) / projectedAmount
              : 1
        } else {
          payload.exchange_rate = undefined
        }
      } else {
        payload.exchange_rate = undefined
        payload.posting_date = undefined
      }

      // A foreign pending row keeps its retained actual figure: only the projected figure
      // is edited here, so no amount, currency or rate is sent.
      if (
        editingTransaction &&
        keepsRetainedActual({
          editing: true,
          sameAccount: editingTransaction.account_id === formData.account_id,
          isPosted: formData.is_posted,
          transactionType: formData.transaction_type,
          accountCurrency,
          faceCurrency: projectedCurrency,
        })
      ) {
        delete payload.amount
        delete payload.currency
        delete payload.exchange_rate
      }

      if (editingTransaction) {
        await updateTransaction({ id: editingTransaction.id, data: payload }).unwrap()
        setEditingTransaction(null)
      } else {
        await createTransaction(payload).unwrap()
      }
      resetForm()
      setIsCreateModalOpen(false)
      await refreshListsRef.current()
    } catch (error) {
      console.error('Error saving transaction:', error)
      // Show the API's reason (e.g. a loan payment rule) instead of failing silently.
      alert(apiErrorMessage(error) || 'Could not save the transaction. Please try again.')
    }
  }

  const handleEdit = (transaction: Transaction) => {
    // A Limited row has no fields to edit.
    if (isLimited(transaction)) {
      return
    }
    setEditingTransaction(transaction)
    // A loan payment's form amount is the whole payment (principal + interest).
    const intoLoan = isLoanPayment(transaction)
    const total = intoLoan
      ? toTotal(transaction.amount, transaction.transfer_fee)
      : transaction.amount
    setFormData(
      createInitialFormState({
      account_id: transaction.account_id,
        // A shared-full row has no category, allocation or schedule link to edit.
        category_id: isOwnerFull(transaction) ? transaction.category_id ?? undefined : undefined,
        allocation_id: isOwnerFull(transaction) ? transaction.allocation_id ?? undefined : undefined,
        budget_entry_id: isOwnerFull(transaction) ? transaction.budget_entry_id ?? undefined : undefined,
      amount: total,
        currency: (transaction.currency as CurrencyCode) || fallbackCurrency,
        projected_amount: editFormProjectedAmount(transaction, intoLoan),
        projected_currency:
          (transaction.projected_currency as CurrencyCode) ||
          (transaction.currency as CurrencyCode) ||
          fallbackCurrency,
        original_amount: transaction.original_amount ?? undefined,
        original_currency: (transaction.original_currency as CurrencyCode) ?? undefined,
        exchange_rate: transaction.exchange_rate ?? undefined,
        received_amount: transaction.received_amount ?? undefined,
        transfer_fee: transaction.transfer_fee ?? 0,
      description: transaction.description || '',
      transaction_type: transaction.transaction_type,
      transaction_date: new Date(transaction.transaction_date).toISOString().split('T')[0],
        posting_date: transaction.posting_date
          ? new Date(transaction.posting_date).toISOString().split('T')[0]
          : undefined,
        is_posted: transaction.is_posted,
        transfer_from_account_id: transaction.transaction_type === 'transfer'
          ? transaction.transfer_from_account_id ?? transaction.account_id
          : undefined,
        transfer_to_account_id: transaction.transaction_type === 'transfer'
          ? transaction.transfer_to_account_id ?? undefined
          : undefined,
        tag_ids: tagIdsOf(transaction.tags),
      })
    )
    setIsCreateModalOpen(true)
  }

  const handleDelete = async (transactionId: number) => {
    if (confirm('Are you sure you want to delete this transaction?')) {
      try {
        await deleteTransaction(transactionId).unwrap()
        if (actionTransaction?.id === transactionId) {
          closeActionModal()
        }
        await refreshListsRef.current()
      } catch (error) {
        console.error('Error deleting transaction:', error)
        alert(apiErrorMessage(error) || 'Could not delete the transaction. Please try again.')
      }
    }
  }

  const handleMarkPostedFromModal = async (
    transaction: Transaction,
    actualAmount: number,
    exchangeRate?: number,
    receivedAmount?: number,
  ) => {
    if (isLimited(transaction)) {
      return
    }
    const account = accounts.find((item) => item.id === transaction.account_id)
    const accountCurrency = (account?.currency as CurrencyCode) || fallbackCurrency
    const timestamp = new Date().toISOString()
    // A loan payment's posted amount is the whole payment; its interest is kept.
    const amount = isLoanPayment(transaction)
      ? toPrincipal(actualAmount, transaction.transfer_fee)
      : actualAmount
    const payload: Record<string, unknown> = {
      is_posted: true,
      posting_date: timestamp,
      amount,
      currency: accountCurrency,
      exchange_rate: exchangeRate,
      // A transfer between currencies posts with what the destination received.
      ...(receivedAmount !== undefined ? { received_amount: receivedAmount } : {}),
    }
    // The response carries the row's fresh permissions (posting changes what may be reverted).
    const updatedTransaction = await updateTransaction({ id: transaction.id, data: payload }).unwrap()
    setActionTransaction(updatedTransaction)
    resetPostingFormState()
    void refreshListsRef.current()
  }

  // Posting or reverting a record the caller may not edit (the account owner resolving
  // a record whose creator lost access) sends the status alone: the API refuses any
  // other field from them.
  // The one figure the row needs besides the status goes with it: `amount` for a foreign
  // pending debit or credit, `received_amount` for a transfer between currencies.
  const handlePostStatusOnly = async (
    transaction: Transaction,
    figure: { amount: number } | { received_amount: number } | null = null,
  ): Promise<string | null> => {
    let updatedTransaction: Transaction
    try {
      updatedTransaction = await updateTransaction({ id: transaction.id, data: { is_posted: true, ...(figure ?? {}) } }).unwrap()
    } catch (error) {
      return apiErrorMessage(error) || 'Could not mark the transaction as posted. Please try again.'
    }
    setActionTransaction(updatedTransaction)
    resetPostingFormState()
    void refreshListsRef.current()
    return null
  }

  const handleRevertPostedFromModal = async (transaction: Transaction) => {
    if (isLimited(transaction)) {
      return
    }
    const account = accounts.find((item) => item.id === transaction.account_id)
    const accountCurrency = (account?.currency as CurrencyCode) || fallbackCurrency
    // A foreign debit or credit keeps its actual figure on revert: the API re-estimates the
    // plan from `projected_amount`, so no amount, currency or rate is sent.
    const face = (transaction.projected_currency as CurrencyCode | undefined) ?? (transaction.currency as CurrencyCode)
    const isForeignFlow = transaction.transaction_type !== 'transfer' && face !== accountCurrency
    const payload: Record<string, unknown> = !transaction.permissions.can_edit || isForeignFlow
      ? { is_posted: false }
      : {
          is_posted: false,
          posting_date: undefined,
          // A loan payment's projected amount is the whole payment; its interest is kept.
          amount:
            transaction.projected_amount != null && isLoanPayment(transaction)
              ? toPrincipal(transaction.projected_amount, transaction.transfer_fee)
              : transaction.projected_amount ?? transaction.amount,
          currency: accountCurrency,
          exchange_rate: undefined,
        }
    let updatedTransaction: Transaction
    try {
      updatedTransaction = await updateTransaction({ id: transaction.id, data: payload }).unwrap()
    } catch (error) {
      console.error('Error reverting transaction:', error)
      alert(apiErrorMessage(error) || 'Could not mark the transaction as not posted. Please try again.')
      return
    }
    setActionTransaction(updatedTransaction)
    resetPostingFormState()
    void refreshListsRef.current()
  }

  const handleInitPostingForm = (transaction: Transaction) => {
    if (isLimited(transaction)) {
      return
    }
    const account = accounts.find((item) => item.id === transaction.account_id)
    const accountCurrency = (account?.currency as CurrencyCode) || fallbackCurrency
    const destinationId = transaction.transaction_type === 'transfer' ? transaction.transfer_to_account_id : null
    const destinationCurrency =
      destinationId != null
        ? ((accounts.find((item) => item.id === destinationId) ?? resolvedDestinations[destinationId])?.currency as CurrencyCode | undefined)
        : undefined
    const needsReceived = destinationCurrency !== undefined && destinationCurrency !== accountCurrency
    // Only the status may change: the row's one missing figure is asked for, if it has one.
    if (!transaction.permissions.can_edit) {
      const face = (transaction.projected_currency as CurrencyCode | undefined) ?? (transaction.currency as CurrencyCode)
      const needsAmount = transaction.transaction_type !== 'transfer' && face !== accountCurrency
      const needsStoredReceived = needsReceived && !(transaction.received_amount != null && transaction.received_amount > 0)
      if (!needsAmount && !needsStoredReceived) {
        void handlePostStatusOnly(transaction).then((message) => {
          if (message) alert(message)
        })
        return
      }
      setPostingFormState({
        ...emptyPostingForm(accountCurrency),
        visible: true,
        projectedAmount: transaction.projected_amount ?? null,
        projectedCurrency: face,
        needsConversion: needsAmount,
        needsReceived: needsStoredReceived,
        destinationCurrency: destinationCurrency ?? accountCurrency,
        statusOnly: true,
      })
      return
    }
    // A loan payment is posted for its whole amount (principal + interest).
    const projectedAmount =
      transaction.projected_amount ??
      (isLoanPayment(transaction)
        ? toTotal(transaction.amount, transaction.transfer_fee)
        : transaction.amount) ??
      null
    const projectedCurrency =
      (transaction.projected_currency as CurrencyCode) ??
      (transaction.currency as CurrencyCode) ??
      accountCurrency
    const needsConversion = projectedCurrency !== accountCurrency
    setPostingFormState({
      ...emptyPostingForm(accountCurrency),
      visible: true,
      amount:
        !needsConversion && projectedAmount && projectedAmount > 0
          ? String(projectedAmount)
          : '',
      error: null,
      projectedAmount,
      projectedCurrency,
      accountCurrency,
      needsConversion,
      needsReceived,
      destinationCurrency: destinationCurrency ?? accountCurrency,
      received: needsReceived && transaction.received_amount != null ? String(transaction.received_amount) : '',
      statusOnly: false,
    })
  }

  const handleSavePostingForm = async () => {
    if (!actionTransaction) {
      return
    }
    // A status-only post asks for just the one figure the row needs.
    const askAmount = !postingFormState.statusOnly || postingFormState.needsConversion
    const parsed = parseFloat(postingFormState.amount)
    if (askAmount && (Number.isNaN(parsed) || parsed <= 0)) {
      setPostingFormState((prev) => ({
        ...prev,
        error: prev.needsConversion
          ? `Enter the amount in ${prev.accountCurrency} to post this foreign purchase`
          : 'Please enter a valid amount greater than zero.',
      }))
      return
    }
    const received = parseFloat(postingFormState.received)
    if (postingFormState.needsReceived && (Number.isNaN(received) || received <= 0)) {
      setPostingFormState((prev) => ({
        ...prev,
        error: `Enter the amount received in ${prev.destinationCurrency}.`,
      }))
      return
    }
    try {
      if (postingFormState.statusOnly) {
        const message = await handlePostStatusOnly(
          actionTransaction,
          postingFormState.needsConversion ? { amount: parsed } : { received_amount: received },
        )
        if (message) setPostingFormState((prev) => ({ ...prev, error: message }))
        return
      }
      const projectedAmount = postingFormState.projectedAmount
      const exchangeRate =
        projectedAmount && projectedAmount > 0 ? parsed / projectedAmount : undefined
      await handleMarkPostedFromModal(
        actionTransaction,
        parsed,
        exchangeRate,
        postingFormState.needsReceived ? received : undefined,
      )
      resetPostingFormState()
    } catch (error) {
      // The API's reason ("Enter the amount received", ...) stays in the form.
      setPostingFormState((prev) => ({
        ...prev,
        error: apiErrorMessage(error) || 'Could not mark the transaction as posted. Please try again.',
      }))
    }
  }

  const handleCancelPostingForm = () => {
    resetPostingFormState()
  }

  const openEditFromModal = (transaction: Transaction) => {
    closeActionModal()
    handleEdit(transaction)
  }

  // A link from the dashboard (`?edit=<id>&from=dashboard`) opens that transaction: its
  // form when the caller may edit it and it is classified, else its action modal, which
  // locks a pending or unavailable loan destination and shows only the permitted
  // actions. The search is then cleared, so a reload doesn't reopen it, and once the
  // modal it opened closes, the page goes back to the dashboard.
  const { edit: linkedId, from: linkedFrom } = Route.useSearch()
  const router = useRouter()
  const canGoBack = useCanGoBack()
  const { currentData: linkedTransaction, error: linkedError } = useGetTransactionQuery(linkedId ?? 0, {
    skip: linkedId === undefined || !isAuthenticated,
  })
  const handleEditRef = useLatestRef(handleEdit)
  const openActionModalRef = useLatestRef(openActionModal)
  // The id already opened, so a re-run (StrictMode, a new `loanPaymentStatus`) doesn't reopen it.
  const handledEditId = useRef<number | null>(null)
  const returnToDashboard = useRef(false)
  // The linked modal has been seen open, so its closing is what sends the page back.
  const linkedSeenOpen = useRef(false)
  const goBackToDashboard = useCallback(() => {
    if (canGoBack) {
      router.history.back()
    } else {
      navigate({ to: '/' })
    }
  }, [canGoBack, navigate, router])

  useEffect(() => {
    if (linkedId === undefined) {
      handledEditId.current = null
      return
    }
    if (handledEditId.current === linkedId) {
      return
    }
    if (linkedError) {
      handledEditId.current = linkedId
      alert(
        'status' in linkedError && linkedError.status === 404
          ? 'This transaction is no longer available.'
          : apiErrorMessage(linkedError) || 'This transaction is no longer available.'
      )
      if (linkedFrom === 'dashboard') {
        goBackToDashboard()
      } else {
        navigate({ to: '/transactions', search: {}, replace: true })
      }
      return
    }
    if (!accountsData || !linkedTransaction || linkedTransaction.id !== linkedId) {
      return
    }
    handledEditId.current = linkedId
    returnToDashboard.current = linkedFrom === 'dashboard'
    linkedSeenOpen.current = false
    const status = loanPaymentStatus(linkedTransaction)
    // `handleEdit` itself refuses only a Limited row, so the edit right is checked here.
    if (
      !isLimited(linkedTransaction) &&
      linkedTransaction.permissions.can_edit &&
      (status === 'loan' || status === 'not_loan')
    ) {
      handleEditRef.current(linkedTransaction)
    } else {
      openActionModalRef.current(linkedTransaction)
    }
    navigate({ to: '/transactions', search: {}, replace: true })
  }, [
    accountsData,
    goBackToDashboard,
    handleEditRef,
    linkedError,
    linkedFrom,
    linkedId,
    linkedTransaction,
    loanPaymentStatus,
    navigate,
    openActionModalRef,
  ])

  useEffect(() => {
    if (!returnToDashboard.current) {
      return
    }
    // `openEditFromModal` swaps the action modal for the form in one batch, so this
    // never reads false in between.
    if (isCreateModalOpen || isActionModalOpen) {
      linkedSeenOpen.current = true
      return
    }
    if (!linkedSeenOpen.current) {
      return
    }
    returnToDashboard.current = false
    linkedSeenOpen.current = false
    handledEditId.current = null
    goBackToDashboard()
  }, [goBackToDashboard, isActionModalOpen, isCreateModalOpen])

  const getTransactionMeta = useCallback(
    (transaction: Transaction) => {
      const currencyCode = (transaction.currency as CurrencyCode) || fallbackCurrency
      const amountLabel = formatCurrency(transaction.amount, currencyCode)
      const transferFeeLabel =
        transaction.transfer_fee && transaction.transfer_fee > 0
          ? formatCurrency(transaction.transfer_fee, currencyCode)
          : null
      const typeBadgeStyles =
        transaction.transaction_type === 'credit'
          ? 'text-ok'
          : transaction.transaction_type === 'debit'
          ? 'text-danger'
          : 'text-ink'
      const amountClass =
        transaction.transaction_type === 'credit'
          ? 'text-ok'
          : transaction.transaction_type === 'debit'
          ? 'text-danger'
          : 'text-ink'

      // A Limited row names its accounts through references (a hidden one is a neutral
      // name with no id); every other row looks them up in the caller's account list.
      if (isLimited(transaction)) {
        return {
          accountLabel: transaction.account?.name || 'Account',
          sourceLabel: transaction.account?.name || 'Source',
          destinationLabel: transaction.counterpart?.name || 'Destination',
          categoryName: transaction.category_name,
          amountLabel,
          projectedLabel: null,
          transferFeeLabel,
          typeBadgeStyles,
          amountClass,
          budgetEntry: undefined,
          scheduleLabel: null,
        }
      }

      const primaryAccount = accounts.find((a) => a.id === transaction.account_id)
      const fromAccount = transaction.transfer_from_account_id
        ? accounts.find((a) => a.id === transaction.transfer_from_account_id)
        : undefined
      const toAccount = transaction.transfer_to_account_id
        ? accounts.find((a) => a.id === transaction.transfer_to_account_id)
        : undefined
      const projectedLabel =
        !transaction.is_posted && transaction.projected_amount && transaction.projected_currency
          ? formatCurrency(transaction.projected_amount, transaction.projected_currency as CurrencyCode)
          : null
      const categoryName = isSharedFull(transaction)
        ? transaction.category_name
        : transaction.category_id
        ? categories.find((cat) => cat.id === transaction.category_id)?.name ?? null
        : null
      const budgetEntry = isOwnerFull(transaction) && transaction.budget_entry_id
        ? budgetEntries.find((entry) => entry.id === transaction.budget_entry_id)
        : undefined
      const scheduleLabel = budgetEntry
        ? `${budgetEntry.name} • ${RECURRENCE_LABELS[budgetEntry.cadence]}`
        : null

      return {
        accountLabel: primaryAccount?.name || 'Account',
        sourceLabel: fromAccount?.name || primaryAccount?.name || 'Source',
        destinationLabel: toAccount?.name || 'Destination',
        categoryName,
        amountLabel,
        projectedLabel,
        transferFeeLabel,
        typeBadgeStyles,
        amountClass,
        budgetEntry,
        scheduleLabel,
      }
    },
    [accounts, categories, fallbackCurrency, budgetEntries]
  )

  const actionModalMeta = useMemo(() => {
    if (!actionTransaction) {
      return null
    }
    const date = transactionDate(actionTransaction)
    // A Limited row has no posting date; its status alone says whether it is posted.
    const postingDate = isLimited(actionTransaction) ? undefined : actionTransaction.posting_date
    return {
      transactionDate: formatEntryDate(date),
      transactionRelative: relativeEntryDay(date, today),
      postingDate: postingDate
        ? formatDateWithOrdinal(new Date(postingDate))
        : isLimited(actionTransaction) && actionTransaction.is_posted
        ? 'Posted'
        : 'Not posted',
      postingRelative: postingDate ? formatRelativeDate(postingDate) : null,
      typeLabel: TRANSACTION_TYPE_LABELS[actionTransaction.transaction_type],
    }
  }, [actionTransaction, today])

  const actionMeta = useMemo(() => (actionTransaction ? getTransactionMeta(actionTransaction) : null), [actionTransaction, getTransactionMeta])

  const actionTransferMeta = useMemo(() => {
    if (!actionTransaction || actionTransaction.transaction_type !== 'transfer') {
      return null
    }
    return getTransactionMeta(actionTransaction)
  }, [actionTransaction, getTransactionMeta])

  const actionSchedule = actionMeta?.budgetEntry ?? null

  const handleBudgetEntrySelect = useCallback((entry: FullBudgetEntry | undefined) => {
    if (!entry) {
      setFormData((prev) => ({
        ...prev,
        budget_entry_id: undefined,
      }))
      return
    }

    setFormData((prev) => {
      const nextAccountId = entry.account_id ?? prev.account_id
      const nextAccount = nextAccountId ? accounts.find((acc) => acc.id === nextAccountId) : undefined
      const nextCurrency = (entry.currency as CurrencyCode) || (nextAccount?.currency as CurrencyCode) || prev.currency
      const updated: TransactionFormState = {
        ...prev,
        budget_entry_id: entry.id,
        account_id: nextAccountId,
        currency: nextCurrency,
        projected_currency: prev.projected_currency ?? nextCurrency,
      }

      if (entry.category_id) {
        updated.category_id = entry.category_id
      }
      if (entry.allocation_id) {
        updated.allocation_id = entry.allocation_id
      }
      if (!prev.description && entry.description) {
        updated.description = entry.description
      }
      if (entry.amount) {
        if (prev.is_posted) {
          updated.amount = prev.amount && prev.amount > 0 ? prev.amount : entry.amount
        } else {
          updated.projected_amount = prev.projected_amount && prev.projected_amount > 0 ? prev.projected_amount : entry.amount
        }
      }
      return updated
    })
  }, [accounts])

  if (authLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-ink"></div>
      </div>
    )
  }

  if (!isAuthenticated) {
    return null // Will redirect
  }

  if (isLoading) {
    return (
      <div className="flex items-center justify-center min-h-96">
        <div className="text-center">
          <div className="loading-spinner mx-auto mb-4"></div>
          <p className="text-body font-medium">Loading transactions...</p>
        </div>
      </div>
    )
  }

  const renderTransactionRow = (transaction: Transaction) => {
    const {
      accountLabel,
      sourceLabel,
      destinationLabel,
      categoryName,
      amountLabel,
      projectedLabel,
      transferFeeLabel,
      typeBadgeStyles,
      amountClass,
      scheduleLabel,
    } = getTransactionMeta(transaction)
    const rowDate = transactionDate(transaction)
    const relativeDate = relativeEntryDay(rowDate, today)
    const exactDate = formatEntryDate(rowDate)
    const status = transactionStatus(transaction, today)
    const postedDate =
      !isLimited(transaction) && transaction.posting_date
        ? formatDateWithOrdinal(new Date(transaction.posting_date))
        : null
    const typeLabel = TRANSACTION_TYPE_LABELS[transaction.transaction_type]
    const cardStateClasses = transaction.is_posted ? '' : 'bg-sunken border border-line'
    const description = transactionDescription(transaction)?.trim() || 'Untitled transaction'

    return (
      <article
        key={transaction.id}
        className={`card p-4 sm:p-5 transition-colors duration-200 hover:bg-sunken cursor-pointer ${cardStateClasses}`}
        onClick={() => openActionModal(transaction)}
        role="button"
        tabIndex={0}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault()
            openActionModal(transaction)
          }
        }}
      >
        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
            <div className="space-y-2">
              <div className="flex flex-wrap items-center gap-2 text-xs font-semibold uppercase tracking-wide text-muted">
                <span>{relativeDate}</span>
                <span className="hidden md:inline text-muted">•</span>
                <span className="text-muted">{exactDate}</span>
              </div>
              <p className="text-base font-semibold text-ink">{description}</p>
              <div className="flex flex-wrap gap-2 text-xs text-body">
                <span className="inline-flex items-center gap-1 rounded-full bg-sunken px-2 py-1">
                  <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 10h18M7 15h1m4 0h1m-7 4h12a3 3 0 003-3V8a3 3 0 00-3-3H6a3 3 0 00-3 3v8a3 3 0 003 3z" />
                  </svg>
                  {transaction.transaction_type === 'transfer'
                    ? `${sourceLabel} → ${destinationLabel}`
                    : accountLabel}
              </span>
                <span className="inline-flex items-center gap-1 rounded-full bg-sunken px-2 py-1">
                  <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h7" />
                  </svg>
                  {transaction.transaction_type === 'transfer'
                    ? categoryName || 'Transfer'
                    : categoryName || 'Uncategorized'}
              </span>
                {transaction.created_by && (
                  <span className="inline-flex items-center gap-1 rounded-full bg-sunken px-2 py-1" data-testid="created-by">
                    by {transaction.created_by}
                  </span>
                )}
                <TagChips tags={transaction.tags} />
                {scheduleLabel && (
                  <span className="inline-flex items-center gap-1 px-2 py-1 text-ink">
                    <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
                    </svg>
                    {scheduleLabel}
                  </span>
                )}
                {transferFeeLabel && (
                  <span className="inline-flex items-center gap-1 px-2 py-1 text-warn">
                    <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1" />
                    </svg>
                    Fee {transferFeeLabel}
                  </span>
                )}
                {projectedLabel && !transaction.is_posted && (
                  <span className="inline-flex items-center gap-1 px-2 py-1 text-ink">
                    <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3" />
                    </svg>
                    Projected {projectedLabel}
                  </span>
                )}
              </div>
            </div>
            <div className="space-y-2 text-right">
              <p className={`text-lg font-bold ${amountClass}`}>{amountLabel}</p>
              {!isLimited(transaction) && transaction.original_amount != null && transaction.original_currency && (
                <p className="text-xs text-muted">
                  Original {formatCurrency(transaction.original_amount, transaction.original_currency as CurrencyCode)}
                </p>
              )}
              {postedDate && <p className="text-xs text-muted">Posted {postedDate}</p>}
              <div className="flex flex-wrap justify-end gap-2">
                <span className={`inline-flex rounded-full px-2 py-1 text-xs font-semibold ${typeBadgeStyles}`}>
                  {typeLabel}
                </span>
                <span
                  className={`inline-flex rounded-full px-2 py-1 text-xs font-semibold ${STATUS_BADGE_CLASSES[status]}`}
                >
                  {STATUS_LABELS[status]}
                </span>
                {!isLimited(transaction) && transaction.is_reconciled && (
                  <span className="inline-flex rounded-full px-2 py-1 text-xs font-semibold text-ok">
                    Reconciled
                  </span>
                )}
              </div>
            </div>
          </div>
        </div>
      </article>
    )
  }

  const pageView = pageWindow(totalTransactions, page, pageSize)

  // Nothing to add a transaction to when every account is read-only for the caller.
  const canAddTransactions = writableAccounts.length > 0

  const emptyState = (
    <div className="card p-6 text-center space-y-4">
      <div className="w-16 h-16 mx-auto rounded-full bg-sunken flex items-center justify-center">
        <svg className="w-8 h-8 text-muted" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5H7a2 2 0 00-2 2v10a2 2 0 002 2h8a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-3 7h3m-3 4h3m-6-4h.01M9 16h.01" />
        </svg>
      </div>
      <div>
        <p className="text-lg font-semibold text-ink">No transactions found</p>
        <p className="text-sm text-muted mt-1">
          {hasActiveFilters
            ? 'No transactions match the current filters. Try adjusting them or reset to see more.'
            : 'No activity recorded for this month yet. Add your first transaction to get started.'}
        </p>
      </div>
      {canAddTransactions && (
        <button
          onClick={() => setIsCreateModalOpen(true)}
          className="btn-primary focus-ring w-full sm:w-auto mx-auto"
        >
          Add Transaction
        </button>
      )}
    </div>
  )

  return (
    <div className="max-w-7xl mx-auto px-3 py-6 sm:px-4 lg:px-6 space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <h1 className="text-3xl font-bold text-ink">Transactions</h1>
        {canAddTransactions && (
          <button
            onClick={() => setIsCreateModalOpen(true)}
            className="btn-primary focus-ring w-full sm:w-auto justify-center"
          >
            Add Transaction
          </button>
        )}
      </div>

      {/* Search and Filters */}
      <div className="card p-4 sm:p-6 space-y-4">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
          <div className="w-full lg:max-w-md">
            <label className="label">Search transactions</label>
            <div className="relative">
              <div className="pointer-events-none absolute inset-y-0 left-0 flex items-center pl-3">
                <svg className="h-5 w-5 text-muted" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
                </svg>
              </div>
              <input
                type="text"
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                className="input-field pl-10 focus-ring"
                placeholder="Search by description..."
              />
            </div>
          </div>
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-end">
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => handleMonthChange('prev')}
                className="inline-flex items-center rounded-full border border-line bg-surface px-2.5 py-1.5 text-sm font-medium text-body transition hover:bg-sunken focus:outline-none"
                aria-label="View previous month"
              >
                <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
                </svg>
              </button>
              <span className="text-sm font-semibold text-ink">{currentMonthLabel}</span>
              <button
                type="button"
                onClick={() => handleMonthChange('next')}
                className="inline-flex items-center rounded-full border border-line bg-surface px-2.5 py-1.5 text-sm font-medium text-body transition hover:bg-sunken focus:outline-none disabled:cursor-not-allowed disabled:opacity-60"
                aria-label="View next month"
                disabled={isAtCurrentMonth}
              >
                <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                </svg>
              </button>
            </div>
            <button
              type="button"
              onClick={() => setIsBreakdownOpen(true)}
              data-onboarding="spending-breakdown"
              className="inline-flex items-center justify-center gap-2 border border-line bg-surface px-3 py-2 text-sm font-semibold text-body transition hover:bg-sunken focus:outline-none"
            >
              <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 3.055A9.001 9.001 0 1020.945 13H11V3.055z" />
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M20.488 9H15V3.512A9.025 9.025 0 0120.488 9z" />
              </svg>
              Spending breakdown
            </button>
            <button
              type="button"
              onClick={() => setShowFilters((prev) => !prev)}
              className="inline-flex items-center justify-center gap-2 border border-line bg-surface px-3 py-2 text-sm font-semibold text-body transition hover:bg-sunken focus:outline-none"
            >
              <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 4h18l-7 8v6l-4 2v-8z" />
              </svg>
              {showFilters ? 'Hide filters' : 'Show filters'}
            </button>
          </div>
        </div>
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <p className="text-sm font-medium text-body">Date range: {dateRangeSummary}</p>
            <p className="text-xs text-muted">
              {isCustomRange ? 'Custom range selected' : 'Automatically showing whole-month activity'}
            </p>
          </div>
          {hasActiveFilters && (
            <button
              type="button"
              onClick={resetFilters}
              className="btn-secondary focus-ring self-start sm:self-auto"
            >
              Reset filters
            </button>
          )}
        </div>
        {(selectedCategoryNames.length > 0 || enteredBy === 'me') && (
          <div className="flex flex-wrap gap-2" aria-label="Active filters">
            {selectedCategoryNames.map((name) => (
              <button
                type="button"
                key={`category:${name}`}
                onClick={() => toggleCategoryFilter(name)}
                className="inline-flex items-center gap-1.5 rounded-full bg-ink px-3 py-1 text-sm font-medium text-paper focus-ring"
                aria-label={`Remove category filter ${name}`}
              >
                Category: {name}
                <span aria-hidden="true">×</span>
              </button>
            ))}
            {enteredBy === 'me' && (
              <button
                type="button"
                onClick={() => setEnteredBy('everyone')}
                className="inline-flex items-center gap-1.5 rounded-full bg-ink px-3 py-1 text-sm font-medium text-paper focus-ring"
                aria-label="Remove the Only mine filter"
              >
                Only mine
                <span aria-hidden="true">×</span>
              </button>
            )}
          </div>
        )}
        {showFilters && (
          <div className="space-y-6">
            <div>
              <h3 className="text-sm font-semibold text-body">Accounts</h3>
              <div className="mt-2 flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={() => setSelectedAccountIds([])}
                  className={`rounded-full px-3 py-1.5 text-sm font-medium transition ${ selectedAccountIds.length === 0 ? 'bg-ink text-paper' : 'bg-sunken text-body hover:bg-sunken' }`}
                  disabled={selectedAccountIds.length === 0}
                >
                  All accounts
                </button>
                {accounts.map((account) => {
                  const isSelected = selectedAccountIds.includes(account.id)
                  return (
                    <button
                      type="button"
                      key={account.id}
                      onClick={() => toggleAccountFilter(account.id)}
                      className={`rounded-full px-3 py-1.5 text-sm font-medium transition ${ isSelected ? 'bg-ink text-paper' : 'bg-sunken text-body hover:bg-sunken' }`}
                    >
                  {account.name}
                    </button>
                  )
                })}
          </div>
            </div>
          <div>
              <h3 className="text-sm font-semibold text-body">Transaction types</h3>
              <div className="mt-2 flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={() => setSelectedTypes([])}
                  className={`rounded-full px-3 py-1.5 text-sm font-medium transition ${ selectedTypes.length === 0 ? 'bg-ink text-paper' : 'bg-sunken text-body hover:bg-sunken' }`}
                  disabled={selectedTypes.length === 0}
                >
                  All types
                </button>
                {transactionTypeOptions.map((option) => {
                  const isSelected = selectedTypes.includes(option.value)
                  return (
                    <button
                      type="button"
                      key={option.value}
                      onClick={() => toggleTypeFilter(option.value)}
                      className={`rounded-full px-3 py-1.5 text-sm font-medium capitalize transition ${ isSelected ? 'bg-ink text-paper' : 'bg-sunken text-body hover:bg-sunken' }`}
                    >
                      {option.label}
                    </button>
                  )
                })}
          </div>
        </div>
            <div>
              <h3 className="text-sm font-semibold text-body">Categories</h3>
              <div className="mt-2 flex flex-wrap gap-2">
            <button
                  type="button"
                  onClick={() => setSelectedCategoryNames([])}
                  className={`rounded-full px-3 py-1.5 text-sm font-medium transition ${ selectedCategoryNames.length === 0 ? 'bg-ink text-paper' : 'bg-sunken text-body hover:bg-sunken' }`}
                  disabled={selectedCategoryNames.length === 0}
                >
                  All categories
            </button>
                {categoryFilterNames.map((name) => {
                  const isSelected = selectedCategoryNames.includes(name)
                  return (
                    <button
                      type="button"
                      key={name}
                      onClick={() => toggleCategoryFilter(name)}
                      className={`rounded-full px-3 py-1.5 text-sm font-medium transition ${ isSelected ? 'bg-ink text-paper' : 'bg-sunken text-body hover:bg-sunken' }`}
                    >
                      {name}
                    </button>
                  )
                })}
          </div>
              {selectedCategoryNames.length >= MAX_CATEGORY_NAMES && (
                <p className="mt-2 text-xs text-muted">
                  You can filter by up to {MAX_CATEGORY_NAMES} categories at once.
                </p>
              )}
      </div>
            <div>
              <h3 className="text-sm font-semibold text-body">Entered by</h3>
              <div className="mt-2 flex flex-wrap gap-2" role="group" aria-label="Entered by">
                {([['everyone', 'Everyone'], ['me', 'Only mine']] as const).map(([value, label]) => (
                  <button
                    type="button"
                    key={value}
                    onClick={() => setEnteredBy(value)}
                    aria-pressed={enteredBy === value}
                    className={`rounded-full px-3 py-1.5 text-sm font-medium transition ${ enteredBy === value ? 'bg-ink text-paper' : 'bg-sunken text-body hover:bg-sunken' }`}
                  >
                    {label}
                  </button>
                ))}
              </div>
              <p className="mt-2 text-xs text-muted">
                Only mine keeps the rows you own, including ones someone else recorded for you from your recurring entries.
              </p>
            </div>
            <div>
              <h3 className="text-sm font-semibold text-body">Tag</h3>
              <div className="mt-2">
                <TagFilter value={selectedTag} onChange={setSelectedTag} />
              </div>
            </div>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div>
                <label className="label">Custom start date</label>
                <input
                  type="date"
                  value={startDate}
                  onChange={(e) => handleCustomStartDateChange(e.target.value)}
                  className="input-field focus-ring"
                  max={endDate || undefined}
                />
              </div>
              <div>
                <label className="label">Custom end date</label>
                <input
                  type="date"
                  value={endDate}
                  onChange={(e) => handleCustomEndDateChange(e.target.value)}
                  className="input-field focus-ring"
                  min={startDate || undefined}
                />
              </div>
            </div>
            {isCustomRange && (
              <p className="text-xs text-muted">
                Month navigation will snap back to calendar months. Use reset to return to the current month view.
              </p>
            )}
                    </div>
        )}
      </div>

      {/* Always mounted at a fixed height so showing it never moves the list. */}
      <p className="flex h-4 items-center gap-2 text-xs text-muted" role="status">
        {isRefreshing && (
          <>
            <span className="loading-spinner !h-3 !w-3" aria-hidden="true"></span>
            Updating...
          </>
        )}
      </p>
      {transactions.length === 0 && upcomingTransactions.length === 0 ? (
        // Not before the first load settles; after that the previous state stays up while refreshing.
        isInitialLoading ? null : emptyState
      ) : (
        <div className={`space-y-6 transition-opacity ${isRefreshing ? 'opacity-60' : ''}`} aria-busy={isRefreshing}>
          {upcomingTransactions.length > 0 && (
            <section className="space-y-3" data-testid="upcoming-transactions">
              <button
                type="button"
                onClick={() => setIsUpcomingOpen((open) => !open)}
                aria-expanded={isUpcomingOpen}
                className="flex w-full items-center justify-between gap-3 text-left focus-ring"
              >
                <span className="text-sm font-semibold text-body">
                  Upcoming ({upcomingTotal})
                  {upcomingTotal > upcomingTransactions.length && (
                    <span className="ml-2 text-xs font-normal text-muted">
                      showing the next {upcomingTransactions.length} of {upcomingTotal}, narrow the dates for more
                    </span>
                  )}
                </span>
                <svg className={`h-4 w-4 text-muted transition-transform ${isUpcomingOpen ? 'rotate-180' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                </svg>
              </button>
              {isUpcomingOpen && (
                <div className="grid grid-cols-1 gap-3">
                  {upcomingTransactions.map(renderTransactionRow)}
                </div>
              )}
            </section>
          )}
          {transactions.length === 0 ? (
            <p className="text-sm text-muted">Nothing on or before today in this range.</p>
          ) : (
            <div className="grid grid-cols-1 gap-3">
              {transactions.map(renderTransactionRow)}
            </div>
          )}
          {totalTransactions > 0 && (
            <nav className="flex flex-col gap-3 px-1 sm:flex-row sm:items-center sm:justify-between" aria-label="Transactions pages" data-testid="transactions-pager">
              <p className="text-xs text-muted">
                {pageView.from}–{pageView.to} of {totalTransactions}
              </p>
              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  onClick={() => goToPage(pageView.page - 1)}
                  disabled={pageView.page <= 1}
                  className="btn-secondary focus-ring disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  Previous
                </button>
                {pageItems(pageView.pages, pageView.page).map((item, index) =>
                  item === 0 ? (
                    <span key={`gap-${index}`} className="px-1 text-muted" aria-hidden="true">…</span>
                  ) : (
                    <button
                      type="button"
                      key={item}
                      onClick={() => goToPage(item)}
                      aria-current={item === pageView.page ? 'page' : undefined}
                      className={`rounded-full px-3 py-1.5 text-sm font-medium transition ${ item === pageView.page ? 'bg-ink text-paper' : 'bg-sunken text-body hover:bg-sunken' }`}
                    >
                      {item}
                    </button>
                  )
                )}
                <button
                  type="button"
                  onClick={() => goToPage(pageView.page + 1)}
                  disabled={pageView.page >= pageView.pages}
                  className="btn-secondary focus-ring disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  Next
                </button>
                <label className="flex items-center gap-2 text-xs text-muted">
                  Per page
                  <select
                    value={pageSize}
                    onChange={(event) => setPageSize(Number(event.target.value) as PageSize)}
                    className="input-field focus-ring !w-auto !py-1"
                  >
                    {PAGE_SIZES.map((size) => (
                      <option key={size} value={size}>{size}</option>
                    ))}
                  </select>
                </label>
              </div>
            </nav>
          )}
        </div>
      )}

      {isBreakdownOpen && (
        <SpendingBreakdownDialog
          startDate={startDate}
          endDate={endDate}
          tag={selectedTag}
          rangeLabel={breakdownRangeLabel}
          defaultCurrency={fallbackCurrency}
          onSelectCategory={(name) => {
            // Replaces any category selection. Page 1 is set explicitly so picking again
            // from page 2 still resets, when the key would not change.
            setSelectedCategoryNames([name])
            goToPage(1)
            setIsBreakdownOpen(false)
          }}
          onClose={() => setIsBreakdownOpen(false)}
        />
      )}

      {isActionModalOpen && actionTransaction && (
        <div
          className="fixed inset-0 z-50 overflow-y-auto bg-black/60 px-4 py-6"
          onClick={closeActionModal}
        >
          <div className="min-h-full flex items-center justify-center">
          <div
            className="w-full max-w-2xl bg-surface p-6"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="flex items-start justify-between gap-4">
              <div>
                <h2 className="text-xl font-semibold text-ink">Transaction Actions</h2>
                <p className="text-sm text-muted">
                  {transactionDescription(actionTransaction) || 'No description'}
                </p>
              </div>
                        <button
                onClick={closeActionModal}
                className="text-muted hover:text-body transition-colors duration-200"
                aria-label="Close actions modal"
              >
                <svg className="h-6 w-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>

            <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div className="border border-line p-4">
                <h3 className="text-sm font-semibold text-body">Dates</h3>
                <dl className="mt-3 space-y-2 text-sm text-body">
                  <div className="flex justify-between gap-3">
                    <dt>Transaction</dt>
                    <dd className="text-right">
                      {actionModalMeta?.transactionDate}
                      {actionModalMeta?.transactionRelative && (
                        <span className="ml-2 text-muted">({actionModalMeta.transactionRelative})</span>
                      )}
                    </dd>
                  </div>
                  <div className="flex justify-between gap-3">
                    <dt>Posting</dt>
                    <dd className="text-right">
                      {actionModalMeta?.postingDate}
                      {actionModalMeta?.postingRelative && (
                        <span className="ml-2 text-muted">({actionModalMeta.postingRelative})</span>
                      )}
                    </dd>
                  </div>
                </dl>
              </div>

              <div className="border border-line p-4">
                <h3 className="text-sm font-semibold text-body">Details</h3>
                <dl className="mt-3 space-y-2 text-sm text-body">
                  <div className="flex justify-between">
                    <dt>Amount</dt>
                    <dd className={
                      actionTransaction.transaction_type === 'credit'
                        ? 'text-ok font-medium'
                        : actionTransaction.transaction_type === 'debit'
                        ? 'text-danger font-medium'
                        : 'text-ink font-medium'
                    }>
                      {formatCurrency(actionTransaction.amount, actionTransaction.currency as CurrencyCode)}
                    </dd>
                  </div>
                  <div className="flex justify-between">
                    <dt>Type</dt>
                    <dd>{actionModalMeta?.typeLabel}</dd>
                  </div>
                  <div className="flex justify-between">
                    <dt>Status</dt>
                    <dd className={STATUS_TEXT_CLASSES[transactionStatus(actionTransaction, today)]}>
                      {STATUS_LABELS[transactionStatus(actionTransaction, today)]}
                    </dd>
                  </div>
                  {actionTransaction.created_by && (
                    <div className="flex justify-between gap-3">
                      <dt>Created by</dt>
                      <dd className="text-right">{actionTransaction.created_by}</dd>
                    </div>
                  )}
                  {actionTransaction.transaction_type === 'transfer' && (
                    <>
                      <div className="flex justify-between gap-3">
                        <dt>From</dt>
                        <dd className="text-right">
                          {actionTransferMeta?.sourceLabel || 'Source account'}
                        </dd>
                      </div>
                      <div className="flex justify-between gap-3">
                        <dt>To</dt>
                        <dd className="text-right">
                          {actionTransferMeta?.destinationLabel || 'Destination account'}
                        </dd>
                      </div>
                      {actionTransferMeta?.transferFeeLabel && (
                        <div className="flex justify-between gap-3">
                          <dt>Transfer Fee</dt>
                          <dd className="text-right text-danger">{actionTransferMeta.transferFeeLabel}</dd>
                        </div>
                      )}
                    </>
                  )}
                  {actionSchedule && (
                    <>
                      <div className="flex justify-between gap-3">
                        <dt>Recurring entry</dt>
                        <dd className="text-right text-ink font-medium">{actionSchedule.name}</dd>
                      </div>
                      <div className="flex justify-between gap-3">
                        <dt>Cadence</dt>
                        <dd>{RECURRENCE_LABELS[actionSchedule.cadence]}</dd>
                      </div>
                      <div className="flex justify-between gap-3">
                        <dt>Scheduled Amount</dt>
                        <dd>{formatCurrency(actionSchedule.amount, actionSchedule.currency)}</dd>
                      </div>
                      <div className="flex justify-between gap-3">
                        <dt>Next Occurrence</dt>
                        <dd>{formatEntryDate(actionSchedule.next_occurrence)}</dd>
                      </div>
                      {actionSchedule.lead_time_days ? (
                        <div className="flex justify-between gap-3 text-xs text-muted">
                          <dt>Reminder</dt>
                          <dd>{actionSchedule.lead_time_days} day{actionSchedule.lead_time_days === 1 ? '' : 's'} before</dd>
                        </div>
                      ) : null}
                      {actionSchedule.is_autopay && (
                        <div className="flex justify-between gap-3 text-xs text-ink">
                          <dt>Autopay</dt>
                          <dd>Enabled</dd>
                        </div>
                      )}
                    </>
                  )}
                </dl>
              </div>
            </div>

            <div className="mt-6 space-y-4">
              {isOwnerFull(actionTransaction) && actionTransaction.receipt_url?.startsWith('/api/') && (
                <div className="space-y-2">
                  <button
                    type="button"
                    onClick={() => handleViewReceipt(actionTransaction.id)}
                    disabled={isReceiptLoading}
                    data-testid="view-receipt"
                    className="px-4 py-2 text-sm font-semibold border border-line text-ink hover:bg-sunken disabled:opacity-50"
                  >
                    {isReceiptLoading ? 'Loading receipt…' : 'View receipt'}
                  </button>
                  {receiptError && <p className="text-sm text-danger">{receiptError}</p>}
                  {receipt && receipt.transactionId === actionTransaction.id && (
                    receipt.type.startsWith('image/') ? (
                      <img src={receipt.url} alt="Receipt" data-testid="receipt-preview" className="max-h-80 border border-line" />
                    ) : (
                      <a href={receipt.url} download={`receipt-${actionTransaction.id}`} data-testid="receipt-download" className="text-sm text-ink underline">
                        Download receipt
                      </a>
                    )
                  )}
                </div>
              )}
              {actionLoanStatus === 'pending' && (
                <p className="text-sm text-muted">Checking this transfer&apos;s destination account…</p>
              )}
              {actionLoanStatus === 'unavailable' && (
                <p className="text-sm text-warn">{DESTINATION_UNAVAILABLE}</p>
              )}
              {!actionPermissions.can_post &&
                !actionPermissions.can_revert &&
                !actionPermissions.can_edit &&
                !actionPermissions.can_delete && (
                  <p className="text-sm text-muted" data-testid="read-only-note">
                    You can view this transaction but not change it.
                  </p>
                )}
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                {actionTransaction.is_posted ? (
                  actionPermissions.can_revert && (
                  <button
                    onClick={() => handleRevertPostedFromModal(actionTransaction)}
                    disabled={actionLocked}
                    className="flex items-center justify-center gap-2 px-4 py-3 text-sm font-semibold transition-colors duration-200 text-warn hover:bg-sunken disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                    </svg>
                    Mark as not posted
                  </button>
                  )
                ) : (
                  actionPermissions.can_post && (
                  <button
                    onClick={() => handleInitPostingForm(actionTransaction)}
                    disabled={actionLocked}
                    className="flex items-center justify-center gap-2 px-4 py-3 text-sm font-semibold transition-colors duration-200 text-ok hover:bg-sunken disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                    </svg>
                    Mark as Posted
                  </button>
                  )
                )}
                {actionPermissions.can_edit && (
                <button
                  onClick={() => openEditFromModal(actionTransaction)}
                  disabled={actionLocked}
                  className="flex items-center justify-center gap-2 bg-ink px-4 py-3 text-sm font-semibold text-paper transition-colors duration-200 hover:bg-ink disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
                          </svg>
                  Edit Transaction
                        </button>
                )}
                {actionPermissions.can_delete && (
                        <button
                  onClick={() => handleDelete(actionTransaction.id)}
                  className="flex items-center justify-center gap-2 bg-sunken px-4 py-3 text-sm font-semibold text-body transition-colors duration-200 hover:bg-sunken"
                        >
                  <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                          </svg>
                  Delete Transaction
                        </button>
                )}
                      </div>
              {!actionTransaction.is_posted && actionPermissions.can_post && postingFormState.visible && (
                <div className="border border-ink p-4 space-y-3">
                  <p className="text-sm font-medium text-ink">
                    {postingFormState.projectedAmount
                      ? `Projected amount: ${formatCurrency(
                          postingFormState.projectedAmount,
                          postingFormState.projectedCurrency
                        )}`
                      : 'No projected amount recorded.'}
                  </p>
                  <p className="text-xs text-ink">
                    {postingFormState.needsConversion
                      ? `Enter the amount actually posted in ${postingFormState.accountCurrency}. The projection only estimates it.`
                      : postingFormState.statusOnly
                      ? 'Enter the figure this transfer needs before it can be posted.'
                      : 'Verify the received amount. Update it only if the actual amount differs.'}
                  </p>
                  <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
                    {(!postingFormState.statusOnly || postingFormState.needsConversion) && (
                    <div className="flex-1">
                      <label className="label text-ink">
                        {postingFormState.needsReceived ? `Amount sent (${postingFormState.accountCurrency})` : `Amount in ${postingFormState.accountCurrency}`}
                      </label>
                      <div className="relative">
                        <span className="absolute inset-y-0 left-0 pl-3 flex items-center text-ink text-sm">
                          {getCurrencySymbol(postingFormState.accountCurrency)}
                        </span>
                        <input
                          type="number"
                          step="0.01"
                          min="0"
                          value={postingFormState.amount}
                          onChange={(e) =>
                            setPostingFormState((prev) => ({
                              ...prev,
                              amount: e.target.value,
                              error: null,
                            }))
                          }
                          className="input-field pl-7 focus-ring"
                          placeholder="0.00"
                        />
                      </div>
                    </div>
                    )}
                    {!postingFormState.statusOnly &&
                      !postingFormState.needsConversion &&
                      postingFormState.projectedAmount &&
                      postingFormState.projectedAmount > 0 && (
                        <button
                          type="button"
                          onClick={() =>
                            setPostingFormState((prev) => ({
                              ...prev,
                              amount: String(prev.projectedAmount ?? ''),
                              error: null,
                            }))
                          }
                          className="bg-surface px-3 py-2 text-sm font-semibold text-ink hover:bg-sunken"
                        >
                          Use projected amount
                        </button>
                      )}
                  </div>
                  {postingFormState.needsReceived && (
                    <div>
                      <label className="label text-ink" htmlFor="posting-received">
                        Amount received ({postingFormState.destinationCurrency})
                      </label>
                      <div className="relative">
                        <span className="absolute inset-y-0 left-0 pl-3 flex items-center text-ink text-sm">
                          {getCurrencySymbol(postingFormState.destinationCurrency)}
                        </span>
                        <input
                          id="posting-received"
                          type="number"
                          step="0.01"
                          min="0"
                          value={postingFormState.received}
                          onChange={(e) =>
                            setPostingFormState((prev) => ({ ...prev, received: e.target.value, error: null }))
                          }
                          className="input-field pl-7 focus-ring"
                          placeholder="0.00"
                        />
                      </div>
                    </div>
                  )}
                  {postingFormState.error && (
                    <p className="text-xs text-danger" role="alert" data-testid="posting-error">{postingFormState.error}</p>
                  )}
                  <div className="flex flex-wrap gap-2">
                    <button
                      type="button"
                      onClick={handleSavePostingForm}
                      disabled={actionLocked}
                      className="btn-primary focus-ring disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      Save Posted Amount
                    </button>
                    <button
                      type="button"
                      onClick={handleCancelPostingForm}
                      className="btn-secondary focus-ring"
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              )}
            </div>
        </div>
          </div>
      </div>
      )}

      {/* Create/Edit Modal */}
      {isCreateModalOpen && (
        <div className="fixed inset-0 z-50 overflow-y-auto bg-black/60 px-4 py-6">
          <div className="min-h-full flex items-center justify-center">
          <div className="bg-surface p-6 w-full max-w-xl">
            <div className="flex items-start justify-between mb-4">
              <div>
                <h2 className="text-xl font-semibold text-ink">
              {editingTransaction ? 'Edit Transaction' : 'Create Transaction'}
            </h2>
                <p className="text-sm text-muted mt-1">
                  {formData.transaction_type === 'transfer'
                    ? 'Move funds between your accounts and optionally include fees.'
                    : 'Log income, expenses, and projections to keep budgets on track.'}
                </p>
              </div>
              <button
                onClick={() => {
                  setIsCreateModalOpen(false)
                  resetForm()
                }}
                className="text-muted hover:text-body transition-colors duration-200"
                aria-label="Close transaction modal"
              >
                <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>

            <form onSubmit={handleSubmit} className="space-y-5">
              <div>
                <label className="label">Description</label>
                <input
                  type="text"
                  value={formData.description}
                  onChange={(e) =>
                    setFormData((prev) => ({
                      ...prev,
                      description: e.target.value,
                    }))
                  }
                  className="input-field focus-ring"
                  placeholder="Add notes about this transaction"
                  required
                />
              </div>
              <div>
                <label className="label">
                  {formData.transaction_type === 'transfer' ? 'From Account' : 'Account'}
                </label>
                <div className="flex flex-wrap gap-2">
                  {writableAccounts.map((account) => {
                    const isSelected = formData.account_id === account.id
                    return (
                      <button
                        type="button"
                        key={account.id}
                        onClick={() => handleAccountSelect(account.id)}
                        className={`rounded-full px-3 py-1.5 text-sm font-medium transition ${ isSelected ? 'bg-ink text-paper' : 'bg-sunken text-body hover:bg-sunken' }`}
                      >
                        {account.name}
                        <span className="ml-2 text-xs font-normal">
                          ({account.currency})
                        </span>
                      </button>
                    )
                  })}
                </div>
                <p className="mt-2 text-xs text-muted">
                  {formData.transaction_type === 'transfer'
                    ? 'Funds will move out of this account.'
                    : 'This is the account where the transaction will be recorded.'}
                </p>
                {formData.account_id !== 0 && (
                  <p className="mt-1 text-xs text-muted">
                    Recording in {formData.currency} ({formCurrencySymbol})
                  </p>
                )}
              </div>
              
              {formData.transaction_type === 'transfer' && (
              <div>
                  <label className="label">Destination Account</label>
                  <div className="flex flex-wrap gap-2">
                    {transferDestinationOptions.length === 0 && (
                      <p className="text-sm text-muted">Select a different source account to see destinations.</p>
                    )}
                    {transferDestinationOptions.map((account) => {
                      const isSelected = formData.transfer_to_account_id === account.id
                      return (
                        <button
                          type="button"
                          key={account.id}
                          onClick={() =>
                            setFormData((prev) => ({
                              ...prev,
                              transfer_to_account_id: isSelected ? undefined : account.id,
                              transfer_fee: isSelected
                                ? prev.transfer_fee
                                : destinationTransferFee(account, prev.transfer_fee),
                            }))
                          }
                          className={`rounded-full px-3 py-1.5 text-sm font-medium transition ${ isSelected ? 'bg-ink text-paper' : 'bg-sunken text-body hover:bg-sunken' }`}
                        >
                          {account.name}
                          <span className="ml-2 text-xs font-normal">({account.currency})</span>
                        </button>
                      )
                    })}
                  </div>
                </div>
              )}
              
              {editingTransaction && isSharedFull(editingTransaction) ? (
                <div>
                  <label className="label">Category</label>
                  <p className="text-sm text-body" data-testid="shared-category">
                    {editingTransaction.category_name || 'Uncategorized'}
                  </p>
                  <p className="mt-1 text-xs text-muted">
                    The category belongs to {editingTransaction.created_by ?? 'the person who recorded this'} and
                    can&apos;t be changed here.
                  </p>
                </div>
              ) : (
              <div>
                <label className="label">
                  {formData.transaction_type === 'transfer' ? 'Contribution category' : 'Category'}
                </label>
                <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    onClick={() =>
                      setFormData((prev) => ({
                        ...prev,
                        category_id: undefined,
                      }))
                    }
                    className={`rounded-full px-3 py-1.5 text-sm font-medium transition ${ formData.category_id === undefined ? 'bg-ink text-paper' : 'bg-sunken text-body hover:bg-sunken' }`}
                  >
                    {formData.transaction_type === 'transfer' ? 'None' : 'Uncategorized'}
                  </button>
                  {visibleCategories.map((category) => {
                    const isSelected = formData.category_id === category.id
                    return (
                      <button
                        type="button"
                        key={category.id}
                        onClick={() =>
                          setFormData((prev) => ({
                            ...prev,
                            category_id: category.id,
                          }))
                        }
                        className={`rounded-full px-3 py-1.5 text-sm font-medium transition ${ isSelected ? 'bg-ink text-paper' : 'bg-sunken text-body hover:bg-sunken' }`}
                      >
                    {category.name}
                      </button>
                    )
                  })}
                </div>
                <p className="mt-2 text-xs text-muted">
                  {formData.transaction_type === 'transfer'
                    ? 'Tag this move (e.g. Savings, Investments) to track contributions. It stays out of income and expense totals.'
                    : `Showing ${TRANSACTION_TYPE_LABELS[formData.transaction_type].toLowerCase()} categories.`}
                </p>
              </div>
              )}

              <div>
                <label className="label">Transaction Type</label>
                <div className="flex flex-wrap gap-2">
                  {transactionTypeOptions.map((option) => {
                    const isSelected = formData.transaction_type === option.value
                    return (
                      <button
                        type="button"
                        key={option.value}
                        onClick={() => handleTypeChange(option.value)}
                        className={`rounded-full px-3 py-1.5 text-sm font-medium capitalize transition ${ isSelected ? 'bg-ink text-paper' : 'bg-sunken text-body hover:bg-sunken' }`}
                      >
                        {option.label}
                      </button>
                    )
                  })}
                </div>
                {contextHint && (
                  <div className="mt-3 flex items-start gap-2 border border-line px-3 py-2 text-xs text-ink">
                    <svg className="mt-0.5 h-4 w-4 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                    </svg>
                    <div className="space-y-1">
                      <p>{contextHint.text}</p>
                      {contextHint.suggestTransfer && (
                        <button
                          type="button"
                          onClick={() => handleTypeChange('transfer')}
                          className="font-semibold text-ink underline-offset-2 hover:underline"
                        >
                          Switch to Transfer
                        </button>
                      )}
                    </div>
                  </div>
                )}
              </div>

              {!formData.is_posted && (
                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                  <div>
                    <label className="label">{crossCurrencyTransfer ? `Amount sent (${formData.currency})` : 'Amount'}</label>
                    <div className="relative">
                      <span className="absolute inset-y-0 left-0 pl-3 flex items-center text-muted text-sm">
                        {projectedCurrencySymbol}
                      </span>
                      <input
                        type="number"
                        step="0.01"
                        min="0"
                        value={formData.projected_amount ?? ''}
                        onChange={(e) => {
                          const value = parseFloat(e.target.value)
                          setFormData((prev) => ({
                            ...prev,
                            projected_amount: Number.isNaN(value) ? undefined : value,
                          }))
                        }}
                        className="input-field pl-7 focus-ring"
                        placeholder="0.00"
                  required
                      />
                    </div>
                  </div>
                  <div>
                    <label className="label">Currency</label>
                    <select
                      value={formData.projected_currency ?? formData.currency}
                      onChange={(e) =>
                        setFormData((prev) => ({
                          ...prev,
                          projected_currency: e.target.value as CurrencyCode,
                        }))
                      }
                      className="select-field focus-ring"
                    >
                      {currencyOptions.map((currency) => (
                        <option key={currency} value={currency}>
                          {currency}
                        </option>
                      ))}
                </select>
              </div>
                </div>
              )}
              
              {crossCurrencyTransfer && (
              <div>
                  <label className="label" htmlFor="transfer-received">Amount received ({destinationCurrency})</label>
                  <div className="relative">
                    <span className="absolute inset-y-0 left-0 pl-3 flex items-center text-muted text-sm">
                      {getCurrencySymbol(destinationCurrency)}
                    </span>
                    <input
                      id="transfer-received"
                      type="number"
                      step="0.01"
                      min="0"
                      value={formData.received_amount ?? ''}
                      onChange={(e) => {
                        const value = parseFloat(e.target.value)
                        setFormData((prev) => ({
                          ...prev,
                          received_amount: Number.isNaN(value) ? undefined : value,
                        }))
                      }}
                      className="input-field pl-7 focus-ring"
                      placeholder="0.00"
                      required={formData.is_posted}
                    />
                  </div>
                  <p className="mt-1 text-xs text-muted">
                    What lands in the destination, in {destinationCurrency}. {formData.is_posted ? 'Required to post a transfer between currencies.' : 'Needed before this transfer can be posted; until then the projection estimates it.'}
                  </p>
                </div>
              )}

              {formData.transaction_type === 'transfer' && (
              <div>
                  <label className="label">{transferIntoLoan ? 'Interest' : 'Transfer Fee'}</label>
                  <div className="relative">
                    <span className="absolute inset-y-0 left-0 pl-3 flex items-center text-muted text-sm">
                      {formCurrencySymbol}
                    </span>
                <input
                  type="number"
                  step="0.01"
                  min="0"
                      value={formData.transfer_fee ?? ''}
                      onChange={(e) => {
                        const value = parseFloat(e.target.value)
                        setFormData((prev) => ({
                          ...prev,
                          transfer_fee: Number.isNaN(value) ? undefined : value,
                        }))
                      }}
                      className="input-field pl-7 focus-ring"
                      placeholder="0.00"
                />
              </div>
                  <p className="mt-1 text-xs text-muted">
                    {transferIntoLoan
                      ? "The interest part of this payment. Leave blank to split the amount at the loan's rate."
                      : 'Automatically deducted from the source account. Default is 0.'}
                  </p>
                </div>
              )}
              
              {formData.is_posted && (
              <div>
                  <label className="label">{crossCurrencyTransfer ? `Amount sent (${formData.currency})` : 'Amount'}</label>
                  <div className="relative">
                    <span className="absolute inset-y-0 left-0 pl-3 flex items-center text-muted text-sm">
                      {formCurrencySymbol}
                    </span>
                <input
                      type="number"
                      step="0.01"
                      min="0"
                      value={formData.amount ?? ''}
                      onChange={(e) => {
                        const value = parseFloat(e.target.value)
                        setFormData((prev) => ({
                          ...prev,
                          amount: Number.isNaN(value) ? undefined : value,
                        }))
                      }}
                      className="input-field pl-7 focus-ring"
                      placeholder="0.00"
                  required
                />
              </div>
                </div>
              )}
              
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                  <label className="label">Transaction Date</label>
                <input
                  type="date"
                  value={formData.transaction_date}
                    onChange={(e) =>
                      setFormData((prev) => ({
                        ...prev,
                        transaction_date: e.target.value,
                      }))
                    }
                    className="input-field focus-ring"
                  required
                />
              </div>
              <div>
                  <label className="label">Posting Date (optional)</label>
                <input
                  type="date"
                  value={formData.posting_date || ''}
                    onChange={(e) =>
                      setFormData((prev) => ({
                        ...prev,
                        posting_date: e.target.value || undefined,
                      }))
                    }
                    className="input-field focus-ring disabled:cursor-not-allowed disabled:bg-sunken disabled:text-muted"
                    disabled={!formData.is_posted}
                  />
                </div>
              </div>
              
              <div className="flex flex-wrap gap-4">
                <label className="inline-flex items-center gap-2 text-sm text-body cursor-pointer">
                  <input
                    type="checkbox"
                    className="border-line text-ink"
                    checked={formData.is_posted}
                    onChange={(e) => {
                      const checked = e.target.checked
                      const today = localToday()
                      setFormData((prev) => ({
                        ...prev,
                        is_posted: checked,
                        posting_date: checked ? prev.posting_date ?? today : undefined,
                        amount: checked ? prev.amount ?? prev.projected_amount : prev.amount,
                      }))
                    }}
                  />
                  <span>Mark as posted</span>
                </label>
              </div>

              {(!editingTransaction || editingTransaction.permissions.can_tag) && (
                <TagPicker
                  value={formData.tag_ids}
                  onChange={(tag_ids) => setFormData((prev) => ({ ...prev, tag_ids }))}
                />
              )}

              {formData.transaction_type !== 'transfer' && !(editingTransaction && isSharedFull(editingTransaction)) && (
                <div className="space-y-3">
                  <label className="label">Recurring entry (optional)</label>
                  <p className="text-xs text-muted">Link this to one of your recurring income or expenses.</p>
                  {matchingBudgetEntries.length === 0 ? (
                    <p className="text-sm text-muted">No recurring entries of this type yet.</p>
                  ) : (
                    <select
                      className="input-field focus-ring"
                      value={formData.budget_entry_id ?? ''}
                      onChange={(event) => {
                        const value = event.target.value
                        if (!value) {
                          handleBudgetEntrySelect(undefined)
                          return
                        }
                        const entryId = Number(value)
                        const entry = matchingBudgetEntries.find((candidate) => candidate.id === entryId)
                        handleBudgetEntrySelect(entry ?? undefined)
                      }}
                    >
                      <option value="">None</option>
                      {matchingBudgetEntries.map((entry) => (
                        <option key={entry.id} value={entry.id}>
                          {entry.name} • {RECURRENCE_LABELS[entry.cadence]} • {formatCurrency(entry.amount, entry.currency)}
                        </option>
                      ))}
                    </select>
                  )}
                  {selectedBudgetEntry && (
                    <div className="bg-sunken p-3 text-xs text-body space-y-1">
                      <p className="font-semibold text-ink">{selectedBudgetEntry.name}</p>
                      <p>Cadence: {RECURRENCE_LABELS[selectedBudgetEntry.cadence]}</p>
                      <p>Next due: {formatEntryDate(selectedBudgetEntry.next_occurrence)}</p>
                      <p>Amount: {formatCurrency(selectedBudgetEntry.amount, selectedBudgetEntry.currency)}</p>
                      {selectedBudgetEntry.is_autopay && <p>Autopay enabled</p>}
                    </div>
                  )}
                </div>
              )}
              
              <div className="flex space-x-3 pt-2">
                <button type="submit" className="flex-1 btn-primary focus-ring">
                  {editingTransaction ? 'Update Transaction' : 'Create Transaction'}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setIsCreateModalOpen(false)
                    resetForm()
                  }}
                  className="flex-1 btn-secondary focus-ring"
                >
                  Cancel
                </button>
              </div>
            </form>
          </div>
          </div>
        </div>
      )}
    </div>
  )
}
