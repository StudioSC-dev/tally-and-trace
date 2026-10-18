import type { RecordPermissions, RecordView } from '../types/access'
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

/** What a payable row and its detail dialog may offer. */
export interface PayableActions {
  /** The row opens the detail dialog. */
  open: boolean
  edit: boolean
  delete: boolean
  /** Budget entries only. */
  markPaid: boolean
  /** The card or loan account to link, for a statement or loan. */
  accountId: number | null
}

const NO_ACTIONS: PayableActions = { open: false, edit: false, delete: false, markPaid: false, accountId: null }

/**
 * The actions for a payable target. `record` is the looked-up entry or transaction;
 * undefined or null means not loaded yet, or gone, so the row is view only. Controls
 * follow the permission flags, never `view`, except that a Limited record offers none.
 */
export function payableActions(
  target: PayableTarget,
  record: { view: RecordView; permissions: RecordPermissions } | null | undefined,
): PayableActions {
  switch (target.kind) {
    case 'none':
      return NO_ACTIONS
    case 'account':
      return { ...NO_ACTIONS, open: true, accountId: target.accountId }
    case 'budget_entry':
    case 'transaction': {
      if (!record || record.view === 'limited') return { ...NO_ACTIONS, open: true }
      const { can_edit, can_delete, can_post } = record.permissions
      return {
        open: true,
        edit: can_edit,
        delete: can_delete,
        markPaid: target.kind === 'budget_entry' && can_post,
        accountId: null,
      }
    }
  }
}
