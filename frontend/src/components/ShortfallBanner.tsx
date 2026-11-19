import type { CashflowTimelineCurrencyRow } from '@tally-trace/shared'
import { formatSigned } from '../utils/amount'
import type { CurrencyCode } from '../utils/currency'
import { Icon } from './Icon'

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
  /** A timeline walked for one main account: the heading names it. */
  accountName?: string | null
}

/**
 * The solvency banner. It lists every currency that dips below zero, whichever one is
 * selected, so a USD shortfall is not hidden behind the PHP segment. Colour is always
 * paired with an icon and text.
 */
export function ShortfallBanner({ rows, selected, days, compact = false, accountName }: Props) {
  const short = rows.filter((row) => row.shortfall)
  const selectedRow = rows.find((row) => row.currency === selected)
  const selectedShort = selectedRow?.shortfall === true
  const pad = compact ? 'p-3' : 'p-4'
  return (
    <div className="space-y-3" data-testid="solvency">
      {short.length > 0 && (
        <div className={`flex items-start gap-3 border border-danger bg-surface text-danger ${pad}`} role="alert" data-testid="shortfall-banner">
          <Icon name="warning" />
          <div className="text-sm min-w-0">
            <p className="font-semibold text-danger">
              {accountName ? `Shortfall on ${accountName} before overflow` : `Projected shortfall${short.length > 1 ? ' in more than one currency' : ''}`}
            </p>
            <ul className="text-danger space-y-0.5">
              {short.map((row) => {
                const when = longDate(row.trough_date)
                return (
                  <li key={row.currency} data-testid={`shortfall-${row.currency}`}>
                    <span className="font-semibold">{row.currency}</span>: lowest {formatSigned(row.lowest_balance, row.currency)}{when ? ` on ${when}` : ''}
                    {row.shortfalls.length > 1 ? ` (${row.shortfalls.length} points)` : ''}
                  </li>
                )
              })}
            </ul>
            {selectedShort && selectedRow && (
              <p className="text-danger mt-1">
                {days !== undefined ? `The ${days}-day ` : 'The month-end '}close in {selectedRow.currency} is {formatSigned(selectedRow.closing_balance, selectedRow.currency)}, but that isn't the problem: the timing is.
              </p>
            )}
          </div>
        </div>
      )}
      {!selectedShort && selectedRow && (
        <div className={`flex items-start gap-3 border border-line text-ok ${pad}`}>
          <Icon name="check" />
          <p className="text-sm font-medium text-ok">
            On track in {selectedRow.currency}: the lowest projected balance is {formatSigned(selectedRow.lowest_balance, selectedRow.currency)}{selectedRow.trough_date ? ` on ${longDate(selectedRow.trough_date)}` : ' at the start of the window'}.
          </p>
        </div>
      )}
    </div>
  )
}
