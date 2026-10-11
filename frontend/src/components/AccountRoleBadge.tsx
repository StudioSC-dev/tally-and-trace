import type { Account } from '../store/api'

const ROLE_LABELS: Record<Account['my_role'], string> = {
  owner: 'Owner',
  admin: 'Admin',
  editor: 'Editor',
  viewer: 'Viewer',
}

/**
 * Marks an account somebody shared with the caller: the caller's role and the
 * owner's name. Renders nothing for the caller's own accounts.
 */
export function AccountRoleBadge({ account }: { account: Pick<Account, 'my_role' | 'owner_name'> }) {
  if (account.my_role === 'owner') return null
  return (
    <span
      className="inline-flex items-center gap-1.5 rounded-full border border-line px-2 py-1 text-xs text-body"
      data-testid="account-role-badge"
      data-role={account.my_role}
    >
      <span className="font-semibold text-ink">{ROLE_LABELS[account.my_role]}</span>
      {account.owner_name && <span className="text-muted">Shared by {account.owner_name}</span>}
    </span>
  )
}
