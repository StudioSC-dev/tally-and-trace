import type { ReactNode } from 'react'
import { createElement, Fragment } from 'react'
import type { Account, User } from '@tally-trace/shared'
import { accountSection } from '@tally-trace/shared'

/**
 * The viewer as the API names a record's creator: the first name and the last name's initial ("Mara S."). The API
 * sends creator names only, never ids, so a creator is matched to the viewer by this display name.
 */
export function viewerDisplayName(user: Pick<User, 'first_name' | 'last_name'> | null | undefined): string | null {
  if (!user) return null
  const first = (user.first_name ?? '').trim()
  const last = (user.last_name ?? '').trim()
  return last ? `${first} ${last[0]}.` : first || null
}

/** Whether an account is shared, by the one rule the Accounts page uses (`accountSection`). A missing account is not. */
export function isSharedAccount(account: Pick<Account, 'is_shared' | 'my_role'> | undefined): boolean {
  return account !== undefined && accountSection(account) === 'shared'
}

/**
 * The "by <name>" a row shows, or null. A row names its creator exactly when the creator is not the viewer or the
 * record sits on a shared account; on one's own account, in a one-person ledger, it would say the same on every row.
 * Until the viewer is known (`viewer` null) it shows nothing, rather than a name on every row.
 */
export function createdByLabel(createdBy: string | null | undefined, viewer: string | null, shared: boolean): string | null {
  if (!createdBy || viewer === null) return null
  return shared || createdBy !== viewer ? `by ${createdBy}` : null
}

/**
 * A row's facts in priority order as at most `size` items, never more lines: the facts past the last item that fits
 * are folded into it, separated by " · ".
 */
export function foldFacts(facts: readonly (ReactNode | false | null | undefined | '')[], size = 3): ReactNode[] {
  const kept = facts.filter((f): f is ReactNode => f !== false && f !== null && f !== undefined && f !== '')
  if (kept.length <= size) return kept
  const tail = kept.slice(size - 1)
  const merged = tail.flatMap((f, i) => (i === 0 ? [f] : [' · ', f]))
  return [
    ...kept.slice(0, size - 1),
    createElement('span', { key: 'folded' }, ...merged.map((n, i) => createElement(Fragment, { key: i }, n))),
  ]
}
