import { describe, it, expect } from 'vitest'
import type {
  Account, HouseholdDashboard, HouseholdMonthly, HouseholdShares, HouseholdView, ReceivedHouseholdShare,
} from '../index'
import { isLimitedEvent, upcomingItemAmount } from '../index'

// Real bodies from a local API (the Demo Partner viewing the Demo User's Household, and
// two registered users sharing a Household tag), trimmed. `satisfies` makes the typecheck
// fail on any key the types lack or misname.
const views = [
  { sharer_id: 2, sharer_name: 'Demo P.', is_self: true },
  { sharer_id: 1, sharer_name: 'Demo U.', is_self: false },
] satisfies HouseholdView[]

const tagViewerAccount = {
  id: 4, name: 'Cash Wallet', account_type: 'cash', currency: 'PHP', balance: 200.0,
  tags: [{ id: 1, name: 'Household', color: null, is_system: true }],
  my_role: 'tag_viewer',
  permissions: { can_edit_settings: false, can_manage_shares: false, can_add_transactions: false, can_delete: false },
  owner_name: 'Demo U.',
} satisfies Account

const dashboard = {
  sharer: { id: 1, name: 'Demo U.' },
  accounts: [tagViewerAccount],
  month: {
    month: '2026-10', kind: 'current',
    currencies: [{
      currency: 'PHP', income: 0.0, expense: 910.0, fees: 0.0, moved_in: 0.0, moved_out: 0.0,
      paid_from_other_accounts: 1200.0,
    }],
  },
  upcoming: [
    {
      view: 'limited', public_id: 'e2', date: '2026-10-20', original_date: null, overdue: false,
      display_name: 'Electric Bill', face_amount: 1200.0, cash_delta: 0.0, currency: 'PHP',
      account: { id: null, name: 'Other account' }, kind: 'household',
    },
    { name: 'Rent', amount: 2500.0, due_date: '2026-11-01', entry_type: 'expense', source: 'budget_entry', source_id: 6 },
  ],
} satisfies HouseholdDashboard

const monthly = {
  sharer: { id: 1, name: 'Demo U.' }, from: '2026-09', to: '2026-11',
  months: [
    { month: '2026-09', kind: 'recorded', currencies: [] },
    { month: '2026-10', kind: 'current', currencies: dashboard.month.currencies },
    { month: '2026-11', kind: 'projected', currencies: [] },
  ],
} satisfies HouseholdMonthly

const shares = {
  tag_id: 4,
  shares: [{ id: 2, tag_id: 4, user_id: 4, display_name: 'Bob P.', created_at: '2026-10-11T16:01:08.002818Z' }],
} satisfies HouseholdShares

const received = [
  { id: 2, tag_id: 4, sharer_id: 3, sharer_name: 'Alice P.', created_at: '2026-10-11T16:01:08.002818Z' },
] satisfies ReceivedHouseholdShare[]

describe('Household response types', () => {
  it('put the caller\'s own view first, and the sharer\'s id keys the other views', () => {
    expect(views[0]?.is_self).toBe(true)
    expect(views.filter((v) => !v.is_self).map((v) => v.sharer_id)).toEqual([dashboard.sharer.id])
    expect(received[0]?.sharer_id).toBe(3)
    expect(shares.shares[0]?.tag_id).toBe(shares.tag_id)
  })

  it('keep a tag_viewer account read-only', () => {
    expect(tagViewerAccount.my_role).toBe('tag_viewer')
    expect(Object.values(tagViewerAccount.permissions).some(Boolean)).toBe(false)
  })

  it('list a Household occurrence at its face amount, not its zero cash effect', () => {
    const [occurrence, rent] = dashboard.upcoming
    expect(occurrence && isLimitedEvent(occurrence) ? occurrence.cash_delta : null).toBe(0)
    expect(occurrence && upcomingItemAmount(occurrence)).toEqual({ amount: 1200, direction: null })
    expect(rent && upcomingItemAmount(rent)).toEqual({ amount: 2500, direction: 'out' })
  })

  it('give one line per currency and never a total across them', () => {
    const lines = monthly.months.flatMap((m) => m.currencies)
    expect(lines.map((l) => l.currency)).toEqual(['PHP'])
    expect(monthly.months.map((m) => m.kind)).toEqual(['recorded', 'current', 'projected'])
  })
})
