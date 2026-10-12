import { isLimitedEvent, upcomingItemAmount } from '@tally-trace/shared'
import { useGetHouseholdUpcomingQuery } from '../../store/api'
import type { UpcomingItemOrEvent } from '../../store/api'
import { useCurrency } from '../../hooks/useCurrency'
import { apiErrorMessage } from '../../utils/apiError'
import { formatDay, money } from './format'

/**
 * Upcoming items, each at its face amount (a Household bill on an account outside the view
 * moves none of the viewer's cash, so its cash effect is 0 and is never what is listed).
 * Each item shows in its own currency; the caller's default currency is only a fallback
 * for a full item from an older API that sends none.
 */
export function UpcomingList({ items }: { items: UpcomingItemOrEvent[] }) {
  const { currencyCode } = useCurrency()
  if (items.length === 0) {
    return <p className="text-sm text-muted" data-testid="household-upcoming-empty">Nothing due.</p>
  }
  return (
    <ul className="divide-y divide-line border border-line" data-testid="household-upcoming">
      {items.map((item, index) => {
        const limited = isLimitedEvent(item)
        const name = limited ? item.display_name : item.name
        const date = limited ? item.date : item.due_date
        const { amount, direction } = upcomingItemAmount(item)
        const itemCurrency = item.currency ?? currencyCode
        const occurrence = limited ? item.kind === 'household' : item.household_occurrence === true
        // A Household bill's account is a neutral label, so only its note is shown.
        const account = limited && !occurrence ? item.account : null
        const overdue = limited && item.overdue
        return (
          <li
            key={limited ? item.public_id : `${item.source}-${item.source_id ?? 'x'}-${date}-${index}`}
            className="flex flex-wrap items-center justify-between gap-3 px-3 py-2"
            data-testid="household-upcoming-item"
            data-household-occurrence={occurrence ? 'true' : 'false'}
          >
            <div>
              <p className="text-sm font-semibold text-ink">{name}</p>
              <p className="text-xs text-muted">
                {formatDay(date)}
                {account ? ` · ${account.name}` : ''}
                {overdue ? ' · Overdue' : ''}
                {occurrence ? ' · Household bill on another account' : ''}
              </p>
            </div>
            <p
              className={`text-sm font-semibold ${direction === 'in' ? 'text-ok' : 'text-ink'}`}
              data-testid="household-upcoming-amount"
            >
              {money(amount, itemCurrency)}
            </p>
          </li>
        )
      })}
    </ul>
  )
}

export function HouseholdUpcomingTab({ sharerId }: { sharerId: number }) {
  const { data, isLoading, error } = useGetHouseholdUpcomingQuery({ sharerId, days: 30 })
  if (isLoading) return <p className="text-sm text-muted">Loading...</p>
  if (error || !data) {
    return (
      <p className="text-sm text-danger" role="alert">
        {apiErrorMessage(error) || 'Could not load what is due.'}
      </p>
    )
  }
  return (
    <section className="card p-4 sm:p-5 space-y-3" data-testid="household-upcoming-tab">
      <h2 className="text-lg font-semibold text-ink">Next {data.days} days</h2>
      <UpcomingList items={data.items} />
    </section>
  )
}
