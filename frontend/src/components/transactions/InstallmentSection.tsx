import { useRef, useState } from 'react'
import { INSTALLMENT_MONTH_PICKS, formatEntryDate, parseInstallmentMonths, parseInstallmentTotal } from '@tally-trace/shared'

import { installmentErrorId, installmentErrorProps } from './installmentField'
import type { InstallmentField } from './installmentField'

/** An Installment field's error, shown under its field (the total's is shown on the Amount box). */
export function InstallmentFieldError({ field, message }: { field: InstallmentField; message: string | undefined }) {
  return message ? (
    <p id={installmentErrorId(field)} className="mt-1 text-xs text-danger" role="alert" data-testid={`field-error-${field}`}>
      {message}
    </p>
  ) : null
}

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
  onMonthsChange: (value: string) => void
  errors: Partial<Record<InstallmentField, string>>
  /** A refusal that belongs to neither field. */
  error: string | null
  preview: InstallmentPreview | null
}

/**
 * Add Transaction's Installment option for an expense on a credit card (STU-631): the
 * number of months (the purchase total is the form's Amount box, STU-656), split into the first payment (this transaction)
 * and a card installment for the rest, whose last payment absorbs any rounding difference
 * (STU-658).
 */
export function InstallmentSection({
  active, onToggle, total, months, onMonthsChange, errors, error, preview,
}: InstallmentSectionProps) {
  // Changing opens the month picks again; a custom count being typed keeps them open (a count
  // such as 12 is valid at "1").
  const [changing, setChanging] = useState(false)
  const [typing, setTyping] = useState(false)
  // A press inside the section (a pick): the custom box's blur it causes must not fold the
  // section before the press is a tap. Safari gives the blur no `relatedTarget`, so the press is noted instead.
  const pressInside = useRef(false)
  // The payments after the first at the monthly amount (the last is shown on its own when it differs).
  const monthlyCount = preview ? preview.months - 1 - (preview.last !== null ? 1 : 0) : 0
  const monthsChosen = parseInstallmentMonths(months)
  // An error that applies to the months, or a total too small for them, is never hidden.
  const errorOpen = Boolean(errors.installment_months) || (Boolean(errors.installment_total) && parseInstallmentTotal(total).ok)
  const collapsed = active && monthsChosen.ok && !changing && !typing && !errorOpen
  const describedBy = (key: InstallmentField) => installmentErrorProps(key, errors[key])

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
        <fieldset
          className="min-w-0 space-y-4 border-l-2 border-line pl-3"
          data-testid="installment-fields"
          onPointerDown={() => { pressInside.current = true }}
          onPointerUp={() => { pressInside.current = false }}
          onPointerCancel={() => { pressInside.current = false }}
        >
          <legend className="sr-only">Installment</legend>
          {collapsed ? (
            <div className="flex flex-wrap items-center justify-between gap-2" data-testid="installment-summary">
              <p className="text-sm text-body">
                <span data-testid="installment-summary-months">{monthsChosen.ok ? monthsChosen.value : ''} {monthsChosen.ok && monthsChosen.value === 1 ? 'month' : 'months'}</span>
                {preview && (
                  <>
                    {', '}
                    <span data-testid="installment-summary-monthly">{preview.monthly}{preview.months > 1 ? ' a month' : ''}</span>
                    {preview.last !== null && (
                      <>
                        {', '}
                        <span data-testid="installment-summary-last">last payment {preview.last}</span>
                      </>
                    )}
                  </>
                )}
              </p>
              <button
                type="button"
                onClick={() => setChanging(true)}
                className="min-h-11 rounded-full bg-sunken px-4 py-1.5 text-sm font-medium text-body hover:bg-sunken focus-ring"
                data-testid="installment-change"
              >
                Change
              </button>
            </div>
          ) : (
            <div>
              <label className="label" htmlFor="installment-months" id="installment-months-label">Months</label>
              <div className="mb-2 flex flex-wrap gap-2" role="group" aria-labelledby="installment-months-label">
                {INSTALLMENT_MONTH_PICKS.map((count) => {
                  const selected = months.trim() === String(count)
                  return (
                    <button
                      key={count}
                      type="button"
                      onClick={() => { onMonthsChange(String(count)); setChanging(false); setTyping(false) }}
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
                onFocus={() => setTyping(true)}
                onBlur={() => {
                  // Pressing a pick keeps the section until the tap lands (it folds then); leaving for elsewhere folds it.
                  if (pressInside.current) return
                  setTyping(false)
                  setChanging(false)
                }}
                className="input-field min-h-11 focus-ring"
                placeholder="Or type a number of months"
                data-field="installment_months"
                {...describedBy('installment_months')}
              />
              <InstallmentFieldError field="installment_months" message={errors.installment_months} />
            </div>
          )}
          {!collapsed && preview && (
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
