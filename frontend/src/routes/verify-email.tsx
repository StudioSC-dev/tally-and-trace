import { createFileRoute, useNavigate, useSearch } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import { useVerifyEmailMutation } from '../store/authApi'
import { PageLoader } from '../components/Loading'
import { apiErrorMessage } from '../utils/apiError'
import { Button } from '../components/Button'
import { Icon } from '../components/Icon'

export const Route = createFileRoute('/verify-email')({
  component: VerifyEmailPage,
  validateSearch: (search: Record<string, unknown>): { token?: string } => {
    return {
      token: (search.token as string) || undefined,
    }
  },
})

export function VerifyEmailPage() {
  const navigate = useNavigate()
  const { token } = useSearch({ from: '/verify-email' })
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
      setErrorMessage(apiErrorMessage(error) || 'Verification failed. Please try again.')
    }
  }, [isError, error])

  if (isLoading) {
    return <PageLoader label="Verifying your email..." className="bg-paper" />
  }

  if (isError) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-paper px-4">
        <div className="max-w-md w-full bg-surface p-6 text-center">
          <div className="w-16 h-16 rounded-full flex items-center justify-center mx-auto mb-4 text-danger">
            <Icon name="error" />
          </div>
          <h2 className="text-xl font-semibold text-ink mb-2">Verification Failed</h2>
          <p className="text-body mb-6">{errorMessage}</p>
          <Button
            variant="primary"
            onClick={() => navigate({ to: '/login', search: { message: undefined } })}
            className="w-full min-h-10 py-1.5 text-base"
          >
            Go to Login
          </Button>
        </div>
      </div>
    )
  }

  if (isSuccess) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-paper px-4">
        <div className="max-w-md w-full bg-surface p-6 text-center">
          <div className="w-16 h-16 rounded-full flex items-center justify-center mx-auto mb-4 text-ok">
            <Icon name="success" />
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
          <Button
            variant="primary"
            onClick={() => navigate({ to: '/' })}
            className="w-full min-h-10 py-1.5 text-base"
          >
            Continue Now
          </Button>
        </div>
      </div>
    )
  }

  return null
}
