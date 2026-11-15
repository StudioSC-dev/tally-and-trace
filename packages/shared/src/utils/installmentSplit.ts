/**
 * A card purchase recorded as an installment from its total and number of months (STU-631).
 *
 * Money is counted in whole centavos, so the split is exact: every payment after the
 * first is the total ÷ months rounded down to centavos, and the first carries what that
 * leaves over. The first payment is the transaction recorded now (a saved row with its own
 * amount); the others are the installment entry's one amount (`repeat.amount`).
 */

/** The most months an installment runs: the API's `max_occurrences` limit. */
export const INSTALLMENT_MAX_MONTHS = 360

/** The month counts offered as quick picks. */
export const INSTALLMENT_MONTH_PICKS: readonly number[] = [3, 6, 12, 24]

export interface InstallmentSplit {
  months: number
  /** The first payment, in centavos: the monthly amount plus the remainder. */
  first: number
  /** Each payment after the first, in centavos. */
  rest: number
  /** Every payment in order, in centavos; they sum to the total. */
  payments: number[]
}

/**
 * `totalCentavos` split into `months` payments: all but the first are the total ÷ months
 * rounded down to centavos, and the remainder goes on the first. Both arguments must be
 * positive integers.
 */
export function splitInstallment(totalCentavos: number, months: number): InstallmentSplit {
  if (!Number.isSafeInteger(totalCentavos) || totalCentavos <= 0) throw new RangeError('The total must be a positive whole number of centavos')
  if (!Number.isSafeInteger(months) || months <= 0) throw new RangeError('The months must be a positive whole number')
  const rest = Math.floor(totalCentavos / months)
  const first = totalCentavos - rest * (months - 1)
  return { months, first, rest, payments: [first, ...Array.from({ length: months - 1 }, () => rest)] }
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
 * then the months, then a total too small to give every payment at least one centavo.
 */
export function installmentInput(totalText: string, monthsText: string): InstallmentInput {
  const total = parseInstallmentTotal(totalText)
  if (!total.ok) return { ok: false, field: 'installment_total', message: total.message }
  const months = parseInstallmentMonths(monthsText)
  if (!months.ok) return { ok: false, field: 'installment_months', message: months.message }
  if (total.value < months.value) {
    return { ok: false, field: 'installment_total', message: `The purchase total is too small to split into ${months.value} payments.` }
  }
  return { ok: true, split: splitInstallment(total.value, months.value) }
}
