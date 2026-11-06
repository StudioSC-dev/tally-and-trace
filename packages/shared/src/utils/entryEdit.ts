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

/** What the form's Settlement control shows for the entry as filled in. */
export interface SettlementControlState {
  /** False for income, a transfer, a card entry or no account yet: those name no settlement. */
  shown: boolean
  /** Why the control is off, in plain words; null when it can be used. */
  disabledReason: string | null
}

/**
 * Whether the recurring form offers the Settlement control: only a cash expense, meaning a
 * non-card expense that is not a transfer. A card subscription, a card bill, a transfer and
 * income show none (their rows read "Scheduled"); a card installment keeps its own review.
 * A spending wallet, a currency that differs from the account's and a paused entry show it
 * off, with the reason.
 */
export function settlementControlState(input: {
  entryType: 'income' | 'expense'
  transferToAccountId?: number | null
  account: { account_type: string; currency: string; is_spending_wallet?: boolean } | undefined
  currency: string
  isActive: boolean
}): SettlementControlState {
  const { entryType, transferToAccountId, account } = input
  if (entryType !== 'expense' || transferToAccountId || !account || account.account_type === 'credit') {
    return { shown: false, disabledReason: null }
  }
  if (account.is_spending_wallet) return { shown: true, disabledReason: 'Spending from a wallet cannot be paid by autopay.' }
  if (input.currency !== account.currency) {
    return { shown: true, disabledReason: 'This is in a different currency than the account it is paid from.' }
  }
  if (!input.isActive) return { shown: true, disabledReason: 'This is paused, so it cannot be paid by autopay.' }
  return { shown: true, disabledReason: null }
}

/**
 * What to do after a save so the entry ends as picked: turn autopay on or off, or nothing.
 * `saved` is the settlement the save returned; an edit can clear the flag on its own.
 */
export function settlementFollowUp(
  pick: 'autopay' | 'manual',
  saved: 'autopay' | 'manual' | null | undefined,
): 'turn_on' | 'turn_off' | null {
  if (pick === 'autopay') return saved === 'autopay' ? null : 'turn_on'
  return saved === 'autopay' ? 'turn_off' : null
}
