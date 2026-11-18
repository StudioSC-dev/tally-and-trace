// STU-771 AC3: times 20 loads of the Dashboard, from just before `page.goto('/')` until its `h1` is visible. Run by
// `scripts/verify-stu-771.sh` through `measure.config.ts` against one revision's own `webServer`, never by `pnpm test:e2e`
// (its name does not match `*.spec.ts` and it lives outside `e2e/`). The API is the shared household fixture, faked in the
// browser, so both revisions load the same data.
import { expect, test } from '@playwright/test'
import { mockHousehold } from '../../e2e/support/fixtures/household'

/** Loads timed per revision (AC3). */
const LOADS = 20

/** A load must finish to count (AC3 requires all 20); this is only the ceiling on waiting for it. */
const LOAD_CEILING_MS = 120_000

test.describe.configure({ mode: 'parallel' })

for (let i = 1; i <= LOADS; i += 1) {
  test(`dashboard load ${String(i).padStart(2, '0')}`, async ({ page }, testInfo) => {
    test.setTimeout(LOAD_CEILING_MS + 30_000)
    await mockHousehold(page)
    const heading = page.getByRole('heading', { level: 1, name: 'Dashboard' })
    const start = performance.now()
    await page.goto('/')
    await expect(heading).toBeVisible({ timeout: LOAD_CEILING_MS })
    const ms = performance.now() - start
    testInfo.annotations.push({ type: 'dashboard-h1-ms', description: ms.toFixed(1) })
  })
}
