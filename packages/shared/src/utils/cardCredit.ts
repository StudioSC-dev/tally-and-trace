import type { Account, CardCredit, CreditCheck, CreditStatus } from '../types/api'
import { formatCurrency } from './currency'
import { formatEntryDate } from './entryDate'

/**
 * The key a check is matched on: `source:source_id:(occurrence_date ?? date)`. A budget
 * entry's occurrence date identifies it; a transaction has only its own date.
 */
export function creditCheckKey(check: Pick<CreditCheck, 'source' | 'source_id' | 'date' | 'occurrence_date'>): string {
  return `${check.source}:${check.source_id}:${check.occurrence_date ?? check.date}`
}

/**
 * The credit check for one budget entry's occurrence on `day` (its occurrence date), across
 * every card the snapshot lists; undefined when no card has one (no `credit` for the caller,
 * or no check for that day). Matched on `creditCheckKey`, so a check whose `date` differs
 * from its `occurrence_date` is found by the occurrence date only.
 */
export function occurrenceCreditCheck(
  cards: readonly { credit?: Pick<CardCredit, 'checks'> | undefined }[],
  entryId: number,
  day: string,
): CreditCheck | undefined {
  const key = `budget_entry:${entryId}:${day}`
  for (const card of cards) {
    const check = card.credit?.checks.find((c) => creditCheckKey(c) === key)
    if (check !== undefined) return check
  }
  return undefined
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

/**
 * The line for charges dated later in the 30-day outlook, which come off on their own dates
 * and are not in the headline figure. Null when there are none (or the field is missing).
 */
export function plannedChargesText(
  credit: Pick<CardCredit, 'currency' | 'planned_charges_total'>,
): string | null {
  if (!(credit.planned_charges_total > 0)) return null
  return `${formatCurrency(credit.planned_charges_total, credit.currency)} in charges dated later in the next 30 days, taken off on their dates`
}

/** The non-ok checks for one budget entry, in date order. */
export function entryCreditWarnings(checks: readonly CreditCheck[], entryId: number): CreditCheck[] {
  return checks
    .filter((c) => c.source === 'budget_entry' && c.source_id === entryId && c.status !== 'ok')
    .sort((a, b) => (a.occurrence_date ?? a.date).localeCompare(b.occurrence_date ?? b.date))
}

export interface EntryCreditWarning {
  /** The check the entry's card shows. */
  check: CreditCheck
  /** Other checks of the entry that are warnings (`at_risk`, `unchecked`, `incomplete`). */
  more: number
}

// Most severe first. `ok_with_planned` is a reassurance: it can be shown, never counted as a warning.
const WARNING_SEVERITY: readonly CreditStatus[] = ['at_risk', 'unchecked', 'incomplete', 'ok_with_planned']
const COUNTED_WARNINGS: readonly CreditStatus[] = ['at_risk', 'unchecked', 'incomplete']

/**
 * The one check an entry's card shows: its most severe non-ok `budget_entry` check (`installment`
 * is left out), the earliest on a tie, plus how many other warnings it has. Null when there are none.
 */
export function entryCreditWarning(checks: readonly CreditCheck[], entryId: number): EntryCreditWarning | null {
  const mine = checks.filter(
    (c) => c.source === 'budget_entry' && c.source_id === entryId && WARNING_SEVERITY.includes(c.status),
  )
  const [first] = [...mine].sort((a, b) => {
    const bySeverity = WARNING_SEVERITY.indexOf(a.status) - WARNING_SEVERITY.indexOf(b.status)
    return bySeverity !== 0 ? bySeverity : (a.occurrence_date ?? a.date).localeCompare(b.occurrence_date ?? b.date)
  })
  if (!first) return null
  const more = mine.filter((c) => c !== first && COUNTED_WARNINGS.includes(c.status)).length
  return { check: first, more }
}

/**
 * Whether a card has a credit limit to report on: its own, or the one it shares. A card the
 * caller can't see the link of (an editor or viewer) reads as having none, as today.
 */
export function hasCreditLimit(account: Pick<Account, 'credit_limit' | 'shares_limit_with_account_id'>): boolean {
  return account.credit_limit != null || account.shares_limit_with_account_id != null
}

/** "BDO Amex", "BDO Amex and BDO Visa", "A, B and C". */
export function joinNames(names: readonly string[]): string {
  if (names.length <= 1) return names.join('')
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`
}

/**
 * The line a card with a shared limit shows, e.g. "Shared ₱480,000 limit with BDO Amex".
 * Null when the card shares its limit with none.
 */
export function sharedLimitText(credit: Pick<CardCredit, 'currency' | 'limit' | 'shared_with'>): string | null {
  if (credit.shared_with.length === 0) return null
  return `Shared ${formatCurrency(credit.limit, credit.currency)} limit with ${joinNames(credit.shared_with.map((c) => c.name))}`
}

/**
 * The cards a card may share its limit with: active credit cards in the same currency that
 * have a limit of their own, are not linked themselves, are not the card itself, and that the
 * caller manages and the same person owns. `ownerName` is the card's owner for an edit; null
 * on create, where the caller owns it and so only the caller's own cards qualify.
 */
export function sharedLimitTargets<
  T extends Pick<Account, 'id' | 'account_type' | 'currency' | 'is_active' | 'credit_limit' | 'shares_limit_with_account_id' | 'my_role' | 'owner_name'> & {
    permissions: Pick<Account['permissions'], 'can_edit_settings'>
  },
>(accounts: readonly T[], card: { id: number | null; currency: string; ownerName: string | null }): T[] {
  return accounts.filter(
    (a) =>
      a.account_type === 'credit' &&
      a.is_active === true &&
      a.currency === card.currency &&
      a.credit_limit != null &&
      a.shares_limit_with_account_id == null &&
      a.id !== card.id &&
      a.permissions.can_edit_settings &&
      (card.ownerName === null ? a.my_role === 'owner' : a.owner_name === card.ownerName),
  )
}
