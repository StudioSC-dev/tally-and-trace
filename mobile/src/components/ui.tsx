/**
 * Reusable UI primitives for the mobile app.
 * All styled with NativeWind (Tailwind CSS for React Native).
 */
import React from 'react'
import {
  View,
  Text,
  TouchableOpacity,
  ActivityIndicator,
  TextInput,
  type ViewProps,
  type TextProps,
  type TouchableOpacityProps,
  type TextInputProps,
} from 'react-native'

// ─── Card ─────────────────────────────────────────────────────────────────────

export const Card: React.FC<ViewProps & { className?: string }> = ({
  children,
  className = '',
  ...props
}) => (
  <View
    className={`bg-slate-800 rounded-2xl p-4 ${className}`}
    {...props}
  >
    {children}
  </View>
)

// ─── Button ───────────────────────────────────────────────────────────────────

interface ButtonProps extends TouchableOpacityProps {
  variant?: 'primary' | 'secondary' | 'destructive' | 'ghost'
  size?: 'sm' | 'md' | 'lg'
  loading?: boolean
  label: string
  className?: string
}

const buttonVariants: Record<string, string> = {
  primary: 'bg-sky-500 active:bg-sky-600',
  secondary: 'bg-slate-700 active:bg-slate-600',
  destructive: 'bg-red-500 active:bg-red-600',
  ghost: 'bg-transparent border border-slate-600 active:bg-slate-800',
}

const buttonTextVariants: Record<string, string> = {
  primary: 'text-white',
  secondary: 'text-slate-100',
  destructive: 'text-white',
  ghost: 'text-slate-300',
}

const buttonSizes: Record<string, string> = {
  sm: 'py-2 px-3',
  md: 'py-3 px-4',
  lg: 'py-4 px-6',
}

const buttonTextSizes: Record<string, string> = {
  sm: 'text-sm',
  md: 'text-base',
  lg: 'text-lg',
}

export const Button: React.FC<ButtonProps> = ({
  variant = 'primary',
  size = 'md',
  loading = false,
  label,
  disabled,
  className = '',
  ...props
}) => (
  <TouchableOpacity
    className={`rounded-xl items-center justify-center flex-row gap-2 ${buttonVariants[variant]} ${buttonSizes[size]} ${disabled || loading ? 'opacity-50' : ''} ${className}`}
    disabled={disabled || loading}
    {...props}
  >
    {loading && <ActivityIndicator size="small" color="#fff" />}
    <Text className={`font-semibold ${buttonTextVariants[variant]} ${buttonTextSizes[size]}`}>
      {label}
    </Text>
  </TouchableOpacity>
)

// ─── Input ────────────────────────────────────────────────────────────────────

interface InputProps extends TextInputProps {
  label?: string
  error?: string
  className?: string
}

export const Input: React.FC<InputProps> = ({ label, error, className = '', ...props }) => (
  <View className="gap-1">
    {label && <Text className="text-slate-400 text-sm font-medium">{label}</Text>}
    <TextInput
      className={`bg-slate-800 border ${error ? 'border-red-500' : 'border-slate-700'} rounded-xl px-4 py-3 text-white placeholder:text-slate-500 ${className}`}
      placeholderTextColor="#64748b"
      {...props}
    />
    {error && <Text className="text-red-400 text-xs">{error}</Text>}
  </View>
)

// ─── Label / Badge ────────────────────────────────────────────────────────────

interface BadgeProps extends ViewProps {
  label: string
  color?: 'green' | 'red' | 'yellow' | 'blue' | 'slate'
  className?: string
}

const badgeColors: Record<string, string> = {
  green: 'bg-emerald-900/50 text-emerald-400',
  red: 'bg-red-900/50 text-red-400',
  yellow: 'bg-yellow-900/50 text-yellow-400',
  blue: 'bg-sky-900/50 text-sky-400',
  slate: 'bg-slate-700 text-slate-300',
}

export const Badge: React.FC<BadgeProps> = ({ label, color = 'slate', className = '' }) => (
  <View className={`rounded-full px-2 py-0.5 self-start ${badgeColors[color].split(' ')[0]} ${className}`}>
    <Text className={`text-xs font-medium ${badgeColors[color].split(' ')[1]}`}>{label}</Text>
  </View>
)

// ─── Section Header ───────────────────────────────────────────────────────────

export const SectionHeader: React.FC<{ title: string; action?: React.ReactNode }> = ({
  title,
  action,
}) => (
  <View className="flex-row items-center justify-between mb-3">
    <Text className="text-white font-bold text-lg">{title}</Text>
    {action}
  </View>
)

// ─── Empty State ─────────────────────────────────────────────────────────────

export const EmptyState: React.FC<{ message: string; icon?: string }> = ({ message }) => (
  <View className="items-center py-12">
    <Text className="text-4xl mb-3">📭</Text>
    <Text className="text-slate-400 text-center">{message}</Text>
  </View>
)

// ─── Loading Spinner ──────────────────────────────────────────────────────────

export const LoadingSpinner: React.FC<{ message?: string }> = ({ message }) => (
  <View className="flex-1 items-center justify-center gap-3">
    <ActivityIndicator size="large" color="#0ea5e9" />
    {message && <Text className="text-slate-400">{message}</Text>}
  </View>
)

// ─── Separator ───────────────────────────────────────────────────────────────

export const Separator: React.FC<{ className?: string }> = ({ className = '' }) => (
  <View className={`h-px bg-slate-700 ${className}`} />
)

// ─── Amount Text ─────────────────────────────────────────────────────────────

interface AmountTextProps extends TextProps {
  amount: number
  currency: string
  positive?: boolean
  negative?: boolean
  className?: string
}

export const AmountText: React.FC<AmountTextProps> = ({
  amount,
  positive,
  negative,
  className = '',
  ...props
}) => {
  const colorClass = positive
    ? 'text-emerald-400'
    : negative
    ? 'text-red-400'
    : 'text-white'

  return (
    <Text className={`font-semibold ${colorClass} ${className}`} {...props}>
      {amount >= 0 ? '' : '-'}
      {Math.abs(amount).toLocaleString('en-US', {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      })}
    </Text>
  )
}
