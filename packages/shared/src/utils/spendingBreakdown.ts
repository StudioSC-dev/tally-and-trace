import type { Category } from '../types/api'
import { dayEndWire, dayStartWire } from './transactionList'

/** The summary query's date bounds: each side is sent only when it is set. */
export interface SummaryRange {
  start_date?: string
  end_date?: string
}

/**
 * The summary request's bounds for a page's date filter (`YYYY-MM-DD` strings, or ''
 * for an open end). An open side is left out, so the API applies no bound there.
 */
export function summaryRange(filterStart: string, filterEnd: string): SummaryRange {
  const range: SummaryRange = {}
  if (filterStart !== '') range.start_date = dayStartWire(filterStart)
  if (filterEnd !== '') range.end_date = dayEndWire(filterEnd)
  return range
}

const UNCATEGORIZED_ROW_NAME = 'Uncategorized'

/**
 * The summary's computed rows. They merge several sources (fees, wallet spend,
 * interest) and are not categories, so no category-name filter can reproduce them.
 * "Uncategorized" is the one exception: the list's `uncategorized` filter reproduces it
 * (see `buildSpendingBreakdown`). These mirror
 * `UNCATEGORIZED`, `TRANSFER_FEES`, `UNALLOCATED_WALLET_SPEND`, `RETURNED_FROM_WALLETS`
 * and `LOAN_INTEREST_PREFIX` in `backend/app/routers/transactions.py`.
 */
export const SYNTHETIC_ROW_NAMES: readonly string[] = [
  UNCATEGORIZED_ROW_NAME,
  'Transfer fees',
  'Unallocated wallet spend',
  'Returned from wallets',
]
const LOAN_INTEREST_PREFIX = 'Interest: '

export function isSyntheticRowName(name: string): boolean {
  return SYNTHETIC_ROW_NAMES.includes(name) || name.startsWith(LOAN_INTEREST_PREFIX)
}

/** What a row sets on the list's filters when it is clicked. */
export interface SpendingDrill {
  /** The category names to filter the list by. */
  names: string[]
  /** Also match income and expenses with no category (the list's `uncategorized` filter). */
  uncategorized: boolean
}

function drillFor(name: string): SpendingDrill | null {
  if (name === UNCATEGORIZED_ROW_NAME) return { names: [name], uncategorized: true }
  return isSyntheticRowName(name) ? null : { names: [name], uncategorized: false }
}

export interface SpendingRow {
  key: string
  name: string
  amount: number
  /** Fraction of `total`, 0 to 1. */
  share: number
  /** The list filters this row sets when clicked, or null when it can't be drilled into. */
  drill: SpendingDrill | null
  color?: string
}

export interface SpendingSlice extends SpendingRow {
  /** Cumulative share of every slice before this one. */
  offset: number
  isOther: boolean
}

export interface SpendingBreakdown {
  /** The sum of the rows listed (rows with spending only). */
  total: number
  rows: SpendingRow[]
  slices: SpendingSlice[]
}

/**
 * Turns a summary's `category_breakdown` into the dialog's rows and donut slices.
 *
 * Only rows with `expenses > 0` count, so a negative row such as "Returned from
 * wallets" is left out and `total` can differ from the period's expenses. A row is
 * drillable by name unless it is one of the summary's computed rows, even when the
 * caller owns a category of that name, because that row merges the computed amount.
 * A name the caller has no category for (a partner's) is still drillable: the list
 * filters by name.
 *
 * The "Uncategorized" row is the exception among the computed rows. It drills into the
 * name "Uncategorized" together with the `uncategorized` flag, whoever owns a real
 * category of that name, because the summary merges the computed row with that
 * category. The other computed rows and "Other" have no drill.
 */
export function buildSpendingBreakdown(
  breakdown: Record<string, { income: number; expenses: number }>,
  categories: readonly Pick<Category, 'name' | 'color'>[],
  maxSlices = 6,
): SpendingBreakdown {
  const entries = Object.entries(breakdown)
    .map(([name, line]) => ({ name, amount: line.expenses }))
    .filter((entry) => entry.amount > 0)
    .sort((a, b) => b.amount - a.amount || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  const total = entries.reduce((sum, entry) => sum + entry.amount, 0)

  const rows: SpendingRow[] = entries.map((entry) => {
    const color = categories.find((c) => c.name === entry.name)?.color?.trim()
    const row: SpendingRow = {
      key: `category:${entry.name}`,
      name: entry.name,
      amount: entry.amount,
      share: total > 0 ? entry.amount / total : 0,
      drill: drillFor(entry.name),
    }
    if (color) row.color = color
    return row
  })

  const shown = rows.length <= maxSlices ? rows : rows.slice(0, Math.max(maxSlices - 1, 0))
  const rest = rows.slice(shown.length)
  const parts: Omit<SpendingSlice, 'offset'>[] = shown.map((row) => ({ ...row, isOther: false }))
  if (rest.length > 0) {
    const amount = rest.reduce((sum, row) => sum + row.amount, 0)
    parts.push({
      key: 'aggregate:other',
      name: 'Other',
      amount,
      share: total > 0 ? amount / total : 0,
      drill: null,
      isOther: true,
    })
  }
  let offset = 0
  const slices = parts.map((part) => {
    const slice: SpendingSlice = { ...part, offset }
    offset += part.share
    return slice
  })

  return { total, rows, slices }
}
