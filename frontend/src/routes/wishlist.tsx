import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useEffect } from 'react'
import { useAuth } from '../contexts/AuthContext'
import { WishlistPanel } from '../components/WishlistPanel'

export const Route = createFileRoute('/wishlist')({
  component: WishlistPage,
})

function WishlistPage() {
  const { isAuthenticated, isLoading: authLoading } = useAuth()
  const navigate = useNavigate()

  useEffect(() => {
    if (!authLoading && !isAuthenticated) navigate({ to: '/login', search: { message: undefined } })
  }, [authLoading, isAuthenticated, navigate])

  if (!isAuthenticated) return null

  return (
    <div className="max-w-7xl mx-auto px-3 py-6 sm:px-4 lg:px-6">
      <WishlistPanel />
    </div>
  )
}
