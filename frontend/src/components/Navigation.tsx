import { Link } from '@tanstack/react-router'
import { useAuth } from '../contexts/AuthContext'
import { useEntity } from '../contexts/EntityContext'
import { useTheme } from '../hooks/useTheme'
import { useState } from 'react'
import { getCurrencyLogoSymbol } from '../utils/currency'

export function Navigation() {
  const { user, logout } = useAuth()
  const { entities, activeEntity, setActiveEntityId } = useEntity()
  const { theme, toggleTheme } = useTheme()
  const [showUserMenu, setShowUserMenu] = useState(false)
  const [showMobileMenu, setShowMobileMenu] = useState(false)
  const [showEntityMenu, setShowEntityMenu] = useState(false)
  const symbol = getCurrencyLogoSymbol(user?.default_currency)

  // Active tab is an ink underline rather than a tinted pill — a saturated fill
  // in the chrome competes with the figures, which are what should carry colour
  // on a ledger screen.
  const navLinkBase = "inline-flex items-center border-b-2 border-transparent px-3 py-2 text-sm text-muted transition-colors duration-200 hover:text-ink"
  const navLinkActive = "inline-flex items-center border-b-2 border-ink px-3 py-2 text-sm text-ink"
  const mobileNavLinkBase = "flex w-full items-center border-l-2 border-transparent px-3 py-3 text-base text-muted transition-colors duration-200 hover:text-ink"
  const mobileNavLinkActive = "flex w-full items-center border-l-2 border-ink px-3 py-3 text-base text-ink"

  return (
    <nav className="fixed left-0 right-0 top-0 z-50 border-b border-line bg-paper/85 backdrop-blur-sm">
      <div className="w-full px-3 sm:px-4 lg:px-6">
        <div className="flex justify-between h-16 gap-2">
          {/* Logo + Desktop Nav Links */}
          <div className="flex items-center min-w-0">
            <div className="flex-shrink-0 flex items-center">
              <Link to="/" className="flex items-center gap-2.5 text-ink transition-colors hover:text-body">
                <span className="flex h-7 w-7 shrink-0 items-center justify-center border border-line-strong font-mono text-xs">
                  {symbol}
                </span>
                <span className="hidden font-serif text-lg md:inline">Tally &amp; Trace</span>
              </Link>
            </div>
            <div className="hidden sm:ml-6 sm:flex sm:space-x-0.5 min-w-0 overflow-x-auto">
              <Link to="/" className={navLinkBase} activeProps={{ className: navLinkActive }}>
                <svg className="w-4 h-4 mr-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2H5a2 2 0 00-2-2z" />
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 5a2 2 0 012-2h4a2 2 0 012 2v2H8V5z" />
                </svg>
                Dashboard
              </Link>
              <Link to="/forecast" className={navLinkBase} activeProps={{ className: navLinkActive }}>
                <svg className="w-4 h-4 mr-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 3v18h18" />
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 14l4-4 3 3 5-6" />
                </svg>
                Forecast
              </Link>
              <Link to="/accounts" className={navLinkBase} activeProps={{ className: navLinkActive }}>
                <svg className="w-4 h-4 mr-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 21V5a2 2 0 00-2-2H7a2 2 0 00-2 2v16m14 0h2m-2 0h-5m-9 0H3m2 0h5M9 7h1m-1 4h1m4-4h1m-1 4h1m-5 10v-5a1 1 0 011-1h2a1 1 0 011 1v5m-4 0h4" />
                </svg>
                Accounts
              </Link>
              <Link to="/transactions" className={navLinkBase} activeProps={{ className: navLinkActive }}>
                <svg className="w-4 h-4 mr-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5H7a2 2 0 00-2 2v10a2 2 0 002 2h8a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-3 7h3m-3 4h3m-6-4h.01M9 16h.01" />
                </svg>
                Transactions
              </Link>
              <Link to="/allocations" className={navLinkBase} activeProps={{ className: navLinkActive }}>
                <svg className="w-4 h-4 mr-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" />
                </svg>
                Allocations
              </Link>
            </div>
          </div>

          {/* Right side: entity switcher + theme toggle + user menu + mobile hamburger */}
          <div className="flex items-center space-x-2 shrink-0">
            {/* Entity Switcher */}
            {entities.length > 1 && (
              <div className="relative hidden sm:block sm:mr-1 sm:border-r sm:border-line sm:pr-3">
                <button
                  onClick={() => setShowEntityMenu(!showEntityMenu)}
                  className="inline-flex max-w-[9rem] items-center gap-1.5 border border-line px-3 py-2 text-sm text-body transition-colors duration-200 hover:border-line-strong hover:text-ink lg:max-w-[12rem]"
                >
                  <svg className="w-4 h-4 shrink-0 text-muted" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 21V5a2 2 0 00-2-2H7a2 2 0 00-2 2v16m14 0h2m-2 0h-5m-9 0H3m2 0h5M9 7h1m-1 4h1m4-4h1m-1 4h1m-5 10v-5a1 1 0 011-1h2a1 1 0 011 1v5m-4 0h4" />
                  </svg>
                  <span className="truncate min-w-0 capitalize">{activeEntity?.name ?? 'Select entity'}</span>
                  <svg className="w-4 h-4 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                  </svg>
                </button>
                {showEntityMenu && (
                  <div className="absolute right-0 z-50 mt-2 w-56 border border-line bg-surface py-1">
                    {entities.map((e) => (
                      <button
                        key={e.id}
                        onClick={() => { setShowEntityMenu(false); if (e.id !== activeEntity?.id) setActiveEntityId(e.id) }}
                        className={`block w-full text-left px-4 py-2 text-sm transition-colors duration-200 ${e.id === activeEntity?.id ? 'text-ink' : 'text-body hover:bg-sunken'}`}
                      >
                        <span className="font-medium">{e.name}</span>
                        <span className="label ml-2 inline">{e.entity_type}</span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}

            {/* Theme Toggle */}
            <button
              onClick={toggleTheme}
              aria-label="Toggle theme"
              className="p-2 text-muted transition-colors duration-200 hover:text-ink"
            >
              {theme === 'dark' ? (
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 3v1m0 16v1m9-9h-1M4 12H3m15.364 6.364l-.707-.707M6.343 6.343l-.707-.707m12.728 0l-.707.707M6.343 17.657l-.707.707M16 12a4 4 0 11-8 0 4 4 0 018 0z" />
                </svg>
              ) : (
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M20.354 15.354A9 9 0 018.646 3.646 9.003 9.003 0 0012 21a9.003 9.003 0 008.354-5.646z" />
                </svg>
              )}
            </button>

            {/* User Menu */}
            <div className="relative">
              <button
                onClick={() => setShowUserMenu(!showUserMenu)}
                className="flex items-center space-x-2 px-3 py-2 text-sm text-body transition-colors duration-200 hover:text-ink focus:outline-none"
              >
                <div className="flex h-8 w-8 items-center justify-center border border-line-strong">
                  <span className="font-mono text-xs text-body">
                    {user?.first_name?.[0]}{user?.last_name?.[0]}
                  </span>
                </div>
                <span className="hidden lg:block">{user?.first_name} {user?.last_name}</span>
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                </svg>
              </button>

              {showUserMenu && (
                <div className="absolute right-0 z-50 mt-2 w-52 border border-line bg-surface py-1">
                  <div className="border-b border-line px-4 py-3 text-sm">
                    <div className="font-medium text-ink">{user?.first_name} {user?.last_name}</div>
                    <div className="mt-0.5 text-xs text-muted">{user?.email}</div>
                    <div className="label mt-1.5">Default {user?.default_currency}</div>
                  </div>
                  <Link
                    to="/settings"
                    onClick={() => setShowUserMenu(false)}
                    className="block w-full px-4 py-2 text-left text-sm text-body transition-colors duration-200 hover:bg-sunken hover:text-ink"
                  >
                    <svg className="w-4 h-4 inline mr-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                    </svg>
                    Settings
                  </Link>
                  <button
                    onClick={() => {
                      logout()
                      setShowUserMenu(false)
                    }}
                    className="block w-full px-4 py-2 text-left text-sm text-body transition-colors duration-200 hover:bg-sunken hover:text-ink"
                  >
                    <svg className="w-4 h-4 inline mr-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1" />
                    </svg>
                    Sign out
                  </button>
                </div>
              )}
            </div>

            {/* Hamburger – only on medium screens where desktop nav is hidden but bottom nav is too */}
            {/* Hidden on mobile (sm:hidden) since BottomNav handles nav; hidden on sm+ since desktop nav links show */}
            <div className="hidden">
              <button
                type="button"
                onClick={() => setShowMobileMenu(!showMobileMenu)}
                className="inline-flex items-center justify-center p-2 text-muted transition-colors duration-200 hover:text-ink focus:outline-none"
              >
                <span className="sr-only">Open main menu</span>
                {showMobileMenu ? (
                  <svg className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                  </svg>
                ) : (
                  <svg className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" />
                  </svg>
                )}
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* Mobile menu dropdown */}
      {showMobileMenu && (
        <div className="space-y-1 border-t border-line bg-surface px-4 pb-4 pt-2 sm:hidden">
          <Link to="/" className={mobileNavLinkBase} activeProps={{ className: mobileNavLinkActive }} onClick={() => setShowMobileMenu(false)}>
            <svg className="w-5 h-5 mr-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2H5a2 2 0 00-2-2z" />
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 5a2 2 0 012-2h4a2 2 0 012 2v2H8V5z" />
            </svg>
            Dashboard
          </Link>
          <Link to="/accounts" className={mobileNavLinkBase} activeProps={{ className: mobileNavLinkActive }} onClick={() => setShowMobileMenu(false)}>
            <svg className="w-5 h-5 mr-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 21V5a2 2 0 00-2-2H7a2 2 0 00-2 2v16m14 0h2m-2 0h-5m-9 0H3m2 0h5M9 7h1m-1 4h1m4-4h1m-1 4h1m-5 10v-5a1 1 0 011-1h2a1 1 0 011 1v5m-4 0h4" />
            </svg>
            Accounts
          </Link>
          <Link to="/transactions" className={mobileNavLinkBase} activeProps={{ className: mobileNavLinkActive }} onClick={() => setShowMobileMenu(false)}>
            <svg className="w-5 h-5 mr-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5H7a2 2 0 00-2 2v10a2 2 0 002 2h8a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-3 7h3m-3 4h3m-6-4h.01M9 16h.01" />
            </svg>
            Transactions
          </Link>
          <Link to="/allocations" className={mobileNavLinkBase} activeProps={{ className: mobileNavLinkActive }} onClick={() => setShowMobileMenu(false)}>
            <svg className="w-5 h-5 mr-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" />
            </svg>
            Allocations
          </Link>
          <div className="border-t border-line pt-2">
            <div className="px-3 py-2 text-sm text-muted">
              <div className="font-medium text-ink">{user?.first_name} {user?.last_name}</div>
              <div className="text-xs mt-0.5">{user?.email}</div>
            </div>
            <button
              onClick={() => { logout(); setShowMobileMenu(false) }}
              className="flex w-full items-center px-3 py-3 text-base text-danger transition-colors duration-200 hover:bg-sunken"
            >
              <svg className="w-5 h-5 mr-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1" />
              </svg>
              Sign out
            </button>
          </div>
        </div>
      )}
    </nav>
  )
}
