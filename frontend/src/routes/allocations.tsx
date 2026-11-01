import { createFileRoute, useNavigate } from '@tanstack/react-router'
import {
  useLazyGetAllocationsQuery,
  useLazyGetBudgetEntriesQuery,
  useGetAccountsQuery,
  useGetCardCreditsQuery,
  useGetCategoriesQuery,
  useCreateAllocationMutation,
  useUpdateAllocationMutation,
  useDeleteAllocationMutation,
  useSetInstallmentAutoPostMutation,
} from '../store/api'
import type {
  Allocation,
  BudgetEntry,
  FullBudgetEntry,
  LimitedBudgetEntry,
  SharedFullBudgetEntry,
  Account,
  Category,
  WishlistItem,
} from '../store/api'
import {
  categoryOptionLabel,
  entryCalendarDate,
  formatEntryDate,
  entryCreditWarning,
  isLimited,
  groupByKind,
  isOwnerFull,
  isSharedFull,
  RECURRING_ACTION_LABELS,
  fieldErrorProps,
  recurringActionsFor,
  withoutError,
} from '@tally-trace/shared'
import type { CardCredit, FieldErrors, KindGroup, RecurringAction } from '@tally-trace/shared'
import { useState, useEffect, useMemo, useRef, useCallback } from 'react'
import { useAuth } from '../contexts/AuthContext'
import { useCurrency } from '../hooks/useCurrency'
import { useConfirm } from '../hooks/useConfirm'
import { useDeleteRecurringEntry } from '../hooks/useDeleteRecurringEntry'
import { useManilaDay } from '../hooks/useManilaDay'
import { useLatestRef, useRequestGeneration } from '../hooks/useRequestGeneration'
import { formatCurrency, CurrencyCode } from '../utils/currency'
import { formatCadenceLabel, formatScheduleLabel } from '../utils/recurringEntry'
import { WishlistPanel } from '../components/WishlistPanel'
import { RecurringEntryFormModal } from '../components/RecurringEntryFormModal'
import { EntryCreditWarningRow, KindCreditLines } from '../components/AllocationsCredit'
import type { KindCreditState } from '../components/AllocationsCredit'
import { TagChips } from '../components/TagChips'
import { TagFilter } from '../components/TagFilter'
import { MarkPaidDialog } from '../components/MarkPaidDialog'
import { InstallmentReviewDialog } from '../components/InstallmentReviewDialog'
import { useToast } from '../hooks/useToast'
import { apiErrorMessage } from '../utils/apiError'
import { SkeletonRows } from '../components/Loading'

const DAY_IN_MS = 24 * 60 * 60 * 1000

type AutoPostState = 'on' | 'off' | 'unreviewed'
const AUTO_POST_STATE_LABELS: Record<AutoPostState, string> = {
  on: 'Auto-post on',
  off: 'Auto-post off',
  unreviewed: 'Not reviewed',
}

const ENTRY_ACTION_TEST_IDS: Record<RecurringAction, string> = {
  mark_paid: 'entry-mark-paid-button',
  mark_received: 'entry-mark-received-button',
  charged: 'entry-charged-button',
  posted: 'entry-posted-button',
}

const startOfDay = (value: Date) => new Date(value.getFullYear(), value.getMonth(), value.getDate())

const differenceInDays = (future: Date, from: Date) =>
  Math.round((startOfDay(future).getTime() - startOfDay(from).getTime()) / DAY_IN_MS)

// A budget entry's dates are wall time stored as UTC components, so they are read
// from those components, not converted to the browser's zone.
const formatFullDate = (isoString: string) => formatEntryDate(isoString)

const formatRelativeDate = (isoString: string) => {
  const target = entryCalendarDate(isoString)
  const today = new Date()
  const days = differenceInDays(target, today)
  if (days === 0) return 'Today'
  if (days === 1) return 'Tomorrow'
  if (days === -1) return 'Yesterday'
  if (days > 0) return `In ${days} day${days === 1 ? '' : 's'}`
  return `${Math.abs(days)} day${days === -1 ? '' : 's'} ago`
}

const formatAmount = (amount: number, currency: CurrencyCode) => formatCurrency(amount, currency)

// The allocation form's inline field errors (STU-410): one message under the field in place
// of a browser popup. A key is a control's `data-field`.
type AllocationFieldKey =
  | 'account_id'
  | 'name'
  | 'category_ids'
  | 'savings_account_ids'
  | 'period_frequency'
  | 'period_start'
  | 'period_end'
  | 'current_amount'
  | 'target_amount'
  | 'monthly_target'
  | 'target_date'
const isAllocationFieldKey = (key: string | undefined): key is AllocationFieldKey =>
  key !== undefined &&
  [
    'account_id', 'name', 'category_ids', 'savings_account_ids', 'period_frequency', 'period_start',
    'period_end', 'current_amount', 'target_amount', 'monthly_target', 'target_date',
  ].includes(key)

/** The app's own wording for a required field left empty; a bound such as `min` uses the browser's text. */
const ALLOCATION_REQUIRED_COPY: Partial<Record<AllocationFieldKey, string>> = {
  name: 'Please enter a name for this allocation.',
  account_id: 'Please choose a primary account.',
  period_start: 'Provide a start date for this budget period.',
}

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

export const Route = createFileRoute('/allocations')({
  component: AllocationsPage,
})

export function AllocationsPage() {
  const { isAuthenticated, isLoading: authLoading } = useAuth()
  const navigate = useNavigate()
  const { format } = useCurrency()

  useEffect(() => {
    if (!authLoading && !isAuthenticated) {
      navigate({ to: '/login', search: { message: undefined } })
    }
  }, [isAuthenticated, authLoading, navigate])

  const [isCreateModalOpen, setIsCreateModalOpen] = useState(false)
  const [editingAllocation, setEditingAllocation] = useState<Allocation | null>(null)
  // The recurring entry form: null when closed, else the entry it edits (null to add one).
  // An entry the caller can edit is one they see in full or shared-full, never Limited.
  const [recurringModal, setRecurringModal] = useState<{ entry: FullBudgetEntry | SharedFullBudgetEntry | null } | null>(
    null
  )
  const [reviewFor, setReviewFor] = useState<{ entryId: number; name: string } | null>(null)
  const [turningOffId, setTurningOffId] = useState<number | null>(null)
  const [markPaidFor, setMarkPaidFor] = useState<{ entry: FullBudgetEntry | SharedFullBudgetEntry; action: RecurringAction } | null>(null)
  const [isActionModalOpen, setIsActionModalOpen] = useState(false)
  const [actionAllocation, setActionAllocation] = useState<Allocation | null>(null)
  const [activeTab, setActiveTab] = useState<'subscriptions' | 'budgets' | 'savings' | 'wishlist'>('subscriptions')

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

  const [allocationForm, setAllocationForm] = useState<AllocationFormState>(() =>
    createAllocationDefaults('savings')
  )

  const [selectedBudgetCategoryIds, setSelectedBudgetCategoryIds] = useState<number[]>([])
  const [selectedSavingsAccountIds, setSelectedSavingsAccountIds] = useState<number[]>([])
  const [fieldErrors, setFieldErrors] = useState<FieldErrors<AllocationFieldKey>>({})
  // A refusal with no single field to fix, or a control the form does not wire.
  const [formError, setFormError] = useState('')
  const fieldRefs = useRef<Partial<Record<AllocationFieldKey, HTMLElement | null>>>({})
  // The controls the browser flagged invalid in one submit attempt, in tree order.
  const invalidTargets = useRef<HTMLElement[]>([])

  const [triggerAllocations] = useLazyGetAllocationsQuery()
  const [triggerBudgetEntries] = useLazyGetBudgetEntriesQuery()
  const [setAutoPost] = useSetInstallmentAutoPostMutation()
  const showToast = useToast()
  const beginBudgetEntriesRequest = useRequestGeneration()
  const beginAllocationsRequest = useRequestGeneration()
  const { data: accountsData } = useGetAccountsQuery(
    { is_active: true, limit: 100 },
    { skip: !isAuthenticated }
  )
  // Every mount fetches: Accounts holds this cache entry too, and its copy can predate Manila midnight.
  const {
    currentData: creditData,
    error: creditError,
    refetch: refetchCredit,
  } = useGetCardCreditsQuery(undefined, { skip: !isAuthenticated, refetchOnMountOrArgChange: true })
  // The checks' window starts at Manila midnight, so refetch when the day turns.
  useManilaDay(() => {
    if (isAuthenticated) void refetchCredit()
  })
  const { data: categoriesData } = useGetCategoriesQuery(
    { is_active: true },
    { skip: !isAuthenticated }
  )
  
  const [createAllocation] = useCreateAllocationMutation()
  const [updateAllocation] = useUpdateAllocationMutation()
  const [deleteAllocation] = useDeleteAllocationMutation()
  const deleteRecurringEntry = useDeleteRecurringEntry()
  const askConfirm = useConfirm()
  const accounts = useMemo(() => accountsData?.items ?? [], [accountsData])
  // Allocations are private to their owner, so only the caller's own accounts can back one.
  const ownAccounts = useMemo(() => accounts.filter((a) => a.my_role === 'owner'), [accounts])
  const categories = useMemo(() => categoriesData ?? [], [categoriesData])
  // An expense or income category may share the name, so the transfer "Savings" wins.
  const savingsCategory = useMemo(
    () =>
      categories.find(
        (category) => category.name.toLowerCase() === 'savings' && category.kind === 'transfer'
      ) ?? categories.find((category) => category.name.toLowerCase() === 'savings'),
    [categories]
  )
  const submitButtonLabel = editingAllocation
    ? 'Update Allocation'
    : allocationForm.allocation_type === 'budget'
    ? 'Create Budget Envelope'
    : 'Create Savings Tracker'
  const accountsById = useMemo(() => {
    const map = new Map<number, Account>()
    accounts.forEach((account) => map.set(account.id, account))
    return map
  }, [accounts])
  // The server fills this only for cards the caller owns or administers that have a limit.
  const creditByCard = useMemo(() => {
    const map = new Map<number, CardCredit>()
    creditData?.items.forEach((credit) => map.set(credit.account_id, credit))
    return map
  }, [creditData])
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
  const actionAllocationCategories = Array.isArray(actionAllocationConfig['category_ids'])
    ? (actionAllocationConfig['category_ids'] as unknown[])
        .map((value) => {
          const id = Number(value)
          if (Number.isNaN(id)) {
            return null
          }
          return categoriesById.get(id) ?? null
        })
        .filter((category): category is Category => Boolean(category))
    : []
  const limit = 10
  const [allocationItems, setAllocationItems] = useState<Allocation[]>([])
  const [totalAllocations, setTotalAllocations] = useState(0)
  const [hasMoreAllocations, setHasMoreAllocations] = useState(true)
  const offsetRef = useRef(0)
  const loadMoreObserver = useRef<IntersectionObserver | null>(null)
  // The first load has settled; later resets keep the rows on screen until they land.
  const [hasLoaded, setHasLoaded] = useState(false)
  const [isResetting, setIsResetting] = useState(false)
  const [isFetchingMore, setIsFetchingMore] = useState(false)
  // The last reset failed: an alert with Retry shows, above any rows still on screen.
  const [loadError, setLoadError] = useState(false)
  // The first recurring load has settled; later reloads keep the sections on screen.
  const [recurringLoaded, setRecurringLoaded] = useState(false)
  const [recurringError, setRecurringError] = useState(false)
  const [recurringIncome, setRecurringIncome] = useState<BudgetEntry[]>([])
  const [recurringExpenses, setRecurringExpenses] = useState<BudgetEntry[]>([])
  const [selectedTag, setSelectedTag] = useState<number | undefined>(undefined)

  const loadAllocations = useCallback(
    async (reset = false) => {
      if (!isAuthenticated) {
        return
      }

      // A reset starts a new generation; a load-more joins it, and is dropped if a
      // reset begins before it lands.
      const isCurrent = beginAllocationsRequest(reset)
      const nextOffset = reset ? 0 : offsetRef.current
      const params = {
        limit,
        offset: nextOffset,
      }

      try {
        if (reset) {
          offsetRef.current = 0
          setIsResetting(true)
          setIsFetchingMore(false)
        } else {
          setIsFetchingMore(true)
        }

        const result = await triggerAllocations(params).unwrap()
        if (!isCurrent()) return
        offsetRef.current = nextOffset + result.items.length
        setAllocationItems((prev) => (reset ? result.items : [...prev, ...result.items]))
        setTotalAllocations(result.total)
        setHasMoreAllocations(result.has_more)
        if (reset) {
          setLoadError(false)
        }
      } catch (error) {
        if (!isCurrent()) return
        console.error('Error loading allocations:', error)
        if (reset) {
          // The rows already on screen stay; no load-more runs until a Retry lands.
          setHasMoreAllocations(false)
          setLoadError(true)
        }
      } finally {
        if (isCurrent()) {
          if (reset) {
            setIsResetting(false)
            setHasLoaded(true)
          } else {
            setIsFetchingMore(false)
          }
        }
      }
    },
    [triggerAllocations, isAuthenticated, beginAllocationsRequest]
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
    const isCurrent = beginBudgetEntriesRequest(true)
    try {
      const tagParam = selectedTag !== undefined ? { tag: selectedTag } : {}
      const [incomeResult, expenseResult] = await Promise.all([
        triggerBudgetEntries({ entry_type: 'income', limit: 100, ...tagParam }).unwrap(),
        triggerBudgetEntries({ entry_type: 'expense', limit: 100, ...tagParam }).unwrap(),
      ])
      if (!isCurrent()) return
      setRecurringIncome(incomeResult.items)
      setRecurringExpenses(expenseResult.items)
      setRecurringError(false)
    } catch (error) {
      if (!isCurrent()) return
      console.error('Error loading budget entries:', error)
      setRecurringError(true)
    } finally {
      if (isCurrent()) {
        setRecurringLoaded(true)
      }
    }
  }, [isAuthenticated, triggerBudgetEntries, beginBudgetEntriesRequest, selectedTag])
  const loadBudgetEntriesRef = useLatestRef(loadBudgetEntries)

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
        if (entries[0]?.isIntersecting && !isResetting && !isFetchingMore && hasLoaded && hasMoreAllocations) {
          loadAllocations(false)
        }
      })

      loadMoreObserver.current.observe(node)
    },
    [hasMoreAllocations, isFetchingMore, isResetting, hasLoaded, loadAllocations]
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
      setEditingAllocation(null)
      setRecurringModal({ entry: null })
      return
    }
    const presetType = activeTab === 'budgets' ? 'budget' : 'savings'
    setAllocationForm(createAllocationDefaults(presetType))
    setSelectedBudgetCategoryIds([])
    setSelectedSavingsAccountIds([])
    setEditingAllocation(null)
    setIsCreateModalOpen(true)
  }, [activeTab, createAllocationDefaults])

  const openAllocationFromWishlist = useCallback(
    (item: WishlistItem, kind: 'budget' | 'savings') => {
      setEditingAllocation(null)
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

  const openRecurringModal = useCallback((entry?: BudgetEntry) => {
    // A Limited entry has no fields to edit.
    if (entry && isLimited(entry)) {
      return
    }
    setActiveTab('subscriptions')
    setEditingAllocation(null)
    setRecurringModal({ entry: entry ?? null })
  }, [])

  const closeModal = useCallback(() => {
    setFieldErrors({})
    setFormError('')
    setIsCreateModalOpen(false)
    setEditingAllocation(null)
    const type = activeTab === 'budgets' ? 'budget' : 'savings'
    setAllocationForm(createAllocationDefaults(type))
    setSelectedBudgetCategoryIds([])
    setSelectedSavingsAccountIds([])
  }, [activeTab, createAllocationDefaults])

  const bindField = (key: AllocationFieldKey) => (el: HTMLElement | null) => {
    fieldRefs.current[key] = el
  }
  const fieldErrorId = (key: AllocationFieldKey) => `allocation-${key}-error`
  const fieldProps = (key: AllocationFieldKey) => fieldErrorProps(fieldErrors, key, fieldErrorId(key))
  // A picker group (chips) takes the description only: aria-invalid is not valid on a group.
  const groupProps = (key: AllocationFieldKey) => ({
    role: 'group' as const,
    'aria-describedby': fieldProps(key)['aria-describedby'],
    'data-field': key,
    ref: bindField(key),
  })
  const focusField = (key: AllocationFieldKey) => {
    const el = fieldRefs.current[key]
    if (!el) return
    // A chip group focuses its selected chip, else its first.
    const target =
      el.getAttribute('role') === 'group'
        ? el.querySelector<HTMLElement>('[data-selected="true"]') ?? el.querySelector<HTMLElement>('button')
        : el
    target?.focus()
  }
  const fail = (key: AllocationFieldKey, message: string) => {
    setFormError('')
    setFieldErrors({ [key]: message })
    focusField(key)
  }
  const clearFieldErrors = (...keys: AllocationFieldKey[]) =>
    setFieldErrors((prev) => keys.reduce<FieldErrors<AllocationFieldKey>>(withoutError, prev))
  const renderFieldError = (key: AllocationFieldKey) =>
    fieldErrors[key] ? (
      <p
        id={fieldErrorId(key)}
        className="mt-1 text-xs text-danger"
        role="alert"
        data-testid={`field-error-${key}`}
      >
        {fieldErrors[key]}
      </p>
    ) : null
  // Editing a field clears its message (a changed start date also clears the end's).
  const handleFormChange = (e: React.ChangeEvent<HTMLFormElement>) => {
    setFormError('')
    const key = (e.target as HTMLElement).dataset.field
    if (!isAllocationFieldKey(key)) return
    clearFieldErrors(key, ...(key === 'period_start' ? (['period_end'] as const) : []))
  }
  // The browser keeps owning every required/min/step; only its popup is replaced. The
  // `invalid` events fire in tree order during the submit's validity check, so the first one
  // collected is the first invalid field. A timer, not a microtask: on a real click the
  // microtask queue drains between two events, so a microtask would see one field per attempt.
  const handleInvalid = (e: React.FormEvent<HTMLFormElement>) => {
    const target = e.target as HTMLInputElement | HTMLSelectElement
    // Every invalid control loses its popup, wired or not: an unwired one (no data-field) is
    // reported in the form-level message above Save, so it fails visibly, never in a bubble.
    e.preventDefault()
    const targets = invalidTargets.current
    targets.push(target)
    if (targets.length > 1) return
    window.setTimeout(() => {
      const first = invalidTargets.current[0] as HTMLInputElement | undefined
      invalidTargets.current = []
      if (!first) return
      const key = first.dataset.field
      if (!isAllocationFieldKey(key)) {
        setFieldErrors({})
        setFormError(first.validationMessage || 'Please check this field.')
        first.focus()
        return
      }
      fail(key, (first.validity.valueMissing && ALLOCATION_REQUIRED_COPY[key]) || first.validationMessage)
    }, 0)
  }

  const toggleBudgetCategory = (categoryId: number) => {
    clearFieldErrors('category_ids')
    setSelectedBudgetCategoryIds((prev) =>
      prev.includes(categoryId) ? prev.filter((id) => id !== categoryId) : [...prev, categoryId]
    )
  }

  const toggleSavingsAccount = (accountId: number) => {
    clearFieldErrors('savings_account_ids')
    setSelectedSavingsAccountIds((prev) =>
      prev.includes(accountId) ? prev.filter((id) => id !== accountId) : [...prev, accountId]
    )
  }

  const handleBudgetCadenceSelect = useCallback(
    (cadence: BudgetCadence) => {
      setFieldErrors((prev) =>
        (['period_frequency', 'period_start', 'period_end'] as const).reduce<FieldErrors<AllocationFieldKey>>(withoutError, prev))
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

  // After a recurring entry is deleted, from its card or its form: close the form and
  // reload the list, so the card goes at once.
  const handleBudgetEntryDeleted = useCallback(async () => {
    setRecurringModal(null)
    await loadBudgetEntriesRef.current()
  }, [loadBudgetEntriesRef])

  const handleDeleteBudgetEntry = useCallback(
    async (entry: BudgetEntry) => {
      if (await deleteRecurringEntry(entry)) {
        await handleBudgetEntryDeleted()
      }
    },
    [deleteRecurringEntry, handleBudgetEntryDeleted]
  )

  // Turn a reviewed installment's auto-post off (it stays reviewed); a failure has no dialog, so it is toasted.
  const handleTurnOffAutoPost = useCallback(
    async (entry: BudgetEntry) => {
      setTurningOffId(entry.id)
      try {
        await setAutoPost({ id: entry.id, data: { enabled: false } }).unwrap()
        await loadBudgetEntriesRef.current()
      } catch (error) {
        showToast(apiErrorMessage(error))
      } finally {
        setTurningOffId(null)
      }
    },
    [setAutoPost, loadBudgetEntriesRef, showToast]
  )

  const handleBudgetEntrySaved = useCallback(async () => {
    setRecurringModal(null)
    await loadBudgetEntriesRef.current()
  }, [loadBudgetEntriesRef])

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setFieldErrors({})
    setFormError('')
    try {
      if (!allocationForm.name.trim()) {
        fail('name', 'Please enter a name for this allocation.')
        return
      }
      if (!allocationForm.account_id) {
        fail('account_id', 'Please choose a primary account.')
        return
      }
      if (allocationForm.allocation_type === 'budget' && selectedBudgetCategoryIds.length === 0) {
        fail('category_ids', 'Select at least one category for this budget envelope.')
        return
      }
      if (
        allocationForm.allocation_type !== 'budget' &&
        allocationForm.goal_mode === 'multi_account' &&
        selectedSavingsAccountIds.length === 0
      ) {
        fail('savings_account_ids', 'Choose at least one account to aggregate for this savings tracker.')
        return
      }
      if (
        allocationForm.allocation_type !== 'budget' &&
        allocationForm.goal_mode === 'transaction_total' &&
        !savingsCategory
      ) {
        setFormError('Create a "Savings" category first so we can total those transactions.')
        return
      }

      if (allocationForm.allocation_type === 'budget') {
        if (!allocationForm.period_frequency) {
          fail('period_frequency', 'Select how often this budget resets (daily, weekly, monthly, or quarterly).')
          return
        }
        if (!allocationForm.period_start) {
          fail('period_start', 'Provide a start date for this budget period.')
          return
        }
        if (allocationForm.period_start && allocationForm.period_end) {
          const startDate = new Date(allocationForm.period_start)
          const endDate = new Date(allocationForm.period_end)
          if (Number.isNaN(startDate.getTime()) || Number.isNaN(endDate.getTime())) {
            fail('period_start', 'Budget period dates must be valid calendar dates.')
            return
          }
          if (endDate <= startDate) {
            fail('period_end', 'Budget end date must be after the start date.')
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
    // The delete runs from the dialog, so a refusal stays there with the server's reason.
    const deleted = await askConfirm({
      title: 'Delete allocation?',
      message: 'Are you sure you want to delete this allocation?',
      confirmLabel: 'Delete allocation',
      action: () => deleteAllocation(allocationId).unwrap(),
      errorFallback: 'Could not delete the allocation. Please try again.',
    })
    if (!deleted) return
    if (actionAllocation?.id === allocationId) {
      closeActionModal()
    }
    await loadAllocations(true)
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
    const budgetCategories = Array.isArray(configuration['category_ids'])
      ? (configuration['category_ids'] as Array<number | string>)
          .map((id) => {
            const parsed = Number(id)
            return Number.isFinite(parsed) ? categoriesById.get(parsed) : undefined
          })
          .filter((category): category is Category => Boolean(category))
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
                {allocation.allocation_type === 'budget' && budgetCategories.length > 0 && (
                  <div className="mt-2 flex flex-wrap gap-2 text-xs">
                    {budgetCategories.map((category) => (
                      <span
                        key={category.id}
                        className="inline-flex items-center gap-1 rounded-full px-2 py-1 text-warn"
                      >
                        {categoryOptionLabel(category, categories)}
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

  // A Limited entry shows only its allowlisted fields; a hidden account is a neutral name
  // with no id, so nothing here links into it. It is read-only: its flags decide whether a
  // delete is offered.
  const renderLimitedEntryCard = (entry: LimitedBudgetEntry) => (
    <article key={entry.id} className="card p-4 sm:p-5" data-testid="limited-entry">
      <div className="flex flex-col gap-3">
        <div className="flex items-start justify-between gap-4">
          <div className="space-y-1">
            <p className="text-base font-semibold text-ink">{entry.display_name ?? 'Recurring entry'}</p>
            <div className="flex flex-wrap items-center gap-2 text-xs uppercase tracking-wide text-muted">
              <span>{entry.entry_type === 'income' ? 'Recurring Income' : 'Recurring Expense'}</span>
              <span className="text-muted">•</span>
              <span>{formatCadenceLabel(entry.cadence)}</span>
            </div>
          </div>
          <div className="text-right">
            <p className={`text-lg font-bold ${entry.entry_type === 'income' ? 'text-ok' : 'text-danger'}`}>
              {formatAmount(entry.amount, entry.currency)}
            </p>
          </div>
        </div>
        <div className="flex flex-wrap gap-2 text-xs text-body">
          <span className="inline-flex items-center gap-1 px-2 py-1 text-ink">
            Next {formatFullDate(entry.next_occurrence)}
          </span>
          {entry.account && (
            <span className="inline-flex items-center gap-1 rounded-full bg-sunken px-2 py-1">
              Account: {entry.account.name}
            </span>
          )}
          {entry.counterpart && (
            <span className="inline-flex items-center gap-1 rounded-full bg-sunken px-2 py-1">
              Transfer to: {entry.counterpart.name}
            </span>
          )}
          {entry.category_name && (
            <span className="inline-flex items-center gap-1 rounded-full bg-sunken px-2 py-1">
              Category: {entry.category_name}
            </span>
          )}
          {entry.end_date && (
            <span className="inline-flex items-center gap-1 rounded-full bg-sunken px-2 py-1">
              Ends {formatFullDate(entry.end_date)}
            </span>
          )}
          {entry.created_by && (
            <span className="inline-flex items-center gap-1 rounded-full bg-sunken px-2 py-1" data-testid="created-by">
              by {entry.created_by}
            </span>
          )}
          <TagChips tags={entry.tags} />
        </div>
        {entry.permissions.can_delete && (
          <div>
            <button
              type="button"
              onClick={() => handleDeleteBudgetEntry(entry)}
              className="text-sm text-danger hover:underline"
            >
              Delete recurring entry
            </button>
          </div>
        )}
      </div>
    </article>
  )

  const renderBudgetEntryCard = (entry: BudgetEntry) => {
    if (isLimited(entry)) {
      return renderLimitedEntryCard(entry)
    }
    const canEdit = entry.permissions.can_edit
    const account = entry.account_id ? accountsById.get(entry.account_id) : undefined
    const transferTo = entry.transfer_to_account_id ? accountsById.get(entry.transfer_to_account_id) : undefined
    const categoryName = isSharedFull(entry)
      ? entry.category_name
      : entry.category_id
      ? categoriesById.get(entry.category_id)?.name
      : undefined
    const allocation = isOwnerFull(entry) && entry.allocation_id ? allocationsById.get(entry.allocation_id) : undefined
    const cadenceLabel = formatScheduleLabel(entry.cadence, entry)
    const creditWarning =
      entry.is_active && (entry.kind === 'subscription' || entry.kind === 'bill') && entry.account_id !== undefined
        ? entryCreditWarning(creditByCard.get(entry.account_id)?.checks ?? [], entry.id)
        : null
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

    // A live card installment shows whether its months auto-post: on, off after a review, or not reviewed yet.
    const showAutoPost = entry.kind === 'installment' && entry.is_active && remaining !== 0
    const autoPostState: AutoPostState = entry.auto_post_enabled ? 'on' : entry.installment_reviewed ? 'off' : 'unreviewed'

    const actions =
      entry.is_active && remaining !== 0 ? recurringActionsFor({ ...entry, can_mark_paid: entry.permissions.can_post }) : []

    return (
      <article
        key={entry.id}
        className={`card p-4 sm:p-5 transition-colors duration-200 ${canEdit ? 'hover:bg-sunken cursor-pointer' : ''} ${ entry.is_active ? '' : 'opacity-60' }`}
        onClick={canEdit ? () => openRecurringModal(entry) : undefined}
        role={canEdit ? 'button' : undefined}
        tabIndex={canEdit ? 0 : undefined}
        onKeyDown={
          canEdit
            ? (event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault()
                  openRecurringModal(entry)
                }
              }
            : undefined
        }
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
            {transferTo && (
              <span className="inline-flex items-center gap-1 rounded-full bg-sunken px-2 py-1">
                Transfer to: {transferTo.name}
              </span>
            )}
            {categoryName && (
              <span className="inline-flex items-center gap-1 rounded-full bg-sunken px-2 py-1">
                Category: {categoryName}
              </span>
            )}
            {entry.created_by && (
              <span className="inline-flex items-center gap-1 rounded-full bg-sunken px-2 py-1" data-testid="created-by">
                by {entry.created_by}
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
            <TagChips tags={entry.tags} />
          </div>
          {creditWarning && <EntryCreditWarningRow warning={creditWarning} />}
          {showAutoPost && (
            <div className="flex flex-wrap items-center gap-2 text-xs text-body" data-testid="installment-auto-post" data-source={`budget_entry:${entry.id}`}>
              <span className="inline-flex items-center gap-1 rounded-full bg-sunken px-2 py-1" data-testid="installment-auto-post-state" data-state={autoPostState}>
                {AUTO_POST_STATE_LABELS[autoPostState]}
              </span>
              {canEdit && autoPostState !== 'on' && (
                <button
                  type="button"
                  onClick={(event) => {
                    event.stopPropagation()
                    setReviewFor({ entryId: entry.id, name: entry.name })
                  }}
                  onKeyDown={(event) => event.stopPropagation()}
                  className="btn-secondary focus-ring"
                  data-testid="installment-review"
                >
                  Review
                </button>
              )}
              {canEdit && autoPostState === 'on' && (
                <button
                  type="button"
                  disabled={turningOffId === entry.id}
                  onClick={(event) => {
                    event.stopPropagation()
                    void handleTurnOffAutoPost(entry)
                  }}
                  onKeyDown={(event) => event.stopPropagation()}
                  className="btn-secondary focus-ring"
                  data-testid="installment-turn-off"
                >
                  Turn off
                </button>
              )}
            </div>
          )}
          {actions.length > 0 && (
            <div className="flex flex-wrap gap-2">
              {actions.map((action) => (
                <button
                  key={action}
                  type="button"
                  onClick={(event) => {
                    event.stopPropagation()
                    setMarkPaidFor({ entry, action })
                  }}
                  onKeyDown={(event) => event.stopPropagation()}
                  className="inline-flex items-center gap-1 bg-ok px-2.5 py-1 text-xs font-semibold text-paper hover:bg-ok transition-colors"
                  data-testid={ENTRY_ACTION_TEST_IDS[action]}
                >
                  {RECURRING_ACTION_LABELS[action]}
                </button>
              ))}
            </div>
          )}
          {!canEdit && entry.permissions.can_delete && (
            <div>
              <button
                type="button"
                onClick={(event) => {
                  event.stopPropagation()
                  void handleDeleteBudgetEntry(entry)
                }}
                className="text-sm text-danger hover:underline"
              >
                Delete recurring entry
              </button>
            </div>
          )}
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
      {loadError && (
        <div className="card p-4 space-y-3" role="alert" data-testid="allocations-load-error">
          <p className="text-sm text-danger">Could not load allocations.</p>
          <button
            type="button"
            className="btn-secondary focus-ring"
            data-testid="allocations-retry"
            onClick={() => void loadAllocations(true)}
          >
            Retry
          </button>
        </div>
      )}
      {allocations.length === 0 ? (
        loadError ? null : <div className="card p-6 text-center text-muted">{emptyMessage}</div>
      ) : (
        <div className="grid grid-cols-1 gap-3">{allocations.map(renderAllocationCard)}</div>
      )}
    </section>
  )

  // Active, non-limited entries of a group: the only ones a credit line or placeholder is about.
  const creditEntries = (group: KindGroup): Array<FullBudgetEntry | SharedFullBudgetEntry> =>
    group.entries.filter((e): e is FullBudgetEntry | SharedFullBudgetEntry => !isLimited(e) && e.is_active)

  // Placeholders show only for a card the caller manages; a figure comes only from creditData.
  const managesCredit = (accountId: number | undefined) => {
    const account = accountId === undefined ? undefined : accountsById.get(accountId)
    return !!account && account.account_type === 'credit' && account.permissions.can_edit_settings && account.credit_limit != null
  }

  const renderKindCredit = (group: KindGroup) => {
    if (group.key !== 'subscription' && group.key !== 'bill') return null
    const entries = creditEntries(group)
    const cardIds = [
      ...new Set(
        entries.flatMap((e) => (e.account_id !== undefined && creditByCard.has(e.account_id) && accountsById.has(e.account_id) ? [e.account_id] : []))
      ),
    ].sort((a, b) => (accountsById.get(a)?.name ?? '').localeCompare(accountsById.get(b)?.name ?? '') || a - b)
    let state: KindCreditState = 'hidden'
    if (creditData) {
      if (cardIds.length > 0) state = creditError ? 'ready-error' : 'ready'
    } else if (entries.some((e) => managesCredit(e.account_id))) {
      state = creditError ? 'error' : 'loading'
    }
    return (
      <KindCreditLines
        cardIds={cardIds}
        accountsById={accountsById}
        creditByCard={creditByCard}
        state={state}
        onRetry={() => void refetchCredit()}
      />
    )
  }

  // Recurring entries by kind: subscriptions, card installments, cash expenses,
  // card-billed bills, then income and transfers, then what is shared with you.
  const renderRecurringKindSections = () => {
    if (!recurringLoaded) {
      return (
        <div className="card p-6" aria-busy="true" data-testid="recurring-pending">
          <span role="status" className="sr-only">Loading recurring entries</span>
          <SkeletonRows rows={3} />
        </div>
      )
    }
    const groups = groupByKind([...recurringExpenses, ...recurringIncome])
    const errorAlert = recurringError && (
      <div className="card p-4 space-y-3" role="alert" data-testid="recurring-load-error">
        <p className="text-sm text-danger">Could not load recurring entries.</p>
        <button
          type="button"
          className="btn-secondary focus-ring"
          data-testid="recurring-retry"
          onClick={() => void loadBudgetEntries()}
        >
          Retry
        </button>
      </div>
    )
    if (groups.length === 0) {
      return (
        errorAlert || (
          <div className="card p-6 text-center text-muted">
            No recurring entries yet. Add your regular income, bills and subscriptions to stay ahead.
          </div>
        )
      )
    }
    return (
      <>
        {errorAlert}
        {groups.map((group) => (
          <section key={group.key} className="space-y-3" data-testid={`kind-section-${group.key}`}>
            <header className="flex items-baseline gap-2 border-b border-line pb-1">
              <h2 className="text-xl font-semibold text-ink">{group.label}</h2>
              <span className="text-sm text-muted">{group.entries.length}</span>
            </header>
            {renderKindCredit(group)}
            <div className="grid grid-cols-1 gap-3">{group.entries.map(renderBudgetEntryCard)}</div>
          </section>
        ))}
      </>
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

  // Only the envelope tabs wait for the first allocations load.
  if (!hasLoaded && (activeTab === 'budgets' || activeTab === 'savings')) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <div className="text-xl">Loading...</div>
      </div>
    )
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

      {activeTab === 'subscriptions' && <TagFilter value={selectedTag} onChange={setSelectedTag} />}

      {activeTab === 'subscriptions' && renderRecurringKindSections()}

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
          {hasLoaded && (isFetchingMore || hasMoreAllocations) && (
            <p className="text-center text-xs text-muted pb-2">
              {isFetchingMore ? 'Loading more envelopes...' : 'Scroll for more envelopes'}
            </p>
          )}
          {!loadError && hasLoaded && !hasMoreAllocations && totalAllocations > 0 && (
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
                {actionAllocationIsBudget && actionAllocationCategories.length > 0 && (
                  <div className="mt-2 flex flex-wrap gap-2 text-xs">
                    {actionAllocationCategories.map((category) => (
                      <span
                        key={category.id}
                        className="inline-flex items-center gap-1 rounded-full px-2 py-1 text-warn"
                      >
                        {categoryOptionLabel(category, categories)}
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
                  {editingAllocation
                    ? 'Edit Allocation'
                    : activeTab === 'budgets'
                    ? 'Create Budget Envelope'
                    : 'Create Savings Tracker'}
            </h2>
                <p className="text-sm text-muted">
                  {activeTab === 'budgets'
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
                
            <form onSubmit={handleSubmit} onChange={handleFormChange} onInvalidCapture={handleInvalid} className="space-y-5">
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
                  ref={bindField('account_id')}
                  data-field="account_id"
                  {...fieldProps('account_id')}
                >
                      <option value={0}>Select account</option>
                      {ownAccounts.map((account) => (
                    <option key={account.id} value={account.id}>
                      {account.name}
                    </option>
                  ))}
                </select>
                {renderFieldError('account_id')}
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
                  ref={bindField('name')}
                  data-field="name"
                  {...fieldProps('name')}
                />
                {renderFieldError('name')}
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
                      <label className="block text-sm font-medium text-body" id="allocation-categories-label">Tracked Categories</label>
                      <div className="mt-1 flex flex-wrap gap-2" aria-labelledby="allocation-categories-label" {...groupProps('category_ids')}>
                        {categories.map((category) => {
                          const isSelected = selectedBudgetCategoryIds.includes(category.id)
                          return (
                            <button
                              type="button"
                              key={category.id}
                              data-selected={isSelected ? 'true' : undefined}
                              aria-describedby={fieldProps('category_ids')['aria-describedby']}
                              onClick={() => toggleBudgetCategory(category.id)}
                              className={`rounded-full px-3 py-1 text-sm font-medium transition ${ isSelected ? 'bg-ink text-paper' : 'bg-sunken text-body hover:bg-sunken' }`}
                            >
                              {categoryOptionLabel(category, categories)}
                            </button>
                          )
                        })}
              </div>
                    {renderFieldError('category_ids')}
                    <p className="mt-2 text-xs text-muted">
                      Transactions in these categories will roll into this envelope when they post.
                    </p>
                    <div className="mt-4 space-y-2">
                      <label className="block text-sm font-medium text-body" id="allocation-cadence-label">Budget cadence</label>
                      <div className="flex flex-wrap gap-2" aria-labelledby="allocation-cadence-label" {...groupProps('period_frequency')}>
                        {budgetCadenceOptions.map((cadence) => {
                          const isSelected = allocationForm.period_frequency === cadence
                          return (
                            <button
                              type="button"
                              key={cadence}
                              data-selected={isSelected ? 'true' : undefined}
                              aria-describedby={fieldProps('period_frequency')['aria-describedby']}
                              onClick={() => handleBudgetCadenceSelect(cadence)}
                              className={`rounded-full px-3 py-1 text-sm font-medium transition ${ isSelected ? 'bg-ink text-paper' : 'bg-sunken text-body hover:bg-sunken' }`}
                            >
                              {formatBudgetCadenceLabel(cadence)}
                            </button>
                          )
                        })}
                      </div>
                      {renderFieldError('period_frequency')}
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
                          ref={bindField('period_start')}
                          data-field="period_start"
                          {...fieldProps('period_start')}
                        />
                        {renderFieldError('period_start')}
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
                          ref={bindField('period_end')}
                          data-field="period_end"
                          {...fieldProps('period_end')}
                        />
                        {renderFieldError('period_end')}
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
                                onClick={() => {
                                  setFormError('')
                                  setAllocationForm((prev) => ({
                                    ...prev,
                                    goal_mode: option.value,
                                  }))
                                }}
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
                          <label className="block text-sm font-medium text-body" id="allocation-savings-accounts-label">
                            Accounts to aggregate
                          </label>
                          <div className="mt-1 flex flex-wrap gap-2" aria-labelledby="allocation-savings-accounts-label" {...groupProps('savings_account_ids')}>
                            {ownAccounts.map((account) => {
                              const isSelected = selectedSavingsAccountIds.includes(account.id)
                              return (
                                <button
                                  type="button"
                                  key={account.id}
                                  data-selected={isSelected ? 'true' : undefined}
                                  aria-describedby={fieldProps('savings_account_ids')['aria-describedby']}
                                  onClick={() => toggleSavingsAccount(account.id)}
                                  className={`rounded-full px-3 py-1 text-sm font-medium transition ${ isSelected ? 'bg-ink text-paper' : 'bg-sunken text-body hover:bg-sunken' }`}
                                >
                                  {account.name}
                                </button>
                              )
                            })}
                          </div>
                          {renderFieldError('savings_account_ids')}
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
                  ref={bindField('current_amount')}
                  data-field="current_amount"
                  {...fieldProps('current_amount')}
                />
                {renderFieldError('current_amount')}
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
                        ref={bindField('target_amount')}
                        data-field="target_amount"
                        {...fieldProps('target_amount')}
                      />
                      {renderFieldError('target_amount')}
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
                  ref={bindField('monthly_target')}
                  data-field="monthly_target"
                  {...fieldProps('monthly_target')}
                />
                {renderFieldError('monthly_target')}
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
                  ref={bindField('target_date')}
                  data-field="target_date"
                  {...fieldProps('target_date')}
                />
                {renderFieldError('target_date')}
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

              {formError && (
                <p className="text-sm text-danger" role="alert" data-testid="allocation-form-error">
                  {formError}
                </p>
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
              </div>
            </form>
          </div>
          </div>
        </div>
      )}

      {reviewFor && (
        <InstallmentReviewDialog
          key={reviewFor.entryId}
          entryId={reviewFor.entryId}
          name={reviewFor.name}
          onClose={() => setReviewFor(null)}
          onReviewed={() => void loadBudgetEntriesRef.current()}
        />
      )}

      {markPaidFor && (
        <MarkPaidDialog
          entryId={markPaidFor.entry.id}
          name={markPaidFor.entry.name}
          occurrenceDate={markPaidFor.entry.next_occurrence.slice(0, 10)}
          entry={markPaidFor.entry}
          action={markPaidFor.action}
          onClose={() => setMarkPaidFor(null)}
          onPaid={() => void loadBudgetEntriesRef.current()}
        />
      )}

      {recurringModal && (
        <RecurringEntryFormModal
          key={recurringModal.entry?.id ?? 'new'}
          entry={recurringModal.entry}
          accounts={accounts}
          categories={categories}
          budgetEnvelopes={budgetEnvelopes}
          onClose={() => setRecurringModal(null)}
          onSaved={handleBudgetEntrySaved}
          onStale={() => void loadBudgetEntriesRef.current()}
          onDeleted={handleBudgetEntryDeleted}
        />
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

