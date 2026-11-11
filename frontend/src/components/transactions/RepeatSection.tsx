import { fieldErrorProps } from '@tally-trace/shared'
import type { FieldErrors, ScheduleDraft, ScheduleState, SchedulePreview } from '@tally-trace/shared'
import { RecurringScheduleFields } from '../RecurringScheduleFields'
import type { ScheduleControlKey, ScheduleControlProps, ScheduleFieldKey } from '../RecurringScheduleFields'

// A Repeat control that shows a field's error under it.
export type RepeatErrorKey = ScheduleFieldKey | ScheduleControlKey
const repeatErrorId = (key: RepeatErrorKey) => `repeat-${key}-error`
const noFieldRef = () => () => undefined

interface RepeatSectionProps {
  /** The toggle's label ("Repeat"). */
  label: string
  /** The line under the toggle: the blocked reason, else what Repeat does. */
  help: string
  /** The line shown when the API has no Repeat endpoint (a deploy in flight). */
  unavailableCopy: string
  active: boolean
  blocked: boolean
  onToggle: (on: boolean) => void
  schedule: ScheduleDraft
  state: ScheduleState
  preview: SchedulePreview | null
  settlementControl: Parameters<typeof RecurringScheduleFields>[0]['settlementControl']
  onChange: (update: (prev: ScheduleDraft) => ScheduleDraft) => void
  errors: FieldErrors<RepeatErrorKey>
  /** A refusal that belongs to no field. */
  error: string | null
  unavailable: boolean
  retryDisabled: boolean
  onRetry: () => void
}

/** The Repeat toggle of Add Transaction and, when on, its schedule fields. */
export function RepeatSection({
  label, help, unavailableCopy, active, blocked, onToggle, schedule, state, preview, settlementControl,
  onChange, errors, error, unavailable, retryDisabled, onRetry,
}: RepeatSectionProps) {
  const fieldError = (key: RepeatErrorKey) =>
    errors[key] ? (
      <p id={repeatErrorId(key)} className="mt-1 text-xs text-danger" role="alert" data-testid={`repeat-error-${key}`}>
        {errors[key]}
      </p>
    ) : null

  return (
    <div className="space-y-3" data-testid="repeat-section">
      <label className="inline-flex min-h-11 items-center gap-2 text-sm text-body cursor-pointer">
        <input
          type="checkbox"
          className="h-5 w-5 border-line text-ink"
          checked={active}
          disabled={blocked}
          onChange={(e) => onToggle(e.target.checked)}
          aria-describedby="repeat-help"
          data-testid="repeat-toggle"
        />
        <span>{label}</span>
      </label>
      <p id="repeat-help" className="-mt-2 text-xs text-muted" data-testid="repeat-help">
        {help}
      </p>
      {active && (
        <fieldset className="min-w-0 space-y-5 border-l-2 border-line pl-3" data-testid="repeat-fields">
          <legend className="sr-only">Repeat schedule</legend>
          <RecurringScheduleFields
            draft={schedule}
            state={state}
            preview={preview}
            settlementControl={settlementControl}
            onChange={onChange}
            fieldProps={(key) => fieldErrorProps(errors, key, repeatErrorId(key))}
            renderFieldError={fieldError}
            bindField={noFieldRef}
            controlProps={(key): ScheduleControlProps => ({
              'data-field': key,
              ...fieldErrorProps(errors, key, repeatErrorId(key)),
            })}
            renderControlError={fieldError}
            showFinalMonthHelp={false}
            finalMonthHelp=""
            idPrefix="repeat"
            touch
            dateFixed
          />
          {preview && 'missed' in preview && preview.missed && (
            <p className="text-xs text-muted" data-testid="repeat-missed">{preview.missed}</p>
          )}
          {error && (
            <p className="text-sm text-danger" role="alert" data-testid="repeat-error">{error}</p>
          )}
          {unavailable && (
            <div className="space-y-2" data-testid="repeat-unavailable">
              <p className="text-sm text-danger" role="alert">{unavailableCopy}</p>
              <button
                type="button"
                className="btn-secondary focus-ring min-h-11"
                disabled={retryDisabled}
                onClick={onRetry}
                data-testid="repeat-retry"
              >
                Retry
              </button>
            </div>
          )}
        </fieldset>
      )}
    </div>
  )
}
