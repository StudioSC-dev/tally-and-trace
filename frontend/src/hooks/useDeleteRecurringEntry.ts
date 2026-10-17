import { useCallback } from 'react'
import { isLimited } from '@tally-trace/shared'
import { useDeleteBudgetEntryMutation } from '../store/api'
import type { BudgetEntry } from '../store/api'
import { apiErrorMessage } from '../utils/apiError'

/**
 * Asks before deleting a recurring entry, then deletes it. Resolves true once the
 * entry is gone; false when the caller cancelled or the delete failed (the failure
 * is alerted here). The caller closes its modal and reloads its list on true.
 */
export function useDeleteRecurringEntry() {
  const [deleteBudgetEntry] = useDeleteBudgetEntryMutation()
  return useCallback(
    async (entry: BudgetEntry): Promise<boolean> => {
      const name = isLimited(entry) ? entry.display_name : entry.name
      if (!confirm(`Delete recurring entry "${name ?? 'this entry'}"?`)) {
        return false
      }
      try {
        await deleteBudgetEntry(entry.id).unwrap()
        return true
      } catch (error) {
        console.error('Error deleting budget entry:', error)
        // E.g. 409: it has linked transactions the caller can't edit.
        alert(apiErrorMessage(error) || 'Could not delete the recurring entry. Please try again.')
        return false
      }
    },
    [deleteBudgetEntry]
  )
}
