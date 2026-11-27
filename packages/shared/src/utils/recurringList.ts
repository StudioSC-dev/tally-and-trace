import type { BudgetEntry } from '../types/api'
import { entryCalendarDate, parseEntryDate } from './entryDate'

/** How a Recurring section is ordered: by next due date, amount or name. */
export type RecurringSortKey = 'due' | 'amount' | 'name'
export type RecurringSortDirection = 'asc' | 'desc'
/** The status filter: every entry, only active ones, or only paused ones. */
export type RecurringStatusFilter = 'all' | 'active' | 'paused'

/** Entries on one page of a Recurring section. */
export const RECURRING_PAGE_SIZE = 5
/** Entries due within this many days read "Due in n days". */
export const DUE_SOON_DAYS = 7

/** One section's sort and filter, as the page holds them (the page number is the page's own). */
export interface RecurringSectionView {
  sort: RecurringSortKey
  direction: RecurringSortDirection
  status: RecurringStatusFilter
  /** Only entries touching this account; null for every account. */
  accountId: number | null
}

export const DEFAULT_RECURRING_VIEW: RecurringSectionView = {
  sort: 'due',
  direction: 'asc',
  status: 'all',
  accountId: null,
}

/** Whether a section's sort or filter differs from the default (its sort alone does not count as a filter). */
export function hasRecurringFilter(view: Pick<RecurringSectionView, 'status' | 'accountId'>): boolean {
  return view.status !== 'all' || view.accountId !== null
}

/**
 * The account ids an entry exposes: its own account, a transfer's other end and its overflow
 * (secondary funding) account. A limited entry exposes the two account refs the API gives it,
 * and only those with an id.
 */
export function entryAccountIds(entry: BudgetEntry): number[] {
  const ids =
    entry.view === 'limited'
      ? [entry.account?.id, entry.counterpart?.id]
      : [entry.account_id, entry.transfer_to_account_id, entry.overflow_account_id]
  return [...new Set(ids.filter((id): id is number => typeof id === 'number'))]
}

export interface RecurringAccountOption {
  id: number
  name: string
}

/**
 * The accounts a section's entries expose, for its account filter, by name. A name comes from
 * `names` first (the caller's accounts), then from a limited entry's own ref, else "Account n".
 */
export function recurringAccountOptions(
  entries: readonly BudgetEntry[],
  names: ReadonlyMap<number, string> = new Map(),
): RecurringAccountOption[] {
  const refNames = new Map<number, string>()
  const ids = new Set<number>()
  for (const entry of entries) {
    for (const id of entryAccountIds(entry)) ids.add(id)
    if (entry.view === 'limited') {
      for (const ref of [entry.account, entry.counterpart]) {
        if (ref && typeof ref.id === 'number' && !refNames.has(ref.id)) refNames.set(ref.id, ref.name)
      }
    }
  }
  const found = new Map([...ids].map((id) => [id, names.get(id) ?? refNames.get(id) ?? `Account ${id}`]))
  return [...found].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name) || a.id - b.id)
}

/**
 * The entries that pass a section's status and account filters, in their order. A limited entry
 * carries no status, so it shows only under "all"; an account filter matches either end of a transfer.
 */
export function filterRecurringEntries<T extends BudgetEntry>(
  entries: readonly T[],
  view: Pick<RecurringSectionView, 'status' | 'accountId'>,
): T[] {
  return entries.filter((entry) => {
    if (view.status !== 'all') {
      if (entry.view === 'limited') return false
      if (view.status === 'active' ? !entry.is_active : entry.is_active) return false
    }
    return view.accountId === null || entryAccountIds(entry).includes(view.accountId)
  })
}

function entryName(entry: BudgetEntry): string {
  return (entry.view === 'limited' ? entry.display_name : entry.name) ?? ''
}

function dueTime(entry: BudgetEntry): number {
  // Wall time stored as UTC parts: read it so, never through the browser's zone (a DST gap would reorder it).
  const time = parseEntryDate(entry.next_occurrence).getTime()
  return Number.isNaN(time) ? Number.POSITIVE_INFINITY : time
}

/** A new array in the chosen order; ties fall back to the id, so the order is the same every time. */
export function sortRecurringEntries<T extends BudgetEntry>(
  entries: readonly T[],
  sort: RecurringSortKey,
  direction: RecurringSortDirection,
): T[] {
  const sign = direction === 'asc' ? 1 : -1
  const compare = (a: T, b: T): number => {
    if (sort === 'amount') return a.amount - b.amount
    if (sort === 'name') return entryName(a).localeCompare(entryName(b), undefined, { sensitivity: 'base' })
    const x = dueTime(a)
    const y = dueTime(b)
    return x === y ? 0 : x < y ? -1 : 1
  }
  return [...entries].sort((a, b) => sign * compare(a, b) || a.id - b.id)
}

/** Filter, then sort: what a section lists before it is cut into pages. */
export function viewRecurringEntries<T extends BudgetEntry>(entries: readonly T[], view: RecurringSectionView): T[] {
  return sortRecurringEntries(filterRecurringEntries(entries, view), view.sort, view.direction)
}

/** The page that exists nearest to `page`: at least 1, at most the last page of `total` entries. */
export function clampRecurringPage(page: number, total: number, pageSize: number = RECURRING_PAGE_SIZE): number {
  const last = Math.max(1, Math.ceil(total / pageSize))
  return Math.min(Math.max(1, Math.floor(page) || 1), last)
}

/** The entries on one page (1-based). */
export function recurringPageSlice<T>(entries: readonly T[], page: number, pageSize: number = RECURRING_PAGE_SIZE): T[] {
  const current = clampRecurringPage(page, entries.length, pageSize)
  return entries.slice((current - 1) * pageSize, current * pageSize)
}

/** What a full, active entry's due date asks of the reader: `days` is whole calendar days from today. */
export type DueIndicator =
  | { kind: 'overdue'; days: number }
  | { kind: 'today' }
  | { kind: 'soon'; days: number }

function localDay(date: Date): number {
  return Date.UTC(date.getFullYear(), date.getMonth(), date.getDate())
}

/**
 * The due indicator of an entry, or null. Only an entry the caller sees in full that is active and
 * not fully paid carries one: past due is "overdue", today is "today", and the next
 * `DUE_SOON_DAYS` days are "soon". Days are calendar days on the reader's clock.
 */
export function dueIndicator(entry: BudgetEntry, today: Date = new Date()): DueIndicator | null {
  if (entry.view === 'limited' || !entry.is_active) return null
  if (entry.end_mode === 'after_occurrences' && (entry.max_occurrences ?? 0) === 0) return null
  if (Number.isNaN(parseEntryDate(entry.next_occurrence).getTime())) return null
  const due = entryCalendarDate(entry.next_occurrence)
  const days = Math.round((localDay(due) - localDay(today)) / 86_400_000)
  if (days < 0) return { kind: 'overdue', days: -days }
  if (days === 0) return { kind: 'today' }
  return days <= DUE_SOON_DAYS ? { kind: 'soon', days } : null
}
