import { useState } from 'react'
import {
  useCreateAccountShareMutation,
  useDeleteAccountShareMutation,
  useGetAccountSharesQuery,
  useLazyLookupUserQuery,
  useUpdateAccountShareMutation,
} from '../store/api'
import type { Account, AccountShare, ShareRole, UserMatch } from '../store/api'
import { apiErrorMessage, apiErrorStatus } from '../utils/apiError'

const ROLE_LABELS: Record<ShareRole, string> = {
  viewer: 'Viewer',
  editor: 'Editor',
  admin: 'Admin',
}

const ROLE_HINTS: Record<ShareRole, string> = {
  viewer: 'Can see the account and its records. Records that touch your other accounts show only neutral details.',
  editor: 'Can add, edit, post and delete transactions on this account.',
  admin: 'Can also change account settings and manage who it is shared with.',
}

/** The roles the caller may grant: only the owner grants admin. */
const grantableRoles = (myRole: Account['my_role']): ShareRole[] =>
  myRole === 'owner' ? ['viewer', 'editor', 'admin'] : ['viewer', 'editor']

const lookupErrorMessage = (error: unknown): string => {
  if (apiErrorStatus(error) === 429) return 'Too many lookups, try again shortly'
  if (apiErrorStatus(error) === 404) return 'No matching user'
  return apiErrorMessage(error) || 'Could not look that user up. Try again.'
}

/**
 * Manage who an account is shared with (owner or admin). A person is found by their
 * exact email; the answer is only their display name, and every miss gets the same
 * message, so the lookup can't be used to discover who has an account.
 */
export function ShareDialog({ account, onClose }: { account: Account; onClose: () => void }) {
  const { data, isLoading, error: loadError } = useGetAccountSharesQuery(account.id)
  const [lookupUser, { isFetching: isLooking }] = useLazyLookupUserQuery()
  const [createShare, { isLoading: isCreating }] = useCreateAccountShareMutation()
  const [updateShare] = useUpdateAccountShareMutation()
  const [deleteShare] = useDeleteAccountShareMutation()

  const [email, setEmail] = useState('')
  const [match, setMatch] = useState<UserMatch | null>(null)
  // The exact email the match was found by: the share is created by it, not by id.
  const [matchedEmail, setMatchedEmail] = useState('')
  const [lookupError, setLookupError] = useState<string | null>(null)
  const [role, setRole] = useState<ShareRole>('viewer')
  const [actionError, setActionError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const roles = grantableRoles(account.my_role)

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
      await createShare({ accountId: account.id, data: { email: matchedEmail, role } }).unwrap()
      setNotice(`Shared with ${match.display_name} as ${ROLE_LABELS[role].toLowerCase()}.`)
      setMatch(null)
      setMatchedEmail('')
      setEmail('')
      setRole('viewer')
    } catch (error) {
      setActionError(
        apiErrorStatus(error) === 404 || apiErrorStatus(error) === 429
          ? lookupErrorMessage(error)
          : apiErrorMessage(error) || 'Could not share the account. Try again.',
      )
    }
  }

  const handleRoleChange = async (share: AccountShare, next: ShareRole) => {
    if (next === share.role) return
    const name = share.display_name ?? 'this person'
    if (!confirm(`Change ${name} from ${ROLE_LABELS[share.role].toLowerCase()} to ${ROLE_LABELS[next].toLowerCase()}?`)) {
      return
    }
    setActionError(null)
    setNotice(null)
    try {
      await updateShare({ accountId: account.id, shareId: share.id, data: { role: next } }).unwrap()
    } catch (error) {
      setActionError(apiErrorMessage(error) || 'Could not change the role. Try again.')
    }
  }

  const handleRemove = async (share: AccountShare) => {
    const name = share.display_name ?? 'this person'
    if (!confirm(`Stop sharing ${account.name} with ${name}? They lose access to it straight away.`)) return
    setActionError(null)
    setNotice(null)
    try {
      await deleteShare({ accountId: account.id, shareId: share.id }).unwrap()
    } catch (error) {
      setActionError(apiErrorMessage(error) || 'Could not remove the share. Try again.')
    }
  }

  // An admin can't change or remove the owner or another admin.
  const canChange = (share: AccountShare) => account.my_role === 'owner' || share.role !== 'admin'

  return (
    <div
      className="fixed inset-0 z-[60] overflow-y-auto bg-black/60 px-4 py-6"
      onClick={onClose}
      data-testid="share-dialog"
    >
      <div className="min-h-full flex items-center justify-center">
        <div
          className="w-full max-w-lg bg-surface p-6 border border-line"
          role="dialog"
          aria-label={`Share ${account.name}`}
          onClick={(event) => event.stopPropagation()}
        >
          <div className="flex items-start justify-between gap-4">
            <div>
              <h2 className="text-xl font-semibold text-ink">Share {account.name}</h2>
              <p className="text-sm text-muted">Choose who can see or work on this account.</p>
            </div>
            <button
              type="button"
              onClick={onClose}
              className="text-muted hover:text-body transition-colors duration-200"
              aria-label="Close share dialog"
            >
              <svg className="h-6 w-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>

          {isLoading && <p className="mt-4 text-sm text-muted">Loading shares...</p>}

          {loadError && (
            <p className="mt-4 text-sm text-danger" role="alert" data-testid="share-load-error">
              {apiErrorMessage(loadError) || 'Could not load who this account is shared with.'}
            </p>
          )}

          {data && (
            <>
              <div className="mt-5">
                <h3 className="text-sm font-semibold text-body">People with access</h3>
                <ul className="mt-2 divide-y divide-line border border-line" data-testid="share-list">
                  <li className="flex items-center justify-between gap-3 px-3 py-2" data-testid="share-owner-row">
                    <span className="text-sm text-ink">{data.owner.display_name ?? 'Owner'}</span>
                    <span className="text-xs font-semibold text-muted">Owner</span>
                  </li>
                  {data.shares.map((share) => (
                    <li
                      key={share.id}
                      className="flex flex-wrap items-center justify-between gap-3 px-3 py-2"
                      data-testid="share-row"
                    >
                      <span className="text-sm text-ink">{share.display_name ?? 'Unknown user'}</span>
                      {canChange(share) ? (
                        <span className="flex items-center gap-2">
                          <select
                            value={share.role}
                            onChange={(event) => handleRoleChange(share, event.target.value as ShareRole)}
                            className="select-field focus-ring py-1 text-sm"
                            aria-label={`Role for ${share.display_name ?? 'this person'}`}
                            data-testid="share-row-role"
                          >
                            {/* Keep the current role selectable even when the caller couldn't grant it. */}
                            {(roles.includes(share.role) ? roles : [...roles, share.role]).map((value) => (
                              <option key={value} value={value}>
                                {ROLE_LABELS[value]}
                              </option>
                            ))}
                          </select>
                          <button
                            type="button"
                            onClick={() => handleRemove(share)}
                            className="btn-secondary focus-ring text-sm"
                            data-testid="share-remove"
                          >
                            Remove
                          </button>
                        </span>
                      ) : (
                        <span className="text-xs font-semibold text-muted">{ROLE_LABELS[share.role]}</span>
                      )}
                    </li>
                  ))}
                  {data.shares.length === 0 && (
                    <li className="px-3 py-2 text-sm text-muted">Not shared with anyone yet.</li>
                  )}
                </ul>
              </div>

              <form onSubmit={handleLookup} className="mt-6 space-y-3" data-testid="share-add-form">
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
                    aria-label="Email address of the person to share with"
                    data-testid="share-email"
                    autoComplete="off"
                  />
                  <button
                    type="submit"
                    disabled={isLooking}
                    className="btn-secondary focus-ring"
                    data-testid="share-lookup"
                  >
                    {isLooking ? 'Looking up...' : 'Look up'}
                  </button>
                </div>
                {lookupError && (
                  <p className="text-sm text-danger" role="alert" data-testid="share-lookup-error">
                    {lookupError}
                  </p>
                )}
                {match && (
                  <div className="space-y-3 border border-line p-3" data-testid="share-match">
                    <p className="text-sm text-ink">
                      Found <span className="font-semibold" data-testid="share-match-name">{match.display_name}</span>
                    </p>
                    <div>
                      <label className="label" htmlFor="share-role">
                        Role
                      </label>
                      <select
                        id="share-role"
                        value={role}
                        onChange={(event) => setRole(event.target.value as ShareRole)}
                        className="select-field focus-ring"
                        data-testid="share-role"
                      >
                        {roles.map((value) => (
                          <option key={value} value={value}>
                            {ROLE_LABELS[value]}
                          </option>
                        ))}
                      </select>
                      <p className="mt-1 text-xs text-muted">{ROLE_HINTS[role]}</p>
                    </div>
                    <button
                      type="button"
                      onClick={handleShare}
                      disabled={isCreating}
                      className="btn-primary focus-ring"
                      data-testid="share-submit"
                    >
                      {isCreating ? 'Sharing...' : `Share with ${match.display_name}`}
                    </button>
                  </div>
                )}
              </form>
            </>
          )}

          {notice && (
            <p className="mt-4 text-sm text-ok" role="status" data-testid="share-notice">
              {notice}
            </p>
          )}
          {actionError && (
            <p className="mt-4 text-sm text-danger" role="alert" data-testid="share-error">
              {actionError}
            </p>
          )}
        </div>
      </div>
    </div>
  )
}
