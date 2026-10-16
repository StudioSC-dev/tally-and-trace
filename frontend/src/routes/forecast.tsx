import { createFileRoute, Link, useNavigate } from '@tanstack/react-router'
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

import { overflowPullsFrom, timelineEventAccountLabel, timelineEventAmount, timelineEventName } from '@tally-trace/shared'
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

// A pinned request the API refuses (the account is no longer usable) falls back to pooled.
const isPinRefusal = (error: unknown) => {
  const status = (error as { status?: unknown } | undefined)?.status
  return status === 400 || status === 404
}

function ForecastPage() {
  const { isAuthenticated, isLoading: authLoading, user, refreshUser } = useAuth()
  const navigate = useNavigate()
  const { currencyCode: defaultCurrency } = useCurrency()
  const [days, setDays] = useState<(typeof DAY_OPTIONS)[number]>(60)
  const [selectedTag, setSelectedTag] = useState<number | undefined>(undefined)
  // The main account opens by default; "All cash accounts" lasts for this visit only.
  const [scope, setScope] = useState<'main' | 'all'>('main')
  const [refusedPin, setRefusedPin] = useState<number | null>(null)
  const [mainName, setMainName] = useState<string | null>(null)
  const pinnedId = user?.main_account_id ?? null
  const accountId = pinnedId !== null && scope === 'main' && refusedPin !== pinnedId ? pinnedId : undefined
  const pinLost = refusedPin !== null && (pinnedId === null || pinnedId === refusedPin)

  useEffect(() => {
    if (!authLoading && !isAuthenticated) {
      navigate({ to: '/login', search: { message: undefined } })
    }
  }, [isAuthenticated, authLoading, navigate])

  const { currentData, error } = useGetForecastTimelineQuery({
    days,
    ...(selectedTag !== undefined ? { tag: selectedTag } : {}),
    ...(accountId !== undefined ? { account_id: accountId } : {}),
  }, { skip: !isAuthenticated })
  // Only a response for the scope on screen: never a stale pooled or pinned one.
  const data = currentData && (currentData.account?.account_id ?? undefined) === accountId ? currentData : undefined
  const refused = accountId !== undefined && isPinRefusal(error)
  const scopeName = data?.account?.account_name ?? null

  useEffect(() => {
    if (!refused || accountId === undefined) return
    setRefusedPin(accountId)
    void refreshUser()
  }, [refused, accountId, refreshUser])

  useEffect(() => {
    if (scopeName) setMainName(scopeName)
  }, [scopeName])

  const [currency, setCurrency] = useSelectedCurrency(data?.currencies, defaultCurrency)
  const format = (amount: number) => formatCurrency(amount, currency)
  const row = data?.by_currency.find((r) => r.currency === currency)
  // Funding shortfalls in every currency, whichever one is selected.
  const fundingShortfalls = data?.by_currency.flatMap((r) => r.account_shortfalls.map((sf) => ({ ...sf, currency: r.currency }))) ?? []
  // Pinned: a row an overflow move covers says where the money would come from. A pull
  // out of the account has no row of its own here, so those are listed above the table.
  const overflowNotes = new Map<string, string>()
  const overflowPulls = data?.account && row ? overflowPullsFrom(row.overflow_moves, data.account.account_id) : []
  if (data?.account && row) {
    for (const m of row.overflow_moves) {
      if (m.to_account_id !== data.account.account_id) continue
      const note = `covered by ${m.from_account_name ?? 'overflow'}`
      const key = `${m.date}|${m.name}`
      overflowNotes.set(key, overflowNotes.has(key) ? `${overflowNotes.get(key)}; ${note}` : note)
    }
  }

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
        {pinnedId !== null && !pinLost ? (
          <div className="flex space-x-1 bg-sunken p-1 self-start" role="group" aria-label="Accounts" data-testid="timeline-scope">
            {(['main', 'all'] as const).map((s) => (
              <button
                key={s}
                type="button"
                aria-pressed={scope === s}
                onClick={() => setScope(s)}
                className={`px-4 py-1.5 text-sm font-medium transition-colors duration-200 ${ scope === s ? 'bg-surface text-ink' : 'text-body hover:text-ink' }`}
              >
                {s === 'main' ? `Main: ${mainName ?? 'account'}` : 'All cash accounts'}
              </button>
            ))}
          </div>
        ) : (
          <Link to="/settings" className="text-sm text-muted hover:text-ink hover:underline self-start sm:self-center">
            Pin a main account in Settings
          </Link>
        )}
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

      {pinLost && (
        <p className="text-sm text-muted" role="status" data-testid="main-account-lost">
          Your main account is no longer available; showing all cash accounts.
        </p>
      )}

      {!data && (!error || refused) ? (
        <div className="flex items-center justify-center h-64">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-ink" />
        </div>
      ) : error || !data ? (
        <div className="bg-surface border border-line p-6 text-sm text-muted">
          Could not load the cash-flow timeline.
        </div>
      ) : !row ? (
        <>
          <ShortfallBanner rows={data.by_currency} selected={currency} days={days} accountName={data.account ? scopeName : undefined} />
          <FxNotice fx={data.fx} />
          <div className="bg-surface border border-line p-6 text-sm text-muted">No {currency} cash is projected in this window.</div>
        </>
      ) : (
        <>
          <ShortfallBanner rows={data.by_currency} selected={currency} days={days} accountName={data.account ? scopeName : undefined} />
          <FxNotice fx={data.fx} />

          {/* Chart */}
          <div className="bg-surface border border-line p-4 sm:p-6">
            <RunningBalanceChart timeline={{ window_start: data.window_start, window_end: data.window_end, ...row }} format={format} height={320} />
            <dl className="mt-4 grid grid-cols-2 sm:grid-cols-4 gap-3">
              {[
                { label: data.account ? `Opening · ${scopeName ?? 'account'}` : 'Opening', value: row.opening_balance, color: 'text-ink' },
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
            {overflowPulls.length > 0 && (
              <section className="p-4 sm:p-6 border-b border-line" aria-labelledby="overflow-pulls-heading" data-testid="timeline-overflow-pulls">
                <h3 id="overflow-pulls-heading" className="text-sm font-semibold text-ink">Overflow pulls from this account</h3>
                <p className="text-xs text-muted mt-1">Not in the running balance below, which would be lower by each amount from its date on.</p>
                <ul className="mt-2 space-y-1 text-sm">
                  {overflowPulls.map((m, i) => (
                    <li key={`${m.date}-${m.to_account_id}-${i}`} className="flex flex-wrap gap-x-2">
                      <span className="text-muted">{longDate(m.date)}</span>
                      <span className="font-medium text-danger">−{format(m.amount)}</span>
                      <span className="text-body">to {m.to_account_name ?? 'another account'} ({m.name})</span>
                    </li>
                  ))}
                </ul>
              </section>
            )}
            {row.events.length === 0 ? (
              <p className="p-4 sm:p-6 text-sm text-muted">No income or payables scheduled in this window.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="min-w-full divide-y divide-line text-sm">
                  <thead>
                    <tr className="text-left text-xs font-semibold uppercase tracking-wide text-muted">
                      <th className="py-3 px-4 sm:px-6">Date</th>
                      <th className="py-3 px-4">Item</th>
                      <th className="py-3 px-4">Account</th>
                      <th className="py-3 px-4 text-right">Amount</th>
                      <th className="py-3 px-4 sm:px-6 text-right">Running balance</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-line/50">
                    {row.events.map((e, i) => (
                      <tr key={e.view === 'limited' ? e.public_id : `${e.source}-${e.source_id}-${i}`} className="hover:bg-sunken/50 transition-colors duration-150">
                        <td className="py-3 px-4 sm:px-6 whitespace-nowrap text-muted">{longDate(e.date)}</td>
                        <td className="py-3 px-4 text-ink">
                          {timelineEventName(e)}
                          {overflowNotes.has(`${e.date}|${timelineEventName(e)}`) && (
                            <span className="block text-xs text-muted" data-testid="timeline-overflow-note">{overflowNotes.get(`${e.date}|${timelineEventName(e)}`)}</span>
                          )}
                        </td>
                        <td className="py-3 px-4 text-muted" data-testid="timeline-account">{timelineEventAccountLabel(e)}</td>
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
