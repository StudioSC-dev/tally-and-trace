import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { SignupForm } from '../components/auth/SignupForm'
import { useAuth } from '../contexts/AuthContext'
import { useEffect } from 'react'

export const Route = createFileRoute('/register')({
  component: RegisterPage,
})

export function RegisterPage() {
  const { isAuthenticated, isLoading: authLoading } = useAuth()
  const navigate = useNavigate()

  useEffect(() => {
    if (!authLoading && isAuthenticated) {
      navigate({ to: '/' })
    }
  }, [isAuthenticated, authLoading, navigate])

  const handleSuccess = () => {
    // Redirect to login page with message about email verification
    navigate({ 
      to: '/login',
      search: { message: 'Registration successful! Please check your email to verify your account before logging in.' }
    })
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

  return <SignupForm onSuccess={handleSuccess} />
}
