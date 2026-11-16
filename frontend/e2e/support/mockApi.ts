import { expect } from '@playwright/test'
import type { Page, Route } from '@playwright/test'
import type { TokenResponse, User } from '@tally-trace/shared'

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'

/** One faked API endpoint. `path` is relative to `/api/v1`, for example `/auth/login`. */
export interface ApiRoute {
  method: HttpMethod
  path: string
  status?: number
  body: unknown
}

/** Builds a route whose body is checked against the type `T` at compile time. */
export const apiRoute = <T>(method: HttpMethod, path: string, body: T, status = 200): ApiRoute => ({
  method,
  path,
  status,
  body,
})

export const loginRoute = (body: TokenResponse): ApiRoute => apiRoute('POST', '/auth/login', body)
export const meRoute = (user: User): ApiRoute => apiRoute('GET', '/auth/me', user)

/** An error reply in the shape the API uses: `{ detail: string }`. */
export const errorRoute = (method: HttpMethod, path: string, status: number, detail: string): ApiRoute =>
  apiRoute<{ detail: string }>(method, path, { detail }, status)

export interface MockOptions {
  /** Stubs the page may call any number of times (including never); each answers with its own data. */
  allow?: ApiRoute[]
}

export interface ApiMock {
  /** How many times the mocked or allowed route was called. */
  count: (method: HttpMethod, path: string) => number
  /** Every `/api/v1` request seen, as `METHOD /path`. */
  requests: () => string[]
}

interface MockState {
  routes: Map<string, ApiRoute>
  counts: Map<string, number>
  seen: string[]
}

const API_PREFIX = '/api/v1'
const states = new WeakMap<Page, MockState>()

const keyOf = (method: string, path: string): string => `${method.toUpperCase()} ${path}`

async function answer(state: MockState, route: Route): Promise<void> {
  const request = route.request()
  const { pathname } = new URL(request.url())
  const path = pathname.startsWith(API_PREFIX) ? pathname.slice(API_PREFIX.length) : pathname
  const key = keyOf(request.method(), path)
  state.seen.push(key)
  const hit = state.routes.get(key)
  if (!hit) {
    // Soft-fail now so the test is red even if the page swallows the error, then answer so the page settles.
    expect.soft(key, `unmocked API call: ${key}`).toBe('a mocked or allowed route')
    await route.fulfill({
      status: 501,
      contentType: 'application/json',
      body: JSON.stringify({ detail: `unmocked ${key}` }),
    })
    return
  }
  state.counts.set(key, (state.counts.get(key) ?? 0) + 1)
  await route.fulfill({
    status: hit.status ?? 200,
    contentType: 'application/json',
    body: JSON.stringify(hit.body),
  })
}

async function stateFor(page: Page): Promise<MockState> {
  const existing = states.get(page)
  if (existing) return existing
  const state: MockState = { routes: new Map(), counts: new Map(), seen: [] }
  states.set(page, state)
  await page.route('**/api/v1/**', (route) => answer(state, route))
  return state
}

const handleFor = (state: MockState): ApiMock => ({
  count: (method, path) => state.counts.get(keyOf(method, path)) ?? 0,
  requests: () => [...state.seen],
})

/** Registers extra routes on a page that already has the catch-all. Used by `signedIn`. */
export async function addRoutes(page: Page, routes: ApiRoute[]): Promise<ApiMock> {
  const state = await stateFor(page)
  for (const r of routes) state.routes.set(keyOf(r.method, r.path), r)
  return handleFor(state)
}

/**
 * Fakes the API in the browser. Anything under `/api/v1` that is neither in `routes`
 * nor in `allow` fails the test. No request ever leaves the browser.
 */
export async function mockApi(page: Page, routes: ApiRoute[], options: MockOptions = {}): Promise<ApiMock> {
  return addRoutes(page, [...(options.allow ?? []), ...routes])
}
