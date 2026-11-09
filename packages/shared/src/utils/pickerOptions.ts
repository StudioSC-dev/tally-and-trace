import type { Account, Category, CategoryKind } from '../types/api'
import { ACCOUNT_SECTIONS, groupAccounts } from './accountGroups'
import { categoryKindOf, categoryOptionLabel } from './categories'

/** A picker option id: a number, or a string for the category name filter. */
export type PickerId = number | string

export interface PickerOption {
  id: PickerId
  label: string
  /** Secondary text, the currency for accounts. */
  hint?: string
}

export interface PickerGroup {
  key: string
  /** Null means no heading. */
  label: string | null
  options: PickerOption[]
  children?: PickerGroup[]
}

/** At or below this many options a picker shows everything flat. */
export const FLAT_LIMIT = 8
/** Chips in the collapsed quick row. */
export const QUICK_LIMIT = 5
/** Most recent ids kept per list. */
export const RECENT_MAX = 8

type PickerAccount = Pick<Account, 'id' | 'name' | 'currency' | 'account_type' | 'my_role' | 'is_shared'>

const byName = (a: { name: string; id: number }, b: { name: string; id: number }): number =>
  a.name.localeCompare(b.name, 'en', { sensitivity: 'base' }) || a.id - b.id

/**
 * Accounts as picker groups: one group per type in `ACCOUNT_GROUPS` order, then a nested
 * "Shared" group holding the same type groups, present only when shared accounts exist.
 * Empty groups are left out and options are sorted by name.
 */
export function accountPickerGroups(accounts: readonly PickerAccount[]): PickerGroup[] {
  const out: PickerGroup[] = []
  for (const section of groupAccounts([...accounts])) {
    const typeGroups: PickerGroup[] = section.groups.map((g) => ({
      key: section.section === 'individual' ? g.group : `${section.section}:${g.group}`,
      label: g.label,
      options: [...g.accounts]
        .sort(byName)
        .map((a) => ({ id: a.id, label: a.name, hint: a.currency })),
    }))
    if (section.section === 'individual') {
      out.push(...typeGroups)
    } else {
      const label = ACCOUNT_SECTIONS.find((s) => s.section === section.section)?.label ?? section.label
      out.push({ key: section.section, label, options: [], children: typeGroups })
    }
  }
  return out
}

const KIND_GROUPS: ReadonlyArray<{ kind: CategoryKind; label: string }> = [
  { kind: 'expense', label: 'Expense' },
  { kind: 'income', label: 'Income' },
  { kind: 'transfer', label: 'Transfer' },
]

type PickerCategory = Pick<Category, 'id' | 'name'> & Partial<Pick<Category, 'kind' | 'is_expense'>>

function kindGroups<T>(
  items: readonly PickerCategory[],
  toOption: (c: PickerCategory) => T,
): Array<{ key: string; label: string | null; options: T[] }> {
  const groups: Array<{ key: string; label: string | null; options: T[] }> = []
  for (const { kind, label } of KIND_GROUPS) {
    const inKind = items.filter((c) => categoryKindOf(c) === kind).sort(byName)
    if (inKind.length > 0) groups.push({ key: kind, label, options: inKind.map(toOption) })
  }
  // One kind present: no heading.
  if (groups.length === 1) groups[0].label = null
  return groups
}

/**
 * Categories grouped by kind (Expense, Income, Transfer), sorted by name. `all` decides
 * which names need a kind suffix; it defaults to `categories`. One kind gives a single
 * group with no heading.
 */
export function categoryPickerGroups(
  categories: readonly PickerCategory[],
  all: readonly PickerCategory[] = categories,
): PickerGroup[] {
  return kindGroups(categories, (c) => ({ id: c.id, label: categoryOptionLabel(c, all) }))
}

/**
 * Category names as ids, for the name filter. A name used in two kinds appears under
 * each kind with the same id.
 */
export function categoryNamePickerGroups(categories: readonly PickerCategory[]): PickerGroup[] {
  const seen = new Map<string, PickerCategory>()
  const unique: PickerCategory[] = []
  for (const c of categories) {
    const k = `${categoryKindOf(c)}\u0000${c.name}`
    if (!seen.has(k)) {
      seen.set(k, c)
      unique.push(c)
    }
  }
  return kindGroups(unique, (c) => ({ id: c.name, label: c.name }))
}

function flatten(groups: readonly PickerGroup[]): PickerOption[] {
  const out: PickerOption[] = []
  for (const g of groups) {
    out.push(...g.options)
    if (g.children) out.push(...flatten(g.children))
  }
  return out
}

export interface QuickPickInput {
  selected?: readonly PickerId[]
  recentIds?: readonly PickerId[]
  pinnedId?: PickerId
  limit?: number
}

/**
 * The ids for the collapsed quick row: selected first, then recents in order, then the
 * pinned id, then group order. De-duplicated, unknown ids dropped, capped at `limit`
 * (every selected id shows even past the limit). Null when there are `FLAT_LIMIT` options
 * or fewer, meaning show everything flat.
 */
export function quickPicks(
  groups: readonly PickerGroup[],
  { selected = [], recentIds = [], pinnedId, limit = QUICK_LIMIT }: QuickPickInput = {},
): PickerId[] | null {
  const all = flatten(groups).map((o) => o.id)
  if (all.length <= FLAT_LIMIT) return null
  const known = new Set(all)
  const out: PickerId[] = []
  const have = new Set<PickerId>()
  const add = (id: PickerId | undefined, force: boolean): void => {
    if (id === undefined || !known.has(id) || have.has(id)) return
    if (!force && out.length >= limit) return
    have.add(id)
    out.push(id)
  }
  for (const id of selected) add(id, true)
  for (const id of recentIds) add(id, false)
  add(pinnedId, false)
  for (const id of all) add(id, false)
  return out
}

const fold = (s: string): string =>
  s.normalize('NFD').replace(/\p{M}/gu, '').toLocaleLowerCase('en').trim()

export interface FilteredPickerGroups {
  groups: PickerGroup[]
  /** Matching options. */
  count: number
}

/**
 * Keeps options whose label contains the query, ignoring case and accents. Empty groups
 * are dropped, nested ones included. An empty query returns the groups unchanged.
 */
export function filterPickerGroups(
  groups: readonly PickerGroup[],
  query: string,
): FilteredPickerGroups {
  const q = fold(query)
  if (q === '') return { groups: [...groups], count: flatten(groups).length }
  let count = 0
  const walk = (list: readonly PickerGroup[]): PickerGroup[] => {
    const out: PickerGroup[] = []
    for (const g of list) {
      const options = g.options.filter((o) => fold(o.label).includes(q))
      const children = g.children ? walk(g.children) : undefined
      count += options.length
      if (options.length > 0 || (children !== undefined && children.length > 0)) {
        out.push({ ...g, options, ...(children ? { children } : {}) })
      }
    }
    return out
  }
  return { groups: walk(groups), count }
}

/** Puts `id` first, removes every repeated id keeping first-seen order, and keeps at most `max` ids. */
export function pushRecent(list: readonly PickerId[], id: PickerId, max: number = RECENT_MAX): PickerId[] {
  return [...new Set<PickerId>([id, ...list])].slice(0, max)
}
