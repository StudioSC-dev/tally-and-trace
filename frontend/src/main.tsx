import React from 'react'
import ReactDOM from 'react-dom/client'
import { RouterProvider, createRouter } from '@tanstack/react-router'
import { Provider } from 'react-redux'
import { store } from './store'
import { AuthProvider } from './contexts/AuthContext'
import { EntityProvider } from './contexts/EntityContext'
import { ThemeProvider } from './contexts/ThemeContext'
import { initSentry, Sentry } from './utils/sentry'
import './assets/index.css'

// Before any app code runs, so module-level errors during boot are captured.
initSentry()

// Import your generated route tree
import { routeTree } from './routeTree.gen'

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

function CrashFallback() {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-4 p-6 text-center">
      <h1 className="text-xl font-semibold">Something went wrong</h1>
      <p className="text-sm opacity-70">
        The error has been reported. Reloading usually fixes it.
      </p>
      <button
        onClick={() => window.location.reload()}
        className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700"
      >
        Reload
      </button>
    </div>
  )
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <Sentry.ErrorBoundary fallback={<CrashFallback />}>
      <Provider store={store}>
        <ThemeProvider>
          <AuthProvider>
            <EntityProvider>
              <RouterProvider router={router} />
            </EntityProvider>
          </AuthProvider>
        </ThemeProvider>
      </Provider>
    </Sentry.ErrorBoundary>
  </React.StrictMode>,
)
