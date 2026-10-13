import type { CurrencyCode } from '../utils/currency'

interface Props {
  currencies: CurrencyCode[] | undefined
  value: CurrencyCode
  onChange: (currency: CurrencyCode) => void
}

/** A segmented control over the currencies a projection holds; hidden when there is only one. */
export function CurrencyControl({ currencies, value, onChange }: Props) {
  if (!currencies || currencies.length <= 1) return null
  return (
    <div className="flex space-x-1 bg-sunken p-1 self-start" role="group" aria-label="Currency" data-testid="currency-control">
      {currencies.map((currency) => (
        <button
          key={currency}
          type="button"
          aria-pressed={value === currency}
          onClick={() => onChange(currency)}
          className={`px-4 py-1.5 text-sm font-medium transition-colors duration-200 ${ value === currency ? 'bg-surface text-ink' : 'text-body hover:text-ink' }`}
        >
          {currency}
        </button>
      ))}
    </div>
  )
}
