import { describe, expect, it, vi } from 'vitest'

// STU-658 AC4: the Home screen's upcoming list shows each occurrence's amount as the API sends it,
// so an installment's last payment (its final_amount) reads differently from the others. Renderer-free,
// as in more.wishlist-badge.test.tsx: native components are names and the tree is walked.
const h = vi.hoisted(() => ({ snapshot: null as unknown }))

vi.mock('react-native', () => {
  const host = (name: string) => name
  return { ScrollView: host('ScrollView'), View: host('View'), Text: host('Text'), RefreshControl: host('RefreshControl') }
})
vi.mock('react-native-safe-area-context', () => ({ SafeAreaView: 'SafeAreaView' }))
vi.mock('../contexts/AuthContext', () => ({ useAuth: () => ({ user: { default_currency: 'PHP' } }) }))
vi.mock('../store/api', () => ({
  useGetDashboardSnapshotQuery: () => ({ data: h.snapshot, isLoading: false, isFetching: false, refetch: vi.fn() }),
}))
vi.mock('../components/ui', () => {
  const host = (name: string) => name
  return { Card: host('Card'), SectionHeader: host('SectionHeader'), LoadingSpinner: host('LoadingSpinner'), Badge: host('Badge'), AmountText: host('AmountText') }
})

import HomeScreen from '../../app/(tabs)/index'

type El = { type?: unknown; props?: Record<string, unknown> }
const walk = (node: unknown, out: El[] = []): El[] => {
  if (node == null || typeof node !== 'object') return out
  if (Array.isArray(node)) { node.forEach((n) => walk(n, out)); return out }
  out.push(node as El)
  walk((node as El).props?.children, out)
  return out
}
const textOf = (el: El): string => {
  const children = el.props?.children
  return (Array.isArray(children) ? children : [children]).filter((c) => typeof c === 'string' || typeof c === 'number').join('')
}

const full = (due: string, amount: number) => ({
  view: 'full', due_date: due, occurrence_date: due, name: 'Laptop', amount, currency: 'PHP',
  source: 'budget_entry', source_id: 7, entry_type: 'expense', cash_delta: 0,
})
const household = (date: string, amount: number) => ({
  view: 'limited', date, display_name: 'Household bill', kind: 'household', face_amount: amount, cash_delta: 0, currency: 'PHP',
})

describe('mobile_occurrence_amounts', () => {
  it('lists the API amount of each occurrence, the last payment included', () => {
    h.snapshot = {
      balances: { by_currency: [], by_account: [] }, upcoming_this_month: [
        full('2026-12-15', 3333.33), full('2027-01-15', 3333.33), full('2027-02-15', 3333.34),
        household('2026-12-15', 3333.33), household('2027-02-15', 3333.34),
      ],
      monthly_summary: null, wishlist_next_up: [], fx: undefined,
    }
    const tree = walk(HomeScreen())
    const shown = tree.filter((el) => el.type === 'Text').map(textOf).filter((t) => t.startsWith('₱'))
    expect(shown).toEqual(['₱3,333.33', '₱3,333.33', '₱3,333.34'])
    const limited = tree.filter((el) => el.type === 'AmountText').map((el) => el.props?.amount)
    expect(limited).toEqual([3333.33, 3333.34])
  })
})
