/**
 * Known critical axe violations the a11y scan tolerates. Each is keyed by axe rule id and
 * the element's CSS selector and must name the ticket that fixes it. Keep this list empty
 * unless a scan finds an existing critical violation.
 */
export interface A11yException {
  rule: string
  selector: string
  ticket: string
}

export const a11yExceptions: readonly A11yException[] = []
