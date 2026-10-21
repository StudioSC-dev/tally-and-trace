import { availableCreditText, formatEntryDate } from '@tally-trace/shared'
import type { Account, CardCredit, EntryCreditWarning } from '@tally-trace/shared'
import { CreditCheckBadge } from './CreditSummary'

/**
 * What a recurring-kind group shows above its entries:
 * - `ready`: one available-credit line per card;
 * - `ready-error`: the lines, kept from the last good fetch, with a refresh error under them;
 * - `loading` / `error`: no figure at all, only a placeholder or the error;
 * - `hidden`: nothing.
 */
export type KindCreditState = 'ready' | 'ready-error' | 'loading' | 'error' | 'hidden'

interface KindCreditLinesProps {
  cardIds: readonly number[]
  accountsById: ReadonlyMap<number, Account>
  creditByCard: ReadonlyMap<number, CardCredit>
  state: KindCreditState
  onRetry: () => void
}

export function KindCreditLines({ cardIds, accountsById, creditByCard, state, onRetry }: KindCreditLinesProps) {
  if (state === 'hidden') return null
  if (state === 'loading') {
    return (
      <p className="text-xs text-muted" data-testid="kind-credit-loading">Checking available credit…</p>
    )
  }
  const errorCopy =
    state === 'ready-error'
      ? "Couldn't refresh available credit. These figures may be out of date."
      : "Couldn't load available credit."
  const error = (state === 'error' || state === 'ready-error') && (
    <div role="alert" className="flex flex-wrap items-center gap-2" data-testid="kind-credit-error">
      <p className="text-xs text-warn">{errorCopy}</p>
      <button type="button" className="btn-secondary focus-ring" onClick={onRetry}>Retry</button>
    </div>
  )
  if (state === 'error') return error

  return (
    <div className="space-y-1" data-testid="kind-credit-lines">
      {cardIds.map((id) => {
        const credit = creditByCard.get(id)
        const account = accountsById.get(id)
        if (!credit || !account) return null
        const { available, withPlanned } = availableCreditText(credit)
        return (
          <div key={id}>
            <p className="text-sm text-ink" data-testid="kind-credit-line" data-card-id={id}>
              Available credit on {account.name}:{' '}
              <span className="font-semibold" data-testid="kind-credit-available">{available}</span>
            </p>
            {withPlanned && (
              <p className="text-xs text-info" data-testid="kind-credit-with-planned" data-card-id={id}>{withPlanned}</p>
            )}
          </div>
        )
      })}
      {error}
    </div>
  )
}

/** The badge an entry earns for its worst upcoming check, with how many other warnings follow. */
export function EntryCreditWarningRow({ warning }: { warning: EntryCreditWarning }) {
  const { check, more } = warning
  const occurrence = check.occurrence_date ?? check.date
  return (
    <div className="flex flex-wrap items-center gap-2 text-xs" data-testid="entry-credit-warning" data-occurrence={occurrence}>
      <CreditCheckBadge check={check} />
      <span className="text-muted">
        on {formatEntryDate(occurrence)}
        {more > 0 ? ` · ${more} more ${more === 1 ? 'warning' : 'warnings'} in the next 30 days` : ''}
      </span>
    </div>
  )
}
