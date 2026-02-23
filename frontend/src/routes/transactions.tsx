import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useLazyGetTransactionsQuery, useGetAccountsQuery, useGetCategoriesQuery, useGetBudgetEntriesQuery, useCreateTransactionMutation, useUpdateTransactionMutation, useDeleteTransactionMutation } from '../store/api'
import { useState, useEffect, useMemo, useRef, useCallback } from 'react'
import type { Transaction, BudgetEntry } from '../store/api'
import { useAuth } from '../contexts/AuthContext'
import { formatCurrency, getCurrencySymbol, CurrencyCode, CURRENCY_CONFIGS } from '../utils/currency'

const TRANSACTION_TYPE_LABELS: Record<Transaction['transaction_type'], string> = {
  credit: 'Income',
  debit: 'Expense',
  transfer: 'Transfer',
}

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

const getMonthStart = (date: Date) => new Date(date.getFullYear(), date.getMonth(), 1)

const getMonthEnd = (date: Date) => new Date(date.getFullYear(), date.getMonth() + 1, 0)

const isSameMonth = (a: Date, b: Date) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth()

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
  transfer_fee: number
  description: string
  transaction_type: Transaction['transaction_type']
  transaction_date: string
  posting_date?: string
  is_posted: boolean
  transfer_from_account_id?: number
  transfer_to_account_id?: number
}

type PostingFormState = {
  visible: boolean
  amount: string
  error: string | null
  projectedAmount: number | null
  projectedCurrency: CurrencyCode
  accountCurrency: CurrencyCode
  needsConversion: boolean
}

export function TransactionsPage() {
  const { user, isAuthenticated, isLoading: authLoading } = useAuth()
  const navigate = useNavigate()
  const fallbackCurrency = (user?.default_currency as CurrencyCode) || 'PHP'

  useEffect(() => {
    if (!authLoading && !isAuthenticated) {
      navigate({ to: '/login' })
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
    transfer_fee: 0,
    description: '',
    transaction_type: 'debit',
    transaction_date: new Date().toISOString().split('T')[0],
    posting_date: undefined,
    is_posted: true,
    transfer_from_account_id: undefined,
    transfer_to_account_id: undefined,
    ...overrides,
  })

  const [isCreateModalOpen, setIsCreateModalOpen] = useState(false)
  const [editingTransaction, setEditingTransaction] = useState<Transaction | null>(null)
  const [isActionModalOpen, setIsActionModalOpen] = useState(false)
  const [actionTransaction, setActionTransaction] = useState<Transaction | null>(null)
  const [postingFormState, setPostingFormState] = useState<PostingFormState>({
    visible: false,
    amount: '',
    error: null,
    projectedAmount: null,
    projectedCurrency: fallbackCurrency,
    accountCurrency: fallbackCurrency,
    needsConversion: false,
  })
  const [searchTerm, setSearchTerm] = useState('')
  const [showFilters, setShowFilters] = useState(false)
  const [selectedAccountIds, setSelectedAccountIds] = useState<number[]>([])
  const [selectedCategoryIds, setSelectedCategoryIds] = useState<number[]>([])
  const [selectedTypes, setSelectedTypes] = useState<Transaction['transaction_type'][]>([])
  const resetPostingFormState = useCallback(() => {
    setPostingFormState({
      visible: false,
      amount: '',
      error: null,
      projectedAmount: null,
      projectedCurrency: fallbackCurrency,
      accountCurrency: fallbackCurrency,
      needsConversion: false,
    })
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
    setSelectedAccountIds([])
    setSelectedCategoryIds([])
    setSelectedTypes([])
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
          selectedCategoryIds.length ||
          selectedTypes.length ||
          isCustomRange ||
          startDate !== defaultMonthStartString ||
          endDate !== defaultMonthEndString
      ),
    [
      searchTerm,
      selectedAccountIds,
      selectedCategoryIds,
      selectedTypes,
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

  const toggleCategoryFilter = useCallback((id: number) => {
    setSelectedCategoryIds((prev) =>
      prev.includes(id) ? prev.filter((value) => value !== id) : [...prev, id]
    )
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

  const toISODateTime = useCallback((dateValue: string, endOfDay = false) => {
    if (!dateValue) {
      return undefined
    }
    const [year, month, day] = dateValue.split('-').map(Number)
    if (!year || !month || !day) {
      return undefined
    }
    const date = new Date(year, month - 1, day, endOfDay ? 23 : 0, endOfDay ? 59 : 0, endOfDay ? 59 : 0, endOfDay ? 999 : 0)
    return date.toISOString()
  }, [])
 
  const [triggerTransactions] = useLazyGetTransactionsQuery()
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
  const categories = useMemo(() => categoriesData ?? [], [categoriesData])
  const budgetEntries = useMemo(() => budgetEntriesData?.items ?? [], [budgetEntriesData])
  const limit = 10
  const [transactions, setTransactions] = useState<Transaction[]>([])
  const [totalTransactions, setTotalTransactions] = useState(0)
  const [hasMoreTransactions, setHasMoreTransactions] = useState(true)
  const offsetRef = useRef(0)
  const loadMoreObserver = useRef<IntersectionObserver | null>(null)
  const [isInitialLoading, setIsInitialLoading] = useState(true)
  const [isFetchingMore, setIsFetchingMore] = useState(false)

  const loadTransactions = useCallback(
    async (reset = false) => {
      if (!isAuthenticated) {
        return
      }

      const nextOffset = reset ? 0 : offsetRef.current
      const params: {
        account_ids?: number[]
        category_ids?: number[]
        allocation_id?: number
        transaction_types?: string[]
        start_date?: string
        end_date?: string
        search?: string
        limit: number
        offset: number
      } = {
        limit,
        offset: nextOffset,
      }
      if (selectedAccountIds.length > 0) {
        params.account_ids = selectedAccountIds
      }
      if (selectedTypes.length > 0) {
        params.transaction_types = selectedTypes
      }
      if (selectedCategoryIds.length > 0) {
        params.category_ids = selectedCategoryIds
      }
      if (searchTerm.trim()) {
        params.search = searchTerm.trim()
      }
      if (startDate) {
        const isoStart = toISODateTime(startDate)
        if (isoStart) {
          params.start_date = isoStart
        }
      }
      if (endDate) {
        const isoEnd = toISODateTime(endDate, true)
        if (isoEnd) {
          params.end_date = isoEnd
        }
      }

      try {
        if (reset) {
          offsetRef.current = 0
          setIsInitialLoading(true)
          setTransactions([])
        } else {
          setIsFetchingMore(true)
        }

        const result = await triggerTransactions(params).unwrap()
        offsetRef.current = nextOffset + result.items.length
        setTransactions((prev) => (reset ? result.items : [...prev, ...result.items]))
        setTotalTransactions(result.total)
        setHasMoreTransactions(result.has_more)
      } catch (error) {
        console.error('Error loading transactions:', error)
        if (reset) {
          setTransactions([])
          setTotalTransactions(0)
          setHasMoreTransactions(false)
        }
      } finally {
        if (reset) {
          setIsInitialLoading(false)
        } else {
          setIsFetchingMore(false)
        }
      }
    },
    [
      selectedAccountIds,
      selectedTypes,
      selectedCategoryIds,
      searchTerm,
      startDate,
      endDate,
      toISODateTime,
      triggerTransactions,
      isAuthenticated,
    ]
  )

  useEffect(() => {
    if (authLoading || !isAuthenticated) {
      return
    }
    loadTransactions(true)
  }, [authLoading, isAuthenticated, loadTransactions])

  useEffect(() => {
    if (!isActionModalOpen) {
      resetPostingFormState()
    }
  }, [isActionModalOpen, resetPostingFormState])

  useEffect(() => {
    return () => {
      loadMoreObserver.current?.disconnect()
    }
  }, [])

  const sentinelRef = useCallback(
    (node: HTMLDivElement | null) => {
      if (loadMoreObserver.current) {
        loadMoreObserver.current.disconnect()
      }
      if (!node) {
        return
      }

      loadMoreObserver.current = new IntersectionObserver((entries) => {
        if (entries[0]?.isIntersecting && hasMoreTransactions && !isFetchingMore && !isInitialLoading) {
          loadTransactions(false)
        }
      })

      loadMoreObserver.current.observe(node)
    },
    [hasMoreTransactions, isFetchingMore, isInitialLoading, loadTransactions]
  )

  const transferDestinationOptions = useMemo(
    () =>
      accounts.filter(
        (account) =>
          account.id !== (formData.transfer_from_account_id ?? formData.account_id) && account.id !== 0
      ),
    [accounts, formData.account_id, formData.transfer_from_account_id]
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

  const isLoading = isInitialLoading || isAccountsLoading || isCategoriesLoading || budgetEntriesLoading

  const orderedTransactions = useMemo(() => {
    const posted = transactions.filter((transaction) => transaction.is_posted)
    const pending = transactions.filter((transaction) => !transaction.is_posted)
    return [...posted, ...pending]
  }, [transactions])

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

      return {
        ...prev,
        transaction_type: nextType,
        budget_entry_id: nextBudgetEntryId,
        category_id: nextType === 'transfer' ? undefined : prev.category_id,
        allocation_id: nextType === 'transfer' ? undefined : prev.allocation_id,
        transfer_fee: nextType === 'transfer' ? prev.transfer_fee : 0,
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
    setActionTransaction(transaction)
    setIsActionModalOpen(true)
  }

  const closeActionModal = () => {
    setIsActionModalOpen(false)
    setActionTransaction(null)
    resetPostingFormState()
  }

  const resetForm = () => {
    setFormData(createInitialFormState())
    setEditingTransaction(null)
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
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

      const payload: Record<string, unknown> = {
        account_id: formData.account_id,
        amount: actualAmount,
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
        transfer_fee: formData.transaction_type === 'transfer' ? formData.transfer_fee || 0 : 0,
        transfer_from_account_id:
          formData.transaction_type === 'transfer'
            ? formData.transfer_from_account_id ?? formData.account_id
            : undefined,
        transfer_to_account_id:
          formData.transaction_type === 'transfer' ? formData.transfer_to_account_id : undefined,
        category_id: formData.transaction_type === 'transfer' ? undefined : formData.category_id,
        allocation_id: formData.transaction_type === 'transfer' ? undefined : formData.allocation_id,
        budget_entry_id: formData.transaction_type === 'transfer' ? undefined : formData.budget_entry_id,
        projected_amount: projectedAmount ?? undefined,
        projected_currency: projectedCurrency,
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
      
      if (editingTransaction) {
        await updateTransaction({ id: editingTransaction.id, data: payload }).unwrap()
        setEditingTransaction(null)
      } else {
        await createTransaction(payload).unwrap()
      }
      resetForm()
      setIsCreateModalOpen(false)
      await loadTransactions(true)
    } catch (error) {
      console.error('Error saving transaction:', error)
    }
  }

  const handleEdit = (transaction: Transaction) => {
    setEditingTransaction(transaction)
    setFormData(
      createInitialFormState({
      account_id: transaction.account_id,
        category_id: transaction.category_id ?? undefined,
        allocation_id: transaction.allocation_id ?? undefined,
        budget_entry_id: transaction.budget_entry_id ?? undefined,
      amount: transaction.amount,
        currency: (transaction.currency as CurrencyCode) || fallbackCurrency,
        projected_amount: transaction.projected_amount ?? undefined,
        projected_currency:
          (transaction.projected_currency as CurrencyCode) ||
          (transaction.currency as CurrencyCode) ||
          fallbackCurrency,
        original_amount: transaction.original_amount ?? undefined,
        original_currency: (transaction.original_currency as CurrencyCode) ?? undefined,
        exchange_rate: transaction.exchange_rate ?? undefined,
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
        await loadTransactions(true)
      } catch (error) {
        console.error('Error deleting transaction:', error)
      }
    }
  }

  const handleMarkPostedFromModal = async (transaction: Transaction, actualAmount: number, exchangeRate?: number) => {
    const account = accounts.find((item) => item.id === transaction.account_id)
    const accountCurrency = (account?.currency as CurrencyCode) || fallbackCurrency
    const timestamp = new Date().toISOString()
    const payload: Record<string, unknown> = {
      is_posted: true,
      posting_date: timestamp,
      amount: actualAmount,
      currency: accountCurrency,
      exchange_rate: exchangeRate,
    }
    await updateTransaction({ id: transaction.id, data: payload }).unwrap()
    const updatedTransaction: Transaction = {
      ...transaction,
      is_posted: true,
      posting_date: timestamp,
      amount: actualAmount,
      currency: accountCurrency,
      exchange_rate: exchangeRate,
    }
    setActionTransaction(updatedTransaction)
    setTransactions((prev) => prev.map((item) => (item.id === transaction.id ? updatedTransaction : item)))
    resetPostingFormState()
  }

  const handleRevertPostedFromModal = async (transaction: Transaction) => {
    const account = accounts.find((item) => item.id === transaction.account_id)
    const accountCurrency = (account?.currency as CurrencyCode) || fallbackCurrency
    const payload: Record<string, unknown> = {
      is_posted: false,
      posting_date: undefined,
      amount: transaction.projected_amount ?? transaction.amount,
      currency: accountCurrency,
      exchange_rate: undefined,
    }
    await updateTransaction({ id: transaction.id, data: payload }).unwrap()
    const updatedTransaction: Transaction = {
      ...transaction,
      is_posted: false,
      posting_date: undefined,
      amount: payload.amount as number,
      currency: accountCurrency,
      exchange_rate: undefined,
    }
    setActionTransaction(updatedTransaction)
    setTransactions((prev) => prev.map((item) => (item.id === transaction.id ? updatedTransaction : item)))
    resetPostingFormState()
  }

  const handleInitPostingForm = (transaction: Transaction) => {
    const account = accounts.find((item) => item.id === transaction.account_id)
    const accountCurrency = (account?.currency as CurrencyCode) || fallbackCurrency
    const projectedAmount = transaction.projected_amount ?? transaction.amount ?? null
    const projectedCurrency =
      (transaction.projected_currency as CurrencyCode) ??
      (transaction.currency as CurrencyCode) ??
      accountCurrency
    const needsConversion = projectedCurrency !== accountCurrency
    setPostingFormState({
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
    })
  }

  const handleSavePostingForm = async () => {
    if (!actionTransaction) {
      return
    }
    const parsed = parseFloat(postingFormState.amount)
    if (Number.isNaN(parsed) || parsed <= 0) {
      setPostingFormState((prev) => ({
        ...prev,
        error: 'Please enter a valid amount greater than zero.',
      }))
      return
    }
    const projectedAmount = postingFormState.projectedAmount
    const exchangeRate =
      projectedAmount && projectedAmount > 0 ? parsed / projectedAmount : undefined
    await handleMarkPostedFromModal(actionTransaction, parsed, exchangeRate)
    resetPostingFormState()
  }

  const handleCancelPostingForm = () => {
    resetPostingFormState()
  }

  const openEditFromModal = (transaction: Transaction) => {
    closeActionModal()
    handleEdit(transaction)
  }

  const getTransactionMeta = useCallback(
    (transaction: Transaction) => {
      const primaryAccount = accounts.find((a) => a.id === transaction.account_id)
      const fromAccount = transaction.transfer_from_account_id
        ? accounts.find((a) => a.id === transaction.transfer_from_account_id)
        : undefined
      const toAccount = transaction.transfer_to_account_id
        ? accounts.find((a) => a.id === transaction.transfer_to_account_id)
        : undefined
      const currencyCode = (transaction.currency as CurrencyCode) || fallbackCurrency
      const amountLabel = formatCurrency(transaction.amount, currencyCode)
      const projectedLabel =
        !transaction.is_posted && transaction.projected_amount && transaction.projected_currency
          ? formatCurrency(transaction.projected_amount, transaction.projected_currency as CurrencyCode)
          : null
      const transferFeeLabel =
        transaction.transfer_fee && transaction.transfer_fee > 0
          ? formatCurrency(transaction.transfer_fee, currencyCode)
          : null
      const typeBadgeStyles =
        transaction.transaction_type === 'credit'
          ? 'bg-green-100 dark:bg-green-900/50 text-green-700 dark:text-green-300'
          : transaction.transaction_type === 'debit'
          ? 'bg-red-100 dark:bg-red-900/50 text-red-700 dark:text-red-300'
          : 'bg-blue-100 dark:bg-blue-900/50 text-blue-700 dark:text-blue-300'
      const amountClass =
        transaction.transaction_type === 'credit'
          ? 'text-green-600'
          : transaction.transaction_type === 'debit'
          ? 'text-red-600'
          : 'text-blue-600'
      const category = transaction.category_id
        ? categories.find((cat) => cat.id === transaction.category_id)
        : undefined
      const budgetEntry = transaction.budget_entry_id
        ? budgetEntries.find((entry) => entry.id === transaction.budget_entry_id)
        : undefined
      const scheduleLabel = budgetEntry
        ? `${budgetEntry.name} • ${RECURRENCE_LABELS[budgetEntry.cadence]}`
        : null

      return {
        primaryAccount,
        fromAccount,
        toAccount,
        category,
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
    return {
      transactionDate: formatDateWithOrdinal(new Date(actionTransaction.transaction_date)),
      transactionRelative: formatRelativeDate(actionTransaction.transaction_date),
      postingDate: actionTransaction.posting_date
        ? formatDateWithOrdinal(new Date(actionTransaction.posting_date))
        : 'Pending',
      postingRelative: actionTransaction.posting_date ? formatRelativeDate(actionTransaction.posting_date) : null,
      typeLabel: TRANSACTION_TYPE_LABELS[actionTransaction.transaction_type],
    }
  }, [actionTransaction])

  const actionMeta = useMemo(() => (actionTransaction ? getTransactionMeta(actionTransaction) : null), [actionTransaction, getTransactionMeta])

  const actionTransferMeta = useMemo(() => {
    if (!actionTransaction || actionTransaction.transaction_type !== 'transfer') {
      return null
    }
    return getTransactionMeta(actionTransaction)
  }, [actionTransaction, getTransactionMeta])

  const actionSchedule = actionMeta?.budgetEntry ?? null

  const handleBudgetEntrySelect = useCallback((entry: BudgetEntry | undefined) => {
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
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600"></div>
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
          <p className="text-gray-600 dark:text-gray-300 font-medium">Loading transactions...</p>
        </div>
      </div>
    )
  }

  const emptyState = (
    <div className="card p-6 text-center space-y-4">
      <div className="w-16 h-16 mx-auto rounded-full bg-gray-100 dark:bg-slate-700 flex items-center justify-center">
        <svg className="w-8 h-8 text-gray-400 dark:text-gray-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5H7a2 2 0 00-2 2v10a2 2 0 002 2h8a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-3 7h3m-3 4h3m-6-4h.01M9 16h.01" />
        </svg>
      </div>
      <div>
        <p className="text-lg font-semibold text-gray-900 dark:text-white">No transactions found</p>
        <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">
          {hasActiveFilters
            ? 'No transactions match the current filters. Try adjusting them or reset to see more.'
            : 'No activity recorded for this month yet. Add your first transaction to get started.'}
        </p>
      </div>
      <button
        onClick={() => setIsCreateModalOpen(true)}
        className="btn-primary focus-ring w-full sm:w-auto mx-auto"
      >
        Add Transaction
      </button>
    </div>
  )

  return (
    <div className="max-w-6xl mx-auto px-4 py-6 sm:px-6 lg:px-8 space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <h1 className="text-3xl font-bold text-gray-900 dark:text-white">Transactions</h1>
        <button
          onClick={() => setIsCreateModalOpen(true)}
          className="btn-primary focus-ring w-full sm:w-auto justify-center"
        >
          Add Transaction
        </button>
      </div>

      {/* Search and Filters */}
      <div className="card p-4 sm:p-6 space-y-4">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
          <div className="w-full lg:max-w-md">
            <label className="label">Search transactions</label>
            <div className="relative">
              <div className="pointer-events-none absolute inset-y-0 left-0 flex items-center pl-3">
                <svg className="h-5 w-5 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
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
                className="inline-flex items-center rounded-full border border-gray-200 bg-white dark:bg-slate-700 dark:border-slate-600 px-2.5 py-1.5 text-sm font-medium text-gray-700 dark:text-gray-200 transition hover:bg-gray-100 dark:hover:bg-slate-600 focus:outline-none focus:ring-2 focus:ring-blue-500"
                aria-label="View previous month"
              >
                <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
                </svg>
              </button>
              <span className="text-sm font-semibold text-gray-900 dark:text-white">{currentMonthLabel}</span>
              <button
                type="button"
                onClick={() => handleMonthChange('next')}
                className="inline-flex items-center rounded-full border border-gray-200 bg-white dark:bg-slate-700 dark:border-slate-600 px-2.5 py-1.5 text-sm font-medium text-gray-700 dark:text-gray-200 transition hover:bg-gray-100 dark:hover:bg-slate-600 focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:cursor-not-allowed disabled:opacity-60"
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
              onClick={() => setShowFilters((prev) => !prev)}
              className="inline-flex items-center justify-center gap-2 rounded-lg border border-gray-200 bg-white dark:bg-slate-700 dark:border-slate-600 px-3 py-2 text-sm font-semibold text-gray-700 dark:text-gray-200 transition hover:bg-gray-100 dark:hover:bg-slate-600 focus:outline-none focus:ring-2 focus:ring-blue-500"
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
            <p className="text-sm font-medium text-gray-700 dark:text-gray-200">Date range: {dateRangeSummary}</p>
            <p className="text-xs text-gray-500 dark:text-gray-400">
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
        {showFilters && (
          <div className="space-y-6">
            <div>
              <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-200">Accounts</h3>
              <div className="mt-2 flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={() => setSelectedAccountIds([])}
                  className={`rounded-full px-3 py-1.5 text-sm font-medium transition ${
                    selectedAccountIds.length === 0
                      ? 'bg-blue-600 text-white shadow-sm'
                      : 'bg-gray-100 dark:bg-slate-700 text-gray-700 dark:text-gray-200 hover:bg-gray-200 dark:hover:bg-slate-600'
                  }`}
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
                      className={`rounded-full px-3 py-1.5 text-sm font-medium transition ${
                        isSelected ? 'bg-blue-600 text-white shadow-sm' : 'bg-gray-100 dark:bg-slate-700 text-gray-700 dark:text-gray-200 hover:bg-gray-200 dark:hover:bg-slate-600'
                      }`}
                    >
                  {account.name}
                    </button>
                  )
                })}
          </div>
            </div>
          <div>
              <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-200">Transaction types</h3>
              <div className="mt-2 flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={() => setSelectedTypes([])}
                  className={`rounded-full px-3 py-1.5 text-sm font-medium transition ${
                    selectedTypes.length === 0
                      ? 'bg-blue-600 text-white shadow-sm'
                      : 'bg-gray-100 dark:bg-slate-700 text-gray-700 dark:text-gray-200 hover:bg-gray-200 dark:hover:bg-slate-600'
                  }`}
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
                      className={`rounded-full px-3 py-1.5 text-sm font-medium capitalize transition ${
                        isSelected ? 'bg-blue-600 text-white shadow-sm' : 'bg-gray-100 dark:bg-slate-700 text-gray-700 dark:text-gray-200 hover:bg-gray-200 dark:hover:bg-slate-600'
                      }`}
                    >
                      {option.label}
                    </button>
                  )
                })}
          </div>
        </div>
            <div>
              <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-200">Categories</h3>
              <div className="mt-2 flex flex-wrap gap-2">
            <button
                  type="button"
                  onClick={() => setSelectedCategoryIds([])}
                  className={`rounded-full px-3 py-1.5 text-sm font-medium transition ${
                    selectedCategoryIds.length === 0
                      ? 'bg-blue-600 text-white shadow-sm'
                      : 'bg-gray-100 dark:bg-slate-700 text-gray-700 dark:text-gray-200 hover:bg-gray-200 dark:hover:bg-slate-600'
                  }`}
                  disabled={selectedCategoryIds.length === 0}
                >
                  All categories
            </button>
                {categories.map((category) => {
                  const isSelected = selectedCategoryIds.includes(category.id)
                  return (
                    <button
                      type="button"
                      key={category.id}
                      onClick={() => toggleCategoryFilter(category.id)}
                      className={`rounded-full px-3 py-1.5 text-sm font-medium transition ${
                        isSelected ? 'bg-blue-600 text-white shadow-sm' : 'bg-gray-100 dark:bg-slate-700 text-gray-700 dark:text-gray-200 hover:bg-gray-200 dark:hover:bg-slate-600'
                      }`}
                    >
                      {category.name}
                    </button>
                  )
                })}
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
              <p className="text-xs text-gray-500 dark:text-gray-400">
                Month navigation will snap back to calendar months. Use reset to return to the current month view.
              </p>
            )}
                    </div>
        )}
      </div>

      {transactions.length === 0 ? (
        emptyState
      ) : (
        <>
          <div className="grid grid-cols-1 gap-3">
          {orderedTransactions.map((transaction) => {
            const {
              primaryAccount,
              fromAccount,
              toAccount,
              category,
              amountLabel,
              projectedLabel,
              transferFeeLabel,
              typeBadgeStyles,
              amountClass,
              scheduleLabel,
            } = getTransactionMeta(transaction)
            const relativeDate = formatRelativeDate(transaction.transaction_date)
            const exactDate = formatDateWithOrdinal(new Date(transaction.transaction_date))
            const postedDate = transaction.posting_date ? formatDateWithOrdinal(new Date(transaction.posting_date)) : null
            const typeLabel = TRANSACTION_TYPE_LABELS[transaction.transaction_type]
            const cardStateClasses = transaction.is_posted ? '' : 'bg-gray-50 dark:bg-slate-700/50 border border-gray-100 dark:border-slate-600'
            const description = transaction.description?.trim() || 'Untitled transaction'
                
                return (
              <article
                key={transaction.id}
                className={`card p-4 sm:p-5 transition-shadow duration-200 hover:shadow-lg focus-within:ring-2 focus-within:ring-blue-500 cursor-pointer ${cardStateClasses}`}
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
                      <div className="flex flex-wrap items-center gap-2 text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">
                        <span>{relativeDate}</span>
                        <span className="hidden md:inline text-gray-300 dark:text-gray-600">•</span>
                        <span className="text-gray-400 dark:text-gray-500">{exactDate}</span>
                      </div>
                      <p className="text-base font-semibold text-gray-900 dark:text-white">{description}</p>
                      <div className="flex flex-wrap gap-2 text-xs text-gray-600 dark:text-gray-300">
                        <span className="inline-flex items-center gap-1 rounded-full bg-gray-100 dark:bg-slate-700 px-2 py-1">
                          <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 10h18M7 15h1m4 0h1m-7 4h12a3 3 0 003-3V8a3 3 0 00-3-3H6a3 3 0 00-3 3v8a3 3 0 003 3z" />
                          </svg>
                          {transaction.transaction_type === 'transfer'
                            ? `${fromAccount?.name || primaryAccount?.name || 'Source'} → ${toAccount?.name || 'Destination'}`
                            : primaryAccount?.name || 'Account'}
                      </span>
                        <span className="inline-flex items-center gap-1 rounded-full bg-gray-100 dark:bg-slate-700 px-2 py-1">
                          <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h7" />
                          </svg>
                          {transaction.transaction_type === 'transfer' ? 'Transfer' : category?.name || 'Uncategorized'}
                      </span>
                        {scheduleLabel && (
                          <span className="inline-flex items-center gap-1 rounded-full bg-indigo-100 dark:bg-indigo-900/50 px-2 py-1 text-indigo-700 dark:text-indigo-300">
                            <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
                            </svg>
                            {scheduleLabel}
                          </span>
                        )}
                        {transferFeeLabel && (
                          <span className="inline-flex items-center gap-1 rounded-full bg-orange-100 dark:bg-orange-900/50 px-2 py-1 text-orange-700 dark:text-orange-300">
                            <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1" />
                            </svg>
                            Fee {transferFeeLabel}
                          </span>
                        )}
                        {projectedLabel && !transaction.is_posted && (
                          <span className="inline-flex items-center gap-1 rounded-full bg-sky-100 dark:bg-sky-900/50 px-2 py-1 text-sky-700 dark:text-sky-300">
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
                      {transaction.original_amount !== undefined && transaction.original_currency && (
                        <p className="text-xs text-gray-500 dark:text-gray-400">
                          Original {formatCurrency(transaction.original_amount, transaction.original_currency as CurrencyCode)}
                        </p>
                      )}
                      {postedDate && <p className="text-xs text-gray-500 dark:text-gray-400">Posted {postedDate}</p>}
                      <div className="flex flex-wrap justify-end gap-2">
                        <span className={`inline-flex rounded-full px-2 py-1 text-xs font-semibold ${typeBadgeStyles}`}>
                          {typeLabel}
                        </span>
                        <span
                          className={`inline-flex rounded-full px-2 py-1 text-xs font-semibold ${
                            transaction.is_posted ? 'bg-blue-100 dark:bg-blue-900/50 text-blue-700 dark:text-blue-300' : 'bg-gray-200 dark:bg-slate-600 text-gray-700 dark:text-gray-300'
                          }`}
                        >
                          {transaction.is_posted ? 'Posted' : 'Planned'}
                        </span>
                        {transaction.is_reconciled && (
                          <span className="inline-flex rounded-full px-2 py-1 text-xs font-semibold bg-emerald-100 dark:bg-emerald-900/50 text-emerald-700 dark:text-emerald-300">
                            Reconciled
                          </span>
                        )}
                      </div>
                    </div>
                  </div>
                </div>
              </article>
            )
          })}
          <div ref={sentinelRef} className="h-3" />
          {!isInitialLoading && (isFetchingMore || hasMoreTransactions) && (
            <p className="text-center text-xs text-gray-500 dark:text-gray-400 pb-2">
              {isFetchingMore ? 'Loading more transactions...' : 'Scroll for more transactions'}
            </p>
          )}
          {!isInitialLoading && !hasMoreTransactions && orderedTransactions.length === totalTransactions && totalTransactions > 0 && (
            <p className="text-center text-xs text-gray-400 dark:text-gray-500 pb-2">End of list</p>
          )}
          </div>
          <div className="flex justify-end px-1">
            <p className="text-xs text-gray-500 dark:text-gray-400">
              Showing {transactions.length} of {totalTransactions} transactions
            </p>
          </div>
        </>
      )}

      {isActionModalOpen && actionTransaction && (
        <div
          className="fixed inset-0 z-50 overflow-y-auto bg-black/60 px-4 py-6"
          onClick={closeActionModal}
        >
          <div className="min-h-full flex items-center justify-center">
          <div
            className="w-full max-w-2xl rounded-xl bg-white dark:bg-slate-800 p-6 shadow-2xl"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="flex items-start justify-between gap-4">
              <div>
                <h2 className="text-xl font-semibold text-gray-900 dark:text-white">Transaction Actions</h2>
                <p className="text-sm text-gray-500 dark:text-gray-400">
                  {actionTransaction.description || 'No description'}
                </p>
              </div>
                        <button
                onClick={closeActionModal}
                className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 transition-colors duration-200"
                aria-label="Close actions modal"
              >
                <svg className="h-6 w-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>

            <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div className="rounded-lg border border-gray-200 dark:border-slate-700 p-4">
                <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-200">Dates</h3>
                <dl className="mt-3 space-y-2 text-sm text-gray-600 dark:text-gray-300">
                  <div className="flex justify-between gap-3">
                    <dt>Transaction</dt>
                    <dd className="text-right">
                      {actionModalMeta?.transactionDate}
                      {actionModalMeta?.transactionRelative && (
                        <span className="ml-2 text-gray-400 dark:text-gray-500">({actionModalMeta.transactionRelative})</span>
                      )}
                    </dd>
                  </div>
                  <div className="flex justify-between gap-3">
                    <dt>Posting</dt>
                    <dd className="text-right">
                      {actionModalMeta?.postingDate}
                      {actionModalMeta?.postingRelative && (
                        <span className="ml-2 text-gray-400 dark:text-gray-500">({actionModalMeta.postingRelative})</span>
                      )}
                    </dd>
                  </div>
                </dl>
              </div>

              <div className="rounded-lg border border-gray-200 dark:border-slate-700 p-4">
                <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-200">Details</h3>
                <dl className="mt-3 space-y-2 text-sm text-gray-600 dark:text-gray-300">
                  <div className="flex justify-between">
                    <dt>Amount</dt>
                    <dd className={
                      actionTransaction.transaction_type === 'credit'
                        ? 'text-green-600 font-medium'
                        : actionTransaction.transaction_type === 'debit'
                        ? 'text-red-600 font-medium'
                        : 'text-blue-600 font-medium'
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
                    <dd className={actionTransaction.is_posted ? 'text-emerald-600 dark:text-emerald-400' : 'text-amber-600 dark:text-amber-400'}>
                      {actionTransaction.is_posted ? 'Posted' : 'Planned'}
                    </dd>
                  </div>
                  {actionTransaction.transaction_type === 'transfer' && (
                    <>
                      <div className="flex justify-between gap-3">
                        <dt>From</dt>
                        <dd className="text-right">
                          {actionTransferMeta?.fromAccount?.name || actionTransferMeta?.primaryAccount?.name || 'Source account'}
                        </dd>
                      </div>
                      <div className="flex justify-between gap-3">
                        <dt>To</dt>
                        <dd className="text-right">
                          {actionTransferMeta?.toAccount?.name || 'Destination account'}
                        </dd>
                      </div>
                      {actionTransferMeta?.transferFeeLabel && (
                        <div className="flex justify-between gap-3">
                          <dt>Transfer Fee</dt>
                          <dd className="text-right text-rose-600 dark:text-rose-400">{actionTransferMeta.transferFeeLabel}</dd>
                        </div>
                      )}
                    </>
                  )}
                  {actionSchedule && (
                    <>
                      <div className="flex justify-between gap-3">
                        <dt>Schedule</dt>
                        <dd className="text-right text-indigo-700 dark:text-indigo-300 font-medium">{actionSchedule.name}</dd>
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
                        <dd>{formatDateWithOrdinal(new Date(actionSchedule.next_occurrence))}</dd>
                      </div>
                      {actionSchedule.lead_time_days ? (
                        <div className="flex justify-between gap-3 text-xs text-gray-500 dark:text-gray-400">
                          <dt>Reminder</dt>
                          <dd>{actionSchedule.lead_time_days} day{actionSchedule.lead_time_days === 1 ? '' : 's'} before</dd>
                        </div>
                      ) : null}
                      {actionSchedule.is_autopay && (
                        <div className="flex justify-between gap-3 text-xs text-indigo-600 dark:text-indigo-400">
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
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                {actionTransaction.is_posted ? (
                  <button
                    onClick={() => handleRevertPostedFromModal(actionTransaction)}
                    className="flex items-center justify-center gap-2 rounded-lg px-4 py-3 text-sm font-semibold transition-colors duration-200 bg-amber-50 dark:bg-amber-900/30 text-amber-700 dark:text-amber-300 hover:bg-amber-100 dark:hover:bg-amber-900/50"
                  >
                    <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                    </svg>
                    Mark as Planned
                  </button>
                ) : (
                  <button
                    onClick={() => handleInitPostingForm(actionTransaction)}
                    className="flex items-center justify-center gap-2 rounded-lg px-4 py-3 text-sm font-semibold transition-colors duration-200 bg-emerald-50 dark:bg-emerald-900/30 text-emerald-700 dark:text-emerald-300 hover:bg-emerald-100 dark:hover:bg-emerald-900/50"
                  >
                    <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                    </svg>
                    Mark as Posted
                  </button>
                )}
                <button
                  onClick={() => openEditFromModal(actionTransaction)}
                  className="flex items-center justify-center gap-2 rounded-lg bg-blue-600 px-4 py-3 text-sm font-semibold text-white transition-colors duration-200 hover:bg-blue-700"
                >
                  <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
                          </svg>
                  Edit Transaction
                        </button>
                        <button
                  onClick={() => handleDelete(actionTransaction.id)}
                  className="flex items-center justify-center gap-2 rounded-lg bg-gray-100 dark:bg-slate-700 px-4 py-3 text-sm font-semibold text-gray-700 dark:text-gray-200 transition-colors duration-200 hover:bg-gray-200 dark:hover:bg-slate-600"
                        >
                  <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                          </svg>
                  Delete Transaction
                        </button>
                      </div>
              {!actionTransaction.is_posted && postingFormState.visible && (
                <div className="rounded-lg border border-blue-100 dark:border-blue-900/50 bg-blue-50 dark:bg-blue-900/20 p-4 space-y-3">
                  <p className="text-sm font-medium text-blue-900 dark:text-blue-200">
                    {postingFormState.projectedAmount
                      ? `Projected amount: ${formatCurrency(
                          postingFormState.projectedAmount,
                          postingFormState.projectedCurrency
                        )}`
                      : 'No projected amount recorded.'}
                  </p>
                  <p className="text-xs text-blue-800 dark:text-blue-300">
                    {postingFormState.needsConversion
                      ? `Enter the amount received in ${postingFormState.accountCurrency}. We will infer the exchange rate.`
                      : 'Verify the received amount. Update it only if the actual amount differs.'}
                  </p>
                  <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
                    <div className="flex-1">
                      <label className="label text-blue-900 dark:text-blue-200">Amount in {postingFormState.accountCurrency}</label>
                      <div className="relative">
                        <span className="absolute inset-y-0 left-0 pl-3 flex items-center text-blue-500 dark:text-blue-400 text-sm">
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
                      {postingFormState.error && (
                        <p className="mt-1 text-xs text-red-600">{postingFormState.error}</p>
                      )}
        </div>
                    {!postingFormState.needsConversion &&
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
                          className="rounded-lg bg-white dark:bg-slate-700 px-3 py-2 text-sm font-semibold text-blue-700 dark:text-blue-300 shadow hover:bg-blue-100 dark:hover:bg-slate-600"
                        >
                          Use projected amount
                        </button>
                      )}
      </div>
                  <div className="flex flex-wrap gap-2">
                    <button
                      type="button"
                      onClick={handleSavePostingForm}
                      className="btn-primary focus-ring"
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
          <div className="bg-white dark:bg-slate-800 rounded-xl p-6 w-full max-w-xl shadow-2xl">
            <div className="flex items-start justify-between mb-4">
              <div>
                <h2 className="text-xl font-semibold text-gray-900 dark:text-white">
              {editingTransaction ? 'Edit Transaction' : 'Create Transaction'}
            </h2>
                <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">
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
                className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 transition-colors duration-200"
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
                  {accounts.map((account) => {
                    const isSelected = formData.account_id === account.id
                    return (
                      <button
                        type="button"
                        key={account.id}
                        onClick={() => handleAccountSelect(account.id)}
                        className={`rounded-full px-3 py-1.5 text-sm font-medium transition ${
                          isSelected ? 'bg-blue-600 text-white shadow-sm' : 'bg-gray-100 dark:bg-slate-700 text-gray-700 dark:text-gray-200 hover:bg-gray-200 dark:hover:bg-slate-600'
                        }`}
                      >
                        {account.name}
                        <span className="ml-2 text-xs font-normal">
                          ({account.currency})
                        </span>
                      </button>
                    )
                  })}
                </div>
                <p className="mt-2 text-xs text-gray-500 dark:text-gray-400">
                  {formData.transaction_type === 'transfer'
                    ? 'Funds will move out of this account.'
                    : 'This is the account where the transaction will be recorded.'}
                </p>
                {formData.account_id !== 0 && (
                  <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                    Recording in {formData.currency} ({formCurrencySymbol})
                  </p>
                )}
              </div>
              
              {formData.transaction_type === 'transfer' && (
              <div>
                  <label className="label">Destination Account</label>
                  <div className="flex flex-wrap gap-2">
                    {transferDestinationOptions.length === 0 && (
                      <p className="text-sm text-gray-500 dark:text-gray-400">Select a different source account to see destinations.</p>
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
                            }))
                          }
                          className={`rounded-full px-3 py-1.5 text-sm font-medium transition ${
                            isSelected ? 'bg-blue-600 text-white shadow-sm' : 'bg-gray-100 dark:bg-slate-700 text-gray-700 dark:text-gray-200 hover:bg-gray-200 dark:hover:bg-slate-600'
                          }`}
                        >
                          {account.name}
                          <span className="ml-2 text-xs font-normal">({account.currency})</span>
                        </button>
                      )
                    })}
                  </div>
                </div>
              )}
              
              {formData.transaction_type !== 'transfer' && (
                <div>
                  <label className="label">Category</label>
                  <div className="flex flex-wrap gap-2">
                    <button
                      type="button"
                      onClick={() =>
                        setFormData((prev) => ({
                          ...prev,
                          category_id: undefined,
                        }))
                      }
                      className={`rounded-full px-3 py-1.5 text-sm font-medium transition ${
                          formData.category_id === undefined
                          ? 'bg-blue-600 text-white shadow-sm'
                          : 'bg-gray-100 dark:bg-slate-700 text-gray-700 dark:text-gray-200 hover:bg-gray-200 dark:hover:bg-slate-600'
                      }`}
                    >
                      Uncategorized
                    </button>
                    {categories.map((category) => {
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
                          className={`rounded-full px-3 py-1.5 text-sm font-medium transition ${
                            isSelected ? 'bg-blue-600 text-white shadow-sm' : 'bg-gray-100 dark:bg-slate-700 text-gray-700 dark:text-gray-200 hover:bg-gray-200 dark:hover:bg-slate-600'
                          }`}
                        >
                      {category.name}
                        </button>
                      )
                    })}
              </div>
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
                        className={`rounded-full px-3 py-1.5 text-sm font-medium capitalize transition ${
                          isSelected ? 'bg-blue-600 text-white shadow-sm' : 'bg-gray-100 dark:bg-slate-700 text-gray-700 dark:text-gray-200 hover:bg-gray-200 dark:hover:bg-slate-600'
                        }`}
                      >
                        {option.label}
                      </button>
                    )
                  })}
                </div>
              </div>

              {!formData.is_posted && (
                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                  <div>
                    <label className="label">Amount</label>
                    <div className="relative">
                      <span className="absolute inset-y-0 left-0 pl-3 flex items-center text-gray-500 dark:text-gray-400 text-sm">
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
              
              {formData.transaction_type === 'transfer' && (
              <div>
                  <label className="label">Transfer Fee</label>
                  <div className="relative">
                    <span className="absolute inset-y-0 left-0 pl-3 flex items-center text-gray-500 dark:text-gray-400 text-sm">
                      {formCurrencySymbol}
                    </span>
                <input
                  type="number"
                  step="0.01"
                  min="0"
                      value={formData.transfer_fee || ''}
                      onChange={(e) => {
                        const value = parseFloat(e.target.value)
                        setFormData((prev) => ({
                          ...prev,
                          transfer_fee: Number.isNaN(value) ? 0 : value,
                        }))
                      }}
                      className="input-field pl-7 focus-ring"
                      placeholder="0.00"
                />
              </div>
                  <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                    Automatically deducted from the source account. Default is 0.
                  </p>
                </div>
              )}
              
              {formData.is_posted && (
              <div>
                  <label className="label">Amount</label>
                  <div className="relative">
                    <span className="absolute inset-y-0 left-0 pl-3 flex items-center text-gray-500 dark:text-gray-400 text-sm">
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
                    className="input-field focus-ring disabled:cursor-not-allowed disabled:bg-gray-100 dark:disabled:bg-slate-700/50 disabled:text-gray-500 dark:disabled:text-gray-500"
                    disabled={!formData.is_posted}
                  />
                </div>
              </div>
              
              <div className="flex flex-wrap gap-4">
                <label className="inline-flex items-center gap-2 text-sm text-gray-700 dark:text-gray-200 cursor-pointer">
                  <input
                    type="checkbox"
                    className="rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                    checked={formData.is_posted}
                    onChange={(e) => {
                      const checked = e.target.checked
                      const today = new Date().toISOString().split('T')[0]
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

              {formData.transaction_type !== 'transfer' && (
                <div className="space-y-3">
                  <label className="label">Budget Schedule</label>
                  {matchingBudgetEntries.length === 0 ? (
                    <p className="text-sm text-gray-500 dark:text-gray-400">No active schedules available for this transaction type.</p>
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
                      <option value="">No schedule</option>
                      {matchingBudgetEntries.map((entry) => (
                        <option key={entry.id} value={entry.id}>
                          {entry.name} • {RECURRENCE_LABELS[entry.cadence]} • {formatCurrency(entry.amount, entry.currency)}
                        </option>
                      ))}
                    </select>
                  )}
                  {selectedBudgetEntry && (
                    <div className="rounded-lg bg-indigo-50 dark:bg-indigo-900/30 p-3 text-xs text-indigo-800 dark:text-indigo-300 space-y-1">
                      <p className="font-semibold text-indigo-900 dark:text-indigo-200">{selectedBudgetEntry.name}</p>
                      <p>Cadence: {RECURRENCE_LABELS[selectedBudgetEntry.cadence]}</p>
                      <p>Next due: {formatDateWithOrdinal(new Date(selectedBudgetEntry.next_occurrence))}</p>
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
