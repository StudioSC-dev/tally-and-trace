import { Outlet } from '@tanstack/react-router'
import { Navigation } from './Navigation'
import { BottomNav } from './BottomNav'
import { useAuth } from '../contexts/AuthContext'
import { OnboardingFlow } from './onboarding/OnboardingFlow'
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
    return (
      <div className="flex min-h-screen items-center justify-center">
        <div className="loading-spinner" />
      </div>
    )
  }

  if (!isAuthenticated) {
    return <Outlet />
  }
  return (
    // No background here on purpose: the page colour lives on <html> so the
    // paper texture (a z-index:-1 pseudo-element) is not painted over.
    <div className="min-h-screen">
      <Navigation />
      {/* pt-20 clears the fixed top nav; pb-20 sm:pb-8 clears the fixed bottom tab bar on mobile */}
      <main className="pt-20 pb-20 sm:pb-8">
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
  )
}
