import { useCallback } from 'react'
import { isLimited } from '@tally-trace/shared'
import { useDeleteBudgetEntryMutation } from '../store/api'
import type { BudgetEntry } from '../store/api'
import { useConfirm } from './useConfirm'

/**
 * Asks in the in-app dialog before deleting a recurring entry, then deletes it from
 * there. Resolves true once the entry is gone; false when the caller cancelled. A refused
 * delete (for example a 409: it has linked transactions the caller can't edit) stays in the
 * dialog with the server's reason, and the caller can retry or cancel. The caller closes
 * its modal and reloads its list on true.
 */
export function useDeleteRecurringEntry() {
  const [deleteBudgetEntry] = useDeleteBudgetEntryMutation()
  const askConfirm = useConfirm()
  return useCallback(
    async (entry: BudgetEntry): Promise<boolean> => {
      const name = isLimited(entry) ? entry.display_name : entry.name
      return askConfirm({
        title: 'Delete recurring entry',
        message: `Delete recurring entry "${name ?? 'this entry'}"?`,
        confirmLabel: 'Delete entry',
        action: () => deleteBudgetEntry(entry.id).unwrap(),
        errorFallback: 'Could not delete the recurring entry. Please try again.',
      })
    },
    [askConfirm, deleteBudgetEntry]
  )
}
