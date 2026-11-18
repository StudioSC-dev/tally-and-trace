import { Link } from '@tanstack/react-router'
import { Icon } from './Icon'
import type { IconName } from './Icon'

// ── Component ─────────────────────────────────────────────────────────────────

interface TabItem {
  to: string
  label: string
  // Tour target marker, shared with the matching desktop nav link
  onboarding: string
  // The same icon as the matching top-bar link; the active tab differs by colour only.
  icon: IconName
}

// Each label is the destination page's title, the same name the top bar uses.
const TABS: TabItem[] = [
  { to: '/',            label: 'Dashboard',    onboarding: 'nav-home',         icon: 'home' },
  { to: '/accounts',   label: 'Accounts',     onboarding: 'nav-accounts',     icon: 'accounts' },
  { to: '/transactions', label: 'Transactions', onboarding: 'nav-transactions', icon: 'transactions' },
  { to: '/allocations', label: 'Allocations',  onboarding: 'nav-allocations',  icon: 'allocations' },
]

const tabBase =
  'relative flex flex-1 flex-col items-center justify-center gap-1 transition-colors duration-150 active:bg-sunken'

export function BottomNav() {
  return (
    // Only visible on mobile – hides at sm (640 px) and above
    <nav className="safe-area-bottom fixed bottom-0 left-0 right-0 z-50 border-t border-line bg-surface sm:hidden">
      <div className="flex h-16 items-stretch">
        {TABS.map(({ to, label, onboarding, icon }) => (
          <Link
            key={to}
            to={to}
            data-onboarding={onboarding}
            className={tabBase}
            activeOptions={{ exact: to === '/' }}
            activeProps={{ className: 'text-ink' }}
            inactiveProps={{ className: 'text-muted' }}
          >
            {({ isActive }) => (
              <>
                {/* Active state is a rule above the tab plus ink weight — the
                    blue-on-white fill was the only saturated colour on mobile. */}
                <span
                  aria-hidden
                  className={`absolute inset-x-0 top-0 h-px ${isActive ? 'bg-ink' : 'bg-transparent'}`}
                />
                <Icon name={icon} />
                <span className="label text-[length:min(0.6875rem,11px)]">{label}</span>
              </>
            )}
          </Link>
        ))}
      </div>
    </nav>
  )
}
