import { formatEntryDate, RECURRING_ACTION_LABELS, relativeEntryDay, upcomingOccurrenceRow } from '@tally-trace/shared'
import type { RecurringAction, UpcomingOccurrence } from '@tally-trace/shared'
import { formatCurrency } from '../../utils/currency'
import type { CurrencyCode } from '../../utils/currency'

const ACTION_TEST_IDS: Record<RecurringAction, string> = {
  mark_paid: 'upcoming-mark-paid',
  mark_received: 'upcoming-mark-received',
  charged: 'upcoming-charged',
  posted: 'upcoming-posted',
}

const buttonClass =
  'border border-line px-2.5 py-1 text-xs font-semibold text-ink hover:bg-sunken disabled:opacity-50 transition-colors focus-ring'
const primaryButtonClass =
  'bg-ok px-2.5 py-1 text-xs font-semibold text-paper hover:bg-ok disabled:opacity-50 transition-colors focus-ring'

const NOT_RECORDED = 'Not recorded'

interface Props {
  occurrence: UpcomingOccurrence
  /** The response's `auto_post_scheduled`, for the auto-post label. */
  scheduled: boolean
  /** The viewer's local day, for "Tomorrow" and the like (display only). */
  today: string
  onRecord: (action: RecurringAction) => void
  onReview: () => void
}

/**
 * A recurring entry's future occurrence that no row stands for yet, in Transactions
 * Upcoming. It has the transaction card's shape as an unposted row, and its buttons
 * come from `upcomingOccurrenceRow` alone: the server decides what can be recorded.
 */
export function UpcomingOccurrenceRow({ occurrence, scheduled, today, onRecord, onReview }: Props) {
  const view = upcomingOccurrenceRow(occurrence, scheduled)
  const amountClass = occurrence.is_transfer ? 'text-ink' : occurrence.entry_type === 'income' ? 'text-ok' : 'text-danger'
  const sign = occurrence.is_transfer ? '' : occurrence.entry_type === 'income' ? '+' : '-'
  const typeLabel = occurrence.is_transfer ? 'Transfer' : occurrence.entry_type === 'income' ? 'Income' : 'Expense'
  const accountLabel = occurrence.is_transfer
    ? `${occurrence.account_name ?? 'Source'} → ${occurrence.transfer_to_account_name ?? 'Destination'}`
    : occurrence.account_name
  // The note always starts with "Not recorded", shown as the badge; the rest is the auto-post label.
  const detail = view.note.startsWith(NOT_RECORDED) ? view.note.slice(NOT_RECORDED.length) : ` · ${view.note}`

  return (
    <article
      className="card p-4 sm:p-5 bg-sunken border border-line"
      data-testid="upcoming-occurrence"
      data-source={`budget_entry:${occurrence.entry_id}`}
      data-day={occurrence.occurrence_date}
    >
      <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
        <div className="space-y-2">
          <div className="flex flex-wrap items-center gap-2 text-xs font-semibold uppercase tracking-wide text-muted">
            <span>{relativeEntryDay(occurrence.occurrence_date, today)}</span>
            <span className="hidden md:inline text-muted">•</span>
            <span className="text-muted">{formatEntryDate(occurrence.occurrence_date)}</span>
          </div>
          <p className="text-base font-semibold text-ink" data-testid="upcoming-occurrence-name">{occurrence.name}</p>
          <p className="text-xs text-muted" data-testid="upcoming-occurrence-note">
            <span className="inline-flex rounded-full bg-surface px-2 py-0.5 font-semibold text-warn" data-testid="upcoming-not-recorded">
              {NOT_RECORDED}
            </span>
            {detail}
          </p>
          {accountLabel && (
            <div className="flex flex-wrap gap-2 text-xs text-body">
              <span className="inline-flex items-center gap-1 rounded-full bg-surface px-2 py-1">{accountLabel}</span>
            </div>
          )}
        </div>
        <div className="space-y-2 md:text-right">
          <p className={`text-lg font-bold ${amountClass}`} data-testid="upcoming-occurrence-amount">
            {sign}
            {formatCurrency(occurrence.amount, occurrence.currency as CurrencyCode)}
          </p>
          <div className="flex flex-wrap gap-2 md:justify-end">
            <span className={`inline-flex rounded-full px-2 py-1 text-xs font-semibold ${amountClass}`}>{typeLabel}</span>
          </div>
          {(view.actions.length > 0 || view.review) && (
            <div className="flex flex-wrap gap-2 md:justify-end">
              {view.review && (
                <button type="button" onClick={onReview} className={buttonClass} data-testid="upcoming-review">
                  Review
                </button>
              )}
              {view.actions.map((action, index) => (
                <button
                  key={action}
                  type="button"
                  onClick={() => onRecord(action)}
                  className={index === 0 ? primaryButtonClass : buttonClass}
                  data-testid={ACTION_TEST_IDS[action]}
                >
                  {RECURRING_ACTION_LABELS[action]}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
    </article>
  )
}
