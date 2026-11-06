import { describe, expect, it } from 'vitest'
import type { AutopayDueRow } from '../types/api'
import { autopayPostable, catchUpText, heldPaymentNotice, settlementDetail, settlementReasonText } from './settlement'

const row = (over: Partial<AutopayDueRow> = {}): AutopayDueRow => ({
  source: 'budget_entry',
  source_id: 1,
  name: 'Rent',
  account_name: 'BPI Checking',
  due_count: 1,
  postable_count: 0,
  oldest: '2026-11-01',
  state: 'held',
  block_reason: 'insufficient_funds',
  ...over,
})

describe('settlement wording', () => {
  it('names the settlement on a detail line, and nothing when the row names none', () => {
    expect(settlementDetail('autopay')).toBe(' · Autopay')
    expect(settlementDetail('manual')).toBe(' · Manual')
    expect(settlementDetail(null)).toBe('')
    expect(settlementDetail(undefined)).toBe('')
  })

  it('words every block reason in plain language, with no code on screen', () => {
    const codes = ['not_cash', 'no_account', 'inactive', 'spending_wallet', 'foreign_currency', 'no_funding_account',
      'no_access', 'no_schedule', 'no_rate', 'recurring_entry', 'insufficient_funds', 'possible_duplicate',
      'planned_payment', 'needs_amount', 'ambiguous', 'pending_not_editable', 'something_new']
    for (const code of codes) {
      const text = settlementReasonText(code)
      expect(text.length).toBeGreaterThan(10)
      expect(text).not.toContain('_')
    }
    expect(settlementReasonText(null)).toBe('')
  })

  it('asks the count before catching up', () => {
    expect(catchUpText(3)).toBe('This will post 3 missed payments, each dated on its own day.')
    expect(catchUpText(1)).toBe('This will post 1 missed payment, dated on its own day.')
  })

  it('says why a held payment did not post', () => {
    expect(heldPaymentNotice(row())).toBe('Rent could not post: not enough in BPI Checking')
    expect(heldPaymentNotice(row({ account_name: null }))).toBe('Rent could not post: not enough in the account it is paid from')
    expect(heldPaymentNotice(row({ block_reason: 'recurring_entry', state: 'blocked' }))).toContain('Rent could not post: a recurring transfer')
    expect(heldPaymentNotice(row({ state: 'on', block_reason: null }))).toBeNull()
    expect(heldPaymentNotice(row({ block_reason: null }))).toBeNull()
  })

  it('opens the page-open run only for a postable autopay payment', () => {
    expect(autopayPostable(undefined)).toBe(false)
    expect(autopayPostable([])).toBe(false)
    expect(autopayPostable([row({ postable_count: 0 })])).toBe(false)
    expect(autopayPostable([row({ postable_count: 2 })])).toBe(true)
  })
})
