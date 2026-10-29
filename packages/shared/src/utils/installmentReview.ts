import type {
  InstallmentAutoPostState,
  InstallmentBlockReason,
  InstallmentReview,
  InstallmentReviewInput,
  InstallmentReviewLink,
  InstallmentReviewTransaction,
} from '../types/api'

/**
 * Card installment review and auto-post: labels, the review dialog's choices and the
 * request body. Days are `YYYY-MM-DD`. The server decides every state; nothing here
 * works out what is due or postable.
 */

/** Shown when a blocked installment names no reason the client knows. */
const BLOCKED_FALLBACK = "Doesn't auto-post"

const BLOCKED_LABELS: Record<InstallmentBlockReason, string> = {
  foreign_currency: "Doesn't auto-post: another currency · Mark paid with the amount charged",
  no_statement_cycle: "Doesn't auto-post: the card has no statement cycle · Mark paid",
  creator_no_access: "Doesn't auto-post: its creator can no longer edit this card",
  ambiguous:
    "Doesn't auto-post: a month has more than one linked transaction · resolve them on the Transactions page",
}

/**
 * The label for one installment's auto-post state; null when it has none (not a card
 * installment). `scheduled` is the snapshot's `auto_post_scheduled`: with the daily job set
 * up an installment posts each morning, otherwise when Transactions opens.
 */
export function autoPostLabel(
  state: InstallmentAutoPostState | null,
  scheduled: boolean,
  blockReason: InstallmentBlockReason | null,
): string | null {
  switch (state) {
    case null:
      return null
    case 'unreviewed':
      return 'Review to auto-post'
    case 'on':
      return scheduled ? 'Auto-posts each morning' : 'Auto-posts when you open Transactions'
    case 'held':
      return 'Possible duplicate · Review'
    case 'off':
      return 'Auto-post off · Mark paid'
    case 'blocked':
      return blockReason === null ? BLOCKED_FALLBACK : BLOCKED_LABELS[blockReason]
  }
}

/** One transaction offered for a missed month, and whether the reader may pick it there. */
export interface LinkOption {
  transaction: InstallmentReviewTransaction
  /** Chosen for this month. */
  selected: boolean
  /** Chosen for another month; a transaction can be the charge for one month only. */
  disabled: boolean
}

export interface LinkChoice {
  occurrenceDate: string
  options: LinkOption[]
}

/**
 * The review's candidates per missed month. `selected` maps a month to the transaction
 * chosen for it. A transaction offered under two months can be chosen once: under the
 * other month it is `disabled`.
 */
export function linkChoices(
  review: Pick<InstallmentReview, 'candidates'>,
  selected: Readonly<Record<string, number>>,
): LinkChoice[] {
  return review.candidates.map((c) => ({
    occurrenceDate: c.occurrence_date,
    options: c.transactions.map((transaction) => {
      const chosenHere = selected[c.occurrence_date] === transaction.id
      const chosenElsewhere = Object.entries(selected).some(
        ([date, id]) => date !== c.occurrence_date && id === transaction.id,
      )
      return { transaction, selected: chosenHere, disabled: chosenElsewhere }
    }),
  }))
}

/** `selected` as the POST's links, for months the review lists with that transaction as a candidate, by month. */
function chosenLinks(
  review: Pick<InstallmentReview, 'candidates'>,
  selected: Readonly<Record<string, number>>,
): InstallmentReviewLink[] {
  const used = new Set<number>()
  const links: InstallmentReviewLink[] = []
  for (const c of review.candidates) {
    const id = selected[c.occurrence_date]
    if (id === undefined || used.has(id) || !c.transactions.some((t) => t.id === id)) continue
    used.add(id)
    links.push({ transaction_id: id, occurrence_date: c.occurrence_date })
  }
  return links
}

/**
 * The review POST's body: the binding fields exactly as the GET returned them, and the
 * chosen links by month.
 */
export function reviewBody(
  review: Pick<InstallmentReview, 'entry_version' | 'review_token' | 'candidates'>,
  selected: Readonly<Record<string, number>> = {},
): InstallmentReviewInput {
  return {
    entry_version: review.entry_version,
    review_token: review.review_token,
    links: chosenLinks(review, selected),
  }
}

/** The dialog's button: it names how many months it records, or just turns auto-post on. */
export function reviewButtonText(review: Pick<InstallmentReview, 'missed'>): string {
  const n = review.missed.length
  if (n === 0) return 'Turn on auto-post'
  return `Record ${n} ${n === 1 ? 'month' : 'months'} and turn on auto-post`
}

/** The dialog's note on budget figures; only the creator may be told which envelope. */
export function envelopeNote(review: Pick<InstallmentReview, 'envelope'>): string {
  if (review.envelope === null) return 'Recording past months can change budget figures for those periods'
  return `Recording past months changes ${review.envelope.allocation_name}'s figures for those periods`
}
