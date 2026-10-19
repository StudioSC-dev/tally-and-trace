import type { CardCharges, UpcomingItemOrEvent } from '../types/api'
import { isLimitedEvent } from '../types/api'
import { upcomingItemAmount } from './records'

/** `source:source_id` of every full card charge, so "Also coming up" doesn't list it twice. */
export const fullCardChargeKeys = (cards: readonly CardCharges[]): Set<string> =>
  new Set(cards.flatMap((card) => card.charges.flatMap((charge) => (charge.view === 'limited' ? [] : [`${charge.source}:${charge.source_id}`]))))

/**
 * An upcoming item that is not a cash outflow listed in the payables: a Household bill, money
 * coming in, or a full row with no stored rate (it moves no cash and is counted nowhere, so
 * it is listed here in its own currency whichever way it goes). A full row listed among the
 * card charges is shown there instead.
 */
export const isOtherUpcoming = (cardChargeKeys: ReadonlySet<string>) => (item: UpcomingItemOrEvent): boolean => {
  if (!isLimitedEvent(item) && cardChargeKeys.has(`${item.source}:${item.source_id}`)) return false
  if (!isLimitedEvent(item) && item.unconverted === true) return true
  const household = isLimitedEvent(item) ? item.kind === 'household' : item.household_occurrence === true
  return household || upcomingItemAmount(item).direction === 'in'
}
