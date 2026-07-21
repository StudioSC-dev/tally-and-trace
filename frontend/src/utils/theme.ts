export type Theme = 'light' | 'dark'

export const THEME_STORAGE_KEY = 'studiosc-theme'

/** Fired on window when the theme changes, so subscribers re-render. */
const THEME_EVENT = 'studiosc:themechange'

export function setTheme(theme: Theme) {
  document.documentElement.setAttribute('data-theme', theme)
  try {
    localStorage.setItem(THEME_STORAGE_KEY, theme)
  } catch {
    // Private mode / storage disabled — the theme still applies for this page.
  }
  window.dispatchEvent(new Event(THEME_EVENT))
}

export function subscribeToTheme(onChange: () => void) {
  window.addEventListener(THEME_EVENT, onChange)

  // Follow the OS only while the visitor has not made an explicit choice.
  const query = window.matchMedia('(prefers-color-scheme: dark)')
  const onSystemChange = () => {
    try {
      if (localStorage.getItem(THEME_STORAGE_KEY)) {
        return
      }
    } catch {
      // Unreadable storage means no explicit choice was recorded.
    }
    document.documentElement.setAttribute(
      'data-theme',
      query.matches ? 'dark' : 'light'
    )
    onChange()
  }
  query.addEventListener('change', onSystemChange)

  return () => {
    window.removeEventListener(THEME_EVENT, onChange)
    query.removeEventListener('change', onSystemChange)
  }
}

export function getThemeSnapshot(): Theme {
  return document.documentElement.getAttribute('data-theme') === 'dark'
    ? 'dark'
    : 'light'
}
