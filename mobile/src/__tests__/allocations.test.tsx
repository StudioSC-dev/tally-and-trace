import { beforeEach, describe, expect, it, vi } from 'vitest'

// Same renderer-free harness as transfers.test.tsx: useState is a per-mount slot store, native
// components are their own names, and each action re-renders so handlers are never stale.
const h = vi.hoisted(() => ({
  slots: [] as unknown[],
  idx: 0,
  alerts: [] as Array<{ title: string; message: string }>,
  create: [] as Array<Record<string, unknown>>,
  update: [] as Array<{ id: number; data: Record<string, unknown> }>,
  fail: false,
  allocations: [] as unknown[],
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
    FlatList: host('FlatList'), View: host('View'), Text: host('Text'), TouchableOpacity: host('TouchableOpacity'),
    RefreshControl: host('RefreshControl'), Modal: host('Modal'), ScrollView: host('ScrollView'),
    Alert: { alert: (title: string, message: string) => h.alerts.push({ title, message }) },
  }
})
vi.mock('react-native-safe-area-context', () => ({ SafeAreaView: 'SafeAreaView' }))
vi.mock('../store/api', () => ({
  useGetAllocationsQuery: () => ({ data: { items: h.allocations }, isLoading: false, isFetching: false, refetch: vi.fn() }),
  useGetAccountsQuery: () => ({ data: { items: [] } }),
  useCreateAllocationMutation: () => [
    (d: Record<string, unknown>) => (h.create.push(d), { unwrap: async () => { if (h.fail) throw new Error('x'); return {} } }),
    { isLoading: false },
  ],
  useUpdateAllocationMutation: () => [
    (a: { id: number; data: Record<string, unknown> }) => (h.update.push(a), { unwrap: async () => { if (h.fail) throw new Error('x'); return {} } }),
    { isLoading: false },
  ],
  useDeleteAllocationMutation: () => [vi.fn(), { isLoading: false }],
}))
vi.mock('../contexts/AuthContext', () => ({ useAuth: () => ({ user: { default_currency: 'PHP' } }) }))
vi.mock('../components/ui', () => {
  const host = (name: string) => name
  return {
    Card: host('Card'), Button: host('Button'), Input: host('Input'), LoadingSpinner: host('LoadingSpinner'),
    EmptyState: host('EmptyState'), Badge: host('Badge'), SectionHeader: host('SectionHeader'),
  }
})

import AllocationsScreen, { AllocationFormModal } from '../../app/(tabs)/allocations'

type El = { type?: unknown; props?: Record<string, unknown> }
// Expands plain function components (e.g. ProgressBar) so their output is searchable too.
const walk = (node: unknown, out: El[] = []): El[] => {
  if (node == null || typeof node !== 'object') return out
  if (Array.isArray(node)) { node.forEach((n) => walk(n, out)); return out }
  const el = node as El
  out.push(el)
  if (typeof el.type === 'function') walk((el.type as (p: unknown) => unknown)(el.props), out)
  walk(el.props?.children, out)
  return out
}
const strings = (node: unknown, out: string[] = []): string[] => {
  if (typeof node === 'string' || typeof node === 'number') { out.push(String(node)); return out }
  if (node == null || typeof node !== 'object') return out
  if (Array.isArray(node)) { node.forEach((n) => strings(n, out)); return out }
  const el = node as El
  if (typeof el.type === 'function') strings((el.type as (p: unknown) => unknown)(el.props), out)
  strings(el.props?.children, out)
  return out
}

const ACCOUNTS = [
  { id: 1, name: 'Cash PHP' },
  { id: 2, name: 'Savings PHP' },
]

function mount(extra: Record<string, unknown> = {}) {
  h.slots = []
  let closed = 0
  const props = { visible: true, onClose: () => { closed++ }, accounts: ACCOUNTS, defaultCurrency: 'PHP', ...extra }
  const render = () => { h.idx = 0; return (AllocationFormModal as unknown as (p: typeof props) => unknown)(props) }
  const find = (id: string) => walk(render()).find((n) => n.props?.testID === id)
  const byLabel = (label: string) => walk(render()).find((n) => n.props?.label === label)
  return {
    press: (id: string) => (find(id)!.props!.onPress as () => void)(),
    type: (label: string, v: string) => (byLabel(label)!.props!.onChangeText as (v: string) => void)(v),
    byLabel,
    hasAccountPicker: () => find('account-picker') !== undefined,
    closed: () => closed,
    submit: async () => { await (find('submit')!.props!.onPress as () => Promise<void>)() },
  }
}
const lastAlert = () => h.alerts[h.alerts.length - 1]

function cardTexts(allocation: Record<string, unknown>): string {
  h.allocations = [allocation]
  h.slots = []
  h.idx = 0
  return strings((AllocationsScreen as unknown as () => unknown)()).join('|')
}

beforeEach(() => {
  h.alerts = []; h.create = []; h.update = []; h.fail = false; h.allocations = []
})

describe('mobile allocations form', () => {
  it('creates_budget_without_spent_or_account', async () => {
    const ui = mount({ accounts: [] })
    ui.press('type-budget')
    expect(ui.byLabel('Current Amount')).toBeUndefined()
    expect(ui.hasAccountPicker()).toBe(false)
    ui.type('Name', '  Groceries ')
    ui.type('Description (optional)', 'Food')
    ui.type('Target Amount (optional)', '5000')
    await ui.submit()
    expect(h.create).toHaveLength(1)
    expect(h.create[0]).toEqual({ name: 'Groceries', allocation_type: 'budget', description: 'Food', target_amount: 5000, currency: 'PHP' })
    expect('current_amount' in h.create[0]).toBe(false)
    expect('account_id' in h.create[0]).toBe(false)
    expect(ui.closed()).toBe(1)
  })

  it('edits_accountless_budget_without_defaulting_to_first_account', async () => {
    const initial = { id: 7, name: 'Rent', allocation_type: 'budget', account_id: null, current_amount: 300, target_amount: 1000, currency: 'PHP' }
    const ui = mount({ initial })
    expect(ui.hasAccountPicker()).toBe(false)
    expect(ui.byLabel('Current Amount')).toBeUndefined()
    await ui.submit()
    expect(h.update).toHaveLength(1)
    expect(h.update[0].id).toBe(7)
    expect(h.update[0].data).toEqual({ name: 'Rent', allocation_type: 'budget', description: undefined, target_amount: 1000, currency: 'PHP' })
    expect('current_amount' in h.update[0].data).toBe(false)
    expect('account_id' in h.update[0].data).toBe(false)
    expect(ui.closed()).toBe(1)
  })

  it('keeps_savings_and_goal_fields_and_payloads_when_switching_type', async () => {
    const ui = mount()
    ui.press('type-budget')
    expect(ui.hasAccountPicker()).toBe(false)
    ui.press('type-goal')
    expect(ui.hasAccountPicker()).toBe(true)
    expect(ui.byLabel('Current Amount')).toBeDefined()
    ui.type('Name', 'Trip')
    ui.type('Current Amount', '250')
    ui.press('account-2')
    await ui.submit()
    expect(h.create[0]).toEqual({
      name: 'Trip', allocation_type: 'goal', description: undefined, target_amount: undefined, current_amount: 250, account_id: 2, currency: 'PHP',
    })
    // Savings still needs an account, and a budget does not.
    h.create = []
    const none = mount({ accounts: [] })
    none.type('Name', 'Fund')
    await none.submit()
    expect(h.create).toHaveLength(0)
    expect(lastAlert().message).toBe('Name and account are required.')
    none.press('type-budget')
    await none.submit()
    expect(h.create).toHaveLength(1)
    expect(h.create[0].allocation_type).toBe('budget')
    const sav = mount()
    sav.press('type-savings')
    sav.type('Name', 'Rainy day')
    await sav.submit()
    expect(h.create[1]).toMatchObject({ allocation_type: 'savings', current_amount: 0, account_id: 1 })
  })

  it('rejects_budget_with_blank_name', async () => {
    const ui = mount({ accounts: [] })
    ui.press('type-budget')
    ui.type('Name', '   ')
    await ui.submit()
    expect(h.create).toHaveLength(0)
    expect(lastAlert().message).toBe('Name is required.')
    expect(ui.closed()).toBe(0)
  })

  it('keeps_budget_form_open_after_save_failure', async () => {
    h.fail = true
    const ui = mount({ accounts: [] })
    ui.press('type-budget')
    ui.type('Name', 'Groceries')
    await ui.submit()
    expect(h.create).toHaveLength(1)
    expect(lastAlert().message).toBe('Could not save allocation.')
    expect(ui.closed()).toBe(0)
  })
})

describe('mobile allocations cards', () => {
  const base = { id: 1, name: 'Thing', currency: 'PHP', account_id: null }

  it('shows_api_budget_spent_against_target', () => {
    const text = cardTexts({ ...base, allocation_type: 'budget', current_amount: 1250, target_amount: 5000 })
    expect(text).toContain('1,250')
    expect(text).toMatch(/25\|%/)
    expect(text).toContain('5,000')
  })

  it('shows_api_budget_spent_without_a_positive_target', () => {
    for (const target_amount of [undefined, 0]) {
      const text = cardTexts({ ...base, allocation_type: 'budget', current_amount: 1250, target_amount })
      expect(text).toContain('1,250')
      expect(text).not.toContain('%')
      expect(text).not.toContain('of ')
      expect(text).not.toMatch(/\|0\|/)
    }
  })

  it('keeps_savings_and_goal_card_amounts_and_progress', () => {
    for (const allocation_type of ['savings', 'goal']) {
      const text = cardTexts({ ...base, allocation_type, current_amount: 500, target_amount: 2000 })
      expect(text).toContain('500')
      expect(text).toMatch(/25\|%/)
      expect(text).toContain('2,000')
    }
  })
})
