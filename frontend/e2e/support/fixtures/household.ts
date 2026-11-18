/**
 * The shared household fixture for the web redesign specs (STU-675 onwards).
 *
 * Dense, made-up data for one Manila household: Mara Santos, who also edits a joint account
 * her partner Jun owns. Every figure, name and place here is invented. The data started in
 * the design audit's scratch spec and is the one source later specs draw from: when a spec
 * needs a state this file lacks, extend this file rather than copying data into the spec.
 *
 * Four variants:
 * - `household`: the busy month. Shared-account rows, recurring entries (two of them paused), an overdue payable,
 *   a card with a closed statement, 18 upcoming occurrences and quick balances.
 * - `calmHousehold`: the same household with nothing overdue, negative, failed or over a budget limit.
 * - `emptyHousehold`: the accounts only, with no transactions or recurring entries.
 * - `allUpcomingHousehold`: the busy month with all 18 occurrences on the Due card's Upcoming tab, so that
 *   tab's count badge reads 18 (in `household` it reads 16, with 2 more under Subscriptions).
 *
 * `householdRoutes(data)` answers every call the dashboard, Transactions and Allocations make
 * on load; `mockHousehold(page, data)` signs in, freezes the clock on `HOUSEHOLD_TODAY` and
 * installs those routes.
 *
 * `wishlistRoutes(data)` answers the Allocations Wishlist tab's calls with an empty wishlist.
 *
 * `with*` helpers derive a variant for one state (a main account, one account's balance, zero-amount rows,
 * a zero forecast event, dollars, five currencies, a long account history, long Due card lists); `cardStatements` answers the card's
 * statements; the create factories (`createdAccount`, `createAccountRoute`,
 * `householdCreateRoutes`) answer the dialogs' saves.
 */
import type { Page } from '@playwright/test'
import type {
  Account,
  AccountInput,
  AccountPermissions,
  AccountShare,
  AccountShares,
  Allocation,
  BudgetEntry,
  BudgetEntryInput,
  CardCredit,
  CardCharges,
  CardCreditDetail,
  CardStatementDue,
  CardStatements,
  CashflowTimeline,
  CashflowTimelineEvent,
  Category,
  DashboardDue,
  DashboardSnapshot,
  DescriptionSuggestion,
  EntryOccurrences,
  ForcedDateResult,
  FullBudgetEntry,
  FullCharge,
  ForecastPeriod,
  FullTransaction,
  HouseholdDashboard,
  HouseholdMonthly,
  HouseholdShares,
  HouseholdTransactions,
  HouseholdUpcoming,
  HouseholdView,
  InstallmentPlan,
  InstallmentPlans,
  InstallmentReview,
  InstallmentReviewResult,
  LimitedBudgetEntry,
  MinimumDuePreset,
  PaginatedResponse,
  Payable,
  RecurrenceFrequency,
  QuickBalances,
  ReceivedHouseholdShare,
  ReceivedShare,
  RecordPermissions,
  RepeatingCreated,
  ScheduledList,
  SharedFullTransaction,
  Tag,
  Transaction,
  TransactionInput,
  TransactionSummary,
  UpcomingItem,
  UpcomingOccurrence,
  UpcomingOccurrences,
  User,
  UserMatch,
  WishlistItem,
  WishlistPlan,
} from '@tally-trace/shared'
import { apiRoute, mockApi, queryRoute, sequenceRoute } from '../mockApi'
import type { ApiMock, ApiRoute } from '../mockApi'
import { signedIn } from '../signedIn'

/** The Manila day every variant is computed for. */
export const HOUSEHOLD_TODAY = '2026-03-12'
/** 10:00 in Manila on `HOUSEHOLD_TODAY`: the frozen browser clock. */
export const HOUSEHOLD_NOW = new Date(`${HOUSEHOLD_TODAY}T10:00:00+08:00`)

/** Everything one variant holds, plus the API answers derived from it. */
export interface HouseholdData {
  today: string
  user: User
  accounts: Account[]
  categories: Category[]
  tags: Tag[]
  transactions: Transaction[]
  allocations: Allocation[]
  entries: BudgetEntry[]
  /** `DashboardSnapshot.upcoming_this_month`. */
  upcoming: UpcomingItem[]
  payables: Payable[]
  cardStatements: CardStatementDue[]
  /** Every unrecorded occurrence in the 30 days after `today`, subscriptions included. */
  occurrences: UpcomingOccurrence[]
  quickBalances: QuickBalances
  snapshot: DashboardSnapshot
  due: DashboardDue
  /** `GET /budget-entries/installment-plans`: none in the built variants. */
  installmentPlans: InstallmentPlan[]
  timeline: CashflowTimeline
  summary: TransactionSummary
}

export const householdUser: User = {
  id: 1,
  email: 'mara@example.com',
  first_name: 'Mara',
  last_name: 'Santos',
  default_currency: 'PHP',
  is_active: true,
  is_verified: true,
  onboarding_completed: true,
  created_at: '2025-06-01T00:00:00',
}

const ownerPerms: AccountPermissions = {
  can_edit_settings: true,
  can_manage_shares: true,
  can_add_transactions: true,
  can_delete: true,
  can_view_details: true,
}
const editorPerms: AccountPermissions = {
  can_edit_settings: false,
  can_manage_shares: false,
  can_add_transactions: true,
  can_delete: false,
  can_view_details: true,
}
const recPerms: RecordPermissions = { can_edit: true, can_delete: true, can_post: true, can_revert: true, can_tag: true }

const acct = (a: Partial<Account> & Pick<Account, 'id' | 'name' | 'account_type' | 'balance'>): Account => ({
  currency: 'PHP',
  is_active: true,
  tags: [],
  my_role: 'owner',
  is_shared: false,
  owner_id: 1,
  owner_name: 'Mara S.',
  permissions: ownerPerms,
  created_at: '2025-06-01T00:00:00',
  ...a,
})

const payroll = acct({ id: 11, name: 'BPI Payroll', account_type: 'checking', balance: 84250.4 })
const savings = acct({ id: 12, name: 'Metrobank Savings', account_type: 'savings', balance: 212600 })
const gcash = acct({ id: 13, name: 'GCash', account_type: 'e_wallet', balance: 3415.75, is_spending_wallet: true })
const cash = acct({ id: 14, name: 'Cash on hand', account_type: 'cash', balance: 1860, is_spending_wallet: true })
const card = acct({
  id: 15,
  name: 'HSBC Red Mastercard',
  account_type: 'credit',
  balance: -18742.3,
  credit_limit: 120000,
  billing_cycle_start: 20,
  days_until_due_date: 21,
  payment_account_id: 11,
})
/** Jun's account, shared with Mara as an editor: the household's shared-account rows land here. */
const joint = acct({
  id: 16,
  name: 'BDO Joint household',
  account_type: 'checking',
  balance: 46380.5,
  my_role: 'editor',
  is_shared: null,
  owner_id: 2,
  owner_name: 'Jun R.',
  permissions: editorPerms,
})

/** The ids of the accounts a variant shares with someone else, for the data-contract checks. */
export const SHARED_ACCOUNT_IDS: readonly number[] = [joint.id]

const cat = (id: number, name: string, kind: Category['kind']): Category => ({
  id,
  name,
  is_expense: kind === 'expense',
  kind,
  is_active: true,
  created_at: '2025-06-01T00:00:00',
})
const categories: Category[] = [
  cat(21, 'Salary', 'income'),
  cat(22, 'Groceries', 'expense'),
  cat(23, 'Dining out', 'expense'),
  cat(24, 'Utilities', 'expense'),
  cat(25, 'Transport', 'expense'),
  cat(26, 'Rent', 'expense'),
  cat(27, 'Subscriptions', 'expense'),
  cat(28, 'Health', 'expense'),
  cat(29, 'Savings transfer', 'transfer'),
  cat(30, 'Freelance', 'income'),
  cat(31, 'Household help', 'expense'),
]

const householdTag: Tag = { id: 41, name: 'Household', color: '#3f6b5c', is_system: true, created_at: '2025-06-01T00:00:00' }
const tripTag: Tag = { id: 42, name: 'Japan trip', color: '#a35f2a', is_system: false, created_at: '2025-06-01T00:00:00' }
const tags = [householdTag, tripTag]

let txId = 500
const tx = (
  day: string,
  description: string,
  amount: number,
  account: Account,
  categoryId: number,
  type: FullTransaction['transaction_type'] = 'debit',
  extra: Partial<FullTransaction> = {},
): FullTransaction => ({
  view: 'full',
  id: ++txId,
  account_id: account.id,
  amount,
  currency: 'PHP',
  description,
  transaction_type: type,
  transaction_date: `${day}T00:00:00`,
  is_posted: true,
  is_reconciled: false,
  is_recurring: false,
  transfer_fee: 0,
  tags: [],
  category_id: categoryId,
  created_at: `${day}T09:00:00`,
  permissions: recPerms,
  created_by: 'Mara S.',
  ...extra,
})
/** A row Jun entered on the joint account: Mara sees it as `shared_full`. */
const junTx = (
  day: string,
  description: string,
  amount: number,
  categoryName: string,
  type: SharedFullTransaction['transaction_type'] = 'debit',
): SharedFullTransaction => ({
  view: 'shared_full',
  id: ++txId,
  account_id: joint.id,
  amount,
  currency: 'PHP',
  description,
  transaction_type: type,
  transaction_date: `${day}T00:00:00`,
  is_posted: true,
  is_reconciled: false,
  is_recurring: false,
  transfer_fee: 0,
  tags: [householdTag],
  category_name: categoryName,
  created_at: `${day}T19:00:00`,
  permissions: { can_edit: true, can_delete: false, can_post: true, can_revert: false, can_tag: true },
  created_by: 'Jun R.',
})

/** Newest first, as the API returns them: 12 February to 12 March. */
const transactions: Transaction[] = [
  tx('2026-03-12', 'Puregold weekly groceries', 3184.5, card, 22, 'debit', { tags: [householdTag] }),
  tx('2026-03-11', 'Grab to Makati', 286, gcash, 25),
  tx('2026-03-11', 'Lunch, Kanto Freestyle', 420, cash, 23),
  junTx('2026-03-10', 'Palengke, Marikina market', 1385, 'Groceries'),
  tx('2026-03-10', 'Meralco February bill', 4812.65, payroll, 24, 'debit', { tags: [householdTag] }),
  tx('2026-03-10', 'Mercury Drug', 965.25, gcash, 28),
  tx('2026-03-09', 'Netflix Standard', 549, card, 27, 'debit', { is_recurring: true }),
  tx('2026-03-08', 'Move to emergency fund', 10000, payroll, 29, 'transfer', {
    transfer_from_account_id: payroll.id,
    transfer_to_account_id: savings.id,
    transfer_fee: 25,
  }),
  tx('2026-03-07', 'Logo design, Kapé Co.', 18500, payroll, 30, 'credit'),
  tx('2026-03-07', 'Dinner, Manam', 2140, card, 23, 'debit', { tags: [tripTag] }),
  tx('2026-03-06', 'PLDT Fibr', 1899, payroll, 24, 'debit', { tags: [householdTag] }),
  tx('2026-03-05', 'Shell V-Power', 2650, card, 25),
  tx('2026-03-05', 'S&R bulk run', 6420.8, card, 22, 'debit', { tags: [householdTag] }),
  junTx('2026-03-04', 'Water refill, 4 gallons', 160, 'Utilities'),
  tx('2026-03-04', 'Spotify Duo', 239, card, 27, 'debit', { is_recurring: true }),
  tx('2026-03-03', 'Coffee, Yardstick', 210, gcash, 23),
  tx('2026-03-01', 'March rent', 22000, payroll, 26, 'debit', { tags: [householdTag] }),
  junTx('2026-03-01', 'Household fund, March', 15000, 'Salary', 'credit'),
  tx('2026-03-01', 'Yaya salary, Feb 16–28', 4500, joint, 31, 'debit', { tags: [householdTag] }),
  tx('2026-02-28', 'Payroll, February 16–28', 41250, payroll, 21, 'credit'),
  tx('2026-02-27', 'Maynilad water', 712.4, payroll, 24, 'debit', { tags: [householdTag] }),
  tx('2026-02-26', 'Angkas ride', 145, gcash, 25),
  junTx('2026-02-22', 'Palengke, Marikina market', 1240, 'Groceries'),
  tx('2026-02-20', 'Globe Postpaid', 1299, payroll, 24),
  tx('2026-02-18', 'Robinsons Supermarket', 2875.3, card, 22, 'debit', { tags: [householdTag] }),
  tx('2026-02-15', 'Payroll, February 1–15', 41250, payroll, 21, 'credit'),
  tx('2026-02-15', 'Yaya salary, Feb 1–15', 4500, joint, 31, 'debit', { tags: [householdTag] }),
  tx('2026-02-12', 'Jollibee family bucket', 899, cash, 23),
]

const alloc = (a: Partial<Allocation> & Pick<Allocation, 'id' | 'name' | 'allocation_type' | 'current_amount'>): Allocation => ({
  account_id: savings.id,
  currency: 'PHP',
  is_active: true,
  created_at: '2025-06-01T00:00:00',
  ...a,
})
/**
 * The one envelope over its limit (120%). The busy month has it; `calmHousehold` leaves it out, since a calm household
 * is over no limit. The other budgets sit at 50, 80, 85 and 100 percent of theirs.
 */
const OVER_BUDGET = alloc({ id: 70, name: 'Shopping', allocation_type: 'budget', account_id: payroll.id, current_amount: 6000, target_amount: 5000, period_frequency: 'monthly', period_start: '2026-03-01', period_end: '2026-03-31' })
const allocations: Allocation[] = [
  alloc({ id: 61, name: 'Emergency fund', allocation_type: 'savings', current_amount: 186400, target_amount: 300000, monthly_target: 10000 }),
  alloc({ id: 62, name: 'Japan trip, October', allocation_type: 'goal', current_amount: 42500, target_amount: 120000, target_date: '2026-10-01', monthly_target: 11000 }),
  alloc({ id: 63, name: 'New laptop', allocation_type: 'goal', current_amount: 31800, target_amount: 75000, target_date: '2026-08-15' }),
  alloc({ id: 64, name: 'Christmas gifts', allocation_type: 'savings', current_amount: 6000, target_amount: 25000, monthly_target: 2000 }),
  alloc({ id: 66, name: 'Dining out', allocation_type: 'budget', account_id: payroll.id, current_amount: 2500, target_amount: 5000, period_frequency: 'monthly', period_start: '2026-03-01', period_end: '2026-03-31' }),
  alloc({ id: 67, name: 'Transport', allocation_type: 'budget', account_id: payroll.id, current_amount: 3600, target_amount: 4500, period_frequency: 'monthly', period_start: '2026-03-01', period_end: '2026-03-31' }),
  alloc({ id: 65, name: 'Groceries', allocation_type: 'budget', account_id: payroll.id, current_amount: 15300, target_amount: 18000, period_frequency: 'monthly', period_start: '2026-03-01', period_end: '2026-03-31' }),
  alloc({ id: 69, name: 'Utilities', allocation_type: 'budget', account_id: payroll.id, current_amount: 6000, target_amount: 6000, period_frequency: 'monthly', period_start: '2026-03-01', period_end: '2026-03-31' }),
  OVER_BUDGET,
  alloc({ id: 68, name: 'Car maintenance', allocation_type: 'savings', current_amount: 14250, target_amount: 30000 }),
]

let entryId = 700
const entry = (
  name: string,
  entryType: FullBudgetEntry['entry_type'],
  amount: number,
  next: string,
  account: Account,
  extra: Partial<FullBudgetEntry> = {},
): FullBudgetEntry => ({
  view: 'full',
  id: ++entryId,
  entry_type: entryType,
  name,
  amount,
  currency: 'PHP',
  cadence: 'monthly',
  next_occurrence: next,
  lead_time_days: 0,
  end_mode: 'indefinite',
  account_id: account.id,
  is_active: true,
  tags: [],
  created_at: '2025-06-01T00:00:00',
  permissions: recPerms,
  created_by: 'Mara S.',
  ...extra,
})
const payrollEntry = entry('Payroll', 'income', 41250, '2026-03-15', payroll, { cadence: 'semi_monthly', semi_monthly_day_1: 15, semi_monthly_day_2: 30 })
const rentEntry = entry('Rent', 'expense', 22000, '2026-04-01', payroll, { anchor_day: 1, tags: [householdTag], kind: 'cash', settlement: 'manual' })
const meralcoEntry = entry('Meralco', 'expense', 4600, '2026-04-10', payroll, { anchor_day: 10, tags: [householdTag], kind: 'cash', settlement: 'manual' })
const pldtEntry = entry('PLDT Fibr', 'expense', 1899, '2026-04-06', payroll, { anchor_day: 6, kind: 'cash', settlement: 'autopay' })
const netflixEntry = entry('Netflix Standard', 'expense', 549, '2026-04-09', card, { anchor_day: 9, kind: 'subscription' })
const spotifyEntry = entry('Spotify Duo', 'expense', 239, '2026-04-04', card, { anchor_day: 4, kind: 'subscription' })
const fundEntry = entry('Emergency fund top-up', 'expense', 10000, '2026-04-08', payroll, { anchor_day: 8, kind: 'cash', settlement: 'manual' })
const hmoEntry = entry('HMO dependent add-on', 'expense', 1450, '2026-03-20', payroll, { anchor_day: 20, kind: 'cash', settlement: 'manual' })
const globeEntry = entry('Globe Postpaid', 'expense', 1299, '2026-03-18', payroll, { anchor_day: 18, kind: 'cash', settlement: 'autopay' })
const mayniladEntry = entry('Maynilad water', 'expense', 720, '2026-03-27', payroll, { anchor_day: 27, tags: [householdTag], kind: 'cash', settlement: 'manual' })
const palengkeEntry = entry('Palengke run', 'expense', 1300, '2026-03-14', joint, { cadence: 'weekly', tags: [householdTag], kind: 'cash', settlement: 'manual' })
const yayaEntry = entry('Yaya salary', 'expense', 4500, '2026-03-15', joint, {
  cadence: 'semi_monthly',
  semi_monthly_day_1: 15,
  semi_monthly_day_2: 31,
  tags: [householdTag],
  kind: 'cash',
  settlement: 'manual',
})
/**
 * Two paused entries: a paused entry offers no Mark paid, Charged or Posted, so each lists as a row with one meta line
 * and nothing under it. Paused entries are left out of the monthly figures, the upcoming list and the occurrences.
 */
const gymEntry = entry('Gym membership', 'expense', 2500, '2026-04-05', payroll, { anchor_day: 5, kind: 'cash', settlement: 'manual', is_active: false })
const disneyEntry = entry('Disney+ Premium', 'expense', 369, '2026-04-02', card, { anchor_day: 2, kind: 'subscription', is_active: false })
const entries: BudgetEntry[] = [
  payrollEntry,
  rentEntry,
  meralcoEntry,
  pldtEntry,
  netflixEntry,
  spotifyEntry,
  fundEntry,
  hmoEntry,
  globeEntry,
  mayniladEntry,
  palengkeEntry,
  yayaEntry,
  gymEntry,
  disneyEntry,
]

const upcoming: UpcomingItem[] = [
  { name: 'Payroll', amount: 41250, due_date: '2026-03-15', entry_type: 'income', source: 'budget_entry', source_id: payrollEntry.id, currency: 'PHP', occurrence_date: '2026-03-15' },
  { name: 'HMO dependent add-on', amount: 1450, due_date: '2026-03-20', entry_type: 'expense', source: 'budget_entry', source_id: hmoEntry.id, currency: 'PHP', occurrence_date: '2026-03-20', settlement: 'manual', can_mark_paid: true },
  { name: 'Payroll', amount: 41250, due_date: '2026-03-30', entry_type: 'income', source: 'budget_entry', source_id: payrollEntry.id, currency: 'PHP', occurrence_date: '2026-03-30' },
  { name: 'Rent', amount: 22000, due_date: '2026-04-01', entry_type: 'expense', source: 'budget_entry', source_id: rentEntry.id, currency: 'PHP', occurrence_date: '2026-04-01', settlement: 'manual', can_mark_paid: true },
  { name: 'Spotify Duo', amount: 239, due_date: '2026-04-04', entry_type: 'expense', source: 'budget_entry', source_id: spotifyEntry.id, currency: 'PHP', occurrence_date: '2026-04-04', kind: 'subscription' },
  { name: 'PLDT Fibr', amount: 1899, due_date: '2026-04-06', entry_type: 'expense', source: 'budget_entry', source_id: pldtEntry.id, currency: 'PHP', occurrence_date: '2026-04-06', settlement: 'autopay' },
  { name: 'Emergency fund top-up', amount: 10000, due_date: '2026-04-08', entry_type: 'expense', source: 'budget_entry', source_id: fundEntry.id, currency: 'PHP', occurrence_date: '2026-04-08' },
]

const payable = (
  p: Omit<Payable, 'account_id' | 'account_name' | 'overflow_account_id' | 'overflow_account_name' | 'currency'> & { account?: Account },
): Payable => {
  const { account = payroll, ...rest } = p
  return { account_id: account.id, account_name: account.name, overflow_account_id: null, overflow_account_name: null, currency: 'PHP', ...rest }
}
/** The one overdue payable: the emergency-fund top-up that was due on 8 March. */
const overduePayable = payable({
  due_date: HOUSEHOLD_TODAY,
  original_date: '2026-03-08',
  overdue: true,
  name: 'Emergency fund top-up',
  amount: 10000,
  source: 'budget_entry',
  source_id: fundEntry.id,
  occurrence_date: '2026-03-08',
  settlement: 'manual',
  can_mark_paid: true,
  kind: 'cash',
})
/** The closed 20 February statement's amount, due 13 March (`cardStatement` below). */
const CLOSED_STATEMENT = 12480.55
/**
 * The 20 March cycle, due 9 April: the card's balance less the closed statement it already includes, so the two
 * payments never count the same charge twice.
 */
const statementPayable = payable({
  due_date: '2026-04-09',
  name: 'HSBC Red Mastercard statement',
  amount: Math.round((-card.balance - CLOSED_STATEMENT) * 100) / 100,
  source: 'statement',
  source_id: card.id,
  statement_close: '2026-03-20',
})
const payables: Payable[] = [
  overduePayable,
  payable({ due_date: '2026-03-20', name: 'HMO dependent add-on', amount: 1450, source: 'budget_entry', source_id: hmoEntry.id, occurrence_date: '2026-03-20', settlement: 'manual', can_mark_paid: true, kind: 'cash' }),
  payable({ due_date: '2026-04-01', name: 'Rent', amount: 22000, source: 'budget_entry', source_id: rentEntry.id, occurrence_date: '2026-04-01', settlement: 'manual', can_mark_paid: true, kind: 'cash' }),
  payable({ due_date: '2026-04-06', name: 'PLDT Fibr', amount: 1899, source: 'budget_entry', source_id: pldtEntry.id, occurrence_date: '2026-04-06', settlement: 'autopay', can_mark_paid: true, kind: 'cash' }),
  statementPayable,
  payable({ due_date: '2026-04-10', name: 'Meralco', amount: 4600, source: 'budget_entry', source_id: meralcoEntry.id, occurrence_date: '2026-04-10', settlement: 'manual', can_mark_paid: true, kind: 'cash' }),
]

/** The HSBC card's closed 20 February statement, due 13 March: owed, not yet overdue. */
const cardStatement: CardStatementDue = {
  account_id: card.id,
  name: card.name,
  currency: 'PHP',
  close_date: '2026-02-20',
  due_date: '2026-03-13',
  clear_through: CLOSED_STATEMENT,
  statement_count: 1,
  oldest_due: '2026-03-13',
  overdue: false,
  incomplete: false,
  unposted_installments: 0,
  unposted_postable: 0,
}

const occurrence = (e: FullBudgetEntry, day: string, account: Account): UpcomingOccurrence => ({
  view: 'full',
  entry_id: e.id,
  name: e.name,
  occurrence_date: day,
  effective_date: day,
  entry_type: e.entry_type,
  is_transfer: false,
  kind: e.entry_type === 'income' ? null : (e.kind ?? null),
  plan_kind: e.kind === 'subscription' ? 'subscription' : null,
  amount: e.amount,
  currency: 'PHP',
  account_name: account.name,
  transfer_to_account_name: null,
  capped: false,
  can_mark_paid: true,
  recordable: true,
  auto_post: null,
  block_reason: null,
  can_review: false,
})
/** The 18 unrecorded occurrences between 13 March and 11 April, sorted by day then name. */
const occurrences: UpcomingOccurrence[] = [
  occurrence(palengkeEntry, '2026-03-14', joint),
  occurrence(payrollEntry, '2026-03-15', payroll),
  occurrence(yayaEntry, '2026-03-15', joint),
  occurrence(globeEntry, '2026-03-18', payroll),
  occurrence(hmoEntry, '2026-03-20', payroll),
  occurrence(palengkeEntry, '2026-03-21', joint),
  occurrence(mayniladEntry, '2026-03-27', payroll),
  occurrence(palengkeEntry, '2026-03-28', joint),
  occurrence(payrollEntry, '2026-03-30', payroll),
  occurrence(yayaEntry, '2026-03-31', joint),
  occurrence(rentEntry, '2026-04-01', payroll),
  occurrence(palengkeEntry, '2026-04-04', joint),
  occurrence(spotifyEntry, '2026-04-04', card),
  occurrence(pldtEntry, '2026-04-06', payroll),
  occurrence(fundEntry, '2026-04-08', payroll),
  occurrence(netflixEntry, '2026-04-09', card),
  occurrence(meralcoEntry, '2026-04-10', payroll),
  occurrence(palengkeEntry, '2026-04-11', joint),
]

const quickBalancesFor = (accounts: Account[]): QuickBalances => {
  const byId = (id: number) => accounts.find((a) => a.id === id)
  const tiles: QuickBalances['tiles'] = []
  for (const [id, slot] of [
    [payroll.id, 'debit'],
    [card.id, 'credit'],
    [gcash.id, 'e_wallet'],
  ] as const) {
    const a = byId(id)
    if (a) tiles.push({ account_id: a.id, name: a.name, account_type: a.account_type, currency: a.currency, balance: a.balance, slot })
  }
  return { pinned: false, max_tiles: 4, tiles }
}

const round2 = (n: number): number => Math.round(n * 100) / 100
const fx = { rates: [], unconverted_count: 0 }

/** `_monthly_equivalent` in the API's forecast service: any cadence as a monthly amount. */
const PER_MONTH: Partial<Record<RecurrenceFrequency, number>> = {
  weekly: 52 / 12,
  biweekly: 26 / 12,
  semi_monthly: 2,
  monthly: 1,
  quarterly: 1 / 3,
  semi_annual: 1 / 6,
  annual: 1 / 12,
}
const monthlyOf = (amount: number, cadence: RecurrenceFrequency): number => amount * (PER_MONTH[cadence] ?? 1)

/**
 * The snapshot's monthly figures, as the API's `_disposable_buckets` derives them from recurring entries: every
 * active entry the user can read counts, the joint account included (Mara holds a direct role on it). Income is
 * income; an expense counts unless it is paid from a spending wallet (that money was counted when the wallet was
 * topped up); income into a wallet is a top-up, so it is an expense as well. A transfer into a wallet from a
 * non-wallet is an expense, and one back out of a wallet is a negative one. Every account here is in PHP.
 */
function monthlyFigures(entries: BudgetEntry[], accounts: Account[]): { monthlyIncome: number; monthlyExpenses: number } {
  const wallets = new Set(accounts.filter((a) => a.is_spending_wallet).map((a) => a.id))
  const isWallet = (id: number | null | undefined): boolean => id != null && wallets.has(id)
  let income = 0
  let expenses = 0
  for (const e of entries) {
    if (e.view === 'limited' || !e.is_active || (e.end_mode === 'on_date' && e.end_date && e.end_date.slice(0, 10) < HOUSEHOLD_TODAY)) continue
    const amount = monthlyOf(e.amount, e.cadence)
    if (e.transfer_to_account_id != null) {
      if (isWallet(e.transfer_to_account_id) && !isWallet(e.account_id)) expenses += amount
      else if (isWallet(e.account_id) && !isWallet(e.transfer_to_account_id)) expenses -= amount
    } else if (e.entry_type === 'income') {
      income += amount
      if (isWallet(e.account_id)) expenses += amount
    } else if (!isWallet(e.account_id)) {
      expenses += amount
    }
  }
  return { monthlyIncome: round2(income), monthlyExpenses: round2(expenses) }
}

/**
 * The payroll account's forecast events from `HOUSEHOLD_TODAY` to 11 April, in date order, with running balances:
 * - each occurrence of an entry paid from or into the payroll account;
 * - each card statement payment, as cash leaving the card's funding account on its due day: the closed statement
 *   (`cardStatements`) and the next cycle's statement payable (`payables` with source `statement`).
 *
 * Card spending reaches cash only through a statement (`is_projection_cash`), so the card's own occurrences (the
 * subscriptions) are never cash events: the statements carry them. Nothing is counted twice.
 */
function timelineEvents(parts: Parts, accounts: Account[], opening: number): CashflowTimelineEvent[] {
  const nameOf = (id: number): string => accounts.find((a) => a.id === id)?.name ?? ''
  const leg = (accountId: number, amount: number): CashflowTimelineEvent['accounts'] => [
    { account_id: accountId, account_name: nameOf(accountId), amount, currency: 'PHP' },
  ]
  const fundedFrom = (cardId: number): number | null => accounts.find((a) => a.id === cardId)?.payment_account_id ?? null
  type Event = Omit<CashflowTimelineEvent, 'running_balance'>
  const entryEvents: Event[] = parts.occurrences
    .filter((o) => o.account_name === payroll.name)
    .map((o) => {
      const amount = o.entry_type === 'income' ? o.amount : -o.amount
      return {
        date: o.occurrence_date,
        name: o.name,
        amount,
        type: o.entry_type,
        source: 'budget_entry',
        source_id: o.entry_id,
        event_id: `be-${o.entry_id}-${o.occurrence_date}`,
        currency: 'PHP',
        accounts: leg(payroll.id, amount),
      }
    })
  const statements = [
    ...parts.cardStatements.map((st) => ({ cardId: st.account_id, date: st.due_date, name: `${st.name} statement`, amount: st.clear_through })),
    ...parts.payables
      .filter((p) => p.source === 'statement' && p.source_id != null)
      .map((p) => ({ cardId: p.source_id ?? 0, date: p.due_date, name: p.name, amount: p.amount })),
  ]
  const statementEvents: Event[] = statements.flatMap((st) => {
    const from = fundedFrom(st.cardId)
    if (from !== payroll.id) return []
    return [
      {
        date: st.date,
        name: st.name,
        amount: -st.amount,
        type: 'expense',
        source: 'statement',
        source_id: st.cardId,
        event_id: `st-${st.cardId}-${st.date}`,
        currency: 'PHP',
        accounts: leg(from, -st.amount),
      },
    ]
  })
  const unsorted = [...entryEvents, ...statementEvents]
  let running = opening
  return unsorted
    .filter((e) => e.date > HOUSEHOLD_TODAY && e.date <= '2026-04-11')
    .sort((a, b) => a.date.localeCompare(b.date))
    .map((e) => {
      running = round2(running + e.amount)
      return { ...e, running_balance: running }
    })
}

interface Parts {
  accounts: Account[]
  transactions: Transaction[]
  entries: BudgetEntry[]
  upcoming: UpcomingItem[]
  payables: Payable[]
  cardStatements: CardStatementDue[]
  occurrences: UpcomingOccurrence[]
  /** Replaces the shared categories and tags, for the variant that tests saved colours. */
  categories?: Category[]
  tags?: Tag[]
  allocations: Allocation[]
}

/**
 * `GET /transactions/summary/period` for the days `start` to `end` (inclusive, `YYYY-MM-DD`): the income, spending
 * and category breakdown of the full and shared rows dated in it. A limited row carries no amount the summary counts.
 */
function summaryOf(transactions: Transaction[], categoryList: Category[], start: string, end: string): TransactionSummary {
  const inWindow = transactions.filter((t) => t.view !== 'limited' && t.transaction_date.slice(0, 10) >= start && t.transaction_date.slice(0, 10) <= end)
  const sumOf = (type: 'credit' | 'debit') => round2(inWindow.filter((t) => t.transaction_type === type).reduce((sum, t) => sum + t.amount, 0))
  const income = sumOf('credit')
  const expenses = sumOf('debit')
  const breakdown: TransactionSummary['category_breakdown'] = {}
  for (const t of inWindow) {
    if (t.view === 'limited' || t.transaction_type === 'transfer') continue
    const name = t.view === 'shared_full' ? (t.category_name ?? 'Uncategorized') : (categoryList.find((c) => c.id === t.category_id)?.name ?? 'Uncategorized')
    const row = breakdown[name] ?? { income: 0, expenses: 0 }
    if (t.transaction_type === 'credit') row.income = round2(row.income + t.amount)
    else row.expenses = round2(row.expenses + t.amount)
    breakdown[name] = row
  }
  return {
    period: { start_date: start, end_date: end },
    summary: { total_income: income, total_expenses: expenses, net_flow: round2(income - expenses), transaction_count: inWindow.length },
    category_breakdown: breakdown,
    by_currency: [
      {
        currency: 'PHP',
        total_income: income,
        total_expenses: expenses,
        moved_in: 0,
        moved_out: 0,
        net_flow: round2(income - expenses),
        transaction_count: inWindow.length,
        category_breakdown: breakdown,
      },
    ],
    household_private: [],
  }
}

/** Builds a variant's API answers from its parts, so every variant stays self-consistent. */
function build(parts: Parts): HouseholdData {
  const { accounts } = parts
  const categoryList = parts.categories ?? categories
  const tagList = parts.tags ?? tags
  const total = round2(accounts.reduce((sum, a) => sum + a.balance, 0))
  const availableCash = round2(accounts.filter((a) => a.account_type !== 'credit' && !a.is_spending_wallet).reduce((sum, a) => sum + a.balance, 0))

  // The month to date: the fixture has no rows after today, so the month and the month to date hold the same rows.
  const summary = summaryOf(parts.transactions, categoryList, '2026-03-01', '2026-03-31')

  const { monthlyIncome, monthlyExpenses } = monthlyFigures(parts.entries, accounts)
  const opening = accounts.find((a) => a.id === payroll.id)?.balance ?? 0
  const events = timelineEvents(parts, accounts, opening)
  const running = events.length ? events[events.length - 1].running_balance : opening
  const lowest = Math.min(opening, ...events.map((e) => e.running_balance))
  const trough = events.find((e) => e.running_balance === lowest)?.date ?? HOUSEHOLD_TODAY
  const byAccount: CashflowTimeline['by_account'] = [
    { account_id: payroll.id, account_name: payroll.name, opening_balance: opening, closing_balance: running, currency: 'PHP' },
  ]
  const timeline: CashflowTimeline = {
    window_start: HOUSEHOLD_TODAY,
    window_end: '2026-04-11',
    opening_balance: opening,
    lowest_balance: lowest,
    trough_date: trough,
    closing_balance: running,
    shortfall: false,
    shortfalls: [],
    account_shortfalls: [],
    by_account: byAccount,
    unassigned_closing: 0,
    overflow_moves: [],
    events,
    by_currency: [
      {
        currency: 'PHP',
        opening_balance: opening,
        lowest_balance: lowest,
        trough_date: trough,
        closing_balance: running,
        shortfall: false,
        shortfalls: [],
        account_shortfalls: [],
        by_account: byAccount,
        unassigned_closing: 0,
        overflow_moves: [],
        events,
      },
    ],
    currencies: ['PHP'],
    fx,
  }

  const snapshot: DashboardSnapshot = {
    balances: {
      total,
      by_account: accounts.map((a) => ({ id: a.id, name: a.name, balance: a.balance, currency: a.currency, is_spending_wallet: a.is_spending_wallet })),
      by_currency: [{ currency: 'PHP', total, available_cash: availableCash }],
    },
    upcoming_this_month: parts.upcoming,
    monthly_summary: {
      monthly_income: monthlyIncome,
      monthly_expenses: monthlyExpenses,
      monthly_disposable: round2(monthlyIncome - monthlyExpenses),
      by_currency: [
        {
          currency: 'PHP',
          monthly_income: monthlyIncome,
          monthly_expenses: monthlyExpenses,
          moved_in: 0,
          moved_out: 0,
          monthly_disposable: round2(monthlyIncome - monthlyExpenses),
        },
      ],
    },
    forecast_next_3_months: [],
    goals_progress: parts.allocations
      .filter((a) => a.allocation_type !== 'budget' && a.target_amount)
      .slice(0, 3)
      .map((a) => ({
        id: a.id,
        name: a.name,
        target_amount: a.target_amount ?? 0,
        current_amount: a.current_amount,
        progress_pct: Math.round((a.current_amount / (a.target_amount ?? 1)) * 1000) / 10,
        remaining: round2((a.target_amount ?? 0) - a.current_amount),
      })),
    wishlist_next_up: [],
    available_cash: availableCash,
    account_closings: [],
    payables: parts.payables,
    card_charges: [],
    card_statements_due: parts.cardStatements,
    missed: [],
    installment_review: [],
    installment_auto_post: [],
    autopay_due: [],
    auto_post_scheduled: true,
    currencies: ['PHP'],
    fx,
    today: HOUSEHOLD_TODAY,
  }

  const listOf = (items: UpcomingOccurrence[]): UpcomingOccurrences => ({ items, total: items.length, auto_post_scheduled: true })
  const due: DashboardDue = {
    today: HOUSEHOLD_TODAY,
    payables: parts.payables,
    upcoming_this_month: parts.upcoming,
    card_charges: [],
    missed: [],
    card_statements_due: parts.cardStatements,
    installment_review: [],
    installment_auto_post: [],
    autopay_due: [],
    auto_post_scheduled: true,
    linked_pending: [],
    upcoming_occurrences: listOf(parts.occurrences.filter((o) => o.plan_kind !== 'subscription')),
    subscription_occurrences: listOf(parts.occurrences.filter((o) => o.plan_kind === 'subscription')),
    unposted: { items: [], total: 0, page: 1, page_size: 50, has_more: false },
  }

  return {
    today: HOUSEHOLD_TODAY,
    user: householdUser,
    accounts,
    categories: categoryList,
    tags: tagList,
    transactions: parts.transactions,
    allocations: parts.allocations,
    entries: parts.entries,
    upcoming: parts.upcoming,
    payables: parts.payables,
    cardStatements: parts.cardStatements,
    occurrences: parts.occurrences,
    quickBalances: quickBalancesFor(accounts),
    snapshot,
    due,
    installmentPlans: [],
    timeline,
    summary,
  }
}

const accounts = [payroll, savings, gcash, cash, card, joint]

/** The busy month: every state the redesign has to hold at once. */
export const household: HouseholdData = build({
  accounts,
  transactions,
  entries,
  upcoming,
  payables,
  cardStatements: [cardStatement],
  occurrences,
  allocations,
})

/**
 * The same household on a quiet day: nothing overdue, no negative balance or net flow, nothing failed. The card is
 * paid off, and a retainer came in, so the month's net flow is positive.
 */
export const calmHousehold: HouseholdData = build({
  accounts: accounts.map((a) => (a.id === card.id ? { ...a, balance: 0 } : a)),
  transactions: [tx('2026-03-11', 'Retainer, Kapé Co.', 25000, payroll, 30, 'credit'), ...transactions],
  entries,
  upcoming,
  payables: payables.filter((p) => !p.overdue && p !== statementPayable),
  cardStatements: [],
  occurrences,
  allocations: allocations.filter((a) => a.id !== OVER_BUDGET.id),
})

/**
 * Two recurring entries Mara sees as `limited` (another household member's, with only the allowlisted fields): one
 * expense and one income. Not part of any variant; a spec adds them to `/budget-entries/` when it needs that renderer.
 */
export const limitedRecurring: LimitedBudgetEntry[] = [
  {
    view: 'limited',
    id: 9101,
    permissions: recPerms,
    created_by: 'Jun R.',
    display_name: 'Water refill service',
    amount: 350,
    currency: 'PHP',
    entry_type: 'expense',
    cadence: 'monthly',
    next_occurrence: '2026-03-20',
    end_date: '2026-12-20',
    category_name: 'Utilities',
    account: { id: null, name: 'Other account' },
    counterpart: null,
    tags: [],
  },
  {
    view: 'limited',
    id: 9102,
    permissions: recPerms,
    created_by: 'Jun R.',
    display_name: 'Condo parking rental income',
    amount: 3500,
    currency: 'PHP',
    entry_type: 'income',
    cadence: 'monthly',
    next_occurrence: '2026-03-25',
    end_date: null,
    category_name: 'Rental',
    account: null,
    counterpart: null,
    tags: [],
  },
]

/** A household that has set up its accounts but recorded nothing yet. */
export const emptyHousehold: HouseholdData = build({
  accounts,
  transactions: [],
  entries: [],
  upcoming: [],
  payables: [],
  cardStatements: [],
  occurrences: [],
  allocations,
})

/** STU-692: the empty household before any account is added, so the Accounts page shows its empty state. */
export const noAccountsHousehold: HouseholdData = build({
  accounts: [],
  transactions: [],
  entries: [],
  upcoming: [],
  payables: [],
  cardStatements: [],
  occurrences: [],
  allocations: [],
})

/** STU-692: the empty household with its accounts but no envelopes, so Budgets and Savings show their empty states. */
export const noEnvelopesHousehold: HouseholdData = build({
  accounts,
  transactions: [],
  entries: [],
  upcoming: [],
  payables: [],
  cardStatements: [],
  occurrences: [],
  allocations: [],
})

const viewerPerms: AccountPermissions = {
  can_edit_settings: false,
  can_manage_shares: false,
  can_add_transactions: false,
  can_delete: false,
  can_view_details: true,
}

/**
 * STU-692: an empty household seen by a viewer. Every account is Jun's, shared with Mara to read only, so she owns
 * none (no envelope can be created) and can add records to none (no recurring entry can be created).
 */
export const viewerEmptyHousehold: HouseholdData = build({
  accounts: accounts.map((a) => ({ ...a, my_role: 'viewer', is_shared: null, owner_id: 2, owner_name: 'Jun R.', permissions: viewerPerms })),
  transactions: [],
  entries: [],
  upcoming: [],
  payables: [],
  cardStatements: [],
  occurrences: [],
  allocations: [],
})

/** STU-692: the ids `withStatusStates` adds, for the specs that find its rows. */
export const STATUS_STATE_IDS = {
  pendingTransaction: 9301,
  chargedTransaction: 9302,
  autoPostOn: 9311,
  autoPostOff: 9312,
  notReviewed: 9313,
  fullyPaid: 9314,
} as const

/**
 * STU-692: a variant that shows every status state the household lacks. A payable due today (Due today), a pending
 * Jollibee lunch dated today (Pending on the Transactions list), a Netflix charge the card took today and that is not
 * posted yet (Charged in the Due card), and four card installments: auto-post on, off after a review, not reviewed,
 * and one fully paid.
 */
export const withStatusStates = (data: HouseholdData): HouseholdData => {
  const dueToday = payable({ due_date: data.today, name: 'Maynilad water', amount: 680, source: 'budget_entry', source_id: hmoEntry.id, occurrence_date: data.today, settlement: 'manual', can_mark_paid: true, kind: 'cash' })
  const pending = tx(data.today, 'Jollibee, pending', 420, gcash, 23, 'debit', { id: STATUS_STATE_IDS.pendingTransaction, is_posted: false })
  const charged = tx(data.today, 'Netflix Standard', 549, card, 27, 'debit', {
    id: STATUS_STATE_IDS.chargedTransaction,
    is_posted: false,
    is_recurring: true,
    budget_entry_id: netflixEntry.id,
  })
  const chargedOnCard: FullCharge = {
    view: 'full',
    date: data.today,
    original_date: null,
    overdue: false,
    occurrence_date: null,
    name: 'Netflix Standard',
    kind: 'pending',
    plan_kind: null,
    source: 'transaction',
    source_id: charged.id,
    amount: 549,
    currency: 'PHP',
    can_mark_paid: false,
    recurring: true,
  }
  const cardCharges: CardCharges = { account_id: card.id, account_name: card.name, currency: 'PHP', statement_cycle: true, missed: [], charges: [chargedOnCard] }
  const installment = (id: number, name: string, extra: Partial<FullBudgetEntry>): FullBudgetEntry =>
    entry(name, 'expense', 2500, '2026-03-20', card, { id, kind: 'installment', anchor_day: 20, end_mode: 'after_occurrences', max_occurrences: 10, occurrences_paid: 2, ...extra })
  const installments = [
    installment(STATUS_STATE_IDS.autoPostOn, 'Laptop, 12 months', { auto_post_enabled: true, installment_reviewed: true }),
    installment(STATUS_STATE_IDS.autoPostOff, 'Aircon, 12 months', { auto_post_enabled: false, installment_reviewed: true }),
    installment(STATUS_STATE_IDS.notReviewed, 'Washing machine, 12 months', { auto_post_enabled: false, installment_reviewed: false }),
    installment(STATUS_STATE_IDS.fullyPaid, 'Rice cooker, 6 months', { max_occurrences: 0, occurrences_paid: 6, auto_post_enabled: true, installment_reviewed: true }),
  ]
  const unposted = [charged, ...data.due.unposted.items]
  return {
    ...data,
    transactions: [pending, charged, ...data.transactions],
    entries: [...data.entries, ...installments],
    payables: [dueToday, ...data.payables],
    snapshot: { ...data.snapshot, payables: [dueToday, ...data.snapshot.payables] },
    due: {
      ...data.due,
      payables: [dueToday, ...data.due.payables],
      card_charges: [...data.due.card_charges, cardCharges],
      unposted: { ...data.due.unposted, items: unposted, total: unposted.length },
    },
  }
}

/** The busy month with every occurrence listed as Upcoming: the Upcoming tab's count badge reads 18, a two-digit count. */
export const allUpcomingHousehold: HouseholdData = {
  ...household,
  due: {
    ...household.due,
    upcoming_occurrences: { items: household.occurrences, total: household.occurrences.length, auto_post_scheduled: true },
    subscription_occurrences: { items: [], total: 0, auto_post_scheduled: true },
  },
}

/**
 * The eight colours the tag and category picker used to offer, and the palette swatch (`--swatch-N`) each one is now
 * drawn with. Saved records keep these strings; the app only resolves them to a swatch for display.
 */
export const LEGACY_SWATCHES: readonly { color: string; swatch: number }[] = [
  { color: '#2563eb', swatch: 1 },
  { color: '#7c3aed', swatch: 2 },
  { color: '#16a34a', swatch: 3 },
  { color: '#f97316', swatch: 4 },
  { color: '#db2777', swatch: 5 },
  { color: '#0891b2', swatch: 6 },
  { color: '#ca8a04', swatch: 7 },
  { color: '#dc2626', swatch: 8 },
]

const legacyNames = ['Blue', 'Violet', 'Green', 'Orange', 'Pink', 'Cyan', 'Gold', 'Red']
/** One tag per old swatch, saved with that swatch's colour string. */
export const legacyTags: Tag[] = LEGACY_SWATCHES.map((l, i) => ({
  id: 51 + i,
  name: `${legacyNames[i]} swatch`,
  color: l.color,
  is_system: false,
  created_at: '2025-06-01T00:00:00',
}))
/** The same blue as swatch 1, saved in capitals: still a legacy swatch, and it must stay as saved. */
export const upperBlueTag: Tag = { id: 59, name: 'Capital blue', color: '#2563EB', is_system: false, created_at: '2025-06-01T00:00:00' }
/** Tags saved with a colour outside the palette (not a legacy swatch): they keep their colour as saved. */
export const customTags: Tag[] = tags.filter((t) => !LEGACY_SWATCHES.some((l) => l.color === t.color))
/** Categories saved with a legacy swatch colour (`Groceries`) and with a colour outside the palette (`Dining out`). */
export const colouredCategories: Category[] = categories.map((c) =>
  c.id === 22 ? { ...c, color: '#16a34a' } : c.id === 23 ? { ...c, color: '#E599F7' } : c,
)

/**
 * The busy month with saved colours: every old swatch on a tag, plus tags and categories with colours outside the
 * palette. One transaction, on the newest day, carries every tag so the chips can be read together.
 */
export const colouredHousehold: HouseholdData = build({
  accounts,
  transactions: [tx('2026-03-12', 'Tag colour check', 100, cash, 22, 'debit', { tags: [...legacyTags, upperBlueTag, ...tags] }), ...transactions],
  entries,
  upcoming,
  payables,
  cardStatements: [cardStatement],
  occurrences,
  allocations,
  categories: colouredCategories,
  tags: [...tags, ...legacyTags, upperBlueTag],
})

/**
 * The summary with a computed "Transfer fees" row: money spent that belongs to no category, so the spending
 * breakdown cannot filter the list by it. The fee is added to the totals, so the summary stays consistent.
 */
export function withTransferFees(data: HouseholdData, fee: number): TransactionSummary {
  const { summary } = data
  const net = (income: number, expenses: number): number => round2(income - expenses)
  return {
    ...summary,
    summary: {
      ...summary.summary,
      total_expenses: round2(summary.summary.total_expenses + fee),
      net_flow: net(summary.summary.total_income, summary.summary.total_expenses + fee),
    },
    by_currency: summary.by_currency.map((row) => ({
      ...row,
      total_expenses: round2(row.total_expenses + fee),
      net_flow: net(row.total_income, row.total_expenses + fee),
      category_breakdown: { ...row.category_breakdown, 'Transfer fees': { income: 0, expenses: fee } },
    })),
  }
}

const pageOf = <T>(items: T[]): PaginatedResponse<T> => ({ items, total: items.length, has_more: false })

/** Throws on a query parameter outside `known`, so the fake never ignores a filter a page sends. */
function only(query: URLSearchParams, known: string[]): void {
  const unknown = [...query.keys()].filter((k) => !known.includes(k))
  if (unknown.length) throw new Error(`unhandled query parameter(s): ${unknown.join(', ')}`)
}

/** One page of `items` for `limit` and `offset`; `total` counts every match, so the page's pagination agrees. */
function pageFor<T>(items: T[], query: URLSearchParams): PaginatedResponse<T> {
  const offset = Number(query.get('offset') ?? 0)
  const limit = Number(query.get('limit') ?? items.length)
  const slice = items.slice(offset, offset + limit)
  return { items: slice, total: items.length, has_more: offset + slice.length < items.length }
}

/**
 * `GET /transactions/` as the pages ask it: `start_date` and `end_date` (inclusive, by Manila day), `order`
 * (newest first unless `asc`, by date then id as the API sorts), `limit` and `offset`. Sorted before it is paged.
 * The list's filters as the API applies them: `account_ids` (any leg on one of them), `transaction_types`, and
 * `entered_by=me` (the caller's own rows, which the API sends as the `full` view).
 */
export function transactionsFor(data: HouseholdData, query: URLSearchParams): PaginatedResponse<Transaction> {
  only(query, ['start_date', 'end_date', 'order', 'limit', 'offset', 'account_ids', 'transaction_types', 'entered_by', 'category_names'])
  const dayOf = (t: Transaction): string => (t.view === 'limited' ? t.date : t.transaction_date).slice(0, 10)
  const start = query.get('start_date')?.slice(0, 10)
  const end = query.get('end_date')?.slice(0, 10)
  const accountIds = query.getAll('account_ids').map(Number)
  const types = query.getAll('transaction_types')
  const enteredBy = query.get('entered_by')
  const categoryNames = query.getAll('category_names')
  const categoryOf = (t: Transaction): string | undefined =>
    t.view === 'shared_full' ? (t.category_name ?? undefined) : t.view === 'full' ? data.categories.find((c) => c.id === t.category_id)?.name : undefined
  if (enteredBy !== null && enteredBy !== 'me') throw new Error(`unhandled entered_by: ${enteredBy}`)
  const touches = (t: Transaction): boolean =>
    t.view === 'limited'
      ? accountIds.includes(t.account?.id ?? -1)
      : [t.account_id, t.transfer_from_account_id, t.transfer_to_account_id].some((id) => id != null && accountIds.includes(id))
  const matches = data.transactions.filter(
    (t) =>
      (!start || dayOf(t) >= start) &&
      (!end || dayOf(t) <= end) &&
      (!accountIds.length || touches(t)) &&
      (!types.length || types.includes(t.transaction_type)) &&
      (!categoryNames.length || categoryNames.includes(categoryOf(t) ?? '')) &&
      (enteredBy === null || t.view === 'full'),
  )
  // The API's order: transaction_date, then id, both ascending for `asc` and both descending otherwise.
  const whenOf = (t: Transaction): string => (t.view === 'limited' ? t.date : t.transaction_date)
  const sign = query.get('order') === 'asc' ? 1 : -1
  const ordered = [...matches].sort((a, b) => sign * (whenOf(a).localeCompare(whenOf(b)) || a.id - b.id))
  return pageFor(ordered, query)
}

/**
 * `GET /transactions/scheduled` as the Scheduled view asks it: the variant's unrecorded occurrences from
 * `start_date` to `end_date` (inclusive days), in date order, as one page. The fixture has no future transactions.
 */
export function scheduledFor(data: HouseholdData, query: URLSearchParams): ScheduledList {
  only(query, ['start_date', 'end_date', 'limit', 'cursor'])
  const start = query.get('start_date')?.slice(0, 10)
  const end = query.get('end_date')?.slice(0, 10)
  const dayOf = (o: UpcomingOccurrence): string => o.effective_date ?? o.occurrence_date
  const items = data.occurrences
    .filter((o) => (!start || dayOf(o) >= start) && (!end || dayOf(o) <= end))
    .map((o) => ({ kind: 'occurrence' as const, day: dayOf(o), occurrence: o }))
  return {
    items,
    total: items.length,
    transactions_total: 0,
    occurrences_total: items.length,
    occurrences_through: end ?? '2026-04-11',
    auto_post_scheduled: true,
    next_cursor: null,
  }
}

/** `GET /budget-entries/` as the pages ask it: `entry_type`, `is_active`, `limit` and `offset`. */
export function budgetEntriesFor(data: HouseholdData, query: URLSearchParams): PaginatedResponse<BudgetEntry> {
  only(query, ['entry_type', 'is_active', 'limit', 'offset'])
  const kind = query.get('entry_type')
  const active = query.get('is_active')
  const matches = data.entries.filter(
    (e) => (!kind || e.entry_type === kind) && (active === null || (e.view === 'limited' ? true : String(e.is_active) === active)),
  )
  return pageFor(matches, query)
}

/** The one bank preset the account form's minimum due rule offers (a card is being added or edited). */
const minimumDuePreset: MinimumDuePreset = {
  key: 'hsbc',
  label: 'HSBC',
  effective_from: '2026-01-01',
  rule: {
    version: 1,
    preset: 'hsbc',
    base_percent: '3',
    base_excludes: [],
    installment_percent: null,
    floor: { PHP: '500' },
    floored_terms: [],
    added_terms: [],
    annual_fee: null,
    rounding: 'half_up',
  },
}

/** Every call the dashboard, Transactions, Allocations and the account form make on load, answered from `data`. */
export const householdRoutes = (data: HouseholdData = household): ApiRoute[] => [
  apiRoute<PaginatedResponse<Account>>('GET', '/accounts/', pageOf(data.accounts)),
  apiRoute<PaginatedResponse<Allocation>>('GET', '/allocations/', pageOf(data.allocations)),
  apiRoute<QuickBalances>('GET', '/dashboard/quick-balances', data.quickBalances),
  apiRoute<DashboardSnapshot>('GET', '/dashboard/snapshot', data.snapshot),
  apiRoute<CashflowTimeline>('GET', '/forecast/timeline', data.timeline),
  apiRoute<Tag[]>('GET', '/tags/', data.tags),
  apiRoute<TransactionSummary>('GET', '/transactions/summary/period', data.summary),
  apiRoute<Category[]>('GET', '/categories/', data.categories),
  queryRoute<PaginatedResponse<BudgetEntry>>('GET', '/budget-entries/', (q) => budgetEntriesFor(data, q)),
  apiRoute<InstallmentPlans>('GET', '/budget-entries/installment-plans', { items: data.installmentPlans, auto_post_scheduled: true, today: data.today }),
  apiRoute<UpcomingOccurrences>('GET', '/budget-entries/upcoming-occurrences', {
    items: data.occurrences,
    total: data.occurrences.length,
    auto_post_scheduled: true,
  }),
  queryRoute<PaginatedResponse<Transaction>>('GET', '/transactions/', (q) => transactionsFor(data, q)),
  queryRoute<ScheduledList>('GET', '/transactions/scheduled', (q) => scheduledFor(data, q)),
  apiRoute<{ items: DescriptionSuggestion[] }>('GET', '/transactions/description-suggestions', { items: [] }),
  apiRoute<DashboardDue>('GET', '/dashboard/due', data.due),
  apiRoute<{ items: CardCredit[] }>('GET', '/cards/credit', { items: [] }),
  apiRoute<MinimumDuePreset[]>('GET', '/accounts/minimum-due-presets', [minimumDuePreset]),
  apiRoute<HouseholdView[]>('GET', '/household/', []),
  apiRoute<ReceivedShare[]>('GET', '/shares/received', []),
  apiRoute<ReceivedHouseholdShare[]>('GET', '/shares/received/household', []),
  apiRoute<HouseholdShares>('GET', '/tags/household/shares', { tag_id: householdTag.id, shares: [] }),
]

/**
 * `GET /transactions/summary/period` answered for the window asked (`start_date` and `end_date`, by Manila day), from
 * the variant's rows, so the dashboard's week, month and year each read their own totals. `householdRoutes` answers
 * every window with the month's summary; a spec that switches the period adds this route after it.
 */
export const periodSummaryRoute = (data: HouseholdData = household): ApiRoute =>
  queryRoute<TransactionSummary>('GET', '/transactions/summary/period', (q) => {
    only(q, ['start_date', 'end_date'])
    // A bound left out is open on that side.
    const start = q.get('start_date')?.slice(0, 10) ?? '0000-01-01'
    const end = q.get('end_date')?.slice(0, 10) ?? '9999-12-31'
    return periodSummaryFor(data, start, end)
  })

/** The variant's period summary for the days `start` to `end` (inclusive, `YYYY-MM-DD`), as `periodSummaryRoute` answers. */
export const periodSummaryFor = (data: HouseholdData, start: string, end: string): TransactionSummary =>
  summaryOf(data.transactions, data.categories, start, end)

/** The projection `withProjection` adds: the rest of March, the two payrolls in and the HMO add-on out. */
export const PROJECTION = { income: 82500, expenses: 1450 } as const

/**
 * The variant with the snapshot's projection filled in: month 0 runs from today to 1 April, opening at available cash,
 * with `PROJECTION`'s income and spending. The built variants leave the projection empty.
 */
export const withProjection = (data: HouseholdData): HouseholdData => {
  const { snapshot } = data
  const opening = snapshot.balances.by_currency[0].available_cash
  const net = round2(PROJECTION.income - PROJECTION.expenses)
  const closing = round2(opening + net)
  const figures = {
    opening_balance: opening,
    income: PROJECTION.income,
    expenses: PROJECTION.expenses,
    unposted_expenses: 0,
    statement_payables: 0,
    net,
    closing_balance: closing,
    by_account: [],
    unassigned_closing: 0,
    overflow_moves: [],
  }
  const period: ForecastPeriod = {
    period_label: 'March 2026',
    period_start: `${data.today}T00:00:00`,
    period_end: '2026-04-01T00:00:00',
    ...figures,
    by_currency: [{ currency: 'PHP', ...figures, moved_in: 0, moved_out: 0, loan_payables: 0 }],
  }
  return { ...data, snapshot: { ...snapshot, forecast_next_3_months: [period] } }
}

/**
 * The variant whose snapshot carries exchange-rate facts, so the dashboard shows its FX notice: one row with no stored
 * rate (the unconverted banner) and the day's dollar rate (the attribution line). Only the snapshot changes.
 */
export const withFxNotice = (data: HouseholdData): HouseholdData => ({
  ...data,
  snapshot: {
    ...data.snapshot,
    fx: {
      rates: [{ base: 'USD', quote: 'PHP', rate: 58, as_of: data.today, source: 'currency-api', stale: false }],
      unconverted_count: 1,
    },
  },
})

/** The Allocations Wishlist tab's calls, for a household with nothing on its wishlist yet. */
export const wishlistRoutes = (data: HouseholdData = household): ApiRoute[] => [
  apiRoute<WishlistItem[]>('GET', '/wishlist/', []),
  apiRoute<WishlistPlan>('GET', '/wishlist/plan', { monthly_disposable: data.snapshot.monthly_summary.monthly_disposable, savings_rate: 0, items: [] }),
]

/** A variant whose user has pinned the payroll account as their main account (the Forecast's "Main" scope). */
export const withMainAccount = (data: HouseholdData): HouseholdData => ({ ...data, user: { ...data.user, main_account_id: payroll.id } })

/** A variant where account `accountId` holds `balance`, in the accounts list and its quick-balance tile. */
export const withBalance = (data: HouseholdData, accountId: number, balance: number): HouseholdData => {
  const accounts = data.accounts.map((a) => (a.id === accountId ? { ...a, balance } : a))
  return { ...data, accounts, quickBalances: quickBalancesFor(accounts) }
}

/**
 * Quick-balance figures that must read as an unsigned zero. A debit tile prints its balance and a card tile prints Owed,
 * the negated balance, so `input` is the number the amount formatter is given: a card at 0 owes a computed `-0`, which
 * JSON cannot carry from the API.
 */
export const ZERO_FIGURE_CASES: readonly { name: string; accountId: number; line: 'balance' | 'owed'; balance: number; input: string }[] = [
  { name: 'zero', accountId: payroll.id, line: 'balance', balance: 0, input: '0' },
  { name: 'computed negative zero', accountId: card.id, line: 'owed', balance: 0, input: '-0' },
  { name: 'under half a centavo', accountId: card.id, line: 'owed', balance: -0.004, input: '0.004' },
  { name: 'under half a centavo below zero', accountId: card.id, line: 'owed', balance: 0.004, input: '-0.004' },
]

/**
 * Two Household-tagged rows on the joint account whose amount is zero (a voided expense and a voided refund), for the
 * zero-sign specs. Defined after every other module-level row, so no other row's id moves.
 */
const zeroRows: FullTransaction[] = [
  tx('2026-03-11', 'Voided palengke run', 0, joint, 22, 'debit', { tags: [householdTag] }),
  tx('2026-03-11', 'Voided refund', 0, joint, 30, 'credit', { tags: [householdTag] }),
]
/** The zero rows `withZeroRows` adds: what each is called, its type and its account. */
export const ZERO_ROWS: readonly { description: string; type: FullTransaction['transaction_type']; accountId: number }[] = zeroRows.map((t) => ({
  description: t.description ?? '',
  type: t.transaction_type,
  accountId: t.account_id,
}))
/** A variant with the zero rows on the joint account (Transactions, the account page and the Household view list them). */
export const withZeroRows = (data: HouseholdData): HouseholdData => ({ ...data, transactions: [...zeroRows, ...data.transactions] })

/** The card's returned purchase and dollar refund on its closed statement (`cardStatements`): credits, so negative. */
export const STATEMENT_REFUNDS = { pesos: -1250, dollars: -40, dollarsInPesos: -2320 } as const
/**
 * `GET /accounts/{card}/statements` for the owner: the closed 20 February statement, whose two charges, returned
 * purchase and converted dollar refund add up to its amount due.
 */
export const cardStatements: CardStatements = {
  view: 'full',
  account_id: card.id,
  name: card.name,
  currency: 'PHP',
  statements: [
    {
      close_date: cardStatement.close_date,
      due_date: cardStatement.due_date,
      amount_due: CLOSED_STATEMENT,
      currency: 'PHP',
      status: 'open',
      statement_balance: CLOSED_STATEMENT,
      lines: [
        { date: '2026-02-03T00:00:00', display_description: "Rustan's Makati", amount: 9560.55, transaction_id: 901 },
        { date: '2026-02-07T00:00:00', display_description: 'Uniqlo Glorietta', amount: 6490, transaction_id: 902 },
        { date: '2026-02-09T00:00:00', display_description: 'Uniqlo Glorietta return', amount: STATEMENT_REFUNDS.pesos, transaction_id: 903 },
        {
          date: '2026-02-14T00:00:00',
          display_description: 'Klook refund',
          amount: STATEMENT_REFUNDS.dollarsInPesos,
          transaction_id: 904,
          estimated: true,
          original_amount: STATEMENT_REFUNDS.dollars,
          original_currency: 'USD',
          rate: 58,
          rate_as_of: '2026-02-14',
          rate_stale: false,
        },
      ],
      unconverted_lines: [],
    },
  ],
}

/** The name of the zero-amount forecast event `withZeroTimelineEvent` adds. */
export const ZERO_EVENT_NAME = 'Maynilad bill adjustment'
/**
 * A variant whose forecast has one more payroll event on 27 March whose amount is zero (a bill adjusted to nothing):
 * the running balance carries over from the event before it.
 */
export const withZeroTimelineEvent = (data: HouseholdData): HouseholdData => {
  const add = (events: CashflowTimeline['events']): CashflowTimeline['events'] => {
    const at = events.findIndex((e) => e.date > '2026-03-27')
    const before = at > 0 ? events[at - 1].running_balance : data.timeline.opening_balance
    const zero: CashflowTimelineEvent = {
      date: '2026-03-27',
      name: ZERO_EVENT_NAME,
      amount: 0,
      type: 'expense',
      source: 'budget_entry',
      source_id: mayniladEntry.id,
      event_id: `be-${mayniladEntry.id}-adjusted`,
      currency: 'PHP',
      accounts: [{ account_id: payroll.id, account_name: payroll.name, amount: 0, currency: 'PHP' }],
      running_balance: before,
    }
    return at < 0 ? [...events, zero] : [...events.slice(0, at), zero, ...events.slice(at)]
  }
  const { timeline } = data
  return {
    ...data,
    timeline: { ...timeline, events: add(timeline.events), by_currency: timeline.by_currency.map((row) => ({ ...row, events: add(row.events) })) },
  }
}

/**
 * A variant whose cash-flow timeline also holds dollars: a USD row with an opening balance and no events, so the
 * Forecast offers its currency control. Every other answer is the variant's own.
 */
export const withDollarTimeline = (data: HouseholdData): HouseholdData => {
  const { by_currency, currencies } = data.timeline
  const peso = by_currency[0]
  return {
    ...data,
    timeline: {
      ...data.timeline,
      currencies: [...currencies, 'USD'],
      by_currency: [
        ...by_currency,
        {
          ...peso,
          currency: 'USD',
          opening_balance: 1250,
          lowest_balance: 1250,
          trough_date: data.today,
          closing_balance: 1250,
          by_account: [],
          events: [],
        },
      ],
    },
  }
}

/**
 * The caller's own Household view (`GET /household/` and the four tabs' calls) for `data`: the accounts and
 * transactions tagged Household, this month's recorded totals from those transactions, and the upcoming items of
 * Household-tagged recurring entries.
 */
export const householdViewRoutes = (data: HouseholdData = household): ApiRoute[] => {
  const sharer = { id: data.user.id, name: 'Mara S.' }
  const tagged = data.transactions.filter((t) => t.view !== 'limited' && t.tags.some((tag) => tag.id === householdTag.id))
  const accountIds = new Set(tagged.map((t) => (t.view === 'limited' ? -1 : t.account_id)))
  const taggedEntries = new Set(data.entries.filter((e) => e.view !== 'limited' && e.tags.some((tag) => tag.id === householdTag.id)).map((e) => e.id))
  const upcomingItems = data.upcoming.filter((u) => u.source_id !== undefined && u.source_id !== null && taggedEntries.has(u.source_id))
  const month = data.today.slice(0, 7)
  const inMonth = tagged.filter((t) => t.view !== 'limited' && t.transaction_date.slice(0, 7) === month)
  const total = (type: Transaction['transaction_type']): number => round2(inMonth.filter((t) => t.transaction_type === type).reduce((sum, t) => sum + t.amount, 0))
  const monthRow = {
    month,
    kind: 'recorded' as const,
    currencies: [{ currency: 'PHP' as const, income: total('credit'), expense: total('debit'), fees: 0, moved_in: 0, moved_out: 0, paid_from_other_accounts: 0 }],
  }
  const views: HouseholdView[] = [{ sharer_id: sharer.id, sharer_name: sharer.name, is_self: true }]
  const base = `/household/${sharer.id}`
  return [
    apiRoute<HouseholdView[]>('GET', '/household/', views),
    apiRoute<HouseholdDashboard>('GET', `${base}/dashboard`, {
      sharer,
      accounts: data.accounts.filter((a) => accountIds.has(a.id)),
      month: monthRow,
      upcoming: upcomingItems,
    }),
    queryRoute<HouseholdTransactions>('GET', `${base}/transactions`, (q) => {
      only(q, ['start_date', 'end_date', 'limit', 'offset'])
      return pageFor(tagged, q)
    }),
    queryRoute<HouseholdUpcoming>('GET', `${base}/upcoming`, (q) => {
      only(q, ['days'])
      return { sharer, items: upcomingItems, days: Number(q.get('days') ?? 30) }
    }),
    queryRoute<HouseholdMonthly>('GET', `${base}/monthly`, (q) => {
      only(q, ['from', 'to'])
      return { sharer, from: q.get('from') ?? month, to: q.get('to') ?? month, months: [monthRow] }
    }),
  ]
}

/**
 * The account Mara fills in on Add Account in the selection specs: every field moved off its default (a savings
 * account in dollars, a spending wallet, one tag, a balance and a note), so a later change to one control can be
 * checked against the rest.
 */
export const newAccountInput = {
  name: 'Maya savings',
  account_type: 'savings',
  is_spending_wallet: true,
  currency: 'USD',
  balance: 1500,
  description: 'Rainy-day buffer',
  tag_ids: [tripTag.id],
} as const satisfies AccountInput

/** What `POST /accounts/` answers for `sent`: the new account, owned by the household's user, its tags resolved. */
export const createdAccount = (data: HouseholdData, id: number, sent: AccountInput): Account =>
  acct({
    id,
    name: sent.name ?? '',
    account_type: sent.account_type ?? 'checking',
    balance: sent.balance ?? 0,
    currency: sent.currency ?? 'PHP',
    is_active: sent.is_active ?? true,
    is_spending_wallet: sent.is_spending_wallet,
    description: sent.description,
    tags: data.tags.filter((t) => sent.tag_ids?.includes(t.id)),
    owner_id: data.user.id,
    created_at: `${data.today}T02:00:00`,
  })

/** `POST /accounts/` answering each create in turn with the next of `created` (201), the last one repeating. */
export const createAccountRoute = (created: Account[]): ApiRoute =>
  sequenceRoute<Account>('POST', '/accounts/', created.map((body) => ({ body, status: 201 })))

/**
 * The creates the Add Transaction, Add Recurring Entry and allocation dialogs send, answered with a record built
 * from the variant's own accounts (201). The specs read what was sent from the mock's captured bodies.
 */
export const householdCreateRoutes = (data: HouseholdData): ApiRoute[] => {
  const account = data.accounts[0]
  const sentTransaction: TransactionInput = { description: 'New transaction', amount: 1, account_id: account.id, transaction_type: 'debit' }
  const sentEntry: BudgetEntryInput = { name: 'New recurring entry', amount: 1, account_id: account.id, entry_type: 'expense' }
  return [
    apiRoute<Transaction>('POST', '/transactions/', tx(data.today, sentTransaction.description ?? '', sentTransaction.amount ?? 0, account, 22), 201),
    apiRoute<BudgetEntry>('POST', '/budget-entries/', entry(sentEntry.name ?? '', 'expense', sentEntry.amount ?? 0, data.today, account), 201),
    apiRoute<Allocation>('POST', '/allocations/', alloc({ id: 69, name: 'New allocation', allocation_type: 'budget', current_amount: 0, account_id: account.id }), 201),
  ]
}

/**
 * A variant that also holds dollars: the snapshot lists USD with a $1,250.00 balance, and this month's summary has
 * a USD row with one $86.40 Dining out expense, so the dashboard and the spending breakdown offer a currency control.
 */
export const withDollars = (data: HouseholdData): HouseholdData => {
  const { snapshot, summary } = data
  const dining = { income: 0, expenses: 86.4 }
  return {
    ...data,
    snapshot: {
      ...snapshot,
      currencies: [...snapshot.currencies, 'USD'],
      balances: { ...snapshot.balances, by_currency: [...snapshot.balances.by_currency, { currency: 'USD', total: 1250, available_cash: 1250 }] },
      monthly_summary: {
        ...snapshot.monthly_summary,
        by_currency: [
          ...snapshot.monthly_summary.by_currency,
          { currency: 'USD', monthly_income: 0, monthly_expenses: 0, moved_in: 0, moved_out: 0, monthly_disposable: 0 },
        ],
      },
    },
    summary: {
      ...summary,
      by_currency: [
        ...summary.by_currency,
        {
          currency: 'USD',
          total_income: 0,
          total_expenses: dining.expenses,
          moved_in: 0,
          moved_out: 0,
          net_flow: -dining.expenses,
          transaction_count: 1,
          category_breakdown: { 'Dining out': dining },
        },
      ],
    },
  }
}

/**
 * A variant in five currencies (PHP, USD, EUR, GBP, JPY): the dollar variant plus empty euro, pound and yen rows, so
 * the dashboard's currency control has five choices.
 */
export const withFiveCurrencies = (data: HouseholdData): HouseholdData => {
  const dollars = withDollars(data)
  const extra = ['EUR', 'GBP', 'JPY'] as const
  const { snapshot } = dollars
  return {
    ...dollars,
    snapshot: {
      ...snapshot,
      currencies: [...snapshot.currencies, ...extra],
      balances: { ...snapshot.balances, by_currency: [...snapshot.balances.by_currency, ...extra.map((currency) => ({ currency, total: 0, available_cash: 0 }))] },
      monthly_summary: {
        ...snapshot.monthly_summary,
        by_currency: [
          ...snapshot.monthly_summary.by_currency,
          ...extra.map((currency) => ({ currency, monthly_income: 0, monthly_expenses: 0, moved_in: 0, moved_out: 0, monthly_disposable: 0 })),
        ],
      },
    },
  }
}

/** The GCash rows the account-history variant adds: one jeepney top-up a day, 2 to 27 January. */
const GCASH_HISTORY_DAYS = 26

/**
 * A variant whose GCash account has 30 rows, two pages of the account page's 25: its four March and February rows
 * and 26 January top-ups, the oldest "GCash top-up, 2 January".
 */
export const withAccountHistory = (data: HouseholdData): HouseholdData => {
  const older = Array.from({ length: GCASH_HISTORY_DAYS }, (_, i) => {
    const day = GCASH_HISTORY_DAYS + 1 - i
    return tx(`2026-01-${String(day).padStart(2, '0')}`, `GCash top-up, ${day} January`, 500, gcash, 25)
  })
  return { ...data, transactions: [...data.transactions, ...older] }
}

/** `GET /accounts/{id}` for every account in `data`, as the account page asks it. */
export const allAccountDetailRoutes = (data: HouseholdData): ApiRoute[] => data.accounts.map((a) => apiRoute<Account>('GET', `/accounts/${a.id}`, a))

const plan = (entryId: number, name: string, nextCharge: string, paymentsLeft: number, paymentsTotal: number): InstallmentPlan => ({
  view: 'full',
  entry_id: entryId,
  name,
  account_name: card.name,
  amount: 2500,
  remaining_total: 2500 * paymentsLeft,
  currency: 'PHP',
  next_charge: nextCharge,
  effective_date: nextCharge,
  missed: 0,
  payments_left: paymentsLeft,
  payments_total: paymentsTotal,
  can_mark_paid: true,
  auto_post: null,
  block_reason: null,
  can_review: false,
  recordable: false,
})

/**
 * A variant with more than a page (three rows) in every Due card tab: three more overdue payables, four rows not
 * posted yet, two more subscriptions and four installment plans.
 */
export const withLongDueLists = (data: HouseholdData): HouseholdData => {
  const overdue = (name: string, original: string, amount: number): Payable =>
    payable({ due_date: data.today, original_date: original, overdue: true, name, amount, source: 'budget_entry', source_id: hmoEntry.id, occurrence_date: original, settlement: 'manual', can_mark_paid: true, kind: 'cash' })
  const morePayables = [overdue('Condo dues', '2026-03-02', 3200), overdue('Pag-IBIG contribution', '2026-03-05', 200), overdue('SSS contribution', '2026-03-06', 1350)]
  const unposted = [
    tx('2026-03-12', 'Shopee order, pending', 1290, card, 22, 'debit', { is_posted: false }),
    tx('2026-03-11', 'Lazada order, pending', 845, card, 22, 'debit', { is_posted: false }),
    tx('2026-03-10', 'Foodpanda, pending', 512, card, 23, 'debit', { is_posted: false }),
    tx('2026-03-09', 'Grab Food, pending', 388, card, 23, 'debit', { is_posted: false }),
  ]
  const youtube = entry('YouTube Premium', 'expense', 189, '2026-03-16', card, { anchor_day: 16, kind: 'subscription' })
  const icloud = entry('iCloud+ 200GB', 'expense', 149, '2026-03-22', card, { anchor_day: 22, kind: 'subscription' })
  const subscriptions = [...data.due.subscription_occurrences.items, occurrence(youtube, '2026-03-16', card), occurrence(icloud, '2026-03-22', card)]
  return {
    ...data,
    due: {
      ...data.due,
      payables: [...data.due.payables, ...morePayables],
      unposted: { items: unposted, total: unposted.length, page: 1, page_size: 50, has_more: false },
      subscription_occurrences: { ...data.due.subscription_occurrences, items: subscriptions, total: subscriptions.length },
    },
    installmentPlans: [
      plan(791, 'iPhone 16, 24 months', '2026-03-15', 18, 24),
      plan(792, 'Aircon, 12 months', '2026-03-18', 7, 12),
      plan(793, 'Washing machine, 6 months', '2026-03-25', 3, 6),
      plan(794, 'Sofa, 12 months', '2026-04-02', 9, 12),
    ],
  }
}

/**
 * What the account detail page (`/accounts/:id`) asks for, answered from `data`: the account, its transactions
 * (`transactionsFor` filters them by `account_ids`) and, for a credit card, an empty credit panel.
 */
export const accountDetailRoutes = (data: HouseholdData, accountId: number): ApiRoute[] => {
  const account = data.accounts.find((a) => a.id === accountId)
  if (!account) throw new Error(`no account ${accountId} in the fixture`)
  const credit: CardCreditDetail = {
    account_id: account.id,
    name: account.name,
    currency: 'PHP',
    credit: null,
    rule: null,
    statements: [],
    open_cycle: null,
    unposted: null,
  }
  return [
    apiRoute<Account>('GET', `/accounts/${accountId}`, account),
    apiRoute<CardCreditDetail>('GET', `/cards/${accountId}/credit`, credit),
  ]
}

/**
 * What the Mark paid dialog asks for when it opens on a recurring entry (`GET /budget-entries/{id}/occurrences`):
 * the entry's unrecorded occurrences from `data.occurrences`, none of them due yet.
 */
export const entryOccurrencesRoute = (data: HouseholdData, entryId: number): ApiRoute => {
  const entry = data.entries.find((e) => e.id === entryId)
  if (!entry || entry.view === 'limited') throw new Error(`no full recurring entry ${entryId} in the fixture`)
  const listed: EntryOccurrences = {
    entry_id: entryId,
    today: data.today,
    capped: false,
    kind: entry.kind ?? null,
    due_unposted: 0,
    omitted: 0,
    occurrences: data.occurrences
      .filter((o) => o.entry_id === entryId)
      .map((o) => ({ occurrence_date: o.occurrence_date, effective_date: o.effective_date, due: false, linked: null, skipped_before: 0 })),
  }
  return apiRoute<EntryOccurrences>('GET', `/budget-entries/${entryId}/occurrences`, listed)
}

/**
 * The lookups the Due card's and Recurring tab's dialogs make when they open, answered from `data`: each full
 * recurring entry (`GET /budget-entries/{id}`, for Mark paid) with the occurrence it was opened for listed as due and
 * unrecorded (`.../occurrences?include=`), and each credit card's detail for Pay (no limit, no closed statements).
 */
export const householdDialogRoutes = (data: HouseholdData): ApiRoute[] => [
  ...data.entries
    .filter((e) => e.view !== 'limited')
    .flatMap((e) => [
      apiRoute<BudgetEntry>('GET', `/budget-entries/${e.id}`, e),
      queryRoute<EntryOccurrences>('GET', `/budget-entries/${e.id}/occurrences`, (q) => {
        only(q, ['include'])
        const day = q.get('include') ?? data.today
        return {
          entry_id: e.id,
          today: data.today,
          capped: false,
          kind: e.kind ?? null,
          due_unposted: 0,
          oldest_due: null,
          latest_due: null,
          oldest_unrecorded: day,
          omitted: 0,
          occurrences: [{ occurrence_date: day, effective_date: day, due: day <= data.today, linked: null, skipped_before: 0, omitted_before: 0 }],
        }
      }),
    ]),
  ...data.accounts.filter((a) => a.account_type === 'credit').flatMap((a) => accountDetailRoutes(data, a.id).filter((r) => r.path.endsWith('/credit'))),
]

/**
 * The saves the action dialogs send, each answered as the API would (200) from `data`: a transaction or account
 * update returns the record, a Mark paid or Charged (`.../materialize`) returns the recorded transaction, a forced
 * date on a payable's occurrence returns that date, and an account's shares list only its owner. Opening an account
 * (`GET /accounts/{id}`) returns it.
 */
/** The person the share dialog's lookup finds. */
export const SHARE_MATCH: UserMatch = { id: 3, display_name: 'Lia M.' }

/** The share `POST /accounts/{id}/shares` answers for Lia, the person the lookup finds. */
export const sharedWithMatch = (data: HouseholdData, account: Account): AccountShare => ({
  id: 400 + account.id,
  account_id: account.id,
  user_id: SHARE_MATCH.id,
  display_name: SHARE_MATCH.display_name,
  role: 'viewer',
  created_at: `${data.today}T09:00:00Z`,
})

/** `GET /accounts/{id}/shares`: Jun can edit, so the share dialog lists a person it can remove, then any `added`. */
export const accountSharesRoute = (data: HouseholdData, account: Account, added: AccountShare[] = []): ApiRoute =>
  apiRoute<AccountShares>('GET', `/accounts/${account.id}/shares`, {
    account_id: account.id,
    owner: { user_id: data.user.id, display_name: `${data.user.first_name} ${data.user.last_name}`, role: 'owner' },
    shares: [{ id: 300 + account.id, account_id: account.id, user_id: 2, display_name: 'Jun R.', role: 'editor', created_at: '2026-02-01T09:00:00Z' }, ...added],
  })

export const householdSaveRoutes = (data: HouseholdData): ApiRoute[] => [
  ...data.transactions.filter((t) => t.view !== 'limited').map((t) => apiRoute<Transaction>('PUT', `/transactions/${t.id}`, t)),
  ...data.accounts.flatMap((a) => [
    apiRoute<Account>('GET', `/accounts/${a.id}`, a),
    apiRoute<Account>('PUT', `/accounts/${a.id}`, a),
    accountSharesRoute(data, a),
  ]),
  ...data.accounts.map((a) => apiRoute<AccountShare>('POST', `/accounts/${a.id}/shares`, sharedWithMatch(data, a), 201)),
  // The share dialog's lookup finds one person by exact email.
  queryRoute<UserMatch>('GET', '/users/lookup', (q) => {
    only(q, ['email'])
    return SHARE_MATCH
  }),
  ...data.allocations.map((a) => apiRoute<Allocation>('PUT', `/allocations/${a.id}`, a)),
  apiRoute<QuickBalances>('PUT', '/dashboard/quick-balances', data.quickBalances),
  // Add Transaction with a repeat or an installment: the first payment and its recurring entry, on the card.
  apiRoute<RepeatingCreated>('POST', '/transactions/repeating', { transaction: tx(data.today, 'New installment', 2000, card, 0), entry: entry('New installment', 'expense', 2000, data.today, card) }, 201),
  apiRoute<Category>('POST', '/categories/', { id: 90, name: 'New category', is_expense: true, kind: 'expense', is_active: true, created_at: `${data.today}T09:00:00Z` }, 201),
  apiRoute<Tag>('POST', '/tags/', { id: 90, name: 'New tag', color: '#5B7553', is_system: false, created_at: `${data.today}T09:00:00Z` }, 201),
  // Settings' category and tag Update.
  ...data.categories.map((c) => apiRoute<Category>('PUT', `/categories/${c.id}`, c)),
  ...data.tags.map((t) => apiRoute<Tag>('PUT', `/tags/${t.id}`, t)),
  // Settings' two exports; the browser saves whatever comes back.
  apiRoute<Record<string, never>>('GET', '/data/export.json', {}),
  apiRoute<Record<string, never>>('GET', '/data/export.csv', {}),
  ...data.entries.flatMap((e) => {
    if (e.view === 'limited') return []
    const account = data.accounts.find((a) => a.id === e.account_id)
    if (!account) return []
    return [apiRoute<Transaction>('POST', `/budget-entries/${e.id}/materialize`, tx(data.today, e.name, e.amount, account, 0), 201)]
  }),
  ...data.payables.flatMap((p) =>
    p.source === 'budget_entry' && p.occurrence_date
      ? [apiRoute<ForcedDateResult>('PUT', `/budget-entries/${p.source_id}/occurrences/${p.occurrence_date}/date`, { occurrence_date: p.occurrence_date, effective_date: p.due_date })]
      : [],
  ),
]

/**
 * Signs in as the household's user, freezes the clock on `HOUSEHOLD_NOW` and fakes the API
 * with `householdRoutes(data)`.
 */
export async function mockHousehold(page: Page, data: HouseholdData = household): Promise<ApiMock> {
  await page.clock.setFixedTime(HOUSEHOLD_NOW)
  await signedIn(page, data.user)
  return mockApi(page, householdRoutes(data))
}

/** A tag whose name is too long for the phone's closed tag filter (STU-743). */
export const LONG_TAG: Tag = { id: 43, name: 'Japan trip 2027 with the whole family and cousins', color: '#a35f2a', is_system: false, created_at: '2025-06-01T00:00:00' }

/** The household with `LONG_TAG` among its tags. */
export const withLongTag = (data: HouseholdData): HouseholdData => ({ ...data, tags: [...data.tags, LONG_TAG] })

/** STU-683: the transaction `withTagOverflow` adds, for the specs that find its row. */
export const TAG_OVERFLOW = { id: 9401, description: 'Divisoria haul for the reunion' } as const

/**
 * STU-683: the household plus one transaction on the newest day carrying more tags than a title line holds on a
 * desktop or a phone (the household's two, every old swatch tag and `LONG_TAG`), so its row draws the "+N" tag button.
 */
export const withTagOverflow = (data: HouseholdData): HouseholdData => {
  const extra = [...legacyTags, LONG_TAG].filter((t) => !data.tags.some((d) => d.id === t.id))
  const overflow = tx(data.today, TAG_OVERFLOW.description, 1850, cash, 22, 'debit', { id: TAG_OVERFLOW.id, tags: [...data.tags, ...extra] })
  return { ...data, tags: [...data.tags, ...extra], transactions: [overflow, ...data.transactions] }
}

/** Two wishlist items, neither bought: a laptop for work and a rice cooker. */
export const householdWishlist: WishlistItem[] = [
  { id: 801, user_id: householdUser.id, name: 'Work laptop', estimated_cost: 65000, currency: 'PHP', priority: 'high', notes: 'For freelance work', target_date: '2026-06-30', is_purchased: false, created_at: '2026-02-01T09:00:00Z' },
  { id: 802, user_id: householdUser.id, name: 'Rice cooker', estimated_cost: 3500, currency: 'PHP', priority: 'medium', is_purchased: false, created_at: '2026-02-10T09:00:00Z' },
]

/**
 * The wishlist tab's reads and writes, answered from `items`: the list (with or without bought items), the plan,
 * and each item's update and delete.
 */
export const householdWishlistRoutes = (items: WishlistItem[] = householdWishlist): ApiRoute[] => [
  queryRoute<WishlistItem[]>('GET', '/wishlist/', (q) => {
    only(q, ['is_purchased'])
    return q.get('is_purchased') === 'false' ? items.filter((i) => !i.is_purchased) : items
  }),
  apiRoute<WishlistPlan>('GET', '/wishlist/plan', { monthly_disposable: 0, savings_rate: 0, items: [] }),
  apiRoute<WishlistItem>('POST', '/wishlist/', { id: 803, user_id: householdUser.id, name: 'New item', estimated_cost: 1, currency: 'PHP', priority: 'medium', is_purchased: false, created_at: '2026-03-12T09:00:00Z' }, 201),
  ...items.flatMap((i) => [apiRoute<WishlistItem>('PUT', `/wishlist/${i.id}`, { ...i, is_purchased: !i.is_purchased }), apiRoute<Record<string, never>>('DELETE', `/wishlist/${i.id}`, {})]),
]

/** The installment plan the review variant adds: a laptop on the card, ten of twelve payments left. */
export const REVIEW_PLAN_ID = 795

/** A variant whose Installments tab has one plan waiting for review, so the row offers Review. */
export const withInstallmentReview = (data: HouseholdData): HouseholdData => ({
  ...data,
  installmentPlans: [{ ...plan(REVIEW_PLAN_ID, 'Laptop, 12 months', '2026-03-20', 10, 12), auto_post: 'unreviewed', can_review: true }],
})

/** What the review dialog reads and sends for the review variant's plan: one missed month and its recording. */
export const installmentReviewRoutes = (): ApiRoute[] => [
  apiRoute<InstallmentReview>('GET', `/budget-entries/${REVIEW_PLAN_ID}/auto-post-review`, {
    entry_id: REVIEW_PLAN_ID,
    name: 'Laptop, 12 months',
    account_name: card.name,
    currency: 'PHP',
    amount: 2500,
    reviewed: false,
    auto_post_enabled: false,
    block: null,
    missed: [{ occurrence_date: '2026-02-20', linked: null }],
    candidates: [],
    remaining_after: 9,
    envelope: null,
    past_cycles: false,
    entry_version: null,
    review_token: `review-${REVIEW_PLAN_ID}`,
  }),
  apiRoute<InstallmentReviewResult>('POST', `/budget-entries/${REVIEW_PLAN_ID}/auto-post-review`, {
    replayed: false,
    reviewed: true,
    auto_post_enabled: true,
    next_occurrence: '2026-03-20',
    max_occurrences: 12,
    outcomes: [{ occurrence_date: '2026-02-20', outcome: 'recorded' }],
  }),
]

/**
 * Records as the lists return them once a save has landed, for the button spec, which reads the row a save
 * produced: a debit on `accountId` dated today, a monthly expense due today, and an allocation.
 */
export const savedTransaction = (data: HouseholdData, id: number, description: string, amount: number, accountId: number): Transaction => {
  const account = data.accounts.find((a) => a.id === accountId)
  if (!account) throw new Error(`no account ${accountId}`)
  return tx(data.today, description, amount, account, 0, 'debit', { id, category_id: undefined })
}
export const savedEntry = (data: HouseholdData, id: number, name: string, amount: number, accountId: number): BudgetEntry => {
  const account = data.accounts.find((a) => a.id === accountId)
  if (!account) throw new Error(`no account ${accountId}`)
  return entry(name, 'expense', amount, data.today, account, { id })
}
export const savedAllocation = alloc
