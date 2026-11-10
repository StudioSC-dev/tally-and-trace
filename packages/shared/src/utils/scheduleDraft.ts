import type { BillingKind, DayRule, EndMode, RecurrenceFrequency, RecurringKind, RepeatScheduleInput, Settlement } from '../types/api'
import { manilaToday } from './cardPay'
import { formatEntryDate, parseEntryDate, toWireWallTime } from './entryDate'
import {
  buildEntryDayFields,
  daySettingOf,
  resolveEntryDayFields,
  weekdayOf,
  WEEKDAY_NAMES,
  type DaySetting,
  type EntryDayFields,
  type StoredDayRow,
} from './entryDayFields'
import { statementCloseDay, statementCycleClose, type StatementCycleSettings } from './markPaid'
import { generateOccurrences, isMonthFamily, lastWeekday } from './recurrence'
import {
  automaticOffered,
  isCappedEnd,
  kindChoiceFor,
  offeredKindChoices,
  settleKindChoice,
  type BillingKindChoice,
} from './recurringKinds'

/**
 * The schedule half of a recurring entry as a form holds it: the recurring entry
 * form (`RecurringEntryFormModal`) and Repeat in the Add Transaction dialog share it,
 * with the controls in `RecurringScheduleFields`.
 */

/** Open-ended bank (non-card) expenses: Subscription stores `billing_kind: 'subscription'`; Other stores null. */
export type BankKind = 'subscription' | 'other'

/** The bank-kind pick a stored `billing_kind` reads as: only `subscription` is a subscription. */
export const bankKindOf = (billingKind: BillingKind | null | undefined): BankKind =>
  billingKind === 'subscription' ? 'subscription' : 'other'

export interface ScheduleDraft {
  cadence: RecurrenceFrequency
  /** The first (next) occurrence, as a `datetime-local` value (wall time). */
  next_occurrence: string
  /** Month-family cadences: the Day control. */
  day: DaySetting
  end_mode: EndMode
  /** `datetime-local` value; read only when `end_mode` is `on_date`. */
  end_date?: string
  max_occurrences?: number
  /** Card expenses: the pick in the kind select (what `billingKindChoices` offers). */
  kind_choice: BillingKindChoice['id']
  /** Open-ended bank expenses: Subscription or Other. */
  bank_kind: BankKind
  /** Cash expenses: how it settles. */
  settlement: Settlement
}

/** The stored entry an edit loaded: what the day, kind and installment rules read from it. */
export interface StoredSchedule extends StoredDayRow {
  end_mode: string
  max_occurrences?: number | null
  billing_kind?: BillingKind | null
  kind?: RecurringKind | null
  account_id?: number
}

export interface ScheduleContext {
  /** The entry being edited, or null when adding one. */
  stored: StoredSchedule | null
  entryType: 'income' | 'expense'
  /** A recurring transfer's destination. */
  transferToAccountId?: number | null
  /** The account picked, with its type and statement cycle (undefined: none picked). */
  account: (StatementCycleSettings & { account_type: string }) | undefined
  accountId: number
  /**
   * The first occurrence is fixed (Repeat in Add Transaction: the transaction's own
   * date). The Day control offers only what that date satisfies, semi-monthly is not
   * offered and the preview counts what a past date leaves missed.
   */
  dateFixed?: boolean
}

/** What the schedule controls show for a draft in its context. */
export interface ScheduleState {
  /** The cadence a save sends: a card installment on create is always monthly. */
  cadence: RecurrenceFrequency
  cadenceChoices: RecurrenceFrequency[]
  showKindSelect: boolean
  showBankKindSelect: boolean
  kindCapped: boolean
  offerAutomatic: boolean
  kindChoices: BillingKindChoice[]
  /** What the kind select shows and a save sends: always one of `kindChoices`. */
  kindValue: BillingKindChoice['id']
  /** The card's statement close day, for a credit account with a statement cycle. */
  cardCloseDay: number | null
  /** A card installment being added: the server anchors it on the statement close. */
  cardInstallmentCreate: boolean
  /** The cadence and Day controls give way to the "Charged monthly on each statement close" note. */
  chargedOnClose: boolean
  /** The Day select's options, in order. */
  dayChoices: DaySetting['kind'][]
  /** The Day control's value: `draft.day`, or "Same as date" where a fixed date can't keep it. */
  day: DaySetting
}

/** The cadences the recurring form offers. */
const FORM_CADENCES: RecurrenceFrequency[] = ['weekly', 'biweekly', 'monthly', 'quarterly', 'semi_annual', 'annual']

/** The cadence select's options. A fixed date never offers semi-monthly: its two days are not that date. */
export function cadenceChoices(ctx: Pick<ScheduleContext, 'dateFixed'>): RecurrenceFrequency[] {
  return ctx.dateFixed ? FORM_CADENCES.filter((cadence) => cadence !== 'semi_monthly') : [...FORM_CADENCES]
}

/** Whether a `datetime-local` (or wire) value falls on its month's last weekday. */
export function isLastWeekdayOfMonth(value: string): boolean {
  const on = parseEntryDate(value)
  if (Number.isNaN(on.getTime())) return false
  return lastWeekday(on.getUTCFullYear(), on.getUTCMonth() + 1).getUTCDate() === on.getUTCDate()
}

export function scheduleState(draft: ScheduleDraft, ctx: ScheduleContext): ScheduleState {
  const { stored, account } = ctx
  const isCardExpense = ctx.entryType === 'expense' && !ctx.transferToAccountId
  const showKindSelect = isCardExpense && account?.account_type === 'credit'
  const kindCapped = isCappedEnd(draft.end_mode, draft.max_occurrences)
  // An open-ended expense on a bank (non-card) account: the user marks whether it is a subscription.
  const showBankKindSelect =
    isCardExpense && account !== undefined && account.account_type !== 'credit' && draft.end_mode === 'indefinite'
  // "Automatic" cannot undo a stored kind, so it is offered only to an entry with none stored.
  const offerAutomatic = automaticOffered(stored?.billing_kind)
  const kindChoices = offeredKindChoices(kindCapped, offerAutomatic)
  const kindValue = settleKindChoice(kindCapped, draft.kind_choice, offerAutomatic)

  // A card installment on a card with a statement cycle is charged monthly on the
  // statement close. On create the server anchors it there and moves the date onto
  // its statement's close, so no day fields are sent and the cadence is monthly. An
  // installment already on the close shows the same note in place of the pickers.
  const cardCloseDay = account?.account_type === 'credit' ? statementCloseDay(account) : null
  const cardInstallmentCreate =
    !stored && cardCloseDay !== null && isCardExpense && kindCapped && kindValue !== 'bill'
  const onCloseEdit =
    stored != null &&
    cardCloseDay !== null &&
    stored.kind === 'installment' &&
    stored.account_id === ctx.accountId &&
    stored.cadence === 'monthly' &&
    stored.anchor_day === cardCloseDay &&
    !stored.day_rule
  const chargedOnClose = cardInstallmentCreate || onCloseEdit

  let dayChoices: DaySetting['kind'][]
  let day = draft.day
  if (ctx.dateFixed) {
    // The date is the first occurrence: only what it already satisfies.
    dayChoices = isLastWeekdayOfMonth(draft.next_occurrence) ? ['same_as_date', 'last_weekday'] : ['same_as_date']
    if (!dayChoices.includes(day.kind)) day = { kind: 'same_as_date' }
  } else {
    // "Same as date" is offered on create and on a row with no stored day (a legacy row).
    const offersSameAsDate = !stored || daySettingOf(stored).kind === 'same_as_date'
    dayChoices = offersSameAsDate ? ['same_as_date', 'day', 'last_weekday'] : ['day', 'last_weekday']
  }

  return {
    cadence: cardInstallmentCreate ? 'monthly' : draft.cadence,
    cadenceChoices: cadenceChoices(ctx),
    showKindSelect,
    showBankKindSelect,
    kindCapped,
    offerAutomatic,
    kindChoices,
    kindValue,
    cardCloseDay,
    cardInstallmentCreate,
    chargedOnClose,
    dayChoices,
    day,
  }
}

/** The schedule fields a write sends (`POST /budget-entries/`, PUT, or `repeat` of `POST /transactions/repeating`). */
export interface ScheduleFields extends EntryDayFields {
  cadence: RecurrenceFrequency
  /** The wire value (UTC components). Not part of `repeat`, whose first occurrence is the transaction's date. */
  next_occurrence: string
  end_mode: EndMode
  end_date: string | undefined
  max_occurrences: number | undefined
  /** Card or bank kind; absent leaves it as it is (or to the server, on create). */
  billing_kind?: BillingKind | null
}

/** The control a refused schedule names. */
export type ScheduleField = 'next_occurrence' | 'end_date' | 'max_occurrences' | 'day'

export type ScheduleRequest =
  | { ok: true; fields: ScheduleFields }
  | { ok: false; field: ScheduleField; message: string }

/**
 * The schedule fields a save sends, or the field and message it is refused with
 * before any request: the recurring form's own checks, in its order (the date,
 * the ends, then the day).
 */
export function scheduleRequest(draft: ScheduleDraft, ctx: ScheduleContext): ScheduleRequest {
  const state = scheduleState(draft, ctx)
  const { stored } = ctx
  if (!draft.next_occurrence) {
    return { ok: false, field: 'next_occurrence', message: 'Please choose the next occurrence date and time.' }
  }
  // The dates go out as the typed wall time in UTC components.
  let nextOccurrence: string
  try {
    nextOccurrence = toWireWallTime(draft.next_occurrence)
  } catch {
    return { ok: false, field: 'next_occurrence', message: 'Please choose a valid next occurrence date and time.' }
  }

  let endDate: string | undefined
  let maxOccurrences: number | undefined
  if (draft.end_mode === 'on_date') {
    if (!draft.end_date) return { ok: false, field: 'end_date', message: 'Please select the end date.' }
    try {
      endDate = toWireWallTime(draft.end_date)
    } catch {
      return { ok: false, field: 'end_date', message: 'Please choose a valid end date.' }
    }
  } else if (draft.end_mode === 'after_occurrences') {
    if (!draft.max_occurrences || draft.max_occurrences <= 0) {
      return { ok: false, field: 'max_occurrences', message: 'Please specify how many occurrences before the entry stops.' }
    }
    maxOccurrences = Math.floor(draft.max_occurrences)
  }

  const dayFields = buildEntryDayFields({
    cadence: state.cadence,
    day: state.day,
    nextOccurrence,
    stored,
    cardInstallment: state.cardInstallmentCreate,
  })
  const resolvedDay = resolveEntryDayFields({ cadence: state.cadence, nextOccurrence, sent: dayFields, stored })
  if (!resolvedDay.ok) {
    return {
      ok: false,
      field: isMonthFamily(state.cadence) && !state.chargedOnClose ? 'day' : 'next_occurrence',
      message: resolvedDay.error,
    }
  }

  // An edit sends a kind only when the pick moved off the one it opened on.
  const openingKindChoice = stored
    ? kindChoiceFor(isCappedEnd(stored.end_mode, stored.max_occurrences), stored.billing_kind)
    : null
  const pickedBillingKind =
    state.showKindSelect && state.kindValue !== openingKindChoice
      ? state.kindChoices.find((choice) => choice.id === state.kindValue)?.billingKind
      : undefined
  const openingBankKind = stored ? bankKindOf(stored.billing_kind) : null
  const pickedBankKind: BillingKind | null | undefined =
    state.showBankKindSelect && draft.bank_kind !== openingBankKind
      ? draft.bank_kind === 'subscription'
        ? 'subscription'
        : null
      : undefined

  return {
    ok: true,
    fields: {
      cadence: state.cadence,
      next_occurrence: nextOccurrence,
      ...dayFields,
      end_mode: draft.end_mode,
      end_date: endDate,
      max_occurrences: maxOccurrences,
      // Card expenses: "Automatic" sends nothing; Installment sends null, which clears an override.
      ...(pickedBillingKind === undefined ? {} : { billing_kind: pickedBillingKind }),
      // Open-ended bank expenses: Subscription or Other (null).
      ...(pickedBankKind === undefined ? {} : { billing_kind: pickedBankKind }),
    },
  }
}

/** Far enough ahead that the schedule preview is bounded by its count alone. */
const PREVIEW_RANGE_END = new Date(Date.UTC(9999, 11, 31))
/** Enough steps for a monthly schedule from the earliest record date to today. */
const MISSED_COUNT_LIMIT = 1000

export type SchedulePreview =
  | { error: string }
  | {
      /** "Monthly · day 15". */
      label: string
      /** The next three dates, from the first. */
      dates: string[]
      /** A fixed past date: the line about the payments between it and today, or null. */
      missed: string | null
    }

/** A cadence's name: "Monthly", "Semi-Annual". */
export const formatCadenceLabel = (value: string) => {
  switch (value) {
    case 'daily':
      return 'Daily'
    case 'weekly':
      return 'Weekly'
    case 'biweekly':
      return 'Every 2 weeks'
    case 'semi_monthly':
      return 'Twice a month'
    case 'monthly':
      return 'Monthly'
    case 'quarterly':
      return 'Quarterly'
    case 'semi_annual':
      return 'Semi-Annual'
    case 'annual':
      return 'Annual'
    default:
      return value
  }
}

/**
 * "Monthly · last weekday" / "Monthly · day 31" / "Weekly · Tuesday" (the weekday of
 * `next_occurrence`); a legacy entry is just its cadence.
 */
export const formatScheduleLabel = (
  cadence: string,
  fields: { anchor_day?: number | null; day_rule?: DayRule | null; next_occurrence?: string | null },
) => {
  const cadenceLabel = formatCadenceLabel(cadence)
  if ((cadence === 'weekly' || cadence === 'biweekly') && fields.next_occurrence) {
    const weekday = weekdayOf(fields.next_occurrence)
    if (weekday !== null) return `${cadenceLabel} · ${WEEKDAY_NAMES[weekday]}`
  }
  if (fields.day_rule === 'last_weekday') return `${cadenceLabel} · last weekday`
  if (fields.anchor_day) return `${cadenceLabel} · day ${fields.anchor_day}`
  return cadenceLabel
}

/**
 * The schedule a save would store: its label and next three dates, or the detail the
 * API would refuse its day with. Null when there is nothing to show (no readable date). With a fixed date before `today`
 * (Manila's), the occurrences after the first and before today are counted: they
 * will show as missed.
 */
export function schedulePreview(
  draft: ScheduleDraft,
  ctx: ScheduleContext,
  today: string = manilaToday(),
): SchedulePreview | null {
  const state = scheduleState(draft, ctx)
  const { cadence } = state
  let nextOccurrence: string
  try {
    nextOccurrence = toWireWallTime(draft.next_occurrence)
  } catch {
    return null
  }
  if (state.cardInstallmentCreate && ctx.account) {
    // What the server stores: the close of the statement the date is on.
    const close = statementCycleClose(ctx.account, nextOccurrence)
    if (close !== null) nextOccurrence = `${close}${nextOccurrence.slice(10)}`
  }
  const resolved =
    state.cardInstallmentCreate && state.cardCloseDay !== null
      ? ({ ok: true, anchor_day: state.cardCloseDay, day_rule: null } as const)
      : resolveEntryDayFields({
          cadence,
          nextOccurrence,
          sent: buildEntryDayFields({ cadence, day: state.day, nextOccurrence, stored: ctx.stored }),
          stored: ctx.stored,
        })
  if (!resolved.ok) return { error: resolved.error }
  let endDate: string | null = null
  if (draft.end_mode === 'on_date' && draft.end_date) {
    try {
      endDate = toWireWallTime(draft.end_date)
    } catch {
      endDate = null
    }
  }
  const schedule = {
    cadence,
    next_occurrence: nextOccurrence,
    anchor_day: resolved.anchor_day,
    day_rule: resolved.day_rule,
    end_mode: draft.end_mode,
    end_date: endDate,
    max_occurrences: draft.end_mode === 'after_occurrences' ? draft.max_occurrences ?? null : null,
  }
  const first = parseEntryDate(nextOccurrence)
  const dates = generateOccurrences(schedule, first, PREVIEW_RANGE_END, 3)
  let missed: string | null = null
  if (ctx.dateFixed) {
    // Every step after the first that lands on a day before today is left unrecorded.
    const beforeToday = new Date(Date.parse(`${today}T00:00:00Z`) - 1)
    const passed = beforeToday >= first ? generateOccurrences(schedule, first, beforeToday, MISSED_COUNT_LIMIT).length - 1 : 0
    if (passed > 0) {
      missed = `${passed} ${passed === 1 ? 'payment' : 'payments'} between then and today will show as missed`
    }
  }
  return {
    label: formatScheduleLabel(cadence, { ...resolved, next_occurrence: nextOccurrence }),
    dates: dates.map((date) => formatEntryDate(date)),
    missed,
  }
}

/**
 * `repeat` of `POST /transactions/repeating`: the schedule fields without the date (the
 * first occurrence is the transaction's own date) and with the settlement picked.
 */
export function repeatScheduleOf(fields: ScheduleFields, settlement: Settlement): RepeatScheduleInput {
  const { next_occurrence: _firstOccurrence, ...repeat } = fields
  return { ...repeat, settlement }
}

/** Where a refused `POST /transactions/repeating` points: the first error's request location. */
export interface RepeatingRefusal {
  /** `transaction` or `repeat` for a 422 with a request location, else null. */
  part: 'transaction' | 'repeat' | null
  /** The field inside that part (`description`, `max_occurrences`), or null (the part as a whole). */
  field: string | null
  message: string
}

/**
 * The first error of a refused repeating save. A validation list (422) carries
 * `loc` = `["body", "transaction" | "repeat", field, ...]`; a string detail (a
 * refusal by a rule) names no field.
 */
export function repeatingRefusal(detail: unknown): RepeatingRefusal | null {
  if (typeof detail === 'string') return { part: null, field: null, message: detail }
  if (!Array.isArray(detail) || detail.length === 0) return null
  const first = detail[0] as { loc?: unknown; msg?: unknown }
  const message = typeof first?.msg === 'string' ? first.msg : ''
  const loc = Array.isArray(first?.loc) ? first.loc : []
  const part = loc[0] === 'body' && (loc[1] === 'transaction' || loc[1] === 'repeat') ? loc[1] : null
  const field = part !== null && typeof loc[2] === 'string' ? loc[2] : null
  return { part, field, message }
}

/** A Repeat schedule control that can carry a refused field's error. */
export type RepeatControl = 'cadence' | 'day' | 'end_mode' | 'end_date' | 'max_occurrences' | 'kind' | 'settlement'

/**
 * The schedule control a refused `repeat` field is shown on, for every field of the API's
 * `RepeatSchedule`, or null (an unknown field, or the schedule as a whole: the Repeat
 * section's own line).
 */
export function repeatFieldControl(field: string | null): RepeatControl | null {
  switch (field) {
    case 'anchor_day':
    case 'day_rule':
      return 'day'
    case 'billing_kind':
      return 'kind'
    case 'cadence':
    case 'end_mode':
    case 'end_date':
    case 'max_occurrences':
    case 'settlement':
      return field
    default:
      return null
  }
}
