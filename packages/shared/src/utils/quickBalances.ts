import type { QuickBalanceTile } from '../types/api'
import { ACCOUNT_GROUPS, ACCOUNT_TYPE_GROUP } from './accountGroups'
import { formatCurrency } from './currency'
import { joinNames } from './cardCredit'
import { parseEntryDate } from './entryDate'

/** How a line reads: `danger` for Overdue, `muted` for a note, `normal` otherwise. */
export type TileLineTone = 'normal' | 'muted' | 'danger'

/**
 * One line of a tile. `label` is the small caption before the text (null for none);
 * `secondary` lines render smaller than the headline figure.
 */
export interface TileLine {
  id: 'balance' | 'owed' | 'due' | 'unbilled' | 'available' | 'shared'
  label: string | null
  text: string
  tone: TileLineTone
  secondary: boolean
}

function line(id: TileLine['id'], label: string | null, text: string, tone: TileLineTone = 'normal', secondary = false): TileLine {
  return { id, label, text, tone, secondary }
}

/** A day as "Nov 25". Read as a calendar day, so the browser's zone never moves it. */
export function shortDate(day: string): string {
  const date = parseEntryDate(day)
  if (Number.isNaN(date.getTime())) return 'Invalid date'
  const month = new Intl.DateTimeFormat('en-US', { month: 'short', timeZone: 'UTC' }).format(date)
  return `${month} ${date.getUTCDate()}`
}

/** The group a tile sits in, as the Accounts page labels it: Debit, Credit, E-wallet, Cash or Loan. */
export function tileGroupLabel(tile: Pick<QuickBalanceTile, 'account_type'>): string {
  const group = ACCOUNT_TYPE_GROUP[tile.account_type]
  return ACCOUNT_GROUPS.find((g) => g.group === group)?.label ?? ''
}

/**
 * The figures a tile shows, in order, every one in the account's own currency.
 *
 * - Checking, savings, e-wallet, cash: the balance.
 * - A loan, or a credit card with no `card` (an editor or viewer): Owed, the negated balance.
 * - A card with `card`: the latest statement's amount due and due date ("Overdue" when past
 *   due, "Nothing due" at 0 (with "may be low" when incomplete), "No statement yet" with none, "may be low" when incomplete),
 *   the unbilled charges as a smaller line (omitted when null or 0), then the available
 *   credit ("at most" when incomplete, followed by "shared with ..." on a linked card, or
 *   "No limit set" when no credit is served).
 */
export function tileLines(tile: QuickBalanceTile): TileLine[] {
  const money = (amount: number) => formatCurrency(amount, tile.currency)
  if (tile.account_type === 'loan') return [line('owed', 'Owed', money(-tile.balance))]
  if (tile.account_type !== 'credit') return [line('balance', null, money(tile.balance))]
  const card = tile.card
  if (card === undefined) return [line('owed', 'Owed', money(-tile.balance))]

  const lines: TileLine[] = []
  if (card.due_date === null) {
    lines.push(line('due', null, 'No statement yet', 'muted'))
  } else if (!(card.amount_due > 0)) {
    lines.push(line('due', null, card.incomplete ? 'Nothing due (may be low)' : 'Nothing due', 'muted'))
  } else {
    const low = card.incomplete ? ' (may be low)' : ''
    lines.push(line('due', card.overdue ? 'Overdue' : 'Due', `${money(card.amount_due)} · ${shortDate(card.due_date)}${low}`, card.overdue ? 'danger' : 'normal'))
  }
  if (card.unbilled !== null && card.unbilled !== 0) {
    lines.push(line('unbilled', 'Unbilled', money(card.unbilled), 'muted', true))
  }
  const credit = tile.credit
  if (credit === undefined) {
    lines.push(line('available', null, 'No limit set', 'muted'))
  } else {
    const available = money(credit.available_now)
    lines.push(line('available', 'Available', credit.complete ? available : `at most ${available}`))
    if (credit.shared_with.length > 0) {
      lines.push(line('shared', null, `shared with ${joinNames(credit.shared_with.map((c) => c.name))}`, 'muted', true))
    }
  }
  return lines
}
