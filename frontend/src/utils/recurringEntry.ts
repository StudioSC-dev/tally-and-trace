import type { DayRule } from '@tally-trace/shared'

export const formatCadenceLabel = (value: string) => {
  switch (value) {
    case 'daily':
      return 'Daily'
    case 'weekly':
      return 'Weekly'
    case 'monthly':
      return 'Monthly'
    case 'quarterly':
      return 'Quarterly'
    case 'semi_annual':
      return 'Semi-Annual'
    case 'annual':
      return 'Annual'
    default:
      return value
  }
}

/** "Monthly · last weekday" / "Monthly · day 31"; a legacy entry is just its cadence. */
export const formatScheduleLabel = (
  cadence: string,
  fields: { anchor_day?: number | null; day_rule?: DayRule | null }
) => {
  const cadenceLabel = formatCadenceLabel(cadence)
  if (fields.day_rule === 'last_weekday') return `${cadenceLabel} · last weekday`
  if (fields.anchor_day) return `${cadenceLabel} · day ${fields.anchor_day}`
  return cadenceLabel
}

const ordinal = (day: number) => {
  const tens = day % 100
  if (tens >= 11 && tens <= 13) return `${day}th`
  return `${day}${({ 1: 'st', 2: 'nd', 3: 'rd' } as Record<number, string>)[day % 10] ?? 'th'}`
}

/** The note a card installment shows in place of the cadence and day pickers. */
export const chargedOnCloseLabel = (closeDay: number) =>
  `Charged monthly on each statement close (the ${ordinal(closeDay)})`
