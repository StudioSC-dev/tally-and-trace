import { manilaToday } from './cardPay'
import { formatEntryDate } from './entryDate'

/** The earliest date a record (transaction, payment) may be saved with. */
export const RECORD_DATE_MIN = '2000-01-01'

const DAY = /^(\d{4})-(\d{2})-(\d{2})$/

function isCalendarDay(day: string): boolean {
  const match = DAY.exec(day)
  if (!match) return false
  const [year, month, date] = [Number(match[1]), Number(match[2]), Number(match[3])]
  const probe = new Date(Date.UTC(year, month - 1, date))
  // Date.UTC maps years 0-99 to 1900-1999, so pin the year back before comparing.
  probe.setUTCFullYear(year)
  return probe.getUTCFullYear() === year && probe.getUTCMonth() === month - 1 && probe.getUTCDate() === date
}

/** The latest date a record may be saved with: `today` plus five years (Feb 29 becomes Feb 28). */
export function recordDateMax(today: string = manilaToday()): string {
  const match = DAY.exec(today)
  if (!match) throw new Error(`recordDateMax needs a YYYY-MM-DD day, got "${today}"`)
  const year = Number(match[1]) + 5
  const month = match[2]
  let day = match[3]
  if (month === '02' && day === '29') {
    const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0
    if (!leap) day = '28'
  }
  return `${String(year).padStart(4, '0')}-${month}-${day}`
}

/**
 * The message for a record date outside the allowed range, or null when it is fine. An empty
 * value is fine (the field is optional); a malformed one is out of range.
 */
export function recordDateError(day: string, today: string = manilaToday()): string | null {
  if (day === '') return null
  const max = recordDateMax(today)
  if (isCalendarDay(day) && day >= RECORD_DATE_MIN && day <= max) return null
  return `Choose a date from ${formatEntryDate(RECORD_DATE_MIN)} to ${formatEntryDate(max)}`
}
