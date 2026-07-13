import type { RecurrenceFrequency, EndMode } from '../types/api'

/**
 * Minimal shape needed to project a recurring schedule's occurrences.
 * A full `BudgetEntry` satisfies this.
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
}

/** Advance a date by one step of a fixed-cadence frequency. */
export function addCadence(date: Date, cadence: RecurrenceFrequency): Date {
  const next = new Date(date.getTime())
  switch (cadence) {
    case 'daily':
      next.setDate(next.getDate() + 1)
      break
    case 'weekly':
      next.setDate(next.getDate() + 7)
      break
    case 'biweekly':
      next.setDate(next.getDate() + 14)
      break
    case 'monthly':
      next.setMonth(next.getMonth() + 1)
      break
    case 'quarterly':
      next.setMonth(next.getMonth() + 3)
      break
    case 'semi_annual':
      next.setMonth(next.getMonth() + 6)
      break
    case 'annual':
      next.setFullYear(next.getFullYear() + 1)
      break
    default:
      // 'semi_monthly' is handled directly in generateOccurrences
      break
  }
  return next
}

/**
 * All occurrences of a recurring schedule within `[rangeStart, rangeEnd]`.
 *
 * Mirrors the backend `iter_occurrences`: fixed-step cadences walk forward from
 * `next_occurrence`; `semi_monthly` fires on two configurable days each month
 * (default 1 & 15), clamped to the month length. Respects `end_date`
 * (`end_mode === 'on_date'`) and `max_occurrences` (`end_mode === 'after_occurrences'`).
 */
export function generateOccurrences(
  entry: RecurringSchedule,
  rangeStart: Date,
  rangeEnd: Date,
  maxIterations = 60
): Date[] {
  const occurrences: Date[] = []
  if (!entry.next_occurrence) return occurrences

  const anchor = new Date(entry.next_occurrence)
  if (Number.isNaN(anchor.getTime())) return occurrences

  const endDateLimit =
    entry.end_mode === 'on_date' && entry.end_date ? new Date(entry.end_date) : null
  const cap =
    entry.end_mode === 'after_occurrences' && entry.max_occurrences
      ? entry.max_occurrences
      : Infinity

  if (entry.cadence === 'semi_monthly') {
    const days = Array.from(
      new Set([entry.semi_monthly_day_1 ?? 1, entry.semi_monthly_day_2 ?? 15])
    ).sort((a, b) => a - b)
    let produced = 0
    let cursor = new Date(anchor.getFullYear(), anchor.getMonth(), 1)
    for (let i = 0; i < maxIterations && cursor <= rangeEnd; i++) {
      const lastDay = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 0).getDate()
      for (const day of days) {
        const occ = new Date(
          cursor.getFullYear(), cursor.getMonth(), Math.min(day, lastDay),
          anchor.getHours(), anchor.getMinutes(), anchor.getSeconds()
        )
        if (occ < anchor) continue
        if (endDateLimit && occ > endDateLimit) return occurrences
        if (produced >= cap) return occurrences
        produced++
        if (occ >= rangeStart && occ <= rangeEnd) occurrences.push(new Date(occ))
      }
      cursor = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 1)
    }
    return occurrences
  }

  // Fixed-step cadences (weekly / biweekly / monthly / quarterly / semi-annual / annual).
  let occurrence = new Date(anchor)
  let occurrencesRemaining = cap
  for (let i = 0; i < maxIterations && occurrencesRemaining > 0 && occurrence <= rangeEnd; i++) {
    if (endDateLimit && occurrence > endDateLimit) break
    if (occurrence >= rangeStart && occurrence <= rangeEnd) {
      occurrences.push(new Date(occurrence))
    }
    occurrencesRemaining--
    if (occurrencesRemaining <= 0) break
    const nextOccurrence = addCadence(occurrence, entry.cadence)
    if (nextOccurrence.getTime() === occurrence.getTime()) break
    occurrence = nextOccurrence
  }

  return occurrences
}
