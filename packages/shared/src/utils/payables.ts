import type { PayableOrEvent } from '../types/api'

/**
 * What an upcoming payable row points at. `source_id` means a different thing per
 * source: the entry or transaction id, or, for a statement or loan, the card or loan
 * account's id. `account_id` on a payable is the funding account, so never link it.
 */
export type PayableTarget =
  | { kind: 'budget_entry'; id: number }
  | { kind: 'transaction'; id: number }
  | { kind: 'account'; source: 'statement' | 'loan'; accountId: number }
  | { kind: 'none' }

/** Limited, or no `source_id` → none. Statement/loan → the card/loan account (`source_id`, never `account_id`). */
export function payableTarget(payable: PayableOrEvent): PayableTarget {
  if (payable.view === 'limited' || payable.source_id === null) return { kind: 'none' }
  switch (payable.source) {
    case 'budget_entry':
      return { kind: 'budget_entry', id: payable.source_id }
    case 'transaction':
      return { kind: 'transaction', id: payable.source_id }
    case 'statement':
    case 'loan':
      return { kind: 'account', source: payable.source, accountId: payable.source_id }
  }
}

/** What a payable row and its read-only detail dialog may offer. */
export interface PayableActions {
  /** The row opens the detail dialog. */
  open: boolean
  /** The card or loan account to link, for a statement or loan. */
  accountId: number | null
}

/**
 * The actions for a payable target. Every target but none opens the dialog; a
 * statement or loan also links its card or loan account. Recording, editing and
 * deleting live in Allocations and on the Transactions page, never here.
 */
export function payableActions(target: PayableTarget): PayableActions {
  switch (target.kind) {
    case 'none':
      return { open: false, accountId: null }
    case 'account':
      return { open: true, accountId: target.accountId }
    case 'budget_entry':
    case 'transaction':
      return { open: true, accountId: null }
  }
}
