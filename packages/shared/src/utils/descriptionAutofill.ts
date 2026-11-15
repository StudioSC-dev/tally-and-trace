// Description autofill in Add Transaction (STU-626).
//
// While the user types a Description, the form lists the matching descriptions they used
// before (GET /transactions/description-suggestions, most recent first, up to 8). Picking
// one, or leaving the field on an exact match (case-insensitive), fills the other fields
// from the latest transaction with that description: its type, account, category, tags
// and, for a transfer, its from and to accounts. Never the amount, never Description, and
// never a field the user already changed in this form. A value the user can no longer use
// (an account they can't add to, a deleted category, a tag that is gone) is skipped: the
// account keeps what it has, any other field the user has not changed goes blank, so an
// earlier suggestion's value never stays behind. Edit Transaction never autofills.
import type { TransactionType } from '../types/api'

/** One suggestion: a description and the latest such transaction's usable values. */
export type DescriptionSuggestion = {
  description: string
  transaction_type: TransactionType
  account_id: number | null
  category_id: number | null
  tag_ids: number[]
  transfer_from_account_id: number | null
  transfer_to_account_id: number | null
}

/** The fields autofill may change, and the only ones the form tracks as changed by the user. */
export const AUTOFILL_FIELDS = [
  'transaction_type',
  'account_id',
  'category_id',
  'tag_ids',
  'transfer_from_account_id',
  'transfer_to_account_id',
] as const
export type AutofillField = (typeof AUTOFILL_FIELDS)[number]

/** The part of the transaction form autofill reads and writes. */
export type AutofillForm = {
  transaction_type: TransactionType
  account_id: number
  category_id?: number
  tag_ids: number[]
  transfer_from_account_id?: number
  transfer_to_account_id?: number
}

/** What the user can still use in the form (its pickers' options). */
export type AutofillUsable = {
  account: (id: number) => boolean
  /** Whether the category can go on a transaction of `type` (its kind fits). */
  category: (id: number, type: TransactionType) => boolean
  tag: (id: number) => boolean
}

/** The key two descriptions match on: trimmed, case folded. */
export const descriptionKey = (value: string): string => value.trim().toLowerCase()

/** The suggestion whose description is exactly `value`, ignoring case and outer spaces. */
export function exactSuggestion(
  suggestions: readonly DescriptionSuggestion[],
  value: string,
): DescriptionSuggestion | undefined {
  const key = descriptionKey(value)
  if (!key) return undefined
  return suggestions.find((s) => descriptionKey(s.description) === key)
}

/**
 * The changes autofill makes to `form` from `suggestion`: only fields not in `changed`,
 * only to values the user can use. The result holds no other key, so spreading it over the
 * form leaves the amount, Description and every other field as they are.
 */
export function autofillPatch<F extends AutofillForm>(
  form: F,
  suggestion: DescriptionSuggestion,
  changed: ReadonlySet<AutofillField>,
  usable: AutofillUsable,
): Partial<Pick<F, AutofillField>> {
  const patch: Partial<AutofillForm> = {}
  const free = (field: AutofillField) => !changed.has(field)
  if (free('transaction_type')) patch.transaction_type = suggestion.transaction_type
  const type = patch.transaction_type ?? form.transaction_type
  const transfer = type === 'transfer'
  const okAccount = (id: number | null): id is number => id !== null && usable.account(id)

  // A transfer's account is its source: the form keeps both in step, so the source is the
  // account the form ends up with (the user's pick, else the suggestion's), never a hidden other.
  const source = transfer ? suggestion.transfer_from_account_id ?? suggestion.account_id : suggestion.account_id
  if (free('account_id') && okAccount(source)) patch.account_id = source
  const account = patch.account_id ?? form.account_id
  // A field the user has not changed takes the suggestion's usable value, or goes blank when
  // there is none, so an earlier suggestion's value never stays behind. The account itself is
  // required and kept (its picker has no blank).
  if (free('transfer_from_account_id')) patch.transfer_from_account_id = transfer && account ? account : undefined
  if (free('transfer_to_account_id')) {
    const to = suggestion.transfer_to_account_id
    patch.transfer_to_account_id = transfer && okAccount(to) && to !== account ? to : undefined
  }
  if (free('category_id')) {
    const id = suggestion.category_id
    patch.category_id = id !== null && usable.category(id, type) ? id : undefined
  }
  if (free('tag_ids')) patch.tag_ids = suggestion.tag_ids.filter((id) => usable.tag(id))
  return patch as Partial<Pick<F, AutofillField>>
}

/**
 * Latest-wins for the suggestion requests: each request takes a ticket for the Description
 * value it asked about, and its answer is used only while it is the newest ticket and that
 * value is still the Description. A late answer for an earlier value is dropped.
 */
export function createLatestGate() {
  let issued = 0
  return {
    /** A ticket for a request about `value`. */
    next(value: string): { id: number; key: string } {
      issued += 1
      return { id: issued, key: descriptionKey(value) }
    },
    /** Whether the answer to `ticket` may be used now that the Description is `current`. */
    accepts(ticket: { id: number; key: string }, current: string): boolean {
      return ticket.id === issued && ticket.key === descriptionKey(current)
    },
    /** Drop every ticket issued so far (the form was reset or closed). */
    reset() {
      issued += 1
    },
  }
}
export type LatestGate = ReturnType<typeof createLatestGate>
