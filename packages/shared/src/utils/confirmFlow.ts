// The in-app confirm dialog's promise semantics (STU-410), with no React: one request
// open at a time, an optional action run on accept whose failure keeps the dialog open
// with its message, and a lifecycle cancel that settles at once and ignores a late action.
// Published as a tiny external store, in the same shape as the screen loader's busySignal.

export interface ConfirmRequest {
  title: string
  message: string
  /** An explicit verb: "Delete account", "Stop sharing", "Leave". */
  confirmLabel: string
  /** Defaults to "Cancel". */
  cancelLabel?: string
  /** 'danger' (the default) for a destructive verb; 'default' for a plain one, such as a role change. */
  tone?: 'danger' | 'default'
  /** Run on accept: success closes and resolves true; a throw keeps the dialog open with its message. */
  action?: () => Promise<unknown>
  /** Shown when the error's own description is ''. */
  errorFallback?: string
}

export type ConfirmView =
  | { open: false }
  | { open: true; request: ConfirmRequest; pending: boolean; error: string | null }

export interface ConfirmFlow {
  /** Resolves true once accepted (and its action succeeded), false otherwise; false at once if one is already open. */
  request(req: ConfirmRequest): Promise<boolean>
  /** No action: resolve true and close. With an action: pending; success resolves true and closes, a throw shows the error and stays open. */
  accept(): void
  /** The user's Cancel, Escape or backdrop: resolve false and close. Ignored while pending. */
  dismiss(): void
  /** Lifecycle (unmount, navigation): unconditional, also while pending; resolve false and close. A late action settle is ignored. */
  cancel(): void
  get(): ConfirmView
  subscribe(fn: (view: ConfirmView) => void): () => void
}

export const CONFIRM_DEFAULT_ERROR = 'Something went wrong. Please try again.'

const closed: ConfirmView = { open: false }

export function createConfirmFlow(describeError: (error: unknown) => string): ConfirmFlow {
  let view: ConfirmView = closed
  /** Bumped on every open and every close, so an action can tell whether its request is still the open one. */
  let generation = 0
  let resolveOpen: ((value: boolean) => void) | null = null
  const listeners = new Set<(view: ConfirmView) => void>()

  const publish = (next: ConfirmView) => {
    view = next
    for (const fn of [...listeners]) fn(next)
  }

  const close = (value: boolean) => {
    generation++
    const resolve = resolveOpen
    resolveOpen = null
    resolve?.(value)
    publish(closed)
  }

  return {
    request(req) {
      if (view.open) return Promise.resolve(false)
      generation++
      return new Promise<boolean>((resolve) => {
        resolveOpen = resolve
        publish({ open: true, request: req, pending: false, error: null })
      })
    },

    accept() {
      if (!view.open || view.pending) return
      const { request } = view
      const action = request.action
      if (!action) {
        close(true)
        return
      }
      const own = generation
      publish({ open: true, request, pending: true, error: null })
      let running: Promise<unknown>
      try {
        running = Promise.resolve(action())
      } catch (error) {
        running = Promise.reject(error)
      }
      // Both handlers are attached here, so a stale rejection is never unhandled.
      running.then(
        () => {
          if (own !== generation) return
          close(true)
        },
        (error: unknown) => {
          if (own !== generation) return
          const message = describeError(error) || request.errorFallback || CONFIRM_DEFAULT_ERROR
          publish({ open: true, request, pending: false, error: message })
        },
      )
    },

    dismiss() {
      if (!view.open || view.pending) return
      close(false)
    },

    cancel() {
      if (!view.open) return
      close(false)
    },

    get() {
      return view
    },

    subscribe(fn) {
      listeners.add(fn)
      return () => {
        listeners.delete(fn)
      }
    },
  }
}
