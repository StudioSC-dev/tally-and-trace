import { Link } from '@tanstack/react-router'
import { tileGroupLabel, tileLines } from '@tally-trace/shared'
import type { QuickBalanceTile, TileLine } from '@tally-trace/shared'
import { useGetQuickBalancesQuery } from '../store/api'
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

function Tile({ tile, defaultCurrency }: { tile: QuickBalanceTile; defaultCurrency: string }) {
  const lines = tileLines(tile)
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

/** The dashboard's quick balances: one tile per account, each a link to its page. Own query, so a failure stays in here. */
export function QuickBalances() {
  const { currencyCode } = useCurrency()
  const { data, isLoading, isError, refetch } = useGetQuickBalancesQuery()

  // A user with no accounts gets no section.
  if (data !== undefined && data.tiles.length === 0) return null

  return (
    <section className="bg-surface border border-line" aria-labelledby="quick-balances-heading" data-testid="quick-balances">
      <div className="p-4 sm:p-6 border-b border-line">
        <h2 id="quick-balances-heading" className="text-lg font-semibold text-ink">Quick balances</h2>
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
        ) : (
          <div className="grid grid-cols-2 lg:grid-cols-3 grid-flow-row-dense lg:grid-flow-row gap-3">
            {data.tiles.map((tile) => (
              <Tile key={tile.account_id} tile={tile} defaultCurrency={currencyCode} />
            ))}
          </div>
        )}
      </div>
    </section>
  )
}
