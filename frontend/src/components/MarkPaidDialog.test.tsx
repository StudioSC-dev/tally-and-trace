// The Mark paid dialog's first render, with its data hooks stubbed (STU-364). The
// frontend has no DOM test environment, so it is rendered to static markup: the
// portal renders in place and no effect runs, which is enough to read which
// occurrence it asks for and what it lists.
import { describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import type { EntryOccurrence, EntryOccurrences, FullBudgetEntry } from '@tally-trace/shared'

const asked: Array<{ id: number; include?: string }> = []
let listing: EntryOccurrences | undefined

const query = <T,>(data: T) => ({ data, currentData: data, error: undefined, isLoading: false, isFetching: false })

vi.mock('react-dom', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react-dom')>()),
  createPortal: (children: unknown) => children,
}))
vi.mock('react-redux', () => ({ useDispatch: () => () => undefined }))
vi.mock('@tanstack/react-router', () => ({ Link: () => null }))
vi.mock('../store/outbox', () => ({ outboxActions: {} }))
vi.mock('../store/outboxForms', () => ({ DUE_ENTRY_FORM: 'due-entry', dueAction: () => ({}) }))
vi.mock('../store/api', () => ({
  useGetEntryOccurrencesQuery: (args: { id: number; include?: string }) => {
    asked.push(args)
    return query(listing)
  },
  useGetBudgetEntryQuery: () => query(undefined),
  useGetAccountsQuery: () => query({ items: [{ id: 1, name: 'Checking', currency: 'PHP', account_type: 'checking' }] }),
  useGetAccountQuery: () => query(undefined),
  useMaterializeBudgetEntryMutation: () => [vi.fn(), { isLoading: false }],
  useMaterializeDueBudgetEntryMutation: () => [vi.fn(), { isLoading: false }],
}))

// The portal's target is read on render; the stubbed portal ignores it.
vi.stubGlobal('document', { body: {} })

const { MarkPaidDialog } = await import('./MarkPaidDialog')

/** A cash semi-monthly expense on days 1/15, stored off its days on `next`. */
const entry = (next: string, extra: Partial<FullBudgetEntry> = {}): FullBudgetEntry => ({
  id: 9, entry_type: 'expense', name: 'Rent', amount: 500, currency: 'PHP', cadence: 'semi_monthly',
  next_occurrence: next, lead_time_days: 0, semi_monthly_day_1: 1, semi_monthly_day_2: 15,
  end_mode: 'indefinite', account_id: 1, is_active: true, kind: 'cash',
  ...extra,
} as FullBudgetEntry)

const occurrence = (day: string): EntryOccurrence => ({
  occurrence_date: day, effective_date: day, due: false, linked: null, skipped_before: 0, omitted_before: 0,
})

const page = (occurrences: EntryOccurrence[]): EntryOccurrences => ({
  entry_id: 9, today: '2026-11-16', capped: false, kind: 'cash', due_unposted: 0, oldest_due: null, latest_due: null,
  oldest_unrecorded: occurrences[0]?.occurrence_date ?? null, omitted: 0, occurrences,
} as EntryOccurrences)

function render(next: string, extra: Partial<FullBudgetEntry> = {}): string {
  asked.length = 0
  const e = entry(next, extra)
  return renderToStaticMarkup(
    <MarkPaidDialog entryId={9} name="Rent" occurrenceDate={next.slice(0, 10)} entry={e} action="mark_paid" onClose={() => undefined} />,
  )
}

describe('MarkPaidDialog', () => {
  // Days 1/15 stored on Dec 26, 40 days out: the dialog asks for Jan 1, the first walked occurrence, and opens on it.
  it('first_walked_occurrence_displayed', () => {
    listing = page([occurrence('2027-01-01'), occurrence('2027-01-15')])
    const html = render('2026-12-26T00:00:00Z')
    expect(asked[0]).toEqual({ id: 9, include: '2027-01-01' })
    expect(html).toContain('<option value="2027-01-01" selected="">')
    expect(html).not.toContain('data-testid="mark-paid-none"')
  })

  it('no_occurrence_reason_displayed', () => {
    listing = page([])
    // An end date before the next scheduled day: nothing is walked, and the dialog says why.
    let html = render('2026-12-26T00:00:00Z', { end_mode: 'on_date', end_date: '2026-12-31T00:00:00Z' })
    expect(asked[0]).toEqual({ id: 9, include: '2026-12-26' })
    expect(html).toContain('This entry ends on Dec 31st, 2026, before its next scheduled day.')
    // A first occurrence too far ahead for the server to list.
    html = render('2029-06-20T00:00:00Z')
    expect(asked[0]).toEqual({ id: 9, include: '2029-07-01' })
    expect(html).toContain('Its next occurrence, Jul 1st, 2029, is too far ahead to record yet.')
  })
})
