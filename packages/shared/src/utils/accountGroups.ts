import type { Account, AccountType } from '../types/api'

/** The Accounts page's two sections, in display order. */
export type AccountSection = 'individual' | 'shared'

export const ACCOUNT_SECTIONS: ReadonlyArray<{ section: AccountSection; label: string }> = [
  { section: 'individual', label: 'Individual' },
  { section: 'shared', label: 'Shared' },
]

/** Type groups inside a section, in display order. */
export type AccountGroup = 'debit' | 'credit' | 'e_wallet' | 'cash' | 'loan'

export const ACCOUNT_GROUPS: ReadonlyArray<{ group: AccountGroup; label: string }> = [
  { group: 'debit', label: 'Debit' },
  { group: 'credit', label: 'Credit' },
  { group: 'e_wallet', label: 'E-wallet' },
  { group: 'cash', label: 'Cash' },
  { group: 'loan', label: 'Loan' },
]

/** Grouping is by `account_type` only; the spending-wallet flag doesn't affect it. */
export const ACCOUNT_TYPE_GROUP = {
  checking: 'debit',
  savings: 'debit',
  credit: 'credit',
  e_wallet: 'e_wallet',
  cash: 'cash',
  loan: 'loan',
} as const satisfies Record<AccountType, AccountGroup>

type Groupable = Pick<Account, 'my_role' | 'is_shared' | 'account_type'>

/**
 * Shared: an account someone else owns, or one the caller owns and shares out. A missing
 * or null `is_shared` on an owned account reads as individual.
 */
export function accountSection(a: Pick<Account, 'my_role' | 'is_shared'>): AccountSection {
  return a.my_role !== 'owner' || a.is_shared === true ? 'shared' : 'individual'
}

export interface AccountGroupBucket<T> {
  group: AccountGroup
  label: string
  accounts: T[]
}

export interface AccountSectionBucket<T> {
  section: AccountSection
  label: string
  /** Accounts in the section. */
  count: number
  groups: Array<AccountGroupBucket<T>>
}

/**
 * Splits accounts into sections and type groups in fixed order. Empty groups and
 * sections are left out; input order is kept inside a group, so the caller sorts.
 */
export function groupAccounts<T extends Groupable>(list: T[]): Array<AccountSectionBucket<T>> {
  const out: Array<AccountSectionBucket<T>> = []
  for (const { section, label } of ACCOUNT_SECTIONS) {
    const inSection = list.filter((a) => accountSection(a) === section)
    const groups: Array<AccountGroupBucket<T>> = []
    for (const { group, label: groupLabel } of ACCOUNT_GROUPS) {
      const accounts = inSection.filter((a) => ACCOUNT_TYPE_GROUP[a.account_type] === group)
      if (accounts.length > 0) groups.push({ group, label: groupLabel, accounts })
    }
    if (groups.length > 0) out.push({ section, label, count: inSection.length, groups })
  }
  return out
}
