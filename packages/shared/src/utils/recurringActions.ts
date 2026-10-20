import type { EntryOccurrence } from '../types/api'

/**
 * How one recurring occurrence can be recorded. Each action is the materialise
 * endpoint: `charged` sends `is_posted: false` (one pending card debit), the
 * others record it posted.
 */
export type RecurringAction = 'mark_paid' | 'mark_received' | 'charged' | 'posted'

/** The exact button labels. */
export const RECURRING_ACTION_LABELS: Record<RecurringAction, string> = {
  mark_paid: 'Mark paid',
  mark_received: 'Mark received',
  charged: 'Charged',
  posted: 'Posted',
}

/**
 * What the helpers read from a row: an entry, a snapshot row or a missed row.
 * `kind` is the entry's derived kind (a card kind, `cash`, or null for income and
 * transfers); `entry_type` is `income` for money coming in.
 */
export interface RecurringActionRow {
  kind?: string | null
  entry_type?: string | null
  can_mark_paid?: boolean
}

export interface RecurringActionOptions {
  /** How the occurrence is already linked; any link hides Charged. */
  linked?: EntryOccurrence['linked'] | undefined
}

const CARD_KINDS: ReadonlySet<string> = new Set(['subscription', 'installment', 'bill'])

/** A card expense: subscription, installment or bill. */
export function isCardKind(kind: string | null | undefined): boolean {
  return kind != null && CARD_KINDS.has(kind)
}

function isIncome(row: RecurringActionRow): boolean {
  return row.entry_type === 'income'
}

/**
 * The buttons a recurring row offers, primary first. No permission: none. Income:
 * Mark received. A card kind: Charged and Posted, or Posted alone when the
 * occurrence is already linked. Anything else (cash, transfer, loan payment): Mark paid.
 */
export function recurringActionsFor(row: RecurringActionRow, opts: RecurringActionOptions = {}): RecurringAction[] {
  if (row.can_mark_paid !== true) return []
  if (isIncome(row)) return ['mark_received']
  if (isCardKind(row.kind)) return opts.linked != null ? ['posted'] : ['charged', 'posted']
  return ['mark_paid']
}

/** The action a dialog opens on when none is given: Posted for a card kind, otherwise the single action. */
export function defaultRecurringAction(row: Pick<RecurringActionRow, 'kind' | 'entry_type'>): RecurringAction {
  if (isIncome(row)) return 'mark_received'
  if (isCardKind(row.kind)) return 'posted'
  return 'mark_paid'
}

/** The Mark paid dialog's title: "Mark {name} as paid", "Mark {name} as received", or "Record {name}" for a card kind. */
export function recurringDialogTitle(name: string, row: Pick<RecurringActionRow, 'kind' | 'entry_type'>): string {
  if (isIncome(row)) return `Mark ${name} as received`
  if (isCardKind(row.kind)) return `Record ${name}`
  return `Mark ${name} as paid`
}
