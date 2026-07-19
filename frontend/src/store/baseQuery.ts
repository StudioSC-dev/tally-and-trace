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
    const entityId = localStorage.getItem('active_entity_id')
    if (entityId) headers.set('X-Entity-Id', entityId)
    return headers
  },
})

// A single in-flight refresh shared by all callers, so a burst of 401s triggers
// exactly one /auth/refresh (and reuses the rotated token).
let refreshing: Promise<boolean> | null = null

function clearSession() {
  localStorage.removeItem('access_token')
  // 'refresh_token' is a leftover key from the pre-cookie flow; remove it so no
  // stale token lingers in storage after upgrade. The live token is an httpOnly
  // cookie the server clears on logout / failed refresh.
  localStorage.removeItem('refresh_token')
  localStorage.removeItem('user')
  localStorage.removeItem('active_entity_id')
}

async function refreshAccessToken(): Promise<boolean> {
  if (!refreshing) {
    refreshing = (async () => {
      try {
        // No body: the refresh token rides in the httpOnly cookie, sent because of
        // credentials:'include'. The server rotates it and sets a fresh cookie.
        const res = await fetch(`${API_BASE}/auth/refresh`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: '{}',
        })
        if (!res.ok) return false
        const data = await res.json()
        localStorage.setItem('access_token', data.access_token)
        return true
      } catch {
        return false
      } finally {
        refreshing = null
      }
    })()
  }
  return refreshing
}

/**
 * Base query with silent refresh: on a 401 it tries to rotate the refresh token
 * once and retries the original request; if that fails, it clears the session
 * and redirects to /login.
 */
export const baseQueryWithReauth: BaseQueryFn<
  string | FetchArgs,
  unknown,
  FetchBaseQueryError
> = async (args, api, extraOptions) => {
  let result = await rawBaseQuery(args, api, extraOptions)

  if (result.error && result.error.status === 401) {
    const refreshed = await refreshAccessToken()
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
