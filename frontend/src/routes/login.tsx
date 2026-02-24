import { createFileRoute, useNavigate, useSearch } from '@tanstack/react-router'
import { LoginForm } from '../components/auth/LoginForm'
import { useAuth } from '../contexts/AuthContext'
import { useEffect } from 'react'

export const Route = createFileRoute('/login')({
  component: LoginPage,
  validateSearch: (search: Record<string, unknown>) => {
    return {
      message: (search.message as string) || undefined,
    }
  },
})

export function LoginPage() {
  const { isAuthenticated, isLoading: authLoading } = useAuth()
  const navigate = useNavigate()
  const { message } = useSearch({ from: '/login' })

  useEffect(() => {
    if (!authLoading && isAuthenticated) {
      navigate({ to: '/' })
    }
  }, [isAuthenticated, authLoading, navigate])

  const handleSuccess = () => {
    navigate({ to: '/' })
  }

  if (authLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600"></div>
      </div>
    )
  }

  if (isAuthenticated) {
    return null // Will redirect
  }

  return <LoginForm onSuccess={handleSuccess} successMessage={message} />
}
