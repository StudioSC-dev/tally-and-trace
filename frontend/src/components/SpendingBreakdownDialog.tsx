import { Spinner } from './Loading'
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent } from 'react'
import { createPortal } from 'react-dom'
import {
  buildHouseholdPrivateBreakdown, buildSpendingBreakdown, summaryCurrencies, summaryRange,
} from '@tally-trace/shared'
import type { SpendingDrill } from '@tally-trace/shared'
import { useGetCategoriesQuery, useGetTransactionSummaryQuery } from '../store/api'
import { useSelectedCurrency } from '../hooks/useSelectedCurrency'
import { apiErrorMessage } from '../utils/apiError'
import { formatCurrency } from '../utils/currency'
import type { CurrencyCode } from '../utils/currency'
import { CurrencyControl } from './CurrencyControl'

const FALLBACK_CATEGORY_COLORS = ['#2563eb', '#7c3aed', '#16a34a', '#f97316', '#db2777']
// Rows the list can't be filtered by, and the "Other" slice, are drawn neutral.
const NEUTRAL_COLOR = '#6B7280'

const DONUT_RADIUS = 48
const DONUT_CIRCUMFERENCE = 2 * Math.PI * DONUT_RADIUS

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

interface Props {
  /** The page's date filter as `YYYY-MM-DD`, or '' for an open end. */
  startDate: string
  endDate: string
  tag: number | undefined
  /** Shown under the title, e.g. "October 1st → October 31st"; an open side reads "Any date". */
  rangeLabel: string
  defaultCurrency: CurrencyCode
  /** Called with the list filters the picked row sets: category names and the uncategorized flag. */
  onSelectCategory: (target: SpendingDrill) => void
  onClose: () => void
}

/**
 * Spending by category for the Transactions page's dates and tag, as a donut and a
 * table. A category can be picked to filter the list by its name.
 *
 * Rendered through a portal; while it is open the app root is `inert`, so focus and
 * assistive technology stay inside. The root is made inert, never an ancestor of the
 * dialog, and cleared before focus returns to the control that opened it.
 */
export function SpendingBreakdownDialog({
  startDate, endDate, tag, rangeLabel, defaultCurrency, onSelectCategory, onClose,
}: Props) {
  const titleId = useId()
  const dialogRef = useRef<HTMLDivElement>(null)
  const closeRef = useRef<HTMLButtonElement>(null)
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose

  const range = useMemo(() => summaryRange(startDate, endDate), [startDate, endDate])
  const {
    data: summary, isLoading, isFetching, error, refetch,
  } = useGetTransactionSummaryQuery({ ...range, ...(tag !== undefined ? { tag } : {}) })
  // Colours only: a failure here leaves the breakdown readable with palette colours.
  const { data: categoriesData } = useGetCategoriesQuery({})
  const currencies = useMemo(() => summaryCurrencies(summary), [summary])
  const [currency, setCurrency] = useSelectedCurrency(currencies, defaultCurrency)

  const breakdown = useMemo(() => {
    const row = summary?.by_currency.find((r) => r.currency === currency)
    return buildSpendingBreakdown(row?.category_breakdown ?? {}, categoriesData ?? [])
  }, [summary, currency, categoriesData])
  const household = useMemo(
    () => buildHouseholdPrivateBreakdown(summary?.household_private ?? [], currency, categoriesData ?? []),
    [summary, currency, categoriesData],
  )

  // The opener, read once per instance in a layout effect: that runs before the passive
  // query subscriptions, which can make the screen loader blur it. StrictMode's replay
  // keeps the first value.
  const openerRef = useRef<Element | null>(null)
  useLayoutEffect(() => {
    openerRef.current ??= document.activeElement
  }, [])

  // Focus into the dialog, make the page behind inert, and undo both on close.
  useEffect(() => {
    const opener = openerRef.current instanceof HTMLElement ? openerRef.current : null
    const root = document.getElementById('root')
    root?.setAttribute('inert', '')
    closeRef.current?.focus()
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation()
        onCloseRef.current()
      }
    }
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('keydown', onKey)
      // Inert off first: an inert element can't take focus back.
      root?.removeAttribute('inert')
      opener?.focus()
    }
  }, [])

  const trapTab = useCallback((event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'Tab') return
    const items = Array.from(dialogRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [])
    const first = items[0]
    const last = items[items.length - 1]
    if (!first || !last) return
    const active = document.activeElement
    if (!dialogRef.current?.contains(active)) {
      event.preventDefault()
      first.focus()
    } else if (event.shiftKey && active === first) {
      event.preventDefault()
      last.focus()
    } else if (!event.shiftKey && active === last) {
      event.preventDefault()
      first.focus()
    }
  }, [])

  const format = (amount: number) => formatCurrency(amount, currency)
  const colorFor = (index: number, color: string | undefined, drillable: boolean) =>
    !drillable ? NEUTRAL_COLOR : color ?? FALLBACK_CATEGORY_COLORS[index % FALLBACK_CATEGORY_COLORS.length] ?? NEUTRAL_COLOR

  let body
  if (isLoading) {
    body = (
      <div className="flex justify-center py-12" role="status" aria-label="Loading spending breakdown">
        <Spinner size="md" />
      </div>
    )
  } else if (error) {
    body = (
      <div className="py-8 text-center" role="alert">
        <p className="text-sm text-body">
          {apiErrorMessage(error) || "Couldn't load the spending breakdown."}
        </p>
        <button type="button" onClick={() => void refetch()} className="btn-secondary focus-ring mt-4">
          Retry
        </button>
      </div>
    )
  } else if (breakdown.rows.length === 0 && household.rows.length === 0) {
    body = <p className="py-8 text-center text-sm text-muted">No posted spending in this range.</p>
  } else {
    const main = breakdown.rows.length === 0 ? (
      <p className="py-8 text-center text-sm text-muted">
        No posted spending from your accounts in this range.
      </p>
    ) : (
      <div className={`grid gap-6 lg:grid-cols-[minmax(0,220px)_minmax(0,1fr)] lg:items-center ${isFetching ? 'opacity-60' : ''}`}>
        <div className="flex justify-center">
          <div className="relative h-44 w-44">
            <svg viewBox="0 0 120 120" className="h-full w-full -rotate-90" role="img" aria-label="Spending by category">
              {breakdown.slices.map((slice, index) => {
                const sliceDrill = slice.drill
                const drillable = sliceDrill !== null
                const length = slice.share * DONUT_CIRCUMFERENCE
                return (
                  <circle
                    key={slice.key}
                    cx="60"
                    cy="60"
                    r={DONUT_RADIUS}
                    fill="none"
                    stroke={colorFor(index, slice.color, drillable)}
                    strokeWidth="18"
                    strokeDasharray={`${length} ${DONUT_CIRCUMFERENCE - length}`}
                    strokeDashoffset={-slice.offset * DONUT_CIRCUMFERENCE}
                    className={drillable ? 'cursor-pointer hover:opacity-80' : undefined}
                    onClick={sliceDrill ? () => onSelectCategory(sliceDrill) : undefined}
                  >
                    <title>{`${slice.name}: ${format(slice.amount)}${drillable ? ' (click to filter the list)' : ''}`}</title>
                  </circle>
                )
              })}
            </svg>
            <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-1 px-6 text-center">
              <span className="text-xs uppercase tracking-wide text-muted">Total of the categories shown</span>
              <span className="text-base font-semibold text-ink">{format(breakdown.total)}</span>
            </div>
          </div>
        </div>
        <ul className="divide-y divide-line/50 text-sm">
          {breakdown.rows.map((row, index) => {
            const rowDrill = row.drill
            const color = colorFor(index, row.color, rowDrill !== null)
            const cells = (
              <>
                <span className="flex min-w-0 items-center gap-2">
                  <span className="h-2.5 w-2.5 flex-shrink-0 rounded-full" style={{ backgroundColor: color }} />
                  <span className="truncate font-medium text-ink">{row.name}</span>
                </span>
                <span className="text-right font-medium text-ink">{format(row.amount)}</span>
                <span className="w-14 text-right text-muted">{(row.share * 100).toFixed(1)}%</span>
              </>
            )
            return (
              <li key={row.key}>
                {rowDrill !== null ? (
                  <button
                    type="button"
                    onClick={() => onSelectCategory(rowDrill)}
                    className="focus-ring grid w-full grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-4 py-2 text-left transition-colors hover:bg-sunken/50"
                  >
                    {cells}
                  </button>
                ) : (
                  <div className="grid grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-4 py-2">
                    {cells}
                    <span className="col-span-3 -mt-1 pl-[18px] text-xs text-muted">Can't filter the list by this.</span>
                  </div>
                )}
              </li>
            )
          })}
        </ul>
      </div>
    )
    body = (
      <>
        {main}
        {household.rows.length > 0 && (
          <section className={`mt-6 border-t border-line/50 pt-4 ${isFetching ? 'opacity-60' : ''}`}>
            <h3 className="text-sm font-semibold text-ink">Household: paid from other accounts</h3>
            <p className="mt-1 text-xs text-muted">
              Household-tagged spending a household member paid from their own accounts. Not included in
              the total or chart above; some of it may have been paid with money moved from accounts you see.
            </p>
            <ul className="mt-2 divide-y divide-line/50 text-sm">
              {household.rows.map((row, index) => {
                const rowDrill = row.drill
                const cells = (
                  <>
                    <span className="flex min-w-0 items-center gap-2">
                      <span
                        className="h-2.5 w-2.5 flex-shrink-0 rounded-full"
                        style={{ backgroundColor: colorFor(index, row.color, rowDrill !== null) }}
                      />
                      <span className="truncate font-medium text-ink">{row.name}</span>
                    </span>
                    <span className="text-right font-medium text-ink">{format(row.amount)}</span>
                  </>
                )
                return (
                  <li key={row.key}>
                    {rowDrill !== null ? (
                      <button
                        type="button"
                        onClick={() => onSelectCategory(rowDrill)}
                        className="focus-ring grid w-full grid-cols-[minmax(0,1fr)_auto] items-center gap-4 py-2 text-left transition-colors hover:bg-sunken/50"
                      >
                        {cells}
                      </button>
                    ) : (
                      <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-4 py-2">{cells}</div>
                    )}
                  </li>
                )
              })}
            </ul>
            <div className="mt-1 grid grid-cols-[minmax(0,1fr)_auto] gap-4 border-t border-line/50 py-2 text-sm font-semibold text-ink">
              <span>Total paid from other accounts</span>
              <span className="text-right">{format(household.total)}</span>
            </div>
          </section>
        )}
      </>
    )
  }

  return createPortal(
    <div
      className="fixed inset-0 z-[60] overflow-y-auto bg-black/60 px-4 py-6"
      onClick={onClose}
      data-testid="spending-breakdown-dialog"
    >
      <div className="flex min-h-full items-center justify-center">
        <div
          ref={dialogRef}
          className="w-full max-w-2xl border border-line bg-surface p-4 sm:p-6"
          role="dialog"
          aria-modal="true"
          aria-labelledby={titleId}
          onClick={(event) => event.stopPropagation()}
          onKeyDown={trapTab}
        >
          <div className="flex items-start justify-between gap-4">
            <div>
              <h2 id={titleId} className="text-lg font-semibold text-ink">Spending breakdown</h2>
              <p className="text-sm text-muted">{rangeLabel}</p>
            </div>
            <button
              ref={closeRef}
              type="button"
              onClick={onClose}
              className="btn-secondary focus-ring"
            >
              Close
            </button>
          </div>
          <div className="mt-4">
            <CurrencyControl
              currencies={currencies}
              value={currency}
              onChange={setCurrency}
            />
          </div>
          <div className="mt-4">{body}</div>
          <div className="mt-4 space-y-1 text-xs text-muted">
            <p>Uses only the date range and tag on this page; other filters don't apply.</p>
            <p>
              Posted spending in {currency} only. The filtered list also shows unposted rows, income,
              transfers and other currencies for that category; set Type to Expense to narrow it.
            </p>
            <p>Includes spending from wallets.</p>
            <p>The filtered list also includes Household rows paid from other accounts.</p>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  )
}
