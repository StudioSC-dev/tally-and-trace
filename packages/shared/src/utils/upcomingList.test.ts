import { describe, it, expect } from 'vitest'
import type { Transaction, UpcomingOccurrence } from '../types/api'
import { mergeUpcoming, upcomingOccurrenceRow } from './upcomingList'

// Transactions arrive as loadUpcoming produces them: date ascending, then id.
function txn(id: number, day: string): Transaction {
  return { id, view: 'limited', date: `${day}T00:00:00Z` } as unknown as Transaction
}

function occ(name: string, day: string, over: Partial<UpcomingOccurrence> = {}): UpcomingOccurrence {
  return {
    view: 'full',
    entry_id: 1,
    name,
    occurrence_date: day,
    entry_type: 'expense',
    is_transfer: false,
    kind: 'cash',
    amount: 100,
    currency: 'PHP',
    account_name: 'Checking',
    transfer_to_account_name: null,
    capped: false,
    can_mark_paid: true,
    recordable: true,
    auto_post: null,
    block_reason: null,
    can_review: false,
    ...over,
  }
}

const keys = (rows: ReturnType<typeof mergeUpcoming>) => rows.map((r) => r.key)

describe('mergeUpcoming', () => {
  it('interleaves the two sources by day', () => {
    const rows = mergeUpcoming(
      [txn(1, '2026-11-02'), txn(2, '2026-11-05')],
      [occ('a', '2026-11-01'), occ('b', '2026-11-03', { entry_id: 2 }), occ('c', '2026-11-06', { entry_id: 3 })],
      100,
    )
    expect(keys(rows)).toEqual(['occ:1:2026-11-01', 'txn:1', 'occ:2:2026-11-03', 'txn:2', 'occ:3:2026-11-06'])
    expect(rows.map((r) => r.day)).toEqual(['2026-11-01', '2026-11-02', '2026-11-03', '2026-11-05', '2026-11-06'])
  })

  it('puts every transaction before every occurrence on one day, each in its input order', () => {
    const rows = mergeUpcoming(
      [txn(9, '2026-11-02'), txn(3, '2026-11-02')],
      [occ('b', '2026-11-02', { entry_id: 8 }), occ('a', '2026-11-02', { entry_id: 4 })],
      100,
    )
    expect(keys(rows)).toEqual(['txn:9', 'txn:3', 'occ:8:2026-11-02', 'occ:4:2026-11-02'])
  })

  it('never re-sorts a source: names b, a stay b, a', () => {
    const rows = mergeUpcoming([], [occ('b', '2026-11-02', { entry_id: 2 }), occ('a', '2026-11-02', { entry_id: 1 })], 100)
    expect(rows.map((r) => (r.kind === 'occurrence' ? r.occurrence.name : ''))).toEqual(['b', 'a'])
  })

  it('cuts to the limit', () => {
    const rows = mergeUpcoming([txn(1, '2026-11-02'), txn(2, '2026-11-03')], [occ('a', '2026-11-02')], 2)
    expect(keys(rows)).toEqual(['txn:1', 'occ:1:2026-11-02'])
    expect(mergeUpcoming([txn(1, '2026-11-02')], [], 0)).toEqual([])
  })

  describe('the limit boundary against a reference', () => {
    const LIMIT = 100
    const build = (perDay: Array<[string, number, number]>) => {
      const transactions: Transaction[] = []
      const occurrences: UpcomingOccurrence[] = []
      let id = 1
      let entry = 1
      for (const [day, t, o] of perDay) {
        for (let i = 0; i < t; i += 1) transactions.push(txn(id++, day))
        // Names run backwards so a name sort would disagree with the server order.
        for (let i = 0; i < o; i += 1) occurrences.push(occ(`n${String(o - i).padStart(3, '0')}`, day, { entry_id: entry++ }))
      }
      return { transactions, occurrences }
    }

    it.each([
      ['150 + 150 on one day', [['2026-11-02', 150, 150]] as Array<[string, number, number]>],
      ['a tie on the boundary day over 3 days', [['2026-11-02', 40, 10], ['2026-11-03', 30, 60], ['2026-11-04', 50, 50]] as Array<[string, number, number]>],
      ['the 100th row falls between the sources', [['2026-11-02', 60, 0], ['2026-11-03', 40, 40], ['2026-11-04', 20, 20]] as Array<[string, number, number]>],
    ])('%s: the first 100 rows of each source give the exact first 100', (_name, perDay) => {
      const { transactions, occurrences } = build(perDay)
      const full = mergeUpcoming(transactions, occurrences, Infinity)
      const cut = mergeUpcoming(transactions.slice(0, LIMIT), occurrences.slice(0, LIMIT), LIMIT)
      expect(keys(cut)).toEqual(keys(full).slice(0, LIMIT))
    })
  })
})

describe('upcomingOccurrenceRow', () => {
  it('offers Mark paid on a cash expense', () => {
    expect(upcomingOccurrenceRow(occ('Rent', '2026-11-05'), true)).toEqual({ actions: ['mark_paid'], review: false, note: 'Not recorded' })
  })

  it('offers Mark paid on a transfer', () => {
    expect(upcomingOccurrenceRow(occ('Save', '2026-11-05', { is_transfer: true, kind: null }), true).actions).toEqual(['mark_paid'])
  })

  it('offers Mark received on income', () => {
    expect(upcomingOccurrenceRow(occ('Salary', '2026-11-05', { entry_type: 'income', kind: null }), true).actions).toEqual(['mark_received'])
  })

  it.each(['subscription', 'bill'] as const)('offers Charged and Posted on a card %s', (kind) => {
    expect(upcomingOccurrenceRow(occ('Card', '2026-11-05', { kind }), true)).toEqual({
      actions: ['charged', 'posted'],
      review: false,
      note: 'Not recorded',
    })
  })

  it('gives an installment that auto-posts no button, and says so', () => {
    const on = occ('Phone', '2026-11-05', { kind: 'installment', auto_post: 'on', recordable: false })
    expect(upcomingOccurrenceRow(on, true)).toEqual({ actions: [], review: false, note: 'Not recorded · Auto-posts each morning' })
    expect(upcomingOccurrenceRow(on, false).note).toBe('Not recorded · Auto-posts when you open Transactions')
  })

  it('does not check auto_post itself: recordable decides the buttons', () => {
    const on = occ('Phone', '2026-11-05', { kind: 'installment', auto_post: 'on', recordable: true })
    expect(upcomingOccurrenceRow(on, true).actions).toEqual(['charged', 'posted'])
  })

  it.each(['unreviewed', 'held'] as const)('offers Review on a %s installment, with Charged and Posted when recordable', (auto_post) => {
    const row = occ('Phone', '2026-11-05', { kind: 'installment', auto_post, can_review: true })
    const view = upcomingOccurrenceRow(row, true)
    expect(view.review).toBe(true)
    expect(view.actions).toEqual(['charged', 'posted'])
    expect(view.note).toBe(auto_post === 'unreviewed' ? 'Not recorded · Review to auto-post' : 'Not recorded · Possible duplicate · Review')
  })

  it('offers no Review when the caller cannot review', () => {
    expect(upcomingOccurrenceRow(occ('Phone', '2026-11-05', { kind: 'installment', auto_post: 'unreviewed', can_review: false }), true).review).toBe(false)
  })

  it.each(['off', 'blocked'] as const)('offers Charged and Posted, no Review, on a %s installment', (auto_post) => {
    const view = upcomingOccurrenceRow(
      occ('Phone', '2026-11-05', { kind: 'installment', auto_post, can_review: true, block_reason: auto_post === 'blocked' ? 'foreign_currency' : null }),
      true,
    )
    expect(view.review).toBe(false)
    expect(view.actions).toEqual(['charged', 'posted'])
    expect(view.note.startsWith('Not recorded · ')).toBe(true)
  })

  it('offers nothing on a capped entry later month', () => {
    expect(upcomingOccurrenceRow(occ('Loan', '2026-12-05', { capped: true, recordable: false }), true)).toEqual({
      actions: [],
      review: false,
      note: 'Not recorded',
    })
  })

  it('offers nothing without permission', () => {
    expect(upcomingOccurrenceRow(occ('Rent', '2026-11-05', { can_mark_paid: false, recordable: false }), true).actions).toEqual([])
  })
})
