import { fetchBaseQuery } from '@reduxjs/toolkit/query/react'
import type { BaseQueryFn, FetchArgs, FetchBaseQueryError } from '@reduxjs/toolkit/query/react'

const API_BASE = `${import.meta.env.VITE_API_URL || ''}/api/v1`

const rawBaseQuery = fetchBaseQuery({
  baseUrl: API_BASE,
  prepareHeaders: (headers) => {
    const token = localStorage.getItem('access_token')
    if (token) headers.set('authorization', `Bearer ${token}`)
    return headers
  },
})

// A single in-flight refresh shared by all callers, so a burst of 401s triggers
// exactly one /auth/refresh (and reuses the rotated token).
let refreshing: Promise<boolean> | null = null

function clearSession() {
  localStorage.removeItem('access_token')
  localStorage.removeItem('refresh_token')
  localStorage.removeItem('user')
}

async function refreshAccessToken(): Promise<boolean> {
  if (!refreshing) {
    refreshing = (async () => {
      const refresh_token = localStorage.getItem('refresh_token')
      if (!refresh_token) return false
      try {
        const res = await fetch(`${API_BASE}/auth/refresh`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ refresh_token }),
        })
        if (!res.ok) return false
        const data = await res.json()
        localStorage.setItem('access_token', data.access_token)
        localStorage.setItem('refresh_token', data.refresh_token)
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
