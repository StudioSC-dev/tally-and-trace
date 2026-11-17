import { forwardRef } from 'react'
import type { ButtonHTMLAttributes, HTMLAttributes } from 'react'
import { withSelection } from '../utils/selection'

/** A `role="tablist"` container for `Tab`s. Keyboard handling stays with the caller. */
export function Tabs(props: Omit<HTMLAttributes<HTMLDivElement>, 'role'>) {
  return <div role="tablist" {...props} />
}

type TabProps = Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'type' | 'role' | 'aria-selected'> & {
  selected: boolean
}

/**
 * One tab: a button with `role="tab"`, `aria-selected` and the selection rule. The caller passes ids,
 * `aria-controls`, `tabIndex` and key handling as before; the ref reaches the button so focus can move.
 */
export const Tab = forwardRef<HTMLButtonElement, TabProps>(function Tab({ selected, className, ...rest }, ref) {
  return <button ref={ref} type="button" role="tab" aria-selected={selected} className={withSelection(selected, className)} {...rest} />
})
