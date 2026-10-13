import type { CashflowTimelineCurrencyRow } from '@tally-trace/shared'
import { formatCurrency } from '../utils/currency'
import type { CurrencyCode } from '../utils/currency'

const longDate = (iso: string | null) => {
  if (!iso) return null
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' }).format(d)
}

interface Props {
  rows: CashflowTimelineCurrencyRow[]
  selected: CurrencyCode
  /** The window's length, for the sentence about the selected currency's close. */
  days?: number
  compact?: boolean
}

/**
 * The solvency banner. It lists every currency that dips below zero, whichever one is
 * selected, so a USD shortfall is not hidden behind the PHP segment. Colour is always
 * paired with an icon and text.
 */
export function ShortfallBanner({ rows, selected, days, compact = false }: Props) {
  const short = rows.filter((row) => row.shortfall)
  const selectedRow = rows.find((row) => row.currency === selected)
  const selectedShort = selectedRow?.shortfall === true
  const pad = compact ? 'p-3' : 'p-4'
  return (
    <div className="space-y-3" data-testid="solvency">
      {short.length > 0 && (
        <div className={`flex items-start gap-3 border border-danger bg-surface ${pad}`} role="alert" data-testid="shortfall-banner">
          <svg className="h-5 w-5 flex-shrink-0 text-danger" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
            <path d="M10.894 2.553c-.346-.598-1.442-.598-1.788 0l-7 12.092c-.339.586.086 1.355.894 1.355h14c.808 0 1.233-.769.894-1.355l-7-12.092z" />
            <path d="M9 8h2v4H9V8zm0 5h2v2H9v-2z" fill="white" />
          </svg>
          <div className="text-sm min-w-0">
            <p className="font-semibold text-danger">Projected shortfall{short.length > 1 ? ' in more than one currency' : ''}</p>
            <ul className="text-danger space-y-0.5">
              {short.map((row) => {
                const when = longDate(row.trough_date)
                return (
                  <li key={row.currency} data-testid={`shortfall-${row.currency}`}>
                    <span className="font-semibold">{row.currency}</span>: lowest {formatCurrency(row.lowest_balance, row.currency)}{when ? ` on ${when}` : ''}
                    {row.shortfalls.length > 1 ? ` (${row.shortfalls.length} points)` : ''}
                  </li>
                )
              })}
            </ul>
            {selectedShort && selectedRow && (
              <p className="text-danger mt-1">
                {days !== undefined ? `The ${days}-day ` : 'The month-end '}close in {selectedRow.currency} is {formatCurrency(selectedRow.closing_balance, selectedRow.currency)}, but that isn't the problem: the timing is.
              </p>
            )}
          </div>
        </div>
      )}
      {!selectedShort && selectedRow && (
        <div className={`flex items-start gap-3 border border-line ${pad}`}>
          <svg className="h-5 w-5 flex-shrink-0 text-ok" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
            <path fillRule="evenodd" d="M16.704 5.29a1 1 0 00-1.408-1.42l-6.32 6.263-2.272-2.26a1 1 0 10-1.408 1.419l2.976 2.958a1 1 0 001.408 0l7.024-6.96z" clipRule="evenodd" />
          </svg>
          <p className="text-sm font-medium text-ok">
            On track in {selectedRow.currency}: the lowest projected balance is {formatCurrency(selectedRow.lowest_balance, selectedRow.currency)}{selectedRow.trough_date ? ` on ${longDate(selectedRow.trough_date)}` : ' at the start of the window'}.
          </p>
        </div>
      )}
    </div>
  )
}
