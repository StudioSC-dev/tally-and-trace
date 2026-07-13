import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import { useAuth } from '../contexts/AuthContext'
import { useCurrency } from '../hooks/useCurrency'
import { useGetForecastTimelineQuery } from '../store/api'
import { RunningBalanceChart } from '../components/RunningBalanceChart'

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
  const { format } = useCurrency()
  const [days, setDays] = useState<(typeof DAY_OPTIONS)[number]>(60)

  useEffect(() => {
    if (!authLoading && !isAuthenticated) {
      navigate({ to: '/login', search: { message: undefined } })
    }
  }, [isAuthenticated, authLoading, navigate])

  const { data, isLoading, error } = useGetForecastTimelineQuery({ days }, { skip: !isAuthenticated })

  if (!isAuthenticated) return null

  const signed = (amount: number) => `${amount >= 0 ? '+' : '−'}${format(Math.abs(amount))}`

  return (
    <div className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8 py-8 space-y-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-white">Cash-Flow Timeline</h1>
          <p className="text-sm text-gray-500 dark:text-slate-400 mt-1">
            Running balance walked in date order — surfaces the trough before payday, not just the month-end total.
          </p>
        </div>
        <div className="flex space-x-1 bg-gray-100 dark:bg-slate-800 rounded-lg p-1">
          {DAY_OPTIONS.map((d) => (
            <button
              key={d}
              onClick={() => setDays(d)}
              className={`px-4 py-1.5 rounded-md text-sm font-medium transition-colors duration-200 ${
                days === d
                  ? 'bg-white dark:bg-slate-700 text-gray-900 dark:text-white shadow-sm'
                  : 'text-gray-600 dark:text-slate-400 hover:text-gray-900 dark:hover:text-white'
              }`}
            >
              {d} days
            </button>
          ))}
        </div>
      </div>

      {isLoading ? (
        <div className="flex items-center justify-center h-64">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-500" />
        </div>
      ) : error || !data ? (
        <div className="bg-white dark:bg-slate-900/50 rounded-xl border border-gray-200 dark:border-slate-800 p-6 text-sm text-gray-500 dark:text-slate-500">
          Could not load the cash-flow timeline.
        </div>
      ) : (
        <>
          {/* Solvency banner */}
          {data.shortfall ? (
            <div className="flex items-start gap-3 rounded-xl border border-rose-200 dark:border-rose-500/30 bg-rose-50 dark:bg-rose-500/10 p-4">
              <svg className="h-5 w-5 flex-shrink-0 text-rose-600 dark:text-rose-400" viewBox="0 0 20 20" fill="currentColor">
                <path d="M10.894 2.553c-.346-.598-1.442-.598-1.788 0l-7 12.092c-.339.586.086 1.355.894 1.355h14c.808 0 1.233-.769.894-1.355l-7-12.092z" />
                <path d="M9 8h2v4H9V8zm0 5h2v2H9v-2z" fill="white" />
              </svg>
              <div className="text-sm">
                <p className="font-semibold text-rose-700 dark:text-rose-300">
                  Projected shortfall: {format(data.lowest_balance)} on {longDate(data.trough_date)}
                </p>
                <p className="text-rose-600/80 dark:text-rose-400/80">
                  The balance drops below zero at {data.shortfalls.length} point{data.shortfalls.length === 1 ? '' : 's'} before funds arrive. The {days}-day close is {format(data.closing_balance)} — healthy on paper, but you're short mid-window.
                </p>
              </div>
            </div>
          ) : (
            <div className="flex items-start gap-3 rounded-xl border border-emerald-200 dark:border-emerald-500/30 bg-emerald-50 dark:bg-emerald-500/10 p-4">
              <svg className="h-5 w-5 flex-shrink-0 text-emerald-600 dark:text-emerald-400" viewBox="0 0 20 20" fill="currentColor">
                <path fillRule="evenodd" d="M16.704 5.29a1 1 0 00-1.408-1.42l-6.32 6.263-2.272-2.26a1 1 0 10-1.408 1.419l2.976 2.958a1 1 0 001.408 0l7.024-6.96z" clipRule="evenodd" />
              </svg>
              <p className="text-sm font-medium text-emerald-700 dark:text-emerald-300">
                On track for the next {days} days — the lowest your balance reaches is {format(data.lowest_balance)}{data.trough_date ? ` on ${longDate(data.trough_date)}` : ''}.
              </p>
            </div>
          )}

          {/* Chart */}
          <div className="bg-white dark:bg-slate-900/50 rounded-xl border border-gray-200 dark:border-slate-800 shadow-sm p-4 sm:p-6">
            <RunningBalanceChart timeline={data} format={format} height={320} />
            <dl className="mt-4 grid grid-cols-2 sm:grid-cols-4 gap-3">
              {[
                { label: 'Opening', value: data.opening_balance, color: 'text-gray-900 dark:text-white' },
                { label: 'Lowest (trough)', value: data.lowest_balance, color: data.lowest_balance < 0 ? 'text-rose-600 dark:text-rose-400' : 'text-gray-900 dark:text-white' },
                { label: `Close (${days}d)`, value: data.closing_balance, color: data.closing_balance < 0 ? 'text-rose-600 dark:text-rose-400' : 'text-emerald-600 dark:text-emerald-400' },
                { label: 'Net change', value: data.closing_balance - data.opening_balance, color: data.closing_balance - data.opening_balance >= 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-rose-600 dark:text-rose-400' },
              ].map(({ label, value, color }) => (
                <div key={label} className="rounded-lg bg-gray-50 dark:bg-slate-800/50 py-3 px-3">
                  <dt className="text-xs uppercase tracking-wide text-gray-500 dark:text-slate-500">{label}</dt>
                  <dd className={`text-base font-semibold ${color}`}>{format(value)}</dd>
                </div>
              ))}
            </dl>
          </div>

          {/* Event table (the accessible table view of the chart) */}
          <div className="bg-white dark:bg-slate-900/50 rounded-xl border border-gray-200 dark:border-slate-800 shadow-sm">
            <div className="p-4 sm:p-6 border-b border-gray-200 dark:border-slate-800 flex items-center justify-between">
              <h2 className="text-lg font-semibold text-gray-900 dark:text-white">Scheduled items</h2>
              <span className="badge badge-info">{data.events.length}</span>
            </div>
            {data.events.length === 0 ? (
              <p className="p-4 sm:p-6 text-sm text-gray-500 dark:text-slate-500">No income or payables scheduled in this window.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="min-w-full divide-y divide-gray-200 dark:divide-slate-800 text-sm">
                  <thead>
                    <tr className="text-left text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-slate-500">
                      <th className="py-3 px-4 sm:px-6">Date</th>
                      <th className="py-3 px-4">Item</th>
                      <th className="py-3 px-4 text-right">Amount</th>
                      <th className="py-3 px-4 sm:px-6 text-right">Running balance</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100 dark:divide-slate-800/50">
                    {data.events.map((e, i) => (
                      <tr key={`${e.source}-${e.source_id}-${i}`} className="hover:bg-gray-50 dark:hover:bg-slate-800/50 transition-colors duration-150">
                        <td className="py-3 px-4 sm:px-6 whitespace-nowrap text-gray-500 dark:text-slate-400">{longDate(e.date)}</td>
                        <td className="py-3 px-4 text-gray-900 dark:text-white">{e.name}</td>
                        <td className={`py-3 px-4 text-right font-medium ${e.amount >= 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-rose-600 dark:text-rose-400'}`}>
                          {signed(e.amount)}
                        </td>
                        <td className={`py-3 px-4 sm:px-6 text-right font-semibold ${e.running_balance < 0 ? 'text-rose-600 dark:text-rose-400' : 'text-gray-900 dark:text-white'}`}>
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
