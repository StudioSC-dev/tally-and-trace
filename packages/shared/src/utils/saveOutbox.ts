/**
 * The save outbox (STU-605, PERF-10): saves leave their dialog at once and are sent in the
 * background, one at a time, in the order they were made.
 *
 * Pure state transitions over plain, JSON-safe data: no React, no Redux, no fetch. The web
 * app's slice (`frontend/src/store/outbox.ts`) wraps these, sends the requests, and mirrors
 * the unsettled entries to localStorage through `persistOutbox` / `restoreOutbox`.
 *
 * Rules:
 * - One FIFO queue; at most one entry is `sending`. `nextToSend` is the oldest `pending`
 *   entry, and only when nothing is in flight, so saves reach the server in creation order.
 * - A failed entry leaves the line (later saves go on); Retry puts it back at the tail with
 *   the same idempotency key, so an unknown outcome is never sent twice as two rows.
 * - A success removes the entry and records a completion. Its tags are collected and handed
 *   out once, when the queue drains (`drain`), not after every save.
 * - A retried DELETE that answers 404 already happened: the caller reports it as a success.
 */

export type OutboxKind = 'create' | 'update' | 'delete' | 'repeat' | 'due-action'
export type OutboxStatus = 'pending' | 'sending' | 'failed'
export type OutboxMethod = 'POST' | 'PUT' | 'DELETE'

/** What is sent. `url` is relative to the API root (`transactions/`, `budget-entries/7/materialize`). */
export interface OutboxRequest {
  method: OutboxMethod
  url: string
  body?: unknown
}

/** Why an entry failed. `raw` is the RTK error (`{ status, data }`) for the form to read again. */
export interface OutboxError {
  message: string
  /** Retry is offered: a network drop, a timeout or a server error (the save may not have happened). */
  retryable: boolean
  /** The outcome is unknown: restored after a reload while it was unsent or in flight. */
  notConfirmed?: boolean
  raw?: unknown
}

/** A display-only row for the list while an entry is unsettled: it feeds no total. */
export interface OutboxDisplay {
  /** YYYY-MM-DD, the row's place in a date-ordered list. */
  date: string
  description: string
  /** Already formatted, e.g. "₱1,234.00". */
  amount: string
  account: string
  transactionType?: 'debit' | 'credit' | 'transfer'
}

export interface OutboxEntry {
  clientId: string
  kind: OutboxKind
  /** The server row an update, delete or due action is about. */
  targetId?: number
  /** Which form reopens the draft on Edit, e.g. `transaction`. */
  form: string
  /** The form's state as the user left it, for Edit (JSON-safe). */
  draft: unknown
  /** Pending toast text: "Saving ₱1,234.00 to BPI Card…". */
  label: string
  /** Named in a failure: "Couldn't save '<description>': <reason>". */
  description: string
  request: OutboxRequest
  /** Sent as `Idempotency-Key` on creates; the same on every retry. */
  idempotencyKey?: string
  /** RTK tags to invalidate once the queue drains. */
  tags: string[]
  status: OutboxStatus
  error?: OutboxError
  display?: OutboxDisplay
  /** Whether a success toast offers View and Undo. */
  viewable?: boolean
  undoable?: boolean
}

/** A settled success, kept for its toast and until the list it belongs to has refetched. */
export interface OutboxCompletion {
  clientId: string
  kind: OutboxKind
  form: string
  description: string
  /** The server row the save created or changed, when the response names one. */
  serverId?: number
  targetId?: number
  viewable?: boolean
  undoable?: boolean
  display?: OutboxDisplay
  /** The drain this success was handed out in; 0 until the queue drains. */
  drainSeq: number
}

export interface OutboxState {
  entries: OutboxEntry[]
  completions: OutboxCompletion[]
  /** Tags collected from successes since the last drain. */
  drainTags: string[]
  /** Advances on every drain; a list that has refetched after drain N shows no marker from it. */
  drainSeq: number
}

export const emptyOutbox: OutboxState = { entries: [], completions: [], drainTags: [], drainSeq: 0 }

/** Completions kept at most (oldest dropped). */
export const MAX_COMPLETIONS = 50

export type NewOutboxEntry = Omit<OutboxEntry, 'status' | 'error'>

/** Appends a save at the tail of the queue. A clientId already queued is ignored. */
export function enqueueEntry(state: OutboxState, entry: NewOutboxEntry): OutboxState {
  if (state.entries.some((e) => e.clientId === entry.clientId)) return state
  return { ...state, entries: [...state.entries, { ...entry, status: 'pending' }] }
}

/** The entry to send now: the oldest pending one, only when none is in flight. */
export function nextToSend(state: OutboxState): OutboxEntry | null {
  if (state.entries.some((e) => e.status === 'sending')) return null
  return state.entries.find((e) => e.status === 'pending') ?? null
}

function patch(state: OutboxState, clientId: string, change: (e: OutboxEntry) => OutboxEntry): OutboxState {
  let changed = false
  const entries = state.entries.map((e) => {
    if (e.clientId !== clientId) return e
    changed = true
    return change(e)
  })
  return changed ? { ...state, entries } : state
}

/** The entry's request is going out. */
export function markSending(state: OutboxState, clientId: string): OutboxState {
  return patch(state, clientId, (e) => (e.status === 'pending' ? { ...e, status: 'sending' } : e))
}

/** The entry succeeded: it leaves the queue, its tags wait for the drain, and a completion is kept. */
export function succeedEntry(state: OutboxState, clientId: string, serverId?: number): OutboxState {
  const entry = state.entries.find((e) => e.clientId === clientId)
  if (!entry) return state
  const completion: OutboxCompletion = {
    clientId,
    kind: entry.kind,
    form: entry.form,
    description: entry.description,
    drainSeq: 0,
    ...(serverId !== undefined ? { serverId } : {}),
    ...(entry.targetId !== undefined ? { targetId: entry.targetId } : {}),
    ...(entry.viewable ? { viewable: true } : {}),
    ...(entry.undoable ? { undoable: true } : {}),
    ...(entry.display ? { display: entry.display } : {}),
  }
  const tags = [...state.drainTags]
  for (const tag of entry.tags) if (!tags.includes(tag)) tags.push(tag)
  const completions = [...state.completions, completion]
  return {
    ...state,
    entries: state.entries.filter((e) => e.clientId !== clientId),
    completions: completions.slice(Math.max(0, completions.length - MAX_COMPLETIONS)),
    drainTags: tags,
  }
}

/** The entry failed: it stays, out of the line, until Retry or Discard. */
export function failEntry(state: OutboxState, clientId: string, error: OutboxError): OutboxState {
  return patch(state, clientId, (e) => ({ ...e, status: 'failed', error }))
}

/** Retry: the failed entry goes back to the tail of the line, with its idempotency key. */
export function retryEntry(state: OutboxState, clientId: string): OutboxState {
  const entry = state.entries.find((e) => e.clientId === clientId)
  if (!entry || entry.status !== 'failed') return state
  const rest = state.entries.filter((e) => e.clientId !== clientId)
  const retried: OutboxEntry = { ...entry, status: 'pending' }
  delete retried.error
  return { ...state, entries: [...rest, retried] }
}

/** Discard: a failed entry is dropped without sending. A pending or sending one cannot be. */
export function discardEntry(state: OutboxState, clientId: string): OutboxState {
  const entry = state.entries.find((e) => e.clientId === clientId)
  if (!entry || entry.status !== 'failed') return state
  return { ...state, entries: state.entries.filter((e) => e.clientId !== clientId) }
}

/** Drops a completion (its toast went away and no list needs its marker). */
export function forgetCompletion(state: OutboxState, clientId: string): OutboxState {
  if (!state.completions.some((c) => c.clientId === clientId)) return state
  return { ...state, completions: state.completions.filter((c) => c.clientId !== clientId) }
}

/** Nothing pending or in flight (failed entries wait for the user and do not hold a drain). */
export function isDrained(state: OutboxState): boolean {
  return !state.entries.some((e) => e.status === 'pending' || e.status === 'sending')
}

/**
 * When the queue has drained and some success is waiting, hands out the collected tags once
 * and stamps those completions with the new drain number. Otherwise returns null.
 */
export function drainOutbox(state: OutboxState): { state: OutboxState; tags: string[] } | null {
  if (!isDrained(state)) return null
  const waiting = state.completions.some((c) => c.drainSeq === 0)
  if (!waiting && state.drainTags.length === 0) return null
  const drainSeq = state.drainSeq + 1
  return {
    tags: state.drainTags,
    state: {
      ...state,
      drainTags: [],
      drainSeq,
      completions: state.completions.map((c) => (c.drainSeq === 0 ? { ...c, drainSeq } : c)),
    },
  }
}

/** Whether a page-level list still needs a completion's marker: it has not refetched since its drain. */
export function completionShown(completion: OutboxCompletion, listDrainSeq: number): boolean {
  return completion.drainSeq === 0 || completion.drainSeq > listDrainSeq
}

/**
 * The kind of save pending on each server row: an update or delete in the queue (pending,
 * sending or failed) makes its row read-only until it settles.
 */
export function pendingTargets(state: OutboxState, form: string): Map<number, OutboxKind> {
  const targets = new Map<number, OutboxKind>()
  for (const e of state.entries) {
    if (e.form === form && e.targetId !== undefined && e.status !== 'failed') targets.set(e.targetId, e.kind)
  }
  return targets
}

/** Number of saves not yet settled (pending or in flight): what `beforeunload` warns about. */
export function unsettledCount(state: OutboxState): number {
  return state.entries.filter((e) => e.status !== 'failed').length
}

// ─── Errors ─────────────────────────────────────────────────────────────────

/**
 * Reads an RTK Query error into an outbox error. A network drop, timeout, 408, 429 or 5xx is
 * retryable (the request may or may not have landed; the key makes a resend safe). Any other
 * status is the server refusing the save as sent: no Retry, the user edits it instead.
 */
export function classifyOutboxError(raw: unknown, reason: string): OutboxError {
  const status = (raw as { status?: unknown } | undefined)?.status
  if (typeof status === 'number') {
    const retryable = status >= 500 || status === 408 || status === 429
    return { message: reason || (retryable ? 'The server had a problem.' : 'The server refused it.'), retryable, raw }
  }
  if (status === 'TIMEOUT_ERROR') return { message: 'It took too long to answer.', retryable: true, raw }
  return { message: reason || 'No connection to the server.', retryable: true, raw }
}

// ─── Persistence ────────────────────────────────────────────────────────────

const STORAGE_VERSION = 1

/** The localStorage key for a user's unsettled saves. Never shared between users. */
export function outboxStorageKey(userId: number | string): string {
  return `tt.outbox.v${STORAGE_VERSION}.${userId}`
}

/** What is mirrored: every unsettled entry (pending, sending or failed), as JSON. */
export function persistOutbox(state: OutboxState): string {
  return JSON.stringify({ v: STORAGE_VERSION, entries: state.entries })
}

export const NOT_CONFIRMED = 'Not confirmed — Retry or Discard'

function isEntry(value: unknown): value is OutboxEntry {
  if (typeof value !== 'object' || value === null) return false
  const e = value as Record<string, unknown>
  const request = e.request as Record<string, unknown> | undefined
  return (
    typeof e.clientId === 'string' &&
    typeof e.kind === 'string' &&
    typeof e.form === 'string' &&
    typeof e.label === 'string' &&
    typeof e.description === 'string' &&
    Array.isArray(e.tags) &&
    typeof request === 'object' &&
    request !== null &&
    typeof request.url === 'string' &&
    (request.method === 'POST' || request.method === 'PUT' || request.method === 'DELETE')
  )
}

/**
 * Reads a mirrored queue back after a reload. Nothing is resent on its own: an entry that was
 * pending or in flight comes back failed and "not confirmed" (Retry is safe: same key), and a
 * failed one keeps its error. Anything unreadable gives an empty queue.
 */
export function restoreOutbox(json: string | null): OutboxEntry[] {
  if (!json) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch {
    return []
  }
  const record = parsed as { v?: unknown; entries?: unknown } | null
  if (!record || record.v !== STORAGE_VERSION || !Array.isArray(record.entries)) return []
  return record.entries.filter(isEntry).map((e) =>
    e.status === 'failed' && e.error
      ? e
      : { ...e, status: 'failed' as const, error: { message: NOT_CONFIRMED, retryable: true, notConfirmed: true } },
  )
}

/** Puts restored entries in front of anything queued since (they were made first). */
export function hydrateOutbox(state: OutboxState, restored: OutboxEntry[]): OutboxState {
  const known = new Set(state.entries.map((e) => e.clientId))
  const fresh = restored.filter((e) => !known.has(e.clientId))
  if (fresh.length === 0) return state
  return { ...state, entries: [...fresh, ...state.entries] }
}
