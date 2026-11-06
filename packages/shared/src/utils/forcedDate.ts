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
