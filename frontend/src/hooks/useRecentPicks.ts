import { useCallback, useEffect, useState } from 'react'
import { pushRecent, RECENT_MAX } from '@tally-trace/shared'
import type { PickerId } from '@tally-trace/shared'
import { useAuth } from '../contexts/AuthContext'

export type RecentKind = 'account' | 'category'

const storageKey = (userId: number, kind: RecentKind): string => `tt:recent:${userId}:${kind}`

function readRecents(key: string | null): PickerId[] {
  if (key === null) return []
  try {
    const raw = window.localStorage.getItem(key)
    if (raw === null) return []
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed
      .filter((id): id is PickerId => typeof id === 'number' || typeof id === 'string')
      .slice(0, RECENT_MAX)
  } catch {
    return []
  }
}

/**
 * The ids recently used in a picker, newest first, for the signed-in user on this device
 * (`localStorage`, `tt:recent:<userId>:<kind>`). Storage that throws or holds junk reads
 * as empty and is never fatal. `push` records ids after a save: the first id given ends
 * up newest.
 */
export function useRecentPicks(kind: RecentKind) {
  const { user } = useAuth()
  const key = user ? storageKey(user.id, kind) : null
  const [recentIds, setRecentIds] = useState<PickerId[]>(() => readRecents(key))

  useEffect(() => {
    setRecentIds(readRecents(key))
  }, [key])

  const push = useCallback(
    (ids: ReadonlyArray<PickerId | null | undefined>) => {
      if (key === null) return
      let next = readRecents(key)
      for (let i = ids.length - 1; i >= 0; i--) {
        const id = ids[i]
        if (id !== null && id !== undefined) next = pushRecent(next, id)
      }
      try {
        window.localStorage.setItem(key, JSON.stringify(next))
      } catch {
        // Storage full or blocked: the recents stay in memory for this page only.
      }
      setRecentIds(next)
    },
    [key],
  )

  return { recentIds, push }
}
