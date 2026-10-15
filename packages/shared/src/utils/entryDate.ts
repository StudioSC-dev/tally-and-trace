/**
 * Budget-entry dates (`next_occurrence`, `end_date`) are wall time stored as UTC
 * components: the owner's typed 2026-10-30 20:00 is stored and returned as
 * `2026-10-30T20:00:00Z`, whatever the browser's zone. The cutover loader writes
 * the same way. These helpers read and write that contract; never convert a
 * budget-entry date through the browser's local time.
 */

const ZONE_DESIGNATOR = /(?:Z|[+-]\d{2}:?\d{2})$/i
const WALL_TIME_INPUT = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})(?::\d{2}(?:\.\d+)?)?$/

/**
 * A budget-entry date as an instant whose UTC components are the wall time. A
 * string without a zone designator is read as UTC components, not local time.
 */
export function parseEntryDate(value: string | Date): Date {
  if (value instanceof Date) return new Date(value.getTime())
  return new Date(ZONE_DESIGNATOR.test(value) || !value.includes('T') ? value : `${value}Z`)
}

/**
 * A `datetime-local` input value (`YYYY-MM-DDTHH:MM`) as the wire value: the
 * same wall time as UTC components, `YYYY-MM-DDTHH:MM:00Z`.
 */
export function toWireWallTime(input: string): string {
  const match = WALL_TIME_INPUT.exec(input)
  if (!match) throw new RangeError(`Not a date and time: ${input}`)
  return `${match[1]}T${match[2]}:00Z`
}

/** A wire value as a `datetime-local` input value, from its UTC components ('' if unreadable). */
export function fromWireWallTime(wire: string): string {
  const date = parseEntryDate(wire)
  return Number.isNaN(date.getTime()) ? '' : date.toISOString().slice(0, 16)
}

/**
 * The calendar day of a budget-entry date as local midnight, for day arithmetic
 * against the browser's today (relative labels, "days until").
 */
export function entryCalendarDate(wire: string | Date): Date {
  const date = parseEntryDate(wire)
  return new Date(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate())
}

function ordinalSuffix(day: number): string {
  if (day % 100 >= 11 && day % 100 <= 13) return 'th'
  switch (day % 10) {
    case 1:
      return 'st'
    case 2:
      return 'nd'
    case 3:
      return 'rd'
    default:
      return 'th'
  }
}

/** A budget-entry date's calendar day, e.g. "Oct 30th, 2026" ("Invalid date" if unreadable). */
export function formatEntryDate(wire: string | Date): string {
  const date = parseEntryDate(wire)
  if (Number.isNaN(date.getTime())) return 'Invalid date'
  const month = new Intl.DateTimeFormat('en-US', { month: 'short', timeZone: 'UTC' }).format(date)
  const day = date.getUTCDate()
  return `${month} ${day}${ordinalSuffix(day)}, ${date.getUTCFullYear()}`
}
