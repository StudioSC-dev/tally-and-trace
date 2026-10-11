// ─── Shared-account access ───────────────────────────────────────────────────
// Every record and account response carries server-computed flags. Controls follow
// those flags only, never the record's `view` (a creator demoted to viewer still
// gets the full shape, with every write flag false).

/** How much of a record the caller sees. */
export type RecordView = 'full' | 'shared_full' | 'limited'

/** What the caller may do to one transaction or recurring entry. */
export interface RecordPermissions {
  can_edit: boolean
  can_delete: boolean
  can_post: boolean
  can_revert: boolean
  can_tag: boolean
}

/**
 * The caller's role on an account. `tag_viewer`: reached only through someone's
 * Household tag share; read-only, with every permission false and only the account's
 * name, type, currency, balance, owner and tags.
 */
export type AccountRole = 'owner' | 'admin' | 'editor' | 'viewer' | 'tag_viewer'

/** What the caller may do on one account. */
export interface AccountPermissions {
  /** Owner or admin: name, balance, terms and other settings (never `is_active`). */
  can_edit_settings: boolean
  can_manage_shares: boolean
  can_add_transactions: boolean
  /** Owner only: delete the account or mark it inactive (send `is_active`). */
  can_delete: boolean
}

/**
 * An account a record touches. `{ id, name }` when the caller can view it, otherwise
 * `{ id: null, name }` with a neutral name ("Other account", "Loan payment" or
 * "Card payment"). Never link to an account whose `id` is null.
 */
export interface AccountRef {
  id: number | null
  name: string
}

/** Roles a share can grant. The owner is never a share. */
export type ShareRole = 'viewer' | 'editor' | 'admin'

/** GET /users/lookup?email= (exact match only; otherwise 404 "No matching user"). */
export interface UserMatch {
  id: number
  display_name: string
}

/**
 * POST /accounts/{id}/shares. The person is named by exact email (case-insensitive),
 * through the same rate-limited lookup as GET /users/lookup: no match answers 404
 * "No matching user", and every POST counts toward the caller's 429 limit.
 */
export interface ShareCreate {
  email: string
  role: ShareRole
}

/** PATCH /accounts/{id}/shares/{share_id}. */
export interface ShareUpdate {
  role: ShareRole
}

export interface AccountShare {
  id: number
  account_id: number
  user_id: number
  display_name: string | null
  role: ShareRole
  created_at: string | null
}

export interface AccountOwner {
  user_id: number
  display_name: string | null
  role: 'owner'
}

/** GET /accounts/{id}/shares (owner or admin). */
export interface AccountShares {
  account_id: number
  owner: AccountOwner
  shares: AccountShare[]
}

/** GET /shares/received: an account someone shared with the caller. */
export interface ReceivedShare {
  id: number
  account_id: number
  account_name: string
  owner_name: string | null
  role: ShareRole
  created_at: string | null
}

// ─── Household tag shares ────────────────────────────────────────────────────

/**
 * POST /tags/household/shares. The person is named by exact email, through the same
 * rate-limited lookup as GET /users/lookup: no match answers 404 "No matching user",
 * yourself or a duplicate 409, and too many lookups 429. Demo users get 403.
 */
export interface HouseholdShareCreate {
  email: string
}

/** One person who holds the caller's Household tag (read-only access to what it tags). */
export interface HouseholdShare {
  id: number
  tag_id: number
  user_id: number
  display_name: string | null
  created_at: string | null
}

/** GET /tags/household/shares (the tag's owner only). */
export interface HouseholdShares {
  tag_id: number
  shares: HouseholdShare[]
}

/** GET /shares/received/household: a Household tag someone shared with the caller. */
export interface ReceivedHouseholdShare {
  id: number
  tag_id: number
  /** Opens that person's Household view: GET /household/{sharer_id}/... */
  sharer_id: number
  sharer_name: string | null
  created_at: string | null
}

// ─── View guards ─────────────────────────────────────────────────────────────

/** A record in the limited allowlist shape. */
export function isLimited<T extends { view: RecordView }>(record: T): record is Extract<T, { view: 'limited' }> {
  return record.view === 'limited'
}

/** An editor's or admin's view of someone else's record (no category, allocation or attachments). */
export function isSharedFull<T extends { view: RecordView }>(record: T): record is Extract<T, { view: 'shared_full' }> {
  return record.view === 'shared_full'
}

/** The creator's own full shape, including category, allocation and attachments. */
export function isOwnerFull<T extends { view: RecordView }>(record: T): record is Extract<T, { view: 'full' }> {
  return record.view === 'full'
}

/** `full` or `shared_full`: every field except the creator's private references is present. */
export function isDetailed<T extends { view: RecordView }>(record: T): record is Exclude<T, { view: 'limited' }> {
  return record.view !== 'limited'
}
