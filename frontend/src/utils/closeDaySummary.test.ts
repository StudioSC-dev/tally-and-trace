import { describe, expect, it } from 'vitest'
import type { CloseDayEntry, CloseDayReport } from '@tally-trace/shared'
import {
  closeDayChanged,
  closeDayRefusal,
  movesNothing,
  needsHistoryAck,
  ordinalDay,
  stepAfterCheck,
  summariseCloseDay,
} from './closeDaySummary'

const report = (extra: Partial<CloseDayReport> = {}): CloseDayReport => ({
  card_id: 5, dry_run: true, changed: false, refused: false, reasons: [], old_close_day: 10, new_close_day: 14,
  entries: [], printed_dues: [], minimum_dues: [], past_statements: [], history_shift_accepted: false,
  ...extra,
})

const entry: CloseDayEntry = {
  entry_id: 12, old_next_occurrence: '2026-12-10', new_next_occurrence: '2026-12-14', old_anchor_day: 10, new_anchor_day: 14,
  rows: [
    { transaction_id: 1, date_kept: true, old_date: '2026-11-12', new_date: '2026-11-12', old_occurrence: '2026-11-10', new_occurrence: '2026-11-14' },
    { transaction_id: 2, date_kept: false, old_date: '2026-10-10', new_date: '2026-10-14', old_occurrence: '2026-10-10', new_occurrence: '2026-10-14' },
  ],
}

describe('ordinalDay', () => {
  it('spells the day', () => {
    expect([1, 2, 3, 4, 11, 12, 13, 21, 22, 31].map(ordinalDay)).toEqual(
      ['1st', '2nd', '3rd', '4th', '11th', '12th', '13th', '21st', '22nd', '31st'],
    )
  })
})

describe('summariseCloseDay', () => {
  it('states the old and new day', () => {
    expect(summariseCloseDay(report()).headline).toBe('The closing day moves from the 10th to the 14th.')
    expect(summariseCloseDay(report({ old_close_day: null })).headline).toBe('The closing day will be the 14th.')
  })

  it('names each installment by id with its next date before and after', () => {
    const { installments } = summariseCloseDay(report({ entries: [entry] }))
    expect(installments).toEqual(['Installment #12: the next charge moves from Dec 10th, 2026 to Dec 14th, 2026.'])
  })

  it('says when the next charge keeps its date, and when there is none', () => {
    const same = { ...entry, new_next_occurrence: entry.old_next_occurrence }
    expect(summariseCloseDay(report({ entries: [same] })).installments[0]).toBe(
      'Installment #12: the next charge stays on Dec 10th, 2026.',
    )
    const none = { ...entry, old_next_occurrence: null, new_next_occurrence: null }
    expect(summariseCloseDay(report({ entries: [none] })).installments[0]).toBe(
      'Installment #12: it has no next charge.',
    )
  })

  it('counts the charges that keep their date but move statement', () => {
    expect(summariseCloseDay(report({ entries: [entry] })).keptDate).toEqual([
      'Installment #12: 1 charge keeps its date but moves to another statement.',
    ])
    expect(summariseCloseDay(report({ entries: [{ ...entry, rows: [entry.rows[1]] }] })).keptDate).toEqual([])
  })

  it('lists printed and minimum dues that move', () => {
    const due = { id: 3, old_close: '2026-10-10', new_close: '2026-10-14' }
    const { dues } = summariseCloseDay(report({ printed_dues: [due], minimum_dues: [due] }))
    expect(dues).toEqual([
      'The printed due date for the statement closing Oct 10th, 2026 moves to the one closing Oct 14th, 2026.',
      'The minimum due for the statement closing Oct 10th, 2026 moves to the one closing Oct 14th, 2026.',
    ])
  })

  it('lists past statements with the charges moving in and out', () => {
    const { history } = summariseCloseDay(
      report({ past_statements: [{ old_close: '2026-09-10', new_close: '2026-09-14', moved_in: [1, 2], moved_out: [3] }] }),
    )
    expect(history).toEqual([
      'The statement that closed Sep 10th, 2026 would close Sep 14th, 2026: 2 charges move in and 1 out.',
    ])
  })
})

describe('what the form does with a report', () => {
  const due = { id: 3, old_close: '2026-10-10', new_close: '2026-10-14' }
  const past = { old_close: '2026-09-10', new_close: '2026-09-14', moved_in: [1], moved_out: [] as number[] }

  it('saves through the PUT when no installment or due moves', () => {
    expect(movesNothing(report())).toBe(true)
    expect(stepAfterCheck(report())).toBe('plain')
  })

  it('still saves through the PUT with past statements, or when refused, and nothing else moves', () => {
    expect(stepAfterCheck(report({ past_statements: [past] }))).toBe('plain')
    expect(stepAfterCheck(report({ refused: true, reasons: ['past statements would change'], past_statements: [past] }))).toBe('plain')
    expect(stepAfterCheck(report({ refused: true, reasons: ['no'] }))).toBe('plain')
  })

  it('opens the confirm step for an installment, a printed due or a minimum due', () => {
    for (const extra of [{ entries: [entry] }, { printed_dues: [due] }, { minimum_dues: [due] }]) {
      expect(stepAfterCheck(report(extra))).toBe('review')
      expect(stepAfterCheck(report({ ...extra, past_statements: [past] }))).toBe('review')
    }
  })

  it('shows a refusal that lists something to move, with Cancel only', () => {
    expect(stepAfterCheck(report({ refused: true, reasons: ['no'], entries: [entry] }))).toBe('refused')
    expect(stepAfterCheck(report({ refused: true, reasons: ['no'], printed_dues: [due] }))).toBe('refused')
  })

  it('needs the history checkbox only when past statements change', () => {
    expect(needsHistoryAck(report({ entries: [entry] }))).toBe(false)
    expect(needsHistoryAck(report({ entries: [entry], past_statements: [past] }))).toBe(true)
  })
})

describe('closeDayRefusal', () => {
  it('reads the report out of a 409', () => {
    const body = report({ refused: true, reasons: ['it already closes on day 14'] })
    expect(closeDayRefusal({ status: 409, data: body })).toEqual(body)
  })

  it('ignores a 409 with only a detail, other statuses and network errors', () => {
    expect(closeDayRefusal({ status: 409, data: { detail: 'x' } })).toBeNull()
    expect(closeDayRefusal({ status: 404, data: report({ refused: true, reasons: [] }) })).toBeNull()
    expect(closeDayRefusal({ status: 'FETCH_ERROR', error: 'x' })).toBeNull()
    expect(closeDayRefusal(undefined)).toBeNull()
  })
})

describe('closeDayChanged', () => {
  const card = { account_type: 'credit', billing_cycle_start: 10, permissions: { can_edit_settings: true } }

  it('is true when a stored closing day is changed on a card', () => {
    expect(closeDayChanged(card, { account_type: 'credit', billing_cycle_start: 14 })).toBe(true)
  })

  it('is false for the same day, a cleared day, a first day, other types and no edit right', () => {
    expect(closeDayChanged(card, { account_type: 'credit', billing_cycle_start: 10 })).toBe(false)
    expect(closeDayChanged(card, { account_type: 'credit' })).toBe(false)
    expect(closeDayChanged({ ...card, billing_cycle_start: null }, { account_type: 'credit', billing_cycle_start: 14 })).toBe(false)
    expect(closeDayChanged(card, { account_type: 'checking', billing_cycle_start: 14 })).toBe(false)
    expect(closeDayChanged({ ...card, account_type: 'checking' }, { account_type: 'credit', billing_cycle_start: 14 })).toBe(false)
    expect(closeDayChanged({ ...card, permissions: { can_edit_settings: false } }, { account_type: 'credit', billing_cycle_start: 14 })).toBe(false)
  })
})
