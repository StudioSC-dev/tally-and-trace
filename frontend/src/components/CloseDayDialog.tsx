import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent } from 'react'
import { createPortal } from 'react-dom'
import type { CloseDayReport } from '@tally-trace/shared'
import { useChangeCloseDayMutation } from '../store/api'
import { newOutboxId } from '../store/outbox'
import { apiErrorMessage } from '../utils/apiError'
import { closeDayRefusal, needsHistoryAck, stepAfterCheck, summariseCloseDay } from '../utils/closeDaySummary'

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

/** How long a check runs before the step shows its "Checking" line. */
const CHECKING_SHOWN_AFTER_MS = 400

/** Where the step is. `refusedOn` tells a refused check (Cancel only) from a refused apply (the data changed). */
export type CloseDayPhase =
  | { kind: 'checking' }
  | { kind: 'review'; report: CloseDayReport }
  | { kind: 'applying'; report: CloseDayReport | null }
  | { kind: 'refused'; report: CloseDayReport; refusedOn: 'check' | 'apply' }
  | { kind: 'error'; message: string; retry: 'check' | 'apply'; report: CloseDayReport | null }

interface ViewProps {
  phase: CloseDayPhase
  newDay: number
  ack: boolean
  titleId: string
  onAck: (value: boolean) => void
  onConfirm: () => void
  onCancel: () => void
  onCheckAgain: () => void
  onTryAgain: () => void
}

function Lines({ title, lines, testId }: { title?: string; lines: string[]; testId: string }) {
  if (lines.length === 0) return null
  return (
    <div className="space-y-1" data-testid={testId}>
      {title && <p className="text-sm font-semibold text-ink">{title}</p>}
      <ul className="list-disc space-y-1 pl-5 text-sm text-ink">
        {lines.map((line) => <li key={line}>{line}</li>)}
      </ul>
    </div>
  )
}

/** The step's content for one phase. Presentational: the dialog owns the state and the calls. */
export function CloseDayStepView({ phase, newDay, ack, titleId, onAck, onConfirm, onCancel, onCheckAgain, onTryAgain }: ViewProps) {
  const report = 'report' in phase ? phase.report : null
  const summary = report ? summariseCloseDay(report) : null
  const needsAck = report !== null && needsHistoryAck(report)
  const canConfirm = phase.kind === 'review' && (!needsAck || ack)
  return (
    <>
      <h2 id={titleId} className="text-lg font-semibold text-ink">Change the closing day</h2>
      {phase.kind === 'checking' && (
        <p className="text-sm text-muted" role="status" data-testid="close-day-checking">
          Checking what moves with the {newDay}th…
        </p>
      )}
      {phase.kind === 'applying' && !summary && (
        <p className="text-sm text-muted" role="status" data-testid="close-day-applying">Changing the closing day…</p>
      )}
      {summary && (
        <div className="space-y-3" data-testid="close-day-summary">
          <p className="text-sm text-ink" data-testid="close-day-headline">{summary.headline}</p>
          {phase.kind === 'refused' ? null : (
            <>
              <Lines title="Installments" lines={summary.installments} testId="close-day-installments" />
              <Lines lines={summary.keptDate} testId="close-day-kept-date" />
              <Lines title="Due dates" lines={summary.dues} testId="close-day-dues" />
              <Lines title="Past statements" lines={summary.history} testId="close-day-history" />
            </>
          )}
        </div>
      )}
      {phase.kind === 'refused' && (
        <div className="space-y-2" data-testid="close-day-refused">
          <p className="text-sm font-semibold text-danger">
            {phase.refusedOn === 'apply' ? 'The closing day was not changed.' : 'The closing day cannot be changed now.'}
          </p>
          <ul className="list-disc space-y-1 pl-5 text-sm text-ink" role="alert" data-testid="close-day-reasons">
            {phase.report.reasons.map((reason) => <li key={reason}>{reason}</li>)}
          </ul>
          {phase.refusedOn === 'apply' && (
            <p className="text-sm text-muted">The card may have changed. Check again to see what moves now.</p>
          )}
        </div>
      )}
      {phase.kind === 'error' && (
        <p className="text-sm text-danger" role="alert" data-testid="close-day-error">{phase.message}</p>
      )}
      {(phase.kind === 'review' || phase.kind === 'applying') && needsAck && (
        <label className="flex items-start gap-2 text-sm text-ink cursor-pointer" data-testid="close-day-ack-label">
          <input
            type="checkbox"
            className="mt-0.5 h-5 w-5 border-line text-ink focus-ring"
            checked={ack}
            disabled={phase.kind === 'applying'}
            onChange={(event) => onAck(event.target.checked)}
            data-testid="close-day-ack"
          />
          <span>I understand past statements will change</span>
        </label>
      )}
      <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        <button
          type="button"
          onClick={onCancel}
          disabled={phase.kind === 'applying'}
          className="btn-secondary focus-ring min-h-11"
          data-testid="close-day-cancel"
        >
          Cancel
        </button>
        {phase.kind === 'review' && (
          <button
            type="button"
            onClick={onConfirm}
            disabled={!canConfirm}
            className="btn-primary focus-ring min-h-11"
            data-testid="close-day-confirm"
          >
            Change closing day
          </button>
        )}
        {phase.kind === 'error' && phase.retry === 'apply' && (
          <button type="button" onClick={onTryAgain} className="btn-primary focus-ring min-h-11" data-testid="close-day-retry">
            Try again
          </button>
        )}
        {((phase.kind === 'error' && phase.retry === 'check') || (phase.kind === 'refused' && phase.refusedOn === 'apply')) && (
          <button type="button" onClick={onCheckAgain} className="btn-primary focus-ring min-h-11" data-testid="close-day-recheck">
            Check again
          </button>
        )}
        {phase.kind === 'applying' && summary && (
          <button type="button" disabled className="btn-primary min-h-11" data-testid="close-day-confirm">
            Changing…
          </button>
        )}
      </div>
    </>
  )
}

interface Props {
  accountId: number
  newDay: number
  /** The change was written. The account form carries on with its other fields. */
  onApplied: (report: CloseDayReport) => void
  /** Nothing the PUT refuses moves with the day: the form saves as it always did. */
  onPlain: () => void
  onCancel: () => void
}

/**
 * The closing-day step of the card form (STU-747). It asks the API for a dry run of the new
 * day. When no installment, printed due or minimum due moves it hands back to the form's plain
 * save (no apply here); otherwise it shows what moves and applies on confirm. Past statements that would change need the checkbox first. A refused check offers
 * only Cancel. Rendered through a portal; while open the app root is `inert`, focus is in the
 * dialog, and it goes back to the element that opened it on close.
 */
export function CloseDayDialog({ accountId, newDay, onApplied, onPlain, onCancel }: Props) {
  const titleId = useId()
  const dialogRef = useRef<HTMLDivElement>(null)
  const [change] = useChangeCloseDayMutation()
  const [phase, setPhase] = useState<CloseDayPhase>({ kind: 'checking' })
  const [ack, setAck] = useState(false)
  // One key per checked report: a retry after an unknown outcome replays the same apply.
  const keyRef = useRef(newOutboxId())
  const attempt = useRef(0)
  const onAppliedRef = useRef(onApplied)
  onAppliedRef.current = onApplied
  const onPlainRef = useRef(onPlain)
  onPlainRef.current = onPlain
  const onCancelRef = useRef(onCancel)
  onCancelRef.current = onCancel
  const applying = phase.kind === 'applying'
  const applyingRef = useRef(applying)
  applyingRef.current = applying

  const openerRef = useRef<Element | null>(null)
  useLayoutEffect(() => {
    openerRef.current ??= document.activeElement
  }, [])

  useEffect(() => {
    const opener = openerRef.current instanceof HTMLElement ? openerRef.current : null
    const root = document.getElementById('root')
    root?.setAttribute('inert', '')
    dialogRef.current?.focus()
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.stopPropagation()
      if (!applyingRef.current) onCancelRef.current()
    }
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('keydown', onKey)
      root?.removeAttribute('inert')
      if (opener?.isConnected) opener.focus()
    }
  }, [])

  // A quick check that ends in the form's plain save shows nothing: the step appears only
  // when the check is slow or it has something to show.
  const [slow, setSlow] = useState(false)
  useEffect(() => {
    if (phase.kind !== 'checking') {
      setSlow(false)
      return
    }
    const timer = setTimeout(() => setSlow(true), CHECKING_SHOWN_AFTER_MS)
    return () => clearTimeout(timer)
  }, [phase.kind])
  const hidden = phase.kind === 'checking' && !slow

  // A phase change can disable the focused button: focus stays inside the dialog.
  useEffect(() => {
    if (!hidden && !dialogRef.current?.contains(document.activeElement)) dialogRef.current?.focus()
  }, [phase.kind, hidden])

  const apply = async (report: CloseDayReport | null) => {
    const mine = ++attempt.current
    setPhase({ kind: 'applying', report })
    try {
      const done = await change({
        accountId,
        data: { close_day: newDay, dry_run: false, accept_history_shift: report ? needsHistoryAck(report) : false },
        idempotencyKey: keyRef.current,
      }).unwrap()
      if (mine === attempt.current) onAppliedRef.current(done)
    } catch (error) {
      if (mine !== attempt.current) return
      const refusal = closeDayRefusal(error)
      setPhase(
        refusal
          ? { kind: 'refused', report: refusal, refusedOn: 'apply' }
          : { kind: 'error', message: apiErrorMessage(error) || 'Could not change the closing day. Try again.', retry: 'apply', report },
      )
    }
  }

  const check = async () => {
    const mine = ++attempt.current
    keyRef.current = newOutboxId()
    setAck(false)
    setPhase({ kind: 'checking' })
    try {
      // The check says yes to a history shift: the API refuses a dry run that would change
      // past statements unless told so, and the step needs that report to show them. The
      // checkbox decides whether the apply goes ahead.
      const report = await change({ accountId, data: { close_day: newDay, dry_run: true, accept_history_shift: true } }).unwrap()
      if (mine !== attempt.current) return
      const next = stepAfterCheck(report)
      if (next === 'plain') onPlainRef.current()
      else if (next === 'review') setPhase({ kind: 'review', report })
      else setPhase({ kind: 'refused', report, refusedOn: 'check' })
    } catch (error) {
      if (mine !== attempt.current) return
      const refusal = closeDayRefusal(error)
      if (refusal && stepAfterCheck(refusal) === 'plain') {
        onPlainRef.current()
        return
      }
      setPhase(
        refusal
          ? { kind: 'refused', report: refusal, refusedOn: 'check' }
          : { kind: 'error', message: apiErrorMessage(error) || 'Could not check the closing day. Try again.', retry: 'check', report: null },
      )
    }
  }
  const checkRef = useRef(check)
  checkRef.current = check

  // The check runs once when the step opens; a later one is the user's Check again.
  useEffect(() => {
    void checkRef.current()
    return () => {
      attempt.current += 1
    }
  }, [])

  const reviewed = phase.kind === 'review' ? phase.report : null
  const retryReport = phase.kind === 'error' ? phase.report : null
  const trapTab = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'Tab') return
    const items = Array.from(dialogRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [])
    const first = items[0]
    const last = items[items.length - 1]
    if (!first || !last) {
      event.preventDefault()
      dialogRef.current?.focus()
      return
    }
    const active = document.activeElement
    if (!dialogRef.current?.contains(active) || active === dialogRef.current) {
      event.preventDefault()
      ;(event.shiftKey ? last : first).focus()
    } else if (event.shiftKey && active === first) {
      event.preventDefault()
      last.focus()
    } else if (!event.shiftKey && active === last) {
      event.preventDefault()
      first.focus()
    }
  }

  if (hidden) return null

  return createPortal(
    <div className="fixed inset-0 z-[60] overflow-y-auto bg-scrim/60 px-4 py-6" data-testid="close-day-overlay">
      <div className="flex min-h-full items-center justify-center">
        <div
          ref={dialogRef}
          tabIndex={-1}
          className="w-full max-w-md space-y-4 border border-line bg-surface p-5 sm:p-6"
          role="dialog"
          aria-modal="true"
          aria-labelledby={titleId}
          aria-busy={phase.kind === 'checking' || phase.kind === 'applying' ? 'true' : undefined}
          data-testid="close-day-dialog"
          onKeyDown={trapTab}
        >
          <CloseDayStepView
            phase={phase}
            newDay={newDay}
            ack={ack}
            titleId={titleId}
            onAck={setAck}
            onConfirm={() => void apply(reviewed)}
            onCancel={onCancel}
            onCheckAgain={() => void check()}
            onTryAgain={() => void apply(retryReport)}
          />
        </div>
      </div>
    </div>,
    document.body,
  )
}
