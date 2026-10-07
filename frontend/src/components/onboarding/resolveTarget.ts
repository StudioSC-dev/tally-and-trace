/**
 * Find the element a tour step should highlight.
 *
 * Several elements can carry the same marker — the desktop nav links and the
 * mobile bottom tabs both do — and only one of them is laid out at a given
 * width; the other sits in a `display: none` container with a 0×0 rect at the
 * origin. So the first match is not good enough: take the first one that is
 * actually rendered with a non-zero size.
 */
export function resolveOnboardingTarget(selector: string | undefined): HTMLElement | null {
  if (!selector) return null
  const candidates = document.querySelectorAll<HTMLElement>(selector)
  for (const element of Array.from(candidates)) {
    const rect = element.getBoundingClientRect()
    if (rect.width > 0 && rect.height > 0) return element
  }
  return null
}
