/**
 * What a screen should render for one query: nothing yet, the data, or a failure.
 *
 * Pure over RTK Query's result flags, with no React and no RTK import, so it is
 * testable here and shared by every page.
 */
export type QueryPhase = 'error' | 'pending' | 'ready' | 'skipped'

/** The three flags of an RTK Query result that decide the phase. */
export interface QueryFlags {
  isError: boolean
  isUninitialized: boolean
  isFetching: boolean
}

/**
 * The phase of one query.
 *
 * `value` is what the caller renders: `data`, or `currentData` where a stale arg
 * would mislabel.
 *
 * Order matters:
 * 1. `skipped` gives `skipped`.
 * 2. `isError` gives `error`. The status is read, not `error !== undefined`, because
 *    RTK keeps `error` while a retry is in flight.
 * 3. A defined `value` gives `ready`, fetching or not (stale rows stay on screen).
 * 4. Anything else is `pending`: the first render, a retry after an error, an arg
 *    change with `currentData`, or a query skipped for a reason other than `skip`.
 *    A settled, unskipped query with neither data nor error does not occur.
 */
export function queryPhase(value: unknown, flags: QueryFlags, skipped = false): QueryPhase {
  if (skipped) return 'skipped'
  if (flags.isError) return 'error'
  if (value !== undefined) return 'ready'
  return 'pending'
}
