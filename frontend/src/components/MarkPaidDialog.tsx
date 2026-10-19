import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent } from 'react'
import { createPortal } from 'react-dom'
import { Link } from '@tanstack/react-router'
import {
  canPostAllDue,
  defaultMarkPaidDay,
  formatEntryDate,
  isDetailed,
  markPaidWireDate,
  sameStatementCycle,
  skippedNotice,
  statementCycleClose,
} from '@tally-trace/shared'
import type {
  BudgetEntryMaterializeInput,
  EntryOccurrence,
  FullBudgetEntry,
  SharedFullBudgetEntry,
} from '@tally-trace/shared'
import {
  useGetAccountsQuery,
  useGetBudgetEntryQuery,
  useGetEntryOccurrencesQuery,
  useMaterializeBudgetEntryMutation,
  useMaterializeDueBudgetEntryMutation,
} from '../store/api'
import { getCurrencySymbol } from '../utils/currency'
import type { CurrencyCode } from '../utils/currency'
import { apiErrorMessage } from '../utils/apiError'

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

type EditableEntry = FullBudgetEntry | SharedFullBudgetEntry

interface Props {
  entryId: number
  /** The entry's name as the caller listed it. */
  name: string
  /** The occurrence the caller clicked (`YYYY-MM-DD`); the dialog opens on it. null opens on the oldest listed. */
  occurrenceDate: string | null
  /** The entry, when the caller holds it; otherwise the dialog looks it up. */
  entry?: EditableEntry
  /** The row as listed, e.g. "≈ PHP 4,640.00 (USD 80.00)": a hint, never a default value. */
  estimate?: string
  /** The listed row was converted from another currency; read only when the account's currency is unknown. */
  estimated?: boolean
  onClose: () => void
  /** Called after a successful Mark paid or Post all due, before the dialog closes. */
  onPaid?: () => void
}

/** One line of the occurrence select: an occurrence, or a run of walked ones the API left out. */
type SelectItem = { type: 'occurrence'; occurrence: EntryOccurrence } | { type: 'gap'; key: string; count: number }

/** What a linked row means for this Mark paid. */
const LINKED_NOTES: Record<'pending' | 'posted', string> = {
  pending: 'will be posted',
  posted: 'already recorded; moves the schedule on',
}

/** An occurrence no posted row stands for (an ambiguous one is left to the Transactions page). */
const unrecorded = (occurrence: EntryOccurrence) => occurrence.linked !== 'posted'

/**
 * The listed occurrences with "… N more …" where the API left a run out. A run shows
 * as a jump in `skipped_before` larger than the occurrence before it accounts for.
 * When exactly one run is found, `omitted` is its exact size.
 */
function selectItems(occurrences: readonly EntryOccurrence[], omitted: number): SelectItem[] {
  const items: SelectItem[] = []
  const gaps: Array<{ type: 'gap'; key: string; count: number }> = []
  occurrences.forEach((occurrence, index) => {
    const previous = occurrences[index - 1]
    if (previous) {
      const expected = previous.skipped_before + (unrecorded(previous) ? 1 : 0)
      const jump = occurrence.skipped_before - expected
      if (jump > 0) {
        const gap = { type: 'gap' as const, key: `gap-${occurrence.occurrence_date}`, count: jump }
        gaps.push(gap)
        items.push(gap)
      }
    }
    items.push({ type: 'occurrence', occurrence })
  })
  const only = gaps.length === 1 ? gaps[0] : undefined
  if (only && omitted > 0) only.count = omitted
  return items
}

const occurrenceLabel = (occurrence: EntryOccurrence, today: string): string => {
  const day = occurrence.occurrence_date
  const due = day < today ? ' · overdue' : day === today ? ' · due today' : ''
  const linked =
    occurrence.linked === 'pending' || occurrence.linked === 'posted'
      ? ` · ${LINKED_NOTES[occurrence.linked]}`
      : occurrence.linked === 'ambiguous'
        ? ' · more than one linked transaction'
        : ''
  return `${formatEntryDate(day)}${due}${linked}`
}

/**
 * Mark paid for one recurring entry: which occurrence, on which day, for how much.
 * It is the only way an occurrence is marked paid, and every submit names the
 * occurrence (`occurrence_date`). A capped installment offers only its oldest
 * unrecorded month. "Post all N due" posts every due occurrence at once, for a
 * non-capped subscription or cash expense in its account's currency.
 * `transfer_fee` is never sent: a loan payment's split is the server's.
 *
 * Rendered through a portal; while it is open the app root is `inert`, and focus
 * returns to the element that opened it.
 */
export function MarkPaidDialog({ entryId, name, occurrenceDate, entry, estimate, estimated, onClose, onPaid }: Props) {
  const titleId = useId()
  const dialogRef = useRef<HTMLDivElement>(null)
  const closeRef = useRef<HTMLButtonElement>(null)
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose

  // The clicked occurrence is asked for explicitly; one the schedule no longer has (a 422) falls back to the plain list.
  const [include, setInclude] = useState<string | undefined>(occurrenceDate ?? undefined)
  const occurrencesQuery = useGetEntryOccurrencesQuery(
    include ? { id: entryId, include } : { id: entryId },
    { refetchOnMountOrArgChange: true },
  )
  const occurrencesError = occurrencesQuery.error
  useEffect(() => {
    if (include && occurrencesError && 'status' in occurrencesError && occurrencesError.status === 422) {
      setInclude(undefined)
    }
  }, [include, occurrencesError])
  const listing = occurrencesQuery.error ? undefined : occurrencesQuery.currentData

  const entryLookup = useGetBudgetEntryQuery(entryId, { skip: entry !== undefined })
  const lookedUp = entryLookup.currentData
  const detailed: EditableEntry | undefined = entry ?? (lookedUp && isDetailed(lookedUp) ? lookedUp : undefined)
  // The dashboard's arguments, so this reads the cache it already filled.
  const { data: accountsData, isLoading: accountsLoading } = useGetAccountsQuery({ limit: 200 })
  const accounts = useMemo(() => new Map((accountsData?.items ?? []).map((a) => [a.id, a])), [accountsData])

  const [materialize, { isLoading: submitting }] = useMaterializeBudgetEntryMutation()
  const [materializeDue, { isLoading: postingAll }] = useMaterializeDueBudgetEntryMutation()
  const busy = submitting || postingAll

  const [selectedInput, setSelectedInput] = useState<string | null>(null)
  const [dayInput, setDayInput] = useState<string | null>(null)
  const [amountInput, setAmountInput] = useState<string | null>(null)
  const [received, setReceived] = useState('')
  const [error, setError] = useState<string | null>(null)

  // Focus into the dialog, make the page behind inert, and undo both on close.
  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null
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

  const occurrences = useMemo(() => listing?.occurrences ?? [], [listing])
  const items = useMemo(() => selectItems(occurrences, listing?.omitted ?? 0), [occurrences, listing])
  const today = listing?.today ?? ''
  // The clicked occurrence when listed (a capped entry lists only its oldest month), else the first.
  const defaultSelected =
    occurrences.find((o) => o.occurrence_date === occurrenceDate)?.occurrence_date ?? occurrences[0]?.occurrence_date ?? null
  const selected = occurrences.find((o) => o.occurrence_date === (selectedInput ?? defaultSelected)) ?? null

  const kind = listing?.kind ?? detailed?.kind ?? null
  const source = detailed?.account_id !== undefined ? accounts.get(detailed.account_id) : undefined
  const destination = detailed?.transfer_to_account_id != null ? accounts.get(detailed.transfer_to_account_id) : undefined
  const chargedCurrency: CurrencyCode = source?.currency ?? detailed?.currency ?? 'PHP'
  const needsCharged = detailed !== undefined && source !== undefined ? detailed.currency !== source.currency : estimated === true
  const needsReceived = destination !== undefined && destination.currency !== chargedCurrency
  const receivedCurrency: CurrencyCode = destination?.currency ?? chargedCurrency
  // A bill varies: its amount is prefilled and editable. A foreign one asks for the charge instead.
  const editableBill = kind === 'bill' && !needsCharged
  const amountShown = amountInput ?? (editableBill && detailed ? String(detailed.amount) : '')
  const sendsAmount = needsCharged || editableBill

  const defaultDay = selected && today ? defaultMarkPaidDay({ kind, occurrenceDate: selected.occurrence_date, today }) : ''
  const day = dayInput ?? defaultDay
  // A card installment is dated on its occurrence; another day may land it on another statement.
  const card = source?.account_type === 'credit' ? source : undefined
  const cycleWarning =
    kind === 'installment' && card && selected && day && !sameStatementCycle(card, selected.occurrence_date, day)
      ? `This day falls on the statement closing ${formatEntryDate(statementCycleClose(card, day) ?? day)}, not the one closing ${formatEntryDate(statementCycleClose(card, selected.occurrence_date) ?? selected.occurrence_date)} that this installment belongs to.`
      : null

  const skippedDates = selected
    ? occurrences.filter((o) => o.occurrence_date < selected.occurrence_date && unrecorded(o)).map((o) => o.occurrence_date)
    : []
  const skipped = selected ? skippedNotice(selected.skipped_before, skippedDates) : null

  const dueUnrecorded = occurrences.filter((o) => o.due && unrecorded(o))
  const oldestDue = dueUnrecorded[0]?.occurrence_date
  const latestDue = dueUnrecorded[dueUnrecorded.length - 1]?.occurrence_date
  const showPostAll =
    listing !== undefined &&
    detailed !== undefined &&
    source !== undefined &&
    canPostAllDue({
      kind: listing.kind,
      capped: listing.capped,
      sameCurrency: detailed.currency === source.currency,
      due_unposted: listing.due_unposted,
    })

  const ambiguous = selected?.linked === 'ambiguous'
  const loading = (occurrencesQuery.isFetching && !listing) || (detailed === undefined && !entryLookup.error) || accountsLoading
  const loadError = occurrencesError && !(include && 'status' in occurrencesError && occurrencesError.status === 422)
    ? apiErrorMessage(occurrencesError) || "Couldn't load this entry's occurrences."
    : entryLookup.error
      ? apiErrorMessage(entryLookup.error) || "Couldn't load this entry."
      : null
  const canSubmit = !loading && !loadError && selected !== null && !ambiguous && !busy

  const handleSubmit = async () => {
    if (!selected) return
    if (!day) {
      setError('Choose the day it was paid')
      return
    }
    const data: BudgetEntryMaterializeInput = {
      occurrence_date: markPaidWireDate(selected.occurrence_date),
      transaction_date: markPaidWireDate(day),
    }
    if (sendsAmount) {
      const amount = parseFloat(amountShown)
      if (!(amount > 0)) {
        setError(`Enter the amount charged in ${chargedCurrency}`)
        return
      }
      data.amount = amount
    }
    if (needsReceived) {
      const amount = parseFloat(received)
      if (!(amount > 0)) {
        setError(`Enter the amount received in ${receivedCurrency}`)
        return
      }
      data.received_amount = amount
    }
    setError(null)
    try {
      await materialize({ id: entryId, data }).unwrap()
      onPaid?.()
      onClose()
    } catch (caught) {
      // The API's reason ("Record the oldest unrecorded month first", ...) stays in the dialog.
      setError(apiErrorMessage(caught) || 'Could not mark the entry as paid. Please try again.')
    }
  }

  const handlePostAll = async () => {
    setError(null)
    try {
      await materializeDue(entryId).unwrap()
      onPaid?.()
      onClose()
    } catch (caught) {
      setError(apiErrorMessage(caught) || 'Could not post the due occurrences. Please try again.')
    }
  }

  return createPortal(
    <div
      className="fixed inset-0 z-[60] overflow-y-auto bg-black/60 px-4 py-6"
      onClick={onClose}
      data-testid="mark-paid-overlay"
    >
      <div className="flex min-h-full items-center justify-center">
        <div
          ref={dialogRef}
          className="w-full max-w-md border border-line bg-surface p-5 sm:p-6 space-y-4"
          role="dialog"
          aria-modal="true"
          aria-labelledby={titleId}
          data-testid="mark-paid-dialog"
          onClick={(event) => event.stopPropagation()}
          onKeyDown={trapTab}
        >
          <div className="flex items-start justify-between gap-4">
            <div>
              <h2 id={titleId} className="text-lg font-semibold text-ink">Mark {name} as paid</h2>
              {estimate && (
                <p className="mt-1 text-sm text-muted" data-testid="mark-paid-estimate">
                  Listed as {estimate}.{needsCharged || needsReceived ? ' Enter what was actually moved; the estimate is only a guide.' : ''}
                </p>
              )}
            </div>
            <button ref={closeRef} type="button" onClick={onClose} className="btn-secondary focus-ring">
              Close
            </button>
          </div>

          {loading && !loadError && (
            <p className="text-sm text-muted" role="status" data-testid="mark-paid-loading">Loading occurrences…</p>
          )}
          {loadError && (
            <p className="text-sm text-warn" role="alert" data-testid="mark-paid-load-error">{loadError}</p>
          )}

          {!loading && !loadError && listing && (
            <>
              {occurrences.length === 0 ? (
                <p className="text-sm text-muted" data-testid="mark-paid-none">This entry has no occurrence left to record.</p>
              ) : (
                <div>
                  <label className="label" htmlFor={`${titleId}-occurrence`}>Occurrence</label>
                  <select
                    id={`${titleId}-occurrence`}
                    value={selected?.occurrence_date ?? ''}
                    onChange={(e) => {
                      setSelectedInput(e.target.value)
                      setDayInput(null)
                      setError(null)
                    }}
                    disabled={listing.capped && occurrences.length === 1}
                    className="select-field focus-ring"
                    data-testid="mark-paid-occurrence"
                  >
                    {items.map((item) =>
                      item.type === 'gap' ? (
                        <option key={item.key} value="" disabled>
                          … {item.count} more …
                        </option>
                      ) : (
                        <option key={item.occurrence.occurrence_date} value={item.occurrence.occurrence_date}>
                          {occurrenceLabel(item.occurrence, today)}
                        </option>
                      ),
                    )}
                  </select>
                  {listing.capped && (
                    <p className="mt-1 text-xs text-muted" data-testid="mark-paid-capped-note">
                      An installment is recorded oldest month first.
                    </p>
                  )}
                  {selected?.linked === 'pending' && (
                    <p className="mt-1 text-xs text-muted" data-testid="mark-paid-linked">
                      A pending transaction stands for this occurrence; it will be posted.
                    </p>
                  )}
                  {selected?.linked === 'posted' && (
                    <p className="mt-1 text-xs text-muted" data-testid="mark-paid-linked">
                      This occurrence is already recorded; marking it paid moves the schedule on.
                    </p>
                  )}
                  {ambiguous && (
                    <p className="mt-1 text-xs text-warn" role="alert" data-testid="mark-paid-linked">
                      More than one transaction is linked to this occurrence. Resolve them on the{' '}
                      <Link to="/transactions" className="underline underline-offset-2 focus-ring">Transactions page</Link>.
                    </p>
                  )}
                </div>
              )}

              {skipped && (
                <p className="text-sm text-warn" data-testid="mark-paid-skipped">{skipped}. They stay unrecorded.</p>
              )}

              {selected && (
                <div>
                  <label className="label" htmlFor={`${titleId}-day`}>Paid on</label>
                  <input
                    id={`${titleId}-day`}
                    type="date"
                    value={day}
                    onChange={(e) => {
                      setDayInput(e.target.value)
                      setError(null)
                    }}
                    className="input-field focus-ring"
                    data-testid="mark-paid-date"
                  />
                  {cycleWarning && (
                    <p className="mt-1 text-xs text-warn" data-testid="mark-paid-cycle-warning">{cycleWarning}</p>
                  )}
                </div>
              )}

              {selected && sendsAmount && (
                <div>
                  <label className="label" htmlFor={`${titleId}-amount`}>
                    {needsCharged ? `Amount charged (${chargedCurrency})` : `Amount (${chargedCurrency})`}
                  </label>
                  <div className="relative">
                    <span className="absolute inset-y-0 left-0 pl-3 flex items-center text-muted text-sm">{getCurrencySymbol(chargedCurrency)}</span>
                    <input
                      id={`${titleId}-amount`}
                      type="number"
                      step="0.01"
                      min="0"
                      value={amountShown}
                      onChange={(e) => {
                        setAmountInput(e.target.value)
                        setError(null)
                      }}
                      className="input-field pl-7 focus-ring"
                      placeholder="0.00"
                      data-testid="mark-paid-amount"
                    />
                  </div>
                  {editableBill && <p className="mt-1 text-xs text-muted">Bills vary: enter this month's amount.</p>}
                </div>
              )}

              {selected && needsReceived && (
                <div>
                  <label className="label" htmlFor={`${titleId}-received`}>Amount received ({receivedCurrency})</label>
                  <div className="relative">
                    <span className="absolute inset-y-0 left-0 pl-3 flex items-center text-muted text-sm">{getCurrencySymbol(receivedCurrency)}</span>
                    <input
                      id={`${titleId}-received`}
                      type="number"
                      step="0.01"
                      min="0"
                      value={received}
                      onChange={(e) => {
                        setReceived(e.target.value)
                        setError(null)
                      }}
                      className="input-field pl-7 focus-ring"
                      placeholder="0.00"
                      data-testid="mark-paid-received"
                    />
                  </div>
                </div>
              )}
            </>
          )}

          {error && <p className="text-sm text-danger" role="alert" data-testid="mark-paid-error">{error}</p>}

          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => void handleSubmit()}
              disabled={!canSubmit}
              className="btn-primary focus-ring disabled:opacity-50"
              data-testid="mark-paid-submit"
            >
              {submitting ? 'Posting…' : 'Mark paid'}
            </button>
            {showPostAll && oldestDue && latestDue && (
              <button
                type="button"
                onClick={() => void handlePostAll()}
                disabled={busy}
                className="btn-secondary focus-ring disabled:opacity-50"
                data-testid="mark-paid-post-all"
              >
                {postingAll
                  ? 'Posting…'
                  : `Post all ${listing.due_unposted} due (${formatEntryDate(oldestDue)} – ${formatEntryDate(latestDue)})`}
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
