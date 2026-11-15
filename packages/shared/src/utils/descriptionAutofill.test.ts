import { describe, expect, it } from 'vitest'
import {
  AUTOFILL_FIELDS,
  autofillForm,
  autofillPatch,
  cleanFormForType,
  createLatestGate,
  exactSuggestion,
  type AutofillField,
  type AutofillUsable,
  type DescriptionSuggestion,
  type TypeFits,
} from './descriptionAutofill'

// The suite the ticket names: transaction_description_autofill (STU-626).

type Form = {
  description: string
  amount?: number
  projected_amount?: number
  transaction_date: string
  is_posted: boolean
  currency: string
  transaction_type: 'debit' | 'credit' | 'transfer'
  account_id: number
  category_id?: number
  tag_ids: number[]
  transfer_from_account_id?: number
  transfer_to_account_id?: number
  allocation_id?: number
  budget_entry_id?: number
}

const blank = (over: Partial<Form> = {}): Form => ({
  description: 'Groceries',
  transaction_date: '2026-11-15',
  is_posted: true,
  currency: 'PHP',
  transaction_type: 'debit',
  account_id: 0,
  tag_ids: [],
  ...over,
})

const groceries: DescriptionSuggestion = {
  description: 'Groceries',
  transaction_type: 'credit',
  account_id: 7,
  category_id: 30,
  tag_ids: [100, 101],
  transfer_from_account_id: null,
  transfer_to_account_id: null,
}
const transfer: DescriptionSuggestion = {
  description: 'To savings',
  transaction_type: 'transfer',
  account_id: 7,
  category_id: null,
  tag_ids: [],
  transfer_from_account_id: 7,
  transfer_to_account_id: 8,
}

const everything: AutofillUsable = { account: () => true, category: () => true, tag: () => true }
const none = new Set<AutofillField>()
const apply = (form: Form, s: DescriptionSuggestion, changed = none, usable = everything): Form => ({
  ...form,
  ...autofillPatch(form, s, changed, usable),
})

describe('transaction_description_autofill', () => {
  it('selection_uses_latest_transaction: fills type, account, category and tags, and a transfer\'s from and to', () => {
    expect(apply(blank(), groceries)).toEqual(
      blank({ transaction_type: 'credit', account_id: 7, category_id: 30, tag_ids: [100, 101] }),
    )
    expect(apply(blank({ description: 'To savings' }), transfer)).toEqual(
      blank({
        description: 'To savings',
        transaction_type: 'transfer',
        account_id: 7,
        transfer_from_account_id: 7,
        transfer_to_account_id: 8,
      }),
    )
  })

  it('autofill_preserves_user_changes: a field the user changed keeps its value', () => {
    for (const field of AUTOFILL_FIELDS) {
      const changed = new Set<AutofillField>([field])
      const patch = autofillPatch(blank({ description: 'To savings' }), transfer, changed, everything)
      expect(Object.keys(patch)).not.toContain(field)
    }
    const form = blank({ account_id: 3, category_id: 31, tag_ids: [102] })
    const changed = new Set<AutofillField>(['account_id', 'category_id', 'tag_ids'])
    expect(apply(form, groceries, changed)).toEqual({ ...form, transaction_type: 'credit' })
    // The user's type decides the transfer fields: a debit the user chose gets no transfer accounts.
    expect(apply(blank(), transfer, new Set<AutofillField>(['transaction_type']))).toEqual(blank({ account_id: 7 }))
  })

  it('autofill_preserves_user_changes: a transfer\'s source is the account the user picked', () => {
    // The user picked account 3 while the form was an expense, then chose a transfer's description.
    const changed = new Set<AutofillField>(['account_id'])
    const out = apply(blank({ account_id: 3 }), transfer, changed)
    expect([out.transaction_type, out.account_id, out.transfer_from_account_id, out.transfer_to_account_id])
      .toEqual(['transfer', 3, 3, 8])
  })

  it('unavailable_references_are_skipped: an unusable account, category or tag leaves its field blank', () => {
    const usable: AutofillUsable = {
      account: (id) => id !== 7 && id !== 8,
      category: (id) => id !== 30,
      tag: (id) => id !== 100,
    }
    expect(apply(blank(), groceries, none, usable)).toEqual(blank({ transaction_type: 'credit', tag_ids: [101] }))
    expect(apply(blank(), transfer, none, usable)).toEqual(blank({ transaction_type: 'transfer' }))
    // Null from the server (a reference it already found unusable) is skipped the same way.
    const stripped = { ...transfer, account_id: null, transfer_from_account_id: null, transfer_to_account_id: 8 }
    expect(apply(blank(), stripped)).toEqual(blank({ transaction_type: 'transfer', transfer_to_account_id: 8 }))
    // A category whose kind does not fit the type is skipped.
    const fits: AutofillUsable = { ...everything, category: (_id, type) => type === 'debit' }
    expect(apply(blank(), groceries, none, fits).category_id).toBeUndefined()
    // A destination that would be the source itself is skipped.
    expect(apply(blank({ account_id: 8 }), { ...transfer, transfer_from_account_id: null, account_id: null },
      none).transfer_to_account_id).toBeUndefined()
  })

  it('user_changed_fields_survive_unavailable_references: changed fields keep their values', () => {
    const usable: AutofillUsable = { account: () => false, category: () => false, tag: () => false }
    const form = blank({ description: 'To savings', account_id: 4, category_id: 31, tag_ids: [5],
      transfer_from_account_id: 4, transfer_to_account_id: 6, transaction_type: 'transfer' })
    const changed = new Set<AutofillField>(AUTOFILL_FIELDS)
    expect(apply(form, transfer, changed, usable)).toEqual(form)
    // The transfer accounts were not changed by the user: a credit has none, so they go blank.
    expect(apply(form, groceries, new Set<AutofillField>(['account_id', 'category_id', 'tag_ids']), usable))
      .toEqual({ ...form, transaction_type: 'credit', transfer_from_account_id: undefined, transfer_to_account_id: undefined })
  })

  it('unavailable_references_are_skipped: a second autofill blanks what the first filled and it cannot', () => {
    const first = apply(blank({ description: 'To savings' }), { ...transfer, category_id: 31, tag_ids: [100] })
    expect([first.transfer_from_account_id, first.transfer_to_account_id, first.category_id, first.tag_ids])
      .toEqual([7, 8, 31, [100]])
    // The next suggestion, an expense with no category and no tags, leaves nothing of the first behind.
    const bare: DescriptionSuggestion = { ...groceries, transaction_type: 'debit', category_id: null, tag_ids: [] }
    const second = apply(first, bare)
    expect([second.transaction_type, second.account_id, second.category_id, second.tag_ids,
      second.transfer_from_account_id, second.transfer_to_account_id]).toEqual(['debit', 7, undefined, [], undefined, undefined])
    // A transfer whose destination and category can't be used: they go blank, not the first's.
    const other = apply(first, { ...transfer, transfer_to_account_id: 9, category_id: 32, tag_ids: [101] },
      none, { account: (id) => id !== 9, category: (id) => id !== 32, tag: (id) => id !== 101 })
    expect([other.transfer_from_account_id, other.transfer_to_account_id, other.category_id, other.tag_ids])
      .toEqual([7, undefined, undefined, []])
    // What the user changed stays, even then.
    const kept = apply(first, bare, new Set<AutofillField>(['category_id', 'tag_ids']))
    expect([kept.category_id, kept.tag_ids]).toEqual([31, [100]])
  })

  it('empty_amount_is_preserved', () => {
    const out = apply(blank(), groceries)
    expect(out.amount).toBeUndefined()
    expect(out.projected_amount).toBeUndefined()
    expect('amount' in autofillPatch(blank(), groceries, none, everything)).toBe(false)
  })

  it('entered_amount_is_preserved', () => {
    const out = apply(blank({ amount: 250, projected_amount: 250, is_posted: false }), groceries)
    expect([out.amount, out.projected_amount, out.is_posted]).toEqual([250, 250, false])
  })

  it('unlisted_fields_are_preserved: only the listed fields can change', () => {
    const form = blank({ description: 'groceries ', allocation_id: 9, budget_entry_id: 10, currency: 'USD',
      transaction_date: '2026-01-02', is_posted: false })
    const patch = autofillPatch(form, transfer, none, everything)
    for (const key of Object.keys(patch)) expect(AUTOFILL_FIELDS as readonly string[]).toContain(key)
    const out = { ...form, ...patch }
    for (const key of ['description', 'allocation_id', 'budget_entry_id', 'currency', 'transaction_date', 'is_posted'] as const) {
      expect(out[key]).toEqual(form[key])
    }
  })

  it('case_insensitive_matching: an exact match ignores case and outer spaces', () => {
    const list = [groceries, transfer]
    expect(exactSuggestion(list, 'GROCERIES')).toBe(groceries)
    expect(exactSuggestion(list, '  to SAVINGS ')).toBe(transfer)
  })

  it('exact_match_on_blur and nonmatch_on_blur: only a whole description matches', () => {
    expect(exactSuggestion([groceries], 'groceries')).toBe(groceries)
    expect(exactSuggestion([groceries], 'Grocer')).toBeUndefined()
    expect(exactSuggestion([groceries], 'Groceries and more')).toBeUndefined()
    expect(exactSuggestion([groceries], '   ')).toBeUndefined()
    expect(exactSuggestion([], 'Groceries')).toBeUndefined()
  })

  it('stale_suggestion_response_is_ignored: a late answer for an earlier value is dropped', () => {
    const gate = createLatestGate()
    const first = gate.next('Gro')
    const second = gate.next('Groc')
    expect(gate.accepts(first, 'Groc')).toBe(false) // an earlier request, answered late
    expect(gate.accepts(second, 'Groc')).toBe(true)
    expect(gate.accepts(second, 'GROC')).toBe(true) // the same value, other case
    expect(gate.accepts(second, 'Groce')).toBe(false) // the Description moved on
    const third = gate.next('Gro')
    gate.reset() // the form was reset
    expect(gate.accepts(third, 'Gro')).toBe(false)
  })
})

// STU-633: autofill that changes the type runs the type-change clean-up first.
describe('transaction_description_autofill: type change (STU-633)', () => {
  // Budget entry 50 is an expense entry, 51 an income entry; categories 30 and 32 are income
  // kind, 31 is expense kind (an expense form keeps 31, an income form keeps 30 and 32).
  const fits: TypeFits = {
    budgetEntry: (id, type) => (id === 50 ? type === 'debit' : id === 51 ? type === 'credit' : false),
    category: (id, type) => (type === 'credit' ? id === 30 || id === 32 : type === 'debit' ? id === 31 : false),
  }
  const linked = (over: Partial<Form> = {}) =>
    blank({ budget_entry_id: 50, allocation_id: 9, category_id: 31, account_id: 3, ...over })
  const fill = (form: Form, s: DescriptionSuggestion, changed = none) => autofillForm(form, s, changed, everything, fits)

  it('type_change_clears_links: a type change clears the budget-entry and allocation links, as a type click does', () => {
    // Expense to transfer: both links go, as clicking Transfer clears them.
    const out = fill(linked(), transfer)
    expect(out.budget_entry_id).toBeUndefined()
    expect(out.allocation_id).toBeUndefined()
    expect({ ...cleanFormForType(linked(), 'transfer', fits), ...autofillPatch(cleanFormForType(linked(), 'transfer', fits), transfer, none, everything) })
      .toEqual(out)
    // Expense to income: an expense budget entry no longer fits and goes.
    expect(fill(linked(), groceries).budget_entry_id).toBeUndefined()
    // An income entry survives an expense form turning income.
    expect(fill(linked({ budget_entry_id: 51 }), groceries).budget_entry_id).toBe(51)
  })

  it('type_change_replaces_mismatched_category: a category that does not fit goes, then the autofilled one applies', () => {
    const out = fill(linked(), groceries)
    expect(out.transaction_type).toBe('credit')
    expect(out.category_id).toBe(30)
    // The same when the user picked the mismatched category themselves.
    expect(fill(linked(), groceries, new Set<AutofillField>(['category_id'])).category_id).toBe(30)
    // Not usable on the new type: blank, the old one does not stay behind.
    const none30 = autofillForm(linked(), groceries, none, { ...everything, category: () => false }, fits)
    expect(none30.category_id).toBeUndefined()
  })

  it('same_type_autofill_unchanged: with the type kept, links and category stay as STU-626 leaves them', () => {
    const sameType: DescriptionSuggestion = { ...groceries, transaction_type: 'debit', category_id: 31 }
    const form = linked({ category_id: 31 })
    expect(fill(form, sameType)).toEqual({ ...form, ...autofillPatch(form, sameType, none, everything) })
    expect(fill(form, sameType).budget_entry_id).toBe(50)
    expect(fill(form, sameType).allocation_id).toBe(9)
    // A user-picked category stays too when the suggestion has none for it to take.
    const picked = fill(linked({ category_id: 99 }), { ...sameType, category_id: null }, new Set<AutofillField>(['category_id']))
    expect(picked.category_id).toBe(99)
  })

  it('type_change_preserves_user_edits: user edits survive a type change unless the clean-up clears them', () => {
    // Retained: the user's account, an income category that fits the new type, tags.
    const kept = fill(
      linked({ category_id: 32, tag_ids: [102] }),
      groceries,
      new Set<AutofillField>(['account_id', 'category_id', 'tag_ids']),
    )
    expect([kept.account_id, kept.category_id, kept.tag_ids]).toEqual([3, 32, [102]])
    // Cleared: the user's expense category cannot stay on an income, as after a manual click;
    // once cleared it is not the user's, so autofill's category goes in (blank if unusable).
    const cleared = fill(linked(), groceries, new Set<AutofillField>(['category_id']))
    expect(cleared.category_id).toBe(30)
    const clearedBlank = autofillForm(linked(), groceries, new Set<AutofillField>(['category_id']), { ...everything, category: () => false }, fits)
    expect(clearedBlank.category_id).toBeUndefined()
    // A user-edited transfer destination equal to the source is cleared, as a click clears it,
    // then the suggestion's destination fills it.
    const sameAccount = fill(blank({ account_id: 3, transfer_to_account_id: 3 }), transfer, new Set<AutofillField>(['account_id', 'transfer_to_account_id']))
    expect(sameAccount.transfer_to_account_id).toBe(8)
    expect(cleanFormForType(blank({ account_id: 3, transfer_to_account_id: 3 }), 'transfer', fits).transfer_to_account_id).toBeUndefined()
    // A user-chosen type is never changed, so nothing is cleaned.
    const typed = fill(linked(), groceries, new Set<AutofillField>(['transaction_type']))
    expect([typed.transaction_type, typed.budget_entry_id, typed.allocation_id]).toEqual(['debit', 50, 9])
  })
})
