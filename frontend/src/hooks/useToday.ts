import { useEffect, useState } from 'react'
import { localToday } from '@tally-trace/shared'

/**
 * The viewer's local calendar day (`YYYY-MM-DD`), kept current: it is recomputed when
 * the window regains focus or the tab becomes visible, and by a timer at local
 * midnight. A page that labels or bounds rows by "today" reads it from here, so the
 * labels and the request bounds always agree on the day.
 */
export function useToday(): string {
  const [today, setToday] = useState(() => localToday())

  useEffect(() => {
    const refresh = () => setToday(localToday())
    let timer: ReturnType<typeof setTimeout> | undefined
    const schedule = () => {
      const now = new Date()
      const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1)
      // A second past midnight, so the recomputed day is the new one.
      timer = setTimeout(() => {
        refresh()
        schedule()
      }, midnight.getTime() - now.getTime() + 1000)
    }
    const onVisibility = () => {
      if (document.visibilityState === 'visible') refresh()
    }
    schedule()
    window.addEventListener('focus', refresh)
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      if (timer !== undefined) clearTimeout(timer)
      window.removeEventListener('focus', refresh)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [])

  return today
}
