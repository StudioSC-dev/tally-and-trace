import { formatEntryDate, rowAmount, transactionDate, transactionDescription, transactionStatus, wallDay } from '@tally-trace/shared'
import type { Transaction, TransactionStatus } from '@tally-trace/shared'
import { formatCurrency } from '../../utils/currency'
import type { CurrencyCode } from '../../utils/currency'

const STATUS_LABELS: Record<TransactionStatus, string> = { planned: 'Planned', pending: 'Pending', posted: 'Posted' }

interface Props {
  transaction: Transaction
  /** The viewer's local day, for the Planned / Pending / Posted label only. */
  localDay: string
  /** Open the transaction in the page's action modal (Edit, Delete, Post). */
  onOpen: (transaction: Transaction) => void
  /** Each account's currency by id, so a foreign row shows its face in its own currency. */
  accountCurrencies?: ReadonlyMap<number, CurrencyCode> | undefined
}

/**
 * A future transaction as one compact row of the Due card's Upcoming tab and the Scheduled
 * view: one button that opens it in the page's action modal.
 */
export function UpcomingTransactionRow({ transaction: txn, localDay, onOpen, accountCurrencies }: Props) {
  // A Limited row has no account id, so it keeps its stored figure.
  const accountCurrency = txn.view === 'limited' ? undefined : accountCurrencies?.get(txn.account_id)
  const shown = accountCurrency ? rowAmount(txn, accountCurrency) : { amount: txn.amount, currency: txn.currency }
  const day = wallDay(transactionDate(txn))
  return (
    <li
      data-testid="due-row"
      data-kind="upcoming"
      data-view={txn.view}
      data-source={`transaction:${txn.id}`}
      data-day={day}
    >
      <button
        type="button"
        onClick={() => onOpen(txn)}
        className="flex w-full items-start justify-between gap-3 px-4 py-3 text-left hover:bg-sunken transition-colors focus-ring"
        data-testid="upcoming-transaction"
      >
        <div className="min-w-0">
          <p className="text-sm font-medium text-ink">{transactionDescription(txn) ?? 'Transaction'}</p>
          <p className="text-xs text-muted">
            {formatEntryDate(day)} · {STATUS_LABELS[transactionStatus(txn, localDay)]}
          </p>
        </div>
        <div className="flex-shrink-0 text-right">
          <p className="text-sm font-semibold text-ink">{formatCurrency(shown.amount, shown.currency)}</p>
        </div>
      </button>
    </li>
  )
}
