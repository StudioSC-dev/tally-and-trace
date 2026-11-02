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
// - Quiet query requests (`runQuietSync`, QUIET_REFETCH_MUTATIONS) stay out of the level
//   until they settle or `releaseQuiet` hands them back; `quietPending` says whether any
//   is in flight.
// - A save abandoned mid-POST (`abandonSave`) stays pending, through its POST and the refresh
//   its success starts, whatever closes or reopens meanwhile; `abandonedSavePending` says so.
import { useSyncExternalStore } from 'react'
import { isAction } from '@reduxjs/toolkit'
import type { Middleware } from '@reduxjs/toolkit'
import {
  anyQueryPending,
  applyQuietQueryAction,
  applyRequestAction,
  idleLevel,
  isQuietSettle,
  publishGate,
} from '@tally-trace/shared'
import type { BusyLevel, QuerySliceLike, RequestActionLike } from '@tally-trace/shared'

/**
 * Endpoints that never make the screen busy, as a query or a mutation. Only the named
 * request is exempt: the refetches its own tag invalidation starts belong to other
 * endpoints and still count.
 *
 * `postDueInstallmentsOnOpen` is the page-open auto-post (STU-343); the refetches it starts when it posts still count.
 * `createTransactionQuiet` is the "Save and add another" save (STU-475); its refetches are quiet too, see below.
 */
export const EXEMPT_ENDPOINTS: ReadonlySet<string> = new Set([
  'fetchReceipt',
  'postDueInstallmentsOnOpen',
  'createTransactionQuiet',
])

/**
 * Mutations whose tag-invalidation refetches are quiet as well. Separate from EXEMPT_ENDPOINTS on
 * purpose: the page-open post is exempt but its refetches still count.
 */
export const QUIET_REFETCH_MUTATIONS: ReadonlySet<string> = new Set(['createTransactionQuiet'])

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
/** Held only while a quiet mutation settles or a `runQuietSync` callback runs; never across an await. */
let quietSync = 0
/**
 * Ids of the query requests that started while `quietSync > 0`; they stay out of the busy
 * level until they settle or `releaseQuiet` clears them.
 */
let quietQueryIds: ReadonlySet<string> = new Set()
/** Recomputes the busy level now; set when the middleware is installed. */
let recompute: (() => void) | null = null
const RECOMPUTE = 'busy/recompute'

// ─── Quiet requests in flight ────────────────────────────────────────────────

const quietListeners = new Set<() => void>()
let quietWasPending = false

function setQuietQueryIds(ids: ReadonlySet<string>): void {
  quietQueryIds = ids
  const pending = ids.size > 0
  if (pending === quietWasPending) return
  quietWasPending = pending
  for (const fn of [...quietListeners]) {
    try {
      fn()
    } catch (error) {
      // A listener's failure must never break the dispatch that changed the set.
      globalThis.reportError?.(error)
    }
  }
}

/**
 * Whether any quiet query request is still in flight. A save started meanwhile would have its
 * invalidation and reload join those requests, whose responses predate it, so callers that
 * save wait until this is false.
 */
export function quietPending(): boolean {
  return quietQueryIds.size > 0
}

/** Calls `listener` synchronously whenever `quietPending()` changes; returns the unsubscribe. */
export function subscribeQuiet(listener: () => void): () => void {
  quietListeners.add(listener)
  return () => {
    quietListeners.delete(listener)
  }
}

/** `quietPending()` as React state. */
export function useQuietPending(): boolean {
  return useSyncExternalStore(subscribeQuiet, quietPending)
}

/**
 * Hands every quiet request still in flight back to the busy level, at once: the screen
 * loader then shows until they settle, so nothing can overlap them. For the caller that made
 * them quiet giving up its view of them (a dialog closing). Synchronous; nothing is held.
 */
export function releaseQuiet(): void {
  if (quietQueryIds.size === 0) return
  setQuietQueryIds(new Set())
  recompute?.()
}

// ─── Abandoned saves ─────────────────────────────────────────────────────────

/** Abandoned saves not yet released by their caller (their POST, then their own refresh). */
let abandonedHolds = 0
/** Mutation request ids of abandoned saves whose POST has not settled yet. */
let abandonedMutationIds: ReadonlySet<string> = new Set()
/** Held only while an abandoned save's POST settles; never across an await. */
let abandonedSync = 0
/**
 * Ids of the query requests an abandoned save's settle started (its tag invalidation's
 * refetches). Unlike `quietQueryIds`, `releaseQuiet` never clears them.
 */
let abandonedQueryIds: ReadonlySet<string> = new Set()

const abandonedListeners = new Set<() => void>()
let abandonedWasPending = false

function notifyAbandoned(): void {
  const pending = abandonedSavePending()
  if (pending === abandonedWasPending) return
  abandonedWasPending = pending
  for (const fn of [...abandonedListeners]) {
    try {
      fn()
    } catch (error) {
      // A listener's failure must never break the dispatch that changed the state.
      globalThis.reportError?.(error)
    }
  }
}

/** The request id of an abandoned save's settle (`fulfilled` or `rejected`), else null. */
function abandonedSettleId(action: RequestActionLike): string | null {
  const requestId = action.meta?.requestId
  if (requestId === undefined || !abandonedMutationIds.has(requestId)) return null
  for (const path of REDUCER_PATHS) {
    if (action.type === `${path}/executeMutation/fulfilled` || action.type === `${path}/executeMutation/rejected`) return requestId
  }
  return null
}

/**
 * Marks a save abandoned: its dialog closed while its POST (mutation request `requestId`) was in
 * flight. Until it settles, a save from a reopened dialog would race it, and that save's
 * invalidation and reload could join requests that capture only the abandoned one.
 *
 * It stays pending until the caller calls the returned release (once its POST has failed, or
 * once the refresh its success started has settled) and every refetch its settle's tag
 * invalidation started has settled. Survives the dialog closing and `releaseQuiet`.
 */
export function abandonSave(requestId: string): () => void {
  abandonedHolds++
  abandonedMutationIds = new Set([...abandonedMutationIds, requestId])
  notifyAbandoned()
  let released = false
  return () => {
    if (released) return
    released = true
    abandonedHolds--
    if (abandonedMutationIds.has(requestId)) {
      const next = new Set(abandonedMutationIds)
      next.delete(requestId)
      abandonedMutationIds = next
    }
    notifyAbandoned()
  }
}

/** Whether any abandoned save is still unsettled (see `abandonSave`). */
export function abandonedSavePending(): boolean {
  return abandonedHolds > 0 || abandonedQueryIds.size > 0
}

/** Calls `listener` synchronously whenever `abandonedSavePending()` changes; returns the unsubscribe. */
export function subscribeAbandonedSave(listener: () => void): () => void {
  abandonedListeners.add(listener)
  return () => {
    abandonedListeners.delete(listener)
  }
}

/** `abandonedSavePending()` as React state. */
export function useAbandonedSavePending(): boolean {
  return useSyncExternalStore(subscribeAbandonedSave, abandonedSavePending)
}

/**
 * Runs `fn` with query requests it starts marked quiet: they do not make the screen busy.
 * Contract: the flag is held only while `fn` runs synchronously. Anything `fn` starts after its
 * first `await` is not quiet. Lazy triggers dispatch `pending` synchronously, so the trigger
 * call itself is the window; wrap a trigger that runs after an `await` in its own call.
 */
export function runQuietSync<T>(fn: () => T): T {
  quietSync++
  try {
    return fn()
  } finally {
    quietSync--
  }
}

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
export const busyMiddleware: Middleware = (storeApi) => {
  // `busy/recompute` reaches no reducer; it only makes this middleware publish the level again.
  recompute = () => {
    storeApi.dispatch({ type: RECOMPUTE })
  }
  return (next) => (action) => {
    depth++
    // A quiet mutation's settle starts its invalidation refetches inside `next(action)`; their
    // `pending` actions are nested dispatches that see the flag and are recorded as quiet.
    const settlesQuiet = isAction(action) && isQuietSettle(action as RequestActionLike, REDUCER_PATHS, QUIET_REFETCH_MUTATIONS)
    if (settlesQuiet) quietSync++
    // Likewise an abandoned save's settle: its refetches are recorded as that save's.
    const abandonedId = isAction(action) ? abandonedSettleId(action as RequestActionLike) : null
    if (abandonedId !== null) abandonedSync++
    try {
      return next(action)
    } finally {
      if (settlesQuiet) quietSync--
      if (abandonedId !== null) {
        abandonedSync--
        const ids = new Set(abandonedMutationIds)
        ids.delete(abandonedId)
        abandonedMutationIds = ids
      }
      depth--
      if (isAction(action)) {
        mutationIds = applyRequestAction(mutationIds, action as RequestActionLike, REDUCER_PATHS, EXEMPT_ENDPOINTS)
        setQuietQueryIds(applyQuietQueryAction(quietQueryIds, action as RequestActionLike, REDUCER_PATHS, quietSync > 0))
        const abandonedIds = applyQuietQueryAction(abandonedQueryIds, action as RequestActionLike, REDUCER_PATHS, abandonedSync > 0)
        if (abandonedIds !== abandonedQueryIds) {
          abandonedQueryIds = abandonedIds
          notifyAbandoned()
        }
      }
      const saving = mutationIds.size > 0
      const state = storeApi.getState()
      const level: BusyLevel = {
        busy: saving || anyQueryPending(REDUCER_PATHS.map((path) => querySlice(state, path)), EXEMPT_ENDPOINTS, quietQueryIds),
        saving,
      }
      const gate = publishGate(published, level, depth)
      published = gate.state
      if (gate.publish) publish(level)
    }
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
