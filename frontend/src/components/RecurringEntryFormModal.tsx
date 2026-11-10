import { useMemo, useRef, useState } from 'react'
import {
  bankKindOf,
  DEFAULT_SETTLEMENT,
  daySettingOf,
  fromWireWallTime,
  isCappedEnd,
  isOwnerFull,
  isSharedFull,
  kindChoiceFor,
  scheduleRequest,
  schedulePreview as previewSchedule,
  scheduleState,
  settlementControlState,
  settlementFollowUp,
  finalMonthHelp,
  fieldErrorProps,
  withLoadedVersion,
  withoutError,
} from '@tally-trace/shared'
import type { BankKind, BillingKindChoice, DaySetting, FieldErrors, ScheduleContext, Settlement } from '@tally-trace/shared'
import { accountPickerGroups, categoryPickerGroups } from '@tally-trace/shared'
import { PickerOptGroups } from './PickerOptGroups'
import { RecurringScheduleFields } from './RecurringScheduleFields'
import { useCreateBudgetEntryMutation, useUpdateBudgetEntryMutation } from '../store/api'
import type { Account, Allocation, BudgetEntry, Category, FullBudgetEntry, SharedFullBudgetEntry } from '../store/api'
import { useCurrency } from '../hooks/useCurrency'
import { useAutopayActions } from '../hooks/useAutopayActions'
import { useDeleteRecurringEntry } from '../hooks/useDeleteRecurringEntry'
import { CurrencyCode, CURRENCY_CONFIGS } from '../utils/currency'
import { apiErrorMessage, apiErrorStatus } from '../utils/apiError'
import { tagIdsIfChanged, tagIdsOf } from '../utils/tags'
import { TagPicker } from './TagPicker'

const toLocalDateTimeInput = (value: Date | string) => {
  const date = typeof value === 'string' ? new Date(value) : value
  return new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16)
}

type SubscriptionFormState = {
  name: string
  description: string
  entry_type: 'income' | 'expense'
  amount: number
  currency: CurrencyCode
  account_id: number
  overflow_account_id?: number
  /** Recurring transfer destination: occurrences move money from account_id here. */
  transfer_to_account_id?: number
  category_id?: number
  allocation_id?: number
  cadence: BudgetEntry['cadence']
  next_occurrence: string
  lead_time_days: number
  is_active: boolean
  end_mode: 'indefinite' | 'on_date' | 'after_occurrences'
  end_date?: string
  max_occurrences?: number
  /** Card expenses: the pick in the kind select (what `billingKindChoices` offers). */
  kind_choice: BillingKindChoice['id']
  /** Open-ended bank (non-card) expenses: Subscription stores `billing_kind: 'subscription'`; Other stores null. */
  bank_kind: BankKind
  /** Cash expenses: how it settles. Applied after the save, as the toggle call. */
  settlement: Settlement
  /** Month-family cadences: the Day control (an edit sends it only when it changed). */
  day: DaySetting
  // The tags picked in the form; an edit sends them only when they changed.
  tag_ids: number[]
}

const createSubscriptionDefaults = (currency: CurrencyCode): SubscriptionFormState => ({
  name: '',
  description: '',
  entry_type: 'expense',
  amount: 0,
  currency,
  account_id: 0,
  transfer_to_account_id: undefined,
  category_id: undefined,
  allocation_id: undefined,
  cadence: 'monthly',
  next_occurrence: toLocalDateTimeInput(new Date()),
  lead_time_days: 0,
  is_active: true,
  end_mode: 'indefinite',
  end_date: undefined,
  max_occurrences: undefined,
  kind_choice: 'automatic',
  bank_kind: 'other',
  settlement: DEFAULT_SETTLEMENT,
  day: { kind: 'same_as_date' },
  tag_ids: [],
})

type RecurringFieldKey = 'name' | 'account_id' | 'amount' | 'next_occurrence' | 'end_date' | 'max_occurrences' | 'day' | 'day_of_month' | 'lead_time_days'

/** The app's own wording for a required field left empty; a bound such as `step` uses the browser's text. */
const REQUIRED_COPY: Partial<Record<RecurringFieldKey, string>> = {
  name: 'Please provide a name for the recurring entry.',
  account_id: 'Please select an account to post this recurring entry into.',
  amount: 'Please enter an amount greater than zero.',
  next_occurrence: 'Please choose the next occurrence date and time.',
}

interface RecurringEntryFormModalProps {
  /** The entry to edit, or null to add one. An entry the caller can edit is never Limited. */
  entry: FullBudgetEntry | SharedFullBudgetEntry | null
  accounts: Account[]
  categories: Category[]
  /** The budget envelopes an entry can link to. */
  budgetEnvelopes: Allocation[]
  onClose: () => void
  onSaved: () => void | Promise<void>
  /** Called on any 409 refusal of a save (a stale copy or an ended schedule): reload the caller's entries so reopening shows the current one. */
  onStale?: () => void
  onDeleted: () => void | Promise<void>
}

/**
 * The add/edit form for a recurring entry (income, expense or recurring transfer).
 * Render it with `key={entry?.id ?? 'new'}`: the form is filled once, when it mounts.
 */
export function RecurringEntryFormModal({
  entry: editingBudgetEntry,
  accounts,
  categories,
  budgetEnvelopes,
  onClose,
  onSaved,
  onStale,
  onDeleted,
}: RecurringEntryFormModalProps) {
  const { currencyCode: defaultCurrencyCode } = useCurrency()
  const currencyOptions = useMemo(() => Object.keys(CURRENCY_CONFIGS) as CurrencyCode[], [])
  const [createBudgetEntry] = useCreateBudgetEntryMutation()
  const [updateBudgetEntry] = useUpdateBudgetEntryMutation()
  // The server's reason for a refused save (a stale copy, a final-month rule), shown above Save.
  const [saveError, setSaveError] = useState('')
  const deleteRecurringEntry = useDeleteRecurringEntry()
  // One inline message per field, shown under it in place of a browser popup (STU-410).
  const [fieldErrors, setFieldErrors] = useState<FieldErrors<RecurringFieldKey>>({})
  const fieldRefs = useRef<Partial<Record<RecurringFieldKey, HTMLElement | null>>>({})
  // The controls the browser flagged invalid in one submit attempt, in tree order.
  const invalidTargets = useRef<HTMLElement[]>([])
  const bindField = (key: RecurringFieldKey) => (el: HTMLElement | null) => {
    fieldRefs.current[key] = el
  }
  const fieldProps = (key: RecurringFieldKey) =>
    fieldErrorProps(fieldErrors, key, `recurring-${key}-error`)
  const fail = (key: RecurringFieldKey, message: string) => {
    setFieldErrors({ [key]: message })
    fieldRefs.current[key]?.focus()
  }
  const renderFieldError = (key: RecurringFieldKey) =>
    fieldErrors[key] ? (
      <p
        id={`recurring-${key}-error`}
        className="mt-1 text-xs text-danger"
        role="alert"
        data-testid={`field-error-${key}`}
      >
        {fieldErrors[key]}
      </p>
    ) : null
  // Editing a field clears its message (a changed date or cadence also clears the day's).
  const handleFormChange = (e: React.ChangeEvent<HTMLFormElement>) => {
    const key = (e.target as HTMLElement).dataset.field as RecurringFieldKey | undefined
    if (!key) return
    setFieldErrors((prev) =>
      (['day', 'day_of_month'] as const).reduce<FieldErrors<RecurringFieldKey>>(withoutError, withoutError(prev, key)))
  }
  // The browser keeps owning every required/min/max/step; only its popup is replaced. The
  // `invalid` events fire in tree order during the submit's validity check, so the first one
  // collected is the first invalid field. A timer, not a microtask: on a real click the
  // microtask queue drains between two events, so a microtask would see one field per attempt.
  const handleInvalid = (e: React.FormEvent<HTMLFormElement>) => {
    const target = e.target as HTMLInputElement | HTMLSelectElement
    // Every invalid control loses its popup, wired or not: an unwired one (no data-field) is
    // reported in the form-level message above Save, so it fails visibly, never in a bubble.
    e.preventDefault()
    const targets = invalidTargets.current
    targets.push(target)
    if (targets.length > 1) return
    window.setTimeout(() => {
      const first = invalidTargets.current[0]
      invalidTargets.current = []
      if (!first) return
      const key = first.dataset.field as RecurringFieldKey | undefined
      const input = first as HTMLInputElement
      if (!key) {
        setSaveError(input.validationMessage || 'Please check this field.')
        first.focus()
        return
      }
      fail(key, (input.validity.valueMissing && REQUIRED_COPY[key]) || input.validationMessage)
    }, 0)
  }

  // A recurring entry is written like a transaction: only to accounts the caller may add to.
  const writableAccounts = useMemo(() => accounts.filter((a) => a.permissions.can_add_transactions), [accounts])
  const accountsById = useMemo(() => {
    const map = new Map<number, Account>()
    accounts.forEach((account) => map.set(account.id, account))
    return map
  }, [accounts])

  const [subscriptionForm, setSubscriptionForm] = useState<SubscriptionFormState>(() => {
    const entry = editingBudgetEntry
    if (!entry) {
      return createSubscriptionDefaults(defaultCurrencyCode)
    }
    return {
      name: entry.name,
      description: entry.description || '',
      entry_type: entry.entry_type,
      amount: entry.amount,
      currency: (entry.currency as CurrencyCode) || defaultCurrencyCode,
      account_id: entry.account_id ?? 0,
      overflow_account_id: entry.overflow_account_id ?? undefined,
      transfer_to_account_id: entry.transfer_to_account_id ?? undefined,
      // A shared-full entry has no category or allocation to edit.
      category_id: isOwnerFull(entry) ? entry.category_id ?? undefined : undefined,
      allocation_id: isOwnerFull(entry) ? entry.allocation_id ?? undefined : undefined,
      cadence: entry.cadence,
      next_occurrence: fromWireWallTime(entry.next_occurrence),
      lead_time_days: entry.lead_time_days ?? 0,
      is_active: entry.is_active,
      end_mode: (entry.end_mode as SubscriptionFormState['end_mode']) ?? 'indefinite',
      end_date: entry.end_date ? fromWireWallTime(entry.end_date) : undefined,
      max_occurrences: entry.max_occurrences ?? undefined,
      kind_choice: kindChoiceFor(isCappedEnd(entry.end_mode, entry.max_occurrences), entry.billing_kind),
      bank_kind: bankKindOf(entry.billing_kind),
      settlement: entry.settlement === 'autopay' ? 'autopay' : DEFAULT_SETTLEMENT,
      day: daySettingOf(entry),
      tag_ids: tagIdsOf(entry.tags),
    }
  })

  const selectedCard = accountsById.get(subscriptionForm.account_id)
  // The schedule controls' rules (shared with Repeat in Add Transaction): the card Kind,
  // the bank kind, a card installment on its statement close, and the Day choices.
  const scheduleContext: ScheduleContext = {
    stored: editingBudgetEntry,
    entryType: subscriptionForm.entry_type,
    transferToAccountId: subscriptionForm.transfer_to_account_id,
    account: selectedCard,
    accountId: subscriptionForm.account_id,
  }
  const schedule = scheduleState(subscriptionForm, scheduleContext)
  // The Settlement control: only a cash expense has one (a card entry, a transfer and income name no settlement).
  const settlementControl = settlementControlState({
    entryType: subscriptionForm.entry_type,
    transferToAccountId: subscriptionForm.transfer_to_account_id,
    account: accountsById.get(subscriptionForm.account_id),
    currency: subscriptionForm.currency,
    isActive: subscriptionForm.is_active,
  })
  const { turnOn, turnOff } = useAutopayActions()
  // What the save could not finish (autopay refused after the entry was saved); the form then only offers Close.
  const [savedNote, setSavedNote] = useState<string | null>(null)
  // The date input as loaded. A paused entry turned active with this date untouched is resumed: the
  // server moves it to the first scheduled date on or after today, so the date is left out of the save.
  const [loadedNextOccurrence] = useState(() => (editingBudgetEntry ? fromWireWallTime(editingBudgetEntry.next_occurrence) : null))
  const resuming =
    editingBudgetEntry != null &&
    !editingBudgetEntry.is_active &&
    subscriptionForm.is_active &&
    subscriptionForm.next_occurrence === loadedNextOccurrence

  // The schedule a save would store: the day fields the API resolves the write to
  // (or the detail it would refuse it with), and the next three dates.
  const schedulePreview = previewSchedule(subscriptionForm, scheduleContext)

  const handleSubscriptionAccountChange = (accountId: number) => {
    const account = accountsById.get(accountId)
    setSubscriptionForm((prev) => {
      const destination = prev.transfer_to_account_id ? accountsById.get(prev.transfer_to_account_id) : undefined
      // A loan is paid only from an account in its own currency.
      const loanInOtherCurrency =
        destination?.account_type === 'loan' && !!account && destination.currency !== account.currency
      return {
        ...prev,
        account_id: accountId,
        currency: (account?.currency as CurrencyCode) || prev.currency,
        // A transfer can't come from a card or go to its own source.
        transfer_to_account_id:
          account?.account_type === 'credit' || prev.transfer_to_account_id === accountId || loanInOtherCurrency
            ? undefined
            : prev.transfer_to_account_id,
      }
    })
  }

  const handleSubscriptionTransferToChange = (accountId: number | undefined) => {
    const destination = accountId ? accountsById.get(accountId) : undefined
    setSubscriptionForm((prev) => ({
      ...prev,
      transfer_to_account_id: accountId,
      // A recurring loan payment is in the loan's currency.
      currency: destination?.account_type === 'loan' ? (destination.currency as CurrencyCode) : prev.currency,
    }))
  }

  const handleDelete = async (entry: FullBudgetEntry | SharedFullBudgetEntry) => {
    if (await deleteRecurringEntry(entry)) {
      await onDeleted()
    }
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (savedNote !== null) return
    setSaveError('')
    setFieldErrors({})
    let saved: BudgetEntry
    try {
      if (!subscriptionForm.name.trim()) {
        fail('name', 'Please provide a name for the recurring entry.')
        return
      }
      if (!subscriptionForm.account_id) {
        fail('account_id', 'Please select an account to post this recurring entry into.')
        return
      }
      if (subscriptionForm.amount <= 0) {
        fail('amount', 'Please enter an amount greater than zero.')
        return
      }
      // The date, the ends and the day, in that order (scheduleRequest).
      const scheduleFields = scheduleRequest(subscriptionForm, scheduleContext)
      if (!scheduleFields.ok) {
        fail(scheduleFields.field, scheduleFields.message)
        return
      }
      const { next_occurrence: nextOccurrenceWire, ...sentSchedule } = scheduleFields.fields

      const subscriptionPayload = {
        name: subscriptionForm.name.trim(),
        description: subscriptionForm.description?.trim() || undefined,
        entry_type: subscriptionForm.entry_type,
        amount: subscriptionForm.amount,
        currency: subscriptionForm.currency,
        account_id: subscriptionForm.account_id,
        // null clears the overflow account on edit; omitted on create.
        overflow_account_id: subscriptionForm.overflow_account_id || (editingBudgetEntry ? null : undefined),
        // null clears a destination on edit; omitted on create. Only expenses carry one.
        transfer_to_account_id:
          (subscriptionForm.entry_type === 'expense' && subscriptionForm.transfer_to_account_id) ||
          (editingBudgetEntry ? null : undefined),
        category_id: subscriptionForm.category_id || undefined,
        allocation_id: subscriptionForm.allocation_id ?? undefined,
        // Omitted on a resume with the date untouched, so the server skips the paused months.
        ...(resuming ? {} : { next_occurrence: nextOccurrenceWire }),
        // The cadence, day fields, ends and card or bank kind (scheduleRequest). The kind is sent
        // only on a card or open-ended bank expense, and an edit sends it only when the pick moved.
        ...sentSchedule,
        lead_time_days: subscriptionForm.lead_time_days,
        is_active: subscriptionForm.is_active,
        // An edit sends the tags only when they changed; omitting them keeps them.
        ...(editingBudgetEntry
          ? tagIdsIfChanged(subscriptionForm.tag_ids, tagIdsOf(editingBudgetEntry.tags))
          : { tag_ids: subscriptionForm.tag_ids }),
      }

      if (editingBudgetEntry) {
        // Someone else's entry keeps its creator's category and envelope: the server
        // refuses an edit that sends them.
        const { category_id, allocation_id, ...sharedPayload } = subscriptionPayload
        const data = isSharedFull(editingBudgetEntry) ? sharedPayload : { ...sharedPayload, category_id, allocation_id }
        // The version this form loaded, so a save from a stale copy is refused rather than overwriting.
        saved = await updateBudgetEntry({ id: editingBudgetEntry.id, data: withLoadedVersion(data, editingBudgetEntry) }).unwrap()
      } else {
        saved = await createBudgetEntry(subscriptionPayload).unwrap()
      }
    } catch (error) {
      console.error('Error saving allocation data:', error)
      if (apiErrorStatus(error) === 409) onStale?.()
      setSaveError(apiErrorMessage(error) || 'Could not save the recurring entry. Please try again.')
      return
    }
    // The save went through. Settlement is its own call: an edit can also clear the flag on its
    // own (the entry moved earlier, or stopped being a cash expense), so it is judged from what the
    // save returned. A refusal leaves the entry saved as Manual and says so.
    // An entry the control is not offered for (a card installment keeps its own review) is left as the server has it.
    const followUp = settlementControl.shown && settlementControl.disabledReason === null
      ? settlementFollowUp(subscriptionForm.settlement, saved.view === 'limited' ? null : saved.settlement)
      : null
    if (followUp !== null) {
      const subject = { kind: 'entry' as const, id: saved.id, name: subscriptionForm.name.trim() }
      const outcome = await (followUp === 'turn_on' ? turnOn(subject) : turnOff(subject))
      if (outcome.error !== null) {
        setSavedNote(
          followUp === 'turn_on'
            ? `The entry was saved as Manual. Autopay was not turned on: ${outcome.error}`
            : `The entry was saved, but autopay is still on: ${outcome.error}`,
        )
        return
      }
    }
    // A failed reload after the save is not a failed save, so it is logged rather than reported as one.
    try {
      await onSaved()
    } catch (error) {
      console.error('Error reloading after saving the recurring entry:', error)
    }
  }

  return (
    <div className="fixed inset-0 z-50 overflow-y-auto bg-black/60 px-4 py-6">
      <div className="min-h-full flex items-center justify-center">
      <div className="bg-surface p-6 w-full max-w-2xl">
        <div className="flex items-start justify-between mb-4">
          <div className="space-y-1">
            <h2 className="text-xl font-semibold text-ink">
              Add Recurring Entry
            </h2>
            <p className="text-sm text-muted">
              Project upcoming income or expenses so they feed into your budgets automatically.
            </p>
          </div>
          <button
            onClick={onClose}
            className="text-muted hover:text-body transition-colors duration-200"
            aria-label="Close allocation modal"
          >
            <svg className="h-6 w-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <form onSubmit={handleSubmit} onChange={handleFormChange} onInvalidCapture={handleInvalid} className="space-y-5">
              <div>
                <label className="block text-sm font-medium text-body">Name</label>
                <input
                  type="text"
                  value={subscriptionForm.name}
                  onChange={(e) => setSubscriptionForm((prev) => ({ ...prev, name: e.target.value }))}
                  className="mt-1 block w-full border border-line px-3 py-2"
                  required
                  ref={bindField('name')}
                  data-field="name"
                  {...fieldProps('name')}
                />
                {renderFieldError('name')}
                </div>
                
              <div>
                <label className="block text-sm font-medium text-body">Entry Type</label>
                <div className="mt-1 inline-flex bg-sunken p-1">
                  {(['expense', 'income'] as Array<'expense' | 'income'>).map((type) => {
                    const isActive = subscriptionForm.entry_type === type
                    return (
                      <button
                        type="button"
                        key={type}
                        onClick={() =>
                          setSubscriptionForm((prev) => ({
                            ...prev,
                            entry_type: type,
                            // Only an expense can be a recurring transfer; the picker hides for income.
                            transfer_to_account_id: type === 'expense' ? prev.transfer_to_account_id : undefined,
                          }))
                        }
                        className={`px-3 py-1 text-sm font-semibold transition ${ isActive ? 'bg-ink text-paper' : 'text-body hover:bg-sunken' }`}
                      >
                        {type === 'expense' ? 'Expense' : 'Income'}
                      </button>
                    )
                  })}
                </div>
                </div>
                
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div>
            <label className="block text-sm font-medium text-body">Account</label>
            <select
                    value={subscriptionForm.account_id}
                    onChange={(e) => handleSubscriptionAccountChange(parseInt(e.target.value))}
              className="mt-1 block w-full border border-line px-3 py-2"
              required
              ref={bindField('account_id')}
              data-field="account_id"
              {...fieldProps('account_id')}
            >
                    <option value={0}>Select account</option>
                    <PickerOptGroups
                      groups={accountPickerGroups(
                        writableAccounts
                          .filter((account) => account.account_type !== 'loan')
                          .filter((account) => {
                            // Paying a loan: only accounts in the loan's currency.
                            const destination = subscriptionForm.transfer_to_account_id
                              ? accountsById.get(subscriptionForm.transfer_to_account_id)
                              : undefined
                            return destination?.account_type !== 'loan' || account.currency === destination.currency
                          }),
                      )}
                    />
            </select>
            {renderFieldError('account_id')}
                </div>
                {editingBudgetEntry && isSharedFull(editingBudgetEntry) ? (
                <div>
                  <label className="block text-sm font-medium text-body">Category</label>
                  <p className="mt-1 py-2 text-sm text-body" data-testid="shared-category">
                    {editingBudgetEntry.category_name || 'Uncategorized'}
                  </p>
                </div>
                ) : (
                <div>
                  <label className="block text-sm font-medium text-body">Category</label>
                  <select
                    value={subscriptionForm.category_id ?? 0}
                    onChange={(e) =>
                      setSubscriptionForm((prev) => ({
                        ...prev,
                        category_id: parseInt(e.target.value) || undefined,
                      }))
                    }
                    className="mt-1 block w-full border border-line px-3 py-2"
                  >
                    <option value={0}>Uncategorized</option>
                    <PickerOptGroups groups={categoryPickerGroups(categories)} />
                  </select>
                </div>
                )}
          </div>

          {subscriptionForm.entry_type === 'expense' && (
            <div>
              <label className="block text-sm font-medium text-body">Overflow account (optional)</label>
              <select
                value={subscriptionForm.overflow_account_id ?? 0}
                onChange={(e) => setSubscriptionForm((prev) => ({ ...prev, overflow_account_id: parseInt(e.target.value) || undefined }))}
                className="mt-1 block w-full border border-line px-3 py-2"
              >
                <option value={0}>None</option>
                <PickerOptGroups
                  groups={accountPickerGroups(
                    writableAccounts.filter((a) => a.id !== subscriptionForm.account_id && a.account_type !== 'loan' && !a.is_spending_wallet),
                  )}
                />
              </select>
              <p className="mt-1 text-xs text-muted">If the primary account can't cover a payment, the shortfall is drawn from here.</p>
            </div>
          )}

          {subscriptionForm.entry_type === 'expense' && (
            <div>
              <label className="block text-sm font-medium text-body">Transfer to (optional)</label>
              <select
                value={subscriptionForm.transfer_to_account_id ?? 0}
                onChange={(e) => handleSubscriptionTransferToChange(parseInt(e.target.value) || undefined)}
                className="mt-1 block w-full border border-line px-3 py-2"
                disabled={accountsById.get(subscriptionForm.account_id)?.account_type === 'credit'}
              >
                <option value={0}>None (a payment)</option>
                <PickerOptGroups
                  groups={accountPickerGroups(
                    writableAccounts
                      .filter((a) => a.account_type !== 'credit' && a.id !== subscriptionForm.account_id)
                      .filter((a) => {
                        // A loan is paid only from an account in its own currency.
                        const source = accountsById.get(subscriptionForm.account_id)
                        return a.account_type !== 'loan' || !source || a.currency === source.currency
                      }),
                  )}
                />
              </select>
              <p className="mt-1 text-xs text-muted">
                Makes this a recurring transfer from the account above, e.g. moving money to the account a loan is
                paid from. Not available from or to a credit card. A loan is listed only when the account above is
                in its currency.
              </p>
            </div>
          )}

          <div>
                <label className="block text-sm font-medium text-body">Currency</label>
                <select
                  value={subscriptionForm.currency}
                  onChange={(e) =>
                    setSubscriptionForm((prev) => ({
                      ...prev,
                      currency: e.target.value as CurrencyCode,
                    }))
                  }
                  className="mt-1 block w-full border border-line px-3 py-2"
                  // A recurring loan payment is in the loan's currency.
                  disabled={
                    !!subscriptionForm.transfer_to_account_id &&
                    accountsById.get(subscriptionForm.transfer_to_account_id)?.account_type === 'loan'
                  }
                >
                  {currencyOptions.map((code) => (
                    <option key={code} value={code}>
                      {code}
                    </option>
                  ))}
                </select>
              </div>

          <div>
                <label className="block text-sm font-medium text-body">
                  Amount ({subscriptionForm.currency})
                </label>
            <input
                  type="number"
                  step="0.01"
                  min="0"
                  value={subscriptionForm.amount || ''}
                  onChange={(e) =>
                    setSubscriptionForm((prev) => ({
                      ...prev,
                      amount: parseFloat(e.target.value) || 0,
                    }))
                  }
              className="mt-1 block w-full border border-line px-3 py-2"
              required
              ref={bindField('amount')}
              data-field="amount"
              {...fieldProps('amount')}
            />
            {renderFieldError('amount')}
              </div>
          
              <RecurringScheduleFields
                draft={subscriptionForm}
                state={schedule}
                preview={schedulePreview}
                settlementControl={settlementControl}
                onChange={(update) => setSubscriptionForm((prev) => ({ ...prev, ...update(prev) }))}
                fieldProps={fieldProps}
                renderFieldError={renderFieldError}
                bindField={bindField}
                showFinalMonthHelp={
                  !!editingBudgetEntry &&
                  editingBudgetEntry.is_active &&
                  editingBudgetEntry.end_mode === 'after_occurrences' &&
                  (editingBudgetEntry.max_occurrences ?? 0) > 0
                }
                finalMonthHelp={finalMonthHelp}
                dateField={
                <div>
                  <label className="block text-sm font-medium text-body">Next Occurrence</label>
                  <input
                    type="datetime-local"
                    value={subscriptionForm.next_occurrence}
                    onChange={(e) =>
                      setSubscriptionForm((prev) => ({
                        ...prev,
                        next_occurrence: e.target.value,
                      }))
                    }
              className="mt-1 block w-full border border-line px-3 py-2"
              required
                  ref={bindField('next_occurrence')}
                  data-field="next_occurrence"
                  {...fieldProps('next_occurrence')}
                  />
                  {renderFieldError('next_occurrence')}
        </div>
                }
                beforeEnds={
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-body">Lead Time (days)</label>
                  <input
                    type="number"
                    min="0"
                    value={subscriptionForm.lead_time_days}
                    onChange={(e) =>
                      setSubscriptionForm((prev) => ({
                        ...prev,
                        lead_time_days: parseInt(e.target.value) || 0,
                      }))
                    }
                    className="mt-1 block w-full border border-line px-3 py-2"
                    ref={bindField('lead_time_days')}
                    data-field="lead_time_days"
                    {...fieldProps('lead_time_days')}
                  />
                  {renderFieldError('lead_time_days')}
              </div>
                {!(editingBudgetEntry && isSharedFull(editingBudgetEntry)) && (
                <div>
                  <label className="block text-sm font-medium text-body">Link to Budget (optional)</label>
                  <select
                    value={subscriptionForm.allocation_id ?? 0}
                    onChange={(e) =>
                      setSubscriptionForm((prev) => ({
                        ...prev,
                        allocation_id: parseInt(e.target.value, 10) || undefined,
                      }))
                    }
                    className="mt-1 block w-full border border-line px-3 py-2"
                  >
                    <option value={0}>No linked envelope</option>
                    {budgetEnvelopes.map((allocation) => (
                      <option key={allocation.id} value={allocation.id}>
                        {allocation.name}
                      </option>
                    ))}
                  </select>
                </div>
                )}
              </div>
                }
              />

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                {(!editingBudgetEntry || editingBudgetEntry.permissions.can_tag) && (
                  <TagPicker
                    value={subscriptionForm.tag_ids}
                    onChange={(tag_ids) => setSubscriptionForm((prev) => ({ ...prev, tag_ids }))}
                  />
                )}

                <div className="flex items-center justify-between border border-line px-4 py-3">
                  <div>
                    <p className="text-sm font-medium text-body">Entry status</p>
                    <p className="text-xs text-muted">Pause recurring entries without deleting them.</p>
                    {resuming && (
                      <p className="mt-1 text-xs text-muted" data-testid="recurring-resume-note">
                        Paused months are skipped. The next date moves to the first scheduled date on or after today.
                      </p>
                    )}
        </div>
                  <button
                    type="button"
                    onClick={() =>
                      setSubscriptionForm((prev) => ({
                        ...prev,
                        is_active: !prev.is_active,
                      }))
                    }
                    className={`inline-flex items-center gap-2 rounded-full px-3 py-1 text-sm font-semibold transition-colors duration-200 ${ subscriptionForm.is_active ? 'text-ink hover:bg-sunken' : 'bg-sunken text-body hover:bg-sunken' }`}
                  >
                    <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      {subscriptionForm.is_active ? (
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 9v6m4-6v6M5 5h14a2 2 0 012 2v10a2 2 0 01-2 2H5a2 2 0 01-2-2V7a2 2 0 012-2z" />
                      ) : (
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 5l10 7-10 7V5z" />
                      )}
                    </svg>
                    <span>{subscriptionForm.is_active ? 'Active' : 'Paused'}</span>
                  </button>
                </div>
  </div>

              <div>
                <label className="block text-sm font-medium text-body">Notes</label>
                <textarea
                  value={subscriptionForm.description}
                  onChange={(e) =>
                    setSubscriptionForm((prev) => ({
                      ...prev,
                      description: e.target.value,
                    }))
                  }
                  className="mt-1 block w-full border border-line px-3 py-2"
                  rows={3}
                />
              </div>

          {saveError && (
            <p className="text-sm text-danger" role="alert" data-testid="recurring-save-error">
              {saveError}
            </p>
          )}

          {savedNote !== null && (
            <div className="space-y-3" data-testid="recurring-settlement-note">
              <p className="text-sm text-danger" role="alert">{savedNote}</p>
              <button
                type="button"
                onClick={() => {
                  void (async () => {
                    try {
                      await onSaved()
                    } catch (error) {
                      console.error('Error reloading after saving the recurring entry:', error)
                    }
                  })()
                }}
                className="bg-ink text-paper py-2 px-4 hover:bg-ink"
                data-testid="recurring-settlement-note-close"
              >
                Close
              </button>
            </div>
          )}

          {savedNote === null && (
          <div className="flex flex-col sm:flex-row gap-3 pt-2">
            <button
              type="submit"
              className="flex-1 bg-ink text-paper py-2 px-4 hover:bg-ink"
            >
              {editingBudgetEntry ? 'Update Recurring Entry' : 'Save Recurring Entry'}
            </button>
            <button
              type="button"
              onClick={onClose}
              className="flex-1 bg-sunken text-body py-2 px-4 hover:bg-surface"
            >
              Cancel
            </button>
            {editingBudgetEntry && editingBudgetEntry.permissions.can_delete && (
              <button
                type="button"
                onClick={() => handleDelete(editingBudgetEntry)}
                className="text-danger py-2 px-4 hover:bg-sunken sm:w-auto"
              >
                Delete Recurring Entry
              </button>
            )}
          </div>
          )}
        </form>
      </div>
      </div>
    </div>
  )
}
