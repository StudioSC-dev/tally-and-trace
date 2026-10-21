import { creditCheckKey, formatEntryDate, isLimitedEvent } from '@tally-trace/shared'
import type { CardCharges, CreditCheck, FullCharge, LimitedCharge, MissedCharge } from '@tally-trace/shared'
import { CreditCheckBadge, CreditSummary } from '../CreditSummary'
import { estimateText, estimateTitle } from '../../utils/fx'

interface Props {
  /** `DashboardSnapshot.card_charges`: one section per card the caller holds a direct role on. */
  cards: readonly CardCharges[]
}

const KIND_LABELS: Record<FullCharge['kind'], string> = {
  installment: 'Installment',
  subscription: 'Subscription',
  bill: 'Bill',
  pending: 'Pending',
  advance: 'Cash advance',
}

/** Missed months nobody has recorded yet: a month with a pending linked row is already Charged. */
const unrecorded = (card: CardCharges): Array<MissedCharge & { oldest_unlinked: string }> =>
  card.missed.filter((m): m is MissedCharge & { oldest_unlinked: string } => m.unlinked_count > 0 && m.oldest_unlinked !== null)

const chargeKey = (cardId: number, charge: FullCharge | LimitedCharge, index: number): string =>
  isLimitedEvent(charge)
    ? `${cardId}-${charge.public_id}-${index}`
    : `${cardId}-${charge.source}-${charge.source_id}-${charge.date}-${index}`

/** The credit check for a charge, keyed on its entry occurrence or its own day. */
const checkFor = (checks: readonly CreditCheck[], charge: FullCharge): CreditCheck | undefined => {
  const key = creditCheckKey({
    source: charge.source,
    source_id: charge.source_id,
    date: charge.original_date ?? charge.date,
    occurrence_date: charge.occurrence_date,
  })
  return checks.find((check) => creditCheckKey(check) === key)
}

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
 * payables too. No total is shown.
 *
 * An owner or admin sees the card's available credit under its name (`credit`, which the
 * API serves to no one else), and a badge on each charge the credit check flags: it would
 * exceed available credit, is fine only with a planned payment, or could not be checked.
 * A card with a limit is listed even with no charges, for that line alone.
 *
 * Read only: occurrences are recorded in the Due and overdue section of the Transactions
 * page. A charge the caller sees Limited shows its name and day only.
 */
export function CardChargesPanel({ cards }: Props) {
  if (cards.length === 0) return null

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

            {card.credit && <CreditSummary credit={card.credit} />}

            {unrecorded(card).length > 0 && (
              <ul className="space-y-2" data-testid="card-missed">
                {unrecorded(card).map((item) => (
                  <li key={item.entry_id} className="flex items-start justify-between gap-3" data-testid="card-missed-row">
                    <div>
                      <p className="text-sm font-medium text-ink">{item.name}</p>
                      <p className="text-xs text-warn" data-testid="card-missed-text">
                        {item.unlinked_count} missed since {formatEntryDate(item.oldest_unlinked)}
                      </p>
                    </div>
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
                  const check = card.credit ? checkFor(card.credit.checks, charge) : undefined
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
                        {check && <CreditCheckBadge check={check} />}
                      </div>
                      <div className="text-right space-y-1 flex-shrink-0">
                        <p className="text-sm font-semibold text-ink" data-testid="card-charge-amount" title={estimateTitle(charge)}>
                          {estimateText(charge.amount, charge.currency, charge)}
                        </p>
                      </div>
                    </li>
                  )
                })}
              </ul>
            )}
          </section>
        ))}
      </div>
    </div>
  )
}
