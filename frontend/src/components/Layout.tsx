import { Outlet } from '@tanstack/react-router'
import { Navigation } from './Navigation'
import { BottomNav } from './BottomNav'
import { useAuth } from '../contexts/AuthContext'
import { OnboardingFlow } from './onboarding/OnboardingFlow'
import { ConfirmProvider } from './ConfirmDialog'
import { ToastProvider } from './Toast'
import { OutboxHost } from './OutboxHost'
import { PageLoader } from './Loading'
import { useEffect, useState } from 'react'

export function Layout() {
  const { isAuthenticated, isLoading, user } = useAuth()
  const [showOnboarding, setShowOnboarding] = useState(false)

  useEffect(() => {
    if (!isLoading && isAuthenticated && user && !user.onboarding_completed) {
      setShowOnboarding(true)
    }
  }, [isLoading, isAuthenticated, user])

  if (isLoading) {
    return <PageLoader />
  }

  if (!isAuthenticated) {
    return <Outlet />
  }
  return (
    <>
      {/* No background here on purpose: the page colour lives on <html> so the
          paper texture (a z-index:-1 pseudo-element) is not painted over.
          ConfirmProvider sits outside every page modal's tree (STU-410), and the
          toast outlasts a move between pages. */}
      <ConfirmProvider>
        <ToastProvider>
          {user && <OutboxHost key={user.id} userId={user.id} />}
          <div className="min-h-screen" data-app-shell>
            <Navigation />
            {/* below-nav clears the fixed top nav including its status-bar inset: a flat pt-20
                leaves 16px of slack over the 64px bar, which the ~59px inset on a notched phone
                in standalone mode swallows. pb-20 sm:pb-8 clears the fixed bottom tab bar; --toast-room
                 (Toast.tsx, STU-629) lifts the bottom padding over the toast stack. */}
            <main id="main-content" tabIndex={-1} className="below-nav pb-[max(5rem,var(--toast-room,0px))] sm:pb-[max(2rem,var(--toast-room,0px))]">
              <div className="fade-in">
                <Outlet />
              </div>
            </main>
            <BottomNav />
            {showOnboarding && (
              <OnboardingFlow
                onComplete={() => {
                  setShowOnboarding(false)
                  // Refresh user data to get updated onboarding_completed status
                  window.location.reload()
                }}
                onSkip={() => {
                  setShowOnboarding(false)
                  // Refresh user data to get updated onboarding_completed status
                  window.location.reload()
                }}
              />
            )}
          </div>
        </ToastProvider>
      </ConfirmProvider>
    </>
  )
}
