import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import type { FormEvent, KeyboardEvent as ReactKeyboardEvent } from 'react'
import { createPortal } from 'react-dom'
import {
  cascadeConfirmation,
  dateChoiceLines,
  formatEntryDate,
  hasDateChoice,
  isForced,
  RECORD_DATE_MIN,
  recordDateError,
  recordDateMax,
  statementConfirmation,
} from '@tally-trace/shared'
import type { DateChoice, ForcedDateMode, ForcedDateOptions } from '@tally-trace/shared'
import {
  useClearLoanDueDateMutation,
  useGetEntryOccurrencesQuery,
  useClearOccurrenceDateMutation,
  useLazyGetForcedDateOptionsQuery,
  useSetLoanDueDateMutation,
  useSetOccurrenceDateMutation,
  useUndoCascadeMutation,
} from '../store/api'
import { useInputBlocked } from '../store/busy'
import { apiErrorMessage, apiErrorStatus } from '../utils/apiError'

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

/** The occurrence or loan due date whose date is being changed. */
export interface ForceDateTarget {
  kind: 'entry' | 'loan'
  /** The budget entry's id, or the loan account's. */
  id: number
  name: string
  /** The scheduled day (`YYYY-MM-DD`): the identity the server keys the forced date on. */
  occurrenceDate: string
  /**
   * The forced date, or the scheduled day. Left out when the row does not carry it (an
   * installment plan): an entry's occurrence listing is then asked for it.
   */
  effectiveDate?: string
}

interface Props {
  target: ForceDateTarget
  onClose: () => void
  /** Called after the date was saved or cleared, before the dialog closes (or confirms). */
  onChanged?: () => void
}

/** One choice for a refused date: its preview and its button, or (greyed) the reason it is unavailable. */
function ChoiceCard({ id, choice, action, busy, onChoose }: {
  id: ForcedDateMode
  choice: DateChoice
  action: string
  busy: boolean
  onChoose: () => void
}) {
  if (!choice.available) {
    return (
      <div className="border border-line p-3 text-sm text-muted opacity-60" data-testid={`date-choice-${id}`} data-available="false">
        {choice.unavailable}
      </div>
    )
  }
  return (
    <div className="border border-line-strong p-3 space-y-2" data-testid={`date-choice-${id}`} data-available="true">
      <p className="text-sm font-semibold text-ink">{choice.title}</p>
      <ul className="space-y-1 text-sm text-ink">
        {choice.lines.map((line) => <li key={line} data-testid="date-choice-line">{line}</li>)}
      </ul>
      {choice.total && <p className="text-sm font-semibold text-ink" data-testid="date-choice-total">{choice.total}</p>}
      {choice.note && <p className="text-xs text-muted" data-testid="date-choice-note">({choice.note})</p>}
      <div className="flex justify-end">
        <button
          type="button"
          onClick={onChoose}
          disabled={busy}
          className="btn-secondary focus-ring min-h-[44px] w-full sm:w-auto"
          data-testid={`date-choice-${id}-button`}
        >
          {action}
        </button>
      </div>
    </div>
  )
}

/**
 * Changes the date one occurrence of a recurring entry, or one open due date of a loan, falls
 * on, or puts it back (Clear, offered while it is forced). The scheduled day stays its
 * identity; the chosen date decides when it is due, shown, overdue and posted. The server's
 * reason for a refusal (a linked row, a closed statement, out of reach or order) shows
 * inline; for an entry, a refused date also offers what the server says it can do instead
 * (`date-options`): Pay together with the next payment, or Delay all (the schedule moves, with an
 * Undo). With neither available, or on an older API, only the refusal shows. A card charge confirms the statement it now falls on before the dialog closes.
 *
 * Rendered through a portal; while it is open the app root is `inert`, and focus returns to
 * the element that opened it.
 */
export function ForceDateDialog({ target, onClose, onChanged }: Props) {
  const titleId = useId()
  const dialogRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose

  const [setEntry, { isLoading: settingEntry }] = useSetOccurrenceDateMutation()
  const [clearEntry, { isLoading: clearingEntry }] = useClearOccurrenceDateMutation()
  const [setLoan, { isLoading: settingLoan }] = useSetLoanDueDateMutation()
  const [clearLoan, { isLoading: clearingLoan }] = useClearLoanDueDateMutation()
  const [fetchOptions] = useLazyGetForcedDateOptionsQuery()
  const [undoCascade, { isLoading: undoing }] = useUndoCascadeMutation()
  const busy = settingEntry || clearingEntry || settingLoan || clearingLoan || undoing
  // The screen loader blocks input a little past the request (STU-576): a refusal shown
  // before it lets go invites a date that is swallowed, so the refusal waits for it.
  const inputBlocked = useInputBlocked()

  // A row without its effective date (an installment plan) reads it from the entry's occurrences.
  const lookup = useGetEntryOccurrencesQuery(
    { id: target.id, include: target.occurrenceDate },
    { skip: target.effectiveDate !== undefined || target.kind !== 'entry' },
  )
  const looked = lookup.currentData?.occurrences.find((o) => o.occurrence_date === target.occurrenceDate)
  const known = target.effectiveDate ?? (target.kind === 'entry' ? looked?.effective_date ?? looked?.occurrence_date : target.occurrenceDate)
  const effectiveDate = known ?? target.occurrenceDate
  const loading = known === undefined && !lookup.isError

  const [dayInput, setDayInput] = useState<string | null>(null)
  const day = dayInput ?? effectiveDate
  const dayRef = useRef(day)
  dayRef.current = day
  const [error, setError] = useState<string | null>(null)
  // The statement a card charge now falls on; the dialog stays open until it is read.
  const [confirmation, setConfirmation] = useState<string | null>(null)
  // The choices for the date last refused (`choiceDay`), and the Delay all that was applied.
  const [options, setOptions] = useState<ForcedDateOptions | null>(null)
  const [choiceDay, setChoiceDay] = useState('')
  const [cascadeDone, setCascadeDone] = useState<{ text: string; token: string } | null>(null)
  const optionsRequest = useRef(0)
  const forced = isForced(target.occurrenceDate, effectiveDate)

  const openerRef = useRef<Element | null>(null)
  useLayoutEffect(() => {
    openerRef.current ??= document.activeElement
  }, [])

  useEffect(() => {
    const opener = openerRef.current instanceof HTMLElement ? openerRef.current : null
    const root = document.getElementById('root')
    root?.setAttribute('inert', '')
    inputRef.current?.focus()
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.stopPropagation()
      onCloseRef.current()
    }
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('keydown', onKey)
      root?.removeAttribute('inert')
      if (opener?.isConnected) opener.focus()
    }
  }, [])

  const trapTab = (event: ReactKeyboardEvent<HTMLDivElement>) => {
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
  }

  /** Asks what the refused `chosen` date can become; anything but a usable answer shows no choices. */
  const loadOptions = async (chosen: string) => {
    const request = ++optionsRequest.current
    try {
      const found = await fetchOptions({ id: target.id, day: target.occurrenceDate, effectiveDate: chosen }).unwrap()
      if (request !== optionsRequest.current) return
      setOptions(hasDateChoice(found) ? found : null)
      setChoiceDay(chosen)
    } catch {
      // An older API (404, 405, 422) or a failed read: the refusal alone stands.
      if (request === optionsRequest.current) setOptions(null)
    }
  }

  const save = async (event: FormEvent) => {
    event.preventDefault()
    setError(null)
    setOptions(null)
    optionsRequest.current += 1
    if (!day) {
      setError('Choose the date')
      return
    }
    const dateError = recordDateError(day)
    if (dateError) {
      setError(dateError)
      return
    }
    const request = { id: target.id, day: target.occurrenceDate, data: { effective_date: day } }
    try {
      const result = await (target.kind === 'entry' ? setEntry(request) : setLoan(request)).unwrap()
      onChanged?.()
      const sentence = statementConfirmation(result)
      if (sentence) setConfirmation(sentence)
      else onClose()
    } catch (err) {
      setError(apiErrorMessage(err) || 'Could not change the date. Try again.')
      if (target.kind === 'entry' && apiErrorStatus(err) === 422 && dayRef.current === day) void loadOptions(day)
    }
  }

  const choose = async (mode: ForcedDateMode) => {
    // Only a preview of the date now in the field can be chosen.
    if (!options || choiceDay !== day) return
    setError(null)
    const chosen = mode === 'overlap' ? options.overlap.date : choiceDay
    try {
      const result = await setEntry({ id: target.id, day: target.occurrenceDate, data: { effective_date: chosen, mode } }).unwrap()
      onChanged?.()
      const sentence = statementConfirmation(result)
      if (mode === 'cascade' && result.cascade) {
        const moved = cascadeConfirmation(chosen, options.cascade)
        setCascadeDone({ text: sentence ? `${moved} ${sentence}` : moved, token: result.cascade.undo_token })
        setOptions(null)
      } else if (sentence) {
        setOptions(null)
        setConfirmation(sentence)
      } else onClose()
    } catch (err) {
      setError(apiErrorMessage(err) || 'Could not change the date. Try again.')
    }
  }

  const undo = async () => {
    if (!cascadeDone) return
    setError(null)
    try {
      await undoCascade({ id: target.id, data: { undo_token: cascadeDone.token } }).unwrap()
      onChanged?.()
      onClose()
    } catch (err) {
      setError(apiErrorMessage(err) || 'Could not undo. Try again.')
    }
  }

  const clear = async () => {
    setError(null)
    const request = { id: target.id, day: target.occurrenceDate }
    try {
      await (target.kind === 'entry' ? clearEntry(request) : clearLoan(request)).unwrap()
      onChanged?.()
      onClose()
    } catch (err) {
      setError(apiErrorMessage(err) || 'Could not clear the date. Try again.')
    }
  }

  return createPortal(
    <div className="fixed inset-0 z-[60] overflow-y-auto bg-black/60 px-4 py-6" onClick={onClose} data-testid="force-date-overlay">
      <div className="flex min-h-full items-center justify-center">
        <div
          ref={dialogRef}
          className="w-full max-w-md border border-line bg-surface p-5 sm:p-6 space-y-4"
          role="dialog"
          aria-modal="true"
          aria-labelledby={titleId}
          data-testid="force-date-dialog"
          onClick={(event) => event.stopPropagation()}
          onKeyDown={trapTab}
        >
          <div className="flex items-start justify-between gap-4">
            <div>
              <h2 id={titleId} className="text-lg font-semibold text-ink">Change date: {target.name}</h2>
              <p className="text-sm text-muted" data-testid="force-date-scheduled">
                Scheduled {formatEntryDate(target.occurrenceDate)}
                {forced && ` · now ${formatEntryDate(effectiveDate)}`}
              </p>
            </div>
            <button type="button" onClick={onClose} className="btn-secondary focus-ring" data-testid="force-date-close">
              {confirmation ? 'Done' : 'Close'}
            </button>
          </div>

          {cascadeDone ? (
            <div className="space-y-3">
              <p className="text-sm text-ok" role="status" data-testid="force-date-cascade-confirmation">{cascadeDone.text}</p>
              {error && !inputBlocked && (
                <p className="text-sm text-danger" role="alert" data-testid="force-date-error">{error}</p>
              )}
              <div className="flex gap-3">
                <button
                  type="button"
                  onClick={() => void undo()}
                  disabled={busy}
                  className="flex-1 btn-secondary focus-ring min-h-[44px]"
                  data-testid="force-date-undo"
                >
                  {undoing ? 'Undoing…' : 'Undo'}
                </button>
                <button type="button" onClick={onClose} className="flex-1 btn-primary focus-ring min-h-[44px]" data-testid="force-date-done">
                  Done
                </button>
              </div>
            </div>
          ) : confirmation ? (
            <p className="text-sm text-ok" role="status" data-testid="force-date-confirmation">{confirmation}</p>
          ) : (
            <form onSubmit={save} className="space-y-4" noValidate>
              <div>
                <label className="label" htmlFor={`${titleId}-date`}>Date it falls on</label>
                <input
                  id={`${titleId}-date`}
                  ref={inputRef}
                  type="date"
                  value={day}
                  min={RECORD_DATE_MIN}
                  max={recordDateMax()}
                  disabled={settingEntry || settingLoan}
                  onChange={(e) => {
                    setDayInput(e.target.value)
                    setError(null)
                    setOptions(null)
                    optionsRequest.current += 1
                  }}
                  className="input-field focus-ring"
                  data-testid="force-date-input"
                />
                <p className="mt-1 text-xs text-muted">
                  The schedule is unchanged: this occurrence alone is due, shown and posted on this date.
                </p>
              </div>
              {error && !inputBlocked && (
                <p className="text-sm text-danger" role="alert" data-testid="force-date-error">{error}</p>
              )}
              {options && choiceDay === day && !inputBlocked && (() => {
                const lines = dateChoiceLines(options, choiceDay)
                return (
                  <div className="space-y-3" data-testid="date-choices">
                    <ChoiceCard id="overlap" choice={lines.overlap} action="Pay together" busy={busy} onChoose={() => void choose('overlap')} />
                    <ChoiceCard id="cascade" choice={lines.cascade} action="Delay all" busy={busy} onChoose={() => void choose('cascade')} />
                  </div>
                )
              })()}
              <div className="flex gap-3">
                <button type="submit" disabled={busy || loading} className="flex-1 btn-primary focus-ring" data-testid="force-date-save">
                  {busy ? 'Saving…' : 'Save'}
                </button>
                {forced && (
                  <button
                    type="button"
                    onClick={() => void clear()}
                    disabled={busy}
                    className="flex-1 btn-secondary focus-ring"
                    data-testid="force-date-clear"
                  >
                    Clear
                  </button>
                )}
              </div>
            </form>
          )}
        </div>
      </div>
    </div>,
    document.body,
  )
}
