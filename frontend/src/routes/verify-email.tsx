import { createFileRoute, useNavigate, useSearch } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import { useVerifyEmailMutation } from '../store/authApi'

export const Route = createFileRoute('/verify-email' as any)({
  component: VerifyEmailPage,
  validateSearch: (search: Record<string, unknown>): { token?: string } => {
    return {
      token: (search.token as string) || undefined,
    }
  },
})

export function VerifyEmailPage() {
  const navigate = useNavigate()
  const { token } = useSearch({ from: Route.fullPath as any })
  const [verifyEmail, { isLoading, isSuccess, isError, error }] = useVerifyEmailMutation()
  const [countdown, setCountdown] = useState(5)
  const [errorMessage, setErrorMessage] = useState<string>('')

  useEffect(() => {
    if (!token) {
      setErrorMessage('No verification token provided.')
      return
    }

    verifyEmail({ token })
  }, [token, verifyEmail])

  useEffect(() => {
    if (isSuccess && countdown > 0) {
      const timer = setTimeout(() => {
        setCountdown(countdown - 1)
      }, 1000)
      return () => clearTimeout(timer)
    } else if (isSuccess && countdown === 0) {
      // Navigate to onboarding or dashboard
      navigate({ to: '/' })
    }
  }, [isSuccess, countdown, navigate])

  useEffect(() => {
    if (isError && error) {
      if ('data' in error && error.data && typeof error.data === 'object') {
        const errorData = error.data as { detail?: string }
        setErrorMessage(errorData.detail || 'Verification failed. Please try again.')
      } else {
        setErrorMessage('Verification failed. Please try again.')
      }
    }
  }, [isError, error])

  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-paper">
        <div className="text-center">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-ink mx-auto mb-4"></div>
          <p className="text-body">Verifying your email...</p>
        </div>
      </div>
    )
  }

  if (isError) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-paper px-4">
        <div className="max-w-md w-full bg-surface p-6 text-center">
          <div className="w-16 h-16 rounded-full flex items-center justify-center mx-auto mb-4">
            <svg className="w-8 h-8 text-danger" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </div>
          <h2 className="text-xl font-semibold text-ink mb-2">Verification Failed</h2>
          <p className="text-body mb-6">{errorMessage}</p>
          <button
            onClick={() => navigate({ to: '/login', search: { message: undefined } })}
            className="w-full px-4 py-2 bg-ink text-paper hover:bg-ink transition-colors duration-200"
          >
            Go to Login
          </button>
        </div>
      </div>
    )
  }

  if (isSuccess) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-paper px-4">
        <div className="max-w-md w-full bg-surface p-6 text-center">
          <div className="w-16 h-16 rounded-full flex items-center justify-center mx-auto mb-4">
            <svg className="w-8 h-8 text-ok" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
            </svg>
          </div>
          <h2 className="text-xl font-semibold text-ink mb-2">Email Verified!</h2>
          <p className="text-body mb-6">
            Your email has been successfully verified. Starting your onboarding in {countdown} second{countdown !== 1 ? 's' : ''}...
          </p>
          <div className="w-full bg-sunken rounded-full h-2 mb-4">
            <div
              className="bg-ink h-2 rounded-full transition-all duration-1000"
              style={{ width: `${((5 - countdown) / 5) * 100}%` }}
            ></div>
          </div>
          <button
            onClick={() => navigate({ to: '/' })}
            className="w-full px-4 py-2 bg-ink text-paper hover:bg-ink transition-colors duration-200"
          >
            Continue Now
          </button>
        </div>
      </div>
    )
  }

  return null
}
