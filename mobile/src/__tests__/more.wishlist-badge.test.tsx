import { beforeEach, describe, expect, it, vi } from 'vitest'

// Same renderer-free approach as transfers.test.tsx: useState is a slot store and native components are names.
const h = vi.hoisted(() => ({
  slots: [] as unknown[],
  idx: 0,
  items: [] as unknown[],
  created: [] as unknown[],
}))

vi.mock('react', async (orig) => ({
  ...(await orig<typeof import('react')>()),
  useState: (init: unknown) => {
    const i = h.idx++
    if (!(i in h.slots)) h.slots[i] = typeof init === 'function' ? (init as () => unknown)() : init
    return [h.slots[i], (v: unknown) => { h.slots[i] = typeof v === 'function' ? (v as (p: unknown) => unknown)(h.slots[i]) : v }]
  },
}))
vi.mock('react-native', () => {
  const host = (name: string) => name
  return {
    ScrollView: host('ScrollView'), View: host('View'), Text: host('Text'), TouchableOpacity: host('TouchableOpacity'),
    Modal: host('Modal'), RefreshControl: host('RefreshControl'), Alert: { alert: vi.fn() },
  }
})
vi.mock('react-native-safe-area-context', () => ({ SafeAreaView: 'SafeAreaView' }))
vi.mock('../contexts/AuthContext', () => ({ useAuth: () => ({ user: { default_currency: 'PHP' } }) }))
vi.mock('../store/api', () => ({
  useGetBudgetEntriesQuery: () => ({}),
  useDeleteBudgetEntryMutation: () => [vi.fn()],
  useGetCategoriesQuery: () => ({}),
  useCreateCategoryMutation: () => [vi.fn()],
  useDeleteCategoryMutation: () => [vi.fn()],
  useGetWishlistItemsQuery: () => ({ data: { items: h.items }, isLoading: false, isFetching: false, refetch: vi.fn() }),
  useCreateWishlistItemMutation: () => [(d: unknown) => (h.created.push(d), { unwrap: async () => ({}) })],
  useDeleteWishlistItemMutation: () => [vi.fn()],
}))
vi.mock('../components/ui', () => {
  const host = (name: string) => name
  return {
    Card: host('Card'), Button: host('Button'), Input: host('Input'), LoadingSpinner: host('LoadingSpinner'),
    EmptyState: host('EmptyState'), Badge: host('Badge'), SectionHeader: host('SectionHeader'),
  }
})

import MoreScreen from '../../app/(tabs)/more'

type El = { type?: unknown; props?: Record<string, unknown> }
const walk = (node: unknown, out: El[] = []): El[] => {
  if (node == null || typeof node !== 'object') return out
  if (Array.isArray(node)) { node.forEach((n) => walk(n, out)); return out }
  out.push(node as El)
  walk((node as El).props?.children, out)
  return out
}

// Renders MoreScreen on the wishlist section, then expands the WishlistSection element it returns.
// Slots: 0 section, 1 showForm, 2 form.
function renderWishlist(slots: unknown[] = ['wishlist']) {
  h.slots = [...slots]
  h.idx = 0
  const tree = (MoreScreen as unknown as () => unknown)()
  const section = walk(tree).find((n) => typeof n.type === 'function')!
  return (section.type as (p: unknown) => unknown)(section.props)
}
const badges = () => walk(renderWishlist()).filter((n) => n.type === 'Badge').map((n) => n.props!)
const item = (id: number, is_purchased: boolean) => ({
  id, user_id: 1, name: `Item ${id}`, estimated_cost: 100, currency: 'PHP', priority: 'medium',
  is_purchased, created_at: '2026-01-01T00:00:00Z',
})

beforeEach(() => { h.items = []; h.created = [] })

describe('more wishlist badge', () => {
  it('purchased_badge', () => {
    h.items = [item(1, true)]
    expect(badges()).toEqual([{ label: '✓ Purchased', color: 'green' }])
  })

  it('saving_badge', () => {
    h.items = [item(2, false)]
    expect(badges()).toEqual([{ label: 'Saving', color: 'yellow' }])
  })

  it('wishlist_writes_purchased_state', async () => {
    const tree = renderWishlist(['wishlist', true, { name: ' Desk ', estimated_cost: '250.5', priority: 'high' }])
    const add = walk(tree).find((n) => n.type === 'Button' && n.props?.label === 'Add')!
    await (add.props!.onPress as () => Promise<void>)()
    expect(h.created).toHaveLength(1)
    const sent = JSON.parse(JSON.stringify(h.created[0]))
    expect(sent).toEqual({ name: 'Desk', estimated_cost: 250.5, priority: 'high', currency: 'PHP', is_purchased: false })
    expect(Object.keys(sent).sort()).toEqual(['currency', 'estimated_cost', 'is_purchased', 'name', 'priority'])
  })
})
