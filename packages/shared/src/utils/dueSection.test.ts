import { describe, it, expect } from 'vitest'
import type {
  InstallmentAutoPostRow,
  CardCharges,
  CardStatementDue,
  DashboardSnapshot,
  FullCharge,
  FullTransaction,
  InstallmentPlan,
  LimitedCharge,
  LimitedEvent,
  LimitedTransaction,
  MissedCharge,
  Payable,
  RecordPermissions,
  RecurringMissed,
  SharedFullTransaction,
  UpcomingItem,
  UpcomingOccurrence,
} from '../index'
import {
  LIMITED_ROWS,
  type DueEntryRow,
  type DueLimitedRow,
  type DueMissedRow,
  type DueRecurringRow,
  type DueRow,
  type DueSectionRow,
  type DueStatementRow,
  type LimitedRowsMode,
  DUE_PAGE_SIZE,
  dueReviewNotice,
  dueTodayLines,
  postNowCount,
  postNowText,
  postedOnOpenText,
  shouldPostOnOpen,
  statementRowText,
  duePendingRows,
  isOneOffPending,
  loggedDays,
  loggedText,
  notPostedRows,
  dueRecurringRows,
  dueStatementRows,
  effectiveDuePage,
  isOverdueRow,
  orderDueRows,
  pendingLinkIds,
  pendingPostLabel,
  freshFor,
  installmentPlanView,
  orderSubscriptionRows,
  subscriptionPastRows,
} from './dueSection'
import { pageWindow } from './transactionList'

const TODAY = '2026-10-20'
const MODES: LimitedRowsMode[] = ['text', 'drop']

function snap(
  parts: Partial<Pick<DashboardSnapshot, 'payables' | 'upcoming_this_month' | 'card_charges' | 'card_statements_due' | 'missed' | 'installment_review' | 'installment_auto_post' | 'auto_post_scheduled'>>,
): DashboardSnapshot {
  return {
    balances: { total: 0, by_account: [], by_currency: [] },
    upcoming_this_month: [],
    monthly_summary: { monthly_income: 0, monthly_expenses: 0, monthly_disposable: 0, by_currency: [] },
    forecast_next_3_months: [],
    goals_progress: [],
    wishlist_next_up: [],
    available_cash: 0,
    account_closings: [],
    payables: [],
    card_charges: [],
    card_statements_due: [],
    missed: [],
    installment_review: [],
    installment_auto_post: [],
    autopay_due: [],
    auto_post_scheduled: false,
    currencies: ['PHP'],
    fx: { rates: [], unconverted_count: 0 },
    ...parts,
  }
}

const payable = (p: Partial<Payable> & Pick<Payable, 'name' | 'source_id'>): Payable => ({
  due_date: TODAY,
  amount: 1000,
  source: 'budget_entry',
  account_id: 1,
  account_name: 'Checking',
  overflow_account_id: null,
  overflow_account_name: null,
  currency: 'PHP',
  occurrence_date: TODAY,
  overdue: false,
  kind: 'cash',
  can_mark_paid: true,
  ...p,
})

const upcoming = (u: Partial<UpcomingItem> & Pick<UpcomingItem, 'name' | 'source_id' | 'entry_type'>): UpcomingItem => ({
  amount: 1000,
  due_date: TODAY,
  source: 'budget_entry',
  currency: 'PHP',
  occurrence_date: TODAY,
  overdue: false,
  kind: null,
  can_mark_paid: true,
  ...u,
})

const charge = (c: Partial<FullCharge> & Pick<FullCharge, 'name' | 'source_id'>): FullCharge => ({
  view: 'full',
  date: TODAY,
  original_date: null,
  overdue: false,
  occurrence_date: TODAY,
  kind: 'subscription',
  // Null keeps these fixtures in Due, their meaning before STU-511; Subscriptions tests set it.
  plan_kind: null,
  source: 'budget_entry',
  amount: 500,
  currency: 'PHP',
  can_mark_paid: true,
  recurring: false,
  ...c,
})

const card = (c: Partial<CardCharges>): CardCharges => ({
  account_id: 9,
  account_name: 'Visa',
  currency: 'PHP',
  statement_cycle: true,
  missed: [],
  charges: [],
  ...c,
})

const cardMissed = (m: Partial<MissedCharge> & Pick<MissedCharge, 'entry_id' | 'name'>): MissedCharge => ({
  kind: 'subscription',
  plan_kind: null,
  count: 2,
  due_count: 2,
  oldest: '2026-08-20',
  unlinked_count: 2,
  oldest_unlinked: '2026-08-20',
  pending_transaction_ids: [],
  can_mark_paid: true,
  ...m,
})

const missed = (m: Partial<RecurringMissed> & Pick<RecurringMissed, 'entry_id' | 'name'>): RecurringMissed => ({
  view: 'full',
  entry_type: 'expense',
  kind: 'cash',
  is_transfer: false,
  capped: false,
  account_name: 'Checking',
  count: 2,
  oldest: '2026-08-20',
  unlinked_count: 2,
  oldest_unlinked: '2026-08-20',
  pending_transaction_ids: [],
  can_mark_paid: true,
  auto_post: null,
  block_reason: null,
  can_review: false,
  ...m,
})

const limitedEvent = (publicId: string, overdue = false): LimitedEvent => ({
  view: 'limited',
  public_id: publicId,
  date: TODAY,
  original_date: overdue ? '2026-10-15' : null,
  overdue,
  display_name: 'Expense',
  face_amount: 100,
  cash_delta: -100,
  currency: 'PHP',
  account: { id: null, name: 'Other account' },
  kind: 'expense',
})

const limitedCharge = (publicId: string): LimitedCharge => ({
  view: 'limited',
  public_id: publicId,
  date: '2026-10-22',
  original_date: null,
  overdue: false,
  display_name: 'Card charge',
})

const canPost: RecordPermissions = { can_edit: true, can_delete: true, can_post: true, can_revert: true, can_tag: true }
const noPost: RecordPermissions = { ...canPost, can_edit: false, can_delete: false, can_post: false }

const txn = (t: Partial<FullTransaction> & Pick<FullTransaction, 'id' | 'transaction_date'>): FullTransaction => ({
  view: 'full',
  account_id: 1,
  amount: 100,
  currency: 'PHP',
  transaction_type: 'debit',
  is_posted: false,
  is_reconciled: false,
  is_recurring: false,
  transfer_fee: 0,
  tags: [],
  created_at: '2026-10-01T00:00:00Z',
  permissions: canPost,
  created_by: 'Owner O.',
  ...t,
})

const sharedTxn = (t: Partial<SharedFullTransaction> & Pick<SharedFullTransaction, 'id' | 'transaction_date'>): SharedFullTransaction => ({
  ...txn({ id: t.id, transaction_date: t.transaction_date }),
  view: 'shared_full',
  category_name: null,
  ...t,
})

const limitedTxn = (id: number, date: string): LimitedTransaction => ({
  view: 'limited',
  id,
  permissions: noPost,
  created_by: 'Owner O.',
  date,
  display_description: null,
  amount: 100,
  transfer_fee: null,
  currency: 'PHP',
  transaction_type: 'debit',
  is_posted: false,
  category_name: null,
  account: null,
  counterpart: null,
  tags: [],
})

const entries = (rows: DueRecurringRow[]): DueEntryRow[] =>
  rows.filter((r): r is DueEntryRow => r.kind === 'recurring' && r.view !== 'limited')
const missedRows = (rows: DueRecurringRow[]): DueMissedRow[] => rows.filter((r): r is DueMissedRow => r.kind === 'missed')
const limitedOf = (rows: DueRecurringRow[]): DueLimitedRow[] => rows.filter((r): r is DueLimitedRow => r.view === 'limited')

describe('LIMITED_ROWS', () => {
  it('is the owner ruling: Limited rows as text', () => {
    expect(LIMITED_ROWS).toBe('text')
  })
})

describe('dueRecurringRows: sources and merge', () => {
  it.each(MODES)('lists a card entry on a card without a statement cycle once, as a card row (%s)', (mode) => {
    const s = snap({
      payables: [payable({ name: 'Netflix', source_id: 5, kind: 'subscription', plan_kind: null, due_date: '2026-10-20', occurrence_date: '2026-10-20', account_name: 'Visa' })],
      card_charges: [card({ statement_cycle: false, charges: [charge({ name: 'Netflix', source_id: 5, date: '2026-10-20', occurrence_date: '2026-10-20' })] })],
    })
    const rows = entries(dueRecurringRows(s, TODAY, mode))
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ key: '5:2026-10-20', view: 'full', recurring_kind: 'subscription', actions: ['charged', 'posted'] })
  })

  it('lists a plain transfer from upcoming with Mark paid', () => {
    const s = snap({ upcoming_this_month: [upcoming({ name: 'Save', source_id: 7, entry_type: 'transfer', due_date: '2026-10-20', occurrence_date: '2026-10-20' })] })
    const rows = entries(dueRecurringRows(s, TODAY))
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ name: 'Save', entry_type: 'transfer', view: null, actions: ['mark_paid'] })
  })

  it('lists a loan-payment transfer in both payables and upcoming once', () => {
    const s = snap({
      payables: [payable({ name: 'Loan', source_id: 8, kind: null, due_date: '2026-10-20', occurrence_date: '2026-10-20' })],
      upcoming_this_month: [upcoming({ name: 'Loan', source_id: 8, entry_type: 'transfer', due_date: '2026-10-20', occurrence_date: '2026-10-20' })],
    })
    const rows = entries(dueRecurringRows(s, TODAY))
    expect(rows).toHaveLength(1)
    // The payable row wins (it has the account) and takes the upcoming row's entry_type.
    expect(rows[0]).toMatchObject({ accountName: 'Checking', entry_type: 'transfer', actions: ['mark_paid'] })
  })

  it('lists income with Mark received and leaves upcoming expenses to the payables', () => {
    const s = snap({
      upcoming_this_month: [
        upcoming({ name: 'Salary', source_id: 3, entry_type: 'income', due_date: '2026-10-20', occurrence_date: '2026-10-20' }),
        upcoming({ name: 'Rent', source_id: 4, entry_type: 'expense', kind: 'cash' }),
        upcoming({ name: 'Pending', source: 'transaction', source_id: 40, entry_type: 'income' }),
      ],
    })
    const rows = entries(dueRecurringRows(s, TODAY))
    expect(rows.map((r) => [r.name, r.actions])).toEqual([['Salary', ['mark_received']]])
  })

  it('takes permission from the row: no can_mark_paid, no actions', () => {
    const s = snap({ payables: [payable({ name: 'Rent', source_id: 2, can_mark_paid: false })] })
    expect(entries(dueRecurringRows(s, TODAY))[0]?.actions).toEqual([])
  })

  it('keeps a converted row\'s estimate labels with its amount', () => {
    const s = snap({
      payables: [payable({
        name: 'Hosting', source_id: 12, amount: 4640, currency: 'PHP',
        estimated: true, original_amount: 80, original_currency: 'USD', rate: 58, rate_as_of: '2026-10-19', rate_stale: false,
      })],
    })
    expect(entries(dueRecurringRows(s, TODAY))[0]).toMatchObject({
      amount: 4640,
      currency: 'PHP',
      estimate: { estimated: true, original_amount: 80, original_currency: 'USD', rate: 58, rate_as_of: '2026-10-19', rate_stale: false },
    })
  })

  it('keeps an unconverted row\'s original figure, from the winning card row', () => {
    const s = snap({
      payables: [payable({ name: 'Cloud', source_id: 13, kind: 'subscription', plan_kind: null, account_name: 'Visa' })],
      card_charges: [card({ charges: [charge({
        name: 'Cloud', source_id: 13, amount: null, unconverted: true, original_amount: 20, original_currency: 'USD',
        rate_as_of: '2026-10-19', rate_stale: false,
      })] })],
    })
    const rows = entries(dueRecurringRows(s, TODAY))
    expect(rows).toHaveLength(1)
    expect(rows[0]?.amount).toBeNull()
    expect(rows[0]?.estimate).toEqual({ unconverted: true, original_amount: 20, original_currency: 'USD', rate_as_of: '2026-10-19', rate_stale: false })
  })

  it('carries no estimate labels for a row in its own currency', () => {
    const s = snap({ payables: [payable({ name: 'Rent', source_id: 14 })] })
    expect(entries(dueRecurringRows(s, TODAY))[0]?.estimate).toEqual({})
  })

  it('skips non-entry payables (statements, loans, transactions)', () => {
    const s = snap({
      payables: [
        payable({ name: 'Statement', source: 'statement', source_id: 9 }),
        payable({ name: 'Loan', source: 'loan', source_id: 10 }),
        payable({ name: 'Debit', source: 'transaction', source_id: 11 }),
      ],
    })
    expect(entries(dueRecurringRows(s, TODAY))).toEqual([])
  })
})

describe('dueRecurringRows: missed coverage', () => {
  // Rent (cash, entry 2) has a missed row from 2026-08-20.
  const withMissed = (parts: Parameters<typeof snap>[0]) =>
    snap({ ...parts, missed: [missed({ entry_id: 2, name: 'Rent', oldest: '2026-08-20' })] })

  it('drops a payable dated before today', () => {
    const s = withMissed({ payables: [payable({ name: 'Rent', source_id: 2, occurrence_date: '2026-10-19', due_date: '2026-10-19', overdue: true })] })
    expect(entries(dueRecurringRows(s, TODAY))).toEqual([])
  })

  it('drops a card row flagged overdue', () => {
    const s = snap({
      card_charges: [card({
        missed: [cardMissed({ entry_id: 5, name: 'Spotify', oldest: '2026-08-20' })],
        charges: [charge({ name: 'Spotify', source_id: 5, date: TODAY, original_date: '2026-09-20', overdue: true, occurrence_date: '2026-09-20' })],
      })],
    })
    expect(entries(dueRecurringRows(s, TODAY))).toEqual([])
  })

  it('drops a capped upcoming row collapsed onto today with last month as its occurrence', () => {
    const s = snap({
      missed: [missed({ entry_id: 3, name: 'Salary', entry_type: 'income', kind: null, capped: true, oldest: '2026-09-25' })],
      upcoming_this_month: [upcoming({ name: 'Salary', source_id: 3, entry_type: 'income', due_date: TODAY, occurrence_date: '2026-09-25', original_date: '2026-09-25', overdue: true })],
    })
    expect(entries(dueRecurringRows(s, TODAY))).toEqual([])
  })

  it("keeps today's occurrence and drops future ones", () => {
    const s = withMissed({
      payables: [
        payable({ name: 'Rent', source_id: 2, occurrence_date: TODAY }),
        payable({ name: 'Rent', source_id: 2, occurrence_date: '2026-11-05', due_date: '2026-11-05' }),
      ],
    })
    expect(entries(dueRecurringRows(s, TODAY)).map((r) => r.occurrenceDate)).toEqual([TODAY])
  })

  it('drops a future occurrence of every source: payable, card charge, upcoming income and transfer', () => {
    const s = snap({
      payables: [payable({ name: 'Rent', source_id: 2, occurrence_date: '2026-10-21', due_date: '2026-10-21' })],
      card_charges: [card({ charges: [charge({ name: 'Netflix', source_id: 5, date: '2026-10-22', occurrence_date: '2026-10-22' })] })],
      upcoming_this_month: [
        upcoming({ name: 'Salary', source_id: 3, entry_type: 'income', due_date: '2026-10-25', occurrence_date: '2026-10-25' }),
        upcoming({ name: 'Save', source_id: 7, entry_type: 'transfer', due_date: '2026-10-24', occurrence_date: '2026-10-24' }),
      ],
    })
    expect(entries(dueRecurringRows(s, TODAY))).toEqual([])
  })

  it('places a forced occurrence by its effective date and keeps the scheduled day as its identity', () => {
    // Scheduled yesterday, forced to tomorrow: not due yet.
    const later = snap({ payables: [payable({ name: 'Rent', source_id: 2, occurrence_date: '2026-10-19', due_date: '2026-10-21' })] })
    expect(entries(dueRecurringRows(later, TODAY))).toEqual([])
    // Scheduled tomorrow, forced to yesterday: due, overdue, and Mark paid still sends the scheduled day.
    const earlier = snap({
      payables: [payable({ name: 'Rent', source_id: 2, occurrence_date: '2026-10-21', due_date: TODAY, original_date: '2026-10-19', overdue: true })],
    })
    expect(entries(dueRecurringRows(earlier, TODAY))).toMatchObject([
      { occurrenceDate: '2026-10-21', effectiveDate: '2026-10-19', overdue: true, key: '2:2026-10-21' },
    ])
  })

  it('splits on the day passed in: the same row is due on its own day and gone the day before', () => {
    const s = snap({ payables: [payable({ name: 'Rent', source_id: 2, occurrence_date: '2026-10-21', due_date: '2026-10-21' })] })
    expect(entries(dueRecurringRows(s, '2026-10-20'))).toEqual([])
    expect(entries(dueRecurringRows(s, '2026-10-21')).map((r) => r.occurrenceDate)).toEqual(['2026-10-21'])
  })

  it("keeps today's occurrence even when flagged overdue", () => {
    const s = withMissed({ payables: [payable({ name: 'Rent', source_id: 2, occurrence_date: TODAY, overdue: true })] })
    expect(entries(dueRecurringRows(s, TODAY)).map((r) => [r.occurrenceDate, r.overdue])).toEqual([[TODAY, false]])
  })

  it('keeps an overdue row of an entry with no missed row', () => {
    const s = withMissed({ payables: [payable({ name: 'Water', source_id: 6, occurrence_date: '2026-10-18', due_date: '2026-10-18', overdue: true })] })
    expect(entries(dueRecurringRows(s, TODAY))).toMatchObject([{ name: 'Water', overdue: true }])
  })

  it("keeps an overdue row dated before the missed row's oldest", () => {
    const s = withMissed({ payables: [payable({ name: 'Rent', source_id: 2, occurrence_date: '2026-08-01', due_date: '2026-08-01', overdue: true })] })
    expect(entries(dueRecurringRows(s, TODAY)).map((r) => r.occurrenceDate)).toEqual(['2026-08-01'])
  })

  it('is covered by a missed row even when every occurrence is linked (count > 0, unlinked 0)', () => {
    const s = snap({
      missed: [missed({ entry_id: 2, name: 'Rent', count: 1, unlinked_count: 0, oldest_unlinked: null, oldest: '2026-09-20' })],
      payables: [payable({ name: 'Rent', source_id: 2, occurrence_date: '2026-09-20', due_date: TODAY, original_date: '2026-09-20', overdue: true })],
    })
    expect(dueRecurringRows(s, TODAY)).toEqual([])
  })
})

describe('dueRecurringRows: a missed row carries what Change date needs', () => {
  const oneRow = (m: RecurringMissed): DueMissedRow => {
    const [row] = missedRows(dueRecurringRows(snap({ missed: [m] }), TODAY))
    if (!row) throw new Error('no missed row')
    return row
  }

  it('carries can_mark_paid as the permission for Change date, true for an owner and false for a viewer', () => {
    const rows = missedRows(dueRecurringRows(snap({
      missed: [missed({ entry_id: 2, name: 'Owner rent', can_mark_paid: true }), missed({ entry_id: 6, name: 'Viewer rent', can_mark_paid: false })],
      card_charges: [card({ missed: [cardMissed({ entry_id: 7, name: 'Spotify', can_mark_paid: false })] })],
    }), TODAY))
    expect(Object.fromEntries(rows.map((r) => [r.name, r.can_mark_paid]))).toEqual({ 'Owner rent': true, 'Viewer rent': false, Spotify: false })
  })

  it('opens on the oldest unlinked occurrence with its forced date as the effective one', () => {
    const row = oneRow(missed({ entry_id: 2, name: 'Rent', count: 2, oldest: '2026-09-20', oldest_effective: '2026-09-22', oldest_unlinked: '2026-09-20' }))
    expect(row).toMatchObject({ oldest: '2026-09-20', oldestEffective: '2026-09-22', oldestEffectiveKnown: true })
  })

  it('knows no effective date when the oldest unlinked day is not the oldest missed one, or the API gives none', () => {
    const later = oneRow(missed({ entry_id: 2, name: 'Rent', count: 2, oldest: '2026-08-20', oldest_effective: '2026-08-22', oldest_unlinked: '2026-09-20' }))
    expect(later).toMatchObject({ oldest: '2026-09-20', oldestEffective: '2026-09-20', oldestEffectiveKnown: false })
    const [spotify] = missedRows(dueRecurringRows(snap({ card_charges: [card({ missed: [cardMissed({ entry_id: 7, name: 'Spotify' })] })] }), TODAY))
    expect(spotify?.oldestEffectiveKnown).toBe(false)
    const older = oneRow({ ...missed({ entry_id: 3, name: 'Old API' }), oldest_effective: undefined })
    expect(older.oldestEffectiveKnown).toBe(false)
  })

  it('reads "since" on the effective date once the oldest is moved to another past day, count unchanged', () => {
    const before = oneRow(missed({ entry_id: 2, name: 'Rent', count: 2, oldest: '2026-09-20', oldest_effective: '2026-09-20', oldest_unlinked: '2026-09-20', unlinked_count: 2 }))
    const after = oneRow(missed({ entry_id: 2, name: 'Rent', count: 2, oldest: '2026-09-20', oldest_effective: '2026-09-23', oldest_unlinked: '2026-09-20', unlinked_count: 2 }))
    expect([before.count, before.text]).toEqual([2, '2 missed since Sep 20th, 2026'])
    expect([after.count, after.text, after.oldest]).toEqual([2, '2 missed since Sep 23rd, 2026', '2026-09-20'])
  })

  it('counts one fewer and starts at the next occurrence once the oldest is moved into the future, and no row for the last one', () => {
    const two = oneRow(missed({ entry_id: 2, name: 'Rent', count: 2, oldest: '2026-09-20', oldest_effective: '2026-09-20', oldest_unlinked: '2026-09-20', unlinked_count: 2 }))
    const one = oneRow(missed({ entry_id: 2, name: 'Rent', count: 1, oldest: '2026-10-20', oldest_effective: '2026-10-20', oldest_unlinked: '2026-10-20', unlinked_count: 1 }))
    expect([two.count, one.count, one.oldest, one.text]).toEqual([2, 1, '2026-10-20', '1 missed since Oct 20th, 2026'])
    expect(missedRows(dueRecurringRows(snap({ missed: [] }), TODAY))).toEqual([])
  })
})

describe('dueRecurringRows: missed rows and the pending split', () => {
  it('lists no missed row when every missed occurrence has a pending row', () => {
    const s = snap({ missed: [missed({ entry_id: 2, name: 'Rent', count: 2, unlinked_count: 0, oldest_unlinked: null, pending_transaction_ids: [31, 32] })] })
    expect(missedRows(dueRecurringRows(s, TODAY))).toEqual([])
  })

  it('shows the unlinked count and its oldest day', () => {
    const s = snap({
      missed: [missed({ entry_id: 2, name: 'Rent', count: 2, oldest: '2026-08-20', unlinked_count: 1, oldest_unlinked: '2026-09-20', pending_transaction_ids: [31] })],
    })
    const [row] = missedRows(dueRecurringRows(s, TODAY))
    expect(row).toMatchObject({ key: 'missed:2', count: 1, oldest: '2026-09-20', text: '1 missed since Sep 20th, 2026', actions: ['mark_paid'] })
  })

  it('offers the buttons of the missed row type', () => {
    const s = snap({
      missed: [
        missed({ entry_id: 2, name: 'Old Rent', kind: 'cash' }),
        missed({ entry_id: 3, name: 'Old Salary', entry_type: 'income', kind: null }),
        missed({ entry_id: 4, name: 'Old Save', entry_type: 'expense', kind: null, is_transfer: true }),
        missed({ entry_id: 5, name: 'Phone', kind: 'installment', plan_kind: null, capped: true }),
        missed({ entry_id: 6, name: 'Viewer rent', can_mark_paid: false }),
      ],
      card_charges: [card({ missed: [cardMissed({ entry_id: 7, name: 'Spotify' })] })],
    })
    const byName = Object.fromEntries(missedRows(dueRecurringRows(s, TODAY)).map((r) => [r.name, r.actions]))
    expect(byName).toEqual({
      'Old Rent': ['mark_paid'],
      'Old Salary': ['mark_received'],
      'Old Save': ['mark_paid'],
      Phone: ['charged', 'posted'],
      'Viewer rent': [],
      Spotify: ['charged', 'posted'],
    })
  })

  it('sorts missed and overdue rows first, then by day', () => {
    const s = snap({
      missed: [missed({ entry_id: 2, name: 'Old Rent', oldest_unlinked: '2026-09-01' })],
      payables: [
        payable({ name: 'Later', source_id: 10, occurrence_date: '2026-10-25', due_date: '2026-10-25' }),
        payable({ name: 'Today', source_id: 11, occurrence_date: TODAY }),
        payable({ name: 'Late', source_id: 12, occurrence_date: '2026-10-10', due_date: TODAY, original_date: '2026-10-10', overdue: true }),
      ],
    })
    // 'Later' is in Upcoming, not here.
    expect(dueRecurringRows(s, TODAY).map((r) => r.name)).toEqual(['Old Rent', 'Late', 'Today'])
  })
})

describe('dueRecurringRows: Limited rows', () => {
  const s = snap({
    payables: [limitedEvent('e1'), limitedEvent('e2', true), payable({ name: 'Rent', source_id: 2 })],
    upcoming_this_month: [limitedEvent('e1')],
    card_charges: [card({ charges: [limitedCharge('e1'), limitedCharge('e3')] })],
  })

  it("lists none under 'drop'", () => {
    const rows = dueRecurringRows(s, TODAY, 'drop')
    expect(limitedOf(rows)).toEqual([])
    expect(rows.map((r) => r.name)).toEqual(['Rent'])
  })

  it("lists Limited payable and card rows once each under 'text', with no actions", () => {
    const rows = limitedOf(dueRecurringRows(s, TODAY, 'text'))
    expect(rows.map((r) => r.publicId).sort()).toEqual(['e1', 'e2', 'e3'])
    for (const row of rows) expect('actions' in row).toBe(false)
    expect(rows.find((r) => r.publicId === 'e2')).toMatchObject({ overdue: true, date: '2026-10-15' })
  })

  it('defaults to LIMITED_ROWS', () => {
    expect(dueRecurringRows(s, TODAY)).toEqual(dueRecurringRows(s, TODAY, LIMITED_ROWS))
  })

  it("keeps a future-dated Limited event under 'text', on its date, while a future full row is dropped", () => {
    // The exception: a viewer's Limited text rows keep their dates; only full and shared_full rows stop at today.
    const future = snap({
      payables: [
        { ...limitedEvent('e4'), date: '2026-10-25' },
        payable({ name: 'Rent', source_id: 2, occurrence_date: '2026-10-25', due_date: '2026-10-25' }),
      ],
    })
    const rows = dueRecurringRows(future, TODAY, 'text')
    expect(limitedOf(rows).map((r) => [r.publicId, r.date])).toEqual([['e4', '2026-10-25']])
    expect(entries(rows)).toEqual([])
  })
})

describe('Group B: duePendingRows', () => {
  const s = snap({
    card_charges: [card({
      missed: [cardMissed({ entry_id: 5, name: 'Spotify', pending_transaction_ids: [60] })],
      charges: [
        charge({ name: 'Netflix', source: 'transaction', source_id: 50, kind: 'pending', occurrence_date: null, recurring: true, date: '2026-10-25' }),
        charge({ name: 'Lunch', source: 'transaction', source_id: 51, kind: 'pending', occurrence_date: null, recurring: false, date: '2026-10-25' }),
      ],
    })],
    missed: [missed({ entry_id: 2, name: 'Rent', pending_transaction_ids: [61, 60] })],
  })

  it.each(MODES)('lists a recurring card charge and linked rows; drops one-offs, posted and Limited rows (%s)', (mode) => {
    // The Limited mode never adds a pending row.
    void mode
    const window = [
      txn({ id: 40, transaction_date: '2026-10-19T00:00:00Z' }),
      txn({ id: 41, transaction_date: '2026-10-25T00:00:00Z' }),
      txn({ id: 42, transaction_date: '2026-10-18T00:00:00Z', is_posted: true }),
      txn({ id: 50, transaction_date: TODAY + 'T00:00:00Z', budget_entry_id: 7, is_recurring: true }),
      txn({ id: 51, transaction_date: '2026-10-25T00:00:00Z' }),
      txn({ id: 52, transaction_date: TODAY + 'T00:00:00Z' }),
    ]
    const linked = [
      txn({ id: 60, transaction_date: TODAY + 'T00:00:00Z', budget_entry_id: 8, is_recurring: true }),
      txn({ id: 61, transaction_date: '2026-09-20T00:00:00Z', is_posted: true }),
    ]
    const rows = duePendingRows([...window, limitedTxn(70, '2026-10-10T00:00:00Z')], linked, s, TODAY)
    expect(rows.map((r) => [r.transaction.id, r.overdue, r.action])).toEqual([
      [50, false, 'posted'],
      [60, false, 'mark_posted'],
    ])
  })

  it('drops a row dated after today even when it is a recurring card charge or a missed row links it', () => {
    const window = [
      txn({ id: 41, transaction_date: '2026-10-25T00:00:00Z' }),
      txn({ id: 50, transaction_date: '2026-10-25T00:00:00Z', budget_entry_id: 7, is_recurring: true }),
    ]
    const linked = [txn({ id: 60, transaction_date: '2026-12-04T00:00:00Z', budget_entry_id: 8, is_recurring: true })]
    expect(duePendingRows(window, linked, s, TODAY)).toEqual([])
    expect(duePendingRows(window, linked, s, '2026-12-04').map((r) => r.transaction.id)).toEqual([50, 60])
  })

  it('lists a row in both queries once', () => {
    const t = txn({ id: 40, transaction_date: '2026-10-01T00:00:00Z', budget_entry_id: 7, is_recurring: true })
    expect(duePendingRows([t], [t], s, TODAY)).toHaveLength(1)
  })

  it('reads the day from the wall-time components', () => {
    // 23:30 wall time on the 19th is still the 19th.
    const rows = duePendingRows([txn({ id: 40, transaction_date: '2026-10-19T23:30:00', budget_entry_id: 7, is_recurring: true })], [], s, TODAY)
    expect(rows[0]).toMatchObject({ date: '2026-10-19', overdue: true })
  })

  it('offers no action without can_post, and keeps a shared_full row', () => {
    const rows = duePendingRows(
      [
        txn({ id: 40, transaction_date: '2026-10-01T00:00:00Z', permissions: noPost, budget_entry_id: 7, is_recurring: true }),
        sharedTxn({ id: 50, transaction_date: TODAY + 'T00:00:00Z', is_recurring: true }),
      ],
      [],
      s,
      TODAY,
    )
    expect(rows.map((r) => [r.transaction.id, r.view, r.action])).toEqual([[40, 'full', null], [50, 'shared_full', 'posted']])
  })
})

describe('pendingLinkIds and pendingPostLabel', () => {
  const s = snap({
    card_charges: [card({
      missed: [cardMissed({ entry_id: 5, name: 'Spotify', pending_transaction_ids: [60, 12] })],
      charges: [charge({ name: 'Netflix', source: 'transaction', source_id: 50, kind: 'pending', occurrence_date: null, recurring: true })],
    })],
    missed: [missed({ entry_id: 2, name: 'Rent', pending_transaction_ids: [61, 60] })],
  })

  it('collects every linked id once, ascending', () => {
    expect(pendingLinkIds(s)).toEqual([12, 60, 61])
    expect(pendingLinkIds(snap({}))).toEqual([])
  })

  it('labels a recurring card charge Posted and anything else Mark posted', () => {
    expect(pendingPostLabel({ id: 50 }, s)).toBe('Posted')
    expect(pendingPostLabel({ id: 60 }, s)).toBe('Mark posted')
  })
})

describe('orderDueRows', () => {
  const pend = (id: number, date: string) => duePendingRows([txn({ id, transaction_date: `${date}T00:00:00Z`, budget_entry_id: 900 + id, is_recurring: true })], [], snap({}), TODAY)
  const names = (rows: ReturnType<typeof orderDueRows>) => rows.map((r) => (r.kind === 'pending' ? `p${r.transaction.id}` : r.name))

  it('puts an overdue pending row before a non-overdue recurring row', () => {
    const rec = dueRecurringRows(snap({ payables: [payable({ name: 'Rent', source_id: 1, occurrence_date: TODAY, due_date: TODAY })] }), TODAY)
    expect(names(orderDueRows(rec, pend(40, '2026-10-19')))).toEqual(['p40', 'Rent'])
  })

  it('puts missed and overdue rows ahead of due-today rows', () => {
    const rec = dueRecurringRows(
      snap({
        missed: [missed({ entry_id: 2, name: 'Old Rent', oldest_unlinked: '2026-09-01' })],
        payables: [
          payable({ name: 'Today', source_id: 11 }),
          payable({ name: 'Late', source_id: 12, occurrence_date: '2026-10-10', due_date: TODAY, original_date: '2026-10-10', overdue: true }),
        ],
      }),
      TODAY,
    )
    expect(names(orderDueRows(rec, pend(40, '2026-10-19')))).toEqual(['Old Rent', 'Late', 'p40', 'Today'])
  })

  it('puts the oldest overdue row first across kinds', () => {
    const rec = dueRecurringRows(snap({ payables: [payable({ name: 'Late', source_id: 12, occurrence_date: '2026-10-10', due_date: TODAY, original_date: '2026-10-10', overdue: true })] }), TODAY)
    expect(names(orderDueRows(rec, pend(40, '2026-10-05')))).toEqual(['p40', 'Late'])
  })

  it('orders a day tie by the recurring family order, then pending', () => {
    const rec = dueRecurringRows(
      snap({
        missed: [missed({ entry_id: 2, name: 'Zed', oldest_unlinked: '2026-10-10' })],
        payables: [payable({ name: 'Alpha', source_id: 12, occurrence_date: '2026-10-10', due_date: TODAY, original_date: '2026-10-10', overdue: true })],
      }),
      TODAY,
    )
    // dueRecurringRows' own order (name) is kept within the recurring family.
    expect(names(orderDueRows(rec, pend(40, '2026-10-10')))).toEqual(['Alpha', 'Zed', 'p40'])
  })

  it('orders two pending rows on one day by numeric id', () => {
    const rows = duePendingRows(
      [
        txn({ id: 10, transaction_date: '2026-10-19T00:00:00Z', budget_entry_id: 7, is_recurring: true }),
        txn({ id: 9, transaction_date: '2026-10-19T00:00:00Z', budget_entry_id: 7, is_recurring: true }),
      ],
      [],
      snap({}),
      TODAY,
    )
    expect(names(orderDueRows([], rows))).toEqual(['p9', 'p10'])
  })

  it("ranks a Limited overdue row as overdue under 'text'; under 'drop' it is absent", () => {
    const s = snap({
      payables: [limitedEvent('e2', true), payable({ name: 'Today', source_id: 11 })],
    })
    expect(names(orderDueRows(dueRecurringRows(s, TODAY, 'text'), []))).toEqual(['Expense', 'Today'])
    expect(names(orderDueRows(dueRecurringRows(s, TODAY, 'drop'), []))).toEqual(['Today'])
  })

  it('does not call a row due today overdue', () => {
    const [today] = dueRecurringRows(snap({ payables: [payable({ name: 'Today', source_id: 11 })] }), TODAY)
    expect(isOverdueRow(today!)).toBe(false)
    const [late] = pend(40, '2026-10-19')
    expect(isOverdueRow(late!)).toBe(true)
  })

  it('leaves the inputs alone and keeps every row', () => {
    const rec = dueRecurringRows(snap({ payables: [payable({ name: 'Today', source_id: 11 })] }), TODAY)
    const pending = pend(40, '2026-10-19')
    expect(pending).toHaveLength(1)
    const recCopy = [...rec]
    const pendCopy = [...pending]
    const out = orderDueRows(rec, pending)
    expect(out).toHaveLength(rec.length + pending.length)
    expect(rec).toEqual(recCopy)
    expect(pending).toEqual(pendCopy)
  })
})

const statementDue = (d: Partial<CardStatementDue> & Pick<CardStatementDue, 'account_id' | 'name'>): CardStatementDue => ({
  currency: 'PHP',
  close_date: '2026-10-03',
  due_date: '2026-10-24',
  clear_through: 4200,
  statement_count: 1,
  oldest_due: '2026-10-24',
  overdue: false,
  incomplete: false,
  unposted_installments: 0,
  unposted_postable: 0,
  ...d,
})

describe('dueStatementRows', () => {
  it('maps each card statement to one row, in the server order', () => {
    const s = snap({
      card_statements_due: [
        statementDue({ account_id: 9, name: 'Visa' }),
        statementDue({
          account_id: 4, name: 'Zed Card', currency: 'USD', close_date: '2026-09-28', due_date: '2026-10-19',
          clear_through: 310.5, statement_count: 2, oldest_due: '2026-09-19', overdue: true, incomplete: true,
        }),
      ],
    })
    expect(dueStatementRows(s)).toEqual<DueStatementRow[]>([
      {
        kind: 'statement', key: 'statement:9', cardId: 9, name: 'Visa', closeDate: '2026-10-03', dueDate: '2026-10-24',
        oldestDue: '2026-10-24', overdue: false, statements: 1, amount: 4200, currency: 'PHP', incomplete: false,
        unposted: 0, unpostedPostable: 0,
      },
      {
        kind: 'statement', key: 'statement:4', cardId: 4, name: 'Zed Card', closeDate: '2026-09-28', dueDate: '2026-10-19',
        oldestDue: '2026-09-19', overdue: true, statements: 2, amount: 310.5, currency: 'USD', incomplete: true,
        unposted: 0, unpostedPostable: 0,
      },
    ])
  })

  it('is empty when the snapshot lists no statement', () => {
    expect(dueStatementRows(snap({}))).toEqual([])
  })

  it('leaves a payables statement row and card charges to Group A, unchanged', () => {
    const parts = {
      payables: [payable({ name: 'Visa statement', source: 'statement', source_id: 9, statement_close: '2026-10-03' })],
      card_charges: [card({ charges: [charge({ name: 'Spotify', source_id: 5 })] })],
    }
    const without = dueRecurringRows(snap(parts), TODAY)
    const withStatement = dueRecurringRows(snap({ ...parts, card_statements_due: [statementDue({ account_id: 9, name: 'Visa' })] }), TODAY)
    expect(withStatement).toEqual(without)
  })

  it("keeps the card's missed subscription row once the statement is paid", () => {
    // After a Full Pay the card leaves card_statements_due; the unrecorded subscription
    // in the paid cycle stays in the card's missed list.
    const s = snap({
      card_statements_due: [],
      card_charges: [card({ missed: [cardMissed({ entry_id: 5, name: 'Spotify', count: 1, unlinked_count: 1, oldest: '2026-09-28', oldest_unlinked: '2026-09-28' })] })],
    })
    expect(dueStatementRows(s)).toEqual([])
    expect(missedRows(dueRecurringRows(s, TODAY))).toMatchObject([{ key: 'missed:5', name: 'Spotify', count: 1, oldest: '2026-09-28' }])
  })
})

describe('orderDueRows with statements', () => {
  const pend = (id: number, date: string) => duePendingRows([txn({ id, transaction_date: `${date}T00:00:00Z`, budget_entry_id: 900 + id, is_recurring: true })], [], snap({}), TODAY)
  const stmts = (...due: CardStatementDue[]) => dueStatementRows(snap({ card_statements_due: due }))
  const names = (rows: readonly DueSectionRow[]) =>
    rows.map((r) => (r.kind === 'pending' ? `p${r.transaction.id}` : r.kind === 'statement' ? `s${r.cardId}` : r.name))

  it('keeps the two-argument form and its return type', () => {
    const rec = dueRecurringRows(snap({ payables: [payable({ name: 'Today', source_id: 11 })] }), TODAY)
    const out: DueRow[] = orderDueRows(rec, pend(40, '2026-10-19'))
    expect(names(out)).toEqual(['p40', 'Today'])
  })

  it('puts an overdue statement ahead of a non-overdue recurring row, by its oldest owed due day', () => {
    const rec = dueRecurringRows(snap({ payables: [payable({ name: 'Today', source_id: 11 })] }), TODAY)
    const statements = stmts(statementDue({ account_id: 9, name: 'Visa', overdue: true, statement_count: 2, oldest_due: '2026-09-24' }))
    expect(names(orderDueRows(rec, pend(40, '2026-10-01'), statements))).toEqual(['s9', 'p40', 'Today'])
  })

  it('sorts a non-overdue statement after the rows due today, whatever its due day', () => {
    const rec = dueRecurringRows(snap({ payables: [payable({ name: 'Today', source_id: 11 })] }), TODAY)
    expect(names(orderDueRows(rec, [], stmts(statementDue({ account_id: 9, name: 'Visa', oldest_due: '2026-10-24' }))))).toEqual(
      ['Today', 's9'],
    )
  })

  it('orders a day tie as recurring family, then statements by name and card id, then pending', () => {
    const day = '2026-10-10'
    const rec = dueRecurringRows(
      snap({ payables: [payable({ name: 'Zulu', source_id: 12, occurrence_date: day, due_date: TODAY, original_date: day, overdue: true })] }),
      TODAY,
    )
    const statements = stmts(
      statementDue({ account_id: 8, name: 'Visa', overdue: true, oldest_due: day }),
      statementDue({ account_id: 3, name: 'Visa', overdue: true, oldest_due: day }),
      statementDue({ account_id: 1, name: 'Amex', overdue: true, oldest_due: day }),
    )
    expect(names(orderDueRows(rec, pend(40, day), statements))).toEqual(['Zulu', 's1', 's3', 's8', 'p40'])
  })

  it('calls an overdue statement row overdue and a current one not', () => {
    const [late, current] = stmts(
      statementDue({ account_id: 1, name: 'Amex', overdue: true }),
      statementDue({ account_id: 2, name: 'Visa' }),
    )
    expect(isOverdueRow(late!)).toBe(true)
    expect(isOverdueRow(current!)).toBe(false)
  })

  it('leaves the inputs alone and keeps every row', () => {
    const rec = dueRecurringRows(snap({ payables: [payable({ name: 'Today', source_id: 11 })] }), TODAY)
    const pending = pend(40, '2026-10-19')
    expect(pending).toHaveLength(1)
    const statements = stmts(
      statementDue({ account_id: 2, name: 'Visa' }),
      statementDue({ account_id: 1, name: 'Amex', overdue: true }),
    )
    const copies = [structuredClone(rec), structuredClone(pending), structuredClone(statements)]
    const out = orderDueRows(rec, pending, statements)
    expect(out).toHaveLength(rec.length + pending.length + statements.length)
    expect([rec, pending, statements]).toEqual(copies)
    expect(names(statements)).toEqual(['s2', 's1'])
  })
})

describe('effectiveDuePage', () => {
  it('keeps the chosen page on the same day', () => {
    expect(effectiveDuePage({ page: 3, day: TODAY }, TODAY)).toBe(3)
  })

  it('is page 1 on a new day, even while the list is briefly short', () => {
    const state = { page: 3, day: '2026-10-19' }
    // The new day's window has not fully arrived: 5 rows is 2 pages, so page 3 alone would clamp to page 2.
    const shown = pageWindow(5, effectiveDuePage(state, TODAY), DUE_PAGE_SIZE).page
    expect(shown).toBe(1)
    const persisted = { page: shown, day: TODAY }
    // When the rows arrive again the reader is still on page 1.
    expect(pageWindow(9, effectiveDuePage(persisted, TODAY), DUE_PAGE_SIZE).page).toBe(1)
  })
})

const apRow = (r: Partial<InstallmentAutoPostRow> & Pick<InstallmentAutoPostRow, 'entry_id' | 'name'>): InstallmentAutoPostRow => ({
  account_name: 'Visa',
  due_count: 1,
  postable_count: 1,
  due_today_count: 1,
  oldest: TODAY,
  state: 'on',
  block_reason: null,
  can_post: true,
  can_review: true,
  ...r,
})

describe('installment auto-post in the due section', () => {
  it('a missed installment row carries its state, reason and label', () => {
    const s = snap({
      auto_post_scheduled: true,
      missed: [missed({ entry_id: 5, name: 'Tablet', capped: true, plan_kind: null, auto_post: 'on', can_review: true })],
    })
    const [row] = missedRows(dueRecurringRows(s, TODAY))
    expect(row?.autoPost).toBe('on')
    expect(row?.autoPostLabel).toBe('Auto-posts each morning')
    expect(row?.review).toBe(false)
  })

  it('shows Review on an unreviewed or held row only with can_review', () => {
    const rowFor = (auto_post: 'unreviewed' | 'held', can_review: boolean) =>
      missedRows(dueRecurringRows(snap({ missed: [missed({ entry_id: 5, name: 'Tablet', plan_kind: null, auto_post, can_review })] }), TODAY))[0]
    expect(rowFor('unreviewed', true)?.review).toBe(true)
    expect(rowFor('held', true)?.review).toBe(true)
    expect(rowFor('unreviewed', false)?.review).toBe(false)
    expect(rowFor('held', false)?.review).toBe(false)
    expect(rowFor('unreviewed', false)?.autoPostLabel).toBe('Review to auto-post')
  })

  it('carries a blocked reason into the label, and no state for a plain missed row', () => {
    const blocked = missedRows(
      dueRecurringRows(snap({ missed: [missed({ entry_id: 5, name: 'T', plan_kind: null, auto_post: 'blocked', block_reason: 'foreign_currency' })] }), TODAY),
    )[0]
    expect(blocked?.blockReason).toBe('foreign_currency')
    expect(blocked?.autoPostLabel).toContain('another currency')
    const plain = missedRows(dueRecurringRows(snap({ missed: [missed({ entry_id: 6, name: 'Rent' })] }), TODAY))[0]
    expect(plain?.autoPost).toBeNull()
    expect(plain?.autoPostLabel).toBeNull()
    expect(plain?.review).toBe(false)
  })

  it('a card missed row has no auto-post state', () => {
    const s = snap({ card_charges: [card({ missed: [cardMissed({ entry_id: 3, name: 'Netflix' })] })] })
    expect(missedRows(dueRecurringRows(s, TODAY))[0]?.autoPost).toBeNull()
  })
})

describe('dueReviewNotice', () => {
  const clean = { entry_version: '2026-10-17T03:04:05.123456+00:00', review_token: 'tok' }
  it('is null with nothing to review', () => {
    expect(dueReviewNotice(snap({}))).toBeNull()
  })
  it('counts the installments and lists one entry each, with clean and reason', () => {
    const one = dueReviewNotice(
      snap({ installment_review: [{ entry_id: 1, name: 'Tablet', account_name: 'Visa', missed_count: 2, clean_review: null }] }),
    )
    expect(one?.text).toBe("1 card installment doesn't auto-post yet")
    expect(one?.entries).toEqual([
      {
        entryId: 1,
        name: 'Tablet',
        accountName: 'Visa',
        missedCount: 2,
        clean: false,
        reason: '2 missed months to record · review it on its own',
      },
    ])
    const two = dueReviewNotice(
      snap({
        installment_review: [
          { entry_id: 1, name: 'Tablet', account_name: 'Visa', missed_count: 1, clean_review: null },
          { entry_id: 2, name: 'Phone', account_name: 'Visa', missed_count: 0, clean_review: clean },
        ],
      }),
    )
    expect(two?.text).toBe("2 card installments don't auto-post yet")
    expect(two?.entries[0]?.reason).toBe('1 missed month to record · review it on its own')
    expect(two?.entries[1]).toMatchObject({ clean: true, reason: null, missedCount: 0 })
  })
  it('falls back when nothing is missed but there is no clean binding', () => {
    const n = dueReviewNotice(
      snap({ installment_review: [{ entry_id: 3, name: 'Pending', account_name: 'Visa', missed_count: 0, clean_review: null }] }),
    )
    expect(n?.entries[0]).toMatchObject({ clean: false, reason: 'Needs a review of its own' })
  })
})

describe('postNowCount', () => {
  it('sums postable_count: a held row adds its postable months, off and blocked add 0', () => {
    const s = snap({
      installment_auto_post: [
        apRow({ entry_id: 1, name: 'A', postable_count: 2 }),
        apRow({ entry_id: 2, name: 'B', state: 'held', due_count: 4, postable_count: 1 }),
        apRow({ entry_id: 3, name: 'C', state: 'off', postable_count: 0 }),
        apRow({ entry_id: 4, name: 'D', state: 'blocked', block_reason: 'ambiguous', postable_count: 0 }),
        apRow({ entry_id: 5, name: 'E', can_post: false, postable_count: 0 }),
      ],
    })
    expect(postNowCount(s)).toBe(3)
  })
  it('is 0 with no rows, and has no button text then', () => {
    expect(postNowCount(snap({}))).toBe(0)
    expect(postNowText(0)).toBeNull()
  })
  it('words the button and the quiet line by count', () => {
    expect(postNowText(1)).toBe('Post 1 due installment month now')
    expect(postNowText(3)).toBe('Post 3 due installment months now')
    expect(postedOnOpenText(0)).toBeNull()
    expect(postedOnOpenText(1)).toBe('Posted 1 due payment')
    expect(postedOnOpenText(2)).toBe('Posted 2 due payments')
  })
})

describe('shouldPostOnOpen', () => {
  it('is true exactly when postNowCount is above 0', () => {
    expect(shouldPostOnOpen(snap({}))).toBe(false)
    expect(shouldPostOnOpen(snap({ installment_auto_post: [apRow({ entry_id: 1, name: 'A', postable_count: 0, state: 'off' })] }))).toBe(false)
    expect(shouldPostOnOpen(snap({ installment_auto_post: [apRow({ entry_id: 1, name: 'A' })] }))).toBe(true)
    expect(shouldPostOnOpen(snap({ installment_auto_post: [apRow({ entry_id: 1, name: 'A', state: 'held', postable_count: 1, due_count: 3 })] }))).toBe(true)
  })

  it('is also true when an autopay payment is postable, and false when every one is held', () => {
    const due = (postable_count: number) => ({
      source: 'budget_entry' as const, source_id: 9, name: 'Rent', account_name: 'Bank', due_count: 1,
      postable_count, oldest: '2026-11-01', state: 'on' as const, block_reason: null,
    })
    expect(shouldPostOnOpen({ ...snap({}), autopay_due: [due(1)] })).toBe(true)
    expect(shouldPostOnOpen({ ...snap({}), autopay_due: [due(0)] })).toBe(false)
  })
})

describe('dueTodayLines', () => {
  it('lists an installment due today that no missed row covers, with its state label', () => {
    const s = snap({
      auto_post_scheduled: false,
      installment_auto_post: [apRow({ entry_id: 1, name: 'Phone', due_count: 1 })],
    })
    const [line] = dueTodayLines(s)
    expect(line?.text).toBe('Phone · 1 due today · Auto-posts when you open Transactions')
    expect(line?.canPost).toBe(true)
  })
  it('leaves out an entry a missed row already shows', () => {
    const s = snap({
      installment_auto_post: [apRow({ entry_id: 5, name: 'Tablet', due_count: 3, due_today_count: 1 })],
      missed: [missed({ entry_id: 5, name: 'Tablet', auto_post: 'on' })],
    })
    expect(dueTodayLines(s)).toEqual([])
  })
  it('lists no line when every month due is before today and has a pending linked row', () => {
    const s = snap({
      installment_auto_post: [apRow({ entry_id: 5, name: 'Tablet', due_count: 3, postable_count: 3, due_today_count: 0, oldest: '2026-08-20' })],
      missed: [missed({ entry_id: 5, name: 'Tablet', auto_post: 'on', count: 3, unlinked_count: 0, oldest_unlinked: null, pending_transaction_ids: [41, 42, 43] })],
    })
    expect(dueTodayLines(s)).toEqual([])
  })
  it('counts only the month due today when the months before it have pending linked rows', () => {
    const s = snap({
      auto_post_scheduled: true,
      installment_auto_post: [apRow({ entry_id: 5, name: 'Tablet', due_count: 3, postable_count: 3, due_today_count: 1, oldest: '2026-08-20' })],
      missed: [missed({ entry_id: 5, name: 'Tablet', auto_post: 'on', count: 2, unlinked_count: 0, oldest_unlinked: null, pending_transaction_ids: [41, 42] })],
    })
    const [line, ...rest] = dueTodayLines(s)
    expect(rest).toEqual([])
    expect(line?.dueCount).toBe(1)
    expect(line?.text).toBe('Tablet · 1 due today · Auto-posts each morning')
    expect(line?.canPost).toBe(true)
  })
  it('lists no line for past months only when no missed row stands for the entry', () => {
    // A shared editor's view of an inactive card's installment: missed leaves it out for scope.
    const s = snap({
      installment_auto_post: [apRow({ entry_id: 5, name: 'Tablet', due_count: 3, postable_count: 0, due_today_count: 0, oldest: '2026-07-05', state: 'blocked', block_reason: 'creator_no_access' })],
    })
    expect(dueTodayLines(s)).toEqual([])
  })
  it('offers Review only for an unreviewed or held row the caller can review', () => {
    const s = snap({
      installment_auto_post: [
        apRow({ entry_id: 1, name: 'A', state: 'unreviewed', postable_count: 0 }),
        apRow({ entry_id: 2, name: 'B', state: 'held', can_review: false }),
        apRow({ entry_id: 3, name: 'C', state: 'on' }),
      ],
    })
    expect(dueTodayLines(s).map((l) => l.canReview)).toEqual([true, false, false])
  })
})

describe('statementRowText', () => {
  it('reads an unposted-only row with Review or Mark paid in Installments and no Pay', () => {
    const out = statementRowText({ amount: 0, unposted: 3, unpostedPostable: 0 })
    expect(out.unpostedOnly).toBe(true)
    expect(out.text).toBe('3 installment months not yet posted')
    expect(out.guidance).toBe('Review or Mark paid in Installments')
    expect(out.pay).toBe(false)
    expect(out.post).toBe(false)
  })
  it('offers Post now, and no guidance, when an unposted-only row has postable months', () => {
    const out = statementRowText({ amount: 0, unposted: 2, unpostedPostable: 2 })
    expect(out.post).toBe(true)
    expect(out.guidance).toBeNull()
    expect(out.pay).toBe(false)
  })
  it('keeps Pay and adds the unposted note when Full is above 0', () => {
    const out = statementRowText({ amount: 4200, unposted: 3, unpostedPostable: 1 })
    expect(out.unpostedOnly).toBe(false)
    expect(out.pay).toBe(true)
    expect(out.text).toBeNull()
    expect(out.note).toBe(
      'Full leaves out 3 installment months not yet posted. 2 of them need Review or Mark paid in Installments',
    )
  })
  it('is a plain Plan C row with no unposted months', () => {
    expect(statementRowText({ amount: 4200, unposted: 0, unpostedPostable: 0 })).toEqual({
      unpostedOnly: false, text: null, note: null, pay: true, post: false, guidance: null,
    })
  })
  it('maps the unposted counts from the snapshot onto the row', () => {
    const [row] = dueStatementRows(
      snap({ card_statements_due: [statementDue({ account_id: 9, name: 'Visa', clear_through: 0, unposted_installments: 3, unposted_postable: 1 })] }),
    )
    expect(row?.unposted).toBe(3)
    expect(row?.unpostedPostable).toBe(1)
  })
})

describe('isOneOffPending', () => {
  it.each([
    ['F1: full, linked, flag false', txn({ id: 1, transaction_date: TODAY, budget_entry_id: 7, is_recurring: false }), false],
    ['F2: full, unlinked, flag true', txn({ id: 2, transaction_date: TODAY, is_recurring: true }), true],
    ['S1: shared, flag true', sharedTxn({ id: 3, transaction_date: TODAY, is_recurring: true }), false],
    ['S2: shared, flag false', sharedTxn({ id: 4, transaction_date: TODAY, is_recurring: false }), true],
    ['F3: plain full', txn({ id: 5, transaction_date: TODAY }), true],
  ])('%s', (_name, t, oneOff) => {
    expect(isOneOffPending(t)).toBe(oneOff)
  })
})

describe('Due and Not posted yet split the pending rows', () => {
  const none = snap({})

  it('keeps a tied, unlinked row dated yesterday in Due as overdue (a paused entry)', () => {
    const rows = duePendingRows([txn({ id: 1, transaction_date: '2026-10-19T00:00:00Z', budget_entry_id: 7, is_recurring: true })], [], none, TODAY)
    expect(rows.map((r) => [r.transaction.id, r.overdue])).toEqual([[1, true]])
  })

  it('keeps a shared recurring row dated yesterday in Due as overdue', () => {
    const rows = duePendingRows([sharedTxn({ id: 3, transaction_date: '2026-10-19T00:00:00Z', is_recurring: true })], [], none, TODAY)
    expect(rows.map((r) => [r.transaction.id, r.view, r.overdue])).toEqual([[3, 'shared_full', true]])
  })

  it('lists a tied, unlinked, non-recurring row dated today in neither tab', () => {
    const t = txn({ id: 1, transaction_date: TODAY + 'T00:00:00Z', budget_entry_id: 7, is_recurring: false })
    expect(duePendingRows([t], [], none, TODAY)).toEqual([])
    expect(notPostedRows([t], TODAY)).toEqual([])
  })

  it('keeps a linked row dated yesterday in Due as overdue', () => {
    const s = snap({ missed: [missed({ entry_id: 2, name: 'Rent', pending_transaction_ids: [9] })] })
    const t = txn({ id: 9, transaction_date: '2026-10-19T00:00:00Z', budget_entry_id: 2, is_recurring: true })
    expect(duePendingRows([], [t], s, TODAY).map((r) => [r.transaction.id, r.overdue])).toEqual([[9, true]])
    expect(notPostedRows([t], TODAY)).toEqual([])
  })

  it('drops a one-off from Due, however old', () => {
    expect(duePendingRows([txn({ id: 1, transaction_date: '2026-01-01T00:00:00Z' })], [], none, TODAY)).toEqual([])
  })

  it('is disjoint, and together covers every visible unposted row dated today or earlier but a tied row dated today with no link', () => {
    const s = snap({ missed: [missed({ entry_id: 2, name: 'Rent', pending_transaction_ids: [4] })] })
    const D = (n: number) => `2026-10-${String(n).padStart(2, '0')}T00:00:00Z`
    const rows = [
      txn({ id: 1, transaction_date: D(20) }),
      txn({ id: 2, transaction_date: D(19) }),
      txn({ id: 3, transaction_date: D(20), budget_entry_id: 7, is_recurring: true }),
      txn({ id: 4, transaction_date: D(20), budget_entry_id: 2, is_recurring: true }),
      txn({ id: 5, transaction_date: D(19), budget_entry_id: 7, is_recurring: true }),
      txn({ id: 6, transaction_date: D(1), permissions: noPost }),
      txn({ id: 7, transaction_date: D(25) }),
      txn({ id: 8, transaction_date: D(25), budget_entry_id: 7, is_recurring: true }),
      txn({ id: 9, transaction_date: D(10), is_posted: true }),
      sharedTxn({ id: 10, transaction_date: D(19), is_recurring: true }),
      sharedTxn({ id: 11, transaction_date: D(19), is_recurring: false }),
      sharedTxn({ id: 12, transaction_date: D(20), is_recurring: true }),
      sharedTxn({ id: 13, transaction_date: D(20), is_recurring: false }),
      limitedTxn(14, D(5)),
    ]
    const due = new Set(duePendingRows(rows, [], s, TODAY).map((r) => r.transaction.id))
    const np = new Set(notPostedRows(rows, TODAY).map((r) => r.transaction.id))
    expect([...due].filter((id) => np.has(id))).toEqual([])
    const visible = rows
      .filter((t): t is FullTransaction | SharedFullTransaction => t.view !== 'limited' && !t.is_posted)
      .filter((t) => t.transaction_date.slice(0, 10) <= TODAY)
      .map((t) => t.id)
    const uncovered = visible.filter((id) => !due.has(id) && !np.has(id))
    expect(uncovered.sort((a, b) => a - b)).toEqual([3, 12])
    expect([...due].sort((a, b) => a - b)).toEqual([4, 5, 10])
    expect([...np].sort((a, b) => a - b)).toEqual([1, 2, 6, 11, 13])
  })
})

describe('notPostedRows', () => {
  const oneOff = (id: number, date: string, extra: Partial<FullTransaction> = {}) => txn({ id, transaction_date: `${date}T00:00:00Z`, ...extra })

  it('lists one-offs oldest first, with how long ago each was logged', () => {
    const rows = notPostedRows([oneOff(3, TODAY), oneOff(2, '2026-10-19'), oneOff(1, '2026-10-15')], TODAY)
    expect(rows.map((r) => [r.transaction.id, r.date, r.daysAgo, r.logged])).toEqual([
      [1, '2026-10-15', 5, 'logged 5 days ago'],
      [2, '2026-10-19', 1, 'logged 1 day ago'],
      [3, TODAY, 0, 'logged today'],
    ])
    expect(rows[0]).toMatchObject({ kind: 'not_posted', view: 'full', key: 'not_posted:1' })
  })

  it('orders two rows on one day by numeric id', () => {
    expect(notPostedRows([oneOff(10, '2026-10-19'), oneOff(9, '2026-10-19')], TODAY).map((r) => r.transaction.id)).toEqual([9, 10])
  })

  it('drops posted, Limited, future, tied and linked rows', () => {
    const rows = notPostedRows(
      [
        oneOff(1, '2026-10-19', { is_posted: true }),
        limitedTxn(2, '2026-10-19T00:00:00Z'),
        oneOff(3, '2026-10-21'),
        oneOff(4, '2026-10-19', { budget_entry_id: 7, is_recurring: false }),
        sharedTxn({ id: 5, transaction_date: '2026-10-19T00:00:00Z', is_recurring: true }),
        // A full row a missed row links carries its entry id.
        oneOff(6, '2026-10-19', { budget_entry_id: 2, is_recurring: true }),
        oneOff(7, '2026-10-19'),
      ],
      TODAY,
    )
    expect(rows.map((r) => r.transaction.id)).toEqual([7])
  })

  it('keeps a shared one-off, with Mark posted only when the caller can post', () => {
    const rows = notPostedRows(
      [
        sharedTxn({ id: 1, transaction_date: '2026-10-19T00:00:00Z', is_recurring: false }),
        sharedTxn({ id: 2, transaction_date: '2026-10-19T00:00:00Z', is_recurring: false, permissions: noPost }),
      ],
      TODAY,
    )
    expect(rows.map((r) => [r.transaction.id, r.view, r.action])).toEqual([[1, 'shared_full', 'mark_posted'], [2, 'shared_full', null]])
  })

  it('lists a row seen in two batches once', () => {
    const t = oneOff(1, '2026-10-19')
    expect(notPostedRows([t, { ...t }], TODAY)).toHaveLength(1)
  })

  it('includes a row dated today and reads the wall-time day', () => {
    const rows = notPostedRows([txn({ id: 1, transaction_date: '2026-10-19T23:30:00' })], TODAY)
    expect(rows[0]).toMatchObject({ date: '2026-10-19', daysAgo: 1 })
    expect(notPostedRows([oneOff(2, TODAY)], TODAY)).toHaveLength(1)
  })

  it('does not mutate its input', () => {
    const input = [oneOff(2, '2026-10-19'), oneOff(1, '2026-10-15')]
    const copy = structuredClone(input)
    notPostedRows(input, TODAY)
    expect(input).toEqual(copy)
  })
})

describe('loggedDays and loggedText', () => {
  it('counts whole calendar days', () => {
    expect(loggedDays('2026-10-19T23:30:00', '2026-10-20')).toBe(1)
    expect(loggedDays('2025-12-31', '2026-01-01')).toBe(1)
    expect(loggedDays('2028-02-28', '2028-03-01')).toBe(2)
    expect(loggedDays('2026-10-20', '2026-10-20')).toBe(0)
  })

  it('clamps a future day at 0 and gives null for an unreadable day', () => {
    expect(loggedDays('2026-10-25', '2026-10-20')).toBe(0)
    expect(loggedDays('', '2026-10-20')).toBeNull()
    expect(loggedDays('2026-10-20', '')).toBeNull()
  })

  it('words the count', () => {
    expect(loggedText(0)).toBe('logged today')
    expect(loggedText(1)).toBe('logged 1 day ago')
    expect(loggedText(2)).toBe('logged 2 days ago')
    expect(loggedText(30)).toBe('logged 30 days ago')
  })
})

describe('STU-511: Due loses subscription and installment rows', () => {
  // One snapshot holding every kind of row: which tab lists each is `plan_kind`'s call.
  const mixed = () =>
    snap({
      card_charges: [
        card({
          charges: [
            charge({ name: 'Netflix', source_id: 1, plan_kind: 'subscription' }),
            charge({ name: 'Phone', source_id: 2, kind: 'installment', plan_kind: 'installment' }),
            charge({ name: 'Meralco', source_id: 3, kind: 'bill', plan_kind: null }),
          ],
          missed: [cardMissed({ entry_id: 4, name: 'Spotify', plan_kind: 'subscription', oldest: '2026-09-20', oldest_unlinked: '2026-09-20', count: 1, unlinked_count: 1 })],
        }),
      ],
      payables: [
        payable({ name: 'Gym', source_id: 5, kind: 'cash', plan_kind: 'subscription', account_name: 'Checking' }),
        payable({ name: 'Rent', source_id: 6, kind: 'cash', plan_kind: null }),
        limitedEvent('p-1'),
      ],
      upcoming_this_month: [upcoming({ name: 'Salary', source_id: 7, entry_type: 'income', plan_kind: null })],
      missed: [
        missed({ entry_id: 8, name: 'Tablet', kind: 'installment', plan_kind: 'installment', capped: true, auto_post: 'unreviewed', can_review: true }),
        missed({ entry_id: 9, name: 'Water', kind: 'cash', plan_kind: null }),
      ],
    })

  const names = (rows: readonly { name: string }[]) => rows.map((r) => r.name).sort()

  describe('dueRecurringRows', () => {
    it('keeps rent, bills, the missed cash entry, income and Limited rows only', () => {
      const rows = dueRecurringRows(mixed(), TODAY)
      expect(names(rows)).toEqual(['Expense', 'Meralco', 'Rent', 'Salary', 'Water'])
      expect(missedRows(rows).map((r) => r.name)).toEqual(['Water'])
      expect(limitedOf(rows)).toHaveLength(1)
    })

    it('reads a missing plan_kind as null: an older API keeps every row in Due', () => {
      const s = mixed()
      const strip = <T extends object>(row: T): T => {
        const { plan_kind: _drop, ...rest } = row as T & { plan_kind?: unknown }
        return rest as T
      }
      const old: DashboardSnapshot = {
        ...s,
        card_charges: s.card_charges.map((c) => ({
          ...c,
          charges: c.charges.map((ch) => (ch.view === 'limited' ? ch : strip(ch))),
          missed: c.missed.map(strip),
        })),
        payables: s.payables.map((p) => (p.view === 'limited' ? p : strip(p))),
        upcoming_this_month: s.upcoming_this_month.map((u) => (u.view === 'limited' ? u : strip(u))),
        missed: s.missed.map(strip),
      }
      expect(JSON.stringify(old)).not.toContain('plan_kind')
      const rows = dueRecurringRows(old, TODAY)
      expect(names(rows)).toEqual(['Expense', 'Gym', 'Meralco', 'Netflix', 'Phone', 'Rent', 'Salary', 'Spotify', 'Tablet', 'Water'])
      expect(missedRows(rows).map((r) => r.name).sort()).toEqual(['Spotify', 'Tablet', 'Water'])
    })
  })

  describe('subscriptionPastRows', () => {
    it("holds the missed subscription as a missed row and today's as entry rows, nothing else", () => {
      const rows = subscriptionPastRows(mixed(), TODAY)
      expect(rows.map((r) => r.key)).toEqual(['missed:4', '5:2026-10-20', '1:2026-10-20'])
      const [spotify, gym, netflix] = rows
      expect(spotify).toMatchObject({ kind: 'missed', name: 'Spotify', text: '1 missed since Sep 20th, 2026', actions: ['charged', 'posted'] })
      expect(gym).toMatchObject({ kind: 'recurring', name: 'Gym', overdue: false, actions: ['mark_paid'] })
      expect(netflix).toMatchObject({ kind: 'recurring', name: 'Netflix', overdue: false, actions: ['charged', 'posted'] })
    })

    it('leaves installments to Installments: neither Due nor Subscriptions lists them', () => {
      const s = mixed()
      const all = [...dueRecurringRows(s, TODAY), ...subscriptionPastRows(s, TODAY)].map((r) => r.name)
      expect(all).not.toContain('Phone')
      expect(all).not.toContain('Tablet')
    })

    it('drops a past occurrence its missed row covers, keeps today and flags an uncovered one overdue', () => {
      const s = snap({
        card_charges: [
          card({
            charges: [
              // Covered: Spotify's missed row starts on 2026-09-20.
              charge({ name: 'Spotify', source_id: 4, plan_kind: 'subscription', date: '2026-10-15', occurrence_date: '2026-10-15', overdue: true }),
              charge({ name: 'Spotify', source_id: 4, plan_kind: 'subscription' }),
              // No missed row: listed, overdue.
              charge({ name: 'Cloud', source_id: 11, plan_kind: 'subscription', date: '2026-10-18', occurrence_date: '2026-10-18', overdue: true }),
            ],
            missed: [cardMissed({ entry_id: 4, name: 'Spotify', plan_kind: 'subscription', oldest: '2026-09-20', oldest_unlinked: '2026-09-20', count: 1, unlinked_count: 1 })],
          }),
        ],
      })
      const rows = subscriptionPastRows(s, TODAY)
      expect(rows.map((r) => r.key)).toEqual(['missed:4', '11:2026-10-18', '4:2026-10-20'])
      expect(rows[1]).toMatchObject({ kind: 'recurring', overdue: true })
      expect(dueRecurringRows(s, TODAY)).toEqual([])
    })
  })

  describe('orderSubscriptionRows', () => {
    const future = (name: string, entry_id: number, day: string): UpcomingOccurrence => ({
      view: 'full',
      entry_id,
      name,
      occurrence_date: day,
      entry_type: 'expense',
      is_transfer: false,
      kind: 'subscription',
      plan_kind: 'subscription',
      amount: 500,
      currency: 'PHP',
      account_name: 'Visa',
      transfer_to_account_name: null,
      capped: false,
      can_mark_paid: true,
      recordable: true,
      auto_post: null,
      block_reason: null,
      can_review: false,
    })

    it('lists missed, then overdue, then today, then the future by day', () => {
      const s = snap({
        card_charges: [
          card({
            charges: [
              charge({ name: 'Cloud', source_id: 11, plan_kind: 'subscription', date: '2026-10-18', occurrence_date: '2026-10-18', overdue: true }),
              charge({ name: 'Netflix', source_id: 1, plan_kind: 'subscription' }),
            ],
            missed: [cardMissed({ entry_id: 4, name: 'Spotify', plan_kind: 'subscription', oldest: '2026-09-20', oldest_unlinked: '2026-09-20', count: 1, unlinked_count: 1 })],
          }),
        ],
      })
      const past = subscriptionPastRows(s, TODAY)
      const later = [future('Disney', 12, '2026-10-25'), future('Apple', 13, '2026-10-22'), future('Adobe', 14, '2026-10-25')]
      const before = later.map((o) => o.name)
      const rows = orderSubscriptionRows(past, later)
      expect(rows.map((r) => r.key)).toEqual([
        'missed:4',
        '11:2026-10-18',
        '1:2026-10-20',
        'occ:13:2026-10-22',
        'occ:14:2026-10-25',
        'occ:12:2026-10-25',
      ])
      expect(rows[3]).toMatchObject({ kind: 'occurrence', day: '2026-10-22' })
      expect(later.map((o) => o.name)).toEqual(before)
    })

    it('puts a missed row first even when its day is later than an overdue row', () => {
      const missedLate = cardMissed({ entry_id: 4, name: 'Spotify', plan_kind: 'subscription', oldest: '2026-10-19', oldest_unlinked: '2026-10-19', count: 1, unlinked_count: 1 })
      const today = charge({ name: 'Netflix', source_id: 1, plan_kind: 'subscription' })
      const rows = orderSubscriptionRows(subscriptionPastRows(snap({ card_charges: [card({ charges: [today], missed: [missedLate] })] }), TODAY), [
        future('Apple', 13, '2026-10-21'),
      ])
      expect(rows.map((r) => r.key)).toEqual(['missed:4', '1:2026-10-20', 'occ:13:2026-10-21'])
    })
  })

  describe('installmentPlanView', () => {
    const plan = (over: Partial<InstallmentPlan> = {}): InstallmentPlan => ({
      view: 'full',
      entry_id: 21,
      name: 'BDO balance convert',
      account_name: 'Visa',
      amount: 2500,
      currency: 'PHP',
      next_charge: '2026-10-27',
      missed: 0,
      payments_left: 10,
      payments_total: 12,
      can_mark_paid: true,
      auto_post: 'off',
      block_reason: null,
      can_review: true,
      recordable: true,
      ...over,
    })

    it('reads "10 of 12 left" and the next charge, with Charged and Posted', () => {
      expect(installmentPlanView(plan(), TODAY, true)).toEqual({
        overdue: false,
        leftText: '10 of 12 left',
        nextText: 'Next charge Oct 27th, 2026',
        missedText: null,
        autoPostLabel: 'Auto-post off · Mark paid',
        actions: ['charged', 'posted'],
        review: false,
      })
    })

    it('reads the effective date of a moved next charge, and says where it was moved from', () => {
      const moved = installmentPlanView(plan({ next_charge: '2026-10-27', effective_date: '2026-10-30' }), TODAY, true)
      expect(moved.nextText).toBe('Next charge Oct 30th, 2026 (moved from Oct 27th, 2026)')
      expect(installmentPlanView(plan({ effective_date: '2026-10-27' }), TODAY, true).nextText).toBe('Next charge Oct 27th, 2026')
      expect(installmentPlanView(plan({ effective_date: null }), TODAY, true).nextText).toBe('Next charge Oct 27th, 2026')
    })

    it('is overdue by its effective date: a charge moved past today is not, one moved before it is', () => {
      expect(installmentPlanView(plan({ next_charge: '2026-10-19', effective_date: '2026-10-25' }), TODAY, true).overdue).toBe(false)
      expect(installmentPlanView(plan({ next_charge: '2026-10-25', effective_date: '2026-10-19' }), TODAY, true).overdue).toBe(true)
    })

    it('is overdue when the next charge is before today, not on it', () => {
      expect(installmentPlanView(plan({ next_charge: '2026-10-19' }), TODAY, true).overdue).toBe(true)
      expect(installmentPlanView(plan({ next_charge: TODAY }), TODAY, true).overdue).toBe(false)
    })

    it('says how many months are missed', () => {
      expect(installmentPlanView(plan({ next_charge: '2026-09-10', missed: 2 }), TODAY, true).missedText).toBe('2 missed')
      expect(installmentPlanView(plan({ missed: 1 }), TODAY, true).missedText).toBe('1 missed')
    })

    it('offers no button when auto-post is on, and labels it', () => {
      const view = installmentPlanView(plan({ auto_post: 'on', recordable: false }), TODAY, true)
      expect(view.actions).toEqual([])
      expect(view.review).toBe(false)
      expect(view.autoPostLabel).toBe('Auto-posts each morning')
      expect(installmentPlanView(plan({ auto_post: 'on', recordable: false }), TODAY, false).autoPostLabel).toBe(
        'Auto-posts when you open Transactions',
      )
    })

    it('offers Review on an unreviewed or held plan the caller can review', () => {
      expect(installmentPlanView(plan({ auto_post: 'unreviewed' }), TODAY, true).review).toBe(true)
      expect(installmentPlanView(plan({ auto_post: 'held' }), TODAY, true).review).toBe(true)
      expect(installmentPlanView(plan({ auto_post: 'unreviewed', can_review: false }), TODAY, true).review).toBe(false)
    })

    it('offers no button when the server says the next charge is not recordable', () => {
      expect(installmentPlanView(plan({ recordable: false }), TODAY, true).actions).toEqual([])
    })

    it('reads "All charges recorded" with no next charge, and offers nothing', () => {
      const view = installmentPlanView(plan({ next_charge: null, auto_post: 'unreviewed', payments_left: 0 }), TODAY, true)
      expect(view.nextText).toBe('All charges recorded')
      expect(view.overdue).toBe(false)
      expect(view.actions).toEqual([])
      expect(view.review).toBe(false)
      expect(view.leftText).toBe('0 of 12 left')
    })
  })

  describe('freshFor', () => {
    it('is fresh for the same day, or with no day (an older API)', () => {
      expect(freshFor(undefined, TODAY)).toBe(true)
      expect(freshFor(TODAY, TODAY)).toBe(true)
    })

    it('is stale for the previous day', () => {
      expect(freshFor('2026-10-19', TODAY)).toBe(false)
    })
  })
})
