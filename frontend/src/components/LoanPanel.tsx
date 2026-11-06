import { LoadingLine } from './Loading'
import { useState } from 'react'
import { movedText, RECORD_DATE_MIN, recordDateError, recordDateMax } from '@tally-trace/shared'
import {
  Account,
  useGetLoanScheduleQuery,
  useRecordLoanPaymentMutation,
  useRecordLoanPrepaymentMutation,
} from '../store/api'
import { formatCurrency, CurrencyCode } from '../utils/currency'
import { ForceDateDialog } from './ForceDateDialog'
import { SettlementControl } from './SettlementControl'
import type { ForceDateTarget } from './ForceDateDialog'

/** A calendar date (YYYY-MM-DD) shown without a timezone shift. */
const formatDueDate = (value: string): string => {
  const [year, month, day] = value.slice(0, 10).split('-').map(Number)
  return new Date(year ?? 1970, (month ?? 1) - 1, day ?? 1).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  })
}

const todayInput = (): string => {
  const now = new Date()
  const month = String(now.getMonth() + 1).padStart(2, '0')
  const day = String(now.getDate()).padStart(2, '0')
  return `${now.getFullYear()}-${month}-${day}`
}

const errorMessage = (error: unknown): string => {
  const detail = (error as { data?: { detail?: unknown } } | undefined)?.data?.detail
  return typeof detail === 'string' ? detail : 'Could not save the payment. Try again.'
}

/** Owed, payments left and next due for a loan account, from GET loan-schedule. */
export function LoanSummary({ account }: { account: Account }) {
  const { data: schedule, isLoading, isError } = useGetLoanScheduleQuery(account.id)
  const currency = account.currency as CurrencyCode

  if (isLoading) return <LoadingLine size="xs">Loading loan details...</LoadingLine>
  if (isError || !schedule) return <p className="text-xs text-muted">Loan details unavailable.</p>

  return (
    <dl className="grid grid-cols-3 gap-3 text-xs">
      <div>
        <dt className="text-muted">Owed</dt>
        <dd className="mt-1 text-sm font-semibold text-danger">{formatCurrency(schedule.owed, currency)}</dd>
      </div>
      <div>
        <dt className="text-muted">Payments left</dt>
        <dd className="mt-1 text-sm font-semibold text-ink">{schedule.payments_left ?? 'Open-ended'}</dd>
      </div>
      <div>
        <dt className="text-muted">Next due</dt>
        <dd className="mt-1 text-sm font-semibold text-ink">
          {schedule.next_due_date
            ? schedule.view === 'full' && schedule.next_due_effective_date && schedule.next_due_effective_date !== schedule.next_due_date
              ? formatDueDate(schedule.next_due_effective_date)
              : formatDueDate(schedule.next_due_date)
            : 'Not set'}
        </dd>
      </div>
    </dl>
  )
}

/**
 * Autopay or manual for a loan. The flag is an owner's or admin's: an editor's schedule
 * carries it as null (and the API answers 404), so the control is not rendered for them.
 */
export function LoanSettlement({ account }: { account: Account }) {
  const { data: schedule } = useGetLoanScheduleQuery(account.id)
  if (schedule?.view !== 'full' || schedule.settlement == null) return null
  return <SettlementControl subject={{ kind: 'loan', id: account.id, name: account.name }} settlement={schedule.settlement} />
}

/** How many open due dates the loan page lists. */
const DUE_DATES_SHOWN = 3

/**
 * The loan's next open due dates, each with Change date for an owner, admin or editor (the
 * ones who get the full schedule; a viewer's rows already carry the forced date and no
 * action). A loan has no row in the Transactions "Due and overdue" card, so this is where its
 * due dates are moved. The scheduled day stays the due date's identity: a moved one reads
 * "(moved from ...)", and Clear in the dialog puts it back.
 */
export function LoanDueDates({ account }: { account: Account }) {
  const { data: schedule } = useGetLoanScheduleQuery(account.id)
  const [target, setTarget] = useState<ForceDateTarget | null>(null)
  const currency = account.currency as CurrencyCode
  if (!schedule) return null

  const rows =
    schedule.view === 'full'
      ? schedule.upcoming.slice(0, DUE_DATES_SHOWN).map((row) => ({
          day: row.due_date,
          effective: row.effective_date ?? row.due_date,
          amount: row.payment,
        }))
      : schedule.rows
          .filter((row) => row.status === 'open')
          .slice(0, DUE_DATES_SHOWN)
          .map((row) => ({ day: row.due_date, effective: row.due_date, amount: row.amount }))
  if (rows.length === 0) return null
  const canChange = schedule.view === 'full'

  return (
    <div data-testid="loan-due-dates">
      <h3 className="text-sm font-semibold text-ink">Next due dates</h3>
      <ul className="mt-2 divide-y divide-line border border-line">
        {rows.map((row) => (
          <li key={row.day} className="flex items-center justify-between gap-3 px-3 py-2 text-sm" data-testid="loan-due-date" data-day={row.day}>
            <div>
              <p className="text-ink" data-testid="loan-due-date-text">{movedText(row.day, row.effective)}</p>
              {row.amount != null && <p className="text-xs text-muted">{formatCurrency(row.amount, currency)}</p>}
            </div>
            {canChange && (
              <button
                type="button"
                onClick={() => setTarget({ kind: 'loan', id: account.id, name: account.name, occurrenceDate: row.day, effectiveDate: row.effective })}
                className="btn-secondary focus-ring"
                data-testid="loan-change-date"
              >
                Change date
              </button>
            )}
          </li>
        ))}
      </ul>
      {target && (
        <ForceDateDialog
          key={target.occurrenceDate}
          target={target}
          onClose={() => setTarget(null)}
        />
      )}
    </div>
  )
}

type Mode = 'payment' | 'prepayment' | null

/**
 * Record payment (principal / interest are optional overrides of the proposed
 * split) and Extra principal (a fixed loan follows the bank's schedule, so it
 * has none) for a loan account.
 */
export function LoanActions({
  account,
  fundingAccounts,
  onRecorded,
}: {
  account: Account
  fundingAccounts: Account[]
  onRecorded?: () => void
}) {
  const { data: scheduleResponse } = useGetLoanScheduleQuery(account.id)
  // Only an editor or above gets the full schedule, and only an owner or admin gets its
  // terms: an editor's has no amortisation or split, so the API decides extra principal.
  const schedule = scheduleResponse?.view === 'full' ? scheduleResponse : undefined
  // A loan is paid only from an account in its own currency (the API refuses others).
  const eligibleFunding = fundingAccounts.filter((a) => a.currency === account.currency)
  const defaultFunding = eligibleFunding.some((a) => a.id === account.payment_account_id)
    ? account.payment_account_id ?? undefined
    : undefined
  const [recordPayment, { isLoading: isPaying }] = useRecordLoanPaymentMutation()
  const [recordPrepayment, { isLoading: isPrepaying }] = useRecordLoanPrepaymentMutation()
  const [mode, setMode] = useState<Mode>(null)
  const [error, setError] = useState<string | null>(null)
  const [form, setForm] = useState({
    amount: '',
    principal: '',
    interest: '',
    from_account_id: defaultFunding as number | undefined,
    date: todayInput(),
    is_posted: true,
  })
  const isFixed = schedule?.amortization === 'fixed'
  const currency = account.currency as CurrencyCode

  const open = (next: Exclude<Mode, null>) => {
    setError(null)
    setForm({
      amount: '',
      principal: '',
      interest: '',
      from_account_id: defaultFunding,
      date: todayInput(),
      is_posted: true,
    })
    setMode(next)
  }

  const optionalNumber = (value: string) => (value.trim() === '' ? undefined : Number(value))

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault()
    setError(null)
    const dateError = recordDateError(form.date)
    if (dateError) {
      setError(dateError)
      return
    }
    const common = {
      from_account_id: form.from_account_id,
      transaction_date: form.date ? `${form.date}T00:00:00` : undefined,
      is_posted: form.is_posted,
    }
    try {
      if (mode === 'prepayment') {
        await recordPrepayment({
          id: account.id,
          data: { ...common, amount: Number(form.amount) },
        }).unwrap()
      } else {
        await recordPayment({
          id: account.id,
          data: {
            ...common,
            amount: optionalNumber(form.amount),
            principal: optionalNumber(form.principal),
            interest: optionalNumber(form.interest),
          },
        }).unwrap()
      }
      setMode(null)
      onRecorded?.()
    } catch (err) {
      setError(errorMessage(err))
    }
  }

  const proposed = schedule?.proposed_split

  return (
    <div className="space-y-3 border border-line p-4">
      <div className="flex flex-wrap gap-3">
        <button type="button" onClick={() => open('payment')} className="btn-primary focus-ring">
          Record payment
        </button>
        <button
          type="button"
          onClick={() => open('prepayment')}
          disabled={!schedule || isFixed}
          title={isFixed ? 'A fixed loan follows the bank’s schedule: no extra principal' : undefined}
          className="btn-secondary focus-ring disabled:opacity-50"
        >
          Extra principal
        </button>
      </div>
      {isFixed && (
        <p className="text-xs text-muted">Extra principal is not available on a fixed loan.</p>
      )}

      {mode && (
        <form onSubmit={handleSubmit} className="space-y-4">
          <h3 className="text-sm font-semibold text-ink">
            {mode === 'payment' ? 'Record payment' : 'Extra principal'}
          </h3>
          <div>
            <label className="label">{mode === 'payment' ? 'Total amount (optional)' : 'Amount'}</label>
            <input
              type="number"
              step="0.01"
              min="0"
              value={form.amount}
              onChange={(e) => setForm({ ...form, amount: e.target.value })}
              className="input-field focus-ring"
              placeholder={
                mode === 'payment' && account.loan_payment_amount != null
                  ? String(account.loan_payment_amount)
                  : '0.00'
              }
              required={mode === 'prepayment'}
            />
          </div>
          {mode === 'payment' && (
            <>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="label">Principal (optional)</label>
                  <input
                    type="number"
                    step="0.01"
                    min="0"
                    value={form.principal}
                    onChange={(e) => setForm({ ...form, principal: e.target.value })}
                    className="input-field focus-ring"
                    placeholder={proposed ? String(proposed.principal) : '0.00'}
                  />
                </div>
                <div>
                  <label className="label">Interest (optional)</label>
                  <input
                    type="number"
                    step="0.01"
                    min="0"
                    value={form.interest}
                    onChange={(e) => setForm({ ...form, interest: e.target.value })}
                    className="input-field focus-ring"
                    placeholder={proposed ? String(proposed.interest) : '0.00'}
                  />
                </div>
              </div>
              <p className="text-xs text-muted">
                Leave principal and interest empty to use the proposed split
                {proposed
                  ? ` (${formatCurrency(proposed.principal, currency)} principal, ${formatCurrency(proposed.interest, currency)} interest)`
                  : ''}
                . Use the bank's figures if you have them.
              </p>
            </>
          )}
          <div>
            <label className="label">From account</label>
            <select
              value={form.from_account_id ?? ''}
              onChange={(e) => setForm({ ...form, from_account_id: parseInt(e.target.value) || undefined })}
              className="select-field focus-ring"
              required
            >
              <option value="">Select account</option>
              {eligibleFunding.map((a) => (
                <option key={a.id} value={a.id}>{a.name}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="label">Date</label>
            <input
              type="date"
              value={form.date}
              onChange={(e) => {
                setForm({ ...form, date: e.target.value })
                setError(null)
              }}
              min={RECORD_DATE_MIN}
              max={recordDateMax()}
              className="input-field focus-ring"
              data-testid="loan-payment-date"
              required
            />
          </div>
          <label className="inline-flex items-center gap-2 text-sm text-body cursor-pointer">
            <input
              type="checkbox"
              className="border-line text-ink"
              checked={form.is_posted}
              onChange={(e) => setForm({ ...form, is_posted: e.target.checked })}
            />
            <span>Posted (moves the balances now; otherwise it is not posted yet)</span>
          </label>
          {error && <p className="text-sm text-danger" role="alert">{error}</p>}
          <div className="flex gap-3">
            <button type="submit" disabled={isPaying || isPrepaying} className="flex-1 btn-primary focus-ring">
              {isPaying || isPrepaying ? 'Saving...' : 'Save'}
            </button>
            <button type="button" onClick={() => setMode(null)} className="flex-1 btn-secondary focus-ring">
              Cancel
            </button>
          </div>
        </form>
      )}
    </div>
  )
}
