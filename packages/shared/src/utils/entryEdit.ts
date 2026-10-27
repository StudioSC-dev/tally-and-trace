import type { BudgetEntryInput } from '../types/api'

/** The help under a capped entry's number of payments (the final-month rule). */
export const finalMonthHelp =
  'Moving the next date keeps the last payment; change this number to lengthen or shorten the plan.'

/**
 * A PUT body carrying the version of the entry the form loaded. `updated_at` is
 * sent as the server returned it, unchanged, because the server compares it
 * exactly: a string, or `null` for an entry that was never updated (the server
 * checks that too). Only a loaded entry without the property leaves the body as
 * it was, which skips the check.
 */
export function withLoadedVersion<T extends BudgetEntryInput>(
  input: T,
  loaded: { updated_at?: string | null },
): T & Pick<BudgetEntryInput, 'expected_updated_at'> {
  const version = loaded.updated_at
  if (version === undefined) return input
  return { ...input, expected_updated_at: version }
}
