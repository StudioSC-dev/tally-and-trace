import type { BudgetEntry } from '../types/api'

/** Where a recurring entry's account and category names come from when the entry carries only ids. */
export interface RecurringSearchNames {
  accountName?: string | null
  categoryName?: string | null
}

/** The search tab of Allocations: `recurring` is the label, `subscriptions` the older value that still opens it. */
export type AllocationsTab = 'subscriptions' | 'budgets' | 'savings' | 'wishlist'

/** Reads the `tab` search param: `recurring` and `subscriptions` both mean the recurring tab. */
export function parseAllocationsTab(value: unknown): AllocationsTab | undefined {
  if (value === 'recurring' || value === 'subscriptions') return 'subscriptions'
  if (value === 'budgets' || value === 'savings' || value === 'wishlist') return value
  return undefined
}

/** The amount as a reader might type it: plain, with two decimals, and grouped ("1500", "1500.00", "1,500.00"). */
function amountTexts(amount: number): string[] {
  return [String(amount), amount.toFixed(2), amount.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })]
}

/**
 * Whether an entry matches a search. Case-insensitive, on the entry's name, its account's name,
 * its category's name and its amount text. A blank query matches every entry. A limited entry
 * has no name of its own, so its display name stands in.
 */
export function matchesRecurringSearch(entry: BudgetEntry, query: string, names: RecurringSearchNames = {}): boolean {
  const needle = query.trim().toLowerCase()
  if (needle === '') return true
  const name = entry.view === 'limited' ? entry.display_name : entry.name
  const haystack = [name, names.accountName, names.categoryName, ...amountTexts(entry.amount)]
  return haystack.some((text) => typeof text === 'string' && text.toLowerCase().includes(needle))
}
