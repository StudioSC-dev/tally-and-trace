import { beforeEach, describe, expect, it, vi } from 'vitest'

// The form is driven without a renderer: useState is a per-mount slot store, every native
// component is its own name, and each action re-renders so handlers are never stale.
const h = vi.hoisted(() => ({
  slots: [] as unknown[],
  idx: 0,
  alerts: [] as Array<{ title: string; message: string }>,
  create: [] as unknown[],
  update: [] as Array<{ id: number; data: Record<string, unknown> }>,
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
  useCreateTransactionMutation: () => [(d: unknown) => (h.create.push(d), { unwrap: async () => ({}) }), { isLoading: false }],
  useUpdateTransactionMutation: () => [
    (a: { id: number; data: Record<string, unknown> }) => (h.update.push(a), { unwrap: async () => ({}) }),
    { isLoading: false },
  ],
  useDeleteTransactionMutation: () => [vi.fn(), { isLoading: false }],
  useGetTransactionsQuery: () => ({}),
  useGetAccountsQuery: () => ({}),
  useGetCategoriesQuery: () => ({}),
}))
vi.mock('../contexts/AuthContext', () => ({ useAuth: () => ({ user: { default_currency: 'PHP' } }) }))
vi.mock('../components/ui', () => {
  const host = (name: string) => name
  return {
    Card: host('Card'), Button: host('Button'), Input: host('Input'), LoadingSpinner: host('LoadingSpinner'),
    EmptyState: host('EmptyState'), Badge: host('Badge'), SectionHeader: host('SectionHeader'),
  }
})

import { TransactionFormModal } from '../../app/(tabs)/transactions'

type El = { props?: Record<string, unknown> }
const walk = (node: unknown, out: El[] = []): El[] => {
  if (node == null || typeof node !== 'object') return out
  if (Array.isArray(node)) { node.forEach((n) => walk(n, out)); return out }
  out.push(node as El)
  walk((node as El).props?.children, out)
  return out
}

const can = { can_add_transactions: true }
const ACCOUNTS = [
  { id: 1, name: 'Cash PHP', currency: 'PHP', permissions: can },
  { id: 2, name: 'Savings USD', currency: 'USD', permissions: can },
  { id: 3, name: 'Wallet PHP', currency: 'PHP', permissions: can },
]

function mount(extra: Record<string, unknown> = {}) {
  h.slots = []
  const props = { visible: true, onClose: () => {}, accounts: ACCOUNTS, categories: [], defaultCurrency: 'PHP', ...extra }
  const render = () => { h.idx = 0; return (TransactionFormModal as unknown as (p: typeof props) => unknown)(props) }
  const find = (id: string) => walk(render()).find((n) => n.props?.testID === id)
  const byLabel = (label: string) => walk(render()).find((n) => n.props?.label === label)
  return {
    press: (id: string) => (find(id)!.props!.onPress as () => void)(),
    type: (label: string, v: string) => (byLabel(label)!.props!.onChangeText as (v: string) => void)(v),
    byLabel,
    submit: async () => { await (find('submit')!.props!.onPress as () => Promise<void>)() },
  }
}
const lastAlert = () => h.alerts[h.alerts.length - 1]
const TODAY = new Date(new Date().toISOString().split('T')[0]).toISOString()
const json = (o: unknown) => JSON.parse(JSON.stringify(o))

beforeEach(() => {
  h.alerts = []; h.create = []; h.update = []
})

describe('mobile transfers', () => {
  it('creates_cross_currency_transfer_with_destination_and_received_amount', async () => {
    const ui = mount()
    ui.press('type-transfer')
    ui.press('transfer-from-1'); ui.press('transfer-to-2')
    ui.type('Amount', '4640')
    ui.type('Received amount (USD)', '80')
    await ui.submit()
    expect(h.create).toHaveLength(1)
    expect(json(h.create[0])).toEqual({
      amount: 4640, transaction_type: 'transfer', account_id: 1, transaction_date: TODAY, currency: 'PHP',
      transfer_from_account_id: 1, transfer_to_account_id: 2, received_amount: 80,
    })
  })

  it('creates_same_currency_transfer', async () => {
    const ui = mount()
    ui.press('type-transfer')
    ui.press('transfer-from-1'); ui.press('transfer-to-3')
    expect(ui.byLabel('Received amount (PHP)')).toBeUndefined()
    ui.type('Amount', '500')
    await ui.submit()
    expect(h.create).toHaveLength(1)
    const sent = json(h.create[0])
    expect(sent).toMatchObject({ transfer_from_account_id: 1, transfer_to_account_id: 3 })
    expect('received_amount' in sent).toBe(false)
  })

  it('missing_destination_refused', async () => {
    const ui = mount()
    ui.press('type-transfer')
    ui.press('transfer-from-1')
    ui.type('Amount', '500')
    await ui.submit()
    expect(h.create).toHaveLength(0)
    expect(lastAlert().message).toBe('Choose the destination account for the transfer.')
  })

  // Deviation from the ticket text: the mobile form has no posted or pending state, so a
  // cross-currency create always needs the received amount (message: "Enter the amount received in USD.").
  it('missing_received_amount_refused', async () => {
    for (const entered of [undefined, '', '0']) {
      h.alerts = []
      const ui = mount()
      ui.press('type-transfer')
      ui.press('transfer-from-1'); ui.press('transfer-to-2')
      ui.type('Amount', '4640')
      if (entered !== undefined) ui.type('Received amount (USD)', entered)
      await ui.submit()
      expect(h.create).toHaveLength(0)
      expect(lastAlert().message).toBe('Enter the amount received in USD.')
    }
  })

  // Deviation: main allows editing a cross-currency transfer (STU-632) instead of refusing it.
  it('edit_cross_currency_transfer_keeps_received_amount', async () => {
    const initial = {
      view: 'full', id: 10, description: 'old', amount: 4640, transaction_type: 'transfer', account_id: 1, currency: 'PHP',
      transaction_date: '2026-03-01T00:00:00Z', transfer_from_account_id: 1, transfer_to_account_id: 2, received_amount: 80,
    }
    const ui = mount({ initial })
    expect((ui.byLabel('Received amount (USD)')!.props as { value: string }).value).toBe('80')
    await ui.submit()
    expect(h.update).toHaveLength(1)
    expect(h.update[0].id).toBe(10)
    expect(h.update[0].data).toMatchObject({ transfer_from_account_id: 1, transfer_to_account_id: 2, received_amount: 80 })
  })
})
