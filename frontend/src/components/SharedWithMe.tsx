import { useState } from 'react'
import { useGetReceivedSharesQuery, useLeaveShareMutation } from '../store/api'
import type { ReceivedShare, ShareRole } from '../store/api'
import { apiErrorMessage } from '../utils/apiError'

const ROLE_LABELS: Record<ShareRole, string> = { viewer: 'Viewer', editor: 'Editor', admin: 'Admin' }

/** Accounts other people shared with the caller, each with a Leave control. Renders nothing when there are none. */
export function SharedWithMe({ onLeft }: { onLeft?: () => void }) {
  const { data: shares = [] } = useGetReceivedSharesQuery()
  const [leaveShare] = useLeaveShareMutation()
  const [error, setError] = useState<string | null>(null)

  if (shares.length === 0 && !error) return null

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

  return (
    <section className="card p-4 sm:p-5 space-y-3" data-testid="shared-with-me">
      <div>
        <h2 className="text-lg font-semibold text-ink">Shared with me</h2>
        <p className="text-sm text-muted">Accounts other people have shared with you.</p>
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
      </ul>
      {error && (
        <p className="text-sm text-danger" role="alert" data-testid="shared-with-me-error">
          {error}
        </p>
      )}
    </section>
  )
}
