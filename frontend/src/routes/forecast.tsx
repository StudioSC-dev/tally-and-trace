import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import { useAuth } from '../contexts/AuthContext'
import { useCurrency } from '../hooks/useCurrency'
import { formatCurrency } from '../utils/currency'
import { estimateText, estimateTitle } from '../utils/fx'
import { CurrencyControl } from '../components/CurrencyControl'
import { useSelectedCurrency } from '../hooks/useSelectedCurrency'
import { FxNotice } from '../components/FxNotice'
import { ShortfallBanner } from '../components/ShortfallBanner'
import { useGetForecastTimelineQuery } from '../store/api'
import { RunningBalanceChart } from '../components/RunningBalanceChart'
import { TagFilter } from '../components/TagFilter'

import { timelineEventAmount, timelineEventName } from '@tally-trace/shared'
import type { CashflowTimelineEvent, LimitedTimelineEvent } from '@tally-trace/shared'
export const Route = createFileRoute('/forecast')({
  component: ForecastPage,
})

const longDate = (iso: string | null) => {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' }).format(d)
}

const DAY_OPTIONS = [30, 60, 90] as const

function ForecastPage() {
  const { isAuthenticated, isLoading: authLoading } = useAuth()
  const navigate = useNavigate()
  const { currencyCode: defaultCurrency } = useCurrency()
  const [days, setDays] = useState<(typeof DAY_OPTIONS)[number]>(60)
  const [selectedTag, setSelectedTag] = useState<number | undefined>(undefined)

  useEffect(() => {
    if (!authLoading && !isAuthenticated) {
      navigate({ to: '/login', search: { message: undefined } })
    }
  }, [isAuthenticated, authLoading, navigate])

  const { data, isLoading, error } = useGetForecastTimelineQuery({ days, ...(selectedTag !== undefined ? { tag: selectedTag } : {}) }, { skip: !isAuthenticated })

  const [currency, setCurrency] = useSelectedCurrency(data?.currencies, defaultCurrency)
  const format = (amount: number) => formatCurrency(amount, currency)
  const row = data?.by_currency.find((r) => r.currency === currency)
  // Funding shortfalls in every currency, whichever one is selected.
  const fundingShortfalls = data?.by_currency.flatMap((r) => r.account_shortfalls.map((sf) => ({ ...sf, currency: r.currency }))) ?? []

  if (!isAuthenticated) return null

  // A converted event reads "≈ PHP 4,640.00 (USD 80.00)"; a limited one has no labels to show.
  const signedEvent = (e: CashflowTimelineEvent | LimitedTimelineEvent) => {
    const amount = timelineEventAmount(e)
    const sign = amount >= 0 ? '+' : '−'
    return `${sign}${e.view === 'limited' ? format(Math.abs(amount)) : estimateText(Math.abs(amount), currency, e)}`
  }

  return (
    <div className="max-w-7xl mx-auto px-3 sm:px-4 lg:px-6 py-8 space-y-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold text-ink">Cash-Flow Timeline</h1>
          <p className="text-sm text-muted mt-1">
            Running balance walked in date order — surfaces the trough before payday, not just the month-end total.
          </p>
        </div>
        <TagFilter value={selectedTag} onChange={setSelectedTag} />
        <CurrencyControl currencies={data?.currencies} value={currency} onChange={setCurrency} />
        <div className="flex space-x-1 bg-sunken p-1">
          {DAY_OPTIONS.map((d) => (
            <button
              key={d}
              onClick={() => setDays(d)}
              className={`px-4 py-1.5 text-sm font-medium transition-colors duration-200 ${ days === d ? 'bg-surface text-ink' : 'text-body hover:text-ink' }`}
            >
              {d} days
            </button>
          ))}
        </div>
      </div>

      {isLoading ? (
        <div className="flex items-center justify-center h-64">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-ink" />
        </div>
      ) : error || !data ? (
        <div className="bg-surface border border-line p-6 text-sm text-muted">
          Could not load the cash-flow timeline.
        </div>
      ) : !row ? (
        <>
          <ShortfallBanner rows={data.by_currency} selected={currency} days={days} />
          <FxNotice fx={data.fx} />
          <div className="bg-surface border border-line p-6 text-sm text-muted">No {currency} cash is projected in this window.</div>
        </>
      ) : (
        <>
          <ShortfallBanner rows={data.by_currency} selected={currency} days={days} />
          <FxNotice fx={data.fx} />

          {/* Chart */}
          <div className="bg-surface border border-line p-4 sm:p-6">
            <RunningBalanceChart timeline={{ window_start: data.window_start, window_end: data.window_end, ...row }} format={format} height={320} />
            <dl className="mt-4 grid grid-cols-2 sm:grid-cols-4 gap-3">
              {[
                { label: 'Opening', value: row.opening_balance, color: 'text-ink' },
                { label: 'Lowest (trough)', value: row.lowest_balance, color: row.lowest_balance < 0 ? 'text-danger' : 'text-ink' },
                { label: `Close (${days}d)`, value: row.closing_balance, color: row.closing_balance < 0 ? 'text-danger' : 'text-ok' },
                { label: 'Net change', value: row.closing_balance - row.opening_balance, color: row.closing_balance - row.opening_balance >= 0 ? 'text-ok' : 'text-danger' },
              ].map(({ label, value, color }) => (
                <div key={label} className="bg-sunken/50 py-3 px-3">
                  <dt className="text-xs uppercase tracking-wide text-muted">{label}</dt>
                  <dd className={`text-base font-semibold ${color}`}>{format(value)}</dd>
                </div>
              ))}
            </dl>
          </div>

          {/* Account funding shortfalls (UC1) */}
          {fundingShortfalls.length > 0 && (
            <div className="bg-surface border border-line">
              <div className="p-4 sm:p-6 border-b border-line">
                <h2 className="text-lg font-semibold text-ink">Funding shortfalls</h2>
                <p className="text-sm text-muted">
                  Bills where the account you pay from can't cover them (even after overflow) — you'd need to move money in first.
                </p>
              </div>
              <ul className="divide-y divide-line/50">
                {fundingShortfalls.map((s, i) => (
                  <li key={`${s.currency}-${s.account_id}-${i}`} className="p-4 sm:px-6 flex items-center justify-between gap-4">
                    <div className="min-w-0">
                      <p className="font-medium text-ink truncate">{s.name}</p>
                      <p className="text-xs text-muted">
                        {longDate(s.date)} · from {s.account_name ?? 'account'}
                        {s.overflow_used > 0 ? ` · ${formatCurrency(s.overflow_used, s.currency)} pulled from overflow` : ''}
                      </p>
                    </div>
                    <p className="text-sm font-semibold text-warn flex-shrink-0">short {formatCurrency(s.short_amount, s.currency)}</p>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* Event table (the accessible table view of the chart) */}
          <div className="bg-surface border border-line">
            <div className="p-4 sm:p-6 border-b border-line flex items-center justify-between">
              <h2 className="text-lg font-semibold text-ink">Scheduled items</h2>
              <span className="badge badge-info">{row.events.length}</span>
            </div>
            {row.events.length === 0 ? (
              <p className="p-4 sm:p-6 text-sm text-muted">No income or payables scheduled in this window.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="min-w-full divide-y divide-line text-sm">
                  <thead>
                    <tr className="text-left text-xs font-semibold uppercase tracking-wide text-muted">
                      <th className="py-3 px-4 sm:px-6">Date</th>
                      <th className="py-3 px-4">Item</th>
                      <th className="py-3 px-4 text-right">Amount</th>
                      <th className="py-3 px-4 sm:px-6 text-right">Running balance</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-line/50">
                    {row.events.map((e, i) => (
                      <tr key={e.view === 'limited' ? e.public_id : `${e.source}-${e.source_id}-${i}`} className="hover:bg-sunken/50 transition-colors duration-150">
                        <td className="py-3 px-4 sm:px-6 whitespace-nowrap text-muted">{longDate(e.date)}</td>
                        <td className="py-3 px-4 text-ink">{timelineEventName(e)}</td>
                        <td className={`py-3 px-4 text-right font-medium ${timelineEventAmount(e) >= 0 ? 'text-ok' : 'text-danger'}`}>
                          <span title={e.view === 'limited' ? undefined : estimateTitle(e)} data-testid="timeline-amount">{signedEvent(e)}</span>
                        </td>
                        <td className={`py-3 px-4 sm:px-6 text-right font-semibold ${e.running_balance < 0 ? 'text-danger' : 'text-ink'}`}>
                          {format(e.running_balance)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  )
}
