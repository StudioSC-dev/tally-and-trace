import type { RecurrenceFrequency, EndMode, DayRule } from '../types/api'
import { parseEntryDate } from './entryDate'

/**
 * Minimal shape needed to project a recurring schedule's occurrences.
 * A full `BudgetEntry` satisfies this.
 *
 * Dates are wall time stored as UTC components (see `entryDate.ts`): every
 * step here reads and writes UTC components, never the browser's local time.
 */
export interface RecurringSchedule {
  cadence: RecurrenceFrequency
  next_occurrence: string | Date
  end_mode?: EndMode
  end_date?: string | Date | null
  max_occurrences?: number | null
  /** Only used when cadence === 'semi_monthly' (defaults 1 & 15). */
  semi_monthly_day_1?: number
  semi_monthly_day_2?: number
  /** Month-family cadences: the intended day 1-31 (used when `day_rule` is null). */
  anchor_day?: number | null
  /** Month-family cadences: the day rule, which wins over `anchor_day`. */
  day_rule?: DayRule | null
}

/** The day fields `ruleDate` reads. */
export interface DayFields {
  anchor_day?: number | null
  day_rule?: DayRule | null
}

/** Months per step for the month-family cadences. */
const MONTH_STEP: Partial<Record<RecurrenceFrequency, number>> = {
  monthly: 1,
  quarterly: 3,
  semi_annual: 6,
  annual: 12,
}

/** Monthly, quarterly, semi-annual and annual: the cadences a day rule applies to. */
export function isMonthFamily(cadence: RecurrenceFrequency): boolean {
  return MONTH_STEP[cadence] !== undefined
}

/** Days in `month` (1-12) of `year`. */
export function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate()
}

/** The month's last Monday-Friday, at 00:00 UTC (`month` is 1-12). */
export function lastWeekday(year: number, month: number): Date {
  const date = new Date(Date.UTC(year, month - 1, daysInMonth(year, month)))
  while (date.getUTCDay() === 0 || date.getUTCDay() === 6) {
    date.setUTCDate(date.getUTCDate() - 1)
  }
  return date
}

/**
 * The entry's day in `month` (1-12) of `year`, at 00:00 UTC, or null for the
 * legacy schedule. Mirrors the backend `rule_date`.
 */
export function ruleDate(entry: DayFields, year: number, month: number): Date | null {
  if (entry.day_rule === 'last_weekday') return lastWeekday(year, month)
  const anchor = entry.anchor_day
  if (anchor) return new Date(Date.UTC(year, month - 1, Math.min(anchor, daysInMonth(year, month))))
  return null
}

/** `date` moved to (year, month, day), keeping its UTC time of day. */
function withUtcDay(date: Date, year: number, month: number, day: number): Date {
  return new Date(
    Date.UTC(year, month - 1, day, date.getUTCHours(), date.getUTCMinutes(), date.getUTCSeconds(), date.getUTCMilliseconds())
  )
}

/** (year, month) `months` later; `month` is 1-12. */
function shiftMonth(year: number, month: number, months: number): [number, number] {
  const index = month - 1 + months
  return [year + Math.floor(index / 12), (index % 12) + 1]
}

/**
 * Advance a date by one step of a fixed-cadence frequency, in UTC components.
 * Month steps clamp the day to the target month (Jan 31 + 1 month is Feb 28),
 * like the backend's legacy `_add_months`.
 */
export function addCadence(date: Date, cadence: RecurrenceFrequency): Date {
  switch (cadence) {
    case 'daily':
      return new Date(date.getTime() + 86_400_000)
    case 'weekly':
      return new Date(date.getTime() + 7 * 86_400_000)
    case 'biweekly':
      return new Date(date.getTime() + 14 * 86_400_000)
    case 'semi_monthly':
      // Handled directly in generateOccurrences.
      return new Date(date.getTime())
    default: {
      const months = MONTH_STEP[cadence] ?? 1
      const [year, month] = shiftMonth(date.getUTCFullYear(), date.getUTCMonth() + 1, months)
      return withUtcDay(date, year, month, Math.min(date.getUTCDate(), daysInMonth(year, month)))
    }
  }
}

/**
 * The occurrence after `current` for a fixed-step cadence. Mirrors the backend
 * `step_occurrence`: a month-family entry with an anchor or rule steps from
 * (year, month), never the day, so a clamped Feb 28 returns to the 31st;
 * otherwise the legacy step (`addCadence`).
 */
export function stepOccurrence(entry: DayFields & { cadence: RecurrenceFrequency }, current: Date): Date {
  const months = MONTH_STEP[entry.cadence]
  if (months !== undefined) {
    const [year, month] = shiftMonth(current.getUTCFullYear(), current.getUTCMonth() + 1, months)
    const day = ruleDate(entry, year, month)
    if (day) return withUtcDay(current, year, month, day.getUTCDate())
  }
  return addCadence(current, entry.cadence)
}

/**
 * All occurrences of a recurring schedule within `[rangeStart, rangeEnd]`.
 *
 * Mirrors the backend `iter_occurrences`: fixed-step cadences walk forward from
 * `next_occurrence` (`stepOccurrence`); `semi_monthly` fires on two configurable
 * days each month (default 1 & 15), clamped to the month length. Respects
 * `end_date` (`end_mode === 'on_date'`, inclusive) and `max_occurrences`
 * (`end_mode === 'after_occurrences'`; 0 means none left).
 */
export function generateOccurrences(
  entry: RecurringSchedule,
  rangeStart: Date,
  rangeEnd: Date,
  maxIterations = 60
): Date[] {
  const occurrences: Date[] = []
  if (!entry.next_occurrence) return occurrences

  const anchor = parseEntryDate(entry.next_occurrence)
  if (Number.isNaN(anchor.getTime())) return occurrences

  const endDateLimit =
    entry.end_mode === 'on_date' && entry.end_date ? parseEntryDate(entry.end_date) : null
  const cap =
    entry.end_mode === 'after_occurrences' && entry.max_occurrences != null
      ? entry.max_occurrences
      : Infinity

  if (entry.cadence === 'semi_monthly') {
    const days = Array.from(
      new Set([entry.semi_monthly_day_1 ?? 1, entry.semi_monthly_day_2 ?? 15])
    ).sort((a, b) => a - b)
    let produced = 0
    let year = anchor.getUTCFullYear()
    let month = anchor.getUTCMonth() + 1
    for (let i = 0; i < maxIterations && Date.UTC(year, month - 1, 1) <= rangeEnd.getTime(); i++) {
      const lastDay = daysInMonth(year, month)
      for (const day of days) {
        const occ = withUtcDay(anchor, year, month, Math.min(day, lastDay))
        if (occ < anchor) continue
        if (endDateLimit && occ > endDateLimit) return occurrences
        if (produced >= cap) return occurrences
        produced++
        if (occ >= rangeStart && occ <= rangeEnd) occurrences.push(occ)
      }
      ;[year, month] = shiftMonth(year, month, 1)
    }
    return occurrences
  }

  // Fixed-step cadences (weekly / biweekly / monthly / quarterly / semi-annual / annual).
  let occurrence = anchor
  let occurrencesRemaining = cap
  for (let i = 0; i < maxIterations && occurrencesRemaining > 0 && occurrence <= rangeEnd; i++) {
    if (endDateLimit && occurrence > endDateLimit) break
    if (occurrence >= rangeStart && occurrence <= rangeEnd) {
      occurrences.push(new Date(occurrence))
    }
    occurrencesRemaining--
    if (occurrencesRemaining <= 0) break
    const nextOccurrence = stepOccurrence(entry, occurrence)
    if (nextOccurrence.getTime() === occurrence.getTime()) break
    occurrence = nextOccurrence
  }

  return occurrences
}
