/**
 * Pure rule for the reauth base query: what to do with a 401. No DOM, no RTK.
 */

/** What the reauth base query does with a 401. */
export type ReauthStep = 'ignore' | 'refresh' | 'clear'

/**
 * - `ignore`: the session changed while the request was in flight, so the 401
 *   belongs to a previous session and is returned untouched.
 * - `clear`: the request was sent with no access token, so it was never part of
 *   a signed-in session. Skip the refresh and clear the session as on a failed one.
 * - `refresh`: the request was sent with a token; try to rotate it.
 */
export function stepAfter401(input: {
  sentToken: boolean
  startedGeneration: number
  currentGeneration: number
}): ReauthStep {
  if (input.startedGeneration !== input.currentGeneration) return 'ignore'
  return input.sentToken ? 'refresh' : 'clear'
}
