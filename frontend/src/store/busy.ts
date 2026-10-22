// The screen loader's busy level (STU-335, R5): the screen is busy while any RTK
// mutation is in flight or any RTK query is fetching, across both APIs, except the
// endpoints named in EXEMPT_ENDPOINTS. Nothing is declared per screen.
//
// - Mutations are counted from their actions, keyed by request id: `useMutation`
//   resets its substate on unmount, so the mutations state cannot show what is in flight.
// - Queries are read from state as a level, which joined requests, StrictMode,
//   `resetApiState` and cache removal can never leave stale.
// - The level is computed in a middleware and published synchronously to `busySignal`,
//   not from `store.subscribe`, which the auto-batch enhancer defers to a frame.
import { isAction } from '@reduxjs/toolkit'
import type { Middleware } from '@reduxjs/toolkit'
import { anyQueryPending, applyRequestAction, idleLevel, publishGate } from '@tally-trace/shared'
import type { BusyLevel, QuerySliceLike, RequestActionLike } from '@tally-trace/shared'

/**
 * Endpoints that never make the screen busy, as a query or a mutation. Only the named
 * request is exempt: the refetches its own tag invalidation starts belong to other
 * endpoints and still count.
 *
 * STU-343 hook point: Plan B's page-open auto-post gets its own endpoint name and is
 * added here.
 */
export const EXEMPT_ENDPOINTS: ReadonlySet<string> = new Set(['fetchReceipt'])

/** The two APIs' reducer paths (`store/api.ts`, `store/authApi.ts`). */
const REDUCER_PATHS = ['accountingApi', 'authApi'] as const

// ─── The published level ─────────────────────────────────────────────────────

type BusyListener = (level: BusyLevel) => void

let current: BusyLevel = idleLevel
const listeners = new Set<BusyListener>()

/**
 * A tiny external store for the level. `subscribe(fn)` calls `fn` synchronously on
 * every published change (inside the dispatch that changed it) and returns the
 * unsubscribe function. It is not Redux state, so the auto-batch enhancer never
 * delays it.
 */
export const busySignal = {
  get(): BusyLevel {
    return current
  },
  subscribe(fn: BusyListener): () => void {
    listeners.add(fn)
    return () => {
      listeners.delete(fn)
    }
  },
}

function publish(level: BusyLevel): void {
  current = level
  for (const fn of [...listeners]) {
    try {
      fn(level)
    } catch (error) {
      // A listener's failure must never break the dispatch that published.
      globalThis.reportError?.(error)
    }
  }
}

// ─── The middleware ──────────────────────────────────────────────────────────

function querySlice(state: unknown, path: string): QuerySliceLike | undefined {
  if (typeof state !== 'object' || state === null) return undefined
  const apiState: unknown = (state as Record<string, unknown>)[path]
  if (typeof apiState !== 'object' || apiState === null) return undefined
  const queries: unknown = (apiState as Record<string, unknown>).queries
  if (typeof queries !== 'object' || queries === null) return undefined
  return queries as QuerySliceLike
}

let mutationIds: ReadonlySet<string> = new Set()
let published: BusyLevel = idleLevel
/** Dispatches currently inside the middleware (nested ones re-enter at depth >= 2). */
let depth = 0

/**
 * Placed before the API middlewares, so `next(action)` runs the reducers and then the
 * API handlers, tag invalidation included: any refetch an invalidation starts is
 * already `pending` when `next` returns.
 *
 * A mutation's id is added and deleted only after its action's `next` returns, so a
 * `resetApiState` dispatched from that mutation's own `onQueryStarted` (sign-out)
 * cannot remove it, and a save's id is gone only once its reload is already pending.
 * A `false` level is published only at depth 0, so a nested dispatch never publishes
 * `busy: false` in the middle of an outer settle.
 */
export const busyMiddleware: Middleware = (storeApi) => (next) => (action) => {
  depth++
  try {
    return next(action)
  } finally {
    depth--
    if (isAction(action)) {
      mutationIds = applyRequestAction(mutationIds, action as RequestActionLike, REDUCER_PATHS, EXEMPT_ENDPOINTS)
    }
    const saving = mutationIds.size > 0
    const state = storeApi.getState()
    const level: BusyLevel = {
      busy: saving || anyQueryPending(REDUCER_PATHS.map((path) => querySlice(state, path)), EXEMPT_ENDPOINTS),
      saving,
    }
    const gate = publishGate(published, level, depth)
    published = gate.state
    if (gate.publish) publish(level)
  }
}

// ─── Programmatic clicks the screen loader lets through ──────────────────────

const allowedClicks = new WeakSet<EventTarget>()

/**
 * Lets one synthetic `click` on `el` through the screen loader's input guard (the
 * export download's anchor). Identity decides; `isTrusted` is never read.
 */
export function allowProgrammaticClick(el: EventTarget): void {
  allowedClicks.add(el)
}

export function releaseProgrammaticClick(el: EventTarget): void {
  allowedClicks.delete(el)
}

export function isProgrammaticClickAllowed(target: EventTarget | null): boolean {
  return target !== null && allowedClicks.has(target)
}
