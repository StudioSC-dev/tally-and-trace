import { describe, it, expect } from 'vitest'
import type { LimitedEvent, Payable } from '../index'
import { payableActions, payableTarget } from './payables'

const payable: Payable = {
  due_date: '2026-10-20',
  name: 'Rent',
  amount: 15000,
  source: 'budget_entry',
  source_id: 3,
  account_id: 5,
  account_name: 'Checking',
  overflow_account_id: null,
  overflow_account_name: null,
  currency: 'PHP',
}

const limited: LimitedEvent = {
  view: 'limited',
  public_id: 'e1',
  date: '2026-10-20',
  original_date: null,
  overdue: false,
  display_name: 'Expense',
  face_amount: 500,
  cash_delta: -500,
  currency: 'PHP',
  account: { id: null, name: 'Other account' },
  kind: 'expense',
}

describe('payableTarget', () => {
  it('points a budget entry at its entry id', () => {
    expect(payableTarget(payable)).toEqual({ kind: 'budget_entry', id: 3 })
  })

  it('points a transaction at its transaction id', () => {
    expect(payableTarget({ ...payable, source: 'transaction', source_id: 7 })).toEqual({ kind: 'transaction', id: 7 })
  })

  it('points a statement at the card account, never the funding account', () => {
    expect(payableTarget({ ...payable, source: 'statement', account_id: 5, source_id: 9 }))
      .toEqual({ kind: 'account', source: 'statement', accountId: 9 })
  })

  it('points a loan at the loan account, never the funding account', () => {
    expect(payableTarget({ ...payable, source: 'loan', account_id: 5, source_id: 11 }))
      .toEqual({ kind: 'account', source: 'loan', accountId: 11 })
  })

  it('gives a Limited event no target', () => {
    expect(payableTarget(limited)).toEqual({ kind: 'none' })
  })

  it('gives a hidden loan transfer (null source_id) no target', () => {
    expect(payableTarget({ ...payable, source: 'transaction', source_id: null, name: 'Loan payment' })).toEqual({ kind: 'none' })
  })

  it('gives a hidden loan (null source_id) no target', () => {
    expect(payableTarget({ ...payable, source: 'loan', source_id: null })).toEqual({ kind: 'none' })
  })
})

describe('payableActions', () => {
  it('offers nothing for no target', () => {
    expect(payableActions({ kind: 'none' })).toEqual({ open: false, accountId: null })
  })

  it('opens an account target with its account id', () => {
    expect(payableActions({ kind: 'account', source: 'statement', accountId: 9 })).toEqual({ open: true, accountId: 9 })
    expect(payableActions({ kind: 'account', source: 'loan', accountId: 4 })).toEqual({ open: true, accountId: 4 })
  })

  it('opens an entry or a transaction without an account link', () => {
    expect(payableActions({ kind: 'budget_entry', id: 3 })).toEqual({ open: true, accountId: null })
    expect(payableActions({ kind: 'transaction', id: 7 })).toEqual({ open: true, accountId: null })
  })

  it('offers no account link for a Limited row, which has no target', () => {
    expect(payableActions(payableTarget(limited))).toEqual({ open: false, accountId: null })
  })
})
