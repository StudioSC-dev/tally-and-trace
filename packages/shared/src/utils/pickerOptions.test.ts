import { describe, it, expect } from 'vitest'
import type { AccountRole } from '../types/access'
import type { AccountType, Category, CategoryKind } from '../types/api'
import type { CurrencyCode } from './currency'
import {
  FLAT_LIMIT,
  accountPickerGroups,
  categoryNamePickerGroups,
  categoryPickerGroups,
  filterPickerGroups,
  pushRecent,
  quickPicks,
  stepPickerRow,
  type PickerGroup,
} from './pickerOptions'

const acct = (
  id: number,
  name: string,
  account_type: AccountType,
  my_role: AccountRole = 'owner',
  is_shared?: boolean,
  currency: CurrencyCode = 'PHP',
) => ({ id, name, account_type, my_role, currency, ...(is_shared === undefined ? {} : { is_shared }) })

const cat = (id: number, name: string, kind?: CategoryKind, is_expense?: boolean) =>
  ({ id, name, ...(kind ? { kind } : {}), ...(is_expense === undefined ? {} : { is_expense }) }) as Pick<Category, 'id' | 'name'> &
    Partial<Pick<Category, 'kind' | 'is_expense'>>

const flat = (n: number): PickerGroup[] => [
  { key: 'g', label: null, options: Array.from({ length: n }, (_, i) => ({ id: i + 1, label: `Opt ${i + 1}` })) },
]
const ids = (g: PickerGroup): Array<number | string> => g.options.map((o) => o.id)

describe('accountPickerGroups', () => {
  const accounts = [
    acct(1, 'Wise', 'checking', 'owner', false, 'USD'),
    acct(2, 'BDO Savings', 'savings'),
    acct(3, 'BPI Visa', 'credit'),
    acct(4, 'GCash', 'e_wallet'),
    acct(5, 'Cash', 'cash'),
    acct(6, 'Car loan', 'loan'),
    acct(7, 'Joint', 'checking', 'admin'),
    acct(8, 'Family card', 'credit', 'owner', true),
  ]

  it('builds the expected tree for mixed types and roles', () => {
    const tree = accountPickerGroups(accounts)
    expect(tree.map((g) => [g.key, g.label])).toEqual([
      ['debit', 'Debit'],
      ['credit', 'Credit'],
      ['e_wallet', 'E-wallet'],
      ['cash', 'Cash'],
      ['loan', 'Loan'],
      ['shared', 'Shared'],
    ])
    expect(ids(tree[0])).toEqual([2, 1])
    const shared = tree[5]
    expect(shared.options).toEqual([])
    expect(shared.children?.map((g) => [g.label, ids(g)])).toEqual([
      ['Debit', [7]],
      ['Credit', [8]],
    ])
  })

  it('uses the currency as the hint', () => {
    expect(accountPickerGroups(accounts)[0].options.find((o) => o.id === 1)).toEqual({
      id: 1,
      label: 'Wise',
      hint: 'USD',
    })
  })

  it('has no empty groups and no Shared group without shared accounts', () => {
    const tree = accountPickerGroups([acct(1, 'A', 'cash'), acct(2, 'B', 'loan')])
    expect(tree.map((g) => g.label)).toEqual(['Cash', 'Loan'])
    expect(tree.every((g) => g.options.length > 0)).toBe(true)
    expect(accountPickerGroups([])).toEqual([])
  })

  it('sorts by name inside a group, ignoring case', () => {
    const tree = accountPickerGroups([acct(1, 'zeta', 'cash'), acct(2, 'Alpha', 'cash'), acct(3, 'beta', 'cash')])
    expect(tree[0].options.map((o) => o.label)).toEqual(['Alpha', 'beta', 'zeta'])
  })

  it('does not mutate its input', () => {
    const input = [acct(1, 'B', 'cash'), acct(2, 'A', 'cash')]
    accountPickerGroups(input)
    expect(input.map((a) => a.id)).toEqual([1, 2])
  })
})

describe('categoryPickerGroups', () => {
  it('groups by kind in Expense, Income, Transfer order, sorted by name', () => {
    const tree = categoryPickerGroups([
      cat(1, 'Savings', 'transfer'),
      cat(2, 'Salary', 'income'),
      cat(3, 'Rent', 'expense'),
      cat(4, 'Food', 'expense'),
    ])
    expect(tree.map((g) => [g.label, g.options.map((o) => o.label)])).toEqual([
      ['Expense', ['Food', 'Rent']],
      ['Income', ['Salary']],
      ['Transfer', ['Savings']],
    ])
  })

  it('reads a legacy is_expense category without kind', () => {
    const tree = categoryPickerGroups([cat(1, 'Old out', undefined, true), cat(2, 'Old in', undefined, false), cat(3, 'New', 'expense')])
    expect(tree.map((g) => [g.key, ids(g)])).toEqual([
      ['expense', [3, 1]],
      ['income', [2]],
    ])
  })

  it('adds the kind to a same-name pair', () => {
    const all = [cat(1, 'Gifts', 'income'), cat(2, 'Gifts', 'expense'), cat(3, 'Food', 'expense')]
    const labels = categoryPickerGroups(all).flatMap((g) => g.options.map((o) => o.label))
    expect(labels).toEqual(['Food', 'Gifts (expense)', 'Gifts (income)'])
  })

  it('takes labels from `all` when the list is a filtered subset', () => {
    const all = [cat(1, 'Gifts', 'income'), cat(2, 'Gifts', 'expense')]
    const tree = categoryPickerGroups([all[0]], all)
    expect(tree[0].options[0].label).toBe('Gifts (income)')
  })

  it('gives one kind a single group with a null label', () => {
    const tree = categoryPickerGroups([cat(1, 'B', 'expense'), cat(2, 'A', 'expense')])
    expect(tree).toHaveLength(1)
    expect(tree[0].label).toBeNull()
    expect(tree[0].options.map((o) => o.label)).toEqual(['A', 'B'])
  })
})

describe('categoryNamePickerGroups', () => {
  it('lists a name used in two kinds in both groups with the same id', () => {
    const tree = categoryNamePickerGroups([cat(1, 'Gifts', 'income'), cat(2, 'Gifts', 'expense'), cat(3, 'Food', 'expense')])
    expect(tree.map((g) => [g.label, ids(g)])).toEqual([
      ['Expense', ['Food', 'Gifts']],
      ['Income', ['Gifts']],
    ])
    expect(tree[0].options[1]).toEqual({ id: 'Gifts', label: 'Gifts' })
  })

  it('shows a name once per kind and leaves a single kind unheaded', () => {
    const tree = categoryNamePickerGroups([cat(1, 'Food', 'expense'), cat(2, 'Food', 'expense')])
    expect(tree).toHaveLength(1)
    expect(tree[0].label).toBeNull()
    expect(ids(tree[0])).toEqual(['Food'])
  })
})

describe('quickPicks', () => {
  const g = flat(12)

  it('returns null at 8 options and a list at 9', () => {
    expect(FLAT_LIMIT).toBe(8)
    expect(quickPicks(flat(8))).toBeNull()
    expect(quickPicks(flat(9))).not.toBeNull()
    expect(quickPicks(flat(0))).toBeNull()
  })

  it('counts options inside nested groups', () => {
    const nested: PickerGroup[] = [
      { key: 'a', label: 'A', options: flat(5)[0].options },
      { key: 's', label: 'S', options: [], children: [{ key: 's:a', label: 'A', options: [{ id: 100, label: 'x' }, { id: 101, label: 'y' }, { id: 102, label: 'z' }, { id: 103, label: 'w' }] }] },
    ]
    expect(quickPicks(nested)).toEqual([1, 2, 3, 4, 5])
    expect(quickPicks(nested, { selected: [103] })).toEqual([103, 1, 2, 3, 4])
  })

  it('falls back to group order', () => {
    expect(quickPicks(g)).toEqual([1, 2, 3, 4, 5])
  })

  it('puts selected first, then recents in order, then pinned, then group order', () => {
    expect(quickPicks(g, { selected: [9], recentIds: [7, 3], pinnedId: 11 })).toEqual([9, 7, 3, 11, 1])
  })

  it('adds the pinned id after recents', () => {
    expect(quickPicks(g, { recentIds: [4], pinnedId: 10 })).toEqual([4, 10, 1, 2, 3])
  })

  it('de-duplicates', () => {
    expect(quickPicks(g, { selected: [2], recentIds: [2, 3, 3], pinnedId: 3 })).toEqual([2, 3, 1, 4, 5])
  })

  it('drops stale recent ids, a stale pinned id and a stale selected id', () => {
    expect(quickPicks(g, { selected: [99], recentIds: [98, 6], pinnedId: 97 })).toEqual([6, 1, 2, 3, 4])
  })

  it('caps at limit', () => {
    expect(quickPicks(g, { recentIds: [12, 11, 10, 9, 8, 7], limit: 3 })).toEqual([12, 11, 10])
  })

  it('shows every selected id even past the limit', () => {
    expect(quickPicks(g, { selected: [1, 2, 3, 4, 5, 6, 7], recentIds: [12], limit: 5 })).toEqual([1, 2, 3, 4, 5, 6, 7])
  })

  it('matches string ids', () => {
    const named: PickerGroup[] = [{ key: 'k', label: null, options: Array.from({ length: 10 }, (_, i) => ({ id: `n${i}`, label: `n${i}` })) }]
    expect(quickPicks(named, { recentIds: ['n7', 'gone'], limit: 2 })).toEqual(['n7', 'n0'])
  })
})

describe('filterPickerGroups', () => {
  const groups: PickerGroup[] = [
    { key: 'credit', label: 'Credit', options: [{ id: 1, label: 'BPI Visa' }, { id: 2, label: 'Metrobank' }] },
    { key: 'cash', label: 'Cash', options: [{ id: 3, label: 'Café fund' }] },
    {
      key: 'shared',
      label: 'Shared',
      options: [],
      children: [
        { key: 'shared:credit', label: 'Credit', options: [{ id: 4, label: 'Joint BPI' }] },
        { key: 'shared:cash', label: 'Cash', options: [{ id: 5, label: 'Pot' }] },
      ],
    },
  ]

  it('matches bpi case-insensitively and counts across nested groups', () => {
    const r = filterPickerGroups(groups, 'bpi')
    expect(r.count).toBe(2)
    expect(r.groups.map((g) => g.key)).toEqual(['credit', 'shared'])
    expect(r.groups[0].options.map((o) => o.id)).toEqual([1])
    expect(r.groups[1].children?.map((c) => [c.key, ids(c)])).toEqual([['shared:credit', [4]]])
  })

  it('matches cafe against Café and the reverse', () => {
    expect(filterPickerGroups(groups, 'cafe').count).toBe(1)
    const accented: PickerGroup[] = [{ key: 'k', label: null, options: [{ id: 1, label: 'Cafe' }] }]
    expect(filterPickerGroups(accented, 'CAFÉ').count).toBe(1)
  })

  it('returns the groups unchanged for an empty or blank query', () => {
    for (const q of ['', '   ']) {
      const r = filterPickerGroups(groups, q)
      expect(r.groups).toEqual(groups)
      expect(r.count).toBe(5)
    }
  })

  it('drops empty groups and reports zero matches', () => {
    const r = filterPickerGroups(groups, 'zzz')
    expect(r).toEqual({ groups: [], count: 0 })
  })

  it('does not mutate its input', () => {
    const before = JSON.stringify(groups)
    filterPickerGroups(groups, 'bpi')
    expect(JSON.stringify(groups)).toBe(before)
  })
})

describe('pushRecent', () => {
  it('puts the id first', () => {
    expect(pushRecent([1, 2, 3], 9)).toEqual([9, 1, 2, 3])
  })

  it('moves an existing id to the front without a duplicate', () => {
    expect(pushRecent([1, 2, 3], 3)).toEqual([3, 1, 2])
  })

  it('removes repeated ids that are not the new one', () => {
    expect(pushRecent([1, 1, 2], 3)).toEqual([3, 1, 2])
    expect(pushRecent([2, 1, 2, 1, 3], 1)).toEqual([1, 2, 3])
  })

  it('caps at 8 by default and at max when given', () => {
    const full = [1, 2, 3, 4, 5, 6, 7, 8]
    expect(pushRecent(full, 9)).toEqual([9, 1, 2, 3, 4, 5, 6, 7])
    expect(pushRecent(full, 9, 3)).toEqual([9, 1, 2])
  })

  it('does not mutate its input', () => {
    const list = [1, 2]
    pushRecent(list, 3)
    expect(list).toEqual([1, 2])
  })
})

describe('stepPickerRow', () => {
  it('moves from the search box to the first row and down to the last', () => {
    expect(stepPickerRow(-1, 'ArrowDown', 3)).toBe(0)
    expect(stepPickerRow(0, 'ArrowDown', 3)).toBe(1)
    expect(stepPickerRow(2, 'ArrowDown', 3)).toBe(2)
  })

  it('moves up between rows and from the first row back to the search box', () => {
    expect(stepPickerRow(2, 'ArrowUp', 3)).toBe(1)
    expect(stepPickerRow(0, 'ArrowUp', 3)).toBe(-1)
    expect(stepPickerRow(-1, 'ArrowUp', 3)).toBe(-1)
  })

  it('stays on the search box with no rows', () => {
    expect(stepPickerRow(-1, 'ArrowDown', 0)).toBe(-1)
    expect(stepPickerRow(0, 'ArrowUp', 0)).toBe(-1)
  })

  it('clamps an index past the rows', () => {
    expect(stepPickerRow(7, 'ArrowUp', 3)).toBe(2)
    expect(stepPickerRow(7, 'ArrowDown', 3)).toBe(2)
  })
})
