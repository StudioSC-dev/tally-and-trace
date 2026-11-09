import { describe, expect, it } from 'vitest'
import { selectOptGroups } from './pickerOptGroups'
import { accountPickerGroups, categoryPickerGroups } from './pickerOptions'

const acct = (id: number, name: string, account_type: string, extra: object = {}) =>
  ({ id, name, currency: 'PHP', account_type, my_role: 'owner', is_shared: false, ...extra }) as never

describe('selectOptGroups', () => {
  it('labels groups like the Accounts page and nests Shared as "Shared · Debit"', () => {
    const groups = accountPickerGroups([
      acct(1, 'BDO', 'savings'),
      acct(2, 'Visa', 'credit'),
      acct(3, 'Joint', 'checking', { my_role: 'editor', is_shared: true }),
    ])
    expect(selectOptGroups(groups).map((g) => [g.label, g.options.map((o) => o.id)])).toEqual([
      ['Debit', [1]],
      ['Credit', [2]],
      ['Shared · Debit', [3]],
    ])
  })

  it('keeps every option exactly once and in group order', () => {
    const groups = accountPickerGroups([acct(5, 'B', 'cash'), acct(4, 'A', 'cash'), acct(6, 'W', 'e_wallet')])
    expect(selectOptGroups(groups).flatMap((g) => g.options.map((o) => o.id))).toEqual([6, 4, 5])
  })

  it('groups categories by kind, and gives one kind no heading', () => {
    const two = selectOptGroups(
      categoryPickerGroups([
        { id: 1, name: 'Pay', kind: 'income' },
        { id: 2, name: 'Food', kind: 'expense' },
      ]),
    )
    expect(two.map((g) => g.label)).toEqual(['Expense', 'Income'])
    const one = selectOptGroups(categoryPickerGroups([{ id: 2, name: 'Food', kind: 'expense' }]))
    expect(one.map((g) => g.label)).toEqual([null])
  })

  it('returns nothing for no options', () => {
    expect(selectOptGroups([])).toEqual([])
  })
})
