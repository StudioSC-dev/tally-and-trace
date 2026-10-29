import { useCallback, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { ToastContext } from '../hooks/useToast'

// The in-app toast (STU-410): one message at a time, for an outcome with no dialog or
// form to hold it (a linked transaction that no longer exists, then a move away). It
// lives in Layout, so it outlasts that move, and stays until dismissed: no timeout.
// Its mobile bottom offset is the tab bar clearance (6rem) plus the device safe-area inset,
// since BottomNav pads itself by that inset and so grows taller on a notched device.

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toast, setToast] = useState<{ id: number; message: string } | null>(null)
  const nextId = useRef(0)

  const show = useCallback((message: string) => {
    nextId.current += 1
    setToast({ id: nextId.current, message })
  }, [])

  return (
    <ToastContext.Provider value={show}>
      {children}
      {toast && (
        // Keyed by id, so a newer message is a new alert and is announced again.
        <div
          key={toast.id}
          role="alert"
          data-testid="toast"
          className="fixed bottom-[calc(6rem+env(safe-area-inset-bottom,0px))] left-4 right-4 z-[70] flex items-start gap-3 border border-line bg-surface p-4 sm:bottom-6 sm:left-auto sm:right-6 sm:max-w-sm"
        >
          <p className="flex-1 text-sm text-body" data-testid="toast-message">
            {toast.message}
          </p>
          <button
            type="button"
            onClick={() => setToast(null)}
            className="btn-secondary focus-ring"
            data-testid="toast-dismiss"
          >
            Dismiss
          </button>
        </div>
      )}
    </ToastContext.Provider>
  )
}
