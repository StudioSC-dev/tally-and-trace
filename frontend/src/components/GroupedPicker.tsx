import { useEffect, useId, useMemo, useRef, useState } from 'react'
import type { KeyboardEvent, ReactNode } from 'react'
import {
  accountPickerGroups,
  categoryNamePickerGroups,
  categoryPickerGroups,
  filterPickerGroups,
  FLAT_LIMIT,
  quickPicks,
} from '@tally-trace/shared'
import type { Account, Category, PickerGroup, PickerId, PickerOption } from '@tally-trace/shared'

/** A fixed chip ahead of the options, such as "Uncategorized" or "All accounts". */
export interface PickerLeadingChip {
  key: string
  label: string
  selected: boolean
  onClick: () => void
  italic?: boolean
  disabled?: boolean
}

interface PickerCommon {
  groups: PickerGroup[]
  recentIds?: readonly PickerId[]
  /** The fallback after recents in the quick row (the user's main account). */
  pinnedId?: PickerId
  leading?: PickerLeadingChip[]
  /** "account" / "accounts", for the toggle and search copy. */
  noun: { one: string; many: string }
  dataField?: string
  labelledBy: string
  describedBy?: string
  /** Shown in place of the chips when there are no options and no leading chips. */
  emptyText?: string
}

interface SinglePickerProps extends PickerCommon {
  mode: 'single'
  value: PickerId | undefined
  onChange: (id: PickerId | undefined) => void
  /** Tapping the selected chip again clears the choice. */
  deselectable?: boolean
}

interface MultiPickerProps extends PickerCommon {
  mode: 'multi'
  value: readonly PickerId[]
  onChange: (ids: PickerId[]) => void
  maxSelected?: number
}

export type GroupedPickerProps = SinglePickerProps | MultiPickerProps

const CHIP = 'inline-flex min-h-11 max-w-full items-center rounded-full px-3 py-1.5 text-left text-sm font-medium break-words transition'
const chipClass = (selected: boolean, italic = false): string =>
  `${CHIP} ${italic ? 'italic ' : ''}${selected ? 'bg-ink text-paper' : 'bg-sunken text-body hover:bg-sunken'}`

function flatten(groups: readonly PickerGroup[]): PickerOption[] {
  const out: PickerOption[] = []
  for (const g of groups) {
    out.push(...g.options)
    if (g.children) out.push(...flatten(g.children))
  }
  return out
}

/**
 * Chips for picking accounts or categories. With `FLAT_LIMIT` options or fewer every chip
 * shows in one row. With more, a quick row (selected, recent, pinned, then group order)
 * and a toggle that opens the full list inline, grouped, with a search box. Each option is
 * in the DOM at most once. The root is a `role="group"` carrying `data-field`, and every
 * chip a `<button>` with `data-selected`, so a form can focus the selected chip, else the
 * first, on an error.
 */
export function GroupedPicker(props: GroupedPickerProps) {
  const { groups, recentIds, pinnedId, leading = [], noun, dataField, labelledBy, describedBy, emptyText } = props
  const [expanded, setExpanded] = useState(false)
  const [query, setQuery] = useState('')
  const rootRef = useRef<HTMLDivElement>(null)
  const toggleRef = useRef<HTMLButtonElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  // After a pick from the panel, focus moves to that chip once it is in the quick row.
  const focusAfterPick = useRef<PickerId | null>(null)
  const panelId = useId()

  const selected: readonly PickerId[] =
    props.mode === 'single' ? (props.value === undefined ? [] : [props.value]) : props.value
  const selectedSet = new Set(selected)
  const options = useMemo(() => flatten(groups), [groups])
  const byId = useMemo(() => new Map(options.map((o) => [o.id, o])), [options])
  const quick = quickPicks(groups, { selected, recentIds, pinnedId })
  const flat = quick === null
  const open = !flat && expanded
  const filtered = useMemo(() => filterPickerGroups(groups, open ? query : ''), [groups, open, query])

  useEffect(() => {
    const id = focusAfterPick.current
    if (id === null || open) return
    focusAfterPick.current = null
    const chip = rootRef.current?.querySelector<HTMLElement>(`[data-picker-id="${CSS.escape(String(id))}"]`)
    ;(chip ?? toggleRef.current)?.focus()
  })

  const choose = (id: PickerId, fromPanel: boolean) => {
    if (props.mode === 'single') {
      const next = props.deselectable && props.value === id ? undefined : id
      props.onChange(next)
      if (fromPanel) {
        focusAfterPick.current = id
        setExpanded(false)
        setQuery('')
      }
      return
    }
    if (selectedSet.has(id)) {
      props.onChange(props.value.filter((v) => v !== id))
    } else if (props.maxSelected === undefined || props.value.length < props.maxSelected) {
      props.onChange([...props.value, id])
    }
  }

  const collapse = () => {
    setExpanded(false)
    setQuery('')
  }

  const chip = (option: PickerOption, fromPanel: boolean): ReactNode => {
    const isSelected = selectedSet.has(option.id)
    return (
      <button
        type="button"
        key={String(option.id)}
        data-picker-id={String(option.id)}
        data-selected={isSelected ? 'true' : undefined}
        aria-pressed={isSelected}
        aria-describedby={describedBy}
        onClick={() => choose(option.id, fromPanel)}
        className={chipClass(isSelected)}
      >
        {option.label}
        {option.hint !== undefined && <span className="ml-2 text-xs font-normal">({option.hint})</span>}
      </button>
    )
  }

  const leadingChips = leading.map((l) => (
    <button
      type="button"
      key={`leading:${l.key}`}
      data-picker-leading={l.key}
      data-selected={l.selected ? 'true' : undefined}
      aria-pressed={l.selected}
      aria-describedby={describedBy}
      disabled={l.disabled}
      onClick={l.onClick}
      className={chipClass(l.selected, l.italic)}
    >
      {l.label}
    </button>
  ))

  const onPanelKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'Escape') return
    event.preventDefault()
    event.stopPropagation()
    if (query !== '') {
      setQuery('')
      searchRef.current?.focus()
    } else {
      collapse()
      toggleRef.current?.focus()
    }
  }

  const onSearchKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== 'Enter') return
    // Never submits the surrounding form.
    event.preventDefault()
    const matches = flatten(filtered.groups)
    if (query.trim() !== '' && matches.length === 1) choose(matches[0].id, true)
  }

  const renderGroups = (list: readonly PickerGroup[], depth: number): ReactNode =>
    list.map((g) => {
      const headingId = `${panelId}-${g.key}`
      return (
        <div
          key={g.key}
          role={g.label ? 'group' : undefined}
          aria-labelledby={g.label ? headingId : undefined}
          data-picker-group={g.key}
          className={depth > 0 ? 'pl-3' : undefined}
        >
          {g.label && (
            <p id={headingId} data-picker-heading={g.key} className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted">
              {g.label}
            </p>
          )}
          {g.options.length > 0 && <div className="flex flex-wrap gap-2">{g.options.map((o) => chip(o, true))}</div>}
          {g.children && g.children.length > 0 && <div className="mt-2 space-y-2">{renderGroups(g.children, depth + 1)}</div>}
        </div>
      )
    })

  const nSelected = selected.length
  const quickOptions = (quick ?? []).map((id) => byId.get(id)).filter((o): o is PickerOption => o !== undefined)

  return (
    <div
      ref={rootRef}
      className="flex min-w-0 flex-wrap gap-2"
      role="group"
      aria-labelledby={labelledBy}
      aria-describedby={describedBy}
      data-field={dataField}
      data-picker={flat ? 'flat' : open ? 'expanded' : 'collapsed'}
    >
      {options.length === 0 && leading.length === 0 && emptyText !== undefined && (
        <p className="text-sm text-muted">{emptyText}</p>
      )}
      {leadingChips}
      {flat && options.map((o) => chip(o, false))}
      {!flat && !open && quickOptions.map((o) => chip(o, false))}
      {!flat && (
        <button
          type="button"
          ref={toggleRef}
          data-picker-toggle=""
          aria-expanded={open}
          aria-controls={panelId}
          aria-describedby={describedBy}
          onClick={() => (open ? collapse() : setExpanded(true))}
          className={`${CHIP} border border-line text-body hover:bg-sunken`}
        >
          {open ? 'Show fewer' : `All ${options.length} ${noun.many}`}
          <span aria-hidden="true" className="ml-1">{open ? '▴' : '▾'}</span>
        </button>
      )}
      {!flat && !open && props.mode === 'multi' && nSelected > 0 && (
        <span className="self-center text-xs text-muted" data-picker-count="">{nSelected} selected</span>
      )}
      {open && (
        <div id={panelId} className="w-full min-w-0 basis-full space-y-3" onKeyDown={onPanelKeyDown}>
          <input
            ref={searchRef}
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onSearchKeyDown}
            placeholder={`Search ${noun.many}`}
            aria-label={`Search ${noun.many}`}
            data-picker-search=""
            className="input-field focus-ring w-full"
            autoComplete="off"
          />
          <p aria-live="polite" data-picker-matches="" className="text-xs text-muted">
            {query.trim() === ''
              ? ''
              : filtered.count === 0
                ? 'No matches'
                : `${filtered.count} ${filtered.count === 1 ? 'match' : 'matches'}`}
          </p>
          {renderGroups(filtered.groups, 0)}
          {props.mode === 'multi' && nSelected > 0 && (
            <p className="text-xs text-muted" data-picker-count="">{nSelected} selected</p>
          )}
        </div>
      )}
    </div>
  )
}

type PickerPassThrough =
  | Omit<SinglePickerProps, 'groups' | 'noun'>
  | Omit<MultiPickerProps, 'groups' | 'noun'>

type PickerAccount = Pick<Account, 'id' | 'name' | 'currency' | 'account_type' | 'my_role' | 'is_shared'>

/**
 * Accounts as a picker, grouped by type with a nested Shared section. A list short enough
 * to show flat keeps the order it was given.
 */
export function AccountPicker({ accounts, ...rest }: PickerPassThrough & { accounts: readonly PickerAccount[] }) {
  const groups = useMemo<PickerGroup[]>(
    () =>
      accounts.length <= FLAT_LIMIT
        ? [{ key: 'all', label: null, options: accounts.map((a) => ({ id: a.id, label: a.name, hint: a.currency })) }]
        : accountPickerGroups(accounts),
    [accounts],
  )
  return <GroupedPicker {...rest} groups={groups} noun={{ one: 'account', many: 'accounts' }} />
}

type PickerCategory = Pick<Category, 'id' | 'name'> & Partial<Pick<Category, 'kind' | 'is_expense'>>

/**
 * Categories as a picker, grouped by kind. `byName` makes the ids the names (the name
 * filter). A list short enough to show flat keeps the order it was given.
 */
export function CategoryPicker({
  categories,
  all,
  byName = false,
  ...rest
}: PickerPassThrough & { categories: readonly PickerCategory[]; all?: readonly PickerCategory[]; byName?: boolean }) {
  const groups = useMemo<PickerGroup[]>(() => {
    const grouped = byName ? categoryNamePickerGroups(categories) : categoryPickerGroups(categories, all)
    if (flatten(grouped).length > FLAT_LIMIT) return grouped
    if (byName) return [{ key: 'all', label: null, options: flatten(grouped) }]
    return [{ key: 'all', label: null, options: categories.map((c) => ({ id: c.id, label: c.name })) }]
  }, [categories, all, byName])
  return <GroupedPicker {...rest} groups={groups} noun={{ one: 'category', many: 'categories' }} />
}
