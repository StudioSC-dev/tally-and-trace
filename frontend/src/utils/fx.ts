import { CURRENCY_CONFIGS, formatCurrency } from './currency'
import type { CurrencyCode } from './currency'
import type { Estimate, FxMeta } from '@tally-trace/shared'

/** A figure written with its currency code ("USD 80.00"), the form an estimate uses. */
export const formatCoded = (amount: number, currency: CurrencyCode): string => {
  const decimals = CURRENCY_CONFIGS[currency]?.decimalPlaces ?? 2
  const number = amount.toLocaleString('en-US', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
    useGrouping: true,
  })
  return `${currency} ${number}`
}

/** The labels of a converted or unconverted full row (all absent when it needed no conversion). */
export type EstimateLabels = Partial<Estimate>

/**
 * A figure in `currency`, as the row shows it. A converted row reads "≈ PHP 4,640.00
 * (USD 80.00)": the estimate first, the row's own figure in brackets. An unconverted row
 * has no estimate to show, so it reads its own figure and says it is not counted.
 */
export const estimateText = (amount: number | null, currency: CurrencyCode, labels: EstimateLabels): string => {
  // The API leaves the original figure out (or null) when a statement mixes currencies.
  const original =
    labels.original_amount != null && labels.original_currency != null
      ? formatCoded(labels.original_amount, labels.original_currency)
      : null
  if (labels.unconverted && original !== null) return `${original} (no rate yet)`
  if (amount === null) return '—'
  if (labels.estimated) {
    return original !== null ? `≈ ${formatCoded(amount, currency)} (${original})` : `≈ ${formatCoded(amount, currency)}`
  }
  return formatCurrency(amount, currency)
}

/** Hover text for an estimate: the rate, the day it is for and whether it is stale. */
export const estimateTitle = (labels: EstimateLabels): string | undefined => {
  if (!labels.estimated || labels.rate == null || labels.original_currency == null) return undefined
  const stale = labels.rate_stale ? ' (more than a day old)' : ''
  return `Estimated at ${labels.rate} per ${labels.original_currency}${labels.rate_as_of ? `, rate for ${labels.rate_as_of}` : ''}${stale}`
}

/** "Rates: currency-api" (the provider ids of the pairs used), or null when none were used. */
export const fxAttribution = (fx: FxMeta | undefined): string | null => {
  if (!fx || fx.rates.length === 0) return null
  const sources = Array.from(new Set(fx.rates.map((rate) => rate.source)))
  const asOf = fx.rates.map((rate) => rate.as_of).sort().pop()
  const stale = fx.rates.some((rate) => rate.stale)
  return `Rates: ${sources.join(', ')}${asOf ? ` · as of ${asOf}` : ''}${stale ? ' · some rates are more than a day old' : ''}`
}
