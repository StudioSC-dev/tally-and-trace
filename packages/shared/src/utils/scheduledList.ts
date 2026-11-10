import { formatEntryDate } from './entryDate'
import { recordDateMax } from './recordDates'
import { addDays } from './transactionList'

/** How far ahead the Scheduled view reaches when no Through day is chosen. */
export const SCHEDULED_DEFAULT_DAYS = 365
/** The furthest day recurring occurrences are listed for (the occurrences API's horizon). */
export const OCCURRENCE_HORIZON_DAYS = 730

export interface ScheduledRange {
  /** First listed day: the day after `today`, or a later From. */
  start: string
  /** Last listed day: Through, or `today` + 365; at least `start`, at most the record maximum. */
  end: string
  /** The last day recurring occurrences are listed for: `end`, at most `today` + 730. */
  occurrencesThrough: string
  /** Set when `end` is past the occurrences' horizon: the day they stop at. */
  listedThrough: string | null
  /** The earliest From the view takes. */
  min: string
  /** The latest Through the view takes (the record maximum). */
  max: string
}

/**
 * The Scheduled view's range from the Manila `today` and the optional From and Through days
 * (empty or undefined for "default"). From never reaches back to today; Through defaults to
 * `today` + 365 and stops at the record maximum.
 */
export function scheduledRange(today: string, from?: string, through?: string): ScheduledRange {
  const min = addDays(today, 1)
  const max = recordDateMax(today)
  const start = from !== undefined && from > min ? from : min
  const wanted = through !== undefined && through !== '' ? through : addDays(today, SCHEDULED_DEFAULT_DAYS)
  const clamped = wanted > max ? max : wanted
  const end = clamped < start ? start : clamped
  const horizon = addDays(today, OCCURRENCE_HORIZON_DAYS)
  return {
    start,
    end,
    occurrencesThrough: end < horizon ? end : horizon,
    listedThrough: end > horizon ? horizon : null,
    min,
    max,
  }
}

/** The line under the header when recurring payments stop before Through; null when they reach it. */
export function scheduledThroughNote(range: Pick<ScheduledRange, 'listedThrough'>): string | null {
  return range.listedThrough === null
    ? null
    : `Recurring payments are listed through ${formatEntryDate(range.listedThrough)}; one-off transactions continue after it`
}

/** "Showing a–b of total" for the page at `index` (0 = first) holding `count` rows; null with no rows. */
export function scheduledPageText(index: number, limit: number, count: number, total: number): string | null {
  if (count === 0) return null
  const from = index * limit + 1
  return `Showing ${from}–${from + count - 1} of ${total}`
}
