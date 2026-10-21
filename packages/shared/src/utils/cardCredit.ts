import type { CardCredit, CreditCheck, CreditStatus } from '../types/api'
import { formatCurrency } from './currency'
import { formatEntryDate } from './entryDate'

/**
 * The key a check is matched on: `source:source_id:(occurrence_date ?? date)`. A budget
 * entry's occurrence date identifies it; a transaction has only its own date.
 */
export function creditCheckKey(check: Pick<CreditCheck, 'source' | 'source_id' | 'date' | 'occurrence_date'>): string {
  return `${check.source}:${check.source_id}:${check.occurrence_date ?? check.date}`
}

/** The warning or reassurance a check shows, e.g. "OK with planned payment by Apr 1st, 2027". */
export function creditStatusText(check: Pick<CreditCheck, 'status' | 'relies_on_planned'>): string {
  const status: CreditStatus = check.status
  switch (status) {
    case 'ok':
      return 'OK'
    case 'ok_with_planned':
      return check.relies_on_planned
        ? `OK with planned payment by ${formatEntryDate(check.relies_on_planned)}`
        : 'OK with planned payment'
    case 'at_risk':
      return 'Would exceed available credit'
    case 'installment':
      return 'Installment: already held'
    case 'unchecked':
      return 'No exchange rate: not checked'
    case 'incomplete':
      return 'Credit check incomplete'
  }
}

/**
 * The headline figure and the planned-payment line. `complete: false` reads "at most";
 * the planned line is null when no planned payment is counted.
 */
export function availableCreditText(credit: Pick<
  CardCredit,
  'currency' | 'available_now' | 'available_with_planned' | 'planned_by' | 'complete'
>): { available: string; withPlanned: string | null } {
  const now = formatCurrency(credit.available_now, credit.currency)
  const available = credit.complete ? now : `at most ${now}`
  const withPlanned = credit.planned_by === null
    ? null
    : `${formatCurrency(credit.available_with_planned, credit.currency)} with planned payment by ${formatEntryDate(credit.planned_by)}`
  return { available, withPlanned }
}

/** The non-ok checks for one budget entry, in date order. */
export function entryCreditWarnings(checks: readonly CreditCheck[], entryId: number): CreditCheck[] {
  return checks
    .filter((c) => c.source === 'budget_entry' && c.source_id === entryId && c.status !== 'ok')
    .sort((a, b) => (a.occurrence_date ?? a.date).localeCompare(b.occurrence_date ?? b.date))
}
