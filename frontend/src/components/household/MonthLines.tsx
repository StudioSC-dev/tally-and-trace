import type { HouseholdMonthRow } from '../../store/api'
import { money } from './format'

const KIND_LABELS: Record<HouseholdMonthRow['kind'], string> = {
  recorded: 'Recorded',
  current: 'Current',
  projected: 'Projected',
}

const LINES = [
  { key: 'income', label: 'Income' },
  { key: 'expense', label: 'Expense' },
  { key: 'fees', label: 'Fees' },
  { key: 'moved_in', label: 'Moved in' },
  { key: 'moved_out', label: 'Moved out' },
  { key: 'paid_from_other_accounts', label: 'Paid from other accounts' },
] as const

/** The month's kind: recorded (posted), current, or projected (from recurring entries and bills). */
export function MonthKindBadge({ kind }: { kind: HouseholdMonthRow['kind'] }) {
  return (
    <span
      className="inline-flex items-center rounded-full border border-line px-2 py-0.5 text-xs text-body"
      data-testid="household-month-kind"
      data-kind={kind}
    >
      {KIND_LABELS[kind]}
    </span>
  )
}

/**
 * One block per currency, never a sum across currencies. A currency appears only when it
 * has a non-zero line; the lines with no amount are left out of its block.
 */
export function MonthLines({ row }: { row: HouseholdMonthRow }) {
  if (row.currencies.length === 0) {
    return <p className="text-sm text-muted" data-testid="household-month-empty">Nothing in this month.</p>
  }
  return (
    <div className="space-y-3">
      {row.currencies.map((block) => (
        <dl
          key={block.currency}
          className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm sm:grid-cols-3"
          data-testid="household-month-currency"
          data-currency={block.currency}
        >
          <dt className="col-span-2 text-xs font-semibold uppercase tracking-wide text-muted sm:col-span-3">
            {block.currency}
          </dt>
          {LINES.filter(({ key }) => block[key] !== 0).map(({ key, label }) => (
            <div key={key} className="flex justify-between gap-2 sm:block" data-testid={`household-line-${key}`}>
              <dt className="text-muted">{label}</dt>
              <dd className="font-semibold text-ink">{money(block[key], block.currency)}</dd>
            </div>
          ))}
        </dl>
      ))}
    </div>
  )
}
