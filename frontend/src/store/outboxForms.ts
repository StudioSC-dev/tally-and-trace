// What each outbox form offers in its toasts: where View and Edit go, and how Undo is queued.
// A form missing here still saves in the background; its toasts offer Retry and Discard only.
import type { NewOutboxEntry, OutboxCompletion } from '@tally-trace/shared'
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
export const DUE_ENTRY_FORM = 'due-entry'
/** The outbox form of a card payment from the Due card; its targetId is the card id. */
export const CARD_PAY_FORM = 'card-pay'

/**
 * Queues a Due-card POST (Mark paid, Post all due, Pay card): sent with its own client id as the
 * idempotency key, so Retry after an unknown outcome cannot record it twice.
 */
export function dueAction(form: string, targetId: number, label: string, description: string, url: string, body?: unknown): NewOutboxEntry {
  const clientId = newOutboxId()
  return {
    clientId,
    kind: 'due-action',
    targetId,
    form,
    draft: null,
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
}
