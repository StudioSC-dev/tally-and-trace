import { fetchBaseQuery } from '@reduxjs/toolkit/query/react'
import type { BaseQueryFn, FetchArgs, FetchBaseQueryError } from '@reduxjs/toolkit/query/react'

const API_BASE = `${import.meta.env.VITE_API_URL || ''}/api/v1`

const rawBaseQuery = fetchBaseQuery({
  baseUrl: API_BASE,
  // Send the httpOnly refresh cookie on cross-origin (web -> api subdomain) requests.
  credentials: 'include',
  prepareHeaders: (headers) => {
    const token = localStorage.getItem('access_token')
    if (token) headers.set('authorization', `Bearer ${token}`)
    return headers
  },
})

// A single in-flight refresh shared by all callers, so a burst of 401s triggers
// exactly one /auth/refresh (and reuses the rotated token).
let refreshing: Promise<boolean> | null = null
let refreshController: AbortController | null = null

// Advances on every login / logout / session clear. A refresh or retry that
// started under an older generation belongs to the previous user and must not
// touch the current session.
let sessionGeneration = 0

/**
 * Start a new auth session: abort any in-flight refresh and detach it, so its
 * late result can neither store a token nor clear the session, and no new
 * request can join it.
 */
export function beginNewSession(): void {
  sessionGeneration++
  refreshController?.abort()
  refreshController = null
  refreshing = null
}

function clearSession() {
  localStorage.removeItem('access_token')
  // 'refresh_token' is a leftover key from the pre-cookie flow; remove it so no
  // stale token lingers in storage after upgrade. The live token is an httpOnly
  // cookie the server clears on logout / failed refresh.
  localStorage.removeItem('refresh_token')
  localStorage.removeItem('user')
}

async function refreshAccessToken(): Promise<boolean> {
  if (!refreshing) {
    const generation = sessionGeneration
    const controller = new AbortController()
    refreshController = controller
    refreshing = (async () => {
      try {
        // No body: the refresh token rides in the httpOnly cookie, sent because of
        // credentials:'include'. The server rotates it and sets a fresh cookie.
        const res = await fetch(`${API_BASE}/auth/refresh`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: '{}',
          signal: controller.signal,
        })
        if (!res.ok) return false
        const data = await res.json()
        if (generation !== sessionGeneration) return false
        localStorage.setItem('access_token', data.access_token)
        return true
      } catch {
        return false
      } finally {
        if (refreshController === controller) {
          refreshing = null
          refreshController = null
        }
      }
    })()
  }
  return refreshing
}

/**
 * Base query with silent refresh: on a 401 it tries to rotate the refresh token
 * once and retries the original request; if that fails, it clears the session
 * and redirects to /login. If the session changes (logout / login) meanwhile,
 * the original 401 is returned untouched.
 */
export const baseQueryWithReauth: BaseQueryFn<
  string | FetchArgs,
  unknown,
  FetchBaseQueryError
> = async (args, api, extraOptions) => {
  const generation = sessionGeneration
  let result = await rawBaseQuery(args, api, extraOptions)

  if (result.error && result.error.status === 401) {
    // The session changed while this request was in flight: its 401 belongs to
    // the previous user, so return it without refreshing, retrying or clearing.
    if (generation !== sessionGeneration) return result
    const refreshed = await refreshAccessToken()
    if (generation !== sessionGeneration) return result
    if (refreshed) {
      result = await rawBaseQuery(args, api, extraOptions)
    } else {
      clearSession()
      if (window.location.pathname !== '/login') {
        window.location.href = '/login'
      }
    }
  }

  return result
}
