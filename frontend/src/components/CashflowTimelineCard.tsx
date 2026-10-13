import { Link } from '@tanstack/react-router'
import { useGetForecastTimelineQuery } from '../store/api'
import { formatCurrency } from '../utils/currency'
import type { CurrencyCode } from '../utils/currency'
import { ShortfallBanner } from './ShortfallBanner'
import { RunningBalanceChart } from './RunningBalanceChart'

export function CashflowTimelineCard({ tag, currency }: { tag?: number; currency: CurrencyCode }) {
  const format = (amount: number) => formatCurrency(amount, currency)
  const { data, isLoading, error } = useGetForecastTimelineQuery({ days: 60, ...(tag !== undefined ? { tag } : {}) })

  const row = data?.by_currency.find((r) => r.currency === currency)
  // Funding shortfalls in every currency, like the solvency banner.
  const shortfalls = data?.by_currency.flatMap((r) => r.account_shortfalls.map((s) => ({ ...s, currency: r.currency }))) ?? []

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
        ) : !row ? (
          <>
            <ShortfallBanner rows={data.by_currency} selected={currency} compact />
            <p className="text-sm text-muted">No {currency} cash is projected in this window.</p>
          </>
        ) : (
          <>
            <ShortfallBanner rows={data.by_currency} selected={currency} compact />

            <RunningBalanceChart timeline={{ window_start: data.window_start, window_end: data.window_end, ...row }} format={format} height={150} compact />

            {shortfalls.length > 0 && (
              <p className="text-xs text-warn">
                ⚠ {shortfalls.length} funding shortfall{shortfalls.length === 1 ? '' : 's'} — a bill can't be covered from its funding account.{' '}
                <Link to="/forecast" className="underline">See details</Link>
              </p>
            )}

            <dl className="grid grid-cols-3 gap-2 text-center">
              {[
                { label: 'Opening', value: row.opening_balance, color: 'text-ink' },
                { label: 'Trough', value: row.lowest_balance, color: row.lowest_balance < 0 ? 'text-danger' : 'text-ink' },
                { label: 'Close (60d)', value: row.closing_balance, color: row.closing_balance < 0 ? 'text-danger' : 'text-ok' },
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
