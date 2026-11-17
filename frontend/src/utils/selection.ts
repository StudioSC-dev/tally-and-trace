/**
 * The selection rule's class names (docs/design-system.md, "Selection rule"): `seg` is a quiet, unselected
 * control and `seg is-selected` the chosen one. `SegmentedControl`, `Segment`, `Tabs` and `Tab` apply it; a
 * control that marks its choice another way (the pager's `aria-current`) uses it directly.
 */
export const selectionClass = (selected: boolean): string => (selected ? 'seg is-selected' : 'seg')

/** `selectionClass` followed by the caller's layout classes. */
export const withSelection = (selected: boolean, className?: string): string =>
  className ? `${selectionClass(selected)} ${className}` : selectionClass(selected)

/**
 * A colour swatch's class names: `swatch` is a round, unringed choice and `swatch is-selected` the chosen one,
 * marked by a ring in the ink token. The swatch keeps its own colour fill, so it never takes the leaf background.
 */
export const swatchClass = (selected: boolean, className?: string): string =>
  `${selected ? 'swatch is-selected' : 'swatch'}${className ? ` ${className}` : ''}`
