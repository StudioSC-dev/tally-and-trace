import type {
  BudgetEntry, CashflowTimelineEvent, LimitedTimelineEvent, Transaction, UpcomingItemOrEvent,
} from '../types/api'

/**
 * Field readers that work on every record shape. A Limited record has `date` and
 * `display_description` where a Full one has `transaction_date` and `description`;
 * these pick the right one so callers don't have to narrow just to display a row.
 */

/** ISO datetime of a transaction, whatever its shape. */
export function transactionDate(transaction: Transaction): string {
  return transaction.view === 'limited' ? transaction.date : transaction.transaction_date
}

/** The text to show for a transaction, or null when there is none. Limited rows use the neutral label. */
export function transactionDescription(transaction: Transaction): string | null {
  const text = transaction.view === 'limited' ? transaction.display_description : transaction.description
  return text ?? null
}

/** The name to show for a recurring entry. Limited entries use the neutral display name. */
export function entryName(entry: BudgetEntry): string | null {
  return entry.view === 'limited' ? entry.display_name : entry.name
}

/** The name to show for a timeline event, whether full or limited. */
export function timelineEventName(event: CashflowTimelineEvent | LimitedTimelineEvent): string {
  return event.view === 'limited' ? event.display_name : event.name
}

/** The signed effect of a timeline event on cash (a limited event's `cash_delta`). */
export function timelineEventAmount(event: CashflowTimelineEvent | LimitedTimelineEvent): number {
  return event.view === 'limited' ? event.cash_delta : event.amount
}

/**
 * An upcoming item as listed: its amount, and whether money comes in or goes out.
 * A limited event lists its `face_amount`, not its `cash_delta`: that is only the
 * cash effect, which is 0 for a card charge billed on a later statement. Its
 * direction comes from its kind; a transfer's from the side of it the caller holds.
 * A Household occurrence (kind `household`) moves none of the caller's cash and does not
 * say which way it goes, so it has no direction.
 */
export function upcomingItemAmount(item: UpcomingItemOrEvent): { amount: number; direction: 'in' | 'out' | null } {
  if (item.view === 'limited') {
    let direction: 'in' | 'out' | null = item.kind === 'income' ? 'in' : 'out'
    if (item.kind === 'transfer') direction = item.cash_delta > 0 ? 'in' : item.cash_delta < 0 ? 'out' : null
    if (item.kind === 'household') direction = null
    return { amount: item.face_amount, direction }
  }
  const type = item.entry_type
  const direction = type === 'income' || type === 'credit' ? 'in' : type === 'expense' || type === 'debit' ? 'out' : null
  return { amount: item.amount, direction }
}
