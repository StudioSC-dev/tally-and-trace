import type { CurrencyCode } from '../utils/currency'
import { SegmentedControl } from './SegmentedControl'

interface Props {
  currencies: CurrencyCode[] | undefined
  value: CurrencyCode
  onChange: (currency: CurrencyCode) => void
  /** Layout classes for each segment; the dashboard header narrows them on a phone. */
  segmentClassName?: string
  /**
   * On a phone, more than two currencies show as one bounded select instead of segments, which would not fit
   * the row (the dashboard header). From `sm` up, and with two currencies, the segments stay.
   */
  compactOnPhone?: boolean
}

/** Segments that still fit a phone row beside the dashboard's tag filter and period group. */
const PHONE_SEGMENTS = 2

/** A segmented control over the currencies a projection holds; hidden when there is only one. */
export function CurrencyControl({ currencies, value, onChange, segmentClassName = 'px-4 py-1.5 text-sm', compactOnPhone = false }: Props) {
  if (!currencies || currencies.length <= 1) return null
  const asSelect = compactOnPhone && currencies.length > PHONE_SEGMENTS
  return (
    <>
      {asSelect && (
        <select
          aria-label="Currency"
          data-testid="currency-select"
          value={value}
          onChange={(e) => {
            const next = currencies.find((currency) => currency === e.target.value)
            if (next) onChange(next)
          }}
          className="select-field focus-ring w-auto shrink-0 sm:hidden"
        >
          {currencies.map((currency) => (
            <option key={currency} value={currency}>
              {currency}
            </option>
          ))}
        </select>
      )}
      <SegmentedControl
        className={`${asSelect ? 'hidden sm:flex' : 'flex'} space-x-1 bg-sunken p-1 self-start`}
        aria-label="Currency"
        data-testid="currency-control"
        options={currencies.map((currency) => ({ value: currency, label: currency }))}
        value={value}
        onChange={onChange}
        segmentClassName={segmentClassName}
      />
    </>
  )
}
