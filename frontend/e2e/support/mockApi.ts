import { expect } from '@playwright/test'
import type { Page, Route } from '@playwright/test'
import type { TokenResponse, User } from '@tally-trace/shared'
import { NO_FREE_FLOW } from './fixtures/freeFlow'

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'

/** One faked API endpoint. `path` is relative to `/api/v1`, for example `/auth/login`. */
export interface ApiRoute {
  method: HttpMethod
  path: string
  status?: number
  body: unknown
  /**
   * Optional replies, one per call in order; once they run out the last one repeats. When present they take
   * precedence over `status` and `body`, which `sequenceRoute` keeps in step with the last reply.
   */
  replies?: ApiReply[]
  /**
   * Optional: answers each call from the request's query string. Used in place of `body` (not of `replies`), still
   * keyed on method and path, so the call is counted and an unregistered method still fails. A query it throws on
   * fails the test. `queryRoute` keeps `body` as the answer to a call with no query.
   */
  respond?: (query: URLSearchParams) => unknown
}

/** One reply in a `replies` list. */
export interface ApiReply {
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

/** Builds a route that answers from the request's query string, checked against the type `T` at compile time. */
export const queryRoute = <T>(method: HttpMethod, path: string, respond: (query: URLSearchParams) => T, status = 200): ApiRoute => ({
  method,
  path,
  status,
  body: respond(new URLSearchParams()),
  respond,
})

/** Builds a route that answers each call with the next reply, so a save can be followed by a refreshed GET. */
export const sequenceRoute = <T>(method: HttpMethod, path: string, replies: { body: T; status?: number }[]): ApiRoute => {
  const last = replies[replies.length - 1]
  return { method, path, status: last?.status ?? 200, body: last?.body, replies }
}

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
  /** The JSON request bodies seen for a route, in order. A call with no JSON body adds nothing. */
  bodies: (method: HttpMethod, path: string) => unknown[]
}

interface MockState {
  routes: Map<string, ApiRoute>
  counts: Map<string, number>
  seen: string[]
}

const API_PREFIX = '/api/v1'
const states = new WeakMap<Page, MockState>()
const captured = new WeakMap<MockState, Map<string, unknown[]>>()

const capturedFor = (state: MockState): Map<string, unknown[]> => {
  const existing = captured.get(state)
  if (existing) return existing
  const fresh = new Map<string, unknown[]>()
  captured.set(state, fresh)
  return fresh
}

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
  const call = state.counts.get(key) ?? 0
  const sent = request.postData()
  if (sent) {
    try {
      const store = capturedFor(state)
      store.set(key, [...(store.get(key) ?? []), JSON.parse(sent) as unknown])
    } catch {
      // A body that is not JSON is not captured.
    }
  }
  if (hit.replies?.length) {
    const reply = hit.replies[Math.min(call, hit.replies.length - 1)]
    state.counts.set(key, call + 1)
    await route.fulfill({
      status: reply.status ?? 200,
      contentType: 'application/json',
      body: JSON.stringify(reply.body),
    })
    return
  }
  state.counts.set(key, (state.counts.get(key) ?? 0) + 1)
  let body = hit.body
  if (hit.respond) {
    try {
      body = hit.respond(new URL(request.url()).searchParams)
    } catch (error) {
      // A query the fake does not handle fails the test, like an unmocked call.
      expect.soft(String(error), `unhandled query: ${request.url()}`).toBe('a handled query')
      await route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ detail: String(error) }) })
      return
    }
  }
  await route.fulfill({
    status: hit.status ?? 200,
    contentType: 'application/json',
    body: JSON.stringify(body),
  })
}

/**
 * Every page that shows the ranked Savings goals section reads `GET /wishlist/free-flow` (STU-790). It is answered with
 * `NO_FREE_FLOW` unless a spec registers its own route, which replaces this one.
 */
async function stateFor(page: Page): Promise<MockState> {
  const existing = states.get(page)
  if (existing) return existing
  const state: MockState = { routes: new Map(), counts: new Map(), seen: [] }
  state.routes.set(keyOf('GET', '/wishlist/free-flow'), { method: 'GET', path: '/wishlist/free-flow', body: NO_FREE_FLOW })
  states.set(page, state)
  await page.route('**/api/v1/**', (route) => answer(state, route))
  return state
}

const handleFor = (state: MockState): ApiMock => ({
  count: (method, path) => state.counts.get(keyOf(method, path)) ?? 0,
  requests: () => [...state.seen],
  bodies: (method, path) => [...(capturedFor(state).get(keyOf(method, path)) ?? [])],
})

/** Registers extra routes on a page that already has the catch-all. Used by `signedIn`. */
export async function addRoutes(page: Page, routes: ApiRoute[]): Promise<ApiMock> {
  const state = await stateFor(page)
  for (const r of routes) state.routes.set(keyOf(r.method, r.path), r)
  return handleFor(state)
}

/**
 * Fakes the API in the browser. Any URL containing `/api/v1/`, on any origin, is intercepted; other URLs are
 * not. An intercepted request that is neither in `routes` nor in `allow` fails the test.
 */
export async function mockApi(page: Page, routes: ApiRoute[], options: MockOptions = {}): Promise<ApiMock> {
  return addRoutes(page, [...(options.allow ?? []), ...routes])
}
