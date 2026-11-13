import { useCallback, useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { useDispatch, useSelector } from 'react-redux'
import type { AppDispatch, RootState } from '../../store'
import { outboxActions } from '../../store/outbox'
import { DUE_ENTRY_FORM } from '../../store/outboxForms'
import type { MarkPaidDraft } from '../../store/outboxForms'
import { apiErrorMessage } from '../../utils/apiError'
import type { RecurringAction } from '@tally-trace/shared'
import { ForceDateDialog } from '../ForceDateDialog'
import type { ForceDateTarget } from '../ForceDateDialog'
import { InstallmentReviewDialog } from '../InstallmentReviewDialog'
import { MarkPaidDialog } from '../MarkPaidDialog'

interface RecordTarget {
  entryId: number
  name: string
  occurrenceDate: string | null
  action: RecurringAction | undefined
  /** Edit on a refused background save: its input and the server's reason. */
  restore?: { draft: MarkPaidDraft; error: string }
}

interface ReviewTarget {
  entryId: number
  name: string
}

export interface OccurrenceDialogs {
  /** Open Mark paid / Mark received / Charged / Posted for an occurrence. */
  openRecord: (entryId: number, name: string, occurrenceDate: string, action: RecurringAction | undefined) => void
  /** Open the Change date dialog for an occurrence. */
  openChangeDate: (entryId: number, name: string, occurrenceDate: string, effectiveDate?: string) => void
  /** Open the installment review dialog. */
  openReview: (entryId: number, name: string) => void
  /** The open dialog, if any: render it once, in the host. */
  dialogs: ReactNode
}

/**
 * The dialogs a recurring occurrence's actions open: Mark paid (`MarkPaidDialog`), Change date
 * (`ForceDateDialog`) and installment Review (`InstallmentReviewDialog`). The Due card and the
 * Scheduled view both host them; `onChanged` runs after any of them changes a record. With
 * `background` (the Due card, STU-605) Mark paid saves through the outbox and closes at once.
 */
export function useOccurrenceDialogs(onChanged: () => void, { background = false }: { background?: boolean } = {}): OccurrenceDialogs {
  const [target, setTarget] = useState<RecordTarget | null>(null)
  // The occurrence whose date is being changed.
  const [forceTarget, setForceTarget] = useState<ForceDateTarget | null>(null)
  // The installment being reviewed.
  const [reviewTarget, setReviewTarget] = useState<ReviewTarget | null>(null)

  // The toast's Edit on a refused Mark paid (background only): the dialog reopens with what was
  // typed and the server's reason, and the failed save leaves the queue.
  const dispatch = useDispatch<AppDispatch>()
  const editEntry = useSelector((state: RootState) =>
    state.outbox.editRequest === null ? undefined : state.outbox.entries.find((e) => e.clientId === state.outbox.editRequest),
  )
  useEffect(() => {
    if (!background || !editEntry || editEntry.form !== DUE_ENTRY_FORM || editEntry.draft === null) return
    const draft = editEntry.draft as MarkPaidDraft
    const error = apiErrorMessage(editEntry.error?.raw) || editEntry.error?.message || 'Could not record the entry.'
    dispatch(outboxActions.editHandled(editEntry.clientId))
    setTarget({ entryId: draft.entryId, name: draft.name, occurrenceDate: draft.occurrenceDate, action: draft.action ?? undefined, restore: { draft, error } })
  }, [background, editEntry, dispatch])

  const openRecord = useCallback<OccurrenceDialogs['openRecord']>(
    (entryId, name, occurrenceDate, action) => setTarget({ entryId, name, occurrenceDate, action }),
    [],
  )
  const openChangeDate = useCallback<OccurrenceDialogs['openChangeDate']>(
    (entryId, name, occurrenceDate, effectiveDate) =>
      setForceTarget({ kind: 'entry', id: entryId, name, occurrenceDate, ...(effectiveDate ? { effectiveDate } : {}) }),
    [],
  )
  const openReview = useCallback<OccurrenceDialogs['openReview']>(
    (entryId, name) => setReviewTarget({ entryId, name }),
    [],
  )

  const dialogs = (
    <>
      {target && (
        <MarkPaidDialog
          entryId={target.entryId}
          name={target.name}
          occurrenceDate={target.occurrenceDate}
          {...(target.action ? { action: target.action } : {})}
          onClose={() => setTarget(null)}
          onPaid={onChanged}
          background={background}
          {...(target.restore ? { restore: target.restore } : {})}
        />
      )}
      {forceTarget && (
        <ForceDateDialog
          key={`${forceTarget.kind}:${forceTarget.id}:${forceTarget.occurrenceDate}`}
          target={forceTarget}
          onClose={() => setForceTarget(null)}
          onChanged={onChanged}
        />
      )}
      {reviewTarget && (
        <InstallmentReviewDialog
          key={reviewTarget.entryId}
          entryId={reviewTarget.entryId}
          name={reviewTarget.name}
          onClose={() => setReviewTarget(null)}
          onReviewed={onChanged}
        />
      )}
    </>
  )

  return { openRecord, openChangeDate, openReview, dialogs }
}
