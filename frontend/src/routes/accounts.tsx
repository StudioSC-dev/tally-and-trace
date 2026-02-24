import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useLazyGetAccountsQuery, useCreateAccountMutation, useUpdateAccountMutation, useDeleteAccountMutation } from '../store/api'
import { useState, useEffect, useMemo, useRef, useCallback } from 'react'
import { Account } from '../store/api'
import { useAuth } from '../contexts/AuthContext'
import { formatCurrency, getCurrencySymbol, CurrencyCode, CURRENCY_CONFIGS } from '../utils/currency'

export const Route = createFileRoute('/accounts')({
  component: AccountsPage,
})

export function AccountsPage() {
  const { user, isAuthenticated, isLoading: authLoading } = useAuth()
  const navigate = useNavigate()
  const defaultCurrency = (user?.default_currency as CurrencyCode) || 'PHP'
  const currencyOptions = useMemo(() => Object.keys(CURRENCY_CONFIGS) as CurrencyCode[], [])

  const [isCreateModalOpen, setIsCreateModalOpen] = useState(false)
  const [editingAccount, setEditingAccount] = useState<Account | null>(null)
  const [isActionModalOpen, setIsActionModalOpen] = useState(false)
  const [actionAccount, setActionAccount] = useState<Account | null>(null)
  const [formData, setFormData] = useState({
    name: '',
    account_type: 'checking' as Account['account_type'],
    balance: 0,
    description: '',
    credit_limit: undefined as number | undefined,
    due_date: undefined as number | undefined,
    billing_cycle_start: undefined as number | undefined,
    currency: defaultCurrency,
    days_until_due_date: 21,
    is_active: true,
  })
  const [showCreditSettings, setShowCreditSettings] = useState(false)

  const [triggerAccounts] = useLazyGetAccountsQuery()
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

  const loadAccounts = useCallback(
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
          setAccounts([])
        } else {
          setIsFetchingMore(true)
        }

        const result = await triggerAccounts(params).unwrap()
        offsetRef.current = nextOffset + result.items.length
        setAccounts((prev) => (reset ? result.items : [...prev, ...result.items]))
        setTotalAccounts(result.total)
        setHasMoreAccounts(result.has_more)
      } catch (error) {
        console.error('Error loading accounts:', error)
        if (reset) {
          setAccounts([])
          setTotalAccounts(0)
          setHasMoreAccounts(false)
        }
      } finally {
        if (reset) {
          setIsInitialLoading(false)
        } else {
          setIsFetchingMore(false)
        }
      }
    },
    [triggerAccounts, isAuthenticated]
  )

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
          <p className="text-gray-600 dark:text-slate-400 font-medium">Loading accounts...</p>
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
      if (editingAccount) {
        await updateAccount({ id: editingAccount.id, data: formData }).unwrap()
        setEditingAccount(null)
      } else {
        await createAccount(formData).unwrap()
      }
      setFormData({
        name: '',
        account_type: 'checking',
        balance: 0,
        description: '',
        credit_limit: undefined,
        due_date: undefined,
        billing_cycle_start: undefined,
        currency: defaultCurrency,
        days_until_due_date: 21,
        is_active: true,
      })
      setIsCreateModalOpen(false)
      await loadAccounts(true)
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
      is_active: account.is_active,
    })
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
        await loadAccounts(true)
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
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600"></div>
      </div>
    )
  }

  if (!isAuthenticated) {
    return null // Will redirect
  }

  return (
    <div className="max-w-6xl mx-auto px-4 py-6 sm:px-6 lg:px-8 space-y-6">
      <div className="flex flex-col sm:flex-row sm:justify-between sm:items-center gap-4">
        <h1 className="text-2xl font-bold text-gray-900 dark:text-white">Accounts</h1>
        <button
          onClick={() => setIsCreateModalOpen(true)}
          className="btn-primary focus-ring w-full sm:w-auto justify-center"
        >
          Add Account
        </button>
      </div>

      {/* Accounts List */}
      {orderedAccounts.length === 0 ? (
        <div className="card p-6 text-center text-gray-500">
          No accounts yet. Start by adding your first account.
        </div>
      ) : (
        <>
          <div className="overflow-x-auto">
          <div className="hidden md:grid grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)_160px] items-center gap-3 px-4 text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-slate-500 mb-2">
            <span>Account</span>
            <span className="text-right">Balance</span>
            <span className="text-right">Status</span>
          </div>
          <div className="grid grid-cols-1 gap-3">
            {orderedAccounts.map((account) => (
              <article
                key={account.id}
                className={`card p-4 sm:p-5 transition-shadow duration-200 hover:shadow-lg focus-within:ring-2 focus-within:ring-blue-500 cursor-pointer ${account.is_active ? '' : 'opacity-60'}`}
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
                        <p className="text-base font-semibold text-gray-900 dark:text-white">{account.name}</p>
                        <p className="text-sm text-gray-500 dark:text-slate-400 capitalize">{account.account_type.replace('_', ' ')}</p>
                        {account.description && (
                          <p className="text-sm text-gray-600 dark:text-slate-400 mt-1">{account.description}</p>
                        )}
                      </div>
                      <span
                        className={`inline-flex items-center gap-1 rounded-full px-2 py-1 text-xs font-medium ${
                          account.is_active ? 'bg-blue-100 dark:bg-blue-500/10 text-blue-700 dark:text-blue-400' : 'bg-gray-200 dark:bg-slate-700 text-gray-600 dark:text-slate-400'
                        } md:hidden`}
                      >
                        {account.is_active ? 'Active' : 'Inactive'}
                      </span>
                    </div>

                    <div className="flex flex-wrap gap-2 text-xs text-gray-600 dark:text-slate-400">
                      <span className="inline-flex items-center gap-1 rounded-full bg-gray-100 dark:bg-slate-800 px-2 py-1">
                        Currency: {account.currency}
                      </span>
                      {account.account_type === 'credit' && account.credit_limit !== undefined && (
                        <span className="inline-flex items-center gap-1 rounded-full bg-blue-100 dark:bg-blue-500/10 px-2 py-1 text-blue-700 dark:text-blue-400">
                          Limit {formatCurrency(account.credit_limit, account.currency as CurrencyCode)}
                        </span>
                      )}
                      {account.account_type === 'credit' && account.days_until_due_date && (
                        <span className="inline-flex items-center gap-1 rounded-full bg-indigo-100 dark:bg-indigo-500/10 px-2 py-1 text-indigo-700 dark:text-indigo-400">
                          +{account.days_until_due_date} days to due
                        </span>
                      )}
                    </div>
                  </div>

                  <div className="text-right space-y-2">
                    <p className={`text-lg font-bold ${account.balance >= 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-600 dark:text-red-400'}`}>
                      {formatCurrency(account.balance, account.currency as CurrencyCode)}
                    </p>
                    {account.account_type === 'credit' && account.due_date && (
                      <p className="text-xs text-gray-500 dark:text-slate-500">Statement due every {account.due_date}th</p>
                    )}
                  </div>

                  <div className="flex flex-wrap justify-end gap-2">
                    <span className={`hidden md:inline-flex items-center gap-1 rounded-full px-2 py-1 text-xs font-medium ${account.is_active ? 'bg-blue-100 dark:bg-blue-500/10 text-blue-700 dark:text-blue-400' : 'bg-gray-200 dark:bg-slate-700 text-gray-600 dark:text-slate-400'}`}>
                      {account.is_active ? 'Active' : 'Inactive'}
                    </span>
                  </div>
                </div>
              </article>
            ))}
            <div ref={sentinelRef} className="h-3" />
            {!isInitialLoading && (isFetchingMore || hasMoreAccounts) && (
              <p className="text-center text-xs text-gray-500 dark:text-slate-500 pb-2">
                {isFetchingMore ? 'Loading more accounts...' : 'Scroll for more accounts'}
              </p>
            )}
            {!isInitialLoading && !hasMoreAccounts && orderedAccounts.length === totalAccounts && totalAccounts > 0 && (
              <p className="text-center text-xs text-gray-400 dark:text-slate-600 pb-2">End of list</p>
            )}
          </div>
          </div>{/* end overflow-x-auto */}
          <div className="flex justify-end px-4">
            <p className="text-xs text-gray-500 dark:text-slate-500">
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
            className="w-full max-w-2xl rounded-xl bg-white dark:bg-slate-800 p-6 shadow-2xl border border-gray-200 dark:border-slate-700"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="flex items-start justify-between gap-4">
              <div>
                <h2 className="text-xl font-semibold text-gray-900 dark:text-white">{actionAccount.name}</h2>
                <p className="text-sm text-gray-500 dark:text-slate-400 capitalize">{actionAccount.account_type.replace('_', ' ')}</p>
              </div>
                <button
                onClick={closeActionModal}
                className="text-gray-400 dark:text-slate-500 hover:text-gray-600 dark:hover:text-slate-300 transition-colors duration-200"
                aria-label="Close account actions modal"
              >
                <svg className="h-6 w-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>

            <div className="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div className="rounded-lg border border-gray-200 dark:border-slate-700 bg-gray-50 dark:bg-slate-900/50 p-4">
                <h3 className="text-sm font-semibold text-gray-700 dark:text-slate-300">Balance</h3>
                <p className={`mt-2 text-lg font-bold ${actionAccount.balance >= 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-600 dark:text-red-400'}`}>
                  {formatCurrency(actionAccount.balance, actionAccount.currency as CurrencyCode)}
                </p>
                <p className="mt-2 text-sm text-gray-500 dark:text-slate-400">Currency: {actionAccount.currency}</p>
                {actionAccount.account_type === 'credit' && actionAccount.credit_limit !== undefined && (
                  <p className="mt-1 text-sm text-gray-500 dark:text-slate-400">
                    Credit limit {formatCurrency(actionAccount.credit_limit, actionAccount.currency as CurrencyCode)}
                  </p>
                )}
              </div>

              <div className="rounded-lg border border-gray-200 dark:border-slate-700 bg-gray-50 dark:bg-slate-900/50 p-4">
                <h3 className="text-sm font-semibold text-gray-700 dark:text-slate-300">Status</h3>
                <p className={`mt-2 inline-flex items-center gap-2 rounded-full px-3 py-1 text-sm font-medium ${actionAccount.is_active ? 'bg-blue-100 dark:bg-blue-500/10 text-blue-700 dark:text-blue-400' : 'bg-gray-200 dark:bg-slate-700 text-gray-600 dark:text-slate-400'}`}>
                  {actionAccount.is_active ? 'Active' : 'Inactive'}
                </p>
                {actionAccount.account_type === 'credit' && actionAccount.due_date && (
                  <p className="mt-2 text-sm text-gray-500 dark:text-slate-400">Statement closes every {actionAccount.due_date}th</p>
                )}
                {actionAccount.account_type === 'credit' && actionAccount.days_until_due_date && (
                  <p className="text-sm text-gray-500 dark:text-slate-400">Due {actionAccount.days_until_due_date} days after statement</p>
                )}
              </div>
            </div>

            <div className="mt-6 grid grid-cols-1 gap-3 sm:grid-cols-2">
              <button
                onClick={() => handleToggleActive(actionAccount)}
                className={`flex items-center justify-between gap-3 rounded-lg px-4 py-3 text-sm font-semibold transition-colors duration-200 ${
                  actionAccount.is_active ? 'bg-blue-50 dark:bg-blue-500/10 text-blue-700 dark:text-blue-400 hover:bg-blue-100 dark:hover:bg-blue-500/20' : 'bg-gray-100 dark:bg-slate-700 text-gray-600 dark:text-slate-300 hover:bg-gray-200 dark:hover:bg-slate-600'
                }`}
              >
                <span>{actionAccount.is_active ? 'Mark as inactive' : 'Activate account'}</span>
                <span
                  className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors duration-200 ${
                    actionAccount.is_active ? 'bg-blue-500' : 'bg-gray-300 dark:bg-slate-600'
                  }`}
                >
                  <span
                    className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform duration-200 ${
                      actionAccount.is_active ? 'translate-x-5' : 'translate-x-1'
                    }`}
                  />
                </span>
              </button>
              <button
                onClick={() => openEditFromModal(actionAccount)}
                className="flex items-center justify-center gap-2 rounded-lg bg-blue-500 px-4 py-3 text-sm font-semibold text-white transition-colors duration-200 hover:bg-blue-600"
              >
                <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
                </svg>
                Edit account
              </button>
              <button
                onClick={() => handleDelete(actionAccount.id)}
                className="flex items-center justify-center gap-2 rounded-lg bg-gray-100 dark:bg-slate-700 px-4 py-3 text-sm font-semibold text-gray-700 dark:text-slate-300 transition-colors duration-200 hover:bg-gray-200 dark:hover:bg-slate-600 sm:col-span-2"
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
          <div className="bg-white dark:bg-slate-800 rounded-xl p-6 w-full max-w-md shadow-2xl border border-gray-200 dark:border-slate-700">
            <div className="flex items-center justify-between mb-6">
              <h2 className="text-xl font-semibold text-gray-900 dark:text-white">
                {editingAccount ? 'Edit Account' : 'Create Account'}
              </h2>
              <button
                onClick={() => {
                  setIsCreateModalOpen(false)
                  setEditingAccount(null)
                  setFormData({
                    name: '',
                    account_type: 'checking',
                    balance: 0,
                    description: '',
                    credit_limit: undefined,
                    due_date: undefined,
                    billing_cycle_start: undefined,
                    currency: defaultCurrency,
                    days_until_due_date: 21,
                    is_active: true,
                  })
                  setShowCreditSettings(false)
                }}
                className="text-gray-400 dark:text-slate-500 hover:text-gray-600 dark:hover:text-slate-300 transition-colors duration-200 w-full sm:w-auto"
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
                    setFormData({ ...formData, account_type: nextType })
                    setShowCreditSettings(false)
                  }}
                  className="select-field focus-ring"
                >
                  <option value="checking">🏦 Checking</option>
                  <option value="savings">💰 Savings</option>
                  <option value="credit">💳 Credit Card</option>
                  <option value="cash">💵 Cash</option>
                  <option value="e_wallet">📱 E-Wallet</option>
                </select>
              </div>
              
              <div>
                <label className="label">Account Currency</label>
                <select
                  value={formData.currency}
                  onChange={(e) => setFormData({ ...formData, currency: e.target.value as CurrencyCode })}
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
                    <span className="text-gray-500 dark:text-slate-400 sm:text-sm">{formCurrencySymbol}</span>
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
              </div>
              
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
                <div className="space-y-3 p-4 bg-blue-50 dark:bg-blue-500/10 rounded-lg border border-blue-200 dark:border-blue-500/20">
                  <div className="flex items-center justify-between">
                    <h3 className="text-sm font-medium text-blue-800 dark:text-blue-300">Credit Card Settings</h3>
                    <button
                      type="button"
                      onClick={() => setShowCreditSettings((prev) => !prev)}
                      className="inline-flex items-center gap-1 text-xs font-semibold text-blue-700 dark:text-blue-400 hover:text-blue-900 dark:hover:text-blue-300"
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
                            <span className="text-gray-500 dark:text-slate-400 sm:text-sm">{formCurrencySymbol}</span>
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
                        <label className="label">Billing Cycle Start (Day of Month)</label>
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
                        <p className="mt-1 text-xs text-gray-500 dark:text-slate-500">Default is 21 days after the statement date.</p>
                      </div>
                    </div>
                  )}
                </div>
              )}

              <div className="flex items-center justify-between rounded-lg border border-gray-200 dark:border-slate-700 bg-gray-50 dark:bg-slate-900/50 px-4 py-3">
                <div>
                  <p className="text-sm font-medium text-gray-700 dark:text-slate-300">Account status</p>
                  <p className="text-xs text-gray-500 dark:text-slate-500">Inactive accounts stay in history but are hidden from most views.</p>
                </div>
                <div className="flex items-center gap-3">
                  <span className="text-sm text-gray-600 dark:text-slate-400">{formData.is_active ? 'Active' : 'Inactive'}</span>
                  <button
                    type="button"
                    onClick={() =>
                      setFormData((prev) => ({
                        ...prev,
                        is_active: !prev.is_active,
                      }))
                    }
                    className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors duration-200 ${
                      formData.is_active ? 'bg-blue-500' : 'bg-gray-300 dark:bg-slate-600'
                    }`}
                  >
                    <span
                      className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform duration-200 ${
                        formData.is_active ? 'translate-x-5' : 'translate-x-1'
                      }`}
                    />
                  </button>
                </div>
              </div>
              
              <div className="flex space-x-3 pt-6 border-t border-gray-200 dark:border-slate-700">
                <button
                  type="submit"
                  className="flex-1 btn-primary focus-ring w-full sm:w-auto py-3 px-4 text-base rounded-lg"
                >
                  {editingAccount ? 'Update Account' : 'Create Account'}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setIsCreateModalOpen(false)
                    setEditingAccount(null)
                    setFormData({
                      name: '',
                      account_type: 'checking',
                      balance: 0,
                      description: '',
                      credit_limit: undefined,
                      due_date: undefined,
                      billing_cycle_start: undefined,
                    currency: defaultCurrency,
                    days_until_due_date: 21,
                    is_active: true,
                    })
                  }}
                  className="flex-1 btn-secondary focus-ring w-full sm:w-auto py-3 px-4 text-base rounded-lg"
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
