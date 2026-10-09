import type { BudgetEntry, Transaction } from '../types/api'

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
