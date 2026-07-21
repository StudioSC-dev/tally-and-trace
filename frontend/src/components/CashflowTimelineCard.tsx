import { Link } from '@tanstack/react-router'
import { useGetForecastTimelineQuery } from '../store/api'
import { useCurrency } from '../hooks/useCurrency'
import { RunningBalanceChart } from './RunningBalanceChart'

const longDate = (iso: string | null) => {
  if (!iso) return null
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' }).format(d)
}

export function CashflowTimelineCard() {
  const { format } = useCurrency()
  const { data, isLoading, error } = useGetForecastTimelineQuery({ days: 60 })

  return (
    <div className="bg-surface border border-line" data-onboarding="cashflow-timeline">
      <div className="p-4 sm:p-6 border-b border-line">
        <div className="flex items-center justify-between gap-4">
          <div>
            <h2 className="text-lg font-semibold text-ink">Cash-Flow Timeline</h2>
            <p className="text-sm text-muted">Your running balance over the next 60 days — before payday, not just month-end.</p>
          </div>
          <Link to="/forecast" className="text-sm font-medium text-ink hover:underline flex-shrink-0">
            Details →
          </Link>
        </div>
      </div>

      <div className="p-4 sm:p-6 space-y-4">
        {isLoading ? (
          <div className="flex items-center justify-center h-40">
            <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-ink" />
          </div>
        ) : error || !data ? (
          <p className="text-sm text-muted">Could not load the cash-flow timeline.</p>
        ) : (
          <>
            {/* Solvency banner — status color always paired with an icon + text */}
            {data.shortfall ? (
              <div className="flex items-start gap-3 border border-danger bg-danger p-3">
                <svg className="h-5 w-5 flex-shrink-0 text-danger" viewBox="0 0 20 20" fill="currentColor">
                  <path d="M10.894 2.553c-.346-.598-1.442-.598-1.788 0l-7 12.092c-.339.586.086 1.355.894 1.355h14c.808 0 1.233-.769.894-1.355l-7-12.092z" />
                  <path d="M9 8h2v4H9V8zm0 5h2v2H9v-2z" fill="white" />
                </svg>
                <div className="text-sm">
                  <p className="font-semibold text-danger">
                    Projected shortfall: {format(data.lowest_balance)}{data.trough_date ? ` on ${longDate(data.trough_date)}` : ''}
                  </p>
                  <p className="text-danger">
                    You dip below zero before funds arrive{data.shortfalls.length > 1 ? ` (${data.shortfalls.length} points)` : ''}. Month-end closes at {format(data.closing_balance)}, but that isn't the problem — the timing is.
                  </p>
                </div>
              </div>
            ) : (
              <div className="flex items-start gap-3 border border-line p-3">
                <svg className="h-5 w-5 flex-shrink-0 text-ok" viewBox="0 0 20 20" fill="currentColor">
                  <path fillRule="evenodd" d="M16.704 5.29a1 1 0 00-1.408-1.42l-6.32 6.263-2.272-2.26a1 1 0 10-1.408 1.419l2.976 2.958a1 1 0 001.408 0l7.024-6.96z" clipRule="evenodd" />
                </svg>
                <p className="text-sm font-medium text-ok">
                  On track — lowest projected balance is {format(data.lowest_balance)}{data.trough_date ? ` on ${longDate(data.trough_date)}` : ' at the start of the window'}.
                </p>
              </div>
            )}

            <RunningBalanceChart timeline={data} format={format} height={150} compact />

            {data.account_shortfalls.length > 0 && (
              <p className="text-xs text-warn">
                ⚠ {data.account_shortfalls.length} funding shortfall{data.account_shortfalls.length === 1 ? '' : 's'} — a bill can't be covered from its funding account.{' '}
                <Link to="/forecast" className="underline">See details</Link>
              </p>
            )}

            <dl className="grid grid-cols-3 gap-2 text-center">
              {[
                { label: 'Opening', value: data.opening_balance, color: 'text-ink' },
                { label: 'Trough', value: data.lowest_balance, color: data.lowest_balance < 0 ? 'text-danger' : 'text-ink' },
                { label: 'Close (60d)', value: data.closing_balance, color: data.closing_balance < 0 ? 'text-danger' : 'text-ok' },
              ].map(({ label, value, color }) => (
                <div key={label} className="bg-sunken/50 py-2">
                  <dt className="text-xs uppercase tracking-wide text-muted">{label}</dt>
                  <dd className={`text-sm font-semibold ${color}`}>{format(value)}</dd>
                </div>
              ))}
            </dl>
          </>
        )}
      </div>
    </div>
  )
}
