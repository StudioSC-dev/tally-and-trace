import { Link } from '@tanstack/react-router'
import { useAuth } from '../contexts/AuthContext'
import { useTheme } from '../hooks/useTheme'
import { useState } from 'react'
import { useSelector } from 'react-redux'
import { useConfirm } from '../hooks/useConfirm'
import type { RootState } from '../store'
import { getCurrencyLogoSymbol } from '../utils/currency'
import { Icon } from './Icon'

export function Navigation() {
  const { user, logout: signOut } = useAuth()
  const askConfirm = useConfirm()
  const queued = useSelector((state: RootState) => state.outbox.entries.length)
  // Saves still queued or failed are asked about first (STU-605); they stay on this device,
  // under this user, and come back at the next sign-in as "not confirmed".
  const logout = () => {
    if (queued === 0) {
      signOut()
      return
    }
    void askConfirm({
      title: 'Sign out with unsaved changes?',
      message: `${queued === 1 ? 'One save is' : `${queued} saves are`} not confirmed yet. They are kept on this device and come back when you sign in again.`,
      confirmLabel: 'Sign out',
      tone: 'default',
    }).then((accepted) => {
      if (accepted) signOut()
    })
  }
  const { theme, toggleTheme } = useTheme()
  const [showUserMenu, setShowUserMenu] = useState(false)
  const symbol = getCurrencyLogoSymbol(user?.default_currency)

  // The bar is the spine band (the `spine` class, index.css): inside it ink, body,
  // muted and line resolve to the on-spine values. Every page link is on-spine
  // text, and the active page is a 2px on-spine underline, never a fill.
  //
  // The router joins className, activeProps.className and inactiveProps.className,
  // so the base holds only layout; the state classes live in the active/inactive
  // props so an active link never carries the inactive colours as well.
  const navLinkBase = "inline-flex items-center gap-2 border-b-2 px-2.5 py-2 text-sm transition-colors duration-200"
  const navLinkInactive = "border-transparent text-body"
  const navLinkActive = "border-ink text-ink"

  return (
    // safe-area-top: index.html asks for a translucent status bar, so when the
    // app is installed to the Home Screen the page owns the full height and a
    // `top-0` bar would render under the clock. Resolves to 0 in a browser tab.
    <nav className="safe-area-top spine fixed left-0 right-0 top-0 z-50">
      <div className="w-full px-3 sm:px-4 lg:px-6">
        <div className="flex justify-between h-16 gap-2">
          {/* Logo + Desktop Nav Links */}
          <div className="flex items-center min-w-0">
            <div className="flex-shrink-0 flex items-center">
              <Link to="/" className="tap-target flex items-center gap-2.5 text-ink transition-colors hover:text-body">
                <span className="flex h-7 w-7 shrink-0 items-center justify-center border border-line font-mono text-xs">
                  {symbol}
                </span>
                <span className="hidden text-lg font-semibold md:inline">Tally &amp; Trace</span>
              </Link>
            </div>
            <div className="hidden sm:ml-6 sm:flex sm:space-x-0.5 min-w-0 overflow-x-auto">
              <Link to="/" data-onboarding="nav-home" activeOptions={{ exact: true }} className={navLinkBase} activeProps={{ className: navLinkActive }} inactiveProps={{ className: navLinkInactive }}>
                <Icon name="home" />
                Dashboard
              </Link>
              <Link to="/forecast" className={navLinkBase} activeProps={{ className: navLinkActive }} inactiveProps={{ className: navLinkInactive }}>
                <Icon name="forecast" />
                Forecast
              </Link>
              <Link to="/accounts" data-onboarding="nav-accounts" className={navLinkBase} activeProps={{ className: navLinkActive }} inactiveProps={{ className: navLinkInactive }}>
                <Icon name="accounts" />
                Accounts
              </Link>
              <Link to="/transactions" data-onboarding="nav-transactions" className={navLinkBase} activeProps={{ className: navLinkActive }} inactiveProps={{ className: navLinkInactive }}>
                <Icon name="transactions" />
                Transactions
              </Link>
              <Link to="/allocations" data-onboarding="nav-allocations" className={navLinkBase} activeProps={{ className: navLinkActive }} inactiveProps={{ className: navLinkInactive }}>
                <Icon name="allocations" />
                Allocations
              </Link>
            </div>
          </div>

          {/* Right side: theme toggle + user menu */}
          <div className="flex items-center space-x-2 shrink-0">
            {/* Theme Toggle */}
            <button
              onClick={toggleTheme}
              aria-label="Toggle theme"
              className="tap-target flex items-center justify-center p-2 text-muted transition-colors duration-200 hover:text-ink"
            >
              <Icon name={theme === 'dark' ? 'theme-light' : 'theme-dark'} />
            </button>

            {/* User Menu */}
            <div className="relative">
              <button
                onClick={() => setShowUserMenu(!showUserMenu)}
                className="flex items-center space-x-2 px-2.5 py-2 text-sm text-body transition-colors duration-200 hover:text-ink focus:outline-none"
              >
                <div className="flex h-8 w-8 items-center justify-center border border-line">
                  <span className="font-mono text-xs text-body">
                    {user?.first_name?.[0]}{user?.last_name?.[0]}
                  </span>
                </div>
                <span className="hidden lg:block">{user?.first_name} {user?.last_name}</span>
                <Icon name="caret-down" />
              </button>

              {showUserMenu && (
                // spine-leaf: the panel is a leaf inside the band, so it takes the document colours back.
                <div className="spine-leaf absolute right-0 z-50 mt-2 w-52 border border-line bg-surface py-1">
                  <div className="border-b border-line px-4 py-3 text-sm">
                    <div className="font-medium text-ink">{user?.first_name} {user?.last_name}</div>
                    <div className="mt-0.5 text-xs text-muted">{user?.email}</div>
                    <div className="label mt-1.5">Default {user?.default_currency}</div>
                  </div>
                  <Link
                    to="/settings"
                    onClick={() => setShowUserMenu(false)}
                    className="flex w-full items-center gap-2 px-4 py-2 text-left text-sm text-body transition-colors duration-200 hover:bg-sunken hover:text-ink"
                  >
                    <Icon name="settings" />
                    Settings
                  </Link>
                  <button
                    onClick={() => {
                      logout()
                      setShowUserMenu(false)
                    }}
                    className="flex w-full items-center gap-2 px-4 py-2 text-left text-sm text-body transition-colors duration-200 hover:bg-sunken hover:text-ink"
                  >
                    <Icon name="sign-out" />
                    Sign out
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </nav>
  )
}
