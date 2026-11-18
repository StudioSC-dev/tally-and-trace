import { defineConfig, devices } from '@playwright/test'

const port = Number(process.env.E2E_PORT ?? 4317)
const baseURL = `http://localhost:${port}`
// Each run builds into its own directory, keyed by its port, never the shared `dist/`: a build that rewrites the files
// a running preview is serving makes a page load with no stylesheet (STU-771).
const outDir = `node_modules/.e2e-dist/${port}`

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
    command: `pnpm exec vite build --minify false --outDir ${outDir} && pnpm exec vite preview --outDir ${outDir} --port ${port} --strictPort`,
    url: baseURL,
    reuseExistingServer: false,
    timeout: 300_000,
  },
})
