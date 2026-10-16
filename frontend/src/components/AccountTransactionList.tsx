import {
  accountLeg,
  formatEntryDate,
  relativeEntryDay,
  transactionCategoryName,
  transactionDate,
  transactionDescription,
  transactionStatus,
} from '@tally-trace/shared'
import type { TransactionStatus } from '@tally-trace/shared'
import type { CurrencyCode, Transaction } from '../store/api'
import { formatCurrency } from '../utils/currency'
import { TagChips } from './TagChips'

// Copied from the Transactions page; a follow-up extracts the row and removes the copy.
const STATUS_LABELS: Record<TransactionStatus, string> = { posted: 'Posted', pending: 'Pending', planned: 'Planned' }
const STATUS_BADGE_CLASSES: Record<TransactionStatus, string> = {
  posted: 'text-ink',
  pending: 'bg-sunken text-warn',
  planned: 'bg-sunken text-body',
}

const TYPE_LABELS: Record<Transaction['transaction_type'], string> = {
  credit: 'Income',
  debit: 'Expense',
  transfer: 'Transfer',
}

interface RowProps {
  row: Transaction
  accountId: number
  accountCurrency: CurrencyCode
  accountNames: ReadonlyMap<number, string>
  categoryNames: ReadonlyMap<number, string>
  today: string
}

/** One transaction as it touches one account. Read-only: editing stays on the Transactions page. */
export function AccountTransactionRow({ row, accountId, accountCurrency, accountNames, categoryNames, today }: RowProps) {
  const leg = accountLeg(row, accountId, accountCurrency)
  const status = transactionStatus(row, today)
  const date = transactionDate(row)
  const description = transactionDescription(row)?.trim() || 'Untitled transaction'
  const isTransfer = row.transaction_type === 'transfer'
  const counterpart =
    leg.counterpartName ?? (leg.counterpartId !== null ? accountNames.get(leg.counterpartId) : undefined) ?? 'Other account'
  const category = transactionCategoryName(row, categoryNames)
  const postingDate = row.view !== 'limited' ? row.posting_date : undefined

  const amountText = !leg.effectKnown
    ? `Sent ${formatCurrency(Math.abs(leg.signed), leg.currency)}`
    : `${leg.signed > 0 ? '+' : leg.signed < 0 ? '−' : ''}${formatCurrency(Math.abs(leg.signed), leg.currency)}`
  const amountClass =
    !leg.effectKnown || leg.direction === null ? 'text-ink' : leg.direction === 'in' ? 'text-ok' : 'text-danger'

  return (
    <li
      className={`card p-4 sm:p-5 ${row.is_posted ? '' : 'bg-sunken border border-line'}`}
      data-testid="account-transaction"
      data-view={row.view}
      data-direction={leg.direction ?? 'none'}
    >
      <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
        <div className="min-w-0 space-y-2">
          <div className="flex flex-wrap items-center gap-2 text-xs font-semibold uppercase tracking-wide text-muted">
            <span>{relativeEntryDay(date, today)}</span>
            <span className="hidden md:inline">•</span>
            <span>{formatEntryDate(date)}</span>
          </div>
          <p className="text-base font-semibold text-ink">{description}</p>
          <div className="flex flex-wrap gap-2 text-xs text-body">
            {isTransfer && leg.direction !== null && (
              <span className="inline-flex items-center gap-1 rounded-full bg-sunken px-2 py-1" data-testid="account-transaction-counterpart">
                {leg.direction === 'out' ? 'To' : 'From'} {counterpart}
              </span>
            )}
            <span className="inline-flex items-center gap-1 rounded-full bg-sunken px-2 py-1">
              {isTransfer ? category || 'Transfer' : category || 'Uncategorized'}
            </span>
            {row.created_by && (
              <span className="inline-flex items-center gap-1 rounded-full bg-sunken px-2 py-1" data-testid="created-by">
                by {row.created_by}
              </span>
            )}
            <TagChips tags={row.tags} />
          </div>
        </div>
        <div className="space-y-2 md:text-right">
          <p
            className={`text-lg font-bold ${amountClass}`}
            data-testid="account-transaction-amount"
            title={!leg.effectKnown ? `Amount sent in ${leg.currency}; the amount received isn't shown.` : undefined}
          >
            {amountText}
          </p>
          {leg.direction === 'out' && leg.fee !== null && (
            <p className="text-xs text-muted">incl. fee {formatCurrency(leg.fee, leg.currency)}</p>
          )}
          {row.view !== 'limited' && row.original_amount != null && row.original_currency && (
            <p className="text-xs text-muted">
              Original {formatCurrency(row.original_amount, row.original_currency)}
            </p>
          )}
          {postingDate && <p className="text-xs text-muted">Posted {formatEntryDate(postingDate)}</p>}
          <div className="flex flex-wrap gap-2 md:justify-end">
            <span className="inline-flex rounded-full px-2 py-1 text-xs font-semibold text-ink">
              {TYPE_LABELS[row.transaction_type]}
            </span>
            <span className={`inline-flex rounded-full px-2 py-1 text-xs font-semibold ${STATUS_BADGE_CLASSES[status]}`}>
              {STATUS_LABELS[status]}
            </span>
            {row.view !== 'limited' && row.is_reconciled && (
              <span className="inline-flex rounded-full px-2 py-1 text-xs font-semibold text-ok">Reconciled</span>
            )}
          </div>
        </div>
      </div>
    </li>
  )
}

interface ListProps extends Omit<RowProps, 'row'> {
  items: Transaction[]
}

export function AccountTransactionList({ items, ...rest }: ListProps) {
  return (
    <ul className="grid grid-cols-1 gap-3" data-testid="account-transaction-list">
      {items.map((row) => (
        <AccountTransactionRow key={row.id} row={row} {...rest} />
      ))}
    </ul>
  )
}
