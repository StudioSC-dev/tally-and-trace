import type { Transaction, UpcomingOccurrence } from '../types/api'
import { autoPostLabel } from './installmentReview'
import { recurringActionsFor } from './recurringActions'
import type { RecurringAction } from './recurringActions'
import { transactionDate } from './records'
import { wallDay } from './transactionList'

/**
 * Transactions Upcoming is two sources on one list: transaction rows (planned or
 * pending) and recurring occurrences not recorded yet.
 */

export type UpcomingRow =
  | { kind: 'transaction'; key: string; day: string; transaction: Transaction }
  | { kind: 'occurrence'; key: string; day: string; occurrence: UpcomingOccurrence }

/**
 * A stable two-way merge on the day alone, cut to `limit`.
 *
 * `transactions` is in the order `loadUpcoming` produces (`transaction_date` ascending,
 * then id) and `occurrences` in the server's order (`occurrence_date`, `name`,
 * `entry_id`). Neither is re-sorted. At each step the head with the earlier day is taken,
 * and on the same day every transaction comes before every occurrence. The merged order is
 * therefore each source's own order interleaved by day, so the first `limit` rows of each
 * source are enough for the first `limit` rows of the merge to be exact. Keys are React
 * keys and are never compared.
 */
export function mergeUpcoming(
  transactions: readonly Transaction[],
  occurrences: readonly UpcomingOccurrence[],
  limit: number,
): UpcomingRow[] {
  const rows: UpcomingRow[] = []
  let t = 0
  let o = 0
  while (rows.length < limit && (t < transactions.length || o < occurrences.length)) {
    const transaction = transactions[t]
    const occurrence = occurrences[o]
    const transactionDay = transaction === undefined ? '' : wallDay(transactionDate(transaction))
    if (transaction !== undefined && (occurrence === undefined || transactionDay <= occurrence.occurrence_date)) {
      rows.push({ kind: 'transaction', key: `txn:${transaction.id}`, day: transactionDay, transaction })
      t += 1
    } else if (occurrence !== undefined) {
      rows.push({
        kind: 'occurrence',
        key: `occ:${occurrence.entry_id}:${occurrence.occurrence_date}`,
        day: occurrence.occurrence_date,
        occurrence,
      })
      o += 1
    }
  }
  return rows
}

export interface UpcomingOccurrenceView {
  /** The record buttons, primary first. */
  actions: RecurringAction[]
  /** Offer Review (a card installment not yet on or held). */
  review: boolean
  /** The line under the name. */
  note: string
}

/**
 * What an Upcoming occurrence row offers. Buttons come from `recurringActionsFor` with
 * the server's `recordable` as the permission, and from nothing else: the auto-post gate
 * lives on the server. `auto_post` is read only for the note and for Review.
 */
export function upcomingOccurrenceRow(occ: UpcomingOccurrence, scheduled: boolean): UpcomingOccurrenceView {
  const actions = recurringActionsFor({
    kind: occ.kind,
    entry_type: occ.is_transfer ? 'transfer' : occ.entry_type,
    can_mark_paid: occ.recordable,
  })
  const label = autoPostLabel(occ.auto_post, scheduled, occ.block_reason)
  return {
    actions,
    review: occ.can_review && (occ.auto_post === 'unreviewed' || occ.auto_post === 'held'),
    note: label === null ? 'Not recorded' : `Not recorded · ${label}`,
  }
}
