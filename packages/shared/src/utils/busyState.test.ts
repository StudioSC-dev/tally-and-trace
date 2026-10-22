import { describe, it, expect } from 'vitest'
import {
  END_GRACE_MS,
  MIN_VISIBLE_MS,
  SHOW_DELAY_MS,
  STUCK_MS,
  anyQueryPending,
  applyRequestAction,
  idleLevel,
  initialOverlayTiming,
  overlayStep,
  publishGate,
  type BusyLevel,
  type OverlayTiming,
  type RequestActionLike,
} from './busyState'

const EXEMPT = new Set(['fetchReceipt', 'autoPost'])
const PATHS = ['accountingApi', 'authApi'] as const

describe('anyQueryPending', () => {
  it('is false for empty slices', () => {
    expect(anyQueryPending([], EXEMPT)).toBe(false)
    expect(anyQueryPending([{}, {}], EXEMPT)).toBe(false)
    expect(anyQueryPending([undefined], EXEMPT)).toBe(false)
  })

  it('is true for one pending entry in either slice', () => {
    const pending = { 'a(1)': { status: 'pending', endpointName: 'getAccounts' } }
    expect(anyQueryPending([pending, {}], EXEMPT)).toBe(true)
    expect(anyQueryPending([{}, pending], EXEMPT)).toBe(true)
  })

  it('ignores a pending entry whose endpoint is exempt', () => {
    expect(
      anyQueryPending([{ r: { status: 'pending', endpointName: 'fetchReceipt' } }], EXEMPT),
    ).toBe(false)
    expect(
      anyQueryPending([{ r: { status: 'pending', endpointName: 'autoPost' } }], EXEMPT),
    ).toBe(false)
  })

  it('counts a non-exempt entry beside an exempt one', () => {
    expect(
      anyQueryPending(
        [
          {
            r: { status: 'pending', endpointName: 'fetchReceipt' },
            q: { status: 'pending', endpointName: 'getAccounts' },
          },
        ],
        EXEMPT,
      ),
    ).toBe(true)
  })

  it('ignores undefined entries and settled or uninitialized statuses', () => {
    expect(
      anyQueryPending(
        [
          {
            a: undefined,
            b: { status: 'fulfilled', endpointName: 'x' },
            c: { status: 'rejected', endpointName: 'x' },
            d: { status: 'uninitialized', endpointName: 'x' },
          },
        ],
        EXEMPT,
      ),
    ).toBe(false)
  })
})

describe('applyRequestAction', () => {
  const mutation = (
    phase: 'pending' | 'fulfilled' | 'rejected',
    requestId: string,
    path = 'accountingApi',
    endpointName = 'createAccount',
  ): RequestActionLike => ({
    type: `${path}/executeMutation/${phase}`,
    meta: { requestId, arg: { endpointName } },
  })
  const apply = (ids: ReadonlySet<string>, action: RequestActionLike) =>
    applyRequestAction(ids, action, PATHS, EXEMPT)
  const none: ReadonlySet<string> = new Set()

  it('adds on pending and removes on fulfilled', () => {
    const open = apply(none, mutation('pending', 'm1'))
    expect([...open]).toEqual(['accountingApi:m1'])
    expect(apply(open, mutation('fulfilled', 'm1')).size).toBe(0)
  })

  it('removes on rejected (an abort is rejected)', () => {
    const open = apply(none, mutation('pending', 'm1'))
    expect(apply(open, mutation('rejected', 'm1')).size).toBe(0)
  })

  it('treats a settle with an unknown id as a no-op', () => {
    const open = apply(none, mutation('pending', 'm1'))
    expect(apply(open, mutation('fulfilled', 'zzz'))).toBe(open)
    expect(apply(none, mutation('rejected', 'zzz'))).toBe(none)
  })

  it('never adds an exempt mutation', () => {
    expect(apply(none, mutation('pending', 'm1', 'accountingApi', 'autoPost'))).toBe(none)
  })

  it('never touches the set for a query action', () => {
    const open = apply(none, mutation('pending', 'm1'))
    const query: RequestActionLike = {
      type: 'accountingApi/executeQuery/pending',
      meta: { requestId: 'q1', arg: { endpointName: 'getAccounts' } },
    }
    expect(apply(open, query)).toBe(open)
    expect(apply(open, { ...query, type: 'accountingApi/executeQuery/fulfilled' })).toBe(open)
  })

  it('ignores actions of other slices', () => {
    expect(apply(none, { type: 'auth/setUser' })).toBe(none)
    expect(apply(none, { type: 'otherApi/executeMutation/pending', meta: { requestId: 'x' } })).toBe(none)
  })

  it('removes only that API ids on resetApiState', () => {
    let ids = apply(none, mutation('pending', 'a1', 'accountingApi'))
    ids = apply(ids, mutation('pending', 'b1', 'authApi', 'logout'))
    const afterAuthReset = apply(ids, { type: 'authApi/resetApiState' })
    expect([...afterAuthReset]).toEqual(['accountingApi:a1'])
    const afterAccountingReset = apply(ids, { type: 'accountingApi/resetApiState' })
    expect([...afterAccountingReset]).toEqual(['authApi:b1'])
  })

  it('keeps the same request id of two APIs apart', () => {
    let ids = apply(none, mutation('pending', 'same', 'accountingApi'))
    ids = apply(ids, mutation('pending', 'same', 'authApi', 'logout'))
    expect(ids.size).toBe(2)
    ids = apply(ids, mutation('fulfilled', 'same', 'authApi', 'logout'))
    expect([...ids]).toEqual(['accountingApi:same'])
  })

  it('holds a StrictMode sequence until the last settle', () => {
    let ids = apply(none, mutation('pending', 'm1'))
    ids = apply(ids, mutation('pending', 'm2'))
    ids = apply(ids, mutation('fulfilled', 'm1'))
    expect(ids.size).toBe(1)
    ids = apply(ids, mutation('fulfilled', 'm2'))
    expect(ids.size).toBe(0)
  })

  it('does not mutate the set it was given', () => {
    const open = apply(none, mutation('pending', 'm1'))
    apply(open, mutation('fulfilled', 'm1'))
    expect(open.size).toBe(1)
  })
})

describe('publishGate', () => {
  const busy: BusyLevel = { busy: true, saving: false }
  const saving: BusyLevel = { busy: true, saving: true }

  it('publishes a true level at depth 2 at once', () => {
    expect(publishGate(idleLevel, busy, 2)).toEqual({ state: busy, publish: true })
  })

  it('holds a false level at depth 2, then publishes the false at depth 0', () => {
    const held = publishGate(busy, idleLevel, 2)
    expect(held).toEqual({ state: busy, publish: false })
    expect(publishGate(held.state, idleLevel, 0)).toEqual({ state: idleLevel, publish: true })
  })

  it('publishes no false when a false at depth 2 is followed by a true at depth 0', () => {
    const held = publishGate(busy, idleLevel, 2)
    expect(publishGate(held.state, busy, 0)).toEqual({ state: busy, publish: false })
  })

  it('publishes nothing for an unchanged level', () => {
    expect(publishGate(busy, busy, 0).publish).toBe(false)
    expect(publishGate(idleLevel, idleLevel, 0).publish).toBe(false)
    expect(publishGate(busy, busy, 3).publish).toBe(false)
  })

  it('publishes a saving change at once, in both directions', () => {
    expect(publishGate(busy, saving, 2)).toEqual({ state: saving, publish: true })
    expect(publishGate(saving, busy, 2)).toEqual({ state: busy, publish: true })
  })
})

describe('overlayStep', () => {
  /** Runs steps in order, feeding each timing into the next. */
  const run = (steps: Array<[busy: boolean, now: number, frame?: boolean]>) => {
    let t: OverlayTiming = initialOverlayTiming
    let last = overlayStep(t, false, 0)
    for (const [busy, now, frame] of steps) {
      last = overlayStep(t, busy, now, frame ?? false)
      t = last.timing
    }
    return last
  }

  it('shields at once, wakes at 300 and is visible at 300', () => {
    const first = overlayStep(initialOverlayTiming, true, 0)
    expect(first.phase).toBe('shield')
    expect(first.wakeAt).toBe(SHOW_DELAY_MS)
    expect(run([[true, 0], [true, 299]]).phase).toBe('shield')
    const shown = run([[true, 0], [true, 300]])
    expect(shown.phase).toBe('visible')
    expect(shown.timing.shownAt).toBe(300)
  })

  it('blocks input in shield and visible, never in hidden', () => {
    // The caller treats `phase !== 'hidden'` as blocked.
    expect(run([[true, 0]]).phase).not.toBe('hidden')
    expect(run([[true, 0], [true, 400]]).phase).not.toBe('hidden')
    expect(overlayStep(initialOverlayTiming, false, 10).phase).toBe('hidden')
  })

  it('never shows for a busy spell shorter than 300 ms', () => {
    const steps: Array<[boolean, number, boolean?]> = [[true, 0], [true, 200], [false, 200]]
    expect(run(steps).phase).toBe('shield')
    // Clear since 200: shield until 250 and the second frame.
    expect(run([...steps, [false, 220, true]]).phase).toBe('shield')
    expect(run([...steps, [false, 250, true]]).phase).toBe('shield') // one frame only
    const done = run([...steps, [false, 230, true], [false, 250, true]])
    expect(done.phase).toBe('hidden')
    expect(done.timing).toEqual(initialOverlayTiming)
  })

  it('stays shield at 250 with a single frame', () => {
    expect(run([[true, 0], [true, 200], [false, 200], [false, 250, true]]).phase).toBe('shield')
  })

  it('does not become visible while holding a short episode open', () => {
    const held = run([[true, 0], [true, 200], [false, 200], [false, 400]])
    expect(held.phase).toBe('shield')
    expect(held.timing.shownAt).toBeNull()
  })

  it('keeps a shown overlay visible until 300 ms after it showed', () => {
    const base: Array<[boolean, number, boolean?]> = [[true, 0], [true, 300], [true, 400], [false, 400]]
    expect(run([...base, [false, 450, true], [false, 500, true]]).phase).toBe('visible')
    expect(run([...base, [false, 599, true], [false, 599, true]]).phase).toBe('visible')
    const done = run([...base, [false, 450, true], [false, 600, true]])
    expect(done.phase).toBe('hidden')
    expect(MIN_VISIBLE_MS).toBe(300)
  })

  it('hides at 1050 after two frames when cleared at 1000 after showing at 300', () => {
    const base: Array<[boolean, number, boolean?]> = [[true, 0], [true, 300], [true, 1000], [false, 1000]]
    expect(run([...base, [false, 1049, true], [false, 1049, true]]).phase).toBe('visible')
    expect(run([...base, [false, 1016, true], [false, 1049, true]]).phase).toBe('visible')
    expect(run([...base, [false, 1016, true], [false, 1050, true]]).phase).toBe('hidden')
    expect(END_GRACE_MS).toBe(50)
  })

  it('waits for the grace even when two frames have passed', () => {
    const base: Array<[boolean, number, boolean?]> = [[true, 0], [true, 300], [true, 1000], [false, 1000]]
    const early = run([...base, [false, 1010, true], [false, 1020, true]])
    expect(early.phase).toBe('visible')
    expect(early.wakeAt).toBe(1050)
  })

  it('keeps busySince when the level clears for 30 ms and goes busy again', () => {
    const again = run([[true, 100], [false, 200], [false, 230, true], [true, 230]])
    expect(again.timing.busySince).toBe(100)
    expect(again.timing.clearSince).toBeNull()
    expect(again.timing.clearFrames).toBe(0)
    // One episode: the show delay counts from 100, not from 230.
    expect(run([[true, 100], [false, 200], [true, 230], [true, 400]]).phase).toBe('visible')
  })

  it('is stuck at 20 000 ms and not at 19 999', () => {
    expect(run([[true, 0], [true, 19_999]]).stuck).toBe(false)
    expect(run([[true, 0], [true, STUCK_MS]]).stuck).toBe(true)
  })

  it('wakes at the stuck threshold once visible', () => {
    expect(run([[true, 0], [true, 300]]).wakeAt).toBe(STUCK_MS)
    expect(run([[true, 0], [true, STUCK_MS]]).wakeAt).toBeNull()
  })

  it('stays stuck while a stuck episode holds on clear, and not once hidden', () => {
    const held = run([[true, 0], [true, 300], [true, STUCK_MS], [false, STUCK_MS]])
    expect(held.stuck).toBe(true)
    expect(held.phase).toBe('visible')
    const done = run([[true, 0], [true, 300], [true, STUCK_MS], [false, STUCK_MS], [false, STUCK_MS + 10, true], [false, STUCK_MS + 20, true]])
    expect(done.phase).toBe('visible') // grace (50 ms) not yet met
    const ended = run([[true, 0], [true, 300], [true, STUCK_MS], [false, STUCK_MS], [false, STUCK_MS + 25, true], [false, STUCK_MS + 50, true]])
    expect(ended.phase).toBe('hidden')
    expect(ended.stuck).toBe(false)
  })

  it('resets to the initial timing after hidden', () => {
    const done = run([[true, 0], [false, 10], [false, 30, true], [false, 60, true]])
    expect(done.phase).toBe('hidden')
    expect(done.timing).toEqual(initialOverlayTiming)
    expect(done.wakeAt).toBeNull()
  })

  it('does not mutate the timing it was given', () => {
    const t = overlayStep(initialOverlayTiming, true, 0).timing
    const copy = { ...t }
    overlayStep(t, true, 500)
    overlayStep(t, false, 500, true)
    expect(t).toEqual(copy)
  })
})
