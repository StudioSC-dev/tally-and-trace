import { useCallback, useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { useDispatch, useSelector } from 'react-redux'
import { useNavigate } from '@tanstack/react-router'
import type { OutboxCompletion, OutboxEntry } from '@tally-trace/shared'
import { ToastContext } from '../hooks/useToast'
import type { AppDispatch, RootState } from '../store'
import { outboxActions } from '../store/outbox'
import { OUTBOX_FORMS } from '../store/outboxForms'
import { Spinner } from './Loading'

// The in-app toast stack. Two sources share it:
// - `useToast(message)` (STU-410): one message at a time, for an outcome with no dialog or form
//   to hold it; it stays until dismissed, and a newer one replaces it.
// - The save outbox (STU-605): one toast per background save, turning in place from pending
//   (spinner) to "Saved" (gone after 4 s, with View and Undo) or to a failure that stays until
//   acted on (Retry, Edit, Discard).
// Newest at the bottom; at most four are shown, the rest behind "+N more". It lives in Layout,
// so it outlasts a move between pages. Its mobile bottom offset is the tab bar clearance (6rem)
// plus the device safe-area inset, since BottomNav pads itself by that inset.

/** How long a "Saved" toast stays. */
export const SAVED_TOAST_MS = 4000
/** Toasts shown before the rest fold into "+N more". */
export const MAX_VISIBLE_TOASTS = 4

type Variant = 'info' | 'pending' | 'success' | 'error'

interface Action {
  label: string
  testId: string
  onClick: () => void
}

interface Item {
  key: string
  seq: number
  variant: Variant
  message: string
  actions: Action[]
  onDismiss: (() => void) | null
  clientId?: string
}

const VARIANT_CLASSES: Record<Variant, string> = {
  info: 'border-line',
  pending: 'border-line',
  success: 'border-ok',
  error: 'border-danger',
}

const STATE_OF: Record<Variant, string> = { info: 'info', pending: 'pending', success: 'saved', error: 'failed' }

const verb = (kind: OutboxEntry['kind']) => (kind === 'delete' ? 'delete' : 'save')

function failureMessage(entry: OutboxEntry): string {
  const error = entry.error
  if (error?.notConfirmed || error?.superseded) return `"${entry.description}": ${error.message}`
  return `Couldn't ${verb(entry.kind)} "${entry.description}": ${error?.message ?? 'Something went wrong.'}`
}

function savedMessage(completion: OutboxCompletion): string {
  return completion.kind === 'delete' ? `Deleted "${completion.description}"` : `Saved "${completion.description}"`
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const dispatch = useDispatch<AppDispatch>()
  const navigate = useNavigate()
  const entries = useSelector((state: RootState) => state.outbox.entries)
  const completions = useSelector((state: RootState) => state.outbox.completions)
  const [info, setInfo] = useState<{ id: number; seq: number; message: string } | null>(null)
  const [expanded, setExpanded] = useState(false)
  // Each toast's place in the stack, by key, fixed when first seen: a save's toast keeps its
  // place as it turns from pending to saved or failed.
  const order = useRef(new Map<string, number>())
  const nextSeq = useRef(0)
  const seqOf = (key: string) => {
    let seq = order.current.get(key)
    if (seq === undefined) {
      nextSeq.current += 1
      seq = nextSeq.current
      order.current.set(key, seq)
    }
    return seq
  }
  // "Saved" toasts already timed out or dismissed.
  const [hiddenSaved, setHiddenSaved] = useState<ReadonlySet<string>>(new Set())
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>())

  const show = useCallback((message: string) => {
    nextSeq.current += 1
    setInfo({ id: nextSeq.current, seq: nextSeq.current, message })
  }, [])

  const hideSaved = useCallback((clientId: string) => {
    setHiddenSaved((prev) => (prev.has(clientId) ? prev : new Set([...prev, clientId])))
  }, [])

  // Each new "Saved" toast goes after SAVED_TOAST_MS.
  useEffect(() => {
    for (const completion of completions) {
      if (timers.current.has(completion.clientId)) continue
      timers.current.set(
        completion.clientId,
        setTimeout(() => hideSaved(completion.clientId), SAVED_TOAST_MS),
      )
    }
  }, [completions, hideSaved])
  // Unfolded once, the stack folds again when it is short enough.
  const fits = entries.length + completions.length + (info ? 1 : 0) <= MAX_VISIBLE_TOASTS
  useEffect(() => {
    if (fits) setExpanded(false)
  }, [fits])
  useEffect(() => {
    const all = timers.current
    return () => {
      for (const timer of all.values()) clearTimeout(timer)
    }
  }, [])

  const items: Item[] = []
  if (info) {
    items.push({
      key: `info:${info.id}`,
      seq: info.seq,
      variant: 'info',
      message: info.message,
      actions: [],
      onDismiss: () => setInfo(null),
    })
  }
  for (const entry of entries) {
    const handlers = OUTBOX_FORMS[entry.form]
    const failed = entry.status === 'failed'
    const actions: Action[] = []
    if (failed && entry.error?.retryable) {
      actions.push({ label: 'Retry', testId: 'save-toast-retry', onClick: () => dispatch(outboxActions.retried(entry.clientId)) })
    }
    // Edit only for a refusal: after an unknown outcome the save may have landed, so the safe
    // choices are Retry (same key) and Discard.
    if (failed && entry.error && !entry.error.retryable && handlers && entry.draft !== null) {
      actions.push({
        label: 'Edit',
        testId: 'save-toast-edit',
        onClick: () => {
          dispatch(outboxActions.editRequested(entry.clientId))
          void navigate({ to: handlers.path })
        },
      })
    }
    if (failed) {
      actions.push({ label: 'Discard', testId: 'save-toast-discard', onClick: () => dispatch(outboxActions.discarded(entry.clientId)) })
    }
    items.push({
      key: entry.clientId,
      seq: seqOf(entry.clientId),
      variant: failed ? 'error' : 'pending',
      message: failed ? failureMessage(entry) : entry.label,
      actions,
      onDismiss: null,
      clientId: entry.clientId,
    })
  }
  for (const completion of completions) {
    if (hiddenSaved.has(completion.clientId)) continue
    const handlers = OUTBOX_FORMS[completion.form]
    const actions: Action[] = []
    const serverId = completion.serverId ?? completion.targetId
    if (handlers && completion.viewable && serverId !== undefined) {
      actions.push({
        label: 'View',
        testId: 'save-toast-view',
        onClick: () => {
          dispatch(outboxActions.highlightRequested({ form: completion.form, id: serverId }))
          void navigate({ to: handlers.path })
        },
      })
    }
    const undo = completion.undoable ? handlers?.undo?.(completion) ?? null : null
    if (undo) {
      actions.push({
        label: 'Undo',
        testId: 'save-toast-undo',
        onClick: () => {
          hideSaved(completion.clientId)
          dispatch(outboxActions.enqueued(undo))
        },
      })
    }
    items.push({
      key: completion.clientId,
      seq: seqOf(completion.clientId),
      variant: 'success',
      message: savedMessage(completion),
      actions,
      onDismiss: () => hideSaved(completion.clientId),
      clientId: completion.clientId,
    })
  }
  items.sort((a, b) => a.seq - b.seq)
  const hiddenCount = expanded ? 0 : Math.max(0, items.length - MAX_VISIBLE_TOASTS)
  const visible = items.slice(hiddenCount)

  return (
    <ToastContext.Provider value={show}>
      {children}
      {items.length > 0 && (
        <div
          data-testid="toast-stack"
          className="fixed bottom-[calc(6rem+env(safe-area-inset-bottom,0px))] left-4 right-4 z-[70] flex max-h-[70vh] flex-col gap-2 overflow-y-auto sm:bottom-6 sm:left-auto sm:right-6 sm:w-96"
        >
          {hiddenCount > 0 && (
            <button
              type="button"
              className="btn-secondary focus-ring self-end text-xs"
              onClick={() => setExpanded(true)}
              data-testid="toast-more"
            >
              +{hiddenCount} more
            </button>
          )}
          {visible.map((item) =>
            item.variant === 'info' ? (
              // Keyed by id, so a newer message is a new alert and is announced again.
              <div
                key={item.key}
                role="alert"
                data-testid="toast"
                className="flex items-start gap-3 border border-line bg-surface p-4"
              >
                <p className="flex-1 text-sm text-body" data-testid="toast-message">
                  {item.message}
                </p>
                <button type="button" onClick={() => item.onDismiss?.()} className="btn-secondary focus-ring" data-testid="toast-dismiss">
                  Dismiss
                </button>
              </div>
            ) : (
              <div
                key={item.key}
                role={item.variant === 'error' ? 'alert' : 'status'}
                data-testid="save-toast"
                data-state={STATE_OF[item.variant]}
                data-client-id={item.clientId}
                className={`flex flex-col gap-2 border bg-surface p-3 ${VARIANT_CLASSES[item.variant]}`}
              >
                <div className="flex items-start gap-2">
                  {item.variant === 'pending' && <Spinner size="sm" className="mt-0.5 shrink-0" />}
                  <p className={`flex-1 text-sm ${item.variant === 'error' ? 'text-danger' : 'text-body'}`} data-testid="save-toast-message">
                    {item.message}
                  </p>
                  {item.onDismiss && (
                    <button
                      type="button"
                      onClick={item.onDismiss}
                      className="text-muted hover:text-ink focus-ring px-1"
                      aria-label="Dismiss"
                      data-testid="save-toast-dismiss"
                    >
                      ×
                    </button>
                  )}
                </div>
                {item.actions.length > 0 && (
                  <div className="flex flex-wrap justify-end gap-2">
                    {item.actions.map((action) => (
                      <button
                        key={action.testId}
                        type="button"
                        onClick={action.onClick}
                        className="btn-secondary focus-ring !px-2.5 !py-1 text-xs"
                        data-testid={action.testId}
                      >
                        {action.label}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            ),
          )}
        </div>
      )}
    </ToastContext.Provider>
  )
}
