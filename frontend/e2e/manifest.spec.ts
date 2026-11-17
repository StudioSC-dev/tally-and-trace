// STU-709: the installed app's colours (web app manifest) match the Columnar pad light theme. The manifest is
// fetched from the running dev server; the API is not used, so nothing is mocked.
import { expect, test } from '@playwright/test'
import type { APIResponse } from '@playwright/test'
import { shot } from './support/shot'

const PAPER = '#e4eae2'

/** Every manifest field except the two colours, recorded from origin/main before this change. */
const BASE_FIELDS = {
  name: 'Tally & Trace',
  short_name: 'Tally & Trace',
  start_url: '/',
  display: 'standalone',
  icons: [{ src: '/icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' }],
}

type Manifest = Record<string, unknown>

async function fetchManifest(response: APIResponse): Promise<Manifest> {
  return (await response.json()) as Manifest
}

test('manifest uses the paper colour', async ({ page }) => {
  const response = await page.request.get('/manifest.webmanifest')
  expect(response.status(), 'GET /manifest.webmanifest status').toBe(200)
  const manifest = await fetchManifest(response)
  expect(String(manifest.background_color).toLowerCase(), 'background_color').toBe(PAPER)
  expect(String(manifest.theme_color).toLowerCase(), 'theme_color').toBe(PAPER)
  await page.goto('/')
  await shot(page, 'paper')
})

test('manifest matches the page and keeps its fields', async ({ page }) => {
  const manifest = await fetchManifest(await page.request.get('/manifest.webmanifest'))
  const html = await (await page.request.get('/')).text()
  const light = /<meta\s+name="theme-color"\s+content="([^"]+)"\s+media="\(prefers-color-scheme:\s*light\)"/i.exec(html)
  expect(light, 'the served index.html has a light theme-color meta').not.toBeNull()
  const content = (light?.[1] ?? '').toLowerCase()
  expect(String(manifest.background_color).toLowerCase(), 'background_color equals the light theme-color meta').toBe(content)
  expect(String(manifest.theme_color).toLowerCase(), 'theme_color equals the light theme-color meta').toBe(content)
  const rest: Manifest = { ...manifest }
  delete rest.background_color
  delete rest.theme_color
  expect(rest, 'every other manifest field is unchanged from origin/main').toEqual(BASE_FIELDS)
  await page.goto('/')
  await expect(page.locator('meta[name="theme-color"][media="(prefers-color-scheme: light)"]'), 'the light meta in the live DOM').toHaveAttribute('content', content)
  await shot(page, 'matches')
})
