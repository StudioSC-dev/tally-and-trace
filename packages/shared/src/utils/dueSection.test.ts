import { describe, it, expect } from 'vitest'
import type {
  InstallmentAutoPostRow,
  CardCharges,
  CardStatementDue,
  DashboardSnapshot,
  FullCharge,
  FullTransaction,
  LimitedCharge,
  LimitedEvent,
  LimitedTransaction,
  MissedCharge,
  Payable,
  RecordPermissions,
  RecurringMissed,
  SharedFullTransaction,
  UpcomingItem,
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
  dueRecurringRows,
  dueStatementRows,
  effectiveDuePage,
  isOverdueRow,
  orderDueRows,
  pendingLinkIds,
  pendingPostLabel,
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
      payables: [payable({ name: 'Netflix', source_id: 5, kind: 'subscription', due_date: '2026-10-22', occurrence_date: '2026-10-22', account_name: 'Visa' })],
      card_charges: [card({ statement_cycle: false, charges: [charge({ name: 'Netflix', source_id: 5, date: '2026-10-22', occurrence_date: '2026-10-22' })] })],
    })
    const rows = entries(dueRecurringRows(s, TODAY, mode))
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ key: '5:2026-10-22', view: 'full', recurring_kind: 'subscription', actions: ['charged', 'posted'] })
  })

  it('lists a plain transfer from upcoming with Mark paid', () => {
    const s = snap({ upcoming_this_month: [upcoming({ name: 'Save', source_id: 7, entry_type: 'transfer', due_date: '2026-10-24', occurrence_date: '2026-10-24' })] })
    const rows = entries(dueRecurringRows(s, TODAY))
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ name: 'Save', entry_type: 'transfer', view: null, actions: ['mark_paid'] })
  })

  it('lists a loan-payment transfer in both payables and upcoming once', () => {
    const s = snap({
      payables: [payable({ name: 'Loan', source_id: 8, kind: null, due_date: '2026-10-25', occurrence_date: '2026-10-25' })],
      upcoming_this_month: [upcoming({ name: 'Loan', source_id: 8, entry_type: 'transfer', due_date: '2026-10-25', occurrence_date: '2026-10-25' })],
    })
    const rows = entries(dueRecurringRows(s, TODAY))
    expect(rows).toHaveLength(1)
    // The payable row wins (it has the account) and takes the upcoming row's entry_type.
    expect(rows[0]).toMatchObject({ accountName: 'Checking', entry_type: 'transfer', actions: ['mark_paid'] })
  })

  it('lists income with Mark received and leaves upcoming expenses to the payables', () => {
    const s = snap({
      upcoming_this_month: [
        upcoming({ name: 'Salary', source_id: 3, entry_type: 'income', due_date: '2026-10-25', occurrence_date: '2026-10-25' }),
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
      payables: [payable({ name: 'Cloud', source_id: 13, kind: 'subscription', account_name: 'Visa' })],
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
      upcoming_this_month: [upcoming({ name: 'Salary', source_id: 3, entry_type: 'income', due_date: TODAY, occurrence_date: '2026-09-25', overdue: true })],
    })
    expect(entries(dueRecurringRows(s, TODAY))).toEqual([])
  })

  it("keeps today's occurrence and future ones", () => {
    const s = withMissed({
      payables: [
        payable({ name: 'Rent', source_id: 2, occurrence_date: TODAY }),
        payable({ name: 'Rent', source_id: 2, occurrence_date: '2026-11-05', due_date: '2026-11-05' }),
      ],
    })
    expect(entries(dueRecurringRows(s, TODAY)).map((r) => r.occurrenceDate)).toEqual([TODAY, '2026-11-05'])
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
      payables: [payable({ name: 'Rent', source_id: 2, occurrence_date: '2026-09-20', due_date: TODAY, overdue: true })],
    })
    expect(dueRecurringRows(s, TODAY)).toEqual([])
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
        missed({ entry_id: 5, name: 'Phone', kind: 'installment', capped: true }),
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
        payable({ name: 'Late', source_id: 12, occurrence_date: '2026-10-10', due_date: TODAY, overdue: true }),
      ],
    })
    expect(dueRecurringRows(s, TODAY).map((r) => r.name)).toEqual(['Old Rent', 'Late', 'Today', 'Later'])
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

  it.each(MODES)('lists yesterday, a recurring card charge and linked rows; drops future, posted and Limited rows (%s)', (mode) => {
    // The Limited mode never adds a pending row.
    void mode
    const window = [
      txn({ id: 40, transaction_date: '2026-10-19T00:00:00Z' }),
      txn({ id: 41, transaction_date: '2026-10-25T00:00:00Z' }),
      txn({ id: 42, transaction_date: '2026-10-18T00:00:00Z', is_posted: true }),
      txn({ id: 50, transaction_date: '2026-10-25T00:00:00Z' }),
      txn({ id: 51, transaction_date: '2026-10-25T00:00:00Z' }),
      txn({ id: 52, transaction_date: TODAY + 'T00:00:00Z' }),
    ]
    const linked = [
      txn({ id: 60, transaction_date: '2026-12-04T00:00:00Z' }),
      txn({ id: 61, transaction_date: '2026-09-20T00:00:00Z', is_posted: true }),
    ]
    const rows = duePendingRows([...window, limitedTxn(70, '2026-10-10T00:00:00Z')], linked, s, TODAY)
    expect(rows.map((r) => [r.transaction.id, r.overdue, r.action])).toEqual([
      [40, true, 'mark_posted'],
      [50, false, 'posted'],
      [60, false, 'mark_posted'],
    ])
  })

  it('lists a row in both queries once', () => {
    const t = txn({ id: 40, transaction_date: '2026-10-01T00:00:00Z' })
    expect(duePendingRows([t], [t], s, TODAY)).toHaveLength(1)
  })

  it('reads the day from the wall-time components', () => {
    // 23:30 wall time on the 19th is still the 19th.
    const rows = duePendingRows([txn({ id: 40, transaction_date: '2026-10-19T23:30:00' })], [], s, TODAY)
    expect(rows[0]).toMatchObject({ date: '2026-10-19', overdue: true })
  })

  it('offers no action without can_post, and keeps a shared_full row', () => {
    const rows = duePendingRows(
      [txn({ id: 40, transaction_date: '2026-10-01T00:00:00Z', permissions: noPost }), sharedTxn({ id: 50, transaction_date: '2026-10-25T00:00:00Z' })],
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
  const pend = (id: number, date: string) => duePendingRows([txn({ id, transaction_date: `${date}T00:00:00Z` })], [], snap({}), TODAY)
  const names = (rows: ReturnType<typeof orderDueRows>) => rows.map((r) => (r.kind === 'pending' ? `p${r.transaction.id}` : r.name))

  it('puts an overdue pending row before a non-overdue recurring row', () => {
    const rec = dueRecurringRows(snap({ payables: [payable({ name: 'Rent', source_id: 1, occurrence_date: '2026-10-25', due_date: '2026-10-25' })] }), TODAY)
    expect(names(orderDueRows(rec, pend(40, '2026-10-19')))).toEqual(['p40', 'Rent'])
  })

  it('puts missed and overdue rows ahead of due-today and future rows', () => {
    const rec = dueRecurringRows(
      snap({
        missed: [missed({ entry_id: 2, name: 'Old Rent', oldest_unlinked: '2026-09-01' })],
        payables: [
          payable({ name: 'Later', source_id: 10, occurrence_date: '2026-10-25', due_date: '2026-10-25' }),
          payable({ name: 'Today', source_id: 11 }),
          payable({ name: 'Late', source_id: 12, occurrence_date: '2026-10-10', due_date: TODAY, overdue: true }),
        ],
      }),
      TODAY,
    )
    expect(names(orderDueRows(rec, pend(40, '2026-10-19')))).toEqual(['Old Rent', 'Late', 'p40', 'Today', 'Later'])
  })

  it('puts the oldest overdue row first across kinds', () => {
    const rec = dueRecurringRows(snap({ payables: [payable({ name: 'Late', source_id: 12, occurrence_date: '2026-10-10', due_date: TODAY, overdue: true })] }), TODAY)
    expect(names(orderDueRows(rec, pend(40, '2026-10-05')))).toEqual(['p40', 'Late'])
  })

  it('orders a day tie by the recurring family order, then pending', () => {
    const rec = dueRecurringRows(
      snap({
        missed: [missed({ entry_id: 2, name: 'Zed', oldest_unlinked: '2026-10-10' })],
        payables: [payable({ name: 'Alpha', source_id: 12, occurrence_date: '2026-10-10', due_date: TODAY, overdue: true })],
      }),
      TODAY,
    )
    // dueRecurringRows' own order (name) is kept within the recurring family.
    expect(names(orderDueRows(rec, pend(40, '2026-10-10')))).toEqual(['Alpha', 'Zed', 'p40'])
  })

  it('orders two pending rows on one day by numeric id', () => {
    const rows = duePendingRows(
      [txn({ id: 10, transaction_date: '2026-10-19T00:00:00Z' }), txn({ id: 9, transaction_date: '2026-10-19T00:00:00Z' })],
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
  const pend = (id: number, date: string) => duePendingRows([txn({ id, transaction_date: `${date}T00:00:00Z` })], [], snap({}), TODAY)
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

  it('sorts a non-overdue statement among the future rows by day', () => {
    const rec = dueRecurringRows(
      snap({
        payables: [
          payable({ name: 'Today', source_id: 11 }),
          payable({ name: 'Later', source_id: 12, occurrence_date: '2026-10-28', due_date: '2026-10-28' }),
        ],
      }),
      TODAY,
    )
    expect(names(orderDueRows(rec, [], stmts(statementDue({ account_id: 9, name: 'Visa', oldest_due: '2026-10-24' }))))).toEqual(
      ['Today', 's9', 'Later'],
    )
  })

  it('orders a day tie as recurring family, then statements by name and card id, then pending', () => {
    const day = '2026-10-10'
    const rec = dueRecurringRows(
      snap({ payables: [payable({ name: 'Zulu', source_id: 12, occurrence_date: day, due_date: TODAY, overdue: true })] }),
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
      missed: [missed({ entry_id: 5, name: 'Tablet', capped: true, auto_post: 'on', can_review: true })],
    })
    const [row] = missedRows(dueRecurringRows(s, TODAY))
    expect(row?.autoPost).toBe('on')
    expect(row?.autoPostLabel).toBe('Auto-posts each morning')
    expect(row?.review).toBe(false)
  })

  it('shows Review on an unreviewed or held row only with can_review', () => {
    const rowFor = (auto_post: 'unreviewed' | 'held', can_review: boolean) =>
      missedRows(dueRecurringRows(snap({ missed: [missed({ entry_id: 5, name: 'Tablet', auto_post, can_review })] }), TODAY))[0]
    expect(rowFor('unreviewed', true)?.review).toBe(true)
    expect(rowFor('held', true)?.review).toBe(true)
    expect(rowFor('unreviewed', false)?.review).toBe(false)
    expect(rowFor('held', false)?.review).toBe(false)
    expect(rowFor('unreviewed', false)?.autoPostLabel).toBe('Review to auto-post')
  })

  it('carries a blocked reason into the label, and no state for a plain missed row', () => {
    const blocked = missedRows(
      dueRecurringRows(snap({ missed: [missed({ entry_id: 5, name: 'T', auto_post: 'blocked', block_reason: 'foreign_currency' })] }), TODAY),
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
  it('is null with nothing to review', () => {
    expect(dueReviewNotice(snap({}))).toBeNull()
  })
  it('counts the installments and lists one entry each', () => {
    const one = dueReviewNotice(snap({ installment_review: [{ entry_id: 1, name: 'Tablet', account_name: 'Visa', missed_count: 2 }] }))
    expect(one?.text).toBe("1 card installment doesn't auto-post yet")
    expect(one?.entries).toEqual([{ entryId: 1, name: 'Tablet', accountName: 'Visa', missedCount: 2 }])
    const two = dueReviewNotice(
      snap({
        installment_review: [
          { entry_id: 1, name: 'Tablet', account_name: 'Visa', missed_count: 2 },
          { entry_id: 2, name: 'Phone', account_name: 'Visa', missed_count: 0 },
        ],
      }),
    )
    expect(two?.text).toBe("2 card installments don't auto-post yet")
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
    expect(postedOnOpenText(1)).toBe('Posted 1 due installment month')
    expect(postedOnOpenText(2)).toBe('Posted 2 due installment months')
  })
})

describe('shouldPostOnOpen', () => {
  it('is true exactly when postNowCount is above 0', () => {
    expect(shouldPostOnOpen(snap({}))).toBe(false)
    expect(shouldPostOnOpen(snap({ installment_auto_post: [apRow({ entry_id: 1, name: 'A', postable_count: 0, state: 'off' })] }))).toBe(false)
    expect(shouldPostOnOpen(snap({ installment_auto_post: [apRow({ entry_id: 1, name: 'A' })] }))).toBe(true)
    expect(shouldPostOnOpen(snap({ installment_auto_post: [apRow({ entry_id: 1, name: 'A', state: 'held', postable_count: 1, due_count: 3 })] }))).toBe(true)
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
      installment_auto_post: [apRow({ entry_id: 5, name: 'Tablet', due_count: 3 })],
      missed: [missed({ entry_id: 5, name: 'Tablet', auto_post: 'on' })],
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
  it('reads an unposted-only row with Review or Mark paid below and no Pay', () => {
    const out = statementRowText({ amount: 0, unposted: 3, unpostedPostable: 0 })
    expect(out.unpostedOnly).toBe(true)
    expect(out.text).toBe('3 installment months not yet posted')
    expect(out.guidance).toBe('Review or Mark paid below')
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
      'Full leaves out 3 installment months not yet posted. 2 of them need Review or Mark paid in Due and overdue',
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
