import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent } from 'react'
import { createPortal } from 'react-dom'
import {
  envelopeNote,
  formatEntryDate,
  isDetailed,
  linkChoices,
  reviewBody,
  reviewButtonText,
} from '@tally-trace/shared'
import type { InstallmentAutoPostBlock, InstallmentReview } from '@tally-trace/shared'
import {
  useGetAccountsQuery,
  useGetAllocationsQuery,
  useGetBudgetEntryQuery,
  useGetCategoriesQuery,
  useGetInstallmentReviewQuery,
  useReviewInstallmentMutation,
} from '../store/api'
import { apiErrorMessage, apiErrorStatus } from '../utils/apiError'
import { formatCurrency } from '../utils/currency'
import { RecurringEntryFormModal } from './RecurringEntryFormModal'

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

/** Why the installment can't be turned on (the review GET's `block`); the POST refuses it with the same reason. */
const BLOCK_TEXT: Record<InstallmentAutoPostBlock, string> = {
  not_installment: 'Only a card installment can auto-post.',
  foreign_currency: "This installment is in another currency than its card, so it can't auto-post. Mark paid each month with the amount charged.",
  no_statement_cycle: "This card has no statement cycle, so its installments can't auto-post. Mark paid each month.",
  inactive: 'This installment is paused or has ended.',
}

const CHANGED = 'This installment changed since you opened the review'

interface Props {
  entryId: number
  /** The entry's name as the caller listed it, for the title until the review loads. */
  name: string
  onClose: () => void
  /** Called after the review is recorded (or the entry deleted from its edit form), before the dialog closes. */
  onReviewed?: () => void
}

/**
 * Review a card installment and turn its auto-post on (STU-343 Plan B): the months it
 * will record now, possible duplicates of each one (the creator's own unlinked charges
 * on the card) to link instead, and the notes. Anyone who can edit the entry may review
 * it. The POST carries the GET's `entry_version` and `review_token` unchanged; a 409
 * (anything changed since) says so and refetches. "Move the next date instead" opens the
 * entry's edit form in place of the dialog and comes back to a fresh review.
 */
export function InstallmentReviewDialog({ entryId, name, onClose, onReviewed }: Props) {
  const [editing, setEditing] = useState(false)
  const reviewQuery = useGetInstallmentReviewQuery(entryId, { refetchOnMountOrArgChange: true })

  if (editing) {
    return (
      <ReviewEditForm
        entryId={entryId}
        onBack={() => setEditing(false)}
        onDeleted={() => {
          onReviewed?.()
          onClose()
        }}
      />
    )
  }
  return (
    <ReviewShell
      entryId={entryId}
      name={name}
      review={reviewQuery.error ? undefined : reviewQuery.currentData}
      loadError={reviewQuery.error}
      refetch={() => void reviewQuery.refetch()}
      onClose={onClose}
      onReviewed={onReviewed}
      onEdit={() => setEditing(true)}
    />
  )
}

interface ShellProps {
  entryId: number
  name: string
  review: InstallmentReview | undefined
  loadError: unknown
  refetch: () => void
  onClose: () => void
  onReviewed: (() => void) | undefined
  onEdit: () => void
}

function ReviewShell({ entryId, name, review, loadError, refetch, onClose, onReviewed, onEdit }: ShellProps) {
  const titleId = useId()
  const dialogRef = useRef<HTMLDivElement>(null)
  const closeRef = useRef<HTMLButtonElement>(null)
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose

  const [submit, { isLoading: submitting }] = useReviewInstallmentMutation()
  // The transaction chosen for each missed month (`YYYY-MM-DD` → transaction id).
  const [selected, setSelected] = useState<Record<string, number>>({})
  const [error, setError] = useState<string | null>(null)

  // The opener, read once per instance in a layout effect: that runs before the passive
  // query subscriptions, which can make the screen loader blur it. StrictMode's replay
  // keeps the first value.
  const openerRef = useRef<Element | null>(null)
  useLayoutEffect(() => {
    openerRef.current ??= document.activeElement
  }, [])

  // Focus into the dialog, make the page behind inert, and undo both on close.
  useEffect(() => {
    const opener = openerRef.current instanceof HTMLElement ? openerRef.current : null
    const root = document.getElementById('root')
    root?.setAttribute('inert', '')
    closeRef.current?.focus()
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.stopPropagation()
      onCloseRef.current()
    }
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('keydown', onKey)
      // Inert off first: an inert element can't take focus back.
      root?.removeAttribute('inert')
      if (opener?.isConnected) opener.focus()
    }
  }, [])

  const trapTab = useCallback((event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'Tab') return
    const items = Array.from(dialogRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [])
    const first = items[0]
    const last = items[items.length - 1]
    if (!first || !last) return
    const active = document.activeElement
    if (!dialogRef.current?.contains(active)) {
      event.preventDefault()
      first.focus()
    } else if (event.shiftKey && active === first) {
      event.preventDefault()
      last.focus()
    } else if (!event.shiftKey && active === last) {
      event.preventDefault()
      first.focus()
    }
  }, [])

  const choices = useMemo(() => (review ? linkChoices(review, selected) : []), [review, selected])
  const notFound = apiErrorStatus(loadError) === 404
  const loadMessage = loadError && !notFound ? apiErrorMessage(loadError) || "Couldn't load this installment's review." : null
  const loading = !review && !loadError
  const canSubmit = review !== undefined && review.block === null && !submitting

  const choose = (month: string, transactionId: number, on: boolean) => {
    setError(null)
    setSelected((prev) => {
      const next = { ...prev }
      if (on) next[month] = transactionId
      else if (next[month] === transactionId) delete next[month]
      return next
    })
  }

  const handleSubmit = async () => {
    if (!review) return
    setError(null)
    try {
      await submit({ id: entryId, data: reviewBody(review, selected) }).unwrap()
      onReviewed?.()
      onClose()
    } catch (caught) {
      if (apiErrorStatus(caught) === 409) {
        setError(CHANGED)
        refetch()
        return
      }
      setError(apiErrorMessage(caught) || 'Could not turn on auto-post. Please try again.')
    }
  }

  const title = review ? `Turn on auto-post for ${review.name} (${review.account_name})` : `Turn on auto-post for ${name}`

  return createPortal(
    <div
      className="fixed inset-0 z-[60] overflow-y-auto bg-black/60 px-4 py-6"
      onClick={onClose}
      data-testid="installment-review-overlay"
    >
      <div className="flex min-h-full items-center justify-center">
        <div
          ref={dialogRef}
          className="w-full max-w-lg border border-line bg-surface p-5 sm:p-6 space-y-4"
          role="dialog"
          aria-modal="true"
          aria-labelledby={titleId}
          data-testid="installment-review-dialog"
          onClick={(event) => event.stopPropagation()}
          onKeyDown={trapTab}
        >
          <div className="flex items-start justify-between gap-4">
            <h2 id={titleId} className="text-lg font-semibold text-ink" data-testid="installment-review-title">{title}</h2>
            <button ref={closeRef} type="button" onClick={onClose} className="btn-secondary focus-ring">
              Close
            </button>
          </div>

          {notFound && (
            <p className="text-sm text-warn" role="alert" data-testid="installment-review-not-found">
              You can&apos;t review this installment.
            </p>
          )}
          {loadMessage && (
            <p className="text-sm text-warn" role="alert" data-testid="installment-review-load-error">{loadMessage}</p>
          )}
          {loading && (
            <p className="text-sm text-muted" role="status" data-testid="installment-review-loading">Loading…</p>
          )}

          {review && review.block !== null && (
            <p className="text-sm text-warn" data-testid="installment-review-block">{BLOCK_TEXT[review.block]}</p>
          )}

          {review && review.block === null && (
            <>
              {review.missed.length > 0 ? (
                <div className="space-y-1" data-testid="installment-review-missed">
                  <p className="text-sm text-ink">
                    These {review.missed.length} {review.missed.length === 1 ? 'month' : 'months'} will be recorded now:
                  </p>
                  <ul className="list-disc pl-5 text-sm text-body">
                    {review.missed.map((month) => (
                      <li key={month.occurrence_date} data-testid="installment-review-month" data-month={month.occurrence_date}>
                        {formatEntryDate(month.occurrence_date)}
                        {month.linked === 'pending' && ' · will be posted'}
                      </li>
                    ))}
                  </ul>
                </div>
              ) : (
                <p className="text-sm text-body" data-testid="installment-review-nothing-missed">No month is due yet.</p>
              )}

              {choices.map((choice) => (
                <fieldset
                  key={choice.occurrenceDate}
                  className="border border-line p-3 space-y-2"
                  data-testid="installment-review-candidates"
                  data-month={choice.occurrenceDate}
                >
                  <legend className="px-1 text-sm font-medium text-ink">
                    Already typed the {formatEntryDate(choice.occurrenceDate)} charge?
                  </legend>
                  {choice.options.map((option) => {
                    const txn = option.transaction
                    const inputId = `${titleId}-${choice.occurrenceDate}-${txn.id}`
                    return (
                      <div
                        key={txn.id}
                        className="flex items-start gap-2 text-sm"
                        data-testid="installment-review-candidate"
                        data-transaction-id={txn.id}
                      >
                        <input
                          id={inputId}
                          type="checkbox"
                          checked={option.selected}
                          disabled={option.disabled || submitting}
                          onChange={(e) => choose(choice.occurrenceDate, txn.id, e.target.checked)}
                          className="mt-0.5 focus-ring"
                          data-testid="installment-review-link"
                        />
                        <label htmlFor={inputId} className="space-y-0.5">
                          <span className="block text-ink">This is the {formatEntryDate(choice.occurrenceDate)} charge</span>
                          <span className="block text-xs text-muted">
                            {formatEntryDate(txn.date)} · {formatCurrency(txn.amount, review.currency)} ·{' '}
                            {txn.is_posted ? 'Posted' : 'Pending'}
                            {txn.description ? ` · ${txn.description}` : ''}
                            {option.disabled && ' · chosen for another month'}
                          </span>
                        </label>
                      </div>
                    )
                  })}
                </fieldset>
              ))}

              <ul className="space-y-1 text-xs text-muted" data-testid="installment-review-notes">
                {review.missed.length > 0 && <li data-testid="installment-review-envelope">{envelopeNote(review)}.</li>}
                {review.past_cycles && (
                  <li data-testid="installment-review-past-cycles">Some months fall on statements that have closed.</li>
                )}
                {review.remaining_after !== null && (
                  <li data-testid="installment-review-remaining">
                    {review.remaining_after} {review.remaining_after === 1 ? 'payment' : 'payments'} left after this.
                  </li>
                )}
                <li>
                  Months you paid outside the app?{' '}
                  <button
                    type="button"
                    onClick={onEdit}
                    disabled={submitting}
                    className="underline underline-offset-2 text-body hover:text-ink focus-ring disabled:opacity-50"
                    data-testid="installment-review-move-date"
                  >
                    Move the next date instead
                  </button>
                </li>
                <li>From now on these post themselves; don&apos;t type them from the statement.</li>
              </ul>
            </>
          )}

          {error && <p className="text-sm text-danger" role="alert" data-testid="installment-review-error">{error}</p>}

          <div className="flex flex-wrap gap-2">
            {review && review.block === null && (
              <button
                type="button"
                onClick={() => void handleSubmit()}
                disabled={!canSubmit}
                className="btn-primary focus-ring disabled:opacity-50"
                data-testid="installment-review-submit"
              >
                {submitting ? 'Recording…' : reviewButtonText(review)}
              </button>
            )}
            <button type="button" onClick={onClose} className="btn-secondary focus-ring">Cancel</button>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  )
}

/**
 * The entry's edit form, opened from the review ("Move the next date instead"): moving
 * the next date counts the skipped months as paid outside the app and keeps the final
 * month (the B1 rule). Saving or cancelling goes back to the review, which refetches.
 */
function ReviewEditForm({ entryId, onBack, onDeleted }: { entryId: number; onBack: () => void; onDeleted: () => void }) {
  const entryQuery = useGetBudgetEntryQuery(entryId, { refetchOnMountOrArgChange: true })
  const { data: accountsData, error: accountsError } = useGetAccountsQuery({ is_active: true, limit: 1000 })
  const { data: categoriesData, error: categoriesError } = useGetCategoriesQuery({ is_active: true })
  const { data: envelopesData, error: envelopesError } = useGetAllocationsQuery({ allocation_type: 'budget', limit: 1000 })
  const entry = entryQuery.currentData
  const failed = entryQuery.error ?? accountsError ?? categoriesError ?? envelopesError

  if (entry && isDetailed(entry) && accountsData && categoriesData && envelopesData) {
    return (
      <RecurringEntryFormModal
        key={entry.id}
        entry={entry}
        accounts={accountsData.items}
        categories={categoriesData}
        budgetEnvelopes={envelopesData.items}
        onClose={onBack}
        onSaved={onBack}
        onDeleted={onDeleted}
      />
    )
  }
  return createPortal(
    <div className="fixed inset-0 z-[60] overflow-y-auto bg-black/60 px-4 py-6" data-testid="installment-review-edit-overlay">
      <div className="flex min-h-full items-center justify-center">
        <div className="w-full max-w-md border border-line bg-surface p-5 sm:p-6 space-y-4" role="dialog" aria-modal="true" aria-label="Edit installment">
          {failed || (entry && !isDetailed(entry)) ? (
            <p className="text-sm text-warn" role="alert" data-testid="installment-review-edit-error">
              {apiErrorMessage(failed) || "Couldn't open this installment's edit form."}
            </p>
          ) : (
            <p className="text-sm text-muted" role="status" data-testid="installment-review-edit-loading">Loading…</p>
          )}
          <button type="button" onClick={onBack} className="btn-secondary focus-ring">Back to the review</button>
        </div>
      </div>
    </div>,
    document.body,
  )
}
