import type { ForcedDateCascadeOption, ForcedDateOptions } from '../types/api'
import { formatCurrency } from './currency'
import { formatEntryDate } from './entryDate'

/**
 * Forced dates: an occurrence keeps its scheduled day as its identity, and its
 * effective date (the forced one, else the scheduled one) decides when it is
 * due, shown, overdue and posted. Days are `YYYY-MM-DD` strings.
 */

/** The effective date of an occurrence, defaulting to its scheduled day for an older API. */
export function effectiveDay(scheduled: string, effective?: string | null): string {
  return effective ?? scheduled
}

/** Whether the occurrence sits on a forced date. */
export function isForced(scheduled: string, effective?: string | null): boolean {
  return effective != null && effective !== scheduled
}

/** "Dec 12th, 2026", or "Dec 12th, 2026 (moved from Dec 10th, 2026)" for a forced date. */
export function movedText(scheduled: string, effective?: string | null): string {
  const shown = effectiveDay(scheduled, effective)
  return isForced(scheduled, effective)
    ? `${formatEntryDate(shown)} (moved from ${formatEntryDate(scheduled)})`
    : formatEntryDate(shown)
}

/** What a saved card charge confirms: the statement now billing it, or null with no cycle. */
export function statementConfirmation(result: { statement_close?: string | null }): string | null {
  return result.statement_close ? `Now on the statement closing ${formatEntryDate(result.statement_close)}` : null
}

// ─── Choices for a refused date ──────────────────────────────────────────────

/** One choice of the dialog as text: its heading, its lines, and why it is unavailable. */
export interface DateChoice {
  available: boolean
  title: string
  lines: string[]
  /** Pay together: the total on the shared day; null otherwise. */
  total: string | null
  /** Pay together: why the day is not the one chosen; null otherwise. */
  note: string | null
  /** "Delay all: ..." or "Pay together: ..." with the server's reason; null while available. */
  unavailable: string | null
}

export interface DateChoiceLines {
  overlap: DateChoice
  cascade: DateChoice
}

const dayOfMonth = (day: string): number => Number(day.slice(8, 10))

const ordinal = (n: number): string => {
  if (n % 100 >= 11 && n % 100 <= 13) return `${n}th`
  return `${n}${['th', 'st', 'nd', 'rd'][n % 10] ?? 'th'}`
}

const daysBetween = (from: string, to: string): number =>
  Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000)

const dayOf = (wire: string): string => wire.slice(0, 10)

const withStatement = (text: string, close: string | null): string =>
  close ? `${text} · statement closing ${formatEntryDate(dayOf(close))}` : text

/**
 * How often the delayed schedule repeats: "on the 12th" for a day-of-month schedule, "every
 * 7 days" for a day-count one (read from two consecutive moves); null when it cannot be told
 * (a day-count schedule with one move shown).
 */
function cascadeRepeat(cascade: ForcedDateCascadeOption): string | null {
  const last = cascade.moves[cascade.moves.length - 1]
  if (!last) return null
  if (cascade.rule === 'day_of_month') return `on the ${ordinal(dayOfMonth(last.to))}`
  const prior = cascade.moves[cascade.moves.length - 2]
  if (cascade.rule !== 'days' || !prior) return null
  return `every ${daysBetween(prior.to, last.to)} days`
}

/**
 * The text of the two choices for a refused date: Pay together (the payments on the shared
 * day and their total, with a note when `chosen` is past the next payment) and Delay all (the
 * first moves, how the schedule repeats and, on a bounded schedule, how many payments move).
 * A card choice adds "· statement closing ..." to its lines. An unavailable choice carries the
 * server's reason, prefixed with the choice's name.
 */
export function dateChoiceLines(options: ForcedDateOptions, chosen?: string): DateChoiceLines {
  const { overlap, cascade } = options
  const overlapDay = dayOf(overlap.date)

  const payments = overlap.payments.map((p) => {
    const day = dayOf(p.effective_date)
    const was = dayOf(p.occurrence_date)
    const when = was === day ? formatEntryDate(day) : `${formatEntryDate(was)} → ${formatEntryDate(day)}`
    return withStatement(`${when} · ${formatCurrency(Number(p.amount), overlap.currency)}`, overlap.statement_close)
  })
  const total = overlap.available && overlap.total !== null
    ? `Total on ${formatEntryDate(overlapDay)}: ${formatCurrency(Number(overlap.total), overlap.currency)}`
    : null
  const note = overlap.available && chosen && dayOf(chosen) > overlapDay
    ? `${formatEntryDate(dayOf(chosen))} is past the next payment; this is the closest day it can join it`
    : null

  const moves = cascade.moves.map((m) =>
    withStatement(`${formatEntryDate(dayOf(m.from))} → ${formatEntryDate(dayOf(m.to))}`, m.statement_close))
  const repeat = cascadeRepeat(cascade)
  const cascadeLines = [...moves]
  if (repeat) cascadeLines.push(`…and every later one ${repeat}`)
  if (cascade.remaining !== null) cascadeLines.push(`${cascade.remaining} ${cascade.remaining === 1 ? 'payment moves' : 'payments move'} in all`)

  return {
    overlap: {
      available: overlap.available,
      title: `Pay together on ${formatEntryDate(overlapDay)}`,
      lines: overlap.available ? payments : [],
      total,
      note,
      unavailable: overlap.available ? null : `Pay together: ${overlap.reason ?? 'not available for this date'}`,
    },
    cascade: {
      available: cascade.available,
      title: 'Delay this and every later payment',
      lines: cascade.available ? cascadeLines : [],
      total: null,
      note: null,
      unavailable: cascade.available ? null : `Delay all: ${cascade.reason ?? 'not available for this date'}`,
    },
  }
}

/** Whether either choice can be offered; with neither, the dialog shows only the refusal. */
export function hasDateChoice(options: ForcedDateOptions): boolean {
  return options.overlap.available || options.cascade.available
}

/**
 * What a Delay all confirms: "Moved to Nov 12th, 2026. Later payments follow on the 12th."
 * (or "every 7 days"; just the first sentence when the repeat is not known).
 */
export function cascadeConfirmation(chosen: string, cascade: ForcedDateCascadeOption): string {
  const first = `Moved to ${formatEntryDate(dayOf(chosen))}.`
  const repeat = cascadeRepeat(cascade)
  return repeat ? `${first} Later payments follow ${repeat}.` : first
}
