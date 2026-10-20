import { useCallback, useEffect, useId, useRef } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent } from 'react'
import { createPortal } from 'react-dom'
import { Link } from '@tanstack/react-router'
import { payableActions, payableTarget } from '@tally-trace/shared'
import type { Payable } from '@tally-trace/shared'

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

/** What the row already shows, so the dialog reads the same. */
export interface PayableDisplay {
  name: string
  dateLabel: string
  amountText: string
  amountTitle: string | undefined
  detail: string
  statusLabel: string
  dueLabel: string
}

interface Props {
  /** A full row; a Limited row never opens. */
  payable: Payable
  display: PayableDisplay
  onClose: () => void
}

/**
 * An upcoming payable, opened from its row: what it is, and for a statement or loan a
 * link to its account. View only; recurring entries and transactions are edited on the
 * Allocations and Transactions pages.
 *
 * Rendered through a portal; while it is open the app root is `inert`, so focus and
 * assistive technology stay inside. Inert is cleared before focus returns to the row
 * that opened it.
 */
export function PayableDetailDialog({ payable, display, onClose }: Props) {
  const titleId = useId()
  const dialogRef = useRef<HTMLDivElement>(null)
  const closeRef = useRef<HTMLButtonElement>(null)
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose

  const target = payableTarget(payable)
  const actions = payableActions(target)

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

  return createPortal(
    <div
      className="fixed inset-0 z-[60] overflow-y-auto bg-black/60 px-4 py-6"
      onClick={onClose}
      data-testid="payable-dialog-overlay"
    >
      <div className="flex min-h-full items-center justify-center">
        <div
          ref={dialogRef}
          className="w-full max-w-md border border-line bg-surface p-5 sm:p-6 space-y-4"
          role="dialog"
          aria-modal="true"
          aria-labelledby={titleId}
          data-testid="payable-dialog"
          onClick={(event) => event.stopPropagation()}
          onKeyDown={trapTab}
        >
          <div className="flex items-start justify-between gap-4">
            <div>
              <h2 id={titleId} className="text-lg font-semibold text-ink">{display.name}</h2>
              <p className="text-sm text-muted">{display.statusLabel}</p>
            </div>
            <button ref={closeRef} type="button" onClick={onClose} className="btn-secondary focus-ring">
              Close
            </button>
          </div>

          <dl className="space-y-2 text-sm">
            <div className="flex justify-between gap-4">
              <dt className="text-muted">Due</dt>
              <dd className="text-right text-ink">
                {display.dateLabel} · {display.dueLabel}
              </dd>
            </div>
            <div className="flex justify-between gap-4">
              <dt className="text-muted">Amount</dt>
              <dd className="text-right font-medium text-ink" title={display.amountTitle}>{display.amountText}</dd>
            </div>
            <div className="flex justify-between gap-4">
              <dt className="text-muted">Details</dt>
              <dd className="text-right text-body">{display.detail}</dd>
            </div>
          </dl>

          {(target.kind === 'budget_entry' || target.kind === 'transaction') && (
            <p className="text-sm text-muted" data-testid="payable-edit-hint">
              Edit recurring entries in Allocations and transactions on the Transactions page.
            </p>
          )}

          {target.kind === 'account' && actions.accountId !== null && (
            <div className="flex flex-wrap gap-2">
              <Link
                to="/accounts/$accountId"
                params={{ accountId: String(actions.accountId) }}
                className="btn-primary focus-ring"
                data-testid="payable-account-link"
              >
                {target.source === 'loan' ? 'View loan account' : 'View card account'}
              </Link>
            </div>
          )}
        </div>
      </div>
    </div>,
    document.body,
  )
}
