// The cadence and schedule labels live with the shared schedule draft (scheduleDraft.ts).
export { formatCadenceLabel, formatScheduleLabel } from '@tally-trace/shared'

const ordinal = (day: number) => {
  const tens = day % 100
  if (tens >= 11 && tens <= 13) return `${day}th`
  return `${day}${({ 1: 'st', 2: 'nd', 3: 'rd' } as Record<number, string>)[day % 10] ?? 'th'}`
}

/** The note a card installment shows in place of the cadence and day pickers. */
export const chargedOnCloseLabel = (closeDay: number) =>
  `Charged monthly on each statement close (the ${ordinal(closeDay)})`
