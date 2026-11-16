import { INSTALLMENT_MONTH_PICKS, formatEntryDate } from '@tally-trace/shared'

/** An Installment field that shows its error under it. */
export type InstallmentField = 'installment_total' | 'installment_months'
const installmentErrorId = (key: InstallmentField) => `transaction-${key}-error`

/** What the preview shows: the payments a save would record, and their days. */
export interface InstallmentPreview {
  /** The first payment and each later one but the last, formatted with the currency. */
  first: string
  monthly: string
  /** The last payment when it differs from `monthly` (the rounding difference), else null. */
  last: string | null
  months: number
  /** Every payment day (`YYYY-MM-DD`), first to last. */
  days: string[]
  /** The card has a statement cycle: the payments fall on its closes. */
  onClose: boolean
}

interface InstallmentSectionProps {
  active: boolean
  onToggle: (on: boolean) => void
  total: string
  months: string
  onTotalChange: (value: string) => void
  onMonthsChange: (value: string) => void
  /** The currency symbol the total is typed in. */
  symbol: string
  errors: Partial<Record<InstallmentField, string>>
  /** A refusal that belongs to neither field. */
  error: string | null
  preview: InstallmentPreview | null
}

/**
 * Add Transaction's Installment option for an expense on a credit card (STU-631): the
 * purchase total and the number of months, split into the first payment (this transaction)
 * and a card installment for the rest, whose last payment absorbs any rounding difference
 * (STU-658).
 */
export function InstallmentSection({
  active, onToggle, total, months, onTotalChange, onMonthsChange, symbol, errors, error, preview,
}: InstallmentSectionProps) {
  // The payments after the first at the monthly amount (the last is shown on its own when it differs).
  const monthlyCount = preview ? preview.months - 1 - (preview.last !== null ? 1 : 0) : 0
  const describedBy = (key: InstallmentField) => (errors[key] ? { 'aria-invalid': true, 'aria-describedby': installmentErrorId(key) } : {})
  const fieldError = (key: InstallmentField) =>
    errors[key] ? (
      <p id={installmentErrorId(key)} className="mt-1 text-xs text-danger" role="alert" data-testid={`field-error-${key}`}>
        {errors[key]}
      </p>
    ) : null

  return (
    <div className="space-y-3" data-testid="installment-section">
      <label className="inline-flex min-h-11 items-center gap-2 text-sm text-body cursor-pointer">
        <input
          type="checkbox"
          className="h-5 w-5 border-line text-ink"
          checked={active}
          onChange={(e) => onToggle(e.target.checked)}
          aria-describedby="installment-help"
          data-testid="installment-toggle"
        />
        <span>Installment</span>
      </label>
      <p id="installment-help" className="-mt-2 text-xs text-muted">
        Enter the purchase total and the number of months; the monthly payments are worked out for you.
      </p>
      {active && (
        <fieldset className="min-w-0 space-y-4 border-l-2 border-line pl-3" data-testid="installment-fields">
          <legend className="sr-only">Installment</legend>
          <div>
            <label className="label" htmlFor="installment-total">Purchase total</label>
            <div className="relative">
              <span className="absolute inset-y-0 left-0 pl-3 flex items-center text-muted text-sm">{symbol}</span>
              <input
                id="installment-total"
                type="text"
                inputMode="decimal"
                autoComplete="off"
                value={total}
                onChange={(e) => onTotalChange(e.target.value)}
                className="input-field min-h-11 pl-7 focus-ring"
                placeholder="0.00"
                data-field="installment_total"
                {...describedBy('installment_total')}
              />
            </div>
            {fieldError('installment_total')}
          </div>
          <div>
            <label className="label" htmlFor="installment-months" id="installment-months-label">Months</label>
            <div className="mb-2 flex flex-wrap gap-2" role="group" aria-labelledby="installment-months-label">
              {INSTALLMENT_MONTH_PICKS.map((count) => {
                const selected = months.trim() === String(count)
                return (
                  <button
                    key={count}
                    type="button"
                    onClick={() => onMonthsChange(String(count))}
                    aria-pressed={selected}
                    className={`min-h-11 min-w-11 rounded-full px-3 py-1.5 text-sm font-medium transition ${selected ? 'bg-ink text-paper' : 'bg-sunken text-body hover:bg-sunken'}`}
                    data-testid={`installment-months-${count}`}
                  >
                    {count}
                  </button>
                )
              })}
            </div>
            <input
              id="installment-months"
              type="text"
              inputMode="numeric"
              autoComplete="off"
              value={months}
              onChange={(e) => onMonthsChange(e.target.value)}
              className="input-field min-h-11 focus-ring"
              placeholder="Or type a number of months"
              data-field="installment_months"
              {...describedBy('installment_months')}
            />
            {fieldError('installment_months')}
          </div>
          {preview && (
            <div className="bg-sunken p-3 text-xs text-body space-y-1" data-testid="installment-preview">
              <p data-testid="installment-preview-first">
                First payment {preview.first} on {formatEntryDate(preview.days[0])}
              </p>
              {monthlyCount > 0 && (
                <p data-testid="installment-preview-rest">
                  Then {preview.monthly} a month for {monthlyCount} {monthlyCount === 1 ? 'month' : 'months'},{' '}
                  {monthlyCount > 1
                    ? `${formatEntryDate(preview.days[1])} to ${formatEntryDate(preview.days[monthlyCount])}`
                    : formatEntryDate(preview.days[1])}
                </p>
              )}
              {preview.last !== null && (
                <p data-testid="installment-preview-last">
                  Last payment {preview.last} on {formatEntryDate(preview.days[preview.days.length - 1])}
                </p>
              )}
              <p className="text-muted" data-testid="installment-preview-dates">
                {preview.onClose ? 'On the statement closes: ' : 'Payment dates: '}
                {preview.days.map((day) => formatEntryDate(day)).join(', ')}
              </p>
            </div>
          )}
          {error && (
            <p className="text-sm text-danger" role="alert" data-testid="installment-error">{error}</p>
          )}
        </fieldset>
      )}
    </div>
  )
}
