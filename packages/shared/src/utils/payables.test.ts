import { describe, it, expect } from 'vitest'
import type { LimitedEvent, Payable, RecordPermissions } from '../index'
import { payableActions, payableTarget } from './payables'

const none: RecordPermissions = { can_edit: false, can_delete: false, can_post: false, can_revert: false, can_tag: false }

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
  const entry = { kind: 'budget_entry', id: 3 } as const
  const txn = { kind: 'transaction', id: 7 } as const
  const viewOnly = { open: true, edit: false, delete: false, markPaid: false, accountId: null }

  it('offers nothing for no target', () => {
    expect(payableActions({ kind: 'none' }, undefined))
      .toEqual({ open: false, edit: false, delete: false, markPaid: false, accountId: null })
  })

  it('opens an account target with its account id and nothing else', () => {
    expect(payableActions({ kind: 'account', source: 'statement', accountId: 9 }, undefined))
      .toEqual({ ...viewOnly, accountId: 9 })
  })

  it('is view only while the record is not loaded, or gone', () => {
    expect(payableActions(entry, undefined)).toEqual(viewOnly)
    expect(payableActions(entry, null)).toEqual(viewOnly)
    expect(payableActions(txn, undefined)).toEqual(viewOnly)
  })

  it('is view only for a Limited record, whatever its flags say', () => {
    expect(payableActions(entry, { view: 'limited', permissions: { ...none, can_edit: true, can_delete: true, can_post: true } }))
      .toEqual(viewOnly)
  })

  it('is view only for a viewer on the full shape', () => {
    expect(payableActions(entry, { view: 'full', permissions: none })).toEqual(viewOnly)
    expect(payableActions(txn, { view: 'shared_full', permissions: none })).toEqual(viewOnly)
  })

  it('offers edit and delete to an editor', () => {
    expect(payableActions(txn, { view: 'shared_full', permissions: { ...none, can_edit: true, can_delete: true } }))
      .toEqual({ ...viewOnly, edit: true, delete: true })
  })

  it('offers delete without edit to a creator who lost edit', () => {
    expect(payableActions(entry, { view: 'full', permissions: { ...none, can_delete: true } }))
      .toEqual({ ...viewOnly, delete: true })
  })

  it('offers mark paid on an entry the caller may post', () => {
    expect(payableActions(entry, { view: 'full', permissions: { ...none, can_edit: true, can_post: true } }))
      .toEqual({ ...viewOnly, edit: true, markPaid: true })
  })

  it('never offers mark paid on a transaction', () => {
    expect(payableActions(txn, { view: 'full', permissions: { ...none, can_post: true } })).toEqual(viewOnly)
  })
})
