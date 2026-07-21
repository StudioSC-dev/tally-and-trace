import { Link } from '@tanstack/react-router'

// ── Icon helpers ───────────────────────────────────────────────────────────────

function HomeIcon({ active }: { active?: boolean }) {
  return (
    <svg className={`w-6 h-6 ${active ? 'text-ink' : 'text-muted'}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={active ? 2.5 : 2} d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2H5a2 2 0 00-2-2z" />
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={active ? 2.5 : 2} d="M8 5a2 2 0 012-2h4a2 2 0 012 2v2H8V5z" />
    </svg>
  )
}

function AccountsIcon({ active }: { active?: boolean }) {
  return (
    <svg className={`w-6 h-6 ${active ? 'text-ink' : 'text-muted'}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={active ? 2.5 : 2} d="M19 21V5a2 2 0 00-2-2H7a2 2 0 00-2 2v16m14 0h2m-2 0h-5m-9 0H3m2 0h5M9 7h1m-1 4h1m4-4h1m-1 4h1m-5 10v-5a1 1 0 011-1h2a1 1 0 011 1v5m-4 0h4" />
    </svg>
  )
}

function TransactionsIcon({ active }: { active?: boolean }) {
  return (
    <svg className={`w-6 h-6 ${active ? 'text-ink' : 'text-muted'}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={active ? 2.5 : 2} d="M7 16V4m0 0L3 8m4-4l4 4M17 8v12m0 0l4-4m-4 4l-4-4" />
    </svg>
  )
}

function AllocationsIcon({ active }: { active?: boolean }) {
  return (
    <svg className={`w-6 h-6 ${active ? 'text-ink' : 'text-muted'}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={active ? 2.5 : 2} d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" />
    </svg>
  )
}

// ── Component ─────────────────────────────────────────────────────────────────

interface TabItem {
  to: string
  label: string
  Icon: React.FC<{ active?: boolean }>
}

const TABS: TabItem[] = [
  { to: '/',            label: 'Home',         Icon: HomeIcon },
  { to: '/accounts',   label: 'Accounts',     Icon: AccountsIcon },
  { to: '/transactions', label: 'Transactions', Icon: TransactionsIcon },
  { to: '/allocations', label: 'Goals',        Icon: AllocationsIcon },
]

const tabBase =
  'relative flex flex-1 flex-col items-center justify-center gap-1 text-muted transition-colors duration-150 active:bg-sunken'

export function BottomNav() {
  return (
    // Only visible on mobile – hides at sm (640 px) and above
    <nav className="safe-area-bottom fixed bottom-0 left-0 right-0 z-50 border-t border-line bg-surface sm:hidden">
      <div className="flex h-16 items-stretch">
        {TABS.map(({ to, label, Icon }) => (
          <Link
            key={to}
            to={to}
            className={tabBase}
            activeProps={{ className: `${tabBase} text-ink` }}
          >
            {({ isActive }) => (
              <>
                {/* Active state is a rule above the tab plus ink weight — the
                    blue-on-white fill was the only saturated colour on mobile. */}
                <span
                  aria-hidden
                  className={`absolute inset-x-0 top-0 h-px ${isActive ? 'bg-ink' : 'bg-transparent'}`}
                />
                <Icon active={isActive} />
                <span className="label">{label}</span>
              </>
            )}
          </Link>
        ))}
      </div>
    </nav>
  )
}
