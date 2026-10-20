import { useMemo, useState } from 'react'
import {
  automaticOffered,
  buildEntryDayFields,
  categoryOptionLabel,
  dateForDaySetting,
  daySettingOf,
  formatEntryDate,
  fromWireWallTime,
  generateOccurrences,
  isCappedEnd,
  isMonthFamily,
  isOwnerFull,
  isSharedFull,
  kindChoiceFor,
  offeredKindChoices,
  parseEntryDate,
  resolveEntryDayFields,
  settleKindChoice,
  toWireWallTime,
} from '@tally-trace/shared'
import type { BillingKindChoice, DaySetting } from '@tally-trace/shared'
import { useCreateBudgetEntryMutation, useUpdateBudgetEntryMutation } from '../store/api'
import type { Account, Allocation, BudgetEntry, Category, FullBudgetEntry, SharedFullBudgetEntry } from '../store/api'
import { useCurrency } from '../hooks/useCurrency'
import { useDeleteRecurringEntry } from '../hooks/useDeleteRecurringEntry'
import { CurrencyCode, CURRENCY_CONFIGS } from '../utils/currency'
import { formatCadenceLabel, formatScheduleLabel } from '../utils/recurringEntry'
import { tagIdsIfChanged, tagIdsOf } from '../utils/tags'
import { TagPicker } from './TagPicker'

const toLocalDateTimeInput = (value: Date | string) => {
  const date = typeof value === 'string' ? new Date(value) : value
  return new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16)
}

/** Far enough ahead that the schedule preview is bounded by its count alone. */
const PREVIEW_RANGE_END = new Date(Date.UTC(9999, 11, 31))

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
  is_autopay: boolean
  is_active: boolean
  end_mode: 'indefinite' | 'on_date' | 'after_occurrences'
  end_date?: string
  max_occurrences?: number
  /** Card expenses: the pick in the kind select (what `billingKindChoices` offers). */
  kind_choice: BillingKindChoice['id']
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
  is_autopay: true,
  is_active: true,
  end_mode: 'indefinite',
  end_date: undefined,
  max_occurrences: undefined,
  kind_choice: 'automatic',
  day: { kind: 'same_as_date' },
  tag_ids: [],
})

interface RecurringEntryFormModalProps {
  /** The entry to edit, or null to add one. An entry the caller can edit is never Limited. */
  entry: FullBudgetEntry | SharedFullBudgetEntry | null
  accounts: Account[]
  categories: Category[]
  /** The budget envelopes an entry can link to. */
  budgetEnvelopes: Allocation[]
  onClose: () => void
  onSaved: () => void | Promise<void>
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
  onDeleted,
}: RecurringEntryFormModalProps) {
  const { currencyCode: defaultCurrencyCode } = useCurrency()
  const currencyOptions = useMemo(() => Object.keys(CURRENCY_CONFIGS) as CurrencyCode[], [])
  const [createBudgetEntry] = useCreateBudgetEntryMutation()
  const [updateBudgetEntry] = useUpdateBudgetEntryMutation()
  const deleteRecurringEntry = useDeleteRecurringEntry()

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
      is_autopay: entry.is_autopay,
      is_active: entry.is_active,
      end_mode: (entry.end_mode as SubscriptionFormState['end_mode']) ?? 'indefinite',
      end_date: entry.end_date ? fromWireWallTime(entry.end_date) : undefined,
      max_occurrences: entry.max_occurrences ?? undefined,
      kind_choice: kindChoiceFor(isCappedEnd(entry.end_mode, entry.max_occurrences), entry.billing_kind),
      day: daySettingOf(entry),
      tag_ids: tagIdsOf(entry.tags),
    }
  })

  const showKindSelect =
    subscriptionForm.entry_type === 'expense' &&
    !subscriptionForm.transfer_to_account_id &&
    accountsById.get(subscriptionForm.account_id)?.account_type === 'credit'
  const kindCapped = isCappedEnd(subscriptionForm.end_mode, subscriptionForm.max_occurrences)
  // The pick the form opened on: an edit sends the field only when the pick moved off it.
  const openingKindChoice = editingBudgetEntry
    ? kindChoiceFor(isCappedEnd(editingBudgetEntry.end_mode, editingBudgetEntry.max_occurrences), editingBudgetEntry.billing_kind)
    : null
  // "Automatic" cannot undo a stored kind, so it is offered only to an entry with none stored.
  const offerAutomatic = automaticOffered(editingBudgetEntry?.billing_kind)
  const kindChoices = offeredKindChoices(kindCapped, offerAutomatic)
  // What the select shows and a save sends: always one of the offered choices.
  const kindValue = settleKindChoice(kindCapped, subscriptionForm.kind_choice, offerAutomatic)

  // The schedule a save would store: the day fields the API resolves the write to
  // (or the detail it would refuse it with), and the next three dates.
  const schedulePreview = useMemo(() => {
    if (!isMonthFamily(subscriptionForm.cadence)) return null
    let nextOccurrence: string
    try {
      nextOccurrence = toWireWallTime(subscriptionForm.next_occurrence)
    } catch {
      return null
    }
    const resolved = resolveEntryDayFields({
      cadence: subscriptionForm.cadence,
      nextOccurrence,
      sent: buildEntryDayFields({
        cadence: subscriptionForm.cadence,
        day: subscriptionForm.day,
        nextOccurrence,
        stored: editingBudgetEntry,
      }),
      stored: editingBudgetEntry,
    })
    if (!resolved.ok) return { error: resolved.error }
    let endDate: string | null = null
    if (subscriptionForm.end_mode === 'on_date' && subscriptionForm.end_date) {
      try {
        endDate = toWireWallTime(subscriptionForm.end_date)
      } catch {
        endDate = null
      }
    }
    const dates = generateOccurrences(
      {
        cadence: subscriptionForm.cadence,
        next_occurrence: nextOccurrence,
        anchor_day: resolved.anchor_day,
        day_rule: resolved.day_rule,
        end_mode: subscriptionForm.end_mode,
        end_date: endDate,
        max_occurrences: subscriptionForm.end_mode === 'after_occurrences' ? subscriptionForm.max_occurrences ?? null : null,
      },
      parseEntryDate(nextOccurrence),
      PREVIEW_RANGE_END,
      3
    )
    return {
      label: formatScheduleLabel(subscriptionForm.cadence, resolved),
      dates: dates.map((date) => formatEntryDate(date)),
    }
  }, [
    editingBudgetEntry,
    subscriptionForm.cadence,
    subscriptionForm.day,
    subscriptionForm.next_occurrence,
    subscriptionForm.end_mode,
    subscriptionForm.end_date,
    subscriptionForm.max_occurrences,
  ])
  // "Same as date" is offered on create and on a row with no stored day (a legacy row).
  const offersSameAsDate = !editingBudgetEntry || daySettingOf(editingBudgetEntry).kind === 'same_as_date'
  const chooseDay = (day: DaySetting) =>
    setSubscriptionForm((prev) => ({
      ...prev,
      day,
      next_occurrence: dateForDaySetting(prev.next_occurrence, day),
    }))

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
    try {
      if (!subscriptionForm.name.trim()) {
        alert('Please provide a name for the recurring entry.')
        return
      }
      if (!subscriptionForm.account_id) {
        alert('Please select an account to post this recurring entry into.')
        return
      }
      if (subscriptionForm.amount <= 0) {
        alert('Please enter an amount greater than zero.')
        return
      }
      if (!subscriptionForm.next_occurrence) {
        alert('Please choose the next occurrence date and time.')
        return
      }

      // The dates go out as the typed wall time in UTC components.
      let nextOccurrenceWire: string
      try {
        nextOccurrenceWire = toWireWallTime(subscriptionForm.next_occurrence)
      } catch {
        alert('Please choose a valid next occurrence date and time.')
        return
      }

      let endDateIso: string | undefined
      let maxOccurrences: number | undefined
      if (subscriptionForm.end_mode === 'on_date') {
        if (!subscriptionForm.end_date) {
          alert('Please select the end date.')
          return
        }
        try {
          endDateIso = toWireWallTime(subscriptionForm.end_date)
        } catch {
          alert('Please choose a valid end date.')
          return
        }
      } else if (subscriptionForm.end_mode === 'after_occurrences') {
        if (!subscriptionForm.max_occurrences || subscriptionForm.max_occurrences <= 0) {
          alert('Please specify how many occurrences before the entry stops.')
          return
        }
        maxOccurrences = Math.floor(subscriptionForm.max_occurrences)
      }

      const dayFields = buildEntryDayFields({
        cadence: subscriptionForm.cadence,
        day: subscriptionForm.day,
        nextOccurrence: nextOccurrenceWire,
        stored: editingBudgetEntry,
      })
      const resolvedDay = resolveEntryDayFields({
        cadence: subscriptionForm.cadence,
        nextOccurrence: nextOccurrenceWire,
        sent: dayFields,
        stored: editingBudgetEntry,
      })
      if (!resolvedDay.ok) {
        alert(resolvedDay.error)
        return
      }

      const pickedBillingKind =
        showKindSelect && kindValue !== openingKindChoice
          ? kindChoices.find((choice) => choice.id === kindValue)?.billingKind
          : undefined

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
        cadence: subscriptionForm.cadence,
        next_occurrence: nextOccurrenceWire,
        ...dayFields,
        lead_time_days: subscriptionForm.lead_time_days,
        is_autopay: subscriptionForm.is_autopay,
        is_active: subscriptionForm.is_active,
        end_mode: subscriptionForm.end_mode,
        end_date: endDateIso,
        max_occurrences: maxOccurrences,
        // Card expenses only. "Automatic" sends nothing; Installment sends null, which clears an override.
        // An edit sends the kind only when the pick moved.
        ...(pickedBillingKind === undefined ? {} : { billing_kind: pickedBillingKind }),
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
        await updateBudgetEntry({ id: editingBudgetEntry.id, data }).unwrap()
      } else {
        await createBudgetEntry(subscriptionPayload).unwrap()
      }
      await onSaved()
    } catch (error) {
      console.error('Error saving allocation data:', error)
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

        <form onSubmit={handleSubmit} className="space-y-5">
              <div>
                <label className="block text-sm font-medium text-body">Name</label>
                <input
                  type="text"
                  value={subscriptionForm.name}
                  onChange={(e) => setSubscriptionForm((prev) => ({ ...prev, name: e.target.value }))}
                  className="mt-1 block w-full border border-line px-3 py-2"
                  required
                />
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
            >
                    <option value={0}>Select account</option>
                    {writableAccounts
                      .filter((account) => account.account_type !== 'loan')
                      .filter((account) => {
                        // Paying a loan: only accounts in the loan's currency.
                        const destination = subscriptionForm.transfer_to_account_id
                          ? accountsById.get(subscriptionForm.transfer_to_account_id)
                          : undefined
                        return destination?.account_type !== 'loan' || account.currency === destination.currency
                      })
                      .map((account) => (
                <option key={account.id} value={account.id}>
                  {account.name}
                </option>
              ))}
            </select>
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
                    {categories.map((category) => (
                      <option key={category.id} value={category.id}>
                        {categoryOptionLabel(category, categories)}
                      </option>
                    ))}
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
                {writableAccounts.filter((a) => a.id !== subscriptionForm.account_id && a.account_type !== 'loan' && !a.is_spending_wallet).map((account) => (
                  <option key={account.id} value={account.id}>{account.name}</option>
                ))}
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
                {writableAccounts
                  .filter((a) => a.account_type !== 'credit' && a.id !== subscriptionForm.account_id)
                  .filter((a) => {
                    // A loan is paid only from an account in its own currency.
                    const source = accountsById.get(subscriptionForm.account_id)
                    return a.account_type !== 'loan' || !source || a.currency === source.currency
                  })
                  .map((account) => (
                    <option key={account.id} value={account.id}>{account.name}</option>
                  ))}
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
            />
              </div>
          
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div>
                  <label className="block text-sm font-medium text-body">Cadence</label>
            <select
                    value={subscriptionForm.cadence}
                    onChange={(e) =>
                      setSubscriptionForm((prev) => ({
                        ...prev,
                        cadence: e.target.value as BudgetEntry['cadence'],
                      }))
                    }
                    className="mt-1 block w-full border border-line px-3 py-2"
                  >
                    {(['monthly', 'quarterly', 'semi_annual', 'annual'] as BudgetEntry['cadence'][]).map(
                      (value) => (
                        <option key={value} value={value}>
                          {formatCadenceLabel(value)}
                        </option>
                      )
                    )}
                  </select>
          </div>
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
                  />
        </div>
              </div>

              {isMonthFamily(subscriptionForm.cadence) && (
                <div className="space-y-2">
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                    <div>
                      <label className="block text-sm font-medium text-body">Day</label>
                      <select
                        value={subscriptionForm.day.kind}
                        onChange={(e) => {
                          const kind = e.target.value as DaySetting['kind']
                          if (kind === 'day') {
                            // Start from the date's own day, so the date stays put.
                            const day = parseEntryDate(subscriptionForm.next_occurrence).getUTCDate()
                            chooseDay({ kind: 'day', day: Number.isNaN(day) ? 1 : day })
                          } else {
                            chooseDay({ kind })
                          }
                        }}
                        className="mt-1 block w-full border border-line px-3 py-2"
                      >
                        {offersSameAsDate && <option value="same_as_date">Same as date</option>}
                        <option value="day">Day of month (1–31)</option>
                        <option value="last_weekday">Last weekday of month</option>
                      </select>
                    </div>
                    {subscriptionForm.day.kind === 'day' && (
                      <div>
                        <label className="block text-sm font-medium text-body">Day of month</label>
                        <input
                          type="number"
                          min={1}
                          max={31}
                          value={subscriptionForm.day.day}
                          onChange={(e) => {
                            const day = parseInt(e.target.value, 10)
                            if (Number.isNaN(day)) return
                            chooseDay({ kind: 'day', day: Math.min(31, Math.max(1, day)) })
                          }}
                          className="mt-1 block w-full border border-line px-3 py-2"
                        />
                      </div>
                    )}
                  </div>
                  {schedulePreview && 'error' in schedulePreview ? (
                    <p className="text-xs text-danger" data-testid="schedule-error">
                      {schedulePreview.error}
                    </p>
                  ) : schedulePreview ? (
                    <div className="text-xs text-muted" data-testid="schedule-preview">
                      <p className="font-medium text-body">{schedulePreview.label}</p>
                      {schedulePreview.dates.length > 0 && <p>Next: {schedulePreview.dates.join(', ')}</p>}
                    </div>
                  ) : null}
                </div>
              )}

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
                  />
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

              <div className="space-y-3">
                <div>
                  <label className="block text-sm font-medium text-body">Ends</label>
                  <div className="mt-1 flex flex-wrap gap-2">
                    {[
                      { value: 'indefinite', label: 'Keep running' },
                      { value: 'on_date', label: 'On date' },
                      { value: 'after_occurrences', label: 'After runs' },
                    ].map(({ value, label }) => {
                      const isSelected = subscriptionForm.end_mode === value
                      return (
                        <button
                          type="button"
                          key={value}
                          onClick={() =>
                            setSubscriptionForm((prev) => ({
                              ...prev,
                              end_mode: value as SubscriptionFormState['end_mode'],
                              kind_choice: settleKindChoice(value === 'after_occurrences', kindValue, offerAutomatic),
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

                {subscriptionForm.end_mode === 'on_date' && (
                  <div>
                    <label className="block text-sm font-medium text-body">End after</label>
                    <input
                      type="datetime-local"
                      value={subscriptionForm.end_date ?? ''}
                      onChange={(e) =>
                        setSubscriptionForm((prev) => ({
                          ...prev,
                          end_date: e.target.value || undefined,
                        }))
                      }
                      className="mt-1 block w-full border border-line px-3 py-2"
                    />
                    <p className="mt-1 text-xs text-muted">
                      No additional transactions will be generated after this date.
                    </p>
                  </div>
                )}

                {subscriptionForm.end_mode === 'after_occurrences' && (
                  <div>
                    <label className="block text-sm font-medium text-body">Number of runs</label>
                    <input
                      type="number"
                      min={1}
                      value={subscriptionForm.max_occurrences ?? ''}
                      onChange={(e) =>
                        setSubscriptionForm((prev) => ({
                          ...prev,
                          max_occurrences: e.target.value ? Math.max(1, parseInt(e.target.value, 10)) : undefined,
                        }))
                      }
                      className="mt-1 block w-full border border-line px-3 py-2"
                    />
                    <p className="mt-1 text-xs text-muted">
                      Stop once this many transactions have been created.
                    </p>
                  </div>
                )}
              </div>

              {showKindSelect && (
                <div>
                  <label className="block text-sm font-medium text-body" htmlFor="recurring-kind">Kind</label>
                  <select
                    id="recurring-kind"
                    value={kindValue}
                    onChange={(e) =>
                      setSubscriptionForm((prev) => ({
                        ...prev,
                        kind_choice: e.target.value as BillingKindChoice['id'],
                      }))
                    }
                    className="mt-1 block w-full border border-line px-3 py-2"
                    data-testid="recurring-kind"
                  >
                    {kindChoices.map((choice) => (
                      <option key={choice.id} value={choice.id}>{choice.label}</option>
                    ))}
                  </select>
                  <p className="mt-1 text-xs text-muted">
                    {kindCapped
                      ? 'An installment has a fixed amount; a bill varies, and you enter the amount charged each time.'
                      : 'A subscription posts a fixed amount; a bill varies, and you enter the amount charged each time.'}
                  </p>
                </div>
              )}

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div className="flex items-center justify-between border border-line px-4 py-3">
          <div>
                    <p className="text-sm font-medium text-body">Autopay</p>
                    <p className="text-xs text-muted">Mark if the charge posts automatically.</p>
                  </div>
                  <button
                    type="button"
                    onClick={() =>
                      setSubscriptionForm((prev) => ({
                        ...prev,
                        is_autopay: !prev.is_autopay,
                      }))
                    }
                    className={`inline-flex items-center gap-2 rounded-full px-3 py-1 text-sm font-semibold transition-colors duration-200 ${ subscriptionForm.is_autopay ? 'text-ink hover:bg-sunken' : 'bg-sunken text-body hover:bg-sunken' }`}
                  >
                    <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      {subscriptionForm.is_autopay ? (
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                      ) : (
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                      )}
                    </svg>
                    <span>{subscriptionForm.is_autopay ? 'Enabled' : 'Disabled'}</span>
                  </button>
          </div>

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
        </form>
      </div>
      </div>
    </div>
  )
}
