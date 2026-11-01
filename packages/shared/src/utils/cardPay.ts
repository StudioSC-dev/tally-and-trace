import type { Account, CardCreditDetail, CardPaymentInput, MinimumDue, StatementDue } from '../types/api'
import { formatEntryDate } from './entryDate'

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

/** A posting date's Manila calendar day (YYYY-MM-DD), or null if unparseable. */
export function postingDay(wire: string): string | null {
  const instant = new Date(wire)
  return Number.isNaN(instant.getTime()) ? null : manilaToday(instant)
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

/** Installment months a card has on closed cycles but not posted: how many, and how many Post now would record. */
export function unpostedCounts(detail: Pick<CardCreditDetail, 'unposted'>): { count: number; postable: number } {
  const { unposted } = detail
  return unposted === null ? { count: 0, postable: 0 } : { count: unposted.count, postable: unposted.postable }
}

const monthsOf = (n: number): string => `${n} installment ${n === 1 ? 'month' : 'months'}`

/**
 * What the Pay dialog says when Full leaves installment months out: `text` always, and
 * `review` for the months Post now cannot record. Null when there are none.
 */
export function unpostedNote(count: number, postable: number): { text: string; review: string | null } | null {
  if (count <= 0) return null
  const needReview = count - postable
  return {
    text: `Full leaves out ${monthsOf(count)} not yet posted`,
    review:
      needReview > 0
        ? `${needReview} of them ${needReview === 1 ? 'needs' : 'need'} Review or Mark paid in Due and overdue`
        : null,
  }
}

/**
 * The account page's card block for unposted installment months, shown even when the card
 * has no recorded statement. `action` is `post` when Post now can record some, otherwise `review`.
 */
export function creditPanelUnposted(
  detail: Pick<CardCreditDetail, 'unposted'>,
): { text: string; action: 'post' | 'review' } | null {
  const { unposted } = detail
  if (unposted === null) return null
  return {
    text:
      `${monthsOf(unposted.count)} not yet posted · ` +
      `oldest closed ${formatEntryDate(unposted.oldest_close)}, due ${formatEntryDate(unposted.oldest_due)}`,
    action: unposted.postable > 0 ? 'post' : 'review',
  }
}

/**
 * Why Pay is disabled; null when it is enabled. `choices` is `payChoices(detail.statements, today)`
 * and `unposted` is `unpostedCounts(detail)`. With no closed statement to pay, unposted months
 * are the first thing to deal with.
 */
export function payDisabledReason(input: {
  isActive: boolean
  choices: PayChoices | null
  unposted: { count: number; postable: number }
}): string | null {
  if (!input.isActive) return 'This card is inactive'
  if (input.choices !== null) return null
  if (input.unposted.postable > 0) return 'Post the installment months first'
  if (input.unposted.count > 0) return 'Review or Mark paid the installment months in Due and overdue first'
  return 'No closed statement yet'
}
