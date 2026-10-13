import { formatCurrency } from '@tally-trace/shared'
import type { CurrencyCode, FxMeta, UpcomingItem } from '@tally-trace/shared'

export interface CurrencyTotal {
  currency: CurrencyCode
  total: number
}

/** Sums balances per account currency, in order of first appearance. Never adds across currencies. */
export function totalsByCurrency(accounts: ReadonlyArray<{ currency: string; balance: number }>): CurrencyTotal[] {
  const totals = new Map<CurrencyCode, number>()
  for (const account of accounts) {
    const currency = account.currency as CurrencyCode
    totals.set(currency, (totals.get(currency) ?? 0) + account.balance)
  }
  return Array.from(totals, ([currency, total]) => ({ currency, total }))
}

export interface FullItemAmountLabel {
  /** Null for an unconverted item: it has no figure to show, never 0. */
  primary: string | null
  /** "(USD 14.99)": the item's own figure, when `primary` is an estimate. */
  original: string | null
}

/**
 * How a full upcoming item shows its amount: in its own `currency`, with "≈" and the
 * original figure when the amount is an estimate at a stored rate.
 */
export function fullItemAmountLabel(item: UpcomingItem, fallback: CurrencyCode): FullItemAmountLabel {
  if (item.unconverted || item.amount === null) return { primary: null, original: null }
  const currency = item.currency ?? fallback
  const primary = formatCurrency(item.amount, currency)
  if (item.estimated && item.original_amount !== undefined && item.original_currency) {
    return {
      primary: `≈ ${primary}`,
      original: `(${item.original_currency} ${item.original_amount.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })})`,
    }
  }
  return { primary, original: null }
}

/** "Rates: currency-api", or null when no stored rate was used. */
export function ratesAttribution(fx: FxMeta | undefined): string | null {
  if (!fx || fx.rates.length === 0) return null
  const sources = Array.from(new Set(fx.rates.map((r) => r.source)))
  return `Rates: ${sources.join(', ')}`
}

/**
 * A transfer whose two accounts are in different currencies. Falls back to a stored
 * `received_amount` when the destination account is not in `accounts`.
 */
export function isCrossCurrencyTransfer(
  tx: { transaction_type: string; account_id: number; transfer_to_account_id?: number; received_amount?: number | null },
  accounts: ReadonlyArray<{ id: number; currency: string }>,
): boolean {
  if (tx.transaction_type !== 'transfer') return false
  const from = accounts.find((a) => a.id === tx.account_id)
  const to = tx.transfer_to_account_id === undefined ? undefined : accounts.find((a) => a.id === tx.transfer_to_account_id)
  if (from && to) return from.currency !== to.currency
  return tx.received_amount != null
}
