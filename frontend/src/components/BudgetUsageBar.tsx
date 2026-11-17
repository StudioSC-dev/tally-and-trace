interface Props {
  /** What the envelope has spent, and its limit (above zero), in the same currency. */
  spent: number
  limit: number
}

/** The fill's colour: muted below 80% of the limit, warn up to and including it, danger only above it. */
function budgetFillClass(spent: number, limit: number): string {
  if (spent > limit) return 'bg-danger'
  // Compared as integers of the limit (spent >= 80% of limit) so 80% exactly is never lost to float rounding.
  if (spent * 5 >= limit * 4) return 'bg-warn'
  return 'bg-muted'
}

/**
 * A Budget Envelope's usage bar. The track is `sunken` at every level; the spent fill is red only when the envelope
 * is over its limit. The width is clamped to the track, but the colour reads the real figures, not the clamped width.
 */
export function BudgetUsageBar({ spent, limit }: Props) {
  const width = Math.min(Math.max((spent / limit) * 100, 0), 100)

  return (
    <div className="relative w-full overflow-hidden h-2 rounded-full transition-colors duration-300 bg-sunken" data-testid="budget-usage-track">
      {width > 0 && (
        <div
          className={`absolute right-0 top-0 h-full transition-all duration-300 ${budgetFillClass(spent, limit)}`}
          style={{ width: `${width}%` }}
          data-testid="budget-usage-fill"
        />
      )}
    </div>
  )
}
