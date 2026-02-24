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
      <div className="min-h-screen flex items-center justify-center bg-gray-50 dark:bg-slate-950">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-500"></div>
      </div>
    )
  }

  if (!isAuthenticated) {
    return <Outlet />
  }
  return (
    <div className="min-h-screen bg-gray-50 dark:bg-slate-950">
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
