const cents = (amount: number): number => Math.round(amount * 100)

/** The fill's colour: muted below 80% of the limit, warn up to and including it, danger only above it. Compared in whole cents so float error never moves an envelope across a line. */
export function budgetFillClass(spent: number, limit: number): string {
  const spentCents = cents(spent)
  const limitCents = cents(limit)
  if (spentCents > limitCents) return 'bg-danger'
  if (spentCents * 5 >= limitCents * 4) return 'bg-warn'
  return 'bg-muted'
}
