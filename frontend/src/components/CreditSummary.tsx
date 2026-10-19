import { availableCreditText, creditStatusText } from '@tally-trace/shared'
import type { CardCredit, CreditCheck } from '@tally-trace/shared'
import { formatCurrency } from '../utils/currency'

interface Props {
  /** `GET /cards/credit` or `card_charges[i].credit`: owner and admin only. */
  credit: CardCredit
  /** Accounts rows show the headline and the planned-payment flag only. */
  compact?: boolean
}

/**
 * A card's available credit: the headline ("Available ₱X", or "at most" when something
 * is left out), the figure with the counted planned payments, and, in full, what the
 * figure already holds for installments and missed months. A planned payment is a
 * transfer into the card dated after today.
 */
export function CreditSummary({ credit, compact = false }: Props) {
  const { available, withPlanned } = availableCreditText(credit)
  const missedMonths = credit.missed.reduce((sum, item) => sum + item.count, 0)
  const held = credit.opening.installment_hold
  const holds: string[] = []
  if (held > 0) holds.push(`Includes ${formatCurrency(held, credit.currency)} held for installments`)
  if (missedMonths > 0) holds.push(`${missedMonths} missed ${missedMonths === 1 ? 'month' : 'months'}`)

  return (
    <div className={compact ? 'space-y-0.5' : 'space-y-1'} data-testid="credit-summary">
      <p className={compact ? 'text-xs font-medium text-ink' : 'text-sm font-semibold text-ink'} data-testid="credit-available">
        Available {available}
      </p>
      {withPlanned && (
        <p className="text-xs text-info" data-testid="credit-with-planned">{withPlanned}</p>
      )}
      {!compact && holds.length > 0 && (
        <p className="text-xs text-muted" data-testid="credit-held">{holds.join(' · ')}</p>
      )}
      {!compact && !credit.complete && (
        <p className="text-xs text-warn" data-testid="credit-incomplete">
          Some items could not be counted, so the figure is a ceiling.
        </p>
      )}
    </div>
  )
}

const BADGE_CLASS: Record<CreditCheck['status'], string | null> = {
  ok: null,
  installment: null,
  ok_with_planned: 'badge-info',
  at_risk: 'badge-danger',
  unchecked: 'badge-warning',
  incomplete: 'badge-warning',
}

/** The badge a credit check earns: nothing for an ok or an installment (already held). */
export function CreditCheckBadge({ check }: { check: CreditCheck }) {
  const tone = BADGE_CLASS[check.status]
  if (!tone) return null
  return (
    <span className={`${tone} flex-shrink-0`} data-testid="credit-check-badge" data-status={check.status}>
      {creditStatusText(check)}
    </span>
  )
}
