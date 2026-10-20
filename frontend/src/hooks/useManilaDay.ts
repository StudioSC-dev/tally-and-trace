import { useEffect, useRef, useState } from 'react'
import { manilaToday } from '@tally-trace/shared'

/** How often the day is rechecked while the page stays open. */
const CHECK_MS = 30_000

/**
 * Manila's calendar day (`YYYY-MM-DD`), the day the server uses for card statements and
 * payments, whatever the browser's own time zone. It is rechecked on a timer and when
 * the tab becomes visible or the window regains focus. When the day changes, the new
 * day is returned and `onDayChange` runs, so a caller can refetch what the server works
 * out from the day (closed statements, overdue).
 */
export function useManilaDay(onDayChange?: () => void): string {
  const [day, setDay] = useState(() => manilaToday())
  const dayRef = useRef(day)
  const onDayChangeRef = useRef(onDayChange)
  onDayChangeRef.current = onDayChange

  useEffect(() => {
    const check = () => {
      const next = manilaToday()
      if (next === dayRef.current) return
      dayRef.current = next
      setDay(next)
      onDayChangeRef.current?.()
    }
    const onVisibility = () => {
      if (document.visibilityState === 'visible') check()
    }
    const timer = setInterval(check, CHECK_MS)
    window.addEventListener('focus', check)
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      clearInterval(timer)
      window.removeEventListener('focus', check)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [])

  return day
}
