/**
 * The tab to move to for a key press in an ARIA tab list with automatic
 * activation: ArrowRight and ArrowLeft wrap, Home and End jump to the ends. Null
 * for any other key, or when there is no tab.
 */
export function tabKeyTarget(key: string, index: number, count: number): number | null {
  if (count < 1) return null
  switch (key) {
    case 'ArrowRight':
      return (index + 1) % count
    case 'ArrowLeft':
      return (index - 1 + count) % count
    case 'Home':
      return 0
    case 'End':
      return count - 1
    default:
      return null
  }
}
