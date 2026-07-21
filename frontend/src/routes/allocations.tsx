import { createFileRoute, useNavigate } from '@tanstack/react-router'
import {
  useLazyGetAllocationsQuery,
  useLazyGetBudgetEntriesQuery,
  useGetAccountsQuery,
  useGetCategoriesQuery,
  useCreateAllocationMutation,
  useUpdateAllocationMutation,
  useDeleteAllocationMutation,
  useCreateBudgetEntryMutation,
  useUpdateBudgetEntryMutation,
  useDeleteBudgetEntryMutation,
} from '../store/api'
import type { Allocation, BudgetEntry, Account, Category, WishlistItem } from '../store/api'
import { useState, useEffect, useMemo, useRef, useCallback } from 'react'
import { useAuth } from '../contexts/AuthContext'
import { useCurrency } from '../hooks/useCurrency'
import { formatCurrency, CurrencyCode, CURRENCY_CONFIGS } from '../utils/currency'
import { WishlistPanel } from '../components/WishlistPanel'

const DAY_IN_MS = 24 * 60 * 60 * 1000

const startOfDay = (value: Date) => new Date(value.getFullYear(), value.getMonth(), value.getDate())

const differenceInDays = (future: Date, from: Date) =>
  Math.round((startOfDay(future).getTime() - startOfDay(from).getTime()) / DAY_IN_MS)

const getOrdinal = (day: number) => {
  if (day % 100 >= 11 && day % 100 <= 13) {
    return `${day}th`
  }
  const lastDigit = day % 10
  if (lastDigit === 1) return `${day}st`
  if (lastDigit === 2) return `${day}nd`
  if (lastDigit === 3) return `${day}rd`
  return `${day}th`
}

const formatFullDate = (isoString: string) => {
  const date = new Date(isoString)
  return `${date.toLocaleString('default', { month: 'short' })} ${getOrdinal(date.getDate())}, ${date.getFullYear()}`
}

const formatRelativeDate = (isoString: string) => {
  const target = new Date(isoString)
  const today = new Date()
  const days = differenceInDays(target, today)
  if (days === 0) return 'Today'
  if (days === 1) return 'Tomorrow'
  if (days === -1) return 'Yesterday'
  if (days > 0) return `In ${days} day${days === 1 ? '' : 's'}`
  return `${Math.abs(days)} day${days === -1 ? '' : 's'} ago`
}

const toLocalDateTimeInput = (value: Date | string) => {
  const date = typeof value === 'string' ? new Date(value) : value
  return new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16)
}

const formatCadenceLabel = (value: string) => {
  switch (value) {
    case 'daily':
      return 'Daily'
    case 'weekly':
      return 'Weekly'
    case 'monthly':
      return 'Monthly'
    case 'quarterly':
      return 'Quarterly'
    case 'semi_annual':
      return 'Semi-Annual'
    case 'annual':
      return 'Annual'
    default:
      return value
  }
}

const formatAmount = (amount: number, currency: CurrencyCode) => formatCurrency(amount, currency)

type AllocationGoalMode = 'target_balance' | 'multi_account' | 'transaction_total'
type BudgetCadence = 'daily' | 'weekly' | 'monthly' | 'quarterly'
const budgetCadenceOptions: BudgetCadence[] = ['daily', 'weekly', 'monthly', 'quarterly']

const formatBudgetCadenceLabel = (value?: string) => {
  switch (value) {
    case 'daily':
      return 'Daily'
    case 'weekly':
      return 'Weekly'
    case 'monthly':
      return 'Monthly'
    case 'quarterly':
      return 'Quarterly'
    default:
      return undefined
  }
}

const toDateInputValue = (date: Date) => {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

const addDays = (date: Date, days: number) => {
  const copy = new Date(date)
  copy.setDate(copy.getDate() + days)
  return copy
}

const getDefaultBudgetPeriod = (cadence: BudgetCadence): { start: string; end: string } => {
  const today = startOfDay(new Date())
  let start = today
  let end = today

  switch (cadence) {
    case 'daily': {
      start = today
      end = addDays(today, 1)
      break
    }
    case 'weekly': {
      const dayOfWeek = today.getDay()
      const weekStart = addDays(today, -dayOfWeek)
      start = weekStart
      end = addDays(weekStart, 7)
      break
    }
    case 'monthly': {
      start = new Date(today.getFullYear(), today.getMonth(), 1)
      end = new Date(today.getFullYear(), today.getMonth() + 1, 1)
      break
    }
    case 'quarterly': {
      const currentQuarter = Math.floor(today.getMonth() / 3)
      start = new Date(today.getFullYear(), currentQuarter * 3, 1)
      end = new Date(today.getFullYear(), currentQuarter * 3 + 3, 1)
      break
    }
    default:
      break
  }

  return {
    start: toDateInputValue(start),
    end: toDateInputValue(end),
  }
}

const computeBudgetPeriodEnd = (startValue: string, cadence: BudgetCadence): string | undefined => {
  if (!startValue) {
    return undefined
  }
  const base = startOfDay(new Date(startValue))
  if (Number.isNaN(base.getTime())) {
    return undefined
  }

  switch (cadence) {
    case 'daily':
      return toDateInputValue(addDays(base, 1))
    case 'weekly':
      return toDateInputValue(addDays(base, 7))
    case 'monthly':
      return toDateInputValue(new Date(base.getFullYear(), base.getMonth() + 1, base.getDate()))
    case 'quarterly':
      return toDateInputValue(new Date(base.getFullYear(), base.getMonth() + 3, base.getDate()))
    default:
      return undefined
  }
}

const formatDateLabel = (value?: string) => {
  if (!value) {
    return undefined
  }
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) {
    return value
  }
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
}

const formatBudgetPeriodEndLabel = (value?: string) => {
  if (!value) {
    return undefined
  }
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) {
    return value
  }
  date.setDate(date.getDate() - 1)
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
}

const isoToDateInput = (value?: string) => {
  if (!value) {
    return undefined
  }
  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime())) {
    return value.split('T')[0] ?? undefined
  }
  return toDateInputValue(parsed)
}

type AllocationFormState = {
  account_id: number
  name: string
  allocation_type: Allocation['allocation_type']
  description: string
  target_amount?: number
  current_amount: number
  monthly_target?: number
  target_date?: string
  is_active: boolean
  goal_mode: AllocationGoalMode
  period_frequency?: 'daily' | 'weekly' | 'monthly' | 'quarterly'
  period_start?: string
  period_end?: string
}

type SubscriptionFormState = {
  name: string
  description: string
  entry_type: 'income' | 'expense'
  amount: number
  currency: CurrencyCode
  account_id: number
  overflow_account_id?: number
  category_id?: number
  allocation_id?: number
  cadence: BudgetEntry['cadence']
  next_occurrence: string
  lead_time_days: number
  is_autopay: boolean
  is_active: boolean
  end_mode: 'indefinite' | 'on_date' | 'after_occurrences'
  end_date?: string
  max_occurrences?: number
}

export const Route = createFileRoute('/allocations')({
  component: AllocationsPage,
})

export function AllocationsPage() {
  const { isAuthenticated, isLoading: authLoading } = useAuth()
  const navigate = useNavigate()
  const { format, currencyCode: defaultCurrencyCode } = useCurrency()

  useEffect(() => {
    if (!authLoading && !isAuthenticated) {
      navigate({ to: '/login', search: { message: undefined } })
    }
  }, [isAuthenticated, authLoading, navigate])

  const [isCreateModalOpen, setIsCreateModalOpen] = useState(false)
  const [editingAllocation, setEditingAllocation] = useState<Allocation | null>(null)
  const [editingBudgetEntry, setEditingBudgetEntry] = useState<BudgetEntry | null>(null)
  const [isActionModalOpen, setIsActionModalOpen] = useState(false)
  const [actionAllocation, setActionAllocation] = useState<Allocation | null>(null)
  const [activeTab, setActiveTab] = useState<'subscriptions' | 'budgets' | 'savings' | 'wishlist'>('subscriptions')
  const [modalMode, setModalMode] = useState<'allocation' | 'subscription'>('allocation')
  const currencyOptions = useMemo(() => Object.keys(CURRENCY_CONFIGS) as CurrencyCode[], [])

  const createAllocationDefaults = useCallback(
    (type: 'budget' | 'savings'): AllocationFormState => {
      const defaultPeriod = getDefaultBudgetPeriod('monthly')
      const base: AllocationFormState = {
    account_id: 0,
    name: '',
        allocation_type: type === 'budget' ? 'budget' : 'savings',
    description: '',
        target_amount: undefined,
    current_amount: 0,
        monthly_target: undefined,
        target_date: undefined,
        is_active: true,
        goal_mode: 'target_balance',
        period_frequency: 'monthly',
        period_start: defaultPeriod.start,
        period_end: defaultPeriod.end,
      }

      if (type === 'budget') {
        const { start, end } = getDefaultBudgetPeriod('monthly')
        return {
          ...base,
          allocation_type: 'budget',
          period_frequency: 'monthly',
          period_start: start,
          period_end: end,
        }
      }

      return {
        ...base,
        allocation_type: 'savings',
      }
    },
    []
  )

  const createSubscriptionDefaults = useCallback(
    (): SubscriptionFormState => ({
      name: '',
      description: '',
      entry_type: 'expense',
      amount: 0,
      currency: defaultCurrencyCode,
      account_id: 0,
      category_id: undefined,
      allocation_id: undefined,
      cadence: 'monthly',
      next_occurrence: toLocalDateTimeInput(new Date()),
      lead_time_days: 0,
      is_autopay: true,
      is_active: true,
      end_mode: 'indefinite',
      end_date: undefined,
      max_occurrences: undefined,
    }),
    [defaultCurrencyCode]
  )

  const [allocationForm, setAllocationForm] = useState<AllocationFormState>(() =>
    createAllocationDefaults('savings')
  )
  const [subscriptionForm, setSubscriptionForm] = useState<SubscriptionFormState>(() =>
    createSubscriptionDefaults()
  )
  const [selectedBudgetCategoryIds, setSelectedBudgetCategoryIds] = useState<number[]>([])
  const [selectedSavingsAccountIds, setSelectedSavingsAccountIds] = useState<number[]>([])

  const [triggerAllocations] = useLazyGetAllocationsQuery()
  const [triggerBudgetEntries] = useLazyGetBudgetEntriesQuery()
  const { data: accountsData } = useGetAccountsQuery(
    { is_active: true, limit: 100 },
    { skip: !isAuthenticated }
  )
  const { data: categoriesData } = useGetCategoriesQuery(
    { is_active: true },
    { skip: !isAuthenticated }
  )
  
  const [createAllocation] = useCreateAllocationMutation()
  const [updateAllocation] = useUpdateAllocationMutation()
  const [deleteAllocation] = useDeleteAllocationMutation()
  const [createBudgetEntry] = useCreateBudgetEntryMutation()
  const [updateBudgetEntry] = useUpdateBudgetEntryMutation()
  const [deleteBudgetEntry] = useDeleteBudgetEntryMutation()
  const accounts = useMemo(() => accountsData?.items ?? [], [accountsData])
  const categories = useMemo(() => categoriesData ?? [], [categoriesData])
  const savingsCategory = useMemo(
    () => categories.find((category) => category.name.toLowerCase() === 'savings'),
    [categories]
  )
  const isSubscriptionMode = modalMode === 'subscription'
  const submitButtonLabel = isSubscriptionMode
    ? editingBudgetEntry
      ? 'Update Recurring Entry'
      : 'Save Recurring Entry'
    : editingAllocation
    ? 'Update Allocation'
    : allocationForm.allocation_type === 'budget'
    ? 'Create Budget Envelope'
    : 'Create Savings Tracker'
  const accountsById = useMemo(() => {
    const map = new Map<number, Account>()
    accounts.forEach((account) => map.set(account.id, account))
    return map
  }, [accounts])
  const categoriesById = useMemo(() => {
    const map = new Map<number, Category>()
    categories.forEach((category) => map.set(category.id, category))
    return map
  }, [categories])
  const actionAllocationConfig = (actionAllocation?.configuration ?? {}) as Record<string, unknown>
  const actionAllocationIsBudget = actionAllocation?.allocation_type === 'budget'
  const actionBudgetCadenceLabel =
    actionAllocationIsBudget && actionAllocation?.period_frequency
      ? formatBudgetCadenceLabel(actionAllocation.period_frequency)
      : undefined
  const actionBudgetPeriodStartLabel =
    actionAllocationIsBudget && actionAllocation?.period_start
      ? formatDateLabel(actionAllocation.period_start)
      : undefined
  const actionBudgetPeriodEndLabel =
    actionAllocationIsBudget && actionAllocation?.period_end
      ? formatBudgetPeriodEndLabel(actionAllocation.period_end)
      : undefined
  const actionAllocationLimit =
    actionAllocationIsBudget && actionAllocation
      ? typeof actionAllocation.target_amount === 'number'
        ? actionAllocation.target_amount
        : typeof actionAllocation.monthly_target === 'number'
        ? actionAllocation.monthly_target
        : null
      : actionAllocation?.target_amount ?? null
  const actionAllocationRemaining =
    actionAllocation && typeof actionAllocationLimit === 'number'
      ? actionAllocationLimit - actionAllocation.current_amount
      : null
  const actionAllocationUsagePct =
    actionAllocation &&
    actionAllocationIsBudget &&
    typeof actionAllocationLimit === 'number' &&
    actionAllocationLimit !== 0
      ? Math.min((actionAllocation.current_amount / actionAllocationLimit) * 100, 999)
      : null
  const actionAllocationTypeLabel = actionAllocationIsBudget
    ? 'Budget Envelope'
    : actionAllocation?.allocation_type === 'savings'
    ? 'Savings'
    : actionAllocation?.allocation_type === 'goal'
    ? 'Goal'
    : actionAllocation?.allocation_type ?? ''
  const actionAllocationAccount = actionAllocation ? accountsById.get(actionAllocation.account_id) ?? null : null
  const actionAllocationCategoryNames = Array.isArray(actionAllocationConfig['category_ids'])
    ? (actionAllocationConfig['category_ids'] as unknown[])
        .map((value) => {
          const id = Number(value)
          if (Number.isNaN(id)) {
            return null
          }
          return categoriesById.get(id)?.name ?? null
        })
        .filter((name): name is string => Boolean(name))
    : []
  const limit = 10
  const [allocationItems, setAllocationItems] = useState<Allocation[]>([])
  const [totalAllocations, setTotalAllocations] = useState(0)
  const [hasMoreAllocations, setHasMoreAllocations] = useState(true)
  const offsetRef = useRef(0)
  const loadMoreObserver = useRef<IntersectionObserver | null>(null)
  const [isInitialLoading, setIsInitialLoading] = useState(true)
  const [isFetchingMore, setIsFetchingMore] = useState(false)
  const [isRecurringLoading, setIsRecurringLoading] = useState(true)
  const [recurringIncome, setRecurringIncome] = useState<BudgetEntry[]>([])
  const [recurringExpenses, setRecurringExpenses] = useState<BudgetEntry[]>([])

  const loadAllocations = useCallback(
    async (reset = false) => {
      if (!isAuthenticated) {
        return
      }

      const nextOffset = reset ? 0 : offsetRef.current
      const params = {
        limit,
        offset: nextOffset,
      }

      try {
        if (reset) {
          offsetRef.current = 0
          setIsInitialLoading(true)
          setAllocationItems([])
        } else {
          setIsFetchingMore(true)
        }

        const result = await triggerAllocations(params).unwrap()
        offsetRef.current = nextOffset + result.items.length
        setAllocationItems((prev) => (reset ? result.items : [...prev, ...result.items]))
        setTotalAllocations(result.total)
        setHasMoreAllocations(result.has_more)
      } catch (error) {
        console.error('Error loading allocations:', error)
        if (reset) {
          setAllocationItems([])
          setTotalAllocations(0)
          setHasMoreAllocations(false)
        }
      } finally {
        if (reset) {
          setIsInitialLoading(false)
        } else {
          setIsFetchingMore(false)
        }
      }
    },
    [triggerAllocations, isAuthenticated]
  )

  useEffect(() => {
    if (authLoading || !isAuthenticated) {
      return
    }
    loadAllocations(true)
  }, [authLoading, isAuthenticated, loadAllocations])

  const loadBudgetEntries = useCallback(async () => {
    if (!isAuthenticated) {
      return
    }
    setIsRecurringLoading(true)
    try {
      const [incomeResult, expenseResult] = await Promise.all([
        triggerBudgetEntries({ entry_type: 'income', limit: 100 }).unwrap(),
        triggerBudgetEntries({ entry_type: 'expense', limit: 100 }).unwrap(),
      ])
      setRecurringIncome(incomeResult.items)
      setRecurringExpenses(expenseResult.items)
    } catch (error) {
      console.error('Error loading budget entries:', error)
      setRecurringIncome([])
      setRecurringExpenses([])
    } finally {
      setIsRecurringLoading(false)
    }
  }, [isAuthenticated, triggerBudgetEntries])

  useEffect(() => {
    if (authLoading || !isAuthenticated) {
      return
    }
    loadBudgetEntries()
  }, [authLoading, isAuthenticated, loadBudgetEntries])

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
        if (entries[0]?.isIntersecting && hasMoreAllocations && !isFetchingMore && !isInitialLoading) {
          loadAllocations(false)
        }
      })

      loadMoreObserver.current.observe(node)
    },
    [hasMoreAllocations, isFetchingMore, isInitialLoading, loadAllocations]
  )

  const orderedAllocations = useMemo(() => {
    return [...allocationItems].sort((a, b) => {
      if (a.is_active === b.is_active) {
        return a.name.localeCompare(b.name)
      }
      return Number(b.is_active) - Number(a.is_active)
    })
  }, [allocationItems])
  const savingsAndGoals = useMemo(
    () => orderedAllocations.filter((allocation) => allocation.allocation_type !== 'budget'),
    [orderedAllocations]
  )
  const budgetEnvelopes = useMemo(
    () => orderedAllocations.filter((allocation) => allocation.allocation_type === 'budget'),
    [orderedAllocations]
  )
  const allocationsById = useMemo(() => {
    const map = new Map<number, Allocation>()
    orderedAllocations.forEach((allocation) => {
      map.set(allocation.id, allocation)
    })
    return map
  }, [orderedAllocations])

  const openCreateModal = useCallback(() => {
    if (activeTab === 'subscriptions') {
      setModalMode('subscription')
      setSubscriptionForm(createSubscriptionDefaults())
      setEditingBudgetEntry(null)
    } else {
      const presetType = activeTab === 'budgets' ? 'budget' : 'savings'
      setModalMode('allocation')
      setAllocationForm(createAllocationDefaults(presetType))
      setSelectedBudgetCategoryIds([])
      setSelectedSavingsAccountIds([])
      setEditingBudgetEntry(null)
    }
    setEditingAllocation(null)
    setIsCreateModalOpen(true)
  }, [activeTab, createAllocationDefaults, createSubscriptionDefaults])

  const openAllocationFromWishlist = useCallback(
    (item: WishlistItem, kind: 'budget' | 'savings') => {
      setModalMode('allocation')
      setEditingAllocation(null)
      setEditingBudgetEntry(null)
      setSelectedBudgetCategoryIds([])
      setSelectedSavingsAccountIds([])
      setAllocationForm({
        ...createAllocationDefaults(kind),
        name: item.name,
        description: `From wishlist: ${item.name}`,
        target_amount: item.estimated_cost || undefined,
        // A savings target keeps the item's target date; a budget envelope resets monthly.
        target_date: kind === 'savings' && item.target_date ? item.target_date.slice(0, 10) : undefined,
      })
      setIsCreateModalOpen(true)
    },
    [createAllocationDefaults]
  )

  const openRecurringModal = useCallback(
    (entry?: BudgetEntry) => {
      setActiveTab('subscriptions')
      setModalMode('subscription')
      setEditingAllocation(null)
      if (entry) {
        setEditingBudgetEntry(entry)
        setSubscriptionForm({
          name: entry.name,
          description: entry.description || '',
          entry_type: entry.entry_type,
          amount: entry.amount,
          currency: (entry.currency as CurrencyCode) || defaultCurrencyCode,
          account_id: entry.account_id ?? 0,
          overflow_account_id: entry.overflow_account_id ?? undefined,
          category_id: entry.category_id ?? undefined,
          allocation_id: entry.allocation_id ?? undefined,
          cadence: entry.cadence,
          next_occurrence: toLocalDateTimeInput(entry.next_occurrence),
          lead_time_days: entry.lead_time_days ?? 0,
          is_autopay: entry.is_autopay,
          is_active: entry.is_active,
          end_mode: (entry.end_mode as SubscriptionFormState['end_mode']) ?? 'indefinite',
          end_date: entry.end_date ? toLocalDateTimeInput(entry.end_date) : undefined,
          max_occurrences: entry.max_occurrences ?? undefined,
        })
      } else {
        setEditingBudgetEntry(null)
        setSubscriptionForm(createSubscriptionDefaults())
      }
      setIsCreateModalOpen(true)
    },
    [createSubscriptionDefaults, defaultCurrencyCode]
  )

  const closeModal = useCallback(() => {
    setIsCreateModalOpen(false)
    setEditingAllocation(null)
    setEditingBudgetEntry(null)
    setModalMode('allocation')
    const type = activeTab === 'budgets' ? 'budget' : 'savings'
    setAllocationForm(createAllocationDefaults(type))
    setSubscriptionForm(createSubscriptionDefaults())
    setSelectedBudgetCategoryIds([])
    setSelectedSavingsAccountIds([])
  }, [activeTab, createAllocationDefaults, createSubscriptionDefaults])

  const handleSubscriptionAccountChange = (accountId: number) => {
    const account = accountsById.get(accountId)
    setSubscriptionForm((prev) => ({
      ...prev,
      account_id: accountId,
      currency: (account?.currency as CurrencyCode) || prev.currency,
    }))
  }

  const toggleBudgetCategory = (categoryId: number) => {
    setSelectedBudgetCategoryIds((prev) =>
      prev.includes(categoryId) ? prev.filter((id) => id !== categoryId) : [...prev, categoryId]
    )
  }

  const toggleSavingsAccount = (accountId: number) => {
    setSelectedSavingsAccountIds((prev) =>
      prev.includes(accountId) ? prev.filter((id) => id !== accountId) : [...prev, accountId]
    )
  }

  const handleBudgetCadenceSelect = useCallback(
    (cadence: BudgetCadence) => {
      setAllocationForm((prev) => {
        const defaults = getDefaultBudgetPeriod(cadence)
        const baselineStart = prev.period_start ?? defaults.start
        return {
          ...prev,
          period_frequency: cadence,
          period_start: baselineStart,
          period_end: computeBudgetPeriodEnd(baselineStart, cadence) ?? defaults.end,
        }
      })
    },
    []
  )

  const handleBudgetPeriodStartChange = useCallback(
    (value: string) => {
      setAllocationForm((prev) => {
        const cadence = prev.period_frequency ?? 'monthly'
        const defaults = getDefaultBudgetPeriod(cadence)
        const sanitizedStart = value || prev.period_start || defaults.start
        const next: AllocationFormState = {
          ...prev,
          period_start: sanitizedStart,
        }
        if (sanitizedStart && cadence) {
          next.period_end =
            computeBudgetPeriodEnd(sanitizedStart, cadence) ?? prev.period_end ?? defaults.end
        }
        return next
      })
    },
    []
  )

  const handleDeleteBudgetEntry = useCallback(
    async (entry: BudgetEntry) => {
      if (!confirm(`Delete recurring entry "${entry.name}"?`)) {
        return
      }
      try {
        await deleteBudgetEntry(entry.id).unwrap()
        setIsCreateModalOpen(false)
        setEditingBudgetEntry(null)
        setSubscriptionForm(createSubscriptionDefaults())
        await loadBudgetEntries()
      } catch (error) {
        console.error('Error deleting budget entry:', error)
      }
    },
    [createSubscriptionDefaults, deleteBudgetEntry, loadBudgetEntries]
  )

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    try {
      if (modalMode === 'subscription') {
        if (!subscriptionForm.name.trim()) {
          alert('Please provide a name for the recurring entry.')
          return
        }
        if (!subscriptionForm.account_id) {
          alert('Please select an account to post this recurring entry into.')
          return
        }
        if (subscriptionForm.amount <= 0) {
          alert('Please enter an amount greater than zero.')
          return
        }
        if (!subscriptionForm.next_occurrence) {
          alert('Please choose the next occurrence date and time.')
          return
        }

        let endDateIso: string | undefined
        let maxOccurrences: number | undefined
        if (subscriptionForm.end_mode === 'on_date') {
          if (!subscriptionForm.end_date) {
            alert('Please select the end date.')
            return
          }
          endDateIso = new Date(subscriptionForm.end_date).toISOString()
        } else if (subscriptionForm.end_mode === 'after_occurrences') {
          if (!subscriptionForm.max_occurrences || subscriptionForm.max_occurrences <= 0) {
            alert('Please specify how many occurrences before the entry stops.')
            return
          }
          maxOccurrences = Math.floor(subscriptionForm.max_occurrences)
        }

        const subscriptionPayload = {
          name: subscriptionForm.name.trim(),
          description: subscriptionForm.description?.trim() || undefined,
          entry_type: subscriptionForm.entry_type,
          amount: subscriptionForm.amount,
          currency: subscriptionForm.currency,
          account_id: subscriptionForm.account_id,
          overflow_account_id: subscriptionForm.overflow_account_id || undefined,
          category_id: subscriptionForm.category_id || undefined,
          allocation_id: subscriptionForm.allocation_id ?? undefined,
          cadence: subscriptionForm.cadence,
          next_occurrence: new Date(subscriptionForm.next_occurrence).toISOString(),
          lead_time_days: subscriptionForm.lead_time_days,
          is_autopay: subscriptionForm.is_autopay,
          is_active: subscriptionForm.is_active,
          end_mode: subscriptionForm.end_mode,
          end_date: endDateIso,
          max_occurrences: maxOccurrences,
        }

        if (editingBudgetEntry) {
          await updateBudgetEntry({ id: editingBudgetEntry.id, data: subscriptionPayload }).unwrap()
          setEditingBudgetEntry(null)
        } else {
          await createBudgetEntry(subscriptionPayload).unwrap()
        }
        setSubscriptionForm(createSubscriptionDefaults())
        setIsCreateModalOpen(false)
        await loadBudgetEntries()
        return
      }

      if (!allocationForm.name.trim()) {
        alert('Please enter a name for this allocation.')
        return
      }
      if (!allocationForm.account_id) {
        alert('Please choose a primary account.')
        return
      }
      if (allocationForm.allocation_type === 'budget' && selectedBudgetCategoryIds.length === 0) {
        alert('Select at least one category for this budget envelope.')
        return
      }
      if (
        allocationForm.allocation_type !== 'budget' &&
        allocationForm.goal_mode === 'multi_account' &&
        selectedSavingsAccountIds.length === 0
      ) {
        alert('Choose at least one account to aggregate for this savings tracker.')
        return
      }
      if (
        allocationForm.allocation_type !== 'budget' &&
        allocationForm.goal_mode === 'transaction_total' &&
        !savingsCategory
      ) {
        alert('Create a "Savings" category first so we can total those transactions.')
        return
      }

      if (allocationForm.allocation_type === 'budget') {
        if (!allocationForm.period_frequency) {
          alert('Select how often this budget resets (daily, weekly, monthly, or quarterly).')
          return
        }
        if (!allocationForm.period_start) {
          alert('Provide a start date for this budget period.')
          return
        }
        if (allocationForm.period_start && allocationForm.period_end) {
          const startDate = new Date(allocationForm.period_start)
          const endDate = new Date(allocationForm.period_end)
          if (Number.isNaN(startDate.getTime()) || Number.isNaN(endDate.getTime())) {
            alert('Budget period dates must be valid calendar dates.')
            return
          }
          if (endDate <= startDate) {
            alert('Budget end date must be after the start date.')
            return
          }
        }
      }

      let configuration: Record<string, unknown> | undefined
      if (allocationForm.allocation_type === 'budget') {
        configuration = {
          category_ids: selectedBudgetCategoryIds,
        }
      } else {
        configuration = {
          goal_mode: allocationForm.goal_mode,
        }
        if (allocationForm.goal_mode === 'multi_account') {
          configuration.account_ids = selectedSavingsAccountIds
        } else if (allocationForm.goal_mode === 'transaction_total' && savingsCategory) {
          configuration.savings_category_id = savingsCategory.id
        }
      }

      if (configuration && Object.keys(configuration).length === 0) {
        configuration = undefined
      }

      const resolvedAllocationType =
        editingAllocation?.allocation_type ||
        (activeTab === 'budgets' ? 'budget' : 'savings')

      const targetDateIso =
        allocationForm.allocation_type === 'budget' || !allocationForm.target_date
          ? undefined
          : new Date(`${allocationForm.target_date}T00:00:00`).toISOString()

      const allocationPayload = {
        account_id: allocationForm.account_id,
        name: allocationForm.name.trim(),
        allocation_type: resolvedAllocationType,
        description: allocationForm.description?.trim() || undefined,
        target_amount: allocationForm.target_amount,
        current_amount: allocationForm.current_amount,
        monthly_target: allocationForm.monthly_target,
        target_date: targetDateIso,
        period_frequency:
          allocationForm.allocation_type === 'budget' ? allocationForm.period_frequency : undefined,
        period_start:
          allocationForm.allocation_type === 'budget' && allocationForm.period_start
            ? new Date(`${allocationForm.period_start}T00:00:00`).toISOString()
            : undefined,
        period_end:
          allocationForm.allocation_type === 'budget' && allocationForm.period_end
            ? new Date(`${allocationForm.period_end}T00:00:00`).toISOString()
            : undefined,
        is_active: allocationForm.is_active,
        configuration,
      }
      
      if (editingAllocation) {
        await updateAllocation({ id: editingAllocation.id, data: allocationPayload }).unwrap()
        setEditingAllocation(null)
      } else {
        await createAllocation(allocationPayload).unwrap()
      }

      setAllocationForm(createAllocationDefaults(resolvedAllocationType === 'budget' ? 'budget' : 'savings'))
      setSelectedBudgetCategoryIds([])
      setSelectedSavingsAccountIds([])
      setIsCreateModalOpen(false)
      await loadAllocations(true)
    } catch (error) {
      console.error('Error saving allocation data:', error)
    }
  }

  const handleEdit = (allocation: Allocation) => {
    setEditingAllocation(allocation)
    setModalMode('allocation')
    const normalizedType: Allocation['allocation_type'] =
      allocation.allocation_type === 'budget' ? 'budget' : 'savings'
    const config = (allocation.configuration ?? {}) as Record<string, unknown>
    const derivedGoalMode = (config['goal_mode'] as AllocationGoalMode) || 'target_balance'
    const incomingCadenceRaw = allocation.period_frequency
      ? allocation.period_frequency.toLowerCase()
      : undefined
    const resolvedCadence: BudgetCadence =
      incomingCadenceRaw && budgetCadenceOptions.includes(incomingCadenceRaw as BudgetCadence)
        ? (incomingCadenceRaw as BudgetCadence)
        : 'monthly'
    const periodStartInput = isoToDateInput(allocation.period_start)
    const periodEndInput = isoToDateInput(allocation.period_end)

    const defaultPeriod = getDefaultBudgetPeriod(resolvedCadence)

    setAllocationForm({
      account_id: allocation.account_id,
      name: allocation.name,
      allocation_type: normalizedType,
      description: allocation.description || '',
      target_amount: allocation.target_amount,
      current_amount: allocation.current_amount,
      monthly_target: normalizedType === 'savings' ? allocation.monthly_target : undefined,
      target_date: normalizedType === 'savings' ? isoToDateInput(allocation.target_date ?? undefined) : undefined,
      is_active: allocation.is_active,
      goal_mode: normalizedType === 'budget' ? 'target_balance' : derivedGoalMode,
      period_frequency: resolvedCadence,
      period_start: periodStartInput ?? defaultPeriod.start,
      period_end: periodEndInput ?? defaultPeriod.end,
    })
    if (normalizedType === 'budget') {
      const categoryIds = Array.isArray(config['category_ids'])
        ? (config['category_ids'] as Array<number | string>)
            .map((id) => {
              const parsed = Number(id)
              return Number.isFinite(parsed) ? parsed : undefined
            })
            .filter((id): id is number => typeof id === 'number')
        : []
      setSelectedBudgetCategoryIds(categoryIds)
      setActiveTab('budgets')
    } else {
      const accountIds = Array.isArray(config['account_ids'])
        ? (config['account_ids'] as Array<number | string>)
            .map((id) => {
              const parsed = Number(id)
              return Number.isFinite(parsed) ? parsed : undefined
            })
            .filter((id): id is number => typeof id === 'number')
        : []
      setSelectedSavingsAccountIds(accountIds)
      setActiveTab('savings')
    }
    setIsCreateModalOpen(true)
  }

  const handleDelete = async (allocationId: number) => {
    if (confirm('Are you sure you want to delete this allocation?')) {
      try {
        await deleteAllocation(allocationId).unwrap()
        if (actionAllocation?.id === allocationId) {
          closeActionModal()
        }
        await loadAllocations(true)
      } catch (error) {
        console.error('Error deleting allocation:', error)
      }
    }
  }

  const openActionModal = (allocation: Allocation) => {
    setActionAllocation(allocation)
    setIsActionModalOpen(true)
  }

  const closeActionModal = () => {
    setIsActionModalOpen(false)
    setActionAllocation(null)
  }

  const handleToggleAllocationActive = async (allocation: Allocation) => {
    try {
      const nextIsActive = !allocation.is_active
      await updateAllocation({ id: allocation.id, data: { is_active: nextIsActive } }).unwrap()
      const updatedAllocation: Allocation = { ...allocation, is_active: nextIsActive }
      setAllocationItems((prev) => prev.map((item) => (item.id === allocation.id ? updatedAllocation : item)))
      if (actionAllocation?.id === allocation.id) {
        setActionAllocation(updatedAllocation)
      }
    } catch (error) {
      console.error('Error updating allocation status:', error)
    }
  }

  const openEditFromModal = (allocation: Allocation) => {
    closeActionModal()
    handleEdit(allocation)
  }

  const renderAllocationCard = (allocation: Allocation) => {
    const account = accountsById.get(allocation.account_id)
    const isBudget = allocation.allocation_type === 'budget'
    const configuration = (allocation.configuration ?? {}) as Record<string, unknown>
    const budgetCadenceLabel = formatBudgetCadenceLabel(allocation.period_frequency)
    const budgetPeriodStartLabel = allocation.period_start ? formatDateLabel(allocation.period_start) : undefined
    const budgetPeriodEndLabel = allocation.period_end ? formatBudgetPeriodEndLabel(allocation.period_end) : undefined
    const limitAmount =
      typeof allocation.target_amount === 'number'
        ? allocation.target_amount
        : isBudget && typeof allocation.monthly_target === 'number'
        ? allocation.monthly_target
        : null
    const usedAmount = typeof allocation.current_amount === 'number' ? allocation.current_amount : 0
    const remainingAmount =
      typeof limitAmount === 'number' ? limitAmount - usedAmount : null
    const usagePercentage =
      isBudget && typeof limitAmount === 'number' && limitAmount !== 0
        ? Math.min((usedAmount / limitAmount) * 100, 999)
        : 0
    const savingsProgressPercentage =
      !isBudget && allocation.target_amount
        ? Math.min((allocation.current_amount / allocation.target_amount) * 100, 999)
        : 0
    const budgetCategoryNames = Array.isArray(configuration['category_ids'])
      ? (configuration['category_ids'] as Array<number | string>)
          .map((id) => {
            const parsed = Number(id)
            return Number.isFinite(parsed) ? categoriesById.get(parsed)?.name : undefined
          })
          .filter((name): name is string => Boolean(name))
      : []
    const goalMode = configuration['goal_mode'] as AllocationGoalMode | undefined
    const linkedAccounts = Array.isArray(configuration['account_ids'])
      ? (configuration['account_ids'] as Array<number | string>)
          .map((id) => {
            const parsed = Number(id)
            return Number.isFinite(parsed) ? accountsById.get(parsed)?.name : undefined
          })
          .filter((name): name is string => Boolean(name))
      : []
    const savingsCategoryId =
      (configuration['savings_category_id'] as number | undefined) ??
      (configuration['category_id'] as number | undefined)
    const savingsCategoryName = savingsCategoryId
      ? categoriesById.get(savingsCategoryId)?.name
      : undefined

    return (
      <article
        key={allocation.id}
        className={`card p-4 sm:p-5 transition-colors duration-200 hover:bg-sunken cursor-pointer ${ allocation.is_active ? '' : 'opacity-60' }`}
        onClick={() => openActionModal(allocation)}
        role="button"
        tabIndex={0}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault()
            openActionModal(allocation)
          }
        }}
      >
        <div className="flex flex-col gap-4 md:grid md:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)_160px] md:items-center md:gap-4">
          <div className="space-y-3">
            <div className="flex items-start justify-between gap-3 md:block">
                <div>
                <p className="text-base font-semibold text-ink">{allocation.name}</p>
                <p className="text-sm text-muted capitalize">
                  {allocation.allocation_type === 'budget' ? 'Budget Envelope' : allocation.allocation_type}
                </p>
                {account && <p className="text-sm text-body">{account.name}</p>}
                  {allocation.description && (
                    <p className="text-sm text-body mt-1">{allocation.description}</p>
                  )}
                {allocation.allocation_type === 'budget' && budgetCategoryNames.length > 0 && (
                  <div className="mt-2 flex flex-wrap gap-2 text-xs">
                    {budgetCategoryNames.map((name) => (
                      <span
                        key={name}
                        className="inline-flex items-center gap-1 rounded-full px-2 py-1 text-warn"
                      >
                        {name}
                      </span>
                    ))}
                </div>
                )}
                {isBudget && (
                  <div className="mt-2 flex flex-wrap gap-2 text-xs text-body">
                    {budgetCadenceLabel && (
                      <span className="inline-flex items-center gap-1 rounded-full bg-sunken px-2 py-1">
                        Cadence: {budgetCadenceLabel}
                      </span>
                    )}
                    {budgetPeriodStartLabel && (
                      <span className="inline-flex items-center gap-1 rounded-full bg-sunken px-2 py-1">
                        Starts {budgetPeriodStartLabel}
                      </span>
                    )}
                    {budgetPeriodEndLabel && (
                      <span className="inline-flex items-center gap-1 rounded-full bg-sunken px-2 py-1">
                        Ends {budgetPeriodEndLabel}
                      </span>
                    )}
                  </div>
                )}
                {allocation.allocation_type === 'savings' && goalMode && (
                  <div className="mt-2 flex flex-wrap gap-2 text-xs text-ink">
                    <span className="inline-flex items-center gap-1 rounded-full px-2 py-1">
                      Goal Mode: {goalMode === 'target_balance'
                        ? 'Target Balance'
                        : goalMode === 'multi_account'
                        ? 'Combined Accounts'
                        : 'Savings Transactions'}
                    </span>
                    {goalMode === 'multi_account' && linkedAccounts.length > 0 && (
                      <span className="inline-flex items-center gap-1 rounded-full px-2 py-1 text-ink">
                        {linkedAccounts.join(', ')}
                      </span>
                    )}
                    {goalMode === 'transaction_total' && savingsCategoryName && (
                      <span className="inline-flex items-center gap-1 rounded-full px-2 py-1 text-ink">
                        Savings category: {savingsCategoryName}
                      </span>
                    )}
                  </div>
                )}
              </div>
              <span
                className={`inline-flex items-center gap-1 rounded-full px-2 py-1 text-xs font-medium ${ allocation.is_active ? 'text-ink' : 'bg-sunken text-body' } md:hidden`}
              >
                {allocation.is_active ? 'Active' : 'Paused'}
              </span>
              </div>
              
            <div className="flex flex-wrap gap-2 text-xs text-body">
              {allocation.target_date && !isBudget && (
                <span className="inline-flex items-center gap-1 px-2 py-1 text-ink">
                  Target {new Date(allocation.target_date).toLocaleDateString()}
                </span>
              )}
              {allocation.monthly_target !== undefined && !isBudget && (
                <span className="inline-flex items-center gap-1 px-2 py-1 text-ink">
                  Monthly {format(allocation.monthly_target)}
                </span>
              )}
            </div>
                </div>
                
          <div className="space-y-2">
            {isBudget ? (
              <>
                {limitAmount !== null && limitAmount > 0 && (
                  <div className="flex items-center justify-between text-sm text-body">
                    <span>Spending limit</span>
                    <span className="font-medium text-ink">{format(limitAmount)}</span>
                  </div>
                )}
                <div className="flex items-center justify-between text-sm text-body">
                  <span>Spent this period</span>
                  <span className="font-semibold text-danger">{format(usedAmount)}</span>
                </div>
                {limitAmount !== null && limitAmount > 0 && (
                  <BudgetUsageBar usagePercentage={usagePercentage} />
                )}
                {limitAmount !== null && (
                  <div className="flex items-center justify-between text-sm text-body">
                    <span>Remaining</span>
                    <span
                      className={`font-semibold ${ remainingAmount !== null && remainingAmount < 0 ? 'text-danger' : 'text-ink' }`}
                    >
                      {format(remainingAmount ?? 0)}
                    </span>
                  </div>
                )}
              </>
            ) : (
              <>
                <div className="flex items-center justify-between text-sm text-body">
                  <span>Current</span>
                  <span className="font-semibold text-ink">{format(allocation.current_amount)}</span>
                </div>
                {allocation.target_amount && (
                  <>
                    <div className="flex items-center justify-between text-sm text-body">
                      <span>Target</span>
                      <span className="font-medium">{format(allocation.target_amount)}</span>
                    </div>
                    <div className="w-full bg-sunken rounded-full h-2">
                      <div
                        className="bg-ink h-2 rounded-full transition-all duration-300"
                        style={{ width: `${Math.min(savingsProgressPercentage, 100)}%` }}
                      />
                    </div>
                    <p className="text-right text-xs font-medium text-muted">
                      {savingsProgressPercentage.toFixed(1)}% funded
                    </p>
                  </>
                )}
              </>
            )}
          </div>
                    
          <div className="flex flex-wrap justify-end gap-2">
            <span
              className={`hidden md:inline-flex items-center gap-1 rounded-full px-2 py-1 text-xs font-medium ${ allocation.is_active ? 'text-ink' : 'bg-sunken text-body' }`}
            >
              {allocation.is_active ? 'Active' : 'Paused'}
            </span>
                    </div>
        </div>
      </article>
    )
  }

  const renderBudgetEntryCard = (entry: BudgetEntry) => {
    const account = entry.account_id ? accountsById.get(entry.account_id) : undefined
    const category = entry.category_id ? categoriesById.get(entry.category_id) : undefined
    const allocation = entry.allocation_id ? allocationsById.get(entry.allocation_id) : undefined
    const cadenceLabel = formatCadenceLabel(entry.cadence)
    const amountLabel = formatAmount(entry.amount, entry.currency)
    const endDate = entry.end_date ? new Date(entry.end_date) : undefined
    // Installment "n of m". The backend decrements max_occurrences on each payment
    // (it means occurrences REMAINING), and occurrences_paid is the count materialised
    // so far, so the fixed total is paid + remaining. Guard on end_mode, not on
    // max_occurrences being truthy — a fully-paid installment has max_occurrences === 0
    // but should still read "6 of 6", not "Indefinite".
    const isInstallment = entry.end_mode === 'after_occurrences'
    const paid = entry.occurrences_paid ?? 0
    const remaining = isInstallment ? entry.max_occurrences ?? 0 : null
    const total = isInstallment ? paid + (entry.max_occurrences ?? 0) : null

    const installmentLabel =
      isInstallment && total
        ? paid > 0
          ? `Payment ${paid} of ${total}`
          : `${total} payment${total === 1 ? '' : 's'} planned`
        : null

    const endLabel =
      entry.end_mode === 'on_date' && endDate
        ? `Ends ${formatFullDate(entry.end_date!)}`
        : installmentLabel ?? 'Indefinite'

    return (
      <article
        key={entry.id}
        className={`card p-4 sm:p-5 transition-colors duration-200 hover:bg-sunken cursor-pointer ${ entry.is_active ? '' : 'opacity-60' }`}
        onClick={() => openRecurringModal(entry)}
        role="button"
        tabIndex={0}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault()
            openRecurringModal(entry)
          }
        }}
      >
        <div className="flex flex-col gap-3">
          <div className="flex items-start justify-between gap-4">
            <div className="space-y-1">
              <p className="text-base font-semibold text-ink">{entry.name}</p>
              <div className="flex flex-wrap items-center gap-2 text-xs uppercase tracking-wide text-muted">
                <span>{entry.entry_type === 'income' ? 'Recurring Income' : 'Recurring Expense'}</span>
                <span className="text-muted">•</span>
                <span>{cadenceLabel}</span>
                <span className="text-muted">•</span>
                <span>{entry.is_autopay ? 'Auto-pay' : 'Manual'}</span>
                {!entry.is_active && (
                  <>
                    <span className="text-muted">•</span>
                    <span>Paused</span>
                  </>
                )}
                  </div>
              {entry.description && <p className="text-sm text-body">{entry.description}</p>}
            </div>
            <div className="text-right">
              <p
                className={`text-lg font-bold ${ entry.entry_type === 'income' ? 'text-ok' : 'text-danger' }`}
              >
                {amountLabel}
              </p>
              <p className="text-xs text-muted">{cadenceLabel}</p>
            </div>
          </div>
          <div className="flex flex-wrap gap-2 text-xs text-body">
            <span className="inline-flex items-center gap-1 px-2 py-1 text-ink">
              Next {formatFullDate(entry.next_occurrence)}
            </span>
            <span className="inline-flex items-center gap-1 rounded-full bg-sunken px-2 py-1">
              {formatRelativeDate(entry.next_occurrence)}
            </span>
            {entry.lead_time_days > 0 && (
              <span className="inline-flex items-center gap-1 px-2 py-1 text-ink">
                Reminder {entry.lead_time_days} day{entry.lead_time_days === 1 ? '' : 's'} ahead
              </span>
            )}
            {account && (
              <span className="inline-flex items-center gap-1 rounded-full bg-sunken px-2 py-1">
                Account: {account.name}
              </span>
            )}
            {category && (
              <span className="inline-flex items-center gap-1 rounded-full bg-sunken px-2 py-1">
                Category: {category.name}
              </span>
            )}
            {allocation && (
              <span className="inline-flex items-center gap-1 rounded-full bg-sunken px-2 py-1">
                Envelope: {allocation.name}
              </span>
            )}
            <span className="inline-flex items-center gap-1 rounded-full bg-sunken px-2 py-1">
              {endLabel}
            </span>
            {remaining !== null && remaining > 0 && (
              <span className="inline-flex items-center gap-1 rounded-full text-ink px-2 py-1">
                {remaining} left
              </span>
            )}
            {remaining === 0 && (
              <span className="inline-flex items-center gap-1 rounded-full text-ok px-2 py-1">
                Fully paid
              </span>
            )}
          </div>
        </div>
      </article>
    )
  }

  const renderAllocationSection = (
    title: string,
    subtitle: string,
    allocations: Allocation[],
    emptyMessage: string
  ) => (
    <section className="space-y-3">
      <header className="space-y-1">
        <h2 className="text-xl font-semibold text-ink">{title}</h2>
        <p className="text-sm text-muted">{subtitle}</p>
      </header>
      {allocations.length === 0 ? (
        <div className="card p-6 text-center text-muted">{emptyMessage}</div>
      ) : (
        <div className="grid grid-cols-1 gap-3">{allocations.map(renderAllocationCard)}</div>
      )}
    </section>
  )

  const renderRecurringSection = (
    title: string,
    subtitle: string,
    entries: BudgetEntry[],
    emptyMessage: string
  ) => (
    <section className="space-y-3">
      <header className="space-y-1">
        <h2 className="text-xl font-semibold text-ink">{title}</h2>
        <p className="text-sm text-muted">{subtitle}</p>
      </header>
      {isRecurringLoading ? (
        <div className="card p-6 text-center text-muted">Loading recurring entries…</div>
      ) : entries.length === 0 ? (
        <div className="card p-6 text-center text-muted">{emptyMessage}</div>
      ) : (
        <div className="grid grid-cols-1 gap-3">
          {entries.map(renderBudgetEntryCard)}
                  </div>
                )}
    </section>
  )

  if (isInitialLoading) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <div className="text-xl">Loading...</div>
      </div>
    )
  }

  const activeAllocationList =
    activeTab === 'budgets' ? budgetEnvelopes : activeTab === 'savings' ? savingsAndGoals : []

  if (authLoading) {
  return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-ink"></div>
            </div>
    )
  }

  if (!isAuthenticated) {
    return null
  }

  return (
    <div className="max-w-7xl mx-auto px-3 py-6 sm:px-4 lg:px-6 space-y-6">
      <div className="space-y-4">
        <div className="flex flex-col sm:flex-row sm:justify-between sm:items-center gap-4">
        <h1 className="text-3xl font-bold text-ink">Allocations</h1>
        {activeTab !== 'wishlist' && (
          <button
              onClick={openCreateModal}
            className="btn-primary focus-ring w-full sm:w-auto justify-center"
          >
              {activeTab === 'subscriptions' ? 'Add Recurring Entry' : 'Add Allocation'}
          </button>
        )}
      </div>
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 border border-line p-2 bg-surface">
          <nav className="flex gap-1">
            {[
              { value: 'subscriptions' as const, label: 'Subscriptions' },
              { value: 'budgets' as const, label: 'Budgets' },
              { value: 'savings' as const, label: 'Savings' },
              { value: 'wishlist' as const, label: 'Wishlist' },
            ].map((tab) => {
              const isActive = activeTab === tab.value
          return (
                  <button
                  key={tab.value}
                  onClick={() => setActiveTab(tab.value)}
                  className={`px-4 py-2 text-sm font-semibold transition ${ isActive ? 'bg-ink text-paper' : 'text-body hover:bg-sunken' }`}
                >
                  {tab.label}
                  </button>
              )
            })}
          </nav>
          <p className="text-xs sm:text-sm text-muted">
            Switch tabs to view recurring subscriptions, monthly budgets, savings envelopes, or your wishlist.
          </p>
                </div>
      </div>

      {activeTab === 'subscriptions' &&
        renderRecurringSection(
          'Recurring Income',
          'Expected paychecks, retainers, and other income that feed your plans.',
          recurringIncome,
          'No recurring income entries yet. Add one to keep future deposits on your radar.'
        )}

      {activeTab === 'subscriptions' &&
        renderRecurringSection(
          'Recurring Expenses & Subscriptions',
          'Upcoming statements and auto-payments that will hit your accounts soon.',
          recurringExpenses,
          'No recurring expenses yet. Add your regular bills and subscriptions to stay ahead.'
        )}

      {activeTab === 'budgets' &&
        renderAllocationSection(
          'Budget Envelopes',
          'Monthly spending buckets that align with your categories and keep cash flow on track.',
          budgetEnvelopes,
          'No budget envelopes yet. Create one to keep monthly spending in check.'
        )}

      {activeTab === 'savings' &&
        renderAllocationSection(
          'Savings & Investment Targets',
          'Longer-term goals and rainy-day funds that should steadily grow over time.',
          savingsAndGoals,
          'No savings or goal envelopes yet. Create one to start building your future plans.'
        )}

      {activeTab === 'wishlist' && (
        <WishlistPanel onCreateAllocationFromItem={openAllocationFromWishlist} />
      )}

      {activeTab !== 'subscriptions' && activeTab !== 'wishlist' && (
        <>
          <div ref={sentinelRef} className="h-3" />
          {!isInitialLoading && (isFetchingMore || hasMoreAllocations) && (
            <p className="text-center text-xs text-muted pb-2">
              {isFetchingMore ? 'Loading more envelopes...' : 'Scroll for more envelopes'}
            </p>
          )}
          {!isInitialLoading && !hasMoreAllocations && totalAllocations > 0 && (
            <p className="text-center text-xs text-muted pb-2">End of envelope list</p>
          )}
          <div className="flex justify-end px-4">
            <p className="text-xs text-muted">
              Showing {activeAllocationList.length} of {totalAllocations} envelopes
            </p>
          </div>
        </>
      )}

      {isActionModalOpen && actionAllocation && (
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
                <h2 className="text-xl font-semibold text-ink">{actionAllocation.name}</h2>
                <p className="text-sm text-muted">{actionAllocationTypeLabel}</p>
                {actionAllocationAccount && (
                  <p className="text-sm text-muted">{actionAllocationAccount.name}</p>
                )}
                {actionAllocationIsBudget && actionAllocationCategoryNames.length > 0 && (
                  <div className="mt-2 flex flex-wrap gap-2 text-xs">
                    {actionAllocationCategoryNames.map((name) => (
                      <span
                        key={name}
                        className="inline-flex items-center gap-1 rounded-full px-2 py-1 text-warn"
                      >
                        {name}
                      </span>
                    ))}
                </div>
                )}
                {actionAllocationIsBudget && (
                  <div className="mt-2 flex flex-wrap gap-2 text-xs text-body">
                    {actionBudgetCadenceLabel && (
                      <span className="inline-flex items-center gap-1 rounded-full bg-sunken px-2 py-1">
                        Cadence: {actionBudgetCadenceLabel}
                      </span>
                    )}
                    {actionBudgetPeriodStartLabel && (
                      <span className="inline-flex items-center gap-1 rounded-full bg-sunken px-2 py-1">
                        Starts {actionBudgetPeriodStartLabel}
                      </span>
                    )}
                    {actionBudgetPeriodEndLabel && (
                      <span className="inline-flex items-center gap-1 rounded-full bg-sunken px-2 py-1">
                        Ends {actionBudgetPeriodEndLabel}
                      </span>
                    )}
                  </div>
                )}
              </div>
                  <button
                onClick={closeActionModal}
                className="text-muted hover:text-body transition-colors duration-200"
                aria-label="Close allocation actions modal"
                  >
                <svg className="h-6 w-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
                  </button>
                </div>
                
            <div className="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div className="border border-line p-4">
                <h3 className="text-sm font-semibold text-body">
                  {actionAllocationIsBudget ? 'Budget snapshot' : 'Current progress'}
                </h3>
                {actionAllocationIsBudget ? (
                  <>
                    {actionAllocationLimit !== null && (
                      <p className="mt-2 text-sm text-muted">
                        Limit <span className="font-semibold text-ink">{format(actionAllocationLimit)}</span>
                      </p>
                    )}
                    <p className="mt-2 text-sm text-muted">
                      Spent <span className="font-semibold text-danger">{format(actionAllocation.current_amount)}</span>
                    </p>
                    {actionAllocationUsagePct !== null && actionAllocationLimit !== null && actionAllocationLimit > 0 && (
                      <BudgetUsageBar usagePercentage={actionAllocationUsagePct} />
                    )}
                    {actionAllocationRemaining !== null && (
                      <p
                        className={`mt-2 text-sm ${ actionAllocationRemaining < 0 ? 'text-danger' : 'text-body' }`}
                      >
                        Remaining{' '}
                        <span className="font-semibold">
                          {format(actionAllocationRemaining)}
                        </span>
                      </p>
                    )}
                  </>
                ) : (
                  <>
                    <p className="mt-2 text-lg font-bold text-ink">{format(actionAllocation.current_amount)}</p>
                    {actionAllocation.target_amount && (
                      <>
                        <p className="text-sm text-muted">Target {format(actionAllocation.target_amount)}</p>
                        <div className="mt-2 w-full bg-sunken rounded-full h-2">
                          <div
                            className="bg-ink h-2 rounded-full transition-all duration-300"
                            style={{
                              width: `${Math.min(
                                (actionAllocation.current_amount / actionAllocation.target_amount) * 100,
                                100
                              )}%`,
                            }}
                          />
                        </div>
                        <p className="mt-1 text-xs text-muted text-right">
                          {Math.min((actionAllocation.current_amount / actionAllocation.target_amount) * 100, 999).toFixed(1)}% funded
                        </p>
                      </>
                    )}
                  </>
                )}
              </div>

              <div className="border border-line p-4">
                <h3 className="text-sm font-semibold text-body">Details</h3>
                {actionAllocation.monthly_target !== undefined && !actionAllocationIsBudget && (
                  <p className="mt-2 text-sm text-muted">Monthly target {format(actionAllocation.monthly_target)}</p>
                )}
                {actionAllocation.target_date && !actionAllocationIsBudget && (
                  <p className="mt-1 text-sm text-muted">Target date {new Date(actionAllocation.target_date).toLocaleDateString()}</p>
                )}
                <p
                  className={`mt-2 inline-flex items-center gap-2 rounded-full px-3 py-1 text-sm font-medium ${ actionAllocation.is_active ? 'text-ink' : 'bg-sunken text-body' }`}
                >
                  {actionAllocation.is_active ? 'Active' : 'Paused'}
                </p>
              </div>
            </div>

            <div className="mt-6 grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <button
                onClick={() => handleToggleAllocationActive(actionAllocation)}
                className={`flex items-center justify-center gap-2 px-4 py-3 text-sm font-semibold transition-colors duration-200 ${ actionAllocation.is_active ? 'text-ink hover:bg-sunken' : 'bg-sunken text-body hover:bg-sunken' }`}
              >
                <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  {actionAllocation.is_active ? (
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 9v6m4-6v6M5 5h14a2 2 0 012 2v10a2 2 0 01-2 2H5a2 2 0 01-2-2V7a2 2 0 012-2z" />
                  ) : (
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 5l10 7-10 7V5z" />
                  )}
                </svg>
                <span>{actionAllocation.is_active ? 'Pause allocation' : 'Resume allocation'}</span>
                  </button>
                  <button
                onClick={() => openEditFromModal(actionAllocation)}
                className="flex items-center justify-center gap-2 bg-ink px-4 py-3 text-sm font-semibold text-paper transition-colors duration-200 hover:bg-ink"
              >
                <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
                </svg>
                Edit allocation
              </button>
              <button
                onClick={() => handleDelete(actionAllocation.id)}
                className="flex items-center justify-center gap-2 px-4 py-3 text-sm font-semibold text-danger transition-colors duration-200 hover:bg-sunken sm:col-span-2"
              >
                <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                </svg>
                Delete allocation
                  </button>
                </div>
              </div>
          </div>
      </div>
      )}

      {/* Create/Edit Modal */}
      {isCreateModalOpen && (
        <div className="fixed inset-0 z-50 overflow-y-auto bg-black/60 px-4 py-6">
          <div className="min-h-full flex items-center justify-center">
          <div className="bg-surface p-6 w-full max-w-2xl">
            <div className="flex items-start justify-between mb-4">
              <div className="space-y-1">
                <h2 className="text-xl font-semibold text-ink">
                  {modalMode === 'subscription'
                    ? 'Add Recurring Entry'
                    : editingAllocation
                    ? 'Edit Allocation'
                    : activeTab === 'budgets'
                    ? 'Create Budget Envelope'
                    : 'Create Savings Tracker'}
            </h2>
                <p className="text-sm text-muted">
                  {modalMode === 'subscription'
                    ? 'Project upcoming income or expenses so they feed into your budgets automatically.'
                    : activeTab === 'budgets'
                    ? 'Define how this envelope should behave and which categories it monitors.'
                    : 'Outline how you want to measure progress for this savings goal.'}
                </p>
              </div>
              <button
                onClick={closeModal}
                className="text-muted hover:text-body transition-colors duration-200"
                aria-label="Close allocation modal"
              >
                <svg className="h-6 w-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
                </div>
                
            <form onSubmit={handleSubmit} className="space-y-5">
              {modalMode === 'subscription' ? (
                <>
                  <div>
                    <label className="block text-sm font-medium text-body">Name</label>
                    <input
                      type="text"
                      value={subscriptionForm.name}
                      onChange={(e) => setSubscriptionForm((prev) => ({ ...prev, name: e.target.value }))}
                      className="mt-1 block w-full border border-line px-3 py-2"
                      required
                    />
                    </div>
                    
                  <div>
                    <label className="block text-sm font-medium text-body">Entry Type</label>
                    <div className="mt-1 inline-flex bg-sunken p-1">
                      {(['expense', 'income'] as Array<'expense' | 'income'>).map((type) => {
                        const isActive = subscriptionForm.entry_type === type
                        return (
                          <button
                            type="button"
                            key={type}
                            onClick={() => setSubscriptionForm((prev) => ({ ...prev, entry_type: type }))}
                            className={`px-3 py-1 text-sm font-semibold transition ${ isActive ? 'bg-ink text-paper' : 'text-body hover:bg-sunken' }`}
                          >
                            {type === 'expense' ? 'Expense' : 'Income'}
                          </button>
                        )
                      })}
                    </div>
                    </div>
                    
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-body">Account</label>
                <select
                        value={subscriptionForm.account_id}
                        onChange={(e) => handleSubscriptionAccountChange(parseInt(e.target.value))}
                  className="mt-1 block w-full border border-line px-3 py-2"
                  required
                >
                        <option value={0}>Select account</option>
                        {accounts.map((account) => (
                    <option key={account.id} value={account.id}>
                      {account.name}
                    </option>
                  ))}
                </select>
                    </div>
                    <div>
                      <label className="block text-sm font-medium text-body">Category</label>
                      <select
                        value={subscriptionForm.category_id ?? 0}
                        onChange={(e) =>
                          setSubscriptionForm((prev) => ({
                            ...prev,
                            category_id: parseInt(e.target.value) || undefined,
                          }))
                        }
                        className="mt-1 block w-full border border-line px-3 py-2"
                      >
                        <option value={0}>Uncategorized</option>
                        {categories.map((category) => (
                          <option key={category.id} value={category.id}>
                            {category.name}
                          </option>
                        ))}
                      </select>
                    </div>
              </div>

              {subscriptionForm.entry_type === 'expense' && (
                <div>
                  <label className="block text-sm font-medium text-body">Overflow account (optional)</label>
                  <select
                    value={subscriptionForm.overflow_account_id ?? 0}
                    onChange={(e) => setSubscriptionForm((prev) => ({ ...prev, overflow_account_id: parseInt(e.target.value) || undefined }))}
                    className="mt-1 block w-full border border-line px-3 py-2"
                  >
                    <option value={0}>None</option>
                    {accounts.filter((a) => a.id !== subscriptionForm.account_id).map((account) => (
                      <option key={account.id} value={account.id}>{account.name}</option>
                    ))}
                  </select>
                  <p className="mt-1 text-xs text-muted">If the primary account can't cover a payment, the shortfall is drawn from here.</p>
                </div>
              )}

              <div>
                    <label className="block text-sm font-medium text-body">Currency</label>
                    <select
                      value={subscriptionForm.currency}
                      onChange={(e) =>
                        setSubscriptionForm((prev) => ({
                          ...prev,
                          currency: e.target.value as CurrencyCode,
                        }))
                      }
                      className="mt-1 block w-full border border-line px-3 py-2"
                    >
                      {currencyOptions.map((code) => (
                        <option key={code} value={code}>
                          {code}
                        </option>
                      ))}
                    </select>
                  </div>

              <div>
                    <label className="block text-sm font-medium text-body">
                      Amount ({subscriptionForm.currency})
                    </label>
                <input
                      type="number"
                      step="0.01"
                      min="0"
                      value={subscriptionForm.amount || ''}
                      onChange={(e) =>
                        setSubscriptionForm((prev) => ({
                          ...prev,
                          amount: parseFloat(e.target.value) || 0,
                        }))
                      }
                  className="mt-1 block w-full border border-line px-3 py-2"
                  required
                />
                  </div>
              
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                      <label className="block text-sm font-medium text-body">Cadence</label>
                <select
                        value={subscriptionForm.cadence}
                        onChange={(e) =>
                          setSubscriptionForm((prev) => ({
                            ...prev,
                            cadence: e.target.value as BudgetEntry['cadence'],
                          }))
                        }
                        className="mt-1 block w-full border border-line px-3 py-2"
                      >
                        {(['monthly', 'quarterly', 'semi_annual', 'annual'] as BudgetEntry['cadence'][]).map(
                          (value) => (
                            <option key={value} value={value}>
                              {formatCadenceLabel(value)}
                            </option>
                          )
                        )}
                      </select>
              </div>
                    <div>
                      <label className="block text-sm font-medium text-body">Next Occurrence</label>
                      <input
                        type="datetime-local"
                        value={subscriptionForm.next_occurrence}
                        onChange={(e) =>
                          setSubscriptionForm((prev) => ({
                            ...prev,
                            next_occurrence: e.target.value,
                          }))
                        }
                  className="mt-1 block w-full border border-line px-3 py-2"
                  required
                      />
            </div>
                  </div>

                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                    <div>
                      <label className="block text-sm font-medium text-body">Lead Time (days)</label>
                      <input
                        type="number"
                        min="0"
                        value={subscriptionForm.lead_time_days}
                        onChange={(e) =>
                          setSubscriptionForm((prev) => ({
                            ...prev,
                            lead_time_days: parseInt(e.target.value) || 0,
                          }))
                        }
                        className="mt-1 block w-full border border-line px-3 py-2"
                      />
                  </div>
                    <div>
                      <label className="block text-sm font-medium text-body">Link to Budget (optional)</label>
                      <select
                        value={subscriptionForm.allocation_id ?? 0}
                        onChange={(e) =>
                          setSubscriptionForm((prev) => ({
                            ...prev,
                            allocation_id: parseInt(e.target.value, 10) || undefined,
                          }))
                        }
                        className="mt-1 block w-full border border-line px-3 py-2"
                      >
                        <option value={0}>No linked envelope</option>
                        {budgetEnvelopes.map((allocation) => (
                          <option key={allocation.id} value={allocation.id}>
                            {allocation.name}
                          </option>
                        ))}
                      </select>
                    </div>
                  </div>

                  <div className="space-y-3">
                    <div>
                      <label className="block text-sm font-medium text-body">Ends</label>
                      <div className="mt-1 flex flex-wrap gap-2">
                        {[
                          { value: 'indefinite', label: 'Keep running' },
                          { value: 'on_date', label: 'On date' },
                          { value: 'after_occurrences', label: 'After runs' },
                        ].map(({ value, label }) => {
                          const isSelected = subscriptionForm.end_mode === value
                          return (
                            <button
                              type="button"
                              key={value}
                              onClick={() =>
                                setSubscriptionForm((prev) => ({
                                  ...prev,
                                  end_mode: value as SubscriptionFormState['end_mode'],
                                  end_date: value === 'on_date' ? prev.end_date : undefined,
                                  max_occurrences:
                                    value === 'after_occurrences'
                                      ? prev.max_occurrences && prev.max_occurrences > 0
                                        ? prev.max_occurrences
                                        : 6
                                      : undefined,
                                }))
                              }
                              className={`rounded-full px-3 py-1 text-sm font-medium transition ${ isSelected ? 'bg-ink text-paper' : 'bg-sunken text-body hover:bg-sunken' }`}
                            >
                              {label}
                            </button>
                          )
                        })}
                      </div>
      </div>

                    {subscriptionForm.end_mode === 'on_date' && (
                      <div>
                        <label className="block text-sm font-medium text-body">End after</label>
                        <input
                          type="datetime-local"
                          value={subscriptionForm.end_date ?? ''}
                          onChange={(e) =>
                            setSubscriptionForm((prev) => ({
                              ...prev,
                              end_date: e.target.value || undefined,
                            }))
                          }
                          className="mt-1 block w-full border border-line px-3 py-2"
                        />
                        <p className="mt-1 text-xs text-muted">
                          No additional transactions will be generated after this date.
                        </p>
                      </div>
                    )}

                    {subscriptionForm.end_mode === 'after_occurrences' && (
                      <div>
                        <label className="block text-sm font-medium text-body">Number of runs</label>
                        <input
                          type="number"
                          min={1}
                          value={subscriptionForm.max_occurrences ?? ''}
                          onChange={(e) =>
                            setSubscriptionForm((prev) => ({
                              ...prev,
                              max_occurrences: e.target.value ? Math.max(1, parseInt(e.target.value, 10)) : undefined,
                            }))
                          }
                          className="mt-1 block w-full border border-line px-3 py-2"
                        />
                        <p className="mt-1 text-xs text-muted">
                          Stop once this many transactions have been created.
                        </p>
                      </div>
                    )}
                  </div>

                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                    <div className="flex items-center justify-between border border-line px-4 py-3">
              <div>
                        <p className="text-sm font-medium text-body">Autopay</p>
                        <p className="text-xs text-muted">Mark if the charge posts automatically.</p>
                      </div>
                      <button
                        type="button"
                        onClick={() =>
                          setSubscriptionForm((prev) => ({
                            ...prev,
                            is_autopay: !prev.is_autopay,
                          }))
                        }
                        className={`inline-flex items-center gap-2 rounded-full px-3 py-1 text-sm font-semibold transition-colors duration-200 ${ subscriptionForm.is_autopay ? 'text-ink hover:bg-sunken' : 'bg-sunken text-body hover:bg-sunken' }`}
                      >
                        <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          {subscriptionForm.is_autopay ? (
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                          ) : (
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                          )}
                        </svg>
                        <span>{subscriptionForm.is_autopay ? 'Enabled' : 'Disabled'}</span>
                      </button>
              </div>

                    <div className="flex items-center justify-between border border-line px-4 py-3">
                      <div>
                        <p className="text-sm font-medium text-body">Entry status</p>
                        <p className="text-xs text-muted">Pause recurring entries without deleting them.</p>
            </div>
                      <button
                        type="button"
                        onClick={() =>
                          setSubscriptionForm((prev) => ({
                            ...prev,
                            is_active: !prev.is_active,
                          }))
                        }
                        className={`inline-flex items-center gap-2 rounded-full px-3 py-1 text-sm font-semibold transition-colors duration-200 ${ subscriptionForm.is_active ? 'text-ink hover:bg-sunken' : 'bg-sunken text-body hover:bg-sunken' }`}
                      >
                        <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          {subscriptionForm.is_active ? (
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 9v6m4-6v6M5 5h14a2 2 0 012 2v10a2 2 0 01-2 2H5a2 2 0 01-2-2V7a2 2 0 012-2z" />
                          ) : (
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 5l10 7-10 7V5z" />
                          )}
                        </svg>
                        <span>{subscriptionForm.is_active ? 'Active' : 'Paused'}</span>
                      </button>
                    </div>
      </div>

                  <div>
                    <label className="block text-sm font-medium text-body">Notes</label>
                    <textarea
                      value={subscriptionForm.description}
                      onChange={(e) =>
                        setSubscriptionForm((prev) => ({
                          ...prev,
                          description: e.target.value,
                        }))
                      }
                      className="mt-1 block w-full border border-line px-3 py-2"
                      rows={3}
                    />
                  </div>
                </>
              ) : (
                <>
              <div>
                <label className="block text-sm font-medium text-body">Account</label>
                <select
                      value={allocationForm.account_id}
                      onChange={(e) =>
                        setAllocationForm((prev) => ({
                          ...prev,
                          account_id: parseInt(e.target.value),
                        }))
                      }
                  className="mt-1 block w-full border border-line px-3 py-2"
                  required
                >
                      <option value={0}>Select account</option>
                      {accounts.map((account) => (
                    <option key={account.id} value={account.id}>
                      {account.name}
                    </option>
                  ))}
                </select>
              </div>
              
              <div>
                <label className="block text-sm font-medium text-body">Name</label>
                <input
                  type="text"
                      value={allocationForm.name}
                      onChange={(e) =>
                        setAllocationForm((prev) => ({
                          ...prev,
                          name: e.target.value,
                        }))
                      }
                  className="mt-1 block w-full border border-line px-3 py-2"
                  required
                />
              </div>
              
              <div>
                    <label className="block text-sm font-medium text-body">Description</label>
                    <textarea
                      value={allocationForm.description}
                      onChange={(e) =>
                        setAllocationForm((prev) => ({
                          ...prev,
                          description: e.target.value,
                        }))
                      }
                  className="mt-1 block w-full border border-line px-3 py-2"
                      rows={3}
                    />
                  </div>

                  {allocationForm.allocation_type === 'budget' && (
                    <div>
                      <label className="block text-sm font-medium text-body">Tracked Categories</label>
                      <div className="mt-1 flex flex-wrap gap-2">
                        {categories.map((category) => {
                          const isSelected = selectedBudgetCategoryIds.includes(category.id)
                          return (
                            <button
                              type="button"
                              key={category.id}
                              onClick={() => toggleBudgetCategory(category.id)}
                              className={`rounded-full px-3 py-1 text-sm font-medium transition ${ isSelected ? 'bg-ink text-paper' : 'bg-sunken text-body hover:bg-sunken' }`}
                            >
                              {category.name}
                            </button>
                          )
                        })}
              </div>
                    <p className="mt-2 text-xs text-muted">
                      Transactions in these categories will roll into this envelope when they post.
                    </p>
                    <div className="mt-4 space-y-2">
                      <label className="block text-sm font-medium text-body">Budget cadence</label>
                      <div className="flex flex-wrap gap-2">
                        {budgetCadenceOptions.map((cadence) => {
                          const isSelected = allocationForm.period_frequency === cadence
                          return (
                            <button
                              type="button"
                              key={cadence}
                              onClick={() => handleBudgetCadenceSelect(cadence)}
                              className={`rounded-full px-3 py-1 text-sm font-medium transition ${ isSelected ? 'bg-ink text-paper' : 'bg-sunken text-body hover:bg-sunken' }`}
                            >
                              {formatBudgetCadenceLabel(cadence)}
                            </button>
                          )
                        })}
                      </div>
                      <p className="text-xs text-muted">
                        Choose how often this envelope resets so we can bucket transactions correctly.
                      </p>
                    </div>
                    <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2">
                      <div>
                        <label className="block text-sm font-medium text-body">Period start</label>
                        <input
                          type="date"
                          value={allocationForm.period_start ?? ''}
                          onChange={(e) => handleBudgetPeriodStartChange(e.target.value)}
                  className="mt-1 block w-full border border-line px-3 py-2"
                  required
                        />
                      </div>
                      <div>
                        <label className="block text-sm font-medium text-body">Period end (optional)</label>
                        <input
                          type="date"
                          value={allocationForm.period_end ?? ''}
                          onChange={(e) =>
                            setAllocationForm((prev) => ({
                              ...prev,
                              period_end: e.target.value || undefined,
                            }))
                          }
                          className="mt-1 block w-full border border-line px-3 py-2"
                        />
                      </div>
                    </div>
                    </div>
                  )}
              
                  {allocationForm.allocation_type === 'savings' && (
                    <div className="space-y-3">
              <div>
                        <label className="block text-sm font-medium text-body">Tracking Mode</label>
                        <div className="mt-1 flex flex-wrap gap-2">
                          {[
                            {
                              value: 'target_balance' as AllocationGoalMode,
                              label: 'Target account balance',
                              description: "Track a single account's balance against a goal.",
                            },
                            {
                              value: 'multi_account' as AllocationGoalMode,
                              label: 'Combined account total',
                              description: 'Watch a collection of accounts grow together.',
                            },
                            {
                              value: 'transaction_total' as AllocationGoalMode,
                              label: 'Savings transactions total',
                              description: 'Sum the transfers tagged as savings over time.',
                            },
                          ].map((option) => {
                            const isSelected = allocationForm.goal_mode === option.value
                            return (
                              <button
                                type="button"
                                key={option.value}
                                onClick={() =>
                                  setAllocationForm((prev) => ({
                                    ...prev,
                                    goal_mode: option.value,
                                  }))
                                }
                                className={`border px-3 py-2 text-left text-sm transition ${ isSelected ? 'border-ink text-ink' : 'border-line bg-surface hover:border-line-strong' }`}
                              >
                                <span className="block font-semibold">{option.label}</span>
                                <span className="block text-xs text-muted">{option.description}</span>
                              </button>
                            )
                          })}
                        </div>
              </div>
              
                      {allocationForm.goal_mode === 'multi_account' && (
              <div>
                          <label className="block text-sm font-medium text-body">
                            Accounts to aggregate
                          </label>
                          <div className="mt-1 flex flex-wrap gap-2">
                            {accounts.map((account) => {
                              const isSelected = selectedSavingsAccountIds.includes(account.id)
                              return (
                                <button
                                  type="button"
                                  key={account.id}
                                  onClick={() => toggleSavingsAccount(account.id)}
                                  className={`rounded-full px-3 py-1 text-sm font-medium transition ${ isSelected ? 'bg-ink text-paper' : 'bg-sunken text-body hover:bg-sunken' }`}
                                >
                                  {account.name}
                                </button>
                              )
                            })}
                          </div>
                        </div>
                      )}
                      {allocationForm.goal_mode === 'transaction_total' && (
                        <p className="text-xs text-muted">
                          {savingsCategory
                            ? `We'll total any transactions categorized as "${savingsCategory.name}".`
                            : 'Tip: add a "Savings" category so we know which transactions to roll up.'}
                        </p>
                      )}
                    </div>
                  )}

                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                    <div>
                      <label className="block text-sm font-medium text-body">
                        {allocationForm.allocation_type === 'budget' ? 'Amount already spent' : 'Current Amount'}
                      </label>
                <input
                  type="number"
                  step="0.01"
                  min="0"
                        value={allocationForm.current_amount}
                        onChange={(e) =>
                          setAllocationForm((prev) => ({
                            ...prev,
                            current_amount: parseFloat(e.target.value) || 0,
                          }))
                        }
                  className="mt-1 block w-full border border-line px-3 py-2"
                  required
                />
                      {allocationForm.allocation_type === 'budget' && (
                        <p className="mt-1 text-xs text-muted">
                          Track how much of the envelope has already been used this period.
                        </p>
                      )}
              </div>
              <div>
                      <label className="block text-sm font-medium text-body">
                        {allocationForm.allocation_type === 'budget'
                          ? 'Spending limit'
                          : 'Target Amount (Optional)'}
                      </label>
                <input
                  type="number"
                  step="0.01"
                  min="0"
                        value={allocationForm.target_amount ?? ''}
                        onChange={(e) =>
                          setAllocationForm((prev) => ({
                            ...prev,
                            target_amount: parseFloat(e.target.value) || undefined,
                          }))
                        }
                  className="mt-1 block w-full border border-line px-3 py-2"
                        required={allocationForm.allocation_type === 'budget'}
                      />
                      {allocationForm.allocation_type === 'budget' ? (
                        <p className="mt-1 text-xs text-muted">
                          The maximum amount available for this envelope before it resets.
                        </p>
                      ) : (
                        <p className="mt-1 text-xs text-muted">
                          Optional goal amount you'd like to reach.
                        </p>
                      )}
                    </div>
              </div>
              
                  {allocationForm.allocation_type !== 'budget' && (
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                        <label className="block text-sm font-medium text-body">
                          Monthly Target
                        </label>
                <input
                  type="number"
                  step="0.01"
                  min="0"
                          value={allocationForm.monthly_target ?? ''}
                          onChange={(e) =>
                            setAllocationForm((prev) => ({
                              ...prev,
                              monthly_target: parseFloat(e.target.value) || undefined,
                            }))
                          }
                  className="mt-1 block w-full border border-line px-3 py-2"
                />
              </div>
              <div>
                        <label className="block text-sm font-medium text-body">
                          Target Date
                        </label>
                <input
                  type="date"
                          value={allocationForm.target_date ?? ''}
                          onChange={(e) =>
                            setAllocationForm((prev) => ({
                              ...prev,
                              target_date: e.target.value || undefined,
                            }))
                          }
                  className="mt-1 block w-full border border-line px-3 py-2"
                />
              </div>
                    </div>
                  )}
              
                  <div className="flex items-center justify-between border border-line px-4 py-3">
              <div>
                      <p className="text-sm font-medium text-body">Allocation status</p>
                      <p className="text-xs text-muted">
                        Pause allocations to hide them from planning without losing history.
                      </p>
              </div>
                    <button
                      type="button"
                      onClick={() =>
                        setAllocationForm((prev) => ({
                          ...prev,
                          is_active: !prev.is_active,
                        }))
                      }
                      className={`inline-flex items-center gap-2 rounded-full px-3 py-1 text-sm font-semibold transition-colors duration-200 ${ allocationForm.is_active ? 'text-ink hover:bg-sunken' : 'bg-sunken text-body hover:bg-sunken' }`}
                    >
                      <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        {allocationForm.is_active ? (
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 9v6m4-6v6M5 5h14a2 2 0 012 2v10a2 2 0 01-2 2H5a2 2 0 01-2-2V7a2 2 0 012-2z" />
                        ) : (
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 5l10 7-10 7V5z" />
                        )}
                      </svg>
                      <span>{allocationForm.is_active ? 'Active' : 'Paused'}</span>
                    </button>
                  </div>
                </>
              )}

              <div className="flex flex-col sm:flex-row gap-3 pt-2">
                <button
                  type="submit"
                  className="flex-1 bg-ink text-paper py-2 px-4 hover:bg-ink"
                >
                  {submitButtonLabel}
                </button>
                <button
                  type="button"
                  onClick={closeModal}
                  className="flex-1 bg-sunken text-body py-2 px-4 hover:bg-surface"
                >
                  Cancel
                </button>
                {isSubscriptionMode && editingBudgetEntry && (
                  <button
                    type="button"
                    onClick={() => handleDeleteBudgetEntry(editingBudgetEntry)}
                    className="text-danger py-2 px-4 hover:bg-sunken sm:w-auto"
                  >
                    Delete Recurring Entry
                  </button>
                )}
              </div>
            </form>
          </div>
          </div>
        </div>
      )}
    </div>
  )
}

const BudgetUsageBar: React.FC<{ usagePercentage: number }> = ({ usagePercentage }) => {
  const clampedUsage = Math.min(Math.max(usagePercentage, 0), 100)
  const remainingColor = clampedUsage >= 100 ? 'bg-sunken' : clampedUsage >= 80 ? 'bg-warn' : 'bg-ok'
  const usageColor = clampedUsage >= 100 ? 'bg-danger' : clampedUsage >= 80 ? 'bg-danger' : 'bg-danger'
 
  return (
    <>
      <div className={`relative w-full overflow-hidden h-2 rounded-full transition-colors duration-300 ${remainingColor}`}>
        {clampedUsage > 0 && (
          <div
            className={`absolute right-0 top-0 h-full transition-all duration-300 ${usageColor}`}
            style={{ width: `${clampedUsage}%` }}
          />
        )}
      </div>
      <p className="text-right text-xs font-medium text-muted">
        {clampedUsage.toFixed(1)}% of limit used
      </p>
    </>
  )
}

