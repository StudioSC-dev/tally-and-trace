import { useEffect, useRef, useState } from 'react'
import { Link } from '@tanstack/react-router'
import { formatEntryDate, transactionDate, transactionDescription } from '@tally-trace/shared'
import type { Allocation, BudgetPeriod, BudgetTransaction } from '@tally-trace/shared'
import { useGetBudgetPeriodsQuery, useGetBudgetTransactionsQuery } from '../store/api'
import { amountClass, formatAmount, formatSigned } from '../utils/amount'
import { estimateLabel, estimateOf } from '../utils/budgetFigures'
import { Button } from './Button'
import { EmptyState } from './EmptyState'
import { Icon } from './Icon'
import { ListSheet } from './ListSheet'
import { Pager } from './Pager'
import { Row } from './Row'
import { SkeletonRows } from './Loading'
import { StatusText } from './StatusText'

/** Counted transactions per page. */
export const COUNTED_PAGE_SIZE = 10

interface Props {
  allocation: Allocation
  /**
   * Refetches the envelope and puts the fresh copy in the list and in any open dialog; resolves with it, rejects when
   * the read fails. History is not read until it resolves, so a window that rolled over cannot show stale figures.
   */
  refresh: (id: number) => Promise<Allocation>
  onClose: () => void
}

/** A window as dates: its first day to its last (the stored end is exclusive), read from the UTC components. */
const windowLabel = (period: Pick<BudgetPeriod, 'start' | 'end'>): string => {
  const end = new Date(Date.parse(period.end) - 1)
  const last = Number.isNaN(end.getTime()) ? period.end : end.toISOString()
  return `${formatEntryDate(period.start)} to ${formatEntryDate(last)}`
}

/**
 * One envelope's history (STU-798), opened from its snapshot dialog: the last 12 windows, newest first, and the
 * transactions the selected window counts, 10 to a page. The envelope is refetched first; the two history reads
 * wait for it. A failed read shows its error in its own section, never the figures it replaces.
 */
export function BudgetEnvelopeDetail({ allocation, refresh, onClose }: Props) {
  const { id, currency } = allocation
  const money = (amount: number) => formatSigned(amount, currency)
  const [phase, setPhase] = useState<'loading' | 'ready' | 'error'>('loading')
  const [attempt, setAttempt] = useState(0)
  const [selectedStart, setSelectedStart] = useState<string | null>(null)
  const [page, setPage] = useState(1)
  const refreshRef = useRef(refresh)
  refreshRef.current = refresh

  useEffect(() => {
    let current = true
    setPhase('loading')
    refreshRef
      .current(id)
      .then(() => {
        if (current) setPhase('ready')
      })
      .catch(() => {
        if (current) setPhase('error')
      })
    return () => {
      current = false
    }
  }, [id, attempt])

  const ready = phase === 'ready'
  const periodsQuery = useGetBudgetPeriodsQuery(id, { skip: !ready, refetchOnMountOrArgChange: true })
  const periods = ready && !periodsQuery.isError ? periodsQuery.currentData : undefined
  const selected: BudgetPeriod | undefined = periods
    ? periods.find((p) => p.start === selectedStart) ?? periods.find((p) => p.is_current) ?? periods[0]
    : undefined

  const countedQuery = useGetBudgetTransactionsQuery(
    { id, period_start: selected?.start, limit: COUNTED_PAGE_SIZE, offset: (page - 1) * COUNTED_PAGE_SIZE },
    { skip: !ready || !selected, refetchOnMountOrArgChange: true },
  )
  const counted = ready && selected && !countedQuery.isError ? countedQuery.currentData : undefined

  const selectWindow = (start: string) => {
    if (start === selected?.start) return
    setSelectedStart(start)
    setPage(1)
  }

  const row = (transaction: BudgetTransaction) => {
    const description = transactionDescription(transaction) ?? 'Transaction'
    const missingRate = transaction.view === 'full' && transaction.missing_rate
    const credit = transaction.transaction_type === 'credit'
    return (
      <Row
        key={transaction.id}
        kind="counted-transaction"
        data-missing-rate={missingRate ? 'true' : undefined}
        title={
          <Link to="/transactions" search={{ edit: transaction.id }} className="underline-offset-2 hover:underline focus-ring">
            {description}
          </Link>
        }
        status={missingRate ? <StatusText tone="warn" data-testid="counted-missing-rate">Missing rate</StatusText> : undefined}
        meta={<span>{formatEntryDate(transactionDate(transaction))}</span>}
        amount={
          <span className={credit ? amountClass('in') : amountClass('out')}>
            {credit ? formatAmount('in', transaction.amount, transaction.currency) : formatSigned(transaction.amount, transaction.currency)}
          </span>
        }
      />
    )
  }

  return (
    <div className="modal-backdrop fixed inset-0 z-50 overflow-y-auto bg-scrim/60" onClick={onClose}>
      <div className="min-h-full flex items-center justify-center">
        <div
          className="w-full max-w-2xl bg-surface p-6"
          role="dialog"
          aria-modal="true"
          aria-labelledby="budget-detail-title"
          data-testid="budget-detail"
          onClick={(event) => event.stopPropagation()}
        >
          <div className="flex items-start justify-between gap-4">
            <div>
              <h2 id="budget-detail-title" className="text-xl font-semibold text-ink">{allocation.name}</h2>
              <p className="text-sm text-muted">Budget envelope history</p>
            </div>
            <button
              onClick={onClose}
              className="text-muted hover:text-body transition-colors duration-200"
              aria-label="Close envelope history"
            >
              <Icon name="close" />
            </button>
          </div>

          {phase === 'loading' && <SkeletonRows rows={3} className="mt-6" />}

          {phase === 'error' && (
            <div className="mt-6 space-y-3" role="alert" data-testid="budget-detail-error">
              <p className="text-sm text-danger">Could not load this envelope. Its history is hidden until it loads.</p>
              <Button variant="secondary" onClick={() => setAttempt((n) => n + 1)}>Retry</Button>
            </div>
          )}

          {ready && (
            <>
              <section className="mt-6 space-y-3" aria-labelledby="budget-periods-heading" data-testid="budget-periods">
                <h3 id="budget-periods-heading" className="text-sm font-semibold text-body">Periods</h3>
                {periodsQuery.isError && (
                  <div className="space-y-3" role="alert" data-testid="budget-periods-error">
                    <p className="text-sm text-danger">Could not load the periods.</p>
                    <Button variant="secondary" onClick={() => void periodsQuery.refetch()}>Retry</Button>
                  </div>
                )}
                {!periodsQuery.isError && !periods && <SkeletonRows rows={3} />}
                {periods && (
                  <ListSheet>
                    {periods.map((period) => {
                      const estimate = estimateLabel(estimateOf(period))
                      const isSelected = period.start === selected?.start
                      const remaining = period.remaining
                      return (
                        <Row
                          key={period.start}
                          kind="budget-period"
                          data-start={period.start}
                          data-selected={isSelected ? 'true' : 'false'}
                          aria-current={isSelected ? 'true' : undefined}
                          className={isSelected ? 'bg-sunken' : ''}
                          onOpen={() => selectWindow(period.start)}
                          title={windowLabel(period)}
                          wrap
                          badges={
                            <>
                              {period.is_current && <StatusText tone="ok" data-testid="period-current">Current</StatusText>}
                              {period.before_created && <StatusText tone="muted" data-testid="period-before-created">Before created</StatusText>}
                              {period.estimated && <StatusText tone="muted" data-testid="period-estimated">Estimated window</StatusText>}
                            </>
                          }
                          meta={
                            <>
                              <span data-testid="period-spent">Spent {money(period.spent)}</span>
                              {period.available !== null && <span data-testid="period-available">Available {money(period.available)}</span>}
                              {remaining !== null && (
                                <span data-testid="period-remaining" className={remaining < 0 ? amountClass('negative') : undefined}>
                                  {remaining < 0 ? `Over by ${money(-remaining)}` : `Remaining ${money(remaining)}`}
                                </span>
                              )}
                            </>
                          }
                          details={estimate ? [<span key="estimate" className="text-warn" data-testid="period-estimate">{estimate}</span>] : []}
                        />
                      )
                    })}
                  </ListSheet>
                )}
              </section>

              {selected && (
                <section className="mt-6 space-y-3" aria-labelledby="budget-counted-heading" data-testid="budget-counted">
                  <h3 id="budget-counted-heading" className="text-sm font-semibold text-body">
                    Counted transactions
                    <span className="ml-2 font-normal text-muted" data-testid="counted-window">{windowLabel(selected)}</span>
                  </h3>
                  {countedQuery.isError && (
                    <div className="space-y-3" role="alert" data-testid="budget-counted-error">
                      <p className="text-sm text-danger">Could not load the counted transactions.</p>
                      <Button variant="secondary" onClick={() => void countedQuery.refetch()}>Retry</Button>
                    </div>
                  )}
                  {!countedQuery.isError && !counted && <SkeletonRows rows={3} />}
                  {counted && counted.items.length > 0 && (
                    <>
                      <ListSheet data-testid="counted-list">{counted.items.map(row)}</ListSheet>
                      <Pager
                        total={counted.total}
                        page={page}
                        pageSize={COUNTED_PAGE_SIZE}
                        onPage={setPage}
                        label="Counted transactions pages"
                        testId="counted-pager"
                      />
                      <div className="flex items-center justify-between text-sm text-body" data-testid="counted-footer">
                        <span>Total counted</span>
                        <span className={`font-semibold ${amountClass('out')}`} data-testid="counted-total">{money(counted.converted_total)}</span>
                      </div>
                    </>
                  )}
                  {counted && counted.items.length === 0 && (
                    <>
                      <div data-testid="counted-empty">
                        <EmptyState message="No transactions are counted in this period." />
                      </div>
                      <div className="flex items-center justify-between text-sm text-body" data-testid="counted-footer">
                        <span>Spent in this period</span>
                        <span className={`font-semibold ${amountClass('out')}`} data-testid="counted-total">{money(selected.spent)}</span>
                      </div>
                    </>
                  )}
                </section>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  )
}
