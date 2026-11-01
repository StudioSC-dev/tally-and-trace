import { describe, it, expect } from 'vitest'
import type { Account, CardUnposted, MinimumDue, StatementDue } from '../types/api'
import {
  cardPaymentBody,
  cardPayers,
  creditPanelUnposted,
  isPlannedPayment,
  manilaToday,
  NOTHING_DUE_NOTE,
  payChoices,
  payDisabledReason,
  postingDay,
  unpostedCounts,
  unpostedNote,
} from './cardPay'

function minimum(over: Partial<MinimumDue> = {}): MinimumDue {
  return {
    amount: 2550,
    remaining: 2550,
    source: 'estimate',
    reason: null,
    complete: true,
    assumptions: [],
    inputs: null,
    ...over,
  }
}

function statement(over: Partial<StatementDue> = {}): StatementDue {
  return {
    close_date: '2027-03-03',
    due_date: '2027-03-24',
    status: 'open',
    owed: 20000,
    clear_through: 21000,
    outstanding: 21000,
    incomplete: false,
    minimum_due: minimum(),
    unposted_installments: 0,
    unposted_postable: 0,
    ...over,
  }
}

const TODAY = '2027-03-18'

describe('payChoices', () => {
  it('suggests Full and the estimated minimum for the latest closed statement', () => {
    const choices = payChoices([statement()], TODAY)
    expect(choices?.full).toBe(21000)
    expect(choices?.minimum).toEqual({ amount: 2550, source: 'estimate' })
    expect(choices?.cleared).toBe(false)
    expect(choices?.statement.close_date).toBe('2027-03-03')
  })

  it('is not changed by an older statement that is also owed', () => {
    const older = statement({ close_date: '2027-02-03', due_date: '2027-02-24', status: 'overdue', clear_through: 1000 })
    const choices = payChoices([older, statement()], TODAY)
    expect(choices?.statement.close_date).toBe('2027-03-03')
    expect(choices?.full).toBe(21000)
    expect(choices?.minimum?.amount).toBe(2550)
  })

  it('does not depend on the order of the statements', () => {
    const older = statement({ close_date: '2027-02-03', clear_through: 1000 })
    expect(payChoices([statement(), older], TODAY)?.full).toBe(21000)
  })

  it('marks an override as from the statement', () => {
    const choices = payChoices([statement({ minimum_due: minimum({ source: 'statement', amount: 1234.56, remaining: 1234.56 }) })], TODAY)
    expect(choices?.minimum).toEqual({ amount: 1234.56, source: 'statement' })
  })

  it('gives no minimum without a rule', () => {
    const choices = payChoices(
      [statement({ minimum_due: minimum({ amount: null, remaining: null, source: 'unavailable', reason: 'no_rule' }) })],
      TODAY,
    )
    expect(choices?.minimum).toBeNull()
    expect(choices?.minimumReason).toBe('no_rule')
  })

  it('has no choices when the only statement closes today', () => {
    expect(payChoices([statement({ close_date: TODAY })], TODAY)).toBeNull()
    expect(payChoices([], TODAY)).toBeNull()
  })

  it('starts empty when the latest statement is cleared', () => {
    const choices = payChoices([statement({ clear_through: 0, owed: 0, status: 'paid' })], TODAY)
    expect(choices?.full).toBe(0)
    expect(choices?.cleared).toBe(true)
    expect(NOTHING_DUE_NOTE).toContain('Nothing due on your latest statement')
  })

  it('reports the excess over Full', () => {
    expect(payChoices([statement()], TODAY, 25000)?.excess).toBe(4000)
    expect(payChoices([statement()], TODAY, 21000)?.excess).toBe(0)
    expect(payChoices([statement()], TODAY)?.excess).toBe(0)
  })

  it('reports a met minimum as paid', () => {
    const choices = payChoices([statement({ minimum_due: minimum({ remaining: 0 }) })], TODAY)
    expect(choices?.minimum).toBeNull()
    expect(choices?.minimumReason).toBe('paid')
  })

  it('carries the incomplete flag', () => {
    expect(payChoices([statement({ incomplete: true })], TODAY)?.incomplete).toBe(true)
  })
})

describe('cardPayers', () => {
  const account = (over: Partial<Account> & { id: number }): Account => ({
    name: `A${over.id}`,
    account_type: 'checking',
    balance: 0,
    currency: 'PHP',
    is_active: true,
    tags: [],
    my_role: 'owner',
    owner_name: null,
    permissions: { can_edit_settings: true, can_manage_shares: true, can_add_transactions: true, can_delete: true },
    ...over,
  })

  it('keeps same-currency, editable, active, non-credit, non-loan accounts, excluding the card', () => {
    const card = account({ id: 1, account_type: 'credit' })
    const accounts = [
      card,
      account({ id: 2 }),
      account({ id: 3, account_type: 'e_wallet' }),
      account({ id: 4, currency: 'USD' }),
      account({ id: 5, is_active: false }),
      account({ id: 6, account_type: 'credit' }),
      account({ id: 7, account_type: 'loan' }),
      account({ id: 8, permissions: { can_edit_settings: false, can_manage_shares: false, can_add_transactions: false, can_delete: false } }),
    ]
    expect(cardPayers(accounts, card).map((a) => a.id)).toEqual([2, 3])
  })
})

describe('manilaToday', () => {
  it('turns at Manila midnight, 16:00 UTC', () => {
    expect(manilaToday(new Date('2027-03-24T15:59:00Z'))).toBe('2027-03-24')
    expect(manilaToday(new Date('2027-03-24T16:01:00Z'))).toBe('2027-03-25')
  })

  it('is already the next day at UTC midnight, and rolls over months and years', () => {
    expect(manilaToday(new Date('2027-03-24T00:00:00Z'))).toBe('2027-03-24')
    expect(manilaToday(new Date('2027-03-23T23:59:59Z'))).toBe('2027-03-24')
    expect(manilaToday(new Date('2027-03-31T16:00:00Z'))).toBe('2027-04-01')
    expect(manilaToday(new Date('2027-12-31T16:00:00Z'))).toBe('2028-01-01')
  })
})

describe('postingDay', () => {
  it('keeps the day of a UTC-midnight posting date', () => {
    expect(postingDay('2026-10-20T00:00:00Z')).toBe('2026-10-20')
  })

  it('is the next day from 16:00 UTC', () => {
    expect(postingDay('2026-10-20T15:59:59Z')).toBe('2026-10-20')
    expect(postingDay('2026-10-20T17:00:00Z')).toBe('2026-10-21')
  })

  it('reads an offset string as the instant it names', () => {
    expect(postingDay('2026-10-20T23:30:00+08:00')).toBe('2026-10-20')
    expect(postingDay('2026-10-20T01:00:00+08:00')).toBe('2026-10-20')
    expect(postingDay('2026-10-20T23:30:00-05:00')).toBe('2026-10-21')
  })

  it('is null for garbage', () => {
    expect(postingDay('not a date')).toBeNull()
    expect(postingDay('')).toBeNull()
  })
})

describe('isPlannedPayment', () => {
  it('is true only after today', () => {
    expect(isPlannedPayment('2027-03-19', '2027-03-18')).toBe(true)
    expect(isPlannedPayment('2027-03-18', '2027-03-18')).toBe(false)
    expect(isPlannedPayment('2027-03-17', '2027-03-18')).toBe(false)
  })
})

describe('cardPaymentBody', () => {
  it('sends a YYYY-MM-DD payment_date and the cents', () => {
    expect(cardPaymentBody({ amount: 1650, fromAccountId: 2, paymentDate: '2027-03-18T00:00:00' })).toEqual({
      amount: 1650,
      from_account_id: 2,
      payment_date: '2027-03-18',
    })
  })

  it('adds a trimmed description only when there is one', () => {
    expect(cardPaymentBody({ amount: 10, fromAccountId: 2, paymentDate: '2027-03-18', description: '  Rent  ' }).description).toBe('Rent')
    expect('description' in cardPaymentBody({ amount: 10, fromAccountId: 2, paymentDate: '2027-03-18', description: '  ' })).toBe(false)
  })
})

const unposted = (over: Partial<CardUnposted> = {}): CardUnposted => ({
  count: 2,
  postable: 2,
  oldest_close: '2027-01-03',
  oldest_due: '2027-01-24',
  ...over,
})

describe('unpostedCounts', () => {
  it('is 0 and 0 when nothing is unposted', () => {
    expect(unpostedCounts({ unposted: null })).toEqual({ count: 0, postable: 0 })
  })
  it('reads count and postable from the detail', () => {
    expect(unpostedCounts({ unposted: unposted({ count: 3, postable: 1 }) })).toEqual({ count: 3, postable: 1 })
  })
})

describe('unpostedNote', () => {
  it('says what Full leaves out and how many need Review', () => {
    expect(unpostedNote(3, 1)).toEqual({
      text: 'Full leaves out 3 installment months not yet posted',
      review: '2 of them need Review or Mark paid in Due and overdue',
    })
  })
  it('has no review line when every month is postable', () => {
    expect(unpostedNote(2, 2)?.review).toBeNull()
  })
  it('is singular for one month', () => {
    expect(unpostedNote(1, 0)).toEqual({
      text: 'Full leaves out 1 installment month not yet posted',
      review: '1 of them needs Review or Mark paid in Due and overdue',
    })
  })
  it('is null with nothing unposted', () => {
    expect(unpostedNote(0, 0)).toBeNull()
  })
})

describe('payDisabledReason', () => {
  const choices = payChoices([statement()], TODAY)
  const none = { count: 0, postable: 0 }
  it('checks inactive before anything else', () => {
    expect(payDisabledReason({ isActive: false, choices: null, unposted: { count: 2, postable: 2 } })).toBe('This card is inactive')
    expect(payDisabledReason({ isActive: false, choices, unposted: none })).toBe('This card is inactive')
  })
  it('asks to post the months first when some are postable and there is no statement', () => {
    expect(payDisabledReason({ isActive: true, choices: null, unposted: { count: 2, postable: 2 } })).toBe(
      'Post the installment months first',
    )
  })
  it('points to Due and overdue when none are postable', () => {
    expect(payDisabledReason({ isActive: true, choices: null, unposted: { count: 2, postable: 0 } })).toBe(
      'Review or Mark paid the installment months in Due and overdue first',
    )
  })
  it('keeps "No closed statement yet" with nothing unposted', () => {
    expect(payDisabledReason({ isActive: true, choices: null, unposted: none })).toBe('No closed statement yet')
  })
  it('is null when there is a statement to pay', () => {
    expect(payDisabledReason({ isActive: true, choices, unposted: { count: 2, postable: 2 } })).toBeNull()
  })
})

describe('creditPanelUnposted', () => {
  it('is null with nothing unposted', () => {
    expect(creditPanelUnposted({ unposted: null })).toBeNull()
  })
  it('names the count and both dates, and posts when some are postable', () => {
    expect(creditPanelUnposted({ unposted: unposted() })).toEqual({
      text: '2 installment months not yet posted · oldest closed Jan 3rd, 2027, due Jan 24th, 2027',
      action: 'post',
    })
  })
  it('asks for review when none are postable', () => {
    expect(creditPanelUnposted({ unposted: unposted({ postable: 0 }) })?.action).toBe('review')
  })
})
