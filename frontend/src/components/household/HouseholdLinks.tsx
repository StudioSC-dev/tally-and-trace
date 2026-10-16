import { Link } from '@tanstack/react-router'
import { useGetHouseholdViewsQuery } from '../../store/api'

/**
 * Links to the read-only Household views (your own is always one, then each one shared
 * with you) and to the Household sharing settings. Renders nothing until there is a view.
 */
export function HouseholdLinks() {
  const { data: views } = useGetHouseholdViewsQuery()
  if (!views || views.length === 0) return null

  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm" data-testid="household-links">
      {views.map((view) => (
        <Link
          key={view.sharer_id}
          to="/accounts/household"
          search={{ sharer: view.sharer_id }}
          className="text-ink underline underline-offset-2 focus-ring"
          data-testid={`household-link-${view.sharer_id}`}
        >
          {view.is_self ? 'Your Household' : `${view.sharer_name}'s Household`}
        </Link>
      ))}
      <Link
        to="/settings"
        hash="household-sharing"
        className="text-muted underline underline-offset-2 hover:text-ink focus-ring"
        data-testid="household-manage-link"
      >
        Manage Household sharing
      </Link>
    </div>
  )
}
