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
