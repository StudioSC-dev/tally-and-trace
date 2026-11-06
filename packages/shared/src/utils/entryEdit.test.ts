import { describe, expect, it } from 'vitest'
import { finalMonthHelp, settlementControlState, settlementFollowUp, withLoadedVersion } from './entryEdit'
import { DEFAULT_SETTLEMENT } from './settlement'

describe('withLoadedVersion', () => {
  it('sends the loaded updated_at string unchanged, microseconds included', () => {
    const loaded = { updated_at: '2026-10-01T02:03:04.123456+00:00' }
    const body = withLoadedVersion({ amount: 5 }, loaded)
    expect(body).toEqual({ amount: 5, expected_updated_at: '2026-10-01T02:03:04.123456+00:00' })
    expect(body.expected_updated_at).toBe(loaded.updated_at)
  })

  it('does not mutate the input', () => {
    const input = { amount: 5 }
    withLoadedVersion(input, { updated_at: '2026-10-01T00:00:00Z' })
    expect(input).toEqual({ amount: 5 })
  })

  it('sends null as null for an entry that was never updated', () => {
    const body = withLoadedVersion({ amount: 5 }, { updated_at: null })
    expect(body).toEqual({ amount: 5, expected_updated_at: null })
    expect('expected_updated_at' in body).toBe(true)
  })

  it('omits the field only when the entry has no updated_at property', () => {
    const body = withLoadedVersion({ amount: 5 }, {})
    expect(body).toEqual({ amount: 5 })
    expect('expected_updated_at' in body).toBe(false)
    expect('expected_updated_at' in withLoadedVersion({ amount: 5 }, { updated_at: undefined })).toBe(false)
  })

  it('replaces a stale version already on the body', () => {
    const body = withLoadedVersion({ expected_updated_at: 'old' }, { updated_at: 'new' })
    expect(body.expected_updated_at).toBe('new')
  })
})

describe('finalMonthHelp', () => {
  it('states the final-month rule', () => {
    expect(finalMonthHelp).toBe(
      'Moving the next date keeps the last payment; change this number to lengthen or shorten the plan.',
    )
  })
})

describe('settlement control (settlement plan PR 8)', () => {
  const bank = { account_type: 'checking', currency: 'PHP' }
  const base = { entryType: 'expense' as const, account: bank, currency: 'PHP', isActive: true }

  it('defaults a new entry to Manual', () => {
    expect(DEFAULT_SETTLEMENT).toBe('manual')
  })

  it('shows for a cash expense, usable', () => {
    expect(settlementControlState(base)).toEqual({ shown: true, disabledReason: null })
  })

  it('shows nothing for a card subscription, a transfer, income or no account', () => {
    const card = { account_type: 'credit', currency: 'PHP' }
    expect(settlementControlState({ ...base, account: card }).shown).toBe(false)
    expect(settlementControlState({ ...base, transferToAccountId: 7 }).shown).toBe(false)
    expect(settlementControlState({ ...base, entryType: 'income' }).shown).toBe(false)
    expect(settlementControlState({ ...base, account: undefined }).shown).toBe(false)
  })

  it('is off with a plain reason for a wallet, another currency and a paused entry', () => {
    const wallet = settlementControlState({ ...base, account: { ...bank, is_spending_wallet: true } })
    const foreign = settlementControlState({ ...base, currency: 'USD' })
    const paused = settlementControlState({ ...base, isActive: false })
    for (const state of [wallet, foreign, paused]) {
      expect(state.shown).toBe(true)
      expect(state.disabledReason).toMatch(/autopay|currency/)
    }
    expect(wallet.disabledReason).toContain('wallet')
    expect(foreign.disabledReason).toContain('currency')
    expect(paused.disabledReason).toContain('paused')
  })

  it('follows up a save only when the entry did not end as picked', () => {
    expect(settlementFollowUp('manual', 'manual')).toBeNull()
    expect(settlementFollowUp('manual', null)).toBeNull()
    expect(settlementFollowUp('autopay', 'autopay')).toBeNull()
    expect(settlementFollowUp('autopay', 'manual')).toBe('turn_on')
    expect(settlementFollowUp('autopay', undefined)).toBe('turn_on')
    expect(settlementFollowUp('manual', 'autopay')).toBe('turn_off')
  })
})
