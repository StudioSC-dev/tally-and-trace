/**
 * Whether the general edit form must leave `amount`, `currency` and `exchange_rate` out of
 * the save. A foreign debit or credit (its face currency differs from the account's) stores
 * the actual figure in `amount` once posted and keeps it across reverts, so a save that does
 * not post the row must not overwrite it with the projected figure.
 */
export const keepsRetainedActual = (args: {
  /** The row is being edited (not created). */
  editing: boolean
  /** The account was not changed in the form. */
  sameAccount: boolean
  isPosted: boolean
  transactionType: string
  accountCurrency: string
  /** `projected_currency ?? currency` of the row. */
  faceCurrency: string
}): boolean =>
  args.editing &&
  args.sameAccount &&
  !args.isPosted &&
  args.transactionType !== 'transfer' &&
  args.faceCurrency !== args.accountCurrency
