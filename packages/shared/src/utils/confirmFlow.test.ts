import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { CONFIRM_DEFAULT_ERROR, createConfirmFlow, type ConfirmRequest, type ConfirmView } from './confirmFlow'

const describe500 = (error: unknown): string =>
  typeof error === 'object' && error !== null && 'detail' in error && typeof error.detail === 'string' ? error.detail : ''

const base: ConfirmRequest = { title: 'Delete category?', message: 'Delete category "Food"?', confirmLabel: 'Delete category' }

/** A promise whose settling the test controls. */
function controlled() {
  let resolve!: (value: unknown) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<unknown>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

/** Lets every queued promise callback run. */
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

/** Records what a promise settled to, or 'pending'. */
function track(promise: Promise<boolean>) {
  const state: { value: boolean | 'pending'; settles: number } = { value: 'pending', settles: 0 }
  promise.then((value) => {
    state.value = value
    state.settles++
  })
  return state
}

function recorder(flow: ReturnType<typeof createConfirmFlow>) {
  const seen: ConfirmView[] = []
  const stop = flow.subscribe((view) => seen.push(view))
  return { seen, stop }
}

const summary = (view: ConfirmView) => (view.open ? (view.pending ? 'pending' : view.error ? `error:${view.error}` : 'open') : 'closed')

describe('createConfirmFlow without an action', () => {
  it('resolves true on accept and closes', async () => {
    const flow = createConfirmFlow(describe500)
    const result = track(flow.request(base))
    expect(flow.get()).toEqual({ open: true, request: base, pending: false, error: null })
    flow.accept()
    await flush()
    expect(result.value).toBe(true)
    expect(flow.get()).toEqual({ open: false })
  })

  it('resolves false on dismiss and closes', async () => {
    const flow = createConfirmFlow(describe500)
    const result = track(flow.request(base))
    flow.dismiss()
    await flush()
    expect(result.value).toBe(false)
    expect(flow.get().open).toBe(false)
  })

  it('resolves a second request false at once and leaves the first open', async () => {
    const flow = createConfirmFlow(describe500)
    const first = track(flow.request(base))
    const second = track(flow.request({ ...base, title: 'Other' }))
    await flush()
    expect(second.value).toBe(false)
    expect(first.value).toBe('pending')
    const view = flow.get()
    expect(view.open && view.request.title).toBe(base.title)
    flow.accept()
    await flush()
    expect(first.value).toBe(true)
  })

  it('ignores accept and dismiss with nothing open', async () => {
    const flow = createConfirmFlow(describe500)
    const { seen } = recorder(flow)
    flow.accept()
    flow.dismiss()
    await flush()
    expect(seen).toEqual([])
  })
})

describe('createConfirmFlow with an action', () => {
  it('closes and resolves true when the action succeeds', async () => {
    const flow = createConfirmFlow(describe500)
    const run = controlled()
    let calls = 0
    const result = track(flow.request({ ...base, action: () => { calls++; return run.promise } }))
    flow.accept()
    expect(calls).toBe(1)
    expect(summary(flow.get())).toBe('pending')
    run.resolve(undefined)
    await flush()
    expect(result.value).toBe(true)
    expect(flow.get().open).toBe(false)
  })

  it('stays open with the described message when the action throws', async () => {
    const flow = createConfirmFlow(describe500)
    const result = track(flow.request({ ...base, errorFallback: 'Could not delete.', action: () => Promise.reject({ detail: 'In use' }) }))
    flow.accept()
    await flush()
    expect(result.value).toBe('pending')
    expect(summary(flow.get())).toBe('error:In use')
  })

  it('falls back to errorFallback when the description is empty, then to the default', async () => {
    const flow = createConfirmFlow(describe500)
    const fallback = track(flow.request({ ...base, errorFallback: 'Could not delete.', action: () => Promise.reject(new Error('x')) }))
    flow.accept()
    await flush()
    expect(summary(flow.get())).toBe('error:Could not delete.')
    flow.dismiss()
    await flush()
    expect(fallback.value).toBe(false)

    track(flow.request({ ...base, action: () => Promise.reject(new Error('x')) }))
    flow.accept()
    await flush()
    expect(summary(flow.get())).toBe(`error:${CONFIRM_DEFAULT_ERROR}`)
  })

  it('treats a synchronous throw like a rejection', async () => {
    const flow = createConfirmFlow(describe500)
    track(flow.request({ ...base, action: () => { throw { detail: 'Sync' } } }))
    flow.accept()
    await flush()
    expect(summary(flow.get())).toBe('error:Sync')
  })

  it('retries on accept after a failure and resolves true on success', async () => {
    const flow = createConfirmFlow(describe500)
    let calls = 0
    const result = track(flow.request({
      ...base,
      action: () => (++calls === 1 ? Promise.reject({ detail: 'Busy' }) : Promise.resolve()),
    }))
    flow.accept()
    await flush()
    expect(summary(flow.get())).toBe('error:Busy')
    flow.accept()
    expect(summary(flow.get())).toBe('pending')
    await flush()
    expect(calls).toBe(2)
    expect(result.value).toBe(true)
    expect(flow.get().open).toBe(false)
  })

  it('resolves false on dismiss after a failure', async () => {
    const flow = createConfirmFlow(describe500)
    const result = track(flow.request({ ...base, action: () => Promise.reject({ detail: 'No' }) }))
    flow.accept()
    await flush()
    flow.dismiss()
    await flush()
    expect(result.value).toBe(false)
    expect(flow.get().open).toBe(false)
  })

  it('ignores dismiss and a second accept while pending', async () => {
    const flow = createConfirmFlow(describe500)
    const run = controlled()
    let calls = 0
    const result = track(flow.request({ ...base, action: () => { calls++; return run.promise } }))
    flow.accept()
    flow.accept()
    flow.dismiss()
    await flush()
    expect(calls).toBe(1)
    expect(result.value).toBe('pending')
    expect(summary(flow.get())).toBe('pending')
    run.resolve(undefined)
    await flush()
    expect(result.value).toBe(true)
  })

  it('publishes open, pending, error, pending and closed in order', async () => {
    const flow = createConfirmFlow(describe500)
    const { seen } = recorder(flow)
    let calls = 0
    flow.request({ ...base, action: () => (++calls === 1 ? Promise.reject({ detail: 'Busy' }) : Promise.resolve()) })
    flow.accept()
    await flush()
    flow.accept()
    await flush()
    expect(seen.map(summary)).toEqual(['open', 'pending', 'error:Busy', 'pending', 'closed'])
  })

  it('stops publishing to an unsubscribed listener', async () => {
    const flow = createConfirmFlow(describe500)
    const { seen, stop } = recorder(flow)
    flow.request(base)
    stop()
    flow.accept()
    await flush()
    expect(seen.map(summary)).toEqual(['open'])
  })
})

describe('createConfirmFlow cancel', () => {
  const rejections: unknown[] = []
  const onRejection = (reason: unknown) => {
    rejections.push(reason)
  }
  beforeEach(() => {
    rejections.length = 0
    process.on('unhandledRejection', onRejection)
  })
  afterEach(() => {
    process.off('unhandledRejection', onRejection)
  })

  it('resolves false and closes while open', async () => {
    const flow = createConfirmFlow(describe500)
    const result = track(flow.request(base))
    flow.cancel()
    await flush()
    expect(result.value).toBe(false)
    expect(flow.get().open).toBe(false)
  })

  it('settles at once while pending and ignores a late success', async () => {
    const flow = createConfirmFlow(describe500)
    const run = controlled()
    const result = track(flow.request({ ...base, action: () => run.promise }))
    flow.accept()
    const { seen } = recorder(flow)
    flow.cancel()
    await flush()
    expect(result.value).toBe(false)
    expect(seen.map(summary)).toEqual(['closed'])
    run.resolve(undefined)
    await flush()
    expect(result.settles).toBe(1)
    expect(result.value).toBe(false)
    expect(seen.map(summary)).toEqual(['closed'])
    expect(flow.get()).toEqual({ open: false })
  })

  it('settles at once while pending and ignores a late rejection, unhandled nowhere', async () => {
    const flow = createConfirmFlow(describe500)
    const run = controlled()
    const result = track(flow.request({ ...base, action: () => run.promise }))
    flow.accept()
    const { seen } = recorder(flow)
    flow.cancel()
    run.reject({ detail: 'Late failure' })
    await flush()
    await flush()
    expect(result.settles).toBe(1)
    expect(result.value).toBe(false)
    expect(seen.map(summary)).toEqual(['closed'])
    expect(flow.get()).toEqual({ open: false })
    expect(rejections).toEqual([])
  })

  it('leaves a newer request alone when the cancelled action settles late', async () => {
    const flow = createConfirmFlow(describe500)
    const old = controlled()
    track(flow.request({ ...base, action: () => old.promise }))
    flow.accept()
    flow.cancel()
    const next = track(flow.request({ ...base, title: 'Next' }))
    const { seen } = recorder(flow)
    old.reject({ detail: 'Old failure' })
    await flush()
    expect(next.value).toBe('pending')
    expect(seen).toEqual([])
    expect(flow.get()).toEqual({ open: true, request: { ...base, title: 'Next' }, pending: false, error: null })

    const other = controlled()
    flow.cancel()
    const third = track(flow.request({ ...base, title: 'Third', action: () => other.promise }))
    flow.accept()
    const late = controlled()
    // A late success from a cancelled request does not close the newer pending one either.
    flow.cancel()
    track(flow.request({ ...base, title: 'Fourth', action: () => late.promise }))
    other.resolve(undefined)
    await flush()
    expect(third.value).toBe(false)
    const view = flow.get()
    expect(view.open && view.request.title).toBe('Fourth')
    expect(rejections).toEqual([])
  })

  it('is a no-op with nothing open', async () => {
    const flow = createConfirmFlow(describe500)
    const { seen } = recorder(flow)
    flow.cancel()
    await flush()
    expect(seen).toEqual([])
    expect(flow.get()).toEqual({ open: false })
  })
})
