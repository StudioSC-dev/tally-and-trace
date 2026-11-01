import type {
  DashboardSnapshot,
  ReviewInstallmentsItem,
  ReviewInstallmentsOutcome,
  ReviewInstallmentsResult,
} from '../types/api'

/** The most installments one batch review takes; the server refuses more. */
export const BATCH_LIMIT = 50

/** Shown while the cap is reached and a further clean row cannot be ticked. */
export const CAP_REASON = `Up to ${BATCH_LIMIT} at a time; review the rest after these`

/** The part of `dueReviewNotice` the selection helpers read. */
export interface ReviewNoticeLike {
  entries: ReadonlyArray<{ entryId: number; clean: boolean }>
}

export type SelectAllState = 'none' | 'some' | 'all' | 'disabled'

/** Clean entry ids in ascending order. */
export function cleanIds(notice: ReviewNoticeLike | null): number[] {
  if (notice === null) return []
  return notice.entries
    .filter((e) => e.clean)
    .map((e) => e.entryId)
    .sort((a, b) => a - b)
}

/** The selection that counts: clean ids of the current notice only, the first BATCH_LIMIT by id. */
export function effectiveSelection(selected: ReadonlySet<number>, notice: ReviewNoticeLike | null): ReadonlySet<number> {
  return new Set(
    cleanIds(notice)
      .filter((id) => selected.has(id))
      .slice(0, BATCH_LIMIT),
  )
}

/** Select all: the first BATCH_LIMIT clean ids by ascending id. */
export function selectAll(notice: ReviewNoticeLike | null): ReadonlySet<number> {
  return new Set(cleanIds(notice).slice(0, BATCH_LIMIT))
}

/** Tick or untick one id. Refuses an id that is not clean and a tick past the cap; returns the same set then. */
export function toggleSelection(
  selected: ReadonlySet<number>,
  id: number,
  notice: ReviewNoticeLike | null,
): ReadonlySet<number> {
  const current = effectiveSelection(selected, notice)
  if (current.has(id)) {
    const next = new Set(current)
    next.delete(id)
    return next
  }
  if (!cleanIds(notice).includes(id)) return selected
  if (current.size >= BATCH_LIMIT) return selected
  const next = new Set(current)
  next.add(id)
  return next
}

/** The Select all checkbox: disabled with no clean row, else none, some or all of the most one batch takes. */
export function selectAllState(selected: ReadonlySet<number>, notice: ReviewNoticeLike | null): SelectAllState {
  const clean = cleanIds(notice).length
  if (clean === 0) return 'disabled'
  const n = effectiveSelection(selected, notice).size
  if (n === 0) return 'none'
  return n >= Math.min(clean, BATCH_LIMIT) ? 'all' : 'some'
}

/** Whether BATCH_LIMIT rows are ticked, so every other clean checkbox is disabled. */
export function atCap(selected: ReadonlySet<number>, notice: ReviewNoticeLike | null): boolean {
  return effectiveSelection(selected, notice).size >= BATCH_LIMIT
}

/** The batch button's text. */
export function reviewSelectedText(n: number): string {
  return `Review selected (${n})`
}

/** The confirm message. */
export function batchConfirmMessage(n: number): string {
  return n === 1 ? '1 installment will start auto-posting.' : `${n} installments will start auto-posting.`
}

/**
 * The payload of a batch review: ticked clean rows of the snapshot in ascending id order, at most BATCH_LIMIT,
 * each with its `clean_review` binding echoed unchanged (the version string is never reparsed or reformatted).
 */
export function reviewBatchItems(
  snapshot: Pick<DashboardSnapshot, 'installment_review'>,
  selected: ReadonlySet<number>,
): ReviewInstallmentsItem[] {
  const seen = new Set<number>()
  const items: ReviewInstallmentsItem[] = []
  const rows = [...snapshot.installment_review].sort((a, b) => a.entry_id - b.entry_id)
  for (const r of rows) {
    if (items.length >= BATCH_LIMIT) break
    if (!selected.has(r.entry_id) || r.clean_review === null || seen.has(r.entry_id)) continue
    seen.add(r.entry_id)
    items.push({
      entry_id: r.entry_id,
      entry_version: r.clean_review.entry_version,
      review_token: r.clean_review.review_token,
    })
  }
  return items
}

export interface BatchFailure {
  entryId: number
  name: string
  text: string
}

const SUCCESS: ReadonlyArray<ReviewInstallmentsOutcome> = ['reviewed', 'replayed']

function failureReason(outcome: ReviewInstallmentsOutcome, detail: string | null): string {
  switch (outcome) {
    case 'changed':
      return 'changed since the list loaded; select it again or use Review'
    case 'not_found':
      return 'you can no longer review it'
    case 'needs_choices':
    case 'blocked':
    case 'failed':
      return detail ?? 'could not be reviewed'
    default:
      return detail ?? 'could not be reviewed'
  }
}

/** The result line and one failure per entry that was not reviewed; names come from the map captured at click time. */
export function batchSummary(
  result: ReviewInstallmentsResult,
  namesById: ReadonlyMap<number, string>,
): { text: string | null; failures: BatchFailure[] } {
  const failures: BatchFailure[] = []
  for (const r of result.results) {
    if (SUCCESS.includes(r.outcome)) continue
    const name = namesById.get(r.entry_id) ?? `Installment ${r.entry_id}`
    failures.push({ entryId: r.entry_id, name, text: `${name}: ${failureReason(r.outcome, r.detail)}` })
  }
  const n = result.reviewed
  return {
    text: n > 0 ? `Auto-post is on for ${n} ${n === 1 ? 'installment' : 'installments'}` : null,
    failures,
  }
}
