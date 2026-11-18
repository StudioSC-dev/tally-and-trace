import { defineConfig, devices } from '@playwright/test'

const port = Number(process.env.E2E_PORT ?? 4317)
const baseURL = `http://localhost:${port}`

export default defineConfig({
  testDir: 'e2e',
  testMatch: '**/*.spec.ts',
  outputDir: 'test-results',
  reporter: [['list'], ['json', { outputFile: 'test-results/report.json' }]],
  use: { baseURL },
  projects: [
    {
      name: 'desktop',
      use: { ...devices['Desktop Chrome'], browserName: 'chromium', viewport: { width: 1440, height: 900 } },
    },
    {
      name: 'phone',
      use: {
        ...devices['Desktop Chrome'],
        browserName: 'chromium',
        viewport: { width: 390, height: 844 },
        hasTouch: true,
      },
    },
  ],
  // Pages come from a production build served statically (STU-771): the dev server transforms each module on request,
  // which on a busy host can keep a page from rendering in time. The build runs once, then `vite preview` serves it.
  // `--minify false` keeps the CSS as written, as the dev server served it: specs read tokens such as `100ms`, which
  // the minifier would rewrite as `.1s`.
  webServer: {
    command: `pnpm exec vite build --minify false && pnpm exec vite preview --port ${port} --strictPort`,
    url: baseURL,
    reuseExistingServer: false,
    timeout: 300_000,
  },
})
