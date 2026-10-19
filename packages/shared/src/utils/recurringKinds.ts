import type { BillingKind, BudgetEntry, RecurringKind } from '../types/api'

/** The sections of the recurring-entries list: a derived kind, income and transfers, or someone else's. */
export type KindGroupKey = RecurringKind | 'other' | 'shared'

/** The order sections appear in. */
export const KIND_ORDER: readonly KindGroupKey[] = ['subscription', 'installment', 'cash', 'bill', 'other', 'shared']

export const KIND_LABELS: Record<KindGroupKey, string> = {
  subscription: 'Subscriptions',
  installment: 'Card installments',
  cash: 'Cash expenses',
  bill: 'Card-billed bills',
  other: 'Income & transfers',
  shared: 'Shared with you',
}

export interface KindGroup<T extends BudgetEntry = BudgetEntry> {
  key: KindGroupKey
  label: string
  entries: T[]
}

/**
 * Entries split into `KIND_ORDER` sections, empty ones dropped. A limited entry
 * has no kind and goes to "shared"; an entry with no kind (income, transfer) to "other".
 * Order within a section is kept.
 */
export function groupByKind<T extends BudgetEntry>(entries: readonly T[]): KindGroup<T>[] {
  const buckets = new Map<KindGroupKey, T[]>()
  for (const entry of entries) {
    const key: KindGroupKey = entry.view === 'limited' ? 'shared' : (entry.kind ?? 'other')
    const bucket = buckets.get(key)
    if (bucket) bucket.push(entry)
    else buckets.set(key, [entry])
  }
  return KIND_ORDER.flatMap((key) => {
    const bucket = buckets.get(key)
    return bucket ? [{ key, label: KIND_LABELS[key], entries: bucket }] : []
  })
}

/**
 * One option of the card-expense kind select. `billingKind` is what to send:
 * undefined sends nothing (the server derives it), null clears a stored override.
 */
export interface BillingKindChoice {
  id: 'automatic' | 'subscription' | 'bill' | 'installment'
  label: string
  billingKind: BillingKind | null | undefined
}

/**
 * The kind select for a card expense. Open-ended: Automatic (Utilities bills,
 * the rest subscribe) / Subscription / Bill. Capped: Installment (clears the
 * override) / Bill (amount varies).
 */
export function billingKindChoices(capped: boolean): BillingKindChoice[] {
  if (capped) {
    return [
      { id: 'installment', label: 'Installment', billingKind: null },
      { id: 'bill', label: 'Bill (amount varies)', billingKind: 'bill' },
    ]
  }
  return [
    { id: 'automatic', label: 'Automatic (Utilities → Bill)', billingKind: undefined },
    { id: 'subscription', label: 'Subscription', billingKind: 'subscription' },
    { id: 'bill', label: 'Bill', billingKind: 'bill' },
  ]
}

/** Whether an entry is capped, as the server's `is_capped`: it ends after a number of runs that is set. */
export function isCappedEnd(endMode: string | null | undefined, maxOccurrences: number | null | undefined): boolean {
  return endMode === 'after_occurrences' && maxOccurrences != null
}

/**
 * The pick a card expense opens on. A capped one is an installment unless it is a bill;
 * a stored 'subscription' on it shows as Installment, because the server derives it so.
 */
export function kindChoiceFor(capped: boolean, billingKind: BillingKind | null | undefined): BillingKindChoice['id'] {
  if (billingKind === 'bill') return 'bill'
  if (capped) return 'installment'
  return billingKind === 'subscription' ? 'subscription' : 'automatic'
}

/**
 * Automatic cannot undo a stored kind, so it is offered only to an entry with no stored
 * non-null `billing_kind`: a new one, or one stored null.
 */
export function automaticOffered(storedBillingKind: BillingKind | null | undefined): boolean {
  return storedBillingKind == null
}

/** `billingKindChoices`, minus Automatic when `automaticOffered` is false. */
export function offeredKindChoices(capped: boolean, offerAutomatic: boolean): BillingKindChoice[] {
  return billingKindChoices(capped).filter((choice) => choice.id !== 'automatic' || offerAutomatic)
}

/**
 * The pick that stands after the Ends choice (or anything else) changes: always one of
 * `offeredKindChoices(capped, offerAutomatic)`. A bill stays a bill; a capped entry is an
 * installment; an open-ended one keeps a subscription and otherwise falls to Automatic,
 * or to Subscription where Automatic is not offered.
 */
export function settleKindChoice(
  capped: boolean,
  choice: BillingKindChoice['id'],
  offerAutomatic: boolean,
): BillingKindChoice['id'] {
  if (choice === 'bill') return 'bill'
  if (capped) return 'installment'
  if (choice === 'subscription') return 'subscription'
  return offerAutomatic ? 'automatic' : 'subscription'
}
