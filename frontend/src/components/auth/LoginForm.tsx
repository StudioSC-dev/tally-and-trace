import React, { useState, useEffect } from 'react'
import { useAuth } from '../../contexts/AuthContext'
import { Link, useNavigate } from '@tanstack/react-router'
import { useResendVerificationMutation } from '../../store/authApi'

type ApiErrorPayload = {
  data?: {
    detail?: string
  }
  message?: string
}

interface LoginFormProps {
  onSuccess?: () => void
  successMessage?: string
}

export const LoginForm: React.FC<LoginFormProps> = ({ onSuccess, successMessage }) => {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState('')
  const [resendMessage, setResendMessage] = useState('')
  const [resendLoading, setResendLoading] = useState(false)
  const [showSuccessMessage, setShowSuccessMessage] = useState(!!successMessage)
  const navigate = useNavigate()

  const { login } = useAuth()
  const [resendVerification] = useResendVerificationMutation()

  // Clear success message from URL after it's shown
  useEffect(() => {
    if (successMessage) {
      // Clear the message from URL after a short delay or when user interacts
      const timer = setTimeout(() => {
        navigate({ 
          to: '/login',
          search: {} // Clear search params
        })
      }, 5000) // Auto-hide after 5 seconds

      return () => clearTimeout(timer)
    }
  }, [successMessage, navigate])

  // Clear success message when user starts typing or submitting
  const handleEmailChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setEmail(e.target.value)
    if (showSuccessMessage) {
      setShowSuccessMessage(false)
      navigate({ 
        to: '/login',
        search: {} // Clear search params
      })
    }
  }

  const handlePasswordChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setPassword(e.target.value)
    if (showSuccessMessage) {
      setShowSuccessMessage(false)
      navigate({ 
        to: '/login',
        search: {} // Clear search params
      })
    }
  }

  const handleDemoLogin = async () => {
    setIsLoading(true)
    setError('')
    try {
      await login('demo@example.com', 'password123')
      onSuccess?.()
    } catch (err: unknown) {
      if (typeof err === 'object' && err !== null) {
        const apiError = err as ApiErrorPayload
        const detail = apiError.data?.detail || apiError.message
        if (detail) { setError(detail); return }
      }
      setError('Demo login failed. Please try again.')
    } finally {
      setIsLoading(false)
    }
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setIsLoading(true)
    setError('')
    setShowSuccessMessage(false) // Clear success message on submit
    navigate({ 
      to: '/login',
      search: {} // Clear search params
    })

    try {
      await login(email, password)
      onSuccess?.()
    } catch (err: unknown) {
      if (typeof err === 'object' && err !== null) {
        const apiError = err as ApiErrorPayload
        const detail = apiError.data?.detail || apiError.message
        if (detail) {
          setError(detail)
          return
        }
      }
      if (err instanceof Error && err.message) {
        setError(err.message)
        return
      }
      setError('Login failed. Please try again.')
    } finally {
      setIsLoading(false)
    }
  }

  const handleResendVerification = async () => {
    if (!email.trim()) {
      setResendMessage('Please enter your email address first.')
      return
    }
    
    setResendLoading(true)
    setResendMessage('')
    try {
      const result = await resendVerification({ email: email.trim() }).unwrap()
      setResendMessage(result.message || 'Verification email sent! Please check your inbox.')
      setError('') // Clear error message
    } catch (err: unknown) {
      if (typeof err === 'object' && err !== null) {
        const apiError = err as ApiErrorPayload
        const detail = apiError.data?.detail || apiError.message
        setResendMessage(detail || 'Failed to send verification email. Please try again.')
      } else {
        setResendMessage('Failed to send verification email. Please try again.')
      }
    } finally {
      setResendLoading(false)
    }
  }

  const isEmailNotVerified = error === 'Email not verified'

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50 dark:bg-slate-950 py-12 px-4 sm:px-6 lg:px-8">
      <div className="max-w-md w-full space-y-8">
        <div>
          <div className="mx-auto h-16 w-16 flex items-center justify-center rounded-2xl bg-gradient-to-br from-blue-500 to-blue-600 shadow-lg">
            <svg className="h-8 w-8 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
            </svg>
          </div>
          <h1 className="mt-4 text-center text-2xl font-bold text-gray-900 dark:text-white tracking-tight">
            Tally &amp; Trace
          </h1>
          <h2 className="mt-1 text-center text-sm font-medium text-gray-500 dark:text-slate-400">
            Sign in to your account
          </h2>
          <p className="mt-2 text-center text-sm text-gray-600 dark:text-slate-400">
            Or{' '}
            <Link to="/register" className="font-medium text-blue-600 dark:text-blue-400 hover:text-blue-500 dark:hover:text-blue-300">
              create a new account
            </Link>
          </p>
        </div>

        <div className="bg-white dark:bg-slate-900/50 rounded-2xl border border-gray-200 dark:border-slate-800 p-8 shadow-sm">
          <form className="space-y-5" onSubmit={handleSubmit}>
            {showSuccessMessage && successMessage && (
              <div className="rounded-lg bg-emerald-50 dark:bg-emerald-500/10 border border-emerald-200 dark:border-emerald-500/20 p-4">
                <div className="flex">
                  <svg className="h-5 w-5 text-emerald-500 dark:text-emerald-400 flex-shrink-0" viewBox="0 0 20 20" fill="currentColor">
                    <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clipRule="evenodd" />
                  </svg>
                  <div className="ml-3">
                    <p className="text-sm text-emerald-700 dark:text-emerald-400">{successMessage}</p>
                  </div>
                </div>
              </div>
            )}
            {error && (
              <div className="rounded-lg bg-red-50 dark:bg-red-500/10 border border-red-200 dark:border-red-500/20 p-4">
                <div className="flex">
                  <svg className="h-5 w-5 text-red-500 dark:text-red-400 flex-shrink-0" viewBox="0 0 20 20" fill="currentColor">
                    <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM8.707 7.293a1 1 0 00-1.414 1.414L8.586 10l-1.293 1.293a1 1 0 101.414 1.414L10 11.414l1.293 1.293a1 1 0 001.414-1.414L11.414 10l1.293-1.293a1 1 0 00-1.414-1.414L10 8.586 8.707 7.293z" clipRule="evenodd" />
                  </svg>
                  <div className="ml-3 flex-1">
                    <p className="text-sm text-red-700 dark:text-red-400">{error}</p>
                    {isEmailNotVerified && (
                      <button
                        type="button"
                        onClick={handleResendVerification}
                        disabled={resendLoading}
                        className="mt-2 text-sm font-medium text-red-700 dark:text-red-400 hover:text-red-800 dark:hover:text-red-300 underline disabled:opacity-50 disabled:cursor-not-allowed"
                      >
                        {resendLoading ? 'Sending...' : 'Resend verification email'}
                      </button>
                    )}
                  </div>
                </div>
              </div>
            )}
            {resendMessage && !isEmailNotVerified && (
              <div className={`rounded-lg p-4 border ${
                resendMessage.includes('sent') || resendMessage.includes('already verified')
                  ? 'bg-emerald-50 dark:bg-emerald-500/10 border-emerald-200 dark:border-emerald-500/20'
                  : 'bg-yellow-50 dark:bg-yellow-500/10 border-yellow-200 dark:border-yellow-500/20'
              }`}>
                <p className={`text-sm ${
                  resendMessage.includes('sent') || resendMessage.includes('already verified')
                    ? 'text-emerald-700 dark:text-emerald-400'
                    : 'text-yellow-700 dark:text-yellow-400'
                }`}>
                  {resendMessage}
                </p>
              </div>
            )}

            <div>
              <label htmlFor="email" className="block text-sm font-medium text-gray-700 dark:text-slate-300 mb-1.5">
                Email address
              </label>
              <input
                id="email"
                name="email"
                type="email"
                autoComplete="email"
                required
                className="w-full px-3 py-2.5 border border-gray-300 dark:border-slate-600 rounded-lg bg-white dark:bg-slate-800 text-gray-900 dark:text-slate-100 placeholder-gray-400 dark:placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500 transition-colors duration-200 text-sm"
                placeholder="you@example.com"
                value={email}
                onChange={handleEmailChange}
              />
            </div>

            <div>
              <label htmlFor="password" className="block text-sm font-medium text-gray-700 dark:text-slate-300 mb-1.5">
                Password
              </label>
              <input
                id="password"
                name="password"
                type="password"
                autoComplete="current-password"
                required
                className="w-full px-3 py-2.5 border border-gray-300 dark:border-slate-600 rounded-lg bg-white dark:bg-slate-800 text-gray-900 dark:text-slate-100 placeholder-gray-400 dark:placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500 transition-colors duration-200 text-sm"
                placeholder="Your password"
                value={password}
                onChange={handlePasswordChange}
              />
            </div>

            <div className="flex items-center justify-between">
              <div className="flex items-center">
                <input
                  id="remember-me"
                  name="remember-me"
                  type="checkbox"
                  className="h-4 w-4 text-blue-600 focus:ring-blue-500 border-gray-300 dark:border-slate-600 rounded"
                />
                <label htmlFor="remember-me" className="ml-2 block text-sm text-gray-700 dark:text-slate-300">
                  Remember me
                </label>
              </div>
              <div className="text-sm">
                <a href="#" className="font-medium text-blue-600 dark:text-blue-400 hover:text-blue-500 dark:hover:text-blue-300">
                  Forgot password?
                </a>
              </div>
            </div>

            <button
              type="submit"
              disabled={isLoading}
              className="w-full flex justify-center py-2.5 px-4 border border-transparent text-sm font-semibold rounded-lg text-white bg-blue-500 hover:bg-blue-600 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500 dark:focus:ring-offset-slate-900 disabled:opacity-50 disabled:cursor-not-allowed transition-all duration-200 shadow-sm"
            >
              {isLoading ? (
                <div className="flex items-center">
                  <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-white mr-2"></div>
                  Signing in...
                </div>
              ) : (
                'Sign in'
              )}
            </button>
          </form>

          {/* Demo account quick access */}
          <div className="mt-6">
            <div className="relative">
              <div className="absolute inset-0 flex items-center">
                <div className="w-full border-t border-gray-200 dark:border-slate-700" />
              </div>
              <div className="relative flex justify-center text-xs">
                <span className="px-3 bg-white dark:bg-slate-900/50 text-gray-500 dark:text-slate-500">
                  or jump in quickly
                </span>
              </div>
            </div>

            <div className="mt-4">
              <p className="text-center text-xs text-gray-500 dark:text-slate-500 mb-3">
                Explore with pre-loaded demo data
              </p>
              <button
                type="button"
                onClick={handleDemoLogin}
                disabled={isLoading}
                className="w-full flex items-center justify-center gap-2 py-2.5 px-4 border-2 border-dashed border-blue-300 dark:border-blue-500/40 rounded-lg text-sm font-medium text-blue-700 dark:text-blue-400 bg-blue-50 dark:bg-blue-500/10 hover:bg-blue-100 dark:hover:bg-blue-500/20 hover:border-blue-400 dark:hover:border-blue-400 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500 dark:focus:ring-offset-slate-900 disabled:opacity-50 disabled:cursor-not-allowed transition-all duration-200"
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
                </svg>
                Sign in as Demo User
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
