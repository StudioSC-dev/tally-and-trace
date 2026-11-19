import type { HTMLAttributes } from 'react'

/** The status colours a state can take (docs/design-system.md, "Status, as a dot and a word"). */
export type StatusTone = 'ok' | 'warn' | 'danger' | 'muted'

/** Written out in full so Tailwind keeps each tone's rule (it drops a class it cannot find in the source). */
const TONE_CLASS: Record<StatusTone, string> = {
  ok: 'text-ok',
  warn: 'text-warn',
  danger: 'text-danger',
  muted: 'text-muted',
}

type StatusTextProps = HTMLAttributes<HTMLSpanElement> & {
  tone: StatusTone
}

/**
 * A state shown as a dot and a word: an 8px dot in the status colour, then the word in the same colour, 13px 500, with
 * no fill. It is for states (Overdue, Due today, Pending, Posted, Paid, Charged, Auto-post on / off, Not reviewed);
 * an action on a state stays a `Button`. The dot is decorative, so the word alone is read out.
 */
export function StatusText({ tone, className, children, ...rest }: StatusTextProps) {
  return (
    <span data-status={tone} className={`status-text ${TONE_CLASS[tone]}${className ? ` ${className}` : ''}`} {...rest}>
      <span aria-hidden="true" data-status-dot className="h-2 w-2 shrink-0 rounded-full bg-current" />
      <span data-status-word>{children}</span>
    </span>
  )
}
