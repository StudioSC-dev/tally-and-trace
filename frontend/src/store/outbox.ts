// The save outbox (STU-605, PERF-10): a dialog's save is queued here and the dialog closes at
// once. The queue lives in the app's store, so it keeps going across in-app navigation; one
// request is in flight at a time, in the order the saves were made, and tags are invalidated
// once when the queue drains. The rules are pure (`@tally-trace/shared` saveOutbox); this file
// sends the requests.
import { createListenerMiddleware, createSlice, current } from '@reduxjs/toolkit'
import type { PayloadAction } from '@reduxjs/toolkit'
import {
  classifyOutboxError,
  discardEntry,
  drainOutbox,
  emptyOutbox,
  enqueueEntry,
  failEntry,
  forgetCompletion,
  hydrateOutbox,
  markSending,
  nextToSend,
  retryEntry,
  succeedEntry,
} from '@tally-trace/shared'
import type { NewOutboxEntry, OutboxEntry, OutboxError, OutboxState } from '@tally-trace/shared'
import { accountingApi } from './api'
import { apiErrorMessage } from '../utils/apiError'

/** A request to show a saved row (the success toast's View): the page that lists it scrolls to it. */
export interface OutboxHighlight {
  form: string
  id: number
  seq: number
}

export interface OutboxSliceState extends OutboxState {
  highlight: OutboxHighlight | null
  /** A failed entry whose form should reopen with its draft (the failure toast's Edit). */
  editRequest: string | null
}

const initialState: OutboxSliceState = { ...emptyOutbox, highlight: null, editRequest: null }

/** Runs a pure rule on a plain copy of the state (the rules build new objects, never drafts). */
function applyRule(draft: OutboxSliceState, rule: (state: OutboxState) => OutboxState): OutboxSliceState {
  const plain = current(draft)
  return { ...plain, ...rule(plain) }
}

const outboxSlice = createSlice({
  name: 'outbox',
  initialState,
  reducers: {
    enqueued(state, action: PayloadAction<NewOutboxEntry>) {
      return applyRule(state, (s) => enqueueEntry(s, action.payload))
    },
    sending(state, action: PayloadAction<string>) {
      return applyRule(state, (s) => markSending(s, action.payload))
    },
    succeeded(state, action: PayloadAction<{ clientId: string; serverId?: number }>) {
      return applyRule(state, (s) => succeedEntry(s, action.payload.clientId, action.payload.serverId))
    },
    failed(state, action: PayloadAction<{ clientId: string; error: OutboxError }>) {
      return applyRule(state, (s) => failEntry(s, action.payload.clientId, action.payload.error))
    },
    retried(state, action: PayloadAction<string>) {
      return applyRule(state, (s) => retryEntry(s, action.payload))
    },
    discarded(state, action: PayloadAction<string>) {
      const next = applyRule(state, (s) => discardEntry(s, action.payload))
      return next.editRequest === action.payload ? { ...next, editRequest: null } : next
    },
    drained(state) {
      return applyRule(state, (s) => drainOutbox(s)?.state ?? s)
    },
    completionForgotten(state, action: PayloadAction<string>) {
      return applyRule(state, (s) => forgetCompletion(s, action.payload))
    },
    hydrated(state, action: PayloadAction<OutboxEntry[]>) {
      return applyRule(state, (s) => hydrateOutbox(s, action.payload))
    },
    highlightRequested(state, action: PayloadAction<{ form: string; id: number }>) {
      state.highlight = { ...action.payload, seq: (state.highlight?.seq ?? 0) + 1 }
    },
    highlightHandled(state, action: PayloadAction<number>) {
      if (state.highlight?.seq === action.payload) state.highlight = null
    },
    editRequested(state, action: PayloadAction<string>) {
      state.editRequest = action.payload
    },
    editHandled(state, action: PayloadAction<string>) {
      // The draft is in the form again: the failed entry is replaced by whatever it saves next.
      state.entries = state.entries.filter((e) => e.clientId !== action.payload)
      if (state.editRequest === action.payload) state.editRequest = null
    },
    /** Sign-out: nothing of one user's queue stays in memory for the next. */
    reset() {
      return initialState
    },
  },
})

export const outboxActions = outboxSlice.actions
export const outboxReducer = outboxSlice.reducer

/** The server row a save's response names: a transaction, or `{ transaction }` for a repeating create. */
export function serverIdOf(data: unknown): number | undefined {
  if (typeof data !== 'object' || data === null) return undefined
  const record = data as { id?: unknown; transaction?: { id?: unknown } | null }
  if (typeof record.id === 'number') return record.id
  if (typeof record.transaction?.id === 'number') return record.transaction.id
  return undefined
}

/** A new client id and idempotency key (a UUID, as the API requires). */
export function newOutboxId(): string {
  return crypto.randomUUID()
}

interface OutboxRoot {
  outbox: OutboxSliceState
}

export const outboxListener = createListenerMiddleware()

// The runner: whenever an entry can go out (nothing in flight, one pending), it is sent.
outboxListener.startListening({
  predicate: (_action, current) => nextToSend((current as OutboxRoot).outbox) !== null,
  effect: async (_action, api) => {
    const entry = nextToSend((api.getState() as OutboxRoot).outbox)
    if (!entry) return
    api.dispatch(outboxActions.sending(entry.clientId))
    const request = api.dispatch(
      accountingApi.endpoints.outboxSend.initiate({
        ...entry.request,
        ...(entry.idempotencyKey ? { idempotencyKey: entry.idempotencyKey } : {}),
      }),
    )
    const result = await request
    // A sign-out meanwhile emptied the queue: the late answer belongs to no entry.
    const still = (api.getState() as OutboxRoot).outbox.entries.some((e) => e.clientId === entry.clientId)
    if (!still) return
    if ('error' in result && result.error !== undefined) {
      const status = (result.error as { status?: unknown }).status
      // A delete that is already gone (a retry after an unknown outcome) did what was asked.
      if (entry.request.method === 'DELETE' && status === 404) {
        api.dispatch(outboxActions.succeeded({ clientId: entry.clientId }))
        return
      }
      api.dispatch(
        outboxActions.failed({ clientId: entry.clientId, error: classifyOutboxError(result.error, apiErrorMessage(result.error)) }),
      )
      return
    }
    const serverId = serverIdOf('data' in result ? result.data : undefined)
    api.dispatch(outboxActions.succeeded({ clientId: entry.clientId, ...(serverId !== undefined ? { serverId } : {}) }))
  },
})

// The drain: once nothing is pending or in flight, the collected tags are invalidated once.
outboxListener.startListening({
  predicate: (_action, current) => drainOutbox((current as OutboxRoot).outbox) !== null,
  effect: (_action, api) => {
    const drained = drainOutbox((api.getState() as OutboxRoot).outbox)
    if (!drained) return
    api.dispatch(outboxActions.drained())
    const tags = drained.tags as Parameters<typeof accountingApi.util.invalidateTags>[0]
    if (tags.length > 0) api.dispatch(accountingApi.util.invalidateTags(tags))
  },
})
