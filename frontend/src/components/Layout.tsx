import { Outlet } from '@tanstack/react-router'
import { Navigation } from './Navigation'
import { BottomNav } from './BottomNav'
import { useAuth } from '../contexts/AuthContext'

export function Layout() {
  console.log('Layout component rendering...')
  const { isAuthenticated, isLoading } = useAuth()

  console.log('Layout: Auth state:', { isAuthenticated, isLoading })

  if (isLoading) {
    console.log('Layout: Showing loading spinner')
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50 dark:bg-slate-950">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-500"></div>
      </div>
    )
  }

  if (!isAuthenticated) {
    console.log('Layout: Not authenticated, showing Outlet (login/register)')
    return <Outlet />
  }

  console.log('Layout: Authenticated, showing full layout with navigation')
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
    </div>
  )
}
