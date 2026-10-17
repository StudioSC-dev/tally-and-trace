import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent, RefObject } from 'react'
import { createPortal } from 'react-dom'
import { Link, useNavigate } from '@tanstack/react-router'
import { isDetailed, payableActions, payableTarget } from '@tally-trace/shared'
import type { FullBudgetEntry, Payable, SharedFullBudgetEntry } from '@tally-trace/shared'
import {
  useDeleteTransactionMutation,
  useGetAccountsQuery,
  useGetAllocationsQuery,
  useGetBudgetEntryQuery,
  useGetCategoriesQuery,
  useGetTransactionQuery,
} from '../../store/api'
import { useDeleteRecurringEntry } from '../../hooks/useDeleteRecurringEntry'
import { apiErrorMessage } from '../../utils/apiError'
import { RecurringEntryFormModal } from '../RecurringEntryFormModal'

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

type EditableEntry = FullBudgetEntry | SharedFullBudgetEntry

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
  /** The entry from the dashboard's list, when it holds it; otherwise the dialog looks it up. */
  entry: EditableEntry | undefined
  /** The dashboard doesn't rule out marking this entry paid. */
  canMarkPaid: boolean
  posting: boolean
  /** Called once the caller picks Mark paid; the dashboard closes the dialog first. */
  onMarkPaid: (entry: EditableEntry) => void
  onClose: () => void
  /** Takes focus after a delete, when the row that opened the dialog is gone. */
  deletedFocusRef: RefObject<HTMLElement>
}

/**
 * An upcoming payable, opened from its row: what it is, and the actions the caller's
 * permission flags allow. A recurring entry is edited here, in its own form; a
 * transaction is edited on the Transactions page, which returns to the dashboard afterwards.
 *
 * Rendered through a portal; while it is open the app root is `inert`, so focus and
 * assistive technology stay inside. Inert is cleared before focus returns to the row
 * that opened it, or, after a delete, to `deletedFocusRef`.
 */
export function PayableDetailDialog({
  payable, display, entry, canMarkPaid, posting, onMarkPaid, onClose, deletedFocusRef,
}: Props) {
  const titleId = useId()
  const navigate = useNavigate()
  const dialogRef = useRef<HTMLDivElement>(null)
  const formRef = useRef<HTMLDivElement>(null)
  const closeRef = useRef<HTMLButtonElement>(null)
  const editRef = useRef<HTMLButtonElement>(null)
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose
  // Detail, or the recurring entry form in its place.
  const [mode, setMode] = useState<'detail' | 'edit'>('detail')
  const modeRef = useRef(mode)
  modeRef.current = mode
  // Where focus goes once the mode switch has rendered.
  const pendingFocus = useRef<'form' | 'edit' | null>(null)
  // The row is gone after a delete, so focus goes to `deletedFocusRef` instead.
  const deletedRef = useRef(false)

  const deleteRecurringEntry = useDeleteRecurringEntry()
  const [deleteTransaction, { isLoading: deletingTransaction }] = useDeleteTransactionMutation()

  const target = payableTarget(payable)
  const entryLookup = useGetBudgetEntryQuery(target.kind === 'budget_entry' ? target.id : 0, {
    skip: target.kind !== 'budget_entry' || entry !== undefined,
  })
  const transactionLookup = useGetTransactionQuery(target.kind === 'transaction' ? target.id : 0, {
    skip: target.kind !== 'transaction',
  })
  const lookup =
    target.kind === 'budget_entry' && entry === undefined
      ? entryLookup
      : target.kind === 'transaction'
        ? transactionLookup
        : null
  const lookupError = lookup?.error
  // RTK Query keeps the last good data after a failed refetch, so a lookup that has
  // errored is treated as no record at all: no actions, nothing editable.
  const entryRecord =
    target.kind === 'budget_entry' && lookupError === undefined ? entry ?? entryLookup.currentData : undefined
  const record =
    lookupError !== undefined ? undefined : target.kind === 'transaction' ? transactionLookup.currentData : entryRecord
  const gone = lookupError !== undefined && 'status' in lookupError && lookupError.status === 404
  const checking = lookup !== null && record === undefined && lookupError === undefined
  const actions = payableActions(target, record)
  const editableEntry = entryRecord && isDetailed(entryRecord) ? entryRecord : null
  const showMarkPaid = canMarkPaid && actions.markPaid && editableEntry !== null

  // Focus into the dialog, make the page behind inert, and undo both on close.
  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const root = document.getElementById('root')
    // The card heading outlives the dialog, so it is read once here.
    const afterDelete = deletedFocusRef.current
    root?.setAttribute('inert', '')
    closeRef.current?.focus()
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.stopPropagation()
      if (modeRef.current === 'edit') {
        pendingFocus.current = 'edit'
        setMode('detail')
      } else {
        onCloseRef.current()
      }
    }
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('keydown', onKey)
      // Inert off first: an inert element can't take focus back.
      root?.removeAttribute('inert')
      if (deletedRef.current || !opener?.isConnected) {
        afterDelete?.focus()
      } else {
        opener.focus()
      }
    }
  }, [deletedFocusRef])

  // The record went away, or edit permission was lost, under an open form: back to the detail view, which says so.
  const formEntry = actions.edit ? editableEntry : null
  const formLost = mode === 'edit' && formEntry === null
  useEffect(() => {
    if (formLost) {
      pendingFocus.current = 'edit'
      setMode('detail')
    }
  }, [formLost])

  // Hand focus over when the form replaces the details, and back when it goes.
  useEffect(() => {
    const next = pendingFocus.current
    pendingFocus.current = null
    if (next === 'form') {
      const container = formRef.current
      const field = container?.querySelector<HTMLElement>('input, select, textarea')
      const target = field ?? container?.querySelector<HTMLElement>(FOCUSABLE)
      target?.focus()
    } else if (next === 'edit') {
      const target = editRef.current ?? closeRef.current
      target?.focus()
    }
  }, [mode])

  const trapTab = useCallback((event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'Tab') return
    const container = modeRef.current === 'edit' ? formRef.current : dialogRef.current
    const items = Array.from(container?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [])
    const first = items[0]
    const last = items[items.length - 1]
    if (!first || !last) return
    const active = document.activeElement
    if (!container?.contains(active)) {
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

  const closeAfterDelete = () => {
    deletedRef.current = true
    onClose()
  }

  const openForm = () => {
    pendingFocus.current = 'form'
    setMode('edit')
  }

  const backToDetail = () => {
    pendingFocus.current = 'edit'
    setMode('detail')
  }

  const handleEdit = () => {
    if (target.kind === 'budget_entry') {
      openForm()
    } else if (target.kind === 'transaction') {
      // The Transactions page opens its form, then comes back here when it closes.
      navigate({ to: '/transactions', search: { edit: target.id, from: 'dashboard' } })
    }
  }

  const handleDelete = async () => {
    if (target.kind === 'budget_entry' && editableEntry) {
      if (await deleteRecurringEntry(editableEntry)) {
        closeAfterDelete()
      }
      return
    }
    if (target.kind !== 'transaction') return
    if (!confirm('Are you sure you want to delete this transaction?')) return
    try {
      await deleteTransaction(target.id).unwrap()
      closeAfterDelete()
    } catch (error) {
      console.error('Error deleting transaction:', error)
      alert(apiErrorMessage(error) || 'Could not delete the transaction. Please try again.')
    }
  }

  if (mode === 'edit' && formEntry) {
    return createPortal(
      <div
        ref={formRef}
        onKeyDown={trapTab}
        role="dialog"
        aria-modal="true"
        aria-label="Edit recurring entry"
        data-testid="payable-entry-form"
      >
        <PayableEntryForm
          entry={formEntry}
          onClose={backToDetail}
          onSaved={onClose}
          onDeleted={closeAfterDelete}
        />
      </div>,
      document.body,
    )
  }

  const hasActions = actions.edit || actions.delete || showMarkPaid

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

          {checking && (
            <p className="text-sm text-muted" role="status" data-testid="payable-checking">
              Checking what you can do…
            </p>
          )}
          {gone && (
            <p className="text-sm text-warn" role="alert" data-testid="payable-gone">
              This item is no longer available.
            </p>
          )}
          {lookupError !== undefined && !gone && (
            <p className="text-sm text-warn" role="alert">
              {apiErrorMessage(lookupError) || "Couldn't check what you can do with this item."}
            </p>
          )}
          {record !== undefined && !hasActions && (
            <p className="text-sm text-muted" data-testid="payable-read-only">
              You can view this item but not change it here.
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

          {hasActions && (
            <div className="flex flex-wrap gap-2">
              {showMarkPaid && editableEntry && (
                <button
                  type="button"
                  onClick={() => onMarkPaid(editableEntry)}
                  disabled={posting}
                  className="btn-primary focus-ring disabled:opacity-50"
                  data-testid="payable-mark-paid"
                >
                  {posting ? 'Posting…' : 'Mark paid'}
                </button>
              )}
              {actions.edit && (
                <button
                  ref={editRef}
                  type="button"
                  onClick={handleEdit}
                  className="btn-secondary focus-ring"
                  data-testid="payable-edit"
                >
                  Edit
                </button>
              )}
              {actions.delete && (
                <button
                  type="button"
                  onClick={() => void handleDelete()}
                  disabled={deletingTransaction}
                  className="btn-secondary focus-ring text-danger disabled:opacity-50"
                  data-testid="payable-delete"
                >
                  Delete
                </button>
              )}
            </div>
          )}
        </div>
      </div>
    </div>,
    document.body,
  )
}

/**
 * The recurring entry form with the reference data it needs, fetched with the
 * same arguments as the Allocations page for accounts and categories, and as the
 * dashboard for allocations, so each hits the cache that page already filled.
 */
function PayableEntryForm({
  entry, onClose, onSaved, onDeleted,
}: {
  entry: EditableEntry
  onClose: () => void
  onSaved: () => void
  onDeleted: () => void
}) {
  const { data: accountsData } = useGetAccountsQuery({ is_active: true, limit: 100 })
  const { data: categoriesData } = useGetCategoriesQuery({ is_active: true })
  const { data: allocationsData } = useGetAllocationsQuery({ limit: 1000, offset: 0 })
  const accounts = useMemo(() => accountsData?.items ?? [], [accountsData])
  const categories = useMemo(() => categoriesData ?? [], [categoriesData])
  // The Allocations page's envelope list: active first, then by name, budgets only.
  const budgetEnvelopes = useMemo(
    () =>
      [...(allocationsData?.items ?? [])]
        .sort((a, b) => (a.is_active === b.is_active ? a.name.localeCompare(b.name) : Number(b.is_active) - Number(a.is_active)))
        .filter((allocation) => allocation.allocation_type === 'budget'),
    [allocationsData]
  )
  return (
    <RecurringEntryFormModal
      key={entry.id}
      entry={entry}
      accounts={accounts}
      categories={categories}
      budgetEnvelopes={budgetEnvelopes}
      onClose={onClose}
      onSaved={onSaved}
      onDeleted={onDeleted}
    />
  )
}
