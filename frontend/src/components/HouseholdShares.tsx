import { useState } from 'react'
import {
  useCreateHouseholdShareMutation,
  useDeleteHouseholdShareMutation,
  useGetHouseholdSharesQuery,
  useLazyLookupUserQuery,
} from '../store/api'
import type { HouseholdShare, UserMatch } from '../store/api'
import { apiErrorMessage, apiErrorStatus } from '../utils/apiError'

const lookupErrorMessage = (error: unknown): string => {
  if (apiErrorStatus(error) === 429) return 'Too many lookups, try again shortly'
  if (apiErrorStatus(error) === 404) return 'No matching user'
  return apiErrorMessage(error) || 'Could not look that user up. Try again.'
}

/**
 * Settings: who holds the caller's Household tag. A holder sees the accounts and records
 * tagged Household read-only, and nothing else. A person is found by their exact email;
 * every miss gets the same message, so the lookup can't be used to discover who has an
 * account. Demo accounts get a 403 from the API, shown as it is (the client has no demo flag).
 */
export function HouseholdShares() {
  const { data, isLoading, error: loadError } = useGetHouseholdSharesQuery()
  const [lookupUser, { isFetching: isLooking }] = useLazyLookupUserQuery()
  const [createShare, { isLoading: isCreating }] = useCreateHouseholdShareMutation()
  const [deleteShare] = useDeleteHouseholdShareMutation()

  const [email, setEmail] = useState('')
  const [match, setMatch] = useState<UserMatch | null>(null)
  // The exact email the match was found by: the share is created by it, not by id.
  const [matchedEmail, setMatchedEmail] = useState('')
  const [lookupError, setLookupError] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const handleLookup = async (event: React.FormEvent) => {
    event.preventDefault()
    setMatch(null)
    setLookupError(null)
    setActionError(null)
    setNotice(null)
    const trimmed = email.trim()
    if (!trimmed) {
      setLookupError('Enter the email address of the person to share with.')
      return
    }
    try {
      const found = await lookupUser(trimmed).unwrap()
      setMatch(found)
      setMatchedEmail(trimmed)
    } catch (error) {
      setLookupError(lookupErrorMessage(error))
    }
  }

  const handleShare = async () => {
    if (!match) return
    setActionError(null)
    try {
      await createShare({ email: matchedEmail }).unwrap()
      setNotice(`Household shared with ${match.display_name}.`)
      setMatch(null)
      setMatchedEmail('')
      setEmail('')
    } catch (error) {
      setActionError(
        apiErrorStatus(error) === 404 || apiErrorStatus(error) === 429
          ? lookupErrorMessage(error)
          : apiErrorMessage(error) || 'Could not share your Household. Try again.',
      )
    }
  }

  const handleRemove = async (share: HouseholdShare) => {
    const name = share.display_name ?? 'this person'
    if (!confirm(`Stop sharing your Household with ${name}? They lose sight of your Household accounts and records straight away.`)) {
      return
    }
    setActionError(null)
    setNotice(null)
    try {
      await deleteShare(share.id).unwrap()
    } catch (error) {
      setActionError(apiErrorMessage(error) || 'Could not remove the share. Try again.')
    }
  }

  return (
    <section id="household-sharing" className="bg-surface border border-line" data-testid="household-shares">
      <div className="p-4 sm:p-6 border-b border-line">
        <h2 className="text-lg font-semibold text-ink">Household sharing</h2>
        <p className="text-sm text-muted">
          Share your Household tag with someone, by their email. They can see your Household-tagged accounts, their
          balances and your Household-tagged transactions and recurring entries, read-only: they can&apos;t change
          anything, and they see nothing that isn&apos;t tagged Household.
        </p>
      </div>

      {isLoading && <p className="p-4 sm:p-6 text-sm text-muted">Loading...</p>}

      {loadError && (
        <p className="p-4 sm:p-6 text-sm text-danger" role="alert" data-testid="household-shares-load-error">
          {apiErrorMessage(loadError) || 'Could not load who your Household is shared with.'}
        </p>
      )}

      {data && (
        <div className="p-4 sm:p-6 space-y-6">
          <div>
            <h3 className="text-sm font-semibold text-body">People who can see your Household</h3>
            <ul className="mt-2 divide-y divide-line border border-line" data-testid="household-share-list">
              {data.shares.map((share) => (
                <li
                  key={share.id}
                  className="flex flex-wrap items-center justify-between gap-3 px-3 py-2"
                  data-testid="household-share-row"
                >
                  <span className="text-sm text-ink">{share.display_name ?? 'Unknown user'}</span>
                  <button
                    type="button"
                    onClick={() => handleRemove(share)}
                    className="btn-secondary focus-ring text-sm"
                    data-testid="household-share-remove"
                  >
                    Remove
                  </button>
                </li>
              ))}
              {data.shares.length === 0 && (
                <li className="px-3 py-2 text-sm text-muted" data-testid="household-share-empty">
                  Not shared with anyone yet.
                </li>
              )}
            </ul>
          </div>

          <form onSubmit={handleLookup} className="space-y-3" data-testid="household-share-add-form">
            <h3 className="text-sm font-semibold text-body">Add a person</h3>
            <div className="flex flex-col gap-2 sm:flex-row">
              <input
                type="email"
                value={email}
                onChange={(event) => {
                  setEmail(event.target.value)
                  setMatch(null)
                  setLookupError(null)
                }}
                className="input-field focus-ring flex-1"
                placeholder="Their exact email address"
                aria-label="Email address of the person to share your Household with"
                data-testid="household-share-email"
                autoComplete="off"
              />
              <button
                type="submit"
                disabled={isLooking}
                className="btn-secondary focus-ring"
                data-testid="household-share-lookup"
              >
                {isLooking ? 'Looking up...' : 'Look up'}
              </button>
            </div>
            {lookupError && (
              <p className="text-sm text-danger" role="alert" data-testid="household-share-lookup-error">
                {lookupError}
              </p>
            )}
            {match && (
              <div className="space-y-3 border border-line p-3" data-testid="household-share-match">
                <p className="text-sm text-ink">
                  Found{' '}
                  <span className="font-semibold" data-testid="household-share-match-name">
                    {match.display_name}
                  </span>
                </p>
                <button
                  type="button"
                  onClick={handleShare}
                  disabled={isCreating}
                  className="btn-primary focus-ring"
                  data-testid="household-share-submit"
                >
                  {isCreating ? 'Sharing...' : `Share Household with ${match.display_name}`}
                </button>
              </div>
            )}
          </form>

          {notice && (
            <p className="text-sm text-ok" role="status" data-testid="household-share-notice">
              {notice}
            </p>
          )}
          {actionError && (
            <p className="text-sm text-danger" role="alert" data-testid="household-share-error">
              {actionError}
            </p>
          )}
        </div>
      )}
    </section>
  )
}
