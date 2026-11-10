import type { ReactNode } from 'react'
import { dateForDaySetting, isMonthFamily, parseEntryDate, settleKindChoice } from '@tally-trace/shared'
import type {
  BillingKindChoice,
  DaySetting,
  ScheduleDraft,
  SchedulePreview,
  ScheduleState,
  SettlementControlState,
} from '@tally-trace/shared'
import { chargedOnCloseLabel, formatCadenceLabel } from '../utils/recurringEntry'

/** The schedule controls that carry an inline error. */
export type ScheduleFieldKey = 'day' | 'day_of_month' | 'end_date' | 'max_occurrences'

const DAY_LABELS: Record<DaySetting['kind'], string> = {
  same_as_date: 'Same as date',
  day: 'Day of month (1–31)',
  last_weekday: 'Last weekday of month',
}

interface RecurringScheduleFieldsProps {
  draft: ScheduleDraft
  /** `scheduleState(draft, ctx)`. */
  state: ScheduleState
  /** `schedulePreview(draft, ctx)`. */
  preview: SchedulePreview | null
  settlementControl: SettlementControlState
  onChange: (update: (prev: ScheduleDraft) => ScheduleDraft) => void
  fieldProps: (key: ScheduleFieldKey) => { 'aria-invalid': true | undefined; 'aria-describedby': string | undefined }
  renderFieldError: (key: ScheduleFieldKey) => ReactNode
  bindField: (key: ScheduleFieldKey) => (el: HTMLElement | null) => void
  /** The date control, beside the cadence. */
  dateField?: ReactNode
  /** Rendered between the Day control and Ends. */
  beforeEnds?: ReactNode
  /** The final-month help under the number of runs (a stored active capped entry). */
  showFinalMonthHelp: boolean
  finalMonthHelp: string
}

/**
 * The schedule controls of a recurring entry: cadence, Day, Ends, the card Kind, the bank
 * kind and Settlement, with their inline errors (`data-field` on each). The values and
 * their rules are `@tally-trace/shared`'s `scheduleState`, `scheduleRequest` and
 * `schedulePreview`; this renders them.
 */
export function RecurringScheduleFields({
  draft,
  state,
  preview,
  settlementControl,
  onChange,
  fieldProps,
  renderFieldError,
  bindField,
  dateField,
  beforeEnds,
  showFinalMonthHelp,
  finalMonthHelp,
}: RecurringScheduleFieldsProps) {
  const { chargedOnClose, cardCloseDay, cadence } = state
  const chooseDay = (day: DaySetting) =>
    onChange((prev) => ({
      ...prev,
      day,
      next_occurrence: dateForDaySetting(prev.next_occurrence, day),
    }))

  return (
    <>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          {chargedOnClose && cardCloseDay !== null ? (
          <div>
                  <label className="block text-sm font-medium text-body">Cadence</label>
                  <p className="mt-1 py-2 text-sm text-body" data-testid="installment-close-note">
                    {chargedOnCloseLabel(cardCloseDay)}
                  </p>
          </div>
          ) : (
          <div>
                  <label className="block text-sm font-medium text-body">Cadence</label>
            <select
                    value={draft.cadence}
                    data-field="cadence"
                    onChange={(e) =>
                      onChange((prev) => ({
                        ...prev,
                        cadence: e.target.value as ScheduleDraft['cadence'],
                      }))
                    }
                    className="mt-1 block w-full border border-line px-3 py-2"
                  >
                    {state.cadenceChoices.map(
                      (value) => (
                        <option key={value} value={value}>
                          {formatCadenceLabel(value)}
                        </option>
                      )
                    )}
                  </select>
          </div>
          )}
                {dateField}
              </div>

              {chargedOnClose && preview && !('error' in preview) && (
                <div className="text-xs text-muted" data-testid="schedule-preview">
                  <p className="font-medium text-body">{preview.label}</p>
                  {preview.dates.length > 0 && <p>Next: {preview.dates.join(', ')}</p>}
                </div>
              )}
              {isMonthFamily(cadence) && !chargedOnClose && (
                <div className="space-y-2">
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                    <div>
                      <label className="block text-sm font-medium text-body">Day</label>
                      <select
                        value={state.day.kind}
                        onChange={(e) => {
                          const kind = e.target.value as DaySetting['kind']
                          if (kind === 'day') {
                            // Start from the date's own day, so the date stays put.
                            const day = parseEntryDate(draft.next_occurrence).getUTCDate()
                            chooseDay({ kind: 'day', day: Number.isNaN(day) ? 1 : day })
                          } else {
                            chooseDay({ kind })
                          }
                        }}
                        className="mt-1 block w-full border border-line px-3 py-2"
                        ref={bindField('day')}
                        data-field="day"
                        {...fieldProps('day')}
                      >
                        {state.dayChoices.map((kind) => (
                          <option key={kind} value={kind}>{DAY_LABELS[kind]}</option>
                        ))}
                      </select>
                    </div>
                    {state.day.kind === 'day' && (
                      <div>
                        <label className="block text-sm font-medium text-body">Day of month</label>
                        <input
                          type="number"
                          min={1}
                          max={31}
                          value={state.day.day}
                          onChange={(e) => {
                            const day = parseInt(e.target.value, 10)
                            if (Number.isNaN(day)) return
                            chooseDay({ kind: 'day', day: Math.min(31, Math.max(1, day)) })
                          }}
                          className="mt-1 block w-full border border-line px-3 py-2"
                          ref={bindField('day_of_month')}
                          data-field="day_of_month"
                          {...fieldProps('day_of_month')}
                        />
                        {renderFieldError('day_of_month')}
                      </div>
                    )}
                  </div>
                  {renderFieldError('day')}
                  {preview && 'error' in preview ? (
                    <p className="text-xs text-danger" data-testid="schedule-error">
                      {preview.error}
                    </p>
                  ) : preview ? (
                    <div className="text-xs text-muted" data-testid="schedule-preview">
                      <p className="font-medium text-body">{preview.label}</p>
                      {preview.dates.length > 0 && <p>Next: {preview.dates.join(', ')}</p>}
                    </div>
                  ) : null}
                </div>
              )}

              {beforeEnds}

              <div className="space-y-3">
                <div>
                  <label className="block text-sm font-medium text-body">Ends</label>
                  <div className="mt-1 flex flex-wrap gap-2">
                    {[
                      { value: 'indefinite', label: 'Keep running' },
                      { value: 'on_date', label: 'On date' },
                      { value: 'after_occurrences', label: 'After runs' },
                    ].map(({ value, label }) => {
                      const isSelected = draft.end_mode === value
                      return (
                        <button
                          type="button"
                          key={value}
                          onClick={() =>
                            onChange((prev) => ({
                              ...prev,
                              end_mode: value as ScheduleDraft['end_mode'],
                              kind_choice: settleKindChoice(value === 'after_occurrences', state.kindValue, state.offerAutomatic),
                              end_date: value === 'on_date' ? prev.end_date : undefined,
                              max_occurrences:
                                value === 'after_occurrences'
                                  ? prev.max_occurrences && prev.max_occurrences > 0
                                    ? prev.max_occurrences
                                    : 6
                                  : undefined,
                            }))
                          }
                          className={`rounded-full px-3 py-1 text-sm font-medium transition ${ isSelected ? 'bg-ink text-paper' : 'bg-sunken text-body hover:bg-sunken' }`}
                        >
                          {label}
                        </button>
                      )
                    })}
                  </div>
  </div>

                {draft.end_mode === 'on_date' && (
                  <div>
                    <label className="block text-sm font-medium text-body">End after</label>
                    <input
                      type="datetime-local"
                      value={draft.end_date ?? ''}
                      onChange={(e) =>
                        onChange((prev) => ({
                          ...prev,
                          end_date: e.target.value || undefined,
                        }))
                      }
                      className="mt-1 block w-full border border-line px-3 py-2"
                      ref={bindField('end_date')}
                      data-field="end_date"
                      {...fieldProps('end_date')}
                    />
                    {renderFieldError('end_date')}
                    <p className="mt-1 text-xs text-muted">
                      No additional transactions will be generated after this date.
                    </p>
                  </div>
                )}

                {draft.end_mode === 'after_occurrences' && (
                  <div>
                    <label className="block text-sm font-medium text-body">Number of runs</label>
                    <input
                      type="number"
                      min={1}
                      value={draft.max_occurrences ?? ''}
                      onChange={(e) =>
                        onChange((prev) => ({
                          ...prev,
                          max_occurrences: e.target.value ? Math.max(1, parseInt(e.target.value, 10)) : undefined,
                        }))
                      }
                      className="mt-1 block w-full border border-line px-3 py-2"
                      ref={bindField('max_occurrences')}
                      data-field="max_occurrences"
                      {...fieldProps('max_occurrences')}
                    />
                    {renderFieldError('max_occurrences')}
                    <p className="mt-1 text-xs text-muted">
                      Stop once this many transactions have been created.
                    </p>
                    {/* Only a stored active capped entry with payments left has a last payment to keep:
                        an edit to a paused entry keeps the pause behaviour instead. */}
                    {showFinalMonthHelp && (
                      <p className="mt-1 text-xs text-muted" data-testid="final-month-help">
                        {finalMonthHelp}
                      </p>
                    )}
                  </div>
                )}
              </div>

              {state.showKindSelect && (
                <div>
                  <label className="block text-sm font-medium text-body" htmlFor="recurring-kind">Kind</label>
                  <select
                    id="recurring-kind"
                    value={state.kindValue}
                    onChange={(e) =>
                      onChange((prev) => ({
                        ...prev,
                        kind_choice: e.target.value as BillingKindChoice['id'],
                      }))
                    }
                    className="mt-1 block w-full border border-line px-3 py-2"
                    data-testid="recurring-kind"
                  >
                    {state.kindChoices.map((choice) => (
                      <option key={choice.id} value={choice.id}>{choice.label}</option>
                    ))}
                  </select>
                  <p className="mt-1 text-xs text-muted">
                    {state.kindCapped
                      ? 'An installment has a fixed amount; a bill varies, and you enter the amount charged each time.'
                      : 'A subscription posts a fixed amount; a bill varies, and you enter the amount charged each time.'}
                  </p>
                </div>
              )}

              {state.showBankKindSelect && (
                <div>
                  <label className="block text-sm font-medium text-body" htmlFor="recurring-bank-kind">Kind</label>
                  <select
                    id="recurring-bank-kind"
                    value={draft.bank_kind}
                    onChange={(e) =>
                      onChange((prev) => ({
                        ...prev,
                        bank_kind: e.target.value === 'subscription' ? 'subscription' : 'other',
                      }))
                    }
                    className="mt-1 block w-full border border-line px-3 py-2"
                    data-testid="recurring-bank-kind"
                  >
                    <option value="subscription">Subscription</option>
                    <option value="other">Other</option>
                  </select>
                  <p className="mt-1 text-xs text-muted">
                    A subscription is listed under Subscriptions on Transactions; anything else, such as rent, stays in Due and overdue.
                  </p>
                </div>
              )}

              {settlementControl.shown && (
                <div>
                  <label className="block text-sm font-medium text-body" htmlFor="recurring-settlement">Settlement</label>
                  <select
                    id="recurring-settlement"
                    value={settlementControl.disabledReason === null ? draft.settlement : 'manual'}
                    onChange={(e) =>
                      onChange((prev) => ({ ...prev, settlement: e.target.value === 'autopay' ? 'autopay' : 'manual' }))
                    }
                    disabled={settlementControl.disabledReason !== null}
                    className="mt-1 block w-full border border-line px-3 py-2 disabled:opacity-60"
                    data-testid="recurring-settlement"
                  >
                    <option value="manual">Manual: I record each payment</option>
                    <option value="autopay">Autopay: post it on its date</option>
                  </select>
                  <p className="mt-1 text-xs text-muted" data-testid="recurring-settlement-help">
                    {settlementControl.disabledReason ?? 'Autopay posts each payment by itself on its date. Manual waits for you.'}
                  </p>
                </div>
              )}
    </>
  )
}
