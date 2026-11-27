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
  accounts: [] as unknown[],
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
  useGetAccountsQuery: () => ({ data: { items: h.accounts } }),
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
const walk = (node: unknown, out: El[] = [], skip?: unknown): El[] => {
  if (node == null || typeof node !== 'object') return out
  if (Array.isArray(node)) { node.forEach((n) => walk(n, out, skip)); return out }
  const el = node as El
  out.push(el)
  if (typeof el.type === 'function' && el.type !== skip) walk((el.type as (p: unknown) => unknown)(el.props), out, skip)
  walk(el.props?.children, out, skip)
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

type Form = {
  press: (id: string) => void
  type: (label: string, v: string) => void
  byLabel: (label: string) => El | undefined
  hasAccountPicker: () => boolean
  closed: () => number
  submit: () => Promise<void>
}

const ACCOUNTS = [
  { id: 1, name: 'Cash PHP' },
  { id: 2, name: 'Savings PHP' },
]

function mount(extra: Record<string, unknown> = {}): Form {
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
// Renders the whole screen like React would: the form's key decides whether its state survives,
// and a changed key remounts it (its useState slots are dropped).
function mountScreen(): Form & { edit: (name: string) => void } {
  h.slots = []
  let closeCalls = 0
  let lastKey: unknown = undefined
  let seen = false
  const render = () => {
    h.idx = 0
    const tree = (AllocationsScreen as unknown as () => unknown)()
    const all = walk(tree, [], AllocationFormModal)
    const modal = all.find((n) => n.type === AllocationFormModal) as (El & { key?: unknown }) | undefined
    if (!modal) throw new Error('form not rendered')
    const base = h.idx
    if (seen && modal.key !== lastKey) h.slots.length = base
    seen = true
    lastKey = modal.key
    const props = { ...modal.props, onClose: () => { closeCalls++; (modal.props!.onClose as () => void)() } }
    const form = walk((AllocationFormModal as unknown as (p: unknown) => unknown)(props))
    return { cards: all, form }
  }
  const find = (id: string) => render().form.find((n) => n.props?.testID === id)
  const byLabel = (label: string) => render().form.find((n) => n.props?.label === label)
  return {
    edit: (name: string) => {
      const card = render().cards.find((n) => strings(n).includes(name) && strings(n).includes('✏️ Edit') && n.props?.className === 'mb-3')
      const edit = walk(card, [], AllocationFormModal).find((n) => n.type === 'TouchableOpacity' && strings(n).includes('✏️ Edit'))
      ;(edit!.props!.onPress as () => void)()
    },
    press: (id: string) => (find(id)!.props!.onPress as () => void)(),
    type: (label: string, v: string) => (byLabel(label)!.props!.onChangeText as (v: string) => void)(v),
    byLabel,
    hasAccountPicker: () => find('account-picker') !== undefined,
    closed: () => closeCalls,
    submit: async () => { await (find('submit')!.props!.onPress as () => Promise<void>)() },
  }
}
const lastAlert = () => h.alerts[h.alerts.length - 1]

function renderCards(allocation: Record<string, unknown>) {
  h.allocations = [allocation]
  h.slots = []
  h.idx = 0
  const tree = (AllocationsScreen as unknown as () => unknown)()
  // The form modal is hidden here and not part of a card, so it is not expanded.
  const widths = walk(tree, [], AllocationFormModal)
    .map((n) => (n.props?.style as { width?: string } | undefined)?.width)
    .filter((w): w is string => typeof w === 'string')
  const cardText = strings(walk(tree, [], AllocationFormModal).filter((n) => n.props?.className === 'mb-3')).join('|')
  return { text: cardText, widths }
}

beforeEach(() => {
  h.alerts = []; h.create = []; h.update = []; h.fail = false; h.allocations = []; h.accounts = []
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
    h.allocations = [{ id: 7, name: 'Rent', allocation_type: 'budget', account_id: null, current_amount: 300, target_amount: 1000, currency: 'PHP' }]
    const ui = mountScreen()
    ui.edit('Rent')
    expect((ui.byLabel('Name')!.props as { value: string }).value).toBe('Rent')
    expect((ui.byLabel('Target Amount (optional)')!.props as { value: string }).value).toBe('1000')
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

  it('edits_accountless_savings_falling_back_to_first_account', async () => {
    h.accounts = ACCOUNTS.map((a) => ({ ...a, my_role: 'owner' }))
    h.allocations = [{ id: 8, name: 'Fund', allocation_type: 'savings', account_id: null, current_amount: 40, currency: 'PHP' }]
    const ui = mountScreen()
    ui.edit('Fund')
    expect(ui.hasAccountPicker()).toBe(true)
    await ui.submit()
    expect(h.update[0].data).toMatchObject({ allocation_type: 'savings', current_amount: 40, account_id: 1 })
  })

  it('keeps_savings_and_goal_fields_and_payloads_when_switching_type', async () => {
    for (const type of ['savings', 'goal'] as const) {
      h.create = []
      h.alerts = []
      const noAccounts = mount({ accounts: [] })
      noAccounts.press('type-budget')
      noAccounts.press(`type-${type}`)
      expect(noAccounts.byLabel('Current Amount')).toBeDefined()
      expect(noAccounts.hasAccountPicker()).toBe(true)
      noAccounts.type('Name', 'Fund')
      await noAccounts.submit()
      expect(h.create).toHaveLength(0)
      expect(lastAlert().message).toBe('Name and account are required.')

      const ui = mount()
      ui.press('type-budget')
      ui.press(`type-${type}`)
      ui.type('Name', 'Trip')
      ui.type('Current Amount', '250')
      ui.press('account-2')
      await ui.submit()
      expect(h.create[0]).toEqual({
        name: 'Trip', allocation_type: type, description: undefined, target_amount: undefined, current_amount: 250, account_id: 2, currency: 'PHP',
      })

      // A filled-in form switched to Budget drops both fields from the request.
      h.create = []
      const sw = mount()
      sw.press(`type-${type}`)
      sw.type('Name', 'Trip')
      sw.type('Current Amount', '250')
      sw.press('account-2')
      sw.press('type-budget')
      expect(sw.byLabel('Current Amount')).toBeUndefined()
      expect(sw.hasAccountPicker()).toBe(false)
      await sw.submit()
      expect(h.create[0]).toEqual({ name: 'Trip', allocation_type: 'budget', description: undefined, target_amount: undefined, currency: 'PHP' })
      expect('current_amount' in h.create[0]).toBe(false)
      expect('account_id' in h.create[0]).toBe(false)
    }
    // Default savings form still picks the first account and a zero amount.
    h.create = []
    const sav = mount()
    sav.type('Name', 'Rainy day')
    await sav.submit()
    expect(h.create[0]).toMatchObject({ allocation_type: 'savings', current_amount: 0, account_id: 1 })
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
    const { text, widths } = renderCards({ ...base, allocation_type: 'budget', current_amount: 1250, target_amount: 5000 })
    expect(text).toContain('1,250')
    expect(text).toMatch(/25\|%/)
    expect(text).toContain('5,000')
    expect(widths).toEqual(['25%'])
  })

  it('shows_api_budget_spent_without_a_positive_target', () => {
    for (const target_amount of [undefined, null, 0]) {
      const { text, widths } = renderCards({ ...base, allocation_type: 'budget', current_amount: 1250, target_amount })
      expect(text).toContain('1,250')
      expect(text).not.toContain('%')
      expect(text).not.toContain('of ')
      expect(text).not.toMatch(/\|0\|/)
      expect(widths).toEqual([])
    }
  })

  it('keeps_savings_and_goal_card_amounts_and_progress', () => {
    for (const allocation_type of ['savings', 'goal']) {
      const { text, widths } = renderCards({ ...base, allocation_type, current_amount: 500, target_amount: 2000 })
      expect(text).toContain('500')
      expect(text).toMatch(/25\|%/)
      expect(text).toContain('2,000')
      expect(widths).toEqual(['25%'])
      // No limit, or a zero limit: the amount stays, the progress comparison and the stray 0 do not.
      for (const target_amount of [undefined, null, 0]) {
        const none = renderCards({ ...base, allocation_type, current_amount: 500, target_amount })
        expect(none.text).toContain('500')
        expect(none.text).not.toMatch(/\|0\|/)
        expect(none.text).not.toContain('%')
        expect(none.widths).toEqual([])
      }
    }
  })
})
