import type { Transaction } from '../types/api'
import { formatEntryDate, parseEntryDate } from './entryDate'
import { transactionDate } from './records'

/**
 * Transaction dates are wall time stored as UTC components, the same contract as
 * budget-entry dates (see `entryDate.ts`). Everything here reads, compares and
 * builds bounds from UTC components, never from the browser's zone. The one
 * exception is `localToday`, which is the viewer's own calendar day.
 */

export type TransactionStatus = 'posted' | 'pending' | 'planned'

/** The bounds of one list request, as wire values. `start` / `end` are omitted when open. */
export interface ListRange {
  start?: string
  end?: string
}

export interface ListBounds {
  /** Rows on or before today, or null when the filter starts after today. */
  main: ListRange | null
  /** Rows after today, or null when the filter ends before tomorrow. */
  upcoming: ListRange | null
}

export interface PageWindow {
  /** 1-based position of the first row on the page (0 when there are no rows). */
  from: number
  /** 1-based position of the last row on the page (0 when there are no rows). */
  to: number
  pages: number
  /** The requested page, clamped to the pages that exist. */
  page: number
}

const DAY = /^\d{4}-\d{2}-\d{2}$/

function pad(value: number): string {
  return String(value).padStart(2, '0')
}

/** The `YYYY-MM-DD` of a wire value from its UTC components ('' if unreadable). */
export function wallDay(wire: string): string {
  const date = parseEntryDate(wire)
  return Number.isNaN(date.getTime()) ? '' : date.toISOString().slice(0, 10)
}

/** The viewer's local calendar day as `YYYY-MM-DD`. */
export function localToday(now: Date = new Date()): string {
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
}

/** Calendar arithmetic on a `YYYY-MM-DD` string, through UTC components. */
export function addDays(day: string, days: number): string {
  if (!DAY.test(day)) throw new RangeError(`Not a calendar day: ${day}`)
  const date = new Date(`${day}T00:00:00Z`)
  date.setUTCDate(date.getUTCDate() + days)
  return date.toISOString().slice(0, 10)
}

/** First instant of a `YYYY-MM-DD` day, as the wire value. */
export function dayStartWire(day: string): string {
  return `${day}T00:00:00Z`
}

/**
 * Last instant of a `YYYY-MM-DD` day, as the wire value. It carries microseconds:
 * a loan payment sent without a date is stored with a microsecond timestamp, and the
 * API compares the bound inclusively.
 */
export function dayEndWire(day: string): string {
  return `${day}T23:59:59.999999Z`
}

/**
 * Posted wins. Otherwise a wall day on or before `today` is pending (due, not yet
 * posted) and a later one is planned. An unreadable date is pending.
 */
export function statusFromDate(wireOrDay: string, isPosted: boolean, today: string): TransactionStatus {
  if (isPosted) return 'posted'
  const day = wallDay(wireOrDay)
  if (day === '') return 'pending'
  return day <= today ? 'pending' : 'planned'
}

/** The status of a transaction in any shape. */
export function transactionStatus(row: Transaction, today: string): TransactionStatus {
  return statusFromDate(transactionDate(row), row.is_posted, today)
}

/**
 * Splits a date filter at today into the two list requests: the main list (on or
 * before today) and Upcoming (after today). Inputs are `YYYY-MM-DD` strings, or ''
 * for an open end. The min / max is done on the day strings, then converted once.
 */
export function listBounds(filterStart: string, filterEnd: string, today: string): ListBounds {
  const tomorrow = addDays(today, 1)

  let main: ListRange | null = null
  if (filterStart === '' || filterStart <= today) {
    const end = dayEndWire(filterEnd !== '' && filterEnd < today ? filterEnd : today)
    main = filterStart === '' ? { end } : { start: dayStartWire(filterStart), end }
  }

  let upcoming: ListRange | null = null
  if (filterEnd === '' || filterEnd >= tomorrow) {
    const start = dayStartWire(filterStart !== '' && filterStart > tomorrow ? filterStart : tomorrow)
    upcoming = filterEnd === '' ? { start } : { start, end: dayEndWire(filterEnd) }
  }

  return { main, upcoming }
}

/** "Today", "Yesterday" or "Tomorrow" for a wire date, else its calendar day. */
export function relativeEntryDay(wire: string, today: string): string {
  const day = wallDay(wire)
  if (day === today) return 'Today'
  if (day !== '' && day === addDays(today, -1)) return 'Yesterday'
  if (day !== '' && day === addDays(today, 1)) return 'Tomorrow'
  return formatEntryDate(wire)
}

/** The rows a page covers, with the page clamped to the pages that exist. */
export function pageWindow(total: number, page: number, size: number): PageWindow {
  const perPage = Math.max(1, Math.floor(size))
  const pages = Math.ceil(total / perPage)
  const clamped = Math.min(Math.max(1, Math.floor(page)), Math.max(1, pages))
  if (total <= 0) return { from: 0, to: 0, pages: 0, page: clamped }
  return { from: (clamped - 1) * perPage + 1, to: Math.min(total, clamped * perPage), pages, page: clamped }
}
