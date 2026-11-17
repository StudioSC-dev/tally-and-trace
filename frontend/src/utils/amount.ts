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

/** True when currency text shows no non-zero digit (the symbols have none), so the amount rounds to zero. */
const readsZero = (text: string): boolean => !/[1-9]/.test(text)

/**
 * Any amount that can fall below zero, as text: the one shared formatter for signed amounts in the web app. A negative
 * amount leads with a minus sign (U+2212) before the symbol, `−₱1,234.56`, never a hyphen. Zero is never signed: a
 * computed `-0` and an amount that rounds to zero in the currency's smallest unit (`-0.004` pesos) read `₱0.00`.
 */
export function formatSigned(amount: number, currency: CurrencyCode): string {
  const magnitude = formatCurrency(Math.abs(amount), currency)
  return amount < 0 && !readsZero(magnitude) ? `−${magnitude}` : magnitude
}

/**
 * `amount` as currency text for `kind`: `+` before money in, a minus sign (U+2212) before a negative, nothing before
 * money out (which `formatSigned` writes, so a negative one still reads `−₱`). Zero is never signed.
 */
export function formatAmount(kind: AmountKind, amount: number, currency: CurrencyCode): string {
  if (kind === 'out') return formatSigned(amount, currency)
  const magnitude = formatCurrency(Math.abs(amount), currency)
  if (readsZero(magnitude)) return magnitude
  return `${kind === 'in' ? '+' : '−'}${magnitude}`
}

/** The class for an account balance: ledger ink, or the red pencil when it is below zero. */
export const balanceClass = (balance: number): string => amountClass(balance < 0 ? 'negative' : 'out')

/** An account balance as text: a negative one leads with a minus sign, any other (zero included) is plain currency. */
export const formatBalance = (balance: number, currency: CurrencyCode): string => formatSigned(balance, currency)
