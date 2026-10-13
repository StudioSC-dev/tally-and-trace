import { useState } from 'react'
import type { CurrencyCode } from '../utils/currency'

/**
 * The currency a projection is read in. Defaults to `currencies[0]` (the user's default
 * currency, or the first one they hold when it holds nothing); a choice that stops being
 * on offer falls back to it.
 */
export function useSelectedCurrency(
  currencies: CurrencyCode[] | undefined,
  fallback: CurrencyCode,
): [CurrencyCode, (currency: CurrencyCode) => void] {
  const [choice, setChoice] = useState<CurrencyCode | null>(null)
  const offered = currencies ?? []
  const selected = choice !== null && offered.includes(choice) ? choice : offered[0] ?? fallback
  return [selected, setChoice]
}
