import { useState } from 'react'
import { formatEntryDate, payChoices } from '@tally-trace/shared'
import type { Account, MinimumDueAssumption, StatementDue } from '@tally-trace/shared'
import {
  useClearStatementMinimumMutation,
  useGetCardCreditQuery,
  useSetStatementMinimumMutation,
} from '../store/api'
import { useManilaDay } from '../hooks/useManilaDay'
import { apiErrorMessage, apiErrorStatus } from '../utils/apiError'
import { formatCurrency } from '../utils/currency'
import type { CurrencyCode } from '../utils/currency'
import { CardPayDialog } from './CardPayDialog'
import { CreditSummary } from './CreditSummary'

const STATUS_STYLES: Record<StatementDue['status'], string> = { paid: 'text-ok', overdue: 'text-danger', open: 'text-warn' }

/** Said once under every estimate: the fees no rule can see. */
const FEE_HINT =
  "This estimate leaves out finance, late and overlimit fees, so it may be below your statement's minimum; adjust the floor or enter the statement's figure."

/** What else an estimate could not account for (the fee hint is shown on its own). */
const ASSUMPTION_TEXT: Record<Exclude<MinimumDueAssumption, 'fees_not_itemised'>, string> = {
  annual_fee_not_set: "The card's annual fee isn't set, so its twelfth is left out.",
  floor_not_set_for_currency: "The rule has no floor for this card's currency.",
  installments_linked_only: 'Only installments recorded from a recurring entry count as installments.',
  new_transactions_excluded: 'New purchases are left out of the base, as the rule says.',
  unconverted_lines_left_out: 'Foreign charges with no exchange rate are left out.',
}

/**
 * A credit card's credit and statements on its account page, for its owner or admin:
 * available credit and what it holds, each closed statement with its minimum amount due
 * (entered from the statement, or estimated from the card's rule), the open cycle, and
 * Pay. Closed means closed before Manila's today; the panel refetches when that day
 * turns. Anyone else gets a 404 from the API and the panel renders nothing.
 */
export function CardCreditPanel({ account }: { account: Account }) {
  const { currentData: detail, error, refetch } = useGetCardCreditQuery(account.id)
  const today = useManilaDay(() => {
    void refetch()
  })
  const [paying, setPaying] = useState(false)

  if (apiErrorStatus(error) === 404) return null
  if (error) {
    return (
      <section className="card p-4 sm:p-5 space-y-3" role="alert" data-testid="card-credit-panel-error">
        <p className="text-sm text-danger">{apiErrorMessage(error) || "Could not load this card's credit."}</p>
        <button type="button" className="btn-secondary focus-ring" onClick={() => void refetch()}>
          Retry
        </button>
      </section>
    )
  }
  if (!detail) {
    return (
      <section className="card p-4 sm:p-5" data-testid="card-credit-panel-loading">
        <p className="text-sm text-body">Loading credit…</p>
      </section>
    )
  }

  const currency = detail.currency as CurrencyCode
  const choices = payChoices(detail.statements, today)
  const closed = detail.statements.filter((s) => s.close_date < today).reverse()
  const disabledReason =
    account.is_active === false ? 'This card is inactive' : choices === null ? 'No closed statement yet' : null

  return (
    <section className="card p-4 sm:p-5 space-y-4" data-testid="card-credit-panel">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <h2 className="text-lg font-semibold text-ink">Credit and statements</h2>
        <div className="flex flex-col items-end gap-1">
          <button
            type="button"
            onClick={() => setPaying(true)}
            disabled={disabledReason !== null}
            className="btn-primary focus-ring disabled:opacity-50"
            data-testid="card-pay-open"
          >
            Pay
          </button>
          {disabledReason && (
            <p className="text-xs text-muted" data-testid="card-pay-disabled-reason">{disabledReason}</p>
          )}
        </div>
      </div>

      {detail.credit && (
        <div className="space-y-1">
          <CreditSummary credit={detail.credit} />
          <p className="text-xs text-muted" data-testid="card-credit-opening">
            Owed {formatCurrency(detail.credit.opening.balance_owed, currency)} · pending{' '}
            {formatCurrency(detail.credit.opening.pending_total, currency)} · held for installments{' '}
            {formatCurrency(detail.credit.opening.installment_hold, currency)} · missed months{' '}
            {formatCurrency(detail.credit.opening.missed_total, currency)}
          </p>
        </div>
      )}

      {closed.length === 0 ? (
        <p className="text-sm text-muted" data-testid="card-statements-empty">No closed statement yet.</p>
      ) : (
        <ul className="space-y-2" data-testid="card-statements">
          {closed.map((statement) => (
            <StatementRow key={statement.close_date} cardId={account.id} statement={statement} currency={currency} />
          ))}
        </ul>
      )}

      {detail.open_cycle && (
        <p className="text-sm text-body" data-testid="card-open-cycle">
          Current cycle closes {formatEntryDate(detail.open_cycle.close_date)} · due {formatEntryDate(detail.open_cycle.due_date)}
        </p>
      )}

      {paying && <CardPayDialog cardId={account.id} onClose={() => setPaying(false)} />}
    </section>
  )
}

function StatementRow({ cardId, statement, currency }: { cardId: number; statement: StatementDue; currency: CurrencyCode }) {
  const minimum = statement.minimum_due
  const [editing, setEditing] = useState(false)
  const [value, setValue] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [setMinimum, { isLoading: saving }] = useSetStatementMinimumMutation()
  const [clearMinimum, { isLoading: clearing }] = useClearStatementMinimumMutation()
  const busy = saving || clearing
  const assumptions = minimum.assumptions.filter(
    (a): a is Exclude<MinimumDueAssumption, 'fees_not_itemised'> => a !== 'fees_not_itemised',
  )

  const save = async () => {
    const amount = Number(value)
    if (value.trim() === '' || !Number.isFinite(amount) || amount < 0) {
      setError(`Enter the minimum in ${currency}`)
      return
    }
    setError(null)
    try {
      await setMinimum({ accountId: cardId, closeDate: statement.close_date, data: { amount: Math.round(amount * 100) / 100 } }).unwrap()
      setEditing(false)
      setValue('')
    } catch (caught) {
      setError(apiErrorMessage(caught) || 'Could not save the minimum. Please try again.')
    }
  }

  const clear = async () => {
    setError(null)
    try {
      await clearMinimum({ accountId: cardId, closeDate: statement.close_date }).unwrap()
    } catch (caught) {
      setError(apiErrorMessage(caught) || 'Could not clear the minimum. Please try again.')
    }
  }

  return (
    <li className="border border-line p-3 space-y-1 text-sm" data-testid="card-statement" data-close={statement.close_date}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-ink">
          Closed {formatEntryDate(statement.close_date)} · due {formatEntryDate(statement.due_date)}
        </span>
        <span className="flex items-center gap-2">
          <span
            className="font-semibold text-ink"
            data-testid="card-statement-owed"
            title={statement.incomplete ? 'may be low: some foreign charges have no exchange rate' : undefined}
          >
            {formatCurrency(statement.owed, currency)}
          </span>
          <span className={`text-xs font-semibold capitalize ${STATUS_STYLES[statement.status]}`} data-testid="card-statement-status">
            {statement.status}
          </span>
        </span>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
        {minimum.amount !== null && minimum.source !== 'unavailable' ? (
          <span className="text-body" data-testid="card-statement-minimum">
            Minimum {formatCurrency(minimum.amount, currency)}{' '}
            <span className="text-muted" data-testid="card-statement-minimum-source">
              ({minimum.source === 'statement' ? 'from your statement' : 'estimate'})
            </span>
            {minimum.remaining !== null && minimum.remaining !== minimum.amount && (
              <> · {formatCurrency(minimum.remaining, currency)} left to pay</>
            )}
          </span>
        ) : (
          <span className="text-muted" data-testid="card-statement-minimum">
            {minimum.reason === 'no_rule' ? 'No minimum due rule set for this card' : 'Minimum not available'}
          </span>
        )}
        {!editing && (
          <span className="flex gap-2">
            <button
              type="button"
              onClick={() => {
                setEditing(true)
                setError(null)
              }}
              disabled={busy}
              className="text-xs underline underline-offset-2 text-body hover:text-ink focus-ring disabled:opacity-50"
              data-testid="card-minimum-edit"
            >
              Enter this statement&apos;s minimum
            </button>
            {minimum.source === 'statement' && (
              <button
                type="button"
                onClick={() => void clear()}
                disabled={busy}
                className="text-xs underline underline-offset-2 text-body hover:text-ink focus-ring disabled:opacity-50"
                data-testid="card-minimum-clear"
              >
                {clearing ? 'Clearing…' : 'Clear'}
              </button>
            )}
          </span>
        )}
      </div>

      {editing && (
        <div className="flex flex-wrap items-center gap-2">
          <label className="sr-only" htmlFor={`minimum-${cardId}-${statement.close_date}`}>
            Minimum amount due ({currency})
          </label>
          <input
            id={`minimum-${cardId}-${statement.close_date}`}
            type="number"
            step="0.01"
            min="0"
            value={value}
            onChange={(e) => {
              setValue(e.target.value)
              setError(null)
            }}
            className="input-field focus-ring w-40"
            placeholder="0.00"
            data-testid="card-minimum-input"
          />
          <button type="button" onClick={() => void save()} disabled={busy} className="btn-primary focus-ring disabled:opacity-50" data-testid="card-minimum-save">
            {saving ? 'Saving…' : 'Save'}
          </button>
          <button type="button" onClick={() => setEditing(false)} disabled={busy} className="btn-secondary focus-ring">
            Cancel
          </button>
        </div>
      )}

      {minimum.source === 'estimate' && minimum.assumptions.includes('fees_not_itemised') && (
        <p className="text-xs text-muted" data-testid="card-statement-fee-hint">{FEE_HINT}</p>
      )}
      {minimum.source === 'estimate' && assumptions.length > 0 && (
        <ul className="text-xs text-muted list-disc pl-4" data-testid="card-statement-assumptions">
          {assumptions.map((a) => (
            <li key={a}>{ASSUMPTION_TEXT[a]}</li>
          ))}
        </ul>
      )}
      {error && <p className="text-xs text-danger" role="alert" data-testid="card-minimum-error">{error}</p>}
    </li>
  )
}
