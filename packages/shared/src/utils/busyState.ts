/**
 * Pure rules for the screen loader: which requests count as busy, how in-flight
 * mutations are tracked, when a level is published, and when the overlay shows,
 * holds and hides. No React, no RTK import, no timers: the caller passes `now`.
 */

// ─── Which requests count ────────────────────────────────────────────────────

/** The part of an RTK query cache entry the rule reads. */
export interface QueryEntryLike {
  status: string
  endpointName?: string
}

/** One API's `queries` state: cache key to entry (entries can be `undefined`). */
export type QuerySliceLike = Readonly<Record<string, QueryEntryLike | undefined>>

/**
 * True when any query entry is `pending` and its endpoint is not exempt.
 * Read as a level from state, so joined requests, StrictMode, `resetApiState` and
 * cache removal can never leave it stale.
 */
export function anyQueryPending(
  slices: ReadonlyArray<QuerySliceLike | undefined>,
  exempt: ReadonlySet<string>,
): boolean {
  for (const slice of slices) {
    if (!slice) continue
    for (const key of Object.keys(slice)) {
      const entry = slice[key]
      if (!entry || entry.status !== 'pending') continue
      if (entry.endpointName !== undefined && exempt.has(entry.endpointName)) continue
      return true
    }
  }
  return false
}

/** The part of a dispatched action the mutation tracker reads. */
export interface RequestActionLike {
  type: string
  meta?: {
    requestId?: string
    arg?: { endpointName?: string }
  }
}

/**
 * The set of in-flight, non-exempt mutations after `action`, as `reducerPath:requestId`
 * keys. Mutations are counted from their actions because `useMutation` resets its
 * substate on unmount.
 *
 * - `<path>/executeMutation/pending` adds the id (unless the endpoint is exempt).
 * - `fulfilled` or `rejected` (an abort is `rejected`) deletes it; an unknown id is a no-op.
 * - `<path>/resetApiState` deletes only that API's ids.
 * - Query actions and every other action leave the set alone.
 *
 * Returns `ids` itself when nothing changed, otherwise a new set.
 */
export function applyRequestAction(
  ids: ReadonlySet<string>,
  action: RequestActionLike,
  reducerPaths: readonly string[],
  exempt: ReadonlySet<string>,
): ReadonlySet<string> {
  for (const path of reducerPaths) {
    const prefix = `${path}/`
    if (!action.type.startsWith(prefix)) continue
    const rest = action.type.slice(prefix.length)

    if (rest === 'resetApiState') {
      const owned = `${path}:`
      const kept = [...ids].filter((id) => !id.startsWith(owned))
      return kept.length === ids.size ? ids : new Set(kept)
    }

    const match = /^executeMutation\/(pending|fulfilled|rejected)$/.exec(rest)
    if (!match) return ids
    const requestId = action.meta?.requestId
    if (requestId === undefined) return ids
    const id = `${path}:${requestId}`

    if (match[1] === 'pending') {
      const endpoint = action.meta?.arg?.endpointName
      if (endpoint !== undefined && exempt.has(endpoint)) return ids
      if (ids.has(id)) return ids
      return new Set([...ids, id])
    }
    if (!ids.has(id)) return ids
    const next = new Set(ids)
    next.delete(id)
    return next
  }
  return ids
}

// ─── Publishing the level ────────────────────────────────────────────────────

/** What the overlay is told: any request in flight, and whether one of them is a save. */
export interface BusyLevel {
  busy: boolean
  saving: boolean
}

export const idleLevel: BusyLevel = { busy: false, saving: false }

/**
 * Decides whether a freshly computed level is published.
 *
 * `depth` is how many dispatches are currently inside the middleware. A `true` level,
 * or a change of `saving` while busy, is published at once. A `false` level is
 * published only at depth 0, so a nested dispatch can never publish `busy: false` in
 * the middle of an outer settle. An unchanged level publishes nothing.
 *
 * Returns the state to keep (what was last published) and whether to publish `level`.
 */
export function publishGate(
  state: BusyLevel,
  level: BusyLevel,
  depth: number,
): { state: BusyLevel; publish: boolean } {
  if (!level.busy && depth > 0) return { state, publish: false }
  if (level.busy === state.busy && level.saving === state.saving) return { state, publish: false }
  return { state: level, publish: true }
}

// ─── Overlay timing ──────────────────────────────────────────────────────────

/** R1: the grey-out appears after about this long busy. */
export const SHOW_DELAY_MS = 300
/** Once grey, it stays at least this long. */
export const MIN_VISIBLE_MS = 300
/** The level must stay clear this long (and for two animation frames) before input returns. */
export const END_GRACE_MS = 50
/** QR5-1: after this long blocked, the card offers Reload page. */
export const STUCK_MS = 20_000
/** Animation frames the level must stay clear for. */
export const CLEAR_FRAMES = 2

export type OverlayPhase = 'hidden' | 'shield' | 'visible'

export interface OverlayTiming {
  busySince: number | null
  clearSince: number | null
  clearFrames: number
  shownAt: number | null
}

export const initialOverlayTiming: OverlayTiming = {
  busySince: null,
  clearSince: null,
  clearFrames: 0,
  shownAt: null,
}

export interface OverlayStep {
  timing: OverlayTiming
  phase: OverlayPhase
  stuck: boolean
  /** The next time boundary the caller should wake at, or null. */
  wakeAt: number | null
}

/**
 * One step of the overlay's state machine. Input is blocked whenever the phase is not
 * `hidden`, in `shield` and in `visible`.
 *
 * - Busy: `busySince` is kept across a brief clear (one episode). The phase is `shield`
 *   until `busySince + SHOW_DELAY_MS`, then `visible`.
 * - Clear: the phase holds until the level has stayed clear for `END_GRACE_MS` and
 *   `CLEAR_FRAMES` frames (`frameTick` marks a frame) and, if shown, until
 *   `MIN_VISIBLE_MS` after it showed. Then it is `hidden` and the timing resets.
 */
export function overlayStep(
  t: OverlayTiming,
  busy: boolean,
  now: number,
  frameTick = false,
): OverlayStep {
  if (busy) {
    const busySince = t.busySince ?? now
    const visible = now >= busySince + SHOW_DELAY_MS
    const shownAt = visible ? (t.shownAt ?? now) : t.shownAt
    const stuck = now - busySince >= STUCK_MS
    let wakeAt: number | null = null
    if (!visible) wakeAt = busySince + SHOW_DELAY_MS
    else if (!stuck) wakeAt = busySince + STUCK_MS
    return {
      timing: { busySince, clearSince: null, clearFrames: 0, shownAt },
      phase: visible ? 'visible' : 'shield',
      stuck,
      wakeAt,
    }
  }

  if (t.busySince === null) {
    return { timing: initialOverlayTiming, phase: 'hidden', stuck: false, wakeAt: null }
  }

  const clearSince = t.clearSince ?? now
  const clearFrames = t.clearFrames + (frameTick ? 1 : 0)
  const timeDone = Math.max(
    clearSince + END_GRACE_MS,
    t.shownAt === null ? 0 : t.shownAt + MIN_VISIBLE_MS,
  )
  if (now >= timeDone && clearFrames >= CLEAR_FRAMES) {
    return { timing: initialOverlayTiming, phase: 'hidden', stuck: false, wakeAt: null }
  }
  return {
    timing: { busySince: t.busySince, clearSince, clearFrames, shownAt: t.shownAt },
    phase: t.shownAt === null ? 'shield' : 'visible',
    stuck: now - t.busySince >= STUCK_MS,
    wakeAt: timeDone > now ? timeDone : null,
  }
}
