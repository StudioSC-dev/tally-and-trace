import { forwardRef } from 'react'
import type { ButtonHTMLAttributes } from 'react'

/** The four button variants in docs/design-system.md ("Button"). */
export type ButtonVariant = 'primary' | 'secondary' | 'quiet' | 'danger'

/** Written out in full so Tailwind keeps each variant's rules (it drops a class it cannot find in the source). */
const VARIANT_CLASS: Record<ButtonVariant, string> = {
  primary: 'button-primary',
  secondary: 'button-secondary',
  quiet: 'button-quiet',
  danger: 'button-danger',
}

/**
 * A variant's class names, followed by the caller's layout classes. `Button` uses it; a link styled as a button
 * uses it directly and sets `data-variant` itself. The colours live in `.button` and `.button-<variant>` in
 * assets/index.css; the caller's classes set layout only (width, padding, text size).
 */
// eslint-disable-next-line react-refresh/only-export-components -- the helper is the one button path for links
export const buttonClass = (variant: ButtonVariant, className?: string): string =>
  `button ${VARIANT_CLASS[variant]}${className ? ` ${className}` : ''}`

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant: ButtonVariant
}

/**
 * Every action button: one of the four variants, with its hover and disabled states, `data-variant` for tests and
 * `type="button"` unless the caller asks for `submit`. Selection controls are not buttons in this sense: they use
 * `Segment`, `SegmentedControl` or `Tabs`.
 */
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant, type = 'button', className, ...rest },
  ref,
) {
  return <button ref={ref} type={type} data-variant={variant} className={buttonClass(variant, className)} {...rest} />
})
