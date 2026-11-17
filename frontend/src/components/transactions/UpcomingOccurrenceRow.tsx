import { movedText, RECURRING_ACTION_LABELS, upcomingOccurrenceRow } from '@tally-trace/shared'
import type { CreditCheck, RecurringAction, UpcomingOccurrence } from '@tally-trace/shared'
import { amountClass, formatAmount } from '../../utils/amount'
import type { CurrencyCode } from '../../utils/currency'
import { CreditCheckBadge } from '../CreditSummary'
import { Button } from '../Button'

const ACTION_TEST_IDS: Record<RecurringAction, string> = {
  mark_paid: 'upcoming-mark-paid',
  mark_received: 'upcoming-mark-received',
  charged: 'upcoming-charged',
  posted: 'upcoming-posted',
}

/**
 * Row actions are secondary buttons (docs/design-system.md, "Button"). Each keeps the height it had until STU-682
 * sizes buttons: an action that was outlined keeps its padding, and one that was filled had no border, so it takes
 * 2px less padding and a 24px floor.
 */
const ROW_ACTION = 'px-2.5 py-1 text-xs'
const WAS_FILLED_ROW_ACTION = 'min-h-6 px-2.5 py-0.5 text-xs'

const NOT_RECORDED = 'Not recorded'

interface Props {
  occurrence: UpcomingOccurrence
  /** The response's `auto_post_scheduled`, for the auto-post label. */
  scheduled: boolean
  /** The occurrence's card credit check (owner or admin only); no badge without one. */
  credit?: CreditCheck | undefined
  onRecord: (action: RecurringAction) => void
  onReview: () => void
  /** Open the Change date dialog; the button shows only for a caller who can record the occurrence. */
  onChangeDate?: () => void
  /** Buttons at least 44px high, for a list that is read on a phone. */
  touch?: boolean
  /** Every button waits while the data the row comes from refetches (stale-data guard). */
  disabled?: boolean
}

/**
 * A recurring entry's future occurrence that no row stands for yet, as one compact row of
 * the Due card (Upcoming, Subscriptions), laid out like its entry rows: the name,
 * "{date} · {account}", "Not recorded" with the auto-post label, the amount and the buttons.
 * The buttons come from `upcomingOccurrenceRow` alone: the server decides what can be recorded.
 */
export function UpcomingOccurrenceRow({ occurrence, scheduled, credit, onRecord, onReview, onChangeDate, touch = false, disabled = false }: Props) {
  const size = touch ? ' min-h-11 min-w-11' : ''
  const view = upcomingOccurrenceRow(occurrence, scheduled)
  const amountClassName = amountClass(!occurrence.is_transfer && occurrence.entry_type === 'income' ? 'in' : 'out')
  // Money in leads with `+`, money out with a minus sign (U+2212), a transfer with nothing; a zero is never signed.
  const signKind = occurrence.is_transfer ? 'out' : occurrence.entry_type === 'income' ? 'in' : 'negative'
  const accountLabel = occurrence.is_transfer
    ? `${occurrence.account_name ?? 'Source'} to ${occurrence.transfer_to_account_name ?? 'Destination'}`
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
            <span data-testid="upcoming-occurrence-date">{movedText(occurrence.occurrence_date, occurrence.effective_date)}</span>
            {accountLabel && ` · ${accountLabel}`}
          </p>
          <p className="text-xs text-muted" data-testid="upcoming-occurrence-note">
            <span className="text-warn" data-testid="upcoming-not-recorded">{NOT_RECORDED}</span>
            {detail}
          </p>
          {credit && <CreditCheckBadge check={credit} />}
        </div>
        <div className="flex-shrink-0 space-y-1 text-right">
          <p className={`text-sm font-semibold ${amountClassName}`} data-testid="upcoming-occurrence-amount">
            {formatAmount(signKind, occurrence.amount, occurrence.currency as CurrencyCode)}
          </p>
          {(view.actions.length > 0 || view.review || (onChangeDate && occurrence.can_mark_paid)) && (
            <div className="flex flex-wrap justify-end gap-2">
              {view.review && (
                <Button variant="secondary" onClick={onReview} disabled={disabled} className={`${ROW_ACTION}${size}`} data-testid="upcoming-review">
                  Review
                </Button>
              )}
              {view.actions.map((action, index) => (
                <Button
                  key={action}
                  variant="secondary"
                  onClick={() => onRecord(action)}
                  disabled={disabled}
                  className={`${index === 0 ? WAS_FILLED_ROW_ACTION : ROW_ACTION}${size}`}
                  data-testid={ACTION_TEST_IDS[action]}
                >
                  {RECURRING_ACTION_LABELS[action]}
                </Button>
              ))}
              {onChangeDate && occurrence.can_mark_paid && (
                <Button variant="secondary" onClick={onChangeDate} disabled={disabled} className={`${ROW_ACTION}${size}`} data-testid="occurrence-change-date">
                  Change date
                </Button>
              )}
            </div>
          )}
        </div>
      </div>
    </li>
  )
}
