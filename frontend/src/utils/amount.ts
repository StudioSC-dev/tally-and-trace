import { formatCurrency } from './currency'
import type { CurrencyCode } from './currency'

/**
 * What an amount means, which decides its colour (docs/design-system.md): money out is ledger ink, money in is `ok`
 * with a leading `+`, and a negative balance is `danger` with a leading minus sign.
 */
export type AmountKind = 'out' | 'in' | 'negative'

const CLASSES: Record<AmountKind, string> = {
  out: 'amount-out',
  in: 'amount-in',
  negative: 'amount-negative',
}

/** The semantic class for `kind`; call sites use this instead of choosing a colour. */
export const amountClass = (kind: AmountKind): string => CLASSES[kind]

/** `amount` as currency text for `kind`: `+` before money in, a minus sign (U+2212) before a negative, nothing before money out. */
export function formatAmount(kind: AmountKind, amount: number, currency: CurrencyCode): string {
  if (kind === 'in') return `+${formatCurrency(Math.abs(amount), currency)}`
  if (kind === 'negative') return `−${formatCurrency(Math.abs(amount), currency)}`
  return formatCurrency(amount, currency)
}

/** The class for an account balance: ledger ink, or the red pencil when it is below zero. */
export const balanceClass = (balance: number): string => amountClass(balance < 0 ? 'negative' : 'out')

/** An account balance as text: a negative one leads with a minus sign, any other is plain currency. */
export const formatBalance = (balance: number, currency: CurrencyCode): string =>
  formatAmount(balance < 0 ? 'negative' : 'out', balance, currency)
