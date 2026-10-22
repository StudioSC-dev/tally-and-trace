import { LoadingLine } from '../Loading'
import { useState } from 'react'
import { useGetHouseholdMonthlyQuery } from '../../store/api'
import { apiErrorMessage } from '../../utils/apiError'
import { MonthKindBadge, MonthLines } from './MonthLines'
import { formatMonth, shiftMonth, thisMonth } from './format'

const MAX_MONTHS = 36

/** Whole months from `from` to `to`, inclusive. */
const monthSpan = (from: string, to: string): number => {
  const [fy, fm] = from.split('-').map(Number)
  const [ty, tm] = to.split('-').map(Number)
  return ((ty ?? 0) - (fy ?? 0)) * 12 + ((tm ?? 0) - (fm ?? 0)) + 1
}

/** Monthly totals per currency over a range of months (the default: last 2 months and the next 3). */
export function HouseholdMonthlyTab({ sharerId }: { sharerId: number }) {
  const [from, setFrom] = useState(() => shiftMonth(thisMonth(), -2))
  const [to, setTo] = useState(() => shiftMonth(thisMonth(), 3))
  const span = monthSpan(from, to)
  const rangeError =
    !from || !to
      ? 'Choose both months.'
      : span < 1
        ? 'The first month must not be after the last.'
        : span > MAX_MONTHS
          ? `Choose at most ${MAX_MONTHS} months.`
          : null
  const { data, isLoading, error } = useGetHouseholdMonthlyQuery({ sharerId, from, to }, { skip: rangeError !== null })

  return (
    <section className="card p-4 sm:p-5 space-y-4" data-testid="household-monthly">
      <div className="flex flex-wrap items-end gap-3">
        <div>
          <label className="label" htmlFor="household-from">From</label>
          <input
            id="household-from"
            type="month"
            value={from}
            onChange={(event) => setFrom(event.target.value)}
            className="input-field focus-ring"
            data-testid="household-monthly-from"
          />
        </div>
        <div>
          <label className="label" htmlFor="household-to">To</label>
          <input
            id="household-to"
            type="month"
            value={to}
            onChange={(event) => setTo(event.target.value)}
            className="input-field focus-ring"
            data-testid="household-monthly-to"
          />
        </div>
      </div>
      {rangeError && (
        <p className="text-sm text-danger" role="alert" data-testid="household-monthly-range-error">
          {rangeError}
        </p>
      )}
      {!rangeError && isLoading && <LoadingLine>Loading...</LoadingLine>}
      {!rangeError && error && (
        <p className="text-sm text-danger" role="alert">
          {apiErrorMessage(error) || 'Could not load the monthly totals.'}
        </p>
      )}
      {!rangeError && data && (
        <div className="divide-y divide-line border border-line">
          {data.months.map((row) => (
            <div key={row.month} className="space-y-2 px-3 py-3" data-testid="household-month" data-month={row.month}>
              <div className="flex items-center justify-between gap-3">
                <h3 className="text-sm font-semibold text-ink">{formatMonth(row.month)}</h3>
                <MonthKindBadge kind={row.kind} />
              </div>
              <MonthLines row={row} />
            </div>
          ))}
        </div>
      )}
    </section>
  )
}
