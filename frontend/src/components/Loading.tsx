// Shared loading markup: skeleton placeholders and one spinner. Tokens only.

function join(...parts: Array<string | undefined>): string {
  return parts.filter(Boolean).join(' ')
}

export type SkeletonTone = 'default' | 'strong'

interface SkeletonProps {
  className?: string
  /** `strong` is for skeletons on `bg-sunken` tiles. */
  tone?: SkeletonTone
}

/** A pulsing placeholder block. Always hidden from assistive technology. */
export function Skeleton({ className, tone = 'default' }: SkeletonProps) {
  return (
    <div
      aria-hidden="true"
      className={join(
        'animate-pulse motion-reduce:animate-none',
        tone === 'strong' ? 'bg-line-strong' : 'bg-line',
        className,
      )}
    />
  )
}

interface SkeletonRowsProps {
  rows: number
  className?: string
}

/** Stacked row-height skeletons. */
export function SkeletonRows({ rows, className }: SkeletonRowsProps) {
  return (
    <div className={join('space-y-2', className)}>
      {Array.from({ length: rows }, (_, index) => (
        <Skeleton key={index} className="h-12 w-full" />
      ))}
    </div>
  )
}

export type SpinnerSize = 'xs' | 'sm' | 'md' | 'lg'
export type SpinnerTone = 'default' | 'current'

const SPINNER_SIZE: Record<SpinnerSize, string> = {
  xs: 'h-3.5 w-3.5 border',
  sm: 'h-4 w-4 border-2',
  md: 'h-8 w-8 border-2',
  lg: 'h-12 w-12 border-2',
}

const SPINNER_TONE: Record<SpinnerTone, string> = {
  default: 'border-line border-t-ink',
  current: 'border-current border-t-transparent',
}

interface SpinnerProps {
  size?: SpinnerSize
  tone?: SpinnerTone
  className?: string
}

/** A turning ring. Decorative: the caller supplies any announced status. */
export function Spinner({ size = 'md', tone = 'default', className }: SpinnerProps) {
  return (
    <span
      data-testid="spinner"
      aria-hidden="true"
      className={join('inline-block animate-spin rounded-full', SPINNER_SIZE[size], SPINNER_TONE[tone], className)}
    />
  )
}

interface PageLoaderProps {
  label?: string
  className?: string
}

/** A full-screen centred spinner, with an optional visible label beneath it. */
export function PageLoader({ label, className }: PageLoaderProps) {
  return (
    <div className={join('flex min-h-screen items-center justify-center', className)}>
      {label ? (
        <div className="text-center">
          <div className="mb-4 flex justify-center">
            <Spinner size="lg" />
          </div>
          <p className="text-body">{label}</p>
        </div>
      ) : (
        <Spinner size="md" />
      )}
    </div>
  )
}

export type LoadingLineSize = 'xs' | 'sm'

interface LoadingLineProps {
  children: string
  size?: LoadingLineSize
  className?: string
}

/** A one-line muted loading message. */
export function LoadingLine({ children, size = 'sm', className }: LoadingLineProps) {
  return <p className={join(size === 'xs' ? 'text-xs' : 'text-sm', 'text-muted', className)}>{children}</p>
}
