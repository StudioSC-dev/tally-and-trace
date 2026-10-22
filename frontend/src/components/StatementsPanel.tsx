import { LoadingLine } from './Loading'
import { useGetAccountStatementsQuery } from '../store/api'
import type { Account } from '../store/api'
import { formatCurrency, CurrencyCode } from '../utils/currency'
import { estimateText, estimateTitle, formatCoded } from '../utils/fx'
import type { EstimateLabels } from '../utils/fx'

/** A calendar date (YYYY-MM-DD, or an ISO datetime) shown without a timezone shift. */
const formatDay = (value: string): string => {
  const [year, month, day] = value.slice(0, 10).split('-').map(Number)
  return new Date(year ?? 1970, (month ?? 1) - 1, day ?? 1).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  })
}

/** A full line may carry the estimate labels; a limited one never does. */
const lineLabels = (line: object): EstimateLabels => ('original_amount' in line ? (line as EstimateLabels) : {})

const STATUS_STYLES = { paid: 'text-ok', overdue: 'text-danger', open: 'text-warn' } as const

/**
 * A credit card's statements, newest first. An editor or above gets the full statements; a
 * viewer gets the limited ones (dates, amount due and lines with their neutral
 * descriptions). Both render here from the fields they share.
 */
export function StatementsPanel({ account }: { account: Account }) {
  const { data, isLoading, isError } = useGetAccountStatementsQuery(account.id)
  const currency = account.currency as CurrencyCode

  if (isLoading) return <LoadingLine size="xs">Loading statements...</LoadingLine>
  if (isError || !data) return <p className="text-xs text-muted">Statements unavailable.</p>
  if (data.statements.length === 0) return <p className="text-xs text-muted">No statements yet.</p>

  const statements = [...data.statements].reverse()

  return (
    <div className="space-y-2" data-testid="statements-panel">
      <h3 className="text-sm font-semibold text-body">Statements</h3>
      {statements.map((statement) => (
        <details key={statement.close_date} className="border border-line p-3" data-testid="statement">
          <summary className="flex cursor-pointer flex-wrap items-center justify-between gap-2 text-sm">
            <span className="text-ink">
              Closes {formatDay(statement.close_date)} · due {formatDay(statement.due_date)}
            </span>
            <span className="flex items-center gap-2">
              <span className="font-semibold text-ink">{formatCurrency(statement.amount_due, currency)}</span>
              <span className={`text-xs font-semibold capitalize ${STATUS_STYLES[statement.status]}`}>
                {statement.status}
              </span>
            </span>
          </summary>
          {statement.lines.length === 0 ? (
            <p className="mt-2 text-xs text-muted">No charges in this statement.</p>
          ) : (
            <ul className="mt-2 divide-y divide-line text-xs">
              {statement.lines.map((line, index) => (
                <li key={index} className="flex justify-between gap-3 py-1">
                  <span className="text-body">
                    {formatDay(line.date)} · {line.display_description ?? 'Charge'}
                  </span>
                  <span className="text-ink" title={estimateTitle(lineLabels(line))}>{estimateText(line.amount, currency, lineLabels(line))}</span>
                </li>
              ))}
            </ul>
          )}
          {'unconverted_lines' in statement && statement.unconverted_lines.length > 0 && (
            <div className="mt-2 text-xs text-warn" data-testid="statement-unconverted">
              <p>Left out of this statement's total (no exchange rate yet):</p>
              <ul className="divide-y divide-line">
                {statement.unconverted_lines.map((line) => (
                  <li key={line.transaction_id} className="flex justify-between gap-3 py-1">
                    <span>{formatDay(line.date)} · {line.display_description ?? 'Charge'}</span>
                    <span>{formatCoded(line.original_amount, line.original_currency)}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {statement.incomplete && (
            <p className="mt-2 text-xs text-warn">Some charges are left out because no exchange rate is stored, so this total is incomplete.</p>
          )}
        </details>
      ))}
    </div>
  )
}
