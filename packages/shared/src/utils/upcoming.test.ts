import { describe, expect, it } from 'vitest'
import { fullCardChargeKeys, isOtherUpcoming } from '../index'
import type { CardCharges, FullCharge, LimitedCharge, LimitedEvent, UpcomingItem } from '../index'

const fullCharge = (id: number): FullCharge => ({
  view: 'full', date: '2026-10-20', original_date: null, overdue: false, occurrence_date: '2026-10-20',
  name: 'Netflix', kind: 'subscription', source: 'budget_entry', source_id: id, amount: 500, currency: 'PHP',
} as FullCharge)

const limitedCharge: LimitedCharge = { view: 'limited', public_id: 'p1', date: '2026-10-20', original_date: null, overdue: false, display_name: 'Shared' }

const card = (charges: CardCharges['charges']): CardCharges => ({
  account_id: 1, account_name: 'Card', currency: 'PHP', statement_cycle: true, missed: [], charges,
})

/** An unconverted full row: no stored rate, so it is otherwise listed under "Also coming up". */
const unconverted = (id: number): UpcomingItem => ({
  name: 'Netflix', amount: null, due_date: '2026-10-20', entry_type: 'expense', source: 'budget_entry', source_id: id,
  unconverted: true, currency: 'USD',
} as UpcomingItem)

const limitedEvent: LimitedEvent = {
  view: 'limited', public_id: 'e1', date: '2026-10-20', original_date: null, overdue: false, display_name: 'Rent',
  face_amount: 100, cash_delta: -100, currency: 'PHP', account: null, kind: 'household',
}

describe('fullCardChargeKeys', () => {
  it('keys full charges by source:source_id and skips limited ones', () => {
    const keys = fullCardChargeKeys([card([fullCharge(7), limitedCharge]), card([fullCharge(9)])])
    expect([...keys].sort()).toEqual(['budget_entry:7', 'budget_entry:9'])
  })
})

describe('isOtherUpcoming', () => {
  const keys = fullCardChargeKeys([card([fullCharge(7)])])

  it('excludes an unconverted full row already listed as a card charge', () => {
    expect(isOtherUpcoming(keys)(unconverted(7))).toBe(false)
  })

  it('keeps an unrelated unconverted full row', () => {
    expect(isOtherUpcoming(keys)(unconverted(8))).toBe(true)
  })

  it('lists the unconverted row when there are no card charges', () => {
    expect(isOtherUpcoming(new Set())(unconverted(7))).toBe(true)
  })

  it('does not apply the card-charge exclusion to a limited event', () => {
    expect(isOtherUpcoming(keys)(limitedEvent)).toBe(true)
  })
})
