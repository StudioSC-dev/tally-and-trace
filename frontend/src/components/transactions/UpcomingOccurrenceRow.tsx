import { formatEntryDate, RECURRING_ACTION_LABELS, upcomingOccurrenceRow } from '@tally-trace/shared'
import type { CreditCheck, RecurringAction, UpcomingOccurrence } from '@tally-trace/shared'
import { formatCurrency } from '../../utils/currency'
import type { CurrencyCode } from '../../utils/currency'
import { CreditCheckBadge } from '../CreditSummary'

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
  /** The occurrence's card credit check (owner or admin only); no badge without one. */
  credit?: CreditCheck | undefined
  onRecord: (action: RecurringAction) => void
  onReview: () => void
}

/**
 * A recurring entry's future occurrence that no row stands for yet, as one compact row of
 * the Due card (Upcoming, Subscriptions), laid out like its entry rows: the name,
 * "{date} · {account}", "Not recorded" with the auto-post label, the amount and the buttons.
 * The buttons come from `upcomingOccurrenceRow` alone: the server decides what can be recorded.
 */
export function UpcomingOccurrenceRow({ occurrence, scheduled, credit, onRecord, onReview }: Props) {
  const view = upcomingOccurrenceRow(occurrence, scheduled)
  const amountClass = occurrence.is_transfer ? 'text-ink' : occurrence.entry_type === 'income' ? 'text-ok' : 'text-danger'
  const sign = occurrence.is_transfer ? '' : occurrence.entry_type === 'income' ? '+' : '-'
  const accountLabel = occurrence.is_transfer
    ? `${occurrence.account_name ?? 'Source'} → ${occurrence.transfer_to_account_name ?? 'Destination'}`
    : occurrence.account_name
  // The note always starts with "Not recorded", shown on its own; the rest is the auto-post label.
  const detail = view.note.startsWith(NOT_RECORDED) ? view.note.slice(NOT_RECORDED.length) : ` · ${view.note}`

  return (
    <li
      className="px-4 py-3"
      data-testid="due-row"
      data-kind="occurrence"
      data-view={occurrence.view}
      data-source={`budget_entry:${occurrence.entry_id}`}
      data-day={occurrence.occurrence_date}
      data-plan={occurrence.plan_kind ?? undefined}
    >
      <div
        className="flex items-start justify-between gap-3"
        data-testid="upcoming-occurrence"
        data-source={`budget_entry:${occurrence.entry_id}`}
        data-day={occurrence.occurrence_date}
      >
        <div className="min-w-0">
          <p className="text-sm font-medium text-ink" data-testid="upcoming-occurrence-name">{occurrence.name}</p>
          <p className="text-xs text-muted">
            {formatEntryDate(occurrence.occurrence_date)}
            {accountLabel && ` · ${accountLabel}`}
          </p>
          <p className="text-xs text-muted" data-testid="upcoming-occurrence-note">
            <span className="text-warn" data-testid="upcoming-not-recorded">{NOT_RECORDED}</span>
            {detail}
          </p>
          {credit && <CreditCheckBadge check={credit} />}
        </div>
        <div className="flex-shrink-0 space-y-1 text-right">
          <p className={`text-sm font-semibold ${amountClass}`} data-testid="upcoming-occurrence-amount">
            {sign}
            {formatCurrency(occurrence.amount, occurrence.currency as CurrencyCode)}
          </p>
          {(view.actions.length > 0 || view.review) && (
            <div className="flex flex-wrap justify-end gap-2">
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
    </li>
  )
}
