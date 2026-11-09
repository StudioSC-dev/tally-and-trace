import { Fragment } from 'react'
import { selectOptGroups } from '@tally-trace/shared'
import type { PickerGroup, PickerOption } from '@tally-trace/shared'

interface Props {
  groups: readonly PickerGroup[]
  /** Option text; defaults to the option's label. */
  text?: (option: PickerOption) => string
}

/**
 * The `<option>` children of a native `<select>`, under `<optgroup>` headings. Placeholder and
 * stored-value options stay outside, written by the caller before this. A group with no heading
 * renders its options directly.
 */
export function PickerOptGroups({ groups, text }: Props) {
  return (
    <>
      {selectOptGroups(groups).map((g) => {
        const options = g.options.map((o) => (
          <option key={o.id} value={o.id}>
            {text ? text(o) : o.label}
          </option>
        ))
        return g.label === null ? (
          <Fragment key={g.key}>{options}</Fragment>
        ) : (
          <optgroup key={g.key} label={g.label}>
            {options}
          </optgroup>
        )
      })}
    </>
  )
}
