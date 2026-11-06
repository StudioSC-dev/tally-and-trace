import type { Account, AutopayDueRow, Settlement } from '../types/api'

/**
 * Settlement: whether the app posts a payment by itself (autopay) or waits for the
 * owner (manual). The server derives it from one flag; a row that names none is
 * "Scheduled".
 */

/** What a new entry starts as. */
export const DEFAULT_SETTLEMENT: Settlement = 'manual'

/** The settlement words on a payable's detail line (" · Autopay"); empty when the row names none. */
export function settlementDetail(settlement: Settlement | null | undefined): string {
  if (settlement === 'autopay') return ' · Autopay'
  return settlement === 'manual' ? ' · Manual' : ''
}

/** Plain wording for each reason autopay cannot be turned on or a payment did not post. */
const REASON_TEXT: Record<string, string> = {
  not_cash: 'Only a cash expense can be paid by autopay.',
  no_account: 'Choose an account to pay from first.',
  inactive: 'This is paused or finished, so it cannot be paid by autopay.',
  spending_wallet: 'Spending from a wallet cannot be paid by autopay.',
  foreign_currency: 'This is in a different currency than the account it is paid from.',
  no_funding_account: 'Choose an account to pay this loan from first.',
  no_access: 'You cannot pay this from its payment account.',
  no_schedule: 'Set the first payment date and the payment amount first.',
  no_rate: 'Set the interest rate first.',
  recurring_entry: 'A recurring transfer already pays this loan. End it first, or it would be paid twice.',
  insufficient_funds: 'There is not enough in the account to pay it.',
  possible_duplicate: 'A payment that looks the same was already entered by hand.',
  planned_payment: 'A planned payment for it is waiting; record or remove that first.',
  needs_amount: 'The last payment is a different amount; record it by hand.',
  ambiguous: 'More than one payment is linked to the same day; sort that out first.',
  pending_not_editable: 'A pending payment for it cannot be changed by you.',
}

/** Owner-readable wording for a reason code; never the code itself. */
export function settlementReasonText(reason: string | null | undefined): string {
  if (reason == null) return ''
  return REASON_TEXT[reason] ?? 'It could not be paid by autopay.'
}

/** The confirmation before turning autopay on over missed payments. */
export function catchUpText(count: number): string {
  return count === 1
    ? 'This will post 1 missed payment, dated on its own day.'
    : `This will post ${count} missed payments, each dated on its own day.`
}

/** A held payment on the dashboard: "Rent could not post: not enough in X". Null when nothing holds the row. */
export function heldPaymentNotice(row: AutopayDueRow): string | null {
  if (row.state === 'on' || row.block_reason == null) return null
  if (row.block_reason === 'insufficient_funds') {
    return `${row.name} could not post: not enough in ${row.account_name ?? 'the account it is paid from'}`
  }
  return `${row.name} could not post: ${settlementReasonText(row.block_reason).replace(/\.$/, '').replace(/^./, (c) => c.toLowerCase())}`
}

/** Whether the page-open run has something to post among the autopay rows. */
export function autopayPostable(rows: readonly Pick<AutopayDueRow, 'postable_count'>[] | undefined): boolean {
  return (rows ?? []).some((row) => row.postable_count > 0)
}

/** Whether the caller may see and change a loan's flag: it comes back null for anyone but an owner or admin. */
export function loanSettlementVisible(account: Pick<Account, 'auto_post_enabled'>): boolean {
  return account.auto_post_enabled != null
}
