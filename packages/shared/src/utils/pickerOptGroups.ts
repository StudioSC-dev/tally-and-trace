import type { PickerGroup, PickerOption } from './pickerOptions'

export interface SelectOptGroup {
  key: string
  /** Null means the options sit directly in the select, with no `<optgroup>`. */
  label: string | null
  options: PickerOption[]
}

/**
 * Picker groups as the flat list a native `<select>` can show: `<optgroup>` cannot nest, so a
 * nested group becomes one entry per child, labelled "Parent · Child" (for example
 * "Shared · Debit"). Groups with no options are left out.
 */
export function selectOptGroups(groups: readonly PickerGroup[], prefix: string | null = null): SelectOptGroup[] {
  const out: SelectOptGroup[] = []
  for (const g of groups) {
    const label = g.label === null ? prefix : prefix === null ? g.label : `${prefix} · ${g.label}`
    if (g.options.length > 0) out.push({ key: g.key, label, options: g.options })
    if (g.children) out.push(...selectOptGroups(g.children, label))
  }
  return out
}
