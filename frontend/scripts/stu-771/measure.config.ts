// STU-771 AC3: runs `dashboard-load.measure.ts` against the revision this file sits in, through that revision's own
// `playwright.config.ts` `webServer` (the dev server on `main`, the built bundle on the PR head). Desktop project only,
// 3 parallel workers, no retries. `STU771_REPORT` names the JSON report the verification script reads.
import { fileURLToPath } from 'node:url'
import { defineConfig } from '@playwright/test'
import type { PlaywrightTestConfig } from '@playwright/test'
import base from '../../playwright.config'

const FRONTEND = fileURLToPath(new URL('../..', import.meta.url))
const server = base.webServer as NonNullable<PlaywrightTestConfig['webServer']> & { command: string }

export default defineConfig({
  ...base,
  testDir: '.',
  testMatch: 'dashboard-load.measure.ts',
  outputDir: process.env.STU771_OUT ?? '../../test-results/stu-771-measure',
  reporter: [['list'], ['json', { outputFile: process.env.STU771_REPORT ?? '../../test-results/stu-771-measure.json' }]],
  workers: 3,
  fullyParallel: true,
  retries: 0,
  projects: (base.projects ?? []).filter((p) => p.name === 'desktop'),
  // The command runs in the frontend directory, where `vite` finds `index.html`, not beside this file.
  webServer: { ...server, cwd: FRONTEND },
})
