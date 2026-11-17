/**
 * The shared household fixture for the web redesign specs (STU-675 onwards).
 *
 * Dense, made-up data for one Manila household: Mara Santos, who also edits a joint account
 * her partner Jun owns. Every figure, name and place here is invented. The data started in
 * the design audit's scratch spec and is the one source later specs draw from: when a spec
 * needs a state this file lacks, extend this file rather than copying data into the spec.
 *
 * Three variants:
 * - `household`: the busy month. Shared-account rows, recurring entries, an overdue payable,
 *   a card with a closed statement, 18 upcoming occurrences and quick balances.
 * - `calmHousehold`: the same household with nothing overdue, negative, failed or over a budget limit.
 * - `emptyHousehold`: the accounts only, with no transactions or recurring entries.
 *
 * `householdRoutes(data)` answers every call the dashboard, Transactions and Allocations make
 * on load; `mockHousehold(page, data)` signs in, freezes the clock on `HOUSEHOLD_TODAY` and
 * installs those routes.
 */
import type { Page } from '@playwright/test'
import type {
  Account,
  AccountPermissions,
  Allocation,
  BudgetEntry,
  CardCredit,
  CardCreditDetail,
  CardStatementDue,
  CashflowTimeline,
  CashflowTimelineEvent,
  Category,
  DashboardDue,
  DashboardSnapshot,
  DescriptionSuggestion,
  FullBudgetEntry,
  FullTransaction,
  HouseholdShares,
  HouseholdView,
  InstallmentPlans,
  LimitedBudgetEntry,
  PaginatedResponse,
  Payable,
  RecurrenceFrequency,
  QuickBalances,
  ReceivedHouseholdShare,
  ReceivedShare,
  RecordPermissions,
  SharedFullTransaction,
  Tag,
  Transaction,
  TransactionSummary,
  UpcomingItem,
  UpcomingOccurrence,
  UpcomingOccurrences,
  User,
} from '@tally-trace/shared'
import { apiRoute, mockApi, queryRoute } from '../mockApi'
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
  allocations: Allocation[]
}

/** Builds a variant's API answers from its parts, so every variant stays self-consistent. */
function build(parts: Parts): HouseholdData {
  const { accounts } = parts
  const total = round2(accounts.reduce((sum, a) => sum + a.balance, 0))
  const availableCash = round2(accounts.filter((a) => a.account_type !== 'credit' && !a.is_spending_wallet).reduce((sum, a) => sum + a.balance, 0))

  const march = parts.transactions.filter((t) => t.view !== 'limited' && t.transaction_date >= '2026-03-01')
  const sumOf = (type: 'credit' | 'debit') => round2(march.filter((t) => t.transaction_type === type).reduce((sum, t) => sum + t.amount, 0))
  const income = sumOf('credit')
  const expenses = sumOf('debit')
  const breakdown: TransactionSummary['category_breakdown'] = {}
  for (const t of march) {
    if (t.view === 'limited' || t.transaction_type === 'transfer') continue
    const name = t.view === 'shared_full' ? (t.category_name ?? 'Uncategorized') : (categories.find((c) => c.id === t.category_id)?.name ?? 'Uncategorized')
    const row = breakdown[name] ?? { income: 0, expenses: 0 }
    if (t.transaction_type === 'credit') row.income = round2(row.income + t.amount)
    else row.expenses = round2(row.expenses + t.amount)
    breakdown[name] = row
  }
  const summary: TransactionSummary = {
    period: { start_date: '2026-03-01', end_date: '2026-03-31' },
    summary: { total_income: income, total_expenses: expenses, net_flow: round2(income - expenses), transaction_count: march.length },
    category_breakdown: breakdown,
    by_currency: [
      {
        currency: 'PHP',
        total_income: income,
        total_expenses: expenses,
        moved_in: 0,
        moved_out: 0,
        net_flow: round2(income - expenses),
        transaction_count: march.length,
        category_breakdown: breakdown,
      },
    ],
    household_private: [],
  }

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
    categories,
    tags,
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
    end_date: null,
    category_name: 'Utilities',
    account: null,
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
 */
export function transactionsFor(data: HouseholdData, query: URLSearchParams): PaginatedResponse<Transaction> {
  only(query, ['start_date', 'end_date', 'order', 'limit', 'offset', 'account_ids'])
  const accountIds = query.getAll('account_ids').map(Number)
  const touches = (t: Transaction): boolean =>
    accountIds.length === 0 ||
    (t.view === 'limited'
      ? accountIds.includes(t.account?.id ?? -1)
      : [t.account_id, t.transfer_from_account_id, t.transfer_to_account_id].some((id) => id != null && accountIds.includes(id)))
  const dayOf = (t: Transaction): string => (t.view === 'limited' ? t.date : t.transaction_date).slice(0, 10)
  const start = query.get('start_date')?.slice(0, 10)
  const end = query.get('end_date')?.slice(0, 10)
  const matches = data.transactions.filter((t) => touches(t) && (!start || dayOf(t) >= start) && (!end || dayOf(t) <= end))
  // The API's order: transaction_date, then id, both ascending for `asc` and both descending otherwise.
  const whenOf = (t: Transaction): string => (t.view === 'limited' ? t.date : t.transaction_date)
  const sign = query.get('order') === 'asc' ? 1 : -1
  const ordered = [...matches].sort((a, b) => sign * (whenOf(a).localeCompare(whenOf(b)) || a.id - b.id))
  return pageFor(ordered, query)
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

/** Every call the dashboard, Transactions and Allocations make on load, answered from `data`. */
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
  apiRoute<InstallmentPlans>('GET', '/budget-entries/installment-plans', { items: [], auto_post_scheduled: true, today: data.today }),
  apiRoute<UpcomingOccurrences>('GET', '/budget-entries/upcoming-occurrences', {
    items: data.occurrences,
    total: data.occurrences.length,
    auto_post_scheduled: true,
  }),
  queryRoute<PaginatedResponse<Transaction>>('GET', '/transactions/', (q) => transactionsFor(data, q)),
  apiRoute<{ items: DescriptionSuggestion[] }>('GET', '/transactions/description-suggestions', { items: [] }),
  apiRoute<DashboardDue>('GET', '/dashboard/due', data.due),
  apiRoute<{ items: CardCredit[] }>('GET', '/cards/credit', { items: [] }),
  apiRoute<HouseholdView[]>('GET', '/household/', []),
  apiRoute<ReceivedShare[]>('GET', '/shares/received', []),
  apiRoute<ReceivedHouseholdShare[]>('GET', '/shares/received/household', []),
  apiRoute<HouseholdShares>('GET', '/tags/household/shares', { tag_id: householdTag.id, shares: [] }),
]

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
 * Signs in as the household's user, freezes the clock on `HOUSEHOLD_NOW` and fakes the API
 * with `householdRoutes(data)`.
 */
export async function mockHousehold(page: Page, data: HouseholdData = household): Promise<ApiMock> {
  await page.clock.setFixedTime(HOUSEHOLD_NOW)
  await signedIn(page, data.user)
  return mockApi(page, householdRoutes(data))
}
