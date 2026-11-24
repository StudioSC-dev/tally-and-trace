/** The saved row an Edit starts from: its posted state and stored posting date. */
export interface PostingDateEditing {
  isPosted: boolean
  postingDate?: string | null
}

/**
 * The `posting_date` a transaction form sends: an ISO instant, `null` to clear the stored
 * one, or `undefined` to leave it out (a `PUT` then keeps the stored value).
 *
 * - A typed day is sent as UTC midnight of that day.
 * - A blank day on a row being posted (Create, or an Edit of a pending row) is stamped `now`.
 * - A blank day on a row that was already posted is left out when the row had none, and
 *   cleared when the user emptied a stored one: a stamped `now` would move a billed card
 *   row onto the next statement (STU-784).
 * - Unposting a row with a stored posting date clears it; any other unposted save leaves
 *   it out.
 */
export function postingDateField(
  isPosted: boolean,
  postingDate: string | undefined,
  editing: PostingDateEditing | null,
  now: Date = new Date(),
): string | null | undefined {
  if (isPosted && postingDate) return new Date(postingDate).toISOString()
  if (isPosted && !editing?.isPosted) return now.toISOString()
  if (editing?.isPosted && editing.postingDate) return null
  return undefined
}
