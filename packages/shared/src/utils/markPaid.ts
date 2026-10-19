import type { Account, EntryOccurrence, EntryOccurrences, MaterializeOutcome, OccurrenceOutcome, RecurringKind } from '../types/api'
import { formatEntryDate } from './entryDate'
import { daysInMonth } from './recurrence'
import { wallDay } from './transactionList'

/**
 * Mark paid: which day a payment defaults to, which statement cycle it lands in,
 * and how to read what the materialise endpoints report back. Days are
 * `YYYY-MM-DD` strings and all arithmetic goes through UTC components.
 */

const DAY = /^\d{4}-\d{2}-\d{2}$/

/** The most skipped dates the notice lists before it falls back to a count. */
const SKIPPED_LIST_LIMIT = 5

function pad(value: number): string {
  return String(value).padStart(2, '0')
}

function day(value: string): string {
  return DAY.test(value) ? value : wallDay(value)
}

/**
 * The day a Mark paid dialog opens on. A card installment posts on its occurrence
 * (the statement it falls in is what matters); everything else on the earlier of
 * the occurrence and today, so a future occurrence is never dated ahead.
 */
export function defaultMarkPaidDay(args: {
  kind: RecurringKind | null | undefined
  occurrenceDate: string
  today: string
}): string {
  const occurrence = day(args.occurrenceDate)
  if (args.kind === 'installment') return occurrence
  const today = day(args.today)
  return occurrence < today ? occurrence : today
}

/** A chosen day as the wire value the materialise endpoint takes: `YYYY-MM-DDT00:00:00Z`. */
export function markPaidWireDate(value: string): string {
  if (!DAY.test(value)) throw new RangeError(`Not a calendar day: ${value}`)
  return `${value}T00:00:00Z`
}

/** The card terms a statement cycle is read from. */
export type StatementCycleSettings = Pick<Account, 'billing_cycle_start' | 'due_date' | 'days_until_due_date'>

/** The statement close day of month: `billing_cycle_start`, else the due day less the days until due. */
function closeDayOfMonth(card: StatementCycleSettings): number | null {
  if (card.billing_cycle_start) return card.billing_cycle_start
  if (card.due_date) {
    const anchor = new Date(Date.UTC(2000, 0, Math.min(card.due_date, 31)))
    anchor.setUTCDate(anchor.getUTCDate() - (card.days_until_due_date ?? 21))
    return anchor.getUTCDate()
  }
  return null
}

/**
 * The close day of the statement a day falls in: this month's close when the day
 * is on or before it, else next month's. A close day past a short month's end
 * lands on its last day. null when the card has no cycle settings.
 */
export function statementCycleClose(card: StatementCycleSettings, onDay: string): string | null {
  const closeDay = closeDayOfMonth(card)
  if (closeDay === null) return null
  const target = day(onDay)
  if (!DAY.test(target)) return null
  let year = Number(target.slice(0, 4))
  let month = Number(target.slice(5, 7))
  const close = (y: number, m: number): string => `${y}-${pad(m)}-${pad(Math.min(closeDay, daysInMonth(y, m)))}`
  let result = close(year, month)
  if (target > result) {
    month += 1
    if (month > 12) {
      month = 1
      year += 1
    }
    result = close(year, month)
  }
  return result
}

/** Whether two days fall in one statement. A card with no cycle settings has nothing to warn about, so true. */
export function sameStatementCycle(card: StatementCycleSettings, a: string, b: string): boolean {
  const first = statementCycleClose(card, a)
  const second = statementCycleClose(card, b)
  if (first === null || second === null) return true
  return first === second
}

/**
 * The skipped-occurrences warning, or null when none were skipped. Up to five
 * dates are listed; above that, the count and the oldest date.
 */
export function skippedNotice(skippedCount: number, skipped: readonly string[]): string | null {
  if (skippedCount <= 0) return null
  const noun = skippedCount === 1 ? 'occurrence' : 'occurrences'
  if (skippedCount <= SKIPPED_LIST_LIMIT && skipped.length >= skippedCount) {
    const dates = skipped.slice(0, skippedCount).map(formatEntryDate).join(', ')
    return `Skipping ${skippedCount} earlier ${noun}: ${dates}`
  }
  const oldest = skipped[0]
  return oldest === undefined
    ? `Skipping ${skippedCount} earlier ${noun}`
    : `Skipping ${skippedCount} earlier ${noun}, the oldest on ${formatEntryDate(oldest)}`
}

/** Anything with a case-insensitive `get`, which is what `Headers` is. */
export interface HeaderReader {
  get(name: string): string | null
}

const OUTCOMES: readonly OccurrenceOutcome[] = ['created', 'posted_pending', 'already_posted']

/**
 * The `X-Occurrence-*` headers of a materialise response. Absent headers read as
 * no outcome, no recorded day, nothing skipped; `X-Occurrences-Skipped` is a
 * comma-separated list of days.
 */
export function readMaterializeHeaders(headers: HeaderReader): Omit<MaterializeOutcome, 'transaction'> {
  const outcome = headers.get('X-Occurrence-Outcome')
  const count = Number.parseInt(headers.get('X-Occurrences-Skipped-Count') ?? '', 10)
  const skipped = (headers.get('X-Occurrences-Skipped') ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter((value) => value !== '')
  return {
    outcome: OUTCOMES.find((known) => known === outcome) ?? null,
    recorded: headers.get('X-Occurrence-Recorded'),
    skippedCount: Number.isFinite(count) && count > 0 ? count : 0,
    skipped,
  }
}

/**
 * Whether the dialog offers "Post all due": a non-capped subscription or cash
 * expense in its account's currency with more than one due occurrence unposted.
 * A capped entry is marked paid month by month, whatever its kind.
 */
export function canPostAllDue(args: {
  kind: RecurringKind | null | undefined
  capped: boolean
  sameCurrency: boolean
  due_unposted: number
}): boolean {
  return (
    !args.capped &&
    (args.kind === 'subscription' || args.kind === 'cash') &&
    args.sameCurrency &&
    args.due_unposted > 1
  )
}

/**
 * The oldest and latest due unposted day "Post all due" covers. The server reports them
 * over the whole walk, which the listed occurrences may not reach (the list is truncated);
 * an API that does not send them (undefined) falls back to the listed occurrences.
 * Null when there is none.
 */
export function postAllDueRange(
  listing: Pick<EntryOccurrences, 'oldest_due' | 'latest_due'>,
  listed: readonly EntryOccurrence[],
): { oldest: string; latest: string } | null {
  if (listing.oldest_due !== undefined || listing.latest_due !== undefined) {
    return listing.oldest_due && listing.latest_due ? { oldest: listing.oldest_due, latest: listing.latest_due } : null
  }
  const due = listed.filter((o) => o.due && o.linked !== 'posted')
  const first = due[0]
  const last = due[due.length - 1]
  return first && last ? { oldest: first.occurrence_date, latest: last.occurrence_date } : null
}

/**
 * Whether Mark paid sends `amount`. A foreign entry always does (the charge is asked for).
 * A bill's amount is prefilled and editable, but when its occurrence is already linked to a
 * pending row the server would overwrite that row's recorded amount with the entry's nominal
 * one, so it is sent only when the user edited the field.
 */
export function markPaidSendsAmount(args: {
  needsCharged: boolean
  editableBill: boolean
  linked: EntryOccurrence['linked'] | undefined
  edited: boolean
}): boolean {
  if (args.needsCharged) return true
  if (!args.editableBill) return false
  return args.linked === 'pending' ? args.edited : true
}

/** A run of walked occurrences the listing left out, shown before the listed occurrence on `before`. */
export interface OmittedRun {
  before: string
  count: number
}

const isUnrecorded = (occurrence: EntryOccurrence): boolean => occurrence.linked !== 'posted'

/**
 * Where the listing left walked occurrences out. The server's `omitted_before` marks every
 * run, recorded or not, with its size. An API that does not send it (undefined on every
 * occurrence) falls back to a jump in `skipped_before` larger than the occurrence before it
 * accounts for, which cannot see a fully recorded run; when exactly one run is found
 * there, `omitted` is its exact size.
 */
export function omittedRuns(occurrences: readonly EntryOccurrence[], omitted: number): OmittedRun[] {
  if (occurrences.some((o) => o.omitted_before !== undefined)) {
    return occurrences.flatMap((o) => ((o.omitted_before ?? 0) > 0 ? [{ before: o.occurrence_date, count: o.omitted_before ?? 0 }] : []))
  }
  const runs: OmittedRun[] = []
  occurrences.forEach((occurrence, index) => {
    const previous = occurrences[index - 1]
    if (!previous) return
    const expected = previous.skipped_before + (isUnrecorded(previous) ? 1 : 0)
    const jump = occurrence.skipped_before - expected
    if (jump > 0) runs.push({ before: occurrence.occurrence_date, count: jump })
  })
  const only = runs.length === 1 ? runs[0] : undefined
  if (only && omitted > 0) only.count = omitted
  return runs
}

/**
 * The unrecorded occurrences before the selected one: their number (the server's
 * `skipped_before`) and the dates known, oldest first. The server's `oldest_unrecorded` is
 * the true oldest, which a listing that starts on a recorded prefix does not show; without
 * it (an older API) only the listed unrecorded dates are known.
 */
export function skippedBefore(
  listing: Pick<EntryOccurrences, 'oldest_unrecorded'>,
  occurrences: readonly EntryOccurrence[],
  selected: EntryOccurrence,
): { count: number; dates: string[] } {
  const dates = occurrences
    .filter((o) => o.occurrence_date < selected.occurrence_date && isUnrecorded(o))
    .map((o) => o.occurrence_date)
  const oldest = listing.oldest_unrecorded
  if (oldest && oldest < selected.occurrence_date && !dates.includes(oldest)) dates.unshift(oldest)
  return { count: selected.skipped_before, dates }
}
