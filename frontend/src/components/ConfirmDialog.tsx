import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent, ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { useRouterState } from '@tanstack/react-router'
import { createConfirmFlow } from '@tally-trace/shared'
import type { ConfirmRequest } from '@tally-trace/shared'
import { ConfirmContext } from '../hooks/useConfirm'
import { apiErrorMessage } from '../utils/apiError'

// The one in-app confirm dialog (STU-410), in place of the browser's confirm. Rendered
// once, in Layout's signed-in branch, outside every page modal's React tree, so its
// Tab and Escape never reach a host modal's handlers. Its promise semantics live in
// @tally-trace/shared `createConfirmFlow`; this file is the DOM side: the portal, the
// inert page behind it, focus, the Tab trap and Escape, and the lifecycle cancels.

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

/** Body children that are never made inert. */
const NEVER_INERT = new Set(['SCRIPT', 'STYLE', 'TEMPLATE', 'LINK'])

export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [flow] = useState(() => createConfirmFlow(apiErrorMessage))
  const view = useSyncExternalStore(flow.subscribe, flow.get)
  const [host] = useState(() => {
    const el = document.createElement('div')
    el.setAttribute('data-confirm-host', '')
    return el
  })
  const dialogRef = useRef<HTMLDivElement>(null)
  const cancelRef = useRef<HTMLButtonElement>(null)
  const openerRef = useRef<Element | null>(null)
  const titleId = useId()
  const messageId = useId()

  // The opener is read at the request itself: the screen loader may blur it later.
  const ask = useCallback(
    (req: ConfirmRequest) => {
      if (!flow.get().open) openerRef.current = document.activeElement
      return flow.request(req)
    },
    [flow],
  )

  useLayoutEffect(() => {
    document.body.appendChild(host)
    return () => {
      host.remove()
    }
  }, [host])

  // Sign-out unmounts the provider: settle any open request (false), even one whose action is running.
  useEffect(() => () => flow.cancel(), [flow])

  // A move to another page settles it too. Pathname only: a search-param write on the
  // same page (an edit link's cleanup, a month filter) leaves it open.
  const pathname = useRouterState({ select: (s) => s.location.pathname })
  const shownPath = useRef(pathname)
  useEffect(() => {
    if (shownPath.current === pathname) return
    shownPath.current = pathname
    flow.cancel()
  }, [pathname, flow])

  // While open: the page behind is inert, focus starts on Cancel, Escape dismisses.
  // On close both are undone and focus goes back to the opener when it can take it.
  const open = view.open
  useLayoutEffect(() => {
    if (!open) return
    const made: Element[] = []
    for (const child of Array.from(document.body.children)) {
      if (child === host || child.hasAttribute('data-busy-host') || NEVER_INERT.has(child.tagName)) continue
      if (child.hasAttribute('inert')) continue
      child.setAttribute('inert', '')
      made.push(child)
    }
    cancelRef.current?.focus()
    // Capture phase, stopped here: a host dialog's own Escape handler never fires.
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.stopPropagation()
      event.preventDefault()
      flow.dismiss()
    }
    document.addEventListener('keydown', onKey, { capture: true })
    return () => {
      document.removeEventListener('keydown', onKey, { capture: true })
      // Inert off first: an inert element can't take focus back.
      for (const el of made) el.removeAttribute('inert')
      const opener = openerRef.current
      openerRef.current = null
      // Otherwise the screen loader's restore (its #main-content fallback) places focus.
      if (opener instanceof HTMLElement && opener.isConnected && opener.closest('[inert]') === null) {
        opener.focus()
      }
    }
  }, [open, host, flow])

  const trapTab = useCallback((event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'Tab') return
    const items = Array.from(dialogRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [])
    const first = items[0]
    const last = items[items.length - 1]
    if (!first || !last) {
      event.preventDefault()
      return
    }
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

  const dialog = view.open
    ? createPortal(
        <div
          className="fixed inset-0 z-[100] overflow-y-auto bg-black/60 px-4 py-6"
          onClick={() => flow.dismiss()}
          data-testid="confirm-dialog-overlay"
        >
          <div className="flex min-h-full items-center justify-center">
            <div
              ref={dialogRef}
              className="w-full max-w-md border border-line bg-surface p-5 sm:p-6 space-y-4"
              role="alertdialog"
              aria-modal="true"
              aria-labelledby={titleId}
              aria-describedby={messageId}
              aria-busy={view.pending ? 'true' : undefined}
              data-testid="confirm-dialog"
              onClick={(event) => event.stopPropagation()}
              onKeyDown={trapTab}
            >
              <h2 id={titleId} className="text-lg font-semibold text-ink" data-testid="confirm-dialog-title">
                {view.request.title}
              </h2>
              <p id={messageId} className="text-sm text-body" data-testid="confirm-dialog-message">
                {view.request.message}
              </p>
              {view.error && (
                <p role="alert" data-testid="confirm-dialog-error" className="text-sm text-danger">
                  {view.error}
                </p>
              )}
              <div className="flex flex-wrap justify-end gap-2">
                <button
                  ref={cancelRef}
                  type="button"
                  onClick={() => flow.dismiss()}
                  disabled={view.pending}
                  className="btn-secondary focus-ring disabled:opacity-60"
                  data-testid="confirm-dialog-cancel"
                >
                  {view.request.cancelLabel ?? 'Cancel'}
                </button>
                <button
                  type="button"
                  onClick={() => flow.accept()}
                  disabled={view.pending}
                  className={`${view.request.tone === 'default' ? 'btn-primary' : 'btn-danger'} focus-ring disabled:opacity-60`}
                  data-testid="confirm-dialog-confirm"
                >
                  {view.request.confirmLabel}
                </button>
              </div>
            </div>
          </div>
        </div>,
        host,
      )
    : null

  return (
    <ConfirmContext.Provider value={ask}>
      {children}
      {dialog}
    </ConfirmContext.Provider>
  )
}
