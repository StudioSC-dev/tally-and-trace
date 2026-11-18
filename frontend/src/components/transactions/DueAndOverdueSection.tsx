import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent, ReactNode } from 'react'
import { shallowEqual, useDispatch, useSelector } from 'react-redux'
import { Link } from '@tanstack/react-router'
import {
  CAP_REASON,
  pendingTargets,
  DUE_PAGE_SIZE,
  atCap,
  batchConfirmMessage,
  batchSummary,
  cleanIds,
  effectiveDuePage,
  effectiveSelection,
  LIMITED_ROWS,
  RECURRING_ACTION_LABELS,
  PENDING_POST_LABELS,
  dayEndWire,
  dueRecurringRows,
  dueReviewNotice,
  duePendingRows,
  dueStatementRows,
  dueTodayLines,
  formatEntryDate,
  movedText,
  dueTabBadge,
  freshFor,
  installmentPlanView,
  isOverdueRow,
  mergeUpcoming,
  occurrenceCreditCheck,
  orderSubscriptionRows,
  subscriptionPastRows,
  notPostedRows,
  orderDueRows,
  pageWindow,
  pendingLinkIds,
  postedOnOpenText,
  postedResultText,
  postNowCount,
  postNowText,
  reviewBatchItems,
  reviewSelectedText,
  rowAmount,
  selectAll,
  selectAllState,
  shouldPostOnOpen,
  statementRowText,
  tabKeyTarget,
  toggleSelection,
  transactionDescription,
  UPCOMING_LIMIT,
  upcomingShownText,
  upcomingWindow,
} from '@tally-trace/shared'
import type {
  BatchFailure,
  DueBadge,
  DuePageState,
  DueEntryRow,
  DueLimitedRow,
  DueMissedRow,
  DuePendingRow,
  DueRecurringRow,
  DueSectionRow,
  DueStatementRow,
  NotPostedRow,
  RecurringAction,
  Transaction,
  CreditCheck,
  DashboardDue,
  DueLists,
  InstallmentPlan,
  SubscriptionRow,
  UpcomingOccurrence,
  UpcomingRow,
} from '@tally-trace/shared'
import { useConfirm } from '../../hooks/useConfirm'
import { useManilaDay } from '../../hooks/useManilaDay'
import { useToday } from '../../hooks/useToday'
import {
  accountingApi,
  useGetDashboardDueQuery,
  useGetDashboardSnapshotQuery,
  useGetInstallmentPlansQuery,
  useGetTransactionsQuery,
  useGetUpcomingOccurrencesQuery,
  usePostDueInstallmentsMutation,
  usePostDueInstallmentsOnOpenMutation,
  useReviewInstallmentsMutation,
} from '../../store/api'
import type { AppDispatch, RootState } from '../../store'
import { formatCurrency } from '../../utils/currency'
import type { CurrencyCode } from '../../utils/currency'
import { apiErrorMessage } from '../../utils/apiError'
import { estimateText, estimateTitle } from '../../utils/fx'
import { CardPayDialog } from '../CardPayDialog'
import { CreditCheckBadge } from '../CreditSummary'
import { SlowReload } from '../Loading'
import { Pager } from '../Pager'
import { UpcomingOccurrenceRow } from './UpcomingOccurrenceRow'
import { UpcomingTransactionRow } from './UpcomingTransactionRow'
import { useOccurrenceDialogs } from './useOccurrenceDialogs'
import { CARD_PAY_FORM, DUE_ENTRY_FORM } from '../../store/outboxForms'
import type { CardPayDraft } from '../../store/outboxForms'
import { outboxActions } from '../../store/outbox'
import { Tab, Tabs } from '../Tabs'
import { Button } from '../Button'
import { StatusText } from '../StatusText'

/**
 * "Due and overdue": every recurring occurrence the caller can record and every pending
 * transaction that is overdue or tied to the schedule, in one place. Everything comes from one
 * request, `GET /dashboard/due` (STU-599, STU-603; `docs/dashboard-due.md`): the due lists, the
 * unposted rows ("Load more" is its next `unposted_page`), the rows missed occurrences link and the
 * occurrence lists. Against an API without that route (404) the card reads the older queries: the
 * dashboard snapshot, the window's batches of 1000 and the linked rows in batches of 500. An owner or admin also gets one
 * row per card with an owed closed statement (`card_statements_due`), with Pay; the server
 * decides closed and overdue on the Manila day, so the snapshot is refetched when that day
 * changes. The merge, the dedup and the labels live in `@tally-trace/shared` (`dueSection.ts`).
 *
 * Card installments (STU-343 Plan B): each missed installment row says whether it
 * auto-posts, with Review where the caller can review it; a reviewed installment whose
 * only due month is today gets a compact line; installments that are not reviewed yet are
 * listed in a notice, each with Review; "Post N due installment months now" posts every
 * month the snapshot counts as postable (`postNowCount`); and a card's statement row
 * counts its installment months not posted yet, listing a card for those alone.
 *
 * ARIA tabs share the card, built from `TABS` (STU-485, STU-511): "Due and overdue" (the
 * default) holds what is owed, with the review notice, today lines, the page-open status and
 * Post now; "Not posted yet" holds the one-off pending rows (no recurring link) dated today or
 * earlier, each with "logged N days ago" on the Manila day; "Upcoming" holds the fixed window
 * from the Manila day (T+1 to T+30, whatever the page's month and filters): transactions in
 * every state, soonest first, and the occurrences of entries no other tab lists (`plan=none`),
 * as compact rows; "Subscriptions" holds the open-ended subscriptions (`plan_kind`
 * `subscription`): missed, today's and overdue rows from the snapshot and the same window's
 * occurrences, card rows with the owner's credit check; "Installments" holds one row per
 * active installment plan with its next charge and "N of M left". A transaction row opens the
 * page's action modal; every recurring action opens this card's dialogs. Each windowed tab
 * reads `currentData` for arguments built from `today`, and the snapshot and the plans must be
 * for that day (`freshFor`), so a new Manila day reads "…" until its data lands. Every panel shell stays mounted; only the selected panel of an
 * open card has content. The tab and each tab's page are component state only.
 */

const WINDOW_DAYS = 30
const PAGE = 1000
/** Seconds a Due read stays current when the card mounts again; focus also revalidates (a 304 when nothing changed). */
const DUE_REVALIDATE_SECONDS = 60
const NO_TRANSACTIONS: readonly Transaction[] = []
const NO_PAGES: readonly number[] = []
/** The most ids one transactions request may name (the API's `ids` limit). */
const IDS_PER_REQUEST = 500
/** The most occurrences one window request lists (the API's `limit` maximum); its `total` stays exact. */
const OCCURRENCE_LIMIT = 500

const ACTION_TEST_IDS: Record<RecurringAction, string> = {
  mark_paid: 'due-mark-paid',
  mark_received: 'due-mark-received',
  charged: 'due-charged',
  posted: 'due-posted',
}

type DueTab = 'due' | 'not_posted' | 'upcoming' | 'subscriptions' | 'installments'
/** The tabs whose badge `dueTabBadge` decides from their sources. */
type WindowBadgeTab = 'upcoming' | 'subscriptions' | 'installments'

/** One tab of the card: its label, its test-id slug, its badge's test id, and whether it lists the window batches (so "Load more" applies). */
interface TabSpec {
  id: DueTab
  label: string
  slug: string
  badgeTestId: string
  usesWindow: boolean
}

const TABS: readonly TabSpec[] = [
  { id: 'due', label: 'Due and overdue', slug: 'due', badgeTestId: 'due-count', usesWindow: true },
  { id: 'not_posted', label: 'Not posted yet', slug: 'not-posted', badgeTestId: 'due-not-posted-count', usesWindow: true },
  { id: 'upcoming', label: 'Upcoming', slug: 'upcoming', badgeTestId: 'due-upcoming-count', usesWindow: false },
  { id: 'subscriptions', label: 'Subscriptions', slug: 'subscriptions', badgeTestId: 'due-subscriptions-count', usesWindow: false },
  { id: 'installments', label: 'Installments', slug: 'installments', badgeTestId: 'due-installments-count', usesWindow: false },
]

/** A Due and overdue row's name, as its row shows it. */
const dueRowName = (row: DueSectionRow): string =>
  row.kind === 'pending' ? (transactionDescription(row.transaction) ?? 'Pending transaction') : row.name

/** The day a Due and overdue row is placed on. */
const dueRowDay = (row: DueSectionRow): string => {
  switch (row.kind) {
    case 'pending':
      return row.date
    case 'statement':
      return row.oldestDue
    case 'missed':
      return row.oldestEffective
    default:
      return row.view === 'limited' ? row.date : row.effectiveDate
  }
}

/** A count with its noun, singular for one: "1 subscription", "2 subscriptions". */
const counted = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`

/** The banner's one line: the lead tab's count, the state of its first row, then that row's name, cut to fit. */
const bannerLine = (count: string, name: string, state: ReactNode): ReactNode => (
  <p className="flex min-w-0 flex-1 items-center gap-2 whitespace-nowrap text-sm text-ink" data-testid="due-banner-text">
    <span className="shrink-0 font-semibold" data-testid="due-banner-count">{count}</span>
    {state}
    <span className="min-w-0 truncate" data-testid="due-banner-item">{name}</span>
  </p>
)

const addDays = (day: string, n: number): string => {
  const d = new Date(`${day}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().slice(0, 10)
}

type TransactionsArgs = typeof accountingApi.endpoints.getTransactions.Types.QueryArg
type TransactionsResult = ReturnType<ReturnType<typeof accountingApi.endpoints.getTransactions.select>>

const NO_BATCHES: readonly TransactionsArgs[] = []

interface TransactionQueries {
  items: Transaction[]
  failed: boolean
  loading: boolean
  /** Some batch is loading or refetching, so the merged rows may be mid-change. */
  fetching: boolean
  /** The last batch's result. */
  last: TransactionsResult | undefined
}

/**
 * One cached transactions query per entry of `batches` (memoise the array), merged in order.
 * Each batch stays subscribed, so it refetches when transactions change, as a query hook would.
 */
function useTransactionQueries(batches: readonly TransactionsArgs[]): TransactionQueries {
  const dispatch = useDispatch<AppDispatch>()
  useEffect(() => {
    const subscriptions = batches.map((args) => dispatch(accountingApi.endpoints.getTransactions.initiate(args)))
    return () => subscriptions.forEach((subscription) => subscription.unsubscribe())
  }, [dispatch, batches])
  const selectors = useMemo(() => batches.map((args) => accountingApi.endpoints.getTransactions.select(args)), [batches])
  const results = useSelector((state: RootState) => selectors.map((select) => select(state)), shallowEqual)
  const items = useMemo(() => results.flatMap((result) => result.data?.items ?? []), [results])
  return {
    items,
    failed: results.some((result) => result.error !== undefined),
    // A batch with nothing yet (first load, or new args): its rows are missing, not gone.
    loading: results.some((result) => result.data === undefined && result.error === undefined),
    fetching: results.some((result) => result.status === 'pending'),
    last: results[results.length - 1],
  }
}

/**
 * The pending transactions with these ids: one cached query per batch of at most
 * `IDS_PER_REQUEST`, merged. Each batch stays subscribed, so it refetches when
 * transactions change, as a query hook would.
 */
function usePendingTransactionsByIds(ids: readonly number[]): { items: Transaction[]; failed: boolean; loading: boolean; fetching: boolean } {
  const batches = useMemo(() => {
    const out: { ids: number[]; is_posted: false; limit: number }[] = []
    for (let start = 0; start < ids.length; start += IDS_PER_REQUEST) {
      const batch = ids.slice(start, start + IDS_PER_REQUEST)
      out.push({ ids: batch, is_posted: false, limit: batch.length })
    }
    return out
  }, [ids])
  return useTransactionQueries(batches)
}

/** Whether a query failed because the API has no such route (an older backend). */
function isNotFound(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'status' in error && error.status === 404
}

interface DuePages {
  /** The unposted rows of the pages after the first, in page order. */
  items: Transaction[]
  failed: boolean
  loading: boolean
  fetching: boolean
  /** The last page's `has_more`; undefined while it has not landed. */
  hasMore: boolean | undefined
}

/**
 * The `/dashboard/due` pages after the first ("Load more"): one cached query per page number in `pages`
 * (memoise the array), each staying subscribed so the `Due` tag refetches them all together. The first
 * page is the card's own query.
 */
function useDuePages(pages: readonly number[]): DuePages {
  const dispatch = useDispatch<AppDispatch>()
  useEffect(() => {
    const subscriptions = pages.map((n) => dispatch(accountingApi.endpoints.getDashboardDue.initiate({ unposted_page: n })))
    return () => subscriptions.forEach((subscription) => subscription.unsubscribe())
  }, [dispatch, pages])
  const selectors = useMemo(() => pages.map((n) => accountingApi.endpoints.getDashboardDue.select({ unposted_page: n })), [pages])
  const results = useSelector((state: RootState) => selectors.map((select) => select(state)), shallowEqual)
  const items = useMemo(() => results.flatMap((result) => result.data?.unposted.items ?? NO_TRANSACTIONS), [results])
  return {
    items,
    failed: results.some((result) => result.error !== undefined),
    loading: results.some((result) => result.data === undefined && result.error === undefined),
    fetching: results.some((result) => result.status === 'pending'),
    hasMore: results[results.length - 1]?.data?.unposted.has_more,
  }
}

/**
 * One tab's pager window: the reader's page for today, and a list that shrank leaves the reader
 * on the last page that exists (staying there if it grows again). Only once `settled`: the window
 * batches land out of order, so a row can be briefly missing.
 */
function useClampedPage(
  count: number,
  tab: DueTab,
  state: DuePageState,
  setState: (tab: DueTab, state: DuePageState) => void,
  today: string,
  settled: boolean,
): ReturnType<typeof pageWindow> {
  const page = effectiveDuePage(state, today)
  const view = pageWindow(count, page, DUE_PAGE_SIZE)
  useEffect(() => {
    if (settled && view.page !== page) setState(tab, { page: view.page, day: today })
  }, [settled, view.page, page, today, tab, setState])
  return view
}

interface Props {
  /** The viewer's calendar day (`YYYY-MM-DD`). */
  today: string
  /** Post a pending transaction: the page's own posting flow. */
  onPost: (transaction: Transaction) => void
  /** After a recurring occurrence is recorded: refresh the page's lists. */
  onChanged: () => void
  /** Open an Upcoming transaction in the page's action modal (Edit, Delete, Post). */
  onOpenTransaction: (transaction: Transaction) => void
  /** Switch the page's list to the Scheduled view. */
  onSeeScheduled: () => void
  /** Each account's currency by id, so a pending foreign row shows its face in its own currency; a row whose account is missing keeps its stored figure. */
  accountCurrencies?: ReadonlyMap<number, CurrencyCode>
}

/** The last batch review's outcome: its line and one failure per entry that was not reviewed, kept for its Manila day. */
interface BatchResultView {
  day: string
  text: string | null
  failures: BatchFailure[]
}

/**
 * Row actions are secondary buttons (docs/design-system.md, "Button"). On a fine pointer each keeps the height it had
 * before the Button migration: an action that was outlined keeps its padding, and one that was filled had no border,
 * so it takes 2px less padding and a 24px floor. On a coarse pointer the 44px floor in index.css sizes them all.
 */
const ROW_ACTION = 'px-2.5 py-1 text-xs'
const WAS_FILLED_ROW_ACTION = 'min-h-6 px-2.5 py-0.5 text-xs'

export function DueAndOverdueSection({ today, onPost, onChanged, onOpenTransaction, onSeeScheduled, accountCurrencies }: Props) {
  const panelId = useId()
  // Collapsed on every mount (STU-687): the card is a one-line banner until the reader expands it.
  const [open, setOpen] = useState(false)
  // The selected tab: Due and overdue on every mount, never stored.
  const [tab, setTab] = useState<DueTab>('due')
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([])
  // The card whose statement is being paid.
  const [payCardId, setPayCardId] = useState<number | null>(null)
  // Edit on a refused background payment: Pay reopens with its input and the server's reason.
  const [payRestore, setPayRestore] = useState<{ draft: CardPayDraft; error: string } | null>(null)
  const payEditEntry = useSelector((state: RootState) =>
    state.outbox.editRequest === null ? undefined : state.outbox.entries.find((e) => e.clientId === state.outbox.editRequest),
  )
  const payDispatch = useDispatch<AppDispatch>()
  useEffect(() => {
    if (!payEditEntry || payEditEntry.form !== CARD_PAY_FORM || payEditEntry.draft === null) return
    const draft = payEditEntry.draft as CardPayDraft
    const error = apiErrorMessage(payEditEntry.error?.raw) || payEditEntry.error?.message || 'Could not record the payment.'
    payDispatch(outboxActions.editHandled(payEditEntry.clientId))
    setPayRestore({ draft, error })
    setPayCardId(draft.cardId)
  }, [payEditEntry, payDispatch])
  // Whether the review notice is expanded.
  const [noticeOpen, setNoticeOpen] = useState(false)
  // Batch review: the ticked ids, whether a batch runs, and the last run's result (kept until the next run or the next day).
  const { openRecord, openChangeDate, openReview, dialogs } = useOccurrenceDialogs(onChanged, { background: true })
  const askConfirm = useConfirm()
  const [reviewBatch] = useReviewInstallmentsMutation()
  const [selected, setSelected] = useState<ReadonlySet<number>>(() => new Set())
  const [batching, setBatching] = useState(false)
  const [batchResult, setBatchResult] = useState<BatchResultView | null>(null)
  // Post now: its last run's count and error, kept until the next run.
  const [postDue, { isLoading: posting }] = usePostDueInstallmentsMutation()
  const [posted, setPosted] = useState<number | null>(null)
  const [postError, setPostError] = useState<string | null>(null)
  // The page-open run (quiet: no loader, no toast): the months it posted, for a status line.
  const [postOnOpen] = usePostDueInstallmentsOnOpenMutation()
  const [openPosted, setOpenPosted] = useState<number | null>(null)
  // How many batches of the window query are loaded ("Load more") and the day they were: a new day is one batch.
  const [loaded, setLoaded] = useState({ count: 1, day: today })
  const batchCount = loaded.day === today ? loaded.count : 1
  // Each tab's page the reader chose and the day they chose it on: a new day is page 1, whatever else is loading.
  const [pageStates, setPageStates] = useState<Record<DueTab, DuePageState>>(() => ({
    due: { page: 1, day: today },
    not_posted: { page: 1, day: today },
    upcoming: { page: 1, day: today },
    subscriptions: { page: 1, day: today },
    installments: { page: 1, day: today },
  }))
  const setPageState = useCallback(
    (id: DueTab, state: DuePageState) => setPageStates((prev) => ({ ...prev, [id]: state })),
    [],
  )

  // The card's one request (docs/dashboard-due.md): the due lists, the pending rows they link, both
  // occurrence lists and the unposted rows. An API without the route answers 404; the card then reads
  // the older queries (snapshot, linked ids, the window batches, the occurrences) until it has one, with the
  // refetch-on-mount they always had: the fallback behaves as the card did before `/dashboard/due`.
  const dueQuery = useGetDashboardDueQuery(undefined, { refetchOnMountOrArgChange: DUE_REVALIDATE_SECONDS, refetchOnFocus: true })
  const legacy = isNotFound(dueQuery.error)
  const snapshotQuery = useGetDashboardSnapshotQuery(
    {},
    { skip: !legacy, refetchOnMountOrArgChange: true, refetchOnFocus: true },
  )
  const source = legacy ? snapshotQuery : dueQuery
  // A `/dashboard/due` answer dated another Manila day is not this day's data (a statement may have closed, a
  // row become overdue): it is treated as not loaded, so its rows, badge and the page-open decision wait for a
  // refetch of the new day. The older API's snapshot keeps the behavior it always had.
  const dueRaw: DashboardDue | undefined = legacy ? undefined : dueQuery.data
  const dueStale = dueRaw !== undefined && !freshFor(dueRaw.today, today)
  const dueData: DashboardDue | undefined = dueStale ? undefined : dueRaw
  const snapshot: DueLists | undefined = legacy ? snapshotQuery.data : dueData
  const {
    isSuccess: snapshotSuccess,
    isFetching: sourceFetching,
    isError: snapshotIsError,
    isLoading: sourceLoading,
    error: snapshotError,
  } = source
  const snapshotLoading = sourceLoading || dueStale
  const refetchSource = () => void (legacy ? snapshotQuery.refetch() : dueQuery.refetch())
  // A cached answer of another day (the page was left open past midnight, or the cache outlived it) is refetched
  // once per day; the card shows no rows from it meanwhile.
  const staleRefetchedFor = useRef<string | null>(null)
  useEffect(() => {
    if (!dueStale || sourceFetching || staleRefetchedFor.current === today) return
    staleRefetchedFor.current = today
    void dueQuery.refetch()
  }, [dueStale, sourceFetching, today, dueQuery])
  // Consumed when this mount's first settled read is evaluated, whether or not a POST is sent.
  const pageOpenDone = useRef(false)
  // Older API only: the snapshot already cached when the fallback began is never the basis of the page-open POST.
  const legacyStartId = useRef<string | null | undefined>(undefined)
  if (legacy && legacyStartId.current === undefined) {
    legacyStartId.current = snapshotQuery.isFetching ? null : snapshotQuery.requestId ?? null
  }
  // Page-open auto-post (Q1): once per mount, decided by a settled read. A read cached under a minute is
  // not refetched on mount, and is as good a decision as a fresh one: the POST is throttled by the server
  // and recomputes what is postable. A failed refetch consumes nothing.
  useEffect(() => {
    if (pageOpenDone.current) return
    if (snapshot === undefined || !snapshotSuccess || sourceFetching || snapshotIsError) return
    if (legacy && (snapshotQuery.requestId ?? null) === legacyStartId.current) return
    pageOpenDone.current = true
    if (!shouldPostOnOpen(snapshot)) return
    // Fired and forgotten: an error is swallowed (Post now stays available) and nothing awaits it in a render path.
    postOnOpen()
      .unwrap()
      .then((result) => setOpenPosted(result.posted))
      .catch(() => undefined)
  }, [snapshot, snapshotSuccess, sourceFetching, snapshotIsError, postOnOpen, legacy, snapshotQuery.requestId])
  // A new Manila day can close a statement or make one overdue.
  useManilaDay(refetchSource)
  const endDate = dayEndWire(addDays(today, WINDOW_DAYS))
  // Older API only: every loaded batch stays subscribed, so all of them refetch together when transactions change.
  const windowBatches = useMemo(
    () =>
      legacy
        ? Array.from({ length: batchCount }, (_, i) => ({ is_posted: false, end_date: endDate, limit: PAGE, offset: i * PAGE }))
        : NO_BATCHES,
    [legacy, endDate, batchCount],
  )
  const windowResult = useTransactionQueries(windowBatches)
  const linkIds = useMemo(() => (legacy && snapshot ? pendingLinkIds(snapshot) : []), [legacy, snapshot])
  const legacyLinked = usePendingTransactionsByIds(linkIds)
  const linkedTxns: readonly Transaction[] = legacy ? legacyLinked.items : dueData?.linked_pending ?? NO_TRANSACTIONS
  const linkedFailed = legacyLinked.failed
  const linkedLoading = legacyLinked.loading
  // "Load more": the next unposted page of the same endpoint.
  const extraPages = useMemo(
    () => (legacy || batchCount < 2 ? NO_PAGES : Array.from({ length: batchCount - 1 }, (_, i) => i + 2)),
    [legacy, batchCount],
  )
  const duePages = useDuePages(extraPages)
  const windowState = legacy
    ? { loading: windowResult.loading, failed: windowResult.failed, fetching: windowResult.fetching }
    : { loading: duePages.loading, failed: duePages.failed, fetching: duePages.fetching }
  // Stale-data guard: every query the rows come from. The row actions wait while any of them refetches.
  const listsFetching = sourceFetching || windowState.fetching || legacyLinked.fetching
  // Upcoming: the fixed window from the Manila day. Its arguments come from `today`, so a new
  // day is a new cache entry, and `currentData` reads it as not loaded until it lands.
  const upcomingRange = useMemo(() => upcomingWindow(today), [today])
  const upcomingTxnResult = useGetTransactionsQuery(
    { start_date: upcomingRange.start, end_date: upcomingRange.end, order: 'asc', limit: UPCOMING_LIMIT, offset: 0 },
  )
  const upcomingOccResult = useGetUpcomingOccurrencesQuery(
    { start_date: upcomingRange.start, end_date: upcomingRange.end, plan: 'none', limit: OCCURRENCE_LIMIT },
    { skip: !legacy, refetchOnMountOrArgChange: true },
  )
  // Subscriptions: the same window's occurrences of `plan_kind` `subscription` entries.
  const subscriptionOccResult = useGetUpcomingOccurrencesQuery(
    { start_date: upcomingRange.start, end_date: upcomingRange.end, plan: 'subscription', limit: OCCURRENCE_LIMIT },
    { skip: !legacy, refetchOnMountOrArgChange: true },
  )
  // Installments: one row per active plan. `day` is only the cache key, so a new day is a new request.
  const plansResult = useGetInstallmentPlansQuery({ day: today })
  // The viewer's local day: an Upcoming transaction's Planned / Pending / Posted label only.
  const localDay = useToday()

  // The unposted rows: the older API's window batches, or `/dashboard/due`'s pages.
  const windowTxns = useMemo(
    () => (legacy ? windowResult.items : [...(dueData?.unposted.items ?? NO_TRANSACTIONS), ...duePages.items]),
    [legacy, windowResult.items, dueData, duePages.items],
  )
  const hasMore = legacy
    ? windowResult.last?.data?.has_more === true
    : (batchCount > 1 ? duePages.hasMore : dueData?.unposted.has_more) === true

  const recurring = useMemo(() => (snapshot ? dueRecurringRows(snapshot, today) : []), [snapshot, today])
  const pending = useMemo(
    () => (snapshot ? duePendingRows(windowTxns, linkedTxns, snapshot, today) : []),
    [snapshot, windowTxns, linkedTxns, today],
  )
  const statements = useMemo(() => (snapshot ? dueStatementRows(snapshot) : []), [snapshot])
  const reviewNotice = useMemo(() => (snapshot ? dueReviewNotice(snapshot) : null), [snapshot])
  // Only ticked rows that are still clean in the current snapshot count, so a refetch drops a stale tick with no effect.
  const effective = useMemo(() => effectiveSelection(selected, reviewNotice), [selected, reviewNotice])
  const cleanCount = cleanIds(reviewNotice).length
  const allState = selectAllState(selected, reviewNotice)
  const capped = atCap(selected, reviewNotice)
  const limitId = `${panelId}-limit`
  const todayLines = useMemo(() => (snapshot ? dueTodayLines(snapshot) : []), [snapshot])
  const postNow = snapshot ? postNowText(postNowCount(snapshot)) : null
  const openPostedText = openPosted === null ? null : postedOnOpenText(openPosted)
  // Overdue rows first, across every kind, so page 1 is where they are.
  const rows = useMemo(() => orderDueRows(recurring, pending, statements), [recurring, pending, statements])
  const count = rows.length
  const loading = snapshotLoading || windowState.loading
  // First-load flags only: a refetch keeps the previous rows. A linked batch that lands adds rows, so the count waits for it.
  const countPending = loading || linkedLoading
  const view = useClampedPage(count, 'due', pageStates.due, setPageState, today, !countPending && !windowState.fetching)
  const visible = count > 0 ? rows.slice(view.from - 1, view.to) : []
  // Not posted yet: the window's one-off rows only, so its count never waits for the linked batches.
  const notPosted = useMemo(() => notPostedRows(windowTxns, today), [windowTxns, today])
  const notPostedCount = notPosted.length
  const notPostedView = useClampedPage(
    notPostedCount,
    'not_posted',
    pageStates.not_posted,
    setPageState,
    today,
    !loading && !windowState.fetching,
  )
  const notPostedVisible = notPostedCount > 0 ? notPosted.slice(notPostedView.from - 1, notPostedView.to) : []
  // The Upcoming, Subscriptions and Installments badges are decided by `dueTabBadge` from each source's
  // state and the tab's last complete total for the Manila day, kept here when the rule marks a figure complete.
  const lastComplete = useRef<Partial<Record<WindowBadgeTab, { day: string; total: number }>>>({})
  const keptFor = (id: WindowBadgeTab) => {
    const kept = lastComplete.current[id]
    return kept !== undefined && kept.day === today ? kept.total : undefined
  }
  // Upcoming: both sources soonest first, merged and cut at UPCOMING_LIMIT; the badge is the exact total.
  const upcomingTxns = upcomingTxnResult.currentData
  // The occurrences: the older API's own queries, or `/dashboard/due`'s lists while they are for today.
  const dueFresh = dueData !== undefined
  const upcomingOccs = legacy ? upcomingOccResult.currentData : dueFresh ? dueData?.upcoming_occurrences : undefined
  const upcomingOccFetching = legacy ? upcomingOccResult.isFetching : sourceFetching
  const upcomingOccFailed = legacy ? upcomingOccResult.isError : snapshotIsError
  const upcomingFailed = upcomingTxnResult.isError || upcomingOccFailed
  const upcomingPending =
    (upcomingTxns === undefined && !upcomingTxnResult.isError) || (upcomingOccs === undefined && !upcomingOccFailed)
  const upcomingRows = useMemo(
    () => mergeUpcoming(upcomingTxns?.items ?? [], upcomingOccs?.items ?? [], UPCOMING_LIMIT),
    [upcomingTxns, upcomingOccs],
  )
  const upcomingBadge = dueTabBadge(
    [
      { hasData: upcomingTxns !== undefined, fresh: true, fetching: upcomingTxnResult.isFetching, failed: upcomingTxnResult.isError, count: upcomingTxns?.total ?? 0 },
      { hasData: upcomingOccs !== undefined, fresh: true, fetching: upcomingOccFetching, failed: upcomingOccFailed, count: upcomingOccs?.total ?? 0 },
    ],
    keptFor('upcoming'),
  )
  const upcomingShown = upcomingBadge.figure === 'pending' ? null : upcomingShownText(upcomingBadge.figure)
  const upcomingCount = upcomingRows.length
  const upcomingView = useClampedPage(
    upcomingCount,
    'upcoming',
    pageStates.upcoming,
    setPageState,
    today,
    !upcomingPending && !upcomingTxnResult.isFetching && !upcomingOccFetching,
  )
  const upcomingVisible = upcomingCount > 0 ? upcomingRows.slice(upcomingView.from - 1, upcomingView.to) : []
  const retryUpcoming = () => {
    void upcomingTxnResult.refetch()
    if (legacy) void upcomingOccResult.refetch()
    else refetchSource()
  }
  // Subscriptions: the snapshot's rows dated today or earlier, only while the snapshot is for
  // today, and the window's occurrences. While either has failed the badge is the last complete total (D7).
  const snapshotFresh = snapshot !== undefined && freshFor(snapshot.today, today)
  const subscriptionPast = useMemo(
    () => (snapshot !== undefined && snapshotFresh ? subscriptionPastRows(snapshot, today) : []),
    [snapshot, snapshotFresh, today],
  )
  const subscriptionOccs = legacy ? subscriptionOccResult.currentData : dueFresh ? dueData?.subscription_occurrences : undefined
  const subscriptionOccFetching = legacy ? subscriptionOccResult.isFetching : sourceFetching
  const subscriptionFailed = legacy ? subscriptionOccResult.isError : snapshotIsError
  const subscriptionPending =
    (!snapshotFresh && !snapshotIsError) || (subscriptionOccs === undefined && !subscriptionFailed)
  const subscriptionRows = useMemo(
    () => orderSubscriptionRows(subscriptionPast, subscriptionOccs?.items ?? []),
    [subscriptionPast, subscriptionOccs],
  )
  const subscriptionBadge = dueTabBadge(
    [
      { hasData: snapshot !== undefined, fresh: snapshotFresh, fetching: sourceFetching, failed: snapshotIsError, count: subscriptionPast.length },
      { hasData: subscriptionOccs !== undefined, fresh: true, fetching: subscriptionOccFetching, failed: subscriptionFailed, count: subscriptionOccs?.total ?? 0 },
    ],
    keptFor('subscriptions'),
  )
  const subscriptionCount = subscriptionRows.length
  const subscriptionView = useClampedPage(
    subscriptionCount,
    'subscriptions',
    pageStates.subscriptions,
    setPageState,
    today,
    !subscriptionPending && !listsFetching && !subscriptionOccFetching,
  )
  const subscriptionVisible =
    subscriptionCount > 0 ? subscriptionRows.slice(subscriptionView.from - 1, subscriptionView.to) : []
  // The card credit check of an entry's occurrence on `day` (owner or admin only), from a snapshot for today.
  const creditFor = (entryId: number, day: string): CreditCheck | undefined =>
    snapshot !== undefined && snapshotFresh ? occurrenceCreditCheck(snapshot.card_charges, entryId, day) : undefined
  // Installments: the plans, only while they are for today; its badge follows the shared rule (D7).
  const plans = plansResult.currentData
  const plansFresh = plans !== undefined && freshFor(plans.today, today)
  const planItems = useMemo(() => (plans !== undefined && plansFresh ? plans.items : []), [plans, plansFresh])
  const plansFailed = plansResult.isError
  const plansPending = !plansFresh && !plansFailed
  const planCount = planItems.length
  const planBadge = dueTabBadge(
    [{ hasData: plans !== undefined, fresh: plansFresh, fetching: plansResult.isFetching, failed: plansFailed, count: planCount }],
    keptFor('installments'),
  )
  // Keep each window tab's total for the day when its rule marks it complete.
  useEffect(() => {
    const complete: [WindowBadgeTab, DueBadge][] = [['upcoming', upcomingBadge], ['subscriptions', subscriptionBadge], ['installments', planBadge]]
    for (const [id, badge] of complete) {
      if (badge.complete && typeof badge.figure === 'number') lastComplete.current[id] = { day: today, total: badge.figure }
    }
  })
  const planView = useClampedPage(
    planCount,
    'installments',
    pageStates.installments,
    setPageState,
    today,
    !plansPending && !plansResult.isFetching,
  )
  const planVisible = planCount > 0 ? planItems.slice(planView.from - 1, planView.to) : []
  // Each tab's badge: "…" while its count is not settled.
  const figure = (badge: DueBadge) => ({ pending: badge.figure === 'pending', count: badge.figure === 'pending' ? 0 : badge.figure })
  const badges: Record<DueTab, { pending: boolean; count: number }> = {
    due: { pending: countPending, count },
    not_posted: { pending: loading, count: notPostedCount },
    upcoming: figure(upcomingBadge),
    subscriptions: figure(subscriptionBadge),
    installments: figure(planBadge),
  }
  const selectedUsesWindow = TABS.find((spec) => spec.id === tab)?.usesWindow === true

  const titleId = `${panelId}-title`
  const tabId = (id: DueTab) => `${panelId}-tab-${id}`
  const tabPanelId = (id: DueTab) => `${panelId}-panel-${id}`
  // Selecting a tab, by click or key, also opens a collapsed card.
  const selectTab = (id: DueTab) => {
    setTab(id)
    setOpen(true)
  }
  const onTabKey = (event: ReactKeyboardEvent<HTMLButtonElement>, index: number) => {
    const next = tabKeyTarget(event.key, index, TABS.length)
    const nextTab = next === null ? undefined : TABS[next]
    if (next === null || nextTab === undefined) return
    event.preventDefault()
    selectTab(nextTab.id)
    tabRefs.current[next]?.focus()
  }

  // The collapsed banner (STU-687). The first tab, in the card's order, that lists anything leads it, with that tab's
  // count and the row the tab lists first; expanding the card opens on that tab. A tab still counting holds the lead
  // until it settles. With all five settled and empty, and nothing else to say, the section is not shown at all.
  const lists: Record<DueTab, boolean> = {
    due: badges.due.count > 0 && rows.length > 0,
    not_posted: badges.not_posted.count > 0 && notPosted.length > 0,
    upcoming: badges.upcoming.count > 0 && upcomingRows.length > 0,
    subscriptions: badges.subscriptions.count > 0 && subscriptionRows.length > 0,
    installments: badges.installments.count > 0 && planItems.length > 0,
  }
  const firstOpen = TABS.find((spec) => badges[spec.id].pending || lists[spec.id])?.id
  const bannerSettled = firstOpen === undefined || !badges[firstOpen].pending
  const leadTab: DueTab | null = firstOpen !== undefined && !badges[firstOpen].pending ? firstOpen : null
  const bannerError =
    Boolean(snapshotError) || windowState.failed || linkedFailed || upcomingFailed || subscriptionFailed || plansFailed
  // What the Due tab shows besides its rows: the review notice, today's lines, Post now and the page-open result.
  const dueNote = reviewNotice?.text ?? todayLines[0]?.text ?? postNow ?? openPostedText
  const sectionEmpty = bannerSettled && leadTab === null && !bannerError && dueNote === null && batchResult === null
  const expand = () => {
    if (!open && leadTab !== null) setTab(leadTab)
    setOpen((prev) => !prev)
  }
  const banner = (): ReactNode => {
    if (leadTab === 'due') {
      const first = rows[0]
      return bannerLine(
        `${badges.due.count} due`,
        dueRowName(first),
        isOverdueRow(first) ? (
          <StatusText tone="danger">Overdue</StatusText>
        ) : dueRowDay(first) <= today ? (
          <StatusText tone="warn">Due today</StatusText>
        ) : null,
      )
    }
    if (leadTab === 'not_posted') {
      const first = notPosted[0]
      return bannerLine(`${badges.not_posted.count} not posted yet`, transactionDescription(first.transaction) ?? 'Pending transaction', null)
    }
    if (leadTab === 'upcoming') {
      const first = upcomingRows[0]
      const name = first.kind === 'occurrence' ? first.occurrence.name : (transactionDescription(first.transaction) ?? 'Planned transaction')
      return bannerLine(`${badges.upcoming.count} upcoming`, name, <span className="shrink-0 text-xs text-muted">{formatEntryDate(first.day)}</span>)
    }
    if (leadTab === 'subscriptions') {
      const first = subscriptionRows[0]
      const count = counted(badges.subscriptions.count, 'subscription', 'subscriptions')
      if (first.kind === 'occurrence') {
        return bannerLine(count, first.occurrence.name, <span className="shrink-0 text-xs text-muted">{formatEntryDate(first.day)}</span>)
      }
      return bannerLine(
        count,
        first.name,
        isOverdueRow(first) ? (
          <StatusText tone="danger">Overdue</StatusText>
        ) : dueRowDay(first) <= today ? (
          <StatusText tone="warn">Due today</StatusText>
        ) : null,
      )
    }
    if (leadTab === 'installments') {
      const first = planItems[0]
      const shown = installmentPlanView(first, today, plans?.auto_post_scheduled ?? false)
      return bannerLine(
        counted(badges.installments.count, 'installment plan', 'installment plans'),
        first.name,
        shown.overdue ? (
          <StatusText tone="danger">Overdue</StatusText>
        ) : first.next_charge !== null ? (
          <span className="shrink-0 text-xs text-muted">{formatEntryDate(first.next_charge)}</span>
        ) : null,
      )
    }
    if (bannerError) {
      return <p className="min-w-0 flex-1 truncate text-sm text-danger" role="alert" data-testid="due-banner-text">Could not load what is due.</p>
    }
    if (dueNote !== null) {
      return <p className="min-w-0 flex-1 truncate text-sm text-ink" data-testid="due-banner-text">{dueNote}</p>
    }
    return <p className="min-w-0 flex-1 truncate text-sm text-muted" data-testid="due-banner-text">Checking what is due…</p>
  }

  const loadMore = () => setLoaded({ count: batchCount + 1, day: today })

  const postDueNow = async () => {
    setPosted(null)
    setPostError(null)
    try {
      const result = await postDue().unwrap()
      setPosted(result.posted)
      onChanged()
    } catch (caught) {
      setPostError(apiErrorMessage(caught) || 'Could not post the due installment months. Please try again.')
    }
  }

  const batchBusy = listsFetching || batching

  const reviewSelected = () => {
    if (!snapshot || reviewNotice === null) return
    const items = reviewBatchItems(snapshot, effective)
    if (items.length === 0) return
    // Names are captured now, so a failure still names a row that has left the list.
    const names = new Map(reviewNotice.entries.map((e) => [e.entryId, e.name] as const))
    void askConfirm({
      title: 'Turn on auto-post',
      message: batchConfirmMessage(items.length),
      confirmLabel: 'Turn on auto-post',
      tone: 'default',
      action: async () => {
        setBatching(true)
        try {
          const result = await reviewBatch({ items }).unwrap()
          setBatchResult({ day: today, ...batchSummary(result, names) })
          setSelected(new Set())
          onChanged()
        } finally {
          setBatching(false)
        }
      },
    })
  }

  const review = openReview

  // Stale-data guard (STU-605, STU-603): while any query the rows come from refetches (`listsFetching`: the
  // Due read, its later pages, or on an older API the snapshot, window and linked batches), or while a row's own
  // save is still queued, its record, post and pay actions wait, so nothing is recorded from figures about to change.
  const outbox = useSelector((state: RootState) => state.outbox)
  const pendingEntries = useMemo(() => pendingTargets(outbox, DUE_ENTRY_FORM), [outbox])
  const pendingCards = useMemo(() => pendingTargets(outbox, CARD_PAY_FORM), [outbox])
  const pendingTransactions = useMemo(() => pendingTargets(outbox, 'transaction'), [outbox])
  const entryActionsOff = (entryId: number) => listsFetching || pendingEntries.has(entryId)
  // Upcoming and Subscriptions occurrences come from the Due read (or, on an older API, their own queries).
  const occurrenceActionsOff = listsFetching || upcomingOccFetching || subscriptionOccFetching

  const record = (row: DueEntryRow | DueMissedRow, action: RecurringAction | undefined) =>
    openRecord(row.entryId, row.name, row.kind === 'missed' ? row.oldest : row.occurrenceDate, action)

  // Change date: the occurrence's date, for a caller who can record it (the server's `can_mark_paid`).
  const changeDateButton = (entryId: number, name: string, occurrenceDate: string, effectiveDate?: string) => (
    <Button
      variant="secondary"
      onClick={() => openChangeDate(entryId, name, occurrenceDate, effectiveDate)}
      className={ROW_ACTION}
      data-testid="row-change-date"
    >
      Change date
    </Button>
  )

  const actionButtons = (row: DueEntryRow | DueMissedRow) =>
    row.actions.map((action, index) => (
      <Button
        variant="secondary"
        key={action}
        onClick={() => record(row, action)}
        disabled={entryActionsOff(row.entryId)}
        className={index === 0 ? WAS_FILLED_ROW_ACTION : ROW_ACTION}
        data-testid={ACTION_TEST_IDS[action]}
      >
        {RECURRING_ACTION_LABELS[action]}
      </Button>
    ))

  const pendingRow = (row: DuePendingRow) => {
    const txn = row.transaction
    const accountCurrency = accountCurrencies?.get(txn.account_id)
    const shown = accountCurrency ? rowAmount(txn, accountCurrency) : { amount: txn.amount, currency: txn.currency }
    return (
      <li
        key={row.key}
        className="flex items-start justify-between gap-3 px-4 py-3"
        data-testid="due-row"
        data-kind="pending"
        data-view={row.view}
        data-source={`transaction:${txn.id}`}
      >
        <div>
          <p className="text-sm font-medium text-ink">{transactionDescription(txn) ?? 'Pending transaction'}</p>
          <p className="text-xs text-muted">
            {formatEntryDate(row.date)} ·{' '}
            {/* A recurring card charge the card already took is Charged (done); any other tied row is still Pending. */}
            {row.action === 'posted' ? (
              <StatusText tone="ok" data-testid="due-pending-state">Charged</StatusText>
            ) : (
              <StatusText tone="muted" data-testid="due-pending-state">Pending</StatusText>
            )}
            {row.overdue && (
              <>
                {' · '}
                <StatusText tone="danger" data-testid="due-overdue">Overdue</StatusText>
              </>
            )}
          </p>
        </div>
        <div className="flex-shrink-0 space-y-1 text-right">
          <p className="text-sm font-semibold text-ink">{formatCurrency(shown.amount, shown.currency)}</p>
          {row.action && (
            <Button
              variant="secondary"
              onClick={() => onPost(txn)}
              disabled={listsFetching || pendingTransactions.has(txn.id)}
              className={WAS_FILLED_ROW_ACTION}
              data-testid={row.action === 'posted' ? 'due-posted' : 'due-mark-posted'}
            >
              {PENDING_POST_LABELS[row.action]}
            </Button>
          )}
        </div>
      </li>
    )
  }

  // A one-off pending row in Not posted yet: never overdue, no edit link, "{date} · logged …".
  const notPostedRow = (row: NotPostedRow) => {
    const txn = row.transaction
    const accountCurrency = accountCurrencies?.get(txn.account_id)
    const shown = accountCurrency ? rowAmount(txn, accountCurrency) : { amount: txn.amount, currency: txn.currency }
    return (
      <li
        key={row.key}
        className="flex items-start justify-between gap-3 px-4 py-3"
        data-testid="due-row"
        data-kind="pending"
        data-view={row.view}
        data-source={`transaction:${txn.id}`}
        data-logged-days={row.daysAgo ?? undefined}
      >
        <div>
          <p className="text-sm font-medium text-ink">{transactionDescription(txn) ?? 'Pending transaction'}</p>
          <p className="text-xs text-muted">
            {formatEntryDate(row.date)} · <span data-testid="due-logged">{row.logged}</span>
          </p>
        </div>
        <div className="flex-shrink-0 space-y-1 text-right">
          <p className="text-sm font-semibold text-ink">{formatCurrency(shown.amount, shown.currency)}</p>
          {row.action && (
            <Button variant="secondary" onClick={() => onPost(txn)} disabled={listsFetching || pendingTransactions.has(txn.id)} className={WAS_FILLED_ROW_ACTION} data-testid="due-mark-posted">
              {PENDING_POST_LABELS[row.action]}
            </Button>
          )}
        </div>
      </li>
    )
  }

  const limitedRow = (row: DueLimitedRow) => (
    <li
      key={row.key}
      className="flex items-start justify-between gap-3 px-4 py-3"
      data-testid="due-row"
      data-kind="recurring"
      data-view="limited"
    >
      <div>
        <p className="text-sm font-medium text-ink">{row.name}</p>
        <p className="text-xs text-muted">{formatEntryDate(row.date)} · Shared item</p>
      </div>
      {row.overdue && <StatusText tone="danger" className="flex-shrink-0" data-testid="due-overdue">Overdue</StatusText>}
    </li>
  )

  // `plan` marks a row of the Subscriptions tab (`data-plan`).
  const missedRow = (row: DueMissedRow, plan?: string) => (
    <li
      key={row.key}
      className="flex items-start justify-between gap-3 px-4 py-3"
      data-testid="due-row"
      data-kind="missed"
      data-view={row.view ?? 'full'}
      data-source={`budget_entry:${row.entryId}`}
      data-plan={plan}
    >
      <div>
        <p className="text-sm font-medium text-ink">{row.name}</p>
        <p className="text-xs text-warn" data-testid="due-missed-text">{row.text}</p>
        {row.autoPostLabel && (
          <p className="text-xs text-muted" data-testid="due-auto-post" data-state={row.autoPost ?? undefined}>
            {row.autoPostLabel}
          </p>
        )}
      </div>
      <div className="flex flex-shrink-0 flex-wrap justify-end gap-2">
        {row.review && (
          <Button variant="secondary" onClick={() => review(row.entryId, row.name)} className={ROW_ACTION} data-testid="due-review">
            Review
          </Button>
        )}
        {actionButtons(row)}
        {row.can_mark_paid && changeDateButton(row.entryId, row.name, row.oldest, row.oldestEffectiveKnown ? row.oldestEffective : undefined)}
      </div>
    </li>
  )

  // `plan` marks a row of the Subscriptions tab (`data-plan`); `credit` is its card credit check.
  const entryRow = (row: DueEntryRow, plan?: string, credit?: CreditCheck) => (
    <li
      key={row.key}
      className="flex items-start justify-between gap-3 px-4 py-3"
      data-testid="due-row"
      data-kind="recurring"
      data-view={row.view ?? 'full'}
      data-source={`budget_entry:${row.entryId}`}
      data-plan={plan}
    >
      <div>
        <p className="text-sm font-medium text-ink">{row.name}</p>
        <p className="text-xs text-muted">
          <span data-testid="due-date">{movedText(row.occurrenceDate, row.effectiveDate)}</span>
          {row.accountName && ` · ${row.accountName}`}
          {row.overdue && (
              <>
                {' · '}
                <StatusText tone="danger" data-testid="due-overdue">Overdue</StatusText>
              </>
            )}
        </p>
        {credit && <CreditCheckBadge check={credit} />}
      </div>
      <div className="flex-shrink-0 space-y-1 text-right">
        {row.currency !== null && (row.amount !== null || row.estimate.unconverted) && (
          <p className="text-sm font-semibold text-ink" data-testid="due-amount" title={estimateTitle(row.estimate)}>
            {estimateText(row.amount, row.currency, row.estimate)}
          </p>
        )}
        <div className="flex flex-wrap justify-end gap-2">
          {actionButtons(row)}
          {row.can_mark_paid && changeDateButton(row.entryId, row.name, row.occurrenceDate, row.effectiveDate)}
        </div>
      </div>
    </li>
  )

  const statementRow = (row: DueStatementRow) => {
    const shown = statementRowText(row)
    const postButton = shown.post && (
      <Button variant="secondary" onClick={() => void postDueNow()} disabled={posting || listsFetching} className={ROW_ACTION} data-testid="due-unposted-post">
        {posting ? 'Posting…' : 'Post due installments now'}
      </Button>
    )
    return (
      <li
        key={row.key}
        className="flex items-start justify-between gap-3 px-4 py-3"
        data-testid="due-row"
        data-kind="statement"
        data-view="full"
        data-source={`statement:${row.cardId}`}
      >
        <div>
          {shown.unpostedOnly ? (
            <p className="text-sm font-medium text-ink" data-testid="due-unposted-text">{`${row.name} · ${shown.text ?? ''}`}</p>
          ) : (
            <p className="text-sm font-medium text-ink">{row.name} statement</p>
          )}
          <p className="text-xs text-muted">
            Closed {formatEntryDate(row.closeDate)} · due {formatEntryDate(row.dueDate)}
            {row.overdue && (
              <>
                {' · '}
                <StatusText tone="danger" data-testid="due-overdue">Overdue</StatusText>
              </>
            )}
            {row.statements > 1 && (
              <span data-testid="due-earlier-statements">
                {` · includes ${row.statements - 1} earlier ${row.statements - 1 === 1 ? 'statement' : 'statements'}`}
              </span>
            )}
          </p>
          {shown.note && <p className="text-xs text-warn" data-testid="due-unposted-note">{shown.note}</p>}
          {shown.guidance && <p className="text-xs text-warn" data-testid="due-unposted-guidance">{shown.guidance}</p>}
        </div>
        <div className="flex-shrink-0 space-y-1 text-right">
          {!shown.unpostedOnly && (
            <p
              className="text-sm font-semibold text-ink"
              data-testid="due-amount"
              {...(row.incomplete ? { title: 'may be low: some foreign charges have no exchange rate' } : {})}
            >
              {formatCurrency(row.amount, row.currency)}
            </p>
          )}
          <div className="flex flex-wrap justify-end gap-2">
            {postButton}
            {shown.pay && (
              <Button variant="secondary" onClick={() => setPayCardId(row.cardId)} disabled={listsFetching || pendingCards.has(row.cardId)} className={WAS_FILLED_ROW_ACTION} data-testid="due-pay">
                Pay
              </Button>
            )}
          </div>
        </div>
      </li>
    )
  }

  const upcomingRow = (row: UpcomingRow) =>
    row.kind === 'transaction'
      ? <UpcomingTransactionRow key={row.key} transaction={row.transaction} localDay={localDay} onOpen={onOpenTransaction} accountCurrencies={accountCurrencies} />
      : occurrenceRow(row.occurrence, row.key, upcomingOccs?.auto_post_scheduled ?? false)

  // A future occurrence as a compact row, in Upcoming or Subscriptions; its actions open this card's dialogs.
  const occurrenceRow = (occurrence: UpcomingOccurrence, key: string, scheduled: boolean, credit?: CreditCheck) => (
    <UpcomingOccurrenceRow
      key={key}
      occurrence={occurrence}
      scheduled={scheduled}
      credit={credit}
      disabled={occurrenceActionsOff}
      onRecord={(action) => openRecord(occurrence.entry_id, occurrence.name, occurrence.occurrence_date, action)}
      onReview={() => review(occurrence.entry_id, occurrence.name)}
      onChangeDate={() =>
        openChangeDate(occurrence.entry_id, occurrence.name, occurrence.occurrence_date, occurrence.effective_date ?? undefined)
      }
    />
  )

  const subscriptionRow = (row: SubscriptionRow) => {
    if (row.kind === 'occurrence') {
      const occ = row.occurrence
      return occurrenceRow(occ, row.key, subscriptionOccs?.auto_post_scheduled ?? false, creditFor(occ.entry_id, occ.occurrence_date))
    }
    if (row.kind === 'missed') return missedRow(row, 'subscription')
    return entryRow(row, 'subscription', creditFor(row.entryId, row.occurrenceDate))
  }

  // One installment plan: its next charge, "N of M left", and the actions on that charge.
  const planRow = (plan: InstallmentPlan) => {
    const shown = installmentPlanView(plan, today, plans?.auto_post_scheduled ?? false)
    const next = plan.next_charge
    return (
      <li
        key={plan.entry_id}
        className="flex items-start justify-between gap-3 px-4 py-3"
        data-testid="due-row"
        data-kind="installment"
        data-view={plan.view}
        data-source={`budget_entry:${plan.entry_id}`}
        data-day={next ?? undefined}
        data-plan="installment"
      >
        <div className="min-w-0">
          <p className="text-sm font-medium text-ink">{plan.name}</p>
          <p className="text-sm font-semibold text-ink" data-testid="due-payments-left">{shown.leftText}</p>
          <p className="text-xs text-muted">
            {shown.nextText}
            {shown.overdue && (
              <>
                {' · '}
                <StatusText tone="danger" data-testid="due-overdue">Overdue</StatusText>
              </>
            )}
            {shown.missedText !== null && (
              <span className="text-warn" data-testid="due-installment-missed">{` · ${shown.missedText}`}</span>
            )}
            {plan.account_name && ` · ${plan.account_name}`}
          </p>
          {shown.autoPostLabel && (
            <p className="text-xs text-muted" data-testid="due-auto-post" data-state={plan.auto_post ?? undefined}>
              {shown.autoPostLabel}
            </p>
          )}
        </div>
        <div className="flex-shrink-0 space-y-1 text-right">
          <p className="text-sm font-semibold text-ink" data-testid="due-amount">
            {formatCurrency(plan.amount, plan.currency as CurrencyCode)}
          </p>
          {next !== null && (shown.review || shown.actions.length > 0) && (
            <div className="flex flex-wrap justify-end gap-2">
              {shown.review && (
                <Button variant="secondary" onClick={() => review(plan.entry_id, plan.name)} className={ROW_ACTION} data-testid="due-review">
                  Review
                </Button>
              )}
              {shown.actions.map((action, index) => (
                <Button
                  variant="secondary"
                  key={action}
                  onClick={() => openRecord(plan.entry_id, plan.name, next, action)}
                  disabled={entryActionsOff(plan.entry_id)}
                  className={index === 0 ? WAS_FILLED_ROW_ACTION : ROW_ACTION}
                  data-testid={ACTION_TEST_IDS[action]}
                >
                  {RECURRING_ACTION_LABELS[action]}
                </Button>
              ))}
            </div>
          )}
          {next !== null && plan.can_mark_paid && (
            <div className="flex flex-wrap justify-end gap-2">{changeDateButton(plan.entry_id, plan.name, next)}</div>
          )}
        </div>
      </li>
    )
  }

  // The Upcoming and Subscriptions panels are a 30-day glance: this opens the browsable list.
  const seeScheduledLink = (
    <button
      type="button"
      onClick={onSeeScheduled}
      className="inline-flex min-h-11 items-center text-sm underline focus-ring"
      data-testid="see-scheduled-link"
    >
      See everything scheduled
    </button>
  )

  // The window's through line, and its note when one tab's occurrences pass the request limit.
  const throughLine = (extra: ReactNode) => (
    <p className="px-4 pt-3 text-xs text-muted" data-testid="due-through">
      Through {formatEntryDate(upcomingRange.through)}
      {extra}
    </p>
  )
  const cappedNote = (result: { items: unknown[]; total: number } | undefined) =>
    result !== undefined && result.total > result.items.length ? (
      <p className="px-4 pt-2 text-xs text-warn" data-testid="due-occurrences-capped">
        {`Only the first ${result.items.length} of ${result.total} recurring charges in this window are listed.`}
      </p>
    ) : null
  const windowError = (retry: () => void) => (
    <div className="flex flex-wrap items-center gap-3 px-4 py-3" data-testid="due-window-error">
      <p className="text-sm text-danger" role="alert">Could not load what is coming up.</p>
      <Button variant="secondary" onClick={retry} className={ROW_ACTION} data-testid="due-window-retry">
        Retry
      </Button>
    </div>
  )

  const recurringRow = (row: DueRecurringRow) => {
    if (row.view === 'limited') return limitedRow(row)
    if (row.kind === 'missed') return missedRow(row)
    return entryRow(row)
  }

  // Each tab's content, mounted only in its own panel while the card is open and the tab selected.
  const panels: Record<DueTab, () => ReactNode> = {
    due: () => (
      <>
        {reviewNotice && (
          <div className="border-b border-line px-4 py-3 space-y-2" data-testid="due-review-notice">
            <button
              type="button"
              onClick={() => setNoticeOpen((prev) => !prev)}
              aria-expanded={noticeOpen}
              className="text-sm font-medium text-warn underline underline-offset-2 focus-ring"
              data-testid="due-review-notice-toggle"
            >
              {reviewNotice.text}
            </button>
            {noticeOpen && (
              <>
                {cleanCount > 0 && (
                  <div className="flex flex-wrap items-center gap-3" data-testid="due-review-notice-header">
                    <label className="flex items-center gap-2 text-sm text-ink">
                      <input
                        type="checkbox"
                        ref={(el) => {
                          if (el) el.indeterminate = allState === 'some'
                        }}
                        checked={allState === 'all'}
                        disabled={batchBusy}
                        onChange={() => setSelected(allState === 'all' ? new Set() : selectAll(reviewNotice))}
                        className="border-line focus-ring"
                        data-testid="due-review-notice-select-all"
                      />
                      Select all
                    </label>
                    <Button
                      variant="secondary"
                      onClick={reviewSelected}
                      disabled={batchBusy || effective.size === 0}
                      className={WAS_FILLED_ROW_ACTION}
                      data-testid="due-review-selected"
                    >
                      {reviewSelectedText(effective.size)}
                    </Button>
                    {capped && (
                      <p id={limitId} className="text-xs text-muted" data-testid="due-review-notice-limit">{CAP_REASON}</p>
                    )}
                  </div>
                )}
                <ul className="space-y-2" data-testid="due-review-notice-list">
                  {reviewNotice.entries.map((entry) => {
                    const nameId = `${panelId}-name-${entry.entryId}`
                    const reasonId = `${panelId}-reason-${entry.entryId}`
                    const ticked = effective.has(entry.entryId)
                    const blockedByCap = entry.clean && capped && !ticked
                    const describedBy = !entry.clean ? reasonId : blockedByCap ? limitId : undefined
                    return (
                      <li
                        key={entry.entryId}
                        className="flex items-center justify-between gap-3"
                        data-testid="due-review-notice-entry"
                        data-source={`budget_entry:${entry.entryId}`}
                      >
                        <span className="flex items-center gap-2">
                          <input
                            type="checkbox"
                            checked={ticked}
                            disabled={!entry.clean || batchBusy || blockedByCap}
                            onChange={() => setSelected((prev) => toggleSelection(prev, entry.entryId, reviewNotice))}
                            aria-labelledby={nameId}
                            {...(describedBy ? { 'aria-describedby': describedBy } : {})}
                            className="border-line focus-ring"
                            data-testid="due-review-notice-select"
                          />
                          <span className="text-sm text-ink">
                            <span id={nameId}>{entry.name}</span>
                            <span className="text-xs text-muted">
                              {` · ${entry.accountName}`}
                              {entry.reason !== null && (
                                <>
                                  {' · '}
                                  <span id={reasonId} data-testid="due-review-notice-reason">{entry.reason}</span>
                                </>
                              )}
                            </span>
                          </span>
                        </span>
                        <Button
                          variant="secondary"
                          onClick={() => review(entry.entryId, entry.name)}
                          className={ROW_ACTION}
                          data-testid="due-review-notice-review"
                        >
                          Review
                        </Button>
                      </li>
                    )
                  })}
                </ul>
              </>
            )}
          </div>
        )}
        {batchResult !== null && batchResult.day === today && (batchResult.text !== null || batchResult.failures.length > 0) && (
          <div className="border-b border-line px-4 py-3 space-y-2" data-testid="due-review-batch">
            {batchResult.text !== null && (
              <p className="text-sm text-ok" role="status" data-testid="due-review-batch-result">{batchResult.text}</p>
            )}
            {batchResult.failures.length > 0 && (
              <ul className="space-y-1">
                {batchResult.failures.map((f) => (
                  <li
                    key={f.entryId}
                    className="text-sm text-danger"
                    role="alert"
                    data-testid="due-review-batch-failure"
                    data-source={`budget_entry:${f.entryId}`}
                  >
                    {f.text}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
        {todayLines.length > 0 && (
          <ul className="divide-y divide-line border-b border-line" data-testid="due-today-lines">
            {todayLines.map((line) => (
              <li
                key={line.key}
                className="flex items-center justify-between gap-3 px-4 py-2"
                data-testid="due-today-line"
                data-source={`budget_entry:${line.entryId}`}
                data-state={line.state}
              >
                <span className="text-sm text-ink" data-testid="due-today-text">{line.text}</span>
                {line.canReview && (
                  <Button
                    variant="secondary"
                    onClick={() => review(line.entryId, line.name)}
                    className={ROW_ACTION}
                    data-testid="due-today-review"
                  >
                    Review
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
        <SlowReload active={listsFetching} className="px-4 pt-3" />
        {openPostedText !== null && (
          <p className="px-4 pt-3 text-sm text-ok" role="status" data-testid="due-page-open-result">{openPostedText}</p>
        )}
        {(postNow !== null || posted !== null || postError !== null) && (
          <div className="flex flex-wrap items-center gap-3 border-b border-line px-4 py-3">
            {postNow !== null && (
              <Button
                variant="secondary"
                onClick={() => void postDueNow()}
                disabled={posting || listsFetching}
                className={WAS_FILLED_ROW_ACTION}
                data-testid="due-post-now"
              >
                {posting ? 'Posting…' : postNow}
              </Button>
            )}
            {posted !== null && (
              <p className="text-sm text-ok" role="status" data-testid="due-post-now-result">{postedResultText(posted)}</p>
            )}
            {postError !== null && (
              <p className="text-sm text-danger" role="alert" data-testid="due-post-now-error">{postError}</p>
            )}
          </div>
        )}
        {!countPending && !snapshotError && count === 0 && (
          <p className="px-4 py-3 text-sm text-muted" data-testid="due-empty">Nothing due or overdue in the next 30 days.</p>
        )}
        {count > 0 && (
          <ul className="divide-y divide-line" data-testid="due-list">
            {visible.map((row) =>
              row.kind === 'pending' ? pendingRow(row) : row.kind === 'statement' ? statementRow(row) : recurringRow(row),
            )}
          </ul>
        )}
        {count > DUE_PAGE_SIZE && (
          <div className="px-4 py-3">
            <Pager
              total={count}
              page={view.page}
              pageSize={DUE_PAGE_SIZE}
              onPage={(next) => setPageState('due', { page: next, day: today })}
              label="Due and overdue pages"
              testId="due-pager"
              disabled={loading}
            />
          </div>
        )}
      </>
    ),
    not_posted: () => (
      <>
        {!loading && !snapshotError && notPostedCount === 0 && (
          <p className="px-4 py-3 text-sm text-muted" data-testid="due-not-posted-empty">Nothing waiting to post.</p>
        )}
        {notPostedCount > 0 && (
          <ul className="divide-y divide-line" data-testid="due-list">
            {notPostedVisible.map((row) => notPostedRow(row))}
          </ul>
        )}
        {notPostedCount > DUE_PAGE_SIZE && (
          <div className="px-4 py-3">
            <Pager
              total={notPostedCount}
              page={notPostedView.page}
              pageSize={DUE_PAGE_SIZE}
              onPage={(next) => setPageState('not_posted', { page: next, day: today })}
              label="Not posted yet pages"
              testId="due-pager"
              disabled={loading}
            />
          </div>
        )}
      </>
    ),
    upcoming: () => (
      <>
        {throughLine(upcomingShown !== null && <span data-testid="upcoming-shown">{` · ${upcomingShown}`}</span>)}
        {cappedNote(upcomingOccs)}
        {upcomingFailed && windowError(retryUpcoming)}
        {!upcomingPending && !upcomingFailed && upcomingCount === 0 && (
          <p className="px-4 py-3 text-sm text-muted" data-testid="due-upcoming-empty">Nothing coming up in the next 30 days.</p>
        )}
        {upcomingCount > 0 && (
          <ul className="divide-y divide-line" data-testid="due-list">
            {upcomingVisible.map((row) => upcomingRow(row))}
          </ul>
        )}
        {upcomingCount > DUE_PAGE_SIZE && (
          <div className="px-4 py-3">
            <Pager
              total={upcomingCount}
              page={upcomingView.page}
              pageSize={DUE_PAGE_SIZE}
              onPage={(next) => setPageState('upcoming', { page: next, day: today })}
              label="Upcoming pages"
              testId="due-pager"
              disabled={upcomingPending}
            />
          </div>
        )}
        <div className="px-4 py-3">{seeScheduledLink}</div>
      </>
    ),
    subscriptions: () => (
      <>
        {throughLine(null)}
        {cappedNote(subscriptionOccs)}
        {subscriptionFailed && windowError(() => (legacy ? void subscriptionOccResult.refetch() : refetchSource()))}
        {!subscriptionPending && !subscriptionFailed && !snapshotError && subscriptionCount === 0 && (
          <p className="px-4 py-3 text-sm text-muted" data-testid="due-subscriptions-empty">
            No subscription charges due or in the next 30 days.
          </p>
        )}
        {subscriptionCount > 0 && (
          <ul className="divide-y divide-line" data-testid="due-list">
            {subscriptionVisible.map((row) => subscriptionRow(row))}
          </ul>
        )}
        {subscriptionCount > DUE_PAGE_SIZE && (
          <div className="px-4 py-3">
            <Pager
              total={subscriptionCount}
              page={subscriptionView.page}
              pageSize={DUE_PAGE_SIZE}
              onPage={(next) => setPageState('subscriptions', { page: next, day: today })}
              label="Subscriptions pages"
              testId="due-pager"
              disabled={subscriptionPending}
            />
          </div>
        )}
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3">
          <Link to="/allocations" search={{ tab: 'recurring' }} className="text-sm underline" data-testid="manage-recurring-link">
            Manage recurring entries
          </Link>
          {seeScheduledLink}
        </div>
      </>
    ),
    installments: () => (
      <>
        {plansFailed && (
          <div className="flex flex-wrap items-center gap-3 px-4 py-3" data-testid="due-plans-error">
            <p className="text-sm text-danger" role="alert">Could not load the installment plans.</p>
            <Button variant="secondary" onClick={() => void plansResult.refetch()} className={ROW_ACTION} data-testid="due-plans-retry">
              Retry
            </Button>
          </div>
        )}
        {!plansPending && !plansFailed && planCount === 0 && (
          <p className="px-4 py-3 text-sm text-muted" data-testid="due-installments-empty">No active installment plans.</p>
        )}
        {planCount > 0 && (
          <ul className="divide-y divide-line" data-testid="due-list">
            {planVisible.map((plan) => planRow(plan))}
          </ul>
        )}
        {planCount > DUE_PAGE_SIZE && (
          <div className="px-4 py-3">
            <Pager
              total={planCount}
              page={planView.page}
              pageSize={DUE_PAGE_SIZE}
              onPage={(next) => setPageState('installments', { page: next, day: today })}
              label="Installments pages"
              testId="due-pager"
              disabled={plansPending}
            />
          </div>
        )}
      </>
    ),
  }

  const payDialog = payCardId !== null && (
    <CardPayDialog
      key={payCardId}
      cardId={payCardId}
      onClose={() => {
        setPayCardId(null)
        setPayRestore(null)
      }}
      onPaid={onChanged}
      background
      {...(payRestore ? { restore: payRestore } : {})}
    />
  )

  // Nothing due, waiting to post or coming up: no section, only the dialogs a finished action may still hold.
  if (sectionEmpty) {
    return (
      <>
        {payDialog}
        {dialogs}
      </>
    )
  }

  return (
    <section
      className="card"
      data-testid="due-section"
      data-state={open ? 'expanded' : 'collapsed'}
      data-limited-rows={LIMITED_ROWS}
      aria-labelledby={titleId}
    >
      <h2 id={titleId} className="sr-only">Due and overdue</h2>
      <div className="flex min-h-10 items-center gap-3 px-3 py-0.5 sm:px-4" data-testid="due-banner">
        {banner()}
        <Button
          variant="secondary"
          onClick={expand}
          aria-expanded={open}
          aria-label={open ? 'Hide due items' : 'Show due items'}
          // The tab panels mount only while the card is open, so the toggle names them only then.
          aria-controls={open ? TABS.map(({ id }) => tabPanelId(id)).join(' ') : undefined}
          className={`${ROW_ACTION} shrink-0`}
          data-testid="due-section-toggle"
        >
          {open ? 'Hide' : 'Show'}
        </Button>
      </div>
      {open && (
        <Tabs aria-labelledby={titleId} className="flex flex-nowrap gap-1 overflow-x-auto border-t border-line bg-sunken p-1" data-testid="due-tabs">
          {TABS.map(({ id, label, slug, badgeTestId }, index) => {
            const selectedTab = tab === id
            const badge = badges[id]
            return (
              <Tab
                key={id}
                ref={(el) => {
                  tabRefs.current[index] = el
                }}
                selected={selectedTab}
                id={tabId(id)}
                aria-controls={tabPanelId(id)}
                tabIndex={selectedTab ? 0 : -1}
                onClick={() => selectTab(id)}
                onKeyDown={(event) => onTabKey(event, index)}
                className="flex shrink-0 flex-auto items-center justify-between gap-1.5 whitespace-nowrap px-1.5 py-1.5 text-left text-sm focus-ring sm:gap-2 sm:px-3"
                data-testid={`due-tab-${slug}`}
              >
                <span>{label}</span>
                <span className="badge" data-testid={badgeTestId}>{badge.pending ? '…' : badge.count}</span>
              </Tab>
            )
          })}
        </Tabs>
      )}
      {open && snapshotError && (
        <p className="border-t border-line px-4 py-3 text-sm text-danger" role="alert">Could not load what is due.</p>
      )}
      {open && !snapshotError && (windowState.failed || linkedFailed) && (
        <p className="border-t border-line px-4 py-3 text-sm text-danger" role="alert" data-testid="due-pending-error">
          Could not load some pending transactions.
        </p>
      )}
      {TABS.map(({ id, slug }) => (
        <div
          key={id}
          role="tabpanel"
          id={tabPanelId(id)}
          aria-labelledby={tabId(id)}
          tabIndex={0}
          hidden={!open || tab !== id}
          className="border-t border-line focus-ring"
          data-testid={`due-panel-${slug}`}
        >
          {open && tab === id && panels[id]()}
        </div>
      ))}
      {open && hasMore && selectedUsesWindow && (
        <div className="border-t border-line px-4 py-3">
          <Button variant="secondary" onClick={loadMore} className={ROW_ACTION} data-testid="due-load-more">
            Load more
          </Button>
        </div>
      )}
      {payDialog}
      {dialogs}
    </section>
  )
}
