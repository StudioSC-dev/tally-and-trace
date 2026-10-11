import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import { useAuth } from '../contexts/AuthContext'
import { useGetHouseholdViewsQuery } from '../store/api'
import { apiErrorMessage } from '../utils/apiError'
import { HouseholdDashboardTab } from '../components/household/HouseholdDashboard'
import { HouseholdMonthlyTab } from '../components/household/HouseholdMonthly'
import { HouseholdTransactionsTab } from '../components/household/HouseholdTransactions'
import { HouseholdUpcomingTab } from '../components/household/HouseholdUpcoming'

export const Route = createFileRoute('/household')({
  component: HouseholdPage,
  validateSearch: (search: Record<string, unknown>): { sharer?: number } => {
    const sharer = Number(search.sharer)
    return { sharer: Number.isInteger(sharer) && sharer > 0 ? sharer : undefined }
  },
})

type Tab = 'dashboard' | 'transactions' | 'upcoming' | 'monthly'

const TABS: Array<{ id: Tab; label: string }> = [
  { id: 'dashboard', label: 'Dashboard' },
  { id: 'transactions', label: 'Transactions' },
  { id: 'upcoming', label: 'Upcoming' },
  { id: 'monthly', label: 'Monthly' },
]

/**
 * A Household view: one person's Household-tagged accounts and records, read-only. Your own
 * is always there; each Household someone shared with you is another. No allocations or
 * budget categories, and nothing here can be edited.
 */
function HouseholdPage() {
  const { isAuthenticated, isLoading: authLoading } = useAuth()
  const navigate = useNavigate()
  const { sharer } = Route.useSearch()
  const [tab, setTab] = useState<Tab>('dashboard')

  useEffect(() => {
    if (!authLoading && !isAuthenticated) navigate({ to: '/login', search: { message: undefined } })
  }, [authLoading, isAuthenticated, navigate])

  const { data: views, isLoading, error } = useGetHouseholdViewsQuery(undefined, { skip: !isAuthenticated })

  if (!isAuthenticated) return null

  // The view asked for in the link, else someone else's Household (what the page is mostly
  // for), else your own.
  const current =
    views?.find((view) => view.sharer_id === sharer) ?? views?.find((view) => !view.is_self) ?? views?.[0]

  return (
    <div className="max-w-5xl mx-auto px-3 py-6 sm:px-4 lg:px-6 space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold text-ink" data-testid="household-title">
            {current ? (current.is_self ? 'Your Household' : `${current.sharer_name}'s Household`) : 'Household'}
          </h1>
          <p className="text-sm text-muted">
            The accounts and records tagged Household, read-only.
          </p>
        </div>
        {views && views.length > 1 && (
          <div>
            <label className="label" htmlFor="household-sharer">Household</label>
            <select
              id="household-sharer"
              className="select-field focus-ring"
              value={current?.sharer_id}
              onChange={(event) => navigate({ to: '/household', search: { sharer: Number(event.target.value) } })}
              data-testid="household-switcher"
            >
              {views.map((view) => (
                <option key={view.sharer_id} value={view.sharer_id}>
                  {view.is_self ? 'Your Household' : `${view.sharer_name}'s Household`}
                </option>
              ))}
            </select>
          </div>
        )}
      </div>

      {isLoading && <p className="text-sm text-muted">Loading...</p>}
      {error && (
        <p className="text-sm text-danger" role="alert">
          {apiErrorMessage(error) || 'Could not load your Households.'}
        </p>
      )}

      {current && (
        <>
          <div className="flex space-x-1 bg-sunken p-1" role="tablist">
            {TABS.map(({ id, label }) => (
              <button
                key={id}
                type="button"
                role="tab"
                aria-selected={tab === id}
                onClick={() => setTab(id)}
                className={`flex-1 px-3 py-1.5 text-sm font-medium transition-colors duration-200 ${
                  tab === id ? 'bg-surface text-ink' : 'text-body hover:text-ink'
                }`}
                data-testid={`household-tab-${id}`}
              >
                {label}
              </button>
            ))}
          </div>
          {/* Keyed by the sharer, so switching Households never shows the previous one's data. */}
          <div key={current.sharer_id}>
            {tab === 'dashboard' && <HouseholdDashboardTab sharerId={current.sharer_id} />}
            {tab === 'transactions' && <HouseholdTransactionsTab sharerId={current.sharer_id} />}
            {tab === 'upcoming' && <HouseholdUpcomingTab sharerId={current.sharer_id} />}
            {tab === 'monthly' && <HouseholdMonthlyTab sharerId={current.sharer_id} />}
          </div>
        </>
      )}
    </div>
  )
}
