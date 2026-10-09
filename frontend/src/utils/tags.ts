import type { TagRef } from '@tally-trace/shared'

/** The ids of a record's own tags, in the order the API returned them. */
export const tagIdsOf = (tags: TagRef[] | undefined): number[] => (tags ?? []).map((tag) => tag.id)

/** Whether two selections hold the same tags, ignoring order. */
export const sameTagIds = (a: number[], b: number[]): boolean => {
  if (a.length !== b.length) return false
  const left = new Set(a)
  return b.every((id) => left.has(id))
}

/**
 * `tag_ids` for an update body: the selection when it differs from the record's
 * current tags, else nothing, so an edit that leaves the tags alone sends no
 * `tag_ids` and the server keeps them.
 */
export const tagIdsIfChanged = (selected: number[], original: number[]): { tag_ids?: number[] } =>
  sameTagIds(selected, original) ? {} : { tag_ids: selected }

/** A `?tag=` value from a `<select>`: the tag id, or undefined for "all tags". */
export const parseTagFilter = (value: string): number | undefined => {
  const id = Number(value)
  return value !== '' && Number.isInteger(id) ? id : undefined
}
