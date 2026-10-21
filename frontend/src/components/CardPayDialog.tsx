import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent } from 'react'
import { createPortal } from 'react-dom'
import {
  addDays,
  cardPayers,
  cardPaymentBody,
  formatEntryDate,
  isPlannedPayment,
  NOTHING_DUE_NOTE,
  payChoices,
  RECORD_DATE_MIN,
  recordDateError,
  recordDateMax,
} from '@tally-trace/shared'
import type { PayChoices } from '@tally-trace/shared'
import { useGetAccountsQuery, useGetCardCreditQuery, usePayCardMutation } from '../store/api'
import { useManilaDay } from '../hooks/useManilaDay'
import { apiErrorMessage, apiErrorStatus } from '../utils/apiError'
import { formatCurrency, getCurrencySymbol } from '../utils/currency'

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

/** The credit check looks 30 days ahead, today included: a later payment isn't counted. */
const CREDIT_WINDOW_DAYS = 31

const DAY = /^\d{4}-\d{2}-\d{2}$/

/** Shown beside Full when a foreign line has no exchange rate. */
const INCOMPLETE_NOTE = 'may be low: some foreign charges have no exchange rate'

const MINIMUM_REASONS: Record<NonNullable<PayChoices['minimumReason']>, string> = {
  no_rule: 'No minimum due rule is set for this card',
  paid: "This statement's minimum is already paid",
  unavailable: 'The minimum is not available',
}

interface Props {
  cardId: number
  onClose: () => void
  /** Called after the payment is recorded, before the dialog closes. */
  onPaid?: () => void
}

/**
 * Pay a credit card: one transfer from a same-currency account into the card, for any
 * amount. Payments settle the oldest statement first, so the dialog only suggests: Full
 * (prefilled) clears the latest closed statement and every one before it; Minimum is
 * that statement's remaining minimum due. A day after Manila's today is a planned
 * payment. The statements and the day come from the server's Manila calendar, rechecked
 * when the day turns.
 *
 * Rendered through a portal; while it is open the app root is `inert`, and focus
 * returns to the element that opened it.
 */
export function CardPayDialog({ cardId, onClose, onPaid }: Props) {
  const titleId = useId()
  const dialogRef = useRef<HTMLDivElement>(null)
  const closeRef = useRef<HTMLButtonElement>(null)
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose

  const detailQuery = useGetCardCreditQuery(cardId, { refetchOnMountOrArgChange: true })
  const { refetch } = detailQuery
  const today = useManilaDay(() => {
    void refetch()
  })
  const detail = detailQuery.currentData
  const { currentData: accountsData, error: accountsError } = useGetAccountsQuery({ is_active: true, limit: 1000 })
  const [payCard, { isLoading: submitting }] = usePayCardMutation()

  const [amountInput, setAmountInput] = useState<string | null>(null)
  const [payerInput, setPayerInput] = useState<number | null>(null)
  const [dateInput, setDateInput] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  // Focus into the dialog, make the page behind inert, and undo both on close.
  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const root = document.getElementById('root')
    root?.setAttribute('inert', '')
    closeRef.current?.focus()
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.stopPropagation()
      onCloseRef.current()
    }
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('keydown', onKey)
      // Inert off first: an inert element can't take focus back.
      root?.removeAttribute('inert')
      if (opener?.isConnected) opener.focus()
    }
  }, [])

  const trapTab = useCallback((event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'Tab') return
    const items = Array.from(dialogRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [])
    const first = items[0]
    const last = items[items.length - 1]
    if (!first || !last) return
    const active = document.activeElement
    if (!dialogRef.current?.contains(active)) {
      event.preventDefault()
      first.focus()
    } else if (event.shiftKey && active === first) {
      event.preventDefault()
      last.focus()
    } else if (!event.shiftKey && active === last) {
      event.preventDefault()
      first.focus()
    }
  }, [])

  const accounts = useMemo(() => accountsData?.items ?? [], [accountsData])
  const payers = useMemo(
    () => (detail ? cardPayers(accounts, { id: cardId, currency: detail.currency }) : []),
    [accounts, cardId, detail],
  )
  const card = accounts.find((a) => a.id === cardId)
  const defaultPayer = payers.find((a) => a.id === card?.payment_account_id)?.id ?? payers[0]?.id ?? null
  const payerId = payerInput !== null && payers.some((a) => a.id === payerInput) ? payerInput : defaultPayer

  const statements = detail?.statements ?? []
  const base = detail ? payChoices(statements, today) : null
  // Untouched, the amount follows Full (empty when the latest statement is cleared).
  const amountShown = amountInput ?? (base && !base.cleared ? base.full.toFixed(2) : '')
  const amount = parseFloat(amountShown)
  const choices = detail ? payChoices(statements, today, Number.isFinite(amount) ? amount : undefined) : null
  const paymentDate = dateInput ?? today
  const validDate = DAY.test(paymentDate)
  const planned = validDate && isPlannedPayment(paymentDate, today)
  const beyondWindow = planned && paymentDate >= addDays(today, CREDIT_WINDOW_DAYS)

  const notFound = apiErrorStatus(detailQuery.error) === 404
  const loadError = notFound
    ? null
    : detailQuery.error
      ? apiErrorMessage(detailQuery.error) || "Couldn't load this card."
      : accountsError
        ? apiErrorMessage(accountsError) || "Couldn't load your accounts."
        : null
  const loading = !notFound && !loadError && (!detail || !accountsData)
  const currency = detail?.currency ?? 'PHP'
  const canSubmit = !loading && !loadError && !notFound && choices !== null && payerId !== null && !submitting

  const title = detail
    ? choices
      ? `Pay ${detail.name}: ${formatEntryDate(choices.statement.close_date)} statement, due ${formatEntryDate(choices.statement.due_date)}`
      : `Pay ${detail.name}`
    : 'Pay card'

  const handleSubmit = async () => {
    if (payerId === null) return
    if (!(amount > 0)) {
      setError(`Enter the amount to pay in ${currency}`)
      return
    }
    if (!validDate) {
      setError('Choose the payment date')
      return
    }
    const dateError = recordDateError(paymentDate)
    if (dateError) {
      setError(dateError)
      return
    }
    setError(null)
    try {
      await payCard({
        accountId: cardId,
        data: cardPaymentBody({ amount, fromAccountId: payerId, paymentDate }),
      }).unwrap()
      onPaid?.()
      onClose()
    } catch (caught) {
      setError(apiErrorMessage(caught) || 'Could not record the payment. Please try again.')
    }
  }

  return createPortal(
    <div
      className="fixed inset-0 z-[60] overflow-y-auto bg-black/60 px-4 py-6"
      onClick={onClose}
      data-testid="card-pay-overlay"
    >
      <div className="flex min-h-full items-center justify-center">
        <div
          ref={dialogRef}
          className="w-full max-w-md border border-line bg-surface p-5 sm:p-6 space-y-4"
          role="dialog"
          aria-modal="true"
          aria-labelledby={titleId}
          data-testid="card-pay-dialog"
          onClick={(event) => event.stopPropagation()}
          onKeyDown={trapTab}
        >
          <div className="flex items-start justify-between gap-4">
            <h2 id={titleId} className="text-lg font-semibold text-ink" data-testid="card-pay-title">{title}</h2>
            <button ref={closeRef} type="button" onClick={onClose} className="btn-secondary focus-ring">
              Close
            </button>
          </div>

          {notFound && (
            <p className="text-sm text-warn" role="alert" data-testid="card-pay-not-found">You can&apos;t pay this card.</p>
          )}
          {loadError && (
            <p className="text-sm text-warn" role="alert" data-testid="card-pay-load-error">{loadError}</p>
          )}
          {loading && (
            <p className="text-sm text-muted" role="status" data-testid="card-pay-loading">Loading…</p>
          )}

          {!loading && !loadError && !notFound && detail && choices === null && (
            <p className="text-sm text-muted" data-testid="card-pay-no-statement">No closed statement yet.</p>
          )}

          {!loading && !loadError && !notFound && detail && choices && (
            <>
              <div>
                <label className="label" htmlFor={`${titleId}-amount`}>Amount ({currency})</label>
                <div className="relative">
                  <span className="absolute inset-y-0 left-0 pl-3 flex items-center text-muted text-sm">{getCurrencySymbol(currency)}</span>
                  <input
                    id={`${titleId}-amount`}
                    type="number"
                    step="0.01"
                    min="0"
                    value={amountShown}
                    onChange={(e) => {
                      setAmountInput(e.target.value)
                      setError(null)
                    }}
                    className="input-field pl-7 focus-ring"
                    placeholder="0.00"
                    data-testid="card-pay-amount"
                  />
                </div>
                {choices.cleared && (
                  <p className="mt-1 text-xs text-muted" data-testid="card-pay-nothing-due">{NOTHING_DUE_NOTE}</p>
                )}
                {choices.excess > 0 && (
                  <p className="mt-1 text-xs text-info" data-testid="card-pay-excess-note">
                    {formatCurrency(choices.excess, currency)} more than the {formatEntryDate(choices.statement.close_date)} statement;
                    the rest pays your next statement.
                  </p>
                )}
              </div>

              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={() => {
                    setAmountInput(choices.full.toFixed(2))
                    setError(null)
                  }}
                  disabled={choices.cleared}
                  className="btn-secondary focus-ring disabled:opacity-50"
                  data-testid="card-pay-full"
                  title={choices.incomplete ? INCOMPLETE_NOTE : undefined}
                >
                  Full {formatCurrency(choices.full, currency)}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    if (!choices.minimum) return
                    setAmountInput(choices.minimum.amount.toFixed(2))
                    setError(null)
                  }}
                  disabled={choices.minimum === null}
                  className="btn-secondary focus-ring disabled:opacity-50"
                  data-testid="card-pay-minimum"
                  title={choices.minimumReason ? MINIMUM_REASONS[choices.minimumReason] : undefined}
                >
                  {choices.minimum ? (
                    <>
                      Minimum {formatCurrency(choices.minimum.amount, currency)}{' '}
                      <span className="text-xs text-muted" data-testid="card-pay-minimum-source">
                        ({choices.minimum.source === 'statement' ? 'from your statement' : 'estimate'})
                      </span>
                    </>
                  ) : (
                    'Minimum'
                  )}
                </button>
              </div>
              {choices.minimumReason && (
                <p className="text-xs text-muted" data-testid="card-pay-minimum-reason">{MINIMUM_REASONS[choices.minimumReason]}</p>
              )}
              {choices.incomplete && (
                <p className="text-xs text-warn" data-testid="card-pay-incomplete-note">Full {INCOMPLETE_NOTE}.</p>
              )}

              <div>
                <label className="label" htmlFor={`${titleId}-from`}>Pay from</label>
                {payers.length === 0 ? (
                  <p className="text-sm text-warn" data-testid="card-pay-no-payer">No {currency} account you can pay from.</p>
                ) : (
                  <select
                    id={`${titleId}-from`}
                    value={payerId ?? ''}
                    onChange={(e) => {
                      setPayerInput(Number(e.target.value))
                      setError(null)
                    }}
                    className="select-field focus-ring"
                    data-testid="card-pay-from"
                  >
                    {payers.map((a) => (
                      <option key={a.id} value={a.id}>{a.name}</option>
                    ))}
                  </select>
                )}
              </div>

              <div>
                <label className="label" htmlFor={`${titleId}-date`}>Payment date</label>
                <input
                  id={`${titleId}-date`}
                  type="date"
                  value={paymentDate}
                  onChange={(e) => {
                    setDateInput(e.target.value)
                    setError(null)
                  }}
                  min={RECORD_DATE_MIN}
                  max={recordDateMax()}
                  className="input-field focus-ring"
                  data-testid="card-pay-date"
                />
                {planned && (
                  <p className="mt-1 text-xs text-info" data-testid="card-pay-planned-note">
                    {beyondWindow
                      ? 'Planned payment: beyond the 30-day credit check'
                      : `Planned payment: counts toward available credit from ${formatEntryDate(paymentDate)}`}
                  </p>
                )}
              </div>
            </>
          )}

          {error && <p className="text-sm text-danger" role="alert" data-testid="card-pay-error">{error}</p>}

          <div className="flex flex-wrap gap-2">
            {!notFound && (
              <button
                type="button"
                onClick={() => void handleSubmit()}
                disabled={!canSubmit}
                className="btn-primary focus-ring disabled:opacity-50"
                data-testid="card-pay-submit"
              >
                {submitting ? 'Paying…' : 'Pay'}
              </button>
            )}
            <button type="button" onClick={onClose} className="btn-secondary focus-ring">Cancel</button>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  )
}
