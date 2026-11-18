import { LoadingLine, Skeleton } from '../components/Loading'
import { PageHeader } from '../components/PageHeader'
import { createFileRoute, Link, useNavigate } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import { queryPhase } from '@tally-trace/shared'
import { useAuth } from '../contexts/AuthContext'
import { useGetHouseholdViewsQuery } from '../store/api'
import { apiErrorMessage } from '../utils/apiError'
import { HouseholdDashboardTab } from '../components/household/HouseholdDashboard'
import { HouseholdMonthlyTab } from '../components/household/HouseholdMonthly'
import { HouseholdTransactionsTab } from '../components/household/HouseholdTransactions'
import { HouseholdUpcomingTab } from '../components/household/HouseholdUpcoming'
import { Tab, Tabs } from '../components/Tabs'

export const Route = createFileRoute('/accounts_/household')({
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

  const viewsQuery = useGetHouseholdViewsQuery(undefined, { skip: !isAuthenticated })
  const { data: views, isLoading, error } = viewsQuery
  // The title names the sharer, so it waits for the views instead of flipping from "Household".
  const viewsPhase = queryPhase(views, viewsQuery, !isAuthenticated)

  if (!isAuthenticated) return null

  // The view asked for in the link, else someone else's Household (what the page is mostly
  // for), else your own.
  const current =
    views?.find((view) => view.sharer_id === sharer) ?? views?.find((view) => !view.is_self) ?? views?.[0]

  return (
    <div className="page">
      <PageHeader
        title={current ? (current.is_self ? 'Your household' : `${current.sharer_name}'s household`) : 'Household'}
        titleTestId="household-title"
        placeholder={
          viewsPhase === 'pending' ? (
            <div data-testid="household-title-pending">
              <Skeleton className="h-8 w-56" />
            </div>
          ) : undefined
        }
      >
        <Link to="/accounts" className="text-sm text-muted hover:text-ink" data-testid="household-back">
          &larr; Accounts
        </Link>
        {views && views.length > 1 && (
          <div className="flex items-center gap-2">
            <label className="label" htmlFor="household-sharer">Household</label>
            <select
              id="household-sharer"
              className="select-field focus-ring"
              value={current?.sharer_id}
              onChange={(event) => navigate({ to: '/accounts/household', search: { sharer: Number(event.target.value) } })}
              data-testid="household-switcher"
            >
              {views.map((view) => (
                <option key={view.sharer_id} value={view.sharer_id}>
                  {view.is_self ? 'Your household' : `${view.sharer_name}'s household`}
                </option>
              ))}
            </select>
          </div>
        )}
      </PageHeader>
      <p className="text-sm text-muted">
        The accounts and records tagged Household, read-only.
      </p>

      {isLoading && <LoadingLine>Loading...</LoadingLine>}
      {error && (
        <p className="text-sm text-danger" role="alert">
          {apiErrorMessage(error) || 'Could not load your Households.'}
        </p>
      )}

      {current && (
        <>
          <Tabs className="flex space-x-1 bg-sunken p-1">
            {TABS.map(({ id, label }) => (
              <Tab
                key={id}
                selected={tab === id}
                onClick={() => setTab(id)}
                className="flex-1 px-2 py-1.5 text-sm sm:px-3"
                data-testid={`household-tab-${id}`}
              >
                {label}
              </Tab>
            ))}
          </Tabs>
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
