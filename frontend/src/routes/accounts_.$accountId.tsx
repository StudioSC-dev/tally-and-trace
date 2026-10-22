import { createFileRoute, Link } from '@tanstack/react-router'
import { useEffect, useMemo, useRef } from 'react'
import { listBounds, pageWindow, parsePage, parsePositiveId, queryPhase } from '@tally-trace/shared'
import { AccountRoleBadge } from '../components/AccountRoleBadge'
import { AccountTransactionList } from '../components/AccountTransactionList'
import { CardCreditPanel } from '../components/CardCreditPanel'
import { SkeletonRows } from '../components/Loading'
import { Pager } from '../components/Pager'
import { TagChips } from '../components/TagChips'
import { useAuth } from '../contexts/AuthContext'
import { useToday } from '../hooks/useToday'
import {
  useGetAccountQuery,
  useGetAccountsQuery,
  useGetCategoriesQuery,
  useGetTransactionsQuery,
} from '../store/api'
import type { CurrencyCode } from '../store/api'
import { apiErrorMessage, apiErrorStatus } from '../utils/apiError'
import { formatCurrency } from '../utils/currency'

export const Route = createFileRoute('/accounts_/$accountId')({
  component: AccountDetailPage,
  validateSearch: (search: Record<string, unknown>): { page?: number } => ({ page: parsePage(search.page) }),
})

const PAGE_SIZE = 25

/**
 * One account: its header and balance, and the transactions that touch it (a transfer
 * shows on both of its accounts), newest first, a page at a time. Read-only, except a
 * credit card's credit panel for its owner or admin (statement minimums and Pay).
 */
function AccountDetailPage() {
  const { isAuthenticated, isLoading: authLoading } = useAuth()
  const navigate = Route.useNavigate()
  const { accountId: rawId } = Route.useParams()
  const { page: rawPage } = Route.useSearch()
  const today = useToday()
  const headingRef = useRef<HTMLHeadingElement>(null)

  const id = parsePositiveId(rawId)
  const skip = !isAuthenticated || id === null
  const page = rawPage ?? 1
  const offset = (page - 1) * PAGE_SIZE
  const end = listBounds('', '', today).main?.end

  useEffect(() => {
    if (!authLoading && !isAuthenticated) navigate({ to: '/login', search: { message: undefined } })
  }, [authLoading, isAuthenticated, navigate])

  // `currentData`, not `data`: `data` keeps the previous arguments' result while the next
  // one loads, which would show another account's header or rows (and clamp a page on
  // that account's total).
  const {
    currentData: account,
    error: accountError,
    refetch: refetchAccount,
  } = useGetAccountQuery(id ?? 0, { skip })
  const accountListQuery = useGetAccountsQuery({ limit: 1000 }, { skip })
  const accountList = accountListQuery.currentData
  const categoriesQuery = useGetCategoriesQuery({}, { skip })
  const categories = categoriesQuery.currentData
  const accountListPhase = queryPhase(accountList, accountListQuery, skip)
  const categoriesPhase = queryPhase(categories, categoriesQuery, skip)
  // Rows wait for both name lookups, so a transfer never reads "Other account" and a
  // category never reads "Uncategorized" before the real name lands.
  const namesPending = accountListPhase === 'pending' || categoriesPhase === 'pending'
  const namesError = accountListPhase === 'error' || categoriesPhase === 'error'
  const {
    currentData: transactions,
    error: transactionsError,
    isFetching: transactionsFetching,
    refetch: refetchTransactions,
  } = useGetTransactionsQuery(
    { account_ids: id === null ? [] : [id], end_date: end, limit: PAGE_SIZE, offset },
    { skip },
  )

  const accountNames = useMemo(
    () => new Map((accountList?.items ?? []).map((item) => [item.id, item.name] as const)),
    [accountList],
  )
  const categoryNames = useMemo(
    () => new Map((categories ?? []).map((category) => [category.id, category.name] as const)),
    [categories],
  )

  const total = transactions?.total
  useEffect(() => {
    if (total === undefined || total <= 0 || offset < total) return
    const last = pageWindow(total, page, PAGE_SIZE).pages
    navigate({ search: { page: last <= 1 ? undefined : last }, replace: true })
  }, [total, offset, page, navigate])

  const onPage = (next: number) => {
    navigate({ search: { page: next <= 1 ? undefined : next } })
    headingRef.current?.scrollIntoView?.({ block: 'start' })
  }

  if (authLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-ink"></div>
      </div>
    )
  }
  if (!isAuthenticated) return null

  const accountStatus = apiErrorStatus(accountError)
  if (id === null || accountStatus === 404 || accountStatus === 403) {
    return (
      <div className="max-w-5xl mx-auto px-3 py-6 sm:px-4 lg:px-6 space-y-4">
        <BackLink />
        <div className="card p-6" data-testid="account-not-found">
          <p className="text-base font-semibold text-ink">This account doesn&apos;t exist or isn&apos;t shared with you.</p>
        </div>
      </div>
    )
  }

  if (accountError) {
    return (
      <div className="max-w-5xl mx-auto px-3 py-6 sm:px-4 lg:px-6 space-y-4">
        <BackLink />
        <div className="card p-6 space-y-3" role="alert" data-testid="account-error">
          <p className="text-sm text-danger">{apiErrorMessage(accountError) || 'Could not load this account.'}</p>
          <button type="button" className="btn-secondary focus-ring" onClick={() => refetchAccount()}>
            Retry
          </button>
        </div>
      </div>
    )
  }

  if (!account) {
    return (
      <div className="max-w-5xl mx-auto px-3 py-6 sm:px-4 lg:px-6 space-y-4">
        <BackLink />
        <div className="card p-6" data-testid="account-loading">
          <p className="text-body font-medium">Loading…</p>
        </div>
      </div>
    )
  }

  const currency = account.currency as CurrencyCode

  return (
    <div className="max-w-5xl mx-auto px-3 py-6 sm:px-4 lg:px-6 space-y-6" data-testid="account-detail">
      <div className="space-y-2">
        <BackLink />
        <h1 className="text-2xl font-bold text-ink" data-testid="account-detail-title">{account.name}</h1>
        <div className="flex flex-wrap items-center gap-2 text-xs text-body">
          <span className="capitalize text-sm text-muted">{account.account_type.replace('_', ' ')}</span>
          <AccountRoleBadge account={account} />
          {account.is_active === false && (
            <span className="inline-flex items-center gap-1 rounded-full bg-sunken px-2 py-1 font-medium text-body">Inactive</span>
          )}
          {account.is_spending_wallet && (
            <span
              className="inline-flex items-center gap-1 rounded-full border border-line px-2 py-1 text-muted"
              title="Spending wallet: shown, but not counted in available cash or projections"
            >
              Not counted
            </span>
          )}
          <TagChips tags={account.tags} />
        </div>
      </div>

      <div className="card p-4 sm:p-5 space-y-3">
        <div className="flex flex-wrap items-baseline justify-between gap-3">
          <p className="text-sm text-muted">Balance ({account.currency})</p>
          <p
            className={`text-2xl font-bold ${account.balance >= 0 ? 'text-ok' : 'text-danger'}`}
            data-testid="account-detail-balance"
          >
            {formatCurrency(account.balance, currency)}
          </p>
        </div>
        {account.account_type === 'credit' && account.credit_limit != null && (
          <p className="text-sm text-body">Limit {formatCurrency(account.credit_limit, currency)}</p>
        )}
        {account.my_role === 'tag_viewer' && (
          <p className="border border-line bg-sunken p-3 text-sm text-body" data-testid="tag-viewer-note">
            {account.owner_name ?? 'Its owner'} shares this account through their Household. You can see its balance and
            the Household-tagged records on it, read-only.
          </p>
        )}
      </div>

      {account.account_type === 'credit' && account.permissions.can_edit_settings && <CardCreditPanel account={account} />}

      <section className="space-y-3" data-testid="account-transactions">
        <div>
          <h2 ref={headingRef} className="text-lg font-semibold text-ink">Transactions</h2>
          <p className="text-sm text-muted">On or before today, newest first.</p>
        </div>

        {transactionsError ? (
          <div className="card p-4 space-y-3" role="alert" data-testid="account-transactions-error">
            <p className="text-sm text-danger">
              {apiErrorMessage(transactionsError) || 'Could not load the transactions.'}
            </p>
            <button type="button" className="btn-secondary focus-ring" onClick={() => refetchTransactions()}>
              Retry
            </button>
          </div>
        ) : !transactions ? (
          <div className="card p-4" data-testid="account-transactions-loading">
            <p className="text-sm text-body">Loading transactions…</p>
          </div>
        ) : namesPending && transactions.total > 0 && offset < transactions.total ? (
          <div data-testid="account-transactions-loading" aria-busy="true">
            <SkeletonRows rows={3} />
            <span role="status" className="sr-only">Loading transactions</span>
          </div>
        ) : transactions.total === 0 ? (
          <div className="card p-4" data-testid="account-transactions-empty">
            <p className="text-sm text-body">No transactions on this account yet.</p>
          </div>
        ) : offset >= transactions.total ? (
          // Past the last page: the effect above moves to the last one.
          <div className="card p-4" data-testid="account-transactions-loading">
            <p className="text-sm text-body">Loading transactions…</p>
          </div>
        ) : (
          <>
            {namesError && (
              <p className="text-xs text-muted" data-testid="account-names-error">
                Account or category names could not be loaded, so some rows show a generic name.
              </p>
            )}
            <div className={transactionsFetching ? 'opacity-60' : ''}>
              <AccountTransactionList
                items={transactions.items}
                accountId={account.id}
                accountCurrency={currency}
                accountNames={accountNames}
                categoryNames={categoryNames}
                today={today}
              />
            </div>
            <Pager
              total={transactions.total}
              page={page}
              pageSize={PAGE_SIZE}
              onPage={onPage}
              label="Account transactions pages"
              testId="account-transactions-pager"
              disabled={transactionsFetching}
            />
          </>
        )}
      </section>
    </div>
  )
}

function BackLink() {
  return (
    <Link to="/accounts" className="text-sm text-muted hover:text-ink focus-ring" data-testid="account-detail-back">
      &larr; Accounts
    </Link>
  )
}
