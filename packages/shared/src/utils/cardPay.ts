import type { Account, CardPaymentInput, MinimumDue, StatementDue } from '../types/api'

/** Shown in the amount field's place when the latest closed statement is already cleared. */
export const NOTHING_DUE_NOTE = 'Nothing due on your latest statement; a payment now goes to your next statement.'

const MANILA_OFFSET_MS = 8 * 60 * 60 * 1000

/**
 * Manila's calendar day (`YYYY-MM-DD`) at `now`, the day the server uses for card payments
 * (closed statements, posted versus planned). Manila is a fixed UTC+8 with no daylight
 * saving, so it is the UTC day of `now + 8 h`, whatever the browser's own time zone.
 */
export function manilaToday(now: Date = new Date()): string {
  return new Date(now.getTime() + MANILA_OFFSET_MS).toISOString().slice(0, 10)
}

export interface PayChoices {
  /** L: the latest statement closed before today, the one coming due next. */
  statement: StatementDue
  /** What clears L given oldest-first settlement; the prefilled default. */
  full: number
  /** L is already cleared: leave the amount field empty and show `NOTHING_DUE_NOTE`. */
  cleared: boolean
  /** Null when `minimumReason` says why. Cumulative, so it carries earlier unpaid minimums. */
  minimum: { amount: number; source: 'statement' | 'estimate' } | null
  minimumReason: 'no_rule' | 'paid' | 'unavailable' | null
  /** Foreign charges with no rate may have left `full` low. */
  incomplete: boolean
  /** How much of the entered amount is above `full` and pays the next statement. */
  excess: number
}

function cents(value: number): number {
  return Math.round(value * 100) / 100
}

function minimumChoice(minimum: MinimumDue): Pick<PayChoices, 'minimum' | 'minimumReason'> {
  if (minimum.source === 'unavailable' || minimum.amount === null || minimum.remaining === null) {
    return { minimum: null, minimumReason: minimum.reason ?? 'unavailable' }
  }
  if (minimum.remaining <= 0) return { minimum: null, minimumReason: 'paid' }
  return { minimum: { amount: minimum.remaining, source: minimum.source }, minimumReason: null }
}

/**
 * What the Pay dialog suggests. L is the latest statement closed before `today` (a
 * statement closing today can still take charges). Null when there is none. `amount` is
 * what the owner typed, to work out the `excess` over Full.
 */
export function payChoices(
  statements: readonly StatementDue[],
  today: string,
  amount?: number,
): PayChoices | null {
  let latest: StatementDue | null = null
  for (const s of statements) {
    if (s.close_date < today && (latest === null || s.close_date > latest.close_date)) latest = s
  }
  if (latest === null) return null
  const full = cents(latest.clear_through)
  return {
    statement: latest,
    full,
    cleared: full <= 0,
    ...minimumChoice(latest.minimum_due),
    incomplete: latest.incomplete,
    excess: amount !== undefined && amount > full ? cents(amount - full) : 0,
  }
}

/**
 * The accounts a card can be paid from: same currency, the caller can add transactions,
 * active, and not a credit card or loan (and not the card itself).
 */
export function cardPayers(accounts: readonly Account[], card: Pick<Account, 'id' | 'currency'>): Account[] {
  return accounts.filter(
    (a) =>
      a.id !== card.id &&
      a.currency === card.currency &&
      a.permissions.can_add_transactions &&
      a.is_active !== false &&
      a.account_type !== 'credit' &&
      a.account_type !== 'loan',
  )
}

/** A payment dated after today is planned: pending until its day. Both are `YYYY-MM-DD`. */
export function isPlannedPayment(paymentDate: string, today: string): boolean {
  return paymentDate > today
}

/** The POST /cards/{id}/payments body; `payment_date` stays a `YYYY-MM-DD` day. */
export function cardPaymentBody(input: {
  amount: number
  fromAccountId: number
  paymentDate: string
  description?: string
}): CardPaymentInput {
  const description = input.description?.trim()
  return {
    amount: cents(input.amount),
    from_account_id: input.fromAccountId,
    payment_date: input.paymentDate.slice(0, 10),
    ...(description ? { description } : {}),
  }
}
