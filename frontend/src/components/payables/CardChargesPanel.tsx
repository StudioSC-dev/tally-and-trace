import { useState } from 'react'
import { formatEntryDate, isLimitedEvent } from '@tally-trace/shared'
import type { CardCharges, FullBudgetEntry, FullCharge, LimitedCharge, MissedCharge, SharedFullBudgetEntry } from '@tally-trace/shared'
import { MarkPaidDialog } from '../MarkPaidDialog'
import { estimateText, estimateTitle } from '../../utils/fx'

type EditableEntry = FullBudgetEntry | SharedFullBudgetEntry

interface Props {
  /** `DashboardSnapshot.card_charges`: one section per card the caller holds a direct role on. */
  cards: readonly CardCharges[]
  /** The dashboard's entries by id, so the Mark paid dialog need not look one up. */
  entriesById: ReadonlyMap<number, EditableEntry>
}

/** What the Mark paid dialog opens on. */
type MarkPaidTarget = {
  key: string
  entryId: number
  name: string
  occurrenceDate: string | null
  estimate?: string
  estimated?: boolean
}

const KIND_LABELS: Record<FullCharge['kind'], string> = {
  installment: 'Installment',
  subscription: 'Subscription',
  bill: 'Bill',
  pending: 'Pending',
  advance: 'Cash advance',
}

const chargeKey = (cardId: number, charge: FullCharge | LimitedCharge, index: number): string =>
  isLimitedEvent(charge)
    ? `${cardId}-${charge.public_id}-${index}`
    : `${cardId}-${charge.source}-${charge.source_id}-${charge.date}-${index}`

/** "Oct 18th, 2026", or "Oct 18th, 2026 · was due Oct 12th, 2026" for an overdue one. */
const dayText = (charge: FullCharge | LimitedCharge): string =>
  charge.overdue && charge.original_date
    ? `${formatEntryDate(charge.date)} · was due ${formatEntryDate(charge.original_date)}`
    : formatEntryDate(charge.date)

/**
 * Upcoming charges on each card over the next 30 days: recurring card expenses,
 * unposted card transactions and cash advances, plus any subscription or bill with
 * months nobody recorded. A card's charges reach cash through its statement, so they
 * are listed here rather than as payables; a card with no statement cycle keeps its
 * payables too. No total and no credit figure is shown.
 *
 * Mark paid is offered only on a recurring entry the caller may post. A pending card
 * transaction is posted on the Transactions page, and a charge the caller sees Limited
 * shows its name and day only.
 */
export function CardChargesPanel({ cards, entriesById }: Props) {
  const [markPaid, setMarkPaid] = useState<MarkPaidTarget | null>(null)

  if (cards.length === 0) return null

  const openMissed = (item: MissedCharge) =>
    setMarkPaid({ key: `missed-${item.entry_id}`, entryId: item.entry_id, name: item.name, occurrenceDate: item.oldest })

  const openCharge = (key: string, charge: FullCharge) =>
    setMarkPaid({
      key,
      entryId: charge.source_id,
      name: charge.name,
      occurrenceDate: charge.occurrence_date,
      estimate: estimateText(charge.amount, charge.currency, charge),
      estimated: charge.estimated === true,
    })

  return (
    <div className="bg-surface border border-line" data-testid="card-charges">
      <div className="p-4 sm:p-6 border-b border-line">
        <h2 className="text-lg font-semibold text-ink">Card Charges</h2>
        <p className="text-sm text-muted">Charges on your cards in the next 30 days. They are paid through each card's statement.</p>
      </div>
      <div className="divide-y divide-line">
        {cards.map((card) => (
          <section key={card.account_id} className="p-4 sm:p-6 space-y-3" data-testid="card-charges-card" aria-label={card.account_name}>
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <h3 className="font-medium text-ink" data-testid="card-charges-name">{card.account_name}</h3>
              <span className="text-xs text-muted">
                {card.currency}
                {!card.statement_cycle && <span data-testid="card-charges-no-cycle"> · no statement cycle, also in payables</span>}
              </span>
            </div>

            {card.missed.length > 0 && (
              <ul className="space-y-2" data-testid="card-missed">
                {card.missed.map((item) => (
                  <li key={item.entry_id} className="flex items-start justify-between gap-3" data-testid="card-missed-row">
                    <div>
                      <p className="text-sm font-medium text-ink">{item.name}</p>
                      <p className="text-xs text-warn">
                        {item.count} missed since {formatEntryDate(item.oldest)}
                      </p>
                    </div>
                    {item.can_mark_paid ? (
                      <button
                        type="button"
                        onClick={() => openMissed(item)}
                        disabled={markPaid?.key === `missed-${item.entry_id}`}
                        className="flex-shrink-0 border border-warn px-2.5 py-1 text-xs font-semibold text-warn hover:bg-sunken disabled:opacity-50 transition-colors focus-ring"
                        data-testid="card-missed-button"
                      >
                        {item.count} missed
                      </button>
                    ) : (
                      <span className="flex-shrink-0 text-xs text-muted">{item.count} missed</span>
                    )}
                  </li>
                ))}
              </ul>
            )}

            {card.charges.length > 0 && (
              <ul className="space-y-3" data-testid="card-charges-list">
                {card.charges.map((charge, index) => {
                  const key = chargeKey(card.account_id, charge, index)
                  if (isLimitedEvent(charge)) {
                    return (
                      <li key={key} className="flex items-start justify-between gap-3" data-testid="card-charge-row" data-view="limited">
                        <div>
                          <p className="text-sm font-medium text-ink">{charge.display_name}</p>
                          <p className="text-xs text-muted">
                            {dayText(charge)} · Shared item
                          </p>
                        </div>
                        {charge.overdue && <span className="badge badge-danger flex-shrink-0" data-testid="card-charge-overdue">Overdue</span>}
                      </li>
                    )
                  }
                  return (
                    <li
                      key={key}
                      className="flex items-start justify-between gap-3"
                      data-testid="card-charge-row"
                      data-view={charge.view}
                      data-source={`${charge.source}:${charge.source_id}`}
                    >
                      <div>
                        <p className="text-sm font-medium text-ink">{charge.name}</p>
                        <p className="text-xs text-muted">
                          {dayText(charge)} · <span data-testid="card-charge-kind">{KIND_LABELS[charge.kind]}</span>
                          {charge.overdue && <span className="text-danger" data-testid="card-charge-overdue"> · Overdue</span>}
                        </p>
                      </div>
                      <div className="text-right space-y-1 flex-shrink-0">
                        <p className="text-sm font-semibold text-ink" data-testid="card-charge-amount" title={estimateTitle(charge)}>
                          {estimateText(charge.amount, charge.currency, charge)}
                        </p>
                        {charge.can_mark_paid && charge.source === 'budget_entry' && (
                          <button
                            type="button"
                            onClick={() => openCharge(key, charge)}
                            disabled={markPaid?.key === key}
                            className="inline-flex items-center gap-1 bg-ok px-2.5 py-1 text-xs font-semibold text-paper hover:bg-ok disabled:opacity-50 transition-colors focus-ring"
                            data-testid="card-charge-mark-paid"
                          >
                            Mark paid
                          </button>
                        )}
                      </div>
                    </li>
                  )
                })}
              </ul>
            )}
          </section>
        ))}
      </div>

      {markPaid && (
        <MarkPaidDialog
          entryId={markPaid.entryId}
          name={markPaid.name}
          occurrenceDate={markPaid.occurrenceDate}
          entry={entriesById.get(markPaid.entryId)}
          estimate={markPaid.estimate}
          estimated={markPaid.estimated}
          onClose={() => setMarkPaid(null)}
        />
      )}
    </div>
  )
}
