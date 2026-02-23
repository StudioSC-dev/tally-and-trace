import { Link } from '@tanstack/react-router'

// ── Icon helpers ───────────────────────────────────────────────────────────────

function HomeIcon({ active }: { active?: boolean }) {
  return (
    <svg className={`w-6 h-6 ${active ? 'text-blue-500 dark:text-blue-400' : 'text-gray-500 dark:text-slate-400'}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={active ? 2.5 : 2} d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2H5a2 2 0 00-2-2z" />
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={active ? 2.5 : 2} d="M8 5a2 2 0 012-2h4a2 2 0 012 2v2H8V5z" />
    </svg>
  )
}

function AccountsIcon({ active }: { active?: boolean }) {
  return (
    <svg className={`w-6 h-6 ${active ? 'text-blue-500 dark:text-blue-400' : 'text-gray-500 dark:text-slate-400'}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={active ? 2.5 : 2} d="M19 21V5a2 2 0 00-2-2H7a2 2 0 00-2 2v16m14 0h2m-2 0h-5m-9 0H3m2 0h5M9 7h1m-1 4h1m4-4h1m-1 4h1m-5 10v-5a1 1 0 011-1h2a1 1 0 011 1v5m-4 0h4" />
    </svg>
  )
}

function TransactionsIcon({ active }: { active?: boolean }) {
  return (
    <svg className={`w-6 h-6 ${active ? 'text-blue-500 dark:text-blue-400' : 'text-gray-500 dark:text-slate-400'}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={active ? 2.5 : 2} d="M7 16V4m0 0L3 8m4-4l4 4M17 8v12m0 0l4-4m-4 4l-4-4" />
    </svg>
  )
}

function AllocationsIcon({ active }: { active?: boolean }) {
  return (
    <svg className={`w-6 h-6 ${active ? 'text-blue-500 dark:text-blue-400' : 'text-gray-500 dark:text-slate-400'}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
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

export function BottomNav() {
  return (
    // Only visible on mobile – hides at sm (640 px) and above
    <nav className="sm:hidden fixed bottom-0 left-0 right-0 z-50 bg-white dark:bg-slate-900 border-t border-gray-200 dark:border-slate-800 safe-area-bottom">
      <div className="flex items-stretch h-16">
        {TABS.map(({ to, label, Icon }) => (
          <Link
            key={to}
            to={to}
            className="flex-1 flex flex-col items-center justify-center gap-0.5 text-xs font-semibold text-gray-500 dark:text-slate-400 transition-colors duration-150 active:bg-gray-100 dark:active:bg-slate-800"
            activeProps={{
              className: 'flex-1 flex flex-col items-center justify-center gap-0.5 text-xs font-semibold text-blue-500 dark:text-blue-400 transition-colors duration-150 active:bg-gray-100 dark:active:bg-slate-800',
            }}
          >
            {({ isActive }) => (
              <>
                <Icon active={isActive} />
                <span className={isActive ? 'text-blue-500 dark:text-blue-400' : ''}>{label}</span>
              </>
            )}
          </Link>
        ))}
      </div>
    </nav>
  )
}
