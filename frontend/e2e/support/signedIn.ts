import type { Page } from '@playwright/test'
import type { User } from '@tally-trace/shared'
import { addRoutes, meRoute } from './mockApi'
import type { ApiMock } from './mockApi'

/**
 * Starts the page signed in: seeds `access_token` and `user` in localStorage before any
 * script runs, and mocks the current-user call.
 */
export async function signedIn(page: Page, user: User): Promise<ApiMock> {
  await page.addInitScript(
    ({ token, saved }: { token: string; saved: string }) => {
      window.localStorage.setItem('access_token', token)
      window.localStorage.setItem('user', saved)
    },
    { token: 'e2e-access-token', saved: JSON.stringify(user) },
  )
  return addRoutes(page, [meRoute(user)])
}
