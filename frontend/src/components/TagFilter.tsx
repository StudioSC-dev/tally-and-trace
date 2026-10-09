import { useEffect } from 'react'
import { useGetTagsQuery } from '../store/api'
import { parseTagFilter } from '../utils/tags'

/** A tag selector that drives a `?tag=` filter. "All tags" clears it. */
export function TagFilter({
  value,
  onChange,
  className = '',
}: {
  value: number | undefined
  onChange: (tag: number | undefined) => void
  className?: string
}) {
  const { data: tags = [], isSuccess } = useGetTagsQuery()
  // A tag deleted since it was chosen must not leave the list filtered by an id that no
  // longer shows in the selector.
  const known = value === undefined || tags.some((tag) => tag.id === value)
  useEffect(() => {
    if (isSuccess && !known) onChange(undefined)
  }, [isSuccess, known, onChange])
  return (
    <label className={`inline-flex items-center gap-2 text-sm text-body ${className}`}>
      <span>Tag</span>
      <select
        aria-label="Filter by tag"
        data-testid="tag-filter"
        value={value !== undefined && known ? String(value) : ''}
        onChange={(e) => onChange(parseTagFilter(e.target.value))}
        className="select-field focus-ring"
      >
        <option value="">All tags</option>
        {tags.map((tag) => (
          <option key={tag.id} value={tag.id}>
            {tag.name}
          </option>
        ))}
      </select>
    </label>
  )
}
