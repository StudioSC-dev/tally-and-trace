// The closing-day step's content for each phase, rendered to static markup (the frontend has no
// DOM test environment): what it says and which buttons it offers.
import { describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import type { CloseDayEntry, CloseDayReport } from '@tally-trace/shared'

vi.mock('../store/api', () => ({ useChangeCloseDayMutation: () => [vi.fn()] }))
vi.mock('../store/outbox', () => ({ newOutboxId: () => 'key' }))

const { CloseDayStepView } = await import('./CloseDayDialog')
type Phase = import('./CloseDayDialog').CloseDayPhase

const report = (extra: Partial<CloseDayReport> = {}): CloseDayReport => ({
  card_id: 5, dry_run: true, changed: false, refused: false, reasons: [], old_close_day: 10, new_close_day: 14,
  entries: [], printed_dues: [], minimum_dues: [], past_statements: [], history_shift_accepted: false,
  ...extra,
})
const entry: CloseDayEntry = {
  entry_id: 12, old_next_occurrence: '2026-12-10', new_next_occurrence: '2026-12-14', old_anchor_day: 10, new_anchor_day: 14,
  rows: [{ transaction_id: 1, date_kept: true, old_date: '2026-11-12', new_date: '2026-11-12', old_occurrence: '2026-11-10', new_occurrence: '2026-11-14' }],
}
const past = { old_close: '2026-09-10', new_close: '2026-09-14', moved_in: [1], moved_out: [] as number[] }

const render = (phase: Phase, ack = false) =>
  renderToStaticMarkup(
    <CloseDayStepView
      phase={phase} newDay={14} ack={ack} titleId="t"
      onAck={() => undefined} onConfirm={() => undefined} onCancel={() => undefined}
      onCheckAgain={() => undefined} onTryAgain={() => undefined}
    />,
  )

// An attribute on the element with this test id, or null.
const confirmDisabled = (html: string) => /<button[^>]*data-testid="close-day-confirm"/.exec(html)?.[0].includes('disabled') ?? null

describe('CloseDayStepView', () => {
  it('checking: says so, with Cancel only', () => {
    const html = render({ kind: 'checking' })
    expect(html).toContain('data-testid="close-day-checking"')
    expect(html).toContain('data-testid="close-day-cancel"')
    expect(html).not.toContain('close-day-confirm')
  })

  it('applying a confirmed change: the headline stays and Cancel is disabled', () => {
    const html = render({ kind: 'applying', report: report({ entries: [entry] }) })
    expect(html).toContain('The closing day moves from the 10th to the 14th.')
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*data-testid="close-day-cancel"/)
  })

  it('things to move: the sentences, an enabled confirm and no checkbox', () => {
    const html = render({ kind: 'review', report: report({ entries: [entry] }) })
    expect(html).toContain('The closing day moves from the 10th to the 14th.')
    expect(html).toContain('Installment #12: the next charge moves from Dec 10th, 2026 to Dec 14th, 2026.')
    expect(html).toContain('keeps its date but moves to another statement')
    expect(html).not.toContain('close-day-ack')
    expect(confirmDisabled(html)).toBe(false)
  })

  it('past statements: the confirm waits for the checkbox', () => {
    const phase: Phase = { kind: 'review', report: report({ entries: [entry], past_statements: [past] }) }
    const unticked = render(phase)
    expect(unticked).toContain('I understand past statements will change')
    expect(unticked).toContain('data-testid="close-day-history"')
    expect(confirmDisabled(unticked)).toBe(true)
    const ticked = render(phase, true)
    expect(ticked).toContain('checked=""')
    expect(confirmDisabled(ticked)).toBe(false)
  })

  it('refused check: the reasons and Cancel only', () => {
    const html = render({ kind: 'refused', refusedOn: 'check', report: report({ refused: true, reasons: ['it already closes on day 14', 'a printed due is out of order'] }) })
    expect(html).toContain('it already closes on day 14')
    expect(html).toContain('a printed due is out of order')
    expect(html).toContain('data-testid="close-day-cancel"')
    expect(html).not.toContain('close-day-confirm')
    expect(html).not.toContain('close-day-recheck')
    expect(html).not.toContain('close-day-ack')
  })

  it('refused apply: the reasons, Cancel and Check again, still no apply', () => {
    const html = render({ kind: 'refused', refusedOn: 'apply', report: report({ refused: true, reasons: ['an installment was added; run it again'] }) })
    expect(html).toContain('an installment was added; run it again')
    expect(html).toContain('data-testid="close-day-recheck"')
    expect(html).not.toContain('close-day-confirm')
  })

  it('a failed apply offers Try again; a failed check offers Check again', () => {
    expect(render({ kind: 'error', message: 'down', retry: 'apply', report: report({ entries: [entry] }) })).toContain('close-day-retry')
    const check = render({ kind: 'error', message: 'down', retry: 'check', report: null })
    expect(check).toContain('close-day-recheck')
    expect(check).toContain('down')
  })
})
