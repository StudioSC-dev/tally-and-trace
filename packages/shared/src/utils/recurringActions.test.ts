import { describe, it, expect } from 'vitest'
import {
  RECURRING_ACTION_LABELS,
  defaultRecurringAction,
  isCardKind,
  recurringActionsFor,
  recurringDialogTitle,
} from './recurringActions'

describe('recurringActionsFor', () => {
  it('offers Mark paid on a cash expense', () => {
    expect(recurringActionsFor({ kind: 'cash', entry_type: 'expense', can_mark_paid: true })).toEqual(['mark_paid'])
  })

  it('offers Mark paid on a transfer or loan payment (no kind, not income)', () => {
    expect(recurringActionsFor({ kind: null, entry_type: 'transfer', can_mark_paid: true })).toEqual(['mark_paid'])
    expect(recurringActionsFor({ kind: null, entry_type: 'expense', can_mark_paid: true })).toEqual(['mark_paid'])
    // A payables row has no entry_type.
    expect(recurringActionsFor({ kind: null, can_mark_paid: true })).toEqual(['mark_paid'])
  })

  it('offers Mark received on income', () => {
    expect(recurringActionsFor({ kind: null, entry_type: 'income', can_mark_paid: true })).toEqual(['mark_received'])
  })

  it.each(['subscription', 'installment', 'bill'])('offers Charged then Posted on a card %s', (kind) => {
    expect(recurringActionsFor({ kind, entry_type: 'expense', can_mark_paid: true })).toEqual(['charged', 'posted'])
  })

  it.each(['pending', 'posted', 'ambiguous'] as const)('offers Posted alone on a card occurrence linked %s', (linked) => {
    expect(recurringActionsFor({ kind: 'subscription', entry_type: 'expense', can_mark_paid: true }, { linked })).toEqual(['posted'])
  })

  it('keeps Charged on an unlinked card occurrence', () => {
    expect(recurringActionsFor({ kind: 'installment', can_mark_paid: true }, { linked: null })).toEqual(['charged', 'posted'])
  })

  it('a link does not change a non-card row', () => {
    expect(recurringActionsFor({ kind: 'cash', can_mark_paid: true }, { linked: 'pending' })).toEqual(['mark_paid'])
  })

  it('offers nothing without permission', () => {
    expect(recurringActionsFor({ kind: 'cash', entry_type: 'expense', can_mark_paid: false })).toEqual([])
    expect(recurringActionsFor({ kind: 'subscription', entry_type: 'expense' })).toEqual([])
    expect(recurringActionsFor({ kind: null, entry_type: 'income', can_mark_paid: false })).toEqual([])
  })
})

describe('defaultRecurringAction', () => {
  it('picks Posted for card kinds', () => {
    expect(defaultRecurringAction({ kind: 'subscription' })).toBe('posted')
    expect(defaultRecurringAction({ kind: 'installment' })).toBe('posted')
    expect(defaultRecurringAction({ kind: 'bill' })).toBe('posted')
  })

  it('picks the single action otherwise', () => {
    expect(defaultRecurringAction({ kind: 'cash', entry_type: 'expense' })).toBe('mark_paid')
    expect(defaultRecurringAction({ kind: null, entry_type: 'transfer' })).toBe('mark_paid')
    expect(defaultRecurringAction({ kind: null, entry_type: 'income' })).toBe('mark_received')
  })
})

describe('labels and titles', () => {
  it('uses the exact labels', () => {
    expect(RECURRING_ACTION_LABELS).toEqual({
      mark_paid: 'Mark paid',
      mark_received: 'Mark received',
      charged: 'Charged',
      posted: 'Posted',
    })
  })

  it('titles the dialog by kind', () => {
    expect(recurringDialogTitle('Rent', { kind: 'cash', entry_type: 'expense' })).toBe('Mark Rent as paid')
    expect(recurringDialogTitle('Save', { kind: null, entry_type: 'transfer' })).toBe('Mark Save as paid')
    expect(recurringDialogTitle('Salary', { kind: null, entry_type: 'income' })).toBe('Mark Salary as received')
    expect(recurringDialogTitle('Netflix', { kind: 'subscription', entry_type: 'expense' })).toBe('Record Netflix')
  })

  it('knows the card kinds', () => {
    expect(['subscription', 'installment', 'bill', 'cash', null, undefined, 'pending'].map(isCardKind)).toEqual([
      true, true, true, false, false, false, false,
    ])
  })
})
