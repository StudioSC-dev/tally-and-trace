import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { expect, test } from '@playwright/test'
import type { User } from '@tally-trace/shared'
import { apiRoute, mockApi, queryRoute } from './support/mockApi'
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

  test('a query route answers from the query and is counted', async ({ page }) => {
    const api = await mockApi(page, [queryRoute('GET', '/q', (query) => ({ kind: query.get('kind') }))])
    await page.goto('/login')
    const bodies = await page.evaluate(async () => {
      const get = (url: string) => fetch(url).then((r) => r.json() as Promise<{ kind: string | null }>)
      return [await get('/api/v1/q?kind=income'), await get('/api/v1/q?kind=expense'), await get('/api/v1/q')]
    })
    expect(bodies).toEqual([{ kind: 'income' }, { kind: 'expense' }, { kind: null }])
    expect(api.count('GET', '/q')).toBe(3)
    expect(api.requests()).toEqual(['GET /q', 'GET /q', 'GET /q'])
  })

  test('a query route does not answer another method', async ({ page }) => {
    // Red on purpose: a POST to a path with only a GET query route must reach the failing catch-all.
    test.fail()
    await mockApi(page, [queryRoute('GET', '/q', () => ({ ok: true }))])
    await page.goto('/login')
    await page.evaluate(() => fetch('/api/v1/q?kind=income', { method: 'POST', body: '{}' }).then((r) => r.status))
  })

  test('a query route fails on a query it throws on', async ({ page }) => {
    // Red on purpose: a fake that throws on an unknown parameter must fail the test, not answer quietly.
    test.fail()
    await mockApi(page, [
      queryRoute('GET', '/q', (query) => {
        if (query.has('surprise')) throw new Error('unhandled query parameter(s): surprise')
        return { ok: true }
      }),
    ])
    await page.goto('/login')
    await page.evaluate(() => fetch('/api/v1/q?surprise=1').then((r) => r.status))
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
    // This spec lives in <frontend>/e2e, so the frontend package dir is one level up from this file.
    const frontend = fileURLToPath(new URL('..', import.meta.url))
    const pkgFile = path.join(frontend, 'package.json')
    const pkgName = fs.existsSync(pkgFile) ? (JSON.parse(fs.readFileSync(pkgFile, 'utf8')) as { name?: string }).name : undefined
    expect(pkgName, `expected ${pkgFile} to exist with name "tally-and-trace-frontend"; the frontend dir was resolved wrongly`).toBe(
      'tally-and-trace-frontend',
    )
    const run = (project: string) =>
      spawnSync('pnpm', ['exec', 'tsc', '-p', project, '--noEmit'], { cwd: frontend, encoding: 'utf8' })

    const clean = run('tsconfig.e2e.json')
    expect(clean.status, clean.stdout + clean.stderr).toBe(0)

    const bad = run('e2e/fixtures/tsconfig.json')
    expect(bad.status).not.toBe(0)
    expect(bad.stdout + bad.stderr).toContain('e2e/fixtures/bad-mock.ts')
    expect(bad.stdout + bad.stderr).toContain('TS2322')
  })
})
