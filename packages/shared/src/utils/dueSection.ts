import type {
  DashboardSnapshot,
  Estimate,
  FullTransaction,
  SharedFullTransaction,
  Transaction,
} from '../types/api'
import { isLimitedEvent } from '../types/api'
import type { CurrencyCode } from './currency'
import { formatEntryDate } from './entryDate'
import { type RecurringAction, recurringActionsFor } from './recurringActions'
import { wallDay } from './transactionList'

/**
 * The Transactions page's "Due and overdue" section, built from the dashboard
 * snapshot (Group A, recurring) and the pending transactions (Group B). Days are
 * `YYYY-MM-DD`; `today` is the Manila calendar day.
 */

/**
 * Limited rows (the caller sees only a display name): `text` lists those from the
 * payables and card charges as read-only text, `drop` leaves them out. Either way
 * none come from the pending transactions.
 */
export const LIMITED_ROWS: 'text' | 'drop' = 'text'

export type LimitedRowsMode = 'text' | 'drop'

/**
 * One occurrence of a recurring entry the caller sees in full. `view` is null for a
 * payables or upcoming row, which does not say whether it is full or shared_full.
 */
export interface DueEntryRow {
  kind: 'recurring'
  view: 'full' | 'shared_full' | null
  /** `entryId:occurrenceDate`. */
  key: string
  entryId: number
  name: string
  occurrenceDate: string
  overdue: boolean
  /** `income`, `expense` or `transfer`; null when only a payables row lists it. */
  entry_type: string | null
  /** The entry's derived kind; null for income and transfers. */
  recurring_kind: string | null
  amount: number | null
  currency: CurrencyCode | null
  /**
   * The source row's estimate labels: `amount` was converted from another currency
   * (`estimated`), or could not be (`unconverted`, `amount` null). Empty when no
   * conversion was needed.
   */
  estimate: Partial<Estimate>
  accountName: string | null
  can_mark_paid: boolean
  actions: RecurringAction[]
}

/** A recurring entry's missed occurrences that have no pending linked row. */
export interface DueMissedRow {
  kind: 'missed'
  view: 'full' | 'shared_full' | null
  /** `missed:entryId`. */
  key: string
  entryId: number
  name: string
  entry_type: string | null
  recurring_kind: string | null
  capped: boolean
  accountName: string | null
  /** The unlinked missed occurrences. */
  count: number
  /** The oldest of them, where the dialog opens. */
  oldest: string
  /** "{count} missed since {oldest}". */
  text: string
  can_mark_paid: boolean
  actions: RecurringAction[]
}

/** A Limited payable or card charge, shown as text with no actions. */
export interface DueLimitedRow {
  kind: 'recurring'
  view: 'limited'
  /** `limited:public_id`. */
  key: string
  publicId: string
  name: string
  /** The real day (`original_date` when overdue). */
  date: string
  overdue: boolean
}

export type DueRecurringRow = DueEntryRow | DueMissedRow | DueLimitedRow

/** How a listed pending row is posted: Posted for a recurring card charge, otherwise Mark posted. */
export type PendingPostAction = 'posted' | 'mark_posted'

export const PENDING_POST_LABELS: Record<PendingPostAction, string> = {
  posted: 'Posted',
  mark_posted: 'Mark posted',
}

export interface DuePendingRow {
  kind: 'pending'
  view: 'full' | 'shared_full'
  key: string
  transaction: FullTransaction | SharedFullTransaction
  date: string
  /** Dated before today. */
  overdue: boolean
  /** Null when the caller cannot post it. */
  action: PendingPostAction | null
}

interface Candidate {
  /** Card beats payable beats upcoming. */
  rank: number
  view: 'full' | 'shared_full' | null
  entryId: number
  name: string
  occurrenceDate: string
  overdue: boolean
  entry_type: string | null
  recurring_kind: string | null
  amount: number | null
  currency: CurrencyCode | null
  estimate: Partial<Estimate>
  accountName: string | null
  can_mark_paid: boolean
}

/** Only the estimate labels a row carries, so they travel with its amount. */
function estimateOf(row: Partial<Estimate>): Partial<Estimate> {
  return {
    ...(row.estimated !== undefined ? { estimated: row.estimated } : {}),
    ...(row.unconverted !== undefined ? { unconverted: row.unconverted } : {}),
    ...(row.original_amount !== undefined ? { original_amount: row.original_amount } : {}),
    ...(row.original_currency !== undefined ? { original_currency: row.original_currency } : {}),
    ...(row.rate !== undefined ? { rate: row.rate } : {}),
    ...(row.rate_as_of !== undefined ? { rate_as_of: row.rate_as_of } : {}),
    ...(row.rate_stale !== undefined ? { rate_stale: row.rate_stale } : {}),
  }
}

const day = (value: string): string => (/^\d{4}-\d{2}-\d{2}$/.test(value) ? value : wallDay(value))

function candidates(snapshot: DashboardSnapshot): Candidate[] {
  const out: Candidate[] = []
  for (const card of snapshot.card_charges) {
    for (const charge of card.charges) {
      if (charge.view === 'limited' || charge.source !== 'budget_entry') continue
      out.push({
        rank: 0,
        view: charge.view,
        entryId: charge.source_id,
        name: charge.name,
        occurrenceDate: day(charge.occurrence_date ?? charge.original_date ?? charge.date),
        overdue: charge.overdue,
        entry_type: 'expense',
        recurring_kind: charge.kind,
        amount: charge.amount,
        currency: charge.currency,
        estimate: estimateOf(charge),
        accountName: card.account_name,
        can_mark_paid: charge.can_mark_paid,
      })
    }
  }
  for (const payable of snapshot.payables) {
    if (isLimitedEvent(payable) || payable.source !== 'budget_entry' || payable.source_id === null) continue
    out.push({
      rank: 1,
      view: null,
      entryId: payable.source_id,
      name: payable.name,
      occurrenceDate: day(payable.occurrence_date ?? payable.due_date),
      overdue: payable.overdue === true,
      entry_type: null,
      recurring_kind: payable.kind ?? null,
      amount: payable.amount,
      currency: payable.currency ?? null,
      estimate: estimateOf(payable),
      accountName: payable.account_name,
      can_mark_paid: payable.can_mark_paid === true,
    })
  }
  for (const item of snapshot.upcoming_this_month) {
    if (isLimitedEvent(item) || item.source !== 'budget_entry' || item.source_id === null) continue
    if (item.entry_type !== 'income' && item.entry_type !== 'transfer') continue
    out.push({
      rank: 2,
      view: null,
      entryId: item.source_id,
      name: item.name,
      occurrenceDate: day(item.occurrence_date ?? item.due_date),
      overdue: item.overdue === true,
      entry_type: item.entry_type,
      recurring_kind: item.kind ?? null,
      amount: item.amount,
      currency: item.currency ?? null,
      estimate: estimateOf(item),
      accountName: null,
      can_mark_paid: item.can_mark_paid === true,
    })
  }
  return out
}

interface MissedSource {
  view: 'full' | 'shared_full' | null
  entry_id: number
  name: string
  entry_type: string | null
  kind: string | null
  capped: boolean
  account_name: string | null
  count: number
  oldest: string
  unlinked_count: number
  oldest_unlinked: string | null
  can_mark_paid: boolean
}

function missedSources(snapshot: DashboardSnapshot): MissedSource[] {
  const card: MissedSource[] = snapshot.card_charges.flatMap((c) =>
    c.missed.map((m) => ({
      view: null,
      entry_id: m.entry_id,
      name: m.name,
      entry_type: 'expense',
      kind: m.kind,
      capped: false,
      account_name: c.account_name,
      count: m.count,
      oldest: m.oldest,
      unlinked_count: m.unlinked_count,
      oldest_unlinked: m.oldest_unlinked,
      can_mark_paid: m.can_mark_paid,
    })),
  )
  const other: MissedSource[] = snapshot.missed.map((m) => ({
    view: m.view,
    entry_id: m.entry_id,
    name: m.name,
    entry_type: m.is_transfer ? 'transfer' : m.entry_type,
    kind: m.kind,
    capped: m.capped,
    account_name: m.account_name,
    count: m.count,
    oldest: m.oldest,
    unlinked_count: m.unlinked_count,
    oldest_unlinked: m.oldest_unlinked,
    can_mark_paid: m.can_mark_paid,
  }))
  return [...card, ...other]
}

function limitedRows(snapshot: DashboardSnapshot): DueLimitedRow[] {
  const seen = new Map<string, DueLimitedRow>()
  const add = (row: { public_id: string; display_name: string; date: string; original_date: string | null; overdue: boolean }) => {
    if (seen.has(row.public_id)) return
    seen.set(row.public_id, {
      kind: 'recurring',
      view: 'limited',
      key: `limited:${row.public_id}`,
      publicId: row.public_id,
      name: row.display_name,
      date: day(row.original_date ?? row.date),
      overdue: row.overdue,
    })
  }
  for (const payable of snapshot.payables) if (isLimitedEvent(payable)) add(payable)
  for (const card of snapshot.card_charges) for (const charge of card.charges) if (charge.view === 'limited') add(charge)
  return [...seen.values()]
}

function sortDay(row: DueRecurringRow): string {
  switch (row.kind) {
    case 'missed':
      return row.oldest
    case 'recurring':
      return row.view === 'limited' ? row.date : row.occurrenceDate
  }
}

function urgent(row: DueRecurringRow): boolean {
  return row.kind === 'missed' || row.overdue
}

/**
 * Group A. Full rows from the card charges, payables (budget entries) and upcoming
 * income and transfers, merged on `entryId:occurrenceDate` (card beats payable beats
 * upcoming). A row is dropped when it is not today's, is before today or overdue, and
 * the entry has a missed row (`count > 0`) whose `oldest` is on or before it. Missed
 * rows are listed only while `unlinked_count > 0`. Limited rows follow `limited`.
 * Missed and overdue rows sort first, then by day.
 */
export function dueRecurringRows(
  snapshot: DashboardSnapshot,
  today: string,
  limited: LimitedRowsMode = LIMITED_ROWS,
): DueRecurringRow[] {
  const missed = missedSources(snapshot)
  const coveredFrom = new Map<number, string>()
  for (const m of missed) {
    if (m.count <= 0) continue
    const oldest = day(m.oldest)
    const prior = coveredFrom.get(m.entry_id)
    if (prior === undefined || oldest < prior) coveredFrom.set(m.entry_id, oldest)
  }

  const merged = new Map<string, Candidate>()
  for (const c of candidates(snapshot)) {
    const key = `${c.entryId}:${c.occurrenceDate}`
    const prior = merged.get(key)
    if (!prior) {
      merged.set(key, c)
      continue
    }
    const [win, lose] = c.rank < prior.rank ? [c, prior] : [prior, c]
    merged.set(key, {
      ...win,
      entry_type: win.entry_type ?? lose.entry_type,
      recurring_kind: win.recurring_kind ?? lose.recurring_kind,
      accountName: win.accountName ?? lose.accountName,
    })
  }

  const rows: DueRecurringRow[] = []
  for (const [key, c] of merged) {
    const occ = c.occurrenceDate
    const past = occ !== today && (occ < today || c.overdue)
    const oldest = coveredFrom.get(c.entryId)
    if (past && oldest !== undefined && oldest <= occ) continue
    const fields = { kind: c.recurring_kind, entry_type: c.entry_type, can_mark_paid: c.can_mark_paid }
    rows.push({
      kind: 'recurring',
      view: c.view,
      key,
      entryId: c.entryId,
      name: c.name,
      occurrenceDate: occ,
      overdue: occ < today || (c.overdue && occ !== today),
      entry_type: c.entry_type,
      recurring_kind: c.recurring_kind,
      amount: c.amount,
      currency: c.currency,
      estimate: c.estimate,
      accountName: c.accountName,
      can_mark_paid: c.can_mark_paid,
      actions: recurringActionsFor(fields),
    })
  }

  for (const m of missed) {
    if (m.unlinked_count <= 0 || m.oldest_unlinked === null) continue
    const oldest = day(m.oldest_unlinked)
    rows.push({
      kind: 'missed',
      view: m.view,
      key: `missed:${m.entry_id}`,
      entryId: m.entry_id,
      name: m.name,
      entry_type: m.entry_type,
      recurring_kind: m.kind,
      capped: m.capped,
      accountName: m.account_name,
      count: m.unlinked_count,
      oldest,
      text: `${m.unlinked_count} missed since ${formatEntryDate(oldest)}`,
      can_mark_paid: m.can_mark_paid,
      // The oldest unlinked occurrence has no pending link and no posted one.
      actions: recurringActionsFor({ kind: m.kind, entry_type: m.entry_type, can_mark_paid: m.can_mark_paid }),
    })
  }

  if (limited === 'text') rows.push(...limitedRows(snapshot))

  return rows.sort((a, b) => {
    const rank = Number(!urgent(a)) - Number(!urgent(b))
    if (rank !== 0) return rank
    const byDay = sortDay(a).localeCompare(sortDay(b))
    if (byDay !== 0) return byDay
    return a.name.localeCompare(b.name) || a.key.localeCompare(b.key)
  })
}

/** Every pending row id any missed row links, ascending and once each: the linked query's `ids`. */
export function pendingLinkIds(snapshot: DashboardSnapshot): number[] {
  const ids = new Set<number>()
  for (const card of snapshot.card_charges) for (const m of card.missed) for (const id of m.pending_transaction_ids) ids.add(id)
  for (const m of snapshot.missed) for (const id of m.pending_transaction_ids) ids.add(id)
  return [...ids].sort((a, b) => a - b)
}

/** Ids of the pending card debits the snapshot flags `recurring`. */
function recurringChargeIds(snapshot: DashboardSnapshot): Set<number> {
  const ids = new Set<number>()
  for (const card of snapshot.card_charges) {
    for (const charge of card.charges) {
      if (charge.view !== 'limited' && charge.source === 'transaction' && charge.recurring) ids.add(charge.source_id)
    }
  }
  return ids
}

/** "Posted" for a pending row the snapshot lists as a recurring card charge, otherwise "Mark posted". */
export function pendingPostLabel(txn: Pick<Transaction, 'id'>, snapshot: DashboardSnapshot): string {
  return PENDING_POST_LABELS[recurringChargeIds(snapshot).has(txn.id) ? 'posted' : 'mark_posted']
}

/**
 * Group B. The window and linked queries merged by id; posted and Limited rows
 * dropped. A row is listed when it is dated before today, a missed row links it, or
 * it is a recurring card charge in the snapshot. Sorted by day, then id.
 */
export function duePendingRows(
  windowTxns: readonly Transaction[],
  linkedTxns: readonly Transaction[],
  snapshot: DashboardSnapshot,
  today: string,
): DuePendingRow[] {
  const linked = new Set(pendingLinkIds(snapshot))
  const recurring = recurringChargeIds(snapshot)
  const byId = new Map<number, FullTransaction | SharedFullTransaction>()
  for (const txn of [...windowTxns, ...linkedTxns]) {
    if (txn.view === 'limited' || txn.is_posted || byId.has(txn.id)) continue
    byId.set(txn.id, txn)
  }
  const rows: DuePendingRow[] = []
  for (const txn of byId.values()) {
    const date = wallDay(txn.transaction_date)
    const overdue = date < today
    if (!overdue && !linked.has(txn.id) && !recurring.has(txn.id)) continue
    rows.push({
      kind: 'pending',
      view: txn.view,
      key: `pending:${txn.id}`,
      transaction: txn,
      date,
      overdue,
      action: txn.permissions.can_post ? (recurring.has(txn.id) ? 'posted' : 'mark_posted') : null,
    })
  }
  return rows.sort((a, b) => a.date.localeCompare(b.date) || a.transaction.id - b.transaction.id)
}

/**
 * Rows per page of the "Due and overdue" section. Short on purpose, so the section
 * does not take over the screen.
 */
export const DUE_PAGE_SIZE = 3

export type DueRow = DueRecurringRow | DuePendingRow

/** Overdue: a missed row, or a recurring, Limited or pending row flagged overdue. A row due today is not. */
export function isOverdueRow(row: DueRow): boolean {
  return row.kind === 'missed' || row.overdue
}

function rowDay(row: DueRow): string {
  return row.kind === 'pending' ? row.date : sortDay(row)
}

/**
 * Recurring and pending rows as one list: overdue rows first, then by day ascending
 * (the oldest overdue row first), the recurring family before pending on the same
 * day. Recurring rows keep `dueRecurringRows`' relative order, pending rows go by
 * numeric id. Returns a new array and leaves both inputs alone.
 */
export function orderDueRows(recurring: readonly DueRecurringRow[], pending: readonly DuePendingRow[]): DueRow[] {
  const indexed = [...recurring, ...pending].map((row, index) => ({ row, index }))
  indexed.sort((a, b) => {
    const tier = Number(!isOverdueRow(a.row)) - Number(!isOverdueRow(b.row))
    if (tier !== 0) return tier
    const byDay = rowDay(a.row).localeCompare(rowDay(b.row))
    if (byDay !== 0) return byDay
    if (a.row.kind === 'pending' && b.row.kind === 'pending') return a.row.transaction.id - b.row.transaction.id
    const family = Number(a.row.kind === 'pending') - Number(b.row.kind === 'pending')
    if (family !== 0) return family
    return a.index - b.index
  })
  return indexed.map((x) => x.row)
}

/** The page the reader chose, and the day they chose it on. */
export interface DuePageState {
  page: number
  day: string
}

/** The chosen page, or page 1 once the day has changed since it was chosen. */
export function effectiveDuePage(state: DuePageState, today: string): number {
  return state.day === today ? state.page : 1
}
