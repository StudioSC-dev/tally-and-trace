import type { Transaction } from '../types/api'
import type { CurrencyCode } from './currency'

/**
 * What one transaction does to one account, read from the row alone. It mirrors the
 * backend's per-leg arithmetic (services/forecast.py `transfer`) over the shapes
 * redaction.py `limited_transaction` produces, so it works on Full, Shared-full and
 * Limited rows alike.
 */

export type LegDirection = 'in' | 'out'

export interface AccountLeg {
  /** Which way money moves on the account; null when the row touches neither leg (bad data). */
  direction: LegDirection | null
  /** Effect on the account: negative out, positive in, 0 when direction is null. */
  signed: number
  /** The currency of `signed`. */
  currency: CurrencyCode
  /**
   * False when the row can't say what an incoming transfer added to the account: the row
   * is in another currency and carries no received amount. `signed` is then the amount
   * sent, in the row's currency.
   */
  effectKnown: boolean
  /** The fee (or loan interest) this leg pays; only on an out transfer leg, null when hidden or none. */
  fee: number | null
  /** The far side of a transfer: its id when the caller sees it, else null. */
  counterpartId: number | null
  /** The far side's name when the row carries it (Limited refs), else null (the caller looks it up). */
  counterpartName: string | null
}

const NO_LEG = { signed: 0, effectKnown: true, fee: null, counterpartId: null, counterpartName: null } as const

/** The effect of `row` on the account `accountId` (whose currency is `accountCurrency`). */
export function accountLeg(row: Transaction, accountId: number, accountCurrency: CurrencyCode): AccountLeg {
  if (row.transaction_type === 'debit') {
    return { ...NO_LEG, direction: 'out', signed: -row.amount, currency: row.currency }
  }
  if (row.transaction_type === 'credit') {
    return { ...NO_LEG, direction: 'in', signed: row.amount, currency: row.currency }
  }

  const limited = row.view === 'limited'
  const source = limited ? row.account?.id ?? null : row.transfer_from_account_id ?? row.account_id
  const dest = limited ? row.counterpart?.id ?? null : row.transfer_to_account_id ?? null

  // Source is checked first, so it wins if both legs match.
  if (source === accountId) {
    const fee = row.transfer_fee
    return {
      direction: 'out',
      signed: -(row.amount + (fee ?? 0)),
      currency: row.currency,
      effectKnown: true,
      fee: fee != null && fee > 0 ? fee : null,
      counterpartId: dest,
      counterpartName: limited ? row.counterpart?.name ?? null : null,
    }
  }

  if (dest === accountId) {
    const counterpart = {
      counterpartId: source,
      counterpartName: limited ? row.account?.name ?? null : null,
    }
    if (!limited && row.received_amount != null) {
      return { direction: 'in', signed: row.received_amount, currency: accountCurrency, effectKnown: true, fee: null, ...counterpart }
    }
    return {
      direction: 'in',
      signed: row.amount,
      currency: row.currency,
      effectKnown: row.currency === accountCurrency,
      fee: null,
      ...counterpart,
    }
  }

  return { ...NO_LEG, direction: null, currency: row.currency }
}

/**
 * The category name to show. A Full row only has an id, looked up in the caller's own
 * categories; the other shapes carry the name.
 */
export function transactionCategoryName(
  row: Transaction,
  ownCategoryNames: ReadonlyMap<number, string>,
): string | null {
  if (row.view === 'full') {
    return row.category_id === undefined ? null : ownCategoryNames.get(row.category_id) ?? null
  }
  return row.category_name
}

/** A route id: digits only, a safe integer above 0. Anything else is null. */
export function parsePositiveId(raw: string | undefined): number | null {
  if (raw === undefined || !/^\d+$/.test(raw)) return null
  const value = Number(raw)
  return Number.isSafeInteger(value) && value > 0 ? value : null
}

/** The largest page number accepted from a URL. */
export const MAX_PAGE = 1_000_000

/**
 * A `?page=` value: kept only when it is a number that is a safe integer from 1 to
 * `MAX_PAGE`, else undefined (page 1). A string is rejected: the router has already
 * parsed `?page=3` to a number. The offset built from it is always a safe integer.
 */
export function parsePage(raw: unknown): number | undefined {
  if (typeof raw !== 'number' || !Number.isSafeInteger(raw)) return undefined
  return raw >= 1 && raw <= MAX_PAGE ? raw : undefined
}
