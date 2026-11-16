/**
 * A card purchase recorded as an installment from its total and number of months (STU-631,
 * STU-658).
 *
 * Money is counted in whole centavos, so the split is exact. It follows the banks' stated
 * rule (Metrobank, HSBC): the monthly amount is the total ÷ months rounded half-up to the
 * centavo, and the last payment absorbs the rounding difference, so it can be higher or
 * lower. The first payment is the transaction recorded now (a saved row with its own
 * amount); the others are the installment entry's `amount` (`repeat.amount`), its last one
 * `final_amount` (`repeat.final_amount`).
 */

/** The most months an installment runs: the API's `max_occurrences` limit. */
export const INSTALLMENT_MAX_MONTHS = 360

/** The month counts offered as quick picks. */
export const INSTALLMENT_MONTH_PICKS: readonly number[] = [3, 6, 12, 24]

export interface InstallmentSplit {
  months: number
  /** The first payment, in centavos: the monthly amount (the total when there is one month). */
  first: number
  /** Each payment but the last, in centavos: the total ÷ months rounded half-up. */
  monthly: number
  /** The last payment, in centavos: the total less every other payment. */
  last: number
  /** Every payment in order, in centavos; they sum to the total. */
  payments: number[]
}

/**
 * The split of `totalCentavos` into `months` payments, or null when a payment would not be
 * positive (a total too small for that many months, e.g. 0.01 over 2). Both arguments must
 * be positive integers.
 */
export function trySplitInstallment(totalCentavos: number, months: number): InstallmentSplit | null {
  if (!Number.isSafeInteger(totalCentavos) || totalCentavos <= 0) throw new RangeError('The total must be a positive whole number of centavos')
  if (!Number.isSafeInteger(months) || months <= 0) throw new RangeError('The months must be a positive whole number')
  const floor = Math.floor(totalCentavos / months)
  // Half-up on exact integers: the remainder is at least half of `months`.
  const monthly = 2 * (totalCentavos - floor * months) >= months ? floor + 1 : floor
  const last = totalCentavos - monthly * (months - 1)
  if (monthly <= 0 || last <= 0) return null
  const payments = [...Array.from({ length: months - 1 }, () => monthly), last]
  return { months, first: payments[0], monthly, last, payments }
}

/**
 * `totalCentavos` split into `months` payments: each but the last is the total ÷ months
 * rounded half-up to centavos, and the last is what that leaves. Both arguments must be
 * positive integers, and every payment must come out positive (a RangeError otherwise).
 */
export function splitInstallment(totalCentavos: number, months: number): InstallmentSplit {
  const split = trySplitInstallment(totalCentavos, months)
  if (split === null) throw new RangeError('The total is too small to split into that many payments')
  return split
}

/** Centavos as the amount the API takes (two decimal places). */
export const centavosToAmount = (centavos: number): number => Number((centavos / 100).toFixed(2))

export type InstallmentParse = { ok: true; value: number } | { ok: false; message: string }

/**
 * The purchase total typed, in centavos: a positive number with at most two decimal
 * places. Thousands separators (commas) and surrounding spaces are allowed.
 */
export function parseInstallmentTotal(text: string): InstallmentParse {
  const typed = text.trim().replace(/,/g, '')
  if (typed === '') return { ok: false, message: 'Please enter the purchase total.' }
  if (!/^-?(\d+\.?\d*|\.\d+)$/.test(typed)) return { ok: false, message: 'Please enter the purchase total as a number.' }
  if (typed.startsWith('-') || !/[1-9]/.test(typed)) return { ok: false, message: 'The purchase total must be more than zero.' }
  const [whole, fraction = ''] = typed.split('.')
  if (fraction.length > 2) return { ok: false, message: 'The purchase total can have at most two decimal places (centavos).' }
  const centavos = Number(whole || '0') * 100 + Number(fraction.padEnd(2, '0'))
  if (!Number.isSafeInteger(centavos)) return { ok: false, message: 'The purchase total is too large.' }
  return { ok: true, value: centavos }
}

/** The number of months typed: a whole number from 1 to `INSTALLMENT_MAX_MONTHS`. */
export function parseInstallmentMonths(text: string): InstallmentParse {
  const typed = text.trim()
  if (typed === '') return { ok: false, message: 'Please enter the number of months.' }
  if (!/^-?(\d+\.?\d*|\.\d+)$/.test(typed)) return { ok: false, message: 'Please enter the number of months as a number.' }
  if (typed.startsWith('-') || !/[1-9]/.test(typed)) return { ok: false, message: 'The number of months must be more than zero.' }
  if (!/^\d+$/.test(typed)) return { ok: false, message: 'The number of months must be a whole number.' }
  const months = Number(typed)
  if (months > INSTALLMENT_MAX_MONTHS) return { ok: false, message: `The number of months can be at most ${INSTALLMENT_MAX_MONTHS}.` }
  return { ok: true, value: months }
}

export type InstallmentInput =
  | { ok: true; split: InstallmentSplit }
  | { ok: false; field: 'installment_total' | 'installment_months'; message: string }

/**
 * The split a save sends, or the field and message it is refused with: the total first,
 * then the months, then a total too small to give every payment, the last included, at
 * least one centavo.
 */
export function installmentInput(totalText: string, monthsText: string): InstallmentInput {
  const total = parseInstallmentTotal(totalText)
  if (!total.ok) return { ok: false, field: 'installment_total', message: total.message }
  const months = parseInstallmentMonths(monthsText)
  if (!months.ok) return { ok: false, field: 'installment_months', message: months.message }
  const split = trySplitInstallment(total.value, months.value)
  if (split === null) {
    return { ok: false, field: 'installment_total', message: `The purchase total is too small to split into ${months.value} payments.` }
  }
  return { ok: true, split }
}
