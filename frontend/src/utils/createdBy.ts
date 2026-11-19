import type { Account, User } from '@tally-trace/shared'

/** The viewer as the API names a record's creator: the first name and the last name's initial ("Mara S."). */
export function viewerDisplayName(user: Pick<User, 'first_name' | 'last_name'> | null | undefined): string | null {
  if (!user) return null
  const first = (user.first_name ?? '').trim()
  const last = (user.last_name ?? '').trim()
  return last ? `${first} ${last[0]}.` : first || null
}

/** Whether an account is shared: the owner shares it out, or someone else owns it and shares it with the viewer. */
export function isSharedAccount(account: Pick<Account, 'is_shared' | 'my_role'> | undefined): boolean {
  if (!account) return false
  return account.is_shared === true || (account.my_role !== undefined && account.my_role !== 'owner')
}

/**
 * The "by <name>" a row shows, or null. A row names its creator exactly when the creator is not the viewer or the
 * record sits on a shared account; on one's own account, in a one-person ledger, it would say the same on every row.
 */
export function createdByLabel(createdBy: string | null | undefined, viewer: string | null, shared: boolean): string | null {
  if (!createdBy) return null
  return shared || createdBy !== viewer ? `by ${createdBy}` : null
}

/** The facts of a row in priority order, split into lines of at most `size` items: the first line is the row's meta. */
export function chunkFacts<T>(facts: readonly (T | false | null | undefined | '')[], size = 3): T[][] {
  const kept = facts.filter((f): f is T => f !== false && f !== null && f !== undefined && f !== '')
  const lines: T[][] = []
  for (let i = 0; i < kept.length; i += size) lines.push(kept.slice(i, i + size))
  return lines
}
