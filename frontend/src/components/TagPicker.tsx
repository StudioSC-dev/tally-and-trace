import { LoadingLine } from './Loading'
import { Link } from '@tanstack/react-router'
import { useGetTagsQuery } from '../store/api'
import { Segment } from './SegmentedControl'

const FALLBACK_COLOR = '#9ca3af'

/**
 * Multi-select of the caller's tags. With `warnHousehold` (the account form) it says what
 * tagging an account Household means for the people holding the owner's Household share.
 */
export function TagPicker({
  value,
  onChange,
  warnHousehold = false,
  label = 'Tags',
}: {
  value: number[]
  onChange: (ids: number[]) => void
  warnHousehold?: boolean
  label?: string
}) {
  const { data: tags = [], isLoading, isError } = useGetTagsQuery()
  const selected = new Set(value)
  const toggle = (id: number) =>
    onChange(selected.has(id) ? value.filter((v) => v !== id) : [...value, id])
  const householdSelected = tags.some((tag) => tag.is_system && selected.has(tag.id))

  return (
    <div data-testid="tag-picker">
      <label className="label">{label} (optional)</label>
      {isLoading ? (
        <LoadingLine>Loading tags…</LoadingLine>
      ) : isError ? (
        <p className="text-sm text-danger">Could not load your tags.</p>
      ) : tags.length === 0 ? (
        <p className="text-sm text-muted">
          No tags yet. Create some in <Link to="/settings" className="underline">Settings</Link>.
        </p>
      ) : (
        <div className="flex flex-wrap gap-2" role="group" aria-label={label}>
          {tags.map((tag) => (
            <Segment
              key={tag.id}
              selected={selected.has(tag.id)}
              onClick={() => toggle(tag.id)}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm"
            >
              <span
                aria-hidden
                className="h-2 w-2 shrink-0 rounded-full border border-black/10"
                style={{ backgroundColor: tag.color || FALLBACK_COLOR }}
              />
              {tag.name}
            </Segment>
          ))}
        </div>
      )}
      {warnHousehold && householdSelected && (
        <p role="note" className="mt-2 border border-line bg-sunken p-3 text-sm text-body" data-testid="household-account-notice">
          Tagging an account Household exposes your own transactions on it, and its balance, to anyone you share your
          Household with (they see them read-only). Other people&apos;s transactions on this account are not shown to
          them.
        </p>
      )}
    </div>
  )
}
