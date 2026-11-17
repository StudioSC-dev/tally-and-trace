import type { TagRef } from '@tally-trace/shared'
import { displayColor, NO_COLOR, swatchOf, tokenColor } from '../utils/palette'

/**
 * One tag as a small chip. A tag in the palette is a chip on its swatch; any other saved colour keeps its own dot on
 * a plain chip. `measure` draws it without its test hook, for an invisible ruler that sizes chips before they show.
 */
export function TagChip({ tag, measure = false }: { tag: TagRef; measure?: boolean }) {
  const swatch = swatchOf(tag.color)
  const hook = measure ? undefined : 'tag-chip'
  return swatch !== null ? (
    <span
      className="inline-flex items-center rounded-full px-2 py-0.5 text-xs text-ink"
      style={{ backgroundColor: tokenColor(`swatch-${swatch}`) }}
      data-testid={hook}
    >
      {tag.name}
    </span>
  ) : (
    <span className="inline-flex items-center gap-1.5 rounded-full bg-sunken px-2 py-0.5 text-xs text-body" data-testid={hook}>
      <span aria-hidden className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ backgroundColor: displayColor(tag.color, NO_COLOR) }} />
      {tag.name}
    </span>
  )
}

/** A record's own tags as small chips (colour dot + name). Renders nothing when there are none. */
export function TagChips({ tags, className = '' }: { tags: TagRef[] | undefined; className?: string }) {
  if (!tags || tags.length === 0) return null
  return (
    <span className={`inline-flex flex-wrap items-center gap-1.5 ${className}`} data-testid="tag-chips">
      {tags.map((tag) => (
        <TagChip key={tag.id} tag={tag} />
      ))}
    </span>
  )
}
