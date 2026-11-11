import { describe, it, expect } from 'vitest'
import type { QuickBalanceCard, QuickBalanceCredit, QuickBalanceTile } from '../types/api'
import { canAddPin, MAX_QUICK_BALANCE_PINS, movePin, shortDate, tileGroupLabel, tileHasNoLimit, tileLines } from './quickBalances'

function tile(over: Partial<QuickBalanceTile> = {}): QuickBalanceTile {
  return { account_id: 1, name: 'Security Bank', account_type: 'checking', currency: 'PHP', balance: 84210.55, slot: 'debit', ...over }
}

const card = (over: Partial<QuickBalanceCard> = {}): QuickBalanceCard =>
  ({ amount_due: 12340, due_date: '2026-11-25', overdue: false, incomplete: false, unbilled: null, ...over })
const credit = (over: Partial<QuickBalanceCredit> = {}): QuickBalanceCredit =>
  ({ limit: 400000, available_now: 330000, complete: true, shared_with: [], ...over })
const creditTile = (over: Partial<QuickBalanceTile> = {}) =>
  tile({ name: 'BDO Amex', account_type: 'credit', balance: -70000, slot: 'credit', ...over })
const texts = (t: QuickBalanceTile) => tileLines(t).map((l) => [l.id, l.label, l.text])

describe('tileLines', () => {
  it('shows the balance of a checking, savings, e-wallet or cash account', () => {
    expect(tileLines(tile())).toEqual([{ id: 'balance', label: null, text: '₱84,210.55', tone: 'normal', secondary: false }])
    for (const account_type of ['savings', 'e_wallet', 'cash'] as const) {
      expect(texts(tile({ account_type, balance: 3402.1 }))).toEqual([['balance', null, '₱3,402.10']])
    }
  })

  it('shows a negative balance as negative and a foreign account in its own currency', () => {
    expect(texts(tile({ balance: -50 }))).toEqual([['balance', null, '₱-50.00']])
    expect(texts(tile({ currency: 'USD', balance: 12.5 }))).toEqual([['balance', null, '$12.50']])
  })

  it('shows a card\'s amount due with its due date, then Available', () => {
    expect(texts(creditTile({ card: card(), credit: credit() }))).toEqual([
      ['due', 'Due', '₱12,340.00 · Nov 25'],
      ['available', 'Available', '₱330,000.00'],
    ])
  })

  it('shows a muted "No limit set" for a card with no credit when noLimit is set', () => {
    const lines = tileLines(creditTile({ card: card() }), { noLimit: true })
    expect(lines.map((l) => [l.id, l.label, l.text, l.tone])).toEqual([
      ['due', 'Due', '₱12,340.00 · Nov 25', 'normal'],
      ['available', null, 'No limit set', 'muted'],
    ])
  })

  it('shows no Available line and no "No limit set" for a card with no credit and no noLimit', () => {
    expect(texts(creditTile({ card: card() }))).toEqual([['due', 'Due', '₱12,340.00 · Nov 25']])
    expect(texts(creditTile({ card: card() }))).toEqual(tileLines(creditTile({ card: card() }), { noLimit: false }).map((l) => [l.id, l.label, l.text]))
  })

  it('leaves a tile without card as Owed only, even with noLimit', () => {
    expect(texts(creditTile({}))).toEqual([['owed', 'Owed', '₱70,000.00']])
    expect(texts(creditTile({ credit: credit() }))).toEqual([['owed', 'Owed', '₱70,000.00']])
    expect(tileLines(creditTile({}), { noLimit: true }).map((l) => l.id)).toEqual(['owed'])
  })

  it('keeps Available for a card with credit, ignoring noLimit', () => {
    expect(tileLines(creditTile({ card: card(), credit: credit() }), { noLimit: true })).toEqual(
      tileLines(creditTile({ card: card(), credit: credit() })),
    )
  })

  it('does not change the tile it is given', () => {
    const t = creditTile({ card: card({ unbilled: 10 }), credit: credit({ shared_with: [{ account_id: 2, name: 'Platinum' }] }) })
    const before = structuredClone(t)
    tileLines(Object.freeze(t))
    tileLines(Object.freeze(creditTile({ card: card() })), { noLimit: true })
    expect(t).toEqual(before)
  })

  it('reads Overdue in the danger tone when an owed statement is past due', () => {
    const [due] = tileLines(creditTile({ card: card({ overdue: true }), credit: credit() }))
    expect([due?.label, due?.text, due?.tone]).toEqual(['Overdue', '₱12,340.00 · Nov 25', 'danger'])
  })

  it('reads Nothing due at 0', () => {
    expect(texts(creditTile({ card: card({ amount_due: 0 }), credit: credit() }))[0]).toEqual(['due', null, 'Nothing due'])
  })

  it('keeps the may be low cue when nothing is due but the figure is incomplete', () => {
    expect(texts(creditTile({ card: card({ amount_due: 0, incomplete: true }), credit: credit() }))[0]).toEqual(['due', null, 'Nothing due (may be low)'])
  })

  it('reads No statement yet with no closed statement', () => {
    expect(texts(creditTile({ card: card({ amount_due: 0, due_date: null }), credit: credit() }))[0]).toEqual(['due', null, 'No statement yet'])
  })

  it('says the figure may be low when it is incomplete', () => {
    expect(texts(creditTile({ card: card({ incomplete: true }), credit: credit() }))[0]).toEqual(['due', 'Due', '₱12,340.00 · Nov 25 (may be low)'])
  })

  it('shows the unbilled charges as a smaller second line, between Due and Available', () => {
    const lines = tileLines(creditTile({ card: card({ unbilled: 4500.25 }), credit: credit() }))
    expect(lines.map((l) => l.id)).toEqual(['due', 'unbilled', 'available'])
    expect(lines[1]).toEqual({ id: 'unbilled', label: 'Unbilled', text: '₱4,500.25', tone: 'muted', secondary: true })
  })

  it('leaves out the unbilled line when it is null or 0', () => {
    for (const unbilled of [null, 0]) {
      expect(tileLines(creditTile({ card: card({ unbilled }), credit: credit() })).map((l) => l.id)).toEqual(['due', 'available'])
    }
  })

  it('says "at most" when the available credit is incomplete', () => {
    expect(texts(creditTile({ card: card(), credit: credit({ complete: false }) }))[1]).toEqual(['available', 'Available', 'at most ₱330,000.00'])
  })

  it('names the cards a linked limit is shared with', () => {
    const lines = tileLines(creditTile({ card: card(), credit: credit({ shared_with: [{ account_id: 2, name: 'BDO Platinum Mastercard' }] }) }))
    expect(lines.map((l) => l.text).slice(-2)).toEqual(['₱330,000.00', 'shared with BDO Platinum Mastercard'])
    const three = tileLines(creditTile({ card: card(), credit: credit({ shared_with: [{ account_id: 2, name: 'A' }, { account_id: 3, name: 'B' }] }) }))
    expect(three[three.length - 1]?.text).toBe('shared with A and B')
  })

  it('leaves the available line out when credit is absent, never saying No limit set', () => {
    // A card with no limit and a card whose shared limit the caller can't see in full both arrive without `credit`.
    const lines = tileLines(creditTile({ card: card() }))
    expect(lines.map((l) => l.id)).toEqual(['due'])
    expect(lines.some((l) => l.text.includes('No limit set'))).toBe(false)
  })

  it('keeps the unbilled line and drops only Available when credit is absent', () => {
    expect(tileLines(creditTile({ card: card({ unbilled: 10 }) })).map((l) => l.id)).toEqual(['due', 'unbilled'])
  })

  it('shows Owed for a card without the card key (editor or viewer)', () => {
    expect(texts(creditTile({ balance: -9800.5 }))).toEqual([['owed', 'Owed', '₱9,800.50']])
  })

  it('shows Owed, the outstanding principal, for a loan', () => {
    expect(texts(tile({ account_type: 'loan', balance: -250000, slot: null }))).toEqual([['owed', 'Owed', '₱250,000.00']])
  })
})

describe('shortDate', () => {
  it('reads the calendar day, not the browser\'s', () => {
    expect(shortDate('2026-11-25')).toBe('Nov 25')
    expect(shortDate('2027-01-01')).toBe('Jan 1')
    expect(shortDate('2026-11-25T00:00:00')).toBe('Nov 25')
  })
})

describe('tileGroupLabel', () => {
  it('labels a tile by its account group', () => {
    expect(tileGroupLabel(tile({ account_type: 'savings' }))).toBe('Debit')
    expect(tileGroupLabel(tile({ account_type: 'credit' }))).toBe('Credit')
    expect(tileGroupLabel(tile({ account_type: 'e_wallet' }))).toBe('E-wallet')
    expect(tileGroupLabel(tile({ account_type: 'loan' }))).toBe('Loan')
  })
})

describe('movePin', () => {
  it('moves one place earlier or later and keeps every other id in order', () => {
    expect(movePin([1, 2, 3, 4], 2, 'earlier')).toEqual([1, 3, 2, 4])
    expect(movePin([1, 2, 3, 4], 1, 'later')).toEqual([1, 3, 2, 4])
  })

  it('ignores a move past either end', () => {
    expect(movePin([1, 2, 3], 0, 'earlier')).toEqual([1, 2, 3])
    expect(movePin([1, 2, 3], 2, 'later')).toEqual([1, 2, 3])
    expect(movePin([7], 0, 'earlier')).toEqual([7])
    expect(movePin([7], 0, 'later')).toEqual([7])
  })

  it('ignores an index outside the list and an empty list', () => {
    expect(movePin([1, 2, 3], -1, 'later')).toEqual([1, 2, 3])
    expect(movePin([1, 2, 3], 3, 'earlier')).toEqual([1, 2, 3])
    expect(movePin([], 0, 'later')).toEqual([])
  })

  it('returns a new list and leaves the input alone', () => {
    const input = [1, 2, 3]
    const out = movePin(input, 0, 'later')
    expect(out).toEqual([2, 1, 3])
    expect(input).toEqual([1, 2, 3])
    expect(movePin(input, 0, 'earlier')).not.toBe(input)
  })
})

describe('canAddPin', () => {
  it('allows an add below 6 and stops at 6', () => {
    expect(MAX_QUICK_BALANCE_PINS).toBe(6)
    expect(canAddPin(0)).toBe(true)
    expect(canAddPin(5)).toBe(true)
    expect(canAddPin(6)).toBe(false)
    expect(canAddPin(7)).toBe(false)
  })

  it('takes the limit the API reports', () => {
    expect(canAddPin(3, 3)).toBe(false)
    expect(canAddPin(2, 3)).toBe(true)
  })
})

describe('tileHasNoLimit', () => {
  const unlimited = { credit_limit: null, shares_limit_with_account_id: null }
  const owned = creditTile({ card: card() })

  it('is true for an owner\'s card with no credit, no limit and no shared limit', () => {
    expect(tileHasNoLimit(owned, unlimited)).toBe(true)
  })

  it('is false for a card that shares another card\'s limit', () => {
    expect(tileHasNoLimit(owned, { credit_limit: null, shares_limit_with_account_id: 7 })).toBe(false)
  })

  it('is false when the account is unknown or not loaded', () => {
    expect(tileHasNoLimit(owned, undefined)).toBe(false)
  })

  it('is false for a tile without card (editor or viewer)', () => {
    expect(tileHasNoLimit(creditTile(), unlimited)).toBe(false)
  })

  it('is false for a tile with credit', () => {
    expect(tileHasNoLimit(creditTile({ card: card(), credit: credit() }), unlimited)).toBe(false)
  })

  it('is false when the account has a credit limit', () => {
    expect(tileHasNoLimit(owned, { credit_limit: 50000, shares_limit_with_account_id: null })).toBe(false)
  })
})
