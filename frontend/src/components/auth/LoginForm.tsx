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
          search: { message: undefined } // Clear search params
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
        search: { message: undefined } // Clear search params
      })
    }
  }

  const handlePasswordChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setPassword(e.target.value)
    if (showSuccessMessage) {
      setShowSuccessMessage(false)
      navigate({ 
        to: '/login',
        search: { message: undefined } // Clear search params
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
      search: { message: undefined } // Clear search params
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
    <div className="flex min-h-screen items-center justify-center px-4 py-12 sm:px-6 lg:px-8">
      <div className="w-full max-w-md">
        {/* Left-aligned: a centred masthead over left-aligned form copy was part
            of what made every screen read the same. */}
        <header className="mb-8">
          <p className="label mb-3">Tally &amp; Trace</p>
          <h1 className="font-serif text-4xl leading-[1.05] text-ink">
            Sign in
          </h1>
          <p className="mt-3 text-sm text-body">
            Or{' '}
            <Link
              to="/register"
              className="text-ink underline decoration-line-strong underline-offset-4 hover:decoration-ink"
            >
              create a new account
            </Link>
          </p>
        </header>

        <div className="border border-line bg-surface p-8">
          <form className="space-y-5" onSubmit={handleSubmit}>
            {/* Alerts are a coloured rule plus text, not a tinted fill panel —
                the bg-*-500/10 blocks glowed and outweighed the form itself. */}
            {showSuccessMessage && successMessage && (
              <div className="border-l-2 border-ok py-1 pl-4">
                <p className="text-sm text-body">{successMessage}</p>
              </div>
            )}
            {error && (
              <div className="border-l-2 border-danger py-1 pl-4">
                <p className="text-sm text-danger">{error}</p>
                {isEmailNotVerified && (
                  <button
                    type="button"
                    onClick={handleResendVerification}
                    disabled={resendLoading}
                    className="mt-2 text-sm text-ink underline decoration-line-strong underline-offset-4 hover:decoration-ink disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {resendLoading ? 'Sending...' : 'Resend verification email'}
                  </button>
                )}
              </div>
            )}
            {resendMessage && !isEmailNotVerified && (
              <div
                className={`border-l-2 py-1 pl-4 ${ resendMessage.includes('sent') || resendMessage.includes('already verified') ? 'border-ok' : 'border-warn' }`}
              >
                <p className="text-sm text-body">{resendMessage}</p>
              </div>
            )}

            <div>
              <label htmlFor="email" className="label mb-1">
                Email address
              </label>
              <input
                id="email"
                name="email"
                type="email"
                autoComplete="email"
                required
                className="input-field text-sm"
                placeholder="you@example.com"
                value={email}
                onChange={handleEmailChange}
              />
            </div>

            <div>
              <label htmlFor="password" className="label mb-1">
                Password
              </label>
              <input
                id="password"
                name="password"
                type="password"
                autoComplete="current-password"
                required
                className="input-field text-sm"
                placeholder="Your password"
                value={password}
                onChange={handlePasswordChange}
              />
            </div>

            <div className="flex items-center justify-between pt-2">
              <div className="flex items-center">
                <input
                  id="remember-me"
                  name="remember-me"
                  type="checkbox"
                  className="h-3.5 w-3.5 accent-ink"
                />
                <label htmlFor="remember-me" className="ml-2 block text-sm text-body">
                  Remember me
                </label>
              </div>
              <div className="text-sm">
                <a
                  href="#"
                  className="text-muted underline decoration-line-strong underline-offset-4 hover:text-ink hover:decoration-ink"
                >
                  Forgot password?
                </a>
              </div>
            </div>

            <button
              type="submit"
              disabled={isLoading}
              className="btn-primary w-full disabled:cursor-not-allowed disabled:opacity-50"
            >
              {isLoading ? (
                <>
                  <span className="h-3.5 w-3.5 animate-spin rounded-full border border-current border-t-transparent" />
                  Signing in...
                </>
              ) : (
                'Sign in'
              )}
            </button>
          </form>

          {/* Demo account quick access */}
          <div className="mt-8 border-t border-line pt-6">
            <p className="label mb-1">Or jump in quickly</p>
            <p className="mb-4 text-sm text-body">
              Explore with pre-loaded demo data.
            </p>
            <button
              type="button"
              onClick={handleDemoLogin}
              disabled={isLoading}
              className="btn-secondary w-full disabled:cursor-not-allowed disabled:opacity-50"
            >
              Sign in as Demo User
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
