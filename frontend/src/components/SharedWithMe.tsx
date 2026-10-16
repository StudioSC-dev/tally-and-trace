import { useState } from 'react'
import { Link } from '@tanstack/react-router'
import {
  useGetReceivedHouseholdSharesQuery,
  useGetReceivedSharesQuery,
  useLeaveHouseholdShareMutation,
  useLeaveShareMutation,
} from '../store/api'
import type { ReceivedHouseholdShare, ReceivedShare, ShareRole } from '../store/api'
import { apiErrorMessage } from '../utils/apiError'

const ROLE_LABELS: Record<ShareRole, string> = { viewer: 'Viewer', editor: 'Editor', admin: 'Admin' }

/**
 * Accounts other people shared with the caller, and Household tags they shared, each with a
 * Leave control. Renders nothing when there are none.
 */
export function SharedWithMe({ onLeft }: { onLeft?: () => void }) {
  const { data: shares = [] } = useGetReceivedSharesQuery()
  const { data: householdShares = [] } = useGetReceivedHouseholdSharesQuery()
  const [leaveShare] = useLeaveShareMutation()
  const [leaveHouseholdShare] = useLeaveHouseholdShareMutation()
  const [error, setError] = useState<string | null>(null)

  if (shares.length === 0 && householdShares.length === 0 && !error) return null

  const handleLeave = async (share: ReceivedShare) => {
    const owner = share.owner_name ?? 'the owner'
    if (!confirm(`Leave ${share.account_name}? You lose access to it and to everything you can see through it.`)) {
      return
    }
    setError(null)
    try {
      await leaveShare(share.id).unwrap()
      onLeft?.()
    } catch (err) {
      setError(apiErrorMessage(err) || `Could not leave ${share.account_name} (shared by ${owner}). Try again.`)
    }
  }

  const handleLeaveHousehold = async (share: ReceivedHouseholdShare) => {
    const sharer = share.sharer_name ?? 'this person'
    if (!confirm(`Leave ${sharer}'s Household? You lose sight of their Household accounts and records.`)) return
    setError(null)
    try {
      await leaveHouseholdShare(share.id).unwrap()
      onLeft?.()
    } catch (err) {
      setError(apiErrorMessage(err) || `Could not leave ${sharer}'s Household. Try again.`)
    }
  }

  return (
    <section className="card p-4 sm:p-5 space-y-3" data-testid="shared-with-me">
      <div>
        <h2 className="text-lg font-semibold text-ink">Shared with me</h2>
        <p className="text-sm text-muted">Accounts and Households other people have shared with you.</p>
      </div>
      <ul className="divide-y divide-line border border-line">
        {shares.map((share) => (
          <li
            key={share.id}
            className="flex flex-wrap items-center justify-between gap-3 px-3 py-2"
            data-testid="shared-with-me-row"
          >
            <div>
              <p className="text-sm font-semibold text-ink">{share.account_name}</p>
              <p className="text-xs text-muted">
                {ROLE_LABELS[share.role]}
                {share.owner_name ? ` · shared by ${share.owner_name}` : ''}
              </p>
            </div>
            <button
              type="button"
              onClick={() => handleLeave(share)}
              className="btn-secondary focus-ring text-sm"
              data-testid="shared-with-me-leave"
            >
              Leave
            </button>
          </li>
        ))}
        {householdShares.map((share) => (
          <li
            key={`household-${share.id}`}
            className="flex flex-wrap items-center justify-between gap-3 px-3 py-2"
            data-testid="shared-with-me-household-row"
          >
            <div>
              <p className="text-sm font-semibold text-ink">
                {share.sharer_name ? `${share.sharer_name}'s Household` : 'Household'}
              </p>
              <p className="text-xs text-muted">Read-only view of their Household accounts and records</p>
            </div>
            <div className="flex items-center gap-2">
              <Link
                to="/accounts/household"
                search={{ sharer: share.sharer_id }}
                className="btn-secondary focus-ring text-sm"
                data-testid="shared-with-me-household-open"
              >
                Open
              </Link>
              <button
                type="button"
                onClick={() => handleLeaveHousehold(share)}
                className="btn-secondary focus-ring text-sm"
                data-testid="shared-with-me-household-leave"
              >
                Leave
              </button>
            </div>
          </li>
        ))}
      </ul>
      {error && (
        <p className="text-sm text-danger" role="alert" data-testid="shared-with-me-error">
          {error}
        </p>
      )}
    </section>
  )
}
