import type { ReactNode } from 'react'

interface SectionIntroProps {
  /** The tab's heading, set as an `h2` in `text-xl`. */
  title: ReactNode
  /** One line saying what the tab holds. */
  description: ReactNode
}

/**
 * The block every tab of a tabbed page opens with (docs/design-system.md, "Page"): a `text-xl` heading and a
 * one-line description, directly under the tab nav. The tab's toolbar, if it has one, follows it.
 */
export function SectionIntro({ title, description }: SectionIntroProps) {
  return (
    <header className="space-y-1" data-testid="section-intro">
      <h2 className="text-xl font-semibold text-ink">{title}</h2>
      <p className="text-sm text-muted">{description}</p>
    </header>
  )
}
