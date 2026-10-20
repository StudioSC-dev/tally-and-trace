import { describe, it, expect } from 'vitest'
import { categoryKindOf, categoryOptionLabel } from './categories'

const income = { id: 1, name: 'Gifts', kind: 'income' as const }
const expense = { id: 2, name: 'Gifts', kind: 'expense' as const }
const rent = { id: 3, name: 'Rent', kind: 'expense' as const }

describe('categoryOptionLabel', () => {
  it('gives the bare name when the name is unique', () => {
    expect(categoryOptionLabel(rent, [income, expense, rent])).toBe('Rent')
  })

  it('adds the kind to each of a same-name pair', () => {
    const all = [income, expense, rent]
    expect(categoryOptionLabel(income, all)).toBe('Gifts (income)')
    expect(categoryOptionLabel(expense, all)).toBe('Gifts (expense)')
  })

  it('does not count the category itself as a duplicate', () => {
    expect(categoryOptionLabel(income, [income, rent])).toBe('Gifts')
    expect(categoryOptionLabel(income, [income, { ...income }])).toBe('Gifts')
  })

  it('is exact about the name', () => {
    expect(categoryOptionLabel(income, [income, { id: 9, name: 'gifts' }])).toBe('Gifts')
  })
})

describe('categoryKindOf', () => {
  it('prefers kind', () => {
    expect(categoryKindOf({ kind: 'transfer', is_expense: false })).toBe('transfer')
  })

  it('falls back from is_expense', () => {
    expect(categoryKindOf({ is_expense: false })).toBe('income')
    expect(categoryKindOf({ is_expense: true })).toBe('expense')
    expect(categoryKindOf({})).toBe('expense')
  })

  it('labels a legacy pair from is_expense', () => {
    const all = [{ id: 1, name: 'Gifts', is_expense: false }, { id: 2, name: 'Gifts', is_expense: true }]
    expect(categoryOptionLabel(all[0]!, all)).toBe('Gifts (income)')
    expect(categoryOptionLabel(all[1]!, all)).toBe('Gifts (expense)')
  })
})
