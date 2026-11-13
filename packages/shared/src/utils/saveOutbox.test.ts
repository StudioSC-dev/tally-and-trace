import { describe, it, expect } from 'vitest'
import {
  NOT_CONFIRMED,
  SUPERSEDED,
  classifyOutboxError,
  completionShown,
  discardEntry,
  drainOutbox,
  emptyOutbox,
  enqueueEntry,
  failEntry,
  hydrateOutbox,
  isDrained,
  markSending,
  nextToSend,
  outboxStorageKey,
  pendingTargets,
  persistOutbox,
  restoreOutbox,
  retryEntry,
  succeedEntry,
  unsettledCount,
} from './saveOutbox'
import type { NewOutboxEntry, OutboxState } from './saveOutbox'

const entry = (clientId: string, over: Partial<NewOutboxEntry> = {}): NewOutboxEntry => ({
  clientId,
  kind: 'create',
  form: 'transaction',
  draft: { description: clientId },
  label: `Saving ${clientId}…`,
  description: clientId,
  request: { method: 'POST', url: 'transactions/', body: { description: clientId } },
  idempotencyKey: `key-${clientId}`,
  tags: ['Transaction', 'Account'],
  ...over,
})

const queue = (...ids: string[]): OutboxState => ids.reduce((s, id) => enqueueEntry(s, entry(id)), emptyOutbox)

/** Sends every entry in turn the way the runner does, recording the order. */
function runAll(state: OutboxState): { state: OutboxState; sent: string[] } {
  const sent: string[] = []
  let s = state
  for (let next = nextToSend(s); next; next = nextToSend(s)) {
    s = markSending(s, next.clientId)
    expect(nextToSend(s)).toBeNull()
    sent.push(next.clientId)
    s = succeedEntry(s, next.clientId, sent.length)
  }
  return { state: s, sent }
}

describe('ordering', () => {
  it('sends in creation order, one at a time', () => {
    const { sent, state } = runAll(queue('a', 'b', 'c'))
    expect(sent).toEqual(['a', 'b', 'c'])
    expect(state.entries).toEqual([])
  })

  it('holds the next entry while one is in flight', () => {
    let s = queue('a', 'b')
    s = markSending(s, 'a')
    expect(nextToSend(s)).toBeNull()
    s = succeedEntry(s, 'a', 1)
    expect(nextToSend(s)?.clientId).toBe('b')
  })

  it('ignores a clientId already queued (no double submit)', () => {
    const s = enqueueEntry(queue('a'), entry('a'))
    expect(s.entries).toHaveLength(1)
  })

  it('lets later saves go on past a failed one', () => {
    let s = queue('a', 'b')
    s = markSending(s, 'a')
    s = failEntry(s, 'a', { message: 'no', retryable: false })
    expect(nextToSend(s)?.clientId).toBe('b')
  })
})

describe('drain', () => {
  it('hands out tags once, when the queue drains, not after every save', () => {
    let s = queue('a', 'b')
    s = markSending(s, 'a')
    s = succeedEntry(s, 'a', 1)
    expect(drainOutbox(s)).toBeNull()
    s = markSending(s, 'b')
    s = succeedEntry(s, 'b', 2)
    const drained = drainOutbox(s)
    expect(drained?.tags).toEqual(['Transaction', 'Account'])
    expect(drained?.state.drainSeq).toBe(1)
    expect(drained?.state.completions.map((c) => c.drainSeq)).toEqual([1, 1])
    expect(drainOutbox(drained!.state)).toBeNull()
  })

  it('is not held by a failed entry', () => {
    let s = queue('a', 'b')
    s = failEntry(markSending(s, 'a'), 'a', { message: 'x', retryable: true })
    s = succeedEntry(markSending(s, 'b'), 'b', 5)
    expect(isDrained(s)).toBe(true)
    expect(drainOutbox(s)?.tags).toEqual(['Transaction', 'Account'])
  })

  it('keeps a marker until the list has refetched after its drain', () => {
    let s = succeedEntry(markSending(queue('a'), 'a'), 'a', 9)
    const before = s.completions[0]!
    expect(completionShown(before, 0)).toBe(true)
    s = drainOutbox(s)!.state
    const after = s.completions[0]!
    expect(after.serverId).toBe(9)
    expect(completionShown(after, 0)).toBe(true)
    expect(completionShown(after, 1)).toBe(false)
  })
})

describe('failure and retry', () => {
  it('retry puts the entry at the tail with the same idempotency key', () => {
    let s = queue('a', 'b')
    s = failEntry(markSending(s, 'a'), 'a', { message: 'offline', retryable: true })
    s = retryEntry(s, 'a')
    expect(s.entries.map((e) => [e.clientId, e.status])).toEqual([['b', 'pending'], ['a', 'pending']])
    expect(s.entries[1]!.idempotencyKey).toBe('key-a')
    expect(s.entries[1]!.error).toBeUndefined()
  })

  it('only a failed entry can be retried or discarded', () => {
    const s = markSending(queue('a'), 'a')
    expect(retryEntry(s, 'a')).toBe(s)
    expect(discardEntry(s, 'a')).toBe(s)
    const failed = failEntry(s, 'a', { message: 'x', retryable: false })
    expect(discardEntry(failed, 'a').entries).toEqual([])
  })

  it('classifies network, timeout and 5xx as retryable, a refusal as not', () => {
    expect(classifyOutboxError({ status: 'FETCH_ERROR', error: 'TypeError' }, '').retryable).toBe(true)
    expect(classifyOutboxError({ status: 'TIMEOUT_ERROR' }, '').retryable).toBe(true)
    expect(classifyOutboxError({ status: 503, data: {} }, '').retryable).toBe(true)
    expect(classifyOutboxError({ status: 429, data: {} }, '').retryable).toBe(true)
    const refused = classifyOutboxError({ status: 422, data: { detail: 'Bad' } }, 'Bad')
    expect(refused).toMatchObject({ retryable: false, message: 'Bad' })
    expect(classifyOutboxError({ status: 400, data: {} }, '').retryable).toBe(false)
  })

  it('marks rows with a pending update or delete read-only, not failed ones', () => {
    let s = enqueueEntry(emptyOutbox, entry('u', { kind: 'update', targetId: 7 }))
    s = enqueueEntry(s, entry('d', { kind: 'delete', targetId: 8 }))
    s = enqueueEntry(s, entry('x', { kind: 'update', targetId: 9 }))
    s = failEntry(s, 'x', { message: 'no', retryable: false })
    expect([...pendingTargets(s, 'transaction')]).toEqual([[7, 'update'], [8, 'delete']])
    expect(pendingTargets(s, 'other').size).toBe(0)
    expect(unsettledCount(s)).toBe(2)
  })
})

describe('same-row rewrites', () => {
  const update = (id: string, value: string) =>
    entry(id, { kind: 'update', targetId: 7, request: { method: 'PUT', url: 'transactions/7', body: { description: value } } })
  const refused = { message: 'Amount too big', retryable: false, raw: { status: 422 } }
  const dropped = { message: 'No connection to the server.', retryable: true }

  it('a newer edit of the same row supersedes an older failed one: no Retry, its draft kept for Edit', () => {
    let s = enqueueEntry(emptyOutbox, update('old', 'first'))
    s = failEntry(markSending(s, 'old'), 'old', dropped)
    s = enqueueEntry(s, update('new', 'second'))
    const old = s.entries.find((e) => e.clientId === 'old')!
    expect(old).toMatchObject({ status: 'failed', error: { message: SUPERSEDED, retryable: false, superseded: true } })
    expect(old.draft).toEqual({ description: 'old' })
    // Retry is refused, so the older values can never land after the newer ones.
    expect(retryEntry(s, 'old')).toBe(s)
    const { sent } = runAll(s)
    expect(sent).toEqual(['new'])
  })

  it('an older edit that fails while a newer one for the row waits is superseded at once', () => {
    let s = enqueueEntry(emptyOutbox, update('old', 'first'))
    s = enqueueEntry(s, update('new', 'second'))
    s = failEntry(markSending(s, 'old'), 'old', dropped)
    expect(s.entries.find((e) => e.clientId === 'old')).toMatchObject({ error: { superseded: true, retryable: false } })
    expect(retryEntry(s, 'old')).toBe(s)
  })

  it('a refusal is superseded the same way, and a delete or another row is left alone', () => {
    let s = enqueueEntry(emptyOutbox, update('old', 'first'))
    s = enqueueEntry(s, entry('del', { kind: 'delete', targetId: 9, draft: null, request: { method: 'DELETE', url: 'transactions/9' } }))
    s = failEntry(markSending(s, 'old'), 'old', refused)
    s = succeedEntry(markSending(s, 'del'), 'del')
    s = failEntry(s, 'old', refused)
    expect(s.entries.find((e) => e.clientId === 'old')!.error).toMatchObject({ message: 'Amount too big' })
    s = enqueueEntry(s, update('new', 'second'))
    expect(s.entries.find((e) => e.clientId === 'old')!.error).toMatchObject({ superseded: true, message: SUPERSEDED })
  })

  it('a failed delete stays retryable after a newer edit, and POST actions on the target never supersede', () => {
    let s = enqueueEntry(emptyOutbox, entry('del', { kind: 'delete', targetId: 7, draft: null, request: { method: 'DELETE', url: 'transactions/7' } }))
    s = failEntry(markSending(s, 'del'), 'del', dropped)
    s = enqueueEntry(s, update('new', 'second'))
    expect(s.entries.find((e) => e.clientId === 'del')!.error).toMatchObject({ retryable: true })
    // Two Mark paid on one entry are two records, not rewrites of one row.
    const markPaid = (id: string) =>
      entry(id, { kind: 'due-action', form: 'due-entry', targetId: 3, request: { method: 'POST', url: 'budget-entries/3/materialize' } })
    let d = enqueueEntry(emptyOutbox, markPaid('m1'))
    d = failEntry(markSending(d, 'm1'), 'm1', dropped)
    d = enqueueEntry(d, markPaid('m2'))
    expect(d.entries.find((e) => e.clientId === 'm1')!.error).toMatchObject({ retryable: true })
  })

  it('a superseded entry survives a reload as superseded', () => {
    let s = enqueueEntry(emptyOutbox, update('old', 'first'))
    s = failEntry(markSending(s, 'old'), 'old', dropped)
    s = enqueueEntry(s, update('new', 'second'))
    const restored = restoreOutbox(persistOutbox(s))
    expect(restored.find((e) => e.clientId === 'old')).toMatchObject({ error: { superseded: true, retryable: false } })
  })
})

describe('persistence', () => {
  it('round-trips: unsent and in-flight entries come back not confirmed, failures keep their error', () => {
    let s = queue('a', 'b', 'c')
    s = markSending(s, 'a')
    s = failEntry(s, 'c', { message: 'Amount too big', retryable: false, raw: { status: 422 } })
    const restored = restoreOutbox(persistOutbox(s))
    expect(restored.map((e) => e.clientId)).toEqual(['a', 'b', 'c'])
    expect(restored[0]).toMatchObject({ status: 'failed', error: { message: NOT_CONFIRMED, retryable: true, notConfirmed: true } })
    expect(restored[1]).toMatchObject({ status: 'failed', error: { notConfirmed: true } })
    expect(restored[2]).toMatchObject({ status: 'failed', error: { message: 'Amount too big', retryable: false } })
    expect(restored[0]!.idempotencyKey).toBe('key-a')
    expect(restored[0]!.draft).toEqual({ description: 'a' })
  })

  it('a failure with an unknown outcome comes back not confirmed', () => {
    const s = failEntry(markSending(queue('a'), 'a'), 'a', { message: 'No connection to the server.', retryable: true })
    const [restored] = restoreOutbox(persistOutbox(s))
    expect(restored).toMatchObject({ status: 'failed', error: { message: NOT_CONFIRMED, retryable: true, notConfirmed: true } })
  })

  it('a restored entry retried is sent once with its key', () => {
    const restored = restoreOutbox(persistOutbox(markSending(queue('a'), 'a')))
    let s = hydrateOutbox(emptyOutbox, restored)
    expect(nextToSend(s)).toBeNull()
    s = retryEntry(s, 'a')
    expect(nextToSend(s)).toMatchObject({ clientId: 'a', idempotencyKey: 'key-a' })
  })

  it('hydrates in front of saves made since, without duplicates', () => {
    const restored = restoreOutbox(persistOutbox(queue('old')))
    let s = queue('new')
    s = hydrateOutbox(s, restored)
    s = hydrateOutbox(s, restored)
    expect(s.entries.map((e) => e.clientId)).toEqual(['old', 'new'])
  })

  it('reads nothing from garbage, another version or malformed entries', () => {
    expect(restoreOutbox(null)).toEqual([])
    expect(restoreOutbox('{')).toEqual([])
    expect(restoreOutbox(JSON.stringify({ v: 99, entries: [] }))).toEqual([])
    expect(restoreOutbox(JSON.stringify({ v: 1, entries: [{ clientId: 'x' }, 5, null] }))).toEqual([])
  })

  it('keys storage by user', () => {
    expect(outboxStorageKey(1)).not.toBe(outboxStorageKey(2))
  })
})
