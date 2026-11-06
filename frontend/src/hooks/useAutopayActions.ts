import { useCallback } from 'react'
import { catchUpText, settlementReasonText } from '@tally-trace/shared'
import {
  useLazyGetEntryAutoPostPreviewQuery,
  useLazyGetLoanAutoPostPreviewQuery,
  useSetEntryAutoPostMutation,
  useSetLoanAutoPostMutation,
} from '../store/api'
import { apiErrorMessage } from '../utils/apiError'
import { useConfirm } from './useConfirm'

export type AutopaySubject = { kind: 'entry' | 'loan'; id: number; name: string }

/**
 * How a turn on or off ended. `enabled` is the flag the server returned (never assumed);
 * null when nothing changed: the owner cancelled, or `error` says why it was refused.
 */
export interface AutopayOutcome {
  enabled: boolean | null
  error: string | null
}

/**
 * Turning autopay on or off for a cash entry or a loan. Turning on asks the server what it
 * would post first: a block is returned in plain words and nothing is sent; missed
 * payments are confirmed with their count (the count goes back as `expected_due`, so a
 * stale one is refused by the server) and post on confirm; Cancel posts nothing.
 */
export function useAutopayActions() {
  const askConfirm = useConfirm()
  const [previewEntry] = useLazyGetEntryAutoPostPreviewQuery()
  const [previewLoan] = useLazyGetLoanAutoPostPreviewQuery()
  const [setEntry] = useSetEntryAutoPostMutation()
  const [setLoan] = useSetLoanAutoPostMutation()

  const send = useCallback(
    async (subject: AutopaySubject, enabled: boolean, expectedDue?: number): Promise<boolean> => {
      const request = { id: subject.id, data: { enabled, ...(expectedDue === undefined ? {} : { expected_due: expectedDue }) } }
      const result = await (subject.kind === 'entry' ? setEntry(request) : setLoan(request)).unwrap()
      // A Limited entry carries no flag; the caller never sees one here, as only an editor can toggle.
      return 'auto_post_enabled' in result && result.auto_post_enabled === true
    },
    [setEntry, setLoan],
  )

  const turnOn = useCallback(
    async (subject: AutopaySubject): Promise<AutopayOutcome> => {
      try {
        // Always a fresh read: the count is what the owner confirms.
        const preview = await (subject.kind === 'entry' ? previewEntry(subject.id, false) : previewLoan(subject.id, false)).unwrap()
        if (preview.block !== null) return { enabled: null, error: settlementReasonText(preview.block) }
        if (preview.due_count === 0) return { enabled: await send(subject, true, 0), error: null }
        const done: { enabled: boolean | null } = { enabled: null }
        const accepted = await askConfirm({
          title: `Turn on autopay: ${subject.name}`,
          message: catchUpText(preview.due_count),
          confirmLabel: 'Turn on autopay',
          tone: 'default',
          errorFallback: 'Could not turn on autopay. Please try again.',
          action: async () => {
            done.enabled = await send(subject, true, preview.due_count)
          },
        })
        return { enabled: accepted ? done.enabled : null, error: null }
      } catch (error) {
        return { enabled: null, error: apiErrorMessage(error) || 'Could not turn on autopay. Please try again.' }
      }
    },
    [askConfirm, previewEntry, previewLoan, send],
  )

  const turnOff = useCallback(
    async (subject: AutopaySubject): Promise<AutopayOutcome> => {
      try {
        return { enabled: await send(subject, false), error: null }
      } catch (error) {
        return { enabled: null, error: apiErrorMessage(error) || 'Could not turn off autopay. Please try again.' }
      }
    },
    [send],
  )

  return { turnOn, turnOff }
}
