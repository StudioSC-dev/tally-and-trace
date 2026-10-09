import { useCallback, useRef } from 'react'

/**
 * Guards a loader against stale responses. Call `begin(reset)` as a request
 * starts: a reset load starts a new generation, a load-more joins the current
 * one. The returned `isCurrent()` turns false once a later reset has begun, so
 * a slow response for an older filter can be ignored instead of overwriting
 * the current list, totals and loading flags.
 */
export function useRequestGeneration() {
  const generationRef = useRef(0)
  return useCallback((reset: boolean) => {
    if (reset) {
      generationRef.current += 1
    }
    const generation = generationRef.current
    return () => generationRef.current === generation
  }, [])
}
