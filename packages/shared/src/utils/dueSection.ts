import type {
  DashboardSnapshot,
  Estimate,
  FullTransaction,
  InstallmentAutoPostState,
  InstallmentBlockReason,
  InstallmentPlan,
  PlanKind,
  SharedFullTransaction,
  Transaction,
  UpcomingOccurrence,
} from '../types/api'
import { isLimitedEvent } from '../types/api'
import type { CurrencyCode } from './currency'
import { formatEntryDate } from './entryDate'
import { effectiveDay, movedText } from './forcedDate'
import { unpostedNote } from './cardPay'
import { autoPostLabel } from './installmentReview'
import { autopayPostable } from './settlement'
import { type RecurringAction, recurringActionsFor } from './recurringActions'
import { wallDay } from './transactionList'
import type { UpcomingRow } from './upcomingList'

/**
 * The Transactions page's "Due and overdue" section, built from the dashboard
 * snapshot (Group A, recurring; Group C, card statements) and the pending
 * transactions (Group B). Days are
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
  /** The scheduled day: the occurrence's identity, sent back by Mark paid. */
  occurrenceDate: string
  /** Its forced date, or `occurrenceDate`. The row is placed, sorted and called overdue on it. */
  effectiveDate: string
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
  /** `oldest` on its forced date, where the row sorts. */
  oldestEffective: string
  /** `oldestEffective` is the API's word for `oldest`, so Change date can pre-fill it; false leaves the dialog to look it up. */
  oldestEffectiveKnown: boolean
  /** "{count} missed since {oldestEffective}". */
  text: string
  can_mark_paid: boolean
  actions: RecurringAction[]
  /** A card installment's auto-post state; null for any other entry. */
  autoPost: InstallmentAutoPostState | null
  blockReason: InstallmentBlockReason | null
  /** The state's label (see `autoPostLabel`); null with no state. */
  autoPostLabel: string | null
  /** Show Review: the caller can review it, and it is unreviewed or held. */
  review: boolean
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
  effectiveDate: string
  overdue: boolean
  entry_type: string | null
  recurring_kind: string | null
  amount: number | null
  currency: CurrencyCode | null
  estimate: Partial<Estimate>
  accountName: string | null
  can_mark_paid: boolean
  /** The card tab that lists the entry; null (or a missing field) is Due. */
  planKind: PlanKind | null
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
        effectiveDate: day(charge.original_date ?? charge.date),
        overdue: charge.overdue,
        entry_type: 'expense',
        recurring_kind: charge.kind,
        amount: charge.amount,
        currency: charge.currency,
        estimate: estimateOf(charge),
        accountName: card.account_name,
        can_mark_paid: charge.can_mark_paid,
        planKind: charge.plan_kind ?? null,
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
      effectiveDate: day(payable.original_date ?? payable.due_date),
      overdue: payable.overdue === true,
      entry_type: null,
      recurring_kind: payable.kind ?? null,
      amount: payable.amount,
      currency: payable.currency ?? null,
      estimate: estimateOf(payable),
      accountName: payable.account_name,
      can_mark_paid: payable.can_mark_paid === true,
      planKind: payable.plan_kind ?? null,
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
      effectiveDate: day(item.original_date ?? item.due_date),
      overdue: item.overdue === true,
      entry_type: item.entry_type,
      recurring_kind: item.kind ?? null,
      amount: item.amount,
      currency: item.currency ?? null,
      estimate: estimateOf(item),
      accountName: null,
      can_mark_paid: item.can_mark_paid === true,
      planKind: item.plan_kind ?? null,
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
  /** `oldest` on its forced date; null when the API does not say (a card's missed charge, an older API). */
  oldest_effective: string | null
  unlinked_count: number
  oldest_unlinked: string | null
  can_mark_paid: boolean
  auto_post: InstallmentAutoPostState | null
  block_reason: InstallmentBlockReason | null
  can_review: boolean
  plan_kind: PlanKind | null
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
      oldest_effective: null,
      unlinked_count: m.unlinked_count,
      oldest_unlinked: m.oldest_unlinked,
      can_mark_paid: m.can_mark_paid,
      auto_post: null,
      block_reason: null,
      can_review: false,
      plan_kind: m.plan_kind ?? null,
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
    oldest_effective: m.oldest_effective ?? null,
    unlinked_count: m.unlinked_count,
    oldest_unlinked: m.oldest_unlinked,
    can_mark_paid: m.can_mark_paid,
    auto_post: m.auto_post,
    block_reason: m.block_reason,
    can_review: m.can_review,
    plan_kind: m.plan_kind ?? null,
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
      return row.oldestEffective
    case 'recurring':
      return row.view === 'limited' ? row.date : row.effectiveDate
  }
}

function urgent(row: DueRecurringRow): boolean {
  return row.kind === 'missed' || row.overdue
}

/**
 * The recurring rows of one card tab (`plan`: null for Due), today and earlier only: a
 * later occurrence is listed in Upcoming or Subscriptions. Full rows from the card charges,
 * payables (budget entries) and upcoming income and transfers, merged on
 * `entryId:occurrenceDate` (card beats payable beats upcoming). A row is dropped when it is
 * not today's, is before today or overdue, and the entry has a missed row (`count > 0`)
 * whose `oldest` is on or before it. Missed rows are listed only while `unlinked_count > 0`.
 * A missing `plan_kind` reads as null. Unsorted; no Limited rows.
 */
function recurringRows(snapshot: DashboardSnapshot, today: string, plan: PlanKind | null): Array<DueEntryRow | DueMissedRow> {
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
      planKind: win.planKind ?? lose.planKind,
    })
  }

  const rows: Array<DueEntryRow | DueMissedRow> = []
  for (const [key, c] of merged) {
    if (c.planKind !== plan) continue
    const occ = c.effectiveDate
    // After today it is in Upcoming, recorded or not.
    if (occ > today) continue
    const past = occ !== today && (occ < today || c.overdue)
    const oldest = coveredFrom.get(c.entryId)
    // A missed run is nominal, like the candidate's identity.
    if (past && oldest !== undefined && oldest <= c.occurrenceDate) continue
    const fields = { kind: c.recurring_kind, entry_type: c.entry_type, can_mark_paid: c.can_mark_paid }
    rows.push({
      kind: 'recurring',
      view: c.view,
      key,
      entryId: c.entryId,
      name: c.name,
      occurrenceDate: c.occurrenceDate,
      effectiveDate: occ,
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
    if (m.plan_kind !== plan) continue
    if (m.unlinked_count <= 0 || m.oldest_unlinked === null) continue
    const oldest = day(m.oldest_unlinked)
    // `oldest_effective` belongs to the oldest missed day; a later unlinked one has no forced date to show.
    const known = m.oldest_effective !== null && day(m.oldest) === oldest
    const oldestEffective = known && m.oldest_effective !== null ? day(m.oldest_effective) : oldest
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
      oldestEffective,
      oldestEffectiveKnown: known,
      text: `${m.unlinked_count} missed since ${formatEntryDate(oldestEffective)}`,
      can_mark_paid: m.can_mark_paid,
      // The oldest unlinked occurrence has no pending link and no posted one.
      actions: recurringActionsFor({ kind: m.kind, entry_type: m.entry_type, can_mark_paid: m.can_mark_paid }),
      autoPost: m.auto_post,
      blockReason: m.block_reason,
      autoPostLabel: autoPostLabel(m.auto_post, snapshot.auto_post_scheduled, m.block_reason),
      review: m.can_review && (m.auto_post === 'unreviewed' || m.auto_post === 'held'),
    })
  }

  return rows
}

/** Missed and overdue rows first, then by day, name and key. */
function byUrgencyThenDay<T extends DueRecurringRow>(rows: T[]): T[] {
  return rows.sort((a, b) => {
    const rank = Number(!urgent(a)) - Number(!urgent(b))
    if (rank !== 0) return rank
    const byDay = sortDay(a).localeCompare(sortDay(b))
    if (byDay !== 0) return byDay
    return a.name.localeCompare(b.name) || a.key.localeCompare(b.key)
  })
}

/**
 * Group A: the recurring rows of entries no other card tab lists (`plan_kind` null or
 * missing), today and earlier, as `recurringRows` builds them. Subscription and installment
 * rows are left out: Subscriptions and Installments list them. Limited rows, which carry no
 * kind, follow `limited`. Missed and overdue rows sort first, then by day.
 */
export function dueRecurringRows(
  snapshot: DashboardSnapshot,
  today: string,
  limited: LimitedRowsMode = LIMITED_ROWS,
): DueRecurringRow[] {
  const rows: DueRecurringRow[] = recurringRows(snapshot, today, null)
  if (limited === 'text') rows.push(...limitedRows(snapshot))
  return byUrgencyThenDay(rows)
}

/**
 * The Subscriptions tab's rows dated today or earlier: missed, overdue and today's rows of
 * `plan_kind` `subscription` entries, with the same rules as Due (`recurringRows`). Missed
 * and overdue rows sort first, then by day.
 */
export function subscriptionPastRows(snapshot: DashboardSnapshot, today: string): Array<DueEntryRow | DueMissedRow> {
  return byUrgencyThenDay(recurringRows(snapshot, today, 'subscription'))
}

/** A future occurrence in Subscriptions, keyed as Upcoming keys it. */
export type SubscriptionOccurrenceRow = Extract<UpcomingRow, { kind: 'occurrence' }>

export type SubscriptionRow = DueEntryRow | DueMissedRow | SubscriptionOccurrenceRow

function subscriptionDay(row: SubscriptionRow): string {
  return row.kind === 'occurrence' ? row.day : sortDay(row)
}

function subscriptionName(row: SubscriptionRow): string {
  return row.kind === 'occurrence' ? row.occurrence.name : row.name
}

/**
 * The Subscriptions tab: `past` (`subscriptionPastRows`) and the future occurrences of the
 * `plan=subscription` query as one list. Missed and overdue rows first, then by day, name
 * and key. Returns a new array and leaves both inputs alone.
 */
export function orderSubscriptionRows(
  past: readonly (DueEntryRow | DueMissedRow)[],
  future: readonly UpcomingOccurrence[],
): SubscriptionRow[] {
  const rows: SubscriptionRow[] = [
    ...past,
    ...future.map((occurrence): SubscriptionOccurrenceRow => ({
      kind: 'occurrence',
      key: `occ:${occurrence.entry_id}:${occurrence.occurrence_date}`,
      day: occurrence.occurrence_date,
      occurrence,
    })),
  ]
  return rows.sort((a, b) => {
    const rank = Number(!(a.kind !== 'occurrence' && urgent(a))) - Number(!(b.kind !== 'occurrence' && urgent(b)))
    if (rank !== 0) return rank
    const byDay = subscriptionDay(a).localeCompare(subscriptionDay(b))
    if (byDay !== 0) return byDay
    return subscriptionName(a).localeCompare(subscriptionName(b)) || a.key.localeCompare(b.key)
  })
}

/** How one Installments plan row reads and what it offers. */
export interface InstallmentPlanView {
  /** The next charge's effective date is before today. */
  overdue: boolean
  /** "{payments_left} of {payments_total} left". */
  leftText: string
  /** "Next charge {date}" (the effective date, "(moved from ...)" when forced), or "All charges recorded" when there is none. */
  nextText: string
  /** "{missed} missed"; null with none. */
  missedText: string | null
  /** The auto-post state's label; null with no state. */
  autoPostLabel: string | null
  /** The record buttons for the next charge, primary first. */
  actions: RecurringAction[]
  /** Offer Review: the caller can review it, and it is unreviewed or held. */
  review: boolean
}

/**
 * One installment plan row. "N of M left" is `payments_left` of `payments_total`, as
 * Allocations reads it. Buttons come from `recurringActionsFor` with the server's
 * `recordable` as the permission and nothing else (the auto-post and first-month gates
 * live on the server). A plan with no next charge offers nothing.
 */
export function installmentPlanView(plan: InstallmentPlan, today: string, scheduled: boolean): InstallmentPlanView {
  const next = plan.next_charge
  return {
    overdue: next !== null && effectiveDay(next, plan.effective_date) < today,
    leftText: `${plan.payments_left} of ${plan.payments_total} left`,
    nextText: next === null ? 'All charges recorded' : `Next charge ${movedText(next, plan.effective_date)}`,
    missedText: plan.missed > 0 ? `${plan.missed} missed` : null,
    autoPostLabel: autoPostLabel(plan.auto_post, scheduled, plan.block_reason),
    actions:
      next === null ? [] : recurringActionsFor({ kind: 'installment', entry_type: 'expense', can_mark_paid: plan.recordable }),
    review: next !== null && plan.can_review && (plan.auto_post === 'unreviewed' || plan.auto_post === 'held'),
  }
}

/**
 * Whether a response is for the card's day: its `today` is `today`, or it has none (an older
 * API, read as fresh).
 */
export function freshFor(dataDay: string | undefined, today: string): boolean {
  return dataDay === undefined || dataDay === today
}

/** One source of a due card tab's badge, as its query reports it now. */
export interface DueBadgeSource {
  /** It holds data for the current request (RTK's `currentData`, which survives a failed refetch). */
  hasData: boolean
  /** That data is for the card's day: `freshFor(response.today, today)` for a dated response (the snapshot, the plans), else true. */
  fresh: boolean
  /** A request for it is in flight (a first load, a refetch or a Retry). */
  fetching: boolean
  /** Its latest fetch failed (RTK clears this when a refetch starts). */
  failed: boolean
  /** What it adds to the tab's total; read only when every source is complete. */
  count: number
}

/** A badge's figure: a number, or `'pending'` (shown as "…"); `complete` when it is the sum of complete sources. */
export interface DueBadge {
  figure: number | 'pending'
  complete: boolean
}

/**
 * The badge of a due card tab built from one or more sources (STU-511 D6, D7). `kept` is the
 * tab's last complete total for the Manila day, or undefined when it has none for today. The
 * first rule that holds decides:
 *
 * (a) a source's latest fetch failed: the kept total, else 0 (D7, after a failure);
 * (b) a source has nothing for today (no data, or a response dated another day): "…",
 *     even with a kept total, so a response still dated the old day never shows a count
 *     (plan-tabs (i): the new day reads "…" until its own data arrives);
 * (c) a source is fetching (a refetch or a Retry over data for today): the kept total,
 *     else "…", never a sum of one fresh source and another's stale cache;
 * (d) every source is complete: the sum, marked complete, which the caller keeps for the day.
 */
export function dueTabBadge(sources: readonly DueBadgeSource[], kept: number | undefined): DueBadge {
  if (sources.some((s) => s.failed)) return { figure: kept ?? 0, complete: false }
  if (sources.some((s) => !s.hasData || !s.fresh)) return { figure: 'pending', complete: false }
  if (sources.some((s) => s.fetching)) return { figure: kept ?? 'pending', complete: false }
  return { figure: sources.reduce((sum, s) => sum + s.count, 0), complete: true }
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
 * True when a pending row has no recurring link: the creator's `budget_entry_id`
 * is unset, or, for a shared view that drops the link, `is_recurring` is false
 * (the API keeps `is_recurring == (budget_entry_id IS NOT NULL)` on every row).
 */
export function isOneOffPending(txn: FullTransaction | SharedFullTransaction): boolean {
  return txn.view === 'full' ? txn.budget_entry_id == null : !txn.is_recurring
}

/** The window and linked rows merged by id, with Limited and posted rows dropped. */
function unpostedVisible(txns: readonly Transaction[]): Map<number, FullTransaction | SharedFullTransaction> {
  const byId = new Map<number, FullTransaction | SharedFullTransaction>()
  for (const txn of txns) {
    if (txn.view === 'limited' || txn.is_posted || byId.has(txn.id)) continue
    byId.set(txn.id, txn)
  }
  return byId
}

/**
 * Group B. The window and linked queries merged by id; posted and Limited rows
 * dropped, and so is any row dated after today (it is in Upcoming) and any one-off
 * (it is in "Not posted yet"). A tied row is listed when it is dated before today,
 * a missed row links it, or it is a recurring card charge in the snapshot. Sorted
 * by day, then id.
 */
export function duePendingRows(
  windowTxns: readonly Transaction[],
  linkedTxns: readonly Transaction[],
  snapshot: DashboardSnapshot,
  today: string,
): DuePendingRow[] {
  const linked = new Set(pendingLinkIds(snapshot))
  const recurring = recurringChargeIds(snapshot)
  const byId = unpostedVisible([...windowTxns, ...linkedTxns])
  const rows: DuePendingRow[] = []
  for (const txn of byId.values()) {
    if (isOneOffPending(txn)) continue
    const date = wallDay(txn.transaction_date)
    // After today it is in Upcoming.
    if (date > today) continue
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

/** A one-off pending row in "Not posted yet". */
export interface NotPostedRow {
  kind: 'not_posted'
  view: 'full' | 'shared_full'
  key: string
  transaction: FullTransaction | SharedFullTransaction
  date: string
  /** Whole days from the transaction's day to today; null when the day is unreadable. */
  daysAgo: number | null
  /** "logged today", "logged 1 day ago" or "logged N days ago". */
  logged: string
  action: 'mark_posted' | null
}

const DAY_MS = 86_400_000

function utcDay(day: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(day)
  if (!m) return null
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
}

/**
 * Whole calendar days from `day` to `today` (both `YYYY-MM-DD`), counted on UTC
 * components so a DST change never shifts it. Clamped at 0; null for an
 * unreadable day.
 */
export function loggedDays(day: string, today: string): number | null {
  const from = utcDay(day)
  const to = utcDay(today)
  if (from === null || to === null) return null
  return Math.max(0, Math.round((to - from) / DAY_MS))
}

/** "logged today", "logged 1 day ago" or "logged N days ago". */
export function loggedText(n: number): string {
  if (n === 0) return 'logged today'
  return n === 1 ? 'logged 1 day ago' : `logged ${n} days ago`
}

/**
 * "Not posted yet": the window query's one-off pending rows (no recurring link)
 * dated today or earlier, merged by id, oldest first, then id. `today` is the
 * Manila day.
 */
export function notPostedRows(windowTxns: readonly Transaction[], today: string): NotPostedRow[] {
  const rows: NotPostedRow[] = []
  for (const txn of unpostedVisible(windowTxns).values()) {
    if (!isOneOffPending(txn)) continue
    const date = wallDay(txn.transaction_date)
    if (date > today) continue
    const daysAgo = loggedDays(date, today)
    rows.push({
      kind: 'not_posted',
      view: txn.view,
      key: `not_posted:${txn.id}`,
      transaction: txn,
      date,
      daysAgo,
      logged: daysAgo === null ? 'Pending' : loggedText(daysAgo),
      action: txn.permissions.can_post ? 'mark_posted' : null,
    })
  }
  return rows.sort((a, b) => a.date.localeCompare(b.date) || a.transaction.id - b.transaction.id)
}

/**
 * One card's owed closed statements: an owner or admin's card in
 * `card_statements_due`. The server decides closed, due and overdue on the Manila
 * day, so no client day is needed. `amount` clears every closed statement through
 * the latest; `statements` mirrors `statement_count`.
 */
export interface DueStatementRow {
  kind: 'statement'
  /** `statement:cardId`. */
  key: string
  cardId: number
  name: string
  /** The latest closed statement's close and due days. */
  closeDate: string
  dueDate: string
  /** The oldest owed statement's due day, where the row sorts. */
  oldestDue: string
  overdue: boolean
  statements: number
  amount: number
  currency: CurrencyCode
  /** Some foreign charge has no exchange rate, so `amount` may be low. */
  incomplete: boolean
  /** Installment months on closed statements that are not posted yet. */
  unposted: number
  /** Of `unposted`, the months Post now would record. */
  unpostedPostable: number
}

/** Group C. One row per card in `card_statements_due`, in the server's order. */
export function dueStatementRows(snapshot: DashboardSnapshot): DueStatementRow[] {
  return snapshot.card_statements_due.map((s) => ({
    kind: 'statement',
    key: `statement:${s.account_id}`,
    cardId: s.account_id,
    name: s.name,
    closeDate: s.close_date,
    dueDate: s.due_date,
    oldestDue: s.oldest_due,
    overdue: s.overdue,
    statements: s.statement_count,
    amount: s.clear_through,
    currency: s.currency,
    incomplete: s.incomplete,
    unposted: s.unposted_installments,
    unpostedPostable: s.unposted_postable,
  }))
}

/**
 * How a statement row reads. `unpostedOnly`: nothing recorded is owed (`amount` 0) but
 * installment months are not posted yet; `text` says so, there is no Pay, and `guidance`
 * points to Review or Mark paid in Installments when Post now can record none of them. Otherwise it is a
 * Plan C row (`pay` true), and `note` repeats the Pay dialog's warning about unposted months.
 */
export function statementRowText(
  row: Pick<DueStatementRow, 'amount' | 'unposted' | 'unpostedPostable'>,
): {
  unpostedOnly: boolean
  text: string | null
  note: string | null
  pay: boolean
  post: boolean
  guidance: string | null
} {
  const unpostedOnly = row.amount <= 0 && row.unposted > 0
  const note = !unpostedOnly ? unpostedNote(row.unposted, row.unpostedPostable) : null
  return {
    unpostedOnly,
    text: unpostedOnly ? `${row.unposted} installment ${row.unposted === 1 ? 'month' : 'months'} not yet posted` : null,
    note: note === null ? null : note.review === null ? note.text : `${note.text}. ${note.review}`,
    pay: row.amount > 0,
    post: row.unpostedPostable > 0,
    guidance: unpostedOnly && row.unpostedPostable === 0 ? 'Review or Mark paid in Installments' : null,
  }
}

/** The months Post now would record: the sum of `postable_count` over the snapshot's installment rows. */
export function postNowCount(snapshot: Pick<DashboardSnapshot, 'installment_auto_post'>): number {
  return snapshot.installment_auto_post.reduce((sum, row) => sum + row.postable_count, 0)
}

/** The Post now button's text; null at 0, when there is no button. */
export function postNowText(count: number): string | null {
  if (count <= 0) return null
  return `Post ${count} due installment ${count === 1 ? 'month' : 'months'} now`
}

/** What the button reports after posting. */
export function postedResultText(posted: number): string {
  return `Posted ${posted}`
}

/** The quiet line after a page-open run posted payments of any kind (installments, cash entries, loans); null when it posted none. */
export function postedOnOpenText(posted: number): string | null {
  if (posted <= 0) return null
  return `Posted ${posted} due ${posted === 1 ? 'payment' : 'payments'}`
}

/**
 * Whether Due and overdue sends the page-open POST for this fresh snapshot: when Post now has a
 * card installment month, or an autopay cash entry or loan has a payment the run can post.
 */
export function shouldPostOnOpen(snapshot: Pick<DashboardSnapshot, 'installment_auto_post'> & Partial<Pick<DashboardSnapshot, 'autopay_due'>>): boolean {
  return postNowCount(snapshot) > 0 || autopayPostable(snapshot.autopay_due)
}

/** One row of the card-installment notice. */
export interface DueReviewNoticeEntry {
  entryId: number
  name: string
  accountName: string
  missedCount: number
  /** True when the review asks nothing, so the row can join a batch review. */
  clean: boolean
  /** Why the row cannot join a batch; null when clean. */
  reason: string | null
}

const REVIEW_ALONE = 'review it on its own'

function notCleanReason(missedCount: number): string {
  if (missedCount <= 0) return 'Needs a review of its own'
  return `${missedCount} missed ${missedCount === 1 ? 'month' : 'months'} to record · ${REVIEW_ALONE}`
}

/** The notice for card installments that do not auto-post yet; null when there are none. */
export function dueReviewNotice(
  snapshot: Pick<DashboardSnapshot, 'installment_review'>,
): { text: string; entries: DueReviewNoticeEntry[] } | null {
  const rows = snapshot.installment_review
  if (rows.length === 0) return null
  return {
    text: rows.length === 1 ? "1 card installment doesn't auto-post yet" : `${rows.length} card installments don't auto-post yet`,
    entries: rows.map((r) => {
      const clean = r.clean_review !== null
      return {
        entryId: r.entry_id,
        name: r.name,
        accountName: r.account_name,
        missedCount: r.missed_count,
        clean,
        reason: clean ? null : notCleanReason(r.missed_count),
      }
    }),
  }
}

/** A compact line for a reviewed installment with a month due today and no missed row. */
export interface DueTodayLine {
  key: string
  entryId: number
  name: string
  accountName: string
  /** The months due today: the snapshot's `due_today_count`. */
  dueCount: number
  postableCount: number
  state: InstallmentAutoPostState
  label: string | null
  /** "<name> · N due today · <state label>". */
  text: string
  canReview: boolean
  canPost: boolean
}

/**
 * One line per installment the snapshot lists with a month due today
 * (`due_today_count`, counted by the server on Manila's today) that no missed
 * row with unlinked months already covers. Months before today are not counted:
 * the missed list or their pending rows show them, and an entry the missed list
 * leaves out for scope gets no line for them either.
 */
export function dueTodayLines(snapshot: DashboardSnapshot): DueTodayLine[] {
  const covered = new Set<number>()
  for (const m of missedSources(snapshot)) {
    if (m.unlinked_count > 0 && m.oldest_unlinked !== null) covered.add(m.entry_id)
  }
  return snapshot.installment_auto_post
    .filter((r) => r.due_today_count > 0 && !covered.has(r.entry_id))
    .map((r) => {
      const label = autoPostLabel(r.state, snapshot.auto_post_scheduled, r.block_reason)
      const head = `${r.name} · ${r.due_today_count} due today`
      return {
        key: `due-today:${r.entry_id}`,
        entryId: r.entry_id,
        name: r.name,
        accountName: r.account_name,
        dueCount: r.due_today_count,
        postableCount: r.postable_count,
        state: r.state,
        label,
        text: label === null ? head : `${head} · ${label}`,
        canReview: r.can_review && (r.state === 'unreviewed' || r.state === 'held'),
        canPost: r.can_post,
      }
    })
}

/**
 * Rows per page of the "Due and overdue" section. Short on purpose, so the section
 * does not take over the screen.
 */
export const DUE_PAGE_SIZE = 3

export type DueRow = DueRecurringRow | DuePendingRow

/** Any row of the section, card statements included. */
export type DueSectionRow = DueRow | DueStatementRow

/** Overdue: a missed row, or a recurring, Limited, pending or statement row flagged overdue. A row due today is not. */
export function isOverdueRow(row: DueSectionRow): boolean {
  return row.kind === 'missed' || row.overdue
}

function rowDay(row: DueSectionRow): string {
  switch (row.kind) {
    case 'pending':
      return row.date
    case 'statement':
      return row.oldestDue
    default:
      return sortDay(row)
  }
}

/** On a day tie: the recurring family, then statements, then pending. */
function familyRank(row: DueSectionRow): number {
  switch (row.kind) {
    case 'statement':
      return 1
    case 'pending':
      return 2
    default:
      return 0
  }
}

/**
 * Recurring, pending and (when given) statement rows as one list: overdue rows
 * first, then by day ascending (the oldest overdue row first; a statement row's day
 * is its oldest owed due day). On the same day the recurring family comes first,
 * then statements, then pending. Recurring rows keep `dueRecurringRows`' relative
 * order, statement rows go by name then card id, pending rows by numeric id.
 * Returns a new array and leaves every input alone.
 */
export function orderDueRows(recurring: readonly DueRecurringRow[], pending: readonly DuePendingRow[]): DueRow[]
export function orderDueRows(
  recurring: readonly DueRecurringRow[],
  pending: readonly DuePendingRow[],
  statements: readonly DueStatementRow[],
): DueSectionRow[]
export function orderDueRows(
  recurring: readonly DueRecurringRow[],
  pending: readonly DuePendingRow[],
  statements: readonly DueStatementRow[] = [],
): DueSectionRow[] {
  const indexed = [...recurring, ...statements, ...pending].map((row, index) => ({ row, index }))
  indexed.sort((a, b) => {
    const tier = Number(!isOverdueRow(a.row)) - Number(!isOverdueRow(b.row))
    if (tier !== 0) return tier
    const byDay = rowDay(a.row).localeCompare(rowDay(b.row))
    if (byDay !== 0) return byDay
    const family = familyRank(a.row) - familyRank(b.row)
    if (family !== 0) return family
    if (a.row.kind === 'pending' && b.row.kind === 'pending') return a.row.transaction.id - b.row.transaction.id
    if (a.row.kind === 'statement' && b.row.kind === 'statement') {
      return a.row.name.localeCompare(b.row.name) || a.row.cardId - b.row.cardId
    }
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
