import { describe, it, expect } from 'vitest'
import type { AccountRole } from '../types/access'
import type { Account, AccountType } from '../types/api'
import { accountSection, ACCOUNT_TYPE_GROUP, groupAccounts } from './accountGroups'

type Row = Pick<Account, 'my_role' | 'is_shared' | 'account_type'> & { name: string }

const row = (
  name: string,
  account_type: AccountType,
  my_role: AccountRole = 'owner',
  is_shared?: boolean | null,
): Row => ({ name, account_type, my_role, ...(is_shared === undefined ? {} : { is_shared }) })

describe('ACCOUNT_TYPE_GROUP', () => {
  it.each([
    ['checking', 'debit'],
    ['savings', 'debit'],
    ['credit', 'credit'],
    ['e_wallet', 'e_wallet'],
    ['cash', 'cash'],
    ['loan', 'loan'],
  ] as const)('maps %s to %s', (type, group) => {
    expect(ACCOUNT_TYPE_GROUP[type]).toBe(group)
  })
})

describe('accountSection', () => {
  it.each([false, null, undefined])('puts an owned account with is_shared %s in individual', (v) => {
    expect(accountSection({ my_role: 'owner', is_shared: v })).toBe('individual')
  })

  it('puts an owned account with is_shared true in shared', () => {
    expect(accountSection({ my_role: 'owner', is_shared: true })).toBe('shared')
  })

  it.each(['admin', 'editor', 'viewer', 'tag_viewer'] as const)('puts a %s account in shared without the field', (role) => {
    expect(accountSection({ my_role: role })).toBe('shared')
  })
})

describe('groupAccounts', () => {
  it('returns [] for no accounts', () => {
    expect(groupAccounts([])).toEqual([])
  })

  it('orders sections and groups for shuffled input, with counts', () => {
    const list = [
      row('loan-s', 'loan', 'editor'),
      row('cash-i', 'cash'),
      row('credit-s', 'credit', 'owner', true),
      row('savings-i', 'savings'),
      row('wallet-i', 'e_wallet'),
      row('checking-s', 'checking', 'tag_viewer'),
      row('credit-i', 'credit', 'owner', false),
    ]
    const result = groupAccounts(list)
    expect(result.map((s) => [s.section, s.label, s.count])).toEqual([
      ['individual', 'Individual', 4],
      ['shared', 'Shared', 3],
    ])
    expect(result[0]?.groups.map((g) => g.group)).toEqual(['debit', 'credit', 'e_wallet', 'cash'])
    expect(result[1]?.groups.map((g) => g.group)).toEqual(['debit', 'credit', 'loan'])
    expect(result[0]?.groups.map((g) => g.label)).toEqual(['Debit', 'Credit', 'E-wallet', 'Cash'])
  })

  it('keeps input order inside a group, with checking and savings together', () => {
    const result = groupAccounts([
      row('b', 'savings'),
      row('a', 'checking'),
      row('c', 'savings'),
    ])
    expect(result[0]?.groups[0]?.accounts.map((a) => a.name)).toEqual(['b', 'a', 'c'])
  })

  it('leaves out empty groups and sections', () => {
    const result = groupAccounts([row('only', 'loan', 'viewer')])
    expect(result).toHaveLength(1)
    expect(result[0]?.section).toBe('shared')
    expect(result[0]?.groups).toHaveLength(1)
    expect(result[0]?.groups[0]?.group).toBe('loan')
  })
})
