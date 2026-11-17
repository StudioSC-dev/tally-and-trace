import type { ButtonHTMLAttributes, HTMLAttributes, ReactNode } from 'react'
import { swatchClass, withSelection } from '../utils/selection'

type SegmentProps = Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'type' | 'aria-pressed'> & {
  selected: boolean
}

/**
 * One pressable choice: a button with `aria-pressed` and the selection rule. `SegmentedControl` renders these
 * for a single choice; a toggle group (tags, filter chips) renders them directly.
 */
export function Segment({ selected, className, ...rest }: SegmentProps) {
  return <button type="button" aria-pressed={selected} className={withSelection(selected, className)} {...rest} />
}

type SwatchProps = Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'type' | 'aria-pressed' | 'color'> & {
  selected: boolean
  /** The swatch's fill, as CSS (a token such as `rgb(var(--swatch-1))`). */
  color: string
}

/**
 * One colour choice of a single-select group of swatches: a round button filled with its own colour and
 * `aria-pressed`. The chosen swatch is ringed in the ink token; the fill never changes.
 */
export function Swatch({ selected, color, className, style, ...rest }: SwatchProps) {
  return <button type="button" aria-pressed={selected} className={swatchClass(selected, className)} style={{ ...style, backgroundColor: color }} {...rest} />
}

export interface SegmentOption<T extends string | number> {
  value: T
  label: ReactNode
  testId?: string
  disabled?: boolean
}

type SegmentedControlProps<T extends string | number> = Omit<HTMLAttributes<HTMLDivElement>, 'onChange' | 'role'> & {
  options: readonly SegmentOption<T>[]
  value: T
  onChange: (value: T) => void
  /** Layout classes for each segment (padding, size); the selection rule supplies the colours. */
  segmentClassName?: string
}

/**
 * A single-select group (`role="group"`): one `aria-pressed` segment per option, exactly one selected. The
 * selected one carries the selection rule, never the primary button's fill.
 */
export function SegmentedControl<T extends string | number>({
  options,
  value,
  onChange,
  segmentClassName,
  ...group
}: SegmentedControlProps<T>) {
  return (
    <div role="group" {...group}>
      {options.map((option) => (
        <Segment
          key={String(option.value)}
          selected={option.value === value}
          disabled={option.disabled}
          data-testid={option.testId}
          onClick={() => onChange(option.value)}
          className={segmentClassName}
        >
          {option.label}
        </Segment>
      ))}
    </div>
  )
}
