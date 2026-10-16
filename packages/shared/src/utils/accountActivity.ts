import type { Transaction } from '../types/api'
import type { CurrencyCode } from './currency'

/**
 * What one transaction does to one account, read from the row alone. It mirrors the
 * backend's per-leg arithmetic over the shapes redaction.py `limited_transaction`
 * produces, so it works on Full, Shared-full and Limited rows alike.
 *
 * Currencies, by the backend's rule:
 * - A POSTED row moves the balance by its stored figures, whatever `currency` says:
 *   a debit or credit's `amount` is in the account's currency even when `currency`
 *   keeps a foreign code (test_foreign_posting_integration.py:283-310; routers/
 *   transactions.py `_foreign_post_on_update` and :626-629, which store the actual
 *   figure in `amount` and move the foreign face to `projected_*`). A transfer's
 *   source moves by `amount + transfer_fee`, its destination by `received_amount`, else
 *   `amount` (models/transaction.py `transfer_sides`, which never reads currencies).
 *   So a posted row's effect is shown in `accountCurrency`. The one exception is a
 *   Limited cross-currency transfer in: it has no `received_amount`, so what the
 *   destination got is unknown.
 * - An UNPOSTED row has no balance effect yet. A debit or credit carries a face in
 *   `projected_currency`, else `currency` (models/transaction.py `pending_face`; Limited
 *   has only `currency`); a transfer's `amount` is in its source's currency
 *   (routers/transactions.py:1002, services/forecast.py `transfer`). That face is
 *   shown in its own currency, and `effectKnown` is false when it isn't
 *   `accountCurrency` because the forecast would only estimate it.
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
   * False when the row can't say what it does to the account in the account's currency:
   * an unposted row whose face is in another currency, or a Limited transfer in from
   * another currency (no received amount). `signed` is then the face amount, in `currency`.
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
  if (row.transaction_type === 'debit' || row.transaction_type === 'credit') {
    const direction = row.transaction_type === 'debit' ? 'out' : 'in'
    const sign = direction === 'out' ? -1 : 1
    if (row.is_posted) {
      return { ...NO_LEG, direction, signed: sign * row.amount, currency: accountCurrency }
    }
    // Unposted: the face, in its own currency.
    const projected = row.view !== 'limited' ? row.projected_amount : undefined
    const amount = projected ?? row.amount
    const currency = (row.view !== 'limited' && row.projected_currency) || row.currency
    return { ...NO_LEG, direction, signed: sign * amount, currency, effectKnown: currency === accountCurrency }
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
      // Posted: always the source's own currency. Unposted: the row's, estimated by the forecast.
      currency: row.is_posted ? accountCurrency : row.currency,
      effectKnown: row.is_posted || row.currency === accountCurrency,
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
    if (!limited && row.is_posted) {
      // No received amount: the backend adds `amount` (`transfer_sides`).
      return { direction: 'in', signed: row.amount, currency: accountCurrency, effectKnown: true, fee: null, ...counterpart }
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
