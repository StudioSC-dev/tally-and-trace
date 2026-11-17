import React from 'react'
import ReactDOM from 'react-dom/client'
import { RouterProvider, createRouter } from '@tanstack/react-router'
import { Provider } from 'react-redux'
import { store } from './store'
import { AuthProvider } from './contexts/AuthContext'
import { initSentry, Sentry } from './utils/sentry'
// IBM Plex Sans, self-hosted. The per-weight files declare the latin and latin-ext faces (U+20B1, the peso sign,
// is in latin-ext) with unicode-range, so the browser fetches only the subsets a page uses.
import '@fontsource/ibm-plex-sans/400.css'
import '@fontsource/ibm-plex-sans/500.css'
import '@fontsource/ibm-plex-sans/600.css'
import './assets/index.css'

// Before any app code runs, so module-level errors during boot are captured.
initSentry()

// Import your generated route tree
import { routeTree } from './routeTree.gen'
import { Button } from './components/Button'

// Create a new router instance
const router = createRouter({ 
  routeTree,
  defaultPreload: 'intent',
})

// Register the router instance for type safety
declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router
  }
}

// eslint-disable-next-line react-refresh/only-export-components
function CrashFallback() {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-4 p-6 text-center">
      <h1 className="font-serif text-2xl text-ink">Something went wrong</h1>
      <p className="text-sm text-muted">
        The error has been reported. Reloading usually fixes it.
      </p>
      <Button
        variant="primary"
        onClick={() => window.location.reload()}
      >
        Reload
      </Button>
    </div>
  )
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <Sentry.ErrorBoundary fallback={<CrashFallback />}>
      <Provider store={store}>
        <AuthProvider>
          <RouterProvider router={router} />
        </AuthProvider>
      </Provider>
    </Sentry.ErrorBoundary>
  </React.StrictMode>,
)
