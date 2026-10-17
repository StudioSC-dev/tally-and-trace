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
