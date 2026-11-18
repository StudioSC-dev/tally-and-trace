import { Spinner } from '../Loading'
import React, { useState } from 'react'
import { useAuth } from '../../contexts/AuthContext'
import { Link } from '@tanstack/react-router'
import { Button } from '../Button'
import { Icon } from '../Icon'

type ValidationError = {
  type: string
  loc: (string | number)[]
  msg: string
  input: unknown
  ctx?: Record<string, unknown>
}

type ApiErrorPayload = {
  data?: {
    detail?: string | ValidationError[]
  }
  message?: string
}

interface SignupFormProps {
  onSuccess?: () => void
}

const CURRENCIES = [
  { value: 'PHP', label: 'Philippine Peso (PHP)' },
  { value: 'USD', label: 'US Dollar (USD)' },
  { value: 'EUR', label: 'Euro (EUR)' },
  { value: 'GBP', label: 'British Pound (GBP)' },
  { value: 'JPY', label: 'Japanese Yen (JPY)' },
  { value: 'AUD', label: 'Australian Dollar (AUD)' },
  { value: 'CAD', label: 'Canadian Dollar (CAD)' },
  { value: 'CHF', label: 'Swiss Franc (CHF)' },
  { value: 'CNY', label: 'Chinese Yuan (CNY)' },
  { value: 'SGD', label: 'Singapore Dollar (SGD)' },
]

export const SignupForm: React.FC<SignupFormProps> = ({ onSuccess }) => {
  const [formData, setFormData] = useState({
    email: '',
    password: '',
    confirmPassword: '',
    firstName: '',
    lastName: '',
    defaultCurrency: 'PHP'
  })
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [showConfirmPassword, setShowConfirmPassword] = useState(false)

  const { register } = useAuth()
  
  // Password validation
  const passwordRequirements = {
    minLength: formData.password.length >= 8,
    hasUpperCase: /[A-Z]/.test(formData.password),
    hasLowerCase: /[a-z]/.test(formData.password),
    hasNumber: /\d/.test(formData.password),
    hasSpecialChar: /[!@#$%^&*()._+\-=]/.test(formData.password),
  }
  
  const isPasswordValid = Object.values(passwordRequirements).every(Boolean)

  const handleChange = (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
    const { name, value } = e.target
    setFormData(prev => ({
      ...prev,
      [name]: value
    }))
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setIsLoading(true)
    setError('')

    if (!isPasswordValid) {
      setError('Password does not meet all requirements')
      setIsLoading(false)
      return
    }

    if (formData.password !== formData.confirmPassword) {
      setError('Passwords do not match')
      setIsLoading(false)
      return
    }

    try {
      await register({
        email: formData.email,
        password: formData.password,
        first_name: formData.firstName,
        last_name: formData.lastName,
        default_currency: formData.defaultCurrency
      })
      onSuccess?.()
    } catch (err: unknown) {
      let errorMessage = 'Registration failed. Please try again.'
      
      if (typeof err === 'object' && err !== null) {
        const apiError = err as ApiErrorPayload
        const detail = apiError.data?.detail
        
        if (detail) {
          // Handle Pydantic validation errors (array of error objects)
          if (Array.isArray(detail)) {
            errorMessage = detail.map((error: ValidationError) => error.msg).join('; ')
          } 
          // Handle simple string error
          else if (typeof detail === 'string') {
            errorMessage = detail
          }
        } else if (apiError.message) {
          errorMessage = apiError.message
        }
      } else if (err instanceof Error && err.message) {
        errorMessage = err.message
      }
      
      setError(errorMessage)
      setIsLoading(false)
    } finally {
      setIsLoading(false)
    }
  }

  const inputClass = "w-full px-3 py-2.5 border border-line  bg-surface text-ink placeholder:text-muted  focus:outline-none   focus:border-ink transition-colors duration-200 text-sm"
  const labelClass = "block text-sm font-medium text-body mb-1.5"

  return (
    <div className="min-h-screen flex items-center justify-center bg-paper py-12 px-4 sm:px-6 lg:px-8">
      <div className="max-w-md w-full space-y-8">
        <div>
          <div className="mx-auto h-16 w-16 flex items-center justify-center text-paper">
            <Icon name="sign-up" />
          </div>
          <h1 className="mt-4 text-center text-2xl font-bold text-ink tracking-tight">
            Tally &amp; Trace
          </h1>
          <h2 className="mt-1 text-center text-sm font-medium text-muted">
            Create your account
          </h2>
          <p className="mt-2 text-center text-sm text-body">
            Or{' '}
            <Link to="/login" search={{ message: undefined }} className="font-medium text-ink hover:text-ink">
              sign in to your existing account
            </Link>
          </p>
        </div>

        <div className="bg-surface border border-line p-8">
          <form className="space-y-5" onSubmit={handleSubmit}>
            {error && (
              <div className="border border-line p-4">
                <div className="flex text-danger">
                  <Icon name="error" />
                  <div className="ml-3">
                    <p className="text-sm text-danger">{error}</p>
                  </div>
                </div>
              </div>
            )}

            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div>
                <label htmlFor="firstName" className={labelClass}>First name</label>
                <input
                  id="firstName"
                  name="firstName"
                  type="text"
                  required
                  className={inputClass}
                  placeholder="John"
                  value={formData.firstName}
                  onChange={handleChange}
                />
              </div>
              <div>
                <label htmlFor="lastName" className={labelClass}>Last name</label>
                <input
                  id="lastName"
                  name="lastName"
                  type="text"
                  required
                  className={inputClass}
                  placeholder="Doe"
                  value={formData.lastName}
                  onChange={handleChange}
                />
              </div>
            </div>

            <div>
              <label htmlFor="email" className={labelClass}>Email address</label>
              <input
                id="email"
                name="email"
                type="email"
                autoComplete="email"
                required
                className={inputClass}
                placeholder="john@example.com"
                value={formData.email}
                onChange={handleChange}
              />
            </div>

            <div>
              <label htmlFor="defaultCurrency" className={labelClass}>Default currency</label>
              <select
                id="defaultCurrency"
                name="defaultCurrency"
                className="w-full px-3 py-2.5 border border-line bg-surface text-ink focus:outline-none focus:border-ink transition-colors duration-200 text-sm"
                value={formData.defaultCurrency}
                onChange={handleChange}
              >
                {CURRENCIES.map((currency) => (
                  <option key={currency.value} value={currency.value}>
                    {currency.label}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label htmlFor="password" className={labelClass}>Password</label>
              <div className="relative">
                <input
                  id="password"
                  name="password"
                  type={showPassword ? "text" : "password"}
                  autoComplete="new-password"
                  required
                  className={`${inputClass} pr-10`}
                  placeholder="Enter a strong password"
                  value={formData.password}
                  onChange={handleChange}
                />
                <button
                  type="button"
                  onClick={() => setShowPassword(!showPassword)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-muted hover:text-body focus:outline-none"
                  aria-label={showPassword ? "Hide password" : "Show password"}
                >
                  <Icon name={showPassword ? 'hide' : 'show'} />
                </button>
              </div>
              {formData.password && (
                <div className="mt-2 space-y-1">
                  <p className="text-xs text-body font-medium">Password requirements:</p>
                  <ul className="text-xs space-y-1">
                    <li className={`flex items-center ${passwordRequirements.minLength ? 'text-ok' : 'text-muted'}`}>
                      <span className="mr-2 inline-flex"><Icon name={passwordRequirements.minLength ? 'check' : 'requirement-unmet'} /></span>
                      At least 8 characters
                    </li>
                    <li className={`flex items-center ${passwordRequirements.hasUpperCase ? 'text-ok' : 'text-muted'}`}>
                      <span className="mr-2 inline-flex"><Icon name={passwordRequirements.hasUpperCase ? 'check' : 'requirement-unmet'} /></span>
                      One uppercase letter
                    </li>
                    <li className={`flex items-center ${passwordRequirements.hasLowerCase ? 'text-ok' : 'text-muted'}`}>
                      <span className="mr-2 inline-flex"><Icon name={passwordRequirements.hasLowerCase ? 'check' : 'requirement-unmet'} /></span>
                      One lowercase letter
                    </li>
                    <li className={`flex items-center ${passwordRequirements.hasNumber ? 'text-ok' : 'text-muted'}`}>
                      <span className="mr-2 inline-flex"><Icon name={passwordRequirements.hasNumber ? 'check' : 'requirement-unmet'} /></span>
                      One number
                    </li>
                    <li className={`flex items-center ${passwordRequirements.hasSpecialChar ? 'text-ok' : 'text-muted'}`}>
                      <span className="mr-2 inline-flex"><Icon name={passwordRequirements.hasSpecialChar ? 'check' : 'requirement-unmet'} /></span>
                      One special character (!@#$%^&*().-_+=)
                    </li>
                  </ul>
                </div>
              )}
            </div>

            <div>
              <label htmlFor="confirmPassword" className={labelClass}>Confirm password</label>
              <div className="relative">
                <input
                  id="confirmPassword"
                  name="confirmPassword"
                  type={showConfirmPassword ? "text" : "password"}
                  autoComplete="new-password"
                  required
                  className={`${inputClass} pr-10`}
                  placeholder="Confirm your password"
                  value={formData.confirmPassword}
                  onChange={handleChange}
                />
                <button
                  type="button"
                  onClick={() => setShowConfirmPassword(!showConfirmPassword)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-muted hover:text-body focus:outline-none"
                  aria-label={showConfirmPassword ? "Hide password" : "Show password"}
                >
                  <Icon name={showConfirmPassword ? 'hide' : 'show'} />
                </button>
              </div>
              {formData.confirmPassword && formData.password !== formData.confirmPassword && (
                <p className="mt-1 text-xs text-danger">Passwords do not match</p>
              )}
            </div>

            <Button
              variant="primary"
              type="submit"
              disabled={isLoading}
              className="w-full flex py-2.5"
            >
              {isLoading ? (
                <div className="flex items-center">
                  <Spinner size="xs" tone="current" className="mr-2" />
                  Creating account...
                </div>
              ) : (
                'Create account'
              )}
            </Button>
          </form>
        </div>
      </div>
    </div>
  )
}
