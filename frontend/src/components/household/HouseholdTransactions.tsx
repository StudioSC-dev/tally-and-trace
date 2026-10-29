import { LoadingLine, SkeletonRows } from '../Loading'
import { useEffect, useState } from 'react'
import { queryPhase, rowAmount, transactionDate, transactionDescription, transactionStatus } from '@tally-trace/shared'
import { useGetHouseholdDashboardQuery, useGetHouseholdTransactionsQuery } from '../../store/api'
import type { Transaction } from '../../store/api'
import { apiErrorMessage } from '../../utils/apiError'
import { useToday } from '../../hooks/useToday'
import { TagChips } from '../TagChips'
import { formatDay, money } from './format'
import type { CurrencyCode } from '../../utils/currency'

const PAGE_SIZE = 20

const TYPE_LABELS: Record<Transaction['transaction_type'], string> = {
  debit: 'Expense',
  credit: 'Income',
  transfer: 'Transfer',
}

/** True when no write flag is set: nothing here can be edited, deleted, posted or reverted. */
const isReadOnly = (transaction: Transaction): boolean => !Object.values(transaction.permissions).some(Boolean)

/**
 * One transaction, from whichever shape the API gave. The Household view lists records; it
 * offers no controls on them, so a row has nothing to edit, delete, post or revert whatever
 * its flags say.
 */
function Row({
  transaction,
  accountNames,
  accountCurrencies,
  today,
}: {
  transaction: Transaction
  accountNames: Map<number, string>
  accountCurrencies: Map<number, CurrencyCode>
  today: string
}) {
  const limited = transaction.view === 'limited'
  const status = transactionStatus(transaction, today)
  const accountName = limited
    ? transaction.account?.name
    : accountNames.get(transaction.account_id) ?? null
  const counterpart = limited ? transaction.counterpart?.name : null
  // An unposted foreign debit or credit shows its face in its own currency; an unknown account keeps the stored figure.
  const accountCurrency = transaction.view === 'limited' ? undefined : accountCurrencies.get(transaction.account_id)
  const shown = accountCurrency ? rowAmount(transaction, accountCurrency) : { amount: transaction.amount, currency: transaction.currency }
  const sign = transaction.transaction_type === 'credit' ? '+' : transaction.transaction_type === 'debit' ? '−' : ''
  return (
    <li
      className="flex flex-wrap items-start justify-between gap-3 px-3 py-3"
      data-testid="household-transaction"
      data-view={transaction.view}
    >
      <div className="min-w-0 space-y-1">
        <p className="text-sm font-semibold text-ink" data-testid="household-transaction-description">
          {transactionDescription(transaction) ?? TYPE_LABELS[transaction.transaction_type]}
        </p>
        <p className="text-xs text-muted">
          {formatDay(transactionDate(transaction))} · {TYPE_LABELS[transaction.transaction_type]}
          {accountName ? ` · ${accountName}` : ''}
          {counterpart ? ` → ${counterpart}` : ''}
          {status !== 'posted' ? ` · ${status === 'pending' ? 'Pending' : 'Planned'}` : ''}
        </p>
        <div className="flex flex-wrap items-center gap-2 text-xs text-body">
          {transaction.created_by && (
            <span className="inline-flex items-center gap-1 rounded-full bg-sunken px-2 py-0.5" data-testid="created-by">
              By {transaction.created_by}
            </span>
          )}
          <TagChips tags={transaction.tags} />
          {isReadOnly(transaction) && (
            <span className="text-muted" data-testid="household-read-only">Read-only</span>
          )}
        </div>
      </div>
      <p className="text-sm font-semibold text-ink" data-testid="household-transaction-amount">
        {sign}
        {money(shown.amount, shown.currency)}
      </p>
    </li>
  )
}

/** The Household's transactions, newest first, a page at a time. */
export function HouseholdTransactionsTab({ sharerId }: { sharerId: number }) {
  const today = useToday()
  const [page, setPage] = useState(0)
  useEffect(() => setPage(0), [sharerId])
  const { data, isLoading, isFetching, error } = useGetHouseholdTransactionsQuery({
    sharerId,
    limit: PAGE_SIZE,
    offset: page * PAGE_SIZE,
  })
  // The view's accounts name a full record's account (a limited record names its own).
  const dashboardQuery = useGetHouseholdDashboardQuery(sharerId)
  const { data: dashboard } = dashboardQuery
  // A full record's account name comes from the dashboard, so the rows wait for it (or its failure).
  const namesPhase = queryPhase(dashboard, dashboardQuery)
  const accountNames = new Map((dashboard?.accounts ?? []).map((account) => [account.id, account.name]))
  const accountCurrencies = new Map((dashboard?.accounts ?? []).map((account) => [account.id, account.currency as CurrencyCode]))

  if (isLoading) return <LoadingLine>Loading...</LoadingLine>
  if (error || !data) {
    return (
      <p className="text-sm text-danger" role="alert">
        {apiErrorMessage(error) || 'Could not load transactions.'}
      </p>
    )
  }

  return (
    <section className="card p-4 sm:p-5 space-y-3" data-testid="household-transactions">
      <h2 className="text-lg font-semibold text-ink">Transactions</h2>
      {namesPhase === 'error' && (
        <p className="text-xs text-muted" data-testid="household-names-error">Account names could not be loaded.</p>
      )}
      {namesPhase === 'pending' ? (
        <div data-testid="household-transactions-loading" aria-busy="true">
          <span role="status" className="sr-only">Loading transactions</span>
          <SkeletonRows rows={3} />
        </div>
      ) : data.items.length === 0 ? (
        <p className="text-sm text-muted" data-testid="household-transactions-empty">
          No Household transactions yet.
        </p>
      ) : (
        <ul className="divide-y divide-line border border-line">
          {data.items.map((transaction) => (
            <Row key={transaction.id} transaction={transaction} accountNames={accountNames} accountCurrencies={accountCurrencies} today={today} />
          ))}
        </ul>
      )}
      <div className="flex items-center justify-between gap-3 text-sm">
        <span className="text-muted" data-testid="household-transactions-count">
          {data.total === 0
            ? ''
            : `${page * PAGE_SIZE + 1}-${page * PAGE_SIZE + data.items.length} of ${data.total}`}
        </span>
        <span className="flex gap-2">
          <button
            type="button"
            className="btn-secondary focus-ring text-sm"
            disabled={page === 0 || isFetching}
            onClick={() => setPage((current) => Math.max(0, current - 1))}
            data-testid="household-transactions-prev"
          >
            Previous
          </button>
          <button
            type="button"
            className="btn-secondary focus-ring text-sm"
            disabled={!data.has_more || isFetching}
            onClick={() => setPage((current) => current + 1)}
            data-testid="household-transactions-next"
          >
            Next
          </button>
        </span>
      </div>
    </section>
  )
}
