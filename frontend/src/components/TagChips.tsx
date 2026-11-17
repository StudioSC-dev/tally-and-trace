import type { TagRef } from '@tally-trace/shared'
import { displayColor, NO_COLOR, swatchOf, tokenColor } from '../utils/palette'

/** A record's own tags as small chips (colour dot + name). Renders nothing when there are none. */
export function TagChips({ tags, className = '' }: { tags: TagRef[] | undefined; className?: string }) {
  if (!tags || tags.length === 0) return null
  return (
    <span className={`inline-flex flex-wrap items-center gap-1.5 ${className}`} data-testid="tag-chips">
      {tags.map((tag) => {
        // A tag in the palette is a chip on its swatch; any other saved colour keeps its own dot on a plain chip.
        const swatch = swatchOf(tag.color)
        return swatch !== null ? (
          <span
            key={tag.id}
            className="inline-flex items-center rounded-full px-2 py-0.5 text-xs text-ink"
            style={{ backgroundColor: tokenColor(`swatch-${swatch}`) }}
            data-testid="tag-chip"
          >
            {tag.name}
          </span>
        ) : (
          <span
            key={tag.id}
            className="inline-flex items-center gap-1.5 rounded-full bg-sunken px-2 py-0.5 text-xs text-body"
            data-testid="tag-chip"
          >
            <span
              aria-hidden
              className="h-1.5 w-1.5 shrink-0 rounded-full"
              style={{ backgroundColor: displayColor(tag.color, NO_COLOR) }}
            />
            {tag.name}
          </span>
        )
      })}
    </span>
  )
}
