import { useEffect, useMemo, useRef, useState } from 'react'
import { Link } from '@tanstack/react-router'
import { accountPickerGroups, canAddPin, movePin, tileGroupLabel, tileHasNoLimit, tileLines } from '@tally-trace/shared'
import type { Account, PickerGroup, QuickBalanceTile, TileLine } from '@tally-trace/shared'
import { useGetAccountsQuery, useGetQuickBalancesQuery, usePutQuickBalancesMutation } from '../store/api'
import { useCurrency } from '../hooks/useCurrency'
import { Skeleton } from './Loading'

const TONE: Record<TileLine['tone'], string> = {
  normal: 'text-ink',
  muted: 'text-muted',
  danger: 'text-danger',
}

function LineView({ line, headline }: { line: TileLine; headline: boolean }) {
  const size = line.secondary ? 'text-xs' : headline ? 'text-lg font-semibold' : 'text-sm'
  return (
    <p className={`${size} ${TONE[line.tone]} break-words`} data-testid={`quick-balance-${line.id}`}>
      {line.label !== null && <span className="text-xs font-medium uppercase tracking-wide text-muted mr-1">{line.label}</span>}
      {line.label !== null && ' '}
      {line.text}
    </p>
  )
}

function Tile({ tile, defaultCurrency, noLimit }: { tile: QuickBalanceTile; defaultCurrency: string; noLimit: boolean }) {
  const lines = tileLines(tile, { noLimit })
  const isCredit = tile.account_type === 'credit'
  return (
    <Link
      to="/accounts/$accountId"
      params={{ accountId: String(tile.account_id) }}
      data-testid="quick-balance-tile"
      data-account-id={tile.account_id}
      data-type={tile.account_type}
      className={`focus-ring block min-h-11 p-3 bg-sunken hover:bg-line transition-colors duration-200 ${isCredit ? 'col-span-2 lg:col-span-1' : ''}`}
    >
      <p className="text-xs font-semibold uppercase tracking-wide text-muted">
        {tileGroupLabel(tile)}
        {tile.currency !== defaultCurrency && <span className="ml-2" data-testid="quick-balance-currency">{tile.currency}</span>}
      </p>
      <p className="text-sm font-medium text-ink truncate" data-testid="quick-balance-name">{tile.name}</p>
      <div className="mt-1 space-y-0.5">
        {lines.map((line, index) => (
          <LineView key={line.id} line={line} headline={index === 0 && line.id === 'balance'} />
        ))}
      </div>
    </Link>
  )
}

const ACTION = 'min-h-11 px-4 py-2 transition-colors duration-200 focus-ring'
const ICON_ACTION = 'min-h-11 min-w-11 px-2 bg-sunken text-ink hover:bg-line transition-colors duration-200 focus-ring disabled:opacity-40 disabled:hover:bg-sunken'

const saveError = (error: unknown): string => {
  const detail = (error as { data?: { detail?: unknown } } | undefined)?.data?.detail
  return typeof detail === 'string' && detail !== '' ? detail : 'Could not save your quick balances. Try again.'
}

/** What an edit row needs to name an account. */
interface PinInfo {
  name: string
  account_type: Account['account_type']
  currency: string
}

function groupOptionCount(groups: readonly PickerGroup[]): number {
  return groups.reduce((n, g) => n + g.options.length + groupOptionCount(g.children ?? []), 0)
}

function AddGroups({ groups, onPick }: { groups: readonly PickerGroup[]; onPick: (id: number) => void }) {
  return (
    <>
      {groups.map((g) => (
        <div key={g.key} role="group" aria-label={g.label ?? undefined} data-testid="quick-balance-add-group" data-group={g.key} className="space-y-1">
          {g.label !== null && <p className="text-xs font-semibold uppercase tracking-wide text-muted">{g.label}</p>}
          {g.options.length > 0 && (
            <div className="flex flex-wrap gap-2">
              {g.options.map((o) => (
                <button
                  key={String(o.id)}
                  type="button"
                  data-testid="quick-balance-add-option"
                  data-account-id={String(o.id)}
                  onClick={() => onPick(Number(o.id))}
                  className="inline-flex min-h-11 max-w-full items-center px-3 py-1.5 text-left text-sm font-medium break-words bg-sunken text-body hover:bg-line transition-colors duration-200 focus-ring"
                >
                  {o.label}
                  {o.hint !== undefined && <span className="ml-2 text-xs font-normal">({o.hint})</span>}
                </button>
              ))}
            </div>
          )}
          {g.children !== undefined && g.children.length > 0 && (
            <div className="pl-3 space-y-2">
              <AddGroups groups={g.children} onPick={onPick} />
            </div>
          )}
        </div>
      ))}
    </>
  )
}

/** The edit view: the pinned accounts in order with Move earlier, Move later and Remove, and Add account. */
function PinEditor({ tiles, pinned, onDone }: { tiles: QuickBalanceTile[]; pinned: boolean; onDone: () => void }) {
  const [draft, setDraft] = useState<number[]>(() => tiles.map((t) => t.account_id))
  const [adding, setAdding] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [save, { isLoading: saving }] = usePutQuickBalancesMutation()
  const { data: accountsPage } = useGetAccountsQuery({ is_active: true, limit: 1000 })
  const focusAfterMove = useRef<string | null>(null)

  const accounts = useMemo(() => accountsPage?.items ?? [], [accountsPage])
  const info = useMemo(() => {
    const map = new Map<number, PinInfo>()
    for (const a of accounts) map.set(a.id, a)
    for (const t of tiles) map.set(t.account_id, t)
    return map
  }, [accounts, tiles])

  // A pin needs a direct role (not a tag viewer) and an active account, and shows once.
  const addable = useMemo(
    () => accounts.filter((a) => a.my_role !== 'tag_viewer' && a.is_active !== false && !draft.includes(a.id)),
    [accounts, draft],
  )
  const groups = useMemo(() => accountPickerGroups(addable), [addable])
  const canAdd = canAddPin(draft.length)

  useEffect(() => {
    const target = focusAfterMove.current
    if (target === null) return
    focusAfterMove.current = null
    document.querySelector<HTMLElement>(`[data-testid="${target}"]`)?.focus()
  })

  const move = (index: number, direction: 'earlier' | 'later') => {
    setDraft((ids) => movePin(ids, index, direction))
    focusAfterMove.current = `quick-balance-move-${direction}-${draft[index]}`
  }

  const submit = async (ids: number[]) => {
    setError(null)
    try {
      await save(ids).unwrap()
      onDone()
    } catch (err) {
      setError(saveError(err))
    }
  }

  return (
    <div data-testid="quick-balances-editor">
      <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
        <p className="text-sm text-body">Choose up to 6 accounts and put them in order.</p>
        <div className="flex flex-wrap gap-2">
          {pinned && (
            <button type="button" data-testid="quick-balances-reset" disabled={saving} onClick={() => void submit([])} className={`${ACTION} bg-sunken text-ink hover:bg-line disabled:opacity-40`}>
              Reset to defaults
            </button>
          )}
          <button type="button" data-testid="quick-balances-cancel" disabled={saving} onClick={onDone} className={`${ACTION} bg-sunken text-ink hover:bg-line disabled:opacity-40`}>
            Cancel
          </button>
          <button type="button" data-testid="quick-balances-save" disabled={saving} onClick={() => void submit(draft)} className={`${ACTION} bg-ink text-paper disabled:opacity-40`}>
            {saving ? 'Saving...' : 'Save'}
          </button>
        </div>
      </div>

      {error !== null && (
        <p className="mb-3 text-sm text-danger" role="alert" data-testid="quick-balances-save-error">{error}</p>
      )}

      <ul className="space-y-2" data-testid="quick-balances-draft">
        {draft.map((id, index) => {
          const account = info.get(id)
          const name = account?.name ?? `Account ${id}`
          return (
            <li key={id} data-testid="quick-balance-edit-row" data-account-id={id} className="flex items-center gap-2">
              <div className="min-w-0 flex-1">
                <p className="text-xs font-semibold uppercase tracking-wide text-muted">{account ? tileGroupLabel(account) : ''}</p>
                <p className="text-sm font-medium text-ink truncate" data-testid="quick-balance-edit-name">{name}</p>
              </div>
              <button type="button" data-testid={`quick-balance-move-earlier-${id}`} aria-label={`Move ${name} earlier`} disabled={index === 0} onClick={() => move(index, 'earlier')} className={ICON_ACTION}>
                <span aria-hidden="true">‹</span>
              </button>
              <button type="button" data-testid={`quick-balance-move-later-${id}`} aria-label={`Move ${name} later`} disabled={index === draft.length - 1} onClick={() => move(index, 'later')} className={ICON_ACTION}>
                <span aria-hidden="true">›</span>
              </button>
              <button type="button" data-testid={`quick-balance-remove-${id}`} aria-label={`Remove ${name}`} onClick={() => setDraft((ids) => ids.filter((x) => x !== id))} className={ICON_ACTION}>
                <span aria-hidden="true">✕</span>
              </button>
            </li>
          )
        })}
      </ul>

      <div className="mt-3 flex flex-wrap items-center gap-3">
        <button
          type="button"
          data-testid="quick-balances-add"
          disabled={!canAdd}
          aria-expanded={adding && canAdd}
          onClick={() => setAdding((open) => !open)}
          className={`${ACTION} border border-line text-ink hover:bg-sunken disabled:opacity-40`}
        >
          + Add account
        </button>
        <span className="text-xs text-muted" data-testid="quick-balances-count">
          {draft.length} of 6{canAdd ? '' : ' (the most you can pin)'}
        </span>
      </div>

      {adding && canAdd && (
        <div className="mt-3 p-3 bg-sunken space-y-3" data-testid="quick-balances-add-panel">
          {groupOptionCount(groups) === 0 ? (
            <p className="text-sm text-muted">No other accounts to add.</p>
          ) : (
            <AddGroups
              groups={groups}
              onPick={(id) => {
                setDraft((ids) => (canAddPin(ids.length) && !ids.includes(id) ? [...ids, id] : ids))
                setAdding(false)
              }}
            />
          )}
        </div>
      )}
    </div>
  )
}

/** The dashboard's quick balances: one tile per account, each a link to its page. Own query, so a failure stays in here. */
export function QuickBalances() {
  const { currencyCode } = useCurrency()
  const { data, isLoading, isError, refetch } = useGetQuickBalancesQuery(undefined, { refetchOnFocus: true })
  const [editing, setEditing] = useState(false)
  const { data: accountsPage } = useGetAccountsQuery({ is_active: true, limit: 1000 })
  const accountsById = useMemo(() => new Map((accountsPage?.items ?? []).map((a) => [a.id, a])), [accountsPage])

  // refetchOnFocus: a tab left open picks up pins another tab or device saved, when it is next focused.
  // A user with no accounts gets no section.
  if (data !== undefined && data.tiles.length === 0) return null

  return (
    <section className="bg-surface border border-line" aria-labelledby="quick-balances-heading" data-testid="quick-balances">
      <div className="p-4 sm:p-6 border-b border-line flex flex-wrap items-center justify-between gap-2">
        <h2 id="quick-balances-heading" className="text-lg font-semibold text-ink">Quick balances</h2>
        {data !== undefined && !isError && !editing && (
          <button type="button" data-testid="quick-balances-edit" onClick={() => setEditing(true)} className={`${ACTION} bg-sunken text-ink hover:bg-line`}>
            Edit
          </button>
        )}
      </div>
      <div className="p-4 sm:p-6">
        {isLoading ? (
          <div className="grid grid-cols-2 lg:grid-cols-3 gap-3" aria-busy="true" data-testid="quick-balances-pending">
            <span role="status" className="sr-only">Loading balances</span>
            <Skeleton tone="strong" className="h-20" />
            <Skeleton tone="strong" className="h-20" />
            <Skeleton tone="strong" className="h-28 col-span-2 lg:col-span-1" />
          </div>
        ) : isError || data === undefined ? (
          <div className="flex flex-wrap items-center gap-3" role="alert" data-testid="quick-balances-error">
            <p className="text-sm text-body">Couldn&apos;t load balances</p>
            <button
              type="button"
              data-testid="quick-balances-retry"
              onClick={() => void refetch()}
              className="min-h-11 px-4 py-2 bg-ink text-paper transition-colors duration-200"
            >
              Retry
            </button>
          </div>
        ) : editing ? (
          <PinEditor tiles={data.tiles} pinned={data.pinned} onDone={() => setEditing(false)} />
        ) : (
          <div className="grid grid-cols-2 lg:grid-cols-3 grid-flow-row-dense lg:grid-flow-row gap-3">
            {data.tiles.map((tile) => {
              const noLimit = tileHasNoLimit(tile, accountsById.get(tile.account_id))
              return <Tile key={tile.account_id} tile={tile} defaultCurrency={currencyCode} noLimit={noLimit} />
            })}
          </div>
        )}
      </div>
    </section>
  )
}
