import { useEffect, useRef } from 'react'
import { useDispatch, useSelector, useStore } from 'react-redux'
import { outboxStorageKey, persistOutbox, restoreOutbox, unsettledCount } from '@tally-trace/shared'
import type { AppDispatch, RootState } from '../store'
import { outboxActions } from '../store/outbox'

// The save outbox's page-lifetime duties (STU-605), mounted once in Layout's signed-in branch:
// - its unsettled saves are mirrored to localStorage under the signed-in user's id, and read
//   back on the next sign-in or reload as "not confirmed" failures (nothing resends by itself);
// - while a save is unsent or in flight, leaving the page asks first (`beforeunload`);
// - signing out empties the in-memory queue, so the next user never sees it.
// Every storage access is in try/catch: storage can be blocked, and the queue then lasts for
// this page only.

export function OutboxHost({ userId }: { userId: number }) {
  const dispatch = useDispatch<AppDispatch>()
  const store = useStore<RootState>()
  const unsettled = useSelector((state: RootState) => unsettledCount(state.outbox))
  // The user the mirror writes for; cleared before the reset, so the reset writes nothing.
  const owner = useRef<number | null>(null)

  useEffect(() => {
    const key = outboxStorageKey(userId)
    let saved: string | null = null
    try {
      saved = localStorage.getItem(key)
    } catch {
      saved = null
    }
    dispatch(outboxActions.hydrated(restoreOutbox(saved)))
    owner.current = userId
    let last = ''
    const mirror = () => {
      if (owner.current !== userId) return
      const outbox = store.getState().outbox
      const json = outbox.entries.length > 0 ? persistOutbox(outbox) : ''
      if (json === last) return
      last = json
      try {
        if (json) localStorage.setItem(key, json)
        else localStorage.removeItem(key)
      } catch {
        // Blocked storage: the queue lasts for this page only.
      }
    }
    mirror()
    const unsubscribe = store.subscribe(mirror)
    return () => {
      unsubscribe()
      owner.current = null
      dispatch(outboxActions.reset())
    }
  }, [dispatch, store, userId])

  useEffect(() => {
    if (unsettled === 0) return
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault()
      // Older browsers show the prompt only when returnValue is set.
      event.returnValue = ''
    }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [unsettled])

  return null
}
