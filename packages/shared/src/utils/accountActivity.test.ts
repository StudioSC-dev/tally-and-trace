import { describe, it, expect } from 'vitest'
import type { FullTransaction, LimitedTransaction, SharedFullTransaction } from '../types/api'
import type { RecordPermissions } from '../types/access'
import { accountLeg, parsePage, parsePositiveId, transactionCategoryName } from './accountActivity'

const none: RecordPermissions = { can_edit: false, can_delete: false, can_post: false, can_revert: false, can_tag: false }

const full: FullTransaction = {
  view: 'full',
  id: 1,
  account_id: 10,
  category_id: 5,
  amount: 100,
  currency: 'PHP',
  description: 'Thing',
  transaction_type: 'debit',
  transaction_date: '2026-10-01T00:00:00',
  is_posted: true,
  is_reconciled: false,
  is_recurring: false,
  transfer_fee: 0,
  tags: [],
  created_at: '2026-10-01T00:00:00',
  permissions: none,
  created_by: 'Seth P.',
}

const sharedFull: SharedFullTransaction = {
  ...(({ category_id: _c, ...rest }) => rest)(full),
  view: 'shared_full',
  category_name: 'Food',
}

const limited: LimitedTransaction = {
  view: 'limited',
  id: 2,
  permissions: none,
  created_by: 'Wife W.',
  date: '2026-10-01T00:00:00',
  display_description: 'Debit',
  amount: 100,
  transfer_fee: null,
  currency: 'PHP',
  transaction_type: 'debit',
  is_posted: true,
  category_name: null,
  account: { id: 10, name: 'Main' },
  counterpart: null,
  tags: [],
}

const transfer = (overrides: Partial<FullTransaction>): FullTransaction => ({
  ...full,
  transaction_type: 'transfer',
  account_id: 10,
  transfer_from_account_id: 10,
  transfer_to_account_id: 20,
  ...overrides,
})

describe('accountLeg: debit and credit', () => {
  it('debits go out and credits come in, on Full and Limited rows', () => {
    expect(accountLeg(full, 10, 'PHP')).toMatchObject({ direction: 'out', signed: -100, currency: 'PHP', effectKnown: true })
    expect(accountLeg({ ...full, transaction_type: 'credit' }, 10, 'PHP')).toMatchObject({ direction: 'in', signed: 100 })
    expect(accountLeg(limited, 10, 'PHP')).toMatchObject({ direction: 'out', signed: -100 })
    expect(accountLeg({ ...limited, transaction_type: 'credit' }, 10, 'PHP')).toMatchObject({ direction: 'in', signed: 100 })
  })
})

describe('accountLeg: currencies of debits and credits', () => {
  it('shows a posted debit with a foreign stored currency in the account currency (Full)', () => {
    const row: FullTransaction = { ...full, amount: 4700, currency: 'USD' }
    expect(accountLeg(row, 10, 'PHP')).toMatchObject({ direction: 'out', signed: -4700, currency: 'PHP', effectKnown: true })
  })

  it('shows a posted debit with a foreign stored currency in the account currency (Shared-full and Limited)', () => {
    expect(accountLeg({ ...sharedFull, amount: 4700, currency: 'USD' }, 10, 'PHP')).toMatchObject({ signed: -4700, currency: 'PHP', effectKnown: true })
    expect(accountLeg({ ...limited, amount: 4700, currency: 'USD' }, 10, 'PHP')).toMatchObject({ signed: -4700, currency: 'PHP', effectKnown: true })
  })

  it('shows a posted credit with a foreign stored currency in the account currency', () => {
    const row: FullTransaction = { ...full, transaction_type: 'credit', amount: 4700, currency: 'USD' }
    expect(accountLeg(row, 10, 'PHP')).toMatchObject({ direction: 'in', signed: 4700, currency: 'PHP', effectKnown: true })
  })

  it('keeps an unposted foreign debit at its face, with an unknown effect', () => {
    const row: FullTransaction = { ...full, is_posted: false, amount: 80, currency: 'USD' }
    expect(accountLeg(row, 10, 'PHP')).toMatchObject({ direction: 'out', signed: -80, currency: 'USD', effectKnown: false })
    expect(accountLeg({ ...limited, is_posted: false, amount: 80, currency: 'USD' }, 10, 'PHP'))
      .toMatchObject({ signed: -80, currency: 'USD', effectKnown: false })
  })

  it('reads an unposted face from the projected figure and currency', () => {
    const row: FullTransaction = { ...full, is_posted: false, amount: 4700, currency: 'PHP', projected_amount: 80, projected_currency: 'USD' }
    expect(accountLeg(row, 10, 'PHP')).toMatchObject({ signed: -80, currency: 'USD', effectKnown: false })
  })

  it('knows an unposted debit in the account currency', () => {
    expect(accountLeg({ ...full, is_posted: false }, 10, 'PHP')).toMatchObject({ signed: -100, currency: 'PHP', effectKnown: true })
  })
})

describe('accountLeg: unposted debits and credits follow the forecast and posting', () => {
  // services/forecast.py: a face in the account currency moves it by `amount`; posting applies `amount`.
  it.each([
    ['debit', 'Full', full, -100],
    ['credit', 'Full', { ...full, transaction_type: 'credit' } as FullTransaction, 100],
    ['debit', 'Shared-full', sharedFull, -100],
    ['credit', 'Shared-full', { ...sharedFull, transaction_type: 'credit' } as SharedFullTransaction, 100],
  ] as const)('uses amount, not projected_amount, for a same-currency %s (%s)', (_type, _view, base, signed) => {
    const row = { ...base, is_posted: false, amount: 100, currency: 'PHP', projected_amount: 80, projected_currency: 'PHP' } as const
    expect(accountLeg(row, 10, 'PHP')).toMatchObject({ signed, currency: 'PHP', effectKnown: true })
  })

  it('uses amount when projected_amount is set but projected_currency is not', () => {
    const row: FullTransaction = { ...full, is_posted: false, amount: 100, currency: 'PHP', projected_amount: 80 }
    expect(accountLeg(row, 10, 'PHP')).toMatchObject({ signed: -100, currency: 'PHP', effectKnown: true })
  })

  it.each([
    ['debit', 'Full', full, -80],
    ['credit', 'Full', { ...full, transaction_type: 'credit' } as FullTransaction, 80],
    ['debit', 'Shared-full', sharedFull, -80],
    ['credit', 'Shared-full', { ...sharedFull, transaction_type: 'credit' } as SharedFullTransaction, 80],
  ] as const)('shows a foreign projected face for a %s (%s), effect unknown', (_type, _view, base, signed) => {
    const row = { ...base, is_posted: false, amount: 4700, currency: 'PHP', projected_amount: 80, projected_currency: 'USD' } as const
    expect(accountLeg(row, 10, 'PHP')).toMatchObject({ signed, currency: 'USD', effectKnown: false })
  })

  it('falls back to amount as the face when a foreign face has no projected figure', () => {
    const row: FullTransaction = { ...full, is_posted: false, amount: 80, currency: 'PHP', projected_currency: 'USD' }
    expect(accountLeg(row, 10, 'PHP')).toMatchObject({ signed: -80, currency: 'USD', effectKnown: false })
  })
})

describe('accountLeg: unposted Limited debits and credits are estimates', () => {
  // A foreign purchase posted then reverted keeps its actual PHP amount; redaction hides the USD face.
  it('does not know the effect of a same-currency unposted Limited debit', () => {
    const row: LimitedTransaction = { ...limited, is_posted: false, amount: 4700, currency: 'PHP' }
    expect(accountLeg(row, 10, 'PHP')).toMatchObject({ direction: 'out', signed: -4700, currency: 'PHP', effectKnown: false })
  })

  it('does not know the effect of a same-currency unposted Limited credit', () => {
    const row: LimitedTransaction = { ...limited, transaction_type: 'credit', is_posted: false, amount: 4700, currency: 'PHP' }
    expect(accountLeg(row, 10, 'PHP')).toMatchObject({ direction: 'in', signed: 4700, currency: 'PHP', effectKnown: false })
  })

  it('still knows a posted Limited debit and credit', () => {
    expect(accountLeg(limited, 10, 'PHP')).toMatchObject({ signed: -100, currency: 'PHP', effectKnown: true })
    expect(accountLeg({ ...limited, transaction_type: 'credit' }, 10, 'PHP')).toMatchObject({ signed: 100, effectKnown: true })
  })
})

describe('accountLeg: transfers out', () => {
  it('shows a posted out transfer in the source account currency whatever the row currency', () => {
    const row = transfer({ amount: 100, transfer_fee: 5, currency: 'USD' })
    expect(accountLeg(row, 10, 'PHP')).toMatchObject({ direction: 'out', signed: -105, currency: 'PHP', effectKnown: true, fee: 5 })
  })

  it('keeps an unposted out transfer in the row currency, unknown when it is not the account currency', () => {
    const row = transfer({ amount: 100, currency: 'USD', is_posted: false })
    expect(accountLeg(row, 10, 'PHP')).toMatchObject({ signed: -100, currency: 'USD', effectKnown: false })
  })

  it('takes the fee on top of the amount', () => {
    expect(accountLeg(transfer({ transfer_fee: 5 }), 10, 'PHP')).toEqual({
      direction: 'out', signed: -105, currency: 'PHP', effectKnown: true, fee: 5, counterpartId: 20, counterpartName: null,
    })
  })

  it('falls back to account_id when transfer_from_account_id is null', () => {
    const { transfer_from_account_id: _from, ...row } = transfer({ transfer_fee: 5 })
    expect(accountLeg(row, 10, 'PHP')).toMatchObject({ direction: 'out', signed: -105 })
  })

  it('has no fee when the fee is zero', () => {
    expect(accountLeg(transfer({}), 10, 'PHP').fee).toBeNull()
  })

  it('pays a loan payment principal plus interest', () => {
    const row = transfer({ amount: 900, transfer_fee: 100, transfer_to_account_id: 30 })
    expect(accountLeg(row, 10, 'PHP')).toMatchObject({ signed: -1000, fee: 100, counterpartId: 30 })
  })

  it('shows the whole payment into a hidden loan, with the fee hidden', () => {
    const row: LimitedTransaction = {
      ...limited,
      transaction_type: 'transfer',
      account: { id: 10, name: 'Main' },
      counterpart: { id: null, name: 'Loan payment' },
    }
    expect(accountLeg(row, 10, 'PHP')).toEqual({
      direction: 'out', signed: -100, currency: 'PHP', effectKnown: true, fee: null, counterpartId: null, counterpartName: 'Loan payment',
    })
  })

  it('treats source equal to destination as out', () => {
    expect(accountLeg(transfer({ transfer_to_account_id: 10 }), 10, 'PHP').direction).toBe('out')
  })
})

describe('accountLeg: transfers in', () => {
  it('adds the amount on a same-currency transfer, and never the source fee', () => {
    expect(accountLeg(transfer({ transfer_fee: 5 }), 20, 'PHP')).toEqual({
      direction: 'in', signed: 100, currency: 'PHP', effectKnown: true, fee: null, counterpartId: 10, counterpartName: null,
    })
  })

  it('adds the received amount in the account currency across currencies', () => {
    const row = transfer({ amount: 100, currency: 'USD', received_amount: 5600 })
    expect(accountLeg(row, 20, 'PHP')).toMatchObject({ direction: 'in', signed: 5600, currency: 'PHP', effectKnown: true })
  })

  it('falls back to the amount when received_amount is null in the same currency', () => {
    expect(accountLeg(transfer({ received_amount: null }), 20, 'PHP')).toMatchObject({ signed: 100, currency: 'PHP', effectKnown: true })
  })

  it('adds the stored amount in the account currency for a posted Full transfer with no received amount', () => {
    const row = transfer({ amount: 100, currency: 'USD', received_amount: null })
    expect(accountLeg(row, 20, 'PHP')).toMatchObject({ direction: 'in', signed: 100, currency: 'PHP', effectKnown: true })
  })

  it('does not know the effect of an unposted Full cross-currency transfer with no received amount', () => {
    const row = transfer({ amount: 100, currency: 'USD', received_amount: null, is_posted: false })
    expect(accountLeg(row, 20, 'PHP')).toMatchObject({ direction: 'in', signed: 100, currency: 'USD', effectKnown: false })
  })

  it('does not know the effect of a Limited cross-currency transfer in', () => {
    const row: LimitedTransaction = {
      ...limited,
      transaction_type: 'transfer',
      currency: 'USD',
      account: { id: 10, name: 'Main' },
      counterpart: { id: 20, name: 'Savings' },
    }
    expect(accountLeg(row, 20, 'PHP')).toMatchObject({
      direction: 'in', signed: 100, currency: 'USD', effectKnown: false, counterpartId: 10, counterpartName: 'Main',
    })
  })

  it('knows the effect of a Limited same-currency transfer in', () => {
    const row: LimitedTransaction = {
      ...limited,
      transaction_type: 'transfer',
      account: { id: 10, name: 'Main' },
      counterpart: { id: 20, name: 'Savings' },
    }
    expect(accountLeg(row, 20, 'PHP')).toMatchObject({ direction: 'in', signed: 100, effectKnown: true })
  })

  it('names a hidden card on a Limited row', () => {
    const row: LimitedTransaction = {
      ...limited,
      transaction_type: 'transfer',
      account: { id: null, name: 'Card payment' },
      counterpart: { id: 20, name: 'Savings' },
    }
    expect(accountLeg(row, 20, 'PHP')).toMatchObject({ direction: 'in', signed: 100, counterpartId: null, counterpartName: 'Card payment' })
  })

  it('behaves like Full on a Shared-full row', () => {
    const row: SharedFullTransaction = { ...sharedFull, transaction_type: 'transfer', transfer_from_account_id: 10, transfer_to_account_id: 20, transfer_fee: 5 }
    expect(accountLeg(row, 20, 'PHP')).toMatchObject({ direction: 'in', signed: 100, effectKnown: true })
    expect(accountLeg(row, 10, 'PHP')).toMatchObject({ direction: 'out', signed: -105, fee: 5 })
  })

  it('credits a loan with the principal', () => {
    const row = transfer({ amount: 900, transfer_fee: 100, transfer_to_account_id: 30 })
    expect(accountLeg(row, 30, 'PHP')).toMatchObject({ direction: 'in', signed: 900, fee: null })
  })
})

describe('accountLeg: neither leg', () => {
  it('has no direction and no effect', () => {
    expect(accountLeg(transfer({}), 99, 'PHP')).toMatchObject({ direction: null, signed: 0, fee: null })
  })
})

describe('transactionCategoryName', () => {
  const names = new Map([[5, 'Groceries']])

  it('looks a Full row up in the caller\'s categories', () => {
    expect(transactionCategoryName(full, names)).toBe('Groceries')
    expect(transactionCategoryName({ ...full, category_id: 6 }, names)).toBeNull()
    const { category_id: _id, ...noCategory } = full
    expect(transactionCategoryName(noCategory, names)).toBeNull()
  })

  it('reads category_name on Shared-full and Limited rows', () => {
    expect(transactionCategoryName(sharedFull, names)).toBe('Food')
    expect(transactionCategoryName({ ...sharedFull, category_name: null }, names)).toBeNull()
    expect(transactionCategoryName({ ...limited, category_name: 'Food' }, names)).toBe('Food')
    expect(transactionCategoryName(limited, names)).toBeNull()
  })
})

describe('parsePositiveId', () => {
  it('reads a canonical positive integer', () => {
    expect(parsePositiveId('12')).toBe(12)
  })

  it.each(['0', '-1', '1.5', 'abc', '', undefined, '1e3', '99999999999999999999'])('rejects %s', (raw) => {
    expect(parsePositiveId(raw)).toBeNull()
  })
})

describe('parsePage', () => {
  it('keeps a safe integer from 1 to 1,000,000', () => {
    expect(parsePage(1)).toBe(1)
    expect(parsePage(5)).toBe(5)
    expect(parsePage(1_000_000)).toBe(1_000_000)
  })

  it.each([1e308, 2 ** 53, 1.5, 0, -1, '3', 1_000_001, NaN, null, undefined])('drops %s', (raw) => {
    expect(parsePage(raw)).toBeUndefined()
  })
})
