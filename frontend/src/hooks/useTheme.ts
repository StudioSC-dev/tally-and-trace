import { useSyncExternalStore } from 'react'
import {
  getThemeSnapshot,
  setTheme,
  subscribeToTheme,
  type Theme,
} from '../utils/theme'

/**
 * The theme lives on <html data-theme>, set by the blocking script in
 * index.html before React mounts, so it is genuinely external state —
 * useSyncExternalStore rather than a provider holding a useState copy.
 */
export function useTheme() {
  const theme = useSyncExternalStore(subscribeToTheme, getThemeSnapshot)
  const next: Theme = theme === 'dark' ? 'light' : 'dark'

  return { theme, next, toggleTheme: () => setTheme(next) }
}
