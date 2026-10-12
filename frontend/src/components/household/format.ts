import type { CurrencyCode } from '../../utils/currency'
import { formatCurrency } from '../../utils/currency'

/** A calendar date (YYYY-MM-DD, or an ISO datetime) shown without a timezone shift. */
export const formatDay = (value: string): string => {
  const [year, month, day] = value.slice(0, 10).split('-').map(Number)
  return new Date(year ?? 1970, (month ?? 1) - 1, day ?? 1).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  })
}

/** `2026-10` as "October 2026". */
export const formatMonth = (value: string): string => {
  const [year, month] = value.split('-').map(Number)
  return new Date(year ?? 1970, (month ?? 1) - 1, 1).toLocaleDateString('en-US', { month: 'long', year: 'numeric' })
}

/** An amount in its own currency; the Household view never adds or converts across currencies. */
export const money = (amount: number, currency: string): string => formatCurrency(amount, currency as CurrencyCode)

/** The current month as YYYY-MM, in local time. */
export const thisMonth = (): string => {
  const now = new Date()
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`
}

/** `month` shifted by `delta` months, as YYYY-MM. */
export const shiftMonth = (month: string, delta: number): string => {
  const [year, mon] = month.split('-').map(Number)
  const date = new Date(year ?? 1970, (mon ?? 1) - 1 + delta, 1)
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`
}
