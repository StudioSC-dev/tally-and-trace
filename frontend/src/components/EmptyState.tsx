import type { HTMLAttributes } from 'react'
import { Button } from './Button'

type EmptyStateProps = Omit<HTMLAttributes<HTMLDivElement>, 'children'> & {
  /** What is missing, as one sentence. */
  message: string
  /** The next step, as the one primary button. Left out for someone who cannot create here: the sentence stands alone. */
  action?: { label: string; onClick: () => void }
}

/**
 * An empty list's message and its one action (docs/design-system.md, "EmptyState"): the sentence, then a primary
 * `Button`, left-aligned on the page with no card chrome.
 */
export function EmptyState({ message, action, className, ...rest }: EmptyStateProps) {
  return (
    <div data-testid="empty-state" className={`space-y-3 text-left${className ? ` ${className}` : ''}`} {...rest}>
      <p className="text-base text-body">{message}</p>
      {action && (
        <Button variant="primary" onClick={action.onClick}>
          {action.label}
        </Button>
      )}
    </div>
  )
}
