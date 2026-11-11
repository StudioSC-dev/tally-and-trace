import { isOwnerFull } from '../types/access'
import type { Transaction, TransactionType } from '../types/api'

/**
 * Whether Edit Transaction may offer "Make this repeat". Only the owner's own row
 * (`full`) with edit rights, never a transfer (as stored or as being edited), and
 * never a row already linked to a recurring entry.
 */
export function canMakeRepeat(
  txn: Transaction,
  formType: TransactionType,
): boolean {
  return (
    isOwnerFull(txn)
    && txn.permissions.can_edit
    && txn.transaction_type !== 'transfer'
    && formType !== 'transfer'
    && txn.budget_entry_id == null
  )
}
