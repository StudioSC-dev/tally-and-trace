import type { Allocation } from '@tally-trace/shared'
import { amountClass, formatSigned } from '../utils/amount'
import { budgetFigures, estimateLabel } from '../utils/budgetFigures'
import { BudgetUsageBar } from './BudgetUsageBar'

interface Props {
  allocation: Allocation
  /** Names this block's test ids (`<prefix>-spent`, ...): `card` on the envelope card, `snapshot` in its dialog. */
  prefix: 'card' | 'snapshot'
  /** The spent row's label: the card says "Spent this period", the dialog "Spent". */
  spentLabel: string
}

/**
 * One budget envelope's current-window figures, shown on its card and in its snapshot dialog so the two agree: spent
 * against what is available (limit plus carry-in), a carry line when carry is not zero, and the estimate marker when a
 * rate is missing. An envelope with no limit shows its spent figure and the marker alone. An overspent envelope says
 * "Over by X" in the danger tone with no usage bar; one with nothing available and nothing spent says "0 left".
 */
export function BudgetFigures({ allocation, prefix, spentLabel }: Props) {
  const figures = budgetFigures(allocation)
  const money = (amount: number) => formatSigned(amount, allocation.currency)
  const estimate = estimateLabel(figures)
  const limited = figures.state !== 'unlimited'
  const hook = (name: string) => `${prefix}-${name}`

  return (
    <div className="space-y-2" data-testid={hook('figures')} data-state={figures.state}>
      {limited && figures.limit !== null && (
        <div className="flex items-center justify-between text-sm text-body">
          <span>Spending limit</span>
          <span className="font-medium text-ink" data-testid={hook('limit')}>{money(figures.limit)}</span>
        </div>
      )}
      {limited && figures.carryIn !== 0 && (
        <div className="flex items-center justify-between text-sm text-body">
          <span>{figures.carryIn > 0 ? 'Carried in from last period' : 'Overspending taken from last period'}</span>
          <span className="font-medium text-ink" data-testid={hook('carry')}>{money(figures.carryIn)}</span>
        </div>
      )}
      {limited && figures.carryIn !== 0 && figures.available !== null && (
        <div className="flex items-center justify-between text-sm text-body">
          <span>Available</span>
          <span className="font-medium text-ink" data-testid={hook('available')}>{money(figures.available)}</span>
        </div>
      )}
      <div className="flex items-center justify-between text-sm text-body">
        <span>{spentLabel}</span>
        <span className={`font-semibold ${amountClass('out')}`} data-testid={hook('spent')}>{money(figures.spent)}</span>
      </div>
      {estimate && (
        <p className="text-xs text-warn" data-testid={hook('estimate')}>{estimate}</p>
      )}
      {figures.state === 'within' && figures.available !== null && figures.available > 0 && (
        <>
          <BudgetUsageBar spent={figures.spent} limit={figures.available} />
          <p className="text-right text-xs font-medium text-muted" data-testid={hook('usage')}>
            {Math.min(Math.max(figures.usedPercent ?? 0, 0), 100).toFixed(1)}% of {figures.carryIn !== 0 ? 'available' : 'limit'} used
          </p>
          <div className="flex items-center justify-between text-sm text-body">
            <span>Remaining</span>
            <span className="font-semibold text-ink" data-testid={hook('remaining')}>{money(figures.remaining)}</span>
          </div>
        </>
      )}
      {figures.state === 'over' && (
        <p className="text-sm font-semibold text-danger" data-testid={hook('over')}>
          Over by {money(figures.over)}
        </p>
      )}
      {figures.state === 'zero' && (
        <p className="text-sm font-semibold text-ink" data-testid={hook('zero')}>0 left</p>
      )}
    </div>
  )
}
