import type { Allocation } from '@tally-trace/shared'

/** How a budget envelope's current window reads: no limit, over what is available, nothing available or spent, or in range. */
export type BudgetState = 'unlimited' | 'over' | 'zero' | 'within'

export interface BudgetFigures {
  state: BudgetState
  /** The stored limit (`target_amount`, else `monthly_target`); null with none. */
  limit: number | null
  /** What carries in from earlier windows; 0 when carry is off. */
  carryIn: number
  /** Limit plus carry-in; null with no limit. */
  available: number | null
  spent: number
  /** `spent - available` when `state` is `over`, else 0. */
  over: number
  /** `available - spent` when there is a limit and the envelope is not over, else 0. */
  remaining: number
  /** `spent / available`, in percent (0 to 999), only in range; null otherwise. */
  usedPercent: number | null
  /** The figure is an estimate: a rate is missing in this window or upstream in its carry chain. */
  isEstimate: boolean
  /** The currencies missing in this window, then upstream, each once. */
  estimateCurrencies: string[]
}

/** A budget's limit: `target_amount`, else `monthly_target`, else null. */
export function budgetLimit(allocation: Pick<Allocation, 'target_amount' | 'monthly_target'>): number | null {
  if (typeof allocation.target_amount === 'number') return allocation.target_amount
  if (typeof allocation.monthly_target === 'number') return allocation.monthly_target
  return null
}

/** What an envelope's current window or one history window says about missing exchange rates. */
interface EstimateSource {
  complete?: boolean | null
  provisional?: boolean | null
  missing?: string[] | null
  inherited_missing?: string[] | null
}

/** Whether a figure is an estimate (a rate is missing in the window or upstream) and the currencies behind it, each once. */
export function estimateOf(source: EstimateSource): Pick<BudgetFigures, 'isEstimate' | 'estimateCurrencies'> {
  return {
    isEstimate: source.complete === false || source.provisional === true,
    estimateCurrencies: [...new Set([...(source.missing ?? []), ...(source.inherited_missing ?? [])])],
  }
}

/** The estimate marker's text, or null when the figure is complete. */
export function estimateLabel(figures: Pick<BudgetFigures, 'isEstimate' | 'estimateCurrencies'>): string | null {
  if (!figures.isEstimate) return null
  return figures.estimateCurrencies.length > 0
    ? `Estimate — missing rates for ${figures.estimateCurrencies.join(', ')}`
    : 'Estimate — missing exchange rates'
}

/**
 * The figures one envelope's card and snapshot dialog both show, read from the list or detail response. A create or
 * update response leaves the carry figures null while carry is on, so a missing `available` is the limit plus the
 * carry-in it has (0 when absent).
 */
export function budgetFigures(allocation: Allocation): BudgetFigures {
  const limit = budgetLimit(allocation)
  const spent = typeof allocation.current_amount === 'number' ? allocation.current_amount : 0
  const carryIn = typeof allocation.carry_in === 'number' ? allocation.carry_in : 0
  const available =
    typeof allocation.available === 'number' ? allocation.available : limit === null ? null : limit + carryIn
  const base = { limit, carryIn, available, spent, ...estimateOf(allocation) }
  if (available === null) {
    return { ...base, state: 'unlimited', carryIn: 0, over: 0, remaining: 0, usedPercent: null }
  }
  if (spent > available) {
    return { ...base, state: 'over', over: spent - available, remaining: 0, usedPercent: null }
  }
  if (available === 0) {
    return { ...base, state: 'zero', over: 0, remaining: 0, usedPercent: null }
  }
  return {
    ...base,
    state: 'within',
    over: 0,
    remaining: available - spent,
    usedPercent: Math.min((spent / available) * 100, 999),
  }
}
