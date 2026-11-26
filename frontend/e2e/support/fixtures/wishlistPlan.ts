/**
 * The wishlist answers for the plan and priority wording specs (STU-791): `GET /wishlist/plan` with its per-currency
 * free-flow rows, the items' outlooks, and the wishlist itself.
 *
 * Made-up figures. Each plan is what the API would answer for one state of the caller; the specs register one with
 * `apiRoute` or `sequenceRoute`. Nothing here works out a date or a rate: the answer carries it, as the API's does.
 */
import type {
  Account,
  WishlistFreeFlowRow,
  WishlistItem,
  WishlistOutlook,
  WishlistPlan,
  WishlistPlanInstallment,
  WishlistPlanItem,
} from '@tally-trace/shared'
import { household } from './household'

export const IDS = { repair: 911, desk: 912, lens: 913, espresso: 914, vault: 915, chair: 916, phone: 917, boiler: 918 } as const

const accountNamed = (name: string): Account => {
  const account = household.accounts.find((a) => a.name === name)
  if (!account) throw new Error(`the household has no ${name}`)
  return account
}
const SAVINGS_ACCOUNT = accountNamed('Metrobank Savings')
const CARD_ACCOUNT = accountNamed('HSBC Red Mastercard')

const base = { user_id: household.user.id, currency: 'PHP' as const, is_purchased: false, payment_plan: 'full' as const, created_at: '2026-02-01T09:00:00Z' }

const REPAIR: WishlistItem = { ...base, id: IDS.repair, name: 'Laptop repair', estimated_cost: 24000, priority: 'critical' }
const BOILER: WishlistItem = { ...base, id: IDS.boiler, name: 'Water heater', estimated_cost: 18000, priority: 'critical' }
const DESK: WishlistItem = { ...base, id: IDS.desk, name: 'Standing desk', estimated_cost: 27000, priority: 'high' }
const LENS: WishlistItem = { ...base, id: IDS.lens, name: 'Camera lens', estimated_cost: 45000, priority: 'medium' }
const ESPRESSO: WishlistItem = { ...base, id: IDS.espresso, name: 'Espresso machine', estimated_cost: 36000, priority: 'low' }
const VAULT: WishlistItem = { ...base, id: IDS.vault, name: 'Piano', estimated_cost: 90000, priority: 'medium', account_id: SAVINGS_ACCOUNT.id }
// A dollar item: its amounts are in dollars, never in the default currency.
const CHAIR: WishlistItem = { ...base, id: IDS.chair, name: 'Reading chair', estimated_cost: 800, currency: 'USD', priority: 'low' }
const PHONE: WishlistItem = { ...base, id: IDS.phone, name: 'Phone on the card', estimated_cost: 24000, priority: 'high', payment_plan: 'installment', installment_months: 6, account_id: CARD_ACCOUNT.id }

export const ITEMS: WishlistItem[] = [REPAIR, BOILER, DESK, LENS, ESPRESSO, VAULT, CHAIR, PHONE]
export const ITEM_BY_ID = (id: number): WishlistItem => {
  const item = ITEMS.find((i) => i.id === id)
  if (!item) throw new Error(`no wishlist item ${id}`)
  return item
}

export const phpRow = (over: Partial<WishlistFreeFlowRow> = {}): WishlistFreeFlowRow => ({
  currency: 'PHP',
  status: 'ok',
  sample_months: 4,
  income: 100000,
  spending: 40000,
  debt_paid: 0,
  saved: 20000,
  net_flow: 60000,
  goal_top_up: 22000,
  reserved: 42000,
  free_flow: 18000,
  shortfall: 0,
  ...over,
})

const NO_FIGURES: Partial<WishlistFreeFlowRow> = {
  income: null,
  spending: null,
  debt_paid: null,
  saved: null,
  net_flow: null,
  goal_top_up: null,
  reserved: null,
  free_flow: null,
  shortfall: null,
}

const planItem = (item: WishlistItem, over: Partial<WishlistPlanItem> = {}): WishlistPlanItem => ({
  item_id: item.id,
  name: item.name,
  estimated_cost: item.estimated_cost,
  estimated_purchase_date: null,
  cumulative_months: 0,
  note: null,
  currency: item.currency,
  priority: item.priority,
  basis: item.priority === 'critical' ? 'net_flow' : 'free_flow',
  projection_status: 'dated',
  projection_note: null,
  queue_note: null,
  ...over,
})

/** The urgent need on its own: bought this month, net flow falls from 60,000 to 36,000, and about 6,000 comes out of saving. */
export const repairItem = (over: Partial<WishlistPlanItem> = {}): WishlistPlanItem =>
  planItem(REPAIR, { estimated_purchase_date: '2026-04-25', cumulative_months: 1, net_flow_after: 36000, from_saving: 6000, ...over })

const boilerItem = (over: Partial<WishlistPlanItem> = {}): WishlistPlanItem =>
  planItem(BOILER, { estimated_purchase_date: '2026-05-25', cumulative_months: 2, net_flow_after: 42000, from_saving: 0, ...over })

const deskItem = (over: Partial<WishlistPlanItem> = {}): WishlistPlanItem =>
  planItem(DESK, { estimated_purchase_date: '2026-06-25', cumulative_months: 4, ...over })

const lensItem = (over: Partial<WishlistPlanItem> = {}): WishlistPlanItem =>
  planItem(LENS, { estimated_purchase_date: '2026-09-25', cumulative_months: 6, ...over })

const espressoItem = (over: Partial<WishlistPlanItem> = {}): WishlistPlanItem =>
  planItem(ESPRESSO, {
    projection_status: 'dated',
    queue_note: 'More than 5 years away behind earlier items',
    note: 'More than 5 years away behind earlier items',
    cumulative_months: 80,
    ...over,
  })

export const PAID_FROM_SAVINGS_NOTE = 'Paid from a savings account, so it is not estimated'

const INSTALLMENT: WishlistPlanInstallment = {
  item_id: IDS.phone,
  name: PHONE.name,
  estimated_cost: PHONE.estimated_cost,
  currency: 'PHP',
  account_id: CARD_ACCOUNT.id,
  installment_months: 6,
  monthly_amount: 4000,
  final_amount: 4000,
}

const planOf = (items: WishlistPlanItem[], rows: WishlistFreeFlowRow[], over: Partial<WishlistPlan> = {}): WishlistPlan => ({
  monthly_disposable: 90000,
  savings_rate: 18000,
  items,
  installments: [],
  net_flow: rows,
  ...over,
})

/** A caller with four months of history: one urgent need, three dated wants, one undated by the queue, one paid from savings. */
export const PLAN_OK: WishlistPlan = planOf(
  [
    repairItem(),
    deskItem(),
    lensItem(),
    espressoItem(),
    planItem(VAULT, {
      projection_status: 'paid_from_savings',
      projection_note: PAID_FROM_SAVINGS_NOTE,
      note: PAID_FROM_SAVINGS_NOTE,
      // The API's old placeholder, kept for compatibility; no client shows it.
      estimated_purchase_date: null,
    }),
  ],
  [phpRow()],
)

/** Twelve months of history: nothing says how many months the figures rest on. */
export const PLAN_YEAR: WishlistPlan = planOf([repairItem(), deskItem()], [phpRow({ sample_months: 12 })])

/** Two urgent needs, the second buying nothing out of saving. */
export const PLAN_TWO_URGENT: WishlistPlan = planOf([repairItem(), boilerItem(), deskItem()], [phpRow()])

/** Goals short by 3,000 a month: free flow is 0 and the wants have no room. */
export const PLAN_SHORT: WishlistPlan = planOf(
  [
    repairItem(),
    deskItem({ estimated_purchase_date: null, cumulative_months: 0, projection_status: 'no_room', projection_note: 'Nothing is left after your savings goals', note: 'Nothing is left after your savings goals' }),
  ],
  [phpRow({ free_flow: 0, shortfall: 3000, reserved: 63000 })],
)

/** Outgoings above income by 3,000 a month with nothing kept for saving: the shortfall is 3,000 and no goal is behind it. */
export const PLAN_OVERSPENT: WishlistPlan = planOf(
  [
    deskItem({ estimated_purchase_date: null, cumulative_months: 0, projection_status: 'no_room', projection_note: 'Nothing is left after your savings goals', note: 'Nothing is left after your savings goals' }),
  ],
  [phpRow({ income: 37000, spending: 40000, saved: 0, net_flow: -3000, goal_top_up: 0, reserved: 0, free_flow: 0, shortfall: 3000 })],
)

const undated = (item: WishlistItem, status: 'not_estimated' | 'incomplete' | 'no_projection', note: string): WishlistPlanItem =>
  planItem(item, { projection_status: status, projection_note: note, note, basis: item.priority === 'critical' ? 'net_flow' : 'free_flow' })

export const NOT_ESTIMATED_NOTE = 'Needs one full month of history'
export const INCOMPLETE_NOTE = 'Money in more than one currency is involved, so this cannot be estimated yet'
export const NO_PROJECTION_NOTE = "No projected income or expenses in PHP, so this can't be judged yet."

/** A new user: no full month yet, so every item is `not_estimated` and the row has no figures. */
export const PLAN_NOT_ESTIMATED: WishlistPlan = planOf(
  [undated(REPAIR, 'not_estimated', NOT_ESTIMATED_NOTE), undated(DESK, 'not_estimated', NOT_ESTIMATED_NOTE)],
  [phpRow({ status: 'not_estimated', sample_months: 0, ...NO_FIGURES })],
)

/** Money in more than one currency is involved: every row is `incomplete`, shown with no figure. */
export const PLAN_INCOMPLETE: WishlistPlan = planOf(
  [undated(REPAIR, 'incomplete', INCOMPLETE_NOTE), undated(DESK, 'incomplete', INCOMPLETE_NOTE)],
  [phpRow({ status: 'incomplete', ...NO_FIGURES, income: 100000, spending: 40000 })],
)

/** No income in the currency: the row is `no_projection`. */
export const PLAN_NO_PROJECTION: WishlistPlan = planOf(
  [undated(REPAIR, 'no_projection', NO_PROJECTION_NOTE), undated(DESK, 'no_projection', NO_PROJECTION_NOTE)],
  [phpRow({ status: 'no_projection', sample_months: 4, income: 0, spending: 0, saved: 0, net_flow: null, goal_top_up: null, reserved: null, free_flow: null, shortfall: null })],
)

/** A peso item and a dollar item: each amount reads in its own currency, each currency has its own row. */
export const PLAN_TWO_CURRENCIES: WishlistPlan = planOf(
  [
    deskItem(),
    planItem(CHAIR, { estimated_purchase_date: '2026-08-25', cumulative_months: 4, basis: 'free_flow' }),
  ],
  [phpRow(), phpRow({ currency: 'USD', income: 1500, spending: 600, saved: 100, net_flow: 900, goal_top_up: 200, reserved: 300, free_flow: 600 })],
)

/** A caller whose figures changed after a write: the same urgent need now takes net flow to 40,000 and nothing comes out of saving. */
export const PLAN_AFTER_WRITE: WishlistPlan = planOf(
  [repairItem({ net_flow_after: 40000, from_saving: 0, estimated_purchase_date: '2026-03-25', cumulative_months: 1 }), deskItem()],
  [phpRow({ net_flow: 64000, reserved: 40000, free_flow: 24000 })],
)

/**
 * What STU-791 changed in the wishlist's own wording, for the specs that compare the page with a baseline recorded before
 * it (icons, button): the header line and the priority choice read differently, and a purchase note is added. Each is the
 * text as the page reads it with one space between words; a spec puts the old text back (or drops the addition) so
 * everything else must still match as recorded.
 */
export const WISHLIST_WORDING = {
  header: {
    old: "Prioritised things you're saving up for. Turn any of them into a budget envelope or savings target.",
    now: 'Urgent needs come first. Everything else is saved for after your savings. Turn any of them into a budget envelope or savings target.',
  },
  purchaseNote: 'Marking an item purchased does not record the payment. Its estimate moves only once you record the transaction.',
  priority: {
    old: 'Priority critical high medium low',
    now: 'Priority Critical An urgent need. It comes before your savings. A want Saved for after your savings, in this order. High Medium Low',
  },
  /** The want-level buttons the priority choice adds beside the form's other segment buttons. */
  levelButtons: ['High', 'Medium', 'Low'],
} as const

/** The same plan with the installment item listed apart, for the page that opens its outlook. */
export const PLAN_WITH_INSTALLMENT: WishlistPlan = { ...PLAN_OK, installments: [INSTALLMENT] }

/** Only a card installment on the wishlist: no item is saved up for, but the currency still has its row. */
export const PLAN_INSTALLMENTS_ONLY: WishlistPlan = { ...planOf([], [phpRow()]), installments: [INSTALLMENT] }

/** The same, for a caller with no full month of history. */
export const PLAN_INSTALLMENTS_ONLY_NOT_ESTIMATED: WishlistPlan = {
  ...planOf([], [phpRow({ status: 'not_estimated', sample_months: 0, ...NO_FIGURES })]),
  installments: [INSTALLMENT],
}

const MONTHS = ['2026-04', '2026-05', '2026-06', '2026-07', '2026-08', '2026-09']

/** An installment item's outlook: 4,000 a month for six months against `available`. */
export const outlookOf = (item: WishlistItem, available: number | null, over: Partial<WishlistOutlook> = {}): WishlistOutlook => ({
  item_id: item.id,
  currency: item.currency,
  payment_plan: item.payment_plan,
  estimated_cost: item.estimated_cost,
  installment_months: item.installment_months ?? null,
  monthly_amount: item.payment_plan === 'installment' ? 4000 : null,
  final_amount: item.payment_plan === 'installment' ? 4000 : null,
  months: MONTHS.map((month) => ({ month, existing_installments: 1500, this_item: item.payment_plan === 'installment' ? 4000 : 0, total: item.payment_plan === 'installment' ? 5500 : 1500 })),
  disposable_check: {
    status: available == null ? 'unknown' : 'fits',
    currency: item.currency,
    amount: 4000,
    // The recurring-entry figure the old table read; it must no longer be used.
    monthly_disposable: 90000,
    available,
    basis: 'free_flow',
    reason: available == null ? 'Needs one full month of history' : null,
  },
  credit_check: null,
  ...over,
})
