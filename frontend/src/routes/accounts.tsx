import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useGetAccountsQuery, useLazyGetAccountsQuery, useCreateAccountMutation, useUpdateAccountMutation, useDeleteAccountMutation } from '../store/api'
import { useState, useEffect, useMemo, useRef, useCallback } from 'react'
import { Account } from '../store/api'
import { useLatestRef, useRequestGeneration } from '../hooks/useRequestGeneration'
import { useAuth } from '../contexts/AuthContext'
import { formatCurrency, getCurrencySymbol, CurrencyCode, CURRENCY_CONFIGS } from '../utils/currency'
import { LoanActions, LoanSummary } from '../components/LoanPanel'
import { TagChips } from '../components/TagChips'
import { TagFilter } from '../components/TagFilter'
import { TagPicker } from '../components/TagPicker'
import { tagIdsIfChanged, tagIdsOf } from '../utils/tags'

export const Route = createFileRoute('/accounts')({
  component: AccountsPage,
})

/** Marks a spending wallet: its balance is shown but not counted in available cash. */
function NotCountedTag() {
  return (
    <span
      className="inline-flex items-center gap-1 rounded-full border border-line px-2 py-1 text-xs text-muted"
      title="Spending wallet: shown, but not counted in available cash or projections"
    >
      Not counted
    </span>
  )
}

type LoanKind = NonNullable<Account['loan_kind']>
type LoanAmortization = NonNullable<Account['loan_amortization']>

/** Home loans shorten their term on extra principal; the others follow the bank's schedule. */
const defaultAmortization = (kind: LoanKind): LoanAmortization => (kind === 'home' ? 'reduce_term' : 'fixed')

/** Today as YYYY-MM-DD in local time, to compare with a date input's value. */
const todayInput = (): string => {
  const now = new Date()
  const month = String(now.getMonth() + 1).padStart(2, '0')
  const day = String(now.getDate()).padStart(2, '0')
  return `${now.getFullYear()}-${month}-${day}`
}

const blankForm = (currency: CurrencyCode) => ({
  name: '',
  account_type: 'checking' as Account['account_type'],
  balance: 0,
  description: '',
  credit_limit: undefined as number | undefined,
  due_date: undefined as number | undefined,
  billing_cycle_start: undefined as number | undefined,
  currency,
  days_until_due_date: 21,
  payment_account_id: undefined as number | undefined,
  payment_overflow_account_id: undefined as number | undefined,
  is_spending_wallet: false,
  loan_kind: undefined as LoanKind | undefined,
  loan_annual_rate: undefined as number | undefined,
  loan_term_months: undefined as number | undefined,
  loan_payment_amount: undefined as number | undefined,
  loan_first_payment_date: undefined as string | undefined,
  loan_amortization: undefined as LoanAmortization | undefined,
  loan_payments_made_offset: undefined as number | undefined,
  is_active: true,
  // The tags picked in the form; an edit sends them only when they changed.
  tag_ids: [] as number[],
})

const LOAN_FIELDS = [
  'loan_kind',
  'loan_annual_rate',
  'loan_term_months',
  'loan_payment_amount',
  'loan_first_payment_date',
  'loan_amortization',
  'loan_payments_made_offset',
] as const

export function AccountsPage() {
  const { user, isAuthenticated, isLoading: authLoading } = useAuth()
  const navigate = useNavigate()
  const defaultCurrency = (user?.default_currency as CurrencyCode) || 'PHP'
  const currencyOptions = useMemo(() => Object.keys(CURRENCY_CONFIGS) as CurrencyCode[], [])

  const [isCreateModalOpen, setIsCreateModalOpen] = useState(false)
  const [editingAccount, setEditingAccount] = useState<Account | null>(null)
  const [isActionModalOpen, setIsActionModalOpen] = useState(false)
  const [actionAccount, setActionAccount] = useState<Account | null>(null)
  const [formData, setFormData] = useState(() => blankForm(defaultCurrency))
  // Once the amortization is picked by hand, changing the loan kind no longer resets it.
  const [amortizationTouched, setAmortizationTouched] = useState(false)
  const [showCreditSettings, setShowCreditSettings] = useState(false)

  const [triggerAccounts] = useLazyGetAccountsQuery()
  const beginAccountsRequest = useRequestGeneration()
  const [createAccount] = useCreateAccountMutation()
  const [updateAccount] = useUpdateAccountMutation()
  const [deleteAccount] = useDeleteAccountMutation()
  const formCurrencySymbol = getCurrencySymbol(formData.currency as CurrencyCode)
  const limit = 10
  const [accounts, setAccounts] = useState<Account[]>([])
  const [totalAccounts, setTotalAccounts] = useState(0)
  const [hasMoreAccounts, setHasMoreAccounts] = useState(true)
  const offsetRef = useRef(0)
  const loadMoreObserver = useRef<IntersectionObserver | null>(null)
  const [isInitialLoading, setIsInitialLoading] = useState(true)
  const [isFetchingMore, setIsFetchingMore] = useState(false)
  const [selectedTag, setSelectedTag] = useState<number | undefined>(undefined)
  // The list above is narrowed by the tag filter, but payment routing can pick any account.
  const { data: allAccountsData } = useGetAccountsQuery(
    { limit: 100 },
    { skip: !isAuthenticated || selectedTag === undefined },
  )
  const routingAccounts = selectedTag === undefined ? accounts : allAccountsData?.items ?? accounts

  // Only non-credit, non-loan, non-wallet accounts can fund a statement or a loan payment
  // (a card or loan holds no cash), and an account can't pay itself. Mirrors the backend
  // validation in routers/accounts.py::_validate_payment_routing.
  const fundingAccounts = routingAccounts.filter(
    (a) =>
      a.account_type !== 'credit' &&
      a.account_type !== 'loan' &&
      !a.is_spending_wallet &&
      a.is_active &&
      a.id !== editingAccount?.id,
  )

  // Spell out the cycle the backend will derive, so "closes 24th, +21 days" doesn't
  // have to be worked out in your head.
  const statementSummary = (() => {
    const close = formData.billing_cycle_start
    const days = formData.days_until_due_date
    if (!close || !days) return null
    const due = new Date(Date.UTC(2026, 0, close))
    due.setUTCDate(due.getUTCDate() + days)
    const ordinal = (n: number) => {
      const suffix =
        n % 10 === 1 && n !== 11 ? 'st' : n % 10 === 2 && n !== 12 ? 'nd' : n % 10 === 3 && n !== 13 ? 'rd' : 'th'
      return `${n}${suffix}`
    }
    return `Closes the ${ordinal(close)}, due around the ${ordinal(due.getUTCDate())} of the following month.`
  })()

  const loadAccounts = useCallback(
    async (reset = false) => {
      if (!isAuthenticated) {
        return
      }

      const nextOffset = reset ? 0 : offsetRef.current
      const params = {
        limit,
        offset: nextOffset,
        ...(selectedTag !== undefined ? { tag: selectedTag } : {}),
      }

      const isCurrent = beginAccountsRequest(reset)
      try {
        if (reset) {
          offsetRef.current = 0
          setIsInitialLoading(true)
          setIsFetchingMore(false)
          setAccounts([])
        } else {
          setIsFetchingMore(true)
        }

        const result = await triggerAccounts(params).unwrap()
        if (!isCurrent()) return
        offsetRef.current = nextOffset + result.items.length
        setAccounts((prev) => (reset ? result.items : [...prev, ...result.items]))
        setTotalAccounts(result.total)
        setHasMoreAccounts(result.has_more)
      } catch (error) {
        if (!isCurrent()) return
        console.error('Error loading accounts:', error)
        if (reset) {
          setAccounts([])
          setTotalAccounts(0)
          setHasMoreAccounts(false)
        }
      } finally {
        if (isCurrent()) {
          if (reset) {
            setIsInitialLoading(false)
          } else {
            setIsFetchingMore(false)
          }
        }
      }
    },
    [triggerAccounts, beginAccountsRequest, isAuthenticated, selectedTag]
  )
  const loadAccountsRef = useLatestRef(loadAccounts)

  useEffect(() => {
    if (authLoading || !isAuthenticated) {
      return
    }
    loadAccounts(true)
  }, [authLoading, isAuthenticated, loadAccounts])

  useEffect(() => {
    if (!authLoading && !isAuthenticated) {
      navigate({ to: '/login', search: { message: undefined } })
    }
  }, [authLoading, isAuthenticated, navigate])

  useEffect(() => {
    return () => {
      loadMoreObserver.current?.disconnect()
    }
  }, [])

  useEffect(() => {
    if (!editingAccount) {
      setFormData((prev) => ({
        ...prev,
        currency: defaultCurrency,
      }))
    }
  }, [defaultCurrency, editingAccount])

  const sentinelRef = useCallback(
    (node: HTMLDivElement | null) => {
      if (loadMoreObserver.current) {
        loadMoreObserver.current.disconnect()
      }
      if (!node) {
        return
      }

      loadMoreObserver.current = new IntersectionObserver((entries) => {
        if (entries[0]?.isIntersecting && hasMoreAccounts && !isFetchingMore && !isInitialLoading) {
          loadAccounts(false)
        }
      })

      loadMoreObserver.current.observe(node)
    },
    [hasMoreAccounts, isFetchingMore, isInitialLoading, loadAccounts]
  )

  useEffect(() => {
    if (!editingAccount) {
      setFormData((prev) => ({
        ...prev,
        currency: defaultCurrency,
      }))
    }
  }, [defaultCurrency, editingAccount])

  const orderedAccounts = useMemo(() => {
    return [...accounts].sort((a, b) => {
      if (a.is_active === b.is_active) {
        return a.name.localeCompare(b.name)
      }
      return Number(b.is_active) - Number(a.is_active)
    })
  }, [accounts])

  if (isInitialLoading) {
    return (
        <div className="flex items-center justify-center min-h-96">
        <div className="text-center">
          <div className="loading-spinner mx-auto mb-4"></div>
          <p className="text-body font-medium">Loading accounts...</p>
        </div>
      </div>
    )
  }

  if (!isAuthenticated) {
    return null // Will redirect
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    try {
      const isLoan = formData.account_type === 'loan'
      // Loan terms are accepted on loans only: drop them from every other type.
      const { tag_ids: selectedTagIds, ...payload } = formData
      if (!isLoan) {
        for (const field of LOAN_FIELDS) delete payload[field]
      }
      if (editingAccount) {
        // A cleared selector is undefined, which JSON drops; send null so "None" saves.
        await updateAccount({
          id: editingAccount.id,
          data: {
            ...payload,
            ...tagIdsIfChanged(selectedTagIds, tagIdsOf(editingAccount.tags)),
            payment_account_id: formData.payment_account_id ?? null,
            payment_overflow_account_id: isLoan ? null : formData.payment_overflow_account_id ?? null,
            ...(isLoan
              ? {
                  loan_annual_rate: formData.loan_annual_rate ?? null,
                  loan_term_months: formData.loan_term_months ?? null,
                  loan_payment_amount: formData.loan_payment_amount ?? null,
                  loan_first_payment_date: formData.loan_first_payment_date || null,
                  loan_payments_made_offset: formData.loan_payments_made_offset ?? null,
                }
              : {}),
          },
        }).unwrap()
        setEditingAccount(null)
      } else {
        await createAccount({ ...payload, tag_ids: selectedTagIds }).unwrap()
      }
      setFormData(blankForm(defaultCurrency))
      setAmortizationTouched(false)
      setIsCreateModalOpen(false)
      await loadAccountsRef.current(true)
    } catch (error) {
      console.error('Error saving account:', error)
    }
  }

  const handleEdit = (account: Account) => {
    setEditingAccount(account)
    setFormData({
      name: account.name,
      account_type: account.account_type,
      balance: account.balance,
      description: account.description || '',
      credit_limit: account.credit_limit,
      due_date: account.due_date,
      billing_cycle_start: account.billing_cycle_start,
      currency: (account.currency as CurrencyCode) || defaultCurrency,
      days_until_due_date: account.days_until_due_date ?? 21,
      payment_account_id: account.payment_account_id ?? undefined,
      payment_overflow_account_id: account.payment_overflow_account_id ?? undefined,
      is_spending_wallet: account.is_spending_wallet,
      loan_kind: account.loan_kind ?? undefined,
      loan_annual_rate: account.loan_annual_rate ?? undefined,
      loan_term_months: account.loan_term_months ?? undefined,
      loan_payment_amount: account.loan_payment_amount ?? undefined,
      loan_first_payment_date: account.loan_first_payment_date ?? undefined,
      loan_amortization: account.loan_amortization ?? undefined,
      loan_payments_made_offset: account.loan_payments_made_offset ?? undefined,
      is_active: account.is_active,
      tag_ids: tagIdsOf(account.tags),
    })
    setAmortizationTouched(true)
    setShowCreditSettings(false)
    setIsCreateModalOpen(true)
  }

  const handleDelete = async (accountId: number) => {
    if (confirm('Are you sure you want to delete this account?')) {
      try {
        await deleteAccount(accountId).unwrap()
        if (actionAccount?.id === accountId) {
          closeActionModal()
        }
        await loadAccountsRef.current(true)
      } catch (error) {
        console.error('Error deleting account:', error)
      }
    }
  }

  const openActionModal = (account: Account) => {
    setActionAccount(account)
    setIsActionModalOpen(true)
  }

  const closeActionModal = () => {
    setIsActionModalOpen(false)
    setActionAccount(null)
  }

  const handleToggleActive = async (account: Account) => {
    try {
      const nextIsActive = !account.is_active
      await updateAccount({ id: account.id, data: { is_active: nextIsActive } }).unwrap()
      const updatedAccount: Account = { ...account, is_active: nextIsActive }
      setAccounts((prev) => prev.map((item) => (item.id === account.id ? updatedAccount : item)))
      if (actionAccount?.id === account.id) {
        setActionAccount(updatedAccount)
      }
    } catch (error) {
      console.error('Error updating account status:', error)
    }
  }

  const openEditFromModal = (account: Account) => {
    closeActionModal()
    handleEdit(account)
  }

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

  return (
    <div className="max-w-7xl mx-auto px-3 py-6 sm:px-4 lg:px-6 space-y-6">
      <div className="flex flex-col sm:flex-row sm:justify-between sm:items-center gap-4">
        <h1 className="text-2xl font-bold text-ink">Accounts</h1>
        <button
          onClick={() => setIsCreateModalOpen(true)}
          className="btn-primary focus-ring w-full sm:w-auto justify-center"
        >
          Add Account
        </button>
      </div>

      <TagFilter value={selectedTag} onChange={setSelectedTag} />

      {/* Accounts List */}
      {orderedAccounts.length === 0 ? (
        <div className="card p-6 text-center text-muted">
          {selectedTag === undefined
            ? 'No accounts yet. Start by adding your first account.'
            : 'No accounts have this tag.'}
        </div>
      ) : (
        <>
          <div className="overflow-x-auto">
          <div className="hidden md:grid grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)_160px] items-center gap-3 px-4 text-xs font-semibold uppercase tracking-wide text-muted mb-2">
            <span>Account</span>
            <span className="text-right">Balance</span>
            <span className="text-right">Status</span>
          </div>
          <div className="grid grid-cols-1 gap-3">
            {orderedAccounts.map((account) => (
              <article
                key={account.id}
                className={`card p-4 sm:p-5 transition-colors duration-200 hover:bg-sunken cursor-pointer ${account.is_active ? '' : 'opacity-60'}`}
                onClick={() => openActionModal(account)}
                role="button"
                tabIndex={0}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault()
                    openActionModal(account)
                  }
                }}
              >
                <div className="flex flex-col gap-4 md:grid md:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)_160px] md:items-center md:gap-4">
                  <div className="space-y-3">
                    <div className="flex items-start justify-between gap-3 md:block">
                      <div>
                        <p className="text-base font-semibold text-ink">{account.name}</p>
                        <p className="text-sm text-muted capitalize">{account.account_type.replace('_', ' ')}</p>
                        {account.description && (
                          <p className="text-sm text-body mt-1">{account.description}</p>
                        )}
                      </div>
                      <span
                        className={`inline-flex items-center gap-1 rounded-full px-2 py-1 text-xs font-medium ${ account.is_active ? 'text-ink' : 'bg-sunken text-body' } md:hidden`}
                      >
                        {account.is_active ? 'Active' : 'Inactive'}
                      </span>
                    </div>

                    {account.account_type === 'loan' && <LoanSummary account={account} />}

                    <div className="flex flex-wrap gap-2 text-xs text-body">
                      <span className="inline-flex items-center gap-1 rounded-full bg-sunken px-2 py-1">
                        Currency: {account.currency}
                      </span>
                      {account.is_spending_wallet && <NotCountedTag />}
                      <TagChips tags={account.tags} />
                      {account.account_type === 'credit' && account.credit_limit !== undefined && (
                        <span className="inline-flex items-center gap-1 rounded-full px-2 py-1 text-ink">
                          Limit {formatCurrency(account.credit_limit, account.currency as CurrencyCode)}
                        </span>
                      )}
                      {account.account_type === 'credit' && account.days_until_due_date && (
                        <span className="inline-flex items-center gap-1 px-2 py-1 text-ink">
                          +{account.days_until_due_date} days to due
                        </span>
                      )}
                    </div>
                  </div>

                  <div className="text-right space-y-2">
                    <p className={`text-lg font-bold ${account.balance >= 0 ? 'text-ok' : 'text-danger'}`}>
                      {formatCurrency(account.balance, account.currency as CurrencyCode)}
                    </p>
                    {account.account_type === 'credit' && account.due_date && (
                      <p className="text-xs text-muted">Statement due every {account.due_date}th</p>
                    )}
                  </div>

                  <div className="flex flex-wrap justify-end gap-2">
                    <span className={`hidden md:inline-flex items-center gap-1 rounded-full px-2 py-1 text-xs font-medium ${account.is_active ? 'text-ink' : 'bg-sunken text-body'}`}>
                      {account.is_active ? 'Active' : 'Inactive'}
                    </span>
                  </div>
                </div>
              </article>
            ))}
            <div ref={sentinelRef} className="h-3" />
            {!isInitialLoading && (isFetchingMore || hasMoreAccounts) && (
              <p className="text-center text-xs text-muted pb-2">
                {isFetchingMore ? 'Loading more accounts...' : 'Scroll for more accounts'}
              </p>
            )}
            {!isInitialLoading && !hasMoreAccounts && orderedAccounts.length === totalAccounts && totalAccounts > 0 && (
              <p className="text-center text-xs text-muted pb-2">End of list</p>
            )}
          </div>
          </div>{/* end overflow-x-auto */}
          <div className="flex justify-end px-4">
            <p className="text-xs text-muted">
              Showing {orderedAccounts.length} of {totalAccounts} accounts
            </p>
          </div>
        </>
      )}

      {isActionModalOpen && actionAccount && (
        <div
          className="fixed inset-0 z-50 overflow-y-auto bg-black/60 px-4 py-6"
          onClick={closeActionModal}
        >
          <div className="min-h-full flex items-center justify-center">
          <div
            className="w-full max-w-2xl bg-surface p-6 border border-line"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="flex items-start justify-between gap-4">
              <div>
                <h2 className="text-xl font-semibold text-ink">{actionAccount.name}</h2>
                <p className="text-sm text-muted capitalize">{actionAccount.account_type.replace('_', ' ')}</p>
                {actionAccount.is_spending_wallet && (
                  <div className="mt-2">
                    <NotCountedTag />
                  </div>
                )}
              </div>
                <button
                onClick={closeActionModal}
                className="text-muted hover:text-body transition-colors duration-200"
                aria-label="Close account actions modal"
              >
                <svg className="h-6 w-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>

            <div className="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div className="border border-line bg-surface/50 p-4">
                <h3 className="text-sm font-semibold text-body">Balance</h3>
                <p className={`mt-2 text-lg font-bold ${actionAccount.balance >= 0 ? 'text-ok' : 'text-danger'}`}>
                  {formatCurrency(actionAccount.balance, actionAccount.currency as CurrencyCode)}
                </p>
                <p className="mt-2 text-sm text-muted">Currency: {actionAccount.currency}</p>
                {actionAccount.account_type === 'credit' && actionAccount.credit_limit !== undefined && (
                  <p className="mt-1 text-sm text-muted">
                    Credit limit {formatCurrency(actionAccount.credit_limit, actionAccount.currency as CurrencyCode)}
                  </p>
                )}
              </div>

              <div className="border border-line bg-surface/50 p-4">
                <h3 className="text-sm font-semibold text-body">Status</h3>
                <p className={`mt-2 inline-flex items-center gap-2 rounded-full px-3 py-1 text-sm font-medium ${actionAccount.is_active ? 'text-ink' : 'bg-sunken text-body'}`}>
                  {actionAccount.is_active ? 'Active' : 'Inactive'}
                </p>
                {actionAccount.account_type === 'credit' && actionAccount.due_date && (
                  <p className="mt-2 text-sm text-muted">Statement closes every {actionAccount.due_date}th</p>
                )}
                {actionAccount.account_type === 'credit' && actionAccount.days_until_due_date && (
                  <p className="text-sm text-muted">Due {actionAccount.days_until_due_date} days after statement</p>
                )}
              </div>
            </div>

            {actionAccount.account_type === 'loan' && (
              <div className="mt-6 space-y-4">
                <LoanSummary account={actionAccount} />
                <LoanActions
                  key={actionAccount.id}
                  account={actionAccount}
                  fundingAccounts={routingAccounts.filter(
                    (a) => a.account_type !== 'credit' && a.account_type !== 'loan' && !a.is_spending_wallet && a.is_active,
                  )}
                  onRecorded={() => {
                    closeActionModal()
                    void loadAccountsRef.current(true)
                  }}
                />
              </div>
            )}

            <div className="mt-6 grid grid-cols-1 gap-3 sm:grid-cols-2">
              <button
                onClick={() => handleToggleActive(actionAccount)}
                className={`flex items-center justify-between gap-3 px-4 py-3 text-sm font-semibold transition-colors duration-200 ${ actionAccount.is_active ? 'text-ink hover:bg-sunken' : 'bg-sunken text-body hover:bg-sunken' }`}
              >
                <span>{actionAccount.is_active ? 'Mark as inactive' : 'Activate account'}</span>
                <span
                  className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors duration-200 ${ actionAccount.is_active ? 'bg-ink' : 'bg-sunken' }`}
                >
                  <span
                    className={`inline-block h-4 w-4 transform rounded-full bg-surface transition-transform duration-200 ${ actionAccount.is_active ? 'translate-x-5' : 'translate-x-1' }`}
                  />
                </span>
              </button>
              <button
                onClick={() => openEditFromModal(actionAccount)}
                className="flex items-center justify-center gap-2 bg-ink px-4 py-3 text-sm font-semibold text-paper transition-colors duration-200 hover:bg-ink"
              >
                <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
                </svg>
                Edit account
              </button>
              <button
                onClick={() => handleDelete(actionAccount.id)}
                className="flex items-center justify-center gap-2 bg-sunken px-4 py-3 text-sm font-semibold text-body transition-colors duration-200 hover:bg-sunken sm:col-span-2"
              >
                <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                </svg>
                Delete account
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
          <div className="bg-surface p-6 w-full max-w-md border border-line">
            <div className="flex items-center justify-between mb-6">
              <h2 className="text-xl font-semibold text-ink">
                {editingAccount ? 'Edit Account' : 'Create Account'}
              </h2>
              <button
                onClick={() => {
                  setIsCreateModalOpen(false)
                  setEditingAccount(null)
                  setFormData(blankForm(defaultCurrency))
                  setAmortizationTouched(false)
                  setShowCreditSettings(false)
                }}
                className="text-muted hover:text-body transition-colors duration-200 w-full sm:w-auto"
              >
                <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
            
            <form onSubmit={handleSubmit} className="space-y-5">
              <div>
                <label className="label">Account Name</label>
                <input
                  type="text"
                  value={formData.name}
                  onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                  className="input-field focus-ring"
                  placeholder="Enter account name"
                  required
                />
              </div>
              
              <div>
                <label className="label">Account Type</label>
                <select
                  value={formData.account_type}
                  onChange={(e) => {
                    const nextType = e.target.value as Account['account_type']
                    // New cash / e-wallet accounts start as spending wallets; a card never is one.
                    const isSpendingWallet =
                      nextType === 'credit' || nextType === 'loan'
                        ? false
                        : editingAccount
                        ? formData.is_spending_wallet
                        : nextType === 'cash' || nextType === 'e_wallet'
                    const loanKind = nextType === 'loan' ? formData.loan_kind ?? 'personal' : formData.loan_kind
                    setFormData({
                      ...formData,
                      account_type: nextType,
                      is_spending_wallet: isSpendingWallet,
                      loan_kind: loanKind,
                      loan_amortization:
                        nextType === 'loan'
                          ? formData.loan_amortization ?? defaultAmortization(loanKind ?? 'personal')
                          : formData.loan_amortization,
                    })
                    setShowCreditSettings(false)
                  }}
                  className="select-field focus-ring"
                  disabled={editingAccount?.account_type === 'loan'}
                >
                  <option value="checking">🏦 Checking</option>
                  <option value="savings">💰 Savings</option>
                  <option value="credit">💳 Credit Card</option>
                  <option value="cash">💵 Cash</option>
                  <option value="e_wallet">📱 E-Wallet</option>
                  <option value="loan">🏠 Loan</option>
                </select>
                {editingAccount?.account_type === 'loan' && (
                  <p className="mt-1 text-xs text-muted">A loan account keeps its type.</p>
                )}
              </div>
              
              {formData.account_type !== 'credit' && formData.account_type !== 'loan' && (
                <div>
                  <label className="inline-flex items-center gap-2 text-sm text-body cursor-pointer">
                    <input
                      type="checkbox"
                      className="border-line text-ink"
                      checked={formData.is_spending_wallet}
                      onChange={(e) => setFormData({ ...formData, is_spending_wallet: e.target.checked })}
                    />
                    <span>Spending wallet</span>
                  </label>
                  <p className="mt-1 text-xs text-muted">
                    Cash on hand or an e-wallet: its balance is shown but not counted in available cash or
                    projections. Topping it up counts as the expense.
                  </p>
                </div>
              )}

              <div>
                <label className="label">Account Currency</label>
                <select
                  value={formData.currency}
                  onChange={(e) => {
                    const currency = e.target.value as CurrencyCode
                    const payer = routingAccounts.find((a) => a.id === formData.payment_account_id)
                    // A loan's paying account must be in the loan's currency.
                    const clearPayer = formData.account_type === 'loan' && !!payer && payer.currency !== currency
                    setFormData({
                      ...formData,
                      currency,
                      payment_account_id: clearPayer ? undefined : formData.payment_account_id,
                    })
                  }}
                  className="select-field focus-ring"
                >
                  {currencyOptions.map((currency) => (
                    <option key={currency} value={currency}>
                      {currency} ({getCurrencySymbol(currency)})
                    </option>
                  ))}
                </select>
              </div>
              
              <div>
                <label className="label">Initial Balance</label>
                <div className="relative">
                  <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
                    <span className="text-muted sm:text-sm">{formCurrencySymbol}</span>
                  </div>
                  <input
                    type="number"
                    step="0.01"
                    value={formData.balance}
                    onChange={(e) => setFormData({ ...formData, balance: parseFloat(e.target.value) || 0 })}
                    className="input-field pl-7 focus-ring"
                    placeholder="0.00"
                    required
                  />
                </div>
                {formData.account_type === 'loan' && (
                  <p className="mt-1 text-xs text-muted">
                    A loan's balance is negative while money is owed (for example -90000).
                  </p>
                )}
              </div>
              
              <TagPicker
                value={formData.tag_ids}
                onChange={(tag_ids) => setFormData((prev) => ({ ...prev, tag_ids }))}
                warnHousehold
              />

              <div>
                <label className="label">Description (Optional)</label>
                <textarea
                  value={formData.description}
                  onChange={(e) => setFormData({ ...formData, description: e.target.value })}
                  className="input-field focus-ring resize-none"
                  rows={3}
                  placeholder="Add a description for this account"
                />
              </div>
              
              {formData.account_type === 'credit' && (
                <div className="space-y-3 p-4 border border-line">
                  <div className="flex items-center justify-between">
                    <h3 className="text-sm font-medium text-ink">Credit Card Settings</h3>
                    <button
                      type="button"
                      onClick={() => setShowCreditSettings((prev) => !prev)}
                      className="inline-flex items-center gap-1 text-xs font-semibold text-ink hover:text-ink"
                    >
                      <svg
                        className={`h-4 w-4 transition-transform duration-200 ${showCreditSettings ? 'rotate-180' : ''}`}
                        fill="none"
                        stroke="currentColor"
                        viewBox="0 0 24 24"
                      >
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                      </svg>
                      {showCreditSettings ? 'Hide details' : 'Show details'}
                    </button>
                  </div>

                  {showCreditSettings && (
                    <div className="space-y-4">
                      <div>
                        <label className="label">Credit Limit</label>
                        <div className="relative">
                          <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
                            <span className="text-muted sm:text-sm">{formCurrencySymbol}</span>
                          </div>
                          <input
                            type="number"
                            step="0.01"
                            value={formData.credit_limit || ''}
                            onChange={(e) => setFormData({ ...formData, credit_limit: parseFloat(e.target.value) || undefined })}
                            className="input-field pl-7 focus-ring"
                            placeholder="0.00"
                          />
                        </div>
                      </div>

                      <div>
                        <label className="label">Due Date (Day of Month)</label>
                        <select
                          value={formData.due_date || ''}
                          onChange={(e) => setFormData({ ...formData, due_date: parseInt(e.target.value) || undefined })}
                          className="select-field focus-ring"
                        >
                          <option value="">Select day</option>
                          {Array.from({ length: 31 }, (_, i) => (
                            <option key={i + 1} value={i + 1}>{i + 1}</option>
                          ))}
                        </select>
                      </div>

                      <div>
                        <label className="label">Statement Closes (Day of Month)</label>
                        <select
                          value={formData.billing_cycle_start || ''}
                          onChange={(e) => setFormData({ ...formData, billing_cycle_start: parseInt(e.target.value) || undefined })}
                          className="select-field focus-ring"
                        >
                          <option value="">Select day</option>
                          {Array.from({ length: 31 }, (_, i) => (
                            <option key={i + 1} value={i + 1}>{i + 1}</option>
                          ))}
                        </select>
                        <p className="mt-1 text-xs text-muted">
                          Charges up to this day form that month's statement.
                        </p>
                      </div>

                      <div>
                        <label className="label">Days Until Due Date</label>
                        <input
                          type="number"
                          min={1}
                          max={90}
                          value={formData.days_until_due_date}
                          onChange={(e) => {
                            const value = parseInt(e.target.value, 10)
                            setFormData({
                              ...formData,
                              days_until_due_date: Number.isNaN(value) ? 21 : value,
                            })
                          }}
                          className="input-field focus-ring"
                          placeholder="21"
                        />
                        <p className="mt-1 text-xs text-muted">
                          {statementSummary ?? 'Default is 21 days after the statement date.'}
                        </p>
                      </div>

                      <div className="pt-2 border-t border-line">
                        <p className="text-sm font-medium text-body">Statement payment</p>
                        <p className="mt-1 text-xs text-muted">
                          Where the forecast expects this card's statement to be paid from.
                        </p>
                      </div>

                      <div>
                        <label className="label">Paid From</label>
                        <select
                          value={formData.payment_account_id ?? ''}
                          onChange={(e) => setFormData({ ...formData, payment_account_id: parseInt(e.target.value) || undefined })}
                          className="select-field focus-ring"
                        >
                          <option value="">Not set</option>
                          {fundingAccounts.map((a) => (
                            <option key={a.id} value={a.id}>{a.name}</option>
                          ))}
                        </select>
                      </div>

                      <div>
                        <label className="label">Overflow To</label>
                        <select
                          value={formData.payment_overflow_account_id ?? ''}
                          onChange={(e) => setFormData({ ...formData, payment_overflow_account_id: parseInt(e.target.value) || undefined })}
                          className="select-field focus-ring"
                          disabled={!formData.payment_account_id}
                        >
                          <option value="">Not set</option>
                          {fundingAccounts
                            .filter((a) => a.id !== formData.payment_account_id)
                            .map((a) => (
                              <option key={a.id} value={a.id}>{a.name}</option>
                            ))}
                        </select>
                        <p className="mt-1 text-xs text-muted">
                          Used when "Paid From" can't cover the statement on its own.
                        </p>
                      </div>
                    </div>
                  )}
                </div>
              )}

              {formData.account_type === 'loan' && (
                <fieldset className="space-y-4 p-4 border border-line">
                  <legend className="px-1 text-sm font-medium text-ink">Loan terms</legend>

                  <div>
                    <label className="label">Kind</label>
                    <select
                      value={formData.loan_kind ?? 'personal'}
                      onChange={(e) => {
                        const kind = e.target.value as LoanKind
                        setFormData({
                          ...formData,
                          loan_kind: kind,
                          loan_amortization: amortizationTouched
                            ? formData.loan_amortization
                            : defaultAmortization(kind),
                        })
                      }}
                      className="select-field focus-ring"
                    >
                      <option value="personal">Personal</option>
                      <option value="auto">Auto</option>
                      <option value="home">Home</option>
                    </select>
                  </div>

                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="label">Annual rate (%)</label>
                      <input
                        type="number"
                        step="0.0001"
                        min={0}
                        max={100}
                        value={formData.loan_annual_rate ?? ''}
                        onChange={(e) => setFormData({ ...formData, loan_annual_rate: e.target.value === '' ? undefined : parseFloat(e.target.value) })}
                        className="input-field focus-ring"
                        placeholder="6.5"
                      />
                    </div>
                    <div>
                      <label className="label">Term (months)</label>
                      <input
                        type="number"
                        min={1}
                        max={600}
                        value={formData.loan_term_months ?? ''}
                        onChange={(e) => setFormData({ ...formData, loan_term_months: parseInt(e.target.value) || undefined })}
                        className="input-field focus-ring"
                        placeholder="60"
                      />
                    </div>
                  </div>

                  <div>
                    <label className="label">Payment amount</label>
                    <div className="relative">
                      <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
                        <span className="text-muted sm:text-sm">{formCurrencySymbol}</span>
                      </div>
                      <input
                        type="number"
                        step="0.01"
                        min={0}
                        value={formData.loan_payment_amount ?? ''}
                        onChange={(e) => setFormData({ ...formData, loan_payment_amount: parseFloat(e.target.value) || undefined })}
                        className="input-field pl-7 focus-ring"
                        placeholder="0.00"
                      />
                    </div>
                  </div>

                  <div>
                    <label className="label">First payment date</label>
                    <input
                      type="date"
                      value={formData.loan_first_payment_date ?? ''}
                      onChange={(e) => setFormData({ ...formData, loan_first_payment_date: e.target.value || undefined })}
                      className="input-field focus-ring"
                    />
                  </div>

                  <div>
                    <label className="label">Amortization</label>
                    <select
                      value={formData.loan_amortization ?? defaultAmortization(formData.loan_kind ?? 'personal')}
                      onChange={(e) => {
                        setAmortizationTouched(true)
                        setFormData({ ...formData, loan_amortization: e.target.value as LoanAmortization })
                      }}
                      className="select-field focus-ring"
                    >
                      <option value="fixed">Fixed (the bank's schedule)</option>
                      <option value="reduce_term">Reduce term (extra principal shortens the loan)</option>
                    </select>
                  </div>

                  <div>
                    <label className="label">Payments already made</label>
                    <input
                      type="number"
                      min={0}
                      value={formData.loan_payments_made_offset ?? ''}
                      onChange={(e) => setFormData({ ...formData, loan_payments_made_offset: e.target.value === '' ? undefined : parseInt(e.target.value) })}
                      className="input-field focus-ring"
                      placeholder="0"
                    />
                    <p className="mt-1 text-xs text-muted">
                      Scheduled payments made before this loan was tracked here. Payments recorded here are counted on top.
                    </p>
                    {formData.loan_payments_made_offset === undefined &&
                      !!formData.loan_first_payment_date &&
                      formData.loan_first_payment_date < todayInput() && (
                        <p className="mt-1 text-xs text-warn">
                          The first payment date is in the past: with no payments already made, every due date
                          from then until today will show as overdue.
                        </p>
                      )}
                  </div>

                  <div>
                    <label className="label">Paid From</label>
                    <select
                      value={formData.payment_account_id ?? ''}
                      onChange={(e) => setFormData({ ...formData, payment_account_id: parseInt(e.target.value) || undefined })}
                      className="select-field focus-ring"
                    >
                      <option value="">Not set</option>
                      {fundingAccounts
                        .filter((a) => a.currency === formData.currency)
                        .map((a) => (
                          <option key={a.id} value={a.id}>{a.name}</option>
                        ))}
                    </select>
                    <p className="mt-1 text-xs text-muted">
                      The account each payment is expected to leave in the forecast, in the loan's currency.
                      Without it (or a payment amount) the loan adds no payable.
                    </p>
                  </div>
                </fieldset>
              )}

              <div className="flex items-center justify-between border border-line bg-surface/50 px-4 py-3">
                <div>
                  <p className="text-sm font-medium text-body">Account status</p>
                  <p className="text-xs text-muted">Inactive accounts stay in history but are hidden from most views.</p>
                </div>
                <div className="flex items-center gap-3">
                  <span className="text-sm text-body">{formData.is_active ? 'Active' : 'Inactive'}</span>
                  <button
                    type="button"
                    onClick={() =>
                      setFormData((prev) => ({
                        ...prev,
                        is_active: !prev.is_active,
                      }))
                    }
                    className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors duration-200 ${ formData.is_active ? 'bg-ink' : 'bg-sunken' }`}
                  >
                    <span
                      className={`inline-block h-4 w-4 transform rounded-full bg-surface transition-transform duration-200 ${ formData.is_active ? 'translate-x-5' : 'translate-x-1' }`}
                    />
                  </button>
                </div>
              </div>
              
              <div className="flex space-x-3 pt-6 border-t border-line">
                <button
                  type="submit"
                  className="flex-1 btn-primary focus-ring w-full sm:w-auto py-3 px-4 text-base"
                >
                  {editingAccount ? 'Update Account' : 'Create Account'}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setIsCreateModalOpen(false)
                    setEditingAccount(null)
                    setFormData(blankForm(defaultCurrency))
                    setAmortizationTouched(false)
                  }}
                  className="flex-1 btn-secondary focus-ring w-full sm:w-auto py-3 px-4 text-base"
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
