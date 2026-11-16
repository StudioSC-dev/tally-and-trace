import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { expect, test } from '@playwright/test'
import type { User } from '@tally-trace/shared'
import { apiRoute, mockApi } from './support/mockApi'
import { landingStubs } from './support/landing'
import { signedIn } from './support/signedIn'

const user: User = {
  id: 1,
  email: 'e2e@example.com',
  first_name: 'Ada',
  last_name: 'Tester',
  default_currency: 'PHP',
  is_active: true,
  is_verified: true,
  onboarding_completed: true,
  created_at: '2026-01-01T00:00:00',
}

test.describe('support', () => {
  test('unmocked nested call fails', async ({ page }) => {
    // The suite must be green while this test is red: it proves an unmocked nested call is caught.
    test.fail()
    await mockApi(page, [apiRoute('GET', '/a', { ok: true })])
    await page.goto('/login')
    // Nested path with no mock and no allow entry: mockApi must fail the test.
    await page.evaluate(() => fetch('/api/v1/a/b').then((r) => r.status))
  })

  test('mocked and allowed calls pass, and are counted', async ({ page }) => {
    const api = await mockApi(page, [apiRoute('GET', '/a/b', { ok: true })], {
      allow: [apiRoute('GET', '/c', [])],
    })
    await page.goto('/login')
    const bodies = await page.evaluate(async () => {
      const nested = await fetch('/api/v1/a/b').then((r) => r.json() as Promise<{ ok: boolean }>)
      const allowed = await fetch('/api/v1/c').then((r) => r.json() as Promise<unknown[]>)
      return { nested, allowed }
    })
    expect(bodies).toEqual({ nested: { ok: true }, allowed: [] })
    expect(api.count('GET', '/a/b')).toBe(1)
    expect(api.count('GET', '/c')).toBe(1)
    expect(api.requests()).toEqual(['GET /a/b', 'GET /c'])
  })

  test('signedIn seeds the session and mocks the current user', async ({ page }) => {
    await mockApi(page, [], { allow: landingStubs() })
    const api = await signedIn(page, user)
    await page.goto('/login')
    // A signed-in visitor is moved off /login by the app.
    await expect(page).not.toHaveURL(/\/login/)
    expect(await page.evaluate(() => window.localStorage.getItem('access_token'))).toBe('e2e-access-token')
    expect(api.count('GET', '/auth/me')).toBeGreaterThan(0)
  })

  test('e2e typecheck rejects invalid mock types', () => {
    test.setTimeout(120_000)
    const frontend = path.resolve(test.info().config.rootDir, '..')
    const run = (project: string) =>
      spawnSync('pnpm', ['exec', 'tsc', '-p', project, '--noEmit'], { cwd: frontend, encoding: 'utf8' })

    const clean = run('tsconfig.e2e.json')
    expect(clean.status, clean.stdout + clean.stderr).toBe(0)

    const bad = run('e2e/fixtures/tsconfig.json')
    expect(bad.status).not.toBe(0)
    expect(bad.stdout + bad.stderr).toContain('e2e/fixtures/bad-mock.ts')
  })
})
