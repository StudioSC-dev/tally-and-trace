import type { DayRule, RecurrenceFrequency } from '../types/api'
import { parseEntryDate } from './entryDate'
import { daysInMonth, isMonthFamily, lastWeekday } from './recurrence'

/**
 * The entry form's Day control for a month-family entry: the date's own day
 * (on a legacy row, the legacy schedule), an anchored day of month, or the
 * last-weekday rule.
 */
export type DaySetting =
  | { kind: 'same_as_date' }
  | { kind: 'day'; day: number }
  | { kind: 'last_weekday' }

/** The day fields a budget-entry write sends; an omitted key leaves the server to decide. */
export interface EntryDayFields {
  anchor_day?: number | null
  day_rule?: DayRule | null
}

/** The stored row's fields the day rules read. */
export interface StoredDayRow {
  cadence: RecurrenceFrequency
  next_occurrence: string
  anchor_day?: number | null
  day_rule?: DayRule | null
}

/** The Day control's value for a stored row. */
export function daySettingOf(row: { anchor_day?: number | null; day_rule?: DayRule | null }): DaySetting {
  if (row.day_rule === 'last_weekday') return { kind: 'last_weekday' }
  if (row.anchor_day) return { kind: 'day', day: row.anchor_day }
  return { kind: 'same_as_date' }
}

function sameSetting(a: DaySetting, b: DaySetting): boolean {
  if (a.kind === 'day' && b.kind === 'day') return a.day === b.day
  return a.kind === b.kind
}

/**
 * The day fields the entry form sends (plan STU-315 section 2.5):
 * - create, month family: the chosen field, the other null ("Same as date"
 *   sends the date's day as the anchor);
 * - update with the Day control unchanged from the stored row: neither, so a
 *   legacy row stays legacy and an anchored row whose date moved is kept or
 *   re-anchored by the API;
 * - update with the Day control changed: the new field, the other null;
 * - cadence leaving the month family: both null;
 * - otherwise neither.
 * `nextOccurrence` is the wire value (UTC components).
 */
export function buildEntryDayFields(args: {
  cadence: RecurrenceFrequency
  day: DaySetting
  nextOccurrence: string
  stored?: StoredDayRow | null
}): EntryDayFields {
  const { cadence, day, nextOccurrence, stored } = args
  if (!isMonthFamily(cadence)) {
    return stored && isMonthFamily(stored.cadence) ? { anchor_day: null, day_rule: null } : {}
  }
  if (stored && sameSetting(day, daySettingOf(stored))) return {}
  switch (day.kind) {
    case 'day':
      return { anchor_day: day.day, day_rule: null }
    case 'last_weekday':
      return { anchor_day: null, day_rule: 'last_weekday' }
    case 'same_as_date': {
      if (stored) return { anchor_day: null, day_rule: null }
      const date = parseEntryDate(nextOccurrence)
      return Number.isNaN(date.getTime()) ? {} : { anchor_day: date.getUTCDate(), day_rule: null }
    }
  }
}

/** What the API will store, or the detail it refuses the write with. */
export type ResolvedDayFields =
  | { ok: true; anchor_day: number | null; day_rule: DayRule | null }
  | { ok: false; error: string }

const isoDay = (date: Date) => date.toISOString().slice(0, 10)

/**
 * The day fields the API resolves a write to: a mirror of the backend
 * `resolve_day_fields` (plan section 2.4), so the form can preview the
 * schedule and flag a write the API would refuse. `cadence` and
 * `nextOccurrence` are the row as it will be; `sent` is the day fields the
 * write names (an omitted key is not sent).
 */
export function resolveEntryDayFields(args: {
  cadence: RecurrenceFrequency
  nextOccurrence: string
  sent: EntryDayFields
  stored?: StoredDayRow | null
}): ResolvedDayFields {
  const { cadence, nextOccurrence, sent, stored } = args
  const sentAnchor = 'anchor_day' in sent
  const anchor = sent.anchor_day ?? null
  const sentRule = 'day_rule' in sent
  const rule = sent.day_rule ?? null
  if (anchor !== null && rule !== null) return { ok: false, error: 'Set anchor_day or day_rule, not both' }
  const storedAnchor = stored?.anchor_day ?? null
  const storedRule = stored?.day_rule ?? null
  let mergedRule = sentRule ? rule : storedRule
  if (anchor !== null && !sentRule) mergedRule = null

  if (!isMonthFamily(cadence)) {
    if (anchor !== null || rule !== null) {
      return {
        ok: false,
        error: 'anchor_day and day_rule apply only to monthly, quarterly, semi-annual and annual entries',
      }
    }
    return { ok: true, anchor_day: null, day_rule: null }
  }

  const on = parseEntryDate(nextOccurrence)
  if (Number.isNaN(on.getTime())) return { ok: false, error: 'next_occurrence is not a date' }
  const year = on.getUTCFullYear()
  const month = on.getUTCMonth() + 1
  const day = on.getUTCDate()
  const clamp = (a: number) => Math.min(a, daysInMonth(year, month))

  if (mergedRule === 'last_weekday') {
    const expected = lastWeekday(year, month)
    if (day !== expected.getUTCDate()) {
      return { ok: false, error: `next_occurrence must be the last weekday of its month (${isoDay(expected)})` }
    }
    return { ok: true, anchor_day: null, day_rule: 'last_weekday' }
  }
  if (anchor !== null) {
    if (day !== clamp(anchor)) {
      const expected = new Date(Date.UTC(year, month - 1, clamp(anchor)))
      return { ok: false, error: `next_occurrence must fall on day ${anchor} of its month (${isoDay(expected)})` }
    }
    return { ok: true, anchor_day: anchor, day_rule: null }
  }
  if (sentAnchor) return { ok: true, anchor_day: null, day_rule: null }

  const derived: ResolvedDayFields = { ok: true, anchor_day: day, day_rule: null }
  if (!stored || storedRule !== null || !isMonthFamily(stored.cadence)) return derived
  if (storedAnchor === null) return { ok: true, anchor_day: null, day_rule: null }
  if (parseEntryDate(stored.next_occurrence).getTime() === on.getTime()) {
    return { ok: true, anchor_day: storedAnchor, day_rule: null }
  }
  if (day === clamp(storedAnchor)) return { ok: true, anchor_day: storedAnchor, day_rule: null }
  return derived
}

/**
 * A `datetime-local` value moved onto the Day control's day in the same month
 * (choosing the rule or an anchor fills the date); "Same as date" leaves it.
 * The value is wall time, read and written as UTC components.
 */
export function dateForDaySetting(input: string, day: DaySetting): string {
  if (day.kind === 'same_as_date') return input
  const date = parseEntryDate(input)
  if (Number.isNaN(date.getTime())) return input
  const year = date.getUTCFullYear()
  const month = date.getUTCMonth() + 1
  const target =
    day.kind === 'last_weekday' ? lastWeekday(year, month).getUTCDate() : Math.min(day.day, daysInMonth(year, month))
  date.setUTCDate(target)
  return date.toISOString().slice(0, 16)
}
