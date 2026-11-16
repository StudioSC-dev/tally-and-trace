import fs from 'node:fs'
import { expect, test } from '@playwright/test'
import type { TokenResponse, User } from '@tally-trace/shared'
import { a11y } from './support/a11y'
import { landingStubs } from './support/landing'
import { apiRoute, errorRoute, loginRoute, mockApi, meRoute } from './support/mockApi'
import { shot } from './support/shot'

const user: User = {
  id: 1,
  email: 'ada@example.com',
  first_name: 'Ada',
  last_name: 'Tester',
  default_currency: 'PHP',
  is_active: true,
  is_verified: true,
  onboarding_completed: true,
  created_at: '2026-01-01T00:00:00',
}

const token: TokenResponse = {
  access_token: 'e2e-access-token',
  token_type: 'bearer',
  expires_in: 3600,
}

const EMAIL_ERROR = 'Please enter a valid email address'
const SERVER_ERROR = 'Incorrect email or password'

test.describe('sign-in', () => {
  test('empty form screenshot', async ({ page }) => {
    await mockApi(page, [])
    await page.goto('/login')
    await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible()
    await expect(page.getByLabel('Email address')).toHaveValue('')
    await expect(page.getByLabel('Password')).toHaveValue('')
    const file = await shot(page, 'empty')
    expect(fs.existsSync(file)).toBe(true)
  })

  test('malformed email shows inline error', async ({ page }) => {
    // The error appears while typing (onChange), and submission is blocked because that error disables the submit button.
    const probe = apiRoute('GET', '/e2e-probe', { ok: true })
    const api = await mockApi(page, [loginRoute(token)], { allow: [probe] })
    await page.goto('/login')
    await page.getByLabel('Email address').fill('not-an-email')
    await page.getByLabel('Password').fill('any-password')

    await expect(page.getByText(EMAIL_ERROR)).toBeVisible()
    await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toBeDisabled()
    await page.getByLabel('Password').press('Enter')

    // The probe goes through the same mock after Enter, so any login request fired by Enter would already be recorded.
    const probeStatus = await page.evaluate(() => fetch('/api/v1/e2e-probe').then((r) => r.status))
    expect(probeStatus).toBe(200)
    await expect(page).toHaveURL(/\/login$/)
    expect(api.requests()).toEqual(['GET /e2e-probe'])
    expect(api.count('POST', '/auth/login')).toBe(0)
    const file = await shot(page, 'error')
    expect(fs.existsSync(file)).toBe(true)
  })

  test('valid credentials land on the signed-in route', async ({ page }) => {
    const api = await mockApi(page, [loginRoute(token), meRoute(user)], { allow: landingStubs() })
    await page.goto('/login')
    await page.getByLabel('Email address').fill(user.email)
    await page.getByLabel('Password').fill('correct-password')
    await page.getByRole('button', { name: 'Sign in', exact: true }).click()

    await expect(page).toHaveURL(/\/$/)
    await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible()
    await expect(page.getByRole('heading', { name: 'Sign in' })).toHaveCount(0)
    expect(api.count('POST', '/auth/login')).toBe(1)
    expect(await page.evaluate(() => window.localStorage.getItem('access_token'))).toBe(token.access_token)
    const file = await shot(page, 'success')
    expect(fs.existsSync(file)).toBe(true)
  })

  test('wrong credentials show the server error', async ({ page }) => {
    const api = await mockApi(page, [errorRoute('POST', '/auth/login', 401, SERVER_ERROR)])
    await page.goto('/login')
    await page.getByLabel('Email address').fill(user.email)
    await page.getByLabel('Password').fill('wrong-password')
    await page.getByRole('button', { name: 'Sign in', exact: true }).click()

    await expect(page.getByText(SERVER_ERROR)).toBeVisible()
    await expect(page).toHaveURL(/\/login$/)
    expect(api.count('POST', '/auth/login')).toBe(1)
  })

  test('Enter submits', async ({ page }) => {
    const api = await mockApi(page, [errorRoute('POST', '/auth/login', 401, SERVER_ERROR)])
    await page.goto('/login')
    await page.getByLabel('Email address').fill(user.email)
    await page.getByLabel('Password').fill('some-password')
    await page.getByLabel('Password').press('Enter')

    await expect(page.getByText(SERVER_ERROR)).toBeVisible()
    expect(api.count('POST', '/auth/login')).toBe(1)
  })

  test('phone layout has no sideways scroll and a 44px submit', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'phone', 'AC5 is asserted at the 390px phone project')
    await mockApi(page, [])
    await page.goto('/login')
    const submit = page.getByRole('button', { name: 'Sign in', exact: true })
    await expect(submit).toBeVisible()

    const widths = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
    }))
    expect(widths.clientWidth).toBe(390)
    expect(widths.scrollWidth).toBeLessThanOrEqual(widths.clientWidth)

    const box = await submit.boundingBox()
    expect(box).not.toBeNull()
    expect(box?.height ?? 0).toBeGreaterThanOrEqual(44)
  })

  test('no critical a11y violations', async ({ page }) => {
    await mockApi(page, [])
    await page.goto('/login')
    await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible()
    await a11y(page)
  })
})
