// What each outbox form offers in its toasts: where View and Edit go, and how Undo is queued.
// A form missing here still saves in the background; its toasts offer Retry and Discard only.
import type { NewOutboxEntry, OutboxCompletion, RecurringAction } from '@tally-trace/shared'
import { newOutboxId } from './outbox'

export interface OutboxFormHandlers {
  /** The page that lists the saved row (View) and hosts the form (Edit). */
  path: '/transactions'
  /** The delete that undoes a create, or null when the create named no row. */
  undo?: (completion: OutboxCompletion) => NewOutboxEntry | null
}

/** Tags a transaction save invalidates (as the mutations it replaces did). */
export const TRANSACTION_TAGS = ['Transaction', 'Account', 'Allocation']

/** Queues the delete of a transaction row (the Transactions page's Delete and the toast's Undo). */
export function transactionDelete(id: number, description: string): NewOutboxEntry {
  return {
    clientId: newOutboxId(),
    kind: 'delete',
    targetId: id,
    form: 'transaction',
    draft: null,
    label: `Deleting "${description}"…`,
    description,
    request: { method: 'DELETE', url: `transactions/${id}` },
    tags: TRANSACTION_TAGS,
  }
}

/** Tags a Due-card save invalidates (as Mark paid, Post all due and Pay card did). */
export const DUE_TAGS = ['BudgetEntry', 'Transaction', 'Account', 'Allocation']

/** The outbox form of a recurring entry's Due-card action; its targetId is the entry id. */
export const DUE_ENTRY_FORM = 'due-entry' as const
/** The outbox form of a card payment from the Due card; its targetId is the card id. */
export const CARD_PAY_FORM = 'card-pay' as const

/** What Mark paid (or Post all due) was sent with: Edit on a refusal reopens the dialog with it. */
export interface MarkPaidDraft {
  entryId: number
  name: string
  /** The occurrence it recorded (`YYYY-MM-DD`), or null for Post all due. */
  occurrenceDate: string | null
  /** The action that opened the dialog. */
  action: RecurringAction | null
  /** The typed day, amount and received amount; null where the dialog's default was kept. */
  day: string | null
  amount: string | null
  received: string
}

/** What a card payment was sent with: Edit on a refusal reopens Pay with it. */
export interface CardPayDraft {
  cardId: number
  amount: string
  payerId: number
  paymentDate: string
}

/**
 * Queues a Due-card POST (Mark paid, Post all due, Pay card): sent with its own client id as the
 * idempotency key, so Retry after an unknown outcome cannot record it twice. `draft` is the
 * dialog's input, for Edit after a refusal.
 */
export function dueAction(
  form: typeof DUE_ENTRY_FORM | typeof CARD_PAY_FORM,
  targetId: number,
  label: string,
  description: string,
  url: string,
  draft: MarkPaidDraft | CardPayDraft,
  body?: unknown,
): NewOutboxEntry {
  const clientId = newOutboxId()
  return {
    clientId,
    kind: 'due-action',
    targetId,
    form,
    draft,
    label,
    description,
    request: body === undefined ? { method: 'POST', url } : { method: 'POST', url, body },
    idempotencyKey: clientId,
    tags: DUE_TAGS,
  }
}

export const OUTBOX_FORMS: Record<string, OutboxFormHandlers> = {
  transaction: {
    path: '/transactions',
    undo: (completion) =>
      completion.serverId === undefined ? null : transactionDelete(completion.serverId, completion.description),
  },
  // The Due card's dialogs: Edit reopens them on Transactions (DueAndOverdueSection).
  [DUE_ENTRY_FORM]: { path: '/transactions' },
  [CARD_PAY_FORM]: { path: '/transactions' },
}
