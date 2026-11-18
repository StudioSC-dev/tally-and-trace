import { formatEntryDate } from '@tally-trace/shared'
import type { CloseDayDue, CloseDayReport } from '@tally-trace/shared'

/** A day of the month as "14th". */
export function ordinalDay(n: number): string {
  const rest = n % 100
  const suffix = rest >= 11 && rest <= 13 ? 'th' : n % 10 === 1 ? 'st' : n % 10 === 2 ? 'nd' : n % 10 === 3 ? 'rd' : 'th'
  return `${n}${suffix}`
}

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`

/** The report as short sentences, grouped for the confirm step. No amounts: the report has none. */
export interface CloseDaySummary {
  /** The old and the new closing day. */
  headline: string
  /** One line per installment: its next charge date before and after. */
  installments: string[]
  /** Charges that keep their date but move to another statement. */
  keptDate: string[]
  /** Printed dues and minimum dues that move to the new close. */
  dues: string[]
  /** Closed statements that would hold other charges. */
  history: string[]
}

const day = (value: string | null): string => (value ? formatEntryDate(value) : 'none')

function dueLine(kind: string, due: CloseDayDue): string {
  return `The ${kind} for the statement closing ${formatEntryDate(due.old_close)} moves to the one closing ${formatEntryDate(due.new_close)}.`
}

export function summariseCloseDay(report: CloseDayReport): CloseDaySummary {
  const headline =
    report.old_close_day == null
      ? `The closing day will be the ${ordinalDay(report.new_close_day)}.`
      : `The closing day moves from the ${ordinalDay(report.old_close_day)} to the ${ordinalDay(report.new_close_day)}.`
  const installments = report.entries.map((entry) => {
    const name = `Installment #${entry.entry_id}`
    if (entry.old_next_occurrence == null && entry.new_next_occurrence == null) return `${name}: it has no next charge.`
    return entry.old_next_occurrence === entry.new_next_occurrence
      ? `${name}: the next charge stays on ${day(entry.old_next_occurrence)}.`
      : `${name}: the next charge moves from ${day(entry.old_next_occurrence)} to ${day(entry.new_next_occurrence)}.`
  })
  const keptDate = report.entries.flatMap((entry) => {
    const kept = entry.rows.filter((row) => row.date_kept).length
    if (kept === 0) return []
    return [`Installment #${entry.entry_id}: ${plural(kept, 'charge keeps its date but moves', 'charges keep their dates but move')} to another statement.`]
  })
  const dues = [
    ...report.printed_dues.map((due) => dueLine('printed due date', due)),
    ...report.minimum_dues.map((due) => dueLine('minimum due', due)),
  ]
  const history = report.past_statements.map(
    (s) =>
      `The statement that closed ${formatEntryDate(s.old_close)} would close ${formatEntryDate(s.new_close)}: ` +
      `${plural(s.moved_in.length, 'charge moves', 'charges move')} in and ${s.moved_out.length} out.`,
  )
  return { headline, installments, keptDate, dues, history }
}

/**
 * True when no installment, printed due or minimum due moves with the day. Past statements
 * are not counted: a card the PUT already accepts keeps its plain save.
 */
export function movesNothing(report: CloseDayReport): boolean {
  return report.entries.length === 0 && report.printed_dues.length === 0 && report.minimum_dues.length === 0
}

/** Past statements would change: the user has to say they understand before applying. */
export function needsHistoryAck(report: CloseDayReport): boolean {
  return report.past_statements.length > 0
}

/**
 * What the account form does with a dry run's report: save through the PUT as before when no
 * installment, printed due or minimum due moves (whether or not it was refused, and whatever
 * past statements say), else show the refusal's reasons or open the confirm step.
 */
export function stepAfterCheck(report: CloseDayReport): 'plain' | 'refused' | 'review' {
  if (movesNothing(report)) return 'plain'
  return report.refused ? 'refused' : 'review'
}

/**
 * The report inside a refused call's error: the route answers 409 with the report itself
 * (`refused` true), not `{detail}`. Null for any other failure.
 */
export function closeDayRefusal(error: unknown): CloseDayReport | null {
  const failure = error as { status?: unknown; data?: unknown } | undefined
  if (failure?.status !== 409 || typeof failure.data !== 'object' || failure.data === null) return null
  const body = failure.data as Partial<CloseDayReport>
  return body.refused === true && Array.isArray(body.reasons) ? (body as CloseDayReport) : null
}

/**
 * Whether saving this edit changes a stored closing day: a card the caller can edit the
 * settings of, with a closing day now and a different one in the form. A card with none stored
 * (or only the legacy due day) saves through the PUT as before.
 */
export function closeDayChanged(
  account: { account_type: string; billing_cycle_start?: number | null; permissions: { can_edit_settings: boolean } },
  form: { account_type: string; billing_cycle_start?: number },
): boolean {
  return (
    account.permissions.can_edit_settings &&
    account.account_type === 'credit' &&
    form.account_type === 'credit' &&
    account.billing_cycle_start != null &&
    form.billing_cycle_start != null &&
    form.billing_cycle_start !== account.billing_cycle_start
  )
}
