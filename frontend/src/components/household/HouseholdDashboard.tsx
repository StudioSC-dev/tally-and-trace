import { LoadingLine } from '../Loading'
import { useGetHouseholdDashboardQuery } from '../../store/api'
import { apiErrorMessage } from '../../utils/apiError'
import { AccountRoleBadge } from '../AccountRoleBadge'
import { TagChips } from '../TagChips'
import { MonthKindBadge, MonthLines } from './MonthLines'
import { UpcomingList } from './HouseholdUpcoming'
import { formatMonth, money } from './format'

/** The Household's accounts with their balances, this month's lines per currency, and what is due next. */
export function HouseholdDashboardTab({ sharerId }: { sharerId: number }) {
  const { data, isLoading, error } = useGetHouseholdDashboardQuery(sharerId)

  if (isLoading) return <LoadingLine>Loading...</LoadingLine>
  if (error || !data) {
    return (
      <p className="text-sm text-danger" role="alert">
        {apiErrorMessage(error) || 'Could not load this Household.'}
      </p>
    )
  }

  return (
    <div className="space-y-6" data-testid="household-dashboard">
      <section className="card p-4 sm:p-5 space-y-3">
        <h2 className="text-lg font-semibold text-ink">Accounts</h2>
        {data.accounts.length === 0 ? (
          <p className="text-sm text-muted" data-testid="household-no-accounts">
            No account is tagged Household yet.
          </p>
        ) : (
          <ul className="divide-y divide-line border border-line" data-testid="household-accounts">
            {data.accounts.map((account) => (
              <li
                key={account.id}
                className="flex flex-wrap items-center justify-between gap-3 px-3 py-2"
                data-testid="household-account"
              >
                <div className="space-y-1">
                  <p className="text-sm font-semibold text-ink">{account.name}</p>
                  <p className="text-xs capitalize text-muted">{account.account_type.replace('_', ' ')}</p>
                  <div className="flex flex-wrap items-center gap-2">
                    <AccountRoleBadge account={account} />
                    <TagChips tags={account.tags} />
                  </div>
                </div>
                <p
                  className={`text-base font-bold ${account.balance >= 0 ? 'text-ok' : 'text-danger'}`}
                  data-testid="household-account-balance"
                >
                  {money(account.balance, account.currency)}
                </p>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="card p-4 sm:p-5 space-y-3">
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-lg font-semibold text-ink">{formatMonth(data.month.month)}</h2>
          <MonthKindBadge kind={data.month.kind} />
        </div>
        <MonthLines row={data.month} />
      </section>

      <section className="card p-4 sm:p-5 space-y-3">
        <h2 className="text-lg font-semibold text-ink">Next 30 days</h2>
        <UpcomingList items={data.upcoming} />
      </section>
    </div>
  )
}
