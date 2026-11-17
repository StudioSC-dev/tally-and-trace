import type { CurrencyCode } from '../utils/currency'
import { SegmentedControl } from './SegmentedControl'

interface Props {
  currencies: CurrencyCode[] | undefined
  value: CurrencyCode
  onChange: (currency: CurrencyCode) => void
}

/** A segmented control over the currencies a projection holds; hidden when there is only one. */
export function CurrencyControl({ currencies, value, onChange }: Props) {
  if (!currencies || currencies.length <= 1) return null
  return (
    <SegmentedControl
      className="flex space-x-1 bg-sunken p-1 self-start"
      aria-label="Currency"
      data-testid="currency-control"
      options={currencies.map((currency) => ({ value: currency, label: currency }))}
      value={value}
      onChange={onChange}
      segmentClassName="px-4 py-1.5 text-sm"
    />
  )
}
