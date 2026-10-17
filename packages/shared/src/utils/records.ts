import type {
  Account, BudgetEntry, CashflowTimelineEvent, LimitedTimelineEvent, OverflowMove, TimelineEventAccount,
  Transaction, UpcomingItemOrEvent,
} from '../types/api'

/**
 * Field readers that work on every record shape. A Limited record has `date` and
 * `display_description` where a Full one has `transaction_date` and `description`;
 * these pick the right one so callers don't have to narrow just to display a row.
 */

/** ISO datetime of a transaction, whatever its shape. */
export function transactionDate(transaction: Transaction): string {
  return transaction.view === 'limited' ? transaction.date : transaction.transaction_date
}

/** The text to show for a transaction, or null when there is none. Limited rows use the neutral label. */
export function transactionDescription(transaction: Transaction): string | null {
  const text = transaction.view === 'limited' ? transaction.display_description : transaction.description
  return text ?? null
}

/** The name to show for a recurring entry. Limited entries use the neutral display name. */
export function entryName(entry: BudgetEntry): string | null {
  return entry.view === 'limited' ? entry.display_name : entry.name
}

/** The name to show for a timeline event, whether full or limited. */
export function timelineEventName(event: CashflowTimelineEvent | LimitedTimelineEvent): string {
  return event.view === 'limited' ? event.display_name : event.name
}

/** The signed effect of a timeline event on cash (a limited event's `cash_delta`). */
export function timelineEventAmount(event: CashflowTimelineEvent | LimitedTimelineEvent): number {
  return event.view === 'limited' ? event.cash_delta : event.amount
}

/**
 * An upcoming item as listed: its amount, and whether money comes in or goes out.
 * A limited event lists its `face_amount`, not its `cash_delta`: that is only the
 * cash effect, which is 0 for a card charge billed on a later statement. Its
 * direction comes from its kind; a transfer's from the side of it the caller holds.
 * A Household occurrence (kind `household`) moves none of the caller's cash and does not
 * say which way it goes, so it has no direction.
 */
export function upcomingItemAmount(item: UpcomingItemOrEvent): { amount: number; direction: 'in' | 'out' | null } {
  if (item.view === 'limited') {
    let direction: 'in' | 'out' | null = item.kind === 'income' ? 'in' : 'out'
    if (item.kind === 'transfer') direction = item.cash_delta > 0 ? 'in' : item.cash_delta < 0 ? 'out' : null
    if (item.kind === 'household') direction = null
    return { amount: item.face_amount, direction }
  }
  const type = item.entry_type
  const direction = type === 'income' || type === 'credit' ? 'in' : type === 'expense' || type === 'debit' ? 'out' : null
  // An unconverted item (no stored rate) has a null amount; it reads 0 here, so a caller
  // that lists it checks `item.unconverted` first.
  return { amount: item.amount ?? 0, direction }
}

/** A timeline leg's account name, or "Unassigned" for a leg with no (visible) account. */
function legName(leg: TimelineEventAccount, withCurrency: boolean): string {
  const name = leg.account_name ?? 'Unassigned'
  return withCurrency && leg.currency ? `${name} (${leg.currency})` : name
}

/**
 * The timeline's Account column. A limited event names its one account; a full
 * event names its cash legs. A transfer (two legs of opposite sign) reads
 * "From → To", with each side's currency when they differ, so a cross-currency
 * transfer never reads like spending in one row.
 */
export function timelineEventAccountLabel(event: CashflowTimelineEvent | LimitedTimelineEvent): string {
  if (event.view === 'limited') return event.account?.name ?? '—'
  const legs = event.accounts ?? []
  if (legs.length === 0) return '—'
  if (legs.length === 1) return legName(legs[0], false)
  if (legs.length === 2) {
    const [a, b] = legs
    if (Math.sign(a.amount) * Math.sign(b.amount) < 0) {
      const [out, into] = a.amount < 0 ? [a, b] : [b, a]
      const mixed = out.currency !== into.currency
      return `${legName(out, mixed)} → ${legName(into, mixed)}`
    }
  }
  return legs.map((leg) => legName(leg, false)).join(', ')
}

/**
 * Whether an account can be the cash-flow timeline's main account: a projection-cash
 * account (not a card, loan or spending wallet) that is active and held with a direct
 * role. The API is the gate (400/404); this only filters the Settings list.
 */
export function isPinnableAccount(account: Pick<Account, 'account_type' | 'is_active' | 'is_spending_wallet' | 'my_role'>): boolean {
  return account.my_role !== 'tag_viewer'
    && account.is_active !== false
    && account.account_type !== 'credit'
    && account.account_type !== 'loan'
    && !account.is_spending_wallet
}

/**
 * The overflow moves that pull money out of `accountId`, in date order. A pinned
 * timeline walks the scheduled book only, so these drains show nowhere in its rows.
 */
export function overflowPullsFrom(moves: OverflowMove[], accountId: number): OverflowMove[] {
  return moves
    .filter((m) => m.from_account_id === accountId)
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
}
