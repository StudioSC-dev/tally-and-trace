import * as Sentry from '@sentry/react'

/**
 * Sentry wiring for the web app.
 *
 * No-op unless VITE_SENTRY_DSN is set at build time, so `pnpm dev` and CI
 * builds stay offline and only the deployed site spends free-tier quota.
 *
 * PII policy mirrors the API (see backend/app/core/observability.py): this is a
 * finance app, so sendDefaultPii stays off and beforeSend strips anything that
 * could carry balances or tokens. No Session Replay — it would capture the
 * user's actual account figures on screen.
 */

const DSN = import.meta.env.VITE_SENTRY_DSN
const ENVIRONMENT = import.meta.env.MODE

// Query strings on our API calls can carry entity ids and date ranges; the
// token itself lives in a header, but strip search params anyway to be safe.
function scrubUrl(url: string): string {
  const queryStart = url.indexOf('?')
  return queryStart === -1 ? url : url.slice(0, queryStart)
}

export function initSentry(): boolean {
  if (!DSN) return false

  Sentry.init({
    dsn: DSN,
    environment: ENVIRONMENT,
    sendDefaultPii: false,
    integrations: [Sentry.browserTracingIntegration()],
    tracesSampleRate: Number(import.meta.env.VITE_SENTRY_TRACES_SAMPLE_RATE ?? 0.1),
    beforeSend(event) {
      if (event.request?.url) event.request.url = scrubUrl(event.request.url)
      // Bodies of failed fetches would contain transaction amounts.
      if (event.request) delete event.request.data
      return event
    },
    beforeBreadcrumb(breadcrumb) {
      if (breadcrumb.category === 'fetch' || breadcrumb.category === 'xhr') {
        const url = breadcrumb.data?.url
        if (typeof url === 'string') breadcrumb.data!.url = scrubUrl(url)
      }
      // Typed input on this app is money and account names — drop it.
      if (breadcrumb.category === 'ui.input') return null
      return breadcrumb
    },
  })

  return true
}

export { Sentry }
