import path from 'node:path'
import { test } from '@playwright/test'
import type { Page } from '@playwright/test'

/**
 * Saves `test-results/screens/<spec>-<name>-<project>.png` and returns its absolute path.
 * `<spec>` is the spec file name without `.spec.ts`.
 */
export async function shot(page: Page, name: string): Promise<string> {
  const info = test.info()
  const spec = path.basename(info.file).replace(/\.spec\.ts$/, '')
  const file = path.join(info.project.outputDir, 'screens', `${spec}-${name}-${info.project.name}.png`)
  await page.screenshot({ path: file, fullPage: true, animations: 'disabled' })
  return file
}
